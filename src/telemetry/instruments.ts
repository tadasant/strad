import {
  metrics,
  trace,
  type Gauge,
  type Histogram,
  type Counter,
  type UpDownCounter,
} from "@opentelemetry/api";
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

export function tracer() {
  return trace.getTracer(TRACER_NAME);
}

interface GatewayInstruments {
  /** /mcp requests, by outcome. */
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

  toolCalls: Counter;
  toolCallDuration: Histogram;

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
    toolCalls: meter.createCounter("strad.mcp.tool_calls", {
      description: "tools/call invocations, by server and outcome",
    }),
    toolCallDuration: meter.createHistogram("strad.mcp.tool_call.duration", {
      description: "Wall time of a tools/call, by server and tool",
      unit: "s",
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
  };
  return cached;
}

/** Test seam: drop the memoised instruments so a fresh meter provider is picked up. */
export function resetInstruments(): void {
  cached = null;
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
