import type { ServiceAccount } from "./parameter-manager.js";

/**
 * The server's configuration, read from the environment.
 *
 * Everything here is injected by strad onto the bundle component (the config
 * `env:` map). The image itself is credential-free, like every other server in
 * this repo.
 */
export interface SecretsConfig {
  projectId: string;
  /**
   * The canonical-path prefixes this server manages, e.g.
   * ["/strad/staging/mcp/"].
   *
   * A parameter is addressed by a canonical path
   * `/strad/{env}/mcp/{server-slug}/{kind}/{VARIABLE_NAME}`, and a "namespace" is
   * a prefix of that path. The prefix is stored inside each parameter's envelope,
   * so listing filters on the envelope's own path — not on a decoded id.
   *
   * Be precise about what it is worth: this is a CODE-LEVEL guard, not the IAM
   * boundary. The IAM boundary is the PROJECT — point this server at a project
   * that holds only these parameters. See the README.
   *
   * What the prefix DOES buy: the server will not list, and get_parameter will
   * not read, outside it — so strad's own parameters (or a second tenant's) in
   * the same project stay out of this server's answers.
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
  projectId: "SECRETS_PROJECT_ID",
  namespaces: "SECRETS_NAMESPACES",
  keyJson: "SECRETS_SERVICE_ACCOUNT_KEY_JSON",
  consoleUrl: "SECRETS_CONSOLE_URL",
  apiBase: "SECRETS_PM_API_BASE",
  tokenUrl: "SECRETS_TOKEN_URL",
} as const;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): SecretsConfig {
  const projectId = env[ENV.projectId];
  if (!projectId) {
    throw new Error(`${ENV.projectId} must be configured`);
  }

  const namespaces = (env[ENV.namespaces] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (namespaces.length === 0) {
    // Fail closed. An empty namespace list would mean "" — every parameter in
    // the project, including strad's own — and that is precisely the blast
    // radius this server exists to bound.
    throw new Error(
      `${ENV.namespaces} must name at least one path prefix (e.g. "/strad/staging/mcp/"). ` +
        `An unset namespace would scope this server to EVERY parameter in the project.`,
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

/** Is this canonical path inside one of the managed namespaces? */
export function inManagedNamespace(name: string, namespaces: string[]): boolean {
  return namespaces.some((ns) => name.startsWith(ns));
}
