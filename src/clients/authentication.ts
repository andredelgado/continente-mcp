import type { Browser, BrowserContext, Frame, Page } from 'playwright';
import type { Logger } from '../ports.js';
import type { CookieStore } from '../stores/files.js';
import { SessionCookiesSchema } from '../stores/files.js';
import type { BrowserLauncher } from '../session/browser.js';
import { browserUserAgent } from '../session/browser.js';
import { field } from '../parsers/records.js';
import { STOREFRONT_ORIGIN } from '../parsers/catalog.js';
import { isLoginUrl, responseStatus } from './policy.js';
import { CART_SUMMARY_URL } from './storefront.js';
import { requestIO, acquireResource, checkRequest, requestTimeout } from '../session/request.js';
import { HumanVerificationRequired, LoginFailed, loginFailure } from '../session/login-errors.js';

const LOGIN_ORIGIN = 'https://login.continente.pt';
const EMAIL_INPUT = '#userNameCC';
const PASSWORD_INPUT = '#password_input';
/** The "Não sou um robô" check (ALTCHA) Continente can show between the email and the password. */
const ROBOT_CHECK = 'input[id^="altcha_checkbox"], altcha-widget';
const VERIFICATION_TIMEOUT_MS = 5 * 60 * 1000;
const CONSENT_BUTTON = /^permitir todos$/i;

export interface Credentials { readonly email: string; readonly password: string; }
export interface LoginOptions {
  readonly showBrowser?: boolean;
  /** How long a visible sign-in waits for the person to confirm they are not a robot. */
  readonly verificationTimeoutMs?: number;
}

/** Signs in through the website's login form and saves the resulting session cookies. */
export class AuthenticationClient {
  constructor(private readonly launch: BrowserLauncher, private readonly cookies: CookieStore,
    private readonly credentials: Credentials, private readonly logger: Logger, private readonly options: LoginOptions = {}) {}

  /** Ask the storefront whether this browser context belongs to a signed-in customer. */
  async isSignedIn(context: BrowserContext): Promise<boolean> {
    const response = await context.request.get(CART_SUMMARY_URL, { headers: { 'X-Requested-With': 'XMLHttpRequest' }, timeout: 10000 });
    if (!responseStatus(response, response.url?.() ?? CART_SUMMARY_URL).ok) return false;
    const body: unknown = await response.json().catch(() => null);
    return field(body, 'resources', 'customerAuthenticated') === true;
  }

  /** The login form is served in a frame from the login origin; wait for it to load. */
  async loginFrame(page: Page): Promise<Frame> {
    const fromLoginOrigin = (frame: Frame) => {
      try { return new URL(frame.url()).origin === LOGIN_ORIGIN; } catch { return false; }
    };
    return page.frames().find(fromLoginOrigin) ?? page.waitForEvent('framenavigated', { predicate: fromLoginOrigin, timeout: 15000 });
  }

  /** After the email: the password field, or the robot check. Neither within the time counts as the password step, whose fill then times out. */
  private async passwordOrRobotCheck(frame: Frame): Promise<'password' | 'robot_check'> {
    const visible = <T>(selector: string, step: T) => frame.locator(selector).first().waitFor({ state: 'visible', timeout: requestTimeout(20000) }).then(() => step);
    return Promise.any([visible(PASSWORD_INPUT, 'password' as const), visible(ROBOT_CHECK, 'robot_check' as const)]).catch(() => 'password' as const);
  }

  private async submit(frame: Frame, input: string, value: string): Promise<void> {
    checkRequest();
    const field = frame.locator(input);
    await field.fill(value, { timeout: 15000 });
    const button = frame.locator('button[type="submit"]:visible').first();
    if (await button.count()) await button.click(); else await field.press('Enter');
  }

  async loginWithCredentials(): Promise<boolean> {
    const { email, password } = this.credentials;
    if (!email || !password) {
      this.logger('Login skipped: CONTINENTE_EMAIL and CONTINENTE_PASSWORD are required.');
      return false;
    }
    let step = 'starting the browser';
    let browser: Browser | undefined;
    let closing: Promise<void> | undefined;
    const close = () => closing ??= browser?.close() ?? Promise.resolve();
    try {
      const launched = browser = await acquireResource(() => this.launch({ headless: !this.options.showBrowser }), opened => opened.close());
      return await requestIO(async () => {
        const context = await acquireResource(() => launched.newContext({ userAgent: browserUserAgent(launched.version()), locale: 'pt-PT' }), context => context.close());
        const page = await acquireResource(() => context.newPage(), page => page.close());
        this.logger('Signing in.');
        step = 'opening the login page';
        await page.goto(`${STOREFRONT_ORIGIN}/login/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.getByRole('button', { name: CONSENT_BUTTON }).click({ timeout: 5000 }).catch(() => {});
        const frame = await this.loginFrame(page);
        step = 'entering the email';
        await this.submit(frame, EMAIL_INPUT, email);
        step = 'waiting for the password step';
        if (await this.passwordOrRobotCheck(frame) === 'robot_check') {
          // Never answered by the server: a person ticks it in a visible window, or the sign-in stops.
          if (!this.options.showBrowser) throw new HumanVerificationRequired();
          this.logger('Continente asks you to confirm you are not a robot: tick "Não sou um robô" in the browser window, then press "Avançar".');
          step = 'waiting for you to confirm you are not a robot';
          await frame.locator(PASSWORD_INPUT).first().waitFor({ state: 'visible', timeout: requestTimeout(this.options.verificationTimeoutMs ?? VERIFICATION_TIMEOUT_MS) });
        }
        const leftLogin = page.waitForURL(url => url.origin === STOREFRONT_ORIGIN && !isLoginUrl(url.href), { timeout: 20000 }).catch(() => {});
        step = 'entering the password';
        await this.submit(frame, PASSWORD_INPUT, password);
        await leftLogin;
        checkRequest();
        step = 'checking the new session';
        if (!(await this.isSignedIn(context))) throw new LoginFailed('Sign-in failed: the website did not accept the login.');
        step = 'saving the session';
        const cookies = SessionCookiesSchema.safeParse(await context.cookies());
        if (!cookies.success) throw new LoginFailed('Sign-in failed: the website returned an unexpected session.');
        await this.cookies.save(cookies.data);
        this.logger('Signed in; session saved.');
        return true;
      }, close);
    } catch (error) {
      // Playwright messages from these steps can contain the typed password or Cookie headers.
      throw loginFailure(step, error);
    } finally { await close(); }
  }
}
