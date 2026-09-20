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
- **`local-tunnel`** — set `url` (your tunnel's hostname **and the path the
  server behind it serves on** — plenty serve at `/mcp`, plenty at the root), any
  `headers`, and a `recovery:` block naming the machine and the commands that
  bring it back.
  For a server on a machine you own; it needs no bundle and no image, and it is
  expected to be offline whenever that machine is. See
  [the kind's section](/servers/interface/#2-local-tunnel) for what changes when
  it is.
- **`supplementary-image`** — set `image` and a `bundle`, plus optional `env` /
  `path` (and `consoleEnv` for a credential only the human console may hold — see
  step 4b). Servers that share an image share the bundle (one component runs one
  image); each gets its own `path`.
- **`builtin`** — set `module` and `bundle` (`core` = in-process, anything else =
  a bundle component), plus optional `options`.

A `remote-http` server can also be written in the [`mcp.json`
dialect](/servers/interface/#mcpservers--the-draft-sep-2633-input-dialect) —
draft SEP-2633's `mcpServers:` map, beside `servers:` in the same file — which is
useful when you are pasting an entry a client already has. It desugars into
exactly the `remote-http` entry above, and the rest of this page is unchanged: an
entry written that way still needs step 2, and still declares its `tools:` policy
in step 3b. The other three kinds have no expression in the format.

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

An entry written in the `mcp.json` dialect declares its half under
`strad: { entitlements: [...] }`. If it declares nothing — which is what a
pasted `mcp.json` looks like, since the format has no notion of who a server is
for — it attaches with `entitlements: []` and `npm run config:check` warns,
naming the slug and both halves of the fix.

## 3. Declare any bundle it needs

If the server runs outside `core` (a `supplementary-image`, or a `builtin` with a
non-`core` bundle), declare that bundle:

```yaml
bundles:
  - name: bundle
    instanceSizeSlug: apps-s-1vcpu-2gb
```

Referencing an undeclared bundle is a boot-time validation error. An
`instanceSizeSlug` naming no App Platform plan is not — the schema takes any
string, because it is also the boot parse — but it reds
[`config:check`](/servers/interface/#nor-an-instancesizeslug-that-names-no-plan--and-that-is-the-same-split)
on the pull request that writes it, which is a good deal earlier than
DigitalOcean rejecting it at the end of a deploy.

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

Spell the tool names exactly. An `allow` list is exhaustive, so an entry that
matches no tool matches nothing and quietly costs that slug one tool. CI checks
every entry against the names the mount really serves —
[`check-tool-policy`](/operate/deploy-model/#checking-a-tools-policy-against-the-tools-that-exist),
in the job that boots the bundle image — so a typo or a stale name fails the PR.
For a server CI cannot enumerate (a `remote-http` upstream, an image it does not
boot) that check skips and says so, and the runtime alarm is what is left.

## 4. Seed any secrets

Any `${NAME}` reference in the config (in `headers`, `env`, or builtin `options`)
must resolve to an env var at boot. Those values live in **GCP Secret Manager** as
`strad-<env>-<NAME>` and are injected as App Platform SECRET env vars at deploy
time — the container itself holds no cloud credentials.

`render-spec` walks the _parsed_ config for `${NAME}` refs and injects each as a
required SECRET; an unresolved `${…}` makes render fail loudly rather than letting
the gateway crash-loop. Seed staging secrets with the `secrets-sync` workflow (see
[Operations & CI](/operate/operations/#seeding-secrets)).

## 4a. If the secret is not seeded yet, declare `mayBeUnseeded:`

Declaring the server and seeding its credential are two steps, and a PR can only
do the first. By default the render is **all or nothing** — one `${NAME}` the
store does not hold exits `render-spec` with an error and no spec at all — so an
entry merged ahead of its secret does not merely degrade its own slug. It stops
the deploy for every other server in the file.

Naming the reference waives that, for that name only:

```yaml
- slug: apify
  kind: remote-http
  url: https://mcp.apify.com/mcp
  entitlements: [admin]
  headers:
    Authorization: "Bearer ${APIFY_TOKEN}"
  mayBeUnseeded: [APIFY_TOKEN]
```

The render warns instead of failing, every other server deploys normally, and
this slug comes up `unconfigured`: named on `/healthz`, chipped `awaiting
credential` in the console, and refusing a `?servers=apify` listing with a
message naming the credential. Seed the value and — under
`gcp-parameter-store`, for a `url:`/`headers:`/`options:` ref — it starts serving
within `negativeTtlSeconds` (default 1 hour; at once if you seed it through
strad's console or the `secrets` MCP server), with no redeploy and no second PR. A
`supplementary-image`'s `env:` is baked onto its container instead, so that half
takes the next deploy. Full behaviour is in
[Secrets](/operate/secrets/#maybeunseeded--deploying-a-server-ahead-of-its-credential).

It is a list of names rather than a flag, and that is the safety property: an
entry naming a `${NAME}` its server references nowhere is a **hard error** in both
`config:check` and `render-spec`, so a typo'd `${APIFY_TOKN}` beside a waiver for
`APIFY_TOKEN` still reds the deploy rather than degrading in silence. A name is
also only waived when **every** enabled server referencing it waives it.

### When `enabled: false` is still the right answer

`mayBeUnseeded:` ships a slug that is visible and waiting. Ship it disabled
instead when it should not be listed, entitled or mounted at all yet:

```yaml
- slug: pulse-subregistry
  kind: supplementary-image
  # ...
  enabled: false # until PULSEMCP_SUBREGISTRY_API_KEY is in the store
  env:
    PULSEMCP_SUBREGISTRY_API_KEY: "${PULSEMCP_SUBREGISTRY_API_KEY}"
```

`enabled: false` is skipped everywhere it matters: `render-spec` never demands the
name, the registry never mounts the slug, and the connectors roster sorts it last
with no badge — strad asks nothing of it, so a green would be a claim about a
server that answers nothing. The
mount is still in the image and the entry still documents itself, so turning the
server on later is a one-line diff and a redeploy.

`test/staging-config.test.ts` holds the staging config to a **provisioning
ledger** — `PROVISIONED_STATICS`, the names staging's store actually holds. An
enabled entry referencing a name that is neither on it nor waived fails CI, which
is the cheap version of the failure; the expensive version is a red `main` and a
blocked deploy. Adding a server whose credential is seeded means adding its name
there in the same PR.

## 4b. A credential the AGENT must not hold — `consoleEnv:`

`env:` on a `supplementary-image` lands on the **container that answers `/mcp`**.
Anything in it is a credential the agent path holds. That is usually what you want.

Sometimes it is exactly what you do not. `consoleEnv:` is the scope that lands on
the **core gateway only** — the component that serves the SSO-gated console, and
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
`/strad/{env}/mcp/{slug}/static/*` and `/strad/{env}/mcp/{slug}/oauth/*` are
resolved and injected as this server's
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
sliced from the process's one reading of the store, which is held for
`gateway.secrets.ttlSeconds` (`gateway/registry.ts`, `secrets/parameters/gcp.ts`).
A parameter changed in the store therefore reaches a running gateway within the
TTL, with no redeploy — at once, if it was changed through strad's console. That
makes a `params: true` builtin the only thing in a
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

`infra/strad.staging.yaml` in the repo deliberately exercises all four kinds at
once. It declares thirty-five server slugs: a core builtin (`echo`), a
credential-free `remote-http` canary (`deepwiki` → `https://mcp.deepwiki.com/mcp`),
a `local-tunnel` (`anki`, which ships disabled),
and thirty-two `supplementary-image` entries — thirty-one sharing ONE bundle
over the private network, which resolve onto twenty paths because every
read-only / read-write pair is two entries on one path. Nineteen of those are
among the bundle image's twenty-three baked mounts; the twentieth,
`/grafana-registry`, is a per-slug instance the host stands up because the
container carries that slug's own Grafana credential. One of
those, `secrets`, is also the worked example for the split `env:` / `consoleEnv:`
credentials from step 4b, and `remote-filesystem-tmp-public` is the deploy-time
`params: true` example from step 4c — `echo` is the runtime one.

The thirty-second, `zimmer-secrets`, is the worked example for the one case where a
second **bundle** is the answer rather than a second `path`: it is the same image
and the same `path: /secrets` as `secrets`, differing only in `bundle:` and in
which store it points at. [Two stores, one
gateway](/operate/secrets/#two-stores-one-gateway) explains why sharing a bundle
there is silently wrong. It also keeps two deliberately narrow roles, `echo-only` and `zimmer`, so
the [424 fail-closed path](/intro/concepts/#the-424-contract) stays exercised. Read
it alongside
[`strad.config.example.yaml`](https://github.com/tadasant/strad/blob/main/strad.config.example.yaml)
as your two references.
