/**
 * Render a deployable App Platform spec.
 *
 * This is the seam where secrets enter the system. CI has just pulled them from
 * GCP Secret Manager into its own environment; here they become SECRET-typed
 * env vars on the app spec, and DigitalOcean encrypts them at rest. The
 * container that eventually runs holds no GCP credential of any kind — it just
 * reads process.env, like any twelve-factor app.
 *
 * Usage (from CI):
 *   node --experimental-transform-types scripts/render-spec.ts \
 *     --config infra/strad.staging.yaml \
 *     --image registry.digitalocean.com/strad/strad:0.1.0 \
 *     --app strad-staging > /tmp/spec.json
 *
 * The output contains secret values. Never echo it into a build log.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { parseConfig } from "../src/config/load.ts";
import {
  collectSecretRefs,
  parseImage,
  renderAppSpec,
  type EnvVar,
} from "../src/deploy/appspec.ts";

const { values } = parseArgs({
  options: {
    config: { type: "string" },
    image: { type: "string" },
    app: { type: "string" },
    region: { type: "string" },
    domain: { type: "string", multiple: true },
  },
});

if (!values.config || !values.image || !values.app) {
  console.error(
    "usage: render-spec --config <path> --image <ref> --app <name>",
  );
  process.exit(1);
}

const raw = readFileSync(values.config, "utf8");
const config = parseConfig(raw, values.config);

const envs: EnvVar[] = [
  // The server list, inline. The stock image ships zero servers by design; this
  // is what makes it *this* deployment rather than an empty gateway.
  {
    key: "STRAD_CONFIG_YAML",
    value: raw,
    scope: "RUN_TIME",
    type: "GENERAL",
  },
];

/** Present -> SECRET env var. Absent -> omitted, and the app fails closed. */
function secret(key: string, required = false): void {
  const value = process.env[key];
  if (!value) {
    if (required) {
      console.error(`::error::${key} is required but not set`);
      process.exit(1);
    }
    console.error(`[render-spec] ${key} not set; omitting from the spec.`);
    return;
  }
  envs.push({ key, value, scope: "RUN_TIME", type: "SECRET" });
}

secret("STRAD_TOKENS", true); // without this, /mcp rejects everything
secret("STRAD_INTERNAL_TOKEN", true); // core <-> bundle auth
secret("ADMIN_BOOTSTRAP_TOKEN"); // console dev bypass
secret("GOOGLE_CLIENT_ID"); // console real auth, when it exists
secret("GOOGLE_CLIENT_SECRET");

// Secrets referenced by a NON-supplementary server via ${NAME} — a remote-http
// server's url/headers (e.g. `Authorization: "Bearer ${GRANOLA_TOKEN}"`), a
// builtin's options. These resolve IN-PROCESS at boot (src/secrets/index.ts
// resolveRefs) in the core and any strad-image bundle, so they belong as
// BROADCAST SECRET env vars. An unresolved ref makes the gateway refuse to
// start, so fail loudly HERE, at render. collectSecretRefs deliberately
// excludes supplementary-image env (those resolve deploy-time, scoped per
// bundle — see the good-eggs path below). Backward-compatible: a config with no
// such refs (the default, and staging) adds nothing.
const already = new Set(envs.map((e) => e.key));
for (const name of collectSecretRefs(config)) {
  if (already.has(name)) continue;
  secret(name, true); // referenced by the config => required to boot
  already.add(name);
}

// A supplementary image's `env:` map may reference `${NAME}` secrets. Unlike the
// SECRETs above (which broadcast to every component), these resolve onto ONLY
// the bundle that names them — see appspec.ts. Collect every referenced name
// from the config, pull it from the environment, and hand the bag to the
// renderer. A referenced-but-unset secret is a hard error: better a failed
// deploy than a browser bundle that can't log in.
const SECRET_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const bundleSecrets: Record<string, string> = {};
for (const server of config.servers) {
  if (server.kind !== "supplementary-image") continue;
  // appspec.ts skips disabled servers and emits no bundle for them, so don't
  // demand their secrets here either — that would fail-close in the wrong place.
  if (!server.enabled) continue;
  for (const raw of Object.values(server.env)) {
    for (const match of raw.matchAll(SECRET_REF)) {
      const name = match[1]!;
      if (name in bundleSecrets) continue;
      const value = process.env[name];
      if (!value) {
        console.error(
          `::error::${name} is referenced by server "${server.slug}" env but is not set`,
        );
        process.exit(1);
      }
      bundleSecrets[name] = value;
    }
  }
}

// The dev-bypass switches. Not secrets — they are switches, and belong in the
// spec as visible GENERAL vars. The container runs NODE_ENV=production, so the
// bypass needs BOTH ALLOW_DEV_AUTH and ALLOW_DEV_AUTH_IN_PRODUCTION (see
// src/auth/dev.ts): the second is what a copy-to-prod would fail to carry.
for (const key of ["ALLOW_DEV_AUTH", "ALLOW_DEV_AUTH_IN_PRODUCTION"]) {
  if (process.env[key] === "true") {
    envs.push({ key, value: "true", scope: "RUN_TIME", type: "GENERAL" });
  }
}

// An App Platform spec update is a full REPLACE, so an omitted field is a
// DELETION, not a no-op: rendering without `domains` does not leave the app's
// custom domain alone, it DETACHES it, and App Platform stops serving and
// renewing that hostname's certificate. (This is exactly how a staging deploy
// took https://staging.strad.tadasant.com from 200 to a TLS handshake failure
// while the app itself stayed perfectly healthy on its *.ondigitalocean.app
// ingress.)
//
// So the domain must be on EVERY render, not only the ones that remember to
// pass --domain. Default it from the config's own gateway.publicUrl — the host
// this deployment already declares it is served at — and let --domain override.
function resolveDomains() {
  const flagged = values.domain?.map((d) => ({ domain: d, type: "PRIMARY" as const }));
  if (flagged?.length) return flagged;

  let host: string | undefined;
  try {
    host = new URL(config.gateway.publicUrl ?? "").hostname;
  } catch {
    host = undefined;
  }
  // *.ondigitalocean.app is the DEFAULT ingress, not a custom domain — App
  // Platform rejects it as one.
  if (!host || host.endsWith(".ondigitalocean.app")) return undefined;
  return [{ domain: host, type: "PRIMARY" as const }];
}

const spec = renderAppSpec({
  config,
  appName: values.app,
  region: values.region ?? "nyc",
  image: parseImage(values.image),
  env: envs,
  secrets: bundleSecrets,
  domains: resolveDomains(),
});

// A BARE spec, not { spec }. This file is fed to `doctl apps create/update
// --spec`, which parses an App Platform spec and rejects an unknown top-level
// "spec" field outright ("parsing app spec: json: unknown field \"spec\"").
// doctl is what wraps it into the API's { spec } envelope.
process.stdout.write(JSON.stringify(spec, null, 2));
