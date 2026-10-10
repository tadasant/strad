/**
 * stderr only, and NEVER the key.
 *
 * stdout is the stdio transport's wire in some hosts, and in the bundle it is a
 * stream strad deliberately does not ship — so a line here is for a human
 * reading container output, never for telemetry.
 */

const PREFIX = "[flightaware]";

/**
 * Anything shaped like an AeroAPI key.
 *
 * A BACKSTOP, NOT THE PRIMARY DEFENCE. The exact rule — remove the literal key —
 * runs in client.ts and again over every tool result (tools/shared.ts), because
 * those are the places that know the value. This one catches a key-shaped run
 * in error text nobody anticipated.
 *
 * An AeroAPI key is a 32-character alphanumeric run. The pattern deliberately
 * excludes `-` and `_`, so the identifiers this server prints constantly
 * survive it: an `fa_flight_id` is `UAL1234-1234567890-airline-0123`, dashes
 * and all, and an ICAO code is four letters. It runs over ERROR text only — a
 * success payload carries pagination cursors that are long opaque runs, and
 * redacting one would break the next page.
 */
const SECRET_SHAPES: RegExp[] = [/[A-Za-z0-9]{32,}/g];

export function redact(message: string): string {
  return SECRET_SHAPES.reduce(
    (text, shape) => text.replace(shape, "[redacted]"),
    message,
  );
}

/**
 * Remove a literal secret from text this server did not write. A short or empty
 * value would make `split`/`join` catastrophic — splitting on "" inserts the
 * replacement between every character — so anything under 8 characters is
 * left alone; no real key is that short.
 */
export function scrubLiteral(text: string, secret: string | undefined): string {
  if (!secret || secret.length < 8) return text;
  return text.split(secret).join("[redacted]");
}

export function logWarning(message: string): void {
  console.error(`${PREFIX} WARN ${redact(message)}`);
}
