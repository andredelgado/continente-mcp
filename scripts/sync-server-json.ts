// After a release is published, bring server.json in the repository up to that release: the
// version, the npm package version, the extension's download URL and checksum, and the image tag. The publish
// workflow fills these in for the MCP Registry, but only in its own copy, so the repository's
// file would otherwise keep an old release. Run `npm run sync:server-json` and commit the result.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

interface ServerJson { version: string; packages: { registryType: string; identifier: string; version?: string; fileSha256?: string }[] }

const file = new URL('../../server.json', import.meta.url);
const version = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version;
const url = `https://github.com/andredelgado/continente-mcp/releases/download/v${version}/continente-mcp.mcpb`;

const response = await fetch(url);
if (!response.ok) throw new Error(`The v${version} release has no extension yet (${response.status}). Run this after the release is published.`);
const sha = createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex');

const server = JSON.parse(readFileSync(file, 'utf8')) as ServerJson;
server.version = version;
for (const entry of server.packages) {
  if (entry.registryType === 'npm') entry.version = version;
  if (entry.registryType === 'mcpb') { entry.identifier = url; entry.fileSha256 = sha; }
  if (entry.registryType === 'oci') entry.identifier = entry.identifier.replace(/:[^:/]+$/, `:${version}`);
}
writeFileSync(file, `${JSON.stringify(server, null, 2)}\n`);
console.log(`server.json now lists ${version} (extension sha256 ${sha.slice(0, 12)}…).`);
