import { describe, expect, it, vi } from "vitest";
import {
  AccessTokenMinter,
  REFRESH_MARGIN_MS,
  REJECTION_FLOOR_MS,
  TokenRefreshError,
  bearerIn,
  tokenUrlAllowed,
  withBearer,
  type RefreshGrant,
} from "../src/gateway/adapters/oauth-refresh.ts";

/**
 * The minter on its own: what it sends, what it accepts, and the rules that are
 * easier to pin with a stub `fetch` and a hand-driven clock than end to end.
 * The end-to-end behaviour is test/oauth-refresh.e2e.test.ts.
 */

interface Call {
  url: string;
  init: RequestInit;
  body: URLSearchParams;
}

function stubFetch(
  answers: Array<{ status?: number; json?: unknown; text?: string } | Error>,
): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init, body: new URLSearchParams(String(init.body)) });
    const next = answers.shift();
    if (!next) throw new Error("no answer queued");
    if (next instanceof Error) throw next;
    const body =
      next.text !== undefined ? next.text : JSON.stringify(next.json ?? {});
    return new Response(body, {
      status: next.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const GRANT: RefreshGrant = {
  tokenUrl: "https://auth.example.com/oauth2/token",
  clientId: "client id+1",
  clientAuth: "basic",
  refreshToken: "rt-seed",
};

function minter(
  answers: Parameters<typeof stubFetch>[0],
  extra: Partial<ConstructorParameters<typeof AccessTokenMinter>[0]> = {},
) {
  let now = 1_000_000;
  const stub = stubFetch(answers);
  const m = new AccessTokenMinter({
    slug: "granola",
    variable: "GRANOLA_REFRESH_TOKEN",
    fetchImpl: stub.fetchImpl,
    now: () => now,
    ...extra,
  });
  return {
    m,
    calls: stub.calls,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("what a refresh sends", () => {
  it("a public client: the refresh-token grant with client_id in the body, no Authorization", async () => {
    const { m, calls } = minter([{ json: { access_token: "at-1" } }]);
    expect(await m.accessToken(GRANT)).toBe("at-1");
    const [call] = calls;
    expect(call!.url).toBe(GRANT.tokenUrl);
    expect(call!.init.method).toBe("POST");
    // A 307 would resend the body, and the body is the refresh token.
    expect(call!.init.redirect).toBe("error");
    expect(new Headers(call!.init.headers).get("authorization")).toBeNull();
    expect(Object.fromEntries(call!.body)).toEqual({
      grant_type: "refresh_token",
      refresh_token: "rt-seed",
      client_id: "client id+1",
    });
  });

  it("a confidential client with `basic`: form-encoded halves in HTTP Basic, no secret in the body", async () => {
    const { m, calls } = minter([{ json: { access_token: "at-1" } }]);
    await m.accessToken({ ...GRANT, clientSecret: "s3cr:et" });
    const header = new Headers(calls[0]!.init.headers).get("authorization")!;
    expect(
      Buffer.from(header.replace(/^Basic /, ""), "base64").toString(),
    ).toBe("client+id%2B1:s3cr%3Aet");
    expect(calls[0]!.body.has("client_secret")).toBe(false);
    expect(calls[0]!.body.has("client_id")).toBe(false);
  });

  it("a confidential client with `post`: both in the body", async () => {
    const { m, calls } = minter([{ json: { access_token: "at-1" } }]);
    await m.accessToken({
      ...GRANT,
      clientSecret: "s3cret",
      clientAuth: "post",
    });
    expect(calls[0]!.body.get("client_id")).toBe("client id+1");
    expect(calls[0]!.body.get("client_secret")).toBe("s3cret");
  });

  it("scope and RFC 8707 resource, when configured", async () => {
    const { m, calls } = minter([{ json: { access_token: "at-1" } }]);
    await m.accessToken({
      ...GRANT,
      scope: "read write",
      resource: "https://mcp.example.com/mcp",
    });
    expect(calls[0]!.body.get("scope")).toBe("read write");
    expect(calls[0]!.body.get("resource")).toBe("https://mcp.example.com/mcp");
  });

  it("refuses to send a refresh token over plain http, except to loopback", async () => {
    const { m, calls } = minter([]);
    const err = await m
      .accessToken({ ...GRANT, tokenUrl: "http://auth.example.com/token" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TokenRefreshError);
    expect((err as TokenRefreshError).failure).toBe("misconfigured");
    expect(calls).toHaveLength(0);

    expect(tokenUrlAllowed("https://a.example/t")).toBe(true);
    expect(tokenUrlAllowed("http://127.0.0.1:9/t")).toBe(true);
    expect(tokenUrlAllowed("http://localhost/t")).toBe(true);
    expect(tokenUrlAllowed("http://[::1]/t")).toBe(true);
    expect(tokenUrlAllowed("http://10.0.0.1/t")).toBe(false);
    expect(tokenUrlAllowed("ftp://a.example/t")).toBe(false);
    expect(tokenUrlAllowed("not a url")).toBe(false);
  });
});

describe("what a refresh accepts", () => {
  it.each([
    ["no access_token", { token_type: "Bearer" }],
    ["an empty access_token", { access_token: "" }],
    ["a non-bearer token_type", { access_token: "at", token_type: "mac" }],
  ])("%s is malformed", async (_label, json) => {
    const { m } = minter([{ json }]);
    const err = await m.accessToken(GRANT).catch((e: unknown) => e);
    expect((err as TokenRefreshError).failure).toBe("malformed");
  });

  it("a non-JSON 200 is malformed, and its body is not quoted", async () => {
    const { m } = minter([{ text: "<html>at-leaked</html>" }]);
    const err = (await m.accessToken(GRANT).catch((e: unknown) => e)) as Error;
    expect((err as TokenRefreshError).failure).toBe("malformed");
    expect(err.message).not.toContain("leaked");
  });

  it("token_type is case-insensitive, and expires_in may be a numeric string", async () => {
    const { m, advance, calls } = minter([
      {
        json: { access_token: "at-1", token_type: "bearer", expires_in: "600" },
      },
      { json: { access_token: "at-2" } },
    ]);
    expect(await m.accessToken(GRANT)).toBe("at-1");
    advance(600_000 - 60_000 - 1);
    expect(await m.accessToken(GRANT)).toBe("at-1");
    advance(2);
    expect(await m.accessToken(GRANT)).toBe("at-2");
    expect(calls).toHaveLength(2);
  });

  it("refreshes REFRESH_MARGIN_MS early for an hour-long token, a tenth early for a short one", async () => {
    const hour = minter([
      { json: { access_token: "a", expires_in: 3600 } },
      { json: { access_token: "b", expires_in: 3600 } },
    ]);
    await hour.m.accessToken(GRANT);
    hour.advance(3600_000 - REFRESH_MARGIN_MS - 1);
    expect(await hour.m.accessToken(GRANT)).toBe("a");
    hour.advance(1);
    expect(await hour.m.accessToken(GRANT)).toBe("b");

    const short = minter([
      { json: { access_token: "a", expires_in: 100 } },
      { json: { access_token: "b", expires_in: 100 } },
    ]);
    await short.m.accessToken(GRANT);
    short.advance(90_000 - 1);
    expect(await short.m.accessToken(GRANT)).toBe("a");
    short.advance(1);
    expect(await short.m.accessToken(GRANT)).toBe("b");
  });

  it("an error code outside RFC 6749's vocabulary is not relayed; error_description never is", async () => {
    const { m } = minter([
      {
        status: 400,
        json: { error: "rt-seed was bad", error_description: "rt-seed" },
      },
    ]);
    const err = (await m.accessToken(GRANT).catch((e: unknown) => e)) as Error;
    expect((err as TokenRefreshError).failure).toBe("refused");
    expect(err.message).toContain("HTTP 400");
    expect(err.message).not.toContain("rt-seed");
  });

  it("invalid_client names the client, not the refresh token", async () => {
    const { m } = minter([{ status: 401, json: { error: "invalid_client" } }]);
    const err = (await m.accessToken(GRANT).catch((e: unknown) => e)) as Error;
    expect(err.message).toContain("refused the OAuth client (invalid_client)");
    expect((err as TokenRefreshError).telemetryKind).toBe("upstream_error");
  });

  it.each([429, 500, 503])("HTTP %i is unavailable", async (status) => {
    const { m } = minter([{ status }]);
    const err = await m.accessToken(GRANT).catch((e: unknown) => e);
    expect((err as TokenRefreshError).failure).toBe("unavailable");
  });

  it("a network failure is unavailable", async () => {
    const { m } = minter([new TypeError("fetch failed")]);
    const err = await m.accessToken(GRANT).catch((e: unknown) => e);
    expect((err as TokenRefreshError).failure).toBe("unavailable");
  });
});

describe("reject()", () => {
  it("drops the held token only when it is the one refused, and only past the floor", async () => {
    const { m, advance, calls } = minter([
      { json: { access_token: "at-1" } },
      { json: { access_token: "at-2" } },
    ]);
    expect(await m.accessToken(GRANT)).toBe("at-1");

    // Fresh: not refused for its age, so keep it.
    m.reject("at-1");
    expect(await m.accessToken(GRANT)).toBe("at-1");

    advance(REJECTION_FLOOR_MS);
    // A token that is not the held one changes nothing.
    m.reject("at-0");
    expect(await m.accessToken(GRANT)).toBe("at-1");

    m.reject("at-1");
    expect(await m.accessToken(GRANT)).toBe("at-2");
    expect(calls).toHaveLength(2);
  });
});

describe("rotation write-back", () => {
  it("writes each rotation once, in order, and skips one a later rotation superseded", async () => {
    let releaseFirst = (): void => {};
    const firstWrite = new Promise<void>((r) => {
      releaseFirst = r;
    });
    const written: string[] = [];
    const persist = vi.fn(async (value: string) => {
      if (written.length === 0 && value === "rt-1") await firstWrite;
      written.push(value);
    });
    const { m, advance } = minter(
      [
        { json: { access_token: "a", expires_in: 600, refresh_token: "rt-1" } },
        { json: { access_token: "b", expires_in: 600, refresh_token: "rt-2" } },
        { json: { access_token: "c", expires_in: 600, refresh_token: "rt-3" } },
      ],
      { persist },
    );
    await m.accessToken(GRANT);
    advance(600_000);
    await m.accessToken(GRANT);
    advance(600_000);
    await m.accessToken(GRANT);
    releaseFirst();
    await m.settled();

    // rt-1's write was already running; rt-2 was superseded before its turn.
    expect(written).toEqual(["rt-1", "rt-3"]);
  });

  it("a write-back that fails does not fail the request", async () => {
    const persist = vi.fn(async () => {
      throw new Error("store down");
    });
    const { m } = minter(
      [{ json: { access_token: "a", refresh_token: "rt-1" } }],
      { persist },
    );
    expect(await m.accessToken(GRANT)).toBe("a");
    await m.settled();
    expect(persist).toHaveBeenCalledWith("rt-1");
  });

  it("the store handing back an OLDER rotation of this lineage is not a re-seed", async () => {
    const { m, advance, calls } = minter([
      { json: { access_token: "a", expires_in: 600, refresh_token: "rt-1" } },
      { json: { access_token: "b", expires_in: 600, refresh_token: "rt-2" } },
      { json: { access_token: "c", expires_in: 600 } },
    ]);
    await m.accessToken(GRANT);
    advance(600_000);
    await m.accessToken({ ...GRANT, refreshToken: "rt-1" });
    advance(600_000);
    // The store trails: it holds rt-1, while the provider has already moved to
    // rt-2 and killed rt-1. The exchange must spend rt-2.
    expect(await m.accessToken({ ...GRANT, refreshToken: "rt-1" })).toBe("c");
    expect(calls.map((c) => c.body.get("refresh_token"))).toEqual([
      "rt-seed",
      "rt-1",
      "rt-2",
    ]);
  });

  it("a changed client is a new lineage even with the same refresh token", async () => {
    const { m, calls } = minter([
      { json: { access_token: "a" } },
      { json: { access_token: "b" } },
    ]);
    expect(await m.accessToken(GRANT)).toBe("a");
    expect(await m.accessToken({ ...GRANT, clientId: "other" })).toBe("b");
    expect(calls).toHaveLength(2);
  });
});

describe("header helpers", () => {
  it("withBearer replaces every spelling of Authorization, and bearerIn reads it back", () => {
    const headers = withBearer(
      { Authorization: "Bearer old", "x-extra": "1" },
      "new",
    );
    expect(headers).toEqual({ "x-extra": "1", authorization: "Bearer new" });
    expect(bearerIn(headers)).toBe("new");
    expect(bearerIn({ AUTHORIZATION: "bearer t" })).toBe("t");
    expect(bearerIn({ authorization: "Basic abc" })).toBeNull();
    expect(bearerIn({})).toBeNull();
  });
});
