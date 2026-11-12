import assert from 'node:assert/strict';
import test from 'node:test';
import type { CouponSelectionResult } from '../src/domain/index.js';
import { parseCartCouponForm, parseCouponsPage } from '../src/parsers/coupons.js';
import { allowedCouponMutation } from '../src/clients/policy.js';
import { CouponsClient } from '../src/clients/coupons.js';
import type { StorefrontClient } from '../src/clients/storefront.js';
import { CouponsData, CouponSelectionData } from '../src/mcp/contracts.js';
import { dataOf, double, mutationOf, textOf, toolError } from '../test-support/assertions.js';
import { fixture, ok, present, valueOf } from '../test-support/helpers.js';
import { connect, injectedServices } from '../test-support/mcp-fixture.js';

// Parsing, the form payload and the selection checks follow #11 by Diogo Almeida.

test('the account page gives each coupon as shown, and only a visible empty marker means no coupons', () => {
  const page = valueOf(parseCouponsPage(fixture('coupons')));
  assert.equal(page.completeness, 'complete');
  assert.deepEqual(page.coupons.map(coupon => [coupon.couponId, coupon.benefitValue, coupon.benefitQualifier, coupon.availability]), [
    ['10000001', '5 €', 'em compras superiores a 25 €', 'Válido até 30/11'],
    ['10000002', '10%', null, 'Válido até 15/11'],
    ['10000003', null, null, null],
  ]);
  assert.ok(page.coupons.every(coupon => coupon.selectedInCart === null));
  assert.deepEqual(valueOf(parseCouponsPage('<div class="loyalty-card-has-no-coupons">Sem cupões</div>')), { coupons: [], completeness: 'complete' });
  assert.equal(parseCouponsPage('<div class="loyalty-card-has-no-coupons d-none">Sem cupões</div>').ok, false);
});

test('the cart coupon form keeps each choice once, takes the live checkboxes, and must post to the coupon action', () => {
  const form = valueOf(parseCartCouponForm(fixture('coupons-cart'), ['10000002']));
  assert.deepEqual(form.coupons.map(coupon => coupon.id), ['10000001', '10000002']);
  assert.deepEqual(form.coupons[0], { id: '10000001', description: '5 euros in test items', amount: '5', unit: '€', isCarouselCoupon: 'true' });
  assert.deepEqual(form.selectedIds, ['10000002']);
  assert.equal(parseCartCouponForm(fixture('coupons-cart').replace('Cart-ApplyCustomerBenefits', 'Checkout-Submit')).ok, false);
  assert.equal(allowedCouponMutation('/on/demandware.store/Sites-continente-Site/default/Cart-ApplyCustomerBenefits', 'POST'), true);
  for (const [path, method] of [['/on/demandware.store/Sites-continente-Site/default/Cart-ApplyCustomerBenefits', 'GET'], ['/Cart-ApplyCustomerBenefits', 'POST'],
    ['/on/demandware.store/Sites-continente-Site/default/Cart-ApplyCustomerBenefits?x=1', 'POST'], ['https://attacker.invalid/on/demandware.store/Sites-continente-Site/default/Cart-ApplyCustomerBenefits', 'POST']] as const) {
    assert.equal(allowedCouponMutation(path, method), false, `${method} ${path}`);
  }
});

/** A storefront whose cart page shows `selections` in turn (null: no coupon form) and records coupon posts. */
function storefront(selections: (string[] | null)[], post: 'ok' | 'lost' | 'http' = 'ok', html = fixture('coupons-cart')) {
  let reads = 0; const posts: { url: string; form: Record<string, string> }[] = [];
  const page = { async waitForSelector() {}, async content() { return html; },
    async evaluate() { const value = selections[Math.min(reads++, selections.length - 1)]; return value === undefined ? null : value; } };
  const lease = { page, context: { request: { async post(url: string, options: { form: Record<string, string> }) {
    posts.push({ url, form: options.form });
    if (post === 'lost') throw new Error('synthetic lost response');
    return { ok: () => post === 'ok', status: () => post === 'ok' ? 200 : 500, url: () => url };
  } } } };
  const site = double<StorefrontClient>({ session: { async ensureReady() { return lease; } } as never,
    async navigateToStorefrontPage() { return ok(lease) as never; },
    async readPage() { return ok({ html: fixture('coupons'), url: 'https://www.continente.pt/conta/cartao-continente/', ready: true }) as never; },
    async io(_lease: unknown, operation: () => Promise<unknown>) { return operation(); } } as never);
  return { client: new CouponsClient(site), posts };
}

test('the coupon list marks what the cart has selected, or leaves it unknown when the cart has no coupon form', async () => {
  const listed = valueOf(await storefront([['10000002']]).client.fetchCoupons());
  assert.equal(listed.cartSelection, 'read');
  assert.deepEqual(listed.coupons.map(coupon => [coupon.couponId, coupon.selectedInCart]), [['10000001', false], ['10000002', true], ['10000003', null]]);
  const empty = valueOf(await storefront([null]).client.fetchCoupons());
  assert.equal(empty.cartSelection, 'unavailable');
  assert.ok(empty.coupons.every(coupon => coupon.selectedInCart === null));
});

test('selecting coupons posts the cart form\'s own fields once and is confirmed only by reading the cart back', async () => {
  const { client, posts } = storefront([[], ['10000001']]);
  assert.deepEqual(valueOf(await client.setSelectedCoupons(['10000001'])), { outcome: 'confirmed', selectedCouponIds: ['10000001'] });
  assert.equal(posts.length, 1);
  assert.equal(present(posts[0]).url, 'https://www.continente.pt/on/demandware.store/Sites-continente-Site/default/Cart-ApplyCustomerBenefits');
  assert.deepEqual(JSON.parse(present(present(posts[0]).form.carouselCoupons)), [{ id: '10000001', description: '5 euros in test items', amount: '5', unit: '€', isCarouselCoupon: 'true' }]);
  // Already the selection: nothing is written.
  const same = storefront([['10000001']]);
  assert.deepEqual(valueOf(await same.client.setSelectedCoupons(['10000001'])), { outcome: 'confirmed', selectedCouponIds: ['10000001'] });
  assert.equal(same.posts.length, 0);
});

test('an unconfirmed coupon change is unknown and never repeated; a coupon the cart does not offer is refused before writing', async () => {
  const unknown = (result: CouponSelectionResult) => result.outcome === 'unknown' && result.recovery.action === 'list_coupons' && !result.recovery.automaticReplay;
  for (const [selections, post] of [[[[], []], 'ok'], [[[], []], 'lost'], [[[]], 'http']] as const) {
    const { client, posts } = storefront(selections.map(value => [...value]), post);
    assert.ok(unknown(valueOf(await client.setSelectedCoupons(['10000001']))), post);
    assert.equal(posts.length, 1, post);
  }
  const refused = storefront([[]]);
  const result = await refused.client.setSelectedCoupons(['99999999']);
  assert.equal(result.ok, false); assert.match(result.ok ? '' : result.error.message, /does not offer coupon 99999999/);
  assert.equal(refused.posts.length, 0);
  assert.equal((await storefront([null]).client.setSelectedCoupons(['10000001'])).ok, false);
});

test('a checked coupon with incomplete form fields stays selected: a clear is confirmed only once the cart has no checked coupon', async () => {
  // 10000002 is checked but the form leaves out its amount, so it cannot be submitted.
  const html = fixture('coupons-cart').replace(' data-amount="10"', '');
  assert.deepEqual(valueOf(parseCartCouponForm(html, ['10000002'])).selectedIds, ['10000002']);
  const listed = valueOf(await storefront([['10000002']], 'ok', html).client.fetchCoupons());
  assert.deepEqual(listed.coupons.map(coupon => [coupon.couponId, coupon.selectedInCart]), [['10000001', false], ['10000002', true], ['10000003', null]]);
  // Clearing writes once and is confirmed by an empty readback.
  const cleared = storefront([['10000002'], []], 'ok', html);
  assert.deepEqual(valueOf(await cleared.client.setSelectedCoupons([])), { outcome: 'confirmed', selectedCouponIds: [] });
  assert.deepEqual(cleared.posts.map(post => JSON.parse(present(post.form.carouselCoupons))), [[]]);
  // A readback that still shows it checked is not a confirmed clear.
  const stuck = storefront([['10000002'], ['10000002']], 'ok', html);
  assert.equal(valueOf(await stuck.client.setSelectedCoupons([])).outcome, 'unknown');
  // It is already the selection, so keeping it alone writes nothing; keeping it alongside another is refused.
  const same = storefront([['10000002']], 'ok', html);
  assert.deepEqual(valueOf(await same.client.setSelectedCoupons(['10000002'])), { outcome: 'confirmed', selectedCouponIds: ['10000002'] });
  const keep = storefront([['10000002']], 'ok', html);
  const refused = await keep.client.setSelectedCoupons(['10000001', '10000002']);
  assert.equal(refused.ok ? null : refused.error.code, 'invalid_data');
  assert.equal(same.posts.length + keep.posts.length, 0);
});

test('coupon tools: the list, a confirmed selection, and an uncertain one that points to list_coupons', async t => {
  const { services, state } = injectedServices();
  const { client } = await connect(t, services);
  const listed = await client.callTool({ name: 'list_coupons', arguments: {} });
  assert.equal(dataOf(listed, CouponsData).coupons[0]?.couponId, '12345678');
  assert.match(textOf(listed), /couponId: 12345678/);
  assert.match(textOf(listed), /0 selected in the cart\./);
  const set = await client.callTool({ name: 'set_cart_coupons', arguments: { couponIds: ['12345678'] } });
  assert.deepEqual(dataOf(set, CouponSelectionData).selectedCouponIds, ['12345678']);
  assert.equal(state.writes, 1);
  services.coupons.setSelectedCoupons = async () => ok({ outcome: 'unknown', error: { code: 'cart_change_unconfirmed', message: 'unconfirmed', retryable: false },
    recovery: { action: 'list_coupons', automaticReplay: false } });
  const uncertain = await client.callTool({ name: 'set_cart_coupons', arguments: { couponIds: ['12345678'] } });
  assert.deepEqual(mutationOf(uncertain), { outcome: 'unknown', recovery: { action: 'list_coupons', automaticReplay: false } });
  assert.match(textOf(uncertain), /Call list_coupons before making another change/);
  // A failure inside the tool after it may have written also points to list_coupons, not get_cart.
  services.coupons.setSelectedCoupons = async () => { throw new Error('synthetic crash'); };
  const crashed = await client.callTool({ name: 'set_cart_coupons', arguments: { couponIds: [] } });
  assert.equal(toolError(crashed).code, 'internal_error');
  assert.deepEqual(mutationOf(crashed), { outcome: 'unknown', recovery: { action: 'list_coupons', automaticReplay: false } });
});
