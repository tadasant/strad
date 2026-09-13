import express from "express";
import { describe, expect, it, vi } from "vitest";
import { parseConfig } from "../src/config/load.ts";
import { StradConfig } from "../src/config/schema.ts";
import { Registry } from "../src/gateway/registry.ts";
import {
  ReloadableGateway,
  type GatewayInstance,
} from "../src/gateway/reload.ts";
import { ToolSurfaceMonitor } from "../src/gateway/reachability.ts";
import {
  sharedSecretProviders,
  EnvSecretProvider,
} from "../src/secrets/provider/index.ts";

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

async function realInstance(config: StradConfig): Promise<GatewayInstance> {
  const registry = await Registry.build({
    config,
    secrets: sharedSecretProviders(new EnvSecretProvider({})),
    mode: "core",
    env: {},
  });
  return {
    config,
    registry,
    app: express(),
    toolSurfaces: new ToolSurfaceMonitor({ registry, intervalMs: 3_600_000 }),
  };
}

describe("ReloadableGateway", () => {
  it("swaps the app the socket dispatches to", async () => {
    const seen: string[] = [];
    const make = (tag: string) => {
      const app = express();
      app.get("/x", (_req, res) => {
        seen.push(tag);
        res.end(tag);
      });
      return app;
    };

    let tag = "one";
    const gateway = await ReloadableGateway.start(
      async (config) => ({ ...(await realInstance(config)), app: make(tag) }),
      CONFIG,
      { drainMs: 0 },
    );
    expect(gateway.current.app).toBeDefined();

    tag = "two";
    await gateway.reload(CONFIG);
    expect(gateway.current.config).toBe(CONFIG);
    await gateway.close();
    expect(seen).toEqual([]);
  });

  it("leaves EVERYTHING as it was when the rebuild throws", async () => {
    const first = await realInstance(CONFIG);
    let fail = false;
    const gateway = await ReloadableGateway.start(
      () =>
        fail
          ? Promise.reject(new Error("cannot reach the bundle"))
          : Promise.resolve(first),
      CONFIG,
      { drainMs: 0 },
    );

    fail = true;
    await expect(gateway.reload(CONFIG)).rejects.toThrow("cannot reach");

    // The old instance is still the live one, and its registry is still open —
    // a failed reload must not have drained the gateway that is still serving.
    expect(gateway.current).toBe(first);
    expect(gateway.registry.has("alpha")).toBe(true);
    await gateway.close();
  });

  it("does not close the outgoing registry until the drain window expires", async () => {
    const first = await realInstance(CONFIG);
    const second = await realInstance(CONFIG);
    const closed = vi.spyOn(first.registry, "close");

    let next = first;
    const gateway = await ReloadableGateway.start(
      () => Promise.resolve(next),
      CONFIG,
      { drainMs: 5_000 },
    );

    vi.useFakeTimers();
    try {
      next = second;
      await gateway.reload(CONFIG);
      // A request that was in flight when the swap happened is still holding a
      // connection on the old adapters. Closing at once would fail it.
      expect(closed).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(closed).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
    await gateway.close();
  });

  it("closes a still-draining registry on shutdown rather than leaking it", async () => {
    const first = await realInstance(CONFIG);
    const second = await realInstance(CONFIG);
    const closed = vi.spyOn(first.registry, "close");

    let next = first;
    const gateway = await ReloadableGateway.start(
      () => Promise.resolve(next),
      CONFIG,
      { drainMs: 600_000 },
    );
    next = second;
    await gateway.reload(CONFIG);

    await gateway.close();
    expect(closed).toHaveBeenCalled();
  });

  it("keeps probing across a reload once probing has started", async () => {
    const first = await realInstance(CONFIG);
    const second = await realInstance(CONFIG);
    const firstStop = vi.spyOn(first.toolSurfaces, "stop");
    const secondStart = vi.spyOn(second.toolSurfaces, "start");

    let next = first;
    const gateway = await ReloadableGateway.start(
      () => Promise.resolve(next),
      CONFIG,
      { drainMs: 0 },
    );
    gateway.startProbing();

    next = second;
    await gateway.reload(CONFIG);

    expect(firstStop).toHaveBeenCalled();
    expect(secondStart).toHaveBeenCalled();
    await gateway.close();
  });

  it("does NOT start probing on a reload when nobody ever started it", async () => {
    const first = await realInstance(CONFIG);
    const second = await realInstance(CONFIG);
    const secondStart = vi.spyOn(second.toolSurfaces, "start");

    let next = first;
    const gateway = await ReloadableGateway.start(
      () => Promise.resolve(next),
      CONFIG,
      { drainMs: 0 },
    );
    next = second;
    await gateway.reload(CONFIG);

    expect(secondStart).not.toHaveBeenCalled();
    await gateway.close();
  });
});

describe("gateway.configStore in the schema", () => {
  it("is off by default, so nothing changes for a deployment that ignores it", () => {
    expect(CONFIG.gateway.configStore.enabled).toBe(false);
    expect(CONFIG.gateway.configStore.pollSeconds).toBe(60);
  });

  it("refuses to be enabled under the env provider, which has nowhere to write", () => {
    const result = StradConfig.safeParse({
      version: 1,
      gateway: { env: "test", configStore: { enabled: true } },
      auth: {},
      roles: {},
      servers: [],
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((i) => i.message).join("\n")).toContain(
      "gcp-parameter-store",
    );
  });

  it("is accepted alongside the parameter-store provider", () => {
    const result = StradConfig.safeParse({
      version: 1,
      gateway: {
        env: "test",
        secrets: { provider: "gcp-parameter-store" },
        configStore: { enabled: true, pollSeconds: 30 },
      },
      auth: {},
      roles: {},
      servers: [],
    });
    expect(result.success).toBe(true);
  });

  it("has a poll floor, for the same reason paramRefreshSeconds has one", () => {
    const result = StradConfig.safeParse({
      version: 1,
      gateway: {
        env: "test",
        secrets: { provider: "gcp-parameter-store" },
        configStore: { enabled: true, pollSeconds: 1 },
      },
      auth: {},
      roles: {},
      servers: [],
    });
    expect(result.success).toBe(false);
  });
});
