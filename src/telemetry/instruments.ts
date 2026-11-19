import {
  metrics,
  trace,
  type Gauge,
  type Histogram,
  type ObservableGauge,
  type ObservableResult,
  type Counter,
  type UpDownCounter,
} from "@opentelemetry/api";
import { sourceNetworks } from "./principal.ts";
import type { ErrorKind } from "./redact.ts";

/**
 * The gateway's instruments.
 *
 * Everything here goes through the OTel *API*, never the SDK. That is what makes
 * the whole thing free when telemetry is off: with no SDK registered,
 * `metrics.getMeter()` hands back a no-op meter and `trace.getTracer()` a no-op
 * tracer, so every call site below compiles down to a method call that returns
 * immediately. There is no `if (telemetryEnabled)` anywhere in the gateway, and
 * there must never need to be — an unset OTEL_EXPORTER_OTLP_ENDPOINT changes
 * nothing about how strad executes a request.
 *
 * Instruments are created lazily and memoised, because the meter must not be
 * resolved at module-import time: the SDK is started inside main(), and a meter
 * captured before that would be permanently the no-op one.
 */

export const TRACER_NAME = "strad.gateway";
export const METER_NAME = "strad.gateway";

/**
 * Seconds elapsed since a `process.hrtime.bigint()` mark.
 *
 * Here because every histogram in this file takes seconds and every caller
 * marks with `hrtime` — the monotonic clock, so a duration cannot go negative
 * when NTP steps the wall clock mid-request. Every module that records one of
 * these durations imports it from here.
 */
export function elapsedSeconds(startedAt: bigint): number {
  return Number(process.hrtime.bigint() - startedAt) / 1e9;
}

export function tracer() {
  return trace.getTracer(TRACER_NAME);
}

interface GatewayInstruments {
  /**
   * /mcp requests, by outcome and by `strad.principal` — the bounded caller
   * identity from src/telemetry/principal.ts, `unauthenticated` for a 401.
   */
  requests: Counter;
  requestDuration: Histogram;
  /** Requests currently in flight. THE concurrency signal. */
  inFlight: UpDownCounter;

  /** 401s, by reason. A spike means a client is misconfigured, not that we're slow. */
  authFailures: Counter;
  /** 424 fail-closed: the client asked for a server it may not have. */
  unavailable: Counter;
  /**
   * A server the client named whose upstream could not be listed at all.
   *
   * Distinct from `unavailable`, which is an entitlement answer and a 424. This
   * one is a reachability answer and rides inside a 200 (a JSON-RPC error is
   * still an HTTP 200), so without its own counter it moves nothing.
   */
  unlistable: Counter;

  /**
   * How many tools each mounted slug is currently serving.
   *
   * THE metric this fleet was missing. A slug can be configured, entitled,
   * routed and dead, and the only symptom is an empty `tools/list` — for a week,
   * on both environments, the only trace of that was a stdout line nothing
   * ingests. A gauge at zero, attributed by slug, is the thing an alert can be
   * hung on.
   *
   * Recorded with `mcp.server` and `mcp.upstream.kind` and NOTHING that varies
   * over the life of a slug: under cumulative temporality a stale attribute set
   * is re-exported at its last value forever. See gateway/reachability.ts.
   */
  toolSurface: Gauge;
  /**
   * 1 when the bundle hosting a slug's mount reports it degraded, 0 when it
   * reports it serving.
   *
   * `toolSurface`'s blind spot: a mount can list every tool and fail every call
   * (a stale login), and only the bundle knows. Same two attributes as
   * `toolSurface`, both from the config, so the two join slug for slug — and the
   * bundle's reason for it is on neither. See gateway/mount-health.ts.
   */
  mountDegraded: Gauge;

  toolCalls: Counter;
  toolCallDuration: Histogram;
  /**
   * tools/call refusals by the capability policy, by server.
   *
   * Deliberately NOT an outcome on `toolCalls`: that counter is attributed by
   * `mcp.tool` as well as `mcp.server`, and the tool name on a refusal is
   * whatever the caller wrote after the `__` — an unbounded series any token
   * holder could mint, and a client-authored string in an ingestor. So the
   * refusal gets its own counter, carrying the config's own slug and the
   * bounded `strad.principal` (src/telemetry/principal.ts), never the name.
   * Same answer `authFailures` gives for `mcp.auth_failed`: when the
   * field cannot ship, the count does.
   */
  toolDenials: Counter;

  /** One per hop to an upstream MCP server. */
  upstreamDuration: Histogram;
  /**
   * Upstream timeouts, called out separately from other errors on purpose: the
   * MCP SDK's default request timeout is 60s and it applies at EVERY hop, so a
   * slow tool behind two hops dies at 60s and looks exactly like a platform bug.
   * This counter is how you tell those apart at a glance.
   */
  upstreamTimeouts: Counter;
  upstreamErrors: Counter;

  /**
   * Distinct client networks (IPv4 /24, IPv6 /48) each principal has called
   * `/mcp` from over the trailing hour, by `strad.principal`. Observed at
   * collection time from the in-process tracker, so a window that empties reads
   * 0 without waiting for a request. Never a network as a value: the count is
   * the only thing exported. See src/telemetry/principal.ts.
   */
  sourceNetworks: ObservableGauge;
}

let cached: GatewayInstruments | null = null;

export function instruments(): GatewayInstruments {
  if (cached) return cached;
  const meter = metrics.getMeter(METER_NAME);

  cached = {
    requests: meter.createCounter("strad.mcp.requests", {
      description: "MCP requests to /mcp, by outcome",
    }),
    requestDuration: meter.createHistogram("strad.mcp.request.duration", {
      description: "Wall time of an /mcp request",
      unit: "s",
    }),
    inFlight: meter.createUpDownCounter("strad.mcp.in_flight", {
      description:
        "MCP requests currently being served — the concurrency signal",
    }),
    authFailures: meter.createCounter("strad.mcp.auth_failures", {
      description: "401s at /mcp, by reason",
    }),
    unavailable: meter.createCounter("strad.mcp.unavailable", {
      description:
        "424 fail-closed responses: a requested server was not available to this principal",
    }),
    unlistable: meter.createCounter("strad.mcp.unlistable", {
      description:
        "tools/list failures for a server the client named: it is serving nothing",
    }),
    toolSurface: meter.createGauge("strad.mcp.tool_surface", {
      description:
        "Tools each mounted server is currently serving; 0 means it serves nothing",
    }),
    mountDegraded: meter.createGauge("strad.mcp.mount_degraded", {
      description:
        "1 when the bundle hosting a server's mount reports it degraded (a failed login, a missing credential), 0 when it reports it serving",
    }),
    toolCalls: meter.createCounter("strad.mcp.tool_calls", {
      description: "tools/call invocations, by server and outcome",
    }),
    toolCallDuration: meter.createHistogram("strad.mcp.tool_call.duration", {
      description: "Wall time of a tools/call, by server and tool",
      unit: "s",
    }),
    toolDenials: meter.createCounter("strad.mcp.tool_denials", {
      description:
        "tools/call invocations the capability policy withheld, by server. Carries no tool name: the name a client asked for is the client's own string.",
    }),
    upstreamDuration: meter.createHistogram("strad.mcp.upstream.duration", {
      description:
        "Wall time of one hop to an upstream MCP server. Per-server, so you can see which one is starving the others.",
      unit: "s",
    }),
    upstreamTimeouts: meter.createCounter("strad.mcp.upstream.timeouts", {
      description: "Upstream hops that hit the MCP SDK request timeout",
    }),
    upstreamErrors: meter.createCounter("strad.mcp.upstream.errors", {
      description: "Upstream hops that failed, by classified error kind",
    }),
    sourceNetworks: meter.createObservableGauge("strad.mcp.source_networks", {
      description:
        "Distinct client networks (IPv4 /24, IPv6 /48) each principal called /mcp from over the trailing hour. Per process; saturates at 64.",
    }),
  };
  cached.sourceNetworks.addCallback(observeSourceNetworks);
  return cached;
}

/** Test seam: drop the memoised instruments so a fresh meter provider is picked up. */
export function resetInstruments(): void {
  // A meter provider outlives this cache, so an observable left registered
  // would be observed again beside its replacement.
  cached?.sourceNetworks.removeCallback(observeSourceNetworks);
  cached = null;
}

function observeSourceNetworks(result: ObservableResult): void {
  for (const [principal, count] of sourceNetworks().counts()) {
    result.observe(count, { "strad.principal": principal });
  }
}

/** Attribute helpers. Slugs and tool names only — never arguments. See redact.ts. */
export function serverAttrs(
  slug: string,
  extra: Record<string, string | number | boolean> = {},
) {
  return { "mcp.server": slug, ...extra };
}

export function errorAttrs(slug: string, kind: ErrorKind) {
  return { "mcp.server": slug, "error.kind": kind };
}
