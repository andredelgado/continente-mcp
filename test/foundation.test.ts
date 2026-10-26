import { present } from '../test-support/helpers.js';
import { textOf } from '../test-support/assertions.js';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createApplication } from '../src/index.js';

import assert from 'node:assert/strict';

import test from 'node:test';

const root = fileURLToPath(new URL('../../', import.meta.url));
const packageVersion = z.object({ version: z.string() }).parse(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))).version;
const isolatedEnv = (dir: string) => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|SYSTEMROOT|WINDIR)$/i.test(key))),
  HOME: dir,
  USERPROFILE: dir,
  CONTINENTE_CREDENTIALS_FILE: join(dir, 'unreadable-credentials'),
  CONTINENTE_UPDATE_CHECK: '0',
});

test('compiled CLI responds through stdio, including npm-style symlinks', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'continente cli '));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const entry = join(root, 'dist/cli.js');
  assert.ok(readFileSync(entry, 'utf8').startsWith('#!/usr/bin/env node\n'));
  if (process.platform !== 'win32') assert.equal(statSync(entry).mode & 0o111, 0o111);
  const entries = [entry];
  if (process.platform !== 'win32') {
    const bin = join(dir, 'continentept-mcp');
    symlinkSync(entry, bin);
    entries.push(bin);
  }
  for (const script of entries) {
    const transport = new StdioClientTransport({
      command: process.execPath, args: [script], env: isolatedEnv(dir), stderr: 'pipe',
    });
    const client = new Client({ name: 'foundation-test', version: '1' });
    try {
      await client.connect(transport);
      assert.equal(present(client.getServerVersion()).name, 'continentept-mcp');
      assert.equal(present(client.getServerVersion()).version, packageVersion);
      assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), [
        'search_products', 'get_product', 'choose_products', 'get_product_labels', 'list_favorites', 'get_cart', 'preview_cart_changes', 'get_checkout_summary', 'list_coupons', 'set_cart_coupons', 'list_pickup_stores', 'list_pickup_slots', 'set_pickup_store', 'add_cart_item', 'set_cart_item_quantity',
        'remove_cart_item', 'clear_cart', 'list_orders', 'get_order', 'list_frequently_bought_products', 'get_session_status',
      ]);
      await assert.rejects(client.callTool({ name: 'nonexistent', arguments: {} }), { code: -32602 });
    } finally {
      await client.close();
    }
  }
});

test('library and domain imports exit without starting stdio or reading credentials', t => {
  const dir = mkdtempSync(join(tmpdir(), 'continente-import-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'unreadable-credentials'), '', { mode: 0o000 });
  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    'await import("./dist/index.js"); await import("./dist/domain/result.js"); await import("./dist/cli.js");'], {
    cwd: root, env: isolatedEnv(dir), encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

test('login command works from a path with spaces without real credentials', t => {
  const dir = mkdtempSync(join(tmpdir(), 'continente login '));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const entry = join(root, 'dist/cli.js');
  const script = process.platform === 'win32' ? entry : join(dir, 'continente mcp.js');
  if (process.platform !== 'win32') symlinkSync(entry, script);
  const result = spawnSync(process.execPath, [script, 'login'], { encoding: 'utf8', timeout: 10000,
    env: { ...isolatedEnv(dir), CONTINENTE_EMAIL: '', CONTINENTE_PASSWORD: '' } });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /CONTINENTE_EMAIL and CONTINENTE_PASSWORD/);
});

test('CLI prints help and version and rejects unknown commands', () => {
  const run = (...args: string[]) => spawnSync(process.execPath, [join(root, 'dist/cli.js'), ...args], { encoding: 'utf8', timeout: 10000 });
  assert.equal(run('--version').stdout.trim(), packageVersion);
  assert.match(run('--help').stdout, /install-browser/);
  const unknown = run('frobnicate'); assert.equal(unknown.status, 2); assert.match(unknown.stderr, /Unknown command/);
});

test('transport dispatches injected handlers and turns failures into protocol results', async () => {
  let closes = 0;
  const application = createApplication({ version: 'test', closeResources: async () => { closes++; }, tools: [{
    definition: { name: 'echo' }, inputSchema: z.looseObject({}),
    async execute(raw) {
      const input = z.looseObject({}).parse(raw);
      if (input.fail) throw new Error('Expected failure');
      return { content: [{ type: 'text', text: String(input.value) }] };
    },
  }] });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'injected-test', version: '1' });
  try {
    await application.connect(serverTransport);
    await client.connect(clientTransport);
    assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['echo']);
    assert.equal(textOf((await client.callTool({ name: 'echo', arguments: { value: 'hello' } }))), 'hello');
    assert.equal((await client.callTool({ name: 'echo', arguments: { fail: true } })).isError, true);
    assert.equal(textOf((await client.callTool({ name: 'echo', arguments: { value: 'after failure' } }))), 'after failure');
  } finally {
    await client.close();
    await application.close();
  }
  assert.equal(closes, 1);
});

test('empty low-level application can connect, list and reject unknown tools', async () => {
  const app = createApplication({ version: 'test' });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'empty-test', version: '1' });
  try {
    await app.connect(serverTransport); await client.connect(clientTransport);
    assert.deepEqual((await client.listTools()).tools, []);
    await assert.rejects(client.callTool({ name: 'missing' }), { code: -32602 });
  } finally { await client.close(); await app.close(); }
});
