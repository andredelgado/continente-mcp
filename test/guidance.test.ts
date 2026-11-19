import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { BASKET_PLANNER_GUIDE, LABEL_CHECK_GUIDE, SERVER_INSTRUCTIONS } from '../src/mcp/guide.js';
import { createApplication } from '../src/application.js';
import { injectedServices, connect } from '../test-support/mcp-fixture.js';
import { present } from '../test-support/helpers.js';

import assert from 'node:assert/strict';
import test from 'node:test';

const GUIDES = { 'basket-planner': BASKET_PLANNER_GUIDE, 'label-check': LABEL_CHECK_GUIDE };

test('each prompt and its bundled skill carry the same guide', () => {
  for (const [name, guide] of Object.entries(GUIDES)) {
    const skill = readFileSync(new URL(`../../skills/${name}/SKILL.md`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(skill);
    assert.match(present(frontmatter?.[1]), new RegExp(`^name: ${name}$`, 'm'));
    assert.match(present(frontmatter?.[1]), /^description: .{40,}$/m);
    assert.equal(skill.slice(present(frontmatter)[0].length).trim(), guide, name);
  }
});

test('clients receive the cart rules as server instructions and the guide as a prompt', async t => {
  const { services, state } = injectedServices(); const { client } = await connect(t, services);
  assert.equal(client.getInstructions(), SERVER_INSTRUCTIONS);
  assert.ok(client.getServerCapabilities()?.prompts);
  const prompts = (await client.listPrompts()).prompts;
  assert.deepEqual(prompts.map(prompt => prompt.name), Object.keys(GUIDES));
  for (const prompt of prompts) {
    assert.deepEqual(prompt.arguments?.map(argument => [argument.name, argument.required ?? false]), [['request', false]]);
    const guide = GUIDES[prompt.name as keyof typeof GUIDES];
    const plain = await client.getPrompt({ name: prompt.name });
    assert.deepEqual(plain.messages, [{ role: 'user', content: { type: 'text', text: guide } }]);
    const asked = present((await client.getPrompt({ name: prompt.name, arguments: { request: '  weekly basket for two ' } })).messages[0]);
    assert.equal(asked.content.type === 'text' && asked.content.text, `${guide}\n\n## Request\n\nweekly basket for two`);
  }
  assert.match(SERVER_INSTRUCTIONS, /label-check prompt/);
  assert.equal(state.reads, 0); assert.equal(state.writes, 0);
});

test('every tool named in the instructions and the guide exists', async t => {
  const { services } = injectedServices(); const { client } = await connect(t, services);
  const tools = new Set((await client.listTools()).tools.map(tool => tool.name));
  const mentioned = new Set(`${SERVER_INSTRUCTIONS}\n${BASKET_PLANNER_GUIDE}\n${LABEL_CHECK_GUIDE}`.match(/\b(?:search|get|list|add|set|remove)_[a-z_]+\b/g));
  assert.ok(mentioned.size >= 8);
  for (const name of mentioned) assert.ok(tools.has(name), `${name} is not a registered tool`);
});

test('a server without guidance advertises no prompts or instructions', async t => {
  const app = createApplication({ version: 'test' });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'guidance-test', version: '1' });
  await app.connect(serverTransport); await client.connect(clientTransport);
  t.after(async () => { await client.close(); await app.close(); });
  assert.equal(client.getInstructions(), undefined);
  assert.equal(client.getServerCapabilities()?.prompts, undefined);
});

test('the label-check guide keeps its safety rules', () => {
  for (const rule of ['get_product_labels', 'not a "free from" claim', 'mayContain', 'Never promise that a product is safe',
    'packaging, which prevails', 'nutrition_basis_mismatch', 'Change the cart only when the user asks'])
    assert.ok(LABEL_CHECK_GUIDE.includes(rule), rule);
});
