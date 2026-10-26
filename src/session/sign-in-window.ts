import type { Logger } from '../ports.js';
import { safeLoginMessage } from './login-errors.js';
import { outsideRequest } from './request.js';

/**
 * What happened when a sign-in needed the person: a window `opened` for them, one was
 * `already_open`, or none can be shown here (`not_available`).
 */
export type SignInWindowState = 'opened' | 'already_open' | 'not_available';

/**
 * Whether this machine can show the person a browser window. Off with
 * CONTINENTE_SIGN_IN_WINDOW=0; on Linux it needs a display.
 */
export function canShowSignInWindow(env: Readonly<Record<string, string | undefined>>, platform: NodeJS.Platform = process.platform): boolean {
  if (env.CONTINENTE_SIGN_IN_WINDOW?.trim() === '0') return false;
  if (platform === 'darwin' || platform === 'win32') return true;
  return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
}

/**
 * A visible sign-in the person finishes themselves, for when Continente asks them to confirm
 * they are not a robot. At most one runs at a time. It runs outside any tool request, so the
 * tool that needed it answers straight away; the saved session it leaves is picked up by the
 * next request.
 */
export class SignInWindow {
  private running: Promise<void> | null = null;
  constructor(private readonly signIn: () => Promise<boolean>, private readonly available: () => boolean, private readonly logger: Logger) {}

  get open(): boolean { return this.running !== null; }

  start(): SignInWindowState {
    if (this.running) return 'already_open';
    if (!this.available()) return 'not_available';
    this.logger('Opening a Continente sign-in window.');
    const running = outsideRequest(async () => {
      try {
        this.logger(await this.signIn() ? 'Signed in from the sign-in window; session saved.' : 'The sign-in window closed without signing in.');
      } catch (error) { this.logger(safeLoginMessage(error)); }
    });
    this.running = running.finally(() => { this.running = null; });
    return 'opened';
  }

  /** Resolves once no sign-in window is open. */
  async settled(): Promise<void> { await this.running; }
}
