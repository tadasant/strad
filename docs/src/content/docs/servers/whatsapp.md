---
title: WhatsApp
description: How strad sits in an existing WhatsApp group as a linked device of one account — pairing by code with no shell, state sealed in GCS, one instance, and the tool contract Zimmer polls.
---

Sit in a WhatsApp group chat that already exists — one a person created on their
phone — read what is said there, and post into it. That requirement decides the
whole design.

`whatsapp-zimmer` is strad's own MCP server — source in `servers/whatsapp/`,
mounted at `/whatsapp` inside the bundle image. It is also the long-lived
WhatsApp client itself: the server and the "bridge" are one process.

:::caution
This is an unofficial client. Automating a WhatsApp account through it is against WhatsApp's Terms of Service, and the account can be banned. See [Limitations #109](/limitations/).
:::

## Why a linked device

WhatsApp's official Cloud API is for business numbers, and a Cloud API number
cannot join a group a consumer created. The only way into an existing group is
as a **linked device** of a real account — the multi-device protocol WhatsApp
Web and the desktop app speak. This server speaks it through
[Baileys](https://github.com/WhiskeySockets/Baileys), a Node implementation.

**That makes it unofficial.** Automating an account this way is against
WhatsApp's Terms of Service and the account can be banned for it. Every tool
description says so, because a tool description is what an agent reads before it
acts. The server keeps the risk down where it can (see
[Sending](#sending)), but it cannot remove it.

It works for a dedicated number or a person's own number. Nothing in the code
assumes which. On a personal number, a message this server sends is that person
speaking, under their own name.

## Tools

| Tool                    | Group     | What it does                                                         |
| ----------------------- | --------- | -------------------------------------------------------------------- |
| `whatsapp_status`       | readonly  | Paired? Connected? Healthy only when both are true                    |
| `whatsapp_list_chats`   | readonly  | Chats and groups, newest activity first — where a chat id comes from |
| `whatsapp_get_messages` | readonly  | One chat's buffered messages, oldest first, with a forward cursor    |
| `whatsapp_get_attachment` | readonly | Read one message's file: a PDF's text, an image, a one-time link    |
| `whatsapp_send_message` | readwrite | Post a text message as the paired account, optionally quoting one    |
| `whatsapp_pair`         | admin     | Start pairing: a code to enter on the phone, or a QR to scan          |
| `whatsapp_logout`       | admin     | Unlink, and delete everything persisted                              |

Every successful result is a JSON object in `structuredContent` and the same
JSON as the first text item. `whatsapp_pair {"method":"qr"}` adds one more item
after it: the QR as an MCP `image` block (`image/png`). `whatsapp_get_attachment`
adds the file's text, or the image, the same way. A failure is an MCP error result (`isError: true`)
whose text says what went wrong and what to do next. Timestamps are integer UNIX seconds. Chat ids are WhatsApp JIDs:
`…@g.us` for a group, `…@s.whatsapp.net` (or `…@lid`) for a person.

### The read Zimmer polls

Zimmer's `whatsapp` trigger calls `whatsapp_get_messages` every minute, and the
paging rule is what makes that safe:

- **With `after`** (inclusive): the **oldest** `limit` messages at or after it,
  and `has_more: true` when more matched. A cursor that passes the last timestamp
  it saw, and drops ids it already has, never skips a message.
- **Without `after`**: the **newest** `limit`.
- Oldest first either way. `limit` defaults to 50 and stops at 200.

Each message carries `sent_by_bridge` (this server posted it — skip it, or the
bridge answers itself), `from_me` (the paired account sent it, from any device),
`mentions_self` and `reply_to_self` (matched against the account's phone JID
**and** its LID, since WhatsApp addresses group members by either), `type`
(`text`, `image`, `video`, `audio`, `document`, `sticker`, `reaction`, `other`),
and `text` (the text, or a media caption). A media message — `document`,
`image`, `video`, `audio`, `sticker` — also carries `attachment`: `file_name`,
`mime_type`, `size_bytes`, `page_count` when the document states one, and
`available`, with `unavailable_reason` when it is false (see
[Attachments](#attachments)). System notices and protocol messages
are not messages and never appear. An edit replaces a buffered message's text;
a delete-for-everyone removes it.

`whatsapp_status` returns one field beyond the minimum Zimmer needs,
`last_disconnect_reason` — `logged_out`, `connection_replaced`,
`replaced_by_another_instance`, `pairing_code_expired`, `state_unreadable` and
so on — so an unhealthy poll says why.

## There is no history API

A linked device cannot ask WhatsApp for a chat's past. It gets a **history sync**
once, when it is paired — recent messages, as the phone chooses to send them —
and after that it knows only what its socket receives. So the server keeps its
own **buffer**: the last 1000 messages or 30 days per chat, whichever is
smaller (`WHATSAPP_BUFFER_MAX_MESSAGES`, `WHATSAPP_BUFFER_MAX_AGE_DAYS`).
`whatsapp_get_messages` reads that buffer and nothing else.

Two consequences, both honest limits:

- A message sent while the socket was down is only there if WhatsApp replays it
  on reconnect. It usually does for short gaps. This is why Zimmer treats a poll
  as healthy only when `connected && paired`.
- A chat the account has not heard from since pairing shows only what the history
  sync carried.

## Setup

strad has no database and App Platform has no persistent disk, so the bridge's
state lives in strad's [state store](/operate/state-store/): one GCS bucket
shared by every stateful server, in a folder of the bridge's own, under a key of
its own. None of these is ever returned by a tool or handed to an agent.

| Variable                        | Kind   | What it is                                                                   |
| ------------------------------- | ------ | ---------------------------------------------------------------------------- |
| `WHATSAPP_STATE_ENCRYPTION_KEY` | secret | 32 random bytes, base64 or hex: `openssl rand -base64 32`. This bridge's own |
| `STRAD_STATE_GCS_BUCKET`        | config | The shared state bucket. Deployment-wide                                     |
| `STRAD_STATE_GCS_CLIENT_EMAIL`  | config | Its service account. Deployment-wide                                         |
| `STRAD_STATE_GCS_PRIVATE_KEY`   | secret | That service account's private key. Deployment-wide                          |
| `WHATSAPP_STATE_PREFIX`         | config | Optional. The folder: `whatsapp` or one under it. Default `whatsapp`         |
| `WHATSAPP_BUFFER_MAX_MESSAGES`  | config | Optional. Default 1000                                                       |
| `WHATSAPP_BUFFER_MAX_AGE_DAYS`  | config | Optional. Default 30                                                         |
| `WHATSAPP_PUBLIC_SLUG`          | config | Optional. The gateway slug attachment links are addressed to (below)         |

Seed the key under the slug (`/strad/{env}/mcp/whatsapp-zimmer/static/`). The
three `STRAD_STATE_GCS_*` are seeded once for the deployment and referenced from
the slug's `env:`; [State store](/operate/state-store/) has the setup.

A deployment set up before the bucket was shared holds `WHATSAPP_GCS_BUCKET`,
`WHATSAPP_GCS_CLIENT_EMAIL`, `WHATSAPP_GCS_PRIVATE_KEY` and
`WHATSAPP_GCS_PREFIX`. The bridge still reads each of them when its successor is
unset, so it keeps the same bucket and folder with nothing re-seeded. A legacy
and a current name that name two different buckets, or two different folders,
are refused at boot rather than resolved. The move onto the shared names is
[three ordered steps](/operate/state-store/#an-existing-whatsapp-deployment).

Under the prefix the server writes:

```
{prefix}/auth.bin           the linked device's Signal state (creds + keys)
{prefix}/index.bin          chat list, names, LID↔phone map
{prefix}/chats/{hash}.bin   one chat's buffered messages
{prefix}/lease.json         which process owns the account
```

Every object except the lease is sealed with **AES-256-GCM** under
`WHATSAPP_STATE_ENCRYPTION_KEY`, with the object's own name as associated data,
so a blob only opens under the name it was written to. A chat's object is named
by a hash of its JID, so the bucket listing does not say who the account talks
to. The key and the state together are the account: whoever holds both can read
every chat and post as it.

**Changing the key** makes the stored state unreadable. The server says so
(`state_unreadable`) and does not connect; it does not silently start over.
Restore the old key, or call `whatsapp_logout` and pair again. The same goes for
**changing the prefix**: the associated data is the full object name, prefix
included, so objects moved to another prefix do not open either.

Give each deployment its **own prefix** — staging uses `whatsapp/staging`. Two
deployments sharing one prefix are two processes on one linked device.

## Pairing, with no shell

Pairing is a tool call, so nobody opens a console on the container. There are two
routes, and both run from the console playground (`/playground/<slug>`) or an
agent session entitled to the slug.

**By code** (the default):

1. Call `whatsapp_pair` with the account's number in E.164 digits, no `+`:
   `{"phone_number": "15551234567"}`. It returns an 8-character code such as
   `ABCD-EFGH`.
2. On the phone: **WhatsApp › Settings › Linked devices › Link a device**, then
   tap **"Link with phone number instead"** and type the code. Do not wait for a
   prompt to appear on the phone: WhatsApp stopped reliably sending the automatic
   "enter this code" notification to linked-device clients around August 2026
   (whatsmeow#1271, with matching Baileys reports). The manual path works.
3. `whatsapp_status` turns `paired: true, connected: true`.

**Only the newest code works.** Every `whatsapp_pair` call starts a fresh
identity on a fresh socket, so the code an earlier call returned is dead the
moment a later one is made. The code lives as long as its socket waits — at least
two minutes. If it lapses, `whatsapp_status` says `pairing_code_expired`.

**By QR**, the second route — from the playground on a laptop, with the phone's
camera:

1. Call `whatsapp_pair` with `{"method": "qr"}`. The result carries the QR as a
   PNG `image` block, drawn in the bundle process (the payload holds this
   device's pairing keys, so it never goes to a QR service), plus the payload as
   text and `expires_in_seconds`. The playground draws the image.
2. On the phone: **WhatsApp › Settings › Linked devices › Link a device**, and
   scan it.
3. WhatsApp rotates the QR about once a minute. Call `{"method": "qr"}` again
   for the current one: while a QR attempt is alive, the call returns its live
   QR instead of starting over. A code call does start over, and kills the QR.

Pairing is refused while an account is already paired: `whatsapp_logout` first.

### What the phone calls this device

The phone lists the device as **Chrome on Mac OS** — Baileys'
`Browsers.macOS("Chrome")` preset, the identity every pairing presents. It is not
configurable. The pairing-code request carries the device's OS and browser
(`companion_platform_display` reads `Chrome (Mac OS)`), and the phone refuses a
code whose OS it does not recognise with nothing more specific than **"Couldn't
link device"**. A custom device name sits in exactly that slot, so there is no
place left to put one. Tell it apart in the Linked devices list by its "last
active" time.

### When pairing fails

The bundle's stderr has a `[whatsapp]` line for each step a pairing reaches and
each close, with its status and Baileys' reason. No pairing line carries the
code, the QR or the number (the `connected as …` line once paired names the
account, as it always has):

```
[whatsapp] pairing (code): started as Chrome on Mac OS
[whatsapp] pairing (code): WhatsApp offered a pairing session
[whatsapp] pairing (code): code issued; waiting for it to be entered on the phone
[whatsapp] pairing: the phone accepted the code; waiting for WhatsApp to confirm the device
[whatsapp] pairing: WhatsApp confirmed the device (pair-success); expecting a restart (515)
[whatsapp] connection: closed 515 (restart_required), during a code pairing: Stream Errored (restart required)
```

A phone that refused the code never reaches "the phone accepted the code". One
that accepted it and still failed stops before "WhatsApp confirmed the device",
and the `ended unpaired` warning says which.

Nothing is written to GCS until WhatsApp accepts the device. Pairing a
**different** account than the buffer belongs to discards the old buffer.

## The phone must come online every 14 days

WhatsApp logs out every linked device of an account whose phone has been offline
for about **14 days**. The server sees that as a logout (`401`): it deletes the
dead login, keeps the buffer, stops reconnecting, and `whatsapp_status` reports
`paired: false` with `last_disconnect_reason: "logged_out"`. A human pairs again.
The same happens when someone removes the device from the phone's Linked devices
list. A `403` (typically a banned or restricted account) also stops reconnecting,
with `last_disconnect_reason: "forbidden"`; the login is kept, and a human decides
what happens next.

## Exactly one instance

A linked device is one socket. Two processes holding the same state open two
sockets on one device, WhatsApp kicks one off, and both keep writing its Signal
state — a session that silently stops decrypting. So:

- **The component must not scale horizontally.** `whatsapp-zimmer` is on its own
  bundle, `bundle-whatsapp`, at `instanceCount: 1`, and `render-spec` refuses to
  render more than one instance of any bundle serving `/whatsapp`.
- **A deploy overlaps two containers anyway** — App Platform starts the new one
  before stopping the old. The server holds a **lease** in GCS: a process claims
  it at start, so the newest process owns the account. Every process re-reads
  the lease every 30 seconds, before every state write, and before every
  reconnect; one that finds it lost closes its socket and stops writing. The
  auth write is also conditional on the GCS generation the process last saw. A
  socket WhatsApp reports as replaced (`440`) waits ten minutes and then checks
  the lease before trying again, so two live processes cannot ping-pong.
- **SIGTERM flushes.** The bundle host closes the mount on shutdown, which writes
  any pending state before exit.
- **A dropped connection to GCS is retried.** The bridge reaches the bucket
  through the state store's small GCS JSON-API client on Node's built-in `fetch`, with a
  service-account token it signs itself. It does not use `@google-cloud/storage`,
  whose node-fetch 2 transport failed every token request on prod (see
  [Limitations](/limitations/) #109). Every bucket call, and the token fetch it
  may need, is retried on a transport error (a connection closed mid-response,
  reset, refused or timed out), and on 408, 429 or 5xx when the call is safe to
  repeat: up to four tries, backing off from 250 ms, no new try after 15
  seconds, and 30 seconds at most for any one request. A 401 gets one more try
  with a fresh token. A write that is not conditional replays only when it
  certainly was not applied (the token fetch failed, or GCS answered 401 or
  429), since one that may have landed could overwrite a newer process's lease. Each retry writes one
  `[whatsapp] WARN GCS …` line to the container's stderr with the error's full
  cause chain and codes. When the budget runs out on a dropped connection or a
  retryable status, a tool answers with a message ending `transient; retry`
  and does not echo the transport's error. Any other refusal (403, a rejected
  key) is reported as GCS worded it. A
  send is the exception: a connection that drops during
  `whatsapp_send_message` may have come after the message went out, so that
  error says to check `whatsapp_get_messages` before retrying.

Every other container that runs the bundle image — the main `bundle`,
`bundle-zimmer-secrets` — lists `/whatsapp`'s tools degraded and never connects,
because only `bundle-whatsapp` carries the four variables.

## Sending

`whatsapp_send_message` posts **as the paired account**: its name, its number,
nothing marking it as software. To look less like a bot:

- a "typing…" indicator shows first, for a moment proportional to the length;
- sends are at least 3 seconds apart;
- past **6 a minute or 60 an hour** a send is **refused**, with the wait — never
  queued. A queue nobody watches is bulk sending.

It sends only to a chat the bridge knows (`whatsapp_list_chats`), so a typo'd id
cannot message a stranger. The message id is chosen by the bridge and written to
GCS as the bridge's **before** the message is sent, and the sent message itself
is written before the call returns. So a send that reaches WhatsApp and then
fails, a crash, or a redeploy cannot leave a message the bridge posted without
`sent_by_bridge: true` — on a personal number `from_me` is also true of what the
person types, so that flag is the only way a caller can skip its own posts.

The device is marked `markOnlineOnConnect: false`, so the phone keeps getting
notifications — on a personal number, the person is still told about their own
messages.

## Attachments

`whatsapp_get_attachment {chat_id, message_id}` reads the file a media message
carries. **These are the private files of the paired account** — whatever anyone
sent it: contracts, IDs, photos — and the tool description says so. It is in the
`readonly` group, because reading an attachment is reading.

What the buffer keeps, per media message, is what a later download needs:
WhatsApp's media key, the CDN path and URL, both SHA-256s, the length, MIME type,
filename, page count and the message's original key. It is sealed with the rest
of the chat object and never returned by a tool. Live messages and history-sync
messages both keep it.

A call fetches the encrypted file from WhatsApp's CDN, checks its SHA-256 and
MAC, decrypts it, checks the plaintext SHA-256, and returns:

- the file's name, MIME type, size and page count, as JSON;
- for a PDF or a text file, the text, at most **200 KB**, with
  `text_truncated: true` and a note when there was more. PDF text comes from
  [`unpdf`](https://github.com/unjs/unpdf) (Mozilla's pdf.js, no native code, no
  network), page by page, in a worker thread with a bounded heap that is
  terminated at the cap or after 20 s, so a hostile PDF cannot stall the
  bundle's event loop. A scanned PDF with no text layer says so;
- for an image or a sticker up to 5 MB, an MCP `image` block;
- always, a **single-use link** to the file through core's
  `/mcp-download/<slug>/<token>`, the route [Slack attachments](/servers/slack-attachments/)
  use, with a `curl` line. It expires in 15 minutes and needs no credential.

Video and audio are the link only.

**Limits.** A file over **25 MB** is refused — before the download when the
message declares its size, and mid-stream when it does not. A download is
abandoned after **60 s**, a phone that never answers a re-upload included. Two
downloads run at once; more wait their turn. Only WhatsApp's own hosts
(`https://*.whatsapp.net`) are fetched, with no redirects: the URL in a media
message is written by whoever sent it. Nothing is written to disk or to the
bucket, and no line logs a filename or a byte of content.

**An expired copy.** WhatsApp's CDN forgets a file after a while and answers 404
or 410. The bridge then asks the phone to upload it again (Baileys'
`updateMediaMessage`), fetches once more, and keeps the new location for the
next read. That needs the socket connected and the phone online.

**Messages buffered before descriptors were kept** show `available: false` and
say why. `whatsapp_get_attachment` asks the phone to send the message again, two
ways at once: a resend of that one message, and an on-demand history sync of the
50 messages before the next one buffered. Either answer is ingested like any
other message, with its descriptor, and the call waits up to 30 s for it. A
history copy of a message already buffered adds only its descriptor, so it
cannot undo an edit. If the phone does not answer — offline, or it no longer
has the message — the error says so, and a later call asks again. This is best effort and has not been exercised against a real phone
in CI.

**The transport is strad's, not Baileys'.** Baileys 7.0.0-rc14's
`downloadMediaMessage` pipes the CDN response into its decipher without
listening for the response's errors, so a connection dropped mid-file is an
uncaught exception in the bundle process, and its re-upload hook never fires
(it tests `error.status`; its own errors carry `output.statusCode`). The bridge
uses Baileys' key derivation and CDN host rule, and its own abortable `fetch`.

### The link

The token is the payload **sealed** (AES-256-GCM), not merely signed: it names a
chat, which is a phone number or a group, and a URL path reaches the edge access
log. The key is derived from the component's `STRAD_INTERNAL_TOKEN`, the gateway
slug and a fingerprint of `WHATSAPP_STATE_ENCRYPTION_KEY`, so a link presented to
the other account's container does not open there. The file is fetched again
when the link is presented; nothing is stored. A link spent on a fetch that
produced no bytes is handed back, so a retry works. Spent links are remembered
in memory, which the one-instance component makes the whole ledger; a restart
forgets them, and the 15-minute expiry still holds.

Every WhatsApp slug is served at `path: /whatsapp`, so the container cannot know
which slug the gateway routes to it: `WHATSAPP_PUBLIC_SLUG` names it, as
`SLACK_PUBLIC_SLUG` does for Slack. Any slug on the same component works. Unset,
or outside a strad deployment (no `STRAD_PUBLIC_URL` or `STRAD_INTERNAL_TOKEN`),
the file is still read and the result carries `download_url: null` with the
reason; the boot log names what was missing.

## Events

A slug that sets `WHATSAPP_EVENTS_ENABLED: "true"` also publishes
[`message_received`](/servers/events/#whatsapp-message_received), an MCP Events
event for every message the bridge receives live, filterable by chat, by
direct or group, and by whether the account sent it. It needs no new secret:
the event buffer sits in this server's folder, sealed under its key. Off by
default.

## Logging

Nothing logs a message's text, an attachment's name or contents, a key, or a pairing code. Baileys' own logger is
silenced (at debug it prints decrypted messages), and every line and every tool
error runs through a redactor that removes key-shaped runs and PEM blocks. A
phone number is not redacted: it is what an operator needs to see.

## What is not here

- **Sending media.** The bridge reads attachments; it sends text only.
- **Reactions as a tool.** Reactions others send arrive as `type: "reaction"`
  messages; the bridge does not send them.
- **A second account in one deployment.** One linked device is one account. A
  second account is a second component with its own prefix.

See [Limitations](/limitations/) for the full list of what this costs.
