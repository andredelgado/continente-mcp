import { STOREFRONT_ORIGIN, storefrontUrl } from '../parsers/catalog.js';
import { field } from '../parsers/records.js';
import { failure, success } from '../domain/index.js';
import type { CartOperation } from '../ports.js';

export function isLoginUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (url.origin === 'https://login.continente.pt' ||
      (url.origin === STOREFRONT_ORIGIN && /^\/login(?:\/|$)/i.test(url.pathname)));
  } catch { return false; }
}
export interface HttpResponse {
  ok(): boolean; status(): number; url?(): string; headers?(): Record<string, string>;
}
/** Only known authentication evidence triggers recovery; arbitrary upstream failures do not. */
export function responseStatus(response: HttpResponse | null, finalUrl: string) {
  const status = response?.status();
  const location = response?.headers?.().location;
  let redirect = '';
  try { if (location) redirect = new URL(location, STOREFRONT_ORIGIN).href; }
  catch { return failure('invalid_data', 'Invalid response redirect'); }
  if (status === 401 || status === 403 || isLoginUrl(finalUrl) || (status && status >= 300 && status < 400 && isLoginUrl(redirect))) {
    return failure('not_authenticated');
  }
  if (!storefrontUrl(finalUrl)) return failure('invalid_data', 'Unexpected response origin');
  if (status === 404) return failure('not_found');
  return response?.ok() ? success(undefined) : failure('upstream_unavailable', `The website returned HTTP ${status ?? 'with no status'}`);
}
export function authenticatedPayload(input: unknown) {
  return field(input, 'resources', 'customerAuthenticated') === false ? failure('not_authenticated') : success(input);
}

/** Each cart write the server makes, with the website endpoints and method that carry it. */
const CART_OPERATIONS: Record<CartOperation, { method: 'GET' | 'POST'; endpoints: readonly string[] }> = {
  add: { method: 'POST', endpoints: ['Cart-AddProduct'] },
  update: { method: 'GET', endpoints: ['Cart-UpdateQuantity'] },
  remove: { method: 'GET', endpoints: ['Cart-RemoveProduct', 'Cart-RemoveProductLineItem'] },
  clear: { method: 'POST', endpoints: ['Cart-RemoveAllProductLineItems'] },
};
export function cartOperationMethod(operation: CartOperation): 'GET' | 'POST' { return CART_OPERATIONS[operation].method; }

/**
 * Validate a retailer form action against the one cart operation the caller means to perform: an
 * add form pointing at "remove all", or a quantity control pointing at remove, is refused.
 */
export function allowedCartMutation(value: string, operation: CartOperation): boolean {
  try {
    const url = new URL(value, STOREFRONT_ORIGIN);
    if (url.origin !== STOREFRONT_ORIGIN || url.username || url.password || url.search || url.hash) return false;
    return (CART_OPERATIONS[operation]?.endpoints ?? []).some(endpoint =>
      url.pathname === `/${endpoint}` || url.pathname === `/on/demandware.store/Sites-continente-Site/default/${endpoint}`);
  } catch { return false; }
}

/** Coupon selection has its own endpoint and is never accepted as a product-cart action. */
export function allowedCouponMutation(value: string, method: 'GET' | 'POST'): boolean {
  try {
    const url = new URL(value, STOREFRONT_ORIGIN);
    return method === 'POST' && url.origin === STOREFRONT_ORIGIN && !url.username && !url.password && !url.search && !url.hash &&
      url.pathname === '/on/demandware.store/Sites-continente-Site/default/Cart-ApplyCustomerBenefits';
  } catch { return false; }
}
