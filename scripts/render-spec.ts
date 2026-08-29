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
 *     --app strad-staging > "$RUNNER_TEMP/spec.json"
 *
 * The deploy writes it into the job's own temp directory, never a shared /tmp:
 * several runner processes share one self-hosted machine, and a second job
 * rendering to the same path truncates this one mid-deploy. See
 * src/deploy/spec-file.ts.
 *
 * `--bundle-image ghcr.io/tadasant/strad-bundle:<tag>` overrides the image on
 * every supplementary component that shares that repository, which is how a
 * branch build and every ordinary staging deploy ship a tag that names one
 * commit without editing the config's 28 `image:` lines.
 *
 * `--require-immutable-images` refuses to emit a spec in which ANY component
 * ships a mutable tag. It is opt-in rather than the default because the two
 * deploys that render through this script do not have the same options: staging
 * resolves a `sha-` tag for both images and can demand it, while prod renders
 * this repo's tooling against tadasant-internal's config, whose supplementary
 * `image:` lines it would have to change first. Without the flag the same list
 * is printed as a warning, so a deploy that cannot yet fail on it still says so.
 *
 * The output contains secret values. Never echo it into a build log.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { parseConfig } from "../src/config/load.ts";
import {
  bootEnvGaps,
  collectSecretRefs,
  parseImage,
  renderAppSpec,
  type EnvVar,
} from "../src/deploy/appspec.ts";
import {
  BUNDLE_BOOT_ENV_KEYS,
  REQUIRED_BOOT_ENV_KEYS,
} from "../src/secrets/provider/hydrate.ts";
import {
  gatewayNamespace,
  gatewayParameterPath,
  resolverFromEnv,
  staticNamespace,
  RESOLVER_ENV,
} from "../src/secrets/parameters/index.ts";
import {
  bakedSecretNames,
  consoleEnvNames,
  preflightSecrets,
} from "../src/deploy/preflight.ts";
import {
  connectorVarsBySlug,
  coveredPerServer,
  envRefsBySlug,
  groupByServer,
  mcpNamespace,
  substitutionBag,
  unreadParameters,
} from "../src/deploy/server-namespaces.ts";
import {
  assertImmutableCoreImage,
  mutableImageComponents,
} from "../src/deploy/imageTag.ts";
import { unusedWaivers, waivedNames } from "../src/deploy/unseeded.ts";

const { values } = parseArgs({
  options: {
    config: { type: "string" },
    image: { type: "string" },
    "bundle-image": { type: "string" },
    app: { type: "string" },
    region: { type: "string" },
    domain: { type: "string", multiple: true },
    "require-immutable-images": { type: "boolean", default: false },
  },
});

if (!values.config || !values.image || !values.app) {
  console.error(
    "usage: render-spec --config <path> --image <ref> --app <name>",
  );
  process.exit(1);
}

// Refuse a mutable core tag at the deploy boundary, BEFORE any of the work
// below — a bad --image should not cost a config parse and a GCP round trip
// first. `renderAppSpec` stays permissive on purpose: it shapes specs for tests
// and for whoever embeds it, and has no business demanding a version number.
// But every spec that reaches App Platform is rendered here, so this is where
// the rule holds. Same split as the strict config parse: lenient library,
// strict deploy gate.
const coreImage = parseImage(values.image);
assertImmutableCoreImage(values.image, coreImage.tag);

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

// A DELIBERATELY UNSEEDED SECRET DEGRADES ONE SLUG. EVERY OTHER ONE STILL REDS
// THE DEPLOY.
//
// Adding a server whose credential nobody has seeded yet used to fail this
// render for the whole fleet, which put a human gate in front of every new
// server: seed the token, THEN merge. `mayBeUnseeded:` moves that gate — the
// name a human listed warns here and leaves its slug `unconfigured` at runtime
// (src/gateway/unconfigured.ts), and every unlisted name keeps the hard failure
// that catches a typo at the deploy instead of at 3am on one request. See
// src/deploy/unseeded.ts for why the waiver is per NAME and has to be unanimous.
const waived = waivedNames(config);

/**
 * The waived names that turned out to have NO value at render time.
 *
 * Populated as the baked half is resolved below, and handed to `renderAppSpec`
 * so it drops the `env:`/`consoleEnv:` entries that mention them. A waived name
 * that DID resolve is not in here — the waiver is permission to be absent, not
 * an instruction to omit.
 */
const unseededBaked = new Set<string>();

// THE TYPO GATE, and the reason the feature does not reintroduce the silence it
// replaces. A waiver for a name this server references nowhere waives nothing —
// the reference it was written for is still unwaived and still fails below — so
// the useless entry is the mistake, and it is fatal here rather than a warning
// nobody reads. Fails BEFORE any store round trip: it is a pure config question.
{
  const problems = unusedWaivers(config);
  for (const problem of problems) console.error(`::error::${problem}`);
  if (problems.length > 0) process.exit(1);
}

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
// gateway key — see secrets/provider/hydrate.ts. Every process that runs the
// strad image, that is: a THIRD-PARTY supplementary image cannot hydrate, so it
// is baked from the store further down (`bootSecrets`).
if (!storeBacked) {
  secret("OTEL_EXPORTER_OTLP_HEADERS"); // e.g. "Authorization=Bearer <token>"
  // The GlitchTip DSN, on the same terms: seeded as `strad-<env>-SENTRY_DSN`,
  // optional everywhere, and a SECRET because it is a write credential for the
  // ingestor. Unlike the OTLP header it does NOT reach a supplementary image —
  // it is in STRAD_IMAGE_ONLY_SECRET_KEYS, because only strad's own process
  // reports exceptions. Absent, the exception reporter never starts.
  secret("SENTRY_DSN"); // e.g. "https://<key>@glitchtip.example.com/1"
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
    // A WAIVED name is not required, and its absence omits the env var rather
    // than failing the render. Nothing resolves it at boot any more — the
    // registry resolves `${NAME}` per operation (src/gateway/registry.ts) — so
    // the omission costs exactly the slugs that named it, which come up
    // `unconfigured`, and costs nothing to anything else on the spec.
    if (waived.has(name) && !process.env[name]) {
      console.error(
        `::warning::unseeded secret ${name} is not set in the deploy ` +
          `environment, and ${waived.get(name)!.join(", ")} declared ` +
          `mayBeUnseeded for it. Those server(s) deploy INACTIVE. This ` +
          `deployment bakes its secrets (gateway.secrets.provider: env), so ` +
          `seeding the value takes a REDEPLOY to take effect — not a PR.`,
      );
      already.add(name);
      continue;
    }
    secret(name, true); // referenced by the config => required to boot
    already.add(name);
  }
}

// The store client, when this deployment is store-backed. It is built from the
// SAME bootstrap credential the container will hold, so a deploy that can
// preflight is a deploy whose container can resolve.
// One enumeration of the store for the whole render. `resolve()` enumerates the
// project once per namespace — the namespace lives inside a parameter's envelope,
// not on a label — so resolving N namespaces cost N x P version reads, and six
// added server slugs took that past Parameter Manager's per-project read quota
// and 429'd a production deploy. This render is one-shot and reads only, so
// reusing the enumeration is safe here in a way it is not for the gateway or the
// console, both of which write.
const store = resolverFromEnv(process.env, { rosterTtlMs: 10 * 60_000 });
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

/**
 * Does this config put a THIRD-PARTY container on the app?
 *
 * That is the population that cannot hydrate, and the only reason to read the
 * boot keys out of the store here.
 */
const hasSupplementary = config.servers.some(
  (s) => s.enabled && s.kind === "supplementary-image",
);

/**
 * The gateway namespace, resolved at most once, and only when it is needed.
 *
 * `resolve()` renders the WHOLE namespace and throws on any parameter in it that
 * cannot be rendered (HACKS #36), so a config that needs this read inherits that
 * blast radius — including for a broken parameter it does not itself use. That
 * is why it is lazy: a deployment that needs neither a supplementary `env:` nor
 * the bundle boot keys never asks.
 */
let namespaceValues: Record<string, string> | null = null;
async function storeValues(): Promise<Record<string, string>> {
  if (!storeBacked || !store) return {};
  namespaceValues ??= await store.resolve(gatewayNamespace(config.gateway.env));
  return namespaceValues;
}

// `consoleEnv:` names are read from the ENVIRONMENT ONLY, never from the store.
// That carries the console's store-ADMIN credential, which can write and reveal.
// Filing it inside the store would let the weaker resolver credential — the one
// this script and the gateway container both hold — read the stronger one, and
// the three-role IAM split would be decorative. Enforcing it here means the
// invariant is code rather than a sentence in a design doc.
const consoleOnly = new Set(consoleEnvNames(config));

/**
 * A server namespace, resolved at most once per render.
 *
 * Two callers want the same read — `${NAME}` substitution below and the
 * `params: true` injection further down — and `resolve()` renders the whole
 * namespace, so asking twice would double the `:render` calls for a server that
 * uses both.
 */
const namespaceCache = new Map<string, Promise<Record<string, string>>>();
function resolveNamespace(namespace: string): Promise<Record<string, string>> {
  const cached = namespaceCache.get(namespace);
  if (cached) return cached;
  const pending = store!.resolve(namespace);
  namespaceCache.set(namespace, pending);
  return pending;
}

// PER-SERVER SUBSTITUTION.
//
// Every `${NAME}` in a supplementary server's `env:` used to resolve from ONE
// place — the gateway namespace — keyed on the name alone, which made a name a
// deployment-wide singleton: `telegram-ro` and `telegram-rw` both write
// `${TELEGRAM_API_HASH}` and could not be given different credentials. A server's
// OWN namespace is consulted first now, and the shared one remains the fallback.
// See src/deploy/server-namespaces.ts for the layering and why it needs no flag.
//
// Gated on a RESOLVER CREDENTIAL, not on the provider, which is where the
// `params: true` path below already draws its line: no credential, no per-server
// read, and every name falls back exactly as it did.
const refsBySlug = envRefsBySlug(config);
// The names a server's own namespace must be READ for, which is wider than the
// names it is CHECKED for. A connector's three variables are injected rather
// than referenced (src/deploy/appspec.ts), so they belong in the substitution
// bag — but not in `refsBySlug`, which feeds `coveredPerServer` below and
// answers a question about `${NAME}` references and their gateway fallback.
const wantedBySlug = new Map<string, Set<string>>();
for (const source of [refsBySlug, connectorVarsBySlug(config)]) {
  for (const [slug, names] of source) {
    const held = wantedBySlug.get(slug) ?? new Set<string>();
    for (const name of names) held.add(name);
    wantedBySlug.set(slug, held);
  }
}
const serverSecrets: Record<string, Record<string, string>> = {};
if (store) {
  // ONE listing of /strad/{env}/mcp/ for the whole render. It is metadata — a
  // secret parameter's payload is a `__REF__` pointer — so this reads no value,
  // and it is what tells us which of the 28 servers is worth a `resolve()`.
  const { seeded, unroutable } = groupByServer(
    config.gateway.env,
    await store.list(mcpNamespace(config.gateway.env)),
  );
  // A path under mcp/ that is not {slug}/static/{VAR} is read by nothing at all.
  if (unroutable.length > 0) {
    console.error(
      `::warning::${unroutable.length} parameter(s) under ` +
        `${mcpNamespace(config.gateway.env)} are not ` +
        `{slug}/static/{VARIABLE} paths, so no resolver reads them: ` +
        `${unroutable.join(", ")}.`,
    );
  }

  // The slugs worth a value read: seeded, AND seeded with a name this server
  // actually references. Resolved concurrently — each `resolve()` renders a
  // whole namespace, and doing them one after another puts the sum of them on
  // the deploy's critical path for no reason.
  const candidates = [...wantedBySlug].filter(([slug, refs]) => {
    const held = seeded.get(slug);
    return Boolean(held?.length) && [...refs].some((n) => held!.includes(n));
  });

  // ...but in BATCHES, not all at once. `resolve()` already fans out ten wide
  // inside one namespace, so resolving every namespace simultaneously made the
  // burst a function of how many servers the config has — and Parameter Manager
  // enforces a per-project read quota. Six new `google-sheets-*` slugs were what
  // took that burst over it: the render 429'd, and a production deploy died
  // before `doctl` was ever called. The retry in the store client is what
  // survives a refusal; this is what stops provoking one, and it holds whether
  // the config carries fourteen servers or forty.
  const NAMESPACE_FANOUT = 3;
  const bags: ReturnType<typeof substitutionBag>[] = [];
  for (let i = 0; i < candidates.length; i += NAMESPACE_FANOUT) {
    bags.push(
      ...(await Promise.all(
        candidates
          .slice(i, i + NAMESPACE_FANOUT)
          .map(async ([slug, refs]) =>
            substitutionBag(
              await resolveNamespace(staticNamespace(config.gateway.env, slug)),
              refs,
            ),
          ),
      )),
    );
  }

  for (const [i, [slug]] of candidates.entries()) {
    const namespace = staticNamespace(config.gateway.env, slug);
    const { bag, unusable } = bags[i]!;

    // A parameter that EXISTS and yields no usable value — an un-dereferenced
    // `__REF__`, an empty payload — is reported and then ignored, so the shared
    // namespace still gets its turn. Baking the pointer would ship a
    // non-credential AND suppress a value that works.
    if (unusable.length > 0) {
      console.error(
        `::warning::${namespace} holds ${unusable.join(", ")}, and the ` +
          `resolver got no usable value back (an un-dereferenced __REF__, or an ` +
          `empty payload). "${slug}" falls back to ` +
          `${gatewayNamespace(config.gateway.env)} for ${unusable.length === 1 ? "it" : "them"}. ` +
          `store:check --resolve says which parameter cannot be rendered.`,
      );
    }
    if (Object.keys(bag).length === 0) continue;
    serverSecrets[slug] = bag;
    // Names only. Which server draws which name from where is exactly what an
    // operator needs when two servers disagree about one name.
    console.error(
      `[render-spec] server "${slug}" resolves ` +
        `${Object.keys(bag).sort().join(", ")} from ${namespace} ` +
        `(ahead of ${gatewayNamespace(config.gateway.env)}).`,
    );
  }

  // A SEEDED PARAMETER NOTHING READS IS THE FAILURE THIS FEATURE EXISTS TO END.
  //
  // The old renderer skipped a server without `params: true` with a bare
  // `continue`: values seeded under its namespace produced no env var, no
  // warning and a green deploy. Say it instead — by name, never by value.
  for (const finding of unreadParameters(config, seeded)) {
    console.error(`::warning::${finding.message}`);
  }
}

if (wanted.length > 0) {
  // One namespace read, shared with the boot keys below. The values go straight
  // into the spec and are never logged, printed, or written anywhere but the
  // rendered spec on stdout.
  const available = await storeValues();

  for (const name of wanted) {
    const value = consoleOnly.has(name)
      ? process.env[name]
      : (available[name] ?? process.env[name]);
    if (!value) {
      // Not missing if every server that references it was served by its OWN
      // namespace: the shared bag is a FALLBACK, and demanding a fallback for a
      // name nothing falls back for would refuse a correct deploy. A name even
      // one referencing server still needs from the shared bag is missing, and
      // the error says which servers those are.
      if (
        !consoleOnly.has(name) &&
        coveredPerServer(name, refsBySlug, serverSecrets)
      ) {
        continue;
      }
      const unserved = [...refsBySlug]
        .filter(
          ([slug, refs]) =>
            refs.has(name) && serverSecrets[slug]?.[name] === undefined,
        )
        .map(([slug]) => slug);
      // A WAIVED name omits the variable instead of failing the render. Be
      // honest about the cost: this half is BAKED onto a container strad does
      // not run, so no runtime resolution inside the gateway can reach it. The
      // slug comes up without the variable and stays that way until the next
      // deploy, which is a redeploy rather than a PR — but it is emphatically
      // not the TTL the runtime refs get.
      if (waived.has(name)) {
        unseededBaked.add(name);
        console.error(
          `::warning::unseeded secret ${name} is referenced by a supplementary ` +
            `server's env: and ${waived.get(name)!.join(", ")} declared ` +
            `mayBeUnseeded for it, so it is omitted from the spec and ` +
            `${unserved.length > 0 ? unserved.join(", ") : "that component"} ` +
            `deploys INACTIVE. This half is BAKED onto the component: seeding ` +
            `the value needs a REDEPLOY to take effect, not just a TTL.`,
        );
        continue;
      }
      console.error(
        `::error::${name} is referenced by a supplementary server's env but ` +
          (storeBacked && !consoleOnly.has(name)
            ? `is not set in ${gatewayNamespace(config.gateway.env)}`
            : `is not set in the environment`) +
          (unserved.length > 0 && !consoleOnly.has(name)
            ? `, and the server(s) that reference it (${unserved.join(", ")}) ` +
              `have no ${name} of their own under ` +
              `${mcpNamespace(config.gateway.env)}{slug}/static/ either`
            : ""),
      );
      process.exit(1);
    }
    scopedSecrets[name] = value;
  }
}

// A PER-SERVER VALUE THAT SHADOWS A SHARED ONE IS A CREDENTIAL SWAP, AND SAYS SO.
//
// Both namespaces holding the name is the one case where this render changes
// what a working deployment ships: the server used to get the shared value and
// now gets its own. That is the point of the feature and it is still worth an
// annotation, because the two are different credentials by construction — a
// stale per-server copy seeded months ago outranks the one being rotated.
// Names and paths only.
if (namespaceValues) {
  for (const [slug, bag] of Object.entries(serverSecrets)) {
    const shadowed = Object.keys(bag)
      .filter((name) => namespaceValues?.[name] !== undefined)
      .sort();
    if (shadowed.length === 0) continue;
    console.error(
      `::warning::server "${slug}" takes ${shadowed.join(", ")} from ` +
        `${staticNamespace(config.gateway.env, slug)}, and ` +
        `${gatewayNamespace(config.gateway.env)} holds ${shadowed.length === 1 ? "that name" : "those names"} ` +
        `too. The per-server value wins. Delete whichever copy is not the one ` +
        `you rotate.`,
    );
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
    // WHICH SLUG IS SHORT. A name held by some of its referencing servers and
    // not others fails here, and "missing from the gateway namespace" points at
    // the wrong fix — the value usually belongs under the one slug that was
    // skipped. Names and slugs only.
    for (const [name, slugs] of Object.entries(result.unservedSlugs)) {
      console.error(
        `::error::${name} is not held by ${slugs.join(", ")}. Seed it under ` +
          `each of those servers' own namespace, or in ${result.namespace}.`,
      );
    }
    process.exit(1);
  }
  // THE DELIBERATELY-DEFERRED CREDENTIAL, said out loud, once per name.
  //
  // `::warning::` and a fixed `unseeded secret` prefix so a deploy log is
  // greppable for exactly this: which slugs shipped inactive, and what a human
  // has to seed to finish the job. It is the whole visible cost of the deploy
  // no longer failing, so it must not be a line that scrolls past unnamed.
  for (const name of result.waived) {
    console.error(
      `::warning::unseeded secret ${name} is held by neither ` +
        `${result.namespace} nor ${mcpNamespace(config.gateway.env)}{slug}/static/, ` +
        `and ${result.waivedSlugs[name]!.join(", ")} declared mayBeUnseeded ` +
        `for it. Those server(s) deploy INACTIVE and report state ` +
        `"unconfigured" on /healthz and in the console. Seed it in ` +
        `${result.namespace} and they start serving within ` +
        `${config.gateway.secrets.negativeTtlSeconds}s, with no redeploy.`,
    );
  }
  console.error(
    `[render-spec] preflight ok: ${result.present.length} referenced secret(s) ` +
      `present in ${result.namespace}` +
      (result.perServer.length > 0
        ? `, plus ${result.perServer.length} served from the referencing ` +
          `server's own namespace instead (${result.perServer.join(", ")})`
        : "") +
      (result.waived.length > 0
        ? `, plus ${result.waived.length} deliberately unseeded ` +
          `(${result.waived.join(", ")})`
        : "") +
      `.`,
  );
}

// THE BOOT KEYS A THIRD-PARTY CONTAINER CANNOT FETCH FOR ITSELF.
//
// `hydrateBootEnv` is what lets this script stop baking the gateway's boot env
// under the store provider — but it runs in strad's own process, and a
// `supplementary-image` component does not run strad. It holds no store
// credential (appspec.ts keeps the resolver key off it deliberately) and would
// not know what to do with one. Under the store provider it was therefore left
// with neither source, and the two names in BUNDLE_BOOT_ENV_KEYS both fail
// silently when absent: telemetry keeps exporting into a 401, and the presence
// route fails closed. See the comment on `bundleBootEnvVars` in appspec.ts.
//
// Read from the STORE, never from `process.env`: the deploy environment stopped
// being a source of gateway secrets at the flip, and reinstating it here would
// let a stale CI value outrank a rotated stored one. Whatever core would
// hydrate is what the bundles are handed.
const bootSecrets: Record<string, string> = {};
if (storeBacked && hasSupplementary) {
  const available = await storeValues();
  for (const key of BUNDLE_BOOT_ENV_KEYS) {
    const value = available[key];
    if (value) bootSecrets[key] = value;
  }
  // Names only, never values — the roster this deploy is about to bake onto its
  // third-party containers is worth seeing in the run log.
  console.error(
    `[render-spec] boot env baked onto supplementary components: ` +
      `${Object.keys(bootSecrets).sort().join(", ") || "(none)"}.`,
  );

  // A REQUIRED boot key that resolved to nothing fails the deploy here.
  //
  // Preflight already demands these by NAME, and it asks `list()` — so a
  // parameter that exists, reports a value, and renders to nothing passes it and
  // arrives here empty. Under the `env` provider the same name is
  // `secret(key, required)` and a missing one fails the render; this is that
  // line, held on the store path, for the component that cannot go and look for
  // itself.
  for (const key of REQUIRED_BOOT_ENV_KEYS) {
    if (!(BUNDLE_BOOT_ENV_KEYS as readonly string[]).includes(key)) continue;
    if (bootSecrets[key]) continue;
    console.error(
      `::error::${key} resolved to no value in ` +
        `${gatewayNamespace(config.gateway.env)}, and a supplementary component ` +
        `cannot read the store for itself. Seed or repair that parameter — ` +
        `presence is not resolvability, so store:check --resolve is what says which.`,
    );
    process.exit(1);
  }

  // The OTLP header is OPTIONAL — an ingestor that needs no auth is ordinary —
  // so this warns rather than failing. But an ENDPOINT with no header is the
  // exact shape that took prod's bundle off telemetry, and it is indistinguishable
  // from a healthy deploy until the ingestor starts refusing batches. Say so.
  if (
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT &&
    !bootSecrets.OTEL_EXPORTER_OTLP_HEADERS
  ) {
    console.error(
      `::warning::telemetry has an endpoint but ` +
        `${gatewayParameterPath(config.gateway.env, "OTEL_EXPORTER_OTLP_HEADERS")} ` +
        `resolved to nothing, so every supplementary component will export ` +
        `unauthenticated. Correct if the ingestor takes anonymous OTLP; if it ` +
        `does not, those components go blind about a minute after this deploy.`,
    );
  }
}

/**
 * The boot keys this render actually has a value for, from whichever source
 * this deployment uses. A key nobody configured cannot be a gap — a deployment
 * with no OTLP ingestor has no header, and that is a supported state.
 */
const heldBootKeys = BUNDLE_BOOT_ENV_KEYS.filter((key) =>
  storeBacked ? bootSecrets[key] !== undefined : Boolean(process.env[key]),
);

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
  resolvedParams[server.slug] = await resolveNamespace(
    staticNamespace(config.gateway.env, server.slug),
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
  serverSecrets,
  // The names a human deferred and the store does not hold. `renderAppSpec`
  // DROPS an `env:`/`consoleEnv:` entry that mentions one instead of resolving
  // it — `resolveMap` throws on an unresolved ref, and that throw would fail the
  // whole render, which is the fleet-wide failure this feature removes.
  unseededRefs: unseededBaked,
  bootSecrets,
  resolvedParams,
  domains: resolveDomains(),
  // Names and paths only — the renderer never hands a value to this.
  onWarning: (message) => console.error(`::warning::${message}`),
});

// EVERY COMPONENT CAN EITHER FETCH ITS BOOT ENV OR IS HANDED IT.
//
// This is the rule the store-backed path broke, and it broke it quietly: the
// deploy was green, `/healthz` was 200 with every slug listed, and the only
// symptom was a component that stopped exporting telemetry a minute later. So
// it is asserted on the rendered spec — structurally, per component — rather
// than trusted to hold.
//
// It runs for BOTH providers, because the property is not about the provider:
// a component that holds neither the store credential nor the value is
// misconfigured either way.
const gaps = bootEnvGaps(spec, heldBootKeys);
if (gaps.length > 0) {
  console.error(
    `::error::${gaps.length} component(s) would boot without env they cannot ` +
      `fetch for themselves:\n  ${gaps.join("\n  ")}\n` +
      `A supplementary image does not run strad, so it never hydrates: the ` +
      `renderer has to bake these. See src/deploy/appspec.ts.`,
  );
  process.exit(1);
}

// THE OTHER HALF of the immutable-tag rule, and the half that was missing.
//
// `assertImmutableCoreImage` above guards the one image passed as an argument.
// Every other component takes its image from the config, and for a year that
// meant `ghcr.io/tadasant/strad-bundle:latest` on all 27 `supplementary-image`
// entries. App Platform resolved that tag once and kept the answer: staging ran
// a bundle from before the `/secrets` mount existed for a week, restarting daily
// onto the same cached digest, while `/healthz` stayed 200 and
// `?servers=secrets` answered `{"tools":[]}`. See HACKS.md #32.
//
// So the check runs on the RENDERED spec, after --bundle-image has had its say —
// what matters is the tag a component actually ships, not where it came from.
const mutable = mutableImageComponents(spec.services);
if (mutable.length > 0) {
  const detail = mutable.map((m) => `${m.component} -> ${m.ref}`).join(", ");
  const why =
    `App Platform may serve a mutable tag from whatever digest it resolved ` +
    `last, so the spec does not determine what boots.`;
  if (values["require-immutable-images"]) {
    console.error(
      `::error::${mutable.length} component(s) would ship a mutable tag: ` +
        `${detail}.\n${why}\n` +
        `Pass --bundle-image with a :sha-<commit> tag (published per commit by ` +
        `release-bundle-image.yml), or drop --require-immutable-images.`,
    );
    process.exit(1);
  }
  console.error(
    `::warning::${mutable.length} component(s) ship a mutable tag: ${detail}. ` +
      `${why} This deploy cannot verify which image those components will run.`,
  );
}

// A BARE spec, not { spec }. This file is fed to `doctl apps create/update
// --spec`, which parses an App Platform spec and rejects an unknown top-level
// "spec" field outright ("parsing app spec: json: unknown field \"spec\"").
// doctl is what wraps it into the API's { spec } envelope.
process.stdout.write(JSON.stringify(spec, null, 2));
