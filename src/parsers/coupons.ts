import { load } from 'cheerio';
import type { Cheerio } from 'cheerio';
import type { AnyNode } from 'domhandler';
import { CouponSchema } from '../domain/index.js';
import type { Coupon, CouponList, Result, ToolError } from '../domain/index.js';
import { failure, parseValue, success } from '../domain/index.js';
import { allowedCouponMutation } from '../clients/policy.js';

const text = (root: Cheerio<AnyNode>, selector: string): string | null => {
  const value = root.find(selector).first();
  const fromInput = value.is('input') ? value.attr('value') : null;
  const result = (fromInput ?? value.text()).replace(/\s+/g, ' ').trim();
  return result || null;
};

/** The coupons on the account page (`/conta/cartao-continente/`), with only the fields it shows. */
export function parseCouponsPage(html: string): Result<Pick<CouponList, 'coupons' | 'completeness'>, ToolError> {
  const $ = load(html);
  const tiles = $('.ct-account--coupon-tile.js-coupon-tile');
  const noCoupons = $('.loyalty-card-has-no-coupons').filter((_, element) => !$(element).hasClass('d-none')).length > 0;
  const coupons: Coupon[] = [];
  const seen = new Set<string>();
  tiles.each((_, element) => {
    const tile = $(element);
    const id = text(tile, '.ct-account--coupon-id') ?? tile.attr('data-coupon-id') ?? null;
    const description = text(tile, '.ct-account--coupon-description');
    if (!description || (id && seen.has(id))) return;
    if (id) seen.add(id);
    const coupon = parseValue(CouponSchema, { couponId: id, description, availability: text(tile, '.ct-account--coupon-availability'),
      benefitValue: text(tile, '.ct-account--coupon-badge-value'), benefitQualifier: text(tile, '.ct-account--coupon-badge-value-quantifier'),
      selectedInCart: null }, 'coupon');
    if (coupon.ok) coupons.push(coupon.value);
  });
  if (!coupons.length && !noCoupons) return failure('invalid_data', 'The coupon page loaded without a recognised coupon list or empty-state marker');
  const completeness = noCoupons || coupons.length === tiles.length ? 'complete' : coupons.length > 0 ? 'partial' : 'unknown';
  return success({ coupons, completeness });
}

/** One coupon choice in the cart's coupon form, with the fields the form submits. */
export interface CartCoupon { id: string; description: string; amount: string; unit: string; isCarouselCoupon: string; }
export interface CartCouponForm { action: string; coupons: CartCoupon[]; selectedIds: string[]; }

/**
 * The cart page's coupon form. The slider repeats choices in clones, so they are kept once by ID.
 * `liveSelectedIds` are the boxes checked in the live page, which can differ from the HTML.
 */
export function parseCartCouponForm(html: string, liveSelectedIds?: string[]): Result<CartCouponForm, ToolError> {
  const $ = load(html);
  const form = $('form.coupon-carousel-form').first();
  const action = form.attr('action');
  if (!action || !allowedCouponMutation(action, 'POST')) return failure('invalid_data', 'The cart page did not show the coupon form');
  const coupons = new Map<string, CartCoupon>();
  const selected = new Set<string>(liveSelectedIds ?? []);
  form.find('.coupon-carousel-input').each((_, element) => {
    const input = $(element);
    const id = input.val()?.toString().trim() ?? '';
    if (!id || id.length > 200) return;
    if (liveSelectedIds === undefined && input.attr('checked') !== undefined) selected.add(id);
    if (coupons.has(id)) return;
    const [description, amount, unit, isCarouselCoupon] = ['data-description', 'data-amount', 'data-unit', 'data-is-carousel'].map(name => input.attr(name));
    if (description === undefined || amount === undefined || unit === undefined || isCarouselCoupon === undefined) return;
    coupons.set(id, { id, description, amount, unit, isCarouselCoupon });
  });
  return coupons.size ? success({ action, coupons: [...coupons.values()], selectedIds: [...selected].filter(id => coupons.has(id)) })
    : failure('invalid_data', 'The cart page did not show readable coupon choices');
}
