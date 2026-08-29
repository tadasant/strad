/**
 * What the mcp-grafana child process is told, and — more to the point — what it
 * is NOT told.
 *
 * THE ENVIRONMENT IS AN ALLOWLIST, NOT AN INHERITANCE. Every other mount in the
 * bundle is Node code running inside the host process, so "what can it read" is
 * a question about imports. This one is a separate executable, and a child
 * process spawned with the default environment inherits the WHOLE bundle
 * container's: a Slack bot token, a 1Password service-account token, a GCP
 * service-account key, six Google OAuth refresh tokens. mcp-grafana needs none
 * of them and has a `grafana_api_request` tool that talks to a host somebody
 * else configures, so the blast radius of handing it the container's credentials
 * is not hypothetical. It gets three Grafana variables and the four process
 * variables any Linux binary needs, and nothing else reaches it.
 *
 * OTEL_* IS DELIBERATELY NOT FORWARDED. mcp-grafana can export its own traces
 * and logs, and those records are authored by it rather than by strad — they
 * would arrive on strad's collector outside the allowlist in
 * src/telemetry/events.ts, which is deny-by-default for exactly this reason. The
 * host's telemetry already reports this mount the way it reports every other.
 */

/** The Grafana origin the child talks to. */
export const GRAFANA_URL = "GRAFANA_URL";

/**
 * The credential. mcp-grafana also accepts the deprecated `GRAFANA_API_KEY` and
 * a basic-auth pair; strad plumbs neither. A service-account token is the shape
 * Grafana itself recommends, it is what the store holds, and one credential
 * shape is one thing to reason about when asking "can this mount write".
 */
export const GRAFANA_SERVICE_ACCOUNT_TOKEN = "GRAFANA_SERVICE_ACCOUNT_TOKEN";

/** Optional: which organisation, on a Grafana that has more than one. */
export const GRAFANA_ORG_ID = "GRAFANA_ORG_ID";

/**
 * The variables that MAKE an instance of this server.
 *
 * The bundle host hands this list to `slugsWithPrefixedNames`, which mounts a
 * second instance for every slug the container carries a COMPLETE set of them
 * for. Both are required there on purpose: a URL without a token is a mount that
 * lists 52 tools and 401s on all of them, which is worse than no mount at a path
 * nobody configured.
 */
export const GRAFANA_ENV_NAMES = [
  GRAFANA_URL,
  GRAFANA_SERVICE_ACCOUNT_TOKEN,
] as const;

/** Process variables a Go binary needs to run and to trust a TLS certificate. */
const PROCESS_ENV_NAMES = [
  "PATH",
  "HOME",
  "TMPDIR",
  // Go's crypto/x509 reads these before the system trust store. The Playwright
  // base image has a normal ca-certificates bundle, so they are usually unset —
  // and if an operator sets them, a Grafana behind a private CA still verifies.
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
] as const;

/** Grafana variables passed through to the child, when set. */
const GRAFANA_PASSTHROUGH = [
  GRAFANA_URL,
  GRAFANA_SERVICE_ACCOUNT_TOKEN,
  GRAFANA_ORG_ID,
] as const;

export type Env = Readonly<Record<string, string | undefined>>;

/**
 * Which of this server's required variables are absent.
 *
 * Empty means "configured", not "working" — whether the token is valid is a
 * question only Grafana can answer, and it answers it on the first tool call.
 */
export function missingCredentials(env: Env): string[] {
  return GRAFANA_ENV_NAMES.filter((name) => !env[name]);
}

/**
 * The child's whole environment: the allowlist above, resolved against ONE
 * slug's view of the container.
 *
 * A value present but empty is dropped rather than passed as `""`. mcp-grafana
 * treats an empty `GRAFANA_URL` as "unset" and falls back to its localhost
 * default, but an empty TOKEN it would send as an `Authorization: Bearer `
 * header — a 401 that reads like a rejected credential rather than a missing
 * one.
 */
export function upstreamEnv(env: Env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of [...PROCESS_ENV_NAMES, ...GRAFANA_PASSTHROUGH]) {
    const value = env[name];
    if (value) out[name] = value;
  }
  return out;
}
