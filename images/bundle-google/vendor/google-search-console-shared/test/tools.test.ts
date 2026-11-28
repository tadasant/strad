/**
 * The tools against a fake client: what each one sends, what each one says
 * back, and that every one of them is a read.
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createMCPServer, type IGoogleSearchConsoleClient } from "../src/server.js";
import { READ_TOOLS, toolNames } from "../src/tools.js";
import { buildRequest, QuerySearchAnalyticsSchema } from "../src/tools/query-search-analytics.js";
import { normalizeSiteUrl } from "../src/utils/site-url.js";
import type { SearchAnalyticsRequest, UrlInspectionRequest } from "../src/types.js";

interface Recorded {
  method: string;
  args: unknown[];
}

function fakeClient(overrides: Partial<IGoogleSearchConsoleClient> = {}): {
  client: IGoogleSearchConsoleClient;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const record =
    <T>(method: string, value: T) =>
    async (...args: unknown[]) => {
      calls.push({ method, args });
      return value;
    };
  const client: IGoogleSearchConsoleClient = {
    listSites: record("listSites", {
      siteEntry: [
        { siteUrl: "https://blog.example.com/", permissionLevel: "siteFullUser" },
        { siteUrl: "sc-domain:example.com", permissionLevel: "siteOwner" },
      ],
    }),
    getSite: record("getSite", { siteUrl: "sc-domain:example.com", permissionLevel: "siteOwner" }),
    querySearchAnalytics: record("querySearchAnalytics", {
      rows: [
        { keys: ["example pricing", "MOBILE"], clicks: 412, impressions: 5210, ctr: 0.07908, position: 3.21 },
        { keys: ["example\tlogin", "DESKTOP"], clicks: 388, impressions: 901, ctr: 0.43063, position: 1.08 },
      ],
      responseAggregationType: "byProperty",
    }),
    listSitemaps: record("listSitemaps", {
      sitemap: [
        {
          path: "https://example.com/sitemap.xml",
          isSitemapsIndex: true,
          lastSubmitted: "2026-09-14T08:12:40.000Z",
          lastDownloaded: "2026-10-27T03:01:22.000Z",
          warnings: "1",
          errors: "0",
          contents: [{ type: "web", submitted: "1840" }],
        },
      ],
    }),
    getSitemap: record("getSitemap", { path: "https://example.com/sitemap.xml", isPending: true }),
    inspectUrl: record("inspectUrl", {
      inspectionResult: {
        inspectionResultLink: "https://search.google.com/search-console/inspect?resource_id=x",
        indexStatusResult: {
          verdict: "NEUTRAL",
          coverageState: "Excluded by 'noindex' tag",
          indexingState: "BLOCKED_BY_META_TAG",
          robotsTxtState: "ALLOWED",
          lastCrawlTime: "2026-10-25T11:42:07Z",
          crawledAs: "MOBILE",
          referringUrls: ["a", "b", "c", "d", "e", "f", "g"],
        },
        richResultsResult: { verdict: "PASS", detectedItems: [{ richResultType: "Breadcrumbs" }] },
      },
    }),
    ...overrides,
  };
  return { client, calls };
}

async function connect(client: IGoogleSearchConsoleClient) {
  const { server, registerHandlers } = createMCPServer({ version: "0.0.0", env: {} });
  await registerHandlers(server, () => client);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const mcp = new Client({ name: "test", version: "0.0.0" });
  await mcp.connect(b);
  return mcp;
}

async function call(client: IGoogleSearchConsoleClient, name: string, args: Record<string, unknown> = {}) {
  const mcp = await connect(client);
  try {
    const result = (await mcp.callTool({ name, arguments: args })) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    return { text: result.content[0].text, isError: result.isError === true };
  } finally {
    await mcp.close();
  }
}

test("six tools, every one a read, and READ_TOOLS is all of them", async () => {
  assert.deepEqual(toolNames(), [...READ_TOOLS]);
  const mcp = await connect(fakeClient().client);
  try {
    const { tools } = await mcp.listTools();
    assert.deepEqual(
      tools.map((t) => t.name),
      [...READ_TOOLS],
    );
    for (const tool of tools) {
      assert.equal(tool.annotations?.readOnlyHint, true, tool.name);
      assert.equal(tool.annotations?.destructiveHint, false, tool.name);
    }
  } finally {
    await mcp.close();
  }
});

test("no credential lists the tools and fails a call by naming the variables", async () => {
  const { server, registerHandlers } = createMCPServer({ version: "0.0.0", env: {} });
  await registerHandlers(server);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const mcp = new Client({ name: "test", version: "0.0.0" });
  await mcp.connect(b);
  try {
    assert.equal((await mcp.listTools()).tools.length, 6);
    const result = (await mcp.callTool({ name: "list_sites", arguments: {} })) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /GOOGLE_SEARCH_CONSOLE_OAUTH_REFRESH_TOKEN/);
  } finally {
    await mcp.close();
  }
});

test("a property is spelled the way Search Console stores it", () => {
  assert.equal(normalizeSiteUrl("sc-domain:example.com"), "sc-domain:example.com");
  assert.equal(normalizeSiteUrl(" sc-domain:example.com "), "sc-domain:example.com");
  assert.equal(normalizeSiteUrl("https://www.example.com/"), "https://www.example.com/");
  assert.equal(normalizeSiteUrl("https://www.example.com"), "https://www.example.com/");
  assert.equal(normalizeSiteUrl("https://www.example.com/blog/"), "https://www.example.com/blog/");
  assert.throws(() => normalizeSiteUrl("example.com"), /"sc-domain:example\.com"[\s\S]*"https:\/\/example\.com\/"/);
  assert.throws(() => normalizeSiteUrl("sc-domain:https://example.com"), /no scheme or path/);
});

test("list_sites names each property's kind and what its permission means, sorted", async () => {
  const { text } = await call(fakeClient().client, "list_sites");
  assert.equal(
    text,
    "2 properties:\n" +
      "- https://blog.example.com/ (URL-prefix property): siteFullUser — full user (can see all data)\n" +
      "- sc-domain:example.com (Domain property): siteOwner — owner (verified; full access, can add users)\n",
  );
});

test("list_sites with no properties says where to add one", async () => {
  const { text } = await call(fakeClient({ listSites: async () => ({}) }).client, "list_sites");
  assert.match(text, /no Search Console properties/);
});

test("get_site normalises the property before asking", async () => {
  const { client, calls } = fakeClient();
  await call(client, "get_site", { site_url: "https://www.example.com" });
  assert.deepEqual(calls[0], { method: "getSite", args: ["https://www.example.com/"] });
});

test("search analytics defaults to the 28 days ending today in Pacific time, web, final, 100 rows", () => {
  // 03:00 UTC on the 29th is still the 28th in Los Angeles: a UTC default would
  // ask Search Console for a day it has not reached.
  const request = buildRequest(QuerySearchAnalyticsSchema.parse({ site_url: "sc-domain:example.com" }), new Date("2026-11-29T03:00:00Z"));
  assert.deepEqual(request, {
    startDate: "2026-11-01",
    endDate: "2026-11-28",
    type: "web",
    rowLimit: 100,
    startRow: 0,
  });
});

test("search analytics maps every argument to the API's field names", () => {
  const request = buildRequest(
    QuerySearchAnalyticsSchema.parse({
      site_url: "sc-domain:example.com",
      start_date: "2026-10-01",
      end_date: "2026-10-28",
      dimensions: ["query", "page"],
      type: "discover",
      filters: [
        { dimension: "page", operator: "contains", expression: "/blog/" },
        { dimension: "country", expression: "usa" },
      ],
      aggregation_type: "byPage",
      row_limit: 25000,
      start_row: 500,
      data_state: "all",
    }),
  );
  assert.deepEqual(request, {
    startDate: "2026-10-01",
    endDate: "2026-10-28",
    dimensions: ["query", "page"],
    type: "discover",
    dimensionFilterGroups: [
      {
        groupType: "and",
        filters: [
          { dimension: "page", operator: "contains", expression: "/blog/" },
          { dimension: "country", operator: "equals", expression: "usa" },
        ],
      },
    ],
    aggregationType: "byPage",
    rowLimit: 25000,
    startRow: 500,
    dataState: "all",
  } satisfies SearchAnalyticsRequest);
});

test("search analytics refuses a bad window, a bad limit and an unknown argument by name", async () => {
  const { client, calls } = fakeClient();
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ start_date: "2026-10-28", end_date: "2026-10-01" }, /start_date 2026-10-28 is after end_date 2026-10-01/],
    [{ start_date: "2026-02-30" }, /start_date: must be a date written YYYY-MM-DD/],
    [{ row_limit: 25001 }, /row_limit/],
    [{ dimensions: ["query", "query"] }, /must not name a dimension twice/],
    [{ search_type: "image" }, /search_type|Unrecognized key/],
    [{ filters: [{ dimension: "date", expression: "2026-10-01" }] }, /filters\.0\.dimension/],
  ];
  for (const [args, expected] of cases) {
    const { text, isError } = await call(client, "query_search_analytics", { site_url: "sc-domain:example.com", ...args });
    assert.equal(isError, true, JSON.stringify(args));
    assert.match(text, expected);
  }
  assert.equal(calls.length, 0);
});

test("search analytics returns compact tab-separated rows and the next start_row", async () => {
  const { client, calls } = fakeClient();
  const { text } = await call(client, "query_search_analytics", {
    site_url: "sc-domain:example.com",
    start_date: "2026-10-01",
    end_date: "2026-10-28",
    dimensions: ["query", "device"],
    row_limit: 2,
  });
  assert.equal(calls[0].method, "querySearchAnalytics");
  assert.equal(calls[0].args[0], "sc-domain:example.com");
  assert.equal(
    text,
    "Search analytics for sc-domain:example.com, 2026-10-01 to 2026-10-28 (type web, data_state final, aggregated byProperty), by query, device.\n" +
      "2 rows. ctr is clicks / impressions; position is the average rank, 1 is the top.\n" +
      "\n" +
      "query\tdevice\tclicks\timpressions\tctr\tposition\n" +
      "example pricing\tMOBILE\t412\t5210\t7.91%\t3.2\n" +
      "example login\tDESKTOP\t388\t901\t43.06%\t1.1\n" +
      "\n" +
      "More rows may exist: call again with start_row 2.\n",
  );
});

test("search analytics with no rows explains the data lag", async () => {
  const { text, isError } = await call(fakeClient({ querySearchAnalytics: async () => ({}) }).client, "query_search_analytics", {
    site_url: "sc-domain:example.com",
  });
  assert.equal(isError, false);
  assert.match(text, /two to three\s+days behind/);
});

test("list_sitemaps and get_sitemap render Google's processing status", async () => {
  const { client, calls } = fakeClient();
  const listed = await call(client, "list_sitemaps", { site_url: "sc-domain:example.com" });
  assert.equal(
    listed.text,
    "1 sitemap for sc-domain:example.com:\n" +
      "- https://example.com/sitemap.xml (sitemap index)\n" +
      "  submitted 2026-09-14T08:12:40.000Z; last read by Google 2026-10-27T03:01:22.000Z\n" +
      "  errors 0, warnings 1\n" +
      "  web: 1840 submitted\n",
  );
  const got = await call(client, "get_sitemap", {
    site_url: "sc-domain:example.com",
    feedpath: "https://example.com/sitemap.xml",
  });
  assert.match(got.text, /pending \(not yet processed\)/);
  assert.match(got.text, /never read by Google/);
  assert.deepEqual(calls[1].args, ["sc-domain:example.com", "https://example.com/sitemap.xml"]);
});

test("inspect_url sends the API's field names and renders the verdict and why", async () => {
  const { client, calls } = fakeClient();
  const { text } = await call(client, "inspect_url", {
    site_url: "sc-domain:example.com",
    inspection_url: "https://example.com/draft",
    language_code: "de",
  });
  assert.deepEqual(calls[0].args[0], {
    inspectionUrl: "https://example.com/draft",
    siteUrl: "sc-domain:example.com",
    languageCode: "de",
  } satisfies UrlInspectionRequest);
  assert.match(text, /^# https:\/\/example\.com\/draft\n\*\*Verdict:\*\* NEUTRAL\n\*\*Coverage:\*\* Excluded by 'noindex' tag/);
  assert.match(text, /\*\*Last crawl:\*\* 2026-10-25T11:42:07Z \(as MOBILE\)/);
  assert.match(text, /\*\*Referring URLs:\*\* a, b, c, d, e \(and 2 more\)/);
  assert.match(text, /\*\*Rich results:\*\* PASS — Breadcrumbs/);
  assert.match(text, /\*\*Open in Search Console:\*\* https:\/\/search\.google\.com/);
});

test("inspect_url refuses a relative inspection_url before calling Google", async () => {
  const { client, calls } = fakeClient();
  const { isError, text } = await call(client, "inspect_url", { site_url: "sc-domain:example.com", inspection_url: "/pricing" });
  assert.equal(isError, true);
  assert.match(text, /inspection_url/);
  assert.equal(calls.length, 0);
});
