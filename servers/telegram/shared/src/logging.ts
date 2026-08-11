/**
 * stderr only, and NEVER a credential.
 *
 * stdout is the stdio transport's wire in some hosts, and in the bundle it is a
 * stream strad deliberately does not ship — so a line here is for a human
 * reading container output, never for telemetry.
 *
 * This server holds a session string that IS a logged-in Telegram account. No
 * code here passes one to these functions — but the text they carry is often an
 * error message from a library this repo does not own, so `redact` runs over
 * every one of them, and over every error a TOOL returns (see tools/shared.ts).
 * A credential that reaches a caller is worse than a message that says nothing.
 */

const PREFIX = "[telegram]";

/**
 * Anything shaped like a credential this server holds.
 *
 * Two shapes, because they are two lengths: a session string is a long base64-ish
 * run, and an api hash is exactly 32 hex characters — under any length threshold
 * that would catch the session, which is why it is matched on its own terms.
 */
const SECRET_SHAPES: RegExp[] = [
  /[A-Za-z0-9+/=_-]{40,}/g,
  /\b[0-9a-f]{32}\b/gi,
];

export function redact(message: string): string {
  return SECRET_SHAPES.reduce(
    (text, shape) => text.replace(shape, "[redacted]"),
    message,
  );
}

export function logWarning(message: string): void {
  console.error(`${PREFIX} WARN ${redact(message)}`);
}

export function logError(message: string): void {
  console.error(`${PREFIX} ERROR ${redact(message)}`);
}
