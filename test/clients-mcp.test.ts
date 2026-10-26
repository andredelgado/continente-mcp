import { validatorSchema, having, double, dataOf, textOf, statusOf, mutationOf, recoveryOf, toolError } from '../test-support/assertions.js';
import { present, valueOf, errorOf, fixture, rawCart, ordersPage, ok, fail, unitRules } from '../test-support/helpers.js';
import { CartData, FrequencyData, SearchData, CartOutput, CheckoutSummaryData } from '../src/mcp/contracts.js';
import { ProductIdSchema } from '../src/domain/index.js';
import { MutationData } from '../src/mcp/contracts.js';
import type { StorefrontSession } from '../src/session/browser.js';
import { injectedServices, connect } from '../test-support/mcp-fixture.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { createApplication } from '../src/application.js';
import { responseStatus } from '../src/clients/policy.js';
import { createShoppingApplication } from '../src/runtime.js';
import { StorefrontClient, CartClient, CatalogClient, OrdersClient, FavoritesClient } from '../src/clients/storefront.js';
import { parseProductForm } from '../src/parsers/cart.js';

import assert from 'node:assert/strict';
import test from 'node:test';

test('shopping tools work through real MCP transport using injected clients', async t => {
  const { state, services } = injectedServices(); const { client } = await connect(t, services);
  assert.equal((await client.listTools()).tools.length, 21); assert.equal(state.reads, 0);
  const search = await client.callTool({ name: 'search_products', arguments: { query: 'milk', limit: 1 } });
  assert.equal(present(dataOf(search, SearchData).products[0]).productId, '00123');
  assert.equal(present(present(dataOf(search, SearchData).products[0]).price).amount.minorUnits, 129);
  assert.equal(present(present(dataOf(search, SearchData).products[0]).price).amount.currency, 'EUR');
  assert.match(textOf((await client.callTool({ name: 'list_favorites' }))), /2 favorites/);
  assert.match(textOf((await client.callTool({ name: 'list_favorites', arguments: { refresh: true } }))), /2 favorites \(fetched from the website\)/);
  const cart = await client.callTool({ name: 'get_cart' });
  assert.equal(present(dataOf(cart, CartData).items[0]).productId, '00123');
  assert.equal(having(present(dataOf(cart, CartData).items[0]).quantity, 'value').value, 2);
  assert.deepEqual(Object.keys(present(cart.structuredContent)), ['result']);
  const summary = await client.callTool({ name: 'get_checkout_summary', arguments: {} });
  const summaryData = dataOf(summary, CheckoutSummaryData);
  assert.equal(summaryData.stage, 'basket');
  assert.equal(summaryData.provisional, true);
  assert.deepEqual(summaryData.loyaltyCredit, { currency: 'EUR', minorUnits: 40 });
  assert.deepEqual(summaryData.selectedCouponIds, ['synthetic-coupon-001']);
  assert.equal(summaryData.immediateDiscounts, null);
  const add = await client.callTool({ name: 'add_cart_item', arguments: { productId: ProductIdSchema.parse('00123') } });
  assert.equal(statusOf(add), 'success');
  assert.equal(dataOf(add, MutationData).productId, '00123');
  assert.deepEqual(Object.keys(present(add.structuredContent)), ['result']);
  assert.equal(dataOf(add, MutationData).confirmedQuantity.value, 3);
  assert.equal(dataOf((await client.callTool({ name: 'set_cart_item_quantity', arguments: { productId: ProductIdSchema.parse('00123'), quantity: 0 } })), MutationData).confirmedQuantity.value, 0);
  assert.match(textOf((await client.callTool({ name: 'list_orders' }))), /2 un × Leite Meio Gordo/);
  assert.match(textOf((await client.callTool({ name: 'list_frequently_bought_products' }))), /across 2 orders/);
  assert.equal(state.writes, 2);
});
test('invalid tool inputs fail before shopping I/O and preserve the queue', async t => {
  const { state, services } = injectedServices(); const { client } = await connect(t, services);
  for (const [name, args] of [['search_products', { query: '   ' }], ['search_products', { query: 'milk', limit: 51 }],
    ['list_orders', { limit: 0 }], ['list_frequently_bought_products', { limit: 1.5 }], ['add_cart_item', { productId: ProductIdSchema.parse('123'), quantity: 0 }],
    ['set_cart_item_quantity', { productId: ProductIdSchema.parse('123'), quantity: -1 }], ['set_cart_item_quantity', { productId: ProductIdSchema.parse('123') }],
    ['add_cart_item', { productId: 'https://invalid/123' }]] as const) {
    await assert.rejects(client.callTool({ name, arguments: args }), { code: -32602 });
  }
  assert.equal(state.reads, 0); assert.equal(state.writes, 0);
  assert.equal((await client.callTool({ name: 'get_cart' })).isError, undefined);
});
test('MCP uncertain mutation retains recovery and never retries authentication', async t => {
  const { state, services } = injectedServices();
  services.cart.addCartItem = async () => ok({ productId: ProductIdSchema.parse('00123'), requested: { value: 1, unit: 'un' }, outcome: 'unknown',
    error: fail('not_authenticated').error, recovery: { action: 'get_cart', automaticReplay: false } });
  const { client } = await connect(t, services);
  const result = await client.callTool({ name: 'add_cart_item', arguments: { productId: ProductIdSchema.parse('00123') } });
  assert.equal(result.isError, true); assert.equal(mutationOf(result).outcome, 'unknown');
  assert.equal(recoveryOf(result).automaticReplay, false);
  assert.match(textOf(result), /Call get_cart/); assert.equal(state.refreshes, 0);
});
test('transport cleanup waits behind active shopping work', async () => {
  const { state, services } = injectedServices(); let release: () => void = () => { throw new Error("Gate has not been initialized"); }; const events: string[] = [];
  const gate = new Promise<void>(resolve => { release = resolve; });
  services.cart.getCart = async () => { events.push('start'); await gate; events.push('done'); return fail(); };
  const originalClose = services.session.closeBrowserSession;
  services.session.closeBrowserSession = async () => { events.push('close'); return originalClose(); };
  const app = createShoppingApplication({ version: 'test', services });
  const first = app.dispatchToolCall('get_cart'); await Promise.resolve();
  const close = app.close();
  await Promise.resolve(); assert.deepEqual(events, ['start']); release();
  await first; await close; assert.deepEqual(events, ['start', 'done', 'close']);
  assert.equal(state.closes, 1);
});

test('discovery schemas describe strict inputs, defaults, outputs and operation annotations', async t => {
  const { services, state } = injectedServices(); const { client } = await connect(t, services);
  const tools = (await client.listTools()).tools;
  const validator = new AjvJsonSchemaValidator();
  for (const tool of tools) {
    assert.ok(tool.title); assert.equal(tool.inputSchema.additionalProperties, false);
    assert.equal(present(tool.outputSchema).type, 'object');
    assert.deepEqual(present(tool.outputSchema).required, ['result']);
    for (const key of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const) assert.equal(typeof present(tool.annotations)[key], 'boolean');
    const args = tool.name === 'search_products' ? { query: 'milk' } : tool.name === 'list_pickup_stores' ? { postalCode: '3000-001', latitude: 40.2, longitude: -8.4 } : ['list_pickup_slots', 'set_pickup_store'].includes(tool.name) ? { fromDate: '2026-10-18', toDate: '2026-10-19', ...(tool.name === 'set_pickup_store' ? { storeId: 'synthetic-store-001' } : {}) } : tool.name === 'set_cart_coupons' ? { couponIds: ['synthetic-coupon-001'] } : ['add_cart_item', 'set_cart_item_quantity'].includes(tool.name) ? { productId: ProductIdSchema.parse('00123'), quantity: 1 } :
      ['remove_cart_item', 'get_product'].includes(tool.name) ? { productId: ProductIdSchema.parse('00123') } : tool.name === 'get_order' ? { orderId: 'first' } :
      tool.name === 'preview_cart_changes' ? { items: [{ productId: '00123', quantity: 1 }] } :
      tool.name === 'get_product_labels' ? { productIds: ['00123'] } :
      tool.name === 'clear_cart' ? { confirm: true } :
      tool.name === 'choose_products' ? { decisions: [{ question: 'Milk', productIds: ['00123', '00123'] }] } : {};
    const result = await client.callTool({ name: tool.name, arguments: args });
    assert.equal(validator.getValidator(validatorSchema(present(tool.outputSchema)))(result.structuredContent).valid, true, tool.name);
    assert.equal(statusOf(result), ['get_checkout_summary', 'list_pickup_slots'].includes(tool.name) ? 'partial' : 'success', tool.name);
  }
  const byName = Object.fromEntries(tools.map(tool => [tool.name, tool]));
  assert.equal(z.object({ default: z.number() }).parse(present(present(byName.search_products).inputSchema.properties).limit).default, 10);
  assert.deepEqual(present(byName.set_cart_item_quantity).inputSchema.required, ['productId', 'quantity']);
  assert.equal(present(present(byName.add_cart_item).annotations).idempotentHint, false);
  assert.equal(present(present(byName.set_cart_item_quantity).annotations).destructiveHint, true);
  assert.equal(present(present(byName.list_favorites).annotations).readOnlyHint, true);
  assert.equal(present(present(byName.get_session_status).annotations).openWorldHint, false);
  for (const [name, args] of [['get_cart', { extra: true }], ['search_products', { query: 'milk\n' }],
    ['add_cart_item', { productId: '00123\n' }], ['search_products', { query: 'milk', limit: '5' }],
    ['search_products', { query: 'milk', surprise: true }]] as const) {
    assert.equal(validator.getValidator(validatorSchema(present(byName[name]).inputSchema))(args).valid, false);
    await assert.rejects(client.callTool({ name, arguments: args }), { code: -32602 });
  }
  await assert.rejects(client.request({ method: 'tools/call', params: { name: 'get_cart', arguments: [] } }, CallToolResultSchema), { code: -32602 });
  // A task-augmented call is refused before it runs: it must not change the cart.
  const writes = state.writes;
  await assert.rejects(client.request({ method: 'tools/call', params: { name: 'add_cart_item', arguments: { productId: ProductIdSchema.parse('00123') }, task: {} } }, CallToolResultSchema),
    (error: { code?: number; message?: string }) => error.code === -32602 || /does not support task creation/.test(error.message ?? ''));
  assert.equal(state.writes, writes);
});
test('empty and partial results agree with text and retain data and failure counts', async t => {
  const { services } = injectedServices(); const { client } = await connect(t, services);
  services.catalog.searchProducts = async () => ok({ page: { items: [], failures: [], completeness: 'unknown', nextCursor: null }, scanned: 0, unknownToFilter: 0, favorites: [] });
  const empty = await client.callTool({ name: 'search_products', arguments: { query: 'nothing' } });
  assert.equal(statusOf(empty), 'empty'); assert.match(textOf(empty), /No products found/);
  services.catalog.searchProducts = async () => ok({ page: { items: [], failures: [fail().error], completeness: 'partial', nextCursor: null }, scanned: 0, unknownToFilter: 0, favorites: [] });
  const partial = await client.callTool({ name: 'search_products', arguments: { query: 'nothing' } });
  assert.equal(partial.isError, undefined); assert.equal(statusOf(partial), 'partial');
  assert.equal(dataOf(partial, SearchData).failures.length, 1); assert.match(textOf(partial), /Partial results/);
  services.orders.listOrders = async () => ok({ items: [], failures: [fail().error], completeness: 'partial', nextCursor: null, hasMore: null, detailBudget: 5, detailsRead: 0, scanFailures: [] });
  const orders = await client.callTool({ name: 'list_orders' });
  assert.equal(statusOf(orders), 'partial'); assert.match(textOf(orders), /Partial results/);
  services.history.listFrequentlyBoughtProducts = async () => ok({ products: [], listed: 2, scanned: 2, succeeded: 1, failed: 1, unscanned: 0, unknownQuantityLines: 0, failures: [], completeness: 'partial' });
  const frequency = await client.callTool({ name: 'list_frequently_bought_products' });
  assert.equal(statusOf(frequency), 'partial'); assert.match(textOf(frequency), /1 of 2 orders/);
  services.cart.getCart = async () => ok({ customerAuthenticated: true, items: [], totals: { products: null, bags: null, deposit: null, delivery: null, discounts: null, grandTotal: null, estimated: false }, checkout: { minimumOrder: null, meetsMinimum: null, entregaZero: null, freeDeliveryFrom: null, deliveryFee: 'set_at_checkout' } });
  const cart = await client.callTool({ name: 'get_cart' });
  assert.equal(statusOf(cart), 'empty'); assert.match(textOf(cart), /cart is empty/);
});
test('execution errors, including preflight mutations, satisfy the published output schema', async t => {
  const { services } = injectedServices(); const { client } = await connect(t, services);
  services.cart.addCartItem = async () => fail('not_found');
  const result = await client.callTool({ name: 'add_cart_item', arguments: { productId: ProductIdSchema.parse('00123') } });
  assert.equal(result.isError, true); assert.equal(statusOf(result), 'error');
  assert.equal(mutationOf(result).outcome, 'not_applied');
  assert.ok(textOf(result).includes(toolError(result).message));
  const schema = present((await client.listTools()).tools.find(tool => tool.name === 'add_cart_item')).outputSchema;
  assert.equal(new AjvJsonSchemaValidator().getValidator(validatorSchema(present(schema)))(result.structuredContent).valid, true);
});
test('thrown or invalid results are sanitized, validate errors too, and never replay mutations', async () => {
  for (const [cartMutation, execute, expected] of [
    [false, async () => { throw new Error('secret cookie upstream payload'); }, 'internal_error'],
    [false, async () => ({ isError: true, structuredContent: { secret: 'payload' }, content: [] }), 'invalid_result'],
    [false, async () => ({ structuredContent: { result: { status: 'error', error: fail().error } }, content: [] }), 'invalid_result'],
    [true, async () => ({ structuredContent: { secret: 'payload' }, content: [] }), 'invalid_result'],
    [true, async () => ({ structuredContent: { result: { status: 'error', error: fail().error } }, isError: true, content: 'bad' }), 'invalid_result'],
    [true, async () => { throw new Error('secret'); }, 'internal_error'],
  ] as const) {
    let calls = 0;
    // Deliberately malformed handler output exercises runtime rejection beyond the static contract.
    const app = createApplication({ version: 'test', tools: [{ definition: { name: 'probe' }, inputSchema: z.strictObject({}),
      outputSchema: CartOutput, cartMutation, execute: async () => { calls++; return await execute() as import('@modelcontextprotocol/sdk/types.js').CallToolResult; } }] });
    try {
      const result = await app.dispatchToolCall('probe');
      assert.equal(result.isError, true); assert.equal(toolError(result).code, expected);
      assert.equal(CartOutput.safeParse(result.structuredContent).success, true);
      assert.equal(calls, 1); assert.doesNotMatch(JSON.stringify(result), /secret|payload/);
      if (cartMutation) assert.deepEqual(mutationOf(result), { outcome: 'unknown', recovery: { action: 'get_cart', automaticReplay: false } });
    } finally { await app.close(); }
  }
});

test('cart tools preserve incremental, absolute and removal semantics', async t => {
  const { state, services } = injectedServices(); const { client } = await connect(t, services);
  const add = await client.callTool({ name: 'add_cart_item', arguments: { productId: 'leite-00123.html' } });
  assert.deepEqual(Object.keys(present(add.structuredContent)), ['result']);
  assert.equal(dataOf(add, MutationData).productId, '00123');
  assert.equal(dataOf(add, MutationData).requested.value, 1);
  assert.equal(dataOf(add, MutationData).confirmedQuantity.value, 3);
  assert.match(textOf(add), /Added 1 un of product 00123/);
  assert.match(textOf(add), /The cart now holds 3 un/);
  const set = await client.callTool({ name: 'set_cart_item_quantity', arguments: { productId: ProductIdSchema.parse('00123'), quantity: 2 } });
  assert.equal(dataOf(set, MutationData).confirmedQuantity.value, 2);
  assert.match(textOf(set), /Set the quantity to 2 un/);
  const cart = await client.callTool({ name: 'get_cart' });
  assert.deepEqual(Object.keys(present(cart.structuredContent)), ['result']);
  assert.equal(having(present(dataOf(cart, CartData).items[0]).quantity, 'value').value, 2);
  const removed = await client.callTool({ name: 'set_cart_item_quantity', arguments: { productId: ProductIdSchema.parse('00123'), quantity: 0 } });
  assert.equal(dataOf(removed, MutationData).confirmedQuantity.value, 0);
  assert.equal(state.quantity, 0); assert.equal(state.writes, 3);
  const added = await client.callTool({ name: 'set_cart_item_quantity', arguments: { productId: ProductIdSchema.parse('00123'), quantity: 2 } });
  assert.equal(dataOf(added, MutationData).confirmedQuantity.value, 2);
  assert.equal(state.quantity, 2); assert.equal(state.writes, 4);
  const repeated = await client.callTool({ name: 'set_cart_item_quantity', arguments: { productId: ProductIdSchema.parse('00123'), quantity: 2 } });
  assert.equal(dataOf(repeated, MutationData).confirmedQuantity.value, 2); assert.equal(state.writes, 4);
});
test('frequency orderLimit and result limit are independent', async t => {
  const { services } = injectedServices(); const calls: number[] = [];
  services.history.listFrequentlyBoughtProducts = async orderLimit => {
    calls.push(orderLimit);
    return ok({ products: Array.from({ length: 30 }, (_, i) => ({ productId: ProductIdSchema.parse(String(i)), identityBasis: 'product', name: `Product ${i}`,
      orders: 1, quantities: [{ value: 1, unit: 'un' }], unknownQuantityLines: 0 })), listed: orderLimit, scanned: orderLimit, succeeded: orderLimit, failed: 0, unscanned: 0, unknownQuantityLines: 0, failures: [], completeness: 'unknown' });
  };
  const { client } = await connect(t, services);
  for (const [name, args, expectedScan, expectedResults] of [
    ['list_frequently_bought_products', { orderLimit: 2, limit: 1 }, 2, 1],
    ['list_frequently_bought_products', {}, 10, 25],
    ['list_frequently_bought_products', { limit: 40 }, 10, 30],
  ] as const) {
    const response = await client.callTool({ name, arguments: args });
    assert.equal(calls.at(-1), expectedScan);
    assert.equal(dataOf(response, FrequencyData).products.length, expectedResults);
    assert.equal(dataOf(response, FrequencyData).scanned, expectedScan);
    assert.equal((textOf(response).match(/across 1 order/g) ?? []).length, expectedResults);
  }
});
test('strict tool contracts reject invalid fields and limits before I/O', async t => {
  const { state, services } = injectedServices(); const { client } = await connect(t, services);
  for (const [name, args] of [
    ['add_cart_item', { product: '00123' }],
    ['set_cart_item_quantity', { productId: ProductIdSchema.parse('00123'), qty: 1 }], ['add_cart_item', { productId: ProductIdSchema.parse('00123'), quantity: 0 }],
    ['add_cart_item', { productId: ProductIdSchema.parse('00123'), unexpected: true }],
    ['list_frequently_bought_products', { orderLimit: 0 }], ['list_frequently_bought_products', { limit: 51 }],
    ['list_frequently_bought_products', { orderLimit: 1.5 }],
  ] as const) await assert.rejects(client.callTool({ name, arguments: args }), { code: -32602 });
  assert.equal(state.reads, 0); assert.equal(state.writes, 0); assert.equal(state.refreshes, 0);
});
test('uncertain mutations keep recovery guidance and the error schema without root fields', async t => {
  const { state, services } = injectedServices(); let calls = 0;
  services.cart.addCartItem = async () => { calls++; return ok({ productId: ProductIdSchema.parse('00123'), requested: { value: 1, unit: 'un' }, outcome: 'unknown',
    error: fail('not_authenticated').error, recovery: { action: 'get_cart', automaticReplay: false } }); };
  const { client } = await connect(t, services);
  for (const [name, args] of [['add_cart_item', { productId: ProductIdSchema.parse('00123') }]] as const) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, true); assert.equal(mutationOf(result).outcome, 'unknown');
    assert.equal(recoveryOf(result).automaticReplay, false);
    assert.equal(toolError(result).retryable, false);
    assert.match(textOf(result), /Call get_cart/); assert.doesNotMatch(textOf(result), /then try again/);
    assert.deepEqual(Object.keys(present(result.structuredContent)), ['result']);
  }
  assert.equal(calls, 1); assert.equal(state.refreshes, 0);
});

function website() {
  const calls: { method: string; url: string; options: { headers?: Record<string, string>; form?: unknown; maxRedirects?: number } }[] = []; let html = fixture('catalog'); let currentUrl = 'https://www.continente.pt/';
  const response = { ok: () => true, status: () => 200, async text() { return html; }, async json(): Promise<unknown> { return rawCart(1); } };
  const request = { async get(url: string | URL, options: { headers?: Record<string, string>; form?: unknown; maxRedirects?: number } = {}) { calls.push({ method: 'GET', url: String(url), options }); return response; }, async post(url: string | URL, options: { headers?: Record<string, string>; form?: unknown; maxRedirects?: number } = {}) { calls.push({ method: 'POST', url: String(url), options }); return response; } };
  const page = { async goto(url: string) { currentUrl = url; return response; }, async waitForTimeout() {}, async waitForSelector() { return null; },
    url: () => currentUrl, async content() { return html; }, locator: () => ({ async innerText() { return ''; } }),
    async evaluate() { return { pid: '00123', action: '/Cart-AddProduct', csrf: 'current-property', measureOptions: JSON.stringify(unitRules) }; } };
  // The generic evaluate callback is replaced with a fixed form extraction fixture.
  const session = { async ensureReady() { return { page: page as unknown as import('playwright').Page, context: { request } }; } };
  return { site: new StorefrontClient(double<StorefrontSession>(session)), calls, page, response, setHtml(value: string) { html = value; } };
}
test('website clients retain authenticated request parameters and reject foreign writes before I/O', async () => {
  const fixture = website(); const client = new CartClient(double<StorefrontClient>(fixture.site));
  assert.equal((await client.fetchCart()).ok, true);
  assert.match(present(fixture.calls[0]).url, /Cart-MiniCartShow$/);
  assert.equal(present(present(fixture.calls[0]).options.headers)['X-Requested-With'], 'XMLHttpRequest');
  const params = new URLSearchParams({ pid: '00123', quantity: '1', csrf_token: 'synthetic' });
  await client.submitCartMutation('/Cart-AddProduct', params, 'POST');
  assert.deepEqual(present(fixture.calls[1]).options.form, Object.fromEntries(params));
  assert.equal(present(fixture.calls[1]).options.maxRedirects, 0);
  assert.equal((await client.submitCartMutation('https://other.invalid/cart', params, 'POST')).ok, false);
  assert.equal(fixture.calls.length, 2);
});
test('product client extracts raw current input values and parser owns purchase interpretation', async () => {
  const fixture = website(); const client = new CartClient(double<StorefrontClient>(fixture.site));
  const response = await client.fetchProductForm('00123');
  assert.equal(z.object({ csrf: z.string() }).parse(valueOf(response)).csrf, 'current-property');
  assert.equal(valueOf(parseProductForm(valueOf(response), ProductIdSchema.parse('00123'))).sale.alternativeUnit, false);
});
test('catalogue follows explicit continuations and stops repeated pages instead of inventing offsets', async () => {
  const fixture = website(); const client = new CatalogClient(double<StorefrontClient>(fixture.site));
  const result = valueOf((await client.searchProducts('milk & bread', 10)));
  assert.equal(result.pages.length, 2); assert.equal(result.completeness, 'partial');
  assert.deepEqual(fixture.calls.map(call => new URL(call.url).searchParams.get('start')), ['35']);
  fixture.response.ok = () => false;
  assert.equal((await client.searchProducts('milk', 0)).ok, false);
});
test('favorites and orders reject login redirects and failed detail HTTP responses', async () => {
  const fixture = website(); fixture.page.url = () => 'https://www.continente.pt/login/';
  assert.equal(errorOf((await new FavoritesClient(double<StorefrontClient>(fixture.site)).fetchFavorites())).code, 'not_authenticated');
  assert.equal(errorOf((await new OrdersClient(double<StorefrontClient>(fixture.site)).fetchOrderLines('/detalhe-encomenda'))).code, 'not_authenticated');
  fixture.page.url = () => 'https://www.continente.pt/conta/encomendas/';
  fixture.response.ok = () => false;
  assert.equal(errorOf((await new OrdersClient(double<StorefrontClient>(fixture.site)).fetchOrderHistory())).code, 'upstream_unavailable');
});
test('response policy consistently classifies authentication, redirects and failed payloads', async () => {
  for (const [status, url, location, code] of [
    [401, 'https://www.continente.pt/', undefined, 'not_authenticated'],
    [403, 'https://www.continente.pt/', undefined, 'not_authenticated'],
    [200, 'https://login.continente.pt/user-register', undefined, 'not_authenticated'],
    [302, 'https://www.continente.pt/cart', '/login/', 'not_authenticated'],
    [503, 'https://www.continente.pt/', undefined, 'upstream_unavailable'],
    [200, 'https://other.invalid/', undefined, 'invalid_data'],
    [200, 'https://user:password@www.continente.pt/', undefined, 'invalid_data'],
  ] as const) assert.equal(errorOf(responseStatus({ status: () => status, ok: () => status === 200, headers: () => (location ? { location } : {}) }, url)).code, code);
  const fixture = website(); const cart = new CartClient(double<StorefrontClient>(fixture.site));
  fixture.response.json = async () => ({ resources: { customerAuthenticated: false } });
  assert.equal(errorOf((await cart.fetchCart())).code, 'not_authenticated');
  fixture.response.status = () => 401; fixture.response.ok = () => false;
  assert.equal(errorOf((await cart.fetchCart())).code, 'not_authenticated');
  assert.equal(errorOf((await new OrdersClient(double<StorefrontClient>(fixture.site)).fetchOrderHistory())).code, 'not_authenticated');
});
