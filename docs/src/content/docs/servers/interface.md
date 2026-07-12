---
title: The server-config interface
description: strad's three server kinds — remote-http, supplementary-image, and builtin — with the one-line-to-add-a-server examples and the fields each kind takes.
sidebar:
  order: 1
---

The core ships with **zero** MCP servers. Attaching one is a single entry under
`servers:` in your config. That entry is a **discriminated union on `kind`**, and
there are exactly three kinds. This is the whole extension surface of strad.

## What every server shares

Every server, regardless of kind, has these base fields (from
`src/config/schema.ts`):

| Field                  | Default      | Meaning                                                                               |
| ---------------------- | ------------ | ------------------------------------------------------------------------------------- |
| `slug`                 | _(required)_ | Identifier, `^[a-z0-9][a-z0-9-]{0,62}$`. Goes in `?servers=` and prefixes every tool. |
| `kind`                 | _(required)_ | `remote-http` \| `supplementary-image` \| `builtin`.                                  |
| `entitlements`         | `[]`         | Roles allowed to reach this server. **Empty = nobody** (fail closed).                 |
| `enabled`              | `true`       | Set `false` to configure without exposing.                                            |
| `timeoutMs`            | `120000`     | Per-hop upstream timeout.                                                             |
| `title`, `description` | —            | Human-facing metadata.                                                                |

<aside class="starlight-aside starlight-aside--tip">

`entitlements` on the server is only **half** of access. A role must _also_ name
the server under `roles.<role>.servers`. Both directions must agree — see
[Auth](/auth/overview/).

</aside>

## The three kinds

```mermaid
flowchart LR
    subgraph strad["strad"]
        G["core gateway"]
    end
    G -->|"remote-http:<br/>proxy over the internet,<br/>strad holds the credential"| RH["Existing MCP server<br/>on the internet"]
    G -->|"supplementary-image:<br/>deploy as internal-only<br/>component, proxy privately"| SI["Your container image<br/>(own bundle)"]
    G -->|"builtin:<br/>module compiled into<br/>the strad image"| BI["In-process module<br/>(or a bundle component)"]
```

### 1. `remote-http`

Proxy an MCP server that **already exists on the internet**. strad holds the
credential; the client never sees it. No container is deployed.

Fields: `url` (required), `headers` (a map of header name → value, where values
may reference secrets as `${NAME}`).

```yaml
servers:
  # remote-http — proxy an MCP server that already exists on the internet.
  - slug: granola
    kind: remote-http
    url: https://mcp.granola.ai/mcp
    entitlements: [admin]
    headers:
      Authorization: "Bearer ${GRANOLA_TOKEN}" # ${...} = a secret, injected at deploy
```

### 2. `supplementary-image`

A server **published as its own container image**. strad deploys it as an
internal-only component and proxies to it over the private network. One entry,
one server, one container.

Fields: `image` (required), `bundle` (required — a supplementary image always
owns its bundle), `path` (defaults to `/mcp`, must start with `/`), `env` and
`headers` (maps whose values may be `${NAME}` secrets).

```yaml
servers:
  # supplementary-image — a server published as its own container image.
  #    strad deploys it as an internal-only component and proxies to it.
  - slug: good-eggs
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-server-good-eggs:latest
    bundle: bundle-browser
    entitlements: [admin]
```

At deploy time this component gets `internal_ports: [8080]` and **no**
`http_port` — which is what keeps it off the public edge (see [Deploy
model](/operate/deploy-model/) for why setting both is a hard API rejection).

### 3. `builtin`

A module **compiled into a strad image**. This is how private / internal servers
ship: `tadasant-internal` builds its own image with its modules and registers them
with entries exactly like this. The same config interface as the public kinds —
nothing special.

Fields: `module` (a specifier resolved at boot; must default-export a
`BuiltinModule` = `{ tools, call(name, args, ctx) }`), `bundle` (defaults to
`core` = in the gateway process; any other value runs the strad image in bundle
mode as a separate component), `options` (an arbitrary map passed to the module;
may contain `${SECRET}` refs).

```yaml
servers:
  # builtin — a module compiled into a strad image (for private/internal
  #    servers). The same interface as the public kinds; nothing special.
  - slug: echo
    kind: builtin
    module: "./servers/echo.js"
    bundle: core
    entitlements: [admin]
```

## Validation refuses to boot on

strad validates the whole config strictly at boot (a Zod `superRefine`). It
**refuses to start** if any of these hold:

- Two servers share a `slug`.
- A server grants a role that isn't defined under `roles:`.
- More than one `supplementary-image` lands in the same bundle.
- A `supplementary-image` shares a bundle with any other server.
- A `supplementary-image` is placed in `core`.
- A server references a `bundle` that isn't declared under `bundles:`.

Failing loudly at boot is the point: a misconfigured gateway never comes up
half-wired.

## Where the config comes from

Config is loaded from two sources, in priority order (`src/config/load.ts`):

1. **`STRAD_CONFIG_YAML`** — an inline YAML document. This is how the stock OSS
   image is configured with **zero rebuild**: hand it a config via env and it
   runs.
2. **`STRAD_CONFIG`** — a path to a file. This is how an image that **bakes its
   config in** works (e.g. `tadasant-internal`).

The full, annotated example lives at
[`strad.config.example.yaml`](https://github.com/tadasant/strad/blob/main/strad.config.example.yaml)
in the repo. To actually wire a server end-to-end, see [Adding a
server](/servers/adding/).
