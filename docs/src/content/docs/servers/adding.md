---
title: Adding a server
description: The end-to-end steps to attach a new MCP server to strad — pick a kind, wire entitlements both ways, declare any bundle, seed secrets, and deploy.
sidebar:
  order: 2
---

Adding a server is a single entry under `servers:` plus the wiring that entry
implies. Here is the whole path, from config to a live tool.

## 1. Add the entry

Choose the [kind](/servers/interface/) and add one entry to the config for the
deployment you're changing — `infra/strad.staging.yaml` for staging, or
`tadasant-internal`'s config for prod.

- **`remote-http`** — set `url` and any `headers` (use `${SECRET}` for
  credentials).
- **`supplementary-image`** — set `image`, give it its **own** `bundle`, plus
  optional `env` / `path`.
- **`builtin`** — set `module` and `bundle` (`core` = in-process, anything else =
  a bundle component), plus optional `options`.

## 2. Wire entitlements — both directions

Access requires **two** agreements. Grant the role on the server *and* name the
server on the role:

```yaml
roles:
  admin:
    servers: ["*"]        # admin can reach every server…
  readonly:
    servers: [echo]       # …readonly can reach only echo

servers:
  - slug: echo
    kind: builtin
    module: "./servers/echo.js"
    bundle: core
    entitlements: [admin, readonly]   # …and echo lets both in
```

If either half is missing, the server is unreachable and a request for it returns
[`424`](/intro/concepts/#the-424-contract). This is deliberate — strad fails
closed.

## 3. Declare any bundle it needs

If the server runs outside `core` (a `supplementary-image`, or a `builtin` with a
non-`core` bundle), declare that bundle:

```yaml
bundles:
  - name: bundle-browser
    instanceSizeSlug: apps-s-1vcpu-1gb   # Chromium peaks ~545MB; give it its own
```

Referencing an undeclared bundle is a boot-time validation error.

## 4. Seed any secrets

Any `${NAME}` reference in the config (in `headers`, `env`, or builtin `options`)
must resolve to an env var at boot. Those values live in **GCP Secret Manager** as
`strad-<env>-<NAME>` and are injected as App Platform SECRET env vars at deploy
time — the container itself holds no cloud credentials.

`render-spec` walks the *parsed* config for `${NAME}` refs and injects each as a
required SECRET; an unresolved `${…}` makes render fail loudly rather than letting
the gateway crash-loop. Seed staging secrets with the `secrets-sync` workflow (see
[Operations & CI](/operate/operations/#seeding-secrets)).

## 5. Deploy

- **Stock image (`remote-http` / `supplementary-image`):** no rebuild. The config
  is supplied via `STRAD_CONFIG_YAML`; a release runs `render-spec` → App
  Platform, and any new container(s) implied by the server list are materialized
  automatically.
- **`builtin`:** requires building an image that compiles the module in — the
  module is resolved at boot from the image's filesystem. That is exactly the
  `tadasant-internal` path (bake modules in, deploy the private image).

## The full worked example

`infra/strad.staging.yaml` in the repo deliberately exercises all three kinds at
once — a core builtin (`echo`), a bundled builtin proving the private-network hop
(`bundled` in `bundle-api`), and a credential-free `remote-http` canary
(`deepwiki` → `https://mcp.deepwiki.com/mcp`) — plus a deliberately narrow
`echo-only` role to keep the [424 fail-closed path](/intro/concepts/#the-424-contract)
meaningful. Read it alongside
[`strad.config.example.yaml`](https://github.com/tadasant/strad/blob/main/strad.config.example.yaml)
as your two references.
