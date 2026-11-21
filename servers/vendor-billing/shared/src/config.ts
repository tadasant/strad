/**
 * What each tool runs on, and the answer a caller gets when it is missing.
 *
 * EACH TOOL IS CONFIGURED ON ITS OWN. Four tools, three vendors, four
 * credentials, and no tool needs another's. A deployment that holds only an
 * OpenAI admin key gets a working `get_openai_costs` and three tools that
 * answer `not configured` naming what they lack — by NAME, never by value.
 * Nothing here fails a boot: `tools/list` needs no variable at all.
 *
 * READ AT CALL TIME, NEVER AT BOOT, from the environment the server was
 * given. A missing variable is one refused call rather than a failed boot. In
 * the bundle that environment is the host's per-mount view, copied when the
 * mount loads, so a rotated value reaches this server on the next restart.
 *
 * THE BIGQUERY TABLE IS CONFIGURATION, AND IT IS SPLICED INTO SQL. BigQuery
 * cannot bind a table name as a query parameter, so the project, dataset and
 * table are validated against strict patterns here, before the query is
 * built, and a value outside them is a configuration error rather than a
 * query. The patterns are narrower than what BigQuery accepts on purpose:
 * they admit what a Cloud Billing export is named and nothing that can close
 * a backtick.
 */

export const ENV = {
  openrouterManagementKey: "OPENROUTER_MANAGEMENT_KEY",
  openrouterApiKey: "OPENROUTER_PI_API_KEY",
  openaiAdminKey: "OPENAI_ADMIN_KEY",
  gcpServiceAccountKey: "GCP_BILLING_SA_KEY_JSON",
  gcpProject: "GCP_BILLING_EXPORT_PROJECT",
  gcpDataset: "GCP_BILLING_EXPORT_DATASET",
  gcpTable: "GCP_BILLING_EXPORT_TABLE",
} as const;

/** The variables whose VALUES are credentials. Scrubbed from every result. */
export const SECRET_ENV_NAMES = [
  ENV.openrouterManagementKey,
  ENV.openrouterApiKey,
  ENV.openaiAdminKey,
  ENV.gcpServiceAccountKey,
] as const;

/** Configuration, not credentials: where the billing export lives. */
export const NON_SECRET_ENV_NAMES = [ENV.gcpProject, ENV.gcpDataset, ENV.gcpTable] as const;

export const TOOL_NAMES = [
  "get_openrouter_credits",
  "get_openrouter_key_usage",
  "get_openai_costs",
  "get_gcp_month_to_date",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

/** Which variables each tool needs. ALL of a tool's names make it configured. */
export const TOOL_ENV: Readonly<Record<ToolName, readonly string[]>> = {
  get_openrouter_credits: [ENV.openrouterManagementKey],
  get_openrouter_key_usage: [ENV.openrouterApiKey],
  get_openai_costs: [ENV.openaiAdminKey],
  get_gcp_month_to_date: [ENV.gcpServiceAccountKey, ENV.gcpProject, ENV.gcpDataset, ENV.gcpTable],
};

/** Every variable any tool reads, secret first. */
export const ALL_ENV_NAMES = [...SECRET_ENV_NAMES, ...NON_SECRET_ENV_NAMES] as const;

export type Env = Readonly<Record<string, string | undefined>>;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** A tool whose variables are absent. Its message names them and nothing else. */
export class NotConfiguredError extends ConfigError {
  constructor(
    readonly tool: ToolName,
    readonly missing: readonly string[],
  ) {
    super(
      `not configured: ${tool} needs ${missing.join(", ")}, which ` +
        `${missing.length === 1 ? "is" : "are"} not set in this deployment. ` +
        `The other tools on this server are unaffected. A human sets ` +
        `${missing.length === 1 ? "it" : "them"} in the deployment's secrets and ` +
        `config; a tool call cannot.`,
    );
    this.name = "NotConfiguredError";
  }
}

export function value(env: Env, name: string): string | undefined {
  const v = env[name]?.trim();
  return v === undefined || v === "" ? undefined : v;
}

/** The variables `tool` needs that `env` lacks, in declaration order. */
export function missingFor(tool: ToolName, env: Env = process.env): string[] {
  return TOOL_ENV[tool].filter((name) => value(env, name) === undefined);
}

/**
 * The variables this mount lacks when NO tool is configured, and nothing once
 * any one is. The bundle host reports a non-empty answer as "every tool will
 * fail", which is only true when all four are unconfigured; a partly
 * configured mount is a working one.
 */
export function missingCredentials(env: Env = process.env): string[] {
  const configured = TOOL_NAMES.some((tool) => missingFor(tool, env).length === 0);
  if (configured) return [];
  const names = new Set<string>();
  for (const tool of TOOL_NAMES) for (const name of missingFor(tool, env)) names.add(name);
  return [...names];
}

/** The value of each of `tool`'s variables, or a `not configured` refusal. */
export function requireFor(tool: ToolName, env: Env): Record<string, string> {
  const missing = missingFor(tool, env);
  if (missing.length > 0) throw new NotConfiguredError(tool, missing);
  const out: Record<string, string> = {};
  for (const name of TOOL_ENV[tool]) out[name] = value(env, name)!;
  return out;
}

// ---- the BigQuery export's address ------------------------------------------

/**
 * A Google Cloud project ID: 6–30 characters, lowercase letters, digits and
 * hyphens, starting with a letter and not ending in a hyphen. The legacy
 * domain-scoped form (`example.com:project`) is refused: its `:` and `.` are
 * not worth admitting into a spliced identifier for a billing export.
 */
export const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

/** A dataset ID: letters, digits and underscores, at most 1,024. */
export const DATASET_ID = /^[A-Za-z0-9_]{1,1024}$/;

/**
 * A table ID, held to the same alphabet as a dataset. BigQuery allows more
 * (Unicode letters, spaces, hyphens), but an export table is named
 * `gcp_billing_export_v1_…` in letters, digits and underscores, and nothing
 * outside that alphabet needs to reach the query text.
 */
export const TABLE_ID = /^[A-Za-z0-9_]{1,1024}$/;

export interface BillingExportTable {
  project: string;
  dataset: string;
  table: string;
}

/** Validate the three parts of the export's address before any SQL sees them. */
export function billingExportTable(vars: Record<string, string>): BillingExportTable {
  const project = vars[ENV.gcpProject]!;
  const dataset = vars[ENV.gcpDataset]!;
  const table = vars[ENV.gcpTable]!;
  const bad: string[] = [];
  if (!PROJECT_ID.test(project)) bad.push(`${ENV.gcpProject} must be a project ID (6-30 of a-z, 0-9, '-', starting with a letter)`);
  if (!DATASET_ID.test(dataset)) bad.push(`${ENV.gcpDataset} must be a dataset ID (letters, digits, '_')`);
  if (!TABLE_ID.test(table)) bad.push(`${ENV.gcpTable} must be a table ID (letters, digits, '_')`);
  if (bad.length > 0) {
    // The values are configuration, not credentials, but they are not echoed
    // either: the variable name is enough to find the mistake.
    throw new ConfigError(`get_gcp_month_to_date is misconfigured: ${bad.join("; ")}.`);
  }
  return { project, dataset, table };
}

// ---- the service-account key ------------------------------------------------

export interface ServiceAccountKey {
  clientEmail: string;
  privateKey: string;
  /** Scrubbed too: it names the key, and a key's name is nobody's business. */
  privateKeyId?: string;
}

/**
 * The two fields of a service-account key JSON this server uses. `token_uri`
 * is deliberately ignored: the signed assertion goes to Google's own token
 * endpoint and nowhere a configured value could point it.
 */
export function serviceAccountKey(raw: string): ServiceAccountKey {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigError(
      `${ENV.gcpServiceAccountKey} is not JSON. It must be a service-account key file's ` +
        `contents, as downloaded from IAM -> Service accounts -> Keys.`,
    );
  }
  const o = (parsed ?? {}) as Record<string, unknown>;
  const clientEmail = typeof o.client_email === "string" ? o.client_email : "";
  const privateKey = typeof o.private_key === "string" ? o.private_key : "";
  if (o.type !== "service_account" || !clientEmail || !privateKey.includes("PRIVATE KEY")) {
    throw new ConfigError(
      `${ENV.gcpServiceAccountKey} is not a service-account key: it needs ` +
        `"type": "service_account", "client_email" and "private_key".`,
    );
  }
  return {
    clientEmail,
    privateKey,
    ...(typeof o.private_key_id === "string" && o.private_key_id ? { privateKeyId: o.private_key_id } : {}),
  };
}
