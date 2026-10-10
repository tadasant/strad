/**
 * Scrubbing, and the one stderr line this server writes.
 *
 * stdout is the stdio transport's wire in some hosts, and in the bundle it is a
 * stream strad deliberately does not ship — so a line here is for a human
 * reading container output, never for telemetry.
 */

const PREFIX = "[airtable]";

/**
 * Anything shaped like the credential, in ERROR text.
 *
 * A BACKSTOP, NOT THE PRIMARY DEFENCE — `scrubSecret` removes the literal token
 * from everything this server returns. This one catches a token-shaped run in
 * text nobody anticipated (a different token pasted into a field, an upstream
 * error quoting a header). A PAT is `pat` + 14 characters + `.` + 64 hex; the
 * generic rule is any 48+ run of token characters.
 *
 * It runs on errors only. Record IDs (`rec` + 14) survive it, but attachment
 * URLs in a successful read carry long signed segments that would not, and
 * mangling a record's data to protect a credential that is not in it would
 * make every attachment read useless.
 */
const SECRET_SHAPES: RegExp[] = [
  /pat[A-Za-z0-9]{14}\.[A-Fa-f0-9]{64}/g,
  /[A-Za-z0-9+/=_.-]{48,}/g,
];

export function redact(message: string): string {
  return SECRET_SHAPES.reduce(
    (text, shape) => text.replace(shape, "[redacted]"),
    message,
  );
}

/**
 * Remove the literal token from any text. A short or empty token would make
 * `split`/`join` catastrophic — splitting on "" inserts the replacement between
 * every character — so anything under 8 characters is left alone.
 */
export function scrubSecret(text: string, secret: string | undefined): string {
  const token = secret?.trim();
  if (!token || token.length < 8) return text;
  return text.split(token).join("[redacted]");
}

export function logWarning(message: string): void {
  console.error(`${PREFIX} WARN ${redact(message)}`);
}
