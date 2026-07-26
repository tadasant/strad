import { createGcpParameterStore } from "./gcp.ts";
import { parseServiceAccount } from "./service-account.ts";
import { staticNamespace } from "./namespace.ts";
import type { ParameterResolver, ParameterStore } from "./types.ts";

/**
 * The runtime resolver: turn a server's managed parameters into the environment
 * variables its process runs with.
 *
 * When strad launches a baked server, it resolves everything under
 * `/strad/{env}/mcp/{slug}/static/*` — non-secret values from Parameter Manager,
 * secret values from Secret Manager (via `:render`) — into a `VARIABLE -> value`
 * map, and injects that map as the child's environment. The values are handed to
 * the child PROCESS only; they are NEVER returned over strad's own MCP channel.
 * That is what keeps the resolver's read-secret-values power from violating the
 * "no value crosses the agent channel" property: it is server→child injection,
 * not a tool result.
 *
 * The resolver credential is a THIRD role, distinct from the MCP viewer (which
 * cannot read secret values) and the console admin (which can read AND write).
 * This one reads both stores' values and writes neither.
 */

/** Resolve one server's static parameters into a `VARIABLE -> value` map. */
export async function resolveServerParams(
  resolver: ParameterResolver,
  gatewayEnv: string,
  slug: string,
): Promise<Record<string, string>> {
  return resolver.resolve(staticNamespace(gatewayEnv, slug));
}

export const RESOLVER_ENV = {
  projectId: "STRAD_PARAMS_PROJECT_ID",
  location: "STRAD_PARAMS_LOCATION",
  keyJson: "STRAD_PARAMS_RESOLVER_SERVICE_ACCOUNT_KEY_JSON",
  pmApiBase: "STRAD_PARAMS_PM_API_BASE",
  smApiBase: "STRAD_PARAMS_SM_API_BASE",
  tokenUrl: "STRAD_PARAMS_TOKEN_URL",
} as const;

/**
 * Build a store client from the environment, or return null when it is not
 * configured. Null is not an error: a deployment that seeds a server's env the
 * old way (deploy-time `${REF}` secrets) simply does not set these, and the
 * caller falls back to whatever it had. This is what lets the resolver be wired
 * in ahead of the resolver service account existing.
 *
 * The return type is the FULL `ParameterStore`, not just `ParameterResolver`,
 * because two callers need more than `resolve()`: the runtime provider needs the
 * resolver half, and the deploy-time preflight needs `list()` — which reads
 * metadata and, for a secret parameter, an envelope holding a `__REF__` pointer
 * rather than a value. Widening the type does not widen the CREDENTIAL: what the
 * service account may do is still decided by IAM, and the resolver role has no
 * write permission whatever this interface offers.
 */
export function resolverFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ParameterStore | null {
  const projectId = env[RESOLVER_ENV.projectId];
  const keyJson = env[RESOLVER_ENV.keyJson];
  if (!projectId || !keyJson) return null;

  const { account } = parseServiceAccount(keyJson);
  if (!account) return null;

  return createGcpParameterStore({
    projectId,
    location: env[RESOLVER_ENV.location],
    account,
    pmApiBase: env[RESOLVER_ENV.pmApiBase],
    smApiBase: env[RESOLVER_ENV.smApiBase],
    tokenUrl: env[RESOLVER_ENV.tokenUrl],
  });
}
