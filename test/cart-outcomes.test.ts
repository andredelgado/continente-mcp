import { present, ok, rawCart, productForm, cartControls, weightedRules, valueOf } from '../test-support/helpers.js';
import type { StorefrontSession } from '../src/session/browser.js';
import { double, mutationOf, recoveryOf } from '../test-support/assertions.js';
import { CartService } from '../src/services/cart.js';
import { CartClient, StorefrontClient } from '../src/clients/storefront.js';
import { createShoppingApplication } from '../src/runtime.js';
import { injectedServices, connect } from '../test-support/mcp-fixture.js';

import assert from 'node:assert/strict';
import test from 'node:test';

test('preparation failures are not_applied and never submit a cart request', async t => {
  const { services, state } = injectedServices(); let writes = 0;
  const client = new CartClient(new StorefrontClient(double<StorefrontSession>({ async ensureReady() { throw new Error('private context details'); } })));
  client.fetchCart = async () => ok(rawCart(2)); client.fetchProductForm = async () => ok(productForm());
  client.submitCartMutation = async () => { writes++; return ok({}); };
  services.cart = new CartService(client); const { client: mcp } = await connect(t, services);
  const result = await mcp.callTool({ name: 'add_cart_item', arguments: { productId: '00123' } });
  assert.equal(result.isError, true); assert.equal(mutationOf(result).outcome, 'not_applied');
  assert.equal(writes, 0); assert.equal(state.refreshes, 0); assert.doesNotMatch(JSON.stringify(result), /private context/);
});
test('preflight exceptions from injected gateways cannot become possibly-applied failures', async () => {
  for (const stage of ['cart', 'product', 'controls', 'prepare'] as const) {
    let writes = 0; const throws = () => { throw new Error('synthetic private data'); };
    const client = { async fetchCart() { return stage === 'cart' ? throws() : ok(rawCart(2)); },
      async fetchProductForm() { return stage === 'product' ? throws() : ok(productForm()); },
      async fetchCartControls() { return stage === 'controls' ? throws() : ok(cartControls()); },
      async prepareCartMutation() { return stage === 'prepare' ? throws() : ok(async () => { writes++; return ok({}); }); },
      async submitCartMutation() { writes++; return ok({}); } };
    const service = new CartService(client);
    const result = stage === 'controls' ? await service.setCartItemQuantity('00123', 1) : await service.addCartItem('00123', 1);
    assert.equal(result.ok, false); assert.equal(writes, 0); assert.doesNotMatch(result.error.message, /private/);
  }
});
test('timeout, invalid JSON, lost context and post-write authentication expiry retain unknown recovery', async t => {
  for (const fault of ['timeout', 'json', 'context', 'auth_payload', 'unauthorized'] as const) {
    const { services, state } = injectedServices(); let writes = 0; const authentication: boolean[] = [];
    const client = new CartClient(new StorefrontClient(double<StorefrontSession>({ recordAuthentication(value) { authentication.push(value); }, async ensureReady() { return { page: { url: () => 'https://www.continente.pt/' }, context: { request: {
      async post() {
        writes++;
        if (fault === 'timeout' || fault === 'context') throw new Error(fault);
        return { ok: () => fault !== 'unauthorized', status: () => fault === 'unauthorized' ? 401 : 200,
          async json() { if (fault === 'json') throw new Error('private invalid JSON'); return { resources: { customerAuthenticated: false } }; } };
      },
    } } }; } })));
    client.fetchCart = async () => ok(rawCart(2)); client.fetchProductForm = async () => ok(productForm());
    services.cart = new CartService(client); const { client: mcp } = await connect(t, services);
    const result = await mcp.callTool({ name: 'add_cart_item', arguments: { productId: '00123' } });
    assert.equal(result.isError, true, fault); assert.equal(mutationOf(result).outcome, 'unknown', fault);
    assert.equal(recoveryOf(result).automaticReplay, false);
    assert.deepEqual(Object.keys(present(result.structuredContent)), ['result']); assert.equal(writes, 1); assert.equal(state.refreshes, 0);
    assert.doesNotMatch(JSON.stringify(result), /private/);
    assert.deepEqual(authentication, ['auth_payload', 'unauthorized'].includes(fault) ? [false] : [], fault);
  }
});
test('weighted second-step preparation or submission failure never replays the first add', async t => {
  for (const second of ['prepare', 'submit'] as const) {
    const { services, state } = injectedServices(); let prepared = 0; let adds = 0; let sets = 0;
    const client = new CartClient(new StorefrontClient(double<StorefrontSession>({ async ensureReady() {
      if (++prepared === 2 && second === 'prepare') throw new Error('lost context');
      return { page: { url: () => 'https://www.continente.pt/' }, context: { request: {
        async post() { adds++; return { ok: () => true, status: () => 200, async json() { return {}; } }; },
        async get() { sets++; throw new Error('lost response'); },
      } } };
    } })));
    client.fetchCart = async () => ok(rawCart(adds ? 3 : 0));
    client.fetchProductForm = async () => ok(productForm(weightedRules)); client.fetchCartControls = async () => ok(cartControls(weightedRules));
    services.cart = new CartService(client); const { client: mcp } = await connect(t, services);
    const result = await mcp.callTool({ name: 'add_cart_item', arguments: { productId: '00123', quantity: 12 } });
    assert.equal(mutationOf(result).outcome, 'unknown');
    assert.equal(adds, 1); assert.equal(sets, second === 'prepare' ? 0 : 1); assert.equal(state.refreshes, 0);
  }
});
test('cancellation while preparing a submission is not_applied', async () => {
  const { services } = injectedServices(); let started: () => void = () => { throw new Error("Gate has not been initialized"); }; let writes = 0;
  const preparing = new Promise<void>(resolve => { started = resolve; });
  services.cart = new CartService({ async fetchCartControls() { throw new Error('Unexpected controls read'); }, async fetchCart() { return ok(rawCart(2)); }, async fetchProductForm() { return ok(productForm()); },
    async prepareCartMutation() { started(); return new Promise(() => {}); }, async submitCartMutation() { writes++; return ok({}); } });
  const app = createShoppingApplication({ version: 'test', services }); const cancel = new AbortController();
  const call = app.dispatchToolCall('add_cart_item', { productId: '00123' }, { signal: cancel.signal });
  await preparing; cancel.abort(); const result = await call;
  assert.equal(mutationOf(result).outcome, 'not_applied'); assert.equal(writes, 0);
  await app.close();
});
test('a form or control pointing at another cart operation is refused with zero requests sent', async () => {
  const SITE = '/on/demandware.store/Sites-continente-Site/default';
  const clearButton = (url: string) => `<button class="confirm-confirm-clean-cart-select" data-clean-cart-url="${url}">Confirmar</button>`;
  for (const [tool, action] of [
    ['add', `${SITE}/Cart-RemoveAllProductLineItems`], ['add', '/Cart-RemoveProduct'], ['add', '/Cart-UpdateQuantity'],
    ['set', '/Cart-RemoveProduct'], ['set', `${SITE}/Cart-RemoveAllProductLineItems`], ['set', '/Cart-AddProduct'],
    ['remove', `${SITE}/Cart-RemoveAllProductLineItems`], ['remove', '/Cart-UpdateQuantity'],
    ['clear', `/checkout/pagamento${SITE}/Cart-RemoveAllProductLineItems`],
  ] as const) {
    const sent: string[] = []; let marked = false;
    const reply = { ok: () => true, status: () => 200, url: () => 'https://www.continente.pt/', headers: () => ({}), async json() { return { success: true }; } };
    const request = { async get(url: string) { sent.push(`GET ${url}`); return reply; }, async post(url: string) { sent.push(`POST ${url}`); return reply; } };
    const client = new CartClient(new StorefrontClient(double<StorefrontSession>({ async ensureReady() {
      marked = true; return { page: { url: () => 'https://www.continente.pt/' }, context: { request } } as never;
    } })));
    client.fetchCart = async () => ok(rawCart(2));
    client.fetchProductForm = async () => ok(productForm(undefined, action));
    client.fetchCartControls = async () => ok(tool === 'clear' ? clearButton(action)
      : tool === 'remove' ? cartControls().replace('data-action="/Cart-RemoveProduct"', `data-action="${action}"`) : cartControls(undefined, action));
    const service = new CartService(client);
    const result = tool === 'add' ? await service.addCartItem('00123', 1) : tool === 'set' ? await service.setCartItemQuantity('00123', 3)
      : tool === 'remove' ? await service.removeCartItem('00123') : await service.clearCart();
    assert.equal(result.ok, false, `${tool} ${action}`);
    assert.equal(result.error.code, 'invalid_data', `${tool} ${action}`);
    assert.deepEqual(sent, [], `${tool} ${action}`);
    assert.equal(marked, false, `${tool} ${action} opened a write lease`);
  }
});
test('a line whose unit is unknown or different is never counted, confirmed or used for arithmetic', async () => {
  const lines = {
    unitless: (qty: number) => { const cart = rawCart(qty); delete (cart.cart.items[0] as { measurementInfo?: unknown }).measurementInfo; return cart; },
    unsupported: (qty: number) => { const cart = rawCart(qty); Object.assign(present(cart.cart.items[0]), { measurementInfo: { quantityConversionRates: { primaryunit: 'kg', secondaryunit: 'kg', hasAlternativeSaleUnit: false, hasConversionRate: false } } }); return cart; },
  };
  for (const [name, line] of Object.entries(lines)) {
    // Before any write: the cart already holds an unreadable 2, so neither "already 2" nor "2 + 1" may be claimed.
    for (const change of ['set', 'add'] as const) {
      let writes = 0;
      const service = new CartService({ async fetchCart() { return ok(line(2)); }, async fetchProductForm() { return ok(productForm()); },
        async fetchCartControls() { return ok(cartControls()); }, async submitCartMutation() { writes++; return ok({ success: true }); } });
      const result = change === 'set' ? await service.setCartItemQuantity('00123', 2) : await service.addCartItem('00123', 1);
      assert.equal(result.ok, false, `${name} ${change}`); assert.equal(result.error.code, 'sale_rules_unknown', `${name} ${change}`);
      assert.equal(writes, 0, `${name} ${change}`);
    }
    // After a write: a readback whose unit is unknown leaves the change unknown, never confirmed.
    let writes = 0;
    const service = new CartService({ async fetchCart() { return ok(writes ? line(1) : rawCart(0)); }, async fetchProductForm() { return ok(productForm()); },
      async fetchCartControls() { return ok(cartControls()); }, async submitCartMutation() { writes++; return ok({ success: true }); } });
    const added = valueOf(await service.addCartItem('00123', 1));
    assert.equal(added.outcome, 'unknown', name); assert.equal(writes, 1, name);
  }
});
test('a set keeps its total when the line appears between reads: it is set, never added to', async () => {
  // Someone adds 3 on the website after the first read, before the change: the set must still end at 2.
  let reads = 0; const sent: string[] = []; let quantity = 0;
  const client = { async fetchCart() { reads++; if (reads === 2 && !sent.length) quantity = 3; return ok(rawCart(quantity)); },
    async fetchProductForm() { return ok(productForm()); }, async fetchCartControls() { return ok(cartControls()); },
    async submitCartMutation(_action: string, params: URLSearchParams, operation: string) {
      sent.push(`${operation} ${params.get('quantity')}`);
      quantity = operation === 'add' ? quantity + Number(params.get('quantity')) : Number(params.get('quantity'));
      return ok({ success: true }); } };
  const result = valueOf(await new CartService(client).setCartItemQuantity('00123', 2));
  assert.deepEqual(sent, ['update 2']);
  assert.equal(result.outcome, 'confirmed');
  assert.deepEqual(result.outcome === 'confirmed' && [result.requested, result.confirmedQuantity], [{ value: 2, unit: 'un' }, { value: 2, unit: 'un' }]);
  // If it changes again after the add, the readback is not the target, so nothing is confirmed.
  let late = 0; const lateSent: string[] = [];
  const racing = { ...client, async fetchCart() { late++; return ok(rawCart(late <= 2 ? 0 : 5)); },
    async submitCartMutation(_action: string, params: URLSearchParams, operation: string) { lateSent.push(`${operation} ${params.get('quantity')}`); return ok({ success: true }); } };
  const raced = valueOf(await new CartService(racing).setCartItemQuantity('00123', 2));
  assert.deepEqual(lateSent, ['add 2']); assert.equal(raced.outcome, 'unknown');
});
test('an add takes its quantity rules from the product itself, never from a recommendation on the page', async () => {
  const own = { primaryunit: 'un', secondaryunit: 'un', minOrderQuantity: 1, stepQuantity: 1, maxNumberOfUnitsPerSale: 10 };
  const other = { ...own, maxNumberOfUnitsPerSale: 11 };
  const control = (pid: string | null, rules: object) => `<div class="ct-tile-quantity-update"${pid ? ` data-pid="${pid}"` : ''} data-measure-options='${JSON.stringify(rules)}'></div>`;
  const page = (...controls: string[]) => `<input name="productID" value="00123"><input class="add-to-cart-url" value="/Cart-AddProduct"><input name="csrf_token" value="synthetic">${controls.join('')}`;
  const add = async (html: string, quantity: number) => {
    let writes = 0;
    const service = new CartService({ async fetchCart() { return ok(rawCart(0)); }, async fetchProductForm() { return ok(html); },
      async fetchCartControls() { return ok(cartControls()); }, async submitCartMutation() { writes++; return ok({ success: true }); } });
    return { result: await service.addCartItem('00123', quantity), writes };
  };
  // A recommendation's control comes first on the page: its limit of 11 must not apply.
  const first = await add(page(control('999', other), control('00123', own)), 11);
  assert.equal(first.result.ok, false); assert.equal(first.writes, 0);
  // Rules missing for this product, or contradicting each other, refuse the add before anything is sent.
  for (const html of [page(control('999', other)), page(control(null, own)), page(control('00123', own), control('00123', other))]) {
    const refused = await add(html, 1);
    assert.equal(refused.result.ok, false); assert.equal(!refused.result.ok && refused.result.error.code, 'sale_rules_unknown'); assert.equal(refused.writes, 0);
  }
  // The same rules repeated for this product are not a conflict.
  assert.equal((await add(page(control('999', other), control('00123', own), control('00123', own)), 2)).writes, 1);
});
