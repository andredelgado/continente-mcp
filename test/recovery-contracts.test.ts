import assert from 'node:assert/strict';
import test from 'node:test';
import * as contracts from '../src/mcp/contracts.js';

const uncertain = (recovery: unknown) => ({ result: { status: 'error',
  error: { code: 'cart_change_unconfirmed', message: 'Synthetic unknown outcome', retryable: false },
  mutation: { outcome: 'unknown', recovery } } });
const cart = { action: 'get_cart', automaticReplay: false };
const coupons = { action: 'get_checkout_summary', automaticReplay: false };
const pickup = { action: 'list_pickup_slots', fromDate: '2026-10-18', toDate: '2026-10-19', automaticReplay: false };

test('existing tool errors retain the cart recovery contract', () => {
  for (const schema of [contracts.SearchOutput, contracts.ProductDetailsOutput, contracts.ChooseProductsOutput,
    contracts.LabelsOutput, contracts.FavoritesOutput, contracts.CartOutput, contracts.PreviewOutput,
    contracts.MutationOutput, contracts.ClearCartOutput, contracts.OrdersOutput, contracts.SingleOrderOutput,
    contracts.FrequencyOutput, contracts.SessionStatusOutput]) {
    assert.equal(schema.safeParse(uncertain(cart)).success, true);
    assert.equal(schema.safeParse(uncertain(coupons)).success, false);
    assert.equal(schema.safeParse(uncertain(pickup)).success, false);
  }
});

test('new mutation tools advertise only their own recovery and validate uncertain execution errors', () => {
  assert.equal(contracts.CouponSelectionOutput.safeParse(uncertain(coupons)).success, true);
  assert.equal(contracts.CouponSelectionOutput.safeParse(uncertain(cart)).success, false);
  assert.equal(contracts.CouponSelectionOutput.safeParse(uncertain(pickup)).success, false);
  assert.equal(contracts.PickupStoreChangeOutput.safeParse(uncertain(pickup)).success, true);
  assert.equal(contracts.PickupStoreChangeOutput.safeParse(uncertain(cart)).success, false);
  assert.equal(contracts.PickupStoreChangeOutput.safeParse(uncertain(coupons)).success, false);
  assert.equal(contracts.OperationExecutionErrorSchema.safeParse(uncertain(coupons)).success, true);
  assert.equal(contracts.OperationExecutionErrorSchema.safeParse(uncertain(pickup)).success, true);
});
