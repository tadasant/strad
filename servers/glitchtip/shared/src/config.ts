/**
 * What this server runs on, and the error a human gets when it is missing.
 *
 * A GLITCHTIP IS AN ORIGIN AND A TOKEN. GlitchTip is self-hosted as often as
 * not, so the base URL is configuration, not a constant: one slug is one
 * GlitchTip, and the bundle host mounts one instance per slug that carries both
 * under its own name. The token is a GlitchTip API token, sent as
 * `Authorization: Bearer`; it reaches whatever its user can see, in every
 * organization, and GlitchTip scopes it by permission (`org:read`,
 * `project:read`, `event:read`, …) rather than by organization.
 *
 * THE ORGANIZATION IS A DEFAULT, NOT A FENCE. Most tools take an
 * `organization` argument, and `GLITCHTIP_ORGANIZATION_SLUG` is what they use
 * when the caller gives none. A token that can see two organizations can read
 * both through one slug.
 *
 * READ AT CALL TIME, NEVER AT BOOT. A missing credential is one failed tool
 * call, not a failed bundle; `tools/list` works with nothing configured.
 */

export const ENV = {
  baseUrl: "GLITCHTIP_BASE_URL",
  apiToken: "GLITCHTIP_API_TOKEN",
  organization: "GLITCHTIP_ORGANIZATION_SLUG",
} as const;

/**
 * The variables that MAKE an instance of this server: an origin and a token.
 * The bundle host mounts a per-slug instance for every slug that carries both
 * under its own name, so neither half is ever a sibling's.
 */
export const GLITCHTIP_ENV_NAMES = [ENV.baseUrl, ENV.apiToken] as const;

export interface GlitchTipConfig {
  /** The origin (and any path prefix), no trailing slash. */
  baseUrl: string;
  /** The bearer token. Secret. */
  apiToken: string;
  /** The organization a tool uses when the caller names none. */
  organization?: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Repeated in every credential error: the error is all an agent mid-call sees. */
export const HOW_TO_GET_IT =
  `${ENV.baseUrl} is the GlitchTip's URL, e.g. https://glitchtip.example.com. ` +
  `${ENV.apiToken} is an API token a human creates in GlitchTip under Profile -> ` +
  `Auth Tokens, with the read scopes (org:read, project:read, team:read, ` +
  `event:read). Both go into this deployment's secrets, not into a tool call.`;

type Env = Readonly<Record<string, string | undefined>>;

function value(env: Env, name: string): string | undefined {
  const v = env[name]?.trim();
  return v === undefined || v === "" ? undefined : v;
}

/** The required variables this deployment is missing, in declaration order. */
export function missingCredentials(env: Env = process.env): string[] {
  return GLITCHTIP_ENV_NAMES.filter((name) => value(env, name) === undefined);
}

/**
 * A host whose plain-http traffic stays off the public internet: loopback,
 * RFC 1918 and link-local addresses, and the `.internal` / `.local` names a
 * private network resolves. Anything else must be https.
 */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "localhost" || h === "::1" || h.endsWith(".internal") || h.endsWith(".local")) {
    return true;
  }
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (!v4) return false;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  return (
    a === 127 ||
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}

export function loadConfig(env: Env = process.env): GlitchTipConfig {
  const missing = missingCredentials(env);
  if (missing.length > 0) {
    throw new ConfigError(
      `GlitchTip is not configured: ${missing.join(" and ")} ` +
        `${missing.length === 1 ? "is" : "are"} not set. ${HOW_TO_GET_IT}`,
    );
  }
  const raw = value(env, ENV.baseUrl)!;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`${ENV.baseUrl} is not a URL. ${HOW_TO_GET_IT}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ConfigError(`${ENV.baseUrl} must be an https URL.`);
  }
  if (url.protocol === "http:" && !isPrivateHost(url.hostname)) {
    throw new ConfigError(
      `${ENV.baseUrl} must be https: the token would cross the network in ` +
        `cleartext. http is accepted only for a loopback, private-network, ` +
        `.internal or .local host.`,
    );
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ConfigError(
      `${ENV.baseUrl} must be a plain origin (and optional path): no ` +
        `credentials, query string or fragment.`,
    );
  }
  const organization = value(env, ENV.organization);
  return {
    baseUrl: `${url.origin}${url.pathname}`.replace(/\/+$/, ""),
    apiToken: value(env, ENV.apiToken)!,
    ...(organization === undefined ? {} : { organization }),
  };
}
