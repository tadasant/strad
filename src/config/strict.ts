import { configDocument } from "./load.ts";
import { StradConfig } from "./schema.ts";

/**
 * Strict parsing: a key the schema does not know is an ERROR, not a shrug.
 *
 * ## Why this is separate from the boot path
 *
 * `parseConfig` is deliberately lenient about unknown keys, because the schema is
 * built from Zod objects and Zod strips what it does not recognise. That default
 * is right at RUNTIME: the config and the image version independently, and an
 * image that refused to boot on a key it had never heard of would turn a rollback
 * into an outage — the older image would reject the config the newer one wrote.
 *
 * It is exactly wrong at DEPLOY time. A stripped key is a key that did nothing,
 * silently, and the config is the only place a strad deployment says what it is.
 * `consoleEnvs:` for `consoleEnv:` parses clean, renders clean, deploys clean and
 * produces a console with no admin credential — which is how that shipped to
 * production once.
 *
 * So: lenient where a false failure costs an outage, strict where a false pass
 * costs a silent misconfiguration. This module is the strict half, and
 * `scripts/check-config.ts` is what CI calls.
 *
 * ## How it detects unknown keys
 *
 * By DIFFING rather than by re-declaring. The document is parsed with the real
 * schema, and every key present in the YAML but absent from the parse result was
 * stripped — which is precisely the definition of "the schema does not know it".
 *
 * A second, hand-maintained strict schema would be the obvious alternative and is
 * the worse one: it would be a copy of `schema.ts` that has to be edited in
 * lockstep with it, and the failure mode of forgetting is a check that quietly
 * stops checking. The diff cannot drift, because it has nothing to drift from.
 *
 * Two things are deliberately NOT reported:
 *   - keys the schema ADDS (defaults). They are in the result and not the source;
 *     the walk only ever looks at what the source declared.
 *   - keys inside a `z.record()` map — `env:`, `consoleEnv:`, `roles:`, a
 *     builtin's `options:`. Those are open by design; the schema keeps every key,
 *     so the diff finds nothing. A typo'd ENV VAR name is not detectable here and
 *     never could be. A typo'd CONFIG key is.
 *
 * ## The one thing the diff cannot see, and what stands in for it
 *
 * `mcpServers:` — the `mcp.json` dialect (`src/config/mcp-json.ts`) — is folded
 * into `servers:` BEFORE the schema runs, so by the time there is a parse result
 * to diff against, the key the operator wrote is gone and the entries they wrote
 * have been rebuilt from a fixed set of fields. Diffing the RAW document would
 * report `mcpServers` itself as unknown and would find a `servers:` list of a
 * different length, which stops the index-wise walk dead.
 *
 * So this diffs the DESUGARED document — the one the schema actually parsed —
 * and the dialect reports its own unknown keys, against its own key paths, from
 * the one place that still has the entries as written. Same guarantee, same
 * output shape, two producers.
 */

export interface UnknownKey {
  /** Dotted path to the containing node, e.g. `servers[7]`. "" for the root. */
  path: string;
  /** The key the schema stripped. */
  key: string;
  /** The nearest known key at that level, when one is close enough to mean it. */
  suggestion?: string;
}

/** `{...}` and nothing else — not an array, not null, not a Date. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Classic Levenshtein. Small inputs (config keys), so the naive form is fine. */
function distance(a: string, b: string): number {
  const cols = b.length + 1;
  let prev = Array.from({ length: cols }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = Array<number>(cols).fill(0);
    cur[0] = i;
    for (let j = 1; j < cols; j++) {
      cur[j] = Math.min(
        (prev[j] ?? 0) + 1,
        (cur[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[cols - 1] ?? 0;
}

/**
 * The nearest known key, if it is near enough to be worth naming.
 *
 * The threshold scales with length so `consoleEnvs` -> `consoleEnv` is offered
 * while two genuinely different short keys are not confidently confused.
 *
 * Best-effort by construction: the candidates are the keys the PARSE RESULT
 * holds at that node, so a required or defaulted key can be suggested and an
 * omitted optional one cannot. Detection never depends on it — an unknown key is
 * reported with or without a suggestion.
 */
function nearest(key: string, known: string[]): string | undefined {
  const limit = Math.max(1, Math.floor(key.length / 3));
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const candidate of known) {
    const d = distance(key.toLowerCase(), candidate.toLowerCase());
    if (d < bestDistance) {
      bestDistance = d;
      best = candidate;
    }
  }
  return bestDistance <= limit ? best : undefined;
}

function walk(
  raw: unknown,
  kept: unknown,
  path: string,
  out: UnknownKey[],
): void {
  if (Array.isArray(raw) && Array.isArray(kept) && raw.length === kept.length) {
    // Index-wise: the schema never reorders or filters a list, so position is a
    // stable identity here.
    raw.forEach((item, i) => walk(item, kept[i], `${path}[${i}]`, out));
    return;
  }
  if (!isPlainObject(raw) || !isPlainObject(kept)) return;

  const known = Object.keys(kept);
  for (const [key, value] of Object.entries(raw)) {
    if (!Object.prototype.hasOwnProperty.call(kept, key)) {
      out.push({ path, key, suggestion: nearest(key, known) });
      continue;
    }
    walk(value, kept[key], path ? `${path}.${key}` : key, out);
  }
}

/**
 * Every key the schema silently dropped, in document order.
 *
 * Takes an already-validated config so the caller controls how a schema error is
 * reported — a document that does not parse at all has no meaningful diff.
 */
export function unknownConfigKeys(
  raw: string,
  parsed: StradConfig,
): UnknownKey[] {
  const dialect = configDocument(raw);
  const out: UnknownKey[] = [];
  for (const u of dialect.unknownKeys) {
    out.push({
      path: u.path,
      key: u.key,
      suggestion: nearest(u.key, [...u.known]),
    });
  }
  walk(dialect.doc, parsed, "", out);
  return out;
}

/** `path.key`, or just `key` at the root. */
export function formatUnknownKey(u: UnknownKey): string {
  const where = u.path ? `${u.path}.${u.key}` : u.key;
  return u.suggestion ? `${where} (did you mean "${u.suggestion}"?)` : where;
}
