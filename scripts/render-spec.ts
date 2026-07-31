/**
 * Render a deployable App Platform spec.
 *
 * How secrets enter the system depends on what the config declares in
 * `gateway.secrets.provider`, and there is exactly ONE path per deployment.
 *
 * **`env` (the default).** CI has pulled secrets into its own environment; here
 * they become SECRET-typed env vars on the app spec, and DigitalOcean encrypts
 * them at rest. The container holds no cloud credential of any kind — it just
 * reads process.env, like any twelve-factor app. This is the OSS default and it
 * requires no vendor.
 *
 * **`gcp-parameter-store`.** The app spec carries ONE credential: the one the
 * gateway uses to reach the store. Every other secret stays in the store and is
 * read at runtime, so adding or rotating one does not need a deploy at all. What
 * this script does instead is PREFLIGHT — it asks the store which names exist and
 * fails the deploy if the config references one that does not. It never reads a
 * value to do that.
 *
 * The one thing still resolved at render time in store mode is a supplementary
 * image's `env:` and `consoleEnv:`. Those are container env vars on a component
 * the gateway does not run, so no runtime path can reach them; they are read from
 * the store here and baked. Changing one of THOSE still needs a redeploy.
 *
 * Usage (from CI):
 *   node --experimental-transform-types scripts/render-spec.ts \
 *     --config infra/strad.staging.yaml \
 *     --image registry.digitalocean.com/strad/strad:0.1.0 \
 *     --app strad-staging > /tmp/spec.json
 *
 * `--bundle-image ghcr.io/tadasant/strad-bundle:<tag>` overrides the image on
 * every supplementary component that shares that repository, which is how a
 * feature branch gets deployed without editing the config's `image:` lines.
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
import {
  gatewayNamespace,
  resolverFromEnv,
  resolveServerParams,
  RESOLVER_ENV,
} from "../src/secrets/parameters/index.ts";
import {
  bakedSecretNames,
  consoleEnvNames,
  preflightSecrets,
} from "../src/deploy/preflight.ts";
import { assertImmutableCoreImage } from "../src/deploy/imageTag.ts";

const { values } = parseArgs({
  options: {
    config: { type: "string" },
    image: { type: "string" },
    "bundle-image": { type: "string" },
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

/**
 * Which of the two secret paths this deployment declared.
 *
 * `store` means the gateway reads its secrets at runtime, so this script must
 * NOT bake them — baking would reinstate the second way to manage a secret, and
 * a stale baked value silently wins over a rotated stored one.
 */
const storeBacked = config.gateway.secrets.provider === "gcp-parameter-store";

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

if (storeBacked) {
  // THE bootstrap credential, and the only secret in a store-backed spec. The
  // gateway uses it to reach the store; everything else it needs, it asks the
  // store for. This is the sanctioned exception to "secrets live in the store"
  // — a key cannot be kept behind the lock it opens.
  //
  // WHICH identity this must be is load-bearing; three service accounts touch
  // this store and handing the container the wrong one breaks the split:
  //   - NOT the viewer key (the `secrets` MCP server's). It deliberately lacks
  //     secretmanager.versions.access, so every ${NAME} would resolve to nothing.
  //   - NOT the admin key (the console's, via consoleEnv:). The gateway never
  //     writes, and a write-capable credential in the process that answers /mcp
  //     would make the console's separate identity pointless.
  //   - NOT CI's GCP_SA_KEY. That drives deploys and is far broader than reading
  //     one namespace; it must not outlive the job into a long-lived container.
  // It is the RESOLVER: parametermanager.parameterViewer +
  // parametermanager.parameterAccessor. Both — parameterViewer does NOT carry
  // parameterVersions.render, so a resolver without the accessor role lists
  // every parameter and 403s on every value. Read-only by IAM, not merely by
  // intent.
  secret(RESOLVER_ENV.keyJson, true);

  // The store's ADDRESS is not a credential, so it ships as a visible GENERAL
  // var where an operator can see which project a deployment is pointed at.
  for (const key of [
    RESOLVER_ENV.projectId,
    RESOLVER_ENV.location,
    RESOLVER_ENV.pmApiBase,
    RESOLVER_ENV.smApiBase,
    RESOLVER_ENV.tokenUrl,
  ]) {
    const value = process.env[key];
    if (value) envs.push({ key, value, scope: "RUN_TIME", type: "GENERAL" });
  }
} else {
  secret("STRAD_TOKENS", true); // without this, /mcp rejects everything
  secret("STRAD_INTERNAL_TOKEN", true); // core <-> bundle auth
  secret("ADMIN_BOOTSTRAP_TOKEN"); // console dev bypass
  secret("GOOGLE_CLIENT_ID"); // console real auth, when it exists
  secret("GOOGLE_CLIENT_SECRET");
  // Optional: signs the console session cookie. Absent, the key is derived from
  // GOOGLE_CLIENT_SECRET. Set it to rotate every console session (the kill
  // switch) without touching the OAuth client. See src/auth/session.ts.
  secret("CONSOLE_SESSION_SECRET");
}

// --- telemetry (OTLP) -------------------------------------------------------
//
// All of this is OPTIONAL, and that is the point: with no OTEL_EXPORTER_OTLP_
// ENDPOINT set, nothing below is emitted into the spec, no component gets a
// telemetry env var, and every strad process boots with telemetry off. Staging
// and prod are live; an observability change must not be able to take them down,
// so "not configured" has to be a first-class, fully-supported state.
//
// The OTLP auth header is a SECRET and travels the SAME path as every other
// credential: seeded into GCP Secret Manager as `strad-<env>-OTEL_EXPORTER_OTLP_
// HEADERS`, read by deploy-staging.yml into the job env (it loads every
// strad-<env>-* secret), picked up here from process.env, and injected as a
// SECRET-typed env var that DigitalOcean encrypts at rest. It is never written
// to a log and never reaches the repo. No workflow change is needed to add it —
// seeding the secret is the whole job.
// Store-backed deployments get this from the store at boot, like every other
// gateway key — see secrets/provider/hydrate.ts.
if (!storeBacked) {
  secret("OTEL_EXPORTER_OTLP_HEADERS"); // e.g. "Authorization=Bearer <token>"
}

// The endpoint and the sampler knobs are NOT secrets — a collector URL is not a
// credential — so they ship as GENERAL vars, visible in the App Platform console
// where an operator can actually see what the deployment is pointed at.
for (const key of [
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_PROTOCOL",
  "OTEL_SERVICE_NAME",
  "OTEL_RESOURCE_ATTRIBUTES",
  "OTEL_METRIC_EXPORT_INTERVAL",
  "OTEL_TRACES_SAMPLER",
  "OTEL_TRACES_SAMPLER_ARG",
]) {
  const value = process.env[key];
  if (value) envs.push({ key, value, scope: "RUN_TIME", type: "GENERAL" });
}

// Secrets referenced by a NON-supplementary server via ${NAME} — a remote-http
// server's url/headers (e.g. `Authorization: "Bearer ${GRANOLA_TOKEN}"`), a
// builtin's options.
//
// Under the `env` provider these resolve IN-PROCESS from process.env, so they
// belong in the spec as BROADCAST SECRET env vars, and a referenced-but-unset
// name is a hard render error — better a failed deploy than a gateway that
// refuses to start. collectSecretRefs deliberately excludes supplementary-image
// env (those are scoped per bundle — see below). A config with no such refs adds
// nothing.
//
// Under the store provider these are NOT baked at all. They are read at runtime,
// which is the entire point; baking a copy would give a rotated secret a stale
// twin that wins. The fail-loud property is preserved by preflightSecrets()
// below, which checks the same names exist — by name, without reading a value.
if (!storeBacked) {
  const already = new Set(envs.map((e) => e.key));
  for (const name of collectSecretRefs(config)) {
    if (already.has(name)) continue;
    secret(name, true); // referenced by the config => required to boot
    already.add(name);
  }
}

// The store client, when this deployment is store-backed. It is built from the
// SAME bootstrap credential the container will hold, so a deploy that can
// preflight is a deploy whose container can resolve.
const store = resolverFromEnv(process.env);
if (storeBacked && !store) {
  console.error(
    `::error::gateway.secrets.provider is "gcp-parameter-store" but ` +
      `${RESOLVER_ENV.projectId} / ${RESOLVER_ENV.keyJson} are not set. ` +
      `The deploy job must supply the bootstrap credential.`,
  );
  process.exit(1);
}

// A supplementary image's `env:` map may reference `${NAME}` secrets. Unlike the
// SECRETs above (which broadcast to every component), these resolve onto ONLY
// the bundle that names them — see appspec.ts.
//
// These are baked in BOTH modes, and that is not a gap in the runtime story: a
// supplementary image is a container the gateway process does not run, so no
// amount of runtime resolution inside strad can change what is in that
// container's environment. What changes with the store provider is only WHERE
// the value is read from — the store, not the deploy job's environment — so a
// human still manages it in exactly one place. Rotating one of these still needs
// a redeploy; docs/operate/secrets.md says so plainly.
//
// `consoleEnv:` is resolved from the SAME bag, but appspec.ts puts it on the
// core component only — never on the bundle. That asymmetry is what keeps a
// value-reading credential out of the container that answers /mcp.
const scopedSecrets: Record<string, string> = {};
const wanted = bakedSecretNames(config);

// `consoleEnv:` names are read from the ENVIRONMENT ONLY, never from the store.
// That carries the console's store-ADMIN credential, which can write and reveal.
// Filing it inside the store would let the weaker resolver credential — the one
// this script and the gateway container both hold — read the stronger one, and
// the three-role IAM split would be decorative. Enforcing it here means the
// invariant is code rather than a sentence in a design doc.
const consoleOnly = new Set(consoleEnvNames(config));

if (wanted.length > 0) {
  let available: Record<string, string> = {};
  if (storeBacked && store) {
    // One namespace read. The values go straight into the spec and are never
    // logged, printed, or written anywhere but /tmp/spec.json.
    available = await store.resolve(gatewayNamespace(config.gateway.env));
  }

  for (const name of wanted) {
    const value = consoleOnly.has(name)
      ? process.env[name]
      : (available[name] ?? process.env[name]);
    if (!value) {
      console.error(
        `::error::${name} is referenced by a supplementary server's env but ` +
          (storeBacked && !consoleOnly.has(name)
            ? `is not set in ${gatewayNamespace(config.gateway.env)}`
            : `is not set in the environment`),
      );
      process.exit(1);
    }
    scopedSecrets[name] = value;
  }
}

// PREFLIGHT: the fail-loud property that runtime resolution would otherwise cost
// us. Every `${NAME}` the gateway resolves at runtime is checked for EXISTENCE
// in the store, by name. `list()` returns metadata — for a secret parameter, an
// envelope holding a `__REF__` pointer, not the secret — so this needs no
// value-reading permission and reads no value.
if (storeBacked && store) {
  const result = await preflightSecrets(store, config);
  if (result.missing.length > 0) {
    console.error(
      `::error::${result.missing.length} secret(s) referenced by the config are ` +
        `missing from ${result.namespace}: ${result.missing.join(", ")}`,
    );
    process.exit(1);
  }
  console.error(
    `[render-spec] preflight ok: ${result.present.length} referenced secret(s) ` +
      `present in ${result.namespace}.`,
  );
}

// A supplementary server with `params: true` gets its managed parameters —
// everything under /strad/{env}/mcp/{slug}/static/* — resolved from the secrets
// system HERE, at deploy time, by the RESOLVER credential (STRAD_PARAMS_*). The
// resolved values (non-secret from Parameter Manager, secret from Secret Manager)
// are handed to renderAppSpec, which lands them as SECRET env vars on the bundle;
// the running container holds no cloud credential, exactly like every other
// secret. When no resolver is configured (e.g. before the resolver service
// account exists), this is a no-op and those servers boot without the params —
// which they already degrade on gracefully — rather than failing the render.
const resolvedParams: Record<string, Record<string, string>> = {};
const resolver = store;
for (const server of config.servers) {
  if (server.kind !== "supplementary-image" || !server.enabled) continue;
  if (!server.params) continue;
  if (!resolver) {
    console.error(
      `[render-spec] server "${server.slug}" has params: true but no resolver ` +
        `credential (STRAD_PARAMS_*) is configured; its managed parameters are ` +
        `not injected on this render.`,
    );
    continue;
  }
  resolvedParams[server.slug] = await resolveServerParams(
    resolver,
    config.gateway.env,
    server.slug,
  );
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
  const flagged = values.domain?.map((d) => ({
    domain: d,
    type: "PRIMARY" as const,
  }));
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

// Refuse a mutable core tag at the deploy boundary. `renderAppSpec` stays
// permissive on purpose — it shapes specs for tests and for whoever embeds it,
// and has no business demanding a version number — but every spec that reaches
// App Platform is rendered here, so this is where the rule holds. Same split as
// the strict config parse: lenient library, strict deploy gate.
const coreImage = parseImage(values.image);
assertImmutableCoreImage(values.image, coreImage.tag);

const spec = renderAppSpec({
  config,
  appName: values.app,
  region: values.region ?? "nyc",
  image: coreImage,
  // --bundle-image swaps the supplementary components onto a branch-scoped
  // bundle tag at render time, so a branch deploy needs no config edit.
  supplementaryImage: values["bundle-image"],
  env: envs,
  secrets: scopedSecrets,
  resolvedParams,
  domains: resolveDomains(),
});

// A BARE spec, not { spec }. This file is fed to `doctl apps create/update
// --spec`, which parses an App Platform spec and rejects an unknown top-level
// "spec" field outright ("parsing app spec: json: unknown field \"spec\"").
// doctl is what wraps it into the API's { spec } envelope.
process.stdout.write(JSON.stringify(spec, null, 2));
