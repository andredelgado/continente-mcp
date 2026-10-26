import { validatorSchema, dataOf, mutationOf, recoveryOf, statusOf } from '../test-support/assertions.js';
import { z } from 'zod';
import type { TestContext } from 'node:test';
import { InitializeResultSchema, ListToolsResultSchema, CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { present } from '../test-support/helpers.js';
import { CartData, FrequencyData, OrdersData } from '../src/mcp/contracts.js';
import { MutationData } from '../src/mcp/contracts.js';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';

import assert from 'node:assert/strict';
import test from 'node:test';

const WireResponseSchema = z.object({ jsonrpc: z.literal('2.0'), id: z.number(), result: z.unknown().optional(), error: z.object({ code: z.number(), message: z.string() }).optional() });
type WireResponse = z.output<typeof WireResponseSchema>;
const resultSchemas = { initialize: InitializeResultSchema, 'tools/list': ListToolsResultSchema, 'tools/call': CallToolResultSchema };
async function wire(t: TestContext, scenario = 'normal', protocolVersion = '2025-06-18') {
  const root = await mkdtemp(join(tmpdir(), 'continente stdio ')); const file = join(root, 'metrics.json');
  const child = spawn(process.execPath, [fileURLToPath(new URL('../test-support/stdio-server.js', import.meta.url))], {
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|SYSTEMROOT|WINDIR)$/i.test(key))),
      HOME: root, USERPROFILE: root, FIXTURE_METRICS: file, FIXTURE_SCENARIO: scenario }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map<number, (response: WireResponse) => void>(); const invalid: string[] = []; const notifications: unknown[] = []; let id = 0; let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    try { const message = z.object({ jsonrpc: z.literal('2.0'), id: z.number().optional() }).passthrough().parse(JSON.parse(line));
      if (message.id !== undefined) { pending.get(message.id)?.(WireResponseSchema.parse(message)); pending.delete(message.id); }
      else notifications.push(message);
    } catch { invalid.push(line); }
  });
  const send = (value: Record<string, unknown>) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
  const request = (method: string, params: Record<string, unknown>) => { const requestId = ++id; const promise = new Promise<WireResponse>(resolve => pending.set(requestId, resolve)); send({ id: requestId, method, params }); return { id: requestId, promise }; };
  const ask = async <M extends keyof typeof resultSchemas>(method: M, params: Record<string, unknown>): Promise<z.output<(typeof resultSchemas)[M]>> => {
    const response = await request(method, params).promise;
    assert.equal(response.error, undefined, JSON.stringify(response.error));
    return resultSchemas[method].parse(response.result) as z.output<(typeof resultSchemas)[M]>;
  };
  const closed = once(child, 'exit');
  t.after(async () => { if (child.exitCode === null) { child.stdin.end(); await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 2000))]); if (child.exitCode === null) child.kill(); }
    await closed; assert.deepEqual(invalid, [], 'stdout must contain only JSON-RPC'); await rm(root, { recursive: true, force: true }); });
  const init = await ask('initialize', { protocolVersion, capabilities: {}, clientInfo: { name: 'raw-stdio-test', version: '1' } });
  assert.equal(init.protocolVersion, protocolVersion); send({ method: 'notifications/initialized' });
  return { ask, request, send, child, closed, notifications, metrics: async () => JSON.parse(await readFile(file, 'utf8')), stderr: () => stderr };
}

test('all tools serialize advertised outputs through real stdio, preserving quantity and scan semantics', { timeout: 15000 }, async t => {
  const io = await wire(t); const tools = (await io.ask('tools/list', {})).tools; assert.equal(tools.length, 21);
  const validator = new AjvJsonSchemaValidator();
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await io.ask('tools/call', { name, arguments: args });
    assert.equal(validator.getValidator(validatorSchema(present(present(tools.find(tool => tool.name === name)).outputSchema)))(result.structuredContent).valid, true, name); return result;
  };
  for (const tool of tools) {
    assert.equal(tool.inputSchema.additionalProperties, false); assert.ok(tool.outputSchema); assert.ok(tool.annotations);
    const args = tool.name === 'search_products' ? { query: 'milk' } : tool.name === 'set_cart_coupons' ? { couponIds: [] } : tool.name === 'list_pickup_stores' ? { postalCode: '3000-001', latitude: 40.2, longitude: -8.4 } : tool.name === 'list_pickup_slots' ? { fromDate: '2026-10-18', toDate: '2026-10-19' } : tool.name === 'set_pickup_store' ? { storeId: 'synthetic-store-002', fromDate: '2026-10-18', toDate: '2026-10-19' } : tool.name === 'add_cart_item' ? { productId: '00123', quantity: 1 } :
      tool.name === 'set_cart_item_quantity' ? { productId: '00123', quantity: 0 } :
      ['remove_cart_item', 'get_product'].includes(tool.name) ? { productId: '00123' } : tool.name === 'get_order' ? { orderId: 'first' } :
      tool.name === 'preview_cart_changes' ? { items: [{ productId: '00123', quantity: 1 }] } :
      tool.name === 'get_product_labels' ? { productIds: ['00123'] } :
      tool.name === 'clear_cart' ? { confirm: true } :
      tool.name === 'choose_products' ? { decisions: [{ question: 'Milk', productIds: ['00123', '00123'] }] } : {};
    await call(tool.name, args);
  }
  const empty = await call('get_cart'); assert.deepEqual(dataOf(empty, CartData).items, []);
  const add = await call('add_cart_item', { productId: '00123', quantity: 2 }); assert.equal(dataOf(add, MutationData).confirmedQuantity.value, 2);
  const set = await call('set_cart_item_quantity', { productId: '00123', quantity: 5 }); assert.equal(dataOf(set, MutationData).confirmedQuantity.value, 5);
  const before = (await io.metrics()).detailReads;
  await call('list_frequently_bought_products', { orderLimit: 1 }); assert.equal((await io.metrics()).detailReads - before, 1);
  const ranked = await call('list_frequently_bought_products', { orderLimit: 2, limit: 1 }); assert.equal(dataOf(ranked, FrequencyData).products.length, 1);
  const invalid = await io.request('tools/call', { name: 'add_cart_item', arguments: { productId: '00123', quantity: 0 } }).promise;
  assert.equal(present(invalid.error).code, -32602);
  const unknown = await io.request('tools/call', { name: 'missing', arguments: {} }).promise; assert.equal(present(unknown.error).code, -32602);
});
test('the 2024-11-05 protocol retains structured uncertain-write recovery', { timeout: 10000 }, async t => {
  const io = await wire(t, 'uncertain', '2024-11-05');
  const result = await io.ask('tools/call', { name: 'add_cart_item', arguments: { productId: '00123' } });
  assert.equal(result.isError, true); assert.equal(mutationOf(result).outcome, 'unknown');
  assert.deepEqual(recoveryOf(result), { action: 'get_cart', automaticReplay: false });
  assert.equal((await io.metrics()).writes, 1);
});
test('stdio cancellation and EOF discard queued writes', { timeout: 10000 }, async t => {
  const io = await wire(t, 'stall'); const active = io.request('tools/call', { name: 'get_cart', arguments: {} });
  // An independent protocol request acts as a barrier after the active request was dispatched.
  await io.ask('tools/list', {});
  const queued = io.request('tools/call', { name: 'add_cart_item', arguments: { productId: '00123' } });
  io.send({ method: 'notifications/cancelled', params: { requestId: queued.id, reason: 'fixture cancellation' } });
  await io.ask('tools/list', {});
  assert.equal((await io.metrics()).waiting, true);
  assert.equal((await io.metrics()).writes, 0);
  io.request('tools/call', { name: 'add_cart_item', arguments: { productId: '00123' } });
  await io.ask('tools/list', {});
  io.child.stdin.end(); await io.closed;
  const metrics = await io.metrics(); assert.equal(metrics.writes, 0); assert.equal(metrics.closed, true); assert.equal(metrics.cartReads, 1);
});

test('partial order results retain successful lines and failure metadata over stdio', { timeout: 10000 }, async t => {
  const io = await wire(t, 'partial');
  const result = await io.ask('tools/call', { name: 'list_orders', arguments: {} });
  assert.equal(statusOf(result), 'partial');
  assert.equal(present(dataOf(result, OrdersData).orders[0]).lines.status, 'available');
  assert.equal(present(dataOf(result, OrdersData).orders[1]).lines.status, 'unavailable');
  const tools = (await io.ask('tools/list', {})).tools;
  assert.equal(new AjvJsonSchemaValidator().getValidator(validatorSchema(present(present(tools.find(tool => tool.name === 'list_orders')).outputSchema)))(result.structuredContent).valid, true);
});
