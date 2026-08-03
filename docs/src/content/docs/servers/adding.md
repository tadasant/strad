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
- **`supplementary-image`** — set `image` and a `bundle`, plus optional `env` /
  `path` (and `consoleEnv` for a credential only the human console may hold — see
  step 4b). Servers that share an image share the bundle (one component runs one
  image); each gets its own `path`.
- **`builtin`** — set `module` and `bundle` (`core` = in-process, anything else =
  a bundle component), plus optional `options`.

## 2. Wire entitlements — both directions

Access requires **two** agreements. Grant the role on the server _and_ name the
server on the role:

```yaml
roles:
  admin:
    servers: ["*"] # admin can reach every server…
  readonly:
    servers: [echo] # …readonly can reach only echo

servers:
  - slug: echo
    kind: builtin
    module: "./servers/echo.js"
    bundle: core
    entitlements: [admin, readonly] # …and echo lets both in
```

If either half is missing, the server is unreachable and a request for it returns
[`424`](/intro/concepts/#the-424-contract). This is deliberate — strad fails
closed.

## 3. Declare any bundle it needs

If the server runs outside `core` (a `supplementary-image`, or a `builtin` with a
non-`core` bundle), declare that bundle:

```yaml
bundles:
  - name: bundle
    instanceSizeSlug: apps-s-1vcpu-2gb
```

Referencing an undeclared bundle is a boot-time validation error.

In practice you are probably adding to the **existing** bundle rather than making
a new one: strad's own deployment is `core` plus one bundle
(`ghcr.io/tadasant/strad-bundle`) holding every containerised server. A new
bundle is a new billed component — worth it for a genuinely heavy or
independently-scaled server, and not otherwise.

## 3b. Give it a capability, if it has one

If the server should ship as a read-only and a read-write variant, that is **two
entries pointing at the same image, bundle and path** — differing only in the
`tools:` policy the gateway enforces:

```yaml
- slug: acme-ro
  kind: supplementary-image
  image: ghcr.io/tadasant/strad-bundle:latest
  bundle: bundle
  path: /acme
  entitlements: [admin]
  tools:
    allow: [acme_list, acme_get] # exhaustive; `deny:` subtracts and wins

- slug: acme-rw # same container, every tool
  kind: supplementary-image
  image: ghcr.io/tadasant/strad-bundle:latest
  bundle: bundle
  path: /acme
  entitlements: [admin]
```

strad enforces the policy on `tools/list` **and** on `tools/call` — a withheld
tool is refused with JSON-RPC `-32600` before the request reaches the upstream. Do
**not** try to do this with a container-side tool-group env var: the two variants
share a container, so an env var would strip tools from the read-write slug as well.
The bundle host deletes any `*_ENABLED_TOOLGROUPS`-shaped variable at boot for
exactly this reason.

Keep the tiers nested — a read-only allow-list should be a subset of the tier above
it. `test/staging-config.test.ts` asserts that for staging, and it is the property
that makes "read-only" mean something predictable.

## 4. Seed any secrets

Any `${NAME}` reference in the config (in `headers`, `env`, or builtin `options`)
must resolve to an env var at boot. Those values live in **GCP Secret Manager** as
`strad-<env>-<NAME>` and are injected as App Platform SECRET env vars at deploy
time — the container itself holds no cloud credentials.

`render-spec` walks the _parsed_ config for `${NAME}` refs and injects each as a
required SECRET; an unresolved `${…}` makes render fail loudly rather than letting
the gateway crash-loop. Seed staging secrets with the `secrets-sync` workflow (see
[Operations & CI](/operate/operations/#seeding-secrets)).

## 4b. A credential the AGENT must not hold — `consoleEnv:`

`env:` on a `supplementary-image` lands on the **container that answers `/mcp`**.
Anything in it is a credential the agent path holds. That is usually what you want.

Sometimes it is exactly what you do not. `consoleEnv:` is the scope that lands on
the **core gateway only** — the component that serves the SSO-gated `/ui`, and
nothing an agent can reach:

```yaml
- slug: secrets
  kind: supplementary-image
  env: # -> the bundle. This is the agent's (viewer) credential.
    SECRETS_SERVICE_ACCOUNT_KEY_JSON: "${SECRETS_VIEWER_KEY_JSON}"
  consoleEnv: # -> core ONLY. Humans, behind SSO.
    SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON: "${SECRETS_ADMIN_KEY_JSON}"
```

The `secrets` server is why this exists. Its MCP container runs as a Parameter
Manager **viewer** service account — no `secretmanager.versions.access` — so **no
tool, bug or prompt injection can pull a secret value through `/mcp`**: Google
refuses the credential, not just the code. The console needs a stronger account to
add and reveal values, and that one must never reach the MCP container or the split
is theatre. (The name is `secrets`, not `gcp-secrets`: the store is an
implementation detail, and other backends can sit behind the same interface.)

Note that a plain broadcast SECRET env var would **not** do: `render-spec` injects
those into every component, supplementary images included. `consoleEnv:` is the
only scope that reaches core and stops there.

## 4c. Let a server draw its env from the parameters system — `params: true`

The alternative to hand-writing `${REF}` entries in `env:` is to opt the server
into [parameter resolution](/intro/architecture/#the-secrets-and-parameters-system).
Set `params: true`, and everything a human has stored under
`/strad/{env}/mcp/{slug}/static/*` is resolved and injected as this server's
environment:

```yaml
- slug: remote-filesystem-tmp-public
  kind: supplementary-image
  image: ghcr.io/tadasant/strad-bundle:latest
  bundle: bundle
  path: /remote-filesystem-tmp-public
  entitlements: [admin]
  params: true # resolve /strad/{env}/mcp/remote-filesystem-tmp-public/static/* into env
  env:
    REMOTE_FILESYSTEM_TMP_PUBLIC_GCS_BUCKET: "my-screenshots" # a literal is fine; not a secret
    REMOTE_FILESYSTEM_TMP_PUBLIC_SENSITIVE_VIEWER_DOMAIN: "example.com" # also config, not a credential
```

The two credentials this server needs — a non-secret
`REMOTE_FILESYSTEM_TMP_PUBLIC_GCS_CLIENT_EMAIL` and a secret
`REMOTE_FILESYSTEM_TMP_PUBLIC_GCS_PRIVATE_KEY` — are **not** in the config. A human sets
them once in `/ui/secrets` — namespace `/strad/{env}/mcp/`, path prefix
`remote-filesystem-tmp-public/static/` — and the resolver injects them: for a
supplementary image at deploy time (`render-spec`, with the `STRAD_PARAMS_*` resolver
credential), scoped onto that bundle.

The path prefix is the part that does the routing, and the console will tell you
whether it landed: a parameter written under a slug that does not set
`params: true` is flagged `not wired` rather than silently going nowhere. See
[the console's parameters page](/operate/secrets/#the-consoles-parameters-page). The container holds no cloud credential, exactly as with a
`${REF}` secret. When no resolver credential is configured, a `params: true` server
simply boots without those values and degrades gracefully — see [Known
limitations](/limitations/).

### On a `builtin`, `params:` resolves at runtime instead

The example above is a `supplementary-image`, where resolution happens once, at
deploy time, into another container's environment. On a **`builtin`** the same
flag means something meaningfully different: the namespace is resolved
**in-process, on every tool call**, and merged over the builtin's `options:` —
through a TTL cache keyed by `gateway.secrets.ttlSeconds` (`gateway/registry.ts`).
A parameter changed in the store therefore reaches a running gateway within the
TTL, with no redeploy. That makes a `params: true` builtin the only thing in a
config that can *demonstrate* runtime rotation from outside the process;
`infra/strad.staging.yaml` uses `echo` for exactly that.

The sharp edge is the merge target. A supplementary server's resolved parameters
become container env vars, which nothing returns to a caller. A builtin's become
**`options:`**, and a builtin is free to put an option in a tool result — `echo`
returns `options.greeting` from `whoami`. So an option a builtin echoes is an
option every caller entitled to that slug can read. Point a `params: true`
builtin's options at a canary, not at a credential, unless you know the builtin
does not surface them.

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
once. It declares twenty-nine server slugs: a core builtin (`echo`), a
credential-free `remote-http` canary (`deepwiki` → `https://mcp.deepwiki.com/mcp`),
and twenty-seven `supplementary-image` entries — twenty-six sharing ONE bundle
over the private network, which resolve onto the bundle image's sixteen mounts
because every read-only / read-write pair is two entries on one path. One of
those, `secrets`, is also the worked example for the split `env:` / `consoleEnv:`
credentials from step 4b, and `remote-filesystem-tmp-public` is the deploy-time
`params: true` example from step 4c — `echo` is the runtime one.

The twenty-seventh, `zimmer-secrets`, is the worked example for the one case where a
second **bundle** is the answer rather than a second `path`: it is the same image
and the same `path: /secrets` as `secrets`, differing only in `bundle:` and in
which store it points at. [Two stores, one
gateway](/operate/secrets/#two-stores-one-gateway) explains why sharing a bundle
there is silently wrong. It also keeps two deliberately narrow roles, `echo-only` and `zimmer`, so
the [424 fail-closed path](/intro/concepts/#the-424-contract) stays exercised. Read
it alongside
[`strad.config.example.yaml`](https://github.com/tadasant/strad/blob/main/strad.config.example.yaml)
as your two references.
