import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { connect, injectedServices } from '../test-support/mcp-fixture.js';
import { dataOf, textOf } from '../test-support/assertions.js';
import { CouponSelectionData, PickupSlotsData } from '../src/mcp/contracts.js';
import { success } from '../src/domain/index.js';

test('all coupon and pickup tools return an observation time from the injected clock', async t => {
  const { services } = injectedServices();
  const { client } = await connect(t, services);
  const timestamp = services.clock!.now().toISOString();
  for (const [name, args] of [
    ['list_coupons', {}], ['get_checkout_summary', {}],
    ['set_cart_coupons', { couponIds: ['synthetic-coupon-001'] }],
    ['list_pickup_stores', { postalCode: '3000-001', latitude: 40.2, longitude: -8.4 }],
    ['list_pickup_slots', { fromDate: '2026-10-18', toDate: '2026-10-19' }],
    ['set_pickup_store', { storeId: 'synthetic-store-002', fromDate: '2026-10-18', toDate: '2026-10-19' }],
  ] as const) {
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true, name);
    assert.equal(dataOf(result, z.object({ observedAt: z.iso.datetime() })).observedAt, timestamp, name);
    if (name === 'list_pickup_slots') assert.equal(dataOf(result, PickupSlotsData).catalogView, 'unknown');
  }
});

test('pickup availability reports the observed account view without inferring it from the slot HTML', async t => {
  const { services } = injectedServices();
  let state: 'authenticated' | 'unauthenticated' | 'unknown' = 'authenticated';
  services.session.getStatus = async () => ({ browser: 'ready', credentials: { hasEmail: true, hasPassword: true },
    savedCookies: 'available', authentication: { state, checkedAt: null } });
  const { client } = await connect(t, services);
  for (const [authentication, view] of [['authenticated', 'signed_in'], ['unauthenticated', 'signed_out'], ['unknown', 'unknown']] as const) {
    state = authentication;
    const result = await client.callTool({ name: 'list_pickup_slots', arguments: { fromDate: '2026-10-18', toDate: '2026-10-19' } });
    assert.equal(dataOf(result, PickupSlotsData).catalogView, view);
  }
});

test('unknown coupon selection distinguishes previous observation from current state over MCP', async t => {
  const { services } = injectedServices();
  let writes = 0;
  services.couponSelection.setSelectedCoupons = async () => {
    writes++;
    return success({ outcome: 'unknown' as const, selectedCouponIds: null, lastObservedSelectedCouponIds: ['synthetic-old'],
      recovery: { action: 'get_checkout_summary' as const, automaticReplay: false as const } });
  };
  const { client } = await connect(t, services);
  const result = await client.callTool({ name: 'set_cart_coupons', arguments: { couponIds: ['synthetic-new'] } });
  const data = dataOf(result, CouponSelectionData);
  assert.equal(data.outcome, 'unknown');
  if (data.outcome !== 'unknown') assert.fail('Expected an uncertain result');
  assert.equal(data.selectedCouponIds, null);
  assert.deepEqual(data.lastObservedSelectedCouponIds, ['synthetic-old']);
  assert.deepEqual(data.recovery, { action: 'get_checkout_summary', automaticReplay: false });
  assert.equal(data.observedAt, services.clock!.now().toISOString());
  assert.match(textOf(result), /current selection could not be read/);
  assert.match(textOf(result), /Use get_checkout_summary/);
  assert.equal(writes, 1);
});
