import { describe, expect, it } from "vitest";
import {
  FAILURE_BACKOFF_MS,
  MAX_DIAGNOSIS_TTL_MS,
  readStoreDiagnosticsCached,
} from "../src/secrets/store-diagnostics.ts";
import type { ParameterStore } from "../src/secrets/parameters/index.ts";

/**
 * The TTL in front of the store diagnosis.
 *
 * `/ui` and `/api/secrets/readiness` both derive their verdict from one pair of
 * store reads — an index `list()` plus a per-parameter render pass — and both
 * used to perform it afresh per request. The pass is not nominal: it renders
 * every parameter under its own try/catch rather than ending at the first
 * failure, so a namespace-wide refusal costs a FULL pass at a fan-out of ten.
 * A caller polling readiness hard was therefore an amplifier.
 *
 * The four properties this file holds, because each one is a way the cache
 * could be wrong rather than merely absent:
 *
 *   1. IT ACTUALLY CACHES, per namespace and per store client, and it expires.
 *   2. IT STAYS HONEST. Every hit carries `ageMs`, and no answer is served past
 *      a minute however long `gateway.secrets.ttlSeconds` is.
 *   3. A FAILED PASS IS NOT AN ANSWER. It is held for a short backoff, so a
 *      broken store is neither hammered nor reported broken for a full TTL
 *      after it recovers. A store that ANSWERS with a namespace-wide render
 *      refusal is the opposite — a complete, expensive answer — and is cached.
 *   4. IT NEVER SLOWS A CALLER DOWN. Concurrent callers share one pass, and the
 *      pass keeps the deadline it always had.
 */

interface Fake {
  store: Pick<ParameterStore, "list" | "resolveDetailed">;
  lists: number;
  renders: number;
}

function fakeStore(
  opts: {
    variables?: string[];
    unrenderable?: { variable: string; hard: boolean; reason: string }[];
    listThrows?: boolean;
    renderThrows?: boolean;
    /** Never settles, so the deadline is the only thing that ends the read. */
    hangs?: boolean;
  } = {},
): Fake {
  const fake: Fake = {
    lists: 0,
    renders: 0,
    store: {
      list: async (namespace: string) => {
        fake.lists += 1;
        if (opts.hangs) return new Promise<never>(() => {});
        if (opts.listThrows) throw new Error("store unreachable");
        return (opts.variables ?? ["ALPHA_TOKEN"]).map((variable) => ({
          path: `${namespace}${variable}`,
          variable,
          secret: true,
          hasValue: true,
          latestVersion: "v1",
        }));
      },
      resolveDetailed: async () => {
        fake.renders += 1;
        if (opts.hangs) return new Promise<never>(() => {});
        if (opts.renderThrows) throw new Error("render refused");
        return {
          values: Object.fromEntries(
            (opts.variables ?? ["ALPHA_TOKEN"])
              .filter(
                (v) => !(opts.unrenderable ?? []).some((u) => u.variable === v),
              )
              .map((v) => [v, "value"]),
          ),
          unrenderable: opts.unrenderable ?? [],
        };
      },
    },
  };
  return fake;
}

const NS = "/strad/test/gateway/static/";

/** A clock the test moves by hand, so elapsed real time proves nothing. */
function clock(): { now: () => number; advance: (ms: number) => void } {
  let t = 1_000_000;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("the diagnosis is cached, per namespace and per store", () => {
  it("reads once for two calls inside the TTL, and says how old the second is", async () => {
    const fake = fakeStore();
    const time = clock();
    const opts = {
      store: fake.store,
      namespace: NS,
      ttlMs: 60_000,
      now: time.now,
    };

    const first = await readStoreDiagnosticsCached(opts);
    expect(first.ageMs).toBe(0);
    expect(first.indexed.has("ALPHA_TOKEN")).toBe(true);

    time.advance(30_000);
    const second = await readStoreDiagnosticsCached(opts);

    // The reads did not happen again...
    expect(fake.lists).toBe(1);
    expect(fake.renders).toBe(1);
    // ...and the answer says so rather than presenting itself as fresh.
    expect(second.ageMs).toBe(30_000);
    expect(second.indexed.has("ALPHA_TOKEN")).toBe(true);
    expect(second.indexRead).toBe(true);
    expect(second.renderRead).toBe(true);
  });

  it("re-reads once the TTL has passed", async () => {
    const fake = fakeStore();
    const time = clock();
    const opts = {
      store: fake.store,
      namespace: NS,
      ttlMs: 60_000,
      now: time.now,
    };

    await readStoreDiagnosticsCached(opts);
    time.advance(59_999);
    await readStoreDiagnosticsCached(opts);
    expect(fake.lists).toBe(1);

    time.advance(1);
    const fresh = await readStoreDiagnosticsCached(opts);
    expect(fake.lists).toBe(2);
    expect(fake.renders).toBe(2);
    expect(fresh.ageMs).toBe(0);
  });

  it("caps the TTL at a minute, whatever ttlSeconds says", async () => {
    // `gateway.secrets.ttlSeconds` accepts up to an hour, and a deployment that
    // rotates rarely can reasonably set it there. An hour-old "the store answers
    // and everything renders" is not a health signal, so the knob is followed
    // down and capped up.
    const fake = fakeStore();
    const time = clock();
    const opts = {
      store: fake.store,
      namespace: NS,
      ttlMs: 3_600_000,
      now: time.now,
    };

    await readStoreDiagnosticsCached(opts);
    time.advance(MAX_DIAGNOSIS_TTL_MS + 1);
    await readStoreDiagnosticsCached(opts);
    expect(fake.lists).toBe(2);
  });

  it("honours a TTL shorter than the cap as given", async () => {
    const fake = fakeStore();
    const time = clock();
    const opts = {
      store: fake.store,
      namespace: NS,
      ttlMs: 5_000,
      now: time.now,
    };

    await readStoreDiagnosticsCached(opts);
    time.advance(4_000);
    await readStoreDiagnosticsCached(opts);
    expect(fake.lists).toBe(1);

    time.advance(1_001);
    await readStoreDiagnosticsCached(opts);
    expect(fake.lists).toBe(2);
  });

  it("does not serve one namespace's answer under another", async () => {
    const fake = fakeStore();
    const time = clock();
    const base = { store: fake.store, ttlMs: 60_000, now: time.now };

    await readStoreDiagnosticsCached({ ...base, namespace: NS });
    await readStoreDiagnosticsCached({
      ...base,
      namespace: "/strad/prod/gateway/static/",
    });
    expect(fake.lists).toBe(2);
  });

  it("does not serve one store client's answer under another", async () => {
    // In production there is one resolver per process, so this is a process-wide
    // cache. Two clients mean two credentials or two projects, and their answers
    // are not interchangeable.
    const a = fakeStore();
    const b = fakeStore();
    const time = clock();

    await readStoreDiagnosticsCached({
      store: a.store,
      namespace: NS,
      ttlMs: 60_000,
      now: time.now,
    });
    await readStoreDiagnosticsCached({
      store: b.store,
      namespace: NS,
      ttlMs: 60_000,
      now: time.now,
    });
    expect(a.lists).toBe(1);
    expect(b.lists).toBe(1);
  });
});

describe("a pass that did not read is cached as a shrug, briefly", () => {
  it("holds a failed pass for the backoff, not for the TTL", async () => {
    const fake = fakeStore({ listThrows: true, renderThrows: true });
    const time = clock();
    const opts = {
      store: fake.store,
      namespace: NS,
      ttlMs: 60_000,
      now: time.now,
    };

    const failed = await readStoreDiagnosticsCached(opts);
    // Not an answer: the console draws exactly the states it had before the
    // diagnosis existed, which is what `indexRead: false` means downstream.
    expect(failed.indexRead).toBe(false);
    expect(failed.renderRead).toBe(false);
    expect(failed.indexed.size).toBe(0);

    // A broken store is not hammered: a poller inside the backoff costs nothing.
    time.advance(FAILURE_BACKOFF_MS - 1);
    await readStoreDiagnosticsCached(opts);
    expect(fake.lists).toBe(1);

    // And an outage is not extended: the retry comes far sooner than the TTL.
    time.advance(1);
    await readStoreDiagnosticsCached(opts);
    expect(fake.lists).toBe(2);
  });

  it("serves the recovered answer as soon as the backoff is up", async () => {
    let broken = true;
    const time = clock();
    let lists = 0;
    const store = {
      list: async (namespace: string) => {
        lists += 1;
        if (broken) throw new Error("store unreachable");
        return [
          {
            path: `${namespace}ALPHA_TOKEN`,
            variable: "ALPHA_TOKEN",
            secret: true,
            hasValue: true,
            latestVersion: "v1",
          },
        ];
      },
      resolveDetailed: async (): Promise<{
        values: Record<string, string>;
        unrenderable: { variable: string; hard: boolean; reason: string }[];
      }> => ({
        values: broken ? {} : { ALPHA_TOKEN: "value" },
        unrenderable: [],
      }),
    };
    const opts = { store, namespace: NS, ttlMs: 60_000, now: time.now };

    expect((await readStoreDiagnosticsCached(opts)).indexRead).toBe(false);
    broken = false;
    time.advance(FAILURE_BACKOFF_MS);
    const recovered = await readStoreDiagnosticsCached(opts);
    expect(recovered.indexRead).toBe(true);
    expect(recovered.indexed.has("ALPHA_TOKEN")).toBe(true);
    expect(lists).toBe(2);
  });

  it("holds a HALF-read pass for the backoff too", async () => {
    // The index answered and the render did not. `unrenderable` is then not a
    // complete list, and treating an incomplete diagnosis as a full answer for a
    // minute would hide a store that is half down.
    const fake = fakeStore({ renderThrows: true });
    const time = clock();
    const opts = {
      store: fake.store,
      namespace: NS,
      ttlMs: 60_000,
      now: time.now,
    };

    const half = await readStoreDiagnosticsCached(opts);
    expect(half.indexRead).toBe(true);
    expect(half.renderRead).toBe(false);

    time.advance(FAILURE_BACKOFF_MS);
    await readStoreDiagnosticsCached(opts);
    expect(fake.renders).toBe(2);
  });

  it("caches a namespace-wide render REFUSAL for the full TTL", async () => {
    // The expensive case, and the one the amplification concern is actually
    // about: every parameter refusing to render is a complete answer produced by
    // a full pass, not a failure. Re-reading it per request is exactly the cost
    // this cache exists to stop paying.
    const fake = fakeStore({
      variables: ["A", "B"],
      unrenderable: [
        { variable: "A", hard: true, reason: "400 SECRET_REFERENCE_ERROR" },
        { variable: "B", hard: true, reason: "400 SECRET_REFERENCE_ERROR" },
      ],
    });
    const time = clock();
    const opts = {
      store: fake.store,
      namespace: NS,
      ttlMs: 60_000,
      now: time.now,
    };

    const first = await readStoreDiagnosticsCached(opts);
    expect(first.unrenderable.size).toBe(2);
    expect(first.renderRead).toBe(true);

    time.advance(FAILURE_BACKOFF_MS * 2);
    const second = await readStoreDiagnosticsCached(opts);
    expect(fake.renders).toBe(1);
    expect(second.unrenderable.get("A")).toBe("400 SECRET_REFERENCE_ERROR");
  });
});

describe("the cache never costs a caller time", () => {
  it("shares ONE pass between concurrent callers", async () => {
    // Without this the TTL does nothing for the case it exists for: ten
    // simultaneous polls on a cold entry would open ten full passes and only
    // then start hitting the cache.
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let lists = 0;
    const store = {
      list: async () => {
        lists += 1;
        await gate;
        return [];
      },
      resolveDetailed: async () => {
        await gate;
        return { values: {}, unrenderable: [] };
      },
    };

    const all = Promise.all(
      Array.from({ length: 10 }, () =>
        readStoreDiagnosticsCached({ store, namespace: NS, ttlMs: 60_000 }),
      ),
    );
    release!();
    const results = await all;

    expect(lists).toBe(1);
    expect(results).toHaveLength(10);
    for (const r of results) expect(r.indexRead).toBe(true);
  });

  it("keeps the deadline: a hanging store degrades the page, it does not hang it", async () => {
    const fake = fakeStore({ hangs: true });
    const started = Date.now();
    const diagnosis = await readStoreDiagnosticsCached({
      store: fake.store,
      namespace: NS,
      ttlMs: 60_000,
      timeoutMs: 50,
    });

    expect(Date.now() - started).toBeLessThan(2_000);
    expect(diagnosis.indexRead).toBe(false);
    expect(diagnosis.renderRead).toBe(false);
  });
});
