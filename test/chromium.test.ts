import { ChromiumInstaller, BrowserUnavailable, isMissingBrowserError, sandboxedLauncher } from '../src/session/chromium.js';
import type { BrowserLauncher } from '../src/session/browser.js';
import { RequestScope, inRequest } from '../src/session/request.js';
import { double } from '../test-support/assertions.js';
import { injectedServices, connect } from '../test-support/mcp-fixture.js';
import { CatalogClient, StorefrontClient } from '../src/clients/storefront.js';
import { CatalogService } from '../src/services/catalog.js';

import assert from 'node:assert/strict';
import test from 'node:test';

const missing = () => new Error("browserType.launch: Executable doesn't exist at /cache/chromium/headless_shell");
const browser = double<Awaited<ReturnType<BrowserLauncher>>>({});
function gate() {
  let open: () => void = () => {}; let fail: (error: Error) => void = () => {};
  const promise = new Promise<void>((resolve, reject) => { open = resolve; fail = reject; });
  return { promise, open, fail };
}

test('Chromium starts with its sandbox, and without it, said once, only where the system cannot provide it', async () => {
  const run = async (available: boolean) => {
    const calls: boolean[] = []; const logs: string[] = [];
    const launch = sandboxedLauncher(async options => { calls.push(options.chromiumSandbox); if (options.chromiumSandbox && !available) throw new Error('No usable sandbox!'); return browser; },
      message => logs.push(message));
    for (const headless of [true, false]) assert.equal(await launch({ headless }), browser);
    return { calls, logs };
  };
  assert.deepEqual(await run(true), { calls: [true, true], logs: [] });
  const without = await run(false);
  assert.deepEqual(without.calls, [true, false, false]);
  assert.deepEqual(without.logs, ['Chromium\'s sandbox is not available on this system, so the browser runs without it.']);
  // A missing browser goes to the installer, and a browser that once started sandboxed is not started without it.
  await assert.rejects(sandboxedLauncher(async () => { throw missing(); }, () => {})({ headless: true }), /Executable doesn't exist/);
  let started = false;
  const once = sandboxedLauncher(async () => { if (started) throw new Error('crashed'); started = true; return browser; }, () => {});
  await once({ headless: true }); await assert.rejects(once({ headless: true }), /crashed/);
});

test('a missing browser is downloaded once, then launched', async () => {
  let installed = false; let installs = 0; let launches = 0;
  const installer = new ChromiumInstaller(async () => { installs++; installed = true; }, () => {});
  const launch = installer.launcher(async () => { launches++; if (!installed) throw missing(); return browser; });
  assert.equal(await launch({ headless: true }), browser);
  assert.equal(await launch({ headless: true }), browser);
  assert.equal(installs, 1); assert.equal(launches, 3);
});

test('other launch errors are not treated as a missing browser', async () => {
  let installs = 0;
  const installer = new ChromiumInstaller(async () => { installs++; }, () => {});
  const launch = installer.launcher(async () => { throw new Error('Target page, context or browser has been closed'); });
  await assert.rejects(launch({ headless: true }), /has been closed/);
  assert.equal(installs, 0);
  assert.equal(isMissingBrowserError(missing()), true); assert.equal(isMissingBrowserError('text'), false);
});

test('a slow download returns a retryable message instead of overrunning the request', async () => {
  const download = gate(); let installs = 0; let installed = false;
  const installer = new ChromiumInstaller(async () => { installs++; await download.promise; installed = true; }, () => {}, 20);
  const launch = installer.launcher(async () => { if (!installed) throw missing(); return browser; });
  const first = await launch({ headless: true }).catch((error: unknown) => error);
  assert.ok(first instanceof BrowserUnavailable);
  assert.deepEqual([first.toolError.code, first.toolError.retryable], ['browser_unavailable', true]);
  assert.match(first.toolError.message, /being downloaded/);
  await assert.rejects(launch({ headless: true }), BrowserUnavailable);
  download.open();
  assert.equal(await launch({ headless: true }), browser);
  assert.equal(installs, 1);
});

test('the wait never exceeds what remains of the request budget', async () => {
  const download = gate();
  const installer = new ChromiumInstaller(async () => download.promise, () => {}, 60000);
  const launch = installer.launcher(async () => { throw missing(); });
  const scope = new RequestScope({ timeoutMs: 10500 });
  const started = Date.now();
  await assert.rejects(inRequest(scope, () => launch({ headless: true })), /being downloaded/);
  assert.ok(Date.now() - started < 2000);
  scope.dispose(); download.open();
});

test('a failed download is reported and retried on the next launch', async () => {
  let attempts = 0; let installed = false;
  const installer = new ChromiumInstaller(async () => { attempts++; if (attempts === 1) throw new Error('network down'); installed = true; }, () => {});
  const launch = installer.launcher(async () => { if (!installed) throw missing(); return browser; });
  const failed = await launch({ headless: true }).catch((error: unknown) => error);
  assert.ok(failed instanceof BrowserUnavailable); assert.match(failed.message, /could not be downloaded/);
  assert.equal(await launch({ headless: true }), browser);
  assert.equal(attempts, 2);
});

test('tools report the download message instead of a generic upstream failure', async t => {
  const { services } = injectedServices();
  const session = { ...services.session, async ensureReady(): Promise<never> {
    throw new BrowserUnavailable({ code: 'browser_unavailable', message: 'Chromium is being downloaded for first use (about 150 MB). Try again in a minute.', retryable: true });
  } };
  services.catalog = new CatalogService(new CatalogClient(new StorefrontClient(session)), services.favorites);
  const { client } = await connect(t, services);
  const result = await client.callTool({ name: 'search_products', arguments: { query: 'leite' } });
  assert.equal(result.isError, true);
  const error = (result.structuredContent as { result: { error: { code: string; retryable: boolean } } }).result.error;
  assert.deepEqual([error.code, error.retryable], ['browser_unavailable', true]);
  assert.match(JSON.stringify(result.content), /being downloaded/);
});
