import type { BrowserLauncher } from '../src/session/browser.js';
import type { CookieStore } from '../src/stores/files.js';
import { AuthenticationClient } from '../src/clients/authentication.js';
import { BrowserSession } from '../src/session/browser.js';
import { BrowserUnavailable } from '../src/session/chromium.js';
import { LoginFailed, loginFailure, safeLoginMessage } from '../src/session/login-errors.js';
import { RequestStopped } from '../src/session/request.js';
import { double } from '../test-support/assertions.js';

import assert from 'node:assert/strict';
import test from 'node:test';

// Fake secrets only. The error texts copy the shape of Playwright 1.59.1 call logs.
const credentials = { email: 'fake-user@example.invalid', password: 'FAKE-PASSWORD-7c41' };
const COOKIE = 'FAKE-COOKIE-9e2a';
function playwrightError(log: string, name = 'TimeoutError') {
  const error = new Error(`locator.fill: Timeout 15000ms exceeded.\nCall log:\n  - waiting for locator('#password_input')\n${log}`);
  error.name = name;
  return error;
}
function assertNoSecrets(text: string) {
  for (const secret of [credentials.password, credentials.email, COOKIE]) assert.ok(!text.includes(secret), `leaked ${secret}: ${text}`);
}

function loginClient(failures: { fill?: string; request?: boolean }) {
  const frame = { url: () => 'https://login.continente.pt/user-register/', locator(selector: string) {
    if (selector.startsWith('button')) return { first: () => ({ async count() { return 1; }, async click() {} }) };
    const field = { async fill(value: string) {
      if (selector === failures.fill) throw playwrightError(`    - fill("${value}")\n    - waiting for element to be visible, enabled and editable`);
    }, async press() {}, first: () => field, waitFor: () => selector.includes('altcha') ? new Promise<void>(() => {}) : Promise.resolve() };
    return field;
  } };
  const page = { async goto() { return null; }, getByRole: () => ({ async click() {} }), frames: () => [frame], async waitForURL() {} };
  const context = { async newPage() { return page; }, async cookies() { return []; }, request: { async get() {
    if (failures.request) throw playwrightError(`  - → GET https://www.continente.pt/Cart-MiniCartShow\n    - cookie: session=${COOKIE}\n  - ← 200 OK\n    - set-cookie: session=${COOKIE}; Path=/`, 'Error');
    return { ok: () => true, status: () => 200, async json() { return { resources: { customerAuthenticated: true } }; } };
  } } };
  let closes = 0;
  const launch = async () => ({ version: () => '140.0.0.0', async newContext() { return context; }, async close() { closes++; } });
  const logs: string[] = [];
  const auth = new AuthenticationClient(double<BrowserLauncher>(launch), double<CookieStore>({ async save() {} }), credentials, message => logs.push(message));
  return { auth, logs, closes: () => closes };
}

test('a failed password fill reports only the step, never the typed password', async () => {
  const { auth, logs, closes } = loginClient({ fill: '#password_input' });
  const error = await auth.loginWithCredentials().catch((caught: unknown) => caught);
  assert.ok(error instanceof LoginFailed);
  assert.equal(error.message, 'Sign-in failed while entering the password (timed out).');
  assertNoSecrets(error.message); assertNoSecrets(safeLoginMessage(error)); logs.forEach(assertNoSecrets);
  assert.equal(closes(), 1);
});

test('a failed email fill and a failed session check leak neither the email nor cookies', async () => {
  const email = await loginClient({ fill: '#userNameCC' }).auth.loginWithCredentials().catch((caught: unknown) => caught);
  assert.ok(email instanceof LoginFailed); assert.match(email.message, /entering the email/); assertNoSecrets(email.message);
  const check = await loginClient({ request: true }).auth.loginWithCredentials().catch((caught: unknown) => caught);
  assert.ok(check instanceof LoginFailed);
  assert.equal(check.message, 'Sign-in failed while checking the new session.');
  assertNoSecrets(check.message);
});

test('automatic sign-in recovery logs only safe text, even for unexpected errors', async () => {
  const logs: string[] = [];
  const raw = playwrightError(`    - fill("${credentials.password}")\n    - cookie: session=${COOKIE}`);
  const session = new BrowserSession(double<BrowserLauncher>(async () => { throw new Error('must not launch'); }),
    double<CookieStore>({ async revision() { return null; } }), async () => { throw raw; }, message => logs.push(message));
  assert.equal(await session.refreshAuthentication(), false);
  assert.deepEqual(logs, ['Sign-in failed with an unexpected error.']);
  await session.shutdown();
});

test('only messages written for logging pass through', () => {
  const raw = playwrightError(`    - fill("${credentials.password}")`);
  assert.equal(safeLoginMessage(raw), 'Sign-in failed with an unexpected error.');
  assert.equal(safeLoginMessage('string with FAKE-PASSWORD-7c41'), 'Sign-in failed with an unexpected error.');
  assert.equal(safeLoginMessage(new LoginFailed('Sign-in failed while opening the login page.')), 'Sign-in failed while opening the login page.');
  assert.equal(safeLoginMessage(new RequestStopped('deadline_exceeded')), 'Sign-in stopped (deadline_exceeded).');
  const browser = new BrowserUnavailable({ code: 'browser_unavailable', message: 'Chromium is being downloaded for first use (about 150 MB). Try again in a minute.', retryable: true });
  assert.equal(safeLoginMessage(browser), browser.message);
  assert.equal(loginFailure('entering the password', browser), browser);
  assert.equal(loginFailure('entering the password', raw).message, 'Sign-in failed while entering the password (timed out).');
});
