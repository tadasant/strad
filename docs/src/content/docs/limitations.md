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
offer, which catches upstream renames; CI runs the same predicate against the
booted bundle image before a deploy
([`check-tool-policy`](/operate/deploy-model/#checking-a-tools-policy-against-the-tools-that-exist)),
and `test/staging-config.test.ts` asserts each tier is a subset of the one above
it. None of those makes the boundary physical.

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

### 40. The tool-surface monitor asks one question, so it can only catch one kind of failure

The [tool-surface monitor](/intro/architecture/#adapters) probes every mounted slug
by calling `tools/list`. That is the whole probe: it never asks for resources,
never calls a tool, and never runs two methods against one slug at once. So
`/healthz` answers "is this slug serving tools to a client that only wants tools",
which is narrower than it reads.

It has already been narrower than a real failure. For seven days in prod, the
`secrets` slug answered a lone `tools/list` perfectly and failed `tools/list` for
any client that asked for resources at the same time — one method's failure closed
the shared upstream connection out from under the other. The metric stayed at four
tools, `/healthz` stayed green, and real clients kept getting `-32603`. The alert
that eventually caught it watched the failure _events_, not the monitor.

That teardown bug is fixed and regression-tested. The blind spot is not: a future
failure that only appears when two methods are in flight will again be invisible
here. The channel that did catch it is also quieter now — a tools-only slug no
longer reports a failed `resources/list`, because it is no longer asked — so
`mcp.list_tools_failed` is the half of that pair still watching.

It has also been narrower than a second, plainer failure: a slug can list its tools
perfectly and fail every _call_. Fetch redesigned its login form to floating labels,
the `fetchpet` mount's email selector went stale, and it spent weeks in both
environments listing four tools and returning `Login failed` for every one. Tool
lists are static; a login is not. The bundle's `/healthz` does report a per-mount
`degraded` string for exactly this, and nothing reads it — not the monitor, not the
staging deploy's assertions, not a metric. Every deploy in that window passed, and
the only symptom was a `WARN` line on stdout, a stream that
[reaches nobody](/operate/telemetry/#logs--strads-own-events-and-only-those).

**Undo:** two halves. Give the probe a mixed-method shape — a concurrent
`tools/list` + `resources/list` per slug, with "answers one but not both"
classified as `degraded`; the cost is a second round trip per slug per interval
against containers that already share one CPU (#24). And export the bundle's
per-mount `degraded` as a gauge alongside `strad.mcp.tool_surface`, asserted by the
staging deploy the way the monitor is. The hard half of that second one: "degraded"
means something different per server — a bad refresh token, a missing credential, a
failed login the next call retries — and a signal a deploy can fail on has to say
which.

### 46. The pre-deploy allow-list check knows by hand which mounts it cannot enumerate

[`check-tool-policy`](/operate/deploy-model/#checking-a-tools-policy-against-the-tools-that-exist)
matches every `tools: allow` and `tools: deny` entry against the names the booted
bundle image really serves, so a typo or an upstream rename fails the PR instead
of quietly narrowing a slug's surface in production. It cannot do that for every
slug. A `remote-http` server is not in the image; a mount that shows CI a floor
rather than its whole surface — `secrets` derives its tools from a capability
probe that fails closed with no credential, `GCS_BUCKET` hides four tools from
`gcs`, a browser server's surface follows the app it drives — would look like a
typo if it were checked.

Those mounts are skipped, and which ones they are is a hand-maintained list
(`PARTIAL_SURFACES` in `servers/bundle/scripts/smoke.mjs`). Every skip prints with
its reason on a passing run, so under-coverage is in the log rather than implied
by a green tick — but a mount that becomes credential-dependent and is not added
to the list turns a correct allow-list into a red PR, and the person who hits it
will reasonably think the config is wrong.

The runtime alarm is what covers everything this cannot: `unmatchedAllowEntries()`
emits `mcp.policy_unmatched_tools` on every `tools/list`, after the deploy.

**Undo:** have each mount declare its own surface stability, so the observer reads
it from the bundle host rather than from a list beside it. That is a change to
every tree's factory contract, which is why it is a list.

### 41. The installed console's cached shell is versioned by hand

The console is [installable](/operate/console-pwa/), and its service worker
precaches a fixed shell — the icons, the manifest, and one static offline page —
into a cache named `strad-shell-v1`. Renaming that constant is what evicts the old
cache. Nothing renames it for you, and nothing fails if you forget.

The shell list is interpolated into the worker script, so adding or removing a
path changes the script, re-installs, and re-fetches the whole list. Those edits
are self-healing. The one that is not is a change to a cached _byte_ that leaves
the script identical — the offline page's copy, or an icon: no install fires and
installed browsers keep the old copy. A removed path leaves dead bytes against
the origin's storage quota; it is never served again, because the fetch handler
only reads for pathnames on the current list. `?v=2` does not help — the worker
looks up `url.pathname`, so the search is dropped and a query-stringed URL is
answered from the same entry.

The blast radius is cosmetic by construction: everything in that cache is a brand
asset or a page whose whole content is "the network is gone." Nothing
authenticated is in there to go stale, because nothing authenticated is in there
at all.

**Undo:** derive the cache name from a content hash of the shell rather than a
literal, so any changed byte renames the cache. It was left as a literal because
the shell is four icons, a manifest and a page, and a hash that turns over on
every theme tweak evicts more often than the problem warrants.

### 42. The installed console's sign-in leaves the app window

The console is [installable](/operate/console-pwa/) as a `display: standalone`
app. Open it on an expired session and the gate answers `/ui` with a 302 to
`/console/login`, which redirects on to `accounts.google.com` — outside the app's
scope, so the browser takes the navigation out of the app window and into a tab.
You return through `/console/oauth/callback` and land back on `/ui`.

That is ordinary on Chrome and Android, and it depends on the standalone window
and the browser sharing a cookie jar. **It has not been exercised on iOS**, where
a standalone web app has historically had its own storage partition — which is
exactly the assumption. A session minted in the tab that ran the OAuth trip might
not be the session the app window reads, which would bounce you back to sign-in in
a loop.

None of this is live yet: Google OAuth is not provisioned, so the gate answers
`401` with a sign-in wall rendered in place (#2) and nothing leaves the window.
The two should be tested on the same day.

**Undo:** test it on real iOS Safari when OAuth lands. If the partition does break
it, the fix is to stop redirecting off-origin from a gated navigation — render an
in-scope interstitial that starts the trip from a user gesture, so the return
lands in the window that began it.

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

The config reserves the seat: `auth.staticTokens.store` is a single-value enum
(`env`) that no code reads — the gateway builds the env-backed store from
`auth.staticTokens.enabled` alone. See
[The server-config interface](/servers/interface/#authstatictokens).

**Undo:** implement a DB-backed `TokenStore` — the interface is already the right
shape — plus a `/console` mint/revoke UI, and drop `STRAD_TOKENS`. The `store`
enum grows its second value there. See
[Auth](/auth/overview/#mcp--static-system-tokens-agents).

## The deployment

### 24. Seventeen servers share one process and one CPU

The `bundle` component runs one Node process that mounts seventeen MCP servers and
launches one shared Chromium, on `apps-s-1vcpu-2gb`. A crash in the host takes all
seventeen down together, and Chromium contends with every other server for the single
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

### 25. Branch and `sha-` image tags accumulate in GHCR with nothing pruning them

Every branch deploy pushes `strad:branch-<slug>-<sha>` and
`strad-bundle:branch-<slug>-<sha>`, and every release pushes a `sha-<commit>` for
both images. Nothing deletes any of them. They are cheap and nothing depends on
them, but the list grows without bound.

:::note[HACKS #25 is superseded]
This entry used to be "the bundle image cannot be rolled back to a published tag".
`deploy-staging.yml` takes a `bundle_version` input, and a deploy that does not
set it resolves a `sha-<commit>` bundle tag anyway, so pinning the core alone no
longer hands the bundle back to a tag that moves. The tag-accumulation half is
what remains. The reasoning still holds as advice: the core and the bundle are
meant to move together, and pinning one alone can produce a spec that routes paths
the running bundle does not serve.
:::

### 32. Prod's supplementary components still deploy a mutable tag

Staging is covered: `deploy-staging.yml` resolves `sha-<commit>` for the bundle
exactly as it does for the core, passes it on every deploy, and passes
`--require-immutable-images`, under which `render-spec` refuses to emit a spec
where any component ships a tag that moves.

Prod is not. `strad-deploy-prod.yml` lives in `tadasant-internal`, renders through
this same script, and passes no `--bundle-image` — so its supplementary components
still ship `:latest` and remain exposed to exactly what follows. It gets a warning
naming every affected component on every deploy rather than a failure: failing a
deploy over a tag it has no way to change would break prod without fixing
anything. The change there is to resolve a bundle tag the same way and pass both
flags. It needs no credential and no IAM change.

**Undo:** make that change in `tadasant-internal`.

What the mutable tag did on staging, kept as the record:

The core image had been pinned to an immutable tag on every deploy since #60 —
`sha-<commit>`, an explicit `version`, or a branch build — and `render-spec`
refused `latest` for it outright. The **bundle** got none of that: its image was
`ghcr.io/tadasant/strad-bundle:latest` on all 25 `supplementary-image` entries in
`infra/strad.staging.yaml`, overridden only by `--bundle-image` on a branch build.

That was the same failure that took staging down — App Platform may serve a
mutable tag from whatever it resolved last — one component over, and nothing
refused it.

**It has bitten.** On 2026-07-31 both bundle components were serving an image
that predated the `/secrets` mount by a week, while a fresh `:latest` sat in the
registry and the containers had restarted after it was pushed. Three slugs —
`secrets`, `zimmer-secrets` and `remote-filesystem-tmp-public` — were routed to
paths that image does not mount. The gateway POSTed to `/secrets`, got a 404, and
answered the client `200 {"tools":[]}`; `/healthz` said 200 with all 27 slugs
listed. A secrets server that registers no tools cannot place a secret, and
nothing in the deployment said so.

The core had an immutable tag to reach for and was already a render-time argument.
The bundle's tag is a config value, which is why it took a `--bundle-image` the
deploy always passes rather than editing 27 `image:` lines per release.

**What also detects it:** not the tag, the consequence. Core probes each slug's
`tools/list` on an interval and publishes the slugs serving nothing on
`/healthz`; the staging deploy fails when a component **we deploy** is
unreachable.

**What detection is still worth:** it catches a stale image only when the
staleness changes a **mount**. An image that keeps every path and changes what a
tool does is invisible to it, and the tag is the only thing that can speak for
that — which is why both now exist.

### 26. The per-server parameter namespace is provisioned but unseeded

strad has a store-agnostic [secrets and parameters
system](/intro/architecture/#the-secrets-and-parameters-system): Parameter Manager
indexes everything, Secret Manager backs the secret parts, and three deliberately
different credentials touch it — the MCP **viewer** (can't read a secret value), the
console **admin** (reads and writes both kinds, behind SSO), and the deploy-time
**resolver** (injects a `params: true` server's env). All of it is tested against an
in-memory fake, so the logic ships proven.

What is **deferred** is the values. For staging the provisioning is complete — the
dedicated `strad-secrets-staging` project, the viewer and admin service accounts,
and the **resolver** service account with its key all exist, the last of these
created and proved during the 2026-07-31 rehearsal. But `/strad/staging/mcp/` holds
zero parameters, so a `params: true` supplementary server —
`remote-filesystem-tmp-public` — boots **without** its resolved parameters and
degrades gracefully rather than failing the deploy. The cause is an empty namespace,
not a missing identity, which changes the fix. Prod needs its own resolver; staging
having one says nothing about it.

The posture is intact throughout: the resolver credential runs at **deploy time**
(in CI / `render-spec`), never in the container, so "the running container holds no
cloud credential" still holds — the resolved values reach the bundle as ordinary
SECRET env vars, exactly like every other secret.

**Undo:** set
`REMOTE_FILESYSTEM_TMP_PUBLIC_GCS_CLIENT_EMAIL` (non-secret) and
`REMOTE_FILESYSTEM_TMP_PUBLIC_GCS_PRIVATE_KEY` (secret) in the `/ui/secrets` console. See
`HACKS.md` #26 for the full checklist.

### 27. Runtime secret resolution runs on staging; prod is still on the env provider

`gateway.secrets.provider: gcp-parameter-store` makes a running gateway resolve
`${NAME}` from the parameter store with a TTL, so a rotation reaches production
with no deploy and the gateway's only secret in the spec is the store credential
itself. It is tested end-to-end against the in-memory fake — a real MCP client,
through a real gateway, to an upstream that rejects a stale token — and staging
runs it for real, with the rotation measured against a live gateway rather than a
fake. **Prod still uses `provider: env`, unchanged.**

Turning it on for a deployment needs the resolver service account (#26) and the
gateway-namespace parameters seeded; prod additionally needs workflow changes in
`tadasant-internal`. It ships off by default so the capability can land without a
flag day, and staging is the worked example of switching it on.

Three boundaries are by design rather than omission, and
[Secrets](/operate/secrets/) states each one: a `supplementary-image` server's
`env:` is another container's environment and still needs a redeploy to change;
the core's boot keys are hydrated from the store at startup and so take effect on
the next restart, not within the TTL — and the two a bundle needs are _baked_ onto
a third-party component that cannot hydrate, so those take a redeploy (#38); and
`consoleEnv:` is never hydrated, because filing the store-admin credential inside
the store would let the weaker resolver credential read the stronger one.

What is left rotating within `ttlSeconds` is narrower than "secrets rotate live":
**request-path `${NAME}` references, and nothing else.** A deployment whose config
has no `params: true` server and no `${NAME}` on a server anyone reaches has no
name that rotates without a restart or a deploy, however the TTL is set. Check the
config before promising it; the table is in
[Secrets](/operate/secrets/#what-rotates-live-what-needs-a-restart-and-what-needs-a-redeploy).

The deploy preflight is a deploy gate and does not make the flip safe: of the boot
keys it counts only the two a deployment cannot work without, so a namespace
missing the optional ones — `GOOGLE_CLIENT_ID` among them, which with
`auth.google.enabled: true` is a front-door outage on `/ui` — deploys green.
[`store:check`](/operate/secrets/#is-the-namespace-complete-store-check) is the
pre-flip counterpart: it counts every name the deployment reads from the store,
names what is absent, and has a report mode for a migration that moves one server
per day.

Staging is not one of those deployments. A live rehearsal on 2026-07-31
provisioned the resolver identity, seeded `/strad/staging/gateway/static/`, flipped
`gateway.secrets.provider` and measured the result against a running gateway. An
earlier pass the same day had concluded the flip was blocked on a missing resolver
credential and on `STRAD_TOKENS` being unstorable; both conclusions are retired.
The resolver exists and renders, and the base64url encoding (limitation #33) makes
a token array render like any other value.

What the encoding leaves is an **ordering** requirement, not an impossibility. The
encoder lives in the core image and in the bundle image's write client, so a name
seeded by an image that predates it is written as raw bytes and refuses to render —
and rolling `core` back past it turns everything seeded after it into gibberish. Pin
both images before seeding one name.

Prod has not flipped. The order it must follow, and the three properties staging
measured, are in
[Migrating](/operate/secrets/#staging-ran-all-four-steps-and-the-property-holds).

**Undo:** pin both images at or after the encoding change, provision the resolver
SA and seed its key, seed `/strad/{env}/gateway/static/*`, confirm with
`store:check --mode require --resolve`, then flip the provider in the deployment's
config and drop the per-secret baking from the deploy workflow.

### 38. A third-party bundle cannot read the store, so its boot env is baked and rotating it is a deploy

Hydration is what lets a store-backed spec stop carrying the gateway's boot keys,
and it runs in strad's own process: the core, and a bundle component running the
strad image. A `supplementary-image` component runs a **third-party image**. It
never executes strad's code and it holds no store credential — that key reaches
the strad image and stops there, deliberately, so one env-dumping tool in one
vendored server is not worth the whole gateway namespace.

That gap shipped once. Prod's parameter-store cutover rendered a spec in which the
bundle had neither `OTEL_EXPORTER_OTLP_HEADERS` baked nor any way to fetch it; the
component answering every supplementary slug stopped exporting telemetry 44
seconds after a deploy that reported success, with `/healthz` at 200, every slug
listed and nothing user-visible broken. The cutover was rolled back.

The fix is to bake those two names — `STRAD_INTERNAL_TOKEN` and
`OTEL_EXPORTER_OTLP_HEADERS` — from the **store** onto the components that cannot
fetch them. Three checks then guard it, and they answer different questions:
preflight asks whether the store **holds** a required name; a second check fails
the deploy when a required boot key **resolves to nothing**, which presence
cannot see; and `bootEnvGaps()` fails it when a component in the rendered spec
holds neither a boot key it needs nor the credential to fetch it. The OTLP header
is not on the required list — an ingestor that needs no auth is ordinary — so an
endpoint with no resolvable header is a warning naming the parameter. What that costs, stated rather than
hidden: rotating either name is a **redeploy**, not a restart, and rotating
`STRAD_INTERNAL_TOKEN` must be a redeploy even for core, since core hydrates it
and a restart of core alone would leave the two sides disagreeing and the presence
route answering 401.

The alternative — give every bundle the resolver credential so hydration works as
the comment claimed — was rejected twice over: it widens a store-reading credential
to every third-party image, and it would not work anyway, because nothing in those
images knows how to ask.

**Undo:** a supplementary server that needs live rotation reads the store itself,
the way `servers/secrets` does. Nothing else removes the redeploy.

### 36. One un-renderable parameter makes the whole gateway namespace resolve to nothing

`resolve()` lists a namespace and calls `:render` on every parameter in it. Any
hard render failure fails the whole read, so with no snapshot yet cached a
single malformed parameter is not a degraded name — it is a gateway that boots
with no token store and `/mcp` rejecting everything.

That is deliberate. A resolver that dropped the failing name would hand the
gateway a bag that looks complete, and the absence would surface later as one
failing request against one server — the "worse place to find out" the deploy
preflight exists to avoid. The cost is that the blast radius of one bad value is
the deployment.

**The base64url encoding (limitation #33) does not fix this.** It stops values
_becoming_ un-renderable; this entry is about what the read path does when one
is, and there are still two live ways to get one: a parameter written before
strad granted it access to its own secret (#30) renders
`400 SECRET_REFERENCE_ERROR` until backfilled, and a parameter written by an
image predating the encoding, read by one following it, is refused by the
round-trip guard by design. Either, anywhere in the gateway namespace, takes the
whole namespace with it.

Run [`store:check --resolve`](/operate/secrets/#is-the-namespace-complete-store-check)
before a flip; it renders what it found and names anything that did not.

`scripts/seed-store.ts` takes `--only NAME` and `--exclude NAME`, so a seeding run
can be scoped around a name rather than seeding it and then deleting it back out.
That narrows what is written and deliberately not the read-back, which still
resolves the whole namespace. It is a way to work around this entry, not a fix for
it — neither way of getting an un-renderable parameter is caused by seeding too
much.

**Diagnostic behavior:** `resolve()` still fails the namespace when any hard
render fails, but the error names every name that could not render, with
value-free reasons. That keeps the failure whole while making the diagnosis a
single line.

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
one.

**The diagnosis is up to a minute old, and says so.** The result is cached for
`gateway.secrets.ttlSeconds`, capped at 60s, so a `/ui` reload and a hard poller
on `/api/secrets/readiness` cost one store pass per minute rather than one per
request. The cost of that is freshness: a value written by anything other than
this console can take up to a minute to change a row, and a store that breaks can
look healthy for up to a minute. So the age is printed rather than hidden — the
console says when it read the store, and the readiness JSON carries
`store.diagnosis.ageSeconds` — and a write through the console drops the cache,
so a rotation is not contradicted by the row it was performed from. A pass whose
index or render half did not answer is held for five seconds only, because a
shrug cached for a minute would extend an outage; a namespace-wide render
**refusal** is not that case — it is a complete answer produced by the expensive
full pass, and it is cached for the whole TTL.

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

### 33. Secret values are base64url in Secret Manager, and only the boundary is unverified

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

The same silence would apply across **trees** rather than across time — the
`secrets` MCP server is a separate npm project that writes to the same store, so its
copy of the encoding could lose the field or fold a path into a different resource id
and both halves would keep answering. That copy is vendored and checked: it is
generated from one source by `npm run wire:sync`, and CI fails if it drifts or if
that tree grows a second implementation beside it. Rollback is not covered by any of
that, because an old image carries an old copy of both halves.

**A live `:render` has been run against this change.** The staging
runtime-secrets rehearsal seeded `STRAD_TOKENS` — the array of token records that
motivated the encoding, carrying `"`, `[`, `]`, `{` and `}` — as a secret parameter
in `strad-secrets-staging`, and it renders. The roster reports `render: 5 of 5
present name(s) resolved to a value`, and the gateway proves it end to end: under
`provider: gcp-parameter-store` the boot keys are not baked into the app spec, so
the only `STRAD_TOKENS` the staging gateway has is the one it renders from the
store — and `/mcp` authenticates against it. That closes the evidence gap that let
the original bug ship, where a double substituting into the parsed object could not
fail for any input.

What is still unverified is the boundary above, not the mechanism.

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

### 52. Two servers on one bundle still cannot hold two values for one name

A supplementary server's `env:` `${NAME}` resolves from
`/strad/{env}/mcp/{slug}/static/` before the shared
`/strad/{env}/gateway/static/`, so two servers can be given **different** values
for one name — as long as they sit on different bundles. Two servers that share a
bundle share a container, and a container has one `process.env`. `render-spec`
fails the deploy when their namespaces disagree rather than picking a winner, and
names both slugs and the key (never the values).

That is a deployment decision rather than a renderer bug: the shared-bundle case
is the capability-variant pattern — `telegram-ro` and `telegram-rw` are one mount,
one upstream process, told apart by the gateway's `tools:` policy — and they share
a container _because_ they share a credential. Two values means two components,
which is a second billed App Platform service for a process that is otherwise
identical.

It also costs store round trips. `list()` enumerates every managed parameter in
the project and filters by prefix, and `resolve()` calls it again — so a render
pays one extra enumeration for the `/strad/{env}/mcp/` listing, plus one per slug
that turns out to need a value (those run concurrently). A store with nothing
seeded per-server pays only the first.

Two smaller edges travel with it. The failure lands at **render** time, not at
`check-config` time: that gate holds no store credential, so it cannot know that
two identical `${NAME}` strings resolve differently. And substitution covers a
`supplementary-image`'s `env:` only — a `builtin`'s `options:` and a
`remote-http`'s `url`/`headers` are resolved in-process at runtime, out of the
gateway namespace, with `params: true` as their per-server path.

### 2b. A deploy without its prerequisites skips and stays green

`workflow_dispatch` workflows are only invocable from the default branch, and
`deploy-staging.yml` has nothing to inject until `secrets-sync.yml` has seeded
Secret Manager. An automatic deploy missing either
[skips and stays green](/operate/operations/#deploy-stagingyml--put-it-on-app-platform)
— zimmer's "safe no-op without the secret" idiom — while a manual dispatch fails
loudly.

**Undo:** run `secrets-sync.yml` for the deployment. The skip is the guard for one
that has not been seeded, not a defect in one that has.

:::note[HACKS #3 is resolved]
`HACKS.md` #3 records that `strad-staging` was first created with a hand-rendered
spec from a build session rather than by `deploy-staging.yml`. That workflow
rebuilds staging from `infra/strad.staging.yaml` on a ghcr image, and nothing
hand-deploys it. The entry is kept in `HACKS.md` for history.
:::

:::note[HACKS #12 is superseded]
`HACKS.md` #12 describes the `bundle-goodeggs` component being hand-deployed off
DOCR. That component no longer exists — the collapse renders `core` and `bundle`,
plus `bundle-zimmer-secrets`, which is there for a second parameter store rather
than for a capability. The entry is kept in `HACKS.md` for history.
:::

### 47. Deploys from two repos share one machine, and coordinate only by not colliding

strad's CI runs on **self-hosted** runners, which means several runner
_processes_ share one machine — and therefore share `/tmp`. This repo's staging
deploy rendered its App Platform spec to `/tmp/spec.json`; so does the prod
deploy that lives in a separate private repo. Nothing coordinated the two.

On 2026-08-06 they overlapped on the same box. Prod's render opened
`/tmp/spec.json` for writing at `11:29:38.75`, truncating the staging spec that
had been complete since `11:29:37.57`. Staging's `doctl apps update` read the
empty file at `11:29:40.05`; prod finished writing at `11:29:40.78`. The staging
deploy failed with

```
400 error validating app spec field ".name": .name in body is required
```

which reads as a renderer bug and was not one — that render was byte-identical to
the deploy that had gone green the day before. `doctl` is silent about this
because an empty document is valid YAML `null`, decodes into a spec with no
fields, and gets sent.

**Fixed on strad's side, twice over.** The spec is rendered into `$RUNNER_TEMP`,
which is per runner installation and emptied between jobs, so no other job can
name it; and it is asserted before every `doctl` call that reads it — it must
parse, carry a non-empty top-level `name`, have components, and **name the app
this job set out to deploy**. The collision needs both writers to agree on a path,
so moving one side ends it.

**Still true, and not only for the spec.** The condition that made this possible
is unchanged: these are long-lived shared runners, and any job on them can still
claim any fixed name — a path, a container, a host port, an image tag. Two known
instances remain open. The prod deploy has not moved off `/tmp/spec.json`
([#115](https://github.com/tadasant/strad/issues/115)). And `ci.yml` builds and
runs its containers under fixed names and fixed image tags on a shared docker
daemon ([#117](https://github.com/tadasant/strad/issues/117)) — where the tag is
the dangerous half, because a concurrent job rebuilding `strad:ci` lets the
"`/mcp` with no token returns 401" assertion pass against an image the PR did not
build. The durable fix for the class is ephemeral runners.

**Why the name check, and not just "has a name."** One second later on the clock
and staging's `doctl` would have read prod's _complete_ 91302-byte spec — valid,
naming `strad-prod`, carrying prod's images and prod's secrets — and replaced the
staging app with it. That deploy would have gone green.

### 37. Exported logs are an allowlist, so most of stdout reaches no ingestor

strad ships its own structured events as OTLP logs, against a per-event field
allowlist. It does not ship the stdout stream — that carries upstream-authored
text, and the whole point is to keep it out of an external ingestor.

Three consequences worth knowing before you go looking for something and do not
find it:

- **`mcp.auth_failed` is not exported.** It fires before authentication
  succeeds, so anyone who can POST `/mcp` could fill the batch queue and evict
  the signals that matter. `strad.mcp.auth_failures` counts the same thing by the
  same `reason`; the per-request detail is on stderr only.
- **A repeated fault is under-reported by up to a minute.** Every exportable
  event a client can drive is throttled to one record per slug per minute. The
  first occurrence always ships, and `strad.mcp.tool_surface` carries the same
  fact continuously.
- **An upstream's error message is never in the ingestor.** `error` is on no
  allowlist; the classification ships instead. Finding out _what_ an upstream
  said means reading the container console.

The alternative was the status quo, which cost a week of a production `secrets`
slug serving nothing while writing `mcp.list_tools_failed` on every request. See
[Telemetry](/operate/telemetry/#logs--strads-own-events-and-only-those).

### 39. A crash report carries free text, and the filter in front of it is heuristic

`SENTRY_DSN` turns on exception reporting into GlitchTip. It is the one channel
in strad that ships text strad did not fully author — an exception message and a
stack trace. Everything else ships shape and closed-set words.

The filter has two halves. The first is exact: every credential-shaped env var the
process holds, and the string leaves of a JSON one like `STRAD_TOKENS`, is struck
out **by value**. The second is **by shape** — PEM blocks, JWTs, `Bearer` lines,
URL userinfo, `secret-ish-key = value` pairs — and a shape rule only catches
shapes somebody thought of. A credential strad does not hold itself, in a form
none of those rules match, could reach the ingestor inside a message.

What bounds it: the event is rebuilt from a key allowlist, so `request`, `user`,
`extra`, `breadcrumbs`, stack-frame local variables and source context never
travel; and the reporter never captures the `event()` fault path, which is where
upstream-authored text actually lives. Unset `SENTRY_DSN` — the default — and none
of this runs. See
[Telemetry](/operate/telemetry/#exception-reporting--glitchtip-over-the-sentry-protocol).

## Links and artifacts

### 43. A link longer than seven days is signed with GCS's legacy V2 process

The [artifact store](/servers/artifact-store/) returns a **14-day** signed URL by
default. GCS's **V4** signing process caps expiry at seven days (604800s) — Google
enforces it and the Node SDK throws rather than clamps — so fourteen days is not
reachable with V4 at all. It is reachable with **V2**, the older process, which has
no cap: verified against a real bucket, 14-day and 365-day V2 URLs both serve `200`
anonymously.

So the server picks by duration: V4 at seven days or less, V2 beyond it, and the
response says which in `signing_version`.

**The exposure.** Google recommends V4 and calls V2 legacy. If V2 is retired, every
link longer than seven days stops being mintable and `upload_file` / `refresh_link`
start failing loudly for those durations — the error names the cap and tells the
caller to ask for seven days or fewer. Links already issued are unaffected.

**Why not just ship seven days.** The default was chosen for the human, not the
API: an artifact is usually looked at days after it is made, and a dead link is the
failure the server exists to avoid. The exposure is bounded by `refresh_link`,
which exists for precisely this — a dead link is one tool call away from being
alive again.

**What is deliberately not done.** No silent downgrade. A 14-day request never
quietly becomes a 7-day link; nothing would surface that until the link was already
stale in someone's inbox.

### 48. A restricted link opens as the reader's default Google account

`is_sensitive: true` grants `domain-<viewer>` READER on the object and returns a
`storage.cloud.google.com` URL. That host is cookie-authenticated, and a bare URL
resolves against **one** of the reader's signed-in Google accounts — the browser
profile's default, usually a personal address that is not in the granted domain.
Google answers `403`.

Nothing distinguishes that from a real permission failure. The ACL is correct, the
URL is correct, and the reader is signed in to an account that would open it; the
`403` is byte-identical to "you were never granted access", so it reads as a broken
grant.

Setting `_SENSITIVE_VIEWER_ACCOUNT` makes restricted links carry Google's account
selector, `?authuser=<address>`, and they then open against that account whichever
one is default. The account is a **hint, not a grant** — the `domain-` ACL still
authorises the whole domain — so the two can drift, and naming a departed employee
sends every reader to an account nobody is signed in to. Validation catches an
address that is malformed or outside the viewer domain — when the store is first
built, since config is read lazily, so a bad value fails every tool rather than
one link. It cannot catch an address that is merely wrong.

**Why it is not derived.** The server never learns who the reader is: an MCP call
carries the agent's identity, not the human's, and the link is minted before anyone
opens it.

**Why it is not always emitted.** With no configured account the bare URL is
returned rather than a guess — an `authuser` naming an account the reader is not
signed in to bounces them to a sign-in page, which is worse than the `403` for
anyone whose default account was already right. Either way, every restricted
response carries a `sign_in_hint` field saying what to tell a human whose link
`403`s.

**What is verified.** Against the live bucket: the grant lands and reads back, the
bare URL `302`s to Google sign-in, and `?authuser=` is accepted by that endpoint
and echoed back decoded. The last step — that a signed-in multi-account browser
then renders the object instead of `403`ing — needs a real Workspace session and
has not been confirmed. Strongly evidenced, not proven.

**Two further ways the hint and the grant disagree.** `restricted` is read off the
object's ACL, not off this deployment's config, so an object granted to some other
`domain-` still gets this deployment's `authuser` appended. And the domain check is
an exact match, so a Workspace alias or subdomain address
(`dana@mail.example.com` under `example.com`) is rejected outright.

### `set_sensitivity` cannot recall a link that is already out there

A signed URL is valid until it expires, independently of the object's ACL.
Marking an artifact sensitive after the fact stops _new_ readers and stops new
signed links being minted — it does not revoke one already pasted into a message.
`delete_file` is the only true revoke, and the tool descriptions say so rather than
implying otherwise.

There is a second layer to this, measured rather than assumed: **an object that was
ever world-readable keeps being served from Google's edge cache for up to an hour
after it is restricted.** A cache-busting query string returns the true `403`
immediately; the bare URL keeps serving the cached bytes. The artifact store never
creates a public object, so this is bounded to objects made public before it
existed — but restricting one of those means "no new readers", not "no readers".

### `upload_file` reads from the bundle container's filesystem

The artifact store takes a `file://` URI, and it runs in the bundle — a container
that also holds sixteen other servers' credentials in its environment, one of them
a session string that IS a Telegram account. An agent that can call `upload_file`
can therefore ask it to read a local path and publish a link to whatever came
back.

Paths under `/proc`, `/sys`, `/dev`, `/app`, `/root` and `/etc` are refused, which
closes the obvious one (`file:///proc/self/environ` returns every secret in the
bundle in a single call). That is a denylist, not a sandbox: the real boundary is
that reaching this tool at all requires a token entitled to the slug. A confined
upload directory would be the stronger answer and is not implemented.

## Supply chain and build

### 10, 15 & 45. The `shared/` trees are vendored, not depended on

`servers/good-eggs/shared/`, `servers/fetchpet/shared/` and
`servers/onepassword/shared/` are copied from
[`pulsemcp/mcp-servers`](https://github.com/pulsemcp/mcp-servers). Mostly the
`remote/` streamable-HTTP entrypoints are the only new code and the tool logic is
reused unchanged. 1Password drags one more thing along: its
`@pulsemcp/mcp-elicitation` dependency isn't published to npm either, so that
library is vendored as a third workspace.

The copies have since taken strad-local edits, and every one of them is a thing
the upstream stdio server cannot know about: the shared-browser seam
(`setSharedBrowserProvider`) that gives three servers one Chromium, browser
telemetry, and — in `fetchpet` — login selectors that match the form Fetch serves
today plus a login that retries instead of caching its first failure. Each tree's
README lists its deltas. The debt is real: a re-vendor is a merge, not a copy.

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

### 51. Every image push is tried three times, and cannot tell a flake from a regression

ghcr sometimes answers a blob `HEAD` with `403 Forbidden` in the middle of an
otherwise healthy push, on credentials that worked seconds earlier. It turned
`main` red on 2026-08-11: the bundle built, the layers exported, the pull/push
token was issued, and nine seconds into `pushing layers` one blob came back 403.
The same commit, re-run unchanged, pushed fine. So `.github/actions/build-push`
runs the identical build up to three times, 15s and 45s apart, and every push to
ghcr in this repo goes through it.

It cannot see why the step failed — a broken `Dockerfile` and a refused blob look
the same from outside `docker/build-push-action`. A retry after a refused push
costs seconds, because the layers are cached; a retry after a failed build costs
a rebuild, because buildkit does not cache a failed layer. So a broken bundle
build runs three times, minutes of it, before the run goes red — and a real
permission change (visibility flipped, linked repo dropped, `packages: write`
removed) is retried twice before it goes red.

The wrapper declares only the seven inputs its call sites pass, and a `with:` key
it does not declare is dropped with a warning rather than an error. `builder:` is
the one it refuses to run without — see #53.

**Undo:** point the call sites back at `docker/build-push-action@v6` and delete
the wrapper. **Watch:** three `build/push attempt N failed` warnings carrying the
same 403 mean the registry is refusing, not flaking — check the package's settings
rather than re-running.

### 53. The buildx builder is a box-wide name, and nothing in a workflow says so

**Resolved.** The condition that made it possible — one docker daemon, one
`$HOME`, several concurrent runner processes — is unchanged, so it is written
down here.

`docker/setup-buildx-action` defaults to `use: true`, which means `docker buildx
create --use`, which writes `~/.docker/buildx/current`. Every job on a
self-hosted box runs as the same user, so there is exactly one of those files for
the whole machine, and a `docker buildx build` with no `--builder` reads it. The
builder each job creates has a uuid name and never collides — which is what made
this invisible. The shared thing was the pointer, not the builder.

On 2026-08-11 it took `main` red in the `bundle_image` job alone, with every
other job green and no assertion of ours having run:

| Time (UTC) | What                                                                  |
| ---------- | --------------------------------------------------------------------- |
| `10:36:11` | `Release image` creates its builder `--use` — it now owns the pointer |
| `10:36:23` | `bundle_image` starts its build with no `--builder`, so on that one   |
| `10:36:44` | `Release image` finishes and removes the builder                      |
| `10:36:54` | `bundle_image` dies: `received prior goaway … "graceful_stop"`        |

The removal took 10.6 seconds; `bundle_image`'s own unused builder came off in
0.26. One buildkit was busy, and it was not the one that job created.

The failure lands on a random job at a random step, names buildkit's transport
rather than anything in this repo, and passes on re-run — the exact shape of an
infrastructure flake. The quieter half never even goes red: a build that lands on
another job's builder and is not killed simply succeeds there, against a
different cache, and nothing reports it.

**Fixed on both sides.** No job writes the pointer (`use: false`), and every one
of the fourteen build steps names its own job's builder. `.github/actions/build-push`
takes it as an input and refuses to build without one, because an omitted input
interpolates to the empty string and reads as "no `--builder`".
`test/workflow-buildx-builder.test.ts` fails the PR that drops either half.

**One thing that fix exposed, the expensive way.** The `actionlint` step that
gates every PR validates a local action's interface — not the shell inside it,
and not its prose. Nothing else in a PR build loads that action either, since the
steps using it run only on `main` (#51). So the file is unlinted where it
matters, and there is no backslash escape for the expression delimiter: the
runner template-parses the WHOLE manifest when it loads it, so an expression
written anywhere in it as an example is evaluated.

The first version of this fix avoided that in the guard's shell message and then
walked into it one field over, putting `steps.<id>.outputs.name` — as a live
expression — in the `builder` input's `description:`, to document what to pass. A
description has no `steps` context, so the manifest failed validation, the action
failed to load, and all eight release workflows died on the same
commit, before a single build ran. actionlint was green on it.
`test/workflow-buildx-builder.test.ts` asserts all three spellings of the rule:
no `\${{` in a shell step, no `${{` in the `name:` or `description:` of any local
action manifest, and no `inputs.*.default` reaching for `steps`, `needs` or
`job`. An action's `outputs.*.value` is exempt — that is a genuine deferred
expression context — and so is an ordinary `inputs.*.default`.

**No retry was added.** With an explicit builder nothing on the box can reach
this job's, so there is no transport failure left to retry — and a retry would
cost what #51 costs, three full bundle builds for a genuinely broken
`Dockerfile`.

### 54. A bundle build that fails blocks every later deploy, not just its own

The staging deploy ships the bundle as `sha-<commit>`, resolved by walking
first-parent history for the newest commit that published one. A commit inside
`release-bundle-image.yml`'s `paths:` filter is required to have published, so
the walk stops there — with an error, if no image exists. Walking past it would
deploy an older bundle against this commit's config, which is the outage in #33's
clothing.

That stop is not confined to the deploy that first hits it. Most commits touch no
baked tree, so the walk steps past them and arrives at the same broken ancestor
on every later merge. **One failed bundle build wedges `main` until some commit
publishes a bundle image again.**

It happened the same day as #53 and because of it. The bundle release for #127's
commit died loading the broken action manifest; #129 fixed the manifest but
touched no baked tree, so it published nothing either. `Release image` on `main`
then failed at "Resolve an immutable bundle image tag" after 16m51s, having
waited the full 900-second budget for an image whose build had failed fourteen
minutes before the deploy started.

**What the step does about it.** It asks the Actions API whether the run that
owes the image is still going. A run that has concluded without success ends the
wait immediately and names itself; a run still queued or in flight is what the
wait is for. The lookup needs `actions: read`, and a workflow that calls
`deploy-staging.yml` must grant it too — a called workflow may narrow its
caller's permissions, never widen them. Without it the step waits out its full
budget and cannot say which of the two happened.

**What it does not do.** Weaken the hard stop. There is no fallback to an older
bundle, and the recovery is a human publishing an image: re-run the failed build,
or — when the failure is IN that commit, so a re-run only rebuilds it — dispatch
`release-bundle-image.yml` on `main`, which publishes `sha-<HEAD>` and ends the
walk before it reaches the stuck commit.

### 49. The Telegram MTProto library is archived upstream

`servers/telegram` speaks MTProto through `telegram` (GramJS), whose last release
was February 2025 and whose npm page now points at
[`teleproto`](https://www.npmjs.com/package/teleproto) — a maintained fork of the
same code, API-compatible, reading the same session strings.

**Why the archived one:** GramJS is what the session string is minted by, and
every instruction a human follows to produce that credential is written against
it. Swapping the library that holds a credential equivalent to a whole Telegram
account is a deliberate decision, not one to inherit from an npm warning.

**Cost:** Telegram raises its TL layer regularly and an archived client will
eventually meet a constructor it does not know. The calls this server makes
(history, search, send, dialogs) are among the protocol's oldest and most stable,
so the likely failure is one unparsed field rather than a dead mount — and
nothing in CI would catch it, because CI holds no Telegram credential.

**Undo:** `createMtprotoClient` in `servers/telegram/shared/src/mtproto.ts` is the
only function that imports the library. Everything above it drives a structural
interface the tests implement directly, so the swap is that function, its imports
and one dependency line — no session re-mint, no change to any tool.

### 50. The telegram slugs ship disabled until their secrets are seeded

`telegram-ro` and `telegram-rw` sit in `infra/strad.staging.yaml` with
`enabled: false`. The mount is in the bundle image and the process registers it
either way — the bundle's own internal `/healthz` lists it, degraded — but no slug
routes to it.

**Why:** `render-spec` resolves every `${NAME}` from GCP Secret Manager and fails
the deploy on one it cannot find, deliberately. A server whose credentials do not
exist yet therefore cannot ship enabled; `enabled: false` is skipped at render, so
the three unseeded refs cost nothing.

**Cost:** a disabled server is invisible where anyone would look — absent from the
gateway's `/healthz` and from the console, and `?servers=telegram-ro` is a 424.
Only the bundle's internal health route, which nothing outside the app can reach,
shows the mount at all.

**Undo:** seed `strad-staging-TELEGRAM_API_ID`, `-TELEGRAM_API_HASH` and
`-TELEGRAM_STRING_SESSION` via `secrets-sync.yml`, then delete the two `enabled:`
lines.

---

## What the human still needs to provision

The one-time steps that clear most of the list above:

- The per-server parameter values. Staging's secrets/parameters GCP project, its
  three service accounts (viewer, admin, resolver) and their seeded keys are
  provisioned; `/strad/staging/mcp/` holds nothing, so set the
  `remote-filesystem-tmp-public` values in `/ui/secrets` — clears **#26**. Prod
  needs the whole set of its own.
- An OAuth client for `https://strad.tadasant.com/console/oauth/callback`, and its
  `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — clears **#2** and **#20**.
- Delete the DigitalOcean Container Registry named `strad`. Staging and prod pull
  ghcr images; the registry the first deploy used is left over, and bills while it
  sits there.
- Re-point prod at the collapsed bundle, then delete the per-server images and
  workflows — clears **#23**.
- Mint a dedicated strad GHCR pull token — clears **#5**.
- Provision Workload Identity Federation, then delete `GCP_SA_KEY` — clears **#8**.
- Stand up a datastore and a console mint/revoke UI — clears **#6**.
