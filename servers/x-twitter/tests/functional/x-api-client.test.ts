import { describe, it, expect, vi } from "vitest";
import { XApiClient } from "../../shared/src/x-client/x-api-client.js";
import { XApiError } from "../../shared/src/x-client/api-errors.js";
import type { ITokenProvider } from "../../shared/src/x-client/auth.js";

/** A token provider that records invalidate() calls and hands out a token. */
function fakeTokenProvider(tokens: string[] = ["tok-1"]): ITokenProvider & {
  invalidateCount: number;
} {
  let i = 0;
  return {
    invalidateCount: 0,
    async getAccessToken() {
      const t = tokens[Math.min(i, tokens.length - 1)];
      return t;
    },
    invalidate() {
      this.invalidateCount += 1;
      i += 1;
    },
  };
}

interface FakeResponse {
  status?: number;
  json?: unknown;
  body?: string;
}

/** Builds a fetch stub returning queued responses and recording requests. */
function fakeFetch(responses: FakeResponse[]) {
  const requests: Array<{ url: string; headers: Record<string, string> }> = [];
  let i = 0;
  const impl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    requests.push({
      url: String(url),
      headers: (init?.headers as Record<string, string>) ?? {},
    });
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    const status = r.status ?? 200;
    const body = r.body ?? JSON.stringify(r.json ?? {});
    return new Response(body, { status });
  });
  return { impl: impl as unknown as typeof fetch, requests };
}

const ME = { id: "42", name: "Me", username: "me" };

describe("XApiClient", () => {
  it("getMe requests /users/me with user fields and a bearer token", async () => {
    const { impl, requests } = fakeFetch([{ json: { data: ME } }]);
    const client = new XApiClient({
      tokenProvider: fakeTokenProvider(),
      fetchImpl: impl,
    });

    const res = await client.getMe();
    expect(res.data?.username).toBe("me");

    const url = new URL(requests[0].url);
    expect(url.pathname).toBe("/2/users/me");
    expect(url.searchParams.get("user.fields")).toContain("public_metrics");
    expect(requests[0].headers.Authorization).toBe("Bearer tok-1");
  });

  it("getUserByUsername strips a leading @ and encodes the handle", async () => {
    const { impl, requests } = fakeFetch([{ json: { data: ME } }]);
    const client = new XApiClient({
      tokenProvider: fakeTokenProvider(),
      fetchImpl: impl,
    });

    await client.getUserByUsername("@me");
    const url = new URL(requests[0].url);
    expect(url.pathname).toBe("/2/users/by/username/me");
  });

  it("getHomeTimeline resolves the me id, then queries the timeline endpoint", async () => {
    const { impl, requests } = fakeFetch([
      { json: { data: ME } }, // getMe (id resolution)
      { json: { data: [], meta: { result_count: 0 } } }, // timeline
    ]);
    const client = new XApiClient({
      tokenProvider: fakeTokenProvider(),
      fetchImpl: impl,
    });

    await client.getHomeTimeline({ maxResults: 50 });
    expect(requests).toHaveLength(2);
    const timelineUrl = new URL(requests[1].url);
    expect(timelineUrl.pathname).toBe(
      "/2/users/42/timelines/reverse_chronological",
    );
    expect(timelineUrl.searchParams.get("max_results")).toBe("50");
    expect(timelineUrl.searchParams.get("tweet.fields")).toContain(
      "note_tweet",
    );
  });

  it("caches the me id so a second list call does not re-fetch /users/me", async () => {
    const { impl, requests } = fakeFetch([
      { json: { data: ME } }, // getMe
      { json: { data: [] } }, // timeline
      { json: { data: [] } }, // bookmarks
    ]);
    const client = new XApiClient({
      tokenProvider: fakeTokenProvider(),
      fetchImpl: impl,
    });

    await client.getHomeTimeline({});
    await client.getBookmarks({});
    // 1 getMe + 2 list calls = 3 total (me id resolved once)
    expect(requests).toHaveLength(3);
    expect(new URL(requests[2].url).pathname).toBe("/2/users/42/bookmarks");
  });

  it("clamps max_results into the X API range", async () => {
    const { impl, requests } = fakeFetch([{ json: { data: [] } }]);
    const client = new XApiClient({
      tokenProvider: fakeTokenProvider(),
      fetchImpl: impl,
    });

    await client.searchRecent({ query: "mcp", maxResults: 999 });
    const url = new URL(requests[0].url);
    expect(url.pathname).toBe("/2/tweets/search/recent");
    expect(url.searchParams.get("query")).toBe("mcp");
    expect(url.searchParams.get("max_results")).toBe("100");
  });

  it("raises search max_results below the endpoint minimum up to 10", async () => {
    const { impl, requests } = fakeFetch([{ json: { data: [] } }]);
    const client = new XApiClient({
      tokenProvider: fakeTokenProvider(),
      fetchImpl: impl,
    });

    // Recent search rejects max_results < 10; timelines/bookmarks accept 5.
    await client.searchRecent({ query: "mcp", maxResults: 5 });
    const url = new URL(requests[0].url);
    expect(url.searchParams.get("max_results")).toBe("10");
  });

  it("getTweets joins ids into a comma-separated ids param", async () => {
    const { impl, requests } = fakeFetch([{ json: { data: [] } }]);
    const client = new XApiClient({
      tokenProvider: fakeTokenProvider(),
      fetchImpl: impl,
    });

    await client.getTweets(["1", "2", "3"]);
    const url = new URL(requests[0].url);
    expect(url.pathname).toBe("/2/tweets");
    expect(url.searchParams.get("ids")).toBe("1,2,3");
  });

  it("invalidates the token and retries once on a 401", async () => {
    const provider = fakeTokenProvider(["tok-1", "tok-2"]);
    const { impl, requests } = fakeFetch([
      { status: 401, body: "Unauthorized" },
      { json: { data: ME } },
    ]);
    const client = new XApiClient({ tokenProvider: provider, fetchImpl: impl });

    const res = await client.getMe();
    expect(res.data?.username).toBe("me");
    expect(provider.invalidateCount).toBe(1);
    expect(requests).toHaveLength(2);
    // Retry used the refreshed token.
    expect(requests[1].headers.Authorization).toBe("Bearer tok-2");
  });

  it("throws XApiError on a persistent non-2xx status", async () => {
    const { impl } = fakeFetch([
      { status: 403, body: '{"title":"client-not-enrolled"}' },
      { status: 403, body: '{"title":"client-not-enrolled"}' },
    ]);
    const client = new XApiClient({
      tokenProvider: fakeTokenProvider(),
      fetchImpl: impl,
    });

    await expect(client.getMe()).rejects.toBeInstanceOf(XApiError);
  });

  it("surfaces client-not-enrolled via the XApiError helper", async () => {
    const { impl } = fakeFetch([
      { status: 403, body: '{"errors":[{"reason":"client-not-enrolled"}]}' },
    ]);
    const client = new XApiClient({
      tokenProvider: fakeTokenProvider(),
      fetchImpl: impl,
    });

    try {
      await client.getUserByUsername("someone");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(XApiError);
      expect((err as XApiError).isClientNotEnrolled).toBe(true);
    }
  });
});
