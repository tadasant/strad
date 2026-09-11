import { describe, expect, it, vi } from "vitest";
import { parseYamlDocument } from "../src/config/load.ts";
import {
  ConfigPoller,
  ConfigRejected,
  RuntimeConfig,
  readOverlayAtBoot,
} from "../src/config/runtime.ts";
import {
  EMPTY_OVERLAY,
  serialiseOverlay,
  withRemoval,
  withUpsert,
  type ServerOverlay,
} from "../src/config/overlay.ts";
import {
  ConfigStoreReadOnly,
  ConfigStoreTooLarge,
  MemoryConfigStore,
  ParameterConfigStore,
  type ConfigStore,
} from "../src/config/store.ts";
import { ParameterStoreError } from "../src/secrets/parameters/index.ts";
import { StradConfig } from "../src/config/schema.ts";

const BASE_YAML = `
version: 1
gateway:
  name: strad
  env: test
  secrets: { provider: gcp-parameter-store }
  configStore: { enabled: true }
auth:
  staticTokens: { enabled: true }
roles:
  admin: { servers: ["*"] }
servers:
  - slug: alpha
    kind: remote-http
    url: https://alpha.example.com/mcp
    entitlements: [admin]
`;

const BASE_DOC = parseYamlDocument(BASE_YAML);
const BASE_CONFIG = StradConfig.parse(BASE_DOC);

function runtimeWith(
  store: ConfigStore | null,
  rebuild: (c: StradConfig) => Promise<void> = () => Promise.resolve(),
): RuntimeConfig {
  return new RuntimeConfig({
    baseDocument: BASE_DOC,
    config: BASE_CONFIG,
    overlay: EMPTY_OVERLAY,
    store,
    rebuild,
  });
}

const DELTA = {
  slug: "delta",
  kind: "remote-http",
  url: "https://delta.example.com/mcp",
  entitlements: ["admin"],
};

function plus(
  entry: Record<string, unknown>,
  from = EMPTY_OVERLAY,
): ServerOverlay {
  return withUpsert(from, entry, { fileSlugs: new Set(["alpha"]) });
}

describe("RuntimeConfig.apply", () => {
  it("validates, rebuilds, stores and serves — in that order", async () => {
    const order: string[] = [];
    const store = new MemoryConfigStore();
    const wrapped: ConfigStore = {
      backend: store.backend,
      writable: true,
      read: () => store.read(),
      write: async (o) => {
        order.push("store");
        await store.write(o);
      },
    };
    const runtime = runtimeWith(wrapped, () => {
      order.push("rebuild");
      return Promise.resolve();
    });

    await runtime.apply(plus(DELTA));

    expect(order).toEqual(["rebuild", "store"]);
    expect(runtime.config().servers.map((s) => s.slug)).toEqual([
      "alpha",
      "delta",
    ]);
    expect((await wrapped.read()).servers.upserts).toHaveLength(1);
  });

  it("refuses an invalid roster without touching the store or the gateway", async () => {
    const store = new MemoryConfigStore();
    const rebuild = vi.fn(() => Promise.resolve());
    const runtime = runtimeWith(store, rebuild);

    await expect(
      runtime.apply(plus({ ...DELTA, entitlements: ["nobody"] })),
    ).rejects.toBeInstanceOf(ConfigRejected);

    expect(rebuild).not.toHaveBeenCalled();
    expect(await store.read()).toEqual(EMPTY_OVERLAY);
    expect(runtime.config().servers.map((s) => s.slug)).toEqual(["alpha"]);
  });

  it("does NOT store an overlay whose rebuild failed", async () => {
    // The ordering that matters most: a document stored before a failed rebuild
    // is a document the next BOOT picks up and dies on.
    const store = new MemoryConfigStore();
    const runtime = runtimeWith(store, () =>
      Promise.reject(new Error("upstream unreachable")),
    );

    await expect(runtime.apply(plus(DELTA))).rejects.toThrow(
      "upstream unreachable",
    );
    expect(await store.read()).toEqual(EMPTY_OVERLAY);
    expect(runtime.config().servers.map((s) => s.slug)).toEqual(["alpha"]);
  });

  it("ROLLS THE GATEWAY BACK when the store write fails", async () => {
    // The subtle one. The rebuild lands before the write, so a write that fails
    // leaves the process serving a roster nothing persisted — and the poll
    // cannot correct it, because the store's revision never moved. The gateway
    // has to be put back, not just the holder's bookkeeping.
    const built: string[][] = [];
    const runtime = runtimeWith(
      {
        backend: "x",
        writable: true,
        read: () => Promise.resolve(EMPTY_OVERLAY),
        write: () => Promise.reject(new Error("store 503")),
      },
      (config) => {
        built.push(config.servers.map((s) => s.slug));
        return Promise.resolve();
      },
    );

    await expect(runtime.apply(plus(DELTA))).rejects.toThrow("store 503");

    // Built forward, then built back to what is still in the store.
    expect(built).toEqual([["alpha", "delta"], ["alpha"]]);
    expect(runtime.config().servers.map((s) => s.slug)).toEqual(["alpha"]);
  });

  it("does not rebuild at all when there is no store to write to", async () => {
    const rebuild = vi.fn(() => Promise.resolve());
    const runtime = runtimeWith(null, rebuild);
    await expect(runtime.apply(plus(DELTA))).rejects.toBeInstanceOf(
      ConfigRejected,
    );
    expect(rebuild).not.toHaveBeenCalled();
  });

  it("one failed apply does not poison the applies queued behind it", async () => {
    const store = new MemoryConfigStore();
    const runtime = runtimeWith(store);

    const bad = runtime.apply(plus({ ...DELTA, entitlements: ["nobody"] }));
    const good = runtime.apply(plus(DELTA));

    await expect(bad).rejects.toBeInstanceOf(ConfigRejected);
    await expect(good).resolves.toBeUndefined();
    expect(runtime.config().servers.map((s) => s.slug)).toEqual([
      "alpha",
      "delta",
    ]);
  });

  it("serialises concurrent applies rather than interleaving their rebuilds", async () => {
    let inFlight = 0;
    let overlapped = false;
    const runtime = runtimeWith(new MemoryConfigStore(), async () => {
      inFlight += 1;
      if (inFlight > 1) overlapped = true;
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
    });

    const first = plus(DELTA);
    await Promise.all([
      runtime.apply(first),
      runtime.apply(plus({ ...DELTA, slug: "epsilon" }, first)),
    ]);
    expect(overlapped).toBe(false);
  });
});

describe("RuntimeConfig.poll", () => {
  it("adopts a change another process wrote", async () => {
    const store = new MemoryConfigStore();
    const runtime = runtimeWith(store);

    // Another process writes. This one has not seen it.
    await store.write(plus(DELTA));
    expect(runtime.config().servers.map((s) => s.slug)).toEqual(["alpha"]);

    expect(await runtime.poll()).toBe(true);
    expect(runtime.config().servers.map((s) => s.slug)).toEqual([
      "alpha",
      "delta",
    ]);
  });

  it("does nothing when the revision has not moved", async () => {
    const rebuild = vi.fn(() => Promise.resolve());
    const runtime = runtimeWith(new MemoryConfigStore(), rebuild);
    expect(await runtime.poll()).toBe(false);
    expect(rebuild).not.toHaveBeenCalled();
  });

  it("keeps serving what it has when the store will not answer", async () => {
    const runtime = runtimeWith({
      backend: "x",
      writable: true,
      read: () => Promise.reject(new ParameterStoreError("boom", 503)),
      write: () => Promise.resolve(),
    });
    expect(await runtime.poll()).toBe(false);
    expect(runtime.config().servers.map((s) => s.slug)).toEqual(["alpha"]);
  });

  it("keeps serving what it has when the stored roster no longer validates", async () => {
    // The image-rollback case: an overlay written by a newer image that this
    // one cannot make sense of must not take the gateway down.
    const store = new MemoryConfigStore();
    await store.write({
      version: 1,
      revision: 9,
      servers: {
        upserts: [{ slug: "broken", kind: "remote-http", url: "not-a-url" }],
        removals: [],
      },
    });
    const runtime = runtimeWith(store);

    expect(await runtime.poll()).toBe(false);
    expect(runtime.config().servers.map((s) => s.slug)).toEqual(["alpha"]);
  });

  it("keeps serving what it has when the rebuild fails", async () => {
    const store = new MemoryConfigStore();
    await store.write(plus(DELTA));
    const runtime = runtimeWith(store, () => Promise.reject(new Error("nope")));

    expect(await runtime.poll()).toBe(false);
    expect(runtime.config().servers.map((s) => s.slug)).toEqual(["alpha"]);
  });

  it("is lenient about unknown keys, unlike a write", async () => {
    const store = new MemoryConfigStore();
    await store.write({
      version: 1,
      revision: 4,
      servers: {
        upserts: [{ ...DELTA, entitlments: ["admin"] }],
        removals: [],
      },
    });
    const runtime = runtimeWith(store);

    expect(await runtime.poll()).toBe(true);
    // A write of the same document is refused, because the human is right here.
    const strict = runtime.evaluate({
      version: 1,
      revision: 5,
      servers: {
        upserts: [{ ...DELTA, entitlments: ["admin"] }],
        removals: [],
      },
    });
    expect(strict.ok).toBe(false);
  });
});

describe("readOverlayAtBoot", () => {
  it("returns an empty overlay and no config when there is no store", async () => {
    const boot = await readOverlayAtBoot(null, BASE_DOC);
    expect(boot.overlay).toEqual(EMPTY_OVERLAY);
    expect(boot.config).toBeNull();
  });

  it("boots on the checked-in document when the store will not answer", async () => {
    const boot = await readOverlayAtBoot(
      {
        backend: "x",
        writable: false,
        read: () => Promise.reject(new ParameterStoreError("down", 503)),
        write: () => Promise.resolve(),
      },
      BASE_DOC,
    );
    expect(boot.config).toBeNull();
  });

  it("boots on the checked-in document when the stored roster is invalid", async () => {
    const store = new MemoryConfigStore({
      version: 1,
      revision: 3,
      servers: {
        upserts: [{ slug: "x", kind: "remote-http", url: "nope" }],
        removals: [],
      },
    });
    const boot = await readOverlayAtBoot(store, BASE_DOC);
    expect(boot.config).toBeNull();
    expect(boot.overlay).toEqual(EMPTY_OVERLAY);
  });

  it("adopts a valid stored roster", async () => {
    const store = new MemoryConfigStore(plus(DELTA));
    const boot = await readOverlayAtBoot(store, BASE_DOC);
    expect(boot.config?.servers.map((s) => s.slug)).toEqual(["alpha", "delta"]);
  });
});

describe("ParameterConfigStore", () => {
  const PATH = "/strad/test/gateway/config/SERVERS";

  it("reads an absent parameter as an empty overlay", async () => {
    const store = new ParameterConfigStore(
      { reveal: () => Promise.reject(new ParameterStoreError("no such", 404)) },
      null,
      PATH,
    );
    expect(await store.read()).toEqual(EMPTY_OVERLAY);
  });

  it("propagates every other store failure", async () => {
    const store = new ParameterConfigStore(
      { reveal: () => Promise.reject(new ParameterStoreError("403", 403)) },
      null,
      PATH,
    );
    await expect(store.read()).rejects.toBeInstanceOf(ParameterStoreError);
  });

  it("rotates an existing parameter and creates an absent one", async () => {
    const calls: string[] = [];
    let exists = false;
    const writer = {
      rotate: (_p: string, _v: string) => {
        calls.push("rotate");
        return exists
          ? Promise.resolve()
          : Promise.reject(new ParameterStoreError("no such", 404));
      },
      create: (input: { path: string; secret: boolean }) => {
        calls.push("create");
        exists = true;
        expect(input.path).toBe(PATH);
        // NOT a secret: the roster is config, and a secret parameter would cost
        // a Secret Manager resource, an IAM grant and the render-injection rules.
        expect(input.secret).toBe(false);
        return Promise.resolve({
          path: PATH,
          variable: "SERVERS",
          secret: false,
          hasValue: true,
        });
      },
    };
    const store = new ParameterConfigStore(
      { reveal: () => Promise.resolve("") },
      writer,
      PATH,
    );

    await store.write(plus(DELTA));
    expect(calls).toEqual(["rotate", "create"]);

    calls.length = 0;
    await store.write(plus(DELTA));
    expect(calls).toEqual(["rotate"]);
  });

  it("is read-only, and says why, with no admin credential", async () => {
    const store = new ParameterConfigStore(
      { reveal: () => Promise.resolve("") },
      null,
      PATH,
    );
    expect(store.writable).toBe(false);
    await expect(store.write(EMPTY_OVERLAY)).rejects.toBeInstanceOf(
      ConfigStoreReadOnly,
    );
  });

  it("refuses a document over the ceiling", async () => {
    const store = new MemoryConfigStore();
    let overlay = EMPTY_OVERLAY;
    // Grow until it is genuinely over, rather than asserting on a magic count.
    for (let i = 0; serialiseOverlay(overlay).length < 64 * 1024; i++) {
      overlay = withUpsert(
        overlay,
        {
          slug: `s${i}`,
          kind: "remote-http",
          url: `https://example.com/${"x".repeat(400)}`,
        },
        { fileSlugs: new Set() },
      );
    }
    await expect(store.write(overlay)).rejects.toBeInstanceOf(
      ConfigStoreTooLarge,
    );
  });
});

describe("ConfigPoller", () => {
  it("polls on the interval and stops when told to", async () => {
    vi.useFakeTimers();
    try {
      const store = new MemoryConfigStore();
      const runtime = runtimeWith(store);
      const poller = new ConfigPoller(runtime, 1000);
      poller.start();

      await store.write(plus(DELTA));
      await vi.advanceTimersByTimeAsync(1000);
      expect(runtime.config().servers.map((s) => s.slug)).toEqual([
        "alpha",
        "delta",
      ]);

      poller.stop();
      await store.write(
        withRemoval(runtime.overlay(), "delta", {
          fileSlugs: new Set(["alpha"]),
        }),
      );
      await vi.advanceTimersByTimeAsync(5000);
      expect(runtime.config().servers.map((s) => s.slug)).toEqual([
        "alpha",
        "delta",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});
