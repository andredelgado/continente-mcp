import type { CouponGateway } from '../ports.js';
import type { CouponList, CouponSelectionResult, Result, ToolError } from '../domain/index.js';
import { failure, success } from '../domain/index.js';
import type { StorefrontClient } from './storefront.js';
import { parseCartCouponForm, parseCouponsPage } from '../parsers/coupons.js';
import type { CartCouponForm } from '../parsers/coupons.js';
import { STOREFRONT_ORIGIN } from '../parsers/catalog.js';
import { responseStatus } from './policy.js';
import { checkRequest, markWriteAttempted, requestTimeout, RequestStopped } from '../session/request.js';

const ACCOUNT_COUPONS_PATH = '/conta/cartao-continente/';
const CART_PATH = '/checkout/carrinho/';
const sameIds = (left: string[], right: string[]) => left.length === right.length && left.every(id => right.includes(id));

/** Cartão Continente coupons: the account's list, and which of them the cart uses. */
export class CouponsClient implements CouponGateway {
  constructor(private readonly site: StorefrontClient) {}

  async fetchCoupons(): Promise<Result<CouponList, ToolError>> {
    const page = await this.site.readPage(ACCOUNT_COUPONS_PATH, '.ct-account--coupon-tile.js-coupon-tile, .loyalty-card-has-no-coupons:not(.d-none)');
    if (!page.ok) return page;
    if (!page.value.ready) return failure('upstream_unavailable', 'The account coupon list did not finish loading');
    const listed = parseCouponsPage(page.value.html);
    if (!listed.ok) return listed;
    // The cart's coupon form says which coupons are selected; an empty cart has none to read.
    const form = await this.readCartCouponForm();
    const offered = form.ok ? new Set(form.value.coupons.map(coupon => coupon.id)) : null;
    const selected = form.ok ? new Set(form.value.selectedIds) : null;
    return success({ ...listed.value, cartSelection: form.ok ? 'read' : 'unavailable',
      coupons: listed.value.coupons.map(coupon => ({ ...coupon,
        // A checked box is selected even when its form fields are incomplete.
        selectedInCart: !coupon.couponId || !offered || !selected ? null : selected.has(coupon.couponId) ? true : offered.has(coupon.couponId) ? false : null })) });
  }

  /**
   * Submit the cart's own coupon form with exactly these coupons, using the fields the form gives
   * for each, then read the cart back. A write whose result cannot be read back is `unknown`.
   */
  async setSelectedCoupons(couponIds: string[]): Promise<Result<CouponSelectionResult, ToolError>> {
    const ids = [...new Set(couponIds)];
    if (ids.length !== couponIds.length) return failure('invalid_input', 'Each coupon ID may appear once');
    const before = await this.readCartCouponForm();
    if (!before.ok) return before;
    if (sameIds(before.value.selectedIds, ids)) return success({ outcome: 'confirmed', selectedCouponIds: before.value.selectedIds });
    const byId = new Map(before.value.coupons.map(coupon => [coupon.id, coupon]));
    // A coupon checked in the cart whose form fields are incomplete cannot be submitted again, so it can be
    // left out of the selection (and is then cleared) but not kept.
    const unreadable = ids.filter(id => !byId.has(id) && before.value.selectedIds.includes(id));
    if (unreadable.length) return failure('invalid_data', `The cart form does not give the details needed to keep coupon ${unreadable.join(', ')}, so the selection was not changed.`);
    const missing = ids.filter(id => !byId.has(id));
    if (missing.length) return failure('invalid_input', `The cart does not offer coupon ${missing.join(', ')}. Use list_coupons to see the cart's coupons.`);
    const unknown = (): Result<CouponSelectionResult, ToolError> => success({ outcome: 'unknown',
      error: { code: 'cart_change_unconfirmed', message: 'The coupon selection may have changed but could not be confirmed', retryable: false },
      recovery: { action: 'list_coupons', automaticReplay: false } });
    try {
      const lease = await this.site.session.ensureReady();
      const headers = { 'X-Requested-With': 'XMLHttpRequest', Origin: STOREFRONT_ORIGIN, Referer: new URL(CART_PATH, STOREFRONT_ORIGIN).href };
      const form = { carouselCoupons: JSON.stringify(ids.map(id => byId.get(id)!)) };
      checkRequest();
      markWriteAttempted();
      const response = await this.site.io(lease, () => lease.context.request.post(new URL(before.value.action, STOREFRONT_ORIGIN).href,
        { headers, form, timeout: requestTimeout(10000), maxRedirects: 0 }));
      if (!responseStatus(response, response.url?.() ?? before.value.action).ok) return unknown();
      // Only the cart's own state confirms the selection, not the response.
      const after = await this.readCartCouponForm();
      return after.ok && sameIds(after.value.selectedIds, ids) ? success({ outcome: 'confirmed', selectedCouponIds: after.value.selectedIds }) : unknown();
    } catch (error) {
      if (error instanceof RequestStopped) throw error;
      // The request may have reached Continente: report it as unknown, never send it again.
      return unknown();
    }
  }

  /** The cart page's coupon form, with the boxes checked in the live page. */
  private async readCartCouponForm(): Promise<Result<CartCouponForm, ToolError>> {
    const page = await this.site.navigateToStorefrontPage(CART_PATH);
    if (!page.ok) return page;
    const lease = page.value;
    try {
      const loaded = await this.site.io(lease, () => lease.page.waitForSelector('form.coupon-carousel-form, .cart-empty, [data-cart-empty]',
        { state: 'attached', timeout: requestTimeout(10000) }).then(() => true, () => false));
      if (!loaded) return failure('upstream_unavailable', 'The cart page did not finish loading');
      const html = await this.site.io(lease, () => lease.page.content());
      const checked = await this.site.io(lease, () => lease.page.evaluate(() => {
        const form = document.querySelector('form.coupon-carousel-form');
        return form ? [...form.querySelectorAll<HTMLInputElement>('.coupon-carousel-input')].filter(input => input.checked).map(input => input.value.trim()) : null;
      }));
      if (checked === null) return failure('not_found', 'The cart shows no coupon choices, for example because it is empty');
      return parseCartCouponForm(html, [...new Set(checked)]);
    } catch (error) {
      if (error instanceof RequestStopped) throw error;
      return failure('upstream_unavailable', 'The cart coupon form could not be read');
    }
  }
}
