/**
 * The one environment variable this server runs on, and the error a human gets
 * when it is missing.
 *
 * ONE CREDENTIAL, A PERSONAL ACCESS TOKEN, sent as `Authorization: Bearer`. A
 * DigitalOcean token can be minted with CUSTOM SCOPES: a token with only
 * `:read` scopes cannot create or delete anything whatever this server's tool
 * list says. That fences a deployment that gives its read-only surface ITS OWN
 * read-scoped token. In strad it fences nothing between the two slugs:
 * `digitalocean-tadasant-ro` and `-rw` share one container and one token, so
 * the token holds the write scopes and the gateway's `tools:` policy is the
 * only thing keeping `-ro` read-only. The exact scope list is in the README.
 *
 * READ AT CALL TIME, NEVER AT BOOT. This server shares a process with the rest
 * of the bundle, so a missing token is one server's failed tool call. It is
 * read from the environment the server was given; in the strad bundle that is
 * a view fixed at boot, so a rotated token takes a redeploy to arrive.
 */

export const ENV = {
  apiToken: "DIGITALOCEAN_API_TOKEN",
} as const;

export const DEFAULT_BASE_URL = "https://api.digitalocean.com/v2";

export interface DigitalOceanConfig {
  /** The bearer token. Secret. */
  apiToken: string;
  /** `https://api.digitalocean.com/v2` outside tests. */
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
  `${ENV.apiToken} is a DigitalOcean personal access token. A human mints one ` +
  `at https://cloud.digitalocean.com/account/api/tokens -> Generate New Token, ` +
  `choosing "Custom Scopes": the :read scopes on account, actions, app, ` +
  `billing, database, droplet, image, regions, sizes and ssh_key for read-only ` +
  `use, plus create/update/delete on droplet, app and database for read-write. ` +
  `It is shown once; it then goes into this deployment's secrets, not into a ` +
  `tool call.`;

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
): DigitalOceanConfig {
  const missing = missingCredentials(env);
  if (missing.length > 0) {
    throw new ConfigError(
      `DigitalOcean is not configured: ${missing.join(", ")} is not set. ` +
        HOW_TO_GET_IT,
    );
  }
  return {
    apiToken: env[ENV.apiToken]!.trim(),
    baseUrl: baseUrl.replace(/\/+$/, ""),
  };
}
