import { isUnhosted } from "../config/schema.ts";
import type { StradConfig } from "../config/schema.ts";
import {
  RESOLVER_ENV,
  SERVER_PARAM_KINDS,
} from "../secrets/parameters/index.ts";
import { refsIn } from "../secrets/provider/resolve.ts";

/**
 * Where a stored parameter actually GOES — computed from the running config,
 * not asserted in prose.
 *
 * The console can write any well-formed path inside its project. Whether anything
 * ever READS that path is a separate question, and it is the one a human gets
 * wrong: storing `/strad/prod/mcp/slack/static/SLACK_BOT_TOKEN` looks like it
 * configures the `slack` server, and it does not unless that server's config
 * entry sets `params: true` AND the deployment holds a resolver credential. A
 * credential that silently goes nowhere is the worst outcome this page can
 * produce, so the page says which it is.
 *
 * The two destinations, and what reads each:
 *
 *   /strad/{env}/mcp/{slug}/{static|oauth}/{VAR}
 *       Read TWO ways, and the difference matters to what this page says.
 *       `params: true` takes the namespace WHOLESALE — a supplementary image's
 *       at DEPLOY time via scripts/render-spec.ts, a builtin's at RUNTIME via
 *       the registry, on the secrets TTL. Separately, and with no flag at all, a
 *       supplementary server's `env:` `${NAME}` references are substituted from
 *       this namespace before the gateway's (src/deploy/server-namespaces.ts) —
 *       so a parameter whose variable matches one of those names is delivered
 *       too. A path matching neither is stored and read by nothing.
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

/** A server that reads its namespace, and when its values land. */
export interface ParamsConsumer {
  slug: string;
  /** The namespace prefix its parameters live under, relative to a namespace. */
  prefix: string;
  when: "deploy" | "runtime";
  /**
   * HOW it reads the namespace, which is not the same question as whether.
   *
   * `params` takes the namespace wholesale. `env-ref` substitutes only the names
   * the server's `env:` map already references — no flag, and invisible in the
   * config's `params:` column. A banner counting only the first would tell a
   * human nothing here is delivered while a row below says `delivered`.
   */
  via: "params" | "env-ref";
}

/**
 * Note the `(.+)` tail rather than one segment.
 *
 * `resolve()` lists everything under `{slug}/{kind}/` and keys the result by the
 * path's LAST segment (src/secrets/parameters/gcp.ts), so
 * `{slug}/static/extra/TOKEN` IS injected — as `TOKEN`. Matching only a single
 * segment would report that path `unrouted`, and "nothing reads this" is the
 * more dangerous direction to be wrong in: a human parks a credential believing
 * it inert while it is being handed to a running server.
 *
 * The KIND alternation is built from `SERVER_PARAM_KINDS` rather than written
 * out, so a kind added there is routed here rather than classified `unrouted` —
 * which is the same dangerous direction, arriving from the other side.
 */
const SLUG_KIND = new RegExp(
  `^([a-z0-9][a-z0-9-]*)\\/(${SERVER_PARAM_KINDS.join("|")})\\/(.+)$`,
);

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

/**
 * Every enabled server that reads its own namespace, in config order.
 *
 * Two ways in, and both count: `params: true`, and a supplementary server whose
 * `env:` references a `${NAME}` that per-server substitution would supply.
 */
export function paramsConsumers(config: StradConfig): ParamsConsumer[] {
  const out: ParamsConsumer[] = [];
  for (const server of config.servers) {
    if (!server.enabled) continue;
    if (isUnhosted(server)) continue;
    const substitutes =
      server.kind === "supplementary-image" &&
      Object.values(server.env).some((raw) => refsIn(raw).length > 0);
    if (!server.params && !substitutes) continue;
    out.push({
      slug: server.slug,
      prefix: `${server.slug}/static/`,
      when: server.kind === "supplementary-image" ? "deploy" : "runtime",
      via: server.params ? "params" : "env-ref",
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
export function prefixSuggestions(config: StradConfig): {
  prefix: string;
  wired: boolean;
  via?: "params" | "env-ref";
  slug: string;
}[] {
  const wired = new Map(paramsConsumers(config).map((c) => [c.slug, c.via]));
  return config.servers
    .filter((s) => s.enabled && !isUnhosted(s))
    .map((s) => ({
      slug: s.slug,
      // `static/` and not `oauth/`: this list is what the CREATE FORM offers, and
      // `oauth/` is the kind strad writes. A human typing a value into that
      // namespace is putting a hand-held credential where the console's consent
      // callback expects to be the only writer, and the suggestion list should
      // not propose it. Nothing refuses the path — resolution reads both kinds,
      // and an operator who means it may type it.
      prefix: `${s.slug}/static/`,
      wired: wired.has(s.slug),
      ...(wired.has(s.slug) ? { via: wired.get(s.slug)! } : {}),
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
  const match = SLUG_KIND.exec(rest);
  if (!match) {
    return {
      state: "unrouted",
      label: "unrouted",
      detail:
        `Not a ${mcpRoot}{server}/{${SERVER_PARAM_KINDS.join("|")}}/… path. Parameter ` +
        "resolution reads exactly those shapes, so nothing will pick this up.",
    };
  }

  const slug = match[1] as string;
  // match[2] is the KIND. It is matched so the path is recognised at all, and
  // deliberately not branched on below: both kinds resolve the same way, which
  // is the whole point of the second one.
  const tail = match[3] as string;
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

  if (isUnhosted(server)) {
    return {
      state: "unrouted",
      slug,
      label: "not wired",
      detail:
        `"${slug}" is a ${server.kind} server — strad runs no container for it and there is no ` +
        "environment to inject, so it can never consume a managed parameter.",
    };
  }

  // PER-SERVER SUBSTITUTION — the second way a value under `{slug}/static/`
  // reaches a server, and the one that needs no flag.
  //
  // A supplementary server's `env:` `${NAME}` refs resolve from its OWN
  // namespace before the gateway's (src/deploy/server-namespaces.ts), so a
  // parameter whose variable matches one of those names is delivered at deploy
  // time even with `params: false`. Reporting it `not wired` would be the same
  // false claim in the other direction: a human seeds a credential the renderer
  // does read, and this page tells them nothing does.
  const variable = tail.slice(tail.lastIndexOf("/") + 1);
  const substituted =
    server.kind === "supplementary-image" &&
    Object.values(server.env).some((raw) => refsIn(raw).includes(variable));

  // A CONNECTOR VARIABLE IS READ WITHOUT BEING REFERENCED. `oauth:` names three
  // variables that the app-spec renderer injects from this slug's own namespace
  // with no `${NAME}` anywhere in the config (src/deploy/appspec.ts), so the
  // `${NAME}` test above is blind to them. Reporting the credential a human just
  // consented to as "stored, not delivered" is precisely the false claim this
  // module exists to prevent, in the direction that wastes an afternoon.
  const connectorVariable =
    server.oauth !== undefined &&
    [
      server.oauth.clientIdVariable,
      server.oauth.clientSecretVariable,
      server.oauth.refreshTokenVariable,
    ].includes(variable);

  if (!server.params && !substituted && !connectorVariable) {
    return {
      state: "not-wired",
      slug,
      label: "not wired",
      detail:
        `Stored, but not delivered: the "${slug}" server does not set \`params: true\` in ` +
        `strad's config, so nothing resolves this path into its environment — it reads its ` +
        `${server.kind === "builtin" ? "options:" : "env:"} map instead. Wire it by setting ` +
        (server.kind === "supplementary-image"
          ? `\`params: true\`, or by referencing this name from that map — \`${variable}: "\${${variable}}"\`. ` +
            "Either is a config change plus a deploy."
          : "`params: true`. That is a config change plus a deploy."),
    };
  }

  const when =
    server.kind === "supplementary-image" &&
    (server.params || substituted || connectorVariable)
      ? "deploy"
      : "runtime";

  if (!resolver) {
    return {
      state: "not-wired",
      slug,
      when,
      label: "no resolver",
      detail: server.params
        ? `"${slug}" sets \`params: true\`, but that is only half of it. ${NO_RESOLVER}`
        : `"${slug}" references \`\${${variable}}\` in its env:, but that is only half of it. ` +
          NO_RESOLVER.replace(
            "so `params: true` resolves to nothing",
            "so this namespace is never consulted and the reference falls back to " +
              gatewayRoot,
          ),
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
        ? connectorVariable && !server.params && !substituted
          ? `Delivered: "${slug}" declares an \`oauth:\` connector and this is one of the three ` +
            `variables it owns, so render-spec injects it onto that container at DEPLOY time — ` +
            `with no \`\${NAME}\` reference anywhere in the config, which is what breaks the ` +
            `ordering cycle a connector would otherwise have. A value reaches the server on the ` +
            `next deploy, not immediately.`
          : server.params
            ? `Delivered: "${slug}" sets \`params: true\`, so render-spec resolves this path at ` +
              "DEPLOY time and injects it onto that container. A new or rotated value reaches the " +
              "server on the next deploy, not immediately."
            : `Delivered: "${slug}" references \`\${${variable}}\` in its env:, and a server's own ` +
              "namespace is resolved before the gateway's — so render-spec substitutes THIS value at " +
              "DEPLOY time, ahead of any same-named value in " +
              `${gatewayRoot}. A rotation reaches the server on the next deploy, not immediately.`
        : `Delivered: "${slug}" sets \`params: true\` and runs a strad image, so this path is ` +
          `resolved at RUNTIME and refreshed within gateway.secrets.ttlSeconds (${config.gateway.secrets.ttlSeconds}s).`) +
      deep,
  };
}
