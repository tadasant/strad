import pg from "pg";
import Cursor from "pg-cursor";

import type { PostgresConfig } from "./config.js";

/**
 * How a statement reaches the database: in a READ ONLY transaction that is
 * always rolled back, under a statement timeout, through a cursor that never
 * fetches more rows than the caller may see.
 *
 * EVERY CALL IS ITS OWN TRANSACTION, and the transaction carries the whole
 * posture: `BEGIN TRANSACTION READ ONLY`, then `SET LOCAL` for the statement,
 * lock and idle timeouts, then the statement, then `ROLLBACK`. Nothing is set
 * on the session or in the startup packet, for two reasons. A session setting
 * can be changed back by the next statement on that session, and a transaction
 * one cannot outlive the transaction. And a PgBouncer in transaction mode — the
 * connection pool a managed Postgres puts in front of the database — refuses
 * startup parameters it does not know and hands each transaction a different
 * server connection, so a setting made anywhere but inside the transaction is
 * one this server cannot rely on.
 *
 * THE CURSOR IS THE ROW CAP. A `SELECT * FROM events` on a large table would
 * otherwise be read into this process whole before a cap could cut it — and
 * this process is the bundle, beside thirty-odd other servers. A cursor reads
 * `maxRows + 1` and stops; the `+ 1` is how the result knows to say there was
 * more. It also sends the statement over the extended query protocol, where the
 * server itself refuses two commands in one statement.
 *
 * A CLIENT-SIDE DEADLINE BACKS THE SERVER'S. `statement_timeout` is enforced by
 * Postgres; a network that stops answering is not. Past the statement timeout
 * plus a grace, the connection is destroyed rather than returned to the pool.
 */

export const STATEMENT_TIMEOUT_MS = 30_000;
export const LOCK_TIMEOUT_MS = 5_000;
export const CONNECT_TIMEOUT_MS = 10_000;
/** How long past the statement timeout the client waits before it gives up on the socket. */
const DEADLINE_GRACE_MS = 5_000;
const ROLLBACK_TIMEOUT_MS = 5_000;
/** What one call may receive on the wire before the connection is dropped. */
export const MAX_RESPONSE_BYTES = 16 * 1_048_576;

export class QueryError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "QueryError";
  }
}

/**
 * Values come back as JSON can carry them. Dates and timestamps stay the text
 * Postgres sent (a JS Date would move a `timestamp without time zone` into the
 * container's zone); bytea stays its `\x...` hex text rather than a Buffer;
 * int8 and numeric stay strings, node-postgres's default, so no digit is lost.
 */
const RAW_TEXT_OIDS = new Set([
  17, // bytea
  1001, // bytea[]
  1082, // date
  1182, // date[]
  1083, // time
  1266, // timetz
  1114, // timestamp
  1115, // timestamp[]
  1184, // timestamptz
  1185, // timestamptz[]
  1186, // interval
  1187, // interval[]
]);

const identity = (value: string) => value;

const TYPES = {
  getTypeParser: ((oid: number, format?: "text" | "binary") =>
    RAW_TEXT_OIDS.has(oid) ? identity : pg.types.getTypeParser(oid, format)) as typeof pg.types.getTypeParser,
};

function sslOptions(config: PostgresConfig): pg.ClientConfig["ssl"] {
  const ca = config.ca === undefined ? {} : { ca: config.ca };
  switch (config.sslmode) {
    case "require":
      // libpq's `require`: encrypted, certificate not checked.
      return { rejectUnauthorized: false };
    case "verify-ca":
      // The chain is checked; the name on the certificate is not.
      return { ...ca, rejectUnauthorized: true, checkServerIdentity: () => undefined };
    case "verify-full":
      // node-postgres sets SNI to the host itself, and checks the name against it.
      return { ...ca, rejectUnauthorized: true };
  }
}

export interface Column {
  name: string;
  type: string;
}

export interface RowsResult {
  columns: Column[];
  rows: unknown[][];
  /** True when the statement produced more than `maxRows` rows. */
  more: boolean;
}

export interface Runner {
  /** Run fixed, server-authored SQL (the catalog tools). */
  catalog: <T extends pg.QueryResultRow>(sql: string, params?: unknown[]) => Promise<T[]>;
  /** Run a caller's statement, already through `checkReadOnlySql`. */
  statement: (sql: string, params: unknown[], maxRows: number) => Promise<RowsResult>;
  close: () => Promise<void>;
}

export interface RunnerOptions {
  statementTimeoutMs?: number;
}

/**
 * One pool per configured database. The pool is small — two connections — on
 * purpose: this is an agent's window onto a production database, not an
 * application's connection pool, and a third concurrent call waiting for a
 * connection is better than a third connection the database must hold.
 */
export function createRunner(config: PostgresConfig, options: RunnerOptions = {}): Runner {
  const statementTimeoutMs = options.statementTimeoutMs ?? STATEMENT_TIMEOUT_MS;
  const pool = new pg.Pool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    ssl: sslOptions(config),
    application_name: "strad-postgres",
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    idleTimeoutMillis: 30_000,
    max: 2,
    allowExitOnIdle: true,
    keepAlive: true,
    types: TYPES,
  });
  // An idle connection the server drops emits 'error' on the POOL. Unheard, that
  // is an uncaught exception, in a process that hosts every other bundle mount.
  pool.on("error", () => {});

  const inReadOnlyTransaction = async <T>(
    work: (client: pg.PoolClient) => Promise<T>,
    { discard }: { discard: boolean },
  ): Promise<T> => {
    let client: pg.PoolClient;
    try {
      client = await pool.connect();
    } catch (error) {
      throw new QueryError(`Could not connect to Postgres: ${describe(error)}`);
    }
    // A CHECKED-OUT client's 'error' is not the pool's: pg-pool removes its own
    // listener while a client is out. A backend ended mid-call (a failover, an
    // admin's pg_terminate_backend, a reset) would otherwise be an uncaught
    // exception in the process every bundle mount shares. The failure still
    // reaches the caller, as the rejected query.
    let broken = discard;
    const onError = () => {
      broken = true;
    };
    client.on("error", onError);
    const timers: NodeJS.Timeout[] = [];
    const fail = (ms: number, message: string) =>
      new Promise<never>((_, reject) => {
        timers.push(
          setTimeout(() => {
            broken = true;
            reject(new QueryError(message));
          }, ms),
        );
      });
    // The row cap bounds rows, not bytes: one row can be a gigabyte. Count what
    // arrives on the socket and drop the connection past the budget, before the
    // driver has assembled the whole of it in this process.
    const stream = (client as unknown as { connection?: { stream?: NodeJS.ReadableStream & { destroy?: () => void } } })
      .connection?.stream;
    let received = 0;
    let overBudget: ((error: QueryError) => void) | undefined;
    const budget = new Promise<never>((_, reject) => {
      overBudget = reject;
    });
    budget.catch(() => {});
    const onData = (chunk: Buffer) => {
      received += chunk.length;
      if (received > MAX_RESPONSE_BYTES && overBudget) {
        broken = true;
        const reject = overBudget;
        overBudget = undefined;
        reject(
          new QueryError(
            `The result passed ${MAX_RESPONSE_BYTES / 1_048_576} MB on the wire and the connection was ` +
              `dropped. Select fewer or narrower columns (left(col, n) for a long text), or fewer rows.`,
          ),
        );
        stream?.destroy?.();
      }
    };
    stream?.on("data", onData);
    try {
      const run = (async () => {
        await client.query("BEGIN TRANSACTION READ ONLY");
        // Integers and constants this module owns, never caller input: safe to
        // inline, and SET takes no bind parameters. standard_conforming_strings
        // is what `sql.ts` assumes when it decides where a string ends; a role
        // or database that turned it off would read a string differently.
        await client.query(
          `SET LOCAL statement_timeout = ${Math.floor(statementTimeoutMs)}; ` +
            `SET LOCAL lock_timeout = ${LOCK_TIMEOUT_MS}; ` +
            `SET LOCAL idle_in_transaction_session_timeout = ${Math.floor(statementTimeoutMs + DEADLINE_GRACE_MS)}; ` +
            `SET LOCAL standard_conforming_strings = on`,
        );
        return await work(client);
      })();
      run.catch(() => {});
      return await Promise.race([
        run,
        budget,
        fail(
          statementTimeoutMs + DEADLINE_GRACE_MS,
          `Postgres did not answer within ${statementTimeoutMs + DEADLINE_GRACE_MS} ms; the connection was dropped.`,
        ),
      ]);
    } catch (error) {
      if (error instanceof QueryError) throw error;
      throw toQueryError(error, statementTimeoutMs);
    } finally {
      for (const t of timers) clearTimeout(t);
      stream?.removeListener("data", onData);
      if (!broken) {
        // ROLLBACK gets its own short deadline: a stall here would otherwise
        // pin a pool slot for as long as TCP takes to give up.
        try {
          await Promise.race([
            client.query("ROLLBACK"),
            fail(ROLLBACK_TIMEOUT_MS, "ROLLBACK did not answer; the connection was dropped."),
          ]);
        } catch {
          broken = true;
        }
        for (const t of timers) clearTimeout(t);
      }
      client.removeListener("error", onError);
      // A broken connection is destroyed rather than returned. Its 'error' may
      // still fire after release, so it keeps a listener that ignores it.
      if (broken) client.on("error", () => {});
      client.release(broken ? true : undefined);
    }
  };

  return {
    catalog: async <T extends pg.QueryResultRow>(sql: string, params: unknown[] = []) =>
      await inReadOnlyTransaction(async (client) => (await client.query<T>(sql, params)).rows, {
        discard: false,
      }),

    // A caller's statement always gets a connection nobody else will use: a
    // session-level effect a function managed despite the guard (an advisory
    // lock, a session variable) ends with it instead of outliving the ROLLBACK
    // on a pooled session.
    statement: async (sql, params, maxRows) =>
      await inReadOnlyTransaction(
        async (client) => {
          const cursor = client.query(new Cursor(sql, params, { rowMode: "array" }));
          const { rows, fields } = await new Promise<{ rows: unknown[][]; fields: pg.FieldDef[] }>(
            (resolve, reject) => {
              cursor.read(maxRows + 1, (error, rows, result) => {
                if (error) reject(error);
                else resolve({ rows: rows as unknown as unknown[][], fields: result?.fields ?? [] });
              });
            },
          );
          await cursor.close();
          const names = await typeNames(client, fields);
          return {
            columns: fields.map((f) => ({ name: f.name, type: names.get(f.dataTypeID) ?? String(f.dataTypeID) })),
            rows: rows.slice(0, maxRows),
            more: rows.length > maxRows,
          };
        },
        { discard: true },
      ),

    close: async () => {
      await pool.end().catch(() => {});
    },
  };
}

async function typeNames(client: pg.PoolClient, fields: pg.FieldDef[]): Promise<Map<number, string>> {
  const oids = [...new Set(fields.map((f) => f.dataTypeID))];
  if (oids.length === 0) return new Map();
  const { rows } = await client.query<{ oid: number; name: string }>(
    "SELECT oid::int AS oid, format_type(oid, NULL) AS name FROM pg_catalog.pg_type WHERE oid = ANY($1::oid[])",
    [oids],
  );
  return new Map(rows.map((r) => [r.oid, r.name]));
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" && !error.message.includes(code) ? `${error.message} (${code})` : error.message;
  }
  return String(error);
}

/** A driver error, said in terms a caller can act on. The message is scrubbed by the server. */
function toQueryError(error: unknown, statementTimeoutMs: number): QueryError {
  const e = error as { message?: string; code?: string; detail?: string; hint?: string; position?: string };
  const message = typeof e?.message === "string" ? e.message : String(error);
  switch (e?.code) {
    case "57014":
      return new QueryError(
        `The statement ran past the ${statementTimeoutMs} ms statement timeout and was cancelled. ` +
          `Narrow it: a WHERE on an indexed column, a LIMIT, or fewer joins.`,
        e.code,
      );
    case "25006":
      return new QueryError(
        `Refused by the database: ${message}. Every statement here runs in a READ ONLY ` +
          `transaction, so nothing that writes can run.`,
        e.code,
      );
    case "55P03":
      return new QueryError(
        `The statement waited past the ${LOCK_TIMEOUT_MS} ms lock timeout and was cancelled.`,
        e.code,
      );
  }
  const parts = [`Postgres error${e?.code ? ` ${e.code}` : ""}: ${message}`];
  if (e?.detail) parts.push(`Detail: ${e.detail}`);
  if (e?.hint) parts.push(`Hint: ${e.hint}`);
  if (e?.position) parts.push(`At character ${e.position}.`);
  return new QueryError(parts.join(" "), e?.code);
}
