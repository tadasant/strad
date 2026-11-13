import type { StradConfig } from "../config/schema.ts";
import { collectSecretRefs } from "./appspec.ts";
import { refsIn } from "../secrets/provider/resolve.ts";
import { gatewayNamespace } from "../secrets/parameters/namespace.ts";
import {
  mcpNamespace,
  ownNamespaceRefsBySlug,
  seededByServer,
} from "./server-namespaces.ts";
import {
  CORE_BOOT_ENV_KEYS,
  REQUIRED_BOOT_ENV_KEYS,
} from "../secrets/provider/hydrate.ts";
import { waivedNames } from "./unseeded.ts";
import type { ParameterAdmin } from "../secrets/parameters/types.ts";

/**
 * The deploy-time preflight for a store-backed deployment.
 *
 * ## Why this exists
 *
 * Baking every `${NAME}` into the app spec had one genuinely good property: a
 * reference to a secret that did not exist failed the DEPLOY, loudly, before
 * anything shipped. Moving resolution to runtime trades that for a failure that
 * shows up later, on one request, to one server — which is a worse place to
 * find out.
 *
 * So the check is kept and the read is dropped. Preflight asks the store which
 * names EXIST and compares that with what the config references. It never asks
 * for a value.
 *
 * ## It reads metadata, not secrets
 *
 * `list()` returns `ParameterMeta` — path, variable, secret flag, note, whether
 * a value is set. For a secret parameter the underlying payload is a `__REF__`
 * pointer at Secret Manager, not the secret; nothing here calls `:render` or
 * `reveal`. A credential with no `secretmanager.versions.access` passes this
 * check happily, which is the proof that it is metadata-only.
 */

export interface PreflightResult {
  /** Names the config references that no namespace holds. */
  missing: string[];
  /** Names the config references that the gateway namespace holds. */
  present: string[];
  /**
   * Names the gateway namespace does NOT hold and does not have to, because
   * every server that references them holds them in its own
   * `/strad/{env}/mcp/{slug}/static/` namespace.
   *
   * Neither present nor missing. The gateway namespace is the FALLBACK for a
   * server's `${NAME}` (see src/secrets/provider), so failing the deploy for
   * one of these would refuse a deployment that resolves every name it needs —
   * which is exactly what a credential moved into its owner's namespace looks
   * like. Named rather than silently dropped: "seeded somewhere else" and
   * "seeded" are different facts about a store.
   */
  perServer: string[];
  /**
   * For each MISSING name, the enabled servers that reference it and do not hold
   * it themselves — the slugs that would fall through to a gateway namespace
   * that does not have it either.
   *
   * A partially-seeded name is the likely failure once the second layer is in
   * use, and "missing from the gateway namespace" is unhelpful advice for it:
   * the fix is usually to seed the one slug that was skipped, not to put the
   * value back in the shared namespace. Empty for a name no server references
   * (a boot key).
   */
  unservedSlugs: Record<string, string[]>;
  /**
   * Names no namespace holds that are NOT missing, because every enabled server
   * referencing them declared `mayBeUnseeded:` for them.
   *
   * The deliberately-deferred credential. Reported, never fatal: the servers
   * that named it deploy `unconfigured` and the rest of the fleet deploys
   * normally. See src/deploy/unseeded.ts for why the waiver is per name and why
   * it has to be unanimous.
   */
  waived: string[];
  /** For each waived name, the slugs that waived it. */
  waivedSlugs: Record<string, string[]>;
  /** The namespace consulted. */
  namespace: string;
}

/**
 * Every secret name a store-backed deployment must be able to resolve.
 *
 * Two sources:
 *   - `collectSecretRefs` — `${NAME}` in a remote-http url/headers or a builtin's
 *     options; resolved on the request path by the runtime provider.
 *   - the core boot keys — read from the environment once at boot, supplied by
 *     hydration (see secrets/provider/hydrate.ts).
 *
 * A supplementary image's own `env:` is NOT here. Those are container env vars
 * on a component strad does not run, so they are resolved at render time and
 * baked; `renderAppSpec` already fails closed on a missing one.
 */
export function requiredSecretNames(config: StradConfig): string[] {
  const names = new Set<string>(collectSecretRefs(config));
  for (const key of CORE_BOOT_ENV_KEYS) names.add(key);
  return [...names].sort();
}

/**
 * The `${NAME}` behind each rendered bundle's `tailnet.authKey`.
 *
 * Baked like a supplementary server's `env:` — onto that one component, read
 * from the store under the store provider — and so counted with them: in
 * `bakedSecretNames` (what `render-spec` fetches) and `supplementaryEnvNames`
 * (what `store:check` demands). A bundle no enabled server uses renders no
 * component and asks for nothing; neither does `enabled: false`, which is what
 * makes that the rollback.
 */
export function tailnetSecretNames(config: StradConfig): string[] {
  const used = new Set(
    config.servers
      .filter((s) => s.enabled && s.kind === "supplementary-image")
      .map((s) => (s as { bundle: string }).bundle),
  );
  const names = new Set<string>();
  for (const bundle of config.bundles) {
    if (!bundle.tailnet?.enabled || !used.has(bundle.name)) continue;
    for (const name of refsIn(bundle.tailnet.authKey)) names.add(name);
  }
  return [...names].sort();
}

/**
 * Names a store-backed deploy must still resolve at render time, because they
 * land as env on a component the gateway process does not own.
 */
export function bakedSecretNames(config: StradConfig): string[] {
  const names = new Set<string>(tailnetSecretNames(config));
  for (const server of config.servers) {
    if (!server.enabled) continue;
    if (server.kind !== "supplementary-image") continue;
    for (const raw of [
      ...Object.values(server.env),
      ...Object.values(server.consoleEnv),
    ]) {
      for (const name of refsIn(raw)) names.add(name);
    }
  }
  return [...names].sort();
}

/**
 * Names referenced by a supplementary image's own `env:` map, and nothing else.
 *
 * `bakedSecretNames()` is `env:` plus `consoleEnv:`, because both are resolved at
 * render time. They are not interchangeable: an `env:` name is read FROM THE
 * STORE under the store provider, a `consoleEnv:` name never is. Anything asking
 * "what must the store hold" needs the two apart, and needs this one to win when
 * a name appears in both — `render-spec` still has to find it in the store for
 * the server that declared it under `env:`.
 */
export function supplementaryEnvNames(config: StradConfig): string[] {
  const names = new Set<string>(tailnetSecretNames(config));
  for (const server of config.servers) {
    if (!server.enabled) continue;
    if (server.kind !== "supplementary-image") continue;
    for (const raw of Object.values(server.env)) {
      for (const name of refsIn(raw)) names.add(name);
    }
  }
  return [...names].sort();
}

/**
 * Names referenced by a `consoleEnv:` map.
 *
 * These are read from the deploy ENVIRONMENT ONLY, never from the store, and the
 * renderer enforces that. `consoleEnv:` exists to carry the console's store-ADMIN
 * credential — the one that can write and reveal — to the core component alone.
 * Filing it inside the store would let the weaker RESOLVER credential read the
 * stronger admin one, which would make the three-role split decorative. Keeping
 * the list here means the rule is enforced by code rather than asserted in prose.
 */
export function consoleEnvNames(config: StradConfig): string[] {
  const names = new Set<string>();
  for (const server of config.servers) {
    if (!server.enabled) continue;
    if (server.kind !== "supplementary-image") continue;
    for (const raw of Object.values(server.consoleEnv)) {
      for (const name of refsIn(raw)) names.add(name);
    }
  }
  return [...names].sort();
}

/**
 * Ways a `consoleEnv:` declaration fails to become a value the console can read.
 *
 * The console is the half of a supplementary server that runs in CORE, and it
 * reads its credential from core's environment under the declared KEY. Two things
 * can quietly break that, and both have a rendered spec to check against:
 *
 *   - the key never lands on core, so the page reports a credential missing that
 *     the config plainly declares;
 *   - two servers declare the SAME key with different values. `consoleEnvVars()`
 *     merges every enabled server's map into one flat environment, so the last
 *     one wins and the other server's console silently runs as the wrong
 *     identity. Nothing downstream can tell that happened.
 *
 * Returns human-readable messages, most specific first, or an empty array.
 */
export function consoleScopeProblems(
  config: StradConfig,
  spec: { services: { name: string; envs: { key: string }[] }[] },
): string[] {
  const problems: string[] = [];
  const core = spec.services.find((s) => s.name === "core");
  const onCore = new Set(core?.envs.map((e) => e.key) ?? []);

  /** key -> the first slug/value that declared it, to catch a later conflict. */
  const claimed = new Map<string, { slug: string; value: string }>();

  for (const server of config.servers) {
    if (!server.enabled) continue;
    if (server.kind !== "supplementary-image") continue;
    for (const [key, value] of Object.entries(server.consoleEnv)) {
      if (!onCore.has(key)) {
        problems.push(
          `server "${server.slug}" declares ${key} under consoleEnv: but it ` +
            `does not land on the core component — the console cannot read it`,
        );
      }
      const first = claimed.get(key);
      if (first && first.value !== value) {
        problems.push(
          `servers "${first.slug}" and "${server.slug}" both declare ${key} ` +
            `under consoleEnv: with different values — core holds one flat ` +
            `environment, so one silently overwrites the other`,
        );
      }
      if (!first) claimed.set(key, { slug: server.slug, value });
    }
  }
  return problems;
}

/**
 * Boot keys that may legitimately be absent.
 *
 * Everything in `CORE_BOOT_ENV_KEYS` except the two the deployment cannot work
 * without. A `${NAME}` the CONFIG references is never optional — it is only these
 * platform keys, which are read from the environment rather than named in the
 * config, that get this treatment.
 */
const OPTIONAL_BOOT_ENV_KEYS = CORE_BOOT_ENV_KEYS.filter(
  (k) => !(REQUIRED_BOOT_ENV_KEYS as readonly string[]).includes(k),
);

/**
 * Check that every required name is resolvable — from the gateway namespace, or
 * from the namespace of every server that references it.
 *
 * `optional` names are checked and reported but never counted as missing — a
 * deployment with no console has no `GOOGLE_CLIENT_SECRET`, and demanding one
 * would fail deploys that are correct. `STRAD_TOKENS` and `STRAD_INTERNAL_TOKEN`
 * are deliberately NOT optional: the `env` renderer marks them `required`, and a
 * store-backed deploy that shipped without them would come up with `/mcp`
 * rejecting everything, or unable to reach its own bundles.
 *
 * ## The second layer, and why it is not optional to check
 *
 * A server's `${NAME}` resolves from its OWN namespace first (src/secrets/provider
 * for the runtime refs, src/deploy/server-namespaces.ts for a supplementary
 * `env:`). This gate is the one that turns an unresolvable name into a failed
 * deploy rather than a failed request, so it has to know about both layers in
 * both directions:
 *
 *   - a name held ONLY per-server must not fail the deploy. Filing a server's
 *     own credential in its own namespace is the recommended shape, and a gate
 *     that reds the deploy for it would make the feature unusable.
 *   - a name held per-server for SOME of its referencing servers and nowhere
 *     else is still missing, for the ones that would fall through. Coverage is
 *     all-or-nothing per name.
 *
 * A boot key is never covered that way. `CORE_BOOT_ENV_KEYS` is read by the
 * gateway process for itself, out of the shared provider, with no server to
 * attribute it to.
 *
 * The second listing costs one extra `list()`, which `list()` serves by
 * enumerating the project. The guard skips it only for a config whose servers
 * reference no `${NAME}` at all — rare once runtime refs count, so treat this as
 * one more enumeration per render rather than as an optimisation.
 */
export async function preflightSecrets(
  store: Pick<ParameterAdmin, "list">,
  config: StradConfig,
  opts: { optional?: readonly string[] } = {},
): Promise<PreflightResult> {
  const namespace = gatewayNamespace(config.gateway.env);
  const metas = await store.list(namespace);
  const held = new Set(metas.filter((m) => m.hasValue).map((m) => m.variable));

  const refsBySlug = ownNamespaceRefsBySlug(config);
  const seeded =
    refsBySlug.size > 0
      ? seededByServer(
          config.gateway.env,
          await store.list(mcpNamespace(config.gateway.env)),
        )
      : new Map<string, string[]>();
  const bootKeys = new Set<string>(CORE_BOOT_ENV_KEYS);

  /** Does EVERY server that references this name hold it for itself? */
  const coveredPerServer = (name: string): boolean => {
    if (bootKeys.has(name)) return false;
    const slugs = [...refsBySlug].filter(([, refs]) => refs.has(name));
    return (
      slugs.length > 0 &&
      slugs.every(([slug]) => (seeded.get(slug) ?? []).includes(name))
    );
  };

  const optional = new Set(opts.optional ?? OPTIONAL_BOOT_ENV_KEYS);
  const waivers = waivedNames(config);
  const present: string[] = [];
  const perServer: string[] = [];
  const missing: string[] = [];
  const waived: string[] = [];
  const waivedSlugs: Record<string, string[]> = {};
  const unservedSlugs: Record<string, string[]> = {};

  for (const name of requiredSecretNames(config)) {
    if (held.has(name)) present.push(name);
    else if (coveredPerServer(name)) perServer.push(name);
    else if (waivers.has(name)) {
      // Absent, and every server that references it said it might be. Kept out
      // of `missing` and named separately: "seeded somewhere else", "deliberately
      // not seeded yet" and "nobody seeded this" are three different facts about
      // a store, and collapsing the middle one into either of the others is what
      // makes a deploy log unreadable.
      waived.push(name);
      waivedSlugs[name] = waivers.get(name)!;
    } else if (!optional.has(name)) {
      missing.push(name);
      const short = [...refsBySlug]
        .filter(
          ([slug, refs]) =>
            refs.has(name) && !(seeded.get(slug) ?? []).includes(name),
        )
        .map(([slug]) => slug)
        .sort();
      if (short.length > 0) unservedSlugs[name] = short;
    }
  }

  return {
    missing,
    present,
    perServer,
    waived,
    waivedSlugs,
    unservedSlugs,
    namespace,
  };
}
