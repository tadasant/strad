import { describe, expect, it } from "vitest";

import { createHttp, paginate, parseErrors, PAGE_MAX } from "../src/client.js";
import { AuthError, BillApiError, RateLimitError } from "../src/errors.js";
import type { BillConfig } from "../src/config.js";
import { createGateway } from "../src/gateway.js";
import { FakeBill, fixture } from "./fake-bill.js";

const CONFIG: BillConfig = {
  apiToken: "s3cr3t-token-value",
  environment: "sandbox",
  baseUrl: "https://gateway.stage.bill.com/connect",
};

interface Recorded {
  url: string;
  init: RequestInit;
}

/** A `fetch` that answers a scripted queue and records what it was sent. */
function scriptedFetch(
  replies: Array<{ status: number; body?: unknown; headers?: Record<string, string> }>,
) {
  const seen: Recorded[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    seen.push({ url: String(url), init });
    const reply = replies.shift();
    if (!reply) throw new Error("scripted fetch ran out of replies");
    return new Response(
      reply.body === undefined ? "" : JSON.stringify(reply.body),
      { status: reply.status, headers: reply.headers },
    );
  }) as unknown as typeof fetch;
  return { impl, seen };
}

describe("authentication", () => {
  it("sends the token in a header literally named apiToken", async () => {
    // NOT `Authorization: Bearer`. Getting this wrong is how a reader ends up
    // on BILL's AP/AR API, which authenticates completely differently.
    const { impl, seen } = scriptedFetch([{ status: 200, body: { ok: true } }]);
    const http = createHttp({ config: CONFIG, fetchImpl: impl });
    await http.request("/v3/spend/budgets");

    const headers = seen[0]!.init.headers as Record<string, string>;
    expect(headers.apiToken).toBe(CONFIG.apiToken);
    expect(headers.Authorization).toBeUndefined();
    expect(seen[0]!.url).toBe(
      "https://gateway.stage.bill.com/connect/v3/spend/budgets",
    );
  });

  it("turns a 401 into a typed error that says retrying will not help", async () => {
    const { impl } = scriptedFetch([
      {
        status: 401,
        body: [{ code: "BDC_1010", message: "Invalid API token" }],
      },
    ]);
    const http = createHttp({ config: CONFIG, fetchImpl: impl });
    const error = await http
      .request("/v3/spend/budgets")
      .catch((e: unknown) => e as AuthError);
    expect(error).toBeInstanceOf(AuthError);
    expect(error.status).toBe(401);
    expect(error.message).toContain("BDC_1010");
    expect(error.message).toContain("Retrying will not help");
    // The environment is named, because a valid production token used against
    // sandbox looks exactly like a revoked one.
    expect(error.message).toContain("sandbox");
  });

  it("never echoes the token back in an error, even when BILL does", async () => {
    // BILL echoes request material into some errors, and an auth failure is
    // exactly where it might echo the credential. Scrubbed by VALUE in the
    // client rather than left to the shape rule in logging.ts, which has a
    // length threshold it cannot go below without destroying every uuid this
    // server returns.
    const { impl } = scriptedFetch([
      { status: 401, body: [{ message: `token ${CONFIG.apiToken} rejected` }] },
    ]);
    const http = createHttp({ config: CONFIG, fetchImpl: impl });
    const error = await http
      .request("/v3/spend/budgets")
      .catch((e: unknown) => e as Error);
    expect(error.message).not.toContain(CONFIG.apiToken);
    expect(error.message).toContain("[redacted]");
  });
});

describe("BILL's error shape", () => {
  it("reads an ARRAY of errors, which is what BILL actually sends", () => {
    // A caller that reads `body.message` reads undefined on every failure BILL
    // has.
    expect(
      parseErrors([{ code: "BDC_1144", message: "Max requests reached" }]),
    ).toEqual([{ code: "BDC_1144", message: "Max requests reached" }]);
  });

  it("survives a reply that is not BILL's shape at all", () => {
    // A load balancer's HTML 502 is not shaped like anything BILL documents.
    expect(parseErrors(undefined)).toEqual([]);
    expect(parseErrors({ message: "nope" })).toEqual([]);
    expect(parseErrors("<html>")).toEqual([]);
  });

  it("passes a 4xx through with BILL's own code, which its docs are indexed by", async () => {
    const { impl } = scriptedFetch([
      { status: 400, body: [{ code: "BDC_1322", message: "bad request" }] },
    ]);
    const http = createHttp({ config: CONFIG, fetchImpl: impl });
    const error = await http
      .request("/v3/spend/transactions")
      .catch((e: unknown) => e as BillApiError);
    expect(error).toBeInstanceOf(BillApiError);
    expect(error.status).toBe(400);
    expect(error.errors[0]?.code).toBe("BDC_1322");
  });
});

describe("the 60-calls-per-minute budget", () => {
  it("retries a 429 with exponential backoff, jittered", async () => {
    const slept: number[] = [];
    const { impl } = scriptedFetch([
      { status: 429, body: [{ code: "BDC_1144" }] },
      { status: 429, body: [{ code: "BDC_1144" }] },
      { status: 200, body: { results: [] } },
    ]);
    const http = createHttp({
      config: CONFIG,
      fetchImpl: impl,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    await http.request("/v3/spend/transactions");
    // 2^n seconds, BILL's own guidance, plus up to 25% jitter — several servers
    // in one container backing off in lockstep re-collide on the same second.
    expect(slept).toHaveLength(2);
    expect(slept[0]).toBeGreaterThanOrEqual(1000);
    expect(slept[0]).toBeLessThan(1250);
    expect(slept[1]).toBeGreaterThanOrEqual(2000);
    expect(slept[1]).toBeLessThan(2500);
  });

  it("honours a Retry-After that fits the budget", async () => {
    const slept: number[] = [];
    const { impl } = scriptedFetch([
      { status: 429, body: [], headers: { "retry-after": "12" } },
      { status: 200, body: {} },
    ]);
    const http = createHttp({
      config: CONFIG,
      fetchImpl: impl,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    await http.request("/v3/spend/transactions");
    // Exactly BILL's number, unjittered: it knows when its window rolls over.
    expect(slept).toEqual([12_000]);
  });

  it("refuses to sleep through a Retry-After longer than one tool call may take", async () => {
    // Honouring `Retry-After` unbounded is how a single `Retry-After: 3600`
    // parks an MCP tool call for an hour inside a process shared with
    // twenty-one other servers. The wait is handed to the CALLER, which can
    // schedule it, instead of being slept through here.
    const slept: number[] = [];
    const { impl, seen } = scriptedFetch([
      { status: 429, body: [], headers: { "retry-after": "3600" } },
    ]);
    const http = createHttp({
      config: CONFIG,
      fetchImpl: impl,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    const error = await http
      .request("/v3/spend/transactions")
      .catch((e: unknown) => e as RateLimitError);
    expect(error).toBeInstanceOf(RateLimitError);
    expect(error.retryAfterSeconds).toBe(3600);
    expect(slept, "nothing was slept through").toEqual([]);
    expect(seen, "and no further call was spent").toHaveLength(1);
  });

  it("surfaces a typed rate-limit error once the budget is spent", async () => {
    const { impl } = scriptedFetch([
      { status: 429, body: [] },
      { status: 429, body: [] },
    ]);
    const http = createHttp({
      config: CONFIG,
      fetchImpl: impl,
      sleep: async () => {},
      maxRetries: 1,
    });
    const error = await http
      .request("/v3/spend/transactions")
      .catch((e: unknown) => e as RateLimitError);
    expect(error).toBeInstanceOf(RateLimitError);
    expect(error.message).toContain("60");
  });

  it("does not retry a 4xx that is not transient", async () => {
    const { impl, seen } = scriptedFetch([{ status: 400, body: [] }]);
    const http = createHttp({
      config: CONFIG,
      fetchImpl: impl,
      sleep: async () => {},
    });
    await expect(http.request("/v3/spend/transactions")).rejects.toBeInstanceOf(
      BillApiError,
    );
    expect(seen).toHaveLength(1);
  });
});

describe("pagination", () => {
  it("walks pages up to the caller's limit and says when it stopped early", async () => {
    const bill = new FakeBill(fixture());
    const walked = await paginate<{ uuid: string }>(
      bill,
      "/v3/spend/custom-fields/tty_gl_0001/values",
      {},
      2,
      PAGE_MAX.customFields,
    );
    expect(walked.results).toHaveLength(2);
    expect(walked.truncated).toBe(true);

    const all = await paginate<{ uuid: string }>(
      bill,
      "/v3/spend/custom-fields/tty_gl_0001/values",
      {},
      100,
      PAGE_MAX.customFields,
    );
    expect(all.results).toHaveLength(4);
    expect(all.truncated).toBe(false);
  });

  it("never asks BILL for more than the endpoint's own cap", async () => {
    const bill = new FakeBill(fixture());
    await paginate(bill, "/v3/spend/transactions", {}, 500, PAGE_MAX.transactions);
    const asked = bill.calls.map((c) => Number(c.query.max));
    expect(Math.max(...asked)).toBeLessThanOrEqual(PAGE_MAX.transactions);
  });
});

describe("retired values need two queries, not one", () => {
  it("does not silently drop retired entries by omitting the filter", async () => {
    // `retired` is `eq`-only and defaults to false, so "everything" is a union.
    // A single unfiltered walk would look right and quietly return live values
    // only — which a diff would then run against.
    const bill = new FakeBill(fixture());
    const gateway = createGateway({ http: bill });

    const live = await gateway.listCodingOptions({
      field: "tty_gl_0001",
      limit: 100,
      include_retired: false,
    });
    expect(live.options.map((o) => o.value)).not.toContain("Retired Account");

    const all = await gateway.listCodingOptions({
      field: "tty_gl_0001",
      limit: 100,
      include_retired: true,
    });
    expect(all.options.map((o) => o.value)).toContain("Retired Account");
  });
});
