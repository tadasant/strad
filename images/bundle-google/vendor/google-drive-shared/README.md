# google-drive, without strad

This is strad's Google Drive MCP server. It finds, describes and reads the files
in one Google account's Drive. It can create new folders and files there, and in
its `full` tier it edits, renames, moves, copies, trashes and restores files that
already exist. You can run it on its own, with no strad gateway: over **stdio**
for a local MCP client, or over **Streamable HTTP** on a localhost port.

The server is strad's own. It was written here, not vendored, and has the same
shape as `../google-sheets-shared`. The standalone entrypoint is
`../../src/standalone/google-drive.ts`. strad's bundle does not mount this server,
so running it on its own, as below, is the only way to use it.

## Tools

Eleven, in three tiers. Each tier holds the one before it:

| Group       | Tools                                                                                                              | Scope it needs                    |
| ----------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------- |
| `readonly`  | `search_files`, `get_file`, `read_file`                                                                            | `drive.readonly`                  |
| `readwrite` | the three above, plus `create_folder` and `create_file`                                                            | `drive.readonly` and `drive.file` |
| `full`      | the five above, plus `replace_file_content`, `update_file_metadata`, `move_file`, `copy_file`, `trash_file`, `restore_file` | `drive`                           |

- `search_files` searches My Drive, "Shared with me" and shared drives, by text,
  name, kind, folder or date. With a folder id and no other filter, it lists the
  folder. `include_trashed=true` finds trashed files too.
- `get_file` returns metadata: owner, parents, link, who the file is shared
  with, and what `read_file` can do with it.
- `read_file` exports a Google Doc as Markdown (or text or HTML), a Google Sheet as
  CSV (first tab only), and Google Slides as text. It returns a stored text file as
  is and an image as an image. Long files are paged with `start_char`. PDFs,
  Office files and other binaries are refused, with the file's link.
- `create_folder` and `create_file` **only create**. Each call makes a new
  file with a new id. `create_file` can convert Markdown or HTML into a Google
  Doc, and CSV or TSV into a Google Sheet, as it uploads. Any other pairing is
  refused before the upload.
- `replace_file_content` overwrites a file's whole content and keeps its id,
  name, folder and sharing. A **Google Doc** is rebuilt from Markdown (the
  default), text or HTML, so the usual edit is `read_file` as Markdown, change
  the text, and send all of it back. A stored file (`.md`, `.csv`, `.json`, an
  image, …) gets the new bytes and keeps its type. It refuses Google Sheets,
  because a CSV upload would collapse every tab into one and drop formulas and
  formatting. Use the google-sheets server to edit cells. It also refuses
  empty content, Slides, folders and shortcuts. The previous content stays in
  the file's version history. A Doc rebuilt from Markdown loses what Markdown
  cannot carry: images unless the export kept them inline, every tab but the
  first, headers and footers, suggestions, smart chips, bookmarks and most
  styling. To change part of a Doc and keep the rest, use the google-docs
  server.
- `update_file_metadata` renames a file or folder, or sets its description.
- `move_file` moves a file or folder into another folder and says where it was,
  so the move can be undone.
- `copy_file` copies a file to a new id, optionally with a new name and folder.
  The copy does not take the original's own sharing, but it inherits the
  sharing of the folder it lands in. Folders cannot be copied.
- `trash_file` moves a file or folder to Drive's trash, and `restore_file` takes
  it back out. A trashed folder takes what the account owns inside it along.
  Drive deletes a trashed file for good after 30 days.

**Not here, on purpose:**

- **Permanent delete and emptying the trash.** Trash is recoverable for 30 days,
  and a delete is not. A model that wants a file gone gets `trash_file`.
- **Sharing and permissions.** Sharing is the one call here that sends a file to
  someone else, and Google emails them about it. strad's google-docs server
  keeps `share_document` in a tier of its own for that reason. If Drive needs
  it, it gets the same treatment, not a place in `full`.
- **In-place edits to part of a Google Doc**, such as inserting a paragraph or
  replacing one phrase. Those need the Docs API, which the google-docs server
  has. `replace_file_content` replaces the whole body.

All eleven are served unless you set `GOOGLE_DRIVE_ENABLED_TOOLGROUPS`. The
server refuses to start on a group it does not recognise (`read-only`, say) and
exits 2, instead of reading the typo as "every group".

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
| `GOOGLE_DRIVE_ENABLED_TOOLGROUPS`  | optional: `readonly`, `readwrite` or `full`                                |

**Scopes.** Consent only what the tier you run needs. The token's scopes are
what Google enforces. The tool group only decides which tools a client sees.

| Tier        | Consent for                                                                                              | What the token can then do                                                                                       |
| ----------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `readonly`  | `https://www.googleapis.com/auth/drive.readonly`                                                         | read every file the account can see, and change none of them                                                     |
| `readwrite` | `https://www.googleapis.com/auth/drive.readonly` and `https://www.googleapis.com/auth/drive.file`        | that, and create files and folders. It can write only to files and folders this OAuth client created            |
| `full`      | `https://www.googleapis.com/auth/drive`                                                                  | read, create, edit, move and trash any file the account itself may. This scope also covers the other two        |

- `drive.file` reaches only files this OAuth client created. So under
  `readwrite`, `create_file` and `create_folder` work at the top of My Drive and
  inside folders made with `create_folder`. A folder someone made by hand in
  Drive is expected to refuse them. That has not been checked against a live
  account (`HACKS.md` #124).
- The `full` tools also run on a `drive.file` token. There they **work** on
  every file and folder this client created, overwriting, moving and trashing
  them, and on anything else Google answers 403 or 404, with an error that says
  to re-consent with `drive`.
- **Moving up a tier means re-consenting.** A refresh token keeps the scopes it
  was minted with. To go from `readwrite` to `full`, run the consent flow below
  again with `https://www.googleapis.com/auth/drive`, replace
  `GOOGLE_DRIVE_OAUTH_REFRESH_TOKEN`, and set `GOOGLE_DRIVE_ENABLED_TOOLGROUPS=full`
  (or leave it unset).
- **Unset means every tool**, `full` included. A setup from before the `full`
  tier with no group set now lists the six edit tools, and on a `drive.file`
  token they succeed on the files the client created. Set the group to match
  the token, as every example below does.

For a read-only server, consent `drive.readonly` alone and set
`GOOGLE_DRIVE_ENABLED_TOOLGROUPS=readonly`. Google then refuses a write even if
one reached it.

**Getting a refresh token** with the OAuth Playground:

1. In a Google Cloud project, enable the **Google Drive API**, and create an
   OAuth client of type **Web application** with the authorized redirect URI
   `https://developers.google.com/oauthplayground`.
2. Open <https://developers.google.com/oauthplayground>, click the gear, tick
   **Use your own OAuth credentials** and paste the client id and secret.
3. In "Input your own scopes", enter the scopes for your tier from the table
   above, separated by a space.
   Click **Authorize APIs** and sign in as the account the server should use.
4. Click **Exchange authorization code for tokens** and copy the refresh token.

While the OAuth consent screen is in **Testing** mode, Google expires the
refresh token after 7 days. Every call then fails with `invalid_grant`, and the
error says to mint a new token. Publishing the consent screen keeps a token
longer, but `drive.readonly` and `drive` are **restricted** scopes: an
unverified published app shows Google's "unverified app" warning at consent and
is capped at 100 users. For a Workspace account, an **Internal** consent screen avoids both the
expiry and the warning.

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
GOOGLE_DRIVE_ENABLED_TOOLGROUPS=readonly \
node dist/standalone/google-drive.js
```

Set `GOOGLE_DRIVE_ENABLED_TOOLGROUPS` to the tier your token was consented for:
`readonly`, `readwrite` or `full`.

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
  -e GOOGLE_DRIVE_ENABLED_TOOLGROUPS=readonly \
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
read the account's Drive, and in the `full` tier overwrite, move and trash its
files. On the default loopback host it refuses any request
whose `Host` header is not loopback, so a web page in your browser cannot reach
it through DNS rebinding. Any other `--host`, such as `0.0.0.0` or a LAN address,
turns that check off and exposes the server to your network. Do that only behind
something that authenticates. Authenticating callers is what strad adds in front
of this server.

## Limits

- `read_file` reads at most 10 MB of text (Google's own export ceiling) and 5 MB
  of image, and returns at most 100,000 characters per call (25,000 by default).
- `create_file` and `replace_file_content` upload at most 5 MB.
- `replace_file_content` has no "only if unchanged since" check. Drive's v3 API
  offers no precondition on a write, so an edit someone made in the browser
  between your `read_file` and the replace is overwritten. It is still in the
  version history.
- A Google Sheet exports its first tab only. For the other tabs, ranges or
  formulas, use the google-sheets server.
- A search across many shared drives can be partial. Drive says so, and so does
  `search_files`.
- `name_contains` is Drive's prefix match on the words of a name, not a
  substring match. `query` matches anywhere, in content too.
- Each `read_file` page exports or downloads the whole file again, so paging
  through a large Doc costs one Drive call per page.
- Stored text is decoded as UTF-8. A file in another encoding, such as a
  Latin-1 CSV, comes back with replacement characters.
- A link-shared file that needs a resource key (`resourcekey=` in its URL) is
  not supported. The key is dropped, and Drive answers 404.

## Tests

From `images/bundle-google`, `npm test` runs:

- `vendor/google-drive-shared/test/` — the wire: every Drive request's URL,
  query and body, the multipart upload, the media PATCH and metadata PATCHes and
  copy the edit tools send, the download cap, the 429 retry, and the 403
  reasons. The OAuth client: one token exchange per burst, the `invalid_grant`
  hint, and a 401 that refreshes. Also the search query and id parsing, each
  tool against a fake client (including every refusal the edit tools make
  before they write), and the tiers and tool groups.
- `test/standalone.test.ts` — both transports against the built entrypoint, with
  no credentials set, and the `readonly` and `readwrite` groups.

Nothing in CI calls Google, and no real account has been read or written through this server (`HACKS.md` #124).
