import type { StradConfig } from "../config/schema.ts";
import { bundleUrlEnvName } from "../gateway/registry.ts";
import { resolveMap } from "../secrets/index.ts";

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
  /** Custom domains, if any. Omit to use the default *.ondigitalocean.app. */
  domains?: { domain: string; type?: "PRIMARY" | "ALIAS" }[];
  coreInstanceSizeSlug?: string;
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

export function renderAppSpec(opts: RenderOptions): AppSpec {
  const { config } = opts;

  // Which bundles actually need a container?
  const imageBundles = new Map<string, ReturnType<typeof supplementaryOf>>();
  const builtinBundles = new Set<string>();

  for (const server of config.servers) {
    if (!server.enabled) continue;
    if (server.kind === "remote-http") continue; // no container: it's someone else's

    if (server.kind === "supplementary-image") {
      imageBundles.set(server.bundle, supplementaryOf(server));
    } else if (server.bundle !== "core") {
      builtinBundles.add(server.bundle);
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
        ...bundleUrlEnvs,
        ...opts.env,
      ],
      health_check: { http_path: "/healthz", initial_delay_seconds: 10 },
    },
  ];

  for (const name of bundleNames) {
    const declared = config.bundles.find((b) => b.name === name);
    const supplementary = imageBundles.get(name);

    services.push({
      name,
      image: supplementary ? parseImage(supplementary.image) : opts.image, // a builtin bundle runs the strad image in bundle mode
      instance_size_slug:
        declared?.instanceSizeSlug ??
        // Chromium peaks around 545MB RSS. 1GB is the floor for a browser
        // bundle; CPU, not RAM, is what actually binds (1 vCPU serialises it).
        "apps-s-1vcpu-1gb",
      instance_count: declared?.instanceCount ?? 1,
      // Internal-only: internal_ports, and NO http_port. Both is an API error.
      internal_ports: [PORT],
      envs: supplementary
        ? [
            // Resolve `${NAME}` refs against the secret bag so the credential
            // lands ONLY on this bundle. resolveMap throws on an unresolved
            // ref — a supplementary image that silently shipped the literal
            // "${GOODEGGS_PASSWORD}" would fail its login in a confusing way.
            ...Object.entries(
              resolveMap(supplementary.env, opts.secrets ?? {}),
            ).map(([key, value]): EnvVar => ({
              key,
              value,
              scope: "RUN_TIME",
              type: "SECRET",
            })),
            ...opts.env.filter((e) => e.type === "SECRET"),
          ]
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
            ...opts.env,
          ],
    });
  }

  const spec: AppSpec = {
    name: opts.appName,
    region: opts.region,
    services,
  };

  if (opts.domains?.length) spec.domains = opts.domains;
  return spec;
}

function supplementaryOf(
  server: Extract<
    StradConfig["servers"][number],
    { kind: "supplementary-image" }
  >,
) {
  return { image: server.image, env: server.env };
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
