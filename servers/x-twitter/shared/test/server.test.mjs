import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  RefreshTokenProvider,
  StaticAccessTokenProvider,
  createMCPServer,
  parseEnabledToolGroups,
} from "../build/index.js";

const EXPECTED_READONLY = [
  "get_my_account",
  "get_user",
  "get_home_timeline",
  "get_user_tweets",
  "get_bookmarks",
  "search_recent_tweets",
  "get_tweets",
];

const EXPECTED_READWRITE = [
  ...EXPECTED_READONLY,
  "create_bookmark",
  "remove_bookmark",
];

const FORBIDDEN_PUBLIC_MUTATIONS = [
  "post",
  "reply",
  "retweet",
  "like",
  "follow",
  "dm",
  "mute",
  "block",
];

const ME = {
  data: {
    id: "1000",
    name: "Mock Me",
    username: "mock_me",
    public_metrics: { followers_count: 10, following_count: 5, tweet_count: 20 },
  },
};

const TIMELINE = {
  data: [
    {
      id: "3001",
      text: "timeline tweet",
      author_id: "2000",
      public_metrics: { like_count: 1 },
    },
  ],
  includes: {
    users: [{ id: "2000", name: "Other", username: "other" }],
  },
  meta: { result_count: 1 },
};

function createMockXClient(overrides = {}) {
  return {
    getMe: async () => ME,
    getUserByUsername: async (username) =>
      username.replace(/^@/, "") === "mock_me"
        ? ME
        : { errors: [{ title: "Not Found Error" }] },
    getHomeTimeline: async () => TIMELINE,
    getUserTweets: async () => TIMELINE,
    getBookmarks: async () => TIMELINE,
    searchRecent: async () => TIMELINE,
    getTweets: async (ids) => ({
      data: ids.map((id) => ({
        id,
        text: `tweet ${id}`,
        author_id: "2000",
      })),
      includes: { users: [{ id: "2000", name: "Other", username: "other" }] },
    }),
    createBookmark: async () => ({ data: { bookmarked: true } }),
    removeBookmark: async () => ({ data: { bookmarked: false } }),
    ...overrides,
  };
}

async function connect(options = {}, mock = createMockXClient()) {
  const { server, registerHandlers } = createMCPServer({
    version: "test",
    ...options,
  });
  await registerHandlers(server, () => mock);
  const client = new Client({ name: "test", version: "1" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, close: () => Promise.all([client.close(), server.close()]) };
}

async function call(client, name, args) {
  const res = await client.callTool({ name, arguments: args });
  return {
    isError: res.isError === true,
    text: res.content.map((c) => c.text).join("\n"),
  };
}

test("tools/list exposes the full safe surface by default", async () => {
  const { client, close } = await connect();
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [...EXPECTED_READWRITE].sort());
  for (const name of names) {
    for (const forbidden of FORBIDDEN_PUBLIC_MUTATIONS) {
      assert.equal(
        name.toLowerCase().includes(forbidden),
        false,
        `${name} must not expose public mutation verb ${forbidden}`,
      );
    }
  }
  await close();
});

test("readonly group excludes private bookmark writes", async () => {
  const { client, close } = await connect({ toolGroups: ["readonly"] });
  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    [...EXPECTED_READONLY].sort(),
  );
  await close();
});

test("readwrite group includes bookmark reads and private bookmark writes", async () => {
  const { client, close } = await connect({ toolGroups: ["readwrite"] });
  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    [...EXPECTED_READWRITE].sort(),
  );
  await close();
});

test("tools call through the MCP path against the injected client", async () => {
  let bookmarkTweetId;
  const { client, close } = await connect(
    {},
    createMockXClient({
      createBookmark: async (tweetId) => {
        bookmarkTweetId = tweetId;
        return { data: { bookmarked: true } };
      },
    }),
  );

  const profile = await call(client, "get_my_account", {});
  assert.equal(profile.isError, false);
  assert.match(profile.text, /@mock_me/);

  const bookmark = await call(client, "create_bookmark", { tweet_id: "3001" });
  assert.equal(bookmark.isError, false);
  assert.equal(bookmarkTweetId, "3001");
  assert.match(bookmark.text, /Bookmarked tweet 3001/);

  await close();
});

test("parseEnabledToolGroups accepts valid local groups and falls back to full", () => {
  assert.deepEqual(parseEnabledToolGroups("readonly, ReadWrite, bogus"), [
    "readonly",
    "readwrite",
  ]);
  assert.deepEqual(parseEnabledToolGroups("bogus"), ["readonly", "readwrite"]);
});

test("StaticAccessTokenProvider returns the injected access token", async () => {
  const provider = new StaticAccessTokenProvider("injected-token");
  assert.equal(await provider.getAccessToken(), "injected-token");
  provider.invalidate();
  assert.equal(await provider.getAccessToken(), "injected-token");
});

test("RefreshTokenProvider rotates single-use refresh tokens in memory", async () => {
  const calls = [];
  const responses = [
    { access_token: "access-1", refresh_token: "refresh-2", expires_in: 1 },
    { access_token: "access-2", refresh_token: "refresh-3", expires_in: 1 },
  ];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    const body = responses[Math.min(calls.length - 1, responses.length - 1)];
    return new Response(JSON.stringify({ token_type: "bearer", ...body }), {
      status: 200,
    });
  };
  const provider = new RefreshTokenProvider({
    clientId: "client",
    clientSecret: "secret",
    refreshToken: "refresh-1",
    fetchImpl,
  });

  assert.equal(await provider.getAccessToken(), "access-1");
  assert.equal(provider.refreshToken, "refresh-2");
  assert.equal(await provider.getAccessToken(), "access-2");
  assert.equal(provider.refreshToken, "refresh-3");

  const firstBody = new URLSearchParams(calls[0].init.body);
  const secondBody = new URLSearchParams(calls[1].init.body);
  assert.equal(firstBody.get("refresh_token"), "refresh-1");
  assert.equal(secondBody.get("refresh_token"), "refresh-2");
  const headers = calls[0].init.headers;
  const expectedBasic = Buffer.from("client:secret").toString("base64");
  assert.equal(headers.Authorization, `Basic ${expectedBasic}`);
});
