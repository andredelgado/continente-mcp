import assert from 'node:assert/strict';
import test from 'node:test';
import { allowedCartMutation } from '../src/clients/policy.js';

test('cart writes allow only supported cart operations with their observed methods', () => {
  assert.equal(allowedCartMutation('/on/demandware.store/Sites-continente-Site/default/Cart-AddProduct', 'POST'), true);
  assert.equal(allowedCartMutation('/Cart-UpdateQuantity', 'GET'), true);
  assert.equal(allowedCartMutation('/on/demandware.store/Sites-continente-Site/default/Cart-RemoveAllProductLineItems', 'POST'), true);
  assert.equal(allowedCartMutation('/on/demandware.store/Sites-continente-Site/default/Cart-RemoveAllProductLineItems', 'GET'), false);
  assert.equal(allowedCartMutation('/Cart-RemoveProduct', 'GET'), true);
  assert.equal(allowedCartMutation('/Cart-RemoveProductLineItem', 'GET'), true);
  assert.equal(allowedCartMutation('https://www.continente.pt/on/demandware.store/Sites-continente-Site/default/Cart-RemoveProductLineItem', 'GET'), true);
  assert.equal(allowedCartMutation('/on/demandware.store/Sites-continente-Site/default/Cart-ApplyCustomerBenefits', 'POST'), false);
  for (const [path, method] of [
    ['/checkout/pagamento/', 'POST'], ['/checkout/confirmar/', 'POST'], ['/Cart-AddProduct', 'GET'],
    ['/Cart-UpdateQuantity', 'POST'], ['/Cart-RemoveProduct', 'POST'], ['/Cart-RemoveProductLineItem', 'POST'],
    ['/Cart-ApplyCustomerBenefits', 'GET'], ['/Cart-ApplyCustomerBenefits', 'POST'], ['/Cart-MiniCartShow', 'GET'],
    ['/Cart-AddProduct?redirect=checkout', 'POST'], ['/Cart-AddProduct#payment', 'POST'],
    ['https://attacker.invalid/Cart-AddProduct', 'POST'], ['/Cart-AddProduct/../checkout/pagamento/', 'POST'],
  ] as const) assert.equal(allowedCartMutation(path, method), false, `${method} ${path}`);
});
