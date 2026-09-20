---
title: "Runtime config: the plan"
description: "What stands between gateway.configStore as it ships and a deployment whose whole MCP posture is managed from /connectors — measured against the production roster, phase by phase, with the steps only a human can take named separately."
sidebar:
  order: 7
---

[Runtime config](/operate/runtime-config/) describes the overlay as it ships:
a mutable layer over `servers:`, written from `/connectors` or over
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

Measured against the production roster — `strad/infra/strad.prod.yaml` in the
private `tadasant/tadasant-internal`, on 2026-09-12 — so these counts are a dated
snapshot this repo cannot re-derive. The numbers matter more than the
impression: "the mechanism exists" and "the mechanism covers the fleet" are
different claims, and on that date only the first was true.

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
   on a server entry. It does not carry `roles:`. A role that names its slugs
   explicitly rather than `*` therefore **cannot reach a connector created at
   runtime until a deploy edits `roles:`** — however its `entitlements:` are
   written — and production's narrower roles are written that way. See [phase 4](#phase-4--roles-become-part-of-the-overlay).
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

5. **Reaching the write tools was worth more than it looked.** The fields a
   runtime write may still move on an entry — a new slug's `path:`, and fields
   the access-control rules did not bind on a checked-in one — let a writer reach
   credentials that belong to other slugs. The mechanisms and their
   reproductions are tracked in the private
   [strad#349](https://github.com/tadasant/strad/issues/349) rather than on
   this page. They were bounded only by the one thing outside the roster — the
   `connectors` slug being `admin`-only — and would have stopped being bounded
   the moment that changed. [Phase 2](#phase-2--bound-what-the-write-tools-are-worth-shipped-with-one-half-left-open)
   bounds them inside strad instead, with one half of the question left open on
   purpose.

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

### Phase 2 — bound what the write tools are worth (shipped, with one half left open)

The `connectors` write tools let a writer reach mounts and credentials that
belong to slugs other than the one being written. strad#349 has the mechanisms,
verified. The expectation on this page was that **every** candidate bound trades
a workflow the roster exists to serve — re-pointing a quick tunnel without a
deploy, adding a second slug onto an already-deployed mount — so that none could
be picked without a posture decision. Measured against the production roster,
that turned out to be true of one candidate and false of the others.

**What changed.** `RuntimeConfig.assertAcceptable` takes the **writing
principal**, supplied by both doors, and `assertWithinReach` bounds a write by
what its author already reaches:

- A new `supplementary-image` slug may only land on a `bundle:` + `path:` its
  author reaches through a checked-in slug.
- A **credential destination** on a checked-in slug may only be moved by an
  author that slug's `entitlements:` admit — which is what re-pointing one's own
  quick tunnel needs. There are four such fields rather than the one #349's
  comment names: `url:`, `oauthRefresh.tokenUrl`, and a connector's
  `oauth.tokenUrl` / `oauth.authorizeUrl`. The OAuth endpoints carry a better
  credential than the bearer they mint — the client secret and the long-lived
  refresh token — and `oauth:` is declared on every kind, so the bound is not
  scoped to the unhosted ones.

Alongside them, the slug's **upstream identity** — `kind:`, and a supplementary
`bundle:` and `path:` — is now bound on both write paths rather than only on the
edit path. That closes a third mechanism, found while bounding the first two and
the only one of the three that lands against production's shape: a narrow role
reaches exactly the slugs its `roles:` entry NAMES and the overlay cannot write
`roles:`, so a create under a new name is unreachable to it — but removing a
checked-in `local-tunnel` and re-creating it as a `supplementary-image` on
another mount keeps the name, and with it the reach the deploy granted.

**Why these needed no choice.** Each candidate was measured against the roster
rather than argued about. The two issue candidates failed: "may not carry roles
beyond the principal's" does not stop the attack at all (a `zimmer` writer
granting `[zimmer]` never exceeded its roles), and "may not land on a `path:` a
checked-in slug declares" forbids the `gmail-ro` / `gmail-rw` create outright.
The reach bound costs nothing instead of costing a workflow, because a role
written `servers: ["*"]` whose slugs all name it reaches every mount the
deployment declares — every one of the **27 distinct `bundle:` + `path:` mounts**
the production roster declared on 2026-09-13, counted with the same caveat as the
table at the top of this page: a dated read of `strad/infra/strad.prod.yaml` in
the private `tadasant/tadasant-internal`, which this repo cannot re-derive. A
mount is not a slug — prod declares more slugs than mounts, which is what a
`-ro` / `-rw` pair on one path is. So the bound never fires for the role that
holds the write tools today. The identity freeze costs nothing because all three fields
were already immutable on the edit path; it makes a move refused as one call
refused as two.

**The half that was left a choice: carrying the `tools:` policy along.** The
bounds are measured in mounts, so a writer that already reaches a mount may
create a second slug on it with a wider tool surface than the checked-in slug it
reaches that mount through. Closing that means a created slug may serve no more
than its author already reaches on that mount, and that one **does** trade a
workflow, because it narrows the wildcard role too. Three of those 27 mounts are
reachable by it only through a `tools.allow` slug — the three
`google-sheets-*-ro` mounts, which are prod-only and are in neither this repo's
staging config nor anything else a reader here can check — and on those it could
no longer create the wider half of a `-ro` / `-rw` pair without a deploy.

**Decided on 2026-09-13: the half stays open.** Tadas, given that trade: _"i want
to keep the workflow you mentioned for now"_. A runtime write may still create a
wider-tool slug on a mount its author already reaches, and the `-ro` / `-rw`
runtime workflow is kept. "For now" is part of the decision: it is a present
choice about a present roster.

**What reopens it: a `connectors` write tool granted to a role other than
`admin`.** What bounds the residual today is who holds the write tools rather
than what they may do with them. `save_connector`, `set_connector_enabled`,
`restore_connector` and `remove_connector` are `admin`-only in production, and
`admin` already reaches every mount the deployment declares, so the only
widening available through them is the `-ro` / `-rw` workflow the decision keeps.
Production gives the `zimmer` role the read half alone, as a `connectors-ro`
slug (tadasant-internal#2816). Grant any of those four to a role narrower than
`admin` and the escalation the bound would have closed becomes reachable: a role
the deploy gave read-only tools on a container can hand itself the write ones.
The trigger is drawn wider than the mechanism deliberately. The widening itself
runs through `save_connector` alone, because it is the only one of the four that
composes an entry and so the only one that reaches `assertAcceptable` at all —
but the other three carry the availability residual described in
[Known limitations](/limitations/) #96, and a grant is decided as a grant rather
than tool by tool. So any of the four re-opens this, in the PR that proposes it.
Human step [1](#what-only-a-human-can-do) decides the grant; this is the
question that travels with it. Both prod facts here are a dated read of
`strad/infra/strad.prod.yaml` in the private `tadasant/tadasant-internal`, like
the counts above, and this repo cannot re-derive either.

**Owner.** `strad` — this repo.

**Evidence.** `test/connectors.isolation.test.ts` carries one suite per mechanism
in the shape the existing three bounds use — the attack, the bound, the
legitimate case that must keep working — including an end-to-end probe showing a
re-pointed slug's credential arriving at a sink, and the `admin` cases asserted
as still passing. The principal is proved to survive each door end to end rather
than asserted: `test/connectors.mcp.test.ts` drives a narrow-role token through a
real MCP client, `test/connectors.hot-reload.test.ts` drives a narrow-role console
session through a real form post, and both fail if either door stops passing it.
The chosen behaviour of the open half is recorded as a test, so that re-taking
the decision must update the record.

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

**What changed — the `strad` half.** A store-served instance: a
`supplementary-image` entry on `path: /_instance/{tree}/{its own slug}` with
`params: true`. Core lists the instances on a component
(`GET /_strad/instances?bundle=`) from its current config, and serves one
instance's own namespace (`GET /_strad/instances/{slug}`). The bundle host builds
the instance from what it is served, re-syncs on an interval and on the first
request for an instance it does not hold, and never falls back to its own
environment. The render bakes nothing for one. `assertCreatable` accepts
`params: true` on an instance and still refuses the other six deploy-only fields;
the reach bound accepts an instance on its own path when the author reaches some
checked-in slug on that component. The client and the reconciler are in
`src/secrets/param-route.ts`, which is already vendored.

**Which mounts get which.**

- `telegram`, `google-sheets`, `grafana` — **add and use, no restart.** Each
  already builds from an injected environment, so an instance is a second copy in
  the same process, and a rotation rebuilds it on the next sync.
- `remote-filesystem-tmp-public` — per-slug by environment, and **not** an
  instance tree yet: its upload and download routes key on the mount path, and
  its variable names carry the second slug rule strad#153 is about.
- gmail, calendar, docs, and every tree that reads `process.env` once — **still a
  deploy.** Nothing restarts one App Platform container, and a second credential
  for such a tree needs a second process. The honest end state above stands.

**strad#153 was checked first**, as the issue gate asked. An instance's namespace
is addressed by the slug through `serverParameterPath`, and its values reach the
tree under their bare names. No `<SLUG>__NAME` mangling is on this path, so
neither of the two namespacing rules #153 describes is either.

**What it does not decide.** The open half of phase 2 is unchanged: an instance
is a new mount reached through no checked-in slug, so there is no narrower
checked-in `tools:` for it to widen past, and a writer that reaches an existing
mount reaches it exactly as before. There is no new secret-reading principal:
core reads the namespace with the resolver it already holds, and hands the
values only to the component the slug is on, identified by that component's own
internal token ([Known limitations](/limitations/) #63, #100).

**Owner.** `strad` for core and the host tree; `strad-production` for the prod
roster once a slug can migrate.

**Evidence.** In this repo, `test/instances.test.ts`: a slug created through
`RuntimeConfig` is listed by core, served from its own namespace (never core's
environment, never the gateway namespace), rebuilt on a rotation and removed on
a removal, with no deploy — plus the route refusals, the relaxed
`assertCreatable`, the reach bound and the schema rules. Still owed by
`strad-production`: one prod slug created end to end at runtime, serving tools,
with no entry in `infra/strad.prod.yaml`.

### Phase 4 — `roles:` becomes part of the overlay

Granting or revoking a role's reach takes a PR and a deploy, and this is the
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

**Was blocked on phase 2**, which has shipped its bounds: a write now reaches no
mount its author does not already reach, so the write tools cost less than admin
and a grant editor added to them is worth something narrower than everything.
Read the residual [phase 2](#phase-2--bound-what-the-write-tools-are-worth-shipped-with-one-half-left-open)
leaves open before designing this one, because a grant editor changes the roles
side of the intersection and the reach bound is measured from it — a phase where
`roles:` is writable is a phase where "what its author already reaches" is a
thing the author can move.

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

The answer to "will I need to jump in?" is **yes, in five places** — one of them
already answered — and none of them is "review the code". Each is named with the
reason, because the reason is what decides whether it can ever be automated away.
Item 2 stays listed after its answer because that answer carries a condition that
brings the question back.

1. **Decide what the `connectors` write tools may be granted to** (phase 2).
   This is a posture decision, not a defect: strad#349's three options —
   read-tools-only for the narrow role, keep the write tools admin-only, or bound
   creates in strad — are a trade between capability and blast radius, and an
   agent picking one of them is an agent choosing its own privileges. The grant
   that raised it landed on the read half: the `zimmer` role reaches the
   `connectors` slug as a `connectors-ro` slug, the read tools alone
   (tadasant-internal#2816). Whether a later grant includes the write half is
   still exactly this decision, and item 2 comes with it.
2. **Decide whether a runtime write may widen a mount's tool surface** — the
   half of [phase 2](#phase-2--bound-what-the-write-tools-are-worth-shipped-with-one-half-left-open)
   that is left open. **Answered on 2026-09-13 by Tadas:** _"i want to keep the
   workflow you mentioned for now"_. The bounds that shipped cost no workflow, so
   they needed no decision and did not get one. This one did: forbidding a
   created slug from serving more than its author already reaches on that mount
   closes a writer widening its own read-only access to a container, and takes
   the wider half of a `-ro` / `-rw` pair out of the runtime roster on any mount
   whose only checked-in slug is the narrow one, which is three of production's
   27 mounts. Adding the read-write half on those would then need a deploy. The
   answer keeps that workflow, so the widening stays.

   It comes back with item 1, and only with it. The residual is bounded by who
   holds the write tools: `save_connector`, `set_connector_enabled`,
   `restore_connector` and `remove_connector` are `admin`-only in production, and
   the `zimmer` role holds the read half alone (tadasant-internal#2816). Granting
   any of the four to a role narrower than `admin` is what makes the trade live
   again — the widening itself runs through `save_connector`, the only one of the
   four that composes an entry, and the trigger is drawn at the grant because
   that is the unit the decision is taken in. The PR proposing such a grant is
   where this gets re-taken rather than assumed settled.

3. **Grant the IAM the host-side credential path needs** (phase 3). Reading a
   parameter from a container that holds no cloud credential means core serving
   it a value over the private network, and whatever principal ends up
   dereferencing a **secret** parameter needs
   `roles/parametermanager.parameterAccessor`. That role is the one thing
   standing between `/mcp` and a production secret value, so who holds it
   is a decision only its owner can make. An agent can write the Terraform; it
   cannot decide that a new principal may deref secrets.

   As shipped, phase 3 needs **no new principal**: core serves an instance's
   values out of the resolver it already holds, which already has
   `parameterAccessor`. Per-component internal tokens came first, as that
   decision required: core serves an instance's values only to the component
   that runs it ([Known limitations](/limitations/) #63, #100).

4. **Complete each OAuth consent** (phases 3 and 4, ongoing). Granting consent
   is a browser handshake with a third party. `describe_connector_authorization`
   exists precisely because an agent cannot do it: it returns the URL a human
   opens and the parameter path the credential lands at.
   `docs/src/content/docs/operate/connectors.md` has the flow.
5. **Merge every PR.** The runtime-config surface is the one an escalation would
   arrive through, and a human decides when a change to it lands.

   Worth being exact about what enforces that, because it is **not** GitHub.
   Neither repository's `main` is protected: both are private repositories on a
   plan where the feature is unavailable, so `branches/main` reports
   `"protected": false` and both the branch-protection and the rulesets APIs
   answer `403`. The gate is the convention that an agent never merges its own
   PR, plus the merge gate that rates one — which is a gate a human operates,
   not a branch rule. Treat "protected" as a description of the practice rather
   than of the repository.

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
- **Migrating a slug off `env:`** now that phase 3's `strad` half has landed:
  for a telegram, google-sheets or grafana slug, moving it to its instance path
  with `params: true`, seeding its namespace, and removing the `env:` block from
  its entry in `infra/strad.prod.yaml`.
- **`envFallback: false`** (phase 7), after the nine names are confirmed present.
