import type { TestContext } from 'node:test';
import type { FavoritesCache } from '../src/domain/index.js';
import type { ShoppingServices } from '../src/mcp/shopping.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createShoppingApplication, createShoppingServices } from '../src/runtime.js';
import { createSerialTaskQueue } from '../src/session/queue.js';
import { fixture, rawCart, productForm, cartControls, ordersPage, ok, pages } from './helpers.js';
import { parseCouponsPage } from '../src/parsers/coupons.js';
import { parsePickupStores } from '../src/parsers/stores.js';
import { parsePickupSlots } from '../src/parsers/pickup-slots.js';

export function injectedServices() {
  const state = { reads: 0, closes: 0, refreshes: 0, writes: 0, quantity: 2, cache: null as FavoritesCache | null };
  const session = { async ensureReady(): Promise<never> { throw new Error('Gateway fixtures must not open a browser'); }, run: createSerialTaskQueue(), async closeBrowserSession() { state.closes++; }, async refreshAuthentication() { state.refreshes++; return false; } };
  const services = createShoppingServices({ env: { CONTINENTE_CREDENTIALS_FILE: join(tmpdir(), 'continente-fixture-absent.env'), CONTINENTE_DATA_DIR: join(tmpdir(), 'continente-fixture-state'), CONTINENTE_EMAIL: '', CONTINENTE_PASSWORD: '' },
    session, logger: () => {}, clock: { now: () => new Date('2026-10-14T12:00:00Z') },
    favoritesStore: { async load() { return ok(state.cache); }, async save(value) { state.cache = value; return ok(); } },
    catalogClient: { async fetchProductDetails() { state.reads++; return ok({ html: fixture('product'), url: 'https://www.continente.pt/produto/leite-00123.html' }); }, async searchProducts() { state.reads++; return ok({ pages: [fixture('catalog')], failures: [] }); } },
    favoritesClient: { async fetchFavorites() { state.reads++; return ok(pages(fixture('favorites'))); } },
    couponClient: { async fetchCoupons() { state.reads++; return parseCouponsPage(fixture('coupons')); } },
    couponSelectionClient: { async setSelectedCoupons(couponIds: string[]) { state.writes++; return ok({ outcome: 'confirmed' as const, selectedCouponIds: couponIds }); },
      async fetchCheckoutContext() { state.reads++; return ok({ loyaltyCredit: { currency: 'EUR' as const, minorUnits: 40 }, selectedCouponIds: ['synthetic-coupon-001'] }); } },
    pickupStoreClient: { async fetchPickupStores() { state.reads++; return parsePickupStores(fixture('stores')); } },
    pickupSlotClient: { async fetchPickupSlots(window) { state.reads++; return parsePickupSlots(fixture('pickup-slots'), window, new Date('2026-10-14T12:00:00Z')); } },
    pickupStoreSelectionClient: { async setPickupStore(storeId, _window) { state.writes++; return ok({ outcome: 'confirmed' as const,
      requestedStoreId: storeId, previousStoreId: 'synthetic-store-old', selectedStoreId: storeId,
      storeName: 'Synthetic pickup store', storePostalCode: '0000-000', selectedStoreChanged: true,
      cartAndCouponsNeedRevalidation: true }); } },
    ordersClient: { async fetchOrderHistory() { state.reads++; return ok(ordersPage); }, async fetchOrderLines() { return ok(fixture('order')); } },
    cartClient: { async fetchCart() { state.reads++; return ok(rawCart(state.quantity)); }, async fetchProductForm() { return ok(productForm()); },
      async fetchCartControls() { return ok(cartControls()); }, async submitCartMutation(action, params, method) {
        state.writes++; state.quantity = method === 'POST' ? state.quantity + Number(params.get('quantity')) : action.includes('Remove') ? 0 : Number(params.get('quantity')); return ok({});
      } },
  });
  return { state, services };
}
export async function connect(t: TestContext, services: ShoppingServices) {
  const application = createShoppingApplication({ version: 'test', services });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'service-contract-test', version: '1' });
  await application.connect(serverTransport); await client.connect(clientTransport);
  t.after(async () => { await client.close(); await application.close(); });
  return { client, application };
}
