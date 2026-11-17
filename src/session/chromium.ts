import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { ToolError } from '../domain/index.js';
import type { Logger } from '../ports.js';
import type { BrowserLauncher } from './browser.js';
import { requestTimeout } from './request.js';

/** The browser cannot be used yet; carries the message to show instead of a generic failure. */
export class BrowserUnavailable extends Error {
  constructor(readonly toolError: ToolError) { super(toolError.message); this.name = 'BrowserUnavailable'; }
}

const unavailable = (message: string) => new BrowserUnavailable({ code: 'browser_unavailable', message, retryable: true });
export const isMissingBrowserError = (error: unknown) => error instanceof Error && /Executable doesn't exist/i.test(error.message);

/**
 * Playwright's debug output (`DEBUG=pw:api`, `pw:protocol` and the like) records what is typed into
 * fields, the password among it, and the cookies the browser is given. Those namespaces are switched
 * off before Playwright loads; its launch and download diagnostics (`pw:browser`, `pw:install`) stay
 * available. Playwright reads `DEBUG` once, when it loads, so this runs before the first import.
 */
export function withoutSecretDiagnostics(env: NodeJS.ProcessEnv = process.env): void {
  if (env.DEBUG?.trim()) env.DEBUG = `${env.DEBUG},-pw:api,-pw:channel,-pw:protocol,-pw:error,-pw:server*`;
}

/** Run Playwright's installer for Chromium. With `onOutput`, its output is captured instead of inherited. */
export function runChromiumInstall(extraArgs: readonly string[] = [], onOutput?: (line: string) => void): Promise<number> {
  const cli = join(dirname(createRequire(import.meta.url).resolve('playwright/package.json')), 'cli.js');
  const child = spawn(process.execPath, [cli, 'install', 'chromium', ...extraArgs], { stdio: onOutput ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
  if (onOutput) {
    const forward = (chunk: Buffer) => chunk.toString().split(/\r?\n|\r/).map(line => line.trim()).filter(Boolean).forEach(onOutput);
    child.stdout?.on('data', forward); child.stderr?.on('data', forward);
  }
  return new Promise(resolve => { child.on('error', () => resolve(1)); child.on('close', code => resolve(code ?? 1)); });
}

/**
 * Downloads Chromium the first time a launch finds it missing. Concurrent requests share one
 * download, and a request that would run past its budget gets a "try again shortly" error.
 */
export class ChromiumInstaller {
  private pending: Promise<void> | undefined;
  constructor(private readonly install: () => Promise<void>, private readonly logger: Logger, private readonly maxWaitMs = 25000) {}

  private start(): Promise<void> {
    this.pending ??= this.install().then(() => this.logger('Chromium is ready.'), error => { this.pending = undefined; throw error; });
    return this.pending;
  }

  private async waitForInstall(): Promise<void> {
    const pending = this.start();
    // Leave time to launch the browser and do the actual work within the same request.
    const budget = Math.max(0, requestTimeout(this.maxWaitMs + 10000) - 10000);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([pending.then(() => 'ready' as const, () => 'failed' as const),
      new Promise<'waiting'>(resolve => { timer = setTimeout(() => resolve('waiting'), budget); })]);
    clearTimeout(timer);
    if (outcome === 'failed') throw unavailable('Chromium could not be downloaded. Check the internet connection, or run `continentept-mcp install-browser`.');
    if (outcome === 'waiting') throw unavailable('Chromium is being downloaded for first use (about 150 MB). Try again in a minute.');
  }

  launcher(launch: BrowserLauncher): BrowserLauncher {
    return async options => {
      if (this.pending) await this.waitForInstall();
      try { return await launch(options); }
      catch (error) {
        if (!isMissingBrowserError(error)) throw error;
        this.logger('Chromium is not installed; downloading it now. This happens once.');
        await this.waitForInstall();
        return launch(options);
      }
    };
  }
}
