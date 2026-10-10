/**
 * The one environment variable this server runs on, and the error a human gets
 * when it is missing.
 *
 * ONE CREDENTIAL: an Airtable personal access token, sent as `Authorization:
 * Bearer`. A PAT is scoped twice — by SCOPE (what kind of call it may make) and
 * by BASE (which bases it may see) — and both are chosen by whoever mints it.
 * So unlike a single admin key, the token itself can be narrowed: a read-only
 * deployment can hold a token that has no write scope at all, and the gateway's
 * `tools:` policy is then a second fence rather than the only one.
 */

export const ENV = {
  apiKey: "AIRTABLE_API_KEY",
} as const;

/** Every call but one goes here. */
export const API_BASE_URL = "https://api.airtable.com";

/**
 * `uploadAttachment` is served from a different host. It is the only endpoint
 * that is, and a request for it sent to the API host is a plain 404.
 */
export const CONTENT_BASE_URL = "https://content.airtable.com";

export interface AirtableConfig {
  /** The personal access token. Secret. */
  apiKey: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * How to get the token. Repeated in every credential error because the error is
 * the only documentation an agent mid-call can see, and the person it relays to
 * needs the scope list, not a link to a manual.
 */
export const HOW_TO_GET_IT =
  `${ENV.apiKey} is an Airtable personal access token. Create one at ` +
  `https://airtable.com/create/tokens with the scopes data.records:read, ` +
  `data.records:write, data.recordComments:read, data.recordComments:write, ` +
  `schema.bases:read and schema.bases:write (a read-only deployment can omit ` +
  `the three :write scopes), and grant it access to each base it should see — ` +
  `a token sees no base it was not explicitly given.`;

/** The variables this deployment is missing, in declaration order. */
export function missingCredentials(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const value = env[ENV.apiKey];
  return value === undefined || value.trim() === "" ? [ENV.apiKey] : [];
}

/**
 * Read at CALL time, never at boot. This server shares a process with every
 * other mount in the bundle, and a missing token must be one failed tool call,
 * not a crashed container.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
): AirtableConfig {
  const missing = missingCredentials(env);
  if (missing.length > 0) {
    throw new ConfigError(
      `Airtable is not configured: ${missing.join(", ")} is not set. ${HOW_TO_GET_IT}`,
    );
  }
  return { apiKey: env[ENV.apiKey]!.trim() };
}
