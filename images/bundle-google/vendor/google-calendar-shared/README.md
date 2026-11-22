# google-calendar, without strad

This is the Google Calendar MCP server strad serves at `/google-calendar`. You
can run it on its own, with no strad gateway and none of the other Google
servers: over **stdio** for a local MCP client, or over **Streamable HTTP** on a
localhost port.

`src/` here is a **patched vendor** of
[`pulsemcp/mcp-servers`](https://github.com/pulsemcp/mcp-servers/tree/main/experimental/google-calendar)
(`experimental/google-calendar/shared`): upstream as of `0ed34de`, plus the
deltas below. strad changes this server here, not upstream first. A re-vendor
copies upstream `src/` over this tree and then has to re-apply every row, or it
silently removes them. This README is strad's and is not part of that copy. The
standalone entrypoint is strad's too, and lives outside the tree in
`../../src/standalone/google-calendar.ts`.

| Delta | Where | Defended by |
| ----- | ----- | ----------- |
| A personal OAuth mode, chosen by `GOOGLE_CALENDAR_AUTH_MODE=oauth`, beside the default service account (`HACKS.md` #125) | `src/server.ts` (`parseAuthMode`, `OAuthCalendarClient`, `createDefaultClient`), `src/index.ts` (exports) | `../../test/calendar-auth-mode.test.ts`, `../../test/standalone.test.ts` |
| `create_calendar_event` takes `send_updates` (`all` \| `externalOnly` \| `none`) and passes it to `events.insert` as `sendUpdates`, the way update and delete already do. `none` creates the event without emailing invites. Omitted, the request carries no `sendUpdates` and Google's default stands | `src/tools/create-event.ts`, `src/calendar-client/lib/create-event.ts`, `src/server.ts` (the `createEvent` options) | `../../test/calendar-create-send-updates.test.ts` |
| Show as Free / Busy: `create_calendar_event` and `update_calendar_event` take `transparency` (`opaque` = Busy \| `transparent` = Free) and its alias `show_as` (`busy` \| `free`), set on the event body; the two disagreeing is an error before any request. Omitted, the body carries no `transparency`, so a new event is Busy (Google's default) and an update leaves it as it was. The create, update, get and list results print `**Show as:** Free (transparent)` or `Busy (opaque)`, reading an absent field as Busy; a cancelled event gets no line, and a value Google may add later prints as `Unknown (…)` | `src/utils/show-as.ts`, `src/tools/create-event.ts`, `src/tools/update-event.ts`, `src/tools/get-event.ts`, `src/tools/list-events.ts` | `../../test/calendar-show-as.test.ts` |
| The read tools default to every shown calendar (`HACKS.md` #166). With no calendar named, `list_calendar_events` and `query_calendar_freebusy` search every calendar in the user's calendar list with `selected` set, plus primary (first), at most 50, eight requests at a time. `list_calendar_events` takes `calendar_ids` (a list) beside `calendar_id` (no longer defaulting to `primary`; both are unioned), asks each calendar for `max_results` ordered by start, merges by start (all-day at local midnight), lists one occurrence on two calendars once (`**Also on:**`), and prints `**Calendar:**` on every event. `max_results` is a total; the result says when more matched. A calendar that fails is named and the rest still answer; all failing is an error. `query_calendar_freebusy`'s `calendar_ids` is optional and batched at 50 | `src/utils/calendar-fanout.ts`, `src/tools/list-events.ts`, `src/tools/query-freebusy.ts` | `../../test/calendar-all-calendars.test.ts` |

## Tools

Seven, in two groups:

| Group       | Tools                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------ |
| `readonly`  | `list_calendar_events`, `get_calendar_event`, `list_calendars`, `query_calendar_freebusy` |
| `readwrite` | the four above, plus `create_calendar_event`, `update_calendar_event`, `delete_calendar_event` |

`create_calendar_event`, `update_calendar_event` and `delete_calendar_event`
all take `send_updates`. On create, `"all"` emails invites to the attendees
and `"none"` makes the event without emailing them. Google warns that with
`"none"`, attendees outside Google Calendar may never receive the event. Left
out, the request carries no `sendUpdates` and Google decides; its documented
default is not to notify, though it says some emails might still go out.

`create_calendar_event` and `update_calendar_event` also take `show_as`
(`"free"` or `"busy"`), or the same setting as the API's `transparency`
(`"transparent"` is Free, `"opaque"` is Busy). A Free event does not block time,
so it does not show up as busy in `query_calendar_freebusy`. Left out, a new
event is Busy and an update leaves the setting alone. The read tools take
neither, and every event they print carries a `**Show as:**` line, so a write
can be checked by reading the event back.

`list_calendar_events` and `query_calendar_freebusy` search every calendar
the user has ticked in Google Calendar, plus the primary one, when you name
none: the user's own calendars and the ones shared with them. Each event says
which calendar it came from, and `max_results` counts events across all of
them. Pass `calendar_ids` (for example `["primary"]`) to search only those
calendars; `calendar_id` still works for one. A calendar that cannot be read is
named in the result and does not fail the call. `get_calendar_event` and the
write tools still take one calendar and default to `primary`.

All seven are served unless you set `GOOGLE_CALENDAR_ENABLED_TOOLGROUPS`. The
standalone entrypoint refuses to start on a group it does not recognise
(`read-only`, say) and exits 2. The server on its own would read that as "all
groups" and serve the write tools.

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

The server signs in one of two ways, and `GOOGLE_CALENDAR_AUTH_MODE` picks which:

| `GOOGLE_CALENDAR_AUTH_MODE` | Signs in as | Reaches |
| --------------------------- | ----------- | ------- |
| `service_account`, or unset | a Google **service account with domain-wide delegation**, acting as one user | a Workspace user's calendars. A Workspace admin has to authorize it |
| `oauth`                     | **one Google account**, by an OAuth refresh token it consented to once | that account's calendars, including a personal `@gmail.com` one |

The mode is named, never guessed from which variables are set. With no
`GOOGLE_CALENDAR_AUTH_MODE`, the server uses the service account even if OAuth
variables are present. In `oauth` mode a missing variable is an error that names
it. The server never falls back to a service account. Any other value, such as
`oauth2`, stops the standalone entrypoint at startup with exit code 2. Inside a
strad bundle the server still boots on one, and every tool call fails naming
the variable.

Either way the token is for `https://www.googleapis.com/auth/calendar`, which the
write tools need. In `oauth` mode, a read-only server can get by with
`https://www.googleapis.com/auth/calendar.readonly` and
`GOOGLE_CALENDAR_ENABLED_TOOLGROUPS=readonly`. Google then refuses a write even
if one reached it.

### Service account (`service_account`, the default)

| Variable                             | What it is                                                                                     |
| ------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `GCAL_SERVICE_ACCOUNT_CLIENT_EMAIL`  | the service account's email (`client_email` in its JSON key)                                   |
| `GCAL_SERVICE_ACCOUNT_PRIVATE_KEY`   | its PEM private key (`private_key`). Literal `\n` sequences are turned into newlines           |
| `GCAL_IMPERSONATE_EMAIL`             | the Workspace user whose calendars the server reads and writes                                 |

Before the key works, a Workspace admin has to authorize the service account's
client ID for `https://www.googleapis.com/auth/calendar` under **Admin Console →
Security → API Controls → Domain-wide Delegation**.

### Personal OAuth (`oauth`)

| Variable                              | What it is                                                     |
| ------------------------------------- | -------------------------------------------------------------- |
| `GOOGLE_CALENDAR_AUTH_MODE`           | `oauth`                                                        |
| `GOOGLE_CALENDAR_OAUTH_CLIENT_ID`     | your OAuth client's id                                         |
| `GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET` | its secret                                                     |
| `GOOGLE_CALENDAR_OAUTH_REFRESH_TOKEN` | a refresh token for the account, consented for the scope above |

To get a refresh token with the OAuth Playground:

1. In a Google Cloud project, enable the **Google Calendar API**, and create an
   OAuth client of type **Web application** with the authorized redirect URI
   `https://developers.google.com/oauthplayground`.
2. Open <https://developers.google.com/oauthplayground>, click the gear, tick
   **Use your own OAuth credentials** and paste the client id and secret.
3. In "Input your own scopes", enter `https://www.googleapis.com/auth/calendar`.
   Click **Authorize APIs** and sign in as the account the server should use.
4. Click **Exchange authorization code for tokens** and copy the refresh token.

While the OAuth consent screen is in **Testing** mode, Google expires the
refresh token after 7 days. Every call then fails with `invalid_grant`, and the
error says to mint a new token. Publishing the consent screen keeps the token
for longer. `calendar` is a **sensitive** scope, so an unverified published app
shows Google's "unverified app" warning at consent. For a Workspace account, an
**Internal** consent screen avoids both the expiry and the warning.

The server finds out which address it signed in as by reading the account's
primary calendar, once. It uses the address to add `&authuser=` to event links.
If that read fails, the links have no `authuser` and still open.

### Either mode

| Variable                             | What it is                                                                                     |
| ------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `GOOGLE_CALENDAR_ENABLED_TOOLGROUPS` | optional: `readonly` or `readwrite`. The upstream name `ENABLED_TOOLGROUPS` works when this is unset |

None of the credentials is needed to start. The server reads them on the first
tool call, so with nothing set it still boots and answers `tools/list`, and every
tool call returns an error naming the missing variables. At startup it lists the
selected mode's missing variables on stderr.

## Run it locally (stdio)

stdio is the default transport:

```bash
GCAL_SERVICE_ACCOUNT_CLIENT_EMAIL=calendar-bot@my-project.iam.gserviceaccount.com \
GCAL_SERVICE_ACCOUNT_PRIVATE_KEY="$(jq -r .private_key key.json)" \
GCAL_IMPERSONATE_EMAIL=you@example.com \
node dist/standalone/google-calendar.js
```

Or, as a personal account:

```bash
GOOGLE_CALENDAR_AUTH_MODE=oauth \
GOOGLE_CALENDAR_OAUTH_CLIENT_ID=1234-abc.apps.googleusercontent.com \
GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET=GOCSPX-... \
GOOGLE_CALENDAR_OAUTH_REFRESH_TOKEN=1//0g... \
node dist/standalone/google-calendar.js
```

Start it with `node` directly, not through `npm run`. npm prints a banner to
stdout, and in stdio mode stdout carries only protocol messages. The server logs
to stderr.

An MCP client launches the process itself. Run with `--help`, it prints the
flags. For Claude Desktop
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

In `oauth` mode the `env` block is the four `GOOGLE_CALENDAR_*` variables
instead of the three `GCAL_*` ones. The same goes for `-e` with Claude Code.

This adds the server to the current project only. Add `-s user` to make it
available in every project.

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

The server is stateless. It builds a fresh server for every POST and issues no
session id, so any number of clients can share it. With no session to resume
or end, `GET /mcp` and `DELETE /mcp` answer `405`. Request bodies are limited to
8 MB, the same limit strad's bundle uses.

To check it, list the tools with curl:

```bash
curl -s http://127.0.0.1:3100/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

The reply is a server-sent event. The JSON is on the `data:` line, after
`event: message`.

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
act as the account the server signs in as. On the default loopback host it
refuses any request whose `Host` header is not loopback, so a web page in your
browser cannot reach it through DNS rebinding. Any other `--host`, such as
`0.0.0.0` or a LAN address, turns that check off and exposes the server to your
network. Do that only behind something that authenticates.
Authenticating callers is what strad adds in front of this server.

## Tests

`test/standalone.test.ts` in `images/bundle-google` covers both modes against
the built entrypoint, with no credentials set. It checks the handshake,
`tools/list`, the port flag and env var, the tool-group toggle, the `Host`
check, and that a tool call fails on missing credentials instead of crashing the
server, in both auth modes. `test/calendar-auth-mode.test.ts` covers the mode
switch and the OAuth client: one token exchange per burst, a 401 that drops
both token caches, the `invalid_grant` hint, and the path the bundle mounts. Nothing in
CI calls Google. `npm test` from `images/bundle-google` runs it.
