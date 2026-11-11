---
title: MCP Events (draft)
description: How strad serves MCP Events — events/list, events/poll and webhook delivery through core, slug-prefixed and entitled like tools — and the Slack message_posted event behind slack-zimmer.
---

A trigger that fires when something happens needs a feed of things that
happened. MCP Events is that feed, as an MCP extension: a server lists event
types, and a client either polls each one with a cursor or subscribes a webhook
that the server POSTs to. strad serves **poll** and **webhook** delivery, not
push (`events/stream`), and it has one event source today: Slack's
`message_posted`, behind `slack-zimmer`.

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
- **`events/subscribe`** and **`events/unsubscribe`** are webhook mode; see
  [Webhook delivery](#webhook-delivery). Core strips the prefix and forwards
  them with a `_meta` of its own: `strad/principal`, the authenticated caller,
  and `strad/name`, the prefixed name. Whatever `_meta` the client sent is
  dropped, so no caller can subscribe as someone else.

Core holds no event state. The cursor belongs to the upstream and is opaque to
core, so a poll is one stateless round trip, like every other `/mcp` request.

The `Mcp-Method` and `Mcp-Name` headers the draft asks clients to send are
accepted. Core does not check them yet.

## Who may poll what

A poll, a subscribe or an unsubscribe is allowed for a slug the request **selected**. That is the same set a
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
| Forbidden             | `-32024` | the slug is not selected for this request; a subscribe with no principal |
| ResourceExhausted     | `-32025` | the subscription cap (100), or too many verifications to one host  |
| Unsupported           | `-32026` | `events/subscribe` with a `delivery.mode` other than `webhook`     |
| CallbackEndpointError | `-32027` | the webhook endpoint failed verification; `data.reason` says how   |

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

### Webhook delivery

`message_posted` lists `delivery: ["poll", "webhook"]`. A client that would
rather be told than ask subscribes a URL, and the Slack mount POSTs each event
to it. Polling keeps working beside it, from the same buffer and in the same
cursor space, so a client can do both and use poll to catch up.

**Subscribe.** `events/subscribe` with
`{name, arguments, delivery: {mode: "webhook", url, secret}, cursor, maxAgeMs?, ttlMs?}`
answers `{id, refreshBefore, cursor, truncated}`, and on a refresh adds
`deliveryStatus` `{active, lastDeliveryAt, lastError, failedSince?}`.

- **The key** is `(principal, url, name, arguments)`, the principal being the
  one core authenticated. Calling `events/subscribe` again with the same key
  refreshes it. `id` is `sub_` plus 32 hex characters of a SHA-256 over the key:
  stable across refreshes and restarts, and not accepted as input anywhere.
- **The URL** must be `https`, carry no credentials, and not name a loopback,
  private or reserved address. Otherwise `-32602`.
- **The secret** is the client's: `whsec_` and the base64 of 24 to 64 random
  bytes. strad never generates one, never logs one and never returns one. A new
  secret on a refresh replaces the old one, and both sign for ten minutes.
- **The TTL.** `ttlMs` is a suggestion. The grant is 1 hour when it is omitted,
  at least 1 minute, and at most 24 hours. `ttlMs: null` asks for no expiry and
  gets 24 hours: strad does not grant no-expiry.
- **The cursor.** `null` starts from now. Any cursor `events/poll` handed out
  starts after it. One older than what the buffer still holds starts at the
  oldest event held, and the answer says `truncated: true`. `maxAgeMs` skips
  events older than that, and says `truncated` if it skipped any.
- **`events/unsubscribe`** `{name, arguments, delivery: {url}}` removes the
  subscription with that key. None: NotFound, `data.kind: "subscription"`.

**Verification.** Before the first delivery to a URL, strad POSTs a signed
`{"type":"verification","challenge":"<nonce>"}` while `events/subscribe` waits.
The endpoint proves it wants deliveries by answering `2xx` with
`{"challenge":"<nonce>"}`; strad compares in constant time. Anything else fails
the subscribe with `-32027` CallbackEndpointError: `data.reason` is
`challenge_failed` when the endpoint answered without the nonce (a redirect to a
login page, a login page, a `401`), or `connection_refused`, `timeout` or
`tls_error` when it did not answer. A verified `(principal, url)` stays verified
while subscribed, up to a day after its last subscribe. At most five
verifications per host per minute, then `-32025`. Challenge-echo is the only
method built: no allowlist, no `/.well-known/mcp-webhook-receiver.json`.

**Delivery.** One POST per event:

```
POST <url>
content-type: application/json
webhook-id: msg_<random>
webhook-timestamp: <unix seconds>
webhook-signature: v1,<base64 HMAC-SHA256(secret, id + "." + timestamp + "." + body)>
x-mcp-subscription-id: sub_<32 hex>

{"eventId":"slack:C…:17…","name":"slack-zimmer__message_posted","timestamp":"…","data":{…},"cursor":"v1.…"}
```

- **Signing** is [Standard Webhooks](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md),
  checked in the tests against the specification's own test vector.
- **`eventId`** is the same as on the poll path, so a receiver that dedupes on
  it fires once whichever path an event arrived by.
- **`cursor`** is the watermark: every event at or before it was acknowledged
  or given up. It never runs ahead of an unacknowledged event, so it is always
  safe to persist and to poll from.
- **Retries.** Five attempts: at once, then after 30 seconds, 2½, 7½ and 14½
  minutes. The `webhook-id` stays the same and the timestamp and signature are
  new each time. `2xx` is accepted. `410` and `413` are not retried. Anything
  else is, `429` included. A request is given 10 seconds.
- **Order.** At most ten events are in flight per subscription, oldest first,
  so arrival order is close to buffer order but not guaranteed.
- **Sustained failure suspends, it does not discard.** An event whose five
  attempts all fail is given up only if the endpoint has answered since that
  event's first attempt with a `2xx`, `410` or `413`: the endpoint is up and
  refuses this one. If
  it has not answered at all, the subscription is suspended
  (`deliveryStatus.active: false`). Nothing is given up and the watermark holds.
  The next refresh reactivates it, and delivery resumes from the watermark, out
  of the buffer, for as long as the buffer keeps the events (7 days by default).
  A refresh reactivates whichever container it lands on: it records its time,
  and a suspension older than the last refresh does not stand.
- **`lastError`** is cleared by the next answer from the endpoint, a `2xx` or a
  deliberate `410` or `413`, so a healthy subscription refreshes with
  `lastError: null`.
- **A gap.** If the buffer evicted events the subscription had not been sent,
  strad POSTs a signed `{"type":"gap","cursor":"<fresh>"}` first, and carries on
  from the oldest event it still holds.
- **SSRF.** The host is resolved again on every attempt, every address it
  resolves to must be globally routable, and the connection is made to the
  address that was checked, with the hostname kept for TLS and `Host`. Every
  IPv4-mapped or IPv4-compatible IPv6 address is refused, in any spelling, and
  an IP-literal URL is held to the same rule.
  Redirects are never followed. A refused address is reported as
  `connection_refused`, never with the far end's own words.
- **Edge credentials.** A receiver behind an access gateway (Zimmer's sits
  behind Cloudflare Access) needs strad's credential on each request. A
  callback URL under a prefix in `SLACK_EVENTS_WEBHOOK_ACCESS_PREFIXES` gets
  `CF-Access-Client-Id` and `CF-Access-Client-Secret` from
  `ZIMMER_APPROVAL_CF_ACCESS_CLIENT_ID` and `_SECRET`, on the challenge and on
  every delivery. A prefix is a host AND a path —
  `https://zimmer.tadasant.com/webhooks/mcp_events/` — over `https` on the
  default port; a whole host is refused. A subscriber chooses its URL, so a
  token sent to any URL would be handed to whoever subscribes, and a token sent
  to any path on a host could be presented to whatever else that host's edge
  admits it to. Dot segments are resolved before the match, so a path cannot
  climb out of the prefix, and since no redirect is followed the headers cannot
  travel on.

**Where subscriptions live.** In `webhooks.bin`, sealed under the ingest's key
in its folder of the [state store](/operate/state-store/), beside the buffer.
Any container may write it, because a subscribe can land on one that does not
hold the lease. Only the lease holder delivers, and it re-reads the registry
every 15 seconds. A restarted container resumes delivering from the persisted
watermark with no resubscribe. Expired subscriptions are dropped.

### `slack_events_status`

A read-only tool, listed on every Slack slug. It reports the state
(`not_configured`, `connecting`, `connected`, `reconnecting`, `superseded`, …),
when the socket opened, the last backfill and how much it recovered, the buffer's
size and age, the last GCS write, and the lease. On the lease holder it lists
the webhook subscriptions: id, name, the callback's host (never its path or
secret), active or suspended, the last delivery and error, and the cursor. It
names the URL prefixes that get edge credentials, never the credential. When events
are not configured it names the missing variables. It never shows their values.

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
are optional. So are the three webhook edge-credential variables:
`SLACK_EVENTS_WEBHOOK_ACCESS_PREFIXES` (plain config, comma-separated `https`
URL prefixes with a path ending in `/`) and `ZIMMER_APPROVAL_CF_ACCESS_CLIENT_ID` / `_SECRET` (secret,
the slug's own namespace). The two token names are the ones a deployment that
already sends strad's confirmation calls through Zimmer's edge seeds per slug
(`confirmationHeaders:` on the gmail slugs): one token, one meaning — strad
calling Zimmer behind Access — under one pair of names. All three or none: a partial set turns the headers
off, says why on `slack_events_status`, and leaves polling and every other
webhook untouched.

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
