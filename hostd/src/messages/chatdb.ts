/**
 * What the `messages` server knows about `~/Library/Messages/chat.db`.
 *
 * The SQL lives HERE, not in the Swift helper, so it is tested against a
 * fixture database on Linux (`test/messages.test.ts`). The helper's part is
 * narrower and is what makes this safe to hand it: it opens the file
 * read-only, refuses any statement SQLite does not call read-only, and decodes
 * the `attributedBody` column it is asked to (`hostd/messages/Sources/strad-hostd-messages/ChatDB.swift`).
 *
 * The schema is Apple's and undocumented, and it grows a column now and then.
 * Every column beyond the handful every macOS release has had is looked up
 * first and read as NULL where it is missing, so a database from an older or a
 * newer macOS answers rather than failing on "no such column".
 */

/** One request to the helper's `query` op. */
export type QueryFn = (
  sql: string,
  params: (string | number | null)[],
  decode?: string[],
) => Promise<QueryResult>;

export interface QueryResult {
  columns: string[];
  rows: unknown[][];
  truncated: boolean;
}

/** Rows as objects keyed by column name. */
export function records(result: QueryResult): Record<string, unknown>[] {
  return result.rows.map((row) =>
    Object.fromEntries(result.columns.map((c, i) => [c, row[i]])),
  );
}

/**
 * Seconds since 1970 from `message.date`. macOS 10.13 and later store
 * nanoseconds since 2001-01-01; earlier releases stored seconds. Converted in
 * SQL because a nanosecond count is past 2^53 and would lose precision on its
 * way through JSON.
 */
export function unixSeconds(column: string): string {
  return `(CASE WHEN ${column} > 100000000000 THEN ${column} / 1000000000 ELSE ${column} END + 978307200)`;
}

/** Columns of `message` read when present, NULL otherwise. */
const OPTIONAL_MESSAGE_COLUMNS = [
  "text",
  "attributedBody",
  "service",
  "cache_has_attachments",
  "associated_message_type",
  "associated_message_guid",
  "associated_message_emoji",
  "thread_originator_guid",
  "date_edited",
  "date_retracted",
  "item_type",
  "group_title",
] as const;

/** The tapback a reaction row carries, by `associated_message_type`. */
const REACTIONS: Record<number, string> = {
  2000: "love",
  2001: "like",
  2002: "dislike",
  2003: "laugh",
  2004: "emphasize",
  2005: "question",
  2006: "emoji",
  2007: "sticker",
};

export interface Attachment {
  attachment_id: number;
  file_name: string | null;
  mime_type: string | null;
  size_bytes: number | null;
}

export interface Message {
  rowid: number;
  guid: string;
  /** Null only for a message Messages has not joined to a chat. */
  chat_id: string | null;
  chat_name: string | null;
  sent_at: string;
  from_me: boolean;
  /** The other party's phone number or email; null for the owner's own messages. */
  sender: string | null;
  service: string | null;
  kind: "message" | "reaction" | "system";
  text: string | null;
  reaction?: {
    type: string;
    emoji?: string;
    removed: boolean;
    target_guid: string | null;
  };
  reply_to_guid?: string;
  edited?: boolean;
  unsent?: boolean;
  attachments: Attachment[];
}

export interface Chat {
  chat_id: string;
  name: string | null;
  identifier: string | null;
  service: string | null;
  is_group: boolean;
  participants: string[];
  last_rowid: number;
  last_message_at: string;
}

const isoFromUnix = (s: unknown): string =>
  new Date(Number(s) * 1000).toISOString();

/**
 * The body as a person would read it. `￼` is the placeholder Messages
 * puts where an attachment sits in the text; the attachment itself is listed
 * separately.
 */
export function cleanText(text: unknown): string | null {
  if (typeof text !== "string") return null;
  const cleaned = text.replace(/￼/g, "").trim();
  return cleaned.length > 0 ? cleaned : null;
}

/** `p:0/<guid>` and `bp:<guid>` both name the message a reaction is on. */
export function targetGuid(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  const slash = raw.indexOf("/");
  if (slash >= 0) return raw.slice(slash + 1);
  return raw.startsWith("bp:") ? raw.slice(3) : raw;
}

export class ChatDb {
  private messageColumns?: Set<string>;

  constructor(private readonly query: QueryFn) {}

  /** The columns `message` has on this Mac. Read once per daemon. */
  private async columns(): Promise<Set<string>> {
    if (!this.messageColumns) {
      const r = await this.query(
        "SELECT name FROM pragma_table_info('message')",
        [],
      );
      this.messageColumns = new Set(r.rows.map((row) => String(row[0])));
    }
    return this.messageColumns;
  }

  private async messageSelect(): Promise<string> {
    const have = await this.columns();
    const optional = OPTIONAL_MESSAGE_COLUMNS.map((c) =>
      have.has(c) ? `m.${c} AS ${c}` : `NULL AS ${c}`,
    );
    return [
      "m.ROWID AS rowid",
      "m.guid AS guid",
      "m.is_from_me AS is_from_me",
      "h.id AS sender",
      `${unixSeconds("m.date")} AS unix`,
      ...optional,
      "c.guid AS chat_id",
      "c.display_name AS chat_name",
    ].join(", ");
  }

  /**
   * Messages strictly after `after` by ROWID, oldest first; or with no
   * `after`, the newest `limit`, still oldest first. ROWID only ever grows, so
   * it is an exact cursor: a reader that passes back the last one it saw
   * never skips a message and never sees one twice.
   */
  async messages(opts: {
    chatId?: string;
    after?: number;
    before?: number;
    limit: number;
  }): Promise<{ messages: Message[]; hasMore: boolean }> {
    const select = await this.messageSelect();
    const params: (string | number | null)[] = [];
    // A message is in one chat; the join table allows more. Filtered by chat,
    // join that chat. Unfiltered, take the message's lowest-numbered chat, so
    // a message never comes back twice — and LEFT JOIN it, so a message whose
    // chat row is not there (yet, or at all) is returned with chat_id null
    // rather than skipped: a cursor that walked past a skipped row would never
    // come back for it.
    let from: string;
    if (opts.chatId !== undefined) {
      from =
        "FROM message m JOIN chat_message_join cmj ON cmj.message_id = m.ROWID " +
        "JOIN chat c ON c.ROWID = cmj.chat_id AND c.guid = ?";
      params.push(opts.chatId);
    } else {
      from =
        "FROM message m LEFT JOIN chat c ON c.ROWID = " +
        "(SELECT MIN(cmj.chat_id) FROM chat_message_join cmj WHERE cmj.message_id = m.ROWID)";
    }
    const where: string[] = [];
    if (opts.after !== undefined) {
      where.push("m.ROWID > ?");
      params.push(opts.after);
    }
    if (opts.before !== undefined) {
      where.push("m.ROWID < ?");
      params.push(opts.before);
    }
    const order = opts.after !== undefined ? "ASC" : "DESC";
    params.push(opts.limit + 1);
    const sql =
      `SELECT ${select} ${from} LEFT JOIN handle h ON h.ROWID = m.handle_id` +
      (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
      ` ORDER BY m.ROWID ${order} LIMIT ?`;
    const rows = records(await this.query(sql, params, ["attributedBody"]));
    const hasMore = rows.length > opts.limit;
    const page = rows.slice(0, opts.limit);
    if (order === "DESC") page.reverse();

    const withFiles = page
      .filter((r) => Number(r.cache_has_attachments ?? 0) !== 0)
      .map((r) => Number(r.rowid));
    const files = await this.attachments(withFiles);
    return {
      messages: page.map((r) => toMessage(r, files.get(Number(r.rowid)) ?? [])),
      hasMore,
    };
  }

  private async attachments(ids: number[]): Promise<Map<number, Attachment[]>> {
    const out = new Map<number, Attachment[]>();
    if (ids.length === 0) return out;
    const r = records(
      await this.query(
        "SELECT maj.message_id AS message_id, a.ROWID AS attachment_id, a.transfer_name AS transfer_name, " +
          "a.filename AS filename, a.mime_type AS mime_type, a.total_bytes AS total_bytes " +
          "FROM message_attachment_join maj JOIN attachment a ON a.ROWID = maj.attachment_id " +
          `WHERE maj.message_id IN (${ids.map(() => "?").join(", ")}) ORDER BY a.ROWID`,
        ids,
      ),
    );
    for (const row of r) {
      const list = out.get(Number(row.message_id)) ?? [];
      const filename =
        typeof row.filename === "string" ? row.filename : undefined;
      list.push({
        attachment_id: Number(row.attachment_id),
        file_name:
          (typeof row.transfer_name === "string" && row.transfer_name) ||
          (filename ? (filename.split("/").pop() ?? null) : null),
        mime_type: typeof row.mime_type === "string" ? row.mime_type : null,
        size_bytes:
          typeof row.total_bytes === "number" ? row.total_bytes : null,
      });
      out.set(Number(row.message_id), list);
    }
    return out;
  }

  /** The highest ROWID in `message`: 0 for an empty database. */
  /**
   * The highest ROWID `message` has ever handed out. `sqlite_sequence`
   * remembers it after the newest row is deleted, which `MAX(ROWID)` does
   * not — and a cursor sitting on a deleted message is not a rebuilt
   * database. `MAX(ROWID)` is the fallback for a table without AUTOINCREMENT.
   */
  async newestRowid(): Promise<number> {
    const hasSequence = await this.query(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'",
      [],
    );
    const r = await this.query(
      hasSequence.rows.length > 0
        ? "SELECT MAX(n) FROM (SELECT seq AS n FROM sqlite_sequence WHERE name = 'message' UNION ALL SELECT MAX(ROWID) FROM message)"
        : "SELECT MAX(ROWID) FROM message",
      [],
    );
    return Number(r.rows[0]?.[0] ?? 0);
  }

  /** Chats with at least one message, the most recently active first. */
  async chats(opts: { limit: number; search?: string }): Promise<Chat[]> {
    const params: (string | number | null)[] = [];
    let filter = "";
    if (opts.search) {
      const like = `%${opts.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      filter =
        " WHERE (c.display_name LIKE ? ESCAPE '\\' OR c.chat_identifier LIKE ? ESCAPE '\\' OR EXISTS (" +
        "SELECT 1 FROM chat_handle_join chj JOIN handle h ON h.ROWID = chj.handle_id " +
        "WHERE chj.chat_id = c.ROWID AND h.id LIKE ? ESCAPE '\\'))";
      params.push(like, like, like);
    }
    params.push(opts.limit);
    const rows = records(
      await this.query(
        "SELECT c.ROWID AS id, c.guid AS chat_id, c.chat_identifier AS identifier, c.display_name AS name, " +
          `c.service_name AS service, c.style AS style, last.message_id AS last_rowid, ${unixSeconds("lm.date")} AS last_unix ` +
          "FROM chat c JOIN (SELECT chat_id, MAX(message_id) AS message_id FROM chat_message_join GROUP BY chat_id) last " +
          "ON last.chat_id = c.ROWID JOIN message lm ON lm.ROWID = last.message_id" +
          filter +
          " ORDER BY last.message_id DESC LIMIT ?",
        params,
      ),
    );
    const ids = rows.map((r) => Number(r.id));
    const people = new Map<number, string[]>();
    if (ids.length > 0) {
      const p = records(
        await this.query(
          "SELECT chj.chat_id AS chat_id, h.id AS handle FROM chat_handle_join chj " +
            "JOIN handle h ON h.ROWID = chj.handle_id " +
            `WHERE chj.chat_id IN (${ids.map(() => "?").join(", ")}) ORDER BY h.id`,
          ids,
        ),
      );
      for (const row of p) {
        const list = people.get(Number(row.chat_id)) ?? [];
        list.push(String(row.handle));
        people.set(Number(row.chat_id), list);
      }
    }
    return rows.map((r) => {
      const participants = people.get(Number(r.id)) ?? [];
      return {
        chat_id: String(r.chat_id),
        name: cleanText(r.name),
        identifier: typeof r.identifier === "string" ? r.identifier : null,
        service: typeof r.service === "string" ? r.service : null,
        // 43 is a group and 45 a one-to-one chat; the participant count is
        // the fallback for a row with neither.
        is_group:
          r.style === 43
            ? true
            : r.style === 45
              ? false
              : participants.length > 1,
        participants,
        last_rowid: Number(r.last_rowid),
        last_message_at: isoFromUnix(r.last_unix),
      };
    });
  }
}

function toMessage(
  r: Record<string, unknown>,
  attachments: Attachment[],
): Message {
  const fromMe = Number(r.is_from_me) === 1;
  const assoc = Number(r.associated_message_type ?? 0);
  const itemType = Number(r.item_type ?? 0);
  const text = cleanText(r.text) ?? cleanText(r.attributedBody);
  const kind: Message["kind"] =
    itemType !== 0
      ? "system"
      : assoc >= 2000 && assoc < 4000
        ? "reaction"
        : "message";
  const m: Message = {
    rowid: Number(r.rowid),
    guid: String(r.guid),
    chat_id: typeof r.chat_id === "string" ? r.chat_id : null,
    chat_name: cleanText(r.chat_name),
    sent_at: isoFromUnix(r.unix),
    from_me: fromMe,
    sender: fromMe ? null : typeof r.sender === "string" ? r.sender : null,
    service: typeof r.service === "string" ? r.service : null,
    kind,
    text: kind === "system" ? (text ?? cleanText(r.group_title)) : text,
    attachments,
  };
  if (kind === "reaction") {
    const removed = assoc >= 3000;
    const base = removed ? assoc - 1000 : assoc;
    m.reaction = {
      type: REACTIONS[base] ?? "other",
      ...(typeof r.associated_message_emoji === "string"
        ? { emoji: r.associated_message_emoji }
        : {}),
      removed,
      target_guid: targetGuid(r.associated_message_guid),
    };
  }
  if (typeof r.thread_originator_guid === "string" && r.thread_originator_guid)
    m.reply_to_guid = r.thread_originator_guid;
  // Unsending also stamps date_edited; an unsent message is not "edited".
  if (Number(r.date_retracted ?? 0) > 0) m.unsent = true;
  else if (Number(r.date_edited ?? 0) > 0) m.edited = true;
  return m;
}
