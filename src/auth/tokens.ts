import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

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

/**
 * Constant-time compare of two hex digests.
 *
 * Both sides are SHA-256 hex, so they are always the same length — but compare
 * lengths first anyway, because timingSafeEqual throws on a length mismatch and
 * a thrown exception is itself a timing signal.
 */
function hashesEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
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

export interface TokenStore {
  get(pubid: string): Promise<TokenRecord | undefined>;
  list(): Promise<TokenRecord[]>;
}

/**
 * Token records from the STRAD_TOKENS env var (a JSON array of TokenRecord).
 *
 * This is the "database" for now. It is deliberately the same shape a real
 * table would be, so moving to Postgres is a new TokenStore and nothing else.
 * See HACKS.md.
 */
export class EnvTokenStore implements TokenStore {
  private readonly byPubid: Map<string, TokenRecord>;

  constructor(json: string | undefined) {
    const records = parseRecords(json);
    this.byPubid = new Map(records.map((r) => [r.pubid, r]));
  }

  async get(pubid: string): Promise<TokenRecord | undefined> {
    return this.byPubid.get(pubid);
  }

  async list(): Promise<TokenRecord[]> {
    return [...this.byPubid.values()];
  }
}

function parseRecords(json: string | undefined): TokenRecord[] {
  if (!json || json.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("STRAD_TOKENS is not valid JSON");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("STRAD_TOKENS must be a JSON array of token records");
  }
  return parsed.map((r, i) => {
    const rec = r as Partial<TokenRecord>;
    if (!rec.pubid || !rec.hash || !Array.isArray(rec.roles)) {
      throw new Error(`STRAD_TOKENS[${i}] must have pubid, hash and roles`);
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

export type TokenVerdict =
  | { ok: true; record: TokenRecord }
  | {
      ok: false;
      reason: "malformed" | "unknown" | "revoked" | "mismatch" | "wrong_env";
    };

/**
 * Verify a presented token against the store.
 *
 * Every failure mode returns the same 401 to the caller — the `reason` is for
 * server-side logs only. Telling a caller *why* their token failed tells an
 * attacker which half of it they got right.
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

  const record = await store.get(parsed.pubid);

  // Always hash and compare, even for an unknown pubid. Returning early on
  // "not found" — before doing the sha256 + timingSafeEqual that a *known*
  // pubid triggers — is a remotely measurable timing difference that reveals
  // which token IDs exist. So we compare the presented secret against the real
  // hash when we have one, and against a fixed dummy when we don't, then decide.
  const digest = sha256(parsed.secret);
  const matches = hashesEqual(digest, record?.hash ?? DUMMY_HASH);

  if (!record) return { ok: false, reason: "unknown" };
  if (record.revokedAt) return { ok: false, reason: "revoked" };
  if (!matches) return { ok: false, reason: "mismatch" };
  return { ok: true, record };
}

// A well-formed SHA-256 hex digest that no real secret hashes to (all zeroes).
// Used so the unknown-pubid path performs the same work as the known path.
const DUMMY_HASH = "0".repeat(64);
