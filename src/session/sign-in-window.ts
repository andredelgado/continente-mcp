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
  return hasDisplay(env, platform);
}

/** Whether a browser window can be shown at all: always on macOS and Windows, on Linux only with a display. */
export function hasDisplay(env: Readonly<Record<string, string | undefined>>, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === 'darwin' || platform === 'win32') return true;
  return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
}

/** What `login --show-browser` says where no window can be shown. */
export const NO_DISPLAY_LOGIN = 'No browser window can be shown here: this computer has no display (for example Docker, or SSH without '
  + 'X forwarding). Run `npx -y continentept-mcp login --show-browser` on a computer with a screen, with the same account, then copy '
  + 'session.json from its data directory (~/.continentept-mcp) to this server\'s data directory (CONTINENTE_DATA_DIR).';

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
