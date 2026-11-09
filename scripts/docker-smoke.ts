import { z } from 'zod';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const IMAGE = 'continente-mcp:smoke';
const MCP_LABEL = 'io.modelcontextprotocol.server.name';
const docker = (args: string[]) => execFileSync('docker', args, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
const metadata = z.object({ version: z.string() });
const pkg = metadata.extend({ mcpName: z.string() }).parse(JSON.parse(await readFile('package.json', 'utf8')));
const lock = z.object({ packages: z.object({ 'node_modules/playwright': metadata }) }).parse(JSON.parse(await readFile('package-lock.json', 'utf8')));
const playwrightVersion = lock.packages['node_modules/playwright'].version;
const dockerfile = await readFile('Dockerfile', 'utf8');
assert.equal(/^ARG PLAYWRIGHT_VERSION=(.+)$/m.exec(dockerfile)?.[1], playwrightVersion, 'Dockerfile Playwright version must match package-lock.json.');
assert.equal([...dockerfile.matchAll(/^FROM mcr\.microsoft\.com\/playwright:v\$\{PLAYWRIGHT_VERSION\}-noble AS (?:build|runtime)$/gm)].length, 2,
  'Both Docker stages must use the official Playwright image selected by PLAYWRIGHT_VERSION.');
const images = z.array(z.object({ Config: z.object({
  User: z.string(),
  Env: z.array(z.string()),
  Labels: z.record(z.string(), z.string().nullable()).nullable(),
}) })).nonempty().parse(JSON.parse(docker(['image', 'inspect', IMAGE])));
const config = images[0]?.Config;
assert.ok(config, 'Docker returned no image configuration.');
assert.ok(config.User && !['0', '0:0', 'root', 'root:root'].includes(config.User), `Container user must not be root: ${config.User}`);
assert.ok(config.Env.includes('CONTINENTE_DATA_DIR=/data'), 'The image must store session data in /data by default.');
assert.equal(config.Labels?.[MCP_LABEL], pkg.mcpName);
docker(['run', '--rm', '--entrypoint', 'node', IMAGE, '-e',
  "import('playwright').then(({ chromium }) => chromium.launch()).then(browser => browser.close())",
]);

const contract = z.object({ tools: z.array(z.object({ name: z.string() })).nonempty() })
  .parse(JSON.parse(await readFile('test/contract/tools.json', 'utf8')));
const expectedTools = contract.tools.map(tool => tool.name).sort();
const volume = `continente-docker-smoke-${process.pid}`;
docker(['volume', 'create', volume]);
try {
  const transport = new StdioClientTransport({ command: 'docker', args: [
    'run', '-i', '--rm', '--volume', `${volume}:/data`,
    '--env', 'CONTINENTE_CREDENTIALS_FILE=/data/missing.env', '--env', 'CONTINENTE_EMAIL=', '--env', 'CONTINENTE_PASSWORD=',
    '--env', 'CONTINENTE_UPDATE_CHECK=0', IMAGE,
  ], stderr: 'inherit' });
  const client = new Client({ name: 'docker-image-check', version: '1' });
  try {
    await client.connect(transport);
    assert.equal(client.getServerVersion()?.version, pkg.version);
    const actualTools = (await client.listTools()).tools.map(tool => tool.name).sort();
    assert.deepEqual(actualTools, expectedTools);
    console.log(`Docker image verified: Playwright ${playwrightVersion}, Chromium launch, user ${config.User}, ${actualTools.length} tools, stdio and isolated data volume.`);
  } finally { await client.close(); }
} finally {
  try { docker(['volume', 'rm', volume]); } catch { /* Best-effort cleanup after a failed container start. */ }
}
