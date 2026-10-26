import { loadSettings, sessionAccountIdentity } from './config.js';
import { FileCookieStore } from './stores/files.js';
import { AuthenticationClient } from './clients/authentication.js';
import type { LoginOptions } from './clients/authentication.js';
import { launchBrowser } from './runtime.js';

/** Sign in with the configured credentials and save the session for the server to reuse. */
export async function runAutoLogin(options: LoginOptions = {}): Promise<boolean> {
  const settings = loadSettings();
  const logger = (message: string) => console.error(message);
  return new AuthenticationClient(launchBrowser, new FileCookieStore(settings.cookieFile, sessionAccountIdentity(settings)), settings, logger, options).loginWithCredentials();
}
