import vm from "node:vm";
import { beforeEach, describe, expect, it } from "vitest";
import { SERVICE_WORKER_JS, SHELL_CACHE, SHELL_PATHS } from "../src/ui/pwa.ts";

/**
 * The service worker, RUN.
 *
 * A service worker is a cache with a persistence guarantee, installed on a
 * console that serves per-user authenticated HTML and, on `POST
 * /ui/:server/reveal`, plaintext secret material. The hazard is not subtle: a
 * cache-first worker over `/ui/*` would write both to disk, outlive sign-out,
 * and hand them to whoever opens the browser next.
 *
 * Reading the worker and satisfying yourself it never does that is one kind of
 * evidence. This file is the other kind: the worker source is evaluated in a
 * sandbox with a recording Cache Storage under it, driven through install,
 * activate and a set of fetches that includes the exact requests that would be
 * damaging to store — and the cache is inspected afterwards.
 *
 * The invariant every test here converges on: after any sequence of requests,
 * the cache holds SHELL_PATHS and nothing else.
 */

interface FakeResponse {
  body: string;
  from: "network" | "cache";
}

interface Harness {
  /** Dispatch an event to the worker's listener and settle its waitUntil()s. */
  dispatch(type: string, event: Record<string, unknown>): Promise<void>;
  /** Everything currently in cache storage, by cache name. */
  contents(): Record<string, string[]>;
  /** Paths the worker actually put on the wire, in order. */
  networkLog: string[];
  /** True if the worker ever called cache.put() — it must not. */
  putCalls: string[];
  /** Make the next (and every) network call reject, as an offline device would. */
  offline: boolean;
  /** Plant an entry a previous release's worker might have left behind. */
  seed(cacheName: string, path: string): void;
  /** Drop an entry, as a browser does when it reclaims storage. */
  evict(cacheName: string, path: string): void;
}

const ORIGIN = "https://strad.example.com";

function harness(): Harness {
  const caches = new Map<string, Map<string, FakeResponse>>();
  const networkLog: string[] = [];
  const putCalls: string[] = [];
  const listeners = new Map<string, (event: unknown) => void>();
  const state = { offline: false };

  async function net(request: { url: string }): Promise<FakeResponse> {
    networkLog.push(new URL(request.url).pathname);
    if (state.offline) throw new TypeError("Failed to fetch");
    // The bodies below stand in for what the real routes return. The two that
    // matter are the ones a careless worker would persist.
    const path = new URL(request.url).pathname;
    return { body: `BODY ${path}`, from: "network" };
  }

  /**
   * How a real Cache keys an entry: by FULL URL, resolved against the worker's
   * own location, and search-sensitive.
   *
   * The worker stores with a bare path (`addAll`) and reads with a bare path
   * (`match(url.pathname)`), so a fake that used the raw string as its key would
   * agree with itself no matter what the worker did. Resolving both ends the way
   * the platform does is what makes a hit here mean a hit in a browser, and it
   * is what would catch a regression to `match(request)` — where the search
   * WOULD be part of the key, and `?v=2` would start missing.
   */
  function key(pathOrUrl: string): string {
    return new URL(pathOrUrl, `${ORIGIN}/sw.js`).href;
  }

  function cacheFor(name: string): Map<string, FakeResponse> {
    let c = caches.get(name);
    if (!c) {
      c = new Map();
      caches.set(name, c);
    }
    return c;
  }

  const sandbox = {
    self: {
      addEventListener(type: string, fn: (event: unknown) => void) {
        listeners.set(type, fn);
      },
      skipWaiting: async () => {},
      clients: { claim: async () => {} },
      location: { origin: ORIGIN },
    },
    caches: {
      async open(name: string) {
        const c = cacheFor(name);
        return {
          async addAll(paths: string[]) {
            for (const p of paths) {
              c.set(key(p), await net({ url: `${ORIGIN}${p}` }));
            }
          },
          async match(request: string) {
            const hit = c.get(key(request));
            return hit ? { ...hit, from: "cache" as const } : undefined;
          },
          async put(request: string, value: FakeResponse) {
            putCalls.push(key(request));
            c.set(key(request), value);
          },
        };
      },
      async keys() {
        return [...caches.keys()];
      },
      async delete(name: string) {
        return caches.delete(name);
      },
    },
    fetch: net,
    URL,
    TypeError,
  };

  vm.runInNewContext(SERVICE_WORKER_JS, sandbox);

  return {
    async dispatch(type, event) {
      const fn = listeners.get(type);
      if (!fn) throw new Error(`no ${type} listener registered`);
      const pending: Promise<unknown>[] = [];
      fn({
        ...event,
        waitUntil: (p: Promise<unknown>) => pending.push(p),
        respondWith: (p: Promise<unknown>) => {
          (event as { responded?: Promise<unknown> }).responded = p;
          pending.push(p.catch(() => {}));
        },
      });
      await Promise.all(pending);
    },
    contents() {
      // Reported as pathnames — the cache keys by full URL, but what a reader
      // of these assertions needs to see is which ROUTES are stored.
      const out: Record<string, string[]> = {};
      for (const [name, c] of caches) {
        out[name] = [...c.keys()]
          .map((u) => new URL(u).pathname + new URL(u).search)
          .sort();
      }
      return out;
    },
    networkLog,
    putCalls,
    seed(cacheName, path) {
      cacheFor(cacheName).set(key(path), {
        body: `STALE ${path}`,
        from: "cache",
      });
    },
    evict(cacheName, path) {
      cacheFor(cacheName).delete(key(path));
    },
    get offline() {
      return state.offline;
    },
    set offline(v: boolean) {
      state.offline = v;
    },
  };
}

/** A fetch event, shaped like the real one. */
function req(
  path: string,
  opts: { method?: string; mode?: string; origin?: string } = {},
) {
  const event: Record<string, unknown> = {
    request: {
      url: `${opts.origin ?? ORIGIN}${path}`,
      method: opts.method ?? "GET",
      mode: opts.mode ?? "navigate",
    },
  };
  return event;
}

/** Whether the worker claimed the request, and what it answered with. */
async function drive(
  h: Harness,
  event: Record<string, unknown>,
): Promise<FakeResponse | null> {
  await h.dispatch("fetch", event);
  const responded = (event as { responded?: Promise<FakeResponse> }).responded;
  return responded ? await responded : null;
}

let h: Harness;

beforeEach(async () => {
  h = harness();
  await h.dispatch("install", {});
});

describe("install", () => {
  it("precaches the shell, and only the shell", () => {
    expect(h.contents()).toEqual({ [SHELL_CACHE]: [...SHELL_PATHS].sort() });
  });
});

describe("activate", () => {
  it("drops every cache but the current one, so a rename is an eviction", async () => {
    // A previous release's worker, having cached something it should not have.
    h.seed("strad-shell-v0", "/ui");
    expect(Object.keys(h.contents()).sort()).toEqual(
      [SHELL_CACHE, "strad-shell-v0"].sort(),
    );

    await h.dispatch("activate", {});

    expect(h.contents()).toEqual({ [SHELL_CACHE]: [...SHELL_PATHS].sort() });
  });
});

describe("an authenticated console page", () => {
  it("is fetched from the network and NOT written to the cache", async () => {
    const before = h.contents();
    const res = await drive(h, req("/ui"));

    expect(res).toEqual({ body: "BODY /ui", from: "network" });
    expect(h.networkLog).toContain("/ui");
    expect(h.contents()).toEqual(before);
    expect(h.putCalls).toEqual([]);
  });

  it("is never read from the cache either — every visit hits the gateway", async () => {
    await drive(h, req("/ui"));
    const second = await drive(h, req("/ui"));
    expect(second?.from).toBe("network");
    expect(h.networkLog.filter((p) => p === "/ui")).toHaveLength(2);
  });

  it("holds for a per-server page, which carries a slug and its contents", async () => {
    const before = h.contents();
    const res = await drive(h, req("/ui/gcs?prefix=screenshots/"));
    expect(res?.from).toBe("network");
    expect(h.contents()).toEqual(before);
  });
});

describe("the secret write surface", () => {
  /*
   * MIND THE MODE. The console's writes are top-level `<form method="post">`
   * submissions, and a browser dispatches those with `mode: "navigate"` — the
   * same mode as a page load. So these must be driven as navigations, not as
   * `same-origin` fetches.
   *
   * The distinction is the whole point of this block. The worker's method check
   * runs before its navigation branch, so both modes behave identically today;
   * but a refactor that hoisted the navigation branch above the method check
   * would claim `POST /ui/:server/reveal` — a response with a plaintext secret
   * in it — and a suite that only ever sent `same-origin` would stay green
   * through that.
   */
  it("is not claimed at all — POST /ui/:server/reveal never enters the worker", async () => {
    const before = h.contents();
    const res = await drive(
      h,
      req("/ui/gcs/reveal", { method: "POST", mode: "navigate" }),
    );

    // null means the worker did not call respondWith(): the browser's own
    // network path handles it, unobserved and unstored.
    expect(res).toBeNull();
    expect(h.networkLog).not.toContain("/ui/gcs/reveal");
    expect(h.contents()).toEqual(before);
  });

  it("holds for every other write on that surface", async () => {
    for (const action of ["create", "rotate", "note", "delete"]) {
      const res = await drive(
        h,
        req(`/ui/gcs/${action}`, { method: "POST", mode: "navigate" }),
      );
      expect(res, action).toBeNull();
    }
    expect(h.contents()).toEqual({ [SHELL_CACHE]: [...SHELL_PATHS].sort() });
  });

  it("holds for a fetch()-driven write, which arrives as same-origin", async () => {
    const res = await drive(
      h,
      req("/ui/gcs/reveal", { method: "POST", mode: "same-origin" }),
    );
    expect(res).toBeNull();
    expect(h.contents()).toEqual({ [SHELL_CACHE]: [...SHELL_PATHS].sort() });
  });
});

describe("everything that is not a page", () => {
  it("is left to the browser — subresource GETs are not claimed", async () => {
    for (const path of ["/api/secrets/readiness", "/healthz", "/mcp"]) {
      const res = await drive(h, req(path, { mode: "cors" }));
      expect(res, path).toBeNull();
    }
    expect(h.contents()).toEqual({ [SHELL_CACHE]: [...SHELL_PATHS].sort() });
  });

  it("includes cross-origin requests, fonts included", async () => {
    const res = await drive(
      h,
      req("/css2?family=IBM+Plex+Sans", {
        mode: "cors",
        origin: "https://fonts.googleapis.com",
      }),
    );
    expect(res).toBeNull();
  });
});

describe("the shell", () => {
  it("is served from the cache without touching the network", async () => {
    const netBefore = h.networkLog.length;
    const res = await drive(h, req("/pwa/icon-192.png", { mode: "no-cors" }));

    expect(res?.from).toBe("cache");
    expect(h.networkLog).toHaveLength(netBefore);
  });

  it("falls through to the network when the entry is gone", async () => {
    // The `hit || fetch(request)` arm. A cache a browser has evicted under
    // storage pressure must not turn an icon into a failed request.
    h.evict(SHELL_CACHE, "/pwa/icon-192.png");
    const res = await drive(h, req("/pwa/icon-192.png", { mode: "no-cors" }));

    expect(res?.from).toBe("network");
    expect(h.networkLog).toContain("/pwa/icon-192.png");
  });

  it("ignores a query string, so `?v=2` cannot bust a stale asset", async () => {
    // `?v=2` is the reflex for forcing a fresh copy of an asset. It does
    // nothing here, and this test is what says so out loud: the worker looks up
    // `url.pathname`, which drops the search, so the request is answered from
    // the same cached entry as the bare path. Renaming SHELL_CACHE is the only
    // remedy. HACKS.md #41.
    const netBefore = h.networkLog.length;
    const res = await drive(
      h,
      req("/pwa/icon-192.png?v=2", { mode: "no-cors" }),
    );

    expect(res?.from).toBe("cache");
    expect(h.networkLog).toHaveLength(netBefore);
    expect(h.contents()).toEqual({ [SHELL_CACHE]: [...SHELL_PATHS].sort() });
  });
});

describe("offline", () => {
  it("answers a page request with the static offline document", async () => {
    h.offline = true;
    const res = await drive(h, req("/ui"));

    expect(res).toEqual({ body: "BODY /pwa/offline", from: "cache" });
  });

  it("still caches nothing beyond the shell after the failure", async () => {
    h.offline = true;
    await drive(h, req("/ui"));
    await drive(h, req("/ui/gcs"));
    await drive(h, req("/"));

    expect(h.contents()).toEqual({ [SHELL_CACHE]: [...SHELL_PATHS].sort() });
    expect(h.putCalls).toEqual([]);
  });
});

describe("the invariant, after a full session", () => {
  it("survives sign-in, browsing, a reveal, a sign-out and going offline", async () => {
    await h.dispatch("activate", {});
    await drive(h, req("/"));
    await drive(h, req("/ui"));
    await drive(h, req("/ui/gcs?prefix=secrets/"));
    await drive(h, req("/ui/gcs/reveal", { method: "POST", mode: "navigate" }));
    await drive(h, req("/pwa/icon-512.png", { mode: "no-cors" }));
    await drive(h, req("/console/logout"));
    h.offline = true;
    await drive(h, req("/ui"));

    expect(h.contents()).toEqual({ [SHELL_CACHE]: [...SHELL_PATHS].sort() });
    expect(h.putCalls).toEqual([]);
  });
});
