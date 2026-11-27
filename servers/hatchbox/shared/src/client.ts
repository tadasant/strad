/**
 * Hatchbox over HTTPS: the env-var API (API key) and the deploy webhook
 * (deploy key). The paths are the npm `hatchbox-mcp-server`'s, and each one
 * answers on `https://hatchbox.io`.
 *
 * THE ORIGIN IS `https://hatchbox.io`, NOT `app.hatchbox.io`. The upstream
 * package called `app.hatchbox.io`, which now answers every GET with a 301 to
 * `hatchbox.io`. Its `checkDeploy` therefore worked only by following that
 * redirect. Here a redirect is never followed (`redirect: "manual"`, reported
 * as an error), so a credential goes to the one origin it was issued for.
 *
 * NOTHING HERE IS CONFIGURABLE BY A SLUG. The origin is a constant; only tests
 * inject another. A slug can point this server at its own app, never at
 * another host.
 */
import { HatchboxApiError } from "./errors.js";
import type { ApiConfig, DeployConfig } from "./config.js";

export const HATCHBOX_ORIGIN = "https://hatchbox.io";
export const REQUEST_TIMEOUT_MS = 30_000;
/** The most of a response body this reads, so one huge answer cannot fill the bundle's heap. */
export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export interface ClientOptions {
  fetchImpl?: typeof fetch;
  origin?: string;
  timeoutMs?: number;
}

export interface EnvVarName {
  name: string;
}

export interface DeployStarted {
  /** The activity id `checkDeploy` takes. Null when Hatchbox returned none. */
  id: string | null;
  status: string | null;
  /** The parsed response, for anything else Hatchbox sent. */
  raw: unknown;
}

export interface DeployStatus {
  id: string;
  status: string;
  output: string | null;
  raw: unknown;
}

interface Request {
  method: "GET" | "PUT" | "DELETE" | "POST";
  path: string;
  apiKey?: string;
  body?: unknown;
  /** What this request is, for an error message: "set HATCHBOX env var". */
  what: string;
}

async function readCapped(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new HatchboxApiError(
        `Hatchbox sent more than ${MAX_RESPONSE_BYTES} bytes; the response was dropped.`,
        response.status,
      );
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parse(text: string): unknown {
  if (text.trim() === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Hatchbox's own error text, from `{"error": …}`, `{"message": …}` or `{"errors": …}`. */
function upstreamMessage(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  for (const key of ["error", "message"]) {
    if (typeof b[key] === "string" && b[key]) return (b[key] as string).slice(0, 500);
  }
  if (Array.isArray(b.errors)) return b.errors.map(String).join("; ").slice(0, 500);
  if (b.errors && typeof b.errors === "object") return JSON.stringify(b.errors).slice(0, 500);
  return null;
}

function statusHint(status: number, apiKey: boolean): string {
  switch (status) {
    case 401:
      return apiKey
        ? "Hatchbox rejected HATCHBOX_API_KEY: it is wrong, revoked or expired. A human replaces it."
        : "Hatchbox rejected HATCHBOX_DEPLOY_KEY. A human replaces it.";
    case 403:
      return "The key is valid but may not act on this app: check HATCHBOX_ACCOUNT_ID and HATCHBOX_APP_ID.";
    case 404:
      return apiKey
        ? "No such account or app for this key: check HATCHBOX_ACCOUNT_ID and HATCHBOX_APP_ID."
        : "Hatchbox knows no app with this deploy key, or no such activity id.";
    case 422:
      return "Hatchbox refused the values sent.";
    case 429:
      return "Hatchbox is rate limiting; wait, then retry.";
    default:
      return status >= 500 ? "Hatchbox failed on its side; retrying later may work." : "";
  }
}

export function createClient(options: ClientOptions = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const origin = (options.origin ?? HATCHBOX_ORIGIN).replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;

  async function send(req: Request): Promise<unknown> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (req.apiKey) headers.Authorization = `Bearer ${req.apiKey}`;
    if (req.body !== undefined) headers["Content-Type"] = "application/json";
    let response: Response;
    try {
      response = await fetchImpl(`${origin}${req.path}`, {
        method: req.method,
        headers,
        ...(req.body === undefined ? {} : { body: JSON.stringify(req.body) }),
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const e = error as Error & { cause?: { code?: string; message?: string } };
      if (e.name === "TimeoutError" || e.name === "AbortError") {
        throw new HatchboxApiError(
          `Hatchbox did not answer within ${timeoutMs} ms (${req.what}). It may still have acted; check before retrying a write.`,
          null,
        );
      }
      const cause = e.cause?.code ?? e.cause?.message;
      throw new HatchboxApiError(
        `Could not reach Hatchbox (${req.what}): ${e.message}${cause ? ` (${cause})` : ""}.`,
        null,
      );
    }
    if (response.status >= 300 && response.status < 400) {
      throw new HatchboxApiError(
        `Hatchbox answered ${req.what} with a redirect (HTTP ${response.status}), which ` +
          `this server does not follow: a credential goes to ${origin} only. Hatchbox ` +
          `may have moved the endpoint.`,
        response.status,
      );
    }
    const text = await readCapped(response);
    const body = parse(text);
    if (!response.ok) {
      const said = upstreamMessage(body);
      const hint = statusHint(response.status, req.apiKey !== undefined);
      throw new HatchboxApiError(
        `Hatchbox answered ${req.what} with HTTP ${response.status}` +
          (said ? `: ${said}` : "") +
          `.${hint ? ` ${hint}` : ""}`,
        response.status,
      );
    }
    if (body === undefined) {
      throw new HatchboxApiError(
        `Hatchbox answered ${req.what} with HTTP ${response.status} and a body that is not JSON.`,
        response.status,
      );
    }
    return body;
  }

  const envVarsPath = (c: ApiConfig) =>
    `/api/v1/accounts/${encodeURIComponent(c.accountId)}/apps/${encodeURIComponent(c.appId)}/env_vars`;

  /** The names in the env-var list Hatchbox answers a write with. Values are never kept. */
  function names(body: unknown): EnvVarName[] | null {
    const list = (body as { env_vars?: unknown } | null)?.env_vars;
    if (!Array.isArray(list)) return null;
    return list
      .map((e) => (e && typeof e === "object" ? (e as { name?: unknown }).name : undefined))
      .filter((n): n is string => typeof n === "string")
      .map((name) => ({ name }));
  }

  return {
    origin,

    /** `PUT …/env_vars` — add or update one variable. */
    async setEnvVar(c: ApiConfig, name: string, value: string): Promise<EnvVarName[] | null> {
      const body = await send({
        method: "PUT",
        path: envVarsPath(c),
        apiKey: c.apiKey,
        body: { env_vars: [{ name, value }] },
        what: `setting ${name}`,
      });
      return names(body);
    },

    /** `DELETE …/env_vars` — remove the named variables. */
    async deleteEnvVars(c: ApiConfig, toDelete: string[]): Promise<EnvVarName[] | null> {
      const body = await send({
        method: "DELETE",
        path: envVarsPath(c),
        apiKey: c.apiKey,
        body: { env_vars: toDelete },
        what: `deleting ${toDelete.join(", ")}`,
      });
      return names(body);
    },

    /** `POST /webhooks/deployments/{deploy key}` — `?sha=` or `?latest=true`. */
    async triggerDeploy(c: DeployConfig, sha?: string): Promise<DeployStarted> {
      const query = sha ? `sha=${encodeURIComponent(sha)}` : "latest=true";
      const body = await send({
        method: "POST",
        path: `/webhooks/deployments/${encodeURIComponent(c.deployKey)}?${query}`,
        what: "the deploy webhook",
      });
      const b = (body ?? {}) as Record<string, unknown>;
      const id = b.id ?? b.activity_id;
      return {
        id: typeof id === "string" || typeof id === "number" ? String(id) : null,
        status: typeof b.status === "string" ? b.status : null,
        raw: body,
      };
    },

    /** `GET /apps/{deploy key}/activities/{id}`. */
    async checkDeploy(c: DeployConfig, activityId: string): Promise<DeployStatus> {
      const body = await send({
        method: "GET",
        path: `/apps/${encodeURIComponent(c.deployKey)}/activities/${encodeURIComponent(activityId)}`,
        what: `activity ${activityId}`,
      });
      const b = (body ?? {}) as Record<string, unknown>;
      const status = [b.status, b.state, b.result].find((v) => typeof v === "string") as
        | string
        | undefined;
      const output = [b.output, b.logs, b.log].find((v) => typeof v === "string") as
        | string
        | undefined;
      return { id: activityId, status: status ?? "unknown", output: output ?? null, raw: body };
    },
  };
}

export type HatchboxClient = ReturnType<typeof createClient>;
