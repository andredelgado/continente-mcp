import { load } from 'cheerio';
import { allowedCouponMutation } from '../clients/policy.js';
import { failure, success } from '../domain/index.js';
import type { Result, ToolError } from '../domain/index.js';

export interface BasketCoupon { id: string; description: string; amount: string; unit: string; isCarouselCoupon: string; }
export interface BasketCouponState { action: string; coupons: BasketCoupon[]; selectedIds: string[]; }

/** Extract the live coupon form and selected checkboxes from the basket page. Slick clones are deduplicated by id. */
export function parseBasketCoupons(html: string, liveSelectedIds?: string[]): Result<BasketCouponState, ToolError> {
  const $ = load(html);
  const form = $('form.coupon-carousel-form').first();
  const action = form.attr('action');
  if (!action || !allowedCouponMutation(action, 'POST')) {
    return failure('invalid_data', 'The basket page did not expose the verified coupon selection form');
  }
  const coupons = new Map<string, BasketCoupon>();
  const selected = new Set<string>(liveSelectedIds ?? []);
  form.find('.coupon-carousel-input').each((_, element) => {
    const input = $(element);
    const id = input.val()?.toString().trim() ?? '';
    if (!id || id.length > 200) return;
    if (liveSelectedIds === undefined && (input.is(':checked') || input.attr('checked') !== undefined)) selected.add(id);
    if (coupons.has(id)) return;
    const description = input.attr('data-description');
    const amount = input.attr('data-amount');
    const unit = input.attr('data-unit');
    const isCarouselCoupon = input.attr('data-is-carousel');
    if (description === undefined || amount === undefined || unit === undefined || isCarouselCoupon === undefined) return;
    coupons.set(id, { id, description, amount, unit, isCarouselCoupon });
  });
  return coupons.size ? success({ action, coupons: [...coupons.values()], selectedIds: [...selected] })
    : failure('invalid_data', 'The basket page did not expose readable coupon choices');
}
