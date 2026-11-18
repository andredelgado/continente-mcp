import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import assert from 'node:assert/strict';
import test from 'node:test';

/** The PowerShell setup a document gives, without the line that opens Notepad. */
async function setup(document: string): Promise<string> {
  const text = await readFile(new URL(`../../${document}`, import.meta.url), 'utf8');
  const block = /```powershell\n([\s\S]*?)```/.exec(text)?.[1];
  assert.ok(block, `${document} has no PowerShell setup`);
  return block.split('\n').filter(line => !line.startsWith('notepad')).join('\n');
}
/** The accounts an `icacls` listing grants anything to. */
function grantees(path: string): string[] {
  const listing = execFileSync('icacls', [path], { encoding: 'utf8' }).replace(path, '');
  return [...listing.matchAll(/^\s*(.+?):\(/gm)].map(match => match[1]!.trim());
}

test('the documented Windows setup leaves the folder and an existing credentials file to the user alone', {
  skip: process.platform !== 'win32' && 'Windows only',
}, async t => {
  const commands = await setup('docs/configuration.md');
  const profile = await mkdtemp(join(tmpdir(), 'continente-acl-'));
  t.after(() => rm(profile, { recursive: true, force: true }));
  const folder = join(profile, '.continentept-mcp'); const file = join(folder, 'credentials.env');
  await mkdir(folder); await writeFile(file, 'CONTINENTE_EMAIL=\n');
  // A folder left from before that everyone may read, holding a file the machine's users were given.
  execFileSync('icacls', [folder, '/grant', '*S-1-1-0:(OI)(CI)R']);
  execFileSync('icacls', [file, '/grant', '*S-1-5-32-545:R']);
  execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', commands], { env: { ...process.env, USERPROFILE: profile } });
  for (const path of [folder, file]) {
    const accounts = grantees(path);
    assert.ok(accounts.length > 0 && accounts.every(account => account.toLowerCase().endsWith(`\\${process.env.USERNAME?.toLowerCase()}`)), `${path}: ${accounts.join(', ')}`);
  }
});
