import {
  billingExportTable,
  ENV,
  requireFor,
  serviceAccountKey,
  type Env,
  type ToolName,
} from "./config.js";
import { accessToken, CALL_BUDGET_MS, monthToDate } from "./gcp.js";
import { deadlineIn, type HttpOptions } from "./http.js";
import { dateRange, getCosts, MAX_RANGE_DAYS } from "./openai.js";
import { getCredits, getKeyUsage } from "./openrouter.js";
import type { Scrubber } from "./scrub.js";

/**
 * Four fixed reads, and nothing that writes or that a caller can aim.
 *
 * No tool takes a URL, a path, a query, a body or a key. Three take no input
 * at all; `get_openai_costs` takes two dates, bounded to
 * {@link MAX_RANGE_DAYS} days. An argument a tool does not declare is refused
 * rather than ignored, so the surface is exactly what `tools/list` says.
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
];
