import { createHash, randomBytes } from "node:crypto";
import { secretEquals } from "./credential.ts";
import { errorSummary } from "../util/error-text.ts";
import type { SecretProvider } from "../secrets/provider/types.ts";

/**
 * Static system tokens — the credential headless agents use against /mcp.
 *
 * Format:  strad_<env>_<pubid>_<secret>
 *          strad_staging_7f3a91c2_i8Kx...  (secret is 32 bytes, base64url)
 *
 * The `pubid` is a non-secret lookup key. It exists so that verification is an
 * O(1) map lookup rather than a scan-and-compare over every token, and so that
 * logs/UI can name a token without ever touching the secret.
 *
 * Only the SHA-256 of the secret is stored. The plaintext is shown exactly once
 * at mint time and is unrecoverable thereafter.
 */

export interface TokenRecord {
  /** Public, non-secret identifier. Safe to log. */
  pubid: string;
  /** Human label: "tadas laptop", "ci deploy probe". */
  label: string;
  /** hex SHA-256 of the secret segment. */
  hash: string;
  /** Roles this token holds. Entitlement is decided server-side, from here. */
  roles: string[];
  /** ISO-8601. Soft revocation: the record stays, verification fails. */
  revokedAt?: string | null;
  createdAt?: string;
}

export interface MintedToken {
  /** Show once. Never persisted. */
  plaintext: string;
  record: TokenRecord;
}

const SECRET_BYTES = 32;

export function mintToken(opts: {
  env: string;
  label: string;
  roles: string[];
}): MintedToken {
  const pubid = randomBytes(4).toString("hex");
  const secret = randomBytes(SECRET_BYTES).toString("base64url");
  const plaintext = `strad_${opts.env}_${pubid}_${secret}`;

  return {
    plaintext,
    record: {
      pubid,
      label: opts.label,
      hash: sha256(secret),
      roles: opts.roles,
      revokedAt: null,
      createdAt: new Date().toISOString(),
    },
  };
}

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

export interface ParsedToken {
  env: string;
  pubid: string;
  secret: string;
}

export function parseToken(raw: string): ParsedToken | null {
  // Split on the first THREE underscores only, then take the rest verbatim.
  //
  // Not `raw.split("_")`: the base64url alphabet includes "_", so a secret can
  // (and roughly half the time does) contain one. Splitting naively shreds a
  // perfectly valid token into 5+ parts and rejects it as malformed — an
  // intermittent auth failure that looks like anything but what it is.
  const i1 = raw.indexOf("_");
  const i2 = i1 < 0 ? -1 : raw.indexOf("_", i1 + 1);
  const i3 = i2 < 0 ? -1 : raw.indexOf("_", i2 + 1);
  if (i1 < 0 || i2 < 0 || i3 < 0) return null;

  const prefix = raw.slice(0, i1);
  const env = raw.slice(i1 + 1, i2);
  const pubid = raw.slice(i2 + 1, i3);
  const secret = raw.slice(i3 + 1);

  if (prefix !== "strad") return null;
  if (!env || !pubid || !secret) return null;
  return { env, pubid, secret };
}

/**
 * The variable the token records are filed under, in either backing.
 *
 * ONE name for both stores, which is what makes the migration a config flip
 * rather than a data move: under `env` it is the environment variable, under
 * `parameter-store` it is `/strad/{env}/gateway/static/STRAD_TOKENS` — the path
 * `hydrateBootEnv` already reads this same name from at boot
 * (`src/secrets/provider/hydrate.ts`).
 */
export const TOKENS_VARIABLE = "STRAD_TOKENS";

export interface TokenStore {
  get(pubid: string): Promise<TokenRecord | undefined>;
  list(): Promise<TokenRecord[]>;
}

/**
 * Token records from the STRAD_TOKENS env var (a JSON array of TokenRecord).
 *
 * The `auth.staticTokens.store: env` backing, and what a deployment with no
 * parameter store runs. It reads `process.env` ONCE, at construction, because
 * `process.env` does not change under a running container — so minting or
 * revoking through this store is a redeploy. `ParameterTokenStore` below is the
 * one that does not have that property.
 */
export class EnvTokenStore implements TokenStore {
  private readonly byPubid: Map<string, TokenRecord>;

  constructor(json: string | undefined) {
    const records = parseTokenRecords(json);
    this.byPubid = new Map(records.map((r) => [r.pubid, r]));
  }

  async get(pubid: string): Promise<TokenRecord | undefined> {
    return this.byPubid.get(pubid);
  }

  async list(): Promise<TokenRecord[]> {
    return [...this.byPubid.values()];
  }
}

/**
 * Token records read from the runtime secret provider, on the request path.
 *
 * The `auth.staticTokens.store: parameter-store` backing. `provider` is the
 * SHARED provider (`src/secrets/provider/index.ts`) — the same object every
 * gateway-level `${NAME}` resolves through — so this adds no second client, no
 * second credential and no second reading of the store. What it adds is that
 * the answer is read at verification time rather than baked at boot, which is
 * what lets a revocation made in the console take effect on a running gateway.
 *
 * ## Failing closed is the whole point
 *
 * `/mcp` authorization is the one place in strad where being wrong is silent,
 * so every way this can fail to produce records denies rather than admits:
 *
 *   - the provider THROWS (the store could not be consulted, and it holds no
 *     last-known-good reading) — the throw propagates and `verifyToken` turns it
 *     into `unavailable`. Nothing is admitted.
 *   - the provider answers `null` (no such name) — zero records, so every pubid
 *     is `unknown`. Nothing is admitted.
 *   - the payload is not a JSON array of records — `parseTokenRecords` throws,
 *     same as above. A malformed store is NOT an empty store and must not read
 *     as one, but neither is it an open one.
 *
 * The one thing it does NOT do is deny during a store outage the provider can
 * still serve through. `StoreSecretProvider` serves its last known good reading
 * when a re-read fails (see `src/secrets/provider/store.ts`), so a revocation
 * made during an outage lands when the store answers again rather than within
 * `ttlSeconds`. That is a bounded staleness on the revoke side and no staleness
 * at all on the admit side — an unknown token is never admitted from a stale
 * reading — and it is strictly less stale than the boot-scoped env var it
 * replaces, where the bound is "until the next deploy".
 *
 * ## The memo
 *
 * The provider's answer is a string, and re-parsing it per request would be a
 * JSON parse on the hot path for an answer that changes a few times a month. The
 * parse is memoised on the payload's IDENTITY: the same string yields the same
 * map, a different one is re-parsed. Nothing is cached across a change, so the
 * memo cannot hold a revoked record the provider has already stopped serving.
 */
export class ParameterTokenStore implements TokenStore {
  /** The payload the memo below was parsed from. `null` until the first read. */
  private memoOf: string | null = null;
  private memo = new Map<string, TokenRecord>();

  constructor(private readonly provider: SecretProvider) {}

  async get(pubid: string): Promise<TokenRecord | undefined> {
    return (await this.load()).get(pubid);
  }

  async list(): Promise<TokenRecord[]> {
    return [...(await this.load()).values()];
  }

  private async load(): Promise<Map<string, TokenRecord>> {
    // `?? ""` and not `?? undefined`: an ABSENT name and an empty payload are
    // the same answer here — no records — and both are a store that admits
    // nobody rather than a store that admits everybody.
    const payload = (await this.provider.get(TOKENS_VARIABLE)) ?? "";
    if (payload === this.memoOf) return this.memo;
    const records = parseTokenRecords(payload);
    this.memo = new Map(records.map((r) => [r.pubid, r]));
    this.memoOf = payload;
    return this.memo;
  }
}

/**
 * The stored payload is not a list of token records.
 *
 * Its own class so the throw site can print the MESSAGE — every one of them is a
 * sentence this file wrote, naming the variable and an index and nothing else. A
 * store client's exception cannot say that of itself, which is why the two are
 * told apart rather than both reduced to a class name.
 */
export class UnreadableTokenRecords extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnreadableTokenRecords";
  }
}

/** The alphabet a `pubid` may use. See the check in `parseTokenRecords`. */
const PUBID = /^[A-Za-z0-9-]{1,64}$/;

/**
 * Parse the stored payload into records, or THROW.
 *
 * Shared by both stores and by the console's write path, so "what is a valid
 * record" is answered once. Absent and empty are zero records; anything else
 * that is not a JSON array of `{pubid, hash, roles}` is an error, never a
 * silently-empty list — see `ParameterTokenStore` for why that distinction is
 * load bearing.
 */
export function parseTokenRecords(json: string | undefined): TokenRecord[] {
  if (!json || json.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new UnreadableTokenRecords(`${TOKENS_VARIABLE} is not valid JSON`);
  }
  if (!Array.isArray(parsed)) {
    throw new UnreadableTokenRecords(
      `${TOKENS_VARIABLE} must be a JSON array of token records`,
    );
  }
  return parsed.map((r, i) => {
    const rec = r as Partial<TokenRecord>;
    if (!rec.pubid || !rec.hash || !Array.isArray(rec.roles)) {
      throw new UnreadableTokenRecords(
        `${TOKENS_VARIABLE}[${i}] must have pubid, hash and roles`,
      );
    }
    // The SHAPE of the id, checked rather than trusted. A record `mintToken`
    // wrote always passes; one written by hand may not, and the id is the field
    // that travels furthest from this file — into an event, onto a console row,
    // back in on a form. A record no token could name is refused rather than
    // filed: `parseToken` cuts the presented token on its first three
    // underscores, so an id containing one is unaddressable by construction.
    if (!PUBID.test(rec.pubid)) {
      throw new UnreadableTokenRecords(
        `${TOKENS_VARIABLE}[${i}] has a pubid that is not 1-64 characters of ` +
          `[A-Za-z0-9-], so no token could name it`,
      );
    }
    return {
      pubid: rec.pubid,
      label: rec.label ?? rec.pubid,
      hash: rec.hash,
      roles: rec.roles,
      revokedAt: rec.revokedAt ?? null,
      createdAt: rec.createdAt,
    };
  });
}

/**
 * Records back to the payload the two stores read.
 *
 * Indented, deliberately: the value is read by humans in `gcloud`, in the
 * secrets console and in a diff, and it holds no secret — only the SHA-256 of
 * one. The cost is a few hundred bytes in a parameter version.
 */
export function serializeTokenRecords(records: TokenRecord[]): string {
  return JSON.stringify(records, null, 2);
}

export type TokenVerdict =
  | { ok: true; record: TokenRecord }
  | {
      ok: false;
      reason:
        | "malformed"
        | "unknown"
        | "revoked"
        | "mismatch"
        | "wrong_env"
        | "unavailable";
      /**
       * Present on `unavailable` alone: a short, strad-authored summary of WHY
       * the store could not be read, for the caller's log line.
       *
       * Never the store client's own exception text and never a payload — it is
       * either one of `parseTokenRecords`'s own sentences or `errorSummary`,
       * which reduces anything else to a class name plus, for a store error, the
       * method and resource it failed on.
       */
      detail?: string;
    };

/**
 * Verify a presented token against the store.
 *
 * Every failure mode returns the same 401 to the caller — the `reason` is for
 * server-side logs only. Telling a caller *why* their token failed tells an
 * attacker which half of it they got right.
 *
 * `unavailable` is the one reason that is not about the token at all: the store
 * could not be read, so nothing was decided. It is NOT an empty store and is
 * certainly not an open one, and nothing is admitted either way — but it is also
 * not a 401, because a 401 tells a caller holding a perfectly good token to
 * discard it and re-authenticate. `authenticateMcp` (src/auth/index.ts) raises
 * `TokenStoreUnavailable` for it, which the route guard answers as a 500; that
 * class carries the reasoning.
 *
 * What this function guarantees is that the store's own exception never escapes
 * it: the error is caught here, reduced to `detail`, and dropped.
 */
export async function verifyToken(
  raw: string,
  store: TokenStore,
  expectedEnv?: string,
): Promise<TokenVerdict> {
  const parsed = parseToken(raw);
  if (!parsed) return { ok: false, reason: "malformed" };

  if (expectedEnv && parsed.env !== expectedEnv) {
    return { ok: false, reason: "wrong_env" };
  }

  let record: TokenRecord | undefined;
  try {
    record = await store.get(parsed.pubid);
  } catch (err) {
    // The error itself is DROPPED here rather than chained. A store client's
    // message can quote a resource and a payload, and this function's every
    // return value is written to a log line — so what survives is a summary:
    // one of this file's own sentences for a payload that would not parse, and
    // `errorSummary` (a class name, plus method and resource for a store error)
    // for anything else. The caller emits it; `src/auth/index.ts` is where it
    // becomes an event and a line on stderr.
    return {
      ok: false,
      reason: "unavailable",
      detail:
        err instanceof UnreadableTokenRecords ? err.message : errorSummary(err),
    };
  }

  // Always hash and compare, even for an unknown pubid. Returning early on
  // "not found" — before doing the sha256 + constant-time compare that a *known*
  // pubid triggers — is a remotely measurable timing difference that reveals
  // which token IDs exist. So we compare the presented secret against the real
  // hash when we have one, and against a fixed dummy when we don't, then decide.
  const digest = sha256(parsed.secret);
  // `secretEquals` is length-guarded, so a record whose `hash` is not a
  // SHA-256 hex digest is a mismatch rather than a throw, which would itself be
  // a timing signal.
  const matches = secretEquals(digest, record?.hash ?? DUMMY_HASH);

  if (!record) return { ok: false, reason: "unknown" };
  if (record.revokedAt) return { ok: false, reason: "revoked" };
  if (!matches) return { ok: false, reason: "mismatch" };
  return { ok: true, record };
}

// A well-formed SHA-256 hex digest that no real secret hashes to (all zeroes).
// Used so the unknown-pubid path performs the same work as the known path.
const DUMMY_HASH = "0".repeat(64);
