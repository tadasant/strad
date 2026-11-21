---
title: Postgres
description: strad's own read-only Postgres server — schemas, tables, one table described, and one read-only statement per call, over TLS, one database per slug.
---

Read a Postgres database from an agent: its schemas, the tables in one schema,
one table in full, and the rows of one read-only statement. The server is
strad's own, `servers/postgres`, over node-postgres, and is served at
`/postgres` in strad's bundle image.

It exists because the bundle is Node only. The server agents used before strad
was `postgres-mcp` (Python, run with `uvx`) in restricted mode; these four tools
are what that mode was used for.

## Tools

Four, all `readOnlyHint: true`.

| Tool             | What it reads                                                                                            |
| ---------------- | -------------------------------------------------------------------------------------------------------- |
| `list_schemas`   | The schemas, with owner and how many relations each holds; system schemas only with `include_system`     |
| `list_tables`    | One schema's tables, views, materialized views and foreign tables, with kind, row estimate, size, comment |
| `describe_table` | One table or view: columns, constraints, indexes, row estimate, comment, and a view's definition         |
| `query`          | The rows of ONE read-only statement, with column names and types                                         |

`query` takes `sql`, optional `params` for `$1`, `$2`, …, and `max_rows`
(default 100, at most 1,000). It says when the statement produced more rows than
it returned. A cell over 2,000 characters is cut where it stands, and a result
over 60,000 characters loses rows from the end until it fits. Both say so. A
call that receives more than 16 MB on the wire is dropped and fails, so one
enormous row is never held whole in the bundle.

Values come back as JSON can carry them without loss: `bigint` and `numeric` as
strings, timestamps and dates as the text Postgres sent, `bytea` as its `\x…`
hex, `json` and `jsonb` as JSON.

## Read-only, three times over

1. **The statement.** One statement per call, beginning `SELECT`, `WITH`,
   `VALUES`, `TABLE`, `EXPLAIN` or `SHOW`. A second statement after a `;` is
   refused before anything is sent, and the extended query protocol it is sent
   over refuses one again at the server. A few functions whose effect is not a
   table write — `pg_terminate_backend`, `set_config`, advisory locks,
   `dblink`, large objects, server file reads — are refused by name, and so are
   the built-ins that run SQL handed to them as a string (`query_to_xml` and its
   family, `cursor_to_xml`, `ts_stat`, `ts_rewrite`).
2. **The transaction.** Every call is `BEGIN TRANSACTION READ ONLY`, a 30-second
   `statement_timeout` and a 5-second `lock_timeout` set with `SET LOCAL`, the
   statement, then `ROLLBACK`. A data-modifying CTE, `EXPLAIN ANALYZE DELETE`,
   `SELECT … INTO`, `FOR UPDATE` and `nextval()` are all refused by Postgres
   there, under any role. Nothing is set on the session, so it works behind a
   transaction-mode PgBouncer. A `query` statement runs on a connection that is
   closed afterwards, so nothing it did to the session outlives the call.
3. **The role.** The URI's role decides what can be seen. Use one that can only
   read — `pg_read_all_data`, or SELECT on what the slug is for. The first two
   layers are on top of it, not in place of it.

## Configuring a slug

| Variable           | Required | What it is                                                                                                       |
| ------------------ | -------- | ---------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URI`     | yes      | `postgres://<role>:<password>@<host>:<port>/<database>?sslmode=require` — `require`, `verify-ca` or `verify-full` |
| `DATABASE_CA_CERT` | no       | The server's CA certificate as PEM, for `verify-ca` or `verify-full`                                             |

```yaml
- slug: pg-example-ro
  kind: supplementary-image
  title: Example database (read-only)
  image: ghcr.io/tadasant/strad-bundle:<version>
  bundle: bundle
  path: /pg-example-ro
  entitlements: [admin]
  env:
    DATABASE_URI: "${DATABASE_URI}"
```

**TLS is required.** A URI with no `sslmode`, or with `disable`, `allow` or
`prefer`, is refused, because each can send the password in cleartext. So is a
URI without a password. `sslmode` means what it means in libpq: `require`
encrypts and does not verify the certificate, which stops an eavesdropper but
not an active man in the middle asking for the password. Prefer `verify-full`
with `DATABASE_CA_CERT` wherever the provider publishes its CA. `verify-ca` checks the chain against `DATABASE_CA_CERT` (or
the system trust store), `verify-full` also checks the host name. No other URI
parameter is accepted; one that is present is refused by name.

**One instance per slug.** A slug on `path: /<its own slug>` gets its own
mount, built from its own `<SLUG>__DATABASE_URI` (the
[per-slug variable mechanism](/operate/secrets/)). `DATABASE_CA_CERT` is read
under the slug's own name only. Two databases are two slugs.

**A slug is served on its own path only.** The renderer bakes each slug's
variables under their bare names too, so the conventional `/postgres` refuses a
bare `DATABASE_URI` that a per-slug slug owns. Without one of its own it lists
its four tools, reports itself `degraded`, and refuses every call by naming the
variable.

## What never comes back

The URI and its password, raw, percent-encoded and JSON-escaped, are scrubbed from every result
and every error, and any other `postgres://` URI's password is too. A
configuration error names the variable and the rule it broke, never the value.
A server that will not speak TLS is sent nothing but the 8-byte TLS request.

:::caution
Its tests run against a real Postgres 17 in Docker, with TLS on. No managed
Postgres or PgBouncer has been in front of it yet. See
[Limitations #161](/limitations/).
:::
