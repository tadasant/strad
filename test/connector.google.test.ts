import {
  createHash,
  createSign,
  generateKeyPairSync,
  type JsonWebKey,
  type KeyObject,
} from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetJwksCache } from "../src/auth/google.ts";
import {
  buildAuthorizeUrl,
  ConnectorError,
  exchangeCode,
} from "../src/connectors/google.ts";

/**
 * The consent URL strad builds, and what it will and will not accept back.
 *
 * No credential and no network: an RSA keypair is generated here, published as a
 * JWK through a stubbed `fetch` for Google's JWKS URI, and every ID token is
 * signed locally.
 *
 * The cases below are the ones where a plausible implementation is silently
 * wrong rather than loudly broken:
 *
 *   - a token stored from a consent the human narrowed (unticked a scope) leaves
 *     a slug that reads "connected" and 403s on its first real call;
 *   - a token stored from the wrong account gives an agent entitled to one
 *     mailbox a view of another;
 *   - a successful consent with no `refresh_token` is an hour of capability and
 *     nothing to store, and reporting it as success is worse than refusing;
 *   - Google's error bodies are upstream text, and none of them may end up in a
 *     message strad renders, logs or exports.
 */

const JWKS_URI = "https://www.googleapis.com/oauth2/v3/certs";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const CLIENT_ID = "6-strad-sheets.apps.googleusercontent.com";
const CLIENT_SECRET = "GOCSPX-do-not-leak-this-anywhere";
const REDIRECT_URI = "https://strad.example/ui/oauth/callback";
const SHEETS_RO = "https://www.googleapis.com/auth/spreadsheets.readonly";
const SHEETS_RW = "https://www.googleapis.com/auth/spreadsheets";
const ACCOUNT = "tadas412@gmail.com";
const REFRESH = "1//0e-REFRESH-TOKEN-CANARY-do-not-leak";

interface TestKey {
  kid: string;
  jwk: JsonWebKey & { kid: string };
  privateKey: KeyObject;
}

function testKey(kid: string): TestKey {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  return {
    kid,
    jwk: { ...publicKey.export({ format: "jwk" }), kid, alg: "RS256" },
    privateKey,
  };
}

const GOOGLE_KEY = testKey("connector-test-kid");

const b64url = (v: unknown): string =>
  Buffer.from(JSON.stringify(v)).toString("base64url");

function idToken(
  overrides: Record<string, unknown> = {},
  key: TestKey = GOOGLE_KEY,
): string {
  const payload = {
    iss: "https://accounts.google.com",
    aud: CLIENT_ID,
    sub: "10928374650192837465",
    exp: Math.floor(Date.now() / 1000) + 3600,
    email: ACCOUNT,
    email_verified: true,
    ...overrides,
  };
  const input = `${b64url({ alg: "RS256", kid: key.kid, typ: "JWT" })}.${b64url(payload)}`;
  const signature = createSign("RSA-SHA256")
    .update(input)
    .sign(key.privateKey)
    .toString("base64url");
  return `${input}.${signature}`;
}

interface TokenStub {
  status?: number;
  body?: unknown;
}

let tokenRequests: URLSearchParams[] = [];

function stubGoogle(stub: TokenStub = {}): typeof fetch {
  tokenRequests = [];
  vi.stubGlobal("fetch", async (input: unknown) => {
    if (String(input) === JWKS_URI) {
      return new Response(JSON.stringify({ keys: [GOOGLE_KEY.jwk] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch: ${String(input)}`);
  });

  return (async (input: unknown, init?: RequestInit) => {
    expect(String(input)).toBe(TOKEN_ENDPOINT);
    tokenRequests.push(new URLSearchParams(String(init?.body)));
    return new Response(
      JSON.stringify(
        stub.body ?? {
          access_token: "ya29.ACCESS-TOKEN-CANARY",
          refresh_token: REFRESH,
          id_token: idToken(),
          scope: `openid email ${SHEETS_RO}`,
          token_type: "Bearer",
        },
      ),
      {
        status: stub.status ?? 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;
}

beforeEach(() => {
  resetJwksCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetJwksCache();
});

const exchange = (
  fetchImpl: typeof fetch,
  overrides: Partial<Parameters<typeof exchangeCode>[0]> = {},
) =>
  exchangeCode(
    {
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      redirectUri: REDIRECT_URI,
      code: "4/0AX-authorization-code",
      verifier: "a-pkce-verifier-of-adequate-length-here",
      expectedAccount: ACCOUNT,
      requiredScopes: [SHEETS_RO],
      ...overrides,
    },
    fetchImpl,
  );

describe("the consent URL", () => {
  it("pins the exact redirect URI, PKCE S256, offline access and a forced consent", () => {
    const pending = buildAuthorizeUrl({
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      scopes: ["openid", "email", SHEETS_RO],
      loginHint: ACCOUNT,
    });
    const url = new URL(pending.url);

    expect(url.origin + url.pathname).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(url.searchParams.get("scope")).toBe(`openid email ${SHEETS_RO}`);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    // `access_type=offline` is what asks for a refresh token at all, and
    // `prompt=consent` is what makes Google return one on a RECONNECT — without
    // it a re-consent yields no refresh_token and the flow can never rotate.
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    // Incremental authorization would hand a `-ro` slug whatever the `-rw` slug
    // had previously been granted for the same client.
    expect(url.searchParams.get("include_granted_scopes")).toBeNull();
  });

  it("puts the challenge in the URL and keeps the verifier out of it", () => {
    const pending = buildAuthorizeUrl({
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      scopes: [SHEETS_RO],
      loginHint: ACCOUNT,
    });
    const challenge = new URL(pending.url).searchParams.get("code_challenge");
    expect(challenge).toBe(
      createHash("sha256").update(pending.verifier).digest("base64url"),
    );
    expect(pending.url).not.toContain(pending.verifier);
  });

  it("mints a fresh state and verifier every time", () => {
    const a = buildAuthorizeUrl({
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      scopes: [SHEETS_RO],
      loginHint: ACCOUNT,
    });
    const b = buildAuthorizeUrl({
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      scopes: [SHEETS_RO],
      loginHint: ACCOUNT,
    });
    expect(a.state).not.toBe(b.state);
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.state.length).toBeGreaterThanOrEqual(40);
  });
});

describe("the exchange", () => {
  it("sends the code, the verifier and the exact redirect URI, and returns the grant", async () => {
    const grant = await exchange(stubGoogle());

    const sent = tokenRequests[0]!;
    expect(sent.get("grant_type")).toBe("authorization_code");
    expect(sent.get("code_verifier")).toBe(
      "a-pkce-verifier-of-adequate-length-here",
    );
    expect(sent.get("redirect_uri")).toBe(REDIRECT_URI);

    expect(grant.refreshToken).toBe(REFRESH);
    expect(grant.email).toBe(ACCOUNT);
    expect(grant.grantedScopes).toEqual(["email", SHEETS_RO, "openid"]);
  });

  it("refuses a consent from a different account, and says which one was expected", async () => {
    const fetchImpl = stubGoogle({
      body: {
        refresh_token: REFRESH,
        id_token: idToken({ email: "tadas@tadasant.com" }),
        scope: `openid email ${SHEETS_RO}`,
      },
    });
    await expect(exchange(fetchImpl)).rejects.toMatchObject({
      code: "account_mismatch",
    });
    await expect(exchange(fetchImpl)).rejects.toThrow(
      /pinned to tadas412@gmail.com/,
    );
  });

  it("matches the account case-insensitively, because Google addresses are", async () => {
    const grant = await exchange(
      stubGoogle({
        body: {
          refresh_token: REFRESH,
          id_token: idToken({ email: "Tadas412@Gmail.com" }),
          scope: `openid email ${SHEETS_RO}`,
        },
      }),
    );
    expect(grant.email).toBe("Tadas412@Gmail.com");
  });

  it("refuses an unverified email rather than trusting the claim", async () => {
    await expect(
      exchange(
        stubGoogle({
          body: {
            refresh_token: REFRESH,
            id_token: idToken({ email_verified: false }),
            scope: `openid email ${SHEETS_RO}`,
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "identity_unverified" });
  });

  it("refuses an ID token minted for a different OAuth client", async () => {
    await expect(
      exchange(
        stubGoogle({
          body: {
            refresh_token: REFRESH,
            id_token: idToken({
              aud: "someone-else.apps.googleusercontent.com",
            }),
            scope: `openid email ${SHEETS_RO}`,
          },
        }),
      ),
    ).rejects.toThrow(/audience mismatch/);
  });

  it("refuses a narrowed consent: a read-only grant cannot satisfy a read-write slug", async () => {
    await expect(
      exchange(
        stubGoogle({
          body: {
            refresh_token: REFRESH,
            id_token: idToken(),
            scope: `openid email ${SHEETS_RO}`,
          },
        }),
        { requiredScopes: [SHEETS_RW] },
      ),
    ).rejects.toMatchObject({ code: "scope_not_granted" });
  });

  it("accepts a read-write grant for a read-write slug", async () => {
    const grant = await exchange(
      stubGoogle({
        body: {
          refresh_token: REFRESH,
          id_token: idToken(),
          scope: `openid email ${SHEETS_RW}`,
        },
      }),
      { requiredScopes: [SHEETS_RW] },
    );
    expect(grant.grantedScopes).toContain(SHEETS_RW);
  });

  it("reports a WIDER grant faithfully rather than narrowing it in the result", async () => {
    // The `-ro` slug asked for `.readonly` and Google says it granted the wider
    // scope. That is NOT refused, deliberately — Google substitutes its own
    // spellings for the identity scopes, so a strict "nothing extra" rule would
    // refuse correct consents. What must not happen is the result under-reporting
    // it: `unexpectedScopes` reads this list, and the console turns it into a
    // warning rather than going on calling the slug read-only.
    const grant = await exchange(
      stubGoogle({
        body: {
          refresh_token: REFRESH,
          id_token: idToken(),
          scope: `openid email ${SHEETS_RO} ${SHEETS_RW}`,
        },
      }),
    );
    expect(grant.grantedScopes).toContain(SHEETS_RW);
  });

  it("refuses a consent that returned no refresh token, rather than reporting success", async () => {
    await expect(
      exchange(
        stubGoogle({
          body: {
            access_token: "ya29.only-an-hour",
            id_token: idToken(),
            scope: `openid email ${SHEETS_RO}`,
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "no_refresh_token" });
  });

  it("refuses a response with no ID token: nothing proves which account consented", async () => {
    await expect(
      exchange(
        stubGoogle({
          body: { refresh_token: REFRESH, scope: `openid email ${SHEETS_RO}` },
        }),
      ),
    ).rejects.toMatchObject({ code: "no_identity" });
  });
});

describe("the exchange is bounded", () => {
  /** What the module asks for, and what this test is willing to wait. */
  const EXCHANGE_TIMEOUT_MS = 10_000;
  const FAST_MS = 5;

  afterEach(() => vi.restoreAllMocks());

  /**
   * A token endpoint that accepts the request and then says nothing. It settles
   * ONLY on the caller's signal, exactly as a real `fetch` does, so an exchange
   * that passed no signal would hang this test rather than pass it.
   *
   * `AbortSignal.timeout` is armed by Node rather than through the global
   * `setTimeout` a faked clock replaces, so the module keeps asking for its real
   * ten seconds and the spy hands back five milliseconds. What is asked for is
   * asserted; everything after the abort is real.
   */
  function stalledExchange(): { asked: number[]; fetchImpl: typeof fetch } {
    const real = AbortSignal.timeout.bind(AbortSignal);
    const asked: number[] = [];
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      asked.push(ms);
      return real(FAST_MS);
    });
    const fetchImpl = ((_input: unknown, init?: RequestInit) =>
      new Promise<never>((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener("abort", () => reject(signal.reason));
      })) as typeof fetch;
    return { asked, fetchImpl };
  }

  it("refuses with a code from the closed set rather than a raw abort", async () => {
    const { asked, fetchImpl } = stalledExchange();

    const err = await exchange(fetchImpl).then(
      () => undefined,
      (e: unknown) => e,
    );

    // A `DOMException` reaching the callback would be a `store_failed` in the
    // query string and in `strad.connector_refused` — the code for "the write
    // was refused", on a flow that never got as far as a token.
    expect(err).toBeInstanceOf(ConnectorError);
    expect((err as ConnectorError).code).toBe("exchange_timed_out");
    expect((err as Error).message).toMatch(
      /timed out after 10000ms\. Nothing was written\./,
    );
    expect(asked).toEqual([EXCHANGE_TIMEOUT_MS]);
  });

  it("carries a live signal on the exchange that succeeds", async () => {
    let seen: unknown;
    const underlying = stubGoogle();
    await exchange(((input: unknown, init?: RequestInit) => {
      seen = init?.signal;
      return underlying(input as string, init);
    }) as typeof fetch);
    expect(seen).toBeInstanceOf(AbortSignal);
    expect((seen as AbortSignal).aborted).toBe(false);
  });

  it("says nothing about the code, the secret or the token when it times out", async () => {
    // The module's standing rule, applied to the new refusal: every sentence
    // here is strad's own, and this one interpolates a constant.
    const { fetchImpl } = stalledExchange();
    const message = await exchange(fetchImpl).then(
      () => "",
      (err: Error) => err.message,
    );
    expect(message).not.toBe("");
    expect(message).not.toContain(CLIENT_SECRET);
    expect(message).not.toContain("4/0AX-authorization-code");
  });
});

describe("what a refusal is allowed to say", () => {
  it("reports a failed exchange by STATUS, never by Google's own words", async () => {
    const upstream =
      "invalid_grant: the CANARY-UPSTREAM-TEXT should never be quoted";
    let caught: unknown;
    try {
      await exchange(
        stubGoogle({
          status: 400,
          body: { error: "invalid_grant", error_description: upstream },
        }),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConnectorError);
    const message = (caught as Error).message;
    expect(message).toContain("HTTP 400");
    expect(message).not.toContain("CANARY-UPSTREAM-TEXT");
    expect(message).not.toContain("invalid_grant");
  });

  it("never puts the code, the client secret or the token in a message", async () => {
    for (const stub of [
      { body: { id_token: idToken(), scope: `openid email ${SHEETS_RO}` } },
      {
        body: {
          refresh_token: REFRESH,
          id_token: idToken({ email: "someone@else.com" }),
          scope: `openid email ${SHEETS_RO}`,
        },
      },
      { status: 401, body: { error: "unauthorized_client" } },
    ]) {
      const message = await exchange(stubGoogle(stub)).then(
        () => "",
        (err: Error) => err.message,
      );
      expect(message).not.toBe("");
      expect(message).not.toContain(REFRESH);
      expect(message).not.toContain(CLIENT_SECRET);
      expect(message).not.toContain("4/0AX-authorization-code");
      expect(message).not.toContain("ya29.");
    }
  });
});
