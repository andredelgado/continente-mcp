import { load } from 'cheerio';
import { FavoriteProductSchema, ProductSchema, drainedPricePerKg, unitPriceOf, parsePriceTag, parseProductReference, parseValue, parsePromotionLabel, parsePromotionDates, previousPriceOf } from '../domain/index.js';
import type { FavoriteProduct, PriceTag, Product, Promotion, Result, ToolError } from '../domain/index.js';
import { failure, success } from '../domain/index.js';
import { parsePackageLabel } from './package.js';
import { record } from './records.js';

export const STOREFRONT_ORIGIN = 'https://www.continente.pt';
export function storefrontUrl(value: string): string | null {
  try { const url = new URL(value, STOREFRONT_ORIGIN); return url.origin === STOREFRONT_ORIGIN && !url.username && !url.password ? url.href : null; }
  catch { return null; }
}
const text = (value: string) => value.replace(/\s+/g, ' ').trim();
export function productReferenceFromUrl(href: string) {
  const url = storefrontUrl(href);
  const slug = url ? new URL(url).pathname.match(/^\/produto\/([^/]+)\.html$/)?.[1] : undefined;
  const parsed = parseProductReference(slug);
  // Slugs can contain encoded punctuation that tool inputs do not accept; fall back to the numeric ID.
  return parsed.ok ? parsed : parseProductReference(slug?.match(/-(\d+)(?:-master)?$/)?.[1]);
}

const PRICE_IN_LABEL = /\d+[,.]\d+\s*€(?:\s*\/\s*[a-z]+)?/gi;
const SEARCH_EMPTY = '.search-noresults-wrapper, .search-no-results, [data-search-empty]';
const PRODUCT_LINK = 'a[href*="/produto/"]';

/** Text after "=" in labels such as "Quant. Mínima = 600 gr (3 un)". */
export function minimumLabel(label: string): string | null {
  const [caption, ...rest] = label.split('=');
  return /m[ií]nim/i.test(caption ?? '') && rest.length ? text(rest.join('=')) || null : null;
}
/** Pack size from labels such as "emb. 940 gr" or "emb. 2 x 52 gr". */
export function packageLabel(label: string): string | null {
  return text(/^emb\.\s*(.+)$/i.exec(text(label))?.[1] ?? '') || null;
}
/** The amount in a "PVPR 6,00€" label, the recommended retail price shown beside a promotional price. */
export function recommendedPriceLabel(label: string): string {
  return text(label).replace(/^PVPR\s*/i, '');
}
/**
 * Promotions shown for a product: the promotional badge (a recommended price or an immediate
 * discount) and the multi-buy message. A badge is kept only when the product's own prices agree
 * with it: a tile for a family of pack sizes can show one size's badge beside another's price. The
 * dates on a product page are given once, so they are kept only when there is a single promotion
 * they can belong to.
 */
export function pagePromotions(shown: { badge: string; message: string; struck: string; recommended: PriceTag | null; price: PriceTag | null; validity?: string }): Promotion[] {
  const found = [shown.badge, shown.message].map(parsePromotionLabel).filter((promotion): promotion is Promotion => promotion !== null).filter(promotion => {
    if (promotion.kind === 'recommended_price') {
      const stated = parsePriceTag(/\d+(?:[.,]\d{1,2})?\s*€/.exec(promotion.label)?.[0] ?? '');
      promotion.previousPrice = shown.recommended;
      return stated.ok && stated.value !== null && shown.recommended?.amount.minorUnits === stated.value.amount.minorUnits;
    }
    if (promotion.kind === 'immediate_discount') {
      promotion.previousPrice = previousPriceOf(shown.struck, shown.price);
      return promotion.previousPrice !== null && shown.price !== null && promotion.previousPrice.amount.minorUnits > shown.price.amount.minorUnits;
    }
    return true;
  });
  const dates = shown.validity ? parsePromotionDates(shown.validity) : null;
  if (dates && found.length === 1) Object.assign(found[0]!, dates);
  return found;
}
/** How many pack sizes a tile's data-variants-mapping lists; 0 when it lists none or is unreadable. */
function variantCount(raw: string | undefined): number {
  try { const parsed: unknown = raw ? JSON.parse(raw) : null; return Array.isArray(parsed) ? parsed.length : 0; } catch { return 0; }
}
/** A product photo on the website's own image service; anything else is not used. */
export function productImageUrl(value: string | undefined | null): string | null {
  const href = value ? storefrontUrl(value) : null;
  return href && /\/images\//.test(new URL(href).pathname) ? href : null;
}
/** Brand and category path from the tile's analytics data, only when it names this product. */
function tileFacts(raw: string | undefined, productId: string): { brand: string | null; category: string | null } {
  let data: unknown = null;
  try { data = raw ? JSON.parse(raw) : null; } catch { /* Optional data stays unknown. */ }
  const facts = record(data);
  if (!facts || String(facts.id ?? '') !== productId) return { brand: null, category: null };
  const value = (input: unknown) => typeof input === 'string' && input.trim() && input !== 'undefined' ? text(input) : null;
  return { brand: value(facts.brand), category: value(facts.category) };
}
/** An unrecognised price is reported, not fatal: the product stays usable with an unknown price. */
function priceOrNull(label: string): { price: PriceTag | null; recognised: boolean } {
  const parsed = parsePriceTag(label);
  return parsed.ok ? { price: parsed.value, recognised: true } : { price: null, recognised: false };
}

export interface SearchPage {
  products: Product[];
  /** Each product's position in the website's full result list, counting from 0. */
  positions: number[];
  /** One entry per result that was skipped or kept with missing data. */
  problems: ToolError[];
}

/**
 * Parse one results page whose first result is at position `start` of the full list. A bad card
 * is reported in `problems` instead of failing the page.
 */
export function parseProductSearchPage(html: string, start = 0): Result<SearchPage, ToolError> {
  const $ = load(html);
  if ($(SEARCH_EMPTY).length) return success({ products: [], positions: [], problems: [] });
  const tiles = $($('.search-results-grid').length ? '.search-results-grid .ct-inner-tile-wrap' : '.ct-inner-tile-wrap').toArray();
  if (!tiles.length) return failure('invalid_data', 'The search results page was not recognised');
  const entries: { product: Product; position: number; family: boolean }[] = [];
  const problems: ToolError[] = [];
  const problem = (message: string) => problems.push(failure('invalid_data', message).error);
  tiles.forEach((tile, index) => {
    const card = $(tile);
    const position = `Search result ${start + index + 1}`;
    const links = card.find(PRODUCT_LINK).toArray().map(link => ({ href: $(link).attr('href'), label: text($(link).text()) }));
    const href = links[0]?.href;
    const name = links.map(link => link.label).find(Boolean);
    const reference = href ? productReferenceFromUrl(href) : null;
    if (!href || !name || !reference?.ok) { problem(`${position} was not recognised and was skipped.`); return; }
    // The ID comes from the first link and the name from the first with text: both must be the same product.
    if (links.some(link => { const other = link.href ? productReferenceFromUrl(link.href) : null; return !other?.ok || other.value.productId !== reference.value.productId; })) {
      problem(`${position} links to more than one product and was skipped.`); return;
    }
    const main = priceOrNull(text(card.find('.pwc-tile--price-primary').first().text()));
    const secondary = priceOrNull(text(card.find('.pwc-tile--price-secondary').first().text()));
    const recommended = priceOrNull(recommendedPriceLabel(card.find('.pvpr-info').first().parent().text()));
    if (!main.recognised) problem(`${position} (product ${reference.value.productId}) has a price in an unrecognised format; its price is unknown.`);
    if (!recommended.recognised) problem(`${position} (product ${reference.value.productId}) has a recommended price (PVPR) in an unrecognised format; it is unknown.`);
    const quantity = card.find('.pwc-tile--quantity').first().text();
    // Every tile carries an "Indisponível" badge, hidden with d-none while the product can be bought;
    // only an available tile has an add button. Anything else, such as markup without them, is unknown.
    const badge = card.find(`.dual-badge-unavailable-${reference.value.productId}`);
    const addButton = card.find('button.js-add-to-cart').length > 0;
    const availability = badge.length !== 1 ? 'unknown' : badge.hasClass('d-none') ? (addButton ? 'available' : 'unknown') : addButton ? 'unknown' : 'unavailable';
    const facts = tileFacts(card.closest('.product-tile').attr('data-product-tile-impression'), reference.value.productId);
    const pack = parsePackageLabel(packageLabel(quantity));
    const drained = drainedPricePerKg(main.price, pack);
    const product = parseValue(ProductSchema, { ...reference.value, name, url: storefrontUrl(href), price: main.price,
      secondaryPrice: secondary.price, packageText: packageLabel(quantity), package: parsePackageLabel(packageLabel(quantity)), minimumText: minimumLabel(quantity),
      recommendedPrice: recommended.price, availability, ...facts, drainedPrice: drained,
      promotions: pagePromotions({ badge: card.find('.ct-product-tile-badge--promotional img').first().attr('alt') ?? '',
        message: card.find(`.dual-badge-${reference.value.productId}.dual-badge-message .dual-badge-message-text`).first().text(),
        struck: card.find('.prices-wrapper .list .strike-through').first().text(), recommended: recommended.price, price: main.price }),
      unitPrice: unitPriceOf(main.price, secondary.price, pack, drained),
      // A tile can also show badge images; the product photo comes from the catalogue's image folder.
      imageUrl: productImageUrl(card.find('img').toArray().map(img => $(img).attr('data-src') ?? $(img).attr('src') ?? '').find(src => /master-catalog/.test(src))) }, 'product');
    // A tile for a family of pack sizes lists them in data-variants-mapping and shows "Desde" (from) prices.
    const family = variantCount(card.closest('.product-tile').attr('data-variants-mapping')) > 1;
    if (product.ok) entries.push({ product: product.value, position: start + index, family });
    else problem(`${position} (product ${reference.value.productId}) was not recognised and was skipped.`);
  });
  if (!entries.length && problems.length) return failure('invalid_data', 'No search result on the page could be recognised');
  // A product can appear twice: in a family tile and in its own tile. Its own tile has its own prices
  // and promotions, so it replaces the family tile, which keeps its place in the list.
  const unique: typeof entries = []; const at = new Map<string, number>();
  for (const entry of entries) {
    const index = at.get(entry.product.productId);
    if (index === undefined) { at.set(entry.product.productId, unique.length); unique.push(entry); }
    else if (unique[index]!.family && !entry.family) unique[index] = { ...entry, position: unique[index]!.position };
  }
  return success({ products: unique.map(entry => entry.product), positions: unique.map(entry => entry.position), problems });
}

export function parseFavoritesPageData(html: string): Result<{ items: FavoriteProduct[]; expectedIds: string[]; nextCursor: string | null }, ToolError> {
  const $ = load(html);
  const grids = $('.favorites-list .favorite-grid[data-pids]');
  if (grids.length !== 1) return failure('invalid_data', 'The favorites page was not recognised');
  const grid = grids.first();
  let rawIds: unknown;
  try { rawIds = JSON.parse(grid.attr('data-pids') ?? ''); } catch { return failure('invalid_data', 'The favorites product list is malformed'); }
  if (!Array.isArray(rawIds)) return failure('invalid_data', 'The favorites product list is malformed');
  const ids = rawIds.map(value => parseProductReference(value));
  if (ids.some(id => !id.ok)) return failure('invalid_data', 'The favorites product list is malformed');
  const expected = new Set(ids.flatMap(id => id.ok ? [id.value.productId] : []));
  const products: FavoriteProduct[] = [];
  let error: ToolError | undefined;
  grid.find('.favoriteProductTile').each((_, element) => {
    const card = $(element);
    const anchor = card.find('a[href*="/produto/"]').filter((_, element) => text($(element).text()).length > 0).first();
    const label = text(anchor.text());
    const href = anchor.attr('href') ?? '';
    const name = label.replace(PRICE_IN_LABEL, '').trim();
    if (!name) { error = failure('invalid_data', 'A favorite product was not recognised').error; return; }
    const ref = productReferenceFromUrl(href);
    const rawPrice = text(card.find('.pwc-tile--price-primary').first().text()) || label.match(PRICE_IN_LABEL)?.[0] || '';
    if (!ref.ok) { error = ref.error; return; }
    // Favorites must be complete, but an unrecognised price only makes that price unknown.
    const result = parseValue(FavoriteProductSchema, { ...ref.value, name, price: priceOrNull(rawPrice).price, url: storefrontUrl(href) }, 'favorite');
    if (result.ok) products.push(result.value); else error = result.error;
  });
  if (error) return { ok: false, error };
  const unique = uniqueProducts(products);
  if (unique.some(product => !expected.has(product.productId))) {
    return failure('invalid_data', 'The favorites page lists products it does not show');
  }
  const next = parseFavoritesContinuation(html);
  return next.ok ? success({ items: unique, expectedIds: [...expected], nextCursor: next.value }) : next;
}
export function parseFavoritesContinuation(html: string): Result<string | null, ToolError> {
  const $ = load(html);
  const links = $('.favorites-list a[rel~="next"]');
  if (!links.length) return success(null);
  const href = storefrontUrl(links.first().attr('href') ?? '');
  const url = href ? new URL(href) : null;
  if (links.length !== 1 || !url || !(url.pathname.endsWith('/Wishlist-RenderGrid') ||
    (url.pathname === '/conta/lista-produtos/' && url.searchParams.get('list') === 'favorites'))) {
    return failure('invalid_data', 'Invalid favorites continuation');
  }
  return success(href);
}
export function parseFavoritesPages(pages: string[]): Result<FavoriteProduct[], ToolError> {
  if (!pages.length) return failure('invalid_data', 'The favorites page was not recognised');
  const expected = new Set<string>(); const items: FavoriteProduct[] = [];
  let next: string | null = null;
  for (const html of pages) {
    const parsed = parseFavoritesPageData(html);
    if (!parsed.ok) return parsed;
    parsed.value.expectedIds.forEach(id => expected.add(id)); items.push(...parsed.value.items); next = parsed.value.nextCursor;
  }
  const unique = uniqueProducts(items);
  // The source identity list proves an empty grid is genuinely empty rather than still loading.
  if (next || unique.length !== expected.size) return failure('invalid_data', 'Not every favorite could be read');
  return success(unique);
}

export function uniqueProducts<T extends FavoriteProduct>(products: T[]): T[] {
  const seen = new Set<string>();
  return products.filter(product => { if (seen.has(product.productId)) return false; seen.add(product.productId); return true; });
}
export interface RankedProduct extends Product {
  /** This exact product is in the saved favorites. */
  favorite: boolean;
}
/**
 * The website orders results by relevance to the query; keep that order and only move exact
 * favorites to the front. Name similarity to favorites is not used: shared words such as a
 * brand name would pull unrelated products above real matches.
 */
/** Mark saved favorites; with `favoritesFirst`, move them ahead of the others, keeping each group's order. */
export function rankProductsByFavorites(products: Product[], favorites: FavoriteProduct[], favoritesFirst = true): RankedProduct[] {
  const favoriteIds = new Set(favorites.map(product => product.productId));
  const ranked = products.map(product => ({ ...product, favorite: favoriteIds.has(product.productId) }));
  return favoritesFirst ? [...ranked.filter(product => product.favorite), ...ranked.filter(product => !product.favorite)] : ranked;
}
export function parseSearchPagination(html: string): Result<{ url: string; start: number; size: number } | null, ToolError> {
  const actions = load(html)('[data-url*="Search-UpdateGrid"]');
  const action = actions.first().attr('data-url');
  if (!action) return success(null);
  const href = storefrontUrl(action);
  if (!href) return failure('invalid_data', 'Invalid search continuation');
  const url = new URL(href);
  const rawStart = url.searchParams.get('start') ?? ''; const rawSize = url.searchParams.get('sz') ?? '';
  const start = Number(rawStart); const size = Number(rawSize);
  return actions.length === 1 && url.pathname.endsWith('/Search-UpdateGrid') && /^\d+$/.test(rawStart) && /^\d+$/.test(rawSize) &&
    Number.isSafeInteger(start) && Number.isSafeInteger(size) && start >= 0 && size > 0 && size <= 200
    ? success({ url: href, start, size }) : failure('invalid_data', 'Invalid search continuation');
}
