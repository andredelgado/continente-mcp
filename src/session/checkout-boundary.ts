import type { BrowserContext, Page, Request } from 'playwright';

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

/** A request the browser must never make: a forbidden checkout path, or a navigation that would take this session to another site. */
export function isBlockedBrowserRequest(value: string, navigation: boolean): boolean {
  let url: URL;
  try { url = new URL(value); } catch { return true; }
  if (url.protocol === 'data:' || url.protocol === 'blob:' || url.protocol === 'about:') return false;
  return isForbiddenCheckoutRequest(url.href) || (navigation && !/^(?:www\.|login\.)?continente\.pt$/i.test(url.hostname));
}

/**
 * Installs the browser boundary on a context: every request, including those issued by retailer
 * JavaScript, is checked before it is sent. Pages are also guarded as they open; callers that use a
 * page straight away await `guardPage` first.
 */
export async function installCheckoutBoundary(context: BrowserContext): Promise<void> {
  await context.route('**/*', route => {
    const request = route.request();
    // A page whose redirect guard is not active yet, such as a window the site opened itself, sends
    // nothing: its first request could redirect to checkout before the guard could see the hop. A new
    // window's first navigation arrives before its frame exists, so a navigation without one counts too.
    const page = requestPage(request);
    const unguarded = page === null ? request.isNavigationRequest() : !active.has(page);
    return unguarded || isBlockedBrowserRequest(request.url(), request.isNavigationRequest()) ? route.abort('blockedbyclient') : route.continue();
  });
  context.on('page', page => { guardPage(context, page).catch(() => undefined); });
}

/** The page a request belongs to, or null when it has none the boundary can tell. */
function requestPage(request: Request): Page | null {
  try { return request.frame().page(); } catch { return null; }
}

const guards = new WeakMap<Page, Promise<void>>();
/** Pages whose every request, redirect hops included, is now checked before it is sent. */
const active = new WeakSet<Page>();

/**
 * Playwright does not route the hops of a redirect: it lets Chromium follow them. Chromium's own
 * request interception pauses every hop, so each one is checked here before it is sent, and a
 * redirect from an allowed page to a forbidden path or another site never reaches its destination.
 */
export function guardPage(context: BrowserContext, page: Page): Promise<void> {
  let guard = guards.get(page);
  if (!guard) {
    guard = (async () => {
      const cdp = await context.newCDPSession(page);
      cdp.on('Fetch.requestPaused', event => {
        const blocked = isBlockedBrowserRequest(event.request.url, event.resourceType === 'Document');
        const decision = blocked
          ? cdp.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' })
          : cdp.send('Fetch.continueRequest', { requestId: event.requestId });
        decision.catch(() => undefined);
      });
      await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
      active.add(page);
    })();
    guards.set(page, guard);
  }
  return guard;
}
