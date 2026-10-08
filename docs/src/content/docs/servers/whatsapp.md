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
| `whatsapp_send_message` | readwrite | Post a text message as the paired account, optionally quoting one    |
| `whatsapp_pair`         | admin     | Start pairing: returns a code a human enters on the phone            |
| `whatsapp_logout`       | admin     | Unlink, and delete everything persisted                              |

Every successful result is a JSON object in `structuredContent` and the same
JSON as the first text item. A failure is an MCP error result (`isError: true`)
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
and `text` (the text, or a media caption). System notices and protocol messages
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
state lives in **GCS**. Four variables are required; seed them in strad's console
(`/ui/secrets`) for the `whatsapp-zimmer` slug. None of them is ever returned by
a tool or handed to an agent.

| Variable                        | Kind   | What it is                                                                  |
| ------------------------------- | ------ | --------------------------------------------------------------------------- |
| `WHATSAPP_STATE_ENCRYPTION_KEY` | secret | 32 random bytes, base64 or hex: `openssl rand -base64 32`                   |
| `WHATSAPP_GCS_BUCKET`           | config | A **private** bucket                                                        |
| `WHATSAPP_GCS_CLIENT_EMAIL`     | config | A service account with `roles/storage.objectAdmin` on that bucket, and no more |
| `WHATSAPP_GCS_PRIVATE_KEY`      | secret | That service account's private key (PEM; `\n`-escaped is fine)              |
| `WHATSAPP_GCS_PREFIX`           | config | Optional. The folder inside the bucket. Default `whatsapp`                  |
| `WHATSAPP_DEVICE_NAME`          | config | Optional. What the phone's Linked devices list calls this. Default `Zimmer` |
| `WHATSAPP_BUFFER_MAX_MESSAGES`  | config | Optional. Default 1000                                                      |
| `WHATSAPP_BUFFER_MAX_AGE_DAYS`  | config | Optional. Default 30                                                        |

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

Pairing is a tool call, so nobody opens a console on the container to scan a QR
code. From the console playground (`/ui`) or an agent session entitled to the
slug:

1. Call `whatsapp_pair` with the account's number in E.164 digits, no `+`:
   `{"phone_number": "15551234567"}`. It returns an 8-character code such as
   `ABCD-EFGH`.
2. On the phone: **WhatsApp › Settings › Linked devices › Link a device**, then
   tap **"Link with phone number instead"** and type the code. Do not wait for a
   prompt to appear on the phone: WhatsApp stopped reliably sending the automatic
   "enter this code" notification to linked-device clients around August 2026
   (whatsmeow#1271, with matching Baileys reports). The manual path works.
3. `whatsapp_status` turns `paired: true, connected: true`. The phone lists the
   device under the name in `WHATSAPP_DEVICE_NAME`.

The code lives as long as the socket waits for it — at least two minutes. If it
lapses, `whatsapp_status` says `pairing_code_expired`; call `whatsapp_pair` again.
Pairing is refused while an account is already paired: `whatsapp_logout` first.

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
  through its own small GCS JSON-API client on Node's built-in `fetch`, with a
  service-account token it signs itself. It does not use `@google-cloud/storage`,
  whose node-fetch 2 transport failed every token request on prod (see
  [Limitations](/limitations/) #109). Every bucket call, and the token fetch it
  may need, is retried on a transport error (a connection closed mid-response,
  reset, refused or timed out), and on 408, 429 or 5xx when the call is safe to
  repeat: up to four tries, backing off from 250 ms, no new try after 15
  seconds, and 30 seconds at most for any one request. A write that is not
  conditional replays only if the token fetch failed, since one that may have
  landed could overwrite a newer process's lease. Each retry writes one
  `[whatsapp] WARN GCS …` line to the container's stderr with the error's full
  cause chain and codes. When the budget runs out, a tool answers with a
  message ending `transient; retry` and does not echo the transport's error. A
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

## Logging

Nothing logs a message's text, a key, or a pairing code. Baileys' own logger is
silenced (at debug it prints decrypted messages), and every line and every tool
error runs through a redactor that removes key-shaped runs and PEM blocks. A
phone number is not redacted: it is what an operator needs to see.

## What is not here

- **Media.** `type` names an attachment and `text` carries its caption; the bytes
  are never downloaded.
- **Reactions as a tool.** Reactions others send arrive as `type: "reaction"`
  messages; the bridge does not send them.
- **A second account in one deployment.** One linked device is one account. A
  second account is a second component with its own prefix.

See [Limitations](/limitations/) for the full list of what this costs.
