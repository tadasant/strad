import type { Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ParameterTokenStore, mintToken } from "../src/auth/tokens.ts";
import { parseConfig } from "../src/config/load.ts";
import { Registry } from "../src/gateway/registry.ts";
import { createApp } from "../src/http/app.ts";
import type { ParameterResolver } from "../src/secrets/parameters/types.ts";
import {
  EnvSecretProvider,
  sharedSecretProviders,
  StoreSecretProvider,
} from "../src/secrets/provider/index.ts";

/**
 * tadasant/strad#523, end to end through `/mcp`.
 *
 * A secret write calls `invalidate()` on the shared provider, which drops the
 * gateway namespace's last known good map — and `STRAD_TOKENS` is read through
 * that namespace on every `/mcp` request (`auth.staticTokens.store:
 * parameter-store`). The next request's read is therefore a read with nothing
 * held, and one transient failure of it was a `500` and a `strad.route_failed`
 * on a fresh pod seconds after its OAuth refresh write-back.
 *
 * Two halves, and both matter: a single failed read is retried and the request
 * succeeds; a store that stays unreadable still fails closed, still answers
 * 500, and still logs both events, so it still pages.
 */

const CONFIG = parseConfig(`
version: 1
gateway: { name: strad, env: test }
auth:
  staticTokens: { enabled: true }
roles:
  admin: { servers: ["*"] }
servers:
  - slug: alpha
    kind: builtin
    module: "./servers/echo.js"
    entitlements: [admin]
`);

const token = mintToken({ env: "test", label: "admin", roles: ["admin"] });

/** The gateway namespace: `STRAD_TOKENS`, failing its next `n` reads on demand. */
function flakyStore() {
  let failNext = 0;
  let reads = 0;
  const resolver: ParameterResolver = {
    async resolve() {
      reads += 1;
      if (failNext > 0) {
        failNext -= 1;
        throw new Error("fetch failed: ECONNRESET");
      }
      return { STRAD_TOKENS: JSON.stringify([token.record]) };
    },
  };
  return {
    resolver,
    failNext: (n: number) => (failNext = n),
    reads: () => reads,
  };
}

let server: Server | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  server?.closeAllConnections();
  await new Promise<void>((resolve) => {
    if (!server) return resolve();
    server.close(() => resolve());
  });
  server = undefined;
});

async function boot(resolver: ParameterResolver) {
  const provider = new StoreSecretProvider(resolver, "/strad/test/gateway/", {
    onWarn: () => {},
    sleep: async () => {},
  });
  const registry = await Registry.build({
    config: CONFIG,
    secrets: sharedSecretProviders(new EnvSecretProvider({})),
    mode: "core",
    env: {},
  });
  const app = createApp({
    config: CONFIG,
    registry,
    tokenStore: new ParameterTokenStore(provider),
    mode: "core",
    env: {},
  });
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const addr = server.address();
  if (typeof addr === "string" || !addr) throw new Error("no port");
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  const post = () =>
    fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token.plaintext}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
    });
  return { provider, post };
}

/** Everything strad wrote to stdout and stderr while `run` ran. */
async function capture(run: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const push = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  vi.spyOn(console, "error").mockImplementation(push);
  vi.spyOn(console, "warn").mockImplementation(push);
  vi.spyOn(console, "log").mockImplementation(push);
  vi.spyOn(console, "info").mockImplementation(push);
  await run();
  vi.restoreAllMocks();
  return lines.join("\n");
}

describe("/mcp after a secret write invalidates the token store", () => {
  it("write, invalidate, ONE failed store read: the request still succeeds", async () => {
    const store = flakyStore();
    const { provider, post } = await boot(store.resolver);

    expect((await post()).status).toBe(200);

    let status = 0;
    const logged = await capture(async () => {
      provider.invalidate(); // what src/http/params.ts does after a write
      store.failNext(1);
      status = (await post()).status;
    });

    expect(status).toBe(200);
    // The failed read and its retry, both reaching the store.
    expect(store.reads()).toBe(3);
    expect(logged).not.toContain("strad.route_failed");
    expect(logged).not.toContain("strad.token_store_unavailable");
  });

  it("a store that STAYS unreadable is still a 500, strad.token_store_unavailable and strad.route_failed", async () => {
    const store = flakyStore();
    const { provider, post } = await boot(store.resolver);
    expect((await post()).status).toBe(200);

    // The outage report is throttled per PROCESS, to one per minute
    // (src/auth/index.ts). Step the wall clock past that window so this
    // assertion does not depend on what ran before it in this worker.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 120_000);

    let status = 0;
    let body = "";
    const logged = await capture(async () => {
      provider.invalidate();
      store.failNext(Infinity);
      const res = await post();
      status = res.status;
      body = await res.text();
    });

    // Fail closed: not admitted, and not a 401 that would send the client
    // into re-authentication over a read that failed.
    expect(status).toBe(500);
    expect(JSON.parse(body)).toEqual({ error: "internal_error" });
    expect(logged).toContain("strad.token_store_unavailable");
    expect(logged).toContain("strad.route_failed");
    expect(logged).toContain('"route":"mcp"');
    expect(logged).toContain('"error":"TokenStoreUnavailable"');
    // The budget was spent, and no more than it: one read before, three after.
    expect(store.reads()).toBe(4);
  });
});
