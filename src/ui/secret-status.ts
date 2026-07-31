import type { ServerConfig, StradConfig } from "../config/schema.ts";
import type { SecretBag } from "../secrets/index.ts";
import { refsIn } from "../secrets/provider/resolve.ts";
import {
  CORE_BOOT_ENV_KEYS,
  REQUIRED_BOOT_ENV_KEYS,
} from "../secrets/provider/hydrate.ts";
import {
  gatewayNamespace,
  staticNamespace,
} from "../secrets/parameters/namespace.ts";
import {
  resolverFromEnv,
  RESOLVER_ENV,
  type ParameterStore,
} from "../secrets/parameters/index.ts";
import { errorSummary } from "../secrets/provider/snapshot.ts";
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
  readStoreDiagnostics,
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
 * A remote-http server's refs are walked out of `url` and `headers` rather than
 * the whole object, so a `${...}`-looking string in a `description` cannot invent
 * a requirement. Same reasoning for a builtin: only `options` can carry one.
 */
function requirementsOf(
  server: ServerConfig,
): { name: string; delivery: Delivery; consoleKey?: string }[] {
  const out: { name: string; delivery: Delivery; consoleKey?: string }[] = [];
  const push = (raw: string, delivery: Delivery, consoleKey?: string) => {
    for (const name of refsIn(raw)) out.push({ name, delivery, consoleKey });
  };

  if (server.kind === "remote-http") {
    push(server.url, "gateway");
    for (const value of Object.values(server.headers)) push(value, "gateway");
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
      .filter((s) => s.enabled && s.kind !== "remote-http" && s.params)
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
 * module is vendored, byte-identical, and `test/presence.sync.test.ts` fails CI
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
  lookup: (name: string) => Promise<string | null>;
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
 * `snapshot.ts`, which is single-flighted — so twenty concurrent `get()`s on a
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
      const found = await withDeadline(
        () => opts.lookup(requirement.name),
        timeoutMs,
      );
      return classify(requirement, found, opts);
    }),
  );
}

/** `{ ok: value }`, or `{ error: message }` for a throw or a timeout. */
type Attempt = { ok: string | null } | { error: string };

async function withDeadline(
  read: () => Promise<string | null>,
  timeoutMs: number,
): Promise<Attempt> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const value = await Promise.race([
      read(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
    return { ok: value };
  } catch (err) {
    // THIS IS THE ONE PIECE OF FREE-FORM TEXT ON THE PAGE THAT COMES FROM OUTSIDE
    // IT, AND A RAW `err.message` HERE LEAKS A SECRET.
    //
    // Not hypothetically. A store read ends in `decodeEnvelope` -> `JSON.parse`
    // over a `:render`ed payload — which is the dereferenced secret, in plaintext.
    // A truncated or corrupted envelope throws a `SyntaxError` whose message
    // embeds a window of the body it choked on, and on a COLD cache
    // `snapshot.ts` re-throws it raw rather than serving stale values. That
    // message would land in `detail` and render, as visible text, on a page whose
    // entire claim is that it never prints bytes. Truncating to 200 characters
    // does not help: the window is ~30 characters and sits well inside the cap.
    //
    // `errorSummary` is the defence snapshot.ts already wrote for exactly this,
    // and reusing it is the point — a `ParameterStoreError` message is known safe
    // (method + resource, query and `:verb` stripped) and passes through; anything
    // else is reduced to its class name. The cap stays as a second belt.
    const summary = errorSummary(err);
    return {
      error:
        summary.length > 200
          ? `${summary.slice(0, 200)}… (truncated)`
          : summary,
    };
  } finally {
    if (timer) clearTimeout(timer);
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
    return finish(requirement, attempt.ok, {
      where: storeBacked
        ? `the parameter store, under ${gatewayNamespace(config.gateway.env)}`
        : "this process's environment",
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
        `exist in the parameter store, so every value that references it resolves to ` +
        `nothing. ` +
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
 * The lookup `observe()` wants, built from what the deployment has.
 *
 * The RUNTIME provider when one was supplied, and the boot bag otherwise. Both
 * honour the contract `observe()` depends on: `null` means the backend answered
 * and the name is absent, and a throw means it could not be consulted.
 * Collapsing those would turn a store outage into a wall of red "not seeded",
 * which is the one failure mode that would make the console worse than nothing.
 *
 * The provider is the right seam rather than the bag alone because it is the
 * only one that can answer for a store-backed deployment, where a name lives in
 * the parameter store and never in `process.env`. Absent, the bag is exactly
 * correct — under the `env` provider the bag IS the environment.
 */
export function secretLookup(
  bag: SecretBag,
  provider?: { get(name: string): Promise<string | null> },
): (name: string) => Promise<string | null> {
  if (provider) return (name: string) => provider.get(name);
  return async (name: string) => bag[name] ?? null;
}

export interface SecretReading {
  /** One entry per ENABLED server, in config order. */
  statuses: ServerSecretStatus[];
  /** The gateway's own boot keys, and whether each is required. */
  boot: { observation: SecretObservation; required: boolean }[];
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
  lookup: (name: string) => Promise<string | null>;
  /** What each bundle reports it holds. Absent = the older, weaker claim. */
  presence?: BundlePresence;
  /** The store's own account of itself, for telling the four states apart. */
  store?: StoreDiagnostics | null;
  timeoutMs?: number;
}): Promise<SecretReading> {
  const { config, bag, lookup, presence, store, timeoutMs } = opts;
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
    statuses: deriveServerStatuses(config, observations, presence),
    boot: bootObservations.map((observation, i) => ({
      observation,
      required: bootKeys[i]?.required ?? false,
    })),
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
 *      (`readStoreDiagnostics`), whenever core has a resolver credential — which
 *      is true on a `provider: env` deployment that also uses `params: true`, so
 *      this is not gated on the flip.
 *
 * Neither is required. With neither, this degrades exactly to the older, weaker
 * reading, which is what makes it safe to deploy core ahead of the bundle image.
 */
export async function readDeploymentSecretStatus(opts: {
  config: StradConfig;
  bag: SecretBag;
  env: NodeJS.ProcessEnv;
  secretProvider?: { get(name: string): Promise<string | null> };
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
      return readStoreDiagnostics({
        store,
        namespace: gatewayNamespace(opts.config.gateway.env),
      });
    })(),
  ]);

  return readSecretStatus({
    config: opts.config,
    bag: opts.bag,
    lookup: secretLookup(opts.bag, opts.secretProvider),
    presence,
    store,
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
  /** This server's requirements, deduplicated within the server. */
  requirements: SecretObservation[];
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
  unrenderable: "cannot render",
  placeholder: "check value",
  unverified: "unverified",
  unknown: "unknown",
};

/** Whether a state should read as a problem a human has to act on. */
export function isActionable(state: ServerState): boolean {
  return (
    state === "missing" ||
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
  if (server.kind === "remote-http" || !server.params) return [];
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

export function deriveServerStatuses(
  config: StradConfig,
  observations: SecretObservation[],
  presence?: BundlePresence,
): ServerSecretStatus[] {
  const byName = new Map(observations.map((o) => [o.requirement.name, o]));

  return config.servers
    .filter((s) => s.enabled)
    .map((server) => {
      const seen = new Set<string>();
      const requirements: SecretObservation[] = [];
      for (const { name } of requirementsOf(server)) {
        if (seen.has(name)) continue;
        seen.add(name);
        const observation = byName.get(name);
        if (observation) requirements.push(observation);
      }

      // A `params: true` server's managed parameters are not `${NAME}`
      // references, so they produce no requirements above — but the component
      // holding them reports each one by name (`STRAD_PARAM_KEYS`, baked by
      // appspec.ts). Fold them in as requirements of their own, so the server is
      // graded on them like anything else instead of being filed under "not
      // checked".
      for (const observation of managedParamObservations(server, presence)) {
        if (seen.has(observation.requirement.name)) continue;
        seen.add(observation.requirement.name);
        requirements.push(observation);
      }

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
        const managed = server.kind !== "remote-http" && server.params;
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
      const state = FROM_SECRET_STATE[worst.state];
      const bad = requirements.filter(
        (r) => r.state === worst.state && worst.state !== "present",
      );

      return {
        server,
        state,
        label: STATE_LABEL[state],
        summary: summarise(state, requirements.length, bad),
        requirements,
      };
    });
}

function summarise(
  state: ServerState,
  total: number,
  bad: SecretObservation[],
): string {
  const names = bad.map((b) => b.requirement.name).join(", ");
  // The NOUN agrees with `total` (it is "N required secrets" either way) and the
  // VERB agrees with whichever count the clause is about — `total` for the
  // all-of-them sentence, `bad.length` for the N-of-M ones. Getting those from one
  // variable is how the page ended up printing "All 1 required secret resolve".
  const plural = total === 1 ? "secret" : "secrets";
  const badIs = bad.length === 1 ? "is" : "are";
  switch (state) {
    case "ready":
      return `All ${total} required ${plural} ${total === 1 ? "resolves" : "resolve"}. strad has not verified that any upstream accepts them.`;
    case "missing":
      return `${bad.length} of ${total} required ${plural} not seeded: ${names}.`;
    case "unrenderable":
      return `${bad.length} of ${total} required ${plural} ${badIs} in the store and cannot be read: ${names}. Not absent — rotate the value.`;
    case "placeholder":
      return `Seeded but evidently placeholder: ${names}. The upstream will reject calls while listing tools normally.`;
    case "unverified":
      return `${bad.length} of ${total} required ${plural} cannot be checked from the console: ${names}.`;
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
  /** The GCP project it goes in. */
  project: string;
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
      server.consoleEnv.SECRETS_PROJECT_ID ?? server.env.SECRETS_PROJECT_ID;
    if (declared && !declared.includes("${")) {
      return { project: declared, guessed: false };
    }
  }
  return { project: `strad-secrets-${config.gateway.env}`, guessed: true };
}

/**
 * Where a missing secret has to be set, most likely route first.
 *
 * This is the whole point of the page: a name and a project and a path, not a
 * scavenger hunt. Which route is FIRST is decided by what the deployment
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
  const { project, guessed } = storeProject(config, env);
  const namespace = gatewayNamespace(gatewayEnv);
  const path = `${namespace}${requirement.name}`;
  const smName = `strad-${gatewayEnv}-${requirement.name}`;
  const projectNote = guessed
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
    targets.push({
      store: "GCP Parameter Manager (index) + Secret Manager (value)",
      resource: `${ns}${requirement.name}`,
      project,
      detail:
        `A managed parameter: "${slug}" sets \`params: true\`, so everything under its ` +
        `static namespace is resolved at render time and injected into that server's ` +
        `environment. This is the only place it goes — it is not a \${NAME} reference, so ` +
        `the gateway namespace and strad-${gatewayEnv}-* do nothing for it. It reaches the ` +
        `container at the NEXT DEPLOY, not on write.${projectNote}`,
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
      project,
      detail:
        `This name is referenced only from a consoleEnv: map, and consoleEnv: is read from ` +
        `the DEPLOY environment — never from the parameter store, because it carries the ` +
        `console's store-admin credential. Seed it in Secret Manager, where the deploy ` +
        `workflow reads every strad-${gatewayEnv}-* secret, then redeploy.${projectNote}`,
      commands: secretManagerCommands(smName, project),
    });
    return targets;
  }

  const storeTarget: FixTarget = {
    store: "GCP Parameter Manager (index) + Secret Manager (value)",
    resource: path,
    project,
    detail: storeBacked
      ? `gateway.secrets.provider is "${config.gateway.secrets.provider}", so the gateway ` +
        `reads this path at runtime. A value added here lands within ` +
        `gateway.secrets.negativeTtlSeconds (${config.gateway.secrets.negativeTtlSeconds}s) ` +
        `with no redeploy — and it is the same path the next deploy's preflight checks.` +
        projectNote
      : `gateway.secrets.provider is "env" on this deployment, so a value here is DEPLOY-time ` +
        `input: the render reads it and bakes it into the app spec. It does not reach the ` +
        `running gateway on its own.${projectNote}`,
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
    project,
    detail:
      `The deploy workflow loads every strad-${gatewayEnv}-* secret into its job ` +
      `environment, and scripts/render-spec.ts turns each referenced \${NAME} into a ` +
      `SECRET env var on the app spec. Adding a version here takes effect on the next ` +
      `deploy, not immediately.${projectNote}`,
    commands: secretManagerCommands(smName, project),
  };

  targets.push(
    ...(storeBacked ? [storeTarget, bakedTarget] : [bakedTarget, storeTarget]),
  );

  // A `params: true` server's own namespace, LAST and explicitly labelled as not
  // a fix for this row.
  //
  // It was offered first, under a heading that reads "most likely route first",
  // and that was wrong: the requirement here is a `${NAME}` REFERENCE in `env:`
  // or `headers:`, and putting the name under `/strad/{env}/mcp/{slug}/static/`
  // does not resolve a reference. render-spec looks a referenced name up in the
  // GATEWAY namespace and then the environment, and exits 1 if neither has it —
  // before `resolveServerParams` runs at all. So the first thing a reader was
  // told to do left the deploy failing with the identical error.
  for (const slug of requirement.paramsSlugs) {
    targets.push({
      store: "GCP Parameter Manager + Secret Manager (a different mechanism)",
      resource: `${staticNamespace(gatewayEnv, slug)}${requirement.name}`,
      project,
      detail:
        `NOT a fix for this row — noted because it is the adjacent thing to reach for. ` +
        `"${slug}" sets \`params: true\`, so everything under its static namespace is ` +
        `injected into that server's environment. But this row is a \${${requirement.name}} ` +
        `REFERENCE, and render-spec resolves a reference from the gateway namespace or the ` +
        `deploy environment — never from a server's own namespace — so a value here leaves ` +
        `the deploy failing exactly as it does now. Use it to replace the \`${requirement.name}\` ` +
        `entry in that server's env: with a managed parameter, which is a config change.` +
        projectNote,
      commands: [
        `# Console: prefix "${slug}/static/", variable ${requirement.name}`,
        `# ...then DELETE the \${${requirement.name}} entry from ${slug}'s env: in the config.`,
      ],
      href: `/ui/secrets?ns=${encodeURIComponent(staticNamespace(gatewayEnv, slug))}`,
    });
  }

  return targets;
}

/**
 * A GCP project id, or a refusal.
 *
 * `project` reaches a command a human is invited to paste into a shell. It comes
 * from `STRAD_PARAMS_PROJECT_ID` or a free-form YAML `SECRETS_PROJECT_ID`, so it
 * is the same trust boundary as the config itself — but "someone who can edit the
 * config can already run code" is an argument for not caring, and this page's
 * whole job is to be pasted from. A value carrying `;` or a backtick would yield
 * a command that runs something else. GCP project ids are 6–30 characters of
 * lowercase letters, digits and hyphens, so anything else is not a project id and
 * is not worth quoting into a command.
 */
function safeProject(project: string): string | null {
  return /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project) ? project : null;
}

function secretManagerCommands(name: string, project: string): string[] {
  const safe = safeProject(project);
  if (!safe) {
    return [
      `# No paste-ready command: "${project}" is not a well-formed GCP project id,`,
      `# so it is not quoted into a shell command here. Fix the project id first.`,
    ];
  }
  return [
    `gcloud secrets create ${name} --project ${safe} --replication-policy automatic`,
    `printf %s "$VALUE" | gcloud secrets versions add ${name} --project ${safe} --data-file=-`,
  ];
}
