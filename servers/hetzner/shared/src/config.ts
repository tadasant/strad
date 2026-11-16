/**
 * The one environment variable this server runs on, and the error a human gets
 * when it is missing.
 *
 * ONE CREDENTIAL, A HETZNER CLOUD PROJECT API TOKEN, sent as
 * `Authorization: Bearer`. `HCLOUD_TOKEN` is Hetzner's own name for it — the
 * `hcloud` CLI and the Terraform provider both read it — so a human who has
 * operated Hetzner before knows what goes there.
 *
 * A TOKEN IS SCOPED TO ONE PROJECT and is either "Read" or "Read & Write".
 * Nothing finer exists. A Read token cannot change anything whatever this
 * server's tool list says, which fences a deployment that gives its read-only
 * surface ITS OWN token. In strad it fences nothing between the two slugs:
 * `hetzner-pulse-ro` and `-rw` share one container and one token, so the token
 * is Read & Write and the gateway's `tools:` policy is the only thing keeping
 * `-ro` read-only.
 *
 * READ AT CALL TIME, NEVER AT BOOT. This server shares a process with the rest
 * of the bundle, so a missing token is one server's failed tool call. It is
 * read from the environment the server was given; in the strad bundle that is
 * a view fixed at boot, so a rotated token takes a redeploy to arrive.
 */

export const ENV = {
  apiToken: "HCLOUD_TOKEN",
} as const;

export const DEFAULT_BASE_URL = "https://api.hetzner.cloud/v1";

export interface HetznerConfig {
  /** The bearer token. Secret. */
  apiToken: string;
  /** `https://api.hetzner.cloud/v1` outside tests. */
  baseUrl: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * How to get the token. Repeated in every credential error because the error is
 * the only documentation an agent mid-call can see.
 */
export const HOW_TO_GET_IT =
  `${ENV.apiToken} is a Hetzner Cloud project API token. A human mints one at ` +
  `https://console.hetzner.cloud -> the project -> Security -> API tokens -> ` +
  `Generate API token, choosing "Read" for read-only use or "Read & Write" ` +
  `for the write tools. A token reaches exactly one project. It is shown ` +
  `once; it then goes into this deployment's secrets, not into a tool call.`;

/** The variables this deployment is missing, in declaration order. */
export function missingCredentials(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const value = env[ENV.apiToken];
  return value === undefined || value.trim() === "" ? [ENV.apiToken] : [];
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  baseUrl: string = DEFAULT_BASE_URL,
): HetznerConfig {
  const missing = missingCredentials(env);
  if (missing.length > 0) {
    throw new ConfigError(
      `Hetzner Cloud is not configured: ${missing.join(", ")} is not set. ` +
        HOW_TO_GET_IT,
    );
  }
  return {
    apiToken: env[ENV.apiToken]!.trim(),
    baseUrl: baseUrl.replace(/\/+$/, ""),
  };
}
