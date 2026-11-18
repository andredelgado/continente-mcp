import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
const link = (prefix: string) => {
  const found = readme.match(new RegExp(`\\]\\((${prefix.replaceAll('.', '\\.').replaceAll('?', '\\?')}[^)\\s]+)\\)`))?.[1];
  assert.ok(found, `the README has no ${prefix} link`);
  return new URL(found);
};

test('the VS Code and Cursor install buttons add the same server as the README configuration, with no credentials', () => {
  const block = /"mcpServers":\s*\{\s*"continente":\s*(\{[^}]*\})/.exec(readme)?.[1];
  assert.ok(block, 'the README has no mcpServers example');
  const expected = JSON.parse(block) as { command: string; args: string[] };
  const vscode = link('https://vscode.dev/redirect/mcp/install?');
  const cursor = link('https://cursor.com/en/install-mcp?');
  for (const url of [vscode, cursor]) assert.equal(url.searchParams.get('name'), 'continente');
  assert.deepEqual(JSON.parse(vscode.searchParams.get('config') ?? ''), { type: 'stdio', ...expected });
  assert.deepEqual(JSON.parse(Buffer.from(cursor.searchParams.get('config') ?? '', 'base64').toString('utf8')), expected);
  for (const url of [vscode, cursor]) assert.doesNotMatch(decodeURIComponent(url.search) + Buffer.from(url.searchParams.get('config') ?? '', 'base64').toString('latin1'), /CONTINENTE_|env/);
});
