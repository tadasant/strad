/**
 * What the `message_received` event persists, beside the bridge's own state:
 *
 *   {prefix}/events/buffer.bin     the ring buffer (buffer.ts's BufferDoc). Sealed.
 *   {prefix}/events/webhooks.bin   webhook subscriptions (webhook/registry.ts). Sealed.
 *
 * `{prefix}` is the bridge's folder (`whatsapp` by default; `store.ts`), and
 * both objects are sealed with the bridge's `WAS1` format under
 * WHATSAPP_STATE_ENCRYPTION_KEY (`crypto.ts`), with the object's name as the
 * associated data.
 *
 * NO LEASE OF ITS OWN. The process that holds the bridge's lease is the one
 * that receives messages, so it is the one that writes the buffer. The buffer
 * write is conditional on the generation this process last saw, and a
 * conflict is settled by asking that lease, the way the bridge settles one on
 * its auth object: still ours, and the other writer was a process we replaced,
 * so both sets of events are kept; not ours, and this process stops.
 */
import { PreconditionFailed, type BlobStore } from "../state-store.js";
import { open, seal } from "../crypto.js";
import type { BufferDoc } from "./buffer.js";

export class EventsSuperseded extends Error {
  constructor() {
    super(
      "Another process owns this WhatsApp account now; this one has stopped writing the event buffer.",
    );
    this.name = "EventsSuperseded";
  }
}

export class EventsStore {
  private bufferGeneration: string | null | undefined;

  constructor(
    private readonly blobs: BlobStore,
    private readonly key: Buffer,
    /** The bridge's folder; the event objects live under `{prefix}/events/`. */
    private readonly prefix: string,
  ) {}

  private name(suffix: string): string {
    return `${this.prefix}/events/${suffix}`;
  }

  /** A sealed JSON document beside the buffer, with the generation a conditional write needs. */
  async readDoc<T>(suffix: string): Promise<{ doc: T | null; generation: string | null }> {
    const name = this.name(suffix);
    const blob = await this.blobs.read(name);
    if (!blob) return { doc: null, generation: null };
    return {
      doc: JSON.parse(open(this.key, name, blob.data).toString("utf8")) as T,
      generation: blob.generation,
    };
  }

  /** Conditional on `ifGeneration` (`null`: must not exist). Throws PreconditionFailed on a race. */
  async writeDoc(suffix: string, doc: unknown, ifGeneration: string | null): Promise<string> {
    const name = this.name(suffix);
    return this.blobs.write(name, seal(this.key, name, Buffer.from(JSON.stringify(doc))), ifGeneration);
  }

  async readBuffer(): Promise<BufferDoc | null> {
    const { doc, generation } = await this.readDoc<BufferDoc>("buffer.bin");
    this.bufferGeneration = generation;
    return doc;
  }

  /**
   * Writes the buffer conditionally. On a conflict, `stillOwner` decides: true,
   * and the other writer's document is handed to `merge` and the result written
   * once; false, and {@link EventsSuperseded} is thrown.
   */
  async writeBuffer(
    doc: BufferDoc,
    merge: (theirs: BufferDoc) => BufferDoc,
    stillOwner: () => Promise<boolean>,
  ): Promise<void> {
    try {
      this.bufferGeneration = await this.writeDoc("buffer.bin", doc, this.bufferGeneration ?? null);
    } catch (err) {
      if (!(err instanceof PreconditionFailed)) throw err;
      if (!(await stillOwner())) throw new EventsSuperseded();
      const theirs = await this.readBuffer();
      const merged = theirs ? merge(theirs) : doc;
      this.bufferGeneration = await this.writeDoc("buffer.bin", merged, this.bufferGeneration ?? null);
    }
  }

  /** The buffer only. Subscriptions carry no message content and outlive a re-pair. */
  async deleteBuffer(): Promise<void> {
    await this.blobs.delete(this.name("buffer.bin"));
    this.bufferGeneration = null;
  }
}
