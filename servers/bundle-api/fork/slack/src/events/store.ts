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
 *     nothing to write still learns it has been replaced and closes its socket.
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

  async claimLease(): Promise<void> {
    await this.blobs.write(
      this.name('lease.json'),
      Buffer.from(JSON.stringify({ owner: this.instanceId, claimed_at: this.clock() }))
    );
    this.leaseOwner = this.instanceId;
    this.lastLeaseCheck = this.clock();
  }

  /** True while this process still owns the socket. Sets `superseded` if not. */
  async checkLease(force = false): Promise<boolean> {
    if (this.superseded) return false;
    if (!force && this.clock() - this.lastLeaseCheck < LEASE_CHECK_MS) return true;
    this.lastLeaseCheck = this.clock();
    const lease = await this.blobs.read(this.name('lease.json'));
    let owner: string | undefined;
    try {
      owner = lease ? (JSON.parse(lease.data.toString('utf8')).owner as string) : undefined;
    } catch {
      owner = undefined;
    }
    // A missing or unreadable lease is nobody else's: take it back.
    if (owner === undefined) {
      await this.claimLease();
      return true;
    }
    this.leaseOwner = owner;
    if (owner !== this.instanceId) this.superseded = true;
    return !this.superseded;
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
