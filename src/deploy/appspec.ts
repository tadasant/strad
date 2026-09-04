import { isUnhosted } from "../config/schema.ts";
import type { ServerConfig, StradConfig } from "../config/schema.ts";
import { connectorVariables } from "./server-namespaces.ts";
import { bundleUrlEnvName } from "../gateway/registry.ts";
import { prefixedEnvName, slugEnvPrefix } from "../secrets/env-prefix.ts";
import { resolveMap } from "../secrets/index.ts";
import { refsIn } from "../secrets/provider/resolve.ts";
import { PARAM_KEYS_ENV } from "../secrets/presence.ts";
import {
  PARAM_REFRESH_ENV,
  PARAM_REFRESH_SECONDS_ENV,
} from "../secrets/param-route.ts";
import { BUNDLE_BOOT_ENV_KEYS } from "../secrets/provider/hydrate.ts";
import { CORE_URL_ENV } from "../secrets/param-route.ts";

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
   * src/deploy/server-namespaces.ts for the layering, and the path-group pass
   * below for where a second value can then LAND (a slug that is the only one on
   * `path: /<its own slug>` gets variables of its own; anything else shares the
   * bare name, and two of those needing different values is a hard error).
   *
   * A slug present here at all — even with a value identical to its neighbour's —
   * is what turns per-slug names on for it. See that pass for why the trigger is
   * the namespace existing rather than the values differing.
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
   * `${NAME}`s that resolve to nothing AND that every referencing server
   * declared `mayBeUnseeded:` for. An `env:`/`consoleEnv:` entry mentioning one
   * is DROPPED rather than resolved, so the component ships without the variable.
   *
   * Necessary because `resolveMap` throws on an unresolved ref — which is right
   * for a name nobody deferred, and wrong for one a human did: the throw would
   * take the whole render down and reinstate exactly the fleet-wide failure
   * `mayBeUnseeded:` exists to remove. See src/deploy/unseeded.ts.
   *
   * Dropping rather than substituting an empty string is the point: an empty
   * `Authorization` header is a credential the container would try to use, and
   * the server's own "is this variable set" check is the thing that should fire.
   */
  unseededRefs?: ReadonlySet<string>;
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
  unseeded: ReadonlySet<string>,
): EnvVar[] {
  const merged: Record<string, string> = {};
  for (const server of config.servers) {
    if (!server.enabled) continue;
    if (server.kind !== "supplementary-image") continue;
    for (const [key, value] of Object.entries(server.consoleEnv)) {
      // A deferred credential is omitted, not resolved. `resolveMap` throws on
      // an unresolved ref, and here that throw would fail the whole render.
      if (refsIn(value).some((name) => unseeded.has(name))) continue;
      merged[key] = value;
    }
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
 * `SECRETS_STORES` — the `mcpStores:` list, as the secrets tree reads it back.
 *
 * NO CREDENTIAL TRAVELS IN HERE. Each entry carries a project id, its
 * namespaces, an optional label, and the NAME of the `env:` key holding that
 * store's viewer credential; the key itself is an ordinary `env:` ref resolved a
 * few lines above. That split is the whole design — the descriptor is safe to
 * read in a rendered app spec, in `doctl apps spec get`, and in a deploy diff,
 * where it shows exactly which store gained or lost a namespace. A rendered blob
 * containing service-account keys would be none of those things.
 *
 * Absent for every server that declares no `mcpStores:`, which leaves the
 * single-store `SECRETS_PROJECT_ID` reading in place untouched.
 */
function mcpStoresEnv(
  server: Extract<ServerConfig, { kind: "supplementary-image" }>,
): Record<string, string> {
  if (server.mcpStores.length === 0) return {};
  return {
    SECRETS_STORES: JSON.stringify(
      server.mcpStores.map((store) => ({
        project: store.project,
        ...(store.label ? { label: store.label } : {}),
        namespaces: store.namespaces,
        viewerKeyVar: store.viewerKeyVar,
      })),
    ),
  };
}

/**
 * `mcpStores:` entries whose project no console page fronts. See the call site.
 *
 * The console resolves its stores from `consoleStores:` when it has one, and
 * otherwise from a single `SECRETS_PROJECT_ID`, which it reads out of `env:`
 * merged with `consoleEnv:` (src/ui/resolve.ts). Only `consoleEnv:` is read
 * here: a server declaring `mcpStores:` may not also carry that name under
 * `env:`, so the `env:` half is unreachable on exactly the servers this walks.
 * A `${REF}` is not read at all — a project id written as a ref is not a project
 * id this can compare.
 */
function storesWithNoConsole(config: StradConfig): string[] {
  const messages: string[] = [];
  for (const server of config.servers) {
    if (!server.enabled) continue;
    if (server.kind !== "supplementary-image") continue;
    if (server.mcpStores.length === 0) continue;

    const visible = new Set<string>(
      server.consoleStores.map((store) => store.project),
    );
    if (visible.size === 0) {
      const fallback = server.consoleEnv.SECRETS_PROJECT_ID;
      if (fallback && refsIn(fallback).length === 0) visible.add(fallback);
    }

    const blind = server.mcpStores
      .map((store) => store.project)
      .filter((project) => !visible.has(project));
    if (blind.length === 0) continue;

    messages.push(
      `server "${server.slug}": mcpStores: names ${blind.map((p) => `"${p}"`).join(", ")}, ` +
        `which no console page fronts. An agent can create, rotate and delete ` +
        `parameters there; a human cannot see or undo them in /ui. Add a matching ` +
        `consoleStores: entry (with its own admin credential), or leave it if the ` +
        `store is deliberately agent-only.`,
    );
  }
  return messages;
}

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

/**
 * Tell a component which of its managed parameters it may RE-READ at runtime,
 * and how often.
 *
 * GENERAL, like `STRAD_PARAM_KEYS` above and for the same reason: it holds
 * variable names, and every one of them is already in the store, in the console
 * and in the spec beside it. What is secret is the values.
 *
 * The container needs telling because it never sees strad's config — it knows
 * the server list only through the variables this renderer bakes on. Handing it
 * the NAMES here rather than letting it ask core is also what keeps the refresh
 * from inventing variables: the set is fixed by the render, so a parameter
 * created afterwards needs a deploy, and only the VALUE of an
 * already-deployed name can move under a running process.
 *
 * Omitted entirely when no server on the component sets `paramsRefresh:`, which
 * is every deployment by default — so a spec diff only moves when the thing it
 * describes does.
 */
function paramRefreshEnvs(
  refresh: Record<string, string[]>,
  intervalSeconds: number,
): EnvVar[] {
  if (Object.keys(refresh).length === 0) return [];
  const sorted: Record<string, string[]> = {};
  for (const slug of Object.keys(refresh).sort()) {
    sorted[slug] = [...(refresh[slug] ?? [])].sort();
  }
  return [
    {
      key: PARAM_REFRESH_ENV,
      value: JSON.stringify(sorted),
      scope: "RUN_TIME",
      type: "GENERAL",
    },
    {
      key: PARAM_REFRESH_SECONDS_ENV,
      value: String(intervalSeconds),
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

/**
 * The connector variables this server's own namespace actually holds.
 *
 * Absent values are simply absent — see the note at the call site. Reads only
 * `serverSecrets[slug]`, which render-spec populates from
 * `/strad/{env}/mcp/{slug}/static/` and from nowhere else, so a client id seeded
 * at the gateway cannot land here.
 */
function connectorEnv(
  server: ServerConfig,
  own: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!own) return out;
  for (const name of connectorVariables(server)) {
    const value = own[name];
    if (value !== undefined && value !== "") out[name] = value;
  }
  return out;
}

const EMPTY_REFS: ReadonlySet<string> = new Set<string>();

export function renderAppSpec(opts: RenderOptions): AppSpec {
  const { config } = opts;
  const unseeded = opts.unseededRefs ?? EMPTY_REFS;

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
      /** `slug -> VARIABLE[]` for the servers that set `paramsRefresh:`. */
      paramRefresh: Record<string, string[]>;
    }
  >();
  const builtinBundles = new Set<string>();
  /** bundle -> variable -> the slugs that contribute it. See the check below. */
  const paramOwners = new Map<string, Map<string, Set<string>>>();
  /** bundle -> every variable on it that came from a PARAMETER. */
  const paramKeys = new Map<string, Set<string>>();
  /**
   * bundle -> every supplementary server on it, in declaration order, with its
   * `env:` ALREADY resolved.
   *
   * Everything about per-slug names is decided from this AFTER the walk, never
   * during it. Who owns the bare name, which slug is a mount of its own, whether
   * two slugs share a path — each is a property of the SET of servers on a
   * bundle, and a running comparison answers them differently depending on the
   * order a config happens to declare its servers in. That went wrong twice.
   */
  const perServerEnv = new Map<
    string,
    {
      slug: string;
      path: string;
      env: Record<string, string>;
      /**
       * The keys that came from `oauth:` rather than from `env:`.
       *
       * They are emitted under this slug's PER-SLUG name and never under the
       * bare one — see the bare-name loop below for why that is the difference
       * between a credential and a credential swap.
       */
      connectorKeys: Set<string>;
    }[]
  >();

  for (const server of config.servers) {
    if (!server.enabled) continue;
    // No container of ours: a third party's server, or the operator's own
    // machine behind a tunnel. Either way there is nothing here to deploy.
    if (isUnhosted(server)) continue;

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
      const injected = connectorEnv(server, own);
      // A DEFERRED CREDENTIAL IS DROPPED, NOT RESOLVED.
      //
      // `resolveMap` throws on an unresolved ref, and that throw fails the WHOLE
      // render — which is right for a name nobody deferred and is precisely the
      // fleet-wide failure `mayBeUnseeded:` exists to remove. A waived name is
      // therefore taken out before resolution, so this component ships without
      // the variable and every other component renders normally.
      const declaredEnv = Object.fromEntries(
        Object.entries(server.env).filter(
          ([, value]) =>
            !refsIn(value).some(
              (name) => unseeded.has(name) && own?.[name] === undefined,
            ),
        ),
      );
      const declared = {
        ...resolveMap(
          declaredEnv,
          own ? { ...(opts.secrets ?? {}), ...own } : (opts.secrets ?? {}),
        ),
        // The multi-store descriptor, DERIVED and never written by hand. It is
        // treated as part of this server's declared env — so it takes the same
        // bare and per-slug names, and collides the same way — because that is
        // exactly what it is: one more non-secret variable the container reads.
        ...mcpStoresEnv(server),
      };
      const resolvedEnv = {
        // A CONNECTOR'S VARIABLES ARE INJECTED, AND ONLY WHERE THEY EXIST.
        //
        // `oauth:` names three variables in this server's own namespace, and
        // none of them is a `${NAME}` — the config gate refuses one written by
        // hand. That is deliberate and it is the deploy-ordering answer: the
        // refresh token does not exist until a human completes the console
        // consent flow, and `resolveMap` (below) throws on an unresolved ref,
        // which would fail the WHOLE render and take every other server's deploy
        // down with it. Injecting what the store holds means an unconnected slug
        // deploys with two variables and no third — it mounts, lists its tools
        // and reports itself degraded, which is the state its server is built to
        // survive.
        //
        // FIRST, so an explicit `env:` entry for the same name still wins: the
        // config is what a human wrote, and the injection is a convenience over
        // it.
        ...injected,
        ...declared,
      };

      // Recorded now, decided after the whole list. See `perServerEnv`.
      const contributions = perServerEnv.get(server.bundle) ?? [];
      contributions.push({
        slug: server.slug,
        path: server.path,
        env: resolvedEnv,
        // A key the config ALSO declares under `env:` is that server's own
        // declaration and keeps the bare name; only the injected ones are
        // alias-only.
        connectorKeys: new Set(
          Object.keys(injected).filter((k) => !(k in server.env)),
        ),
      });
      perServerEnv.set(server.bundle, contributions);

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
      // DECLARED `paramsRefresh:` NAMES COUNT HERE TOO, seeded or not.
      //
      // The loop above registers what the render RESOLVED, and for an ordinary
      // `params: true` server that is the whole story — a name with no value
      // reaches no container. A refreshable name is different: it is a name this
      // component may acquire LATER, when somebody seeds it, and the refresh
      // writes it under the same bare name the renderer would have. So a
      // collision that this check would have caught at render time for a seeded
      // parameter must not become invisible merely because the value is not in
      // the store yet — that is the one shape where a sibling's credential could
      // be overwritten by a human action taken long after the deploy, with
      // nothing reporting it.
      for (const key of [...Object.keys(params), ...server.paramsRefresh]) {
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
        // DECLARED ONLY — never `resolvedEnv`. This map becomes the component's
        // BARE-named environment, and a connector's variables must not be in it:
        // the bundle host falls back to a bare name for any slug that has no
        // per-slug one, so a connector credential here is a credential every
        // sibling on the bundle silently inherits. See the bare-name loop below.
        env: firstWins(prev?.env, declared),
        params: { ...(prev?.params ?? {}), ...params },
        // Which VARIABLES each `params: true` server contributed, by slug. Names
        // only — see paramKeysEnv() for why the component needs to be told.
        paramKeys: server.params
          ? {
              ...(prev?.paramKeys ?? {}),
              [server.slug]: Object.keys(params).sort(),
            }
          : (prev?.paramKeys ?? {}),
        // From the CONFIG, not from `params` — a name a human listed but has not
        // seeded yet has no resolved value to bake, and it is exactly the name a
        // refresh should pick up when they do seed it. Reading this off the
        // store's contents instead would make "seed it after the deploy" go on
        // needing a redeploy, which is half of what this feature is for.
        paramRefresh:
          server.paramsRefresh.length > 0
            ? {
                ...(prev?.paramRefresh ?? {}),
                [server.slug]: [...server.paramsRefresh],
              }
            : (prev?.paramRefresh ?? {}),
      });
    } else if (server.bundle !== "core") {
      builtinBundles.add(server.bundle);
    }
  }

  // ==========================================================================
  // EVERY SUPPLEMENTARY VARIABLE GETS A PER-SLUG NAME. NO CONDITION.
  // ==========================================================================
  //
  // A bundle is a component is a container is one `process.env`, so two servers
  // that both write `${TELEGRAM_API_HASH}` and resolve it differently need two
  // names. The obvious move is to mint the second name only where it is needed,
  // and that is what this did first — and it is wrong, for a reason that is
  // nothing to do with correctness: you could not look at a server and know what
  // its variables are called on the box. The answer depended on what some OTHER
  // slug happened to have been seeded, which is unreadable and unpredictable.
  //
  // So the rule is flat and mechanical. Every enabled `supplementary-image`
  // server's resolved `env:` is emitted TWICE onto its bundle: once under the
  // bare name it always had, and once under `<SLUG>__<NAME>` — the slug
  // uppercased, `-` to `_`, joined with `__`. Given a config you can compute the
  // whole set by hand, per server, with no reference to any other server.
  //
  // NOTHING IS REMOVED. The bare names keep their values and every tree in the
  // image that reads `process.env` directly goes on reading them, so this is
  // additive to a running deployment and does not care which image is deployed
  // first.
  //
  // WHAT REMAINS CONDITIONAL IS READING, NOT NAMING, and it is a property of the
  // config you can check by eye: the bundle host serves ONE INSTANCE PER PATH, so
  // a slug can only be handed its own names if it is the only slug on its path
  // and that path is `/<its own slug>`. Capability variants sharing `/gmail` are
  // one process; they are named here like everything else, and they read the bare
  // names. That is why two servers on ONE path with different values still throw:
  // one process, one credential, nothing to do with naming.
  const emittedAliases = new Map<string, Record<string, string>>();
  /** Slugs whose name cannot be mangled — reported once, at the end. */
  const unnameable = new Map<string, Set<string>>();

  for (const [bundle, contributions] of perServerEnv) {
    /** path -> the slugs serving it, in declaration order. */
    const groupSlugs = new Map<string, string[]>();
    for (const c of contributions) {
      (groupSlugs.get(c.path) ?? groupSlugs.set(c.path, []).get(c.path)!).push(
        c.slug,
      );
    }
    /** The slug the host can serve as its own instance, for this path. */
    const ownInstance = (path: string): string | null => {
      const slugs = groupSlugs.get(path) ?? [];
      if (slugs.length !== 1) return null;
      const slug = slugs[0]!;
      if (path !== `/${slug}`) return null;
      return slugEnvPrefix(slug) === null ? null : slug;
    };

    // --- one value per path, or throw ---------------------------------------
    //
    // One path is one upstream process holding one set of credentials. A second
    // value has nowhere to go there, whatever it is called.
    /** path -> key -> value, plus the slug that put it there. */
    const byPath = new Map<
      string,
      Map<string, { slug: string; value: string }>
    >();
    for (const c of contributions) {
      const held = byPath.get(c.path) ?? new Map();
      byPath.set(c.path, held);
      for (const [key, value] of Object.entries(c.env)) {
        const prior = held.get(key);
        if (prior && prior.value !== value) {
          throw new Error(
            `bundle "${bundle}": servers "${prior.slug}" and "${c.slug}" both ` +
              `carry ${key} (under env:, or injected by an oauth: connector), ` +
              `both serve path "${c.path}", and the two resolve to DIFFERENT ` +
              `values — one of them comes from a per-server namespace ` +
              `(/strad/${config.gateway.env}/mcp/{slug}/static/). One path on ` +
              `one bundle is ONE mount in the container: one process, one set of ` +
              `credentials, so one value would silently overwrite the other. ` +
              `Give each its own path — path: /<its-own-slug>, which is where ` +
              `the bundle host mounts a per-slug instance — or its own bundle, ` +
              `or seed them the same value.`,
          );
        }
        if (!prior) held.set(key, { slug: c.slug, value });
      }
    }

    // --- which value the BARE name carries ----------------------------------
    //
    // A path group that cannot be its own instance reads the bare name and
    // nothing else, so the bare name is theirs. Two such groups disagreeing is
    // unrepresentable and throws — again about instances, not about names.
    const entry = imageBundles.get(bundle);
    const keys = new Set(contributions.flatMap((c) => Object.keys(c.env)));

    // A CONNECTOR'S VARIABLE NEVER TAKES THE BARE NAME.
    //
    // This is the difference between a credential and a CREDENTIAL SWAP, and it
    // is not the same rule as the throw above. That rule is about two servers
    // that both HOLD a value; this is about one that holds nothing.
    //
    // The bundle host's `slugEnvView` starts from the whole environment and
    // OVERLAYS `<SLUG>__<NAME>`, so a slug with no per-slug name of its own
    // reads the bare one. A connector's whole point is that an unconnected slug
    // has no refresh token — so if the bare name carried a sibling's, the
    // unconnected `-ro` mount would come up holding the `-rw` slug's WRITE
    // credential, fully functional, while its console page said "not connected".
    // Six slugs of one Google OAuth app on one bundle is the intended production
    // shape, so that is not a corner: it is the default.
    //
    // Alias-only makes the absent case absent. The slug reads its own name or it
    // reads nothing, degrades, and says which variable it is missing.
    //
    // A key a server ALSO writes under `env:` is not connector-only and keeps its
    // bare name: that is a human's own declaration and this must not silently
    // withdraw it.
    const connectorOnly = new Set(
      [...keys].filter((key) =>
        contributions.every((c) => !(key in c.env) || c.connectorKeys.has(key)),
      ),
    );

    for (const key of keys) {
      const holders = [...byPath]
        .filter(([, held]) => held.has(key))
        .map(([path, held]) => ({
          path,
          slug: held.get(key)!.slug,
          value: held.get(key)!.value,
          own: ownInstance(path),
        }));
      const owner = holders.find((h) => h.own === null) ?? holders[0]!;
      for (const h of holders) {
        if (h.value === owner.value || h.own !== null) continue;
        throw new Error(
          `bundle "${bundle}": servers "${owner.slug}" (path "${owner.path}") ` +
            `and "${h.slug}" (path "${h.path}") resolve ${key} to DIFFERENT ` +
            `values, and neither can be given an instance of its own — the ` +
            `bundle host mounts a per-slug instance at "/<slug>", so a server ` +
            `that needs its own value must be the only one on ` +
            `path: /<its-own-slug>. Fix that, give one its own bundle, or seed ` +
            `them the same value.`,
        );
      }
      if (entry && !connectorOnly.has(key)) entry.env[key] = owner.value;
    }

    // --- the per-slug names, for everybody -----------------------------------
    const emitted = emittedAliases.get(bundle) ?? {};
    for (const c of contributions) {
      for (const [key, value] of Object.entries(c.env)) {
        const alias = prefixedEnvName(c.slug, key);
        // The one shape that cannot be named: a slug mangling to something that
        // is not a portable variable name (one starting with a digit). It reads
        // the bare names exactly as it always did.
        if (alias === null) {
          (
            unnameable.get(bundle) ??
            unnameable.set(bundle, new Set()).get(bundle)!
          ).add(c.slug);
          continue;
        }
        emitted[alias] = value;
      }
    }
    emittedAliases.set(bundle, emitted);
  }

  // A STORE THE AGENT REACHES AND THE HUMAN CANNOT SEE.
  //
  // The console's store list and the MCP half's are separate fields on purpose —
  // they carry different credentials, and the console's may legitimately be the
  // wider of the two. The reverse is the one worth saying out loud: a store on
  // `mcpStores:` with no console page behind it is managed parameter state an
  // agent can create, rotate and delete, and which a human cannot inspect or
  // undo through the product's own front door.
  //
  // A WARNING and not an error, because it is a posture a deployment may choose
  // deliberately — and because the console's single-store fallback reads
  // `SECRETS_PROJECT_ID` out of a merged environment at runtime, so what is
  // visible here is a config-shaped approximation of it rather than the answer.
  for (const message of storesWithNoConsole(config)) opts.onWarning?.(message);

  for (const [bundle, slugs] of unnameable) {
    opts.onWarning?.(
      `bundle "${bundle}": ${[...slugs].sort().join(", ")} get no per-slug ` +
        `variable names, because the slug does not mangle to a portable ` +
        `variable name (one cannot start with a digit). Those servers read the ` +
        `bare names, as every server did before per-slug names existed, and ` +
        `cannot be given a value of their own on a shared bundle. Rename the ` +
        `slug if they need one.`,
    );
  }

  // A PER-SLUG NAME MAY NOT LAND ON A NAME SOMETHING ELSE ALREADY OWNS.
  //
  // Contrived but not impossible: a server declaring a variable literally called
  // `A__B` collides with slug `a`'s alias for `B`. The alias is generated rather
  // than written down, so nobody would see it in the config — hence a check here
  // rather than a note in the docs. A name already holding the SAME value is not
  // a collision, but it must not be emitted twice either: one component may not
  // carry one key twice, whatever the values.
  for (const [bundle, emitted] of emittedAliases) {
    const entry = imageBundles.get(bundle);
    if (!entry) continue;
    for (const key of Object.keys(emitted)) {
      const claimed = entry.env[key] ?? entry.params[key];
      if (claimed === undefined) continue;
      if (claimed !== emitted[key]) {
        throw new Error(
          `bundle "${bundle}": the per-slug name ${key} collides with a ` +
            `variable of the same name that another server on this bundle ` +
            `already sets to a different value. Rename that variable.`,
        );
      }
      delete emitted[key];
    }
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

  /**
   * The binding in the OTHER direction: every non-core component gets core's
   * private URL.
   *
   * Core has always needed a URL per bundle because it proxies `/mcp` to them.
   * Nothing needed core's until the parameter write-back route
   * (src/secrets/param-route.ts), which is the first call a bundle makes TO core
   * — a hosted server persisting a credential that rotated under it.
   *
   * Unconditional rather than only where `paramsWritable:` appears. It is a
   * private hostname, not a credential; a component that never calls it never
   * reads it; and making it conditional would mean adding the flag to a server
   * silently requires a redeploy of its component before the flag can work,
   * which is exactly the class of "green deploy, feature does nothing" this
   * repo keeps having to fix.
   */
  const coreUrlEnv: EnvVar = {
    key: CORE_URL_ENV,
    value: "${core.PRIVATE_URL}",
    scope: "RUN_TIME",
    type: "GENERAL",
  };

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
        ...consoleEnvVars(config, opts.secrets ?? {}, unseeded),
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
      // The same values under their per-slug names — every server on this
      // bundle, with no condition attached, which is the whole point. Nothing
      // here replaces a bare name: the bare ones are all still above, holding
      // the values they always held.
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
      coreUrlEnv,
      ...paramKeysEnv(supplementary.paramKeys),
      ...paramRefreshEnvs(
        supplementary.paramRefresh,
        config.gateway.secrets.paramRefreshSeconds,
      ),
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

    const instanceCount = declared?.instanceCount ?? 1;

    // SINGLE WRITER, enforced at render.
    //
    // `paramsWritable:` is what lets a process persist a credential that rotated
    // under it, and the credentials that rotate are the single-use kind: X's
    // refresh token is dead the moment it is spent. Two replicas therefore do not
    // merely race to write — they INVALIDATE EACH OTHER. Replica A spends the
    // token and stores R2; replica B, still holding R1, spends it, fails, and
    // either replica's next boot reads whatever landed last.
    //
    // The alternative is a compare-and-set on the parameter's version id with a
    // re-read on conflict, which is the right answer for a value two writers may
    // legitimately hold — and this is not one. There is no merge: the losing
    // replica's token is already invalid at the upstream and no amount of
    // retrying makes it valid again. So the useful thing to do is refuse the
    // topology, here, where it costs a render rather than a silent outage.
    //
    // THIS IS THE ASSUMPTION THE WHOLE MECHANISM RESTS ON. If a future change
    // makes a `paramsWritable` component scale out, the write-back path needs a
    // CAS before this check is relaxed, not after.
    const writableHere = config.servers.filter(
      (s) =>
        s.enabled &&
        s.kind === "supplementary-image" &&
        s.bundle === name &&
        s.paramsWritable.length > 0,
    );
    if (writableHere.length > 0 && instanceCount > 1) {
      throw new Error(
        `bundle "${name}" has instance_count ${instanceCount} and hosts ` +
          `${writableHere.length} server(s) with paramsWritable: ` +
          `(${writableHere.map((s) => s.slug).join(", ")}). A rotating ` +
          `credential has exactly one valid value at a time, so two replicas ` +
          `refreshing it invalidate each other and the last write wins the next ` +
          `boot. Set instanceCount: 1 for this bundle, or move the server with ` +
          `paramsWritable: to its own bundle.`,
      );
    }

    services.push({
      name,
      image: componentImage, // a builtin bundle runs the strad image in bundle mode
      instance_size_slug:
        declared?.instanceSizeSlug ??
        // Chromium peaks around 545MB RSS. 1GB is the floor for a browser
        // bundle; CPU, not RAM, is what actually binds (1 vCPU serialises it).
        "apps-s-1vcpu-1gb",
      instance_count: instanceCount,
      // Internal-only: internal_ports, and NO http_port. Both is an API error.
      internal_ports: [PORT],
      envs: supplementary
        ? supplementaryEnvs(name, supplementary, componentImage)
        : [
            coreUrlEnv,
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
