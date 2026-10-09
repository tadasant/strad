/**
 * stderr only, and NEVER the password, a token or a device secret.
 *
 * The bundle's stdout/stderr stream is not shipped anywhere — a line here is
 * for a human reading container output. No code here passes a secret to these
 * functions, but much of the text they carry is an error written by something
 * this repo does not own (Cognito, Apiture, GCS), so every line and every
 * error a tool returns goes through `redact`:
 *
 * - SHAPES: a long base64/hex/JWT-ish run (an access token, a device key, a
 *   signed URL's signature) and a PEM block.
 * - VALUES: the configured password, literally, wherever it appears. A shape
 *   rule cannot catch a short password; `scrubber` is told the value and
 *   removes it, so an upstream that echoed the password back in an error
 *   message still could not put it in a tool result.
 */

const PREFIX = "[liveoak]";

const SECRET_SHAPES: RegExp[] = [
  /-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g,
  /[A-Za-z0-9+/=_.-]{40,}/g,
];

/** Values that must never appear in output, registered once the config loads. */
const literals = new Set<string>();

/**
 * Register a value — the password — to be removed from every line this module
 * writes and every error `redact` returns. Values shorter than 4 characters are
 * refused: scrubbing "a" from every message would destroy them and protect
 * nothing.
 */
export function registerSecret(value: string | undefined): void {
  if (value && value.length >= 4) literals.add(value);
}

export function redact(message: string): string {
  let text = message;
  for (const value of literals) text = text.split(value).join("[redacted]");
  return SECRET_SHAPES.reduce((t, shape) => t.replace(shape, "[redacted]"), text);
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
