import { AsyncLocalStorage } from 'node:async_hooks';

export type StopCode = 'cancelled' | 'deadline_exceeded' | 'server_closed' | 'queue_full';
export class RequestStopped extends Error {
  constructor(readonly code: StopCode) { super(code); this.name = 'RequestStopped'; }
}
export interface Progress { completed: number; total?: number; message: string; }
export interface RequestOptions { signal?: AbortSignal; timeoutMs?: number; onProgress?: (progress: Progress) => void; }
export class RequestScope {
  readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  readonly deadline: number;
  writeAttempted = false;
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly relay: () => void;
  constructor(private readonly options: RequestOptions = {}) {
    const timeout = options.timeoutMs ?? 45000;
    this.deadline = Date.now() + timeout;
    this.relay = () => this.cancel(options.signal?.reason instanceof RequestStopped ? options.signal.reason.code : 'cancelled');
    if (options.signal?.aborted) this.relay(); else options.signal?.addEventListener('abort', this.relay, { once: true });
    this.timer = setTimeout(() => this.cancel('deadline_exceeded'), timeout);
  }
  cancel(code: StopCode): void { this.controller.abort(new RequestStopped(code)); }
  progress(value: Progress): void { if (!this.signal.aborted) this.options.onProgress?.(value); }
  dispose(): void { clearTimeout(this.timer); this.options.signal?.removeEventListener('abort', this.relay); }
}
const requests = new AsyncLocalStorage<RequestScope>();
export const currentRequest = () => requests.getStore();
export function inRequest<T>(scope: RequestScope, operation: () => Promise<T>): Promise<T> { return requests.run(scope, operation); }
/** Run work that outlives the current tool request, so the request's deadline and cancellation do not stop it. */
export function outsideRequest<T>(operation: () => Promise<T>): Promise<T> { return requests.exit(operation); }
export function checkRequest(): void {
  const scope = currentRequest();
  if (scope?.signal.aborted) throw scope.signal.reason;
  if (scope && Date.now() >= scope.deadline) { scope.cancel('deadline_exceeded'); throw scope.signal.reason; }
}
export function requestTimeout(maximum: number): number { checkRequest(); return Math.max(1, Math.min(maximum, (currentRequest()?.deadline ?? Infinity) - Date.now())); }
export function markWriteAttempted(): void { checkRequest(); const scope = currentRequest(); if (scope) scope.writeAttempted = true; }
export function reportProgress(completed: number, total: number, message: string): void { currentRequest()?.progress({ completed, total, message }); }
/** Retire a browser lease on abort before another operation can acquire it. Late results are ignored. */
export async function requestIO<T>(operation: () => Promise<T>, retire?: () => Promise<void>): Promise<T> {
  checkRequest();
  const signal = currentRequest()?.signal;
  if (!signal) return operation();
  let onAbort: () => void = () => {};
  const stopped = new Promise<never>((_, reject) => {
    onAbort = () => { void retire?.().catch(() => {}); reject(signal.reason); };
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try { const result = await Promise.race([operation(), stopped]); checkRequest(); return result; }
  finally { signal.removeEventListener('abort', onAbort); }
}
export function acquireResource<T>(create: () => Promise<T>, close: (resource: T) => Promise<void>): Promise<T> {
  return requestIO(async () => {
    const resource = await create();
    try { checkRequest(); return resource; }
    catch (error) { await close(resource).catch(() => {}); throw error; }
  });
}
