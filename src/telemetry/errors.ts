import type { ErrorEvent, NodeOptions } from "@sentry/node";
import { credentialValues, scrubText } from "./redact.ts";
import {
  identityFromEnv,
  serviceName,
  type ResourceIdentity,
} from "./resource.ts";

/**
 * Exception reporting over the Sentry protocol, into GlitchTip.
 *
 * ## The gap this fills
 *
 * strad exports OTLP metrics, traces and logs, and the log path carries strad's
 * OWN structured events against an allowlist (see `events.ts`). That is a
 * deliberate deny-by-default design and nothing here changes it.
 *
 * What it leaves uncovered is the process dying. An uncaught `TypeError`, an
 * unhandled rejection, an OOM — none of those go through `event()`, so none of
 * them produce telemetry. They produce a stack trace on stdout, and the stdout
 * STREAM is never shipped: on App Platform, a log nobody ships is a log nobody
 * reads. The component restarts, `service.instance.id` changes, and the
 * ingestor can tell you that strad restarted but not one word about why.
 *
 * This closes that: uncaught exceptions and unhandled rejections are reported to
 * a GlitchTip instance, which speaks the Sentry ingest protocol, so the official
 * `@sentry/node` SDK is the client.
 *
 * ## Off by default, and completely off
 *
 * The OSS repo bakes in no integrations. With no `SENTRY_DSN` set there is no
 * `Sentry.init()`, no process handler, no network, and — because the SDK is
 * behind a dynamic `import()` — the module is never even loaded. Nothing is
 * logged either: an unconfigured crash reporter is not an event, and a developer
 * running `npm run dev` should see exactly what they saw before. The line that
 * proves the feature is ON is `errors.started`; its absence is the answer to
 * "is it off".
 *
 * ## What it reports, and what it will not
 *
 * ONLY strad's own fatal faults. In particular it does NOT capture the `event()`
 * fault path (`*_failed`, `*_degraded`), and that is a decision rather than an
 * omission:
 *
 *   - Those events already have a first-class export: an OTLP log record, at
 *     ERROR severity, against a per-event field allowlist. Sending them twice
 *     buys no signal.
 *   - They are the events an UPSTREAM can drive. `mcp.list_tools_failed` fires
 *     once per failing slug per listing, and its `error` is text strad did not
 *     author — the reason the allowlist ships `error.kind` instead. Feeding that
 *     to an issue tracker would fill it with one upstream's HTML error page,
 *     grouped as a strad defect, and drown the crashes this exists to surface.
 *   - A caught, classified error is a condition strad handled. A crash is not.
 *     GlitchTip should hold the second kind.
 *
 * The `strad.evt`-shaped question ("which surface is failing") is answered by
 * OTLP. The question here is "which line of strad's own code blew up".
 *
 * ## Secrets
 *
 * This is the ONE channel in strad that ships free text (see the long note in
 * `redact.ts`), and strad proxies 1Password items, Gmail threads and a secrets
 * provider. So:
 *
 *   - `sendDefaultPii: false`, and no default integrations at all. The SDK's
 *     defaults would attach request data (headers, cookies, query strings),
 *     console output as breadcrumbs (which is every upstream error message strad
 *     logs) and source-context lines. Every one of those is a channel for
 *     something we did not author. The only integrations installed are the two
 *     process handlers and `dedupe`.
 *   - `beforeSend` rebuilds the event from a key ALLOWLIST — the same discipline
 *     as `events.ts` — and runs `scrubText()` over every string that survives.
 *     A field a future SDK version adds is dropped rather than shipped, because
 *     being on the list is how a field gets exported.
 *   - `beforeBreadcrumb` returns null. There are no breadcrumbs.
 *
 * ## Tracing
 *
 * `tracesSampleRate: 0`, `beforeSendTransaction` returns null, and
 * `skipOpenTelemetrySetup: true` so the SDK does not register a tracer provider
 * of its own. strad's traces go to Tempo over OTLP, from an OTel SDK this
 * repo configures deliberately; a second SDK racing it for the global provider
 * is how you lose both.
 */

/** Set by the app spec, or by an operator. Unset means the reporter is off. */
const DSN_ENV = "SENTRY_DSN";

export interface ErrorReporterHandle {
  readonly enabled: boolean;
  /**
   * Report a fatal that is about to end the process by a route the handlers
   * cannot see, and flush before it does.
   *
   * There is exactly one: a boot that throws. `main().catch()` prints it and
   * calls `process.exit(1)` — it never becomes an `uncaughtException`, so the
   * integration never fires. That path is also the likeliest crash strad has (a
   * malformed config, an unreachable bundle, a store that will not answer), and
   * leaving it out would mean the reporter covered every failure except the
   * common one.
   */
  captureFatal(err: unknown, phase: string): Promise<void>;
  /** Flush pending events, bounded. Safe to call when disabled. */
  flush(timeoutMs?: number): Promise<void>;
  /** Flush and close the client. Safe to call when disabled. */
  shutdown(): Promise<void>;
}

export interface StartErrorReporterOptions {
  env?: NodeJS.ProcessEnv;
  /** Defaults when the environment does not say. */
  identity?: Partial<ResourceIdentity>;
  log?: (event: Record<string, unknown>) => void;
  /**
   * Test seam: the SDK's transport factory. Tests hand in one that records
   * envelopes instead of opening a socket, which is the only way to assert on
   * the SHAPE of what would be sent without sending it.
   */
  transport?: NodeOptions["transport"];
}

const DISABLED: ErrorReporterHandle = {
  enabled: false,
  captureFatal: async () => {},
  flush: async () => {},
  shutdown: async () => {},
};

/**
 * Start the exception reporter — or, with no DSN, do precisely nothing.
 *
 * Never throws. Telemetry must not be the reason a deploy fails, and a crash
 * reporter that crashes the boot is a special kind of embarrassing: an invalid
 * DSN, a network stack that will not resolve, an SDK that changed its options
 * shape — all of them land in the catch and leave strad running, uninstrumented.
 */
export async function startErrorReporter(
  opts: StartErrorReporterOptions = {},
): Promise<ErrorReporterHandle> {
  const env = opts.env ?? process.env;
  const dsn = env[DSN_ENV]?.trim();
  // The load-bearing early return: no DSN, no import, no init, no log line.
  if (!dsn) return DISABLED;

  const log = opts.log ?? ((e) => console.log(JSON.stringify(e)));
  const identity = identityFromEnv(env, opts.identity);
  const name = serviceName(env, identity);

  try {
    // Dynamic, so that an unconfigured deployment does not pay for the SDK at
    // all — not the import, not the module-init side effects, not the memory. A
    // static import would run all of that in every dev shell and every test.
    const Sentry = await import("@sentry/node");
    Sentry.init(
      errorReporterOptions({
        dsn,
        env,
        identity,
        integrations: [
          // The two handlers this exists for. `mode: "strict"` on rejections
          // preserves Node's own behaviour — report, print, exit non-zero.
          // The SDK's default ("warn") would install a handler that SWALLOWS
          // the rejection, turning a crash into a warning: a behaviour change
          // smuggled in by a telemetry feature, which is not a trade this
          // change is allowed to make.
          Sentry.onUncaughtExceptionIntegration(),
          Sentry.onUnhandledRejectionIntegration({ mode: "strict" }),
          // One report per distinct fault. A restart loop otherwise reports the
          // same stack until the quota says stop.
          Sentry.dedupeIntegration(),
        ],
        ...(opts.transport ? { transport: opts.transport } : {}),
      }),
    );

    log({
      evt: "errors.started",
      service: name,
      component: identity.component,
      environment: identity.environment,
      release: identity.version,
      // The DSN embeds a key. What an operator needs from this line is "which
      // ingestor", which the host answers.
      ingest: dsnHost(dsn),
    });

    return {
      enabled: true,
      async captureFatal(err: unknown, phase: string) {
        try {
          Sentry.captureException(err, {
            level: "fatal",
            // Which phase died. A boot failure and a request-path crash are
            // different incidents and should not group as one issue.
            tags: { "strad.phase": phase },
          });
          await Sentry.flush(2000);
        } catch {
          // The process is already on its way out. Reporting the report's
          // failure would be the last thing anyone needs.
        }
      },
      async flush(timeoutMs = 2000) {
        await Sentry.flush(timeoutMs).catch(() => false);
      },
      async shutdown() {
        // Bounded, and its own errors swallowed: App Platform sends SIGTERM and
        // does not wait long, and a dead ingestor must not be what gets strad
        // SIGKILLed on the way out.
        await Sentry.close(2000).catch(() => false);
      },
    };
  } catch (err) {
    log({
      evt: "errors.start_failed",
      service: name,
      error: err instanceof Error ? err.message : String(err),
    });
    return DISABLED;
  }
}

/**
 * The SDK options, as a pure function of the environment.
 *
 * Separated from `startErrorReporter` so a test can assert the whole posture —
 * PII off, tracing off, no default integrations, the right release and
 * environment — without initialising anything.
 */
export function errorReporterOptions(args: {
  dsn: string;
  env: NodeJS.ProcessEnv;
  identity: ResourceIdentity;
  integrations?: NodeOptions["integrations"];
  transport?: NodeOptions["transport"];
}): NodeOptions {
  const { dsn, env, identity } = args;
  const name = serviceName(env, identity);

  return {
    dsn,
    // The SAME identity OTLP stamps. `environment` is what OTLP exports as
    // `deployment.environment` ("prod", "staging", "dev") and `release` is
    // `service.version` — the deployed image TAG, not the VERSION file — so a
    // GlitchTip issue and a Grafana log record can be lined up by release and
    // environment without anyone maintaining a mapping.
    environment: identity.environment,
    release: identity.version,
    serverName: name,
    initialScope: {
      tags: {
        "service.name": name,
        "strad.component": identity.component,
        "strad.mode": identity.mode,
      },
    },

    // ── the secrets posture ────────────────────────────────────────────────
    sendDefaultPii: false,
    // No IP, no user, no request. Nothing here is a "nice default" we can take
    // and then filter; the filtering is what this whole file is.
    defaultIntegrations: false,
    integrations: args.integrations ?? [],
    maxBreadcrumbs: 0,
    beforeBreadcrumb: () => null,
    beforeSend: (event) => redactErrorEvent(event, credentialValues(env)),

    // ── tracing: not here ──────────────────────────────────────────────────
    tracesSampleRate: 0,
    beforeSendTransaction: () => null,
    // Leave the global OTel provider to src/telemetry/index.ts.
    skipOpenTelemetrySetup: true,

    ...(args.transport ? { transport: args.transport } : {}),
  };
}

/**
 * Top-level event keys that may be sent. Everything else is dropped.
 *
 * Deny-by-default, exactly like `EXPORTABLE` in events.ts, and for the same
 * reason: `request` (headers, cookies, body), `user`, `extra`, `breadcrumbs` and
 * `modules` are all present in the Sentry event shape, all of them carry things
 * strad did not author, and a rebuild-from-allowlist cannot be widened by
 * accident — not by an SDK upgrade, and not by someone adding a `setExtra()`
 * call three files away.
 */
const EVENT_KEYS = [
  "event_id",
  "timestamp",
  "platform",
  "level",
  "logger",
  "server_name",
  "environment",
  "release",
  "sdk",
  "tags",
  "fingerprint",
  "exception",
  "message",
  "contexts",
  // The SDK's own bookkeeping (propagation context, capture metadata). It is
  // stripped before the envelope is written and never reaches the wire; dropping
  // it here would only make the SDK rebuild it.
  "sdkProcessingMetadata",
] as const;

/**
 * Contexts that may travel. `runtime` and `os` are the process's own facts and
 * are exactly what you want when reading a crash; `trace` is two ids; `app` is
 * start time and version.
 */
const CONTEXT_KEYS = new Set(["trace", "runtime", "os", "app"]);

/**
 * Stack-frame keys that may travel.
 *
 * `vars` (local variables) and the `*_context` source lines are the two that
 * matter: the first is a serialisation of whatever was in scope when it blew up
 * — the token, the tool result, the decrypted parameter — and the second is
 * source text read off disk. Neither integration is installed, so neither
 * should ever appear; they are dropped here anyway, because "should never
 * appear" is not a boundary.
 */
const FRAME_KEYS = [
  "filename",
  "abs_path",
  "module",
  "function",
  "lineno",
  "colno",
  "in_app",
  "platform",
] as const;

/**
 * Rebuild an event from the allowlist, with every surviving string scrubbed.
 *
 * Returning `null` drops the event entirely — which is what happens if anything
 * in here throws. A report we cannot prove is clean is not sent.
 */
export function redactErrorEvent(
  event: ErrorEvent,
  secrets: readonly string[] = [],
): ErrorEvent | null {
  try {
    const source = event as unknown as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of EVENT_KEYS) {
      if (source[key] !== undefined) out[key] = source[key];
    }

    if (typeof out.message === "string") {
      out.message = scrubText(out.message, secrets);
    }
    if (out.contexts) {
      out.contexts = pick(out.contexts as Record<string, unknown>, (key) =>
        CONTEXT_KEYS.has(key),
      );
    }
    if (out.tags) {
      const tags = out.tags as Record<string, unknown>;
      out.tags = Object.fromEntries(
        Object.entries(tags).map(([key, value]) => [
          key,
          typeof value === "string" ? scrubText(value, secrets) : value,
        ]),
      );
    }
    if (out.exception) {
      out.exception = redactException(
        out.exception as { values?: unknown[] },
        secrets,
      );
    }

    return out as unknown as ErrorEvent;
  } catch {
    return null;
  }
}

function redactException(
  exception: { values?: unknown[] },
  secrets: readonly string[],
): { values: unknown[] } {
  const values = Array.isArray(exception.values) ? exception.values : [];
  return {
    values: values.map((raw) => {
      const value = raw as Record<string, unknown>;
      const out: Record<string, unknown> = {
        // The exception CLASS. It comes from the throw site, but a thrown
        // string becomes the "type" of a synthetic Error, so it is scrubbed
        // like any other text.
        type:
          typeof value.type === "string"
            ? scrubText(value.type, secrets)
            : value.type,
        // The message. This is the payload of the whole feature and the single
        // riskiest string in it.
        value:
          typeof value.value === "string"
            ? scrubText(value.value, secrets)
            : value.value,
      };
      if (value.mechanism) out.mechanism = value.mechanism;
      const stacktrace = value.stacktrace as { frames?: unknown[] } | undefined;
      if (stacktrace) {
        out.stacktrace = {
          frames: (Array.isArray(stacktrace.frames)
            ? stacktrace.frames
            : []
          ).map((frame) =>
            redactFrame(frame as Record<string, unknown>, secrets),
          ),
        };
      }
      return out;
    }),
  };
}

function redactFrame(
  frame: Record<string, unknown>,
  secrets: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of FRAME_KEYS) {
    const value = frame[key];
    if (value === undefined) continue;
    out[key] = typeof value === "string" ? scrubText(value, secrets) : value;
  }
  return out;
}

function pick(
  source: Record<string, unknown>,
  keep: (key: string) => boolean,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(source).filter(([key]) => keep(key)),
  );
}

/** The ingest host from a DSN, or a placeholder. Never the key it embeds. */
function dsnHost(dsn: string): string {
  try {
    return new URL(dsn).host;
  } catch {
    return "<unparseable>";
  }
}
