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

/**
 * A resolver whose namespace contents a test can change mid-flight.
 *
 * It models the store CLIENT, snapshot and all: `resolve()` answers from what
 * it holds until `forget()` is called, exactly as parameters/gcp.ts does inside
 * its TTL. `reads` counts the times it went to the "store" — the number the
 * provider is supposed to keep small — and `resolves` the times it was asked
 * at all, which is one per `get` and is not the thing being defended.
 */
function fakeResolver(initial: Record<string, string> = {}) {
  let values = { ...initial };
  let held: Record<string, string> | undefined;
  let heldAt = -Infinity;
  let reads = 0;
  let resolves = 0;
  let fail: Error | null = null;
  let clock = () => 0;
  return {
    resolver: {
      async resolve(): Promise<Record<string, string>> {
        resolves += 1;
        if (!held) {
          reads += 1;
          if (fail) throw fail;
          held = { ...values };
          heldAt = clock();
        }
        return { ...held };
      },
      forget() {
        held = undefined;
      },
      snapshotAgeMs() {
        return held ? clock() - heldAt : Infinity;
      },
    } satisfies ParameterResolver,
    /** Change the STORE. The held reading does not move until it is dropped. */
    set(next: Record<string, string>) {
      values = { ...next };
    },
    /** Change the store AND drop the reading — what a write through the client does. */
    write(next: Record<string, string>) {
      values = { ...next };
      held = undefined;
    },
    failWith(err: Error | null) {
      fail = err;
      if (err) held = undefined;
    },
    onClock(now: () => number) {
      clock = now;
    },
    reads: () => reads,
    resolves: () => resolves,
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
  it("re-slices the resolver's reading on every get, and never re-reads the store on its own", async () => {
    // The provider holds no TTL. How long a value is reused is the store
    // client's decision (parameters/gcp.ts), and a second timer here would only
    // smear that bound. So: many gets, one store read.
    const f = fakeResolver({ TOKEN: "v1" });
    const p = new StoreSecretProvider(f.resolver, "/ns/");

    expect(await p.get("TOKEN")).toBe("v1");
    expect(await p.get("TOKEN")).toBe("v1");
    expect(await p.get("TOKEN")).toBe("v1");
    expect(f.reads()).toBe(1);
    expect(f.resolves()).toBe(3);
  });

  it("serves the reading the resolver holds until the resolver drops it", async () => {
    const f = fakeResolver({ TOKEN: "v1" });
    const p = new StoreSecretProvider(f.resolver, "/ns/");

    expect(await p.get("TOKEN")).toBe("v1");
    f.set({ TOKEN: "v2" }); // rotated outside strad; nothing told this process
    expect(await p.get("TOKEN")).toBe("v1");

    f.resolver.forget(); // what the store client does when its TTL elapses
    expect(await p.get("TOKEN")).toBe("v2");
  });

  it("picks up an ADDITION within the negative TTL by dropping the reading", async () => {
    const c = clock();
    const f = fakeResolver({ OTHER: "x" });
    f.onClock(c.now);
    const p = new StoreSecretProvider(f.resolver, "/ns/", {
      negativeTtlMs: 10_000,
      now: c.now,
    });

    expect(await p.get("NEW")).toBeNull();
    f.set({ OTHER: "x", NEW: "added" });

    // Inside the negative TTL the miss is not chased: an unknown ref on a hot
    // path must not re-read the store once per request.
    const before = f.reads();
    expect(await p.get("NEW")).toBeNull();
    expect(f.reads()).toBe(before);

    // Past it, the reading is dropped and the addition is visible.
    c.advance(10_001);
    expect(await p.get("NEW")).toBe("added");
    expect(f.reads()).toBe(before + 1);
  });

  it("does not chase a miss against a reading younger than the negative TTL", async () => {
    // On a cold start the get has just read the store. A name it did not hold
    // a moment ago is not going to be found by reading it again.
    const c = clock();
    const f = fakeResolver({ OTHER: "x" });
    f.onClock(c.now);
    const p = new StoreSecretProvider(f.resolver, "/ns/", {
      negativeTtlMs: 10_000,
      now: c.now,
    });

    expect(await p.get("NOPE")).toBeNull();
    expect(f.reads()).toBe(1);
    c.advance(5_000);
    expect(await p.get("NOPE")).toBeNull();
    expect(f.reads()).toBe(1);
  });

  it("collapses concurrent cold reads into ONE store call (single-flight)", async () => {
    const f = fakeResolver({ TOKEN: "v1" });
    const p = new StoreSecretProvider(f.resolver, "/ns/");

    const all = await Promise.all(
      Array.from({ length: 25 }, () => p.get("TOKEN")),
    );
    expect(all.every((v) => v === "v1")).toBe(true);
    expect(f.resolves()).toBe(1);
  });

  it("serves the last known good values when a read fails", async () => {
    const c = clock();
    const warnings: string[] = [];
    const f = fakeResolver({ TOKEN: "v1" });
    const p = new StoreSecretProvider(f.resolver, "/ns/", {
      now: c.now,
      onWarn: (m) => warnings.push(m),
    });

    expect(await p.get("TOKEN")).toBe("v1");
    f.failWith(new Error("503 backend unavailable"));

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

  it("invalidate() is not undone by a read that was already in flight", async () => {
    // The race this closes: a request triggers a read whose result captures the
    // PRE-write state; the console then writes and calls invalidate(); the
    // in-flight read lands afterwards. Without a generation check it installs
    // the values it captured before the write as the last known good map, and
    // "a console write is instant" quietly becomes "a console write is ignored"
    // the next time the store hiccups.
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

    // It must NOT have been installed — and the caller whose read was
    // discarded is not handed nothing either: it re-reads and gets the write.
    expect(await inflight).toBe("v2");
    expect(await p.get("TOKEN")).toBe("v2");
  });

  it("a read discarded by invalidate() re-reads rather than reporting a miss, even with no miss-chase", async () => {
    // The per-server layer is built with `negativeTtlMs: Infinity`, so a miss
    // there is never chased: an empty map handed to the raced caller would be
    // read as "not in this server's namespace", fall through to the gateway's,
    // and turn a live per-server credential into a SecretNotFoundError on that
    // one request — precisely when a console write is what raced it.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let values: Record<string, string> = { TOKEN: "v1" };
    let reads = 0;
    const resolver: ParameterResolver = {
      async resolve() {
        reads += 1;
        const captured = { ...values };
        if (reads === 1) await gate;
        return captured;
      },
    };
    const p = new StoreSecretProvider(resolver, "/ns/", {
      negativeTtlMs: Infinity,
    });

    const inflight = p.get("TOKEN");
    await Promise.resolve();
    values = { TOKEN: "v2" };
    p.invalidate();
    release();

    expect(await inflight).toBe("v2");
    // Exactly one extra read, for the caller that was raced — not a loop.
    expect(reads).toBe(2);
    expect(await p.get("TOKEN")).toBe("v2");
    expect(reads).toBe(3);
  });

  it("invalidate() drops the resolver's reading, so the next get reaches the store", async () => {
    const f = fakeResolver({ TOKEN: "v1" });
    const p = new StoreSecretProvider(f.resolver, "/ns/");

    expect(await p.get("TOKEN")).toBe("v1");
    f.set({ TOKEN: "v2" });
    p.invalidate(); // what a write through strad's own console does
    expect(await p.get("TOKEN")).toBe("v2");
    expect(f.reads()).toBe(2);
  });

  it("recovers from a failed read once the store comes back", async () => {
    const c = clock();
    const f = fakeResolver({ TOKEN: "v1" });
    const p = new StoreSecretProvider(f.resolver, "/ns/", {
      now: c.now,
      onWarn: () => {},
    });

    await p.get("TOKEN");
    f.failWith(new Error("boom"));
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

/**
 * The read with nothing to fall back on, and why one failure of it is not the
 * answer (tadasant/strad#523).
 *
 * `invalidate()` drops the last known good map — it has to, or a write would be
 * ignored the next time the store hiccups. So the read straight after a write
 * is a read with nothing held, exactly like a cold start, and the gateway's
 * token store reads through it on the `/mcp` request path. One transient
 * failure there was a 500. It is retried now, within a stated budget, and only
 * a store that STAYS unreadable propagates.
 */
describe("StoreSecretProvider, a read with nothing held", () => {
  /** A resolver that fails its next `n` reads, then answers. */
  function flaky(values: Record<string, string>) {
    let failNext = 0;
    let reads = 0;
    let current = { ...values };
    const resolver: ParameterResolver = {
      async resolve() {
        reads += 1;
        if (failNext > 0) {
          failNext -= 1;
          throw new Error("fetch failed: ECONNRESET");
        }
        return { ...current };
      },
    };
    return {
      resolver,
      failNext: (n: number) => (failNext = n),
      set: (next: Record<string, string>) => (current = { ...next }),
      reads: () => reads,
    };
  }

  const noSleep = () => {
    const slept: number[] = [];
    return {
      slept,
      sleep: async (ms: number) => {
        slept.push(ms);
      },
    };
  };

  it("a write, then invalidate, then ONE failed read: the get still answers, with the write", async () => {
    const f = flaky({ TOKEN: "v1" });
    const warnings: string[] = [];
    const s = noSleep();
    const p = new StoreSecretProvider(f.resolver, "/ns/", {
      onWarn: (m) => warnings.push(m),
      sleep: s.sleep,
      random: () => 0,
    });

    expect(await p.get("TOKEN")).toBe("v1");
    f.set({ TOKEN: "v2" }); // the write lands
    p.invalidate(); // ...and the writer says so
    f.failNext(1); // the read after it fails once

    expect(await p.get("TOKEN")).toBe("v2");
    expect(f.reads()).toBe(3);
    expect(s.slept).toEqual([100]); // equal jitter, random 0: half the 200ms term
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("with nothing held; retrying in 100ms");
    expect(warnings[0]).toContain("attempt 2 of 3");
  });

  it("a cold start whose first read fails once still answers", async () => {
    const f = flaky({ TOKEN: "v1" });
    f.failNext(1);
    const s = noSleep();
    const p = new StoreSecretProvider(f.resolver, "/ns/", {
      onWarn: () => {},
      sleep: s.sleep,
    });
    expect(await p.get("TOKEN")).toBe("v1");
    expect(f.reads()).toBe(2);
  });

  it("a store that STAYS unreadable still propagates, after the budget and no more", async () => {
    const f = flaky({ TOKEN: "v1" });
    const s = noSleep();
    const p = new StoreSecretProvider(f.resolver, "/ns/", {
      onWarn: () => {},
      sleep: s.sleep,
      random: () => 0.5,
    });
    await p.get("TOKEN");
    p.invalidate();
    f.failNext(Infinity);

    await expect(p.get("TOKEN")).rejects.toThrow("ECONNRESET");
    // One read for the cold start; three for the invalidated get. The `get`
    // does NOT re-read once more on top: a failed read leaves nothing
    // discarded, only nothing held.
    expect(f.reads()).toBe(4);
    expect(s.slept).toEqual([150, 300]);
    // And it does not stop failing closed: the next request tries again,
    // rather than being handed an empty namespace.
    await expect(p.get("TOKEN")).rejects.toThrow("ECONNRESET");
  });

  it("does not retry a read that failed by HANGING past the retry deadline", async () => {
    const c = clock();
    let reads = 0;
    const resolver: ParameterResolver = {
      async resolve() {
        reads += 1;
        c.advance(10_000); // the store client's own timeout, spent
        throw new Error("The operation was aborted due to timeout");
      },
    };
    const s = noSleep();
    const p = new StoreSecretProvider(resolver, "/ns/", {
      now: c.now,
      onWarn: () => {},
      sleep: s.sleep,
    });
    await expect(p.get("TOKEN")).rejects.toThrow("timeout");
    expect(reads).toBe(1);
    expect(s.slept).toEqual([]);
  });

  it("with something held, a failure is answered from it at once — no retry, no sleep", async () => {
    const f = flaky({ TOKEN: "v1" });
    const s = noSleep();
    const p = new StoreSecretProvider(f.resolver, "/ns/", {
      onWarn: () => {},
      sleep: s.sleep,
    });
    await p.get("TOKEN");
    f.failNext(1);
    // A get with something held does not reach the resolver while the
    // resolver's own snapshot is fresh; this fake holds none, so it does.
    expect(await p.get("TOKEN")).toBe("v1");
    expect(f.reads()).toBe(2);
    expect(s.slept).toEqual([]);
  });

  it("a revocation is never undone by a failed read after it: the pre-write map is not served", async () => {
    // The fallback this deliberately does NOT have. Keeping the map from before
    // `invalidate()` for "the read after failed" would serve a token the
    // operator was just told is revoked.
    const f = flaky({ TOKEN: "live" });
    const p = new StoreSecretProvider(f.resolver, "/ns/", {
      onWarn: () => {},
      sleep: noSleep().sleep,
    });
    expect(await p.get("TOKEN")).toBe("live");
    f.set({});
    p.invalidate();
    f.failNext(Infinity);
    await expect(p.get("TOKEN")).rejects.toThrow();
  });

  it("concurrent gets share one retrying read", async () => {
    const f = flaky({ TOKEN: "v1" });
    f.failNext(1);
    const p = new StoreSecretProvider(f.resolver, "/ns/", {
      onWarn: () => {},
      sleep: noSleep().sleep,
    });
    const all = await Promise.all(
      Array.from({ length: 10 }, () => p.get("TOKEN")),
    );
    expect(all.every((v) => v === "v1")).toBe(true);
    expect(f.reads()).toBe(2);
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
    expect(hydrated).toEqual(["OTEL_EXPORTER_OTLP_HEADERS"]);
    // Nor the internal-token ROOT: a bundle holds its own derived token, baked
    // by the renderer, and the root would be every component's.
    expect(env.STRAD_INTERNAL_TOKEN).toBeUndefined();
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
        now: c.now,
        onWarn: (m) => warnings.push(m),
      },
    );

    expect(await p.get("TOKEN")).toBe(VALUE);
    // An upstream error that itself tries to smuggle the value out.
    f.failWith(new Error(`bad payload: ${VALUE}`));
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
 * one namespace. The whole point below is that there are two. Like the other
 * one it holds a reading: `asked` records the namespaces that cost a READ of
 * the store, not every slice handed out, and `forget()` drops it.
 */
function namespacedResolver(
  byNamespace: Record<string, Record<string, string>>,
) {
  const asked: string[] = [];
  let held: Record<string, Record<string, string>> | undefined;
  return {
    resolver: {
      async resolve(namespace: string): Promise<Record<string, string>> {
        if (!held) {
          asked.push(namespace);
          held = structuredClone(byNamespace);
        }
        return { ...(held[namespace] ?? {}) };
      },
      forget() {
        held = undefined;
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
    expect(f.asked).toHaveLength(1);
  });

  it("does not re-read the store chasing a miss on the per-server layer", async () => {
    // A miss on layer 1 is the NORMAL case — most names live in the shared
    // namespace — and chasing one drops the whole reading of the store.
    // Chasing every one of them would cost a full re-read per gateway-resolved
    // name per slug.
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
    expect(f.asked).toHaveLength(1);
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
