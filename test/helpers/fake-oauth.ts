import { randomUUID } from "node:crypto";
import type { Server as HttpServer } from "node:http";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  isInitializeRequest,
} from "@modelcontextprotocol/sdk/types.js";
import express, { type Request, type Response } from "express";

/**
 * An OAuth authorization server and an MCP server that trusts it — the shape of
 * an OAuth-per-user upstream like Granola, with nothing real behind it.
 *
 * The TOKEN ENDPOINT (`POST /token`) runs the refresh-token grant against a
 * table of refresh tokens, each owned by a PRINCIPAL. It mints opaque access
 * tokens, and can be told to rotate refresh tokens on use (the used one dies),
 * to omit `expires_in`, to refuse with an OAuth error, to fail with a 5xx, or to
 * hold its answers until released.
 *
 * The UPSTREAM (`POST /mcp/{principal}`) is a real MCP server behind a real
 * Streamable HTTP transport. It answers 401 to any request whose bearer is not
 * a live access token it issued — unknown, expired on the process clock, or
 * revoked — and to any bearer issued to a DIFFERENT principal than the path
 * names (`/mcp/any` skips that last check, for a slug whose account changes). Its `whoami` tool answers with the principal the bearer belongs to. It
 * records every bearer it saw, in order, with the verdict it gave.
 *
 * Expiry is judged by `Date.now()`, so a test that fakes `Date` moves the
 * upstream's clock and strad's together.
 */

interface Issued {
  principal: string;
  expiresAt: number | null;
  revoked: boolean;
}

export interface Seen {
  /** The principal the request's PATH named. */
  path: string;
  /** The bearer it carried, verbatim. */
  bearer: string | null;
  /** The principal that bearer belongs to, when it is one the server issued. */
  principal: string | null;
  status: 200 | 401;
}

export interface TokenRequest {
  grantType: string | undefined;
  refreshToken: string | undefined;
  clientId: string | undefined;
  clientSecret: string | undefined;
  scope: string | undefined;
  resource: string | undefined;
  /** The raw Authorization header, when the client authenticated with Basic. */
  authorization: string | undefined;
}

export interface FakeOAuthOptions {
  /** `expires_in` on every token, in seconds. `null` omits the field. */
  expiresIn?: number | null;
  /** Issue a new refresh token on every refresh, and kill the one just used. */
  rotate?: boolean;
}

export interface FakeOAuth {
  base: string;
  tokenUrl: string;
  /** The upstream MCP URL for a principal. */
  mcpUrl: (principal: string) => string;
  /** Register a refresh token as belonging to a principal. */
  grant: (refreshToken: string, principal: string) => void;
  /** Every refresh token the endpoint has ever issued or been given, live or not. */
  liveRefreshTokens: () => string[];
  tokenRequests: TokenRequest[];
  seen: Seen[];
  /** Every access token issued, oldest first. */
  issued: () => string[];
  revoke: (accessToken: string) => void;
  /** The next `n` token requests answer this way instead of minting. */
  failNext: (
    n: number,
    answer: { status: number; body?: Record<string, unknown> },
  ) => void;
  /** Hold every token response until `release()`. */
  hold: () => void;
  release: () => void;
  /** Resolves when `n` token requests have ARRIVED (held or not). */
  arrived: (n: number) => Promise<void>;
  options: FakeOAuthOptions;
  close: () => Promise<void>;
}

export async function startFakeOAuth(
  options: FakeOAuthOptions = {},
): Promise<FakeOAuth> {
  const refreshTokens = new Map<string, { principal: string; live: boolean }>();
  const accessTokens = new Map<string, Issued>();
  const issuedOrder: string[] = [];
  const tokenRequests: TokenRequest[] = [];
  const seen: Seen[] = [];
  const failures: { status: number; body?: Record<string, unknown> }[] = [];
  let held: Promise<void> | null = null;
  let releaseHeld = (): void => {};
  const arrivals: { n: number; resolve: () => void }[] = [];
  let counter = 0;

  const app = express();

  app.post(
    "/token",
    express.urlencoded({ extended: false }),
    (req: Request, res: Response) => {
      void (async () => {
        const body = req.body as Record<string, string | undefined>;
        tokenRequests.push({
          grantType: body.grant_type,
          refreshToken: body.refresh_token,
          clientId: body.client_id,
          clientSecret: body.client_secret,
          scope: body.scope,
          resource: body.resource,
          authorization: req.get("authorization"),
        });
        for (const a of arrivals.splice(0)) {
          if (tokenRequests.length >= a.n) a.resolve();
          else arrivals.push(a);
        }
        if (held) await held;

        const failure = failures.shift();
        if (failure) {
          res.status(failure.status).json(failure.body ?? {});
          return;
        }
        if (body.grant_type !== "refresh_token") {
          res.status(400).json({ error: "unsupported_grant_type" });
          return;
        }
        const owner = refreshTokens.get(body.refresh_token ?? "");
        if (!owner || !owner.live) {
          res.status(400).json({
            error: "invalid_grant",
            error_description: `refresh token ${body.refresh_token} is dead`,
          });
          return;
        }

        counter += 1;
        const accessToken = `at-${owner.principal}-${counter}-${randomUUID()}`;
        const expiresIn =
          options.expiresIn === undefined ? 3600 : options.expiresIn;
        accessTokens.set(accessToken, {
          principal: owner.principal,
          expiresAt: expiresIn === null ? null : Date.now() + expiresIn * 1000,
          revoked: false,
        });
        issuedOrder.push(accessToken);

        const answer: Record<string, unknown> = {
          access_token: accessToken,
          token_type: "Bearer",
        };
        if (expiresIn !== null) answer.expires_in = expiresIn;
        if (options.rotate) {
          owner.live = false;
          const next = `rt-${owner.principal}-${counter}-${randomUUID()}`;
          refreshTokens.set(next, { principal: owner.principal, live: true });
          answer.refresh_token = next;
        }
        res.json(answer);
      })();
    },
  );

  const transports: Record<string, StreamableHTTPServerTransport> = {};
  const build = (): McpServer => {
    const server = new McpServer(
      { name: "fake-oauth-upstream", version: "0" },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "whoami",
          description: "the principal this request's bearer belongs to",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    }));
    server.setRequestHandler(CallToolRequestSchema, async (_req, extra) => {
      const bearer = String(
        extra.requestInfo?.headers.authorization ?? "",
      ).replace(/^Bearer\s+/i, "");
      return {
        content: [
          { type: "text", text: accessTokens.get(bearer)?.principal ?? "?" },
        ],
      };
    });
    return server;
  };

  app.all("/mcp/:principal", express.json(), (req: Request, res: Response) => {
    void (async () => {
      const header = req.get("authorization") ?? null;
      const bearer = header?.match(/^Bearer\s+(.+)$/i)?.[1] ?? null;
      const issued = bearer ? accessTokens.get(bearer) : undefined;
      const live =
        issued !== undefined &&
        !issued.revoked &&
        (issued.expiresAt === null || Date.now() < issued.expiresAt) &&
        (req.params.principal === "any" ||
          issued.principal === req.params.principal);
      seen.push({
        path: req.params.principal!,
        bearer,
        principal: issued?.principal ?? null,
        status: live ? 200 : 401,
      });
      if (!live) {
        res.status(401).json({ error: "invalid_token" });
        return;
      }

      const sessionId = req.get("mcp-session-id");
      let transport = sessionId ? transports[sessionId] : undefined;
      if (!transport) {
        if (req.method !== "POST" || !isInitializeRequest(req.body)) {
          res.status(400).json({ error: "no session" });
          return;
        }
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            transports[id] = transport!;
          },
        });
        await build().connect(transport);
      }
      await transport.handleRequest(req, res, req.body);
    })();
  });

  const server: HttpServer = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const addr = server.address();
  if (typeof addr === "string" || !addr) throw new Error("no port");
  const base = `http://127.0.0.1:${addr.port}`;

  return {
    base,
    tokenUrl: `${base}/token`,
    mcpUrl: (principal) => `${base}/mcp/${principal}`,
    grant: (refreshToken, principal) => {
      refreshTokens.set(refreshToken, { principal, live: true });
    },
    liveRefreshTokens: () =>
      [...refreshTokens.entries()].filter(([, v]) => v.live).map(([k]) => k),
    tokenRequests,
    seen,
    issued: () => [...issuedOrder],
    revoke: (accessToken) => {
      const issued = accessTokens.get(accessToken);
      if (issued) issued.revoked = true;
    },
    failNext: (n, answer) => {
      for (let i = 0; i < n; i++) failures.push(answer);
    },
    hold: () => {
      held = new Promise((r) => {
        releaseHeld = r;
      });
    },
    release: () => {
      held = null;
      releaseHeld();
    },
    arrived: (n) =>
      tokenRequests.length >= n
        ? Promise.resolve()
        : new Promise((resolve) => arrivals.push({ n, resolve })),
    options,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
