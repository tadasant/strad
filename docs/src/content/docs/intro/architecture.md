---
title: Architecture
description: How strad is put together — the public core gateway, internal-only bundles over the private network, DigitalOcean App Platform, ghcr images, and GCP Secret Manager.
sidebar:
  order: 2
---

strad is a small gateway process with an unusual deployment shape: the same
binary runs in two modes, and the server list in your config decides how many
containers exist and how they are wired to each other.

## The whole system

```mermaid
flowchart TB
    subgraph internet["Public internet"]
        CL["MCP clients<br/>agents · human tools"]
        HU["Humans<br/>(browser)"]
    end

    subgraph app["DigitalOcean App Platform"]
        subgraph core["core (public component)"]
            GW["strad gateway<br/>STRAD_MODE=core"]
            RH["remote-http adapters"]
            BI["core builtins<br/>(in-process)"]
        end
        subgraph priv["Private network (VPC)"]
            BA["bundle-api<br/>STRAD_MODE=bundle<br/>builtins"]
            BB["bundle-browser<br/>supplementary image<br/>(own container)"]
        end
    end

    EXT["Remote MCP servers<br/>on the internet"]
    SM["GCP Secret Manager<br/>strad-&lt;env&gt;-*"]
    GH["ghcr.io/tadasant/strad"]

    CL -->|"/mcp?servers=… + token"| GW
    HU -->|"/console (Google OAuth)"| GW
    GW --> RH --> EXT
    GW --> BI
    GW -->|"http://bundle-api:8080<br/>Bearer STRAD_INTERNAL_TOKEN"| BA
    GW -->|"http://bundle-browser:8080"| BB
    SM -.->|"injected as SECRET env at deploy"| app
    GH -.->|"image pulled on every restart/scale"| app
```

## Core and bundles

There is exactly one public component — the **core gateway**. Everything else is
a **bundle**: an internal-only App Platform component that lives on the private
network and is never reachable from the internet. The core reaches a bundle at
`${bundle.PRIVATE_URL}`, which resolves to `http://bundle-name:8080` — a private,
in-VPC hop (~4ms) with no public-edge hairpin.

The same image runs in two modes, selected by the `STRAD_MODE` env var:

- **`core`** mounts `remote-http` servers and core `builtin`s directly, and
  proxies to every non-core bundle over private HTTP.
- **`bundle`** mounts only the `builtin`s assigned to its `STRAD_BUNDLE`, and
  serves them back to core over private HTTP.

When core proxies to a bundle, it calls the bundle at
`${base}/mcp?servers=<slug>` with `Authorization: Bearer ${STRAD_INTERNAL_TOKEN}`.
Because a bundle is itself a strad that already namespaces its tools, the adapter
strips and restores the inner `<slug>__` prefix so you never see
`bundled__bundled__whoami`.

<aside class="starlight-aside starlight-aside--note">

**Internal network is not an authorization story.** Bundle components have no
public route, but they still require the shared `STRAD_INTERNAL_TOKEN` (verified
with a constant-time compare) — because anything else in the VPC could otherwise
reach them.

</aside>

## Adapters

All three server kinds are unified behind a single `ServerAdapter` interface
(`listTools`, `callTool`, `close`):

- **`HttpServerAdapter`** backs `remote-http`, `supplementary-image`, **and**
  core→bundle builtin proxying — all of which are Streamable HTTP under the hood.
- **`BuiltinServerAdapter`** runs a builtin module in-process.

Adapters are built **once at boot** — they hold long-lived upstream connections.
Only the _toolset_ is resolved per request, from the caller's entitlements
intersected with `?servers=`. Per-hop upstream timeouts are set explicitly to
`120_000` ms, because the MCP SDK defaults to 60s at every hop and would silently
kill long tool calls.

A slow or failing upstream contributes **zero tools** to `tools/list` (and logs
it) rather than failing the whole request with a 500. Selection is re-checked at
`tools/call` time too: `tools/list` filters by the current `?servers=`, but a
client could call any tool name it saw on a prior request, so authorization is
re-enforced on the action itself.

## Sizing bundles

The server list drives how containers are grouped:

- **Lightweight builtins** colocate in one bundle at roughly $0 marginal cost.
- **A `supplementary-image` server always owns its bundle** — one component runs
  one image.
- **Browser / Chromium bundles want their own** component: 1 vCPU serialises
  rendering, and peak RSS runs ~545MB, so budget 1GB.

## Platform, images, and secrets

- **Deploy target:** DigitalOcean App Platform. `src/deploy/appspec.ts` turns
  your config into an App Platform spec — the server list decides the container
  topology. See [Deploy model](/operate/deploy-model/).
- **Images:** published to **ghcr** (`ghcr.io/tadasant/strad`).
- **Secrets:** stored in **GCP Secret Manager** as `strad-<env>-<NAME>`, and
  injected as App Platform SECRET env vars _at deploy time_. The runtime
  container holds **no cloud credentials** — it simply reads `process.env`, and
  the secret source is pluggable behind `loadSecrets()` in `src/secrets/`.
