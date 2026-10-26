import { load } from 'cheerio';
import type { Cheerio } from 'cheerio';
import type { AnyNode } from 'domhandler';
import { CouponListSchema } from '../domain/index.js';
import type { Coupon, CouponList, Result, ToolError } from '../domain/index.js';
import { failure, parseValue, success } from '../domain/index.js';

const text = (root: Cheerio<AnyNode>, selector: string): string | null => {
  const value = root.find(selector).first();
  const fromInput = value.is('input') ? value.attr('value') : null;
  const result = (fromInput ?? value.text()).replace(/\s+/g, ' ').trim();
  return result || null;
};

/** Parse only fields verified in the account coupon DOM; eligibility and expiry stay unknown. */
export function parseCouponsPage(html: string): Result<CouponList, ToolError> {
  const $ = load(html);
  const tiles = $('.loyalty-card-coupons .ct-account--coupon-tile.js-coupon-tile, .ct-account--coupon-tile.js-coupon-tile');
  const noCoupons = $('.loyalty-card-has-no-coupons').filter((_, element) => !$(element).hasClass('d-none')).length > 0;
  const coupons: Coupon[] = [];
  const seen = new Set<string>();
  tiles.each((_, element) => {
    const tile = $(element);
    const id = text(tile, '.ct-account--coupon-id') ?? tile.attr('data-coupon-id') ?? null;
    const description = text(tile, '.ct-account--coupon-description');
    if (!description) return;
    if (id && seen.has(id)) return;
    if (id) seen.add(id);
    coupons.push({ couponId: id, description, availability: text(tile, '.ct-account--coupon-availability'),
      benefitValue: text(tile, '.ct-account--coupon-badge-value'),
      benefitQualifier: text(tile, '.ct-account--coupon-badge-value-quantifier'), eligibility: 'unknown', expiry: null });
  });
  const completeness = noCoupons || (tiles.length > 0 && coupons.length === tiles.length)
    ? 'complete' : coupons.length > 0 ? 'partial' : 'unknown';
  const parsed = parseValue(CouponListSchema, { coupons, completeness }, 'coupon list');
  if (!parsed.ok) return parsed;
  if (!coupons.length && !noCoupons) return failure('invalid_data', 'The coupon page loaded without a recognised coupon list or empty-state marker');
  return success(parsed.value);
}
