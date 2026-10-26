import assert from 'node:assert/strict';
import test from 'node:test';
import type { BrowserLauncher } from '../src/session/browser.js';
import type { CookieStore } from '../src/stores/files.js';
import { AuthenticationClient } from '../src/clients/authentication.js';
import { BrowserSession } from '../src/session/browser.js';
import { HumanVerificationRequired } from '../src/session/login-errors.js';
import { checkRequest, inRequest, RequestScope } from '../src/session/request.js';
import { SignInWindow, canShowSignInWindow } from '../src/session/sign-in-window.js';
import { double, textOf, toolError } from '../test-support/assertions.js';
import { fail } from '../test-support/helpers.js';
import { connect, injectedServices } from '../test-support/mcp-fixture.js';

const credentials = { email: 'test@example.invalid', password: 'synthetic' };

/** A login page that shows the robot check after the email. The password step appears once `tick()` is called. */
function robotCheckLogin(options: { showBrowser?: boolean } = {}) {
  const events: string[] = []; let tick = () => {};
  const ticked = new Promise<void>(resolve => { tick = () => { events.push('ticked'); resolve(); }; });
  const frame = { url: () => 'https://login.continente.pt/user-register/', locator(selector: string) {
    if (selector.startsWith('button')) return { first: () => ({ async count() { return 1; }, async click() { events.push('submit'); } }) };
    const locator = { async fill(value: string) { events.push(`fill ${selector} ${value === credentials.password ? '<password>' : value}`); }, async press() {},
      first: () => locator, waitFor: () => selector.includes('altcha') ? Promise.resolve() : ticked };
    return locator;
  } };
  const page = { async goto() { return null; }, getByRole: () => ({ async click() {} }), frames: () => [frame], async waitForURL() {} };
  const context = { async newPage() { return page; }, async cookies() { return [{ name: 's', value: 'v', domain: '.continente.pt', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' }]; },
    request: { async get() { return { ok: () => true, status: () => 200, async json() { return { resources: { customerAuthenticated: true } }; } }; } } };
  const launch = async (launchOptions: { headless: boolean }) => { events.push(`launch headless=${launchOptions.headless}`);
    return { version: () => '140.0.0.0', async newContext() { return context; }, async close() { events.push('close'); } }; };
  const logs: string[] = [];
  const auth = new AuthenticationClient(double<BrowserLauncher>(launch), double<CookieStore>({ async save() { events.push('save'); } }), credentials,
    message => logs.push(message), { ...options, verificationTimeoutMs: 1000 });
  return { auth, events, logs, tick };
}

test('an unattended sign-in stops at the robot check, never ticking it or typing the password', async () => {
  const { auth, events } = robotCheckLogin();
  const error = await auth.loginWithCredentials().catch((caught: unknown) => caught);
  assert.ok(error instanceof HumanVerificationRequired);
  assert.match(error.message, /confirm you are not a robot.*login --show-browser.*Não sou um robô/);
  assert.deepEqual(events, ['launch headless=true', 'fill #userNameCC test@example.invalid', 'submit', 'close']);
});

test('a visible sign-in waits for the person to tick the robot check, then finishes by itself', async () => {
  const { auth, events, logs, tick } = robotCheckLogin({ showBrowser: true });
  const signedIn = auth.loginWithCredentials();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(logs.some(line => /tick "Não sou um robô" in the browser window/.test(line)));
  assert.ok(!events.some(event => event.includes('<password>')), 'the password waits for the person');
  tick();
  assert.equal(await signedIn, true);
  assert.deepEqual(events.slice(-5), ['ticked', 'fill #password_input <password>', 'submit', 'save', 'close']);
});

test('a sign-in window is shown only where a person can see it, and can be turned off', () => {
  assert.equal(canShowSignInWindow({}, 'darwin'), true);
  assert.equal(canShowSignInWindow({}, 'win32'), true);
  assert.equal(canShowSignInWindow({}, 'linux'), false);
  assert.equal(canShowSignInWindow({ DISPLAY: ':0' }, 'linux'), true);
  assert.equal(canShowSignInWindow({ WAYLAND_DISPLAY: 'wayland-0' }, 'linux'), true);
  assert.equal(canShowSignInWindow({ CONTINENTE_SIGN_IN_WINDOW: '0' }, 'darwin'), false);
});

test('one sign-in window at a time, kept open after the tool request that opened it ends', async () => {
  let finish = (_signedIn: boolean) => {}; let opened = 0;
  const window = new SignInWindow(() => { opened++; return new Promise<boolean>(resolve => { finish = value => { checkRequest(); resolve(value); }; }); }, () => true, () => {});
  const scope = new RequestScope({ timeoutMs: 1000 });
  assert.equal(await inRequest(scope, async () => window.start()), 'opened');
  scope.cancel('cancelled'); scope.dispose();
  assert.equal(window.start(), 'already_open');
  assert.equal(window.open, true);
  finish(true); await window.settled();
  assert.equal(window.open, false);
  assert.equal(opened, 1);
  assert.equal(new SignInWindow(async () => true, () => false, () => {}).start(), 'not_available');
});

test('after the robot check, the session opens a window instead of retrying unattended, until the person signs in', async () => {
  let now = Date.parse('2026-10-26T12:00:00Z'); let logins = 0; let windows = 0; let finish = () => {};
  const window = new SignInWindow(() => { windows++; return new Promise<boolean>(resolve => { finish = () => resolve(false); }); }, () => true, () => {});
  const session = new BrowserSession(double<BrowserLauncher>(async () => { throw new Error('no browser'); }), double<CookieStore>({ async revision() { return null; } }),
    async () => { logins++; throw new HumanVerificationRequired(); }, () => {}, { clock: { now: () => new Date(now) }, signInWindow: window });
  assert.equal(await session.refreshAuthentication(), false);
  assert.deepEqual([logins, windows, session.signInPrompt()], [1, 1, 'opened']);
  assert.equal(await session.refreshAuthentication(), false);
  assert.deepEqual([logins, windows, session.signInPrompt()], [1, 1, 'already_open']);
  finish(); await window.settled();
  // The window closed without a sign-in: the next request opens a new one rather than meeting the check again.
  assert.equal(await session.refreshAuthentication(), false);
  assert.deepEqual([logins, windows, session.signInPrompt()], [1, 2, 'opened']);
  finish(); await window.settled();
  session.recordAuthentication(true);
  assert.equal(session.signInPrompt(), null);
  now += 11 * 60 * 1000;
  assert.equal(await session.refreshAuthentication(), false);
  assert.equal(logins, 2);
  finish(); await window.settled();
});

test('tools say a sign-in window opened, or how to sign in when none can be shown', async t => {
  const { services } = injectedServices();
  services.cart.getCart = async () => fail('not_authenticated');
  services.session.getStatus = async () => ({ browser: 'closed', credentials: { hasEmail: true, hasPassword: true }, savedCookies: 'available', authentication: { state: 'unauthenticated', checkedAt: null } });
  let prompt: 'opened' | 'already_open' | 'not_available' | null = 'opened';
  services.session.signInPrompt = () => prompt;
  const { client } = await connect(t, services);
  const signInOf = (result: unknown) => (result as { structuredContent: { result: { signIn: { action: string; signInWindow: string | null } } } }).structuredContent.result.signIn;
  let result = await client.callTool({ name: 'get_cart', arguments: {} });
  assert.equal(toolError(result).code, 'not_authenticated');
  assert.match(textOf(result), /sign-in window has opened on this computer: tick "Não sou um robô" and press "Avançar"/);
  assert.deepEqual([signInOf(result).action, signInOf(result).signInWindow], ['confirm_not_a_robot', 'opened']);
  prompt = 'not_available';
  result = await client.callTool({ name: 'get_cart', arguments: {} });
  assert.match(textOf(result), /no window can be shown here\. Run `continentept-mcp login --show-browser`/);
  prompt = null;
  result = await client.callTool({ name: 'get_cart', arguments: {} });
  assert.deepEqual([signInOf(result).action, signInOf(result).signInWindow], ['check_credentials_or_sign_in', null]);
});

