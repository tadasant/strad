/**
 * What the events ingest persists, and who is allowed to write it.
 *
 *   {prefix}/buffer.bin   the ring buffer (buffer.ts's BufferDoc). Sealed.
 *   {prefix}/lease.json   which process owns the socket. Plain.
 *
 * `{prefix}` is this ingest's folder in strad's shared state bucket
 * (`state-store.ts`), always `slack-events` or a folder under it, and the
 * buffer is sealed under SLACK_EVENTS_STATE_ENCRYPTION_KEY — this ingest's own
 * key — with magic `SLE1`, so no other consumer's object opens as this one's.
 *
 * ONE WRITER, by the shared `Lease`, WITH a heartbeat: an App Platform deploy
 * starts the new container before it stops the old one, and Slack Socket Mode
 * spreads events ACROSS up to ten connections per app, so two live sockets are
 * not a duplicate — they are two halves of the event stream, each buffered by
 * a different process.
 *
 *   - a process CLAIMS the lease when it starts, so the newest one owns it;
 *   - the buffer is written conditionally on the generation this process last
 *     saw; a conflict means another process wrote it, and the lease decides
 *     whether to merge and retry (ours) or stop (theirs);
 *   - a superseded process takes the lease back once the owner's heartbeat is
 *     stale, so a newer container that dies does not leave the feed down
 *     until a restart.
 */
import {
  Lease,
  open,
  PreconditionFailed,
  seal,
  type BlobStore,
  type LeaseView,
  type SealFormat,
} from './state-store.js';
import type { BufferDoc } from './buffer.js';

export { LEASE_CHECK_MS, type LeaseView } from './state-store.js';

const FORMAT: SealFormat = {
  magic: 'SLE1',
  what: 'a sealed Slack events object',
  keyVariable: 'SLACK_EVENTS_STATE_ENCRYPTION_KEY',
  recovery:
    'Restore the previous key, or delete the object: the next boot starts an empty buffer ' +
    'and backfills nothing older than its first connection.',
};

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

export class EventsStore {
  private bufferGeneration: string | null | undefined;
  private readonly leaseHolder: Lease;

  constructor(
    private readonly blobs: BlobStore,
    private readonly key: Buffer,
    private readonly prefix: string,
    clock: () => number = Date.now
  ) {
    this.leaseHolder = new Lease(blobs, this.name('lease.json'), { clock });
  }

  private name(suffix: string): string {
    return `${this.prefix}/${suffix}`;
  }

  get instanceId(): string {
    return this.leaseHolder.instanceId;
  }

  get superseded(): boolean {
    return this.leaseHolder.superseded;
  }

  get lease(): LeaseView {
    return this.leaseHolder.view;
  }

  /** Unconditional: the newest process takes the socket, whoever held it. */
  async claimLease(): Promise<void> {
    await this.leaseHolder.claim();
  }

  /** True while this process still owns the socket. Sets `superseded` if not. */
  async checkLease(force = false): Promise<boolean> {
    return this.leaseHolder.check(force);
  }

  /**
   * A superseded process takes the lease back when its owner has stopped
   * heartbeating — the newer container that claimed it crashed, or its deploy
   * was rolled back — so the survivor recovers with no restart by hand.
   */
  async reclaimIfStale(staleAfterMs: number): Promise<boolean> {
    return this.leaseHolder.reclaimIfStale(staleAfterMs);
  }

  async readBuffer(): Promise<BufferDoc | null> {
    const name = this.name('buffer.bin');
    const blob = await this.blobs.read(name);
    this.bufferGeneration = blob ? blob.generation : null;
    if (!blob) return null;
    return JSON.parse(open(this.key, name, blob.data, FORMAT).toString('utf8')) as BufferDoc;
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
    const sealed = (d: BufferDoc) => seal(this.key, name, Buffer.from(JSON.stringify(d)), FORMAT);
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
