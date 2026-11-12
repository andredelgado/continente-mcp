import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseClearCartAction } from '../src/parsers/cart.js';
import { CartService } from '../src/services/cart.js';
import { ok, fail, valueOf, errorOf } from '../test-support/helpers.js';
import { connect, injectedServices } from '../test-support/mcp-fixture.js';
import { textOf } from '../test-support/assertions.js';

const CLEAR = 'https://www.continente.pt/on/demandware.store/Sites-continente-Site/default/Cart-RemoveAllProductLineItems';
const button = (url = CLEAR) => `<div id="confirm-clean-cart-modal"><button class="button button--primary confirm-confirm-clean-cart-select" data-clean-cart-url="${url}">Confirmar</button></div>`;
const minicart = () => JSON.parse(readFileSync(new URL('../../test/fixtures/minicart.json', import.meta.url), 'utf8')) as Record<string, any>;
const empty = { action: 'Cart-MiniCartShow', resources: { customerAuthenticated: true }, basket: {} };
const bagOnly = () => { const cart = minicart(); cart.basket.itemsSortedByBrand = [cart.basket.itemsSortedByBrand[1]]; return cart; };

function site(after: unknown, options: { page?: string; send?: () => unknown } = {}) {
  const posts: { action: string; operation: string }[] = []; let cleared = false;
  const client = {
    async fetchCart() { return ok(cleared ? after : minicart()); },
    async fetchCartControls() { return ok(options.page ?? button()); },
    async submitCartMutation(action: string, _params: URLSearchParams, operation: string) {
      posts.push({ action, operation }); cleared = true;
      return (options.send?.() ?? ok({ success: true })) as never;
    },
  };
  return { service: new CartService(client as never), posts };
}

test('the clear-all request comes only from the cart page\'s own confirmation button', () => {
  assert.equal(valueOf(parseClearCartAction(button())), CLEAR);
  for (const page of ['<main></main>', button('https://other.invalid/Cart-RemoveAllProductLineItems'), button(CLEAR.replace('RemoveAllProductLineItems', 'AddProduct')),
    button() + button(CLEAR + '?x=1')]) assert.equal(parseClearCartAction(page).ok, false);
});

test('clearing posts the website\'s request once and is confirmed by an empty cart', async () => {
  const { service, posts } = site(empty);
  assert.deepEqual(valueOf(await service.clearCart()), { outcome: 'confirmed', disposition: 'cleared', removedLines: 2 });
  assert.deepEqual(posts, [{ action: CLEAR, operation: 'clear' }]);
  // Bags the website keeps or removes by itself do not count as products left behind.
  const { service: withBag } = site(bagOnly());
  assert.equal(valueOf(await withBag.clearCart()).outcome, 'confirmed');
});

test('an empty cart, or one holding only bags, is not written to', async () => {
  for (const before of [empty, bagOnly()]) {
    const posts: unknown[] = [];
    const service = new CartService({ async fetchCart() { return ok(before); }, async fetchCartControls() { throw new Error('no controls read'); },
      async submitCartMutation() { posts.push(1); return ok({}); } } as never);
    assert.deepEqual(valueOf(await service.clearCart()), { outcome: 'confirmed', disposition: 'already_empty', removedLines: 0 });
    assert.equal(posts.length, 0);
  }
});

test('without a recognised control nothing is sent; after sending, anything unconfirmed is unknown and never retried', async () => {
  const missing = site(empty, { page: '<main></main>' });
  assert.equal(errorOf(await missing.service.clearCart()).code, 'invalid_data'); assert.equal(missing.posts.length, 0);
  for (const [label, after, send] of [['products left', minicart(), undefined], ['rejected', empty, () => ok({ success: false })],
    ['lost response', empty, () => fail('upstream_unavailable')], ['unreadable cart', null, undefined]] as const) {
    const { service, posts } = site(after ?? {}, send ? { send } : {});
    const result = valueOf(await service.clearCart());
    assert.equal(result.outcome, 'unknown', label);
    assert.equal(posts.length, 1, label);
  }
});

test('clear_cart needs confirm: true and reports what it removed', async t => {
  const { services } = injectedServices();
  services.cart.clearCart = async () => ok({ outcome: 'confirmed' as const, disposition: 'cleared' as const, removedLines: 3 });
  const { client } = await connect(t, services);
  for (const args of [{}, { confirm: false }, { confirm: 'yes' }]) await assert.rejects(client.callTool({ name: 'clear_cart', arguments: args }), { code: -32602 });
  const result = await client.callTool({ name: 'clear_cart', arguments: { confirm: true } });
  assert.match(textOf(result), /^Emptied the cart: removed 3 product lines\./);
  services.cart.clearCart = async () => ok({ outcome: 'unknown' as const, error: { code: 'cart_change_unconfirmed' as const, message: 'x', retryable: false as const },
    recovery: { action: 'get_cart' as const, automaticReplay: false as const } });
  const unknown = await client.callTool({ name: 'clear_cart', arguments: { confirm: true } });
  assert.equal(unknown.isError, true);
  assert.equal((unknown.structuredContent as { result: { mutation: { outcome: string } } }).result.mutation.outcome, 'unknown');
});
