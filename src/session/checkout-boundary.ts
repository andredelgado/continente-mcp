import type { BrowserContext } from 'playwright';

/** The server may inspect a basket and delivery choices, but never payment or reservations. */
export function isForbiddenCheckoutRequest(value: string): boolean {
  let url: URL;
  try { url = new URL(value, 'https://www.continente.pt'); } catch { return true; }
  if (!/(^|\.)continente\.pt$/i.test(url.hostname)) return false;
  let path = url.pathname;
  try { for (let i = 0; i < 3; i++) path = decodeURIComponent(path); } catch { return true; }
  path = path.replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase();
  if (path.startsWith('/checkout/') && !/^\/checkout\/(carrinho|entrega)\/?$/.test(path)) return true;
  if (/\/(?:checkout|checkoutservices)-/i.test(path) &&
    Array.from(url.searchParams).some(([key, val]) => /^(?:stage|step|action)$/i.test(key) && /payment|pagamento|placeorder|submitorder/i.test(val))) return true;
  return /(?:pagamento|payment|paypal|placeorder|submitorder|submitpayment|bookdeliveryslot|confirmorder)/i.test(path);
}

/** Runs before navigation/redirect requests, including requests issued by retailer JavaScript. */
export async function installCheckoutBoundary(context: BrowserContext): Promise<void> {
  await context.route('**/*', route => {
    const request = route.request();
    const url = new URL(request.url());
    // A redirect must not carry this session to an external payment provider.
    const externalDocument = request.isNavigationRequest() && !/^(?:www\.|login\.)?continente\.pt$/i.test(url.hostname);
    return isForbiddenCheckoutRequest(url.href) || externalDocument
      ? route.abort('blockedbyclient') : route.continue();
  });
}
