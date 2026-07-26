import type { StradConfig } from "../config/schema.ts";
import { collectSecretRefs } from "./appspec.ts";
import { refsIn } from "../secrets/provider/resolve.ts";
import { gatewayNamespace } from "../secrets/parameters/namespace.ts";
import { CORE_BOOT_ENV_KEYS } from "../secrets/provider/hydrate.ts";
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
 * Names a store-backed deploy must still resolve from the deploy environment,
 * because they land as env on a component the gateway process does not own.
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
 * Check that every required name exists in the gateway namespace.
 *
 * `optional` names are checked and reported but never counted as missing — the
 * gateway boot keys are individually optional (a deployment with no console has
 * no `GOOGLE_CLIENT_SECRET`), so demanding all of them would fail deploys that
 * are correct.
 */
export async function preflightSecrets(
  store: Pick<ParameterAdmin, "list">,
  config: StradConfig,
  opts: { optional?: readonly string[] } = {},
): Promise<PreflightResult> {
  const namespace = gatewayNamespace(config.gateway.env);
  const metas = await store.list(namespace);
  const held = new Set(metas.filter((m) => m.hasValue).map((m) => m.variable));

  const optional = new Set(opts.optional ?? CORE_BOOT_ENV_KEYS);
  const present: string[] = [];
  const missing: string[] = [];

  for (const name of requiredSecretNames(config)) {
    if (held.has(name)) present.push(name);
    else if (!optional.has(name)) missing.push(name);
  }

  return { missing, present, namespace };
}
