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

// The dev-bypass switches. Not secrets — they are switches, and belong in the
// spec as visible GENERAL vars. The container runs NODE_ENV=production, so the
// bypass needs BOTH ALLOW_DEV_AUTH and ALLOW_DEV_AUTH_IN_PRODUCTION (see
// src/auth/dev.ts): the second is what a copy-to-prod would fail to carry.
for (const key of ["ALLOW_DEV_AUTH", "ALLOW_DEV_AUTH_IN_PRODUCTION"]) {
  if (process.env[key] === "true") {
    envs.push({ key, value: "true", scope: "RUN_TIME", type: "GENERAL" });
  }
}

const spec = renderAppSpec({
  config,
  appName: values.app,
  region: values.region ?? "nyc",
  image: parseImage(values.image),
  env: envs,
  domains: values.domain?.map((d) => ({ domain: d, type: "PRIMARY" as const })),
});

process.stdout.write(JSON.stringify({ spec }, null, 2));
