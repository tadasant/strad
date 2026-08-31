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

/**
 * The most bytes this check will clean to reach a verdict.
 *
 * The cleaner's cost tracks the amount of content it EXTRACTS, not the size of
 * the document: a 906KB client-rendered shell cleans in 833ms because there is
 * nothing in it, while an 846KB page of prose takes 5.8s and a 2MB one takes
 * 42s. So a size ceiling that skipped large documents would exempt exactly the
 * shells this check is for, and still leave the expensive case unbounded.
 *
 * Capping the INPUT bounds it the other way round — ~1s at any document size,
 * measured — and costs almost nothing in accuracy: a page that draws nothing
 * draws nothing in its first 256KB either, and a page that draws something
 * clears an eight-character floor long before then. The trade is a page whose
 * entire content sits past 256KB of head and script, which is judged on a
 * prefix that did not reach it.
 *
 * A partial clean is a verdict only. Its text is NOT handed back, because the
 * caller would render a truncated page as the whole one.
 */
const ASSESS_MAX_BYTES = 256 * 1024;

export interface ExtractionAssessment {
  /** Could a caller read anything out of these bytes? */
  readable: boolean;
  /** The cleaned text, when the whole document was cleaned. */
  text?: string;
  /** Why not — a phrase, for the per-strategy diagnostics. */
  reason?: string;
  /** Were these bytes empty to begin with? An empty page is empty, not unknown. */
  empty?: boolean;
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
  content: string | undefined,
  url: string
): Promise<ExtractionAssessment> {
  // An upstream can report success and hand back nothing — firecrawl's payload
  // carries `html` as an optional field. Nothing can be read out of that, and
  // it is the one case where "empty" is the honest word rather than "unknown".
  if (!content || content.trim().length === 0) {
    return { readable: false, empty: true, reason: 'fetched an empty body' };
  }

  const partial = content.length > ASSESS_MAX_BYTES;
  const assessed = partial ? content.slice(0, ASSESS_MAX_BYTES) : content;

  let text: string;
  try {
    text = await createCleaner(assessed, url).clean(assessed, url);
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
  const lossless = detectContentType(assessed, url) !== 'text/html';
  if (lossless) {
    return { readable: true, text: partial ? undefined : text };
  }

  const extracted = text.trim().length;
  if (extracted < MIN_EXTRACTED_CHARS) {
    return {
      readable: false,
      text: partial ? undefined : text,
      reason:
        `fetched ${content.length} bytes but extracted ${extracted} characters of readable ` +
        `content — the page is likely rendered client-side`,
    };
  }

  return { readable: true, text: partial ? undefined : text };
}
