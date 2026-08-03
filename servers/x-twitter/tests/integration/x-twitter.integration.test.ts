import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { TestMCPClient } from "../support/stdio-client.js";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = join(
  __dirname,
  "../../local/build/index.integration-with-mock.js",
);

/**
 * The complete tool surface this server must expose when all groups are
 * enabled (reads + the two private bookmark writes).
 */
const EXPECTED_TOOLS = [
  "get_my_account",
  "get_user",
  "get_home_timeline",
  "get_user_tweets",
  "get_bookmarks",
  "search_recent_tweets",
  "get_tweets",
  "create_bookmark",
  "remove_bookmark",
];

/**
 * Substrings that must NEVER appear in a tool name. This server performs reads
 * plus PRIVATE bookmark writes only — it must never expose a PUBLIC mutation
 * (posting, replying, retweeting, quote-tweeting, liking, following, DMing). These verbs are
 * chosen to catch public mutations without matching the allowed private
 * bookmark writes (create_bookmark / remove_bookmark).
 */
const FORBIDDEN_TOOL_SUBSTRINGS = [
  "post",
  "reply",
  "retweet",
  "quote",
  "like",
  "follow",
  "dm",
  "mute",
  "block",
];

describe("X (Twitter) MCP Server Integration Tests", () => {
  let client: TestMCPClient | null = null;

  beforeEach(async () => {
    client = new TestMCPClient({ serverPath: SERVER_PATH });
    await client.connect();
  });

  afterEach(async () => {
    if (client) {
      await client.disconnect();
      client = null;
    }
  });

  describe("Server Setup", () => {
    it("connects successfully", () => {
      expect(client).not.toBeNull();
    });

    it("exposes exactly the expected tool surface", async () => {
      const { tools } = await client!.listTools();
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual([...EXPECTED_TOOLS].sort());
    });

    it("exposes no public-mutation tools", async () => {
      const { tools } = await client!.listTools();
      for (const tool of tools) {
        for (const forbidden of FORBIDDEN_TOOL_SUBSTRINGS) {
          expect(tool.name.toLowerCase()).not.toContain(forbidden);
        }
      }
    });
  });

  describe("get_my_account", () => {
    it("returns the authenticated mock user", async () => {
      const result = await client!.callTool("get_my_account", {});
      expect(result.content[0].type).toBe("text");
      expect(result.content[0].text).toContain("@mock_me");
    });
  });

  describe("get_user", () => {
    it("resolves a known handle", async () => {
      const result = await client!.callTool("get_user", {
        username: "another_account",
      });
      expect(result.content[0].text).toContain("@another_account");
    });
  });

  describe("get_home_timeline", () => {
    it("returns timeline tweets with authors resolved", async () => {
      const result = await client!.callTool("get_home_timeline", {
        max_results: 10,
      });
      expect(result.content[0].text).toContain("tweet(s)");
      expect(result.content[0].text).toContain("@another_account");
    });
  });

  describe("get_bookmarks", () => {
    it("returns bookmarked tweets", async () => {
      const result = await client!.callTool("get_bookmarks", {});
      expect(result.content[0].text).toContain("bookmarked tweet");
    });
  });

  describe("search_recent_tweets", () => {
    it("returns results for a query", async () => {
      const result = await client!.callTool("search_recent_tweets", {
        query: "model context protocol",
      });
      expect(result.content[0].text).toContain("model context protocol");
    });
  });

  describe("get_tweets", () => {
    it("looks up tweets by id", async () => {
      const result = await client!.callTool("get_tweets", {
        ids: ["9001", "9002"],
      });
      expect(result.content[0].text).toContain("9001");
      expect(result.content[0].text).toContain("9002");
    });
  });

  describe("get_user_tweets", () => {
    it("returns the authenticated user tweets by default", async () => {
      const result = await client!.callTool("get_user_tweets", {});
      expect(result.content[0].text).toContain("@mock_me");
    });

    it("returns another account tweets when a username is supplied", async () => {
      const result = await client!.callTool("get_user_tweets", {
        username: "another_account",
      });
      expect(result.content[0].text).toContain("@another_account");
    });
  });

  describe("create_bookmark", () => {
    it("confirms a tweet was bookmarked", async () => {
      const result = await client!.callTool("create_bookmark", {
        tweet_id: "9001",
      });
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain("Bookmarked tweet 9001");
    });
  });

  describe("remove_bookmark", () => {
    it("confirms a tweet was removed from bookmarks", async () => {
      const result = await client!.callTool("remove_bookmark", {
        tweet_id: "9001",
      });
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain(
        "Removed tweet 9001 from bookmarks",
      );
    });
  });
});
