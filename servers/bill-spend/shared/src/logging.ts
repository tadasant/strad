/**
 * stderr only, and NEVER the token.
 *
 * stdout is the stdio transport's wire in some hosts, and in the bundle it is a
 * stream strad deliberately does not ship — so a line here is for a human
 * reading container output, never for telemetry.
 *
 * This server holds one credential that is unscoped ADMIN on a company's card
 * program. No code here passes it to these functions, but most of the text they
 * carry is an error message BILL wrote rather than one this server wrote, so
 * `redact` runs over every one of them and over every error a TOOL returns (see
 * tools/shared.ts). An error that quotes the token back at a caller hands over
 * the ability to issue a card.
 */

const PREFIX = "[bill-spend]";

/**
 * Anything shaped like the credential this server holds.
 *
 * A BACKSTOP, NOT THE PRIMARY DEFENCE. The exact rule — scrub the literal token
 * — lives in client.ts, which is the only module holding the value. This one
 * catches a credential-shaped run in text nobody anticipated, and it is a length
 * threshold, so it necessarily trades false positives against false negatives:
 * an identifier this long would be redacted out of the very `InputError` that
 * names it. The threshold sits above every BILL identifier observed and the
 * exact rule covers the case that matters, so the trade lands here.
 *
 * A BILL Spend & Expense apiToken is a long opaque run of base64url-ish
 * characters. The threshold is deliberately below any token length seen, and
 * deliberately above the identifiers this server prints constantly: a BILL
 * `uuid` is 36 characters with dashes, and a base64 `id` is short. Both are
 * public identifiers and both must survive redaction, or every result this
 * server returns becomes unusable.
 */
const SECRET_SHAPES: RegExp[] = [/[A-Za-z0-9+/=_-]{48,}/g];

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
