import { diag, DiagConsoleLogger, DiagLogLevel } from "@opentelemetry/api";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { installBrowserTelemetry } from "./browser.ts";
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
  errorKind,
  resultShape,
  type ErrorKind,
} from "./redact.ts";
export {
  errorAttrs,
  instruments,
  resetInstruments,
  serverAttrs,
  tracer,
} from "./instruments.ts";
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
 * Deliberately NOT configured: a log exporter. strad's stdout carries upstream
 * error messages, which are arbitrary text we did not author. Shipping those to
 * an external ingestor would drive straight through the boundary in redact.ts.
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
        // Flush what we have. A container being torn down for OOM is exactly when
        // the last few seconds of metrics matter most.
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
