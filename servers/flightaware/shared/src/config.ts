/**
 * The one environment variable this server runs on, and the error a human gets
 * when it is missing.
 *
 * ONE CREDENTIAL, SENT AS `x-apikey`. AeroAPI v4 has no OAuth, no account id and
 * no secret pair: a single key in a header literally named `x-apikey`. It is
 * READ-ONLY by construction — nothing in AeroAPI's flight data can be written —
 * but it is NOT free: every query is billed to the account that owns the key,
 * so the scarce thing this server guards is the bill, not the data. See
 * client.ts for how a call is bounded.
 *
 * Read at CALL time, never at import or boot, from the env object the server
 * was given. This server shares a process with the rest of the bundle, and a
 * missing key must be one failed tool call, not a boot failure for every other
 * mount. Per call is not the same as live: the strad bundle's env view is a
 * snapshot taken at boot, so a rotated key there takes a redeploy.
 */

export const ENV = {
  apiKey: "AEROAPI_API_KEY",
} as const;

/** AeroAPI v4. There is no sandbox host; a test key bills like any other. */
export const DEFAULT_BASE_URL = "https://aeroapi.flightaware.com/aeroapi";

export interface AeroConfig {
  /** The `x-apikey` header value. Secret, and it spends money. */
  apiKey: string;
  baseUrl: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * How to get the key. Repeated in every credential error because the error is
 * the only documentation an agent mid-call can see.
 */
export const HOW_TO_GET_IT =
  `${ENV.apiKey} is a FlightAware AeroAPI v4 key. A human signs in at ` +
  `https://www.flightaware.com/aeroapi/portal, picks a tier (Personal is ` +
  `enough for these tools), then API Keys -> create a key. AeroAPI bills the ` +
  `account per query, so the key should belong to whoever pays for the calls.`;

/** The variables this deployment is missing, in declaration order. */
export function missingCredentials(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const value = env[ENV.apiKey];
  return value === undefined || value.trim() === "" ? [ENV.apiKey] : [];
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  baseUrl: string = DEFAULT_BASE_URL,
): AeroConfig {
  const missing = missingCredentials(env);
  if (missing.length > 0) {
    throw new ConfigError(
      `FlightAware AeroAPI is not configured: ${missing.join(", ")} is not ` +
        `set. ${HOW_TO_GET_IT}`,
    );
  }
  return {
    apiKey: env[ENV.apiKey]!.trim(),
    baseUrl: baseUrl.replace(/\/+$/, ""),
  };
}
