/**
 * The thin layer over Airtable's Web API: one header, two hosts, one error
 * shape, one pagination convention — and the operations the tools call.
 *
 *   AUTH is `Authorization: Bearer <personal access token>`.
 *
 *   ERRORS come back as `{"error":{"type":"…","message":"…"}}`, or as a bare
 *   `{"error":"NOT_FOUND"}` on some 404s. Both are read; anything else (a proxy's
 *   HTML page) falls back to the status and a capped excerpt.
 *
 *   PAGINATION is an opaque `offset` cursor, pages of at most 100 records.
 *   Nothing here walks an unbounded number of pages: every list stops at the
 *   caller's bound and hands the cursor back, so a 50,000-row table costs the
 *   caller one page per call rather than one tool call that never returns.
 *
 *   THE RATE LIMIT is 5 requests per second per base, with a 30 second penalty
 *   after a 429. Surfaced as a retryable `RateLimitError`, not slept through —
 *   except past the first page of a list, where the records already fetched are
 *   returned with the cursor to resume rather than thrown away.
 *
 *   A LONG FORMULA cannot ride in a GET: Airtable caps a URL at 16,000
 *   characters. Past `MAX_GET_URL_LENGTH` a list goes as `POST …/listRecords`
 *   with the same parameters in a JSON body — still a read.
 *
 * @see https://airtable.com/developers/web/api/introduction
 */

import { API_BASE_URL, CONTENT_BASE_URL } from "./config.js";
import {
  AirtableApiError,
  InputError,
  RateLimitError,
  TransportError,
} from "./errors.js";
import { logWarning, scrubSecret } from "./logging.js";

/** Airtable's ceiling on `pageSize` for records and comments. */
export const PAGE_SIZE = 100;

/** Every request gets this long before it is abandoned. */
export const REQUEST_TIMEOUT_MS = 30_000;

/** What Airtable asks a client to wait after a 429, when it does not say. */
export const RATE_LIMIT_PENALTY_SECONDS = 30;

/**
 * The longest list URL sent as a GET. Airtable refuses past 16,000 characters;
 * the margin is for the host and anything a proxy adds.
 */
export const MAX_GET_URL_LENGTH = 15_000;

/** How much of an upstream error body reaches a caller. */
const ERROR_EXCERPT = 300;

export interface AirtableRecord {
  id: string;
  /** When Airtable sends it — every record read and write does. */
  createdTime?: string;
  fields: Record<string, unknown>;
}

export interface FieldSchema {
  id: string;
  name: string;
  type: string;
  description?: string;
  options?: unknown;
}

export interface ViewSchema {
  id: string;
  name: string;
  type?: string;
}

export interface TableSchema {
  id: string;
  name: string;
  description?: string;
  primaryFieldId?: string;
  fields: FieldSchema[];
  views: ViewSchema[];
}

export interface Comment {
  id: string;
  createdTime: string;
  lastUpdatedTime: string | null;
  text: string;
  author: { id: string; email: string; name?: string };
  parentCommentId?: string;
}

export interface SortSpec {
  field: string;
  direction?: "asc" | "desc";
}

export interface ListRecordsOptions {
  view?: string;
  filterByFormula?: string;
  sort?: SortSpec[];
  /** Field names or IDs to return; every field when omitted. */
  fields?: string[];
  /** The most records this call returns, across however many pages that is. */
  maxRecords: number;
  /** A cursor from a previous call, to continue where it stopped. */
  offset?: string;
}

export interface RecordPage {
  records: AirtableRecord[];
  /** Present when more records match; pass it back as `offset` to continue. */
  offset?: string;
  /**
   * Set when a page after the first failed in a way worth waiting out. The
   * records are what came before it; `offset` resumes at the page that failed.
   */
  stoppedEarly?: "rate_limited" | "transport_error";
  /** With `rate_limited`: how long Airtable asked to be left alone. */
  retryAfterSeconds?: number;
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  query?: URLSearchParams;
  body?: unknown;
  /** `content` is the attachment-upload host; everything else is `api`. */
  host?: "api" | "content";
  /** The token scope this call needs — named in a 403's hint. */
  scope?: string;
}

export interface CreateClientOptions {
  apiKey: string;
  fetch?: typeof fetch;
  baseUrl?: string;
  contentBaseUrl?: string;
  timeoutMs?: number;
}

/** A path segment. Table names carry spaces and slashes; IDs pass unchanged. */
const seg = encodeURIComponent;

/** Airtable's error document, defensively. */
function parseError(text: string): { type?: string; message?: string } {
  try {
    const body = JSON.parse(text) as { error?: unknown };
    if (typeof body.error === "string") return { type: body.error };
    if (body.error && typeof body.error === "object") {
      const e = body.error as { type?: unknown; message?: unknown };
      return {
        ...(typeof e.type === "string" ? { type: e.type } : {}),
        ...(typeof e.message === "string" ? { message: e.message } : {}),
      };
    }
  } catch {
    // Not JSON — a proxy page, an empty body. The status is all there is.
  }
  return {};
}

function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > ERROR_EXCERPT
    ? `${flat.slice(0, ERROR_EXCERPT)}…`
    : flat;
}

/**
 * What a rejected token most likely is. A PAT is `pat<14>.<64 hex>`; the usual
 * mistakes are pasting only the token ID (no dot) or a legacy `key…` API key,
 * which Airtable stopped accepting in 2024. Says nothing about the value itself
 * beyond its shape.
 */
function tokenShapeHints(apiKey: string): string[] {
  const hints: string[] = [];
  if (apiKey.startsWith("key")) {
    hints.push(
      "The token looks like a legacy Airtable API key (it starts with `key`); " +
        "those are no longer accepted — create a personal access token instead.",
    );
  } else if (apiKey.split(".").length !== 2) {
    hints.push(
      "The token does not have the shape of a personal access token " +
        "(`pat…` with exactly one dot) — it may be only the token ID, or truncated.",
    );
  }
  return hints;
}

function hintFor(
  status: number,
  type: string | undefined,
  scope: string | undefined,
  apiKey: string,
): string {
  if (status === 401 || type === "AUTHENTICATION_REQUIRED") {
    return [
      "Airtable rejected the token.",
      ...tokenShapeHints(apiKey),
      "Check it has not expired or been revoked at https://airtable.com/create/tokens. Retrying will not help.",
    ].join(" ");
  }
  if (status === 403) {
    return (
      "Airtable answers the same way for a base, table or record that does not " +
      "exist and for one this token may not touch. Check the IDs (list_bases, " +
      "list_tables), that the token " +
      (scope ? `has the \`${scope}\` scope` : "has the scope this call needs") +
      ", and that it was granted access to this base at " +
      "https://airtable.com/create/tokens."
    );
  }
  if (status === 404) {
    return (
      "Not found. Check the base, table, record or field ID — list_bases and " +
      "list_tables show what this token can see. Record IDs start with `rec`, " +
      "base IDs with `app`."
    );
  }
  if (type === "LIST_RECORDS_ITERATOR_NOT_AVAILABLE") {
    return (
      "The offset expired — Airtable keeps a list cursor alive only briefly. " +
      "Restart without it: repeat the call with no `offset`."
    );
  }
  if (status === 413) {
    return "The request body is too large for Airtable.";
  }
  if (status === 422) {
    return (
      "Airtable refused the request as invalid. For a field error, " +
      "describe_table lists the exact field names, IDs and types; for a formula " +
      "error, check the filterByFormula syntax."
    );
  }
  if (status >= 500) {
    return "Airtable is failing on its side; retrying shortly may succeed.";
  }
  return "";
}

export interface AirtableClient {
  request<T>(path: string, options?: RequestOptions): Promise<T>;
  listBases(offset?: string): Promise<{
    bases: Array<{ id: string; name: string; permissionLevel: string }>;
    offset?: string;
  }>;
  getBaseSchema(baseId: string): Promise<{ tables: TableSchema[] }>;
  findTable(baseId: string, tableIdOrName: string): Promise<TableSchema>;
  listRecords(
    baseId: string,
    tableId: string,
    options: ListRecordsOptions,
  ): Promise<RecordPage>;
  searchRecords(
    baseId: string,
    tableId: string,
    searchTerm: string,
    fieldIds: string[] | undefined,
    options: Omit<ListRecordsOptions, "filterByFormula" | "sort" | "fields">,
  ): Promise<RecordPage & { searchedFieldIds: string[] }>;
  getRecord(
    baseId: string,
    tableId: string,
    recordId: string,
  ): Promise<AirtableRecord>;
  createRecord(
    baseId: string,
    tableId: string,
    fields: Record<string, unknown>,
  ): Promise<AirtableRecord>;
  updateRecords(
    baseId: string,
    tableId: string,
    records: AirtableRecord[],
  ): Promise<AirtableRecord[]>;
  deleteRecords(
    baseId: string,
    tableId: string,
    recordIds: string[],
  ): Promise<Array<{ id: string }>>;
  createTable(
    baseId: string,
    name: string,
    fields: Record<string, unknown>[],
    description?: string,
  ): Promise<Record<string, unknown>>;
  updateTable(
    baseId: string,
    tableId: string,
    updates: { name?: string; description?: string },
  ): Promise<Record<string, unknown>>;
  createField(
    baseId: string,
    tableId: string,
    field: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  updateField(
    baseId: string,
    tableId: string,
    fieldId: string,
    updates: { name?: string; description?: string },
  ): Promise<Record<string, unknown>>;
  createComment(
    baseId: string,
    tableId: string,
    recordId: string,
    text: string,
    parentCommentId?: string,
  ): Promise<Comment>;
  listComments(
    baseId: string,
    tableId: string,
    recordId: string,
    pageSize?: number,
    offset?: string,
  ): Promise<{ comments: Comment[]; offset: string | null }>;
  uploadAttachment(
    baseId: string,
    recordId: string,
    attachmentFieldIdOrName: string,
    file: string,
    filename: string,
    contentType: string,
  ): Promise<AirtableRecord>;
}

/**
 * The field types a text search can run over. Upstream's list, kept so a search
 * that worked against the npx package searches the same columns here.
 */
export const SEARCHABLE_FIELD_TYPES = [
  "singleLineText",
  "multilineText",
  "richText",
  "email",
  "url",
  "phoneNumber",
];

/**
 * `OR(FIND("term", {fld1}), …)`, with the term escaped so it cannot close the
 * string literal and inject formula. `"` and `\` are the two characters that
 * can; both are backslash-escaped, the backslash first in effect because the
 * replacement is a single pass.
 */
export function buildSearchFormula(
  searchTerm: string,
  fieldIds: string[],
): string {
  const escaped = searchTerm.replace(/["\\]/g, "\\$&");
  return `OR(${fieldIds.map((id) => `FIND("${escaped}", {${id}})`).join(",")})`;
}

interface RawRecord {
  id: string;
  createdTime?: string;
  fields?: Record<string, unknown>;
}

function toRecord(raw: RawRecord): AirtableRecord {
  return {
    id: raw.id,
    ...(typeof raw.createdTime === "string"
      ? { createdTime: raw.createdTime }
      : {}),
    fields: raw.fields ?? {},
  };
}

/** `tbl` + 14, `fld` + 14: what the schema endpoints accept in a path. */
const TABLE_ID_SHAPE = /^tbl[A-Za-z0-9]{14}$/;
const FIELD_ID_SHAPE = /^fld[A-Za-z0-9]{14}$/;

export function createClient(options: CreateClientOptions): AirtableClient {
  const apiKey = options.apiKey;
  const doFetch = options.fetch ?? fetch;
  const apiBase = options.baseUrl ?? API_BASE_URL;
  const contentBase = options.contentBaseUrl ?? CONTENT_BASE_URL;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const scrub = (text: string) => scrubSecret(text, apiKey);

  async function request<T>(
    path: string,
    opts: RequestOptions = {},
  ): Promise<T> {
    const method = opts.method ?? "GET";
    const query = opts.query?.toString();
    const url =
      (opts.host === "content" ? contentBase : apiBase) +
      path +
      (query ? `?${query}` : "");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    let text: string;
    try {
      response = await doFetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
          ...(opts.body === undefined
            ? {}
            : { "Content-Type": "application/json" }),
        },
        ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
        signal: controller.signal,
      });
      text = await response.text();
    } catch (err) {
      if (controller.signal.aborted) {
        throw new TransportError(
          `Airtable did not answer ${method} ${path} within ${Math.round(timeoutMs / 1000)}s. ` +
            `Nothing is known about whether a write landed; read before retrying one.`,
        );
      }
      throw new TransportError(
        scrub(
          `Could not reach Airtable for ${method} ${path}: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    } finally {
      clearTimeout(timer);
    }

    if (response.ok) {
      if (text === "") return {} as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new AirtableApiError(
          `Airtable answered ${method} ${path} with HTTP ${response.status} but a body that is not JSON.`,
          response.status,
        );
      }
    }

    const { type, message } = parseError(text);
    const said =
      `Airtable answered HTTP ${response.status}` +
      (type ? ` ${type}` : "") +
      (message
        ? `: ${excerpt(message)}`
        : type
          ? ""
          : text
            ? `: ${excerpt(text)}`
            : "");

    if (response.status === 429) {
      const header = Number(response.headers.get("retry-after"));
      const wait =
        Number.isFinite(header) && header > 0
          ? header
          : RATE_LIMIT_PENALTY_SECONDS;
      logWarning(`HTTP 429 on ${method} ${path}; asked to wait ${wait}s`);
      throw new RateLimitError(
        scrub(
          `${said}. Airtable allows 5 requests per second per base and asks a ` +
            `client that exceeds it to wait ${wait} seconds. Nothing was done; ` +
            `wait, then retry, and page with larger maxRecords rather than many small calls.`,
        ),
        wait,
      );
    }

    const hint = hintFor(response.status, type, opts.scope, apiKey);
    throw new AirtableApiError(
      scrub(hint ? `${said}. ${hint}` : said),
      response.status,
      type,
      response.status >= 500,
    );
  }

  async function getBaseSchema(baseId: string) {
    const body = await request<{ tables?: TableSchema[] }>(
      `/v0/meta/bases/${seg(baseId)}/tables`,
      { scope: "schema.bases:read" },
    );
    return {
      tables: (body.tables ?? []).map((t) => ({
        ...t,
        fields: t.fields ?? [],
        views: t.views ?? [],
      })),
    };
  }

  async function findTable(baseId: string, tableIdOrName: string) {
    const { tables } = await getBaseSchema(baseId);
    // ID first: an ID is unambiguous, and a table could be NAMED like another's ID.
    const table =
      tables.find((t) => t.id === tableIdOrName) ??
      tables.find((t) => t.name === tableIdOrName);
    if (!table) {
      throw new InputError(
        `Table "${tableIdOrName}" is not in base ${baseId}. Its tables are: ` +
          `${tables.map((t) => `${t.name} (${t.id})`).join(", ") || "none this token can see"}.`,
      );
    }
    return table;
  }

  async function listRecords(
    baseId: string,
    tableId: string,
    opts: ListRecordsOptions,
  ): Promise<RecordPage> {
    const records: AirtableRecord[] = [];
    const path = `/v0/${seg(baseId)}/${seg(tableId)}`;
    let offset = opts.offset;
    let pages = 0;
    // Airtable's own `maxRecords` is deliberately NOT sent: with it, the last
    // page comes back with no cursor, and "were there more?" has no answer.
    // `pageSize` sized to what is left gives the same bound and keeps the cursor.
    for (;;) {
      const pageSize = Math.min(PAGE_SIZE, opts.maxRecords - records.length);
      const q = new URLSearchParams();
      q.set("pageSize", String(pageSize));
      if (opts.view) q.set("view", opts.view);
      if (opts.filterByFormula) q.set("filterByFormula", opts.filterByFormula);
      (opts.sort ?? []).forEach((s, i) => {
        q.set(`sort[${i}][field]`, s.field);
        if (s.direction) q.set(`sort[${i}][direction]`, s.direction);
      });
      for (const f of opts.fields ?? []) q.append("fields[]", f);
      if (offset) q.set("offset", offset);

      // The same parameters, as a body, when they would not fit in a URL.
      const tooLong =
        `${apiBase}${path}?${q.toString()}`.length > MAX_GET_URL_LENGTH;
      let page: { records?: RawRecord[]; offset?: string };
      try {
        page = tooLong
          ? await request(`${path}/listRecords`, {
              method: "POST",
              body: {
                pageSize,
                ...(offset ? { offset } : {}),
                ...(opts.view ? { view: opts.view } : {}),
                ...(opts.filterByFormula
                  ? { filterByFormula: opts.filterByFormula }
                  : {}),
                ...(opts.sort && opts.sort.length > 0
                  ? { sort: opts.sort }
                  : {}),
                ...(opts.fields && opts.fields.length > 0
                  ? { fields: opts.fields }
                  : {}),
              },
              scope: "data.records:read",
            })
          : await request(path, { query: q, scope: "data.records:read" });
      } catch (err) {
        // The FIRST page failing is the call failing: there is nothing to keep.
        // Past it, a wait-it-out failure costs only the page that failed — the
        // records in hand are returned with the cursor that re-asks for it.
        if (pages === 0 || !offset) throw err;
        if (err instanceof RateLimitError) {
          return {
            records,
            offset,
            stoppedEarly: "rate_limited",
            retryAfterSeconds: err.retryAfterSeconds,
          };
        }
        if (err instanceof TransportError) {
          return { records, offset, stoppedEarly: "transport_error" };
        }
        throw err;
      }
      pages += 1;
      const batch = page.records ?? [];
      records.push(...batch.map(toRecord));
      offset = page.offset;
      // An empty page with a cursor would loop; stop and hand the cursor back.
      if (!offset || batch.length === 0 || records.length >= opts.maxRecords)
        break;
    }
    return { records, ...(offset ? { offset } : {}) };
  }

  /** A table's ID, from an ID as given or a name looked up in the schema. */
  async function tableIdFor(
    baseId: string,
    tableIdOrName: string,
  ): Promise<string> {
    return TABLE_ID_SHAPE.test(tableIdOrName)
      ? tableIdOrName
      : (await findTable(baseId, tableIdOrName)).id;
  }

  return {
    request,
    getBaseSchema,
    findTable,
    listRecords,

    async listBases(offset) {
      const q = new URLSearchParams();
      if (offset) q.set("offset", offset);
      const body = await request<{
        bases?: Array<{ id: string; name: string; permissionLevel: string }>;
        offset?: string;
      }>("/v0/meta/bases", { query: q, scope: "schema.bases:read" });
      return {
        bases: (body.bases ?? []).map((b) => ({
          id: b.id,
          name: b.name,
          permissionLevel: b.permissionLevel,
        })),
        ...(body.offset ? { offset: body.offset } : {}),
      };
    },

    async searchRecords(baseId, tableId, searchTerm, fieldIds, opts) {
      const table = await findTable(baseId, tableId);
      const searchable = table.fields.filter((f) =>
        SEARCHABLE_FIELD_TYPES.includes(f.type),
      );
      if (searchable.length === 0) {
        throw new InputError(
          `Table ${table.name} (${table.id}) has no text fields to search ` +
            `(searchable types: ${SEARCHABLE_FIELD_TYPES.join(", ")}). Use ` +
            `list_records with a filterByFormula instead.`,
        );
      }
      let ids = searchable.map((f) => f.id);
      if (fieldIds && fieldIds.length > 0) {
        // Accepts a name as well as an ID; the formula always gets the ID.
        const resolved = fieldIds.map(
          (want) =>
            searchable.find((f) => f.id === want || f.name === want)?.id,
        );
        const invalid = fieldIds.filter((_, i) => resolved[i] === undefined);
        if (invalid.length > 0) {
          throw new InputError(
            `Not searchable text fields of ${table.name}: ${invalid.join(", ")}. ` +
              `Searchable: ${searchable.map((f) => `${f.name} (${f.id})`).join(", ")}.`,
          );
        }
        ids = resolved as string[];
      }
      const page = await listRecords(baseId, table.id, {
        ...opts,
        filterByFormula: buildSearchFormula(searchTerm, ids),
      });
      return { ...page, searchedFieldIds: ids };
    },

    async getRecord(baseId, tableId, recordId) {
      return toRecord(
        await request<RawRecord>(
          `/v0/${seg(baseId)}/${seg(tableId)}/${seg(recordId)}`,
          {
            scope: "data.records:read",
          },
        ),
      );
    },

    async createRecord(baseId, tableId, fields) {
      return toRecord(
        await request<RawRecord>(`/v0/${seg(baseId)}/${seg(tableId)}`, {
          method: "POST",
          // typecast: Airtable converts "2026-01-01" to a date, a new option
          // name to a select choice, and so on — what a model writing values
          // as text needs, and what the npx package sent.
          body: { fields, typecast: true },
          scope: "data.records:write",
        }),
      );
    },

    async updateRecords(baseId, tableId, records) {
      const body = await request<{ records?: RawRecord[] }>(
        `/v0/${seg(baseId)}/${seg(tableId)}`,
        {
          method: "PATCH",
          body: { records, typecast: true },
          scope: "data.records:write",
        },
      );
      return (body.records ?? []).map(toRecord);
    },

    async deleteRecords(baseId, tableId, recordIds) {
      const q = new URLSearchParams();
      for (const id of recordIds) q.append("records[]", id);
      const body = await request<{ records?: Array<{ id: string }> }>(
        `/v0/${seg(baseId)}/${seg(tableId)}`,
        { method: "DELETE", query: q, scope: "data.records:write" },
      );
      return (body.records ?? []).map(({ id }) => ({ id }));
    },

    async createTable(baseId, name, fields, description) {
      return request(`/v0/meta/bases/${seg(baseId)}/tables`, {
        method: "POST",
        body: {
          name,
          ...(description === undefined ? {} : { description }),
          fields,
        },
        scope: "schema.bases:write",
      });
    },

    async updateTable(baseId, tableId, updates) {
      return request(`/v0/meta/bases/${seg(baseId)}/tables/${seg(tableId)}`, {
        method: "PATCH",
        body: updates,
        scope: "schema.bases:write",
      });
    },

    // The two field endpoints take a table ID and a field ID, never a name —
    // a name in that path is a 404 that reads like a missing table. A name is
    // looked up in the base schema first, one extra read, as search does.
    async createField(baseId, tableId, field) {
      const table = await tableIdFor(baseId, tableId);
      return request(
        `/v0/meta/bases/${seg(baseId)}/tables/${seg(table)}/fields`,
        {
          method: "POST",
          body: field,
          scope: "schema.bases:write",
        },
      );
    },

    async updateField(baseId, tableId, fieldId, updates) {
      let table = tableId;
      let field = fieldId;
      if (!TABLE_ID_SHAPE.test(tableId) || !FIELD_ID_SHAPE.test(fieldId)) {
        const schema = await findTable(baseId, tableId);
        // ID first, as findTable does: a field could be NAMED like another's ID.
        const found =
          schema.fields.find((f) => f.id === fieldId) ??
          schema.fields.find((f) => f.name === fieldId);
        if (!found) {
          throw new InputError(
            `Field "${fieldId}" is not in table ${schema.name} (${schema.id}). Its ` +
              `fields are: ${schema.fields.map((f) => `${f.name} (${f.id})`).join(", ") || "none"}.`,
          );
        }
        table = schema.id;
        field = found.id;
      }
      return request(
        `/v0/meta/bases/${seg(baseId)}/tables/${seg(table)}/fields/${seg(field)}`,
        { method: "PATCH", body: updates, scope: "schema.bases:write" },
      );
    },

    async createComment(baseId, tableId, recordId, text, parentCommentId) {
      return request<Comment>(
        `/v0/${seg(baseId)}/${seg(tableId)}/${seg(recordId)}/comments`,
        {
          method: "POST",
          body: { text, ...(parentCommentId ? { parentCommentId } : {}) },
          scope: "data.recordComments:write",
        },
      );
    },

    async listComments(baseId, tableId, recordId, pageSize, offset) {
      const q = new URLSearchParams();
      if (pageSize !== undefined) q.set("pageSize", String(pageSize));
      if (offset) q.set("offset", offset);
      const body = await request<{
        comments?: Comment[];
        offset?: string | null;
      }>(`/v0/${seg(baseId)}/${seg(tableId)}/${seg(recordId)}/comments`, {
        query: q,
        scope: "data.recordComments:read",
      });
      return { comments: body.comments ?? [], offset: body.offset ?? null };
    },

    async uploadAttachment(
      baseId,
      recordId,
      field,
      file,
      filename,
      contentType,
    ) {
      return toRecord(
        await request<RawRecord>(
          `/v0/${seg(baseId)}/${seg(recordId)}/${seg(field)}/uploadAttachment`,
          {
            method: "POST",
            host: "content",
            body: { contentType, file, filename },
            scope: "data.records:write",
          },
        ),
      );
    },
  };
}
