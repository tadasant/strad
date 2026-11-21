/**
 * The server end to end, through a real MCP client over an in-memory
 * transport, against a REAL Postgres with TLS on (see `global-setup.ts`).
 *
 * Two roles. `strad_reader` is what a deployment should configure: a role that
 * can read and not write. The superuser is the harder case, and the one the
 * write-refusal tests use on purpose: it can write anything, so a write that
 * fails under it failed because of the READ ONLY transaction, not the role.
 */
import { createServer, type Socket } from "node:net";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { createMCPServer, MAX_CELL_CHARS, MAX_RESULT_CHARS, TOOL_NAMES } from "../src/index.js";

const { adminUrl, host, port, ca } = inject("pg");

const READER_PASSWORD = "rd:pw/with@odd%chars-91b2";
const DB = new URL(adminUrl).pathname.slice(1) || "postgres";
const ADMIN_PASSWORD = decodeURIComponent(new URL(adminUrl).password);

function uri(user: string, password: string, mode = "require", h = host): string {
  return `postgres://${user}:${encodeURIComponent(password)}@${h}:${port}/${DB}?sslmode=${mode}`;
}

const READER = uri("strad_reader", READER_PASSWORD);
const ADMIN = uri("postgres", ADMIN_PASSWORD);

const closers: Array<() => Promise<void>> = [];

async function connect(env: Record<string, string | undefined>, statementTimeoutMs?: number) {
  const created = createMCPServer({
    version: "test",
    env,
    ...(statementTimeoutMs === undefined ? {} : { runner: { statementTimeoutMs } }),
  });
  const server = new Server({ name: "strad-postgres", version: "test" }, { capabilities: { tools: {} } });
  await created.registerHandlers(server);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "test", version: "test" });
  await client.connect(b);
  closers.push(async () => {
    await client.close();
    await created.close();
  });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    const text = r.content[0]!.text;
    return { text, isError: r.isError === true, json: () => JSON.parse(text) as Record<string, any> };
  };
  return { client, call, created };
}

let admin: pg.Client;

beforeAll(async () => {
  admin = new pg.Client({ connectionString: adminUrl, ssl: { rejectUnauthorized: false } });
  await admin.connect();
  await admin.query(`
    DROP SCHEMA IF EXISTS shop CASCADE;
    DROP TABLE IF EXISTS public.canary;
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'strad_reader') THEN
        EXECUTE 'DROP OWNED BY strad_reader'; EXECUTE 'DROP ROLE strad_reader';
      END IF;
    END $$;
    CREATE ROLE strad_reader LOGIN PASSWORD '${READER_PASSWORD.replace(/'/g, "''")}';
    GRANT pg_read_all_data TO strad_reader;
    CREATE SCHEMA shop;
    COMMENT ON SCHEMA shop IS 'the shop';
    CREATE TABLE shop.customers (id int PRIMARY KEY, email text UNIQUE NOT NULL);
    CREATE TABLE shop.orders (
      id serial PRIMARY KEY,
      customer_id int NOT NULL REFERENCES shop.customers(id),
      total numeric(10,2) NOT NULL DEFAULT 0 CHECK (total >= 0),
      placed_at timestamptz NOT NULL DEFAULT '2026-11-21 10:00:00+00',
      notes text,
      data jsonb,
      payload bytea,
      big bigint
    );
    COMMENT ON TABLE shop.orders IS 'one row per order';
    COMMENT ON COLUMN shop.orders.total IS 'in dollars';
    CREATE INDEX orders_customer_idx ON shop.orders (customer_id);
    CREATE VIEW shop.big_orders AS SELECT * FROM shop.orders WHERE total > 100;
    CREATE SEQUENCE shop.counter;
    INSERT INTO shop.customers VALUES (1, 'a@example.com'), (2, 'b@example.com');
    INSERT INTO shop.orders (customer_id, total, notes, data, payload, big)
      SELECT 1 + (g % 2), g, 'order ' || g, jsonb_build_object('n', g), '\\x0102'::bytea, 9007199254740993
        FROM generate_series(1, 300) g;
    ANALYZE shop.orders;
    CREATE TABLE public.canary (v text);
    INSERT INTO public.canary VALUES ('alive');
  `);
});

afterAll(async () => {
  for (const close of closers.splice(0)) await close().catch(() => {});
  await admin?.end();
});

async function canary(): Promise<string[]> {
  return (await admin.query<{ v: string }>("SELECT v FROM public.canary ORDER BY v")).rows.map((r) => r.v);
}

describe("the tool surface", () => {
  it("is exactly four tools, every one read-only", async () => {
    const { client } = await connect({});
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["list_schemas", "list_tables", "describe_table", "query"]);
    expect(TOOL_NAMES).toEqual(tools.map((t) => t.name));
    for (const t of tools) {
      expect(t.annotations?.readOnlyHint).toBe(true);
      expect(t.annotations?.destructiveHint).toBe(false);
    }
  });

  it("lists with nothing configured, and every call names the missing variable", async () => {
    const { created, call } = await connect({});
    expect(created.missing).toEqual(["DATABASE_URI"]);
    for (const name of TOOL_NAMES) {
      const r = await call(name, name === "query" ? { sql: "SELECT 1" } : { table: "x" });
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/DATABASE_URI is not set/);
    }
  });
});

describe("the catalog tools", () => {
  it("list_schemas lists user schemas, and system ones on request", async () => {
    const { call } = await connect({ DATABASE_URI: READER });
    const r = (await call("list_schemas")).json();
    const names = r.schemas.map((s: { schema: string }) => s.schema);
    expect(names).toContain("shop");
    expect(names).toContain("public");
    expect(names).not.toContain("pg_catalog");
    expect(r.schemas.find((s: { schema: string }) => s.schema === "shop").relations).toBe(3);
    const all = (await call("list_schemas", { include_system: true })).json();
    expect(all.schemas.map((s: { schema: string }) => s.schema)).toContain("pg_catalog");
  });

  it("list_tables lists one schema's relations with kind, estimate and comment", async () => {
    const { call } = await connect({ DATABASE_URI: READER });
    const r = (await call("list_tables", { schema: "shop" })).json();
    expect(r.relations.map((x: { name: string }) => x.name)).toEqual(["big_orders", "customers", "orders"]);
    const orders = r.relations.find((x: { name: string }) => x.name === "orders");
    expect(orders).toMatchObject({ kind: "table", estimated_rows: 300, comment: "one row per order" });
    expect(orders.total_bytes).toBeGreaterThan(0);
    expect(r.relations.find((x: { name: string }) => x.name === "big_orders").kind).toBe("view");
  });

  it("list_tables says when the schema does not exist", async () => {
    const { call } = await connect({ DATABASE_URI: READER });
    const r = await call("list_tables", { schema: "nope" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/no schema "nope"/);
  });

  it("describe_table gives columns, constraints and indexes", async () => {
    const { call } = await connect({ DATABASE_URI: READER });
    const r = (await call("describe_table", { schema: "shop", table: "orders" })).json();
    expect(r.kind).toBe("table");
    expect(r.comment).toBe("one row per order");
    expect(r.columns.map((c: { name: string }) => c.name)).toEqual([
      "id", "customer_id", "total", "placed_at", "notes", "data", "payload", "big",
    ]);
    expect(r.columns.find((c: { name: string }) => c.name === "total")).toMatchObject({
      type: "numeric(10,2)",
      nullable: false,
      default: "0",
      comment: "in dollars",
    });
    const types = r.constraints.map((c: { type: string }) => c.type);
    expect(types).toEqual(expect.arrayContaining(["primary key", "foreign key", "check"]));
    expect(r.constraints.find((c: { type: string }) => c.type === "foreign key").definition).toMatch(
      /REFERENCES shop\.customers\(id\)/,
    );
    expect(r.indexes.map((i: { name: string }) => i.name)).toEqual(["orders_customer_idx", "orders_pkey"]);
  });

  it("describe_table gives a view its definition, and refuses a missing table by name", async () => {
    const { call } = await connect({ DATABASE_URI: READER });
    const v = (await call("describe_table", { schema: "shop", table: "big_orders" })).json();
    expect(v.kind).toBe("view");
    expect(v.definition).toMatch(/total > 100/);
    const missing = await call("describe_table", { table: "orders" });
    expect(missing.isError).toBe(true);
    expect(missing.text).toMatch(/no table or view "orders" in schema "public"/);
  });
});

describe("query", () => {
  it("returns columns with type names and rows as arrays", async () => {
    const { call } = await connect({ DATABASE_URI: READER });
    const r = (
      await call("query", {
        sql: "SELECT id, total, placed_at, data, payload, big FROM shop.orders WHERE id = $1",
        params: [7],
      })
    ).json();
    expect(r.columns).toEqual([
      { name: "id", type: "integer" },
      { name: "total", type: "numeric" },
      { name: "placed_at", type: "timestamp with time zone" },
      { name: "data", type: "jsonb" },
      { name: "payload", type: "bytea" },
      { name: "big", type: "bigint" },
    ]);
    // Timestamps stay Postgres's text, bytea its hex, bigint a string: no digit lost.
    expect(r.rows).toEqual([[7, "7.00", "2026-11-21 10:00:00+00", { n: 7 }, "\\x0102", "9007199254740993"]]);
    expect(r.more_rows).toBe(false);
  });

  it("caps rows at max_rows, says there were more, and clamps max_rows at 1000", async () => {
    const { call } = await connect({ DATABASE_URI: READER });
    const r = (await call("query", { sql: "SELECT id FROM shop.orders ORDER BY id", max_rows: 5 })).json();
    expect(r.rows).toEqual([[1], [2], [3], [4], [5]]);
    expect(r.more_rows).toBe(true);
    expect(r.note).toMatch(/max_rows=5/);
    const d = (await call("query", { sql: "SELECT id FROM shop.orders" })).json();
    expect(d.row_count).toBe(100);
    const big = (await call("query", { sql: "SELECT g FROM generate_series(1, 5000) g", max_rows: 99999 })).json();
    expect(big.row_count).toBe(1000);
    expect(big.more_rows).toBe(true);
  });

  it("cuts a long cell, and cuts a long result by rows, within the character cap", async () => {
    const { call } = await connect({ DATABASE_URI: READER });
    const cellR = (await call("query", { sql: "SELECT repeat('x', 10000) AS long" })).json();
    expect(cellR.rows[0][0]).toHaveLength(MAX_CELL_CHARS + "…[cut: 10000 characters]".length);
    const wide = await call("query", { sql: "SELECT g, repeat('y', 1500) FROM generate_series(1, 1000) g", max_rows: 1000 });
    expect(wide.text.length).toBeLessThanOrEqual(MAX_RESULT_CHARS);
    const w = wide.json();
    expect(w.more_rows).toBe(true);
    expect(w.row_count).toBeLessThan(1000);
    expect(w.rows).toHaveLength(w.row_count);
    expect(w.note).toMatch(/Cut to \d+ of the 1000 rows/);
  });

  it("runs every statement in a READ ONLY transaction", async () => {
    const { call } = await connect({ DATABASE_URI: ADMIN });
    expect((await call("query", { sql: "SHOW transaction_read_only" })).json().rows).toEqual([["on"]]);
  });

  it("refuses a write the guard cannot see — a data-modifying CTE — even for a superuser", async () => {
    const { call } = await connect({ DATABASE_URI: ADMIN });
    const r = await call("query", { sql: "WITH d AS (DELETE FROM public.canary RETURNING *) SELECT * FROM d" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/READ ONLY transaction/);
    const e = await call("query", { sql: "EXPLAIN ANALYZE DELETE FROM public.canary" });
    expect(e.isError).toBe(true);
    expect(e.text).toMatch(/read-only transaction/);
    const seq = await call("query", { sql: "SELECT nextval('shop.counter')" });
    expect(seq.isError).toBe(true);
    const into = await call("query", { sql: "SELECT * INTO public.stolen FROM public.canary" });
    expect(into.isError).toBe(true);
    const lock = await call("query", { sql: "SELECT * FROM public.canary FOR UPDATE" });
    expect(lock.isError).toBe(true);
    expect(await canary()).toEqual(["alive"]);
    expect((await admin.query("SELECT to_regclass('public.stolen') AS t")).rows[0].t).toBeNull();
  });

  it("refuses multi-statement input before it reaches the database", async () => {
    const { call } = await connect({ DATABASE_URI: ADMIN });
    const r = await call("query", { sql: "SELECT 1; DELETE FROM public.canary" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Only one SQL statement/);
    expect(await canary()).toEqual(["alive"]);
  });

  it("refuses statements that do not read, and the functions a read-only transaction would not stop", async () => {
    const { call } = await connect({ DATABASE_URI: ADMIN });
    for (const sql of [
      "DELETE FROM public.canary",
      "SET TRANSACTION READ WRITE",
      "COMMIT",
      "SELECT pg_terminate_backend(pg_backend_pid())",
      "SELECT set_config('transaction_read_only', 'off', true)",
      "SELECT pg_advisory_lock(1)",
    ]) {
      const r = await call("query", { sql });
      expect(r.isError, sql).toBe(true);
    }
    expect(await canary()).toEqual(["alive"]);
  });

  it("leaves no transaction state behind: a session setting does not reach the next call", async () => {
    const { call } = await connect({ DATABASE_URI: ADMIN });
    for (let i = 0; i < 4; i += 1) {
      expect((await call("query", { sql: "SHOW transaction_read_only" })).json().rows).toEqual([["on"]]);
      expect((await call("query", { sql: "SHOW statement_timeout" })).json().rows).toEqual([["30s"]]);
    }
  });

  it("survives the backend being ended mid-query: an error for the call, not a crash for the process", async () => {
    const { call } = await connect({ DATABASE_URI: READER });
    const pending = call("query", { sql: "SELECT pg_sleep(10) AS slept" });
    let ended = 0;
    for (let i = 0; i < 50 && ended === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      ended = (
        await admin.query(
          `SELECT count(*)::int AS n FROM (SELECT pg_terminate_backend(pid) FROM pg_stat_activity
            WHERE application_name = 'strad-postgres' AND query LIKE '%pg_sleep(10)%' AND pid <> pg_backend_pid()) t`,
        )
      ).rows[0].n;
    }
    expect(ended).toBe(1);
    const r = await pending;
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/57P01|terminat/i);
    // And the mount still serves.
    expect((await call("query", { sql: "SELECT 1 AS one" })).json().rows).toEqual([[1]]);
  });

  it("gives every caller statement its own connection, so no session state outlives it", async () => {
    const { call } = await connect({ DATABASE_URI: READER });
    const a = (await call("query", { sql: "SELECT pg_backend_pid()" })).json().rows[0][0];
    const b = (await call("query", { sql: "SELECT pg_backend_pid()" })).json().rows[0][0];
    expect(a).not.toBe(b);
  });

  it("drops the connection when a result passes the byte budget, before holding it whole", async () => {
    const { call } = await connect({ DATABASE_URI: READER });
    const r = await call("query", { sql: "SELECT repeat('x', 40000000) AS huge", max_rows: 1 });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/passed 16 MB on the wire/);
    expect((await call("query", { sql: "SELECT 1 AS one" })).json().rows).toEqual([[1]]);
  });

  it("refuses SQL-in-a-string executors that would run a refused function", async () => {
    const { call } = await connect({ DATABASE_URI: ADMIN });
    const r = await call("query", { sql: "SELECT query_to_xml('select pg_advisory_lock(42)', true, false, '')" });
    expect(r.isError).toBe(true);
    expect((await admin.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory'")).rows[0].n).toBe(0);
  });

  it("forces standard_conforming_strings on, which the guard assumes", async () => {
    await admin.query("ALTER ROLE strad_reader SET standard_conforming_strings = off");
    try {
      const { call } = await connect({ DATABASE_URI: READER });
      expect((await call("query", { sql: "SHOW standard_conforming_strings" })).json().rows).toEqual([["on"]]);
    } finally {
      await admin.query("ALTER ROLE strad_reader RESET standard_conforming_strings");
    }
  });

  it("accepts a statement that begins with a parenthesis", async () => {
    const { call } = await connect({ DATABASE_URI: READER });
    expect((await call("query", { sql: "(SELECT 1) UNION ALL (SELECT 2)" })).json().rows).toEqual([[1], [2]]);
  });

  it("applies the statement timeout", async () => {
    const { call } = await connect({ DATABASE_URI: READER }, 500);
    const r = await call("query", { sql: "SELECT pg_sleep(3)" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/500 ms statement timeout/);
    // And the connection it ran on is still good.
    expect((await call("query", { sql: "SELECT 1 AS one" })).json().rows).toEqual([[1]]);
  });

  it("reports a SQL error with its code and position", async () => {
    const { call } = await connect({ DATABASE_URI: READER });
    const r = await call("query", { sql: "SELECT nope FROM shop.orders" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Postgres error 42703: column "nope" does not exist/);
    expect(r.text).toMatch(/At character 8/);
  });

  it("validates its arguments", async () => {
    const { call } = await connect({ DATABASE_URI: READER });
    expect((await call("query", {})).text).toMatch(/`sql` is required/);
    expect((await call("query", { sql: "SELECT 1", max_rows: 0 })).text).toMatch(/positive integer/);
    expect((await call("query", { sql: "SELECT $1", params: [{ a: 1 }] })).text).toMatch(/string, number/);
  });
});

describe("credentials and TLS", () => {
  it("never echoes the password or the URI, even when the database rejects them", async () => {
    const wrong = "wrong:pw/@%-but-long";
    const bad = uri("strad_reader", wrong);
    const { call } = await connect({ DATABASE_URI: bad });
    const r = await call("query", { sql: "SELECT 1" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/password authentication failed/);
    expect(r.text).not.toContain(wrong);
    expect(r.text).not.toContain(encodeURIComponent(wrong));
    expect(r.text).not.toContain(bad);
  });

  it("scrubs the password from a result that happens to contain it", async () => {
    const { call } = await connect({ DATABASE_URI: READER });
    const r = await call("query", { sql: "SELECT $1::text AS s", params: [`pw is ${READER_PASSWORD}`] });
    expect(r.text).not.toContain(READER_PASSWORD);
    expect(r.json().rows).toEqual([["pw is [redacted]"]]);
  });

  it("connects over TLS: the session reports ssl", async () => {
    const { call } = await connect({ DATABASE_URI: READER });
    const r = (await call("query", { sql: "SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()" })).json();
    expect(r.rows).toEqual([[true]]);
  });

  it("verify-ca checks the chain against DATABASE_CA_CERT; verify-full also checks the name", async () => {
    if (!ca) return; // POSTGRES_TEST_ADMIN_URL without POSTGRES_TEST_CA
    const withCa = await connect({ DATABASE_URI: uri("strad_reader", READER_PASSWORD, "verify-ca"), DATABASE_CA_CERT: ca });
    expect((await withCa.call("query", { sql: "SELECT 1 AS one" })).isError).toBe(false);
    // The snakeoil certificate is not in any trust store...
    const noCa = await connect({ DATABASE_URI: uri("strad_reader", READER_PASSWORD, "verify-ca") });
    expect((await noCa.call("query", { sql: "SELECT 1" })).text).toMatch(/certificate/i);
    // ...and its name is the image's build host, not 127.0.0.1.
    const full = await connect({ DATABASE_URI: uri("strad_reader", READER_PASSWORD, "verify-full"), DATABASE_CA_CERT: ca });
    const f = await full.call("query", { sql: "SELECT 1" });
    expect(f.isError).toBe(true);
    expect(f.text).toMatch(/altnames|does not match|Hostname/i);
  });

  it("never sends credentials to a server that will not speak TLS", async () => {
    // A listener that answers the SSLRequest with 'N' (no TLS) and records
    // everything it is sent. node-postgres must give up, not fall back.
    const received: Buffer[] = [];
    const sockets: Socket[] = [];
    const plain = createServer((socket) => {
      sockets.push(socket);
      socket.on("data", (chunk) => {
        received.push(chunk);
        socket.write("N");
      });
    });
    await new Promise<void>((r) => plain.listen(0, "127.0.0.1", r));
    const plainPort = (plain.address() as { port: number }).port;
    try {
      const target = `postgres://strad_reader:${encodeURIComponent(READER_PASSWORD)}@127.0.0.1:${plainPort}/db?sslmode=require`;
      const { call } = await connect({ DATABASE_URI: target });
      const r = await call("query", { sql: "SELECT 1" });
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/does not support SSL/);
      const all = Buffer.concat(received);
      // Exactly the 8-byte SSLRequest: length 8, code 80877103. No startup packet, no user, no password.
      expect(all.length).toBe(8);
      expect(all.readInt32BE(0)).toBe(8);
      expect(all.readInt32BE(4)).toBe(80877103);
      expect(all.toString("latin1")).not.toContain("strad_reader");
    } finally {
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => plain.close(() => r()));
    }
  });
});
