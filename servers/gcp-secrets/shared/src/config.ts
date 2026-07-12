import type { ServiceAccount } from "./client.js";

/**
 * The server's configuration, read from the environment.
 *
 * Everything here is injected by strad onto the bundle component (the config
 * `env:` map). The image itself is credential-free, like every other server in
 * this repo.
 */
export interface GcpSecretsConfig {
  projectId: string;
  /**
   * The secret-name prefixes this server manages, e.g. ["mcp-"].
   *
   * GCP secret ids are flat (`[A-Za-z0-9_-]{1,255}`) — there is no folder — so a
   * "namespace" is a prefix, and it is the SAME string the IAM condition on the
   * service account's role binding uses:
   *
   *   resource.name.startsWith("projects/<num>/secrets/mcp-")
   *
   * Keeping the two in lockstep is the point. The server can only ever LIST what
   * its credential can see; configuring a namespace it has no binding for yields
   * an empty list, not an escalation.
   */
  namespaces: string[];
  account: ServiceAccount | null;
  /** Where the human console lives, for `open_secrets_manager`'s deep link. */
  consoleUrl?: string;
  /** Test seams. Unset in production. */
  apiBase?: string;
  tokenUrl?: string;
}

export const ENV = {
  projectId: "GCP_SECRETS_PROJECT_ID",
  namespaces: "GCP_SECRETS_NAMESPACES",
  keyJson: "GCP_SECRETS_SERVICE_ACCOUNT_KEY_JSON",
  consoleUrl: "GCP_SECRETS_CONSOLE_URL",
  apiBase: "GCP_SECRETS_API_BASE",
  tokenUrl: "GCP_SECRETS_TOKEN_URL",
} as const;

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
): GcpSecretsConfig {
  const projectId = env[ENV.projectId];
  if (!projectId) {
    throw new Error(`${ENV.projectId} must be configured`);
  }

  const namespaces = (env[ENV.namespaces] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (namespaces.length === 0) {
    // Fail closed. An empty namespace list would mean "" — every secret in the
    // project, including strad's own STRAD_TOKENS — and that is precisely the
    // blast radius this server exists to bound.
    throw new Error(
      `${ENV.namespaces} must name at least one prefix (e.g. "mcp-"). ` +
        `An unset namespace would scope this server to EVERY secret in the project.`,
    );
  }

  return {
    projectId,
    namespaces,
    account: parseAccount(env[ENV.keyJson]),
    consoleUrl: env[ENV.consoleUrl],
    apiBase: env[ENV.apiBase],
    tokenUrl: env[ENV.tokenUrl],
  };
}

/**
 * The service-account key, as JSON.
 *
 * A malformed key must not leak into the error: `JSON.parse` failures here are
 * reported by shape, never by content, because the content IS a private key.
 */
export function parseAccount(raw: string | undefined): ServiceAccount | null {
  if (!raw) return null;
  let parsed: Partial<ServiceAccount>;
  try {
    parsed = JSON.parse(raw) as Partial<ServiceAccount>;
  } catch {
    throw new Error(`${ENV.keyJson} is not valid JSON`);
  }
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error(`${ENV.keyJson} is missing client_email / private_key`);
  }
  return { client_email: parsed.client_email, private_key: parsed.private_key };
}

/** Is this secret id inside one of the managed namespaces? */
export function inManagedNamespace(
  name: string,
  namespaces: string[],
): boolean {
  return namespaces.some((ns) => name.startsWith(ns));
}
