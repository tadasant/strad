/**
 * Google Cloud, line by line: one grouped BigQuery query over the same Cloud
 * Billing standard usage cost export `get_gcp_month_to_date` reads, with the
 * same credential.
 *
 * THE QUERY IS ASSEMBLED FROM FIXED FRAGMENTS, NEVER FROM INPUT. `group_by` is
 * an enum, and each value selects a constant fragment from {@link GROUPS};
 * the filters only switch a constant `AND col = @param` clause on. Every value
 * a caller supplies — the two dates, the filter values, the row cap — reaches
 * BigQuery as a bound named parameter, so no caller text is ever part of the
 * SQL. The table is spliced in after the same validation as the month-to-date
 * query (`config.ts`).
 *
 * DAYS ARE PACIFIC TIME, the zone Cloud Billing invoices and the console
 * reports in. The range is filtered on `usage_start_time`, both ends
 * inclusive, at most {@link MAX_BREAKDOWN_DAYS} days.
 *
 * THE RANKING IS IN SQL. Groups are ranked by net (cost + credits) descending
 * and only the top `max_rows` are returned; the number of groups and the
 * per-currency totals over ALL of them are computed by window functions in
 * the same query, so a cut answer still says what it cut. Each currency's
 * top group comes back too even when it ranks below the cap, carrying that
 * currency's totals; it is read for the totals and not returned as a row.
 *
 * NO PARTITION FILTER, for the reason the month-to-date query has none: a
 * standard export's partitioning is not documented as stable, and a filter on
 * a pseudo-column the table lacks is a query that fails. The scan is bounded
 * by the columns named here and by `maximumBytesBilled`, and the answer
 * carries `bytes_processed` so the cost of a call is visible.
 */

import type { BillingExportTable } from "./config.js";
import {
  cells,
  net,
  number,
  queryParameter,
  runQuery,
  text,
  type QueryOptions,
  type QueryParameter,
} from "./gcp.js";

export const MAX_BREAKDOWN_DAYS = 92;
export const DEFAULT_BREAKDOWN_ROWS = 100;
export const MAX_BREAKDOWN_ROWS = 200;
export const BILLING_TIMEZONE = "America/Los_Angeles";

/**
 * The group keys, in the order their columns appear. Each is a fixed set of
 * SELECT expressions and the aliases it groups by. `sku` also sums usage,
 * grouped by its unit, which is constant per SKU and so costs no extra row.
 */
export const GROUPS = {
  project: { select: ["IFNULL(project.id, '(none)') AS project_id"], keys: ["project_id"] },
  service: { select: ["IFNULL(service.description, '(none)') AS service"], keys: ["service"] },
  sku: {
    select: ["sku.id AS sku_id", "IFNULL(sku.description, '(none)') AS sku", "usage.unit AS usage_unit"],
    keys: ["sku_id", "sku", "usage_unit"],
  },
  day: {
    select: [`FORMAT_DATE('%Y-%m-%d', DATE(usage_start_time, '${BILLING_TIMEZONE}')) AS usage_date`],
    keys: ["usage_date"],
  },
} as const;

export type GroupKey = keyof typeof GROUPS;
export const GROUP_KEYS = Object.keys(GROUPS) as GroupKey[];

/**
 * Equality filters, each a fixed expression compared with one bound
 * parameter. Each compares the SAME expression a row shows, so a `(none)`
 * read off a row filters to exactly those rows.
 */
export const FILTERS = {
  project_id: "IFNULL(project.id, '(none)') = @project_id",
  service: "IFNULL(service.description, '(none)') = @service",
  sku_id: "sku.id = @sku_id",
  sku: "IFNULL(sku.description, '(none)') = @sku",
} as const;

export type FilterName = keyof typeof FILTERS;
export const FILTER_NAMES = Object.keys(FILTERS) as FilterName[];

export interface BreakdownRequest {
  startDate: string;
  endDate: string;
  /** De-duplicated, in {@link GROUP_KEYS} order. */
  groupBy: GroupKey[];
  filters: Partial<Record<FilterName, string>>;
  maxRows: number;
}

/** The SQL for a request. Only `groupBy` and WHICH filters are set shape it. */
export function breakdownQuery(t: BillingExportTable, groupBy: readonly GroupKey[], filters: readonly FilterName[]): string {
  const ordered = GROUP_KEYS.filter((k) => groupBy.includes(k));
  const select = ordered.flatMap((k) => [...GROUPS[k].select]);
  const keys = ordered.flatMap((k) => [...GROUPS[k].keys]);
  const where = [
    `usage_start_time >= TIMESTAMP(@start_date, '${BILLING_TIMEZONE}')`,
    `usage_start_time < TIMESTAMP(DATE_ADD(@end_date, INTERVAL 1 DAY), '${BILLING_TIMEZONE}')`,
    ...FILTER_NAMES.filter((f) => filters.includes(f)).map((f) => FILTERS[f]),
  ];
  const usage = ordered.includes("sku") ? ["  SUM(usage.amount) AS usage_amount,"] : [];
  return [
    "WITH grouped AS (",
    "SELECT",
    ...select.map((s) => `  ${s},`),
    "  currency,",
    "  SUM(cost) AS cost,",
    "  SUM(IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) AS c), 0)) AS credits,",
    ...usage,
    "  MAX(usage_end_time) AS latest_usage_end_time",
    `FROM \`${t.project}.${t.dataset}.${t.table}\``,
    `WHERE ${where.join("\n  AND ")}`,
    // By ordinal: `service` and `sku` are also STRUCT columns of the export,
    // so grouping by those aliases would be ambiguous.
    `GROUP BY ${[...select, "currency"].map((_, i) => i + 1).join(", ")}`,
    "), ranked AS (",
    "SELECT",
    "  *,",
    `  ROW_NUMBER() OVER (ORDER BY cost + credits DESC, ${[...keys, "currency"].join(", ")}) AS row_rank,`,
    `  ROW_NUMBER() OVER (PARTITION BY currency ORDER BY cost + credits DESC, ${keys.join(", ")}) AS currency_rank,`,
    "  COUNT(*) OVER () AS group_count,",
    "  SUM(cost) OVER (PARTITION BY currency) AS currency_cost,",
    "  SUM(credits) OVER (PARTITION BY currency) AS currency_credits,",
    "  MAX(latest_usage_end_time) OVER () AS range_latest_usage_end_time",
    "FROM grouped",
    ")",
    "SELECT",
    ...keys.map((k) => `  ${k},`),
    "  currency, cost, credits,",
    ...(ordered.includes("sku") ? ["  usage_amount,"] : []),
    "  row_rank, group_count, currency_cost, currency_credits,",
    "  FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%SZ', range_latest_usage_end_time, 'UTC') AS range_latest_usage_end_time",
    "FROM ranked",
    "WHERE row_rank <= @max_rows OR currency_rank = 1",
    "ORDER BY row_rank",
  ].join("\n");
}

export function breakdownParameters(req: BreakdownRequest): QueryParameter[] {
  return [
    queryParameter("start_date", "DATE", req.startDate),
    queryParameter("end_date", "DATE", req.endDate),
    queryParameter("max_rows", "INT64", String(req.maxRows)),
    ...FILTER_NAMES.filter((f) => req.filters[f] !== undefined).map((f) => queryParameter(f, "STRING", req.filters[f]!)),
  ];
}

/** Today's date in Pacific Time, YYYY-MM-DD. */
export function billingToday(now: Date): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: BILLING_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function dayNumber(date: string, name: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new RangeError(`\`${name}\` must be a date as YYYY-MM-DD, e.g. 2026-11-01.`);
  }
  const ms = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== date) {
    throw new RangeError(`\`${name}\` is not a real date: ${date}.`);
  }
  return ms / 86_400_000;
}

/**
 * Two Pacific-Time dates, inclusive. At most {@link MAX_BREAKDOWN_DAYS} days,
 * and the range may not begin after today (Pacific).
 */
export function breakdownRange(start: string, end: string, now: Date): { startDate: string; endDate: string; days: number } {
  const s = dayNumber(start, "start_date");
  const e = dayNumber(end, "end_date");
  if (s > dayNumber(billingToday(now), "today")) {
    throw new RangeError("`start_date` is in the future (Pacific Time).");
  }
  if (e < s) throw new RangeError("`end_date` is before `start_date`.");
  const days = e - s + 1;
  if (days > MAX_BREAKDOWN_DAYS) {
    throw new RangeError(`The range is ${days} days; at most ${MAX_BREAKDOWN_DAYS} are allowed per call.`);
  }
  return { startDate: start, endDate: end, days };
}

/**
 * A quantity, not money: usage in byte-seconds and bytes scanned run past
 * 1e15, where {@link number}'s rounding to 1e-8 would itself lose precision.
 */
function quantity(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

const KEY_FIELDS: Record<GroupKey, readonly string[]> = {
  project: ["project_id"],
  service: ["service"],
  sku: ["sku_id", "sku"],
  day: ["usage_date"],
};

export async function costBreakdown(table: BillingExportTable, req: BreakdownRequest, options: QueryOptions) {
  const filters = FILTER_NAMES.filter((f) => req.filters[f] !== undefined);
  const response = await runQuery(
    table,
    breakdownQuery(table, req.groupBy, filters),
    breakdownParameters(req),
    "cost breakdown",
    options,
  );
  const raw = cells(response);
  const sku = req.groupBy.includes("sku");
  const totals = new Map<string, { cost: number | null; credits: number | null }>();
  let groups = 0;
  let latest: string | null = null;

  const rows: Array<Record<string, unknown>> = [];
  for (const cell of raw) {
    const currency = text(cell.currency);
    const cost = number(cell.cost);
    const credits = number(cell.credits);
    groups = Math.max(groups, quantity(cell.group_count) ?? 0);
    latest = text(cell.range_latest_usage_end_time) ?? latest;
    if (currency !== null && !totals.has(currency)) {
      totals.set(currency, { cost: number(cell.currency_cost), credits: number(cell.currency_credits) });
    }
    // A currency's top group past the cap is here only for its totals.
    if ((quantity(cell.row_rank) ?? 0) > req.maxRows) continue;
    const row: Record<string, unknown> = {};
    for (const k of GROUP_KEYS) {
      if (!req.groupBy.includes(k)) continue;
      for (const field of KEY_FIELDS[k]) row[field] = text(cell[field]);
    }
    if (sku) {
      row.usage_amount = quantity(cell.usage_amount);
      row.usage_unit = text(cell.usage_unit);
    }
    row.currency = currency;
    row.cost = cost;
    row.credits = credits;
    row.net = net(cost, credits);
    rows.push(row);
  }

  const truncated = groups > rows.length;
  const bytes = quantity(response.totalBytesProcessed);
  return {
    start_date: req.startDate,
    end_date: req.endDate,
    timezone: BILLING_TIMEZONE,
    group_by: req.groupBy,
    ...(filters.length > 0 ? { filters: Object.fromEntries(filters.map((f) => [f, req.filters[f]])) } : {}),
    groups,
    returned: rows.length,
    truncated,
    totals: [...totals]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([currency, t]) => ({ currency, cost: t.cost, credits: t.credits, net: net(t.cost, t.credits) })),
    latest_usage_end_time: latest,
    bytes_processed: bytes,
    rows,
    ...(rows.length === 0
      ? { note: "The export has no rows for this range and these filters." }
      : truncated
        ? {
            note:
              `Showing the top ${rows.length} of ${groups} groups by net. totals cover all ${groups}. ` +
              "Narrow the range, add a filter, or group by fewer keys to see the rest.",
          }
        : {}),
  };
}
