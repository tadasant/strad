---
title: What strad is
description: strad is a self-hosted MCP platform — one endpoint in front of many MCP servers, selected per request, proxied and namespaced and access-controlled server-side.
sidebar:
  order: 1
---

strad is a self-hosted MCP platform. It puts **one endpoint in front of many MCP
servers**. A client points at that endpoint, names the servers it wants, presents
a token, and gets back a single merged toolset drawn from exactly those servers —
proxied, namespaced, and access-controlled server-side.

The core ships with **zero** MCP servers baked in. strad is a platform, not a
bundle of integrations. Servers are attached through one config interface, and
that config is the entire product surface.

## The shape of the thing

```mermaid
flowchart LR
    C["MCP client<br/>(agent / human tool)"] -->|"GET /mcp?servers=granola,deepwiki<br/>Authorization: Bearer strad_…"| G["strad core gateway"]
    G -->|"entitled ∩ requested"| SEL["Selected servers"]
    SEL --> R1["granola<br/>(remote-http)"]
    SEL --> R2["deepwiki<br/>(remote-http)"]
    SEL --> B1["echo<br/>(builtin, in-process)"]
    G -->|"merged, namespaced toolset<br/>granola__… deepwiki__… echo__…"| C
```

Point any MCP client at `https://your-strad.example.com/mcp?servers=granola,deepwiki`,
present a token, and strad returns the union of those servers' tools — every tool
namespaced as `server__tool` (e.g. `granola__list_meetings`) so nothing collides.

## The one rule: the query proposes, the token disposes

There is a single invariant that everything else follows from:

> **The query string proposes. The token disposes.**

The `?servers=` parameter can only ever _narrow_ what a caller is already
entitled to. It is **never an authorization boundary**. A token minted for `/mcp`
is valid at `?servers=anything`; the query string cannot widen access, only
select within it. Entitlement is computed server-side from the caller's roles and
the config — nothing the caller sends can grow it.

The justification is RFC 8707: resource indicators bind a token to a _resource_,
and a query string is not one. So `?servers=` is treated as a **selection hint**,
not a credential scope. See [Auth](/auth/overview/) for how the entitled set is
actually computed.

## It fails closed

Ask for a server you are not entitled to, and strad does **not** silently drop it.
It returns a `424 Failed Dependency` with a machine-readable body naming exactly
what's missing and where to authorize it:

```json
{
  "error": "downstream_not_authenticated",
  "message": "One or more requested servers are unavailable to this token.",
  "servers": [
    {
      "slug": "slack",
      "status": "not_entitled",
      "authorize_url": "https://…/ui/slack"
    }
  ]
}
```

The per-server `status` is one of `not_configured`, `not_entitled`, or
`disabled`. strad deliberately avoids returning a `401` here — a `401` would march
the client into a pointless OAuth loop against the gateway, when the real problem
is downstream authorization. And it avoids silently omitting the server, because
"a client that asked for slack and got a toolset without it looks like a broken
Slack integration." Fail closed, loudly, with a pointer to the fix.

## Capability is a policy the gateway enforces

Entitlement decides which _servers_ a token can reach. A second, narrower decision
is which _tools_ it can use on a server it has already reached — read-only versus
read-write. That is a `tools: { allow: [...] }` list on the server entry, and the
gateway enforces it on `tools/list` **and** on `tools/call`: a withheld tool is
refused with JSON-RPC `-32600` before the request reaches the upstream.

Because the decision lives at the gateway, `gmail-ro` and `gmail-rw` are two config
entries pointing at the same container on the same path. They differ only in the
policy. That is what makes the deployment small, and it is worth naming what it
costs: capability is now policy, not physics. A gateway that declines is not the
same guarantee as a process that lacks the tool. See
[Known limitations](/limitations/).

## Stateless, and spec-conformant because of it

strad is **stateless**. It builds a fresh MCP `Server` and transport for every
request (`StreamableHTTPServerTransport({ sessionIdGenerator: undefined })`) and
tears it down when the response closes. The toolset a client sees is a pure
function of `(token, URL)` — it is never derived from session state.

That is exactly what keeps `?servers=` conformant with the **2026-07-28 MCP spec
revision**, which removes sessions and forbids a server from varying its toolset
per _connection_ — while explicitly allowing variation by per-request _input_.
Because `?servers=` is request input and there are no sessions, selecting servers
per request is squarely within spec.

## Auth is the only gate

strad is built to run on the **open internet** — there is no tailnet, VPN, or IP
allowlist in front of it. That posture is deliberate, and it means auth is the
only thing standing between a caller and the tools:

- **`/mcp`** always requires a static system token. No token, no tools —
  including the CI smoke test that asserts an unauthenticated `/mcp` returns
  `401`.
- **`/console`** (the human surface) uses Google Workspace OAuth.

See [Auth](/auth/overview/) for the full model.

## Scope

There is no hosted strad. You deploy it yourself on DigitalOcean App Platform (see
[Deploy model](/operate/deploy-model/)), with your own config, your own servers, and
your own credentials.

The access model is roles and tokens, and that is the whole of it. There are no
accounts, no organizations, and no per-user gating: a role names the servers it can
reach, a token holds roles, and a server names the roles it admits. If you need to
mediate distrust between the people using it, strad is the wrong tool.
