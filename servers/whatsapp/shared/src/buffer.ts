/**
 * The message buffer: what this bridge has SEEN, because WhatsApp has no
 * history API a linked device can call.
 *
 * Everything a read returns comes from here — the history sync WhatsApp pushes
 * once, when the device is linked, plus every message the socket has received
 * since. It is bounded per chat (by count and by age) and persisted per chat
 * (store.ts), so a redeploy does not forget it and one busy group cannot make
 * every write expensive.
 *
 * Chat MESSAGES load lazily: the index (chat names, activity times, the name
 * book) is read at boot, and a chat's messages are read the first time a tool
 * or an incoming message touches that chat.
 */
import type { StoredMessage } from "./normalize.js";

export interface ChatMeta {
  id: string;
  name: string | null;
  is_group: boolean;
  /** UNIX seconds of the newest activity WhatsApp or the buffer knows of. */
  last_message_at: number | null;
  participant_count: number | null;
}

export interface QueryResult {
  messages: StoredMessage[];
  has_more: boolean;
}

export interface BufferLimits {
  maxMessages: number;
  maxAgeDays: number;
}

export type ChatLoader = (chatId: string) => Promise<StoredMessage[] | null>;

interface ChatMessages {
  byId: Map<string, StoredMessage>;
}

const byTime = (a: StoredMessage, b: StoredMessage): number =>
  a.timestamp - b.timestamp || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export class MessageBuffer {
  readonly chats = new Map<string, ChatMeta>();
  /** jid → best display name known (contact book, group subject, push name). */
  readonly names = new Map<string, string>();
  /** LID → phone JID, as WhatsApp discloses the mapping. */
  readonly lidToPn = new Map<string, string>();
  /** Chats that have a persisted messages object (whether loaded or not). */
  readonly stored = new Set<string>();

  private readonly loaded = new Map<string, ChatMessages>();
  private readonly loading = new Map<string, Promise<ChatMessages>>();
  readonly dirtyChats = new Set<string>();
  indexDirty = false;

  constructor(
    private readonly limits: BufferLimits,
    private readonly loader: ChatLoader,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  /** Forget everything, in memory. The caller deletes what is persisted. */
  clear(): void {
    this.chats.clear();
    this.names.clear();
    this.lidToPn.clear();
    this.stored.clear();
    this.loaded.clear();
    this.loading.clear();
    this.dirtyChats.clear();
    this.indexDirty = true;
  }

  private cutoff(): number {
    return this.now() - this.limits.maxAgeDays * 86_400;
  }

  private async chat(chatId: string): Promise<ChatMessages> {
    const have = this.loaded.get(chatId);
    if (have) return have;
    let pending = this.loading.get(chatId);
    if (!pending) {
      pending = (async () => {
        const fresh: ChatMessages = { byId: new Map() };
        if (this.stored.has(chatId)) {
          for (const m of (await this.loader(chatId)) ?? []) fresh.byId.set(m.id, m);
        }
        this.loaded.set(chatId, fresh);
        this.loading.delete(chatId);
        return fresh;
      })();
      pending.catch(() => this.loading.delete(chatId));
      this.loading.set(chatId, pending);
    }
    return pending;
  }

  /** Metadata for a chat, created on first sight. */
  touchChat(chatId: string, patch: Partial<Omit<ChatMeta, "id">> = {}): ChatMeta {
    let meta = this.chats.get(chatId);
    if (!meta) {
      meta = {
        id: chatId,
        name: null,
        is_group: chatId.endsWith("@g.us"),
        last_message_at: null,
        participant_count: chatId.endsWith("@g.us") ? null : 2,
      };
      this.chats.set(chatId, meta);
      this.indexDirty = true;
    }
    for (const [k, v] of Object.entries(patch) as [keyof ChatMeta, unknown][]) {
      if (v === undefined || v === null) continue;
      if (k === "last_message_at") {
        const t = v as number;
        if (meta.last_message_at === null || t > meta.last_message_at) {
          meta.last_message_at = t;
          this.indexDirty = true;
        }
        continue;
      }
      if ((meta as unknown as Record<string, unknown>)[k] !== v) {
        (meta as unknown as Record<string, unknown>)[k] = v;
        this.indexDirty = true;
      }
    }
    return meta;
  }

  setName(jid: string, name: string | null | undefined): void {
    if (!name || name === "~") return;
    if (this.names.get(jid) === name) return;
    this.names.set(jid, name);
    this.indexDirty = true;
  }

  mapLid(lid: string, pn: string): void {
    if (this.lidToPn.get(lid) === pn) return;
    this.lidToPn.set(lid, pn);
    this.indexDirty = true;
  }

  /**
   * Add a message, or merge it into the copy already held.
   *
   * `sent_by_bridge` is STICKY: the socket echoes a message this bridge sent
   * back through the same event as every other message, before `sendMessage`
   * even returns, and a history sync may deliver it a third time. None of those
   * copies may clear the flag, or Zimmer would answer its own message.
   */
  async upsert(message: StoredMessage): Promise<boolean> {
    if (message.timestamp < this.cutoff()) return false;
    const chat = await this.chat(message.chat_id);
    const existing = chat.byId.get(message.id);
    const merged: StoredMessage = existing
      ? {
          ...existing,
          ...message,
          sent_by_bridge: existing.sent_by_bridge || message.sent_by_bridge,
          // An echo or a redelivery can arrive without what a richer copy
          // carried: keep the text, the quote and the mentions already known.
          text: message.text ?? existing.text,
          quoted_message_id: message.quoted_message_id ?? existing.quoted_message_id,
          quoted_participant: message.quoted_participant ?? existing.quoted_participant,
          mentioned: message.mentioned.length ? message.mentioned : existing.mentioned,
        }
      : message;
    chat.byId.set(message.id, merged);
    this.prune(message.chat_id, chat);
    this.dirtyChats.add(message.chat_id);
    this.stored.add(message.chat_id);
    this.touchChat(message.chat_id, { last_message_at: message.timestamp });
    if (!message.from_me && message.push_name && !this.names.has(message.sender_jid)) {
      this.setName(message.sender_jid, message.push_name);
    }
    return true;
  }

  async markSentByBridge(chatId: string, id: string): Promise<void> {
    const chat = await this.chat(chatId);
    const existing = chat.byId.get(id);
    if (existing && !existing.sent_by_bridge) {
      chat.byId.set(id, { ...existing, sent_by_bridge: true });
      this.dirtyChats.add(chatId);
    }
  }

  async edit(chatId: string, id: string, text: string | null): Promise<void> {
    const chat = await this.chat(chatId);
    const existing = chat.byId.get(id);
    if (!existing) return;
    chat.byId.set(id, { ...existing, text });
    this.dirtyChats.add(chatId);
  }

  /** Deleted for everyone: the buffer forgets it, as the chat does. */
  async revoke(chatId: string, id: string): Promise<void> {
    const chat = await this.chat(chatId);
    if (chat.byId.delete(id)) this.dirtyChats.add(chatId);
  }

  async get(chatId: string, id: string): Promise<StoredMessage | undefined> {
    return (await this.chat(chatId)).byId.get(id);
  }

  private prune(chatId: string, chat: ChatMessages): void {
    const cutoff = this.cutoff();
    const sorted = [...chat.byId.values()].sort(byTime);
    const excess = sorted.length - this.limits.maxMessages;
    for (let i = 0; i < sorted.length; i++) {
      const m = sorted[i]!;
      if (i < excess || m.timestamp < cutoff) {
        chat.byId.delete(m.id);
        this.dirtyChats.add(chatId);
      }
    }
  }

  /**
   * The contract's read, exactly:
   *   - with `after` (inclusive): the OLDEST `limit` at or after it, and
   *     `has_more` when more matched — a cursor walking forward never skips;
   *   - without: the NEWEST `limit`;
   * oldest first either way.
   */
  async query(chatId: string, limit: number, after?: number): Promise<QueryResult> {
    const chat = await this.chat(chatId);
    this.prune(chatId, chat);
    const all = [...chat.byId.values()].sort(byTime);
    if (after !== undefined) {
      const matched = all.filter((m) => m.timestamp >= after);
      return { messages: matched.slice(0, limit), has_more: matched.length > limit };
    }
    return {
      messages: all.slice(Math.max(0, all.length - limit)),
      has_more: all.length > limit,
    };
  }

  /** Messages of a chat for persistence, oldest first. */
  async snapshot(chatId: string): Promise<StoredMessage[]> {
    return [...(await this.chat(chatId)).byId.values()].sort(byTime);
  }

  isLoaded(chatId: string): boolean {
    return this.loaded.has(chatId);
  }
}
