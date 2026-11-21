import { createHash, randomBytes } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tokenStoreFromConfig } from "../src/auth/index.ts";
import type { FetchedDocument } from "../src/auth/mcp-oauth/cimd.ts";
import { clientFingerprint } from "../src/auth/mcp-oauth/clients.ts";
import {
  mintAccessToken,
  mintRefreshToken,
  readAccessToken,
  readRefreshToken,
} from "../src/auth/mcp-oauth/grants.ts";
import {
  resolveMcpOAuth,
  verifyAccessToken,
  type McpOAuth,
} from "../src/auth/mcp-oauth/index.ts";
import {
  ClientPolicies,
  requestedSlugs,
  scopeString,
} from "../src/auth/mcp-oauth/policy.ts";
import { parseConfig } from "../src/config/load.ts";
import { entitledServers } from "../src/gateway/entitlements.ts";
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
 * Per-client policy and `slug:` scopes on strad's authorization server.
 *
 * Two halves, and the first is the one that matters most:
 *
 *   - **A config with no `clients` block, and a token minted before slug
 *     scopes existed, behave exactly as before.** Same roles, no narrowing,
 *     `scope: "mcp"`, DCR open, one TTL.
 *   - **Every new knob only narrows.** A listed client's ceiling, its slug
 *     allowlist, a `slug:` scope, a box unticked on the consent screen, a
 *     narrower scope on refresh — and a request for more than the ceiling is
 *     refused rather than quietly granted or quietly dropped.
 */

const KEY = "an-oauth-signing-key-of-sufficient-length";
const CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const CLAUDE = "https://claude.ai/oauth/mcp-oauth-client-metadata";
const ZIMMER = "https://zimmer.example.com/oauth/client.json";
const STRANGER = "https://stranger.example.com/client.json";

function yaml(mcpOAuthExtra = ""): string {
  return `
version: 1
gateway: { name: strad, env: test }
auth:
  staticTokens: { enabled: true }
  mcpOAuth:
    enabled: true
    hostedDomain: tadasant.com
    roles: [admin]
${mcpOAuthExtra}
roles:
  admin: { servers: ["*"] }
  limited: { servers: [alpha, beta] }
servers:
  - slug: alpha
    kind: builtin
    module: "./servers/echo.js"
    entitlements: [admin, limited]
  - slug: beta
    kind: builtin
    module: "./servers/echo.js"
    entitlements: [admin, limited]
  - slug: gamma
    kind: builtin
    module: "./servers/echo.js"
    entitlements: [admin]
`;
}

const documents = new Map<string, FetchedDocument>();
for (const [id, name] of [
  [CLAUDE, "Claude"],
  [ZIMMER, "Zimmer"],
  [STRANGER, "Stranger"],
] as const) {
  documents.set(id, {
    status: 200,
    headers: { "content-type": "application/json" },
    body: Buffer.from(
      JSON.stringify({
        client_id: id,
        client_name: name,
        redirect_uris: [CALLBACK],
        token_endpoint_auth_method: "none",
      }),
    ),
  });
}
async function fetchDocument(url: URL): Promise<FetchedDocument> {
  const doc = documents.get(url.href);
  if (!doc) throw new Error(`no document for ${url.href}`);
  return doc;
}

interface Gateway {
  base: string;
  server: Server;
  google: FakeGoogleGrant;
  oauth: McpOAuth;
  close: () => Promise<void>;
}

async function gateway(extra = ""): Promise<Gateway> {
  const config = parseConfig(yaml(extra));
  const env = {
    NODE_ENV: "test",
    STRAD_OAUTH_KEY: KEY,
    STRAD_TOKENS: "[]",
  } as NodeJS.ProcessEnv;
  const google = fakeGoogleGrant("tadasant.com");
  const registry = await Registry.build({
    config,
    secrets: sharedSecretProviders(new EnvSecretProvider({})),
    mode: "core",
    env,
  });
  const app = createApp({
    config,
    registry,
    tokenStore: tokenStoreFromConfig(config, env),
    mode: "core",
    env,
    mcpOAuthGoogle: google,
    mcpOAuthClientMetadataFetch: fetchDocument,
  });
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // Same config, same key: the same ciphers and policies the app holds, so a
  // test can open what the app sealed.
  const oauth = resolveMcpOAuth({ config, env, google, log: () => {} });
  if (!oauth) throw new Error("no oauth");
  return {
    base,
    server,
    google,
    oauth,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return {
    verifier,
    challenge: createHash("sha256")
      .update(verifier, "ascii")
      .digest("base64url"),
  };
}

interface Walk {
  /** The /oauth/authorize answer when it did not go to Google. */
  refused?: Response;
  consent?: string;
  /** Where /oauth/approve sent the browser. */
  landed?: URL;
  verifier: string;
}

/**
 * The browser half: authorize, Google, consent, approve.
 *
 * `tick` is the human's checkbox choice: `"all"` posts every offered box,
 * an array posts those, and `undefined` posts the form without the slug list
 * at all — what a page from before slug consent existed would post.
 */
async function walk(
  g: Gateway,
  opts: {
    clientId: string;
    scope?: string;
    tick?: "all" | string[];
  },
): Promise<Walk> {
  const { verifier, challenge } = pkce();
  const url = new URL(`${g.base}/oauth/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", opts.clientId);
  url.searchParams.set("redirect_uri", CALLBACK);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", "s");
  if (opts.scope !== undefined) url.searchParams.set("scope", opts.scope);
  const started = await fetch(url, { redirect: "manual" });
  const location = started.headers.get("location") ?? "";
  if (started.status !== 302 || !location.startsWith("https://accounts")) {
    return { refused: started, verifier };
  }
  const cookie = (started.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const callback = new URL(`${g.base}/oauth/callback/google`);
  callback.searchParams.set("code", "google-code");
  callback.searchParams.set("state", g.google.lastState);
  const consentRes = await fetch(callback, {
    headers: { cookie },
    redirect: "manual",
  });
  const consent = await consentRes.text();
  const approval = /name="approval" value="([^"]+)"/.exec(consent)?.[1] ?? "";
  const offered = [...consent.matchAll(/name="slug" value="([^"]+)"/g)].map(
    (m) => m[1] ?? "",
  );
  const form = new URLSearchParams({ approval, decision: "allow" });
  if (opts.tick !== undefined) {
    form.append("slug_choice", "1");
    for (const slug of opts.tick === "all" ? offered : opts.tick)
      form.append("slug", slug);
  }
  const approved = await fetch(`${g.base}/oauth/approve`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form,
    redirect: "manual",
  });
  return {
    consent,
    landed: new URL(approved.headers.get("location") ?? ""),
    verifier,
  };
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string;
  error?: string;
  error_description?: string;
}

async function token(
  g: Gateway,
  body: Record<string, string>,
): Promise<{ status: number; json: TokenResponse }> {
  const res = await fetch(`${g.base}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  return { status: res.status, json: (await res.json()) as TokenResponse };
}

async function exchange(
  g: Gateway,
  clientId: string,
  w: Walk,
): Promise<{ status: number; json: TokenResponse }> {
  return token(g, {
    grant_type: "authorization_code",
    code: w.landed?.searchParams.get("code") ?? "",
    client_id: clientId,
    code_verifier: w.verifier,
  });
}

async function mcp(g: Gateway, bearer: string, query: string): Promise<number> {
  const res = await fetch(`${g.base}/mcp${query}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  return res.status;
}

/** The slug set a token opens onto, through the real verifier. */
function principalOf(g: Gateway, access: string) {
  const verdict = verifyAccessToken(access, g.oauth, `${g.base}/mcp`);
  if (!verdict.ok) throw new Error(verdict.reason);
  return verdict.principal;
}

async function register(g: Gateway): Promise<Response> {
  return fetch(`${g.base}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "DCR", redirect_uris: [CALLBACK] }),
  });
}

// ---------------------------------------------------------------------------

describe("a config with no clients block behaves exactly as before", () => {
  let g: Gateway;
  beforeAll(async () => (g = await gateway()));
  afterAll(async () => g.close());

  it("defaults every new setting to the open, unnarrowed answer", () => {
    const settings = parseConfig(yaml()).auth.mcpOAuth;
    expect(settings.clients).toEqual([]);
    expect(settings.allowUnlistedClients).toBe(true);
    expect(settings.dynamicRegistration).toBe(true);
    expect(settings.advertiseSlugScopes).toBe(false);
    const off = parseConfig(`
version: 1
gateway: { name: strad, env: test }
auth: { staticTokens: { enabled: true } }
`).auth.mcpOAuth;
    expect(off).toMatchObject({
      enabled: false,
      clients: [],
      allowUnlistedClients: true,
      dynamicRegistration: true,
    });
  });

  it("issues `mcp`, with no narrowing, when every box is left ticked", async () => {
    const w = await walk(g, { clientId: CLAUDE, tick: "all" });
    expect(w.consent).toContain('value="alpha" checked');
    expect(w.consent).toContain('value="gamma" checked');
    const { status, json } = await exchange(g, CLAUDE, w);
    expect(status).toBe(200);
    expect(json.scope).toBe("mcp");
    expect(json.expires_in).toBe(3600);
    expect(readAccessToken(g.oauth.keys.access, json.access_token)?.slugs).toBe(
      undefined,
    );
    expect(
      readRefreshToken(g.oauth.keys.refresh, json.refresh_token)?.slugs,
    ).toBe(undefined);
    // The exact principal a token verified to before this change.
    expect(principalOf(g, json.access_token)).toEqual({
      kind: "mcp-oauth",
      id: "google-sub-1",
      label: "tadas@tadasant.com",
      roles: ["admin"],
    });
    expect(await mcp(g, json.access_token, "?servers=gamma")).toBe(200);
  });

  it("grants the request unchanged when the approve post carries no slug list", async () => {
    const w = await walk(g, { clientId: CLAUDE });
    const { json } = await exchange(g, CLAUDE, w);
    expect(json.scope).toBe("mcp");
  });

  it("ignores a scope it does not know, as it always did", async () => {
    const w = await walk(g, {
      clientId: CLAUDE,
      scope: "mcp openid whatever",
      tick: "all",
    });
    const { status, json } = await exchange(g, CLAUDE, w);
    expect(status).toBe(200);
    expect(json.scope).toBe("mcp");
  });

  it("still registers DCR clients and lets them complete a grant", async () => {
    const res = await register(g);
    expect(res.status).toBe(201);
    const { client_id } = (await res.json()) as { client_id: string };
    const w = await walk(g, { clientId: client_id, tick: "all" });
    expect((await exchange(g, client_id, w)).status).toBe(200);
  });

  it("advertises `mcp` and nothing else, in both metadata documents", async () => {
    const as = (await (
      await fetch(`${g.base}/.well-known/oauth-authorization-server`)
    ).json()) as Record<string, unknown>;
    expect(as.scopes_supported).toEqual(["mcp"]);
    expect(as.registration_endpoint).toBe(`${g.base}/oauth/register`);
    const pr = (await (
      await fetch(`${g.base}/.well-known/oauth-protected-resource/mcp`)
    ).json()) as Record<string, unknown>;
    expect(pr.scopes_supported).toEqual(["mcp"]);
  });

  it("verifies and refreshes tokens minted in the format from before slug scopes", async () => {
    // These two calls are the pre-change minting shapes, field for field: no
    // `slugs` member at all.
    const identity = {
      sub: "google-sub-1",
      email: "tadas@tadasant.com",
      hd: "tadasant.com",
    };
    const access = mintAccessToken(g.oauth.keys.access, {
      cid: clientFingerprint(CLAUDE),
      aud: `${g.base}/mcp`,
      identity,
      ttlMs: 60_000,
    });
    expect(principalOf(g, access)).toEqual({
      kind: "mcp-oauth",
      id: "google-sub-1",
      label: "tadas@tadasant.com",
      roles: ["admin"],
    });
    expect(await mcp(g, access, "?servers=gamma")).toBe(200);

    // A refresh token needs a live Google grant behind it.
    await walk(g, { clientId: CLAUDE, tick: "all" });
    const refresh = mintRefreshToken(g.oauth.keys.refresh, {
      cid: clientFingerprint(CLAUDE),
      resource: `${g.base}/mcp`,
      identity,
      googleRefreshToken: g.google.lastRefreshToken,
    });
    for (const scope of [undefined, "mcp"]) {
      const { status, json } = await token(g, {
        grant_type: "refresh_token",
        refresh_token: refresh,
        client_id: CLAUDE,
        ...(scope ? { scope } : {}),
      });
      expect(status).toBe(200);
      expect(json.scope).toBe("mcp");
      expect(json.refresh_token).toBe(refresh);
      expect(principalOf(g, json.access_token).slugs).toBe(undefined);
    }
  });
});

describe("slug scopes", () => {
  let g: Gateway;
  beforeAll(async () => (g = await gateway()));
  afterAll(async () => g.close());

  it("confines a token to the slugs the client asked for", async () => {
    const w = await walk(g, {
      clientId: CLAUDE,
      scope: "slug:alpha slug:beta",
      tick: "all",
    });
    // Only the asked-for slugs are offered.
    expect(w.consent).toContain('value="alpha"');
    expect(w.consent).toContain('value="beta"');
    expect(w.consent).not.toContain('value="gamma"');
    expect(w.consent).toContain("asked for");
    const { json } = await exchange(g, CLAUDE, w);
    expect(json.scope).toBe("slug:alpha slug:beta");
    expect(principalOf(g, json.access_token).slugs).toEqual(["alpha", "beta"]);
    expect(await mcp(g, json.access_token, "?servers=alpha")).toBe(200);
    // Not entitled: the ordinary 424, exactly as a narrower role answers.
    expect(await mcp(g, json.access_token, "?servers=gamma")).toBe(424);
  });

  it("refuses a slug beyond the client's ceiling, by name, to the client", async () => {
    const w = await walk(g, {
      clientId: CLAUDE,
      scope: "slug:alpha slug:nope",
    });
    expect(w.refused?.status).toBe(302);
    const back = new URL(w.refused?.headers.get("location") ?? "");
    expect(back.origin + back.pathname).toBe(CALLBACK);
    expect(back.searchParams.get("error")).toBe("invalid_scope");
    expect(back.searchParams.get("error_description")).toContain("slug:nope");
    expect(back.searchParams.get("error_description")).not.toContain(
      "slug:alpha",
    );
  });

  it("narrows an `mcp` request to the boxes the human left ticked", async () => {
    const w = await walk(g, { clientId: CLAUDE, tick: ["beta"] });
    const { json } = await exchange(g, CLAUDE, w);
    expect(json.scope).toBe("slug:beta");
    expect(await mcp(g, json.access_token, "?servers=alpha")).toBe(424);
    expect(await mcp(g, json.access_token, "?servers=beta")).toBe(200);
  });

  it("cannot be widened by posting a slug the screen did not offer", async () => {
    const w = await walk(g, {
      clientId: CLAUDE,
      scope: "slug:alpha",
      tick: ["alpha", "gamma"],
    });
    const { json } = await exchange(g, CLAUDE, w);
    expect(json.scope).toBe("slug:alpha");
  });

  it("treats every box unticked as a denial", async () => {
    const w = await walk(g, { clientId: CLAUDE, tick: [] });
    expect(w.landed?.searchParams.get("error")).toBe("access_denied");
    expect(w.landed?.searchParams.get("code")).toBe(null);
  });

  it("lets a refresh ask for a subset of the grant, and never more", async () => {
    const w = await walk(g, {
      clientId: CLAUDE,
      scope: "slug:alpha slug:beta",
      tick: "all",
    });
    const first = (await exchange(g, CLAUDE, w)).json;
    const refresh = (scope?: string) =>
      token(g, {
        grant_type: "refresh_token",
        refresh_token: first.refresh_token,
        client_id: CLAUDE,
        ...(scope !== undefined ? { scope } : {}),
      });

    const subset = await refresh("slug:alpha");
    expect(subset.status).toBe(200);
    expect(subset.json.scope).toBe("slug:alpha");
    expect(subset.json.refresh_token).toBe(first.refresh_token);
    expect(principalOf(g, subset.json.access_token).slugs).toEqual(["alpha"]);

    // The refresh token kept the grant's scope: the next one can ask for all
    // of it again.
    const whole = await refresh();
    expect(whole.json.scope).toBe("slug:alpha slug:beta");
    // `mcp` on a narrowed grant means "the grant as given", not the ceiling.
    expect((await refresh("mcp")).json.scope).toBe("slug:alpha slug:beta");

    const wider = await refresh("slug:alpha slug:gamma");
    expect(wider.status).toBe(400);
    expect(wider.json.error).toBe("invalid_scope");
    expect(wider.json.error_description).toContain("slug:gamma");
  });

  it("lets a refresh of an `mcp` grant narrow to slugs inside the ceiling only", async () => {
    const w = await walk(g, { clientId: CLAUDE, tick: "all" });
    const first = (await exchange(g, CLAUDE, w)).json;
    const narrowed = await token(g, {
      grant_type: "refresh_token",
      refresh_token: first.refresh_token,
      client_id: CLAUDE,
      scope: "slug:gamma",
    });
    expect(narrowed.json.scope).toBe("slug:gamma");
    const unknown = await token(g, {
      grant_type: "refresh_token",
      refresh_token: first.refresh_token,
      client_id: CLAUDE,
      scope: "slug:nope",
    });
    expect(unknown.json.error).toBe("invalid_scope");
  });
});

describe("per-client configuration", () => {
  let g: Gateway;
  beforeAll(
    async () =>
      (g = await gateway(`    clients:
      - clientId: ${ZIMMER}
        name: Zimmer sessions
        roles: [limited]
        servers: [alpha]
        accessTokenTtlSeconds: 600
      - clientId: ${CLAUDE}
        roles: [limited]
    advertiseSlugScopes: true`)),
  );
  afterAll(async () => g.close());

  it("bounds a listed client by its own roles and allowlist", async () => {
    const w = await walk(g, { clientId: ZIMMER, tick: "all" });
    expect(w.consent).toContain("Zimmer sessions");
    expect(w.consent).toContain("listed by this gateway");
    // `limited` reaches alpha and beta; the allowlist leaves alpha.
    expect(w.consent).toContain('value="alpha"');
    expect(w.consent).not.toContain('value="beta"');
    const { json } = await exchange(g, ZIMMER, w);
    expect(json.expires_in).toBe(600);
    expect(json.scope).toBe("mcp");
    const p = principalOf(g, json.access_token);
    expect(p.roles).toEqual(["limited"]);
    expect(p.slugs).toEqual(["alpha"]);
    expect(await mcp(g, json.access_token, "?servers=alpha")).toBe(200);
    expect(await mcp(g, json.access_token, "?servers=beta")).toBe(424);
  });

  it("refuses a slug scope outside a listed client's ceiling", async () => {
    const w = await walk(g, { clientId: CLAUDE, scope: "slug:gamma" });
    expect(
      new URL(w.refused?.headers.get("location") ?? "").searchParams.get(
        "error",
      ),
    ).toBe("invalid_scope");
  });

  it("still applies the global defaults to an unlisted client", async () => {
    const w = await walk(g, { clientId: STRANGER, tick: "all" });
    const { json } = await exchange(g, STRANGER, w);
    expect(json.expires_in).toBe(3600);
    expect(principalOf(g, json.access_token).roles).toEqual(["admin"]);
  });

  it("advertises every slug some ceiling reaches, when asked to", async () => {
    const as = (await (
      await fetch(`${g.base}/.well-known/oauth-authorization-server`)
    ).json()) as Record<string, unknown>;
    expect(as.scopes_supported).toEqual([
      "mcp",
      "slug:alpha",
      "slug:beta",
      "slug:gamma",
    ]);
  });
});

describe("closing the door to unlisted clients", () => {
  let g: Gateway;
  beforeAll(
    async () =>
      (g = await gateway(`    allowUnlistedClients: false
    dynamicRegistration: false
    clients:
      - clientId: ${CLAUDE}`)),
  );
  afterAll(async () => g.close());

  it("refuses an unlisted client at /oauth/authorize, on a page", async () => {
    const w = await walk(g, { clientId: STRANGER });
    expect(w.refused?.status).toBe(403);
    expect(await w.refused?.text()).toContain("not allowed on this gateway");
  });

  it("admits the listed client", async () => {
    const w = await walk(g, { clientId: CLAUDE, tick: "all" });
    expect((await exchange(g, CLAUDE, w)).status).toBe(200);
  });

  it("refuses an unlisted client's tokens at /mcp and at /oauth/token", async () => {
    const identity = {
      sub: "google-sub-1",
      email: "tadas@tadasant.com",
      hd: "tadasant.com",
    };
    const access = mintAccessToken(g.oauth.keys.access, {
      cid: clientFingerprint(STRANGER),
      aud: `${g.base}/mcp`,
      identity,
      ttlMs: 60_000,
    });
    expect(verifyAccessToken(access, g.oauth, `${g.base}/mcp`)).toEqual({
      ok: false,
      reason: "oauth_client_not_allowed",
    });
    expect(await mcp(g, access, "?servers=alpha")).toBe(401);
    const refresh = mintRefreshToken(g.oauth.keys.refresh, {
      cid: clientFingerprint(STRANGER),
      resource: `${g.base}/mcp`,
      identity,
      googleRefreshToken: "whatever",
    });
    const { status, json } = await token(g, {
      grant_type: "refresh_token",
      refresh_token: refresh,
      client_id: STRANGER,
    });
    expect(status).toBe(401);
    expect(json.error).toBe("invalid_client");
  });

  it("turns registration off, in the route and in the metadata", async () => {
    const res = await register(g);
    expect(res.status).toBe(404);
    const as = (await (
      await fetch(`${g.base}/.well-known/oauth-authorization-server`)
    ).json()) as Record<string, unknown>;
    expect(as.registration_endpoint).toBe(undefined);
    expect(as.scopes_supported).toEqual(["mcp"]);
  });
});

describe("the pieces", () => {
  const cfg = parseConfig(yaml());

  it("intersects a principal's slugs last, so they can only remove", () => {
    const base = { kind: "mcp-oauth" as const, id: "x", label: "x" };
    expect(
      [...entitledServers({ ...base, roles: ["limited"] }, cfg)].sort(),
    ).toEqual(["alpha", "beta"]);
    expect([
      ...entitledServers(
        { ...base, roles: ["limited"], slugs: ["beta", "gamma"] },
        cfg,
      ),
    ]).toEqual(["beta"]);
    expect([
      ...entitledServers({ ...base, roles: ["admin"], slugs: [] }, cfg),
    ]).toEqual([]);
  });

  it("reads and writes the scope grammar", () => {
    expect(requestedSlugs(undefined)).toBe(null);
    expect(requestedSlugs("mcp")).toBe(null);
    expect(requestedSlugs("mcp slug: openid")).toBe(null);
    expect(requestedSlugs("slug:b slug:a slug:b")).toEqual(["b", "a"]);
    expect(scopeString(undefined)).toBe("mcp");
    expect(scopeString(["b", "a"])).toBe("slug:a slug:b");
  });

  it("resolves an unlisted client to the global roles only while the door is open", () => {
    const open = new ClientPolicies(cfg.auth.mcpOAuth);
    expect(open.forClient(STRANGER)?.roles).toEqual(["admin"]);
    const closed = new ClientPolicies({
      ...cfg.auth.mcpOAuth,
      allowUnlistedClients: false,
    });
    expect(closed.forClient(STRANGER)).toBe(null);
    expect(closed.forFingerprint(clientFingerprint(STRANGER))).toBe(null);
  });

  it("refuses a client entry it could never match, a duplicate, or an unknown role", () => {
    const bad = (clients: string) => () =>
      parseConfig(yaml(`    clients:\n${clients}`));
    expect(bad(`      - clientId: not-a-url`)).toThrow(/metadata/);
    expect(bad(`      - clientId: https://claude.ai/`)).toThrow(/metadata/);
    expect(
      bad(`      - clientId: ${CLAUDE}\n      - clientId: ${CLAUDE}`),
    ).toThrow(/twice/);
    expect(bad(`      - clientId: ${CLAUDE}\n        roles: [nobody]`)).toThrow(
      /unknown role "nobody"/,
    );
  });
});
