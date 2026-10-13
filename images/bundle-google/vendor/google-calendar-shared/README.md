# google-calendar, without strad

This is the Google Calendar MCP server strad serves at `/google-calendar`. You
can run it on its own, with no strad gateway and none of the other Google
servers: over **stdio** for a local MCP client, or over **Streamable HTTP** on a
localhost port.

`src/` here is vendored verbatim from
[`pulsemcp/mcp-servers`](https://github.com/pulsemcp/mcp-servers/tree/main/experimental/google-calendar)
(`experimental/google-calendar/shared`). This README is strad's and is not part
of that copy. The standalone entrypoint is strad's too, and lives outside the tree
in `../../src/standalone/google-calendar.ts`, so the tree stays a clean copy.

## Tools

Seven, in two groups:

| Group       | Tools                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------ |
| `readonly`  | `list_calendar_events`, `get_calendar_event`, `list_calendars`, `query_calendar_freebusy` |
| `readwrite` | the four above, plus `create_calendar_event`, `update_calendar_event`, `delete_calendar_event` |

All seven are served unless you set `GOOGLE_CALENDAR_ENABLED_TOOLGROUPS`.

## Build

You need Node 22 or later. The server is one npm workspace of the
`images/bundle-google` package, so install and build from there:

```bash
git clone https://github.com/tadasant/strad.git
cd strad/images/bundle-google
npm ci
npm run build
```

This builds every workspace in the package. The entrypoint is then
`dist/standalone/google-calendar.js`. The examples below run from
`images/bundle-google`. From anywhere else, use the absolute path to that file.

## Credentials

The server authenticates as a Google **service account with domain-wide
delegation** and acts as one user in your Workspace domain. It has no OAuth
mode, so a personal `@gmail.com` calendar is out of reach.

| Variable                             | What it is                                                                                     |
| ------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `GCAL_SERVICE_ACCOUNT_CLIENT_EMAIL`  | the service account's email (`client_email` in its JSON key)                                   |
| `GCAL_SERVICE_ACCOUNT_PRIVATE_KEY`   | its PEM private key (`private_key`). Literal `\n` sequences are turned into newlines           |
| `GCAL_IMPERSONATE_EMAIL`             | the Workspace user whose calendars the server reads and writes                                 |
| `GOOGLE_CALENDAR_ENABLED_TOOLGROUPS` | optional: `readonly` or `readwrite`. The upstream name `ENABLED_TOOLGROUPS` works when this is unset |

Before the key works, a Workspace admin has to authorize the service account's
client ID for `https://www.googleapis.com/auth/calendar` under **Admin Console →
Security → API Controls → Domain-wide Delegation**.

None of the credentials is needed to start. The server reads them on the first
tool call, so with nothing set it still boots and answers `tools/list`, and every
tool call returns an error naming the missing variable. It says so on stderr at
startup.

## Run it locally (stdio)

stdio is the default transport:

```bash
GCAL_SERVICE_ACCOUNT_CLIENT_EMAIL=calendar-bot@my-project.iam.gserviceaccount.com \
GCAL_SERVICE_ACCOUNT_PRIVATE_KEY="$(jq -r .private_key key.json)" \
GCAL_IMPERSONATE_EMAIL=you@example.com \
node dist/standalone/google-calendar.js
```

Start it with `node` directly, not through `npm run`. npm prints a banner to
stdout, and in stdio mode stdout carries only protocol messages. The server logs
to stderr.

An MCP client launches the process itself. For Claude Desktop
(`claude_desktop_config.json`), or any client that reads the same `mcpServers`
shape:

```json
{
  "mcpServers": {
    "google-calendar": {
      "command": "node",
      "args": ["/absolute/path/to/strad/images/bundle-google/dist/standalone/google-calendar.js"],
      "env": {
        "GCAL_SERVICE_ACCOUNT_CLIENT_EMAIL": "calendar-bot@my-project.iam.gserviceaccount.com",
        "GCAL_SERVICE_ACCOUNT_PRIVATE_KEY": "-----BEGIN PRIVATE KEY-----\\n...\\n-----END PRIVATE KEY-----\\n",
        "GCAL_IMPERSONATE_EMAIL": "you@example.com"
      }
    }
  }
}
```

For Claude Code:

```bash
claude mcp add google-calendar \
  -e GCAL_SERVICE_ACCOUNT_CLIENT_EMAIL=calendar-bot@my-project.iam.gserviceaccount.com \
  -e GCAL_SERVICE_ACCOUNT_PRIVATE_KEY="$(jq -r .private_key key.json)" \
  -e GCAL_IMPERSONATE_EMAIL=you@example.com \
  -- node /absolute/path/to/strad/images/bundle-google/dist/standalone/google-calendar.js
```

## Run it as an HTTP service on localhost

```bash
node dist/standalone/google-calendar.js --transport http --port 3100
# [google-calendar] serving MCP on http://127.0.0.1:3100/mcp
```

| Setting   | How                                                    | Default     |
| --------- | ------------------------------------------------------ | ----------- |
| transport | `--transport stdio` or `--transport http`              | `stdio`     |
| port      | `--port N`, else the `PORT` env var                    | `3000`      |
| host      | `--host H`                                             | `127.0.0.1` |

The MCP endpoint is `/mcp` (Streamable HTTP). `GET /healthz` returns
`{"ok":true,"server":"google-calendar"}` and never contacts Google. The
credentials are the same environment variables as in stdio mode.

The server is stateless. It builds a fresh server for every request and issues
no session id, so any number of clients can share it.

To check it, list the tools with curl:

```bash
curl -s http://127.0.0.1:3100/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

or open it in the MCP Inspector, with transport **Streamable HTTP** and URL
`http://127.0.0.1:3100/mcp`:

```bash
npx @modelcontextprotocol/inspector
```

A client that speaks Streamable HTTP connects with just the URL. In Claude Code:

```bash
claude mcp add --transport http google-calendar http://127.0.0.1:3100/mcp
```

**The HTTP endpoint has no authentication.** Anyone who can reach the port can
act as `GCAL_IMPERSONATE_EMAIL`. On the default loopback host it refuses any
request whose `Host` header is not loopback, so a web page in your browser cannot
reach it through DNS rebinding. `--host 0.0.0.0` turns that check off and exposes
the server to your network. Do that only behind something that authenticates.
Authenticating callers is what strad adds in front of this server.

## Tests

`test/standalone.test.ts` in `images/bundle-google` covers both modes against
the built entrypoint, with no credentials set. It checks the handshake,
`tools/list`, the port flag and env var, the tool-group toggle, the `Host`
check, and that a tool call fails on missing credentials instead of crashing the
server. `npm test` from `images/bundle-google` runs it.
