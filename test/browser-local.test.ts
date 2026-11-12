import { ProductIdSchema } from '../src/domain/index.js';
import { z } from 'zod';
import type { StorefrontSession } from '../src/session/browser.js';
import { double } from '../test-support/assertions.js';
import { chromium } from 'playwright';
import { CartClient, StorefrontClient } from '../src/clients/storefront.js';
import { parseProductForm } from '../src/parsers/cart.js';
import { loginFailure, safeLoginMessage } from '../src/session/login-errors.js';
import { guardPage, installCheckoutBoundary } from '../src/session/checkout-boundary.js';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import assert from 'node:assert/strict';
import test from 'node:test';

test('local Chromium extracts current form properties before pure validation', {
  skip: process.env.CONTINENTE_LOCAL_BROWSER_TEST !== '1' && 'Opt in with CONTINENTE_LOCAL_BROWSER_TEST=1; uses only fulfilled local routes',
}, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: `
      <input name="productID"><input class="add-to-cart-url"><input name="csrf_token">
      <div class="ct-tile-quantity-update" data-pid="999" data-measure-options='{"primaryunit":"un","maxNumberOfUnitsPerSale":11}'></div>
      <div data-pid="00123"><div class="ct-tile-quantity-update" data-measure-options='{"primaryunit":"un"}'></div></div>
      <script>
        document.querySelector('[name="productID"]').value = '00123';
        document.querySelector('.add-to-cart-url').value = '/Cart-AddProduct';
        document.querySelector('[name="csrf_token"]').value = 'local-dynamic-token';
      </script>` }));
    const page = await context.newPage();
    const session = { async ensureReady() { return { page, context }; } };
    const response = await new CartClient(new StorefrontClient(double<StorefrontSession>(session))).fetchProductForm('00123');
    assert.equal(response.ok, true);
    assert.equal(z.object({ csrf: z.string() }).parse(response.value).csrf, 'local-dynamic-token');
    assert.equal((await page.content()).includes('value="local-dynamic-token"'), false);
    const form = parseProductForm(response.value, ProductIdSchema.parse('00123'));
    assert.equal(form.ok, true);
    assert.equal(form.value.sale.rules.saleUnit, 'un');
  } finally { await browser.close(); }
});

test('real Playwright failures never put a typed password or cookie into sign-in logs', {
  skip: process.env.CONTINENTE_LOCAL_BROWSER_TEST !== '1' && 'Opt in with CONTINENTE_LOCAL_BROWSER_TEST=1; uses only local pages',
}, async () => {
  const password = 'FAKE-PASSWORD-7c41'; const cookie = 'FAKE-COOKIE-9e2a';
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<form><input id="password_input" type="password" disabled></form>');
    const fill = await page.locator('#password_input').fill(password, { timeout: 500 }).catch((error: unknown) => error);
    assert.ok(fill instanceof Error && fill.message.includes(password), 'Playwright is expected to embed the typed value');
    const fillLog = safeLoginMessage(loginFailure('entering the password', fill));
    assert.equal(fillLog, 'Sign-in failed while entering the password (timed out).');
    await page.context().addCookies([{ name: 'session', value: cookie, domain: '127.0.0.1', path: '/' }]);
    const request = await page.context().request.get('http://127.0.0.1:9/', { timeout: 500 }).catch((error: unknown) => error);
    assert.ok(request instanceof Error && request.message.includes(cookie), 'Playwright is expected to embed the Cookie header');
    const requestLog = safeLoginMessage(loginFailure('checking the new session', request));
    for (const text of [fillLog, requestLog, safeLoginMessage(fill), safeLoginMessage(request)]) {
      assert.ok(!text.includes(password) && !text.includes(cookie), text);
    }
  } finally { await browser.close(); }
});

test('real Chromium never requests a forbidden or external destination through a redirect', {
  skip: process.env.CONTINENTE_LOCAL_BROWSER_TEST !== '1' && 'Opt in with CONTINENTE_LOCAL_BROWSER_TEST=1; uses only a local server',
}, async () => {
  const seen: string[] = [];
  const redirects: Record<string, [string, number]> = {
    '/checkout/carrinho/': ['/checkout/pagamento/', 302],
    '/to-place-order': ['/on/demandware.store/Sites-continente-Site/default/CheckoutServices-PlaceOrder', 307],
    '/to-elsewhere': ['http://payments.example/pay', 302],
    '/hop-1': ['/hop-2', 302], '/hop-2': ['/checkout/entrega/', 301],
    '/via-1': ['/via-2', 302], '/via-2': ['/checkout/pagamento/', 302],
  };
  const server = createServer((request, response) => {
    seen.push(`${request.method} ${request.headers.host?.split(':')[0]} ${request.url}`);
    const redirect = redirects[request.url ?? ''];
    if (redirect) { response.writeHead(redirect[1], { Location: redirect[0] }); response.end(); return; }
    response.writeHead(200, { 'content-type': 'text/html' }); response.end('<p>ok</p>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  // The browser resolves the storefront and an external host to the local server.
  const browser = await chromium.launch({ headless: true, args: [`--host-resolver-rules=MAP www.continente.pt 127.0.0.1:${port}, MAP payments.example 127.0.0.1:${port}`] });
  try {
    const context = await browser.newContext();
    await installCheckoutBoundary(context);
    // A fresh page for each visit: a blocked navigation leaves an error page still loading.
    const open = async () => { const page = await context.newPage(); await guardPage(context, page); return page; };
    const visit = async (path: string) => {
      const page = await open(); seen.length = 0;
      const outcome = await page.goto(`http://www.continente.pt${path}`).then(() => new URL(page.url()).pathname, () => 'blocked');
      await page.close(); return outcome;
    };
    assert.equal(await visit('/checkout/carrinho/'), 'blocked');
    assert.deepEqual(seen, ['GET www.continente.pt /checkout/carrinho/'], 'the payment page received a request');
    assert.equal(await visit('/to-elsewhere'), 'blocked');
    assert.deepEqual(seen, ['GET www.continente.pt /to-elsewhere'], 'the external site received a request');
    assert.equal(await visit('/via-1'), 'blocked');
    assert.deepEqual(seen, ['GET www.continente.pt /via-1', 'GET www.continente.pt /via-2'], 'a later hop reached the payment page');
    assert.equal(await visit('/hop-1'), '/checkout/entrega/');
    assert.deepEqual(seen, ['GET www.continente.pt /hop-1', 'GET www.continente.pt /hop-2', 'GET www.continente.pt /checkout/entrega/']);

    const page = await open();
    await page.goto(`http://www.continente.pt/checkout/entrega/`);
    seen.length = 0;
    const status = await page.evaluate(() => fetch('/to-place-order', { method: 'POST', body: 'x=1' }).then(response => String(response.status), () => 'blocked'));
    assert.equal(status, 'blocked');
    assert.deepEqual(seen, ['POST www.continente.pt /to-place-order'], 'the order submission received a request');

    // A window the site opens itself: its first request goes out before its guard could attach, so it
    // is refused, and a redirect from it never reaches the order submission.
    for (const open of [
      () => page.evaluate(() => { const form = Object.assign(document.createElement('form'), { method: 'POST', action: '/to-place-order', target: '_blank' }); document.body.append(form); form.submit(); }),
      () => page.evaluate(() => { window.open('/to-place-order'); }),
    ]) {
      seen.length = 0;
      const popup = context.waitForEvent('page');
      await open();
      const opened = await popup;
      await opened.waitForLoadState('domcontentloaded').catch(() => undefined);
      await page.waitForTimeout(300);
      assert.deepEqual(seen, [], 'a new window sent its first request before its guard was active');
      await opened.close();
    }
  } finally { await browser.close(); server.close(); }
});
