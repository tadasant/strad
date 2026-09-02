import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tokenStoreFromConfig } from "../src/auth/index.ts";
import { parseConfig } from "../src/config/load.ts";
import { Registry } from "../src/gateway/registry.ts";
import { createApp } from "../src/http/app.ts";
import {
  EnvSecretProvider,
  sharedSecretProviders,
} from "../src/secrets/provider/index.ts";
import {
  createStoreRefreshClient,
  parseStoreRefreshResponse,
  PARAM_PROTOCOL,
  STORE_REFRESH_FLOOR_MS,
  STORE_REFRESH_ROUTE,
} from "../src/secrets/param-route.ts";
import { createFakeGcp } from "../src/secrets/parameters/fake.ts";
import { readStoreDiagnosticsCached } from "../src/secrets/store-diagnostics.ts";

/**
 * The store re-read route, and the client the `secrets` MCP server calls it
 * with — the agent's copy of the console's "Re-read the store" button.
 *
 * Three properties, each of which is a way this could be wrong rather than
 * merely absent:
 *
 *   1. IT DROPS WHAT A CONSOLE WRITE DROPS, and nothing else: the runtime
 *      providers' reading and the diagnosis pass. It writes nothing.
 *   2. IT IS GATED like the write-back wire — the internal token, constant-time
 *      compared — and refuses BEFORE it does anything.
 *   3. IT HAS A FLOOR. A caller in a loop cannot make core enumerate the store
 *      more than once per `STORE_REFRESH_FLOOR_MS`; the second call inside the
 *      floor is answered, honestly, as not refreshed.
 *
 * And the client never throws: a refresh is best-effort, the TTL lands the
 * value regardless, so every failure is a reason the agent can read.
 */

const CONFIG = parseConfig(`
version: 1
gateway: { name: strad, env: test }
auth: { staticTokens: { enabled: true } }
roles: { admin: { servers: ["*"] } }
bundles:
  - name: bundle-secrets
servers:
  - slug: secrets
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle-secrets
    path: /secrets
    entitlements: [admin]
    env:
      SECRETS_PROJECT_ID: "strad-secrets-test"
      SECRETS_NAMESPACES: "/strad/test/mcp/"
`);

const TOKEN = "InternalTokenValueNeverShown";
const GATEWAY_NS = "/strad/test/gateway/static/";

const fake = createFakeGcp();

/** The clock the floor is measured on. */
let clock = 1_700_000_000_000;

/** The runtime providers, counting how often the route tells them to re-read. */
let invalidations = 0;
const runtimeEnv = new EnvSecretProvider({});
const runtimeProviders = sharedSecretProviders({
  name: runtimeEnv.name,
  get: (name: string) => runtimeEnv.get(name),
  invalidate: () => {
    invalidations += 1;
  },
});

/** The diagnosis store, counting index passes that actually ran. */
const diagnostic = {
  lists: 0,
  store: {
    list: async (namespace: string) => {
      diagnostic.lists += 1;
      return fake.store.list(namespace);
    },
    resolveDetailed: (namespace: string) =>
      fake.store.resolveDetailed!(namespace),
  },
};

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const env: NodeJS.ProcessEnv = {
    STRAD_MODE: "core",
    STRAD_INTERNAL_TOKEN: TOKEN,
    STRAD_BUNDLE_URL_BUNDLE_SECRETS: "http://bundle-secrets:8080",
  };
  const app = createApp({
    config: CONFIG,
    registry: await Registry.build({
      config: CONFIG,
      secrets: runtimeProviders,
      mode: "core",
      env,
    }),
    tokenStore: tokenStoreFromConfig(CONFIG, env),
    mode: "core",
    env,
    parametersStore: () => fake.store,
    secretProvider: runtimeProviders,
    diagnosticStore: diagnostic.store,
    now: () => clock,
  });
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
});

async function post(token: string | undefined): Promise<Response> {
  return fetch(`${baseUrl}${STORE_REFRESH_ROUTE}`, {
    method: "POST",
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  });
}

/** The answer to a well-formed call, typed as the wire says it is. */
async function answer(): Promise<{ refreshed: boolean }> {
  return (await (await post(TOKEN)).json()) as { refreshed: boolean };
}

/** A diagnosis pass, primed so the route has something to drop. */
async function primeDiagnosis(): Promise<number> {
  await readStoreDiagnosticsCached({
    store: diagnostic.store,
    namespace: GATEWAY_NS,
    ttlMs: 60_000,
  });
  return diagnostic.lists;
}

describe("the route", () => {
  it("drops the providers' reading and the diagnosis pass, and writes nothing", async () => {
    clock += STORE_REFRESH_FLOOR_MS;
    const passes = await primeDiagnosis();
    const before = invalidations;
    const payloads = fake.pmPayloads().length;

    const res = await post(TOKEN);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      protocol: PARAM_PROTOCOL,
      ok: true,
      refreshed: true,
    });
    expect(invalidations).toBe(before + 1);
    // The held pass went too: the next diagnosis runs a fresh one.
    await readStoreDiagnosticsCached({
      store: diagnostic.store,
      namespace: GATEWAY_NS,
      ttlMs: 60_000,
    });
    expect(diagnostic.lists).toBe(passes + 1);
    expect(fake.pmPayloads()).toHaveLength(payloads);
  });

  it("holds a second call inside the floor off, and says so", async () => {
    clock += STORE_REFRESH_FLOOR_MS;
    expect((await answer()).refreshed).toBe(true);
    const before = invalidations;

    clock += STORE_REFRESH_FLOOR_MS - 1_000;
    const held = await (await post(TOKEN)).json();
    expect(held).toEqual({
      protocol: PARAM_PROTOCOL,
      ok: true,
      refreshed: false,
      ageSeconds: STORE_REFRESH_FLOOR_MS / 1000 - 1,
    });
    expect(invalidations).toBe(before);

    // And past the floor it refreshes again.
    clock += 1_000;
    expect((await answer()).refreshed).toBe(true);
    expect(invalidations).toBe(before + 1);
  });

  it("refuses without the token, and before touching anything", async () => {
    clock += STORE_REFRESH_FLOOR_MS;
    const before = invalidations;
    expect((await post(undefined)).status).toBe(401);
    expect((await post("not-the-token")).status).toBe(401);
    expect(invalidations).toBe(before);
  });
});

describe("the client the secrets server calls with", () => {
  it("reports a refresh, and a floored one, as outcomes rather than throws", async () => {
    clock += STORE_REFRESH_FLOOR_MS;
    const client = createStoreRefreshClient({ baseUrl, token: TOKEN });
    expect(client.unconfigured()).toBeNull();
    expect(await client.refresh()).toEqual({ refreshed: true });

    const floored = await client.refresh();
    expect(floored.refreshed).toBe(false);
    if (!floored.refreshed) {
      expect(floored.reason).toMatch(/will not again inside 30s/);
    }
  });

  it("names what is missing when it is not configured, and never throws", async () => {
    const noUrl = createStoreRefreshClient({
      baseUrl: undefined,
      token: TOKEN,
    });
    expect(noUrl.unconfigured()).toBe("STRAD_CORE_URL is not set");
    expect(await noUrl.refresh()).toEqual({
      refreshed: false,
      reason: "STRAD_CORE_URL is not set",
    });
    const noToken = createStoreRefreshClient({ baseUrl, token: undefined });
    expect(noToken.unconfigured()).toBe("STRAD_INTERNAL_TOKEN is not set");
  });

  it("turns a refusal and an unreachable core into reasons", async () => {
    clock += STORE_REFRESH_FLOOR_MS;
    const wrong = createStoreRefreshClient({ baseUrl, token: "wrong" });
    expect(await wrong.refresh()).toEqual({
      refreshed: false,
      reason: "core answered HTTP 401",
    });
    const dead = createStoreRefreshClient({
      baseUrl: "http://127.0.0.1:1",
      token: TOKEN,
      timeoutMs: 500,
    });
    const outcome = await dead.refresh();
    expect(outcome.refreshed).toBe(false);
    if (!outcome.refreshed)
      expect(outcome.reason).toMatch(/could not reach core/);
  });

  it("treats an answer it does not understand as not refreshed", () => {
    expect(
      parseStoreRefreshResponse({ protocol: 99, ok: true, refreshed: true }),
    ).toEqual({
      ok: false,
      error: "unknown protocol 99",
    });
    expect(parseStoreRefreshResponse("nope")).toEqual({
      ok: false,
      error: "response is not an object",
    });
    expect(
      parseStoreRefreshResponse({
        protocol: PARAM_PROTOCOL,
        ok: true,
        refreshed: false,
        ageSeconds: 4,
      }),
    ).toEqual({ ok: true, refreshed: false, ageSeconds: 4 });
  });
});
