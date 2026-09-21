---
title: Flow-through
description: How one hosted server calls another strad slug's tools through core, with no credential of its own. The two-sided grant, the pinned arguments, and what it can and cannot widen.
---

A hosted server can call another slug's tools **through core**, the same way an
agent does, without holding that slug's credential or any new one. That is
flow-through: a housing server reads and writes one Google Sheet by calling the
`google-sheets-…-rw` slug, and the Google refresh token never leaves the
container it already lives in.

## The grant

A grant has two halves, and both are checked-in config:

```yaml
servers:
  - slug: housing-search-2026
    kind: supplementary-image
    image: ghcr.io/you/strad-bundle-internal:latest
    bundle: bundle-internal
    path: /housing-search-2026
    entitlements: [admin]
    reaches:
      - slug: google-sheets-you-rw
        tools: [get_sheet_values, update_sheet_values]
        pin:
          spreadsheet_id: "1HHgyj_fw5un2Asr7UK-OXrSTwmjUskMkT_4-bUo5-Ag"

  - slug: google-sheets-you-rw
    # …its usual fields…
    reachableFrom: [housing-search-2026]
```

| Field | On | Means |
| --- | --- | --- |
| `reaches[].slug` | the source (a `supplementary-image`) | the slug it may call |
| `reaches[].tools` | the source | an **exhaustive** list of that slug's tools it may list and call |
| `reaches[].pin` | the source | arguments fixed to exact values on every call |
| `reachableFrom` | the target (any kind) | the sources the target consents to be called by |

`npm run config:check` refuses, and CI runs it over every config:

- a grant whose target does not name the source under `reachableFrom:`, and a
  `reachableFrom:` entry no grant matches;
- a tool the target's own `tools:` policy withholds, so a grant on a `-ro` slug
  cannot reach the write tool `-ro` hides;
- an empty tool list, a target that is not configured, and a server reaching
  itself;
- a **chain**: a target that itself `reaches:` something. Flow-through is one
  hop, so a source's whole reach is readable off its own entry;
- a `local-tunnel` target, whose degraded surface carries a tool outside every
  policy.

Boot does not refuse these, on purpose. A runtime removal of either slug has to
stay possible, since it is how you switch a grant off without a deploy, and it
leaves the other half dangling. What core serves never depends on the check
having run: it re-derives every rule that decides reach on each request, and a
grant that fails one is inactive.

A runtime roster write can neither declare nor change either half, on any slug,
including one only the overlay declares. See
[Runtime config](/operate/runtime-config/).

## The call

Every non-core component already holds core's private URL (`STRAD_CORE_URL`) and
its own derived internal token (`STRAD_INTERNAL_TOKEN`). A server on that
component opens an MCP session at:

```text
POST {STRAD_CORE_URL}/_strad/reach/{its own slug}/mcp
Authorization: Bearer {STRAD_INTERNAL_TOKEN}
```

It speaks Streamable HTTP and is stateless, like `/mcp`. The session lists
exactly the granted tools, namespaced `<target>__<tool>`. Core enforces three
things on every `tools/call`, before the target sees the call:

1. **The tool.** The grant's list, intersected with the target's own `tools:`
   policy.
2. **The pins.** Every pinned argument must be present and equal to the
   configured value. `"1"` is not `1`, and nothing is normalised: the Sheets tools
   accept a bare id or a URL, and only the spelling the grant names is the one it
   was reviewed for. On a pinned target, an argument the tool does not declare
   in its `inputSchema` is refused too, so a second spelling of the resource
   cannot walk around the pin. A refusal is `mcp.pin_refused`, carrying the slug
   and the pinned argument's name (or `(undeclared)`), never a value.
3. **The slug.** Only the grant's targets are selected.

No resources are relayed. A grant names tools.

Every other answer is one refusal. A missing or unknown token is `401`. A slug
that isn't on the caller's component, is disabled, or holds no active grant is
`403 reach_not_granted`, with a `mcp.reach_refused` event carrying no fields.

## Which identity the nested call runs as

The **source server's**, never the human's or agent's that called the source.
Someone entitled to `housing-search-2026` reaches the sheet only through that
server's own tools, the surface a reviewer approved. Nothing they send is
forwarded as authority. That is a service account's shape, and it is why the
grant must be narrow: it is standing authority, held by code, used on behalf of
whoever the source serves.

So entitling a role to the source effectively grants that role the source's
tools over the target. Review a grant with that in mind. A grant to a `-rw`
target is only as narrow as its tool list, its pins, and the source's code.

## What it does not bound

- **Columns, ranges, paths.** A pin fixes an argument to one exact value. It
  cannot express "only columns AC and AD" or "only paths under `housing/`". Past
  the pinned id, the source's code is the boundary.
- **Which server on a component asked.** The caller is proven to be a
  COMPONENT, and it may only speak for a slug on that component. Every server on
  one component shares a process environment and so the same token, so a grant
  is effectively held by the component. Put a server you do not trust on its
  own. [Known limitations](/limitations/) carries this.
