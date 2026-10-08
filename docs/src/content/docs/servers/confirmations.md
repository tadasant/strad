---
title: Confirming a tool before it acts
description: How a tool that needs a human's yes, like gmail's send_email, asks the session that called it, and why it refuses when there is no one to ask.
---

Some tools should not act until a human says yes. A sent email cannot be
recalled, so gmail's `send_email` asks first. In strad the question goes to the
session that made the call, and nowhere else. If the call names no session to
ask, the tool refuses and nothing is sent.

## The protocol

The question travels over the pulsemcp fallback-elicitation protocol, the one
the vendored `@pulsemcp/mcp-elicitation` library speaks:

1. `POST <url>` with the question: a message, a form schema, and `_meta`
   carrying a request id and an expiry.
2. `GET <url>/<request-id>` every five seconds until the answer is `accept`,
   `decline`, `cancel` or `expired`.

Only `accept`, with the confirm box still ticked, sends the mail. Every other
answer, an unrecognised one included, sends nothing.

Zimmer serves this protocol at `/api/v1/elicitations/session/<token>`. The
token names one session. It is minted from Zimmer's own secret, so it cannot be
guessed, and Zimmer takes the session from the token rather than from anything
the caller claims. The token can create and poll a prompt but cannot answer
one: the answer comes from a human in Zimmer's UI.

## Why the address travels with the call

Upstream's deployment runs one gmail server process per agent session and
reads the URL from `ELICITATION_REQUEST_URL` in that process's environment. In
that setup the environment is the session.

strad's bundle is one process serving every caller, so a container-wide URL
cannot name the calling session. It would send every confirmation to one place,
whoever asked. So the caller names its URL on each request instead:

```http
POST /mcp?servers=gmail-rw-external
Authorization: Bearer strad_prod_…
X-Elicitation-Url: https://zimmer.tadasant.com/api/v1/elicitations/session/22867-…
```

```mermaid
sequenceDiagram
  participant C as Zimmer session
  participant Core as strad core /mcp
  participant B as bundle /gmail
  participant Z as Zimmer elicitations
  participant H as Human
  C->>Core: tools/call send_email + X-Elicitation-Url
  Core->>Core: under gateway.elicitation.allowedUrlPrefixes? slug has confirmations: true?
  Core->>B: tools/call, _meta["dev.strad/elicitation"] = {url, slug, ttlMs}
  B->>Z: POST url (slug, mailbox, To, Subject)
  Z->>H: push notification, banner
  loop every 5s until answered or the deadline
    B->>Z: GET url/request-id
  end
  H->>Z: approve
  B->>B: send
  B-->>Core: result
  Core-->>C: result
```

## What core does with the header

`src/gateway/elicitation.ts` handles all three steps.

- **Reads it** off every `/mcp` request. The header is a credential, since the
  token in its path lets a POST raise a prompt on that session. strad never
  logs it. A value that is not exactly one URL is refused; that includes a
  repeated header, which Node joins with a comma.
- **Holds it to an allowlist of URL prefixes**,
  `gateway.elicitation.allowedUrlPrefixes`. The bundle will fetch this URL. An
  unchecked header would be a request the caller could aim anywhere on strad's
  private network. An origin alone would still let the caller pick any path on
  a trusted host. So the URL, after the parser has resolved any `..` or
  `%2e%2e` segments, must sit strictly under a listed prefix. It must also be
  `https`; plain `http` is accepted only for a loopback host. The list is
  empty by default, and then every confirmed tool refuses. A URL that fails is
  not dropped silently: it reaches the bundle as a refusal carrying the reason,
  and the tool's error repeats it.
- **Forwards it** on the upstream `tools/call` as
  `_meta["dev.strad/elicitation"]`, and only to a `supplementary-image` slug
  that declares `confirmations: true`. The other mounts in the same bundle
  never receive it, and neither does a `remote-http` or `local-tunnel` server.
  Most of those mounts are third-party code, and the URL is a credential. Core
  never forwards a client's own `_meta`, so an upstream can treat that key as
  core's word.

The forwarded entry also carries a deadline, `ttlMs`: the slug's `timeoutMs`
less a margin of a quarter of it, at most 15 seconds.

## What the bundle does with it

`images/bundle-google/src/confirm.ts` is strad's own layer over the verbatim
gmail tree. The tree and the library both stay byte-identical. The layer uses a
seam the library already has: its native tier asks the server object whether
the client supports elicitation, then calls `server.elicitInput()`. The gmail
tools are registered on a proxy of the real server.

- The `tools/call` handler runs inside a scope holding that call's channel and
  deadline. Two sessions sending at once never see each other's address.
- `getClientCapabilities()` reports elicitation support exactly when the
  current call carries a channel.
- `elicitInput()` speaks the protocol itself, against the channel's URL.
  Nothing reads the address from `process.env`.

The protocol is spoken there rather than through the library's own HTTP
client because that client is built for an address its operator chose, and
this one comes from a caller:

- **A redirect is an error.** It is never followed, so an open redirect on an
  allowed host cannot carry the POST somewhere else.
- **A failure names a status, never a body.** Nothing the endpoint returns on
  an error reaches the caller, so the confirmation path cannot be used to read
  what the bundle's network position can see.
- **Every request is aborted at the deadline, and an answer read after it
  counts as `expired`.** The bundle stops accepting answers a margin before core
  stops waiting for the call. Without that, an approval could land after the
  caller was told the call failed, and the mail would go out anyway, possibly
  twice if the caller retried. What the bundle cannot see is a caller whose own
  timeout is shorter than the slug's `timeoutMs`.

The prompt names the strad slug and the mailbox, then the vendored message's
To, Cc, Bcc and Subject. A send of a saved draft (`from_draft_id`) would
otherwise show only the draft's id, which a human cannot judge, so the layer
reads the draft and adds its recipients and subject. If the draft cannot be
read, the prompt says so and advises declining.

## When it refuses

`send_email` is refused before it runs, with an error saying why, when:

| Situation                                                                       | Why                                                                                            |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| The `/mcp` request had no `X-Elicitation-Url`                                   | There is no one to ask.                                                                        |
| The header is not under `gateway.elicitation.allowedUrlPrefixes`                | strad will not fetch it.                                                                       |
| The slug does not declare `confirmations: true`                                 | Core forwards no channel to it.                                                                |
| The call came from the console playground, or through a flow-through grant      | Neither has a session to ask. The console is a human, but it has no prompt surface.           |
| The bundle container sets `ELICITATION_ENABLED=false`                           | The vendored tool would skip the prompt entirely.                                              |
| The bundle container sets `ELICITATION_REQUEST_URL` or `ELICITATION_POLL_URL`   | The vendored tool would prefer that container-wide URL, which cannot name the calling session. |

An `admin` token is not an exception. It holds every role and still has no
human attached, so it gets the same refusal unless it names a channel.

`DANGEROUSLY_SKIP_ELICITATIONS` is not in the table because the gmail tree
never reads it. That flag belongs to 1Password, and setting it for the
`onepassword-*` slugs does not reach this mount.

Only `send_email` is confirmed. `CONFIRMED_TOOLS` in `confirm.ts` names it, and
`images/bundle-google/test/confirm.test.ts` fails if the vendored tree gains
another tool that calls `requestConfirmation` without the list changing with it.

## Configuring it

```yaml
gateway:
  elicitation:
    allowedUrlPrefixes:
      - https://zimmer.tadasant.com/api/v1/elicitations/session/

servers:
  - slug: gmail-rw-external
    kind: supplementary-image
    # …
    confirmations: true
    # How long a human has to answer, plus the margin. The default 120s gives
    # a human 105s.
    timeoutMs: 900000
```

A prefix is an `https` URL in normal form whose path ends in `/`, so it cannot
match a sibling path that merely starts the same way. `https://host/` allows
the whole host, which is rarely what you want.

On the client side, the caller sends its session's URL in `X-Elicitation-Url`
on every `/mcp` request to a slug with a confirmed tool. A Zimmer session has
that URL as `ELICITATION_REQUEST_URL` in its environment. Zimmer resolves
`${VAR}` in an MCP entry's headers from its own secrets rather than from the
session, so the header has to be written by Zimmer when it renders a session's
MCP config, not referenced from the catalog.

## Why not native elicitation

MCP has its own way for a server to ask the client a question,
`elicitation/create`. strad does not relay it, for two reasons.

- strad's `/mcp` is stateless. A server-to-client request sent mid-call needs
  the client's answer routed back to the same in-flight call, and with no
  session there is nothing to route it by.
- In a headless Zimmer session the client is Claude Code with no human
  attached. It advertises elicitation and answers on its own, and Zimmer sets
  `ELICITATION_PREFER_HTTP_FALLBACK` on its own servers for exactly that
  reason.

The HTTP fallback reaches a person. That is the property this feature exists
for.
