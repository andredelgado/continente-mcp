import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, valueOf } from '../test-support/helpers.js';
import { parsePickupSlots } from '../src/parsers/pickup-slots.js';
import { PickupSlotsClient } from '../src/clients/stores.js';
import { injectedServices, connect } from '../test-support/mcp-fixture.js';

const clock = { now: () => new Date('2026-10-18T12:00:00Z') };
const window = { from: '2026-10-18', to: '2026-10-19' };

test('pickup slot parser infers year from explicit window and omits private reservation identifiers', () => {
  const parsed = valueOf(parsePickupSlots(fixture('pickup-slots'), window, clock.now()));
  assert.equal(parsed.pickupMode, 'pickup');
  assert.equal(parsed.selectedStoreId, 'synthetic-store-001');
  assert.equal(parsed.storePostalCode, '3000-001');
  assert.deepEqual(parsed.slots.map(slot => [slot.date, slot.startTime, slot.endTime, slot.shippingCost]), [
    ['2026-10-18', '12:00', '14:00', '0,00€'], ['2026-10-19', '14:00', '16:00', '2,99€'],
  ]);
  assert.equal(parsed.completeness, 'partial');
  assert.equal(parsed.slotReserved, false);
  assert.equal(parsed.selectedStoreChanged, false);
  assert.equal(JSON.stringify(parsed).includes('synthetic-scheduler'), false);
});

test('slot parser reports unknown mode rather than exposing possibly home-delivery slots', () => {
  const html = fixture('pickup-slots').replace('data-address-store="store"', 'data-address-store="home"');
  const parsed = valueOf(parsePickupSlots(html, window, clock.now()));
  assert.equal(parsed.pickupMode, 'unknown');
  assert.equal(parsed.selectedStoreId, null);
  assert.deepEqual(parsed.slots, []);
  assert.equal(parsed.completeness, 'unknown');
});

test('slot parser refuses mismatched selected radios, shipments and unbounded future years', () => {
  const selectionMismatch = fixture('pickup-slots').replace('data-selected-delivery="synthetic-store-001"', 'data-selected-delivery="synthetic-store-002"');
  const unknown = valueOf(parsePickupSlots(selectionMismatch, window, new Date('2026-10-18T12:00:00Z')));
  assert.equal(unknown.pickupMode, 'unknown');
  assert.equal(unknown.selectedStoreId, null);
  assert.deepEqual(unknown.slots, []);
  const shipmentMismatch = fixture('pickup-slots').replace('data-shipment-id="synthetic-shipment-001"\n    data-delivery-slot-url', 'data-shipment-id="synthetic-shipment-002"\n    data-delivery-slot-url');
  assert.equal(parsePickupSlots(shipmentMismatch, window, new Date('2026-10-18T12:00:00Z')).ok, false);
  assert.equal(parsePickupSlots(fixture('pickup-slots'), { from: '2030-10-18', to: '2030-10-18' }, new Date('2026-10-18T12:00:00Z')).ok, false);
});

test('slot parser leaves dates outside the requested window out and keeps malformed dates unknown', () => {
  const outside = valueOf(parsePickupSlots(fixture('pickup-slots'), { from: '2026-10-20', to: '2026-10-30' }, clock.now()));
  assert.deepEqual(outside.slots, []);
  assert.equal(outside.completeness, 'unknown');
  const malformedHtml = fixture('pickup-slots').replace('slotDateMonth":"Out', 'slotDateMonth":"Unknown');
  const malformed = valueOf(parsePickupSlots(malformedHtml, window, clock.now()));
  assert.equal(malformed.completeness, 'partial');
  assert.deepEqual(malformed.slots.map(slot => slot.date), ['2026-10-19']);
  const nextYear = valueOf(parsePickupSlots(fixture('pickup-slots').replace('slotDateMonth":"Out', 'slotDateMonth":"Jan'),
    { from: '2027-01-18', to: '2027-01-18' }, new Date('2027-01-01T12:00:00Z')));
  assert.equal(nextYear.slots[0]?.date, '2027-01-18');
});

test('slot client reads only the exact delivery page with redirects disabled', async () => {
  const calls: { url: string; maxRedirects?: number }[] = [];
  const lease = { context: { request: { async get(url: string, options: { maxRedirects?: number }) {
    calls.push({ url, ...(options.maxRedirects !== undefined ? { maxRedirects: options.maxRedirects } : {}) });
    return { ok: () => true, status: () => 200, url: () => url, async text() { return fixture('pickup-slots'); } };
  } } } };
  const site = { session: { async ensureReady() { return lease; } }, async io(_lease: unknown, operation: () => Promise<unknown>) { return operation(); } } as never;
  const client = new PickupSlotsClient(site, clock);
  assert.equal((await client.fetchPickupSlots({ from: '2026-10-18', to: '2026-11-30' })).ok, false);
  assert.equal(calls.length, 0);
  const result = await client.fetchPickupSlots(window);
  assert.equal(result.ok, true);
  assert.equal(new URL(calls[0]!.url).pathname, '/checkout/entrega/');
  assert.equal(calls[0]?.maxRedirects, 0);
  assert.equal(calls.length, 1);
});

test('list_pickup_slots advertises rendered availability without store change or reservation', async t => {
  const { services } = injectedServices();
  const { client } = await connect(t, services);
  const result = await client.callTool({ name: 'list_pickup_slots', arguments: { fromDate: window.from, toDate: window.to } });
  assert.equal(result.isError, undefined);
  const data = (result.structuredContent as { result: { data: { slots: { date: string }[]; slotReserved: boolean; selectedStoreChanged: boolean } } }).result.data;
  assert.equal(data.slots.length, 2);
  assert.equal(data.slotReserved, false);
  assert.equal(data.selectedStoreChanged, false);
  assert.match(JSON.stringify(result.content), /did not submit a store change or slot reservation/);
});
