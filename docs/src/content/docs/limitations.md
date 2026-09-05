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

It happened again, in prod, on 2026-08-28: `good-eggs` listed its tools while
every authenticated call returned `Login failed: page.waitForURL: Timeout 30000ms
exceeded`. The login was fixed; the blind spot that let it run unseen was not.

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

### 60. A local-tunnel that is not answering answers with a tool about itself

[`local-tunnel`](/servers/interface/#2-local-tunnel) is the one kind exempt from
the rule that a server **named** in `?servers=` fails the whole listing when its
upstream cannot be listed. Instead of failing, and instead of dropping out, the
slug keeps its place and serves one tool that is not its own —
`<slug>__troubleshoot_host`, which names the machine, the failure and the
commands to bring it back. The only other record is a `mcp.local_machine_offline`
event, exported at Info because nothing failed.

So a listing contains a tool the upstream never offered: a gateway inventing tool
surface, which a proxy should be reluctant to do. That is the cost.

**Why anyway:** MCP has no in-band way to say "part of your selection is
unavailable right now" in a successful `tools/list` — a `_meta` field on the
result would be the place, and no client reads one. Every alternative is worse. A
shorter list says nothing, so a client that sees no `anki__*` and concludes "Anki
has no tools" is drawing a wrong conclusion from a correct response. An error
takes the healthy servers named beside it down. An empty list is
indistinguishable from a server that genuinely has none. A tool is the one
channel every client already renders.

The console extends the same bet one step. `/playground/<slug>` cannot classify
by error — its MCP session runs over an in-memory transport, so an adapter's
error reaches it as a message with no class — so it infers "this host is
unavailable" from the surface it can see: this kind, exactly one tool, and the
tool is `<slug>__troubleshoot_host`. A healthy local-tunnel whose upstream serves
exactly one tool of that name is therefore described as unavailable on that page.
The mitigation is the name, and the cost is one page's wording — nothing `/mcp`
serves changes.

It is bounded: it is **listed** only while the host is unavailable, takes no
arguments, reaches nothing but that slug's own upstream, and returns only text
strad and the operator wrote. It is exempt from the [`tools:`
policy](/intro/concepts/#capability) on purpose — an `allow:` list written for
the real toolset would otherwise filter away the one tool explaining the outage.

Two consequences of that, both deliberate. It is **answerable** on a
`local-tunnel` slug at any time rather than only while the host is down, which is
what lets somebody who has just run the commands ask again and be told the
machine is back. And because strad answers it rather than forwarding it, it
permanently **shadows** an upstream tool of the same name on a `local-tunnel`
slug: such a tool is unreachable through strad, and the caller gets strad's
answer rather than an error. The name is specific enough that no MCP server on a
laptop is likely to have chosen it, which is the whole mitigation.

On `/healthz` such a slug reads `offline` rather than `unreachable` and stays
out of `degraded`: a machine somebody switched off is this kind's normal state,
the slug is still connectable, and filing it beside a bundle that will not start
meant a fleet with one sleeping laptop never read as healthy. A host that
**refuses** still counts as degraded — it is answering, and a stale credential
will not clear on its own.

The exemption is as narrow as the offline verdict, and that verdict is not
perfectly sharp: a `502` from the tunnel edge is what you get both when the
machine is off and when the machine is **up** and the MCP server process on it
has died. The second case therefore drops out of `degraded` too, and its
remedy text tells its owner to wake a machine that is already awake. That
ambiguity is inherent — the edge answers on the origin's behalf and says the
same thing either way — and it is the one way a broken thing goes unreported
here.

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

### 64. A Google Sheets credential is minted by a human, and expires in 7 days in testing mode

[Google Sheets](/servers/google-sheets/) is the one bundled server that
authenticates as a **person** — an OAuth refresh token for one Google account —
rather than as a service account with domain-wide delegation. That is what lets it
serve a consumer `gmail.com` account, which delegation cannot reach, and it makes
each slug's credential the narrowest one available.

The cost is lifecycle. strad cannot mint a refresh token, cannot replace a revoked
one, and cannot see one expiring. While the OAuth app is in **testing** mode —
which is what whitelisting a few accounts as test users means — Google expires
refresh tokens after **seven days**; every call then fails `invalid_grant` until a
human re-consents and re-seeds the value. The error says so in as many words, but
nothing warns beforehand. Publishing the OAuth app removes the expiry.

## The deployment

### 24. Twenty-one servers share one process and one CPU

The `bundle` component runs one Node process that mounts twenty-one MCP servers,
launches one shared Chromium and supervises one `mcp-grafana` child process, on
`apps-s-1vcpu-2gb`. A crash in the host takes all twenty-one down together, and
Chromium contends with every other server for the single vCPU.

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
deploy always passes rather than editing 28 `image:` lines per release.

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

### 69. A namespace is not addressable, so reading one means reading the whole store

A parameter's namespace lives inside its version envelope, not on a Parameter
Manager label. `list(namespace)` therefore cannot ask for a namespace: it pages
every managed parameter in the project, reads a version of each to recover its
envelope, and filters afterwards. `resolve()` calls `list()`, so a read of one
namespace costs P billed version reads for P parameters, however small the
namespace — and P grows as servers are added. Six added server slugs took that
past Parameter Manager's per-project read quota, and a production deploy died on
a `429` before `doctl` was called. Later, with the running gateway reading six
or seven namespaces on independent 60-second timers, the same shape was ~3.2M
billed reads a month in production and the largest line on the bill.

So every process that reads more than one namespace holds **one reading** of
the store and slices it. The two deploy-time readers, `render-spec` and
`store:check`, hold it for the run: at the shape a render actually has — one
store-wide `list()` then fourteen namespace `resolve()`s over 56 parameters,
counted against the in-memory fake — that is 1751 requests down to 169. The
running gateway holds it for `gateway.secrets.ttlSeconds`, an hour by default,
and every namespace it serves — the providers, a `params: true` builtin, the
console's diagnosis — is a slice of it: one enumeration plus one render per
parameter per TTL, ~68 billed reads at production's 34 parameters, whatever the
server count. The console's own admin client holds nothing, because it writes
and re-lists in one breath; instead every write through it, the console's
**Re-read the store** button, and the `secrets` MCP server's `refresh_gateway`
tool (which its write tools call for you) drop the gateway's reading so the
next read reaches the store. See [what "immediately"
means](/operate/secrets/#what-immediately-means) for the resulting bounds and
[the cost model](/operate/secrets/#one-reading-of-the-store-per-process) for the
numbers.

What is still true: a single read of the store costs P, and nothing bounds P.
The real fix for that is to put the namespace on a parameter label so the
listing can filter server-side, which needs a backfill of every parameter
already seeded. See `HACKS.md` #69.

The store client also retries a refused request — `429` or a transient `5xx`, on an
idempotent method only — with exponential backoff and jitter, bounded at three
retries and at most 2.8s of backoff. A write is never retried, because a refusal
can post-date the write and a retried `POST` that landed comes back `409`. That
clears a burst that overran the quota for a second or two. It does not clear a quota exhausted for a whole minute: the budget
runs out and the deploy fails as it did before, just later. The bound is deliberate
— every read has to SETTLE, and a budget long enough to cross a minute boundary
would put minutes of sleep on a deploy's critical path, multiplied by every call in
a store-wide read.

### 71. A refreshed parameter only reaches an upstream that re-reads its environment

[`paramsRefresh:`](/operate/secrets/#paramsrefresh--a-rotation-that-lands-without-a-deploy)
keeps a listed parameter current in a supplementary container's environment
without a redeploy. It cannot make the MCP server inside that container **look**
at the new value — that is a property of the upstream, and the bundle image runs
twenty-one of them written by other people.

`strad-fetch` builds its scraping clients inside a factory the host invokes per
request, so a rotated key is used by the next tool call; that is the case the
feature was built for. A server that snapshots its credential at mount time and
memoises a connection does not: `telegram` holds one MTProto session for the life
of the process, `grafana` and `google-sheets` build a client per mount, and
`x-twitter` caches its OAuth provider deliberately, because its token rotates in
memory and re-reading would fight that. For those the refreshed value sits in the
environment, correct and unused, until the container restarts.

Making every mount re-readable would mean re-running its loader when a value
moves, and the loaders are the expensive part of that image — a Chromium page, an
MTProto login, a memoised session store. Rebuilding one mid-flight is a bigger
blast radius than the staleness it fixes.

What stops this being silent is that the host records which mounts re-read per
call and logs one line per opted-in slug at boot: an unmarked mount gets a warning
naming the variables and saying the value will be current in the environment and
may go unused. So pointing `paramsRefresh:` at the wrong slug is a line in the
boot log, not a rotation that quietly does nothing. See `HACKS.md` #71.

### 70. Nothing escalates a slug that sits `unconfigured` forever

A server can name the `${NAME}`s it is willing to deploy without
([`mayBeUnseeded:`](/operate/secrets/#maybeunseeded--deploying-a-server-ahead-of-its-credential)),
so onboarding one no longer needs its credential seeded before the config PR can
merge. The cost is that a red deploy used to be what guaranteed somebody dealt
with it, and a warning in a run log is not.

The state is visible in four places — `/healthz` (`servers[].state`, plus a
top-level `unconfigured` list), the console index (chip `awaiting credential`,
counted as actionable), `/api/secrets/readiness`, and a
`strad.tool_surface_unconfigured` log line per boot and per state change. None of
them **escalate**. A slug waiting a week looks exactly like one waiting ten
minutes, and no alert fires either way — deliberately, because the same event at
ERROR severity would page a production channel about a credential a human already
decided to defer. The honest home for a threshold is the alerting stack reading
that event with a `for:` duration.

What still fails loudly is the mistake: a `${NAME}` no server waived reds the
deploy exactly as before, and a waiver naming a reference its server does not use
is a hard error in both `render-spec` and `config:check`. So this describes a slug
somebody deferred and then forgot, not a typo.

There is one asymmetry worth knowing. How fast a seeded value takes effect depends
on where the reference is read: a `url:`, `headers:` or builtin `options:` ref
under `gcp-parameter-store` activates within `negativeTtlSeconds` (default 10
minutes; at once if seeded through the console) with no redeploy, while a
`supplementary-image`'s `env:` — and everything under
`provider: env` — is baked onto a container strad does not run and needs the next
deploy. The render says which it is in the warning, but "no PR" and "no deploy"
are not the same promise. The baked half also reports less: `unconfigured` is a
state strad derives from a resolution it performs itself, so a slug whose only
waived name is a `supplementary-image` `env:` variable ships without that
variable and reads as whatever its own server says about itself. See
`HACKS.md` #70.

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

**On a `params: true` server that gap is total rather than partial.** Such a
server may declare no `${NAME}` references at all, and then a component that
cannot answer leaves its entry with **zero** requirement rows — not a row reading
`unverified`, but no rows. That is the state `/ui` explains least well by
construction, and it is the one that produced a **dead control** in production:
the entry rendered an `ISSUE` button over a `<dialog>` that was never emitted, so
the click did nothing at all ([#259](https://github.com/tadasant/strad/issues/259),
live on `craigslist`). The popout is built from the probe outcome instead — which
component holds the value, which of the five ways the question went unanswered,
and the `/strad/<env>/mcp/<slug>/static/*` prefix to look under — so the badge
leads somewhere. It is still not an observation. Making it one is the same pin
bump, on that component's image.

**A server that declares something else is graded on both.** The managed
namespace is a requirement in its own right, ranked `unobservable`, so an
unchecked one demotes the entry to `unverified` whatever its `${NAME}` references
did. A `READY` badge is never earned by checking a part rather than the whole
([#265](https://github.com/tadasant/strad/issues/265)). The popout gets its own
first line there: the `unverified` headline ("nothing here was established
either") would contradict the rows under it.

**One edge of that shape remains.** A `params: true` **builtin** runs inside
core, which resolves its parameters itself: the panel's whole vocabulary is about
a component core is not, so a builtin gets no panel — an inert `ISSUE` chip where
it has no rows, and its `${NAME}` rows plus the summary sentence where it has
some. The headline and the summary do name the namespace; what is missing is the
panel's three facts — which component, why the question went unanswered, and the
link into the parameters console
([#264](https://github.com/tadasant/strad/issues/264)). `echo` in staging is that
shape, and because `core` is never probed the gap is permanent for it: nothing an
operator seeds clears the badge, and `/api/secrets/readiness` reports
`ready: false` for as long as the deployment carries such a server.

**The `cannot render` diagnosis can lose a race and simply not appear.**
`readStoreDiagnostics` gives its two store reads six seconds together, and the
per-parameter render pass is bounded at a fan-out of ten. A large namespace can
exceed the deadline, and then the diagnosis returns null and the state is not
drawn — the console degrades to the states it had without it, never to a wrong
one.

**The diagnosis is as old as the process's reading of the store, and says so.**
It is answered from the same reading the gateway resolves `${NAME}` through,
held for `gateway.secrets.ttlSeconds` (an hour by default), and the pass over it
is reused for up to a minute, so a `/ui` reload and a hard poller on
`/api/secrets/readiness` cost no store read at all inside the TTL. The cost of
that is freshness: a value written by anything other than this console can take
up to the TTL to change a row, and a store that breaks can look healthy for that
long. So the age is printed rather than hidden — the console says when the store
was read, and the readiness JSON carries `store.diagnosis.ageSeconds` — and a
write through the console drops the reading,
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
generated from one source by `npm run wire:sync` — one entry in the vendoring
manifest every cross-tree copy is generated from — and CI fails if it drifts or if
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

### 52. Two slugs on one PATH still cannot hold two values for one name

A supplementary server's `env:` `${NAME}` resolves from
`/strad/{env}/mcp/{slug}/static/` before the shared
`/strad/{env}/gateway/static/`, so two servers can be given **different** values
for one name. Where those values can then LAND depends on whether the two slugs
are two mounts:

- **Different `path:`** — two instances in the container, each reading its own
  [per-slug variable name](/operate/secrets/#a-servers-secrets-live-in-that-servers-namespace). Both
  values land on one bundle; no second component.
- **Same `path:`** — one instance, serving both slugs from one set of
  credentials. There is nowhere for a second value to go, whatever it is called,
  so `render-spec` fails the deploy rather than picking a winner, naming both
  slugs, the path and the key (never the values). The answer is a separate path,
  a separate bundle, or the same value.

The same-path case is not a renderer bug: it is the capability-variant pattern —
`telegram-ro` and `telegram-rw` as two names for one mount, told apart by the
gateway's `tools:` policy — and those two share a container _because_ they share
a credential.

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
claim any fixed name — a path, a container, a host port, an image tag. The prod
deploy has not moved off `/tmp/spec.json`
([#115](https://github.com/tadasant/strad/issues/115)), and it is the instance
that remains open. The docker half is closed: every job in this repo that builds
an image and runs it tags it per run, because a concurrent job rebuilding a
shared `strad:ci` between the build and the `docker run` lets an assertion pass
against an image the run never built — the "`/mcp` with no token returns 401" one
in `ci.yml` ([#117](https://github.com/tadasant/strad/issues/117)), the mount
count in `bundle-google-ci.yml`
([#119](https://github.com/tadasant/strad/issues/119)), and the pinned `op
--version` that gates the published 1Password image
([#126](https://github.com/tadasant/strad/issues/126)). The durable fix for the
class is ephemeral runners.

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
that also holds twenty other servers' credentials in its environment, one of them
a session string that IS a Telegram account. An agent that can call `upload_file`
can therefore ask it to read a local path and publish a link to whatever came
back.

Paths under `/proc`, `/sys`, `/dev`, `/app`, `/root` and `/etc` are refused, which
closes the obvious one (`file:///proc/self/environ` returns every secret in the
bundle in a single call). That is a denylist, not a sandbox: the real boundary is
that reaching this tool at all requires a token entitled to the slug. A confined
upload directory would be the stronger answer and is not implemented.

## Supply chain and build

### 15 & 45. The `shared/` trees are vendored, not depended on

`servers/fetchpet/shared/`, `servers/onepassword/shared/` and
`servers/pointsyeah/shared/` are copied from
[`pulsemcp/mcp-servers`](https://github.com/pulsemcp/mcp-servers). Mostly the
`remote/` streamable-HTTP entrypoints are the only new code and the tool logic is
reused unchanged. 1Password drags one more thing along: its
`@pulsemcp/mcp-elicitation` dependency isn't published to npm either, so that
library is vendored as a third workspace.

That library is vendored twice, because `images/bundle-google` needs it for its
send-email confirmation and is its own Docker build context. Both copies end up
in the same bundle image, and both gate an irreversible act through the library's
`requestConfirmation()` — sending an email on one side, revealing or minting a
credential on the other — so the seam is in the `VENDORED` manifest alongside the
other six: `servers/onepassword/elicitation/src` is the source, `npm run
elicitation:sync` writes the copy, and `test/vendored.sync.test.ts` fails CI on
drift and on a `files:` list that no longer names every module in the source
directory. The trees' `package.json`, `tsconfig.json` and markdown are identical
too and are outside the seam — a banner-less check is a different mechanism.

The copies have since taken strad-local edits, and every one of them is a thing
the upstream stdio server cannot know about: the shared-browser seam
(`setSharedBrowserProvider`) that gives three servers one Chromium, browser
telemetry, and — in `fetchpet` — login selectors that match the form Fetch serves
today plus a login that retries instead of caching its first failure (good-eggs,
which is a fork rather than a vendor copy, carries the same retry; see #10). Each tree's
README lists its deltas. The debt is real: a re-vendor is a merge, not a copy.

**Why:** the upstream packages publish stdio servers, not libraries strad could
depend on. strad's ESLint, Prettier, and TypeScript are scoped away from
`servers/**` so the vendored code keeps its own toolchain.

A vendored tree can still be tested from outside itself: the 1Password and
PointsYeah Vitest suites live at `servers/onepassword/test/` and
`servers/pointsyeah/test/`, at their tree roots, and import the vendored sources
rather than sitting among them. A re-vendor overwrites `shared/` and never touches
`test/`, so neither suite is part of the merge.

**Undo:** land shared fixes upstream and re-vendor; longer term, have upstream
publish `shared` and the elicitation library as real packages.

### 10. good-eggs is a fork, because there was nowhere else to fix it

`servers/good-eggs/shared/` began as a verbatim copy of the same monorepo's
`experimental/good-eggs/shared`, carrying the same "fixes belong upstream, then
re-vendor" instruction. That instruction had nowhere to point: the npm package
the defects were reported against, `good-eggs-mcp-server@0.1.11`, declares no
`repository`, `homepage` or `bugs` URL, and no matching repo exists under
`pulsemcp` or `tadasant`. So the tree is first-party now, on the same reasoning
as `strad-fetch` and the two forks in `bundle-api`.

What it cost: a fork has no upstream to argue with it and no sync script to
notice a loss, so `servers/good-eggs/shared/test/` is the only thing defending
its deltas. CI runs that suite on every PR.

`servers/good-eggs/FORK.md` lists all of them. The load-bearing one is that the
basket is read from the `storeData` payload Good Eggs renders into every page
rather than from the drawn markup — the markup depends on which of two basket
layouts the account is served, and the scrape that preceded this knew only one
of them, so `get_cart` answered "your cart is empty" against a 43-item basket.

The second is the login. The wait after submitting credentials took Playwright's
default `waitUntil: 'load'`, and the page Good Eggs lands on once it has accepted
them does not fire that event — so on 2026-08-28 every authenticated call, on
every tool, failed with a 30-second `page.waitForURL` timeout, over a log showing
the navigation to `/home?recently-logged-in=true` had already happened. The wait
now stops at `domcontentloaded` like every other navigation in that server,
decides on the landing PATH rather than an exact URL, and takes the page's own
`storeData.user` as the evidence — a signed-in payload is a successful login
however the wait ended, and an anonymous one is a failed login however the URL
looks. A failed login is retried rather than latched: the failed attempt is
discarded, the half-initialized client is closed, and the next tool call starts a
fresh attempt on a fresh browser context — with the bundle host clearing the
mount's `degraded` mark when one succeeds. That second half is what decides how
long an outage lasts. Without it, a latched failure has nothing to clear it —
this mount degrades rather than exiting, so no restart comes — and one transient
blip at boot disables the slug until a redeploy.

**Undo:** if upstream ever publishes `shared` as a library carrying these fixes,
depend on it and delete the fork.

### 55. The slack server is a fork, and only its tests defend the delta

`servers/bundle-api/fork/slack/` is a FORK rather than a vendor copy. Four of the
six servers in `bundle-api` sit in `upstream/` and are copied verbatim; slack
sits in `fork/` alongside `google-flights` (#58), and strad has edited its tool
definitions.

The reason is Slack's message format. Slack renders **mrkdwn**, mrkdwn is not
Markdown, and `~text~` is strikethrough — so an agent writing `~750 som` and
`~$9` in the same message has written one struck-through run covering everything
between them. Nothing errors: the message posts, the tool reports success, and
the only signal is a human reading the channel. Upstream's write tools describe
their text as "Supports Slack markdown formatting", which is the assumption that
produces the bug, and never mention the tilde. The fork rewrites those
descriptions and appends a warning to the tool result when the text that was
just sent contains a construct Slack will render differently.

The fork also **adds four tools** upstream does not have — `slack_send_dm`,
`slack_get_dm`, `slack_get_dms` and `slack_find_user`. Upstream can post to a
channel and to a thread and cannot address a person at all, and Slack's own DM
flow is two calls an agent should not have to know about. The OAuth scopes they
need are [#59](#59-a-dm-needs-slack-scopes-the-channel-tools-never-asked-for).

**Cost:** a fork has no upstream to diff against, so a re-vendor that pastes
`experimental/slack/shared/src` over `fork/slack/src` reverts the fix and nothing
reports it. The vendored seams elsewhere in strad each have a sync script and a
drift test; this has neither, by construction. What stands in for one is
`fork/slack/test/mrkdwn.test.ts` and `fork/slack/test/dm.test.ts`,
run on every PR by `ci.yml`'s `servers (bundle-api)` leg. They fail if a write tool stops
leading with the tilde rule, if the registered set is no longer exactly the
thirteen expected names, or if the server starts rewriting a caller's text.

**The warning is after the fact.** It cannot stop the bad message — nothing
errors, so there is no send to refuse — and it is heuristic: deliberately lenient
about where a strikethrough closes (it over-reports rather than missing one), and
deliberately silent about `_italics_`, which would fire on every `snake_case`
identifier. It never escapes or rewrites the text; `~` has legitimate uses, and a
server that edits the words a caller chose fails just as quietly as the bug it
is preventing.

**Undo:** move the tree back under `upstream/`, restore the two Dockerfile `COPY`
lines and `loadApiTree`'s path, and drop the CI job. It also means dropping the
DM tools: the `slack` slug goes back to nine tools and `slack-readonly`'s
allow-list back to four, in both `infra/strad.staging.yaml` and
`strad.config.example.yaml`.

### 59. A DM needs Slack scopes the channel tools never asked for

The slack fork's four DM tools (#55) call five Slack methods the nine channel
tools never touch, and each one is gated on its own OAuth scope:

| Call                               | Scope                   | Used by                                                                                                |
| ---------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------ |
| `conversations.open`               | `im:write`              | `slack_send_dm`                                                                                        |
| `conversations.list?types=im`      | `im:read`               | `slack_get_dms`, `slack_get_dm`, and `slack_send_dm`'s fallback                                        |
| `conversations.list?types=im,mpim` | `mpim:read` **as well** | `slack_get_dms` with `include_group_dms: true`                                                         |
| `users.list` / `users.info`        | `users:read`            | `slack_find_user`, resolving any recipient not named by ID, and confirming the name behind one that is |
| `users.lookupByEmail`              | `users:read.email`      | naming a recipient by email address                                                                    |

Posting into a `D…` channel needs only the `chat:write` the server already had,
and reading one needs `im:history`.

The last measured scope set — `auth.test`'s `x-oauth-scopes` header, read live on
2026-08-14 — holds `im:history`, `im:read`, `users:read` and `chat:write`, and
**not** `im:write`, `mpim:read` or `users:read.email`. Adding one is an edit to
the Slack app plus a reinstall, and that is a human action in Slack's UI.

:::caution[The scope set above is a measurement, and it has an expiry]
The workspace owner reports having added `im:write` on 2026-08-15. That is **not
re-measured here**, and the page says so rather than assuming it: re-enumerating
scopes needs the bot token, which is injected into the `slack-workspace` MCP
server's process rather than into an agent's environment — and none of the tools
that server currently exposes calls `conversations.open`, `users.list` or
`users.lookupByEmail`, and the 1Password copy of the token declined its reveal.
What was confirmed on 2026-08-15 is that the deployed token still authenticates
and still reads a DM, so nothing rotated out from under the deployment. Re-run
`auth.test` from somewhere holding the token before relying on `im:write`.
:::

**A live DM test on 2026-08-15 measured capability, not scope.** Two messages
were sent through `chat.postMessage` addressed by USER id, and both landed — one
to a person whose DM channel already existed (empty, created when the app was
installed), and one to an account this bot had never had a conversation with at
all. The second is the interesting result and it still does not settle
`im:write`: Slack opens the conversation itself when `channel` is a user id, and
documents `chat:write` as the only scope that call needs. So a delivered message
is equally consistent with "`im:write` was added yesterday" and with "`im:write`
was never needed for this path", and only `auth.test` tells them apart.

The second reading would make this entry moot — `slack_send_dm` drags `im:write`
in only because it calls `conversations.open` before posting — and
[issue #150](https://github.com/tadasant/strad/issues/150) carries that as a
hypothesis to test rather than a change to make. Removing the
`conversations.open` path while the scope list is unknown would trade a call
known to work for one that is merely likely to.

**What that costs.** `conversations.open` is what creates a DM that does not
exist yet. Without `im:write`, `slack_send_dm` retries a `missing_scope` as a
scan of the DMs that are already open and posts into the one it finds — so
messaging anyone the bot has ever DMed works today, and a first-time recipient
gets an error naming the scope and the alternative (they DM the bot once, which
opens the conversation from their side). Group-DM listing and by-email
addressing fail the same way, on the call rather than at boot: the tool list does
not change shape with the credential, because a surface that silently narrows is
harder to debug than a call that says what it needs.

**Undo:** add the scopes to the Slack app, reinstall, and rotate
`SLACK_BOT_TOKEN`. No code changes — the fallback simply stops firing.

### 11. Playwright is pinned to the base image's Chromium

The browser images build `FROM mcr.microsoft.com/playwright:v1.61.1-noble` and pin
Playwright to `1.61.1` rather than downloading a browser at build time:
`cdn.playwright.dev` was flaky from the build environment, and the base image's
Chromium revision matches 1.61.1 exactly. The three server trees pin it with an
`overrides` block; the bundle host declares it directly.

**Cost:** the base image is large, and the bundle image lands around 3.9GB, ~85% of
which is that base. **When bumping Playwright,** bump the base image tag and the
`overrides` version together, or the browser revision stops matching. That version
is written in four Dockerfiles, four `package.json` files, four lockfiles, this page
and `HACKS.md`, and the bundle collapses three of those trees into one container
sharing one browser — so `test/playwright-pin.test.ts` reads every one of them and
fails the PR that leaves a sibling behind. Nothing else would: listing a browser
server's tools never launches Chromium, so a mismatched pin builds, boots and lists
green, then fails on the first browser-driven tool call.

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
build on the release path runs three times, minutes of it, before the run goes
red — and a real permission change (visibility flipped, linked repo dropped,
`packages: write` removed) is retried twice before it goes red. A run that
publishes nothing takes exactly one attempt: there is no registry to refuse it,
so a failure is the build itself and a retry would only spend wall clock (#73).

The wrapper declares only the ten inputs its call sites pass, and a `with:` key
it does not declare is dropped with a warning rather than an error. `builder:` is
the one it refuses to run without — see #53.

**Undo:** point the call sites back at `docker/build-push-action@v6` and delete
the wrapper. **Watch:** three `build/push attempt N failed` warnings carrying the
same 403 mean the registry is refusing, not flaking — check the package's settings
rather than re-running. Read #57 first, though: a credential a concurrent job had
logged out of produced exactly those three warnings and had nothing to do with the
package.

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
and not its prose. At the time nothing else in a PR build loaded that action
either, since every step using it ran on `main` only. So the file was unlinted
where it mattered, and there is no backslash escape for the expression delimiter:
the runner template-parses the WHOLE manifest when it loads it, so an expression
written anywhere in it as an example is evaluated. #73 closed the second half of
that — `ci.yml` builds through the action on every PR, so a manifest that does
not load fails the PR — and the assertions below still stand, because a green
load proves the file parses and not that a description is free of examples.

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

### 54. A bundle build that fails or is cancelled blocks every later deploy, not just its own

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

**A cancelled build is the same wedge for a commit nobody broke.** On 2026-09-04
the self-hosted runner host restarted mid-build. `a278b5ed`'s bundle build was
cancelled 100 seconds in — three unrelated jobs on two other runners died in the
same second — and `main` was undeployable until somebody re-ran it by hand nine
minutes later. Nothing alerted: `alert-ci-failure.yml` stays quiet on `cancelled`
on purpose, because `ci.yml`'s `cancel-in-progress` makes cancellation routine.

`reheal-bundle-image.yml` now makes that re-run automatically, on the first
cancellation of a `push` build and nowhere else, and the tag walk holds its wait
open for exactly the cancellations that listener will heal — it restates the same
three guards rather than assuming — so a deploy already waiting does not stop in
the minute before the re-run starts. See
[the self-heal](/operate/operations/#when-the-bundle-build-was-cancelled-it-re-runs-itself).

**What is still open.** A `failure` wedges `main` exactly as before — that is the
case above, and a re-run cannot fix it. So does a cancellation on attempt 2 (the
heal spends one attempt per run) and a cancellation of a `workflow_dispatch`
build (which a human may have stopped on purpose); both of those hard-stop
immediately, exactly as every cancellation used to. What is genuinely slower is
the case where the heal _should_ have fired and did not: the deploy spends its
full 900-second budget first, and the error then names the interruption and says
to re-run it.

### 57. The ghcr credential is a box-wide file, and the slowest build loses it

**Resolved.** The condition behind it — one docker daemon, one `$HOME`, several
concurrent runner processes — is unchanged, and is the same one behind #53, so it
is written down here.

`~/.docker/config.json` is where `docker login` puts a registry credential, and
there is one of it per machine, because every job runs as the same user. Nine jobs
here run `docker/login-action` against ghcr, each writing the same
`auths["ghcr.io"]` entry with its own job's `GITHUB_TOKEN`, and each running
`docker logout ghcr.io` in a post step — `logout: true` is that action's default.
So the last job to log in owns the credential every concurrent build pushes with,
and the first job to finish deletes it. A buildx CLI reads that file once at
startup and pushes with whatever it read, which for a long build can be a token
belonging to a job that has since ended — and GitHub revokes a job's token the
moment it does.

On 2026-08-12 that took `main` red on `Release bundle image`:

| Time (UTC) | What                                                                                    |
| ---------- | --------------------------------------------------------------------------------------- |
| `03:50:53` | the bundle logs in, then the bundle-API job logs in over it half a second later         |
| `03:50:59` | the bundle's buildx starts and loads the file once — holding the bundle-API job's token |
| `03:51:49` | the bundle-API job ends, and GitHub revokes the token buildx is holding                 |
| `03:53:07` | the bundle finishes and pushes with it: `oauth token: denied: denied`                   |
| `03:53:22` | `Release image` finishes; its post step logs out, emptying the file                     |
| `03:53:24` | the two retries ask for an ANONYMOUS token instead, and take a `403` each               |

Three attempts, three 403s, and nobody had touched the package's permissions. The
two sibling image jobs in that same push both pushed fine, because each was short
enough to finish while its own credential was still the one in the file — so the
bug selects for the slowest build, which is always the bundle, and reads as
something specific to the bundle rather than a race. Every error string points
away from this repo: a revoked token and an absent one look exactly like a package
whose visibility flipped, which is what #51 tells you to go and check.

**Fixed by isolation.** `.github/actions/docker-config` points `DOCKER_CONFIG` at
`$RUNNER_TEMP/docker`, and every job that logs in calls it first. `RUNNER_TEMP` is
per runner installation and emptied between jobs. One variable moves the docker
CLI, both of `docker/login-action`'s steps and buildx's auth provider together, so
the post-step logout stays on and empties only this job's own file. Three details
carry the fix: it is written through `$GITHUB_ENV`, because `runner.temp` is not
available in a job-level `env:` and expands to the empty string there; it runs
before `docker/setup-buildx-action`, because buildx keeps its builder metadata in
the same directory; and `logout:` stays on, because `logout: false` would stop a
job deleting the shared credential while leaving it overwriting one, and leave a
live token on the runner. `test/workflow-docker-config.test.ts` fails the PR that
drops any of them.

**What a fresh config directory does not inherit.** `~/.docker` also holds
`cli-plugins/` — buildx is a CLI plugin — plus `contexts/`, `currentContext` and
`proxies`, and an isolated directory starts without them. On this runner that
costs nothing, checked rather than assumed: `docker info` reports buildx at
`/usr/libexec/docker/cli-plugins/docker-buildx`, the system path the CLI searches
whatever `DOCKER_CONFIG` says, and `Context: default`. Re-check if the runner is
ever rebuilt with a rootless or hand-installed docker, where buildx lives in
`$HOME` and the daemon is chosen by a context.

**Serialising the workflows was the alternative.** A `concurrency:` group would
have ended it too, at the cost of every push taking the sum of its builds rather
than the longest — the bundle alone is thirteen dependency trees. Isolation costs a
`mkdir`.

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

### 61. A server's own namespace is read at runtime, so one bad parameter in it takes that slug down

Every `${NAME}` written on a server entry resolves from
`/strad/{env}/mcp/{slug}/static/` before the shared gateway namespace, at runtime,
in strad's own process. That layer is chained in front of the shared one, and the
chain deliberately does **not** fall through on a throw — an unreachable store must
not silently demote a server to whatever the shared namespace happens to hold,
which is how a rotated credential comes back from the dead.

Combined with [#36](#36-one-un-renderable-parameter-makes-the-whole-gateway-namespace-resolve-to-nothing),
that widens the blast radius by one namespace: a malformed parameter under a slug's
own namespace fails that slug's ref resolution outright, rather than missing and
letting the gateway namespace answer — even for a name the gateway namespace holds
and that worked before anyone seeded anything. It is the same semantics a
`params: true` server has always had for that namespace, so both halves of
`/mcp/{slug}/static/` fail the same way rather than one being quietly more
forgiving.

Two things bound it: the layer is **lazy**, so a slug nobody seeded and nobody
calls never reads at all, and a refresh that throws serves the last good snapshot —
only a first read failing propagates.

A slug seeded by nobody but _called_ does read its own empty namespace, and in
principle a throw there fails a name the shared namespace holds. In practice an
empty namespace has no parameter to fail on, so it can only fail on transport —
and transport takes the shared layer with it anyway. Every case that genuinely
differs is one where something broken was seeded under that slug.

Two smaller costs of the same layer:

- **A newly seeded per-server name takes up to `ttlSeconds` (1 hour)**, not
  `negativeTtlSeconds` (10 minutes) — unless it was seeded through the console,
  which drops the reading. The layer does not chase a miss, because a miss on it
  is the normal case and chasing one drops the process's whole reading of the
  store — chasing every miss would cost a full re-read per gateway-resolved name
  per slug. Rotating an existing per-server value is unaffected.
- **One namespace read per TTL per slug** that both references a `${NAME}` and is
  actually called, on top of the shared read. The same shape as #52's render-time
  cost, moved to the request path and cached.

Whatever fixes #36 fixes this. **Nothing detects it ahead of time yet**:
`store:check --resolve` renders the gateway namespace only. It `list()`s
`/strad/{env}/mcp/` to decide coverage and never `resolve()`s it — the report says
so, marking a `perServer` name "NOT render-checked" — so a per-server parameter
that lists fine and will not render passes every gate and fails on the request
path. Extending `--resolve` to the namespaces it already enumerates is the cheap
half of the exit.

### 50. Three slugs ship disabled until their secrets are seeded

`telegram-ro`, `telegram-rw` and `pulse-subregistry` sit in
`infra/strad.staging.yaml` with `enabled: false`. The mount is in the bundle image and the process registers it
either way — the bundle's own internal `/healthz` lists it, degraded — but no slug
routes to it.

**Why:** `render-spec` resolves every `${NAME}` from GCP Secret Manager and fails
the deploy on one it cannot find, deliberately. A server whose credentials do not
exist yet therefore cannot ship enabled; `enabled: false` is skipped at render, so
the four unseeded refs cost nothing. The render is also all-or-nothing — one spec,
so one unseeded name stops the deploy for every other slug, which is what
`pulse-subregistry` did to `main` on 2026-08-14 before it was gated.

**Cost:** a disabled server is invisible where anyone would look — absent from the
gateway's `/healthz` and from the console, and `?servers=telegram-ro` is a 424.
Only the bundle's internal health route, which nothing outside the app can reach,
shows the mount at all.

**Undo:** per slug, seed the names it references — the three `TELEGRAM_*` values
for the telegram pair, `PULSEMCP_SUBREGISTRY_API_KEY` for `pulse-subregistry` —
then delete that entry's `enabled:` line and add each seeded name to
`PROVISIONED_STATICS` in `test/staging-config.test.ts`.

### 56. Per-slug variable names are emitted for every server; only four of the thirteen trees can read one

Every supplementary server's `env:` lands on its bundle twice — under the bare
name and under `<SLUG>__<NAME>` — with no condition attached, so what a server's
variables are called is computable from that server's own config entry. Four
limits travel with it, and each is decidable by looking at the config.

**Only a slug that is its own mount can READ its names.** The bundle host serves
one instance per path, so a slug is handed its own names only when it is the only
slug on its path and that path is `/<its own slug>`. Capability variants sharing
`/gmail` are one process: their per-slug names exist on the container, and what
they read is the bare name. Two slugs on one path resolving one variable
differently is still a hard error — one process cannot hold two credentials,
whatever the variables are called.

**Only `telegram`, `remote-filesystem`, `bundle-google` (for `google-sheets`)
and `grafana` read an injected environment.** The other nine trees in the bundle
image are vendored upstream code that reads `process.env` directly, often lazily
at call time, so they see the bare names only. The renderer cannot tell which tree an image contains — an image is a tag in
someone else's config — so a slug of another tree given its own path renders,
warns, and serves nothing, because the image has no mount at that path.
Reachability reports the deployment `degraded`, which is where you would see it.

**A slug starting with a digit gets no per-slug names**, because `1PASSWORD__X` is
not a portable variable name. It reads the bare names, and the render says so by
name.

**A `params: true` server's variables are not covered**, because they are not in
`env:` — a managed parameter's name comes from its path in the store, so there is
no declaration to prefix. Prod's `telegram-ro` is `params: true`, so giving it a
credential of its own means moving it to explicit `env:` refs first.

**What it costs a rendered spec.** One extra variable per supplementary `env:`
entry: prod's `bundle` goes from 36 to 87 and staging's from 34 to 83, with
nothing removed and no value changed anywhere, and `core` untouched. Each
supplementary credential therefore appears twice in the spec, encrypted at rest by
DigitalOcean both times.

Two smaller edges. The console's presence probe asks the bundle about **bare**
names only, so it reports the bare variable healthy and says nothing about the
per-slug name a server may actually be reading. And a slug may no longer contain
`--`, or lead or trail with `-`, because `a--b` + `C` and `a` + `B__C` would
otherwise be one variable; no slug in any strad config has ever used either shape.

**The discovery is unit-tested; the mounting is not.**
The bundle host has a suite (`servers/bundle/host`, vitest over its TypeScript
sources) covering the discovery rule, the two `degraded` verdicts, the presence
route's wiring and the per-tree SDK cache. What it does not cover is anything
needing `/app/trees` to exist — `buildMounts()` itself, the loop that refuses a
discovered slug colliding with a mount the image already serves, and the two
loaders that build a per-slug instance. Those are reached only by the
`bundle_image` job, which asserts the mount **set** against a booted container and
exercises no branch.

**Undo:** `HACKS.md` #56.

---

### 58. The google-flights date grid costs one request per date, a premium seat has no legroom to report, and the fare brand is not the cabin

`servers/bundle-api/fork/google-flights/` is the second fork in that tree (#55 is
the first), taken from the published `google-flights-mcp-server` v0.2.6. It fixes
three defects that all shipped a confident, wrong answer with no error attached:
cabin class and passenger counts encoded at protobuf field numbers Google skips
as unknown fields, so every search was economy and one adult; the two baggage
entries read in the wrong order; and a `get_date_grid` that returned a trailing
61-day price _history_ instead of future departure dates. `FORK.md` in that
directory carries the evidence. What follows is what remains.

**The grid is one request per date.** Google's search response contains no
forward-looking grid to read — the only future date in the whole document is the
anchor the caller asked for — so the grid is built by searching each date in
turn, rate-limited and in sequence. A date costs `max(1.5s, Google's own response
time)` — measured at 7.2s for five dates, so the 7-day default lands near ten
seconds, and a slow Google raises it rather than being absorbed by the gap.
`window_days` caps at 31 and the grid abandons at a 55s budget,
reporting unreached dates: the MCP SDK's default request timeout is 60s, and a
client that gives up does not stop the loop. Sequencing is deliberate too — a
burst against someone else's page is the quickest way to get the tool blocked
outright.

**Cost:** a genuinely wide date search is not something this tool can serve. The
honest answer to "cheapest month" is several calls, and the tool says so rather
than returning a fast grid of the wrong dates.

**`segments[].legroom` is `null` on a lie-flat seat, because Google publishes no
measurement for one.** This was recorded as a suspected parser gap — an index the
fork had not found on payloads it could only reach once the cabin field number
was fixed — and it is not one. A business offer for the same physical flight
differs from its economy twin in five values that could name an amenity, and in
nothing else of the kind: the seat classification, the two legroom strings going
`null`, the cabin, and the price. No measurement appears anywhere else in a
premium document.

The cabin does not predict it. Across 372 legs from eight searches over two
routes and four cabins, a figure is present exactly when Google classifies the
seat by legroom band and absent exactly when it classifies it by seat type — a
recliner, an angled flat, a lie flat. Premium-economy segments therefore often do
carry one (`"35 inches"`, `"37 inches"`), and an economy connection inside a
business itinerary carries its own while the premium legs either side report
`null`. The seat classification is not translated into a label like "lie flat
seat" either: the payload carries no text establishing what its codes name, and
inventing one is the failure this fork exists to stop.

**`fare_brand` is the field that remains untrustworthy.** It names a tier
_within_ the requested cabin, not the cabin: a business-class result whose tier
reads `"Economy Flex"` is not an economy fare. Both it and the legroom null are
documented in the tool description instead of being smoothed over with a
plausible transformation — the same call the baggage parser makes when it reports
an absent entry as `null` rather than as zero.

**Cost:** a caller that wants a legroom figure for a premium seat, or a
human-readable fare name, does not get one from this server; for the seat, the
airline's own seat map is the source.

**Only its tests defend the delta,** exactly as with #55. A re-vendor that pastes
the published package over `fork/google-flights/src` reverts every fix silently.
`fork/google-flights/test/fork.test.ts`, run on every PR by `ci.yml`'s
`servers (bundle-api)` leg, asserts the encoded `tfs` bytes rather than a round-trip
through this repo's own schema — a round-trip passes on the broken numbering,
since the bug was a disagreement with a schema that lives at Google — and asserts
the grid's window as literal dates, because which dates came back was the bug.

**Undo:** move the tree back under `upstream/`, restore the Dockerfile `COPY`
lines and `loadApiTree`'s path, and drop `fork/google-flights` from the
`bundle-api` workspaces, build and test scripts. Tool names and tool count are
unchanged by the fork.

### 62. A `paramsWritable` write is single-writer only because the render says so

[`paramsWritable:`](/operate/secrets/#paramswritable-a-credential-that-rotates-on-use)
lets a supplementary server persist a credential that rotated under it: it POSTs
to core, which performs the write with the store-admin credential it already
holds. The write is a plain `rotate()` — there is no compare-and-set on the
parameter's version, so two processes writing the same variable are
last-write-wins.

What keeps that from mattering is one check in `renderAppSpec`: a component
hosting a server with a non-empty `paramsWritable:` may not have
`instance_count > 1`. The correctness of the whole mechanism rests on that
refusal.

For the credentials this exists for, a CAS would not help anyway. X's refresh
tokens are single-use: replica A spending one invalidates it at X, so replica B
is holding a dead value before any write happens. There is no merge and no
version check that recovers it — the damage is at the upstream, not in the store.
The useful response to that topology is to refuse it at render, where it costs a
deploy rather than a silent outage.

**What it costs.** A server that persists a credential cannot scale horizontally.
For the current fleet that is free — every bundle runs one instance — but it is a
real constraint, and the render error is the only place it is enforced.

Two smaller edges of the same path:

- **The boot read makes the store authoritative at boot** for the names on the
  list. That is the point: it is what closes the race where a deploy bakes a value
  a sibling process has since spent. It also means a bad value written to a
  `paramsWritable` name takes effect on the next restart with no deploy in
  between. The fallback to the baked environment covers the store failing to
  _answer_, not the store answering with something wrong.
- **A failed write degrades a mount that is still fully working.** The `degraded`
  string on the bundle's `/healthz` is a statement about the _next restart_, not
  about this process. Read a degraded x-twitter as "re-seed before this restarts",
  not as "it is down". The alternative is a silent loss that surfaces hours later
  as a total outage.

**Exit.** A compare-and-set `put()` — read the latest version id, write
conditional on it, re-read on conflict — plus dropping the render check, for any
credential that is not single-use at the upstream. Worth doing when a second
consumer appears; not for a token whose upstream has already made the concurrency
decision for us.

### 63. One internal token means any container can reach any writable parameter

The [parameter write-back routes](/operate/secrets/#paramswritable-a-credential-that-rotates-on-use)
authenticate with `STRAD_INTERNAL_TOKEN` — one token, broadcast to every
supplementary component, because it is the same token core presents when it
proxies `/mcp` to them. Nothing binds a caller to the slug it addresses.

So the reachable set is not "this server's allowlist"; it is the **union** of
every enabled server's `paramsWritable:`, for any container holding the token.
Two consequences worth stating plainly:

- A compromised container on one bundle can read and overwrite the rotating
  credential of a server on another.
- The `GET` is a value read on the **public** component. Before this, reading a
  stored value took the console admin key behind Google SSO — so
  `STRAD_INTERNAL_TOKEN` is now also a read credential for the names on that
  union, which belongs in how often you rotate it.

The union is opt-in and empty by default, and every name in it is by construction
a credential that rotates, so losing one costs a re-seed rather than a durable
secret. Against that, the alternative — a cloud credential on each container — is
the thing strad's three-role split exists to prevent, and is strictly stronger
than this.

A component-identity header would **not** fix it: the caller would be choosing
its own identity, so it narrows the accident and not the attack while reading like
a boundary.

**Exit.** Per-component internal tokens — core mints one per bundle and presents
the matching one when it proxies, so each component holds only its own. That makes
the caller's identity a property of the credential rather than a claim, and
narrows the presence route by the same stroke.

### 65. strad-fetch's scraped-page cache is shared by every caller of the slug

`strad-fetch` (strad's fork of `@pulsemcp/pulse-fetch`) saves each page it fetches
as an MCP resource, and the bundle host builds its factory once. The cache is
therefore one cache for the container: any client entitled to the slug can
`resources/list` the URLs every other client scraped, and `resources/read` their
content, until an entry is evicted.

**Why it is like that.** Upstream got privacy for free — it runs as one stdio
subprocess per client session, so a process-level cache _was_ a session-private
cache. Behind a gateway it is not. Keeping the cache is what makes a repeated
fetch cheap; a cache keyed per identity is real work for a property nothing has
asked for yet.

**Cost:** scraped pages, and more tellingly their URLs, are visible across the
agent sessions that share the token. In this deployment that is one person's own
sessions — the slug is admin-entitled in staging, and prod's `zimmer` role
authenticates every session as the same principal — so it is not a cross-tenant
leak. Nothing in the cache is a credential; it is public pages someone fetched.

**What the fork DID bound is the memory.** Upstream's store grows for the life of
the process, which is fine for a subprocess the OS reclaims and an out-of-memory
kill in a container that hosts twenty-one mounts. The cache is LRU-bounded on both
entry count and bytes, and the filesystem backend is gone (App Platform gives the
container no persistent volume, so it was memory with extra steps).

**Undo:** `HACKS.md` #65.

### 66. A connector's credential reaches the container on the next deploy, and there is no Disconnect

strad's console can run a Google OAuth consent for a server slug and write the
refresh token into that slug's parameter namespace — see
[Connectors](/operate/connectors/). Two things it deliberately does not do.

**The activation boundary is a deploy.** A supplementary image's environment is
baked at render time, so a credential stored through the console reaches the
container when the app is next deployed, not when the page says it was written.
The console says so rather than implying success; there is no "applying…" state
and no restart button.

Live rotation is not impossible in principle — `paramsWritable:`
[(#62)](#62-a-paramswritable-write-is-single-writer-only-because-the-render-says-so)
already carries a value from the store to a running container — but it is the
wrong shape here. That path exists so a process can persist a credential that
rotated _under_ it, and it is single-writer by construction. A connector rotation
is initiated by a human on a different component, and making the bundle poll for
one would be a second mechanism with a second set of failure modes for a value
that changes a handful of times a year.

**There is no Disconnect.** Removing a stored credential is a delete in the
parameters manager; revoking the grant is a step at
[myaccount.google.com](https://myaccount.google.com/permissions). strad does not
call Google's revocation endpoint. A generic Disconnect is only meaningful if it
does both, and the second means holding a live credential purely to destroy it —
deliberately out of scope for the first provider.

**A stored token is not a working one.** The console says _a credential is
stored_, never _this works_. Google expires a refresh token from an app in
"testing" after seven days
[(#64)](#64-a-google-sheets-credential-is-a-human-minted-refresh-token-and-in-testing-mode-it-expires-in-7-days)
and revokes on a password change; the store can see neither. The only honest live
signal is a real call, and the console does not make one.

### 67. A lapsed good-eggs session is detected but never repaired

`servers/good-eggs/` signs in once, in `initialize()`, and holds the browser
context for the life of the container. Nothing re-establishes that session.

The server can at least tell when the session is gone. The basket read and the
favorites read both decide "is this signed in" from the `storeData.user` the page
carries rather than from the markup it drew, so a lapsed login produces a loud
_the contents are UNKNOWN, not empty_ rather than a false empty — and, when the
page carries a payload this tree recognises, rather than the plausible list of
recommendation tiles a signed-out visitor is shown. That is the failure
[#10](#10-good-eggs-is-a-fork-because-there-was-nowhere-else-to-fix-it) exists to
prevent. What it cannot do is fix it: the tool stays broken until the container
restarts.

Re-logging in mid-call means driving the sign-in form from inside a tool handler,
possibly with another call in flight on the same page, and inventing a retry
policy for a credential that may genuinely have been revoked. Detecting the lapse
truthfully is what stops the harm; repairing it is a larger change.

It is worse one layer up: a boot-time login failure is latched for the life of
the container and cleared only by a teardown the collapsed bundle never calls, so
even a transient failure never retries.

**Undo:** give the client a `reauthenticate()` and call it from the read paths
that throw on an unconfirmed session, guarded so two concurrent tool calls cannot
drive the sign-in form at once — and clear the login latch in the same change.

### 68. The Grafana mount runs a downloaded binary, and its version is pinned in three places

`grafana` is the only upstream in the bundle image that is not JavaScript.
Grafana publishes `mcp-grafana` as a Go executable and a Docker image and nothing
else, so the bundle Dockerfile fetches the pinned release, verifies it against a
SHA-256 digest committed here, and installs it on PATH; `servers/grafana`
supervises it as a stdio child and proxies to it.

A version bump has to move three things, and nothing checks that it did: the
`MCP_GRAFANA_VERSION` and both `MCP_GRAFANA_SHA256_*` digests in the Dockerfile (a
mismatch fails the build, which is the good case), the tool count in the bundle
smoke test if the release changed the read surface (that one fails CI), and the
prose on [Grafana](/servers/grafana/), which names both.

**This is stronger than what it replaced, not weaker.** The client-side bootstrap
compared the tarball against a `checksums.txt` fetched from the same server —
which detects a corrupted download and nothing else. A digest in the repo is
reviewed in a diff, so a re-tagged release fails the build.

**Undo:** `HACKS.md` #68. If Grafana ever ships an npm package, this becomes an
ordinary tree.

---

### 72. The App Platform spec has a size nobody documents, and nothing measured it

A DigitalOcean App Platform spec is refused past some size, and DigitalOcean
publishes no figure for it anywhere. The first thing that ever mentioned it to
strad was the API, on a deploy that had otherwise gone fine:

```
400 error validating app spec field "App spec": size limit exceeded
```

Every production deploy failed on that from 2026-08-30T16:09Z until the config's
inlined form shrank the spec.

**What is known is a range, not a number.** Two runs, same app, same day: a
131,010-byte spec deployed at 04:01Z, and a 141,342-byte spec was refused at
19:18Z. So the ceiling is somewhere in `(131010, 141342]`. 128 KiB is 131,072 —
62 bytes above the accepted spec — which makes it look like the answer and is a
coincidence, not a measurement. Nothing here treats it as known.

**The real problem was that nobody was looking.** Production had been deploying
on headroom nobody had measured — somewhere between 1 and 10,332 bytes, which is
all the two runs establish. The size was printed in two places and compared
against nothing, so the first symptom of crossing the line was the whole deploy
path failing — not one component, everything.

Two things changed, neither of which claims to know the limit:

- **The config no longer travels with its prose.** `STRAD_CONFIG_YAML` was 66,019
  bytes of that 141,342 — 47% of the spec, on the core component alone — because
  `render-spec` inlined the config file verbatim, and 44,209 bytes of that file
  were comment-only lines. It now bakes the document re-emitted without comments,
  checked lossless against the original before the schema sees either, falling
  back to the file's own text if the round trip does not hold or does not shrink.
  Prod's spec: 141,342 → ~96,238 bytes. See
  [the deploy model](/operate/deploy-model/#the-config-travels-without-its-prose-and-the-spec-has-a-size).
- **`assert-spec` reports the size and where it is**, per component, and warns
  past ~80% of the largest spec known to have deployed.
- **`render-spec` refuses to emit a spec past 131,010 bytes**
  (`src/deploy/spec-size.ts`). That is a hard gate, and it is safe only because
  of where it sits: 131,010 is the largest spec `strad-prod` has been observed to
  deploy, so the gate cannot refuse a size that is known to work, and everything
  above it is a size nobody has evidence about. It names the byte count, the
  ceiling, the overshoot and the components and variables the bytes are in — the
  400 it replaces names none of those and arrives three steps later.
  `--max-spec-bytes` raises it for an operator who finds App Platform takes more,
  because prod renders this script straight from `main` and should not have to
  wait on a strad PR to say so.

**What is still true.** The largest remaining block is the `bundle` component's
93 credential variables, about half of them the per-slug aliases of #56. That
grows with the server count, and shrinking it means changing how credentials
reach a container rather than how many bytes they take. The headroom above buys
that redesign time; it does not remove the need for it.

**Undo:** `HACKS.md` #72.

---

### 73. The release path executes on a pull request, but only as far as the push

Every image build in this repo goes through one composite action,
`.github/actions/build-push`. For most of its life every call site sat in a
workflow no pull request could reach — the eight release workflows, on
`push: branches: [main]`, plus `deploy-staging.yml` on `workflow_call` — so
nothing on the pull request path loaded it, and **the first execution of a change
to the release path was also its first production run.** The failure mode is a red `main` plus, when
an image fails to publish, a wedged deploy for every later commit (#54).

On 2026-08-11 a `${{ … }}` written as an EXAMPLE in an input `description:`
merged green and took all eight release workflows down inside twenty seconds —
eight alerts from one merge, and three more merges to settle. `actionlint` was
green on all of it, because it validates an action's INTERFACE and reads neither
its prose nor its shell.

`ci.yml`'s `build_image` and `bundle_image` jobs build through that action with
`push: false`, so every pull request loads and runs it. What that covers: the
manifest parses and LOADS, every input a call site passes is declared, the builder
guard runs, and `docker/setup-buildx-action` → `builder:` → buildx holds together
end to end on the shared self-hosted daemon.

**What a pull request still cannot exercise**, deliberately — everything
downstream of the push:

- the ghcr login, and `packages: write`;
- the push itself, and therefore the three-403 retry of #51;
- `release-image.yml`'s tag-digest verification, which reads the registry back;
- the `VERSION`-offset version arithmetic, which needs `main`'s history;
- `deploy-staging.yml`'s tag resolution (#54) and the deploy.

All five need a registry credential, and the whole point of a pull-request build
is that the run holds none. Reaching them would mean giving a workflow an
unmerged branch can trigger something to push WITH, which trades this gap for a
worse one. So the boundary is drawn at the credential, and drawn twice: no
workflow reachable from a `pull_request` event runs `docker/login-action` or asks
for `packages: write`, and `build-push` folds `github.event_name` into its own
effective `push` — once, in one file, rather than as a condition ten call sites
across nine workflows could each forget.

**Undo:** `HACKS.md` #73.

### 74. strad-fetch decides a page was read by counting characters

`strad-fetch` accepts a scraping strategy on what can be _extracted_ from what it
fetched, not on whether bytes came back — that is what stops a client-rendered
page from being reported as a successful scrape of an empty document. The test is
a **character floor**: clean the page, and under 8 characters of readable HTML
means the strategy could not read it.

Counting characters is a proxy for "is there anything here", and it is coarse in
both directions. A client-rendered page whose static shell carries a nav bar or a
cookie banner extracts to a few dozen characters of exactly that, clears the
floor, and is served as the page's content — the case that was actually reported
(a craigslist search page) extracted to zero, which is the easy one. And a very
short real page sits closer to the floor than anything else does; it has headroom
against every extraction measured that carries a sentence, but that is fixtures,
not a corpus.

The floor is low on purpose. A false escalation costs a paid credential _and_
turns a genuinely short page into "unknown", which is the same over-claiming the
check exists to remove. Judging content rather than counting it would need a model
call — which this fork deliberately removed — or a per-site rule table, which is
what the learned-strategy cache already is and cannot bootstrap itself.

**Two edges it leaves open.** The verdict is reached on at most the first 256KB
of a document, so a page whose entire content sits past that much head and script
is judged on a prefix that never reached it. And a `cleanScrape: false` call that
saves an unreadable page caches the raw bytes without the note saying they could
not be read, so a later cache hit on the same URL serves them plainly — one
container lifetime, since the store is in memory.

**How you would know.** A page reported as read whose content is a navigation
menu. `cleanScrape: false` returns the raw bytes that were served.

See `HACKS.md` #74.

---

### 75. The App Platform plan list is a hand-copied snapshot of DigitalOcean's plan table

`check-config` and `render-spec` refuse a `bundles[].instanceSizeSlug` outside a
closed set — the fourteen current App Platform plans plus the ten legacy
`basic-*` / `professional-*` ones — transcribed into
`src/deploy/instance-size.ts` from the [pricing
page](https://docs.digitalocean.com/products/app-platform/details/pricing/) on
2026-09-02. That is what stops a plausible-but-nonexistent name from parsing
clean, rendering clean, merging, and only then failing at `doctl apps update`.

The list is authoritative at DigitalOcean and static here. DigitalOcean publishes
it as an API (`GET /v2/apps/tiers/instance_sizes`) and nothing reads it, so the
day a plan is added, a config naming it is **refused by strad and accepted by App
Platform** — wrong in the tight direction, with the fix in this repo rather than
in the config being edited. The error names every accepted value, so the
diagnosis is one read of the message.

Calling that API from the gate is not the fix. `check-config` is meant to run on
every pull request in a repo with no cloud credentials at all, and a gate that
reaches the network fails when the vendor is slow. A generated file, checked in
and refreshed by CI, is the honest middle and is not built.

Nor does the check belong in the config schema, which is why a bad slug is caught
by the two deploy scripts rather than by `parseConfig`. That parse also runs at
boot, in every container, and the config versions independently of the image — so
a schema that refused a plan it had not heard of would make an older image reject
the config a newer one wrote, turning a rollback into a crash loop over a field
nothing at runtime reads.

**How you would know.** `instanceSizeSlug "<a plan that does exist>" names no App
Platform plan`, on a slug read straight off the pricing page.

---

### 76. Superseded Secret Manager versions are pruned by one writer of three

`secrets-sync.yml` destroys every superseded version of a `strad-staging-*`
secret after it adds a new one, so each of those secrets carries exactly one live
version — Secret Manager bills every version that is not `DESTROYED`, a disabled
one included, and every consumer reads `versions/latest`.

That workflow is one of three writers of Secret Manager versions in this repo and
the only one that cleans up. The console's rotate (and the parameter write-back
route behind it) and the `secrets` MCP server's write tools both add a version to
the `strad-secrets-*` project and leave the one they superseded enabled. A
credential rotated through either accumulates one billed version per rotation,
and the old value stays readable by anything holding `secretAccessor` on that
secret.

**A precondition.** Destroying needs `secretmanager.versions.destroy` on the
service account behind `GCP_SA_KEY`, and nothing in this repo records which role
that account holds. If it lacks the permission, a sync run adds every new version
(the values are live) and then fails red on the destroys, naming the secrets
whose superseded versions remain. Nothing is destroyed that should not be; the
run is red until the grant is made.

**How you would know.** `gcloud secrets versions list` on a `strad-secrets-*`
secret shows more than one `ENABLED` version. A red `Secrets sync (staging)` run
whose errors read `could not destroy version`.

See `HACKS.md` #76.

---

### 77. The console index describes a multi-store slug by its first store

A `consoleStores:` slug puts several parameter stores on one `/ui/<slug>` page,
selected with `?project=`. The console INDEX at `/ui` did not follow: it renders
one card per slug, and the roster's "which project holds this store" answer is a
single id resolved in this order — the resolver's own `STRAD_PARAMS_PROJECT_ID`
if this process holds one, else the first enabled supplementary server that
declares a project at all, and within it `consoleEnv.SECRETS_PROJECT_ID`, then
`env.SECRETS_PROJECT_ID`, then the FIRST store. The first store is the answer
only when nothing earlier in that order gave one.

**What it costs.** The roster prints copy-pasteable `gcloud` commands for a
missing secret. If the name lives in a namespace owned by a store other than the
first, the printed command names the wrong `--project`. It fails legibly rather
than writing anywhere wrong — but it is a wrong answer to a question a human
asked.

**How you would know.** A `gcloud parameters ...` command copied off `/ui` returns
`NOT_FOUND` for a parameter you can see listed on `/ui/<slug>?project=<the other
one>`. The `SECRETS_PROJECT_ID`-outvotes-the-list case is caught earlier:
`check-config` emits a `::warning::` when that name and the first store disagree
on the server the roster would answer from.

**The fix.** `storeForPath` already resolves a path to the one store that covers
it, across both several slugs and several stores per slug. The index should ask it
rather than reading a project off the config.

See `HACKS.md` #77.

---

### 78. One `/mcp` container fronting several stores lists `get_secret_value` for all of them

`mcpStores:` lets one secrets container front several GCP projects. An MCP tool
list is static per container — a client caches one listing per session — so there
is no way to offer `get_secret_value` for a staging store and omit it for a
production one. strad lists the **union**: the tool exists when at least one
store's credential can back it.

**What it costs.** A guarantee changes shape. With one store per container,
production's was _"the tool does not exist."_ On a container it shares with a
store that can read, it is _"the handler refuses, and Google refuses underneath
it."_ The second half is the one that was always load-bearing — the production
store is read with its **own** viewer credential, which holds neither
`secretmanager.versions.access` nor `parametermanager.parameterVersions.render` —
but a runtime refusal is a different kind of thing from an absent tool.

Nothing about the capability itself is shared: the probe runs once per store and
is memoised by project id, a parameter path binds to exactly one store, and
`check-config` refuses two stores sharing a viewer credential (by key name and by
`${REF}` alike), a project id, or overlapping namespaces. `list_managed_namespaces` reports capabilities per store,
so an agent is never told only the union.

**How you would know.** `tools/list` on a mixed-posture container offers
`get_secret_value`; calling it with a production path returns
`store "…": cannot read secret values`.

**When it does not apply.** A container whose stores all refuse secret reads
lists no `get_secret_value` at all, exactly as before.

**The fix.** Either take the intersection across stores — restoring "absent" at
the cost of the staging read the write surface exists to test end to end — or give
strad a way to express entitlement per **namespace** rather than per slug, at
which point one store per container stops being the only way to split reach.

See `HACKS.md` #78.

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
