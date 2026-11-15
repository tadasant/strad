# gmail, without strad

This is the Gmail MCP server strad serves at `/gmail` and under every
`gmail-*` slug. It lists, searches and reads the mail in one Google account,
labels and archives it, and writes drafts. You can run it on its own, with no
strad gateway and none of the other Google servers: over **stdio** for a local
MCP client, or over **Streamable HTTP** on a localhost port.

**On its own, it does not send mail.** That is the one thing it does
differently from the server strad mounts, and the next section says why.

`src/` here is a **fork** of
[`pulsemcp/mcp-servers`](https://github.com/pulsemcp/mcp-servers/tree/main/experimental/gmail)
(`experimental/gmail/shared`). strad owns it, changes land here, and
[`FORK.md`](./FORK.md) lists every delta from upstream. This README is strad's
too. strad's own code for this server also lives outside the tree:
`../../src/gmail.ts` is the per-account layer the bundle mounts (the credential
and the tool-group toggle), `../../src/confirm.ts` is the human confirmation in
front of `send_email`, and `../../src/standalone/gmail.ts` is the standalone
entrypoint, which hands that same per-account layer to the shared runner.

## Tools

| Group                | Tools                                                                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `readonly`           | `list_email_conversations`, `search_email_conversations`, `get_email_conversation`, `download_email_attachments`, `list_draft_emails`             |
| `readwrite`          | the five above, plus `change_email_conversation`, `upsert_draft_email` and `delete_draft_email`                                                   |
| `readwrite_external` | the eight above, plus `send_email`. **Served through strad only.** The standalone entrypoint refuses to start with it                              |

- `get_email_conversation` returns a message's headers and body, and a
  `## Sender Verification Headers` section with the headers that say whether
  the receiving server believed the `From:` line (`FORK.md` delta 4).
- `download_email_attachments` returns attachments in the response, as MCP
  embedded resources (a base64 `blob` for binary files, `text` for text
  types), which a client such as Claude Code saves to a local file. With
  `inline=true` it puts everything in one text block instead. It writes
  nothing to the server's disk (`FORK.md` delta 6).
- `change_email_conversation` marks a conversation read, unread or archived,
  and adds or removes labels.
- `upsert_draft_email` creates or updates a draft, with attachments by HTTPS
  URL or as base64 (`FORK.md` delta 1). A draft is saved, not sent. The
  answer names the account and links its Drafts folder (`FORK.md` delta 7),
  as does `list_draft_emails`.
- `delete_draft_email` deletes one draft by ID, permanently, and refuses an
  ID that is not a draft (`FORK.md` delta 5). It never touches a message or
  a thread.

**With `GMAIL_ENABLED_TOOLGROUPS` unset, the standalone server serves
`readonly` and `readwrite`**: all eight tools above. Set
`GMAIL_ENABLED_TOOLGROUPS=readonly` for the five reads alone. It refuses to
start, with exit 2, on a group it does not recognise (`read-only`, say),
instead of reading the typo as "every group". The vendored parser would read
it that way, `send_email` included.

## Why standalone does not send

In strad, `send_email` asks a human before every send. strad's gateway reads
the caller's approval URL off its request, holds it to an allowlist, and hands
it to this server on the call, under a `_meta` key that only the gateway may
write. A send with no approval URL is refused. A mailbox that is the agent's
own can waive the human, and that waiver also comes from the gateway, per
slug. See `docs/src/content/docs/servers/confirmations.md`.

On its own, the server has no gateway in front of it. The `_meta` on a call is
whatever the client wrote, so trusting it would let a client claim the waiver
and send with nobody asked. Ignoring it would refuse every send. Neither is a
send tool worth serving. So the standalone entrypoint refuses
`GMAIL_ENABLED_TOOLGROUPS=readwrite_external` at startup, with exit 2, and
`send_email` never appears in its tool list.

To write mail on your own machine, save it with `upsert_draft_email` and send
it from Gmail yourself. To let an agent send, run the server behind strad.

The scopes below do not enforce this. `gmail.modify` alone lets a token send
mail through the Gmail API, and the service account always asks for
`gmail.send`. What keeps the standalone server from sending is that it serves
no tool that sends.

## Build

You need Node 22 or later. The server is one npm workspace of the
`images/bundle-google` package, so install and build from there:

```bash
git clone https://github.com/tadasant/strad.git
cd strad/images/bundle-google
npm ci
npm run build
```

The entrypoint is then `dist/standalone/gmail.js`. The examples below run from
`images/bundle-google`. From anywhere else, use the absolute path to that file.

## Credentials

The server acts as **one Google account**, in one of two modes.

**OAuth (a refresh token).** Any Google account, personal `@gmail.com` or
Workspace. This is the one to use on your own machine.

| Variable                    | What it is                                                      |
| --------------------------- | --------------------------------------------------------------- |
| `GMAIL_OAUTH_CLIENT_ID`     | your OAuth client's id                                          |
| `GMAIL_OAUTH_CLIENT_SECRET` | its secret                                                      |
| `GMAIL_OAUTH_REFRESH_TOKEN` | a refresh token for the account, consented for the scopes below |

**Service account (domain-wide delegation).** A Workspace user's mailbox,
reached through a service account a Workspace admin has authorized.

| Variable                             | What it is                                                           |
| ------------------------------------ | -------------------------------------------------------------------- |
| `GMAIL_SERVICE_ACCOUNT_CLIENT_EMAIL` | the service account's email                                          |
| `GMAIL_SERVICE_ACCOUNT_PRIVATE_KEY`  | its PEM private key. Literal `\n` sequences are turned into newlines |
| `GMAIL_IMPERSONATE_EMAIL`            | the Workspace user whose mailbox it reads                            |

If all three OAuth variables are set, OAuth wins. Set one mode, not both: the
standalone entrypoint refuses to start, with exit 2, when some OAuth variables
are set beside a complete service account, because that would quietly serve
the Workspace user's mailbox instead of your account's.

**Scopes (OAuth).** The token's scopes are what Google enforces. The tool
group only decides which tools a client sees.

| Group       | Consent for                                      |
| ----------- | ------------------------------------------------ |
| `readonly`  | `https://www.googleapis.com/auth/gmail.readonly` |
| `readwrite` | `https://www.googleapis.com/auth/gmail.modify`   |

For a read-only server, consent `gmail.readonly` alone and set
`GMAIL_ENABLED_TOOLGROUPS=readonly`. Google then refuses a label change or a
draft even if one reached it. A draft written with `gmail.modify` carries the
sender's display name only if the token can read the account's send-as
settings, which `gmail.modify` can (`FORK.md` delta 2).

**Scopes (service account).** The service-account client always asks for all
four of `gmail.readonly`, `gmail.modify`, `gmail.compose` and `gmail.send`,
whatever the group. Delegate all four, or every call fails at the token. In
this mode the tool group is the only thing narrowing what the server can do.

**Getting a refresh token** with the OAuth Playground:

1. In a Google Cloud project, enable the **Gmail API**, and create an OAuth
   client of type **Web application** with the authorized redirect URI
   `https://developers.google.com/oauthplayground`.
2. Open <https://developers.google.com/oauthplayground>, click the gear, tick
   **Use your own OAuth credentials** and paste the client id and secret.
3. In "Input your own scopes", enter the scope for your group from the table
   above. Click **Authorize APIs** and sign in as the account the server should
   use.
4. Click **Exchange authorization code for tokens** and copy the refresh token.

While the OAuth consent screen is in **Testing** mode, Google expires the
refresh token after 7 days. Every call then fails with `invalid_grant`. That
error's hint names strad's console and its Reconnect button, which does not
exist when you run the server on your own: mint a new token with the steps
above instead. The Gmail scopes are **restricted**, so a published but
unverified app shows Google's "unverified app" warning at consent. For a
Workspace account, an **Internal** consent screen avoids both the expiry and
the warning.

**The service-account mode needs a Workspace admin.** It does nothing until an
admin authorizes the service account's client id for the four scopes, in
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
GMAIL_OAUTH_CLIENT_ID=1234-abc.apps.googleusercontent.com \
GMAIL_OAUTH_CLIENT_SECRET=GOCSPX-... \
GMAIL_OAUTH_REFRESH_TOKEN=1//0g... \
GMAIL_ENABLED_TOOLGROUPS=readonly \
node dist/standalone/gmail.js
```

Start it with `node` directly, not through `npm run`. npm prints a banner to
stdout, and in stdio mode stdout carries only protocol messages. The server logs
to stderr. Run with `--help`, it prints the flags.

For Claude Desktop (`claude_desktop_config.json`), or any client that reads the
same `mcpServers` shape:

```json
{
  "mcpServers": {
    "gmail": {
      "command": "node",
      "args": ["/absolute/path/to/strad/images/bundle-google/dist/standalone/gmail.js"],
      "env": {
        "GMAIL_OAUTH_CLIENT_ID": "1234-abc.apps.googleusercontent.com",
        "GMAIL_OAUTH_CLIENT_SECRET": "GOCSPX-...",
        "GMAIL_OAUTH_REFRESH_TOKEN": "1//0g...",
        "GMAIL_ENABLED_TOOLGROUPS": "readonly"
      }
    }
  }
}
```

For Claude Code:

```bash
claude mcp add gmail \
  -e GMAIL_OAUTH_CLIENT_ID=1234-abc.apps.googleusercontent.com \
  -e GMAIL_OAUTH_CLIENT_SECRET=GOCSPX-... \
  -e GMAIL_OAUTH_REFRESH_TOKEN=1//0g... \
  -e GMAIL_ENABLED_TOOLGROUPS=readonly \
  -- node /absolute/path/to/strad/images/bundle-google/dist/standalone/gmail.js
```

This adds the server to the current project only. Add `-s user` to make it
available in every project.

For the service account, swap the three OAuth variables for
`GMAIL_SERVICE_ACCOUNT_CLIENT_EMAIL`, `GMAIL_SERVICE_ACCOUNT_PRIVATE_KEY` and
`GMAIL_IMPERSONATE_EMAIL`. In JSON, write the key's newlines as `\n`.

## Run it as an HTTP service on localhost

```bash
node dist/standalone/gmail.js --transport http --port 3300
# [gmail] serving MCP on http://127.0.0.1:3300/mcp
```

| Setting   | How                                       | Default     |
| --------- | ----------------------------------------- | ----------- |
| transport | `--transport stdio` or `--transport http` | `stdio`     |
| port      | `--port N`, else the `PORT` env var       | `3000`      |
| host      | `--host H`                                | `127.0.0.1` |

The MCP endpoint is `/mcp` (Streamable HTTP). `GET /healthz` returns
`{"ok":true,"server":"gmail"}` and never contacts Google. The credentials are
the same environment variables as in stdio mode.

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
claude mcp add --transport http gmail http://127.0.0.1:3300/mcp
```

**The HTTP endpoint has no authentication.** Anyone who can reach the port can
read every message in the mailbox, and in `readwrite` archive and relabel it
and write drafts. On the default loopback host it refuses any request whose
`Host` header is not loopback, so a web page in your browser cannot reach it
through DNS rebinding. That does not stop another process on the same machine.
Any other `--host`, such as `0.0.0.0` or a LAN address, turns that check off
and exposes the server to your network. Do that only behind something that
authenticates. Authenticating callers is what strad adds in front of this
server.

## Tests

From `images/bundle-google`, `npm test` runs:

- `test/gmail.test.ts` — strad's per-account layer, `src/gmail.ts`: which mode
  an environment is in, which variables it is short of, the client cache, the
  per-mount tool-group toggle and the `invalid_grant` hint.
- `test/confirm.test.ts` — the confirmation in front of `send_email` that
  strad's mount carries.
- `test/standalone.test.ts` — both transports against the built entrypoint,
  with no credentials set: the eight tools by default, `readonly` and
  `readwrite`, comma-separated groups, a tool call that fails naming the
  missing variables in each mode, `send_email` answered as an unknown tool
  even with the gateway's waiver forged into `_meta`, and exit 2 on
  `readwrite_external`, on an unknown group, and on a half-set OAuth trio
  beside a service account.
- `test/gmail-*.test.ts` — the fork's deltas, listed in `FORK.md`.

Nothing in CI calls Google.
