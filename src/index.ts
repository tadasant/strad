import { tokenStoreFromConfig } from "./auth/index.ts";
import { assertDevBypassAllowed } from "./auth/dev.ts";
import { configPathFromEnv, loadConfig } from "./config/load.ts";
import { Registry, type Mode } from "./gateway/registry.ts";
import { createApp } from "./http/app.ts";
import { loadSecrets } from "./secrets/index.ts";
import { resolverFromEnv } from "./secrets/parameters/index.ts";
import {
  buildSecretProvider,
  hydrateBootEnv,
} from "./secrets/provider/index.ts";
import { startTelemetry } from "./telemetry/index.ts";

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

  const config = await loadConfig(configPathFromEnv(env));

  // The runtime secret provider, built from what the config declares. With
  // `gateway.secrets.provider: env` (the default) this is a wrapper around
  // process.env and no cloud client is constructed; with `gcp-parameter-store`
  // it is a cached, TTL'd reader over the parameter store, and the container
  // holds exactly one credential — the one that reaches the store.
  //
  // This is built BEFORE telemetry because hydration below supplies
  // OTEL_EXPORTER_OTLP_HEADERS, which the OpenTelemetry SDK reads from the
  // environment on its own terms.
  const resolver = resolverFromEnv(env);
  const secretProvider = buildSecretProvider({ config, env, resolver });

  // Fill in the handful of env vars that are read once, by code with no provider
  // in scope (the token store, the console's OAuth client, the OTLP header).
  // Under the env provider this finds everything already set and does nothing.
  // A bundle asks for strictly less than core — see hydrate.ts.
  const hydrated = await hydrateBootEnv(secretProvider, mode, env);
  if (hydrated.length > 0) {
    // Names only. Never a value, and never a name paired with one.
    console.log(
      JSON.stringify({
        evt: "strad.secrets_hydrated",
        provider: secretProvider.name,
        keys: hydrated,
      }),
    );
  }

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
  const telemetry = startTelemetry({
    env,
    identity: {
      mode,
      component: bundleName ?? "core",
      environment: config.gateway.env,
    },
  });

  // The boot-time bag, read AFTER hydration so it reflects anything the provider
  // supplied. It backs the console's `consoleEnv:` resolution (src/ui) — a
  // snapshot is right there, because the console's own store credential is a
  // bootstrap credential, not a managed secret.
  //
  // Every `${NAME}` a SERVER references goes through `secretProvider` instead,
  // on the request path. That is the difference between a secret you must
  // redeploy to change and one you do not.
  const secrets = await loadSecrets();

  // Boot-time guard, before anything can serve a request.
  assertDevBypassAllowed(config, env);

  const registry = await Registry.build({
    config,
    secrets: secretProvider,
    mode,
    bundleName,
    env,
    resolver,
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

  const app = createApp({ config, registry, tokenStore, mode, env, secrets });

  // App Platform: a PUBLIC component sets http_port. An INTERNAL component sets
  // internal_ports and must NOT set http_port (http_port is what mints the
  // public route), and the two may not be equal — the API hard-rejects that.
  // Both land on 8080 here; the app spec decides which one is which.
  const port = Number(env.PORT ?? 8080);

  const server = app.listen(port, () => {
    console.log(
      JSON.stringify({
        evt: "strad.listening",
        port,
        mode,
        bundle: bundleName ?? "core",
        env: config.gateway.env,
        servers: registry.slugs,
        tokens: tokenCount,
        telemetry: telemetry.enabled ? telemetry.serviceName : "disabled",
      }),
    );
  });

  // App Platform sends SIGTERM and does not wait long. Close cleanly.
  const shutdown = async (signal: string) => {
    console.log(JSON.stringify({ evt: "strad.shutdown", signal }));
    server.close();
    await registry.close();
    // Flush telemetry LAST and before exit. When App Platform OOM-kills this
    // container, the final few seconds of memory metrics are the entire
    // diagnosis, and an unflushed exporter throws them away. This is bounded:
    // shutdown() swallows its own errors, so a dead collector cannot wedge the
    // SIGTERM path and get us SIGKILLed instead.
    await telemetry.shutdown();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  console.error("[strad] failed to start:", err);
  process.exit(1);
});
