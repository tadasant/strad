import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign as cryptoSign,
  type KeyObject,
} from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tokenStoreFromConfig } from "../src/auth/index.ts";
import type { FetchedDocument } from "../src/auth/mcp-oauth/cimd.ts";
import { CLIENT_ASSERTION_TYPE } from "../src/auth/mcp-oauth/client-auth.ts";
import { clientFingerprint } from "../src/auth/mcp-oauth/clients.ts";
import {
  GrantStore,
  type GrantRecord,
} from "../src/auth/mcp-oauth/grant-store.ts";
import { mintRecordAccessToken } from "../src/auth/mcp-oauth/grants.ts";
import {
  resolveMcpOAuth,
  verifyAccessToken,
  type McpOAuth,
} from "../src/auth/mcp-oauth/index.ts";
import {
  ACCESS_TOKEN_TYPE,
  TOKEN_EXCHANGE_GRANT,
} from "../src/auth/mcp-oauth/metadata.ts";
import { parseConfig } from "../src/config/load.ts";
import { Registry } from "../src/gateway/registry.ts";
import { createApp } from "../src/http/app.ts";
import { validExchangeLabel } from "../src/http/oauth.ts";
import {
  EnvSecretProvider,
  sharedSecretProviders,
} from "../src/secrets/provider/index.ts";
import { MemoryBlobStore, type BlobStore } from "../src/state/store.ts";
import { EXPORTABLE } from "../src/telemetry/events.ts";
import { renderGrantsPage } from "../src/ui/grants.ts";
import { fakeGoogleGrant } from "./helpers/fake-google-grant.ts";

/**
 * RFC 8693 token exchange on strad's authorization server: a confidential
 * client trades its own live access token for a narrower, shorter-lived
 * CHILD, recorded under its grant.
 *
 * The rules, each with a test below:
 *
 *   - off unless a client entry carries `tokenExchange` (and records are on);
 *     off is byte-identical, metadata and token endpoint alike;
 *   - confidential clients only, and only one whose entry allows it;
 *   - the subject must be a live record-backed access token of the SAME
 *     client, and not itself a child;
 *   - scope is a named `slug:` subset of what the subject reaches;
 *     `resource` / `audience` must be the grant's;
 *   - the answer is RFC 8693's shape with no refresh token, and a lifetime
 *     from the client's child TTL, capped, and never past the grant;
 *   - revoking a child ends only it; revoking or expiring the parent ends
 *     every child;
 *   - a cap on live children per grant, expired ones dropped;
 *   - the label is stored, shown, exported — and no token reaches a log.
 */

const KEY = "an-oauth-signing-key-of-sufficient-length";
const ZIMMER = "https://zimmer.example.com/oauth-client/metadata.json";
const ZIMMER_JWKS = "https://zimmer.example.com/oauth-client/jwks.json";
const ZIMMER_CB = "https://zimmer.example.com/oauth/strad/callback";
const OTHER = "https://other.example.com/oauth/client.json";
const OTHER_JWKS = "https://other.example.com/oauth/jwks.json";
const OTHER_CB = "https://other.example.com/cb";

interface TestKey {
  kid: string;
  privateKey: KeyObject;
  jwk: Record<string, unknown>;
}

function makeKey(kid: string): TestKey {
  const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    kid,
    privateKey: pair.privateKey,
    jwk: {
      ...(pair.publicKey.export({ format: "jwk" }) as Record<string, unknown>),
      kid,
      use: "sig",
      alg: "ES256",
    },
  };
}

const b64 = (v: unknown) =>
  Buffer.from(JSON.stringify(v)).toString("base64url");

function assertionFor(key: TestKey, clientId: string, aud: string): string {
  const now = Math.floor(Date.now() / 1000);
  const h = b64({ alg: "ES256", kid: key.kid, typ: "JWT" });
  const c = b64({
    iss: clientId,
    sub: clientId,
    aud,
    iat: now,
    exp: now + 60,
    jti: randomUUID(),
  });
  const sig = cryptoSign("sha256", Buffer.from(`${h}.${c}`), {
    key: key.privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return `${h}.${c}.${sig.toString("base64url")}`;
}

const zimmerKey = makeKey("zimmer-kms-1");
const otherKey = makeKey("other-1");

function json(body: unknown): FetchedDocument {
  return {
    status: 200,
    headers: { "content-type": "application/json" },
    body: Buffer.from(JSON.stringify(body)),
  };
}

const DOCUMENTS = new Map<string, FetchedDocument>([
  [
    ZIMMER,
    json({
      client_id: ZIMMER,
      client_name: "Zimmer",
      redirect_uris: [ZIMMER_CB],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "private_key_jwt",
      jwks_uri: ZIMMER_JWKS,
    }),
  ],
  [ZIMMER_JWKS, json({ keys: [zimmerKey.jwk] })],
  [
    OTHER,
    json({
      client_id: OTHER,
      client_name: "Other",
      redirect_uris: [OTHER_CB],
      token_endpoint_auth_method: "private_key_jwt",
      jwks_uri: OTHER_JWKS,
    }),
  ],
  [OTHER_JWKS, json({ keys: [otherKey.jwk] })],
]);

const EXCHANGE_ON = (
  opts: { cap?: number; refreshTtl?: number; ttl?: string } = {},
) => `    clients:
      - clientId: ${ZIMMER}
        name: Zimmer
        tokenEndpointAuthMethod: private_key_jwt
        jwksUri: ${ZIMMER_JWKS}
        refreshTokenTtlSeconds: ${opts.refreshTtl ?? 2592000}
        tokenExchange:
${opts.ttl ?? "          childTokenTtlSeconds: 21600"}
          maxLiveChildren: ${opts.cap ?? 3}
      - clientId: ${OTHER}
        tokenEndpointAuthMethod: private_key_jwt
        jwksUri: ${OTHER_JWKS}
    grants:
      enabled: true
      store: memory`;

function yaml(extra: string, publicUrl: string): string {
  return `
version: 1
gateway: { name: strad, env: test, publicUrl: "${publicUrl}" }
auth:
  staticTokens: { enabled: true }
  mcpOAuth:
    enabled: true
    hostedDomain: tadasant.com
    roles: [admin]
${extra}
roles:
  admin: { servers: ["*"] }
servers:
  - slug: alpha
    kind: builtin
    module: "./servers/echo.js"
    entitlements: [admin]
  - slug: beta
    kind: builtin
    module: "./servers/echo.js"
    entitlements: [admin]
`;
}

interface Gateway {
  base: string;
  /** A second view over the app's durable layer, as another process holds. */
  oauth: McpOAuth;
  blobs: () => Promise<BlobStore>;
  publicUrl: string;
  close: () => Promise<void>;
}

const open: Gateway[] = [];
let logged: string[] = [];
beforeEach(() => {
  logged = [];
  for (const stream of ["log", "error", "warn", "info"] as const) {
    vi.spyOn(console, stream).mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });
  }
});
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(open.splice(0).map((g) => g.close()));
});

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", () => r()));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((r) => probe.close(() => r()));
  return port;
}

async function gateway(extra: string): Promise<Gateway> {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const config = parseConfig(yaml(extra, base));
  const env = {
    NODE_ENV: "test",
    STRAD_OAUTH_KEY: KEY,
    STRAD_TOKENS: "[]",
  } as NodeJS.ProcessEnv;
  const google = fakeGoogleGrant("tadasant.com");
  const memory = new MemoryBlobStore();
  const blobs = () => Promise.resolve(memory as BlobStore);
  const fetchDocument = async (url: URL) => {
    const doc = DOCUMENTS.get(url.href);
    if (!doc) throw new Error(`no document for ${url.href}`);
    return doc;
  };
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
    mcpOAuthGrantBlobs: blobs,
  });
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(port, "127.0.0.1", () => resolve(s));
  });
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
    oauth,
    blobs,
    publicUrl: base,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
  // The Google leg is faked; `walk` reads its state through this.
  (g as Gateway & { google: typeof google }).google = google;
  open.push(g);
  return g;
}

interface Body {
  access_token?: string;
  refresh_token?: string;
  issued_token_type?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

async function post(
  g: Gateway,
  path: string,
  body: Record<string, string>,
): Promise<{ status: number; json: Body }> {
  const res = await fetch(`${g.base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  const text = await res.text();
  return { status: res.status, json: (text ? JSON.parse(text) : {}) as Body };
}

const assertion = (g: Gateway, key = zimmerKey, clientId = ZIMMER) => ({
  client_id: clientId,
  client_assertion_type: CLIENT_ASSERTION_TYPE,
  client_assertion: assertionFor(key, clientId, `${g.base}/oauth/token`),
});

/** Authorize → Google → consent → approve → code → tokens. */
async function connect(
  g: Gateway,
  clientId = ZIMMER,
  redirect = ZIMMER_CB,
  key = zimmerKey,
): Promise<Body> {
  const google = (g as Gateway & { google: { lastState: string } }).google;
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256")
    .update(verifier, "ascii")
    .digest("base64url");
  const url = new URL(`${g.base}/oauth/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirect);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  const started = await fetch(url, { redirect: "manual" });
  const cookie = (started.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const callback = new URL(`${g.base}/oauth/callback/google`);
  callback.searchParams.set("code", "google-code");
  callback.searchParams.set("state", google.lastState);
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
  const code =
    new URL(approved.headers.get("location") ?? "").searchParams.get("code") ??
    "";
  const issued = await post(g, "/oauth/token", {
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    ...assertion(g, key, clientId),
  });
  if (issued.status !== 200) {
    throw new Error(`code exchange failed: ${JSON.stringify(issued.json)}`);
  }
  return issued.json;
}

function exchange(
  g: Gateway,
  subject: string,
  extra: Record<string, string> = {},
) {
  return post(g, "/oauth/token", {
    grant_type: TOKEN_EXCHANGE_GRANT,
    subject_token: subject,
    subject_token_type: ACCESS_TOKEN_TYPE,
    scope: "slug:alpha",
    ...assertion(g),
    ...extra,
  });
}

async function mcp(g: Gateway, bearer: string, slug = "alpha") {
  const res = await fetch(`${g.base}/mcp?servers=${slug}`, {
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

function gidOf(g: Gateway, access: string): string {
  const p = g.oauth.keys.access.open<{ v: 4; gid: string }>(
    access.slice("strad_oat_".length),
  );
  if (!p) throw new Error("not an access token");
  return p.gid;
}

async function metadata(g: Gateway): Promise<Record<string, unknown>> {
  return (await (
    await fetch(`${g.base}/.well-known/oauth-authorization-server`)
  ).json()) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------

describe("off unless configured", () => {
  it.each([
    ["grant records off", ""],
    [
      "grant records on, no client allowed to exchange",
      `    grants:
      enabled: true
      store: memory`,
    ],
  ])(
    "%s: no metadata entry, and the grant type is unsupported",
    async (_n, extra) => {
      const g = await gateway(extra);
      expect((await metadata(g)).grant_types_supported).toEqual([
        "authorization_code",
        "refresh_token",
      ]);
      const res = await post(g, "/oauth/token", {
        grant_type: TOKEN_EXCHANGE_GRANT,
        subject_token: "x",
        subject_token_type: ACCESS_TOKEN_TYPE,
      });
      expect(res).toEqual({
        status: 400,
        json: {
          error: "unsupported_grant_type",
          error_description:
            "this server supports authorization_code and refresh_token.",
        },
      });
    },
  );

  it("advertises the grant type when a client may use it", async () => {
    const g = await gateway(EXCHANGE_ON());
    expect((await metadata(g)).grant_types_supported).toEqual([
      "authorization_code",
      "refresh_token",
      TOKEN_EXCHANGE_GRANT,
    ]);
  });
});

describe("the config", () => {
  const base = (block: string, grants = true) =>
    yaml(
      `    clients:
      - clientId: ${ZIMMER}
${block}
${grants ? "    grants: { enabled: true, store: memory }" : ""}`,
      "https://strad.test",
    );

  it("refuses tokenExchange for a public client", () => {
    expect(() => parseConfig(base("        tokenExchange: {}"))).toThrow(
      /tokenExchange is for a confidential client only/,
    );
  });

  it("refuses tokenExchange without grant records", () => {
    expect(() =>
      parseConfig(
        base(
          "        tokenEndpointAuthMethod: private_key_jwt\n        tokenExchange: {}",
          false,
        ),
      ),
    ).toThrow(/needs auth.mcpOAuth.grants.enabled/);
  });

  it("refuses a maximum below the default", () => {
    expect(() =>
      parseConfig(
        base(`        tokenEndpointAuthMethod: private_key_jwt
        tokenExchange:
          childTokenTtlSeconds: 21600
          maxChildTokenTtlSeconds: 3600`),
      ),
    ).toThrow(/maxChildTokenTtlSeconds is below childTokenTtlSeconds/);
  });

  it("defaults to one hour and 500 live children", () => {
    const cfg = parseConfig(
      base(
        "        tokenEndpointAuthMethod: private_key_jwt\n        tokenExchange: {}",
      ),
    );
    expect(cfg.auth.mcpOAuth.clients[0]?.tokenExchange).toEqual({
      childTokenTtlSeconds: 3600,
      maxLiveChildren: 500,
    });
  });
});

describe("an exchange", () => {
  it("issues a child in RFC 8693's shape, with no refresh token, that /mcp accepts for its slugs only", async () => {
    const g = await gateway(EXCHANGE_ON());
    const parent = await connect(g);
    const res = await exchange(g, parent.access_token ?? "", {
      label: "29970",
    });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      access_token: expect.stringMatching(/^strad_oat_/),
      issued_token_type: ACCESS_TOKEN_TYPE,
      token_type: "Bearer",
      expires_in: 21600,
      scope: "slug:alpha",
    });
    expect(res.json.refresh_token).toBeUndefined();
    const child = res.json.access_token ?? "";
    expect(await mcp(g, child, "alpha")).toBe(200);
    expect(await mcp(g, child, "beta")).not.toBe(200);
    // The parent is untouched and still reaches both.
    expect(await mcp(g, parent.access_token ?? "", "beta")).toBe(200);

    const record = (await g.oauth.grants?.store.get(
      gidOf(g, child),
    )) as GrantRecord;
    expect(record).toMatchObject({
      parentGid: gidOf(g, parent.access_token ?? ""),
      exchange: { label: "29970" },
      slugs: ["alpha"],
      auth: "private_key_jwt",
      state: "active",
    });
    expect(record.googleRefreshToken).toBeUndefined();
  });

  it("demands the client's assertion, and an entry that allows exchange", async () => {
    const g = await gateway(EXCHANGE_ON());
    const parent = await connect(g);
    const bare = await post(g, "/oauth/token", {
      grant_type: TOKEN_EXCHANGE_GRANT,
      client_id: ZIMMER,
      subject_token: parent.access_token ?? "",
      subject_token_type: ACCESS_TOKEN_TYPE,
      scope: "slug:alpha",
    });
    expect(bare.status).toBe(401);
    expect(bare.json.error).toBe("invalid_client");

    // A confidential client whose entry has no `tokenExchange`.
    const other = await connect(g, OTHER, OTHER_CB, otherKey);
    const refused = await exchange(g, other.access_token ?? "", {
      ...assertion(g, otherKey, OTHER),
    });
    expect(refused.status).toBe(400);
    expect(refused.json.error).toBe("unauthorized_client");

    // Zimmer presenting the other client's token.
    const stolen = await exchange(g, other.access_token ?? "");
    expect(stolen.status).toBe(400);
    expect(stolen.json).toMatchObject({
      error: "invalid_request",
      error_description: "subject_token was issued to another client.",
    });
  });

  it("refuses a subject that is not a live access token, and a child as subject", async () => {
    const g = await gateway(EXCHANGE_ON());
    const parent = await connect(g);
    for (const subject of ["garbage", parent.refresh_token ?? ""]) {
      const res = await exchange(g, subject);
      expect(res.status).toBe(400);
      expect(res.json.error).toBe("invalid_request");
    }
    const child = (await exchange(g, parent.access_token ?? "")).json
      .access_token;
    const again = await exchange(g, child ?? "");
    expect(again.status).toBe(400);
    expect(again.json.error_description).toBe(
      "a token minted by token exchange cannot itself be exchanged.",
    );
    // A revoked subject token.
    await post(g, "/oauth/revoke", {
      token: parent.access_token ?? "",
      ...assertion(g),
    });
    const dead = await exchange(g, parent.access_token ?? "");
    expect(dead.status).toBe(400);
    expect(dead.json.error).toBe("invalid_request");
  });

  it("refuses the wrong token types and an actor token", async () => {
    const g = await gateway(EXCHANGE_ON());
    const parent = await connect(g);
    const subject = parent.access_token ?? "";
    const shapes: Record<string, string>[] = [
      { subject_token_type: "urn:ietf:params:oauth:token-type:refresh_token" },
      { requested_token_type: "urn:ietf:params:oauth:token-type:id_token" },
      { actor_token: subject, actor_token_type: ACCESS_TOKEN_TYPE },
    ];
    for (const extra of shapes) {
      const res = await exchange(g, subject, extra);
      expect(res.status).toBe(400);
      expect(res.json.error).toBe("invalid_request");
    }
    // Naming the one supported type explicitly is fine.
    expect(
      (await exchange(g, subject, { requested_token_type: ACCESS_TOKEN_TYPE }))
        .status,
    ).toBe(200);
  });

  it("issues only a named subset of what the subject token reaches", async () => {
    const g = await gateway(EXCHANGE_ON());
    const parent = await connect(g);
    const subject = parent.access_token ?? "";
    const none = await exchange(g, subject, { scope: "mcp" });
    expect(none.status).toBe(400);
    expect(none.json.error).toBe("invalid_scope");
    const beyond = await exchange(g, subject, {
      scope: "slug:alpha slug:gamma",
    });
    expect(beyond.status).toBe(400);
    expect(beyond.json).toMatchObject({
      error: "invalid_scope",
      error_description: "the subject token does not include: slug:gamma.",
    });
    const both = await exchange(g, subject, { scope: "slug:beta slug:alpha" });
    expect(both.json.scope).toBe("slug:alpha slug:beta");

    // A subject narrowed at refresh to alpha cannot mint a beta child.
    const narrowed = await post(g, "/oauth/token", {
      grant_type: "refresh_token",
      refresh_token: parent.refresh_token ?? "",
      scope: "slug:alpha",
      ...assertion(g),
    });
    expect(narrowed.status).toBe(200);
    const widened = await exchange(g, narrowed.json.access_token ?? "", {
      scope: "slug:beta",
    });
    expect(widened.status).toBe(400);
    expect(widened.json.error).toBe("invalid_scope");
  });

  it("keeps resource and audience to the grant's", async () => {
    const g = await gateway(EXCHANGE_ON());
    const parent = await connect(g);
    const subject = parent.access_token ?? "";
    for (const field of ["resource", "audience"]) {
      const wrong = await exchange(g, subject, {
        [field]: "https://elsewhere.example.com/mcp",
      });
      expect(wrong.status).toBe(400);
      expect(wrong.json.error).toBe("invalid_target");
      const right = await exchange(g, subject, { [field]: `${g.base}/mcp` });
      expect(right.status).toBe(200);
    }
  });

  it("takes the child lifetime from the client: default, capped request, never past the grant", async () => {
    const g = await gateway(
      EXCHANGE_ON({
        ttl: "          childTokenTtlSeconds: 3600\n          maxChildTokenTtlSeconds: 21600",
        cap: 10,
      }),
    );
    const subject = (await connect(g)).access_token ?? "";
    expect((await exchange(g, subject)).json.expires_in).toBe(3600);
    expect(
      (await exchange(g, subject, { expires_in: "600" })).json.expires_in,
    ).toBe(600);
    expect(
      (await exchange(g, subject, { expires_in: "999999" })).json.expires_in,
    ).toBe(21600);
    for (const bad of ["0", "-5", "1.5", "six"]) {
      expect((await exchange(g, subject, { expires_in: bad })).status).toBe(
        400,
      );
    }

    // A grant with an hour left clips a six-hour child to that hour.
    const short = await gateway(EXCHANGE_ON({ refreshTtl: 3600 }));
    const s2 = (await connect(short)).access_token ?? "";
    const clipped = (await exchange(short, s2)).json.expires_in ?? 0;
    expect(clipped).toBeLessThanOrEqual(3600);
    expect(clipped).toBeGreaterThan(3500);
  });

  it("refuses a malformed label, and accepts a session id", async () => {
    expect(validExchangeLabel("29970")).toBe(true);
    expect(validExchangeLabel("session:29970.turn-3")).toBe(true);
    for (const bad of [
      "",
      "strad_oat_abc",
      "a b",
      "<b>",
      "x".repeat(65),
      "-leading",
    ]) {
      expect(validExchangeLabel(bad)).toBe(false);
    }
    const g = await gateway(EXCHANGE_ON());
    const subject = (await connect(g)).access_token ?? "";
    const res = await exchange(g, subject, { label: "strad_oat_leak" });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe("invalid_request");
  });
});

describe("revocation", () => {
  it("revoking a child ends only that child, and needs the client", async () => {
    const g = await gateway(EXCHANGE_ON());
    const parent = await connect(g);
    const subject = parent.access_token ?? "";
    const a =
      (await exchange(g, subject, { label: "1" })).json.access_token ?? "";
    const b =
      (await exchange(g, subject, { label: "2" })).json.access_token ?? "";

    expect(
      (await post(g, "/oauth/revoke", { token: a, client_id: ZIMMER })).status,
    ).toBe(401);
    expect(
      (await post(g, "/oauth/revoke", { token: a, ...assertion(g) })).status,
    ).toBe(200);
    expect(await mcp(g, a)).toBe(401);
    expect(await mcp(g, b)).toBe(200);
    expect(await mcp(g, subject)).toBe(200);
    // Another process sees it by the next stale re-read; this one at once.
    expect(
      (await g.oauth.grants?.store.get(gidOf(g, a), { fresh: true }))?.state,
    ).toBe("revoked");
    // The slot is given back.
    const parentRecord = await g.oauth.grants?.store.get(gidOf(g, subject), {
      fresh: true,
    });
    expect(Object.keys(parentRecord?.children ?? {})).toEqual([gidOf(g, b)]);
  });

  it("revoking the parent grant ends every child", async () => {
    const g = await gateway(EXCHANGE_ON());
    const parent = await connect(g);
    const subject = parent.access_token ?? "";
    const a = (await exchange(g, subject)).json.access_token ?? "";
    const b = (await exchange(g, subject)).json.access_token ?? "";
    expect(
      (
        await post(g, "/oauth/revoke", {
          token: parent.refresh_token ?? "",
          ...assertion(g),
        })
      ).status,
    ).toBe(200);
    expect(await mcp(g, a)).toBe(401);
    expect(await mcp(g, b)).toBe(401);
  });

  it("an expired parent ends its children, including one shortened by config", async () => {
    const g = await gateway(EXCHANGE_ON());
    const parent = await connect(g);
    const child =
      (await exchange(g, parent.access_token ?? "")).json.access_token ?? "";
    const resource = `${g.base}/mcp`;
    expect((await verifyAccessToken(child, g.oauth, resource)).ok).toBe(true);

    // Records written directly, so the CHILD is well inside its own
    // deadline and only the PARENT's can decide: a parent created at T0, a
    // child at T0 + 9 min with six hours to run, judged at T0 + 11 min by a
    // build whose config lowered the client's refresh lifetime to 10 min.
    const t0 = Date.now() - 11 * 60 * 1000;
    const store = g.oauth.grants?.store;
    if (!store) throw new Error("no store");
    const cid = clientFingerprint(ZIMMER);
    const identity = {
      sub: "1",
      email: "tadas@tadasant.com",
      hd: "tadasant.com",
    };
    const old: GrantRecord = {
      v: 1,
      gid: GrantStore.newGid(),
      cid,
      identity,
      resource,
      auth: "private_key_jwt",
      state: "active",
      generation: 1,
      createdAt: t0,
      expiresAt: null,
    };
    const kid: GrantRecord = {
      ...old,
      gid: GrantStore.newGid(),
      parentGid: old.gid,
      generation: 0,
      createdAt: t0 + 9 * 60 * 1000,
      expiresAt: t0 + 6 * 60 * 60 * 1000,
      slugs: ["alpha"],
      exchange: {},
    };
    await store.create(old);
    await store.create(kid);
    const { token } = mintRecordAccessToken(
      g.oauth.keys.access,
      {
        gid: kid.gid,
        cid,
        aud: resource,
        identity,
        ttlMs: 6 * 60 * 60 * 1000,
        slugs: ["alpha"],
        auth: "private_key_jwt",
      },
      kid.createdAt,
    );
    expect((await verifyAccessToken(token, g.oauth, resource)).ok).toBe(true);
    const lowered = parseConfig(
      yaml(EXCHANGE_ON({ refreshTtl: 600 }), g.publicUrl),
    );
    const view = resolveMcpOAuth({
      config: lowered,
      env: { STRAD_OAUTH_KEY: KEY } as NodeJS.ProcessEnv,
      google: fakeGoogleGrant("tadasant.com"),
      grantBlobs: g.blobs,
      log: () => {},
    });
    if (!view) throw new Error("no oauth");
    expect(await verifyAccessToken(token, view, resource)).toEqual({
      ok: false,
      reason: "oauth_grant_expired",
    });
  });
});

describe("turning exchange off", () => {
  it("ends every live child, and leaves the parent working", async () => {
    const g = await gateway(EXCHANGE_ON());
    const parent = await connect(g);
    const child =
      (await exchange(g, parent.access_token ?? "")).json.access_token ?? "";
    const resource = `${g.base}/mcp`;
    // The same records, read by a build whose config dropped `tokenExchange`
    // from Zimmer's entry.
    const off = parseConfig(
      yaml(
        `    clients:
      - clientId: ${ZIMMER}
        tokenEndpointAuthMethod: private_key_jwt
        jwksUri: ${ZIMMER_JWKS}
    grants:
      enabled: true
      store: memory`,
        g.publicUrl,
      ),
    );
    const view = resolveMcpOAuth({
      config: off,
      env: { STRAD_OAUTH_KEY: KEY } as NodeJS.ProcessEnv,
      google: fakeGoogleGrant("tadasant.com"),
      grantBlobs: g.blobs,
      log: () => {},
    });
    if (!view) throw new Error("no oauth");
    expect(await verifyAccessToken(child, view, resource)).toEqual({
      ok: false,
      reason: "oauth_exchange_disabled",
    });
    expect(
      (await verifyAccessToken(parent.access_token ?? "", view, resource)).ok,
    ).toBe(true);
  });
});

describe("the cap on live children", () => {
  it("refuses at the cap without evicting, and a revoke frees a slot", async () => {
    const g = await gateway(EXCHANGE_ON({ cap: 2 }));
    const subject = (await connect(g)).access_token ?? "";
    const a = (await exchange(g, subject)).json.access_token ?? "";
    const b = (await exchange(g, subject)).json.access_token ?? "";
    const full = await exchange(g, subject);
    expect(full.status).toBe(400);
    expect(full.json).toMatchObject({
      error: "invalid_request",
      error_description:
        "this grant already holds 2 live child tokens; revoke one, or wait for one to expire.",
    });
    expect(await mcp(g, a)).toBe(200);
    expect(await mcp(g, b)).toBe(200);
    await post(g, "/oauth/revoke", { token: a, ...assertion(g) });
    expect((await exchange(g, subject)).status).toBe(200);
  });

  it("holds under a burst of concurrent exchanges", async () => {
    const g = await gateway(EXCHANGE_ON({ cap: 3 }));
    const subject = (await connect(g)).access_token ?? "";
    const results = await Promise.all(
      Array.from({ length: 6 }, () => exchange(g, subject)),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(3);
    expect(results.filter((r) => r.status === 400)).toHaveLength(3);
  });

  it("drops expired children from the count, and sweeps their records", async () => {
    let clock = 1_800_000_000_000;
    const store = new GrantStore({
      kind: "memory",
      blobs: (() => {
        const m = new MemoryBlobStore();
        return () => Promise.resolve(m);
      })(),
      key: randomBytes(32),
      prefix: "mcp-oauth/test",
      now: () => clock,
    });
    const parent: GrantRecord = {
      v: 1,
      gid: GrantStore.newGid(),
      cid: clientFingerprint(ZIMMER),
      identity: { sub: "1", email: "t@tadasant.com", hd: "tadasant.com" },
      resource: "https://strad.test/mcp",
      state: "active",
      generation: 1,
      createdAt: clock,
      expiresAt: null,
    };
    await store.create(parent);
    const mintChild = async (ttl: number) => {
      const gid = GrantStore.newGid();
      const slot = await store.reserveChild(parent.gid, gid, clock + ttl, 2);
      if (slot === "ok") {
        await store.create({
          ...parent,
          gid,
          parentGid: parent.gid,
          generation: 0,
          createdAt: clock,
          expiresAt: clock + ttl,
          exchange: {},
        });
      }
      return slot;
    };
    expect(await mintChild(60_000)).toBe("ok");
    expect(await mintChild(60_000)).toBe("ok");
    expect(await mintChild(60_000)).toBe("full");
    clock += 61_000;
    expect(await mintChild(60_000)).toBe("ok");
    const after = await store.get(parent.gid, { fresh: true });
    expect(Object.keys(after?.children ?? {})).toHaveLength(1);
    // A dead child's record is kept a day for the console, then swept.
    expect((await store.list()).filter((r) => r.exchange)).toHaveLength(3);
    clock += 25 * 60 * 60 * 1000;
    expect((await store.list()).filter((r) => r.exchange)).toHaveLength(0);
    expect((await store.list()).map((r) => r.gid)).toEqual([parent.gid]);
    // A revoked parent takes no reservation.
    await store.revoke(parent.gid, "revoked");
    expect(await mintChild(60_000)).toBe("dead");
  });
});

describe("labels and logs", () => {
  it("shows the label on the console, ships it in telemetry, and never logs a token", async () => {
    const g = await gateway(EXCHANGE_ON());
    const parent = await connect(g);
    const child =
      (await exchange(g, parent.access_token ?? "", { label: "29970" })).json
        .access_token ?? "";
    await post(g, "/oauth/revoke", { token: child, ...assertion(g) });

    const events = logged
      .filter((l) => l.startsWith("{"))
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(events).toContainEqual({
      evt: "mcp_oauth.exchange",
      outcome: "issued",
      reason: "exchange",
      client: expect.stringMatching(/^cimd-[0-9a-f]{12}$/),
      label: "29970",
      slug_count: 1,
      ttl_seconds: 21600,
    });
    expect(events).toContainEqual({
      evt: "mcp_oauth.revoked",
      token: "child",
      outcome: "ok",
      label: "29970",
    });
    // The allowlist names the label deliberately, on these two events only.
    expect(EXPORTABLE["mcp_oauth.exchange"]).toContain("label");
    expect(EXPORTABLE["mcp_oauth.revoked"]).toContain("label");
    expect(
      Object.entries(EXPORTABLE)
        .filter(([, fields]) => fields.includes("label"))
        .map(([evt]) => evt)
        .sort(),
    ).toEqual(["mcp_oauth.exchange", "mcp_oauth.revoked"]);

    // No token — subject, child, refresh — in anything written to a log.
    for (const line of logged) {
      expect(line).not.toMatch(/strad_o[ar]t_/);
      expect(line).not.toContain(child.slice(10, 40));
    }

    const records = (await g.oauth.grants?.store.list()) ?? [];
    const html = renderGrantsPage({
      oauth: g.oauth,
      records,
      readError: null,
    });
    expect(html).toContain("child token <code>29970</code>");
  });

  it("logs refusals after client authentication with a closed-set reason", async () => {
    const g = await gateway(EXCHANGE_ON());
    const subject = (await connect(g)).access_token ?? "";
    await exchange(g, subject, { scope: "slug:gamma" });
    const events = logged
      .filter((l) => l.startsWith("{"))
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(events).toContainEqual(
      expect.objectContaining({
        evt: "mcp_oauth.exchange",
        outcome: "refused",
        reason: "scope_beyond",
      }),
    );
  });
});
