/**
 * OpenAI: `GET /v1/organization/costs`, per day and per project, with an
 * ADMIN key (the deployed one restricted to Usage API read).
 *
 * THE REQUEST IS FIXED. `bucket_width=1d` and `group_by=project_id` always;
 * the only inputs are the two dates, which become `start_time` (inclusive)
 * and `end_time` (exclusive) in Unix seconds at UTC midnight. `limit` is the
 * number of DAY BUCKETS a page holds, set to the range's own length so a
 * range is normally one page.
 *
 * PAGINATION is walked here, to the end: `has_more` and `next_page` out,
 * `page` back in. A walk is bounded by {@link MAX_PAGES}; a range is at most
 * {@link MAX_RANGE_DAYS} days, so a walk that long is an API misbehaving, and
 * it is reported rather than looped on.
 *
 * @see https://developers.openai.com/api/reference/resources/organization/subresources/audit_logs/subresources/usage
 */

import { deadlineIn, requestJson, UpstreamError, type HttpOptions } from "./http.js";

export const OPENAI_API = "https://api.openai.com/v1";
export const MAX_RANGE_DAYS = 31;
export const MAX_PAGES = 20;

/** The whole walk, every page included. Under the gateway's 120 s tool-call default. */
export const WALK_BUDGET_MS = 90_000;

const DAY_SECONDS = 86_400;

export interface DateRange {
  /** Unix seconds, UTC midnight of the first day. */
  startTime: number;
  /** Unix seconds, UTC midnight AFTER the last day: exclusive. */
  endTime: number;
  days: number;
}

interface CostResult {
  amount?: { value?: unknown; currency?: unknown };
  project_id?: unknown;
}

interface CostsPage {
  data?: Array<{ start_time?: unknown; results?: CostResult[] }>;
  has_more?: unknown;
  next_page?: unknown;
}

function advice(status: number): string {
  switch (status) {
    case 401:
      return (
        " OpenAI rejected the key: it is invalid or revoked, or it is not an " +
        "ADMIN key (Organization settings -> Admin keys). Retrying will not help."
      );
    case 403:
      return " The admin key may not read costs: it needs read access to the Usage API.";
    case 429:
      return " Rate limited. Wait before calling again.";
    default:
      return status >= 500 ? " OpenAI is failing on its side; a read is safe to retry shortly." : "";
  }
}

/** Sum dollar amounts without carrying float noise into the answer. */
function money(v: number): number {
  return Math.round(v * 1e8) / 1e8;
}

function isoDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

export async function getCosts(adminKey: string, range: DateRange, httpOptions: HttpOptions) {
  const http = deadlineIn(WALK_BUDGET_MS, httpOptions);
  const days = new Map<string, Map<string, { amount: number; currency: string }>>();
  const totals = new Map<string, number>();
  let page: string | undefined;
  let pages = 0;

  for (;;) {
    if (pages >= MAX_PAGES) {
      throw new UpstreamError(
        `OpenAI kept answering has_more after ${MAX_PAGES} pages for a ${range.days}-day range; ` +
          `stopped rather than loop. Ask for a shorter range.`,
        0,
      );
    }
    const url = new URL(`${OPENAI_API}/organization/costs`);
    url.searchParams.set("start_time", String(range.startTime));
    url.searchParams.set("end_time", String(range.endTime));
    url.searchParams.set("bucket_width", "1d");
    url.searchParams.set("group_by", "project_id");
    url.searchParams.set("limit", String(range.days));
    if (page) url.searchParams.set("page", page);

    const body = await requestJson<CostsPage>(
      {
        what: "OpenAI (GET /v1/organization/costs)",
        url: url.toString(),
        method: "GET",
        headers: { Authorization: `Bearer ${adminKey}` },
        advice,
      },
      http,
    );
    pages++;

    for (const bucket of body.data ?? []) {
      if (typeof bucket.start_time !== "number") continue;
      const date = isoDate(bucket.start_time);
      const projects = days.get(date) ?? new Map();
      days.set(date, projects);
      for (const r of bucket.results ?? []) {
        const v = r.amount?.value;
        const amount = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
        if (!Number.isFinite(amount)) continue;
        const currency = typeof r.amount?.currency === "string" ? r.amount.currency.toLowerCase() : "usd";
        const project = typeof r.project_id === "string" ? r.project_id : "(none)";
        const key = `${project}\u0000${currency}`;
        const prior = projects.get(key);
        projects.set(key, { amount: (prior?.amount ?? 0) + amount, currency });
        totals.set(currency, (totals.get(currency) ?? 0) + amount);
      }
    }

    const next = typeof body.next_page === "string" && body.next_page ? body.next_page : undefined;
    if (body.has_more !== true || !next) break;
    page = next;
  }

  return {
    start_date: isoDate(range.startTime),
    end_date: isoDate(range.endTime - DAY_SECONDS),
    bucket_width: "1d",
    group_by: "project_id",
    pages,
    totals: [...totals].sort().map(([currency, amount]) => ({ currency, amount: money(amount) })),
    days: [...days]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, projects]) => ({
        date,
        projects: [...projects]
          .map(([key, p]) => ({ project_id: key.split("\u0000")[0], amount: money(p.amount), currency: p.currency }))
          .sort((a, b) => b.amount - a.amount),
      })),
  };
}

/**
 * Two `YYYY-MM-DD` dates, inclusive, into the API's range. The whole range is
 * at most {@link MAX_RANGE_DAYS} days and may not begin in the future.
 */
export function dateRange(start: string, end: string, now: Date = new Date()): DateRange {
  const startTime = utcMidnight(start, "start_date");
  const endDay = utcMidnight(end, "end_date");
  if (endDay < startTime) throw new RangeError("`end_date` is before `start_date`.");
  const days = (endDay - startTime) / DAY_SECONDS + 1;
  if (days > MAX_RANGE_DAYS) {
    throw new RangeError(`The range is ${days} days; at most ${MAX_RANGE_DAYS} are allowed per call.`);
  }
  const today = Math.floor(now.getTime() / 1000 / DAY_SECONDS) * DAY_SECONDS;
  if (startTime > today) throw new RangeError("`start_date` is in the future (UTC).");
  return { startTime, endTime: endDay + DAY_SECONDS, days };
}

function utcMidnight(date: string, name: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new RangeError(`\`${name}\` must be a date as YYYY-MM-DD, e.g. 2026-11-01.`);
  }
  const ms = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== date) {
    throw new RangeError(`\`${name}\` is not a real date: ${date}.`);
  }
  return ms / 1000;
}
