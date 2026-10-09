import { describe, it, expect, vi } from "vitest";
import {
  RefreshTokenProvider,
  StaticAccessTokenProvider,
} from "../../shared/src/x-client/auth.js";
import { XAuthError } from "../../shared/src/x-client/api-errors.js";
import { createTokenProviderFromEnv } from "../../shared/src/x-client/index.js";

/**
 * Builds a fake `fetch` that returns the given sequence of token responses,
 * one per call. Each entry is either a TokenResponse-ish object (200) or a
 * `{ status, body }` failure.
 */
function tokenFetchSequence(
  responses: Array<
    | { access_token: string; refresh_token?: string; expires_in?: number }
    | { status: number; body: string }
  >,
) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;
  const impl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if ("status" in r) {
      return new Response(r.body, { status: r.status });
    }
    return new Response(
      JSON.stringify({
        access_token: r.access_token,
        refresh_token: r.refresh_token,
        token_type: "bearer",
        expires_in: r.expires_in ?? 7200,
        scope: "tweet.read users.read bookmark.read offline.access",
      }),
      { status: 200 },
    );
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

describe("RefreshTokenProvider", () => {
  it("exchanges the refresh token for an access token with HTTP Basic auth", async () => {
    const { impl, calls } = tokenFetchSequence([
      { access_token: "access-1", refresh_token: "refresh-2" },
    ]);
    const provider = new RefreshTokenProvider({
      clientId: "my-client",
      clientSecret: "my-secret",
      refreshToken: "refresh-1",
      fetchImpl: impl,
    });

    const token = await provider.getAccessToken();
    expect(token).toBe("access-1");

    // Verify the request shape.
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0];
    expect(url).toBe("https://api.x.com/2/oauth2/token");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    const expectedBasic = Buffer.from("my-client:my-secret").toString("base64");
    expect(headers.Authorization).toBe(`Basic ${expectedBasic}`);
    const body = new URLSearchParams(init.body as string);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("refresh-1");
    expect(body.get("client_id")).toBe("my-client");
  });

  it("rotates the refresh token in memory across refreshes (single-use tokens)", async () => {
    const { impl, calls } = tokenFetchSequence([
      { access_token: "access-1", refresh_token: "refresh-2", expires_in: 1 },
      { access_token: "access-2", refresh_token: "refresh-3", expires_in: 1 },
    ]);
    const provider = new RefreshTokenProvider({
      clientId: "c",
      clientSecret: "s",
      refreshToken: "refresh-1",
      fetchImpl: impl,
    });

    await provider.getAccessToken();
    expect(provider.refreshToken).toBe("refresh-2");

    // Expiry buffer forces a refresh on the next call; the rotated token must
    // be used, not the original single-use one.
    await provider.getAccessToken();
    expect(provider.refreshToken).toBe("refresh-3");

    const secondBody = new URLSearchParams(calls[1].init.body as string);
    expect(secondBody.get("refresh_token")).toBe("refresh-2");
  });

  it("hands every rotated token to onRefreshToken, in order", async () => {
    // The persistence hook is what makes a restart survivable: a host that can
    // store the value durably (strad's bundle host writes it to the parameter
    // store) sees each new token as it is minted, not only the last one.
    const { impl } = tokenFetchSequence([
      { access_token: "access-1", refresh_token: "refresh-2", expires_in: 1 },
      { access_token: "access-2", refresh_token: "refresh-3", expires_in: 1 },
    ]);
    const persisted: string[] = [];
    const provider = new RefreshTokenProvider({
      clientId: "c",
      clientSecret: "s",
      refreshToken: "refresh-1",
      fetchImpl: impl,
      onRefreshToken: async (token) => {
        persisted.push(token);
      },
    });

    await provider.getAccessToken();
    await provider.getAccessToken();

    expect(persisted).toEqual(["refresh-2", "refresh-3"]);
  });

  it("keeps serving when onRefreshToken fails", async () => {
    // A failed write means the NEXT restart is dead — it does not mean this
    // process is. Failing the refresh would turn a durable-storage outage into
    // an immediate one, so the rejection is swallowed here and reported by the
    // hook's owner (the strad mount marks itself degraded).
    const { impl } = tokenFetchSequence([
      { access_token: "access-1", refresh_token: "refresh-2", expires_in: 1 },
    ]);
    const provider = new RefreshTokenProvider({
      clientId: "c",
      clientSecret: "s",
      refreshToken: "refresh-1",
      fetchImpl: impl,
      onRefreshToken: () => {
        throw new Error("the store said no");
      },
    });

    await expect(provider.getAccessToken()).resolves.toBe("access-1");
    // And the token still rotated in memory, so this process keeps working.
    expect(provider.refreshToken).toBe("refresh-2");
  });

  it("caches the access token within the expiry buffer window", async () => {
    const { impl, calls } = tokenFetchSequence([
      {
        access_token: "access-1",
        refresh_token: "refresh-2",
        expires_in: 7200,
      },
    ]);
    const provider = new RefreshTokenProvider({
      clientId: "c",
      clientSecret: "s",
      refreshToken: "refresh-1",
      fetchImpl: impl,
    });

    const a = await provider.getAccessToken();
    const b = await provider.getAccessToken();
    expect(a).toBe("access-1");
    expect(b).toBe("access-1");
    expect(calls).toHaveLength(1); // second call served from cache
  });

  it("collapses concurrent refreshes into a single request (mutex)", async () => {
    const { impl, calls } = tokenFetchSequence([
      {
        access_token: "access-1",
        refresh_token: "refresh-2",
        expires_in: 7200,
      },
    ]);
    const provider = new RefreshTokenProvider({
      clientId: "c",
      clientSecret: "s",
      refreshToken: "refresh-1",
      fetchImpl: impl,
    });

    const [a, b, c] = await Promise.all([
      provider.getAccessToken(),
      provider.getAccessToken(),
      provider.getAccessToken(),
    ]);
    expect([a, b, c]).toEqual(["access-1", "access-1", "access-1"]);
    expect(calls).toHaveLength(1);
  });

  it("forces a refresh after invalidate()", async () => {
    const { impl, calls } = tokenFetchSequence([
      {
        access_token: "access-1",
        refresh_token: "refresh-2",
        expires_in: 7200,
      },
      {
        access_token: "access-2",
        refresh_token: "refresh-3",
        expires_in: 7200,
      },
    ]);
    const provider = new RefreshTokenProvider({
      clientId: "c",
      clientSecret: "s",
      refreshToken: "refresh-1",
      fetchImpl: impl,
    });

    expect(await provider.getAccessToken()).toBe("access-1");
    provider.invalidate();
    expect(await provider.getAccessToken()).toBe("access-2");
    expect(calls).toHaveLength(2);
  });

  it("throws XAuthError when the token endpoint returns a non-2xx status", async () => {
    const { impl } = tokenFetchSequence([
      { status: 400, body: '{"error":"invalid_grant"}' },
    ]);
    const provider = new RefreshTokenProvider({
      clientId: "c",
      clientSecret: "s",
      refreshToken: "refresh-1",
      fetchImpl: impl,
    });

    await expect(provider.getAccessToken()).rejects.toBeInstanceOf(XAuthError);
  });
});

describe("StaticAccessTokenProvider", () => {
  it("returns the injected access token and never refreshes", async () => {
    const provider = new StaticAccessTokenProvider("injected-token");
    expect(await provider.getAccessToken()).toBe("injected-token");
    provider.invalidate();
    expect(await provider.getAccessToken()).toBe("injected-token");
  });
});

describe("createTokenProviderFromEnv with durable persistence", () => {
  const ENV = {
    X_OAUTH_CLIENT_ID: "c",
    X_OAUTH_CLIENT_SECRET: "s",
    X_OAUTH_REFRESH_TOKEN: "baked-into-the-deploy",
  };

  it("prefers the host's stored token over the one the deploy baked", () => {
    // THE RACE THIS CLOSES. A sibling process can rotate the token after the
    // render read it, which makes the baked value already dead by the time this
    // container boots. The stored one is the live one.
    const provider = createTokenProviderFromEnv(ENV, {
      refreshToken: "read-from-the-store",
    });
    expect(provider).toBeInstanceOf(RefreshTokenProvider);
    expect((provider as RefreshTokenProvider).refreshToken).toBe(
      "read-from-the-store",
    );
  });

  it("falls back to the baked token when the host could not read one", () => {
    // Undefined means "I could not read one", not "use nothing" — a store that
    // is briefly unreachable must degrade to the previous behaviour rather than
    // leave the server with no credential at all.
    const provider = createTokenProviderFromEnv(ENV, {
      refreshToken: undefined,
    });
    expect((provider as RefreshTokenProvider).refreshToken).toBe(
      "baked-into-the-deploy",
    );
  });

  it("is unchanged when no persistence is supplied", () => {
    const provider = createTokenProviderFromEnv(ENV);
    expect((provider as RefreshTokenProvider).refreshToken).toBe(
      "baked-into-the-deploy",
    );
  });

  it("still reaches static-token mode when only a stored token is missing", () => {
    const provider = createTokenProviderFromEnv(
      { X_OAUTH_ACCESS_TOKEN: "direct" },
      {},
    );
    expect(provider).toBeInstanceOf(StaticAccessTokenProvider);
  });
});

describe("grantedScopes", () => {
  it("reports what X granted with the latest access token, and nothing before one", async () => {
    const { impl } = tokenFetchSequence([
      { access_token: "access-1", refresh_token: "refresh-2" },
    ]);
    const provider = new RefreshTokenProvider({
      clientId: "c",
      clientSecret: "s",
      refreshToken: "refresh-1",
      fetchImpl: impl,
    });
    expect(provider.grantedScopes).toBeUndefined();
    await provider.getAccessToken();
    expect(provider.grantedScopes).toEqual([
      "tweet.read",
      "users.read",
      "bookmark.read",
      "offline.access",
    ]);
  });

  it("is unknown for a static access token", () => {
    expect(new StaticAccessTokenProvider("t").grantedScopes).toBeUndefined();
  });
});
