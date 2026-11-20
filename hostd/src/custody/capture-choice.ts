import { looksMasked } from "./vault.js";

/** A credential-shaped string on the page, and where it is. */
export interface Candidate {
  /**
   * A `document.querySelector` selector for the element it is in. Null for
   * an element inside a shadow root, which no document selector reaches.
   */
  selector: string | null;
  token: string;
}

export type CaptureChoice =
  | { kind: "one"; candidate: Candidate }
  | { kind: "several"; candidates: Candidate[] }
  | { kind: "masked"; candidates: Candidate[] }
  | { kind: "none" };

/**
 * Which of the strings a click produced is THE credential, for a capture with
 * no `capture_selector`. `fresh` is already only what was not on the page
 * before the click: a key list's previews of the account's OTHER keys are
 * gone by the time this runs.
 *
 * - A MASKED string (`sk-…abc...xyz`, `••••`) is a provider's display of a
 *   key, never the key, and is never chosen. A provider that adds the new
 *   key to its list as it reveals it renders exactly that, a new string,
 *   beside the real one.
 * - What remains must be exactly one. Two credential-shaped values is
 *   ambiguous and is refused, never guessed — INCLUDING when one contains
 *   the other. "Prefer the longer" holds a key glued to its neighbours (a
 *   `Copy` label, a quoted snippet `api_key="…"`), which looks right by
 *   prefix and length, deposits broken, and arms the filter with a string
 *   the bare key never matches.
 * - Nothing but masked strings is its own answer: the page showed a preview
 *   and the real value is somewhere this diff cannot read.
 */
export function chooseCapture(fresh: readonly Candidate[]): CaptureChoice {
  const masked = fresh.filter((c) => looksMasked(c.token));
  const plain = fresh.filter((c) => !looksMasked(c.token));
  if (plain.length === 1) return { kind: "one", candidate: plain[0]! };
  if (plain.length > 1) return { kind: "several", candidates: plain };
  if (masked.length > 0) return { kind: "masked", candidates: masked };
  return { kind: "none" };
}
