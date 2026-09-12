---
title: "Runtime config: the plan"
description: "What stands between gateway.configStore as it ships today and a deployment whose whole MCP posture is managed from /connectors — measured against the production roster, phase by phase, with the steps only a human can take named separately."
sidebar:
  order: 7
---

[Runtime config](/operate/runtime-config/) describes the overlay that ships
today: a mutable layer over `servers:`, written from `/connectors` or over
`/mcp`, live on the next request. This page is about the distance between that
and the end state somebody actually asked for —

> all MCP configs stored in a runtime database, so we can manage them through
> `/connectors` without redeploys, and all secrets are references to the secret
> store

— stated as phases, with what closes each one, and with the steps a **human**
has to take pulled out into [their own section](#what-only-a-human-can-do),
because "can this be done autonomously?" is a question the plan owes an answer
to rather than a footnote.

## Where the coverage actually is

Measured against the production roster on 2026-09-12. The numbers matter more
than the impression: "the mechanism exists" and "the mechanism covers the
fleet" are different claims, and only the first is true today.

|                                           | count      |
| ----------------------------------------- | ---------- |
| server entries                            | **45**     |
| — `supplementary-image`                   | 37         |
| — `remote-http`                           | 6          |
| — `local-tunnel`                          | 1          |
| — `builtin`                               | 1          |
| entries declaring `env:`                  | **26**     |
| entries declaring `params: true`          | **5**      |
| `env:` values that are `${NAME}` refs     | 42 of 52   |
| `headers:` values that are `${NAME}` refs | **8 of 8** |

And the number this page exists to move — how many of the 45 a runtime write
can **create**:

|                                                                     | count  |
| ------------------------------------------------------------------- | ------ |
| `remote-http` + `local-tunnel` — unhosted, fully runtime-manageable | **7**  |
| `supplementary-image` declaring no deploy-only field                | **8**  |
| `supplementary-image` declaring one or more                         | **29** |
| `builtin` — never creatable at runtime, by construction             | 1      |

**15 of 45.** The deploy-only fields are `env:`, `params:`, `paramsWritable:`,
`paramsRefresh:`, `consoleEnv:`, `consoleStores:` and `mcpStores:`, and
`assertCreatable` refuses every one of them on a runtime write because they
reach a container as environment variables the renderer bakes at render time.
A process's environment is fixed when it spawns.

The 8 header values being refs already is the other half of the picture, and a
happier one: correct practice is universal here, which is what made [phase
1](#phase-1--a-runtime-write-names-a-credential-never-carries-one-shipped)
a description of existing practice rather than a migration.

## The four obstacles, and which are real

1. **`env:` blocks runtime management, and it is the big one.** Real, and it is
   physics rather than policy — see [phase 3](#phase-3--a-mount-reads-its-own-credentials-instead-of-receiving-them).
   29 of 45 slugs are behind it.
2. **The overlay is `servers:` only.** Real, and **sharper than it looks**.
   Entitlement is a two-sided intersection (`src/gateway/entitlements.ts`): a
   `roles:` entry names servers, a server's `entitlements:` names roles, and
   **both must agree**. The overlay carries `entitlements:` because that lives
   on a server entry. It does not carry `roles:`. Production's `zimmer` role
   names seventeen slugs explicitly rather than `*`, so **a connector created at
   runtime is unreachable by `zimmer` until a deploy edits `roles:`** — however
   its `entitlements:` are written. See [phase 4](#phase-4--roles-become-part-of-the-overlay).
3. **A runtime-created connector must never hold a secret value.** Real, and
   **shipped** — [phase 1](#phase-1--a-runtime-write-names-a-credential-never-carries-one-shipped).
4. **`envFallback: true` still permits a `${NAME}` to resolve from the process
   environment.** Real, and **the smallest of the four** — read the two-fallbacks
   note in the internal `strad/infra/README.md` before proposing the flip. Under
   `gcp-parameter-store` the renderer stops baking the gateway-namespace names
   into the spec at all, so the environment the knob falls back **to** is empty
   for every one of them. Flipping it to `false` cuts off nine names that have
   nothing to fall back to and is a no-op for the twenty-three that migrate on a
   separate, render-time mechanism the knob does not control. It is a
   tidying-up, not an unblocking, and it belongs last.

A fifth thing is not on that list and belongs on this one.

5. **The write tools are admin-equivalent, and two separate mechanisms make them
   so.** [strad#349](https://github.com/tadasant/strad/issues/349) has the first:
   a runtime write may CREATE a `supplementary-image` entry on any `path:` in a
   declared bundle, reaching that mount's baked credential under whatever
   `entitlements:` the new slug carries. The second is verified in
   [phase 2](#phase-2--bound-what-the-write-tools-are-worth) below and is not in
   that issue: a runtime write may change `url:` on a slug the **checked-in
   config declares**, and the slug's credential follows it. Both are bounded
   today by the one thing outside the roster — the `connectors` slug is
   `admin`-only — and both stop being bounded the moment that changes.

## The phases

Each phase names what changes, who owns it, and what evidence closes it. The
order is not negotiable in one place: phase 2 gates phase 4, because widening
what a runtime write may move before bounding what it is worth makes the blast
radius larger rather than smaller.

### Phase 1 — a runtime write names a credential, never carries one (shipped)

**What changed.** `src/config/secret-position.ts`: every credential-carrying
value in an entry a runtime write would store must be a reference — one
`${NAME}`, optionally after an auth scheme. It covers `headers:` on every kind,
`url:`'s userinfo, and `oauthRefresh:`'s grant. Enforced at
`RuntimeConfig.assertAcceptable` (the entry a caller composed) and again at
`RuntimeConfig.apply` (everything a write would newly store, which is what
catches `toggle` and `set_connector_enabled` re-upserting an entry they did not
compose). Both doors inherit it from the one seam they already share.

**Owner.** `strad` — this repo.

**Evidence.** `test/config.secret-position.test.ts`, plus a door-level refusal in
`test/connectors.mcp.test.ts` and in `test/connectors.hot-reload.test.ts`. The
overlay parameter is created with `secret: false`, which is why this is about
storage at rest and not only about tidiness.

**What it does not cover**, stated rather than implied away: a URL **query**
parameter, and a **builtin's `options:`**. Both in
[Known limitations](/limitations/) #96, both closed by phase 6.

### Phase 2 — bound what the write tools are worth

Today, reaching the `connectors` write tools is worth admin over every mount in a
declared bundle and over every file-declared slug's credential. Two mechanisms:

- **Create onto a privileged `path:`.** A new `supplementary-image` entry may
  name any `path:` in a bundle this deployment runs, and serves that mount's
  full tool surface under the new slug's own `entitlements:`.
  [strad#349](https://github.com/tadasant/strad/issues/349) has it, verified.
- **Re-point a file-declared `url:`.** `immutableFields("remote-http")` is
  `["kind"]` and `assertNoAccessControlChange` compares `entitlements:`,
  `tools:` and (for supplementary) `path:` — so `url:` moves freely on an entry
  the checked-in config declares. The slug's `headers:` refs go with it. The
  isolated-provider bound does not help here: editing a file slug makes its
  source `store`, so it resolves against **its own namespace**, and for the
  slugs whose credential lives there that is exactly the value being sent.
  Verified in-process: a write moving nothing but `url:` on a file-declared
  `remote-http` delivered `Authorization: Bearer <the slug's token>` to a local
  sink.

  `url:` cannot simply be frozen — a Cloudflare quick tunnel mints a new
  hostname on every restart, and re-pointing a `local-tunnel` without a deploy is
  the flagship reason the roster is editable at all. So this is a design
  decision, not a patch. The candidates: refuse an **origin** change on a
  file-declared entry that carries a credential ref (a tunnel would need a
  one-line file edit or an explicit re-consent); or strip credential headers from
  the first request after an origin change until somebody confirms; or thread the
  writing principal into `assertAcceptable` and bound a write by what that
  principal could already reach.

**Owner.** `strad` — this repo. The _choice_ is a posture decision (see
[below](#what-only-a-human-can-do)).

**Evidence.** A test in `test/connectors.isolation.test.ts` for each mechanism,
in the shape the existing three bounds use: the attack, then the bound, then the
legitimate case that must keep working.

### Phase 3 — a mount reads its own credentials instead of receiving them

The 29. A `supplementary-image` mount's credentials arrive as environment
variables baked into the app spec, and the bundle host discovers which extra
slugs to mount by looking for prefixed marker variables in its own
`process.env` (`servers/bundle/host/src/mounts.ts`). So a slug whose variables
are not there is a slug that container does not serve, whatever the roster says.

The route is the one `paramsRefresh:` already takes, widened: the host reads
from the store rather than from its environment — a name the spec never listed,
not merely a value behind a name it did. `src/secrets/param-route.ts` is the
existing wire between core and the host and is already a vendored seam.
[strad#343](https://github.com/tadasant/strad/issues/343) carries it.

**Honest answer to "can `supplementary-image` get there at all?"** Yes, but not
uniformly. A mount that reads its credential from `process.env` **once at
start-up** — which is most third-party MCP server images — cannot be given a new
one without a restart, and nothing in App Platform restarts one container. So
phase 3 delivers "a new account for a bundled server, live after the next
container restart", not "live on the next request". The kinds that are genuinely
add-and-use stay `remote-http` and `local-tunnel`, which run in core's own
process; for a third-party server that is not published as a hosted endpoint,
the honest end state is a mount whose credential set is refreshed on a schedule
or on a restart, and the plan should say that to whoever is expecting otherwise.

**Owner.** `strad` for core and the host tree; `strad-production` for the prod
roster once a slug can migrate.

**Evidence.** One prod slug created end to end at runtime, serving tools, with
no entry in `infra/strad.prod.yaml`.

### Phase 4 — `roles:` becomes part of the overlay

Granting or revoking a role's reach is a PR and a deploy today, and this is the
wall that gets hit most often. It is small in code and large in consequence:
`roles:` is one half of the entitlement intersection, so an overlay that can
write it is an overlay that can grant access.

The shape that keeps it reviewable: a **second** overlay document, with its own
parameter, its own console page and its own tool surface — not a widening of
`SERVERS`. A grant is then a thing with its own revision history and its own
audit line, and a deployment can mount the roster editor without mounting the
grant editor. `assertNoAccessControlChange`'s argument still holds on the other
side: a role the checked-in file declares is the deploy's, and what the overlay
adds is grants, not redefinitions.

**Blocked on phase 2.** Until the write tools cost less than admin, adding a
grant editor to them adds nothing an attacker did not already have — and makes
that fact harder to see.

**Owner.** `strad`.

**Evidence.** A role granted reach to a slug from `/connectors` and from
`save_grant`, a `/mcp` request that is refused before it and served after it,
and no deploy in between.

### Phase 5 — the rest of the document

`bundles:`, `auth:` and the `gateway:` block. Each one is a different answer, and
lumping them together is how this gets done wrong:

- **`bundles:`** decides container topology. A runtime write cannot create a
  component; it can only name one that exists. Read-only at runtime is the right
  end state, and saying so is the deliverable.
- **`auth:`** already moved the part that should move —
  `auth.staticTokens.store: parameter-store` puts the `/mcp` token records in
  the store, so `/tokens` can mint and revoke without a deploy. What is left is
  the enable/disable flags, which are posture, not operations.
- **`gateway:`** is boot shape — `publicUrl`, telemetry, the secrets provider.
  Changing it at runtime would mean a process that no longer matches the spec
  that started it. Read-only, deliberately.

**Owner.** `strad`.

**Evidence.** Each of the three has a paragraph in
[Runtime config](/operate/runtime-config/) saying which it is and why, and
`servers/interface.md` agrees.

### Phase 6 — a typed statement of which fields carry a credential

The two positions phase 1 does not cover — a URL query parameter, a builtin's
`options:` — need something phase 1 deliberately did not invent: a per-kind,
per-builtin declaration of which fields are credential-carrying. With one,
`assertSecretsByReference` stops being a list of positions in a module and
becomes a property of the schema, and `redacted()` in `src/servers/connectors.ts`
stops being a best-effort pass over two known fields.

**Owner.** `strad`.

**Evidence.** A builtin declaring a credential-carrying option, refused as a
literal on the runtime path and redacted on the read path, with `echo`'s
`greeting` still accepted as the literal it is.

### Phase 7 — `envFallback: false`

Last, and small. The knob governs the nine gateway-namespace names, not the
twenty-three supplementary ones; the twenty-three have a separate render-time
fallback it does not control. Flipping it removes a backstop that is already
empty under this provider. It is worth doing for the honesty of the config, and
it unblocks nothing.

**Owner.** `strad-production` — it is one line in `infra/strad.prod.yaml`.

**Evidence.** The deploy's own parameter-store report shows every one of the
nine present before the flip, and `/healthz` is not degraded after it.

## What only a human can do

The answer to "will I need to jump in?" is **yes, in five places**, and none of
them is "review the code". Each is named with the reason, because the reason is
what decides whether it can ever be automated away.

1. **Decide what the `connectors` write tools may be granted to** (phase 2).
   This is a posture decision, not a defect: strad#349's three options —
   read-tools-only for the narrow role, keep the write tools admin-only, or bound
   creates in strad — are a trade between capability and blast radius, and an
   agent picking one of them is an agent choosing its own privileges. **This one
   is live right now**: a separate change grants the `zimmer` role reach to the
   `connectors` slug, and whether that includes the write half is exactly this
   decision.
2. **Choose how a file-declared `url:` may move** (phase 2). Same character:
   every candidate trades the quick-tunnel workflow against credential
   containment, and there is no reading of the requirements that settles it.
3. **Grant the IAM the host-side credential path needs** (phase 3). Reading a
   parameter from a container that holds no cloud credential means core serving
   it a value over the private network, and whatever principal ends up
   dereferencing a **secret** parameter needs
   `roles/parametermanager.parameterAccessor`. That role is the one thing
   standing between `/mcp` and a production secret value today, so who holds it
   is a decision only its owner can make. An agent can write the Terraform; it
   cannot decide that a new principal may deref secrets.
4. **Complete each OAuth consent** (phases 3 and 4, ongoing). Granting consent
   is a browser handshake with a third party. `describe_connector_authorization`
   exists precisely because an agent cannot do it: it returns the URL a human
   opens and the parameter path the credential lands at.
   `docs/src/content/docs/operate/connectors.md` has the flow.
5. **Merge every PR.** `main` is protected in both repos, and the runtime-config
   surface is the one an escalation would arrive through. That is the review gate
   working as intended.

Everything else in this plan is agent-executable: the code, the tests, the docs,
the staging verification, the prod roster edits in `infra/strad.prod.yaml`, and
the `envFallback` flip. None of it needs a shell on a running container — see
the operability rule in `AGENTS.md`, which this plan is bound by like any other
change here.

## What belongs to `strad-production`

This repo mints a generic, server-less image. The production roster, the pinned
image version, the prod secrets map and the deploy docs live in
`tadasant/tadasant-internal` under `strad/`, and that directory belongs to the
`strad-production` agent root. Three things in this plan land there rather than
here:

- **The `zimmer` grant on `connectors`** — with the `tools:` decision from
  [above](#what-only-a-human-can-do) applied, rather than the full surface by
  default.
- **Migrating a slug off `env:`** once phase 3 lands: removing the `env:` block
  from an entry in `infra/strad.prod.yaml` and letting the runtime path carry it.
- **`envFallback: false`** (phase 7), after the nine names are confirmed present.
