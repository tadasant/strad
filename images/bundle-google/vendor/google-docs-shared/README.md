# google-docs, without strad

This is the Google Docs MCP server strad serves at `/google-docs`. It reads,
edits, exports, comments-lists and shares the Google Docs one account can
reach. You can run it on its own, with no strad gateway and none of the other
Google servers: over **stdio** for a local MCP client, or over **Streamable
HTTP** on a localhost port.

`src/` here is vendored **verbatim** from
[`pulsemcp/mcp-servers`](https://github.com/pulsemcp/mcp-servers/tree/main/experimental/google-docs)
(`experimental/google-docs/shared`). Do not edit it here: a re-vendor copies
upstream `src/` over this tree. This README is strad's and is not part of that
copy. strad's own code for this server lives outside the tree:
`../../src/docs.ts` is the per-account layer the bundle mounts (the credential
and the tool-group toggle), and `../../src/standalone/google-docs.ts` is the
standalone entrypoint, which hands that same layer to the shared runner.

## Tools

Eleven, in three groups. Each group holds the one before it:

| Group                | Tools                                                                                                                       |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `readonly`           | `get_document`, `get_document_outline`, `export_document`, `list_comments`                                                  |
| `readwrite`          | the four above, plus `create_document`, `update_document`, `append_text`, `insert_text`, `replace_text`, `delete_document` |
| `readwrite_external` | the ten above, plus `share_document`                                                                                        |

- `get_document` returns a document's title, heading outline and plain-text
  body, or the raw Docs API resource with `format=json`.
  `get_document_outline` returns the headings alone.
- `export_document` exports through Drive: `markdown`, `html` and `txt` come
  back as text, `pdf`, `docx`, `odt`, `rtf` and `epub` as base64.
- `list_comments` lists comments with their quoted text, replies and resolved
  state.
- `update_document` takes raw Docs `batchUpdate` requests: styling, tables,
  lists, deletions. `append_text`, `insert_text` and `replace_text` are
  wrappers over it for the common cases.
- `delete_document` moves a document to Drive's trash, recoverable for 30
  days. With `permanent=true` it deletes it for good.
- `share_document` adds a Drive permission: a user, group, domain or anyone
  with the link, as reader, commenter or writer. Google emails a user or group
  it is shared with. It is the one tool that sends a document to someone else,
  which is why it has a group of its own.

**Every group is served unless you set `GOOGLE_DOCS_ENABLED_TOOLGROUPS`**, and
that includes `share_document`. Set the group you mean. The server refuses to
start on a group it does not recognise (`read-only`, say) and exits 2, instead
of reading the typo as "every group".

## Build

You need Node 22 or later. The server is one npm workspace of the
`images/bundle-google` package, so install and build from there:

```bash
git clone https://github.com/tadasant/strad.git
cd strad/images/bundle-google
npm ci
npm run build
```

The entrypoint is then `dist/standalone/google-docs.js`. The examples below run
from `images/bundle-google`. From anywhere else, use the absolute path to that file.

## Credentials

The server acts as **one Google account**, in one of two modes.

**OAuth (a refresh token).** Any Google account, personal `@gmail.com` or
Workspace. This is the one to use on your own machine.

| Variable                          | What it is                                                     |
| --------------------------------- | -------------------------------------------------------------- |
| `GOOGLE_DOCS_OAUTH_CLIENT_ID`     | your OAuth client's id                                         |
| `GOOGLE_DOCS_OAUTH_CLIENT_SECRET` | its secret                                                     |
| `GOOGLE_DOCS_OAUTH_REFRESH_TOKEN` | a refresh token for the account, consented for the scopes below |

**Service account (domain-wide delegation).** A Workspace user's documents,
reached through a service account a Workspace admin has authorized.

| Variable                                   | What it is                                                     |
| ------------------------------------------ | -------------------------------------------------------------- |
| `GOOGLE_DOCS_SERVICE_ACCOUNT_CLIENT_EMAIL` | the service account's email                                    |
| `GOOGLE_DOCS_SERVICE_ACCOUNT_PRIVATE_KEY`  | its PEM private key. Literal `\n` sequences are turned into newlines |
| `GOOGLE_DOCS_IMPERSONATE_EMAIL`            | the Workspace user whose documents it reads                    |

If all three OAuth variables are set, OAuth wins. Set one mode, not both.
`GOOGLE_DOCS_ENABLED_TOOLGROUPS` (optional) is `readonly`, `readwrite` or
`readwrite_external`, comma-separated if you want more than one.

**Scopes.** The token's scopes are what Google enforces. The tool group only
decides which tools a client sees.

| Group                               | Consent for                                                                                                         |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `readonly`                          | `https://www.googleapis.com/auth/documents.readonly` and `https://www.googleapis.com/auth/drive.readonly`          |
| `readwrite` and `readwrite_external` | `https://www.googleapis.com/auth/documents` and `https://www.googleapis.com/auth/drive`                             |

The Drive scope is not optional. `export_document`, `list_comments`,
`delete_document` and `share_document` go through the Drive API, and
`drive.file` only reaches documents this OAuth client created, so it is not
enough for documents you already have. Both Drive scopes reach every file in
the account, not just Docs.

For a read-only server, consent the two `.readonly` scopes and set
`GOOGLE_DOCS_ENABLED_TOOLGROUPS=readonly`. Google then refuses a write even if
one reached it.

**Getting a refresh token** with the OAuth Playground:

1. In a Google Cloud project, enable the **Google Docs API** and the **Google
   Drive API**, and create an OAuth client of type **Web application** with the
   authorized redirect URI `https://developers.google.com/oauthplayground`.
2. Open <https://developers.google.com/oauthplayground>, click the gear, tick
   **Use your own OAuth credentials** and paste the client id and secret.
3. In "Input your own scopes", enter the two scopes for your group from the
   table above, separated by a space. Click **Authorize APIs** and sign in as
   the account the server should use.
4. Click **Exchange authorization code for tokens** and copy the refresh token.

While the OAuth consent screen is in **Testing** mode, Google expires the
refresh token after 7 days. Every call then fails with `invalid_grant`. That
error's hint names strad's console and its Reconnect button, which does not
exist when you run the server on your own: mint a new token with the steps
above instead. The Drive scopes are **restricted**, so a published but
unverified app shows Google's "unverified app" warning at consent. For a
Workspace account, an **Internal** consent screen avoids both the expiry and
the warning.

**The service-account mode needs a Workspace admin.** It does nothing until an
admin authorizes the service account's client id for the scopes above, in
**Admin Console → Security → API Controls → Domain-wide Delegation**. It does
not work for a personal `@gmail.com` account.

None of the credentials is needed to start. The server reads them on the first
tool call, so with nothing set it still boots and answers `tools/list`, and every
tool call returns an error naming the missing variables. It says so on stderr at
startup: the service account's three by default, the OAuth three once any
OAuth variable is set.

## Run it locally (stdio)

stdio is the default transport:

```bash
GOOGLE_DOCS_OAUTH_CLIENT_ID=1234-abc.apps.googleusercontent.com \
GOOGLE_DOCS_OAUTH_CLIENT_SECRET=GOCSPX-... \
GOOGLE_DOCS_OAUTH_REFRESH_TOKEN=1//0g... \
GOOGLE_DOCS_ENABLED_TOOLGROUPS=readonly \
node dist/standalone/google-docs.js
```

Start it with `node` directly, not through `npm run`. npm prints a banner to
stdout, and in stdio mode stdout carries only protocol messages. The server logs
to stderr. Run with `--help`, it prints the flags.

For Claude Desktop (`claude_desktop_config.json`), or any client that reads the
same `mcpServers` shape:

```json
{
  "mcpServers": {
    "google-docs": {
      "command": "node",
      "args": ["/absolute/path/to/strad/images/bundle-google/dist/standalone/google-docs.js"],
      "env": {
        "GOOGLE_DOCS_OAUTH_CLIENT_ID": "1234-abc.apps.googleusercontent.com",
        "GOOGLE_DOCS_OAUTH_CLIENT_SECRET": "GOCSPX-...",
        "GOOGLE_DOCS_OAUTH_REFRESH_TOKEN": "1//0g...",
        "GOOGLE_DOCS_ENABLED_TOOLGROUPS": "readonly"
      }
    }
  }
}
```

For Claude Code:

```bash
claude mcp add google-docs \
  -e GOOGLE_DOCS_OAUTH_CLIENT_ID=1234-abc.apps.googleusercontent.com \
  -e GOOGLE_DOCS_OAUTH_CLIENT_SECRET=GOCSPX-... \
  -e GOOGLE_DOCS_OAUTH_REFRESH_TOKEN=1//0g... \
  -e GOOGLE_DOCS_ENABLED_TOOLGROUPS=readonly \
  -- node /absolute/path/to/strad/images/bundle-google/dist/standalone/google-docs.js
```

This adds the server to the current project only. Add `-s user` to make it
available in every project.

For the service account, swap the three OAuth variables for
`GOOGLE_DOCS_SERVICE_ACCOUNT_CLIENT_EMAIL`,
`GOOGLE_DOCS_SERVICE_ACCOUNT_PRIVATE_KEY` and `GOOGLE_DOCS_IMPERSONATE_EMAIL`.
In JSON, write the key's newlines as `\n`.

## Run it as an HTTP service on localhost

```bash
node dist/standalone/google-docs.js --transport http --port 3300
# [google-docs] serving MCP on http://127.0.0.1:3300/mcp
```

| Setting   | How                                       | Default     |
| --------- | ----------------------------------------- | ----------- |
| transport | `--transport stdio` or `--transport http` | `stdio`     |
| port      | `--port N`, else the `PORT` env var       | `3000`      |
| host      | `--host H`                                | `127.0.0.1` |

The MCP endpoint is `/mcp` (Streamable HTTP). `GET /healthz` returns
`{"ok":true,"server":"google-docs"}` and never contacts Google. The credentials
are the same environment variables as in stdio mode.

The server is stateless. It builds a fresh server for every POST and issues no
session id, so any number of clients can share it. `GET /mcp` and `DELETE /mcp`
answer `405`. Request bodies are limited to 8 MB.

To check it, list the tools with curl:

```bash
curl -s http://127.0.0.1:3300/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

The reply is a server-sent event. The JSON is on the `data:` line, after
`event: message`. You can also open it in the MCP Inspector
(`npx @modelcontextprotocol/inspector`), with transport **Streamable HTTP** and
URL `http://127.0.0.1:3300/mcp`, or add it to Claude Code by URL:

```bash
claude mcp add --transport http google-docs http://127.0.0.1:3300/mcp
```

**The HTTP endpoint has no authentication.** Anyone who can reach the port can
read every document the account can, and in the write groups edit and delete
them, and in `readwrite_external` share them with anyone. On the default
loopback host it refuses any request whose `Host` header is not loopback, so a
web page in your browser cannot reach it through DNS rebinding. That does not
stop another process on the same machine. Any other `--host`, such as `0.0.0.0`
or a LAN address, turns that check off and exposes the server to your network.
Do that only behind something that authenticates. Authenticating callers is
what strad adds in front of this server.

## Tests

From `images/bundle-google`, `npm test` runs:

- `test/docs.test.ts` — strad's per-account layer, `../../src/docs.ts`: which
  mode an environment is in, which variables it is short of, and the client
  cache.
- `test/standalone.test.ts` — both transports against the built entrypoint,
  with no credentials set: all eleven tools, each of the three groups,
  `share_document` only in `readwrite_external`, a tool call that fails naming
  the missing variables in each mode, and an unknown group refused with exit 2.

Nothing in CI calls Google.
