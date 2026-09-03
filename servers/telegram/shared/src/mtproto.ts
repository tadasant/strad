/**
 * The MTProto half: everything that knows what a Telegram entity looks like.
 *
 * THE LIBRARY IS BEHIND ONE DOOR. The only import of the MTProto client library
 * in this server is in `createMtprotoClient` at the bottom of this file; the
 * mapping above it drives a structural interface (`MtprotoClient`) that the
 * library's client satisfies and that the tests implement directly. That is what
 * makes the suite a test of THIS code rather than of a mock of itself — and it
 * is what would make swapping the library a change to one function.
 *
 * The mapping is defensive about shapes on purpose. A TL object is whatever the
 * layer the server negotiated says it is, and a field that is absent for a
 * channel is present for a user; reading them optionally beats a cast that is
 * true until Telegram ships a layer.
 */

import {
  UnknownChatError,
  type Account,
  type ChatKind,
  type ChatSummary,
  type HistoryQuery,
  type ListChatsQuery,
  type Message,
  type MessagePage,
  type SearchQuery,
  type SendRequest,
  type SentMessage,
  type TelegramGateway,
} from "./gateway.js";
import type { TelegramConfig } from "./config.js";

/* -------------------------------------------------------------------------- */
/* The client surface this server uses                                        */
/* -------------------------------------------------------------------------- */

export interface RawEntity {
  id?: unknown;
  className?: string;
  title?: string;
  username?: string;
  firstName?: string;
  lastName?: string;
  bot?: boolean;
  megagroup?: boolean;
  broadcast?: boolean;
}

export interface RawDialog {
  id?: unknown;
  title?: string;
  name?: string;
  unreadCount?: number;
  archived?: boolean;
  isUser?: boolean;
  isGroup?: boolean;
  isChannel?: boolean;
  entity?: RawEntity | null;
}

export interface RawMessage {
  id: number;
  /** Unix seconds, as MTProto sends it. */
  date?: number;
  message?: string;
  senderId?: unknown;
  sender?: RawEntity | null;
  replyTo?: { replyToMsgId?: number } | null;
  media?: { className?: string } | null;
  editDate?: number | null;
  out?: boolean;
}

/**
 * The five calls this server makes. Deliberately narrow: a wider surface is a
 * wider fake, and a wider fake is a test that proves less.
 */
export interface MtprotoClient {
  connect(): Promise<unknown>;
  getMe(): Promise<RawEntity>;
  getDialogs(params: {
    limit: number;
    archived?: boolean;
  }): Promise<readonly RawDialog[]>;
  getMessages(
    entity: unknown,
    params: { limit: number; offsetId?: number; search?: string },
  ): Promise<readonly RawMessage[]>;
  sendMessage(
    entity: unknown,
    params: { message: string; replyTo?: number; linkPreview?: boolean },
  ): Promise<RawMessage>;
  getEntity(ref: unknown): Promise<RawEntity>;
}

/* -------------------------------------------------------------------------- */
/* Mapping                                                                     */
/* -------------------------------------------------------------------------- */

/** Telegram ids are 64-bit; carry them as strings everywhere above this line. */
function idString(id: unknown): string {
  if (id === null || id === undefined) return "";
  if (typeof id === "string") return id;
  if (typeof id === "number" || typeof id === "bigint") return String(id);
  // big-integer's BigInteger, and anything else that knows its own decimal form.
  return String(id);
}

export function entityKind(entity: RawEntity | null | undefined): ChatKind {
  const className = entity?.className ?? "";
  if (className.startsWith("Channel")) {
    return entity?.megagroup ? "group" : "channel";
  }
  if (className.startsWith("Chat")) return "group";
  if (entity?.bot) return "bot";
  return "user";
}

export function displayName(entity: RawEntity | null | undefined): string {
  if (!entity) return "unknown";
  if (entity.title) return entity.title;
  const name = [entity.firstName, entity.lastName].filter(Boolean).join(" ");
  if (name) return name;
  if (entity.username) return `@${entity.username}`;
  return `id:${idString(entity.id)}`;
}

export function toChatSummary(
  entity: RawEntity | null | undefined,
  extra: { id?: string; unread_count?: number; archived?: boolean } = {},
): ChatSummary {
  const id = extra.id ?? idString(entity?.id);
  return {
    id,
    kind: entityKind(entity),
    title: displayName(entity),
    ...(entity?.username ? { username: entity.username } : {}),
    ...(extra.unread_count !== undefined
      ? { unread_count: extra.unread_count }
      : {}),
    ...(extra.archived ? { archived: true } : {}),
  };
}

/** "MessageMediaDocument" -> "document". The kind, never the bytes. */
export function mediaKind(
  media: { className?: string } | null | undefined,
): string | undefined {
  const className = media?.className;
  if (!className) return undefined;
  const stripped = className.replace(/^MessageMedia/, "");
  if (!stripped || stripped === "Empty") return undefined;
  return stripped
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
}

export function toMessage(raw: RawMessage): Message {
  const author = raw.sender
    ? {
        id: idString(raw.sender.id),
        name: displayName(raw.sender),
        ...(raw.sender.username ? { username: raw.sender.username } : {}),
      }
    : raw.senderId !== undefined && raw.senderId !== null
      ? { id: idString(raw.senderId), name: `id:${idString(raw.senderId)}` }
      : undefined;

  return {
    id: raw.id,
    date: new Date((raw.date ?? 0) * 1000).toISOString(),
    text: raw.message ?? "",
    ...(author ? { author } : {}),
    ...(raw.replyTo?.replyToMsgId
      ? { reply_to_message_id: raw.replyTo.replyToMsgId }
      : {}),
    ...(mediaKind(raw.media) ? { media: mediaKind(raw.media) } : {}),
    ...(raw.editDate
      ? { edited_at: new Date(raw.editDate * 1000).toISOString() }
      : {}),
    ...(raw.out ? { outgoing: true } : {}),
  };
}

/**
 * What a caller may put in `chat`.
 *
 * A t.me link is accepted because it is what a human copies out of a Telegram
 * client and hands to an agent verbatim — including the `t.me/c/<id>/<message>`
 * form, which is what "Copy Link" produces inside a PRIVATE supergroup, i.e.
 * exactly the kind of group this server exists to read. A private-INVITE link
 * (`t.me/+hash`, `t.me/joinchat/hash`) is not a chat reference at all — it is an
 * invitation — and saying so is more useful than resolving it to nothing.
 */
export function parseChatRef(
  raw: string,
): { kind: "username"; value: string } | { kind: "id"; value: string } {
  const ref = raw.trim();
  if (ref === "") throw new UnknownChatError(raw, "empty reference");

  const host = /^(?:https?:\/\/)?(?:t\.me|telegram\.me)\//i;
  const isLink = host.test(ref);
  const path = isLink ? ref.replace(host, "") : ref;

  // t.me/c/4123456789/8815 — the id is right there, and it is the one form a
  // human can copy for a group with no @username. It carries the BARE id, and a
  // bare positive id is a user peer to the library, so it is normalised to the
  // `-100` form: this link only ever names a channel or supergroup.
  const privateLink = isLink && path.match(/^c\/(\d+)/i);
  if (privateLink) return { kind: "id", value: `-100${privateLink[1]!}` };

  const candidate = path.split(/[/?#]/)[0] ?? "";

  // An invite is `+hash` in either form, or the legacy `joinchat/hash` PATH.
  // `joinchat` alone is a legal username, so the slash matters.
  if (candidate.startsWith("+") || /^joinchat\//i.test(path)) {
    throw new UnknownChatError(
      raw,
      "that is a private INVITE link, not a chat reference. Join the chat in a " +
        "Telegram client first, then call list_chats to get its id",
    );
  }

  const bare = candidate.replace(/^@/, "");
  if (/^-?\d+$/.test(bare)) return { kind: "id", value: bare };
  if (/^[A-Za-z][A-Za-z0-9_]{3,}$/.test(bare)) {
    return { kind: "username", value: bare };
  }
  throw new UnknownChatError(
    raw,
    "not a numeric id, an @username, or a public t.me link",
  );
}

/**
 * Two ids for one chat, and both are "right".
 *
 * A supergroup is id 1234567890 in MTProto and -1001234567890 in every Bot API
 * surface and every "Copy Link" a human pastes. Matching on the canonical form
 * means a caller can hand over either.
 *
 * ONLY the `-100` prefix is folded. Stripping a bare `-` as well would make a
 * legacy chat `-4123456789` equal to a USER `4123456789`, and user ids and
 * channel ids come from overlapping ranges — so that fold silently widens the
 * set of chats a reference can match, on the same path `send_message` resolves
 * through. Two ids for one chat is a Telegram fact; three is a bug.
 */
export function sameChatId(a: string, b: string): boolean {
  return canonicalId(a) === canonicalId(b);
}

function canonicalId(id: string): string {
  return id.replace(/^-100/, "");
}

/** Is this entity the one the reference asked for? */
function resolvesTo(
  parsed: { kind: "username" | "id"; value: string },
  entity: RawEntity,
): boolean {
  if (parsed.kind === "username") {
    return (
      (entity.username ?? "").toLowerCase() === parsed.value.toLowerCase()
    );
  }
  return sameChatId(idString(entity.id), parsed.value);
}

/* -------------------------------------------------------------------------- */
/* The gateway                                                                 */
/* -------------------------------------------------------------------------- */

/** How many dialogs a resolution scan is willing to walk. */
const RESOLVE_SCAN_LIMIT = 200;

interface Resolved {
  summary: ChatSummary;
  entity: unknown;
}

export function createGateway(client: MtprotoClient): TelegramGateway {
  // Resolutions are memoised for the process. Resolving costs an API round trip
  // and every tool call needs one; a title that goes stale between calls is a
  // cosmetic cost against a per-call round trip on every read.
  //
  // What a memoised summary does NOT carry is the chat's volatile state: an
  // unread count cached at first resolution would be reported as current for
  // the life of the process. `list_chats` reads that from the dialog list every
  // time, which is where a count belongs.
  const resolved = new Map<string, Resolved>();

  const dialogsOf = async (
    limit: number,
    includeArchived: boolean,
  ): Promise<RawDialog[]> => {
    const active = await client.getDialogs({ limit, archived: false });
    if (!includeArchived) return [...active];
    const archived = await client.getDialogs({ limit, archived: true });
    return [...active, ...archived.map((d) => ({ ...d, archived: true }))];
  };

  const resolve = async (ref: string): Promise<Resolved> => {
    const parsed = parseChatRef(ref);
    const cached = resolved.get(parsed.value);
    if (cached) return cached;

    // The fast path. For a public @username it is also the only path that works
    // for a chat the account has never opened.
    try {
      const entity = await client.getEntity(
        parsed.kind === "username" ? parsed.value : Number(parsed.value),
      );
      // A POSITIVE id is a user peer to the library, so asking it for a
      // supergroup's bare id can come back with a different chat that happens to
      // hold that number — user ids and channel ids share a range. Whatever it
      // answers must be the chat that was asked for; if it is not, the dialog
      // scan below decides instead. This is a wrong-chat WRITE otherwise.
      if (entity && resolvesTo(parsed, entity)) {
        const hit = { summary: toChatSummary(entity), entity };
        resolved.set(parsed.value, hit);
        return hit;
      }
    } catch {
      // Expected for an id whose access hash this session has not learned yet.
      // Fall through to the dialog scan, which is what teaches it.
    }

    const dialogs = await dialogsOf(RESOLVE_SCAN_LIMIT, true);
    let fallback: Resolved | undefined;
    for (const dialog of dialogs) {
      const entity = dialog.entity ?? undefined;
      const dialogId = idString(dialog.id ?? entity?.id);
      const exact =
        parsed.kind === "id"
          ? dialogId === parsed.value
          : entity?.username?.toLowerCase() === parsed.value.toLowerCase();
      // `-100…` and the bare form name one supergroup, so a canonical match is a
      // real answer — but only when no dialog answers to the id AS WRITTEN.
      const canonical =
        parsed.kind === "id" && sameChatId(dialogId, parsed.value);
      if (!exact && !canonical) continue;

      const hit = {
        summary: toChatSummary(entity, {
          id: dialogId,
          ...(dialog.archived ? { archived: true } : {}),
        }),
        entity: entity ?? dialog.id,
      };
      if (!exact) {
        fallback ??= hit;
        continue;
      }
      resolved.set(parsed.value, hit);
      return hit;
    }

    if (fallback) {
      resolved.set(parsed.value, fallback);
      return fallback;
    }
    throw new UnknownChatError(ref);
  };

  const page = async (
    chat: Resolved,
    limit: number,
    params: { offsetId?: number; search?: string },
  ): Promise<MessagePage> => {
    const raw = await client.getMessages(chat.entity, {
      limit,
      ...(params.offsetId !== undefined ? { offsetId: params.offsetId } : {}),
      ...(params.search !== undefined ? { search: params.search } : {}),
    });

    // Telegram answers newest-first. A transcript reads oldest-first, and the
    // cursor below is what keeps paging honest either way: it always points at
    // the OLDEST message returned, because paging goes backwards in time.
    const messages = [...raw].map(toMessage).sort((a, b) => a.id - b.id);
    const oldest = messages[0]?.id;

    return {
      chat: chat.summary,
      messages,
      // A short page means the chat ran out, so there is nothing older to ask
      // for. Emitting a cursor there produces one wasted empty call per read.
      ...(oldest !== undefined && raw.length >= limit
        ? { next_offset_id: oldest }
        : {}),
    };
  };

  return {
    async getMe(): Promise<Account> {
      const me = await client.getMe();
      return {
        id: idString(me?.id),
        name: displayName(me),
        ...(me?.username ? { username: me.username } : {}),
      };
    },

    async listChats(query: ListChatsQuery): Promise<ChatSummary[]> {
      // Filters run over a page Telegram already sent, so ask for headroom when
      // one is set — otherwise `kinds: ["group"]` returns four chats out of a
      // limit of fifty and looks like the account has four groups.
      const filtered = Boolean(query.query || query.kinds?.length);
      const fetchLimit = Math.min(
        filtered ? Math.max(query.limit * 4, 100) : query.limit,
        500,
      );
      const dialogs = await dialogsOf(fetchLimit, query.include_archived);

      const needle = query.query?.trim().toLowerCase();
      const summaries: ChatSummary[] = [];
      for (const dialog of dialogs) {
        const entity = dialog.entity ?? undefined;
        const summary = toChatSummary(entity, {
          id: idString(dialog.id ?? entity?.id),
          ...(dialog.unreadCount !== undefined
            ? { unread_count: dialog.unreadCount }
            : {}),
          ...(dialog.archived ? { archived: true } : {}),
        });
        if (query.kinds?.length && !query.kinds.includes(summary.kind)) continue;
        if (
          needle &&
          !summary.title.toLowerCase().includes(needle) &&
          !(summary.username ?? "").toLowerCase().includes(needle)
        ) {
          continue;
        }
        summaries.push(summary);
        if (summaries.length >= query.limit) break;
      }
      return summaries;
    },

    async resolveChat(ref: string): Promise<ChatSummary> {
      return (await resolve(ref)).summary;
    },

    async getHistory(query: HistoryQuery): Promise<MessagePage> {
      const chat = await resolve(query.chat);
      return page(chat, query.limit, {
        ...(query.offset_id !== undefined ? { offsetId: query.offset_id } : {}),
      });
    },

    async searchMessages(query: SearchQuery): Promise<MessagePage> {
      const chat = await resolve(query.chat);
      return page(chat, query.limit, {
        search: query.query,
        ...(query.offset_id !== undefined ? { offsetId: query.offset_id } : {}),
      });
    },

    async sendMessage(request: SendRequest): Promise<SentMessage> {
      const chat = await resolve(request.chat);
      const sent = await client.sendMessage(chat.entity, {
        message: request.text,
        ...(request.reply_to_message_id !== undefined
          ? { replyTo: request.reply_to_message_id }
          : {}),
        ...(request.disable_link_preview ? { linkPreview: false } : {}),
      });
      return {
        chat: chat.summary,
        message_id: sent.id,
        date: new Date((sent.date ?? 0) * 1000).toISOString(),
      };
    },
  };
}

/* -------------------------------------------------------------------------- */
/* The one place the library is imported                                       */
/* -------------------------------------------------------------------------- */

/**
 * Build and connect a real MTProto client.
 *
 * `telegram` is GramJS. It is the library the session string is minted by, and
 * its `StringSession` is the format that string is in. It is also ARCHIVED
 * upstream (last release February 2025), which is recorded in HACKS.md and in
 * the README rather than discovered later: the maintained fork is `teleproto`,
 * the session format is the same, and this function is the whole of what would
 * change.
 *
 * The import is dynamic so that nothing about the library — including its
 * WebSocket and crypto dependencies — is loaded in a process that never calls a
 * Telegram tool. In the bundle that process hosts twenty other servers.
 */
export async function createMtprotoClient(
  config: TelegramConfig,
): Promise<MtprotoClient> {
  const { TelegramClient, Logger } = (await import("telegram")) as unknown as {
    TelegramClient: new (
      session: unknown,
      apiId: number,
      apiHash: string,
      options: Record<string, unknown>,
    ) => MtprotoClient;
    Logger: new (level: string) => unknown;
  };
  const { StringSession } = (await import(
    "telegram/sessions/index.js"
  )) as unknown as { StringSession: new (session: string) => unknown };

  const client = new TelegramClient(
    new StringSession(config.stringSession),
    config.apiId,
    config.apiHash,
    {
      connectionRetries: 3,
      // The library logs its own connection lifecycle to stdout at "info", and
      // stdout in the bundle is a stream strad does not ship. "error" keeps the
      // lines that mean something and keeps the rest out of a stream nobody
      // reads. Nothing it logs is a credential, but see logging.ts — this
      // server's own lines go through `redact` regardless.
      baseLogger: new Logger("error"),
    },
  );
  await client.connect();
  return client;
}
