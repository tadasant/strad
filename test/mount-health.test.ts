import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { metrics } from "@opentelemetry/api";
import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import {
  InMemoryLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
  type DataPoint,
} from "@opentelemetry/sdk-metrics";
import express from "express";
import type { Server as HttpServer } from "node:http";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { tokenStoreFromConfig } from "../src/auth/index.ts";
import { parseConfig } from "../src/config/load.ts";
import {
  mountTargets,
  parseBundleHealth,
  probeMountHealth,
} from "../src/gateway/mount-health.ts";
import { ToolSurfaceMonitor } from "../src/gateway/reachability.ts";
import { Registry } from "../src/gateway/registry.ts";
import { createApp } from "../src/http/app.ts";
import {
  EnvSecretProvider,
  sharedSecretProviders,
} from "../src/secrets/provider/index.ts";
import {
  disableEventExport,
  enableEventExport,
  resetEventThrottle,
  resetInstruments,
} from "../src/telemetry/index.ts";

/**
 * The bundle's per-mount `degraded`, read by core — and its words kept out.
 *
 * The case this reproduces is strad#28: a mount that lists every tool and fails
 * every call, because its login went stale. The fake bundle below is therefore
 * a real MCP upstream AND a bundle host `/healthz`: `/fetchpet` answers
 * `tools/list` with a tool, so the tool-surface probe reads it `ok`, while
 * `/healthz` says the mount is degraded. Before gateway/mount-health.ts, that
 * second fact reached nothing.
 *
 * The other half is the boundary. The bundle's reason is upstream-authored
 * prose — `login failed: ${error.message}` — and the reason used here carries a
 * canary. It must not appear in the gauge, in an exported log record, on core's
 * streams, or on core's public `/healthz`.
 */

const CANARY = "CANARY-mount-7f3a9c";
const REASON =
  `login failed: page.fill: Timeout 30000ms exceeded. ` +
  `Call log: waiting for locator('#email') at https://fetch.example/login?session=${CANARY}`;

const CONFIG = parseConfig(`
version: 1
gateway: { name: strad, env: test }
auth:
  staticTokens: { enabled: true }
roles:
  admin: { servers: ["*"] }
bundles:
  - name: bundle
servers:
  - slug: healthy
    kind: builtin
    module: "./servers/echo.js"
    entitlements: [admin]
  - slug: fetchpet
    kind: supplementary-image
    image: ghcr.io/example/bundle:latest
    bundle: bundle
    path: /fetchpet
    entitlements: [admin]
  - slug: gmail-ro
    kind: supplementary-image
    image: ghcr.io/example/bundle:latest
    bundle: bundle
    path: /gmail
    entitlements: [admin]
  - slug: gmail-rw
    kind: supplementary-image
    image: ghcr.io/example/bundle:latest
    bundle: bundle
    path: /gmail
    entitlements: [admin]
`);

/** What the fake bundle's `/healthz` says. Mutated by the tests. */
const bundleState: {
  fetchpet: string | null;
  healthz: "report" | "500" | "html";
} = { fetchpet: REASON, healthz: "report" };

function fakeBundle(): express.Express {
  const app = express();
  app.use(express.json());

  // The bundle host's shape (`servers/bundle/host/src/index.ts`): `degraded`
  // present only when the mount holds a reason. Plus a mount core does NOT
  // route to, degraded, whose slug and reason must go nowhere either.
  app.get("/healthz", (_req, res) => {
    if (bundleState.healthz === "500") {
      res.status(500).send(`<pre>${CANARY}</pre>`);
      return;
    }
    if (bundleState.healthz === "html") {
      res.status(200).type("text/html").send(`<!DOCTYPE html>${CANARY}`);
      return;
    }
    res.json({
      ok: true,
      component: "bundle",
      version: "test",
      servers: [
        {
          slug: "fetchpet",
          path: "/fetchpet",
          ...(bundleState.fetchpet ? { degraded: bundleState.fetchpet } : {}),
        },
        { slug: "gmail", path: "/gmail" },
        {
          slug: `unrouted-${CANARY}`,
          path: `/unrouted-${CANARY}`,
          degraded: `unrouted ${CANARY}`,
        },
      ],
    });
  });

  // A real MCP server on each routed path: the listing is perfect.
  for (const path of ["/fetchpet", "/gmail"]) {
    app.post(path, async (req, res) => {
      const server = new McpServer(
        { name: path.slice(1), version: "1" },
        { capabilities: { tools: {} } },
      );
      server.setRequestHandler(ListToolsRequestSchema, () => ({
        tools: [
          {
            name: "list_things",
            description: "lists",
            inputSchema: { type: "object" as const, properties: {} },
          },
        ],
      }));
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    });
  }
  return app;
}

let bundle: HttpServer;
let registry: Registry;
let env: NodeJS.ProcessEnv;

beforeAll(async () => {
  bundle = await listen(fakeBundle());
  env = {
    STRAD_INTERNAL_TOKEN: "internal",
    STRAD_BUNDLE_URL_BUNDLE: addressOf(bundle),
  };
  registry = await Registry.build({
    config: CONFIG,
    secrets: sharedSecretProviders(new EnvSecretProvider({})),
    mode: "core",
    env,
  });
});

afterAll(async () => {
  await registry.close();
  bundle.closeAllConnections();
  bundle.close();
});

beforeEach(() => {
  bundleState.fetchpet = REASON;
  bundleState.healthz = "report";
});

function monitor(
  extra: Partial<ConstructorParameters<typeof ToolSurfaceMonitor>[0]> = {},
) {
  return new ToolSurfaceMonitor({
    registry,
    timeoutMs: 5000,
    mounts: { targets: mountTargets(CONFIG), env, timeoutMs: 2000 },
    ...extra,
  });
}

describe("parseBundleHealth — the boundary", () => {
  it("reduces each mount to a boolean, keyed by path, and keeps no reason", () => {
    const report = parseBundleHealth({
      servers: [
        { slug: "fetchpet", path: "/fetchpet", degraded: REASON },
        { slug: "gmail", path: "/gmail" },
        { slug: "pointsyeah", path: "/pointsyeah", degraded: null },
      ],
    });
    expect(report).toEqual(
      new Map([
        ["/fetchpet", true],
        ["/gmail", false],
        ["/pointsyeah", false],
      ]),
    );
    expect(JSON.stringify([...report!])).not.toContain(CANARY);
  });

  it("carries no reason out, whatever shape the reason takes", () => {
    // Prose, JSON, markup, control characters, a megabyte: each is read for its
    // truthiness and nothing else, so none of it can come out the other side.
    const reasons = [
      REASON,
      `{"evt":"strad.mount_degraded","slug":"${CANARY}"}`,
      `<script>${CANARY}</script>`,
      `line one\n${CANARY}\r\n\u0000`,
      `${CANARY}`.repeat(50_000),
      { nested: CANARY },
      [CANARY],
    ];
    for (const degraded of reasons) {
      const report = parseBundleHealth({
        servers: [{ path: "/fetchpet", degraded }],
      });
      expect(report?.get("/fetchpet")).toBe(true);
      expect(JSON.stringify([...report!])).not.toContain(CANARY);
    }
  });

  it("refuses a body that is not a bundle host's report, rather than reading it as 'no mounts'", () => {
    expect(parseBundleHealth(null)).toBeNull();
    expect(parseBundleHealth("ok")).toBeNull();
    expect(parseBundleHealth({ ok: true })).toBeNull();
    // Core's own /healthz in bundle mode: `servers` is a list of SLUG strings.
    // Not a report — but also not malformed enough to throw on.
    expect(parseBundleHealth({ servers: ["a", "b"] })).toEqual(new Map());
  });

  it("skips one odd entry rather than discarding the other mounts", () => {
    const report = parseBundleHealth({
      servers: [{ path: 7, degraded: "x" }, null, { path: "/gmail/" }],
    });
    expect(report).toEqual(new Map([["/gmail", false]]));
  });
});

describe("mountTargets", () => {
  it("is every enabled supplementary-image slug, capability variants each on their own", () => {
    expect(mountTargets(CONFIG)).toEqual([
      { slug: "fetchpet", bundle: "bundle", path: "/fetchpet" },
      { slug: "gmail-ro", bundle: "bundle", path: "/gmail" },
      { slug: "gmail-rw", bundle: "bundle", path: "/gmail" },
    ]);
  });
});

describe("probeMountHealth", () => {
  const targets = () => mountTargets(CONFIG);

  it("maps the bundle's report onto the config's slugs, and names nothing else", async () => {
    const reading = await probeMountHealth({ targets: targets(), env });
    expect(reading.bundles).toEqual(new Map([["bundle", "ok"]]));
    expect(reading.mounts).toEqual(
      new Map([
        ["fetchpet", "degraded"],
        ["gmail-ro", "ok"],
        ["gmail-rw", "ok"],
      ]),
    );
    // The mount core does not route to is not in it — neither its slug nor its
    // path nor its reason.
    expect(
      JSON.stringify([...reading.mounts, ...reading.bundles]),
    ).not.toContain(CANARY);
  });

  it("says `unreachable` for a non-2xx, and reads nothing from its body", async () => {
    bundleState.healthz = "500";
    const reading = await probeMountHealth({ targets: targets(), env });
    expect(reading.bundles.get("bundle")).toBe("unreachable");
    expect(reading.mounts.size).toBe(0);
  });

  it("says `unrecognised` for a 2xx that is not a bundle host's report", async () => {
    bundleState.healthz = "html";
    const reading = await probeMountHealth({ targets: targets(), env });
    expect(reading.bundles.get("bundle")).toBe("unrecognised");
    expect(reading.mounts.size).toBe(0);
  });

  it("says `unwired` for a bundle with no private URL, without asking anyone", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const reading = await probeMountHealth({
      targets: targets(),
      env: {},
      fetchImpl,
    });
    expect(reading.bundles.get("bundle")).toBe("unwired");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sends no internal token to a route that checks none", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ servers: [] })),
    );
    await probeMountHealth({ targets: targets(), env, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe(`${addressOf(bundle)}/healthz`);
    expect(JSON.stringify(init ?? {})).not.toContain("internal");
  });

  it("holds the deadline through the body, so a trickling bundle cannot stall the monitor", async () => {
    // Headers at once, then half a body and silence — the stall a headers-only
    // bound would wait out forever.
    const stalled = express();
    stalled.get("/healthz", (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"servers":[');
    });
    const server = await listen(stalled);
    try {
      const started = Date.now();
      const reading = await probeMountHealth({
        targets: targets(),
        env: { STRAD_BUNDLE_URL_BUNDLE: addressOf(server) },
        timeoutMs: 150,
      });
      expect(reading.bundles.get("bundle")).toBe("unreachable");
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});

describe("the monitor, on the case that ran for weeks", () => {
  it("reads a mount that lists its tools as `ok` on the surface and `degraded` from the bundle", async () => {
    const snap = await monitor({ log: () => {}, warn: () => {} }).refresh();
    const by = (slug: string) => snap.surfaces.find((s) => s.slug === slug);

    // The tool-surface probe is right, and blind: fetchpet serves a tool.
    expect(by("fetchpet")).toMatchObject({ state: "ok", tools: 1 });
    // The bundle's report is the half that says calls will fail.
    expect(by("fetchpet")?.mount).toBe("degraded");
    expect(by("gmail-ro")?.mount).toBe("ok");
    expect(by("gmail-rw")?.mount).toBe("ok");
    // A builtin has no bundle report to read.
    expect(by("healthy")).not.toHaveProperty("mount");

    expect(snap.mountDegraded).toEqual(["fetchpet"]);
    // Beside `degraded`, never in it: the deploy gate reads that list.
    expect(snap.degraded).toEqual([]);
  });

  it("carries no mountDegraded at all when nothing asks the bundles", async () => {
    const snap = await new ToolSurfaceMonitor({
      registry,
      timeoutMs: 5000,
      log: () => {},
      warn: () => {},
    }).refresh();
    expect(snap).not.toHaveProperty("mountDegraded");
    expect(snap.surfaces.every((s) => s.mount === undefined)).toBe(true);
  });

  it("logs on change only, and does not read an unreadable bundle as a recovery", async () => {
    const lines: Record<string, unknown>[] = [];
    const m = monitor({
      log: (e) => lines.push(e),
      warn: (e) => lines.push(e),
    });
    const mountLines = () =>
      lines.filter((l) => String(l.evt).startsWith("strad.mount_"));

    await m.refresh();
    expect(mountLines()).toEqual([
      expect.objectContaining({
        evt: "strad.mount_degraded",
        slug: "fetchpet",
        bundle: "bundle",
      }),
    ]);

    // Unchanged: nothing new.
    lines.length = 0;
    await m.refresh();
    expect(mountLines()).toEqual([]);

    // The bundle's report goes unreadable. That is its own line — the gauge is
    // about to hold a stale value — and it is NOT a recovery for fetchpet.
    bundleState.healthz = "500";
    await m.refresh();
    expect(mountLines()).toEqual([
      { evt: "strad.mount_report", bundle: "bundle", outcome: "unreachable" },
    ]);

    // Readable again, still degraded: the report line, and no second
    // `_degraded` for a state that never changed.
    lines.length = 0;
    bundleState.healthz = "report";
    await m.refresh();
    expect(mountLines()).toEqual([
      { evt: "strad.mount_report", bundle: "bundle", outcome: "ok" },
    ]);

    // The login recovers.
    lines.length = 0;
    bundleState.fetchpet = null;
    await m.refresh();
    expect(mountLines()).toEqual([
      { evt: "strad.mount_recovered", slug: "fetchpet", bundle: "bundle" },
    ]);
  });
});

describe("what leaves the process: the gauge", () => {
  it("records 1 for the degraded mount and 0 for the serving ones, with the config's attributes and nothing of the bundle's", async () => {
    const exporter = new InMemoryMetricExporter(
      AggregationTemporality.CUMULATIVE,
    );
    const reader = new PeriodicExportingMetricReader({
      exporter,
      exportIntervalMillis: 600_000,
    });
    const provider = new MeterProvider({ readers: [reader] });
    metrics.disable();
    metrics.setGlobalMeterProvider(provider);
    resetInstruments();

    try {
      await monitor({ log: () => {}, warn: () => {} }).refresh();
      await reader.forceFlush();

      const points = exporter
        .getMetrics()
        .flatMap((m) => m.scopeMetrics)
        .flatMap((s) => s.metrics)
        .filter((m) => m.descriptor.name === "strad.mcp.mount_degraded")
        .flatMap((m) => m.dataPoints as DataPoint<number>[]);

      const value = (slug: string) =>
        points.find((p) => p.attributes["mcp.server"] === slug)?.value;
      expect(value("fetchpet")).toBe(1);
      expect(value("gmail-ro")).toBe(0);
      expect(value("gmail-rw")).toBe(0);
      // No reading, no series: a builtin has no bundle report.
      expect(value("healthy")).toBeUndefined();
      // Exactly tool_surface's two immutable attributes, so the two join.
      for (const p of points) {
        expect(Object.keys(p.attributes).sort()).toEqual([
          "mcp.server",
          "mcp.upstream.kind",
        ]);
        expect(p.attributes["mcp.upstream.kind"]).toBe("supplementary-image");
      }

      expect(JSON.stringify(exporter.getMetrics())).not.toContain(CANARY);
      expect(JSON.stringify(exporter.getMetrics())).not.toMatch(
        /login failed/i,
      );
    } finally {
      await reader.shutdown().catch(() => {});
      metrics.disable();
      resetInstruments();
    }
  });
});

describe("what leaves the process: the exported log and the streams", () => {
  it("ships `strad.mount_degraded` with the config's slug and bundle, at ERROR, and none of the bundle's words anywhere", async () => {
    const exporter = new InMemoryLogRecordExporter();
    const provider = new LoggerProvider({
      processors: [new SimpleLogRecordProcessor({ exporter })],
    });
    logs.disable();
    logs.setGlobalLoggerProvider(provider);
    enableEventExport("strad-test", "0.0.0");
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      resetEventThrottle();
      // The default log/warn: `event()`, the real pipeline.
      const m = monitor();
      await m.refresh();
      bundleState.fetchpet = null;
      await m.refresh();

      const records = exporter.getFinishedLogRecords();
      const degraded = records.find((r) => r.body === "strad.mount_degraded");
      expect(degraded?.severityNumber).toBe(SeverityNumber.ERROR);
      expect(degraded?.attributes).toEqual({
        "strad.evt": "strad.mount_degraded",
        slug: "fetchpet",
        bundle: "bundle",
      });
      const recovered = records.find((r) => r.body === "strad.mount_recovered");
      expect(recovered?.severityNumber).toBe(SeverityNumber.INFO);
      expect(recovered?.attributes).toEqual({
        "strad.evt": "strad.mount_recovered",
        slug: "fetchpet",
        bundle: "bundle",
      });

      expect(JSON.stringify(records)).not.toContain(CANARY);
      expect(JSON.stringify(records)).not.toMatch(/login failed/i);

      // The streams too. They are never shipped, but core has no business
      // repeating the bundle's words: the bundle's own log already holds them,
      // and on core they would be one careless allowlist edit from leaving.
      const streamed = [...out.mock.calls, ...err.mock.calls]
        .map((c) => c.map(String).join(" "))
        .join("\n");
      expect(streamed).toContain("strad.mount_degraded");
      expect(streamed).not.toContain(CANARY);
      expect(streamed).not.toMatch(/login failed/i);
    } finally {
      out.mockRestore();
      err.mockRestore();
      disableEventExport();
      await provider.shutdown().catch(() => {});
      logs.disable();
    }
  });
});

describe("core's /healthz", () => {
  it("names the degraded mount beside `degraded`, and publishes no word of the bundle's", async () => {
    const m = monitor({ log: () => {}, warn: () => {} });
    await m.refresh();
    const app = createApp({
      config: CONFIG,
      registry,
      tokenStore: tokenStoreFromConfig(CONFIG, env),
      mode: "core",
      env,
      toolSurfaces: () => m.snapshot(),
    });
    const server = await listen(app);
    try {
      const res = await fetch(`${addressOf(server)}/healthz`);
      const raw = await res.text();
      const body = JSON.parse(raw) as {
        ok: boolean;
        degraded: string[];
        mountDegraded: string[];
        toolSurfaces: { servers: { slug: string; mount?: string }[] };
      };
      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.degraded).toEqual([]);
      expect(body.mountDegraded).toEqual(["fetchpet"]);
      expect(
        body.toolSurfaces.servers.find((s) => s.slug === "fetchpet")?.mount,
      ).toBe("degraded");
      expect(raw).not.toContain(CANARY);
      expect(raw).not.toMatch(/login failed/i);
    } finally {
      server.close();
    }
  });
});

function listen(app: express.Express): Promise<HttpServer> {
  return new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
}

function addressOf(server: HttpServer): string {
  const addr = server.address();
  if (typeof addr === "string" || !addr) throw new Error("no port");
  return `http://127.0.0.1:${addr.port}`;
}
