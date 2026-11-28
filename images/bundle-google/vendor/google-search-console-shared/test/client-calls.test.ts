/**
 * What actually goes on the wire.
 *
 * None of this is visible to a credential-free smoke test, and each one decides
 * what a call reaches: a property not encoded WHOLE into the path (`sc-domain:`
 * and the slashes of a URL-prefix property included) addresses a different
 * resource or none, and every call here must be a read.
 */
import { test, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";

import {
  getSite,
  getSitemap,
  inspectUrl,
  listSitemaps,
  listSites,
  querySearchAnalytics,
} from "../src/client/api.js";
import { SearchConsoleApiError } from "../src/client/api-errors.js";

const HEADERS = { Authorization: "Bearer test" };

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}
let calls: Call[] = [];
let responses: Array<() => Response> = [];
const realFetch = globalThis.fetch;

function json(body: unknown, status = 200, headers: Record<string, string> = {}): () => Response {
  return () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

beforeEach(() => {
  calls = [];
  responses = [];
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    calls.push({
      url: String(url),
      method: init.method ?? "GET",
      headers: (init.headers ?? {}) as Record<string, string>,
      body: init.body,
    });
    const next = responses.shift();
    return next ? next() : new Response("{}", { status: 200 });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("sites.list is a GET on webmasters/v3", async () => {
  responses.push(json({ siteEntry: [] }));
  await listSites(HEADERS);
  assert.equal(calls[0].url, "https://www.googleapis.com/webmasters/v3/sites");
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].headers.Authorization, "Bearer test");
});

test("a Domain property is encoded whole, colon included", async () => {
  await getSite(HEADERS, "sc-domain:example.com");
  assert.equal(calls[0].url, "https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com");
});

test("a URL-prefix property is encoded whole, slashes included", async () => {
  await getSite(HEADERS, "https://www.example.com/");
  assert.equal(calls[0].url, "https://www.googleapis.com/webmasters/v3/sites/https%3A%2F%2Fwww.example.com%2F");
});

test("search analytics is a POST of the request body to the property's searchAnalytics/query", async () => {
  responses.push(json({ rows: [] }));
  const body = { startDate: "2026-10-01", endDate: "2026-10-28", dimensions: ["query" as const], rowLimit: 10 };
  await querySearchAnalytics(HEADERS, "sc-domain:example.com", body);
  assert.equal(
    calls[0].url,
    "https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query",
  );
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].headers["Content-Type"], "application/json");
  assert.equal(calls[0].headers.Authorization, "Bearer test");
  assert.deepEqual(JSON.parse(String(calls[0].body)), body);
});

test("sitemaps.list passes sitemapIndex only when asked, and sitemaps.get encodes the feedpath", async () => {
  await listSitemaps(HEADERS, "sc-domain:example.com");
  await listSitemaps(HEADERS, "sc-domain:example.com", "https://example.com/sitemap_index.xml");
  await getSitemap(HEADERS, "https://example.com/", "https://example.com/sitemap.xml");
  assert.equal(calls[0].url, "https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/sitemaps");
  assert.equal(
    calls[1].url,
    "https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/sitemaps?sitemapIndex=https%3A%2F%2Fexample.com%2Fsitemap_index.xml",
  );
  assert.equal(
    calls[2].url,
    "https://www.googleapis.com/webmasters/v3/sites/https%3A%2F%2Fexample.com%2F/sitemaps/https%3A%2F%2Fexample.com%2Fsitemap.xml",
  );
  assert.ok(calls.every((c) => c.method === "GET"));
});

test("URL inspection is a POST to searchconsole v1 with the API's field names", async () => {
  responses.push(json({ inspectionResult: {} }));
  await inspectUrl(HEADERS, { inspectionUrl: "https://example.com/a", siteUrl: "sc-domain:example.com" });
  assert.equal(calls[0].url, "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect");
  assert.equal(calls[0].method, "POST");
  assert.deepEqual(JSON.parse(String(calls[0].body)), {
    inspectionUrl: "https://example.com/a",
    siteUrl: "sc-domain:example.com",
  });
});

test("a 429 is retried once, after its Retry-After", async () => {
  responses.push(json({ error: { message: "slow down" } }, 429, { "retry-after": "0" }));
  responses.push(json({ siteEntry: [{ siteUrl: "sc-domain:example.com" }] }));
  const result = await listSites(HEADERS);
  assert.equal(calls.length, 2);
  assert.equal(result.siteEntry?.[0].siteUrl, "sc-domain:example.com");
});

test("a second 429 is a rate-limit error that says to wait", async () => {
  responses.push(json({ error: { message: "slow down" } }, 429, { "retry-after": "0" }));
  responses.push(json({ error: { message: "Quota exceeded" } }, 429, { "retry-after": "0" }));
  const error = await listSites(HEADERS).catch((e: unknown) => e);
  assert.ok(error instanceof SearchConsoleApiError);
  assert.equal(error.category, "rate_limit");
  assert.match(error.message, /Rate limit exceeded \(sites\.list\): 429/);
  assert.match(error.message, /Wait a minute/);
});

test("a 403 for a missing scope names webmasters.readonly", async () => {
  responses.push(
    json(
      {
        error: {
          code: 403,
          message: "Request had insufficient authentication scopes.",
          status: "PERMISSION_DENIED",
          details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }],
        },
      },
      403,
    ),
  );
  const error = await inspectUrl(HEADERS, { inspectionUrl: "https://example.com/", siteUrl: "sc-domain:example.com" }).catch(
    (e: unknown) => e,
  );
  assert.ok(error instanceof SearchConsoleApiError);
  assert.equal(error.category, "forbidden");
  assert.match(error.message, /https:\/\/www\.googleapis\.com\/auth\/webmasters\.readonly/);
});

test("a 403 on a property the account cannot see says to use list_sites' exact spelling", async () => {
  responses.push(
    json(
      {
        error: {
          code: 403,
          message: "User does not have sufficient permission for site 'https://example.com/'.",
          errors: [{ reason: "forbidden" }],
        },
      },
      403,
    ),
  );
  const error = await getSite(HEADERS, "https://example.com/").catch((e: unknown) => e);
  assert.ok(error instanceof SearchConsoleApiError);
  assert.match(error.message, /Permission denied \(sites\.get\)/);
  assert.match(error.message, /list_sites/);
  assert.match(error.message, /sc-domain:example\.com/);
});

test("a disabled API names the API to enable", async () => {
  responses.push(
    json(
      {
        error: {
          code: 403,
          message: "Google Search Console API has not been used in project 123 before or it is disabled.",
          errors: [{ reason: "accessNotConfigured" }],
        },
      },
      403,
    ),
  );
  const error = await listSites(HEADERS).catch((e: unknown) => e);
  assert.match(String((error as Error).message), /searchconsole\.googleapis\.com/);
});

test("a 401 is categorised auth, which is what makes the client drop its token", async () => {
  responses.push(json({ error: { message: "Invalid Credentials" } }, 401));
  const error = await listSites(HEADERS).catch((e: unknown) => e);
  assert.ok(error instanceof SearchConsoleApiError);
  assert.equal(error.category, "auth");
  assert.match(error.message, /Authentication failed/);
});
