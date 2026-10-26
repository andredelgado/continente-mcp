import assert from 'node:assert/strict';
import test from 'node:test';
import { parseBasketCoupons } from '../src/parsers/cart-coupons.js';
import { CartCouponSelectionClient } from '../src/clients/coupons.js';
import type { StorefrontClient } from '../src/clients/storefront.js';
import { double } from '../test-support/assertions.js';
import { fixture, present } from '../test-support/helpers.js';

test('basket coupon parser deduplicates carousel clones and requires the exact apply action', () => {
  const parsed = parseBasketCoupons(fixture('cart-coupons'), ['synthetic-002']);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.coupons.length, 2);
  assert.deepEqual(parsed.value.selectedIds, ['synthetic-002']);
  assert.deepEqual(parsed.value.coupons[0], { id: 'synthetic-001', description: '5 euros in test items', amount: '5', unit: '€', isCarouselCoupon: 'true' });
  assert.equal(parseBasketCoupons(fixture('cart-coupons').replace('Cart-ApplyCustomerBenefits', 'Checkout-Submit')).ok, false);
  assert.equal(parseBasketCoupons(fixture('cart-coupons').replace('action="/', 'action="/nested/')).ok, false);
});

function selectionClient(selectionStates: (string[] | null)[], postFailure?: 'lost' | 'http' | 'json') {
  let read = 0;
  const posts: { url: string; options: { form?: Record<string, string> } }[] = [];
  const page = {
    async waitForSelector() {}, async content() { return fixture('cart-coupons'); },
    async evaluate() { const value = selectionStates[Math.min(read++, selectionStates.length - 1)]; return value === undefined ? [] : value; },
  };
  const response = { ok: () => postFailure !== 'http', status: () => postFailure === 'http' ? 401 : 200,
    url: () => 'https://www.continente.pt/on/demandware.store/Sites-continente-Site/default/Cart-ApplyCustomerBenefits',
    async json() { if (postFailure === 'json') throw new Error('Synthetic invalid response'); return {}; } };
  const lease = { page, context: { request: { async post(url: string | URL, options: { form?: Record<string, string> }) {
    posts.push({ url: String(url), options });
    if (postFailure === 'lost') throw new Error('Synthetic lost response');
    return response;
  } } } };
  const site = double<StorefrontClient>({
    session: { async ensureReady() { return lease; } },
    async navigateToStorefrontPage() { return { ok: true, value: lease }; },
    async io(_lease: unknown, operation: () => Promise<unknown>) { return operation(); },
  } as never);
  return { client: new CartCouponSelectionClient(site), posts };
}

test('coupon selection posts only fresh form fields and verifies the live selected state', async () => {
  const fixtureClient = selectionClient([[], ['synthetic-001']]);
  const result = await fixtureClient.client.setSelectedCoupons(['synthetic-001']);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.value, { outcome: 'confirmed', selectedCouponIds: ['synthetic-001'] });
  const post = present(fixtureClient.posts[0]);
  assert.equal(post.url, 'https://www.continente.pt/on/demandware.store/Sites-continente-Site/default/Cart-ApplyCustomerBenefits');
  const body = JSON.parse(present(post.options.form).carouselCoupons!) as Record<string, string>[];
  assert.deepEqual(body, [{ id: 'synthetic-001', description: '5 euros in test items', amount: '5', unit: '€', isCarouselCoupon: 'true' }]);
  assert.equal('data-type' in body[0]!, false);
});

test('unknown coupon outcome is not replayed and unavailable IDs are rejected before writing', async () => {
  const uncertain = selectionClient([[], []]);
  const result = await uncertain.client.setSelectedCoupons(['synthetic-001']);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.outcome, 'unknown');
  assert.equal(uncertain.posts.length, 1);

  const unavailable = selectionClient([[]]);
  const rejected = await unavailable.client.setSelectedCoupons(['unobserved-id']);
  assert.equal(rejected.ok, false);
  assert.equal(unavailable.posts.length, 0);
});

test('lost coupon responses keep the current selection null and preserve the older observation without replay', async () => {
  for (const mode of ['lost', 'http', 'json'] as const) {
    const uncertain = selectionClient([['synthetic-002']], mode);
    const result = await uncertain.client.setSelectedCoupons(['synthetic-001']);
    assert.deepEqual(result, { ok: true, value: { outcome: 'unknown', selectedCouponIds: null,
      lastObservedSelectedCouponIds: ['synthetic-002'], recovery: { action: 'get_checkout_summary', automaticReplay: false } } });
    assert.equal(uncertain.posts.length, 1, mode);
  }
});

test('unreadable coupon readback differs from an observed mismatched or empty selection', async () => {
  for (const after of [null, ['synthetic-002'], []]) {
    const uncertain = selectionClient([['synthetic-002'], after]);
    const result = await uncertain.client.setSelectedCoupons(['synthetic-001']);
    assert.deepEqual(result, { ok: true, value: { outcome: 'unknown', selectedCouponIds: after,
      lastObservedSelectedCouponIds: after ?? ['synthetic-002'], recovery: { action: 'get_checkout_summary', automaticReplay: false } } });
    assert.equal(uncertain.posts.length, 1);
  }
});
