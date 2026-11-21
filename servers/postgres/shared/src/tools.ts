import type { PostgresConfig } from "./config.js";
import type { Runner } from "./query.js";
import { checkReadOnlySql } from "./sql.js";

/**
 * Four reads, and nothing that writes.
 *
 * Three are the catalog — schemas, the relations in one schema, one relation in
 * full — and run SQL this file wrote, so a caller orienting in an unfamiliar
 * database never has to guess `information_schema`'s shape. The fourth runs the
 * caller's statement, through the guard in `sql.ts` and in the READ ONLY
 * transaction every call gets (`query.ts`).
 *
 * Bounds are part of every result. `query` returns at most `max_rows` rows
 * (default 100, at most 1,000), a cell over `MAX_CELL_CHARS` is cut where it
 * stands, and the result as a whole is cut at the server's character cap by
 * dropping rows from the end — and says so.
 */

export interface ToolContext {
  runner: Runner;
  config: PostgresConfig;
}

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;
}

export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputError";
  }
}

export const DEFAULT_MAX_ROWS = 100;
export const MAX_MAX_ROWS = 1_000;
export const MAX_CELL_CHARS = 2_000;
/** The catalog tools' own ceiling on relations listed. */
export const MAX_RELATIONS = 1_000;

function optionalString(args: Record<string, unknown>, name: string): string | undefined {
  const v = args[name];
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string") throw new InputError(`\`${name}\` must be a string.`);
  return v;
}

function requiredString(args: Record<string, unknown>, name: string): string {
  const v = optionalString(args, name);
  if (v === undefined) throw new InputError(`\`${name}\` is required.`);
  return v;
}

function optionalBoolean(args: Record<string, unknown>, name: string): boolean {
  const v = args[name];
  if (v === undefined || v === null) return false;
  if (typeof v !== "boolean") throw new InputError(`\`${name}\` must be true or false.`);
  return v;
}

function maxRows(args: Record<string, unknown>): number {
  const v = args.max_rows;
  if (v === undefined || v === null) return DEFAULT_MAX_ROWS;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
    throw new InputError("`max_rows` must be a positive integer.");
  }
  return Math.min(v, MAX_MAX_ROWS);
}

type Param = string | number | boolean | null;

function params(args: Record<string, unknown>): Param[] {
  const v = args.params;
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new InputError("`params` must be an array.");
  if (v.length > 100) throw new InputError("`params` may hold at most 100 values.");
  for (const p of v) {
    if (p !== null && !["string", "number", "boolean"].includes(typeof p)) {
      throw new InputError("Each of `params` must be a string, number, boolean or null.");
    }
  }
  return v as Param[];
}

/** A cell, cut to `MAX_CELL_CHARS` if it is longer. JSON values are cut as their text. */
export function cell(value: unknown): unknown {
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text === undefined) return null;
  if (text.length <= MAX_CELL_CHARS) return value;
  return `${text.slice(0, MAX_CELL_CHARS)}…[cut: ${text.length} characters]`;
}

const RELATION_KINDS: Record<string, string> = {
  r: "table",
  p: "partitioned table",
  v: "view",
  m: "materialized view",
  f: "foreign table",
};

const listSchemas: ToolDefinition = {
  name: "list_schemas",
  title: "List schemas",
  description:
    "List the schemas in this database, with each one's owner and how many tables, views and " +
    "materialized views it holds. System schemas (pg_catalog, information_schema, pg_toast) are " +
    "left out unless include_system is true. Start here in an unfamiliar database; then list_tables.",
  inputSchema: {
    type: "object",
    properties: {
      include_system: {
        type: "boolean",
        description: "Include pg_catalog, information_schema and the pg_* schemas. Default false.",
      },
    },
    additionalProperties: false,
  },
  handler: async (args, { runner, config }) => {
    const includeSystem = optionalBoolean(args, "include_system");
    const rows = await runner.catalog(
      `SELECT n.nspname AS schema,
              pg_catalog.pg_get_userbyid(n.nspowner) AS owner,
              (SELECT count(*)::int FROM pg_catalog.pg_class c
                WHERE c.relnamespace = n.oid AND c.relkind IN ('r','p','v','m','f')) AS relations
         FROM pg_catalog.pg_namespace n
        WHERE $1::boolean
           OR (n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema')
        ORDER BY 1
        LIMIT ${MAX_RELATIONS + 1}`,
      [includeSystem],
    );
    return {
      database: config.database,
      schemas: rows.slice(0, MAX_RELATIONS),
      ...(rows.length > MAX_RELATIONS ? { cut: `Only the first ${MAX_RELATIONS} schemas, by name.` } : {}),
    };
  },
};

const listTables: ToolDefinition = {
  name: "list_tables",
  title: "List tables",
  description:
    "List the tables, views, materialized views and foreign tables in one schema (default " +
    "`public`), with each one's kind, estimated row count (from planner statistics, not a " +
    "count), total size in bytes and comment. Then describe_table for one of them.",
  inputSchema: {
    type: "object",
    properties: {
      schema: { type: "string", description: "The schema. Default `public`." },
    },
    additionalProperties: false,
  },
  handler: async (args, { runner }) => {
    const schema = optionalString(args, "schema") ?? "public";
    const rows = await runner.catalog<{
      name: string;
      kind: string;
      estimated_rows: string | null;
      total_bytes: string | null;
      comment: string | null;
    }>(
      `SELECT c.relname AS name,
              c.relkind::text AS kind,
              CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::bigint END AS estimated_rows,
              CASE WHEN c.relkind IN ('r','p','m') THEN pg_catalog.pg_total_relation_size(c.oid) END AS total_bytes,
              pg_catalog.obj_description(c.oid, 'pg_class') AS comment
         FROM pg_catalog.pg_class c
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relkind IN ('r','p','v','m','f')
        ORDER BY c.relname
        LIMIT ${MAX_RELATIONS + 1}`,
      [schema],
    );
    if (rows.length === 0) {
      const exists = await runner.catalog("SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = $1", [schema]);
      if (exists.length === 0) {
        throw new InputError(`There is no schema ${JSON.stringify(schema)} in this database. list_schemas lists them.`);
      }
    }
    return {
      schema,
      relations: rows.slice(0, MAX_RELATIONS).map((r) => ({
        name: r.name,
        kind: RELATION_KINDS[r.kind] ?? r.kind,
        estimated_rows: r.estimated_rows === null ? null : Number(r.estimated_rows),
        total_bytes: r.total_bytes === null ? null : Number(r.total_bytes),
        comment: r.comment,
      })),
      ...(rows.length > MAX_RELATIONS ? { cut: `Only the first ${MAX_RELATIONS} relations, by name.` } : {}),
    };
  },
};

const describeTable: ToolDefinition = {
  name: "describe_table",
  title: "Describe a table",
  description:
    "Describe one table, view or materialized view: its columns (name, type, nullable, default, " +
    "comment), primary key, unique, check and foreign-key constraints, indexes, estimated row " +
    "count and comment, and for a view its definition. Names are matched exactly, as stored " +
    "(usually lowercase); list_tables shows them.",
  inputSchema: {
    type: "object",
    properties: {
      schema: { type: "string", description: "The schema. Default `public`." },
      table: { type: "string", description: "The table, view or materialized view name, as stored." },
    },
    required: ["table"],
    additionalProperties: false,
  },
  handler: async (args, { runner }) => {
    const schema = optionalString(args, "schema") ?? "public";
    const table = requiredString(args, "table");
    const [relation] = await runner.catalog<{
      oid: number;
      kind: string;
      estimated_rows: string | null;
      comment: string | null;
      definition: string | null;
    }>(
      `SELECT c.oid::int AS oid,
              c.relkind::text AS kind,
              CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::bigint END AS estimated_rows,
              pg_catalog.obj_description(c.oid, 'pg_class') AS comment,
              CASE WHEN c.relkind IN ('v','m') THEN pg_catalog.pg_get_viewdef(c.oid, true) END AS definition
         FROM pg_catalog.pg_class c
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r','p','v','m','f')`,
      [schema, table],
    );
    if (!relation) {
      throw new InputError(
        `There is no table or view ${JSON.stringify(table)} in schema ${JSON.stringify(schema)}. ` +
          `list_tables lists them; names are matched exactly, as stored.`,
      );
    }
    const columns = await runner.catalog<{ name: string; type: string; nullable: boolean; default: string | null; comment: string | null }>(
      `SELECT a.attname AS name,
              pg_catalog.format_type(a.atttypid, a.atttypmod) AS type,
              NOT a.attnotnull AS nullable,
              pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS "default",
              pg_catalog.col_description(a.attrelid, a.attnum) AS comment
         FROM pg_catalog.pg_attribute a
         LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY a.attnum`,
      [relation.oid],
    );
    const constraints = await runner.catalog<{ name: string; type: string; definition: string }>(
      `SELECT conname AS name, contype::text AS type, pg_catalog.pg_get_constraintdef(oid, true) AS definition
         FROM pg_catalog.pg_constraint
        WHERE conrelid = $1
        ORDER BY contype, conname`,
      [relation.oid],
    );
    const indexes = await runner.catalog(
      `SELECT i.relname AS name, pg_catalog.pg_get_indexdef(x.indexrelid) AS definition,
              x.indisprimary AS primary, x.indisunique AS unique
         FROM pg_catalog.pg_index x
         JOIN pg_catalog.pg_class i ON i.oid = x.indexrelid
        WHERE x.indrelid = $1
        ORDER BY i.relname`,
      [relation.oid],
    );
    const CONSTRAINT_TYPES: Record<string, string> = {
      p: "primary key",
      u: "unique",
      f: "foreign key",
      c: "check",
      x: "exclusion",
      n: "not null",
      t: "trigger",
    };
    return {
      schema,
      name: table,
      kind: RELATION_KINDS[relation.kind] ?? relation.kind,
      estimated_rows: relation.estimated_rows === null ? null : Number(relation.estimated_rows),
      comment: relation.comment,
      // A default can be a long expression and a comment a paragraph.
      columns: columns.map((c) => ({ ...c, default: cell(c.default), comment: cell(c.comment) })),
      constraints: constraints.map((c) => ({
        ...c,
        type: CONSTRAINT_TYPES[c.type] ?? c.type,
        definition: cell(c.definition),
      })),
      indexes,
      ...(relation.definition === null ? {} : { definition: cell(relation.definition) }),
    };
  },
};

const query: ToolDefinition = {
  name: "query",
  title: "Run a read-only query",
  description:
    "Run ONE read-only SQL statement and return its rows. The statement must begin with SELECT, " +
    "WITH, VALUES, TABLE, EXPLAIN or SHOW; more than one statement per call is refused. It runs in a " +
    "READ ONLY transaction that is always rolled back, under a 30-second statement timeout, so " +
    "nothing that writes can run. Returns at most max_rows rows (default 100, at most 1000) and " +
    "says when there were more; long values are cut. Pass values as `params` ($1, $2, ...) rather " +
    "than splicing them into the SQL. For large tables, filter and LIMIT in the SQL itself.",
  inputSchema: {
    type: "object",
    properties: {
      sql: { type: "string", description: "One SQL statement. A trailing `;` is fine; a second statement is not." },
      params: {
        type: "array",
        items: { type: ["string", "number", "boolean", "null"] },
        description: "Values for $1, $2, ... in `sql`.",
      },
      max_rows: {
        type: "integer",
        minimum: 1,
        maximum: MAX_MAX_ROWS,
        description: `Rows to return at most. Default ${DEFAULT_MAX_ROWS}, at most ${MAX_MAX_ROWS}.`,
      },
    },
    required: ["sql"],
    additionalProperties: false,
  },
  handler: async (args, { runner }) => {
    const sql = checkReadOnlySql(requiredString(args, "sql"));
    const limit = maxRows(args);
    const result = await runner.statement(sql, params(args), limit);
    return {
      columns: result.columns,
      rows: result.rows.map((r) => r.map(cell)),
      row_count: result.rows.length,
      more_rows: result.more,
      ...(result.more
        ? { note: `Stopped at max_rows=${limit}; the statement produced more. Narrow it, or raise max_rows.` }
        : {}),
    };
  },
};

export const TOOLS: readonly ToolDefinition[] = [listSchemas, listTables, describeTable, query];
export const TOOL_NAMES = TOOLS.map((t) => t.name);
