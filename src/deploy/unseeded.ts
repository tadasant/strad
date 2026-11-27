import {
  isUnhosted,
  unhostedRefFields,
  type StradConfig,
} from "../config/schema.ts";
import { CORE_BOOT_ENV_KEYS } from "../secrets/provider/hydrate.ts";
import { refsIn } from "../secrets/provider/resolve.ts";

/**
 * Names no waiver may ever cover, whatever a config writes.
 *
 * The gateway process reads these for itself at boot, out of the shared
 * provider. Ordinarily no server references one, so they have no referencing
 * slug and the unanimity rule alone keeps them unwaivable — but that is an
 * accident of how configs are written, not a guarantee. A builtin whose
 * `options:` mentions `${STRAD_TOKENS}` gives the key a referencing slug, and
 * without this the slug could then waive it: a green render, a clean boot log,
 * and `/mcp` rejecting every request in the fleet. Deferring the credential that
 * makes the front door work is not a thing to allow by accident.
 */
const NEVER_WAIVABLE: ReadonlySet<string> = new Set<string>(CORE_BOOT_ENV_KEYS);

/**
 * Which `${NAME}`s a deploy is allowed to ship without.
 *
 * ## The trade this module is holding open
 *
 * The deploy-time preflight (src/deploy/preflight.ts) exists to catch a typo'd
 * secret name at the deploy instead of at 3am on one request, and deleting it
 * would trade a loud early failure for a silent late one. But it also made
 * ADDING a server a two-step human ritual: seed the credential, then merge the
 * PR — because a `${NAME}` nobody had seeded yet failed the render for the whole
 * fleet, not for the one slug that referenced it.
 *
 * Both properties are wanted, so the waiver is explicit and per NAME. A name a
 * human listed in that server's `mayBeUnseeded:` degrades; every other name
 * keeps today's hard failure. Nothing here loosens the default.
 *
 * ## Two rules, and they are the whole design
 *
 * **A waiver only counts where it is unanimous.** A name is waived only if every
 * enabled server that references it waives it. `GRANOLA_TOKEN` deferred by a new
 * slug and required by an existing one is not deferred — the existing slug would
 * come up dead, which is the fleet-wide failure this feature is removing, spelt
 * differently.
 *
 * **A waiver for a name nothing references is a typo, and fails.** This is what
 * keeps `mayBeUnseeded:` from becoming the silence it replaces: writing
 * `mayBeUnseeded: [APIFY_TOKEN]` beside a header that says `${APIFY_TOKN}` waives
 * a name the config never asks for, so the reference is still unwaived and still
 * reds the deploy — and the unused entry is named as the mistake it is. Same
 * shape as the `tools: allow` gate (scripts/check-tool-policy.ts): an entry that
 * matches nothing is a narrowing nobody wrote on purpose.
 *
 * ## What it deliberately does not know about
 *
 * Boot keys. `CORE_BOOT_ENV_KEYS` are read by the gateway process for itself.
 * Ordinarily no server references one, so the unanimity rule alone would keep
 * them unwaivable — but that is how configs happen to be written rather than a
 * guarantee, so `NEVER_WAIVABLE` enforces it, and a config that tries is a hard
 * error rather than a line that quietly does nothing. Their own optionality
 * (preflight's `OPTIONAL_BOOT_ENV_KEYS`) is a different question.
 */

/**
 * `${NAME}` -> the enabled slugs that reference it, from NAMED FIELDS.
 *
 * Named fields rather than a walk of the whole server object, for the reason
 * `runtimeRefsBySlug` gives: a `${...}`-shaped string in a `description` is not a
 * reference, and letting one count would let a waiver attach to a slug that
 * resolves nothing.
 *
 * Every delivery is here, because a waiver has to be unanimous across all of
 * them: a `url:`/`headers:`/`options:` ref resolved on the request path, a
 * supplementary image's `env:` baked onto its bundle, and a `consoleEnv:` key
 * that lands on core.
 */
export function referencingSlugs(
  config: StradConfig,
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const [slug, refs] of referencesBySlug(config)) {
    for (const name of refs) {
      const slugs = out.get(name) ?? new Set<string>();
      slugs.add(slug);
      out.set(name, slugs);
    }
  }
  return out;
}

/** `slug -> every `${NAME}` that server references, across every delivery. */
export function referencesBySlug(
  config: StradConfig,
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const server of config.servers) {
    if (!server.enabled) continue;
    const refs = new Set<string>();
    const add = (raw: string): void => {
      for (const name of refsIn(raw)) refs.add(name);
    };
    if (isUnhosted(server)) {
      for (const value of unhostedRefFields(server)) add(value);
    } else if (server.kind === "builtin") {
      for (const value of Object.values(server.options)) {
        if (typeof value === "string") add(value);
      }
    } else {
      for (const value of Object.values(server.headers)) add(value);
      for (const value of Object.values(server.confirmationHeaders)) add(value);
      for (const value of Object.values(server.env)) add(value);
      for (const value of Object.values(server.consoleEnv)) add(value);
    }
    out.set(server.slug, refs);
  }
  return out;
}

/**
 * The names this config says may be absent, and the slugs that said so.
 *
 * Unanimity is enforced here rather than at each caller, so the deploy gate, the
 * gateway and the console cannot disagree about whether one name is waived.
 */
export function waivedNames(config: StradConfig): Map<string, string[]> {
  const referencing = referencingSlugs(config);
  const waivers = new Map<string, Set<string>>();
  for (const server of config.servers) {
    if (!server.enabled) continue;
    waivers.set(server.slug, new Set(server.mayBeUnseeded));
  }

  const out = new Map<string, string[]>();
  for (const [name, slugs] of referencing) {
    if (NEVER_WAIVABLE.has(name)) continue;
    const all = [...slugs].sort();
    if (all.every((slug) => waivers.get(slug)?.has(name))) out.set(name, all);
  }
  return out;
}

/**
 * `slug -> the ${NAME}s that server waives`, for every enabled server, in one pass.
 *
 * The batch form of `waivedBy`. Both the registry and the console ask this per
 * server over the whole config, and `waivedBy` recomputes the reference map each
 * time — cheap at 39 servers and quadratic in principle, which is not a shape to
 * leave on a page render.
 */
export function waiversBySlug(config: StradConfig): Map<string, Set<string>> {
  const references = referencesBySlug(config);
  const out = new Map<string, Set<string>>();
  for (const server of config.servers) {
    if (!server.enabled) {
      out.set(server.slug, new Set());
      continue;
    }
    const referenced = references.get(server.slug) ?? new Set<string>();
    out.set(
      server.slug,
      new Set(server.mayBeUnseeded.filter((name) => referenced.has(name))),
    );
  }
  return out;
}

/**
 * The `${NAME}`s ONE server waives, restricted to the ones it references.
 *
 * What the gateway wants: whether THIS slug's unresolvable name is a deferral it
 * declared or a fault. Unanimity is irrelevant to that question — a name another
 * server also needs still leaves this slug unconfigured, and this slug still
 * declared it. The deploy gate is the half that cares about the other server.
 */
export function waivedBy(config: StradConfig, slug: string): Set<string> {
  return waiversBySlug(config).get(slug) ?? new Set();
}

/**
 * Waivers that waive nothing — the typo gate.
 *
 * Returns human-readable messages, or an empty array. A DEPLOY-TIME check
 * (scripts/check-config.ts and scripts/render-spec.ts), never a schema rule: the
 * boot parse stays lenient on purpose so a rollback cannot become an outage, and
 * "did I typo a key" is answered at the gate. Same split as src/config/strict.ts.
 */
export function unusedWaivers(config: StradConfig): string[] {
  const references = referencesBySlug(config);
  const problems: string[] = [];
  for (const server of config.servers) {
    // A DISABLED server is not checked, and that is not an oversight. It
    // references nothing, so every waiver on it matches nothing — and turning
    // that into a fatal error would red a deploy for the ordinary act of
    // switching a server off with its waiver left in place. A typo parked behind
    // `enabled: false` costs nothing while it is off, and fails loudly the moment
    // it is switched on, which is exactly when it starts to matter.
    if (!server.enabled) continue;
    const referenced = references.get(server.slug) ?? new Set<string>();
    for (const name of server.mayBeUnseeded) {
      // A BOOT KEY IS NOT DEFERRABLE, and saying so beats silently ignoring it.
      // `waivedNames` drops it either way, so the config would deploy — with an
      // entry its author believed was doing something. That is the shape this
      // whole gate exists to refuse.
      if (NEVER_WAIVABLE.has(name)) {
        problems.push(
          `server "${server.slug}" declares mayBeUnseeded: ${name}, which is a ` +
            `gateway BOOT key — the process reads it for itself at boot, and a ` +
            `deployment without it comes up rejecting every request. It cannot ` +
            `be deferred. Seed it, or remove the entry.`,
        );
        continue;
      }
      if (referenced.has(name)) continue;
      problems.push(
        `server "${server.slug}" declares mayBeUnseeded: ${name} but ` +
          `references no \${${name}} — check the spelling against this ` +
          `server's url/headers/options/env. A waiver that matches nothing ` +
          `waives nothing, and the reference it was meant for still fails the ` +
          `deploy.`,
      );
    }
  }
  return problems;
}
