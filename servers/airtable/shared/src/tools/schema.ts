import type { TableSchema } from "../client.js";
import { InputError } from "../errors.js";
import {
  args,
  BASE_ID,
  DETAIL_LEVEL,
  guard,
  ok,
  oneOf,
  optionalString,
  plainObject,
  READ,
  requiredString,
  TABLE_ID,
  type ClientFactory,
  type ToolAnnotations,
  type ToolDefinition,
} from "./shared.js";

/**
 * Bases, tables and fields: the schema reads, and the four schema writes.
 *
 * The two FIELD endpoints take a table ID and a field ID only; the client
 * resolves a name to its ID through the base schema before it calls them.
 *
 * Airtable has no endpoint for ONE table's schema — `describe_table` reads the
 * whole base and picks the table out, exactly as the npx package did. What this
 * tree adds is that a table may be named instead of IDed, everywhere a
 * `tableId` is taken, because the parameter has always been described that way.
 */

const DETAIL_LEVELS = [
  "tableIdentifiersOnly",
  "identifiersOnly",
  "full",
] as const;
type DetailLevel = (typeof DETAIL_LEVELS)[number];

function shapeTable(
  table: TableSchema,
  level: DetailLevel,
): Record<string, unknown> {
  if (level === "tableIdentifiersOnly")
    return { id: table.id, name: table.name };
  if (level === "identifiersOnly") {
    return {
      id: table.id,
      name: table.name,
      fields: table.fields.map((f) => ({ id: f.id, name: f.name })),
      views: table.views.map((v) => ({ id: v.id, name: v.name })),
    };
  }
  return {
    id: table.id,
    name: table.name,
    ...(table.description !== undefined
      ? { description: table.description }
      : {}),
    ...(table.primaryFieldId !== undefined
      ? { primaryFieldId: table.primaryFieldId }
      : {}),
    fields: table.fields,
    views: table.views,
  };
}

/** Name and description edits overwrite the previous text and are repeatable. */
const SCHEMA_EDIT: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
};

const SCHEMA_CREATE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

/** At least one of name/description, so an empty PATCH is never sent. */
function renameArgs(input: Record<string, unknown>, what: string) {
  const name = optionalString(input, "name");
  const description = input.description;
  if (description !== undefined && typeof description !== "string") {
    throw new InputError("`description` must be a string.");
  }
  if (name === undefined && description === undefined) {
    throw new InputError(
      `Give \`name\`, \`description\`, or both — there is nothing to change on the ${what}.`,
    );
  }
  return {
    ...(name !== undefined ? { name } : {}),
    ...(description !== undefined ? { description } : {}),
  };
}

export function listBasesTool(client: ClientFactory): ToolDefinition {
  return {
    name: "list_bases",
    description:
      "List the Airtable bases this token can reach. START HERE: every other " +
      "tool takes a `baseId` from this list. A base the token was not granted " +
      "access to is absent, not an error.\n\n" +
      'Example: {"bases":[{"id":"appA1b2C3d4E5f6G7","name":"Roadmap",' +
      '"permissionLevel":"create"}],"returned":1,"more":false}\n\n' +
      "`permissionLevel` is the human's role on the base: none, read, comment, " +
      "edit or create. Airtable returns up to 1000 bases per page; when `more` " +
      "is true, call again with `offset`.",
    inputSchema: {
      type: "object",
      properties: {
        offset: {
          type: "string",
          description:
            "The `offset` a previous call returned, for the next page.",
        },
      },
      additionalProperties: false,
    },
    annotations: READ,
    handler: (raw) =>
      guard(async () => {
        const offset = optionalString(args(raw), "offset");
        const page = await (await client()).listBases(offset);
        return ok({
          bases: page.bases,
          returned: page.bases.length,
          more: page.offset !== undefined,
          ...(page.offset !== undefined ? { offset: page.offset } : {}),
        });
      }),
  };
}

export function listTablesTool(client: ClientFactory): ToolDefinition {
  return {
    name: "list_tables",
    description:
      "List the tables in a base, with as much schema as `detailLevel` asks " +
      "for.\n\n" +
      'Example (identifiersOnly): {"tables":[{"id":"tblA1b2C3d4E5f6G7","name":' +
      '"Tasks","fields":[{"id":"fldA1b2C3d4E5f6G7","name":"Name"}],"views":' +
      '[{"id":"viwA1b2C3d4E5f6G7","name":"Grid view"}]}]}\n\n' +
      "For a base with many tables, list with tableIdentifiersOnly and then " +
      "describe_table the one you need at full.",
    inputSchema: {
      type: "object",
      properties: { baseId: BASE_ID, detailLevel: DETAIL_LEVEL },
      required: ["baseId"],
      additionalProperties: false,
    },
    annotations: READ,
    handler: (raw) =>
      guard(async () => {
        const input = args(raw);
        const baseId = requiredString(input, "baseId");
        const level = oneOf(input, "detailLevel", DETAIL_LEVELS, "full");
        const { tables } = await (await client()).getBaseSchema(baseId);
        return ok({ tables: tables.map((t) => shapeTable(t, level)) });
      }),
  };
}

export function describeTableTool(client: ClientFactory): ToolDefinition {
  return {
    name: "describe_table",
    description:
      "Get one table's schema: its fields (ID, name, type, options such as " +
      "select choices or linked table) and views. Use it before writing " +
      "records or a filterByFormula, to get exact field names and types.\n\n" +
      'Example (full): {"table":{"id":"tblA1b2C3d4E5f6G7","name":"Tasks",' +
      '"primaryFieldId":"fldA1b2C3d4E5f6G7","fields":[{"id":"fldA1b2C3d4E5f6G7",' +
      '"name":"Name","type":"singleLineText"},{"id":"fldB…","name":"Status",' +
      '"type":"singleSelect","options":{"choices":[{"name":"Done"}]}}],' +
      '"views":[{"id":"viw…","name":"Grid view","type":"grid"}]}}',
    inputSchema: {
      type: "object",
      properties: {
        baseId: BASE_ID,
        tableId: TABLE_ID,
        detailLevel: DETAIL_LEVEL,
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
        const level = oneOf(input, "detailLevel", DETAIL_LEVELS, "full");
        const table = await (await client()).findTable(baseId, tableId);
        return ok({ table: shapeTable(table, level) });
      }),
  };
}

export function createTableTool(client: ClientFactory): ToolDefinition {
  return {
    name: "create_table",
    description:
      "Create a table in a base. The FIRST field becomes the primary field and " +
      "must be a type Airtable allows there (singleLineText is the safe " +
      "choice).\n\n" +
      'Example call: {"baseId":"app…","name":"Vendors","fields":[{"name":"Name",' +
      '"type":"singleLineText"},{"name":"Contact","type":"email"},{"name":"Tier",' +
      '"type":"singleSelect","options":{"choices":[{"name":"Gold"}]}}]}\n' +
      'Returns: {"table":{"id":"tblNew…","name":"Vendors","fields":[…],"views":[…]}}\n\n' +
      "Field definitions use Airtable's field model: {name, type, description?, " +
      "options?}. Needs the schema.bases:write scope.",
    inputSchema: {
      type: "object",
      properties: {
        baseId: BASE_ID,
        name: { type: "string", description: "The table name." },
        fields: {
          type: "array",
          items: { type: "object" },
          description: "Field definitions, primary field first.",
        },
        description: {
          type: "string",
          description: "Optional table description.",
        },
      },
      required: ["baseId", "name", "fields"],
      additionalProperties: false,
    },
    annotations: SCHEMA_CREATE,
    handler: (raw) =>
      guard(async () => {
        const input = args(raw);
        const baseId = requiredString(input, "baseId");
        const name = requiredString(input, "name");
        const fields = input.fields;
        if (
          !Array.isArray(fields) ||
          fields.length === 0 ||
          fields.some((f) => !f || typeof f !== "object" || Array.isArray(f))
        ) {
          throw new InputError(
            '`fields` must be a non-empty array of field definitions, e.g. [{"name":"Name","type":"singleLineText"}].',
          );
        }
        const description = optionalString(input, "description");
        const table = await (
          await client()
        ).createTable(
          baseId,
          name,
          fields as Record<string, unknown>[],
          description,
        );
        return ok({ table });
      }),
  };
}

export function updateTableTool(client: ClientFactory): ToolDefinition {
  return {
    name: "update_table",
    description:
      "Rename a table or change its description. The old value is replaced. " +
      "Renaming breaks any formula, filter or integration that refers to the " +
      "table by name.\n\n" +
      'Returns: {"table":{"id":"tblA1b2C3d4E5f6G7","name":"New name",…}}',
    inputSchema: {
      type: "object",
      properties: {
        baseId: BASE_ID,
        tableId: TABLE_ID,
        name: { type: "string", description: "New name for the table." },
        description: {
          type: "string",
          description: "New description for the table.",
        },
      },
      required: ["baseId", "tableId"],
      additionalProperties: false,
    },
    annotations: SCHEMA_EDIT,
    handler: (raw) =>
      guard(async () => {
        const input = args(raw);
        const baseId = requiredString(input, "baseId");
        const tableId = requiredString(input, "tableId");
        const updates = renameArgs(input, "table");
        const table = await (
          await client()
        ).updateTable(baseId, tableId, updates);
        return ok({ table });
      }),
  };
}

export function createFieldTool(client: ClientFactory): ToolDefinition {
  return {
    name: "create_field",
    description:
      "Add a field (column) to a table. The definition goes under " +
      "`nested.field` — the npx package's argument shape, kept so existing " +
      "prompts work.\n\n" +
      'Example call: {"baseId":"app…","tableId":"Tasks","nested":{"field":' +
      '{"name":"Priority","type":"singleSelect","options":{"choices":' +
      '[{"name":"High"},{"name":"Low"}]}}}}\n' +
      'Returns: {"field":{"id":"fldNew…","name":"Priority","type":"singleSelect",…}}\n\n' +
      "Some types need `options` (e.g. number needs {precision}, " +
      "multipleRecordLinks needs {linkedTableId}); Airtable's 422 names what " +
      "is missing. Formula, rollup and lookup fields cannot be created through " +
      "the API. A table NAME costs one extra schema read to resolve to its ID.",
    inputSchema: {
      type: "object",
      properties: {
        baseId: BASE_ID,
        tableId: TABLE_ID,
        nested: {
          type: "object",
          properties: {
            field: {
              type: "object",
              description:
                "Field definition: {name, type, description?, options?}.",
            },
          },
          required: ["field"],
        },
      },
      required: ["baseId", "tableId", "nested"],
      additionalProperties: false,
    },
    annotations: SCHEMA_CREATE,
    handler: (raw) =>
      guard(async () => {
        const input = args(raw);
        const baseId = requiredString(input, "baseId");
        const tableId = requiredString(input, "tableId");
        const nested = input.nested;
        if (!nested || typeof nested !== "object" || Array.isArray(nested)) {
          throw new InputError(
            '`nested` is required: {"field": {"name": "…", "type": "…"}}.',
          );
        }
        const field = plainObject(nested as Record<string, unknown>, "field");
        const created = await (
          await client()
        ).createField(baseId, tableId, field);
        return ok({ field: created });
      }),
  };
}

export function updateFieldTool(client: ClientFactory): ToolDefinition {
  return {
    name: "update_field",
    description:
      "Rename a field or change its description. The old value is replaced; a " +
      "field's TYPE cannot be changed through the API. Renaming breaks any " +
      "formula or filter text that names the field. A table or field NAME " +
      "costs one extra schema read to resolve to its ID.\n\n" +
      'Returns: {"field":{"id":"fldA1b2C3d4E5f6G7","name":"New name",…}}',
    inputSchema: {
      type: "object",
      properties: {
        baseId: BASE_ID,
        tableId: TABLE_ID,
        fieldId: {
          type: "string",
          description:
            'The field ID or name, e.g. "fldXXXXXXXXXXXXXX" or "Status". Prefer the ID: a name is looked up in the schema first.',
        },
        name: { type: "string", description: "New name for the field." },
        description: {
          type: "string",
          description: "New description for the field.",
        },
      },
      required: ["baseId", "tableId", "fieldId"],
      additionalProperties: false,
    },
    annotations: SCHEMA_EDIT,
    handler: (raw) =>
      guard(async () => {
        const input = args(raw);
        const baseId = requiredString(input, "baseId");
        const tableId = requiredString(input, "tableId");
        const fieldId = requiredString(input, "fieldId");
        const updates = renameArgs(input, "field");
        const field = await (
          await client()
        ).updateField(baseId, tableId, fieldId, updates);
        return ok({ field });
      }),
  };
}
