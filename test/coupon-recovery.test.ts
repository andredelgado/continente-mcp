import assert from 'node:assert/strict';
import test from 'node:test';
import { createShoppingApplication } from '../src/runtime.js';
import { markWriteAttempted, requestIO } from '../src/session/request.js';
import { injectedServices } from '../test-support/mcp-fixture.js';
import { mutationOf, toolError } from '../test-support/assertions.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test('cancelled coupon selection reports summary recovery and never replays the write', async () => {
  const { services } = injectedServices();
  const submitted = deferred();
  let writes = 0;
  services.couponSelection = {
    async fetchCheckoutContext() { throw new Error('Unexpected recovery read'); },
    async setSelectedCoupons() {
      writes++;
      markWriteAttempted();
      submitted.resolve();
      return requestIO(() => new Promise<never>(() => {}));
    },
  };
  const app = createShoppingApplication({ version: 'test', services });
  const cancel = new AbortController();
  try {
    const call = app.dispatchToolCall('set_cart_coupons', { couponIds: ['synthetic-coupon-001'] }, { signal: cancel.signal });
    await submitted.promise;
    cancel.abort();
    const result = await call;
    assert.equal(toolError(result).code, 'cancelled');
    assert.deepEqual(mutationOf(result), {
      outcome: 'unknown', recovery: { action: 'get_checkout_summary', automaticReplay: false },
    });
    assert.match(result.content[0]?.type === 'text' ? result.content[0].text : '', /get_checkout_summary/);
    assert.equal(writes, 1);
  } finally {
    await app.close();
  }
});
