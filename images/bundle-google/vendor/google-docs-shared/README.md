# google-docs, without strad

This is the Google Docs MCP server strad serves at `/google-docs`. It reads,
edits, exports, comments on and shares the Google Docs one account can
reach. You can run it on its own, with no strad gateway and none of the other
Google servers: over **stdio** for a local MCP client, or over **Streamable
HTTP** on a localhost port.

`src/` here is a **patched vendor** of
[`pulsemcp/mcp-servers`](https://github.com/pulsemcp/mcp-servers/tree/main/experimental/google-docs)
(`experimental/google-docs/shared`): upstream as of `0ed34de`, plus the deltas
below. strad changes this server here, not upstream first. A re-vendor copies
upstream `src/` over this tree and then has to re-apply every row, or it
silently removes them. This README is strad's and is not part of that copy.
strad's own code for this server lives outside the tree:
`../../src/docs.ts` is the per-account layer the bundle mounts (the credential
and the tool-group toggle), and `../../src/standalone/google-docs.ts` is the
standalone entrypoint, which hands that same layer to the shared runner.

| Delta | Where | Defended by |
| ----- | ----- | ----------- |
| Every tab is read, not only the first: `documents.get` is asked for `includeTabsContent=true`, and `get_document` and `get_document_outline` take a `tab_id` (`HACKS.md` #129) | `src/utils/tabs.ts`, `src/types.ts` (`Tab`), `src/google-docs-client/lib/get-document.ts`, `src/server.ts` (`getDocument`'s options), `src/tools/get-document.ts`, `src/tools/get-document-outline.ts`, the tab notes in `src/tools/update-document.ts`, `src/tools/append-text.ts`, `src/tools/insert-text.ts` and `src/tools/export-document.ts` | `../../test/docs-tabs.test.ts`, `../../test/standalone.test.ts` |
| Comments can be written: `add_comment` (Drive `comments.create`) and `reply_to_comment` (Drive `replies.create`, which also resolves and reopens), both in `readwrite` (`HACKS.md` #132) | `src/tools/add-comment.ts`, `src/tools/reply-to-comment.ts`, `src/google-docs-client/lib/drive-comments.ts` (`createComment`, `createReply`), `src/server.ts` (the two client methods), `src/tools.ts` (registration) | `../../test/docs-comments.test.ts`, `../../test/standalone.test.ts` |
| Edits can be suggestions, and comments attach to a passage: `suggest` on `append_text`, `insert_text`, `replace_text` and `update_document` (`writeControl.writeMode: SUGGEST`), `add_comment`'s `quoted_text` becomes a Docs `insertComment`, and `commentUpdateState` failures are errors (`HACKS.md` #135) | `src/utils/suggest.ts`, `src/utils/find-passage.ts`, `src/google-docs-client/lib/batch-update.ts`, `src/google-docs-client/lib/get-document.ts` (`suggestionsViewMode`), `src/server.ts` (`batchUpdate`'s `writeControl`), `src/types.ts`, `src/tools/add-comment.ts`, `src/tools/append-text.ts`, `src/tools/insert-text.ts`, `src/tools/replace-text.ts`, `src/tools/update-document.ts`, the suggestions note in `src/tools/get-document.ts` | `../../test/docs-suggest-anchor.test.ts`, `../../test/standalone.test.ts` |

## Tools

Thirteen, in three groups. Each group holds the one before it:

| Group                | Tools                                                                                                                       |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `readonly`           | `get_document`, `get_document_outline`, `export_document`, `list_comments`                                                  |
| `readwrite`          | the four above, plus `create_document`, `update_document`, `append_text`, `insert_text`, `replace_text`, `delete_document`, `add_comment`, `reply_to_comment` |
| `readwrite_external` | the twelve above, plus `share_document`                                                                                     |

- `get_document` returns a document's title, heading outline and plain-text
  body, or the raw Docs API resource with `format=json`.
  `get_document_outline` returns the headings alone.
- Both read **every tab** of a document, nested child tabs included. With
  more than one tab, `get_document_outline` gives each tab a section with its
  `tab_id`, and `get_document` returns every tab's outline and body, one
  section each. Pass `tab_id` to either to read one tab. A `?tab=` in a
  pasted URL does not narrow the read: Docs puts `?tab=t.0` on nearly every
  URL, and honouring it would read the first tab alone again. A single-tab
  document reads the same as it always has. `export_document` has no per-tab option, because
  Drive's export has none.
- In a multi-tab document, `update_document`, `append_text` and `insert_text`
  edit the first tab unless a request's location carries a `tabId`. Only
  `update_document` takes raw requests, so it is the one that can target
  another tab. `replace_text` replaces in every tab.
- `append_text`, `insert_text`, `replace_text` and `update_document` take
  `suggest=true`, which proposes the edit as a suggestion for a human to accept
  or reject in the Docs editor. The tab rules above are the same in suggest
  mode. `update_document` refuses, by name and before calling Google, the
  requests Docs cannot suggest. A pending suggestion occupies indexes, and
  `get_document`'s text shows both sides of one, unmarked.
- `export_document` exports through Drive: `markdown`, `html` and `txt` come
  back as text, `pdf`, `docx`, `odt`, `rtf` and `epub` as base64.
- `list_comments` lists comments with their quoted text, replies and resolved
  state, and each comment's ID.
- `add_comment` starts a comment thread. With `quoted_text` it attaches the
  comment to that passage, which it finds in the body of any tab (`tab_id`
  narrows it, `occurrence` picks one of several matches) and sends as a Docs
  `insertComment`. Text it cannot find, or a repeat with no `occurrence`, is
  refused and nothing is created. Without `quoted_text` the comment is on the
  document as a whole, through Drive. `reply_to_comment` replies to a thread
  by its ID; `resolve=true` resolves the thread and `resolve=false` reopens
  it. Google may notify people with access to the document, as it does for a
  comment made in the editor.
- `update_document` takes raw Docs `batchUpdate` requests: styling, tables,
  lists, deletions. `append_text`, `insert_text` and `replace_text` are
  wrappers over it for the common cases.
- `delete_document` moves a document to Drive's trash, recoverable for 30
  days. With `permanent=true` it deletes it for good.
- `share_document` adds a Drive permission: a user, group, domain or anyone
  with the link, as reader, commenter or writer. By default Google emails a
  user or group it is shared with. It is the one tool that sends a document to someone else,
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

If all three OAuth variables are set, OAuth wins. Set one mode, not both: the
standalone entrypoint refuses to start, with exit 2, when some OAuth variables
are set beside a complete service account, because that would quietly serve
the Workspace user's documents instead of your account's.
`GOOGLE_DOCS_ENABLED_TOOLGROUPS` (optional) is `readonly`, `readwrite` or
`readwrite_external`, comma-separated if you want more than one.

**Scopes (OAuth).** The token's scopes are what Google enforces. The tool
group only decides which tools a client sees.

| Group                               | Consent for                                                                                                         |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `readonly`                          | `https://www.googleapis.com/auth/documents.readonly` and `https://www.googleapis.com/auth/drive.readonly`          |
| `readwrite` and `readwrite_external` | `https://www.googleapis.com/auth/documents` and `https://www.googleapis.com/auth/drive`                             |

The Drive scope is not optional. `export_document`, the three comment tools,
`delete_document` and `share_document` go through the Drive API, and
`drive.file` only reaches documents this OAuth client created, so it is not
enough for documents you already have. Both Drive scopes reach every file in
the account, not just Docs.

For a read-only OAuth server, consent the two `.readonly` scopes and set
`GOOGLE_DOCS_ENABLED_TOOLGROUPS=readonly`. Google then refuses a write even if
one reached it.

**Scopes (service account).** The service-account client always asks for the
full `https://www.googleapis.com/auth/documents` and
`https://www.googleapis.com/auth/drive`, whatever the group. Delegating only the
`.readonly` scopes makes every call fail at the token. In this mode the tool
group is the only thing narrowing what the server can do.

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
admin authorizes the service account's client id for those two full scopes, in
**Admin Console → Security → API Controls → Domain-wide Delegation**. It does
not work for a personal `@gmail.com` account.

None of the credentials is needed to start. The server reads them on the first
tool call, so with nothing set it still boots and answers `tools/list`, and every
tool call returns an error naming the missing variables. It says so on stderr at
startup: the service account's three by default, the OAuth three once any
OAuth variable is present, even empty.

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

- `test/docs.test.ts` — strad's per-account layer, `src/docs.ts`: which mode
  an environment is in, which variables it is short of, the client cache, the
  per-mount tool-group toggle and the `invalid_grant` hint.
- `test/docs-comments.test.ts` — `add_comment` and `reply_to_comment` through
  the same layer, against a fake client: what each sends to Drive, the
  resolve and reopen mapping, and that neither is listed in `readonly`.
- `test/docs-suggest-anchor.test.ts` — suggest mode and anchored comments: the
  `writeControl` and `insertComment` bodies, the refusals, `commentUpdateState`
  failures, and the index arithmetic across tabs, tables and pending suggestions.
- `test/standalone.test.ts` — both transports against the built entrypoint,
  with no credentials set: all thirteen tools, each of the three groups,
  `share_document` only in `readwrite_external`, comma-separated groups, a tool
  call that fails naming the missing variables in each mode, and exit 2 on an
  unknown group or a half-set OAuth trio beside a service account. With a fake
  Google preloaded, it also makes suggestions and adds anchored comments
  end to end.

Nothing in CI calls Google.
