import type { StradConfig } from "../config/schema.ts";
import { resolveMap, resolveRefs, type SecretBag } from "../secrets/index.ts";
import {
  resolveServerParams,
  type ParameterResolver,
} from "../secrets/parameters/index.ts";
import { BuiltinServerAdapter, loadBuiltin } from "./adapters/builtin.ts";
import { HttpServerAdapter } from "./adapters/http.ts";
import type { ServerAdapter } from "./adapters/types.ts";

/**
 * Config -> live adapters.
 *
 * This is where the three kinds are reconciled into one runtime surface, and
 * where `${SECRET}` refs are resolved. Built once at boot: an adapter is a
 * long-lived upstream connection, not a per-request object. (The *toolset* is
 * still resolved per request — see router.ts. Only the plumbing is shared.)
 */

export type Mode = "core" | "bundle";

export interface RegistryOptions {
  config: StradConfig;
  secrets: SecretBag;
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
   * this and injected into the builtin's `options` at launch — the concrete
   * "resolve, then inject into the child process" path. Absent (the default) =
   * no resolution, and the core holds no cloud credential. See
   * src/secrets/parameters and resolverFromEnv().
   */
  resolver?: ParameterResolver | null;
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
    // parameters injected on top. That resolution reads secret values (to build
    // the child's env), which is exactly why it uses the RESOLVER credential and
    // not the MCP one; the values are handed to the builtin's process and never
    // returned over /mcp.
    const optionsFor = async (
      server: Extract<StradConfig["servers"][number], { kind: "builtin" }>,
    ): Promise<Record<string, unknown>> => {
      const base = resolveOptions(server.options, secrets);
      if (!server.params || !opts.resolver) return base;
      const params = await resolveServerParams(
        opts.resolver,
        config.gateway.env,
        server.slug,
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
            await optionsFor(server),
            component,
          ),
        );
        slugs.push(server.slug);
        continue;
      }

      // --- core mode ---
      switch (server.kind) {
        case "remote-http": {
          adapters.set(
            server.slug,
            new HttpServerAdapter({
              slug: server.slug,
              kind: "remote-http",
              url: resolveRefs(server.url, secrets),
              headers: resolveMap(server.headers, secrets),
              timeoutMs: server.timeoutMs,
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
          const base = privateUrlFor(server.bundle, env);
          adapters.set(
            server.slug,
            new HttpServerAdapter({
              slug: server.slug,
              kind: "supplementary-image",
              url: joinUrl(base, server.path),
              headers: resolveMap(server.headers, secrets),
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
                await optionsFor(server),
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
                url,
                headers: internalHeaders(env),
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

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

function resolveOptions(
  options: Record<string, unknown>,
  secrets: SecretBag,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(options)) {
    out[k] = typeof v === "string" ? resolveRefs(v, secrets) : v;
  }
  return out;
}
