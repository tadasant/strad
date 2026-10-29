/**
 * What the events ingest persists, and who is allowed to write it.
 *
 *   {prefix}/buffer.bin   the ring buffer (buffer.ts's BufferDoc). Sealed.
 *   {prefix}/lease.json   which process owns the socket. Plain.
 *
 * The pattern is the WhatsApp bridge's (servers/whatsapp/shared/src/store.ts),
 * for the same reason: an App Platform deploy starts the new container before
 * it stops the old one. Slack Socket Mode allows up to ten connections per app
 * and spreads events ACROSS them, so two live sockets are not a duplicate — they
 * are two halves of the event stream, each buffered by a different process.
 *
 *   - a process CLAIMS the lease when it starts, so the newest one owns it;
 *   - the buffer is written conditionally on the generation this process last
 *     saw; a conflict means another process wrote it, and the lease decides
 *     whether to merge and retry (ours) or stop (theirs);
 *   - the lease is re-read every LEASE_CHECK_MS, so an old process that has
 *     nothing to write still learns it has been replaced and closes its socket;
 *   - the owner refreshes a heartbeat in the lease on each check, and a
 *     superseded process takes the lease back once that heartbeat is stale, so
 *     a newer container that dies does not leave the feed down until a restart.
 */
import { randomUUID } from 'node:crypto';
import { PreconditionFailed, type BlobStore } from './blob-store.js';
import { open, seal } from './crypto.js';
import type { BufferDoc } from './buffer.js';

export const LEASE_CHECK_MS = 30_000;

export class SupersededError extends Error {
  constructor() {
    super(
      'Another process has taken over the Slack events socket (a newer deploy, or a ' +
        'second replica). This one has closed its socket and stopped writing the buffer. ' +
        'The component serving the events slug must run exactly ONE instance.'
    );
    this.name = 'SupersededError';
  }
}

export interface LeaseView {
  instanceId: string;
  owner: string | null;
  superseded: boolean;
}

export class EventsStore {
  readonly instanceId = randomUUID();
  private bufferGeneration: string | null | undefined;
  private lastLeaseCheck = 0;
  private leaseOwner: string | null = null;
  superseded = false;

  constructor(
    private readonly blobs: BlobStore,
    private readonly key: Buffer,
    private readonly prefix: string,
    private readonly clock: () => number = Date.now
  ) {}

  private name(suffix: string): string {
    return `${this.prefix}/${suffix}`;
  }

  get lease(): LeaseView {
    return { instanceId: this.instanceId, owner: this.leaseOwner, superseded: this.superseded };
  }

  private leaseBody(): Buffer {
    return Buffer.from(
      JSON.stringify({ owner: this.instanceId, heartbeat_at: this.clock() })
    );
  }

  /** Unconditional: the newest process takes the socket, whoever held it. */
  async claimLease(): Promise<void> {
    await this.blobs.write(this.name('lease.json'), this.leaseBody());
    this.leaseOwner = this.instanceId;
    this.superseded = false;
    this.lastLeaseCheck = this.clock();
  }

  private async readLease(): Promise<{
    owner?: string;
    heartbeatAt?: number;
    generation: string | null;
  }> {
    const lease = await this.blobs.read(this.name('lease.json'));
    if (!lease) return { generation: null };
    try {
      const body = JSON.parse(lease.data.toString('utf8')) as {
        owner?: unknown;
        heartbeat_at?: unknown;
        claimed_at?: unknown;
      };
      const at = typeof body.heartbeat_at === 'number' ? body.heartbeat_at : body.claimed_at;
      return {
        owner: typeof body.owner === 'string' ? body.owner : undefined,
        heartbeatAt: typeof at === 'number' ? at : undefined,
        generation: lease.generation,
      };
    } catch {
      return { generation: lease.generation };
    }
  }

  /**
   * True while this process still owns the socket. Sets `superseded` if not.
   *
   * The owner refreshes `heartbeat_at` on every check, CONDITIONALLY on the
   * generation it just read: an unconditional refresh racing a newer process's
   * claim would take the lease back from it. A lost race is a lost lease.
   */
  async checkLease(force = false): Promise<boolean> {
    if (this.superseded) return false;
    if (!force && this.clock() - this.lastLeaseCheck < LEASE_CHECK_MS) return true;
    this.lastLeaseCheck = this.clock();
    const lease = await this.readLease();
    // A missing or unreadable lease is nobody else's: take it back.
    if (lease.owner === undefined) {
      await this.claimLease();
      return true;
    }
    this.leaseOwner = lease.owner;
    if (lease.owner !== this.instanceId) {
      this.superseded = true;
      return false;
    }
    try {
      await this.blobs.write(this.name('lease.json'), this.leaseBody(), lease.generation);
    } catch (err) {
      if (!(err instanceof PreconditionFailed)) throw err;
      const now = await this.readLease();
      this.leaseOwner = now.owner ?? null;
      if (now.owner !== this.instanceId) this.superseded = true;
    }
    return !this.superseded;
  }

  /**
   * A superseded process takes the lease back when its owner has stopped
   * heartbeating — the newer container that claimed it crashed, or its deploy
   * was rolled back — so the survivor recovers with no restart by hand. The
   * write is conditional on the stale lease it read, so two survivors cannot
   * both win. True when this process owns the lease again.
   */
  async reclaimIfStale(staleAfterMs: number): Promise<boolean> {
    if (!this.superseded) return true;
    const lease = await this.readLease();
    const stale =
      lease.owner === undefined ||
      lease.heartbeatAt === undefined ||
      this.clock() - lease.heartbeatAt > staleAfterMs;
    if (!stale) return false;
    try {
      await this.blobs.write(this.name('lease.json'), this.leaseBody(), lease.generation);
    } catch (err) {
      if (err instanceof PreconditionFailed) return false;
      throw err;
    }
    this.leaseOwner = this.instanceId;
    this.superseded = false;
    this.lastLeaseCheck = this.clock();
    return true;
  }

  async readBuffer(): Promise<BufferDoc | null> {
    const name = this.name('buffer.bin');
    const blob = await this.blobs.read(name);
    this.bufferGeneration = blob ? blob.generation : null;
    if (!blob) return null;
    return JSON.parse(open(this.key, name, blob.data).toString('utf8')) as BufferDoc;
  }

  /**
   * Writes the buffer conditionally. On a conflict it hands the other writer's
   * document to `merge` — which folds it into memory and returns the merged
   * document — and writes that, once. Throws {@link SupersededError} when the
   * other writer is the lease holder.
   */
  async writeBuffer(doc: BufferDoc, merge: (theirs: BufferDoc) => BufferDoc): Promise<void> {
    if (this.superseded) throw new SupersededError();
    const name = this.name('buffer.bin');
    const sealed = (d: BufferDoc) => seal(this.key, name, Buffer.from(JSON.stringify(d)));
    try {
      this.bufferGeneration = await this.blobs.write(name, sealed(doc), this.bufferGeneration);
    } catch (err) {
      if (!(err instanceof PreconditionFailed)) throw err;
      if (!(await this.checkLease(true))) throw new SupersededError();
      // Ours is the live socket; theirs was a process we replaced, writing on
      // its way out. Keep both sets of events.
      const theirs = await this.readBuffer();
      const merged = theirs ? merge(theirs) : doc;
      this.bufferGeneration = await this.blobs.write(name, sealed(merged), this.bufferGeneration);
    }
  }
}
