import { present, valueOf, ok, fixture } from '../test-support/helpers.js';
import type { FavoritesCache } from '../src/domain/index.js';

import type { StorefrontClient } from '../src/clients/storefront.js';
import { double } from '../test-support/assertions.js';
import { CatalogClient, FavoritesClient } from '../src/clients/storefront.js';
import { CatalogService, FavoritesService } from '../src/services/catalog.js';
import { parseProductSearchPage, parseFavoritesPages, parseSearchPagination } from '../src/parsers/catalog.js';

import assert from 'node:assert/strict';
import test from 'node:test';

const searchPage = (ids: string[], next?: number) => ids.map(id => `<div class="ct-inner-tile-wrap"><a href="/produto/product-${id}.html">Product ${id}</a><span class="pwc-tile--price-primary">1,29 €</span></div>`).join('') +
  (next ? `<button data-url="/on/demandware.store/Sites-continente-Site/default/Search-UpdateGrid?q=milk&amp;start=${next}&amp;sz=2">More</button>` : '');
const favoritePage = (ids: string[], expected: string[], next?: number) => `<div class="favorites-list"><div class="favorite-grid" data-pids='${JSON.stringify(expected)}'>` +
  ids.map(id => `<div class="favoriteProductTile"><a href="/produto/product-${id}.html">Product ${id}</a></div>`).join('') + '</div>' +
  (next ? `<a rel="next" href="/conta/lista-produtos/?list=favorites&amp;start=${next}">Next</a>` : '') + '</div>';
function site(first: string, subsequent: (string | Error)[]) {
  const urls: string[] = [];
  return { urls, async html() { return ok(first); }, async io<T>(_lease: unknown, operation: () => Promise<T>) { return operation(); },
    session: { async ensureReady() { return { context: { request: { async get(url: string) {
      urls.push(url); const body = subsequent[urls.length - 1]; if (body instanceof Error) throw body;
      return { ok: () => true, status: () => 200, url: () => url, async text() { return present(body); } };
    } } } }; } } };
}
test('search scans enough explicit source pages for the limit regardless of cached favorites, deduplicates and retains prices', async () => {
  for (const favorites of [[], valueOf(parseFavoritesPages([fixture('favorites')]))] as const) {
    const source = site(searchPage(['1', '2'], 2), [searchPage(['2', '3'], 4), searchPage(['4', '5'])]);
    const service = new CatalogService(new CatalogClient(double<StorefrontClient>(source)), double<FavoritesService>({ async loadCachedFavorites() { return { favorites: [...favorites] }; } }));
    const result = valueOf((await service.searchProducts('milk', 4)));
    assert.equal(result.scanned, 5); assert.deepEqual(result.page.items.map(item => item.productId), ['1', '2', '3', '4']);
    // Product 5 was read but not returned, so the search is not complete and the cursor resumes at it.
    assert.equal(result.page.completeness, 'unknown'); assert.equal(source.urls.length, 2);
    assert.equal(present(present(result.page.items[0]).price).amount.minorUnits, 129);
    const rest = site('', [searchPage(['5'])]);
    const resumed = valueOf(await new CatalogService(new CatalogClient(double<StorefrontClient>(rest)), double<FavoritesService>({ async loadCachedFavorites() { return null; } }))
      .searchProducts('milk', 4, { cursor: present(result.page.nextCursor) }));
    assert.deepEqual(resumed.page.items.map(item => item.productId), ['5']);
    assert.equal(resumed.page.completeness, 'complete'); assert.equal(resumed.page.nextCursor, null);
    assert.match(present(rest.urls[0]), /Search-UpdateGrid\?q=milk&start=5&sz=35$/);
  }
});
/** A results grid that serves any `start` and `sz`, like the website's Search-UpdateGrid. */
function grid(ids: string[], pageSize: number) {
  const slice = (start: number, size: number) => {
    const end = Math.min(start + size, ids.length);
    return ids.slice(start, end).map(id => `<div class="ct-inner-tile-wrap"><a href="/produto/product-${id}.html">Product ${id}</a><span class="pwc-tile--price-primary">1,29 €</span></div>`).join('') +
      (end < ids.length ? `<button data-url="/on/demandware.store/Sites-continente-Site/default/Search-UpdateGrid?q=milk&amp;start=${end}&amp;sz=${size}">More</button>` : '');
  };
  const urls: string[] = [];
  return { urls, async html() { return ok(slice(0, pageSize)); }, async io<T>(_lease: unknown, operation: () => Promise<T>) { return operation(); },
    session: { async ensureReady() { return { context: { request: { async get(url: string) {
      urls.push(url); const params = new URL(url).searchParams;
      return { ok: () => true, status: () => 200, url: () => url, async text() { return slice(Number(params.get('start')), Number(params.get('sz'))); } };
    } } } }; } } };
}
test('a search cursor resumes exactly, only for the same query and only on the results grid', async () => {
  const favorites = double<FavoritesService>({ async loadCachedFavorites() { return null; } });
  const service = new CatalogService(new CatalogClient(double<StorefrontClient>(grid(['1', '2', '3', '4', '5', '6', '7'], 3))), favorites);
  const seen: string[] = []; let cursor: string | undefined;
  do {
    const page = valueOf(await service.searchProducts('milk', 2, cursor ? { cursor } : {}));
    seen.push(...page.page.items.map(item => item.productId)); cursor = page.page.nextCursor ?? undefined;
  } while (cursor && seen.length < 10);
  assert.deepEqual(seen, ['1', '2', '3', '4', '5', '6', '7']);
  // Without a grid URL (one page of results), the first page is read again and earlier results are dropped.
  const single = new CatalogService(new CatalogClient(double<StorefrontClient>(site(searchPage(['1', '2', '3']), []))), favorites);
  const first = valueOf(await single.searchProducts('milk', 2));
  assert.deepEqual(first.page.items.map(item => item.productId), ['1', '2']);
  const second = valueOf(await single.searchProducts('milk', 2, { cursor: present(first.page.nextCursor) }));
  assert.deepEqual(second.page.items.map(item => item.productId), ['3']); assert.equal(second.page.nextCursor, null);
  const valid = present(first.page.nextCursor);
  const forged = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  for (const cursor of ['not a cursor', forged({ v: 1, q: 'milk', start: -1, grid: null }),
    forged({ v: 1, q: 'milk', start: 2, grid: 'https://other.invalid/Search-UpdateGrid?q=milk' }),
    forged({ v: 1, q: 'milk', start: 2, grid: 'https://www.continente.pt/on/demandware.store/Sites-continente-Site/default/Cart-AddProduct?q=milk' }),
    forged({ v: 1, q: 'milk', start: 2, grid: 'https://www.continente.pt/on/demandware.store/Sites-continente-Site/default/Search-UpdateGrid?q=beer' })]) {
    const result = await single.searchProducts('milk', 2, { cursor });
    assert.equal(result.ok ? null : result.error.code, 'invalid_input', cursor);
  }
  const other = await single.searchProducts('beer', 2, { cursor: valid });
  assert.deepEqual(other.ok ? null : [other.error.code, other.error.message], ['invalid_input', 'This cursor belongs to a search for different text']);
});
test('search stops at requested limit and returns only a real remaining cursor; later failures retain successful products', async () => {
  const bounded = site(searchPage(['1', '2'], 2), []);
  const result = valueOf((await new CatalogClient(double<StorefrontClient>(bounded)).searchProducts('milk', 1)));
  assert.equal(bounded.urls.length, 0); assert.equal(result.completeness, 'unknown');
  assert.match(present(result.nextCursor), /start=2/);
  const capped = site(searchPage(['1'], 1), Array.from({ length: 5 }, (_, i) => searchPage([String(i + 2)], i + 2)));
  const cappedResult = valueOf((await new CatalogClient(double<StorefrontClient>(capped)).searchProducts('milk', 50)));
  assert.equal(cappedResult.pages.length, 5); assert.equal(capped.urls.length, 4); assert.match(present(cappedResult.nextCursor), /start=5/);
  for (const response of [new Error('timeout'), '<main>unrecognized</main>'] as const) {
    const source = site(searchPage(['1', '2'], 2), [response]);
    const partial = valueOf((await new CatalogClient(double<StorefrontClient>(source)).searchProducts('milk', 4)));
    assert.equal(partial.completeness, 'partial'); assert.equal(partial.pages.length, 1); assert.equal(partial.failures.length, 1);
    assert.match(present(partial.nextCursor), /start=2/);
  }
});
test('search empty recognition ignores recommendations and malformed continuations are never guessed', () => {
  assert.deepEqual(valueOf(parseProductSearchPage('<div class="search-noresults-wrapper"></div>' + searchPage(['1']))), { products: [], positions: [], problems: [] });
  assert.equal(parseProductSearchPage('<main>unrecognized</main>').ok, false);
  for (const action of ['/Search-UpdateGrid?sz=2', '/Search-UpdateGrid?start=2&sz=1.5', '/Search-UpdateGrid?start=2&sz=0',
    '/Cart-RemoveProduct?Search-UpdateGrid&start=2&sz=2', 'https://other.invalid/Search-UpdateGrid?start=2&sz=2'] as const) {
    assert.equal(parseSearchPagination(`<button data-url="${action}"></button>`).ok, false);
  }
});
test('favorites traverse explicit read-only next links before saving a complete snapshot', async () => {
  const source = site(favoritePage(['1'], ['1', '2'], 1), [favoritePage(['2'], ['1', '2'])]);
  let saved: FavoritesCache | undefined;
  const service = new FavoritesService(new FavoritesClient(double<StorefrontClient>(source)), { async load() { return ok(null); }, async save(value) { saved = value; return ok(); } },
    { now: () => new Date('2026-10-14T12:00:00Z') }, 'test', () => {});
  const result = await service.refreshFavorites();
  assert.equal(result.ok, true); assert.equal(present(saved).favorites.length, 2); assert.equal(present(saved).completeness, 'complete'); assert.equal(source.urls.length, 1);
});
test('favorites continuation failures, loops, missing products and mutation URLs never replace a valid snapshot', async () => {
  for (const mode of ['failure', 'loop', 'missing', 'write-url'] as const) {
    let first = favoritePage(['1'], ['1', '2'], 1);
    if (mode === 'write-url') first = first.replace('/conta/lista-produtos/?list=favorites&amp;start=1', '/Cart-RemoveProduct?uuid=secret');
    const source = site(first, [mode === 'failure' ? new Error('timeout') : mode === 'loop' ? first : favoritePage([], ['1', '2'])]);
    let saves = 0; const previous: FavoritesCache = { schemaVersion: 2, accountScope: 'test', fetchedAt: '2026-10-14T12:00:00Z', favorites: valueOf(parseFavoritesPages([fixture('favorites')])) };
    const service = new FavoritesService(new FavoritesClient(double<StorefrontClient>(source)), { async load() { return ok(previous); }, async save() { saves++; return ok(); } },
      { now: () => new Date() }, 'test', () => {});
    assert.equal((await service.refreshFavorites()).ok, false); assert.equal(saves, 0);
    if (mode === 'write-url') assert.equal(source.urls.length, 0);
  }
  const capped = site(favoritePage(['1'], ['1'], 1), Array.from({ length: 20 }, (_, i) => favoritePage(['1'], ['1'], i + 2)));
  const result = valueOf((await new FavoritesClient(double<StorefrontClient>(capped)).fetchFavorites()));
  assert.equal(result.pages.length, 20); assert.equal(capped.urls.length, 19); assert.equal(result.completeness, 'partial');
});

interface TileSpec { id: string; category: string; brand: string; price: string; label?: string }
/** Like `grid`, with each tile's analytics data, price and pack label. */
function catalogue(specs: TileSpec[], pageSize: number) {
  const slice = (start: number, size: number) => {
    const end = Math.min(start + size, specs.length);
    return specs.slice(start, end).map(spec => `<div class="product-tile" data-product-tile-impression='${JSON.stringify({ id: spec.id, brand: spec.brand, category: spec.category })}'>` +
      `<div class="ct-inner-tile-wrap"><a href="/produto/product-${spec.id}.html">Product ${spec.id}</a><span class="pwc-tile--price-primary">${spec.price}</span>` +
      `${spec.label ? `<span class="pwc-tile--quantity">emb. ${spec.label}</span>` : ''}</div></div>`).join('') +
      (end < specs.length ? `<button data-url="/on/demandware.store/Sites-continente-Site/default/Search-UpdateGrid?q=tofu&amp;start=${end}&amp;sz=${size}">More</button>` : '');
  };
  const urls: string[] = [];
  return { urls, async html() { return ok(slice(0, pageSize)); }, async io<T>(_lease: unknown, operation: () => Promise<T>) { return operation(); },
    session: { async ensureReady() { return { context: { request: { async get(url: string) {
      urls.push(url); const params = new URL(url).searchParams;
      return { ok: () => true, status: () => 200, url: () => url, async text() { return slice(Number(params.get('start')), Number(params.get('sz'))); } };
    } } } }; } } };
}
const food = 'Supermercado/Frescos/Tofu'; const pets = 'Animais/Gato/Areias e Absorventes';
test('category and brand filters keep reading pages until enough products match', async () => {
  const specs = [{ id: '1', category: pets, brand: 'Catfield', price: '7,99€' }, { id: '2', category: pets, brand: 'Catfield', price: '6,99€' },
    { id: '3', category: food, brand: 'Continente', price: '1,99€' }, { id: '4', category: pets, brand: 'Catfield', price: '5,99€' },
    { id: '5', category: food, brand: 'Joya', price: '2,49€' }, { id: '6', category: 'Supermercado/Laticínios e Ovos/Iogurtes', brand: 'Continente', price: '0,99€' }];
  const favorites = double<FavoritesService>({ async loadCachedFavorites() { return null; } });
  const run = async (options: object, limit = 2) => {
    const source = catalogue(specs, 2);
    const result = valueOf(await new CatalogService(new CatalogClient(double<StorefrontClient>(source)), favorites).searchProducts('tofu', limit, options));
    return { ids: result.page.items.map(item => item.productId), cursor: result.page.nextCursor, reads: source.urls.length };
  };
  const notPets = await run({ excludeCategory: 'animais' });
  assert.deepEqual(notPets.ids, ['3', '5']); assert.equal(notPets.reads, 2);
  assert.deepEqual((await run({ category: 'supermercado/frescos' })).ids, ['3', '5']);
  assert.deepEqual((await run({ category: 'LATICINIOS' })).ids, ['6']);
  assert.deepEqual((await run({ brand: 'continente' }, 5)).ids, ['3', '6']);
  assert.deepEqual((await run({ brand: 'nobody' }, 5)).ids, []);
  // Products the page gives no category or brand for are counted when a filter leaves them out.
  const unknown = [...specs.slice(0, 3), { id: '7', category: '', brand: '', price: '1,49€' }, { id: '8', category: pets, brand: '', price: '1,49€' }];
  const counted = async (options: object) => valueOf(await new CatalogService(new CatalogClient(double<StorefrontClient>(catalogue(unknown, 10))), favorites).searchProducts('tofu', 10, options));
  assert.deepEqual([(await counted({ category: 'supermercado' })).unknownToFilter, (await counted({ brand: 'continente' })).unknownToFilter], [1, 2]);
  assert.equal((await counted({ excludeCategory: 'animais' })).unknownToFilter, 0);
  assert.equal((await counted({ category: 'supermercado', brand: 'joya' })).unknownToFilter, 1);
  assert.equal((await counted({})).unknownToFilter, 0);
  // A filtered cursor continues after the last product returned.
  const first = await run({ category: 'supermercado' }, 1);
  assert.deepEqual(first.ids, ['3']);
  const service = new CatalogService(new CatalogClient(double<StorefrontClient>(catalogue(specs, 2))), favorites);
  const next = valueOf(await service.searchProducts('tofu', 5, { category: 'supermercado', cursor: present(first.cursor) }));
  assert.deepEqual(next.page.items.map(item => item.productId), ['5', '6']);
});
test('unit_price sorts the returned products by drained kg, kg or litre and keeps the rest in order', async () => {
  const specs = [{ id: '1', category: food, brand: 'A', price: '1,15€', label: '120 gr (peso escorrido 78 gr)' }, { id: '2', category: food, brand: 'B', price: '2,00€/kg' },
    { id: '3', category: food, brand: 'C', price: '3,00€' }, { id: '4', category: food, brand: 'D', price: '0,90€/lt' }, { id: '5', category: food, brand: 'E', price: '1,50€/kg' }];
  const favorites = double<FavoritesService>({ async loadCachedFavorites() { return null; } });
  const service = new CatalogService(new CatalogClient(double<StorefrontClient>(catalogue(specs, 10))), favorites);
  const sorted = valueOf(await service.searchProducts('tofu', 10, { sort: 'unit_price' }));
  assert.deepEqual(sorted.page.items.map(item => item.productId), ['5', '2', '1', '4', '3']);
  const relevance = valueOf(await service.searchProducts('tofu', 10, {}));
  assert.deepEqual(relevance.page.items.map(item => item.productId), ['1', '2', '3', '4', '5']);
  // Packs without a website price per litre are compared on their pack price over the net quantity.
  const drinks = [{ id: '6', category: food, brand: 'A', price: '1,09€', label: '3 x 200 ml' }, { id: '7', category: food, brand: 'B', price: '2,99€', label: '3 x 250 ml' },
    { id: '8', category: food, brand: 'C', price: '0,79€', label: '1 lt' }, { id: '9', category: food, brand: 'D', price: '1,29€', label: '1 lt' }];
  const soy = new CatalogService(new CatalogClient(double<StorefrontClient>(catalogue(drinks, 10))), favorites);
  assert.deepEqual(valueOf(await soy.searchProducts('soja', 10, { sort: 'unit_price' })).page.items.map(item => item.productId), ['8', '9', '6', '7']);
  // When most products are priced per litre, those come first: chocolate milk per kg does not lead a milk search.
  const milk = [{ id: '10', category: food, brand: 'A', price: '7,72€/kg' }, { id: '11', category: food, brand: 'B', price: '0,85€/lt' }, { id: '12', category: food, brand: 'C', price: '0,83€/lt' }];
  const dairy = new CatalogService(new CatalogClient(double<StorefrontClient>(catalogue(milk, 10))), favorites);
  assert.deepEqual(valueOf(await dairy.searchProducts('leite', 10, { sort: 'unit_price' })).page.items.map(item => item.productId), ['12', '11', '10']);
});

test('favoritesFirst on a first page scans every page a search may read and puts the favorites found there first', async () => {
  const ids = Array.from({ length: 30 }, (_, index) => String(index + 1));
  const favorites = (list: string[]) => double<FavoritesService>({ async loadCachedFavorites() {
    return { favorites: list.map(productId => ({ productId, productSlug: null, name: `Product ${productId}`, price: null, url: `https://www.continente.pt/produto/product-${productId}.html` })) } as never; } });
  const service = (list: string[], source = grid(ids, 3)) => ({ source, catalog: new CatalogService(new CatalogClient(double<StorefrontClient>(source)), favorites(list)) });
  // Favorites 8 and 14 are beyond the first page of 4. Pages hold 3, so five pages reach product 15.
  const { source, catalog } = service(['14', '8', '29']);
  const first = valueOf(await catalog.searchProducts('milk', 4, { favoritesFirst: true }));
  assert.deepEqual(first.page.items.map(item => [item.productId, item.favorite]), [['8', true], ['14', true], ['1', false], ['2', false]]);
  assert.equal(first.favoritesPromoted, 2); assert.equal(first.scanned, 15); assert.equal(source.urls.length, 4);
  // Following the cursors returns every other product once: the promoted favorites are not repeated, product 29 keeps its place.
  const seen: string[] = first.page.items.map(item => item.productId); let cursor = first.page.nextCursor;
  while (cursor && seen.length < 40) {
    const page = valueOf(await catalog.searchProducts('milk', 4, { favoritesFirst: true, cursor }));
    assert.equal(page.favoritesPromoted, 0);
    seen.push(...page.page.items.map(item => item.productId)); cursor = page.page.nextCursor;
  }
  assert.deepEqual([...seen].sort((a, b) => Number(a) - Number(b)), ids);
  assert.ok(seen.indexOf('29') > seen.indexOf('28') - 4 && seen.indexOf('29') > 4);
  // More favorites than the limit: the first page is only favorites, and the rest come in their own place later.
  const crowded = service(['2', '5', '7', '9']).catalog;
  const top = valueOf(await crowded.searchProducts('milk', 2, { favoritesFirst: true }));
  assert.deepEqual(top.page.items.map(item => item.productId), ['2', '5']);
  const after = valueOf(await crowded.searchProducts('milk', 4, { cursor: present(top.page.nextCursor) }));
  assert.deepEqual(after.page.items.map(item => item.productId), ['1', '3', '4', '6']);
  // Without favoritesFirst, or without saved favorites, a search reads only what it needs.
  for (const [list, options] of [[['8'], {}], [[], { favoritesFirst: true }]] as const) {
    const plain = service([...list]);
    const result = valueOf(await plain.catalog.searchProducts('milk', 4, options));
    assert.deepEqual(result.page.items.map(item => item.productId), ['1', '2', '3', '4']);
    assert.equal(result.favoritesPromoted, 0); assert.equal(plain.source.urls.length, 1);
  }
});

test('a search cursor rejects a malformed list of favorites to skip', async () => {
  const catalog = new CatalogService(new CatalogClient(double<StorefrontClient>(grid(['1', '2', '3'], 3))), double<FavoritesService>({ async loadCachedFavorites() { return null; } }));
  for (const skip of [['x'], Array.from({ length: 51 }, (_, index) => String(index))]) {
    const cursor = Buffer.from(JSON.stringify({ v: 1, q: 'milk', start: 1, grid: null, skip })).toString('base64url');
    assert.equal((await catalog.searchProducts('milk', 2, { cursor })).ok, false);
  }
});

test('unit_price reads every page in the website\'s order, sorts again by the prices read, and pages through that sorted list', async () => {
  // The website's own order is not always right: product 7 sorts first but is the dearest.
  const specs = [{ id: '7', category: food, brand: 'A', price: '9,00€/kg' }, { id: '1', category: food, brand: 'A', price: '1,00€/kg' },
    { id: '3', category: food, brand: 'A', price: '3,00€/kg' }, { id: '2', category: food, brand: 'A', price: '2,00€/kg' },
    { id: '5', category: food, brand: 'A', price: '5,00€/kg' }, { id: '4', category: food, brand: 'A', price: '4,00€/kg' }];
  const favorites = double<FavoritesService>({ async loadCachedFavorites() { return null; } });
  const base = catalogue(specs, 2); const paths: string[] = [];
  const source = { ...base, async html(path: string) { paths.push(path); return base.html(); } };
  const service = new CatalogService(new CatalogClient(double<StorefrontClient>(source)), favorites);
  const first = valueOf(await service.searchProducts('tofu', 2, { sort: 'unit_price', promotion: 'discount' }));
  assert.deepEqual(first.page.items.map(item => item.productId), ['1', '2']);
  assert.equal(first.scanned, 6); assert.equal(first.page.completeness, 'unknown');
  assert.equal(paths[0], '/pesquisa/?q=tofu&srule=price-per-capacity-ascending&prefn1=isOpportunity&prefv1=Com%20Desconto');
  const seen: string[] = first.page.items.map(item => item.productId); let cursor = first.page.nextCursor;
  while (cursor && seen.length < 10) {
    const page = valueOf(await service.searchProducts('tofu', 2, { sort: 'unit_price', promotion: 'discount', cursor }));
    seen.push(...page.page.items.map(item => item.productId)); cursor = page.page.nextCursor;
  }
  assert.deepEqual(seen, ['1', '2', '3', '4', '5', '7']);
  // A cursor only continues the search it came from.
  const sortedCursor = present(first.page.nextCursor);
  for (const options of [{ cursor: sortedCursor }, { sort: 'unit_price' as const, cursor: sortedCursor }, { sort: 'unit_price' as const, promotion: 'below_recommended_price' as const, cursor: sortedCursor }]) {
    const result = await service.searchProducts('tofu', 2, options);
    assert.equal(result.ok, false); assert.match(result.ok ? '' : result.error.message, /different sort or promotion filter/);
  }
  const plain = valueOf(await service.searchProducts('tofu', 2, { promotion: 'below_recommended_price' }));
  assert.equal((await service.searchProducts('tofu', 2, { promotion: 'discount', cursor: present(plain.page.nextCursor) })).ok, false);
  assert.equal((await service.searchProducts('tofu', 2, { promotion: 'below_recommended_price', cursor: present(plain.page.nextCursor) })).ok, true);
  assert.equal(paths.at(-1), '/pesquisa/?q=tofu&prefn1=isOpportunity&prefv1=Menos%20que%20PVPR');
});
