import { present, valueOf, ok } from '../test-support/helpers.js';

import type { TestContext } from 'node:test';
import type { Page } from 'playwright';
import type { CookieStore } from '../src/stores/files.js';
import type { BrowserLauncher, StorefrontSession } from '../src/session/browser.js';
import { SessionAccountMismatch } from '../src/session/browser.js';
import { double } from '../test-support/assertions.js';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadSettings, readDotEnv, hasCredentials, sessionAccountIdentity } from '../src/config.js';
import { FileFavoritesStore, FileCookieStore } from '../src/stores/files.js';
import { BrowserSession } from '../src/session/browser.js';
import { createSerialTaskQueue } from '../src/session/queue.js';
import { AuthenticationClient } from '../src/clients/authentication.js';
import { StorefrontClient, CatalogClient } from '../src/clients/storefront.js';

import assert from 'node:assert/strict';
import test from 'node:test';

async function temporary(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'continente-fixture-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
test('settings read the private credentials file, and explicit environment values win', async t => {
  const root = await temporary(t);
  const dataDir = join(root, '.continentept-mcp'); await mkdir(dataDir);
  await writeFile(join(dataDir, 'credentials.env'), 'CONTINENTE_EMAIL=file@example.invalid\nCONTINENTE_PASSWORD=\'synthetic\'\nCONTINENTE_DATA_DIR=/ignored');
  const fromFile = loadSettings({ HOME: root });
  assert.equal(fromFile.email, 'file@example.invalid'); assert.equal(fromFile.password, 'synthetic'); assert.equal(hasCredentials(fromFile), true);
  assert.equal(fromFile.dataDir, dataDir); assert.equal(fromFile.cookieFile, join(dataDir, 'session.json'));
  assert.equal(fromFile.credentialsFile, join(dataDir, 'credentials.env'));
  const overridden = loadSettings({ USERPROFILE: root, CONTINENTE_EMAIL: '' });
  assert.equal(overridden.email, ''); assert.equal(hasCredentials(overridden), false);
  const elsewhere = join(root, 'elsewhere'); const custom = join(root, 'custom.env');
  await writeFile(custom, 'CONTINENTE_BROWSER_IDLE_SECONDS=0');
  const moved = loadSettings({ HOME: root, CONTINENTE_DATA_DIR: elsewhere, CONTINENTE_CREDENTIALS_FILE: custom });
  assert.equal(moved.favoritesFile, join(elsewhere, 'favorites.json')); assert.equal(moved.email, ''); assert.equal(moved.browserIdleMs, 0);
  assert.deepEqual(readDotEnv('# comment\nexport A="x y"\nB = 2\nlower=no\nnot an assignment'), { A: 'x y', B: '2' });
});
test('session identity binds the configured email without persisting a password verifier', () => {
  const identity = sessionAccountIdentity({ email: 'User@example.invalid' });
  assert.equal(identity.length, 64);
  assert.equal(identity, sessionAccountIdentity({ email: 'user@example.invalid' }));
  assert.notEqual(identity, sessionAccountIdentity({ email: 'other@example.invalid' }));
  assert.equal(identity.includes('user@example.invalid'), false);
});
test('private file stores reject unversioned data and validate cache/account scope', async t => {
  const root = await temporary(t); const file = join(root, 'state/favorites.json');
  const store = new FileFavoritesStore(file, 'account-a');
  assert.equal(valueOf((await store.load())), null);
  await mkdir(join(root, 'state'));
  await writeFile(file, JSON.stringify({ lastUpdated: '2026-10-14T12:00:00Z', favorites: [{ productId: 'leite-00123.html', name: 'Leite Meio Gordo', price: '1,29€', url: '/produto/leite-00123.html' }] }));
  assert.equal((await store.load()).ok, false); // Unscoped account ownership is unverified.
  const cache = { schemaVersion: 2 as const, accountScope: 'account-a', fetchedAt: '2026-10-14T12:00:00Z', favorites: [] };
  assert.equal((await store.save(cache)).ok, true);
  assert.deepEqual(JSON.parse(await readFile(`${file}.bak`, 'utf8')), cache);
  assert.equal((await new FileFavoritesStore(file, 'account-b').load()).ok, false);
  await store.save(cache); // Retain an account-scoped recovery snapshot.
  await writeFile(file, '{broken');
  assert.deepEqual(valueOf((await store.load())), cache);
  await writeFile(file, JSON.stringify({ ...cache, schemaVersion: 2 }));
  assert.deepEqual(valueOf((await store.load())), cache);
});
test('saved sessions are private files and malformed contents are rejected', async t => {
  const root = await temporary(t); const file = join(root, 'private/session.json');
  const store = new FileCookieStore(file, 'opaque-test-account');
  assert.equal(await store.revision(), null);
  const cookie = { name: 'session', value: 'synthetic', domain: '.continente.pt', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' as const };
  await store.save([cookie]);
  assert.deepEqual(valueOf((await store.load())), [cookie]); assert.notEqual(await store.revision(), null);
  await writeFile(file, JSON.stringify([{ ...cookie, sameSite: 'lax' }])); assert.equal((await store.load()).ok, false);
  await writeFile(file, '{broken'); assert.equal((await store.load()).ok, false);
  if (process.platform !== 'win32') {
    await store.save([]);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal((await stat(join(root, 'private'))).mode & 0o777, 0o700);
  }
});

function fakeBrowser() {
  const state = { launches: 0, contexts: 0, pages: 0, cookies: 0, closes: 0, disconnect: () => {} };
  const launch = async () => {
    state.launches++;
    return {
      on(event: string, callback: (browser: import('playwright').Browser) => void) { if (event === 'disconnected') state.disconnect = () => callback(double<import('playwright').Browser>({})); return double<import('playwright').Browser>({}); },
      version: () => '140.0.0.0', async newContext() {
        state.contexts++;
        return { async route() { return double<import('playwright').Disposable>({}); }, async addCookies() { state.cookies++; }, async close() {}, async newPage() {
          state.pages++; return { isClosed: () => false, async close() {} };
        } };
      },
      async close() { state.closes++; },
    };
  };
  return { state, launch };
}
test('browser session is lazy, reloads cookies on revision changes, and reopens after close', async () => {
  const { state, launch } = fakeBrowser(); let revision = 1;
  const cookies = { async revision() { return revision; }, async load() { return ok([]); } };
  const session = new BrowserSession(double<BrowserLauncher>(launch), double<CookieStore>(cookies), async () => false, () => {});
  assert.equal(state.launches, 0);
  await session.ensureReady(); await session.ensureReady();
  assert.equal(state.launches, 1); assert.equal(state.contexts, 1);
  revision++; await session.ensureReady();
  assert.equal(state.launches, 1); assert.equal(state.contexts, 2);
  await session.closeBrowserSession(); await session.ensureReady();
  assert.equal(state.launches, 2); assert.equal(state.closes, 1);
});
test('normal browser launches require Chromium sandboxing', async () => {
  const { state, launch } = fakeBrowser(); let observed: { headless: boolean; chromiumSandbox?: boolean } | undefined;
  const session = new BrowserSession(double<BrowserLauncher>(options => { observed = options; return launch(); }),
    double<CookieStore>({ async revision() { return null; }, async load() { return ok([]); } }), async () => false, () => {});
  await session.ensureReady();
  assert.deepEqual(observed, { headless: true, chromiumSandbox: true });
  await session.shutdown();
  assert.equal(state.closes, 1);
});
test('restored cookies are remotely verified once per context before any lease is returned', async t => {
  const root = await temporary(t); const email = 'configured-user@example.invalid';
  const cookies = new FileCookieStore(join(root, 'session.json'), sessionAccountIdentity({ email }));
  await cookies.save([{ name: 'session', value: 'synthetic-session', domain: '.continente.pt', path: '/', expires: -1,
    httpOnly: true, secure: true, sameSite: 'Lax' }]);
  const { launch } = fakeBrowser(); let verifications = 0;
  const session = new BrowserSession(double<BrowserLauncher>(launch), cookies, async () => false, () => {}, {
    verifyRestoredAccount: async () => { verifications++; return true; },
  });
  await session.ensureReady(); await session.ensureReady();
  assert.equal(verifications, 1);
  await session.shutdown();
});
test('a bound cookie envelope still fails closed when the retailer profile belongs to another account', async t => {
  const root = await temporary(t); const email = 'configured-user@example.invalid';
  const cookies = new FileCookieStore(join(root, 'session.json'), sessionAccountIdentity({ email }));
  await cookies.save([{ name: 'session', value: 'synthetic-session', domain: '.continente.pt', path: '/', expires: -1,
    httpOnly: true, secure: true, sameSite: 'Lax' }]);
  const { launch, state } = fakeBrowser(); let verifications = 0;
  const session = new BrowserSession(double<BrowserLauncher>(launch), cookies, async () => false, () => {}, {
    verifyRestoredAccount: async () => { verifications++; return false; },
  });
  await assert.rejects(session.ensureReady(), SessionAccountMismatch);
  assert.equal(verifications, 1);
  assert.equal(state.closes, 1);
});
test('disconnect replaces crashed resources and corrupt cache is attempted only once per revision', async () => {
  const { state, launch } = fakeBrowser(); let loads = 0;
  const cookies = { async revision() { return 1; }, async load() { loads++; return { ok: false as const, error: { code: 'cache_unavailable' as const, message: 'Fixture failure', retryable: false } }; } };
  const session = new BrowserSession(double<BrowserLauncher>(launch), double<CookieStore>(cookies), async () => false, () => {});
  await session.ensureReady(); await session.ensureReady(); assert.equal(loads, 1);
  state.disconnect(); await session.ensureReady();
  assert.equal(state.launches, 2); assert.equal(loads, 2);
});
test('separate sessions have independent resources and queue survives operation failure', async () => {
  const a = fakeBrowser(); const b = fakeBrowser();
  const cookies = { async revision() { return 1; }, async load() { return ok([]); } };
  const first = new BrowserSession(double<BrowserLauncher>(a.launch), double<CookieStore>(cookies), async () => false, () => {});
  const second = new BrowserSession(double<BrowserLauncher>(b.launch), double<CookieStore>(cookies), async () => false, () => {});
  await first.ensureReady(); await second.ensureReady(); await first.closeBrowserSession();
  assert.equal(b.state.closes, 0);
  const queue = createSerialTaskQueue(); const events: string[] = []; let release: () => void = () => { throw new Error("Gate has not been initialized"); };
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const one = queue(async () => { events.push('start'); await barrier; events.push('fail'); throw new Error('expected'); });
  const two = queue(async () => { events.push('next'); return 2; });
  await Promise.resolve(); assert.deepEqual(events, ['start']); release();
  await assert.rejects(one); assert.equal(await two, 2); assert.deepEqual(events, ['start', 'fail', 'next']);
});
test('direct lifecycle calls and two owners sharing a session use one serialized queue', async () => {
  const { state, launch } = fakeBrowser();
  const session = new BrowserSession(double<BrowserLauncher>(launch), double<CookieStore>({ async revision() { return 1; }, async load() { return ok([]); } }), async () => false, () => {});
  let release: () => void = () => { throw new Error("Gate has not been initialized"); }; let started: () => void = () => { throw new Error("Gate has not been initialized"); };
  const gate = new Promise<void>(resolve => { release = resolve; });
  const active = new Promise<void>(resolve => { started = resolve; });
  const events: string[] = [];
  const first = session.run(async () => {
    const [a, b] = await Promise.all([session.ensureReady(), session.ensureReady()]);
    assert.equal(a.page, b.page); events.push('first'); started(); await gate; events.push('finished');
  });
  await active;
  const close = session.closeBrowserSession().then(() => events.push('closed'));
  const second = session.run(async () => { await session.ensureReady(); events.push('second'); });
  assert.equal(state.closes, 0); release(); await Promise.all([first, close, second]);
  assert.deepEqual(events, ['first', 'finished', 'closed', 'second']);
  assert.equal(state.launches, 2); assert.equal(state.contexts, 2); assert.equal(state.pages, 2);
  await Promise.all([session.closeBrowserSession(), session.closeBrowserSession()]); assert.equal(state.closes, 2);
});
const credentials = { email: 'test@example.invalid', password: 'synthetic' };
test('sign-in status comes from the cart summary, and login needs both credentials', async () => {
  const auth = new AuthenticationClient(double<BrowserLauncher>(async () => { throw new Error('should not launch'); }), double<CookieStore>({}), { email: '', password: '' }, () => {});
  let response = { ok: () => true, status: () => 200, async json(): Promise<unknown> { return { resources: { customerAuthenticated: false } }; } };
  const context = double<import('playwright').BrowserContext>({ request: { async get() { return response; } } });
  assert.equal(await auth.isSignedIn(context), false);
  response = { ...response, async json() { return { resources: { customerAuthenticated: true } }; } }; assert.equal(await auth.isSignedIn(context), true);
  response = { ...response, ok: () => false, status: () => 403 }; assert.equal(await auth.isSignedIn(context), false);
  assert.equal(await auth.loginWithCredentials(), false);
});
test('login fills both form steps, saves only a verified session and always closes the browser', async () => {
  const events: string[] = []; let signedIn = false; let remoteEmail = credentials.email; let profileMarker = true; let currentUrl = 'https://www.continente.pt/';
  const field = (name: string) => ({ async fill(value: string) { events.push(`fill ${name} ${value === credentials.password ? '<password>' : value}`); }, async press() {} });
  const frame = { url: () => 'https://login.continente.pt/user-register/', locator(selector: string) {
    if (selector.startsWith('button')) return { first: () => ({ async count() { return 1; }, async click() { events.push('submit'); } }) };
    return field(selector);
  } };
  const page = { async goto(url: string) { currentUrl = url; return null; }, url: () => currentUrl,
    getByRole: () => ({ async click() {} }), frames: () => [frame], async waitForURL() {},
    async waitForFunction(_predicate: unknown, selector: string, options: { timeout: number }) {
      assert.equal(selector, 'input#registration-form-email[type="email"][readonly]'); assert.ok(options.timeout > 0);
      if (!profileMarker || !remoteEmail.trim()) throw new Error('profile email is not populated');
    },
    locator(selector: string) { assert.equal(selector, 'input#registration-form-email[type="email"][readonly]'); return { async evaluate() { return { value: remoteEmail, readonly: true, type: 'email' }; } }; } };
  const context = { async route() { return double<import('playwright').Disposable>({}); }, async newPage() { return page; }, async cookies() { return [{ name: 's', value: 'v', domain: '.continente.pt', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax', partitionKey: 'ignored' }]; },
    request: { async get() { return { ok: () => true, status: () => 200, async json() { return { resources: { customerAuthenticated: signedIn } }; } }; } } };
  const launch = async (options: { headless: boolean; chromiumSandbox?: boolean }) => { events.push(`launch headless=${options.headless}, sandbox=${options.chromiumSandbox}`);
    return { version: () => '140.0.0.0', async newContext() { return context; }, async close() { events.push('close'); } }; };
  const saved: unknown[] = [];
  const auth = new AuthenticationClient(double<BrowserLauncher>(launch), double<CookieStore>({ async save(cookies) { saved.push(cookies); events.push('save'); } }), credentials, () => {}, { showBrowser: true });
  await assert.rejects(auth.loginWithCredentials(), /did not accept/);
  assert.deepEqual(events, ['launch headless=false, sandbox=true', 'fill #userNameCC test@example.invalid', 'submit', 'fill #password_input <password>', 'submit', 'close']);
  events.length = 0; signedIn = true;
  assert.equal(await auth.loginWithCredentials(), true);
  assert.equal(events.at(-1), 'close'); assert.ok(events.indexOf('save') < events.length - 1);
  assert.deepEqual(saved, [[{ name: 's', value: 'v', domain: '.continente.pt', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' }]]);

  events.length = 0; saved.length = 0; remoteEmail = 'different@example.invalid';
  await assert.rejects(auth.loginWithCredentials(), /configured account could not be verified/);
  assert.equal(saved.length, 0);
  assert.equal(events.includes('save'), false);

  profileMarker = false; remoteEmail = credentials.email;
  await assert.rejects(auth.loginWithCredentials(), /configured account could not be verified/);
  assert.equal(saved.length, 0);

  profileMarker = true; remoteEmail = '   ';
  await assert.rejects(auth.loginWithCredentials(), /configured account could not be verified/);
  assert.equal(saved.length, 0);
  const noConfiguredEmail = new AuthenticationClient(double<BrowserLauncher>(async () => { throw new Error('not used'); }),
    double<CookieStore>({}), { email: ' ', password: 'synthetic' }, () => {});
  assert.equal(await noConfiguredEmail.verifyAccount(double<Page>({ async goto() { throw new Error('must not navigate'); } })), false);
});
test('public search never invokes login with missing cookies, even when configured login throws', async () => {
  let logins = 0; let markers = 0;
  const page = { isClosed: () => false, async close() {}, url: () => 'https://www.continente.pt/pesquisa/',
    async goto(url: string, options: { waitUntil?: string }) { assert.equal(options.waitUntil, 'domcontentloaded'); return { ok: () => true, status: () => 200 }; },
    async waitForSelector() { markers++; }, async content() { return '<div data-search-empty></div>'; } };
  const launch = async () => ({ on() { return double<import('playwright').Browser>({}); }, async close() {}, version: () => '140.0.0.0', async newContext() { return { async route() { return double<import('playwright').Disposable>({}); }, async close() {}, async newPage() { return page; } }; } });
  const session = new BrowserSession(double<BrowserLauncher>(launch), double<CookieStore>({ async revision() { return null; } }), async () => { logins++; throw new Error('private login failure'); }, () => {});
  const catalog = new CatalogClient(new StorefrontClient(double<StorefrontSession>(session)));
  assert.equal((await catalog.searchProducts('milk', 0)).ok, true);
  assert.equal(logins, 0); assert.equal(markers, 1);
  assert.equal(await session.refreshAuthentication(), false); assert.equal(logins, 1);
  assert.equal((await catalog.searchProducts('milk', 0)).ok, true); assert.equal(logins, 1);
  await session.closeBrowserSession();
});
test('the login frame must come from the exact login origin', async () => {
  const auth = new AuthenticationClient(double<BrowserLauncher>(async () => { throw new Error('Unexpected browser launch'); }), double<CookieStore>({}), credentials, () => {});
  const target = { url: () => 'https://login.continente.pt/user-register/session' };
  const page = { frames: () => [{ url: () => 'https://evil.invalid/login.continente.pt/user-register' }],
    async waitForEvent(event: string, options: { timeout: number; predicate: (frame: { url(): string }) => boolean }) { assert.equal(event, 'framenavigated'); assert.equal(options.timeout, 15000);
      assert.equal(options.predicate(present(this.frames()[0])), false); assert.equal(options.predicate(target), true); return target; } };
  // This double implements only the framenavigated overload of waitForEvent.
  assert.equal(await auth.loginFrame(page as unknown as Page), target);
});
