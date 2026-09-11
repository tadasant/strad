import { tokenStoreFromConfig } from "./auth/index.ts";
import { assertDevBypassAllowed } from "./auth/dev.ts";
import { configPathFromEnv, loadConfig } from "./config/load.ts";
import { mountTargets } from "./gateway/mount-health.ts";
import { ToolSurfaceMonitor } from "./gateway/reachability.ts";
import { Registry, type Mode } from "./gateway/registry.ts";
import { createApp } from "./http/app.ts";
import { createParameterWriteBack } from "./http/params.ts";
import { loadSecrets } from "./secrets/index.ts";
import { resolverFromEnv } from "./secrets/parameters/index.ts";
import {
  buildSecretProviders,
  hydrateBootEnv,
} from "./secrets/provider/index.ts";
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

  const config = await loadConfig(configPathFromEnv(env));

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

  const registry = await Registry.build({
    config,
    secrets: secretProviders,
    mode,
    bundleName,
    env,
    resolver,
    // Where a `remote-http` server's rotated refresh token is persisted. Core
    // only: core is the component holding the store-admin credential, and the
    // only one that proxies an unhosted server. Same store, same `rotate()`,
    // same invalidation as the bundle write-back route — see
    // src/http/params.ts.
    writeBack:
      mode === "core"
        ? createParameterWriteBack({
            config,
            env,
            secrets,
            secretProvider: secretProviders,
            diagnosticStore: resolver,
          })
        : undefined,
  });

  const tokenStore = tokenStoreFromConfig(config, env);
  const tokenCount = (await tokenStore.list()).length;

  if (mode === "core" && tokenCount === 0) {
    // Not fatal — an operator may be mid-rollout — but /mcp is now a wall with
    // no door, and that is worth being noisy about.
    console.warn(
      "[strad] no system tokens configured (STRAD_TOKENS is empty). " +
        "/mcp will reject every request. Mint one with: npm run token:mint",
    );
  }

  // `secretProvider` is handed to the app for the console's secret roster and the
  // readiness endpoint that mirrors it: it is the only seam that can answer "does
  // this ${NAME} resolve?" for a store-backed deployment, where the answer is in
  // the parameter store and in no bag.

  // Which of the mounted slugs actually serve tools.
  //
  // A slug can be configured, entitled, routed and dead, and the only symptom is
  // an empty `tools/list` that reads exactly like a server with no tools. This
  // watches for that from inside the process, says so in the logs, and publishes
  // the answer on /healthz so a deploy can assert on it. It never blocks the
  // boot and never fails it — see gateway/reachability.ts.
  //
  // The interval is an escape hatch, not configuration anyone should need. It is
  // VALIDATED rather than coerced: `Number("")` is 0 and `Number("60s")` is NaN,
  // and setTimeout clamps both to 1ms — a typo would turn this into a hot loop
  // probing every upstream continuously.
  //
  // In core it also asks each bundle what it says about its own mounts, because
  // a mount can list every tool and fail every call — a stale login — and only
  // the bundle knows. Core is the process that routes those slugs and holds the
  // bundles' private URLs; a bundle-mode process mounts no supplementary slug
  // and has nothing to ask. See gateway/mount-health.ts.
  const toolSurfaces = new ToolSurfaceMonitor({
    registry,
    intervalMs: positiveMs(env.STRAD_TOOL_SURFACE_INTERVAL_MS, 60_000),
    mounts:
      mode === "core" ? { targets: mountTargets(config), env } : undefined,
  });

  const app = createApp({
    config,
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
    toolSurfaces: () => toolSurfaces.snapshot(),
  });

  // App Platform: a PUBLIC component sets http_port. An INTERNAL component sets
  // internal_ports and must NOT set http_port (http_port is what mints the
  // public route), and the two may not be equal — the API hard-rejects that.
  // Both land on 8080 here; the app spec decides which one is which.
  const port = Number(env.PORT ?? 8080);

  const server = app.listen(port, () => {
    event({
      evt: "strad.listening",
      port,
      mode,
      bundle: bundleName ?? "core",
      env: config.gateway.env,
      servers: registry.slugs,
      tokens: tokenCount,
      telemetry: telemetry.enabled ? telemetry.serviceName : "disabled",
    });
    // AFTER listening, deliberately: the first probe reaches every upstream, and
    // on a bundle-hosted builtin that upstream is another strad which may still
    // be coming up. Starting here costs the boot nothing and the interval
    // catches whatever was not ready yet.
    toolSurfaces.start();
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
    toolSurfaces.stop();
    server.close();
    await registry.close();
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
