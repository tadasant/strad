/**
 * What the Gmail events ingest persists, and who may write it.
 *
 *   {prefix}/buffer.bin     the ring buffer (buffer.ts's BufferDoc), with the
 *                           history id and the watch's expiry. Sealed.
 *   {prefix}/webhooks.bin   webhook subscriptions (webhook/registry.ts). Sealed.
 *   {prefix}/lease.json     which process reads the mailbox. Plain.
 *
 * `{prefix}` is `gmail-events/<slug>` by default, in strad's shared state
 * bucket (`state-store.ts`), and everything is sealed under the mount's own
 * GMAIL_EVENTS_STATE_ENCRYPTION_KEY with magic `GME1`, so no other consumer's
 * object opens as this one's.
 *
 * Slack's `EventsStore` (`servers/bundle-api/fork/slack/src/events/store.ts`)
 * with Gmail's names. ONE WRITER, by the shared `Lease` with a heartbeat: the
 * newest process claims it, a write conflict is settled by the lease (merge
 * when it is ours, stop when it is not), and a superseded process takes it
 * back once the owner's heartbeat is stale. For Gmail the cost of two writers
 * is smaller than for Slack (two processes reading one history see the same
 * messages), but two processes calling `users.watch` and pulling one Pub/Sub
 * subscription would split the notifications between them.
 */
import {
  Lease,
  open,
  PreconditionFailed,
  seal,
  type BlobStore,
  type LeaseView,
  type SealFormat,
} from "./state-store.js";
import type { BufferDoc } from "./buffer.js";

export { LEASE_CHECK_MS, type LeaseView } from "./state-store.js";

const FORMAT: SealFormat = {
  magic: "GME1",
  what: "a sealed Gmail events object",
  keyVariable: "GMAIL_EVENTS_STATE_ENCRYPTION_KEY",
  recovery:
    "Restore the previous key, or delete the object: the next boot starts an empty buffer " +
    "from the mailbox's current history, and recovers nothing older.",
};

export class SupersededError extends Error {
  constructor() {
    super(
      "Another process has taken over this mailbox's events (a newer deploy, or a " +
        "second replica). This one has stopped reading the mailbox and writing the buffer."
    );
    this.name = "SupersededError";
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
    this.leaseHolder = new Lease(blobs, this.name("lease.json"), { clock });
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

  /** Unconditional: the newest process takes the mailbox, whoever held it. */
  async claimLease(): Promise<void> {
    await this.leaseHolder.claim();
  }

  /** True while this process still owns the mailbox. Sets `superseded` if not. */
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

  /**
   * A sealed JSON document beside the buffer, with the generation a
   * conditional write needs. Unlike the buffer, any process may write one: a
   * subscribe can land on a container that is not the lease holder.
   */
  async readDoc<T>(suffix: string): Promise<{ doc: T | null; generation: string | null }> {
    const name = this.name(suffix);
    const blob = await this.blobs.read(name);
    if (!blob) return { doc: null, generation: null };
    return {
      doc: JSON.parse(open(this.key, name, blob.data, FORMAT).toString("utf8")) as T,
      generation: blob.generation,
    };
  }

  /** Conditional on `ifGeneration` (`null`: must not exist). Throws PreconditionFailed on a race. */
  async writeDoc(suffix: string, doc: unknown, ifGeneration: string | null): Promise<string> {
    const name = this.name(suffix);
    return this.blobs.write(name, seal(this.key, name, Buffer.from(JSON.stringify(doc)), FORMAT), ifGeneration);
  }

  async readBuffer(): Promise<BufferDoc | null> {
    const name = this.name("buffer.bin");
    const blob = await this.blobs.read(name);
    this.bufferGeneration = blob ? blob.generation : null;
    if (!blob) return null;
    return JSON.parse(open(this.key, name, blob.data, FORMAT).toString("utf8")) as BufferDoc;
  }

  /**
   * Writes the buffer conditionally. On a conflict it hands the other writer"s
   * document to `merge` — which folds it into memory and returns the merged
   * document — and writes that, once. Throws {@link SupersededError} when the
   * other writer is the lease holder.
   */
  async writeBuffer(doc: BufferDoc, merge: (theirs: BufferDoc) => BufferDoc): Promise<void> {
    if (this.superseded) throw new SupersededError();
    const name = this.name("buffer.bin");
    const sealed = (d: BufferDoc) => seal(this.key, name, Buffer.from(JSON.stringify(d)), FORMAT);
    try {
      this.bufferGeneration = await this.blobs.write(name, sealed(doc), this.bufferGeneration);
    } catch (err) {
      if (!(err instanceof PreconditionFailed)) throw err;
      if (!(await this.checkLease(true))) throw new SupersededError();
      // Ours is the live reader; theirs was a process we replaced, writing on
      // its way out. Keep both sets of events.
      const theirs = await this.readBuffer();
      const merged = theirs ? merge(theirs) : doc;
      this.bufferGeneration = await this.blobs.write(name, sealed(merged), this.bufferGeneration);
    }
  }
}
