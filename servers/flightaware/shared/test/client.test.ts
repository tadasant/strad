import { describe, expect, it } from "vitest";

import {
  createClient,
  describeError,
  nextCursor,
  retryAfterSeconds,
} from "../src/client.js";
import {
  AeroApiError,
  AuthError,
  NotFoundError,
  PlanError,
  RateLimitError,
} from "../src/errors.js";
import { FakeAeroApi, KEY } from "./fake-aeroapi.js";

const BASE = "https://aeroapi.example/aeroapi";

function build(fake = new FakeAeroApi()) {
  const client = createClient({
    config: { apiKey: KEY, baseUrl: BASE },
    fetchImpl: fake.fetch,
  });
  return { fake, client };
}

describe("the request", () => {
  it("is a GET with the key in x-apikey and nothing in Authorization", async () => {
    const { fake, client } = build();
    await client.get("/operators/UAL");
    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0]!;
    expect(call.method).toBe("GET");
    expect(call.url.toString()).toBe(`${BASE}/operators/UAL`);
    expect(call.headers["x-apikey"]).toBe(KEY);
    expect(call.headers.authorization).toBeUndefined();
    expect(call.headers.accept).toBe("application/json");
  });

  it("drops undefined query values rather than sending them empty", async () => {
    const { fake, client } = build();
    await client.get("/flights/UAL4", {
      start: undefined,
      max_pages: 1,
      ident_type: "designator",
    });
    const params = fake.calls[0]!.url.searchParams;
    expect(params.has("start")).toBe(false);
    expect(params.get("max_pages")).toBe("1");
    expect(params.get("ident_type")).toBe("designator");
  });
});

describe("errors", () => {
  const cases: Array<[number, unknown]> = [
    [401, AuthError],
    [402, PlanError],
    [403, PlanError],
    [404, NotFoundError],
    [429, RateLimitError],
    [400, AeroApiError],
    [503, AeroApiError],
  ];
  for (const [status, type] of cases) {
    it(`classifies HTTP ${status}`, async () => {
      const fake = new FakeAeroApi();
      fake.failWith(status, { title: "Nope", detail: "because", status });
      const { client } = build(fake);
      const err = await client.get("/operators/UAL").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(type as never);
      expect((err as AeroApiError).status).toBe(status);
      expect((err as Error).message).toContain("Nope: because");
    });
  }

  it("says a 402/403 is the plan, not the key", async () => {
    const fake = new FakeAeroApi();
    fake.failWith(403, { title: "Forbidden" });
    const err = await build(fake)
      .client.get("/operators/UAL")
      .catch((e: Error) => e);
    expect(err.message).toMatch(/tier/);
    expect(err.message).toMatch(/key is valid/);
  });

  it("carries Retry-After on a 429 and does NOT retry", async () => {
    const fake = new FakeAeroApi();
    fake.failWith(429, { title: "Too Many Requests" }, { "retry-after": "7" });
    const { client } = build(fake);
    const err = (await client
      .get("/operators/UAL")
      .catch((e: unknown) => e)) as RateLimitError;
    expect(err.retryAfterSeconds).toBe(7);
    expect(fake.calls).toHaveLength(1);
  });

  it("converts an HTTP-date Retry-After into seconds", () => {
    const now = Date.parse("2026-10-09T12:00:00Z");
    const at = (v: string) =>
      retryAfterSeconds(new Headers({ "retry-after": v }), now);
    expect(at("Fri, 09 Oct 2026 12:02:00 GMT")).toBe(120);
    expect(at("Fri, 09 Oct 2026 11:00:00 GMT")).toBe(0);
    expect(at("12")).toBe(12);
    expect(at("soon")).toBeUndefined();
    expect(retryAfterSeconds(new Headers(), now)).toBeUndefined();
  });

  it("carries a date-form Retry-After on a 429 as seconds", async () => {
    const fake = new FakeAeroApi();
    const when = new Date(Date.now() + 90_000).toUTCString();
    fake.failWith(429, { title: "Too Many Requests" }, { "retry-after": when });
    const err = (await build(fake)
      .client.get("/operators/UAL")
      .catch((e: unknown) => e)) as RateLimitError;
    expect(err.retryAfterSeconds).toBeGreaterThanOrEqual(88);
    expect(err.retryAfterSeconds).toBeLessThanOrEqual(91);
  });

  it("names the flight window on a /flights/ 404 only", async () => {
    const fake = new FakeAeroApi();
    fake.failWith(404, { title: "Not Found" });
    const { client } = build(fake);
    const flight = (await client
      .get("/flights/UAL4")
      .catch((e: unknown) => e)) as Error;
    const airport = (await client
      .get("/airports/KJFK")
      .catch((e: unknown) => e)) as Error;
    expect(flight.message).toMatch(/10-day window/);
    expect(airport).toBeInstanceOf(NotFoundError);
    expect(airport.message).not.toMatch(/window/);
  });

  it("says on a 401 that strad may slug-prefix the variable", async () => {
    const fake = new FakeAeroApi();
    fake.failWith(401, { title: "Unauthorized" });
    const err = (await build(fake)
      .client.get("/operators/UAL")
      .catch((e: unknown) => e)) as Error;
    expect(err.message).toContain("AEROAPI_API_KEY");
    expect(err.message).toContain("FLIGHTAWARE__AEROAPI_API_KEY");
  });

  for (const [label, text] of [
    ["HTML", "<html>captive portal</html>"],
    ["a JSON array", "[1,2]"],
    ["a JSON string", '"ok"'],
    ["JSON null", "null"],
  ] as const) {
    it(`refuses a 2xx whose body is ${label}, retryable`, async () => {
      const fake = new FakeAeroApi();
      fake.answerText("/aeroapi/flights/UAL4", 200, text);
      const err = (await build(fake)
        .client.get("/flights/UAL4")
        .catch((e: unknown) => e)) as AeroApiError;
      expect(err).toBeInstanceOf(AeroApiError);
      expect(err.message).toMatch(
        /AeroAPI answered HTTP 200 with a non-JSON body/,
      );
      expect(err.retryable).toBe(true);
      expect(err.status).toBe(200);
    });
  }

  it("still accepts an empty 2xx body", async () => {
    const fake = new FakeAeroApi();
    fake.answerText("/aeroapi/flights/UAL4", 200, "");
    expect(await build(fake).client.get("/flights/UAL4")).toBeUndefined();
  });

  it("scrubs the key when AeroAPI echoes it back", async () => {
    const fake = new FakeAeroApi();
    fake.failWith(401, { title: "Unauthorized", detail: `bad key ${KEY}` });
    const err = (await build(fake)
      .client.get("/operators/UAL")
      .catch((e: unknown) => e)) as Error;
    expect(err.message).not.toContain(KEY);
    expect(err.message).toContain("[redacted]");
  });

  it("caps a long upstream error body", () => {
    const text = describeError({ title: "x", detail: "y".repeat(5000) }, 400);
    expect(text.length).toBeLessThan(320);
  });

  it("falls back to the status for a non-JSON body", () => {
    expect(describeError(undefined, 502)).toBe("AeroAPI answered HTTP 502");
  });

  it("times out a request that never answers", async () => {
    const hang: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new Error("aborted")),
        );
      });
    const client = createClient({
      config: { apiKey: KEY, baseUrl: BASE },
      fetchImpl: hang,
      timeoutMs: 20,
    });
    const err = (await client
      .get("/operators/UAL")
      .catch((e: unknown) => e)) as AeroApiError;
    expect(err).toBeInstanceOf(AeroApiError);
    expect(err.message).toMatch(/did not answer/);
    expect(err.retryable).toBe(true);
  });
});

describe("nextCursor", () => {
  it("takes only the cursor out of links.next", () => {
    expect(
      nextCursor({ next: "/flights/search?query=-origin+KSFO&cursor=abc123" }),
    ).toBe("abc123");
  });
  it("decodes a percent-encoded cursor", () => {
    expect(nextCursor({ next: "/flights/search?cursor=a%2Fb%2Bc%3D%3D" })).toBe(
      "a/b+c==",
    );
  });
  it("takes only the cursor from a foreign-origin link", () => {
    expect(
      nextCursor({ next: "https://evil.example/steal?cursor=ZZ&x=1" }),
    ).toBe("ZZ");
  });
  it("is undefined at the end of a collection", () => {
    expect(nextCursor(null)).toBeUndefined();
    expect(nextCursor({})).toBeUndefined();
    expect(nextCursor({ next: "/flights/search?query=x" })).toBeUndefined();
  });
});
