#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createShoppingApplication } from './runtime.js';
import { runAutoLogin } from './auto-login.js';
import { isMainModule } from './main-module.js';
import { runChromiumInstall } from './session/chromium.js';
import { safeLoginMessage } from './session/login-errors.js';
import { hasDisplay, NO_DISPLAY_LOGIN } from './session/sign-in-window.js';
import { checkForUpdate } from './services/updates.js';
import { loadSettings } from './config.js';
import type { ContinenteMcpServer } from './mcp/server.js';

const USAGE = `Usage: continentept-mcp [command]

Commands:
  (none)            Start the MCP server on stdio
  login             Sign in with CONTINENTE_EMAIL and CONTINENTE_PASSWORD and save the session
                    (--show-browser displays the browser window)
  install-browser   Download the Chromium build used by the server (extra arguments go to Playwright)

Options:
  -h, --help        Show this help
  -v, --version     Show the version
`;

function packageMetadata(): { name: string; version: string } {
  const metadata: unknown = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  if (typeof metadata !== 'object' || metadata === null || !('version' in metadata) || !('name' in metadata) ||
    typeof metadata.version !== 'string' || typeof metadata.name !== 'string') throw new Error('Missing package metadata');
  return { name: metadata.name, version: metadata.version };
}

export async function startStdioServer(): Promise<ContinenteMcpServer> {
  const { name, version } = packageMetadata();
  const settings = loadSettings();
  const update = await checkForUpdate({ currentVersion: version, packageName: name, dataDir: settings.dataDir, enabled: settings.updateCheck });
  if (update.available) console.error(`${name} ${update.latestVersion} is available (running ${version}).`);
  const application = createShoppingApplication({ version, update });
  await connectStdioApplication(application);
  console.error(`continentept-mcp ${version} ready on stdio`);
  return application;
}

/** The SDK stdio transport does not treat input EOF as closure, so the CLI owns that lifecycle. */
export async function connectStdioApplication(application: ContinenteMcpServer): Promise<void> {
  const detach = () => {
    process.off('SIGINT', shutdown); process.off('SIGTERM', shutdown);
    process.stdin.off('end', shutdown); process.stdin.off('close', shutdown);
  };
  const shutdown = () => {
    detach();
    void application.close().catch(() => { console.error('Could not close Continente MCP resources.'); process.exitCode = 1; });
  };
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
  process.stdin.once('end', shutdown); process.stdin.once('close', shutdown);
  try { await application.connect(new StdioServerTransport()); } catch (error) { detach(); throw error; }
}

export async function main(args: string[]): Promise<number> {
  const [command, ...rest] = args;
  switch (command) {
    case undefined:
    case 'serve':
      await startStdioServer();
      return 0;
    case 'login': {
      const showBrowser = rest.includes('--show-browser');
      if (showBrowser && !hasDisplay(process.env)) { console.error(NO_DISPLAY_LOGIN); return 1; }
      try { return (await runAutoLogin({ showBrowser })) ? 0 : 1; }
      catch (error) { console.error(safeLoginMessage(error)); return 1; }
    }
    case 'install-browser':
      return runChromiumInstall(rest);
    case '-v':
    case '--version':
      console.log(packageMetadata().version);
      return 0;
    case '-h':
    case '--help':
      console.log(USAGE);
      return 0;
    default:
      console.error(`Unknown command: ${command}\n\n${USAGE}`);
      return 2;
  }
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).then(code => { if (code) process.exitCode = code; }, (error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Could not start Continente MCP');
    process.exitCode = 1;
  });
}
