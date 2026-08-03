import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { TestMCPClient } from "../support/stdio-client.js";
import path from "path";
import { fileURLToPath } from "url";
import { readFileSync, existsSync } from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * E2E tests that hit the real X (Twitter) API v2 through the MCP server.
 *
 * Credential sources (checked in order):
 *   1. Process env — X_OAUTH_ACCESS_TOKEN (static mode), or
 *      X_OAUTH_CLIENT_ID + X_OAUTH_CLIENT_SECRET + X_OAUTH_REFRESH_TOKEN
 *      (refresh mode, the server refreshes on demand).
 *   2. Decrypted tests/e2e/.env with the same variables.
 *
 * If no credentials are available (e.g. fork PRs), the suite skips gracefully.
 *
 * To run locally:
 *   cd mcp-servers
 *   MCP_SERVERS_MASTER_KEY="<key>" ./scripts/decrypt-credentials.sh x-twitter
 *   (cd servers/x-twitter/shared && npm run build)
 *   (cd servers/x-twitter/local && npm run build)
 *   cd servers/x-twitter && npx vitest run -c vitest.config.e2e.ts
 */

function loadEnvFile(): Record<string, string> {
  const envPath = path.join(__dirname, ".env");
  if (!existsSync(envPath)) return {};
  const env: Record<string, string> = {};
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq > 0) env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return env;
}

/** Resolve X credentials from process env, falling back to the .env file. */
function resolveCredentials(): Record<string, string> | null {
  const fileEnv = loadEnvFile();
  const pick = (k: string) => process.env[k] || fileEnv[k];

  const clientId = pick("X_OAUTH_CLIENT_ID");
  const clientSecret = pick("X_OAUTH_CLIENT_SECRET");
  const refreshToken = pick("X_OAUTH_REFRESH_TOKEN");
  const accessToken = pick("X_OAUTH_ACCESS_TOKEN");

  if (clientId && clientSecret && refreshToken) {
    return {
      X_OAUTH_CLIENT_ID: clientId,
      X_OAUTH_CLIENT_SECRET: clientSecret,
      X_OAUTH_REFRESH_TOKEN: refreshToken,
    };
  }
  if (accessToken) {
    return { X_OAUTH_ACCESS_TOKEN: accessToken };
  }
  return null;
}

const credentials = resolveCredentials();
const describeE2E = credentials ? describe : describe.skip;

if (!credentials) {
  console.warn(
    "[x-twitter e2e] No X credentials found — skipping E2E tests. " +
      "Set X_OAUTH_* env vars or decrypt tests/e2e/.env.",
  );
}

describeE2E("X (Twitter) MCP Server — E2E Tests", () => {
  let client: TestMCPClient;

  beforeAll(async () => {
    const serverPath = path.join(__dirname, "../../local/build/index.js");
    client = new TestMCPClient({
      serverPath,
      env: credentials as Record<string, string>,
    });
    await client.connect();
  });

  afterAll(async () => {
    if (client) await client.disconnect();
  });

  it("lists exactly the read tools plus the two private bookmark writes", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "get_bookmarks",
        "get_home_timeline",
        "get_my_account",
        "get_tweets",
        "get_user",
        "get_user_tweets",
        "search_recent_tweets",
        "create_bookmark",
        "remove_bookmark",
      ].sort(),
    );
  });

  it("get_my_account returns the authenticated account", async () => {
    const result = await client.callTool("get_my_account", {});
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    // Real profiles render as "@handle (Display Name)" with an id line.
    expect(text).toMatch(/@\S+/);
    expect(text).toContain("id:");
  });

  it("get_home_timeline returns tweets (or a clear empty message)", async () => {
    const result = await client.callTool("get_home_timeline", {
      max_results: 5,
    });
    expect(result.isError).toBeFalsy();
    expect(typeof result.content[0].text).toBe("string");
    expect(result.content[0].text.length).toBeGreaterThan(0);
  });

  it("get_bookmarks returns a well-formed response", async () => {
    const result = await client.callTool("get_bookmarks", { max_results: 5 });
    expect(result.isError).toBeFalsy();
    expect(typeof result.content[0].text).toBe("string");
    expect(result.content[0].text.length).toBeGreaterThan(0);
  });

  it("search_recent_tweets returns results for a common query", async () => {
    // Query must contain a positive, non-stopword clause and max_results >= 10,
    // else the recent-search endpoint returns a 400.
    const result = await client.callTool("search_recent_tweets", {
      query: "news",
      max_results: 10,
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("tweet");
  });

  it("get_user_tweets returns the authenticated user own tweet history", async () => {
    const result = await client.callTool("get_user_tweets", { max_results: 5 });
    expect(result.isError).toBeFalsy();
    expect(typeof result.content[0].text).toBe("string");
    expect(result.content[0].text.length).toBeGreaterThan(0);
  });

  it("create_bookmark then remove_bookmark round-trips a real tweet", async () => {
    // Find a real tweet id to bookmark. Prefer a search hit; the bookmark
    // write/remove is reversible and touches only the authed user's PRIVATE
    // bookmarks, so this leaves no lasting state behind.
    const search = await client.callTool("search_recent_tweets", {
      query: "news",
      max_results: 10,
    });
    expect(search.isError).toBeFalsy();
    const tweetId = search.content[0].text.match(/id:\s*(\d+)/)?.[1];
    expect(tweetId, "expected a tweet id in search output").toBeTruthy();

    const added = await client.callTool("create_bookmark", {
      tweet_id: tweetId,
    });
    expect(added.isError).toBeFalsy();
    expect(added.content[0].text).toContain(tweetId as string);

    const removed = await client.callTool("remove_bookmark", {
      tweet_id: tweetId,
    });
    expect(removed.isError).toBeFalsy();
    expect(removed.content[0].text).toContain(tweetId as string);
  });
});
