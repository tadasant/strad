import { stringify as stringifyYaml } from "yaml";
import { isDeepStrictEqual } from "node:util";
import { parseYamlDocument } from "../config/load.ts";

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
 * The document is round-tripped — parsed to plain values and re-emitted — which
 * drops comments and normalises formatting. That is only safe if the values
 * survive it, so this checks, on every render:
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
 * **Both sides of that comparison go through `parseYamlDocument`, the function
 * BOOT parses `STRAD_CONFIG_YAML` with**, and that is what makes the equality a
 * proof rather than a coincidence. It is not a stylistic preference: re-emitting
 * rewrites scalars into forms whose meaning is parser-dependent. `a: "2024-01-01"`
 * comes back as `a: 2024-01-01` and `a: "yes"` as `a: yes` — identical under the
 * YAML 1.2 core schema this repo parses with, and DIFFERENT under YAML 1.1, where
 * they are a timestamp and a boolean. Comparing with a second, independently
 * configured parser would call that round trip lossless while the container read
 * something else. Import from `src/config/load.ts` here; never from `yaml`.
 *
 * The one gap deep-equality cannot close: the renderer resolves `yaml` at CI
 * checkout and the container resolves it at image build, so in principle they are
 * two installs of the same range. The emitted text also uses constructs a
 * hand-written config would not (indentation indicators, generated anchors). The
 * range is narrow and the schema is stable, so this is a caveat rather than a
 * risk — but it is the reason the fallback exists rather than an assertion.
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
 * Total: every parse, emit and compare runs inside a `try`, so a document this
 * cannot handle costs the saving and never the render. A malformed config is not
 * this function's error to report — `parseConfig` reports it a few lines later,
 * with the message built for it.
 */
export function inlineConfigYaml(raw: string): InlineConfigResult {
  const rawBytes = Buffer.byteLength(raw, "utf8");
  const kept = (because: string): InlineConfigResult => ({
    yaml: raw,
    rawBytes,
    inlinedBytes: rawBytes,
    keptRawBecause: because,
  });
  // A reason names the FAULT and never the input. `yaml`'s messages quote the
  // source, and the source is a config that may hold a `${NAME}` or, in another
  // deployment, a literal credential.
  const fault = (err: unknown): string =>
    err instanceof Error ? err.name : "unknown error";

  // A malformed config is not this function's error to report — `parseConfig`
  // reports it, with the message built for it — so it is kept apart from a
  // failure to RE-EMIT a document that parsed fine. They have different causes
  // and only one of them is the config author's.
  let document: unknown;
  try {
    document = parseYamlDocument(raw);
  } catch (err) {
    return kept(`the config file did not parse (${fault(err)})`);
  }

  let emitted: string;
  try {
    // `lineWidth: 0` disables line folding. Folding is lossless in YAML, but it
    // rewrites the interior of long scalars, which is exactly the kind of change
    // this function should not be making to a credential-bearing document — and
    // it does not save bytes either way.
    emitted = stringifyYaml(document, { lineWidth: 0 });
  } catch (err) {
    return kept(`the document could not be re-emitted (${fault(err)})`);
  }

  try {
    const reparsed = parseYamlDocument(emitted);
    if (!isDeepStrictEqual(reparsed, document)) {
      return kept("the re-emitted document does not hold the same values");
    }
  } catch (err) {
    return kept(`the re-emitted document did not parse (${fault(err)})`);
  }

  const inlinedBytes = Buffer.byteLength(emitted, "utf8");
  if (inlinedBytes >= rawBytes) {
    return kept("the re-emitted document is no smaller");
  }

  return { yaml: emitted, rawBytes, inlinedBytes };
}
