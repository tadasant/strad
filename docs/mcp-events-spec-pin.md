# MCP Events: the draft this repo is built against

strad's MCP Events support tracks a **draft**: SEP-3415, the events extension
(`io.modelcontextprotocol/events`). It is not part of any released MCP
specification, and its wire, error codes and capability shape can still change.

| Field                | Value                                                                                                                      |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| SEP                  | SEP-3415, `seps/0000-events-extension.md`                                                                                  |
| Pinned head commit   | `b08e4f9dd684f39d846d94089487fbeb28e666f5`                                                                                 |
| Pinned on            | 2026-10-29                                                                                                                 |
| Delivery modes built | poll only (`events/list`, `events/poll`)                                                                                   |
| Not built            | push (`events/stream`), webhook (`events/subscribe`/`unsubscribe`), `notifications/events/list_changed`, `server/discover` |

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
- Errors use the draft's provisional codes: `-32602` InvalidParams, `-32023`
  NotFound (`data.kind: "event"`), `-32024` Forbidden.
- The `Mcp-Method` and `Mcp-Name` headers are accepted and not checked.
- `resultType: "complete"` is not set on results.

Code: `src/gateway/events.ts` (core), `servers/bundle-api/fork/slack/src/events/`
(the Slack `message_posted` event). Prose: `docs/src/content/docs/servers/events.md`.
