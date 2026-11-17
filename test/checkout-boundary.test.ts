import assert from 'node:assert/strict';
import test from 'node:test';
import type { BrowserContext, Page, Route } from 'playwright';
import { guardPage, installCheckoutBoundary, isBlockedBrowserRequest, isForbiddenCheckoutRequest } from '../src/session/checkout-boundary.js';
import { allowedCartMutation, allowedCouponMutation } from '../src/clients/policy.js';
import { StorefrontClient } from '../src/clients/storefront.js';
import type { StorefrontSession } from '../src/session/browser.js';

test('payment, order submission and slot reservation requests are blocked before transmission', async () => {
  const denied = [
    '/checkout/pagamento/', '/checkout/payment/', '/checkout/resumo/',
    '/on/demandware.store/Sites-continente-Site/default/Checkout-Begin?stage=payment', '/checkout/%70agamento/', '/checkout/%2570agamento/',
    '/on/demandware.store/Sites-continente-Site/default/CheckoutServices-BookDeliverySlot',
    '/on/demandware.store/Sites-continente-Site/default/CheckoutServices-BookDeliverySlotForEntregaZero',
    '/on/demandware.store/Sites-continente-Site/default/CheckoutServices-PlaceOrder',
    '/on/demandware.store/Sites-continente-Site/default/CheckoutServices-GetPayPalButton',
  ];
  let handler: (route: Route) => Promise<void> = async () => { throw new Error('not installed'); };
  const context = { async route(pattern: string, callback: typeof handler) {
    assert.equal(pattern, '**/*'); handler = callback;
  }, on() {}, async newCDPSession() { return { on() {}, async send() {} }; } } as unknown as BrowserContext;
  await installCheckoutBoundary(context);
  const guarded = {} as Page; await guardPage(context, guarded);
  const unguarded = {} as Page;
  for (const path of denied) {
    assert.equal(isForbiddenCheckoutRequest(path), true, path);
    let aborted = false;
    await handler({ request: () => ({ url: () => `https://www.continente.pt${path}`, isNavigationRequest: () => true }),
      async abort() { aborted = true; }, async continue() { assert.fail('unsafe request continued'); }
    } as unknown as Route);
    assert.equal(aborted, true);
  }
  for (const path of ['/checkout/carrinho/', '/checkout/entrega/', '/login/', '/conta/cartao-continente/']) {
    assert.equal(isForbiddenCheckoutRequest(path), false, path);
  }
  let externalBlocked = false;
  await handler({ request: () => ({ url: () => 'https://payments.example/checkout', isNavigationRequest: () => true }),
    async abort() { externalBlocked = true; }, async continue() { assert.fail('external navigation continued'); }
  } as unknown as Route);
  assert.equal(externalBlocked, true);
  const decide = async (navigation: boolean, frame: () => unknown) => {
    let decision = '';
    await handler({ request: () => ({ url: () => 'https://www.continente.pt/checkout/carrinho/', isNavigationRequest: () => navigation, frame }),
      async abort() { decision = 'abort'; }, async continue() { decision = 'continue'; } } as unknown as Route);
    return decision;
  };
  const noFrame = () => { throw new Error('the frame does not exist yet'); };
  // The basket from a page whose redirect guard is active.
  assert.equal(await decide(true, () => ({ page: () => guarded })), 'continue');
  assert.equal(await decide(false, () => ({ page: () => guarded })), 'continue');
  // The same request from a window whose guard is not active yet, or a navigation before its window exists.
  assert.equal(await decide(true, () => ({ page: () => unguarded })), 'abort');
  assert.equal(await decide(false, () => ({ page: () => unguarded })), 'abort');
  assert.equal(await decide(true, noFrame), 'abort');
  // A request with no page that is not a navigation is judged by its address alone.
  assert.equal(await decide(false, noFrame), 'continue');
});

test('redirect hops are judged like requests: forbidden paths always, other sites for navigations', () => {
  assert.equal(isBlockedBrowserRequest('https://www.continente.pt/checkout/pagamento/', false), true);
  assert.equal(isBlockedBrowserRequest('https://www.continente.pt/on/demandware.store/Sites-continente-Site/default/CheckoutServices-PlaceOrder', false), true);
  assert.equal(isBlockedBrowserRequest('https://payments.example/pay', true), true);
  assert.equal(isBlockedBrowserRequest('https://payments.example/pay.js', false), false);
  assert.equal(isBlockedBrowserRequest('https://login.continente.pt/', true), false);
  assert.equal(isBlockedBrowserRequest('https://www.continente.pt/checkout/entrega/', true), false);
  assert.equal(isBlockedBrowserRequest('data:text/html,ok', true), false);
  assert.equal(isBlockedBrowserRequest('not a url', false), true);
});

test('pages the server reads cannot write to the cart or the coupons; the server\'s own writes are the ones it checks', () => {
  const base = 'https://www.continente.pt/on/demandware.store/Sites-continente-Site/default/';
  const writes = [['add', 'Cart-AddProduct'], ['update', 'Cart-UpdateQuantity'], ['remove', 'Cart-RemoveProduct'], ['remove', 'Cart-RemoveProductLineItem'],
    ['clear', 'Cart-RemoveAllProductLineItems']] as const;
  for (const [operation, endpoint] of writes) {
    // Every endpoint the cart client may write to is one the browser refuses, in either form and however it is encoded.
    assert.equal(allowedCartMutation(`${base}${endpoint}`, operation), true, endpoint);
    for (const url of [`${base}${endpoint}`, `https://www.continente.pt/${endpoint}?pid=1`, `${base}${encodeURIComponent(endpoint)}`, `${base}${endpoint.toLowerCase()}`]) {
      assert.equal(isBlockedBrowserRequest(url, false), true, url);
    }
  }
  assert.equal(allowedCouponMutation(`${base}Cart-ApplyCustomerBenefits`, 'POST'), true);
  assert.equal(isBlockedBrowserRequest(`${base}Cart-ApplyCustomerBenefits`, false), true);
  for (const url of [`${base}Cart-MiniCartShow`, `${base}Cart-Show`, 'https://www.continente.pt/checkout/carrinho/', 'https://www.continente.pt/produto/cart-addproduct-guia-00123.html',
    'https://cdn.example/Cart-AddProduct']) {
    assert.equal(isBlockedBrowserRequest(url, false), false, url);
  }
});

test('explicit payment navigation is rejected without starting a browser', async () => {
  let started = false;
  const site = new StorefrontClient({ async ensureReady() { started = true; throw new Error('must not start'); } } as unknown as StorefrontSession);
  const result = await site.navigateToStorefrontPage('/checkout/pagamento/');
  assert.equal(result.ok, false);
  assert.equal(started, false);
});
