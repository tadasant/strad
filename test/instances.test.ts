import type { Express } from "express";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tokenStoreFromConfig } from "../src/auth/index.ts";
import { parseConfig, parseYamlDocument } from "../src/config/load.ts";
import {
  EMPTY_OVERLAY,
  NotRuntimeCreatable,
  ReachExceeded,
  validateMerged,
  withRemoval,
  withUpsert,
  type WritingPrincipal,
} from "../src/config/overlay.ts";
import { ConfigRejected, RuntimeConfig } from "../src/config/runtime.ts";
import type { StradConfig } from "../src/config/schema.ts";
import { MemoryConfigStore } from "../src/config/store.ts";
import { renderAppSpec } from "../src/deploy/appspec.ts";
import { Registry } from "../src/gateway/registry.ts";
import { createApp } from "../src/http/app.ts";
import {
  createInstanceClient,
  createInstanceReconciler,
  instanceSyncSeconds,
  parseInstancePath,
  type InstanceClient,
  type InstanceDescriptor,
  type InstanceTree,
  PARAM_PROTOCOL,
} from "../src/secrets/param-route.ts";
import { createFakeGcp } from "../src/secrets/parameters/fake.ts";
import {
  gatewayParameterPath,
  serverParameterPath,
} from "../src/secrets/parameters/index.ts";
import {
  EnvSecretProvider,
  sharedSecretProviders,
} from "../src/secrets/provider/index.ts";

/**
 * Store-served instances end to end — strad#343, phase 3 of the runtime-config
 * plan: a `supplementary-image` slug created at RUNTIME, credentialed from the
 * parameter store, and discovered by the bundle host with no environment
 * variable and no deploy.
 *
 * Asserted against the real pieces, the way `test/params-refresh.test.ts` is:
 * core's actual `/_strad/instances` routes over a real socket, the in-memory
 * Parameter Manager + Secret Manager double behind them, the real
 * `RuntimeConfig` holder rebuilding the app on a roster write, and the client
 * and reconciler from `src/secrets/param-route.ts` — byte-identical to the copy
 * the bundle host runs (test/vendored.sync.test.ts).
 *
 * The thing standing in for the bundle host is the reconciler with a `build`
 * that records what it was handed. Nothing in this file gives it an
 * environment: what it knows about which slugs exist and what they hold, it
 * learned from core.
 */

const TOKEN = "InternalTokenValueNeverShown";
const IMAGE = "ghcr.io/tadasant/strad-bundle:latest";

const YAML = `
version: 1
gateway:
  name: strad
  env: test
  secrets: { provider: gcp-parameter-store }
auth: { staticTokens: { enabled: true } }
roles:
  admin: { servers: ["*"] }
  narrow: { servers: [telegram] }
  nobody: { servers: [] }
bundles:
  - name: bundle
  - name: bundle-other
servers:
  - slug: telegram
    kind: supplementary-image
    image: ${IMAGE}
    bundle: bundle
    path: /telegram
    entitlements: [admin, narrow]
  - slug: telegram-work
    kind: supplementary-image
    image: ${IMAGE}
    bundle: bundle
    path: /_instance/telegram/telegram-work
    entitlements: [admin]
    params: true
  - slug: grafana-elsewhere
    kind: supplementary-image
    image: ${IMAGE}
    bundle: bundle-other
    path: /_instance/grafana/grafana-elsewhere
    entitlements: [admin]
    params: true
  - slug: telegram-off
    kind: supplementary-image
    image: ${IMAGE}
    bundle: bundle
    path: /_instance/telegram/telegram-off
    entitlements: [admin]
    params: true
    enabled: false
`;

const BASE_DOC = parseYamlDocument(YAML);
const CONFIG = parseConfig(YAML);

const ADMIN: WritingPrincipal = { roles: ["admin"] };
const NARROW: WritingPrincipal = { roles: ["narrow"] };
const NOBODY: WritingPrincipal = { roles: ["nobody"] };

const ENV: NodeJS.ProcessEnv = {
  STRAD_MODE: "core",
  STRAD_INTERNAL_TOKEN: TOKEN,
  STRAD_BUNDLE_URL_BUNDLE: "http://bundle:8080",
  STRAD_BUNDLE_URL_BUNDLE_OTHER: "http://bundle-other:8080",
  // In CORE's environment, where a runtime-authored entry must never reach it.
  TELEGRAM_STRING_SESSION: "core-process-environment-session",
};

/** A runtime-created instance: a second Telegram account, no deploy. */
const PERSONAL = {
  slug: "telegram-personal",
  kind: "supplementary-image",
  image: IMAGE,
  bundle: "bundle",
  path: "/_instance/telegram/telegram-personal",
  entitlements: ["admin"],
  params: true,
};

const staticPath = (slug: string, name: string) =>
  serverParameterPath("test", slug, "static", name);
const oauthPath = (slug: string, name: string) =>
  serverParameterPath("test", slug, "oauth", name);

const fake = createFakeGcp();
let server: Server;
let baseUrl: string;
let runtime: RuntimeConfig;
let current: Express;

async function buildApp(config: StradConfig): Promise<Express> {
  return createApp({
    config,
    registry: await Registry.build({
      config,
      secrets: sharedSecretProviders(new EnvSecretProvider({})),
      mode: "core",
      env: ENV,
    }),
    tokenStore: tokenStoreFromConfig(config, ENV),
    mode: "core",
    env: ENV,
    resolver: fake.store,
  });
}

beforeAll(async () => {
  // telegram-work: the checked-in instance's own account.
  await fake.store.create({
    path: staticPath("telegram-work", "TELEGRAM_API_ID"),
    secret: false,
    value: "1111",
  });
  await fake.store.create({
    path: staticPath("telegram-work", "TELEGRAM_API_HASH"),
    secret: true,
    value: "work-hash",
  });
  await fake.store.create({
    path: staticPath("telegram-work", "TELEGRAM_STRING_SESSION"),
    secret: true,
    value: "work-session",
  });
  // The GATEWAY namespace holds a session too. An instance must never see it:
  // it is not that slug's, and the per-server provider chain ends there.
  await fake.store.create({
    path: gatewayParameterPath("test", "TELEGRAM_STRING_SESSION"),
    secret: true,
    value: "gateway-namespace-session",
  });

  current = await buildApp(CONFIG);
  server = createServer((req, res) => current(req, res));
  server.listen(0);
  await new Promise((r) => server.once("listening", r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  runtime = new RuntimeConfig({
    baseDocument: BASE_DOC,
    config: CONFIG,
    overlay: EMPTY_OVERLAY,
    store: new MemoryConfigStore(),
    // The same rebuild core does: a new app from the new config, swapped in
    // under the socket (src/gateway/reload.ts).
    rebuild: async (next) => {
      current = await buildApp(next);
    },
    env: ENV,
  });
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
});

interface Built {
  tree: InstanceTree;
  slug: string;
  env: Record<string, string>;
  closed: boolean;
}

/** The bundle host, reduced to what it learns from core and what it builds. */
function host(bundle = "bundle") {
  const built: Built[] = [];
  let clock = 0;
  const reconciler = createInstanceReconciler<Built>({
    client: createInstanceClient({ baseUrl, token: TOKEN, bundle }),
    build: async (tree, slug, env) => {
      const instance = { tree, slug, env, closed: false };
      built.push(instance);
      return instance;
    },
    dispose: (instance) => {
      instance.closed = true;
    },
    now: () => clock,
  });
  return {
    reconciler,
    built,
    advance: (ms: number) => {
      clock += ms;
    },
    envOf: (slug: string) => reconciler.held().get(slug)?.value.env,
  };
}

const get = (path: string, token: string | null = TOKEN) =>
  fetch(`${baseUrl}${path}`, {
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
  });

describe("a slug created at runtime is served by the bundle, with no deploy", () => {
  it("is discovered from core, credentialed from its own namespace, rotated, and removed", async () => {
    const h = host();

    // Boot: the checked-in instance, and nothing else. The disabled one is not
    // listed, and the other bundle's is not this component's.
    const boot = await h.reconciler.sync();
    expect(boot.added).toEqual(["telegram-work"]);
    expect(h.envOf("telegram-work")).toEqual({
      TELEGRAM_API_ID: "1111",
      TELEGRAM_API_HASH: "work-hash",
      TELEGRAM_STRING_SESSION: "work-session",
    });
    expect(h.reconciler.held().has(PERSONAL.slug)).toBe(false);

    // A human seeds the second account's credentials — through the console's
    // secrets page, in production. The session lands under `oauth/` AND a stale
    // hand-seeded copy sits under `static/`: the layering must pick `oauth/`.
    await fake.store.create({
      path: staticPath(PERSONAL.slug, "TELEGRAM_API_ID"),
      secret: false,
      value: "2222",
    });
    await fake.store.create({
      path: staticPath(PERSONAL.slug, "TELEGRAM_API_HASH"),
      secret: true,
      value: "personal-hash",
    });
    await fake.store.create({
      path: staticPath(PERSONAL.slug, "TELEGRAM_STRING_SESSION"),
      secret: true,
      value: "stale-static-session",
    });
    await fake.store.create({
      path: oauthPath(PERSONAL.slug, "TELEGRAM_STRING_SESSION"),
      secret: true,
      value: "personal-session",
    });

    // Then creates the slug — through the same seam both doors call.
    expect(() =>
      runtime.assertAcceptable(PERSONAL, undefined, ADMIN),
    ).not.toThrow();
    await runtime.apply(
      withUpsert(runtime.overlay(), PERSONAL, {
        fileSlugs: runtime.fileSlugs(),
      }),
    );

    // THE CLAIM, part one: the first request for the new path is a miss, and the
    // miss path finds it — no sync interval, no container environment, no deploy.
    h.advance(10_000);
    await h.reconciler.syncOnMiss();
    expect(h.reconciler.held().get(PERSONAL.slug)?.tree).toBe("telegram");
    expect(h.envOf(PERSONAL.slug)).toEqual({
      TELEGRAM_API_ID: "2222",
      TELEGRAM_API_HASH: "personal-hash",
      TELEGRAM_STRING_SESSION: "personal-session",
    });
    // Nothing from core's own environment and nothing from the gateway
    // namespace, although both hold a TELEGRAM_STRING_SESSION.
    expect(JSON.stringify(h.built)).not.toContain(
      "core-process-environment-session",
    );
    expect(JSON.stringify(h.built)).not.toContain("gateway-namespace-session");

    // Part two: a rotation in the store rebuilds the instance, and releases the
    // one it replaces rather than leaving it holding the old login.
    const before = h.reconciler.held().get(PERSONAL.slug)!.value;
    await fake.store.rotate(
      oauthPath(PERSONAL.slug, "TELEGRAM_STRING_SESSION"),
      "personal-session-rotated",
    );
    const rotated = await h.reconciler.sync();
    expect(rotated.changed).toEqual([PERSONAL.slug]);
    expect(before.closed).toBe(true);
    expect(h.envOf(PERSONAL.slug)?.TELEGRAM_STRING_SESSION).toBe(
      "personal-session-rotated",
    );

    // A sync with nothing moved rebuilds nothing.
    const quiet = await h.reconciler.sync();
    expect(quiet).toMatchObject({
      added: [],
      changed: [],
      removed: [],
      failed: [],
    });

    // Part three: removing the slug removes the instance.
    const held = h.reconciler.held().get(PERSONAL.slug)!.value;
    await runtime.apply(
      withRemoval(runtime.overlay(), PERSONAL.slug, {
        fileSlugs: runtime.fileSlugs(),
      }),
    );
    const removed = await h.reconciler.sync();
    expect(removed.removed).toEqual([PERSONAL.slug]);
    expect(held.closed).toBe(true);
    expect(h.reconciler.held().has(PERSONAL.slug)).toBe(false);
    // And the checked-in one was never touched by any of it.
    expect(h.reconciler.held().has("telegram-work")).toBe(true);
  });

  it("lists only the asking component's instances", async () => {
    const other = host("bundle-other");
    const outcome = await other.reconciler.sync();
    expect(outcome.added).toEqual(["grafana-elsewhere"]);
    // An empty namespace is served as an empty environment, so the instance is
    // built and degrades on its own missing-credential check.
    expect(other.envOf("grafana-elsewhere")).toEqual({});
  });
});

describe("the instance routes", () => {
  it("refuse a caller without the internal token", async () => {
    expect((await get("/_strad/instances?bundle=bundle", null)).status).toBe(
      401,
    );
    expect((await get("/_strad/instances/telegram-work", null)).status).toBe(
      401,
    );
    expect(
      (await get("/_strad/instances/telegram-work", "wrong")).status,
    ).not.toBe(200);
  });

  it("need the asking bundle named", async () => {
    expect((await get("/_strad/instances")).status).toBe(400);
  });

  it("give ONE answer for every slug that is not a served instance", async () => {
    const answers = await Promise.all(
      ["telegram", "no-such-slug", "telegram-off", "..%2Fgateway"].map(
        async (slug) => {
          const res = await get(`/_strad/instances/${slug}`);
          return { status: res.status, body: await res.json() };
        },
      ),
    );
    for (const answer of answers) {
      expect(answer).toEqual({
        status: 403,
        body: { error: "instance_not_served" },
      });
    }
  });

  it("serve one slug's namespace, never a sibling's and never the gateway's", async () => {
    const res = await get("/_strad/instances/telegram-work");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      protocol: PARAM_PROTOCOL,
      slug: "telegram-work",
      tree: "telegram",
      env: {
        TELEGRAM_API_ID: "1111",
        TELEGRAM_API_HASH: "work-hash",
        TELEGRAM_STRING_SESSION: "work-session",
      },
    });
  });

  it("answer 503 rather than reading anything when this gateway has no store", async () => {
    const app = createApp({
      config: CONFIG,
      registry: await Registry.build({
        config: CONFIG,
        secrets: sharedSecretProviders(new EnvSecretProvider({})),
        mode: "core",
        env: ENV,
      }),
      tokenStore: tokenStoreFromConfig(CONFIG, ENV),
      mode: "core",
      env: ENV,
    });
    const s = app.listen(0);
    await new Promise((r) => s.once("listening", r));
    try {
      const port = (s.address() as { port: number }).port;
      const res = await fetch(
        `http://127.0.0.1:${port}/_strad/instances/telegram-work`,
        {
          headers: { authorization: `Bearer ${TOKEN}` },
        },
      );
      expect(res.status).toBe(503);
    } finally {
      await new Promise((r) => s.close(r));
    }
  });
});

describe("what a runtime write may now create, and what it still may not", () => {
  const onInstance = (extra: Record<string, unknown>) => ({
    ...PERSONAL,
    ...extra,
  });

  it("accepts params: true on the entry's own instance path", () => {
    expect(() =>
      runtime.assertAcceptable(onInstance({}), undefined, ADMIN),
    ).not.toThrow();
  });

  it("still refuses every other deploy-only field on an instance, by name", () => {
    const refusals: [string, Record<string, unknown>][] = [
      ["env", { env: { TELEGRAM_API_ID: "${TG_ID}" } }],
      ["paramsWritable", { paramsWritable: ["TELEGRAM_STRING_SESSION"] }],
      ["paramsRefresh", { paramsRefresh: ["TELEGRAM_STRING_SESSION"] }],
      ["consoleEnv", { consoleEnv: { X: "${Y}" } }],
    ];
    for (const [field, extra] of refusals) {
      expect(() =>
        runtime.assertAcceptable(onInstance(extra), undefined, ADMIN),
      ).toThrow(NotRuntimeCreatable);
      expect(() =>
        runtime.assertAcceptable(onInstance(extra), undefined, ADMIN),
      ).toThrow(new RegExp(`store-served instance.*${field}`));
    }
  });

  it("still refuses params: true on an ordinary path, and says where the instance path is", () => {
    const ordinary = { ...PERSONAL, slug: "telegram-copy", path: "/telegram" };
    expect(() => runtime.assertAcceptable(ordinary, undefined, ADMIN)).toThrow(
      NotRuntimeCreatable,
    );
    expect(() => runtime.assertAcceptable(ordinary, undefined, ADMIN)).toThrow(
      /\/_instance\/\{tree\}\/\{its own slug\}/,
    );
  });

  it("still names a credential and never carries one — references only", () => {
    expect(() =>
      runtime.assertAcceptable(
        onInstance({ headers: { "X-Api-Key": "a-literal-credential" } }),
        undefined,
        ADMIN,
      ),
    ).toThrow(/X-Api-Key/);
  });

  it("refuses an instance path that names ANOTHER slug, even for admin", async () => {
    // The mount bound does not refuse this for admin — admin reaches the
    // checked-in `telegram-work` on that path, the same reach that allows a
    // `-ro` / `-rw` pair on an ordinary mount. The SCHEMA does, when the write is
    // applied: an instance path selects a namespace, so it must be the entry's
    // own. Both doors apply after they assert, so this is the refusal both see.
    const squatter = onInstance({
      slug: "squatter",
      path: "/_instance/telegram/telegram-work",
    });
    const before = runtime.overlay();
    await expect(
      runtime.apply(
        withUpsert(before, squatter, { fileSlugs: runtime.fileSlugs() }),
      ),
    ).rejects.toThrow(ConfigRejected);
    await expect(
      runtime.apply(
        withUpsert(before, squatter, { fileSlugs: runtime.fileSlugs() }),
      ),
    ).rejects.toThrow(/path: \/_instance\/telegram\/squatter/);
    expect(runtime.overlay()).toBe(before);
  });

  it("lets a narrow writer create an instance on a component it already reaches", () => {
    expect(() =>
      runtime.assertAcceptable(
        onInstance({ entitlements: ["narrow"] }),
        undefined,
        NARROW,
      ),
    ).not.toThrow();
  });

  it("refuses one on a component the writer reaches nothing on", () => {
    const elsewhere = onInstance({
      slug: "grafana-mine",
      bundle: "bundle-other",
      path: "/_instance/grafana/grafana-mine",
      entitlements: ["narrow"],
    });
    expect(() =>
      runtime.assertAcceptable(elsewhere, undefined, NARROW),
    ).toThrow(ReachExceeded);
    expect(() =>
      runtime.assertAcceptable(elsewhere, undefined, NARROW),
    ).toThrow(/bundle-other/);
    expect(() =>
      runtime.assertAcceptable(
        onInstance({ entitlements: ["nobody"] }),
        undefined,
        NOBODY,
      ),
    ).toThrow(ReachExceeded);
  });
});

describe("the schema's instance rules", () => {
  const withServer = (entry: Record<string, unknown>) => {
    const doc = structuredClone(BASE_DOC) as { servers: unknown[] };
    doc.servers.push(entry);
    return validateMerged(doc, { strict: true });
  };
  const problems = (entry: Record<string, unknown>) => {
    const result = withServer(entry);
    return result.ok ? [] : result.problems;
  };

  it("accepts a well-formed instance, and a connector on one", () => {
    expect(problems(PERSONAL)).toEqual([]);
    expect(
      problems({
        ...PERSONAL,
        oauth: { provider: "google", scopes: ["openid"] },
      }).filter((p) => p.includes("serves path")),
    ).toEqual([]);
  });

  it("refuses a malformed instance path, an unknown tree, and a path naming another slug", () => {
    expect(
      problems({ ...PERSONAL, path: "/_instance/telegram" }).join(),
    ).toMatch(/not an instance path/);
    expect(
      problems({
        ...PERSONAL,
        path: "/_instance/gmail/telegram-personal",
      }).join(),
    ).toMatch(/not an instance path/);
    expect(
      problems({
        ...PERSONAL,
        path: "/_instance/telegram/someone-else",
      }).join(),
    ).toMatch(/path: \/_instance\/telegram\/telegram-personal/);
  });

  it("requires params: true and refuses what the render would deliver", () => {
    expect(problems({ ...PERSONAL, params: false }).join()).toMatch(
      /params: true/,
    );
    expect(problems({ ...PERSONAL, env: { A: "${B}" } }).join()).toMatch(
      /declares env:/,
    );
  });

  it("requires the store provider", () => {
    const doc = structuredClone(BASE_DOC) as {
      gateway: { secrets: { provider: string } };
      servers: Record<string, unknown>[];
    };
    doc.gateway.secrets.provider = "env";
    const result = validateMerged(doc, { strict: true });
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.problems.join()).toMatch(
      /gcp-parameter-store/,
    );
  });
});

describe("the reconciler's failure posture", () => {
  const ONE: InstanceDescriptor = { slug: "a", tree: "telegram" };

  function scripted(script: {
    list: () => Awaited<ReturnType<InstanceClient["list"]>>;
    env: () => Awaited<ReturnType<InstanceClient["env"]>>;
  }) {
    let lists = 0;
    const client: InstanceClient = {
      unconfigured: () => null,
      list: async () => {
        lists += 1;
        return script.list();
      },
      env: async () => script.env(),
    };
    return { client, lists: () => lists };
  }

  it("changes nothing when the list cannot be read", async () => {
    let listOk = true;
    const s = scripted({
      list: () =>
        listOk
          ? { ok: true, instances: [ONE] }
          : { ok: false, reason: "core answered HTTP 502" },
      env: () => ({ ok: true, env: { K: "v" } }),
    });
    const r = createInstanceReconciler({
      client: s.client,
      build: async () => "instance",
    });
    await r.sync();
    listOk = false;
    const outcome = await r.sync();
    expect(outcome.listFailed).toMatch(/502/);
    expect(r.held().get("a")?.value).toBe("instance");
  });

  it("keeps a held instance on its reading when its env cannot be read, and when a rebuild throws", async () => {
    let envOk = true;
    let value = "v1";
    let buildOk = true;
    const s = scripted({
      list: () => ({ ok: true, instances: [ONE] }),
      env: () =>
        envOk
          ? { ok: true, env: { K: value } }
          : { ok: false, reason: "core answered HTTP 500" },
    });
    const r = createInstanceReconciler({
      client: s.client,
      build: async (_t, _s, env) => {
        if (!buildOk) throw new TypeError("boom");
        return env.K;
      },
    });
    await r.sync();
    envOk = false;
    expect((await r.sync()).failed).toEqual([
      { slug: "a", reason: "core answered HTTP 500" },
    ]);
    expect(r.held().get("a")?.value).toBe("v1");

    envOk = true;
    buildOk = false;
    value = "v2";
    expect((await r.sync()).failed[0]?.reason).toMatch(/TypeError/);
    expect(r.held().get("a")?.value).toBe("v1");
  });

  it("shares one pass between concurrent syncs, and bounds a miss by the floor", async () => {
    let clock = 0;
    const s = scripted({
      list: () => ({ ok: true, instances: [] }),
      env: () => ({ ok: true, env: {} }),
    });
    const r = createInstanceReconciler({
      client: s.client,
      build: async () => null,
      now: () => clock,
      missFloorMs: 5_000,
    });
    // Two syncs share one pass. The miss waits for it and then syncs AGAIN:
    // that pass may have listed before the write that created the slug.
    await Promise.all([r.sync(), r.sync(), r.syncOnMiss()]);
    expect(s.lists()).toBe(2);
    // An interval sync does not use up the miss floor...
    await r.sync();
    expect(s.lists()).toBe(3);
    // ...but a second miss inside it is refused, and one at the floor is not.
    clock = 4_999;
    await r.syncOnMiss();
    expect(s.lists()).toBe(3);
    clock = 5_000;
    await r.syncOnMiss();
    expect(s.lists()).toBe(4);
  });

  it("reports what it could not build, and rebuilds a slug whose tree changed", async () => {
    let tree: InstanceTree = "telegram";
    let envOk = false;
    const s = scripted({
      list: () => ({ ok: true, instances: [{ slug: "a", tree }] }),
      env: () =>
        envOk
          ? { ok: true, env: { K: "v" } }
          : { ok: false, reason: "core answered HTTP 502" },
    });
    const disposed: string[] = [];
    const r = createInstanceReconciler<string>({
      client: s.client,
      build: async (t) => t,
      dispose: (value) => {
        disposed.push(value);
      },
    });

    await r.sync();
    expect(r.unbuilt().get("a")).toEqual({
      tree: "telegram",
      reason: "core answered HTTP 502",
    });

    envOk = true;
    await r.sync();
    expect(r.unbuilt().size).toBe(0);
    expect(r.held().get("a")?.value).toBe("telegram");

    tree = "grafana";
    const outcome = await r.sync();
    expect(outcome.removed).toEqual(["a"]);
    expect(outcome.added).toEqual(["a"]);
    expect(disposed).toEqual(["telegram"]);
    expect(r.held().get("a")?.value).toBe("grafana");
  });

  it("treats an answer on an unfamiliar protocol as unreadable, not as empty", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ protocol: 999, instances: [] }), {
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    const client = createInstanceClient({
      baseUrl: "http://core",
      token: "t",
      bundle: "b",
      fetchImpl,
    });
    expect(await client.list()).toMatchObject({ ok: false });
  });

  it("says why it cannot sync when the component is not wired to core", async () => {
    const client = createInstanceClient({
      baseUrl: undefined,
      token: "t",
      bundle: "b",
    });
    expect(client.unconfigured()).toMatch(/STRAD_CORE_URL/);
    const r = createInstanceReconciler({ client, build: async () => null });
    expect((await r.sync()).listFailed).toMatch(/STRAD_CORE_URL/);
  });
});

describe("the instance path and interval helpers", () => {
  it("parse only the trees the host can build", () => {
    expect(parseInstancePath("/_instance/google-sheets/sheets-home")).toEqual({
      tree: "google-sheets",
      slug: "sheets-home",
    });
    expect(parseInstancePath("/_instance/gmail/x")).toBeNull();
    expect(parseInstancePath("/_instance/telegram/Bad_Slug")).toBeNull();
    expect(parseInstancePath("/_instance/telegram/a/b")).toBeNull();
    expect(parseInstancePath("/telegram")).toBeNull();
  });

  it("clamp the sync interval to its floor", () => {
    expect(instanceSyncSeconds({})).toBe(60);
    expect(instanceSyncSeconds({ STRAD_INSTANCE_SYNC_SECONDS: "1" })).toBe(15);
    expect(instanceSyncSeconds({ STRAD_INSTANCE_SYNC_SECONDS: "nope" })).toBe(
      60,
    );
  });
});

describe("the render bakes nothing for an instance", () => {
  it("gives the component no variable, alias or manifest entry for it — and still renders the component", () => {
    const spec = renderAppSpec({
      config: CONFIG,
      appName: "strad-test",
      region: "nyc",
      image: {
        registry_type: "GHCR",
        registry: "tadasant",
        repository: "strad",
        tag: "latest",
      },
      env: [],
      // Even when a deploy's resolver DID read the namespace, nothing lands: a
      // bare-named copy would be read by the conventional /telegram mount.
      resolvedParams: {
        "telegram-work": { TELEGRAM_STRING_SESSION: "work-session" },
      },
    });
    const other = spec.services.find((c) => c.name === "bundle-other");
    const bundle = spec.services.find((c) => c.name === "bundle");
    expect(other).toBeDefined();
    expect(bundle).toBeDefined();
    const text = JSON.stringify(bundle!.envs);
    expect(text).not.toContain("TELEGRAM_");
    expect(text).not.toContain("work-session");
    expect(text).not.toContain("STRAD_PARAM_KEYS");
    // And it still gets the private URL it calls core on.
    expect(bundle!.envs.some((e) => e.key === "STRAD_CORE_URL")).toBe(true);
  });
});
