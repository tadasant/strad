import { createVerify, generateKeyPairSync } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  BIGQUERY_API,
  BIGQUERY_SCOPE,
  billingExportTable,
  createMCPServer,
  createScrubber,
  dateRange,
  GOOGLE_TOKEN_URL,
  MAX_PAGES,
  MAX_POLLS,
  missingCredentials,
  monthToDateQuery,
  breakdownQuery,
  MAX_BREAKDOWN_DAYS,
  OPENAI_API,
  OPENROUTER_API,
  TOOL_NAMES,
} from "../build/index.js";

// ---- fixtures ---------------------------------------------------------------

const MGMT_KEY = "sk-or-v1-management-0123456789abcdef0123456789abcdef";
const PI_KEY = "sk-or-v1-apikey-fedcba9876543210fedcba9876543210";
const ADMIN_KEY = "sk-admin-0123456789ABCDEFGHIJKLMNOPQRSTUV";
const ACCESS_TOKEN = "ya29.fake-access-token-abcdefghijklmnop";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const SA_KEY = JSON.stringify({
  type: "service_account",
  project_id: "example-project",
  private_key_id: "0123456789abcdef0123456789abcdef01234567",
  private_key: PEM,
  client_email: "test-service-account.invalid",
  token_uri: "https://attacker.invalid/token",
});

const GCP_ENV = {
  GCP_BILLING_SA_KEY_JSON: SA_KEY,
  GCP_BILLING_EXPORT_PROJECT: "example-project",
  GCP_BILLING_EXPORT_DATASET: "billing_export",
  GCP_BILLING_EXPORT_TABLE: "gcp_billing_export_v1_EXAMPLE",
};

const FULL_ENV = {
  OPENROUTER_MANAGEMENT_KEY: MGMT_KEY,
  OPENROUTER_PI_API_KEY: PI_KEY,
  OPENAI_ADMIN_KEY: ADMIN_KEY,
  ...GCP_ENV,
};

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  redirect?: string;
}

type Route = (req: Seen) => { status?: number; body: unknown } | undefined;

function fakeFetch(route: Route) {
  const seen: Seen[] = [];
  const impl = (async (input: string | URL, init: RequestInit = {}) => {
    const req: Seen = {
      url: String(input),
      method: init.method ?? "GET",
      headers: Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>)),
      ...(typeof init.body === "string" ? { body: init.body } : {}),
      ...(init.redirect ? { redirect: init.redirect } : {}),
    };
    seen.push(req);
    const answer = route(req);
    if (!answer) return new Response(JSON.stringify({ error: { message: "no route" } }), { status: 599 });
    return new Response(typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body), {
      status: answer.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { impl, seen };
}

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

async function harness(env: Record<string, string>, route: Route, now = new Date("2026-11-21T12:00:00Z")) {
  const { impl, seen } = fakeFetch(route);
  const created = createMCPServer({ version: "test", env, fetch: impl, now: () => now });
  const handlers = new Map<unknown, (req: never) => unknown>();
  await created.registerHandlers({
    setRequestHandler: (schema: unknown, handler: (req: never) => unknown) => handlers.set(schema, handler),
  });
  const [listHandler, callHandler] = [...handlers.values()];
  return {
    seen,
    created,
    list: async () => (await listHandler!({} as never)) as { tools: Array<{ name: string; inputSchema: unknown; annotations: Record<string, boolean> }> },
    call: async (name: string, args: Record<string, unknown> = {}) =>
      (await callHandler!({ params: { name, arguments: args } } as never)) as ToolResult,
  };
}

function json(result: ToolResult): Record<string, unknown> {
  expect(result.isError).toBeFalsy();
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

const SECRETS = [MGMT_KEY, PI_KEY, ADMIN_KEY, ACCESS_TOKEN, "0123456789abcdef0123456789abcdef01234567"];

function expectNoSecret(text: string) {
  for (const s of SECRETS) expect(text).not.toContain(s);
  expect(text).not.toContain("PRIVATE KEY");
  for (const line of PEM.split("\n").filter((l) => l && !l.startsWith("-----"))) {
    expect(text).not.toContain(line);
  }
}

// ---- the surface ------------------------------------------------------------

describe("the surface", () => {
  it("lists five read-only tools with nothing configured", async () => {
    const h = await harness({}, () => undefined);
    const { tools } = await h.list();
    expect(tools.map((t) => t.name)).toEqual([...TOOL_NAMES]);
    for (const t of tools) {
      expect(t.annotations.readOnlyHint).toBe(true);
      expect(t.annotations.destructiveHint).toBe(false);
      expect((t.inputSchema as { additionalProperties: boolean }).additionalProperties).toBe(false);
    }
    expect(h.seen).toHaveLength(0);
  });

  it("takes no free-form input: only the two dated tools have properties", async () => {
    const h = await harness({}, () => undefined);
    const { tools } = await h.list();
    const props = Object.fromEntries(
      tools.map((t) => [t.name, Object.keys((t.inputSchema as { properties: object }).properties)]),
    );
    expect(props).toEqual({
      get_openrouter_credits: [],
      get_openrouter_key_usage: [],
      get_openai_costs: ["start_date", "end_date"],
      get_gcp_month_to_date: [],
      get_gcp_cost_breakdown: ["start_date", "end_date", "group_by", "project_id", "service", "sku_id", "sku", "max_rows"],
    });
  });

  it("gives get_gcp_cost_breakdown's group_by a closed enum and no string that is SQL", async () => {
    const h = await harness({}, () => undefined);
    const { tools } = await h.list();
    const schema = tools.find((t) => t.name === "get_gcp_cost_breakdown")!.inputSchema as {
      properties: Record<string, { type: string; enum?: string[]; items?: { enum: string[] }; maxLength?: number }>;
    };
    expect(schema.properties.group_by!.items!.enum).toEqual(["project", "service", "sku", "day"]);
    for (const f of ["project_id", "service", "sku_id", "sku"]) expect(schema.properties[f]!.maxLength).toBe(256);
    expect(schema.properties.max_rows!.type).toBe("integer");
  });

  it("refuses an argument a tool does not declare, before any request", async () => {
    const h = await harness(FULL_ENV, () => undefined);
    const r = await h.call("get_openrouter_credits", { url: "https://evil.invalid" });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/Unexpected argument: url/);
    const q = await h.call("get_gcp_month_to_date", { query: "DROP TABLE x" });
    expect(q.isError).toBe(true);
    const b = await h.call("get_gcp_cost_breakdown", { start_date: "2026-11-01", where: "1=1" });
    expect(b.isError).toBe(true);
    expect(b.content[0]!.text).toMatch(/Unexpected argument: where/);
    expect(h.seen).toHaveLength(0);
  });

  it("reports the mount unconfigured only when NO tool is configured", () => {
    expect(missingCredentials({})).toEqual([
      "OPENROUTER_MANAGEMENT_KEY",
      "OPENROUTER_PI_API_KEY",
      "OPENAI_ADMIN_KEY",
      "GCP_BILLING_SA_KEY_JSON",
      "GCP_BILLING_EXPORT_PROJECT",
      "GCP_BILLING_EXPORT_DATASET",
      "GCP_BILLING_EXPORT_TABLE",
    ]);
    expect(missingCredentials({ OPENAI_ADMIN_KEY: ADMIN_KEY })).toEqual([]);
    // A half-configured GCP tool configures nothing.
    expect(missingCredentials({ GCP_BILLING_SA_KEY_JSON: SA_KEY })).toHaveLength(6);
  });
});

// ---- not configured ---------------------------------------------------------

describe("not configured", () => {
  const cases: Array<[string, Record<string, string>, string[]]> = [
    ["get_openrouter_credits", {}, ["OPENROUTER_MANAGEMENT_KEY"]],
    ["get_openrouter_key_usage", {}, ["OPENROUTER_PI_API_KEY"]],
    ["get_openai_costs", { start_date: "2026-11-01" }, ["OPENAI_ADMIN_KEY"]],
    [
      "get_gcp_month_to_date",
      {},
      ["GCP_BILLING_SA_KEY_JSON", "GCP_BILLING_EXPORT_PROJECT", "GCP_BILLING_EXPORT_DATASET", "GCP_BILLING_EXPORT_TABLE"],
    ],
    [
      "get_gcp_cost_breakdown",
      { start_date: "2026-11-01" },
      ["GCP_BILLING_SA_KEY_JSON", "GCP_BILLING_EXPORT_PROJECT", "GCP_BILLING_EXPORT_DATASET", "GCP_BILLING_EXPORT_TABLE"],
    ],
  ];

  for (const [tool, args, names] of cases) {
    it(`${tool} names exactly what it lacks, and the other tools still work`, async () => {
      // Every OTHER tool's variables set, this one's absent.
      const env: Record<string, string> = { ...FULL_ENV };
      for (const n of names) delete env[n];
      const h = await harness(env, (req) => {
        if (req.url === `${OPENROUTER_API}/credits`) return { body: { data: { total_credits: 1, total_usage: 0 } } };
        if (req.url === `${OPENROUTER_API}/key`) return { body: { data: { usage: 0 } } };
        if (req.url.startsWith(`${OPENAI_API}/organization/costs`)) return { body: { data: [], has_more: false } };
        if (req.url === GOOGLE_TOKEN_URL) return { body: { access_token: ACCESS_TOKEN } };
        if (req.url.startsWith(BIGQUERY_API)) return { body: { jobComplete: true, schema: { fields: [] }, rows: [] } };
        return undefined;
      });
      const r = await h.call(tool, args);
      expect(r.isError).toBe(true);
      const text = r.content[0]!.text;
      expect(text).toMatch(/^not configured: /);
      for (const n of names) expect(text).toContain(n);
      expectNoSecret(text);
      expect(h.seen).toHaveLength(0);

      // The two Google Cloud tools share their variables, so neither works
      // without the other's; every tool that shares none still does.
      for (const [other, otherArgs] of cases.filter(([, , n]) => !n.some((x) => names.includes(x)))) {
        const ok = await h.call(other, otherArgs);
        expect(ok.isError, `${other} after ${tool} unconfigured`).toBeFalsy();
      }
    });
  }

  it("treats a blank variable as absent", async () => {
    const h = await harness({ OPENAI_ADMIN_KEY: "   " }, () => undefined);
    const r = await h.call("get_openai_costs", { start_date: "2026-11-01" });
    expect(r.content[0]!.text).toMatch(/not configured: get_openai_costs needs OPENAI_ADMIN_KEY/);
  });
});

// ---- OpenRouter -------------------------------------------------------------

describe("get_openrouter_credits", () => {
  it("reads /credits with the management key and derives the balance", async () => {
    const h = await harness(FULL_ENV, (req) =>
      req.url === `${OPENROUTER_API}/credits`
        ? { body: { data: { total_credits: 100.5, total_usage: 25.75 } } }
        : undefined,
    );
    const out = json(await h.call("get_openrouter_credits"));
    expect(out).toEqual({ currency: "USD", total_credits: 100.5, total_usage: 25.75, remaining: 74.75 });
    expect(h.seen).toHaveLength(1);
    expect(h.seen[0]!.method).toBe("GET");
    expect(h.seen[0]!.headers.Authorization).toBe(`Bearer ${MGMT_KEY}`);
    expect(h.seen[0]!.redirect).toBe("error");
  });

  it("refuses a 200 whose body is not a JSON object, without crashing", async () => {
    const h = await harness(FULL_ENV, () => ({ body: "null" }));
    const r = await h.call("get_openrouter_credits");
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/not a JSON object/);
  });

  it("rounds away float noise in the remaining balance", async () => {
    const h = await harness(FULL_ENV, () => ({ body: { data: { total_credits: 0.3, total_usage: 0.1 } } }));
    expect(json(await h.call("get_openrouter_credits")).remaining).toBe(0.2);
  });

  it("scrubs the key from an upstream error that echoes it", async () => {
    const h = await harness(FULL_ENV, () => ({
      status: 403,
      body: { error: { code: 403, message: `Only management keys can perform this operation. Got ${MGMT_KEY}` } },
    }));
    const r = await h.call("get_openrouter_credits");
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/HTTP 403/);
    expect(r.content[0]!.text).toMatch(/MANAGEMENT key/);
    expectNoSecret(r.content[0]!.text);
  });
});

describe("get_openrouter_key_usage", () => {
  it("reads /key with the API key and keeps only usage and limit fields", async () => {
    const h = await harness(FULL_ENV, (req) =>
      req.url === `${OPENROUTER_API}/key`
        ? {
            body: {
              data: {
                label: "sk-or-v1-abc...xyz",
                limit: 50,
                limit_remaining: 38.2,
                limit_reset: "monthly",
                include_byok_in_limit: false,
                usage: 120.4,
                usage_daily: 0.9,
                usage_weekly: 4.1,
                usage_monthly: 11.8,
                byok_usage: 0,
                byok_usage_daily: 0,
                byok_usage_weekly: 0,
                byok_usage_monthly: 0,
                is_free_tier: false,
                creator_user_id: "user_123",
                organization_id: "org_123",
                workspace_id: "ws_123",
                rate_limit: { requests: 10, interval: "10s" },
              },
            },
          }
        : undefined,
    );
    const out = json(await h.call("get_openrouter_key_usage"));
    expect(out).toEqual({
      currency: "USD",
      limit: 50,
      limit_remaining: 38.2,
      limit_reset: "monthly",
      include_byok_in_limit: false,
      usage: 120.4,
      usage_daily: 0.9,
      usage_weekly: 4.1,
      usage_monthly: 11.8,
      byok_usage: 0,
      byok_usage_daily: 0,
      byok_usage_weekly: 0,
      byok_usage_monthly: 0,
      is_free_tier: false,
    });
    expect(h.seen[0]!.headers.Authorization).toBe(`Bearer ${PI_KEY}`);
  });

  it("scrubs the key from a 401 and says retrying will not help", async () => {
    const h = await harness(FULL_ENV, () => ({ status: 401, body: { error: { code: 401, message: `bad key ${PI_KEY}` } } }));
    const r = await h.call("get_openrouter_key_usage");
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/Retrying will not help/);
    expectNoSecret(r.content[0]!.text);
  });
});

// ---- OpenAI -----------------------------------------------------------------

const DAY = 86_400;
const NOV1 = Date.parse("2026-11-01T00:00:00Z") / 1000;

describe("get_openai_costs", () => {
  it("asks for daily buckets grouped by project over the inclusive range", async () => {
    const h = await harness(FULL_ENV, () => ({ body: { object: "page", data: [], has_more: false, next_page: null } }));
    json(await h.call("get_openai_costs", { start_date: "2026-11-01", end_date: "2026-11-03" }));
    const url = new URL(h.seen[0]!.url);
    expect(`${url.origin}${url.pathname}`).toBe(`${OPENAI_API}/organization/costs`);
    expect(url.searchParams.get("start_time")).toBe(String(NOV1));
    expect(url.searchParams.get("end_time")).toBe(String(NOV1 + 3 * DAY));
    expect(url.searchParams.get("bucket_width")).toBe("1d");
    expect(url.searchParams.get("group_by")).toBe("project_id");
    expect(url.searchParams.get("limit")).toBe("3");
    expect(url.searchParams.has("page")).toBe(false);
    expect(h.seen[0]!.headers.Authorization).toBe(`Bearer ${ADMIN_KEY}`);
  });

  it("follows next_page to the end and merges every page", async () => {
    const pages: Record<string, unknown> = {
      first: {
        data: [
          {
            object: "bucket",
            start_time: NOV1,
            end_time: NOV1 + DAY,
            results: [
              { object: "organization.costs.result", amount: { value: 1.25, currency: "usd" }, project_id: "proj_a" },
              { object: "organization.costs.result", amount: { value: "0.5", currency: "USD" }, project_id: null },
            ],
          },
        ],
        has_more: true,
        next_page: "page_2",
      },
      page_2: {
        data: [
          {
            object: "bucket",
            start_time: NOV1 + DAY,
            end_time: NOV1 + 2 * DAY,
            results: [{ amount: { value: 2, currency: "usd" }, project_id: "proj_b" }],
          },
        ],
        has_more: false,
        next_page: null,
      },
    };
    const h = await harness(FULL_ENV, (req) => {
      const page = new URL(req.url).searchParams.get("page") ?? "first";
      return { body: pages[page] };
    });
    const out = json(await h.call("get_openai_costs", { start_date: "2026-11-01", end_date: "2026-11-02" }));
    expect(h.seen.map((s) => new URL(s.url).searchParams.get("page"))).toEqual([null, "page_2"]);
    expect(out.pages).toBe(2);
    expect(out.totals).toEqual([{ currency: "usd", amount: 3.75 }]);
    expect(out.days).toEqual([
      {
        date: "2026-11-01",
        projects: [
          { project_id: "proj_a", amount: 1.25, currency: "usd" },
          { project_id: "(none)", amount: 0.5, currency: "usd" },
        ],
      },
      { date: "2026-11-02", projects: [{ project_id: "proj_b", amount: 2, currency: "usd" }] },
    ]);
    expect(out.start_date).toBe("2026-11-01");
    expect(out.end_date).toBe("2026-11-02");
  });

  it("stops a walk that never ends instead of looping", async () => {
    let n = 0;
    const h = await harness(FULL_ENV, () => ({ body: { data: [], has_more: true, next_page: `p${++n}` } }));
    const r = await h.call("get_openai_costs", { start_date: "2026-11-01" });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(new RegExp(`after ${MAX_PAGES} pages`));
    expect(h.seen).toHaveLength(MAX_PAGES);
  });

  it("bounds and validates the dates before any request", async () => {
    const h = await harness(FULL_ENV, () => undefined);
    const bad: Array<[Record<string, unknown>, RegExp]> = [
      [{}, /start_date` is required/],
      [{ start_date: "11/01/2026" }, /YYYY-MM-DD/],
      [{ start_date: "2026-02-30" }, /not a real date/],
      [{ start_date: "2026-11-05", end_date: "2026-11-01" }, /before/],
      [{ start_date: "2026-01-01", end_date: "2026-02-01" }, /32 days; at most 31/],
      [{ start_date: "2026-11-25" }, /in the future/],
      [{ start_date: 20261101 }, /must be a string/],
    ];
    for (const [args, message] of bad) {
      const r = await h.call("get_openai_costs", args);
      expect(r.isError, JSON.stringify(args)).toBe(true);
      expect(r.content[0]!.text).toMatch(message);
    }
    expect(h.seen).toHaveLength(0);
  });

  it("allows exactly 31 days", () => {
    expect(dateRange("2026-01-01", "2026-01-31", new Date("2026-11-21T00:00:00Z")).days).toBe(31);
  });

  it("scrubs the admin key, and any key-shaped text, from an upstream error", async () => {
    const h = await harness(FULL_ENV, () => ({
      status: 401,
      body: { error: { message: `Incorrect API key provided: ${ADMIN_KEY}. Also sk-proj-someoneelse12345678.` } },
    }));
    const r = await h.call("get_openai_costs", { start_date: "2026-11-01" });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/HTTP 401/);
    expect(r.content[0]!.text).not.toContain("sk-proj-someoneelse12345678");
    expectNoSecret(r.content[0]!.text);
  });

  it("does not quote a non-JSON error page", async () => {
    const h = await harness(FULL_ENV, () => ({ status: 502, body: `<html>${ADMIN_KEY}</html>` }));
    const r = await h.call("get_openai_costs", { start_date: "2026-11-01" });
    expect(r.content[0]!.text).toMatch(/HTTP 502\. OpenAI is failing/);
    expectNoSecret(r.content[0]!.text);
  });
});

// ---- Google Cloud -----------------------------------------------------------

function gcpRoute(overrides: { query?: Route; token?: Route; poll?: Route } = {}): Route {
  return (req) => {
    if (req.url === GOOGLE_TOKEN_URL) return overrides.token?.(req) ?? { body: { access_token: ACCESS_TOKEN, expires_in: 3599 } };
    if (req.url === `${BIGQUERY_API}/projects/example-project/queries` && req.method === "POST") {
      return (
        overrides.query?.(req) ?? {
          body: {
            jobComplete: true,
            schema: {
              fields: [
                { name: "invoice_month" },
                { name: "currency" },
                { name: "cost" },
                { name: "credits" },
                { name: "latest_usage_end_time" },
              ],
            },
            rows: [{ f: [{ v: "202611" }, { v: "USD" }, { v: "41.2" }, { v: "-3.1" }, { v: "2026-11-20T18:00:00Z" }] }],
          },
        }
      );
    }
    if (req.url.startsWith(`${BIGQUERY_API}/projects/example-project/queries/`)) return overrides.poll?.(req);
    return undefined;
  };
}

describe("get_gcp_month_to_date", () => {
  it("signs a readonly assertion for Google's own token endpoint, then runs the fixed query", async () => {
    const h = await harness(FULL_ENV, gcpRoute());
    const out = json(await h.call("get_gcp_month_to_date"));
    expect(out).toEqual({
      invoice_month_timezone: "America/Los_Angeles",
      rows: [
        {
          invoice_month: "202611",
          currency: "USD",
          cost: 41.2,
          credits: -3.1,
          net: 38.1,
          latest_usage_end_time: "2026-11-20T18:00:00Z",
        },
      ],
    });

    // The token exchange went to Google — never to the key file's token_uri.
    expect(h.seen.map((s) => s.url)).toEqual([GOOGLE_TOKEN_URL, `${BIGQUERY_API}/projects/example-project/queries`]);
    const form = new URLSearchParams(h.seen[0]!.body);
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    const [header, claims, signature] = form.get("assertion")!.split(".");
    const payload = JSON.parse(Buffer.from(claims!, "base64url").toString()) as Record<string, unknown>;
    expect(payload.scope).toBe(BIGQUERY_SCOPE);
    expect(payload.aud).toBe(GOOGLE_TOKEN_URL);
    expect(payload.iss).toBe("test-service-account.invalid");
    expect(
      createVerify("RSA-SHA256").update(`${header}.${claims}`).verify(publicKey, signature!, "base64url"),
    ).toBe(true);

    const query = JSON.parse(h.seen[1]!.body!) as Record<string, unknown>;
    expect(h.seen[1]!.headers.Authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(query.useLegacySql).toBe(false);
    expect(query.maximumBytesBilled).toBe(String(10 * 1024 ** 3));
    expect(query.query).toBe(
      monthToDateQuery({ project: "example-project", dataset: "billing_export", table: "gcp_billing_export_v1_EXAMPLE" }),
    );
    expect(query.query).toContain("FROM `example-project.billing_export.gcp_billing_export_v1_EXAMPLE`");
    expect(query.query).toContain("invoice.month = FORMAT_DATE('%Y%m', CURRENT_DATE('America/Los_Angeles'))");
    expect(query.query).toContain("MAX(usage_end_time)");
    expect(Object.keys(query).sort()).toEqual(["maximumBytesBilled", "query", "timeoutMs", "useLegacySql"]);
  });

  it("polls an incomplete job at its own location until it finishes", async () => {
    let polls = 0;
    const h = await harness(
      FULL_ENV,
      gcpRoute({
        query: () => ({
          body: { jobComplete: false, jobReference: { projectId: "example-project", jobId: "job_1", location: "US" } },
        }),
        poll: () =>
          ++polls < 2
            ? { body: { jobComplete: false, jobReference: { projectId: "example-project", jobId: "job_1", location: "US" } } }
            : { body: { jobComplete: true, schema: { fields: [] }, rows: [] } },
      }),
    );
    const out = json(await h.call("get_gcp_month_to_date"));
    expect(out.rows).toEqual([]);
    expect(out.note).toMatch(/no rows/);
    const poll = new URL(h.seen[2]!.url);
    expect(poll.pathname).toBe("/bigquery/v2/projects/example-project/queries/job_1");
    expect(poll.searchParams.get("location")).toBe("US");
    expect(h.seen).toHaveLength(4);
  });

  it("scrubs the access token and the key from a BigQuery error", async () => {
    const h = await harness(
      FULL_ENV,
      gcpRoute({
        query: () => ({
          status: 403,
          body: {
            error: {
              code: 403,
              message: `Access Denied: token ${ACCESS_TOKEN}, Authorization: Bearer ${ACCESS_TOKEN}`,
              status: "PERMISSION_DENIED",
            },
          },
        }),
      }),
    );
    const r = await h.call("get_gcp_month_to_date");
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/HTTP 403/);
    expect(r.content[0]!.text).toMatch(/Data Viewer/);
    expectNoSecret(r.content[0]!.text);
  });

  it("scrubs the private key from a token-exchange error that quotes it", async () => {
    const h = await harness(
      FULL_ENV,
      gcpRoute({
        token: () => ({
          status: 400,
          body: { error: "invalid_grant", error_description: `bad key ${PEM.split("\n")[1]} ${JSON.stringify(PEM)}` },
        }),
      }),
    );
    const r = await h.call("get_gcp_month_to_date");
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/invalid_grant/);
    expectNoSecret(r.content[0]!.text);
    expect(h.seen).toHaveLength(1);
  });

  it("refuses a key that is not a service-account key, without quoting it", async () => {
    const h = await harness({ ...FULL_ENV, GCP_BILLING_SA_KEY_JSON: `{"type":"authorized_user","refresh_token":"1//abcdefghijkl"}` }, gcpRoute());
    const r = await h.call("get_gcp_month_to_date");
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/not a service-account key/);
    expect(r.content[0]!.text).not.toContain("1//abcdefghijkl");
    expect(h.seen).toHaveLength(0);
  });
});

describe("get_gcp_month_to_date, the edges", () => {
  const incomplete = { body: { jobComplete: false, jobReference: { projectId: "example-project", jobId: "job_1", location: "EU" } } };

  it("maps rows that arrive on a poll, not only on the first answer", async () => {
    const h = await harness(
      FULL_ENV,
      gcpRoute({
        query: () => incomplete,
        poll: () => ({
          body: {
            jobComplete: true,
            schema: { fields: [{ name: "invoice_month" }, { name: "currency" }, { name: "cost" }, { name: "credits" }, { name: "latest_usage_end_time" }] },
            rows: [
              { f: [{ v: "202611" }, { v: "EUR" }, { v: "1.5" }, { v: "0" }, { v: "2026-11-20T10:00:00Z" }] },
              { f: [{ v: "202611" }, { v: "USD" }, { v: "10" }, { v: "-2.25" }, { v: null }] },
            ],
          },
        }),
      }),
    );
    const out = json(await h.call("get_gcp_month_to_date"));
    expect(out.rows).toEqual([
      { invoice_month: "202611", currency: "EUR", cost: 1.5, credits: 0, net: 1.5, latest_usage_end_time: "2026-11-20T10:00:00Z" },
      { invoice_month: "202611", currency: "USD", cost: 10, credits: -2.25, net: 7.75, latest_usage_end_time: null },
    ]);
  });

  it(`gives up after ${MAX_POLLS} polls with an error that says to call again`, async () => {
    const h = await harness(FULL_ENV, gcpRoute({ query: () => incomplete, poll: () => incomplete }));
    const r = await h.call("get_gcp_month_to_date");
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/did not finish .* safe to call again/);
    // token + query + MAX_POLLS polls
    expect(h.seen).toHaveLength(2 + MAX_POLLS);
  });

  it("refuses an incomplete answer with no job id rather than loop", async () => {
    const h = await harness(FULL_ENV, gcpRoute({ query: () => ({ body: { jobComplete: false } }) }));
    const r = await h.call("get_gcp_month_to_date");
    expect(r.isError).toBe(true);
    expect(h.seen).toHaveLength(2);
  });

  it("says when the byte ceiling is the reason for a 400", async () => {
    const h = await harness(
      FULL_ENV,
      gcpRoute({ query: () => ({ status: 400, body: { error: { code: 400, message: "Query exceeded limit for bytes billed: 10737418240.", errors: [{ reason: "bytesBilledLimitExceeded" }] } } }) }),
    );
    const r = await h.call("get_gcp_month_to_date");
    expect(r.content[0]!.text).toMatch(/10 GiB ceiling/);
  });

  it("scrubs the signed assertion if an error quotes it back", async () => {
    let assertion = "";
    const h = await harness(
      FULL_ENV,
      gcpRoute({
        token: (req) => {
          assertion = new URLSearchParams(req.body).get("assertion")!;
          return { status: 400, body: { error: "invalid_grant", error_description: `assertion ${assertion} rejected` } };
        },
      }),
    );
    const r = await h.call("get_gcp_month_to_date");
    expect(assertion.length).toBeGreaterThan(100);
    expect(r.content[0]!.text).not.toContain(assertion);
    expect(r.content[0]!.text).not.toContain(assertion.split(".")[1]!);
  });
});

// ---- Google Cloud, line by line -------------------------------------------

const TABLE = { project: "example-project", dataset: "billing_export", table: "gcp_billing_export_v1_EXAMPLE" };

const BREAKDOWN_FIELDS = [
  "service",
  "sku_id",
  "sku",
  "usage_unit",
  "currency",
  "cost",
  "credits",
  "usage_amount",
  "row_rank",
  "group_count",
  "currency_cost",
  "currency_credits",
  "range_latest_usage_end_time",
];

function breakdownAnswer(rows: unknown[][], fields = BREAKDOWN_FIELDS, bytes = "10485760") {
  return {
    body: {
      jobComplete: true,
      totalBytesProcessed: bytes,
      schema: { fields: fields.map((name) => ({ name })) },
      rows: rows.map((r) => ({ f: r.map((v) => ({ v })) })),
    },
  };
}

const SERVICE_SKU_ROWS = [
  ["Secret Manager", "6D5B-0001", "Secret access operations", "requests", "USD", "7.2", "0", "2400000", "1", "3", "12.5", "-1", "2026-11-27T18:00:00Z"],
  ["Cloud SQL", "9A1C-0002", "vCPU time", "seconds", "USD", "4.3", "-1", "86400", "2", "3", "12.5", "-1", "2026-11-27T18:00:00Z"],
  ["Cloud Storage", "E5F3-0003", "Standard storage", "byte-seconds", "USD", "1", "0", "1e15", "3", "3", "12.5", "-1", "2026-11-27T18:00:00Z"],
];

function breakdownQueryOf(seen: Seen[]): { query: string; parameterMode?: string; queryParameters?: Array<{ name: string; parameterType: { type: string }; parameterValue: { value: string } }>; maximumBytesBilled: string; useLegacySql: boolean } {
  const post = seen.find((s) => s.url === `${BIGQUERY_API}/projects/example-project/queries` && s.method === "POST");
  return JSON.parse(post!.body!);
}

function params(q: ReturnType<typeof breakdownQueryOf>): Record<string, [string, string]> {
  return Object.fromEntries((q.queryParameters ?? []).map((p) => [p.name, [p.parameterType.type, p.parameterValue.value]]));
}

describe("get_gcp_cost_breakdown", () => {
  it("runs one grouped query with every caller value bound, and maps the rows", async () => {
    const h = await harness(FULL_ENV, gcpRoute({ query: () => breakdownAnswer(SERVICE_SKU_ROWS) }));
    const out = json(
      await h.call("get_gcp_cost_breakdown", {
        start_date: "2026-11-01",
        end_date: "2026-11-20",
        group_by: ["sku", "service"],
      }),
    );
    expect(out).toEqual({
      start_date: "2026-11-01",
      end_date: "2026-11-20",
      timezone: "America/Los_Angeles",
      group_by: ["service", "sku"],
      groups: 3,
      returned: 3,
      truncated: false,
      totals: [{ currency: "USD", cost: 12.5, credits: -1, net: 11.5 }],
      latest_usage_end_time: "2026-11-27T18:00:00Z",
      bytes_processed: 10485760,
      rows: [
        {
          service: "Secret Manager",
          sku_id: "6D5B-0001",
          sku: "Secret access operations",
          usage_amount: 2400000,
          usage_unit: "requests",
          currency: "USD",
          cost: 7.2,
          credits: 0,
          net: 7.2,
        },
        {
          service: "Cloud SQL",
          sku_id: "9A1C-0002",
          sku: "vCPU time",
          usage_amount: 86400,
          usage_unit: "seconds",
          currency: "USD",
          cost: 4.3,
          credits: -1,
          net: 3.3,
        },
        {
          service: "Cloud Storage",
          sku_id: "E5F3-0003",
          sku: "Standard storage",
          usage_amount: 1e15,
          usage_unit: "byte-seconds",
          currency: "USD",
          cost: 1,
          credits: 0,
          net: 1,
        },
      ],
    });

    // Same token exchange, same export project, same ceiling as month-to-date.
    expect(h.seen.map((s) => s.url)).toEqual([GOOGLE_TOKEN_URL, `${BIGQUERY_API}/projects/example-project/queries`]);
    const q = breakdownQueryOf(h.seen);
    expect(h.seen[1]!.headers.Authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(q.useLegacySql).toBe(false);
    expect(q.maximumBytesBilled).toBe(String(10 * 1024 ** 3));
    expect(q.parameterMode).toBe("NAMED");
    expect(params(q)).toEqual({
      start_date: ["DATE", "2026-11-01"],
      end_date: ["DATE", "2026-11-20"],
      max_rows: ["INT64", "100"],
    });
    expect(q.query).toBe(breakdownQuery(TABLE, ["service", "sku"], []));
    expect(q.query).toContain("FROM `example-project.billing_export.gcp_billing_export_v1_EXAMPLE`");
    expect(q.query).toContain("usage_start_time >= TIMESTAMP(@start_date, 'America/Los_Angeles')");
    expect(q.query).toContain("TIMESTAMP(DATE_ADD(@end_date, INTERVAL 1 DAY), 'America/Los_Angeles')");
    expect(q.query).toContain("SUM(usage.amount) AS usage_amount");
    expect(q.query).toContain("WHERE row_rank <= @max_rows OR currency_rank = 1");
    // Ordinals, not aliases that shadow the export's own STRUCT columns.
    expect(q.query).toContain("GROUP BY 1, 2, 3, 4, 5\n");
    expect(q.query).not.toMatch(/2026-11-/);
  });

  it("binds a filter value as a parameter: hostile text never reaches the SQL", async () => {
    const hostile = "x' OR 1=1; DROP TABLE t; --";
    const h = await harness(FULL_ENV, gcpRoute({ query: () => breakdownAnswer([]) }));
    const out = json(
      await h.call("get_gcp_cost_breakdown", {
        start_date: "2026-11-01",
        end_date: "2026-11-01",
        group_by: ["day"],
        service: hostile,
        project_id: "example-staging",
        sku_id: "6D5B-0001",
        sku: "`; SELECT 1",
        max_rows: 5,
      }),
    );
    const q = breakdownQueryOf(h.seen);
    expect(q.query).toBe(breakdownQuery(TABLE, ["day"], ["project_id", "service", "sku_id", "sku"]));
    expect(q.query).not.toContain(hostile);
    expect(q.query).not.toContain("example-staging");
    expect(q.query).not.toContain("6D5B");
    expect(q.query).not.toContain("SELECT 1");
    // The filter compares what a row shows, so `(none)` read off a row works.
    expect(q.query).toContain("AND IFNULL(project.id, '(none)') = @project_id");
    expect(q.query).toContain("AND IFNULL(service.description, '(none)') = @service");
    expect(q.query).toContain("AND sku.id = @sku_id");
    expect(q.query).toContain("AND IFNULL(sku.description, '(none)') = @sku");
    expect(params(q)).toMatchObject({
      project_id: ["STRING", "example-staging"],
      sku_id: ["STRING", "6D5B-0001"],
      service: ["STRING", hostile],
      sku: ["STRING", "`; SELECT 1"],
      max_rows: ["INT64", "5"],
    });
    expect(out.filters).toEqual({ project_id: "example-staging", service: hostile, sku_id: "6D5B-0001", sku: "`; SELECT 1" });
    expect(out.rows).toEqual([]);
    expect(out.groups).toBe(0);
    expect(out.note).toMatch(/no rows/);
  });

  it("builds every group_by and filter combination from fixed fragments only", () => {
    const keys = ["project", "service", "sku", "day"] as const;
    const filters = ["project_id", "service", "sku_id", "sku"] as const;
    for (let mask = 1; mask < 16; mask++) {
      const groupBy = keys.filter((_, i) => mask & (1 << i));
      for (let fmask = 0; fmask < 16; fmask++) {
        const on = filters.filter((_, i) => fmask & (1 << i));
        const fq = breakdownQuery(TABLE, [...groupBy], [...on]);
        expect([...new Set(fq.match(/@\w+/g))].sort()).toEqual(
          ["@end_date", "@max_rows", "@start_date", ...on.map((f) => `@${f}`)].sort(),
        );
      }
      const q = breakdownQuery(TABLE, [...groupBy], []);
      expect([...new Set(q.match(/@\w+/g))].sort()).toEqual(["@end_date", "@max_rows", "@start_date"]);
      expect(q.includes("usage.amount")).toBe(groupBy.includes("sku"));
      expect(q.includes("usage_date")).toBe(groupBy.includes("day"));
      expect(q.includes("project_id")).toBe(groupBy.includes("project"));
    }
  });

  it("maps a day trend, defaults end_date to today in Pacific Time, and groups by service by default", async () => {
    // 05:00 UTC on the 21st is still the 20th in Pacific Time.
    const now = new Date("2026-11-21T05:00:00Z");
    const fields = ["usage_date", "currency", "cost", "credits", "row_rank", "group_count", "currency_cost", "currency_credits", "range_latest_usage_end_time"];
    const h = await harness(
      FULL_ENV,
      gcpRoute({
        query: (req) =>
          JSON.parse(req.body!).query.includes("usage_date")
            ? breakdownAnswer([["2026-11-20", "USD", "4", "0", "1", "2", "5.3", "0", "2026-11-20T18:00:00Z"], ["2026-11-01", "USD", "1.3", "0", "2", "2", "5.3", "0", "2026-11-20T18:00:00Z"]], fields)
            : breakdownAnswer([]),
      }),
      now,
    );
    const out = json(await h.call("get_gcp_cost_breakdown", { start_date: "2026-11-01", group_by: "day" }));
    expect(out.end_date).toBe("2026-11-20");
    expect(out.rows).toEqual([
      { usage_date: "2026-11-20", currency: "USD", cost: 4, credits: 0, net: 4 },
      { usage_date: "2026-11-01", currency: "USD", cost: 1.3, credits: 0, net: 1.3 },
    ]);
    expect(params(breakdownQueryOf(h.seen)).end_date).toEqual(["DATE", "2026-11-20"]);

    const d = await harness(FULL_ENV, gcpRoute({ query: () => breakdownAnswer([]) }), now);
    expect(json(await d.call("get_gcp_cost_breakdown", { start_date: "2026-11-01" })).group_by).toEqual(["service"]);
    expect(breakdownQueryOf(d.seen).query).toBe(breakdownQuery(TABLE, ["service"], []));
  });

  it("says when the cap cut the answer, with totals over every group", async () => {
    const rows = SERVICE_SKU_ROWS.slice(0, 2).map((r) => {
      const c = [...r];
      c[9] = "250";
      return c;
    });
    const h = await harness(FULL_ENV, gcpRoute({ query: () => breakdownAnswer(rows) }));
    const out = json(await h.call("get_gcp_cost_breakdown", { start_date: "2026-10-01", group_by: ["service", "sku"], max_rows: 2 }));
    expect(out.groups).toBe(250);
    expect(out.returned).toBe(2);
    expect(out.truncated).toBe(true);
    expect(out.totals).toEqual([{ currency: "USD", cost: 12.5, credits: -1, net: 11.5 }]);
    expect(out.note).toMatch(/top 2 of 250 groups/);
  });

  const refusals: Array<[string, Record<string, unknown>, RegExp]> = [
    ["a missing start_date", {}, /start_date. is required/],
    ["a malformed date", { start_date: "2026-11-1" }, /YYYY-MM-DD/],
    ["an impossible date", { start_date: "2026-02-30" }, /not a real date/],
    ["an end before the start", { start_date: "2026-11-10", end_date: "2026-11-01" }, /before/],
    ["a range past the bound", { start_date: "2026-08-01", end_date: "2026-11-20" }, /at most 92/],
    ["a start in the future", { start_date: "2026-11-22" }, /future/],
    ["an unknown group key", { start_date: "2026-11-01", group_by: ["service", "region"] }, /takes only project, service, sku, day; got "region"/],
    ["a column-shaped group key", { start_date: "2026-11-01", group_by: ["service.description; --"] }, /takes only/],
    ["an empty group_by", { start_date: "2026-11-01", group_by: [] }, /non-empty/],
    ["a non-list group_by", { start_date: "2026-11-01", group_by: { a: 1 } }, /non-empty list/],
    ["a non-string filter", { start_date: "2026-11-01", service: ["a"] }, /service. must be a non-empty string/],
    ["an empty filter", { start_date: "2026-11-01", service: "" }, /service. must be a non-empty string/],
    ["an overlong filter", { start_date: "2026-11-01", sku: "x".repeat(257) }, /longer than 256/],
    ["a zero row cap", { start_date: "2026-11-01", max_rows: 0 }, /1 to 200/],
    ["a row cap past the bound", { start_date: "2026-11-01", max_rows: 201 }, /1 to 200/],
    ["a fractional row cap", { start_date: "2026-11-01", max_rows: 2.5 }, /whole number/],
    ["a string row cap", { start_date: "2026-11-01", max_rows: "10; --" }, /whole number/],
  ];
  for (const [what, args, message] of refusals) {
    it(`refuses ${what} before any request`, async () => {
      const h = await harness(FULL_ENV, gcpRoute());
      const r = await h.call("get_gcp_cost_breakdown", args);
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toMatch(message);
      expect(h.seen).toHaveLength(0);
    });
  }

  it("keeps a currency's totals when its every group ranks past the cap, without returning that row", async () => {
    const rows = [
      [...SERVICE_SKU_ROWS[0]!.slice(0, 8), "1", "4", "12.5", "-1", "2026-11-27T18:00:00Z"],
      // EUR's top group is fourth overall: back only for EUR's totals.
      ["Cloud Run", "AAAA-0004", "CPU", "seconds", "EUR", "0.5", "0", "10", "4", "4", "0.75", "-0.05", "2026-11-27T18:00:00Z"],
    ];
    const h = await harness(FULL_ENV, gcpRoute({ query: () => breakdownAnswer(rows) }));
    const out = json(await h.call("get_gcp_cost_breakdown", { start_date: "2026-11-01", group_by: ["service", "sku"], max_rows: 1 }));
    expect(out.returned).toBe(1);
    expect((out.rows as Array<{ currency: string }>).map((r) => r.currency)).toEqual(["USD"]);
    expect(out.totals).toEqual([
      { currency: "EUR", cost: 0.75, credits: -0.05, net: 0.7 },
      { currency: "USD", cost: 12.5, credits: -1, net: 11.5 },
    ]);
    expect(out.truncated).toBe(true);
  });

  it("maps rows that arrive on a poll, with the bytes the finished job reports", async () => {
    const h = await harness(
      FULL_ENV,
      gcpRoute({
        query: () => ({ body: { jobComplete: false, jobReference: { projectId: "example-project", jobId: "job_ok", location: "US" } } }),
        poll: () => breakdownAnswer(SERVICE_SKU_ROWS, BREAKDOWN_FIELDS, "4096"),
      }),
    );
    const out = json(await h.call("get_gcp_cost_breakdown", { start_date: "2026-11-01", group_by: ["service", "sku"] }));
    expect(out.returned).toBe(3);
    expect(out.bytes_processed).toBe(4096);
  });

  it(`allows exactly ${MAX_BREAKDOWN_DAYS} days`, async () => {
    const h = await harness(FULL_ENV, gcpRoute({ query: () => breakdownAnswer([]) }));
    const r = await h.call("get_gcp_cost_breakdown", { start_date: "2026-08-21", end_date: "2026-11-20" });
    expect(r.isError).toBeFalsy();
  });

  it("names itself when the export address is misconfigured", async () => {
    const h = await harness({ ...FULL_ENV, GCP_BILLING_EXPORT_TABLE: "t` UNION ALL SELECT 1 --" }, gcpRoute());
    const r = await h.call("get_gcp_cost_breakdown", { start_date: "2026-11-01" });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/^get_gcp_cost_breakdown is misconfigured: GCP_BILLING_EXPORT_TABLE/);
    expect(h.seen).toHaveLength(0);
  });

  it("polls an unfinished job like month-to-date, and says which query gave up", async () => {
    const incomplete = { body: { jobComplete: false, jobReference: { projectId: "example-project", jobId: "job_b", location: "US" } } };
    const h = await harness(FULL_ENV, gcpRoute({ query: () => incomplete, poll: () => incomplete }));
    const r = await h.call("get_gcp_cost_breakdown", { start_date: "2026-11-01" });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/did not finish the cost breakdown query in time/);
    expect(h.seen.filter((s) => s.url.includes("/queries/job_b"))).toHaveLength(MAX_POLLS);
  });

  it("scrubs the access token and the key from a BigQuery error", async () => {
    const h = await harness(
      FULL_ENV,
      gcpRoute({ query: () => ({ status: 403, body: { error: { code: 403, message: `Access Denied for ${ACCESS_TOKEN} ${PEM.split("\n")[2]}` } } }) }),
    );
    const r = await h.call("get_gcp_cost_breakdown", { start_date: "2026-11-01" });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/BigQuery Data Viewer/);
    expectNoSecret(r.content[0]!.text);
  });
});

describe("transport failures", () => {
  it("reports a network failure and its cause, scrubbed", async () => {
    const created = createMCPServer({
      version: "test",
      env: FULL_ENV,
      fetch: (async () => {
        throw Object.assign(new TypeError("fetch failed"), { cause: new Error(`getaddrinfo ENOTFOUND (key ${ADMIN_KEY})`) });
      }) as typeof fetch,
    });
    let call: ((req: never) => unknown) | undefined;
    await created.registerHandlers({ setRequestHandler: (_s: unknown, h: (req: never) => unknown) => (call = h) });
    const r = (await call!({ params: { name: "get_openai_costs", arguments: { start_date: "2026-11-01" } } } as never)) as ToolResult;
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/failed before any answer: fetch failed \(getaddrinfo ENOTFOUND/);
    expectNoSecret(r.content[0]!.text);
  });

  it("stops a multi-request call at its deadline instead of starting another request", async () => {
    let clock = Date.parse("2026-11-21T12:00:00Z");
    const spy = vi.spyOn(Date, "now").mockImplementation(() => clock);
    try {
      let n = 0;
      const h = await harness(FULL_ENV, () => {
        clock += 31_000; // each page takes 31 s; the 90 s walk budget allows three
        return { body: { data: [], has_more: true, next_page: `p${++n}` } };
      });
      const r = await h.call("get_openai_costs", { start_date: "2026-11-01" });
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toMatch(/ran out of time/);
      expect(h.seen).toHaveLength(3);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("the export table's identifiers", () => {
  const ok = {
    GCP_BILLING_EXPORT_PROJECT: "example-project",
    GCP_BILLING_EXPORT_DATASET: "billing_export",
    GCP_BILLING_EXPORT_TABLE: "gcp_billing_export_v1_0A0A0A_B1B1B1_C2C2C2",
  };

  it("accepts a standard export's address", () => {
    expect(billingExportTable(ok)).toEqual({
      project: "example-project",
      dataset: "billing_export",
      table: "gcp_billing_export_v1_0A0A0A_B1B1B1_C2C2C2",
    });
  });

  const injections: Array<[keyof typeof ok, string]> = [
    ["GCP_BILLING_EXPORT_PROJECT", "example-project`; DROP TABLE x; --"],
    ["GCP_BILLING_EXPORT_PROJECT", "Example-Project"],
    ["GCP_BILLING_EXPORT_PROJECT", "short"],
    ["GCP_BILLING_EXPORT_PROJECT", "ends-in-hyphen-"],
    ["GCP_BILLING_EXPORT_PROJECT", "example.com:project"],
    ["GCP_BILLING_EXPORT_DATASET", "billing.export"],
    ["GCP_BILLING_EXPORT_DATASET", "billing`export"],
    ["GCP_BILLING_EXPORT_DATASET", "billing export"],
    ["GCP_BILLING_EXPORT_TABLE", "t` UNION ALL SELECT 1 --"],
    ["GCP_BILLING_EXPORT_TABLE", "gcp_billing_export_*"],
    ["GCP_BILLING_EXPORT_TABLE", "other_dataset.table"],
    ["GCP_BILLING_EXPORT_TABLE", "x\nWHERE"],
  ];

  for (const [name, bad] of injections) {
    it(`refuses ${name}=${JSON.stringify(bad)} before any request, naming the variable only`, async () => {
      const h = await harness({ ...FULL_ENV, [name]: bad }, gcpRoute());
      const r = await h.call("get_gcp_month_to_date");
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toMatch(/misconfigured/);
      expect(r.content[0]!.text).toContain(name);
      expect(h.seen).toHaveLength(0);
    });
  }
});

describe("the scrubber", () => {
  it("removes each held secret, every PEM line, and credential-shaped text", () => {
    const scrub = createScrubber(FULL_ENV);
    const text = [MGMT_KEY, PI_KEY, ADMIN_KEY, PEM, PEM.split("\n")[3], "Bearer abc.def", "sk-live-abcdefghijkl", "ya29.zzz"].join(" ");
    const out = scrub(text);
    expectNoSecret(out);
    expect(out).not.toMatch(/Bearer abc|sk-live|ya29\.zzz/);
  });

  it("removes a token added at call time", () => {
    const scrub = createScrubber({});
    scrub.add("minted-at-call-time-123");
    expect(scrub("x minted-at-call-time-123 y")).toBe("x [redacted] y");
  });
});
