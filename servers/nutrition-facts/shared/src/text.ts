/**
 * Matching a caller's words against a source's names.
 *
 * DELIBERATELY SIMPLE AND DETERMINISTIC. The caller is an LLM that can rephrase
 * and retry, and every candidate carries its score, so what matters is that a
 * score means the same thing every time and that the runners-up are visible —
 * not that the matcher is clever. No embeddings, no LLM call (a spec non-goal).
 *
 * The score is token overlap: how much of the QUERY the name covers (80% of
 * the weight — "chicken breast" must find "Chicken, broilers or fryers, breast,
 * meat only, cooked, roasted"), and how much of the NAME the query covers (a
 * tie-breaker that prefers the plainer entry over the one with eleven
 * qualifiers).
 */

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "the",
  "of",
  "with",
  "w",
  "in",
  "on",
  "for",
  "or",
  "to",
  "from",
  "style",
  "type",
  "made",
  "nfs",
  "ns",
]);

/**
 * Lowercase, strip accents and punctuation, drop stop words, fold simple
 * plurals. "Tomatoes, grape, raw" → ["tomato", "grape", "raw"].
 */
export function tokens(text: string): string[] {
  return normalize(text)
    .split(" ")
    .filter((t) => t.length > 0 && !STOP_WORDS.has(t))
    .map(stem);
}

/**
 * USDA's "this is the plain one" qualifiers. FNDDS writes "Rice, white,
 * cooked, no added fat" and "…, NS as to fat added in cooking" for its default
 * entry; counted as words, they would make the plain entry LOSE to "Rice,
 * white, cooked, made with oil" on a query that never mentioned fat.
 */
const NEUTRAL_PHRASES = [/\bno added fat\b/gi, /\bns as to [^,]*/gi, /\bnfs\b/gi];

/** Tokens of a source's food NAME: `tokens`, minus USDA's neutral qualifiers. */
export function nameTokens(name: string): string[] {
  return tokens(NEUTRAL_PHRASES.reduce((t, re) => t.replace(re, " "), name));
}

/** Lowercase, accents folded, every run of non-alphanumerics a single space. */
export function normalize(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Letters and digits only: "McDonald's" → "mcdonalds", "Chick-Fil-A" → "chickfila". */
export function squash(text: string): string {
  return normalize(text).replace(/ /g, "");
}

/**
 * Plural folding, and only that. A real stemmer turns "dressing" into "dress"
 * and "chips" into "chip" alike, and the first is wrong in a way a caller can
 * not see; these three rules are wrong rarely and symmetrically (both sides of
 * a comparison are folded the same way).
 */
export function stem(token: string): string {
  if (token.length > 4 && token.endsWith("ies")) return token.slice(0, -3) + "y";
  if (token.length > 4 && /(ches|shes|xes|oes)$/.test(token)) {
    return token.slice(0, -2);
  }
  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) {
    return token.slice(0, -1);
  }
  return token;
}

function tokenMatches(q: string, n: string): boolean {
  if (q === n) return true;
  // Near-equal only: a spelling the plural fold missed ("tomatoe"/"tomato").
  // A real prefix match is wrong more often than right here — "apple" is not
  // "applebees", and "cheeseburger" is not "cheese".
  const [short, long] = q.length <= n.length ? [q, n] : [n, q];
  return short.length >= 4 && long.startsWith(short) && long.length - short.length <= 2;
}

export interface MatchScore {
  /** 0..1. */
  score: number;
  /** Fraction of the query's words the name contains. */
  coverage: number;
}

/**
 * Score `name` against an already-tokenised query. `nameTokens` may be
 * precomputed (the local datasets do, once, at load).
 */
export function scoreTokens(
  query: readonly string[],
  nameTokens: readonly string[],
): MatchScore {
  if (query.length === 0 || nameTokens.length === 0) {
    return { score: 0, coverage: 0 };
  }
  let matchedQuery = 0;
  for (const q of query) {
    if (nameTokens.some((n) => tokenMatches(q, n))) matchedQuery += 1;
  }
  let matchedName = 0;
  for (const n of nameTokens) {
    if (query.some((q) => tokenMatches(q, n))) matchedName += 1;
  }
  const coverage = matchedQuery / query.length;
  const precision = matchedName / nameTokens.length;
  return { score: 0.8 * coverage + 0.2 * precision, coverage };
}

export function score(query: string, name: string): MatchScore {
  return scoreTokens(tokens(query), tokens(name));
}

export type MatchLabel = "exact" | "strong" | "partial" | "weak";

/**
 * What a score means, in the words a caller reads. `weak` is still returned —
 * it is evidence of what the source had — but it never sets the expected value
 * and is left out of the range (see estimate.ts).
 */
export function matchLabel(s: number): MatchLabel {
  if (s >= 0.95) return "exact";
  if (s >= 0.75) return "strong";
  if (s >= 0.5) return "partial";
  return "weak";
}

/** Below this a candidate is not reported at all: the source had no match. */
export const MIN_SCORE = 0.3;

/**
 * Below this a candidate is reported but does not enter the range, and a
 * chain's menu item does not count as the chain having the item. 0.65 is a
 * query whose words are mostly all there: "chicken burrito" against a menu's
 * bare "Chicken" (one of two words) is 0.6, and stays out.
 */
export const RANGE_MIN_SCORE = 0.65;
