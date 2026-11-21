# Postgres MCP server

strad's own read-only server for one Postgres database: list schemas, list
tables, describe a table, and run one read-only statement. Four tools, all
`readOnlyHint: true`, over node-postgres. Docs: `docs/servers/postgres`.

## Environment

| Variable           | Required | What it is                                                                                  |
| ------------------ | -------- | ------------------------------------------------------------------------------------------- |
| `DATABASE_URI`     | yes      | `postgres://role:password@host:port/db?sslmode=require` (or `verify-ca`, `verify-full`)      |
| `DATABASE_CA_CERT` | no       | The server's CA certificate as PEM, for `verify-ca` / `verify-full`                         |

Read on each call from the environment the server was given, never at boot.
`tools/list` works without them. A URI without `sslmode=require` or stricter is
refused, and so is any other URI parameter.

## Read-only

- `src/sql.ts` — one statement, beginning with a read keyword, calling none of
  the side-effect functions a read-only transaction would not stop.
- `src/query.ts` — every call is `BEGIN TRANSACTION READ ONLY`, `SET LOCAL`
  timeouts, the statement through a cursor capped at `max_rows + 1`, `ROLLBACK`.
- The role in the URI. Make it a read-only one; the two above are on top of it.

The URI and password are scrubbed from every result and error. See `HACKS.md`
#161.

## Tests

```
cd servers/postgres && npm ci && npm test
```

The suite starts `postgres:17` in Docker with TLS on, and tears it down after.
Set `POSTGRES_TEST_ADMIN_URL` (a superuser URI, no `sslmode`, on a TLS-enabled
server) and optionally `POSTGRES_TEST_CA` to use a server you started instead.
There is no skip when Docker is missing.
