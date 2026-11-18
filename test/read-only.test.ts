import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createShoppingApplication } from '../src/runtime.js';
import { loadSettings } from '../src/config.js';
import { injectedServices } from '../test-support/mcp-fixture.js';

import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';

const WRITES = ['add_cart_item', 'set_cart_item_quantity', 'remove_cart_item', 'clear_cart', 'set_cart_coupons'];
const absent = join(tmpdir(), 'continente-read-only-absent.env');

async function connect(t: TestContext, readOnly: string | undefined) {
  const { services, state } = injectedServices();
  const env = { CONTINENTE_CREDENTIALS_FILE: absent, ...(readOnly === undefined ? {} : { CONTINENTE_READ_ONLY: readOnly }) };
  const application = createShoppingApplication({ version: '1.0.0', services, env });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'read-only-test', version: '1' });
  await application.connect(serverTransport); await client.connect(clientTransport);
  t.after(async () => { await client.close(); await application.close(); });
  return { client, state, tools: (await client.listTools()).tools };
}

test('CONTINENTE_READ_ONLY is read from the environment or the credentials file, and an empty extension setting is off', async t => {
  const root = await mkdtemp(join(tmpdir(), 'continente-read-only-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'credentials.env');
  await writeFile(file, 'CONTINENTE_READ_ONLY=1\n');
  const settings = (env: Record<string, string>) => loadSettings({ HOME: root, CONTINENTE_CREDENTIALS_FILE: absent, ...env }).readOnly;
  assert.equal(settings({}), false);
  for (const on of ['1', 'true', ' TRUE ', 'yes', 'on']) assert.equal(settings({ CONTINENTE_READ_ONLY: on }), true, on);
  for (const off of ['0', 'false', '', 'maybe', '${user_config.read_only}']) assert.equal(settings({ CONTINENTE_READ_ONLY: off }), false, off);
  assert.equal(loadSettings({ HOME: root, CONTINENTE_CREDENTIALS_FILE: file }).readOnly, true, 'the credentials file can turn it on');
  assert.equal(loadSettings({ HOME: root, CONTINENTE_CREDENTIALS_FILE: file, CONTINENTE_READ_ONLY: '0' }).readOnly, false, 'the environment wins');
});

test('read-only mode lists only the tools that read, says so, and refuses a cart change without writing', async t => {
  const full = await connect(t, undefined);
  for (const name of WRITES) assert.ok(full.tools.some(tool => tool.name === name), `${name} is there by default`);
  assert.doesNotMatch(full.client.getInstructions() ?? '', /Read-only mode/);

  const { client, state, tools } = await connect(t, 'true');
  assert.deepEqual(tools.map(tool => tool.name), full.tools.filter(tool => !WRITES.includes(tool.name)).map(tool => tool.name));
  assert.ok(tools.every(tool => tool.annotations?.readOnlyHint === true), 'every remaining tool only reads');
  assert.ok(tools.some(tool => tool.name === 'preview_cart_changes') && tools.some(tool => tool.name === 'get_cart'));
  assert.match(client.getInstructions() ?? '', /Read-only mode: .*no tools that change the cart or the coupon selection/);
  for (const name of ['set_cart_item_quantity', 'set_cart_coupons']) {
    const args = name === 'set_cart_coupons' ? { couponIds: [] } : { productId: '00123', quantity: 1 };
    await assert.rejects(client.callTool({ name, arguments: args }), /No tool named/);
  }
  assert.equal(state.writes, 0);
});
