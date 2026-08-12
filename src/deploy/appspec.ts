import type { StradConfig } from "../config/schema.ts";
import { bundleUrlEnvName } from "../gateway/registry.ts";
import { prefixedEnvName, slugEnvPrefix } from "../secrets/env-prefix.ts";
import { resolveMap } from "../secrets/index.ts";
import { PARAM_KEYS_ENV } from "../secrets/presence.ts";
import { BUNDLE_BOOT_ENV_KEYS } from "../secrets/provider/hydrate.ts";

/**
 * Render a DigitalOcean App Platform spec from strad.config.yaml.
 *
 * This is the deploy-time half of the config interface: the same `servers:`
 * list that the gateway reads at runtime decides, here, how many containers
 * exist and how they are wired. Adding a server is one config entry; if it
 * needs a container, one appears.
 *
 * Hard-won App Platform facts encoded below — each cost a PoC to learn:
 *
 *   - An INTERNAL component sets `internal_ports: [8080]` and must OMIT
 *     `http_port`. `http_port` is what mints the public route. Setting both to
 *     the same value is a hard API rejection.
 *   - Do NOT write your own `ingress` rules. App Platform generates them from
 *     the component that has `http_port`; supplying your own fights it.
 *   - `${bundle-name.PRIVATE_URL}` resolves to `http://bundle-name:8080` on the
 *     private network — no hairpin through the public edge (3.9ms vs 58ms).
 *   - Deploy from a REGISTRY IMAGE, not a GitHub source. App Platform's GitHub
 *     integration requires an interactive OAuth handshake and cannot be driven
 *     headlessly from CI.
 */

export interface RenderOptions {
  config: StradConfig;
  /** App name, e.g. "strad-staging". */
  appName: string;
  region: string;
  /** The strad core image, e.g. ghcr.io/tadasant/strad:0.1.3 */
  image: ImageRef;
  /** Env vars for every component. SECRET-typed ones are injected by CI. */
  env: EnvVar[];
  /**
   * Secret values used to resolve `${NAME}` refs in a supplementary image's
   * per-server `env:` map. This is what scopes a credential to the ONE bundle
   * that needs it, instead of broadcasting it to every component via `env`.
   * A referenced name missing from this bag is a hard error (fail closed).
   */
  secrets?: Readonly<Record<string, string>>;
  /**
   * Per-server substitution values, keyed by server slug -> NAME -> value.
   *
   * The SAME job as `secrets`, one scope in: these come from that server's own
   * `/strad/{env}/mcp/{slug}/static/` namespace, and they WIN over the shared bag
   * for that server's `env:` refs. It is what lets two servers write
   * `${TELEGRAM_API_HASH}` and mean different credentials — see
   * src/deploy/server-namespaces.ts for the layering, and the collision check
   * below for the limit (two servers on ONE bundle share one environment, so
   * "different values" there is a hard error, not a resolution).
   *
   * Absent or empty for a server nobody seeded, which is every server in every
   * deployment that predates this: resolution then reads exactly as it did, out
   * of `secrets` alone.
   */
  serverSecrets?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /**
   * Resolved managed parameters, keyed by server slug -> VARIABLE -> value.
   *
   * A supplementary server with `params: true` has its `/strad/{env}/mcp/{slug}/
   * static/*` parameters resolved from the secrets system at DEPLOY time (see
   * scripts/render-spec.ts, which holds the resolver credential — the container
   * does not) and passed in here. They land as SECRET env vars on that server's
   * bundle, exactly like its `env:` refs, so the running container reads them from
   * process.env and holds no cloud credential of its own.
   */
  resolvedParams?: Readonly<Record<string, Record<string, string>>>;
  /**
   * Override the image a supplementary component runs, without editing the
   * config's 25 `image:` lines. This is what makes a BRANCH deployable:
   * the branch build pushes `ghcr.io/tadasant/strad-bundle:branch-<slug>`, and
   * the deploy renders the branch's own config against that tag.
   *
   * The override is REPOSITORY-SCOPED, not blanket: it replaces only those
   * supplementary images whose registry+repository match the override's own, so
   * a config mounting some OTHER supplementary image keeps it — and that other
   * image stays on whatever tag the config names, since a branch build produces
   * one bundle image, not one per repository.
   *
   * Two ways to get this wrong both throw rather than deploy something that
   * merely looks right, because the failure this feature exists to prevent is a
   * green branch deploy that silently ran `strad-bundle:latest`:
   *   - a ref that matches no supplementary server (wrong repository), and
   *   - a ref whose tag is `latest`, explicitly or by omission.
   */
  supplementaryImage?: string;
  /**
   * The boot env a component cannot fetch for itself, by name -> value.
   *
   * Supplied by a STORE-BACKED render only, and read from the store rather than
   * the deploy environment, so it is still one place a human manages. Under the
   * `env` provider these same names arrive as broadcast SECRETs in `env` and
   * this is empty.
   *
   * Only `BUNDLE_BOOT_ENV_KEYS` are taken from it, and only onto components that
   * cannot hydrate — see `bundleBootEnvVars` below for why that is not the same
   * set as "every bundle".
   */
  bootSecrets?: Readonly<Record<string, string>>;
  /**
   * Where a non-fatal finding goes. Absent means "nowhere" — the renderer is
   * usable as a pure function in tests and in the console.
   *
   * `scripts/render-spec.ts` passes an emitter that writes `::warning::` lines,
   * which is what puts a finding in the deploy log. Nothing here ever passes a
   * VALUE to it; a warning names slugs, variables and paths.
   */
  onWarning?: (message: string) => void;
  /** Custom domains, if any. Omit to use the default *.ondigitalocean.app. */
  domains?: { domain: string; type?: "PRIMARY" | "ALIAS" }[];
  coreInstanceSizeSlug?: string;
}

/**
 * Resolve a supplementary server's `consoleEnv:` onto the CORE component only.
 *
 * Note what this is NOT: it is not `opts.env`. A SECRET-typed entry in `opts.env`
 * is BROADCAST — look at the bundle branch below, which forwards
 * `opts.env.filter(e => e.type === "SECRET")` to every supplementary component.
 * So the ordinary way to give the core gateway a credential also hands it to the
 * container that answers /mcp, which for the `secrets` server would put the value-reading
 * service-account key inside the process an agent talks to. The IAM split would
 * then be a lie: the MCP credential could not read a value, but a stronger one
 * would be sitting in the same environment.
 *
 * `consoleEnv:` is therefore resolved HERE and appended to core's envs alone.
 * test/appspec.consoleEnv.test.ts asserts the key appears on core and on no
 * other component.
 */
function consoleEnvVars(
  config: StradConfig,
  secrets: Readonly<Record<string, string>>,
): EnvVar[] {
  const merged: Record<string, string> = {};
  for (const server of config.servers) {
    if (!server.enabled) continue;
    if (server.kind !== "supplementary-image") continue;
    Object.assign(merged, server.consoleEnv);
  }
  return Object.entries(resolveMap(merged, secrets)).map(
    ([key, value]): EnvVar => ({
      key,
      value,
      scope: "RUN_TIME",
      type: "SECRET",
    }),
  );
}

export interface ImageRef {
  registry_type: "GHCR" | "DOCR" | "DOCKER_HUB";
  registry?: string;
  repository: string;
  tag: string;
}

export interface EnvVar {
  key: string;
  value: string;
  scope?: "RUN_TIME" | "BUILD_TIME" | "RUN_AND_BUILD_TIME";
  type?: "GENERAL" | "SECRET";
}

export interface AppSpec {
  name: string;
  region: string;
  features?: string[];
  services: ServiceSpec[];
  domains?: { domain: string; type?: string }[];
}

export interface ServiceSpec {
  name: string;
  image: ImageRef;
  instance_size_slug: string;
  instance_count: number;
  envs: EnvVar[];
  /** Public component ONLY. Its presence is what creates the public route. */
  http_port?: number;
  /** Internal component ONLY. Mutually exclusive with http_port. */
  internal_ports?: number[];
  health_check?: {
    http_path: string;
    initial_delay_seconds?: number;
    period_seconds?: number;
  };
}

const PORT = 8080;

/**
 * Telemetry env vars that must reach EVERY component, including supplementary
 * images.
 *
 * This list exists because of an asymmetry that is easy to miss and silent when
 * you get it wrong. A supplementary component does NOT receive the broadcast
 * `opts.env` — look below: it gets its
 * own scoped secrets plus `opts.env.filter(e => e.type === "SECRET")`, and
 * nothing else. That is deliberate and correct for `STRAD_CONFIG_YAML` (a
 * supplementary image does not run strad and has no use for strad's server
 * list).
 *
 * But it means a GENERAL var like `OTEL_EXPORTER_OTLP_ENDPOINT` would reach the
 * core and every strad-image bundle, and would NOT reach the supplementary image
 * — i.e. it would instrument everything EXCEPT the one container where Chromium
 * and the `op` CLI actually live, which is the entire reason we are doing this.
 * The failure mode is the worst kind: no error, no warning, just a dashboard
 * that is quietly missing the component you care about most.
 *
 * `OTEL_EXPORTER_OTLP_HEADERS` is not in this list on purpose — it is a SECRET
 * (it carries the ingestor's auth token) and so it already crosses via the
 * SECRET filter, on the same path as every other credential.
 */
const TELEMETRY_ENV_KEYS = new Set([
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_PROTOCOL",
  "OTEL_SERVICE_NAME",
  "OTEL_RESOURCE_ATTRIBUTES",
  "OTEL_METRIC_EXPORT_INTERVAL",
  "OTEL_TRACES_SAMPLER",
  "OTEL_TRACES_SAMPLER_ARG",
]);

/**
 * SECRETs that must reach the strad image and STOP there.
 *
 * A SECRET-typed entry in `opts.env` is BROADCAST — see the supplementary branch
 * below, which forwards every one of them to each supplementary component. That
 * is right for a credential the servers themselves need and wrong for one that
 * only strad's own process uses.
 *
 * The store credential is the sharp case. It can read every value in the gateway
 * namespace — the token store, the OAuth client secret, every third-party bearer
 * token — so broadcasting it would put a key to all of them inside `good-eggs`,
 * `fetchpet` and every other third-party image, none of which have any use for
 * it. One env-dumping tool or one compromised upstream image would then be worth
 * the entire deployment. Scoping is what keeps the blast radius of a
 * supplementary image bounded by what that image was actually handed.
 *
 * This is the same reasoning as `consoleEnv:` (see `consoleEnvVars`), one layer
 * out: that one is core-only, this one is core plus the bundles running the
 * strad image, because those run `hydrateBootEnv` and may host a `params:`
 * builtin. `test/appspec.secrets.test.ts` asserts it lands on neither more nor
 * fewer components than that.
 */
const STRAD_IMAGE_ONLY_SECRET_KEYS = new Set([
  "STRAD_PARAMS_RESOLVER_SERVICE_ACCOUNT_KEY_JSON",
  // The GlitchTip DSN. Only strad's own process reports exceptions (see
  // src/telemetry/errors.ts); a supplementary image runs someone else's code
  // and has nothing to do with it. A DSN is a write credential for the
  // ingestor, and broadcasting one to every third-party container would hand
  // each of them the ability to write into strad's issue tracker.
  "SENTRY_DSN",
]);

/**
 * The boot env a SUPPLEMENTARY component is BAKED, because it can never read the
 * store for itself.
 *
 * `hydrateBootEnv` fills these in from the provider at boot, and that is what
 * lets a store-backed render stop baking them (see scripts/render-spec.ts). But
 * it only runs where strad's own process runs: the core, and a bundle running
 * the strad image. A `supplementary-image` component is a THIRD-PARTY container
 * — it does not run strad, it holds no store credential (the set above is what
 * keeps the resolver key off it), and giving it one would not help, because
 * nothing in that image knows how to ask.
 *
 * So a store-backed render left those components with NEITHER source: the
 * renderer stopped baking on the assumption hydration would cover it, and
 * hydration cannot reach them. Both keys are silent when missing, which is the
 * whole problem:
 *
 *   - `OTEL_EXPORTER_OTLP_HEADERS` — the exporter still starts and still sends;
 *     the ingestor rejects every batch. The component answering every
 *     supplementary slug goes blind about a minute after a deploy that reports
 *     success, while `/healthz` stays 200 with every slug listed. That is
 *     precisely the blind spot that let a dead `secrets` slug look healthy for a
 *     week (HACKS.md #32).
 *   - `STRAD_INTERNAL_TOKEN` — the component's presence route
 *     (`src/secrets/presence.ts`) fails closed, so the console stops being able
 *     to say whether that container holds its credentials and reports that the
 *     component "REFUSED the internal token" instead.
 *
 * The values are read from the STORE by the renderer, not from the deploy
 * environment, so a human still manages them in exactly one place. The cost is
 * stated rather than hidden: a baked value changes on a redeploy, not on a
 * restart, so rotating one of these is a deploy — the same trade every
 * supplementary `env:` name already makes, for the same reason.
 * `docs/operate/secrets.md` carries the table.
 */
function bundleBootEnvVars(
  bootSecrets: Readonly<Record<string, string>>,
  taken: ReadonlySet<string>,
): EnvVar[] {
  const out: EnvVar[] = [];
  for (const key of BUNDLE_BOOT_ENV_KEYS) {
    // The component's own `env:` or a managed parameter wins. One container has
    // one environment, and a server that deliberately sets one of these names
    // for its own upstream must not be overwritten from underneath.
    if (taken.has(key)) continue;
    const value = bootSecrets[key];
    // Absent is ORDINARY: an ingestor that needs no auth header has no
    // OTEL_EXPORTER_OTLP_HEADERS to bake, and telemetry is optional everywhere.
    if (value === undefined || value === "") continue;
    out.push({ key, value, scope: "RUN_TIME", type: "SECRET" });
  }
  return out;
}

/**
 * Components that will boot without a boot key they need and with no way to get
 * it — the rendered-spec check for the failure above.
 *
 * It reads the SPEC rather than the config, because the question is structural:
 * a component either carries the store credential (so it can hydrate) or it
 * carries the value (so it does not need to). A component with neither is the
 * bug, and it is invisible until something downstream goes quiet.
 *
 * `held` is the boot keys this render actually has a value for. A key nobody
 * configured is not a gap — telemetry with no ingestor is a supported state and
 * must stay one.
 *
 * Returns human-readable messages, or an empty array. Never a value.
 */
export function bootEnvGaps(spec: AppSpec, held: readonly string[]): string[] {
  const wanted = BUNDLE_BOOT_ENV_KEYS.filter((k) => held.includes(k));
  if (wanted.length === 0) return [];

  const problems: string[] = [];
  for (const service of spec.services) {
    const keys = new Set(service.envs.map((e) => e.key));
    // Holding the STORE CREDENTIAL is the ability to hydrate: it reaches the
    // strad image and stops there, and the strad image is what runs
    // hydrateBootEnv. Named explicitly rather than asking whether the component
    // holds ANY image-only key — that set has other members now (the GlitchTip
    // DSN), and none of them says anything about reaching the store.
    if (keys.has("STRAD_PARAMS_RESOLVER_SERVICE_ACCOUNT_KEY_JSON")) continue;
    for (const key of wanted) {
      if (keys.has(key)) continue;
      problems.push(
        `component "${service.name}" is missing ${key}: it holds no store ` +
          `credential, so it cannot hydrate the value, and the spec does not ` +
          `carry it either`,
      );
    }
  }
  return problems;
}

/**
 * The identity vars every component gets, so its telemetry can say which of the
 * deployed processes it is. `STRAD_COMPONENT` is the one that matters: a
 * supplementary image has no STRAD_BUNDLE and could not otherwise name itself.
 *
 * `STRAD_VERSION` is the deployed image's TAG, which makes `service.version` in
 * the ingestor the thing that is actually running rather than whatever was in
 * the VERSION file at build time.
 */
/**
 * Tell a component which managed-parameter VARIABLES the render put on it.
 *
 * GENERAL, not SECRET: it holds names. The names are already in the store, in
 * the console, and in every fix command the console prints — what is secret is
 * the values, and none are here.
 *
 * It exists because a `params: true` server's credentials are NOT `${NAME}`
 * references. They are whatever `/strad/{env}/mcp/{slug}/static/` held when the
 * render ran, so the config does not name them and core cannot derive them. The
 * console can only answer, unaided, "this server sets `params: true` and this
 * page does not read that namespace" — a shrug about the servers most likely to
 * be misconfigured, since nothing else checks them either. With the list baked
 * on, the component's presence route (secrets/presence.ts) answers for each one
 * by name.
 *
 * Omitted entirely when no server on the component sets `params: true`, so a
 * spec diff only moves when the thing it describes does.
 */
function paramKeysEnv(paramKeys: Record<string, string[]>): EnvVar[] {
  if (Object.keys(paramKeys).length === 0) return [];
  const sorted: Record<string, string[]> = {};
  for (const slug of Object.keys(paramKeys).sort()) {
    sorted[slug] = paramKeys[slug] ?? [];
  }
  return [
    {
      key: PARAM_KEYS_ENV,
      value: JSON.stringify(sorted),
      scope: "RUN_TIME",
      type: "GENERAL",
    },
  ];
}

function identityEnvs(
  component: string,
  environment: string,
  imageTag: string,
  publicUrl?: string,
): EnvVar[] {
  const envs: EnvVar[] = [
    {
      key: "STRAD_COMPONENT",
      value: component,
      scope: "RUN_TIME",
      type: "GENERAL",
    },
    {
      key: "STRAD_ENV",
      value: environment,
      scope: "RUN_TIME",
      type: "GENERAL",
    },
    {
      key: "STRAD_VERSION",
      value: imageTag,
      scope: "RUN_TIME",
      type: "GENERAL",
    },
  ];
  if (publicUrl) {
    envs.push({
      key: "STRAD_PUBLIC_URL",
      value: publicUrl.replace(/\/$/, ""),
      scope: "RUN_TIME",
      type: "GENERAL",
    });
  }
  return envs;
}

/**
 * The `${NAME}` secret references a config uses that must be injected as
 * BROADCAST SECRET env vars — a `remote-http` server's `url`/`headers` (e.g.
 * `Authorization: "Bearer ${GRANOLA_TOKEN}"`) and a `builtin`'s `options`.
 * These resolve IN-PROCESS at boot (secrets/index.ts `resolveRefs`) inside the
 * core (and any strad-image bundle), and an unresolved `${…}` makes the gateway
 * refuse to start, so render-spec must ship each as a SECRET env var.
 *
 * A `supplementary-image`'s `env:` is deliberately EXCLUDED: those refs are
 * resolved at deploy time and SCOPED onto only their bundle (see the `secrets`
 * bag threaded into `renderAppSpec`), so broadcasting them here too would
 * un-scope a credential and double-inject it.
 *
 * We walk the PARSED config, never the raw YAML text: comments are stripped by
 * the parse and never reach `resolveRefs`, so a `${NAME}` written in a comment
 * must not be mistaken for a real reference.
 */
export function collectSecretRefs(config: StradConfig): string[] {
  const REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
  const out = new Set<string>();
  const walk = (node: unknown): void => {
    if (typeof node === "string") {
      for (const m of node.matchAll(REF)) {
        const name = m[1];
        if (name) out.add(name);
      }
    } else if (Array.isArray(node)) {
      node.forEach(walk);
    } else if (node && typeof node === "object") {
      Object.values(node).forEach(walk);
    }
  };
  for (const server of config.servers) {
    if (!server.enabled) continue;
    // supplementary-image env is scoped per-bundle, not broadcast — skip it.
    if (server.kind === "supplementary-image") continue;
    walk(server);
  }
  return [...out];
}

/** Same registry and repository, ignoring the tag. */
export function sameRepository(a: ImageRef, b: ImageRef): boolean {
  return (
    a.registry_type === b.registry_type &&
    (a.registry ?? "") === (b.registry ?? "") &&
    a.repository === b.repository
  );
}

/**
 * Merge `next` into `prev` without overwriting a key `prev` already holds, and
 * without disturbing the order `prev` holds them in. New keys append.
 */
function firstWins(
  prev: Record<string, string> | undefined,
  next: Record<string, string>,
): Record<string, string> {
  const merged: Record<string, string> = { ...(prev ?? {}) };
  for (const [key, value] of Object.entries(next)) merged[key] ??= value;
  return merged;
}

export function renderAppSpec(opts: RenderOptions): AppSpec {
  const { config } = opts;

  const override = opts.supplementaryImage
    ? parseImage(opts.supplementaryImage)
    : undefined;
  // `parseImage` defaults a tag-less ref to `latest`, so an override of
  // "ghcr.io/tadasant/strad-bundle" would match, apply, and deploy `:latest`
  // while reading as a branch override. Refuse the whole shape.
  if (override && override.tag === "latest") {
    throw new Error(
      `supplementaryImage "${opts.supplementaryImage}" resolves to the tag "latest". ` +
        `Pass an explicit branch-scoped tag — overriding to :latest is what this flag exists to avoid.`,
    );
  }
  let overrideApplied = false;

  // Which bundles actually need a container? A supplementary bundle resolves to
  // one image plus the union of its servers' env maps.
  const imageBundles = new Map<
    string,
    {
      image: string;
      /**
       * `env:` maps, ALREADY resolved — per server, against that server's own
       * bag layered over the shared one. Resolution happens before the merge
       * rather than after it, because after the merge there is no server left to
       * ask which namespace a value should come from.
       */
      env: Record<string, string>;
      /** Resolved managed parameters — ALREADY literal, so NOT ref-resolved. */
      params: Record<string, string>;
      /** `slug -> VARIABLE[]` for the `params: true` servers on this component. */
      paramKeys: Record<string, string[]>;
    }
  >();
  const builtinBundles = new Set<string>();
  /** bundle -> variable -> the slugs that contribute it. See the check below. */
  const paramOwners = new Map<string, Map<string, Set<string>>>();
  /** bundle -> every variable on it that came from a PARAMETER. */
  const paramKeys = new Map<string, Set<string>>();
  /**
   * bundle -> key -> every server that resolved it, in declaration order.
   *
   * The FIRST entry owns the bare name; the rest are compared against it and
   * against each other. All of them, not just the first — see the same-path
   * check below for why a running comparison against one owner is not enough.
   */
  const envValueOwners = new Map<
    string,
    Map<string, { slug: string; path: string; value: string }[]>
  >();
  /**
   * Every (server, variable) that resolved to something other than the value the
   * bare name carries. Validated and turned into per-slug names after the whole
   * server list has been walked — see the loop below.
   */
  const dissenters: {
    bundle: string;
    slug: string;
    path: string;
    key: string;
    value: string;
    /** The server that declared this key first, and therefore owns the bare name. */
    bareOwner: string;
  }[] = [];

  for (const server of config.servers) {
    if (!server.enabled) continue;
    if (server.kind === "remote-http") continue; // no container: it's someone else's

    if (server.kind === "supplementary-image") {
      // Several supplementary servers may share one bundle image (bundle-api
      // hosts a fleet from a single image, each on its own path). The schema
      // guarantees they share the SAME image; the component's env is the union
      // of every such server's `env:` map, so all of them get their secrets on
      // the one component.
      // A `params: true` server's resolved managed parameters are kept SEPARATE
      // from `env:`. They are already literal values (dereferenced by the resolver
      // at deploy time), so they must NOT go through resolveMap below: a resolved
      // value that happened to contain `${NAME}` would otherwise be treated as an
      // unresolved ref and either fail the render or be silently corrupted.
      const params = opts.resolvedParams?.[server.slug] ?? {};
      const prev = imageBundles.get(server.bundle);

      // Resolve THIS SERVER'S `${NAME}` refs, against its own namespace layered
      // over the shared one. resolveMap throws on an unresolved ref — a
      // supplementary image that silently shipped the literal
      // "${GOODEGGS_PASSWORD}" would fail its login in a confusing way.
      const own = opts.serverSecrets?.[server.slug];
      const resolvedEnv = resolveMap(
        server.env,
        own ? { ...(opts.secrets ?? {}), ...own } : (opts.secrets ?? {}),
      );

      // TWO MOUNTS ON ONE BUNDLE CANNOT SHARE ONE BARE NAME.
      //
      // A bundle is a component is a container is one `process.env`. The config
      // schema already refuses two servers declaring the same key with different
      // REF STRINGS on one bundle; per-server namespaces add the case it cannot
      // see, because the strings are identical and the VALUES differ — the exact
      // shape of `telegram-ro` and `telegram-rw` both writing
      // `${TELEGRAM_API_HASH}` and each being seeded its own.
      //
      // THE BARE NAME BELONGS TO THE FIRST SERVER THAT DECLARED IT, and is never
      // taken away. Dropping it was the obvious move and it is wrong: the drop is
      // bundle-wide while the disagreement is between two servers, so a THIRD
      // server that never disagreed with anyone loses a variable it reads —
      // silently, if its tree is one of the eight that read `process.env`
      // directly. Adding a slug would then break slugs that already worked, and
      // turn a render-time error into a runtime outage. So nothing is ever
      // deleted here: a DISSENTER — a server whose value differs from the bare
      // one — gets `<SLUG>__<NAME>` of its own, and every existing name on the
      // component keeps meaning what it meant.
      //
      // `path:` is what separates an error from an alias, because it is what
      // decides whether there are two SERVERS or two names for one. Two slugs on
      // one path are ONE mount in the bundle host, serving both from one process
      // with one set of credentials — there is nowhere for a second value to go,
      // whatever it is called. Two slugs on different paths are two instances,
      // and each can read its own name.
      const valueOwners =
        envValueOwners.get(server.bundle) ??
        new Map<string, { slug: string; path: string; value: string }[]>();
      for (const [key, value] of Object.entries(resolvedEnv)) {
        const owners = valueOwners.get(key) ?? [];
        valueOwners.set(key, owners);
        owners.push({ slug: server.slug, path: server.path, value });
        // The first declaration IS the bare name. Nothing to compare it to.
        if (owners.length === 1) continue;

        // Compared against EVERY prior owner on this path, not just the first —
        // a same-path pair that happens to be declared second and third is the
        // same one mount with two credentials, and comparing only against the
        // first owner would let config order decide whether it is caught.
        const clash = owners
          .slice(0, -1)
          .find((o) => o.path === server.path && o.value !== value);
        if (clash) {
          throw new Error(
            `bundle "${server.bundle}": servers "${clash.slug}" and ` +
              `"${server.slug}" both set ${key} under env:, both serve ` +
              `path "${server.path}", and the two resolve to DIFFERENT ` +
              `values — one of them comes from a per-server namespace ` +
              `(/strad/${config.gateway.env}/mcp/{slug}/static/). One path on ` +
              `one bundle is ONE mount in the container, so one value would ` +
              `silently overwrite the other. Give the two servers separate ` +
              `paths (the bundle host then runs one instance per slug, each ` +
              `reading its own ${slugEnvPrefix(server.slug) ?? "SLUG"}__${key}), ` +
              `separate bundles, or seed them the same value.`,
          );
        }

        // Agrees with the bare name: reads it, exactly as it always did.
        if (value === owners[0]!.value) continue;

        // A DISSENTER. What it needs to be given a name of its own is checked
        // AFTER the whole server list, not here: a same-path clash is the more
        // fundamental error and the more useful message, and a running loop
        // cannot see a clash whose other half has not been declared yet.
        dissenters.push({
          bundle: server.bundle,
          slug: server.slug,
          path: server.path,
          key,
          value,
          bareOwner: owners[0]!.slug,
        });
      }
      envValueOwners.set(server.bundle, valueOwners);

      // Who contributed which variable, so the collision check below can tell a
      // server overriding ITSELF from one server clobbering another. Order-free
      // on purpose: it is a post-pass, not a running comparison, because a
      // `params: true` server may be declared either side of the server it would
      // shadow.
      const owners = paramOwners.get(server.bundle) ?? new Map();
      for (const key of Object.keys(server.env)) {
        (owners.get(key) ?? owners.set(key, new Set()).get(key)!).add(
          server.slug,
        );
      }
      for (const key of Object.keys(params)) {
        (owners.get(key) ?? owners.set(key, new Set()).get(key)!).add(
          server.slug,
        );
        (
          paramKeys.get(server.bundle) ??
          paramKeys.set(server.bundle, new Set()).get(server.bundle)!
        ).add(key);
      }
      paramOwners.set(server.bundle, owners);

      imageBundles.set(server.bundle, {
        image: server.image,
        // FIRST writer wins, which is what makes "the bare name belongs to the
        // first server that declared it" true of the emitted spec and not just
        // of the check above. It changes nothing for a config that predates
        // per-slug names: two servers could only ever reach here holding the
        // same value for a key, and the disagreeing case threw. Key ORDER stays
        // first-seen — a spread the other way round would rewrite the whole
        // env array's order on a config where no value moved at all.
        env: firstWins(prev?.env, resolvedEnv),
        params: { ...(prev?.params ?? {}), ...params },
        // Which VARIABLES each `params: true` server contributed, by slug. Names
        // only — see paramKeysEnv() for why the component needs to be told.
        paramKeys: server.params
          ? {
              ...(prev?.paramKeys ?? {}),
              [server.slug]: Object.keys(params).sort(),
            }
          : (prev?.paramKeys ?? {}),
      });
    } else if (server.bundle !== "core") {
      builtinBundles.add(server.bundle);
    }
  }

  // WHAT A DISSENTER NEEDS BEFORE IT CAN BE GIVEN A NAME OF ITS OWN.
  //
  // Both of these are refusals rather than warnings, because both produce a
  // credential that is ON the container and reaches NO server — indistinguishable
  // from a seeding mistake, and diagnosable only by reading a rendered spec.
  const emittedAliases = new Map<string, Record<string, string>>();
  for (const d of dissenters) {
    const alias = prefixedEnvName(d.slug, d.key);
    if (alias === null) {
      throw new Error(
        `bundle "${d.bundle}": server "${d.slug}" resolves ${d.key} to a ` +
          `different value than "${d.bareOwner}" does, so it needs a per-slug ` +
          `variable name — and its slug does not mangle to a usable one (a ` +
          `variable name cannot start with a digit). Rename the slug, give it ` +
          `its own bundle, or seed it the same value.`,
      );
    }
    // The bundle host mounts a per-slug instance at `/<slug>`, because it never
    // sees this config. A dissenter routed anywhere else reads whatever that
    // other mount was given — which is the FIRST declarant's credential, so the
    // symptom is a working server acting as the wrong account.
    if (d.path !== `/${d.slug}`) {
      throw new Error(
        `bundle "${d.bundle}": server "${d.slug}" resolves ${d.key} to a ` +
          `different value than "${d.bareOwner}" does, so the bundle host has to ` +
          `run it as its OWN instance — which it mounts at "/${d.slug}", because ` +
          `it never sees this config. This server is configured with path ` +
          `"${d.path}", so it would route to a different mount and read the ` +
          `other server's credential. Set path: /${d.slug}, or seed the two the ` +
          `same value.`,
      );
    }
    const emitted = emittedAliases.get(d.bundle) ?? {};
    emitted[alias] = d.value;
    emittedAliases.set(d.bundle, emitted);
  }

  // A PER-SLUG NAME MAY NOT LAND ON A NAME SOMETHING ELSE ALREADY OWNS.
  //
  // Contrived but not impossible: a server declaring a variable literally called
  // `A__B` collides with slug `a`'s alias for `B`. The alias is generated rather
  // than written down, so nobody would see it in the config — hence a check here
  // rather than a note in the docs. Same value is not a collision, and because
  // nothing is ever deleted above, this sees every name the component holds.
  for (const [bundle, emitted] of emittedAliases) {
    const entry = imageBundles.get(bundle);
    if (!entry) continue;
    for (const [key, value] of Object.entries(emitted)) {
      const claimed = entry.env[key] ?? entry.params[key];
      if (claimed === undefined || claimed === value) continue;
      throw new Error(
        `bundle "${bundle}": the per-slug name ${key} collides with a variable ` +
          `of the same name that another server on this bundle already sets to a ` +
          `different value. Rename that variable.`,
      );
    }
  }

  // Said once, per bundle, naming slugs and variables and never a value. The
  // operator needs it because the per-slug name is GENERATED — it appears in no
  // config file, and it is what a seeding question ("is the credential on the
  // box?") has to be asked about from here on.
  for (const bundle of new Set(dissenters.map((d) => d.bundle))) {
    const mine = dissenters.filter((d) => d.bundle === bundle);
    opts.onWarning?.(
      `bundle "${bundle}": ${mine.length} variable(s) resolve to a value other ` +
        `than the one the bare name carries, so they are ALSO emitted under a ` +
        `per-slug name — ${mine
          .map(
            (d) => `${prefixedEnvName(d.slug, d.key)} (${d.slug}'s ${d.key})`,
          )
          .sort()
          .join(
            ", ",
          )}. The bare name(s) still carry the first-declared value ` +
        `and every other server on this bundle reads them unchanged. Only a ` +
        `server whose image reads an injected environment (telegram, ` +
        `remote-filesystem) can see a per-slug name.`,
    );
  }

  // A PARAMETER MAY NOT SHADOW ANOTHER SERVER'S VARIABLE ON THE SAME BUNDLE.
  //
  // `env:` and `params` are collected separately above but they are emitted into
  // ONE component environment, params last — so a parameter whose variable name
  // collides with a sibling's silently wins. That matters more than an ordinary
  // config collision because it is reachable by a HUMAN action rather than only
  // by a config edit: the console creates parameters, and a parameter's PATH
  // decides its variable name. A parameter named `SECRETS_PROJECT_ID` created
  // under some other slug's namespace would repoint the `secrets` server's whole
  // store at the next render, with nothing reporting it.
  //
  // The config schema cannot catch this — a parameter's NAME comes from a path in
  // the store and its VALUE does not exist until render time. The `superRefine` in
  // src/config/schema.ts covers the static `env:`-vs-`env:` half; this covers the
  // half that only exists here.
  //
  // What is NOT an error: a server shadowing its OWN `env:` key with its OWN
  // parameter. That is the documented migration path off a hand-written `${REF}`,
  // and it stays a deliberate single-server override.
  for (const [bundle, owners] of paramOwners) {
    for (const [key, slugs] of owners) {
      if (slugs.size < 2) continue;
      if (!paramKeys.get(bundle)?.has(key)) continue;
      throw new Error(
        `bundle "${bundle}": ${key} is contributed by more than one server ` +
          `(${[...slugs].sort().join(", ")}) and at least one of them resolves it ` +
          `as a managed parameter. One bundle is one container with one ` +
          `environment, so the parameter would silently overwrite the other ` +
          `server's value. Rename the parameter, or give the server its own bundle.`,
      );
    }
  }

  const bundleNames = [...imageBundles.keys(), ...builtinBundles].sort();

  // The core gets a private URL for every bundle it must reach. App Platform
  // substitutes ${bundle.PRIVATE_URL} at deploy time.
  const bundleUrlEnvs: EnvVar[] = bundleNames.map((name) => ({
    key: bundleUrlEnvName(name),
    value: `\${${name}.PRIVATE_URL}`,
    scope: "RUN_TIME",
    type: "GENERAL",
  }));

  const services: ServiceSpec[] = [
    {
      name: "core",
      image: opts.image,
      instance_size_slug: opts.coreInstanceSizeSlug ?? "apps-s-1vcpu-1gb",
      instance_count: 1,
      // The ONE public component. http_port is what mints the public route.
      http_port: PORT,
      envs: [
        {
          key: "STRAD_MODE",
          value: "core",
          scope: "RUN_TIME",
          type: "GENERAL",
        },
        {
          key: "NODE_ENV",
          value: "production",
          scope: "RUN_TIME",
          type: "GENERAL",
        },
        ...identityEnvs(
          "core",
          config.gateway.env,
          opts.image.tag,
          config.gateway.publicUrl,
        ),
        ...bundleUrlEnvs,
        ...opts.env,
        // Core-only credentials. Deliberately NOT part of opts.env, which is
        // broadcast — see consoleEnvVars().
        ...consoleEnvVars(config, opts.secrets ?? {}),
      ],
      health_check: { http_path: "/healthz", initial_delay_seconds: 10 },
    },
  ];

  /**
   * A supplementary component's environment, in one place, so the boot keys can
   * be appended only where the component has not already claimed the name.
   */
  const supplementaryEnvs = (
    name: string,
    supplementary: NonNullable<ReturnType<typeof imageBundles.get>>,
    componentImage: ImageRef,
  ): EnvVar[] => {
    const envs: EnvVar[] = [
      // Already resolved, per server, above — the credential lands ONLY on this
      // bundle either way, and resolving there is what lets each server draw on
      // its own namespace first.
      ...Object.entries(supplementary.env).map(([key, value]): EnvVar => ({
        key,
        value,
        scope: "RUN_TIME",
        type: "SECRET",
      })),
      // Per-slug names, for the contested variables only — the bare name they
      // replace was deleted above. Empty for every bundle where no two mounts
      // disagreed, which is every bundle in every deployment today.
      ...Object.entries(emittedAliases.get(name) ?? {}).map(
        ([key, value]): EnvVar => ({
          key,
          value,
          scope: "RUN_TIME",
          type: "SECRET",
        }),
      ),
      // Resolved managed parameters are already literal — emit them as
      // SECRET env vars directly, WITHOUT resolveMap, so a value containing
      // `${…}` cannot be mistaken for an unresolved ref.
      ...Object.entries(supplementary.params).map(([key, value]): EnvVar => ({
        key,
        value,
        scope: "RUN_TIME",
        type: "SECRET",
      })),
      ...identityEnvs(
        name,
        config.gateway.env,
        componentImage.tag,
        config.gateway.publicUrl,
      ),
      ...paramKeysEnv(supplementary.paramKeys),
      ...opts.env.filter(
        (e) =>
          !STRAD_IMAGE_ONLY_SECRET_KEYS.has(e.key) &&
          (e.type === "SECRET" || TELEMETRY_ENV_KEYS.has(e.key)),
      ),
    ];
    // LAST, and only for names nothing above claimed. Under the `env` provider
    // these arrive in the broadcast just above and this adds nothing; under the
    // store provider the broadcast does not carry them and this is the only
    // thing that can.
    envs.push(
      ...bundleBootEnvVars(
        opts.bootSecrets ?? {},
        new Set(envs.map((e) => e.key)),
      ),
    );
    return envs;
  };

  for (const name of bundleNames) {
    const declared = config.bundles.find((b) => b.name === name);
    const supplementary = imageBundles.get(name);
    let componentImage = supplementary
      ? parseImage(supplementary.image)
      : opts.image;
    if (supplementary && override && sameRepository(componentImage, override)) {
      componentImage = override;
      overrideApplied = true;
    }

    services.push({
      name,
      image: componentImage, // a builtin bundle runs the strad image in bundle mode
      instance_size_slug:
        declared?.instanceSizeSlug ??
        // Chromium peaks around 545MB RSS. 1GB is the floor for a browser
        // bundle; CPU, not RAM, is what actually binds (1 vCPU serialises it).
        "apps-s-1vcpu-1gb",
      instance_count: declared?.instanceCount ?? 1,
      // Internal-only: internal_ports, and NO http_port. Both is an API error.
      internal_ports: [PORT],
      envs: supplementary
        ? supplementaryEnvs(name, supplementary, componentImage)
        : [
            {
              key: "STRAD_MODE",
              value: "bundle",
              scope: "RUN_TIME",
              type: "GENERAL",
            },
            {
              key: "STRAD_BUNDLE",
              value: name,
              scope: "RUN_TIME",
              type: "GENERAL",
            },
            {
              key: "NODE_ENV",
              value: "production",
              scope: "RUN_TIME",
              type: "GENERAL",
            },
            ...identityEnvs(
              name,
              config.gateway.env,
              componentImage.tag,
              config.gateway.publicUrl,
            ),
            ...opts.env,
          ],
    });
  }

  if (override && !overrideApplied) {
    throw new Error(
      `supplementaryImage "${opts.supplementaryImage}" matched no supplementary server in the config. ` +
        `Check the registry and repository — only the tag is meant to differ.`,
    );
  }

  const spec: AppSpec = {
    name: opts.appName,
    region: opts.region,
    services,
  };

  if (opts.domains?.length) spec.domains = opts.domains;
  return spec;
}

/** ghcr.io/tadasant/strad-server-good-eggs:latest -> an App Platform ImageRef */
export function parseImage(ref: string): ImageRef {
  const [pathPart, tag = "latest"] = splitTag(ref);
  const segments = pathPart.split("/");
  const host = segments[0] ?? "";

  if (host === "ghcr.io") {
    const [, owner, ...rest] = segments;
    return {
      registry_type: "GHCR",
      registry: owner ?? "",
      repository: rest.join("/"),
      tag,
    };
  }
  if (host === "registry.digitalocean.com") {
    const [, , ...rest] = segments;
    return { registry_type: "DOCR", repository: rest.join("/"), tag };
  }
  // Bare `owner/name` -> Docker Hub.
  return {
    registry_type: "DOCKER_HUB",
    registry: segments.length > 1 ? segments[0] : "library",
    repository: segments.slice(1).join("/") || pathPart,
    tag,
  };
}

function splitTag(ref: string): [string, string?] {
  const i = ref.lastIndexOf(":");
  // A colon before the last "/" is a port, not a tag.
  if (i === -1 || ref.indexOf("/", i) !== -1) return [ref, undefined];
  return [ref.slice(0, i), ref.slice(i + 1)];
}
