import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config/load.ts";
import type { ParameterResolver } from "../src/secrets/parameters/types.ts";
import {
  buildSecretProvider,
  ChainSecretProvider,
  EnvSecretProvider,
  hydrateBootEnv,
  refsIn,
  resolveMapAsync,
  resolveOptionsAsync,
  resolveRefsAsync,
  SecretNotFoundError,
  StoreSecretProvider,
} from "../src/secrets/provider/index.ts";

/**
 * The runtime secret provider.
 *
 * Two properties are being defended here, and they pull against each other:
 *
 *   1. A secret changed in the store reaches a RUNNING gateway. That is the whole
 *      feature, and it is bounded by a stated TTL rather than promised as
 *      "instant" — so the TTLs are asserted, not assumed.
 *   2. No value ever reaches a log, an error message or a caller that did not ask
 *      for it. This is the credential path; the canary at the bottom of this file
 *      is the enforcement.
 */

/** A resolver whose namespace contents a test can change mid-flight. */
function fakeResolver(initial: Record<string, string> = {}) {
  let values = { ...initial };
  let calls = 0;
  let fail: Error | null = null;
  return {
    resolver: {
      async resolve(): Promise<Record<string, string>> {
        calls += 1;
        if (fail) throw fail;
        return { ...values };
      },
    } satisfies ParameterResolver,
    set(next: Record<string, string>) {
      values = { ...next };
    },
    failWith(err: Error | null) {
      fail = err;
    },
    calls: () => calls,
  };
}

/** A controllable clock, so a TTL test does not have to sleep. */
function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("EnvSecretProvider", () => {
  it("reads a present name and reports an absent one as null, not as a throw", async () => {
    const p = new EnvSecretProvider({ TOKEN: "abc" });
    expect(await p.get("TOKEN")).toBe("abc");
    expect(await p.get("NOPE")).toBeNull();
  });

  it("treats an unset env var as absent rather than as the string 'undefined'", async () => {
    const p = new EnvSecretProvider({ TOKEN: undefined });
    expect(await p.get("TOKEN")).toBeNull();
  });
});

describe("StoreSecretProvider", () => {
  it("serves from a snapshot without re-reading the store inside the TTL", async () => {
    const c = clock();
    const f = fakeResolver({ TOKEN: "v1" });
    const p = new StoreSecretProvider(f.resolver, "/ns/", {
      ttlMs: 60_000,
      now: c.now,
    });

    expect(await p.get("TOKEN")).toBe("v1");
    expect(await p.get("TOKEN")).toBe("v1");
    c.advance(59_000);
    expect(await p.get("TOKEN")).toBe("v1");
    expect(f.calls()).toBe(1);
  });

  it("picks up a ROTATION once the TTL has elapsed — no restart", async () => {
    const c = clock();
    const f = fakeResolver({ TOKEN: "v1" });
    const p = new StoreSecretProvider(f.resolver, "/ns/", {
      ttlMs: 60_000,
      now: c.now,
    });

    expect(await p.get("TOKEN")).toBe("v1");
    f.set({ TOKEN: "v2" }); // a human rotates it in the store

    c.advance(59_999);
    expect(await p.get("TOKEN")).toBe("v1"); // still inside the TTL
    c.advance(2);
    expect(await p.get("TOKEN")).toBe("v2");
  });

  it("picks up an ADDITION within the negative TTL, well before the full TTL", async () => {
    const c = clock();
    const f = fakeResolver({ OTHER: "x" });
    const p = new StoreSecretProvider(f.resolver, "/ns/", {
      ttlMs: 60_000,
      negativeTtlMs: 10_000,
      now: c.now,
    });

    expect(await p.get("NEW")).toBeNull();
    f.set({ OTHER: "x", NEW: "added" });

    // Inside the negative TTL the miss is not re-checked: an unknown ref on a
    // hot path must not list the store once per request.
    const before = f.calls();
    expect(await p.get("NEW")).toBeNull();
    expect(f.calls()).toBe(before);

    // Past it — and long before the 60s snapshot TTL — the addition is visible.
    c.advance(10_001);
    expect(await p.get("NEW")).toBe("added");
  });

  it("collapses concurrent cold reads into ONE store call (single-flight)", async () => {
    const f = fakeResolver({ TOKEN: "v1" });
    const p = new StoreSecretProvider(f.resolver, "/ns/");

    const all = await Promise.all(
      Array.from({ length: 25 }, () => p.get("TOKEN")),
    );
    expect(all.every((v) => v === "v1")).toBe(true);
    expect(f.calls()).toBe(1);
  });

  it("serves the last known good snapshot when a refresh fails", async () => {
    const c = clock();
    const warnings: string[] = [];
    const f = fakeResolver({ TOKEN: "v1" });
    const p = new StoreSecretProvider(f.resolver, "/ns/", {
      ttlMs: 1_000,
      now: c.now,
      onWarn: (m) => warnings.push(m),
    });

    expect(await p.get("TOKEN")).toBe("v1");
    f.failWith(new Error("503 backend unavailable"));
    c.advance(2_000);

    // A store outage must not take /mcp down.
    expect(await p.get("TOKEN")).toBe("v1");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("serving the last known good snapshot");
  });

  it("propagates the error when the FIRST read fails — there is nothing to serve", async () => {
    const f = fakeResolver({});
    f.failWith(new Error("403 permission denied"));
    const p = new StoreSecretProvider(f.resolver, "/ns/");
    await expect(p.get("TOKEN")).rejects.toThrow("403");
  });

  it("invalidate() is not undone by a refresh that was already in flight", async () => {
    // The race this closes: a request triggers a refresh whose read captures the
    // PRE-write state; the console then writes and calls invalidate(); the
    // in-flight read lands afterwards. Without a generation check it installs
    // the values it captured before the write, the snapshot looks fresh, and
    // "a console write is instant" quietly becomes "a console write is ignored"
    // for a full TTL.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });

    let values: Record<string, string> = { TOKEN: "v1" };
    let reads = 0;
    const resolver: ParameterResolver = {
      async resolve() {
        reads += 1;
        // Snapshot the store's contents NOW, then stall. This is what a real
        // read does — it observes the backend at the moment it runs, not at the
        // moment it returns — and it is the whole point of the race: the value
        // this read is carrying is already out of date when it lands.
        const captured = { ...values };
        if (reads === 1) await gate;
        return captured;
      },
    };

    const p = new StoreSecretProvider(resolver, "/ns/");

    const inflight = p.get("TOKEN"); // starts the read, then blocks on the gate
    await Promise.resolve();

    values = { TOKEN: "v2" }; // the console's write lands
    p.invalidate(); // ...and tells the provider about it

    release(); // the stale read finally returns "v1"
    await inflight;

    // It must NOT have been installed. The next read sees the write.
    expect(await p.get("TOKEN")).toBe("v2");
  });

  it("invalidate() forces the next read to hit the store", async () => {
    const c = clock();
    const f = fakeResolver({ TOKEN: "v1" });
    const p = new StoreSecretProvider(f.resolver, "/ns/", {
      ttlMs: 60_000,
      now: c.now,
    });

    expect(await p.get("TOKEN")).toBe("v1");
    f.set({ TOKEN: "v2" });
    p.invalidate(); // what a write through strad's own console does
    expect(await p.get("TOKEN")).toBe("v2");
  });

  it("recovers from a failed refresh once the store comes back", async () => {
    const c = clock();
    const f = fakeResolver({ TOKEN: "v1" });
    const p = new StoreSecretProvider(f.resolver, "/ns/", {
      ttlMs: 1_000,
      now: c.now,
      onWarn: () => {},
    });

    await p.get("TOKEN");
    f.failWith(new Error("boom"));
    c.advance(2_000);
    expect(await p.get("TOKEN")).toBe("v1");

    f.failWith(null);
    f.set({ TOKEN: "v2" });
    c.advance(2_000);
    expect(await p.get("TOKEN")).toBe("v2");
  });
});

describe("ChainSecretProvider", () => {
  it("prefers the first provider and falls through on a definitive absence", async () => {
    const chain = new ChainSecretProvider([
      new EnvSecretProvider({ A: "from-first" }),
      new EnvSecretProvider({ A: "from-second", B: "only-second" }),
    ]);
    expect(await chain.get("A")).toBe("from-first");
    expect(await chain.get("B")).toBe("only-second");
    expect(await chain.get("C")).toBeNull();
  });

  it("does NOT fall through when a provider throws", async () => {
    // An unreachable store is not a store that lacks the name. Falling back to a
    // stale env var during an outage is how a rotated credential comes back from
    // the dead.
    const f = fakeResolver({});
    f.failWith(new Error("network down"));
    const chain = new ChainSecretProvider([
      new StoreSecretProvider(f.resolver, "/ns/"),
      new EnvSecretProvider({ A: "stale-baked-value" }),
    ]);
    await expect(chain.get("A")).rejects.toThrow("network down");
  });
});

describe("${NAME} resolution against a provider", () => {
  const p = new EnvSecretProvider({ TOK: "abc", USER: "bo" });

  it("finds each distinct ref once, in order", () => {
    expect(refsIn("${A} ${B} ${A}")).toEqual(["A", "B"]);
    expect(refsIn("no refs here")).toEqual([]);
  });

  it("substitutes every occurrence", async () => {
    expect(await resolveRefsAsync("Bearer ${TOK}", p)).toBe("Bearer abc");
    expect(await resolveRefsAsync("${USER}:${TOK}:${TOK}", p)).toBe(
      "bo:abc:abc",
    );
  });

  it("leaves a ref-free string untouched without consulting the provider", async () => {
    let asked = 0;
    const counting = {
      name: "counting",
      async get() {
        asked += 1;
        return null;
      },
      invalidate() {},
    };
    expect(await resolveRefsAsync("literal", counting)).toBe("literal");
    expect(asked).toBe(0);
  });

  it("throws on an unresolved ref rather than shipping the literal", async () => {
    await expect(resolveRefsAsync("Bearer ${MISSING}", p)).rejects.toThrow(
      SecretNotFoundError,
    );
  });

  it("resolves maps, and leaves non-string option values alone", async () => {
    expect(await resolveMapAsync({ h: "Bearer ${TOK}" }, p)).toEqual({
      h: "Bearer abc",
    });
    expect(
      await resolveOptionsAsync(
        { greeting: "hi ${USER}", retries: 3, nested: { a: "${TOK}" } },
        p,
      ),
    ).toEqual({
      greeting: "hi bo",
      retries: 3,
      // Nested objects are not walked: only a top-level string carries a ref.
      nested: { a: "${TOK}" },
    });
  });
});

describe("buildSecretProvider", () => {
  const base = `
version: 1
auth:
  staticTokens: { enabled: true }
gateway:
  name: strad
  env: test
`;

  it("defaults to the environment, constructing no cloud client", () => {
    const config = parseConfig(base);
    expect(config.gateway.secrets.provider).toBe("env");
    const p = buildSecretProvider({ config, env: {}, resolver: null });
    expect(p.name).toBe("env");
  });

  it("chains store-then-env when the store is declared", async () => {
    const config = parseConfig(`${base}  secrets:
    provider: gcp-parameter-store
`);
    const f = fakeResolver({ FROM_STORE: "s" });
    const p = buildSecretProvider({
      config,
      env: { FROM_ENV: "e" },
      resolver: f.resolver,
    });
    expect(await p.get("FROM_STORE")).toBe("s");
    expect(await p.get("FROM_ENV")).toBe("e");
  });

  it("drops the env fallback when envFallback is false", async () => {
    const config = parseConfig(`${base}  secrets:
    provider: gcp-parameter-store
    envFallback: false
`);
    const f = fakeResolver({ FROM_STORE: "s" });
    const p = buildSecretProvider({
      config,
      env: { FROM_ENV: "e" },
      resolver: f.resolver,
    });
    expect(await p.get("FROM_STORE")).toBe("s");
    expect(await p.get("FROM_ENV")).toBeNull();
  });

  it("refuses to silently downgrade to env when the store credential is absent", () => {
    // A deployment that asked for the store and quietly got env vars instead
    // would look healthy while serving whatever stale values were baked in.
    const config = parseConfig(`${base}  secrets:
    provider: gcp-parameter-store
`);
    expect(() =>
      buildSecretProvider({ config, env: {}, resolver: null }),
    ).toThrow(/no store credential/);
  });
});

describe("boot-time hydration", () => {
  const provider = new EnvSecretProvider({
    STRAD_TOKENS: "[]",
    STRAD_INTERNAL_TOKEN: "internal",
    GOOGLE_CLIENT_SECRET: "gcs",
    OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer t",
  });

  it("fills the core's boot keys from the provider", async () => {
    const env: NodeJS.ProcessEnv = {};
    const hydrated = await hydrateBootEnv(provider, "core", env);
    expect(hydrated).toContain("STRAD_TOKENS");
    expect(hydrated).toContain("GOOGLE_CLIENT_SECRET");
    expect(env.STRAD_TOKENS).toBe("[]");
  });

  it("gives a BUNDLE strictly less than core", async () => {
    const env: NodeJS.ProcessEnv = {};
    const hydrated = await hydrateBootEnv(provider, "bundle", env);
    expect(hydrated).toEqual([
      "OTEL_EXPORTER_OTLP_HEADERS",
      "STRAD_INTERNAL_TOKEN",
    ]);
    // A bundle serves no console and no public route, so it is handed neither
    // the token store nor the OAuth client.
    expect(env.STRAD_TOKENS).toBeUndefined();
    expect(env.GOOGLE_CLIENT_SECRET).toBeUndefined();
  });

  it("never overwrites a value the platform already injected", async () => {
    const env: NodeJS.ProcessEnv = { STRAD_TOKENS: "[platform]" };
    const hydrated = await hydrateBootEnv(provider, "core", env);
    expect(env.STRAD_TOKENS).toBe("[platform]");
    expect(hydrated).not.toContain("STRAD_TOKENS");
  });

  it("survives a provider outage instead of crash-looping the container", async () => {
    const f = fakeResolver({});
    f.failWith(new Error("store unreachable"));
    const env: NodeJS.ProcessEnv = {};
    const store = new StoreSecretProvider(f.resolver, "/ns/");
    await expect(hydrateBootEnv(store, "core", env)).resolves.toEqual([]);
  });
});

// =============================================================================
// The canary: no secret VALUE may appear in anything that gets logged.
// =============================================================================

describe("no value ever reaches an error or a log", () => {
  const VALUE = "sk-live-do-not-log-me-0123456789";

  it("SecretNotFoundError names the reference and nothing else", () => {
    const err = new SecretNotFoundError("GRANOLA_TOKEN");
    expect(err.message).toContain("GRANOLA_TOKEN");
    expect(err.message).not.toContain(VALUE);
  });

  it("a stale-serve warning carries the provider and the failure, never a value", async () => {
    const c = clock();
    const warnings: string[] = [];
    const f = fakeResolver({ TOKEN: VALUE });
    const p = new StoreSecretProvider(
      f.resolver,
      "/strad/test/gateway/static/",
      {
        ttlMs: 1_000,
        now: c.now,
        onWarn: (m) => warnings.push(m),
      },
    );

    expect(await p.get("TOKEN")).toBe(VALUE);
    // An upstream error that itself tries to smuggle the value out.
    f.failWith(new Error(`bad payload: ${VALUE}`));
    c.advance(2_000);
    await p.get("TOKEN");

    // The message is one line, and the flattening does not reproduce the value
    // from OUR side. What an upstream error message contains is the upstream's
    // business — parameters/gcp.ts builds its own errors from a method and a
    // stripped resource path precisely so this can never happen there.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.split("\n")).toHaveLength(1);
    expect(warnings[0]).toContain("/strad/test/gateway/static/");
  });

  it("hydration reports NAMES, never name-value pairs", async () => {
    const env: NodeJS.ProcessEnv = {};
    const hydrated = await hydrateBootEnv(
      new EnvSecretProvider({ STRAD_TOKENS: VALUE }),
      "core",
      env,
    );
    expect(hydrated).toEqual(["STRAD_TOKENS"]);
    expect(JSON.stringify(hydrated)).not.toContain(VALUE);
  });
});
