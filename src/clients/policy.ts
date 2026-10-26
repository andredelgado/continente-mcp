import { STOREFRONT_ORIGIN, storefrontUrl } from '../parsers/catalog.js';
import { field } from '../parsers/records.js';
import { failure, success } from '../domain/index.js';

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

/** Validate a retailer form action against the small cart operations this server supports. */
export function allowedCartMutation(value: string, method: 'GET' | 'POST'): boolean {
  try {
    const url = new URL(value, STOREFRONT_ORIGIN);
    if (url.origin !== STOREFRONT_ORIGIN || url.username || url.password || url.search || url.hash) return false;
    const path = url.pathname;
    if (!['/Cart-AddProduct', '/Cart-UpdateQuantity', '/Cart-RemoveProduct', '/Cart-RemoveProductLineItem', '/Cart-RemoveAllProductLineItems',
      '/on/demandware.store/Sites-continente-Site/default/Cart-AddProduct',
      '/on/demandware.store/Sites-continente-Site/default/Cart-UpdateQuantity',
      '/on/demandware.store/Sites-continente-Site/default/Cart-RemoveProduct',
      '/on/demandware.store/Sites-continente-Site/default/Cart-RemoveProductLineItem',
      '/on/demandware.store/Sites-continente-Site/default/Cart-RemoveAllProductLineItems'].includes(path)) return false;
    const operation = path.slice(path.lastIndexOf('Cart-') + 5).toLowerCase();
    if (!operation) return false;
    return ['addproduct', 'removeallproductlineitems'].includes(operation) ? method === 'POST' : method === 'GET';
  } catch { return false; }
}

/** Coupon selection has its own endpoint boundary and is never accepted as a product-cart action. */
export function allowedCouponMutation(value: string, method: 'GET' | 'POST'): boolean {
  try {
    const url = new URL(value, STOREFRONT_ORIGIN);
    return method === 'POST' && url.origin === STOREFRONT_ORIGIN && !url.username && !url.password && !url.search && !url.hash &&
      url.pathname === '/on/demandware.store/Sites-continente-Site/default/Cart-ApplyCustomerBenefits';
  } catch { return false; }
}

/** Primary pickup context has its own two-route boundary, separate from cart/coupon writes. */
export function allowedPickupStoreContextRequest(value: string, method: 'GET' | 'POST'): boolean {
  try {
    const url = new URL(value, STOREFRONT_ORIGIN);
    if (url.origin !== STOREFRONT_ORIGIN || url.username || url.password || url.search || url.hash) return false;
    const routes: Record<string, 'GET' | 'POST'> = {
      '/on/demandware.store/Sites-continente-Site/default/Stores-GetCoverageArea': 'GET',
      '/on/demandware.store/Sites-continente-Site/default/Stores-SetStoreContext': 'POST',
    };
    return routes[url.pathname] === method;
  } catch { return false; }
}
