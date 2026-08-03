import { test } from "node:test";
import assert from "node:assert/strict";

import { XApiClient, XApiError } from "../build/index.js";

function fakeTokenProvider(tokens = ["tok-1"]) {
  let index = 0;
  return {
    invalidateCount: 0,
    async getAccessToken() {
      return tokens[Math.min(index, tokens.length - 1)];
    },
    invalidate() {
      this.invalidateCount += 1;
      index += 1;
    },
  };
}

function fakeFetch(responses) {
  const requests = [];
  let index = 0;
  const impl = async (url, init = {}) => {
    requests.push({
      url: String(url),
      method: init.method,
      headers: init.headers ?? {},
      body: init.body,
    });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return new Response(next.body ?? JSON.stringify(next.json ?? {}), {
      status: next.status ?? 200,
    });
  };
  return { impl, requests };
}

const ME = { id: "42", name: "Me", username: "me" };

test("getMe requests /users/me with user fields and a bearer token", async () => {
  const { impl, requests } = fakeFetch([{ json: { data: ME } }]);
  const client = new XApiClient({ tokenProvider: fakeTokenProvider(), fetchImpl: impl });

  const res = await client.getMe();
  assert.equal(res.data?.username, "me");

  const url = new URL(requests[0].url);
  assert.equal(url.pathname, "/2/users/me");
  assert.match(url.searchParams.get("user.fields"), /public_metrics/);
  assert.equal(requests[0].headers.Authorization, "Bearer tok-1");
});

test("getUserByUsername strips a leading @ and encodes the handle", async () => {
  const { impl, requests } = fakeFetch([{ json: { data: ME } }]);
  const client = new XApiClient({ tokenProvider: fakeTokenProvider(), fetchImpl: impl });

  await client.getUserByUsername("@me");
  assert.equal(new URL(requests[0].url).pathname, "/2/users/by/username/me");
});

test("timeline and bookmarks resolve the authenticated user id once", async () => {
  const { impl, requests } = fakeFetch([
    { json: { data: ME } },
    { json: { data: [], meta: { result_count: 0 } } },
    { json: { data: [], meta: { result_count: 0 } } },
  ]);
  const client = new XApiClient({ tokenProvider: fakeTokenProvider(), fetchImpl: impl });

  await client.getHomeTimeline({ maxResults: 50 });
  await client.getBookmarks({});

  assert.equal(requests.length, 3);
  const timelineUrl = new URL(requests[1].url);
  assert.equal(timelineUrl.pathname, "/2/users/42/timelines/reverse_chronological");
  assert.equal(timelineUrl.searchParams.get("max_results"), "50");
  assert.match(timelineUrl.searchParams.get("tweet.fields"), /note_tweet/);
  assert.equal(new URL(requests[2].url).pathname, "/2/users/42/bookmarks");
});

test("recent search clamps max_results into the endpoint-specific X API range", async () => {
  const { impl, requests } = fakeFetch([{ json: { data: [] } }, { json: { data: [] } }]);
  const client = new XApiClient({ tokenProvider: fakeTokenProvider(), fetchImpl: impl });

  await client.searchRecent({ query: "mcp", maxResults: 999 });
  await client.searchRecent({ query: "mcp", maxResults: 5 });

  const high = new URL(requests[0].url);
  assert.equal(high.pathname, "/2/tweets/search/recent");
  assert.equal(high.searchParams.get("query"), "mcp");
  assert.equal(high.searchParams.get("max_results"), "100");
  assert.equal(new URL(requests[1].url).searchParams.get("max_results"), "10");
});

test("getTweets joins ids into a comma-separated ids param", async () => {
  const { impl, requests } = fakeFetch([{ json: { data: [] } }]);
  const client = new XApiClient({ tokenProvider: fakeTokenProvider(), fetchImpl: impl });

  await client.getTweets(["1", "2", "3"]);
  const url = new URL(requests[0].url);
  assert.equal(url.pathname, "/2/tweets");
  assert.equal(url.searchParams.get("ids"), "1,2,3");
});

test("bookmark writes use only private bookmark endpoints", async () => {
  const { impl, requests } = fakeFetch([
    { json: { data: ME } },
    { json: { data: { bookmarked: true } } },
    { json: { data: { bookmarked: false } } },
  ]);
  const client = new XApiClient({ tokenProvider: fakeTokenProvider(), fetchImpl: impl });

  await client.createBookmark("3001");
  await client.removeBookmark("3001");

  assert.equal(requests[1].method, "POST");
  assert.equal(new URL(requests[1].url).pathname, "/2/users/42/bookmarks");
  assert.equal(requests[1].body, JSON.stringify({ tweet_id: "3001" }));
  assert.equal(requests[2].method, "DELETE");
  assert.equal(new URL(requests[2].url).pathname, "/2/users/42/bookmarks/3001");
});

test("a 401 invalidates the token and retries once", async () => {
  const provider = fakeTokenProvider(["tok-1", "tok-2"]);
  const { impl, requests } = fakeFetch([
    { status: 401, body: "Unauthorized" },
    { json: { data: ME } },
  ]);
  const client = new XApiClient({ tokenProvider: provider, fetchImpl: impl });

  const res = await client.getMe();
  assert.equal(res.data?.username, "me");
  assert.equal(provider.invalidateCount, 1);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].headers.Authorization, "Bearer tok-2");
});

test("persistent non-2xx responses surface XApiError details", async () => {
  const { impl } = fakeFetch([
    { status: 403, body: '{"errors":[{"reason":"client-not-enrolled"}]}' },
    { status: 403, body: '{"errors":[{"reason":"client-not-enrolled"}]}' },
  ]);
  const client = new XApiClient({ tokenProvider: fakeTokenProvider(), fetchImpl: impl });

  await assert.rejects(client.getMe(), (error) => {
    assert.ok(error instanceof XApiError);
    assert.equal(error.status, 403);
    assert.equal(error.isClientNotEnrolled, true);
    return true;
  });
});
