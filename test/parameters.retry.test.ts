import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createFakeGcp } from "../src/secrets/parameters/fake.ts";
import {
  createGcpParameterStore,
  parameterPath,
  staticNamespace,
} from "../src/secrets/parameters/index.ts";
import {
  DEFAULT_RETRY_BUDGET,
  isIdempotentMethod,
  isRetryableStatus,
  parseRetryAfter,
  retryDelayMs,
} from "../src/secrets/parameters/retry.ts";

/**
 * A refused read is not a fact about the parameter.
 *
 * Parameter Manager enforces a per-project, per-minute read quota, and a deploy
 * reads the whole store twice in a few seconds — `check-store --resolve`, then
 * `render-spec`. One `429` out of that burst used to throw straight out of
 * `call()` and take a production deploy down before `doctl` was reached. These
 * are the two halves of not doing that again: a refusal is retried, and a real
 * answer (`403`, `404`, `409`) still lands on the first attempt.
 */

const ENV = "staging";
const SLUG = "remote-filesystem-tmp-public";
const VAR = "REMOTE_FILESYSTEM_TMP_PUBLIC_GCS_CLIENT_EMAIL";
const PATH = parameterPath(ENV, SLUG, VAR);

/** A store wired to a stub transport, with a budget small enough to test. */
function storeOn(
  fetchImpl: typeof fetch,
  retry?: Partial<typeof DEFAULT_RETRY_BUDGET>,
  snapshotTtlMs = 0,
) {
  return createGcpParameterStore({
    projectId: "p",
    account: {
      client_email: "admin@demo.iam.gserviceaccount.com",
      private_key: generateKeyPairSync("rsa", { modulusLength: 2048 })
        .privateKey.export({ type: "pkcs8", format: "pem" })
        .toString(),
    },
    pmApiBase: "http://pm",
    smApiBase: "http://sm",
    tokenUrl: "http://token/token",
    fetchImpl,
    retry,
    snapshotTtlMs,
  });
}

/**
 * A transport that answers the token exchange, then hands every API call to
 * `answer`, recording what it was asked.
 */
function transport(answer: (n: number, url: string) => Response) {
  const calls: string[] = [];
  const impl = (async (input: string | URL) => {
    const url = String(input);
    if (url.endsWith("/token")) {
      return new Response(
        JSON.stringify({ access_token: "t", expires_in: 3600 }),
        { status: 200 },
      );
    }
    calls.push(url);
    return answer(calls.length - 1, url);
  }) as typeof fetch;
  return { impl, calls };
}

const listing = () =>
  new Response(
    JSON.stringify({
      parameters: [
        { name: "projects/p/locations/global/parameters/x", labels: {} },
      ],
    }),
    { status: 200 },
  );

const throttled = (headers?: Record<string, string>) =>
  new Response(JSON.stringify({ error: { code: 429 } }), {
    status: 429,
    statusText: "Too Many Requests",
    headers,
  });

describe("the parameter store retries a refusal", () => {
  it("succeeds after a 429, having waited before trying again", async () => {
    const { impl, calls } = transport((n) =>
      n === 0 ? throttled() : listing(),
    );
    const store = storeOn(impl);

    const started = Date.now();
    // `list()` on an empty-labelled listing: one call, refused, then answered.
    await expect(store.list(`/strad/${ENV}/mcp/`)).resolves.toEqual([]);
    const elapsed = Date.now() - started;

    expect(calls).toHaveLength(2);
    // It BACKED OFF rather than hammering. Equal jitter puts the first sleep in
    // [base/2, base]; asserting the floor is what says a delay happened at all.
    expect(elapsed).toBeGreaterThanOrEqual(
      DEFAULT_RETRY_BUDGET.baseDelayMs / 2,
    );
  });

  it("gives up on a 429 that never clears, in bounded time", async () => {
    const { impl, calls } = transport(() => throttled());
    const budget = {
      attempts: 3,
      baseDelayMs: 10,
      maxDelayMs: 40,
      totalDelayMs: 100,
    };
    const store = storeOn(impl, budget);

    const started = Date.now();
    await expect(store.list(`/strad/${ENV}/mcp/`)).rejects.toThrow(/429/);
    const elapsed = Date.now() - started;

    // The attempt ceiling holds: three tries, not an unbounded loop.
    expect(calls).toHaveLength(budget.attempts);
    // And so does the delay ceiling. A generous slack — this asserts the bound
    // exists, not that the event loop is punctual.
    expect(elapsed).toBeLessThan(budget.totalDelayMs + 5_000);
  });

  it("does NOT retry a 403 — a permission error is a real answer", async () => {
    const { impl, calls } = transport(
      () =>
        new Response(JSON.stringify({ error: { code: 403 } }), {
          status: 403,
          statusText: "Forbidden",
        }),
    );
    const store = storeOn(impl);

    await expect(store.list(`/strad/${ENV}/mcp/`)).rejects.toThrow(/403/);
    expect(calls).toHaveLength(1);
  });

  it("does NOT retry a 404 — an absent parameter stays absent", async () => {
    const { impl, calls } = transport(
      () =>
        new Response(JSON.stringify({ error: { code: 404 } }), {
          status: 404,
          statusText: "Not Found",
        }),
    );
    const store = storeOn(impl);

    await expect(store.reveal(PATH)).rejects.toThrow(/404/);
    expect(calls).toHaveLength(1);
  });

  it("honours Retry-After when the API names a delay", async () => {
    const { impl, calls } = transport((n) =>
      n === 0 ? throttled({ "retry-after": "1" }) : listing(),
    );
    // A budget whose own exponential is 10ms; only the header can make this slow.
    const store = storeOn(impl, {
      baseDelayMs: 10,
      maxDelayMs: 10,
      totalDelayMs: 5_000,
    });

    const started = Date.now();
    await expect(store.list(`/strad/${ENV}/mcp/`)).resolves.toEqual([]);
    expect(calls).toHaveLength(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  });

  it("gives up rather than sleeping past its budget for a long Retry-After", async () => {
    const { impl, calls } = transport(() =>
      throttled({ "retry-after": "600" }),
    );
    const store = storeOn(impl, { totalDelayMs: 50 });

    const started = Date.now();
    await expect(store.list(`/strad/${ENV}/mcp/`)).rejects.toThrow(/429/);
    // One attempt: a ten-minute wait does not fit the budget, so there is no
    // second try rather than a deploy step that hangs for ten minutes.
    expect(calls).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("retries a transient status on a GET but not on a POST", async () => {
    const unavailable = () =>
      new Response("", { status: 503, statusText: "Service Unavailable" });

    const quick = { baseDelayMs: 5, maxDelayMs: 5, totalDelayMs: 50 };
    const reads = transport((n) => (n === 0 ? unavailable() : listing()));
    await expect(
      storeOn(reads.impl, quick).list(`/strad/${ENV}/mcp/`),
    ).resolves.toEqual([]);
    expect(reads.calls).toHaveLength(2);

    // A POST may have landed before the response was lost, so it fails on the
    // first answer. The parameter POST is the first API call `create()` makes
    // for a non-secret parameter, so it is the failure under test; what follows
    // is the 404-tolerant rollback DELETE, which is idempotent and does retry.
    const writes = transport(() => unavailable());
    await expect(
      storeOn(writes.impl, quick).create({
        path: PATH,
        secret: false,
        value: "v",
      }),
    ).rejects.toThrow(/503/);
    // The versions LIST that precedes the write is a GET and does retry, so the
    // assertion that matters is that the POST itself was made exactly once.
    expect(
      writes.calls.filter((u) => u.includes("parameters?parameter_id=")),
    ).toHaveLength(1);
  });
});

describe("the retry policy itself", () => {
  it("retries a transient status only where repeating the request is safe", () => {
    // Including `429`. A refusal from a fronting proxy may post-date the write,
    // and a retried `POST` that already landed comes back `409` — which is what
    // strands a versionless parameter. See `isRetryableStatus`.
    for (const s of [429, 500, 502, 503, 504]) {
      expect(isRetryableStatus(s, true)).toBe(true);
      expect(isRetryableStatus(s, false)).toBe(false);
    }
  });

  it("never retries a status that is a real answer", () => {
    for (const s of [400, 401, 403, 404, 409, 412, 501]) {
      expect(isRetryableStatus(s, true)).toBe(false);
      expect(isRetryableStatus(s, false)).toBe(false);
    }
  });

  it("knows which methods may be repeated", () => {
    expect(isIdempotentMethod("GET")).toBe(true);
    expect(isIdempotentMethod("delete")).toBe(true);
    expect(isIdempotentMethod("POST")).toBe(false);
  });

  it("reads both Retry-After forms, and neither of the non-forms", () => {
    expect(parseRetryAfter("30")).toBe(30_000);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter("  ")).toBeUndefined();
    expect(parseRetryAfter("soon")).toBeUndefined();

    const now = Date.parse("2026-08-29T14:00:00Z");
    expect(parseRetryAfter("Sat, 29 Aug 2026 14:00:30 GMT", now)).toBe(30_000);
    // A date already past is zero, not a negative sleep.
    expect(parseRetryAfter("Sat, 29 Aug 2026 13:59:00 GMT", now)).toBe(0);
  });

  it("backs off exponentially, with jitter that never rounds to nothing", () => {
    const budget = DEFAULT_RETRY_BUDGET;
    for (const [attempt, term] of [
      [0, 400],
      [1, 800],
      [2, 1_600],
    ] as const) {
      for (const random of [0, 0.5, 0.999]) {
        const d = retryDelayMs({
          attempt,
          spentMs: 0,
          budget,
          random: () => random,
        })!;
        expect(d).toBeGreaterThanOrEqual(term / 2);
        expect(d).toBeLessThanOrEqual(term);
      }
    }
  });

  it("caps a single sleep at maxDelayMs", () => {
    const d = retryDelayMs({
      attempt: 20,
      spentMs: 0,
      budget: { ...DEFAULT_RETRY_BUDGET, attempts: 99 },
      random: () => 0.999,
    })!;
    expect(d).toBeLessThanOrEqual(DEFAULT_RETRY_BUDGET.maxDelayMs);
  });

  it("stops at the attempt ceiling and at the total-delay ceiling", () => {
    const budget = DEFAULT_RETRY_BUDGET;
    // The last permitted attempt has no successor.
    expect(
      retryDelayMs({ attempt: budget.attempts - 1, spentMs: 0, budget }),
    ).toBeUndefined();
    // And a spent budget refuses one even when attempts remain.
    expect(
      retryDelayMs({ attempt: 0, spentMs: budget.totalDelayMs, budget }),
    ).toBeUndefined();
  });

  it("bounds the default budget: three retries, ~6s of sleep at the very most", () => {
    const budget = DEFAULT_RETRY_BUDGET;
    let spentMs = 0;
    let sleeps = 0;
    for (let n = 0; ; n++) {
      const d = retryDelayMs({
        attempt: n,
        spentMs,
        budget,
        random: () => 0.999,
      });
      if (d === undefined) break;
      spentMs += d;
      sleeps++;
    }
    expect(sleeps).toBe(budget.attempts - 1);
    expect(spentMs).toBeLessThanOrEqual(budget.totalDelayMs);
  });
});

/**
 * The other half of surviving a quota: not spending it.
 *
 * A namespace is not addressable in Parameter Manager — it lives inside a
 * parameter's envelope, not on a label — so `list(namespace)` reads a version of
 * EVERY managed parameter in the project and filters afterwards. `resolve()`
 * calls `list()`, so a deploy that resolves N namespaces paid N x P version
 * reads for P parameters, and BOTH factors grow when servers are added. Six new
 * slugs took that past the quota.
 *
 * `snapshotTtlMs` makes a one-shot, read-only reader enumerate once. It stays off
 * everywhere that writes.
 */
describe("enumerating the store once per deploy", () => {
  const namespaces = [
    staticNamespace(ENV, "remote-filesystem-tmp-public"),
    staticNamespace(ENV, "telegram-ro"),
  ];

  /** Seed one parameter into each namespace, then count the reads that follow. */
  async function seeded() {
    const gcp = createFakeGcp();
    for (const [i, ns] of namespaces.entries()) {
      await gcp.store.create({
        path: `${ns}VALUE_${i}`,
        secret: false,
        value: `v${i}`,
      });
    }
    return gcp;
  }

  /** A store on the fake's transport, counting every non-token request. */
  function counting(
    gcp: Awaited<ReturnType<typeof seeded>>,
    snapshotTtlMs: number,
  ) {
    let reads = 0;
    const store = createGcpParameterStore({
      projectId: gcp.endpoints.projectId,
      location: gcp.endpoints.location,
      account: JSON.parse(gcp.endpoints.keyJson) as {
        client_email: string;
        private_key: string;
      },
      pmApiBase: gcp.endpoints.pmApiBase,
      smApiBase: gcp.endpoints.smApiBase,
      tokenUrl: gcp.endpoints.tokenUrl,
      fetchImpl: (input, init) => {
        if (!String(input).endsWith("/token")) reads++;
        return gcp.fetchImpl(input, init);
      },
      snapshotTtlMs,
    });
    return { store, reads: () => reads };
  }

  it("reads the same values either way, and far fewer times with reuse", async () => {
    const gcp = await seeded();

    const off = counting(gcp, 0);
    const cold = [];
    for (const ns of namespaces) cold.push(await off.store.resolve(ns));

    const on = counting(gcp, 60_000);
    const warm = [];
    for (const ns of namespaces) warm.push(await on.store.resolve(ns));

    // Byte-for-byte the same resolution. The cache changes the request count,
    // never the answer — a deploy must render the same spec.
    expect(warm).toEqual(cold);
    expect(warm[0]).toEqual({ VALUE_0: "v0" });
    expect(warm[1]).toEqual({ VALUE_1: "v1" });

    expect(on.reads()).toBeLessThan(off.reads());
  });

  it("enumerates once for N namespaces instead of once per namespace", async () => {
    const gcp = await seeded();
    const { store, reads } = counting(gcp, 60_000);

    await store.resolve(namespaces[0]!);
    const afterFirst = reads();
    await store.resolve(namespaces[1]!);
    const afterSecond = reads();

    // The second namespace costs only its own render — no second enumeration.
    // The first paid for the listing, so it is strictly the more expensive one.
    expect(afterSecond - afterFirst).toBeLessThan(afterFirst);
  });

  it("shares ONE enumeration between namespaces resolved concurrently", async () => {
    const gcp = await seeded();
    const { store, reads } = counting(gcp, 60_000);

    await Promise.all(namespaces.map((ns) => store.resolve(ns)));
    const together = reads();

    const fresh = counting(gcp, 60_000);
    for (const ns of namespaces) await fresh.store.resolve(ns);

    // The promise is cached, not its result, so a concurrent caller waits on the
    // enumeration already in flight rather than starting a second one.
    expect(together).toBe(fresh.reads());
  });

  it("is OFF by default, so a write is never answered from a stale roster", async () => {
    const gcp = createFakeGcp();
    const ns = staticNamespace(ENV, "telegram-ro");
    expect(await gcp.store.list(ns)).toEqual([]);

    await gcp.store.create({
      path: `${ns}FRESH`,
      secret: false,
      value: "v",
    });

    // The default store enumerated a moment ago and must NOT still believe it.
    expect(await gcp.store.list(ns)).toHaveLength(1);
  });

  it("drops a cached roster on EVERY write, not just create", async () => {
    const gcp = await seeded();
    const { store } = counting(gcp, 60_000);
    const ns = namespaces[0]!;
    const path = `${ns}VALUE_0`;

    // create
    expect(await store.list(ns)).toHaveLength(1);
    await store.create({ path: `${ns}SECOND`, secret: false, value: "v" });
    expect(await store.list(ns)).toHaveLength(2);

    // setNote — the roster carries the note, so a stale one shows the old text.
    await store.setNote(path, "annotated");
    expect((await store.list(ns)).find((m) => m.path === path)?.note).toBe(
      "annotated",
    );

    // rotate — the roster carries `latestVersion`, which a rotation moves.
    const before = (await store.list(ns)).find(
      (m) => m.path === path,
    )!.latestVersion;
    await store.rotate(path, "rotated");
    expect(
      (await store.list(ns)).find((m) => m.path === path)?.latestVersion,
    ).not.toBe(before);

    // destroy
    await store.destroy(`${ns}SECOND`);
    expect(await store.list(ns)).toHaveLength(1);
  });

  it("does not cache a REFUSED enumeration", async () => {
    let refuse = true;
    const { impl, calls } = transport((_n, url) => {
      if (refuse && url.includes("/parameters?"))
        return new Response("", {
          status: 429,
          statusText: "Too Many Requests",
        });
      return listing();
    });
    const cached = storeOn(impl, { attempts: 1 }, 60_000);

    await expect(cached.list(`/strad/${ENV}/mcp/`)).rejects.toThrow(/429/);
    const afterFailure = calls.length;

    // A refusal must not become the answer for the whole TTL.
    refuse = false;
    await expect(cached.list(`/strad/${ENV}/mcp/`)).resolves.toEqual([]);
    expect(calls.length).toBeGreaterThan(afterFailure);
  });
});
