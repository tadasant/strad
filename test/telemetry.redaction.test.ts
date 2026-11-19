import { sharedSecretProviders } from "../src/secrets/provider/index.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { metrics, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import {
  InMemoryLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
  type ReadableLogRecord,
} from "@opentelemetry/sdk-logs";
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
  disableEventExport,
  enableEventExport,
  event,
  EXPORTABLE,
  resetEventThrottle,
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
// The console's credential. A different door, and the same rule: the playground
// runs tool calls too, so its surface goes under the same canary.
const CANARY_CONSOLE_TOKEN = "console-CANARY-bootstrap-must-never-export-8b2d";
// The TOOL NAME on a call the capability policy withholds. `mcp.tool_denied` is
// exported, so the name a caller invents is the field on that record with a
// client's bytes in it — and `?servers=` is the only other place they reach
// strad's own vocabulary. Shaped like a plausible tool name, because that is
// what would make an export of it look harmless in review.
const CANARY_TOOL = "delete_everything-CANARY-tool-name-must-not-export-3e9a";

const CONFIG = parseConfig(`
version: 1
gateway: { name: strad, env: test }
auth:
  staticTokens: { enabled: true }
  consoleDevBypass: { enabled: true, roles: [admin] }
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
  - slug: gamma
    kind: builtin
    module: "./servers/echo.js"
    entitlements: [admin]
    tools:
      allow: [echo]
  - slug: delta
    kind: builtin
    module: "./servers/echo.js"
    entitlements: [admin]
    tools:
      allow: [echo]
`);

const adminToken = mintToken({ env: "test", label: "admin", roles: ["admin"] });
const limitedToken = mintToken({
  env: "test",
  label: "limited",
  roles: ["limited"],
});

const env: NodeJS.ProcessEnv = {
  STRAD_TOKENS: JSON.stringify([adminToken.record, limitedToken.record]),
  ALLOW_DEV_AUTH: "true",
  ADMIN_BOOTSTRAP_TOKEN: CANARY_CONSOLE_TOKEN,
};

const spanExporter = new InMemorySpanExporter();
const logExporter = new InMemoryLogRecordExporter();
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
let loggerProvider: LoggerProvider;
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

  // strad exports its OWN structured events as OTLP logs (src/telemetry/events.ts),
  // against a per-event field allowlist. That is a NEW way for text to leave this
  // process, so it goes under the same canary as spans and metrics.
  loggerProvider = new LoggerProvider({
    processors: [new SimpleLogRecordProcessor({ exporter: logExporter })],
  });
  logs.disable();
  logs.setGlobalLoggerProvider(loggerProvider);
  enableEventExport("strad-test", "0.0.0");

  // Instruments memoise their meter, so drop any no-op ones captured by an
  // earlier test file in the same worker.
  resetInstruments();

  // The process/container observables (RSS, cgroup memory, event-loop lag, GC).
  // startTelemetry() does this in production; here we do it directly so the test
  // does not need a live OTLP endpoint.
  runtime = startRuntimeMetrics();

  const registry = await Registry.build({
    config: CONFIG,
    secrets: sharedSecretProviders(new EnvSecretProvider({})),
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

  // 1b. THE SAME CALL, through the console playground.
  //
  //     A human MCP client is a second path into `adapter.callTool`, carrying
  //     the same arguments and returning the same result — so it is a second way
  //     for a vault item to reach an exporter, and it goes under the same
  //     canary rather than being trusted because it is "internal".
  const playground = await fetch(`${baseUrl}/playground/alpha/tools/call`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `strad_console=${CANARY_CONSOLE_TOKEN}`,
    },
    body: JSON.stringify({
      tool: "alpha__echo",
      arguments: { text: CANARY_ARG, email: CANARY_ARG_2 },
    }),
  });
  // Sanity, for the same reason as above: if the playground stopped calling the
  // tool, its half of the canary would pass by doing nothing.
  expect(JSON.stringify(await playground.json())).toContain(CANARY_ARG);

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

  // 4. A 424 for a server that does not EXIST, named with the canary.
  //
  //    The throttle keys `mcp.unavailable` on one global bucket, so the 424
  //    above would suppress this one's export. Two distinct scenarios, not a
  //    repeated fault — reset between them.
  resetEventThrottle();
  //
  //    `?servers=` is parsed and deduped and validated against nothing, so this
  //    is the one place a client writes free text into strad's own vocabulary.
  //    An earlier draft of the event allowlist echoed it straight into an
  //    exported log record, and the metric attribute minted a new time series
  //    per distinct string on top. Neither is caught by planting the canary in
  //    a tool argument, which is why it is planted HERE as well.
  await fetch(`${baseUrl}/mcp?servers=${encodeURIComponent(CANARY_ARG)}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${adminToken.plaintext}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });

  // 5. A tools/call the capability policy WITHHOLDS, asking for a tool name
  //    that does not exist and carries the canary.
  //
  //    `gamma` allows `echo` and nothing else, so this is refused before the
  //    adapter is reached. The refusal's record IS exported — `slug` and
  //    `principal` are strad's own — and the name below is the field on it a
  //    client writes, which is why the canary is planted here as well as in the
  //    tool arguments and the `?servers=` string.
  resetEventThrottle();
  const denied = new Client({ name: "test", version: "1" });
  await denied.connect(
    new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: {
        headers: { authorization: `Bearer ${adminToken.plaintext}` },
      },
    }),
  );
  // Sanity, for the same reason as the calls above: if the policy stopped
  // refusing, the assertions below would pass by never having been exercised.
  await expect(
    denied.callTool({ name: `gamma__${CANARY_TOOL}`, arguments: {} }),
  ).rejects.toThrow(/capability policy withholds it/);
  // A SECOND slug refused inside the same 60s window, with NO throttle reset
  // between them. `mcp.tool_denied` is throttled per bucket, and the bucket is
  // `payload.slug` — so this is what fails if the payload field is spelled
  // `server` again: both refusals would land in one global bucket and only
  // gamma's would export.
  await expect(
    denied.callTool({ name: `delta__${CANARY_TOOL}`, arguments: {} }),
  ).rejects.toThrow(/capability policy withholds it/);
  await denied.close();

  await tracerProvider.forceFlush();
  await metricReader.forceFlush();
});

afterAll(async () => {
  server?.close();
  runtime?.stop();
  await metricReader.shutdown().catch(() => {});
  await tracerProvider.shutdown().catch(() => {});
  await meterProvider.shutdown().catch(() => {});
  disableEventExport();
  await loggerProvider?.shutdown().catch(() => {});
  logs.disable();
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
  const logRecords = logExporter
    .getFinishedLogRecords()
    .map((r: ReadableLogRecord) => ({
      body: r.body,
      attributes: r.attributes,
      severityNumber: r.severityNumber,
    }));
  return JSON.stringify({ spans, metrics: metricPayload, logs: logRecords });
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
    // The console's credential rides on a cookie rather than a header, and the
    // playground is the surface that reads it.
    expect(payload).not.toContain(CANARY_CONSOLE_TOKEN);
    expect(payload).not.toContain("Bearer ");
  });

  it("exports no TOOL NAME from a call the capability policy refused", () => {
    // `mcp.tool_denied` ships, and the record's `tool` is everything the caller
    // wrote after the `__` — validated against nothing, because the whole point
    // of the refusal is that no such tool exists here. If it ever reaches the
    // allowlist, a client can write any string it likes into the ingestor by
    // calling a tool that is not there. Both channels, one assertion: the blob
    // below is every span, every metric data point and every log record.
    expect(exportedPayload()).not.toContain(CANARY_TOOL);
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
      .find(
        (s) =>
          s.name === "mcp.tools.call" &&
          s.attributes["strad.surface"] === "mcp",
      );

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
    const call = spans.find(
      (s) =>
        s.name === "mcp.tools.call" && s.attributes["strad.surface"] === "mcp",
    );
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

  it("attributes every /mcp request to a BOUNDED principal: the pubid, or `unauthenticated`", () => {
    const points = findMetric("strad.mcp.requests")!.dataPoints;
    const principals = new Set(
      points.map((d) => d.attributes["strad.principal"]),
    );
    // The verified token's non-secret lookup key, and nothing derived from its
    // secret half.
    expect(principals).toContain(`token:${adminToken.record.pubid}`);
    expect(principals).toContain(`token:${limitedToken.record.pubid}`);
    // The 401 with the canary token is one fixed word, so a caller presenting
    // a thousand different strings mints one series, not a thousand.
    expect(principals).toContain("unauthenticated");
    const unauth = points.find(
      (d) => d.attributes["strad.principal"] === "unauthenticated",
    );
    expect(unauth!.attributes["outcome"]).toBe("unauthenticated");
    expect(principals.size).toBe(3);
  });

  it("attributes tool calls and 424s to the principal, playground included", () => {
    const calls = findMetric("strad.mcp.tool_calls")!.dataPoints;
    const mcp = calls.find((d) => d.attributes["strad.surface"] === "mcp");
    expect(mcp!.attributes["strad.principal"]).toBe(
      `token:${adminToken.record.pubid}`,
    );
    const playground = calls.find(
      (d) => d.attributes["strad.surface"] === "playground",
    );
    // A human is their kind, never their Google subject.
    expect(playground!.attributes["strad.principal"]).toMatch(
      /^(google|console-bypass|console-token)$/,
    );

    // A capability refusal names the principal too, and still no tool.
    const refused = findMetric("strad.mcp.tool_denials")!.dataPoints.find(
      (d) => d.attributes["mcp.server"] === "gamma",
    );
    expect(refused!.attributes["strad.principal"]).toBe(
      `token:${adminToken.record.pubid}`,
    );

    const denied = findMetric("strad.mcp.unavailable")!.dataPoints.find(
      (d) => d.attributes["mcp.server"] === "beta",
    );
    expect(denied!.attributes["strad.principal"]).toBe(
      `token:${limitedToken.record.pubid}`,
    );
  });

  it("counts distinct source networks per principal, never the address", () => {
    const points = findMetric("strad.mcp.source_networks")!.dataPoints;
    const admin = points.find(
      (d) =>
        d.attributes["strad.principal"] === `token:${adminToken.record.pubid}`,
    );
    // Every request came from 127.0.0.1, which is one /24.
    expect(admin!.value).toBe(1);
    // A 401 never reaches the tracker.
    expect(
      points.some((d) => d.attributes["strad.principal"] === "unauthenticated"),
    ).toBe(false);
    // The principal is the only attribute: no address, no network.
    expect(Object.keys(admin!.attributes)).toEqual(["strad.principal"]);
    expect(JSON.stringify(points)).not.toContain("127.0.0");
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

  it("ships strad's own events as logs — otherwise the canary above passes for nothing", () => {
    // Without this, every log assertion in this file would be vacuously true on
    // an implementation that exports no logs at all. Which is exactly the
    // implementation that let a dead slug hide for a week.
    const records = logExporter.getFinishedLogRecords();
    expect(records.length).toBeGreaterThan(0);

    // `mcp.auth_failed` is deliberately NOT exported, even though its fields are
    // safe: it fires before authentication succeeds, so anyone who can POST
    // /mcp could fill the batch queue and evict the signals that matter. The
    // metric counts it instead, in a channel with no queue to starve.
    expect(records.some((r) => r.body === "mcp.auth_failed")).toBe(false);
    expect(allMetricNames()).toContain("strad.mcp.auth_failures");

    // The 424 for `beta`: a CONFIGURED slug, so it may be named.
    const unavailable = records.filter((r) => r.body === "mcp.unavailable");
    expect(
      unavailable.some((r) =>
        (r.attributes["unavailable"] as string[] | undefined)?.includes("beta"),
      ),
    ).toBe(true);

    // The 424 for the canary: a slug that names NOTHING, so it is counted and
    // never repeated back. `requested` is on no allowlist at all.
    const invented = unavailable.find(
      (r) => (r.attributes["unknown_count"] as number) > 0,
    );
    expect(invented).toBeDefined();
    expect(invented?.attributes["unavailable"]).toEqual([]);
    expect(invented?.attributes).not.toHaveProperty("requested");
  });

  it("tells a human's tool call apart from an agent's, on the span and the metric", () => {
    // Both run the same code, so without this attribute a console session's
    // thinking time lands in the same latency series as an agent's calls.
    const surfaces = spanExporter
      .getFinishedSpans()
      .filter((s) => s.name === "mcp.tools.call")
      .map((s) => s.attributes["strad.surface"]);
    expect(surfaces).toContain("mcp");
    expect(surfaces).toContain("playground");

    const metricSurfaces = findMetric("strad.mcp.tool_calls")!.dataPoints.map(
      (d) => d.attributes["strad.surface"],
    );
    expect(metricSurfaces).toContain("mcp");
    expect(metricSurfaces).toContain("playground");
  });

  it("delivers a policy refusal as a slug and a count, and nothing else", () => {
    // The pair is the design. The record says WHICH slug refused; the counter
    // says HOW OFTEN, which is the question the missing `tool` would otherwise
    // have been asked. The throw sits ahead of the `strad.mcp.tool_calls`
    // block, so the counter is the only thing that can answer it.
    const records = logExporter
      .getFinishedLogRecords()
      .filter((r) => r.body === "mcp.tool_denied");
    const record = records.find((r) => r.attributes["slug"] === "gamma");
    expect(record, "no mcp.tool_denied record was exported").toBeDefined();
    // `strad.evt` and `slug`. Named rather than left to the canary above, so
    // this fails on the CHANGE and not only on a string that happens to be
    // distinctive — and the exact-match is what catches a field added back.
    expect(Object.keys(record!.attributes).sort()).toEqual([
      "slug",
      "strad.evt",
    ]);
    // `tool` is the caller's own bytes. `principal` is a token `pubid` through
    // router.ts and a signed-in human's Google `sub` through the playground,
    // which builds this same server — so neither ships.
    expect(record!.attributes).not.toHaveProperty("tool");
    expect(record!.attributes).not.toHaveProperty("principal");

    // The throttle buckets on `payload.slug`, so a second slug refused in the
    // same window gets its own record rather than being swallowed by gamma's.
    expect(
      records.map((r) => r.attributes["slug"]).sort(),
      "the per-slug throttle bucket collapsed",
    ).toEqual(["delta", "gamma"]);

    const denials = findMetric("strad.mcp.tool_denials");
    expect(denials, "no strad.mcp.tool_denials series").toBeDefined();
    const point = denials!.dataPoints.find(
      (d) => d.attributes["mcp.server"] === "gamma",
    );
    expect(point?.value).toBe(1);
    expect(point!.attributes["strad.surface"]).toBe("mcp");
    // An unbounded `mcp.tool` attribute here is a cardinality bomb any token
    // holder could set off by calling names that do not exist, which is the
    // second reason the tool name is not on this pair.
    expect(point!.attributes).not.toHaveProperty("mcp.tool");
  });

  it("exports the boot line that says this component's exporter came up", () => {
    // `telemetry.started` is the record that tells "the container never
    // started" apart from "the container started, telemetry was fine, and boot
    // died mounting a server", for the strad image. It exports its NAME and
    // nothing else: every one of its fields is already a resource attribute of
    // the record carrying it.
    //
    // The gateway under test does not run startTelemetry (the harness wires the
    // providers directly), so this drives events.ts itself rather than a boot.
    event({
      evt: "telemetry.started",
      service: "strad-core",
      component: "core",
      environment: "test",
      endpoint: "https://otel.example.com",
      browser: false,
    });
    const started = logExporter
      .getFinishedLogRecords()
      .find((r) => r.body === "telemetry.started");
    expect(started, "telemetry.started did not export").toBeDefined();
    expect(Object.keys(started!.attributes)).toEqual(["strad.evt"]);
  });

  it("keeps the playground's own log line out of the ingestor", () => {
    // `ui.playground.tool_call` names a tool a human TYPED into a text field,
    // which is not a word from a set this repo wrote down. It is on no
    // allowlist, so it reaches stdout and stops there.
    const records = logExporter.getFinishedLogRecords();
    expect(records.some((r) => r.body === "ui.playground.tool_call")).toBe(
      false,
    );
  });

  it("mints no metric series from a slug the caller invented", () => {
    // Not just a redaction problem: an unbounded `mcp.server` attribute is a
    // cardinality bomb any token holder could set off.
    const servers = findMetric("strad.mcp.unavailable")!.dataPoints.map(
      (d) => d.attributes["mcp.server"],
    );
    expect(servers).toContain("beta");
    expect(servers).toContain("(not configured)");
    expect(servers).not.toContain(CANARY_ARG);
  });

  it("exports no field that is not on that event's allowlist", () => {
    // The boundary is deny-by-default, so this holds for fields nobody has
    // thought of yet — including any added to a log call later by someone who
    // has never read events.ts.
    for (const record of logExporter.getFinishedLogRecords()) {
      const evt = String(record.body);
      const allowed = new Set([...(EXPORTABLE[evt] ?? []), "strad.evt"]);
      // `error.kind` is a substitution, not a passthrough: see events.ts.
      allowed.add("error.kind");
      for (const key of Object.keys(record.attributes)) {
        expect(allowed.has(key), `${evt} exported "${key}"`).toBe(true);
      }
    }
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
