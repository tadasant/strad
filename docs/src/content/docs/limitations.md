---
title: Known limitations
description: The shims, gaps, and deferred work in the current strad build — drawn straight from HACKS.md. Read this before you treat anything as finished.
sidebar:
  order: 1
---

These docs are honest about what's finished and what isn't. The list below tracks
the repo's [`HACKS.md`](https://github.com/tadasant/strad/blob/main/HACKS.md), and
the numbers match its entries so you can cross-reference. Each item names the shim,
why it exists, and how it gets undone.

If you only read one section, read the first.

## Where a guarantee is weaker than it looks

### 22. Capability is policy, not physics

Read-only versus read-write is a `tools: { allow: [...] }` list on a config entry,
enforced by the **gateway**: a withheld tool is refused with JSON-RPC `-32600` on
`tools/call`, before the request reaches the upstream. That is a real boundary, and
it is a weaker one than what it replaced.

It used to be physics. `GMAIL_ENABLED_TOOLGROUPS=readonly` meant the read-only
container _did not have_ the write tools — the process could not perform the write
if it tried. Now `gmail-ro` and `gmail-rw` are two entries pointing at the same
container, which holds full-capability credentials, and the only thing standing
between the read-only slug and a write is a gateway that declines.

The consequence is concrete: a bug in `toolPolicy.ts`, or a config entry that
forgets its `tools:` block, silently promotes a read-only slug to read-write. The
container's own credential is no longer a backstop. `unmatchedAllowEntries()` logs
`mcp.policy_unmatched_tools` when an allow-list names a tool the upstream doesn't
offer, which catches upstream renames, and `test/staging-config.test.ts` asserts
each tier is a subset of the one above it. Neither of those makes the boundary
physical.

**Why anyway:** it is what collapsed thirteen billed App Platform components into
two. **Undo:** there is no clean one. Restoring physics means one container per
capability tier, which is the topology that was deliberately removed.

### 13. The bundle serves `/mcp` with no bearer auth of its own

The `strad-bundle` container serves its mounts unauthenticated. Its only protection
is that it is an internal-only App Platform component — `internal_ports: [8080]`, no
public route — reachable solely by the core over the private network. Anything else
that got into the VPC could talk to it directly.

A strad-image bundle (one holding `builtin` servers) does _not_ have this problem;
it requires `STRAD_INTERNAL_TOKEN` with a constant-time compare. The supplementary
path never grew the equivalent.

**Undo:** add `headers: { Authorization: "Bearer ${STRAD_INTERNAL_TOKEN}" }` to the
server entries and have the bundle host reject requests without it. The token is
already in the component's environment.

### 16. The gateway can't gate MCP Apps on client capabilities

strad's `/mcp` is deliberately stateless, so it sees a client's `initialize`
capabilities once and never again on the follow-up POSTs. That means it cannot
withhold the `resources` capability from a client that didn't ask for it. The
gateway therefore advertises `resources` unconditionally, proxies them, and always
advertises the `io.modelcontextprotocol/ui` extension upstream.

The strict "byte-identical result for a non-App client" guarantee is upheld one
layer down, at `good-eggs`, which _is_ session-ful. Through the gateway, the App
surface is exposed to every client and rendered only by the ones that asked for it.

This is the intended design given statelessness, not a stopgap — but it is a real
difference between calling `good-eggs` directly and calling it through strad.

### 28. An unknown config key is ignored at boot, not rejected

The schema is built from Zod objects, and Zod strips what it does not recognise. So
`consoleEnvs:` where you meant `consoleEnv:` is valid YAML, parses clean, renders
clean, deploys clean — and does nothing. The gateway never says a word, and the only
symptom is whatever that key was supposed to configure quietly not being configured.

Boot stays lenient deliberately: the config and the image version independently, and
an image that refused to start on a key it had never heard of would turn a rollback
into an outage. A false failure at boot costs an outage; a false pass at deploy costs
a silent misconfiguration — so the strictness lives at the gate.

[`check-config`](/operate/deploy-model/#checking-a-config-before-it-deploys) is that
gate: an unknown key is exit 1, annotated, with a "did you mean". It needs no
credentials, so any repo holding a config can run it on every PR, and `ci.yml`'s
`config` job runs it over all three configs here.

What it still cannot catch: a typo inside an **open map** — an `env:` /
`consoleEnv:` variable name, a builtin's `options:`, or a **role name** under
`roles:`. Those keys are the declarer's vocabulary, not the schema's, and the
schema keeps every one. A misspelled env var name is still silent. (A role's own
fields are ordinary schema keys and _are_ checked: `roles.admin.serverz` is
caught.)

## Auth and identity

### 2. The console dev bypass stands in for Google OAuth

`/console` is enterable with `ADMIN_BOOTSTRAP_TOKEN`. It is triple-guarded (requires
`auth.consoleDevBypass.enabled`, `ALLOW_DEV_AUTH=true`, and either a non-production
`NODE_ENV` or `ALLOW_DEV_AUTH_IN_PRODUCTION`), and it logs loudly.

**It cannot authenticate `/mcp`.** That endpoint takes a static system token and
nothing else; there is no code path from a console session to it.

Google sign-in is complete in code — the `hd` claim check, the session it
mints, and the gate that accepts it — and the bypass sits **alongside** it, not
behind it. What is left is provisioning: an OAuth client for
`https://strad.tadasant.com/console/oauth/callback` and its two secrets. Staging
also depends on the bypass, and it is the only way an automated actor reaches the
console (see #43 in the repo).

**Undo, in this order:** provide `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`, set
`auth.google.enabled: true`, verify a real sign-in in prod, then set
`consoleDevBypass.enabled: false`, and only then delete `src/auth/dev.ts` and its
call sites. `src/ui/console-auth.ts` imports from that module; deleting it before
Google sign-in is verified leaves `/ui` with no fallback authenticator. See
[Auth](/auth/overview/#console-dev-bypass-temporary).

### 20. The dev-bypass "session" is the bootstrap token in a cookie

A Google login mints a real signed, expiring session — see
[Auth](/auth/overview/#the-console-session). The **bypass** half of the gate is
not one: when `ADMIN_BOOTSTRAP_TOKEN` is presented as `?token=`, the
gate moves it into an HttpOnly, `SameSite=Lax`, Secure-in-prod cookie
(`strad_console`) and redirects to a clean URL, so the token isn't left in the
address bar or in screenshots — but the cookie **is** the standing credential,
re-validated on every request rather than a session in its own right. It is scoped
to `/` rather than `/ui`, since the gate covers the landing page too; it therefore
rides along to `/mcp`, where it is inert — that endpoint reads the `Authorization`
header via the static token store and never looks at cookies.

Same scope as #2: it is console-class only and cannot reach `/mcp`.

**Undo:** it goes away with the dev bypass itself.

### 6. Token records live in an env var, not a database

`STRAD_TOKENS` is a JSON array of token records (SHA-256 hashes only — the plaintext
is shown once at mint and never stored). Minting or revoking a token means editing
the secret and redeploying.

**Undo:** implement a DB-backed `TokenStore` — the interface is already the right
shape — plus a `/console` mint/revoke UI, and drop `STRAD_TOKENS`. See
[Auth](/auth/overview/#mcp--static-system-tokens-agents).

## The deployment

### 24. Fifteen servers share one process and one CPU

The `bundle` component runs one Node process that mounts fifteen MCP servers and
launches one shared Chromium, on `apps-s-1vcpu-2gb`. A crash in the host takes all
fifteen down together, and Chromium contends with every other server for the single
vCPU.

Measured working set is ~760MB with two browser servers logging in at once, against
a 2GB limit — so memory has headroom. Compute is the suspected binding constraint,
which is why the [telemetry](/operate/telemetry/) exists: `strad.eventloop.delay.p99`
and `strad.container.memory.utilization` are there to answer "is this thing starved,
and of what."

**This is an accepted risk, not a proven design.** If it turns out to be starved, the
next move is a dedicated CPU (`apps-d-1vcpu-2gb`), not more RAM.

### 18. An App Platform spec update deletes any field it omits

A spec update is a **full replace**. Omitting `domains` detaches the custom domain —
and the app then stays perfectly healthy on its `*.ondigitalocean.app` ingress while
the real hostname fails its TLS handshake, so no health check fires. This has already
happened once, to `staging.strad.tadasant.com`.

`render-spec` now always emits `domains`, defaulting from `gateway.publicUrl`.
The gun is still loaded for every other field.

**Undo:** none available — it is how the API works. Verify both custom domains serve
a 200 after every deploy.

### 23. The per-server images still exist, and must

`strad-bundle-api`, `strad-server-good-eggs`, `strad-server-fetchpet`,
`strad-server-pointsyeah`, `strad-server-onepassword`, and
`strad-server-bundle-google` are still built and still pushed to `:latest` on every
relevant change, even though staging deploys only the one collapsed
`ghcr.io/tadasant/strad-bundle`.

They cannot be deleted yet: production, in `tadasant-internal`, still points at them,
and App Platform re-pulls `:latest` on every restart and scale event. Deleting the
images or their release workflows would be an outage, not a cleanup.

**Undo, in order:** re-point prod at `strad-bundle` → confirm it serves → then delete
the per-server release workflows and images.

### 25. The bundle image cannot be rolled back to a published tag

A staging deploy can pin the **core** to any published tag (`-f version=0.1.6`, or
a `sha-<sha>`), because the core image is a render-time argument. The **bundle**
image is written into `infra/strad.staging.yaml`, and the only override —
`--bundle-image` — is passed solely for a branch build. So staging's bundle is
either whatever `strad-bundle:latest` points at, or a branch build. There is no
"the bundle from three commits ago", even though `release-bundle-image.yml`
publishes `:sha-<sha>` for exactly that.

This is a deliberate omission rather than an oversight: the core and the bundle
are meant to move together, and rolling one back alone produces a spec that routes
paths the running bundle no longer serves.

Branch tags also accumulate in GHCR with nothing pruning them.

**Undo:** add a `bundle_version` input that renders
`--bundle-image ghcr.io/tadasant/strad-bundle:<tag>` — the render-side override
already exists.

### 26. The secrets/parameters system is wired but not yet live on GCP

strad has a store-agnostic [secrets and parameters
system](/intro/architecture/#the-secrets-and-parameters-system): Parameter Manager
indexes everything, Secret Manager backs the secret parts, and three deliberately
different credentials touch it — the MCP **viewer** (can't read a secret value), the
console **admin** (reads and writes both kinds, behind SSO), and the deploy-time
**resolver** (injects a `params: true` server's env). All of it is tested against an
in-memory fake, so the logic ships proven.

What is **deferred** is the last of the GCP provisioning: the dedicated
`strad-secrets-staging` project and the viewer and admin service accounts exist, but
the **resolver** service account and the seeded parameter values do not. Until the
resolver exists, a `params: true` supplementary server —
`remote-filesystem-tmp-public` — boots **without** its resolved parameters and
degrades gracefully rather than failing the deploy.

The posture is intact throughout: the resolver credential runs at **deploy time**
(in CI / `render-spec`), never in the container, so "the running container holds no
cloud credential" still holds — the resolved values reach the bundle as ordinary
SECRET env vars, exactly like every other secret.

**Undo:** provision the resolver service account and its key, then set
`REMOTE_FILESYSTEM_TMP_PUBLIC_GCS_CLIENT_EMAIL` (non-secret) and
`REMOTE_FILESYSTEM_TMP_PUBLIC_GCS_PRIVATE_KEY` (secret) in the `/ui/secrets` console. See
`HACKS.md` #26 for the full checklist.

### 27. Runtime secret resolution is implemented but not enabled anywhere

`gateway.secrets.provider: gcp-parameter-store` makes a running gateway resolve
`${NAME}` from the parameter store with a TTL, so a rotation reaches production
with no deploy and the gateway's only secret in the spec is the store credential
itself. It is implemented and
tested end-to-end against the in-memory fake — a real MCP client, through a real
gateway, to an upstream that rejects a stale token — and **no deployment runs it
yet**. Staging and prod both still use `provider: env`, unchanged.

Turning it on needs the resolver service account (#26), the gateway-namespace
parameters seeded, and workflow changes in `tadasant-internal`. It ships off by
default so the capability can land without a flag day.

Three boundaries are by design rather than omission, and
[Secrets](/operate/secrets/) states each one: a `supplementary-image` server's
`env:` is another container's environment and still needs a redeploy to change;
the boot keys are hydrated from the store at startup and so take effect on the
next restart, not within the TTL; and `consoleEnv:` is never hydrated, because
filing the store-admin credential inside the store would let the weaker resolver
credential read the stronger one.

The deploy preflight is a deploy gate and does not make the flip safe: of the boot
keys it counts only the two a deployment cannot work without, so a namespace
missing the optional ones — `GOOGLE_CLIENT_ID` among them, which with
`auth.google.enabled: true` is a front-door outage on `/ui` — deploys green.
[`store:check`](/operate/secrets/#is-the-namespace-complete-store-check) is the
pre-flip counterpart: it counts every name the deployment reads from the store,
names what is absent, and has a report mode for a migration that moves one server
per day.

**Undo:** provision the resolver SA, seed `/strad/prod/gateway/static/*`, flip the
provider in the deployment's config, and drop the per-secret baking from the
deploy workflow.

### 29. The console's secret badges prove presence, not that a credential works

`/ui` lists every configured MCP server and whether the secrets it requires
resolve. What it cannot do is tell you a credential is still _accepted_: strad
never calls an upstream to check, so the good badge is named `READY` ("everything
it needs is present") and never "healthy". A server whose token was revoked
yesterday reads `READY` here and 401s on every call. `GET /api/secrets/readiness`
carries the same limitation into JSON: `ready: true` is a presence claim.

Two mitigations are real but partial. A value that is _evidently_ filler — an
unexpanded `${...}`, a well-known "change-me" string, an empty string — gets its
own `check value` state behind the `ISSUE` badge, which catches the specific shape a
placeholder-bearer-token server has (boots fine, lists fine, 401s in isolation).
And the placeholder list is deliberately narrow, exact-match plus a few
unmistakable substrings: entropy scoring would send someone to rotate a working
secret, and they cannot check without revealing it, so both directions of wrong
are costly.

The second gap is scope. Under `provider: env` a `supplementary-image` server's
`env:` is baked onto its own bundle and never broadcast to core, where the console
renders — so core cannot see it and the popout says `unverified` rather than
guessing. That badges the entry `ISSUE`, because `READY` has to mean observed. That is honest but it is not an answer, and on an `env`-provider
deployment it is the state most servers land in. `provider: gcp-parameter-store`
closes it: the store holds the deploy-time source of truth for those refs too, so
every name gets a real answer. Closing it under `env` would mean the console
reading CI's environment, which it has no path to.

An upstream `initialize` probe per server would close the first gap, at the cost of
a page that makes N authenticated calls to third parties on every load. That is
the trade not yet made.

A third gap is `params: true`. Such a server takes its credentials from
`/strad/<env>/mcp/<slug>/static/*` rather than from `${NAME}` references, and the
page does not read that namespace — so it reports `unverified` and names the
namespace it did not check. That is honest but it is not an answer, and
`remote-filesystem-tmp-public` on staging is exactly that shape. Listing the
namespace through the resolver would close it; `preflightSecrets` already shows
the listing is metadata-only, so nothing about it needs a value-reading credential.

A fourth, smaller edge: the popout's `GSM` / `ENV` source badge uses Zimmer's
Connectors-page labels on purpose, so the two screens can be compared — a
cross-repo coupling with no compile-time link. If Zimmer renames a label, strad's
is silently wrong. `test/ui.secret-status.test.ts` pins both spellings and their
tooltips so the coupling shows up in a diff; nothing can make it automatic from
inside this repo.

**Undo:** delete `src/ui/secret-status.ts` and `src/http/readiness.ts`, drop the
`/secrets` redirect in `src/ui/index.ts`, and revert `src/ui/index-page.ts` to the
plain server grid it renders around. Nothing else reads any of it.

### 30. Secret parameters written before strad granted them access need a manual backfill

A secret parameter's value is reached through `:render`, which dereferences the
`__REF__` **as the parameter's own principal** rather than as the caller. That
principal has to hold `roles/secretmanager.secretAccessor` on the secret, and
`create()` now grants it. Parameters written by an earlier strad have no such
binding, and nothing repairs them: `rotate()` writes a Secret Manager version and
never touches IAM, and there is no reconcile pass. They fail every resolution with
`400 SECRET_REFERENCE_ERROR` until a human runs the backfill loop in
[Secrets IAM](/operate/secrets-iam/#backfilling-parameters-created-before-strad-made-this-grant).
It is idempotent, so running it over a correct store does nothing.

Self-healing was rejected rather than deferred. Repairing from the resolver would
put `secretmanager.secrets.setIamPolicy` in the gateway container — making the one
deliberately read-only credential in the system able to rewrite the access policy of
every secret it reads — and repairing from `rotate()` would add the same permission
to the console's write path for a case that occurs once, while still missing every
parameter nobody rotates.

The sharp part is the diagnosis, not the fix. The failure names neither the
parameter nor the missing binding: the resolver gets a 400 while holding every
permission the message implicates, and a `testIamPermissions` probe of that
credential comes back completely clean. Anything built on such a probe reports
healthy while nothing resolves.

### 31. The console's "write, never read" role can escalate itself to read

Creating a secret parameter requires granting the parameter's own principal
`secretAccessor` on its secret, so the console's credential holds
`secretmanager.secrets.setIamPolicy` at project level. That permission can write
any binding onto any secret in the project — including granting the console's own
service account `roles/secretmanager.secretAccessor`.

So the write-without-read posture is honest about the permissions the role holds
and **is not a boundary**: it is a speed bump and an audit signal. It means no bug,
bad merge or prompt injection reads a secret by accident, and that anyone who does
read one must first take a conspicuous, logged policy-write. It does not mean a
determined holder of that key cannot read production secrets. That matters here
because the key in question is among the credentials whose rotation has been
deliberately deferred.

The fix is an IAM **deny** policy on `versions.access` and `parameterVersions.render`
for that principal — deny is evaluated before allow and cannot be self-granted
around. The command is in
[Secrets IAM](/operate/secrets-iam/#1-prod-console-write-but-never-read); it needs
project IAM admin, which no strad process holds, so it is a human step and is not
applied yet. Removing `setIamPolicy` instead is not an option: it would remove the
console's ability to create a secret parameter at all.

### 3 & 2b. Staging's first deploy came from an agent session, and CI deploys are merge-gated

`strad-staging` was originally created with a hand-rendered spec from a build session
rather than by `deploy-staging.yml`. Separately, `workflow_dispatch` workflows are
only invocable from the default branch, and Secret Manager isn't seeded until
`secrets-sync.yml` has run — so `deploy-staging.yml`
[skips and stays green](/operate/operations/#deploy-stagingyml--put-it-on-app-platform)
on an automatic release without prerequisites, while a manual dispatch fails loudly.

**Undo:** let `release-image.yml` → `deploy-staging.yml` rebuild staging from
`infra/strad.staging.yaml`, and never hand-deploy again.

:::note[HACKS #12 is superseded]
`HACKS.md` #12 describes the `bundle-goodeggs` component being hand-deployed off
DOCR. That component no longer exists — the collapse renders exactly two components,
`core` and `bundle`. The entry is kept in `HACKS.md` for history.
:::

## Supply chain and build

### 10 & 15. The `shared/` trees are vendored, not depended on

`servers/good-eggs/shared/` and `servers/onepassword/shared/` are copied verbatim
from [`pulsemcp/mcp-servers`](https://github.com/pulsemcp/mcp-servers). Only the
`remote/` streamable-HTTP entrypoints are new; the tool logic is reused unchanged.
1Password drags one more thing along: its `@pulsemcp/mcp-elicitation` dependency
isn't published to npm either, so that library is vendored as a third workspace.

**Why:** the upstream packages publish stdio servers, not libraries strad could
depend on. strad's ESLint, Prettier, and TypeScript are scoped away from
`servers/**` so the vendored code keeps its own toolchain.

**Undo:** land shared fixes upstream and re-vendor; longer term, have upstream
publish `shared` and the elicitation library as real packages.

### 11. Playwright is pinned to the base image's Chromium

The browser images build `FROM mcr.microsoft.com/playwright:v1.61.1-noble` and pin
Playwright to `1.61.1` with an `overrides` block, rather than downloading a browser
at build time — `cdn.playwright.dev` was flaky from the build environment, and the
base image's Chromium revision matches 1.61.1 exactly.

**Cost:** the base image is large, and the bundle image lands around 3.9GB, ~85% of
which is that base. **When bumping Playwright,** bump the base image tag and the
`overrides` version together, or the browser revision stops matching.

### 5. GHCR pull tokens are shared with zimmer

Staging uses `GHCR_PULL_TOKEN`; prod reuses zimmer's
`GHCR_PULL_TOKEN_ZIMMER_TADASANT_INTERNAL` — a classic PAT with `read:packages` is
account-wide, so it works.

**Undo:** mint a dedicated `GHCR_PULL_TOKEN_STRAD_TADASANT_INTERNAL`. **Watch:** a
403 on pull means the PAT is fine-grained and strad's package isn't in its scope.

### 8. Deploy-time GCP auth uses a long-lived key

The runtime container holds no cloud credential — that part is the intended design,
not a hack. The debt is that `secrets-sync.yml` and `deploy-staging.yml` authenticate
to GCP with a long-lived `GCP_SA_KEY`.

**Undo:** provision Workload Identity Federation (a pool + provider bound to
`tadasant/strad` and `tadasant/tadasant-internal`) so `google-github-actions/auth@v2`
goes keyless, then delete `GCP_SA_KEY` from both repos.

---

## What the human still needs to provision

The one-time steps that clear most of the list above:

- The secrets/parameters GCP project plus its three service accounts (viewer,
  admin, resolver) and seeded keys, then the `remote-filesystem-tmp-public` values in
  `/ui/secrets` — clears **#25**.
- An OAuth client for `https://strad.tadasant.com/console/oauth/callback`, and its
  `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — clears **#2** and **#20**.
- Re-point prod at the collapsed bundle, then delete the per-server images and
  workflows — clears **#23**.
- Mint a dedicated strad GHCR pull token — clears **#5**.
- Provision Workload Identity Federation, then delete `GCP_SA_KEY` — clears **#8**.
- Stand up a datastore and a console mint/revoke UI — clears **#6**.
