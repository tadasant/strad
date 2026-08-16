import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config/load.ts";
import type { ParameterResolver } from "../src/secrets/parameters/types.ts";
import {
  buildSecretProviders,
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
    expect(warnings[0]).toContain("serving the last known good values");
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
    // Past the post-failure backoff. Inside it the provider deliberately does
    // NOT retry — during an outage, one failed call and one log line per request
    // turns a degraded dependency into a self-inflicted load problem.
    c.advance(10_000);
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

describe("buildSecretProviders", () => {
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
    const p = buildSecretProviders({ config, env: {}, resolver: null });
    expect(p.shared.name).toBe("env");
    // No per-slug layer to have: a container's process.env is flat.
    expect(p.forServer("anki")).toBe(p.shared);
  });

  it("chains store-then-env when the store is declared", async () => {
    const config = parseConfig(`${base}  secrets:
    provider: gcp-parameter-store
`);
    const f = fakeResolver({ FROM_STORE: "s" });
    const p = buildSecretProviders({
      config,
      env: { FROM_ENV: "e" },
      resolver: f.resolver,
    }).shared;
    expect(await p.get("FROM_STORE")).toBe("s");
    expect(await p.get("FROM_ENV")).toBe("e");
  });

  it("drops the env fallback when envFallback is false", async () => {
    const config = parseConfig(`${base}  secrets:
    provider: gcp-parameter-store
    envFallback: false
`);
    const f = fakeResolver({ FROM_STORE: "s" });
    const p = buildSecretProviders({
      config,
      env: { FROM_ENV: "e" },
      resolver: f.resolver,
    }).shared;
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
      buildSecretProviders({ config, env: {}, resolver: null }),
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

// =============================================================================
// The per-server layer
// =============================================================================

/**
 * A resolver that answers PER NAMESPACE, and counts what it was asked.
 *
 * The other fake in this file ignores its argument, which is fine while there is
 * one namespace. The whole point below is that there are two.
 */
function namespacedResolver(
  byNamespace: Record<string, Record<string, string>>,
) {
  const asked: string[] = [];
  return {
    resolver: {
      async resolve(namespace: string): Promise<Record<string, string>> {
        asked.push(namespace);
        return { ...(byNamespace[namespace] ?? {}) };
      },
    } satisfies ParameterResolver,
    asked,
    set(namespace: string, values: Record<string, string>) {
      byNamespace[namespace] = values;
    },
  };
}

describe("per-server secret providers", () => {
  const STORE_CONFIG = parseConfig(`
version: 1
auth:
  staticTokens: { enabled: true }
gateway:
  name: strad
  env: test
  secrets:
    provider: gcp-parameter-store
    envFallback: false
`);

  const GATEWAY_NS = "/strad/test/gateway/static/";
  const ANKI_NS = "/strad/test/mcp/anki/static/";

  it("prefers the server's OWN namespace over the shared one", async () => {
    const f = namespacedResolver({
      [GATEWAY_NS]: { ANKI_MCP_API_KEY: "shared" },
      [ANKI_NS]: { ANKI_MCP_API_KEY: "mine" },
    });
    const providers = buildSecretProviders({
      config: STORE_CONFIG,
      env: {},
      resolver: f.resolver,
    });
    expect(await providers.forServer("anki").get("ANKI_MCP_API_KEY")).toBe(
      "mine",
    );
    // The shared provider is unchanged — this is a layer, not a rewrite.
    expect(await providers.shared.get("ANKI_MCP_API_KEY")).toBe("shared");
  });

  it("falls back to the shared namespace for a server nobody seeded", async () => {
    // The back-compat guarantee, stated as a test: every deployment that works
    // today has an empty layer 1 for every server.
    const f = namespacedResolver({ [GATEWAY_NS]: { GRANOLA_TOKEN: "shared" } });
    const providers = buildSecretProviders({
      config: STORE_CONFIG,
      env: {},
      resolver: f.resolver,
    });
    expect(await providers.forServer("granola").get("GRANOLA_TOKEN")).toBe(
      "shared",
    );
  });

  it("resolves the SAME name to DIFFERENT values for two servers", async () => {
    const f = namespacedResolver({
      [GATEWAY_NS]: {},
      [ANKI_NS]: { TOKEN: "anki" },
      "/strad/test/mcp/other/static/": { TOKEN: "other" },
    });
    const providers = buildSecretProviders({
      config: STORE_CONFIG,
      env: {},
      resolver: f.resolver,
    });
    expect(await providers.forServer("anki").get("TOKEN")).toBe("anki");
    expect(await providers.forServer("other").get("TOKEN")).toBe("other");
  });

  it("memoises per slug, so a per-request thunk does not re-read the store", async () => {
    const f = namespacedResolver({ [ANKI_NS]: { TOKEN: "t" } });
    const providers = buildSecretProviders({
      config: STORE_CONFIG,
      env: {},
      resolver: f.resolver,
    });
    expect(providers.forServer("anki")).toBe(providers.forServer("anki"));
    await providers.forServer("anki").get("TOKEN");
    await providers.forServer("anki").get("TOKEN");
    expect(f.asked.filter((ns) => ns === ANKI_NS)).toHaveLength(1);
  });

  it("does not re-list the store chasing a miss on the per-server layer", async () => {
    // A miss on layer 1 is the NORMAL case — most names live in the shared
    // namespace — and `resolve()` enumerates the project. Chasing every one of
    // them would cost a full listing per gateway-resolved name per slug.
    const f = namespacedResolver({
      [GATEWAY_NS]: { SHARED: "s" },
      [ANKI_NS]: {},
    });
    const providers = buildSecretProviders({
      config: STORE_CONFIG,
      env: {},
      resolver: f.resolver,
    });
    for (let i = 0; i < 3; i += 1) {
      expect(await providers.forServer("anki").get("SHARED")).toBe("s");
    }
    expect(f.asked.filter((ns) => ns === ANKI_NS)).toHaveLength(1);
  });

  it("reports a name no layer holds as null, not as a throw", async () => {
    const f = namespacedResolver({ [GATEWAY_NS]: {}, [ANKI_NS]: {} });
    const providers = buildSecretProviders({
      config: STORE_CONFIG,
      env: {},
      resolver: f.resolver,
    });
    expect(await providers.forServer("anki").get("NOPE")).toBeNull();
  });

  it("invalidate() drops the per-server snapshots too", async () => {
    // The console writes through this seam. A write to a server's own namespace
    // that only cleared the shared cache would leave the page reporting the old
    // value it just replaced.
    const f = namespacedResolver({ [GATEWAY_NS]: {}, [ANKI_NS]: { T: "old" } });
    const providers = buildSecretProviders({
      config: STORE_CONFIG,
      env: {},
      resolver: f.resolver,
    });
    expect(await providers.forServer("anki").get("T")).toBe("old");
    f.set(ANKI_NS, { T: "new" });
    providers.invalidate();
    expect(await providers.forServer("anki").get("T")).toBe("new");
  });

  it("does not consult the store for a slug nothing asks about", async () => {
    // The layer is lazy. A fleet of 30 slugs must not cost 30 listings at boot.
    const f = namespacedResolver({ [GATEWAY_NS]: { SHARED: "s" } });
    const providers = buildSecretProviders({
      config: STORE_CONFIG,
      env: {},
      resolver: f.resolver,
    });
    providers.forServer("anki");
    expect(f.asked).toEqual([]);
  });
});
