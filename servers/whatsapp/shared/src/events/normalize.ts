/**
 * A message the bridge just received → the `message_received` payload.
 *
 * The payload is a SUMMARY, not the message: the text is cut to
 * {@link MAX_TEXT_CHARS}, a media message says what kind it is and carries
 * none of its descriptor (the media key decrypts the file and never leaves
 * the bridge), and a subscriber that wants more reads the chat with
 * `whatsapp_get_messages` or the file with `whatsapp_get_attachment`.
 *
 * Every name and the text are what other people typed. They are untrusted,
 * and the schema says so on each field.
 */
import type { StoredMessage } from "../normalize.js";

/** Zimmer's WhatsApp trigger quotes at most this much of a message; so does the event. */
export const MAX_TEXT_CHARS = 2_000;

export type MediaType = "image" | "video" | "audio" | "document" | "sticker";

const MEDIA = new Set<string>(["image", "video", "audio", "document", "sticker"]);

export interface MessageReceived {
  message_id: string;
  chat_id: string;
  chat_name: string;
  is_group: boolean;
  sender_jid: string;
  sender_name: string;
  push_name: string | null;
  from_me: boolean;
  timestamp: string;
  type: StoredMessage["type"];
  media_type: MediaType | null;
  text: string | null;
  text_truncated: boolean;
  quoted_message_id: string | null;
  mentions_self: boolean;
  reply_to_self: boolean;
}

/** What the bridge resolves about a new message at the moment it is ingested. */
export interface IncomingMessage {
  message: StoredMessage;
  /** The chat's other JID (LID ↔ phone), when the bridge knows it. Matched by `chat_ids`, never delivered. */
  chat_alt_id?: string;
  chat_name: string;
  sender_name: string;
  mentions_self: boolean;
  reply_to_self: boolean;
}

/** `whatsapp:<chat_jid>:<message_id>`. A message id is unique within its chat, not across chats. */
export function eventIdFor(chatId: string, messageId: string): string {
  return `whatsapp:${chatId}:${messageId}`;
}

/** Cut at a code point, never inside a surrogate pair. */
function cut(text: string, max: number): string {
  const points = Array.from(text);
  return points.length <= max ? text : points.slice(0, max).join("");
}

export function toMessageReceived(m: IncomingMessage): MessageReceived {
  const s = m.message;
  const text = s.text === null ? null : cut(s.text, MAX_TEXT_CHARS);
  return {
    message_id: s.id,
    chat_id: s.chat_id,
    chat_name: m.chat_name,
    is_group: s.chat_id.endsWith("@g.us"),
    sender_jid: s.sender_jid,
    sender_name: m.sender_name,
    push_name: s.push_name ?? null,
    from_me: s.from_me,
    timestamp: new Date(s.timestamp * 1000).toISOString(),
    type: s.type,
    media_type: MEDIA.has(s.type) ? (s.type as MediaType) : null,
    text,
    text_truncated: text !== null && text !== s.text,
    quoted_message_id: s.quoted_message_id,
    mentions_self: m.mentions_self,
    reply_to_self: m.reply_to_self,
  };
}
