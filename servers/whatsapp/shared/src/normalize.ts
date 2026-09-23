/**
 * WhatsApp's wire message → the record this server buffers.
 *
 * Pure functions over structural types, and deliberately NOT Baileys' helpers:
 * importing Baileys here would load it (and its protobuf tables) into every
 * bundle container that merely lists this server's tools. The shapes below are
 * the subset of `proto.IWebMessageInfo` this file reads; the tests feed them
 * the same objects Baileys emits.
 *
 * What is decided here is most of the tool contract: which messages exist at
 * all (protocol and system stubs do not), what `type` and `text` are, and what
 * a message quotes and mentions. Whether a mention or a quote is of the PAIRED
 * account is decided later, at read time, against whoever is paired then.
 */

export type MessageType =
  | "text"
  | "image"
  | "video"
  | "audio"
  | "document"
  | "sticker"
  | "reaction"
  | "other";

/** What the buffer stores. The tool output adds names and the two `_self` flags. */
export interface StoredMessage {
  id: string;
  chat_id: string;
  /** UNIX seconds. */
  timestamp: number;
  /** The sender. For `from_me`, the paired account's JID at the time. */
  sender_jid: string;
  /** The sender's OTHER address (LID for a phone JID, or the reverse), when known. */
  sender_alt_jid?: string;
  /** The display name the sender's own phone attached to this message. */
  push_name?: string;
  from_me: boolean;
  sent_by_bridge: boolean;
  text: string | null;
  type: MessageType;
  quoted_message_id: string | null;
  /** Who wrote the quoted message, as WhatsApp reports it (phone JID or LID). */
  quoted_participant: string | null;
  mentioned: string[];
}

/** A change to a message already buffered, carried by a protocol message. */
export type Mutation =
  | { kind: "edit"; chat_id: string; id: string; text: string | null }
  | { kind: "revoke"; chat_id: string; id: string };

// --- structural input types -------------------------------------------------

type Long = number | string | { toNumber(): number } | null | undefined;

export interface RawKey {
  remoteJid?: string | null;
  remoteJidAlt?: string | null;
  fromMe?: boolean | null;
  id?: string | null;
  participant?: string | null;
  participantAlt?: string | null;
}

export interface RawContextInfo {
  stanzaId?: string | null;
  participant?: string | null;
  mentionedJid?: string[] | null;
}

// Message content is a protobuf oneof-ish bag; indexing it by key is the only
// honest type for it without importing the generated classes.
export type RawContent = Record<string, unknown>;

export interface RawMessage {
  key?: RawKey | null;
  message?: RawContent | null;
  messageTimestamp?: Long;
  pushName?: string | null;
  messageStubType?: number | null;
}

// --- JIDs ---------------------------------------------------------------------

/** `123:4@s.whatsapp.net` → `123@s.whatsapp.net`. Device suffixes are not identity. */
export function normalizeJid(jid: string | null | undefined): string | null {
  if (!jid) return null;
  const at = jid.indexOf("@");
  if (at < 0) return null;
  const user = jid.slice(0, at).split(":")[0]!;
  const server = jid.slice(at + 1);
  return `${user}@${server === "c.us" ? "s.whatsapp.net" : server}`;
}

export const isGroupJid = (jid: string): boolean => jid.endsWith("@g.us");
export const isLidJid = (jid: string): boolean => jid.endsWith("@lid");
export const isPhoneJid = (jid: string): boolean =>
  jid.endsWith("@s.whatsapp.net");

/**
 * Chats this server never buffers: status updates, broadcast lists, channels.
 * None of them is a conversation anyone is in with the account.
 */
export function isIgnoredJid(jid: string): boolean {
  return (
    jid === "status@broadcast" ||
    jid.endsWith("@broadcast") ||
    jid.endsWith("@newsletter")
  );
}

export function toSeconds(value: Long): number | null {
  if (value === null || value === undefined) return null;
  const n =
    typeof value === "object" && typeof value.toNumber === "function"
      ? value.toNumber()
      : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

// --- content ------------------------------------------------------------------

/** Envelopes that carry the real message one level down. */
const WRAPPERS = [
  "ephemeralMessage",
  "viewOnceMessage",
  "viewOnceMessageV2",
  "viewOnceMessageV2Extension",
  "documentWithCaptionMessage",
  "deviceSentMessage",
  "editedMessage",
  "botInvokeMessage",
  "groupMentionedMessage",
  "lottieStickerMessage",
] as const;

export function unwrap(content: RawContent | null | undefined): RawContent | null {
  let current = content ?? null;
  for (let depth = 0; current && depth < 6; depth++) {
    let inner: RawContent | null = null;
    for (const wrapper of WRAPPERS) {
      const env = current[wrapper] as { message?: RawContent | null } | undefined;
      if (env && typeof env === "object" && env.message) {
        inner = env.message;
        break;
      }
    }
    if (!inner) break;
    current = inner;
  }
  return current;
}

/**
 * Keys that are plumbing rather than something a person sent. A message whose
 * only content is one of these is not a message (a sender-key handshake rides
 * along with the first group message of every new device, for example).
 */
const PLUMBING = new Set([
  "messageContextInfo",
  "senderKeyDistributionMessage",
  "protocolMessage",
  "pollUpdateMessage",
  "keepInChatMessage",
  "encReactionMessage",
  "encEventResponseMessage",
  "pinInChatMessage",
  "call",
  "fastRatchetKeySenderKeyDistributionMessage",
  "messageHistoryBundle",
  "messageHistoryNotice",
]);

const MEDIA: Record<string, MessageType> = {
  imageMessage: "image",
  videoMessage: "video",
  ptvMessage: "video",
  audioMessage: "audio",
  documentMessage: "document",
  stickerMessage: "sticker",
};

export interface Classified {
  type: MessageType;
  text: string | null;
  context: RawContextInfo | null;
  /** For a reaction, the message reacted to. */
  target_id?: string | null;
}

const str = (v: unknown): string | null =>
  typeof v === "string" && v !== "" ? v : null;

/** The content of an (unwrapped) message, or null when it is not a message. */
export function classify(content: RawContent | null): Classified | null {
  if (!content) return null;
  const pick = (key: string) =>
    (content[key] ?? null) as Record<string, unknown> | null;

  if (typeof content.conversation === "string" && content.conversation !== "") {
    return { type: "text", text: content.conversation, context: null };
  }
  const ext = pick("extendedTextMessage");
  if (ext) {
    return {
      type: "text",
      text: str(ext.text),
      context: (ext.contextInfo ?? null) as RawContextInfo | null,
    };
  }
  for (const [key, type] of Object.entries(MEDIA)) {
    const media = pick(key);
    if (media) {
      return {
        type,
        text: str(media.caption),
        context: (media.contextInfo ?? null) as RawContextInfo | null,
      };
    }
  }
  const reaction = pick("reactionMessage");
  if (reaction) {
    const emoji = str(reaction.text);
    // An empty reaction is a reaction REMOVED, which is not something anyone
    // said. Dropping it is what a transcript would do.
    if (!emoji) return null;
    const target = (reaction.key ?? null) as RawKey | null;
    return { type: "reaction", text: emoji, context: null, target_id: target?.id ?? null };
  }
  for (const [key, value] of Object.entries(content)) {
    if (value === null || value === undefined || PLUMBING.has(key)) continue;
    if (typeof value !== "object") continue;
    const inner = value as Record<string, unknown>;
    return {
      type: "other",
      text: str(inner.caption) ?? str(inner.text) ?? str(inner.name),
      context: (inner.contextInfo ?? null) as RawContextInfo | null,
    };
  }
  return null;
}

/** Protocol messages that change a message already in the buffer. */
export function mutationOf(
  chatId: string,
  content: RawContent | null,
): Mutation | null {
  const protocol = (content?.protocolMessage ?? null) as {
    type?: number | string | null;
    key?: RawKey | null;
    editedMessage?: RawContent | null;
  } | null;
  if (!protocol?.key?.id) return null;
  const type = protocol.type;
  // proto.Message.ProtocolMessage.Type: REVOKE = 0, MESSAGE_EDIT = 14.
  if (type === 0 || type === "REVOKE") {
    return { kind: "revoke", chat_id: chatId, id: protocol.key.id };
  }
  if (type === 14 || type === "MESSAGE_EDIT") {
    const edited = classify(unwrap(protocol.editedMessage ?? null));
    return { kind: "edit", chat_id: chatId, id: protocol.key.id, text: edited?.text ?? null };
  }
  return null;
}

// --- the whole message ----------------------------------------------------------

export interface SelfIdentity {
  /** Phone JID, device suffix stripped. */
  jid: string | null;
  lid: string | null;
}

/**
 * The chat a key belongs to, as ONE id.
 *
 * A 1:1 chat can arrive addressed by phone JID or by LID. The phone JID is the
 * one a human can read and the one `whatsapp_list_chats` hands out, so it wins
 * whenever the key (or a mapping learned earlier) supplies it.
 */
export function chatIdOf(
  key: RawKey,
  lidToPn: ReadonlyMap<string, string>,
): string | null {
  const remote = normalizeJid(key.remoteJid);
  if (!remote) return null;
  if (isLidJid(remote)) {
    const alt = normalizeJid(key.remoteJidAlt);
    if (alt && isPhoneJid(alt)) return alt;
    return lidToPn.get(remote) ?? remote;
  }
  return remote;
}

export type Normalized =
  | { kind: "message"; message: StoredMessage }
  | { kind: "mutation"; mutation: Mutation }
  | { kind: "skip" };

export function normalizeMessage(
  raw: RawMessage,
  self: SelfIdentity,
  lidToPn: ReadonlyMap<string, string>,
): Normalized {
  const key = raw.key;
  if (!key?.id || !key.remoteJid) return { kind: "skip" };
  const chatId = chatIdOf(key, lidToPn);
  if (!chatId || isIgnoredJid(chatId)) return { kind: "skip" };

  const content = unwrap(raw.message);
  const mutation = mutationOf(chatId, content);
  if (mutation) return { kind: "mutation", mutation };
  // A stub (someone joined, the subject changed, encryption notice…) carries no
  // content, and is excluded by the contract.
  if (raw.messageStubType && !content) return { kind: "skip" };

  const classified = classify(content);
  if (!classified) return { kind: "skip" };
  const timestamp = toSeconds(raw.messageTimestamp);
  if (timestamp === null) return { kind: "skip" };

  const fromMe = key.fromMe === true;
  let sender: string | null;
  let senderAlt: string | null;
  if (fromMe) {
    sender = self.jid ?? self.lid;
    senderAlt = self.lid && sender !== self.lid ? self.lid : null;
  } else if (isGroupJid(chatId)) {
    const participant = normalizeJid(key.participant);
    const alt = normalizeJid(key.participantAlt);
    // Prefer the phone JID, like chats do; keep the other so a mention of the
    // LID can still be matched to this person.
    if (participant && isLidJid(participant)) {
      sender = alt && isPhoneJid(alt) ? alt : lidToPn.get(participant) ?? participant;
      senderAlt = sender === participant ? null : participant;
    } else {
      sender = participant ?? alt;
      senderAlt = participant && alt ? alt : null;
    }
  } else {
    sender = chatId;
    const remote = normalizeJid(key.remoteJid);
    senderAlt = remote && remote !== chatId ? remote : null;
  }
  if (!sender) return { kind: "skip" };

  const context = classified.context;
  const quotedId =
    classified.type === "reaction"
      ? (classified.target_id ?? null)
      : str(context?.stanzaId);

  return {
    kind: "message",
    message: {
      id: key.id,
      chat_id: chatId,
      timestamp,
      sender_jid: sender,
      ...(senderAlt ? { sender_alt_jid: senderAlt } : {}),
      ...(raw.pushName ? { push_name: raw.pushName } : {}),
      from_me: fromMe,
      sent_by_bridge: false,
      text: classified.text,
      type: classified.type,
      quoted_message_id: quotedId,
      quoted_participant: normalizeJid(context?.participant),
      mentioned: (context?.mentionedJid ?? [])
        .map((j) => normalizeJid(j))
        .filter((j): j is string => j !== null),
    },
  };
}

/** Is `jid` the paired account, under either of its addresses? */
export function isSelf(jid: string | null | undefined, self: SelfIdentity): boolean {
  const n = normalizeJid(jid);
  return n !== null && (n === self.jid || n === self.lid);
}
