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
import { RESOLVER_ENV } from "../secrets/parameters/index.ts";

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
 * near-miss version of this mistake: `/ui/secrets` reported a missing admin
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
 * They belong on this page because the loop it serves starts with "point Zimmer
 * at a strad URL with the shared API token": without `STRAD_TOKENS` every /mcp
 * request is rejected and no amount of per-server green means anything.
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
 * Values that are a human saying "I will fill this in later".
 *
 * Kept to EXACT matches (case-insensitively, trimmed) plus a short list of
 * unmistakable substrings. The temptation is entropy scoring, and it is the wrong
 * trade: a false "this looks fake" on a real credential sends someone to rotate a
 * working secret, and there is no way for them to check without revealing it.
 * Both directions of wrong are costly here, so the rule is only ever applied to
 * shapes no credential issuer emits.
 */
const PLACEHOLDER_EXACT = new Set([
  "placeholder",
  "change-me",
  "changeme",
  "change_me",
  "replace-me",
  "replaceme",
  "replace_me",
  "fixme",
  "todo",
  "tbd",
  "unset",
  "not-set",
  "not_set",
  "notset",
  "none",
  "null",
  "nil",
  "n/a",
  "na",
  "example",
  "dummy",
  "fake",
  "test",
  "secret",
  "value",
  "-",
  "x",
  "xxx",
  "xxxx",
  "xxxxx",
  "0",
]);

const PLACEHOLDER_SUBSTRING = [
  "placeholder",
  "change-me",
  "changeme",
  "replace-me",
  "replace me",
  "replacethis",
  "replace-this",
  "your-token",
  "your_token",
  "yourtoken",
  "<your",
  "todo:",
  "fill-me",
  "fillme",
];

/**
 * Why this value is evidently not a credential, or null.
 *
 * The returned reason describes the SHAPE that matched and never quotes, echoes,
 * excerpts, hashes or measures the value. A page that said "the value is
 * `change-me`" would be printing a secret in every case where the check was
 * wrong, which is the only case that matters.
 */
export function placeholderReason(value: string): string | null {
  if (value.trim() === "") {
    return "the value is set but empty, so whatever reads it gets nothing";
  }
  // An unexpanded reference. Something resolved `${FOO}` to the literal text
  // `${FOO}`, which the gateway would send upstream verbatim.
  if (/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value.trim())) {
    return "the value is still an unexpanded ${...} reference, so nothing resolved it";
  }
  const folded = value.trim().toLowerCase();
  if (PLACEHOLDER_EXACT.has(folded)) {
    return "the value is a well-known filler string, not a credential";
  }
  for (const needle of PLACEHOLDER_SUBSTRING) {
    if (folded.includes(needle)) {
      return "the value contains well-known placeholder text, so it was probably never filled in";
    }
  }
  return null;
}

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
    // The message describes the BACKEND's failure, and this is the one piece of
    // free-form text on the page that comes from outside it. strad's own providers
    // are safe by construction — `ParameterStoreError` carries method, resource
    // path and HTTP status, and gcp.ts strips the query and `:verb` precisely
    // because "values travel in the body, which is not echoed here" — so a value
    // cannot arrive this way today. The cap is for the provider nobody has written
    // yet: bounded text cannot become a payload dump on a page whose entire claim
    // is that it never prints bytes.
    const raw = err instanceof Error ? err.message : String(err);
    return {
      error: raw.length > 200 ? `${raw.slice(0, 200)}… (truncated)` : raw,
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
  const { config, bag } = opts;
  const storeBacked = config.gateway.secrets.provider !== "env";

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
    const key = requirement.consoleKeys.find((k) => nonEmpty(bag[k]));
    if (key) {
      return finish(requirement, bag[key] as string, {
        where: `core's environment, under ${key} (declared by consoleEnv:)`,
        source: "ENV",
      });
    }
    if (nonEmpty(bag[requirement.name])) {
      return finish(requirement, bag[requirement.name] as string, {
        where: `core's environment, under \${${requirement.name}} itself`,
        source: "ENV",
      });
    }
    return {
      requirement,
      state: "missing",
      // Where it HAS to be seeded: the deploy environment, fed from Secret
      // Manager by the deploy workflow.
      source: "GSM",
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

  if ("ok" in attempt && attempt.ok !== null) {
    return finish(requirement, attempt.ok, {
      where: storeBacked
        ? `the parameter store, under ${gatewayNamespace(config.gateway.env)}`
        : "this process's environment",
      source: storeBacked ? "GSM" : "ENV",
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
      detail:
        `The secret backend could not be consulted for this name, so its status is ` +
        `unknown — NOT absent. Detail: ${attempt.error}`,
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
      detail:
        `Declared only under a supplementary server's env:, which is baked onto that ` +
        `component at deploy time and never broadcast to core — so the console cannot ` +
        `confirm it either way. It was present at the last successful deploy, because a ` +
        `missing one fails the render. Set gateway.secrets.provider to ` +
        `"gcp-parameter-store" to make this checkable at runtime.`,
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
    detail: storeBacked
      ? `Not seeded: ${gatewayNamespace(config.gateway.env)}${requirement.name} does not ` +
        `exist in the parameter store, so every value that references it resolves to ` +
        `nothing and the next deploy's preflight will fail.`
      : `Not seeded: \${${requirement.name}} does not resolve from this process's ` +
        `environment, so the gateway cannot build the value that references it.`,
  };
}

function finish(
  requirement: SecretRequirement,
  value: string,
  ctx: { where: string; source: SecretSource },
): SecretObservation {
  const reason = placeholderReason(value);
  if (reason) {
    return {
      requirement,
      state: "placeholder",
      source: ctx.source,
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
    detail:
      `Resolves from ${ctx.where}. That proves a value EXISTS — strad does not call ` +
      `the upstream, so it is not a claim that the credential is accepted.`,
  };
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
const STATE_RANK: Record<SecretState, number> = {
  missing: 4,
  placeholder: 3,
  error: 2,
  unobservable: 1,
  present: 0,
};

const FROM_SECRET_STATE: Record<SecretState, ServerState> = {
  missing: "missing",
  placeholder: "placeholder",
  error: "unknown",
  unobservable: "unverified",
  present: "ready",
};

export const STATE_LABEL: Record<ServerState, string> = {
  ready: "ready",
  "no-secrets": "no secrets",
  missing: "not seeded",
  placeholder: "check value",
  unverified: "unverified",
  unknown: "unknown",
};

/** Whether a state should read as a problem a human has to act on. */
export function isActionable(state: ServerState): boolean {
  return state === "missing" || state === "placeholder";
}

export function deriveServerStatuses(
  config: StradConfig,
  observations: SecretObservation[],
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

      if (requirements.length === 0) {
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
  const plural = total === 1 ? "secret" : "secrets";
  switch (state) {
    case "ready":
      return `All ${total} required ${plural} resolve. strad has not verified that any upstream accepts them.`;
    case "missing":
      return `${bad.length} of ${total} required ${plural} not seeded: ${names}.`;
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

  // For a `params: true` server the per-server namespace is the more specific
  // (and usually the intended) home: it lands on exactly that component.
  for (const slug of requirement.paramsSlugs) {
    const serverPath = `${staticNamespace(gatewayEnv, slug)}${requirement.name}`;
    targets.push({
      store: "GCP Parameter Manager + Secret Manager",
      resource: serverPath,
      project,
      detail:
        `"${slug}" sets \`params: true\`, so everything under its static namespace is ` +
        `resolved into that server's environment and this is the narrowest place to put a ` +
        `credential only it needs.${projectNote}`,
      commands: [
        `# In the console: prefix "${slug}/static/", variable ${requirement.name}.`,
      ],
      href: `/ui/secrets?ns=${encodeURIComponent(staticNamespace(gatewayEnv, slug))}`,
    });
  }

  targets.push(
    ...(storeBacked ? [storeTarget, bakedTarget] : [bakedTarget, storeTarget]),
  );
  return targets;
}

function secretManagerCommands(name: string, project: string): string[] {
  return [
    `gcloud secrets create ${name} --project ${project} --replication-policy automatic`,
    `printf %s "$VALUE" | gcloud secrets versions add ${name} --project ${project} --data-file=-`,
  ];
}
