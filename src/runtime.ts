import { createApplication } from './application.js';
import { favoritesScope, loadSettings } from './config.js';
import type { Environment } from './config.js';
import type { Clock, Logger, FavoritesStore, CatalogGateway, FavoritesGateway, CartGateway, OrdersGateway } from './ports.js';
import { FileCookieStore, FileFavoritesStore } from './stores/files.js';
import type { CookieStore } from './stores/files.js';
import { BrowserSession } from './session/browser.js';
import { SignInWindow, canShowSignInWindow } from './session/sign-in-window.js';
import type { BrowserLauncher, StorefrontSession } from './session/browser.js';
import { ChromiumInstaller, runChromiumInstall } from './session/chromium.js';
import { AuthenticationClient } from './clients/authentication.js';
import { StorefrontClient, CatalogClient, FavoritesClient, CartClient, OrdersClient } from './clients/storefront.js';
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
export const launchBrowser: BrowserLauncher = chromiumInstaller.launcher(async options => (await import('playwright')).chromium.launch(options));
export interface RuntimeOptions {
  env?: Environment; clock?: Clock; logger?: Logger; launch?: BrowserLauncher;
  cookies?: CookieStore; favoritesStore?: FavoritesStore; session?: StorefrontSession;
  catalogClient?: CatalogGateway; favoritesClient?: FavoritesGateway; cartClient?: CartGateway; ordersClient?: OrdersGateway;
}
/** Build the shopping services. Nothing is read or launched until this is called. */
export function createShoppingServices(options: RuntimeOptions = {}): ShoppingServices {
  const settings = loadSettings(options.env ?? process.env);
  const logger = options.logger ?? ((message: string) => console.error(message));
  const clock = options.clock ?? systemClock;
  const launch = options.launch ?? launchBrowser;
  const scope = () => favoritesScope(settings);
  const cookies = options.cookies ?? new FileCookieStore(settings.cookieFile);
  const store = options.favoritesStore ?? new FileFavoritesStore(settings.favoritesFile, scope);
  const auth = new AuthenticationClient(launch, cookies, settings, logger);
  // When Continente asks to confirm the person is not a robot, they finish the sign-in in a visible window.
  const signInWindow = new SignInWindow(() => new AuthenticationClient(launch, cookies, settings, logger, { showBrowser: true }).loginWithCredentials(),
    () => canShowSignInWindow(options.env ?? process.env), logger);
  const session = options.session ?? new BrowserSession(launch, cookies, () => auth.loginWithCredentials(), logger, {
    credentials: { hasEmail: settings.email !== '', hasPassword: settings.password !== '' }, clock, signInWindow,
    ...(settings.browserIdleMs !== undefined ? { idleCloseMs: settings.browserIdleMs } : {}),
  });
  const site = new StorefrontClient(session);
  const favorites = new FavoritesService(options.favoritesClient ?? new FavoritesClient(site), store, clock, scope, logger);
  const ordersClient = options.ordersClient ?? new OrdersClient(site);
  const settled = new SettledOrders(clock, scope);
  return { session, favorites, clock, catalog: new CatalogService(options.catalogClient ?? new CatalogClient(site), favorites),
    cart: new CartService(options.cartClient ?? new CartClient(site)), orders: new OrderService(ordersClient, settled),
    history: new PurchaseHistoryService(ordersClient, settled) };
}
export function createShoppingApplication(options: RuntimeOptions & { version: string; services?: ShoppingServices; update?: UpdateStatus }) {
  const services = options.services ?? createShoppingServices(options);
  const notice = options.update ? updateNotice(options.update) : null;
  return createApplication({ version: options.version, tools: registerShoppingTools(services, options.update),
    prompts: [basketPlannerPrompt], resources: [productPicker], instructions: notice ? `${SERVER_INSTRUCTIONS}\n\n${notice}` : SERVER_INSTRUCTIONS,
    closeResources: () => services.session.shutdown?.() ?? services.session.run(() => services.session.closeBrowserSession()) });
}
