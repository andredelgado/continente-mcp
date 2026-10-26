import type { CouponGateway, CouponSelectionGateway } from '../ports.js';
import { failure, success } from '../domain/index.js';
import type { Result, CouponList, ToolError } from '../domain/index.js';
import type { StorefrontClient } from './storefront.js';
import { parseCouponsPage } from '../parsers/coupons.js';
import { STOREFRONT_ORIGIN } from '../parsers/catalog.js';
import { parseBasketCoupons } from '../parsers/cart-coupons.js';
import type { BasketCouponState } from '../parsers/cart-coupons.js';
import { allowedCouponMutation, responseStatus } from './policy.js';
import { checkRequest, markWriteAttempted, requestTimeout, RequestStopped } from '../session/request.js';
import type { CouponSelection } from '../domain/index.js';
import { parseCheckoutContext } from '../parsers/checkout-summary.js';

/** Read coupon details already rendered on the authenticated account coupon page. */
export class CouponsClient implements CouponGateway {
  constructor(private readonly site: StorefrontClient) {}
  async fetchCoupons(): Promise<Result<CouponList, ToolError>> {
    const page = await this.site.readPage('/conta/cartao-continente/',
      '.loyalty-card-coupons .ct-account--coupon-tile.js-coupon-tile, .loyalty-card-has-no-coupons:not(.d-none)');
    if (!page.ok) return page;
    if (!page.value.ready) return failure('upstream_unavailable', 'The account coupon list did not finish loading');
    return parseCouponsPage(page.value.html);
  }
}

const CART_COUPONS_PATH = '/checkout/carrinho/';

/** Apply an explicit coupon set using fresh fields from the live basket form, then verify it. */
export class CartCouponSelectionClient implements CouponSelectionGateway {
  constructor(private readonly site: StorefrontClient) {}

  async fetchCheckoutContext(): Promise<Result<Pick<import('../domain/index.js').CheckoutSummary, 'loyaltyCredit' | 'selectedCouponIds'>, ToolError>> {
    const page = await this.site.navigateToStorefrontPage(CART_COUPONS_PATH);
    if (!page.ok) return page;
    try {
      const lease = page.value;
      try {
        await this.site.io(lease, () => lease.page.waitForSelector('.js-cart-subtotal',
          { state: 'attached', timeout: requestTimeout(5000) }));
      } catch (error) {
        if (error instanceof RequestStopped) throw error;
        return failure('upstream_unavailable', 'The basket summary did not finish loading');
      }
      let couponStateReady = false;
      try {
        couponStateReady = await this.site.io(lease, () => lease.page.waitForSelector(
          'form.coupon-carousel-form, .cart-empty, [data-cart-empty]',
          { state: 'attached', timeout: requestTimeout(3000) }).then(() => true, () => false));
      } catch (error) { if (error instanceof RequestStopped) throw error; }
      const html = await this.site.io(lease, () => lease.page.content());
      const selected = couponStateReady ? await this.site.io(lease, () => lease.page.evaluate(() => {
        const form = document.querySelector<HTMLFormElement>('form.coupon-carousel-form');
        return form ? [...new Set(Array.from(form.querySelectorAll<HTMLInputElement>('.coupon-carousel-input'))
          .filter(input => input.checked).map(input => input.value).filter(Boolean))] : null;
      })) : null;
      return success(parseCheckoutContext(html, selected));
    } catch (error) {
      if (error instanceof RequestStopped) throw error;
      return failure('upstream_unavailable', 'The basket summary could not be read');
    }
  }

  async setSelectedCoupons(couponIds: string[]): Promise<Result<CouponSelection, ToolError>> {
    const ids = [...new Set(couponIds)];
    if (ids.length !== couponIds.length || ids.some(id => !id.trim() || id.length > 200)) {
      return failure('invalid_input', 'Coupon IDs must be unique, non-empty IDs returned by list_coupons');
    }
    const before = await this.readBasketCoupons();
    if (!before.ok) return before;
    const byId = new Map(before.value.coupons.map(coupon => [coupon.id, coupon]));
    if (ids.some(id => !byId.has(id))) return failure('invalid_input', 'A requested coupon is not currently available in the basket');
    const coupons = ids.map(id => byId.get(id)!);
    const form = { carouselCoupons: JSON.stringify(coupons) };
    const action = before.value.action;
    if (!allowedCouponMutation(action, 'POST')) return failure('invalid_data', 'The coupon selection action is not allowlisted');
    const unknown = (current: string[] | null): Result<CouponSelection, ToolError> => success({
      outcome: 'unknown', selectedCouponIds: current,
      lastObservedSelectedCouponIds: current ?? before.value.selectedIds,
      recovery: { action: 'get_checkout_summary', automaticReplay: false },
    });

    try {
      const lease = await this.site.session.ensureReady();
      const headers = { 'X-Requested-With': 'XMLHttpRequest', Origin: STOREFRONT_ORIGIN,
        Referer: new URL(CART_COUPONS_PATH, STOREFRONT_ORIGIN).href };
      checkRequest();
      markWriteAttempted();
      const response = await this.site.io(lease, () => lease.context.request.post(new URL(action, STOREFRONT_ORIGIN).href,
        { headers, form, timeout: requestTimeout(10000), maxRedirects: 0 }));
      const status = responseStatus(response, response.url?.() ?? action);
      if (!status.ok) return unknown(null);
      // The response is not treated as proof of selection; only the basket state confirms it.
      await this.site.io(lease, () => response.json());
      const after = await this.readBasketCoupons();
      if (!after.ok) return unknown(null);
      if (!sameIds(after.value.selectedIds, ids)) {
        return unknown(after.value.selectedIds);
      }
      return { ok: true, value: { outcome: 'confirmed', selectedCouponIds: after.value.selectedIds } };
    } catch (error) {
      if (error instanceof RequestStopped) throw error;
      // The request may have reached Continente. Do not replay it automatically.
      return unknown(null);
    }
  }

  private async readBasketCoupons(): Promise<Result<BasketCouponState, ToolError>> {
    const page = await this.site.navigateToStorefrontPage(CART_COUPONS_PATH);
    if (!page.ok) return page;
    try {
      const lease = page.value;
      await this.site.io(lease, () => lease.page.waitForSelector('form.coupon-carousel-form',
        { state: 'attached', timeout: requestTimeout(10000) }));
      const html = await this.site.io(lease, () => lease.page.content());
      const selected = await this.site.io(lease, () => lease.page.evaluate(() => {
        const form = document.querySelector<HTMLFormElement>('form.coupon-carousel-form');
        return form ? Array.from(form.querySelectorAll<HTMLInputElement>('.coupon-carousel-input'))
          .filter(input => input.checked).map(input => input.value) : null;
      }));
      if (selected === null) return failure('invalid_data', 'The basket coupon form could not be read');
      return parseBasketCoupons(html, selected);
    } catch (error) {
      if (error instanceof RequestStopped) throw error;
      return failure('upstream_unavailable', 'The basket coupon form could not be read');
    }
  }
}

function sameIds(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every(id => right.includes(id));
}
