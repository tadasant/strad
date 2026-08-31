import { createCleaner } from './cleaner-factory.js';
import { detectContentType } from './content-type-detector.js';
import { logWarning } from '../logging.js';

/**
 * The floor, in characters, under which a cleaned page is treated as nothing a
 * caller could read.
 *
 * Measured rather than guessed, against this cleaner:
 *
 *   craigslist-shaped client-rendered shell (698 bytes of markup)   ->  0 chars
 *   `<html><body></body></html>`                                    ->  0 chars
 *   `<h1>Not Found</h1><p>The requested URL was not found…</p>`     -> 60 chars
 *   `<h1>Status</h1><p>All systems operational.</p>`                -> 34 chars
 *   `<p>Not found.</p>`                                             -> 10 chars
 *
 * Eight sits above every extraction a page that drew NOTHING can produce — the
 * reported failure produces exactly zero, and the residue a lossy clean can
 * leave behind (a bare `#`, a stray bullet, an empty comment pair) is a handful
 * of characters — and below the shortest extraction measured that carries a
 * sentence. It is deliberately near the floor: a false escalation spends a paid
 * credential AND turns a short-but-real page into "unknown", which is the same
 * over-claiming this check exists to remove, pointed the other way.
 */
export const MIN_EXTRACTED_CHARS = 8;

export interface ExtractionAssessment {
  /** Could a caller read anything out of these bytes? */
  readable: boolean;
  /** The cleaned text, when the cleaner ran. Absent when it threw. */
  text?: string;
  /** Why not — a phrase, for the per-strategy diagnostics. */
  reason?: string;
}

/**
 * Can anything actually be READ out of the bytes a strategy fetched?
 *
 * "The response had a body" and "the page had content" are different questions,
 * and the strategy chain has always answered the first while reporting the
 * second. A client-rendered page answers 200 with a full document whose content
 * is drawn by JavaScript that never runs here, so the bytes are present and the
 * extraction is empty — which is the canonical signal for "this strategy could
 * not read this page", not for "this page has nothing on it".
 *
 * The cleaner runs HERE, once, so its verdict is available to the decision that
 * needs it; the text it produced travels back on the result rather than being
 * recomputed by the caller.
 */
export async function assessExtraction(
  content: string,
  url: string
): Promise<ExtractionAssessment> {
  if (content.trim().length === 0) {
    return { readable: false, reason: 'fetched an empty body' };
  }

  let text: string;
  try {
    text = await createCleaner(content, url).clean(content, url);
  } catch (error) {
    // OUR failure to clean says nothing about the page. Do not spend another
    // strategy on it, and leave the caller to fall back to the raw bytes.
    logWarning('assessExtraction', `cleaning failed, treating the page as readable: ${error}`);
    return { readable: true };
  }

  // Only a LOSSY clean can turn a fetched page into nothing. JSON, XML and
  // plain text come back byte-identical, so their extraction is readable
  // exactly when their bytes are — which the empty check above already decided.
  // Holding them to a character floor would escalate `{"ok":true}` to a paid
  // strategy that would return the same eleven bytes.
  if (detectContentType(content, url) !== 'text/html') {
    return { readable: true, text };
  }

  const extracted = text.trim().length;
  if (extracted < MIN_EXTRACTED_CHARS) {
    return {
      readable: false,
      text,
      reason:
        `fetched ${content.length} bytes but extracted ${extracted} characters of readable ` +
        `content — the page is likely rendered client-side`,
    };
  }

  return { readable: true, text };
}
