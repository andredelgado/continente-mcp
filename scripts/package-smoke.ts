import { z } from 'zod';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const TOOL_COUNT = 21;
const root = await mkdtemp(join(tmpdir(), 'continente installed package '));
const npm = process.env.npm_execpath;
assert.ok(npm, 'Run through npm run test:package');
const runNpm = (args: string[], cwd = process.cwd()) => execFileSync(process.execPath, [npm, ...args], { cwd, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
try {
  const metadata = z.object({ version: z.string() });
  const pkg = metadata.extend({ name: z.string() }).parse(JSON.parse(await readFile('package.json', 'utf8')));
  const lock = metadata.extend({ packages: z.object({ '': metadata }) }).parse(JSON.parse(await readFile('package-lock.json', 'utf8')));
  assert.equal(pkg.version, lock.version); assert.equal(pkg.version, lock.packages[''].version);
  const packed = z.array(z.object({ filename: z.string(), files: z.array(z.object({ path: z.string() })) })).nonempty().parse(JSON.parse(runNpm(['pack', '--json', '--pack-destination', root])));
  const archive = packed[0]; assert.ok(archive);
  const paths = new Set(archive.files.map(file => file.path));
  for (const required of ['dist/cli.js', 'dist/index.js', 'dist/index.d.ts', 'skills/basket-planner/SKILL.md',
    'docs/tools.md', 'docs/configuration.md', 'docs/troubleshooting.md', '.env.example', 'CHANGELOG.md', 'README.md', 'LICENSE']) assert.ok(paths.has(required), required);
  assert.ok(![...paths].some(path => /^(test\/|test-support\/|node_modules\/|build\/|scripts\/)|(^|\/)(cookies\.json|credentials\.env|preferences\.json)$/.test(path)));
  await writeFile(join(root, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  runNpm(['install', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', join(root, archive.filename)], root);
  const installed = join(root, 'node_modules', ...pkg.name.split('/'));
  assert.ok((await readFile(join(installed, 'dist/cli.js'), 'utf8')).startsWith('#!/usr/bin/env node\n'));
  if (process.platform !== 'win32') assert.ok((await stat(join(installed, 'dist/cli.js'))).mode & 0o111);
  const bin = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'continentept-mcp.cmd' : 'continentept-mcp');
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|SYSTEMROOT|WINDIR|PATHEXT)$/i.test(key))),
    HOME: root, USERPROFILE: root, CONTINENTE_CREDENTIALS_FILE: join(root, 'missing.env'), CONTINENTE_DATA_DIR: join(root, 'state'), CONTINENTE_EMAIL: '', CONTINENTE_PASSWORD: '', CONTINENTE_UPDATE_CHECK: '0' };
  const transport = new StdioClientTransport({ command: bin, env, stderr: 'pipe' });
  const client = new Client({ name: 'installed-package-check', version: '1' });
  try {
    await client.connect(transport); assert.equal(client.getServerVersion()?.version, pkg.version);
    assert.equal((await client.listTools()).tools.length, TOOL_COUNT);
    assert.match(client.getInstructions() ?? '', /get_cart/);
    assert.deepEqual((await client.listPrompts()).prompts.map(prompt => prompt.name), ['basket-planner']);
    const result = await client.callTool({ name: 'get_session_status', arguments: {} });
    const status = z.object({ result: z.object({ status: z.literal('success'), data: z.object({ browser: z.literal('closed'), credentials: z.object({ hasEmail: z.literal(false) }) }) }) }).parse(result.structuredContent);
    assert.equal(status.result.data.browser, 'closed');
    assert.equal(status.result.data.credentials.hasEmail, false);
    await assert.rejects(client.callTool({ name: 'search_products', arguments: { query: '' } }));
  } finally { await client.close(); }
  console.log(`Installed package verified: ${process.platform}, Node ${process.version}, ${archive.files.length} files, ${TOOL_COUNT} tools, instructions and prompt, npm bin, isolated state.`);
} finally { await rm(root, { recursive: true, force: true }); }
