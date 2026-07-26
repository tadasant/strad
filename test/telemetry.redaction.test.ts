import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { metrics, trace } from "@opentelemetry/api";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tokenStoreFromConfig } from "../src/auth/index.ts";
import { mintToken } from "../src/auth/tokens.ts";
import { parseConfig } from "../src/config/load.ts";
import { Registry } from "../src/gateway/registry.ts";
import { createApp } from "../src/http/app.ts";
import { EnvSecretProvider } from "../src/secrets/provider/index.ts";
import {
  resetInstruments,
  startRuntimeMetrics,
  type RuntimeMetricsHandle,
} from "../src/telemetry/index.ts";

/**
 * THE SECRETS TEST.
 *
 * strad proxies 1Password vault items, Gmail bodies and grocery carts. Telemetry
 * leaves the box. If a tool argument or a tool result ever reaches a span
 * attribute, we have built a credential exfiltration pipeline and pointed it at
 * a third party — a strictly worse outcome than the resource-starvation problem
 * the telemetry exists to diagnose.
 *
 * So this test drives a REAL MCP tool call, through the real Express app, over a
 * real MCP client, with a canary string planted in BOTH the arguments AND the
 * result (the `echo` builtin returns its input, which is what makes it the
 * perfect vehicle). Then it serialises EVERYTHING the SDK would have exported —
 * every span, every attribute, every event, every status, every metric data
 * point and its attributes — and asserts the canary appears nowhere in it.
 *
 * It is deliberately a whole-payload substring assertion rather than a check of
 * specific fields. A field-by-field check only pins the leaks you thought of;
 * this pins the ones you didn't, including any added later by someone who has
 * never read redact.ts.
 *
 * The second half is just as important: it asserts the telemetry DOES emit the
 * things we need. Without that, this file would pass perfectly on an
 * implementation that exports nothing at all — which is a great way to leak no
 * secrets and also learn nothing.
 */

// Distinctive enough that a substring match cannot fire by accident, and shaped
// like the things that actually flow through strad.
const CANARY_ARG = "op://vault/SuperSecret/password-CANARY-9c1f4e2a";
const CANARY_ARG_2 = "tadas@example.com-CANARY-b7d3";
const CANARY_TOKEN = "strad_test_CANARY-token-must-never-be-exported-4f21";

const CONFIG = parseConfig(`
version: 1
gateway: { name: strad, env: test }
auth:
  staticTokens: { enabled: true }
roles:
  admin:   { servers: ["*"] }
  limited: { servers: [alpha] }
servers:
  - slug: alpha
    kind: builtin
    module: "./servers/echo.js"
    entitlements: [admin, limited]
    options: { greeting: "from alpha" }
  - slug: beta
    kind: builtin
    module: "./servers/echo.js"
    entitlements: [admin]
`);

const adminToken = mintToken({ env: "test", label: "admin", roles: ["admin"] });
const limitedToken = mintToken({
  env: "test",
  label: "limited",
  roles: ["limited"],
});

const env: NodeJS.ProcessEnv = {
  STRAD_TOKENS: JSON.stringify([adminToken.record, limitedToken.record]),
};

const spanExporter = new InMemorySpanExporter();
const metricExporter = new InMemoryMetricExporter(
  AggregationTemporality.CUMULATIVE,
);
const metricReader = new PeriodicExportingMetricReader({
  exporter: metricExporter,
  // Long interval: the test drives the flush itself, so the timer never fires.
  exportIntervalMillis: 600_000,
});

let tracerProvider: NodeTracerProvider;
let meterProvider: MeterProvider;
let runtime: RuntimeMetricsHandle;
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  // Register REAL providers globally. This is the whole point: instruments.ts
  // resolves its meter and tracer from the global API, so with these registered
  // the gateway is running fully instrumented — exactly as it does in
  // production, only exporting to memory instead of to an ingestor.
  tracerProvider = new NodeTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(spanExporter)],
  });
  tracerProvider.register();

  meterProvider = new MeterProvider({ readers: [metricReader] });
  metrics.setGlobalMeterProvider(meterProvider);

  // Instruments memoise their meter, so drop any no-op ones captured by an
  // earlier test file in the same worker.
  resetInstruments();

  // The process/container observables (RSS, cgroup memory, event-loop lag, GC).
  // startTelemetry() does this in production; here we do it directly so the test
  // does not need a live OTLP endpoint.
  runtime = startRuntimeMetrics();

  const registry = await Registry.build({
    config: CONFIG,
    secrets: new EnvSecretProvider({}),
    mode: "core",
    env,
  });
  const app = createApp({
    config: CONFIG,
    registry,
    tokenStore: tokenStoreFromConfig(CONFIG, env),
    mode: "core",
    env,
  });

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });

  // --- drive real traffic through the instrumented gateway -----------------

  // 1. A tool call whose ARGUMENTS and RESULT both carry the canary.
  const client = new Client({ name: "test", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: {
        headers: { authorization: `Bearer ${adminToken.plaintext}` },
      },
    }),
  );
  const result = await client.callTool({
    name: "alpha__echo",
    arguments: { text: CANARY_ARG, email: CANARY_ARG_2 },
  });
  await client.close();

  // Sanity: the canary really did make the round trip. If the echo server
  // stopped echoing, the leak assertions below would pass for the wrong reason.
  expect(JSON.stringify(result)).toContain(CANARY_ARG);

  // 2. A 401, driven with a canary TOKEN. The token is the most dangerous string
  //    in the whole system and it is the one an eager "log the auth header"
  //    change would expose first.
  await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${CANARY_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });

  // 3. A 424 fail-closed: a real token asking for a server it may not have.
  await fetch(`${baseUrl}/mcp?servers=beta`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${limitedToken.plaintext}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });

  await tracerProvider.forceFlush();
  await metricReader.forceFlush();
});

afterAll(async () => {
  server?.close();
  runtime?.stop();
  await metricReader.shutdown().catch(() => {});
  await tracerProvider.shutdown().catch(() => {});
  await meterProvider.shutdown().catch(() => {});
  trace.disable();
  metrics.disable();
  resetInstruments();
});

/** Everything the exporters would have sent, as one blob of text. */
function exportedPayload(): string {
  const spans = spanExporter.getFinishedSpans().map((s) => ({
    name: s.name,
    kind: s.kind,
    attributes: s.attributes,
    events: s.events,
    status: s.status,
    links: s.links,
    resource: s.resource.attributes,
  }));
  const metricPayload = metricExporter.getMetrics();
  return JSON.stringify({ spans, metrics: metricPayload });
}

describe("telemetry never exports secrets", () => {
  it("exports no tool ARGUMENT, anywhere, in any span or metric", () => {
    const payload = exportedPayload();
    expect(payload).not.toContain(CANARY_ARG);
    expect(payload).not.toContain(CANARY_ARG_2);
  });

  it("exports no tool RESULT content", () => {
    // Same canary — `echo` returns it — so a result leak and an argument leak
    // are both caught above. This case exists to name the second failure mode
    // explicitly: `span.setAttributes(result)` is a very natural thing to write.
    expect(exportedPayload()).not.toContain(CANARY_ARG);
  });

  it("exports no bearer token, even the invalid one that caused a 401", () => {
    const payload = exportedPayload();
    expect(payload).not.toContain(CANARY_TOKEN);
    // Nor any real token, nor the `Bearer ` header that would carry one.
    expect(payload).not.toContain(adminToken.plaintext);
    expect(payload).not.toContain(limitedToken.plaintext);
    expect(payload).not.toContain("Bearer ");
  });

  it("records no exception events (they carry upstream messages and stacks)", () => {
    // recordException() writes `exception.message` and `exception.stacktrace`.
    // An upstream MCP server's error text is arbitrary and not ours to export,
    // so strad classifies errors instead. If someone adds a recordException(),
    // this fails.
    const events = spanExporter
      .getFinishedSpans()
      .flatMap((s) => s.events.map((e) => e.name));
    expect(events).not.toContain("exception");
  });
});

describe("telemetry exports the signals we actually need", () => {
  // Without these, the tests above would pass on an implementation that emits
  // nothing whatsoever.

  it("emits a tools/call span carrying the server slug, tool name and arg SHAPE", () => {
    const call = spanExporter
      .getFinishedSpans()
      .find((s) => s.name === "mcp.tools.call");

    expect(call, "no mcp.tools.call span was exported").toBeDefined();
    expect(call!.attributes["mcp.server"]).toBe("alpha");
    expect(call!.attributes["mcp.tool"]).toBe("echo");

    // Shape, not content: two arguments went in, and their serialised size is
    // recorded — enough to spot a 4MB payload, useless for reconstructing one.
    expect(call!.attributes["mcp.tool.arg_count"]).toBe(2);
    expect(call!.attributes["mcp.tool.args_bytes"]).toBeGreaterThan(0);
    expect(call!.attributes["mcp.tool.result_bytes"]).toBeGreaterThan(0);
    expect(call!.attributes["mcp.tool.is_error"]).toBe(false);
  });

  it("nests the tool-call span under the /mcp request span", () => {
    const spans = spanExporter.getFinishedSpans();
    const call = spans.find((s) => s.name === "mcp.tools.call");
    expect(call).toBeDefined();

    // The endpoint is session-less, so a single MCP client produces SEVERAL
    // /mcp requests (initialize, then tools/call) and there are several
    // `mcp.request` spans. Resolve the tool call's actual parent by id rather
    // than assuming it is the first one.
    const parent = spans.find(
      (s) => s.spanContext().spanId === call!.parentSpanContext?.spanId,
    );

    // A flat pile of spans cannot attribute latency. The waterfall is the point.
    expect(parent, "the tools/call span is orphaned").toBeDefined();
    expect(parent!.name).toBe("mcp.request");
    // Same trace, so the ingestor stitches them into one waterfall.
    expect(call!.spanContext().traceId).toBe(parent!.spanContext().traceId);
  });

  it("records the requested-vs-selected server sets on the request span", () => {
    const request = spanExporter
      .getFinishedSpans()
      .find(
        (s) =>
          s.name === "mcp.request" &&
          Array.isArray(s.attributes["mcp.servers.selected"]),
      );
    expect(request).toBeDefined();
    expect(request!.attributes["mcp.servers.selected"]).toContain("alpha");
    expect(request!.attributes["mcp.principal.kind"]).toBe("system-token");
  });

  it("counts the 401 and the 424 fail-closed, without the credential", () => {
    const names = allMetricNames();
    expect(names).toContain("strad.mcp.auth_failures");
    expect(names).toContain("strad.mcp.unavailable");

    // The 424 names the SERVER that was withheld — a config slug, which is
    // exactly the identifier an operator needs and carries no authority.
    const unavailable = findMetric("strad.mcp.unavailable");
    const attrs = unavailable!.dataPoints.map((d) => d.attributes);
    expect(attrs.some((a) => a["mcp.server"] === "beta")).toBe(true);
  });

  it("emits the resource-constraint metrics (the whole reason we are here)", () => {
    const names = allMetricNames();
    // The OOM story.
    expect(names).toContain("strad.process.memory.rss");
    // The saturation story. On a 1-vCPU box this is the number that moves first.
    expect(names).toContain("strad.eventloop.delay.p99");
    // The concurrency story.
    expect(names).toContain("strad.mcp.in_flight");
    // Per-server latency: which server is starving the others.
    expect(names).toContain("strad.mcp.tool_call.duration");
  });
});

function allMetricNames(): string[] {
  return metricExporter
    .getMetrics()
    .flatMap((rm) => rm.scopeMetrics)
    .flatMap((sm) => sm.metrics)
    .map((m) => m.descriptor.name);
}

function findMetric(name: string) {
  return metricExporter
    .getMetrics()
    .flatMap((rm) => rm.scopeMetrics)
    .flatMap((sm) => sm.metrics)
    .find((m) => m.descriptor.name === name);
}
