import {
  createPublicKey,
  constants as cryptoConstants,
  verify as cryptoVerify,
  type JsonWebKey,
  type KeyObject,
} from "node:crypto";
import {
  clientIdUrlProblem,
  freshnessMs,
  guardedFetch,
  jwksUriProblem,
  MetadataFetchRefused,
  type ClientMetadataResolver,
  type DocumentFetcher,
  type FetchedDocument,
} from "./cimd.ts";
import type { ClientPolicy } from "./policy.ts";

/**
 * `private_key_jwt` client authentication (RFC 7523 §2.2, RFC 7521), for
 * CONFIDENTIAL clients identified by a client id metadata document.
 *
 * ## Why it exists
 *
 * Every other client of this server is public: whoever holds its refresh token
 * IS the client. A confidential client proves, on every call to the token and
 * revocation endpoints, that it holds a private key whose public half it
 * published — so a refresh token stolen from its backend is worthless without
 * the key, and a key held in a KMS cannot be copied out to go with it.
 *
 * ## What a valid assertion is
 *
 * A compact JWS, signed with one of `ASSERTION_ALGORITHMS` (asymmetric only;
 * `none` and every HMAC are absent by construction, not by a check), whose
 * claims say:
 *
 *   - `iss` and `sub` — both exactly the client id.
 *   - `aud` — this authorization server: its issuer (the origin), its token
 *     endpoint URL, or the URL of the endpoint the assertion was sent to. A
 *     string, or an array containing one of those.
 *   - `exp` — in the future, and at most `ASSERTION_MAX_LIFETIME_S` ahead.
 *     `nbf` and `iat`, when present, not in the future.
 *   - `jti` — never seen before from this client while the assertion is live.
 *
 * Every time comparison allows `CLOCK_SKEW_S` either way.
 *
 * ## Where the keys come from
 *
 * In order: the client's config entry's `jwksUri` (an operator PIN — a
 * tampered document cannot swap the keys under it), else the document's own
 * `jwks_uri`, else its inline `jwks`. A JWKS URL is fetched by
 * `guardedFetch` — every SSRF rule the document fetch has — and cached by
 * `Cache-Control` within the same bounds. An assertion naming a `kid` the
 * cached set lacks triggers ONE refetch, at most once per
 * `JWKS_REFETCH_INTERVAL_MS` per URL, which is how a rotation lands without a
 * random-`kid` loop turning this process into a fetch amplifier.
 *
 * ## Whether it is required
 *
 * Not decided here. `src/http/oauth.ts` decides — the config entry, or the
 * `auth` sealed into the grant at `/oauth/authorize` — and calls
 * `ClientAuthenticator.authenticate` with `required`. A grant handler that
 * needs to know "was this request client-authenticated, and as whom" reads the
 * `ClientAuthentication` it gets back.
 */

/** RFC 7523 §2.2. The one `client_assertion_type` this server reads. */
export const CLIENT_ASSERTION_TYPE =
  "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";

/** The method name, as RFC 7591 and RFC 8414 spell it. */
export const PRIVATE_KEY_JWT = "private_key_jwt";

export type AuthMethod = "none" | typeof PRIVATE_KEY_JWT;

/**
 * The signature algorithms an assertion may use. Asymmetric only: a shared
 * secret in a public metadata document is forbidden outright, and an HMAC
 * "verified" against a public key is the classic algorithm-confusion forgery.
 */
export const ASSERTION_ALGORITHMS = [
  "RS256",
  "RS384",
  "RS512",
  "PS256",
  "PS384",
  "PS512",
  "ES256",
  "ES384",
  "ES512",
  "EdDSA",
] as const;
export type AssertionAlgorithm = (typeof ASSERTION_ALGORITHMS)[number];

/** The longest an assertion may live, from now. RFC 7523bis asks for short. */
export const ASSERTION_MAX_LIFETIME_S = 300;

/** Allowed disagreement between the client's clock and this one. */
export const CLOCK_SKEW_S = 30;

/** No real assertion is anywhere near this; anything larger is refused unread. */
export const ASSERTION_MAX_CHARS = 8 * 1024;

/** A JWKS is bigger than a metadata document — an RSA key alone is ~0.5 KiB. */
export const JWKS_MAX_BYTES = 16 * 1024;

/** The most keys one set may hold. */
export const JWKS_MAX_KEYS = 16;

/** How soon an unknown `kid` may make a JWKS URL be fetched again. */
export const JWKS_REFETCH_INTERVAL_MS = 30_000;

/** Concurrent JWKS fetches across every URL, refused past this, not queued. */
export const JWKS_MAX_CONCURRENT_FETCHES = 16;

/** How many JWKS URLs the cache holds. */
const JWKS_CACHE_ENTRIES = 64;

/** How many live `jti`s the replay cache holds before it refuses new ones. */
export const REPLAY_CACHE_ENTRIES = 10_000;

/**
 * How many of those one client may hold. Without it, one confidential client
 * signing assertions in a loop fills the cache and locks every other one out
 * for an assertion's lifetime; with it, it only locks itself out.
 */
export const REPLAY_CACHE_ENTRIES_PER_CLIENT = 1_000;

const RSA_MIN_BITS = 2048;

/** Who authenticated, and how. What a grant handler reads. */
export interface ClientAuthentication {
  clientId: string;
  method: AuthMethod;
  /** The `kid` of the key that verified the assertion, when it had one. */
  keyId?: string;
}

/** Closed, so the word can ride on `mcp_oauth.refused` as its `reason`. */
export type ClientAuthRefusal =
  | "client_assertion_missing"
  | "client_assertion_malformed"
  | "client_assertion_invalid"
  | "client_assertion_replayed"
  | "client_keys_unavailable";

export type ClientAuthOutcome =
  | { ok: true; client: ClientAuthentication }
  | { ok: false; reason: ClientAuthRefusal; description: string };

/** Where a client's public keys are read from. */
export type KeySource =
  { kind: "uri"; uri: string } | { kind: "inline"; jwks: unknown };

// ---------------------------------------------------------------------------
// JWKS
// ---------------------------------------------------------------------------

interface VerificationKey {
  kid?: string;
  /** The `alg` the key is restricted to, when the set says so. */
  alg?: string;
  key: KeyObject;
}

/** The members of a public JWK that carry key material, per `kty`. */
const PUBLIC_MEMBERS: Record<string, readonly string[]> = {
  RSA: ["n", "e"],
  EC: ["crv", "x", "y"],
  OKP: ["crv", "x"],
};

/** Members that only a PRIVATE (or symmetric) JWK has. */
const PRIVATE_MEMBERS = ["d", "p", "q", "dp", "dq", "qi", "oth", "k"];

/**
 * Read a JWK Set into verification keys, or say why it cannot be used.
 *
 * Keys this server cannot use — `use: enc`, an unknown `kty`, a symmetric
 * `oct` key — are skipped rather than refused: a set is published for every
 * relying party at once. A key carrying PRIVATE material refuses the whole
 * set, because a published private key means the client is already
 * compromised and nothing it signs can be trusted.
 */
export function parseJwks(
  body: unknown,
): { ok: true; keys: VerificationKey[] } | { ok: false; description: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, description: "the JWK Set must be a JSON object" };
  }
  const raw = (body as { keys?: unknown }).keys;
  if (!Array.isArray(raw)) {
    return { ok: false, description: 'the JWK Set has no "keys" array' };
  }
  if (raw.length > JWKS_MAX_KEYS) {
    return {
      ok: false,
      description: `the JWK Set holds more than ${JWKS_MAX_KEYS} keys`,
    };
  }
  const keys: VerificationKey[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const jwk = entry as Record<string, unknown>;
    if (PRIVATE_MEMBERS.some((m) => m in jwk)) {
      return {
        ok: false,
        description:
          "the JWK Set publishes private or symmetric key material, so none of it is trusted",
      };
    }
    if (jwk.use !== undefined && jwk.use !== "sig") continue;
    if (
      Array.isArray(jwk.key_ops) &&
      !jwk.key_ops.includes("verify") &&
      jwk.key_ops.length > 0
    ) {
      continue;
    }
    const kty = typeof jwk.kty === "string" ? jwk.kty : "";
    const members = PUBLIC_MEMBERS[kty];
    if (!members) continue;
    const material: Record<string, unknown> = { kty };
    for (const m of members) {
      if (typeof jwk[m] !== "string") {
        material.kty = "";
        break;
      }
      material[m] = jwk[m];
    }
    if (material.kty === "") continue;
    let key: KeyObject;
    try {
      key = createPublicKey({
        key: material as JsonWebKey,
        format: "jwk",
      });
    } catch {
      continue;
    }
    if (kty === "RSA") {
      const bits = key.asymmetricKeyDetails?.modulusLength ?? 0;
      if (bits < RSA_MIN_BITS) continue;
    }
    if (kty === "OKP" && key.asymmetricKeyType !== "ed25519") continue;
    keys.push({
      ...(typeof jwk.kid === "string" ? { kid: jwk.kid } : {}),
      ...(typeof jwk.alg === "string" ? { alg: jwk.alg } : {}),
      key,
    });
  }
  return { ok: true, keys };
}

interface JwksEntry {
  keys: VerificationKey[];
  fetchedAt: number;
  expiresAt: number;
}

type JwksOutcome =
  | { ok: true; keys: VerificationKey[]; fetchedAt: number }
  | { ok: false; description: string };

/**
 * Fetch and cache JWK Sets by URL. Same rules as `ClientMetadataResolver`:
 * `guardedFetch`, `200` and JSON only, `Cache-Control` bounded to an hour,
 * failures never cached, one fetch in flight per URL.
 */
export class JwksResolver {
  private readonly fetchDocument: DocumentFetcher;
  private readonly now: () => number;
  private readonly cache = new Map<string, JwksEntry>();
  private readonly inFlight = new Map<string, Promise<JwksOutcome>>();
  private readonly maxConcurrent: number;

  constructor(
    opts: {
      fetch?: DocumentFetcher;
      now?: () => number;
      maxConcurrent?: number;
    } = {},
  ) {
    this.fetchDocument =
      opts.fetch ??
      ((url) =>
        guardedFetch(url, { maxBytes: JWKS_MAX_BYTES, subject: "JWK Set" }));
    this.now = opts.now ?? (() => Date.now());
    this.maxConcurrent = opts.maxConcurrent ?? JWKS_MAX_CONCURRENT_FETCHES;
  }

  /** The cached set when fresh, else a fetch. */
  async get(uri: string): Promise<JwksOutcome> {
    const cached = this.cache.get(uri);
    if (cached && cached.expiresAt > this.now()) {
      return { ok: true, keys: cached.keys, fetchedAt: cached.fetchedAt };
    }
    return this.fetch(uri);
  }

  /**
   * Fetch again because an assertion named a `kid` the set lacks — unless the
   * set was fetched within `JWKS_REFETCH_INTERVAL_MS`, in which case the
   * answer is null and the `kid` is simply unknown.
   */
  async refetchForUnknownKid(
    uri: string,
    lastFetchedAt: number,
  ): Promise<JwksOutcome | null> {
    if (this.now() - lastFetchedAt < JWKS_REFETCH_INTERVAL_MS) return null;
    const cached = this.cache.get(uri);
    if (cached && cached.fetchedAt > lastFetchedAt) {
      // Someone else refetched in the meantime.
      return { ok: true, keys: cached.keys, fetchedAt: cached.fetchedAt };
    }
    return this.fetch(uri);
  }

  private fetch(uri: string): Promise<JwksOutcome> {
    const pending = this.inFlight.get(uri);
    if (pending) return pending;
    if (this.inFlight.size >= this.maxConcurrent) {
      return Promise.resolve({
        ok: false,
        description:
          "strad is fetching too many JWK Sets at once; try again shortly",
      });
    }
    const work = this.fetchAndParse(uri).finally(() =>
      this.inFlight.delete(uri),
    );
    this.inFlight.set(uri, work);
    return work;
  }

  private async fetchAndParse(uri: string): Promise<JwksOutcome> {
    const problem = jwksUriProblem(uri);
    if (problem) return { ok: false, description: problem };
    let fetched: FetchedDocument;
    try {
      fetched = await this.fetchDocument(new URL(uri));
    } catch (err) {
      return {
        ok: false,
        description:
          err instanceof MetadataFetchRefused
            ? err.message
            : "the JWK Set could not be fetched",
      };
    }
    if (fetched.status !== 200) {
      return {
        ok: false,
        description: `the jwks_uri answered ${fetched.status}, not 200`,
      };
    }
    const type =
      fetched.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() ??
      "";
    if (
      type !== "application/json" &&
      !(type.startsWith("application/") && type.endsWith("+json"))
    ) {
      return { ok: false, description: "the JWK Set is not served as JSON" };
    }
    let body: unknown;
    try {
      body = JSON.parse(fetched.body.toString("utf8"));
    } catch {
      return { ok: false, description: "the JWK Set is not valid JSON" };
    }
    const parsed = parseJwks(body);
    if (!parsed.ok) return parsed;
    const fetchedAt = this.now();
    const ttl = freshnessMs(fetched.headers);
    if (this.cache.size >= JWKS_CACHE_ENTRIES && !this.cache.has(uri)) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    // Stored even at a zero TTL: `fetchedAt` is what throttles the
    // unknown-`kid` refetch, and a `no-store` set must not defeat it.
    this.cache.set(uri, {
      keys: parsed.keys,
      fetchedAt,
      expiresAt: fetchedAt + ttl,
    });
    return { ok: true, keys: parsed.keys, fetchedAt };
  }
}

// ---------------------------------------------------------------------------
// The assertion
// ---------------------------------------------------------------------------

interface DecodedAssertion {
  header: Record<string, unknown>;
  claims: Record<string, unknown>;
  signingInput: Buffer;
  signature: Buffer;
}

function decodeSegment(segment: string): Record<string, unknown> | null {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) return null;
  try {
    const value = JSON.parse(
      Buffer.from(segment, "base64url").toString("utf8"),
    ) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function decode(assertion: string): DecodedAssertion | null {
  if (assertion.length > ASSERTION_MAX_CHARS) return null;
  const parts = assertion.split(".");
  if (parts.length !== 3) return null;
  const [h = "", c = "", s = ""] = parts;
  const header = decodeSegment(h);
  const claims = decodeSegment(c);
  if (!header || !claims || !/^[A-Za-z0-9_-]+$/.test(s)) return null;
  return {
    header,
    claims,
    signingInput: Buffer.from(`${h}.${c}`, "ascii"),
    signature: Buffer.from(s, "base64url"),
  };
}

/**
 * The `iss` of an assertion, UNVERIFIED. For one use only: finding which
 * client a request that sent no `client_id` claims to be, so its keys can be
 * looked up. Nothing is trusted on it until `verify` has checked the
 * signature and `iss` again.
 */
export function assertionIssuer(assertion: string): string | undefined {
  const iss = decode(assertion)?.claims.iss;
  return typeof iss === "string" ? iss : undefined;
}

/** Does this key fit this algorithm? The key's own `alg` must agree too. */
function keyFits(k: VerificationKey, alg: AssertionAlgorithm): boolean {
  if (k.alg !== undefined && k.alg !== alg) return false;
  const type = k.key.asymmetricKeyType;
  const curve = k.key.asymmetricKeyDetails?.namedCurve;
  switch (alg) {
    case "RS256":
    case "RS384":
    case "RS512":
    case "PS256":
    case "PS384":
    case "PS512":
      return type === "rsa";
    case "ES256":
      return type === "ec" && curve === "prime256v1";
    case "ES384":
      return type === "ec" && curve === "secp384r1";
    case "ES512":
      return type === "ec" && curve === "secp521r1";
    case "EdDSA":
      return type === "ed25519";
  }
}

function signatureValid(
  alg: AssertionAlgorithm,
  key: KeyObject,
  data: Buffer,
  signature: Buffer,
): boolean {
  try {
    if (alg === "EdDSA") return cryptoVerify(null, data, key, signature);
    const hash = `sha${alg.slice(2)}`;
    if (alg.startsWith("RS")) return cryptoVerify(hash, data, key, signature);
    if (alg.startsWith("PS")) {
      return cryptoVerify(
        hash,
        data,
        {
          key,
          padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
          saltLength: Number(alg.slice(2)) / 8,
        },
        signature,
      );
    }
    return cryptoVerify(
      hash,
      data,
      { key, dsaEncoding: "ieee-p1363" },
      signature,
    );
  } catch {
    return false;
  }
}

/**
 * The `jti`s already spent, per client, until their assertion expires.
 *
 * Written only AFTER a signature verifies, so filling it needs the client's
 * private key. Bounded anyway; past the bound a new assertion is refused
 * rather than an old entry evicted, because eviction is a replay window.
 * Per process — the same honest limit as `SpentCodes`.
 */
export class AssertionReplayCache {
  private readonly seen = new Map<string, { clientId: string; exp: number }>();
  private readonly perClient = new Map<string, number>();
  constructor(
    private readonly max: number = REPLAY_CACHE_ENTRIES,
    private readonly maxPerClient: number = REPLAY_CACHE_ENTRIES_PER_CLIENT,
  ) {}

  /** "fresh" the first time, "replayed" after, "full" when at a bound. */
  spend(
    clientId: string,
    jti: string,
    expiresAtMs: number,
    now: number,
  ): "fresh" | "replayed" | "full" {
    for (const [k, entry] of this.seen) {
      if (entry.exp > now) continue;
      this.seen.delete(k);
      const n = (this.perClient.get(entry.clientId) ?? 1) - 1;
      if (n <= 0) this.perClient.delete(entry.clientId);
      else this.perClient.set(entry.clientId, n);
    }
    const key = `${clientId}\n${jti}`;
    if (this.seen.has(key)) return "replayed";
    const held = this.perClient.get(clientId) ?? 0;
    if (this.seen.size >= this.max || held >= this.maxPerClient) return "full";
    this.seen.set(key, { clientId, exp: expiresAtMs });
    this.perClient.set(clientId, held + 1);
    return "fresh";
  }

  get size(): number {
    return this.seen.size;
  }
}

export interface VerifyAssertionInput {
  clientId: string;
  assertion: string;
  /** Every `aud` value that names this server for this request. */
  audiences: readonly string[];
  keys: KeySource;
  /** The document's `token_endpoint_auth_signing_alg`, when it named one. */
  requiredAlg?: string;
}

/**
 * Verifies RFC 7523 client assertions. One per authorization server.
 */
export class ClientAssertionVerifier {
  readonly jwks: JwksResolver;
  private readonly replay: AssertionReplayCache;
  private readonly now: () => number;

  constructor(
    opts: {
      fetch?: DocumentFetcher;
      now?: () => number;
      replayEntries?: number;
    } = {},
  ) {
    this.now = opts.now ?? (() => Date.now());
    this.jwks = new JwksResolver({
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
      now: this.now,
    });
    this.replay = new AssertionReplayCache(opts.replayEntries);
  }

  async verify(input: VerifyAssertionInput): Promise<ClientAuthOutcome> {
    const invalid = (description: string): ClientAuthOutcome => ({
      ok: false,
      reason: "client_assertion_invalid",
      description,
    });
    const decoded = decode(input.assertion);
    if (!decoded) {
      return {
        ok: false,
        reason: "client_assertion_malformed",
        description: "client_assertion is not a compact JWS",
      };
    }
    const { header, claims } = decoded;

    // --- the header ---------------------------------------------------------
    const alg = header.alg;
    if (
      typeof alg !== "string" ||
      !(ASSERTION_ALGORITHMS as readonly string[]).includes(alg)
    ) {
      return invalid(
        `client_assertion alg must be one of ${ASSERTION_ALGORITHMS.join(", ")}`,
      );
    }
    const algorithm = alg as AssertionAlgorithm;
    if (input.requiredAlg !== undefined && input.requiredAlg !== alg) {
      return invalid(
        `this client's metadata names token_endpoint_auth_signing_alg ${input.requiredAlg}`,
      );
    }
    // RFC 7515 §4.1.11: an extension this server does not implement must
    // fail, and it implements none. `jku`/`x5u`/`jwk` are ignored — keys come
    // from the client's registration, never from the token that is being
    // verified.
    if (header.crit !== undefined) {
      return invalid(
        "client_assertion carries a crit header strad does not implement",
      );
    }
    if (
      header.typ !== undefined &&
      header.typ !== "JWT" &&
      header.typ !== "client-authentication+jwt"
    ) {
      return invalid(
        'client_assertion typ must be "JWT" or "client-authentication+jwt" when present',
      );
    }
    const kid = typeof header.kid === "string" ? header.kid : undefined;

    // --- the claims, before the key fetch, so a stale or misaddressed
    // assertion costs nothing ---------------------------------------------
    if (claims.iss !== input.clientId || claims.sub !== input.clientId) {
      return invalid("client_assertion iss and sub must both be the client_id");
    }
    const aud = claims.aud;
    const auds =
      typeof aud === "string" ? [aud] : Array.isArray(aud) ? aud : [];
    if (
      !auds.some((a) => typeof a === "string" && input.audiences.includes(a))
    ) {
      return invalid(
        `client_assertion aud must name this authorization server (${input.audiences[0] ?? ""})`,
      );
    }
    const nowS = this.now() / 1000;
    const exp = claims.exp;
    if (typeof exp !== "number" || !Number.isFinite(exp)) {
      return invalid("client_assertion must carry a numeric exp");
    }
    if (exp <= nowS - CLOCK_SKEW_S) {
      return invalid("client_assertion has expired");
    }
    if (exp > nowS + ASSERTION_MAX_LIFETIME_S + CLOCK_SKEW_S) {
      return invalid(
        `client_assertion exp may be at most ${ASSERTION_MAX_LIFETIME_S} seconds ahead`,
      );
    }
    for (const name of ["nbf", "iat"] as const) {
      const v = claims[name];
      if (v === undefined) continue;
      if (typeof v !== "number" || v > nowS + CLOCK_SKEW_S) {
        return invalid(`client_assertion ${name} is in the future`);
      }
    }
    const jti = claims.jti;
    if (typeof jti !== "string" || jti === "" || jti.length > 256) {
      return invalid(
        "client_assertion must carry a jti of at most 256 characters",
      );
    }

    // --- the key ------------------------------------------------------------
    let keys: VerificationKey[];
    let fetchedAt = 0;
    if (input.keys.kind === "inline") {
      const parsed = parseJwks(input.keys.jwks);
      if (!parsed.ok) {
        return {
          ok: false,
          reason: "client_keys_unavailable",
          description: parsed.description,
        };
      }
      keys = parsed.keys;
    } else {
      const got = await this.jwks.get(input.keys.uri);
      if (!got.ok) {
        return {
          ok: false,
          reason: "client_keys_unavailable",
          description: got.description,
        };
      }
      keys = got.keys;
      fetchedAt = got.fetchedAt;
    }
    let candidates = pick(keys, algorithm, kid);
    if (
      candidates.length === 0 &&
      kid !== undefined &&
      input.keys.kind === "uri"
    ) {
      // A key the cached set does not have: rotation, maybe. One refetch.
      const again = await this.jwks.refetchForUnknownKid(
        input.keys.uri,
        fetchedAt,
      );
      if (again && !again.ok) {
        return {
          ok: false,
          reason: "client_keys_unavailable",
          description: again.description,
        };
      }
      if (again?.ok) candidates = pick(again.keys, algorithm, kid);
    }
    if (candidates.length === 0) {
      return invalid(
        kid !== undefined
          ? `no ${algorithm} key with kid "${kid}" is published for this client`
          : `no ${algorithm} key is published for this client`,
      );
    }
    if (candidates.length > 1) {
      return invalid(
        "several published keys fit this assertion; it must name one with kid",
      );
    }
    const [chosen] = candidates as [VerificationKey];
    if (
      !signatureValid(
        algorithm,
        chosen.key,
        decoded.signingInput,
        decoded.signature,
      )
    ) {
      return invalid("client_assertion signature does not verify");
    }

    // --- single use, last, so only a signed assertion takes a slot ----------
    const spent = this.replay.spend(
      input.clientId,
      jti,
      (exp + CLOCK_SKEW_S) * 1000,
      this.now(),
    );
    if (spent === "replayed") {
      return {
        ok: false,
        reason: "client_assertion_replayed",
        description: "this client_assertion has already been used",
      };
    }
    if (spent === "full") {
      return {
        ok: false,
        reason: "client_assertion_replayed",
        description:
          "strad cannot record another assertion right now; try again shortly",
      };
    }
    return {
      ok: true,
      client: {
        clientId: input.clientId,
        method: PRIVATE_KEY_JWT,
        ...(chosen.kid !== undefined ? { keyId: chosen.kid } : {}),
      },
    };
  }
}

function pick(
  keys: readonly VerificationKey[],
  alg: AssertionAlgorithm,
  kid: string | undefined,
): VerificationKey[] {
  return keys.filter(
    (k) => keyFits(k, alg) && (kid === undefined || k.kid === kid),
  );
}

// ---------------------------------------------------------------------------
// The question a grant handler asks
// ---------------------------------------------------------------------------

export interface AuthenticateInput {
  /** The request's `client_id`, or the assertion's `iss` when it sent none. */
  clientId: string;
  /** The client's resolved policy (`policy.ts`). */
  policy: ClientPolicy;
  /** Must this request carry a valid assertion? The caller decides. */
  required: boolean;
  /** `client_assertion_type`, as sent. */
  assertionType: string | undefined;
  /** `client_assertion`, as sent. */
  assertion: string | undefined;
  /** Every `aud` value that names this server for this request. */
  audiences: readonly string[];
}

/**
 * "Was this request client-authenticated, and as whom?"
 *
 * A request that need not authenticate gets `method: "none"` — the public
 * client every grant here was before this file — and any assertion it sent is
 * not read, which is exactly what this server did with one before. A request
 * that must authenticate gets `private_key_jwt` or a refusal; there is no
 * third answer, and in particular no fall-back to public when the keys cannot
 * be fetched.
 */
export class ClientAuthenticator {
  constructor(
    private readonly verifier: ClientAssertionVerifier,
    private readonly documents: ClientMetadataResolver,
  ) {}

  async authenticate(input: AuthenticateInput): Promise<ClientAuthOutcome> {
    if (!input.required) {
      return { ok: true, client: { clientId: input.clientId, method: "none" } };
    }
    if (input.assertion === undefined) {
      return {
        ok: false,
        reason: "client_assertion_missing",
        description:
          "this client authenticates with private_key_jwt: client_assertion is required",
      };
    }
    if (input.assertionType !== CLIENT_ASSERTION_TYPE) {
      return {
        ok: false,
        reason: "client_assertion_malformed",
        description: `client_assertion_type must be ${CLIENT_ASSERTION_TYPE}`,
      };
    }
    const source = await this.keySource(input.clientId, input.policy);
    if (!source.ok) {
      return {
        ok: false,
        reason: "client_keys_unavailable",
        description: source.description,
      };
    }
    return this.verifier.verify({
      clientId: input.clientId,
      assertion: input.assertion,
      audiences: input.audiences,
      keys: source.keys,
      ...(source.requiredAlg ? { requiredAlg: source.requiredAlg } : {}),
    });
  }

  /**
   * The config's pin, else the client's document. The document is the one
   * `/oauth/authorize` fetched, from the same cache; a confidential client's
   * token calls depend on its key host anyway, so depending on its document
   * host too adds nothing a public client's refresh is exposed to — public
   * clients never reach this line.
   */
  private async keySource(
    clientId: string,
    policy: ClientPolicy,
  ): Promise<
    | { ok: true; keys: KeySource; requiredAlg?: string }
    | { ok: false; description: string }
  > {
    if (policy.jwksUri)
      return { ok: true, keys: { kind: "uri", uri: policy.jwksUri } };
    if (clientIdUrlProblem(clientId) !== null) {
      return {
        ok: false,
        description:
          "only a client id metadata document client can authenticate with private_key_jwt",
      };
    }
    const doc = await this.documents.resolve(clientId);
    if (!doc.ok) return { ok: false, description: doc.description };
    const alg = doc.client.signingAlg;
    const extra = alg ? { requiredAlg: alg } : {};
    if (doc.client.jwksUri) {
      return {
        ok: true,
        keys: { kind: "uri", uri: doc.client.jwksUri },
        ...extra,
      };
    }
    if (doc.client.jwks !== undefined) {
      return {
        ok: true,
        keys: { kind: "inline", jwks: doc.client.jwks },
        ...extra,
      };
    }
    return {
      ok: false,
      description:
        "the client's metadata document publishes no jwks or jwks_uri",
    };
  }
}
