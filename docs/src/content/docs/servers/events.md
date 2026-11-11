---
title: MCP Events (draft)
description: How strad serves MCP Events in poll mode — events/list and events/poll through core, slug-prefixed and entitled like tools — and the Slack message_posted event behind slack-zimmer.
---

A trigger that fires when something happens needs a feed of things that
happened. MCP Events is that feed, as an MCP extension: a server lists event
types, and a client polls each one with a cursor. strad serves it in **poll mode
only**, and it has one event source today: Slack's `message_posted`, behind
`slack-zimmer`.

:::caution
MCP Events is a **draft** (SEP-3415). It is in no released MCP specification,
and the wire can still change. The commit strad is built against is pinned in
`docs/mcp-events-spec-pin.md` at the repository root. See
[Limitations #131](/limitations/).
:::

## The wire

Three things, all on the ordinary `/mcp` endpoint:

- **The extension.** The `initialize` result carries
  `capabilities.extensions["io.modelcontextprotocol/events"] = {}` when a slug
  selected for the request serves events. Core does not decide that from config.
  It asks each selected upstream's own handshake, in parallel, with a 3-second
  bound per slug. A slow or failing slug counts as "no" for that request. A
  `local-tunnel` slug is never asked: it is a machine that is often off, and
  nothing on one serves events.
- **`events/list`** only asks a slug whose handshake advertised events, so an
  unconfigured, offline or tools-only slug is skipped quietly. A listing that
  fails after the handshake advertised events is a fault, and exports
  `mcp.events_list_failed`.
- **`events/list`** `{cursor?}` returns `{events: [...]}`, the union over the
  selected slugs. Each name is prefixed `<slug>__`, like a tool:
  `slack-zimmer__message_posted`. There is one page and no `nextCursor`.
- **`events/poll`** `{name, arguments, cursor, maxEvents?, maxAgeMs?}` returns
  `{events, cursor, truncated, hasMore, nextPollMs}`. Core strips the prefix,
  forwards the poll to that slug's upstream, and prefixes the names in the
  answer. A `null` cursor means "from now": no events, and a cursor to poll from
  next time.

Core holds no event state. The cursor belongs to the upstream and is opaque to
core, so a poll is one stateless round trip, like every other `/mcp` request.

The `Mcp-Method` and `Mcp-Name` headers the draft asks clients to send are
accepted. Core does not check them yet.

## Who may poll what

A poll is allowed for a slug the request **selected**. That is the same set a
tool call is checked against: the slugs the token is entitled to, narrowed by
`?servers=`. Anything else is Forbidden, `-32024`. That covers a slug the token
cannot reach, one it did not select, and one that does not exist. The refusal
does not say which, so it cannot be used to probe for slugs.

A slug's `tools:` policy does not apply to events. It names tools, and an event
type is not a tool. A caller that should not see a slug's events should not be
entitled to the slug.

| Error                 | Code     | When                                                               |
| --------------------- | -------- | ------------------------------------------------------------------ |
| InvalidParams         | `-32602` | the name is not `<slug>__<event>`; a bad argument; a foreign cursor |
| NotFound (`event`)    | `-32023` | the slug serves no such event type, or is not configured for events |
| Forbidden             | `-32024` | the slug is not selected for this request                          |

An upstream's own refusal reaches the caller with its code and its message. That
matters for the one refusal every deployment sees first: a Slack mount without
its app-level token answers NotFound and names `SLACK_APP_TOKEN`.

## Slack: `message_posted`

The Slack server (`servers/bundle-api/fork/slack`) holds one Slack **Socket
Mode** connection and buffers what arrives. Socket Mode is an outbound
WebSocket, so strad needs no public route and no signing secret for it.

**The event.** A message posted in a channel, a private channel or a direct
message the bot is a member of. The event id is `slack:<channel_id>:<ts>`, which
is the dedupe key. The payload:

| Field          | Notes                                                       |
| -------------- | ----------------------------------------------------------- |
| `channel_id`   |                                                             |
| `channel_type` | `channel`, `group` (a private channel) or `im`              |
| `ts`           | the message's Slack timestamp                               |
| `thread_ts`    | present on a thread reply only; a parent is top-level       |
| `user_id`      | absent on a bot or integration post                         |
| `bot_id`, `username` | present on a bot or integration post                  |
| `is_dm`        | `channel_type` is `im`                                      |
| `mentions_bot` | the text contains `<@BOT_USER_ID>`                          |
| `permalink`    | built from the workspace URL, with no extra API call       |
| `text`         | Slack mrkdwn, cut to 4,000 characters                      |

**What is never an event.** The bot's own posts, so a trigger cannot fire on its
own reply. Edits, deletes, joins, topic changes and every hidden subtype, because
none of them is a message being posted. Group DMs.

**The arguments.** All optional, and each one only narrows. An unknown argument
is refused rather than ignored, because a filter that is silently dropped widens
a trigger.

| Argument              | Default | Narrows to                                              |
| --------------------- | ------- | ------------------------------------------------------- |
| `addressed_to_bot`    | —       | a DM to the bot, or text containing `<@BOT_USER_ID>`    |
| `channel_ids`         | —       | these conversations                                     |
| `include_dms`         | `true`  | `false` drops DMs                                       |
| `thread_ts`           | —       | that thread: its parent and its replies                 |
| `top_level_only`      | —       | messages that are not thread replies                    |
| `include_bot_authors` | `true`  | `false` drops bot and integration posts                 |

### The buffer

Events are kept for 7 days in one sealed object, beside a lease object, in
strad's [state store](/operate/state-store/): the bucket the
[WhatsApp](/servers/whatsapp/) bridge also uses, in a `slack-events/` folder of
the ingest's own.

- **Sealed.** AES-256-GCM under `SLACK_EVENTS_STATE_ENCRYPTION_KEY`, the
  ingest's own key, with the object's name as authenticated data. The bucket
  holds no readable message text.
- **One writer.** A process claims the lease when it starts, so the newest one
  owns it. A process that finds the lease is someone else's closes its socket and
  stops writing. This matters more for Slack than for WhatsApp. Slack spreads one
  app's events across all of its open Socket Mode connections, so two live
  sockets would each get half the stream.
- **Written every couple of seconds**, not per event, and on SIGTERM.
- **A heartbeat in the lease.** The owner refreshes it every 30 seconds. A
  superseded process takes the lease back once the heartbeat is 90 seconds old,
  so a newer container that dies or rolls back does not leave the feed down
  until somebody restarts the old one.
- **Merging after a write conflict re-sequences.** The other writer's events
  that are new to this buffer get fresh sequence numbers, above every cursor
  already handed out, so a client never steps over them.
- **The cursor is a sequence number** that grows with the clock, so a cursor
  from one process still works after a deploy, and after the buffer is lost.
- **`truncated: true`** means an event after the cursor was evicted, by age or
  by the 20,000-event cap.

### Backfill

Every time the socket says hello, on the first connection and on every
reconnect, the ingest re-reads each conversation the bot is in, from two minutes
before the last moment any process held a live socket. Top-level messages come
from `conversations.history`. Replies come from `conversations.replies`, which
is asked only for a parent whose latest reply falls inside the gap. The dedupe
on `channel:ts` drops what the buffer already holds.

**The gap is not given up until it has been read.** `live_through` does not
move while a backfill is owed. A conversation that fails is counted, the others
are still read, and the gap is re-read on the next pass. That pass is the
settle pass below, a retry every five minutes while the socket is up, or the
next reconnect.

It runs once more about 75 seconds after connecting. During a deploy the old
and new containers overlap, and Slack can hand some events to the old socket in
that window. The old process is about to lose the lease and will not write them,
so this second backfill picks them up.

A first-ever boot backfills nothing. "From now" is the only honest start for a
buffer that has never been live.

### `slack_events_status`

A read-only tool, listed on every Slack slug. It reports the state
(`not_configured`, `connecting`, `connected`, `reconnecting`, `superseded`, …),
when the socket opened, the last backfill and how much it recovered, the buffer's
size and age, the last GCS write, and the lease. When events are not configured
it names the missing variables. It never shows their values.

### Turning it on

The ingest needs six variables on the component serving the slug:

| Variable                            | What                                                           |
| ----------------------------------- | -------------------------------------------------------------- |
| `SLACK_APP_TOKEN`                   | the Slack app-level token, `xapp-…`, scope `connections:write` |
| `SLACK_BOT_TOKEN`                   | the bot token the tools already use                            |
| `SLACK_EVENTS_STATE_ENCRYPTION_KEY` | 32 random bytes, base64 or hex (`openssl rand -base64 32`)     |
| `STRAD_STATE_GCS_BUCKET`            | the shared [state store](/operate/state-store/) bucket         |
| `STRAD_STATE_GCS_CLIENT_EMAIL`      | its service account                                            |
| `STRAD_STATE_GCS_PRIVATE_KEY`       | that service account's `private_key`                           |

`SLACK_EVENTS_STATE_PREFIX` (default `slack-events`, and always `slack-events`
or a folder under it) and `SLACK_EVENTS_RETENTION_DAYS` (default 7, at most 30)
are optional.

**How they reach the container.** The first three are the slug's own. Use
`params: true` on the slug, with the `gcp-parameter-store` provider: the slug's
whole namespace lands on its component, so seeding
`/strad/prod/mcp/slack-zimmer/static/SLACK_APP_TOKEN` and
`.../SLACK_EVENTS_STATE_ENCRYPTION_KEY` in the console is the step. The three
`STRAD_STATE_GCS_*` are the deployment's, seeded once at
`/strad/prod/gateway/static/` and shared with the WhatsApp bridge. They reach
this slug only if its `env:` names them, as `"${STRAD_STATE_GCS_BUCKET}"` and
so on. Add those three references only once all three are seeded; a deploy
picks up the rest. Do **not** put any of the six behind `mayBeUnseeded:` before
they are seeded. That marks the whole slug `unconfigured` until they land,
which takes the existing Slack tools down with it.

The bucket and its service account are made in GCP by hand, once per
deployment, and are the same ones the WhatsApp bridge uses. See
[State store](/operate/state-store/) and [Limitations #131](/limitations/).

Until all six are present the mount is inert. It opens no socket, makes no
Slack or GCS call, lists no event types and does not advertise the extension.
The other Slack tools are unaffected.

On the Slack side, the app needs Socket Mode turned on, an app-level token, and
bot event subscriptions for `message.channels`, `message.groups` and `message.im`.
Backfill reads with the history scopes the bot already has
(`channels:history`, `groups:history`, `im:history`) and lists its
conversations with `channels:read`, `groups:read` and `im:read`.

**One instance.** The component that holds the socket must run one instance.
The lease stops a second one from writing, but each socket still takes its share
of Slack's events until the lease check closes it.
