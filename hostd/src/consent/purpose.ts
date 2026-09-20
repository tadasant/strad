/**
 * The caller's stated purpose, as it will appear in a dialog on someone's screen.
 *
 * It is untrusted text headed for a UI, so it is normalised before anything else
 * sees it: control characters out, whitespace collapsed, length capped. Two
 * sentences is the owner's rule — a purpose is a reason, not a briefing, and a
 * dialog that has to be read in five seconds cannot carry a paragraph.
 *
 * A purpose that breaks the rule is REFUSED, not trimmed. A silently truncated
 * purpose is a dialog that shows the harmless first half of a sentence.
 */
export const MAX_PURPOSE_CHARS = 280;
export const MAX_PURPOSE_SENTENCES = 2;

/**
 * C0 and C1 controls, the line and paragraph separators, and the bidi overrides
 * and isolates — the last because a right-to-left override can make a dialog
 * DISPLAY a purpose other than the one that was sent.
 */
const UNPRINTABLE =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

export type PurposeResult =
  { ok: true; purpose: string } | { ok: false; reason: string };

export function normalizePurpose(raw: unknown): PurposeResult {
  if (typeof raw !== "string") {
    return { ok: false, reason: "purpose is required and must be a string" };
  }
  const purpose = raw.replace(UNPRINTABLE, " ").replace(/\s+/g, " ").trim();
  if (purpose.length < 8) {
    return {
      ok: false,
      reason:
        "purpose is too short to mean anything to the person reading it — say what you are about to do and why",
    };
  }
  if (purpose.length > MAX_PURPOSE_CHARS) {
    return {
      ok: false,
      reason: `purpose is ${purpose.length} characters; the limit is ${MAX_PURPOSE_CHARS}`,
    };
  }
  const sentences = countSentences(purpose);
  if (sentences > MAX_PURPOSE_SENTENCES) {
    return {
      ok: false,
      reason: `purpose is ${sentences} sentences; the limit is ${MAX_PURPOSE_SENTENCES}`,
    };
  }
  return { ok: true, purpose };
}

/** A terminator followed by whitespace and more text starts a new sentence. */
export function countSentences(text: string): number {
  const boundaries = text.match(/[.!?]+["')\]]*\s+(?=\S)/g);
  return (boundaries?.length ?? 0) + 1;
}
