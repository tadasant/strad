/**
 * What a supplementary server's variable is CALLED on the container, and how the
 * container reads it back.
 *
 * THE PROBLEM. A bundle is a component is a container is one `process.env`. Two
 * servers on one bundle that both write `${TELEGRAM_API_HASH}` want one name to
 * hold two values, and no environment can do that. src/deploy/server-namespaces.ts
 * (the layer under this one) decides which NAMESPACE a value is read FROM; this
 * decides what it is CALLED once it lands. They are different axes and both are
 * needed: a per-server namespace gives you two values, a per-server box name gives
 * you somewhere to put them.
 *
 * THE RULE. Uppercase the slug, turn `-` into `_`, join with `__`:
 *
 *   telegram-ro + TELEGRAM_API_HASH -> TELEGRAM_RO__TELEGRAM_API_HASH
 *
 * INJECTIVITY, which is the whole reason the separator is two characters. A slug
 * cannot contain `_`, so a mangled slug contains `_` only where the slug had `-` —
 * and it contains `__` only where the slug had `--`. Ban `--` in a slug (the SLUG
 * regex in src/config/schema.ts does) and the FIRST `__` in a box name is always
 * the separator, so no two (slug, name) pairs can collide. Without that ban,
 * `a--b` + `C` and `a` + `B__C` are the same variable and one credential silently
 * becomes another. A slug that is a PREFIX of another is fine either way:
 * `telegram` + `RO__X` is `TELEGRAM__RO__X`, `telegram-ro` + `X` is
 * `TELEGRAM_RO__X`.
 *
 * BOTH NAMES EXIST, FOR EVERY SERVER, and the container prefers the prefixed
 * one. There is no condition on the naming: given a config you can work out
 * what a server's variables are called from that server's own entry, without
 * looking at any other server. The trees migrated to an injected env view read
 * `PREFIX__NAME`; the eight that have not keep reading the bare `NAME` they
 * always read. See `slugEnvView`.
 *
 * "Exist" is a claim about the RUNNING container's environment, not about the
 * app spec. On a `strad-bundle` component a per-slug name whose value is already
 * baked under another name travels as a line in `STRAD_ENV_COPIES` instead of a
 * second copy of the value, and the bundle host restores it before anything
 * reads the environment. See {@link applyEnvCopies}.
 *
 * This module is IMPORT-FREE on purpose: it is vendored into the bundle host tree
 * across an npm boundary (`npm run envprefix:sync`). The renderer names the
 * variable and the host reads it; a drift between the two halves is a credential
 * that is present on the box and invisible to the server that needs it, with
 * nothing in any log. `test/vendored.sync.test.ts` is what stands between us and
 * a drift in the RULE, and `test/env-prefix.markers.test.ts` between us and the
 * other way in: the host and a server tree spelling a marker variable
 * differently.
 */

/** Separates a slug's mangled prefix from the variable name. Two characters, deliberately — see above. */
export const SLUG_ENV_SEPARATOR = "__";

/**
 * A name POSIX, App Platform and Docker all accept for an environment variable.
 * The SLUG regex permits a leading digit (`1password`), which mangles to `1PASSWORD`
 * and is not a portable variable name — such a slug simply gets no prefixed alias
 * rather than an unusable one, and keeps working on the bare names.
 */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The box-name prefix for a slug, or null when the slug cannot have one.
 *
 * Null is not an error: it means "this slug is served by its bare names alone",
 * which is exactly what every deployment did before per-slug names existed.
 */
export function slugEnvPrefix(slug: string): string | null {
  // `--` would put the separator inside the prefix and destroy injectivity. The
  // config schema rejects it; this is the half of the guard that travels with the
  // rule, so a caller outside the schema cannot mint an ambiguous name.
  if (slug.includes("--")) return null;
  const prefix = slug.toUpperCase().split("-").join("_");
  return ENV_NAME.test(prefix) ? prefix : null;
}

/** Reverse of {@link slugEnvPrefix}. Exact, because a slug holds no `_`. */
export function envPrefixSlug(prefix: string): string {
  return prefix.toLowerCase().split("_").join("-");
}

/** What `name` is called on the box when it belongs to `slug`. Null when the slug has no prefix. */
export function prefixedEnvName(slug: string, name: string): string | null {
  const prefix = slugEnvPrefix(slug);
  return prefix === null ? null : `${prefix}${SLUG_ENV_SEPARATOR}${name}`;
}

/**
 * The environment as ONE SLUG sees it: `PREFIX__NAME` first, bare `NAME` second.
 *
 * A snapshot, not a live view — a component's environment is baked at deploy time
 * and does not change under a running process, and a snapshot is what makes two
 * instances of one tree in one process independent of each other.
 *
 * The fallback is the entire backward-compatibility argument. A server nobody has
 * given a per-slug name resolves out of the bare names exactly as it did, so this
 * lands with no flag and no transition.
 */
export function slugEnvView(
  env: Readonly<Record<string, string | undefined>>,
  slug: string,
): Record<string, string | undefined> {
  const view: Record<string, string | undefined> = { ...env };
  const prefix = slugEnvPrefix(slug);
  if (prefix === null) return view;

  const head = prefix + SLUG_ENV_SEPARATOR;
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith(head)) continue;
    const name = key.slice(head.length);
    // `PREFIX__` with nothing after it names no variable. Dropping it is not the
    // same as setting "" — an empty name would land under the key "".
    if (name === "") continue;
    view[name] = value;
  }
  return view;
}

/**
 * Which slugs the environment carries a COMPLETE per-slug set of `names` for.
 *
 * This is how the bundle host learns that a tree needs a SECOND instance without
 * being handed strad's config: it never sees the server list, only the variables
 * the renderer baked.
 *
 * EVERY name must be present, not any one, and that is the whole filter. The
 * names are a tree's REQUIRED variables, so a partial set is not a server —
 * whereas "any one" would let a single unrelated variable conjure a mount. The
 * renderer names EVERY supplementary server's `env:`, and these names are
 * ordinary variables rather than reserved words, so a server that happens to
 * declare one of them (`TELEGRAM_API_ID` belongs to nobody) would otherwise stand
 * up a live, credentialed instance at a path nobody asked for.
 *
 * A prefix is also required to round-trip through {@link slugEnvPrefix}, which
 * rejects a head that is not a mangled slug at all — `FOO__BAR__X` does not
 * invent a slug called `foo--bar`.
 *
 * Returned sorted, so the mount order a boot log reports is stable.
 */
export function slugsWithPrefixedNames(
  env: Readonly<Record<string, string | undefined>>,
  names: readonly string[],
): string[] {
  if (names.length === 0) return [];
  const seen = new Map<string, Set<string>>();
  for (const key of Object.keys(env)) {
    for (const name of names) {
      const suffix = SLUG_ENV_SEPARATOR + name;
      if (!key.endsWith(suffix)) continue;
      const head = key.slice(0, key.length - suffix.length);
      if (head === "") continue;
      const slug = envPrefixSlug(head);
      if (slugEnvPrefix(slug) !== head) continue;
      (seen.get(slug) ?? seen.set(slug, new Set()).get(slug)!).add(name);
    }
  }
  return [...seen]
    .filter(([, held]) => held.size === names.length)
    .map(([slug]) => slug)
    .sort();
}

// ============================================================================
// COPIES: one value baked once, restored under every name that holds it.
// ============================================================================

/**
 * The variable that carries a component's copy list. GENERAL, not SECRET: it
 * holds variable NAMES, every one of which is already in the spec beside it.
 */
export const ENV_COPIES_VAR = "STRAD_ENV_COPIES";

/**
 * Serialize a copy list: `SOURCE=TARGET,TARGET;SOURCE=TARGET`.
 *
 * Not JSON, on purpose. This value sits inside a JSON app spec, where every `"`
 * costs two bytes, and the whole point of the variable is spec bytes. Variable
 * names are `[A-Za-z0-9_]`, so `=`, `,` and `;` cannot occur inside one.
 *
 * A target that is `<anything>__<SOURCE>` — which is what nearly every per-slug
 * name copied from its bare name is — is written as `<anything>__`, and the
 * reader appends the source back. That is unambiguous because a literal target
 * ending in `__` is refused: no per-slug name ends that way unless its variable
 * does, and the renderer does not fold one that does.
 *
 * Throws on a name that is not a portable variable name, or that would make the
 * line ambiguous: the renderer is the only writer, and a list it could not read
 * back is a bug to stop at render time rather than on the box.
 */
export function formatEnvCopies(
  copies: ReadonlyArray<readonly [source: string, targets: readonly string[]]>,
): string {
  const parts: string[] = [];
  for (const [source, targets] of copies) {
    if (targets.length === 0) continue;
    for (const name of [source, ...targets]) {
      if (
        !ENV_NAME.test(name) ||
        name === ENV_COPIES_VAR ||
        name.endsWith(SLUG_ENV_SEPARATOR)
      ) {
        throw new Error(
          `${ENV_COPIES_VAR}: "${name}" cannot be carried as a copy`,
        );
      }
    }
    const tail = SLUG_ENV_SEPARATOR + source;
    const written = targets.map((t) =>
      t.length > tail.length && t.endsWith(tail)
        ? t.slice(0, t.length - source.length)
        : t,
    );
    parts.push(`${source}=${written.join(",")}`);
  }
  return parts.join(";");
}

/** Read a copy list back. Throws on anything {@link formatEnvCopies} would not write. */
export function parseEnvCopies(text: string): Array<[string, string[]]> {
  if (text === "") return [];
  return text.split(";").map((part) => {
    const eq = part.indexOf("=");
    const source = eq === -1 ? "" : part.slice(0, eq);
    const targets = eq === -1 ? [] : part.slice(eq + 1).split(",");
    if (
      !ENV_NAME.test(source) ||
      targets.length === 0 ||
      !targets.every((t) => ENV_NAME.test(t))
    ) {
      throw new Error(
        `${ENV_COPIES_VAR} is malformed near "${part.slice(0, 80)}"`,
      );
    }
    return [
      source,
      targets.map((t) => (t.endsWith(SLUG_ENV_SEPARATOR) ? t + source : t)),
    ];
  });
}

/** What {@link applyEnvCopies} did, for the boot log. Names only. */
export interface EnvCopiesResult {
  /** Targets set from their source. */
  copied: number;
  /** Sources the list named and the environment did not hold — their targets stay unset. */
  missingSources: string[];
  /** Targets the environment already held, left as they were. */
  alreadySet: string[];
}

/**
 * Restore every name in `STRAD_ENV_COPIES` from its source, IN PLACE, and then
 * remove `STRAD_ENV_COPIES` itself, so the environment that results is the one
 * a render without copies would have produced, name for name and value for
 * value.
 *
 * It mutates rather than returning a view because the readers are everywhere:
 * `slugEnvView` snapshots, the per-slug instance discovery, a tree reading
 * `process.env` directly, and every child process the host spawns, which
 * inherits the environment as it stands. Run it once, before any of them.
 *
 * Never overwrites. A target the environment already holds was baked literally,
 * and the literal is what the render meant. A missing source leaves its targets
 * unset, which is the state the reader of that name already knows how to report
 * as a missing credential; it is returned so the caller can say so.
 */
export function applyEnvCopies(
  env: Record<string, string | undefined>,
): EnvCopiesResult {
  const result: EnvCopiesResult = {
    copied: 0,
    missingSources: [],
    alreadySet: [],
  };
  const text = env[ENV_COPIES_VAR];
  if (text === undefined) return result;
  const copies = parseEnvCopies(text);
  for (const [source, targets] of copies) {
    const value = env[source];
    if (value === undefined) {
      result.missingSources.push(source);
      continue;
    }
    for (const target of targets) {
      if (env[target] !== undefined) {
        result.alreadySet.push(target);
        continue;
      }
      env[target] = value;
      result.copied += 1;
    }
  }
  delete env[ENV_COPIES_VAR];
  return result;
}
