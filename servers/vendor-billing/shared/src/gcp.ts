/**
 * Google Cloud: fixed BigQuery queries over a Cloud Billing standard usage
 * cost export table. This file runs them and holds the month-to-date one;
 * `gcp-breakdown.ts` builds the grouped one.
 *
 * AUTH is a service-account key, exchanged for an access token by the JWT
 * bearer grant (RFC 7523) with node's own `crypto` and `fetch`, and no client
 * library, as `servers/liveoak/shared/src/gcs.ts` does. The scope is
 * `bigquery.readonly`, which `jobs.query` accepts; the account is meant to hold
 * BigQuery Data Viewer on the export dataset and Job User on the project the
 * query runs in, and nothing else. The assertion only ever goes to Google's
 * own token endpoint: the key file's `token_uri` is not read.
 *
 * EACH QUERY IS A CONSTANT apart from the table, which BigQuery cannot bind as
 * a parameter (the breakdown also picks among fixed fragments by enum). The
 * table's three parts are validated against strict identifier patterns in
 * `config.ts` before any query sees them, every value a caller supplies is a
 * bound query parameter, and each query runs as GoogleSQL with a ceiling on
 * the bytes it may bill.
 *
 * THE MONTH is the current `invoice.month` in Pacific Time, the zone Cloud
 * Billing invoices in, computed by BigQuery itself so the server's clock is
 * not a factor.
 *
 * @see https://docs.cloud.google.com/billing/docs/how-to/export-data-bigquery-tables/standard-usage
 * @see https://docs.cloud.google.com/bigquery/docs/reference/rest/v2/jobs/query
 */

import { createSign } from "node:crypto";

import type { BillingExportTable, ServiceAccountKey } from "./config.js";
import { requestJson, UpstreamError, type HttpOptions } from "./http.js";
import type { Scrubber } from "./scrub.js";

export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const BIGQUERY_API = "https://bigquery.googleapis.com/bigquery/v2";
export const BIGQUERY_SCOPE = "https://www.googleapis.com/auth/bigquery.readonly";

/** 10 GiB. A month of a billing export is far smaller; a larger scan is refused by BigQuery. */
export const MAXIMUM_BYTES_BILLED = String(10 * 1024 ** 3);

/** How long BigQuery may hold each request open waiting for the job. */
export const QUERY_WAIT_MS = 20_000;

/** How many times an incomplete job is asked about before giving up. */
export const MAX_POLLS = 3;

/**
 * The whole tool call: token exchange, query and polls. Under the gateway's
 * 120 s tool-call default, so a slow job ends in this server's own "call
 * again" rather than a generic gateway timeout.
 */
export const CALL_BUDGET_MS = 90_000;

export function monthToDateQuery(t: BillingExportTable): string {
  return [
    "SELECT",
    "  invoice.month AS invoice_month,",
    "  currency,",
    "  SUM(cost) AS cost,",
    "  SUM(IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) AS c), 0)) AS credits,",
    "  FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%SZ', MAX(usage_end_time), 'UTC') AS latest_usage_end_time",
    `FROM \`${t.project}.${t.dataset}.${t.table}\``,
    "WHERE invoice.month = FORMAT_DATE('%Y%m', CURRENT_DATE('America/Los_Angeles'))",
    "GROUP BY invoice_month, currency",
    "ORDER BY currency",
  ].join("\n");
}

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

/** A signed JWT asking for `scope` on behalf of the service account. */
export function signedAssertion(key: ServiceAccountKey, nowSeconds: number): string {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT", ...(key.privateKeyId ? { kid: key.privateKeyId } : {}) }));
  const claims = base64url(
    JSON.stringify({
      iss: key.clientEmail,
      scope: BIGQUERY_SCOPE,
      aud: GOOGLE_TOKEN_URL,
      iat: nowSeconds,
      exp: nowSeconds + 3600,
    }),
  );
  let signature: string;
  try {
    signature = createSign("RSA-SHA256").update(`${header}.${claims}`).sign(key.privateKey, "base64url");
  } catch {
    // The signing error can quote the key's parse failure; it is not repeated.
    throw new UpstreamError(
      "The service-account private key in GCP_BILLING_SA_KEY_JSON would not sign. " +
        "The key file may be truncated or its newlines mangled; a human replaces it with a fresh key.",
      0,
    );
  }
  return `${header}.${claims}.${signature}`;
}

export async function accessToken(key: ServiceAccountKey, http: HttpOptions, scrub?: Scrubber): Promise<string> {
  // The assertion is a bearer credential for an hour; it is scrubbed too.
  const assertion = signedAssertion(key, Math.floor(Date.now() / 1000));
  scrub?.add(assertion);
  const body = await requestJson<{ access_token?: unknown }>(
    {
      what: "Google OAuth (token exchange)",
      url: GOOGLE_TOKEN_URL,
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }).toString(),
      advice: (status) =>
        status === 400 || status === 401 || status === 403
          ? " Google did not accept the service account's signed request: the key may be deleted or disabled."
          : "",
    },
    http,
  );
  if (typeof body.access_token !== "string" || !body.access_token) {
    throw new UpstreamError("Google OAuth answered without an access token.", 200);
  }
  return body.access_token;
}

interface QueryResponse {
  jobComplete?: boolean;
  jobReference?: { projectId?: string; jobId?: string; location?: string };
  schema?: { fields?: Array<{ name?: string }> };
  rows?: Array<{ f?: Array<{ v?: unknown }> }>;
  totalBytesProcessed?: unknown;
}

function bigQueryAdvice(status: number): string {
  switch (status) {
    case 403:
      return (
        " The service account needs BigQuery Data Viewer on the export dataset and " +
        "BigQuery Job User on the project the query runs in."
      );
    case 404:
      return (
        " The export table was not found. Check GCP_BILLING_EXPORT_PROJECT, " +
        "GCP_BILLING_EXPORT_DATASET and GCP_BILLING_EXPORT_TABLE against the " +
        "Cloud Billing export settings."
      );
    case 400:
      return (
        " BigQuery refused the query: the table may not be a standard usage cost " +
        "export, or the scan would bill more than this server's 10 GiB ceiling " +
        "(the message says bytesBilledLimitExceeded when it is that)."
      );
    default:
      return status >= 500 ? " BigQuery is failing on its side; a read is safe to retry shortly." : "";
  }
}

export function number(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.round(n * 1e8) / 1e8 : null;
}

export interface MonthToDateRow {
  invoice_month: string | null;
  currency: string | null;
  cost: number | null;
  credits: number | null;
  net: number | null;
  latest_usage_end_time: string | null;
}

/** Each row as a record keyed by the schema's column names. */
export function cells(response: QueryResponse): Array<Record<string, unknown>> {
  const names = (response.schema?.fields ?? []).map((f) => f.name ?? "");
  return (response.rows ?? []).map((row) => {
    const cell: Record<string, unknown> = {};
    (row.f ?? []).forEach((c, i) => {
      cell[names[i] ?? String(i)] = c?.v ?? null;
    });
    return cell;
  });
}

export function text(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

export function net(cost: number | null, credits: number | null): number | null {
  return cost !== null && credits !== null ? Math.round((cost + credits) * 1e8) / 1e8 : null;
}

function rows(response: QueryResponse): MonthToDateRow[] {
  return cells(response).map((cell) => {
    const cost = number(cell.cost);
    const credits = number(cell.credits);
    return {
      invoice_month: typeof cell.invoice_month === "string" ? cell.invoice_month : null,
      currency: typeof cell.currency === "string" ? cell.currency : null,
      cost,
      credits,
      net: net(cost, credits),
      latest_usage_end_time: typeof cell.latest_usage_end_time === "string" ? cell.latest_usage_end_time : null,
    };
  });
}

export interface MonthToDateOptions extends HttpOptions {
  /** A token already minted, so a caller can scrub it. */
  token: string;
}

/** One named, typed GoogleSQL query parameter, as `jobs.query` takes it. */
export interface QueryParameter {
  name: string;
  parameterType: { type: "STRING" | "DATE" | "INT64" };
  parameterValue: { value: string };
}

export function queryParameter(name: string, type: QueryParameter["parameterType"]["type"], value: string): QueryParameter {
  return { name, parameterType: { type }, parameterValue: { value } };
}

/**
 * Run one query against the export's project and wait for it: the first
 * `jobs.query` answer, then at most {@link MAX_POLLS} `getQueryResults` polls.
 * `what` names the query in the "call again" error.
 */
export async function runQuery(
  table: BillingExportTable,
  query: string,
  parameters: readonly QueryParameter[],
  what: string,
  options: MonthToDateOptions,
): Promise<QueryResponse> {
  const auth = { Authorization: `Bearer ${options.token}` };
  const project = encodeURIComponent(table.project);
  let response = await requestJson<QueryResponse>(
    {
      what: "BigQuery (jobs.query)",
      url: `${BIGQUERY_API}/projects/${project}/queries`,
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        query,
        useLegacySql: false,
        timeoutMs: QUERY_WAIT_MS,
        maximumBytesBilled: MAXIMUM_BYTES_BILLED,
        ...(parameters.length > 0 ? { parameterMode: "NAMED", queryParameters: parameters } : {}),
      }),
      advice: bigQueryAdvice,
    },
    options,
  );

  for (let polls = 0; response.jobComplete !== true; polls++) {
    const job = response.jobReference;
    if (polls >= MAX_POLLS || !job?.jobId) {
      throw new UpstreamError(`BigQuery did not finish the ${what} query in time. It is safe to call again.`, 0);
    }
    // The job runs in the export's project, so that is where it is asked
    // about. Only the job id and location come from the answer, encoded.
    const url = new URL(`${BIGQUERY_API}/projects/${project}/queries/${encodeURIComponent(job.jobId)}`);
    url.searchParams.set("timeoutMs", String(QUERY_WAIT_MS));
    if (job.location) url.searchParams.set("location", job.location);
    response = await requestJson<QueryResponse>(
      {
        what: "BigQuery (jobs.getQueryResults)",
        url: url.toString(),
        method: "GET",
        headers: auth,
        advice: bigQueryAdvice,
      },
      options,
    );
  }
  return response;
}

export async function monthToDate(table: BillingExportTable, options: MonthToDateOptions) {
  const response = await runQuery(table, monthToDateQuery(table), [], "month-to-date", options);
  const result = rows(response);
  return {
    invoice_month_timezone: "America/Los_Angeles",
    rows: result,
    ...(result.length === 0
      ? { note: "The export has no rows for the current invoice month yet." }
      : {}),
  };
}
