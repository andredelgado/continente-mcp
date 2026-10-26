import assert from 'node:assert/strict';
import test from 'node:test';
import { PickupStoreSelectionClient } from '../src/clients/stores.js';
import { allowedPickupStoreContextRequest, allowedCartMutation, allowedCouponMutation } from '../src/clients/policy.js';
import { parsePickupStoreMutationContext, pickupStoreReadbackConfirms } from '../src/parsers/pickup-store-selection.js';
import { withAuthenticationRecovery } from '../src/services/recovery.js';
import { RequestStopped, markWriteAttempted } from '../src/session/request.js';
import { connect, injectedServices } from '../test-support/mcp-fixture.js';
import { fixture, valueOf } from '../test-support/helpers.js';

const clock = { now: () => new Date('2026-10-18T12:00:00Z') };
const window = { from: '2026-10-18', to: '2026-10-25' };
const delivery = fixture('pickup-store-context');
const updated = delivery.replace('data-current-shipment-store="synthetic-store-001"', 'data-current-shipment-store="synthetic-store-002"')
  .replace('data-selected-delivery="synthetic-store-001"', 'data-selected-delivery="synthetic-store-002"')
  .replace('value="synthetic-store-001" checked>', 'value="synthetic-store-001">')
  .replace('value="synthetic-store-002">', 'value="synthetic-store-002" checked>');
const coverage = { error: false, data: { storeId: 8123, physicalStoreId: 8124, areaID: 8125, storeID: 8126 } };

function validChoice(html = delivery) {
  const parsed = valueOf(parsePickupStoreMutationContext(html));
  assert.equal(parsed.options.length, 2);
  assert.equal(parsed.selectedRadioStoreId, 'synthetic-store-001');
  assert.equal('shipmentUuid' in parsed, false);
  return parsed;
}

test('pickup context actions allow only exact coverage GET and store context POST', () => {
  const base = 'https://www.continente.pt/on/demandware.store/Sites-continente-Site/default/';
  assert.equal(allowedPickupStoreContextRequest(`${base}Stores-GetCoverageArea`, 'GET'), true);
  assert.equal(allowedPickupStoreContextRequest(`${base}Stores-SetStoreContext`, 'POST'), true);
  for (const [url, method] of [
    [`${base}Stores-GetCoverageArea`, 'POST'], [`${base}Stores-SetStoreContext`, 'GET'],
    [`${base}Stores-SetStoreContext/extra`, 'POST'], [`${base}Stores-SetStoreContext?storeId=x`, 'POST'],
    ['https://attacker.invalid/on/demandware.store/Sites-continente-Site/default/Stores-SetStoreContext', 'POST'],
    [`${base}CheckoutServices-UpdateShipmentAddress`, 'POST'],
  ] as const) assert.equal(allowedPickupStoreContextRequest(url, method), false, `${method} ${url}`);
  assert.equal(allowedCartMutation(`${base}Stores-SetStoreContext`, 'POST'), false);
  assert.equal(allowedCouponMutation(`${base}Stores-SetStoreContext`, 'POST'), false);
});

test('primary pickup choice parser binds one primary step to fresh exact radio rows', () => {
  const parsed = validChoice();
  assert.equal(parsed.options[1]?.name, 'Synthetic Store Two');
  assert.equal(parsed.options[1]?.postalCode, '0000-002');
  assert.equal(parsed.options[1]?.latitude, '40.2002');
  assert.equal(parsed.options[1]?.addressId, 'synthetic-address-002');
  assert.equal(valueOf(pickupStoreReadbackConfirms(updated, 'synthetic-store-002'))?.storeId, 'synthetic-store-002');
  assert.equal(valueOf(pickupStoreReadbackConfirms(delivery, 'synthetic-store-002')), null);
  assert.equal(parsePickupStoreMutationContext(delivery.replace('data-is-primary="true"', 'data-is-primary="false"')).ok, false);
  assert.equal(parsePickupStoreMutationContext(`${delivery}<section class="step-type--address"></section>`).ok, false);
  assert.equal(parsePickupStoreMutationContext(delivery.replace('value="synthetic-store-002"', 'value="other-store"')).ok, false);
  assert.equal(parsePickupStoreMutationContext(delivery.replace('data-current-shipment-store="synthetic-store-001"', 'data-current-shipment-store="other-store"')).ok, false);
  assert.equal(parsePickupStoreMutationContext(delivery.replace('data-address-store="store"', 'data-address-store="home"')).ok, false);
});

test('store context client gets coverage, posts once with fresh row fields, then verifies raw delivery readback', async () => {
  const calls: { method: string; url: string; params?: Record<string, unknown>; maxRedirects?: number }[] = [];
  let deliveryReads = 0;
  const lease = { context: { request: {
    async get(url: string, options: { maxRedirects?: number }) {
      calls.push({ method: 'GET', url, ...(options.maxRedirects === undefined ? {} : { maxRedirects: options.maxRedirects }) });
      if (url.includes('Stores-GetCoverageArea')) return { ok: () => true, status: () => 200, url: () => url, async json() { return coverage; } };
      deliveryReads++;
      return { ok: () => true, status: () => 200, url: () => url, async text() { return deliveryReads === 1 ? delivery : updated; } };
    },
    async post(url: string, options: { form: Record<string, string>; maxRedirects?: number }) {
      calls.push({ method: 'POST', url, params: options.form, ...(options.maxRedirects === undefined ? {} : { maxRedirects: options.maxRedirects }) });
      return { ok: () => true, status: () => 200, url: () => url, async json() { return { success: true }; } };
    },
  } } };
  const site = { session: { async ensureReady() { return lease; } }, async io(_lease: unknown, operation: () => Promise<unknown>) { return operation(); } } as never;
  const result = await new PickupStoreSelectionClient(site, clock).setPickupStore('synthetic-store-002', window);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.outcome, 'confirmed');
    assert.equal(result.value.selectedStoreChanged, true);
    assert.equal(result.value.cartAndCouponsNeedRevalidation, true);
  }
  assert.deepEqual(calls.map(call => call.method), ['GET', 'GET', 'POST', 'GET']);
  assert.equal(calls.filter(call => call.method === 'POST').length, 1);
  assert.equal(new URL(calls[1]!.url).searchParams.get('postalCode'), '0000-002');
  assert.deepEqual(calls[2]?.params, { city: 'Test City', storeId: '8123', physicalStoreId: '8124', areaID: '8125', storeID: '8126',
    storeInfo: 'Synthetic Store Two', storePostalCode: '0000-002', latitude: '40.2002', longitude: '-8.4002',
    searchLatitude: '40.2002', searchLongitude: '-8.4002', ID: 'synthetic-store-002',
    selectedAddressId: 'synthetic-address-002', checkOutChange: 'true' });
  assert.equal(calls.every(call => call.maxRedirects === 0), true);
  assert.equal(JSON.stringify(calls).includes('shipmentUuid'), false);
  assert.equal(JSON.stringify(calls).includes('synthetic-shipment'), false);
});

test('uncertain and rejected store writes are never replayed and only explicit rejection plus old readback is not_applied', async () => {
  for (const mode of ['lost', 'rejected'] as const) {
    let posts = 0; let reads = 0;
    const lease = { context: { request: {
      async get(url: string) {
        if (url.includes('Stores-GetCoverageArea')) return { ok: () => true, status: () => 200, url: () => url, async json() { return coverage; } };
        reads++;
        return { ok: () => true, status: () => 200, url: () => url, async text() { return delivery; } };
      },
      async post(url: string) {
        posts++;
        if (mode === 'lost') throw new Error('synthetic connection lost');
        return { ok: () => true, status: () => 200, url: () => url, async json() { return { success: false }; } };
      },
    } } };
    const site = { session: { async ensureReady() { return lease; } }, async io(_lease: unknown, operation: () => Promise<unknown>) { return operation(); } } as never;
    const result = await new PickupStoreSelectionClient(site, clock).setPickupStore('synthetic-store-002', window);
    assert.equal(result.ok, true);
    if (!result.ok) continue;
    assert.equal(result.value.outcome, mode === 'rejected' ? 'not_applied' : 'unknown');
    assert.equal(posts, 1);
    assert.equal(reads, 2);
    if (result.value.outcome === 'unknown') assert.deepEqual(result.value.recovery, {
      action: 'list_pickup_slots', fromDate: window.from, toDate: window.to, automaticReplay: false });
  }
});

test('invalid context and invalid coverage stop before mutation', async () => {
  let posts = 0;
  const lease = { context: { request: {
    async get(url: string) {
      if (url.includes('Stores-GetCoverageArea')) return { ok: () => true, status: () => 200, url: () => url, async json() { return { error: false, data: { storeId: 1 } }; } };
      return { ok: () => true, status: () => 200, url: () => url, async text() { return delivery; } };
    }, async post() { posts++; throw new Error('must not post'); },
  } } };
  const site = { session: { async ensureReady() { return lease; } }, async io(_lease: unknown, operation: () => Promise<unknown>) { return operation(); } } as never;
  const client = new PickupStoreSelectionClient(site, clock);
  const missing = await client.setPickupStore('synthetic-store-999', window);
  assert.equal(missing.ok, false);
  const badCoverage = await client.setPickupStore('synthetic-store-002', window);
  assert.equal(badCoverage.ok, false);
  assert.equal(posts, 0);
});

test('HTTP 401 after the store POST is unknown and does not trigger credential recovery or replay', async () => {
  let posts = 0; let refreshes = 0; let deliveryReads = 0;
  const lease = { context: { request: {
    async get(url: string) {
      if (url.includes('Stores-GetCoverageArea')) return { ok: () => true, status: () => 200, url: () => url, async json() { return coverage; } };
      deliveryReads++;
      return { ok: () => true, status: () => 200, url: () => url, async text() { return delivery; } };
    }, async post(url: string) {
      posts++;
      return { ok: () => false, status: () => 401, url: () => url, async json() { return {}; } };
    },
  } } };
  const site = { session: { async ensureReady() { return lease; }, recordAuthentication() {} }, async io(_lease: unknown, operation: () => Promise<unknown>) { return operation(); } } as never;
  const client = new PickupStoreSelectionClient(site, clock);
  const result = await withAuthenticationRecovery(() => client.setPickupStore('synthetic-store-002', window), async () => { refreshes++; return true; });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.outcome, 'unknown');
  assert.equal(posts, 1);
  assert.equal(deliveryReads, 2);
  assert.equal(refreshes, 0);
});

test('cancelled pickup-store write recovery includes the caller window and forbids replay', async t => {
  const { services } = injectedServices(); let writes = 0;
  services.pickupStoreSelection = { async setPickupStore() {
    writes++; markWriteAttempted(); throw new RequestStopped('deadline_exceeded');
  } };
  const { client } = await connect(t, services);
  const result = await client.callTool({ name: 'set_pickup_store', arguments: {
    storeId: 'synthetic-store-002', fromDate: window.from, toDate: window.to,
  } });
  assert.equal(result.isError, true);
  const mutation = (result.structuredContent as { result: { mutation: { outcome: string; recovery: unknown } } }).result.mutation;
  assert.equal(mutation.outcome, 'unknown');
  assert.deepEqual(mutation.recovery, { action: 'list_pickup_slots', fromDate: window.from, toDate: window.to, automaticReplay: false });
  assert.equal(writes, 1);
});
