import { createApplication } from './application.js';
import { favoritesScope, loadSettings, sessionAccountIdentity } from './config.js';
import type { Environment } from './config.js';
import type { Clock, Logger, FavoritesStore, CatalogGateway, FavoritesGateway, CartGateway, OrdersGateway, CouponGateway, CouponSelectionGateway, PickupSlotGateway, PickupStoreGateway, PickupStoreSelectionGateway } from './ports.js';
import { FileCookieStore, FileFavoritesStore } from './stores/files.js';
import type { CookieStore } from './stores/files.js';
import { BrowserSession } from './session/browser.js';
import type { BrowserLauncher, StorefrontSession } from './session/browser.js';
import { BrowserUnavailable, ChromiumInstaller, runChromiumInstall } from './session/chromium.js';
import { AuthenticationClient } from './clients/authentication.js';
import { StorefrontClient, CatalogClient, FavoritesClient, CartClient, OrdersClient } from './clients/storefront.js';
import { CartCouponSelectionClient, CouponsClient } from './clients/coupons.js';
import { PickupSlotsClient, PickupStoresClient, PickupStoreSelectionClient } from './clients/stores.js';
import { CatalogService, FavoritesService } from './services/catalog.js';
import { CartService } from './services/cart.js';
import { OrderService, PurchaseHistoryService, SettledOrders } from './services/orders.js';
import { productPicker, registerShoppingTools } from './mcp/shopping.js';
import type { ShoppingServices } from './mcp/shopping.js';
import { SERVER_INSTRUCTIONS, basketPlannerPrompt } from './mcp/guide.js';
import { updateNotice } from './services/updates.js';
import type { UpdateStatus } from './domain/index.js';

export const systemClock: Clock = { now: () => new Date() };
const chromiumInstaller = new ChromiumInstaller(async () => {
  // Skip per-percent progress lines; keep the start, finish and any errors.
  const code = await runChromiumInstall([], line => { if (!line.includes('%')) console.error(`[chromium] ${line}`); });
  if (code !== 0) throw new Error(`Chromium download exited with code ${code}`);
}, message => console.error(message));
/** Launch Playwright's Chromium, downloading it first if this machine does not have it yet. */
export const launchBrowser: BrowserLauncher = chromiumInstaller.launcher(async options => {
  try { return await (await import('playwright')).chromium.launch(options); }
  catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (/sandbox|user namespace|operation not permitted/i.test(message)) {
      throw new BrowserUnavailable({ code: 'browser_unavailable', retryable: false,
        message: 'Chromium sandboxing is required but this host cannot start it. Enable Chromium sandbox support on the host before using this server.' });
    }
    throw error;
  }
});
export interface RuntimeOptions {
  env?: Environment; clock?: Clock; logger?: Logger; launch?: BrowserLauncher;
  cookies?: CookieStore; favoritesStore?: FavoritesStore; session?: StorefrontSession;
  catalogClient?: CatalogGateway; favoritesClient?: FavoritesGateway; cartClient?: CartGateway; ordersClient?: OrdersGateway;
  couponClient?: CouponGateway; couponSelectionClient?: CouponSelectionGateway; pickupStoreClient?: PickupStoreGateway; pickupSlotClient?: PickupSlotGateway; pickupStoreSelectionClient?: PickupStoreSelectionGateway;
}
/** Build the shopping services. Nothing is read or launched until this is called. */
export function createShoppingServices(options: RuntimeOptions = {}): ShoppingServices {
  const settings = loadSettings(options.env ?? process.env);
  const logger = options.logger ?? ((message: string) => console.error(message));
  const clock = options.clock ?? systemClock;
  const launch = options.launch ?? launchBrowser;
  const scope = () => favoritesScope(settings);
  const cookies = options.cookies ?? new FileCookieStore(settings.cookieFile, sessionAccountIdentity(settings));
  const store = options.favoritesStore ?? new FileFavoritesStore(settings.favoritesFile, scope);
  const auth = new AuthenticationClient(launch, cookies, settings, logger);
  const session = options.session ?? new BrowserSession(launch, cookies, () => auth.loginWithCredentials(), logger, {
    credentials: { hasEmail: settings.email !== '', hasPassword: settings.password !== '' }, clock,
    verifyRestoredAccount: page => auth.verifyAccount(page),
    ...(settings.browserIdleMs !== undefined ? { idleCloseMs: settings.browserIdleMs } : {}),
  });
  const site = new StorefrontClient(session);
  const favorites = new FavoritesService(options.favoritesClient ?? new FavoritesClient(site), store, clock, scope, logger);
  const ordersClient = options.ordersClient ?? new OrdersClient(site);
  const settled = new SettledOrders(clock, scope);
  return { session, favorites, clock, catalog: new CatalogService(options.catalogClient ?? new CatalogClient(site), favorites),
    cart: new CartService(options.cartClient ?? new CartClient(site)), orders: new OrderService(ordersClient, settled),
    history: new PurchaseHistoryService(ordersClient, settled), coupons: options.couponClient ?? new CouponsClient(site),
    couponSelection: options.couponSelectionClient ?? new CartCouponSelectionClient(site),
    pickupStores: options.pickupStoreClient ?? new PickupStoresClient(site),
    pickupSlots: options.pickupSlotClient ?? new PickupSlotsClient(site, clock),
    pickupStoreSelection: options.pickupStoreSelectionClient ?? new PickupStoreSelectionClient(site, clock) };

}
export function createShoppingApplication(options: RuntimeOptions & { version: string; services?: ShoppingServices; update?: UpdateStatus }) {
  const services = options.services ?? createShoppingServices(options);
  const notice = options.update ? updateNotice(options.update) : null;
  return createApplication({ version: options.version, tools: registerShoppingTools(services, options.update),
    prompts: [basketPlannerPrompt], resources: [productPicker], instructions: notice ? `${SERVER_INSTRUCTIONS}\n\n${notice}` : SERVER_INSTRUCTIONS,
    closeResources: () => services.session.shutdown?.() ?? services.session.run(() => services.session.closeBrowserSession()) });
}
