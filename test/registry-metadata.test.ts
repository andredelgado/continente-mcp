import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { present } from '../test-support/helpers.js';

import assert from 'node:assert/strict';
import test from 'node:test';

const read = (path: string): unknown => JSON.parse(readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8'));
const pkg = z.object({ name: z.string(), mcpName: z.string() }).parse(read('package.json'));
const server = z.object({
  name: z.string(), description: z.string(),
  packages: z.array(z.object({ registryType: z.string(), identifier: z.string(), environmentVariables: z.array(z.object({ name: z.string() })).optional() })),
}).parse(read('server.json'));
const configuration = readFileSync(new URL('../../docs/configuration.md', import.meta.url), 'utf8');

test('MCP Registry metadata matches the npm package', () => {
  assert.equal(server.name, pkg.mcpName);
  assert.match(server.name, /^io\.github\.andredelgado\//);
  assert.ok(server.description.length <= 100, 'the registry limits descriptions to 100 characters');
  const npm = server.packages.find(entry => entry.registryType === 'npm');
  assert.equal(npm?.identifier, pkg.name);
  for (const variable of npm?.environmentVariables ?? []) assert.ok(configuration.includes(variable.name), `${variable.name} is not documented`);
});

test('the listed extension points at the release asset the workflow uploads', () => {
  const extension = server.packages.find(entry => entry.registryType === 'mcpb');
  assert.match(present(extension).identifier, /^https:\/\/github\.com\/andredelgado\/continente-mcp\/releases\/download\/v[^/]+\/continente-mcp\.mcpb$/);
});

test('the listed image is the one the workflow pushes, run the way the docs say', () => {
  const image = z.object({ identifier: z.string(), runtimeHint: z.string(), runtimeArguments: z.array(z.object({ type: z.literal('positional'), value: z.string() })),
    environmentVariables: z.array(z.object({ name: z.string() })) })
    .parse(z.object({ packages: z.array(z.looseObject({ registryType: z.string() })) }).parse(read('server.json')).packages.find(entry => entry.registryType === 'oci'));
  assert.match(image.identifier, /^ghcr\.io\/andredelgado\/continente-mcp:[^:/]+$/);
  assert.equal(image.runtimeHint, 'docker');
  // The registry checks this label against the server name before it lists the image.
  const label = /^LABEL io\.modelcontextprotocol\.server\.name="([^"]+)"$/m.exec(readFileSync(new URL('../../Dockerfile', import.meta.url), 'utf8'));
  assert.equal(label?.[1], pkg.mcpName);
  assert.deepEqual(image.runtimeArguments.map(argument => argument.value), ['--init', '--ipc=host', '--volume=continente:/data']);
  for (const flag of ['--init', '--ipc=host', 'continente:/data']) assert.ok(configuration.includes(flag), `${flag} is not in the Docker docs`);
  assert.deepEqual(image.environmentVariables.map(variable => variable.name), ['CONTINENTE_EMAIL', 'CONTINENTE_PASSWORD']);
});

test('server.json names one release throughout: its version, the npm package and the extension', () => {
  const listing = z.object({ version: z.string(), packages: z.array(z.object({ registryType: z.string(), identifier: z.string(), version: z.string().optional(), fileSha256: z.string().optional() })) })
    .parse(read('server.json'));
  const npm = present(listing.packages.find(entry => entry.registryType === 'npm'));
  const extension = present(listing.packages.find(entry => entry.registryType === 'mcpb'));
  assert.equal(npm.version, listing.version);
  assert.ok(extension.identifier.includes(`/download/v${listing.version}/`), 'the extension URL is for another release');
  assert.match(extension.fileSha256 ?? '', /^[0-9a-f]{64}$/);
  const image = present(listing.packages.find(entry => entry.registryType === 'oci'));
  assert.ok(image.identifier.endsWith(`:${listing.version}`), 'the image tag is for another release');
});
