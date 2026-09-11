import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import {
  InMemoryLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import express, { type Request, type Response } from "express";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { tokenStoreFromConfig } from "../src/auth/index.ts";
import { mintToken } from "../src/auth/tokens.ts";
import type { TokenStore } from "../src/auth/tokens.ts";
import { parseConfig } from "../src/config/load.ts";
import { Registry } from "../src/gateway/registry.ts";
import { createApp } from "../src/http/app.ts";
import { asyncRoute, jsonFailure } from "../src/http/async-route.ts";
import { createFakeGcp, type FakeGcp } from "../src/secrets/parameters/fake.ts";
import {
  disableEventExport,
  enableEventExport,
  resetEventThrottle,
} from "../src/telemetry/index.ts";
import type { Capabilities } from "../src/secrets/parameters/index.ts";
import {
  EnvSecretProvider,
  sharedSecretProviders,
} from "../src/secrets/provider/index.ts";

/**
 * THE GUARD, and the failure it replaces.
 *
 * Express 4 drops the promise an async handler returns; this process exits on an
 * unhandled rejection (`src/telemetry/errors.ts`). Between those two facts there
 * was no path from a throw inside the `/mcp` handler to a 500 — only to a
 * container restart that took every concurrent request with it. Issue #276.
 *
 * So the assertions here are about three things, in order of what actually
 * matters: the process is still serving afterwards, the caller got a 500 rather
 * than a hung socket, and the answer contains nothing the failure said.
 */

// Planted inside the thrown error's MESSAGE. Nothing a caller or an ingestor
// receives may contain it — /mcp's whole discipline is that text this repo did
// not author does not leave the process (src/telemetry/redact.ts).
const CANARY = "sk-live-CANARY-9f81cd-DO-NOT-LEAK";

// ===========================================================================
// The wrapper itself
// ===========================================================================

describe("asyncRoute", () => {
  it("routes a rejection to the renderer instead of leaving it unhandled", async () => {
    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const seen: unknown[] = [];
      const app = express();
      app.get(
        "/boom",
        asyncRoute(
          () => Promise.reject(new Error(CANARY)),
          (res, err) => {
            seen.push(err);
            res.status(500).json({ error: "internal_error" });
          },
        ),
      );

      const { baseUrl, close } = await listen(app);
      const res = await fetch(`${baseUrl}/boom`);
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "internal_error" });
      expect(seen).toHaveLength(1);
      await close();

      // The rejection went somewhere. `unhandledRejection` fires on a later
      // turn of the loop than the response, so give it one.
      await new Promise((r) => setTimeout(r, 20));
      expect(ours(rejections)).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("does not let a renderer that throws become the same bug one turn later", async () => {
    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    const errs = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // Driven directly rather than over a socket: a renderer that throws
      // answers nothing, so an HTTP round trip here would only measure a
      // timeout. What is under test is the turn AFTER the renderer.
      const handler = asyncRoute(
        () => Promise.reject(new Error(`first ${CANARY}`)),
        () => {
          throw new Error("the renderer failed too");
        },
      );
      handler({} as Request, {} as Response, () => {});
      await new Promise((r) => setTimeout(r, 20));

      expect(ours(rejections)).toEqual([]);
      const logged = errs.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain("route failure renderer threw");
      // The class, not the message — the same rule the renderers keep.
      expect(logged).not.toContain("the renderer failed too");
    } finally {
      errs.mockRestore();
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("jsonFailure", () => {
  it("logs the class alone and answers a fixed body", () => {
    const lines: string[] = [];
    const errs = vi
      .spyOn(console, "error")
      .mockImplementation((...args: unknown[]) => {
        lines.push(String(args[0]));
      });
    try {
      const sent: unknown[] = [];
      const res = {
        headersSent: false,
        status(code: number) {
          sent.push(code);
          return this;
        },
        json(body: unknown) {
          sent.push(body);
        },
      } as unknown as Response;

      jsonFailure("mcp")(res, new TypeError(CANARY));
      expect(sent).toEqual([500, { error: "internal_error" }]);

      const logged = lines.join("\n");
      expect(logged).toContain("strad.route_failed");
      expect(logged).toContain('"route":"mcp"');
      expect(logged).toContain('"error":"TypeError"');
      expect(logged).not.toContain(CANARY);
    } finally {
      errs.mockRestore();
    }
  });

  it("ends a half-streamed response rather than leaving the caller hanging", () => {
    const errs = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // Headers are out, so there is no status left to set — but /mcp streams,
      // and a response left open costs the caller its own timeout and leaks the
      // in-flight gauge, whose books are closed on `close`.
      let ended = false;
      const res = {
        headersSent: true,
        writableEnded: false,
        status() {
          throw new Error("must not be called");
        },
        end() {
          ended = true;
        },
      } as unknown as Response;

      jsonFailure("mcp")(res, new Error(CANARY));
      expect(ended).toBe(true);
    } finally {
      errs.mockRestore();
    }
  });

  it("leaves an already-ended response alone", () => {
    const errs = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = {
        headersSent: true,
        writableEnded: true,
        status() {
          throw new Error("must not be called");
        },
        end() {
          throw new Error("must not be called");
        },
      } as unknown as Response;

      expect(() => jsonFailure("mcp")(res, new Error(CANARY))).not.toThrow();
    } finally {
      errs.mockRestore();
    }
  });
});

// ===========================================================================
// What the guard's event ships
// ===========================================================================

describe("strad.route_failed, exported", () => {
  async function withExporter(
    run: (exporter: InMemoryLogRecordExporter) => void,
  ): Promise<void> {
    const exporter = new InMemoryLogRecordExporter();
    const provider = new LoggerProvider({
      processors: [new SimpleLogRecordProcessor({ exporter })],
    });
    logs.disable();
    logs.setGlobalLoggerProvider(provider);
    enableEventExport("strad-test", "0.0.0");
    try {
      resetEventThrottle();
      run(exporter);
    } finally {
      disableEventExport();
      await provider.shutdown().catch(() => {});
      logs.disable();
    }
  }

  it("carries the route and a classified kind, and never the error text", async () => {
    const errs = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await withExporter((exporter) => {
        const res = { headersSent: true, writableEnded: true } as Response;
        jsonFailure("mcp")(res, new Error(`ECONNREFUSED ${CANARY}`));

        const [record] = exporter.getFinishedLogRecords();
        expect(record?.severityNumber).toBe(SeverityNumber.ERROR);
        expect(record?.attributes["route"]).toBe("mcp");
        // From redact.ts's fixed vocabulary, not from the message.
        expect(record?.attributes["error.kind"]).toBe("upstream_unavailable");
        expect(JSON.stringify(record?.attributes)).not.toContain(CANARY);
        expect(record?.attributes["error"]).toBeUndefined();
      });
    } finally {
      errs.mockRestore();
    }
  });

  it("throttles per ROUTE, so one failing route cannot hide another", async () => {
    const errs = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await withExporter((exporter) => {
        const res = { headersSent: true, writableEnded: true } as Response;
        // This event carries no `slug`, so keying the throttle on `slug` alone
        // would put every route in one 60s bucket and drop the second one.
        for (let i = 0; i < 5; i++) jsonFailure("mcp")(res, new Error("x"));
        jsonFailure("params_write")(res, new Error("x"));

        const shipped = exporter
          .getFinishedLogRecords()
          .map((r) => r.attributes["route"]);
        expect(shipped).toEqual(["mcp", "params_write"]);
      });
    } finally {
      errs.mockRestore();
    }
  });
});

// ===========================================================================
// /mcp, through the real app
// ===========================================================================

/**
 * The injection is a TOKEN STORE THAT FAILS, which is the plainest real version
 * of this bug: `authenticateMcp` rethrows anything that is not `Unauthenticated`
 * (src/gateway/router.ts), so a store whose backing read throws lands exactly on
 * the unguarded surface the issue is about. Nothing else in the request has to be
 * unusual for it.
 *
 * It is also the shape a store-backed deployment has in an outage
 * (`auth.staticTokens.store: parameter-store`), and the answer is deliberately
 * this 500 rather than a 401: nothing was decided about the caller's credential,
 * and a 401 would send every agent holding one into a re-authentication flow
 * over a read that timed out. See `TokenStoreUnavailable` in src/auth/index.ts.
 */
describe("/mcp answers 500 when strad itself throws", () => {
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
  const env: NodeJS.ProcessEnv = {
    STRAD_TOKENS: JSON.stringify([token.record]),
  };

  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const registry = await Registry.build({
      config: CONFIG,
      secrets: sharedSecretProviders(new EnvSecretProvider({})),
      mode: "core",
      env,
    });

    const brokenStore: TokenStore = {
      get: () => Promise.reject(new Error(`token store is down: ${CANARY}`)),
      list: () => Promise.resolve([]),
    };

    const app = createApp({
      config: CONFIG,
      registry,
      tokenStore: brokenStore,
      mode: "core",
      env,
    });
    ({ server, baseUrl } = await listenOn(app));
  });

  afterAll(async () => {
    server?.closeAllConnections();
    await new Promise<void>((resolve) => {
      server?.close(() => resolve());
    });
  });

  async function post(): Promise<globalThis.Response> {
    return fetch(`${baseUrl}/mcp`, {
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
  }

  it("is a 500 with a fixed body, and no word of the failure in it", async () => {
    const errs = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await post();
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(JSON.parse(text)).toEqual({ error: "internal_error" });
      expect(text).not.toContain(CANARY);
      expect(text).not.toContain("token store is down");
    } finally {
      errs.mockRestore();
    }
  });

  it("leaves the process serving — the whole point of the guard", async () => {
    const errs = vi.spyOn(console, "error").mockImplementation(() => {});
    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      // Three of them: before this change the FIRST would have taken the
      // container down and the other two would never have been answered.
      for (let i = 0; i < 3; i++) expect((await post()).status).toBe(500);
      await new Promise((r) => setTimeout(r, 20));
      expect(ours(rejections)).toEqual([]);

      const health = await fetch(`${baseUrl}/healthz`);
      expect(health.status).toBe(200);
      expect((await health.json()) as { ok: boolean }).toMatchObject({
        ok: true,
      });
    } finally {
      process.off("unhandledRejection", onUnhandled);
      errs.mockRestore();
    }
  });

  it("records the failure as strad.route_failed, with the class and nothing else", async () => {
    const lines: string[] = [];
    const errs = vi
      .spyOn(console, "error")
      .mockImplementation((...args: unknown[]) => {
        lines.push(String(args[0]));
      });
    try {
      await post();
      const logged = lines.join("\n");
      expect(logged).toContain("strad.route_failed");
      expect(logged).toContain('"route":"mcp"');
      // `TokenStoreUnavailable`, not `Error`: the store's own exception is
      // caught and DROPPED at `verifyToken` (its message quotes payloads) and a
      // detail-free one is raised in its place, which is what reaches the guard.
      // So the class name is strad's own word rather than the backend's.
      expect(logged).toContain('"error":"TokenStoreUnavailable"');
      expect(logged).not.toContain(CANARY);
    } finally {
      errs.mockRestore();
    }
  });
});

// ===========================================================================
// The console, after the conversion
// ===========================================================================

/**
 * The console's routes were already guarded, in two spellings, and the
 * conversion has to be behaviour-identical: an unexpected throw still renders
 * `renderUnexpected`'s HTML page, not `jsonFailure`'s JSON. `capabilitiesFor()`
 * is the call that throws OUTSIDE the action handler's own `try`, which is what
 * makes it the seam for reaching the catch-all (see
 * `test/ui.secrets.error-text.test.ts`).
 */
describe("a converted console route still renders renderUnexpected", () => {
  const BOOTSTRAP = "bootstrap-secret-xyz";
  const NS = "/strad/test/mcp/secrets/static/";
  const CONFIG = parseConfig(`
version: 1
gateway: { name: strad, env: test }
auth:
  staticTokens: { enabled: true }
  consoleDevBypass: { enabled: true, roles: [admin] }
roles:
  admin: { servers: ["*"] }
bundles:
  - name: bundle
servers:
  - slug: secrets
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle
    path: /secrets
    entitlements: [admin]
    env:
      SECRETS_PROJECT_ID: "demo-project"
      SECRETS_NAMESPACES: "${NS}"
    consoleEnv:
      SECRETS_PROJECT_ID: "demo-project"
      SECRETS_NAMESPACES: "${NS}"
`);

  const env: NodeJS.ProcessEnv = {
    ALLOW_DEV_AUTH: "true",
    ADMIN_BOOTSTRAP_TOKEN: BOOTSTRAP,
    STRAD_BUNDLE_URL_BUNDLE: "http://127.0.0.1:1",
    STRAD_TOKENS: "[]",
  };

  let fake: FakeGcp;
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    fake = createFakeGcp();
    const providers = sharedSecretProviders(new EnvSecretProvider({}));
    const registry = await Registry.build({
      config: CONFIG,
      secrets: providers,
      mode: "core",
      env,
    });
    const app = createApp({
      config: CONFIG,
      registry,
      tokenStore: tokenStoreFromConfig(CONFIG, env),
      mode: "core",
      env,
      secrets: {},
      secretProvider: providers,
      parametersStore: () => fake.store,
      capabilities: (): Promise<Capabilities> =>
        Promise.reject(new Error(CANARY)),
    });
    ({ server, baseUrl } = await listenOn(app));
  });

  afterAll(async () => {
    server?.closeAllConnections();
    await new Promise<void>((resolve) => {
      server?.close(() => resolve());
    });
  });

  it("is a 500 HTML page, not the JSON a machine route would answer", async () => {
    const errs = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await fetch(`${baseUrl}/ui/secrets`, {
        headers: { authorization: `Bearer ${BOOTSTRAP}` },
      });
      const html = await res.text();

      expect(res.status).toBe(500);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(html).toContain("Something went wrong");
      expect(html).not.toContain("internal_error");
      expect(html).not.toContain(CANARY);
    } finally {
      errs.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------

/**
 * Only the rejections this suite planted.
 *
 * `unhandledRejection` is a PROCESS listener, so an unrelated rejection anywhere
 * in this worker would otherwise fail an assertion that is not about it. Every
 * error these tests throw carries the canary, which is what makes the filter
 * exact rather than approximate.
 */
function ours(rejections: unknown[]): unknown[] {
  return rejections.filter((r) =>
    String((r as Error)?.message).includes(CANARY),
  );
}

async function listenOn(
  app: ReturnType<typeof express>,
): Promise<{ server: Server; baseUrl: string }> {
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const addr = server.address();
  if (typeof addr === "string" || !addr) throw new Error("no port");
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

async function listen(
  app: ReturnType<typeof express>,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const { server, baseUrl } = await listenOn(app);
  return {
    baseUrl,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
