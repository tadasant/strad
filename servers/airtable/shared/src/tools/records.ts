import type { RecordPage, SortSpec } from "../client.js";
import { InputError } from "../errors.js";
import {
  args,
  BASE_ID,
  boundedInt,
  guard,
  OFFSET,
  ok,
  optionalString,
  plainObject,
  READ,
  RECORD_ID,
  requiredString,
  requiredText,
  stringArray,
  TABLE_ID,
  VIEW,
  type ClientFactory,
  type ToolDefinition,
} from "./shared.js";

/**
 * The record tools. Reads are BOUNDED: `maxRecords` defaults to 100 (one
 * Airtable page) and is clamped at 1000 (ten), and a read that stopped short
 * says so with the cursor to continue. The npx package these replace walked
 * every page of a table inside one call, which is a context window and a rate
 * budget spent on a question nobody asked.
 */

export const DEFAULT_MAX_RECORDS = 100;
export const MAX_RECORDS_CAP = 1000;
/** Airtable's per-request ceiling on record writes and deletes. */
export const MAX_WRITE_BATCH = 10;

const MAX_RECORDS = {
  type: "integer",
  description: `The most records to return in this call (1-${MAX_RECORDS_CAP}, default ${DEFAULT_MAX_RECORDS}). When more match, the result carries \`offset\` to continue.`,
};

/**
 * The page, plus the facts a caller needs to decide whether to continue — and,
 * when a later page was rate-limited or lost in transit, why it stopped short.
 */
function pageResult(page: RecordPage, extra: Record<string, unknown> = {}) {
  return {
    records: page.records,
    returned: page.records.length,
    more: page.offset !== undefined,
    ...(page.offset !== undefined ? { offset: page.offset } : {}),
    ...(page.stoppedEarly ? { stopped_early: page.stoppedEarly } : {}),
    ...(page.retryAfterSeconds !== undefined
      ? { retry_after_seconds: page.retryAfterSeconds }
      : {}),
    ...extra,
  };
}

function parseSort(raw: Record<string, unknown>): SortSpec[] | undefined {
  const value = raw.sort;
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new InputError(
      '`sort` must be an array, e.g. [{"field":"Due","direction":"asc"}].',
    );
  }
  return value.map((entry, i) => {
    const e = args(entry);
    if (typeof e.field !== "string" || e.field.trim() === "") {
      throw new InputError(`\`sort[${i}].field\` must be a field name or ID.`);
    }
    if (
      e.direction !== undefined &&
      e.direction !== "asc" &&
      e.direction !== "desc"
    ) {
      throw new InputError(`\`sort[${i}].direction\` must be "asc" or "desc".`);
    }
    return {
      field: e.field,
      ...(e.direction ? { direction: e.direction as "asc" | "desc" } : {}),
    };
  });
}

export function listRecordsTool(client: ClientFactory): ToolDefinition {
  return {
    name: "list_records",
    description:
      "List records from an Airtable table, optionally filtered, sorted and " +
      "restricted to a view. Returns at most `maxRecords` (default 100, cap " +
      "1000); when more match, `more` is true and `offset` continues from " +
      "where this call stopped.\n\n" +
      'Example: {"records":[{"id":"recA1b2C3d4E5f6G7","createdTime":' +
      '"2026-10-01T00:00:00.000Z","fields":{"Name":"Launch","Status":"Done"}}],' +
      '"returned":1,"more":true,"offset":"itrX/recY"}\n\n' +
      "If a later page is rate-limited or lost in transit, the records so far " +
      "come back with `stopped_early` (rate_limited or transport_error), " +
      "`retry_after_seconds` when known, and the `offset` to resume from. " +
      "An empty field is ABSENT from `fields`, not null — Airtable omits it. " +
      "`filterByFormula` is an Airtable formula, e.g. `{Status} = 'Done'` or " +
      "`AND({Owner} = 'Ada', IS_AFTER({Due}, TODAY()))`. Use describe_table " +
      "first to get exact field names. Use `fields` to fetch only the columns " +
      "you need from a wide table.",
    inputSchema: {
      type: "object",
      properties: {
        baseId: BASE_ID,
        tableId: TABLE_ID,
        view: VIEW,
        maxRecords: MAX_RECORDS,
        filterByFormula: {
          type: "string",
          description:
            "An Airtable formula; only records where it is truthy are returned.",
        },
        sort: {
          type: "array",
          description:
            "Sort order, first entry first. Overrides the view's order.",
          items: {
            type: "object",
            properties: {
              field: { type: "string", description: "Field name or ID." },
              direction: { type: "string", enum: ["asc", "desc"] },
            },
            required: ["field"],
          },
        },
        fields: {
          type: "array",
          items: { type: "string" },
          description:
            "Only return these fields (names or IDs). Every field when omitted.",
        },
        offset: OFFSET,
      },
      required: ["baseId", "tableId"],
      additionalProperties: false,
    },
    annotations: READ,
    handler: (raw) =>
      guard(async () => {
        const input = args(raw);
        const baseId = requiredString(input, "baseId");
        const tableId = requiredString(input, "tableId");
        const view = optionalString(input, "view");
        const filterByFormula = optionalString(input, "filterByFormula");
        const sort = parseSort(input);
        const fields = stringArray(input, "fields");
        const offset = optionalString(input, "offset");
        const page = await (
          await client()
        ).listRecords(baseId, tableId, {
          maxRecords: boundedInt(
            input,
            "maxRecords",
            DEFAULT_MAX_RECORDS,
            MAX_RECORDS_CAP,
          ),
          ...(view ? { view } : {}),
          ...(filterByFormula ? { filterByFormula } : {}),
          ...(sort ? { sort } : {}),
          ...(fields ? { fields } : {}),
          ...(offset ? { offset } : {}),
        });
        return ok(pageResult(page));
      }),
  };
}

export function searchRecordsTool(client: ClientFactory): ToolDefinition {
  return {
    name: "search_records",
    description:
      "Find records whose text fields contain `searchTerm` (case-sensitive " +
      "substring). Searches every text-like field (single line, long text, rich " +
      "text, email, URL, phone) unless `fieldIds` narrows it. Bounded like " +
      "list_records: `maxRecords` default 100, cap 1000, `offset` to continue.\n\n" +
      'Example: {"records":[{"id":"recA1b2C3d4E5f6G7","fields":{"Name":"Acme ' +
      'renewal"}}],"returned":1,"more":false,"searchedFieldIds":["fldName0000000001"]}\n\n' +
      "Costs one extra schema read per call. For anything other than a " +
      "substring match — numbers, dates, case-insensitive, exact — use " +
      "list_records with `filterByFormula`.",
    inputSchema: {
      type: "object",
      properties: {
        baseId: BASE_ID,
        tableId: TABLE_ID,
        searchTerm: { type: "string", description: "The text to search for." },
        fieldIds: {
          type: "array",
          items: { type: "string" },
          description: "Only search these text fields (IDs or names).",
        },
        maxRecords: MAX_RECORDS,
        view: VIEW,
        offset: OFFSET,
      },
      required: ["baseId", "tableId", "searchTerm"],
      additionalProperties: false,
    },
    annotations: READ,
    handler: (raw) =>
      guard(async () => {
        const input = args(raw);
        const baseId = requiredString(input, "baseId");
        const tableId = requiredString(input, "tableId");
        // Not trimmed: a leading or trailing space is part of what is searched for.
        const searchTerm = requiredText(input, "searchTerm");
        const fieldIds = stringArray(input, "fieldIds");
        const view = optionalString(input, "view");
        const offset = optionalString(input, "offset");
        const { searchedFieldIds, ...page } = await (
          await client()
        ).searchRecords(baseId, tableId, searchTerm, fieldIds, {
          maxRecords: boundedInt(
            input,
            "maxRecords",
            DEFAULT_MAX_RECORDS,
            MAX_RECORDS_CAP,
          ),
          ...(view ? { view } : {}),
          ...(offset ? { offset } : {}),
        });
        return ok(pageResult(page, { searchedFieldIds }));
      }),
  };
}

export function getRecordTool(client: ClientFactory): ToolDefinition {
  return {
    name: "get_record",
    description:
      "Get one record by ID, with every non-empty field.\n\n" +
      'Example: {"id":"recA1b2C3d4E5f6G7","createdTime":"2026-10-01T00:00:00.000Z",' +
      '"fields":{"Name":"Launch","Status":"Done"}}',
    inputSchema: {
      type: "object",
      properties: { baseId: BASE_ID, tableId: TABLE_ID, recordId: RECORD_ID },
      required: ["baseId", "tableId", "recordId"],
      additionalProperties: false,
    },
    annotations: READ,
    handler: (raw) =>
      guard(async () => {
        const input = args(raw);
        return ok(
          await (
            await client()
          ).getRecord(
            requiredString(input, "baseId"),
            requiredString(input, "tableId"),
            requiredString(input, "recordId"),
          ),
        );
      }),
  };
}

export function createRecordTool(client: ClientFactory): ToolDefinition {
  return {
    name: "create_record",
    description:
      "Create one record. `fields` maps field names (or IDs) to values. Values " +
      "are typecast: a date string becomes a date, an unknown select option is " +
      "created, a linked record can be given by its record ID in an array.\n\n" +
      'Example call: {"baseId":"app…","tableId":"Tasks","fields":{"Name":"Ship",' +
      '"Due":"2026-11-01","Tags":["urgent"]}}\n' +
      'Returns: {"id":"recNew0000000001","fields":{…}}\n\n' +
      'Attachments: give a public URL, e.g. {"Files":[{"url":"https://…"}]}, ' +
      "or create the record and then use upload_attachment for a local file.",
    inputSchema: {
      type: "object",
      properties: {
        baseId: BASE_ID,
        tableId: TABLE_ID,
        fields: {
          type: "object",
          description: "Field name or ID → value for the new record.",
        },
      },
      required: ["baseId", "tableId", "fields"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    handler: (raw) =>
      guard(async () => {
        const input = args(raw);
        return ok(
          await (
            await client()
          ).createRecord(
            requiredString(input, "baseId"),
            requiredString(input, "tableId"),
            plainObject(input, "fields"),
          ),
        );
      }),
  };
}

export function updateRecordsTool(client: ClientFactory): ToolDefinition {
  return {
    name: "update_records",
    description:
      `Update up to ${MAX_WRITE_BATCH} records in one table. Only the fields ` +
      "named are changed; each named field's old value is REPLACED (a linked-" +
      "record or multi-select field is set to exactly the array given, not " +
      "appended to). Values are typecast as in create_record. Send null to " +
      "clear a field.\n\n" +
      'Example call: {"baseId":"app…","tableId":"Tasks","records":[{"id":' +
      '"recA1b2C3d4E5f6G7","fields":{"Status":"Done"}}]}\n' +
      'Returns: {"records":[{"id":"recA1b2C3d4E5f6G7","fields":{…}}]}',
    inputSchema: {
      type: "object",
      properties: {
        baseId: BASE_ID,
        tableId: TABLE_ID,
        records: {
          type: "array",
          description: `The records to update (1-${MAX_WRITE_BATCH}).`,
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Record ID." },
              fields: { type: "object", description: "Field → new value." },
            },
            required: ["id", "fields"],
          },
        },
      },
      required: ["baseId", "tableId", "records"],
      additionalProperties: false,
    },
    // Destructive: an update overwrites the previous value and Airtable keeps
    // no undo an API caller can reach. Idempotent: the same patch twice lands
    // the same state.
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: (raw) =>
      guard(async () => {
        const input = args(raw);
        const baseId = requiredString(input, "baseId");
        const tableId = requiredString(input, "tableId");
        const list = input.records;
        if (!Array.isArray(list) || list.length === 0) {
          throw new InputError(
            "`records` is required and must be a non-empty array of {id, fields}.",
          );
        }
        if (list.length > MAX_WRITE_BATCH) {
          throw new InputError(
            `\`records\` has ${list.length} items; Airtable takes at most ${MAX_WRITE_BATCH} per request. Split the call.`,
          );
        }
        const records = list.map((entry, i) => {
          const e = args(entry);
          if (typeof e.id !== "string" || e.id.trim() === "") {
            throw new InputError(`\`records[${i}].id\` must be a record ID.`);
          }
          return { id: e.id.trim(), fields: plainObject(e, "fields") };
        });
        const updated = await (
          await client()
        ).updateRecords(baseId, tableId, records);
        return ok({ records: updated });
      }),
  };
}

export function deleteRecordsTool(client: ClientFactory): ToolDefinition {
  return {
    name: "delete_records",
    description:
      `Delete up to ${MAX_WRITE_BATCH} records from a table. Permanent through ` +
      "the API: a deleted record is only recoverable by a human from the base's " +
      "trash in the Airtable app.\n\n" +
      'Example call: {"baseId":"app…","tableId":"Tasks","recordIds":["recA1b2C3d4E5f6G7"]}\n' +
      'Returns: {"records":[{"id":"recA1b2C3d4E5f6G7"}],"deleted":1}',
    inputSchema: {
      type: "object",
      properties: {
        baseId: BASE_ID,
        tableId: TABLE_ID,
        recordIds: {
          type: "array",
          items: { type: "string" },
          description: `Record IDs to delete (1-${MAX_WRITE_BATCH}).`,
        },
      },
      required: ["baseId", "tableId", "recordIds"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: (raw) =>
      guard(async () => {
        const input = args(raw);
        const baseId = requiredString(input, "baseId");
        const tableId = requiredString(input, "tableId");
        const recordIds = stringArray(input, "recordIds", {
          required: true,
          max: MAX_WRITE_BATCH,
        })!;
        const records = await (
          await client()
        ).deleteRecords(baseId, tableId, recordIds);
        return ok({ records, deleted: records.length });
      }),
  };
}
