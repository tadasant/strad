import { tokenStoreFromConfig } from "./auth/index.ts";
import { assertDevBypassAllowed } from "./auth/dev.ts";
import { configPathFromEnv, loadConfigDocument } from "./config/load.ts";
import {
  ConfigPoller,
  RuntimeConfig,
  readOverlayAtBoot,
} from "./config/runtime.ts";
import { configStoreFrom } from "./config/store.ts";
import type { StradConfig } from "./config/schema.ts";
import { mountTargets } from "./gateway/mount-health.ts";
import { ToolSurfaceMonitor } from "./gateway/reachability.ts";
import { Registry, type Mode } from "./gateway/registry.ts";
import { ReloadableGateway, type GatewayInstance } from "./gateway/reload.ts";
import { createServer } from "node:http";
import { createApp } from "./http/app.ts";
import { createParameterWriteBack } from "./http/params.ts";
import { loadSecrets } from "./secrets/index.ts";
import { resolverFromEnv } from "./secrets/parameters/index.ts";
import {
  buildSecretProviders,
  hydrateBootEnv,
} from "./secrets/provider/index.ts";
import { errorSummary } from "./util/error-text.ts";
import {
  event,
  startErrorReporter,
  startTelemetry,
  type ErrorReporterHandle,
} from "./telemetry/index.ts";

/**
 * Set as soon as the reporter is up, so the boot-failure handler at the bottom
 * of this file can use it. Null until then — and a crash before that point is
 * a crash before we know where to report it to.
 */
let errorReporter: ErrorReporterHandle | null = null;

async function main(): Promise<void> {
  const env = process.env;

  const mode = (env.STRAD_MODE ?? "core") as Mode;
  if (mode !== "core" && mode !== "bundle") {
    throw new Error(`STRAD_MODE must be "core" or "bundle", got "${mode}"`);
  }
  const bundleName = env.STRAD_BUNDLE;
  if (mode === "bundle" && !bundleName) {
    throw new Error("STRAD_MODE=bundle requires STRAD_BUNDLE");
  }

  // Exception reporting, as early as there is anything to report WITH. A boot
  // that throws is the likeliest crash strad has, and the two commonest shapes
  // of it — a config that will not parse, a store that will not answer — happen
  // in the next twenty lines. With no SENTRY_DSN in the environment this
  // imports nothing, starts nothing and logs nothing; the deployment that has
  // one only in the parameter store gets a second chance after hydration below.
  const identity = { mode, component: bundleName ?? "core" };
  errorReporter = await startErrorReporter({ env, identity });

  // The checked-in config, AND the document it came from. The document is the
  // DESUGARED one — `mcpServers:` already folded into `servers:` — which is
  // what the runtime overlay merges into. See src/config/load.ts.
  //
  // The `mcp.json` dialect reports what it attached, and telemetry is not up
  // yet — so it is collected here and emitted below, beside the other event
  // that has to wait for the exporter. See src/config/mcp-json.ts.
  let unentitledFromMcpJson: string[] = [];
  const { config: baseConfig, document: baseDocument } =
    await loadConfigDocument(configPathFromEnv(env), env, (dialect) => {
      unentitledFromMcpJson = dialect.notices.map((n) => n.slug);
    });
  let config = baseConfig;

  // The runtime secret provider, built from what the config declares. With
  // `gateway.secrets.provider: env` (the default) this is a wrapper around
  // process.env and no cloud client is constructed; with `gcp-parameter-store`
  // it is a reader over the parameter store, and the container holds exactly
  // one credential — the one that reaches the store.
  //
  // ONE store client for the process, holding ONE reading of the store for
  // `ttlSeconds`. The providers, the registry's `params:` resolution and the
  // console's store diagnosis all slice it — that is what keeps the store's
  // bill from scaling with the number of namespaces this process reads.
  //
  // This is built BEFORE telemetry because hydration below supplies
  // OTEL_EXPORTER_OTLP_HEADERS, which the OpenTelemetry SDK reads from the
  // environment on its own terms.
  const resolver = resolverFromEnv(env, {
    snapshotTtlMs: config.gateway.secrets.ttlSeconds * 1000,
  });
  const secretProviders = buildSecretProviders({ config, env, resolver });
  // The deployment-wide half. Boot hydration, the console roster and the
  // readiness route all ask about names with no server to attribute them to.
  const secretProvider = secretProviders.shared;

  // Fill in the handful of env vars that are read once, by code with no provider
  // in scope (the token store, the console's OAuth client, the OTLP header).
  // Under the env provider this finds everything already set and does nothing.
  // A bundle asks for strictly less than core — see hydrate.ts.
  const hydrated = await hydrateBootEnv(secretProvider, mode, env);

  // Telemetry starts before the registry connects to anything and before we
  // listen, so that a slow or failing boot is itself observable. A boot that
  // dies in Registry.build() because a bundle is unreachable is exactly the kind
  // of thing you want a trace for, and starting telemetry afterwards would mean
  // the only boots we can see are the ones that succeeded.
  //
  // Exactly one thing precedes it: hydration, above, which is what SUPPLIES
  // `OTEL_EXPORTER_OTLP_HEADERS` to a store-backed deployment. The window this
  // opens is bounded rather than open-ended — every store read carries a
  // deadline (see parameters/gcp.ts) and hydration swallows its own failures —
  // so a sick store delays this boot by seconds, it does not hang it forever.
  //
  // With no OTEL_EXPORTER_OTLP_ENDPOINT this starts no SDK, logs one line, and
  // returns a handle whose shutdown() is a no-op. It cannot fail the boot: every
  // error inside is caught (see src/telemetry/index.ts).
  const telemetryIdentity = { ...identity, environment: config.gateway.env };

  // The second chance for the exception reporter. A store-backed deployment
  // keeps the DSN in the parameter store, and hydration is what puts it in the
  // environment — so the early start above found nothing and this one finds it.
  // A reporter already running is left alone rather than re-initialised.
  if (!errorReporter.enabled) {
    errorReporter = await startErrorReporter({
      env,
      identity: telemetryIdentity,
    });
  }

  const telemetry = startTelemetry({ env, identity: telemetryIdentity });

  // Reported AFTER telemetry starts, not at the moment it happened. Hydration
  // has to run first — it is what SUPPLIES the OTLP headers — so an event
  // emitted there would reach stdout and never the collector, which is the
  // failure mode this whole change is about. Names only, never a value.
  if (hydrated.length > 0) {
    event({
      evt: "strad.secrets_hydrated",
      provider: secretProvider.name,
      keys: hydrated,
    });
  }

  // A server the `mcp.json` dialect attached with no entitlements: configured,
  // routed, and reachable by nobody. `mcp.json` has no notion of who a server
  // is for, so `[]` is the only fail-closed answer — and a fail-closed answer
  // that nothing says out loud is indistinguishable from a broken one. The
  // slugs come from the config, which is ours.
  if (unentitledFromMcpJson.length > 0) {
    event({
      evt: "strad.mcp_json_unentitled",
      slugs: unentitledFromMcpJson,
    });
  }

  // The boot-time bag, read AFTER hydration so it reflects anything the provider
  // supplied. It backs the console's `consoleEnv:` resolution (src/ui) — a
  // snapshot is right there, because the console's own store credential is a
  // bootstrap credential, not a managed secret.
  //
  // Every `${NAME}` a SERVER references goes through `secretProvider` instead,
  // on the request path. That is the difference between a secret you must
  // redeploy to change and one you do not.
  const secrets = loadSecrets();

  // Boot-time guard, before anything can serve a request.
  assertDevBypassAllowed(config, env);

  // The mutable layer, if this deployment asked for one. Off by default, and
  // null costs nothing — every line below behaves exactly as it did.
  //
  // Core only, and that is not a simplification. The kinds a console can add
  // (`remote-http`, `local-tunnel`) are mounted by core and by nothing else, a
  // bundle mounts only the builtins compiled into its image, and no overlay
  // entry can produce one of those. A bundle reading this would be a store read
  // per interval to learn about servers it does not serve.
  const configStore =
    mode === "core"
      ? configStoreFrom({ config: baseConfig, env, resolver })
      : null;

  const boot = await readOverlayAtBoot(configStore, baseDocument);
  if (boot.config) config = boot.config;

  // `secretProviders`, so a `parameter-store` token store reads the records
  // through the same client, the same credential and the same reading of the
  // store every other gateway-level `${NAME}` resolves through.
  const tokenStore = tokenStoreFromConfig(config, env, secretProviders);
  // Counted, never fatal. Under the store backing this is also the first read of
  // the records, so a store that cannot be read says so in the boot log rather
  // than on the first agent's request — but it still does not stop the boot: a
  // gateway that comes up and serves 401s is diagnosable, and one that refuses
  // to come up takes the console down with it, and the console is where the
  // records are fixed.
  const tokenCount = await tokenStore
    .list()
    .then((records) => records.filter((r) => !r.revokedAt).length)
    .catch((err: unknown) => {
      console.error(
        `[strad] the system-token store could not be read at boot: ${errorSummary(err)}. ` +
          "/mcp will reject every request until it can be.",
      );
      return 0;
    });

  // Where the config write-back persists a rotated refresh token. Built from
  // the BASE config: everything it reads (`gateway.env`, the secrets provider)
  // is outside what an overlay may change, and a write-back that outlives a
  // reload is one fewer thing a roster change can break.
  const writeBack =
    mode === "core"
      ? createParameterWriteBack({
          config: baseConfig,
          env,
          secrets,
          secretProvider: secretProviders,
          diagnosticStore: resolver,
        })
      : undefined;

  /**
   * Everything downstream of the config, built from one.
   *
   * Called once at boot and once per roster change. It is a pure function of
   * `next` plus the process-wide things above it — the store client, the
   * providers, the token store — none of which an overlay may touch. See
   * src/gateway/reload.ts for why this is a rebuild rather than a mutation.
   */
  const buildGateway = async (next: StradConfig): Promise<GatewayInstance> => {
    const registry = await Registry.build({
      config: next,
      secrets: secretProviders,
      mode,
      bundleName,
      env,
      resolver,
      writeBack,
      // For the `connectors` builtin, when a deployment mounts it. Late-bound
      // for the same reason the console's is: the holder owns the rebuild that
      // produces this registry.
      runtime: () => runtimeRef.current,
    });

    // Which of the mounted slugs actually serve tools. See the long note below
    // the listen() call for what this monitor is for; the interval is validated
    // rather than coerced, because `Number("60s")` is NaN and setTimeout clamps
    // it to 1ms — a typo would turn this into a hot loop probing every upstream.
    const toolSurfaces = new ToolSurfaceMonitor({
      registry,
      intervalMs: positiveMs(env.STRAD_TOOL_SURFACE_INTERVAL_MS, 60_000),
      mounts:
        mode === "core" ? { targets: mountTargets(next), env } : undefined,
    });

    const app = createApp({
      config: next,
      registry,
      tokenStore,
      mode,
      env,
      secrets,
      secretProvider: secretProviders,
      // The SAME client the providers read through, so the console's and the
      // readiness route's diagnosis is answered from the snapshot this process
      // already holds rather than from a second client with a reading of its
      // own. A write through the console drops both by dropping one.
      diagnosticStore: resolver,
      // And the same one again for the store-served instance routes, which
      // read a slug's namespace as a slice of that one snapshot rather than
      // with a store client of their own.
      resolver,
      toolSurfaces: () => toolSurfaces.snapshot(),
      // Late-bound on purpose: the console's roster editor needs the runtime,
      // the runtime needs a gateway to rebuild, and the gateway is what this
      // function returns. A thunk breaks the cycle, and every route that reads
      // it runs long after the box is filled.
      runtimeConfig: () => runtimeRef.current,
    });

    return { config: next, registry, app, toolSurfaces };
  };

  const runtimeRef: { current: RuntimeConfig | null } = { current: null };

  const gateway = await ReloadableGateway.start(buildGateway, config);

  const runtime = new RuntimeConfig({
    baseDocument,
    // Parsed once, here, rather than again on the first roster write: the reach
    // bound measures against what the deploy authorised, and this is it.
    baseConfig,
    config,
    overlay: boot.overlay,
    store: configStore,
    rebuild: (next) => gateway.reload(next),
    env,
  });
  runtimeRef.current = runtime;

  // Carries a change written by another core instance into this one. Never
  // started when there is no store — a poll with nothing to poll is a timer
  // that exists to do nothing.
  const poller = configStore
    ? new ConfigPoller(runtime, config.gateway.configStore.pollSeconds * 1000)
    : null;

  if (mode === "core" && tokenCount === 0) {
    // Not fatal — an operator may be mid-rollout — but /mcp is now a wall with
    // no door, and that is worth being noisy about.
    console.warn(
      "[strad] no live system tokens. /mcp will reject every request. " +
        (config.auth.staticTokens.store === "parameter-store"
          ? "Mint one in the console at /tokens."
          : "Mint one with: npm run token:mint"),
    );
  }

  // `secretProvider` is handed to the app for the console's secret roster and the
  // readiness endpoint that mirrors it: it is the only seam that can answer "does
  // this ${NAME} resolve?" for a store-backed deployment, where the answer is in
  // the parameter store and in no bag.

  // A slug can be configured, entitled, routed and dead, and the only symptom is
  // an empty `tools/list` that reads exactly like a server with no tools. The
  // ToolSurfaceMonitor built in `buildGateway` watches for that from inside the
  // process, says so in the logs, and publishes the answer on /healthz so a
  // deploy can assert on it. It never blocks the boot and never fails it — see
  // gateway/reachability.ts.
  //
  // In core it also asks each bundle what it says about its own mounts, because
  // a mount can list every tool and fail every call — a stale login — and only
  // the bundle knows. Core is the process that routes those slugs and holds the
  // bundles' private URLs; a bundle-mode process mounts no supplementary slug
  // and has nothing to ask. See gateway/mount-health.ts.

  // App Platform: a PUBLIC component sets http_port. An INTERNAL component sets
  // internal_ports and must NOT set http_port (http_port is what mints the
  // public route), and the two may not be equal — the API hard-rejects that.
  // Both land on 8080 here; the app spec decides which one is which.
  const port = Number(env.PORT ?? 8080);

  // `http.createServer` rather than `app.listen`, because the app is no longer
  // a constant: the socket outlives every rebuild and dispatches to whichever
  // app the gateway currently holds. See src/gateway/reload.ts for why this is
  // a bare dispatch rather than an Express app mounted inside another one.
  const server = createServer(gateway.handle);

  server.listen(port, () => {
    event({
      evt: "strad.listening",
      port,
      mode,
      bundle: bundleName ?? "core",
      env: config.gateway.env,
      servers: gateway.registry.slugs,
      tokens: tokenCount,
      telemetry: telemetry.enabled ? telemetry.serviceName : "disabled",
    });
    // AFTER listening, deliberately: the first probe reaches every upstream, and
    // on a bundle-hosted builtin that upstream is another strad which may still
    // be coming up. Starting here costs the boot nothing and the interval
    // catches whatever was not ready yet. `startProbing` also latches, so a
    // roster change later starts the NEW monitor without anyone remembering to.
    gateway.startProbing();
    poller?.start();
  });

  // App Platform sends SIGTERM and does not wait long. Close cleanly.
  const shutdown = async (signal: string) => {
    // Through `event`, so a clean SIGTERM leaves a record in the ingestor. Its
    // ABSENCE next to a restart is how you tell an orderly stop from an OOM
    // kill, and that distinction is only useful if the line ships.
    event({ evt: "strad.shutdown", signal });
    // BEFORE the adapters it probes through: a probe still in flight when
    // registry.close() lands would fail against a closed adapter and write a
    // "this slug serves NOTHING" line on the way out the door.
    poller?.stop();
    gateway.toolSurfaces.stop();
    server.close();
    await gateway.close();
    // Flush telemetry LAST and before exit. When App Platform OOM-kills this
    // container, the final few seconds of memory metrics are the entire
    // diagnosis, and an unflushed exporter throws them away. This is bounded:
    // shutdown() swallows its own errors, so a dead collector cannot wedge the
    // SIGTERM path and get us SIGKILLed instead.
    await telemetry.shutdown();
    // Same argument as the flush above, for the other channel: an orderly stop
    // should not leave a crash report sitting in a queue that is about to be
    // freed. Bounded and error-swallowing, so a dead ingestor cannot wedge
    // SIGTERM and get us SIGKILLed instead.
    await errorReporter?.shutdown();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

/** A positive, finite millisecond count, or the default. Never NaN, never 0. */
function positiveMs(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

main().catch((err: unknown) => {
  console.error("[strad] failed to start:", err);
  // A boot failure exits by THIS path, not as an uncaughtException, so the
  // reporter's process handler never sees it. Report it explicitly — and exit
  // on a watchdog as well as on the report, because "the reporter is bounded"
  // is a property of the SDK and the exit code is a property strad owns. A
  // crash-looping container that sits there not exiting is a worse outage than
  // the crash.
  // Set first, so that every path out of here — the explicit exit, or an event
  // loop that simply drains — is a FAILED boot as far as the platform is
  // concerned. That is what makes the watchdog below safe to unref.
  process.exitCode = 1;
  const exit = () => process.exit(1);
  // No reporter, or one that is off: exit exactly as before, in this tick. The
  // unconfigured path does not get a deferred exit or a stray timer.
  if (!errorReporter?.enabled) exit();
  else {
    const watchdog = setTimeout(exit, 3000);
    watchdog.unref();
    void errorReporter.captureFatal(err, "boot").finally(exit);
  }
});
