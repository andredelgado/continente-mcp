import { having, double, toolError, mutationOf, statusOf, dataOf } from '../test-support/assertions.js';
import type { CookieStore } from '../src/stores/files.js';
import type { BrowserLauncher, BrowserLease, StorefrontSession } from '../src/session/browser.js';
import { present, ok, fail, rawCart, fixture, productForm, ordersPage } from '../test-support/helpers.js';
import { OrdersData, SearchData } from '../src/mcp/contracts.js';
import { ProgressNotificationSchema, CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { createShoppingApplication } from '../src/runtime.js';
import { CartService } from '../src/services/cart.js';
import { OrderService } from '../src/services/orders.js';
import { CatalogService } from '../src/services/catalog.js';
import { BrowserSession } from '../src/session/browser.js';
import { StorefrontClient, CatalogClient } from '../src/clients/storefront.js';
import { createSerialTaskQueue } from '../src/session/queue.js';
import { RequestScope, inRequest, currentRequest, requestIO } from '../src/session/request.js';
import { injectedServices, connect } from '../test-support/mcp-fixture.js';

import assert from 'node:assert/strict';
import test from 'node:test';

function deferred<T = void>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => { throw new Error('Gate not initialized'); };
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test('cancelled queued mutations return promptly and never reach shopping I/O', async () => {
  const { state, services } = injectedServices(); const started = deferred(); const gate = deferred();
  services.cart.getCart = async () => { started.resolve(); await gate.promise; return fail(); };
  const app = createShoppingApplication({ version: 'test', services });
  const active = app.dispatchToolCall('get_cart'); await started.promise;
  const cancel = new AbortController();
  const queued = app.dispatchToolCall('add_cart_item', { productId: '00123' }, { signal: cancel.signal });
  cancel.abort();
  try {
    const result = await queued;
    assert.equal(toolError(result).code, 'cancelled');
    assert.equal(mutationOf(result).outcome, 'not_applied');
    assert.equal(state.reads, 0); assert.equal(state.writes, 0);
  } finally { gate.resolve(); await active; await app.close(); }
  assert.equal(state.writes, 0);
});
test('an active read is cancelled without waiting for a stalled upstream response', async () => {
  const { services } = injectedServices(); const started = deferred(); const cancel = new AbortController();
  services.cart = new CartService({ async fetchCartControls() { throw new Error('Unexpected controls read'); }, async fetchProductForm() { throw new Error('Unexpected product read'); }, async submitCartMutation() { throw new Error('Unexpected write'); }, async fetchCart() { started.resolve(); return new Promise(() => {}); } });
  const app = createShoppingApplication({ version: 'test', services });
  const active = app.dispatchToolCall('get_cart', {}, { signal: cancel.signal });
  await started.promise; cancel.abort();
  const result = await active;
  assert.equal(result.isError, true); assert.equal(toolError(result).code, 'cancelled');
  await app.close();
});
test('deadline stops a stalled order scan and preserves completed details and progress', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { services } = injectedServices(); let reads = 0; const stalled = deferred(); const progress: import('../src/session/request.js').Progress[] = [];
  services.orders = new OrderService({ async fetchOrderHistory() { return ok(ordersPage); },
    async fetchOrderLines() { if (++reads === 1) return ok(fixture('order')); stalled.resolve(); return new Promise(() => {}); } });
  const app = createShoppingApplication({ version: 'test', services });
  const call = app.dispatchToolCall('list_orders', {}, { timeoutMs: 40, onProgress: value => progress.push(value) });
  await stalled.promise; t.mock.timers.tick(40); const result = await call;
  assert.equal(statusOf(result), 'partial');
  assert.equal(present(dataOf(result, OrdersData).orders[0]).lines.status, 'available');
  assert.equal(having(present(dataOf(result, OrdersData).orders[1]).lines, 'error').error.code, 'deadline_exceeded');
  assert.deepEqual(progress.map(value => value.completed), [1]); assert.equal(reads, 2);
  await app.close();
});
test('scan progress travels over MCP using the caller progress token', async t => {
  const { services } = injectedServices(); const { client } = await connect(t, services); const progress: import('@modelcontextprotocol/sdk/types.js').ProgressNotification['params'][] = [];
  client.setNotificationHandler(ProgressNotificationSchema, message => { progress.push(message.params); });
  await client.callTool({ name: 'list_orders', _meta: { progressToken: 'order-scan' } });
  assert.deepEqual(progress.map(value => value.progress), [1, 2]);
  assert.ok(progress.every(value => value.progressToken === 'order-scan' && value.total === 2));
});
test('catalogue cancellation keeps already-read products as partial results', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { services } = injectedServices(); await services.favorites.refreshFavorites(); let reads = 0; const stalled = deferred();
  const catalog = new CatalogClient(double<StorefrontClient>({ async html() { return ok(fixture('catalog')); },
    session: { async ensureReady() { return double<BrowserLease>({ context: { request: { async get() { reads++; stalled.resolve(); return new Promise<never>(() => {}); } } } }); } },
    io<T>(lease: unknown, operation: () => Promise<T>) { return requestIO(operation); } }));
  services.catalog = new CatalogService(catalog, services.favorites);
  const app = createShoppingApplication({ version: 'test', services });
  const call = app.dispatchToolCall('search_products', { query: 'milk' }, { timeoutMs: 40 });
  await stalled.promise; t.mock.timers.tick(40); const result = await call;
  assert.equal(statusOf(result), 'partial');
  assert.equal(dataOf(result, SearchData).products.length, 3);
  assert.equal(present(dataOf(result, SearchData).failures[0]).code, 'deadline_exceeded');
  assert.equal(reads, 1); await app.close();
});
test('MCP cancellation notifications reach the running service scope', async t => {
  const { services } = injectedServices(); const started = deferred(); const stopped = deferred();
  services.cart.getCart = async () => {
    present(currentRequest()).signal.addEventListener('abort', () => stopped.resolve(), { once: true });
    started.resolve(); return requestIO(() => new Promise(() => {}));
  };
  const { client } = await connect(t, services); const cancel = new AbortController();
  const call = client.callTool({ name: 'get_cart' }, CallToolResultSchema, { signal: cancel.signal });
  const rejected = assert.rejects(call);
  await started.promise; cancel.abort(); await rejected; await stopped.promise;
});
test('cancelling after a possible write preserves unknown recovery and never retries', async () => {
  const { state, services } = injectedServices(); const sent = deferred(); let writes = 0; let reads = 0;
  services.cart = new CartService({ async fetchCartControls() { throw new Error('Unexpected controls read'); }, async fetchCart() { reads++; return ok(rawCart(2)); }, async fetchProductForm() { return ok(productForm()); },
    async submitCartMutation() { writes++; sent.resolve(); return new Promise(() => {}); } });
  const app = createShoppingApplication({ version: 'test', services }); const cancel = new AbortController();
  const active = app.dispatchToolCall('add_cart_item', { productId: '00123' }, { signal: cancel.signal });
  await sent.promise; cancel.abort(); const result = await active;
  assert.equal(toolError(result).code, 'cancelled');
  assert.deepEqual(mutationOf(result), { outcome: 'unknown', recovery: { action: 'get_cart', automaticReplay: false } });
  assert.equal(writes, 1); assert.equal(reads, 1); assert.equal(state.refreshes, 0);
  await app.close();
});
test('queue admission is bounded and shutdown discards waiting operations', async () => {
  const queue = createSerialTaskQueue(1); const started = deferred(); const gate = deferred(); let calls = 0;
  const first = queue(async () => { started.resolve(); await gate.promise; }); await started.promise;
  const waiting = queue(async () => { calls++; }); const rejected = assert.rejects(waiting, { code: 'server_closed' });
  await assert.rejects(queue(async () => {}), { code: 'queue_full' });
  const shutdown = queue.shutdown(); gate.resolve(); await first; await rejected; await shutdown;
  await assert.rejects(queue(async () => {}), { code: 'server_closed' }); assert.equal(calls, 0);
});
test('shutdown cancels active and queued work, closes browser once, and rejects new calls', async () => {
  const { services } = injectedServices(); let closes = 0; let writes = 0; const started = deferred();
  services.session = new BrowserSession(double<BrowserLauncher>(async () => ({ on() { return double<import('playwright').Browser>({}); }, async close() { closes++; }, version: () => '140.0.0.0', async newContext() {
    return { async route() { return double<import('playwright').Disposable>({}); }, async close() {}, async newPage() { return { isClosed: () => false, async close() {} }; } };
  } })), double<CookieStore>({ async revision() { return null; } }), async () => false, () => {});
  assert.ok(services.session instanceof BrowserSession); await services.session.ensureReady();
  services.cart = new CartService({ async fetchCartControls() { throw new Error('Unexpected controls read'); }, async fetchCart() { started.resolve(); return new Promise(() => {}); }, async fetchProductForm() { throw new Error('Unexpected product read'); }, async submitCartMutation() { writes++; return ok({}); } });
  const app = createShoppingApplication({ version: 'test', services });
  const active = app.dispatchToolCall('get_cart'); await started.promise;
  const waiting = app.dispatchToolCall('add_cart_item', { productId: '00123' });
  await Promise.all([app.close(), app.close()]);
  assert.equal(toolError((await active)).code, 'server_closed');
  assert.equal(mutationOf((await waiting)).outcome, 'not_applied');
  assert.equal(toolError((await app.dispatchToolCall('get_cart'))).code, 'server_closed');
  assert.equal(closes, 1); assert.equal(writes, 0);
});
test('cancelled browser I/O retires its lease before the next operation starts', async () => {
  let contexts = 0; let closed = 0; const navigating = deferred(); const late = deferred();
  const session = new BrowserSession(double<BrowserLauncher>(async () => ({ on() { return double<import('playwright').Browser>({}); }, async close() {}, version: () => '140.0.0.0', async newContext() {
    const id = ++contexts; return { async route() { return double<import('playwright').Disposable>({}); }, async close() { closed++; }, async newPage() { return {
      isClosed: () => false, async close() {}, url: () => 'https://www.continente.pt/',
      async goto() { if (id === 1) { navigating.resolve(); await late.promise; } return { ok: () => true, status: () => 200 }; },
      async waitForSelector() { return null; }, async content() { return '<main>ready</main>'; },
    }; } };
  } })), double<CookieStore>({ async revision() { return null; } }), async () => false, () => {});
  const site = new StorefrontClient(double<StorefrontSession>(session)); const scope = new RequestScope();
  const read = inRequest(scope, () => session.run(() => site.html('/')));
  await navigating.promise; scope.cancel('cancelled'); await assert.rejects(read, { code: 'cancelled' }); scope.dispose();
  assert.equal((await session.run(() => site.html('/'))).ok, true);
  assert.equal(contexts, 2); assert.equal(closed, 1); late.resolve(); await session.shutdown();
});
test('a browser that finishes launching after cancellation is closed rather than leaked', async () => {
  const launch = deferred<import('playwright').Browser>(); const started = deferred(); const closed = deferred();
  const session = new BrowserSession(double<BrowserLauncher>(async () => { started.resolve(); return launch.promise; }),
    double<CookieStore>({ async revision() { return null; } }), async () => false, () => {});
  const scope = new RequestScope(); const ready = inRequest(scope, () => session.ensureReady());
  await started.promise; scope.cancel('cancelled'); await assert.rejects(ready, { code: 'cancelled' }); scope.dispose();
  launch.resolve(double<import('playwright').Browser>({ async close() { closed.resolve(); } })); await closed.promise;
  await session.shutdown();
});
