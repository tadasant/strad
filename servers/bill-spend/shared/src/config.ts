/**
 * The two environment variables this server runs on, and the error a human gets
 * when the credential is missing.
 *
 * ONE CREDENTIAL, AND IT IS UNSCOPED ADMIN. BILL Spend & Expense authenticates
 * with a single static token in a header literally named `apiToken` — no
 * organization id, no developer key, no client secret, no OAuth. If a reader
 * finds themselves wiring four credentials they are on BILL's AP/AR API, which
 * is a different product behind the same gateway host.
 *
 * BILL offers no read-only and no least-privilege token: the same secret that
 * re-codes a transaction can issue a virtual card, move a budget and manage
 * users. The TOOL SURFACE is the only thing standing between an agent and a new
 * virtual card, which is why this server implements five tools and not the
 * twenty the API would allow. See tools.ts.
 *
 * THE ENVIRONMENT IS NOT A SECRET AND IS STILL LOAD-BEARING. Sandbox and
 * production are separate companies with separate tokens and separate data, and
 * the only thing that tells them apart in a request is the base URL. A token
 * pasted into the wrong deployment does not silently write to the wrong company
 * — it 401s — but a deployment pointed at production while a human believes it
 * is sandbox writes to real financial records. So the value is explicit, it is
 * validated against a closed set, and there is no default that could be wrong
 * quietly.
 */

export const ENV = {
  apiToken: "BILL_SPEND_API_TOKEN",
  environment: "BILL_ENVIRONMENT",
} as const;

/** The two BILL environments, and the base URL each one means. */
export const BASE_URLS = {
  sandbox: "https://gateway.stage.bill.com/connect",
  production: "https://gateway.prod.bill.com/connect",
} as const;

export type BillEnvironment = keyof typeof BASE_URLS;

export const ENVIRONMENTS = Object.keys(BASE_URLS) as BillEnvironment[];

export interface BillConfig {
  /** The `apiToken` header value. Secret, and unscoped ADMIN on the company. */
  apiToken: string;
  /** Which BILL company this token belongs to. */
  environment: BillEnvironment;
  /** `https://gateway.{stage,prod}.bill.com/connect`, derived from the above. */
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
const HOW_TO_GET_IT =
  `${ENV.apiToken} is a BILL Spend & Expense API token. In production an ADMIN ` +
  `on the company mints one under My account -> Settings -> Generate new token. ` +
  `For sandbox, fill in the Sandbox Access Form at ` +
  `https://app-dev-bdc-stg.divvy.co/create-sandbox-company, which creates a ` +
  `separate empty test company and hands back an apiToken. It is NOT a Bill.com ` +
  `AP/AR credential: that API wants a sessionId and a devKey, and none of its ` +
  `endpoints appear here.`;

/** The variables this deployment is missing, in declaration order. */
export function missingCredentials(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  // Only the TOKEN. `BILL_ENVIRONMENT` has a default and a deployment that omits
  // it is configured, not broken — reporting it as missing would mark the mount
  // degraded over a variable nobody has to set.
  const value = env[ENV.apiToken];
  return value === undefined || value.trim() === "" ? [ENV.apiToken] : [];
}

/**
 * Which company this deployment talks to.
 *
 * DEFAULTS TO SANDBOX, and that direction is the whole point. An unset variable
 * on a deployment somebody meant to be production costs a 401 and a confused
 * hour; an unset variable that defaulted the other way would point an unattended
 * agent at real financial records because someone forgot a line of YAML.
 */
export function readEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): BillEnvironment {
  const raw = env[ENV.environment]?.trim();
  if (raw === undefined || raw === "") return "sandbox";
  const normalized = raw.toLowerCase();
  if (!ENVIRONMENTS.includes(normalized as BillEnvironment)) {
    // The value is safe to quote — an environment name is not a credential —
    // and quoting it is what makes a pasted "Production " diagnosable.
    throw new ConfigError(
      `${ENV.environment}="${raw}" is not a BILL environment. Use one of: ` +
        `${ENVIRONMENTS.join(", ")}. Omit it entirely for ${ENVIRONMENTS[0]}.`,
    );
  }
  return normalized as BillEnvironment;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BillConfig {
  // The environment is read FIRST, so a deployment with both a bad environment
  // name and no token hears about the one a human can fix without minting
  // anything.
  const environment = readEnvironment(env);
  const missing = missingCredentials(env);
  if (missing.length > 0) {
    throw new ConfigError(
      `BILL Spend & Expense is not configured: ${missing.join(", ")} is not ` +
        `set. ${HOW_TO_GET_IT}`,
    );
  }
  return {
    apiToken: env[ENV.apiToken]!.trim(),
    environment,
    baseUrl: BASE_URLS[environment],
  };
}
