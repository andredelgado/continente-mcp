import type { Browser, BrowserContext, Page } from 'playwright';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { CookieStore } from '../stores/files.js';
import type { Clock, Logger, SessionService } from '../ports.js';
import type { BrowserStatus } from '../domain/index.js';
import { createSerialTaskQueue } from './queue.js';
import { HumanVerificationRequired, safeLoginMessage } from './login-errors.js';
import type { SignInWindow, SignInWindowState } from './sign-in-window.js';
import { checkRequest, currentRequest, inRequest, RequestScope, acquireResource } from './request.js';

export type BrowserLauncher = (options: { headless: boolean }) => Promise<Browser>;

/** A desktop Chrome user agent matching the launched Chromium, without the "HeadlessChrome" marker. */
export function browserUserAgent(version: string, platform: string = process.platform): string {
  const os = platform === 'win32' ? 'Windows NT 10.0; Win64; x64' : platform === 'linux' ? 'X11; Linux x86_64' : 'Macintosh; Intel Mac OS X 10_15_7';
  const major = /^\d+/.exec(version)?.[0] ?? '140';
  return `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

export const DEFAULT_IDLE_CLOSE_MS = 5 * 60 * 1000;

export interface BrowserLease { page: Page; context: BrowserContext; }
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
  /** Where the person signs in when Continente asks them to confirm they are not a robot. */
  signInWindow?: SignInWindow;
}
/** After the robot check stops an unattended sign-in, later ones would meet it too, so they are skipped for this long. */
const ROBOT_CHECK_PAUSE_MS = 10 * 60 * 1000;

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
  private authentication: BrowserStatus['authentication'] = { state: 'unknown', checkedAt: null };
  private signInNeeded: SignInWindowState | null = null;
  private robotCheckUntil = 0;
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
    if (authenticated) { this.signInNeeded = null; this.robotCheckUntil = 0; }
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

  /** Whether the last sign-in needed the person (the robot check), and what was done about it. */
  signInPrompt(): SignInWindowState | null { return this.signInNeeded; }

  async refreshAuthentication(): Promise<boolean> {
    // While the person signs in in a window, or soon after the robot check stopped an unattended
    // sign-in, another unattended attempt would only meet the same check.
    if (this.options.signInWindow?.open) { this.signInNeeded = 'already_open'; return false; }
    if (this.now() < this.robotCheckUntil) { this.signInNeeded = this.options.signInWindow?.start() ?? 'not_available'; return false; }
    return this.run(async () => {
      await this.closeOwnedResources();
      this.authentication = { state: 'unknown', checkedAt: null };
      try {
        const authenticated = await this.login();
        if (authenticated) { this.recordAuthentication(true); this.authenticationRevision = await this.cookies.revision(); }
        return authenticated;
      } catch (error) {
        if (error instanceof HumanVerificationRequired) {
          this.robotCheckUntil = this.now() + ROBOT_CHECK_PAUSE_MS;
          this.signInNeeded = this.options.signInWindow?.start() ?? 'not_available';
          // The terminal command in the error is only the way forward when no window could open.
          if (this.signInNeeded !== 'not_available') { this.logger('Continente asks you to confirm you are not a robot; finish signing in in the window.'); return false; }
        }
        this.logger(safeLoginMessage(error)); return false;
      }
    });
  }
  private now(): number { return (this.options.clock?.now() ?? new Date()).getTime(); }

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
      const launched = await acquireResource(() => this.launch({ headless: true }), browser => browser.close());
      launched.on('disconnected', () => {
        if (this.browser === launched) { this.browser = undefined; this.context = undefined; this.page = undefined; this.loadedRevision = null; }
      });
      this.browser = launched;
    }
    if (!this.context) {
      const browser = this.browser;
      this.context = await acquireResource(() => browser.newContext({ userAgent: browserUserAgent(browser.version()), locale: 'pt-PT' }), context => context.close());
      if (revision !== null) {
        const cached = await this.cookies.load();
        const restored = cached.ok && await this.context.addCookies(cached.value).then(() => true, () => false);
        if (!restored) this.logger('The saved session could not be restored; run `continentept-mcp login` to replace it.');
      }
      this.loadedRevision = revision;
    }
    if (!this.page || this.page.isClosed()) this.page = await acquireResource(() => this.context!.newPage(), page => page.close());
    checkRequest();
    return { page: this.page, context: this.context };
  }

  private async closeContext(): Promise<void> {
    const page = this.page; const context = this.context;
    this.page = undefined; this.context = undefined; this.loadedRevision = null;
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
