// GENERATED — DO NOT EDIT.
// Vendored from servers/bundle-api/fork/slack/src/events/webhook by `npm run eventswebhook:sync`.
// Edit the source, run the sync, and commit both. CI fails if these drift.
/**
 * The cursor's wire form, shared by `events/poll` and webhook delivery.
 *
 * A cursor is a buffer sequence number with a version prefix. The sequence
 * itself, and what it means, belongs to each event source's buffer; this file
 * only owns how one is written down, so a cursor delivery puts in a payload is
 * a cursor `events/poll` accepts.
 */
export const CURSOR_PREFIX = 'v1.';

export function encodeCursor(seq: number): string {
  return `${CURSOR_PREFIX}${seq}`;
}
