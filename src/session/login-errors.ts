import { BrowserUnavailable } from './chromium.js';
import { RequestStopped } from './request.js';

/**
 * A sign-in failure with a fixed, loggable message. Browser automation errors from credential
 * entry or authenticated requests can embed typed values and Cookie headers in their message,
 * so they are never passed on; only the failed step is reported.
 */
export class LoginFailed extends Error {
  constructor(message: string) { super(message); this.name = 'LoginFailed'; }
}

/**
 * Continente asked the person to confirm they are not a robot. Only a person can do that, in a
 * visible browser window, so an unattended sign-in stops here instead of timing out.
 */
export class HumanVerificationRequired extends LoginFailed {
  constructor() {
    super('Sign-in needs you: Continente asks you to confirm you are not a robot. Run `continentept-mcp login --show-browser`, '
      + 'tick "Não sou um robô" in the window and press "Avançar".');
    this.name = 'HumanVerificationRequired';
  }
}

/** Wrap any error from a sign-in step in a LoginFailed that names only the step. */
export function loginFailure(step: string, error: unknown): Error {
  if (error instanceof LoginFailed || error instanceof RequestStopped || error instanceof BrowserUnavailable) return error;
  const timedOut = error instanceof Error && error.name === 'TimeoutError';
  return new LoginFailed(`Sign-in failed while ${step}${timedOut ? ' (timed out)' : ''}.`);
}

/** The only text about a sign-in error that may reach logs or the terminal. */
export function safeLoginMessage(error: unknown): string {
  if (error instanceof LoginFailed || error instanceof BrowserUnavailable) return error.message;
  if (error instanceof RequestStopped) return `Sign-in stopped (${error.code}).`;
  return 'Sign-in failed with an unexpected error.';
}
