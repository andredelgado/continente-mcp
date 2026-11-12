import { ProductIdSchema } from '../src/domain/index.js';
import { double, having } from '../test-support/assertions.js';
import { present, valueOf, errorOf, fixture, ok, fail, rawCart, productForm, cartControls, unitRules, weightedRules, ordersPage, pages } from '../test-support/helpers.js';
import type { FavoritesCache } from '../src/domain/index.js';
import type { CartGateway, FavoritesGateway, FavoritesStore, OrdersGateway, CatalogGateway } from '../src/ports.js';

import { CatalogService, FavoritesService } from '../src/services/catalog.js';
import { CartService } from '../src/services/cart.js';
import { OrderService, PurchaseHistoryService } from '../src/services/orders.js';
import { withAuthenticationRecovery } from '../src/services/recovery.js';

import assert from 'node:assert/strict';
import test from 'node:test';

interface CartScenario { initial?: number; rules?: typeof unitRules; confirmation?: number; receipt?: Awaited<ReturnType<CartGateway['submitCartMutation']>>; writeThrows?: boolean; controls?: string; }
function cartScenario({ initial = 0, rules = unitRules, confirmation, receipt, writeThrows = false, controls = cartControls(rules) }: CartScenario = {}) {
  let quantity = initial;
  const writes: { action: string; params: Record<string, string>; operation: string }[] = [];
  const client: CartGateway = {
    async fetchCart() { return ok(rawCart(confirmation !== undefined && writes.length ? confirmation : quantity)); },
    async fetchProductForm() { return ok(productForm(rules)); },
    async fetchCartControls() { return ok(controls); },
    async submitCartMutation(action, params, operation) {
      writes.push({ action, params: Object.fromEntries(params), operation });
      if (writeThrows) throw new Error('connection lost after write');
      if (operation === 'add') quantity += params.get('quantity') === '-1' ? 3 : Number(params.get('quantity'));
      else quantity = action.includes('Remove') ? 0 : Number(params.get('quantity')) / (rules.primaryToSecondary || 1);
      return receipt ?? ok({ success: true });
    },
  };
  return { client, writes, service: new CartService(client) };
}

test('unit add is incremental and confirms the final basket quantity', async () => {
  const { service, writes } = cartScenario({ initial: 4 });
  const result = await service.addCartItem('leite-00123.html', 2);
  assert.equal(valueOf(result).outcome, 'confirmed');
  assert.deepEqual(valueOf(result).requested, { value: 2, unit: 'un' });
  assert.equal(having(valueOf(result), 'confirmedQuantity').confirmedQuantity.value, 6);
  assert.deepEqual(writes[0], { action: '/Cart-AddProduct', operation: 'add', params: { pid: '00123-master', quantity: '2', options: '[]', csrf_token: 'synthetic-token' } });
});
test('weighted new item uses minimum sentinel then one absolute update', async () => {
  const { service, writes } = cartScenario({ rules: weightedRules });
  const result = await service.addCartItem('00123', 12);
  assert.equal(valueOf(result).outcome, 'confirmed');
  assert.ok(Math.abs(having(valueOf(result), 'confirmedQuantity').confirmedQuantity.value - 12) < 0.0005);
  assert.equal(writes.length, 2);
  assert.equal(present(writes[0]).params.quantity, '-1');
  assert.equal(present(writes[1]).params.quantity, '2.4');
  assert.equal(present(writes[1]).params.step, '0.2');
  assert.equal(present(writes[1]).params.dimension, 'un');
});
test('a weighted maximum in kg limits whole pieces and is enforced before any write', async () => {
  const limited = { ...weightedRules, maxNumberOfUnitsPerSale: 5 };
  const { service, writes } = cartScenario({ rules: limited });
  assert.equal(valueOf(await service.addCartItem('00123', 25)).outcome, 'confirmed');
  const over = cartScenario({ rules: limited });
  assert.equal(errorOf(await over.service.addCartItem('00123', 26)).code, 'invalid_input');
  assert.equal(over.writes.length, 0);
  assert.equal(present(writes[1]).params.quantity, '5');
});
test('weighted existing item uses absolute total and validates minimum against that total', async () => {
  const { service, writes } = cartScenario({ initial: 4, rules: weightedRules });
  const result = await service.addCartItem('00123', 1);
  assert.equal(having(valueOf(result), 'confirmedQuantity').confirmedQuantity.value, 5);
  assert.equal(valueOf(result).requested.value, 1);
  assert.equal(writes.length, 1);
  assert.equal(present(writes[0]).operation, 'update');
  assert.equal(present(writes[0]).params.quantity, '1');
  const tooSmall = cartScenario({ rules: weightedRules });
  assert.equal(errorOf((await tooSmall.service.addCartItem('00123', 2))).code, 'quantity_below_minimum');
  assert.equal(tooSmall.writes.length, 0);
});
test('set is absolute and zero removes via the cart line UUID', async () => {
  const { service, writes } = cartScenario({ initial: 4 });
  assert.equal(having(valueOf((await service.setCartItemQuantity('00123', 2))), 'confirmedQuantity').confirmedQuantity.value, 2);
  assert.equal(having(valueOf((await service.setCartItemQuantity('00123', 0))), 'confirmedQuantity').confirmedQuantity.value, 0);
  assert.deepEqual(writes[1], { action: '/Cart-RemoveProduct', operation: 'remove', params: { pid: '00123', uuid: 'line-abc' } });
});
test('missing cart line and foreign action fail before any network write', async () => {
  for (const controls of ['', cartControls(unitRules, 'https://other.invalid/update')] as const) {
    const { service, writes } = cartScenario({ initial: 4, controls });
    assert.equal((await service.setCartItemQuantity('00123', 2)).ok, false);
    assert.equal(writes.length, 0);
  }
});
test('rejected receipt, thrown write and mismatched confirmation are unknown with no authentication replay', async () => {
  for (const options of [{ receipt: ok({ error: true }) }, { receipt: fail('not_authenticated') }, { writeThrows: true }, { confirmation: 0 }] as const) {
    const { service, writes } = cartScenario(options);
    let refreshes = 0;
    const result = await withAuthenticationRecovery(() => service.addCartItem('00123', 1), async () => { refreshes++; return true; });
    assert.equal(valueOf(result).outcome, 'unknown');
    assert.equal(having(valueOf(result), 'recovery').recovery.automaticReplay, false);
    assert.equal(having(valueOf(result), 'error').error.retryable, false);
    assert.equal(writes.length, 1);
    assert.equal(refreshes, 0);
  }
});
test('failed second weighted step retains first-write uncertainty without replay', async () => {
  const { service, client, writes } = cartScenario({ rules: weightedRules });
  client.fetchCartControls = async () => fail('not_authenticated');
  let refreshes = 0;
  const result = await withAuthenticationRecovery(() => service.addCartItem('00123', 12), async () => { refreshes++; return true; });
  assert.equal(valueOf(result).outcome, 'unknown');
  assert.equal(writes.length, 1);
  assert.equal(refreshes, 0);
});
test('pre-write authentication failure retries once and no more', async () => {
  let attempts = 0; let refreshes = 0;
  const result = await withAuthenticationRecovery(async () => { attempts++; return fail('not_authenticated'); }, async () => { refreshes++; return true; });
  assert.equal(result.ok, false); assert.equal(attempts, 2); assert.equal(refreshes, 1);
  const scenario = cartScenario();
  let reads = 0;
  scenario.client.fetchCart = async () => ++reads === 1 ? ok({ resources: { customerAuthenticated: false } }) : ok(rawCart(1));
  assert.equal(having(present(valueOf((await withAuthenticationRecovery(() => scenario.service.getCart(), async () => true))).items[0]).quantity, 'quantity').quantity.value, 1);
});
test('cart reads reject malformed data and invalid quantities never write', async () => {
  const { service, client, writes } = cartScenario();
  for (const quantity of [0, -1, NaN, Infinity] as const) assert.equal((await service.addCartItem('00123', quantity)).ok, false);
  client.fetchCart = async () => ok({ resources: { customerAuthenticated: true }, basket: {} });
  assert.equal(errorOf((await service.getCart())).code, 'invalid_data');
  assert.equal(writes.length, 0);
});
test('out-of-step and over-maximum cart changes fail before submission, including add totals', async () => {
  const rules = { ...unitRules, stepQuantity: 1, maxNumberOfUnitsPerSale: 5 };
  for (const [method, initial, value] of [['addCartItem', 4, 2], ['addCartItem', 0, 1.5], ['addCartItem', 0.5, 1.5], ['setCartItemQuantity', 2, 6], ['setCartItemQuantity', 2, 1.5]] as const) {
    const { service, writes } = cartScenario({ initial, rules });
    const result = await service[method]('00123', value);
    assert.equal(result.ok, false); assert.equal(result.error.code, 'invalid_input'); assert.equal(writes.length, 0);
  }
  const { service, writes } = cartScenario({ initial: 4, rules });
  assert.equal(having(valueOf((await service.addCartItem('00123', 1))), 'confirmedQuantity').confirmedQuantity.value, 5);
  assert.equal(writes.length, 1);
});
test('favorites refresh uses injected clock/store and never overwrites cache after fetch failure', async () => {
  let cache: FavoritesCache | null = null; let writes = 0; let fetches = 0;
  const store: FavoritesStore = { async load() { return ok(cache); }, async save(value) { cache = value; writes++; return ok(); } };
  const client: FavoritesGateway = { async fetchFavorites() { fetches++; return ok(pages(fixture('favorites'))); } };
  const service = new FavoritesService(client, store, { now: () => new Date('2026-10-14T12:00:00Z') }, 'test-account', () => {});
  assert.equal(valueOf((await service.listFavorites())).fetchedAt, '2026-10-14T12:00:00.000Z');
  await service.listFavorites(); assert.equal(fetches, 1);
  client.fetchFavorites = async () => fail();
  assert.equal((await service.refreshFavorites()).ok, false); assert.equal(writes, 1);
});
test('catalogue passes requested limit independently of favorites, ranks and deduplicates', async () => {
  let extra;
  const favorite = { productId: ProductIdSchema.parse('456'), productSlug: 'banana-456', name: 'Banana Madeira', price: null, url: 'https://www.continente.pt/produto/banana-456.html' };
  const favorites = { async loadCachedFavorites() { return { favorites: [favorite] }; } };
  const client: CatalogGateway = { async searchProducts(query, pages) { assert.equal(query, 'fruit'); extra = pages; return ok({ pages: [fixture('catalog'), fixture('catalog')], failures: [fail().error] }); } };
  const service = new CatalogService(client, double<FavoritesService>(favorites));
  const result = await service.searchProducts('fruit', 1);
  assert.equal(extra, 1); assert.equal(valueOf(result).scanned, 3);
  // The website's relevance order by default; favorites are marked, not moved.
  assert.deepEqual(valueOf(result).page.items.map(item => [item.productId, item.favorite]), [['00123', false]]);
  assert.equal(valueOf(result).page.completeness, 'partial');
  const relevance = valueOf(await service.searchProducts('fruit', 3));
  assert.deepEqual(relevance.page.items.map(item => [item.productId, item.favorite]), [['00123', false], ['456', true], ['789', false]]);
  const first = valueOf(await service.searchProducts('fruit', 3, { favoritesFirst: true }));
  assert.deepEqual(first.page.items.map(item => item.productId), ['456', '00123', '789']);
});
test('order detail failures retain other orders and unrecognized history avoids detail requests', async () => {
  let requests = 0;
  const client: OrdersGateway = { async fetchOrderHistory() { return ok(ordersPage); }, async fetchOrderLines(url) { requests++; return url.includes('first') ? ok(fixture('order')) : fail(); } };
  const result = await new OrderService(client).listOrders(5);
  assert.equal(present(valueOf(result).items[0]).lines.status, 'available');
  assert.equal(present(valueOf(result).items[1]).lines.status, 'unavailable');
  assert.equal(valueOf(result).completeness, 'partial');
  assert.equal(requests, 2);
  client.fetchOrderHistory = async () => ok('');
  const mismatch = await new OrderService(client).listOrders(1);
  assert.equal(errorOf(mismatch).code, 'invalid_data');
  assert.equal(requests, 2);
});
test('frequency scans requested number of orders and reports unreadable/unknown quantities', async () => {
  const client: OrdersGateway = { async fetchOrderHistory() { return ok(ordersPage); }, async fetchOrderLines(url) { return ok(url.includes('first') ? fixture('order') : fixture('order').replace('2 un', 'unknown')); } };
  const service = new PurchaseHistoryService(client);
  const result = await service.listFrequentlyBoughtProducts(2);
  assert.equal(valueOf(result).scanned, 2); assert.equal(valueOf(result).failed, 0);
  assert.equal(present(valueOf(result).products[0]).orders, 2);
  assert.equal(present(valueOf(result).products.find(p => p.name === 'Leite Meio Gordo')).unknownQuantityLines, 1);
  client.fetchOrderLines = async () => fail();
  assert.equal(valueOf((await service.listFrequentlyBoughtProducts(2))).failed, 2);
});
