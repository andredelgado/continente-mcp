import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { ProductIdSchema } from '../src/domain/index.js';
import { parseCartResponse, weightedLineQuantity } from '../src/parsers/cart.js';
import { CartService } from '../src/services/cart.js';
import { createShoppingApplication } from '../src/runtime.js';
import { ok, present, valueOf } from '../test-support/helpers.js';
import { injectedServices } from '../test-support/mcp-fixture.js';

const minicart = () => JSON.parse(readFileSync(new URL('../../test/fixtures/minicart.json', import.meta.url), 'utf8')) as Record<string, any>;
const eur = (minorUnits: number) => ({ currency: 'EUR', minorUnits });
const line = (rates: Record<string, unknown> | undefined) => ({ action: 'Cart-MiniCartShow', resources: { customerAuthenticated: true },
  basket: { itemsSortedByBrand: [{ items: [{ id: '00123', productName: 'Milk', secondaryQuantity: 2, price: { sales: { value: 1 } },
    ...(rates ? { measurementInfo: { quantityConversionRates: rates } } : {}) }] }] } });

test('cart lines read their unit from their own sale rules, never from the selected dimension', () => {
  const cart = valueOf(parseCartResponse(minicart()));
  assert.deepEqual(cart.items.map(item => [item.productId, item.kind, item.quantity]), [
    ['8912985', 'product', { status: 'known', quantity: { value: 3, unit: 'un' } }],
    ['7303767', 'product', { status: 'known', quantity: { value: 3, unit: 'un' } }],
    ['9999999', 'bag', { status: 'known', quantity: { value: 2, unit: 'un' } }],
  ]);
  assert.deepEqual(cart.items.map(item => item.storefrontQuantity), [null, { value: 0.6, unit: 'kg' }, null]);
});

test('cart line prices say what they are for, and line totals come from the website', () => {
  const cart = valueOf(parseCartResponse(minicart()));
  assert.deepEqual(cart.items.map(item => [item.productId, item.price, item.lineTotal, item.estimated]), [
    ['8912985', { amount: eur(85), per: 'item' }, eur(255), false],
    ['7303767', { amount: eur(250), per: 'kg' }, eur(150), true],
    ['9999999', { amount: eur(10), per: 'item' }, eur(20), false],
  ]);
  const unreadable = minicart();
  unreadable.basket.itemsSortedByBrand[0].items[0].price.sales.value = 'soon';
  assert.equal(parseCartResponse(unreadable).ok, false);
});

test('a line without usable sale rules keeps its amount with an unknown unit and price', () => {
  assert.equal(present(valueOf(parseCartResponse(line(undefined))).items[0]).price, null);
  assert.equal(present(valueOf(parseCartResponse(line({ primaryunit: 'kg' }))).items[0]).price, null);
  const quantity = (rates?: Record<string, unknown>) => present(valueOf(parseCartResponse(line(rates))).items[0]).quantity;
  assert.deepEqual(quantity(), { status: 'unknown', value: 2, rawText: null, reason: null });
  for (const rates of [{ primaryunit: 'kg' }, { primaryunit: 'kg', secondaryunit: 'lt', hasAlternativeSaleUnit: true }, { primaryunit: 'un', selectedunit: 'primary', hasConversionRate: true }]) {
    assert.deepEqual(quantity(rates), { status: 'unknown', value: 2, rawText: null, reason: 'unsupported_unit' });
  }
});

test('cart totals keep products, bags, deposit, delivery, discounts and the amount to pay apart', () => {
  assert.deepEqual(valueOf(parseCartResponse(minicart())).totals,
    { products: eur(405), bags: eur(20), deposit: eur(10), delivery: eur(0), discounts: eur(50), grandTotal: eur(385), estimated: true });
  const unreadable = minicart();
  delete unreadable.basket.resources;
  unreadable.basket.totals = { productsTotalPriceOnly: 4.05, grandTotalNumber: 'soon', totalShippingCostNumber: -1 };
  const cart = valueOf(parseCartResponse(unreadable));
  assert.ok(cart.items.every(item => item.kind === 'product'));
  assert.deepEqual(cart.totals, { products: eur(405), bags: null, deposit: null, delivery: null, discounts: null, grandTotal: null, estimated: true });
  assert.deepEqual(valueOf(parseCartResponse({ action: 'Cart-MiniCartShow', resources: { customerAuthenticated: true }, basket: {} })).totals,
    { products: eur(0), bags: eur(0), deposit: eur(0), delivery: null, discounts: eur(0), grandTotal: eur(0), estimated: false });
});

test('get_cart text shows units, marks bags and lists each total', async () => {
  const { services } = injectedServices();
  services.cart.getCart = async () => parseCartResponse(minicart());
  services.clock = { now: () => new Date('2026-10-15T12:00:00.000Z') };
  const app = createShoppingApplication({ version: 'test', services });
  const result = await app.dispatchToolCall('get_cart', {}, {});
  assert.equal((result.structuredContent as { result: { data: { observedAt: string } } }).result.data.observedAt, '2026-10-15T12:00:00.000Z');
  const text = (result.content as { text: string }[])[0]?.text ?? '';
  assert.match(text, /Leite Meio Gordo — 3 un × €0\.85, line €2\.55\n/);
  assert.match(text, /Maçã Pink Lady — 3 un \(about 0\.6 kg\) × €2\.50\/kg, line about €1\.50\n/);
  assert.match(text, /Saco \(bag\) — 2 un × €0\.10, line €0\.20\n/);
  assert.match(text, /Products: €4\.05\nBags: €0\.20\nDeposit: €0\.10\nDiscounts: €0\.50\nTotal to pay: about €3\.85\nProducts sold by weight are charged by the weight picked/);
  assert.doesNotMatch(text, /unit unknown|each|Delivery: €/);
  assert.match(text, /\nDelivery fee: set at checkout by day, time slot and area; not included here\.\n/);
  await app.close();
});

test('a cart line in another unit does not confirm a change', async () => {
  const kilos = line({ primaryunit: 'un', secondaryunit: 'kg', unitConversionRate: 1, hasAlternativeSaleUnit: true });
  const service = new CartService({ async fetchCart() { return ok(kilos); } } as never);
  const result = valueOf(await service.confirmCartItemQuantity(ProductIdSchema.parse('00123'), { value: 2, unit: 'un' }, 2));
  assert.equal(result.outcome, 'unknown');
  const pieces = valueOf(await new CartService({ async fetchCart() { return ok(line({ primaryunit: 'un' })); } } as never)
    .confirmCartItemQuantity(ProductIdSchema.parse('00123'), { value: 2, unit: 'un' }, 2));
  assert.equal(pieces.outcome, 'confirmed');
});

const weightedCart = () => JSON.parse(readFileSync(new URL('../../test/fixtures/cart-weighted.json', import.meta.url), 'utf8')) as Record<string, any>;
const weightedPage = () => readFileSync(new URL('../../test/fixtures/cart-page-weighted.html', import.meta.url), 'utf8');
const onion = ProductIdSchema.parse('5063153');

test('a weighted line without its own conversion rate does not trust secondaryQuantity', () => {
  // 4 onions of 0.29 kg are 1.16 kg (1,96 € at 1,69 €/kg), but the JSON says 1.
  const line = present(valueOf(parseCartResponse(weightedCart())).items[0]);
  assert.deepEqual([line.quantity, line.storefrontQuantity], [{ status: 'unknown', value: null, rawText: null, reason: 'missing' }, null]);
  assert.deepEqual([line.price, line.lineTotal, line.estimated], [{ amount: eur(169), per: 'kg' }, eur(196), true]);
});

test('the cart page holds the kilograms of a weighted line, which count whole pieces', () => {
  const four = { pieces: { value: 4, unit: 'un' }, storefront: { value: 1.16, unit: 'kg' } };
  assert.deepEqual(weightedLineQuantity(weightedPage(), onion, 'line-onion'), four);
  assert.deepEqual(weightedLineQuantity(weightedPage(), onion, null), four);
  for (const page of [weightedPage().replace('data-previous-val="1.16"', 'data-previous-val="1.1"'), weightedPage().replace('data-previous-val="1.16"', ''),
    weightedPage().replace('data-previous-val="1.16"', 'data-previous-val="abc"'), weightedPage().replace('"hasConversionRate":true,"hasAlternativeSaleUnit":true', '"hasConversionRate":false,"hasAlternativeSaleUnit":false')]) {
    assert.equal(weightedLineQuantity(page, onion, 'line-onion'), null);
  }
  assert.equal(weightedLineQuantity(weightedPage(), onion, 'another-line'), null);
});

test('get_cart and change confirmation count weighted pieces from the cart page only when needed', async () => {
  let pages = 0; let page = weightedPage();
  const client = { async fetchCart() { return ok(weightedCart()); }, async fetchCartControls() { pages++; return ok(page); } };
  const service = new CartService(client as never);
  const line = present(valueOf(await service.getCart()).items[0]);
  assert.deepEqual([line.quantity, line.storefrontQuantity], [{ status: 'known', quantity: { value: 4, unit: 'un' } }, { value: 1.16, unit: 'kg' }]);
  assert.equal(pages, 1);
  assert.equal(valueOf(await service.confirmCartItemQuantity(onion, { value: 4, unit: 'un' }, 4)).outcome, 'confirmed');
  assert.equal(valueOf(await service.confirmCartItemQuantity(onion, { value: 3, unit: 'un' }, 3)).outcome, 'unknown');
  page = page.replace('data-previous-val="1.16"', 'data-previous-val="1.1"');
  assert.equal(present(valueOf(await service.getCart()).items[0]).quantity.status, 'unknown');
  const failing = new CartService({ async fetchCart() { return ok(weightedCart()); }, async fetchCartControls() { return { ok: false, error: { code: 'upstream_unavailable', message: 'x', retryable: true } }; } } as never);
  assert.equal(present(valueOf(await failing.getCart()).items[0]).quantity.status, 'unknown');
  const counted = new CartService({ async fetchCart() { return ok(minicart()); }, async fetchCartControls() { pages++; return ok(''); } } as never);
  const before = pages; await counted.getCart(); assert.equal(pages, before);
});

test('a weighted line without secondaryQuantity never reads its kilograms as pieces', async () => {
  // The apple line holds 1 kg in `quantity`: that is 5 apples of 0.2 kg, not 1 apple.
  // Its piece count is missing either way: left out, or present as null.
  for (const missing of ['absent', 'null'] as const) {
    const kilograms = () => { const cart = minicart();
      for (const group of cart.basket.itemsSortedByBrand) for (const item of group.items) if (item.id === '7303767') {
        if (missing === 'absent') delete item.secondaryQuantity; else item.secondaryQuantity = null;
        item.quantity = 1;
      }
      return cart; };
    const apple = ProductIdSchema.parse('7303767');
    const parsed = present(valueOf(parseCartResponse(kilograms())).items.find(item => item.productId === apple));
    assert.deepEqual([parsed.quantity, parsed.storefrontQuantity], [{ status: 'unknown', value: null, rawText: null, reason: 'missing' }, null]);
    // With no cart page to say otherwise, one apple is not confirmed.
    const blind = new CartService({ async fetchCart() { return ok(kilograms()); }, async fetchCartControls() { return ok(''); } } as never);
    assert.equal(valueOf(await blind.confirmCartItemQuantity(apple, { value: 1, unit: 'un' }, 1)).outcome, 'unknown');
    assert.equal(valueOf(await blind.confirmCartItemQuantity(apple, { value: 5, unit: 'un' }, 5)).outcome, 'unknown');
    // The cart page's kilograms count the pieces: 1 kg is 5 apples.
    const rules = JSON.stringify({ primaryunit: 'kg', secondaryunit: 'un', unitConversionRate: 0.2, hasAlternativeSaleUnit: true, hasConversionRate: true });
    const page = `<div data-pid="7303767" data-product-name="Maçã" data-uuid="line-apple"><span class="ct-tile-quantity-update" data-uuid="line-apple" data-previous-val="1" data-measure-options='${rules}'></span></div>`;
    const read = new CartService({ async fetchCart() { return ok(kilograms()); }, async fetchCartControls() { return ok(page); } } as never);
    assert.equal(valueOf(await read.confirmCartItemQuantity(apple, { value: 1, unit: 'un' }, 1)).outcome, 'unknown');
    const five = valueOf(await read.confirmCartItemQuantity(apple, { value: 5, unit: 'un' }, 5));
    assert.equal(five.outcome, 'confirmed', missing);
  }
});
