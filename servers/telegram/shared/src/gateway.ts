/**
 * The shape every tool talks to, and the shape the MTProto library is hidden
 * behind.
 *
 * One file implements this against a real client (mtproto.ts); the tests
 * implement the CLIENT it drives, not this interface, so the mapping and paging
 * logic below the tools is what the suite actually exercises.
 *
 * Ids are STRINGS. Telegram's are 64-bit and a channel id is already
 * `-100…` + a 10-digit number; JSON numbers are doubles, and an id that survives
 * a round trip today is not a property worth betting a wrong-chat write on.
 */

export type ChatKind = "user" | "bot" | "group" | "channel";

export interface ChatSummary {
  /** Numeric Telegram id, as a string. What every other tool takes as `chat`. */
  id: string;
  kind: ChatKind;
  /** Group/channel title, or the person's display name. */
  title: string;
  /** Public @username without the "@", when the chat has one. */
  username?: string;
  /** Unread count as Telegram reports it for this account. */
  unread_count?: number;
  /** True when the chat sits in the account's archive. */
  archived?: boolean;
}

export interface Account {
  id: string;
  name: string;
  username?: string;
}

export interface MessageAuthor {
  id: string;
  name: string;
  username?: string;
}

export interface Message {
  id: number;
  /** ISO 8601, UTC. */
  date: string;
  /** The message text, or "" for a media-only message. */
  text: string;
  author?: MessageAuthor;
  /** Set when this message is a reply, so a thread can be reconstructed. */
  reply_to_message_id?: number;
  /** A short kind ("photo", "document", "poll"), never the bytes. */
  media?: string;
  edited_at?: string;
  /** True when the authenticated account sent it. */
  outgoing?: boolean;
}

export interface MessagePage {
  chat: ChatSummary;
  /** OLDEST first. See `next_offset_id` for how to walk further back. */
  messages: Message[];
  /**
   * Pass as `offset_id` to get the page BEFORE this one. Absent when the chat
   * has been read back to its first message.
   */
  next_offset_id?: number;
}

export interface ListChatsQuery {
  limit: number;
  include_archived: boolean;
  /** Case-insensitive substring of the title or @username. */
  query?: string;
  kinds?: ChatKind[];
}

export interface HistoryQuery {
  chat: string;
  limit: number;
  /** Return messages OLDER than this id. From a previous `next_offset_id`. */
  offset_id?: number;
}

export interface SearchQuery {
  chat: string;
  query: string;
  limit: number;
  offset_id?: number;
}

export interface SendRequest {
  chat: string;
  text: string;
  reply_to_message_id?: number;
  disable_link_preview?: boolean;
}

export interface SentMessage {
  chat: ChatSummary;
  message_id: number;
  date: string;
}

export interface TelegramGateway {
  getMe(): Promise<Account>;
  listChats(query: ListChatsQuery): Promise<ChatSummary[]>;
  resolveChat(ref: string): Promise<ChatSummary>;
  getHistory(query: HistoryQuery): Promise<MessagePage>;
  searchMessages(query: SearchQuery): Promise<MessagePage>;
  sendMessage(request: SendRequest): Promise<SentMessage>;
}

/**
 * A chat reference that named nothing.
 *
 * Its own class because the recovery is specific and always the same: an id the
 * account has never seen has no access hash in the session, and `list_chats` is
 * what puts one there.
 */
export class UnknownChatError extends Error {
  constructor(ref: string, cause?: string) {
    super(
      `No chat matched "${ref}". Call list_chats first — it is what teaches this ` +
        `session about a chat, and its \`id\` and \`username\` fields are what ` +
        `belong here. A numeric id copied from a Telegram client's "Copy Link" ` +
        `is not one of them.` + (cause ? ` (${cause})` : ""),
    );
    this.name = "UnknownChatError";
  }
}
