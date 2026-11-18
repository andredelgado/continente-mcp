import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const documents = { 'README.md': read('README.md'), 'docs/clients.md': read('docs/clients.md') };
const SERVER = { command: 'npx', args: ['-y', 'continentept-mcp'] };

test('the install buttons, commands and JSON add the same server, with no credentials', () => {
  const block = /"mcpServers":\s*\{\s*"continente":\s*(\{[^}]*\})/.exec(documents['docs/clients.md'])?.[1];
  assert.ok(block, 'the clients guide has no mcpServers example');
  assert.deepEqual(JSON.parse(block), SERVER);
  const decoders: [RegExp, (config: string) => unknown][] = [
    [/https:\/\/vscode\.dev\/redirect\/mcp\/install\?[^)\s]+/g, config => JSON.parse(config)],
    [/https:\/\/cursor\.com\/en\/install-mcp\?[^)\s]+/g, config => JSON.parse(Buffer.from(config, 'base64').toString('utf8'))],
    [/https:\/\/lmstudio\.ai\/install-mcp\?[^)\s]+/g, config => JSON.parse(Buffer.from(config, 'base64').toString('utf8'))],
  ];
  for (const [name, text] of Object.entries(documents)) {
    for (const [pattern, decode] of decoders) {
      const links = text.match(pattern) ?? [];
      assert.ok(links.length > 0, `${name} has no ${pattern.source} link`);
      for (const link of links) {
        const url = new URL(link);
        assert.equal(url.searchParams.get('name'), 'continente', link);
        const config = decode(url.searchParams.get('config') ?? '') as Record<string, unknown>;
        const { type, ...rest } = config;
        assert.deepEqual(rest, SERVER, link);
        assert.ok(type === undefined || type === 'stdio', link);
      }
    }
    // Every command line that starts the server starts the same package, with no environment in it.
    for (const line of text.split('\n').filter(line => /mcp add|--add-mcp|--with-extension/.test(line))) {
      assert.match(line, /continentept-mcp/, line);
      assert.doesNotMatch(line, /CONTINENTE_|--env|-e /, line);
    }
  }
});
