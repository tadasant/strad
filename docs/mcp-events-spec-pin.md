# MCP Events: the draft this repo is built against

strad's MCP Events support tracks SEP-3415, the events extension
(`io.modelcontextprotocol/events`). The SEP merged on 2026-11-19 with status
Final, but it is an Extensions Track SEP, not part of any released MCP
specification, and its official extension repository has not published it
yet. Treat the wire as able to change until it has.

| Field                | Value                                                                                                    |
| -------------------- | -------------------------------------------------------------------------------------------------------- |
| SEP                  | SEP-3415, `seps/3415-events-extension.md` (docs copy `docs/seps/3415-events-extension.mdx`)              |
| Source               | `modelcontextprotocol/modelcontextprotocol` `main`, merged in `8a18b4b3292b9f9b3aee73f6325f9f62f19a89f9` |
| Pinned head commit   | `6a4bf07c96abad167976c1156c6daa63ced40535` (the PR's final head)                                         |
| Pinned on            | 2026-11-19                                                                                               |
| Delivery modes built | poll (`events/list`, `events/poll`) and webhook (`events/subscribe`, `events/unsubscribe`)               |
| Not built            | push (`events/stream`), `notifications/events/list_changed`, `server/discover`                           |
| Re-checked           | 2026-11-19: merged, status Final                                                                         |

Before changing anything under MCP Events, compare this commit with the SEP
on `main` (and, once it exists, the extension repository's copy). If the draft moved, decide what the change means for the wire here, then
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
- No `inputSchema` property carries `x-mcp-header`, so no `Mcp-Param-*`
  header is asked for and none is validated.
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

## Changelog

- 2026-10-29 — pinned at `b08e4f9dd684f39d846d94089487fbeb28e666f5`, the first build.
- 2026-11-11 — re-checked while building webhook mode; head unchanged.
- 2026-11-16 — `b08e4f9` → `4165cc2e580afa795842002f631edbbe17c63757`. No
  wire-breaking change for poll or webhook, so no code change. The file moved to
  `seps/3415-events-extension.md`, and a docs copy was added. Status went from
  Draft to Accepted, which is editorial. Push now negotiates the heartbeat
  interval (`heartbeatMs` on `events/stream`, granted on
  `notifications/events/active`, dead after 3× the grant) and asks clients to
  jitter reconnects. That is additive and out of scope, because push is not
  built. The Server Card members `signingKeys` and `egressIpRanges` moved from
  `remotes[].extensions[…]` to `remotes[].extensionsInfo[…]`, with a same-origin
  rule for keys. That is webhook-side but out of scope, because strad builds no
  `v1a,` signatures and publishes no card. Open Question 6 and a rationale
  paragraph were added (non-normative).

- 2026-11-19 — `4165cc2` → `6a4bf07`, and the SEP MERGED (`8a18b4b` on
  `main`), status Final. Additive only, so no code change: an event type's
  `inputSchema` property MAY carry `x-mcp-header`, which mirrors the argument
  into an `Mcp-Param-{Name}` header on `events/poll`, `events/stream`,
  `events/subscribe` and `events/unsubscribe`, with a `-32020` HeaderMismatch
  when they disagree. strad annotates nothing, so nothing is mirrored and
  nothing is checked; the SEP itself advises against annotating an argument
  that may be sensitive, such as a sender filter, which Gmail's `query` is.
  The rest is editorial: the author's handle, and a TypeScript SDK reference
  implementation listed. Built the Gmail `message_received` event against it.

Code: `src/gateway/events.ts` (core), `servers/bundle-api/fork/slack/src/events/`
(the Slack `message_posted` event, and the webhook engine both sources share),
`images/bundle-google/src/events/` (the Gmail `message_received` event). Prose: `docs/src/content/docs/servers/events.md`.
