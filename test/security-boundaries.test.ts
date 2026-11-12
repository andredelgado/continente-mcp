import assert from 'node:assert/strict';
import test from 'node:test';
import { allowedCartMutation } from '../src/clients/policy.js';

const SITE = '/on/demandware.store/Sites-continente-Site/default';
test('each cart write accepts only its own operation endpoint', () => {
  for (const [path, operation] of [
    [`${SITE}/Cart-AddProduct`, 'add'], ['/Cart-AddProduct', 'add'], ['/Cart-UpdateQuantity', 'update'],
    [`${SITE}/Cart-RemoveAllProductLineItems`, 'clear'], ['/Cart-RemoveProduct', 'remove'], ['/Cart-RemoveProductLineItem', 'remove'],
    [`https://www.continente.pt${SITE}/Cart-RemoveProductLineItem`, 'remove'],
  ] as const) assert.equal(allowedCartMutation(path, operation), true, `${operation} ${path}`);
  for (const [path, operation] of [
    // Another cart operation behind the requested one.
    [`${SITE}/Cart-RemoveAllProductLineItems`, 'add'], ['/Cart-RemoveAllProductLineItems', 'update'], ['/Cart-RemoveAllProductLineItems', 'remove'],
    ['/Cart-RemoveProduct', 'update'], ['/Cart-RemoveProductLineItem', 'update'], ['/Cart-RemoveProduct', 'add'],
    ['/Cart-AddProduct', 'update'], ['/Cart-AddProduct', 'clear'], ['/Cart-UpdateQuantity', 'remove'], ['/Cart-UpdateQuantity', 'add'],
    // Not a product-cart write at all.
    ['/checkout/pagamento/', 'add'], ['/checkout/confirmar/', 'clear'], [`${SITE}/Cart-ApplyCustomerBenefits`, 'add'],
    ['/Cart-ApplyCustomerBenefits', 'update'], ['/Cart-MiniCartShow', 'update'],
    ['/Cart-AddProduct?redirect=checkout', 'add'], ['/Cart-AddProduct#payment', 'add'],
    ['https://attacker.invalid/Cart-AddProduct', 'add'], ['/Cart-AddProduct/../checkout/pagamento/', 'add'],
    ['/checkout/Cart-RemoveAllProductLineItems', 'clear'], ['/Cart-AddProduct', 'checkout' as never],
  ] as const) assert.equal(allowedCartMutation(path, operation), false, `${operation} ${path}`);
});
