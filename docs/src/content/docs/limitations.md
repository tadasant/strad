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

### 32. The bundle component still deploys a mutable tag

The core image is pinned to an immutable tag on every deploy — `sha-<commit>`, an
explicit `version`, or a branch build — and `render-spec` refuses `latest` for it
outright. The **bundle** gets none of that: its image is
`ghcr.io/tadasant/strad-bundle:latest` on all 24 `supplementary-image` entries in
`infra/strad.staging.yaml`, overridden only by `--bundle-image` on a branch build.

That is the same failure that took staging down — App Platform may serve a mutable
tag from whatever it resolved last — one component over, and nothing refuses it.
It has not bitten yet because `release-bundle-image.yml` moves
`strad-bundle:latest` on every change to `servers/bundle/**`, so the tag is
usually fresh.

The core had an immutable tag to reach for and is already a render-time argument.
The bundle's tag is a config value, so pinning it means editing 24 `image:` lines
per release or adding the `bundle_version` input that **#25** declines to add —
a change to how the bundle is released, not a line in the deploy workflow.

**Undo:** extend the mutable-tag refusal to every image in the rendered spec, and
resolve `sha-<commit>` for the bundle the way the core already does. Do it with
**#25**, which wants the same input for the same reason.

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

A live rehearsal against staging on 2026-07-31 found the flip blocked on two
prerequisites, both now confirmed rather than assumed. Staging holds **no
resolver credential**: `STRAD_PARAMS_PROJECT_ID` and
`STRAD_PARAMS_RESOLVER_SERVICE_ACCOUNT_KEY_JSON` are absent from its
`strad-staging-*` secrets, so `store:check` exits 3 and `render-spec` refuses a
store-backed render. And the flip cannot be partial: `render-spec` stops baking
the boot keys, `STRAD_TOKENS` becomes required in the store, and a JSON array of
token records is the value shape `:render` refuses until the value-encoding fix
(tadasant/strad#61) lands.

**Undo:** land the encoding fix and pin both images, provision the resolver SA and
seed its key, seed `/strad/{env}/gateway/static/*`, confirm with
`store:check --mode require --resolve`, then flip the provider in the deployment's
config and drop the per-secret baking from the deploy workflow.

### 33. One un-renderable parameter makes the whole gateway namespace resolve to nothing

`resolve()` lists a namespace and calls `:render` on every parameter in it,
without catching per parameter. The first failure aborts the whole read, so with
no snapshot yet cached a single malformed parameter is not a degraded name — it
is a gateway that boots with no token store and `/mcp` rejecting everything.

That is deliberate. A resolver that dropped the failing name would hand the
gateway a bag that looks complete, and the absence would surface later as one
failing request against one server — the "worse place to find out" the deploy
preflight exists to avoid. The cost is that the blast radius of one bad value is
the deployment, which matters most while that refusal is unfixed: seeding a single
quote-bearing secret takes the rest of the namespace with it.

Run [`store:check --resolve`](/operate/secrets/#is-the-namespace-complete-store-check)
before a flip; it renders what it found and names anything that did not.

**Undo:** collect per-parameter failures in `resolve()` and throw one error naming
every name that could not render, rather than the first. That keeps the failure
whole while making the diagnosis a single line.

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

The second gap was scope, and it is mostly closed — see
[#35](#35-the-presence-probe-asserts-about-the-process-and-the-process-can-lie-by-being-old).
Under `provider: env` a `supplementary-image` server's `env:` is baked onto its own
bundle and never broadcast to core, where the console renders. Core still cannot
_read_ those values; it asks the component that holds them instead, and the
component answers in presence and never in values. `unverified` survives only
where nothing could answer.

An upstream `initialize` probe per server would close the first gap, at the cost of
a page that makes N authenticated calls to third parties on every load. That is
the trade not yet made, and it is the one that would turn this surface into an
oracle for credential validity.

A fourth, smaller edge: the popout's `GSM` / `ENV` source badge uses Zimmer's
Connectors-page labels on purpose, so the two screens can be compared — a
cross-repo coupling with no compile-time link. If Zimmer renames a label, strad's
is silently wrong. `test/ui.secret-status.test.ts` pins both spellings and their
tooltips so the coupling shows up in a diff; nothing can make it automatic from
inside this repo.

**Undo:** delete `src/ui/secret-status.ts` and `src/http/readiness.ts`, drop the
`/secrets` redirect in `src/ui/index.ts`, and revert `src/ui/index-page.ts` to the
plain server grid it renders around. Nothing else reads any of it.

### 35. The presence probe asserts about the process, and the process can lie by being old

`/ui` and `/api/secrets/readiness` now make a positive claim about a secret that
lives on a component core is not: `POST /_strad/presence` asks each bundle what it
holds, and the bundle answers with one of five words — `absent`, `empty`,
`unexpanded`, `placeholder`, `present` — and nothing else. That is what turned
"this entry could not be checked from the console" into "plumbed, via env, on
`bundle`, established at 09:12".

It is a claim about the **process**, which is the strongest one available and
still not the same as "the deploy is correct". A container that predates the last
render holds the previous deploy's environment: it can report `present` for a
value since rotated, or `absent` for one the last render baked in but that the
running instance never restarted to receive. That is the actual state of the
deployment rather than a bug in the probe, and it is why `bootedAt` and `image`
are in every report and printed on every row. The console shows the divergence; it
does not resolve it.

The designs not taken, so the trade is legible. Deriving from `render-spec` would
be a claim about the last deploy, not the running process — a rollback re-runs an
older spec — so it could say "plumbed" about a process holding nothing. Probing
the upstream would be an oracle by construction, would spend third-party calls on
a page load, and could not tell "credential rejected" from "upstream down".
Reading the deployed spec from the DigitalOcean API would need a new cloud
credential in core and still describe the spec rather than the process.

**It is not an oracle.** The key roster core sends is derived from the config core
is running plus what the component reports under `STRAD_PARAM_KEYS`; no request
parameter reaches a probed name, so no caller can ask strad whether a name of its
choosing exists. The route takes the existing `STRAD_INTERNAL_TOKEN` — strictly
stronger than the surface, so it widens nothing — and fails closed with `503` when
that token is unset.

**It needs an image and a pin bump to become visible.** The core half degrades
gracefully: a component answering `404` is reported `unsupported` with "rebuild
and repin" as the sentence, and its rows fall back to exactly the old
`unverified`. So core ships first and nothing regresses — but nothing on the fleet
actually answers until `ghcr.io/tadasant/strad-bundle` is rebuilt with
`servers/bundle/host` and the deployed config's `image:` pins move to it.

**The `cannot render` diagnosis can lose a race and simply not appear.**
`readStoreDiagnostics` gives its two store reads six seconds together, and the
per-parameter render pass is bounded at a fan-out of ten. A large namespace can
exceed the deadline, and then the diagnosis returns null and the state is not
drawn — the console degrades to the states it had without it, never to a wrong
one. There is no result cache yet, so every `/ui` render and every
`/api/secrets/readiness` call performs the reads afresh.

**Live verification is outstanding.** Every state is constructed in tests,
including over a real socket, and none of it has been exercised against a live
store or a live bundle — staging was down when this landed. A green unit suite is
not the same as having run it, and this repo has shipped a bug of exactly that
shape before.

**Undo:** delete `src/secrets/presence.ts`, `src/secrets/store-diagnostics.ts`,
`src/gateway/bundle-presence.ts`, `src/http/presence.ts`, the vendored copy and
its route in the bundle host, the `STRAD_PARAM_KEYS` env var in `appspec.ts`, and
`resolveDetailed` in `gcp.ts`. The console reverts to the shrug.

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

### 33. Secret values are base64url in Secret Manager, and the encoding is not yet verified against live Google

A secret parameter is created with `parameter-format=JSON`, and `:render` does not
rebuild that JSON — it splices the secret's raw bytes into the payload **text** and
then rejects a result that looks structurally damaged. So a value containing `"`,
`\`, `{`, `}` or a newline comes back `400 INVALID_ARGUMENT … injection detected`,
which is every PEM key, every service-account blob, and a `STRAD_TOKENS` array of
token records.

strad therefore stores every secret value **base64url-encoded** in Secret Manager
and records `"encoding":"base64url"` in the Parameter Manager envelope. Two
consequences an operator sees:

- `gcloud secrets versions access latest --secret=<id>` prints base64url, not the
  value. Pipe it through `base64 -d`. strad's own reads decode it for you; the
  console's reveal, the resolver and the `secrets` MCP `readValue` all return the
  real value.
- An envelope with **no** `encoding` field means the literal bytes, which is what
  every parameter written before this change carries. They keep working untouched;
  see [Secrets](/operate/secrets/#what-a-secret-value-looks-like-in-the-store).

The unverified part is the boundary, not the mechanism. `isRenderSafe` — the
predicate the in-memory double enforces — is a lower bound built from one live
repro (quotes fail) and one live control (the five names seeded in prod, one of
which carries `,` and `=`, render fine). Braces, brackets, backslashes and control
characters are assumed unsafe rather than demonstrated so. The encoding itself does
not depend on that boundary being exactly right, because base64url emits
`[A-Za-z0-9_-]` only. But if Parameter Manager is stricter somewhere we have not
looked, the double is the more permissive of the two, and would say yes where Google
says no.

**Rolling `core` back past this change is the one silent failure.** strad reads the
`encoding` field; an image that predates it does not know the field exists, so it
hands a child process base64url text as its credential and reports success. Every
other failure mode here is loud by construction — this one is not. Re-seed any secret
parameter written after this change before rolling back past it. Boot is deliberately
lenient so a rollback cannot become an outage, which makes rollback a path people
actually take.

**No live `:render` has been run against this change.** Everything is proved against
strad's own double, which now models the failure faithfully — it substitutes
textually and refuses what `isRenderSafe` refuses — but a model is not the API. That
is the same class of evidence gap that let the original bug ship: the previous double
substituted into the parsed object and re-stringified, so it could not fail for any
input, and the identical value that 400s at Google passed every test here.

### 34. A second parameter store costs a second billed component

Staging renders **three** App Platform components, not two. The third,
`bundle-zimmer-secrets`, runs the same bundle image as `bundle` and is only ever
routed `/secrets`. It is there because the secrets server reads
`SECRETS_PROJECT_ID` from `process.env` and the bundle host calls `loadConfig()`
with no argument — one container fronts one store — so a slug pointing at a second
GCP project needs a container of its own. That is roughly $12/month at
`apps-s-1vcpu-1gb`, for a store a human touches a few times a month. The full
reasoning, including why the two cheaper shapes are worse rather than cheaper, is
in [Two stores, one gateway](/operate/secrets/#two-stores-one-gateway).

It also wastes most of the container: the bundle image registers every upstream at
boot (~200MB of Node) though this one serves a single mount, because there is no
build that produces a secrets-only image and adding one would be a second image to
keep current.

An upstream `consoleOnly: true` flag would let a second store be console-only — no
MCP surface, no second container, no cost — and for a store a human manages and no
agent should enumerate that is arguably the right shape rather than merely the
cheaper one. It is not built, and nothing blocks on it.

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
DOCR. That component no longer exists — the collapse renders `core` and `bundle`,
plus `bundle-zimmer-secrets`, which is there for a second parameter store rather
than for a capability. The entry is kept in `HACKS.md` for history.
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
