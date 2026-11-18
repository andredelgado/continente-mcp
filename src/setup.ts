import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { promisify } from 'node:util';
import { loadSettings, readDotEnv } from './config.js';
import type { Environment } from './config.js';
import { HumanVerificationRequired, safeLoginMessage } from './session/login-errors.js';
import { NO_DISPLAY_LOGIN, hasDisplay } from './session/sign-in-window.js';

const KEYS = ['CONTINENTE_EMAIL', 'CONTINENTE_PASSWORD'] as const;
const ASSIGNS = /^\s*(?:export\s+)?(CONTINENTE_EMAIL|CONTINENTE_PASSWORD)\s*=/;

/** Thrown when the person stops the setup (Ctrl-C or end of input); nothing is written. */
export class SetupCancelled extends Error {
  constructor() { super('Setup cancelled; nothing was saved.'); this.name = 'SetupCancelled'; }
}

/**
 * The credentials file with this email and password, keeping every other line as it was. Values are
 * written in double quotes, which the reader removes without unescaping anything, so any password
 * that fits on one line reads back exactly.
 */
export function credentialsText(existing: string, email: string, password: string): string {
  for (const value of [email, password]) if (/[\r\n\0]/.test(value)) throw new Error('The email and password must fit on one line.');
  const lines = existing.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  const fresh = [`CONTINENTE_EMAIL="${email}"`, `CONTINENTE_PASSWORD="${password}"`];
  const first = lines.findIndex(line => ASSIGNS.test(line));
  const kept = lines.filter(line => !ASSIGNS.test(line));
  if (first === -1) kept.push(...fresh);
  // Every line before the first credential line is kept, so the new ones go where that line was.
  else kept.splice(first, 0, ...fresh);
  return `${kept.join('\n')}\n`;
}

type Run = (command: string, args: string[]) => Promise<unknown>;
const runFile: Run = promisify(execFile);

/** Give the current Windows account, and nobody else, full control of a file or folder. */
async function windowsOwnerOnly(path: string, folder: boolean, run: Run, user: string): Promise<void> {
  if (folder) await run('icacls', [path, '/reset', '/T', '/Q']);
  await run('icacls', [path, '/inheritance:r', '/grant:r', `${user}:${folder ? '(OI)(CI)F' : 'F'}`]);
}

export interface SaveOptions {
  /** The data directory; when the file is inside it, the directory is restricted too, as the saved session lives there. */
  dataDir: string;
  platform?: NodeJS.Platform;
  run?: Run;
  user?: string;
}

/**
 * Write the credentials file readable only by the current user, replacing it atomically. The new file
 * is restricted before the password is written to it, so it is never readable by others, even briefly.
 */
export async function saveCredentials(file: string, email: string, password: string, options: SaveOptions): Promise<void> {
  const platform = options.platform ?? process.platform;
  const run = options.run ?? runFile;
  const user = options.user ?? process.env.USERNAME ?? userInfo().username;
  let existing = '';
  try { existing = await readFile(file, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const text = credentialsText(existing, email, password);
  const folder = dirname(file);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  if (resolve(folder) === resolve(options.dataDir)) {
    if (platform === 'win32') await windowsOwnerOnly(folder, true, run, user);
    else await chmod(folder, 0o700);
  }
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      if (platform === 'win32') await windowsOwnerOnly(temporary, false, run, user);
      await handle.writeFile(text); await handle.sync();
    } finally { await handle.close(); }
    await rename(temporary, file);
  } finally { await unlink(temporary).catch(() => {}); }
}

/** Read a line without showing what is typed. Backspace deletes; Ctrl-C or end of input cancels. */
export function readHidden(question: string, input: NodeJS.ReadStream, output: NodeJS.WritableStream): Promise<string> {
  return new Promise((done, fail) => {
    let value = '';
    const finish = (error?: Error) => {
      input.off('data', onData); input.off('end', onEnd);
      input.setRawMode(false); input.pause();
      output.write('\n');
      if (error) fail(error); else done(value);
    };
    const onEnd = () => finish(new SetupCancelled());
    const onData = (chunk: string | Buffer) => {
      for (const character of String(chunk)) {
        if (character === '\r' || character === '\n') return finish();
        if (character === '\u0003' || (character === '\u0004' && !value)) return finish(new SetupCancelled());
        if (character === '\u007f' || character === '\b') value = [...value].slice(0, -1).join('');
        else if (character >= ' ') value += character;
      }
    };
    output.write(question);
    input.setRawMode(true); input.setEncoding('utf8'); input.resume();
    input.on('data', onData); input.once('end', onEnd);
  });
}

export interface SetupIO {
  ask(question: string): Promise<string>;
  askHidden(question: string): Promise<string>;
  print(message: string): void;
}

/** Prompts on this terminal; null when it is not interactive, as a hidden prompt needs one. */
export function terminalIO(input: NodeJS.ReadStream = process.stdin, output: NodeJS.WriteStream = process.stderr): SetupIO | null {
  if (!input.isTTY || typeof input.setRawMode !== 'function') return null;
  return {
    async ask(question) {
      const lines = createInterface({ input, output, terminal: true });
      lines.once('SIGINT', () => lines.close());
      const closed = new Promise<never>((_, fail) => lines.once('close', () => fail(new SetupCancelled())));
      try { return await Promise.race([lines.question(question), closed]); } finally { lines.close(); }
    },
    askHidden: question => readHidden(question, input, output),
    print: message => { output.write(`${message}\n`); },
  };
}

export interface SetupOptions {
  io: SetupIO | null;
  env?: Environment;
  platform?: NodeJS.Platform;
  /** Sign in with the saved credentials; true when the session was saved. */
  login?: (showBrowser: boolean) => Promise<boolean>;
  signIn?: boolean;
  save?: typeof saveCredentials;
}

const EMAIL = /^[^\s@]+@[^\s@]+$/;
const set = (env: Environment, key: string) => { const value = env[key]?.trim(); return Boolean(value) && !/^\$\{user_config\./.test(value ?? ''); };

/** Ask for the email and password, save them privately, then sign in once. Returns the exit code. */
export async function runSetup(options: SetupOptions): Promise<number> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const settings = loadSettings(env);
  const { io } = options;
  if (!io) {
    console.error('setup needs an interactive terminal to ask for your password. Run it in a terminal, or create the credentials file by hand: '
      + 'https://github.com/andredelgado/continente-mcp/blob/main/docs/configuration.md#credentials-file');
    return 1;
  }
  io.print(`This saves your Continente email and password in ${settings.credentialsFile}, readable only by you. They are sent only to Continente.pt.`);
  for (const key of KEYS) if (set(env, key)) io.print(`Note: ${key} is set in this environment, and the server uses it instead of the file.`);
  let saved: Record<string, string> = {};
  try { saved = readDotEnv(await readFile(settings.credentialsFile, 'utf8')); } catch { /* No file yet. */ }
  try {
    const current = saved.CONTINENTE_EMAIL?.trim() ?? '';
    let email = '';
    for (let attempt = 0; attempt < 3 && !EMAIL.test(email); attempt++) {
      email = (await io.ask(current ? `Email [${current}]: ` : 'Email: ')).trim() || current;
      if (!EMAIL.test(email)) io.print('That is not an email address.');
    }
    if (!EMAIL.test(email)) return 1;
    const keep = Boolean(saved.CONTINENTE_PASSWORD) && email.toLowerCase() === current.toLowerCase();
    let password = '';
    for (let attempt = 0; attempt < 3 && !password; attempt++) {
      password = await io.askHidden(keep ? 'Password (not shown; Enter keeps the saved one): ' : 'Password (not shown): ');
      if (!password && keep) password = saved.CONTINENTE_PASSWORD!;
      if (!password) io.print('The password cannot be empty.');
      else if (/[\r\n\0]/.test(password)) { io.print('The password must fit on one line.'); password = ''; }
    }
    if (!password) return 1;
    await (options.save ?? saveCredentials)(settings.credentialsFile, email, password, { dataDir: settings.dataDir, platform });
  } catch (error) {
    if (error instanceof SetupCancelled) { io.print(error.message); return 1; }
    throw error;
  }
  io.print(`Saved to ${settings.credentialsFile}.`);
  if (options.signIn === false || !options.login) return 0;
  io.print('Signing in to check them...');
  try {
    if (await options.login(false)) { io.print('Signed in; the session is saved. Add the server to your client and you are ready.'); return 0; }
  } catch (error) {
    if (!(error instanceof HumanVerificationRequired)) { io.print(safeLoginMessage(error)); return 1; }
    if (!hasDisplay(env, platform)) { io.print(NO_DISPLAY_LOGIN); return 1; }
    io.print('Continente asks you to confirm you are not a robot. In the window that opens, tick "Não sou um robô" and press "Avançar".');
    try { if (await options.login(true)) { io.print('Signed in; the session is saved. Add the server to your client and you are ready.'); return 0; } }
    catch (retry) { io.print(safeLoginMessage(retry)); return 1; }
  }
  io.print('Sign-in did not finish. Your credentials are saved; check them and run `npx -y continentept-mcp setup` again.');
  return 1;
}
