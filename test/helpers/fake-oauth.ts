import { createHash, randomUUID } from "node:crypto";
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
 *
 * With `mcpAuth`, it is also the AUTHORIZATION SERVER an MCP client discovers
 * (the MCP authorization spec, end to end): the upstream's 401 carries
 * `WWW-Authenticate: Bearer resource_metadata=…`, the protected-resource
 * metadata (RFC 9728) names this server as issuer, its RFC 8414 metadata names
 * `/authorize`, `/token` and — unless turned off — `/register` (RFC 7591).
 * `/authorize` consents at once as `consentAs` and redirects with a code, and
 * `/token` runs the authorization-code grant: PKCE S256, the client id, the
 * redirect URI and the `resource` must all match what `/authorize` saw. A
 * refresh token issued that way is bound to its client, and a refresh that
 * presents another client id is `invalid_client`.
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
  /**
   * `POST` for a JSON-RPC message strad sent. A `GET` is the SDK's
   * server-to-client notification stream, which it opens WITHOUT awaiting it
   * after each handshake, so it can land on the wire after the call that
   * caused the handshake returned.
   */
  http: string;
  /** The JSON-RPC method of a POST (`initialize`, `tools/call`, …). */
  rpc: string | null;
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
  code?: string;
  codeVerifier?: string;
  redirectUri?: string;
  /** Every body key sent, so a test can say what was NOT. */
  keys: string[];
}

export interface McpAuthOptions {
  /** Offer `/register`. Default true. */
  registration?: boolean;
  /**
   * Advertise `client_id_metadata_document_supported: true`. With
   * `registration: false` it is LOOPS' SHAPE: a metadata document is the only
   * way to name a client.
   */
  clientIdMetadataDocument?: boolean;
  /** `/register` answers with a confidential client. */
  confidential?: boolean;
  /** Serve the protected-resource metadata with this status instead. */
  prmStatus?: number;
  /** Serve the authorization server metadata with this status instead. */
  asMetaStatus?: number;
  /** A firewall in front of `/token`: a GET there is a 403 page. */
  tokenBlocked?: boolean;
  /** `scopes_supported` on the protected-resource metadata. */
  scopes?: string[];
  /** `/register` refuses with this status. */
  registrationStatus?: number;
  /** The authorization-code grant answers without a `refresh_token`. */
  omitRefreshToken?: boolean;
  /** The authorization-code grant drops the connection without answering. */
  dropExchange?: boolean;
  /**
   * FIGMA'S SHAPE. `/register` answers 403 unless `client_name` starts with
   * this — case-sensitive, as Figma's is.
   */
  clientNamePrefix?: string;
  /**
   * FIGMA'S SHAPE. `/register` issues a `client_secret` to every client while
   * echoing whatever `token_endpoint_auth_method` it was asked for, and
   * `/token` refuses either grant for that client without the secret.
   */
  issueSecret?: boolean;
  /**
   * GOOGLE'S SHAPE. The code exchange answers with a `refresh_token` only when
   * the consent asked for one as query parameters: `access_type=offline` and
   * `prompt=consent`. The metadata lists no `offline_access` scope and offers
   * no registration, names its issuer with a trailing slash in the
   * protected-resource document and without one in its own, and the upstream
   * answers an unauthenticated `initialize` 200 rather than with a challenge.
   */
  googleOffline?: boolean;
}

export interface FakeOAuthOptions {
  /** `expires_in` on every token, in seconds. `null` omits the field. */
  expiresIn?: number | null;
  /** Issue a new refresh token on every refresh, and kill the one just used. */
  rotate?: boolean;
  /** Act as the upstream's MCP authorization server. See the header. */
  mcpAuth?: McpAuthOptions;
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
  /** Who `/authorize` consents as. Default `alice`. */
  consentAs: (principal: string) => void;
  /** Every `/register` body, in order. */
  registrations: Record<string, unknown>[];
  /** Every `/authorize` query, in order. */
  authorizations: URLSearchParams[];
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
  let consenter = "alice";
  const registrations: Record<string, unknown>[] = [];
  const authorizations: URLSearchParams[] = [];
  const codes = new Map<
    string,
    {
      clientId: string;
      redirectUri: string;
      challenge: string;
      resource: string | null;
      principal: string;
      offline: boolean;
    }
  >();
  /** refresh token -> the client it was issued to, for code-issued tokens. */
  const refreshClients = new Map<string, string>();
  /** client id -> the secret `/register` issued it, under `issueSecret`. */
  const clientSecrets = new Map<string, string>();
  let base = "";

  const app = express();

  const auth = options.mcpAuth;
  if (auth) {
    app.get(
      "/.well-known/oauth-protected-resource/mcp/:principal",
      (req: Request, res: Response) => {
        // `x-unblocked` stands for a request from an address the firewall
        // lets through: the e2e suite's stand-in for BrightData sends it.
        if (auth.prmStatus && !req.get("x-unblocked")) {
          res.status(auth.prmStatus).type("html").send("<html>blocked</html>");
          return;
        }
        res.json({
          resource: `${base}/mcp/${req.params.principal}`,
          authorization_servers: [auth.googleOffline ? `${base}/` : base],
          ...(auth.scopes ? { scopes_supported: auth.scopes } : {}),
        });
      },
    );
    app.get("/.well-known/oauth-authorization-server", (_req, res) => {
      if (auth.asMetaStatus) {
        res.status(auth.asMetaStatus).type("html").send("<html>blocked</html>");
        return;
      }
      res.json({
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        ...(auth.registration === false || auth.googleOffline
          ? {}
          : { registration_endpoint: `${base}/register` }),
        ...(auth.clientIdMetadataDocument
          ? {
              client_id_metadata_document_supported: true,
              token_endpoint_auth_methods_supported: ["none"],
            }
          : {}),
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
        ...(auth.googleOffline
          ? {}
          : { scopes_supported: [...(auth.scopes ?? []), "offline_access"] }),
      });
    });
    if (auth.tokenBlocked) {
      app.get("/token", (_req, res) => {
        res
          .status(403)
          .set("cf-ray", "8a1b2c3d4e5f-EWR")
          .type("html")
          .send("<html>blocked</html>");
      });
    }
    app.post("/register", express.json(), (req: Request, res: Response) => {
      const body = req.body as Record<string, unknown>;
      registrations.push(body);
      if (auth.registrationStatus) {
        res.status(auth.registrationStatus).json({
          error: "access_denied",
          error_description: "UPSTREAM-REGISTRATION-TEXT",
        });
        return;
      }
      if (
        auth.clientNamePrefix !== undefined &&
        !String(body.client_name ?? "").startsWith(auth.clientNamePrefix)
      ) {
        res.status(403).type("text").send("Forbidden");
        return;
      }
      const clientId = `client-${registrations.length}`;
      if (auth.issueSecret) {
        const secret = `dcr-issued-SECRET-${registrations.length}`;
        clientSecrets.set(clientId, secret);
        res.status(201).json({
          client_id: clientId,
          client_secret: secret,
          client_secret_expires_at: 0,
          token_endpoint_auth_method: body.token_endpoint_auth_method,
          redirect_uris: body.redirect_uris,
        });
        return;
      }
      res.status(201).json(
        auth.confidential
          ? {
              client_id: clientId,
              client_secret: "dcr-SECRET-CANARY",
              token_endpoint_auth_method: "client_secret_basic",
            }
          : {
              client_id: clientId,
              token_endpoint_auth_method: "none",
              redirect_uris: body.redirect_uris,
            },
      );
    });
    app.get("/authorize", (req: Request, res: Response) => {
      const q = new URLSearchParams(req.url.split("?")[1] ?? "");
      authorizations.push(q);
      const code = `code-${randomUUID()}`;
      codes.set(code, {
        clientId: q.get("client_id") ?? "",
        redirectUri: q.get("redirect_uri") ?? "",
        challenge: q.get("code_challenge") ?? "",
        resource: q.get("resource"),
        principal: consenter,
        offline:
          q.get("access_type") === "offline" && q.get("prompt") === "consent",
      });
      const to = new URL(q.get("redirect_uri") ?? "");
      to.searchParams.set("code", code);
      to.searchParams.set("state", q.get("state") ?? "");
      res.redirect(302, to.toString());
    });
  }

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
          code: body.code,
          codeVerifier: body.code_verifier,
          redirectUri: body.redirect_uri,
          keys: Object.keys(body),
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
        // A client `/register` issued a secret must present it, on either
        // grant: in the body, or as the Basic password.
        const owed = clientSecrets.get(body.client_id ?? "");
        if (owed !== undefined) {
          const basic = req.get("authorization")?.replace(/^Basic /, "");
          const presented =
            body.client_secret ??
            (basic
              ? Buffer.from(basic, "base64").toString().split(":")[1]
              : undefined);
          if (presented !== owed) {
            res.status(400).json({
              error: "Client ID and client secret are required",
            });
            return;
          }
        }
        if (auth?.dropExchange && body.grant_type === "authorization_code") {
          req.socket.destroy();
          return;
        }
        if (auth && body.grant_type === "authorization_code") {
          const issued = codes.get(body.code ?? "");
          codes.delete(body.code ?? "");
          const challenge = createHash("sha256")
            .update(body.code_verifier ?? "")
            .digest("base64url");
          if (
            !issued ||
            issued.clientId !== body.client_id ||
            issued.redirectUri !== body.redirect_uri ||
            issued.challenge !== challenge ||
            issued.resource !== (body.resource ?? null)
          ) {
            res.status(400).json({ error: "invalid_grant" });
            return;
          }
          counter += 1;
          const refresh = `rt-${issued.principal}-code-${counter}-${randomUUID()}`;
          refreshTokens.set(refresh, {
            principal: issued.principal,
            live: true,
          });
          refreshClients.set(refresh, issued.clientId);
          res.json({
            access_token: `at-unused-${counter}`,
            token_type: "Bearer",
            expires_in: 3600,
            ...(auth.omitRefreshToken || (auth.googleOffline && !issued.offline)
              ? {}
              : { refresh_token: refresh }),
            scope: "mcp:read",
          });
          return;
        }
        if (body.grant_type !== "refresh_token") {
          res.status(400).json({ error: "unsupported_grant_type" });
          return;
        }
        const boundTo = refreshClients.get(body.refresh_token ?? "");
        // A client that authenticates with Basic names itself there, and need
        // not repeat its id in the body (RFC 6749 §2.3.1).
        const basicUser = req.get("authorization")?.replace(/^Basic /, "");
        const refreshing =
          body.client_id ??
          (basicUser
            ? Buffer.from(basicUser, "base64").toString().split(":")[0]
            : undefined);
        if (boundTo !== undefined && boundTo !== refreshing) {
          res.status(401).json({ error: "invalid_client" });
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
          if (boundTo !== undefined) refreshClients.set(next, boundTo);
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
        http: req.method,
        rpc:
          typeof (req.body as { method?: unknown } | undefined)?.method ===
          "string"
            ? (req.body as { method: string }).method
            : null,
      });
      if (!live && auth?.googleOffline && bearer === null) {
        const rpc = req.body as { id?: unknown; method?: unknown };
        if (rpc.method === "initialize") {
          res.json({
            jsonrpc: "2.0",
            id: rpc.id,
            result: {
              protocolVersion: "2025-06-18",
              capabilities: { tools: {} },
              serverInfo: { name: "google-shaped", version: "0" },
            },
          });
          return;
        }
      }
      if (!live) {
        if (auth) {
          res.set(
            "www-authenticate",
            `Bearer realm="OAuth", resource_metadata="${base}/.well-known/` +
              `oauth-protected-resource/mcp/${req.params.principal}", ` +
              `error="invalid_token"`,
          );
        }
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
  base = `http://127.0.0.1:${addr.port}`;

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
    consentAs: (principal) => {
      consenter = principal;
    },
    registrations,
    authorizations,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
