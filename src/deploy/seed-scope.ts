/**
 * Narrowing a seeding run to a subset of the names a config would seed.
 *
 * ## Why a seeder needs this at all
 *
 * `scripts/seed-store.ts` derives its name list from the config and seeds it as
 * a unit, so "seed these names but not that one" has no spelling. That is a gap
 * with a specific, expensive shape, because the READ side is all-or-nothing:
 * `resolve()` renders a namespace as a unit and throws as a unit
 * (`HACKS.md` #36), so ONE parameter that cannot render leaves the gateway with
 * no token store, no internal token and `/mcp` rejecting every request.
 *
 * Without a scope, an operator who suspects one name is a problem has only two
 * moves: seed everything and find out, or seed everything and then `--delete`
 * the offender back out of a namespace it should never have entered. A scope
 * makes the first move avoidable rather than recoverable.
 *
 * ## The rules, and why they are not symmetric
 *
 * `only` and `exclude` are mutually exclusive: `only` states the set
 * exhaustively, so an `exclude` beside it is either a contradiction or a no-op.
 *
 * An unmatched name is a hard error under `only` and a note under `exclude`, and
 * the test is whether silence still serves what the caller asked for:
 *
 *   - `only: ["NOPE"]` — the caller named something to seed, and it would not be
 *     seeded. Reporting "seeded" over that is the failure a dry-run-by-default
 *     seeder exists to refuse.
 *   - `exclude: ["NOPE"]` — the caller asked for a name NOT to be seeded, and it
 *     is not going to be. The intent already holds, so this reports and
 *     continues, the way a delete of an absent name does.
 *
 * A name the caller introduced with `--set` and then scoped away is a hard error
 * under either flag, for the first reason: it was typed on the command line.
 *
 * This module decides membership only. It never reads a value, never touches the
 * store, and takes no position on `--delete`, which is explicit by construction
 * and so has nothing for a scope to narrow.
 */

export interface SeedScopeInput {
  /** Every name the config would seed, `consoleEnv:` names already removed. */
  candidates: readonly string[];
  /** `--only` names, in command-line order. */
  only?: readonly string[];
  /** `--exclude` names, in command-line order. */
  exclude?: readonly string[];
  /** `--set` names, which the caller introduced explicitly. */
  overrides?: readonly string[];
  /**
   * `consoleEnv:` names. Not seedable by any run, and named apart from the
   * general "not a name this config seeds" case so the error can say why.
   */
  consoleOnly?: readonly string[];
}

export interface SeedScope {
  /** The names to seed, in `candidates` order. */
  wanted: string[];
  /** Candidates a scope held back. Empty when the run is not scoped. */
  outOfScope: string[];
  /** Which flag narrowed the run, or `null` when nothing did. */
  scopedBy: "--only" | "--exclude" | null;
  /** Lines worth printing that are not errors — an unmatched `exclude`. */
  notes: string[];
}

/** A refusal, phrased for `usage()`. */
export class SeedScopeError extends Error {}

export function resolveSeedScope(input: SeedScopeInput): SeedScope {
  const candidates = [...input.candidates];
  const only = [...new Set(input.only ?? [])];
  const exclude = [...new Set(input.exclude ?? [])];
  const consoleOnly = new Set(input.consoleOnly ?? []);
  const notes: string[] = [];

  if (only.length > 0 && exclude.length > 0)
    throw new SeedScopeError(
      "--only and --exclude are mutually exclusive: --only already states the " +
        "set, so an --exclude beside it is a contradiction or a no-op.",
    );

  const known = new Set(candidates);

  for (const name of only) {
    if (known.has(name)) continue;
    throw new SeedScopeError(
      consoleOnly.has(name)
        ? `--only ${name}: that is a consoleEnv: name, read from the deploy ` +
            `environment only — the store must never hold it, so no run can seed it.`
        : `--only ${name}: this config does not seed that name. It is not a ` +
            `\${NAME} the config references, not a core boot key, and no --set ` +
            `introduces it.`,
    );
  }

  for (const name of exclude) {
    if (!known.has(name))
      notes.push(`not a name this config seeds, nothing to exclude: ${name}`);
  }

  const onlySet = new Set(only);
  const excludeSet = new Set(exclude);
  const wanted = candidates.filter((name) =>
    only.length > 0 ? onlySet.has(name) : !excludeSet.has(name),
  );

  const kept = new Set(wanted);
  const outOfScope = candidates.filter((name) => !kept.has(name));

  for (const name of input.overrides ?? []) {
    if (kept.has(name)) continue;
    throw new SeedScopeError(
      only.length > 0
        ? `--set ${name} is excluded by the scope: --only does not list it. ` +
            `Add --only ${name}, or drop the --set.`
        : `--set ${name} is excluded by the scope: --exclude names it. Drop ` +
            `one of the two.`,
    );
  }

  return {
    wanted,
    outOfScope,
    scopedBy:
      outOfScope.length === 0 ? null : only.length > 0 ? "--only" : "--exclude",
    notes,
  };
}
