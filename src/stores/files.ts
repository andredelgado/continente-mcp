import { mkdir, readFile, stat, open, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { z } from 'zod';
import { FavoritesCacheSchema, failure, parseValue, success } from '../domain/index.js';
import type { FavoritesCache, Result, ToolError } from '../domain/index.js';
import type { FavoritesStore } from '../ports.js';

/** The cookie shape Playwright returns from `context.cookies()` and accepts in `addCookies()`. */
export const SessionCookieSchema = z.object({
  name: z.string().min(1), value: z.string(), domain: z.string().min(1), path: z.string().min(1),
  expires: z.number().finite(), httpOnly: z.boolean(), secure: z.boolean(), sameSite: z.enum(['Strict', 'Lax', 'None']),
});
export type SessionCookie = z.infer<typeof SessionCookieSchema>;
export const SessionCookiesSchema = z.array(SessionCookieSchema);
const SavedSessionSchema = z.strictObject({ schemaVersion: z.literal(1), accountIdentity: z.string().min(1), cookies: SessionCookiesSchema });

const isMissing = (error: unknown) => (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';

/** Write JSON readable only by the current user, replacing the target atomically. */
export async function writePrivateJson(file: string, data: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(data, null, 2)); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, file);
  } finally { await unlink(temporary).catch(() => {}); }
}

export interface CookieStore {
  /** Changes whenever the file is replaced; null when there is no file. */
  revision(): Promise<number | null>;
  load(): Promise<Result<SessionCookie[], ToolError>>;
  save(cookies: SessionCookie[]): Promise<void>;
}

export class FileCookieStore implements CookieStore {
  constructor(private readonly file: string, private readonly accountIdentity: string) {}
  async revision(): Promise<number | null> {
    try { return (await stat(this.file)).mtimeMs; } catch (error) { if (isMissing(error)) return null; throw error; }
  }
  async load(): Promise<Result<SessionCookie[], ToolError>> {
    let input: unknown;
    try { input = JSON.parse(await readFile(this.file, 'utf8')); } catch { return failure('invalid_data', 'The saved session could not be read'); }
    const parsed = parseValue(SavedSessionSchema, input, 'saved session');
    if (!parsed.ok) return failure('cache_unavailable', 'The saved session has no verified account binding; run `continentept-mcp login` to replace it');
    if (parsed.value.accountIdentity !== this.accountIdentity) return failure('cache_unavailable', 'The saved session belongs to a different configured account; run `continentept-mcp login` to replace it');
    return success(parsed.value.cookies);
  }
  async save(cookies: SessionCookie[]): Promise<void> { await writePrivateJson(this.file, { schemaVersion: 1, accountIdentity: this.accountIdentity, cookies }); }
}

/** Favorites snapshot with a one-version backup, tied to the current login. */
export class FileFavoritesStore implements FavoritesStore {
  private readonly backupFile: string;
  constructor(private readonly file: string, private readonly accountScope: string | (() => string)) { this.backupFile = `${file}.bak`; }
  private scope(): string { return typeof this.accountScope === 'function' ? this.accountScope() : this.accountScope; }
  private async read(file: string): Promise<Result<FavoritesCache | null, ToolError>> {
    let input: unknown;
    try { input = JSON.parse(await readFile(file, 'utf8')); }
    catch (error) { return isMissing(error) ? success(null) : failure('cache_unavailable'); }
    return parseValue(FavoritesCacheSchema, input, 'favorites cache');
  }
  async load(): Promise<Result<FavoritesCache | null, ToolError>> {
    const current = await this.read(this.file);
    // A valid snapshot for another login must not be replaced by an older backup.
    if (current.ok && current.value) return current.value.accountScope === this.scope()
      ? current : failure('cache_unavailable', 'The favorites snapshot belongs to another login; refresh it');
    const backup = await this.read(this.backupFile);
    return backup.ok && backup.value?.accountScope === this.scope() ? backup : current;
  }
  async save(cache: FavoritesCache): Promise<Result<void, ToolError>> {
    const parsed = parseValue(FavoritesCacheSchema, cache, 'favorites cache');
    if (!parsed.ok) return parsed;
    if (parsed.value.accountScope !== this.scope()) return failure('cache_unavailable', 'The login changed while favorites were refreshing');
    try {
      const current = await this.read(this.file);
      const backup = current.ok && current.value ? current : await this.read(this.backupFile);
      await writePrivateJson(this.backupFile, (backup.ok ? backup.value : null) ?? parsed.value);
      await writePrivateJson(this.file, parsed.value);
      return success(undefined);
    } catch { return failure('cache_unavailable', 'The favorites snapshot could not be saved'); }
  }
}
