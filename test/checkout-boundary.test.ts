import assert from 'node:assert/strict';
import test from 'node:test';
import type { BrowserContext, Route } from 'playwright';
import { installCheckoutBoundary, isForbiddenCheckoutRequest } from '../src/session/checkout-boundary.js';
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
  await installCheckoutBoundary({ async route(pattern: string, callback: typeof handler) {
    assert.equal(pattern, '**/*'); handler = callback;
  } } as unknown as BrowserContext);
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
  let basketContinued = false;
  await handler({ request: () => ({ url: () => 'https://www.continente.pt/checkout/carrinho/', isNavigationRequest: () => true }),
    async abort() { assert.fail('basket navigation blocked'); }, async continue() { basketContinued = true; }
  } as unknown as Route);
  assert.equal(basketContinued, true);
});

test('explicit payment navigation is rejected without starting a browser', async () => {
  let started = false;
  const site = new StorefrontClient({ async ensureReady() { started = true; throw new Error('must not start'); } } as unknown as StorefrontSession);
  const result = await site.navigateToStorefrontPage('/checkout/pagamento/');
  assert.equal(result.ok, false);
  assert.equal(started, false);
});
