import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createFakeGcp } from "../src/secrets/parameters/fake.ts";
import {
  createGcpParameterStore,
  parameterPath,
  staticNamespace,
} from "../src/secrets/parameters/index.ts";
import { DEFAULT_RETRY_BUDGET } from "../src/http/retry.ts";

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
  timeoutMs?: number,
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
    timeoutMs,
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

/**
 * A read that runs out its own deadline is a blip, not an answer.
 *
 * `render-spec` fans out over the whole store, and one `GET` that Google left
 * hanging for the full ten seconds rejected with undici's `TimeoutError` and
 * failed a production deploy (tadasant/tadasant-internal run 38093686525). It is
 * tried again — once, because each retry of a timeout spends the whole deadline
 * again.
 */
describe("the parameter store retries its own timeout once", () => {
  const timedOut = () =>
    new DOMException(
      "The operation was aborted due to timeout",
      "TimeoutError",
    );
  const quick = { baseDelayMs: 5, maxDelayMs: 5, totalDelayMs: 50 };

  /** Like `transport`, but `answer` may reject the way a fetch does. */
  function rejecting(answer: (n: number) => Response | Error) {
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
      const out = answer(calls.length - 1);
      if (out instanceof Error) throw out;
      return out;
    }) as typeof fetch;
    return { impl, calls };
  }

  it("succeeds when the attempt after a TimeoutError answers", async () => {
    const { impl, calls } = rejecting((n) =>
      n === 0 ? timedOut() : listing(),
    );

    await expect(
      storeOn(impl, quick).list(`/strad/${ENV}/mcp/`),
    ).resolves.toEqual([]);
    expect(calls).toHaveLength(2);
  });

  it("gives up after the second timeout, with its identity intact", async () => {
    const { impl, calls } = rejecting(() => timedOut());

    const err = await storeOn(impl, quick)
      .list(`/strad/${ENV}/mcp/`)
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    // Two tries, not `attempts` (four): each one spent the whole deadline.
    expect(calls).toHaveLength(2);
    expect((err as Error).name).toBe("TimeoutError");
  });

  it("still retries a 429 after a timeout, within the attempt budget", async () => {
    const { impl, calls } = rejecting((n) =>
      n === 0 ? timedOut() : n === 1 ? throttled() : listing(),
    );

    await expect(
      storeOn(impl, quick).list(`/strad/${ENV}/mcp/`),
    ).resolves.toEqual([]);
    expect(calls).toHaveLength(3);
  });

  it("retries a token exchange that timed out, once", async () => {
    let mints = 0;
    const calls: string[] = [];
    const impl = (async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith("/token")) {
        if (mints++ === 0) throw timedOut();
        return new Response(
          JSON.stringify({ access_token: "t", expires_in: 3600 }),
          { status: 200 },
        );
      }
      calls.push(url);
      return listing();
    }) as typeof fetch;

    await expect(
      storeOn(impl, quick).list(`/strad/${ENV}/mcp/`),
    ).resolves.toEqual([]);
    expect(mints).toBe(2);
    expect(calls).toHaveLength(1);
  });

  it("does NOT retry a write that timed out — it may have landed", async () => {
    const posts: string[] = [];
    const impl = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/token")) {
        return new Response(
          JSON.stringify({ access_token: "t", expires_in: 3600 }),
          { status: 200 },
        );
      }
      if (init?.method === "POST") {
        posts.push(url);
        throw timedOut();
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    await expect(
      storeOn(impl, quick).create({ path: PATH, secret: false, value: "v" }),
    ).rejects.toThrow(/timeout/);
    // The parameter-create POST, made once and never repeated.
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain("parameters?parameter_id=");
  });

  it("does NOT retry an AbortError — a cancelled request was withdrawn", async () => {
    const { impl, calls } = rejecting(
      () => new DOMException("This operation was aborted", "AbortError"),
    );

    await expect(
      storeOn(impl, quick).list(`/strad/${ENV}/mcp/`),
    ).rejects.toThrow(/aborted/);
    expect(calls).toHaveLength(1);
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

describe("the store's own deadline governs the bearer it fetches", () => {
  it("replaces the mint's default rather than inheriting it", async () => {
    // `mintAccessToken` carries a ten-second default for callers that name no
    // deadline. This store names one, and wraps the mint's `fetchImpl` to say
    // so, because a bearer fetched on the way to a read is part of that read.
    // Drop that wrapper and a deployment that configured `timeoutMs` gets the
    // mint's number instead — silently, and only on the path that stalls.
    const impl = (async (input: string | URL, init?: RequestInit) =>
      String(input).endsWith("/token")
        ? new Promise<never>((_resolve, reject) => {
            const signal = init?.signal;
            signal?.addEventListener("abort", () => reject(signal.reason));
          })
        : new Response("{}", { status: 200 })) as unknown as typeof fetch;

    const started = Date.now();
    const err = await storeOn(impl, { attempts: 1 }, 0, 30)
      .list(`/strad/${ENV}/mcp/`)
      .then(
        () => undefined,
        (e: unknown) => e,
      );

    // The store's 30ms, not the mint's 10s — measured, because the assertion is
    // about WHOSE bound fired and the two differ by three orders of magnitude.
    expect(Date.now() - started).toBeLessThan(2_000);
    // And the abort keeps its own identity: `withRequestDeadline` maps only the
    // expiry ITS signal caused, so this is not reported as the mint's 408.
    expect((err as Error).name).toBe("TimeoutError");
  });
});
