import { load } from 'cheerio';
import { parseMoneyAmount } from '../domain/index.js';
import type { Money } from '../domain/index.js';

/** Parse only the basket's earned loyalty credit. Immediate cart discounts come from cart totals. */
export function parseCheckoutContext(html: string, selectedCouponIds: string[] | null): {
  loyaltyCredit: Money | null; selectedCouponIds: string[] | null;
} {
  const $ = load(html);
  selectedCouponIds = selectedCouponIds === null ? null : [...new Set(selectedCouponIds.filter(id => id.trim()))];
  const area = $('.js-acumula-area').first();
  const value = area.find('.total-discount-value').first();
  let loyaltyCredit: Money | null = null;
  if (area.length && value.length && !area.hasClass('d-none') && !value.hasClass('d-none') &&
    area.attr('aria-hidden') !== 'true' && value.attr('aria-hidden') !== 'true') {
    const amount = parseMoneyAmount(value.text().replace(/\s+/g, ' ').trim());
    if (amount.ok) loyaltyCredit = amount.value;
  }
  return { loyaltyCredit, selectedCouponIds };
}
