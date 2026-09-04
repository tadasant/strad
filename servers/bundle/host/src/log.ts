/**
 * One log format for the whole bundle, on stderr.
 *
 * Every line names the mount it came from. With 21 upstream servers in one
 * container, "which server did that" is the first question anyone asks — of a
 * crash, a slow call, or a memory spike. (The OpenTelemetry instrumentation
 * carries the same identity as a `server` attribute; these lines are what you
 * read when you are staring at `doctl apps logs`.)
 */
export function log(msg: string): void {
  console.error(`[${new Date().toISOString()}] [bundle] ${msg}`);
}

export function logWarn(msg: string): void {
  log(`WARN ${msg}`);
}

export function logError(scope: string, err: unknown): void {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  log(`[${scope}] ERROR ${message}`);
}

export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
