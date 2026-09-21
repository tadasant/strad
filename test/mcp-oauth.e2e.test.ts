import { createHash, randomBytes } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { tokenStoreFromConfig } from "../src/auth/index.ts";
import {
  guardedFetch,
  type FetchedDocument,
} from "../src/auth/mcp-oauth/cimd.ts";
import { mintToken } from "../src/auth/tokens.ts";
import { parseConfig } from "../src/config/load.ts";
import { Registry } from "../src/gateway/registry.ts";
import { createApp } from "../src/http/app.ts";
import {
  EnvSecretProvider,
  sharedSecretProviders,
} from "../src/secrets/provider/index.ts";
import {
  fakeGoogleGrant,
  type FakeGoogleGrant,
} from "./helpers/fake-google-grant.ts";

/**
 * The whole flow, end to end, against a stubbed Google.
 *
 * This is the acceptance test written down: a client that knows nothing about
 * strad but the URL — `…/mcp?servers=granola` — discovers the authorization
 * server, registers itself, sends a human through a sign-in, exchanges a code
 * for a token, calls `/mcp` with it, watches the token expire, refreshes, and
 * calls again. Every hop is the real route; only accounts.google.com is fake
 * (see `test/helpers/fake-google-grant.ts`).
 *
 * The `?servers=granola` shape is the point of several assertions rather than
 * decoration. The URL a human pastes carries a query; the RFC 8707 resource
 * identifier does not. A token rejected because the request URL carried
 * `?servers=` would fail the acceptance test while passing every test written
 * against the bare `/mcp`.
 */

const YAML = `
version: 1
gateway: { name: strad, env: test }
auth:
  staticTokens: { enabled: true }
  mcpOAuth:
    enabled: true
    hostedDomain: tadasant.com
    roles: [admin]
    accessTokenTtlSeconds: 3600
roles:
  admin: { servers: ["*"] }
  narrow: { servers: [] }
servers:
  - slug: granola
    kind: builtin
    module: "./servers/echo.js"
    entitlements: [admin]
  - slug: other
    kind: builtin
    module: "./servers/echo.js"
    entitlements: [admin]
`;

const CONFIG = parseConfig(YAML);
const ENV = {
  NODE_ENV: "test",
  // Key material for the sealers and ciphers. Nothing else is needed: the
  // Google leg is injected.
  STRAD_OAUTH_KEY: "an-oauth-signing-key-of-sufficient-length",
} as NodeJS.ProcessEnv;

const CLAUDE_CALLBACK = "https://claude.ai/api/mcp/auth_callback";

/**
 * Client id metadata documents, served by URL.
 *
 * The seam is the fetch and nothing else: every URL in this table answers the
 * canned response, and every URL NOT in it goes to the real `guardedFetch` —
 * so `https://localhost/…` really is resolved, really does come back as
 * `127.0.0.1`, and really is refused by the address check, with no document
 * server needed to prove it.
 */
const CLAUDE_CIMD = "https://claude.ai/oauth/mcp-oauth-client-metadata";
const VSCODE_CIMD = "https://vscode.dev/oauth/client-metadata.json";
const MISMATCHED_CIMD = "https://evil.example/claude.json";
const MARKUP_CIMD = "https://markup.example/client.json";
const documents = new Map<string, FetchedDocument>();
const fetched: string[] = [];

function serveDocument(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  documents.set(url, {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
    body: Buffer.from(JSON.stringify(body)),
  });
}

// claude.ai's document, verbatim as it is served — including the JWT-bearer
// grant strad does not implement, which must not make the document invalid.
serveDocument(
  CLAUDE_CIMD,
  {
    client_id: CLAUDE_CIMD,
    client_name: "Claude",
    client_uri: "https://claude.ai",
    redirect_uris: [CLAUDE_CALLBACK],
    grant_types: [
      "authorization_code",
      "refresh_token",
      "urn:ietf:params:oauth:grant-type:jwt-bearer",
    ],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  },
  { "cache-control": "public, max-age=300" },
);
// VS Code's, verbatim: a loopback listener and a `no-store` cache policy.
serveDocument(
  VSCODE_CIMD,
  {
    client_name: "Visual Studio Code",
    logo_uri: "https://code.visualstudio.com/assets/branding/code-stable.png",
    grant_types: [
      "authorization_code",
      "refresh_token",
      "urn:ietf:params:oauth:grant-type:device_code",
    ],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    application_type: "native",
    client_id: VSCODE_CIMD,
    client_uri: "https://vscode.dev/product",
    redirect_uris: ["http://127.0.0.1:33418/", "https://vscode.dev/redirect"],
  },
  { "cache-control": "no-store,no-cache,max-age=0" },
);
// A document that claims to be claude.ai's from somewhere else.
serveDocument(MISMATCHED_CIMD, {
  client_id: CLAUDE_CIMD,
  client_name: "Claude",
  redirect_uris: ["https://evil.example/cb"],
});

// A client_name carrying markup: the consent screen must print it, not run it.
serveDocument(MARKUP_CIMD, {
  client_id: MARKUP_CIMD,
  client_name: '<img src=x onerror="alert(1)">Claude',
  redirect_uris: [CLAUDE_CALLBACK],
});

async function fetchDocument(url: URL): Promise<FetchedDocument> {
  fetched.push(url.href);
  return documents.get(url.href) ?? guardedFetch(url);
}

let server: Server;
let base: string;
let google: FakeGoogleGrant;
let staticToken: string;

beforeAll(async () => {
  const minted = mintToken({ env: "test", label: "zimmer", roles: ["admin"] });
  staticToken = minted.plaintext;
  const env = { ...ENV, STRAD_TOKENS: JSON.stringify([minted.record]) };

  google = fakeGoogleGrant("tadasant.com");
  const registry = await Registry.build({
    config: CONFIG,
    secrets: sharedSecretProviders(new EnvSecretProvider({})),
    mode: "core",
    env,
  });
  const app = createApp({
    config: CONFIG,
    registry,
    tokenStore: tokenStoreFromConfig(CONFIG, env),
    mode: "core",
    env,
    mcpOAuthGoogle: google,
    mcpOAuthClientMetadataFetch: fetchDocument,
  });
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const addr = server.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  vi.useRealTimers();
  await new Promise<void>((r) => server.close(() => r()));
});

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

/** PKCE, client side. */
function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return {
    verifier,
    challenge: createHash("sha256")
      .update(verifier, "ascii")
      .digest("base64url"),
  };
}

async function register(
  overrides: Record<string, unknown> = {},
): Promise<Response> {
  return fetch(`${base}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Claude",
      redirect_uris: [CLAUDE_CALLBACK],
      ...overrides,
    }),
  });
}

interface Authorized {
  clientId: string;
  verifier: string;
  code: string;
  state: string;
  iss: string;
}

/**
 * Register, authorize, sign in, consent — everything up to the code landing on
 * the client's redirect URI. The steps a human drives, driven.
 */
async function walkToCode(
  opts: {
    resource?: string;
    state?: string;
    /** A metadata-document URL to present instead of registering. */
    clientId?: string;
    redirectUri?: string;
    /** Receives the consent page's HTML. */
    onConsent?: (html: string) => void;
  } = {},
): Promise<Authorized> {
  const clientId =
    opts.clientId ??
    ((await (await register()).json()) as { client_id: string }).client_id;
  const redirectUri = opts.redirectUri ?? CLAUDE_CALLBACK;
  const { verifier, challenge } = pkce();
  const state = opts.state ?? randomBytes(8).toString("hex");

  const authorize = new URL(`${base}/oauth/authorize`);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("client_id", clientId);
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("code_challenge", challenge);
  authorize.searchParams.set("code_challenge_method", "S256");
  authorize.searchParams.set("state", state);
  if (opts.resource) authorize.searchParams.set("resource", opts.resource);

  const started = await fetch(authorize, { redirect: "manual" });
  expect(started.status).toBe(302);
  const cookie = txCookie(started);

  const callback = new URL(`${base}/oauth/callback/google`);
  callback.searchParams.set("code", "google-code");
  callback.searchParams.set("state", google.lastState);
  const consent = await fetch(callback, { headers: { cookie } });
  expect(consent.status).toBe(200);
  const html = await consent.text();
  opts.onConsent?.(html);
  const approval = approvalField(html);

  const approved = await fetch(`${base}/oauth/approve`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ approval, decision: "allow" }),
    redirect: "manual",
  });
  expect(approved.status).toBe(302);
  const landed = new URL(approved.headers.get("location") ?? "");

  return {
    clientId,
    verifier,
    code: landed.searchParams.get("code") ?? "",
    state: landed.searchParams.get("state") ?? "",
    iss: landed.searchParams.get("iss") ?? "",
  };
}

function txCookie(res: Response): string {
  const raw = res.headers.get("set-cookie") ?? "";
  return raw.split(";")[0] ?? "";
}

function approvalField(html: string): string {
  const match = /name="approval" value="([^"]+)"/.exec(html);
  if (!match?.[1]) throw new Error("no approval field on the consent page");
  return match[1];
}

/** The token endpoint's answer, in the two shapes it takes. */
interface TokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
  error?: string;
  error_description?: string;
}

async function exchange(
  body: Record<string, string>,
): Promise<{ status: number; json: TokenResponse }> {
  const res = await fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  return { status: res.status, json: (await res.json()) as TokenResponse };
}

/** A real MCP client against `/mcp?servers=…`, with a bearer. */
async function callMcp(
  token: string,
  query: string,
): Promise<{ tools: string[] }> {
  const client = new Client({ name: "e2e", version: "1" });
  const transport = new StreamableHTTPClientTransport(
    new URL(`${base}/mcp${query}`),
    { requestInit: { headers: { Authorization: `Bearer ${token}` } } },
  );
  await client.connect(transport);
  const listed = await client.listTools();
  await client.close();
  return { tools: listed.tools.map((t) => t.name) };
}

// ---------------------------------------------------------------------------

describe("discovery names the authorization server strad actually runs", () => {
  it("points the RFC 9728 document at this same origin", async () => {
    const res = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`);
    expect(res.status).toBe(200);
    const doc = (await res.json()) as Record<string, unknown>;
    expect(doc.resource).toBe(`${base}/mcp`);
    expect(doc.authorization_servers).toEqual([base]);
    expect(doc.scopes_supported).toEqual(["mcp"]);
  });

  it("serves RFC 8414 metadata at both the suffixed and bare well-known paths", async () => {
    for (const path of [
      "/.well-known/oauth-authorization-server/mcp",
      "/.well-known/oauth-authorization-server",
    ]) {
      const res = await fetch(`${base}${path}`);
      expect(res.status, path).toBe(200);
      const doc = (await res.json()) as Record<string, unknown>;
      expect(doc.issuer).toBe(base);
      expect(doc.authorization_endpoint).toBe(`${base}/oauth/authorize`);
      expect(doc.token_endpoint).toBe(`${base}/oauth/token`);
      expect(doc.registration_endpoint).toBe(`${base}/oauth/register`);
      expect(doc.revocation_endpoint).toBe(`${base}/oauth/revoke`);
      expect(doc.response_types_supported).toEqual(["code"]);
      expect(doc.grant_types_supported).toEqual([
        "authorization_code",
        "refresh_token",
      ]);
      // S256 and ONLY S256. `plain` advertised here would be a downgrade
      // advertised, and the authorization endpoint refuses it anyway.
      expect(doc.code_challenge_methods_supported).toEqual(["S256"]);
      expect(doc.token_endpoint_auth_methods_supported).toEqual(["none"]);
    }
  });

  it("answers the browser preflight a remote client sends first", async () => {
    const res = await fetch(`${base}/oauth/token`, { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    // Never on a cookie-bearing route: /authorize is a top-level navigation.
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("`401`s an unauthenticated /mcp with a pointer at that document", async () => {
    const res = await fetch(`${base}/mcp?servers=granola`, { method: "POST" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain(
      `resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
    );
  });
});

describe("dynamic client registration", () => {
  it("registers a public client and hands back a usable client_id", async () => {
    const res = await register();
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.client_id).toBe("string");
    expect(body.redirect_uris).toEqual([CLAUDE_CALLBACK]);
    expect(body.token_endpoint_auth_method).toBe("none");
    expect(body.grant_types).toEqual(["authorization_code", "refresh_token"]);
    // A PUBLIC client: no secret was issued, because a dynamically-registered
    // MCP client runs where its user can read it.
    expect(body.client_secret).toBeUndefined();
  });

  it("admits claude.ai and claude.com without an operator editing anything", async () => {
    const res = await register({
      redirect_uris: [
        "https://claude.ai/api/mcp/auth_callback",
        "https://claude.com/api/mcp/auth_callback",
      ],
    });
    expect(res.status).toBe(201);
  });

  it("registers a client that lists grants strad does not serve, narrowed to the ones it does", async () => {
    // What a real client sends: claude.ai's metadata names the JWT-bearer
    // grant and VS Code's the device grant. Refusing the registration over them
    // would be a connector that cannot be added.
    const res = await register({
      grant_types: [
        "authorization_code",
        "refresh_token",
        "urn:ietf:params:oauth:grant-type:device_code",
      ],
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.grant_types).toEqual(["authorization_code", "refresh_token"]);
  });

  it("still refuses a registration that does not include the code flow", async () => {
    const res = await register({ grant_types: ["refresh_token"] });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("invalid_client_metadata");
  });

  it("admits a native client's loopback listener", async () => {
    const res = await register({
      redirect_uris: ["http://127.0.0.1:33418/callback"],
    });
    expect(res.status).toBe(201);
  });
});

describe("the flow a human walks", () => {
  it("issues a token for the `?servers=granola` URL that was pasted", async () => {
    // The resource indicator carries the query, because the URL the human
    // pasted did. It must be accepted and normalised, not refused.
    const authorized = await walkToCode({
      resource: `${base}/mcp?servers=granola`,
    });
    expect(authorized.code).not.toBe("");
    expect(authorized.iss).toBe(base);

    const { status, json } = await exchange({
      grant_type: "authorization_code",
      code: authorized.code,
      client_id: authorized.clientId,
      code_verifier: authorized.verifier,
      redirect_uri: CLAUDE_CALLBACK,
    });
    expect(status).toBe(200);
    expect(json.token_type).toBe("Bearer");
    expect(json.expires_in).toBe(3600);
    expect(json.access_token.startsWith("strad_oat_")).toBe(true);
    expect(json.refresh_token.startsWith("strad_ort_")).toBe(true);

    // THE assertion the whole change is for: the token is used at the URL the
    // human pasted, query and all.
    const { tools } = await callMcp(json.access_token, "?servers=granola");
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.every((t) => t.startsWith("granola__"))).toBe(true);
  });

  it("echoes the client's own `state` back unchanged", async () => {
    const authorized = await walkToCode({ state: "claude-state-abc123" });
    expect(authorized.state).toBe("claude-state-abc123");
  });

  it("expires the access token on the hour, and refreshes past it", async () => {
    const authorized = await walkToCode();
    const first = await exchange({
      grant_type: "authorization_code",
      code: authorized.code,
      client_id: authorized.clientId,
      code_verifier: authorized.verifier,
    });
    expect(first.status).toBe(200);
    await expect(
      callMcp(first.json.access_token, "?servers=granola"),
    ).resolves.toBeTruthy();

    // Only `Date` is faked: the HTTP server, its sockets and its timers are
    // real, and it is the token's own `exp` that has to be judged stale.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 3601 * 1000);
    try {
      const stale = await fetch(`${base}/mcp?servers=granola`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${first.json.access_token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      expect(stale.status).toBe(401);

      // The refresh token has NO expiry, so the same hour does not touch it.
      const refreshed = await exchange({
        grant_type: "refresh_token",
        refresh_token: first.json.refresh_token,
        client_id: authorized.clientId,
      });
      expect(refreshed.status).toBe(200);
      expect(refreshed.json.access_token).not.toBe(first.json.access_token);
      // Not rotated, and deliberately — see docs/auth/overview.md. A new
      // string while the old one stayed valid would be the appearance of
      // rotation without the property.
      expect(refreshed.json.refresh_token).toBe(first.json.refresh_token);

      const { tools } = await callMcp(
        refreshed.json.access_token,
        "?servers=granola",
      );
      expect(tools.length).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("narrows to the servers asked for, exactly as a static token does", async () => {
    const authorized = await walkToCode();
    const { json } = await exchange({
      grant_type: "authorization_code",
      code: authorized.code,
      client_id: authorized.clientId,
      code_verifier: authorized.verifier,
    });

    const both = await callMcp(json.access_token, "");
    expect(both.tools.some((t) => t.startsWith("granola__"))).toBe(true);
    expect(both.tools.some((t) => t.startsWith("other__"))).toBe(true);

    const one = await callMcp(json.access_token, "?servers=granola");
    expect(one.tools.every((t) => t.startsWith("granola__"))).toBe(true);

    // And the same 424 a static token gets for a slug nobody configured.
    const res = await fetch(`${base}/mcp?servers=nope`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${json.access_token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(424);
  });
});

describe("both doors are open at once", () => {
  it("serves a static token and an OAuth token side by side", async () => {
    const authorized = await walkToCode();
    const { json } = await exchange({
      grant_type: "authorization_code",
      code: authorized.code,
      client_id: authorized.clientId,
      code_verifier: authorized.verifier,
    });

    const viaOauth = await callMcp(json.access_token, "?servers=granola");
    const viaStatic = await callMcp(staticToken, "?servers=granola");
    // The same toolset from the same endpoint, reached with two credentials
    // that share no code path beyond `bearerToken`. The static one is what
    // every headless agent holds and is the regression this must not cause.
    expect(viaStatic.tools).toEqual(viaOauth.tools);
  });
});

// ---------------------------------------------------------------------------
// Client ID Metadata Documents
// ---------------------------------------------------------------------------

/** `/oauth/authorize` for a client, up to strad's first answer. */
async function authorizeAs(
  clientId: string,
  redirectUri: string = CLAUDE_CALLBACK,
): Promise<Response> {
  const authorize = new URL(`${base}/oauth/authorize`);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("client_id", clientId);
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("code_challenge", pkce().challenge);
  authorize.searchParams.set("code_challenge_method", "S256");
  authorize.searchParams.set("state", "s");
  return fetch(authorize, { redirect: "manual" });
}

describe("client id metadata documents", () => {
  it("advertises support beside the registration endpoint", async () => {
    const res = await fetch(`${base}/.well-known/oauth-authorization-server`);
    const doc = (await res.json()) as Record<string, unknown>;
    expect(doc.client_id_metadata_document_supported).toBe(true);
    // Additive: DCR is still offered to every client that does not do CIMD.
    expect(doc.registration_endpoint).toBe(`${base}/oauth/register`);
  });

  it("connects claude.ai by its document URL, with no registration, end to end", async () => {
    let consent = "";
    const authorized = await walkToCode({
      clientId: CLAUDE_CIMD,
      resource: `${base}/mcp?servers=granola`,
      onConsent: (html) => (consent = html),
    });
    // The consent screen names the host that published the client, not just
    // the name the client gave itself.
    expect(consent).toContain("Claude");
    expect(consent).toContain("published by <code>claude.ai</code>");
    expect(consent).not.toContain("program on this computer");

    const first = await exchange({
      grant_type: "authorization_code",
      code: authorized.code,
      client_id: CLAUDE_CIMD,
      code_verifier: authorized.verifier,
      redirect_uri: CLAUDE_CALLBACK,
    });
    expect(first.status).toBe(200);
    const { tools } = await callMcp(
      first.json.access_token,
      "?servers=granola",
    );
    expect(tools.length).toBeGreaterThan(0);

    // Refresh works on the URL client id too, and never fetches: the grant is
    // bound to its client by fingerprint at /oauth/authorize.
    const before = fetched.length;
    const refreshed = await exchange({
      grant_type: "refresh_token",
      refresh_token: first.json.refresh_token,
      client_id: CLAUDE_CIMD,
    });
    expect(refreshed.status).toBe(200);
    expect(fetched.length).toBe(before);
    await expect(
      callMcp(refreshed.json.access_token, "?servers=granola"),
    ).resolves.toBeTruthy();
  });

  it("will not let a DCR client spend a code issued to a CIMD client", async () => {
    const authorized = await walkToCode({ clientId: CLAUDE_CIMD });
    const registered = (await (await register()).json()) as {
      client_id: string;
    };
    const { status, json } = await exchange({
      grant_type: "authorization_code",
      code: authorized.code,
      client_id: registered.client_id,
      code_verifier: authorized.verifier,
    });
    expect(status).toBe(400);
    expect(json.error).toBe("invalid_grant");
  });

  it("warns on the consent screen when the code goes to a loopback listener", async () => {
    let consent = "";
    await walkToCode({
      clientId: VSCODE_CIMD,
      redirectUri: "http://127.0.0.1:33418/",
      onConsent: (html) => (consent = html),
    });
    expect(consent).toContain("published by <code>vscode.dev</code>");
    expect(consent).toContain("program on this computer");
  });

  it("escapes a client_name that carries markup on the consent screen", async () => {
    let consent = "";
    await walkToCode({
      clientId: MARKUP_CIMD,
      onConsent: (html) => (consent = html),
    });
    expect(consent).not.toContain("<img src=x");
    expect(consent).toContain("&lt;img src=x");
  });

  it("refuses a document whose client_id is not the URL it was fetched from", async () => {
    const res = await authorizeAs(MISMATCHED_CIMD, "https://evil.example/cb");
    expect(res.status).toBe(400);
    // A page, never a redirect: nothing about the destination is verified.
    expect(res.headers.get("location")).toBeNull();
    expect(await res.text()).toContain("does not match the URL");
  });

  it("refuses a redirect_uri the document does not list, without redirecting to it", async () => {
    const res = await authorizeAs(CLAUDE_CIMD, "https://attacker.example/cb");
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    expect(await res.text()).toContain("metadata document at claude.ai");
  });

  it("refuses to fetch a private, loopback or link-local address", async () => {
    for (const clientId of [
      "https://127.0.0.1/client.json",
      "https://169.254.169.254/latest/meta-data",
      "https://[::1]/client.json",
      "https://10.0.0.8/client.json",
    ]) {
      const before = fetched.length;
      const res = await authorizeAs(clientId);
      expect(res.status, clientId).toBe(400);
      expect(res.headers.get("location")).toBeNull();
      // Refused on its face — the fetch was never attempted.
      expect(fetched.length, clientId).toBe(before);
    }
  });

  it("refuses a name that resolves to loopback, at the socket's own lookup", async () => {
    // Not in the table, so this is the REAL guarded fetch, the real resolver
    // and the real address check.
    const res = await authorizeAs("https://localhost/client.json");
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("private, loopback or reserved address");
  });

  it("refuses an http client_id", async () => {
    const res = await authorizeAs(
      "http://claude.ai/oauth/mcp-oauth-client-metadata",
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("must use https");
  });

  it("answers invalid_client at the token endpoint for a malformed URL client id", async () => {
    const { status, json } = await exchange({
      grant_type: "authorization_code",
      code: "x",
      client_id: "http://claude.ai/x",
      code_verifier: "y".repeat(43),
    });
    expect(status).toBe(401);
    expect(json.error).toBe("invalid_client");
  });
});
