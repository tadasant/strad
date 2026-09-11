import { describe, expect, it } from "vitest";
import {
  EnvTokenStore,
  ParameterTokenStore,
  mintToken,
  parseToken,
  parseTokenRecords,
  serializeTokenRecords,
  verifyToken,
  TOKENS_VARIABLE,
  type TokenRecord,
} from "../src/auth/tokens.ts";
import { tokenStoreFromConfig } from "../src/auth/index.ts";
import { parseConfig } from "../src/config/load.ts";
import { sharedSecretProviders } from "../src/secrets/provider/index.ts";
import type { SecretProvider } from "../src/secrets/provider/index.ts";

/**
 * `ParameterTokenStore` — the store-backed half of `/mcp` authentication.
 *
 * The reason this file is long for a 30-line class: `/mcp` authorization fails
 * OPEN if it fails wrong, and nothing downstream would notice. So every way the
 * backing can misbehave is asserted to DENY: a provider that throws, one that
 * answers nothing, one that answers something that is not a list of records, and
 * one that answers a list holding a record for the pubid but the wrong hash.
 */

/** A provider whose answer (or failure) the test chooses, per call. */
function providerOf(answer: () => string | null): SecretProvider & {
  calls: number;
} {
  const provider = {
    name: "test",
    calls: 0,
    async get(name: string): Promise<string | null> {
      provider.calls += 1;
      if (name !== TOKENS_VARIABLE) return null;
      return answer();
    },
    invalidate(): void {},
  };
  return provider;
}

const MINTED = mintToken({ env: "test", label: "probe", roles: ["admin"] });
const PAYLOAD = serializeTokenRecords([MINTED.record]);

describe("ParameterTokenStore", () => {
  it("verifies a token whose record is in the store", async () => {
    const store = new ParameterTokenStore(providerOf(() => PAYLOAD));
    const v = await verifyToken(MINTED.plaintext, store, "test");
    expect(v.ok).toBe(true);
    if (!v.ok) throw new Error("unreachable");
    expect(v.record.roles).toEqual(["admin"]);
    expect(v.record.label).toBe("probe");
  });

  it("reads LIVE: a record revoked after the first read stops verifying", async () => {
    // The whole point of this store over EnvTokenStore. The env var is read at
    // construction; this one is read per verification, so a revocation written
    // by the console lands on the very next request rather than at a redeploy.
    let payload = PAYLOAD;
    const store = new ParameterTokenStore(providerOf(() => payload));

    expect((await verifyToken(MINTED.plaintext, store, "test")).ok).toBe(true);

    payload = serializeTokenRecords([
      { ...MINTED.record, revokedAt: new Date().toISOString() },
    ]);
    expect(await verifyToken(MINTED.plaintext, store, "test")).toEqual({
      ok: false,
      reason: "revoked",
    });
  });

  it("FAILS CLOSED when the provider throws", async () => {
    const store = new ParameterTokenStore(
      providerOf(() => {
        throw new Error("parameter manager: 503 backend unavailable");
      }),
    );
    expect(await verifyToken(MINTED.plaintext, store, "test")).toEqual({
      ok: false,
      reason: "unavailable",
    });
  });

  it("FAILS CLOSED when the stored payload is not JSON", async () => {
    const store = new ParameterTokenStore(providerOf(() => "{not json"));
    expect(await verifyToken(MINTED.plaintext, store, "test")).toEqual({
      ok: false,
      reason: "unavailable",
    });
  });

  it("FAILS CLOSED when the payload is JSON but not a list of records", async () => {
    for (const payload of [
      '{"pubid":"aa"}',
      "[{}]",
      '[{"pubid":"aa","hash":"bb"}]',
      '"a string"',
    ]) {
      const store = new ParameterTokenStore(providerOf(() => payload));
      expect(await verifyToken(MINTED.plaintext, store, "test")).toEqual({
        ok: false,
        reason: "unavailable",
      });
    }
  });

  it("an EMPTY store admits nobody, and says `unknown` rather than `unavailable`", async () => {
    // Empty is a settled answer about the records; unreadable is not an answer
    // at all. Both deny, and an operator reading the logs needs them apart:
    // "mint a token" and "the store is down" are opposite responses.
    for (const payload of [null, "", "  ", "[]"]) {
      const store = new ParameterTokenStore(providerOf(() => payload));
      expect(await verifyToken(MINTED.plaintext, store, "test")).toEqual({
        ok: false,
        reason: "unknown",
      });
    }
  });

  it("a record with the right pubid and a wrong hash is a mismatch, not a pass", async () => {
    const impostor: TokenRecord = { ...MINTED.record, hash: "0".repeat(64) };
    const store = new ParameterTokenStore(
      providerOf(() => serializeTokenRecords([impostor])),
    );
    expect(await verifyToken(MINTED.plaintext, store, "test")).toEqual({
      ok: false,
      reason: "mismatch",
    });
  });

  it("a record whose hash is not a digest at all is a mismatch, never a throw", async () => {
    // `secretEquals` is length-guarded. A hand-edited record carrying a short
    // string must not become an exception on the auth path — an exception there
    // is a 500, which reads as a broken client rather than a broken record.
    const store = new ParameterTokenStore(
      providerOf(() =>
        serializeTokenRecords([{ ...MINTED.record, hash: "x" }]),
      ),
    );
    expect(await verifyToken(MINTED.plaintext, store, "test")).toEqual({
      ok: false,
      reason: "mismatch",
    });
  });

  it("a token minted for another environment is refused before the store is read", async () => {
    const provider = providerOf(() => PAYLOAD);
    const store = new ParameterTokenStore(provider);
    expect(await verifyToken(MINTED.plaintext, store, "prod")).toEqual({
      ok: false,
      reason: "wrong_env",
    });
    expect(provider.calls).toBe(0);
  });

  it("does not regress parseToken: a secret containing `_` still verifies", async () => {
    // `parseToken` splits on the first three underscores only, because the
    // base64url alphabet includes `_`. A record whose secret contains one has to
    // survive the round trip through the store as well as through the parser.
    let minted = mintToken({ env: "test", label: "u", roles: ["admin"] });
    for (
      let i = 0;
      i < 200 && !parseToken(minted.plaintext)?.secret.includes("_");
      i++
    ) {
      minted = mintToken({ env: "test", label: "u", roles: ["admin"] });
    }
    expect(parseToken(minted.plaintext)?.secret).toContain("_");

    const store = new ParameterTokenStore(
      providerOf(() => serializeTokenRecords([minted.record])),
    );
    expect((await verifyToken(minted.plaintext, store, "test")).ok).toBe(true);
  });

  it("a malformed token never reaches the store", async () => {
    const provider = providerOf(() => PAYLOAD);
    const store = new ParameterTokenStore(provider);
    for (const raw of ["", "strad_test_abc", "nope_test_abc_secret", "x"]) {
      expect(await verifyToken(raw, store, "test")).toEqual({
        ok: false,
        reason: "malformed",
      });
    }
    expect(provider.calls).toBe(0);
  });

  it("memoises the parse on the payload, and drops it when the payload changes", async () => {
    let payload = PAYLOAD;
    const provider = providerOf(() => payload);
    const store = new ParameterTokenStore(provider);

    const first = await store.list();
    const second = await store.list();
    // The provider is asked every time — the memo is over the PARSE, never over
    // the read, or a revocation would be invisible for as long as it held.
    expect(provider.calls).toBe(2);
    expect(second).toEqual(first);

    const other = mintToken({ env: "test", label: "second", roles: [] });
    payload = serializeTokenRecords([MINTED.record, other.record]);
    expect((await store.list()).map((r) => r.label)).toEqual([
      "probe",
      "second",
    ]);
  });
});

describe("record codec", () => {
  it("round-trips through serialize/parse", () => {
    const records = [MINTED.record, { ...MINTED.record, pubid: "beefbeef" }];
    expect(parseTokenRecords(serializeTokenRecords(records))).toEqual(records);
  });

  it("is the SAME codec both stores read, so one backing can read the other's payload", () => {
    // The migration rests on this: `env` and `parameter-store` differ only in
    // where the bytes come from. A record written by the console must verify
    // against a gateway still reading the environment variable, and vice versa.
    const payload = serializeTokenRecords([MINTED.record]);
    const fromEnv = new EnvTokenStore(payload);
    const fromStore = new ParameterTokenStore(providerOf(() => payload));
    return Promise.all([
      verifyToken(MINTED.plaintext, fromEnv, "test"),
      verifyToken(MINTED.plaintext, fromStore, "test"),
    ]).then(([a, b]) => {
      expect(a.ok).toBe(true);
      expect(b.ok).toBe(true);
    });
  });

  it("defaults the label to the pubid and revokedAt to null", () => {
    const [record] = parseTokenRecords(
      '[{"pubid":"aa","hash":"bb","roles":[]}]',
    );
    expect(record).toEqual({
      pubid: "aa",
      label: "aa",
      hash: "bb",
      roles: [],
      revokedAt: null,
      createdAt: undefined,
    });
  });
});

describe("tokenStoreFromConfig", () => {
  const base = `
version: 1
gateway:
  env: test
  secrets: { provider: gcp-parameter-store }
roles: { admin: { servers: ["*"] } }
`;

  it('builds a ParameterTokenStore for store: "parameter-store"', async () => {
    const config = parseConfig(
      `${base}auth: { staticTokens: { enabled: true, store: parameter-store } }`,
    );
    const store = tokenStoreFromConfig(
      config,
      {},
      sharedSecretProviders(providerOf(() => PAYLOAD)),
    );
    expect(store).toBeInstanceOf(ParameterTokenStore);
    expect((await store.list()).map((r) => r.pubid)).toEqual([
      MINTED.record.pubid,
    ]);
  });

  it('builds an EnvTokenStore for store: "env", ignoring the providers', async () => {
    const config = parseConfig(
      `${base.replace("gcp-parameter-store", "env")}auth: { staticTokens: { enabled: true } }`,
    );
    const store = tokenStoreFromConfig(
      config,
      { STRAD_TOKENS: PAYLOAD },
      sharedSecretProviders(providerOf(() => "[]")),
    );
    expect(store).toBeInstanceOf(EnvTokenStore);
    expect((await store.list()).length).toBe(1);
  });

  it("FAILS CLOSED when the parameter store is asked for and no provider is supplied", async () => {
    // The dangerous shape: a config that says "parameter-store" built by a call
    // site that has no provider. Falling back to the env var would serve the
    // BAKED records to a deployment that believes it is serving revocations.
    const config = parseConfig(
      `${base}auth: { staticTokens: { enabled: true, store: parameter-store } }`,
    );
    const store = tokenStoreFromConfig(config, { STRAD_TOKENS: PAYLOAD });
    expect(await store.list()).toEqual([]);
    expect(await verifyToken(MINTED.plaintext, store, "test")).toEqual({
      ok: false,
      reason: "unknown",
    });
  });

  it("staticTokens.enabled: false admits nobody under either backing", async () => {
    for (const store of ["env", "parameter-store"] as const) {
      const config = parseConfig(
        `${base}auth: { staticTokens: { enabled: false, store: ${store} } }`,
      );
      const built = tokenStoreFromConfig(
        config,
        { STRAD_TOKENS: PAYLOAD },
        sharedSecretProviders(providerOf(() => PAYLOAD)),
      );
      expect(await built.list()).toEqual([]);
    }
  });
});

describe("the config gate", () => {
  it("refuses store: parameter-store without a parameter store to read it from", () => {
    expect(() =>
      parseConfig(`
version: 1
gateway: { env: test }
auth: { staticTokens: { enabled: true, store: parameter-store } }
roles: { admin: { servers: ["*"] } }
`),
    ).toThrow(/gateway\.secrets\.provider/);
  });
});
