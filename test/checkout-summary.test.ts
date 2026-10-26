import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCheckoutContext } from '../src/parsers/checkout-summary.js';
import { fixture } from '../test-support/helpers.js';

test('basket summary keeps earned loyalty credit separate and selected coupons nullable', () => {
  assert.deepEqual(parseCheckoutContext(fixture('checkout-summary'), ['synthetic-coupon-001']), {
    loyaltyCredit: { currency: 'EUR', minorUnits: 235 }, selectedCouponIds: ['synthetic-coupon-001'],
  });
  assert.deepEqual(parseCheckoutContext(fixture('checkout-summary'), null).selectedCouponIds, null);
});

test('hidden, absent or unreadable loyalty credit remains unknown rather than zero', () => {
  const html = fixture('checkout-summary');
  assert.equal(parseCheckoutContext(html.replace('class="js-acumula-area"', 'class="js-acumula-area d-none"'), []).loyaltyCredit, null);
  assert.equal(parseCheckoutContext(html.replace('2,35 €', 'credit unavailable'), []).loyaltyCredit, null);
  assert.equal(parseCheckoutContext('<div class="js-cart-subtotal">Subtotal</div>', []).loyaltyCredit, null);
});
