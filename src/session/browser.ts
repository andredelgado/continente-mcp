import type { Browser, BrowserContext, Page } from 'playwright';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { CookieStore } from '../stores/files.js';
import type { Clock, Logger, SessionService } from '../ports.js';
import type { BrowserStatus } from '../domain/index.js';
import { createSerialTaskQueue } from './queue.js';
import { installCheckoutBoundary } from './checkout-boundary.js';
import { safeLoginMessage } from './login-errors.js';
import { checkRequest, currentRequest, inRequest, RequestScope, acquireResource, requestIO } from './request.js';

export type BrowserLauncher = (options: { headless: boolean; chromiumSandbox?: boolean }) => Promise<Browser>;

/** A desktop Chrome user agent matching the launched Chromium, without the "HeadlessChrome" marker. */
export function browserUserAgent(version: string, platform: string = process.platform): string {
  const os = platform === 'win32' ? 'Windows NT 10.0; Win64; x64' : platform === 'linux' ? 'X11; Linux x86_64' : 'Macintosh; Intel Mac OS X 10_15_7';
  const major = /^\d+/.exec(version)?.[0] ?? '140';
  return `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

export const DEFAULT_IDLE_CLOSE_MS = 5 * 60 * 1000;

export interface BrowserLease { page: Page; context: BrowserContext; }
export class SessionAccountMismatch extends Error {
  constructor() { super('The saved session does not match the configured account'); this.name = 'SessionAccountMismatch'; }
}
export interface StorefrontSession extends SessionService {
  ensureReady(): Promise<BrowserLease>;
  invalidate?(lease: BrowserLease): Promise<void>;
  recordAuthentication?(authenticated: boolean): void;
}
export interface BrowserSessionOptions {
  credentials?: BrowserStatus['credentials'];
  clock?: Clock;
  /** Close the browser after this many idle milliseconds. Zero disables automatic closing. */
  idleCloseMs?: number;
  /** Verify the saved browser context against the configured retailer account before exposing it. */
  verifyRestoredAccount?: (page: Page) => Promise<boolean>;
}

export class BrowserSession implements StorefrontSession {
  private readonly queue = createSerialTaskQueue();
  private readonly owner = new AsyncLocalStorage<boolean>();
  private preparing: Promise<BrowserLease> | undefined;
  private active: RequestScope | undefined;
  private shutdownPromise: Promise<void> | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private browser: Browser | undefined;
  private context: BrowserContext | undefined;
  private page: Page | undefined;
  private loadedRevision: number | null = null;
  private verifiedAccountContext: BrowserContext | null = null;
  private pendingAccountVerification = false;
  private authentication: BrowserStatus['authentication'] = { state: 'unknown', checkedAt: null };
  private authenticationRevision: number | null = null;

  constructor(private readonly launch: BrowserLauncher, private readonly cookies: CookieStore,
    private readonly login: () => Promise<boolean>, private readonly logger: Logger,
    private readonly options: BrowserSessionOptions = {}) {}

  /** Nested calls from an owned operation run inline; all other callers join the serial queue. */
  run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.owner.getStore()) { checkRequest(); return operation(); }
    const existing = currentRequest();
    const scope = existing ?? new RequestScope();
    return inRequest(scope, () => this.queue(async () => {
      this.active = scope;
      clearTimeout(this.idleTimer);
      try { return await this.owner.run(true, operation); }
      finally { this.active = undefined; this.scheduleIdleClose(); }
    })).finally(() => { if (!existing) scope.dispose(); });
  }

  private scheduleIdleClose(): void {
    const delay = this.options.idleCloseMs ?? DEFAULT_IDLE_CLOSE_MS;
    if (!delay || !this.browser || this.shutdownPromise) return;
    this.idleTimer = setTimeout(() => {
      void this.run(() => this.closeOwnedResources()).catch(() => {});
    }, delay);
    this.idleTimer.unref?.();
  }

  recordAuthentication(authenticated: boolean): void {
    this.authenticationRevision = this.loadedRevision;
    this.authentication = { state: authenticated ? 'authenticated' : 'unauthenticated', checkedAt: (this.options.clock?.now() ?? new Date()).toISOString() };
  }

  async getStatus(): Promise<BrowserStatus> {
    let savedCookies: BrowserStatus['savedCookies'] = 'unavailable';
    let authentication = this.authentication;
    try {
      const revision = await this.cookies.revision();
      savedCookies = revision === null ? 'missing' : (await this.cookies.load()).ok ? 'available' : 'unavailable';
      if (revision !== this.authenticationRevision || savedCookies === 'unavailable') authentication = { state: 'unknown', checkedAt: null };
    } catch { authentication = { state: 'unknown', checkedAt: null }; }
    return { browser: this.preparing ? 'starting' : this.context && this.page && !this.page.isClosed() ? 'ready' : 'closed',
      credentials: this.options.credentials ?? { hasEmail: null, hasPassword: null }, savedCookies, authentication };
  }

  async refreshAuthentication(): Promise<boolean> {
    return this.run(async () => {
      await this.closeOwnedResources();
      this.authentication = { state: 'unknown', checkedAt: null };
      try {
        const authenticated = await this.login();
        if (authenticated) { this.recordAuthentication(true); this.authenticationRevision = await this.cookies.revision(); }
        return authenticated;
      } catch (error) { this.logger(safeLoginMessage(error)); return false; }
    });
  }

  async ensureReady(): Promise<BrowserLease> {
    return this.run(async () => {
      this.preparing ??= this.prepare().catch(async error => { await this.closeOwnedResources(); throw error; });
      try { return await this.preparing; } finally { this.preparing = undefined; }
    });
  }

  private async prepare(): Promise<BrowserLease> {
    const revision = await this.cookies.revision();
    if (this.context && revision !== this.loadedRevision) await this.closeContext();
    if (!this.browser) {
      const launched = await acquireResource(() => this.launch({ headless: true, chromiumSandbox: true }), browser => browser.close());
      launched.on('disconnected', () => {
        if (this.browser === launched) { this.browser = undefined; this.context = undefined; this.page = undefined; this.loadedRevision = null; }
      });
      this.browser = launched;
    }
    if (!this.context) {
      const browser = this.browser;
      this.context = await acquireResource(() => browser.newContext({ userAgent: browserUserAgent(browser.version()), locale: 'pt-PT', serviceWorkers: 'block' }), context => context.close());
      await installCheckoutBoundary(this.context);
      this.pendingAccountVerification = false;
      if (revision !== null) {
        const cached = await this.cookies.load();
        const restored = cached.ok && await this.context.addCookies(cached.value).then(() => true, () => false);
        if (!restored) this.logger('The saved session could not be restored; run `continentept-mcp login` to replace it.');
        else if (cached.ok && cached.value.length > 0) this.pendingAccountVerification = true;
      }
      this.loadedRevision = revision;
    }
    if (!this.page || this.page.isClosed()) this.page = await acquireResource(() => this.context!.newPage(), page => page.close());
    if (revision !== null && this.verifiedAccountContext !== this.context) {
      if (this.pendingAccountVerification) {
        if (!this.options.verifyRestoredAccount || !(await requestIO(
          () => this.options.verifyRestoredAccount!(this.page!), () => this.closeContext()))) {
          this.recordAuthentication(false);
          throw new SessionAccountMismatch();
        }
      }
      this.pendingAccountVerification = false;
      this.verifiedAccountContext = this.context;
    }
    checkRequest();
    return { page: this.page, context: this.context };
  }

  private async closeContext(): Promise<void> {
    const page = this.page; const context = this.context;
    this.page = undefined; this.context = undefined; this.loadedRevision = null; this.verifiedAccountContext = null; this.pendingAccountVerification = false;
    await page?.close().catch(() => {});
    await context?.close().catch(() => {});
  }

  async invalidate(lease: BrowserLease): Promise<void> {
    if (this.context === lease.context) await this.closeContext();
  }

  private async closeOwnedResources(): Promise<void> {
    await this.closeContext();
    const browser = this.browser; this.browser = undefined;
    await browser?.close().catch(() => {});
  }

  /** Release browser resources. Saved cookies are kept, and a later call reopens the browser. */
  async closeBrowserSession(): Promise<void> { await this.run(() => this.closeOwnedResources()); }

  /** Permanently stop: reject new work, cancel the active request, drain the queue, then close. */
  shutdown(): Promise<void> {
    if (!this.shutdownPromise) {
      clearTimeout(this.idleTimer);
      const drained = this.queue.shutdown();
      this.active?.cancel('server_closed');
      this.shutdownPromise = drained.then(() => this.closeOwnedResources());
    }
    return this.shutdownPromise;
  }
}
