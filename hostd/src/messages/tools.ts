import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type { Config } from "../config.js";
import { defineTool, json, type Capability } from "../mcp/tool.js";
import type { HelperClient } from "../native/client.js";
import { ChatDb, type QueryResult } from "./chatdb.js";

/** What `strad-hostd-messages` answers to `hello`. */
export interface MessagesHello {
  version: string;
  pid: number;
  executable: string;
  chat_db: {
    path: string;
    state: "readable" | "denied" | "missing" | "error";
    error?: string;
  };
  full_disk_access: boolean;
}

/** What its `read_attachment` op answers. */
interface AttachmentBytes {
  file_name: string;
  mime_type: string | null;
  original_mime_type?: string | null;
  converted: boolean;
  size_bytes: number;
  data_base64: string;
}

const DEFAULT_MESSAGES = 50;
const MAX_MESSAGES = 200;
const DEFAULT_CHATS = 30;
const MAX_CHATS = 200;
/** The helper's own ceiling on one query's rows. */
const MAX_QUERY_ROWS = 5000;

/** Image types a model reads as an image. Anything else comes back as a file. */
const IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

const CHAT_ID_DESCRIPTION =
  'A chat_id from imessage_list_chats, e.g. "iMessage;-;+15551234567" for a one-to-one chat or ' +
  '"iMessage;+;chat123456789012345678" for a group. Omit it to read every chat at once.';

/** Why the server cannot work right now, in the words the owner needs; undefined when it can. */
export function messagesBlocked(hello: MessagesHello): string | undefined {
  switch (hello.chat_db.state) {
    case "readable":
      return undefined;
    case "denied":
      return `strad-hostd-messages does not have Full Disk Access, so it cannot read ${hello.chat_db.path}. Its owner adds ${hello.executable} under System Settings › Privacy & Security › Full Disk Access (\`strad-hostd messages --grant\` opens both)`;
    case "missing":
      return `${hello.chat_db.path} does not exist: Messages has not been set up for this user on this Mac`;
    default:
      return `strad-hostd-messages cannot open ${hello.chat_db.path}: ${hello.chat_db.error ?? "unknown error"}`;
  }
}

/**
 * The `messages` server: the owner's iMessage and SMS history, read from the
 * Messages database through `strad-hostd-messages`. Three tools, none of which
 * writes anything anywhere. There is no send tool; posting as the owner would
 * be a separate server and a separate slug.
 */
export function messagesCapability(
  config: Config,
  helper: HelperClient,
): Capability {
  const db = new ChatDb(async (sql, params, decode) => {
    const result = await helper.call<QueryResult>("query", {
      sql,
      params,
      ...(decode ? { decode } : {}),
      max_rows: MAX_QUERY_ROWS,
    });
    // Every query here is bounded well under this; one that is not would
    // lose rows without a word, so it fails instead.
    if (result.truncated)
      throw new Error(
        `a query returned more than ${MAX_QUERY_ROWS} rows; ask for fewer`,
      );
    return result;
  });

  const listChats = defineTool({
    name: "imessage_list_chats",
    description: `List the owner's Messages conversations (iMessage, SMS and RCS), the most recently active first. Use it to find a chat_id for imessage_get_messages, or to see who has written lately.

**Returns:**
{"chats":[{"chat_id":"iMessage;+;chat123456789012345678","name":"Wedding planning","identifier":"chat123456789012345678","service":"iMessage","is_group":true,"participants":["+15551234567","grace@example.com"],"last_rowid":48211,"last_message_at":"2026-10-08T19:02:11.000Z"}]}
"name" is the group's name if it was given one, else null. Participants are phone numbers and email addresses: the Messages database holds no contact names. "last_rowid" is the ROWID of the chat's newest message, comparable with imessage_get_messages' cursor.

**Use cases:**
- Find the chat_id of a person or a group by name, number or email (search)
- See which conversations have new messages since a ROWID you stored
- Orient before reading: who has written recently, and in which chats

Reads only what is on this Mac. With Messages in iCloud, a Mac that was asleep catches up when it wakes; until then the newest messages may be missing here.`,
    schema: z.object({
      search: z.string().min(1).max(200).optional(),
      limit: z.number().int().min(1).max(MAX_CHATS).optional(),
    }),
    inputSchema: {
      type: "object",
      properties: {
        search: {
          type: "string",
          description:
            'Only chats whose name, identifier or a participant\'s number or email contains this, case-insensitively, e.g. "Wedding" or "+1555123". Omit for all chats.',
        },
        limit: {
          type: "integer",
          description: `How many chats (1-${MAX_CHATS}). Default: ${DEFAULT_CHATS}.`,
          minimum: 1,
          maximum: MAX_CHATS,
        },
      },
    },
    annotations: {
      title: "List Messages chats",
      readOnlyHint: true,
      openWorldHint: false,
    },
    summarize: (a) =>
      `imessage_list_chats${a.search ? ` search=${JSON.stringify(a.search)}` : ""}`,
    handler: async (a) =>
      json({
        chats: await db.chats({
          limit: a.limit ?? DEFAULT_CHATS,
          search: a.search,
        }),
      }),
  });

  const getMessages = defineTool({
    name: "imessage_get_messages",
    description: `Read messages from one chat or from every chat at once, in the order this Mac stored them (by rowid), earliest stored first. Reading marks nothing as read and sends nothing.

**Paging forward (a sweep).** Every message row has a "rowid" that only ever grows. With after_rowid you get the first \`limit\` messages whose rowid is STRICTLY greater, and has_more: true if there were more; pass the returned next_after_rowid back to continue. Store next_after_rowid between runs and a periodic sweep sees every message row exactly once — no timestamps, no de-duplication. Two things it does not see: an edit or unsend made later to a message it already read (the row changes; its rowid does not), and true chronological order — messages a woken Mac syncs from iCloud get new rowids, so sent_at can go backwards across a page.

**Without a cursor, and paging back.** With no after_rowid you get the newest \`limit\` messages, earliest first, with next_after_rowid to sweep forward from — and here has_more means OLDER messages exist. Pass next_before_rowid as before_rowid to read further back: you get the \`limit\` messages just before it, has_more again meaning older ones exist. after_rowid and before_rowid cannot be combined.

**Returns:**
{"messages":[{"rowid":48211,"guid":"5D0C…","chat_id":"iMessage;+;chat123456789012345678","chat_name":"Wedding planning","sent_at":"2026-10-08T19:02:11.000Z","from_me":false,"sender":"+15551234567","service":"iMessage","kind":"message","text":"Can we move the tasting to Friday?","attachments":[{"attachment_id":9120,"file_name":"IMG_0412.HEIC","mime_type":"image/heic","size_bytes":1840211}]}],"has_more":false,"next_after_rowid":48211,"next_before_rowid":48211}
next_before_rowid is present when you read without a cursor or with before_rowid.

- kind: "message" (text, attachments, or both), "reaction" (a tapback: "reaction":{"type":"love"|"like"|"dislike"|"laugh"|"emphasize"|"question"|"emoji"|"sticker"|"other","removed":false,"target_guid":"<guid of the message reacted to>"}), or "system" (a group renamed, someone added or left).
- sender is the other party's phone number or email; null when from_me is true. There are no contact names.
- reply_to_guid is set on a reply in a thread; edited and unsent appear when true (as of this read).
- chat_id is null only for a message Messages has not joined to a chat.
- text is null for a message that is only an attachment. Fetch one with imessage_get_attachment and its attachment_id.
- A "warning" field appears when after_rowid is past every message: the database was rebuilt, and the cursor has to start again.

**Use cases:**
- A nightly sweep: imessage_get_messages with the after_rowid stored last time, until has_more is false
- Read the recent history of one conversation (chat_id, no cursor), then further back with before_rowid
- Catch up on everything since a known point, across all chats

This Mac's copy is only as fresh as the Mac: asleep, it receives nothing until it wakes and Messages in iCloud catches it up.`,
    schema: z
      .object({
        chat_id: z.string().min(1).max(512).optional(),
        after_rowid: z.number().int().min(0).optional(),
        before_rowid: z.number().int().min(1).optional(),
        limit: z.number().int().min(1).max(MAX_MESSAGES).optional(),
      })
      .refine(
        (a) => a.after_rowid === undefined || a.before_rowid === undefined,
        {
          message: "pass after_rowid OR before_rowid, not both",
        },
      ),
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: "string", description: CHAT_ID_DESCRIPTION },
        after_rowid: {
          type: "integer",
          minimum: 0,
          description:
            "Return messages with a rowid STRICTLY greater than this, earliest stored first: the next_after_rowid of your previous call. Omit for the newest messages. 0 reads from the very beginning.",
        },
        before_rowid: {
          type: "integer",
          minimum: 1,
          description:
            "Return the `limit` messages with a rowid STRICTLY less than this, earliest first: the next_before_rowid of your previous call, to page back through history. Not with after_rowid.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: MAX_MESSAGES,
          description: `How many messages (1-${MAX_MESSAGES}). Default: ${DEFAULT_MESSAGES}.`,
        },
      },
    },
    annotations: {
      title: "Read Messages",
      readOnlyHint: true,
      openWorldHint: false,
    },
    summarize: (a) =>
      `imessage_get_messages${a.chat_id ? " chat" : " all chats"}${a.after_rowid !== undefined ? ` after_rowid=${a.after_rowid}` : ""}${a.before_rowid !== undefined ? ` before_rowid=${a.before_rowid}` : ""}`,
    handler: async (a) => {
      const { messages, hasMore } = await db.messages({
        chatId: a.chat_id,
        after: a.after_rowid,
        before: a.before_rowid,
        limit: a.limit ?? DEFAULT_MESSAGES,
      });
      const newestRow = messages.at(-1)?.rowid;
      const forward = a.after_rowid !== undefined;
      const newest =
        messages.length === 0 && a.after_rowid !== undefined
          ? await db.newestRowid()
          : undefined;
      return json({
        messages,
        has_more: hasMore,
        next_after_rowid: forward
          ? (newestRow ?? a.after_rowid!)
          : a.before_rowid === undefined
            ? (newestRow ?? 0)
            : undefined,
        // Paging back: the cursor for the page before this one.
        ...(!forward
          ? { next_before_rowid: messages[0]?.rowid ?? a.before_rowid ?? 0 }
          : {}),
        // A cursor past every message means the database was rebuilt (a
        // restore, or Messages in iCloud re-syncing from scratch) and its
        // ROWIDs started again. Waiting would never see a message.
        ...(newest !== undefined && a.after_rowid! > newest
          ? {
              warning: `after_rowid ${a.after_rowid} is past the newest message on this Mac (${newest}): its Messages database was rebuilt and numbering restarted. Read again with after_rowid 0, or omit it, and de-duplicate by guid against what you already have.`,
            }
          : {}),
      });
    },
  });

  const getAttachment = defineTool({
    name: "imessage_get_attachment",
    description: `Fetch one attachment's contents by the attachment_id imessage_get_messages lists. Photos come back as an image you can see: HEIC, HEIF and TIFF are converted to JPEG on the Mac first. Anything else — a PDF, a voice memo, a contact card — comes back as an embedded file with its MIME type.

**Returns** a text item, then the content:
{"attachment_id":9120,"file_name":"IMG_0412.HEIC","mime_type":"image/jpeg","original_mime_type":"image/heic","converted":true,"size_bytes":412330}

**Errors** name one of: not_found (no such attachment_id), file_missing (not on this Mac — with Messages in iCloud, older attachments stay in iCloud until the conversation is opened in Messages), too_large (over ${Math.round(config.messages.maxAttachmentBytes / 1024 / 1024)} MB after conversion), convert_failed.

**Use cases:**
- Read a document someone sent (a contract, a ticket, a PDF invoice)
- Look at a photo or screenshot in a conversation
- Check what a message with no text actually contained`,
    schema: z.object({
      attachment_id: z.number().int().min(1),
    }),
    inputSchema: {
      type: "object",
      properties: {
        attachment_id: {
          type: "integer",
          minimum: 1,
          description:
            'An attachment_id from a message\'s "attachments" in imessage_get_messages, e.g. 9120.',
        },
      },
      required: ["attachment_id"],
    },
    annotations: {
      title: "Get a Messages attachment",
      readOnlyHint: true,
      openWorldHint: false,
    },
    summarize: (a) => `imessage_get_attachment ${a.attachment_id}`,
    handler: async (a): Promise<CallToolResult> => {
      const file = await helper.call<AttachmentBytes>(
        "read_attachment",
        {
          attachment_id: a.attachment_id,
          convert: true,
          max_bytes: config.messages.maxAttachmentBytes,
        },
        // A conversion is a `sips` run on a large photo.
        Math.max(config.native.requestTimeoutMs, 60_000),
      );
      const meta = {
        attachment_id: a.attachment_id,
        file_name: file.file_name,
        mime_type: file.mime_type,
        ...(file.converted
          ? { original_mime_type: file.original_mime_type ?? null }
          : {}),
        converted: file.converted,
        size_bytes: file.size_bytes,
      };
      const mime = file.mime_type ?? "application/octet-stream";
      return {
        content: [
          { type: "text", text: JSON.stringify(meta, null, 2) },
          IMAGE_TYPES.has(mime)
            ? { type: "image", data: file.data_base64, mimeType: mime }
            : {
                type: "resource",
                resource: {
                  uri: `imessage-attachment:${a.attachment_id}`,
                  mimeType: mime,
                  blob: file.data_base64,
                },
              },
        ],
      };
    },
  });

  const hello = () => helper.call<MessagesHello>("hello", {}, 5000);

  return {
    tools: [listChats, getMessages, getAttachment],
    preflight: async () => {
      try {
        return messagesBlocked(await hello());
      } catch (err) {
        return `strad-hostd-messages is not running on this Mac (${(err as Error).message})`;
      }
    },
    status: async () => {
      try {
        const h = await hello();
        return {
          helper: {
            running: true,
            full_disk_access: h.full_disk_access,
            chat_db: h.chat_db.state,
          },
        };
      } catch {
        return { helper: { running: false } };
      }
    },
    close: () => helper.close(),
  };
}
