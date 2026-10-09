import { describe, it, expect } from "vitest";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMCPServer } from "../../shared/src/server.js";
import { RefreshTokenProvider } from "../../shared/src/x-client/auth.js";
import { XApiClient } from "../../shared/src/x-client/x-api-client.js";

/**
 * TWO SLUGS, ONE ROTATING CREDENTIAL.
 *
 * strad serves `x-twitter` (read tier) and `x-twitter-rw` (read + private
 * bookmark writes) from ONE mount: same bundle, same `path: /x-twitter`, and the
 * gateway's `tools:` policy is the only difference between them. The bundle host
 * calls `createMCPServer` once for that mount and `registerHandlers` on a fresh
 * MCP `Server` for EVERY request, whichever slug it arrived under — so what the
 * two slugs share is the client `registerHandlers` memoises, and with it one
 * `RefreshTokenProvider`.
 *
 * X refresh tokens are single-use: each refresh returns a new one and kills the
 * one presented. The fake X below enforces exactly that, so any design where the
 * two slugs each refresh the same token fails here the way it would at X.
 */

const TOKEN_URL = "https://x.test/2/oauth2/token";
const API_BASE = "https://x.test/2";
const READ_SCOPES = "tweet.read users.read bookmark.read offline.access";
const WRITE_SCOPES = `${READ_SCOPES} bookmark.write`;

interface FakeXOptions {
  /** The scopes every token response reports, and that bookmark writes check. */
  scope?: string;
  /** Access-token lifetime in seconds. Under 60 means every call refreshes. */
  expiresIn?: number;
  /** Delay on the token endpoint, so concurrent callers overlap in flight. */
  refreshDelayMs?: number;
}

/** A fake X: OAuth token endpoint with single-use rotation, plus four API routes. */
function fakeX(opts: FakeXOptions = {}) {
  const scope = opts.scope ?? WRITE_SCOPES;
  let live = "refresh-1";
  let issued = 1;
  const presented: string[] = [];
  const rejected: string[] = [];

  const impl = async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";

    if (url === TOKEN_URL) {
      const sent = new URLSearchParams(String(init?.body)).get("refresh_token");
      presented.push(String(sent));
      if (opts.refreshDelayMs) {
        await new Promise((r) => setTimeout(r, opts.refreshDelayMs));
      }
      if (sent !== live) {
        rejected.push(String(sent));
        return new Response(
          JSON.stringify({
            error: "invalid_request",
            error_description: "Value passed for the token was invalid.",
          }),
          { status: 400 },
        );
      }
      issued += 1;
      live = `refresh-${issued}`;
      return new Response(
        JSON.stringify({
          access_token: `access-${issued}`,
          refresh_token: live,
          token_type: "bearer",
          expires_in: opts.expiresIn ?? 7200,
          scope,
        }),
        { status: 200 },
      );
    }

    const path = url.slice(API_BASE.length).split("?")[0];
    if (method === "GET" && path === "/users/me") {
      return Response.json({
        data: { id: "42", username: "me", name: "Me" },
      });
    }
    if (method === "GET" && path === "/users/42/bookmarks") {
      return Response.json({ data: [], meta: { result_count: 0 } });
    }
    if (method === "POST" && path === "/users/42/bookmarks") {
      if (!scope.split(" ").includes("bookmark.write")) {
        return Response.json(
          { title: "Forbidden", detail: "Forbidden", status: 403 },
          { status: 403 },
        );
      }
      return Response.json({ data: { bookmarked: true } });
    }
    return new Response("not found", { status: 404 });
  };

  return {
    fetchImpl: impl as unknown as typeof fetch,
    presented,
    rejected,
    get live() {
      return live;
    },
  };
}

/**
 * One bundle-host mount: `createMCPServer` once, the factory once, and a fresh
 * MCP `Server` per request — the shape `loadXTwitter` gives it.
 */
function mount(x: ReturnType<typeof fakeX>, seed = "refresh-1") {
  const created = createMCPServer({ version: "test" });
  const persisted: string[] = [];
  let clientsBuilt = 0;

  const factory = () => {
    clientsBuilt += 1;
    return new XApiClient({
      baseUrl: API_BASE,
      fetchImpl: x.fetchImpl,
      tokenProvider: new RefreshTokenProvider({
        clientId: "client",
        clientSecret: "secret",
        refreshToken: seed,
        tokenUrl: TOKEN_URL,
        fetchImpl: x.fetchImpl,
        onRefreshToken: async (token) => {
          persisted.push(token);
        },
      }),
    });
  };

  /** One request, under whichever slug — the mount cannot tell them apart. */
  async function call(tool: string, args: Record<string, unknown> = {}) {
    const server = new Server(
      { name: "x", version: "test" },
      { capabilities: { tools: {} } },
    );
    await created.registerHandlers(server, factory);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "test", version: "test" });
    await client.connect(clientSide);
    try {
      const result = (await client.callTool({
        name: tool,
        arguments: args,
      })) as { isError?: boolean; content: Array<{ text: string }> };
      return { isError: !!result.isError, text: result.content[0].text };
    } finally {
      await client.close();
    }
  }

  return {
    call,
    persisted,
    get clientsBuilt() {
      return clientsBuilt;
    },
  };
}

describe("x-twitter and x-twitter-rw sharing one rotating refresh token", () => {
  it("builds ONE client for the mount, whichever slug a request came in on", async () => {
    const x = fakeX();
    const m = mount(x);

    await m.call("get_bookmarks"); // x-twitter
    await m.call("create_bookmark", { tweet_id: "7" }); // x-twitter-rw
    await m.call("get_my_account"); // x-twitter

    expect(m.clientsBuilt).toBe(1);
    // One refresh served all three: the access token lives ~2h.
    expect(x.presented).toEqual(["refresh-1"]);
  });

  it("collapses concurrent refreshes from both slugs into ONE token exchange", async () => {
    const x = fakeX({ refreshDelayMs: 25 });
    const m = mount(x);

    const [ro, rw] = await Promise.all([
      m.call("get_bookmarks"),
      m.call("create_bookmark", { tweet_id: "7" }),
    ]);

    expect(ro.isError).toBe(false);
    expect(rw.isError).toBe(false);
    expect(rw.text).toContain("Bookmarked tweet 7");
    expect(x.presented).toEqual(["refresh-1"]);
    expect(x.rejected).toEqual([]);
    expect(m.persisted).toEqual(["refresh-2"]);
  });

  it("carries each rotation into the other slug's next refresh, and persists every one in order", async () => {
    // Every call refreshes: the access token is born inside the 60s buffer.
    const x = fakeX({ expiresIn: 1 });
    const m = mount(x);

    const results = [
      await m.call("get_my_account"), // x-twitter
      await m.call("create_bookmark", { tweet_id: "7" }), // x-twitter-rw
      await m.call("get_bookmarks"), // x-twitter
      await m.call("create_bookmark", { tweet_id: "8" }), // x-twitter-rw
    ];

    for (const r of results) expect(r.isError).toBe(false);
    // Each refresh presented the token the PREVIOUS one rotated to, regardless
    // of which slug spent it, and X never saw a spent token.
    expect(x.rejected).toEqual([]);
    expect(x.presented).toEqual(x.presented.map((_, i) => `refresh-${i + 1}`));
    // The store ends holding the live token, so the next boot resumes from it.
    expect(m.persisted.at(-1)).toBe(x.live);
    expect(m.persisted).toEqual(x.presented.map((_, i) => `refresh-${i + 2}`));
  });

  it("is why the slugs share a mount: two mounts seeded with one token kill each other", async () => {
    const x = fakeX();
    const first = mount(x);
    const second = mount(x);

    expect((await first.call("get_bookmarks")).isError).toBe(false);
    const lost = await second.call("get_bookmarks");

    // The second mount presented the token the first one already spent.
    expect(x.rejected).toEqual(["refresh-1"]);
    expect(lost.isError).toBe(true);
    expect(lost.text).toMatch(/Failed to refresh X access token/);
  });
});

describe("a bookmark write on a credential consented without bookmark.write", () => {
  it("names the missing scope and the re-consent, while reads keep working", async () => {
    const x = fakeX({ scope: READ_SCOPES });
    const m = mount(x);

    const read = await m.call("get_bookmarks");
    expect(read.isError).toBe(false);

    const write = await m.call("create_bookmark", { tweet_id: "7" });
    expect(write.isError).toBe(true);
    expect(write.text).toContain("HTTP 403");
    expect(write.text).toContain("does not include bookmark.write");
    expect(write.text).toContain(READ_SCOPES);
    expect(write.text).toMatch(/Re-run the X OAuth consent/);
  });
});
