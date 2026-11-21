import { describe, expect, it } from "vitest";

import { checkReadOnlySql, SqlRejected } from "../src/index.js";

const ok = (sql: string) => checkReadOnlySql(sql);
const refused = (sql: string) => expect(() => checkReadOnlySql(sql)).toThrow(SqlRejected);

describe("the statement guard", () => {
  it("accepts one read statement of each allowed kind", () => {
    for (const sql of [
      "SELECT 1",
      "select * from users where id = $1",
      "WITH x AS (SELECT 1) SELECT * FROM x",
      "VALUES (1), (2)",
      "TABLE users",
      "EXPLAIN SELECT 1",
      "SHOW server_version",
      "(SELECT 1) UNION (SELECT 2)",
      "((SELECT 1))",
      "  -- a leading comment\n  SELECT 1",
      "/* a /* nested */ comment */ SELECT 1",
    ]) {
      expect(ok(sql)).toBe(sql.trim());
    }
  });

  it("drops one trailing semicolon, and trailing comments after it", () => {
    expect(ok("SELECT 1;")).toBe("SELECT 1");
    expect(ok("SELECT 1 ;  -- done\n")).toBe("SELECT 1");
    expect(ok("SELECT 1;;")).toBe("SELECT 1");
  });

  it("refuses more than one statement", () => {
    refused("SELECT 1; SELECT 2");
    refused("SELECT 1; DROP TABLE users");
    refused("SELECT 1;\n/* x */ DELETE FROM users");
    expect(() => ok("SELECT 1; SELECT 2")).toThrow(/Only one SQL statement/);
  });

  it("does not mistake a semicolon inside a string, identifier, comment or dollar quote for a second statement", () => {
    expect(ok("SELECT ';' AS s")).toBe("SELECT ';' AS s");
    expect(ok("SELECT 'it''s; fine'")).toBe("SELECT 'it''s; fine'");
    expect(ok("SELECT E'a\\'; b'")).toBe("SELECT E'a\\'; b'");
    expect(ok('SELECT 1 AS "a;b"')).toBe('SELECT 1 AS "a;b"');
    expect(ok("SELECT 1 -- ; DROP TABLE x\n")).toBe("SELECT 1 -- ; DROP TABLE x");
    expect(ok("SELECT $$ ; DROP TABLE x $$")).toBe("SELECT $$ ; DROP TABLE x $$");
    expect(ok("SELECT $tag$ ; $$ ; $tag$")).toBe("SELECT $tag$ ; $$ ; $tag$");
  });

  it("does not let a string hide the end of itself", () => {
    // The E'' escape: \' does not end the string, so the `;` is inside it...
    expect(ok("SELECT E'\\'; DELETE FROM x'")).toBeTruthy();
    // ...whereas in a plain string a backslash escapes nothing, so this IS two statements.
    refused("SELECT '\\'; DELETE FROM x");
  });

  it("refuses unterminated strings, identifiers, comments and dollar quotes", () => {
    refused("SELECT 'abc");
    refused('SELECT "abc');
    refused("SELECT /* abc");
    refused("SELECT /* /* */ abc");
    refused("SELECT $x$ abc");
  });

  it("refuses statements that do not begin with a read keyword", () => {
    for (const sql of [
      "INSERT INTO t VALUES (1)",
      "UPDATE t SET a = 1",
      "DELETE FROM t",
      "DROP TABLE t",
      "TRUNCATE t",
      "COPY t TO STDOUT",
      "SET TRANSACTION READ WRITE",
      "SET default_transaction_read_only = off",
      "COMMIT",
      "BEGIN",
      "DO $$ BEGIN END $$",
      "CALL p()",
      "GRANT SELECT ON t TO x",
      "LISTEN x",
      "VACUUM t",
      '"SELECT" 1',
    ]) {
      refused(sql);
    }
    expect(() => ok("DELETE FROM t")).toThrow(/begins with DELETE/);
  });

  it("refuses functions whose effect a read-only transaction does not stop", () => {
    for (const sql of [
      "SELECT pg_terminate_backend(123)",
      "SELECT pg_cancel_backend (123)",
      "SELECT pg_catalog.pg_terminate_backend(1)",
      'SELECT "pg_terminate_backend"(1)',
      "SELECT PG_RELOAD_CONF()",
      "SELECT set_config('transaction_read_only', 'off', true)",
      "SELECT pg_advisory_lock(1)",
      "SELECT pg_try_advisory_lock(1)",
      "SELECT * FROM dblink('host=x', 'DELETE FROM t') AS t(a int)",
      "SELECT pg_read_file('/etc/passwd')",
      "SELECT lo_export(1, '/tmp/x')",
      "SELECT pg_notify('c', 'x')",
      "WITH x AS (SELECT pg_terminate_backend(1)) SELECT * FROM x",
      // SQL inside a string, executed by a built-in the guard cannot read into.
      "SELECT query_to_xml('select pg_advisory_lock(42)', true, false, '')",
      "SELECT query_to_xmlschema('select 1', true, false, '')",
      "SELECT cursor_to_xml('c', 1, true, false, '')",
      "SELECT ts_stat('select pg_advisory_lock(7)::text::tsvector')",
      "SELECT ts_rewrite('a'::tsquery, 'select 1')",
    ]) {
      refused(sql);
    }
  });

  it("does not refuse those names where they are not calls", () => {
    expect(ok("SELECT 'pg_terminate_backend(1)'")).toBeTruthy();
    expect(ok("SELECT set_config_value FROM settings")).toBeTruthy();
    expect(ok("SELECT lo_count FROM t")).toBeTruthy();
    expect(ok("SELECT 1 -- pg_terminate_backend(1)\n")).toBeTruthy();
  });

  it("refuses unicode-escaped names and strings, which could spell a refused function", () => {
    refused('SELECT U&"pg\\005fterminate_backend"(1)');
    refused("SELECT U&'\\0041'");
  });

  it("refuses empty input", () => {
    refused("");
    refused("   ");
    refused("-- only a comment");
    refused(";");
  });
});
