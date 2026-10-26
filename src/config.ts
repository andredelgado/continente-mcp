import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

export type Environment = Readonly<Record<string, string | undefined>>;

export interface Settings {
  /** Empty when not configured. */
  readonly email: string;
  readonly password: string;
  readonly dataDir: string;
  readonly credentialsFile: string;
  readonly cookieFile: string;
  readonly favoritesFile: string;
  /** Undefined keeps the session default. */
  readonly browserIdleMs: number | undefined;
  /** Check npm once a day for a newer release. */
  readonly updateCheck: boolean;
}

const FILE_KEYS = new Set(['CONTINENTE_EMAIL', 'CONTINENTE_PASSWORD', 'CONTINENTE_BROWSER_IDLE_SECONDS', 'CONTINENTE_UPDATE_CHECK']);
const ASSIGNMENT = /^(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/;

/** Read `KEY=value` lines. Surrounding quotes are removed; nothing is expanded or unescaped. */
export function readDotEnv(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith('#')) continue;
    const match = ASSIGNMENT.exec(line);
    if (!match?.[1]) continue;
    let value = (match[2] ?? '').trim();
    const quote = value.charAt(0);
    if (value.length >= 2 && (quote === '"' || quote === "'") && value.endsWith(quote)) value = value.slice(1, -1);
    values[match[1]] = value;
  }
  return values;
}

function readCredentialsFile(file: string): Record<string, string> {
  let text: string;
  try { text = readFileSync(file, 'utf8'); } catch { return {}; }
  return Object.fromEntries(Object.entries(readDotEnv(text)).filter(([key]) => FILE_KEYS.has(key)));
}

/**
 * Resolve settings from the environment and the private credentials file.
 * A variable present in the environment always wins, even when it is empty.
 */
export function loadSettings(env: Environment = process.env): Settings {
  const home = env.HOME || env.USERPROFILE || homedir();
  const dataDir = env.CONTINENTE_DATA_DIR || join(home, '.continentept-mcp');
  const credentialsFile = env.CONTINENTE_CREDENTIALS_FILE || join(dataDir, 'credentials.env');
  const file = readCredentialsFile(credentialsFile);
  const value = (key: string) => env[key] ?? file[key];
  const idle = value('CONTINENTE_BROWSER_IDLE_SECONDS');
  const idleSeconds = idle === undefined || idle.trim() === '' ? NaN : Number(idle);
  return {
    email: value('CONTINENTE_EMAIL')?.trim() ?? '',
    password: value('CONTINENTE_PASSWORD') ?? '',
    dataDir,
    credentialsFile,
    cookieFile: join(dataDir, 'session.json'),
    favoritesFile: join(dataDir, 'favorites.json'),
    browserIdleMs: Number.isFinite(idleSeconds) && idleSeconds >= 0 ? idleSeconds * 1000 : undefined,
    updateCheck: !['0', 'false', 'off', 'no'].includes(value('CONTINENTE_UPDATE_CHECK')?.trim().toLowerCase() ?? ''),
  };
}

export function hasCredentials(settings: Pick<Settings, 'email' | 'password'>): boolean {
  return settings.email !== '' && settings.password !== '';
}

/**
 * Opaque key that ties the favorites snapshot to one login. Cookie contents are part of it
 * because a replaced session can belong to another account even when the email is unchanged.
 */
export function favoritesScope(settings: Pick<Settings, 'email' | 'cookieFile'>): string {
  const digest = createHash('sha256');
  digest.update(`${settings.email.toLowerCase()}\n${settings.cookieFile}\n`);
  try { digest.update(readFileSync(settings.cookieFile)); } catch { digest.update('-'); }
  return digest.digest('hex');
}

/** Opaque credential key for binding saved cookies without persisting configured credentials. */
export function sessionAccountIdentity(settings: Pick<Settings, 'email'>): string {
  return createHash('sha256').update(settings.email.trim().toLowerCase()).digest('hex');
}
