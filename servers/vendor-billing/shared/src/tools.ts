import {
  billingExportTable,
  ENV,
  requireFor,
  serviceAccountKey,
  type Env,
  type ToolName,
} from "./config.js";
import { accessToken, CALL_BUDGET_MS, monthToDate } from "./gcp.js";
import {
  billingToday,
  breakdownRange,
  costBreakdown,
  DEFAULT_BREAKDOWN_ROWS,
  FILTER_NAMES,
  GROUP_KEYS,
  MAX_BREAKDOWN_DAYS,
  MAX_BREAKDOWN_ROWS,
  type FilterName,
  type GroupKey,
} from "./gcp-breakdown.js";
import { deadlineIn, type HttpOptions } from "./http.js";
import { dateRange, getCosts, MAX_RANGE_DAYS } from "./openai.js";
import { getCredits, getKeyUsage } from "./openrouter.js";
import type { Scrubber } from "./scrub.js";

/**
 * Five fixed reads, and nothing that writes or that a caller can aim.
 *
 * No tool takes a URL, a path, a query, a body or a key. Three take no input
 * at all; `get_openai_costs` takes two dates, bounded to
 * {@link MAX_RANGE_DAYS} days; `get_gcp_cost_breakdown` takes two dates, a
 * `group_by` drawn from an enum, equality filters and a row cap, every one of
 * them a bound BigQuery parameter or a choice among fixed SQL fragments. An
 * argument a tool does not declare is refused rather than ignored, so the
 * surface is exactly what `tools/list` says.
 */

export interface ToolContext {
  env: Env;
  http: HttpOptions;
  scrub: Scrubber;
  now: () => Date;
}

export interface ToolDefinition {
  name: ToolName;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties: false;
  };
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;
}

export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputError";
  }
}

function onlyArgs(args: Record<string, unknown>, allowed: readonly string[]): void {
  const extra = Object.keys(args).filter((k) => !allowed.includes(k));
  if (extra.length > 0) {
    throw new InputError(
      `Unexpected argument${extra.length === 1 ? "" : "s"}: ${extra.join(", ")}. ` +
        (allowed.length === 0 ? "This tool takes none." : `This tool takes only ${allowed.join(", ")}.`),
    );
  }
}

function dateArg(args: Record<string, unknown>, name: string): string | undefined {
  const v = args[name];
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string") throw new InputError(`\`${name}\` must be a string, YYYY-MM-DD.`);
  return v;
}

const MAX_FILTER_CHARS = 256;

function groupByArg(args: Record<string, unknown>): GroupKey[] {
  const v = args.group_by;
  if (v === undefined || v === null) return ["service"];
  const list = typeof v === "string" ? [v] : v;
  if (!Array.isArray(list) || list.length === 0) {
    throw new InputError(`\`group_by\` must be a non-empty list drawn from ${GROUP_KEYS.join(", ")}.`);
  }
  const bad = list.filter((k) => typeof k !== "string" || !(GROUP_KEYS as string[]).includes(k));
  if (bad.length > 0) {
    throw new InputError(
      `\`group_by\` takes only ${GROUP_KEYS.join(", ")}; got ${bad.map((b) => JSON.stringify(b)).join(", ")}.`,
    );
  }
  // Fixed column order whatever order the caller gave, duplicates dropped.
  return GROUP_KEYS.filter((k) => list.includes(k));
}

function filterArgs(args: Record<string, unknown>): Partial<Record<FilterName, string>> {
  const out: Partial<Record<FilterName, string>> = {};
  for (const name of FILTER_NAMES) {
    const v = args[name];
    if (v === undefined || v === null || v === "") continue;
    if (typeof v !== "string") throw new InputError(`\`${name}\` must be a string.`);
    if (v.length > MAX_FILTER_CHARS) throw new InputError(`\`${name}\` is longer than ${MAX_FILTER_CHARS} characters.`);
    out[name] = v;
  }
  return out;
}

function maxRowsArg(args: Record<string, unknown>): number {
  const v = args.max_rows;
  if (v === undefined || v === null) return DEFAULT_BREAKDOWN_ROWS;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > MAX_BREAKDOWN_ROWS) {
    throw new InputError(`\`max_rows\` must be a whole number from 1 to ${MAX_BREAKDOWN_ROWS}.`);
  }
  return v;
}

const DATE_PATTERN = "^\\d{4}-\\d{2}-\\d{2}$";

const NO_INPUT = { type: "object" as const, properties: {}, additionalProperties: false as const };

export const TOOLS: readonly ToolDefinition[] = [
  {
    name: "get_openrouter_credits",
    description:
      "OpenRouter account balance: total credits ever purchased, total ever used, and the " +
      "remaining prepaid balance (purchased minus used), in USD. Account-wide, across every key. " +
      "Takes no input.\n\n" +
      'Example: {"currency":"USD","total_credits":100.5,"total_usage":25.75,"remaining":74.75}\n\n' +
      "Use get_openrouter_key_usage for one key's own usage and limit instead.",
    inputSchema: NO_INPUT,
    handler: async (args, ctx) => {
      onlyArgs(args, []);
      const vars = requireFor("get_openrouter_credits", ctx.env);
      return getCredits(vars[ENV.openrouterManagementKey]!, ctx.http);
    },
  },
  {
    name: "get_openrouter_key_usage",
    description:
      "Usage and spending limit of the one OpenRouter API key this deployment holds: credits used " +
      "all-time, today, this week and this month (UTC), the same for bring-your-own-key usage, and " +
      "the key's limit, remaining limit and reset interval (null means no limit). USD. Takes no input.\n\n" +
      'Example: {"currency":"USD","limit":50,"limit_remaining":38.2,"limit_reset":"monthly",' +
      '"usage":120.4,"usage_daily":0.9,"usage_weekly":4.1,"usage_monthly":11.8,...}\n\n' +
      "Use get_openrouter_credits for the account's prepaid balance.",
    inputSchema: NO_INPUT,
    handler: async (args, ctx) => {
      onlyArgs(args, []);
      const vars = requireFor("get_openrouter_key_usage", ctx.env);
      return getKeyUsage(vars[ENV.openrouterApiKey]!, ctx.http);
    },
  },
  {
    name: "get_openai_costs",
    description:
      "OpenAI organization costs per day (UTC) and per project, from the Costs API with daily " +
      `buckets. Dates are inclusive and the range is at most ${MAX_RANGE_DAYS} days. All pages are ` +
      "read. Days with no spend may appear with an empty project list. `(none)` is cost OpenAI " +
      "attributes to no project.\n\n" +
      'Example: {"start_date":"2026-11-01","end_date":"2026-11-02","totals":[{"currency":"usd",' +
      '"amount":3.21}],"days":[{"date":"2026-11-01","projects":[{"project_id":"proj_…",' +
      '"amount":2.5,"currency":"usd"}]}],...}\n\n' +
      "Today's bucket is still filling, and OpenAI's figures can lag by hours.",
    inputSchema: {
      type: "object",
      properties: {
        start_date: {
          type: "string",
          pattern: "^\\d{4}-\\d{2}-\\d{2}$",
          description: "First day, YYYY-MM-DD (UTC), e.g. 2026-11-01.",
        },
        end_date: {
          type: "string",
          pattern: "^\\d{4}-\\d{2}-\\d{2}$",
          description: `Last day, inclusive, YYYY-MM-DD (UTC). Defaults to start_date. The range, both ends included, is at most ${MAX_RANGE_DAYS} days.`,
        },
      },
      required: ["start_date"],
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      onlyArgs(args, ["start_date", "end_date"]);
      const start = dateArg(args, "start_date");
      if (!start) throw new InputError("`start_date` is required, YYYY-MM-DD.");
      const end = dateArg(args, "end_date") ?? start;
      let range;
      try {
        range = dateRange(start, end, ctx.now());
      } catch (error) {
        throw new InputError(error instanceof Error ? error.message : String(error));
      }
      const vars = requireFor("get_openai_costs", ctx.env);
      return getCosts(vars[ENV.openaiAdminKey]!, range, ctx.http);
    },
  },
  {
    name: "get_gcp_month_to_date",
    description:
      "Google Cloud spend for the current invoice month (Pacific Time) from this deployment's " +
      "Cloud Billing BigQuery export: summed cost, summed credits (negative), net (cost + credits), " +
      "the currency, and latest_usage_end_time, the end of the newest usage hour the export holds, " +
      "which says how fresh the figures are (the export lags usage by hours). One row per " +
      "currency. Takes no input.\n\n" +
      'Example: {"invoice_month_timezone":"America/Los_Angeles","rows":[{"invoice_month":"202611",' +
      '"currency":"USD","cost":41.2,"credits":-3.1,"net":38.1,' +
      '"latest_usage_end_time":"2026-11-20T18:00:00Z"}]}',
    inputSchema: NO_INPUT,
    handler: async (args, ctx) => {
      onlyArgs(args, []);
      const vars = requireFor("get_gcp_month_to_date", ctx.env);
      const table = billingExportTable(vars);
      const key = serviceAccountKey(vars[ENV.gcpServiceAccountKey]!);
      const http = deadlineIn(CALL_BUDGET_MS, ctx.http);
      const token = await accessToken(key, http, ctx.scrub);
      ctx.scrub.add(token);
      return monthToDate(table, { ...http, token });
    },
  },
  {
    name: "get_gcp_cost_breakdown",
    description:
      "Google Cloud cost line by line, from the same Cloud Billing BigQuery export as " +
      "get_gcp_month_to_date: cost, credits (negative) and net (cost + credits) summed per group " +
      "over a date range, ranked by net, highest first. Group by any combination of project " +
      "(project_id; `(none)` is account-level cost such as support or tax), service " +
      "(e.g. \"Secret Manager\"), sku (sku_id, sku, and summed usage_amount in usage_unit) and day " +
      "(usage_date). Days are Pacific Time, both ends inclusive, at most " +
      `${MAX_BREAKDOWN_DAYS} days. Optional exact-match filters on project_id, service and sku. ` +
      `Returns the top max_rows groups (default ${DEFAULT_BREAKDOWN_ROWS}); \`groups\`, ` +
      "`truncated` and `totals` (per currency, over every group) say what a cut left out. " +
      "`bytes_processed` is what the query scanned.\n\n" +
      "To find what grew: group_by [service, sku] over two equal periods and compare, then " +
      "group_by [day] filtered to that sku to see when it started.\n\n" +
      'Example: {"start_date":"2026-11-01","end_date":"2026-11-27","timezone":"America/Los_Angeles",' +
      '"group_by":["service","sku"],"groups":42,"returned":42,"truncated":false,' +
      '"totals":[{"currency":"USD","cost":80.1,"credits":-2,"net":78.1}],' +
      '"latest_usage_end_time":"2026-11-27T18:00:00Z","bytes_processed":10485760,' +
      '"rows":[{"service":"Secret Manager","sku_id":"6D5B-…","sku":"Secret access operations",' +
      '"usage_amount":2400000,"usage_unit":"requests","currency":"USD","cost":7.2,"credits":0,' +
      '"net":7.2},...]}\n\n' +
      "The export lags usage by hours, and late rows can still change recent days.",
    inputSchema: {
      type: "object",
      properties: {
        start_date: {
          type: "string",
          pattern: DATE_PATTERN,
          description: "First day, YYYY-MM-DD (Pacific Time), e.g. 2026-11-01.",
        },
        end_date: {
          type: "string",
          pattern: DATE_PATTERN,
          description:
            "Last day, inclusive, YYYY-MM-DD (Pacific Time). Defaults to today (Pacific). The range, " +
            `both ends included, is at most ${MAX_BREAKDOWN_DAYS} days.`,
        },
        group_by: {
          type: "array",
          items: { type: "string", enum: [...GROUP_KEYS] },
          minItems: 1,
          uniqueItems: true,
          description:
            "What each row is: any combination of project, service, sku, day. Defaults to [service]. " +
            "e.g. [service, sku] for which line costs most, [sku, day] or [day] for a trend.",
        },
        project_id: {
          type: "string",
          maxLength: MAX_FILTER_CHARS,
          description: "Only this project ID, exact match, e.g. my-project-123.",
        },
        service: {
          type: "string",
          maxLength: MAX_FILTER_CHARS,
          description: "Only this service, exact match on its description, e.g. Cloud SQL.",
        },
        sku: {
          type: "string",
          maxLength: MAX_FILTER_CHARS,
          description: "Only this SKU, exact match on its description as a row's `sku` shows it.",
        },
        max_rows: {
          type: "integer",
          minimum: 1,
          maximum: MAX_BREAKDOWN_ROWS,
          description: `How many groups to return, highest net first. Default ${DEFAULT_BREAKDOWN_ROWS}, at most ${MAX_BREAKDOWN_ROWS}.`,
        },
      },
      required: ["start_date"],
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      onlyArgs(args, ["start_date", "end_date", "group_by", ...FILTER_NAMES, "max_rows"]);
      const start = dateArg(args, "start_date");
      if (!start) throw new InputError("`start_date` is required, YYYY-MM-DD.");
      const end = dateArg(args, "end_date") ?? billingToday(ctx.now());
      let range;
      try {
        range = breakdownRange(start, end, ctx.now());
      } catch (error) {
        throw new InputError(error instanceof Error ? error.message : String(error));
      }
      const groupBy = groupByArg(args);
      const filters = filterArgs(args);
      const maxRows = maxRowsArg(args);
      const vars = requireFor("get_gcp_cost_breakdown", ctx.env);
      const table = billingExportTable(vars, "get_gcp_cost_breakdown");
      const key = serviceAccountKey(vars[ENV.gcpServiceAccountKey]!);
      const http = deadlineIn(CALL_BUDGET_MS, ctx.http);
      const token = await accessToken(key, http, ctx.scrub);
      ctx.scrub.add(token);
      return costBreakdown(
        table,
        { startDate: range.startDate, endDate: range.endDate, groupBy, filters, maxRows },
        { ...http, token },
      );
    },
  },
];
