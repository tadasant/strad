/**
 * What the mcp-victorialogs child process is told, and what it is NOT told.
 *
 * THE ENVIRONMENT IS AN ALLOWLIST, NOT AN INHERITANCE — for the reason
 * servers/grafana/shared/src/config.ts gives at length: a child spawned with the
 * default environment would inherit every credential the bundle container
 * holds, and this one makes HTTP requests to an origin a deployment configures.
 * It gets the VictoriaLogs variables below and the process variables any Linux
 * binary needs, and nothing else.
 *
 * MCP_* IS NOT FORWARDED, apart from the transport this file pins. The binary
 * reads `MCP_SERVER_MODE`, `MCP_LISTEN_ADDR`, `MCP_DISABLED_TOOLS` and
 * `MCP_PASSTHROUGH_HEADERS` from its environment. A stray one on the container
 * would move the child off stdio (and the proxy would hang waiting for an
 * answer on a pipe nobody writes), or silently narrow a tool list the gateway's
 * `tools:` policy is meant to own.
 */

/** The VictoriaLogs origin the child talks to — or a proxy in front of one. */
export const VL_INSTANCE_ENTRYPOINT = "VL_INSTANCE_ENTRYPOINT";

/**
 * Optional: sent as `Authorization: Bearer`. A VictoriaLogs behind Grafana's
 * datasource proxy (`https://<grafana>/api/datasources/proxy/uid/<uid>`) takes a
 * Grafana service-account token here.
 */
export const VL_INSTANCE_BEARER_TOKEN = "VL_INSTANCE_BEARER_TOKEN";

/**
 * Optional: extra request headers, `Name=value,Name=value`. For a reverse proxy
 * that authenticates some other way. It can carry a credential, so it is a
 * value a deployment injects as a secret.
 */
export const VL_INSTANCE_HEADERS = "VL_INSTANCE_HEADERS";

/** Optional: `AccountID` or `AccountID:ProjectID`, for a multi-tenant VictoriaLogs. */
export const VL_DEFAULT_TENANT_ID = "VL_DEFAULT_TENANT_ID";

/**
 * The variables that MAKE an instance of this server.
 *
 * Only the entrypoint. A VictoriaLogs on a private network commonly takes no
 * credential at all, so requiring a token would refuse a working deployment —
 * and the bundle host's per-slug discovery mounts an instance for every slug
 * the container carries ALL of these for.
 */
export const VICTORIALOGS_ENV_NAMES = [VL_INSTANCE_ENTRYPOINT] as const;

/**
 * The variables that are a CREDENTIAL for one entrypoint, and so are never
 * inherited by a per-slug instance from a sibling's bare name: sent to this
 * slug's entrypoint, a sibling's token is a credential handed to a host it was
 * not minted for. The bundle host drops them from a per-slug view unless the
 * slug carries them under its own name.
 */
export const VICTORIALOGS_CREDENTIAL_ENV_NAMES = [
  VL_INSTANCE_BEARER_TOKEN,
  VL_INSTANCE_HEADERS,
] as const;

/**
 * Where an UNCONFIGURED child is pointed.
 *
 * The binary refuses to start without an entrypoint, and a mount with no
 * credential still has to list its tools (the console shows the slug, and an
 * agent sees what it would offer). `.invalid` is reserved by RFC 2606 and never
 * resolves, so nothing can answer it — and the proxy refuses every call on such
 * a mount before it reaches the child anyway.
 */
export const UNCONFIGURED_ENTRYPOINT = "http://unconfigured.invalid";

/** Process variables a Go binary needs to run and to trust a TLS certificate. */
const PROCESS_ENV_NAMES = [
  "PATH",
  "HOME",
  "TMPDIR",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
] as const;

/** VictoriaLogs variables passed through to the child, when set. */
const PASSTHROUGH = [
  VL_INSTANCE_ENTRYPOINT,
  VL_INSTANCE_BEARER_TOKEN,
  VL_INSTANCE_HEADERS,
  VL_DEFAULT_TENANT_ID,
] as const;

export type Env = Readonly<Record<string, string | undefined>>;

/**
 * Which of this server's required variables are absent. Empty means
 * "configured", not "working": VictoriaLogs answers that on the first call.
 */
export function missingCredentials(env: Env): string[] {
  return VICTORIALOGS_ENV_NAMES.filter((name) => !env[name]);
}

/**
 * The child's whole environment: the allowlist above, resolved against ONE
 * slug's view of the container.
 *
 * An empty value is dropped rather than passed as `""`: an empty bearer token
 * would be sent as `Authorization: Bearer `, a 401 that reads like a rejected
 * credential rather than a missing one.
 */
export function upstreamEnv(env: Env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of [...PROCESS_ENV_NAMES, ...PASSTHROUGH]) {
    const value = env[name];
    if (value) out[name] = value;
  }
  if (!out[VL_INSTANCE_ENTRYPOINT]) {
    out[VL_INSTANCE_ENTRYPOINT] = UNCONFIGURED_ENTRYPOINT;
  }
  // Pinned, not inherited: the proxy speaks stdio and nothing else.
  out.MCP_SERVER_MODE = "stdio";
  return out;
}
