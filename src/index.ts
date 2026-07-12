import { tokenStoreFromConfig } from "./auth/index.ts";
import { assertDevBypassAllowed } from "./auth/dev.ts";
import { configPathFromEnv, loadConfig } from "./config/load.ts";
import { Registry, type Mode } from "./gateway/registry.ts";
import { createApp } from "./http/app.ts";
import { loadSecrets } from "./secrets/index.ts";

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

  // Secrets are already env vars by the time we boot: CI read them from GCP
  // Secret Manager and injected them as App Platform SECRET env vars. The
  // container holds no GCP credentials. See src/secrets/index.ts.
  const secrets = await loadSecrets();

  // Boot-time guard, before anything can serve a request.
  assertDevBypassAllowed(config, env);

  const registry = await Registry.build({
    config,
    secrets,
    mode,
    bundleName,
    env,
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

  const app = createApp({ config, registry, tokenStore, mode, env });

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
      }),
    );
  });

  // App Platform sends SIGTERM and does not wait long. Close cleanly.
  const shutdown = async (signal: string) => {
    console.log(JSON.stringify({ evt: "strad.shutdown", signal }));
    server.close();
    await registry.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  console.error("[strad] failed to start:", err);
  process.exit(1);
});
