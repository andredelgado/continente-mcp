import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, ok, ordersPage, valueOf } from '../test-support/helpers.js';
import { OrderService, PurchaseHistoryService, SettledOrders } from '../src/services/orders.js';

const clock = { now: () => new Date('2026-10-16T12:00:00Z') };
// Order _001 (id=first) was delivered 4 days ago; order _002 (id=second) 15 days ago.
const history = ordersPage.replace('2 outubro 2026', '12 outubro 2026');
const detail = (number: string, date?: string) => `${date ? `<div data-order-date="${date}"></div>` : ''}<h2 class="order-list-title">Encomenda 123456789_${number}</h2>` + fixture('order');
function client() {
  const reads: string[] = [];
  return { reads, async fetchOrderHistory() { return ok(history); }, async fetchOrderLines(url: string) {
    const id = new URL(url).searchParams.get('orderID') ?? new URL(url).searchParams.get('id') ?? '';
    reads.push(id);
    return ok(id === 'first' ? detail('001', '10 outubro 2026') : detail('002', '1 outubro 2026'));
  } };
}

test('settled orders are read once for every order tool; recent ones are read each time', async () => {
  const site = client(); const settled = new SettledOrders(clock, () => 'account');
  const orders = new OrderService(site, settled);
  const first = valueOf(await orders.listOrders(2));
  assert.deepEqual(site.reads, ['first', 'second']);
  const again = valueOf(await orders.listOrders(2));
  assert.deepEqual(site.reads, ['first', 'second', 'first']);
  assert.deepEqual(again, first);
  assert.equal(again.detailsRead, 2);
  await new PurchaseHistoryService(site, settled).listFrequentlyBoughtProducts(2);
  assert.deepEqual(site.reads, ['first', 'second', 'first', 'first']);
  // get_order keeps the detail page's own result: lines read for the list do not stand in for it.
  const single = valueOf(await orders.getOrder('second'));
  assert.equal(site.reads.length, 5);
  assert.deepEqual(valueOf(await orders.getOrder('second')), single);
  await orders.getOrder('first'); await orders.getOrder('first');
  assert.deepEqual(site.reads.slice(5), ['first', 'first']);
});

test('the settled orders are kept per account and handed out as copies', async () => {
  const site = client(); let account = 'one'; const settled = new SettledOrders(clock, () => account);
  const orders = new OrderService(site, settled);
  const read = valueOf(await orders.getOrder('second'));
  assert.equal(read.lines.status, 'available');
  if (read.lines.status === 'available') read.lines.items.length = 0;
  const cached = valueOf(await orders.getOrder('second'));
  assert.ok(cached.lines.status === 'available' && cached.lines.items.length > 0);
  assert.equal(site.reads.length, 1);
  account = 'two';
  await orders.getOrder('second');
  assert.equal(site.reads.length, 2);
  // Without the cache nothing is kept.
  const plain = new OrderService(site);
  await plain.getOrder('second'); await plain.getOrder('second');
  assert.equal(site.reads.length, 4);
});

test('an order read while the session changes is not kept for the new session', async () => {
  let session = 1; const site = client(); const settled = new SettledOrders(clock, () => `account-${session}`);
  // Each detail page is read with one session and arrives after the next one has been saved.
  const switching = { ...site, async fetchOrderLines(url: string) { const page = await site.fetchOrderLines(url); session++; return page; } };
  const orders = new OrderService(site, settled); const switched = new OrderService(switching, settled);
  // The session now in use reads the settled order from the website, not from what the previous one read.
  await switched.getOrder('second'); await orders.getOrder('second');
  assert.deepEqual(site.reads, ['second', 'second']);
  await switched.listOrders(2); await orders.listOrders(2);
  assert.deepEqual(site.reads.slice(2), ['first', 'second', 'first', 'second']);
});
