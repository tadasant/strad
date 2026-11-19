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

### 93. The `mcp.json` dialect carries one of four kinds, and refuses the rest by name

strad accepts draft
[SEP-2633](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2633)'s
`mcpServers:` map as an [input
dialect](/servers/interface/#mcpservers--the-draft-sep-2633-input-dialect) for
its server list, desugared into `servers:` before the schema sees the document.
It covers `kind: remote-http` and nothing else.

The draft is **open**, not merged. Its reference-implementation section is a
`TODO`, so **there is no published JSON schema** — nothing in strad or in these
docs names a `$schema` — and its `oauth` object is being renegotiated upstream
([SEP-2742](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2742)).
Binding more of it than the part with a direct analog would bet the config
contract on a moving target, in the one file where a mistranslated field silently
changes what a mount executes. So everything strad cannot honour is a **hard
error** rather than a default: `type: "stdio"`, `type: "sse"`, `oauth`,
`command` / `args` / `env` on a remote entry, pipe-chained interpolation
(`${env:A | value:b}`), the `input` and `op` schemes and every other scheme, a
bare `${NAME}`, a `${...}` in `title` or `description`, and a `value:` literal
carrying `$`, `{` or `}` (the SEP defines no escape, and a literal is spliced
into a value that is scanned for `${NAME}` later). A key that is not a
legal strad slug is an error too, with the slug it would have been offered as a
suggestion and never applied — `My_Server` and `my-server` are two legal SEP
names that fold to one slug, and a slug names this server's variables on the box.

The three kinds with no expression are not an oversight in the format.
`mcp.json` is a **client** config: `supplementary-image` is deployment topology,
`builtin` is an in-process import, `bundles:` is the container an image lands in.
The deepest mismatch is `entitlements` / `roles` — `mcp.json` is a
single-principal file, and strad's two-way agreement presumes the config's reader
is not its only user.

**The sharp edge**, and the one thing here that is not an error: an entry with no
`strad: { entitlements: [...] }` attaches a server with `entitlements: []` —
configured, routed, reachable by nobody. `[]` is the only fail-closed answer
available, and a fail-closed answer nothing says out loud is indistinguishable on
a gateway from a routing bug nobody has noticed. So
[`check-config`](/operate/deploy-model/#checking-a-config-before-it-deploys)
warns, naming the slug and both halves of the fix, and boot emits
`strad.mcp_json_unentitled`. Neither fails anything: an `mcp.json` with no
entitlements is a valid config, not a broken one.

**Undo:** widen it when the SEP does. A published JSON schema and a settled
`oauth` object are the two events that change the calculus; `type: "sse"` becomes
expressible the day strad grows an SSE adapter. `stdio`, `supplementary-image`
and `builtin` do not converge and should not be forced to.

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

And a listing now retries an upstream's JSON-RPC `-32603` before it reports one
(#475). A persistent `-32603` still pages once the retry budget is spent, but an
_intermittent_ one — the shape a two-methods-in-flight failure can take — is
absorbed and shows up only as an Info `mcp.list_retry` record. Nothing pages on
that; a rate alert on `mcp.list_retry` per slug is the only signal for that class.

It has also been narrower than a second, plainer failure: a slug can list its tools
perfectly and fail every _call_. Fetch redesigned its login form to floating labels,
the `fetchpet` mount's email selector went stale, and it spent weeks in both
environments listing four tools and returning `Login failed` for every one. Tool
lists are static; a login is not. Every deploy in that window passed, and the only
symptom was a `WARN` line on stdout, a stream that
[reaches nobody](/operate/telemetry/#logs--strads-own-events-and-only-those). It
happened again, in prod, on 2026-08-28: `good-eggs` listed its tools while every
authenticated call returned `Login failed: page.waitForURL: Timeout 30000ms
exceeded`.

That second blind spot is **reported, not gated**. The bundle's `/healthz` carries a
per-mount `degraded` string for exactly this, and core reads it on the monitor's
interval: a
[`strad.mcp.mount_degraded`](/operate/telemetry/#stradmcpmount_degraded--does-the-bundle-say-a-mount-is-unwell)
gauge per slug, a `strad.mount_state` event on change, `mountDegraded` and
`mountUnread` on core's [`/healthz`](/operate/operations/#health-and-console-surface),
and a warning from the staging deploy. So the monitor does ask a second question —
of the bundle rather than of the mount — and the heading above is about the one
it asks the mount. What crosses is one bit per slug — the bundle's reason is
upstream text (`login failed: …` quoting whatever page the login died on) and is
dropped where core parses it. So:

- **Nothing fails on it.** A bit cannot say whether a mount is a failed login the
  next call retries, a credential nobody has set, or a refresh token to re-set
  through a tool, and only some of those are a deploy's fault. The staging deploy
  annotates and passes.
- **The why is still on the bundle.** Its own `/healthz` and its container log name
  the reason; nothing core exports does.
- **The gauge holds its last value while a bundle cannot be read.** Under cumulative
  temporality a series with no new reading keeps exporting the old one.
  `mountUnread` names the slugs affected, `strad.mount_report` says when a bundle's
  report went unreadable and when it came back, and `strad.mcp.tool_surface` shows
  a bundle that is down.
- **The deploy's read is one moment.** It waits for a core observation newer than
  the one its first read saw, which is after most boot-time logins resolve; a
  login that fails later reaches the gauge, not that run.
- **It does not page.** `strad.mount_state` ships at Info, because one bit cannot
  tell a failed login from a credential deferred on purpose. Alert on the gauge,
  scoped by slug.

**Undo:** two halves. Give the probe a mixed-method shape — a concurrent
`tools/list` + `resources/list` per slug, with "answers one but not both"
classified as `degraded`; the cost is a second round trip per slug per interval
against containers that already share one CPU (#24). And make the bundle's report
something a deploy can fail on: the bundle host authors a closed-set class where it
sets `degraded` (`login_failed`, `credential_missing`, `token_invalid`), and the
staging deploy fails on the classes that are its own fault. Classifying the reason
string in core instead would let an upstream's error message pick the class. The
export is done; the class is what is left.

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
into a cache named `strad-shell-v2`. Renaming that constant is what evicts the old
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
app. Open it on an expired session and the gate answers `/connectors` with a 302 to
`/console/login`, which redirects on to `accounts.google.com` — outside the app's
scope, so the browser takes the navigation out of the app window and into a tab.
You return through `/console/oauth/callback` and land back on `/connectors`.

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

---

### 89. The console link opens a parameter list, not a parameter

`open_secrets_manager` is how an agent helps with a secret it must never see: it hands back a URL for a human to open. That URL addresses a **store** and a **namespace** — never a parameter. On a namespace with dozens of rows the human scans for the one the agent meant, and the agent's job is to name it, which is what the tool's `instructions` tell it to do.

The reason is the console rather than the tool: `/ui/:server` reads `project` and `ns` off the query string and renders the rows of one namespace, and those rows carry no identity a URL could address. So a parameter-level landing is not a key away — it is a per-row anchor, a selected state, and a query key to read them with.

The tool did carry the canonical path as `?param=`, which bought the human nothing (no handler read it) and cost them a false expectation, since the prose around the link promised the parameter. That claim is withdrawn rather than implemented, and `the tool writes no key the page it opens does not read` in `servers/secrets/shared/test/console-link.test.ts` pins the emitted key set against what `/ui/:server` actually reads, so the mismatch cannot return quietly.

**How you would know.** The `instructions` the tool returns say it: the link opens the store's parameter list, and the parameter is named in the message the agent sends.

See `HACKS.md` #89 and [Secrets](/operate/secrets/).

---

### 90. The good-eggs freebie tool checks two pages, not the store

`search_for_freebie_groceries` looks for `$0.00` items on the Good Eggs homepage and `/fresh-picks`, and nowhere else. On the 2026-08-23 shop, two "TRY ME!" samples were live and orderable while this tool found nothing, and only a keyword search for something unrelated turned them up. Where Good Eggs had them listed was never established — most likely off those two pages, but a scrape that missed them on-page would look the same. Either way the tool can miss freebies, and nothing short of a catalog-wide sweep would stop that.

That sweep is not built — Good Eggs' search may not expose a price filter at all, so it would be a new traversal. What the tool does instead is claim only what it checked. The description and every result, errors included, name the two pages. An empty result says what this check found on them, says it does not mean no free items are available, and tells the caller to count any `$0.00` item in a `search_for_grocery` result as a freebie too. The upstream answer, _"No free items or deals currently available."_, is not something this server says: an agent took it at its word.

**How you would know.** The tool's own answer says it. Every result names the two pages it checked, and an empty one says in its second sentence that it is not a statement about the store.

See `HACKS.md` #90 and `servers/good-eggs/FORK.md` #10.

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
also depends on the bypass, and it is the only standing credential an automated
actor can hold for the console. A single-use
[console login token](/auth/overview/#console-login-tokens-the-automated-actors-door)
it mints is what the actor should hold instead.

**Undo, in this order:** provide `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`, set
`auth.google.enabled: true`, verify a real sign-in in prod, then set
`consoleDevBypass.enabled: false`, and only then delete `src/auth/dev.ts` and its
call sites. `src/ui/console-auth.ts` imports from that module; deleting it before
Google sign-in is verified leaves the console with no fallback authenticator. See
[Auth](/auth/overview/#console-dev-bypass-temporary).

### 20. The dev-bypass "session" is the bootstrap token in a cookie

A Google login mints a real signed, expiring session — see
[Auth](/auth/overview/#the-console-session). The **bypass** half of the gate is
not one: when `ADMIN_BOOTSTRAP_TOKEN` is presented as `?token=`, the
gate moves it into an HttpOnly, `SameSite=Lax`, Secure-in-prod cookie
(`strad_console`) and redirects to a clean URL, so the token isn't left in the
address bar or in screenshots — but the cookie **is** the standing credential,
re-validated on every request rather than a session in its own right. It is scoped
to `/` rather than a console subtree, since the gate covers the splash too; it therefore
rides along to `/mcp`, where it is inert — that endpoint reads the `Authorization`
header via the static token store and never looks at cookies.

Same scope as #2: it is console-class only and cannot reach `/mcp`.

**Undo:** it goes away with the dev bypass itself.

### 97. A console session cannot be revoked one at a time

A Google console session is a signed cookie with no server-side record. It
renews while it is used and dies at an absolute cap counted from the sign-in —
48 hours sliding and 7 days absolute by default, set under
[`auth.google.session`](/servers/interface/#authgooglesession). Until then
nothing ends one session early. The only lever is rotating
`CONSOLE_SESSION_SECRET`, which signs **everyone** out.

Renewal is what makes this worth stating. A stolen cookie the thief keeps using
renews itself exactly as the owner's does, so it lives until the cap: up to 7 days
after the owner signed in, where a fixed 12-hour session would have given it 12
hours. The same
holds for a person removed from the Workspace: strad does not ask Google again
after sign-in, so a session they already hold runs its clocks out. Lower
`absoluteTtlSeconds` if that is too long for your deployment. The schema will not
let it go past 30 days.

**How you would know.** You would not, from strad: there is no list of live
sessions to look at. That absence is the limitation.

**Undo:** a durable session store, shared with #43's login tokens, that renewal
checks and the console can strike a session from. See `HACKS.md` #97 and
[Auth](/auth/overview/#the-console-session).

### 6. Token records live in an env var, not a database

**Resolved** for a store-backed deployment, with two narrower residuals.

`auth.staticTokens.store: parameter-store` files the records at
`/strad/{env}/gateway/static/STRAD_TOKENS`, reads them on the request path and
writes them from the SSO-gated console at `/tokens`. Minting and revoking land on
a running gateway — no restart, no deploy. It is not a database: the records are
a few hundred bytes that change a few times a month, Parameter Manager is already
there and already credentialed, and a database would be a fourth App Platform
component with a migration story. See
[Managing tokens](/auth/overview/#managing-tokens-the-tokens-console).

`auth.staticTokens.store: env` remains the default and behaves exactly as it
always did: `STRAD_TOKENS` is a JSON array of token records (SHA-256 hashes only
— the plaintext is shown once at mint and never stored), read once at boot, and
minting or revoking means editing the secret and redeploying. `/tokens` still
renders the roster there; it says why it cannot write rather than offering a form
that would always fail.

What remains under `parameter-store`:

1. **No compare-and-swap.** Parameter Manager has none, so a write is a
   read-modify-write whose read is a live `:render` through the gateway's
   resolver immediately before the write.
   Two humans minting inside that window lose one of the two mints — the same
   limitation as [#91](#91-a-rotated-refresh-token-can-be-overwritten-by-a-re-seed).
   A lost mint is a token that does not work, which is loud; revoke and forget
   are keyed on a token id and applied to whatever the fresh read holds, so they
   cannot silently resurrect a record.
2. **"Effective on the next request" assumes one core instance.** The write drops
   the reading held by the process that made it, and core runs one instance. A
   second one would keep serving a revoked token from its own snapshot for up to
   `gateway.secrets.ttlSeconds` — a day by default — with nothing saying so.
3. **Revocation is stale for the length of a store outage.** The runtime provider
   serves its last known good reading when a re-read fails, because a store
   outage must not take `/mcp` down. So a revoke made while the store is
   unreachable takes effect when the store answers again. Nothing is _admitted_
   from a stale reading: a token that was not in the last good reading is
   refused, and a store that cannot be read at all fails the request closed.

**Undo the residuals:** a backing with compare-and-swap, or a records document
whose writes commute; and, for the second, either broadcasting the invalidation
between core instances or refusing more than one.

### 94. The authorization server in front of `/mcp` has no datastore

`/mcp` accepts access tokens from [strad's own OAuth 2.1 authorization
server](/auth/overview/#mcp--oauth-21-interactive-clients), which authenticates
the human behind them with Google. strad has no database, so every value in that
flow is a self-contained sealed blob rather than a row — a dynamic client
registration _is_ the `client_id`, and codes and tokens are encrypted payloads
under keys only the process holds. Four things follow, and none of them is
hidden:

- **An authorization code is single-use against a per-process set.** It holds
  sixty seconds of entries. strad core runs one instance; scaled wider, a code
  replayed against another replica inside that window would not be caught there.
  PKCE is mandatory and `S256`-only, so whoever intercepted the code does not
  hold the verifier — that is what actually stops the attack.
- **Refresh tokens are not rotated.** Rotation detects the replay of a stolen
  token, which needs a record of the token just spent. There is nowhere to keep
  one, so minting a new string while the old one stayed valid would be the
  appearance of rotation without the property.
- **Revocation happens at Google, per user and per OAuth client.** A strad
  refresh token embeds the Google refresh token behind it, and `POST
/oauth/revoke` calls Google — there is no strad-side denylist, because an
  in-memory one would come back to life on the next deploy. The upside is that
  revocation is durable and survives every restart. The cost is the granularity:
  revoking one connector signs that account out of every strad OAuth connector it
  holds.
- **An access token cannot be revoked before it expires**, because it is verified
  with no lookup. The one-hour default is therefore also the revocation window,
  which is what the five-minute floor on `accessTokenTtlSeconds` is for.

Two more follow from **open registration** instead, and are stated for the same
reason:

- **strad's domain is an open redirector to anyone who can POST.** Registration
  takes no credential, and RFC 6749 requires an authorization error to be
  delivered to the client's registered `redirect_uri` — so a stranger can
  register `https://evil.example/x` and then hand somebody an `/oauth/authorize`
  link on strad's hostname that `302`s straight off it, with no cookie, no
  consent and no Google hop. Inherent to open dynamic registration; the value is
  phishing rather than access, because nothing about it yields a token.
- **One browser runs one authorization at a time.** The in-flight transaction is
  one cookie at a fixed name, so a second `/oauth/authorize` in the same browser
  overwrites the first and that tab comes back to "this sign-in has expired".

And a last thing that is absent rather than degraded: **the console cannot list
or revoke issued grants**, because a stateless token leaves no record to render.
Revoking access today means Google's own security page, the Workspace admin
console, or `POST /oauth/revoke`.

**Undo:** a `GrantStore` interface with one Postgres implementation retires the
first, second and fourth together, and gives the console page something to read.
The third stays Google's shape unless strad mints its own grant identity, which
it should not.

### 105. A client id metadata document is fetched on an unauthenticated request

strad accepts an `https` URL as a `client_id` — a [client id metadata
document](/auth/overview/#client-id-metadata-documents) — and fetches it at
`GET /oauth/authorize`, before anyone has signed in. It is on whenever
`auth.mcpOAuth` is.

- **Anyone can make strad fetch a public `https` URL.** The fetch is `https`
  only, refuses any name that resolves to a private, loopback, link-local or
  reserved address (checked on the lookup the socket actually uses), follows no
  redirect, and stops at 5 KiB and five seconds. The destination is still the
  caller's choice, and a failure is never cached, so a repeated request is a
  repeated fetch. At most sixteen fetches run at once; past that a sign-in is
  refused as busy, which a caller flooding the endpoint can use to make a real
  sign-in fail until it is retried.
- **A document cannot vouch for a loopback redirect URI.** Any program can
  present VS Code's document URL and listen on its port. The consent screen names
  the publishing host and warns when the code is going to a program on the
  machine; nothing stronger exists without client attestation.
- **The token endpoint does not re-fetch.** The grant is bound to its client at
  `/authorize`. A publisher that withdraws its document does not end grants
  already issued; revocation is Google's, as above.
- **The document cache is per process**, bounded to an hour and respecting
  `Cache-Control`.

See `HACKS.md` #105.

### 98. Console login tokens live in core's memory

A [console login token](/auth/overview/#console-login-tokens-the-automated-actors-door)
and the 30-minute session it opens are records in core's memory. A restart ends
every one of them, and every deploy is a restart. That is sound only because core
is a single process, which is hard-coded in the app spec. If that ever changes,
it fails closed. A mint on one replica is `invalid_token` on the other, and a
revoke that lands on the wrong replica is a `404` rather than a false "revoked".
A lost token or session is the whole cost: a token can never be spent twice, and
no session is issued that should not exist.

An automated actor has to treat a failed exchange as "mint again once, then
stop", never "retry the same token", and a deploy in the middle of a run looks
exactly like that.

A token session can view the console and cannot act through it: no reveal, no
store write, no connector, no playground tool call. That is what keeps a leaked
session from reading or planting a durable credential. It also means an automated
actor cannot drive the console's write forms. Doing that would take a mint-time
capability, which is not built.

Minting takes a standing console credential: the bootstrap token (through the
bypass, [#2](#2-the-console-dev-bypass-stands-in-for-google-oauth)) or a Google
session. When the bypass goes, a Google session is the only minter left, so a
CI job that mints for itself will need a standing credential that survives it.

**Undo:** keep these records in the same shared store as a database-backed
[#6](#6-token-records-live-in-an-env-var-not-a-database), with the
compare-and-set as a conditional write there, before core runs more than one
replica.

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

### 24. Thirty-four servers share one process and one CPU

The `bundle` component runs one Node process that mounts thirty-four MCP servers,
launches one shared Chromium and supervises one `mcp-grafana` child process, on
`apps-s-1vcpu-2gb`. A crash in the host takes all thirty-four down together, and
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

### 85. Staging is asleep, not gone — and it is archived rather than deleted for a reason

Staging is on demand. `teardown-staging.yml` archives `strad-staging` nightly,
which stops App Platform billing for all three components; dispatching
`deploy-staging.yml` brings it back. Merging to `main` no longer deploys it, so
**nothing smoke-tests a released image on real infrastructure until someone asks
it to** — that is the trade, made deliberately, because the app billed 30 days a
month for roughly 5 days of use.

The teardown does not delete the app, and could not. `strad-staging` serves
`staging.strad.tadasant.com` on a certificate App Platform issues for that app,
reached by a Cloudflare CNAME naming that app's own
`strad-staging-wy9v5.ondigitalocean.app` starter hostname. DigitalOcean's own
instruction is to remove a custom domain before deleting the app it belongs to,
because a domain left attached may keep pointing at the deleted app **for up to
24 hours** and be unavailable to a new one meanwhile — and the replacement app
would answer on a different starter hostname anyway, in a DNS zone nothing in
this repo holds a credential for. See [DNS & domains](/operate/dns/).

Two consequences to know about:

- **An archived app still exists.** `doctl apps list` shows it, and
  `https://staging.strad.tadasant.com` serves App Platform's offline page over a
  live certificate. Liveness has to be read from `maintenance.archive`, not from
  the app's presence.
- **Archiving does not stop billing for databases or dedicated egress IPs.**
  `strad-staging` has neither today. One added to the spec would keep billing
  through the night, silently.

**Undo:** disable the `schedule:` in `teardown-staging.yml` to keep staging up,
at roughly $49/month.

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

### 32. Prod's second first-party image is pinned by hand

Staging is covered: `deploy-staging.yml` resolves `sha-<commit>` for the bundle
exactly as it does for the core, passes it on every deploy, and passes
`--require-immutable-images`, under which `render-spec` refuses to emit a spec
where any component ships a tag that moves.

Prod's `ghcr.io/tadasant/strad-bundle` is covered the same way.
`strad-deploy-prod.yml`, in `tadasant-internal`, resolves a bundle tag, passes it
as `--bundle-image`, and passes `--require-immutable-images` as a hard gate.

The gap is the **second** image. Prod also mounts
`ghcr.io/tadasant/strad-bundle-internal`, behind the `craigslist` slug, and
`--require-immutable-images` refuses a moving tag on any component — so that
repository has to be pinned too. It is pinned by hand: a literal `:sha-…` written
into `strad.prod.yaml`.

That pin fails silently. Nothing moves it when a new `strad-bundle-internal`
publishes and nothing reads it back, so the deploy stays green while App Platform
pulls the digest somebody typed in weeks ago and prod runs the previous code.

`--bundle-image` is repeatable — once per image repository, each occurrence
matched on its own and each required to match something — which is what makes the
pin removable. Doing it is two changes in `tadasant-internal`: resolve a
`strad-bundle-internal` tag and pass a second `--bundle-image`, then put
`:latest` back in the config where the sha is. It needs no credential and no IAM
change.

Once that lands, the per-override rule couples the two: disabling `craigslist`,
the only slug on `strad-bundle-internal`, fails every prod render until the same
change drops that `--bundle-image`. That is intended — the alternative is a
deploy that believes it pinned an image nothing runs.

**Undo:** make those two changes in `tadasant-internal`
([#1952](https://github.com/tadasant/tadasant-internal/issues/1952)).

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
`auth.google.enabled: true` is a front-door outage on the console — deploys green.
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

The fix is to bake what those components cannot fetch. `OTEL_EXPORTER_OTLP_HEADERS`
is baked from the **store**. `STRAD_INTERNAL_TOKEN` is not copied at all: the
renderer reads the root from the store and bakes each non-core component its
**own** token derived from it ([#63](#63-one-internal-token-means-any-container-can-reach-any-writable-parameter)),
so the root stays on core. Three checks then guard it, and they answer different
questions: preflight asks whether the store **holds** a required name; the render
fails when the root **resolves to nothing** and a non-core component exists, which
presence cannot see; and `bootEnvGaps()` fails it when a component in the rendered
spec holds neither a boot key it needs nor the credential to fetch it, and when
any non-core component lacks its derived token. The OTLP header is not on the
required list — an ingestor that needs no auth is ordinary — so an endpoint with
no resolvable header is a warning naming the parameter. What that costs, stated
rather than hidden: rotating either name is a **redeploy**, not a restart, and
rotating `STRAD_INTERNAL_TOKEN` must be a redeploy even for core, since core
hydrates the root and a restart of core alone would leave it deriving tokens no
component holds, with every presence route and mount answering 401.

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
running gateway holds it for `gateway.secrets.ttlSeconds`, a day by default,
and every namespace it serves — the providers, a `params: true` builtin, the
console's diagnosis — is a slice of it: one enumeration plus one render per
parameter per TTL, ~68 billed reads at production's 34 parameters, whatever the
server count. The console's own admin client holds a reading of its own for
five minutes: a write through it re-reads only the parameter it touched, so a
page load reads nothing and an action costs a few requests rather than two per
parameter in the project. Every write through the console, its **Re-read the
store** button, and the `secrets` MCP server's `refresh_gateway` tool (which its
write tools call for you) drop the gateway's reading so the next read reaches
the store; the button and `refresh_gateway` drop the console's too. See [what "immediately"
means](/operate/secrets/#what-immediately-means) for the resulting bounds and
[the cost model](/operate/secrets/#one-reading-of-the-store-per-process) for the
numbers.

Every client also remembers the envelopes it has read. A version is immutable,
so a re-read lists every parameter's versions but only fetches the ones that
moved: a cold read costs 2P requests, a warm one P, and neither bills a
`GetParameterVersion` for a parameter that did not change. A parameter whose
read fails no longer fails the console's listing: the page shows the rest and
names the one it could not read. The resolver's strict read still fails on it.

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
thirty-four of them, most written by other people.

`strad-fetch` builds its scraping clients inside a factory the host invokes per
request, so a rotated key is used by the next tool call; that is the case the
feature was built for. A server that snapshots its credential at mount time and
memoises a connection does not: `telegram` holds one MTProto session for the life
of the process, `grafana`, `google-sheets`, `gmail` and `google-docs` build a
client per mount, and `x-twitter` caches its OAuth provider deliberately, because its token rotates
in memory and re-reading would fight that. For those the refreshed value sits in
the environment, correct and unused, until the container restarts.

`gmail` and `google-docs` are on that list because a snapshot is what makes
per-slug mounts work at all: several of each share one process, one per Google
account, and a live view of `process.env` would give every one of them the last
account's credential.

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
top-level `unconfigured` list), the connectors roster (chip `awaiting credential`,
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
under `gcp-parameter-store` activates within `negativeTtlSeconds` (default 1
hour; at once if seeded through the console or the `secrets` MCP server) with no
redeploy, while a
`supplementary-image`'s `env:` — and everything under
`provider: env` — is baked onto a container strad does not run and needs the next
deploy. The render says which it is in the warning, but "no PR" and "no deploy"
are not the same promise. The baked half also reports less: `unconfigured` is a
state strad derives from a resolution it performs itself, so a slug whose only
waived name is a `supplementary-image` `env:` variable ships without that
variable and reads as whatever its own server says about itself. See
`HACKS.md` #70.

### 29. The console's secret badges prove presence, not that a credential works

`/connectors` lists every configured MCP server and whether the secrets it requires
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
where nothing could answer, and it is its own `UNVERIFIED` badge, kept out of the
issue count.

Two answers are one step weaker than they look. A store-backed deployment's
supplementary `env:` name that the store does not hold reads `UNVERIFIED` when its
bundle does not answer the presence probe, not `not seeded`: render-spec falls
back to the deploy environment (`strad-<env>-*`) for it, core cannot see that, and
a missing value would have failed the render. So a value deleted from Secret
Manager after the last deploy, on a bundle that is not answering, is not caught
here until the next deploy refuses it. And a `params: true` server whose component
named no parameters is graded on the store instead, so its `plumbed` means "in the
store and renders", which reaches a supplementary image's container only at the
next deploy.

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
`/secrets` and `/ui` redirects in `src/ui/index.ts`, and revert
`src/ui/roster-page.ts` to the plain roster it renders around. Nothing else reads
any of it.

### 35. The presence probe asserts about the process, and the process can lie by being old

`/connectors` and `/api/secrets/readiness` now make a positive claim about a secret that
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
choosing exists. The route takes the component's own `STRAD_INTERNAL_TOKEN` —
the token core derives for that component and nothing else holds, strictly
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
`unverified`, but no rows. That is the state `/connectors` explains least well by
construction, and it is the one that produced a **dead control** in production:
the entry rendered an `ISSUE` button over a `<dialog>` that was never emitted, so
the click did nothing at all ([#259](https://github.com/tadasant/strad/issues/259),
live on `craigslist`). The popout is built from the probe outcome instead — which
component holds the value, which of the five ways the probe went unanswered,
and the `/strad/<env>/mcp/<slug>/static/*` prefix to look under — so the badge
leads somewhere. It is still not an observation. Making it one is the same pin
bump, on that component's image.

**A server that declares something else is graded on both.** The managed
namespace is a requirement in its own right, ranked `unobservable`, so an
unchecked one demotes the entry to `unverified` whatever its `${NAME}` references
did. A `READY` badge is never earned by checking a part rather than the whole
([#265](https://github.com/tadasant/strad/issues/265)). The popout gets its own
first line there: the `unverified` headline ("this page could not check this
server's credentials") would contradict the rows under it.

**A `params: true` builtin's panel says something else entirely, and the badge
still never goes green.** A builtin runs inside a strad process, which resolves
its parameters itself, per tool call, out of the resolver's snapshot — so the
container panel's whole vocabulary (a private URL to bind, an image to repin, a
container to redeploy, a value that lands at the next deploy) is false about it.
A confidently wrong panel is worse than an inert chip, so it got no panel at all
before [#264](https://github.com/tadasant/strad/issues/264); it has three reasons
of its own — `in-process`, `delegated`, `inert` — whose sentence about when a
write takes effect is `gateway.secrets.ttlSeconds` rather than a deploy. What
that does **not** do is make the parameters observable. `core` is never probed,
so the gap is permanent for `echo` in staging: nothing an operator seeds clears
the badge, and `/api/secrets/readiness` reports `ready: false` for as long as the
deployment carries such a server. The badge leads somewhere; it still cannot be
cleared.

**And on one shape the two doors disagree about the credential.** The panel
reproduces `resolverFromEnv`'s three exits, so a key JSON that is _set and
unparseable_ reads as `inert` with the key named as the problem.
`/api/secrets/readiness` derives its `resolverCredential` from set-ness instead,
so on that deployment it reports a credential as present and says `params: true`
servers resolve their parameters. The JSON field is self-consistent about what it
measures — its own `detail` says "are not both set" — and changing what a
published field means is a wider decision than the panel that surfaced it.

**The `cannot render` diagnosis can lose a race and simply not appear.**
`readStoreDiagnostics` gives its two store reads six seconds together, and the
per-parameter render pass is bounded at a fan-out of ten. A large namespace can
exceed the deadline, and then the diagnosis returns null and the state is not
drawn — the console degrades to the states it had without it, never to a wrong
one.

**The diagnosis is as old as the process's reading of the store, and says so.**
It is answered from the same reading the gateway resolves `${NAME}` through,
held for `gateway.secrets.ttlSeconds` (a day by default), and the pass over it
is reused for up to a minute, so a `/connectors` reload and a hard poller on
`/api/secrets/readiness` cost no store read at all inside the TTL. The cost of
that is freshness: a value written by anything other than this console can take
up to the TTL to change a row, and a store that breaks — a revoked resolver key,
lost IAM — can look healthy for that long, which at the default is a day. So the
age is printed rather than hidden — the console says when the store
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

**Undo:** move `bearerToken` and `constantTimeEquals` out first — every door
authenticates with them — then delete `src/secrets/presence.ts`,
`src/secrets/store-diagnostics.ts`,
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

### 99. An `oauth:` connector needs the console to read its OAuth client

A [connector](/operate/connectors/) reads the slug's client id and client secret
with the console's own credential, and for a secret parameter that read is Secret
Manager's `versions.access`: the permission the
[write-never-read console](/operate/secrets-iam/#1-prod-console-write-but-never-read)
withholds. So every connector needs `roles/secretmanager.secretAccessor` for the
console's service account, **on that slug's two client secrets and nothing
else**.

**✅ The grant is no longer a human step.** Creating either client value from the
console makes the binding as part of the create, and a connector seeded before
that offers **Grant read on this client** on its own page, beside the refusal
that diagnosed it. Which paths qualify is derived from the config's `oauth:`
blocks — no field on any form can ask for it — and the `oauth/` kind is never
granted, so the credential strad mints and stores there stays unreadable to the
console.

**What is left is the deny policy fork, and it is why this entry stays.** The
`strad-console-no-read` deny policy from **#31** is evaluated before any allow
and cannot be granted around, so on a deployment that applied it the binding
writes successfully and buys nothing. strad therefore **reads the value back**
before it claims the grant worked, and says so when it did not — naming the
permission, the resource and the deny policy — rather than letting **Connect**
fail after the human has already consented. A deployment that applied the deny
policy has decided its connectors need a human, and keeps the hand-run grant
documented in
[Secrets IAM](/operate/secrets-iam/#an-oauth-connector-reads-its-own-oauth-client).
Keeping both would mean tagging the connector's client secrets and exempting that
tag in the deny rule's condition — a deny rule can match resource tags but not
resource names — which strad has neither built nor tested.

**And the audit cost is real.** The console granting itself read is exactly the
escalation **#31** describes, and doing it on a button makes a conspicuous act a
routine one. What replaces the conspicuousness is a record: a
`strad.connector_client_granted` event naming the slug and the variable at the
moment it happens, and `strad.connector_client_grant_failed` at ERROR when the
binding landed and the value still could not be read.

When the grant is absent, **Connect** refuses on the page, at 409, naming the
permission and the exact resource, and emits `strad.connector_connect_failed`
with `reason: client_unreadable` and `status: 403`. It is a 409 because the App
Platform ingress replaces an upstream 5xx with its own edge page, which would
drop the sentence that says why.

**Undo:** a connector that never reads its client through the console at all,
which would close the exception rather than automate it. Seeding the client id as
a non-secret parameter halves it. Running the code exchange in the slug's own
container, which already has both values in its environment, removes it.
`HACKS.md` #99 has both.

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

**Resolved for strad.** Every strad job runs on a GitHub-hosted runner, a fresh
VM per job, so nothing shares its `/tmp` or its docker daemon; the fixes below
stay because they cost nothing and hold if a job ever lands on a shared machine
again.

strad's CI ran on **self-hosted** runners, which meant several runner
_processes_ shared one machine — and therefore shared `/tmp`. This repo's staging
deploy rendered its App Platform spec to `/tmp/spec.json`; so did the prod deploy
that lives in a separate private repo. Nothing coordinated the two.

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

**Not only the spec.** On long-lived shared runners any job can claim any fixed
name — a path, a container, a host port, an image tag. The prod deploy has not
moved off `/tmp/spec.json`
([#115](https://github.com/tadasant/strad/issues/115)), and on whatever runners it
shares that is the instance that remains open; no strad job is among them. The
docker half is closed: every job in this repo that builds
an image and runs it tags it per run, because a concurrent job rebuilding a
shared `strad:ci` between the build and the `docker run` lets an assertion pass
against an image the run never built — the "`/mcp` with no token returns 401" one
in `ci.yml` ([#117](https://github.com/tadasant/strad/issues/117)), the mount
count in `bundle-google-ci.yml`
([#119](https://github.com/tadasant/strad/issues/119)), and the pinned `op
--version` that gates the published 1Password image
([#126](https://github.com/tadasant/strad/issues/126)). The durable fix for the
class is ephemeral runners, which is what strad's CI runs on.

**Why the name check, and not just "has a name."** One second later on the clock
and staging's `doctl` would have read prod's _complete_ 91302-byte spec — valid,
naming `strad-prod`, carrying prod's images and prod's secrets — and replaced the
staging app with it. That deploy would have gone green.

### 37. Exported logs are an allowlist, so most of stdout reaches no ingestor

strad ships its own structured events as OTLP logs, against a per-event field
allowlist. It does not ship the stdout stream — that carries upstream-authored
text, and the whole point is to keep it out of an external ingestor. Thirty-two
event types are on the allowlist and seven are deliberately off it, each with its
reason written beside it in `NOT_EXPORTED`.

Five consequences worth knowing before you go looking for something and do not
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
- **A refusal is a slug and a count, and no more.** `mcp.tool_denied` exports
  its slug and `strad.mcp.tool_denials` counts it per slug. The tool name the
  caller asked for is free text a client writes, and `principal` is a token
  `pubid` through `/mcp` but a signed-in human's Google `sub` through the console
  playground — so both stay on the stream. "How often is this slug refusing
  calls" is a query; "which tool, and who" means reading the container console.
- **The lines that say the exporter is off are on the console only.**
  `telemetry.disabled`, `telemetry.start_failed`, `errors.started` and
  `errors.start_failed` each fire at a moment when the exporter that would carry
  them is not running, so they are blind by construction rather than by
  redaction. `telemetry.started` does export — its name and nothing else, and
  from the strad image only — which is what separates "the container never
  started" from "it started, telemetry was fine, and boot died mounting a
  server".

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

### 82. Tool descriptions are written to a client's 2048-character cut

Claude Code truncates an MCP tool description at 2048 characters. It says so in
its own connection log and never tells the server, so a description longer than
that does not fail anywhere; it stops arriving. Production's log named four of the
artifact store's seven tools, and by the time they were fixed `upload_file` was
4111 characters: more than half of it, off the end, where the use cases and the
link-handling guidance are.

Every description in that server is now held under `DESCRIPTION_BUDGET`, asserted
over every tool the server defines so that a new tool cannot regress unnoticed.
The four that were over the line were rewritten to fit rather than cut at the
tail.

The room is tight and stays tight. The shared link-handling block is 1067
characters and three tools carry it verbatim, so half of each of those budgets
goes before the tool describes itself, and the four rewrites land 46 to 57
characters below the ceiling. An addition to one of them costs a removal. Five
things came out for that reason, and [the artifact store
page](/servers/artifact-store/) carries all five with no budget of its own: the
example response, the `access`-values glossary, the caveat that a multi-replica
deployment needs sticky routing for an upload token, three sentences of
motivation from the link-handling block, and the long form of the `is_sensitive`
argument. Only the example response is new prose there; the rest was already on
the page. That last argument also still reaches an agent in full through the
parameter description, which is not what this client cuts.

2048 is a client's cut rather than the protocol's. MCP puts no ceiling on
`description`, and other clients cut at other lengths or not at all, so this
server writes to the smallest limit anyone has measured.

See `HACKS.md` #82.

---

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
as `strad-fetch` and the three forks in `bundle-api`.

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

Past orders go the same way as the basket. `get_past_order_groceries` finds an
order by comparing its delivery date with `storeData.populatedPastOrders`, then
reads the items from that order page's `storeData.order.items`. It does not
search the drawn `/account/orders` page for the date's text: that page draws
`Monday 9/21`, a text search cannot match the `Monday, September 21st` form the
list tool hands out, and on 2026-09-21 it left that day's order unreadable for a
day.

**Undo:** if upstream ever publishes `shared` as a library carrying these fixes,
depend on it and delete the fork.

### 55. The slack server is a fork, and only its tests defend the delta

`servers/bundle-api/fork/slack/` is a FORK rather than a vendor copy. Three of the
six servers in `bundle-api` sit in `upstream/` and are copied verbatim; slack
sits in `fork/` alongside `google-flights` (#58) and `monarch-money` (#80), and
strad has edited its tool definitions.

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
`$HOME`, several concurrent runner processes — ended when every job moved to GitHub-hosted runners in November 2026, each one a fresh VM.
The fix stays because it costs nothing and holds on a shared machine, and the
condition is written down here for whoever lands a job on one again.

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

**No retry was added.** With an explicit builder nothing on a shared box can reach
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

**A cancelled build is the same wedge for a commit nobody broke.** On 2026-09-04,
while CI ran on self-hosted runners, the runner host restarted mid-build. `a278b5ed`'s bundle build was
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
concurrent runner processes — is the same one behind #53, and ended with it when
every job moved to GitHub-hosted runners in November 2026, each one a fresh VM. It is written down here for the same reason.

`~/.docker/config.json` is where `docker login` puts a registry credential, and
on a self-hosted box there is one of it per machine, because every job runs as
the same user. Nine jobs
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
than the longest — the bundle alone is twenty-five dependency trees. Isolation costs a
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

- **A newly seeded per-server name takes up to `ttlSeconds` (1 day)**, not
  `negativeTtlSeconds` (1 hour) — unless it was seeded through the console or the
  `secrets` MCP server, which drop the reading, or somebody presses **Re-read
  the store**. The layer does not chase a miss, because a miss on it
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
for the telegram pair, `BILL_SPEND_API_TOKEN` for the bill-spend pair,
`PULSEMCP_SUBREGISTRY_API_KEY` for `pulse-subregistry` —
then delete that entry's `enabled:` line and add each seeded name to
`PROVISIONED_STATICS` in `test/staging-config.test.ts`.

### 56. Per-slug variable names are emitted for every server; only thirteen of the twenty-five trees can read one

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

**Only `telegram`, `remote-filesystem`, `bundle-google` (for `google-sheets`),
`grafana`, `bill-spend`, `aws-device-farm`, `whatsapp`, `liveoak`, `airtable`,
`flightaware`, `digitalocean`, `hetzner` and `ssh` read an injected environment.** The other eleven
trees in the bundle image are vendored upstream code that reads `process.env` directly,
often lazily at call time, so they see the bare names only. `bill-spend` reads
the injected view for one mount rather than one per slug: one BILL token is one
company, so `bill-spend-ro` and `bill-spend-rw` share it and differ only in what
the gateway's `tools:` policy lets them call. `whatsapp` does the same, because
one linked device is one account, and so do `airtable`, `flightaware` and
`digitalocean`, whose read-only and read-write slugs share one key. The renderer cannot tell which tree an image contains — an image is a tag in
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
the first, #80 the third), taken from the published `google-flights-mcp-server` v0.2.6. It fixes
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

[`paramsWritable:`](/operate/secrets/#paramswritable--a-credential-that-rotates-on-use)
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

Four smaller edges of the same path:

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
- **A console Reconnect does not reach a running process.** A connector's
  variable on `paramsWritable:` is rotated under `oauth/` once a consent has
  written it there. Reconnecting writes a fresh grant there, but the running process
  still holds the token it booted with, and its next rotation writes over the
  reconnect. Restart the component after a reconnect. A hand re-seed of any
  `paramsWritable:` name has the same window.
- **Twin slugs on one mount share one copy, by a config rule.** `x-twitter`
  and `x-twitter-rw` share a bundle and a path, so they are one process and one
  token provider, and the render check refuses a second replica.
  What keeps the twin from holding a SECOND copy of the token is the schema's
  one-writer-per-mount rule: a name may be on only one twin's `paramsWritable:`,
  and no twin may put it on its own `oauth:` connector. Two costs follow. The
  owner's consent carries the union of the scopes (`bookmark.write` included), so
  the read tier is bounded by its `tools:` policy alone. And disabling the owner
  strands the twin, because a disabled server's namespace is not rendered.

**Exit.** A compare-and-set `put()` — read the latest version id, write
conditional on it, re-read on conflict — plus dropping the render check, for any
credential that is not single-use at the upstream. Worth doing when a second
consumer appears; not for a token whose upstream has already made the concurrency
decision for us.

### 63. One internal token means any container can reach any writable parameter

**Resolved for every `supplementary-image` component.** `STRAD_INTERNAL_TOKEN` is
a **root** that stays on core. Every other component is baked its own token,
derived from it at render time,

```text
token(component) = base64url(HMAC-SHA256(root, "strad-internal-token/v1:" + component))
```

under the same variable name, so nothing on the component side reads anything
different. Core presents the matching token when it proxies `/mcp` to a component
and when it asks that component's presence route. Every `/_strad/` route core
serves reads the caller's component off the credential and refuses a slug whose
`bundle:` is another component's, with the same `403 parameter_not_writable` a
name on no allowlist gets. No component holds the root, so every door refuses it.
What that gives:

- A container on component A cannot read or rotate a `paramsWritable:` or
  `paramsRefresh:` name of a server on component B. It reaches its own servers'
  names and nothing else.
- A component cannot ask another component's presence route or reach its `/mcp`
  mounts: each verifies only its own token, and answers `401` to anything else.
- `POST /_strad/store/refresh` accepts any component's own token and is not
  narrowed further. It names no slug, writes nothing, and is floored.

The problem, kept because it is what the design answers: the routes took one
token, broadcast to every supplementary component because it was also
the token core presented to proxy `/mcp`. Nothing bound a caller to the slug it
addressed, so the reachable set was the **union** of every enabled server's
`paramsWritable:`, for any container holding the token, and the presence route had
the same shape. A component-identity header checked against `server.bundle` would
not have fixed it: the caller would be choosing its own identity, which narrows
the accident and not the attack while reading like a boundary. That is why the
identity is a property of the credential — a caller cannot present a token for a
component it is not.

**Derived, not seeded.** The tokens come from one HMAC over the root that already
existed, so there is no new secret and no new human step in any environment, and a
component added to the config is issued its token by the next render. What that
costs, stated rather than hidden:

- **A leaked root is every component's token.** The root is on core only; a
  supplementary image never holds it under either provider.
- **Rotating one component rotates all of them.** Rotating the root is one
  redeploy, as it always was.
- **A strad-image bundle is not isolated from the root.** It is baked its own
  derived token and does not hydrate the root, but under `gcp-parameter-store` it
  holds the resolver key, which can read the gateway namespace, root included.
  That component runs strad's own code and is inside core's trust boundary for
  that reason — it can read every gateway value — so this narrows accidents there,
  not attacks. Staging's non-core components are both `supplementary-image`s.
- **Re-keying is not atomic.** A deploy that changes the root, or the first deploy
  of per-component tokens, replaces core and the components as separate
  containers. While an old one overlaps a new one, core's calls to it answer
  `401`, a boot-time parameter read falls back to the baked value, and a
  `paramsWritable:` write-back fails loudly — for a single-use refresh token, the
  rotation it carried is lost and the slug needs re-seeding. The window is the
  deploy's overlap, the same one every root rotation already had.

Independent random tokens per component would isolate a leaked root, at the price
of one secret per component per environment that only a human can create in prod.
Switching to them is a renderer change: the renderer bakes a seeded value instead
of a derived one, and core checks callers against the same list.

:::note[HACKS #13 is resolved, and #63 closed what it left behind]
`HACKS.md` #13 records that the `strad-bundle` container served its mounts with
no bearer auth at all, protected only by being an internal-only App Platform
component. Both halves of that seam hold: core adds
`Authorization: Bearer <token>` to every `supplementary-image` adapter from the
code rather than from a `headers:` entry, presenting the token it derives for that
adapter's component, and the bundle host gates every mount on it through the same
comparator its presence route uses — 401 for a missing or wrong token, 503 when
the token is unset, nothing served either way. `/healthz` stays open, because App
Platform's prober holds no credential.

Nothing of the shape that entry had remains. Each component holds its own token,
so a sibling container's token is refused, and the gate authenticates "core, or
something holding the root" rather than "a strad container".
:::

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
kill in a container that hosts thirty-four mounts. The cache is LRU-bounded on both
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
- **And then it travels gzipped.** On 2026-10-08 prod crossed again — 132,740
  bytes, on the deploy that added a second WhatsApp bridge — with nothing left to
  strip from a 34,018-byte document. `render-spec` now bakes the stripped document
  gzipped and base64'd as `STRAD_CONFIG_YAML_GZ_B64` whenever that is smaller,
  decoded with boot's own function and compared byte for byte before it is used.
  Prod's spec: 132,740 → 106,203 bytes. The price: the App Platform console no
  longer shows the config as text, and an image older than the compressed form
  cannot boot a spec that carries it — `STRAD_CONFIG_YAML` holds a tripwire that
  makes that image refuse to start rather than run its stock zero-server config.
  Render with the tooling of the image you deploy, which prod already does.
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
end to end.

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

### 79. strad-fetch's URL guard is a denylist, so it refuses what is known to be private

`strad-fetch`'s `native` strategy fetches `http` and `https` only, and refuses three shapes of private destination. **Addresses**: loopback, link-local (including `169.254.169.254`), RFC1918, carrier-grade NAT, multicast and reserved space — as literals, as the IPv6 forms that carry an IPv4 address, and as **resolved** addresses, checked on the resolution that decides the socket rather than on a second one that raced it. **Names**: a single-label host, and the special-use suffixes (`.internal`, `.local`, `.localdomain`, `.home.arpa`, `.alt`, `.localhost`) — which is how strad's own private network is addressed, since `${bundle.PRIVATE_URL}` resolves to `http://bundle-name:8080`. **Connections**: every hop the fetch opens is checked, so a redirect into a private address is refused at the connector, before a socket exists.

It is a **denylist**: it refuses what is known to be private rather than permitting what is known to be public. A private service behind an ordinary dotted name that resolves outside every listed range is still reachable, and every new form of private addressing is a rule somebody has to remember to add. An allowlist of permitted destinations is the shape that fails closed, and it is not a shape a general-purpose web fetcher can have.

What `169.254.169.254` and the private component network actually **answer** from inside an App Platform container was never established — that means probing a live deployment, which is a decision about production rather than about a change. The guard was built not to need it: the metadata address is refused by range and the component network by name, in both cases without opening a connection.

Three narrower edges. The guard is on `native` only — the paid strategies fetch from a third party's network, not from this container, so a private URL still costs a call to Firecrawl or BrightData before the chain gives up. `STRAD_FETCH_ALLOW_PRIVATE_HOSTS` exempts a host rather than a host and port, and is less operator-only than it reads: strad-fetch declares no parameters, but it shares a bundle with a server that does, so whoever can write that namespace can put this variable on the shared bundle environment at the next deploy. And a redirect is refused at the connector, so the error names the host that was refused without saying a redirect pointed at it.

**How you would know.** A `scrape` of a private URL comes back `Refusing to fetch …: 127.0.0.1 is a loopback address (127.0.0.0/8)`, or `… strad-bundle is a single-label name, which only a private network serves`, as the `native` strategy's error, with the other strategies' failures beside it.

See `HACKS.md` #79.

---

### 80. monarch-money is a fork, and no recorded fixture can see the schema move again

`servers/bundle-api/fork/monarch-money/` is the third fork in that tree, alongside slack (#55) and google-flights (#58), taken from `monarch-money-mcp-server-shared` v0.0.6. It fixes one defect of exactly the kind that justifies a fork: `get_accounts(includeHoldings: true)` reported `"holdings": []` for **every** account — reproduced twice, twenty minutes apart, across all fifty-six accounts on a workspace where fourteen held forty-four positions.

Two defects had to hold at once for that to be invisible. The query asked for `account(id:) { holdings }`, a field Monarch's schema does not have, so every request came back `400`; and the handler wrapped each one in `.catch(() => [])`, over a `?? []` in the client, so every `400` became an empty portfolio. Nothing raised, anywhere. Holdings hang off `portfolio.aggregateHoldings` — a portfolio-wide connection grouped by security, each node's legs carrying their own `account { id }` — so the fork reads the whole thing in one request and regroups by account, which also retires the old shape's one-round-trip-per-account N+1.

**The cost of the silence was the decision made on top of it.** An agent asked for that workspace's asset allocation, got fifty-six empty arrays, and fell back to bucketing from account names and transaction merchant strings. It classified the money-market funds as equity and understated that allocation by roughly twenty times. A human caught it by noticing the number looked wrong; nothing in the analysis could have. So `holdings: []` now means "this account holds nothing" and nothing else: every structural absence throws rather than yielding an empty map — a missing `portfolio`, `aggregateHoldings`, `edges`, `node` or `node.holdings` — a holding that cannot be attributed to an account throws rather than being dropped, and the one remaining request propagates to the handler's error path. `aggregateHoldings` is a Relay connection that Monarch will not let this client page, so the query asks `pageInfo { hasNextPage }` and refuses a truncated page rather than reporting part of a portfolio as all of it. An empty `edges` array is a genuinely empty portfolio and stays one.

**Only its tests defend the delta,** exactly as with #55 and #58. A re-vendor that pastes the published package over `fork/monarch-money/src` reverts it silently. `fork/monarch-money/test/holdings.test.ts`, run on every PR by `ci.yml`'s `servers (bundle-api)` leg, asserts the QUERY TEXT — `portfolio(input:)`, `aggregateHoldings`, `account { id }`, the asset-class fields, and the absence of `account(id:` — because a wrong query shape is invisible to a mocked client by construction, which is exactly how this shipped. It also asserts that every way the fetch can fail surfaces as an error rather than as `[]`.

**What no fixture can cover is the schema moving again.** `test/fixtures/portfolio-holdings.json` is recorded from a real response and anonymized — ids replaced, quantities and values regenerated, every shape and every null verbatim, because the shape is the only thing the parser can get wrong and the alternative is a household's positions in a git history. Nothing in CI talks to `api.monarch.com`. The query-text assertions pin the shape this fork was verified against on 2026-09-05; the next schema change will present exactly as this one did, minus the silence.

**How you would know.** `get_accounts` with `includeHoldings: true` returns an error naming Monarch's message and the query coordinates it rejected — `Monarch Money error: Monarch GraphQL errors: Something went wrong while processing: None on request_id: None. (at 6:5)` — rather than a well-formed list of accounts that hold nothing.

**Undo:** move the tree back under `upstream/`, restore the Dockerfile `COPY` lines and `loadApiTree`'s path, and move the workspace back in the `bundle-api` workspaces and build script. Tool names and tool count are unchanged by the fork.

See `HACKS.md` #80.

---

### 81. The env-name rule is one module, and three vendored files still hold a copy

"What is a legal environment-variable name" — `[A-Za-z_][A-Za-z0-9_]*`, and the `${NAME}` reference form built on it — is one rule, and it lives once, in `src/config/env-name.ts`. It is load-bearing in two places where a disagreement would be silent: the config schema composes `/strad/{env}/mcp/{slug}/static/{VARIABLE}` out of it, and the two reference scanners on either side of the deploy boundary decide from it which `${NAME}`s get baked onto a container and which get looked up at request time. A name one accepts and the other does not is a credential baked under a name nothing reads.

Three modules still keep their own copy of the literal: the presence vocabulary, the parameter write-back route, and the slug env-prefix rule. All three are vendored byte-for-byte into the bundle host's own npm tree, and a vendored module can only import something that crosses the boundary with it at the same relative path — so importing the rule would mean a ninth vendoring seam, for a forty-character regex.

What holds them instead is a test, not a convention: `test/env-name.test.ts` reads all three as text and fails if any mention of the character class in them is not a verbatim occurrence of the shared constant. The vendoring check covers the other half, that each copy in the bundle tree still matches its source.

**How you would know.** You would not, from a running deployment — that is the point of the test. A drift would surface as a variable name the console accepts and the deploy refuses, or the reverse.

See `HACKS.md` #81.

---

### 83. The console will not print an unexpected error's message

`JSON.parse` embeds about ten characters of its input in the `SyntaxError` it throws, and on a store path that input is a parameter payload — a credential on a non-secret parameter, the envelope around one on a secret parameter. So the console's two catch-alls, `describe()` and `renderUnexpected()`, no longer render `err.message`: they go through `errorSummary()` (`src/util/error-text.ts`), which passes a `ParameterStoreError`'s message through and reduces everything else to its class name.

The cost is real and it is debuggability. An operator who hits a failure strad did not anticipate gets the class and a sentence saying the message was withheld and why, instead of the upstream's own words.

What keeps that branch rare is that every failure the console actually produces has a sentence strad wrote: a 403 names the IAM binding to add, a 409 says the parameter already exists, a timeout says the bound is on strad's end so a write may still have landed, a store the container cannot reach names the transport code (`ENOTFOUND`, `ECONNREFUSED`), a version whose payload will not decode says that rotating clears it, and a path the console itself rejected still says which rule it broke. The class is logged under `strad.console_render_failed`, whose export carries the event name alone.

**How you would know.** The page says so — it names the class and says the message was withheld. If that is all you have, the next step is another branch in `describe()`, not a wider message.

See `HACKS.md` #83.

---

### 84. A BILL coding write is reported successful only after strad re-reads the transaction

BILL Spend & Expense's `PUT /v3/spend/transactions/{id}/custom-fields` answers HTTP 200 `{"status":"SUCCESS"}` to updates it discards. Measured against a live sandbox company: two values sent to a single-select field come back SUCCESS with the field exactly as it was — the update dropped whole, across every shape it was probed with. It is the mistake an agent makes by treating a single-select field as multi-select.

So `set_transaction_coding` sends up to two body shapes and **re-reads the transaction after each one**, reporting success only on a change it observed. A successful result carries `verified: true` and the `wire_variant` that persisted; a failure carries `persisted: false` and the whole attempt table. `changed` is a diff against the state read before the PUT rather than against the state requested, because asking for the state a field is already in satisfies "matches what was asked for" vacuously. The failure asserts "did NOT change" and "treat this as UNCODED", which are claims about the transaction rather than about the request, so they are checked: a transaction that moved while this write did not — a person editing it in the BILL web app between the PUT and the read-back — comes back `changed: true` with the before and after instead.

The cost is round trips against a budget of 60 calls per token per minute: a verified write is four to five requests, so roughly a dozen transactions a minute. The winning shape is memoised for the process, so the ladder itself is paid for once.

The two documentation puzzles the ladder was built around are settled, both by calling the endpoint. `customFieldUuid` — the key name in BILL's Transactions guide — is a hard `400 customFieldId: must not be null`, and that rung is gone. The community claim that the `tty_…` / `tvl_…` uuid forms are accepted and dropped is false: both identifier forms persist, in both slots. What is left of the ladder is about which forms a caller holds, not about which BILL prefers.

**How you would know.** The tool tells you, either way — that is the entire design. What it still cannot tell you is whether an accounting-integration-mapped GL field is exposed through this API; the sandbox company has no integration connected, BILL's custom-field `type` enum has no GL-account member and no integration-origin marker, and that question needs the production company to answer. `GET /v3/spend/custom-fields` takes no origin filter and returns every field a company has, so there is no mechanism by which it could hide one — but that is reasoning, not a measurement.

See `HACKS.md` #84 and [BILL Spend & Expense](/servers/bill-spend/).

---

### 87. BILL's transaction filters are day-granular, so strad widens every date window

`GET /v3/spend/transactions` takes one `filters` parameter whose grammar is `{field}:{op}:{value}`, split on `:` and `,` with no quoting and no escape sequence. A value carrying either separator is not a filter that matches something else — it is a request BILL rejects: `occurredTime:gte:2026-09-01T00:00:00Z` comes back `422 Invalid filter request format. Expect (field:operator:value).`, because an ISO-8601 instant is four colons long, so no date filter can be expressed as one. That is why a real sweep of four months of transactions had to cursor-page the entire history and narrow client-side, and why `updated_after` — the documented mechanism for an incremental run — reached nothing.

What BILL accepts on a time field is a bare `yyyy-MM-dd`, with `gte` and `lte` as the only operators, and **the date means the instant that day starts at, not the day it covers**. Against a company whose transactions all occurred at `2026-09-06T06:03Z`, `occurredTime:lte:2026-09-06` matched nothing and `occurredTime:lte:2026-09-07` matched all of them — so truncating an instant to its own date drops a sweep's most recent day, silently.

So each bound is floored to its UTC day and moved **outward**: the window strad asks for can only be too wide, never too narrow, and the result echoes the terms actually sent as `filters_applied`. The two moves are different sizes — a day back below, two days on above — because flooring has already moved the bound backwards by its own time of day, which is the safe direction for a lower bound and the dangerous one for an upper one. A single day above would leave `2026-09-06T23:00Z` bounded by midnight on the 7th, an hour of margin, which any zone east of UTC eats. The sizes are what make the window bracket the caller's instant under every offset from UTC-12 to UTC+14 — which matters because BILL does not document which zone its midnight is in, and measuring it would not settle it anyway: a Spend & Expense company has its own locale, so the boundary is a per-company fact strad cannot carry. Too wide is a row a caller can see and discard against its own `occurred_time`; too narrow is a transaction nobody learns about.

**How you would know.** `filters_applied` in every result says exactly what was asked of BILL, and it is deliberately not the window you named.

See `HACKS.md` #87 and [BILL Spend & Expense](/servers/bill-spend/).

---

### 88. Nothing in BILL's Spend & Expense API marks a transaction reviewed

A sweep can re-code a transaction and cannot tick it off, so a human still passes through the BILL web app afterwards. That is BILL's gap, not a missing tool: `is_reviewed` works as a **filter** — a run can skip what was already reviewed — but BILL does not return the field on a transaction, and no endpoint sets it.

Established by calling the sandbox rather than by reading the docs. BILL's own documentation index enumerates the whole Spend & Expense transaction family — list, get, update, the 3DS challenge, three receipt endpoints and three custom-field endpoints — and there is no review or approval endpoint among them. All eight plausible paths (`/reviews`, `/review`, `/approve`, `/approvals`, `/status` under a transaction; `/v3/spend/reviews`, `/v3/spend/review-policies`, `/v3/spend/transaction-reviews`) answer `404 Page Not Found`, and the router discriminates: `PATCH` on a transaction answers `405` naming the allowed methods, so a 404 there means the route is absent rather than the verb wrong. The one transaction mutator, `PUT /v3/spend/transactions/{id}`, documents exactly one body field, `budgetId`.

And it fails the way #84 fails: seven review-shaped bodies through that PUT — `isReviewed`, `reviewed`, `reviewStatus`, `review`, `reviews`, `reviewers` and `status: APPROVED` — each answered **HTTP 200 with a full transaction body and `updatedTime` moved**, while `reviews` and `reviewers` stayed empty and `isReviewed:eq:true` went on matching nothing. A tool built on that reply would report an unattended monthly sweep as forty transactions reviewed with none of them changed. strad ships no such tool — and the restraint is also a security one, because the apiToken behind this mount is unscoped admin on a card program and the five-tool surface is the only thing withholding card issuance.

**How you would know.** `list_transactions` says it in its own description, so an agent planning a sweep reads the gap before it promises anyone a tick.

See `HACKS.md` #88 and [BILL Spend & Expense](/servers/bill-spend/).

---

### 91. A rotated refresh token with nowhere to land dies at the next restart

A `remote-http` server with [`oauthRefresh:`](/servers/interface/#oauthrefresh--a-bearer-that-expires-minted-by-strad) mints its upstream access tokens from a refresh token `${NAME}`. A provider that rotates refresh tokens on use hands back a new one on every exchange and kills the one just spent, and core writes the new one to the parameter store — the server's own namespace, or the gateway's when that is where the name lives. Where the name resolves from the environment instead (`gateway.secrets.provider: env`, or a name that only `envFallback` supplies), there is nothing strad can write. The rotation is held in memory, every rotation is refused on stderr, and the slug keeps working until the process restarts and reads the seeded value again — which the provider killed. From then on every call on that slug fails with `invalid_grant` until a human authorizes again and re-seeds.

Two narrower windows sit beside it. The write-back reads the parameter (through the resolver) before it writes and refuses when the stored value is not one this minter's lineage produced — a human re-seeding another account between the exchange and the write — but a read-then-write is not a compare-and-set, and a re-seed landing between those two calls is still overwritten. And a rolling deploy runs two cores for the minutes the old one stays up: two minters, one refresh token. A provider that rotates on use refuses the second spender, which re-reads the store within `ttlSeconds`; a provider that revokes the token family on reuse leaves the slug dead until a human authorizes again.

The write-back also stops at a parameter it could not check: on anything but a definite 404 for the server's own path it does not fall through to the gateway's, because a token written to a layer the reader never reaches is a token nothing spends.

**How you would know.** `strad.param_write_failed` fires for the slug on every rotation it could not persist, with a `reason` from a closed set (`not_held` is this case; `not_ours` is the re-seed window) and the store's HTTP `status` when one answered. The stderr line names the `${NAME}` and says the rest. After the restart, the slug reads `degraded` on `/healthz` and its calls say the refresh token was refused.

**Undo:** run under `gcp-parameter-store` and get the refresh token into the store — with **Connect** on the slug's console page, which stores it under the slug's `oauth/` kind, or seeded by hand under the server's namespace or the gateway's. Connect means a `remote-http` upstream's first refresh token need not pass through a human's clipboard; see [Connectors](/operate/connectors/#remote-http-with-oauthrefresh-connect-an-upstream-mcp-server) and #111 for what that flow cannot do.

See `HACKS.md` #91.

---

### 95. A Slack download link is single-use against a per-process set

[`slack_download_file`](/servers/slack-attachments/) returns a short-lived signed URL, and the link is single-use: the mount marks the token's nonce spent in a `Map` held by its own process. A bundle component has no database and no shared cache, so there is nowhere durable to keep a fact that is worthless fifteen minutes later — the artifact store's upload leases make the same trade.

So a restart forgets which links were spent, and one could be replayed across a restart inside its own expiry. A deploy is the realistic way to get there, and it closes the window by another route: the signing key is derived from the component's own `STRAD_INTERNAL_TOKEN`, which is derived from core's root, so rotating the root voids every outstanding link. Single-use is also per replica — `bundle-slack-zimmer` runs one instance, and scaled wider a link replayed against a different replica inside its window would not be caught, the same shape as the authorization-code set in #94. The set is bounded at ten thousand live nonces, oldest dropped first; eviction can only shorten a nonce's protection to less than its own expiry, never extend one, because the signature's `exp` is checked independently.

The token rides in the URL path and therefore reaches App Platform's edge access log. The fifteen-minute expiry and the single use are what bound that. The expiry is fixed — no deployment configures it — and the module refuses to sign for longer than an hour whatever it is asked for. The filename is deliberately kept out of the URL and served in `Content-Disposition`, so the durable part names nothing about the file.

**How you would know.** A replayed or expired link answers `403` with the same text in either case, and says to call the tool again.

**Undo:** none needed — call `slack_download_file` again. A fresh link costs one round trip.

See `HACKS.md` #95.

---

### 96. The runtime roster can add a slug, not a credential

[`gateway.configStore`](/operate/runtime-config/) lets a human add, edit, disable
and remove a server entry from the console at `/connectors`, and an agent do the
same over `/mcp` through the `connectors` builtin, live on the next request with
no deploy. Two things it does not do, and the first is the one people expect.

**A second account of an existing bundled server still needs a deploy — except
on the three trees a [store-served instance](#100-what-a-store-served-instance-does-not-cover)
covers.** A `supplementary-image` mount's credentials reach its container as environment
variables the renderer bakes into the app spec, and a process's environment is
fixed at spawn — so a new value cannot reach a running container at all. The
bundle host compounds it: it discovers the extra slugs it should mount by looking
for prefixed marker variables in its own environment, so a slug whose variables
are not there is a slug that container does not serve, whatever the roster says.
Both doors refuse the fields that would lie — `env:`, `params:`,
`paramsWritable:`, `paramsRefresh:`, `consoleEnv:`, `consoleStores:`,
`mcpStores:` — rather than accept an entry the deployment cannot honour. What is
deliverable at runtime is a second slug onto a mount that is already deployed and
already credentialed (the `gmail-ro` / `gmail-rw` pattern, two entries on one
`path:` differing by `tools:`), the two unhosted kinds, `remote-http` and
`local-tunnel`, which run in core's own process — and a store-served instance on
`/_instance/{tree}/{its own slug}` with `params: true`, for telegram,
google-sheets or grafana, which bakes nothing and reads its own namespace through
core.

**The overlay parameter has no compare-and-swap.** Parameter Manager offers none,
so a write is a read-modify-write. The console form carries the revision it
rendered and a stale Save is refused with `409`, which catches the collision a
human causes — a second tab, a second console process. The write tools take the
same revision as `expectedRevision`, optionally, so a caller that read the roster
first gets the same refusal. Two writes landing inside one read-modify-write
window still lose one, silently, and the loser is whichever wrote first. What
bounds it is that writes are rare and come from one component: core is the only
thing holding the admin credential, whichever door the write arrived through.

**Neither gap means a runtime write is unbounded.** Four rules bound what a
write may reach, as distinct from who may make one: a runtime-authored entry's
`${NAME}` refs resolve against that slug's own `/strad/{env}/mcp/{slug}/static/`
namespace and nothing else, so a connector `url:` cannot read core's process
environment and send it off-box; a runtime write may not change `entitlements:`,
`tools:` or the slug's upstream identity (`kind:`, and a supplementary `bundle:`
and `path:`) on a slug the checked-in document declares; a runtime write reaches
no mount its **author** does not already reach, so a new supplementary slug may
only land on a mount the writing principal reaches through a checked-in slug and
a checked-in slug's credential destinations — `url:`, `oauthRefresh.tokenUrl` and
a connector's two `oauth:` endpoints — may only be moved by an author it admits;
and a runtime write may
name a credential but never carry one, so a literal in `headers:`, in `url:`'s
userinfo or in an `oauthRefresh:` grant is refused rather than stored in the
clear. Disabling a connector that carries one is refused too, because disable
re-upserts the entry; removing it is always allowed. All four are in [Who may write, and what a write may
reach](/operate/runtime-config/#who-may-write-and-what-a-write-may-reach).

**The reach rule is measured in mounts, not in tools.** A writer that already
reaches a mount may create a second slug on it with a **wider** tool surface than
the checked-in slug it reaches that mount through, so a role given read-only
access to a container can hand itself that container's write tools. Closing it
would narrow the role that reaches everything in the same motion — on any mount
whose only checked-in slug is the narrow one, it could no longer create the wider
half of a `-ro` / `-rw` pair without a deploy — so it is a workflow traded
against a residual widening rather than a free tightening. The operator took it
on 2026-09-13 and kept the workflow, so the widening stays and is chosen. It is
re-taken if a `connectors` write tool is granted to a role other than `admin` —
`save_connector` is the one of the four the widening runs through, and the
trigger is the grant because that is the unit the decision is taken in. Phase 2
in [the runtime-config plan](/operate/runtime-config-plan/) carries the decision
and the condition.

**And it bounds what a write reaches, not what a writer stops.** Disable, remove
and restore compose no entry, so no bound here touches them: a writer holding the
write tools can disable or remove any connector in the roster, including one it
cannot reach. That is availability rather than disclosure, and deliberate in the
other direction — refusing a removal is what would leave a broken connector
nobody can switch off, and a removal of a checked-in slug is a standing
instruction the console shows and Restore undoes.

**The name-a-credential rule has two positions it does not cover.** A **URL query
parameter** — `https://api.example.com/mcp?key=abc` — is a literal credential
and is accepted, because nothing can tell it from `?version=2` without refusing
every URL that carries a query at all; userinfo is refused because
`user:pass@` is a credential by definition. And a **builtin's `options:`** is an
untyped bag whose ordinary contents are non-secret literals, so the reachable
surface there is editing the options of a builtin the checked-in config already
declares — one cannot be created at runtime. Closing either needs a typed
statement of which fields carry a credential, per kind and per builtin, which is
a schema change rather than a rule; [the runtime-config
plan](/operate/runtime-config-plan/) carries it as a later phase.

**Undo:** for the first, a credential path a running container reads rather than
receives — what `paramsRefresh:` does for a value behind an already-listed name,
widened to a name the spec never listed, which needs the bundle host to discover
mounts from the store instead of from its environment. #100's store-served
instances are that path for the three trees that build from an injected
environment; the rest need a tree that does, or a process per credential. For the
second, a stored document with an `etag`-style precondition, or one writer
elected per deployment.

See `HACKS.md` #96.

---

### 100. What a store-served instance does not cover

A server on [`path: /_instance/{tree}/{slug}`](/operate/secrets/#store-served-instances--a-mount-credentialed-from-its-own-namespace)
is credentialed at runtime: core lists it to its bundle and serves that slug's own
namespace, and the bundle host builds the instance from the values. Six edges,
and the boundary that bounds them.

**The caller is the component that serves the slug, and no other.** Each
component holds its own internal token ([#63](#63-one-internal-token-means-any-container-can-reach-any-writable-parameter)),
and both routes read the caller's component off it: the list answers for that
component only, and the env route serves a slug only when its `bundle:` is the
caller's. Any other component gets the same `403` as a slug that is not an
instance.

**Four trees, one account per slug.** `telegram`, `google-sheets`, `grafana` and
`ssh` only. `remote-filesystem-tmp-public` is not one yet, and gmail, calendar, docs and
every tree that reads its environment once cannot be. An instance path names its
own slug, so a `-ro` / `-rw` pair over one account is two instances seeded twice.

**A telegram rebuild does not close the connection it replaces**, so any change
to the slug's namespace leaves the previous connection open until the container
restarts. Nothing routes to it. A grafana instance is closed properly.

**A sync is a poll**: one list call per component per
`STRAD_INSTANCE_SYNC_SECONDS` (default 60) plus one read per instance, each a
slice of core's one reading of the store.

**A namespace outlives its entry.** An instance is served whatever its slug's
namespace holds, including values a removed slug left behind. A runtime-created
`remote-http` entry already reads the same namespace, so this adds no reach; both
are bounded by who holds the `connectors` write tools.

**Nothing checks the image**: an instance on a component that does not run the
strad bundle image is listed to it and never served. **Health lags the first
sync**: before it, a component serving only instances reads as unrecognised to
core's mount health.

**Undo:** a `close()` on the telegram tree, and an instance tree for
remote-filesystem once its routes key on the slug.

See `HACKS.md` #100.

---

### 101. strad-hostd is set up by hand, on the machine it controls

[strad-hostd](/servers/hostd/) breaks the rule that operating a strad feature never needs a shell on a box. Its install script runs in a terminal on the laptop, `cloudflared tunnel login` opens a browser there, macOS permission prompts are answered at its screen, Chrome's remote debugging is a toggle in Chrome, and an upgrade is `git pull` and the script again.

The rule assumes a box strad deploys to. This one is a personal laptop strad holds no credential for, by design: the machine dials out and nothing dials in. A channel that let strad push code to it would be remote code execution with no consent dialog in front of it. Everything after install stays off the box. The slugs are config, the secrets are seeded at `/ui/secrets`, and the machine's state is on `/healthz` and in `troubleshoot_host`.

An unanswered consent dialog is a denial by default, so with nobody at the laptop every `request_control` fails with `timeout`. `consent.onTimeout: "allow"` changes that, and [the design page](/servers/hostd-design/#fail-closed-and-the-tension-with-the-original-ask) says what it costs.

The macOS halves have not run anywhere but a bare CI runner: the `osascript` dialog (including the claim that no key answers it, which only a Mac can show), the LaunchAgents, the installer's `cloudflared` branch, and Chrome 144's debugging toggle against a real default profile. The two computer-use servers add steps of their own; see #108. The Chrome extension adds one more, and the trade-off that goes with it; see #112. The Messages server adds a Full Disk Access grant and needs the Mac awake; see #115.

An upgrade can run unattended over the shell slug, and that route is still box access. On an upgrade [the installer](/servers/hostd/#install) unloads a service only through a one-shot launchd runs itself, so a failure there leaves the machine reachable or retrying. The `5` that stopped the first unattended run ([#457](https://github.com/tadasant/strad/issues/457)) reproduces on a macOS runner as a `bootstrap` into a `bootout` that has not finished. Nobody has shown that on the laptop itself, so a refusal prints what would prove it. Its restart paths run against a real launchd on a macOS runner, on a throwaway agent, and against the real daemon only on the owner's Mac. The `/healthz` check and rollback after a restart need the installer to outlive that restart; if it does not, a new build that crashes at runtime is left crash-looping under launchd. A service launchd refuses permanently, on both its old and new plist, stays down until someone is at the Mac: the one-shot keeps trying for as long as the owner is logged in, and that is all it can do.

**How you would know.** `troubleshoot_host` reports `offline` when the daemon, the tunnel or the laptop is down, and also when the owner has switched remote control off. `http://127.0.0.1:7312` on the machine says which.

**Undo:** a signed app with an auto-updater would take upgrades off the terminal. The first install, the permission clicks and the Cloudflare login stay manual.

See `HACKS.md` #101.

### 102. An Office workbook in Drive is read by strad's own parser, not by Google

A `.xlsx`, `.xlsm`, `.csv` or `.tsv` **uploaded** to Drive rather than converted
to a native Google Sheet is invisible to the Sheets API — every call against it
is `400 FAILED_PRECONDITION` — so `google-sheets`'
[four read tools](/servers/google-sheets/#office-files-in-drive-are-read-too)
download it from Drive and parse the workbook in-process instead. That read is
not the same read, and every result says so on its own last line.

What differs from a native spreadsheet:

- Values are **as the file was last saved**. A formula cell serves its stored
  result; `value_render_option: FORMULA` serves the formula text.
- There is **no number formatting**. `FORMATTED_VALUE` returns `1234` where the
  Sheets API returns `$1,234.00`. Dates and durations are the exceptions,
  rendered `2025-01-21` and `36:00:00`, because in those two cases the raw number
  carries no recoverable meaning. `UNFORMATTED_VALUE` returns the stored number,
  as it does on a native spreadsheet.
- `namedRanges` is empty. An `.xlsx`'s defined names are formulas, not grid
  ranges.
- The reported `gid` is the workbook's own sheet id, not a Sheets gid. It is
  stable within the file, and the same number `sheet_gid` resolves.
- **No write tool works.** Writing one back would need a Drive write scope, a
  re-encoded workbook and a last-writer-wins race against whoever has the file
  open in the Sheets UI. The five write tools that edit a file refuse and name
  the conversion.
- The file is read **whole**: 20MB downloaded, 500,000 cells parsed, both
  refused past that with a message. A native spreadsheet is read a range at a
  time and has no such ceiling.
- Legacy `.xls`, `.xlsb` and `.ods` are refused by name rather than attempted,
  and so is a UTF-16 `.csv` — decoding one as UTF-8 yields plausible-looking
  nonsense rather than an error.

The fallback needs `https://www.googleapis.com/auth/drive.readonly` on the slug,
which is **broader than the Sheets scopes beside it** — it reaches every file in
that account's Drive, not only spreadsheets. Google offers nothing narrower that
can download a file the app did not create: `drive.file` covers app-created files
only, and `drive.metadata.readonly` cannot read content. A slug without the scope
serves native spreadsheets exactly as before; an Office file then fails with a
message naming the scope, the config field and the Reconnect button, rather than
with an opaque 403.

**How you would know.** The provenance line on every Office-backed result, and
`isError` with that message when the scope is absent.

**Undo:** convert the file. **File → Save as Google Sheets** mints a native
spreadsheet, and every tool then works against it live, formatted and writable.
This path is for the files nobody has converted.

See `HACKS.md` #102.

---

### 103. The Device Farm server has never made a live call

[`aws-device-farm`](/servers/aws-device-farm/) is built, tested and baked into the bundle image. **No environment declares a slug for it, and there is no AWS account behind it.** Every line is written from AWS's published API and documented behaviour, and its suite runs against injected fakes: an AWS SDK `send`, and a `fetch` standing in for both the build download and the phone's WebDriver endpoint.

It shipped that way on purpose. An unresolved `${NAME}` fails the spec render, and the render is the whole spec — a slug that lands before its secret is seeded takes every other server's deploy down with it. The mount costs nothing while it waits: it comes up `degraded`, lists its tools, and fails every call with an error naming the variables.

**Four claims the first live call will settle:** whether the Appium endpoint accepts a session created with `platformName: iOS` and nothing else; whether the iOS predicate `hasKeyboardFocus == 1` names the field a coordinate tap just focused; how long a session really takes to become drivable, which decides whether the 180-second default wait is generous or tight; and whether `"2"` is the right `appium:version` to default on iOS 27 and later, where Device Farm requires one.

**One thing that is a choice rather than an unknown:** `upload_app` buffers the build in memory, because the pre-signed S3 PUT needs a `Content-Length` and a source URL is not obliged to declare one. The download is read with a running ceiling — `AWS_DEVICE_FARM_MAX_UPLOAD_MB`, 192 MB by default — and abandoned mid-flight past it. On a 2 GB box shared with a Chromium that is a real bound, not a formality.

**How you would know.** The mount is `degraded` on `/healthz` until its variables exist, and every tool call says which are missing.

**Undo:** the slug block in [the setup guide](/servers/aws-device-farm-setup/#61--strad-staging-config-tadasantstrad-this-repo), pasted once the credential is seeded.

See `HACKS.md` #103.

### 104. A new spreadsheet lands in the Drive root, shared with no one

[`create_spreadsheet`](/servers/google-sheets/#the-tools) needs nothing wider than the `https://www.googleapis.com/auth/spreadsheets` scope a `-rw` slug already holds, and that is exactly why it stops where it does. The file lands in the **root** of the slug account's My Drive, owned by that account and shared with no one. Putting it in a folder and deleting it are Drive API writes this server never makes — so a human moves it, in Drive. Sharing it is [`share_spreadsheet`](/servers/google-sheets/#sharing-is-its-own-tier), on an `-rw-external` slug that holds the full `drive` scope; on a `-rw` slug a human shares it.

It is **not idempotent**. A call that times out after Google made the file, retried, leaves two; nothing here can remove the first. The tool's own description tells a caller to look before retrying. The tabs and their header rows go in the same single request as the file, so a failure never leaves a half-built spreadsheet behind.

**How you would know.** The tool's answer names the new file's id and URL; a duplicate is a second id with the same title.

**Undo:** a move tool behind `drive.file`, on a slug whose operator has decided that scope is worth it. The create itself stays on `spreadsheets`.

See `HACKS.md` #104.

### 106. A flow-through grant is held by a component

A [`reaches:`](/servers/flow-through/) grant lets a hosted server call another slug's tools as itself. Core proves which **component** is calling, not which server on it: every server in one container shares the same internal token, so any of them could use a neighbour's grant. And a pin fixes an argument to one exact value and nothing finer, so a grant pinned to one spreadsheet can write any cell of it. Past that, the source server's code is the boundary.

**How you would know.** Every call is a `strad.surface=reach` span and metric under the target's slug, and a pin refusal is a `mcp.pin_refused` event naming the argument.

**Undo:** per-server tokens inside a shared container, and pin forms beyond exact equality where a real grant needs them.

See `HACKS.md` #106.

### 107. The console's app host is not the spec's sandbox proxy

The MCP Apps spec describes, for a web host, a proxy iframe on a **different origin**. strad has one public origin, so [`/apps/<slug>`](/servers/apps/) serves the app's page from the console's origin under a CSP `sandbox` header without `allow-same-origin`. That gives the page an opaque origin that cannot read the console's cookies or call its routes, and `connect-src 'none'` gives it no network. The host also has no model, so the methods an LLM host answers (`ui/message`, `ui/update-model-context`) say "not supported" here.

The opaque origin also costs the app its own history. In Chromium, traversing an entry the frame pushed, or the host setting the frame's `#hash`, reloads the frame, and the host closes an app whose frame loads twice. So Back and Forward work only for an app that asks the host for entries and follows the hash the host sends back (`x-strad/hash`, [History](/servers/apps/#console-extensions)); an app that does neither gets no in-app Back.

**Undo:** a second hostname for app frames.

See `HACKS.md` #107.

---

## What the human still needs to provision

The one-time steps that clear most of the list above:

- The per-server parameter values. Staging's secrets/parameters GCP project, its
  three service accounts (viewer, admin, resolver) and their seeded keys are
  provisioned; `/strad/staging/mcp/` holds nothing, so set the
  `remote-filesystem-tmp-public` values in `/ui/secrets` — clears **#26**. Prod
  needs the whole set of its own.
- For each `oauth:` connector in production, `roles/secretmanager.secretAccessor`
  for the console's service account on that slug's client-id and client-secret
  secrets — per secret, never on the project. **The console now does this
  itself**, from the connector's own page or as part of a create, so what is left
  for a human is pressing the button once per already-seeded slug — or, on a
  deployment that applied #31's deny policy, deciding between that policy and
  working connectors. See **#99**.
- An OAuth client for `https://strad.tadasant.com/console/oauth/callback`, and its
  `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — clears **#2** and **#20**.
- An AWS account, a Device Farm project, a least-privilege IAM key, and three
  values at `/ui/secrets` — clears **#103**. Every step is in
  [the setup guide](/servers/aws-device-farm-setup/).
- A private GCS bucket, a service account with `roles/storage.objectAdmin` on
  it, and a 32-byte key, seeded as four values at `/ui/secrets` — then a
  `whatsapp_pair` call and a code typed into the phone — turns on
  `whatsapp-zimmer` (**#109**). See [WhatsApp](/servers/whatsapp/#setup).
- Delete the DigitalOcean Container Registry named `strad`. Staging and prod pull
  ghcr images; the registry the first deploy used is left over, and bills while it
  sits there.
- Re-point prod at the collapsed bundle, then delete the per-server images and
  workflows — clears **#23**.
- Mint a dedicated strad GHCR pull token — clears **#5**.
- Provision Workload Identity Federation, then delete `GCP_SA_KEY` — clears **#8**.
- Stand up a datastore and a console mint/revoke UI — clears **#6**.

---

### 108. The computer-use servers are signed, permissioned and re-approved by hand

The `computer-use-*-headless` and `computer-use-*` servers of [strad-hostd](/servers/hostd/) run through a native helper, `strad-hostd-ax`, because macOS grants Accessibility and Screen Recording to a program by its code signature and a grant to `node` would cover every Node script on the machine. Three things about that happen at the Mac, by hand.

The helper has to be signed with a stable identity, or every rebuild loses both grants. The install signs with a Developer ID certificate if there is one, else with a self-signed certificate it creates and trusts for code signing, which asks for the login password once. The self-signed route has not run anywhere.

The two grants are clicked in System Settings › Privacy & Security, and they only land on the helper because it runs as its own LaunchAgent rather than as a child of the daemon: macOS attributes a child's grants to its parent, and resets that for a process launchd starts. That is reasoned from how the responsible-process rule works and has not been observed.

macOS 15 asks again, about monthly, whether a program that captures the screen without the system picker may keep doing so. Nothing on the strad side can answer it. Until the owner does, `take_screenshot` fails with `screen_recording_denied`; the headless server does not capture the screen and is unaffected.

One boundary is not there, and the shell slug is why. The helper's socket is a file every process of the owner can open. The helper takes one controlling connection at a time and refuses every op that acts on the machine unless that connection last reported a grant covering it, so nobody drives it around the daemon's grant table while the daemon runs; but a command run through `shell-*` runs as the owner and can stop the daemon, edit its config, unload a LaunchAgent or replace the helper. macOS gives two processes of one user no way to keep secrets from each other. That is the shell slug's blast radius, and every hostd slug stays `admin`-only for it.

The banner can be put away into the menu bar (**Minimize**), and then the only thing on screen for the life of a grant is the menu-bar icon: tinted, counting, animating while a call runs. macOS drops status items that do not fit, and on a notched MacBook a crowded menu bar can hide it altogether. The notification at a grant's start and end still posts, a foreground grant still ends on the owner's first key or click, and **Show banner** (or `defaults write strad-hostd-ax bannerMode compact`) puts the strip back for every grant after.

**How you would know.** `get_control_status` on either server reports `helper: {running, accessibility, screen_recording}`, and `request_control` refuses with `helper_unavailable` and shows no dialog when a grant is missing. `strad-hostd helper` on the Mac says the same.

**Undo:** a Developer ID certificate removes the self-signed step. Apple's persistent-content-capture entitlement removes the monthly prompt and is issued on application to remote-desktop products. The grants are the owner's and stay.

See `HACKS.md` #108.

---

### 109. The WhatsApp bridge is an unofficial linked device, on one socket, with its state in a bucket

The [WhatsApp](/servers/whatsapp/) server sits in chats as a linked device of one real account, through Baileys, because Meta's Cloud API cannot join a group a consumer created. Automating an account that way is against WhatsApp's Terms of Service, and the account can be banned for it. Every tool description says so. Sending is human-paced, which lowers the risk and does not remove it. Baileys is pinned to `7.0.0-rc14`: the 7.x line is the one that speaks WhatsApp's LID addressing, and it has not left release candidates.

A linked device is one socket, so the component that holds it runs one instance and the render refuses more. A deploy still overlaps two containers; a lease in the bucket makes the newer one the owner, and the older one stops within 30 seconds. State the older one wrote in that window is overwritten. A Signal session that loses a step recovers through WhatsApp's retry receipts, so a message can arrive late, once.

The device cannot be named: it pairs as Baileys' `Browsers.macOS("Chrome")` preset and the phone lists it as Chrome on Mac OS, because the phone refuses a pairing code whose OS it does not recognise, and the OS slot is the only place a name could go.

State is written to GCS on a two-second debounce and on shutdown, so a crash loses up to that window. The bucket is strad's shared [state store](/operate/state-store/) (#138), reached through a hand-written GCS client on Node's built-in `fetch`, not `@google-cloud/storage`: that library's node-fetch 2 transport reported every token request from prod's `bundle-whatsapp-tadas` as `Premature close`, and what caused it on that container was never found. A GCS call that loses its connection, the token fetch included, is tried up to four times with no new try after 15 seconds; past that the tool answers `transient; retry` rather than the transport's error. Nothing in CI talks to real GCS: the client is tested against a fake JSON API. There is no history API: a gap WhatsApp does not replay on reconnect is a gap in `whatsapp_get_messages`. The phone has to come online about every 14 days or WhatsApp logs the device out. A new `WHATSAPP_STATE_ENCRYPTION_KEY` makes the stored state unreadable; there is no rotation path.

**How you would know.** `whatsapp_status` reports `connected`, `paired` and `last_disconnect_reason` — `logged_out`, `connection_replaced`, `replaced_by_another_instance`, `state_unreadable`. Zimmer treats only `connected && paired` as healthy.

**Undo:** an official API that can join a consumer group replaces all of it. Short of that, a key-rotation path, and a transactional store for the Signal state if strad ever has a database.

See `HACKS.md` #109.

---

### 110. monarch-money's session cookie expires, and refreshing it is still a human step

Monarch's web app moved to an HttpOnly session cookie. Scripted logins now meet a CAPTCHA on a growing share of accounts: `403 {"error_code":"CAPTCHA_REQUIRED"}`, or the edge's `403 {"You":"Shall Not Pass"}`. So the monarch fork runs on `MONARCH_COOKIE`, the whole `Cookie` request header from a signed-in browser. That cookie expires when Monarch decides it does. The one available observation suggests an API call does not extend it, so strad does not poll to keep it alive.

What strad does instead:

- **Re-reads the cookie on every request.** `MONARCH_COOKIE` outranks `MONARCH_SESSION_TOKEN` and is read per request. With `params: true` and `paramsRefresh: [MONARCH_COOKIE]` on the slug, a value rotated in `/ui/secrets` reaches the running container without a deploy.
- **Accepts a new cookie over `/mcp`.** `set_session_cookie` checks the cookie against Monarch first. Only then does it use the cookie and persist it through `paramsWritable: [MONARCH_COOKIE]`. Persistence goes to the namespace of the slug named by `MONARCH_COOKIE_SLUG` (default `monarch-money-readwrite`).
- **Keeps a re-issued session.** When Monarch re-issues the session with `Set-Cookie`, strad keeps the new value the same way.
- **Says which credential died.** Every auth failure names the credential, says whether a re-login was tried, and gives the refresh steps.

Headless re-login (`MONARCH_EMAIL`, `MONARCH_PASSWORD`, `MONARCH_TOTP_SECRET`, `MONARCH_DEVICE_UUID`) is opt-in and best-effort. The public evidence splits by account and by egress IP. It runs at most once every 15 minutes, so a login that cannot succeed does not lock the account.

**How you would know.** A tool call answers `Monarch cookie expired or was signed out (Monarch answered 401).`, followed by the refresh steps. `check_authentication` reports `method`, `source`, and whether a runtime-set cookie survives a restart (`cookiePersistence`).

**Undo:** a browser extension on the signed-in profile could read the cookie with `chrome.cookies` and push it to strad itself, with no human step. That belongs on the strad-hostd browser bridge.

See `HACKS.md` #110.

---

### 111. Connect on a `remote-http` server discovers everything, registers public clients only, and has never met a real upstream

A `remote-http` server with `oauthRefresh:` has a **Connect** button that runs the MCP authorization flow from the console: protected-resource metadata, the authorization server's metadata, dynamic client registration, code + PKCE with `resource=`. Its limits:

- **A firewall decides whether it works at all.** Every request is from strad's own egress, a cloud provider's addresses. From a DigitalOcean droplet (the Zimmer host, 2026-10-06), Rippling's Cloudflare answers `/mcp` with the expected `401` and every other path on `mcp.rippling.com`, both metadata documents included, with a `403` block page. Prod's App Platform egress got the same `403` on the protected-resource metadata the same day. `app.rippling.com`'s token and registration endpoints answer normally. Two ways past a blocked metadata document, and they cover only the two metadata GETs:
  - **Paste it.** The refusal opens a form that links the refused document. Open the link in your own browser and paste the JSON. strad checks a pasted document the way it checks a fetched one, and also requires its `resource` and `issuer`. It cannot tell whether the endpoints a pasted document names are really the upstream's, so paste only what the linked address showed.
  - **`oauthRefresh.discoveryProxy:`.** A document that answers strad `403` is re-read through BrightData's Web Unlocker, with `BRIGHTDATA_API_KEY` from the `apiKeyFrom` slug's namespace. This works around the upstream's bot protection on purpose, and it sends the upstream's metadata URLs to a third party. It is opt-in per slug and accepts GET only, so no code, client or token goes through it. Each proxied read gets 60 seconds.

  Registration, the code exchange and every refresh still leave from strad. Before it registers anything or sends anyone to sign in, Connect GETs the token endpoint and refuses (`token_endpoint_blocked`) on a `403` page a firewall signed (`cf-ray`, `server: cloudflare`, `AkamaiGHost`). An unsigned `403` page passes, so a firewall that signs nothing is found at the code exchange instead, after the sign-in. A firewall there means no refresh would ever work, and neither workaround helps.

- **Public clients only, when strad registers one.** The transaction that carries a registered client from the button to the callback is a signed cookie, not an encrypted one, so strad registers with `token_endpoint_auth_method: none` and refuses a confidential answer. A server that needs a client secret gets a client a human registered at the upstream, seeded under the `clientId` and `clientSecret` `${NAME}`s.
- **A fresh client on every Connect.** Each Connect registers a new client and stops using the old one; nothing deletes the old registration at the upstream.
- **No identity is proved.** As with `provider: generic`, strad stores whichever account signed in. The page says `account: not checked`.
- **Other replicas catch up on their TTL.** Connect drops the cached reading of the process that served it. Another core replica sees the new values within `ttlSeconds`; core runs one instance today.
- **A partial write is possible.** The token URL, client id and resource are written before the refresh token. A store failure between them leaves a mismatched set until the next Connect; the page says so.
- **Never run against a real upstream.** The flow is tested end to end against a fake authorization server over real sockets (`test/connector.upstream.e2e.test.ts`), not against Rippling, Granola or any other real provider.

**How you would know.** The connect POST answers `409` with the reason on the page, and `strad.connector_connect_failed` carries a closed `reason` (`metadata_blocked`, `token_endpoint_blocked`, `proxy_failed`, `proxy_key_unreadable`, `registration_confidential`, `no_client`, …) and the HTTP `status`.

**Undo:** for a blocked upstream, ask its owner to allow the deployment's egress and drop `discoveryProxy:`. If its token endpoint is blocked too, authorize from a machine it allows and seed the refresh token by hand. Even then, every refresh from strad would fail. For a confidential-only upstream, register a client by hand and seed it.

See `HACKS.md` #111.

### 112. The Chrome extension makes the real profile drivable with no prompt

The browser server of [strad-hostd](/servers/hostd/) can reach the owner's real Chrome through an extension installed in that profile, and does so ahead of DevTools whenever the extension is connected. It exists because neither route Chrome offers into the default profile can run unattended: `--remote-debugging-port` is ignored there since Chrome 136, and the `chrome://inspect/#remote-debugging` toggle asks "Allow remote debugging?" on every connection. The extension attaches `chrome.debugger` with no per-connection prompt.

That is the trade-off, and it is the owner's to make. With the extension installed and `consent.onTimeout: "allow"`, every account the owner is signed in to is drivable by anything that holds a hostd browser key and gets past a consent window nobody is at the screen to answer. A prompt injection that lands in one agent's page reaches all of them. What remains is the daemon's own: a key per server, a grant per task, the audit log, and a kill switch that also detaches the debugger from every tab. Keep the slugs `admin`-only.

Installing it is done at the Mac, by hand: unpacked from `chrome://extensions` with developer mode on, paired through its options page, and it holds while developer mode does. `strad-hostd extension` also writes a configuration profile that force-installs the extension with the token in managed storage, which survives developer-mode rules and shows no "started debugging this browser" infobar — but Chrome honours a force-install from outside the Web Store only on a Mac it considers managed (MDM-enrolled or domain-bound), and on a personal Mac filters it as a sensitive policy. The profile is for a managed Mac; a personal one gets the unpacked route.

The extension has run in a real Chromium in CI, through every browser tool, with two sessions sharing one attachment, the kill switch detaching it, and a rogue listener on the daemon's port getting a nonce and nothing else (the pairing token never crosses the socket; each side proves it over the other's nonce). It has not run in Google Chrome on a Mac: the unpacked route there, the profile on a managed Mac, managed storage and the absence of the infobar are reasoned from Chromium's source and not yet observed.

**How you would know.** The status page at `http://127.0.0.1:7312` says "Chrome extension: connected" or "not connected", `strad-hostd status` says the same, and `get_control_status` on the browser server reports `browser: {extension, via}`. A tool call that falls back to DevTools and finds none says the extension is not connected.

**Undo:** Chrome remembering an "always allow" for remote debugging on the default profile would retire the extension. Nothing suggests it will.

See `HACKS.md` #112.

---

### 113. A confirmation reaches the session the caller names, and the console has none

gmail's `send_email` asks a human first, at the URL the `/mcp` request names in
`X-Elicitation-Url` ([how](/servers/confirmations/)).

- **strad trusts the caller to name its own session.** The URL-prefix allowlist
  bounds where the bundle fetches, not whose session it is. A caller holding
  another session's URL can raise a prompt there but cannot answer it: Zimmer's
  token route creates and polls, and only a human in Zimmer's UI responds.
- **The console cannot send mail.** The playground has no prompt surface, so it
  gets the same refusal as a caller with no header. A `skipConfirmations: true`
  slug is the exception, since nobody is asked there.
- **A window is only as long as the caller's hop holds it.** strad's own hop
  holds any `timeoutMs`, because the bundle sends keepalives. The caller's hop
  to core belongs to the caller's client and any ingress in front of strad, and
  core relays keepalives only to a caller that sent a progressToken. A longer
  window than that hop holds is safe but useless: the drop reaches the bundle
  and the answer becomes `cancel`, so strad never sends after its caller was
  told the call failed. What remains is a send whose request had already
  reached Gmail when the drop arrived. How long App
  Platform's ingress, or Zimmer's client, holds a silent `/mcp` response has
  not been measured.
- **A container-wide `ELICITATION_ENABLED=false`, `ELICITATION_REQUEST_URL` or
  `ELICITATION_POLL_URL` on the bundle refuses every send**, rather than skipping
  the prompt or sending it to one address for everybody.
- **`skipConfirmations: true` trusts the config about whose mailbox it is.** A
  slug that declares it sends with nobody asked
  ([how](/servers/confirmations/#a-mailbox-that-is-the-agents-own)). strad does
  not check that the slug's credential is the agent's own account rather than a
  person's, so the waiver is only as right as the reviewed config line that
  sets it.

See `HACKS.md` #113.

---

### 114. A WhatsApp attachment buffered before descriptors were kept is recovered from the phone, best effort

[`whatsapp_get_attachment`](/servers/whatsapp/#attachments) needs the media key
and CDN path a message carried when it arrived. The buffer keeps them for every
media message it ingests. A message buffered before it did has neither, and they
cannot be derived, so the bridge asks the paired phone to send the message again
(a resend of the message, and an on-demand history sync before the next one) and
waits 30 seconds for the answer.

- **It needs the phone.** Online, with WhatsApp able to run, and still holding
  the message. An offline phone is an error that says to retry; a phone that has
  deleted it is an error for good, and the file has to be sent again.
- **It has not met a real phone in CI.** The suite drives both requests through a
  fake socket that answers the way Baileys delivers an answer. Whether a given
  phone honours a resend for a message that decrypted fine the first time is
  WhatsApp's behaviour, not the bridge's.
- **An expired CDN copy needs the phone too.** WhatsApp forgets a file after a
  while; the phone re-uploads it on request, and a phone that cannot leaves the
  file unreadable.
- **Spent links live in memory.** The `/whatsapp` component runs one instance,
  so that is the whole ledger, but a restart forgets it: a link used once before
  a deploy could be used again after it, inside its 15 minutes.
- **The download transport is strad's own.** Baileys 7.0.0-rc14's
  `downloadMediaMessage` crashes its host on a dropped CDN connection and never
  calls its re-upload hook, so the bridge fetches with its own abortable `fetch`
  and keeps only Baileys' key derivation.

**How you would know.** The attachment's `available: false` and
`unavailable_reason` in `whatsapp_get_messages`, and the error text of
`whatsapp_get_attachment`. The container logs one line per recovery attempt,
with no chat or file named.

**Undo:** the recovery goes away once every message older than the change has
aged out of the buffer (30 days by default). The transport goes back to Baileys
when its download forwards source errors and tests the status it sets.

See `HACKS.md` #114.

---

### 115. The Messages server needs Full Disk Access granted by hand, and an awake Mac

The `imessage-*` server of [strad-hostd](/servers/hostd/) reads the owner's Messages history from `~/Library/Messages/chat.db` through a native helper, `strad-hostd-messages`, the one process on the machine strad-hostd asks Full Disk Access for. Five things about it are not what the rest of strad is like.

The grant is clicked at the Mac. There is no API that asks for Full Disk Access; the owner drags the helper into System Settings › Privacy & Security › Full Disk Access, and `strad-hostd messages --grant` opens the list and shows the binary. It lands on the helper rather than on `node` because the helper runs as its own LaunchAgent, which is reasoned from how macOS attributes grants and has not been observed on a real Mac.

The data is only as fresh as the Mac. iMessage exists only on Apple hardware, and a sleeping Mac receives nothing. With Messages in iCloud on, a Mac that wakes catches up, and the ROWID cursor `imessage_get_messages` takes then reads what arrived meanwhile; without it, what arrived during sleep may never reach this Mac's database. Nothing keeps the Mac awake.

The helper's socket answers any process running as the owner, and reads chat.db and the owner's Contacts databases for it, read-only and nothing else: no database the helper did not find itself, and attachments only by id from inside the Messages directory. That is narrower than granting Full Disk Access to `node`, and it is not a privilege boundary, for the same reason as #108.

Contact names come from Contacts' own SQLite files under `~/Library/Application Support/AddressBook`, read under that same Full Disk Access grant rather than through Contacts.framework, which would ask for a second grant nobody is there to answer. That the grant reaches those files is documented by other tools that read them and has not been observed on the owner's Mac. Their schema is Apple's and undocumented, like chat.db's. The book is re-read every ten minutes, so a contact added since then has no name until the next read, and a book that cannot be read adds a `contacts_warning` rather than failing the read: names are null if it has never been read, and the last read's if a re-read failed.

The server is allowed on timeout. `init` and `add messages` set `onTimeout: "allow"` on it alone so a nightly read works with nobody at the screen; the rest of the machine keeps `deny`. With nobody there, the dialog refuses nothing. The slug stays `admin`-only.

**How you would know.** `get_control_status` reports `helper: {running, full_disk_access, chat_db, contacts}`, `request_control` refuses with `helper_unavailable` and shows no dialog while the grant is missing, and `strad-hostd messages` on the Mac says the same. A cursor past every message comes back with a `warning`: the database was rebuilt and numbering restarted.

**Undo:** an always-on Mac removes the freshness gap. Setting `"onTimeout": "deny"` on `capabilities.messages` puts the dialog back in charge. The grant is the owner's and stays.

See `HACKS.md` #115.

---

### 116. The LiveOak server speaks a wire nobody here has watched, and holds a bank login that skips MFA

The [LiveOak Bank](/servers/liveoak/) server logs in to LiveOak's legacy portal
as the account holder, through AWS Cognito, and reads statements from the
bank's Apiture API. LiveOak publishes neither. What it costs:

- **The wire is inferred, not observed.** The pool id, the app client, the
  statement query and the document link were read out of the portal's public
  JavaScript. CI drives the real Cognito client library against a fake pool that
  does the SRP math, and a fake API, so the exchange is proven against
  Cognito's protocol rather than against LiveOak. The first real enrolment is
  the first time any of it meets the bank. A portal release that renames a
  field, moves the pool or adds a login step breaks it, with no notice.
- **Statement fields are best effort.** The portal's code reads three fields of
  a statement (`_id`, `endOn` and the document link). The rest (`name`,
  `account`, `start_on`, …) come from a few plausible names and are omitted
  when absent.
- **The device keys are a login that skips the code.** With the password, the
  three keys sealed in the bucket log in with no phone. They are sealed with
  `LIVEOAK_STATE_ENCRYPTION_KEY`, and no tool returns them, but anyone holding
  the store's values and the bucket holds the account. There is no rotation
  path for the key: a new one makes the state unreadable, and the fix is
  `enrol_device` with `force: true`.
- **Enrolment needs a human, once, within minutes.** The code goes to the
  account holder's phone, and Cognito's challenge lives about three minutes
  unless the pool says otherwise. The pending challenge is in one container's
  memory, so a deploy between `enrol_device` and `confirm_device` drops it.
- **A confirmed device whose keys could not be stored lives in memory.** LiveOak
  remembers the device before this server writes it to the bucket.
  `enrol_device` checks the bucket takes a write before it texts a code, so this
  takes a storage failure in the seconds between the two calls. If it happens,
  the next `enrol_device` stores the held keys with no code. A restart first
  loses them, `force: true` enrols again, and the old device stays on the
  account doing nothing.
- **A pool that issues no device makes this server useless unattended.** If
  LiveOak's pool does not track devices, every login asks for a code.
  `confirm_device` says so instead of reporting success.
- **Spent links are an in-memory ledger per instance.** A restart forgets
  them, and two instances keep two ledgers, so a link could be used once per
  instance inside its 15 minutes.
- **Read-only is a property of the client, not of the token.** The Cognito
  access token can write. Nothing in `apiture.ts` sends anything but GET, and a
  test asserts that against every request, but a change to that file is a
  change to the boundary.

**How you would know.** `get_status` says whether a device is enrolled. A login
the pool refuses comes back with Cognito's own exception name
(`NotAuthorizedException`, `CodeMismatchException`, …). A device LiveOak stopped
honouring comes back as "no longer accepts the enrolled device", with the
challenge held for `confirm_device`.

**Undo:** an API from LiveOak, or a statements export to an aggregator this
server could read instead. Short of that, a key-rotation path for the device
state.

See `HACKS.md` #116.

---

### 117. gmail attachments: inline files are capped near 3 MB, and a URL's host is checked before the fetch

`send_email` and `upsert_draft_email` take `attachments`, up to 10 files and
17 MB decoded, each an HTTPS `url` the server downloads or `content_base64`
with a `filename`.

- **Inline files stop at about 3 MB.** Core reads a `/mcp` request with a 4 MB
  body limit, and base64 inside JSON costs a third more. A bigger inline file is
  a `413` at core. Upload it to the [artifact store](/servers/artifact-store/)
  and pass the signed link as `url` instead; that route goes to the full 17 MB.
- **Private destinations are refused before the fetch, not by it.** Every
  redirect hop is checked: a private literal address (loopback, RFC 1918,
  carrier-grade NAT, link-local, and the IPv6 forms that carry them),
  `localhost`, `*.internal`, and any name that resolves to a private address
  are refused. The fetch then resolves the name a second time, so a name whose
  answer changes in between is not caught. That gap is worth more here than in
  a plain fetch: `upsert_draft_email` asks no one, and
  `download_email_attachments` can read a draft's files back.
  [strad-fetch](#79-strad-fetchs-url-guard-is-a-denylist-so-it-refuses-what-is-known-to-be-private)
  checks at the connector instead.
- **Downloads come out of the confirmation window.** `send_email` fetches its
  attachments before asking, so the prompt lists what will be sent. Every
  download in a call shares one 60-second budget, taken from the same deadline
  the human answers in.
- **A draft send takes no attachments.** `from_draft_id` with `attachments` is
  an error. The draft carries its own files, and the prompt lists them.
- **The gmail tree is a fork.** Re-vendoring it from upstream would remove
  attachments. `images/bundle-google/vendor/gmail-shared/FORK.md` lists the
  delta.

**How you would know.** An inline file that is too big is a `413` from strad,
not a tool error. A refused or failed download is a tool error naming the host
and HTTP status, never the signed query string.

**Undo:** raising core's body limit lifts the inline cap, for every slug. A
fetch whose connector checks the address it actually connects to closes the
rebinding gap.

See `HACKS.md` #117.

### 118. 1Password asks the calling session, and what that leaves out

Every 1Password reveal, share and create in the bundle asks the human attached
to the calling session ([how](/servers/confirmations/#1password-every-reveal-and-every-write)),
and `DANGEROUSLY_SKIP_ELICITATIONS` is not a bundle setting.

- **The console and `admin` tokens cannot see a password.** Neither has a
  prompt surface, so a reveal is refused. Metadata and the listings still work.
  Staging allows no approval URL, so nothing reveals there.
- **The approval protocol client exists twice**, in the gmail layer and the
  1Password one. A fix to one has to be copied to the other by hand until they
  share a vendored module.
- **No whitelist, no read posture.** `OP_WHITELISTED_ITEMS` and
  `OP_ELICITATION_READ` are removed, because every 1Password mount shares the
  process environment those are read from.
- **"Sensitive" is the vendored tool's heuristic.** A field is gated by its
  type or its label. A secure note's body is neither, so it is returned
  unasked, by `onepassword_get_item` and by `onepassword_get_item_metadata`.
- **The provisioning posture still asks before a share**, unlike the npx entry
  it replaces: a share link reveals an existing item.
- **The `onepassword://config` resource says writes ask** on every mount,
  including a provisioning one whose writes run unasked, and reports the bare
  token rather than the mount's own. It describes what the vendored tool is
  told, not what the mount does.
- **A per-slug token's keys are written already per-slug**, because the config
  schema refuses one bare name with two values on a bundle.

**Undo:** a console prompt surface; one shared protocol module; a vendored tool
that takes its posture per mount and counts a note's body as sensitive; a
schema check that knows about own-path slugs.

See `HACKS.md` #118.

---

### 119. airtable, flightaware and digitalocean have only met fakes

[Airtable](/servers/airtable/), [FlightAware](/servers/flightaware/) and
[DigitalOcean](/servers/digitalocean/) are strad's own servers, each run on one
static key. What they cost:

- **Untested against the real APIs.** CI drives each through a real MCP client
  against a fake upstream built from the published references. The first real
  call on each slug is the first time it meets the service.
- **FlightAware has no upstream to match.** The npx package the Zimmer catalog
  pointed at does not exist on npm, so the tools were designed from the
  catalog's description and AeroAPI's OpenAPI document. Every call is billed;
  each tool makes one request and returns a cursor rather than walking pages.
- **DigitalOcean is a subset.** Droplets, App Platform, managed databases and
  account basics — twenty-nine tools against the npx binary's two hundred.
  DigitalOcean's own hosted remote MCP servers cover the rest.
- **Credentials are redacted by name pattern.** A credential DigitalOcean
  starts returning under a name the pattern does not match passes through until
  the pattern learns it. Leave `database:view_credentials` off the token.
- **DigitalOcean's log host is assumed.** `apps-get-logs` fetches only from
  hosts ending `.digitaloceanspaces.com` or `.digitalocean.com`; if real log
  links live elsewhere it fails naming the host, and the allowlist widens.

See `HACKS.md` #119.

---

### 120. image-diff and svg-tracer read URLs, not files, and run one job at a time

[image-diff and svg-tracer](/servers/image-tools/) replace two npx packages that
read a path off the agent's disk. Running in the bundle, they cannot.

- **Inputs are public http(s) URLs.** Upload a local file to the
  [artifact store](/servers/artifact-store/) first and pass the whole signed
  link. Private, loopback, link-local and metadata addresses are refused at the
  connector, redirects included, so an image only reachable on a private
  network cannot be used.
- **Results come back inline.** The heatmap and composite are PNG image
  content, at most 1568px on the long edge; cluster coordinates stay in
  full-resolution pixels and `images[].scale` relates the two. The SVG is a
  string in the JSON, refused past 1M characters. Nothing is written to a file
  or a link.
- **Bounds.** 25 MB and 10 megapixels per image, 30 seconds per fetch, 60 per
  job. A 2x full-page screenshot is over the pixel limit; crop or downscale it.
- **One job at a time per bundle process,** across both servers, because a
  diff at the limit holds about 400 MB beside a shared Chromium. Two more
  callers may wait, up to 20 seconds each, before they are told the server is
  busy; past that a caller is told at once, because a waiting call already holds
  its fetched images.

**How you would know.** Every refusal is a tool error that names the argument
and the rule: the address class, the size, the pixel count, or "Busy".

**Undo:** a flow-through grant onto the artifact store would let these tools
take an upload and return a link. A larger bundle instance, or a component of
their own, raises the bounds.

See `HACKS.md` #120.

---

### 121. gmail reflows a plain-text body that looks hard-wrapped, and sends HTML beside it

Agents hard-wrap prose at 72-80 columns. Sent as plain text, every one of those
newlines is a hard break, and on a phone a paragraph comes out as alternating
long and two-word lines. So `send_email` and `upsert_draft_email` join the
lines of a `plaintext_body` paragraph back together before sending, and send
every text part quoted-printable so a long paragraph stays one line.

- **Which newlines were soft is a guess.** A line is joined onto the one before
  only when that one is at least 40 characters, the paragraph's widest line is
  between 50 and 100, the next word would not have fit, and the line does not
  end in a colon. Blank lines, list items, `>` quotes, headings, table rows,
  bare URLs, label rows like `Status: merged`, sign-offs like `Best regards,`,
  `P.S.` lines, indented lines, fenced code and everything below a `-- `
  signature separator are kept as written.
- **A short line right under a long one can still be joined into it** when it
  matches none of those, such as a name alone on a line. A blank line above it
  keeps it.
- **There is no way to turn it off.** Send `html_body`, or indent the lines,
  when every newline has to survive as written.
- **A `plaintext_body` sent alone also goes out as HTML the caller did not
  write.** Gmail breaks a plain-text-only message at about 70 columns when it
  shows it, whatever the line on the wire was, so the reflow alone still
  arrived broken. The HTML part is the reflowed text escaped, a `<br>` per line
  break, bare URLs linked by their own text. It cannot give a link anchor text;
  the tool descriptions ask for an `html_body` for that.
- **A caller's `html_body` loses the space at its top.** Gmail shows a leading
  `<p>` with the browser's default margin, an empty line above the first word,
  so the leading whitespace, `<br>`s and unstyled empty paragraphs are dropped
  and the first paragraph, heading or list gets `margin-top:0`, ahead of any
  inline style it already carries. An inline margin on that block still
  applies; one from a `<style>` sheet or a class does not.
- **The gmail tree is a fork.** Re-vendoring it from upstream would remove the
  reflow and the HTML part. `images/bundle-google/vendor/gmail-shared/FORK.md` lists the delta.

**How you would know.** The draft or the Sent copy shows the paragraph as one
line where the caller sent several, and a message sent with only a
`plaintext_body` is `multipart/alternative`, with a `<div dir="auto">` HTML
part the caller did not write.

**Undo:** callers that write each paragraph as one line, as the tool
descriptions ask, make the reflow a no-op.

See `HACKS.md` #121.

### 122. nutrition-facts ships its data in the image, and calls FatSecret only through a proxy

[nutrition-facts](/servers/nutrition-facts/) answers from local USDA and
MenuStat data and from FatSecret, live.

- **The local data is fixed when the image is built.** USDA's Foundation, SR
  Legacy and FNDDS releases and MenuStat's NYC Open Data CSV are downloaded at
  build time, each checked against a SHA-256 pinned in the repo. A newer USDA
  release reaches the server through a PR that moves the pin. A file that
  changes under its URL fails the bundle build until someone reviews it and
  updates the digest.
- **USDA Branded is live, and only with a key.** Its 449 MB release is too large
  to bake. With `USDA_FDC_API_KEY` unset, a brand lookup gets FatSecret's brand
  foods and USDA's local entries, and says Branded was not searched.
- **MenuStat's newest year is 2018.** Newer menu items are missing. FatSecret's
  current menus are shown beside it, and a near-tie goes to FatSecret.
- **The FatSecret cache and daily-quota counter are per process.** A restart or
  a second bundle instance starts both from zero. The counter stops at 4,500 of
  the 5,000 daily calls to leave room for that; it cannot promise it.
- **FatSecret is called only through a proxy.** A FatSecret key answers only
  allowlisted IP addresses, set by hand in its console, single addresses on the
  Basic tier, and strad's App Platform components have no fixed egress IP. So
  every FatSecret request — the token POST included — goes through
  `FATSECRET_PROXY_URL`, a forward proxy with dedicated exit IPs (a BrightData
  dedicated-IP zone in strad's deployment), and those IPs are what is on the
  allowlist. Without the variable FatSecret is not called at all and is
  reported `unavailable`. Putting the proxy's IPs on the allowlist is a human
  step in FatSecret's console, once per IP.
- **The proxy is a dependency.** If it is down or rejects its credentials,
  FatSecret is `unavailable` — reported as the proxy's failure, not
  FatSecret's — until it recovers. The local sources still answer.

**How you would know.** `sources.fatsecret.detail` in a result names the
missing variable, the proxy failure, error 21 (an exit IP not on the
allowlist) or the daily budget. A degraded `nutrition-facts` mount on
`/healthz` means the image was built without its data files.

**Undo:** a shared store for the cache and counter; a disk or a bigger
instance for a baked Branded index. The proxy goes only if FatSecret stops
checking caller IPs.

See `HACKS.md` #122.

---

### 123. gmail returns who-sent-it headers, and the reader has to read them right

`get_email_conversation` returns a `Sender Verification Headers` section: every
`Received`, `Authentication-Results`, `ARC-Authentication-Results`, `Received-SPF`,
`DKIM-Signature`, `From`, `Sender`, `Reply-To`, `Return-Path`, `Message-ID`,
`In-Reply-To`, `References`, `Auto-Submitted` and `List-Id`, verbatim, as JSON,
each with its position in the message, and the ones the message lacks under
`absent`. A `From:` line proves nothing; these are what can.

- **Only the topmost `Authentication-Results` is the receiving server's.** A
  sender can write its own lower down. Take the one with the lowest `index`,
  check its first token is `mx.google.com`, and read `dkim=` and `dmarc=`
  there. strad does not pick the verdict for you.
- **If Google wrote none, a forged one is the topmost.** Mail inside one Google
  Workspace may carry no `Authentication-Results` of Google's (not yet checked
  on a live message). Then a sender-written one, if there is one, has the
  lowest `index`. Google's sits directly under the `Received` in which
  mx.google.com accepted the message, with no sender-written header above it;
  one that does not is not Google's.
- **Only the first section is strad's.** A Subject or body can carry a copy of
  it, always lower in the output.
- **Forwarded and mailing-list mail is judged at the last hop.** The original
  sender's result is only in the ARC chain, and nothing here validates ARC.
- **The gmail tree is a fork.** Re-vendoring it from upstream would remove the
  section. `images/bundle-google/vendor/gmail-shared/FORK.md` lists the delta.

**How you would know.** The topmost `Authentication-Results` is absent, its
authserv-id is not `mx.google.com`, or it is not directly under Google's
`Received`.

See `HACKS.md` #123.

---

### 124. google-drive runs only on its own, and has met only fakes

`images/bundle-google/vendor/google-drive-shared` is a Google Drive MCP server
in three tiers: three read tools on `drive.readonly`, `create_folder` and
`create_file` on `drive.file`, and five tools that rename, move, copy, trash
and restore existing files on the full `drive` scope. No strad slug mounts
it. You run it [on its own](/servers/standalone/), over stdio or on a localhost
port, with one Google account's OAuth refresh token.

- **No request has reached Google.** Its tests fake the network. Three things
  are still unverified: the Markdown a Doc exports as, how Drive refuses a
  `drive.file` write into a folder made by hand, and whether an upload converts
  into a Doc or a Sheet.
- **Only the `full` tier changes existing files.** `readwrite` only creates, so
  it can stay on `drive.file`. Under `drive.file`, a create should work only at
  the top of My Drive or in a folder `create_folder` made.
- **No tool rewrites a file's content.** Drive can only replace a whole file,
  and a Google Doc rebuilt from Markdown that way loses its formatting. Editing
  a document belongs to a Google Docs server.
- **No tool group set means every tool, the `full` tier included.** A setup that
  set no group before the `full` tier existed now lists its five tools. Set
  `GOOGLE_DRIVE_ENABLED_TOOLGROUPS` to match the token.
- **No permanent delete and no sharing.** `trash_file` is recoverable for 30
  days.
- **`read_file` reads text and images.** A PDF or Office file is refused with
  its link. A Google Sheet exports its first tab only.

**How you would know.** A `read_file` on a Doc that comes back empty or as raw
HTML, or a `create_file` into a `create_folder` folder that is refused.

See `HACKS.md` #124.

---

### 125. google-calendar's personal OAuth mode is a strad patch on a vendored copy

The google-calendar server signs in as a service account with domain-wide
delegation by default. `GOOGLE_CALENDAR_AUTH_MODE=oauth` makes it sign in as one
Google account with a refresh token instead, which is the only way it reaches a
personal `@gmail.com` calendar. The setup is in
`images/bundle-google/vendor/google-calendar-shared/README.md`.

- **strad added the mode, not upstream.** The server is a copy of a pulsemcp
  server. Re-copying it from upstream removes the mode unless the change is
  applied again, and a test fails if it is not.
- **The mode is chosen, never guessed.** Unlike gmail and google-docs, which
  switch to OAuth when its variables are present, calendar uses the service
  account unless the variable says `oauth`. In `oauth` mode a missing variable
  is an error, not a fallback.
- **Its error text is matched on.** The upstream code words a 401 and a 403 for
  a service account, and the OAuth mode rewrites those messages by matching
  their opening words. If upstream rewords them, the OAuth mode shows the
  service-account advice, and a token Google rejected early is reused until it
  expires.
- **The refresh token is yours to mint and replace.** gmail and google-docs
  get theirs from the console's Connect Google button. Calendar has no such
  flow, so you run the consent yourself and set the token as a secret, and
  again whenever Google revokes it. A consent screen still in Testing mode
  revokes it every 7 days.
- **A mistyped mode boots inside strad.** The standalone server refuses to
  start on one. In a bundle the server starts, and every call fails naming the
  variable.
- **No request has reached Google in OAuth mode.** The tests fake the token
  exchange and the Calendar API.

**How you would know.** An `oauth` call that fails with "verify the credentials
and domain-wide delegation", or event links whose `authuser` is missing.

See `HACKS.md` #125.

---

### 126. good-eggs nutrition covers Good Eggs Kitchen products only, from tables that lag the catalog

`get_grocery_nutrition` returns structured calories, fat, carbohydrate, protein,
serving size and servings per package only for products Good Eggs' own kitchen
makes, and only when the kitchen's help-center tables have a row for them. Good
Eggs publishes no nutrition for any other product: not on the product payload,
not on the page, not in an API the page calls. For those the tool says
`not_published` and returns the product's photo URLs, which are public and
usually front of pack, so they rarely show the label.

The tables cover little of the kitchen's current range. On 2026-10-15, 3 of the 15
kitchen products on the producer page had a row, and most of the articles were
last edited in 2020–2022. A row is matched on the product's whole name, never a
substring. When rows under one name disagree and the product's retail units do
not single one out, as happens for one product across two articles, the answer
is `ambiguous` and lists them all. A table the parser cannot fully read makes the
answer `unknown` for every kitchen product, not "no row".

**How you would know.** From the tool's own answer. `nutrition.status` is always
set, and `matchedRow.source.updatedAt` says how old the table is.

See `HACKS.md` #126 and `servers/good-eggs/FORK.md` #12.

---

---

### 127. The console masks a value field with CSS, so not every browser masks it

The parameters console's value fields are textareas, so a pasted PEM key keeps
its line breaks. A password input would have stripped them. The dots come from
CSS `-webkit-text-security`, and a browser that does not support it shows the
value as you type it. A browser extension that reads text fields can see the
value too, where it would have skipped a password input. A one-line value has a
trailing line break dropped, and a multi-line value is stored exactly as pasted.

**How you would know.** You see the characters instead of dots in the **Value**
field.

See `HACKS.md` #127 and [the parameters page](/operate/secrets/#a-value-is-kept-exactly-as-pasted-line-breaks-included).

---

### 128. good-eggs adds through an endpoint Good Eggs does not document

`add_to_cart` sends the same request as the "Add to basket" button on a product
page, `POST /api/basket/update-item`. It does not click the button. Good Eggs
publishes no API, so the request was read out of the site's own traffic, and its
meaning was measured against an anonymous basket. `quantity` sets the line's
total. It does not add to it. So the tool sends the update only when it has read
the line's current total and that total is below the request. With the total
unknown it attempts no add, and says so. A signed-in account has exercised this
path only through tests with fakes.

**How you would know.** From the tool's answer. If Good Eggs moves or reshapes
the endpoint, a failed add names the HTTP status and Good Eggs' reason
(`Good Eggs refused the basket update with HTTP …`) before falling back to the
button. Every add is checked against a fresh read of the basket.

Good Eggs also answers that update with a 2xx for a product it will not sell on
the basket's delivery day, then leaves the line out. So `add_to_cart` reads
the product's `availabilitiesByDay` from the page payload first. That is
another undocumented field, read the same way as the basket. A product listed
as sold out or unavailable for that day is refused by name, with no request
sent, along with the next day it is available. When the record is missing or
carries a status nobody has measured, the add is sent and the basket re-read
decides. `get_grocery_details` reports the same
record.

See `HACKS.md` #128 and `servers/good-eggs/FORK.md` #13 and #14.

---

### 129. google-docs reading every tab is a strad patch on a vendored copy

The google-docs server reads every tab of a document, nested tabs included.
`get_document` and `get_document_outline` take a `tab_id` to read one, and
a `?tab=` in a pasted link is ignored, because Docs puts `?tab=t.0` on nearly
every link. The upstream server it is copied from reads only the first tab.

- **strad added it, not upstream.** Re-copying the server from upstream
  removes it unless the change is applied again, and a test fails if it is
  not.
- **`format=json` on a multi-tab document has no top-level `body`.** The
  content is under `tabs[].documentTab.body`. Pass `tab_id` to get one tab
  with its `body` at the top level. A single-tab document is unchanged.
- **A write with no tab goes to the first tab.** `append_text` and `insert_text`
  take a `tab_id`, and an `update_document` request can name a `tabId`.
  `replace_text` replaces in every tab unless `tab_id` narrows it. `insert_content`
  searches every tab and refuses a heading it finds in two.
- **`export_document` cannot export one tab.** Drive's export has no option
  for it, and what it does with a multi-tab document has not been measured.
- **No tabbed read has reached Google from CI.** The tests fake the Docs API.

**How you would know.** A tool answer that shows one tab of a document that
has several, or a `tab_id` that comes back "not found" with the tab list
missing the one you expected.

See `HACKS.md` #129.

---

### 130. gmail's `delete_draft_email` deletes permanently, and asks nobody

`delete_draft_email` removes one draft, by ID, and Gmail does not keep it in
Trash. It is on the `-rw` and `-rw-external` tiers, and like
`upsert_draft_email` it asks no human. An agent on either tier can delete a
draft a person wrote.

- **It deletes drafts only.** It reads the draft first and refuses an ID
  that is not one, so a message or a thread is never touched.
- **`upsert_draft_email` does not delete.** It creates and updates. A slug
  can allow drafting and withhold deletion by leaving `delete_draft_email`
  off its `tools: allow` list.
- **The gmail tree is a fork.** Re-vendoring it from upstream would remove the
  tool. `images/bundle-google/vendor/gmail-shared/FORK.md` lists the delta.

**How you would know.** A draft is missing from Gmail's Drafts folder and not
in Sent. The calling agent's transcript has the `delete_draft_email` answer,
which names the draft's recipient and subject.

See `HACKS.md` #130.

---

### 131. MCP Events follows a draft, with poll and webhook delivery

strad's [MCP Events](/servers/events/) support is built from draft SEP-3415,
pinned in `docs/mcp-events-spec-pin.md`. The draft can still change, and so can
its error codes. `events/list`, `events/poll`, `events/subscribe` and
`events/unsubscribe` exist; webhook delivery has its own entry, #140. There is
no push (`events/stream`), no `list_changed` notification and no
`server/discover`.

The Slack `message_posted` feed has met fakes only. No real Socket Mode
connection has run in CI, and it stays off until `SLACK_APP_TOKEN`,
`SLACK_EVENTS_STATE_ENCRYPTION_KEY` and the shared
[state store](/operate/state-store/) variables are seeded.

- **Backfill has a horizon.** After a gap, a thread reply is recovered only if
  its parent is less than 48 hours older than the gap. Each read stops at 10
  pages.
- **The buffer is written every couple of seconds.** A crash loses what was
  buffered since. The next connection's backfill recovers what Slack returns.
- **One instance is a lease, not a render check.** A second replica stops
  writing within 30 seconds, but its socket takes a share of Slack's events
  until then.
- **`tools:` does not narrow events.** A read-only slug sharing the mount sees
  the same events.
- **The bucket is made by hand.** The GCS bucket and the service account that
  writes it are created once in GCP, outside any deploy, as for WhatsApp.

**How you would know.** `slack_events_status` reports the state, the last
backfill and how many reads were cut short, and the last GCS write.

See `HACKS.md` #131.

---

### 132. google-docs comments can notify people, with no gate in strad

`add_comment` and `reply_to_comment` write comments to a Google Doc as the
slug's account. They are on the read-write tiers only.

- **Google may notify people.** A comment or reply can notify people who
  already have access to the document, per their own Docs settings, with no
  gate in strad. Neither tool grants anyone access.
- **strad added them, not upstream.** Re-copying the server from upstream
  removes them unless the change is applied again, and a test fails if it is
  not.
- **No comment has reached Google from CI.** The tests fake the Drive API.

**How you would know.** Someone with access to the document mentions a
notification about a comment an agent wrote.

See `HACKS.md` #132.

---

### 133. The bundle restarts itself when its event loop wedges

A `strad-bundle` component restarts when its event loop has been saturated for
about three minutes. The host's watchdog exits on its own, and a liveness check
on `/healthz` restarts it if the loop is too blocked to run the watchdog. It
also starts with a V8 heap of half its plan's memory, rather than whatever Node
would pick.

- **A restart drops in-flight calls** on every slug the component serves, and
  takes about a minute.
- **The heap size is a rule of thumb.** If Chromium and everything else outgrow
  the other half, the kernel kills the container and it restarts.
- **No leak was found behind the incident that caused this.** A heap that
  climbs steadily toward its new ceiling is a leak this does not fix.
- **Any other image gets no liveness check** unless `bundles[].liveness: true`,
  because a check against an image with no `/healthz` restarts it in a loop.

**How you would know.** `strad.process.uptime` resets on the bundle, and its
log has a `[watchdog] ERROR event loop saturated for …` line, or App Platform
shows a liveness restart.

See `HACKS.md` #133.

---

### 134. gmail attachments come back as embedded resources

`download_email_attachments` returns each attachment inside the tool result,
as an MCP embedded resource: the bytes as base64 for a PDF or an image, the
decoded text for UTF-8 text under 100 KB, base64 for any other text. It writes nothing to the server's disk, which no
caller can reach anyway. Claude Code saves each binary resource to a local
file and reports the path.

- **A client that ignores embedded resources shows only the summary.** Call
  again with `inline=true` and the content comes back as text, binary types as
  a base64 code block.
- **One call carries at most 25 MB.** Use `filename` to fetch attachments one
  at a time. Gmail receives messages up to 50 MB, so a single attachment over
  25 MB cannot be fetched at all.
- **Small text attachments come back as text** and land in the model's
  context, the way a message body does. They are written by the sender.

**How you would know.** The result's first block lists the attachments, and
no local path follows it in the client.

See `HACKS.md` #134.

---

### 135. google-docs suggestions and anchored comments are partly seen live

`suggest: true` on `insert_content` (with refusals, #136), `append_text`,
`insert_text`, `replace_text` and `update_document` makes an edit a suggestion for a
human to review.
`add_comment`'s `quoted_text` attaches a comment to that passage.

- **A failed save can still change the document.** Google says a batch can
  commit its text while the comment or suggestion fails to save. strad reports
  that as an error and says to read the document before retrying. What a failed
  suggestion leaves behind has not been measured, and it might be a direct edit.
- **`update_document` refuses what Docs cannot suggest**, by name and before
  calling Google: tab and named-range changes, deleting a header or footer,
  table column properties, and three document style fields. Send those without
  `suggest`. strad also refuses requests on comment and suggestion threads, as its
  own rule, because they are not edits to propose.
- **A comment only attaches to text in the body.** Headers, footers, footnotes
  and a table of contents are not searched; send `insertComment` through
  `update_document` for those. `quoted_text` that is not found, or that repeats with no
  `occurrence`, is refused and creates nothing.
- **`suggest` follows the tab rules of direct edits.** A write with no tab goes
  to the first tab, and `replace_text` reaches every tab unless `tab_id` narrows
  it.
- **`get_document`'s text shows both sides of a pending suggestion**, unmarked.
  `format=json` carries the suggestion ids.
- **`replace_text` with `suggest` can overwrite a pending suggestion.** It matches
  text inside a pending insertion and rewrites that suggestion under the same id,
  so what it proposed is gone. Text in a pending deletion does not match. This was
  seen on one account's own suggestions. Whether it does the same to another
  author's suggestion is untested.
- **A quote across a pending replacement shows both sides.** `add_comment`'s
  "Anchored to" and `list_comments` read `papayabanana` for a passage typed as
  either word. The anchor itself is right.
- **The live behaviour is only partly seen.** The request shapes come from Google's
  reference. #462 ran against real Google on 0.4.154 with nothing failing, and on
  0.4.155 suggestions with `tab_id` each stayed in their tab. Not yet seen on a real
  document:
  how `replace_text` splits into suggestions and what count it reports, whether `reply_to_comment` accepts an anchored comment's ID, and
  whether a comment-only account can write this way at all. The tests fake both
  APIs.
- **strad added it, not upstream.** Re-copying the server from upstream removes
  it unless the change is applied again, and a test fails if it is not.

**How you would know.** A result labelled `UNCONFIRMED` means Google neither
named a suggestion nor said it saved one. An edit with `suggest` that shows in
the document with no suggestion marking is the failure to report.

See `HACKS.md` #135.

---

### 136. google-docs edits by heading, and `insert_content` cannot suggest everywhere

`insert_content` writes markdown above, under or at the end of a heading's
section, in any tab, and `get_document` can read one section. An agent no longer
needs an index for the common edit.

- **The dialect is small.** Headings, paragraphs, one level of bullets or numbers,
  bold, italic, code and links. Tables, images, block quotes, code fences, rules
  and nested lists are refused by line, not written as punctuation. They go
  through `update_document`.
- **Every non-blank line is a paragraph, and no blank paragraph is written.**
  Spacing comes from the document's own named styles, so a document that relies
  on empty lines between paragraphs will read tighter around new text.
- **Only top-level headings are anchors.** A heading inside a table cell is not
  found. A paragraph styled to look like a heading, in bold with no heading
  style, is not a heading to Docs; `insert_text` with `tab_id` and
  `format=outline_with_indices` reaches those, as plain text.
- **Directly above a table, or at a tab's end, the paragraph before is split.**
  Docs takes no text at a table's start, so `after_heading` on a heading followed
  by a table, or on a tab's last paragraph, writes inside the heading's closing
  newline. Above a table its text, style and `heading_id` stay. At a tab's end the
  `heading_id` was not checked.
- **`suggest` is refused there unless everything involved is plain text.** In that
  shape the content's last paragraph ends on the existing paragraph's own newline,
  and a suggestion cannot restyle that newline cleanly. On a real document, a
  reviewer accepting the suggestions in the order the tool returned them was left
  with a stray heading under a new id. So `after_heading` on a heading directly
  above a table cannot be a suggestion. The same goes for a tab's end when the last
  paragraph is a heading or list item, or the content would end in one. The refusal
  names what to do instead, such as `end_of_section`, `before_heading` or a direct
  write.
  Only the heading above a table failed live. The other refused cases share its
  shape and were not run. An allowed suggestion at a tab's end keeps any direct
  formatting of the line it follows, a centred line for example, on its last
  paragraph, and that case has not been run either.
- **One suggest call can make several suggestions, and the number depends on the
  shape.** Content above a heading made one, across five paragraphs. The refused
  shape made one per paragraph plus one. A tab's end, the one remaining shape that
  ends on an existing newline, has not been measured, so read the IDs the tool
  returns rather than assuming one.
- **A numbered list directly after an existing one joins it.** That is Docs' rule
  for a matching list, and so the numbering continues. A number other than 1 only
  continues a list being written; elsewhere it stays text, so `2020. A year` is a
  sentence.
- **A heading anchor can match more loosely than you typed.** It ignores case,
  matches a whole-word prefix when nothing is exact, and last ignores leading
  symbols, so
  `Agent Run` finds `🖼️ Agent Run Lifecycle`. A repeat is refused, and the result
  always names the heading it used.
- **`delete_section` and `replace_section` do not exist.** Read the range with
  `get_document` and send `deleteContentRange` through `update_document`. For a
  tab's last section use `endIndex - 1`, because Docs keeps a segment's final
  newline.
- **`format=outline_with_indices` uses the account's default suggestion view**,
  which is inline for anyone who can edit or comment. Only those indexes are good
  for a write. An account that can only view may be shown other ones.
- **The tests use a local model of a tab that strad wrote.** It follows what the
  live run showed for a split paragraph and a suggested style. Beyond those
  cases it is an assumption. Written from Google's reference alone, it missed the
  stray heading above.
- **strad added it, not upstream.** Re-copying the server from upstream removes
  it unless the change is applied again, and a test fails if it is not.

**How you would know.** New text in the right place with the wrong style means
ranges were off. A `heading_id` refused as matching two headings means a suggested
paragraph is sitting on that heading's newline, most likely one written before the
refusal existed; resolve the suggestions, or use `heading`. A paragraph at a tab's
end that keeps the wrong look after accepting is the unmeasured case above.

See `HACKS.md` #136.

---

### 137. The SSH server is a shell on production hosts, and nothing here has reached one

The [SSH](/servers/ssh/) server runs commands and moves files on one host per
slug, with the key and a pinned host key in the slug's own namespace. What it
costs:

- **It is box access.** strad's own invariant is that products run without it.
  These tools are for diagnosis and emergencies, and each routine use is a
  missing API, deploy step or workflow.
- **No real host has been reached.** CI runs the real `ssh2` client against a
  real SSH server on loopback. The five hosts' sshd settings, accounts and
  firewalls are proven by the first `ssh_check_connection` after their
  parameters are seeded.
- **The egress address moves.** App Platform does not give the bundle a fixed
  source address, so a host that allowlists SSH sources will refuse it.
- **A timed-out command may keep running.** No pty is allocated; a `KILL` is
  requested and older sshd ignores the request.
- **A down host costs each call up to `SSH_TIMEOUT`** (15 s by default). It
  never fails the MCP connection — nothing connects until a tool is called — but
  a powered-off droplet usually swallows the connection rather than refusing it,
  so each call waits that long before it can say `UNREACHABLE`.
- **A rebuilt host stays refused until it is re-pinned.** That is strict
  checking working, and the error names both fingerprints.
- **An SSH slug cannot be added at runtime**, from either door. Who may reach a
  shell is decided in the checked-in config, where no runtime write can move it.
- **Whoever writes the slug's namespace picks the host.** `SSH_HOST` and
  `SSH_HOST_KEY` are both parameters, so a writer of
  `/strad/{env}/mcp/ssh-*/static/` can re-point a slug at its own machine.
  Nothing enforces that only a human seeds them; keep those paths out of every
  namespace the `secrets` server can write.

**How you would know.** Every refusal is a tool error that names its cause: a
missing parameter, a host-key mismatch with both fingerprints, a rejected key, a
refused or unreachable port.

**Undo:** a fixed egress address or a tunnel for the firewall case, and a pty
mode for the timeout case. The rest is the design.

See `HACKS.md` #137.

---

### 138. Every stateful server shares one bucket and one storage credential

strad's [state store](/operate/state-store/) is one GCS bucket and one service
account for the whole deployment. The [WhatsApp](/servers/whatsapp/) bridge and
the [Slack events](/servers/events/) ingest each keep their own folder in it and
their own encryption key.

- **A container that holds the storage key can damage another server's state.**
  It cannot read it, because each server's key is its own. It can delete it, or
  put back an older sealed copy. For WhatsApp that means re-pairing. Separate
  service accounts would stop this; strad uses one.
- **The folder rule is a boot check, not IAM.** A server refuses a folder
  outside its own root, but the credential itself reaches the whole bucket.
- **The WhatsApp bridge still reads `WHATSAPP_GCS_*`** when the shared names are
  unset, so an existing deployment keeps its state with nothing re-seeded. If an
  old and a new name point at two different buckets or folders, the bridge
  refuses to start and names both.
- **The bucket and its service account are made by hand** in GCP, once per
  deployment.
- **Moving the state to another bucket is a manual copy**, with the bridge
  stopped.

**How you would know.** `whatsapp_status` reports a configuration error that
names `STRAD_STATE_GCS_BUCKET` and `WHATSAPP_GCS_BUCKET`, or a prefix variable
and "outside this server's folder". `slack_events_status` reports
`config_error` the same way.

See `HACKS.md` #138.

### 139. Tailnet egress runs a userspace tailscaled inside the bundle, and has met only fakes

A bundle with `tailnet:` runs Tailscale's daemon as a second process beside the
bundle host, so the [SSH server](/servers/ssh/) can reach hosts that exist only
on a tailnet. See [Tailnet egress](/operate/tailnet/).

- **Any process in that container can use it.** Only the `ssh` tree is given
  the listener's address, but nothing stops another server from dialing
  loopback. What it would reach is what the tailnet policy grants the node's
  tag. For strad's own deployment that is OpenSSH on Zimmer staging, once the
  allow-all grant is narrowed. Until then a key for the tag must not exist.
- **Inbound is refused at the node, not by the policy.** `--shields-up` drops
  every incoming tailnet connection.
- **The credential is baked**, so rotating it is a redeploy.
- **It has not run for real.** CI proves the SOCKS5 route with the real SSH
  client against fakes, and the supervision against stand-in binaries. A real
  `tailscaled` in App Platform's sandbox, on the real tailnet, has not run yet.

**How you would know.** The bundle's `/healthz` has a `tailnet` field: `up`,
`starting`, or `down` with a reason. An SSH call to a tailnet host says "no
tailnet egress" when the block is missing, "tailnet sidecar" when the daemon is
not up, and `UNREACHABLE` naming the tailnet policy when the host could not be
reached.

See `HACKS.md` #139.

---

### 140. Webhook delivery POSTs to a URL a caller chose, and has met only a fake receiver

With [webhook delivery](/servers/events/#webhook-delivery), the Slack mount
sends HTTP requests to a URL whoever subscribed picked. It is guarded: `https`
only, no private, loopback or reserved address (checked on every attempt, and
connected to directly), no redirects, a challenge the endpoint must answer
before anything is delivered, and only a caller entitled to the slug can
subscribe. It has met a recording fake and a loopback server in tests, not a
real receiver.

- **An edge credential goes to configured URL prefixes.** Zimmer's receiver is
  behind Cloudflare Access, so a callback URL under a prefix in
  `SLACK_EVENTS_WEBHOOK_ACCESS_PREFIXES` — a host and a path, such as
  `https://zimmer.tadasant.com/webhooks/mcp_events/` — gets strad's Access
  service token on every request. Any other path on the same host does not. A
  wrong prefix sends the token to that prefix.
- **Revoking a caller does not stop its deliveries at once.** It can no longer
  refresh, and its subscription delivers until its grant runs out, at most 24
  hours.
- **A receiver that is down is suspended, not abandoned**, after five failed
  attempts over about 15 minutes. Its next refresh resumes delivery from where
  it stopped, as long as the buffer still holds the events (7 days by default).
  Past that it gets a `gap` envelope.
- **A restart can deliver an event twice**, under a new `webhook-id` and the same
  `eventId`.
- **Verification is challenge-echo only.** No allowlist, no
  `/.well-known/mcp-webhook-receiver.json`.

**How you would know.** `slack_events_status` on the lease holder lists each
subscription: active or suspended, the last delivery and the last error, as one
of the draft's categories (`connection_refused`, `timeout`, `tls_error`,
`http_4xx`, `http_5xx`). A subscribe that fails verification answers `-32027`
with the reason.

See `HACKS.md` #140.

### 141. Custody holds a captured secret in a daemon's memory, and its capture and filter are heuristics

strad-hostd's [custody server](/servers/hostd-custody/) captures a credential
in the owner's browser into an in-memory handle and deposits it through core's
write-only `POST /_strad/deposit`. The value never appears in a tool result.
What that leaves:

- **Capture can miss.** Without `capture_selector` it takes the one new string
  of 16 or more characters, with letters and digits and no spaces, that the
  click produced. A token with no digits, one split across elements, one drawn
  in a canvas, or one only put on the clipboard is not found. If two such
  strings appear at once, nothing is kept and their selectors are returned.
- **`capture_download` watches the Downloads folder**, not Chrome. A Chrome set
  to ask where to save times out, and an unrelated file arriving in the same
  seconds could be taken. The shape it reports (`json_keys`) shows which.
- **A background tab is clicked under focus emulation.** Chrome does not
  deliver DevTools mouse input to a hidden page, so every hostd click switches
  on `Emulation.setFocusEmulationEnabled` for that one click. The page sees
  itself as visible and focused while it is clicked, and the click is
  trusted. The tab is not brought forward, and emulation is switched off
  straight after. On a Chrome where the page still reads hidden under
  emulation, the click is refused at once with an error that says to bring
  the tab forward. Once emulation is off the page gets `blur`, so a page that
  drops its reveal on blur, or writes the clipboard only while focused, can
  still defeat a background capture. This has been tested in a windowed
  Chrome on Linux. It has not been tested on the owner's Mac or through the
  extension route.
- **The hold blocks other sessions on the Mac.** From capture to release, every
  shell and computer-use call is refused, and so are browser reads on every
  tab. A capture will not start while a shell command is running. Ending the
  custody grant blanks its tainted tabs and drops its handles.
- **Whoever holds the custody slug key can deposit.** That includes a shell
  grant on the Mac while custody holds nothing, because the key is in hostd's
  config file. The route bounds what they can write: only a new secret, never
  one that already resolves for the slug, never a `url:` name, never a
  process-control name such as `NODE_OPTIONS`, never on a `local-tunnel`, and
  on a `params: true` slug only if `deposit.into:` names it or
  `deposit.paramsVariables:` names that exact slug and variable.
- **A generated SSH key is held like a captured token.** `generate_keypair`
  mints an ed25519 key in the daemon and keeps the private half behind a
  handle. Its bytes pass through JavaScript strings that cannot be zeroed, as a
  captured value's match forms do. Only ed25519, and only unencrypted.
- **The clipboard is not cleared.** A value put there by a "Copy" button is
  filtered only until the custody grant ends.
- **A daemon restart loses every handle**, and a tab still showing the token is
  no longer tainted. Re-mint the credential.
- **The egress filter matches known forms.** It catches the raw value,
  JSON-escaped, base64, base64url and URL-encoded forms, and a JSON
  credential's secret fields and PEM lines. A value transformed some other way
  would pass. This is why shell and computer-use are refused outright rather
  than filtered. Images are not scanned.
- **Create-only has a narrow race.** The `oauth/` check and the create are two
  calls, so a consent written in between leaves a `static/` copy that it
  shadows.
- **Only fakes in CI.** The suite runs a real headless Chromium against a fake
  strad. The owner's Chrome, the extension route and real provider pages have
  only been used on the owner's Mac.

**How you would know.** The hostd status page shows how many secrets custody
holds and how many tabs are tainted. A refused call says custody is holding a
secret. `list_handles` shows each handle as held, deposited (with its path),
burned, discarded or expired. On core, `strad.deposit_written`,
`strad.deposit_failed` and `strad.deposit_refused` record each attempt.

See `HACKS.md` #141.

---

### 142. gmail's draft links open the Drafts folder, not the draft

`upsert_draft_email` and `list_draft_emails` link the acting account's Drafts
folder, `https://mail.google.com/mail/?authuser=<email>#drafts`. The account
is chosen by address, so the link opens the right mailbox in a browser signed
into several Google accounts. Gmail documents no URL for a single draft, and
the commonly cited `#drafts?compose=<id>` form has not been checked against a
live mailbox, so the draft itself is one more click.

If the account's address cannot be read, the answer has no link. The draft is
still saved.

See `HACKS.md` #142.

### 143. The hostd banner's session is the caller's claim, and its call text is scrubbed by heuristic

[strad-hostd's banner](/servers/hostd/#see-it-stop-it-turn-it-off) shows the
session a grant says it acts for and the call it is running. Nothing strad
forwards identifies the caller, so the session is whatever the caller passed
to `request_control`'s optional `session`, drawn as `says it's for: …` with the
link's host in the label. Only an https URL becomes a link, and it authorizes
nothing.

The call text is scrubbed of obvious secrets (headers, credential-named pairs
and flags, URL userinfo, known token prefixes, JWTs, private keys, long opaque
runs) and capped, and typed text is shown as its length. A password passed as
a plain word in a shell command is still shown, and some harmless long tokens
are redacted. The banner appears in a foreground grant's screenshots, so a
screenshot carries every grant's purpose, session and current call (more with
**Details** open). The audit log on the machine keeps the full summary.

See `HACKS.md` #143.

---

### 144. A gmail sender name only reaches a slug on its own path

`GMAIL_SENDER_DISPLAY_NAME` in a gmail slug's `env:` is the name in
`From: "Name" <address>`, used instead of the account's Gmail send-as name. Each
mount reads it under its own slug only, so one mailbox's name never lands on
another's mail. `gmail-ro`, `gmail-rw` and `gmail-rw-external` share the
`/gmail` mount, so a name set on one of them is ignored without a warning, and
their mail carries the send-as name. A slug on `path: /<slug>` gets its name.

See `HACKS.md` #144.

### 145. The Hetzner server has only met fakes, and its read-only slug is read-only by policy

[Hetzner Cloud](/servers/hetzner/) is strad's own server, behind
`hetzner-pulse-ro` and `hetzner-pulse-rw`. What it costs:

- **Untested against the real API.** CI drives it through a real MCP client
  against a fake built from Hetzner's API reference. The first real call on
  each slug is the first time it meets Hetzner.
- **One Read & Write token for both slugs.** Hetzner tokens are Read or Read &
  Write per project and nothing finer, and the two slugs share a mount, so the
  `-ro` allow list is the only thing between it and a write.
- **The CI runner box also runs PulseMCP's production CI.** The
  slugs reach one server, `ci-runner-2`, and the `-rw` tools that can take it
  down say so in their descriptions, none can lift delete or rebuild
  protection, and an empty firewall rule set or a server with no SSH key is
  refused. That is all: nothing waits for a human to confirm, so
  a hard power-off, a firewall change or a volume detach happens when it is
  called, and `create_server` can boot arbitrary code inside the project's
  private network.
- **The token is visible to the whole bundle.** Like every bundle credential,
  `HCLOUD_TOKEN` sits in the one container's environment, where the vendored
  trees that read `process.env` can see it.
- **Root passwords are redacted by field name.** A credential Hetzner starts
  returning under a name the pattern does not match passes through until the
  pattern learns it.

See `HACKS.md` #145.

---

### 146. A per-slug variable the spec does not carry is restored by the bundle host

On a `strad-bundle` component, a per-slug variable (`<SLUG>__<NAME>`) whose
value the component already bakes under another name is not in the app spec.
It is listed in `STRAD_ENV_COPIES`, and the bundle host restores it into
`process.env` as its first import. That keeps the spec under App Platform's
undocumented size ceiling.

The renderer and the host have to agree, and nothing checks that they do. A
bundle image from before this change, deployed by a renderer from after it,
ignores the list silently, and every folded per-slug name is missing. A slug
served by a per-slug instance is then not discovered, and reads the bare name
instead. A connector's per-slug credential, such as a Google refresh token, has
no bare name to fall back on, so that slug has no credential at all. Prod's
deploy pairs the renderer with the bundle built from the same history, so this
takes a bundle image pinned or rolled back on its own. A list the host cannot
parse stops the bundle at boot rather than guessing.

See `HACKS.md` #146.

---

### 147. A listing during a bundle restart can page

A listing that fails transiently (a refused connection, a reset, a `503`) is
tried three times, with under a second of backoff, and the first retry happens
even when the failed attempt took several seconds. That covers a blip. It does not
cover a `strad-bundle` component being replaced in a deploy, which refuses
connections for around half a minute. A listing of one of that bundle's slugs
that starts inside the window spends its budget and emits
`mcp.list_tools_failed` at ERROR, and that pages. A slug that a client polls
often, like `gmail-zimmer-ro`, is the one most likely to be caught. Its
`tool_surface_recovered` follows within a minute.

A longer retry would make every client's listing wait out a bundle that is down
for real, so the fix belongs to the deploy: drain the outgoing bundle before it
stops listening, or have the alert skip that window. Neither is built.

See `HACKS.md` #147.

### 148. The Messenger bridge is unofficial, and has met Meta only up to its login form

[Messenger](/servers/messenger/) reads one personal account through mautrix-meta,
run headless in a separate AGPL-3.0 process. What that costs:

- **Against Facebook's Terms.** Meta can checkpoint or disable the account, and
  the bridge connects from a datacenter IP, which makes that more likely.
  `MESSENGER_PROXY` sends everything through a proxy if it happens.
- **Untested against a real login.** CI runs the Go program against SQLite and
  the TypeScript tree against a fake of it. The owner's first Android login got
  through the password and failed at the authenticator-code step, which a
  patched mautrix-meta (below) fixes; a completed app login is still untested.
- **Encrypted history before login needs the PIN.** Without the 6-digit
  secure-storage PIN at login, encrypted chats start at the moment of login.
- **A checkpoint means a new login.** When Meta stops the session (a checkpoint,
  a forced password change), the bridge does not reconnect it on its own, and
  `messenger_status` says to log in again. Every app login presents the same
  stored phone, adopted from the login that was already running, but still
  from a datacenter IP; `messenger_logout` deletes that phone with everything
  else.
- **A slow login step answers `working`.** The PIN step can outlast the
  console's minute-long ingress timeout, so a step is answered in the
  background and a call returns after 25 seconds; a submit with no input picks
  up the result and never resends.
- **A crash loses up to a minute of encryption state.** A deploy does not: the
  new container waits for the old one's final snapshot, and tool calls wait
  with it, for up to five minutes.
  Messages that cannot be decrypted arrive as placeholders.
- **Read-only.** There is no send tool.
- **A patched mautrix-meta.** The phone-app login's authenticator-code step
  needed a Bloks function mautrix-meta does not implement, and mautrix-meta
  makes every login a new device, so strad builds from its own copy of the
  module with both changes, and a newer release has to have them re-applied. A login screen that uses another function the interpreter
  lacks fails that step and ends the login; the `cookies` flow avoids those
  screens.

### 149. The hostd Chrome extension moves a password manager's overlay out of the way

Chrome will not let [strad-hostd](/servers/hostd/)'s extension debug a tab that
holds another extension's frame, such as a password manager's inline menu or
save prompt. When Chrome refuses, the extension takes those frames out of the
page, attaches, and puts them back when it lets go of the tab. What that costs:

- **The owner's overlay is gone while an agent drives the tab.** It reloads
  when it comes back.
- **Some frames can't be found.** A frame inside a cross-origin frame the
  extension can't script still blocks the attach. The error says so, and the
  owner can dismiss the popup or switch the extension off for that site.
- **Login pages open up.** A password manager's menu on a sign-in form used to
  keep the debugger off it. Now an agent can read that form, including a
  password the manager filled in.
- **The upgrade adds permissions.** An unpacked copy needs Reload on
  `chrome://extensions` before it takes the new version.
- **Tested against a fixture, not a real password manager.** CI runs it in
  Chromium with a stand-in extension. It hasn't run against a real password
  manager in Google Chrome on the Mac.

### 150. Gmail `message_received` asks Gmail whether a query matches, and has met only fakes

A gmail mount given its own key publishes [`message_received`](/servers/events/#gmail-message_received).
What that costs:

- **Fakes only.** No real Gmail watch, Pub/Sub notification, history read or
  per-message search has run in CI.
- **A query waits on Gmail's search index.** A message the index has not
  caught up with holds that subscriber's feed for a few seconds. One still
  unindexed after 30 minutes is decided as not matching, with a warning.
- **A verdict is not revised.** Whether a message matches is decided once,
  when it is first asked, and kept.
- **One event per message.** Zimmer's email trigger fires once per thread, so
  a burst in one thread is several events and one native fire.
- **No status tool.** The ingest's state is in the bundle's logs only.
- **Push needs Google Cloud set up by hand.** A Pub/Sub topic in the OAuth
  client's project, Gmail's publish grant on it, and a pull subscription the
  state store's service account may read. Without them the mount polls every
  15 seconds.

**How you would know.** A webhook subscription that stays quiet while the
mailbox receives mail, or a poll whose cursor does not move. The bundle's
stderr says why, prefixed `[gmail-events <slug>]`.

See `HACKS.md` #150.

### 151. Per-token source-network counts can be spoofed

[`strad.mcp.source_networks`](/operate/telemetry/#stradprincipal--whose-request-was-it)
counts how many networks each token called `/mcp` from in the last hour. What
that costs:

- **The address is `X-Forwarded-For`'s first entry**, which the client writes.
  A careless thief using a stolen token from a second network shows up. A
  careful one can make every request look like it came from one place.
- **Per core instance.** With more than one, each count is a lower bound.
- **One hour, and a restart resets it.**

The `strad.principal` label on the request and tool-call counters does not
depend on any of this.

See `HACKS.md` #151.
