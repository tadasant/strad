import type { StradConfig } from "../config/schema.ts";
import { RESOLVER_ENV } from "../secrets/parameters/index.ts";

/**
 * Where a stored parameter actually GOES — computed from the running config,
 * not asserted in prose.
 *
 * The console can write any path inside a managed namespace. Whether anything
 * ever READS that path is a separate question, and it is the one a human gets
 * wrong: storing `/strad/prod/mcp/slack/static/SLACK_BOT_TOKEN` looks like it
 * configures the `slack` server, and it does not unless that server's config
 * entry sets `params: true` AND the deployment holds a resolver credential. A
 * credential that silently goes nowhere is the worst outcome this page can
 * produce, so the page says which it is.
 *
 * The two destinations, and what reads each:
 *
 *   /strad/{env}/mcp/{slug}/static/{VAR}
 *       Read for a server that sets `params: true`. A supplementary image's
 *       parameters are resolved at DEPLOY time by scripts/render-spec.ts and
 *       injected onto its component; a builtin's are resolved at RUNTIME by the
 *       registry, on the secrets TTL. A server without `params: true` reads none
 *       of it — it takes its environment from `env:` / `options:` instead.
 *
 *   /strad/{env}/gateway/static/{NAME}
 *       The gateway's own `${NAME}` references. Read at runtime only when
 *       `gateway.secrets.provider` is a parameter store; under the default `env`
 *       provider the gateway resolves `${NAME}` from its process environment and
 *       this namespace is deploy-time input at most.
 *
 * BOTH depend on a credential the config does not mention. `params: true` with
 * no `STRAD_PARAMS_*` resolver is a no-op — render-spec warns and ships the
 * component without those values (scripts/render-spec.ts), and the registry's
 * `paramCache` is null. So the verdict is a function of the config AND the
 * environment, and reporting `delivered` off `params: true` alone would produce
 * exactly the false claim this module exists to prevent.
 *
 * Everything else in a managed namespace is stored and indexed and read by
 * nothing, which is a legitimate thing to want (a registry of credentials a
 * human manages by hand) as long as it is not mistaken for delivery.
 */

export type DeliveryState =
  /** Something in this deployment resolves this path. */
  | "delivered"
  /** A well-formed path whose consumer is not wired to read it. */
  | "not-wired"
  /** Not a path any resolver looks at. */
  | "unrouted";

export interface Routing {
  state: DeliveryState;
  /** The server slug the path addresses, when it addresses one. */
  slug?: string;
  /** When a delivered value reaches its consumer. */
  when?: "deploy" | "runtime";
  /** Short label for a chip. */
  label: string;
  /** One sentence a human can act on. */
  detail: string;
}

/** A server that opts into parameter resolution, and when its values land. */
export interface ParamsConsumer {
  slug: string;
  /** The namespace prefix its parameters live under, relative to a namespace. */
  prefix: string;
  when: "deploy" | "runtime";
}

/**
 * Note the `(.+)` tail rather than one segment.
 *
 * `resolve()` lists everything under `{slug}/static/` and keys the result by the
 * path's LAST segment (src/secrets/parameters/gcp.ts), so
 * `{slug}/static/extra/TOKEN` IS injected — as `TOKEN`. Matching only a single
 * segment would report that path `unrouted`, and "nothing reads this" is the
 * more dangerous direction to be wrong in: a human parks a credential believing
 * it inert while it is being handed to a running server.
 */
const SLUG_STATIC = /^([a-z0-9][a-z0-9-]*)\/static\/(.+)$/;

/**
 * Does this process's environment carry the resolver credential?
 *
 * `STRAD_PARAMS_RESOLVER_SERVICE_ACCOUNT_KEY_JSON` is scoped to strad's own
 * images (`STRAD_IMAGE_ONLY_SECRET_KEYS` in src/deploy/appspec.ts), so a deploy
 * that had it puts it on core — which is where this console renders. It is a
 * proxy rather than a proof for the DEPLOY-time path (the console cannot see
 * CI's environment), but it is the same credential from the same source, and a
 * deployment missing it here is one where `params: true` resolved to nothing.
 */
export function resolverConfigured(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env[RESOLVER_ENV.projectId] && env[RESOLVER_ENV.keyJson]);
}

/** Every enabled server with `params: true`, in config order. */
export function paramsConsumers(config: StradConfig): ParamsConsumer[] {
  const out: ParamsConsumer[] = [];
  for (const server of config.servers) {
    if (!server.enabled) continue;
    if (server.kind === "remote-http") continue;
    if (!server.params) continue;
    out.push({
      slug: server.slug,
      prefix: `${server.slug}/static/`,
      when: server.kind === "supplementary-image" ? "deploy" : "runtime",
    });
  }
  return out;
}

/**
 * Every server that COULD consume parameters, whether or not it does yet.
 *
 * This is what the create form offers as prefix suggestions: a human adding a
 * credential for `gcs` should get `gcs/static/` from a list rather than typing
 * it, and should see in the same list that `gcs` is not wired yet.
 */
export function prefixSuggestions(
  config: StradConfig,
): { prefix: string; wired: boolean; slug: string }[] {
  const wired = new Set(paramsConsumers(config).map((c) => c.slug));
  return config.servers
    .filter((s) => s.enabled && s.kind !== "remote-http")
    .map((s) => ({
      slug: s.slug,
      prefix: `${s.slug}/static/`,
      wired: wired.has(s.slug),
    }));
}

/** The sentence to add when a `params: true` server has no resolver behind it. */
const NO_RESOLVER =
  "This deployment carries no resolver credential (STRAD_PARAMS_PROJECT_ID and " +
  "STRAD_PARAMS_RESOLVER_SERVICE_ACCOUNT_KEY_JSON), so `params: true` resolves to nothing and " +
  "the value is stored and unread.";

/** Classify one canonical path against the running config and environment. */
export function classifyPath(
  config: StradConfig,
  path: string,
  resolver: boolean,
): Routing {
  const env = config.gateway.env;
  const mcpRoot = `/strad/${env}/mcp/`;
  const gatewayRoot = `/strad/${env}/gateway/static/`;

  if (path.startsWith(gatewayRoot)) {
    const store = config.gateway.secrets.provider !== "env";
    if (store && resolver) {
      return {
        state: "delivered",
        when: "runtime",
        label: "gateway · runtime",
        detail:
          "The gateway resolves its own ${NAME} references from this namespace at runtime, " +
          `because gateway.secrets.provider is "${config.gateway.secrets.provider}". A value is ` +
          "read only if some config value actually references it by name.",
      };
    }
    return {
      state: "not-wired",
      label: "not wired",
      detail: store
        ? NO_RESOLVER
        : 'gateway.secrets.provider is "env" on this deployment, so the gateway resolves ' +
          "${NAME} from its process environment. A value here reaches it only if the DEPLOY " +
          "is run with a resolver credential, which renders it into the app spec.",
    };
  }

  if (!path.startsWith(mcpRoot)) {
    return {
      state: "unrouted",
      label: "unrouted",
      detail:
        `Outside strad's canonical namespaces for this gateway (${mcpRoot} and ${gatewayRoot}). ` +
        "It is stored and listed; no resolver reads it.",
    };
  }

  const rest = path.slice(mcpRoot.length);
  const match = SLUG_STATIC.exec(rest);
  if (!match) {
    return {
      state: "unrouted",
      label: "unrouted",
      detail:
        `Not a ${mcpRoot}{server}/static/… path. Parameter resolution reads exactly that ` +
        "shape, so nothing will pick this up.",
    };
  }

  const slug = match[1] as string;
  const tail = match[2] as string;
  const server = config.servers.find((s) => s.slug === slug);
  if (!server || !server.enabled) {
    return {
      state: "unrouted",
      slug,
      label: "no such server",
      detail: server
        ? `The "${slug}" server is disabled on this gateway, so nothing resolves this path.`
        : `No server named "${slug}" is configured on this gateway.`,
    };
  }

  if (server.kind === "remote-http") {
    return {
      state: "unrouted",
      slug,
      label: "not wired",
      detail:
        `"${slug}" is a remote-http server — strad runs no container for it and there is no ` +
        "environment to inject, so it can never consume a managed parameter.",
    };
  }

  if (!server.params) {
    return {
      state: "not-wired",
      slug,
      label: "not wired",
      detail:
        `Stored, but not delivered: the "${slug}" server does not set \`params: true\` in ` +
        `strad's config, so nothing resolves this path into its environment — it reads its ` +
        `${server.kind === "builtin" ? "options:" : "env:"} map instead. Wiring that is a ` +
        "config change plus a deploy.",
    };
  }

  const when = server.kind === "supplementary-image" ? "deploy" : "runtime";

  if (!resolver) {
    return {
      state: "not-wired",
      slug,
      when,
      label: "no resolver",
      detail: `"${slug}" sets \`params: true\`, but that is only half of it. ${NO_RESOLVER}`,
    };
  }

  // Two paths under one `{slug}/static/` that end in the same segment collapse
  // onto one env var, and the deeper one is invisible in a bare variable list.
  // Say so on the row rather than letting the human find out from a server
  // reading a value it did not expect.
  const deep = tail.includes("/")
    ? " Note the extra path depth: resolution keys on the LAST segment, so this arrives as " +
      `\`${tail.slice(tail.lastIndexOf("/") + 1)}\` and collides with any sibling ending in the same name.`
    : "";

  return {
    state: "delivered",
    slug,
    when,
    label: when === "deploy" ? "delivered · deploy" : "delivered · runtime",
    detail:
      (when === "deploy"
        ? `Delivered: "${slug}" sets \`params: true\`, so render-spec resolves this path at ` +
          "DEPLOY time and injects it onto that container. A new or rotated value reaches the " +
          "server on the next deploy, not immediately."
        : `Delivered: "${slug}" sets \`params: true\` and runs a strad image, so this path is ` +
          `resolved at RUNTIME and refreshed within gateway.secrets.ttlSeconds (${config.gateway.secrets.ttlSeconds}s).`) +
      deep,
  };
}
