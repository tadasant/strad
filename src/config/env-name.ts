/**
 * What a legal environment-variable name is — the rule, stated once.
 *
 * This is one rule with two spellings. The BARE form names a variable on a
 * container (`GRANOLA_TOKEN`); the REFERENCE form is that name written inside a
 * config value (`Bearer ${GRANOLA_TOKEN}`) for something to substitute later.
 * Both are the same character class, and they were written out as a literal
 * regex in eleven modules with nothing holding them together.
 *
 * The rule is load-bearing in two places where a disagreement is SILENT:
 *
 *   PATH COMPOSITION. `src/config/schema.ts` gates what may appear in
 *   `paramsWritable:` / `paramsRefresh:`, because core composes
 *   `/strad/{env}/mcp/{slug}/static/{VARIABLE}` out of the config's copy of the
 *   string rather than out of the URL a caller sent. `src/secrets/param-route.ts`
 *   is the route's own second gate on the same composition. If they disagree the
 *   config gate is the one that decides, which is the wrong way round.
 *
 *   REFERENCE SCANNING. `collectSecretRefs()` in `src/deploy/appspec.ts` decides
 *   which `${NAME}`s the RENDERER injects; `refsIn()` in
 *   `src/secrets/provider/resolve.ts` decides which ones the RESOLVER looks up at
 *   request time. A name one accepts and the other does not is a credential baked
 *   under a name nothing reads, or a request-time lookup for a name nothing baked.
 *
 * ZERO IMPORTS, and that is the point rather than an accident. `schema.ts` is the
 * most import-constrained consumer and the console's own gate
 * (`validateVariableName`) used to live in `src/secrets/parameters/namespace.ts`,
 * which imports `wire.ts` — so the rule was copied rather than imported. The RULE
 * has no dependencies; only its old home did. It lives here now, and every
 * consumer imports it.
 *
 * NOT EVERY COPY IS GONE. `src/secrets/presence.ts`, `src/secrets/param-route.ts`
 * and `src/secrets/env-prefix.ts` are vendored byte-for-byte across an npm-tree
 * boundary (`scripts/sync-vendored.mjs`) and cannot import a module that does not
 * cross with them, so those three keep their own literal. See `HACKS.md` #81.
 */

/**
 * The character class, UNANCHORED, as a source string.
 *
 * Exported because two consumers need the source rather than a compiled regex:
 * the reference form embeds it, and `src/ui/render.ts` writes it into the
 * browser's `pattern=` attribute — which HTML anchors implicitly, so the
 * attribute wants exactly this and the server gate wants it between `^` and `$`.
 * One string, both gates.
 */
export const ENV_NAME_SOURCE = "[A-Za-z_][A-Za-z0-9_]*";

/**
 * The bare form: a whole string that is a legal variable name.
 *
 * Safe to share as one object because it is NOT global — `test()` on a
 * non-global regex does not read or write `lastIndex`. The `/g` half of this
 * module is a factory for exactly that reason; see `secretRefRe`.
 */
export const ENV_NAME_RE = new RegExp(`^${ENV_NAME_SOURCE}$`);

/** Whether `value` is a legal environment-variable name. */
export function isEnvName(value: string): boolean {
  return ENV_NAME_RE.test(value);
}

/**
 * The reference form — `${NAME}` — with the name in capture group 1, as a source
 * string.
 *
 * A source string and not a regex OBJECT, because every use of this form is
 * global and a shared `/g` object carries `lastIndex` between calls. `matchAll`
 * and `replace` happen to be safe with one; `test` and `exec` are not, and the
 * failure is a `${NAME}` silently skipped on every other call — which in this
 * codebase means a credential not baked or not resolved. Construct a fresh one.
 */
export const SECRET_REF_SOURCE = "\\$\\{([A-Za-z_][A-Za-z0-9_]*)\\}";

/** A FRESH global regex for the `${NAME}` form. Never share the object. */
export function secretRefRe(): RegExp {
  return new RegExp(SECRET_REF_SOURCE, "g");
}

/** Every distinct `${NAME}` in a string, in first-appearance order. */
export function secretRefsIn(value: string): string[] {
  const out: string[] = [];
  for (const match of value.matchAll(secretRefRe())) {
    const name = match[1];
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/**
 * Parameter Manager's cap on a variable name, in characters.
 *
 * A name past it addresses a parameter that cannot exist, so every gate that
 * composes a parameter path checks it alongside the shape.
 */
export const MAX_VARIABLE_LENGTH = 200;

/**
 * Validate a variable name for a new parameter.
 *
 * A parameter's variable is injected as an ENVIRONMENT VARIABLE into a server's
 * process, so it must be a legal env var name: it is not free-form. This is the
 * console's first gate; it turns "GCP rejected your id" into a sentence.
 *
 * Re-exported from `src/secrets/parameters/index.ts`, which is where the console
 * imports it from.
 */
export function validateVariableName(variable: string): string | null {
  if (!variable) return "A variable name is required.";
  if (variable.length > MAX_VARIABLE_LENGTH) {
    return `A variable name may be at most ${MAX_VARIABLE_LENGTH} characters.`;
  }
  if (!isEnvName(variable)) {
    return "A variable name must be a valid environment variable name (letters, digits and underscores; not starting with a digit).";
  }
  return null;
}
