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
  Core->>B: tools/call, _meta["dev.strad/elicitation"] = {url, slug, ttlMs, headers}
  B->>Z: POST url (slug, mailbox, To, Subject) + confirmationHeaders
  Z->>H: push notification, banner
  loop every 5s until answered, the deadline, or the call is dropped
    B->>Z: GET url/request-id + confirmationHeaders
    B-->>Core: progress keepalive (every 30s)
    Core-->>C: progress, if the caller sent a progressToken
  end
  H->>Z: approve
  B->>B: still wanted? then send
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
less a margin of a quarter of it, at most 15 seconds. It carries the slug's
`confirmationHeaders:` too, resolved by core, when the slug declares any (see
[the edge](#the-edge-in-front-of-the-approval-url)).

Core also ties the upstream request to the caller. A confirmed slug's
`tools/call` is torn down the moment the caller's `/mcp` response closes, or the
hop's `timeoutMs` runs out. That means the HTTP request to the bundle itself,
not only the promise core was waiting on. The MCP SDK's own cancel does not do
that: it sends `notifications/cancelled`, which a stateless bundle receives on a
new request at a new server instance that never saw the call, and it leaves the
original request open. So core aborts that request's own fetch, and closing it
is what tells the bundle the call is gone.

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
  stops waiting for the call.
- **A dropped call never sends.** The call's own abort signal fires when its
  response to core closes, whether core's hop timed out, core's caller went
  away, or the caller cancelled. It aborts the approval requests and the wait
  between polls, it turns any answer into `cancel`, and the mailbox itself
  refuses `sendMessage` and `sendDraft` once it has fired. That last check is
  for the reads the tool makes between the approval and the send: a reply looks
  up the original message first. Without it, an approval landing after the
  caller was told the call failed would still send, and send twice if the
  caller retried.
- **A long wait stays open.** While a human decides, nothing else crosses the
  wire, and Node's `fetch` in core drops a response body that has been silent
  for 300 seconds. So the bundle sends a progress notification every 30
  seconds, against the progressToken core puts on every confirmed call. Core
  relays it to its own caller when that caller sent a progressToken of its own.

What is left is a race of milliseconds: an approval read just before the drop
reaches the bundle can still send. Everything slower than that is a cancel.

The prompt names the strad slug and the mailbox, then the vendored message's
To, Cc, Bcc and Subject. A send of a saved draft (`from_draft_id`) would
otherwise show only the draft's id, which a human cannot judge, so the layer
reads the draft and adds its recipients and subject. If the draft cannot be
read, the prompt says so and advises declining.

## The edge in front of the approval URL

The approval service can sit behind an edge that wants strad's own credential
before it lets a request through. Cloudflare Access with a service token is the
case: without `CF-Access-Client-Id` and `CF-Access-Client-Secret`, the POST
gets a 401 from Access and the approval service never sees it.

The slug declares those headers, and core resolves them on every call, the same
way it resolves `headers:`: from the slug's own namespace first, then the shared
one.

```yaml
  - slug: gmail-rw-external
    confirmations: true
    confirmationHeaders:
      CF-Access-Client-Id: "${ZIMMER_CF_ACCESS_CLIENT_ID}"
      CF-Access-Client-Secret: "${ZIMMER_CF_ACCESS_CLIENT_SECRET}"
```

- They go on the POST and on every poll, and only to a URL core has already held
  to `gateway.elicitation.allowedUrlPrefixes`.
- They are strad's credential, never the caller's: nothing in them comes from
  the `/mcp` request.
- The bundle sets `content-type` itself. A `confirmationHeaders:` name that
  would collide with what the bundle owns (`content-type`, `content-length`,
  `transfer-encoding`, `connection`, `host`) is a config error.
- If a ref cannot be resolved, the channel reaches the bundle as a refusal that
  names the variable, so `send_email` refuses and says why. The slug's other
  tools are unaffected. List the names in `mayBeUnseeded:` to deploy before they
  are seeded.
- `confirmationHeaders:` without `confirmations: true` is a config error,
  because nothing would ever send them.

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
| A `confirmationHeaders:` ref is not seeded                                      | Without the edge credential the approval request would be refused at the edge.                 |

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
    # a human 105s. See "How long a window can be" below before raising it.
    timeoutMs: 240000
    # Only when an edge in front of the approval URL wants strad's credential.
    confirmationHeaders:
      CF-Access-Client-Id: "${ZIMMER_CF_ACCESS_CLIENT_ID}"
      CF-Access-Client-Secret: "${ZIMMER_CF_ACCESS_CLIENT_SECRET}"
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

## How long a window can be

Two hops carry the call, and strad controls one of them.

- **Core to the bundle** holds any `timeoutMs`. The keepalives keep its body
  from going silent, so the 300-second limit in Node's `fetch` never fires.
- **The caller to core** is the caller's own client, and whatever proxies sit in
  front of strad's public URL. strad cannot see their limits. If the caller sent
  a progressToken, the relayed keepalives cross this hop too. If it did not,
  core's response stays silent until the human answers, and a client or
  ingress that drops a silent response ends the call there.

A window longer than the caller's hop can hold is not unsafe: the drop reaches
the bundle, and the call becomes a `cancel` that sends nothing. It is just a
window nobody can use. So size `timeoutMs` to the caller's hop. strad has no
config guard for this, because the limit belongs to the caller and not to the
config.

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
