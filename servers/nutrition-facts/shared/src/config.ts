/**
 * The environment this server reads. EVERY VARIABLE IS OPTIONAL.
 *
 * With nothing set the server still answers from its local USDA and MenuStat
 * data and reports FatSecret (and USDA Branded) as `unavailable`, naming the
 * variable. That is the spec's posture — a fallback that keeps working when a
 * live source does not — and it is why this server never reports itself
 * degraded for a missing credential.
 *
 * Read at CALL time from the env object the server was given, never at import.
 * In the strad bundle that object is a snapshot taken at boot (and a name may
 * arrive slug-prefixed, e.g. `NUTRITION_FACTS__FATSECRET_CLIENT_ID`), so a
 * newly seeded credential takes a redeploy.
 */

export const ENV = {
  fatsecretClientId: "FATSECRET_CLIENT_ID",
  fatsecretClientSecret: "FATSECRET_CLIENT_SECRET",
  fatsecretProxyUrl: "FATSECRET_PROXY_URL",
  fdcApiKey: "USDA_FDC_API_KEY",
  dataDir: "NUTRITION_FACTS_DATA_DIR",
} as const;

export interface FatSecretCredentials {
  clientId: string;
  clientSecret: string;
  /**
   * The forward proxy EVERY FatSecret request goes through — token and API
   * alike. A FatSecret key answers only allowlisted IPs, and this proxy's
   * dedicated exit IPs are the ones on that list. It carries a password, so it
   * is never logged and is scrubbed from every error.
   */
  proxyUrl: string;
}

function value(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const v = env[name]?.trim();
  return v ? v : undefined;
}

/**
 * FatSecret's configuration, or why it is missing.
 *
 * ALL THREE OR NOTHING. Without the proxy there is no direct fallback: a direct
 * call leaves from an IP the key does not allow (error 21), and every FatSecret
 * call is meant to leave from the proxy's dedicated IPs. So a missing proxy is
 * an unconfigured FatSecret, exactly like a missing client.
 */
export function fatsecretConfig(
  env: NodeJS.ProcessEnv,
): { ok: true; value: FatSecretCredentials } | { ok: false; reason: string } {
  const clientId = value(env, ENV.fatsecretClientId);
  const clientSecret = value(env, ENV.fatsecretClientSecret);
  const proxyUrl = value(env, ENV.fatsecretProxyUrl);
  const missing = ([
    clientId ? null : ENV.fatsecretClientId,
    clientSecret ? null : ENV.fatsecretClientSecret,
    proxyUrl ? null : ENV.fatsecretProxyUrl,
  ] as Array<string | null>).filter((n): n is string => n !== null);
  if (missing.length > 0) {
    return {
      ok: false,
      reason:
        `FatSecret is not configured: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not set. ` +
        `${ENV.fatsecretClientId} / ${ENV.fatsecretClientSecret} are a FatSecret Platform API ` +
        `OAuth 2.0 client (https://platform.fatsecret.com, Basic tier); ${ENV.fatsecretProxyUrl} is ` +
        `the forward proxy whose dedicated IPs are on the key's allowlist. FatSecret is never called without it.`,
    };
  }
  if (!validProxyUrl(proxyUrl!)) {
    return {
      ok: false,
      reason:
        `FatSecret is not configured: ${ENV.fatsecretProxyUrl} is not an http(s) proxy URL ` +
        `of the form http://user:password@host:port. (Its value is not shown: it carries a password.)`,
    };
  }
  return { ok: true, value: { clientId: clientId!, clientSecret: clientSecret!, proxyUrl: proxyUrl! } };
}

function validProxyUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return (u.protocol === "http:" || u.protocol === "https:") && u.hostname !== "";
  } catch {
    return false;
  }
}

export function fatsecretCredentials(
  env: NodeJS.ProcessEnv,
): FatSecretCredentials | undefined {
  const c = fatsecretConfig(env);
  return c.ok ? c.value : undefined;
}

export function fdcApiKey(env: NodeJS.ProcessEnv): string | undefined {
  return value(env, ENV.fdcApiKey);
}

export const FDC_NOT_CONFIGURED =
  `USDA Branded foods were not searched: ${ENV.fdcApiKey} is not set. It is ` +
  `a free api.data.gov key (https://fdc.nal.usda.gov/api-key-signup).`;

/**
 * The credentials this deployment lacks. Always empty: nothing is required.
 * Exported in the shape the strad bundle host reads from every tree, so the
 * mount is never marked degraded for an optional source.
 */
export function missingCredentials(): string[] {
  return [];
}
