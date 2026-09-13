import type { Request, RequestHandler, Response } from "express";
import {
  authenticateMcp,
  Unauthenticated,
  type Principal,
} from "../auth/index.ts";
import type { TokenStore } from "../auth/tokens.ts";
import type { StradConfig } from "../config/schema.ts";
import { asyncRoute, jsonFailure } from "./async-route.ts";
import { entitledServers } from "../gateway/entitlements.ts";
import type { SecretBag } from "../secrets/index.ts";
import type { ServerSecretProviders } from "../secrets/provider/index.ts";
import {
  gatewayNamespace,
  staticNamespace,
} from "../secrets/parameters/namespace.ts";
import {
  RESOLVER_ENV,
  type ParameterStore,
} from "../secrets/parameters/index.ts";
import type { BundlePresence } from "../gateway/bundle-presence.ts";
import type { StoreDiagnostics } from "../secrets/store-diagnostics.ts";
import {
  readDeploymentSecretStatus,
  storeProject,
  tally,
  type SecretReading,
  type SecretState,
  type ServerState,
} from "../ui/secret-status.ts";
import { event } from "../telemetry/index.ts";
import { errorSummary } from "../util/error-text.ts";

/**
 * `GET /api/secrets/readiness` — the machine's answer to "is the secrets side of
 * this gateway wired up?"
 *
 * ## Why this exists as its own surface
 *
 * Zimmer, the platform app that points agents at strad, needs to know whether
 * Google Secret Manager and Parameter Manager are fully wired before it can tell
 * a human that a connector is usable. Until now the only place that answer
 * existed was an SSO-gated HTML page, and a page is not an answer a program can
 * hold: it would have to be scraped, and a scraper breaks the first time the
 * copy changes.
 *
 * ## The three shape decisions, and why each one
 *
 * **1. A static bearer token, never OAuth — and entitlement to match the scope.**
 * The consumer is a machine holding a single long-lived credential
 * (`STRAD_API_KEY`). The Google-SSO path exists to put a human identity in front
 * of the console, and a machine has none — so this authenticates exactly the way
 * `/mcp` does, through `authenticateMcp`, against the same `STRAD_TOKENS` roster
 * and the same environment check. No new credential, no new trust boundary,
 * nothing to rotate separately. Authorization is then narrower than /mcp's rather
 * than absent: the report is deployment-wide, so it takes a token entitled to
 * every enabled server, and answers 403 to anything less.
 *
 * **2. Always 200, with the verdict in the body.** The tempting alternative is
 * 503-when-not-ready. It is wrong here for two reasons: an App Platform ingress
 * treats an upstream 5xx as its own failure and can rewrite it, so the body a
 * caller sees would be the ingress's; and "not ready" is a correct, complete,
 * successfully computed answer. The request succeeded. `ready: false` is the
 * result, not an error. Only auth failures and an unhandled crash are non-200.
 *
 * **3. Derived from the SAME code as the console.** `readSecretStatus` is shared
 * with `/connectors`. A JSON field and a badge computed by two paths would drift, and the
 * entire value of this endpoint is that a platform app can trust it says what the
 * page says.
 *
 * ## What it never contains
 *
 * A secret value. Names, canonical paths, states and sentences about shapes —
 * the same line `src/ui/secret-status.ts` holds, for the same reason, and
 * `test/readiness.test.ts` is the canary that enforces it.
 */

/** The JSON body. Every field is stable; a consumer may key on any of them. */
export interface ReadinessReport {
  /**
   * The single boolean a caller can branch on: the store is wired, every
   * enabled server's secrets were OBSERVED to resolve, and every required boot
   * key is present.
   *
   * It is deliberately conservative. A server whose secrets could not be checked
   * from this process (`unverified`) or whose backend did not answer (`unknown`)
   * makes this `false`, because `true` has to mean "observed", not "not known to
   * be broken". `servers.states` below carries the distinction for a caller that
   * wants to treat them differently.
   */
  ready: boolean;
  /** `gateway.env` — which deployment answered. */
  env: string;
  /** Everything about the store itself, independent of any one server. */
  store: StoreReadiness;
  servers: {
    /** Enabled servers. Disabled ones are not mounted and are not counted. */
    total: number;
    /** Observed to have everything they reference. */
    ready: number;
    /** Everything else, including "could not be checked". */
    issues: number;
    /** The full breakdown, for a caller that wants more than the boolean. */
    states: Record<ServerState, number>;
  };
  /** One entry per non-ready server, worst first. Never a value. */
  issues: ServerIssue[];
  /** The gateway's own boot keys. Without STRAD_TOKENS nothing else matters. */
  boot: BootKey[];
}

export interface StoreReadiness {
  /** `gateway.secrets.provider`: "env" or "gcp-parameter-store". */
  provider: string;
  /**
   * Whether the store is fully wired for this deployment.
   *
   * Under `gcp-parameter-store` that means this process holds the resolver
   * credential, because `params: true` and a store-backed provider both resolve
   * to nothing without it. Under `env` it is true by definition: there is no
   * store to wire, the deploy bakes values in, and reporting `false` would make
   * every `env` deployment permanently un-ready for a reason that is not a fault.
   */
  wired: boolean;
  /** The GCP project the store lives in. */
  project: string;
  /** True when `project` is the naming convention rather than a declaration. */
  projectGuessed: boolean;
  /** Where the gateway's own `${NAME}` references are read from. */
  gatewayNamespace: string;
  /** Whether STRAD_PARAMS_PROJECT_ID + the resolver key are both present here. */
  resolverCredential: boolean;
  /** One sentence naming what is wired and what is not. */
  detail: string;
  /**
   * How the store's own account of itself was obtained, and when.
   *
   * Null when there was none: no resolver credential, so `unrenderable` was not
   * a distinction this report could draw. Otherwise the pair of reads behind it
   * is TTL-cached, and `ageSeconds` is how old the answer is — 0 on a pass that
   * just ran. A poller is entitled to know it is being served a cached verdict,
   * and how stale it may be before it is refreshed.
   */
  diagnosis: StoreDiagnosis | null;
}

export interface StoreDiagnosis {
  /** Age of the underlying index + render reads, in seconds. */
  ageSeconds: number;
  /** True when the index read succeeded. False means "not read", not "empty". */
  indexRead: boolean;
  /** True when the per-parameter render pass ran. */
  renderRead: boolean;
}

export interface ServerIssue {
  slug: string;
  /** The per-server state: missing / placeholder / unverified / unknown. */
  state: ServerState;
  /** One sentence, the same one the console entry carries. */
  summary: string;
  /** Only the requirements that are NOT present. */
  secrets: SecretIssue[];
}

export interface SecretIssue {
  /** The `${NAME}` as the config spells it. */
  name: string;
  state: SecretState;
  /**
   * True when this is a MANAGED PARAMETER rather than a `${NAME}` reference — a
   * value that lives only under its server's static namespace, carried in
   * `path`, with no Secret Manager route.
   *
   * It is also the discriminator between two entries with the same `name`: a
   * `params: true` server can declare `${FOO}` while its component manifests a
   * managed parameter `FOO`, and those are two claims with two homes (see
   * ui/secret-status.ts).
   */
  managed?: true;
  /** "GSM" | "ENV", or null when the backend could not be consulted. */
  source: string | null;
  /** Which process's environment the value has to land in. */
  deliveries: string[];
  /** The canonical parameter path, when the store is where it goes. */
  path?: string;
  /** The Secret Manager secret name the deploy reads, when that is the route. */
  secretManagerName?: string;
  /** The console's own sentence. Describes shapes and paths, never bytes. */
  detail: string;
}

export interface BootKey {
  name: string;
  state: SecretState;
  required: boolean;
  detail: string;
}

/**
 * `missing` is worse news than `unconfigured`, which is worse than
 * `unrenderable`, which is worse than `placeholder`, which is worse than
 * `unknown`, which is worse than `unverified`.
 */
const ISSUE_RANK: Record<ServerState, number> = {
  missing: 6,
  // Below `missing`: both are a server with no value, and the difference is
  // whether anyone knew. A name nobody seeded is a server broken by an
  // oversight; a deferred one is a plan somebody has not finished. Above
  // `unrenderable` for the reason `missing` is — there is no value at all.
  unconfigured: 5,
  // Between the two above and `placeholder`, matching STATE_RANK in
  // ui/secret-status.ts. A caller sorting by severity and a page sorting by
  // severity must not disagree about which row is worse.
  unrenderable: 4,
  placeholder: 3,
  unknown: 2,
  unverified: 1,
  ready: 0,
  "no-secrets": 0,
};

export interface BuildReadinessOptions {
  config: StradConfig;
  env: NodeJS.ProcessEnv;
  reading: SecretReading;
}

export function buildReadiness(opts: BuildReadinessOptions): ReadinessReport {
  const { config, env, reading } = opts;
  const store = storeReadiness(config, env, reading.storeDiagnosis);
  const states = tally(reading.statuses);

  const issues: ServerIssue[] = reading.statuses
    .filter((s) => s.state !== "ready" && s.state !== "no-secrets")
    .map((s) => ({
      slug: s.server.slug,
      state: s.state,
      summary: s.summary,
      secrets: s.requirements
        .filter((o) => o.state !== "present")
        .map((o) => ({
          name: o.requirement.name,
          state: o.state,
          source: o.source,
          deliveries: o.requirement.deliveries,
          // A MANAGED PARAMETER HAS ONE HOME, AND IT IS NEITHER OF THE TWO
          // BELOW. It is not a `${NAME}` reference: nothing resolves it from the
          // gateway namespace and nothing reads `strad-<env>-<NAME>` for it, so
          // naming those would send a caller at resources that change nothing —
          // the same branch fixTargets() takes for the console. `managed` is
          // also what tells two entries apart where one name carries both a
          // reference row and a managed-parameter row.
          ...(o.requirement.managed
            ? {
                managed: true as const,
                path: `${staticNamespace(
                  config.gateway.env,
                  o.requirement.paramsSlugs[0] ?? s.server.slug,
                )}${o.requirement.name}`,
              }
            : {
                // Both routes are named because both are real: a store-backed
                // deployment reads the path at runtime, and every deployment can
                // seed the Secret Manager secret the render bakes in. A
                // `consoleEnv:`-only name gets the Secret Manager name alone —
                // the store is deliberately not a route for it (see fixTargets).
                ...(o.requirement.deliveries.length === 1 &&
                o.requirement.deliveries[0] === "console"
                  ? {}
                  : {
                      path: `${gatewayNamespace(config.gateway.env)}${o.requirement.name}`,
                    }),
                secretManagerName: `strad-${config.gateway.env}-${o.requirement.name}`,
              }),
          detail: o.detail,
        })),
    }))
    .sort((a, b) => ISSUE_RANK[b.state] - ISSUE_RANK[a.state]);

  const boot: BootKey[] = reading.boot.map((b) => ({
    name: b.observation.requirement.name,
    state: b.observation.state,
    required: b.required,
    detail: b.observation.detail,
  }));

  const bootOk = boot.every((b) => !b.required || b.state === "present");

  return {
    ready: store.wired && issues.length === 0 && bootOk,
    env: config.gateway.env,
    store,
    servers: {
      total: reading.statuses.length,
      ready: states.ready + states["no-secrets"],
      issues: issues.length,
      states,
    },
    issues,
    boot,
  };
}

/**
 * Is the store itself wired, independent of what is in it?
 *
 * This is the half a caller most often actually means by "is GSM set up": not
 * "is every credential seeded" but "can this gateway reach the store at all".
 * They are different failures with different fixes — a missing parameter is a
 * value to create, a missing resolver credential is a deploy — so they are
 * separate fields rather than one merged verdict.
 */
function storeReadiness(
  config: StradConfig,
  env: NodeJS.ProcessEnv,
  diagnosis: StoreDiagnostics | null,
): StoreReadiness {
  const provider = config.gateway.secrets.provider;
  const storeBacked = provider !== "env";
  const resolverCredential = Boolean(
    env[RESOLVER_ENV.projectId] && env[RESOLVER_ENV.keyJson],
  );
  const { project, guessed } = storeProject(config, env);

  return {
    provider,
    wired: storeBacked ? resolverCredential : true,
    project,
    projectGuessed: guessed,
    gatewayNamespace: gatewayNamespace(config.gateway.env),
    resolverCredential,
    diagnosis: diagnosis
      ? {
          ageSeconds: Math.round(diagnosis.ageMs / 1000),
          indexRead: diagnosis.indexRead,
          renderRead: diagnosis.renderRead,
        }
      : null,
    detail: storeBacked
      ? resolverCredential
        ? `gateway.secrets.provider is "${provider}" and this process holds the resolver ` +
          `credential, so \${NAME} references are read from the parameter store at runtime.`
        : `gateway.secrets.provider is "${provider}", but this process holds no resolver ` +
          `credential (${RESOLVER_ENV.projectId} and ${RESOLVER_ENV.keyJson} are not both ` +
          `set), so nothing reads the store and every reference resolves to nothing.`
      : `gateway.secrets.provider is "env": the deploy reads strad-${config.gateway.env}-* ` +
        `from Secret Manager and bakes each referenced name into the app spec, and the ` +
        `running container holds no store credential. There is nothing further to wire.` +
        (resolverCredential
          ? ` A resolver credential IS present, so \`params: true\` servers resolve their ` +
            `managed parameters as well.`
          : ` No resolver credential is present, so \`params: true\` resolves to nothing.`),
  };
}

export interface ReadinessHandlerOptions {
  config: StradConfig;
  tokenStore: TokenStore;
  env: NodeJS.ProcessEnv;
  /** The boot bag, for a `consoleEnv:` value that lands under its declared key. */
  secrets: SecretBag;
  /** The runtime provider, when the deployment has one. */
  secretProvider?: ServerSecretProviders;
  /** Test seam: the transport the bundle presence probe uses. */
  fetchImpl?: typeof fetch;
  /** Test seam: an already-probed bundle report. */
  presence?: BundlePresence;
  /** Test seam: the store the four-state diagnosis reads. */
  diagnosticStore?: Pick<ParameterStore, "list" | "resolveDetailed"> | null;
}

export function createReadinessHandler(
  opts: ReadinessHandlerOptions,
): RequestHandler {
  // Guarded by `asyncRoute` (src/http/async-route.ts): an unhandled rejection
  // would leave the caller's request open until its own timeout, which for a
  // machine consumer is the worst answer of the three (worse than a 500, which
  // at least tells it something) — and in this process it would also exit the
  // container. The two `try` blocks below stay: they answer 401 and
  // `readiness_failed` specifically, and a catch-all cannot.
  return asyncRoute(
    async (req: Request, res: Response) => {
      let principal: Principal;
      try {
        principal = await authenticateMcp(
          req.headers.authorization,
          opts.tokenStore,
          opts.config.gateway.env,
        );
      } catch (err) {
        if (err instanceof Unauthenticated) {
          // The same opaque 401 /mcp returns. Telling a caller WHICH half of their
          // token failed tells an attacker which half they got right.
          res
            .status(401)
            .json({ error: "unauthenticated", message: "invalid token" });
          return;
        }
        res.status(500).json({ error: "readiness_failed" });
        return;
      }

      // AUTHENTICATED IS NOT ENTITLED, and this report is deployment-wide.
      //
      // `/mcp` narrows the identical credential through entitledServers() — the
      // query string proposes, the token disposes — so a surface that authenticated
      // like /mcp and then answered for EVERY server would be a strict widening on
      // the same token: a narrow role would learn every slug, every referenced
      // secret NAME, the canonical paths, the project id, and the presence state of
      // strad's own boot keys.
      //
      // The report cannot be meaningfully narrowed instead, because `ready` is a
      // claim about the GATEWAY. A per-token subset would make the same field mean
      // different things to different callers, which for a machine consumer is
      // worse than a refusal. So the credential has to match the scope: entitled to
      // every enabled server, or nothing. Zimmer's `admin` token (`servers: ["*"]`)
      // passes; a per-server token does not.
      const entitled = entitledServers(principal, opts.config);
      const enabled = opts.config.servers.filter((s) => s.enabled);
      if (enabled.some((s) => !entitled.has(s.slug))) {
        res.status(403).json({
          error: "forbidden",
          message:
            "This report covers every server on the gateway, so it requires a token " +
            "entitled to every server on the gateway.",
        });
        return;
      }

      try {
        const reading = await readDeploymentSecretStatus({
          config: opts.config,
          bag: opts.secrets,
          env: opts.env,
          secretProvider: opts.secretProvider,
          fetchImpl: opts.fetchImpl,
          presence: opts.presence,
          store: opts.diagnosticStore,
        });

        // The RESPONSE is never cached: the answer changes the moment someone
        // seeds a value, and a stale `ready: false` held by an intermediary is
        // exactly the thing that would keep a fixed connector looking broken.
        //
        // What is bounded rather than instant is the store READING behind it, and
        // by one number: `gateway.secrets.ttlSeconds`. Each `${NAME}` lookup is
        // performed per request but answered from the runtime provider's
        // namespace snapshot, which that TTL governs; the store's own account of
        // itself (the index + render pass) is held for the same TTL, capped at a
        // minute, so a hard poller cannot turn this endpoint into a full render
        // pass per request. The second one declares its staleness rather than
        // hiding it: `store.diagnosis.ageSeconds` says how old those reads are.
        res.set("cache-control", "no-store");
        res.json(
          buildReadiness({ config: opts.config, env: opts.env, reading }),
        );
      } catch (err) {
        // `observe()` already degrades a sick backend to per-name `error` states,
        // so reaching here means something structural failed. The message is
        // withheld rather than echoed: this is the one path whose error text did
        // not come from code that promises to be value-free.
        event({
          evt: "strad.readiness_failed",
          error: errorSummary(err),
        });
        if (!res.headersSent)
          res.status(500).json({ error: "readiness_failed" });
      }
      // The route's own word, not `internal_error`: a machine consumer switching
      // on `error` should not meet a second shape on the same status.
    },
    jsonFailure("readiness", { error: "readiness_failed" }),
  );
}
