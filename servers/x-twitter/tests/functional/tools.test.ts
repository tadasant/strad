import { describe, it, expect, beforeEach, vi } from "vitest";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createMockXClient } from "../mocks/x-client.functional-mock.js";
import { createMCPServer } from "../../shared/src/server.js";
import { getMyAccountTool } from "../../shared/src/tools/get-my-account.js";
import { getUserTool } from "../../shared/src/tools/get-user.js";
import { getHomeTimelineTool } from "../../shared/src/tools/get-home-timeline.js";
import { getUserTweetsTool } from "../../shared/src/tools/get-user-tweets.js";
import { getBookmarksTool } from "../../shared/src/tools/get-bookmarks.js";
import { searchRecentTweetsTool } from "../../shared/src/tools/search-recent-tweets.js";
import { getTweetsTool } from "../../shared/src/tools/get-tweets.js";
import { createBookmarkTool } from "../../shared/src/tools/create-bookmark.js";
import { removeBookmarkTool } from "../../shared/src/tools/remove-bookmark.js";
import {
  createRegisterTools,
  parseEnabledToolGroups,
  getAvailableToolGroups,
  type ToolGroup,
} from "../../shared/src/tools.js";
import type { IXClient } from "../../shared/src/types.js";

describe("X (Twitter) tools", () => {
  let mockClient: IXClient;
  const server = {} as Server;
  const factory = () => mockClient;

  beforeEach(() => {
    mockClient = createMockXClient();
  });

  describe("get_my_account", () => {
    it("returns the authenticated profile", async () => {
      const tool = getMyAccountTool(server, factory);
      const result = await tool.handler({});
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain("@mock_me");
    });

    it("reports an error when getMe returns no data", async () => {
      mockClient = createMockXClient({ getMe: vi.fn(async () => ({})) });
      const tool = getMyAccountTool(server, factory);
      const result = await tool.handler({});
      expect(result.isError).toBe(true);
    });
  });

  describe("get_user", () => {
    it("looks up a user by handle", async () => {
      const tool = getUserTool(server, factory);
      const result = await tool.handler({ username: "@mock_me" });
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain("@mock_me");
    });

    it("errors on an unknown user", async () => {
      const tool = getUserTool(server, factory);
      const result = await tool.handler({ username: "nobody" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("No user found");
    });

    it("errors when username is missing", async () => {
      const tool = getUserTool(server, factory);
      const result = await tool.handler({});
      expect(result.isError).toBe(true);
    });
  });

  describe("get_home_timeline", () => {
    it("returns timeline tweets", async () => {
      const tool = getHomeTimelineTool(server, factory);
      const result = await tool.handler({ max_results: 10 });
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain("timeline tweet");
      expect(mockClient.getHomeTimeline).toHaveBeenCalledWith({
        maxResults: 10,
        paginationToken: undefined,
      });
    });
  });

  describe("get_user_tweets", () => {
    it("fetches the authenticated user tweets when no username is given", async () => {
      const tool = getUserTweetsTool(server, factory);
      const result = await tool.handler({ max_results: 5 });
      expect(result.isError).toBeFalsy();
      expect(mockClient.getUserTweets).toHaveBeenCalledWith({
        username: undefined,
        maxResults: 5,
        excludeReplies: undefined,
        excludeRetweets: undefined,
        paginationToken: undefined,
      });
    });

    it("passes username and exclude filters through to the client", async () => {
      const tool = getUserTweetsTool(server, factory);
      const result = await tool.handler({
        username: "@pulsemcp",
        exclude_replies: true,
        exclude_retweets: true,
      });
      expect(result.isError).toBeFalsy();
      expect(mockClient.getUserTweets).toHaveBeenCalledWith({
        username: "@pulsemcp",
        maxResults: undefined,
        excludeReplies: true,
        excludeRetweets: true,
        paginationToken: undefined,
      });
    });
  });

  describe("get_bookmarks", () => {
    it("returns bookmarked tweets", async () => {
      const tool = getBookmarksTool(server, factory);
      const result = await tool.handler({});
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain("tweet(s)");
    });
  });

  describe("search_recent_tweets", () => {
    it("passes the query through to the client", async () => {
      const tool = searchRecentTweetsTool(server, factory);
      const result = await tool.handler({ query: "#mcp" });
      expect(result.isError).toBeFalsy();
      expect(mockClient.searchRecent).toHaveBeenCalledWith({
        query: "#mcp",
        maxResults: undefined,
        paginationToken: undefined,
      });
    });

    it("errors when query is missing", async () => {
      const tool = searchRecentTweetsTool(server, factory);
      const result = await tool.handler({});
      expect(result.isError).toBe(true);
    });
  });

  describe("get_tweets", () => {
    it("accepts an array of ids", async () => {
      const tool = getTweetsTool(server, factory);
      const result = await tool.handler({ ids: ["1", "2"] });
      expect(result.isError).toBeFalsy();
      expect(mockClient.getTweets).toHaveBeenCalledWith(["1", "2"]);
      expect(result.content[0].text).toContain("2 tweet(s)");
    });

    it("accepts a comma-separated string of ids", async () => {
      const tool = getTweetsTool(server, factory);
      const result = await tool.handler({ ids: "10, 11 ,12" });
      expect(mockClient.getTweets).toHaveBeenCalledWith(["10", "11", "12"]);
      expect(result.isError).toBeFalsy();
    });

    it("errors when more than 100 ids are supplied", async () => {
      const tool = getTweetsTool(server, factory);
      const ids = Array.from({ length: 101 }, (_, i) => String(i));
      const result = await tool.handler({ ids });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("at most 100");
    });
  });

  describe("create_bookmark", () => {
    it("bookmarks a tweet by id", async () => {
      const tool = createBookmarkTool(server, factory);
      const result = await tool.handler({ tweet_id: "3001" });
      expect(result.isError).toBeFalsy();
      expect(mockClient.createBookmark).toHaveBeenCalledWith("3001");
      expect(result.content[0].text).toContain("Bookmarked tweet 3001");
    });

    it("errors when tweet_id is missing", async () => {
      const tool = createBookmarkTool(server, factory);
      const result = await tool.handler({});
      expect(result.isError).toBe(true);
    });

    it("reports a failure when the API does not confirm the bookmark", async () => {
      mockClient = createMockXClient({
        createBookmark: vi.fn(async () => ({ data: { bookmarked: false } })),
      });
      const tool = createBookmarkTool(server, factory);
      const result = await tool.handler({ tweet_id: "3001" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Failed to bookmark");
    });
  });

  describe("remove_bookmark", () => {
    it("removes a tweet from bookmarks by id", async () => {
      const tool = removeBookmarkTool(server, factory);
      const result = await tool.handler({ tweet_id: "4001" });
      expect(result.isError).toBeFalsy();
      expect(mockClient.removeBookmark).toHaveBeenCalledWith("4001");
      expect(result.content[0].text).toContain(
        "Removed tweet 4001 from bookmarks",
      );
    });

    it("errors when tweet_id is missing", async () => {
      const tool = removeBookmarkTool(server, factory);
      const result = await tool.handler({});
      expect(result.isError).toBe(true);
    });
  });
});

describe("tool groups", () => {
  const factory = () => createMockXClient();

  /** Registers tools for the given groups and returns the advertised names. */
  async function toolNamesFor(groups?: ToolGroup[]): Promise<string[]> {
    let listHandler:
      (() => Promise<{ tools: Array<{ name: string }> }>) | undefined;
    const fakeServer = {
      setRequestHandler: (schema: unknown, handler: unknown) => {
        if (schema === ListToolsRequestSchema) {
          listHandler = handler as typeof listHandler;
        }
      },
    } as unknown as Server;

    const register = createRegisterTools(factory, groups);
    register(fakeServer);
    const result = await listHandler!();
    return result.tools.map((t) => t.name);
  }

  it("exposes the two supported groups", () => {
    expect(getAvailableToolGroups()).toEqual(["readonly", "readwrite"]);
  });

  it("parseEnabledToolGroups defaults to all groups when unset", () => {
    expect(parseEnabledToolGroups(undefined)).toEqual([
      "readonly",
      "readwrite",
    ]);
  });

  it("parseEnabledToolGroups filters to valid groups and lowercases them", () => {
    expect(parseEnabledToolGroups("readonly, ReadWrite, bogus")).toEqual([
      "readonly",
      "readwrite",
    ]);
  });

  it("parseEnabledToolGroups fails closed when none are valid", () => {
    expect(parseEnabledToolGroups("bogus,nope")).toEqual([]);
  });

  it("readonly group excludes the bookmark-write tools", async () => {
    const names = await toolNamesFor(["readonly"]);
    expect(names).toContain("get_user_tweets");
    expect(names).toContain("search_recent_tweets");
    expect(names).not.toContain("create_bookmark");
    expect(names).not.toContain("remove_bookmark");
  });

  it("readwrite group includes the bookmark-write tools", async () => {
    const names = await toolNamesFor(["readwrite"]);
    expect(names).toContain("create_bookmark");
    expect(names).toContain("remove_bookmark");
  });

  it("never advertises a public-mutation tool in any group", async () => {
    const names = await toolNamesFor(["readonly", "readwrite"]);
    const forbidden = [
      "post",
      "reply",
      "retweet",
      "quote",
      "like",
      "follow",
      "dm",
    ];
    for (const name of names) {
      for (const verb of forbidden) {
        expect(name.includes(verb)).toBe(false);
      }
    }
  });
});

describe("stateless host registration", () => {
  function fakeServerWithCallHandler() {
    let callHandler:
      | ((request: {
          params: { name: string; arguments?: Record<string, unknown> };
        }) => Promise<unknown>)
      | undefined;

    const fakeServer = {
      setRequestHandler: (schema: unknown, handler: unknown) => {
        if (schema === CallToolRequestSchema) {
          callHandler = handler as typeof callHandler;
        }
      },
    } as unknown as Server;

    return {
      server: fakeServer,
      call: (name: string, args: Record<string, unknown> = {}) =>
        callHandler!({ params: { name, arguments: args } }),
    };
  }

  it("reuses one client across repeated stateless registrations", async () => {
    const client = createMockXClient();
    const clientFactory = vi.fn(() => client);
    const created = createMCPServer({ version: "test" });
    const first = fakeServerWithCallHandler();
    const second = fakeServerWithCallHandler();

    await created.registerHandlers(first.server, clientFactory);
    await first.call("get_my_account");
    await created.registerHandlers(second.server, clientFactory);
    await second.call("get_my_account");

    expect(clientFactory).toHaveBeenCalledTimes(1);
    expect(client.getMe).toHaveBeenCalledTimes(2);
  });
});
