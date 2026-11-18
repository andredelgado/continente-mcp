import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { readDotEnv } from '../src/config.js';
import { HumanVerificationRequired, LoginFailed } from '../src/session/login-errors.js';
import { NO_DISPLAY_LOGIN } from '../src/session/sign-in-window.js';
import { SetupCancelled, credentialsText, readHidden, runSetup, saveCredentials } from '../src/setup.js';
import type { SetupIO } from '../src/setup.js';

import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';

async function temporary(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'continente-setup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
const posix = process.platform !== 'win32' ? false : 'POSIX file modes';

test('any one-line password reads back exactly, and the other lines of the file are kept', () => {
  for (const password of ['simple', ' spaces around ', '"quoted"', "'single'", 'a"b\'c', '#hash', 'x=y=z', 'back\\slash', '${HOME}', '$(whoami)', 'é ç ã 🙂', '  ']) {
    const read = readDotEnv(credentialsText('', 'me@example.com', password));
    assert.equal(read.CONTINENTE_PASSWORD, password, JSON.stringify(password));
    assert.equal(read.CONTINENTE_EMAIL, 'me@example.com');
  }
  const before = '# my settings\nexport CONTINENTE_EMAIL=old@example.com\nCONTINENTE_READ_ONLY=1\nCONTINENTE_PASSWORD=old\nCONTINENTE_PASSWORD=older\n';
  assert.equal(credentialsText(before, 'new@example.com', 'secret'),
    '# my settings\nCONTINENTE_EMAIL="new@example.com"\nCONTINENTE_PASSWORD="secret"\nCONTINENTE_READ_ONLY=1\n');
  assert.equal(credentialsText('CONTINENTE_UPDATE_CHECK=0', 'a@b.pt', 'p'), 'CONTINENTE_UPDATE_CHECK=0\nCONTINENTE_EMAIL="a@b.pt"\nCONTINENTE_PASSWORD="p"\n');
  assert.throws(() => credentialsText('', 'a@b.pt', 'two\nlines'), /one line/);
});

test('the credentials file and the data directory are left readable only by the user', { skip: posix }, async t => {
  const root = await temporary(t);
  const dataDir = join(root, '.continentept-mcp');
  await mkdir(dataDir, { mode: 0o755 }); await chmod(dataDir, 0o755);
  await writeFile(join(dataDir, 'credentials.env'), 'CONTINENTE_READ_ONLY=1\n', { mode: 0o644 });
  await saveCredentials(join(dataDir, 'credentials.env'), 'me@example.com', 'secret', { dataDir });
  assert.equal((await stat(dataDir)).mode & 0o777, 0o700);
  assert.equal((await stat(join(dataDir, 'credentials.env'))).mode & 0o777, 0o600);
  assert.deepEqual(readDotEnv(await readFile(join(dataDir, 'credentials.env'), 'utf8')),
    { CONTINENTE_READ_ONLY: '1', CONTINENTE_EMAIL: 'me@example.com', CONTINENTE_PASSWORD: 'secret' });
  assert.deepEqual(await readdir(dataDir), ['credentials.env'], 'no temporary file is left');

  // A file kept elsewhere is restricted, but the folder around it is not the server's to change.
  const elsewhere = join(root, 'shared'); await mkdir(elsewhere, { mode: 0o755 }); await chmod(elsewhere, 0o755);
  await saveCredentials(join(elsewhere, 'continente.env'), 'me@example.com', 'secret', { dataDir });
  assert.equal((await stat(elsewhere)).mode & 0o777, 0o755);
  assert.equal((await stat(join(elsewhere, 'continente.env'))).mode & 0o777, 0o600);
});

test('on Windows the folder is restricted first and the new file before the password is written to it', async t => {
  const root = await temporary(t);
  const dataDir = join(root, '.continentept-mcp');
  const calls: { args: string[]; size: number | null }[] = [];
  const run = async (command: string, args: string[]) => {
    assert.equal(command, 'icacls');
    calls.push({ args, size: await stat(args[0]!).then(info => info.isFile() ? info.size : null) });
  };
  await saveCredentials(join(dataDir, 'credentials.env'), 'me@example.com', 'secret', { dataDir, platform: 'win32', run, user: 'ana' });
  assert.deepEqual(calls.map(call => call.args.slice(1)), [
    ['/reset', '/T', '/Q'], ['/inheritance:r', '/grant:r', 'ana:(OI)(CI)F'], ['/inheritance:r', '/grant:r', 'ana:F']]);
  assert.equal(calls[0]!.args[0], dataDir); assert.equal(calls[1]!.args[0], dataDir);
  assert.match(calls[2]!.args[0]!, /credentials\.env\..+\.tmp$/);
  assert.equal(calls[2]!.size, 0, 'the file is restricted while it is still empty');
  assert.match(await readFile(join(dataDir, 'credentials.env'), 'utf8'), /CONTINENTE_PASSWORD="secret"/);
});

test('on Windows only the user can read the saved file and its folder', { skip: process.platform !== 'win32' && 'Windows only' }, async t => {
  const root = await temporary(t);
  const dataDir = join(root, '.continentept-mcp'); await mkdir(dataDir);
  execFileSync('icacls', [dataDir, '/grant', '*S-1-1-0:(OI)(CI)R']);
  const file = join(dataDir, 'credentials.env');
  await saveCredentials(file, 'me@example.com', 'secret', { dataDir });
  for (const path of [dataDir, file]) {
    const listing = execFileSync('icacls', [path], { encoding: 'utf8' }).replace(path, '');
    const accounts = [...listing.matchAll(/^\s*(.+?):\(/gm)].map(match => match[1]!.trim());
    assert.ok(accounts.length > 0 && accounts.every(account => account.toLowerCase().endsWith(`\\${process.env.USERNAME?.toLowerCase()}`)), `${path}: ${accounts.join(', ')}`);
  }
});

function fakeTerminal() {
  const input = Object.assign(new PassThrough(), { isTTY: true, raw: false, setRawMode(mode: boolean) { input.raw = mode; return input; } });
  const output = new PassThrough(); let shown = '';
  output.on('data', chunk => { shown += String(chunk); });
  return { input: input as unknown as NodeJS.ReadStream & { raw: boolean }, output, shown: () => shown };
}

test('a hidden answer is never shown, honours backspace, and Ctrl-C cancels', async () => {
  const terminal = fakeTerminal();
  const answer = readHidden('Password: ', terminal.input, terminal.output);
  assert.equal(terminal.input.raw, true);
  terminal.input.write('pa'); terminal.input.write('x\u007fss'); terminal.input.write('wd\r');
  assert.equal(await answer, 'passwd');
  assert.equal(terminal.input.raw, false, 'the terminal is restored');
  assert.equal(terminal.shown(), 'Password: \n');

  const other = fakeTerminal();
  const cancelled = readHidden('Password: ', other.input, other.output);
  other.input.write('abc\u0003');
  await assert.rejects(cancelled, SetupCancelled);
  assert.equal(other.input.raw, false);
});

function scripted(answers: string[], hidden: string[]) {
  const printed: string[] = [];
  const io: SetupIO = {
    async ask() { const next = answers.shift(); if (next === undefined) throw new SetupCancelled(); return next; },
    async askHidden() { const next = hidden.shift(); if (next === undefined) throw new SetupCancelled(); return next; },
    print: message => { printed.push(message); },
  };
  return { io, printed };
}

test('setup saves what was typed, signs in, and opens a window only for the robot check', async t => {
  const root = await temporary(t);
  const env = { HOME: root, CONTINENTE_CREDENTIALS_FILE: join(root, '.continentept-mcp', 'credentials.env'), DISPLAY: ':0' };
  const saves: unknown[][] = []; const save = async (...args: unknown[]) => { saves.push(args); };
  const logins: boolean[] = [];

  let { io, printed } = scripted(['  me@example.com '], ['s3cret']);
  assert.equal(await runSetup({ io, env, platform: 'linux', save, login: async show => { logins.push(show); return true; } }), 0);
  assert.deepEqual(saves[0]!.slice(0, 3), [env.CONTINENTE_CREDENTIALS_FILE, 'me@example.com', 's3cret']);
  assert.deepEqual(logins, [false]);
  assert.ok(!printed.join('\n').includes('s3cret'), 'the password is never printed');

  ({ io, printed } = scripted(['me@example.com'], ['s3cret']));
  assert.equal(await runSetup({ io, env, platform: 'linux', save, login: async show => { logins.push(show); if (!show) throw new HumanVerificationRequired(); return true; } }), 0);
  assert.deepEqual(logins, [false, false, true]);
  assert.match(printed.join('\n'), /Não sou um robô/);

  ({ io, printed } = scripted(['me@example.com'], ['s3cret']));
  assert.equal(await runSetup({ io, env: { ...env, DISPLAY: '' }, platform: 'linux', save, login: async () => { throw new HumanVerificationRequired(); } }), 1);
  assert.ok(printed.includes(NO_DISPLAY_LOGIN));

  ({ io, printed } = scripted(['me@example.com'], ['wrong']));
  assert.equal(await runSetup({ io, env, platform: 'linux', save, login: async () => { throw new LoginFailed('Sign-in failed: the email or password was not accepted.'); } }), 1);
  assert.match(printed.join('\n'), /not accepted/);

  ({ io } = scripted(['me@example.com'], ['s3cret']));
  const before = logins.length;
  assert.equal(await runSetup({ io, env, platform: 'linux', save, signIn: false, login: async show => { logins.push(show); return true; } }), 0);
  assert.equal(logins.length, before, '--no-login only saves');
});

test('setup keeps the saved email and password on Enter, and saves nothing for a bad email or a cancel', async t => {
  const root = await temporary(t);
  const file = join(root, 'credentials.env');
  await writeFile(file, 'CONTINENTE_EMAIL=me@example.com\nCONTINENTE_PASSWORD=saved\n');
  const env = { HOME: root, CONTINENTE_CREDENTIALS_FILE: file, CONTINENTE_EMAIL: 'other@example.com' };
  const saves: unknown[][] = []; const save = async (...args: unknown[]) => { saves.push(args); };

  let { io, printed } = scripted([''], ['']);
  assert.equal(await runSetup({ io, env, platform: 'linux', save, signIn: false }), 0);
  assert.deepEqual(saves[0]!.slice(1, 3), ['me@example.com', 'saved']);
  assert.match(printed.join('\n'), /CONTINENTE_EMAIL is set in this environment/);

  ({ io } = scripted(['new@example.com'], ['', 'fresh']));
  assert.equal(await runSetup({ io, env, platform: 'linux', save, signIn: false }), 0);
  assert.deepEqual(saves[1]!.slice(1, 3), ['new@example.com', 'fresh'], 'another email never inherits the saved password');

  ({ io } = scripted(['nope', 'still nope', 'no@'], []));
  assert.equal(await runSetup({ io, env, platform: 'linux', save, signIn: false }), 1);
  ({ io, printed } = scripted(['me@example.com'], []));
  assert.equal(await runSetup({ io, env, platform: 'linux', save, signIn: false }), 1);
  assert.match(printed.join('\n'), /nothing was saved/);
  assert.equal(saves.length, 2);
  assert.equal(await runSetup({ io: null, env, platform: 'linux', save }), 1);
});
