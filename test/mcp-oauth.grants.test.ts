import { createHash, randomBytes } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { tokenStoreFromConfig } from "../src/auth/index.ts";
import type { FetchedDocument } from "../src/auth/mcp-oauth/cimd.ts";
import { clientFingerprint } from "../src/auth/mcp-oauth/clients.ts";
import {
  GrantStore,
  GrantStoreUnavailable,
  UNREADABLE_LINK,
  type GrantRecord,
} from "../src/auth/mcp-oauth/grant-store.ts";
import {
  mintAccessToken,
  mintRecordAccessToken,
  mintRefreshToken,
  RECORD_VERSION,
  type CodePayload,
} from "../src/auth/mcp-oauth/grants.ts";
import {
  grantDeadline,
  resolveMcpOAuth,
  verifyAccessToken,
  type McpOAuth,
} from "../src/auth/mcp-oauth/index.ts";
import { mcpOAuthKeysFromEnv } from "../src/auth/mcp-oauth/keys.ts";
import { parseConfig } from "../src/config/load.ts";
import { Registry } from "../src/gateway/registry.ts";
import { createApp } from "../src/http/app.ts";
import { classifyRefresh } from "../src/http/oauth.ts";
import {
  EnvSecretProvider,
  sharedSecretProviders,
} from "../src/secrets/provider/index.ts";
import {
  MemoryBlobStore,
  PreconditionFailed,
  type BlobStore,
} from "../src/state/store.ts";
import { mountGrantsConsole, renderGrantsPage } from "../src/ui/grants.ts";
import {
  fakeGoogleGrant,
  type FakeGoogleGrant,
} from "./helpers/fake-google-grant.ts";

/**
 * Server-side grant records: rotation with replay detection, refresh-token
 * lifetime, per-token and per-grant revocation that touches nothing else, no
 * Google credential in any token, durability across a restart, failing closed
 * when the store is gone — and, first, that none of it happens unless the
 * config asks for it.
 */

const KEY = "an-oauth-signing-key-of-sufficient-length";
const CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const CLAUDE = "https://claude.ai/oauth/mcp-oauth-client-metadata";
const ZIMMER = "https://zimmer.example.com/oauth/client.json";

function yaml(mcpOAuthExtra = ""): string {
  return `
version: 1
gateway: { name: strad, env: test, publicUrl: "https://strad.test" }
auth:
  staticTokens: { enabled: true }
  mcpOAuth:
    enabled: true
    hostedDomain: tadasant.com
    roles: [admin]
${mcpOAuthExtra}
roles:
  admin: { servers: ["*"] }
servers:
  - slug: alpha
    kind: builtin
    module: "./servers/echo.js"
    entitlements: [admin]
`;
}

const GRANTS = (extra = "") => `
    clients:
      - clientId: ${ZIMMER}
        name: Zimmer
        refreshTokenTtlSeconds: 21600
    grants:
      enabled: true
      store: memory
${extra}`;

const documents = new Map<string, FetchedDocument>();
for (const [id, name] of [
  [CLAUDE, "Claude"],
  [ZIMMER, "Zimmer"],
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
  google: FakeGoogleGrant;
  revokedAtGoogle: string[];
  /**
   * A SECOND authorization server over the app's durable layer, as another
   * process would hold: its own cache, the same records.
   */
  oauth: McpOAuth;
  close: () => Promise<void>;
}

const open: Gateway[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((g) => g.close()));
});

async function gateway(
  extra: string,
  opts: { blobs?: () => Promise<BlobStore>; google?: FakeGoogleGrant } = {},
): Promise<Gateway> {
  const config = parseConfig(yaml(extra));
  const env = {
    NODE_ENV: "test",
    STRAD_OAUTH_KEY: KEY,
    STRAD_TOKENS: "[]",
  } as NodeJS.ProcessEnv;
  const google = opts.google ?? fakeGoogleGrant("tadasant.com");
  const revokedAtGoogle: string[] = [];
  const revoke = google.revoke.bind(google);
  google.revoke = async (t: string) => {
    revokedAtGoogle.push(t);
    return revoke(t);
  };
  const registry = await Registry.build({
    config,
    secrets: sharedSecretProviders(new EnvSecretProvider({})),
    mode: "core",
    env,
  });
  // One blob store for the app; the test reads the app's own grant store
  // through the server it exposes below.
  const blobs = opts.blobs ?? memoryBlobs();
  const app = createApp({
    config,
    registry,
    tokenStore: tokenStoreFromConfig(config, env),
    mode: "core",
    env,
    mcpOAuthGoogle: google,
    mcpOAuthClientMetadataFetch: fetchDocument,
    mcpOAuthGrantBlobs: blobs,
  });
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // A second view over the SAME durable layer, as another process would have.
  const oauth = resolveMcpOAuth({
    config,
    env,
    google,
    grantBlobs: blobs,
    log: () => {},
  });
  if (!oauth) throw new Error("no oauth");
  const g: Gateway = {
    base,
    google,
    revokedAtGoogle,
    oauth,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
  open.push(g);
  return g;
}

function memoryBlobs(): () => Promise<BlobStore> {
  const store = new MemoryBlobStore();
  return () => Promise.resolve(store);
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

/** Authorize, Google, consent, approve: the code (or the refusal). */
async function authorize(
  g: Gateway,
  clientId: string,
): Promise<{ code: string; verifier: string; approved: Response }> {
  const { verifier, challenge } = pkce();
  const url = new URL(`${g.base}/oauth/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", CALLBACK);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", "s");
  const started = await fetch(url, { redirect: "manual" });
  const cookie = (started.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const callback = new URL(`${g.base}/oauth/callback/google`);
  callback.searchParams.set("code", "google-code");
  callback.searchParams.set("state", g.google.lastState);
  const consent = await (
    await fetch(callback, { headers: { cookie }, redirect: "manual" })
  ).text();
  const approval = /name="approval" value="([^"]+)"/.exec(consent)?.[1] ?? "";
  const approved = await fetch(`${g.base}/oauth/approve`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ approval, decision: "allow" }),
    redirect: "manual",
  });
  const landed = approved.headers.get("location");
  const code = landed ? (new URL(landed).searchParams.get("code") ?? "") : "";
  return { code, verifier, approved };
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

async function connect(g: Gateway, clientId = ZIMMER) {
  const a = await authorize(g, clientId);
  const t = await token(g, {
    grant_type: "authorization_code",
    code: a.code,
    client_id: clientId,
    code_verifier: a.verifier,
  });
  expect(t.status).toBe(200);
  return { ...a, ...t.json };
}

async function refresh(g: Gateway, refreshToken: string, clientId = ZIMMER) {
  return token(g, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
  });
}

async function revoke(g: Gateway, tok: string): Promise<number> {
  const res = await fetch(`${g.base}/oauth/revoke`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: tok }),
  });
  return res.status;
}

async function mcp(g: Gateway, bearer: string): Promise<number> {
  const res = await fetch(`${g.base}/mcp?servers=alpha`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  await res.text();
  return res.status;
}

function gidOf(g: Gateway, refreshToken: string): string {
  const keys = mcpOAuthKeysFromEnv({ STRAD_OAUTH_KEY: KEY });
  const payload = keys?.refresh.open<{ v: 4; gid: string }>(
    refreshToken.slice("strad_ort_".length),
  );
  if (!payload) throw new Error("not a refresh token");
  void g;
  return payload.gid;
}

function versionOf(tok: string, kind: "access" | "refresh" | "code"): number {
  const keys = mcpOAuthKeysFromEnv({ STRAD_OAUTH_KEY: KEY });
  if (!keys) throw new Error("no keys");
  // Both prefixes, `strad_oat_` and `strad_ort_`, are ten characters.
  const body = kind === "code" ? tok : tok.slice(10);
  const payload = keys[kind].open<{ v: 1 | 2 | 3 | 4 }>(body);
  return payload?.v ?? 0;
}

// ---------------------------------------------------------------------------

describe("off by default: the stateless server, unchanged", () => {
  it("defaults grants off, and issues the v1 shapes it always did", async () => {
    const settings = parseConfig(yaml()).auth.mcpOAuth;
    expect(settings.grants).toEqual({
      enabled: false,
      store: "gcs",
      refreshReuseGraceSeconds: 30,
      legacyTokens: "accept",
    });
    const g = await gateway("");
    expect(g.oauth.grants).toBe(null);
    const t = await connect(g, CLAUDE);
    expect(versionOf(t.access_token, "access")).toBe(1);
    expect(versionOf(t.refresh_token, "refresh")).toBe(1);
    // The same refresh token back: no rotation without a record.
    const r = await refresh(g, t.refresh_token, CLAUDE);
    expect(r.json.refresh_token).toBe(t.refresh_token);
    // Revocation still goes to Google.
    expect(await revoke(g, t.refresh_token)).toBe(200);
    expect(g.revokedAtGoogle).toHaveLength(1);
  });

  it("the grants page says records are off", async () => {
    const g = await gateway("");
    const html = renderGrantsPage({
      oauth: g.oauth,
      records: [],
      readError: null,
    });
    expect(html).toContain("Grant records are off");
  });
});

describe("a record-backed grant", () => {
  it("carries no Google credential in its code or tokens", async () => {
    const g = await gateway(GRANTS());
    const a = await authorize(g, ZIMMER);
    expect(versionOf(a.code, "code")).toBe(RECORD_VERSION);
    const keys = mcpOAuthKeysFromEnv({ STRAD_OAUTH_KEY: KEY });
    const code = keys?.code.open<CodePayload>(a.code);
    expect(code).not.toHaveProperty("googleRefreshToken");
    expect(code).not.toHaveProperty("identity");
    const t = await token(g, {
      grant_type: "authorization_code",
      code: a.code,
      client_id: ZIMMER,
      code_verifier: a.verifier,
    });
    expect(t.status).toBe(200);
    const refreshPayload = keys?.refresh.open<{ v: 4; gen: number }>(
      t.json.refresh_token.slice(10),
    );
    expect(refreshPayload).toMatchObject({ v: 4, gen: 1 });
    expect(JSON.stringify(refreshPayload)).not.toContain("google-rt-");
    expect(versionOf(t.json.access_token, "access")).toBe(RECORD_VERSION);
    expect(await mcp(g, t.json.access_token)).toBe(200);
    // The Google refresh token is in the record, server-side.
    const record = await g.oauth.grants?.store.get(
      gidOf(g, t.json.refresh_token),
    );
    expect(record?.googleRefreshToken).toBe(g.google.lastRefreshToken);
    expect(record?.state).toBe("active");
  });

  it("rotates the refresh token on every use", async () => {
    const g = await gateway(GRANTS());
    const t = await connect(g);
    const r1 = await refresh(g, t.refresh_token);
    expect(r1.status).toBe(200);
    expect(r1.json.refresh_token).not.toBe(t.refresh_token);
    const r2 = await refresh(g, r1.json.refresh_token);
    expect(r2.status).toBe(200);
    expect(await mcp(g, r2.json.access_token)).toBe(200);
    const record = await g.oauth.grants?.store.get(gidOf(g, t.refresh_token), {
      fresh: true,
    });
    expect(record?.generation).toBe(3);
  });

  it("honours the previous token inside the grace window, without advancing", async () => {
    const g = await gateway(GRANTS());
    const t = await connect(g);
    const r1 = await refresh(g, t.refresh_token);
    // The response to r1 was "lost": the client presents the old token again.
    const again = await refresh(g, t.refresh_token);
    expect(again.status).toBe(200);
    // It gets the current generation, which still works.
    const next = await refresh(g, again.json.refresh_token);
    expect(next.status).toBe(200);
    // And the one r1 handed out is now one behind, inside the grace.
    expect((await refresh(g, r1.json.refresh_token)).status).toBe(200);
  });

  it("revokes the whole grant when a spent token is replayed outside the grace", async () => {
    const g = await gateway(GRANTS("      refreshReuseGraceSeconds: 0"));
    const t = await connect(g);
    const r1 = await refresh(g, t.refresh_token);
    expect(r1.status).toBe(200);
    await new Promise((r) => setTimeout(r, 5));
    const replay = await refresh(g, t.refresh_token);
    expect(replay.status).toBe(400);
    expect(replay.json.error).toBe("invalid_grant");
    // The legitimate holder's current token and access token are dead too.
    expect((await refresh(g, r1.json.refresh_token)).status).toBe(400);
    expect(await mcp(g, r1.json.access_token)).toBe(401);
    const record = await g.oauth.grants?.store.get(gidOf(g, t.refresh_token), {
      fresh: true,
    });
    expect(record?.state).toBe("revoked");
    expect(record?.revokedReason).toBe("refresh_replay");
    expect(record).not.toHaveProperty("googleRefreshToken");
  });

  it("revokes a grant whose code is redeemed twice", async () => {
    const g = await gateway(GRANTS());
    const a = await authorize(g, ZIMMER);
    const body = {
      grant_type: "authorization_code",
      code: a.code,
      client_id: ZIMMER,
      code_verifier: a.verifier,
    };
    const first = await token(g, body);
    expect(first.status).toBe(200);
    const second = await token(g, body);
    expect(second.status).toBe(400);
    expect(await mcp(g, first.json.access_token)).toBe(401);
  });

  it("never lets an access token outlive the grant, and refuses an expired grant", async () => {
    const g = await gateway(GRANTS());
    const t = await connect(g);
    // Zimmer's entry: six-hour refresh lifetime, one-hour access tokens.
    expect(t.expires_in).toBe(3600);
    const store = g.oauth.grants?.store;
    const gid = gidOf(g, t.refresh_token);
    const record = await store?.get(gid, { fresh: true });
    expect(record?.expiresAt).toBe((record?.createdAt ?? 0) + 21_600_000);
    // Move the grant to 5h59m30s old: the next access token is clipped.
    await store?.update(gid, (r) => ({
      write: r
        ? {
            ...r,
            createdAt: Date.now() - 21_570_000,
            expiresAt: Date.now() + 30_000,
          }
        : null,
      result: null,
    }));
    const clipped = await refresh(g, t.refresh_token);
    expect(clipped.status).toBe(200);
    expect(clipped.json.expires_in).toBeLessThanOrEqual(30);
    // And past the deadline, refused.
    await store?.update(gid, (r) => ({
      write: r ? { ...r, expiresAt: Date.now() - 1 } : null,
      result: null,
    }));
    const expired = await refresh(g, clipped.json.refresh_token);
    expect(expired.status).toBe(400);
    expect(expired.json.error_description).toContain("expired");
  });

  it("a lowered refresh TTL in config shortens a grant already issued", () => {
    const record = {
      createdAt: 1_000,
      expiresAt: null,
    } as unknown as GrantRecord;
    expect(grantDeadline(record, null)).toBe(null);
    expect(
      grantDeadline(record, {
        listed: true,
        roles: [],
        accessTokenTtlMs: 1,
        refreshTokenTtlMs: 500,
      }),
    ).toBe(1_500);
    expect(
      grantDeadline(
        { ...record, expiresAt: 1_200 },
        {
          listed: true,
          roles: [],
          accessTokenTtlMs: 1,
          refreshTokenTtlMs: 500,
        },
      ),
    ).toBe(1_200);
  });
});

describe("revocation", () => {
  it("revokes ONE access token, leaving its grant and siblings working", async () => {
    const g = await gateway(GRANTS());
    const t = await connect(g);
    const r1 = await refresh(g, t.refresh_token);
    expect(await revoke(g, t.access_token)).toBe(200);
    expect(await mcp(g, t.access_token)).toBe(401);
    // A sibling access token, and the grant's refresh, still work.
    expect(await mcp(g, r1.json.access_token)).toBe(200);
    expect((await refresh(g, r1.json.refresh_token)).status).toBe(200);
    expect(g.revokedAtGoogle).toEqual([]);
  });

  it("revokes one grant by its refresh token without touching another grant for the same account", async () => {
    const g = await gateway(GRANTS());
    const one = await connect(g);
    const two = await connect(g, CLAUDE);
    expect(await revoke(g, one.refresh_token)).toBe(200);
    expect(await mcp(g, one.access_token)).toBe(401);
    expect((await refresh(g, one.refresh_token)).json.error).toBe(
      "invalid_grant",
    );
    // The other connector: untouched, and Google was never called.
    expect(await mcp(g, two.access_token)).toBe(200);
    expect((await refresh(g, two.refresh_token, CLAUDE)).status).toBe(200);
    expect(g.revokedAtGoogle).toEqual([]);
    expect(g.google.live()).toHaveLength(2);
  });

  it("answers 200 for a token it never issued", async () => {
    const g = await gateway(GRANTS());
    expect(await revoke(g, "strad_oat_nonsense")).toBe(200);
    expect(await revoke(g, "")).toBe(200);
  });

  it("revoking a parent grant revokes the child minted under it", async () => {
    const g = await gateway(GRANTS());
    const parent = await connect(g);
    const store = g.oauth.grants?.store;
    if (!store) throw new Error("no store");
    const parentGid = gidOf(g, parent.refresh_token);
    const parentRecord = await store.get(parentGid);
    if (!parentRecord) throw new Error("no parent");
    // The token-exchange seam: a child record with no Google credential.
    const child: GrantRecord = {
      v: 1,
      gid: GrantStore.newGid(),
      cid: parentRecord.cid,
      identity: parentRecord.identity,
      resource: parentRecord.resource,
      slugs: ["alpha"],
      parentGid,
      state: "active",
      generation: 1,
      rotatedAt: Date.now(),
      createdAt: Date.now(),
      expiresAt: null,
    };
    await store.create(child);
    const childAccess = mintRecordAccessToken(g.oauth.keys.access, {
      gid: child.gid,
      cid: child.cid,
      aud: parentRecord.resource,
      identity: child.identity,
      ttlMs: 60_000,
      slugs: ["alpha"],
    }).token;
    expect(await mcp(g, childAccess)).toBe(200);
    expect(await revoke(g, parent.refresh_token)).toBe(200);
    expect(await mcp(g, childAccess)).toBe(401);
  });
});

describe("durability", () => {
  it("a restart over the same store honours live grants and still refuses revoked ones", async () => {
    const blobs = memoryBlobs();
    const google = fakeGoogleGrant("tadasant.com");
    const before = await gateway(GRANTS(), { blobs, google });
    const kept = await connect(before);
    const dead = await connect(before);
    expect(await revoke(before, dead.refresh_token)).toBe(200);
    await before.close();
    open.splice(open.indexOf(before), 1);

    const after = await gateway(GRANTS(), { blobs, google });
    expect(await mcp(after, kept.access_token)).toBe(200);
    expect((await refresh(after, kept.refresh_token)).status).toBe(200);
    expect(await mcp(after, dead.access_token)).toBe(401);
    expect((await refresh(after, dead.refresh_token)).status).toBe(400);
  });

  it("a restart that lost the store refuses every record-backed token (fails closed)", async () => {
    const google = fakeGoogleGrant("tadasant.com");
    const before = await gateway(GRANTS(), { google });
    const t = await connect(before);
    const after = await gateway(GRANTS(), { google });
    expect(await mcp(after, t.access_token)).toBe(401);
    expect((await refresh(after, t.refresh_token)).json.error).toBe(
      "invalid_grant",
    );
  });

  it("a revocation in one process reaches another within the staleness bound", async () => {
    const g = await gateway(GRANTS());
    const t = await connect(g);
    const other = g.oauth.grants?.store;
    if (!other) throw new Error("no store");
    const gid = gidOf(g, t.refresh_token);
    // The other process revokes; this one re-reads on a refresh at once.
    await other.revoke(gid, "console");
    expect((await refresh(g, t.refresh_token)).json.error).toBe(
      "invalid_grant",
    );
  });

  it("with the store down: 503 at approve and revoke, never a 401 at /mcp", async () => {
    let up = true;
    const memory = new MemoryBlobStore();
    const flaky: BlobStore = {
      read: (n) => (up ? memory.read(n) : Promise.reject(new Error("down"))),
      write: (n, d, gen) =>
        up ? memory.write(n, d, gen) : Promise.reject(new Error("down")),
      delete: (n) =>
        up ? memory.delete(n) : Promise.reject(new Error("down")),
      list: (p) => (up ? memory.list(p) : Promise.reject(new Error("down"))),
    };
    const blobs = () => Promise.resolve(flaky);
    const google = fakeGoogleGrant("tadasant.com");
    const g = await gateway(GRANTS(), { blobs, google });
    const t = await connect(g);
    up = false;
    // A fresh process with nothing cached cannot vouch for the token: 500,
    // not 401, so the client does not discard it and re-authenticate.
    const cold = await gateway(GRANTS(), { blobs, google });
    expect(await mcp(cold, t.access_token)).toBe(500);
    // This process has it cached and keeps serving it.
    expect(await mcp(g, t.access_token)).toBe(200);
    expect((await refresh(g, t.refresh_token)).status).toBe(503);
    expect(await revoke(g, t.refresh_token)).toBe(503);
    // …but the revocation it could not persist is already in force here.
    expect(await mcp(g, t.access_token)).toBe(401);
    const a = await authorize(g, ZIMMER);
    expect(a.approved.status).toBe(503);
    up = true;
  });

  it("a GCS store with no credentials is unavailable rather than open", async () => {
    const config = parseConfig(
      yaml(`    grants:
      enabled: true
      store: gcs`),
    );
    const oauth = resolveMcpOAuth({
      config,
      env: { STRAD_OAUTH_KEY: KEY } as NodeJS.ProcessEnv,
      google: fakeGoogleGrant(),
      log: () => {},
    });
    const store = oauth?.grants?.store;
    expect(store?.kind).toBe("gcs");
    await expect(store?.get("x".repeat(22))).rejects.toBeInstanceOf(
      GrantStoreUnavailable,
    );
    expect(await store?.probe()).toContain("STRAD_STATE_GCS_BUCKET");
  });
});

describe("stateless (legacy) tokens, with records on", () => {
  async function legacyGrant(g: Gateway) {
    // Mint the way the build before records did: through a stateless flow on
    // a records-off gateway sharing this key and Google.
    const off = await gateway("", { google: g.google });
    const t = await connect(off, CLAUDE);
    return t;
  }

  it("accept: keeps working as before, and revocation no longer reaches Google", async () => {
    const g = await gateway(GRANTS());
    const t = await legacyGrant(g);
    const other = await legacyGrant(g);
    const r = await refresh(g, t.refresh_token, CLAUDE);
    expect(r.status).toBe(200);
    expect(r.json.refresh_token).toBe(t.refresh_token);
    expect(await mcp(g, t.access_token)).toBe(200);

    expect(await revoke(g, t.refresh_token)).toBe(200);
    expect(g.revokedAtGoogle).toEqual([]);
    expect((await refresh(g, t.refresh_token, CLAUDE)).json.error).toBe(
      "invalid_grant",
    );
    // The other connector for the same account is untouched.
    expect((await refresh(g, other.refresh_token, CLAUDE)).status).toBe(200);
  });

  it("upgrade: the next refresh converts it into a rotating record", async () => {
    const g = await gateway(
      GRANTS(`      legacyTokens: upgrade
      refreshReuseGraceSeconds: 0`),
    );
    const t = await legacyGrant(g);
    const up = await refresh(g, t.refresh_token, CLAUDE);
    expect(up.status).toBe(200);
    expect(versionOf(up.json.refresh_token, "refresh")).toBe(RECORD_VERSION);
    expect(versionOf(up.json.access_token, "access")).toBe(RECORD_VERSION);
    expect(await mcp(g, up.json.access_token)).toBe(200);
    const next = await refresh(g, up.json.refresh_token, CLAUDE);
    expect(next.status).toBe(200);
    // The stateless token is now spent: presenting it again is a replay.
    await new Promise((r) => setTimeout(r, 5));
    expect((await refresh(g, t.refresh_token, CLAUDE)).status).toBe(400);
    expect((await refresh(g, next.json.refresh_token, CLAUDE)).status).toBe(
      400,
    );
  });

  it("upgrade: a lost response is covered by the grace window", async () => {
    const g = await gateway(GRANTS(`      legacyTokens: upgrade`));
    const t = await legacyGrant(g);
    expect((await refresh(g, t.refresh_token, CLAUDE)).status).toBe(200);
    const again = await refresh(g, t.refresh_token, CLAUDE);
    expect(again.status).toBe(200);
    expect(versionOf(again.json.refresh_token, "refresh")).toBe(RECORD_VERSION);
  });

  it("refuse: refused at /oauth/token and at /mcp", async () => {
    const g = await gateway(GRANTS(`      legacyTokens: refuse`));
    const t = await legacyGrant(g);
    expect((await refresh(g, t.refresh_token, CLAUDE)).json.error).toBe(
      "invalid_grant",
    );
    expect(await mcp(g, t.access_token)).toBe(401);
  });

  it("a token minted by the stateless build verifies unchanged under accept", async () => {
    const g = await gateway(GRANTS());
    const access = mintAccessToken(g.oauth.keys.access, {
      cid: clientFingerprint(CLAUDE),
      aud: "https://strad.test/mcp",
      identity: { sub: "s", email: "t@tadasant.com", hd: "tadasant.com" },
      ttlMs: 60_000,
    });
    const verdict = await verifyAccessToken(
      access,
      g.oauth,
      "https://strad.test/mcp",
    );
    expect(verdict.ok).toBe(true);
    const refreshToken = mintRefreshToken(g.oauth.keys.refresh, {
      cid: clientFingerprint(CLAUDE),
      resource: "https://strad.test/mcp",
      identity: { sub: "s", email: "t@tadasant.com", hd: "tadasant.com" },
      googleRefreshToken: "google-rt-unknown",
    });
    expect(versionOf(refreshToken, "refresh")).toBe(1);
  });
});

describe("turning records off again", () => {
  it("refuses record-backed tokens rather than reading them without the record", async () => {
    const blobs = memoryBlobs();
    const google = fakeGoogleGrant("tadasant.com");
    const on = await gateway(GRANTS(), { blobs, google });
    const t = await connect(on);
    const off = await gateway("", { google });
    expect(await mcp(off, t.access_token)).toBe(401);
    expect((await refresh(off, t.refresh_token)).json.error).toBe(
      "invalid_grant",
    );
  });
});

describe("classifyRefresh", () => {
  const r = { generation: 4, rotatedAt: 1_000 };
  it("rotates the current generation", () => {
    expect(classifyRefresh(r, 4, 30_000, 99_999)).toBe("rotate");
  });
  it("reissues the previous one inside the grace only", () => {
    expect(classifyRefresh(r, 3, 30_000, 31_000)).toBe("reissue");
    expect(classifyRefresh(r, 3, 30_000, 31_001)).toBe("replay");
    expect(classifyRefresh(r, 3, 0, 1_000)).toBe("replay");
  });
  it("treats anything older, or newer, as a replay", () => {
    expect(classifyRefresh(r, 2, 30_000, 1_001)).toBe("replay");
    expect(classifyRefresh(r, 5, 30_000, 1_001)).toBe("replay");
  });
});

describe("the console grants view", () => {
  it("lists grants and revokes one", async () => {
    const g = await gateway(GRANTS());
    const t = await connect(g);
    const app = express();
    app.use((_req, res, next) => {
      res.locals.principal = {
        kind: "console",
        id: "tadas",
        label: "tadas@tadasant.com",
        roles: ["admin"],
      };
      next();
    });
    // The console over the app's own authorization server's store view.
    mountGrantsConsole(app, (_req, _res, next) => next(), { oauth: g.oauth });
    const server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const page = await (await fetch(`${base}/tokens/grants`)).text();
      expect(page).toContain("Zimmer");
      expect(page).toContain("tadas@tadasant.com");
      expect(page).toContain(">live<");
      const gid = gidOf(g, t.refresh_token);
      expect(page).toContain(`value="${gid}"`);

      const revoked = await fetch(`${base}/tokens/grants/revoke`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ gid }),
      });
      expect(revoked.status).toBe(200);
      expect(await revoked.text()).toContain("Revoked grant");
      // The app's process re-reads within its staleness bound; a refresh
      // re-reads at once.
      expect((await refresh(g, t.refresh_token)).json.error).toBe(
        "invalid_grant",
      );
      const bad = await fetch(`${base}/tokens/grants/revoke`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ gid: "<script>" }),
      });
      expect(bad.status).toBe(400);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("escapes what it renders", () => {
    const html = renderGrantsPage({
      oauth: {
        policies: { forFingerprint: () => null },
        grants: {
          store: { kind: "memory", lastUsed: () => undefined },
          legacy: "accept",
          graceMs: 0,
        },
      } as unknown as McpOAuth,
      records: [
        {
          v: 1,
          gid: "g".repeat(22),
          cid: "c",
          clientName: "<img src=x onerror=alert(1)>",
          identity: { sub: "s", email: "a@b", hd: "b" },
          resource: "r",
          state: "active",
          generation: 1,
          createdAt: Date.now(),
          expiresAt: null,
        },
      ],
      readError: null,
    });
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
  });
});

describe("review fixes: lost writes, replayed writes, races", () => {
  /** A blob store whose writes can be made to fail, or to land and then 412. */
  function controllable() {
    const memory = new MemoryBlobStore();
    const ctl = {
      failWrites: false,
      /** The next write lands, then the caller is told 412 (a replayed write). */
      landThen412: false,
      blobs: (() =>
        Promise.resolve<BlobStore>({
          read: (n) => memory.read(n),
          list: (p) => memory.list(p),
          delete: (n) => memory.delete(n),
          write: async (n, d, gen) => {
            if (ctl.failWrites) throw new Error("write failed");
            if (ctl.landThen412) {
              ctl.landThen412 = false;
              await memory.write(n, d, gen);
              throw new PreconditionFailed(n);
            }
            return memory.write(n, d, gen);
          },
        })) as () => Promise<BlobStore>,
    };
    return ctl;
  }

  it("a revocation whose write failed is not undone by a later write", async () => {
    const ctl = controllable();
    const g = await gateway(GRANTS(), { blobs: ctl.blobs });
    const t = await connect(g);
    ctl.failWrites = true;
    expect(await revoke(g, t.refresh_token)).toBe(503);
    expect(await mcp(g, t.access_token)).toBe(401);
    ctl.failWrites = false;
    // Any later write on the grant — here, revoking one access token —
    // carries the revocation with it instead of resetting it.
    expect(await revoke(g, t.access_token)).toBe(200);
    expect(await mcp(g, t.access_token)).toBe(401);
    expect((await refresh(g, t.refresh_token)).json.error).toBe(
      "invalid_grant",
    );
    // And it is now durable: another process sees it.
    const durable = await g.oauth.grants?.store.get(gidOf(g, t.refresh_token), {
      fresh: true,
    });
    expect(durable?.state).toBe("revoked");
  });

  it("a code exchange whose write landed and was replayed is not a code replay", async () => {
    const ctl = controllable();
    const g = await gateway(GRANTS(), { blobs: ctl.blobs });
    const a = await authorize(g, ZIMMER);
    ctl.landThen412 = true;
    const t = await token(g, {
      grant_type: "authorization_code",
      code: a.code,
      client_id: ZIMMER,
      code_verifier: a.verifier,
    });
    expect(t.status).toBe(200);
    expect(await mcp(g, t.json.access_token)).toBe(200);
  });

  it("a rotation whose write landed and was replayed is not a refresh replay, even with no grace", async () => {
    const ctl = controllable();
    const g = await gateway(GRANTS("      refreshReuseGraceSeconds: 0"), {
      blobs: ctl.blobs,
    });
    const t = await connect(g);
    ctl.landThen412 = true;
    const r = await refresh(g, t.refresh_token);
    expect(r.status).toBe(200);
    expect(await mcp(g, r.json.access_token)).toBe(200);
    expect((await refresh(g, r.json.refresh_token)).status).toBe(200);
  });

  it("two concurrent refreshes of one token rotate once", async () => {
    const g = await gateway(GRANTS());
    const t = await connect(g);
    const [a, b] = await Promise.all([
      refresh(g, t.refresh_token),
      refresh(g, t.refresh_token),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const record = await g.oauth.grants?.store.get(gidOf(g, t.refresh_token), {
      fresh: true,
    });
    expect(record?.generation).toBe(2);
    expect(record?.state).toBe("active");
  });

  it("two concurrent refreshes with no grace: one rotates, the other is a replay", async () => {
    const g = await gateway(GRANTS("      refreshReuseGraceSeconds: 0"));
    const t = await connect(g);
    await new Promise((r) => setTimeout(r, 5));
    const results = await Promise.all([
      refresh(g, t.refresh_token),
      refresh(g, t.refresh_token),
    ]);
    const statuses = results.map((r) => r.status).sort();
    // Either the loser lands after the winner's rotation (a replay, which
    // revokes) or both were judged against the same generation and the
    // precondition decided — never two rotations.
    expect(statuses).toContain(400);
    const record = await g.oauth.grants?.store.get(gidOf(g, t.refresh_token), {
      fresh: true,
    });
    expect(record?.state).toBe("revoked");
  });

  it("accept mode: a stateless refresh with the store down is a 503, not an allow", async () => {
    const ctl = controllable();
    let down = false;
    const blobs = async (): Promise<BlobStore> => {
      const inner = await ctl.blobs();
      return {
        ...inner,
        read: (n) => (down ? Promise.reject(new Error("down")) : inner.read(n)),
      };
    };
    const g = await gateway(GRANTS(), { blobs });
    const off = await gateway("", { google: g.google });
    const legacy = await connect(off, CLAUDE);
    down = true;
    expect((await refresh(g, legacy.refresh_token, CLAUDE)).status).toBe(503);
    down = false;
    expect((await refresh(g, legacy.refresh_token, CLAUDE)).status).toBe(200);
  });

  it("another process's revocation lands after the staleness bound, not before", async () => {
    let clock = 1_000_000;
    const memory = new MemoryBlobStore();
    const key = randomBytes(32);
    const make = () =>
      new GrantStore({
        kind: "memory",
        blobs: () => Promise.resolve(memory),
        key,
        prefix: "mcp-oauth/test",
        now: () => clock,
      });
    const a = make();
    const b = make();
    const record: GrantRecord = {
      v: 1,
      gid: GrantStore.newGid(),
      cid: "c",
      identity: { sub: "s", email: "e@x", hd: "x" },
      resource: "r",
      state: "active",
      generation: 1,
      createdAt: clock,
      expiresAt: null,
    };
    await a.create(record);
    expect((await b.get(record.gid))?.state).toBe("active");
    await a.revoke(record.gid, "console");
    clock += 5_000;
    expect((await b.get(record.gid))?.state).toBe("active");
    clock += 15_000;
    expect((await b.get(record.gid))?.state).toBe("revoked");
  });

  it("a legacy link that does not open is read as revoked", async () => {
    const memory = new MemoryBlobStore();
    const store = new GrantStore({
      kind: "memory",
      blobs: () => Promise.resolve(memory),
      key: randomBytes(32),
      prefix: "mcp-oauth/test",
    });
    await store.linkLegacy("jti-1", GrantStore.newGid());
    const other = new GrantStore({
      kind: "memory",
      blobs: () => Promise.resolve(memory),
      key: randomBytes(32),
      prefix: "mcp-oauth/test",
    });
    const linked = await other.legacyGrant("jti-1");
    expect(linked).toBe(UNREADABLE_LINK);
    expect(await other.get(linked ?? "")).toBe(null);
  });
});
