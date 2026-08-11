/**
 * stderr only, and NEVER a credential.
 *
 * stdout is the stdio transport's wire in some hosts, and in the bundle it is a
 * stream strad deliberately does not ship — so a line here is for a human
 * reading container output, never for telemetry.
 *
 * This server holds a session string that IS a logged-in Telegram account. It is
 * never passed to these functions, and `redact` exists so a message that carries
 * one by accident says so instead of printing it.
 */

const PREFIX = "[telegram]";

/** Anything that looks like a MTProto session string or an api hash. */
const SECRET_SHAPE = /[A-Za-z0-9+/=_-]{40,}/g;

export function redact(message: string): string {
  return message.replace(SECRET_SHAPE, "[redacted]");
}

export function logWarning(message: string): void {
  console.error(`${PREFIX} WARN ${redact(message)}`);
}

export function logError(message: string): void {
  console.error(`${PREFIX} ERROR ${redact(message)}`);
}
