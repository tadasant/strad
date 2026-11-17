/**
 * stderr only, and NEVER a message's text, a login field or a key.
 *
 * The bundle's stdout/stderr stream is not shipped anywhere — a line here is
 * for a human reading container output. The text these functions carry is
 * often an error written by a library this repo does not own (mautrix-meta,
 * Meta's own servers, the GCS client), so `redact` runs over every line and
 * over every error a tool returns.
 */

const PREFIX = "[messenger]";

const SECRET_SHAPES: RegExp[] = [
  /-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g,
  /[A-Za-z0-9+/=_-]{40,}/g,
];

export function redact(message: string): string {
  return SECRET_SHAPES.reduce((text, shape) => text.replace(shape, "[redacted]"), message);
}

export function logInfo(message: string): void {
  console.error(`${PREFIX} ${redact(message)}`);
}

export function logWarning(message: string): void {
  console.error(`${PREFIX} WARN ${redact(message)}`);
}

export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
