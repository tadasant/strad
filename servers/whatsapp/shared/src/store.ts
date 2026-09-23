/**
 * What the bridge persists, where, and who is allowed to write it.
 *
 *   {prefix}/auth.bin          the Signal state: creds + keys. Sealed.
 *   {prefix}/index.bin         chat list, name book, LID map, owner. Sealed.
 *   {prefix}/chats/{hash}.bin  one chat's buffered messages. Sealed.
 *   {prefix}/lease.json        which process owns the account. Plain.
 *
 * Every sealed object is AES-256-GCM under WHATSAPP_STATE_ENCRYPTION_KEY with
 * its own name as AAD (crypto.ts). A chat's object name is a hash of its JID,
 * so the bucket listing does not disclose who the account talks to.
 *
 * ONE WRITER. A linked device is one identity, and two sockets on it kick each
 * other — but before WhatsApp notices, both would be writing the same Signal
 * state, and interleaved ratchet state is a session that silently stops
 * decrypting. An App Platform deploy makes that overlap routine: the new
 * container starts before the old one stops. So:
 *
 *   - a process CLAIMS the lease when it starts, which makes the newest
 *     process the owner;
 *   - the auth object is written conditionally on the generation this process
 *     last saw; a conflict means another process wrote it, and the lease says
 *     which of the two should stop;
 *   - the lease is re-read before a flush (at most every LEASE_CHECK_MS), so an
 *     old process that is not writing auth still learns it has been replaced.
 *
 * A process that loses the lease is SUPERSEDED: it stops writing anything and
 * the bridge closes its socket.
 */
import { createHash, randomUUID } from "node:crypto";
import { PreconditionFailed, type BlobStore } from "./blob-store.js";
import { open, seal } from "./crypto.js";
import type { ChatMeta } from "./buffer.js";
import type { StoredMessage } from "./normalize.js";

export const LEASE_CHECK_MS = 30_000;

export interface IndexDoc {
  version: 1;
  /** The paired account these chats belong to. A different account wipes them. */
  owner_jid: string | null;
  chats: ChatMeta[];
  /** Chats with a persisted messages object. */
  stored: string[];
  names: [string, string][];
  lid_to_pn: [string, string][];
  /** Ids this bridge sent, so an echo under another chat address stays marked. */
  bridge_sent?: string[];
}

export class SupersededError extends Error {
  constructor() {
    super(
      "Another process has taken over this WhatsApp account (a newer deploy, " +
        "or a second replica). This one has stopped its socket and stopped " +
        "writing state. The bridge component must run exactly ONE instance.",
    );
    this.name = "SupersededError";
  }
}

export class StateStore {
  readonly instanceId = randomUUID();
  private authGeneration: string | null | undefined;
  private lastLeaseCheck = 0;
  superseded = false;

  constructor(
    private readonly blobs: BlobStore,
    private readonly key: Buffer,
    private readonly prefix: string,
    private readonly clock: () => number = Date.now,
  ) {}

  private name(suffix: string): string {
    return `${this.prefix}/${suffix}`;
  }

  chatObjectName(chatId: string): string {
    const hash = createHash("sha256").update(chatId).digest("hex").slice(0, 40);
    return this.name(`chats/${hash}.bin`);
  }

  // --- the lease -------------------------------------------------------------

  async claimLease(): Promise<void> {
    await this.blobs.write(
      this.name("lease.json"),
      Buffer.from(
        JSON.stringify({ owner: this.instanceId, claimed_at: this.clock() }),
      ),
    );
    this.lastLeaseCheck = this.clock();
  }

  /** True when this process still owns the account. Sets `superseded` if not. */
  async checkLease(force = false): Promise<boolean> {
    if (this.superseded) return false;
    if (!force && this.clock() - this.lastLeaseCheck < LEASE_CHECK_MS) return true;
    this.lastLeaseCheck = this.clock();
    const lease = await this.blobs.read(this.name("lease.json"));
    let owner: string | undefined;
    try {
      owner = lease ? (JSON.parse(lease.data.toString("utf8")).owner as string) : undefined;
    } catch {
      owner = undefined;
    }
    // A missing or unreadable lease is nobody else's: take it back.
    if (owner === undefined) {
      await this.claimLease();
      return true;
    }
    if (owner !== this.instanceId) this.superseded = true;
    return !this.superseded;
  }

  private assertOwner(): void {
    if (this.superseded) throw new SupersededError();
  }

  // --- sealed objects -----------------------------------------------------------

  private async readSealed(name: string): Promise<{ plain: Buffer; generation: string } | null> {
    const blob = await this.blobs.read(name);
    if (!blob) return null;
    return { plain: open(this.key, name, blob.data), generation: blob.generation };
  }

  /** The raw auth document (Baileys' BufferJSON text), or null when never paired. */
  async readAuth(): Promise<string | null> {
    const got = await this.readSealed(this.name("auth.bin"));
    this.authGeneration = got ? got.generation : null;
    return got ? got.plain.toString("utf8") : null;
  }

  async writeAuth(json: string): Promise<void> {
    this.assertOwner();
    const name = this.name("auth.bin");
    const sealed = seal(this.key, name, Buffer.from(json, "utf8"));
    try {
      this.authGeneration = await this.blobs.write(name, sealed, this.authGeneration);
    } catch (err) {
      if (!(err instanceof PreconditionFailed)) throw err;
      // Somebody else wrote the account's state. If the lease is still ours,
      // that was a process we replaced, writing on its way out: ours is the
      // live socket, so ours wins. If the lease is theirs, we are the old one.
      if (!(await this.checkLease(true))) throw new SupersededError();
      const current = await this.blobs.read(name);
      this.authGeneration = await this.blobs.write(
        name,
        sealed,
        current ? current.generation : null,
      );
    }
  }

  async readIndex(): Promise<IndexDoc | null> {
    const got = await this.readSealed(this.name("index.bin"));
    return got ? (JSON.parse(got.plain.toString("utf8")) as IndexDoc) : null;
  }

  async writeIndex(doc: IndexDoc): Promise<void> {
    this.assertOwner();
    const name = this.name("index.bin");
    await this.blobs.write(name, seal(this.key, name, Buffer.from(JSON.stringify(doc))));
  }

  async readChat(chatId: string): Promise<StoredMessage[] | null> {
    const got = await this.readSealed(this.chatObjectName(chatId));
    if (!got) return null;
    const doc = JSON.parse(got.plain.toString("utf8")) as {
      chat_id: string;
      messages: StoredMessage[];
    };
    return doc.chat_id === chatId ? doc.messages : null;
  }

  async writeChat(chatId: string, messages: StoredMessage[]): Promise<void> {
    this.assertOwner();
    const name = this.chatObjectName(chatId);
    await this.blobs.write(
      name,
      seal(this.key, name, Buffer.from(JSON.stringify({ chat_id: chatId, messages }))),
    );
  }

  // --- wiping -------------------------------------------------------------------

  async deleteAuth(): Promise<void> {
    this.assertOwner();
    await this.blobs.delete(this.name("auth.bin"));
    this.authGeneration = null;
  }

  /** The buffer: the index and every chat object. The lease stays. */
  async deleteBuffer(): Promise<void> {
    this.assertOwner();
    await this.blobs.delete(this.name("index.bin"));
    for (const object of await this.blobs.list(this.name("chats/"))) {
      await this.blobs.delete(object);
    }
  }
}
