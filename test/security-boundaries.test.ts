import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { allowedCartMutation, allowedCouponMutation } from '../src/clients/policy.js';
import { FileCookieStore } from '../src/stores/files.js';

test('cart writes allow only supported cart operations with their observed methods', () => {
  assert.equal(allowedCartMutation('/on/demandware.store/Sites-continente-Site/default/Cart-AddProduct', 'POST'), true);
  assert.equal(allowedCartMutation('/Cart-UpdateQuantity', 'GET'), true);
  assert.equal(allowedCartMutation('/on/demandware.store/Sites-continente-Site/default/Cart-RemoveAllProductLineItems', 'POST'), true);
  assert.equal(allowedCartMutation('/on/demandware.store/Sites-continente-Site/default/Cart-RemoveAllProductLineItems', 'GET'), false);
  assert.equal(allowedCartMutation('/Cart-RemoveProduct', 'GET'), true);
  assert.equal(allowedCartMutation('/Cart-RemoveProductLineItem', 'GET'), true);
  assert.equal(allowedCartMutation('/on/demandware.store/Sites-continente-Site/default/Cart-ApplyCustomerBenefits', 'POST'), false);
  assert.equal(allowedCouponMutation('/on/demandware.store/Sites-continente-Site/default/Cart-ApplyCustomerBenefits', 'POST'), true);
  assert.equal(allowedCouponMutation('/Cart-ApplyCustomerBenefits', 'POST'), false);
  assert.equal(allowedCouponMutation('/on/demandware.store/Sites-continente-Site/default/Cart-ApplyCustomerBenefits', 'GET'), false);
  for (const [path, method] of [
    ['/checkout/pagamento/', 'POST'], ['/checkout/confirmar/', 'POST'], ['/Cart-AddProduct', 'GET'],
    ['/Cart-UpdateQuantity', 'POST'], ['/Cart-RemoveProduct', 'POST'], ['/Cart-RemoveProductLineItem', 'POST'],
    ['/Cart-ApplyCustomerBenefits', 'GET'], ['/Cart-ApplyCustomerBenefits', 'POST'], ['/Cart-MiniCartShow', 'GET'],
    ['/Cart-AddProduct?redirect=checkout', 'POST'], ['/Cart-AddProduct#payment', 'POST'],
    ['https://attacker.invalid/Cart-AddProduct', 'POST'], ['/Cart-AddProduct/../checkout/pagamento/', 'POST'],
  ] as const) assert.equal(allowedCartMutation(path, method), false, `${method} ${path}`);
});

test('saved cookies are bound to one opaque configured-account identity', async t => {
  const root = await mkdtemp(join(tmpdir(), 'continente-session-binding-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'session.json');
  const cookie = { name: 'session', value: 'synthetic', domain: '.continente.pt', path: '/', expires: -1,
    httpOnly: true, secure: true, sameSite: 'Lax' as const };
  const accountA = new FileCookieStore(file, 'opaque-account-a');
  await accountA.save([cookie]);
  const restored = await accountA.load();
  assert.equal(restored.ok, true);
  if (restored.ok) assert.deepEqual(restored.value, [cookie]);
  const accountB = await new FileCookieStore(file, 'opaque-account-b').load();
  assert.equal(accountB.ok, false);
  if (!accountB.ok) assert.match(accountB.error.message, /different configured account/);
});

test('legacy unbound cookie arrays are rejected and require a fresh login', async t => {
  const root = await mkdtemp(join(tmpdir(), 'continente-session-legacy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new FileCookieStore(join(root, 'session.json'), 'opaque-account-a');
  await store.save([]);
  await writeFile(join(root, 'session.json'), '[]');
  const loaded = await store.load();
  assert.equal(loaded.ok, false);
  if (!loaded.ok) assert.match(loaded.error.message, /no verified account binding/);
});
