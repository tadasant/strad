/**
 * The presence vocabulary: what a process may say about a secret it holds.
 *
 * This module exists because TWO processes have to answer the same question in
 * the same words. Core answers it for the values in its own environment and in
 * the parameter store; a BUNDLE answers it for the values baked onto its
 * component, which core cannot see (see src/gateway/bundle-presence.ts). A
 * console that rendered "present" from core and "set" from a bundle would be two
 * pages wearing one layout.
 *
 * ## The rule this file enforces
 *
 * A verdict is derived FROM a value and carries nothing OF it. No bytes, no
 * excerpt, no hash, no length, no character class — the verdict is one of five
 * fixed words, and the reason attached to it describes the SHAPE that matched.
 * `test/presence.test.ts` asserts that across a table of hostile values, and
 * `test/presence.route.test.ts` asserts it again over the wire, because the
 * bundle path is the one where a value would be leaving the process that owns
 * it.
 *
 * That is also why this is not "return the first N characters so a human can
 * eyeball it". A page that printed four characters of a token would be printing
 * a secret, and the four characters an issuer puts at the front are the four an
 * attacker most wants.
 *
 * ## It carries BOTH ends of the wire
 *
 * The vocabulary is the top of the file; `presenceResponse` at the bottom is the
 * route those words are spoken through, and both are here for the same reason
 * `secrets/param-route.ts` carries both the shape core serves and the client the
 * host calls with. The wiring — authorize before parse, what a refusal carries,
 * `cache-control: no-store` on an answer — belongs to the seam rather than to
 * either tree, because the tree with no test runner is the one every deployment
 * actually runs: a bundle of `supplementary-image` servers runs the host image,
 * not the strad image in bundle mode. Each tree keeps only the three-line
 * express adapter that applies the result to a response.
 *
 * ## Why this file has no imports
 *
 * It is vendored, byte-identical, into `servers/bundle/host/src/presence.ts` —
 * that tree is a separate npm project with its own lockfile and its own compiler
 * settings, and it cannot import across the boundary. Zero imports is what makes
 * one file compile in both, and it is why `node:crypto`'s `timingSafeEqual` is
 * INJECTED by the caller rather than imported here. `npm run presence:sync`
 * writes the copy and `test/vendored.sync.test.ts` fails CI if it drifts.
 *
 * ## It is also where every door reads and compares a credential
 *
 * `authorizePresence` — the internal-token gate on the presence route, on the
 * host's mounts and on core's `/_strad/params` — lives here, and a vendored file
 * cannot import a sibling: the same bytes would have to say `./x.ts` in core and
 * `./x.js` in the host. So the parse and the comparator it uses are here too,
 * rather than injected, and every other door of the gateway goes through the
 * same two: `bearerToken` — how an `Authorization` header yields a credential —
 * and `constantTimeEquals` — how two credentials are compared. Core reaches
 * them through `src/auth/credential.ts`, which binds the comparator to
 * `node:crypto`; the host tree imports them from its vendored copy.
 */

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
export const PLACEHOLDER_EXACT: ReadonlySet<string> = new Set([
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

export const PLACEHOLDER_SUBSTRING: readonly string[] = [
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

/**
 * What one process can say about one name, in five words.
 *
 *   absent      — the key is not set at all.
 *   empty       — set to the empty string. An injected-but-empty var configures
 *                 nothing, and it is a different mistake from never setting it:
 *                 something DID put a value here and the value was nothing.
 *   unexpanded  — the literal text `${NAME}`. Nothing resolved the reference,
 *                 and the process would send that text upstream verbatim.
 *   placeholder — evident filler. Seeded is not working.
 *   present     — a value exists and nothing about its shape says otherwise.
 *                 NOT a claim that any upstream accepts it.
 */
export type Presence =
  "absent" | "empty" | "unexpanded" | "placeholder" | "present";

export interface PresenceVerdict {
  presence: Presence;
  /** One clause naming the shape that decided it. Never a value. */
  reason: string | null;
}

/** Classify one value, or `undefined` for a key that is not set. */
export function presenceOf(value: string | undefined | null): PresenceVerdict {
  if (value === undefined || value === null) {
    return { presence: "absent", reason: null };
  }
  if (value === "") {
    return {
      presence: "empty",
      reason: "the value is set but empty, so whatever reads it gets nothing",
    };
  }
  if (/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value.trim())) {
    return {
      presence: "unexpanded",
      reason:
        "the value is still an unexpanded ${...} reference, so nothing resolved it",
    };
  }
  const reason = placeholderReason(value);
  if (reason) return { presence: "placeholder", reason };
  return { presence: "present", reason: null };
}

/** The five words, so a decoder can reject anything else. */
export const PRESENCE_VALUES: readonly Presence[] = [
  "absent",
  "empty",
  "unexpanded",
  "placeholder",
  "present",
];

/**
 * The sentence a verdict earns, derived LOCALLY from the word alone.
 *
 * The wire carries a `reason` too, and core deliberately does not render it. The
 * five words are a closed set, so a reader gains nothing from the peer's copy and
 * a console that printed it would be letting another process write a sentence
 * into a page whose whole claim is that it authors its own. Same rule as the
 * error-message boundary in ui/secret-status.ts, one component further out.
 */
export function reasonFor(presence: Presence): string | null {
  switch (presence) {
    case "empty":
      return "the value is set but empty, so whatever reads it gets nothing";
    case "unexpanded":
      return "the value is still an unexpanded ${...} reference, so nothing resolved it";
    case "placeholder":
      return "the value is evident filler rather than a credential";
    case "absent":
    case "present":
      return null;
  }
}

export function isPresence(value: unknown): value is Presence {
  return (
    typeof value === "string" &&
    (PRESENCE_VALUES as readonly string[]).includes(value)
  );
}

// ---------------------------------------------------------------------------
// The wire protocol: one component answering for its own environment
// ---------------------------------------------------------------------------

/**
 * The route every component that holds secrets in its own process environment
 * serves, so core can ask it what it actually has.
 *
 * Underscore-prefixed and off `/mcp`, `/ui` and `/healthz`: it is neither an
 * agent surface nor a human one, and a bundle's mounts are named after server
 * slugs — `/_strad/` is the one prefix a slug cannot take.
 */
export const PRESENCE_ROUTE = "/_strad/presence";

/**
 * Bumped when the response shape changes in a way a reader must notice. Core
 * treats an unknown version as "this component speaks a protocol I do not", not
 * as an answer — the wrong direction of guess here is a false green.
 */
export const PRESENCE_PROTOCOL = 1;

export interface PresenceReport {
  protocol: number;
  /** Which component answered, e.g. "bundle". Its own name for itself. */
  component: string;
  /** The image tag it is running, when it knows one. "Which build answered." */
  image: string | null;
  /** When this process started. The freshness half of the vocabulary. */
  bootedAt: string;
  /** When it read its environment to answer. */
  observedAt: string;
  /** One verdict per requested key. Never a value. */
  keys: Record<string, PresenceVerdict>;
  /**
   * `slug -> VARIABLE[]` for every `params: true` server on this component,
   * as the deploy baked it in (`STRAD_PARAM_KEYS`). Names only.
   *
   * This is the one thing core cannot derive: a managed parameter is not a
   * `${NAME}` reference in the config, it is whatever the store held under
   * `/strad/{env}/mcp/{slug}/static/` at render time. Without it, a
   * `params: true` server is unanswerable from anywhere but the store.
   */
  paramKeys: Record<string, string[]> | null;
}

/** A key a caller may ask about: env-var shaped, and nothing else. */
const KEY_SHAPE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The most keys one request may ask about.
 *
 * A bound rather than a policy: the caller is core, asking about the names its
 * own config declares, and the largest real deployment asks for a few dozen. The
 * cap is what stops a malformed or hostile body from turning one request into an
 * unbounded loop over an attacker-chosen list.
 */
export const MAX_PRESENCE_KEYS = 256;

export type PresenceRequest =
  { ok: true; keys: string[] } | { ok: false; status: number; error: string };

/**
 * Validate a request body.
 *
 * Unknown-shaped input is refused rather than coerced. This endpoint's entire
 * value is that its answers are precise, and "we ignored the half of your
 * request we could not parse" produces a confident answer about a question
 * nobody asked.
 */
export function parsePresenceRequest(body: unknown): PresenceRequest {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, status: 400, error: "body must be a JSON object" };
  }
  const raw = (body as { keys?: unknown }).keys;
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      status: 400,
      error: "keys must be an array of strings",
    };
  }
  if (raw.length > MAX_PRESENCE_KEYS) {
    return {
      ok: false,
      status: 400,
      error: `at most ${MAX_PRESENCE_KEYS} keys per request`,
    };
  }
  const keys: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string" || !KEY_SHAPE.test(entry)) {
      // The offending entry is NOT echoed. It is attacker-controlled text that
      // would otherwise land in a log line and, on the core side, in a console
      // sentence — the one place this codebase promises free-form text never
      // reaches.
      return {
        ok: false,
        status: 400,
        error: "every key must be an environment-variable name",
      };
    }
    if (!keys.includes(entry)) keys.push(entry);
  }
  return { ok: true, keys };
}

/**
 * Is this caller allowed to ask?
 *
 * This component's own internal token, the same one core presents to proxy
 * `/mcp` to it — derived for this component alone, so a token another
 * component holds is refused here.
 *
 * FAIL CLOSED when it is not configured: a component with no token
 * cannot distinguish core from anything else in the VPC, and "the network is
 * private" is a reachability property, not an authorization one.
 *
 * What a token holder learns is presence, source and freshness for names it
 * names. Not values, not lengths, not prefixes. That matters because the
 * credential is already strictly stronger than the surface — a holder can proxy
 * `/mcp` to every server on this component — so this adds no reach it did not
 * have.
 *
 * The header is read with `bearerToken`, the same rule as every other door, and
 * that is not a parameter: the parse is not something a caller gets to loosen.
 */
export function authorizePresence(
  header: string | undefined,
  expected: string | undefined,
  /**
   * `constantTimeEquals`, bound to the caller's `node:crypto`. REQUIRED for the
   * same reason `PresenceRouteInput.timingSafeEqual` is: a default is what a
   * caller gets by saying nothing, and the one it would get is the JS loop.
   */
  equals: (a: string, b: string) => boolean,
): { ok: true } | { ok: false; status: number; error: string } {
  if (!expected) {
    return {
      ok: false,
      status: 503,
      error: "internal token not configured",
    };
  }
  const presented = bearerToken(header);
  if (!presented || !equals(presented, expected)) {
    return { ok: false, status: 401, error: "invalid internal token" };
  }
  return { ok: true };
}

/**
 * The credential an `Authorization` header carries, or null.
 *
 * ONE rule for every door in both trees. The `Bearer` scheme is required, in
 * any case (RFC 7235 makes scheme names case-insensitive), then a space, then
 * the credential, trimmed; a header with no scheme, another scheme, or nothing
 * after the scheme is null. Required rather than optional because an optional
 * prefix — `header.replace(/^Bearer\s+/i, "")` — returns a header with no
 * scheme unchanged, so it accepts a bare `Authorization: <token>` that a strict
 * door beside it refuses: the same header, answered two ways, and nobody chose
 * the difference.
 *
 * Every caller strad has sends the scheme: `internalHeaders()` in
 * `src/gateway/registry.ts`, the host's parameter write-back client, the
 * bundle smoke, and any `/mcp` client.
 */
export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const space = header.indexOf(" ");
  if (space < 0 || header.slice(0, space).toLowerCase() !== "bearer") {
    return null;
  }
  const token = header.slice(space + 1).trim();
  return token === "" ? null : token;
}

/**
 * The comparator every door compares a credential with, in both trees.
 *
 * It is a compare of BYTES, not of UTF-16 code units: two strings of equal
 * `.length` can encode to different numbers of bytes, and a token is bytes.
 * The length is compared first — that leaks the length of the presented token,
 * which is what `timingSafeEqual` itself does by throwing on a mismatch, and it
 * is not a secret worth a branchless compare.
 *
 * `timingSafeEqual` is INJECTED rather than imported because this file is
 * vendored into a tree that cannot import across the boundary. A caller with
 * `node:crypto` in scope passes it and gets the C implementation; the fallback
 * is a JS loop with no early exit, for a caller that has none. Either way the
 * framing — the utf-8 encode, the length guard, the "a mismatch must not throw"
 * rule — is one function rather than one per tree, and rather than one per
 * door: core's `secretEquals` (`src/auth/credential.ts`) is this function with
 * `node:crypto` passed in. A length guard written wrong here is wrong on every
 * door at once, which is why `test/auth-header.doors.test.ts` asserts it
 * directly rather than through any one route.
 */
export function constantTimeEquals(
  a: string,
  b: string,
  timingSafeEqual?: (a: Uint8Array, b: Uint8Array) => boolean,
): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  if (timingSafeEqual) return timingSafeEqual(left, right);
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) {
    diff |= left[i]! ^ right[i]!;
  }
  return diff === 0;
}

export interface BuildPresenceReportOptions {
  component: string;
  image?: string | null;
  bootedAt: Date;
  observedAt?: Date;
  env: Record<string, string | undefined>;
  keys: string[];
}

/**
 * Read the environment and answer, in the five words and nothing else.
 *
 * The answered set is the caller's keys PLUS every variable this component's own
 * `STRAD_PARAM_KEYS` names, and that union is not a convenience — it is what
 * makes a `params: true` server answerable at all. Core cannot ask about a
 * managed parameter, because a managed parameter is not a `${NAME}` reference
 * and the config does not name it; only this process knows the names, from the
 * manifest the render baked on. Answering only what was asked would report every
 * one of them absent on a perfectly healthy component.
 *
 * It also cannot be used to widen what a caller learns: the extra names come
 * from this component's own environment, never from the request.
 */
export function buildPresenceReport(
  opts: BuildPresenceReportOptions,
): PresenceReport {
  const paramKeys = parseParamKeys(opts.env[PARAM_KEYS_ENV]);
  const keys: Record<string, PresenceVerdict> = {};
  const answer = (key: string) => {
    if (!Object.prototype.hasOwnProperty.call(keys, key)) {
      keys[key] = presenceOf(opts.env[key]);
    }
  };
  for (const key of opts.keys) answer(key);
  for (const names of Object.values(paramKeys ?? {})) {
    for (const name of names) answer(name);
  }

  return {
    protocol: PRESENCE_PROTOCOL,
    component: opts.component,
    image: opts.image ?? null,
    bootedAt: opts.bootedAt.toISOString(),
    observedAt: (opts.observedAt ?? new Date()).toISOString(),
    keys,
    paramKeys,
  };
}

/**
 * The env var name `appspec.ts` bakes onto a supplementary component: a JSON
 * object of `slug -> VARIABLE[]`, listing the managed parameters the render
 * resolved onto it. GENERAL, not SECRET — it holds names, and names are what the
 * console prints anyway.
 */
export const PARAM_KEYS_ENV = "STRAD_PARAM_KEYS";

/** Parse it, or null. A malformed value is not half-trusted. */
export function parseParamKeys(
  raw: string | undefined,
): Record<string, string[]> | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const out: Record<string, string[]> = {};
  for (const [slug, value] of Object.entries(parsed)) {
    if (!Array.isArray(value)) return null;
    const names: string[] = [];
    for (const entry of value) {
      if (typeof entry !== "string" || !KEY_SHAPE.test(entry)) return null;
      names.push(entry);
    }
    out[slug] = names;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The route: authorize, then parse, then answer
// ---------------------------------------------------------------------------

/**
 * One HTTP answer, as a value rather than as a side effect on a response.
 *
 * Framework-free on purpose: both adapters are three lines of express, and a
 * handler that returned nothing would only be reachable through a socket. This
 * one is reachable from a unit test in either tree.
 */
export interface PresenceResponse {
  status: number;
  /** Applied verbatim. Empty on a refusal — only an answer is worth caching rules. */
  headers: Record<string, string>;
  body: PresenceReport | { error: string };
}

export interface PresenceRouteInput {
  /** The `authorization` header, as express reports it. */
  authorization: string | undefined;
  /** The parsed JSON body, whatever it turned out to be. */
  body: unknown;
  /**
   * The process environment: the thing being reported ON, and also where the
   * internal token and the provenance come from.
   */
  env: Record<string, string | undefined>;
  /** When THIS process started. The freshness half of the report. */
  bootedAt: Date;
  /**
   * What to answer under when the environment names nobody.
   *
   * The two callers legitimately know different things about themselves — the
   * host image knows its own package version, core in bundle mode knows none —
   * so the FALLBACKS are the adapter's and the env lookup is shared. Reversing
   * that would be two copies of "who am I" resolving in different orders.
   */
  component?: string;
  image?: string | null;
  /** Injected so the clock under test is not the wall clock. */
  now?: () => Date;
  /**
   * `node:crypto`'s `timingSafeEqual`. REQUIRED, though `constantTimeEquals`
   * has a fallback: this module is vendored and import-free, so it cannot reach
   * for the C implementation itself, and an optional field would let a third
   * adapter take the JS loop by saying nothing. Making it required turns that
   * into a compile error in whichever tree forgot.
   */
  timingSafeEqual: (a: Uint8Array, b: Uint8Array) => boolean;
}

/**
 * `POST /_strad/presence`, as a function of its inputs.
 *
 * The vocabulary above decides what a verdict may say; this decides the ORDER
 * the three steps run in, what a caller learns when one of them refuses, and
 * which headers an answer carries. It is ONE implementation, vendored across
 * the npm-tree boundary like the vocabulary it sits on (`npm run
 * presence:sync`), because the tree that serves it in production is the tree a
 * second copy would rot in unwatched.
 *
 * AUTHORIZE BEFORE PARSE IS THE POINT. An unauthorized caller learns nothing
 * about which bodies this endpoint would have accepted, so a 401 comes back for
 * a malformed body just as it does for a well-formed one.
 */
export function presenceResponse(input: PresenceRouteInput): PresenceResponse {
  const auth = authorizePresence(
    input.authorization,
    input.env.STRAD_INTERNAL_TOKEN,
    (a, b) => constantTimeEquals(a, b, input.timingSafeEqual),
  );
  if (!auth.ok) {
    return { status: auth.status, headers: {}, body: { error: auth.error } };
  }

  const parsed = parsePresenceRequest(input.body);
  if (!parsed.ok) {
    return {
      status: parsed.status,
      headers: {},
      body: { error: parsed.error },
    };
  }

  return {
    status: 200,
    // Never cached. The answer changes the moment a deploy lands, and a stale
    // "absent" is exactly the thing that would keep a fixed connector looking
    // broken — the failure mode the readiness endpoint refuses for the same
    // reason.
    headers: { "cache-control": "no-store" },
    body: buildPresenceReport({
      component:
        input.env.STRAD_COMPONENT ??
        input.env.STRAD_BUNDLE ??
        input.component ??
        "bundle",
      image: input.env.STRAD_VERSION ?? input.image ?? null,
      bootedAt: input.bootedAt,
      observedAt: input.now?.(),
      env: input.env,
      keys: parsed.keys,
    }),
  };
}
