import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, valueOf } from '../test-support/helpers.js';
import { parseCouponsPage } from '../src/parsers/coupons.js';
import { injectedServices, connect } from '../test-support/mcp-fixture.js';

test('coupon parsing preserves displayed fields and leaves eligibility and expiry unknown', () => {
  const result = valueOf(parseCouponsPage(fixture('coupons')));
  assert.equal(result.completeness, 'complete');
  assert.equal(result.coupons.length, 2);
  assert.deepEqual(result.coupons.map(coupon => coupon.couponId), ['synthetic-coupon-001', 'synthetic-coupon-002']);
  assert.equal(result.coupons[0]?.benefitValue, '5 €');
  assert.equal(result.coupons[0]?.benefitQualifier, 'em compras superiores a 25 €');
  assert.equal(result.coupons[0]?.eligibility, 'unknown');
  assert.equal(result.coupons[0]?.expiry, null);
  assert.equal(result.coupons[1]?.couponId, 'synthetic-coupon-002');
});

test('only a visible no-coupons marker establishes a complete empty list', () => {
  assert.deepEqual(valueOf(parseCouponsPage('<div class="loyalty-card-has-no-coupons">Sem cupões</div>')),
    { coupons: [], completeness: 'complete' });
  assert.equal(parseCouponsPage('<div class="loyalty-card-has-no-coupons d-none">Sem cupões</div>').ok, false);
});

test('list_coupons returns a schema-checked account read and states unknown rules', async t => {
  const { services } = injectedServices();
  const { client } = await connect(t, services);
  const result = await client.callTool({ name: 'list_coupons', arguments: {} });
  assert.equal(result.isError, undefined);
  const payload = result.structuredContent as { result: { data: { coupons: unknown[]; completeness: string } } };
  assert.equal(payload.result.data.coupons.length, 2);
  assert.equal(payload.result.data.completeness, 'complete');
  assert.match(JSON.stringify(result.content), /Cart eligibility, expiry and stacking are unknown/);
});
