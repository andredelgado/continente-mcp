import { present, valueOf, errorOf, ok, fail, rawCart, productForm, cartControls, unitRules, weightedRules } from '../test-support/helpers.js';
import { having, mutationOf, dataOf } from '../test-support/assertions.js';

import type { CartGateway } from '../src/ports.js';

import { MutationData } from '../src/mcp/contracts.js';
import { CartService } from '../src/services/cart.js';
import { parseCartResponse } from '../src/parsers/cart.js';
import { connect, injectedServices } from '../test-support/mcp-fixture.js';

import assert from 'node:assert/strict';
import test from 'node:test';

function scenario(rules = unitRules) {
  let lines = [{ ...rawCart(2).cart.items[0], UUID: 'first' }, { ...rawCart(7).cart.items[0], UUID: 'second' }];
  const writes: { action: string; params: Record<string, string>; operation: string }[] = [];
  const client: CartGateway = {
    async fetchCart() { return ok({ resources: { customerAuthenticated: true }, cart: { items: lines } }); },
    async fetchProductForm() { return ok(productForm(rules)); },
    async fetchCartControls() { return ok(['first', 'second'].map(id => cartControls(rules).replaceAll('line-abc', id)).join('')); },
    async submitCartMutation(action, parameters, operation) {
      writes.push({ action, params: Object.fromEntries(parameters), operation });
      const id = parameters.get('uuid');
      if (action.includes('Remove')) lines = lines.filter(line => line.UUID !== id);
      else present(lines.find(line => line.UUID === id)).quantity = Number(parameters.get('quantity')) / (rules.primaryToSecondary || 1);
      return ok({ success: true });
    },
  };
  return { client, service: new CartService(client), writes, lines };
}
test('product-only mutations reject duplicate lines before writing; explicit IDs select add, set and removal', async () => {
  for (const rules of [unitRules, weightedRules] as const) {
    const s = scenario(rules);
    for (const [operation, quantity] of [['addCartItem', 1], ['setCartItemQuantity', 4], ['setCartItemQuantity', 0]] as const) {
      assert.equal(having((await s.service[operation]('00123', quantity)), 'error').error.code, 'invalid_input');
    }
    assert.equal(s.writes.length, 0);
    assert.equal(having(valueOf((await s.service.addCartItem('00123', 1, 'second'))), 'confirmedQuantity').confirmedQuantity.value, 8);
    assert.equal(present(s.writes[0]).params.uuid, 'second');
    assert.equal(present(s.writes[0]).operation, 'update');
    assert.equal(having(valueOf((await s.service.setCartItemQuantity('00123', 6, 'second'))), 'cartItemId').cartItemId, 'second');
    assert.equal(having(valueOf((await s.service.setCartItemQuantity('00123', 0, 'second'))), 'confirmedQuantity').confirmedQuantity.value, 0);
    assert.equal(present(s.lines[0]).quantity, 2);
    assert.equal(s.writes.length, 3);
  }
});
test('confirmation cannot borrow another line quantity or trust a missing line for nonzero sets', async () => {
  for (const behavior of ['wrong-line', 'missing-line'] as const) {
    const s = scenario();
    s.client.submitCartMutation = async () => { s.writes.push({ action: 'synthetic-write', params: {}, operation: 'update' }); if (behavior === 'missing-line') s.lines.pop(); return ok({}); };
    const result = await s.service.setCartItemQuantity('00123', 2, 'second');
    assert.equal(valueOf(result).outcome, 'unknown'); assert.equal(s.writes.length, 1);
  }
});
test('mismatched controls, duplicate UUIDs and unknown requested IDs fail before writing', async () => {
  const s = scenario();
  for (const id of ['absent', 'bad id'] as const) assert.equal((await s.service.setCartItemQuantity('00123', 3, id)).ok, false);
  s.client.fetchCartControls = async () => ok(cartControls());
  assert.equal((await s.service.setCartItemQuantity('00123', 3, 'second')).ok, false);
  assert.equal(s.writes.length, 0);
  const raw = { resources: { customerAuthenticated: true }, cart: { items: s.lines } };
  present(raw.cart.items[1]).UUID = 'first';
  assert.equal(errorOf(parseCartResponse(raw)).code, 'invalid_data');
});
test('authenticated empty, guest, malformed and unavailable carts remain distinct and unknown prices stay null', async () => {
  const s = scenario();
  for (const [response, code] of [[ok({}), 'invalid_data'], [ok({ resources: { customerAuthenticated: false } }), 'not_authenticated'], [fail(), 'upstream_unavailable']] as const) {
    s.client.fetchCart = async () => response;
    assert.equal(errorOf((await s.service.getCart())).code, code);
  }
  s.client.fetchCart = async () => ok({ action: 'Cart-MiniCartShow', resources: { customerAuthenticated: true }, basket: {} });
  assert.deepEqual(valueOf((await s.service.getCart())).items, []);
  s.client.fetchCart = async () => ok({ resources: { customerAuthenticated: true }, cart: { items: [{ id: '00123', quantity: 2, productName: 'Unknown price' }] } });
  const cart = valueOf((await s.service.getCart()));
  assert.equal(cart.totals.products, null); assert.equal(present(cart.items[0]).price, null);
});
test('post-write guest, malformed, unavailable and ambiguous confirmation never report success', async () => {
  for (const final of [ok({ resources: { customerAuthenticated: false } }), ok({}), fail(), ok({ resources: { customerAuthenticated: true }, cart: { items: [rawCart(3).cart.items[0], rawCart(3).cart.items[0]] } })] as const) {
    let writes = 0;
    const service = new CartService({ async fetchCartControls() { throw new Error('Unexpected controls read'); }, async fetchCart() { return writes ? final : ok(rawCart(2)); },
      async fetchProductForm() { return ok(productForm()); }, async submitCartMutation() { writes++; return ok({}); } });
    assert.equal(valueOf((await service.addCartItem('00123', 1))).outcome, 'unknown');
    assert.equal(writes, 1);
  }
});
test('MCP mutations expose line selection and reject ambiguous product-only requests', async t => {
  const { services } = injectedServices(); const s = scenario(); services.cart = s.service;
  const { client } = await connect(t, services);
  const rejected = await client.callTool({ name: 'set_cart_item_quantity', arguments: { productId: '00123', quantity: 3 } });
  assert.equal(mutationOf(rejected).outcome, 'not_applied');
  const result = await client.callTool({ name: 'set_cart_item_quantity', arguments: { productId: '00123', cartItemId: 'second', quantity: 3 } });
  assert.equal(dataOf(result, MutationData).cartItemId, 'second');
  assert.equal(s.writes.length, 1);
});
