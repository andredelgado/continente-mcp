import { ProductIdSchema, parsePriceTag } from '../src/domain/index.js';
import { present, valueOf, errorOf, fixture, rawCart, unitRules, weightedRules, productForm, cartControls, ordersPage } from '../test-support/helpers.js';
import { parseProductSearchPage, parseFavoritesPages, parseSearchPagination, rankProductsByFavorites } from '../src/parsers/catalog.js';
import { parseCartResponse, parseSaleRules, validateSaleQuantity, toStorefrontQuantity, parseProductForm, parseCartControls } from '../src/parsers/cart.js';
import { normalizedDate, parseOrderHistory, parseOrderLines, parseOrderQuantity, aggregatePurchaseFrequency } from '../src/parsers/orders.js';

import assert from 'node:assert/strict';
import test from 'node:test';

const eur = (minorUnits: number) => ({ currency: 'EUR' as const, minorUnits });
test('catalogue tiles keep each price with what it is for, the pack size and the minimum', () => {
  const page = valueOf(parseProductSearchPage(fixture('catalog')));
  assert.equal(page.products.length, 3); assert.deepEqual(page.problems, []);
  assert.deepEqual(page.products[0], { productId: '00123', productSlug: 'leite-00123', name: 'Leite Meio Gordo',
    price: { amount: eur(129), per: 'item' }, url: 'https://www.continente.pt/produto/leite-00123.html',
    secondaryPrice: { amount: eur(129), per: 'l' }, packageText: '1 lt', minimumText: null, recommendedPrice: { amount: eur(149), per: 'item' },
    package: { count: 1, each: { value: 1, unit: 'l' }, net: { value: 1, unit: 'l' }, drained: null, approximate: false }, availability: 'available',
    brand: 'Mimosa', category: 'Supermercado/Laticínios e Ovos/Leite/Leite Meio Gordo', drainedPrice: null,
    unitPrice: { amount: eur(129), per: 'l', basis: 'website' }, imageUrl: null, promotions: [] });
  const banana = present(page.products[1]);
  assert.deepEqual([banana.price, banana.secondaryPrice], [{ amount: eur(119), per: 'kg' }, { amount: eur(24), per: 'piece' }]);
  assert.equal(banana.minimumText, '600 gr (3 un)'); assert.equal(banana.packageText, null); assert.equal(banana.package, null);
  assert.equal(banana.availability, 'unavailable'); assert.equal(present(page.products[2]).availability, 'unknown');
  assert.deepEqual([banana.brand, banana.category], [null, null]); assert.equal(banana.recommendedPrice, null);
  assert.equal(present(page.products[2]).price, null);
  assert.equal(valueOf(parseProductSearchPage(fixture('catalog') + fixture('catalog'))).products.length, 3);
});
test('one unreadable result is reported without failing the rest of the page', () => {
  const page = valueOf(parseProductSearchPage(fixture('catalog-mixed')));
  assert.deepEqual(page.products.map(product => [product.productId, product.price?.per ?? null]), [['7001', 'kg'], ['7002', null], ['7003', 'item']]);
  assert.equal(present(page.products[2]).packageText, '12 un');
  assert.deepEqual(page.problems.map(problem => problem.message), [
    'Search result 2 (product 7002) has a price in an unrecognised format; its price is unknown.',
    'Search result 3 was not recognised and was skipped.',
  ]);
  const broken = parseProductSearchPage('<main><div class="ct-inner-tile-wrap"><span>no product</span></div></main>');
  assert.equal(broken.ok, false);
});
test('tile brand and category come only from data naming the same product', () => {
  const tile = (impression: string) => `<main><div class="product-tile" data-product-tile-impression='${impression}'><div class="ct-inner-tile-wrap">` +
    `<a href="/produto/leite-00123.html">Leite</a></div></div></main>`;
  const facts = (impression: string) => { const product = present(valueOf(parseProductSearchPage(tile(impression))).products[0]); return [product.brand, product.category]; };
  assert.deepEqual(facts('{"id":"00123","brand":"Catfield","category":"Animais/Gato/Areias e Absorventes"}'), ['Catfield', 'Animais/Gato/Areias e Absorventes']);
  assert.deepEqual(facts('{"id":"999","brand":"Other","category":"Other"}'), [null, null]);
  assert.deepEqual(facts('{"id":"00123","brand":"","category":"undefined"}'), [null, null]);
  assert.deepEqual(facts('not json'), [null, null]);
});
test('the price per drained kg is worked out only for a single pack with a drained weight', () => {
  const tuna = (label: string, price = '1,15€') => present(valueOf(parseProductSearchPage(`<main><div class="ct-inner-tile-wrap"><a href="/produto/atum-00123.html">Atum</a>` +
    `<span class="pwc-tile--price-primary">${price}</span><span class="pwc-tile--quantity">emb. ${label}</span></div></main>`)).products[0]).drainedPrice;
  assert.deepEqual(tuna('120 gr (peso escorrido 78 gr)'), { amount: { currency: 'EUR', minorUnits: 1474 }, per: 'kg' });
  assert.equal(tuna('120 gr'), null); assert.equal(tuna('3 x 80 gr'), null); assert.equal(tuna('120 gr (peso escorrido 78 gr)', '1,15€/kg'), null);
});
test('the unit price is per drained kg, else the website\'s per kg or litre, else the pack price over its net quantity', () => {
  const tile = (price: string, secondary: string, label: string) => present(valueOf(parseProductSearchPage(`<main><div class="ct-inner-tile-wrap">` +
    `<a href="/produto/p-00123.html">P</a><span class="pwc-tile--price-primary">${price}</span>` +
    `${secondary ? `<span class="pwc-tile--price-secondary">${secondary}</span>` : ''}<span class="pwc-tile--quantity">emb. ${label}</span></div></main>`)).products[0]).unitPrice;
  assert.deepEqual(tile('0,79€', '', '1 lt'), { amount: eur(79), per: 'l', basis: 'pack' });
  assert.deepEqual(tile('7,99€', '', '1 kg'), { amount: eur(799), per: 'kg', basis: 'pack' });
  assert.deepEqual(tile('1,09€', '', '3 x 200 ml'), { amount: eur(182), per: 'l', basis: 'pack' });
  // A per-piece "secondary" price on a 500 g jar (seen on the site) is not a per-kg price; the pack decides.
  assert.deepEqual(tile('4,79€', '9,58€/un', '500 gr'), { amount: eur(958), per: 'kg', basis: 'pack' });
  assert.deepEqual(tile('2,49€', '4,98€/kg', '500 gr'), { amount: eur(498), per: 'kg', basis: 'website' });
  assert.deepEqual(tile('1,15€', '13,53€/kg', '120 gr (peso escorrido 78 gr)'), { amount: eur(1474), per: 'kg', basis: 'drained' });
  assert.equal(tile('3,00€', '', '12 un'), null);
});
test('search availability needs the badge and the add button to agree', () => {
  const tile = (badge: string, button: boolean) => `<main><div class="ct-inner-tile-wrap"><a href="/produto/leite-00123.html">Leite</a>` +
    `${badge ? `<div class="dual-badge-message dual-badge-unavailable-00123 ${badge}">Indisponível</div>` : ''}` +
    `${button ? '<button class="add-to-cart js-add-to-cart">Adicionar</button>' : ''}</div></main>`;
  const availability = (badge: string, button: boolean) => present(valueOf(parseProductSearchPage(tile(badge, button))).products[0]).availability;
  assert.equal(availability('d-none', true), 'available'); assert.equal(availability('null', false), 'unavailable');
  for (const [badge, button] of [['d-none', false], ['null', true], ['', true], ['', false]] as const) assert.equal(availability(badge, button), 'unknown');
});
test('an unreadable recommended price is reported and leaves the product usable', () => {
  const page = valueOf(parseProductSearchPage('<main><div class="ct-inner-tile-wrap"><a href="/produto/leite-00123.html">Leite</a>' +
    '<span class="pwc-tile--price-primary">1,29€</span><div class="list"><span class="pvpr-info">PVPR</span> sob consulta</div></div></main>'));
  assert.deepEqual(present(page.products[0]).price, { amount: eur(129), per: 'item' }); assert.equal(present(page.products[0]).recommendedPrice, null);
  assert.deepEqual(page.problems.map(problem => problem.message),
    ['Search result 1 (product 00123) has a recommended price (PVPR) in an unrecognised format; it is unknown.']);
});
test('price labels parse strictly and say what they are for', () => {
  const cases: [string, unknown][] = [['1,29€', { amount: eur(129), per: 'item' }], [' 1,19€/kg ', { amount: eur(119), per: 'kg' }],
    ['0,24€/un', { amount: eur(24), per: 'piece' }], ['1,29€/lt', { amount: eur(129), per: 'l' }], ['2,5 € / L', { amount: eur(250), per: 'l' }],
    ['12€', { amount: eur(1200), per: 'item' }], ['0,16€/dos', { amount: eur(16), per: 'dose' }], ['', null]];
  for (const [label, expected] of cases) assert.deepEqual(valueOf(parsePriceTag(label)), expected, label);
  for (const label of ['1,199€', '€1,29', '1,29€/dz', 'Preço sob consulta', '1,29']) assert.equal(parsePriceTag(label).ok, false, label);
});
test('favorites parsing deduplicates identities and retains absent price', () => {
  const favorites = valueOf(parseFavoritesPages([fixture('favorites')]));
  assert.equal(favorites.length, 2);
  assert.equal(present(favorites[1]).price, null);
  const { products } = valueOf(parseProductSearchPage(fixture('catalog')));
  assert.equal(present(rankProductsByFavorites(products, [present(favorites[1])])[0]).productId, '456');
  const renamed = present(rankProductsByFavorites(products, [{ ...present(favorites[0]), name: 'Old name' }])[0]);
  assert.equal(renamed.productId, '00123'); assert.equal(renamed.favorite, true);
  // A favorite with a similar name but a different product does not reorder the website's results.
  const similar = rankProductsByFavorites(products, [{ ...present(favorites[1]), productId: ProductIdSchema.parse('1'), name: 'Sold out product' }]);
  assert.deepEqual(similar.map(product => [product.productId, product.favorite]), [['00123', false], ['456', false], ['789', false]]);
});
test('pagination accepts only same-origin URLs and finite positive page sizes', () => {
  assert.deepEqual(valueOf(parseSearchPagination(fixture('catalog'))), { url: 'https://www.continente.pt/on/demandware.store/Sites-continente-Site/default/Search-UpdateGrid?start=35&sz=35', start: 35, size: 35 });
  assert.equal(parseSearchPagination('<a data-url="https://other.invalid/Search-UpdateGrid?sz=5">').ok, false);
  assert.equal(parseSearchPagination('<a data-url="/Search-UpdateGrid?sz=-5">').ok, false);
});
test('cart JSON supports add and minicart envelopes without invented units or prices', () => {
  // A line without its sale rules: the amount is kept, its unit is not guessed.
  const unitless = rawCart(2); delete (unitless.cart.items[0] as { measurementInfo?: unknown }).measurementInfo;
  const cart = valueOf(parseCartResponse(unitless));
  assert.equal(present(cart.items[0]).productId, '00123');
  assert.deepEqual(present(cart.items[0]).quantity, { status: 'unknown', value: 2, rawText: null, reason: null });
  // Without the line's sale rules, a unit price would not say what it is for, so it stays unknown.
  assert.equal(present(cart.items[0]).price, null);
  const mini = parseCartResponse({ resources: { customerAuthenticated: true }, basket: { itemsSortedByBrand: [{ items: [{ id: '00123-master', productName: 'Milk', secondaryQuantity: 3, priceTotal: { value: 4.25, basePriceValue: 5 } }] }] } });
  assert.deepEqual(present(valueOf(mini).items[0]).lineTotal, { currency: 'EUR', minorUnits: 425 });
  assert.equal(valueOf(mini).totals.products, null);
  assert.equal(present(valueOf(parseCartResponse({ cart: { items: [{ id: '123', productName: 'Milk', quantity: 2 }] } })).items[0]).price, null);
});
test('only recognized empty carts succeed; malformed groups and lines fail the entire parse', () => {
  assert.deepEqual(valueOf(parseCartResponse({ action: 'Cart-MiniCartShow', basket: {}, resources: { customerAuthenticated: true } })),
    { customerAuthenticated: true, items: [], totals: { products: { currency: 'EUR', minorUnits: 0 }, bags: { currency: 'EUR', minorUnits: 0 }, deposit: { currency: 'EUR', minorUnits: 0 }, delivery: null, discounts: { currency: 'EUR', minorUnits: 0 }, grandTotal: { currency: 'EUR', minorUnits: 0 }, estimated: false },
      checkout: { minimumOrder: null, meetsMinimum: null, entregaZero: null, freeDeliveryFrom: null, deliveryFee: 'set_at_checkout' } });
  assert.equal(parseCartResponse({ basket: { itemsSortedByBrand: [] } }).ok, true);
  for (const input of [null, {}, { basket: {} }, { basket: { itemsSortedByBrand: [{}] } },
    { cart: { items: [{}] } }, rawCart(-1), { cart: { items: [{ id: '123', productName: 'Milk', quantity: null }] } }] as const) assert.equal(parseCartResponse(input).ok, false);
});
test('sale conversion retains weighted minimum, explicit zero removal and three decimal formatting', () => {
  const sale = valueOf(parseSaleRules(weightedRules));
  assert.equal(errorOf(validateSaleQuantity(2, sale)).code, 'quantity_below_minimum');
  assert.equal(validateSaleQuantity(0, sale).ok, true);
  assert.equal(toStorefrontQuantity(valueOf(validateSaleQuantity(12, sale)), sale), '2.4');
  assert.equal(toStorefrontQuantity(valueOf(validateSaleQuantity(3, valueOf(parseSaleRules(unitRules)))), valueOf(parseSaleRules(unitRules))), '3');
  for (const invalid of [{ hasAlternativeSaleUnit: true }, { primaryunit: 'kg' }, { primaryunit: 'un', selectedunit: 'secondary' },
    { minOrderQuantity: 'bad' }, { hasConversionRate: 'false' }, { stepQuantity: -1 }, '{bad}'] as const) assert.equal(parseSaleRules(invalid).ok, false);
  assert.equal(parseSaleRules({ ...weightedRules, secondaryunit: undefined }).ok, false);
  assert.equal(valueOf(parseSaleRules({ ...weightedRules, secondaryunit: 'g', primaryToSecondary: 0.001, stepQuantity: 0.001 })).rules.saleUnit, 'g');
});
test('sale quantities enforce authoritative maxima, steps and precision without guessing', () => {
  const sale = valueOf(parseSaleRules({ primaryunit: 'un', stepQuantity: 1, minOrderQuantity: 1, maxNumberOfUnitsPerSale: 5 }));
  for (const value of [1.5, 6, Infinity, NaN, -1] as const) {
    const result = validateSaleQuantity(value, sale);
    assert.equal(result.ok, false); assert.match(result.error.message, /un.*maximum 5 un.*step 1 un/);
  }
  for (const value of [0, 1, 5] as const) assert.equal(validateSaleQuantity(value, sale).ok, true);
  const decimal = valueOf(parseSaleRules({ primaryunit: 'un', stepQuantity: 0.1 }));
  assert.equal(toStorefrontQuantity(valueOf(validateSaleQuantity(0.1 + 0.2, decimal)), decimal), '0.3');
  for (const value of [0.3001, 0.35, Number.MAX_SAFE_INTEGER] as const) assert.equal(validateSaleQuantity(value, decimal).ok, false);
  assert.throws(() => toStorefrontQuantity({ value: 1.5, unit: 'un' }, sale), /step/);
  assert.throws(() => toStorefrontQuantity({ value: 1, unit: 'kg' }, sale), /unit/);
});
test('unestablished bounds and contradictory conversions fail before producing sale rules', () => {
  for (const input of [{}, { ...unitRules, stepQuantity: 0 }, { ...unitRules, stepQuantity: 0.0001 },
    { ...unitRules, minOrderQuantity: 6, maxNumberOfUnitsPerSale: 5 }, { ...unitRules, maxNumberOfUnitsPerSale: 'invalid' },
    { ...weightedRules, unitConversionRate: 0.3 }, { ...weightedRules, secondaryunit: 'g' },
    { ...weightedRules, secondaryunit: 'l', stepQuantity: 0.2 }, { ...weightedRules, maxNumberOfUnitsPerSale: 5.1 }] as const) {
    assert.equal(errorOf(parseSaleRules(input)).code, 'sale_rules_unknown');
  }
  const weighted = valueOf(parseSaleRules({ ...weightedRules, stepQuantity: 0.2 }));
  assert.equal(validateSaleQuantity(3, weighted).ok, true);
  assert.equal(validateSaleQuantity(3.5, weighted).ok, false);
  assert.equal(toStorefrontQuantity({ value: 12, unit: 'un' }, weighted), '2.4');
});
test('product forms and cart controls are parsed locally and reject wrong product/action', () => {
  assert.equal(valueOf(parseProductForm(productForm(), ProductIdSchema.parse('00123'))).pid, '00123-master');
  assert.equal(parseProductForm(productForm(), ProductIdSchema.parse('999')).ok, false);
  assert.equal(parseProductForm(productForm(unitRules, 'https://other.invalid/add'), ProductIdSchema.parse('00123')).ok, false);
  const controls = valueOf(parseCartControls(cartControls(), ProductIdSchema.parse('00123')));
  assert.equal(controls.uuid, 'line-abc');
  assert.equal(controls.removeUuid, 'line-abc');
  assert.equal(controls.gtmIndex, '2');
  assert.equal(errorOf(parseCartControls(cartControls(), ProductIdSchema.parse('999'))).code, 'not_found');
});
test('order parser preserves units and unknown quantities instead of inventing purchases', () => {
  const parsed = valueOf(parseOrderLines(fixture('order')));
  assert.equal(parsed.length, 2);
  assert.equal(present(parsed[0]).name, 'Leite Meio Gordo');
  assert.deepEqual(present(parsed[1]).quantity, { status: 'known', quantity: { value: 1.2, unit: 'kg' } });
  for (const text of ['?', '2', '1 box', '-2 un', '2 un trailing'] as const) assert.equal(parseOrderQuantity(text).status, 'unknown');
  const history = parseOrderHistory(ordersPage + '<a href="https://other.invalid/detalhe-encomenda">bad</a>');
  assert.equal(present(valueOf(history).entries[0]).order.orderNumber, '123456789_001');
  assert.equal(present(valueOf(history).entries[0]).order.date, '2026-10-02');
  assert.equal(present(valueOf(history).entries[0]).order.rawDate, '2 outubro 2026');
  assert.equal(valueOf(history).entries.length, 2);
});
test('order dates parse full and abbreviated Portuguese months, and nothing else', () => {
  const cases: [string, string | null][] = [['2 outubro 2026', '2026-10-02'], ['2 de outubro de 2026', '2026-10-02'], ['01 Set 26', '2026-09-01'],
    ['07 Mai 26', '2026-05-07'], ['15 Mar. 26', '2026-03-15'], ['31 Dez 25', '2025-12-31'], ['31 Fev 26', null], ['01 Sep 26', null],
    ['01 Se 26', null], ['01 Set 2026x', null], ['Tomorrow?', null]];
  for (const [raw, expected] of cases) assert.equal(normalizedDate(raw), expected, raw);
});
test('purchase frequency counts distinct orders and keeps units separate', () => {
  const lines = valueOf(parseOrderLines(fixture('order')));
  const result = aggregatePurchaseFrequency([[present(lines[0]), present(lines[0]), { ...present(lines[0]), quantity: present(lines[1]).quantity }], [present(lines[0])]]);
  assert.equal(present(valueOf(result)[0]).orders, 2);
  assert.deepEqual(present(valueOf(result)[0]).quantities, [{ value: 6, unit: 'un' }, { value: 1.2, unit: 'kg' }]);
  const unknown = valueOf(aggregatePurchaseFrequency([[{ ...present(lines[0]), quantity: parseOrderQuantity('?') }]]))[0];
  assert.deepEqual(present(unknown).quantities, []); assert.equal(present(unknown).unknownQuantityLines, 1);
});
