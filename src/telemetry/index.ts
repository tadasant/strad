import { diag, DiagConsoleLogger, DiagLogLevel } from "@opentelemetry/api";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-proto";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { installBrowserTelemetry } from "./browser.ts";
import { disableEventExport, enableEventExport } from "./events.ts";
import { resetInstruments } from "./instruments.ts";
import {
  buildResource,
  identityFromEnv,
  serviceName,
  type ResourceIdentity,
} from "./resource.ts";
import { startRuntimeMetrics, type RuntimeMetricsHandle } from "./runtime.ts";

export {
  argShape,
  byteSize,
  credentialValues,
  errorKind,
  resultShape,
  scrubText,
  REDACTED,
  type ErrorKind,
} from "./redact.ts";
export {
  errorReporterOptions,
  redactErrorEvent,
  startErrorReporter,
  type ErrorReporterHandle,
  type StartErrorReporterOptions,
} from "./errors.ts";
export {
  errorAttrs,
  instruments,
  resetInstruments,
  serverAttrs,
  tracer,
} from "./instruments.ts";
export {
  disableEventExport,
  enableEventExport,
  event,
  eventExportEnabled,
  resetEventThrottle,
  EXPORTABLE,
} from "./events.ts";
export {
  installBrowserTelemetry,
  uninstallBrowserTelemetry,
  BROWSER_TELEMETRY_KEY,
  type BrowserTelemetryHooks,
} from "./browser.ts";
export {
  identityFromEnv,
  serviceName,
  type ResourceIdentity,
} from "./resource.ts";
export {
  startRuntimeMetrics,
  readCgroupMemoryLimit,
  readCgroupMemoryUsage,
  type RuntimeMetricsHandle,
} from "./runtime.ts";

/**
 * Start OpenTelemetry — or, if it is not configured, don't, and say so once.
 *
 * ── The load-bearing property: an unset endpoint changes NOTHING ─────────────
 *
 * staging and prod are LIVE. A telemetry misconfiguration must not be able to
 * take them down, and neither must a telemetry OUTAGE. So:
 *
 *   - No `OTEL_EXPORTER_OTLP_ENDPOINT` -> we start no SDK at all, log one line,
 *     and return. Every call site in the gateway keeps calling the OTel API,
 *     which without a registered SDK is a no-op tracer and a no-op meter. There
 *     is no branch to forget and no code path that only runs "when telemetry is
 *     on" — the instrumented path IS the path.
 *   - Any failure while STARTING the SDK (a malformed endpoint, an exporter that
 *     throws on construction) is caught, logged, and swallowed. strad boots.
 *   - An UNREACHABLE collector at runtime is the exporter's problem, not ours:
 *     OTLP export failures are retried and then dropped, on a background timer,
 *     and they never propagate into a request. The one thing they do is talk, so
 *     the diag logger is pinned to ERROR — enough to see "your collector is
 *     wrong", quiet enough not to bury the app's own logs.
 *
 * ── Logs: strad's OWN events, and only those ─────────────────────────────────
 *
 * There is a log exporter, and for a long time there deliberately was not. The
 * old reasoning was right as far as it went: stdout carries upstream error
 * messages, which are arbitrary text we did not author, and shipping the stream
 * wholesale would drive straight through the boundary in redact.ts.
 *
 * What that reasoning missed is the cost. The `secrets` slug served zero tools
 * in production for over a week. `mcp.list_tools_failed` named the failure on
 * every request, and went to a stream with no ingestor — on App Platform, a log
 * nobody ships is a log nobody reads. The boundary was intact and the deployment
 * was broken, invisibly, the whole time.
 *
 * So this exports strad's own structured events against a per-event field
 * ALLOWLIST (see events.ts), never the stdout stream. `error` is on no list; an
 * event that carries one exports `error.kind` — a word from redact.ts — instead.
 * stdout is unchanged and still carries everything, in full.
 */

export interface TelemetryHandle {
  readonly enabled: boolean;
  readonly serviceName: string;
  readonly identity: ResourceIdentity;
  /** Container memory utilisation (0..1) or null. Null when telemetry is off. */
  memoryUtilization(): number | null;
  shutdown(): Promise<void>;
}

export interface StartTelemetryOptions {
  env?: NodeJS.ProcessEnv;
  /** Defaults when the environment does not say. */
  identity?: Partial<ResourceIdentity>;
  /** Install the Chromium hooks on globalThis. Bundle images want this. */
  browser?: boolean;
  log?: (event: Record<string, unknown>) => void;
}

/** The instrumentation-scope version on exported log records. */
const VERSION = "0.1.0";

const DISABLED: Omit<TelemetryHandle, "serviceName" | "identity"> = {
  enabled: false,
  memoryUtilization: () => null,
  shutdown: async () => {},
};

export function startTelemetry(
  opts: StartTelemetryOptions = {},
): TelemetryHandle {
  const env = opts.env ?? process.env;
  const log = opts.log ?? ((e) => console.log(JSON.stringify(e)));
  const identity = identityFromEnv(env, opts.identity);
  const name = serviceName(env, identity);

  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  if (!endpoint) {
    // Not an error, and not a warning. Telemetry is opt-in; a deployment with no
    // ingestor is a perfectly ordinary deployment.
    log({
      evt: "telemetry.disabled",
      reason: "OTEL_EXPORTER_OTLP_ENDPOINT is not set",
      service: name,
    });
    // Both early returns hand back the DISABLED handle, whose shutdown() is a
    // no-op — so a logger left wired here would point at an SDK nothing will
    // ever flush, and would persist across a second call in the same process.
    disableEventExport();
    return { ...DISABLED, serviceName: name, identity };
  }

  try {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.ERROR);

    // The exporters read OTEL_EXPORTER_OTLP_ENDPOINT, _HEADERS, _PROTOCOL and the
    // per-signal overrides from the environment themselves — that is the whole
    // point of using the standard variables, and it means an operator can point
    // traces and metrics at different collectors without a code change.
    const sdk = new NodeSDK({
      resource: buildResource(env, identity),
      traceExporter: new OTLPTraceExporter(),
      metricReaders: [
        new PeriodicExportingMetricReader({
          exporter: new OTLPMetricExporter(),
          // 15s, not the 60s default. We are hunting a container that dies; a
          // 60s window can miss the entire memory ramp that preceded the kill.
          exportIntervalMillis: Number(
            env.OTEL_METRIC_EXPORT_INTERVAL ?? 15_000,
          ),
        }),
      ],
      // BATCHED, not simple. These are diagnostics, not an audit trail: a
      // per-record HTTP round trip on the failure path would add latency to
      // exactly the requests that are already going badly.
      logRecordProcessors: [
        new BatchLogRecordProcessor({ exporter: new OTLPLogExporter() }),
      ],
      // No auto-instrumentation, on purpose. It would monkey-patch http and
      // express to produce spans that are strictly worse than the ones the
      // gateway emits by hand (ours know the server slug, the tool name and the
      // upstream kind), while adding a patching surface to a process that proxies
      // credentials. Everything strad traces, it traces deliberately.
    });

    sdk.start();

    // Must come AFTER sdk.start(): a meter resolved before the provider is
    // registered is permanently the no-op meter, and the metrics would silently
    // never appear. Same reason instruments.ts memoises lazily.
    resetInstruments();
    // AFTER sdk.start(), which is what registers the logger provider. (Unlike
    // the metrics API, `logs.getLogger` before registration returns a proxy that
    // resolves later rather than a permanent no-op — but relying on that would
    // make the ordering look incidental when it is not.)
    enableEventExport(name, VERSION);
    const runtime: RuntimeMetricsHandle = startRuntimeMetrics();

    if (opts.browser) {
      installBrowserTelemetry({ memoryUtilization: runtime.memoryUtilization });
    }

    log({
      evt: "telemetry.started",
      service: name,
      component: identity.component,
      environment: identity.environment,
      endpoint: redactEndpoint(endpoint),
      browser: opts.browser === true,
    });

    return {
      enabled: true,
      serviceName: name,
      identity,
      memoryUtilization: runtime.memoryUtilization,
      async shutdown() {
        runtime.stop();
        disableEventExport();
        // Flush what we have. A container being torn down for OOM is exactly when
        // the last few seconds of metrics matter most — and the last few log
        // records are how you find out whether it went quietly.
        await sdk.shutdown().catch(() => {});
      },
    };
  } catch (err) {
    // Telemetry must NEVER be the reason a deploy fails. Log and carry on
    // uninstrumented — a blind strad is infinitely better than a dead one.
    log({
      evt: "telemetry.start_failed",
      service: name,
      error: err instanceof Error ? err.message : String(err),
    });
    // See the other early return: a wired logger on a DISABLED handle is a
    // logger nothing will flush. `startRuntimeMetrics` and the browser hooks run
    // after `enableEventExport`, so this path is reachable.
    disableEventExport();
    return { ...DISABLED, serviceName: name, identity };
  }
}

/**
 * An endpoint is a URL, not a secret — but a URL with credentials in it is a
 * thing people do, and this line gets logged. Strip userinfo and query.
 */
function redactEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    url.username = "";
    url.password = "";
    url.search = "";
    return url.toString();
  } catch {
    return "<unparseable>";
  }
}
