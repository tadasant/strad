import { createHash, randomBytes } from "node:crypto";
import {
  GcsBlobStore,
  MemoryBlobStore,
  open,
  PreconditionFailed,
  seal,
  STATE_STORE_ENV,
  StateStoreConfigError,
  type BlobStore,
  type SealFormat,
} from "../../state/store.ts";
import type { GrantIdentity } from "./grants.ts";

/**
 * Server-side GRANT RECORDS for strad's authorization server.
 *
 * Without them every value the server hands out is a sealed, self-contained
 * blob (`grants.ts`), which has three consequences the MCP authorization spec
 * and the operator both object to: a refresh token cannot be rotated (nothing
 * remembers the spent one), an access token cannot be revoked (nothing is
 * consulted when it is presented), and the only revocation there is happens at
 * Google, where it kills every connector the account holds at once. A record
 * per grant answers all three.
 *
 * ## What a record is
 *
 * One grant: one human's consent to one client, for one resource and one slug
 * set. It holds what the sealed tokens used to carry — the identity, the slugs,
 * and the GOOGLE refresh token the Workspace re-check refreshes against — so a
 * record-backed token carries only a grant id. The Google credential stays in
 * strad's own state, sealed under a key only core holds, and never travels to
 * the client.
 *
 * Plus what only a record can hold: the refresh GENERATION (rotation and replay
 * detection), the deadline, the revocation, the access tokens revoked one by
 * one, and `parentGid` — the seam for a child grant minted under another one
 * (RFC 8693 token exchange), which is dead whenever any ancestor is.
 *
 * ## Where it lives
 *
 * Two layers. The HOT path is an in-memory cache in this process — core runs as
 * one instance, so a revocation here is in force on the very next request. The
 * DURABLE copy is one sealed object per grant in strad's shared GCS state store
 * (`src/state/store.ts`), under `mcp-oauth/<gateway.env>/`, written with
 * generation preconditions so two processes (a deploy overlaps the old
 * container and the new one for a minute or two) cannot silently overwrite each
 * other. Parameter Manager was the other candidate and is the wrong one: it is
 * versioned, cached for a day on this deployment, read-only for core's resolver
 * credential, and every rotation would be a new secret version.
 *
 * ## Failing closed
 *
 * A record that cannot be found is a grant that does not exist: its tokens are
 * refused. That is the rule that keeps lost state from un-revoking anything —
 * a revoked grant whose record vanished is refused for the same reason a grant
 * that never existed is. The costs fall the other way:
 *
 *   - `store: memory` forgets every grant on restart, so every record-backed
 *     client signs in again after a deploy. It never resurrects one.
 *   - A GCS outage with a grant already cached here keeps serving that grant
 *     from the cache (revocations made in THIS process still apply). With no
 *     cached copy the request is answered as unavailable, never as allowed and
 *     never as a 401 that would send a client back through sign-in.
 *   - A refresh always reads the durable copy and writes the next generation
 *     BEFORE it answers. If the write does not land, the client keeps the token
 *     it has, which is still current.
 *
 * A COLD START needs nothing: records are read lazily, on first sight of a
 * grant id, so a restart costs one GCS read per active grant.
 */

/** Why a grant stopped working. A closed set: it reaches the console and the logs. */
export type RevokedReason =
  /** `POST /oauth/revoke` with a refresh token. */
  | "revoked"
  /** A spent refresh token was presented again outside the grace window. */
  | "refresh_replay"
  /** An authorization code was redeemed a second time. */
  | "code_replay"
  /** A human, from the console's grants view. */
  | "console";

export interface GrantRecord {
  v: 1;
  gid: string;
  /** `clientFingerprint(client_id)`. */
  cid: string;
  /** Display only: the client's registered or published name. */
  clientName?: string;
  identity: GrantIdentity;
  resource: string;
  /** The granted slug narrowing. Absent = the client's whole ceiling. */
  slugs?: string[];
  /**
   * Google's refresh token. Absent on a CHILD grant (it refreshes against its
   * root's) and dropped the moment a grant is revoked.
   */
  googleRefreshToken?: string;
  /** The grant this one was minted under. Revoking it revokes this. */
  parentGid?: string;
  /**
   * `private_key_jwt` when the grant was sealed to a confidential client
   * (#532): every refresh and revocation of it then demands the client's
   * assertion, whatever token is presented.
   */
  auth?: "private_key_jwt";
  /** `pending` from consent until the code is redeemed. */
  state: "pending" | "active" | "revoked";
  /** The current refresh generation. `0` while pending. */
  generation: number;
  /** When `generation` last advanced: the start of the reuse grace window. */
  rotatedAt?: number;
  createdAt: number;
  /** The last refresh, or the code exchange. */
  lastRefreshedAt?: number;
  /** The absolute refresh deadline set at creation, or null for none. */
  expiresAt: number | null;
  revokedAt?: number;
  revokedReason?: RevokedReason;
  /** Access tokens revoked one at a time: jti → its own expiry. */
  revokedAccess?: Record<string, number>;
  /** Set when this grant was upgraded from a stateless legacy refresh token. */
  fromLegacy?: boolean;
  /**
   * Present on a CHILD minted by RFC 8693 token exchange (`exchangeGrant` in
   * `src/http/oauth.ts`): one access token, no refresh token, `parentGid` set,
   * `expiresAt` its own expiry. Such a record is never a subject token itself.
   *
   * `label` is the client's opaque tag for it — Zimmer sends its session id —
   * shown on the console and exported with `mcp_oauth.exchange`. Validated to
   * `EXCHANGE_LABEL` before it is stored, so it is never a credential.
   */
  exchange?: { label?: string };
  /**
   * On a PARENT: its live token-exchange children, child gid → expiry. This
   * is the count `maxLiveChildren` caps. An entry leaves when the child
   * expires (dropped on the parent's next write) or is revoked.
   */
  children?: Record<string, number>;
  /**
   * A random id the last activating or rotating write stamped. A re-run of
   * that same decision (the transport replayed a write that had in fact
   * landed, and got a 412) recognises its own write by it, instead of reading
   * it as somebody else's and calling a replay.
   */
  writeId?: string;
}

/**
 * What `legacyGrant` answers for a link object that exists and does not open.
 * Not a grant id (ids are base64url), so no record answers to it, and every
 * caller that follows it is refused — the fail-closed reading.
 */
export const UNREADABLE_LINK = "!unreadable";

export class GrantStoreUnavailable extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "GrantStoreUnavailable";
  }
}

export interface GrantStoreOptions {
  /** The durable layer, or a promise of one (credentials are read lazily). */
  blobs: () => Promise<BlobStore>;
  /** The 32-byte record key (`McpOAuthKeys.grantState`). */
  key: Buffer;
  /** The folder in the bucket: `mcp-oauth/<env>`. */
  prefix: string;
  /**
   * How long a cached record is trusted on the access-token path before it is
   * re-read. Bounds how long a revocation made by ANOTHER process (the other
   * container during a deploy overlap) takes to land here. A revocation made
   * by this process lands at once.
   */
  staleAfterMs?: number;
  /**
   * How long a revoked, expired or never-redeemed record is kept before the
   * sweep deletes it. Deleting is safe — a missing record is refused — so this
   * only decides how long the console shows it.
   */
  retainMs?: number;
  /** "memory" or "gcs", for the console. */
  kind: "memory" | "gcs";
  now?: () => number;
  warn?: (message: string) => void;
}

const SEAL: SealFormat = {
  magic: "SOG1",
  what: "a sealed strad OAuth grant record",
  keyVariable: "STRAD_OAUTH_KEY (or the key it falls back to)",
  recovery:
    "Its grant cannot be honoured; the client will be asked to sign in again.",
};

/** How long a pending record outlives its code: generous, it costs nothing. */
const PENDING_TTL_MS = 15 * 60 * 1000;
/** The default retention for a dead record. */
const DEFAULT_RETAIN_MS = 7 * 24 * 60 * 60 * 1000;
/** The default staleness bound on the access-token path. */
export const DEFAULT_STALE_AFTER_MS = 15_000;
/**
 * How long a dead token-exchange child is kept before the sweep deletes it.
 * Shorter than a grant's: a client mints one per agent turn, and a week of
 * those is thousands of rows nobody needs once the day is over.
 */
const CHILD_RETAIN_MS = 24 * 60 * 60 * 1000;
/** How deep a parent chain may go. A token-exchange chain is one or two hops. */
const MAX_DEPTH = 8;
/** Conditional-write retries before a contended update gives up. */
const UPDATE_TRIES = 4;

interface Cached {
  record: GrantRecord | null;
  generation: string | null;
  fetchedAt: number;
}

/**
 * The grant table: an in-memory cache in front of sealed objects in a bucket.
 */
export class GrantStore {
  readonly kind: "memory" | "gcs";
  private readonly cache = new Map<string, Cached>();
  /** Last seen at `/mcp`, in memory only — see `lastUsed`. */
  private readonly seen = new Map<string, number>();
  private readonly opts: GrantStoreOptions;
  private readonly now: () => number;
  private readonly staleAfterMs: number;
  private readonly retainMs: number;
  private blobsPromise: Promise<BlobStore> | undefined;
  private lastSweep = 0;
  private lastStaleWarn = 0;
  /** Per-grant serialisation of child reservations in this process. */
  private readonly reserving = new Map<string, Promise<unknown>>();

  constructor(opts: GrantStoreOptions) {
    this.opts = opts;
    this.kind = opts.kind;
    this.now = opts.now ?? (() => Date.now());
    this.staleAfterMs = opts.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    this.retainMs = opts.retainMs ?? DEFAULT_RETAIN_MS;
  }

  /** A fresh, URL-safe grant id. */
  static newGid(): string {
    return randomBytes(16).toString("base64url");
  }

  private async blobs(): Promise<BlobStore> {
    this.blobsPromise ??= this.opts.blobs().catch((err: unknown) => {
      // Not cached: a credential seeded after boot should start working on
      // the next request rather than at the next deploy.
      this.blobsPromise = undefined;
      throw new GrantStoreUnavailable(
        err instanceof Error ? err.message : String(err),
        { cause: err },
      );
    });
    return this.blobsPromise;
  }

  private name(gid: string): string {
    return `${this.opts.prefix}/grants/${gid}`;
  }

  private legacyName(jti: string): string {
    // Hashed: the legacy jti is a value inside a credential, and an object
    // name is visible to anything that can list the bucket.
    const h = createHash("sha256").update(jti, "utf8").digest("base64url");
    return `${this.opts.prefix}/legacy/${h}`;
  }

  /** Is the durable layer reachable? For the boot log and the console. */
  async probe(): Promise<string | null> {
    try {
      const blobs = await this.blobs();
      await blobs.list(`${this.opts.prefix}/grants/`);
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /**
   * The record for a grant id, or null when there is none.
   *
   * `fresh` reads the durable copy whatever the cache says — the refresh path
   * always does, because it is about to write. Otherwise a cached copy younger
   * than `staleAfterMs` is the answer; an older one is re-read, and kept as the
   * answer only if the re-read FAILS (and it is not revoked, which it then
   * stays). No cached copy and no durable answer throws
   * {@link GrantStoreUnavailable}: unknown, never allowed.
   */
  async get(
    gid: string,
    opts: { fresh?: boolean } = {},
  ): Promise<GrantRecord | null> {
    const cached = this.cache.get(gid);
    const now = this.now();
    if (
      !opts.fresh &&
      cached &&
      (now - cached.fetchedAt < this.staleAfterMs ||
        cached.record?.state === "revoked")
    ) {
      // A revoked record never needs re-reading: nothing un-revokes.
      return cached.record;
    }
    try {
      await this.load(gid);
      return this.cache.get(gid)?.record ?? null;
    } catch (err) {
      if (!opts.fresh && cached) {
        if (this.now() - this.lastStaleWarn > 60_000) {
          this.lastStaleWarn = this.now();
          this.opts.warn?.(
            `[strad] grant store unreadable; serving a cached grant record: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
        return cached.record;
      }
      throw err instanceof GrantStoreUnavailable
        ? err
        : new GrantStoreUnavailable(
            err instanceof Error ? err.message : String(err),
            { cause: err },
          );
    }
  }

  private async load(gid: string): Promise<Cached> {
    const blobs = await this.blobs();
    const name = this.name(gid);
    const read = await blobs.read(name);
    let record: GrantRecord | null = null;
    if (read) {
      try {
        record = JSON.parse(
          open(this.opts.key, name, read.data, SEAL).toString("utf8"),
        ) as GrantRecord;
      } catch (err) {
        // A record we cannot open is a grant we cannot honour — the key
        // changed, or the object was altered. Refused, like a missing one.
        this.opts.warn?.(
          `[strad] grant record ${gid} does not open: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        record = null;
      }
      if (record && (record.v !== 1 || record.gid !== gid)) record = null;
    }
    const durable: Cached = {
      record,
      generation: read?.generation ?? null,
      fetchedAt: this.now(),
    };
    // What this process CACHES is the durable copy plus any revocation this
    // process already holds and has not seen land — a write that failed, or
    // one the other container has not made yet. Nothing a durable read says
    // un-revokes a grant or an access token here. What this returns is the
    // durable copy alone, because `update` decides its write against that.
    const merged = keepRevocations(this.cache.get(gid)?.record, record);
    this.cache.set(gid, { ...durable, record: merged });
    return durable;
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  /** Write a new record. Its id must be new. */
  async create(record: GrantRecord): Promise<GrantRecord> {
    const blobs = await this.blobs();
    const name = this.name(record.gid);
    let generation: string;
    try {
      generation = await blobs.write(name, this.sealRecord(record), null);
    } catch (err) {
      // A 412 on a create-only write of a fresh 128-bit id is OUR write,
      // landed and then replayed by the transport: nobody else can hold the
      // name. Read back what landed.
      if (!(err instanceof PreconditionFailed)) throw asUnavailable(err);
      let landed: Cached;
      try {
        landed = await this.load(record.gid);
      } catch (again) {
        throw asUnavailable(again);
      }
      if (!landed.record) throw asUnavailable(err);
      return landed.record;
    }
    this.cache.set(record.gid, {
      record,
      generation,
      fetchedAt: this.now(),
    });
    void this.maybeSweep();
    return record;
  }

  /**
   * Read-modify-write, against the durable copy, under a generation
   * precondition. `mutate` sees the CURRENT record (or null) and returns the
   * record to write, or null to write nothing. Re-read and re-run on a lost
   * race, so `mutate` must be a pure decision on what it is given.
   *
   * Returns what was decided: the record written (or the record as read, when
   * `mutate` wrote nothing) and the value `mutate` returned alongside it.
   */
  async update<T>(
    gid: string,
    mutate: (
      current: GrantRecord | null,
      durable: GrantRecord | null,
    ) => {
      write: GrantRecord | null;
      result: T;
    },
  ): Promise<{ record: GrantRecord | null; result: T }> {
    const blobs = await this.blobs();
    for (let attempt = 1; ; attempt++) {
      let durable: Cached;
      try {
        durable = await this.load(gid);
      } catch (err) {
        throw asUnavailable(err);
      }
      // `current` is what this process believes: the durable copy with any
      // revocation it holds laid over it. Decisions are made on that, so a
      // grant revoked here — even by a write that failed — is never rotated
      // or activated. `durable` is offered for the one decision that is
      // about the durable copy itself: whether a revocation still needs
      // writing.
      const current = this.cache.get(gid)?.record ?? null;
      const decided = mutate(current, durable.record);
      if (!decided.write) {
        return { record: current, result: decided.result };
      }
      // Whatever is written carries this process's revocations with it, so
      // one that failed to land earlier lands now.
      const next = keepRevocations(
        current,
        prune(decided.write, this.now()),
      ) as GrantRecord;
      try {
        const generation = await blobs.write(
          this.name(gid),
          this.sealRecord(next),
          durable.generation,
        );
        this.cache.set(gid, {
          record: next,
          generation,
          fetchedAt: this.now(),
        });
        return { record: next, result: decided.result };
      } catch (err) {
        // A lost race — or OUR OWN write, landed and then retried by the
        // transport, which answers 412 the second time. Re-reading and
        // re-deciding covers both: callers stamp `writeId` so a re-run can
        // recognise its own landed write (see `GrantRecord.writeId`).
        if (err instanceof PreconditionFailed && attempt < UPDATE_TRIES) {
          continue;
        }
        throw asUnavailable(err);
      }
    }
  }

  /**
   * Revoke a grant. In force in this process at once — the cache is updated
   * BEFORE the durable write, so even a write that fails leaves this process
   * refusing the grant (and the caller is told the write failed).
   *
   * The Google refresh token is dropped from the record. It is NOT revoked at
   * Google: Google revokes per account and OAuth client, so doing that would
   * sign the account out of every other strad grant as well — which is the
   * behaviour records exist to end.
   */
  async revoke(gid: string, reason: RevokedReason): Promise<boolean> {
    const at = this.now();
    const cached = this.cache.get(gid);
    if (cached?.record && cached.record.state !== "revoked") {
      cached.record = revokedCopy(cached.record, reason, at);
    }
    const out = await this.update(gid, (current, durable) => {
      if (!durable) return { write: null, result: current !== null };
      if (durable.state === "revoked") return { write: null, result: true };
      return { write: revokedCopy(durable, reason, at), result: true };
    });
    // A token-exchange child gives its slot under the parent back, so a
    // client that revokes as it goes never meets `maxLiveChildren`.
    const child = out.record;
    if (child?.exchange && child.parentGid) {
      await this.releaseChild(child.parentGid, gid).catch(() => undefined);
    }
    return out.result;
  }

  /** Revoke one access token of a grant, until it would have expired anyway. */
  async revokeAccess(gid: string, jti: string, exp: number): Promise<boolean> {
    const cached = this.cache.get(gid);
    if (cached?.record) {
      cached.record = {
        ...cached.record,
        revokedAccess: { ...(cached.record.revokedAccess ?? {}), [jti]: exp },
      };
    }
    const out = await this.update(gid, (_current, durable) => {
      if (!durable) return { write: null, result: false };
      if (durable.revokedAccess?.[jti]) return { write: null, result: true };
      return {
        write: {
          ...durable,
          revokedAccess: { ...(durable.revokedAccess ?? {}), [jti]: exp },
        },
        result: true,
      };
    });
    return out.result;
  }

  // -------------------------------------------------------------------------
  // Legacy upgrade index
  // -------------------------------------------------------------------------

  /**
   * The grant a stateless legacy refresh token was upgraded into (or revoked
   * as), by the legacy token's jti. Null when it never was.
   */
  async legacyGrant(jti: string): Promise<string | null> {
    const blobs = await this.blobs();
    const name = this.legacyName(jti);
    let read;
    try {
      read = await blobs.read(name);
    } catch (err) {
      throw asUnavailable(err);
    }
    if (!read) return null;
    try {
      const gid = open(this.opts.key, name, read.data, SEAL).toString("utf8");
      return gid === "" ? UNREADABLE_LINK : gid;
    } catch {
      // A link that exists but does not open was written by somebody — most
      // likely as a revocation. Read as "revoked", never as "never linked".
      return UNREADABLE_LINK;
    }
  }

  /**
   * Point a legacy jti at a grant, once. Returns the gid that won: ours, or the
   * one another request wrote first (the caller then follows that one).
   */
  async linkLegacy(jti: string, gid: string): Promise<string> {
    const blobs = await this.blobs();
    const name = this.legacyName(jti);
    try {
      await blobs.write(
        name,
        seal(this.opts.key, name, Buffer.from(gid, "utf8"), SEAL),
        null,
      );
      return gid;
    } catch (err) {
      if (err instanceof PreconditionFailed) {
        const winner = await this.legacyGrant(jti);
        if (winner) return winner;
      }
      throw asUnavailable(err);
    }
  }

  /** Remove a record outright (a lost upgrade race). */
  async remove(gid: string): Promise<void> {
    const blobs = await this.blobs();
    try {
      await blobs.delete(this.name(gid));
    } catch (err) {
      throw asUnavailable(err);
    }
    this.cache.delete(gid);
  }

  // -------------------------------------------------------------------------
  // The access-token path
  // -------------------------------------------------------------------------

  /** Note a use at `/mcp`. Memory only: a write per request is not worth it. */
  touch(gid: string): void {
    this.seen.set(gid, this.now());
  }

  /** The latest of the last refresh (durable) and the last `/mcp` use (here). */
  lastUsed(record: GrantRecord): number | undefined {
    const seen = this.seen.get(record.gid);
    const refreshed = record.lastRefreshedAt;
    if (seen === undefined) return refreshed;
    if (refreshed === undefined) return seen;
    return Math.max(seen, refreshed);
  }

  /**
   * Walk a grant and its ancestors. The first that is missing or not active
   * decides; `null` means every one of them is live.
   */
  async chain(
    record: GrantRecord,
    opts: { fresh?: boolean } = {},
  ): Promise<{ root: GrantRecord; dead: string | null; path: GrantRecord[] }> {
    let current = record;
    // Every record walked, the grant itself first: a caller that judges
    // deadlines (an expired PARENT ends its children) needs all of them.
    const path: GrantRecord[] = [];
    for (let depth = 0; depth < MAX_DEPTH; depth++) {
      path.push(current);
      if (current.state !== "active") {
        return { root: current, dead: current.state, path };
      }
      if (!current.parentGid) return { root: current, dead: null, path };
      const parent = await this.get(current.parentGid, opts);
      if (!parent) return { root: current, dead: "parent_missing", path };
      current = parent;
    }
    return { root: current, dead: "chain_too_deep", path };
  }

  // -------------------------------------------------------------------------
  // Token-exchange children
  // -------------------------------------------------------------------------

  /**
   * Reserve a slot for a new child under `parentGid`, against the durable
   * parent record and under its generation precondition — so the count holds
   * across the two processes of a deploy overlap as well as within this one.
   * Expired entries are dropped by the same write (`prune`). Reservations in
   * this process are serialised per parent, so a burst of exchanges does not
   * spend its conditional-write retries racing itself.
   *
   * `dead`: the parent is gone or not active. `full`: it already holds `cap`
   * live children; nothing is evicted — a live child is somebody's running
   * session.
   */
  async reserveChild(
    parentGid: string,
    childGid: string,
    expiresAt: number,
    cap: number,
  ): Promise<"ok" | "dead" | "full"> {
    return this.queued(parentGid, async () => {
      const at = this.now();
      const out = await this.update(parentGid, (current) => {
        if (!current || current.state !== "active") {
          return { write: null, result: "dead" as const };
        }
        const live = liveChildren(current.children, at);
        if (live[childGid] !== undefined) {
          // Our own reservation, landed and then replayed by the transport.
          return { write: null, result: "ok" as const };
        }
        if (Object.keys(live).length >= cap) {
          return { write: null, result: "full" as const };
        }
        return {
          write: {
            ...current,
            children: { ...live, [childGid]: expiresAt },
          },
          result: "ok" as const,
        };
      });
      return out.result;
    });
  }

  /**
   * Run `work` after every earlier child write on this parent in this
   * process. Bounded by the blob client's own per-request timeout and retry
   * deadline (`GcsBlobStore`), so a hung write cannot hold the queue forever.
   */
  private async queued<T>(
    parentGid: string,
    work: () => Promise<T>,
  ): Promise<T> {
    const prior = this.reserving.get(parentGid) ?? Promise.resolve();
    const run = prior.catch(() => undefined).then(work);
    this.reserving.set(parentGid, run);
    try {
      return await run;
    } finally {
      if (this.reserving.get(parentGid) === run) {
        this.reserving.delete(parentGid);
      }
    }
  }

  /**
   * Give a child's slot back: it was revoked, or never got its record. Best
   * effort by design — a slot that is not released is freed when the child
   * would have expired, and the child itself is refused either way.
   */
  async releaseChild(parentGid: string, childGid: string): Promise<void> {
    await this.queued(parentGid, async () => {
      await this.update(parentGid, (current) => {
        if (!current?.children || current.children[childGid] === undefined) {
          return { write: null, result: undefined };
        }
        const { [childGid]: _gone, ...rest } = current.children;
        return { write: { ...current, children: rest }, result: undefined };
      });
    });
  }

  // -------------------------------------------------------------------------
  // The console
  // -------------------------------------------------------------------------

  /** Every record, newest first, sweeping what is past retention. */
  async list(): Promise<GrantRecord[]> {
    const blobs = await this.blobs();
    let names: string[];
    try {
      names = await blobs.list(`${this.opts.prefix}/grants/`);
    } catch (err) {
      throw asUnavailable(err);
    }
    const prefix = `${this.opts.prefix}/grants/`;
    const out: GrantRecord[] = [];
    const queue = names
      .filter((n) => n.startsWith(prefix))
      .map((n) => n.slice(prefix.length));
    const worker = async () => {
      for (let gid = queue.shift(); gid !== undefined; gid = queue.shift()) {
        await this.load(gid);
        const record = this.cache.get(gid)?.record;
        if (!record) continue;
        if (this.sweepable(record)) {
          await blobs.delete(this.name(gid)).catch(() => undefined);
          this.cache.delete(gid);
          continue;
        }
        out.push(record);
      }
    };
    try {
      await Promise.all(Array.from({ length: 8 }, worker));
    } catch (err) {
      throw asUnavailable(err);
    }
    this.lastSweep = this.now();
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }

  private sweepable(record: GrantRecord): boolean {
    const now = this.now();
    if (record.exchange) {
      const ended =
        record.state === "revoked"
          ? (record.revokedAt ?? record.createdAt)
          : (record.expiresAt ?? Number.POSITIVE_INFINITY);
      return ended + CHILD_RETAIN_MS < now;
    }
    if (record.state === "pending") {
      return record.createdAt + PENDING_TTL_MS < now;
    }
    if (record.state === "revoked") {
      return (record.revokedAt ?? record.createdAt) + this.retainMs < now;
    }
    return record.expiresAt !== null && record.expiresAt + this.retainMs < now;
  }

  /** At most hourly, off the request path: list (which sweeps). */
  private async maybeSweep(): Promise<void> {
    if (this.now() - this.lastSweep < 60 * 60 * 1000) return;
    this.lastSweep = this.now();
    await this.list().catch(() => undefined);
  }

  private sealRecord(record: GrantRecord): Buffer {
    return seal(
      this.opts.key,
      this.name(record.gid),
      Buffer.from(JSON.stringify(record), "utf8"),
      SEAL,
    );
  }
}

/**
 * A durable copy, with any revocation this process holds that it does not
 * show yet laid over it. Never the other way round: nothing durable
 * un-revokes a grant or an access token in this process.
 */
function keepRevocations(
  prior: GrantRecord | null | undefined,
  record: GrantRecord | null,
): GrantRecord | null {
  if (prior?.state === "revoked" && record?.state !== "revoked") return prior;
  if (record && prior?.revokedAccess) {
    return {
      ...record,
      revokedAccess: {
        ...prior.revokedAccess,
        ...(record.revokedAccess ?? {}),
      },
    };
  }
  return record;
}

function revokedCopy(
  record: GrantRecord,
  reason: RevokedReason,
  at: number,
): GrantRecord {
  const { googleRefreshToken: _dropped, ...rest } = record;
  return { ...rest, state: "revoked", revokedAt: at, revokedReason: reason };
}

/**
 * Drop what has expired on its own: individually revoked access tokens, and
 * token-exchange children past their expiry. Every write prunes, so neither
 * map grows past what is live.
 */
function prune(record: GrantRecord, now: number): GrantRecord {
  let out = record;
  if (out.revokedAccess) {
    const kept = Object.fromEntries(
      Object.entries(out.revokedAccess).filter(([, exp]) => exp > now),
    );
    if (Object.keys(kept).length === 0) {
      const { revokedAccess: _gone, ...rest } = out;
      out = rest;
    } else {
      out = { ...out, revokedAccess: kept };
    }
  }
  if (out.children) {
    const kept = liveChildren(out.children, now);
    if (Object.keys(kept).length === 0) {
      const { children: _gone, ...rest } = out;
      out = rest;
    } else {
      out = { ...out, children: kept };
    }
  }
  return out;
}

/** The children whose expiry is still ahead. */
export function liveChildren(
  children: Record<string, number> | undefined,
  now: number,
): Record<string, number> {
  if (!children) return {};
  return Object.fromEntries(
    Object.entries(children).filter(([, exp]) => exp > now),
  );
}

function asUnavailable(err: unknown): Error {
  if (err instanceof GrantStoreUnavailable) return err;
  return new GrantStoreUnavailable(
    err instanceof Error ? err.message : String(err),
    { cause: err },
  );
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

/** Reads one credential by name: the gateway's secret provider, else env. */
export type CredentialReader = (name: string) => Promise<string | undefined>;

/**
 * The durable layer this deployment's config asks for.
 *
 * `gcs` reads the three deployment-wide `STRAD_STATE_GCS_*` names — the same
 * bucket and service account every stateful server already shares — through
 * the gateway's secret provider, LAZILY, on first use. Nothing new is seeded:
 * the record key is derived from the OAuth key core already holds. A missing
 * name is a {@link GrantStoreUnavailable} on every grant operation: it refuses
 * record-backed tokens, and makes a stateless refresh or revocation answer
 * 503, because whether a stateless token was revoked is recorded here too.
 */
export function grantBlobsFor(
  kind: "memory" | "gcs",
  read: CredentialReader,
  warn: (message: string) => void,
): () => Promise<BlobStore> {
  if (kind === "memory") {
    const memory = new MemoryBlobStore();
    return () => Promise.resolve(memory);
  }
  return async () => {
    const [bucket, clientEmail, privateKey] = await Promise.all([
      read(STATE_STORE_ENV.bucket),
      read(STATE_STORE_ENV.clientEmail),
      read(STATE_STORE_ENV.privateKey),
    ]);
    const missing = [
      [STATE_STORE_ENV.bucket, bucket],
      [STATE_STORE_ENV.clientEmail, clientEmail],
      [STATE_STORE_ENV.privateKey, privateKey],
    ]
      .filter(([, v]) => !v)
      .map(([k]) => k);
    if (missing.length > 0 || !bucket || !clientEmail || !privateKey) {
      throw new StateStoreConfigError(
        `auth.mcpOAuth.grants.store is gcs but ${missing.join(", ")} ` +
          `${missing.length === 1 ? "is" : "are"} not set. Record-backed ` +
          `grants cannot be issued or honoured until ${missing.length === 1 ? "it is" : "they are"}.`,
      );
    }
    return new GcsBlobStore({
      bucket: bucket.trim(),
      clientEmail: clientEmail.trim(),
      privateKey: privateKey.replace(/\\n/g, "\n"),
      privateKeyVariable: STATE_STORE_ENV.privateKey,
      who: "the OAuth grant store",
      warn,
    });
  };
}

/** The folder: `mcp-oauth/<env>`, the consumer's own root plus the deployment. */
export function grantPrefix(env: string): string {
  const clean = env.replace(/[^A-Za-z0-9_-]/g, "_") || "default";
  return `mcp-oauth/${clean}`;
}
