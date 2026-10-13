# google-drive, without strad

This is strad's Google Drive MCP server. It finds, describes and reads the files
in one Google account's Drive, and it can create new folders and files there. You
can run it on its own, with no strad gateway: over **stdio** for a local MCP
client, or over **Streamable HTTP** on a localhost port.

The server is strad's own. It was written here, not vendored, and has the same
shape as `../google-sheets-shared`. The standalone entrypoint is
`../../src/standalone/google-drive.ts`. strad's bundle does not mount this server
yet. Running it on its own, as below, is the only way to use it today.

## Tools

Five, in two groups:

| Group       | Tools                                                            |
| ----------- | ---------------------------------------------------------------- |
| `readonly`  | `search_files`, `get_file`, `read_file`                          |
| `readwrite` | the three above, plus `create_folder` and `create_file`          |

- `search_files` searches My Drive, "Shared with me" and shared drives, by text,
  name, kind, folder or date. With a folder id and no other filter, it lists the folder.
- `get_file` returns metadata: owner, parents, link, who the file is shared
  with, and what `read_file` can do with it.
- `read_file` exports a Google Doc as Markdown (or text or HTML), a Google Sheet as
  CSV (first tab only), and Google Slides as text. It returns a stored text file as
  is and an image as an image. Long files are paged with `start_char`. PDFs,
  Office files and other binaries are refused, with the file's link.
- `create_folder` and `create_file` **only create**. Each call makes a new
  file with a new id. No tool here edits, overwrites, moves, shares, trashes or
  deletes a file. `create_file` can convert Markdown or HTML into a Google
  Doc and CSV into a Google Sheet as it uploads.

All five are served unless you set `GOOGLE_DRIVE_ENABLED_TOOLGROUPS`. The server
refuses to start on a group it does not recognise (`read-only`, say) and exits 2,
instead of reading the typo as "every group".

## Build

You need Node 22 or later. The server is one npm workspace of the
`images/bundle-google` package, so install and build from there:

```bash
git clone https://github.com/tadasant/strad.git
cd strad/images/bundle-google
npm ci
npm run build
```

The entrypoint is then `dist/standalone/google-drive.js`. The examples below run
from `images/bundle-google`. From anywhere else, use the absolute path to that file.

## Credentials

The server signs in as **one Google account** with an OAuth refresh token. That
can be a personal `@gmail.com` account or a Workspace one. There is no
service-account mode.

| Variable                           | What it is                                                                 |
| ---------------------------------- | -------------------------------------------------------------------------- |
| `GOOGLE_DRIVE_OAUTH_CLIENT_ID`     | your OAuth client's id                                                     |
| `GOOGLE_DRIVE_OAUTH_CLIENT_SECRET` | its secret                                                                 |
| `GOOGLE_DRIVE_OAUTH_REFRESH_TOKEN` | a refresh token for the account, consented for the scopes below            |
| `GOOGLE_DRIVE_ENABLED_TOOLGROUPS`  | optional: `readonly` or `readwrite`                                        |

**Scopes.** Neither is the full `drive` scope:

- `https://www.googleapis.com/auth/drive.readonly` — every read tool. It reaches
  every file the account can see and cannot change any of them.
- `https://www.googleapis.com/auth/drive.file` — the two create tools, as well.
  It can write only files and folders this OAuth client created. So `create_file`
  and `create_folder` work at the top of My Drive and inside folders made with
  `create_folder`. A folder someone made by hand in Drive refuses them.

For a read-only server, consent `drive.readonly` alone and set
`GOOGLE_DRIVE_ENABLED_TOOLGROUPS=readonly`. Google then refuses a write even if
one reached it.

**Getting a refresh token** with the OAuth Playground:

1. In a Google Cloud project, enable the **Google Drive API**, and create an
   OAuth client of type **Web application** with the authorized redirect URI
   `https://developers.google.com/oauthplayground`.
2. Open <https://developers.google.com/oauthplayground>, click the gear, tick
   **Use your own OAuth credentials** and paste the client id and secret.
3. In "Input your own scopes", enter the scopes above, separated by a space.
   Click **Authorize APIs** and sign in as the account the server should use.
4. Click **Exchange authorization code for tokens** and copy the refresh token.

While the OAuth consent screen is in **Testing** mode, Google expires the
refresh token after 7 days. Every call then fails with `invalid_grant`, and the
error says to mint a new token. Publish the consent screen to keep a token
longer.

None of the credentials is needed to start. The server reads them on the first
tool call, so with nothing set it still boots and answers `tools/list`, and every
tool call returns an error naming the missing variables. It says so on stderr at
startup.

## Run it locally (stdio)

stdio is the default transport:

```bash
GOOGLE_DRIVE_OAUTH_CLIENT_ID=1234-abc.apps.googleusercontent.com \
GOOGLE_DRIVE_OAUTH_CLIENT_SECRET=GOCSPX-... \
GOOGLE_DRIVE_OAUTH_REFRESH_TOKEN=1//0g... \
node dist/standalone/google-drive.js
```

Start it with `node` directly, not through `npm run`. npm prints a banner to
stdout, and in stdio mode stdout carries only protocol messages. The server logs
to stderr. Run with `--help`, it prints the flags.

For Claude Desktop (`claude_desktop_config.json`), or any client that reads the
same `mcpServers` shape:

```json
{
  "mcpServers": {
    "google-drive": {
      "command": "node",
      "args": ["/absolute/path/to/strad/images/bundle-google/dist/standalone/google-drive.js"],
      "env": {
        "GOOGLE_DRIVE_OAUTH_CLIENT_ID": "1234-abc.apps.googleusercontent.com",
        "GOOGLE_DRIVE_OAUTH_CLIENT_SECRET": "GOCSPX-...",
        "GOOGLE_DRIVE_OAUTH_REFRESH_TOKEN": "1//0g...",
        "GOOGLE_DRIVE_ENABLED_TOOLGROUPS": "readonly"
      }
    }
  }
}
```

For Claude Code:

```bash
claude mcp add google-drive \
  -e GOOGLE_DRIVE_OAUTH_CLIENT_ID=1234-abc.apps.googleusercontent.com \
  -e GOOGLE_DRIVE_OAUTH_CLIENT_SECRET=GOCSPX-... \
  -e GOOGLE_DRIVE_OAUTH_REFRESH_TOKEN=1//0g... \
  -- node /absolute/path/to/strad/images/bundle-google/dist/standalone/google-drive.js
```

This adds the server to the current project only. Add `-s user` to make it
available in every project.

## Run it as an HTTP service on localhost

```bash
node dist/standalone/google-drive.js --transport http --port 3200
# [google-drive] serving MCP on http://127.0.0.1:3200/mcp
```

| Setting   | How                                       | Default     |
| --------- | ----------------------------------------- | ----------- |
| transport | `--transport stdio` or `--transport http` | `stdio`     |
| port      | `--port N`, else the `PORT` env var       | `3000`      |
| host      | `--host H`                                | `127.0.0.1` |

The MCP endpoint is `/mcp` (Streamable HTTP). `GET /healthz` returns
`{"ok":true,"server":"google-drive"}` and never contacts Google. The credentials
are the same environment variables as in stdio mode.

The server is stateless. It builds a fresh server for every POST and issues no
session id, so any number of clients can share it. `GET /mcp` and `DELETE /mcp`
answer `405`. Request bodies are limited to 8 MB.

To check it, list the tools with curl:

```bash
curl -s http://127.0.0.1:3200/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

The reply is a server-sent event. The JSON is on the `data:` line, after
`event: message`. You can also open it in the MCP Inspector
(`npx @modelcontextprotocol/inspector`), with transport **Streamable HTTP** and
URL `http://127.0.0.1:3200/mcp`, or add it to Claude Code by URL:

```bash
claude mcp add --transport http google-drive http://127.0.0.1:3200/mcp
```

**The HTTP endpoint has no authentication.** Anyone who can reach the port can
read the account's Drive. On the default loopback host it refuses any request
whose `Host` header is not loopback, so a web page in your browser cannot reach
it through DNS rebinding. Any other `--host`, such as `0.0.0.0` or a LAN address,
turns that check off and exposes the server to your network. Do that only behind
something that authenticates. Authenticating callers is what strad adds in front
of this server.

## Limits

- `read_file` reads at most 10 MB of text (Google's own export ceiling) and 5 MB
  of image, and returns at most 100,000 characters per call (25,000 by default).
- `create_file` uploads at most 5 MB.
- A Google Sheet exports its first tab only. For the other tabs, ranges or
  formulas, use the google-sheets server.
- A search across many shared drives can be partial. Drive says so, and so does
  `search_files`.

## Tests

From `images/bundle-google`, `npm test` runs:

- `vendor/google-drive-shared/test/` — the wire (every Drive request's URL,
  query and body, the multipart upload, the download cap, the 429 retry, the
  403 reasons), the search query and id parsing, each tool against a fake
  client, and the tiers and tool groups.
- `test/standalone.test.ts` — both transports against the built entrypoint, with
  no credentials set.

Nothing in CI calls Google. No real account has been read or written through this server yet.
