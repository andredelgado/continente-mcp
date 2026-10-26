import { requestIO, requestTimeout, checkRequest, RequestStopped, reportProgress } from '../session/request.js';
import { isForbiddenCheckoutRequest } from '../session/checkout-boundary.js';
import { BrowserUnavailable } from '../session/chromium.js';
import type { CatalogGateway, FavoritesGateway, CartGateway, OrdersGateway, PreparedCartMutation, RetrievedPages, SearchResume } from '../ports.js';
import type { Product, Result, ToolError } from '../domain/index.js';
import { failure, success } from '../domain/index.js';
import { parseProductSearchPage, parseSearchPagination, parseFavoritesPageData, STOREFRONT_ORIGIN, storefrontUrl } from '../parsers/catalog.js';
import { SessionAccountMismatch } from '../session/browser.js';
import type { BrowserLease, StorefrontSession } from '../session/browser.js';
import { responseStatus, authenticatedPayload, allowedCartMutation } from './policy.js';
import { orderHistoryUrl } from '../parsers/orders.js';
import { field } from '../parsers/records.js';

export const CART_SUMMARY_URL = `${STOREFRONT_ORIGIN}/on/demandware.store/Sites-continente-Site/default/Cart-MiniCartShow`;
const ORDER_DETAIL_PATHS = ['/conta/detalhe-encomenda/', '/detalhe-encomenda'];
/** Map an error from starting or using the browser; cancellation keeps propagating. */
function browserFailure(error: unknown): { ok: false; error: ToolError } {
  if (error instanceof RequestStopped) throw error;
  if (error instanceof SessionAccountMismatch) return failure('not_authenticated', 'The saved session account could not be verified. Sign in again with the configured account.');
  return error instanceof BrowserUnavailable ? { ok: false, error: error.toolError } : failure('upstream_unavailable');
}
const productPath = (reference: string) => `/produto/${reference.endsWith('.html') ? reference : `${reference}.html`}`;

export class StorefrontClient {
  constructor(readonly session: StorefrontSession) {}
  io<T>(lease: BrowserLease, operation: () => Promise<T>): Promise<T> {
    return requestIO(operation, () => this.session.invalidate?.(lease) ?? lease.context.close());
  }
  async navigateToStorefrontPage(path: string): Promise<Result<BrowserLease, ToolError>> {
    const url = storefrontUrl(path);
    if (!url || isForbiddenCheckoutRequest(url)) return failure('invalid_data', 'This storefront page is outside the permitted shopping boundary');
    try {
      const lease = await this.session.ensureReady();
      const response = await this.io(lease, () => lease.page.goto(url, { waitUntil: 'domcontentloaded', timeout: requestTimeout(20000) }));
      const status = responseStatus(response, lease.page.url());
      if (!status.ok && status.error.code === 'not_authenticated') this.session.recordAuthentication?.(false);
      if (!status.ok) return status;
      return success(lease);
    } catch (error) { return browserFailure(error); }
  }
  /**
   * Load a page and wait for a marker only the expected page has. A fresh browser's first visit can
   * land on an interim page while the website sets up its session, so a page without the marker is
   * loaded once more; `ready` says whether the marker appeared. `landed` rejects a final URL early.
   */
  async readPage(path: string, marker: string, landed?: (url: URL) => ToolError | null): Promise<Result<{ html: string; url: string; ready: boolean }, ToolError>> {
    for (let attempt = 1; ; attempt++) {
      const response = await this.navigateToStorefrontPage(path);
      if (!response.ok) return response;
      const lease = response.value;
      const rejected = landed?.(new URL(lease.page.url()));
      if (rejected) return { ok: false, error: rejected };
      try {
        const ready = await this.io(lease, () => lease.page.waitForSelector(marker, { state: 'attached', timeout: requestTimeout(10000) }).then(() => true, () => false));
        if (ready || attempt === 2) return success({ html: await this.io(lease, () => lease.page.content()), url: lease.page.url(), ready });
      } catch (error) { return browserFailure(error); }
    }
  }
  async html(path: string, marker = 'main, [role="main"], .product-line, a[href*="/produto/"]'): Promise<Result<string, ToolError>> {
    const page = await this.readPage(path, marker);
    if (!page.ok) return page;
    return page.value.ready ? success(page.value.html) : failure('upstream_unavailable', 'Page readiness marker was not found');
  }
}
export class CatalogClient implements CatalogGateway {
  constructor(private readonly site: StorefrontClient) {}
  async fetchProductDetails(reference: string): Promise<Result<{ html: string; url: string }, ToolError>> {
    // The website redirects a product page it does not show to this session to its home page. It may be
    // sold elsewhere: the same product can open signed in and redirect signed out.
    const page = await this.site.readPage(productPath(reference), 'h1.product-name, .ct-pdp--prices',
      url => url.pathname.startsWith('/produto/') ? null : failure('not_found', 'The website does not show this product to this session: it may not be sold in your area, or no longer be sold').error);
    if (!page.ok) return page;
    return page.value.ready ? success({ html: page.value.html, url: page.value.url }) : failure('invalid_data', 'Product detail content is unavailable');
  }
  async fetchProductLabel(url: string): Promise<Result<string, ToolError>> {
    const href = storefrontUrl(url);
    if (!href || !new URL(href).pathname.endsWith('/Product-ProductNutritionalInfoTab')) return failure('invalid_input', 'Invalid product label URL');
    return readContinuation(this.site, href);
  }
  /**
   * Read result pages until `limit` products are collected, at most five pages. `resume` continues
   * at a position of the full list: from the results grid when its URL is known, otherwise from
   * the first page, whose earlier results the caller drops.
   */
  async searchProducts(query: string, limit: number, resume?: SearchResume, accept: (product: Product) => boolean = () => true): Promise<Result<RetrievedPages, ToolError>> {
    const from = resume?.start ?? 0;
    const resumeUrl = resume?.grid ? searchGridUrl(resume.grid, from) : null;
    const first = resumeUrl ? await readContinuation(this.site, resumeUrl)
      : await this.site.html(`/pesquisa/?q=${encodeURIComponent(query)}`, '.ct-inner-tile-wrap, .search-noresults-wrapper, .search-no-results, [data-search-empty]');
    if (!first.ok) return first;
    const pages: string[] = []; const starts: number[] = []; const failures: ToolError[] = []; const ids = new Set<string>(); const seen = new Set<string>(); const visited = new Set<string>();
    let html = first.value; let start = resumeUrl ? from : 0; let grid = resume?.grid ?? null; let nextCursor: string | null = null;
    for (let index = 0; index < 5; index++) {
      const parsed = parseProductSearchPage(html, start);
      if (!parsed.ok) { if (!pages.length) return parsed; failures.push(parsed.error); break; }
      const previousCount = seen.size;
      parsed.value.products.forEach((product, position) => {
        seen.add(product.productId);
        if ((parsed.value.positions[position] ?? 0) >= from && accept(product)) ids.add(product.productId);
      });
      pages.push(html); starts.push(start);
      reportProgress(pages.length, 5, 'Reading catalogue pages');
      const continuation = parseSearchPagination(html);
      if (!continuation.ok) { failures.push(continuation.error); nextCursor = null; break; }
      nextCursor = continuation.value?.url ?? null;
      if (continuation.value) grid ??= searchGridBase(continuation.value.url);
      if (!continuation.value || ids.size >= limit) break;
      if (visited.has(continuation.value.url) || (index > 0 && seen.size === previousCount)) { failures.push(failure('invalid_data', 'Search pagination did not advance').error); break; }
      if (index === 4) break;
      visited.add(continuation.value.url);
      const response = await readContinuation(this.site, continuation.value.url);
      if (!response.ok) { failures.push(response.error); break; }
      html = response.value; start = continuation.value.start;
    }
    return success({ pages, starts, grid, failures, nextCursor, completeness: failures.length ? 'partial' : nextCursor ? 'unknown' : 'complete' });
  }
}
/** The results grid URL without its position, so a search can continue anywhere in the list. */
export function searchGridBase(url: string): string {
  const base = new URL(url); base.searchParams.delete('start'); base.searchParams.delete('sz');
  return base.href;
}
export function searchGridUrl(base: string, start: number): string {
  const url = new URL(base); url.searchParams.set('start', String(start)); url.searchParams.set('sz', '35');
  return url.href;
}
async function readContinuation(site: StorefrontClient, url: string): Promise<Result<string, ToolError>> {
  try {
    const lease = await site.session.ensureReady();
    const response = await site.io(lease, () => lease.context.request.get(url, { timeout: requestTimeout(10000), maxRedirects: 0 }));
    const status = responseStatus(response, response.url?.() ?? url);
    return status.ok ? success(await site.io(lease, () => response.text())) : status;
  } catch (error) { return error instanceof RequestStopped ? failure(error.code) : browserFailure(error); }
}
export class FavoritesClient implements FavoritesGateway {
  constructor(private readonly site: StorefrontClient) {}
  async fetchFavorites(): Promise<Result<RetrievedPages, ToolError>> {
    const first = await this.site.html('/conta/lista-produtos/?list=favorites', '.favorites-list .favorite-grid[data-pids]');
    if (!first.ok) return first;
    const pages: string[] = []; const failures: ToolError[] = []; const visited = new Set<string>();
    let html = first.value; let nextCursor: string | null = null;
    for (let index = 0; index < 20; index++) {
      const parsed = parseFavoritesPageData(html);
      if (!parsed.ok) { if (!pages.length) return parsed; failures.push(parsed.error); break; }
      pages.push(html); nextCursor = parsed.value.nextCursor;
      reportProgress(pages.length, 20, 'Reading favorites pages');
      if (!nextCursor) break;
      if (visited.has(nextCursor)) { failures.push(failure('invalid_data', 'Favorites pagination did not advance').error); break; }
      if (index === 19) { failures.push(failure('upstream_unavailable', 'Favorites page limit reached; previous cache preserved').error); break; }
      visited.add(nextCursor);
      const response = await readContinuation(this.site, nextCursor);
      if (!response.ok) { failures.push(response.error); break; }
      html = response.value;
    }
    return success({ pages, failures, nextCursor, completeness: failures.length ? 'partial' : nextCursor ? 'unknown' : 'complete' });
  }
}
export class CartClient implements CartGateway {
  constructor(private readonly site: StorefrontClient) {}
  async fetchCart(): Promise<Result<unknown, ToolError>> {
    try {
      const lease = await this.site.session.ensureReady();
      const { context } = lease;
      const response = await this.site.io(lease, () => context.request.get(CART_SUMMARY_URL,
        { headers: { 'X-Requested-With': 'XMLHttpRequest' }, timeout: requestTimeout(10000), maxRedirects: 0 }));
      const status = responseStatus(response, response.url?.() ?? STOREFRONT_ORIGIN);
      if (!status.ok && status.error.code === 'not_authenticated') this.site.session.recordAuthentication?.(false);
      if (!status.ok) return status;
      const data: unknown = await this.site.io(lease, () => response.json());
      const authenticated = field(data, 'resources', 'customerAuthenticated');
      if (typeof authenticated === 'boolean') this.site.session.recordAuthentication?.(authenticated);
      return authenticatedPayload(data);
    } catch (error) { return browserFailure(error); }
  }
  async fetchProductForm(reference: string): Promise<Result<unknown, ToolError>> {
    const response = await this.site.navigateToStorefrontPage(productPath(reference));
    if (!response.ok) return response;
    try {
      await this.site.io(response.value, () => response.value.page.waitForSelector('input.add-to-cart-url', { state: 'attached', timeout: requestTimeout(10000) }));
      // Read current DOM properties: dynamic input values need not appear in serialized HTML.
      const raw: unknown = await this.site.io(response.value, () => response.value.page.evaluate(() => ({
        pid: document.querySelector<HTMLInputElement>('input[name="productID"]')?.value,
        action: document.querySelector<HTMLInputElement>('input.add-to-cart-url')?.value,
        csrf: document.querySelector<HTMLInputElement>('input[name="csrf_token"]')?.value ?? '',
        measureOptions: document.querySelector<HTMLElement>('.ct-tile-quantity-update[data-measure-options]')?.dataset.measureOptions ?? '{}',
      })));
      return success(raw);
    } catch (error) { if (error instanceof RequestStopped) throw error; return failure('invalid_data', 'The product page has no add-to-cart form'); }
  }
  fetchCartControls(): Promise<Result<string, ToolError>> { return this.site.html('/checkout/carrinho/', '.ct-tile-quantity-update, .cart-empty, [data-cart-empty]'); }
  async submitCartMutation(action: string, parameters: URLSearchParams, method: 'GET' | 'POST'): Promise<Result<unknown, ToolError>> {
    const prepared = await this.prepareCartMutation(action, parameters, method);
    return prepared.ok ? prepared.value() : prepared;
  }
  async prepareCartMutation(action: string, parameters: URLSearchParams, method: 'GET' | 'POST'): Promise<Result<PreparedCartMutation, ToolError>> {
    const href = storefrontUrl(action);
    if (!href || !allowedCartMutation(href, method)) return failure('invalid_data', 'The cart action is not an allowed operation');
    try {
      const lease = await this.site.session.ensureReady();
      const { context, page } = lease;
      const url = new URL(href);
      const headers = { 'X-Requested-With': 'XMLHttpRequest', Referer: page.url() };
      if (method === 'GET') for (const [key, value] of parameters) url.searchParams.set(key, value);
      const form = Object.fromEntries(parameters);
      return success(async () => { try {
      checkRequest();
      const response = await this.site.io(lease, () => method === 'GET' ? context.request.get(url.href, { headers, timeout: requestTimeout(10000), maxRedirects: 0 })
        : context.request.post(url.href, { headers: { ...headers, Origin: STOREFRONT_ORIGIN }, form, timeout: requestTimeout(10000), maxRedirects: 0 }));
      const status = responseStatus(response, response.url?.() ?? url.href);
      if (!status.ok && status.error.code === 'not_authenticated') this.site.session.recordAuthentication?.(false);
      if (!status.ok) return status;
      const data: unknown = await this.site.io(lease, () => response.json());
      const payload = authenticatedPayload(data);
      if (!payload.ok && payload.error.code === 'not_authenticated') this.site.session.recordAuthentication?.(false);
      return payload;
      } catch (error) { if (error instanceof RequestStopped) throw error; return failure('cart_change_unconfirmed'); } });
    } catch (error) { return browserFailure(error); }
  }
}
export class OrdersClient implements OrdersGateway {
  constructor(private readonly site: StorefrontClient) {}
  async fetchOrderHistory(cursor?: string): Promise<Result<string, ToolError>> {
    const path = cursor === undefined ? '/conta/encomendas/' : orderHistoryUrl(cursor);
    if (!path) return failure('invalid_input', 'Invalid order history cursor');
    // Without the marker the page is still handed to the parser, which says what it does not recognise.
    const page = await this.site.readPage(path, '.ct-order-history--landing-container, .ct-order-history--order-preview-item');
    return page.ok ? success(page.value.html) : page;
  }
  async fetchOrderLines(url: string): Promise<Result<string, ToolError>> {
    const href = storefrontUrl(url);
    if (!href || !ORDER_DETAIL_PATHS.includes(new URL(href).pathname)) return failure('invalid_input', 'Invalid order detail URL');
    const response = await this.site.navigateToStorefrontPage(href);
    if (!response.ok) return response;
    const final = new URL(response.value.page.url()); const requested = new URL(href);
    const id = requested.searchParams.get('orderID') ?? requested.searchParams.get('id');
    if (!ORDER_DETAIL_PATHS.includes(final.pathname) ||
      (id !== null && id !== (final.searchParams.get('orderID') ?? final.searchParams.get('id')))) return failure('order_details_unavailable', 'Order navigation changed identity');
    try {
      await this.site.io(response.value, () => response.value.page.waitForSelector('.ct-order-history--products-list-container, .product-line, .order-list-title', { state: 'attached', timeout: requestTimeout(10000) }));
      return success(await this.site.io(response.value, () => response.value.page.content()));
    } catch (error) { if (error instanceof RequestStopped) throw error; return failure('order_details_unavailable'); }
  }
}
