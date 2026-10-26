import { fail, present } from '../test-support/helpers.js';
import type { FavoritesCache } from '../src/domain/index.js';

import type { CookieStore } from '../src/stores/files.js';
import type { BrowserLauncher } from '../src/session/browser.js';
import { double, dataOf } from '../test-support/assertions.js';
import { SessionStatusOutput } from '../src/mcp/contracts.js';
import { BrowserSession } from '../src/session/browser.js';
import { FavoritesService } from '../src/services/catalog.js';
import { injectedServices, connect } from '../test-support/mcp-fixture.js';

const sessionData = SessionStatusOutput.shape.result.options[0].shape.data;

import assert from 'node:assert/strict';
import test from 'node:test';

const clock = { now: () => new Date('2026-10-14T12:00:00Z') };
test('status is local, distinguishes readiness from authentication, and invalidates replaced cookies', async () => {
  let revision: number | null = null; let launches = 0; let logins = 0;
  const session = new BrowserSession(double<BrowserLauncher>(async () => { launches++; return { on() { return double<import('playwright').Browser>({}); }, async close() {}, version: () => '140.0.0.0', async newContext() {
    return { async route() { return double<import('playwright').Disposable>({}); }, async close() {}, async addCookies() {}, async newPage() { return { isClosed: () => false, async close() {} }; } };
  } }; }), double<CookieStore>({ async revision() { return revision; }, async load() { return { ok: true, value: [] }; } }),
  async () => { logins++; return true; }, () => {}, { credentials: { hasEmail: true, hasPassword: false }, clock });
  assert.deepEqual(await session.getStatus(), { browser: 'closed', credentials: { hasEmail: true, hasPassword: false },
    savedCookies: 'missing', authentication: { state: 'unknown', checkedAt: null } });
  assert.equal(launches, 0); assert.equal(logins, 0);
  revision = 1; await session.ensureReady();
  assert.equal((await session.getStatus()).browser, 'ready');
  assert.equal((await session.getStatus()).authentication.state, 'unknown');
  session.recordAuthentication(true);
  assert.deepEqual((await session.getStatus()).authentication, { state: 'authenticated', checkedAt: clock.now().toISOString() });
  await session.closeBrowserSession(); assert.equal((await session.getStatus()).browser, 'closed');
  assert.equal((await session.getStatus()).authentication.state, 'authenticated');
  revision = 2; assert.equal((await session.getStatus()).authentication.state, 'unknown');
  await session.ensureReady(); session.recordAuthentication(false);
  assert.equal((await session.getStatus()).authentication.state, 'unauthenticated');
  assert.equal(logins, 0); await session.closeBrowserSession();
});
test('unreadable cookies report unavailable without claiming unauthenticated', async () => {
  const session = new BrowserSession(double<BrowserLauncher>(() => { throw new Error('must not launch'); }), double<CookieStore>({ async revision() { throw new Error('private path'); } }),
    () => { throw new Error('must not login'); }, () => {});
  const status = await session.getStatus();
  assert.equal(status.savedCookies, 'unavailable'); assert.equal(status.authentication.state, 'unknown');
  assert.deepEqual(status.credentials, { hasEmail: null, hasPassword: null });
  assert.ok(!JSON.stringify(status).includes('private path'));
});
test('favorites status reads freshness without refresh, writes, or exposing account scope', async () => {
  let cache: FavoritesCache | null = null; let broken = false;
  const favorites = new FavoritesService({ async fetchFavorites() { throw new Error('must not fetch'); } }, {
    async load() { return broken ? fail('cache_unavailable') : { ok: true, value: cache }; }, async save() { throw new Error('must not save'); }
  }, clock, 'private-account', () => {});
  assert.equal((await favorites.getCacheStatus()).state, 'missing');
  cache = { schemaVersion: 2 as const, accountScope: 'private-account', fetchedAt: clock.now().toISOString(), favorites: [] };
  const status = await favorites.getCacheStatus(); assert.equal(status.state, 'fresh'); assert.equal(status.empty, true);
  assert.ok(!JSON.stringify(status).includes('private-account'));
  cache.fetchedAt = '2026-10-12T12:00:00Z'; assert.equal((await favorites.getCacheStatus()).state, 'stale');
  cache.accountScope = 'other'; assert.equal((await favorites.getCacheStatus()).state, 'unavailable');
  broken = true; assert.equal((await favorites.getCacheStatus()).state, 'unavailable');
});
test('MCP status exposes only allowlisted local facts and read-only annotations', async t => {
  const { services, state } = injectedServices(); const { client } = await connect(t, services);
  const tool = (await client.listTools()).tools.find(tool => tool.name === 'get_session_status');
  assert.equal(present(present(tool).annotations).readOnlyHint, true); assert.equal(present(present(tool).annotations).openWorldHint, false);
  const result = await client.callTool({ name: 'get_session_status', arguments: {} });
  assert.equal(result.isError, undefined);
  assert.deepEqual(dataOf(result, sessionData), { browser: 'unknown', credentials: { hasEmail: null, hasPassword: null },
    savedCookies: 'unknown', authentication: { state: 'unknown', checkedAt: null },
    favorites: { state: 'missing', fetchedAt: null, expiresAt: null, empty: null },
    update: { currentVersion: null, latestVersion: null, available: false } });
  assert.equal(state.reads, 0); assert.equal(state.refreshes, 0); assert.equal(state.writes, 0);
});
test('an idle browser closes automatically and reopens on the next operation', async () => {
  let launches = 0; let closes = 0;
  const session = new BrowserSession(double<BrowserLauncher>(async () => { launches++; return { on() { return double<import('playwright').Browser>({}); }, async close() { closes++; }, version: () => '140.0.0.0', async newContext() {
    return { async route() { return double<import('playwright').Disposable>({}); }, async close() {}, async addCookies() {}, async newPage() { return { isClosed: () => false, async close() {} }; } };
  } }; }), double<CookieStore>({ async revision() { return null; } }), async () => false, () => {}, { idleCloseMs: 20, clock });
  await session.ensureReady(); assert.equal((await session.getStatus()).browser, 'ready');
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(closes, 1); assert.equal((await session.getStatus()).browser, 'closed');
  await session.ensureReady(); assert.equal(launches, 2);
  await session.shutdown(); assert.equal(closes, 2);
});
