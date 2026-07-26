import type { StradConfig } from "../config/schema.ts";
import { collectSecretRefs } from "./appspec.ts";
import { refsIn } from "../secrets/provider/resolve.ts";
import { gatewayNamespace } from "../secrets/parameters/namespace.ts";
import {
  CORE_BOOT_ENV_KEYS,
  REQUIRED_BOOT_ENV_KEYS,
} from "../secrets/provider/hydrate.ts";
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
  /** Names the config references that the store does not hold. */
  missing: string[];
  /** Names the config references that the store does hold. */
  present: string[];
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
 * Names a store-backed deploy must still resolve at render time, because they
 * land as env on a component the gateway process does not own.
 */
export function bakedSecretNames(config: StradConfig): string[] {
  const names = new Set<string>();
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
 * Check that every required name exists in the gateway namespace.
 *
 * `optional` names are checked and reported but never counted as missing — a
 * deployment with no console has no `GOOGLE_CLIENT_SECRET`, and demanding one
 * would fail deploys that are correct. `STRAD_TOKENS` and `STRAD_INTERNAL_TOKEN`
 * are deliberately NOT optional: the `env` renderer marks them `required`, and a
 * store-backed deploy that shipped without them would come up with `/mcp`
 * rejecting everything, or unable to reach its own bundles.
 */
export async function preflightSecrets(
  store: Pick<ParameterAdmin, "list">,
  config: StradConfig,
  opts: { optional?: readonly string[] } = {},
): Promise<PreflightResult> {
  const namespace = gatewayNamespace(config.gateway.env);
  const metas = await store.list(namespace);
  const held = new Set(metas.filter((m) => m.hasValue).map((m) => m.variable));

  const optional = new Set(opts.optional ?? OPTIONAL_BOOT_ENV_KEYS);
  const present: string[] = [];
  const missing: string[] = [];

  for (const name of requiredSecretNames(config)) {
    if (held.has(name)) present.push(name);
    else if (!optional.has(name)) missing.push(name);
  }

  return { missing, present, namespace };
}
