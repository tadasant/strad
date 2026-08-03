import { test } from "node:test";
import assert from "node:assert/strict";

import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createRegisterTools, getAvailableToolGroups, parseEnabledToolGroups } from "../build/index.js";
import { createBookmarkTool } from "../build/tools/create-bookmark.js";
import { getBookmarksTool } from "../build/tools/get-bookmarks.js";
import { getHomeTimelineTool } from "../build/tools/get-home-timeline.js";
import { getMyAccountTool } from "../build/tools/get-my-account.js";
import { getTweetsTool } from "../build/tools/get-tweets.js";
import { getUserTweetsTool } from "../build/tools/get-user-tweets.js";
import { getUserTool } from "../build/tools/get-user.js";
import { removeBookmarkTool } from "../build/tools/remove-bookmark.js";
import { searchRecentTweetsTool } from "../build/tools/search-recent-tweets.js";

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
  includes: { users: [{ id: "2000", name: "Other", username: "other" }] },
  meta: { result_count: 1 },
};

function fn(impl) {
  const calls = [];
  const wrapped = async (...args) => {
    calls.push(args);
    return impl(...args);
  };
  wrapped.calls = calls;
  return wrapped;
}

function createMockXClient(overrides = {}) {
  return {
    getMe: fn(async () => ME),
    getUserByUsername: fn(async (username) =>
      username.replace(/^@/, "") === "mock_me" ? ME : { errors: [{ title: "Not Found Error" }] },
    ),
    getHomeTimeline: fn(async () => TIMELINE),
    getUserTweets: fn(async () => TIMELINE),
    getBookmarks: fn(async () => TIMELINE),
    searchRecent: fn(async () => TIMELINE),
    getTweets: fn(async (ids) => ({
      data: ids.map((id) => ({ id, text: `tweet ${id}`, author_id: "2000" })),
      includes: { users: [{ id: "2000", name: "Other", username: "other" }] },
    })),
    createBookmark: fn(async () => ({ data: { bookmarked: true } })),
    removeBookmark: fn(async () => ({ data: { bookmarked: false } })),
    ...overrides,
  };
}

async function textResult(tool, args) {
  const result = await tool.handler(args);
  return {
    isError: result.isError === true,
    text: result.content.map((c) => c.text).join("\n"),
  };
}

test("direct tools call through to the injected client", async () => {
  const client = createMockXClient();
  const factory = () => client;

  assert.match((await textResult(getMyAccountTool({}, factory), {})).text, /@mock_me/);
  assert.match((await textResult(getUserTool({}, factory), { username: "@mock_me" })).text, /@mock_me/);
  assert.match((await textResult(getHomeTimelineTool({}, factory), { max_results: 10 })).text, /timeline tweet/);
  assert.deepEqual(client.getHomeTimeline.calls[0][0], {
    maxResults: 10,
    paginationToken: undefined,
  });

  await textResult(getUserTweetsTool({}, factory), {
    username: "@pulsemcp",
    exclude_replies: true,
    exclude_retweets: true,
  });
  assert.deepEqual(client.getUserTweets.calls[0][0], {
    username: "@pulsemcp",
    maxResults: undefined,
    excludeReplies: true,
    excludeRetweets: true,
    paginationToken: undefined,
  });

  assert.match((await textResult(getBookmarksTool({}, factory), {})).text, /tweet\(s\)/);

  await textResult(searchRecentTweetsTool({}, factory), { query: "#mcp" });
  assert.deepEqual(client.searchRecent.calls[0][0], {
    query: "#mcp",
    maxResults: undefined,
    paginationToken: undefined,
  });

  await textResult(getTweetsTool({}, factory), { ids: "10, 11 ,12" });
  assert.deepEqual(client.getTweets.calls[0][0], ["10", "11", "12"]);

  assert.match((await textResult(createBookmarkTool({}, factory), { tweet_id: "3001" })).text, /Bookmarked tweet 3001/);
  assert.deepEqual(client.createBookmark.calls[0], ["3001"]);

  assert.match((await textResult(removeBookmarkTool({}, factory), { tweet_id: "4001" })).text, /Removed tweet 4001 from bookmarks/);
  assert.deepEqual(client.removeBookmark.calls[0], ["4001"]);
});

test("direct tools report validation and API failures as tool errors", async () => {
  const client = createMockXClient({
    createBookmark: fn(async () => ({ data: { bookmarked: false } })),
  });
  const factory = () => client;

  assert.equal((await textResult(getUserTool({}, factory), { username: "nobody" })).isError, true);
  assert.equal((await textResult(searchRecentTweetsTool({}, factory), {})).isError, true);
  const tooMany = await textResult(getTweetsTool({}, factory), {
    ids: Array.from({ length: 101 }, (_, i) => String(i)),
  });
  assert.equal(tooMany.isError, true);
  assert.match(tooMany.text, /at most 100/);

  const failedBookmark = await textResult(createBookmarkTool({}, factory), { tweet_id: "3001" });
  assert.equal(failedBookmark.isError, true);
  assert.match(failedBookmark.text, /Failed to bookmark/);
});

test("tool groups expose readonly and private-bookmark write surfaces", async () => {
  assert.deepEqual(getAvailableToolGroups(), ["readonly", "readwrite"]);
  assert.deepEqual(parseEnabledToolGroups(undefined), ["readonly", "readwrite"]);
  assert.deepEqual(parseEnabledToolGroups("readonly, ReadWrite, bogus"), ["readonly", "readwrite"]);
  assert.deepEqual(parseEnabledToolGroups("bogus,nope"), ["readonly", "readwrite"]);

  async function namesFor(groups) {
    let listHandler;
    const fakeServer = {
      setRequestHandler(schema, handler) {
        if (schema === ListToolsRequestSchema) listHandler = handler;
      },
    };
    createRegisterTools(() => createMockXClient(), groups)(fakeServer);
    return (await listHandler()).tools.map((t) => t.name);
  }

  const readonly = await namesFor(["readonly"]);
  assert.deepEqual(
    readonly.sort(),
    [
      "get_bookmarks",
      "get_home_timeline",
      "get_my_account",
      "get_tweets",
      "get_user",
      "get_user_tweets",
      "search_recent_tweets",
    ],
  );
  assert.equal(readonly.includes("create_bookmark"), false);
  assert.equal(readonly.includes("remove_bookmark"), false);

  const readwrite = await namesFor(["readwrite"]);
  assert.equal(readwrite.includes("create_bookmark"), true);
  assert.equal(readwrite.includes("remove_bookmark"), true);
});
