import type { StradConfig } from "../config/schema.ts";

/**
 * Where a stored parameter actually GOES — computed from the running config,
 * not asserted in prose.
 *
 * The console can write any path inside a managed namespace. Whether anything
 * ever READS that path is a separate question, and it is the one a human gets
 * wrong: storing `/strad/prod/mcp/slack/static/SLACK_BOT_TOKEN` looks like it
 * configures the `slack` server, and it does not unless that server's config
 * entry sets `params: true`. A credential that silently goes nowhere is the
 * worst outcome this page can produce, so the page says which it is.
 *
 * The two destinations, and what reads each:
 *
 *   /strad/{env}/mcp/{slug}/static/{VAR}
 *       Read for a server that sets `params: true`. A supplementary image's
 *       parameters are resolved at DEPLOY time by scripts/render-spec.ts and
 *       injected onto its component; a `core` builtin's are resolved at RUNTIME
 *       by the registry, on the secrets TTL. A server without `params: true`
 *       reads none of it — it takes its environment from `env:` instead.
 *
 *   /strad/{env}/gateway/static/{NAME}
 *       The gateway's own `${NAME}` references. Read at runtime only when
 *       `gateway.secrets.provider` is a parameter store; under the default `env`
 *       provider the gateway resolves `${NAME}` from its process environment and
 *       this namespace is deploy-time input at most.
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

const SLUG_STATIC = /^([a-z0-9][a-z0-9-]*)\/static\/([A-Za-z_][A-Za-z0-9_]*)$/;

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

/** Classify one canonical path against the running config. */
export function classifyPath(config: StradConfig, path: string): Routing {
  const env = config.gateway.env;
  const mcpRoot = `/strad/${env}/mcp/`;
  const gatewayRoot = `/strad/${env}/gateway/static/`;

  if (path.startsWith(gatewayRoot)) {
    const store = config.gateway.secrets.provider !== "env";
    return store
      ? {
          state: "delivered",
          when: "runtime",
          label: "gateway · runtime",
          detail:
            "The gateway resolves its own ${NAME} references from this namespace at runtime, " +
            `because gateway.secrets.provider is "${config.gateway.secrets.provider}".`,
        }
      : {
          state: "not-wired",
          label: "not wired",
          detail:
            'gateway.secrets.provider is "env" on this deployment, so the gateway resolves ' +
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
        `Not a ${mcpRoot}{server}/static/{VARIABLE} path. Parameter resolution reads exactly ` +
        "that shape, so nothing will pick this up.",
    };
  }

  const slug = match[1] as string;
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

  if (server.kind === "remote-http" || !server.params) {
    return {
      state: "not-wired",
      slug,
      label: "not wired",
      detail:
        `Stored, but not delivered: the "${slug}" server does not set \`params: true\` in ` +
        "strad's config, so nothing resolves this path into its environment. Wiring that is a " +
        "config change plus a deploy.",
    };
  }

  const when = server.kind === "supplementary-image" ? "deploy" : "runtime";
  return {
    state: "delivered",
    slug,
    when,
    label: when === "deploy" ? "delivered · deploy" : "delivered · runtime",
    detail:
      when === "deploy"
        ? `Delivered: "${slug}" sets \`params: true\`, so render-spec resolves this path at ` +
          "DEPLOY time and injects it onto that container. A new or rotated value reaches the " +
          "server on the next deploy, not immediately."
        : `Delivered: "${slug}" sets \`params: true\` and runs in the gateway process, so this ` +
          `path is resolved at RUNTIME and refreshed within gateway.secrets.ttlSeconds (${config.gateway.secrets.ttlSeconds}s).`,
  };
}
