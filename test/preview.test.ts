import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProductDetails } from '../src/domain/index.js';
import { ProductIdSchema } from '../src/domain/index.js';
import { parseCartResponse } from '../src/parsers/cart.js';
import { PreviewData } from '../src/mcp/contracts.js';
import { connect, injectedServices } from '../test-support/mcp-fixture.js';
import { dataOf, textOf } from '../test-support/assertions.js';
import { ok, fail, valueOf } from '../test-support/helpers.js';

const minicart = () => JSON.parse(readFileSync(new URL('../../test/fixtures/minicart.json', import.meta.url), 'utf8')) as unknown;
const eur = (minorUnits: number) => ({ currency: 'EUR' as const, minorUnits });
const un = (value: number) => ({ value, unit: 'un' as const });
function product(id: string, name: string, options: { price: number; per: 'item' | 'kg'; kgPerPiece?: number; minimum?: number; availability?: ProductDetails['availability']; packageText?: string }): ProductDetails {
  const weighted = options.kgPerPiece !== undefined;
  return { productId: ProductIdSchema.parse(id), productSlug: null, name, url: `https://www.continente.pt/produto/p-${id}.html`,
    price: { amount: eur(options.price), per: options.per }, secondaryPrice: null, recommendedPrice: null, promotions: [],
    packageText: options.packageText ?? null, package: null, minimumText: null, drainedPrice: null, unitPrice: null, imageUrl: null, availability: options.availability ?? 'available',
    saleRules: { status: 'available', rules: { saleUnit: 'un', storefrontUnit: weighted ? 'kg' : 'un', storefrontUnitsPerSaleUnit: options.kgPerPiece ?? 1,
      minimum: un(options.minimum ?? 1), maximum: un(99), step: un(1) } } };
}
const catalogue: Record<string, ProductDetails> = {
  '8912985': product('8912985', 'Leite Meio Gordo', { price: 85, per: 'item', packageText: '1 lt' }),
  '7303767': product('7303767', 'Maçã Pink Lady', { price: 250, per: 'kg', kgPerPiece: 0.2, minimum: 2 }),
  '2597619': product('2597619', 'Banana', { price: 119, per: 'kg', kgPerPiece: 0.2, minimum: 3 }),
  '3697794': product('3697794', 'Atum', { price: 115, per: 'item' }),
  '6119649': product('6119649', 'Iogurte Grego', { price: 159, per: 'item', availability: 'unavailable' }),
};

async function preview(t: test.TestContext, items: { productId: string; quantity: number; cartItemId?: string }[]) {
  const { services, state } = injectedServices(); let cartReads = 0; let productReads = 0;
  services.cart.getCart = async () => { cartReads++; return parseCartResponse(minicart()); };
  services.catalog.getProduct = async reference => { productReads++; const found = catalogue[reference]; return found ? ok(found) : fail('not_found'); };
  const { client } = await connect(t, services);
  const result = await client.callTool({ name: 'preview_cart_changes', arguments: { items } });
  return { result, data: dataOf(result, PreviewData), state, cartReads, productReads };
}

test('a preview says what each line would do and cost, reading the cart once and writing nothing', async t => {
  const { result, data, state, cartReads, productReads } = await preview(t, [
    { productId: '8912985', quantity: 2 }, { productId: '7303767', quantity: 5 }, { productId: '3697794', quantity: 4 },
    { productId: '6119649', quantity: 1 }]);
  assert.equal(cartReads, 1); assert.equal(productReads, 4); assert.equal(state.writes, 0);
  assert.deepEqual(data.lines.map(line => [line.productId, line.current, line.requested, line.change, line.estimatedCost, line.estimated, line.error]), [
    ['8912985', { status: 'known', quantity: un(3) }, un(2), 'decrease', eur(170), false, null],
    ['7303767', { status: 'known', quantity: un(3) }, un(5), 'increase', eur(250), true, null],
    ['3697794', { status: 'known', quantity: un(0) }, un(4), 'add', eur(460), false, null],
    ['6119649', { status: 'known', quantity: un(0) }, un(1), 'add', eur(159), false, null],
  ]);
  assert.equal(present(data.lines[0]).cartItemId, 'line-milk');
  assert.deepEqual([data.estimatedCost, data.estimated, data.problems], [eur(1039), true, 1]);
  assert.equal(data.observedAt, '2026-10-14T12:00:00.000Z'); assert.equal(data.catalogView, 'unknown');
  assert.deepEqual(data.lines.map(line => line.storefrontQuantity), [null, { value: 1, unit: 'kg' }, null, null]);
  const text = textOf(result);
  assert.match(text, /^Cart changes preview, nothing was changed:/);
  assert.match(text, /Leite Meio Gordo \[8912985\] — decrease to 2 un \(cart has 3 un\), €1\.70\n   pack 1 lt, available/);
  assert.match(text, /Maçã Pink Lady \[7303767\] — increase to 5 un, about 1 kg \(cart has 3 un\), about €2\.50/);
  assert.match(text, /Estimated cost of these lines: about €10\.39\nProducts in the cart after these changes: about €10\.39\nDelivery fee: set at checkout by day, time slot and area; not included here\.\n1 line\(s\) need attention/);
});

test('lines that would be refused say why and leave the estimate to the others', async t => {
  const { data, state } = await preview(t, [
    { productId: '2597619', quantity: 2 }, { productId: '7303767', quantity: 2.5 }, { productId: '1234567', quantity: 1 },
    { productId: '3697794', quantity: 1 }, { productId: '3697794', quantity: 2 }, { productId: '8912985', quantity: 0 }, { productId: '7303767', quantity: 0, cartItemId: 'missing-line' }]);
  assert.equal(state.writes, 0);
  assert.deepEqual(data.lines.map(line => [line.productId, line.change, line.error?.code ?? null]), [
    ['2597619', null, 'quantity_below_minimum'], ['7303767', null, 'invalid_input'], ['1234567', null, 'not_found'],
    ['3697794', 'add', null], ['3697794', null, 'invalid_input'], ['8912985', 'remove', null], ['7303767', null, 'not_found']]);
  assert.equal(present(data.lines[4]).error?.message, 'This product is listed more than once');
  assert.equal(present(data.lines[2]).name, null);
  assert.deepEqual([data.estimatedCost, data.estimated, data.problems], [eur(115), false, 5]);
  const absent = await preview(t, [{ productId: '3697794', quantity: 0 }]);
  assert.equal(present(absent.data.lines[0]).change, 'none');
});

test('a product ID and its own cartItemId are the same line and are counted once', async t => {
  const alone = await preview(t, [{ productId: '8912985', quantity: 0 }]);
  assert.deepEqual(alone.data.productsAfter, eur(150));
  for (const items of [
    [{ productId: '8912985', quantity: 0 }, { productId: '8912985', quantity: 0, cartItemId: 'line-milk' }],
    [{ productId: '8912985', quantity: 0, cartItemId: 'line-milk' }, { productId: '8912985', quantity: 2 }],
  ]) {
    const { data, state } = await preview(t, items);
    assert.equal(state.writes, 0);
    assert.deepEqual(data.lines.map(line => line.error?.code ?? null), [null, 'invalid_input']);
    assert.equal(present(data.lines[1]).error?.message, 'This product is listed more than once');
    assert.deepEqual(data.productsAfter, eur(150));
  }
});

test('a preview needs the cart and checks references before any read', async t => {
  const { services, state } = injectedServices(); let reads = 0;
  services.catalog.getProduct = async () => { reads++; return fail(); };
  services.cart.getCart = async () => fail('not_authenticated');
  const { client } = await connect(t, services);
  const signedOut = await client.callTool({ name: 'preview_cart_changes', arguments: { items: [{ productId: '3697794', quantity: 1 }] } });
  assert.equal(signedOut.isError, true); assert.equal(reads, 0); assert.equal(state.writes, 0);
  await assert.rejects(client.callTool({ name: 'preview_cart_changes', arguments: { items: [] } }), { code: -32602 });
});

function present<T>(value: T | undefined): T { assert.ok(value !== undefined); return value; }

test('results say whose view of the catalogue they come from', async t => {
  const { services } = injectedServices();
  const status = (state: 'authenticated' | 'unauthenticated' | 'unknown', savedCookies: 'available' | 'missing') =>
    async () => ({ browser: 'closed' as const, credentials: { hasEmail: true, hasPassword: true }, savedCookies, authentication: { state, checkedAt: null } });
  const { client } = await connect(t, services);
  for (const [state, cookies, expected] of [['authenticated', 'available', 'signed_in'], ['unauthenticated', 'available', 'signed_out'],
    ['unknown', 'missing', 'signed_out'], ['unknown', 'available', 'unknown']] as const) {
    services.session.getStatus = status(state, cookies);
    const search = await client.callTool({ name: 'search_products', arguments: { query: 'milk' } });
    assert.equal((search.structuredContent as { result: { data: { catalogView: string } } }).result.data.catalogView, expected, `${state}/${cookies}`);
  }
});

test('a line kept at its quantity keeps what the cart charges for it, multi-buy discounts included', async t => {
  // 3 units at €0.39 are charged €1.00 together; keeping all three must not reprice them at €1.17.
  const promotions = () => JSON.parse(readFileSync(new URL('../../test/fixtures/promotions-minicart.json', import.meta.url), 'utf8')) as unknown;
  const before = present(valueOf(parseCartResponse(promotions())).totals.products);
  const { services } = injectedServices();
  services.cart.getCart = async () => parseCartResponse(promotions());
  services.catalog.getProduct = async () => ok(product('8607640', 'Iogurte', { price: 39, per: 'item' }));
  const { client } = await connect(t, services);
  const kept = dataOf(await client.callTool({ name: 'preview_cart_changes', arguments: { items: [{ productId: '8607640', quantity: 3 }] } }), PreviewData);
  assert.deepEqual([present(kept.lines[0]).change, present(kept.lines[0]).estimatedCost, kept.productsAfter], ['none', eur(100), before]);
  // A changed quantity is still estimated at the current price.
  const changed = dataOf(await client.callTool({ name: 'preview_cart_changes', arguments: { items: [{ productId: '8607640', quantity: 4 }] } }), PreviewData);
  assert.deepEqual([present(changed.lines[0]).change, present(changed.lines[0]).estimatedCost], ['increase', eur(156)]);
});
