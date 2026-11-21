/**
 * OpenRouter: two fixed GETs, each with its own key.
 *
 *   GET /api/v1/credits  — a MANAGEMENT key (OpenRouter calls them
 *                          provisioning keys too). Answers
 *                          `{ data: { total_credits, total_usage } }` for the
 *                          whole account. An ordinary key gets 403.
 *   GET /api/v1/key      — any API key, about ITSELF: its usage and limit.
 *
 * The `/key` answer also carries the key's label, creator, organization and
 * workspace identifiers. None of those is a usage figure, and a label is often
 * a masked preview of the key, so only the usage and limit fields are kept.
 *
 * @see https://openrouter.ai/docs/api/api-reference/credits/get-credits
 * @see https://openrouter.ai/docs/api/reference/limits
 */

import { requestJson, type HttpOptions } from "./http.js";

export const OPENROUTER_API = "https://openrouter.ai/api/v1";

function advice(which: "management" | "api") {
  return (status: number): string => {
    if (status === 401) {
      return (
        ` OpenRouter rejected the key: it is invalid, expired or deleted. A human ` +
        `issues a new one in OpenRouter's settings. Retrying will not help.`
      );
    }
    if (status === 403) {
      return which === "management"
        ? " /credits needs a MANAGEMENT key (Settings -> Management keys); an ordinary API key is refused."
        : " The key is not allowed to read itself.";
    }
    if (status === 429) return " Rate limited. Wait before calling again.";
    if (status >= 500) return " OpenRouter is failing on its side; a read is safe to retry shortly.";
    return "";
  };
}

function finite(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Round away float noise from a subtraction of two dollar amounts. */
function money(v: number): number {
  return Math.round(v * 1e8) / 1e8;
}

export async function getCredits(managementKey: string, http: HttpOptions) {
  const body = await requestJson<{ data?: Record<string, unknown> }>(
    {
      what: "OpenRouter (GET /credits)",
      url: `${OPENROUTER_API}/credits`,
      method: "GET",
      headers: { Authorization: `Bearer ${managementKey}` },
      advice: advice("management"),
    },
    http,
  );
  const totalCredits = finite(body.data?.total_credits);
  const totalUsage = finite(body.data?.total_usage);
  return {
    currency: "USD",
    total_credits: totalCredits,
    total_usage: totalUsage,
    remaining: totalCredits !== null && totalUsage !== null ? money(totalCredits - totalUsage) : null,
  };
}

/** The usage and limit fields of `/key`, and nothing that identifies it. */
const KEY_FIELDS = [
  "limit",
  "limit_remaining",
  "limit_reset",
  "include_byok_in_limit",
  "usage",
  "usage_daily",
  "usage_weekly",
  "usage_monthly",
  "byok_usage",
  "byok_usage_daily",
  "byok_usage_weekly",
  "byok_usage_monthly",
  "is_free_tier",
] as const;

export async function getKeyUsage(apiKey: string, http: HttpOptions) {
  const body = await requestJson<{ data?: Record<string, unknown> }>(
    {
      what: "OpenRouter (GET /key)",
      url: `${OPENROUTER_API}/key`,
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
      advice: advice("api"),
    },
    http,
  );
  const data = body.data ?? {};
  const out: Record<string, unknown> = { currency: "USD" };
  for (const field of KEY_FIELDS) {
    const v = data[field];
    if (typeof v === "number" || typeof v === "boolean" || typeof v === "string" || v === null) out[field] = v;
  }
  return out;
}
