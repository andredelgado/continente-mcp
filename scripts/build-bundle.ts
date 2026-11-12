// Build the Claude Desktop extension: build/continente-mcp.mcpb.
// Run `npm run build` first; this packs the compiled dist/ with production dependencies only.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { z } from 'zod';

const root = fileURLToPath(new URL('../../', import.meta.url));
const stage = join(root, 'build', 'bundle');
const output = join(root, 'build', 'continente-mcp.mcpb');
const repository = 'https://github.com/andredelgado/continente-mcp';

const pkg = z.object({ name: z.string(), version: z.string(), description: z.string(), keywords: z.array(z.string()), license: z.string() })
  .parse(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')));
if (!existsSync(join(root, 'dist', 'cli.js'))) throw new Error('Run `npm run build` before building the bundle.');

interface ToolDefinition { definition: { name: string; description?: string } }
type RegisterTools = (services: unknown) => ToolDefinition[];
const shopping: unknown = await import(new URL('../../dist/mcp/shopping.js', import.meta.url).href);
const registerShoppingTools = (shopping as { registerShoppingTools: RegisterTools }).registerShoppingTools;
// Definitions are read without calling any tool, so no services are needed.
const tools = registerShoppingTools({}).map(({ definition }) => ({ name: definition.name, description: definition.description ?? '' }));

const manifest = {
  manifest_version: '0.3',
  name: pkg.name,
  display_name: 'Continente MCP',
  version: pkg.version,
  description: 'Search Continente.pt products and promotions, compare prices per kg or litre, read your favorites and orders, and fill your cart.',
  long_description: 'Unofficial MCP server for Continente.pt. It is not affiliated with Continente or MC Sonae. '
    + 'Every cart change is confirmed by reading the cart back, and checkout and payment always stay on the website. '
    + 'Chromium (about 150 MB) is downloaded automatically the first time it is needed.',
  author: { name: 'André Delgado', url: 'https://github.com/andredelgado' },
  repository: { type: 'git', url: repository },
  homepage: repository,
  documentation: `${repository}/blob/main/docs/tools.md`,
  support: `${repository}/issues`,
  server: {
    type: 'node',
    entry_point: 'dist/cli.js',
    mcp_config: {
      command: 'node',
      args: ['${__dirname}/dist/cli.js'],
      env: { CONTINENTE_EMAIL: '${user_config.email}', CONTINENTE_PASSWORD: '${user_config.password}' },
    },
  },
  tools,
  tools_generated: false,
  prompts_generated: true,
  keywords: pkg.keywords,
  license: pkg.license,
  compatibility: { platforms: ['darwin', 'win32'], runtimes: { node: '>=22.0.0' } },
  user_config: {
    // Optional so the extension can be tried first: search and product tools work without an account.
    email: { type: 'string', title: 'Continente email', description: 'The email you use to sign in to Continente.pt. Optional: without it, searching and product details still work, and you can add it later in the extension settings to use your cart and orders.', required: false },
    password: { type: 'string', title: 'Continente password', description: 'Used only to sign in to Continente.pt; Claude stores it securely. Optional, like the email.', sensitive: true, required: false },
  },
};

const run = (command: string, args: string[], cwd = root) => execFileSync(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });

rmSync(stage, { recursive: true, force: true });
rmSync(output, { force: true });
mkdirSync(stage, { recursive: true });
for (const entry of ['dist', 'skills', 'LICENSE', 'README.md', 'package.json', 'package-lock.json']) {
  cpSync(join(root, entry), join(stage, entry), { recursive: true });
}
writeFileSync(join(stage, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], stage);
rmSync(join(stage, 'package-lock.json'));
const mcpb = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'mcpb.cmd' : 'mcpb');
run(mcpb, ['validate', join(stage, 'manifest.json')]);
run(mcpb, ['pack', stage, output]);
console.log(`Bundle ready: ${output}`);
