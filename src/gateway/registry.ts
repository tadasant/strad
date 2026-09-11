import { soleRefName, type StradConfig } from "../config/schema.ts";
import {
  resolveMapAsync,
  resolveOptionsAsync,
  resolveRefsAsync,
  type ServerSecretProviders,
} from "../secrets/provider/index.ts";
import {
  staticNamespace,
  type ParameterResolver,
} from "../secrets/parameters/index.ts";
import { NamespaceView } from "../secrets/provider/view.ts";
import { waiversBySlug } from "../deploy/unseeded.ts";
import { BuiltinServerAdapter, loadBuiltin } from "./adapters/builtin.ts";
import { HttpServerAdapter } from "./adapters/http.ts";
import {
  AccessTokenMinter,
  bearerIn,
  resolveRefreshGrant,
  withBearer,
} from "./adapters/oauth-refresh.ts";
import type { ServerAdapter } from "./adapters/types.ts";
import { resolvingFor } from "./unconfigured.ts";

/** Shared empty waiver set — most slugs declare none. */
const EMPTY: ReadonlySet<string> = new Set<string>();

/**
 * Config -> live adapters.
 *
 * This is where the four kinds are reconciled into one runtime surface. Built
 * once at boot: an adapter is a long-lived upstream connection, not a
 * per-request object. (The *toolset* is still resolved per request — see
 * router.ts. Only the plumbing is shared.)
 *
 * What is NOT built once is the SECRETS. Each adapter is handed a thunk that
 * resolves its `${SECRET}` refs when they are needed, against the runtime
 * provider. Resolving them here, into constructor arguments, is what makes
 * "rotate a credential" mean "redeploy the gateway": the values a boot happened
 * to see would live as long as the process. The process holds the reference; the
 * provider holds the value.
 */

export type Mode = "core" | "bundle";

export interface RegistryOptions {
  config: StradConfig;
  /**
   * The runtime secret providers. See src/secrets/provider.
   *
   * A SET rather than one provider: every `${NAME}` resolved below is written on
   * a server entry, so it is resolved through `forServer(slug)` — that server's
   * own `/strad/{env}/mcp/{slug}/static/` namespace layered over the shared one.
   */
  secrets: ServerSecretProviders;
  /**
   * "core"   — the public gateway. Mounts remote-http + core builtins directly,
   *            and proxies to every non-core bundle over the private network.
   * "bundle" — an internal component. Mounts only the builtins assigned to
   *            `bundleName`, and serves them to the core over private HTTP.
   */
  mode: Mode;
  bundleName?: string;
  env?: NodeJS.ProcessEnv;
  /**
   * Optional runtime parameter resolver. When a builtin server sets `params:
   * true`, its `/strad/{env}/mcp/{slug}/static/*` parameters are resolved through
   * this and merged into the builtin's `options` — on every call, so a parameter
   * changed in the store reaches the builtin without a restart. Absent (the
   * default) = no resolution, and the process holds no cloud credential. See
   * src/secrets/parameters and resolverFromEnv().
   */
  resolver?: ParameterResolver | null;
  /**
   * Persist a credential that rotated inside THIS process, where the store
   * will hand it back: `(slug, variable, value)`.
   *
   * What a `remote-http` server with `oauthRefresh:` calls when its token
   * endpoint issues a new refresh token. Core only, and absent wherever there
   * is no store to write — the minter then holds the rotation in memory and
   * says so. See `createParameterWriteBack` in src/http/params.ts.
   */
  writeBack?: (slug: string, variable: string, value: string) => Promise<void>;
}

export class Registry {
  private constructor(
    private readonly adapters: Map<string, ServerAdapter>,
    /** Slugs this process serves, in config order. */
    readonly slugs: string[],
  ) {}

  get(slug: string): ServerAdapter | undefined {
    return this.adapters.get(slug);
  }

  has(slug: string): boolean {
    return this.adapters.has(slug);
  }

  async close(): Promise<void> {
    await Promise.all([...this.adapters.values()].map((a) => a.close()));
  }

  static async build(opts: RegistryOptions): Promise<Registry> {
    const { config, secrets, mode } = opts;
    const env = opts.env ?? process.env;
    const adapters = new Map<string, ServerAdapter>();
    const slugs: string[] = [];

    // Identity of the process we are building this registry for. Handed to every
    // builtin, so a builtin never has to guess from globals where it is running.
    const component = {
      mode,
      bundle: opts.bundleName ?? "core",
      hostname: env.HOSTNAME ?? "unknown",
    };

    // A builtin's factory options are its `options:` map with `${SECRET}` refs
    // resolved, PLUS — when it opts into `params:` — its resolved managed
    // parameters merged on top. That resolution reads secret values (to build
    // the child's env), which is exactly why it uses the RESOLVER credential and
    // not the MCP one.
    //
    // The values are handed to the BUILTIN. Whether any of them leaves over /mcp
    // is that builtin's decision, not this file's: `src/servers/echo.ts` returns
    // `options.greeting` from `whoami`, so a parameter named `greeting` in echo's
    // namespace is returned verbatim to every caller entitled to the slug. Point
    // a `params:` builtin's options at a credential only when the builtin is
    // known not to echo them.
    //
    // `params:` resolution is a slice of the resolver's one snapshot of the
    // store — a NETWORK read only when that snapshot has aged past
    // `gateway.secrets.ttlSeconds` — and the thunk below runs on every tool
    // call. The view over it is the same single-flight, last-known-good layer
    // the secret provider uses: a store that starts failing mid-flight leaves
    // the builtin on the parameters it last had, with a warning, rather than
    // failing every call.
    // Which `${NAME}`s each slug declared it may deploy without. A miss on one of
    // these is `unconfigured` — a deploy that shipped ahead of a token on purpose
    // — rather than an upstream failure, and every consumer downstream of here
    // (/healthz, the console, the MCP error a client sees) depends on the two
    // being told apart. A miss on anything else stays the fault it is.
    const waived: ReadonlyMap<string, ReadonlySet<string>> = waiversBySlug(
      config,
    );
    /** This slug's endpoint/options resolution, with its declared misses named. */
    const resolving = <T>(slug: string, resolve: () => Promise<T>) =>
      resolvingFor(slug, waived.get(slug) ?? EMPTY, resolve);

    const resolver = opts.resolver;
    const paramCache = resolver
      ? new NamespaceView((namespace) => resolver.resolve(namespace), {
          label: "server parameters",
        })
      : null;

    // This returns a THUNK, not a value: it is invoked per tool call, so a
    // rotated `${SECRET}` or a re-set parameter is picked up by a running
    // process.
    const optionsFor =
      (server: Extract<StradConfig["servers"][number], { kind: "builtin" }>) =>
      async (): Promise<Record<string, unknown>> => {
        const base = await resolving(server.slug, () =>
          resolveOptionsAsync(server.options, secrets.forServer(server.slug)),
        );
        if (!server.params || !paramCache) return base;
        const params = await paramCache.get(
          staticNamespace(config.gateway.env, server.slug),
        );
        return { ...base, ...params };
      };

    for (const server of config.servers) {
      if (!server.enabled) continue;

      // --- bundle mode: mount only what this component is responsible for ---
      if (mode === "bundle") {
        if (server.kind !== "builtin") continue;
        if (server.bundle !== opts.bundleName) continue;

        adapters.set(
          server.slug,
          new BuiltinServerAdapter(
            server.slug,
            await loadBuiltin(server.module),
            optionsFor(server),
            component,
          ),
        );
        slugs.push(server.slug);
        continue;
      }

      // --- core mode ---
      switch (server.kind) {
        // One transport, one endpoint thunk. The url AND the headers are
        // re-resolved per operation for both: a third-party bearer token is the
        // single most likely thing in a strad config to be rotated, and a tunnel
        // URL is exactly the kind of value that changes without a deploy (a
        // Cloudflare quick tunnel mints a new hostname every restart). For both
        // kinds, resolving per call is the point rather than an inherited detail.
        case "remote-http":
        case "local-tunnel": {
          // A minted bearer: ONE minter per slug, reachable from this slug's
          // endpoint thunk and nothing else. There is no cache shared between
          // servers to key wrongly — see gateway/adapters/oauth-refresh.ts.
          const oauth =
            server.kind === "remote-http" ? server.oauthRefresh : undefined;
          const refreshVariable = oauth
            ? soleRefName(oauth.refreshToken)
            : null;
          const writeBack = opts.writeBack;
          const minter =
            oauth && refreshVariable
              ? new AccessTokenMinter({
                  slug: server.slug,
                  variable: refreshVariable,
                  persist: writeBack
                    ? (value) => writeBack(server.slug, refreshVariable, value)
                    : undefined,
                })
              : null;
          adapters.set(
            server.slug,
            new HttpServerAdapter({
              slug: server.slug,
              kind: server.kind,
              endpoint: async () =>
                resolving(server.slug, async () => {
                  const provider = secrets.forServer(server.slug);
                  const [url, headers] = await Promise.all([
                    resolveRefsAsync(server.url, provider),
                    resolveMapAsync(server.headers, provider),
                  ]);
                  if (!oauth || !minter) return { url, headers };
                  const grant = await resolveRefreshGrant(oauth, provider);
                  const token = await minter.accessToken(grant);
                  return { url, headers: withBearer(headers, token) };
                }),
              onUnauthorized: minter
                ? (rejected) => {
                    const token = bearerIn(rejected.headers);
                    if (token) minter.reject(token);
                  }
                : undefined,
              timeoutMs: server.timeoutMs,
              // The one behavioural difference a local-tunnel carries: an absent
              // machine must be a fast, legible failure rather than a hang...
              connectTimeoutMs:
                server.kind === "local-tunnel"
                  ? server.connectTimeoutMs
                  : undefined,
              // ...and what to tell a caller when it IS absent. Built here, from
              // config alone, because this is the only place that has both the
              // entry and the adapter — and because everything downstream of it
              // (the troubleshooting tool, the error message) must be strad's
              // own words rather than an upstream's.
              host:
                server.kind === "local-tunnel"
                  ? {
                      slug: server.slug,
                      hostname: plainHostname(server.url),
                      machine: server.recovery.machine,
                      commands: server.recovery.commands,
                      notes: server.recovery.notes,
                    }
                  : undefined,
            }),
          );
          slugs.push(server.slug);
          break;
        }

        case "supplementary-image": {
          // The component runs on the private network. App Platform binds
          // ${bundle-name.PRIVATE_URL} into this env var at deploy time; it
          // resolves to http://bundle-name:8080 — ~4ms away, and never
          // reachable from the internet.
          //
          // "Never reachable from the internet" is a reachability property, not
          // an authorization one, so the internal token rides along here too —
          // from the code, unconditionally, rather than from a `headers:` entry
          // each of thirty-two config entries would have to remember. The other
          // half is the bundle host refusing a request without it
          // (`servers/bundle/host/src/internal-auth.ts`).
          const base = privateUrlFor(server.bundle, env);
          adapters.set(
            server.slug,
            new HttpServerAdapter({
              slug: server.slug,
              kind: "supplementary-image",
              endpoint: async () =>
                resolving(server.slug, async () => ({
                  url: joinUrl(base, server.path),
                  headers: withInternalToken(
                    await resolveMapAsync(
                      server.headers,
                      secrets.forServer(server.slug),
                    ),
                    env,
                  ),
                })),
              timeoutMs: server.timeoutMs,
            }),
          );
          slugs.push(server.slug);
          break;
        }

        case "builtin": {
          if (server.bundle === "core") {
            adapters.set(
              server.slug,
              new BuiltinServerAdapter(
                server.slug,
                await loadBuiltin(server.module),
                optionsFor(server),
                component,
              ),
            );
          } else {
            // The builtin lives in another component (running this same image
            // in bundle mode). Talk to it over the private network, using the
            // same HTTP adapter as any other upstream — and narrow the request
            // to just this slug so the bundle doesn't hand back its siblings.
            const base = privateUrlFor(server.bundle, env);
            const url = `${joinUrl(base, "/mcp")}?servers=${encodeURIComponent(server.slug)}`;
            adapters.set(
              server.slug,
              new HttpServerAdapter({
                slug: server.slug,
                kind: "supplementary-image",
                // core <-> bundle auth is a deploy-injected env var on BOTH
                // sides, so it cannot rotate without a redeploy of the pair
                // anyway. Read it per call regardless — one env lookup, and it
                // keeps every endpoint on the same code path.
                endpoint: async () => ({
                  url,
                  headers: internalHeaders(env),
                }),
                timeoutMs: server.timeoutMs,
                // The upstream is another strad, so its tools arrive already
                // namespaced. Tell the adapter to unwrap them.
                innerPrefix: server.slug,
              }),
            );
          }
          slugs.push(server.slug);
          break;
        }

        default: {
          // Compile-time only. A kind added to the schema and not handled here
          // fails `npm run typecheck` on this assignment, which is the point of
          // deriving the union rather than restating it. At RUNTIME this stays a
          // skip: Zod's discriminated union has already rejected an unknown kind
          // before the registry sees it, and boot is deliberately lenient so a
          // rollback does not become an outage.
          const unhandled: never = server;
          void unhandled;
          break;
        }
      }
    }

    return new Registry(adapters, slugs);
  }
}

/**
 * The env var App Platform binds ${bundle.PRIVATE_URL} into.
 * `bundle-api` -> STRAD_BUNDLE_URL_BUNDLE_API
 */
export function bundleUrlEnvName(bundle: string): string {
  return `STRAD_BUNDLE_URL_${bundle.toUpperCase().replace(/-/g, "_")}`;
}

function privateUrlFor(bundle: string, env: NodeJS.ProcessEnv): string {
  const name = bundleUrlEnvName(bundle);
  const url = env[name];
  if (!url) {
    throw new Error(
      `bundle "${bundle}" has no private URL: ${name} is not set. ` +
        `The app spec must bind it to \${${bundle}.PRIVATE_URL}.`,
    );
  }
  return url;
}

/**
 * Bundle components authenticate the core with a shared secret. They are on the
 * private network and have no public route, but "internal network" is not an
 * authorization story — anything else in the VPC could reach them.
 */
export function internalHeaders(
  env: NodeJS.ProcessEnv,
): Record<string, string> {
  const token = env.STRAD_INTERNAL_TOKEN;
  return token ? { authorization: `Bearer ${token}` } : {};
}

/**
 * The internal token, added to a supplementary component's configured headers.
 *
 * A configured `Authorization` WINS. The internal token is strad's own
 * credential for its own containers; a `supplementary-image` entry that spells
 * an authorization header is naming an upstream's, and quietly replacing it
 * would break that server for the sake of a component the operator has told us
 * is not one of ours. The match is case-insensitive because HTTP header names
 * are, and because emitting both spellings is worse than either: `fetch` folds a
 * record into `Headers` by APPENDING, so `Authorization` plus `authorization`
 * would go out as one comma-joined value neither side can parse.
 */
export function withInternalToken(
  headers: Record<string, string>,
  env: NodeJS.ProcessEnv,
): Record<string, string> {
  const declared = Object.keys(headers).some(
    (name) => name.toLowerCase() === "authorization",
  );
  return declared ? headers : { ...internalHeaders(env), ...headers };
}

/**
 * The hostname of a configured URL, when there is one to be had.
 *
 * Returns undefined for a `url:` that contains a `${REF}`, and does so WITHOUT
 * resolving it. The resolved value can only exist inside the secrets store, and
 * this hostname is destined for a tool result that any entitled client reads:
 * "which laptop is this" is worth a sentence, and is not worth reading a secret
 * to answer.
 */
function plainHostname(url: string): string | undefined {
  if (url.includes("${")) return undefined;
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}
