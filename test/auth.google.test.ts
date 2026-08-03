import {
  createHash,
  createHmac,
  createSign,
  generateKeyPairSync,
  type JsonWebKey,
  type KeyObject,
} from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AuthError,
  GoogleOAuthProvider,
  googleProviderFromEnv,
  resetJwksCache,
} from "../src/auth/google.ts";

/**
 * The ID-token verifier behind the console's front door.
 *
 * No credential and no network: an RSA keypair is generated here, its public
 * half is published as a JWK through a stubbed `fetch` for Google's JWKS URI,
 * and every token in this file is signed locally. That reaches every branch of
 * `verifyGoogleJwt` and `verifyIdToken`, including the two that matter most:
 *
 *   1. `hd`. Google's `email` claim is not proof of Workspace membership — a
 *      personal account can set its profile email to `someone@tadasant.com` and
 *      `email_verified` will be true for it. Only `hd` is emitted for real
 *      members, so a token that is perfectly signed and perfectly verified must
 *      still be refused when `hd` is wrong or absent.
 *   2. Algorithm confusion. `alg: none`, and HS256 signed with the verifying
 *      public key as the HMAC secret — the attack that turns a public key into a
 *      signing key on any verifier that trusts the header's `alg`.
 *
 * The JWKS cache is process-wide (`resetJwksCache()` exists for exactly this),
 * so each case starts from a cold cache and installs its own key material.
 */

const JWKS_URI = "https://www.googleapis.com/oauth2/v3/certs";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const CLIENT_ID = "1234567890-strad.apps.googleusercontent.com";
const HOSTED_DOMAIN = "tadasant.com";
const REDIRECT_URI = "https://strad.example/auth/google/callback";

interface TestKey {
  kid: string;
  jwk: JsonWebKey & { kid: string };
  publicKey: KeyObject;
  privateKey: KeyObject;
}

function testKey(kid: string): TestKey {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  return {
    kid,
    jwk: { ...publicKey.export({ format: "jwk" }), kid, alg: "RS256" },
    publicKey,
    privateKey,
  };
}

/** The key Google publishes. */
const GOOGLE_KEY = testKey("strad-test-kid");
/** A different key under the SAME kid: the lookup hits, the signature does not. */
const IMPOSTOR_KEY = testKey("strad-test-kid");

const b64url = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

interface Claims {
  iss?: string;
  aud?: string;
  sub?: string;
  exp?: number;
  hd?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
}

function claims(overrides: Claims = {}): Claims {
  return {
    iss: "https://accounts.google.com",
    aud: CLIENT_ID,
    sub: "109283746501928374650",
    exp: Math.floor(Date.now() / 1000) + 3600,
    hd: HOSTED_DOMAIN,
    email: "person@tadasant.com",
    email_verified: true,
    name: "A Person",
    picture: "https://lh3.googleusercontent.com/a/person",
    ...overrides,
  };
}

function signingInput(header: unknown, payload: Claims): string {
  return `${b64url(header)}.${b64url(payload)}`;
}

/** A well-formed RS256 token signed by whichever key is handed in. */
function rs256(payload: Claims, key: TestKey = GOOGLE_KEY, kid = key.kid) {
  const input = signingInput({ alg: "RS256", kid, typ: "JWT" }, payload);
  const signature = createSign("RSA-SHA256")
    .update(input)
    .sign(key.privateKey)
    .toString("base64url");
  return `${input}.${signature}`;
}

interface StubOptions {
  jwks?: unknown;
  jwksStatus?: number;
  cacheControl?: string;
  tokenStatus?: number;
  tokenBody?: unknown;
}

let jwksFetches = 0;
let tokenRequests: URLSearchParams[] = [];

function stubFetch(options: StubOptions = {}) {
  jwksFetches = 0;
  tokenRequests = [];
  vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url === JWKS_URI) {
      jwksFetches += 1;
      const status = options.jwksStatus ?? 200;
      const headers: Record<string, string> = {
        "content-type": "application/json",
      };
      if (options.cacheControl) headers["cache-control"] = options.cacheControl;
      return new Response(
        JSON.stringify(options.jwks ?? { keys: [GOOGLE_KEY.jwk] }),
        { status, headers },
      );
    }
    if (url === TOKEN_ENDPOINT) {
      tokenRequests.push(new URLSearchParams(String(init?.body)));
      return new Response(JSON.stringify(options.tokenBody ?? {}), {
        status: options.tokenStatus ?? 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

const provider = new GoogleOAuthProvider({
  clientId: CLIENT_ID,
  clientSecret: "shh",
  redirectUri: REDIRECT_URI,
  hostedDomain: HOSTED_DOMAIN,
});

/** Both that it is an AuthError and what it says — the message is the diagnosis. */
async function refuses(token: string, message: RegExp) {
  await expect(provider.verifyIdToken(token)).rejects.toThrow(AuthError);
  await expect(provider.verifyIdToken(token)).rejects.toThrow(message);
}

beforeEach(() => {
  resetJwksCache();
  stubFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("verifyIdToken — the success path", () => {
  it("accepts a token signed by the published key and returns the identity", async () => {
    const identity = await provider.verifyIdToken(rs256(claims()));
    expect(identity).toEqual({
      sub: "109283746501928374650",
      email: "person@tadasant.com",
      hd: HOSTED_DOMAIN,
      name: "A Person",
      picture: "https://lh3.googleusercontent.com/a/person",
    });
  });

  it("accepts the bare `accounts.google.com` issuer as well as the https one", async () => {
    const identity = await provider.verifyIdToken(
      rs256(claims({ iss: "accounts.google.com" })),
    );
    expect(identity.sub).toBe("109283746501928374650");
  });
});

describe("verifyIdToken — Workspace membership (`hd`)", () => {
  it("refuses a personal account whose profile email carries the domain", async () => {
    // Everything else about this token is genuine: signed by Google's key, right
    // audience, unexpired, and `email_verified: true` for an @tadasant.com
    // address. `hd` is the only claim that says it is a Workspace account, and
    // Google does not emit it for a personal one.
    const impersonation = rs256(
      claims({ hd: undefined, email: "someone@tadasant.com" }),
    );
    await refuses(
      impersonation,
      /not a member of the tadasant\.com Google Workspace/,
    );
  });

  it("refuses a Workspace member from a different domain", async () => {
    await refuses(
      rs256(claims({ hd: "example.com", email: "person@example.com" })),
      /not a member of the tadasant\.com Google Workspace/,
    );
  });

  it("does not accept the email suffix in place of `hd`", async () => {
    // The suffix matches and the check still fails: strad checks `hd`, and the
    // email domain is not a substitute for it.
    await refuses(
      rs256(claims({ hd: "gmail.com", email: "person@tadasant.com" })),
      /not a member of the tadasant\.com Google Workspace/,
    );
  });
});

describe("verifyIdToken — verified email", () => {
  it("refuses an unverified email", async () => {
    await refuses(
      rs256(claims({ email_verified: false })),
      /no verified email/,
    );
  });

  it("refuses an absent `email_verified`", async () => {
    await refuses(
      rs256(claims({ email_verified: undefined })),
      /no verified email/,
    );
  });

  it("refuses a token with no email at all", async () => {
    await refuses(rs256(claims({ email: undefined })), /no verified email/);
  });
});

describe("verifyGoogleJwt — algorithm confusion", () => {
  it("refuses `alg: none`", async () => {
    // The unsigned-token attack: drop the signature, claim the algorithm was
    // never meant to produce one.
    const input = signingInput(
      { alg: "none", kid: GOOGLE_KEY.kid, typ: "JWT" },
      claims(),
    );
    await refuses(`${input}.`, /unexpected id_token alg: none/);
  });

  it("refuses HS256 signed with the verifying public key as the HMAC secret", async () => {
    // Algorithm confusion proper. The public key is public; if the verifier
    // trusted the header's `alg`, anyone could mint a token with it.
    const pem = GOOGLE_KEY.publicKey
      .export({ type: "spki", format: "pem" })
      .toString();
    const input = signingInput(
      { alg: "HS256", kid: GOOGLE_KEY.kid, typ: "JWT" },
      claims(),
    );
    const forged = `${input}.${createHmac("sha256", pem)
      .update(input)
      .digest("base64url")}`;
    await refuses(forged, /unexpected id_token alg: HS256/);
  });

  it("refuses RS512 — the check is an equality, not a family", async () => {
    const input = signingInput(
      { alg: "RS512", kid: GOOGLE_KEY.kid, typ: "JWT" },
      claims(),
    );
    const signature = createSign("RSA-SHA512")
      .update(input)
      .sign(GOOGLE_KEY.privateKey)
      .toString("base64url");
    await refuses(`${input}.${signature}`, /unexpected id_token alg: RS512/);
  });
});

describe("verifyGoogleJwt — signature and key", () => {
  it("refuses a token whose `kid` is not in the JWKS", async () => {
    await refuses(
      rs256(claims(), GOOGLE_KEY, "some-other-kid"),
      /signed by an unknown key/,
    );
  });

  it("refuses a token signed by a different key under a known `kid`", async () => {
    await refuses(
      rs256(claims(), IMPOSTOR_KEY, GOOGLE_KEY.kid),
      /signature verification failed/,
    );
  });

  it("refuses a token whose payload was edited after signing", async () => {
    const [header, , signature] = rs256(claims()).split(".");
    const tampered = `${header}.${b64url(claims({ hd: "attacker.example" }))}.${signature}`;
    await refuses(tampered, /signature verification failed/);
  });

  it("refuses a token that is not three segments", async () => {
    await refuses("not.a-jwt", /malformed id_token/);
  });
});

describe("verifyGoogleJwt — claims", () => {
  it("refuses an unexpected issuer", async () => {
    await refuses(
      rs256(claims({ iss: "https://accounts.google.com.evil.example" })),
      /unexpected id_token issuer/,
    );
  });

  it("refuses a token minted for another audience", async () => {
    await refuses(
      rs256(claims({ aud: "9999-someone-else.apps.googleusercontent.com" })),
      /audience mismatch/,
    );
  });

  it("refuses an expired token", async () => {
    await refuses(
      rs256(claims({ exp: Math.floor(Date.now() / 1000) - 1 })),
      /id_token expired/,
    );
  });
});

describe("getJwks", () => {
  it("surfaces a JWKS fetch failure", async () => {
    stubFetch({ jwksStatus: 503 });
    await refuses(rs256(claims()), /failed to fetch Google JWKS: 503/);
  });

  it("fetches once and serves later verifications from the cache", async () => {
    await provider.verifyIdToken(rs256(claims()));
    await provider.verifyIdToken(rs256(claims()));
    expect(jwksFetches).toBe(1);
  });

  it("re-fetches after resetJwksCache()", async () => {
    await provider.verifyIdToken(rs256(claims()));
    resetJwksCache();
    await provider.verifyIdToken(rs256(claims()));
    expect(jwksFetches).toBe(2);
  });

  describe("Cache-Control", () => {
    // Google rotates these keys, so the TTL is the window in which a rotated-out
    // key is still accepted. Time is faked to observe it without waiting.
    const LONG_LIVED = () =>
      claims({ exp: Math.floor(Date.now() / 1000) + 30 * 24 * 3600 });

    beforeEach(() => {
      vi.useFakeTimers({ now: new Date("2026-01-01T00:00:00Z") });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("honours max-age", async () => {
      stubFetch({ cacheControl: "public, max-age=60, must-revalidate" });
      await provider.verifyIdToken(rs256(LONG_LIVED()));

      vi.advanceTimersByTime(59_000);
      await provider.verifyIdToken(rs256(LONG_LIVED()));
      expect(jwksFetches).toBe(1);

      vi.advanceTimersByTime(2_000);
      await provider.verifyIdToken(rs256(LONG_LIVED()));
      expect(jwksFetches).toBe(2);
    });

    it("falls back to an hour when the header carries no max-age", async () => {
      stubFetch({ cacheControl: "no-transform" });
      await provider.verifyIdToken(rs256(LONG_LIVED()));

      vi.advanceTimersByTime(3_599_000);
      await provider.verifyIdToken(rs256(LONG_LIVED()));
      expect(jwksFetches).toBe(1);

      vi.advanceTimersByTime(2_000);
      await provider.verifyIdToken(rs256(LONG_LIVED()));
      expect(jwksFetches).toBe(2);
    });

    it("falls back to an hour when there is no Cache-Control at all", async () => {
      stubFetch();
      await provider.verifyIdToken(rs256(LONG_LIVED()));

      vi.advanceTimersByTime(3_601_000);
      await provider.verifyIdToken(rs256(LONG_LIVED()));
      expect(jwksFetches).toBe(2);
    });
  });
});

describe("beginAuth", () => {
  it("carries a PKCE challenge that is the S256 of its own verifier", () => {
    const pending = provider.beginAuth();
    const url = new URL(pending.url);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe(
      createHash("sha256").update(pending.codeVerifier).digest("base64url"),
    );
    expect(url.searchParams.get("state")).toBe(pending.state);
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
    // A hint to the account chooser, not a control: `hd` is verified on the way back.
    expect(url.searchParams.get("hd")).toBe(HOSTED_DOMAIN);
  });

  it("mints a fresh state and verifier each time", () => {
    const a = provider.beginAuth();
    const b = provider.beginAuth();
    expect(a.state).not.toBe(b.state);
    expect(a.codeVerifier).not.toBe(b.codeVerifier);
  });
});

describe("completeAuth", () => {
  it("sends the PKCE verifier and verifies the returned id_token", async () => {
    stubFetch({ tokenBody: { id_token: rs256(claims()) } });
    const identity = await provider.completeAuth("the-code", "the-verifier");
    expect(identity.email).toBe("person@tadasant.com");
    expect(tokenRequests).toHaveLength(1);
    expect(Object.fromEntries(tokenRequests[0]!)).toMatchObject({
      code: "the-code",
      code_verifier: "the-verifier",
      client_id: CLIENT_ID,
      client_secret: "shh",
      grant_type: "authorization_code",
    });
  });

  it("refuses an id_token from the exchange that fails `hd`", async () => {
    stubFetch({ tokenBody: { id_token: rs256(claims({ hd: undefined })) } });
    await expect(
      provider.completeAuth("the-code", "the-verifier"),
    ).rejects.toThrow(/not a member of the tadasant\.com Google Workspace/);
  });

  it("reports a failed exchange", async () => {
    stubFetch({ tokenStatus: 400, tokenBody: { error: "invalid_grant" } });
    await expect(
      provider.completeAuth("the-code", "the-verifier"),
    ).rejects.toThrow(/google token exchange failed: 400/);
  });

  it("reports an exchange that returns no id_token", async () => {
    stubFetch({ tokenBody: { access_token: "ya29.a0" } });
    await expect(
      provider.completeAuth("the-code", "the-verifier"),
    ).rejects.toThrow(/no id_token/);
  });
});

describe("googleProviderFromEnv", () => {
  it("is null until both credentials are present", () => {
    expect(googleProviderFromEnv(HOSTED_DOMAIN, REDIRECT_URI, {})).toBeNull();
    expect(
      googleProviderFromEnv(HOSTED_DOMAIN, REDIRECT_URI, {
        GOOGLE_CLIENT_ID: CLIENT_ID,
      }),
    ).toBeNull();
    expect(
      googleProviderFromEnv(HOSTED_DOMAIN, REDIRECT_URI, {
        GOOGLE_CLIENT_SECRET: "shh",
      }),
    ).toBeNull();
  });

  it("builds a provider bound to the hosted domain when both are present", async () => {
    const built = googleProviderFromEnv(HOSTED_DOMAIN, REDIRECT_URI, {
      GOOGLE_CLIENT_ID: CLIENT_ID,
      GOOGLE_CLIENT_SECRET: "shh",
    });
    expect(built).not.toBeNull();
    const identity = await built!.verifyIdToken(rs256(claims()));
    expect(identity.hd).toBe(HOSTED_DOMAIN);
  });
});
