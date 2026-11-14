# MCP Events: the draft this repo is built against

strad's MCP Events support tracks a **draft**: SEP-3415, the events extension
(`io.modelcontextprotocol/events`). It is not part of any released MCP
specification, and its wire, error codes and capability shape can still change.

| Field                | Value                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------ |
| SEP                  | SEP-3415, `seps/0000-events-extension.md`                                                  |
| Pinned head commit   | `b08e4f9dd684f39d846d94089487fbeb28e666f5`                                                 |
| Pinned on            | 2026-10-29                                                                                 |
| Delivery modes built | poll (`events/list`, `events/poll`) and webhook (`events/subscribe`, `events/unsubscribe`) |
| Not built            | push (`events/stream`), `notifications/events/list_changed`, `server/discover`             |
| Re-checked           | 2026-11-11, building webhook mode: the SEP's head is still the pinned commit               |

Before changing anything under MCP Events, compare this commit with the live
SEP. If the draft moved, decide what the change means for the wire here, then
update this file in the same PR.

## What is implemented against this commit

- `capabilities.extensions["io.modelcontextprotocol/events"] = {}` on the
  `initialize` result, when a slug selected for the request serves events.
  `listChanged` is not offered.
- `events/list` `{cursor?}` returns `{events: EventDescriptor[]}` with one page
  and no `nextCursor`. Names are slug-prefixed: `slack-zimmer__message_posted`.
- `events/poll` `{name, arguments, cursor|null, maxEvents?, maxAgeMs?}` returns
  `{events, cursor, truncated, hasMore, nextPollMs}`. A null cursor returns no
  events and a fresh cursor.
- `events/subscribe` `{name, arguments, delivery: {mode: "webhook", url, secret}, cursor, maxAgeMs?, ttlMs?}`
  returns `{id, refreshBefore, cursor, truncated, deliveryStatus?}`;
  `events/unsubscribe` `{name, arguments, delivery: {url}}` returns `{}`. The
  key is `(principal, delivery.url, name, arguments)`; core supplies the
  principal in `_meta["strad/principal"]` and the prefixed name in
  `_meta["strad/name"]`, and drops any `_meta` the client sent.
- Webhook delivery: challenge-echo verification (the SEP's option 1, and the
  only one), Standard Webhooks `v1,` HMAC-SHA256 signatures with
  `X-MCP-Subscription-Id`, control envelopes `verification` and `gap`, retries
  over 14½ minutes, `410` and `413` not retried, suspension on sustained
  failure, delivery-time SSRF checks with no redirects, `https` only.
- Errors use the draft's provisional codes: `-32602` InvalidParams, `-32023`
  NotFound (`data.kind: "event"` or `"subscription"`), `-32024` Forbidden,
  `-32025` ResourceExhausted, `-32026` Unsupported, `-32027`
  CallbackEndpointError (`data.reason`).
- The `Mcp-Method` and `Mcp-Name` headers are accepted and not checked.
- `resultType: "complete"` is not set on results.

## Choices the draft leaves open, as made here

These are agreed with Zimmer's receiver (tadasant/zimmer#1484); change one and
change both.

- **TTL.** Omitted: 1 hour. Clamped to at least 1 minute and at most 24 hours.
  `ttlMs: null` (no expiry) is granted 24 hours: the draft lets a server decline
  no-expiry by answering with a finite `refreshBefore`.
- **Persistence.** Subscriptions, their verification and their delivery
  watermark are persisted (sealed, in the state store) although the grant is
  finite, so a restart does not wait for the next refresh to deliver again.
- **The cursor** is the poll cursor: one cursor space for both modes. A
  subscribe accepts any cursor `events/poll` issued.
- **Retries.** Five attempts at 0, 30 s, 2½, 7½ and 14½ minutes; a 10-second
  timeout per request; `429` retried.
- **Suspension.** Not the draft's rate-over-a-window example. An event that
  exhausts its retries suspends the subscription when the endpoint has not
  answered since that event's first attempt, and is given up when it has. A
  refresh reactivates, and delivery resumes from the watermark.
- **Secret rotation.** The previous secret also signs for 10 minutes.
- **Edge credentials.** Extra headers (a Cloudflare Access service token) on
  requests under configured URL prefixes (host and path) only. Standard Webhooks allows extra headers.

## Not built from the webhook section

- The allowlist, out-of-band and `/.well-known/mcp-webhook-receiver.json`
  verification paths.
- `terminated` envelopes: nothing here revokes a subscription. A subscriber
  that loses access stops being able to refresh, and the grant expires.
- `v1a,` server-identity signatures, and `deliveryStatus.throttled`.

Code: `src/gateway/events.ts` (core), `servers/bundle-api/fork/slack/src/events/`
(the Slack `message_posted` event). Prose: `docs/src/content/docs/servers/events.md`.
