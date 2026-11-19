# Messenger MCP server

strad's Facebook Messenger server: READ-ONLY access to one personal account,
through a headless [mautrix-meta](https://github.com/mautrix/meta) logged in as
a device of its own. The full page, with login and operations, is
`docs/servers/messenger` on the docs site. This file is what someone working in
the tree needs.

## Two halves, two licences

| Directory | Language | Licence | What it is |
| --- | --- | --- | --- |
| `shared/` | TypeScript | MIT (strad's) | the MCP server: tools, config, the sealed snapshot to GCS, the lease, supervising the Go program |
| `bridge/` | Go | **AGPL-3.0** (`bridge/LICENSE`) | `strad-messenger-bridge`: mautrix-meta's network connector run headless, behind a loopback JSON API |

mautrix-meta is AGPL-3.0, so anything that links it is too. `bridge/` links it
and carries the AGPL; `shared/` never imports a line of it and talks to the
running program over `127.0.0.1` with a per-spawn bearer token. The two are an
aggregate, not one work, and the source of the AGPL program is this directory of
this public repository.

## How the Go program works

mautrix-meta is a bridgev2 **network** connector. It reaches Matrix only through
bridgev2's `MatrixConnector` and `MatrixAPI` interfaces, and `bridge/headless.go`
implements those against SQLite (`bridge/record.go`) instead of a homeserver:
a room is a row id, a send is an insert, an edit or an unsend updates the row
and moves it to the end of the cursor order. Login steps (`bridge/login.go`) are
bridgev2's own `LoginProcess`, held one at a time and advanced by the admin
tools. Media is direct media: a row carries Meta's descriptor and
`GET /attachment` downloads on demand. A file Meta cannot hand over that way is
kept in `strad_blob` if it is 2 MB or less.

The loopback protocol (`bridge/api.go`): stdout carries one JSON event per line
(`listening`, `login_complete`, `stopped`, or `fatal`); stderr is the log and is
never parsed; every request carries `Authorization: Bearer <token>`.

## Tools

| Tool | Group |
| --- | --- |
| `messenger_status` | readonly |
| `messenger_list_threads` | readonly |
| `messenger_get_messages` | readonly |
| `messenger_get_attachment` | readonly |
| `messenger_login_start` | admin |
| `messenger_login_submit` | admin |
| `messenger_login_cancel` | admin |
| `messenger_logout` | admin |

No send tool, by design. `servers/bundle/scripts/smoke.mjs` pins the eight names.

## Environment

Required: `MESSENGER_STATE_ENCRYPTION_KEY` and the shared state store's
`STRAD_STATE_GCS_BUCKET`, `STRAD_STATE_GCS_CLIENT_EMAIL`,
`STRAD_STATE_GCS_PRIVATE_KEY`. Optional: `MESSENGER_STATE_PREFIX` (default
`messenger`), `MESSENGER_BUFFER_MAX_AGE_DAYS` (30), `MESSENGER_PROXY`.

The Go program is handed only its own settings, never the container's
environment (`shared/src/sidecar.ts`, `childEnv`).

## One instance

One Messenger device is one connection. The renderer refuses `instanceCount > 1`
for a bundle serving `/messenger`, and the lease in `shared/src/bridge.ts`
handles the overlap a deploy creates anyway.

## mautrix-meta is a patched copy

`bridge/third_party/mautrix-meta` is mautrix-meta's module with strad's deltas
(today: one, the Bloks interpreter's `bk.action.callback.Make`, which the
phone-app login's authenticator-code step needs). `bridge/go.mod` builds against
it through a `replace`. `bridge/third_party/README.md` has the delta table, the
diff that checks the copy against upstream, and the steps for moving to a newer
release; each delta has a test in `bridge/` that fails if a re-copy drops it.

## Tests

```
cd servers/messenger && npm ci && npm test
docker run --rm -v "$PWD/bridge:/src" -w /src golang:1.27-bookworm go test ./...
```

Nothing in CI talks to Meta. Every identifier in the fixtures is invented.
