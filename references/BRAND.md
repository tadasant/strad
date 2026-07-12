# strad brand and philosophy

The single source of truth for what strad is, who it's for, and the opinions that
follow. Read this before writing anything user-facing — docs, README, console
copy. When a wording or framing choice is ambiguous, this decides it, not
instinct.

## What strad is

strad is a self-hosted MCP gateway. One endpoint sits in front of many MCP
servers. A client points at that endpoint, presents a token, names the servers it
wants with `?servers=`, and gets back a single merged toolset — proxied,
namespaced, and access-controlled server-side.

The thing it replaces is the sprawl: every agent, every client, every laptop
separately configured with the same dozen MCP servers and the same dozen
credentials. strad holds the credentials and the config once, and every client
gets one URL.

## The five things it stands for

### 1. Selection is not authorization

This is the load-bearing idea, and it has a sentence:

> The query string proposes. The token disposes.

`?servers=` can only ever _narrow_ what a token is entitled to. It can never
widen it. Entitlement is computed server-side from the token's roles intersected
with each server's `entitlements`, and both directions must agree. The grounding
is RFC 8707: a token is bound to a resource, and a query string is not one, so it
cannot function as a credential scope.

Everything else about strad's security posture is downstream of taking that
seriously.

### 2. It fails closed, and it says why

Ask for a server you can't have and you get `424 Failed Dependency` naming each
unavailable server, its `status` (`not_configured` / `not_entitled` / `disabled`),
and an `authorize_url`. Not a silent drop, and not a `401` that would march the
client into a pointless OAuth loop against the gateway.

A server with no `entitlements` is reachable by nobody. That is the default.

### 3. Auth is the only gate

strad runs on the open internet. There is no VPN, no tailnet, no IP allowlist in
front of it. That is a deliberate choice — a gateway that agents can only reach
from inside a network perimeter is a gateway most agents can't reach — and it
means the token check is the whole wall. So it is strict, and it is uniform:
`/mcp` requires a static system token, always. `/console` requires Google
Workspace OAuth, verified on the `hd` claim. The two doors never cross, and that
is enforced in code rather than config.

Where zimmer can lean on a perimeter, strad cannot. Say that plainly wherever
it's relevant.

### 4. A platform, not a bundle of integrations

The core ships with **zero** servers baked in. Attaching one is a single entry
under `servers:` — one of three kinds (`remote-http`, `supplementary-image`,
`builtin`), unified behind one adapter interface. That config file is the whole
extension surface, and it is also the deployment: the server list is what decides
how many containers exist and how they are wired.

Nothing about strad is special-cased for the servers its author happens to run.
If a feature only makes sense for one upstream, it belongs in that upstream.

### 5. Honest about which guarantees are real

strad enforces capability — read-only versus read-write — as a **policy** at the
gateway: a `tools: { allow: [...] }` list, checked on `tools/list` and on
`tools/call`, rejecting a withheld tool with `-32600` before the request reaches
the upstream. That is a real boundary, and it is also weaker than a process that
physically lacks the tool. strad writes down which one it has rather than letting
the reader assume the stronger one.

The same instinct produces `HACKS.md` and the limitations page: every shim, every
hardcoded assumption, every known-broken edge, named and dated with what it would
take to undo it. That page is a feature, not a confession. Under-reporting is the
failure mode.

## What this means when you write

- **Lead with the one endpoint.** That's the product. Not "gateway," not
  "platform" in the abstract — one URL, many servers, selected per request.
- **Name the boundary you actually have.** Policy is not physics. A gateway that
  declines is not a process that can't. Where the guarantee is weaker than it
  looks, say so in the same breath.
- **Be specific about numbers and names.** strad's docs are re-derived from its
  own source. Every claim should be traceable to a file, a metric name, an error
  code, or a count.
- **Don't sell the servers.** The upstream MCP servers strad happens to proxy are
  an implementation detail of one deployment. The product is the gateway.
- **Don't reach for enterprise vocabulary** — no "teams," "workspaces," "seats,"
  "compliance," "SSO for your org." strad has roles and tokens, and that is the
  whole model.
- **Confidence and candor are the same voice here.** Naming a sharp edge is not
  hedging. It is the thing that makes the rest of the page trustworthy.
