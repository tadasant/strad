import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { isDeepStrictEqual } from "node:util";

/**
 * The config document, as it is BAKED into `STRAD_CONFIG_YAML`.
 *
 * ## Why this exists
 *
 * `render-spec` inlines the config file into the app spec verbatim, and an App
 * Platform spec has a size the API refuses past. On 2026-08-30 prod's spec
 * crossed it: a 131,010-byte spec deployed at 04:01Z, a 141,342-byte spec was
 * rejected at 19:18Z with `400 … error validating app spec field "App spec":
 * size limit exceeded`, and every prod deploy failed from then on.
 *
 * The measurement that matters is where those bytes were. `STRAD_CONFIG_YAML`
 * was 66,019 of the 141,342 — 47% of the whole spec, on the core component
 * alone — and 44,209 bytes of the 64,531-byte config file were comment-only
 * lines. The growth that crossed the line was itself mostly comments: the
 * config gained 7,644 bytes of prose between the two runs, against 1,390 bytes
 * for the entire new component the deploy was adding.
 *
 * strad's configs carry a lot of prose on purpose — a `bundles:` entry explains
 * why an instance size is what it is, and that comment is the reason the next
 * person does not re-break it. None of it means anything to the process that
 * parses the document at boot. So the prose stays in the FILE, where humans read
 * it, and stops travelling to App Platform, where nothing does.
 *
 * ## Lossless, or it does not happen
 *
 * The document is round-tripped through `yaml` — parsed to plain values and
 * re-emitted — which drops comments and normalises formatting. That is only
 * safe if the values survive it, so this checks, on every render:
 *
 *   - the re-emitted text parses back to a value deep-equal to the original's,
 *     and
 *   - it is actually smaller.
 *
 * Either check failing returns the raw text with a reason. A config whose
 * inlined form would differ is deployed exactly as written, and the deploy log
 * says so — because a shorter spec is worth nothing next to a spec that means
 * something else.
 *
 * Note what is deliberately NOT compared: the Zod-parsed config. Zod strips
 * unknown keys, so comparing parsed configs would call a round trip lossless
 * that had dropped a key the schema does not know about — and boot is lenient
 * about unknown keys on purpose (`src/config/strict.ts`). The comparison is of
 * the YAML documents, before the schema has seen either.
 */
export interface InlineConfigResult {
  /** The text to bake into `STRAD_CONFIG_YAML`. */
  yaml: string;
  /** Bytes of the config file as written. */
  rawBytes: number;
  /** Bytes of `yaml`. Equal to `rawBytes` when the raw text was kept. */
  inlinedBytes: number;
  /**
   * Why the raw text was kept, when it was. Absent means the document was
   * re-emitted; a caller that wants to log the outcome branches on this.
   */
  keptRawBecause?: string;
}

/**
 * Re-emit `raw` without its comments, unless doing so would change what it
 * means or would not save anything.
 *
 * Pure and total: every failure path returns the raw text rather than throwing.
 * A malformed config is not this function's error to report — `parseConfig`
 * reports it a few lines later, with the message built for it.
 */
export function inlineConfigYaml(raw: string): InlineConfigResult {
  const rawBytes = Buffer.byteLength(raw, "utf8");
  const kept = (because: string): InlineConfigResult => ({
    yaml: raw,
    rawBytes,
    inlinedBytes: rawBytes,
    keptRawBecause: because,
  });

  let document: unknown;
  let emitted: string;
  try {
    document = parseYaml(raw);
    // `lineWidth: 0` disables line folding. Folding is lossless in YAML, but it
    // rewrites the interior of long scalars, which is exactly the kind of change
    // this function should not be making to a credential-bearing document — and
    // it does not save bytes either way.
    emitted = stringifyYaml(document, { lineWidth: 0 });
  } catch (err) {
    return kept(
      `the document could not be re-emitted (${err instanceof Error ? err.name : "unknown error"})`,
    );
  }

  let reparsed: unknown;
  try {
    reparsed = parseYaml(emitted);
  } catch (err) {
    return kept(
      `the re-emitted document did not parse (${err instanceof Error ? err.name : "unknown error"})`,
    );
  }

  if (!isDeepStrictEqual(reparsed, document)) {
    return kept("the re-emitted document does not hold the same values");
  }

  const inlinedBytes = Buffer.byteLength(emitted, "utf8");
  if (inlinedBytes >= rawBytes) {
    return kept("the re-emitted document is no smaller");
  }

  return { yaml: emitted, rawBytes, inlinedBytes };
}
