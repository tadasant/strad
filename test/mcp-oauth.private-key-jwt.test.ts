import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign as cryptoSign,
  constants as cryptoConstants,
  type KeyObject,
} from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { tokenStoreFromConfig } from "../src/auth/index.ts";
import {
  parseClientMetadata,
  type FetchedDocument,
} from "../src/auth/mcp-oauth/cimd.ts";
import {
  ASSERTION_ALGORITHMS,
  CLIENT_ASSERTION_TYPE,
  AssertionReplayCache,
  ClientAssertionVerifier,
  parseJwks,
  type AssertionAlgorithm,
} from "../src/auth/mcp-oauth/client-auth.ts";
import { readRefreshToken } from "../src/auth/mcp-oauth/grants.ts";
import { resolveMcpOAuth, type McpOAuth } from "../src/auth/mcp-oauth/index.ts";
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
 * `private_key_jwt` client authentication (RFC 7523) on strad's authorization
 * server.
 *
 * The properties, in the order they matter:
 *
 *   - **Off by default, and off is byte-identical.** No config key set: the
 *     metadata says `["none"]` with no algorithm list, and a document that
 *     declares `private_key_jwt` is refused at `/oauth/authorize` as before.
 *   - **A confidential client cannot be spent as a public one.** Its code, its
 *     refresh token and its revocation each demand a valid assertion, and
 *     neither a document tampered to say `none` (with a config requirement)
 *     nor a document that changes its mind after the grant downgrades it.
 *   - **A valid assertion is narrow.** Right `iss`/`sub`, an `aud` naming this
 *     server, a short `exp`, an unspent `jti`, an asymmetric `alg`, a key the
 *     client published — and a rotated key lands with one refetch.
 *   - **Public clients are untouched** while it is on.
 */

// ---------------------------------------------------------------------------
// Keys and assertions
// ---------------------------------------------------------------------------

interface TestKey {
  alg: AssertionAlgorithm;
  kid: string;
  privateKey: KeyObject;
  jwk: Record<string, unknown>;
}

function makeKey(alg: AssertionAlgorithm, kid: string = randomUUID()): TestKey {
  let pair: { publicKey: KeyObject; privateKey: KeyObject };
  if (alg.startsWith("RS") || alg.startsWith("PS")) {
    pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  } else if (alg === "EdDSA") {
    pair = generateKeyPairSync("ed25519");
  } else {
    const curve = { ES256: "P-256", ES384: "P-384", ES512: "P-521" }[
      alg as "ES256" | "ES384" | "ES512"
    ];
    pair = generateKeyPairSync("ec", { namedCurve: curve });
  }
  const jwk = {
    ...(pair.publicKey.export({ format: "jwk" }) as Record<string, unknown>),
    kid,
    use: "sig",
    alg,
  };
  return { alg, kid, privateKey: pair.privateKey, jwk };
}

function b64(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function signJwt(
  key: TestKey,
  claims: Record<string, unknown>,
  header: Record<string, unknown> = {},
): string {
  const h = b64({ alg: key.alg, kid: key.kid, typ: "JWT", ...header });
  const c = b64(claims);
  const data = Buffer.from(`${h}.${c}`);
  const alg = key.alg;
  let sig: Buffer;
  if (alg === "EdDSA") sig = cryptoSign(null, data, key.privateKey);
  else if (alg.startsWith("RS"))
    sig = cryptoSign(`sha${alg.slice(2)}`, data, key.privateKey);
  else if (alg.startsWith("PS"))
    sig = cryptoSign(`sha${alg.slice(2)}`, data, {
      key: key.privateKey,
      padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
      saltLength: Number(alg.slice(2)) / 8,
    });
  else
    sig = cryptoSign(`sha${alg.slice(2)}`, data, {
      key: key.privateKey,
      dsaEncoding: "ieee-p1363",
    });
  return `${h}.${c}.${sig.toString("base64url")}`;
}

function claimsFor(
  clientId: string,
  aud: string | string[],
  nowMs = Date.now(),
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const now = Math.floor(nowMs / 1000);
  return {
    iss: clientId,
    sub: clientId,
    aud,
    iat: now,
    exp: now + 60,
    jti: randomUUID(),
    ...extra,
  };
}

function json(
  body: unknown,
  headers: Record<string, string> = {},
): FetchedDocument {
  return {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
    body: Buffer.from(JSON.stringify(body)),
  };
}

// ---------------------------------------------------------------------------
// The verifier, on its own
// ---------------------------------------------------------------------------

const CID = "https://zimmer.example.com/oauth/client.json";
const JWKS_URI = "https://zimmer.example.com/oauth/jwks.json";
const ISSUER = "https://strad.example.com";
const AUDS = [ISSUER, `${ISSUER}/oauth/token`];

describe("the assertion verifier", () => {
  let clock: number;
  let served: Record<string, unknown>[];
  let fetches: number;
  let verifier: ClientAssertionVerifier;
  const key = makeKey("ES256", "k1");

  beforeEach(() => {
    clock = 1_800_000_000_000;
    served = [key.jwk];
    fetches = 0;
    verifier = new ClientAssertionVerifier({
      now: () => clock,
      fetch: async (url) => {
        fetches += 1;
        if (url.href !== JWKS_URI) throw new Error(`unexpected ${url.href}`);
        return json({ keys: served });
      },
    });
  });

  const verify = (assertion: string, requiredAlg?: string) =>
    verifier.verify({
      clientId: CID,
      assertion,
      audiences: AUDS,
      keys: { kind: "uri", uri: JWKS_URI },
      ...(requiredAlg ? { requiredAlg } : {}),
    });

  it.each(ASSERTION_ALGORITHMS)("accepts a valid %s assertion", async (alg) => {
    const k = makeKey(alg, `kid-${alg}`);
    served = [k.jwk];
    const out = await verify(signJwt(k, claimsFor(CID, ISSUER, clock)));
    expect(out).toEqual({
      ok: true,
      client: { clientId: CID, method: "private_key_jwt", keyId: `kid-${alg}` },
    });
  });

  it("accepts the token endpoint URL, and an array, as aud", async () => {
    expect(
      (
        await verify(
          signJwt(key, claimsFor(CID, `${ISSUER}/oauth/token`, clock)),
        )
      ).ok,
    ).toBe(true);
    expect(
      (
        await verify(
          signJwt(
            key,
            claimsFor(CID, ["https://other.example", ISSUER], clock),
          ),
        )
      ).ok,
    ).toBe(true);
  });

  it("refuses a wrong audience", async () => {
    const out = await verify(
      signJwt(key, claimsFor(CID, "https://other.example.com", clock)),
    );
    expect(out).toMatchObject({
      ok: false,
      reason: "client_assertion_invalid",
    });
    expect(fetches).toBe(0); // refused before any key fetch
  });

  it("refuses an expired assertion, and one that lives too long", async () => {
    const s = Math.floor(clock / 1000);
    expect(
      await verify(
        signJwt(key, claimsFor(CID, ISSUER, clock, { exp: s - 31 })),
      ),
    ).toMatchObject({ ok: false, description: "client_assertion has expired" });
    expect(
      await verify(
        signJwt(key, claimsFor(CID, ISSUER, clock, { exp: s + 3600 })),
      ),
    ).toMatchObject({ ok: false, reason: "client_assertion_invalid" });
    expect(
      await verify(
        signJwt(key, claimsFor(CID, ISSUER, clock, { exp: undefined })),
      ),
    ).toMatchObject({ ok: false, reason: "client_assertion_invalid" });
    expect(
      await verify(
        signJwt(key, claimsFor(CID, ISSUER, clock, { iat: s + 600 })),
      ),
    ).toMatchObject({ ok: false, reason: "client_assertion_invalid" });
  });

  it("refuses iss or sub other than the client id", async () => {
    for (const extra of [
      { iss: "https://evil.example.com/c.json" },
      { sub: "someone-else" },
    ]) {
      expect(
        await verify(signJwt(key, claimsFor(CID, ISSUER, clock, extra))),
      ).toMatchObject({ ok: false, reason: "client_assertion_invalid" });
    }
  });

  it("refuses a replayed jti, and accepts it again only after it expires", async () => {
    const claims = claimsFor(CID, ISSUER, clock);
    const assertion = signJwt(key, claims);
    expect((await verify(assertion)).ok).toBe(true);
    expect(await verify(assertion)).toMatchObject({
      ok: false,
      reason: "client_assertion_replayed",
    });
    // A different assertion with the same jti is a replay too.
    expect(
      await verify(
        signJwt(key, { ...claims, exp: (claims.exp as number) + 1 }),
      ),
    ).toMatchObject({ ok: false, reason: "client_assertion_replayed" });
  });

  it("refuses symmetric and unsigned algorithms outright", async () => {
    const claims = b64(claimsFor(CID, ISSUER, clock));
    for (const alg of ["none", "HS256"]) {
      const forged = `${b64({ alg, kid: "k1" })}.${claims}.${Buffer.from("x").toString("base64url")}`;
      expect(await verify(forged)).toMatchObject({
        ok: false,
        reason: "client_assertion_invalid",
      });
    }
    expect(fetches).toBe(0);
  });

  it("refuses a tampered signature, and a crit header", async () => {
    const good = signJwt(key, claimsFor(CID, ISSUER, clock));
    const [h, , s] = good.split(".");
    const tampered = `${h}.${b64(claimsFor(CID, ISSUER, clock))}.${s}`;
    expect(await verify(tampered)).toMatchObject({
      ok: false,
      description: "client_assertion signature does not verify",
    });
    expect(
      await verify(
        signJwt(key, claimsFor(CID, ISSUER, clock), { crit: ["x"] }),
      ),
    ).toMatchObject({ ok: false, reason: "client_assertion_invalid" });
  });

  it("refuses a key the client did not publish, signed by a stranger", async () => {
    const stranger = makeKey("ES256", "k1"); // same kid, different key
    expect(
      await verify(signJwt(stranger, claimsFor(CID, ISSUER, clock))),
    ).toMatchObject({ ok: false, reason: "client_assertion_invalid" });
  });

  it("refuses an alg the document's token_endpoint_auth_signing_alg rules out", async () => {
    expect(
      await verify(signJwt(key, claimsFor(CID, ISSUER, clock)), "RS256"),
    ).toMatchObject({ ok: false, reason: "client_assertion_invalid" });
  });

  it("picks up a rotated key with one refetch on an unknown kid", async () => {
    expect((await verify(signJwt(key, claimsFor(CID, ISSUER, clock)))).ok).toBe(
      true,
    );
    expect(fetches).toBe(1);
    const rotated = makeKey("ES256", "k2");
    served = [rotated.jwk];
    clock += 31_000; // past the refetch interval, inside the cache's TTL
    const out = await verify(signJwt(rotated, claimsFor(CID, ISSUER, clock)));
    expect(out).toMatchObject({ ok: true, client: { keyId: "k2" } });
    expect(fetches).toBe(2);
  });

  it("does not refetch for an unknown kid more than once per interval", async () => {
    expect((await verify(signJwt(key, claimsFor(CID, ISSUER, clock)))).ok).toBe(
      true,
    );
    const unknown = makeKey("ES256", "nobody");
    for (let i = 0; i < 5; i += 1) {
      clock += 1000;
      expect(
        await verify(signJwt(unknown, claimsFor(CID, ISSUER, clock))),
      ).toMatchObject({ ok: false, reason: "client_assertion_invalid" });
    }
    expect(fetches).toBe(1);
  });

  it("refuses a key set that publishes private material", async () => {
    const leaked = {
      ...(key.privateKey.export({ format: "jwk" }) as Record<string, unknown>),
      kid: "k1",
    };
    served = [leaked];
    expect(
      await verify(signJwt(key, claimsFor(CID, ISSUER, clock))),
    ).toMatchObject({ ok: false, reason: "client_keys_unavailable" });
  });

  it("skips RSA keys under 2048 bits and keys not for signing", () => {
    const small = generateKeyPairSync("rsa", { modulusLength: 1024 });
    const enc = makeKey("ES256", "enc");
    const parsed = parseJwks({
      keys: [
        small.publicKey.export({ format: "jwk" }),
        { ...enc.jwk, use: "enc" },
        { kty: "oct", k: "c2VjcmV0" },
      ],
    });
    // `oct` carries `k`, a symmetric secret: the whole set is refused.
    expect(parsed.ok).toBe(false);
    const withoutOct = parseJwks({
      keys: [
        small.publicKey.export({ format: "jwk" }),
        { ...enc.jwk, use: "enc" },
      ],
    });
    expect(withoutOct).toMatchObject({ ok: true, keys: [] });
  });

  it("verifies against an inline jwks without fetching", async () => {
    const out = await verifier.verify({
      clientId: CID,
      assertion: signJwt(key, claimsFor(CID, ISSUER, clock)),
      audiences: AUDS,
      keys: { kind: "inline", jwks: { keys: [key.jwk] } },
    });
    expect(out.ok).toBe(true);
    expect(fetches).toBe(0);
  });
});

describe("what a document may declare", () => {
  const base = {
    client_id: CID,
    redirect_uris: ["https://zimmer.example.com/cb"],
    token_endpoint_auth_method: "private_key_jwt",
    jwks_uri: JWKS_URI,
  };

  it("refuses private_key_jwt where the deployment has not turned it on", () => {
    expect(parseClientMetadata(CID, base)).toMatchObject({
      ok: false,
      description:
        'strad serves public clients only: token_endpoint_auth_method must be "none"',
    });
  });

  it("accepts it, with its keys, where it is on", () => {
    expect(
      parseClientMetadata(CID, base, { privateKeyJwt: true }),
    ).toMatchObject({
      ok: true,
      client: { auth: "private_key_jwt", jwksUri: JWKS_URI },
    });
  });

  it("requires keys, one source of them, and an https jwks_uri", () => {
    const on = { privateKeyJwt: true };
    const { jwks_uri: _u, ...noKeys } = base;
    expect(parseClientMetadata(CID, noKeys, on).ok).toBe(false);
    expect(
      parseClientMetadata(CID, { ...base, jwks: { keys: [] } }, on).ok,
    ).toBe(false);
    expect(
      parseClientMetadata(
        CID,
        { ...base, jwks_uri: "http://zimmer.example.com/jwks.json" },
        on,
      ).ok,
    ).toBe(false);
    expect(
      parseClientMetadata(
        CID,
        { ...base, jwks_uri: "https://10.0.0.1/jwks.json" },
        on,
      ).ok,
    ).toBe(false);
  });

  it("does not read a public document's key fields, even where it is on", () => {
    const publicDoc = {
      client_id: CID,
      redirect_uris: ["https://zimmer.example.com/cb"],
      token_endpoint_auth_method: "none",
      jwks: { keys: [] },
      jwks_uri: "http://not-even-https.example.com/jwks",
      token_endpoint_auth_signing_alg: 7,
    };
    const out = parseClientMetadata(CID, publicDoc, { privateKeyJwt: true });
    expect(out.ok).toBe(true);
    expect(out.ok && out.client).not.toHaveProperty("jwksUri");
    expect(parseClientMetadata(CID, publicDoc).ok).toBe(true);
  });

  it("still refuses a client secret and every secret-based method", () => {
    const on = { privateKeyJwt: true };
    expect(
      parseClientMetadata(
        CID,
        { ...base, token_endpoint_auth_method: "client_secret_basic" },
        on,
      ).ok,
    ).toBe(false);
    expect(
      parseClientMetadata(CID, { ...base, client_secret: "x" }, on).ok,
    ).toBe(false);
  });
});

describe("the config", () => {
  const cfg = (
    clientExtra: string,
    global = "",
    gw = ", publicUrl: https://strad.example.com",
  ) => `
version: 1
gateway: { name: strad, env: test${gw} }
auth:
  staticTokens: { enabled: true }
  mcpOAuth:
    enabled: true
    hostedDomain: tadasant.com
${global}
    clients:
      - clientId: ${CID}
${clientExtra}
`;

  it("requires gateway.publicUrl, so aud is never taken from the request", () => {
    expect(() =>
      parseConfig(
        cfg("        tokenEndpointAuthMethod: private_key_jwt", "", ""),
      ),
    ).toThrow(/needs gateway.publicUrl/);
    expect(() => parseConfig(cfg("", "    privateKeyJwt: true", ""))).toThrow(
      /needs gateway.publicUrl/,
    );
  });

  it("leaves the feature unset by default", () => {
    expect(parseConfig(cfg("")).auth.mcpOAuth.privateKeyJwt).toBe(undefined);
  });

  it("refuses a jwksUri pin without the requirement", () => {
    expect(() => parseConfig(cfg(`        jwksUri: ${JWKS_URI}`))).toThrow(
      /jwksUri pins keys/,
    );
  });

  it("refuses a non-https jwksUri", () => {
    expect(() =>
      parseConfig(
        cfg(
          `        tokenEndpointAuthMethod: private_key_jwt\n        jwksUri: http://zimmer.example.com/jwks.json`,
        ),
      ),
    ).toThrow(/jwks_uri must use https/);
  });

  it("refuses a requirement the global switch turns off", () => {
    expect(() =>
      parseConfig(
        cfg(
          "        tokenEndpointAuthMethod: private_key_jwt",
          "    privateKeyJwt: false",
        ),
      ),
    ).toThrow(/privateKeyJwt is false/);
  });
});

// ---------------------------------------------------------------------------
// End to end
// ---------------------------------------------------------------------------

const KEY = "an-oauth-signing-key-of-sufficient-length";
const CALLBACK = "https://zimmer.example.com/oauth/callback";
const CLAUDE = "https://claude.ai/oauth/mcp-oauth-client-metadata";
const CLAUDE_CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const PINNED_JWKS = "https://keys.zimmer.example.com/jwks.json";
const ATTACKER_JWKS = "https://evil.example.com/jwks.json";

function yaml(mcpOAuthExtra = "", publicUrl?: string): string {
  return `
version: 1
gateway: { name: strad, env: test${publicUrl ? `, publicUrl: "${publicUrl}"` : ""} }
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

interface Gateway {
  base: string;
  server: Server;
  google: FakeGoogleGrant;
  oauth: McpOAuth;
  documents: Map<string, FetchedDocument>;
  close: () => Promise<void>;
}

const zimmerKey = makeKey("ES256", "zimmer-1");
const attackerKey = makeKey("ES256", "zimmer-1");

function zimmerDocument(
  overrides: Record<string, unknown> = {},
): FetchedDocument {
  return json({
    client_id: CID,
    client_name: "Zimmer",
    redirect_uris: [CALLBACK],
    grant_types: ["authorization_code", "refresh_token"],
    token_endpoint_auth_method: "private_key_jwt",
    jwks_uri: JWKS_URI,
    ...overrides,
  });
}

/** A free loopback port, so the config can declare the origin it serves. */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", () => r()));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((r) => probe.close(() => r()));
  return port;
}

async function gateway(
  extra = "",
  opts: { publicUrl?: string | null } = {},
): Promise<Gateway> {
  const port = await freePort();
  const own = `http://127.0.0.1:${port}`;
  const publicUrl = opts.publicUrl === undefined ? own : opts.publicUrl;
  const config = parseConfig(yaml(extra, publicUrl ?? undefined));
  const env = {
    NODE_ENV: "test",
    STRAD_OAUTH_KEY: KEY,
    STRAD_TOKENS: "[]",
  } as NodeJS.ProcessEnv;
  const google = fakeGoogleGrant("tadasant.com");
  const documents = new Map<string, FetchedDocument>([
    [CID, zimmerDocument()],
    [JWKS_URI, json({ keys: [zimmerKey.jwk] })],
    [PINNED_JWKS, json({ keys: [zimmerKey.jwk] })],
    [ATTACKER_JWKS, json({ keys: [attackerKey.jwk] })],
    [
      CLAUDE,
      json({
        client_id: CLAUDE,
        client_name: "Claude",
        redirect_uris: [CLAUDE_CALLBACK],
        token_endpoint_auth_method: "none",
      }),
    ],
  ]);
  const fetchDocument = async (url: URL): Promise<FetchedDocument> => {
    const doc = documents.get(url.href);
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
  });
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(port, "127.0.0.1", () => resolve(s));
  });
  const base = own;
  const oauth = resolveMcpOAuth({ config, env, google, log: () => {} });
  if (!oauth) throw new Error("no oauth");
  return {
    base,
    server,
    google,
    oauth,
    documents,
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

/** Authorize → Google → consent → approve. The code, or the refusal. */
async function walk(
  g: Gateway,
  clientId = CID,
  redirect = CALLBACK,
): Promise<{ code?: string; verifier: string; refused?: number }> {
  const { verifier, challenge } = pkce();
  const url = new URL(`${g.base}/oauth/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirect);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  const started = await fetch(url, { redirect: "manual" });
  const location = started.headers.get("location") ?? "";
  if (started.status !== 302 || !location.startsWith("https://accounts")) {
    return { verifier, refused: started.status };
  }
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
  const landed = new URL(approved.headers.get("location") ?? "");
  return { code: landed.searchParams.get("code") ?? "", verifier };
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  error?: string;
  error_description?: string;
}

async function post(
  g: Gateway,
  path: string,
  body: Record<string, string>,
): Promise<{ status: number; json: TokenResponse }> {
  const res = await fetch(`${g.base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  const text = await res.text();
  return {
    status: res.status,
    json: (text ? JSON.parse(text) : {}) as TokenResponse,
  };
}

function assertionParams(
  g: Gateway,
  key: TestKey = zimmerKey,
  aud: string = g.base,
): Record<string, string> {
  return {
    client_assertion_type: CLIENT_ASSERTION_TYPE,
    client_assertion: signJwt(key, claimsFor(CID, aud)),
  };
}

async function metadata(g: Gateway): Promise<Record<string, unknown>> {
  return (await (
    await fetch(`${g.base}/.well-known/oauth-authorization-server`)
  ).json()) as Record<string, unknown>;
}

describe("with nothing configured, nothing changes", () => {
  let g: Gateway;
  beforeAll(async () => (g = await gateway()));
  afterAll(async () => g.close());

  it("advertises none, and no algorithm list", async () => {
    const as = await metadata(g);
    expect(as.token_endpoint_auth_methods_supported).toEqual(["none"]);
    expect(as.revocation_endpoint_auth_methods_supported).toEqual(["none"]);
    expect(as).not.toHaveProperty(
      "token_endpoint_auth_signing_alg_values_supported",
    );
    expect(as).not.toHaveProperty(
      "revocation_endpoint_auth_signing_alg_values_supported",
    );
  });

  it("refuses a document that declares private_key_jwt, as before", async () => {
    expect((await walk(g)).refused).toBe(400);
  });

  it("still refuses a token request with no client_id, assertion or not", async () => {
    const w = await walk(g, CLAUDE, CLAUDE_CALLBACK);
    const forged = signJwt(makeKey("ES256"), claimsFor(CLAUDE, g.base));
    const res = await post(g, "/oauth/token", {
      grant_type: "authorization_code",
      code: w.code ?? "",
      code_verifier: w.verifier,
      client_assertion_type: CLIENT_ASSERTION_TYPE,
      client_assertion: forged,
    });
    expect(res.status).toBe(401);
    expect(res.json.error_description).toBe("unknown client_id.");
  });

  it("serves a public client exactly as before, ignoring any assertion", async () => {
    const w = await walk(g, CLAUDE, CLAUDE_CALLBACK);
    const res = await post(g, "/oauth/token", {
      grant_type: "authorization_code",
      code: w.code ?? "",
      client_id: CLAUDE,
      code_verifier: w.verifier,
      client_assertion_type: CLIENT_ASSERTION_TYPE,
      client_assertion: "not.a.jwt",
    });
    expect(res.status).toBe(200);
    const rt = readRefreshToken(g.oauth.keys.refresh, res.json.refresh_token);
    expect(rt?.v).toBe(1);
    expect(rt).not.toHaveProperty("auth");
  });
});

describe("a client whose document declares private_key_jwt", () => {
  let g: Gateway;
  beforeAll(async () => (g = await gateway("    privateKeyJwt: true")));
  afterAll(async () => g.close());

  it("is advertised, with the algorithm list, on both endpoints", async () => {
    const as = await metadata(g);
    expect(as.token_endpoint_auth_methods_supported).toEqual([
      "none",
      "private_key_jwt",
    ]);
    expect(as.token_endpoint_auth_signing_alg_values_supported).toEqual([
      ...ASSERTION_ALGORITHMS,
    ]);
    expect(as.revocation_endpoint_auth_methods_supported).toEqual([
      "none",
      "private_key_jwt",
    ]);
  });

  it("must authenticate to redeem its code", async () => {
    const w = await walk(g);
    const bare = {
      grant_type: "authorization_code",
      code: w.code ?? "",
      client_id: CID,
      code_verifier: w.verifier,
    };
    const refused = await post(g, "/oauth/token", bare);
    expect(refused.status).toBe(401);
    expect(refused.json.error).toBe("invalid_client");

    const wrongAud = await post(g, "/oauth/token", {
      ...bare,
      ...assertionParams(g, zimmerKey, "https://elsewhere.example"),
    });
    expect(wrongAud.status).toBe(401);

    const ok = await post(g, "/oauth/token", {
      ...bare,
      ...assertionParams(g),
    });
    expect(ok.status).toBe(200);
    const rt = readRefreshToken(g.oauth.keys.refresh, ok.json.refresh_token);
    expect(rt).toMatchObject({ v: 3, auth: "private_key_jwt" });
  });

  it("may omit client_id when the assertion names it", async () => {
    const w = await walk(g);
    const ok = await post(g, "/oauth/token", {
      grant_type: "authorization_code",
      code: w.code ?? "",
      code_verifier: w.verifier,
      ...assertionParams(g, zimmerKey, `${g.base}/oauth/token`),
    });
    expect(ok.status).toBe(200);
  });

  it("must authenticate on every refresh, and cannot replay an assertion", async () => {
    const w = await walk(g);
    const issued = await post(g, "/oauth/token", {
      grant_type: "authorization_code",
      code: w.code ?? "",
      client_id: CID,
      code_verifier: w.verifier,
      ...assertionParams(g),
    });
    const refresh = {
      grant_type: "refresh_token",
      refresh_token: issued.json.refresh_token ?? "",
      client_id: CID,
    };
    expect((await post(g, "/oauth/token", refresh)).status).toBe(401);
    const once = assertionParams(g);
    expect(
      (await post(g, "/oauth/token", { ...refresh, ...once })).status,
    ).toBe(200);
    const replay = await post(g, "/oauth/token", { ...refresh, ...once });
    expect(replay.status).toBe(401);
    expect(replay.json.error_description).toMatch(/already been used/);
  });

  it("stays confidential when its document later says none", async () => {
    const w = await walk(g);
    const issued = await post(g, "/oauth/token", {
      grant_type: "authorization_code",
      code: w.code ?? "",
      client_id: CID,
      code_verifier: w.verifier,
      ...assertionParams(g),
    });
    // The document flips to public. The cache is per process, so a fresh
    // gateway is the one that would read the new document.
    const g2 = await gateway("    privateKeyJwt: true");
    g2.documents.set(
      CID,
      zimmerDocument({
        token_endpoint_auth_method: "none",
        jwks_uri: undefined,
      }),
    );
    try {
      const res = await post(g2, "/oauth/token", {
        grant_type: "refresh_token",
        refresh_token: issued.json.refresh_token ?? "",
        client_id: CID,
      });
      expect(res.status).toBe(401);
      expect(res.json.error).toBe("invalid_client");
    } finally {
      await g2.close();
    }
  });

  it("revokes only with an assertion", async () => {
    const w = await walk(g);
    const issued = await post(g, "/oauth/token", {
      grant_type: "authorization_code",
      code: w.code ?? "",
      client_id: CID,
      code_verifier: w.verifier,
      ...assertionParams(g),
    });
    const google = g.google.lastRefreshToken;
    const token = issued.json.refresh_token ?? "";
    const bare = await post(g, "/oauth/revoke", { token, client_id: CID });
    expect(bare.status).toBe(401);
    expect(g.google.live()).toContain(google);

    const ok = await post(g, "/oauth/revoke", {
      token,
      ...assertionParams(g, zimmerKey, `${g.base}/oauth/revoke`),
    });
    expect(ok.status).toBe(200);
    expect(g.google.live()).not.toContain(google);
  });

  it("leaves public clients alone", async () => {
    const w = await walk(g, CLAUDE, CLAUDE_CALLBACK);
    const issued = await post(g, "/oauth/token", {
      grant_type: "authorization_code",
      code: w.code ?? "",
      client_id: CLAUDE,
      code_verifier: w.verifier,
    });
    expect(issued.status).toBe(200);
    const refreshed = await post(g, "/oauth/token", {
      grant_type: "refresh_token",
      refresh_token: issued.json.refresh_token ?? "",
      client_id: CLAUDE,
    });
    expect(refreshed.status).toBe(200);
    expect(
      (
        await post(g, "/oauth/revoke", {
          token: issued.json.refresh_token ?? "",
        })
      ).status,
    ).toBe(200);
  });
});

describe("a client the config requires to use private_key_jwt", () => {
  let g: Gateway;
  beforeAll(
    async () =>
      (g = await gateway(`    clients:
      - clientId: ${CID}
        tokenEndpointAuthMethod: private_key_jwt
        jwksUri: ${PINNED_JWKS}`)),
  );
  afterAll(async () => g.close());

  it("turns the method on without the global switch", async () => {
    expect(g.oauth.policies.privateKeyJwt).toBe(true);
    expect((await metadata(g)).token_endpoint_auth_methods_supported).toEqual([
      "none",
      "private_key_jwt",
    ]);
  });

  it("cannot be downgraded by a document tampered to say none", async () => {
    g.documents.set(
      CID,
      zimmerDocument({
        token_endpoint_auth_method: "none",
        jwks_uri: ATTACKER_JWKS,
      }),
    );
    try {
      const w = await walk(g);
      expect(w.code).toBeTruthy();
      const bare = {
        grant_type: "authorization_code",
        code: w.code ?? "",
        client_id: CID,
        code_verifier: w.verifier,
      };
      expect((await post(g, "/oauth/token", bare)).status).toBe(401);
      // The document's keys are not the pinned ones, so its holder's
      // signature does not count.
      expect(
        (
          await post(g, "/oauth/token", {
            ...bare,
            ...assertionParams(g, attackerKey),
          })
        ).status,
      ).toBe(401);
      const ok = await post(g, "/oauth/token", {
        ...bare,
        ...assertionParams(g),
      });
      expect(ok.status).toBe(200);
      expect(
        readRefreshToken(g.oauth.keys.refresh, ok.json.refresh_token)?.auth,
      ).toBe("private_key_jwt");
    } finally {
      g.documents.set(CID, zimmerDocument());
    }
  });
});

describe("the audience is the declared origin, not the request's", () => {
  let g: Gateway;
  beforeAll(
    async () =>
      (g = await gateway("    privateKeyJwt: true", {
        publicUrl: "https://strad.example.com",
      })),
  );
  afterAll(async () => g.close());

  it("refuses an assertion addressed to the origin the request arrived on", async () => {
    const w = await walk(g);
    const bare = {
      grant_type: "authorization_code",
      code: w.code ?? "",
      client_id: CID,
      code_verifier: w.verifier,
    };
    const toRequestOrigin = await post(g, "/oauth/token", {
      ...bare,
      ...assertionParams(g, zimmerKey, g.base),
    });
    expect(toRequestOrigin.status).toBe(401);
    const ok = await post(g, "/oauth/token", {
      ...bare,
      ...assertionParams(g, zimmerKey, "https://strad.example.com"),
    });
    expect(ok.status).toBe(200);
  });
});

describe("the replay record", () => {
  it("bounds each client separately, so one cannot lock out the rest", () => {
    const cache = new AssertionReplayCache(10, 2);
    const later = 10_000;
    expect(cache.spend("a", "1", later, 0)).toBe("fresh");
    expect(cache.spend("a", "2", later, 0)).toBe("fresh");
    expect(cache.spend("a", "3", later, 0)).toBe("full");
    expect(cache.spend("b", "1", later, 0)).toBe("fresh");
    // Expired entries free the client's slots.
    expect(cache.spend("a", "3", later, later + 1)).toBe("fresh");
  });
});
