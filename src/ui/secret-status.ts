import { isUnhosted, unhostedRefFields } from "../config/schema.ts";
import type { ServerConfig, StradConfig } from "../config/schema.ts";
import type { SecretBag } from "../secrets/index.ts";
import { refsIn } from "../secrets/provider/resolve.ts";
import {
  CORE_BOOT_ENV_KEYS,
  REQUIRED_BOOT_ENV_KEYS,
} from "../secrets/provider/hydrate.ts";
import {
  gatewayNamespace,
  normaliseNamespace,
  staticNamespace,
} from "../secrets/parameters/namespace.ts";
import { resolveServerView, serverLooksSecrets } from "./resolve.ts";
import {
  parseServiceAccount,
  resolverFromEnv,
  RESOLVER_ENV,
  type ParameterStore,
} from "../secrets/parameters/index.ts";
import { mcpNamespace } from "../deploy/server-namespaces.ts";
import { waiversBySlug } from "../deploy/unseeded.ts";
import { errorSummary } from "../util/error-text.ts";
import { withDeadline } from "../util/deadline.ts";
import {
  placeholderReason,
  reasonFor,
  type Presence,
  type PresenceReport,
  type PresenceVerdict,
} from "../secrets/presence.ts";
import {
  probeBundles,
  refDelivery,
  type BundlePresence,
} from "../gateway/bundle-presence.ts";
import {
  forgetStoreDiagnosis,
  readStoreDiagnosticsCached,
  type StoreDiagnostics,
} from "../secrets/store-diagnostics.ts";

/**
 * "Is the strad side of this connector broken?" — derived, not asserted.
 *
 * A `${NAME}` that is not seeded is discoverable today at exactly one moment:
 * the deploy, when `scripts/render-spec.ts` refuses to render (or
 * `preflightSecrets` refuses to pass). That is the wrong place to find out, and
 * it is no help at all to someone standing in front of a connector that returns
 * 401 and asking whether strad is the reason. This module answers that question
 * from the running config, before and independently of any deploy.
 *
 * ## The two things that make this honest rather than reassuring
 *
 * **1. SEEDED IS NOT WORKING.** A present value proves a value exists, and
 * nothing else. strad does not call an upstream to prove a credential is
 * accepted, so the good state here is `ready` — "everything it needs is
 * present" — never "healthy". Where a value is cheaply, obviously fake (see
 * `placeholderReason`) that gets its own state, because a page that reported a
 * placeholder token as fine would be worse than no page: prod's `granola` boots,
 * lists, and 401s in isolation on exactly that shape.
 *
 * **2. NOT VISIBLE HERE IS NOT MISSING.** This code runs in CORE. A
 * supplementary image's `env:` is resolved at render time and injected onto its
 * BUNDLE — `appspec.ts` never broadcasts it — so core cannot see it, and a
 * presence check that answered "missing" would report the entire fleet broken on
 * a perfectly healthy deployment. That case is `unobservable`, and it says which
 * process would have to be asked. (`src/ui/resolve.ts` carries the scar from the
 * near-miss version of this mistake: the console reported a missing admin
 * credential in prod with the value sitting in core's environment under the key
 * one line below.)
 *
 * Where the deployment IS store-backed the picture is better, not worse: the
 * store holds the deploy-time source of truth for a bundle-scoped ref too, so
 * `gcp-parameter-store` deployments get a real answer for every name — the same
 * answer `render-spec` would compute, one deploy earlier.
 *
 * ## No value is ever displayed, and none is ever put in a message
 *
 * Every string this module produces is built from NAMES, PATHS and STATES. The
 * placeholder check reads a value and returns a reason that describes the shape
 * it matched, never the bytes — `test/ui.secret-status.test.ts` asserts that
 * across a table of hostile values.
 */

// ---------------------------------------------------------------------------
// Requirements: what each server needs, and where the value has to land
// ---------------------------------------------------------------------------

/**
 * Which process's environment a resolved value ends up in. This is what decides
 * whether core can observe it at all.
 *
 *   gateway — a remote-http url/headers, or a builtin's options. Resolved by the
 *             gateway process itself, on the request path. Observable here.
 *   bundle  — a supplementary image's `env:`. Baked onto that component at render
 *             time. NOT observable here under the `env` provider.
 *   console — a supplementary image's `consoleEnv:`. Lands on core, but under the
 *             declared KEY, never under the ref name (see resolve.ts). Observable
 *             here, by key.
 */
export type Delivery = "gateway" | "bundle" | "console";

export interface SecretRequirement {
  /** The `${NAME}` as the config spells it. */
  name: string;
  /** Every way this deployment delivers it, in a stable order. */
  deliveries: Delivery[];
  /** Enabled server slugs that declare it, in config order. */
  slugs: string[];
  /**
   * The env KEYs a `console` delivery lands under on core.
   *
   * A rendered spec carries the resolved VALUE filed under the key, not the ref
   * name, so this is the only thing there is to look for.
   */
  consoleKeys: string[];
  /**
   * Slugs whose `params: true` namespace is a legitimate place to put this,
   * because that server's own parameters are resolved into its environment.
   */
  paramsSlugs: string[];
  /**
   * This IS a managed parameter, rather than a `${NAME}` reference that a
   * `params: true` server happens to also declare.
   *
   * The two want opposite fix guidance and there is no way to tell them apart
   * from the name: a reference is resolved from the GATEWAY namespace or the
   * deploy environment and putting it under the server's own namespace does
   * nothing, while a managed parameter lives ONLY under that server's namespace
   * and the gateway route does nothing for it. Guessing wrong sends a reader to
   * create a resource that changes none of what they are looking at.
   */
  managed?: boolean;
}

/**
 * Every secret one server requires, in declaration order, before deduplication.
 *
 * An unhosted server's refs are walked out of `unhostedRefFields` — `url`,
 * `headers` and a remote-http's `oauthRefresh:` — rather than the whole object,
 * so a `${...}`-looking string in a `description` cannot invent a requirement.
 * Same reasoning for a builtin: only `options` can carry one.
 */
function requirementsOf(
  server: ServerConfig,
): { name: string; delivery: Delivery; consoleKey?: string }[] {
  const out: { name: string; delivery: Delivery; consoleKey?: string }[] = [];
  const push = (raw: string, delivery: Delivery, consoleKey?: string) => {
    for (const name of refsIn(raw)) out.push({ name, delivery, consoleKey });
  };

  // Both unhosted kinds carry the same two ref-bearing fields, and strad
  // resolves them in its own process because there is no container to inject.
  if (isUnhosted(server)) {
    for (const value of unhostedRefFields(server)) push(value, "gateway");
    return out;
  }

  if (server.kind === "builtin") {
    for (const value of Object.values(server.options)) {
      if (typeof value === "string") push(value, "gateway");
    }
    return out;
  }

  for (const value of Object.values(server.env)) push(value, "bundle");
  // The gateway proxies to a supplementary image over the private network, so a
  // `headers:` ref is resolved by the gateway process, not by the container.
  for (const value of Object.values(server.headers)) push(value, "gateway");
  for (const [key, value] of Object.entries(server.consoleEnv)) {
    push(value, "console", key);
  }
  return out;
}

const DELIVERY_ORDER: Delivery[] = ["gateway", "console", "bundle"];

/**
 * Every distinct secret the enabled servers require, deduplicated by NAME.
 *
 * Deduplication is the point, not a tidiness pass. Every variant of a server
 * family declares its credentials identically and on purpose — with the secret on
 * only one variant, disabling THAT variant would silently strip it from its
 * siblings — so `OP_SERVICE_ACCOUNT_TOKEN_TADAS_RW` legitimately appears on two
 * entries and `GMAIL_*` on three. One unseeded secret shared by four variants is
 * one problem, and a page that listed it four times would bury the other three.
 *
 * Disabled servers contribute nothing: the gateway does not mount them, so their
 * secrets are not required for anything, and `render-spec` skips them too.
 */
export function collectRequirements(config: StradConfig): SecretRequirement[] {
  const byName = new Map<string, SecretRequirement>();
  const paramsSlugs = new Set(
    config.servers
      .filter((s) => s.enabled && !isUnhosted(s) && s.params)
      .map((s) => s.slug),
  );

  for (const server of config.servers) {
    if (!server.enabled) continue;
    for (const { name, delivery, consoleKey } of requirementsOf(server)) {
      let req = byName.get(name);
      if (!req) {
        req = {
          name,
          deliveries: [],
          slugs: [],
          consoleKeys: [],
          paramsSlugs: [],
        };
        byName.set(name, req);
      }
      if (!req.deliveries.includes(delivery)) req.deliveries.push(delivery);
      if (!req.slugs.includes(server.slug)) req.slugs.push(server.slug);
      if (consoleKey && !req.consoleKeys.includes(consoleKey)) {
        req.consoleKeys.push(consoleKey);
      }
      if (
        paramsSlugs.has(server.slug) &&
        !req.paramsSlugs.includes(server.slug)
      )
        req.paramsSlugs.push(server.slug);
    }
  }

  for (const req of byName.values()) {
    req.deliveries.sort(
      (a, b) => DELIVERY_ORDER.indexOf(a) - DELIVERY_ORDER.indexOf(b),
    );
  }
  return [...byName.values()];
}

/**
 * The gateway's OWN boot keys — the token store, the internal token, the console
 * OAuth client. Not any server's, which is why they are a separate roster.
 *
 * They belong on the console because the loop it serves starts with "point Zimmer
 * at a strad URL with the shared API token": without `STRAD_TOKENS` every /mcp
 * request is rejected and no amount of per-server READY means anything.
 */
export function bootRequirements(): {
  name: string;
  required: boolean;
}[] {
  const required = new Set<string>(REQUIRED_BOOT_ENV_KEYS);
  return CORE_BOOT_ENV_KEYS.map((name) => ({
    name,
    required: required.has(name),
  }));
}

// ---------------------------------------------------------------------------
// Placeholder detection
// ---------------------------------------------------------------------------

/**
 * The rule lives in `src/secrets/presence.ts` and is re-exported here.
 *
 * It moved because a BUNDLE has to apply the identical rule to the values core
 * cannot see, and that tree cannot import across the package boundary — so the
 * module is vendored, byte-identical, and `test/vendored.sync.test.ts` fails CI
 * if the copies drift. Two placeholder tables would mean one component calling
 * `change-me` filler and the other calling it a credential, in one list, under
 * one word.
 */
export { placeholderReason } from "../secrets/presence.ts";

// ---------------------------------------------------------------------------
// Observation
// ---------------------------------------------------------------------------

export type SecretState =
  /** Resolved, and nothing about the value says "placeholder". */
  | "present"
  /** Resolved, but evidently filler. Seeded is not working. */
  | "placeholder"
  /** The backend answered, and there is no such secret. */
  | "missing"
  /**
   * The parameter EXISTS and its value cannot be dereferenced.
   *
   * Neither healthy nor absent, and the two obvious labels are both lies: "not
   * seeded" sends someone to create a value that is already there (and a
   * `create` on an existing path fails with 409), and "unknown" says the store
   * did not answer when it answered clearly.
   *
   * The live cause is a secret parameter whose payload strad wrapped as a JSON
   * string: Parameter Manager refuses `:render` with `400 injection detected`
   * when the dereferenced value carries a quote, a brace or a newline. Every
   * structural credential — a service-account key, a PEM — is that shape. The
   * fix is a write, not a seed, and this state is what says so.
   */
  | "unrenderable"
  /** Correctly scoped away from this process. Cannot be checked from here. */
  | "unobservable"
  /** The backend could not be consulted. Not the same as absent. */
  | "error";

/**
 * WHICH BACKING STORE this value comes from, as a two-or-three-letter badge.
 *
 * The labels are `GSM` and `ENV` and they are not strad's own invention — Zimmer's
 * Connectors page uses the same two (plus `Rails Credentials`, which strad has no
 * equivalent of). The workflow is to read one screen and then the other and
 * compare, so a divergent spelling here — "secret-manager", "gcp", "process env" —
 * would defeat the point of having the badge at all. If Zimmer's labels change,
 * these change with them.
 *
 *   GSM — Google Secret Manager holds the bytes. Either read at runtime through
 *         the parameter store (whose secret parameters are `__REF__` pointers into
 *         Secret Manager), or seeded as `strad-<env>-<NAME>` and baked into the app
 *         spec at deploy time.
 *   ENV — strad reads it straight out of its own process environment.
 */
export type SecretSource = "GSM" | "ENV";

export const SOURCE_TOOLTIP: Record<SecretSource, string> = {
  GSM: "Google Secret Manager",
  ENV: "Process environment",
};

/**
 * WHO established this, and how current the answer is.
 *
 * The third word in the vocabulary, after presence and source. It is not
 * decoration: "the value is in the parameter store" and "the process serving
 * this server has the value" are different claims with different failure modes,
 * and before the presence probe existed the console could only ever make the
 * first. A reader who sees `plumbed` is entitled to know which of the two they
 * are being told.
 */
export interface SecretEvidence {
  /**
   *   core   — read out of this process's own environment.
   *   store  — read from the parameter store at runtime.
   *   bundle — reported by the component that holds it, over the private
   *            network, as presence and never as a value.
   *   none   — nothing established it.
   */
  by: "core" | "store" | "bundle" | "none";
  /** The component that answered, when one did. */
  component?: string;
  /** Its boot time, ISO. A process older than the last render holds older env. */
  bootedAt?: string;
  /** The image tag that answered, when it reported one. */
  image?: string;
}

export interface SecretObservation {
  requirement: SecretRequirement;
  state: SecretState;
  /** One sentence naming what was checked, and where. Never a value. */
  detail: string;
  /**
   * Which store the value comes from — or, when it is absent, which store it has
   * to be seeded in. `null` only when that cannot be established, which is the
   * `error` state: a backend that could not be consulted cannot be named as the
   * source either.
   */
  source: SecretSource | null;
  /** Who established the state above, and when. */
  evidence: SecretEvidence;
}

export interface ObserveOptions {
  config: StradConfig;
  /**
   * The runtime provider's read, narrowed to what this page needs.
   *
   * `null` MUST mean the backend answered and the name is absent; a throw MUST
   * mean the backend could not be consulted. Collapsing the two would turn an
   * outage into a wall of red "not seeded" — see secrets/provider/types.ts, which
   * holds the same line for the same reason.
   */
  lookup: SecretLookup;
  /**
   * Core's own environment. The only place a `consoleEnv:` value can be found,
   * because it is filed under the declared KEY and the ref name is deliberately
   * never injected anywhere.
   */
  bag: SecretBag;
  /**
   * What each bundle reports it actually holds, keyed by component name.
   *
   * The whole reason `unobservable` is a residue rather than the common case.
   * Absent (or an `unreachable`/`unsupported` outcome for a component) leaves the
   * rows exactly as honest as they were before: not observed, and saying which
   * process would have to be asked.
   */
  presence?: BundlePresence;
  /**
   * `${NAME}` -> the (component, KEY) pairs it is delivered under. From
   * `refDelivery(config)`; the probe speaks only in keys, and this is the join.
   */
  delivery?: Map<string, { bundle: string; key: string }[]>;
  /**
   * What the parameter store holds, and what it refuses to hand over.
   *
   * `list()` reads metadata and a `__REF__` pointer without dereferencing, and
   * `resolveDetailed()` renders each parameter on its own so one failure does
   * not end the loop — together they separate "not seeded" from "exists and
   * cannot be read" from "the store did not answer", which the ordinary read
   * path collapses into one null. Null when no resolver credential is present,
   * and then the distinction is simply not drawn.
   */
  store?: StoreDiagnostics | null;
  /**
   * Per-name deadline. One sick backend must degrade to `error` on that row and
   * must not hang the page or the other rows.
   */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 4000;

/**
 * Resolve every requirement CONCURRENTLY, each under its own deadline.
 *
 * Concurrency plus a per-name timeout is what makes "degrade gracefully" true
 * rather than intended: a store that hangs costs this page `timeoutMs` once, not
 * once per secret, and a store that throws costs it one `error` row.
 *
 * The fan-out is deliberately unbounded, and that is safe rather than lucky:
 * `StoreSecretProvider` reads a whole NAMESPACE and caches it behind
 * `view.ts`, which is single-flighted — so twenty concurrent `get()`s on a
 * cold cache open ONE connection to the store, not twenty. A future provider that
 * reads per name would need a semaphore here.
 */
export async function observe(
  requirements: SecretRequirement[],
  opts: ObserveOptions,
): Promise<SecretObservation[]> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return Promise.all(
    requirements.map(async (requirement) => {
      const found = await attemptRead(
        () => opts.lookup(requirement.name, requirement.slugs),
        timeoutMs,
        requirement.name,
      );
      return classify(requirement, found, opts);
    }),
  );
}

/** `{ ok: value }`, or `{ error: message }` for a throw or a timeout. */
type Attempt = { ok: string | null } | { error: string };

/**
 * One name's read, under its own deadline, reduced to something printable.
 *
 * The reduction is the point, and it lives HERE rather than inside
 * `withDeadline` so that the next reader of this page sees it: the wrapper is
 * generic and knows nothing about secrets, and the defence below is about
 * exactly one thing this page does.
 */
async function attemptRead(
  read: () => Promise<string | null>,
  timeoutMs: number,
  name: string,
): Promise<Attempt> {
  try {
    return { ok: await withDeadline(read, timeoutMs, name) };
  } catch (err) {
    // THIS IS THE ONE PIECE OF FREE-FORM TEXT ON THE PAGE THAT COMES FROM OUTSIDE
    // IT, AND A RAW `err.message` HERE LEAKS A SECRET.
    //
    // Not hypothetically. A store read ends in `decodeEnvelope` -> `JSON.parse`
    // over a `:render`ed payload — which is the dereferenced secret, in plaintext.
    // A truncated or corrupted envelope throws a `SyntaxError` whose message
    // embeds a window of the body it choked on, and on a COLD cache
    // `view.ts` re-throws it raw rather than serving stale values. That
    // message would land in `detail` and render, as visible text, on a page whose
    // entire claim is that it never prints bytes. Truncating to 200 characters
    // does not help: the window is ~30 characters and sits well inside the cap.
    //
    // `errorSummary` (`src/util/error-text.ts`) is the defence the repo wrote
    // for exactly this, and reusing it is the point — a `ParameterStoreError`
    // message is known safe
    // (method + resource, query and `:verb` stripped) and passes through; anything
    // else is reduced to its class name. The cap stays as a second belt.
    const summary = errorSummary(err);
    return {
      error:
        summary.length > 200
          ? `${summary.slice(0, 200)}… (truncated)`
          : summary,
    };
  }
}

/** Set, and not the empty string. An injected-but-empty var configures nothing. */
function nonEmpty(value: string | undefined): boolean {
  return value !== undefined && value !== "";
}

function classify(
  requirement: SecretRequirement,
  attempt: Attempt,
  opts: ObserveOptions,
): SecretObservation {
  const { bag } = opts;

  // ---------------------------------------------------------------------------
  // The `consoleEnv:` half is answered from the ENVIRONMENT ONLY — never from the
  // provider.
  //
  // Two mistakes are avoided here, and both of them are false answers about the
  // console's store-ADMIN credential, which is the most consequential secret on
  // the page.
  //
  // A FALSE GREEN. `render-spec` resolves `consoleEnv:` from the deploy
  // environment and refuses to read it from the store (see the `consoleOnly` set
  // there, and preflight.ts's `consoleEnvNames`), because filing the admin
  // credential inside the store would let the weaker resolver credential read the
  // stronger one. So on a store-backed deployment a provider hit on the ref NAME
  // proves nothing about what core can read: someone seeding
  // `/strad/{env}/gateway/static/SECRETS_ADMIN_KEY_JSON` would make this row go
  // green while `/ui/secrets` stayed dead. Consulting `attempt` for a console ref
  // is therefore wrong on exactly the deployment that matters.
  //
  // A FALSE NEGATIVE. A rendered spec carries the value under the declared KEY;
  // the ref NAME is deliberately injected nowhere. Checking only the name is the
  // bug src/ui/resolve.ts documents having shipped — `/ui/secrets` reported a
  // missing admin credential in production with the value one line below.
  //
  // So: the KEY first, then the ref name spelled directly in core's environment
  // (the `npm run dev` shape, and the order resolve.ts itself uses), and nothing
  // else.
  if (requirement.deliveries.includes("console")) {
    // A name can be BOTH a consoleEnv: key and a gateway-resolved ref, because
    // requirements are merged by NAME across servers: one server's consoleEnv:
    // and another's headers:/url:/options: collapse into one row. The console
    // rule below is authority for the console half ONLY — answering the whole row
    // from it would report `ready` while /mcp throws SecretNotFoundError on every
    // call to the other server (a false green), or `missing` for a gateway that
    // works fine (a false red). So when a gateway half exists, it is checked too
    // and the WORSE of the two wins, with the detail naming which half is which.
    const alsoGateway = requirement.deliveries.includes("gateway");
    const gatewayBad =
      alsoGateway && !("ok" in attempt && attempt.ok !== null)
        ? "error" in attempt
          ? `The gateway half could not be checked (${attempt.error}).`
          : `The GATEWAY half is NOT seeded: \${${requirement.name}} does not resolve for ` +
            `the process that answers /mcp, so every call to the server referencing it fails.`
        : "";

    const key = requirement.consoleKeys.find((k) => nonEmpty(bag[k]));
    const consoleValue = key
      ? (bag[key] as string)
      : nonEmpty(bag[requirement.name])
        ? (bag[requirement.name] as string)
        : undefined;

    if (consoleValue !== undefined && !gatewayBad) {
      return finish(requirement, consoleValue, {
        where: key
          ? `core's environment, under ${key} (declared by consoleEnv:)`
          : `core's environment, under \${${requirement.name}} itself`,
        source: "ENV",
        evidence: { by: "core" },
      });
    }
    if (consoleValue !== undefined && gatewayBad) {
      return {
        requirement,
        state: "error" in attempt ? "error" : "missing",
        source: "error" in attempt ? null : "GSM",
        evidence: "error" in attempt ? { by: "none" } : { by: "core" },
        detail:
          `The console half resolves from core's environment, but this name is ALSO a ` +
          `gateway reference and that half does not. ${gatewayBad}`,
      };
    }
    return {
      requirement,
      state: "missing",
      // Where it HAS to be seeded: the deploy environment, fed from Secret
      // Manager by the deploy workflow.
      source: "GSM",
      evidence: { by: "core" },
      detail:
        `Not seeded for the console: neither ${requirement.consoleKeys.join(" / ")} nor ` +
        `\${${requirement.name}} resolves on the core component. consoleEnv: is read from ` +
        `the deploy environment ONLY — never from the parameter store, because it carries ` +
        `the console's store-admin credential, so a value in the store does not fix this.` +
        (requirement.deliveries.includes("bundle")
          ? ` The same name is also declared under env:, and that half is baked onto the ` +
            `bundle separately — it may well be fine. This row is about the console half.`
          : ""),
    };
  }

  // ---------------------------------------------------------------------------
  // THE BUNDLE HALF, asked of the process that actually holds it.
  //
  // A supplementary server's `env:` is resolved at render time and injected onto
  // ITS component; core never receives it. So a question about it cannot end in "not visible here",
  // and under the `env` provider — which is what prod runs — that was most of the
  // fleet. The component answers for itself (src/gateway/bundle-presence.ts),
  // in presence and never in values.
  //
  // It takes precedence over the store read for a bundle-delivered name, and that
  // ordering is the point rather than an optimisation: the store says what the
  // NEXT deploy would bake, the component says what the process serving requests
  // right now actually holds. When they disagree, the second one is the one a
  // human debugging a 401 needs.
  const bundle = bundleHalf(requirement, opts);
  if (bundle && !requirement.deliveries.includes("gateway")) {
    return bundle;
  }
  if (bundle && requirement.deliveries.includes("gateway")) {
    // Both halves are real and either can be broken alone. Worst wins, and the
    // detail names which half is which — a row that said `ready` because the
    // bundle had it would be a false green for every /mcp call the gateway makes
    // with the same name.
    const gateway = gatewayHalf(requirement, attempt, opts);
    const gatewayWorse = STATE_RANK[gateway.state] > STATE_RANK[bundle.state];
    const winner = gatewayWorse ? gateway : bundle;
    const loser = gatewayWorse ? bundle : gateway;
    return {
      ...winner,
      detail: `${winner.detail} ${otherHalf(gatewayWorse ? "BUNDLE" : "GATEWAY", loser)}`,
    };
  }

  return gatewayHalf(requirement, attempt, opts);
}

/**
 * The clause describing the half that did NOT decide the row.
 *
 * The connective comes from the loser's own state rather than from which branch
 * won. Ranking picks the worse of two halves, and "worse" is satisfied by an
 * EQUAL rank too — so a row whose gateway and bundle halves are both unseeded
 * would otherwise read "NOT plumbed. … The GATEWAY half resolves too: not
 * seeded", a sentence that contradicts itself. A name declared in both `env:`
 * and `headers:` and seeded nowhere is the likeliest way to reach it.
 */
function otherHalf(
  which: "BUNDLE" | "GATEWAY",
  loser: SecretObservation,
): string {
  const verb =
    loser.state === "present" ? "resolves too" : "is also not usable";
  return `The ${which} half ${verb}: ${lowerFirst(loser.detail)}`;
}

/** Lower-case the first character of a sentence being spliced mid-paragraph. */
function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/**
 * What the store or this process's own environment says.
 *
 * The store-or-environment half of a row, extracted so a name delivered to BOTH
 * a bundle and the gateway can have each half answered on its own terms.
 */
function gatewayHalf(
  requirement: SecretRequirement,
  attempt: Attempt,
  opts: ObserveOptions,
): SecretObservation {
  const { config } = opts;
  const storeBacked = config.gateway.secrets.provider !== "env";
  const unrenderableReason = opts.store?.unrenderable.get(requirement.name);
  const indexed = opts.store?.indexed.has(requirement.name) ?? false;
  const renderRead = opts.store?.renderRead ?? false;
  const renderedHere = opts.store?.rendered.has(requirement.name) ?? false;

  // THE FOURTH STATE, and it is checked FIRST because it is the only one of the
  // four established by a positive read rather than by the absence of one. The
  // store was asked to produce this value, named this parameter, and refused.
  // Everything below reasons from a null or a throw, which is weaker evidence.
  if (unrenderableReason) {
    return {
      requirement,
      state: "unrenderable",
      source: "GSM",
      evidence: { by: "store" },
      detail:
        `The parameter EXISTS and its value cannot be produced. ` +
        `${gatewayNamespace(config.gateway.env)}${requirement.name} is in the store and ` +
        `\`:render\` will not return it, so this is neither "not seeded" — creating it ` +
        `again fails with 409 — nor healthy. Rotate the value through the console, which ` +
        `rewrites the payload. Reason: ${unrenderableReason}`,
    };
  }

  if ("ok" in attempt && attempt.ok !== null) {
    // A bundle-scoped ref on a store-backed deployment is DEPLOY-TIME INPUT, not
    // a runtime read: render-spec reads the gateway namespace at render time and
    // bakes the value onto the component, and the running container never touches
    // the store. So "present" here is true and "the server has it" is not — a
    // value added after the last deploy makes this row green while the container
    // still holds nothing. Say which it is rather than letting the reader assume.
    const bundleOnly =
      storeBacked &&
      requirement.deliveries.includes("bundle") &&
      !requirement.deliveries.includes("gateway");
    // WHICH namespace is deliberately NOT guessed.
    //
    // The tempting inference — resolved, but absent from the gateway namespace's
    // index, therefore it came from a server's own namespace — is wrong two ways.
    // `envFallback` defaults to true, so a store-backed deployment can resolve a
    // name out of `process.env` and land in exactly that state; and with several
    // referencing servers there is no way to say WHICH namespace answered without
    // the lookup reporting it. So the sentence names the store and stops, and the
    // per-server path is described where it is actionable instead: in the fix
    // targets below.
    return finish(requirement, attempt.ok, {
      where: storeBacked ? "the parameter store" : "this process's environment",
      source: storeBacked ? "GSM" : "ENV",
      evidence: storeBacked ? { by: "store" } : { by: "core" },
      lands: bundleOnly
        ? " It reaches this server's container at the NEXT DEPLOY, not now: a " +
          "supplementary image's env: is baked at render time and the container never " +
          "reads the store."
        : "",
    });
  }

  if ("error" in attempt) {
    return {
      requirement,
      state: "error",
      // No source: a backend that could not be consulted cannot be named as the
      // one this value comes from. Guessing would be the same class of mistake as
      // reporting "not seeded" for a store that was merely down.
      source: null,
      evidence: { by: "none" },
      detail:
        `The secret backend could not be consulted for this name, so its status is ` +
        `unknown — NOT absent. Detail: ${attempt.error}`,
    };
  }

  // Answered with no value, and the store's index says the parameter is there.
  //
  // THREE conditions, and every one of them removes a false red that the obvious
  // one-condition version produces:
  //
  //   storeBacked — under the `env` provider `lookup` is core's own bag, which by
  //     design does not hold a bundle-scoped ref. Every listed parameter would
  //     then read `unrenderable` on a completely healthy deployment, telling an
  //     operator to rotate a working credential. That is worse than the shrug it
  //     replaced.
  //   renderRead — without a successful per-parameter render, "not among the
  //     values" means nothing was asked, not that nothing came back.
  //   !rendered  — a name the render DID return is the opposite of unrenderable.
  //
  // What survives all three is narrow and correct: a store-backed deployment
  // whose runtime read produced nothing for a name the store rendered nothing
  // for, and which the index says exists.
  if (indexed && storeBacked && renderRead && !renderedHere) {
    return {
      requirement,
      state: "unrenderable",
      source: "GSM",
      evidence: { by: "store" },
      detail:
        `The parameter EXISTS in the store's index and resolves to no value, so every ` +
        `reference to it gets nothing. That is not "not seeded" — the resource is there, ` +
        `and creating it again fails with 409. Rotate it through the console to write a ` +
        `payload that renders.`,
    };
  }

  // Answered, and absent. Whether that is a problem depends entirely on whether
  // this process was ever supposed to be able to see it.
  const onlyElsewhere =
    !storeBacked &&
    !requirement.deliveries.includes("gateway") &&
    requirement.deliveries.includes("bundle");

  if (onlyElsewhere) {
    return {
      requirement,
      state: "unobservable",
      // GSM even though this process cannot read it: the value was resolved from
      // `strad-<env>-<NAME>` in Secret Manager at render time and baked onto the
      // bundle. The badge names where it LIVES, which is the question a human
      // comparing this screen with Zimmer's Connectors page is asking.
      source: "GSM",
      evidence: { by: "none" },
      detail:
        `Declared only under a supplementary server's env:, which is baked onto that ` +
        `component at deploy time and never broadcast to core. ` +
        `${bundleShrugReason(requirement, opts)} It was present at the last successful ` +
        `deploy, because a missing one fails the render — but that is a claim about the ` +
        `deploy, not about the process running now.`,
    };
  }

  return {
    requirement,
    state: "missing",
    // Absent, so the badge names the store it must be seeded in — which is Secret
    // Manager on both paths: directly as `strad-<env>-<NAME>` under the `env`
    // provider, or as the Secret Manager secret a store-backed deployment's secret
    // parameter points at.
    source: "GSM",
    evidence: storeBacked ? { by: "store" } : { by: "core" },
    detail: storeBacked
      ? `Not seeded: ${gatewayNamespace(config.gateway.env)}${requirement.name} does not ` +
        `exist in the parameter store` +
        // Both layers, because both are checked. A reader told only about the
        // gateway path would seed there when the credential belongs to one
        // server — which is the shape this deployment is moving away from.
        (requirement.slugs.length
          ? `, and neither does it under the namespace of any server that ` +
            `references it (${requirement.slugs
              .map(
                (slug) =>
                  `${staticNamespace(config.gateway.env, slug)}${requirement.name}`,
              )
              .join(", ")})`
          : "") +
        `, so every value that references it resolves to nothing. ` +
        (requirement.deliveries.includes("bundle")
          ? `The next deploy fails in render-spec's baked-secret pass — preflight ` +
            `deliberately excludes a supplementary server's env:.`
          : `The next deploy's preflight will fail, by name.`)
      : `Not seeded: \${${requirement.name}} does not resolve from this process's ` +
        `environment. ` +
        (requirement.slugs.length
          ? `The gateway cannot build the value that references it.`
          : `The gateway reads this key directly at boot.`),
  };
}

// ---------------------------------------------------------------------------
// The bundle half
// ---------------------------------------------------------------------------

/**
 * Why a bundle-delivered name is still not observed, in the words that name the
 * remedy. The three reasons are genuinely different actions.
 */
function bundleShrugReason(
  requirement: SecretRequirement,
  opts: ObserveOptions,
): string {
  const targets = opts.delivery?.get(requirement.name) ?? [];
  const outcomes = targets
    .map((t) => opts.presence?.probes.get(t.bundle))
    .filter((o): o is NonNullable<typeof o> => o !== undefined);

  if (outcomes.length === 0) {
    return (
      `This gateway did not probe that component for presence, so nothing here ` +
      `established anything about it.`
    );
  }
  const unsupported = outcomes.find((o) => o.kind === "unsupported");
  if (unsupported && unsupported.kind === "unsupported") {
    return `The component could not answer: ${unsupported.detail}`;
  }
  const unreachable = outcomes.find((o) => o.kind === "unreachable");
  if (unreachable && unreachable.kind === "unreachable") {
    return `The component was asked and did not answer: ${unreachable.detail}`;
  }
  return (
    `The component answered but did not report on this key, which means the deploy ` +
    `did not bake it under the name this config declares.`
  );
}

/**
 * Ask the presence report about every (component, KEY) this name is delivered
 * under, and reduce to one verdict.
 *
 * Returns null when there is nothing to say — no bundle delivery, no probe, or a
 * component that could not answer — and the caller then falls back to the older,
 * weaker claim. That fallback is the whole reason this is safe to ship before the
 * bundle image is rebuilt: an old image degrades to exactly today's behaviour.
 *
 * WORST WINS across components. One ref legitimately lands on several bundles
 * (the capability variants declare their credentials identically on purpose), and
 * "present on one of the three" is not an answer anybody can act on.
 */
function bundleHalf(
  requirement: SecretRequirement,
  opts: ObserveOptions,
): SecretObservation | null {
  if (!requirement.deliveries.includes("bundle")) return null;
  const targets = opts.delivery?.get(requirement.name) ?? [];
  if (targets.length === 0 || !opts.presence) return null;

  const seen: {
    bundle: string;
    key: string;
    verdict: PresenceVerdict;
    report: PresenceReport;
  }[] = [];

  for (const target of targets) {
    const outcome = opts.presence.probes.get(target.bundle);
    if (!outcome || outcome.kind !== "ok") continue;
    const verdict = outcome.report.keys[target.key];
    if (!verdict) continue;
    seen.push({ ...target, verdict, report: outcome.report });
  }
  if (seen.length === 0) return null;

  const worst = seen.reduce((a, b) =>
    PRESENCE_RANK[b.verdict.presence] > PRESENCE_RANK[a.verdict.presence]
      ? b
      : a,
  );
  const where =
    seen.length === 1
      ? `${worst.bundle}, under ${worst.key}`
      : `${seen.length} components (worst: ${worst.bundle}, under ${worst.key})`;
  const evidence: SecretEvidence = {
    by: "bundle",
    component: worst.report.component,
    bootedAt: worst.report.bootedAt,
    ...(worst.report.image ? { image: worst.report.image } : {}),
  };

  // The value lives in that component's process environment either way: a
  // supplementary image's `env:` is baked into the app spec, whether the value
  // came from Secret Manager directly (the `env` provider) or out of the
  // parameter store at render time. ENV is where it is READ from, which is the
  // question the badge answers.
  const source: SecretSource = "ENV";

  switch (worst.verdict.presence) {
    case "present":
      return {
        requirement,
        state: "present",
        source,
        evidence,
        detail:
          `PLUMBED, via a process environment variable. The component holding it — ` +
          `${where} — was asked and reports a value. It was baked into the app spec at ` +
          `deploy time from ${gatewayNamespace(opts.config.gateway.env)}${requirement.name} ` +
          `or from strad-${opts.config.gateway.env}-${requirement.name} in Secret Manager. ` +
          `That proves a value EXISTS in the running container — strad does not call the ` +
          `upstream, so it is not a claim that the credential is accepted.`,
      };
    case "placeholder":
    case "unexpanded":
      return {
        requirement,
        state: "placeholder",
        source,
        evidence,
        detail:
          `Plumbed but not usable: ${reasonFor(worst.verdict.presence) ?? "the value is evident filler"}. ` +
          `The component holding it — ${where} — reports a value of that shape, so the ` +
          `server boots and lists tools normally and the upstream rejects every call. ` +
          `Rotate it to a real credential and redeploy that component.`,
      };
    case "empty":
      return {
        requirement,
        state: "placeholder",
        source,
        evidence,
        detail:
          `Plumbed but empty: ${where} holds this key set to the empty string, so whatever ` +
          `reads it gets nothing. Something DID inject a value here and the value was ` +
          `nothing — which is a different mistake from never seeding it, and it will not ` +
          `be fixed by creating the secret.`,
      };
    case "absent":
      return {
        requirement,
        state: "missing",
        source: "GSM",
        evidence,
        detail:
          `NOT plumbed. The component that would hold it — ${where} — was asked and does ` +
          `not have this key at all. Seed the value, then redeploy that component: a ` +
          `supplementary image's env: is baked at render time, so a value added to the ` +
          `store or to Secret Manager does not reach a running container on its own.`,
      };
  }
}

/** Worst-first across the five words. */
const PRESENCE_RANK: Record<Presence, number> = {
  absent: 4,
  empty: 3,
  unexpanded: 2,
  placeholder: 1,
  present: 0,
};

function finish(
  requirement: SecretRequirement,
  value: string,
  ctx: {
    where: string;
    source: SecretSource;
    evidence: SecretEvidence;
    lands?: string;
  },
): SecretObservation {
  const reason = placeholderReason(value);
  if (reason) {
    return {
      requirement,
      state: "placeholder",
      source: ctx.source,
      evidence: ctx.evidence,
      detail:
        `Seeded, but not usable: ${reason}. It resolves from ${ctx.where}, so the ` +
        `gateway boots and lists tools normally and the upstream rejects every call — ` +
        `which looks like a broken server rather than an unset secret. Rotate it to a ` +
        `real credential.`,
    };
  }
  return {
    requirement,
    state: "present",
    source: ctx.source,
    evidence: ctx.evidence,
    detail:
      `Resolves from ${ctx.where}. That proves a value EXISTS — strad does not call ` +
      `the upstream, so it is not a claim that the credential is accepted.` +
      (ctx.lands ?? ""),
  };
}

// ---------------------------------------------------------------------------
// The whole reading, in one call
// ---------------------------------------------------------------------------

/**
 * Read one `${NAME}`, on behalf of the servers that reference it.
 *
 * `null` means the backend answered and the name is absent; a throw means it
 * could not be consulted. `observe()` depends on that distinction — collapsing
 * the two would turn a store outage into a wall of red "not seeded", which is
 * the one failure mode that would make this page worse than nothing.
 *
 * The slugs are not decoration. A server's refs resolve from its OWN
 * `/strad/{env}/mcp/{slug}/static/` namespace before the shared one (see
 * src/secrets/provider), so a lookup that knew only the name would report a
 * per-server-seeded credential as missing on a deployment where it resolves
 * fine — the console's job is to say what the gateway will actually do.
 */
export type SecretLookup = (
  name: string,
  slugs?: readonly string[],
) => Promise<string | null>;

/** The structural half of `ServerSecretProviders` this module needs. */
export interface SecretLookupProviders {
  shared: { get(name: string): Promise<string | null> };
  forServer(slug: string): { get(name: string): Promise<string | null> };
}

export function secretLookup(
  bag: SecretBag,
  providers?: SecretLookupProviders,
): SecretLookup {
  if (!providers) return async (name: string) => bag[name] ?? null;
  return async (name: string, slugs?: readonly string[]) => {
    // NO SLUG TO ATTRIBUTE IT TO: a boot key, or a name every referencing server
    // was disabled out of. The shared provider is the whole answer.
    if (!slugs || slugs.length === 0) return providers.shared.get(name);

    // THE SHARED LAYER FIRST, and it settles the row on its own when it hits.
    //
    // Reading this the other way round — each slug's own provider in turn, first
    // hit wins — is wrong twice over, and both were live bugs.
    //
    // WRONG VERDICT. "Some slug resolves it" is not the question. Every layer-1
    // namespace falls back to this one, so a hit HERE means every referencing
    // server resolves the name; a hit in ONE server's namespace says nothing
    // about its peers. Two servers writing `Bearer ${SHARED_TOKEN}` with only
    // one of them seeded would read green while the other threw on every
    // request — the exact case `coveredPerServer` fails the deploy for.
    //
    // WRONG COST. Every per-server provider holds its own namespace snapshot,
    // and resolving a namespace enumerates the whole project. `observe()` fans
    // out over every requirement at once, so asking layer 1 first turned one
    // readiness poll into one full enumeration per referencing slug — dozens, to
    // learn that dozens of namespaces are empty. Asking the shared layer first
    // costs one read for the whole page, and reaches layer 1 only for a name
    // that is genuinely absent from it, which is the only case where layer 1
    // changes the answer.
    const shared = await providers.shared.get(name);
    if (shared !== null) return shared;

    // The shared layer missed, so the name resolves only if EVERY referencing
    // server holds it for itself. One short slug makes the row missing, and the
    // value of the last one is what gets classified — they are the same
    // credential's worth of evidence, and a placeholder in any of them is worth
    // reporting.
    let value: string | null = null;
    for (const slug of slugs) {
      const own = await providers.forServer(slug).get(name);
      if (own === null) return null;
      value = own;
    }
    return value;
  };
}

export interface SecretReading {
  /** One entry per ENABLED server, in config order. */
  statuses: ServerSecretStatus[];
  /** The gateway's own boot keys, and whether each is required. */
  boot: { observation: SecretObservation; required: boolean }[];
  /**
   * The store diagnosis these statuses were derived from, echoed back so a
   * surface can say WHEN it was read.
   *
   * Null when there was none — no resolver credential, so the four-state
   * distinction was simply not drawn. It is echoed rather than re-read because
   * the diagnosis is cached: "how old is this claim" is not answerable from the
   * statuses, and a surface that printed a cached verdict without its age would
   * be making a fresher claim than it holds.
   */
  storeDiagnosis: StoreDiagnostics | null;
}

/**
 * Read every referenced `${NAME}` once and derive both rosters.
 *
 * Shared by the human console (`/ui`) and the machine readiness endpoint
 * (`/api/secrets/readiness`) so the two can never disagree: a badge and a JSON
 * field that were derived separately would eventually drift, and the entire
 * point of the endpoint is that a platform app can trust it says what the page
 * says.
 */
export async function readSecretStatus(opts: {
  config: StradConfig;
  bag: SecretBag;
  lookup: SecretLookup;
  /** What each bundle reports it holds. Absent = the older, weaker claim. */
  presence?: BundlePresence;
  /** The store's own account of itself, for telling the four states apart. */
  store?: StoreDiagnostics | null;
  /**
   * The running gateway's environment — see `deriveServerStatuses`.
   *
   * REQUIRED, unlike every other reading input, because the branch it decides
   * fails toward a claim rather than toward silence: without it a `params: true`
   * builtin reads `inert`, "these are read by nothing, do not seed", which is
   * the most actionable sentence this feature prints and the worst one to print
   * wrongly. Both surfaces reach this through `readDeploymentSecretStatus`,
   * which is handed the environment it was built with.
   */
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<SecretReading> {
  const { config, bag, lookup, presence, store, env, timeoutMs } = opts;
  const delivery = refDelivery(config);

  const observations = await observe(collectRequirements(config), {
    config,
    lookup,
    bag,
    presence,
    delivery,
    store,
    timeoutMs,
  });

  // The gateway's own boot keys travel the same path, so they are observed the
  // same way. They carry no `consoleEnv:` key and no bundle scope, so they are
  // plain `gateway`-delivery requirements.
  const bootKeys = bootRequirements();
  const bootObservations = await observe(
    bootKeys.map(({ name }) => ({
      name,
      deliveries: ["gateway" as const],
      slugs: [],
      consoleKeys: [],
      paramsSlugs: [],
    })),
    { config, lookup, bag, store, timeoutMs },
  );

  return {
    statuses: deriveServerStatuses(config, observations, presence, env),
    boot: bootObservations.map((observation, i) => ({
      observation,
      required: bootKeys[i]?.required ?? false,
    })),
    storeDiagnosis: store ?? null,
  };
}

/**
 * One resolver client per process, not one per page load.
 *
 * `resolverFromEnv()` builds a client whose OAuth token cache lives on the
 * instance, so constructing a fresh one per request threw that cache away and
 * minted a new Google token on every `/ui` render and every readiness call. The
 * diagnostics read is already the most expensive thing on this path; paying for
 * an extra token exchange to perform it is pure waste.
 *
 * Keyed on the env object identity rather than memoised outright, because tests
 * hand this function different environments in one process and a single slot
 * would serve the first one's credential to all of them.
 */
const RESOLVERS = new WeakMap<NodeJS.ProcessEnv, ParameterStore | null>();

function cachedResolver(env: NodeJS.ProcessEnv): ParameterStore | null {
  if (RESOLVERS.has(env)) return RESOLVERS.get(env) ?? null;
  const store = resolverFromEnv(env);
  RESOLVERS.set(env, store);
  return store;
}

/**
 * Forget what the store told us, because we just changed what it holds.
 *
 * The console writes through the ADMIN client and reads through the RESOLVER
 * one, so the write path cannot drop the diagnosis by identity — this is the
 * join. Without it, `/ui` keeps a row saying "the parameter EXISTS and its value
 * cannot be produced — rotate it" for the rest of the TTL, one click after the
 * console flashed "Rotated ALPHA: a new value is now current". The store-derived
 * state is checked BEFORE the live read in `gatewayHalf`, so a cached refusal
 * outranks a value that now resolves: the page would contradict itself.
 *
 * Deliberately does NOT construct a resolver: a deployment with no resolver
 * credential has nothing cached, and building a client on the write path to
 * invalidate an empty cache would be pure cost.
 */
export function forgetDeploymentDiagnosis(opts: {
  env: NodeJS.ProcessEnv;
  /** Test seam: the same one `readDeploymentSecretStatus` takes. */
  store?: Pick<ParameterStore, "list" | "resolveDetailed"> | null;
}): void {
  const store = opts.store === undefined ? RESOLVERS.get(opts.env) : opts.store;
  if (store) forgetStoreDiagnosis(store);
}

/**
 * The whole reading, plus the evidence-gathering that makes it a claim.
 *
 * `/ui` and `/api/secrets/readiness` both call THIS rather than assembling the
 * pieces themselves. The two surfaces are supposed to say the same thing, and
 * the way they stop saying the same thing is one of them acquiring a source of
 * evidence the other does not have.
 *
 * Two reads happen before the classification, both optional, both incapable of
 * failing the page:
 *
 *   1. Every bundle is asked what it actually holds (`probeBundles`). This is
 *      what turns "not visible here" into "plumbed via env, on `bundle`".
 *   2. The parameter store is asked what it holds and what it will not render
 *      (`readStoreDiagnosticsCached`), whenever core has a resolver credential —
 *      which is true on a `provider: env` deployment that also uses
 *      `params: true`, so this is not gated on the flip. That pair of reads is
 *      the expensive half of this call and is held for `ttlSeconds` (capped at a
 *      minute), so a reload does not re-run it; the reading carries the age of
 *      what it served, and a console write drops it outright.
 *
 * Neither is required. With neither, this degrades exactly to the older, weaker
 * reading, which is what makes it safe to deploy core ahead of the bundle image.
 */
export async function readDeploymentSecretStatus(opts: {
  config: StradConfig;
  bag: SecretBag;
  env: NodeJS.ProcessEnv;
  secretProvider?: SecretLookupProviders;
  /** Test seam: the presence probe's transport. */
  fetchImpl?: typeof fetch;
  /** Test seam: the already-probed bundle report, skipping the transport. */
  presence?: BundlePresence;
  /** Test seam: the store to diagnose. Defaults to `resolverFromEnv(env)`. */
  store?: Pick<ParameterStore, "list" | "resolveDetailed"> | null;
  timeoutMs?: number;
}): Promise<SecretReading> {
  const [presence, store] = await Promise.all([
    opts.presence
      ? Promise.resolve(opts.presence)
      : probeBundles({
          config: opts.config,
          env: opts.env,
          fetchImpl: opts.fetchImpl,
        }),
    (async () => {
      const store =
        opts.store === undefined ? cachedResolver(opts.env) : opts.store;
      if (!store) return null;
      return readStoreDiagnosticsCached({
        store,
        namespace: gatewayNamespace(opts.config.gateway.env),
        // The same number the request path already uses to mean "how stale may
        // a store read be" (`gateway.secrets.ttlSeconds`), capped inside the
        // cache so a long rotation TTL cannot make a HEALTH signal a day old.
        ttlMs: opts.config.gateway.secrets.ttlSeconds * 1000,
      });
    })(),
  ]);

  return readSecretStatus({
    config: opts.config,
    bag: opts.bag,
    lookup: secretLookup(opts.bag, opts.secretProvider),
    presence,
    store,
    env: opts.env,
    timeoutMs: opts.timeoutMs,
  });
}

// ---------------------------------------------------------------------------
// Per-server status
// ---------------------------------------------------------------------------

export type ServerState =
  /** Every secret it needs resolves, and none looks like filler. */
  | "ready"
  /** It needs no secret at all. Nothing to seed, nothing to break. */
  | "no-secrets"
  /** At least one is definitively not seeded. */
  | "missing"
  /**
   * Everything it is short of, it declared it could deploy without.
   *
   * `missing` says nobody seeded a credential this server needs; this says the
   * config DECLARED that, listed the names in `mayBeUnseeded:`, and shipped the
   * server anyway rather than failing the deploy for the whole fleet (see
   * src/deploy/unseeded.ts). Both want the same action — seed the value — and
   * they are not the same news: one is an oversight and the other is a plan
   * halfway through, and a console that spelt them the same way would report a
   * deliberate deferral as a fault on every page load until somebody got round
   * to it.
   *
   * Still `isActionable`. A human finishes this; nothing else does.
   */
  | "unconfigured"
  /** At least one parameter exists and cannot be dereferenced. */
  | "unrenderable"
  /** At least one resolves to something evidently fake. */
  | "placeholder"
  /** At least one could not be checked from this process. */
  | "unverified"
  /** At least one backend read failed. */
  | "unknown";

export interface ServerSecretStatus {
  server: ServerConfig;
  state: ServerState;
  /** Chip text. */
  label: string;
  /** One sentence for the row, derived from the worst requirement. */
  summary: string;
  /**
   * This server's requirements, deduplicated within each PASS rather than across
   * the entry: one name can carry both a `${NAME}` reference row and a managed
   * parameter row, which are two claims about two different things. Tell them
   * apart by `requirement.managed`.
   */
  requirements: SecretObservation[];
  /**
   * Present when a `params: true` server's managed parameters went UNCHECKED —
   * no component named them, so not one of them produced a row.
   *
   * Set whether or not the entry has other requirements, because the gap is the
   * same fact either way. On a server that declares nothing else it is the whole
   * of the entry: the badge says ISSUE and the panel behind it would otherwise
   * be empty. On one that also declares a `${NAME}` it is the part the rows do
   * NOT cover, and the part a reader is owed — those rows are about names this
   * server references, not about the credentials it runs on.
   *
   * Either way it carries the three facts that make the panel worth opening:
   * which component holds the value, why this page did not establish it, and
   * where the value lives instead. WHICH component and WHY differ by kind — a
   * supplementary image's parameters are on a container core could not ask, a
   * builtin's are resolved by a strad process per tool call — so the panel says
   * both in that kind's own words rather than in one set for both.
   */
  unobservable?: UnobservableScope;
}

/**
 * Why an entry could not be checked, said in specifics rather than as a shrug.
 *
 * TWO FAMILIES OF REASON, and they are not the same claim. The first five are
 * PROBE OUTCOMES from a `supplementary-image`, whose parameters live on a
 * component this process is not, and they are not one problem either. Three are
 * about the component: `unwired` is a spec that never bound its private URL,
 * `unsupported` is a pin to bump, `unreachable` is a component core cannot talk
 * to. Two are about what it said, and they want OPPOSITE first moves —
 * `unmanifested` is a component that named no parameters AT ALL for anyone, so
 * the answer is to redeploy it; `silent` is one that named none for THIS slug
 * while manifesting others, so the answer is that the namespace is empty and
 * wants seeding. Collapsing those two sends an operator to seed a value that is
 * already there.
 *
 * The other three are about a `params: true` BUILTIN, where nothing was probed
 * because there was nothing to probe: a builtin's parameters are resolved by a
 * strad process, per tool call, out of the resolver's own snapshot of the store
 * — `optionsFor` in src/gateway/registry.ts merges them over the server's
 * `options:`. `in-process` is THIS process doing it; `delegated` is a builtin
 * mounted in another component running the strad image in bundle mode, which
 * does it there; `inert` is a deployment holding no resolver credential at all,
 * where the merge is skipped and the parameters are read by nobody.
 *
 * The two families share a shape and almost no vocabulary. Every sentence the
 * probe reasons say — which private URL was never bound, which image to repin,
 * which container to redeploy so the value reaches it — is false about a
 * builtin, which is why it took a second set of reasons rather than a widened
 * predicate (#264). `delegated` is the one that keeps a foot in both: its values
 * ARE on a component core cannot see, so it keeps the container chip and takes
 * the builtin's account of when a write lands. A confidently wrong panel is
 * worse than the dead control this replaced.
 */
export interface UnobservableScope {
  /**
   * The App Platform component the value would be resolved BY.
   *
   * `core` when that process is this one: `in-process`, where it does resolve
   * them, and `inert`, where it would and no credential lets it. For every other
   * reason it is another component — and for the five probe reasons that is the
   * whole reason the value is not visible from here.
   */
  component: string;
  reason:
    | "unwired"
    | "unsupported"
    | "unreachable"
    | "unmanifested"
    | "silent"
    | "in-process"
    | "delegated"
    | "inert";
  /** One sentence: what was asked, what answered, and what would change it. */
  detail: string;
  /** The static namespace this server's managed parameters live under. */
  namespace: string;
}

/**
 * Worst-first precedence.
 *
 * `missing` outranks `placeholder` outranks `error` outranks `unobservable`:
 * each step down is a weaker claim, and a row must be labelled by the strongest
 * bad news it carries or the label is a lie of omission.
 */
export const STATE_RANK: Record<SecretState, number> = {
  missing: 5,
  // Above `placeholder` because it is a harder fact: a placeholder is inferred
  // from a shape, an unrenderable parameter is the store refusing to return a
  // value. Below `missing` because the resource exists — the two want opposite
  // first moves, and ranking them apart is what keeps a row's label pointing at
  // the right one.
  unrenderable: 4,
  placeholder: 3,
  error: 2,
  unobservable: 1,
  present: 0,
};

const FROM_SECRET_STATE: Record<SecretState, ServerState> = {
  missing: "missing",
  unrenderable: "unrenderable",
  placeholder: "placeholder",
  error: "unknown",
  unobservable: "unverified",
  present: "ready",
};

export const STATE_LABEL: Record<ServerState, string> = {
  ready: "ready",
  "no-secrets": "no secrets",
  missing: "not seeded",
  unconfigured: "awaiting credential",
  unrenderable: "cannot render",
  placeholder: "check value",
  unverified: "unverified",
  unknown: "unknown",
};

/** Whether a state should read as a problem a human has to act on. */
export function isActionable(state: ServerState): boolean {
  return (
    state === "missing" ||
    // A deferral is a job somebody has not finished, not a job nobody has. It
    // stays on the actionable list — dropping it there is how "we will seed it
    // later" becomes "nobody ever seeded it", which is the failure mode this
    // whole feature has to be careful not to buy.
    state === "unconfigured" ||
    state === "placeholder" ||
    // A parameter that exists and cannot render is as actionable as either: the
    // server is broken now, and the fix (rotate the value) is a specific thing a
    // human does. Leaving it out of `isActionable` would file it under "could not
    // be checked", which is the shrug this state exists to replace.
    state === "unrenderable"
  );
}

/**
 * A `params: true` server's managed parameters, as observations.
 *
 * These are the credentials the console can say the LEAST about on its own: they
 * are not `${NAME}` references, so the config does not name them and core cannot
 * enumerate them. Without help the only honest answer is "this server sets
 * `params: true` and this page does not read that namespace" — a shrug about the
 * servers least likely to be checked by anything else.
 * `remote-filesystem-tmp-public` in staging carries its GCS client email and
 * private key exactly this way.
 *
 * `appspec.ts` bakes the VARIABLE names onto the component (`STRAD_PARAM_KEYS`,
 * names only) and the component reports presence for each, which is what makes
 * the question answerable from here at all.
 *
 * Empty when the component did not answer, ran an image without the presence
 * route, or reported no parameters for this slug — and the caller then falls
 * back to the shrug, which stays correct for exactly those cases.
 */
function managedParamObservations(
  server: ServerConfig,
  presence?: BundlePresence,
): SecretObservation[] {
  if (isUnhosted(server) || !server.params) return [];
  if (!presence) return [];
  const outcome = presence.probes.get(server.bundle);
  if (!outcome || outcome.kind !== "ok") return [];
  const names = outcome.report.paramKeys?.[server.slug];
  if (!names || names.length === 0) return [];

  const evidence: SecretEvidence = {
    by: "bundle",
    component: outcome.report.component,
    bootedAt: outcome.report.bootedAt,
    ...(outcome.report.image ? { image: outcome.report.image } : {}),
  };

  return names.map((name): SecretObservation => {
    const requirement: SecretRequirement = {
      name,
      deliveries: ["bundle"],
      slugs: [server.slug],
      consoleKeys: [],
      paramsSlugs: [server.slug],
      managed: true,
    };
    const verdict = outcome.report.keys[name];
    if (!verdict || verdict.presence === "absent") {
      return {
        requirement,
        state: "missing",
        source: "GSM",
        evidence,
        detail:
          `A managed parameter for this server, and the component does not hold it. The ` +
          `deploy listed ${name} among this slug's parameters and the running process has ` +
          `no such variable — so whatever reads it gets nothing. Seed it under this ` +
          `server's static namespace and redeploy that component.`,
      };
    }
    if (verdict.presence === "present") {
      return {
        requirement,
        state: "present",
        source: "ENV",
        evidence,
        detail:
          `PLUMBED, via a process environment variable. A managed parameter, resolved out ` +
          `of this server's static namespace at deploy time and injected onto the ` +
          `component — which was asked and reports a value under ${name}. That proves a ` +
          `value EXISTS in the running container, not that any upstream accepts it.`,
      };
    }
    return {
      requirement,
      state: "placeholder",
      source: "ENV",
      evidence,
      detail:
        `A managed parameter for this server, plumbed but not usable: ` +
        `${reasonFor(verdict.presence) ?? "the value is evident filler"}. Rotate it through the ` +
        `console and redeploy that component.`,
    };
  });
}

/**
 * WHICH of the ways the managed-parameter question went unanswered.
 *
 * `managedParamObservations` returns nothing in every one of these cases and the
 * entry falls back to the shrug. The shrug is still the right STATE — none of
 * these is evidence a value resolves — but it is not the whole of what this
 * process knows, and the difference between "bump the pin" and "the component is
 * down" is the entire content of the panel a reader opens the badge for.
 *
 * TWO KINDS GET A SCOPE, and they are answered by different functions because
 * they are answered from different evidence. A `supplementary-image` is answered
 * from the PROBE below — this process asked a component and this is what came
 * back. A `params: true` BUILTIN is never probed at all, and `builtinScope`
 * answers it from the config and the environment instead: nothing asked it a
 * question because a builtin's parameters are resolved by a strad process rather
 * than held on a container. Running a builtin through the probe branch is what
 * would produce the confidently wrong panel — a `${core.PRIVATE_URL}` that was
 * never meant to exist, an image to repin, a container to redeploy.
 *
 * Everything else — `remote-http`, `local-tunnel` — is unhosted and never gets
 * here: `params:` is not a field on it, and `isUnhosted` keeps the caller's
 * `managed` false regardless.
 */
function unobservableScope(
  config: StradConfig,
  server: ServerConfig,
  presence?: BundlePresence,
  env: NodeJS.ProcessEnv = {},
): UnobservableScope | undefined {
  if (server.kind === "builtin") return builtinScope(config, server, env);
  if (server.kind !== "supplementary-image") return undefined;
  const component = server.bundle;
  const namespace = staticNamespace(config.gateway.env, server.slug);
  const base = { component, namespace };
  // `expectedKeys` enumerates every bundle holding a supplementary image, so a
  // server of this kind is always probed and a missing entry means the same
  // thing the outcome does: no private URL was bound for it.
  const outcome = presence?.probes.get(component);

  if (!outcome || outcome.kind === "unwired") {
    return {
      ...base,
      reason: "unwired",
      detail:
        `This gateway holds no private URL for "${component}", so nothing was asked. A ` +
        `supplementary image's environment is baked onto ITS container and never broadcast ` +
        `to core, so with no way to ask that component there is no route from this process ` +
        `to the answer. The app spec binds it as \${${component}.PRIVATE_URL}; until it does, ` +
        `this entry stays unverified however well the server is working.`,
    };
  }
  if (outcome.kind === "unsupported") {
    return {
      ...base,
      reason: "unsupported",
      detail:
        `"${component}" answered, and it runs an image that predates the presence route, so ` +
        `it cannot be asked what it holds. This is a PIN BUMP rather than an outage — the ` +
        `component is up and serving requests, and only the question is unanswerable. ` +
        `Rebuild that image and repin the component, and these rows fill in on the next load.`,
    };
  }
  if (outcome.kind === "unreachable") {
    return {
      ...base,
      reason: "unreachable",
      detail:
        `"${component}" could not be reached from this process, so nothing about it was ` +
        `established. Chase that on its own account before the secrets: whatever it says ` +
        `about them, a component core cannot talk to is not answering core's requests ` +
        `either. (${outcome.detail})`,
    };
  }

  // It answered. Two very different silences, and they want opposite first
  // moves: a component that manifested NO parameters for anyone has a stale
  // spec, and one that manifested others but none for this slug has an empty
  // namespace. Telling the first to seed a value is how a present credential
  // gets rewritten.
  const manifest = outcome.report.paramKeys;
  if (!manifest || !manifest[server.slug]) {
    return {
      ...base,
      reason: "unmanifested",
      detail:
        `"${component}" answered and named no managed parameters for this server — not an ` +
        `empty list, no entry at all. The deploy bakes what it resolved into ` +
        `STRAD_PARAM_KEYS, so the running component is holding a spec rendered before this ` +
        `slug had \`params: true\`, or one whose manifest it cannot read. Redeploy that ` +
        `component; do NOT seed on the strength of this, because it says nothing about ` +
        `what the store holds.`,
    };
  }
  return {
    ...base,
    reason: "silent",
    detail:
      `"${component}" answered, manifested its managed parameters, and listed NONE under ` +
      `this server. That is the component reporting that the last render found nothing ` +
      `beneath this namespace — so nothing was injected, and the usual reason is that ` +
      `nothing is seeded there yet.`,
  };
}

/**
 * Whether this environment yields a resolver, and if not, WHY NOT.
 *
 * `resolverFromEnv` has three exits and this reproduces all three, because the
 * third is the one that would otherwise be told a lie: a key JSON that is SET
 * and unparseable returns null exactly as an absent one does (see
 * `parseServiceAccount` — not JSON, not an object, or missing
 * `client_email` / `private_key`). A panel that reported that as "the variables
 * are not set" would send an operator to look at two variables that are sitting
 * right there.
 *
 * A PREDICATE RATHER THAN A CLIENT. Asking `resolverFromEnv()` would answer the
 * same question and construct a `ParameterStore` to throw away — and this file
 * asks it per builtin, per page load, for a value it only null-tests. Nothing
 * here reads the store; the running gateway's own resolver is built once, in
 * src/index.ts, and this is a claim ABOUT that, not a second one.
 *
 * `test/ui.secret-status.test.ts` pins the two together over the shapes that
 * separate them, which is what keeps this from drifting into an approximation.
 */
export function resolverCredential(
  env: NodeJS.ProcessEnv,
): "present" | "unset" | "unusable" {
  const projectId = env[RESOLVER_ENV.projectId];
  const keyJson = env[RESOLVER_ENV.keyJson];
  if (!projectId || !keyJson) return "unset";
  return parseServiceAccount(keyJson).account ? "present" : "unusable";
}

/**
 * The same three facts for a builtin, in the vocabulary that is TRUE about one.
 *
 * A builtin has no container. Its managed parameters are read by a strad
 * process, from the store, at the moment they are used: `optionsFor` in
 * src/gateway/registry.ts merges everything under this namespace over the
 * server's resolved `options:` on EVERY TOOL CALL, out of the one snapshot of
 * the store that process holds for `gateway.secrets.ttlSeconds`. So the honest
 * panel is not "which container was not asked" but "which process resolves
 * these, and how long after a write it picks one up" — and the answer to the
 * second is a TTL rather than a deploy, which is the single sentence the
 * supplementary-image panel gets wrong about this shape.
 *
 * Three cases, because "a strad process" is not always THIS one and is
 * sometimes none:
 *
 *   - `in-process` — `bundle: core` (the default) and this deployment holds a
 *     resolver credential. This very process resolves them, per call. The
 *     rotation observatory `infra/strad.staging.yaml` documents on `echo` is
 *     exactly this case.
 *   - `delegated` — a builtin mounted in another component. That component runs
 *     the strad image in bundle mode and resolves them there with its own
 *     resolver; core proxies the call over the private network and never holds
 *     the values. It is not probed either, and cannot be: `expectedKeys` (see
 *     src/gateway/bundle-presence.ts) enumerates only the bundles holding
 *     supplementary images, and a bundle may not hold both kinds.
 *   - `inert` — no USABLE resolver credential in this environment.
 *     `Registry.build` gets a null resolver, skips the merge outright, and the
 *     server runs on its `options:` alone. Seeding the namespace changes nothing
 *     until the credential exists, so a panel pointing at the namespace without
 *     saying this would send someone to write a value nothing reads.
 *
 * `inert` is decided by `resolverCredential()`, which reproduces
 * `resolverFromEnv`'s three exits rather than approximating them — and the third
 * exit is why: a key JSON that is set and UNPARSEABLE resolves nothing, exactly
 * as an absent one does. "Set the variables" is the wrong instruction for a
 * deployment that has set them, so the two are told apart in the prose.
 *
 * It is decided by the credential rather than by `gateway.secrets.provider`,
 * because the registry decides it that way. The two come apart: `params:`
 * resolution is wired to `STRAD_PARAMS_*` and not to the provider flip, so a
 * `provider: env` deployment that sets the resolver credential does resolve a
 * builtin's parameters (which is why staging's `echo` is a usable observatory
 * without the flip).
 */
function builtinScope(
  config: StradConfig,
  server: Extract<ServerConfig, { kind: "builtin" }>,
  env: NodeJS.ProcessEnv,
): UnobservableScope {
  const namespace = staticNamespace(config.gateway.env, server.slug);
  const ttl = config.gateway.secrets.ttlSeconds;
  const credential = resolverCredential(env);

  if (server.bundle !== "core") {
    // THE TTL IS A PROMISE ABOUT A PROCESS THIS ONE CANNOT SEE, so it is stated
    // conditionally rather than asserted. That component holds whatever the app
    // spec gave it, which is core's own resolver credential (`renderAppSpec`
    // broadcasts the environment to a bundle running the strad image) — so
    // core holding none is real evidence about it and NOT an observation of it.
    // Promising a TTL unconditionally is the same falsehood `inert` exists to
    // prevent, one component over.
    const lands =
      credential === "present"
        ? `A value written under this namespace reaches that process within the TTL, with ` +
          `no redeploy.`
        : `Whether a value written under this namespace reaches it depends on that ` +
          `component holding a resolver credential of its own. The app spec gives it the ` +
          `one core has, and core has none — so on this deployment the merge is most ` +
          `likely skipped there too, and nothing reads this namespace.`;
    return {
      component: server.bundle,
      namespace,
      reason: "delegated",
      detail:
        `This builtin is mounted in "${server.bundle}", a component running the strad image ` +
        `in bundle mode, and THAT process resolves these parameters — merging everything ` +
        `under this namespace over the server's options: on every tool call, out of its own ` +
        `snapshot of the store, refreshed within gateway.secrets.ttlSeconds (${ttl}s). Core ` +
        `proxies the call over the private network and never holds the values. Nothing was ` +
        `asked of that component either: the presence probe enumerates only the components ` +
        `holding supplementary images, and this one holds builtins. ${lands}`,
    };
  }

  if (credential !== "present") {
    // WHICH FAILURE, because they take opposite actions. Unset is a deploy that
    // never wired the credential; unusable is one that wired a key JSON the
    // resolver cannot parse, and telling THAT operator to "set the variables"
    // sends them to look at two variables that are already there.
    const why =
      credential === "unset"
        ? `this environment sets no ${RESOLVER_ENV.projectId} / ${RESOLVER_ENV.keyJson}`
        : `this environment sets ${RESOLVER_ENV.keyJson} to something the resolver cannot ` +
          `parse as a service-account key — which resolves exactly as much as an absent ` +
          `one does, namely nothing`;
    return {
      component: "core",
      namespace,
      reason: "inert",
      detail:
        `\`params: true\` is INERT on this deployment, so these parameters are read by ` +
        `nothing. A builtin's parameters are resolved by this process rather than baked ` +
        `onto a container — but only while it holds a usable store credential, and ${why}. ` +
        `The registry is built with a null resolver, skips the merge outright, and this ` +
        `server runs on its options: alone. Seeding this namespace changes nothing until ` +
        `that credential works.`,
    };
  }

  return {
    component: "core",
    namespace,
    reason: "in-process",
    detail:
      `THIS process resolves these, and no component holds them. A builtin runs inside the ` +
      `gateway: everything under this namespace is merged over the server's options: on ` +
      `EVERY TOOL CALL, out of the one snapshot of the store this process holds for ` +
      `gateway.secrets.ttlSeconds (${ttl}s). So there is no private URL to bind, no image ` +
      `to repin and no container to redeploy — a value written under this namespace reaches ` +
      `the running server within that TTL, and rotating one takes effect the same way. The ` +
      `TTL is the upper bound rather than the wait: a write made through this console drops ` +
      `the snapshot, so the next tool call re-reads. What went unestablished is only that ` +
      `this PAGE does not read the namespace; the process that serves the server does.`,
  };
}

export function deriveServerStatuses(
  config: StradConfig,
  observations: SecretObservation[],
  presence?: BundlePresence,
  /**
   * The environment the RUNNING gateway resolves through, for the one question
   * a `params: true` builtin's panel cannot answer from config alone: whether
   * this deployment holds a resolver credential at all, and so whether the
   * merge that reads the namespace happens (see `builtinScope`).
   *
   * Defaults to nothing rather than to `process.env`, and deliberately: a
   * default of the real environment would make this function's output depend on
   * whichever machine ran it — green on a developer's box with the credential
   * exported, `inert` in CI, from one config. The one production caller passes
   * the environment it was handed.
   */
  env: NodeJS.ProcessEnv = {},
): ServerSecretStatus[] {
  const byName = new Map(observations.map((o) => [o.requirement.name, o]));
  const waivers = waiversBySlug(config);

  return config.servers
    .filter((s) => s.enabled)
    .map((server) => {
      // TWO PASSES, TWO DEDUP SETS, AND THAT SEPARATION IS LOAD-BEARING.
      // Deduplicating WITHIN a pass is what a `seen` set is for: one name
      // declared twice in one `env:` block is one requirement, and one
      // component manifesting a variable twice is one parameter. Arbitrating
      // BETWEEN the passes is a different job, and a single set did it by
      // accident — first pass claims the name, second pass skips it (#280).
      //
      // The two passes do not make the same claim about the same thing. A
      // `${NAME}` row says this deployment can resolve a value for that
      // reference out of the gateway namespace. A managed-parameter row says
      // whether the RUNNING CONTAINER holds a variable of that name, as the
      // component itself reported it. When a `params: true` server declares
      // `${FOO}` and its component manifests a managed parameter also called
      // `FOO`, both are true observations and either one can be the bad news.
      //
      // So both go to the worst-first reduce below and IT decides. A stated
      // precedence was the alternative and it is the wrong shape here: whichever
      // way it pointed, it would discard a live observation and buy a false
      // green in that direction — the store resolving `${FOO}` while the
      // container holds nothing, or the container holding `FOO` while the
      // reference the deploy renders from does not resolve. Worst-first
      // ranking exists precisely so no source's bad news has to be thrown away.
      const seenRefs = new Set<string>();
      const requirements: SecretObservation[] = [];
      for (const { name } of requirementsOf(server)) {
        if (seenRefs.has(name)) continue;
        seenRefs.add(name);
        const observation = byName.get(name);
        if (observation) requirements.push(observation);
      }

      // A `params: true` server's managed parameters are not `${NAME}`
      // references, so they produce no requirements above — but the component
      // holding them reports each one by name (`STRAD_PARAM_KEYS`, baked by
      // appspec.ts). Fold them in as requirements of their own, so the server is
      // graded on them like anything else instead of being filed under "not
      // checked".
      const managedParams = managedParamObservations(server, presence);
      const seenManaged = new Set<string>();
      for (const observation of managedParams) {
        if (seenManaged.has(observation.requirement.name)) continue;
        seenManaged.add(observation.requirement.name);
        requirements.push(observation);
      }

      // A NAMESPACE THIS SERVER TAKES CREDENTIALS FROM, AND NOBODY ANSWERED FOR
      // IT. That is a requirement that went unchecked, not an absence of
      // requirements, and the distinction is the whole of this entry's honesty:
      // the checks below grade what was observed, and this is the thing that
      // was not.
      //
      // `managed` and `managedGap` are two questions, not one. The first is
      // whether there IS a managed namespace, which is what the zero-row branch
      // has always asked; the second is whether anything answered for it. They
      // come apart when every parameter a component manifested is also a
      // `${NAME}` this server declares and no observation exists for it —
      // `requirements` is empty and `managedParams` is not — and collapsing them
      // would drop that entry into `no-secrets`, the false green this whole
      // branch exists to prevent.
      const managed = !isUnhosted(server) && server.params;
      const managedGap = managed && managedParams.length === 0;
      // ONE call site, so the three branches below cannot drift about which
      // entries get a panel. Gated on `managed` rather than `managedGap` for the
      // same reason the zero-row branch is: that branch has always built a scope
      // whenever there IS a namespace. Both hosted kinds get one, in their own
      // vocabulary — see unobservableScope().
      const managedScope = managed
        ? unobservableScope(config, server, presence, env)
        : undefined;

      if (requirements.length === 0) {
        // `params: true` means this server's credentials are MANAGED PARAMETERS,
        // resolved out of /strad/{env}/mcp/{slug}/static/* and injected directly —
        // they are not `${NAME}` refs, so they produce no requirements here.
        //
        // Calling that "no secrets" is a false green, and a live one:
        // `remote-filesystem-tmp-public` in infra/strad.staging.yaml carries its
        // GCS client email and private key exactly this way, and an unseeded one
        // breaks the server while this page reports it has nothing to seed. This
        // page does not read that namespace, so the honest answer is that it did
        // not check — not that there was nothing to check.
        if (managed) {
          return {
            server,
            state: "unverified" as ServerState,
            label: STATE_LABEL.unverified,
            summary:
              `This server sets \`params: true\`, so its credentials are managed parameters ` +
              `under ${staticNamespace(config.gateway.env, server.slug)} rather than ` +
              `\${NAME} references — and this page does not read that namespace. Nothing ` +
              `here says they are seeded.`,
            requirements,
            unobservable: managedScope,
          };
        }
        return {
          server,
          state: "no-secrets" as ServerState,
          label: STATE_LABEL["no-secrets"],
          summary:
            "This server declares no ${NAME} references, so there is nothing to seed. " +
            "Whether its upstream needs no credential or gets one another way, strad " +
            "holds none for it.",
          requirements,
        };
      }

      const worst = requirements.reduce((a, b) =>
        STATE_RANK[b.state] > STATE_RANK[a.state] ? b : a,
      );

      // AN UNCHECKED NAMESPACE RANKS LIKE ANY OTHER UNOBSERVABLE NAME — above
      // `present`, below every piece of bad news — so it demotes a green and
      // never overwrites a red.
      //
      // Without this the entry is graded on whatever it happens to declare
      // BESIDE its parameters. One resolving `${NAME}` in `env:` made
      // `requirements.length === 1`, the zero-row branch above was skipped, and
      // the badge read READY for a server whose actual credentials had been
      // checked by nothing — a green earned by an unrelated name, and strictly
      // worse than the zero-row case it sits beside, which at least says so.
      if (managedGap && STATE_RANK[worst.state] < STATE_RANK.unobservable) {
        // "NOT ALL OF WHAT IT NEEDS", never "not what it runs on". A resolved
        // `${NAME}` IS part of what this server runs on — `optionsFor` merges a
        // builtin's parameters OVER its resolved `options:`, and a supplementary
        // image's `env:` is injected beside its parameters — so calling the rows
        // irrelevant would be a second false claim in place of the first one.
        // What is true is that they are not the whole of it, and the rest went
        // unchecked.
        return {
          server,
          state: "unverified" as ServerState,
          label: STATE_LABEL.unverified,
          summary:
            `Every \${NAME} this server declares resolves — and they are not all of what it ` +
            `needs. It also sets \`params: true\`, so it takes managed parameters from ` +
            `${staticNamespace(config.gateway.env, server.slug)}, which are not \${NAME} ` +
            `references and which this page does not read. Nothing here says those are ` +
            `seeded.`,
          requirements,
          unobservable: managedScope,
        };
      }

      const bad = requirements.filter(
        (r) => r.state === worst.state && worst.state !== "present",
      );

      // A DEFERRAL IS NOT AN OVERSIGHT. Downgraded only when EVERY missing name
      // is one this server listed in `mayBeUnseeded:` — a server short of one
      // declared name and one undeclared one is `missing`, because the
      // undeclared one is the news and the row has to be labelled by the
      // strongest bad news it carries.
      const waived = waivers.get(server.slug) ?? new Set<string>();
      //
      // A WAIVER IS A STATEMENT ABOUT A `${NAME}`, NEVER ABOUT A MANIFESTED
      // PARAMETER. `mayBeUnseeded:` is validated against the names a server
      // REFERENCES (see waiversBySlug), so a waived name can only ever collide
      // with a managed parameter of the same name — and every clause the
      // `unconfigured` sentence goes on to make would be false about that row:
      // nothing was deferred at deploy time, no TTL activates it, and it reaches
      // the container at the next deploy rather than on write. So a managed row
      // is never waivable, and a server whose only bad news is one stays
      // `missing`.
      const state: ServerState =
        worst.state === "missing" &&
        bad.every(
          (r) => !r.requirement.managed && waived.has(r.requirement.name),
        )
          ? "unconfigured"
          : FROM_SECRET_STATE[worst.state];

      return {
        server,
        state,
        label: STATE_LABEL[state],
        summary: summarise(state, requirements.length, bad),
        requirements,
        // Reported even when worse news labels the row: the gap is true, and the
        // panel has room for it under the requirement rows. `managedGap`, not
        // `managed` — a namespace a component DID answer for produced rows above
        // and wants no panel.
        unobservable: managedGap ? managedScope : undefined,
      };
    });
}

/**
 * How a row's name reads in a summary sentence.
 *
 * A colliding name is TWO requirements, not one written twice: the `${NAME}` a
 * deployment resolves out of the gateway namespace, and the managed parameter
 * under this server's own — two values, at two paths, with two remediations
 * (see fixTargets). So the count stays a count of ROWS, and the managed one
 * says which it is. A bare "not seeded: FOO, FOO" would read as the page
 * repeating itself over a name a reader then seeds once.
 */
function summaryName(observation: SecretObservation): string {
  return observation.requirement.managed
    ? `${observation.requirement.name} (managed parameter)`
    : observation.requirement.name;
}

function summarise(
  state: ServerState,
  total: number,
  bad: SecretObservation[],
): string {
  const names = bad.map(summaryName).join(", ");
  // The NOUN agrees with `total` (it is "N required secrets" either way) and the
  // VERB agrees with whichever count the clause is about — `total` for the
  // all-of-them sentence, `badCount` for the N-of-M ones. Getting those from one
  // variable is how the page ended up printing "All 1 required secret resolve".
  const plural = total === 1 ? "secret" : "secrets";
  const badCount = bad.length;
  const badIs = badCount === 1 ? "is" : "are";
  switch (state) {
    case "ready":
      return `All ${total} required ${plural} ${total === 1 ? "resolves" : "resolve"}. strad has not verified that any upstream accepts them.`;
    case "missing":
      return `${badCount} of ${total} required ${plural} not seeded: ${names}.`;
    case "unconfigured":
      return (
        `${badCount} of ${total} required ${plural} not seeded yet: ${names}. ` +
        `This server declares \`mayBeUnseeded\` for ${badCount === 1 ? "it" : "them"}, ` +
        `so the deploy shipped it INACTIVE instead of failing — it starts serving ` +
        `on its own within a TTL of the value landing, with no redeploy.`
      );
    case "unrenderable":
      return `${badCount} of ${total} required ${plural} ${badIs} in the store and cannot be read: ${names}. Not absent — rotate the value.`;
    case "placeholder":
      return `Seeded but evidently placeholder: ${names}. The upstream will reject calls while listing tools normally.`;
    case "unverified":
      return `${badCount} of ${total} required ${plural} cannot be checked from the console: ${names}.`;
    case "unknown":
      return `The secret backend could not be consulted for: ${names}. Status unknown, not absent.`;
    case "no-secrets":
      return "No secrets required.";
  }
}

/** Counts for the page header, so the roster is scannable before it is read. */
export function tally(
  statuses: ServerSecretStatus[],
): Record<ServerState, number> {
  const out: Record<ServerState, number> = {
    ready: 0,
    "no-secrets": 0,
    missing: 0,
    unconfigured: 0,
    unrenderable: 0,
    placeholder: 0,
    unverified: 0,
    unknown: 0,
  };
  for (const s of statuses) out[s.state] += 1;
  return out;
}

// ---------------------------------------------------------------------------
// Fix guidance
// ---------------------------------------------------------------------------

export interface FixTarget {
  /** Which store, e.g. "GCP Parameter Manager + Secret Manager". */
  store: string;
  /** The exact resource name or canonical path to create. */
  resource: string;
  /**
   * The GCP project it goes in, or null when this process cannot know.
   *
   * A parameter PATH is answered from the config: the store whose namespaces
   * cover it declared its project, and that declaration is what the resolver
   * reads too. A `strad-<env>-*` SECRET MANAGER secret is not — the deploy
   * workflow reads those from its own `GCP_PROJECT_ID`, which is a deploy-
   * environment fact the running gateway holds nothing about, and which
   * `infra/strad.staging.yaml` INSTRUCTS should differ from the parameter
   * store's project. Null there, and the route says so, because the one id this
   * page holds answers a different question. See HACKS.md #86.
   */
  project: string | null;
  /** Why this route, and when the value takes effect. */
  detail: string;
  /** Copy-pasteable, in order. Never contains a value — `$VALUE` is a stand-in. */
  commands: string[];
  /** A console route that can do it in a browser, when one exists. */
  href?: string;
}

/**
 * Which GCP project holds the parameter store.
 *
 * Read from the deployment rather than assumed: the resolver's own project id if
 * this process holds one, else the `secrets` server's declared `SECRETS_PROJECT_ID`
 * (a non-secret literal in the config), else the naming convention. The
 * convention is last because a deployment that named its project something else
 * would otherwise be handed a copy-pasteable command that fails.
 */
export function storeProject(
  config: StradConfig,
  env: NodeJS.ProcessEnv,
): {
  project: string;
  guessed: boolean;
} {
  const fromResolver = env[RESOLVER_ENV.projectId];
  if (fromResolver) return { project: fromResolver, guessed: false };

  for (const server of config.servers) {
    // A DISABLED server is not this deployment's source of truth for anything;
    // letting its project id win would bake a wrong --project into every command.
    if (!server.enabled) continue;
    if (server.kind !== "supplementary-image") continue;
    const declared =
      server.consoleEnv.SECRETS_PROJECT_ID ??
      server.env.SECRETS_PROJECT_ID ??
      // A multi-store console names its projects in consoleStores: rather than
      // in a SECRETS_PROJECT_ID. The FIRST is the page's default store, which is
      // the one a copy-pasteable gcloud command should target.
      server.consoleStores[0]?.project ??
      // …and a deployment may declare only the /mcp half. Its first store is a
      // worse answer than the console's and a much better one than the GUESS
      // below, which is a project name assembled from the gateway's env.
      server.mcpStores[0]?.project;
    if (declared && !declared.includes("${")) {
      return { project: declared, guessed: false };
    }
  }
  return { project: `strad-secrets-${config.gateway.env}`, guessed: true };
}

/**
 * Which project holds the store that owns ONE parameter path.
 *
 * `storeProject()` answers for the DEPLOYMENT — a single default, which is the
 * right shape for a page header and the wrong shape for a command a human is
 * invited to paste. A `consoleStores:` slug fronts N stores on one `/ui/<slug>`
 * page, each with its own project and its own namespaces, so "which project" is
 * a question about the PATH and not about the deployment: a `${NAME}` missing
 * out of the second store's namespace is created with the second store's
 * `--project`, and naming the first store's would be a wrong answer to the
 * question the roster exists to answer.
 *
 * The stores come from `resolveServerView` where a console view can see them,
 * which is the one place that knows how a console store is declared, so the
 * index reads the same declarations the page that writes to it reads. The
 * NAMESPACE TEST is the one `storeForPath` in `src/http/params.ts` applies to
 * the write-back route, and deliberately so: a path is owned by the store whose
 * namespace covers it, however the store was declared. The two are not the same
 * function and do not answer identically — `storeForPath` falls back to a lone
 * candidate that covers nothing, and refuses two covering stores even when they
 * share a project. This is stricter in both directions, because falling back
 * here costs a less specific answer rather than a refused write.
 *
 * Nothing here reads a VALUE. The bag is the process environment (a store's
 * project and namespaces are config literals; only its credential needs the real
 * bag, and no credential is used) and the answer reaches a printed string, never
 * a store selection for resolution.
 *
 * Anything other than exactly one covering store — no namespaces declared at
 * all, a path outside every one of them, two stores both claiming it — falls
 * back to the deployment default. An ambiguous answer stated confidently is
 * worse than the default, which at least says when it was guessed.
 */
export function storeProjectForPath(
  config: StradConfig,
  path: string,
  env: NodeJS.ProcessEnv,
): {
  project: string;
  guessed: boolean;
} {
  const project = projectOwning(declaredStores(config, env), path);
  return project ? { project, guessed: false } : storeProject(config, env);
}

/** One declared parameter store, reduced to the two fields this file needs. */
interface DeclaredStore {
  project: string;
  namespaces: string[];
}

/**
 * Every parameter store this deployment declares, however it declared them.
 *
 * Flattened across BOTH dimensions the way `storeForPath` flattens them:
 * several secrets SLUGS, and several stores on one slug. A store is a
 * (project, namespaces) pair here whichever shape it arrived in, because that is
 * all a printed `--project` needs.
 *
 * THREE SHAPES, and one server never contributes two of them. The console's
 * `consoleStores:` and the single-store `SECRETS_*` env vars both arrive through
 * `resolveServerView`, which already refuses to merge them — a config that
 * declares its stores has said what they are. `mcpStores:` is the third, and it
 * is read straight off the config here because the console view cannot see it:
 * it is the `/mcp` half's list, and a server declaring it may not also carry
 * `SECRETS_PROJECT_ID` under `env:` (src/config/schema.ts refuses that), so it
 * reaches no console view at all. Leaving it out would answer such a path from
 * `storeProject()`, whose `mcpStores[0]` fallback is the same first-store guess
 * this exists to replace.
 */
function declaredStores(
  config: StradConfig,
  env: NodeJS.ProcessEnv,
): DeclaredStore[] {
  const forEnv = STORE_CACHE.get(config);
  const hit = forEnv?.get(env);
  if (hit) return hit;

  const bag: SecretBag = Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );

  const stores: DeclaredStore[] = [];
  const add = (project: string | undefined, namespaces: string[]): void => {
    // An unresolved `${REF}` is not a project id, and `storeProject()` refuses
    // one for the same reason: it would print a command that cannot run.
    if (!project || project.includes("${")) return;
    stores.push({ project, namespaces });
  };

  for (const server of config.servers) {
    // A DISABLED server is not this deployment's source of truth for anything —
    // the rule `storeProject()` applies above, for the same reason.
    if (!server.enabled) continue;
    if (serverLooksSecrets(server)) {
      const view = resolveServerView(config, server.slug, bag);
      if (view.kind !== "secrets") continue;
      for (const store of view.stores) add(store.projectId, store.namespaces);
      continue;
    }
    if (server.kind !== "supplementary-image") continue;
    for (const store of server.mcpStores) add(store.project, store.namespaces);
  }

  const cache = forEnv ?? new WeakMap<NodeJS.ProcessEnv, DeclaredStore[]>();
  cache.set(env, stores);
  STORE_CACHE.set(config, cache);
  return stores;
}

/**
 * Memoised per (config, env), because both are read-only inputs to this answer.
 *
 * The index calls `fixTargets()` once per actionable requirement and
 * `unobservableTarget()` once per unobservable block, and each call would
 * otherwise re-resolve every secrets server's view — which parses a service
 * account key per store. On a fleet-sized config that is a page render's
 * dominant cost, spent recomputing a list of (project, namespaces) pairs that
 * cannot have changed: a parsed config is not mutated, and a store's project and
 * namespaces are config literals or deploy-time env.
 */
const STORE_CACHE = new WeakMap<
  StradConfig,
  WeakMap<NodeJS.ProcessEnv, DeclaredStore[]>
>();

/**
 * The one project whose store covers this path, or null if that is not decided.
 *
 * Null covers three different situations and deliberately does not tell them
 * apart, because the caller does the same thing in all three: no store declares
 * a namespace, the path is outside every declared namespace, or two stores in
 * DIFFERENT projects both claim it. The last is the case `storeForPath` refuses
 * outright rather than picking a first — printing one of two projects with the
 * same confidence as a certain answer is the failure this function exists to
 * stop, so it falls back to the deployment default, which says when it guessed.
 */
function projectOwning(stores: DeclaredStore[], path: string): string | null {
  const owners = new Set(
    stores
      .filter((s) =>
        s.namespaces.some((ns) => path.startsWith(normaliseNamespace(ns))),
      )
      .map((s) => s.project),
  );
  const [only] = [...owners];
  return owners.size === 1 && only !== undefined ? only : null;
}

/**
 * Where to look when the console cannot look for you.
 *
 * The same shape as a `fixTargets` entry and deliberately so — a reader who has
 * opened one popout has read this layout already — but it points at a NAMESPACE
 * rather than a resource, because nothing here knows the variable names. That is
 * the honest end of the trail this process can follow: the store, the project,
 * the prefix, and a console route that lists what is actually under it.
 *
 * The store, the project, the prefix and the route are the same for every
 * reason — they are facts about where the values live, and a builtin's live in
 * exactly the same place. WHEN A WRITE TAKES EFFECT is not the same, and it is
 * the sentence a reader acts on: a supplementary image's environment is baked at
 * render time, so a write waits for the next deploy, while a builtin's
 * parameters are read at the moment they are used, so a write waits for a TTL
 * and nothing else. Saying "redeploy" to someone whose value is already live
 * within the hour is the specific falsehood #264 is about.
 */
export function unobservableTarget(
  config: StradConfig,
  scope: UnobservableScope,
  env: NodeJS.ProcessEnv,
): FixTarget {
  // The namespace IS the path here, so the store that owns it is knowable: this
  // asks which store covers it rather than which store the deployment defaults
  // to. On a single-store deployment they are the same answer. Every branch
  // below prints THIS project — the reason decides when a write takes effect,
  // never where it goes.
  const { project, guessed } = storeProjectForPath(
    config,
    scope.namespace,
    env,
  );
  const projectNote = guessed
    ? "; the project is inferred from the naming convention, because this deployment declares none"
    : "";
  const ttl = config.gateway.secrets.ttlSeconds;
  const where =
    `Everything under this prefix is where this server's managed parameters live, and the ` +
    `parameters console reads it directly. What is listed there is the answer this page ` +
    `could not get${projectNote}.`;

  // A BUILTIN, RESOLVED BY A STRAD PROCESS. No render bakes these onto anything
  // and no deploy carries them; the process reads the prefix itself and a write
  // lands within its TTL. `inert` is the exception INSIDE that family — the
  // merge does not run at all — so it is told to fix the credential rather than
  // promised a TTL that nothing is counting. WHICH fix, because the two shapes
  // of a null resolver take opposite actions: `resolverCredential` tells an
  // unset credential from an unparseable one, and "set these two variables" is
  // the wrong instruction for a deployment that has set them.
  if (scope.reason === "inert") {
    const fix =
      resolverCredential(env) === "unusable"
        ? {
            detail:
              `Fix ${RESOLVER_ENV.keyJson} first — it is set to something the resolver ` +
              `cannot parse as a service-account key; then this prefix is read on every ` +
              `tool call.`,
            command: `# But first: ${RESOLVER_ENV.keyJson} does not parse, so nothing reads them.`,
          }
        : {
            detail:
              `Set ${RESOLVER_ENV.projectId} and ${RESOLVER_ENV.keyJson} first; then this ` +
              `prefix is read on every tool call.`,
            command: `# But first: this deployment sets no ${RESOLVER_ENV.projectId}, so nothing reads them.`,
          };
    return {
      store: "GCP Parameter Manager (index) + Secret Manager (value)",
      resource: `${scope.namespace}*`,
      project,
      detail:
        `${where} Nothing reads it on this deployment: with no usable resolver credential ` +
        `the registry skips the merge, so a value written here takes effect at no point at ` +
        `all — not on write, not on a TTL, not on a deploy. ${fix.detail}`,
      commands: [
        `# Console: prefix "${scope.namespace}" — where this builtin's parameters would go.`,
        fix.command,
      ],
      href: `/ui/secrets?ns=${encodeURIComponent(scope.namespace)}`,
    };
  }
  if (scope.reason === "in-process" || scope.reason === "delegated") {
    const who =
      scope.reason === "in-process"
        ? "this gateway process"
        : `"${scope.component}"`;
    // THE SAME HEDGE THE SCOPE'S OWN DETAIL MAKES, because the two are one
    // popout and a reader takes the action from THIS half. A `delegated` scope
    // on a deployment with no resolver credential says the merge is most likely
    // skipped on that component; promising the TTL here regardless would
    // contradict the paragraph directly above it.
    const unbacked =
      scope.reason === "delegated" && resolverCredential(env) !== "present";
    const lands = unbacked
      ? `${where} It would be read by ${who} on every tool call — but only if that ` +
        `component holds a resolver credential, and core holds none, so on this ` +
        `deployment a value written here most likely reaches nothing. Wire the credential ` +
        `before you seed.`
      : `${where} It is read by ${who} on every tool call, out of one snapshot of the ` +
        `store — so a value written here reaches the running server within ` +
        `gateway.secrets.ttlSeconds (${ttl}s), with NO deploy, no restart and nothing to ` +
        `repin. A rotation lands the same way, and a write made THROUGH THIS CONSOLE lands ` +
        `sooner still: it drops the snapshot, so the next tool call re-reads rather than ` +
        `waiting out the TTL.`;
    return {
      store: "GCP Parameter Manager (index) + Secret Manager (value)",
      resource: `${scope.namespace}*`,
      project,
      detail: lands,
      commands: [
        `# Console: prefix "${scope.namespace}" — every managed parameter this server gets.`,
        unbacked
          ? `# But first: core sets no ${RESOLVER_ENV.projectId}, and "${scope.component}" is given core's.`
          : `# Then nothing: ${who} re-reads this prefix within ${ttl}s. No redeploy.`,
      ],
      href: `/ui/secrets?ns=${encodeURIComponent(scope.namespace)}`,
    };
  }

  return {
    store: "GCP Parameter Manager (index) + Secret Manager (value)",
    resource: `${scope.namespace}*`,
    project,
    detail:
      `Everything under this prefix is resolved at RENDER time and injected into ` +
      `"${scope.component}" as environment variables — so this is where the credentials ` +
      `are, and the parameters console reads it directly. What is listed there is the ` +
      `answer this page could not get${projectNote}. A value written here reaches the ` +
      `container at the NEXT DEPLOY, not on write.`,
    commands: [
      `# Console: prefix "${scope.namespace}" — every managed parameter this server gets.`,
      `# Then redeploy "${scope.component}": a supplementary image's environment is baked at render time.`,
    ],
    href: `/ui/secrets?ns=${encodeURIComponent(scope.namespace)}`,
  };
}

/**
 * Where a missing secret has to be set, most likely route first.
 *
 * This is the whole point of the page: a name and a path and — where it is
 * knowable — a project, not a scavenger hunt. Which route is FIRST is decided by what the deployment
 * declares, because the two are not interchangeable — a value in the parameter
 * store is read at runtime by a store-backed gateway and is deploy-time input at
 * most to an `env` one.
 */
export function fixTargets(
  config: StradConfig,
  requirement: SecretRequirement,
  env: NodeJS.ProcessEnv,
): FixTarget[] {
  const gatewayEnv = config.gateway.env;
  const storeBacked = config.gateway.secrets.provider !== "env";
  const namespace = gatewayNamespace(gatewayEnv);
  const path = `${namespace}${requirement.name}`;
  const smName = `strad-${gatewayEnv}-${requirement.name}`;

  // TWO DIFFERENT QUESTIONS, and a multi-store deployment answers them
  // differently. A PARAMETER PATH is owned by whichever store's namespaces cover
  // it — `storeProjectForPath` — because that is the store a human has to create
  // it in. A `strad-<env>-*` SECRET MANAGER secret is NOT a parameter path, so
  // no namespace covers it and there is no per-path answer to give — and the
  // deployment default is not one either: it answers for the PARAMETER STORE,
  // and the deploy workflow reads `strad-<env>-*` from its own GCP_PROJECT_ID,
  // which `infra/strad.staging.yaml` instructs should be a different project.
  // Those routes therefore name NO project and print a command with the project
  // left as a shell variable, rather than one that writes somewhere plausible
  // and wrong. See `secretManagerCommands` below.
  const deployment = storeProject(config, env);
  const stores = declaredStores(config, env);
  /** The project a PARAMETER PATH is created in — its owning store's, or the default. */
  const ownerOf = (resource: string): { project: string; guessed: boolean } => {
    const project = projectOwning(stores, resource);
    return project ? { project, guessed: false } : deployment;
  };
  const projectNoteFor = (guessed: boolean): string =>
    guessed
      ? ` (project inferred from the naming convention — this deployment does not declare one)`
      : "";

  const targets: FixTarget[] = [];

  // A MANAGED PARAMETER has exactly one home, and it is not either of the two
  // routes below. It is not a `${NAME}` reference: nothing resolves it from the
  // gateway namespace and nothing reads `strad-<env>-<NAME>` for it, so offering
  // those would be telling a reader to create resources that change nothing
  // about the row they are looking at. It lives under its server's own static
  // namespace, and the console can write it.
  if (requirement.managed) {
    const slug = requirement.paramsSlugs[0] ?? requirement.slugs[0] ?? "";
    const ns = staticNamespace(gatewayEnv, slug);
    const owner = ownerOf(`${ns}${requirement.name}`);
    targets.push({
      store: "GCP Parameter Manager (index) + Secret Manager (value)",
      resource: `${ns}${requirement.name}`,
      project: owner.project,
      detail:
        `A managed parameter: "${slug}" sets \`params: true\`, so everything under its ` +
        `static namespace is resolved at render time and injected into that server's ` +
        `environment. This is the only place it goes — it is not a \${NAME} reference, so ` +
        `the gateway namespace and strad-${gatewayEnv}-* do nothing for it. It reaches the ` +
        `container at the NEXT DEPLOY, not on write.${projectNoteFor(owner.guessed)}`,
      commands: [
        `# Console: prefix "${slug}/static/", variable ${requirement.name}`,
        `# Then redeploy: a supplementary image's environment is baked at render time.`,
      ],
      href: `/ui/secrets?ns=${encodeURIComponent(ns)}`,
    });
    return targets;
  }

  // consoleEnv: is its own route and it is deliberately NOT the store. It carries
  // the console's admin credential, and filing that inside the store would let
  // the weaker resolver credential read the stronger one.
  if (
    requirement.deliveries.includes("console") &&
    requirement.deliveries.length === 1
  ) {
    targets.push({
      store: "GCP Secret Manager (deploy environment only)",
      resource: smName,
      project: null,
      detail:
        `This name is referenced only from a consoleEnv: map, and consoleEnv: is read from ` +
        `the DEPLOY environment — never from the parameter store, because it carries the ` +
        `console's store-admin credential. Seed it in Secret Manager, where the deploy ` +
        `workflow reads every strad-${gatewayEnv}-* secret, then redeploy.` +
        deploySecretsProjectNote(gatewayEnv),
      commands: secretManagerCommands(smName, gatewayEnv),
    });
    return targets;
  }

  const shared = ownerOf(path);
  const storeTarget: FixTarget = {
    store: "GCP Parameter Manager (index) + Secret Manager (value)",
    resource: path,
    project: shared.project,
    detail: storeBacked
      ? `gateway.secrets.provider is "${config.gateway.secrets.provider}", so the gateway ` +
        `reads this path at runtime. A value added here lands within ` +
        `gateway.secrets.negativeTtlSeconds (${config.gateway.secrets.negativeTtlSeconds}s) ` +
        `with no redeploy — and it is the same path the next deploy's preflight checks.` +
        projectNoteFor(shared.guessed)
      : `gateway.secrets.provider is "env" on this deployment, so a value here is DEPLOY-time ` +
        `input: the render reads it and bakes it into the app spec. It does not reach the ` +
        `running gateway on its own.${projectNoteFor(shared.guessed)}`,
    // The console is the route to recommend: a parameter is a Parameter Manager
    // entry plus (for a secret one) a Secret Manager secret, addressed by a
    // FLATTENED id that `parameterId()` derives from the path. Printing a gcloud
    // recipe for that pairing would be four commands and an encoding a human
    // should not be computing by hand.
    commands: [
      `# Console: namespace ${namespace} · prefix (none) · variable ${requirement.name}`,
      `# By hand, both stores use parameterId("${path}") as the resource id.`,
    ],
    href: `/ui/secrets?ns=${encodeURIComponent(namespace)}`,
  };

  const bakedTarget: FixTarget = {
    store: "GCP Secret Manager",
    resource: smName,
    project: null,
    detail:
      `The deploy workflow loads every strad-${gatewayEnv}-* secret into its job ` +
      `environment, and scripts/render-spec.ts turns each referenced \${NAME} into a ` +
      `SECRET env var on the app spec. Adding a version here takes effect on the next ` +
      `deploy, not immediately.` +
      deploySecretsProjectNote(gatewayEnv),
    commands: secretManagerCommands(smName, gatewayEnv),
  };

  // THE SERVER'S OWN NAMESPACE — on a store-backed deployment, the route to
  // recommend rather than a footnote.
  //
  // A `${NAME}` reference resolves from `/strad/{env}/mcp/{slug}/static/` FIRST,
  // at runtime by the gateway (src/secrets/provider) and at render time for a
  // supplementary `env:` (src/deploy/server-namespaces.ts), so a credential that
  // belongs to one server belongs here and the shared namespace is the fallback.
  // The `env`-provider branch below is the one place where that is not true, and
  // it says so.
  //
  // Store-backed only. Under `gateway.secrets.provider: env` there is no store in
  // the read path at all — `forServer` is the process environment, which is flat
  // — so a value here would resolve for nothing.
  // WHEN a value here takes effect depends on the DELIVERY, not on the namespace.
  // A `gateway` ref is resolved on the request path, so it lands without a
  // redeploy; a supplementary image's `env:` is baked at render time whichever
  // namespace it came out of, so it reaches the container at the next deploy.
  // Saying "no redeploy" for the second would be a promise this does not keep.
  const runtimeRef = requirement.deliveries.includes("gateway");
  const bakedRef = requirement.deliveries.includes("bundle");
  const lands = runtimeRef
    ? `It is read on the request path, so a value here takes effect within ` +
      `gateway.secrets.ttlSeconds (${config.gateway.secrets.ttlSeconds}s) with no redeploy.`
    : `Its \${${requirement.name}} is a supplementary image's env: ref, baked at ` +
      `render time — so a value here reaches the container at the NEXT DEPLOY, not on write.`;

  // A name referenced ONLY from a consoleEnv: map is not served by this route at
  // all — that half is read from the deploy environment, never from the store —
  // and the early return above only catches the case where console is the ONLY
  // delivery. A name declared under both still needs the store route for its
  // other half, so the target stays and the caveat is said out loud.
  const consoleCaveat = requirement.deliveries.includes("console")
    ? ` This name is ALSO declared under a consoleEnv: map, and that half is read ` +
      `from the deploy environment — a value here does nothing for it.`
    : "";

  const perServerTargets: FixTarget[] =
    storeBacked && (runtimeRef || bakedRef)
      ? requirement.slugs.map((slug) => {
          const resource = `${staticNamespace(gatewayEnv, slug)}${requirement.name}`;
          const owner = ownerOf(resource);
          return {
            store: "GCP Parameter Manager (index) + Secret Manager (value)",
            resource,
            project: owner.project,
            detail:
              `"${slug}" resolves \${${requirement.name}} from its OWN namespace before the ` +
              `shared one, so this is where a credential that belongs to this server goes. ` +
              `${lands} The next deploy's preflight accepts it in place of ${path}.` +
              (requirement.slugs.length > 1
                ? ` ${requirement.slugs.length} servers reference this name, and the ` +
                  `deploy demands that EVERY one of them resolve it: a value here covers ` +
                  `"${slug}" alone, and the others still need ${namespace} or a value of ` +
                  `their own.`
                : "") +
              consoleCaveat +
              projectNoteFor(owner.guessed),
            commands: [
              `# Console: namespace ${mcpNamespace(gatewayEnv)} · prefix "${slug}/static/" · variable ${requirement.name}`,
            ],
            href: `/ui/secrets?ns=${encodeURIComponent(staticNamespace(gatewayEnv, slug))}`,
          };
        })
      : [];

  targets.push(
    ...(storeBacked
      ? [...perServerTargets, storeTarget, bakedTarget]
      : [bakedTarget, storeTarget]),
  );

  // Under the `env` provider the note above stays a note, and stays LAST.
  //
  // The per-server route is a STORE route: `forServer` layers a namespace read
  // in front of the shared one, and on an `env` deployment there is no store in
  // the read path — every `${NAME}` comes from `process.env`, which is flat. So
  // a value under a server's own namespace still changes nothing about this row
  // here, and offering it as a fix would send a reader to create a resource that
  // resolves for nobody. It is named anyway because it is the adjacent thing to
  // reach for.
  if (!storeBacked) {
    for (const slug of requirement.paramsSlugs) {
      const resource = `${staticNamespace(gatewayEnv, slug)}${requirement.name}`;
      const owner = ownerOf(resource);
      targets.push({
        store: "GCP Parameter Manager + Secret Manager (a different mechanism)",
        resource,
        project: owner.project,
        detail:
          `NOT a fix for this row — noted because it is the adjacent thing to reach for. ` +
          `"${slug}" sets \`params: true\`, so everything under its static namespace is ` +
          `injected into that server's environment. But this deployment sets ` +
          `gateway.secrets.provider: env, so a \${${requirement.name}} REFERENCE is ` +
          `resolved from the deploy environment and the rendered spec — never from a ` +
          `parameter namespace — and a value here leaves the deploy failing exactly as it ` +
          `does now. Use it to replace the \`${requirement.name}\` entry in that server's ` +
          `env: with a managed parameter, which is a config change.` +
          projectNoteFor(owner.guessed),
        commands: [
          `# Console: prefix "${slug}/static/", variable ${requirement.name}`,
          `# ...then DELETE the \${${requirement.name}} entry from ${slug}'s env: in the config.`,
        ],
        href: `/ui/secrets?ns=${encodeURIComponent(staticNamespace(gatewayEnv, slug))}`,
      });
    }
  }

  return targets;
}

/** The shell variable a reader fills in, mirroring `$VALUE` in the same recipe. */
const DEPLOY_PROJECT_VAR = "DEPLOY_SECRETS_PROJECT";

/**
 * The one sentence a Secret Manager route owes a reader in place of a project.
 *
 * Said in the detail as well as in the commands, because the two are read by
 * different people: the recipe is for whoever is pasting, this is for whoever is
 * deciding whether the row is even their problem.
 */
function deploySecretsProjectNote(gatewayEnv: string): string {
  return (
    ` The project is whichever one your deploy workflow reads strad-${gatewayEnv}-* ` +
    `out of — its own GCP_PROJECT_ID, a deploy-environment fact this page cannot ` +
    `see. On a deployment that has a parameter store it is deliberately NOT that ` +
    `store's project, so the commands leave it to you rather than naming an id ` +
    `that answers a different question.`
  );
}

/**
 * A Secret Manager secret id, or a refusal.
 *
 * Applied to everything `secretManagerCommands` prints, which is the rendered
 * name AND `gateway.env` — both free-form YAML, the same trust boundary as the
 * config itself. "Someone who can edit the config can already run code" is an
 * argument for not caring, and this page's whole job is to be pasted from, so a
 * value carrying `;` or a backtick would yield a command that runs something
 * else. A Secret Manager id is letters, digits, `-` and `_`, up to 255 of them;
 * anything else is not a secret name and is not worth quoting into a command.
 *
 * The env is checked SEPARATELY even though today's call sites compose the name
 * out of it, which makes the second check redundant. Redundant is not the same
 * as unnecessary: the coupling is a fact about two call sites, not about this
 * function, and a third one that printed a name the env is not a prefix of would
 * otherwise put unchecked YAML into a pasteable block.
 */
function safeSecretName(name: string): string | null {
  return /^[A-Za-z0-9_-]{1,255}$/.test(name) ? name : null;
}

/**
 * The paste-ready recipe for a `strad-<env>-*` secret, with the project LEFT OUT.
 *
 * A baked `--project` here was wrong on exactly the deployment this repo
 * prescribes: `<P>` was `storeProject()`, which answers for the parameter store,
 * and `infra/strad.staging.yaml` instructs that the parameter store is a
 * different project from the one holding strad's own `strad-<env>-*` secrets, so
 * that the store's viewer and admin cannot reach them. The paste then SUCCEEDED
 * against the wrong project and the next deploy failed on the same name with
 * nothing pointing at where the value went — the one route on this page that did
 * not fail legibly (HACKS.md #86).
 *
 * `"$DEPLOY_SECRETS_PROJECT"` rather than a placeholder like `<PROJECT>`, and
 * rather than dropping the flag. A variable nobody filled in is not a project
 * id — unset it expands to empty, pasted whole it is still the `…` placeholder —
 * and `gcloud` refuses either, so nothing is written. Dropping the flag would
 * instead fall through to whatever `gcloud config` has set, which for an
 * operator who has been working in the parameter store is the very project this
 * exists to stop writing to, and it would succeed. The recipe already asks the
 * reader to supply `$VALUE`; this asks for one more.
 */
function secretManagerCommands(name: string, gatewayEnv: string): string[] {
  const safe = safeSecretName(name);
  const safeEnv = safeSecretName(gatewayEnv);
  if (!safe || !safeEnv) {
    // NEITHER value is echoed. Whichever failed is the one that failed a shape
    // test, so it may carry a newline — and a newline in a `#` line ends the
    // comment and starts a command, which is the injection this branch exists
    // to refuse.
    return [
      `# No paste-ready command: this deployment's strad-<env>-<NAME> is not a`,
      `# well-formed Secret Manager id, so nothing is quoted into a shell command`,
      `# here. Fix gateway.env, or shorten the variable name.`,
    ];
  }
  return [
    `# Set this to the project your deploy reads strad-${safeEnv}-* from — the`,
    `# deploy workflow's GCP_PROJECT_ID, NOT this deployment's parameter store.`,
    `export ${DEPLOY_PROJECT_VAR}=…`,
    `gcloud secrets create ${safe} --project "$${DEPLOY_PROJECT_VAR}" --replication-policy automatic`,
    `printf %s "$VALUE" | gcloud secrets versions add ${safe} --project "$${DEPLOY_PROJECT_VAR}" --data-file=-`,
  ];
}
