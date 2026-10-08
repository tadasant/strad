# WhatsApp MCP server

strad's WhatsApp server is also the long-lived WhatsApp client behind it: ONE
**linked device** of one real account, driven by
[Baileys](https://github.com/WhiskeySockets/Baileys), that sits in chats the
account is in — including a group someone created on their phone — buffers what
it sees, and posts as the account.

The full page, with setup and operations, is `docs/servers/whatsapp` on the
docs site. This file is what someone working in the tree needs.

## Unofficial, and said so

WhatsApp's Cloud API cannot join a group a consumer created, so the only way in
is the multi-device protocol WhatsApp Web speaks. Automating an account that way
is against WhatsApp's Terms of Service and the account can be banned. Every tool
description says this. Sending is human-paced (typing indicator, 3 s spacing,
refused past 6/minute or 60/hour) to keep the risk down, not to remove it.

## Tools

| Tool                    | Group     |                                                        |
| ----------------------- | --------- | ------------------------------------------------------ |
| `whatsapp_status`       | readonly  | `connected && paired` is the only healthy state         |
| `whatsapp_list_chats`   | readonly  | where a chat id (JID) comes from                        |
| `whatsapp_get_messages` | readonly  | the buffer, oldest first; `after` is an inclusive cursor |
| `whatsapp_send_message` | readwrite | posts AS the account; recorded `sent_by_bridge: true`   |
| `whatsapp_pair`         | admin     | pairing code for the phone — no QR, no shell            |
| `whatsapp_logout`       | admin     | unlink and delete everything persisted                  |

The names and shapes are a contract with Zimmer's `whatsapp` trigger, which
polls `whatsapp_get_messages` every minute. Do not rename a tool or a field
without changing Zimmer in step. `servers/bundle/scripts/smoke.mjs` pins the six
names against the built image.

## Environment

Required: `WHATSAPP_STATE_ENCRYPTION_KEY` (32 bytes, base64 or hex),
`WHATSAPP_GCS_BUCKET`, `WHATSAPP_GCS_CLIENT_EMAIL`, `WHATSAPP_GCS_PRIVATE_KEY`.
Optional: `WHATSAPP_GCS_PREFIX` (default `whatsapp`),
`WHATSAPP_DEVICE_NAME` (default `Zimmer`), `WHATSAPP_BUFFER_MAX_MESSAGES` (1000),
`WHATSAPP_BUFFER_MAX_AGE_DAYS` (30).

Missing any required variable is a supported state: the tools list and every
call fails naming what is missing, and the server never opens a socket. That is
every bundle container except the one this slug is bundled onto.

## Layout

| File              | What it owns                                                                     |
| ----------------- | -------------------------------------------------------------------------------- |
| `src/socket.ts`   | the ONLY Baileys import (lazy), the `WaSocket` seam, the in-memory auth state     |
| `src/bridge.ts`   | lifecycle: start, pair, reconnect/backoff, ingest, flush, the tool operations     |
| `src/normalize.ts`| wire message → buffered record; which messages exist, `type`, `text`, quotes      |
| `src/buffer.ts`   | per-chat buffer, caps, the `after`/`has_more` read, sticky `sent_by_bridge`      |
| `src/store.ts`    | what is persisted where, the lease, conditional auth writes                       |
| `src/crypto.ts`   | AES-256-GCM with the object name as AAD                                           |
| `src/blob-store.ts`| GCS (and the in-memory double the tests use)                                    |
| `src/pacing.ts`   | human-paced sending                                                               |

## One instance

Two processes on one linked device kick each other off and both write its Signal
state. The component must not scale (the renderer refuses `instanceCount > 1`
for a bundle serving `/whatsapp`); the lease in `store.ts` handles the overlap a
deploy creates anyway. Read the header of `src/store.ts` before changing how
state is written.

## Tests

```
cd servers/whatsapp && npm test
```

Vitest over the TypeScript sources, run on every PR by the `servers (whatsapp)`
CI leg. The server tests drive the tools through a real MCP client against a
fake socket (`test/fake-socket.ts`) and an in-memory GCS with real generation
preconditions: pairing and the 515 restart, restore after a restart, the
get_messages cursor, the `_self` flags against a phone JID and a LID, edits and
deletes, history sync, `sent_by_bridge` surviving an echo, pacing refusals, two
processes on one account, 401 and 440, logout, a state sealed under another
key, and no configuration; a send that fails after delivery, overlapping pair
calls, logout racing a flush, a message held through a chat-load failure, and
403. The auth-state round trip runs against real Baileys, the console guard
against real libsignal, and `GcsBlobStore` — strad's own GCS JSON-API client on Node's
`fetch` — against a local stand-in for the JSON API and the token endpoint
(`test/gcs.test.ts`). That is what checks that a read reports the generation a
later conditional write needs, that the signed JWT verifies, and that a body
cut off mid-read is retried.
Nothing in CI talks to WhatsApp. Every identifier in the fixtures is invented.
