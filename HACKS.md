# HACKS.md

A running catalogue of every deliberate workaround in strad, why it exists, and
what a human must provision to remove it. Each entry is a debt with an owner.

Ordered roughly by how much you'd want to fix it.

---

## 1. First ghcr image is bootstrapped from the PR branch

**✅ RESOLVED.** All servers are merged to `main` and every release workflow now
builds from `main` only — the bootstrap `feat/*` push triggers were removed.

**What.** `release-image.yml` triggers on `main` **and** on the feature branch
`feat/strad-core-platform`. That second trigger is a bootstrap.

**Why.** The very first strad image has to be pushed to ghcr by _something_, and
the agent session that built this has no PAT with `write:packages` to push one by
hand. The push path in CI uses the built-in `GITHUB_TOKEN`, which can only run
from a workflow in the repo. So the branch trigger lets CI mint `0.1.0` into
`ghcr.io/tadasant/strad` once, tonight, so staging comes up on a real ghcr image
instead of waiting on a merge.

**Undo.** Delete the `feat/strad-core-platform` line from the `on.push.branches`
list in `release-image.yml` before (or immediately after) merge. From then on,
images are cut only from `main`.

---

## 2. Console dev bypass stands in for Google OAuth

**What.** `/console` can be entered by presenting `ADMIN_BOOTSTRAP_TOKEN` instead
of signing in with Google. Guarded three ways (`auth.consoleDevBypass.enabled` +
`ALLOW_DEV_AUTH=true` + a set `ADMIN_BOOTSTRAP_TOKEN`), hard-disabled under
`NODE_ENV=production` unless `ALLOW_DEV_AUTH` is _explicitly_ `true`, and it logs
loudly at boot.

**Crucial scope.** This bypass CANNOT authenticate `/mcp`. `/mcp` only ever
accepts a static system token — there is no code path from the bypass to it. On
the open internet, `/mcp` is never left ungated.

**Why.** Google OAuth client credentials (`GOOGLE_CLIENT_ID` /
`GOOGLE_CLIENT_SECRET`) are being provisioned by the human. The Google path is
complete in code — the provider and its `hd` hosted-domain check
(`src/auth/google.ts`), the signed session the callback mints
(`src/auth/session.ts`), and the gate that accepts it
(`src/ui/console-auth.ts`) — and the bypass sits **alongside** it, not behind it.
A deployment with credentials uses Google; one without still has a door.

**Undo, in this order.** Create a Web-application OAuth client whose authorized
redirect URI is `https://strad.tadasant.com/console/oauth/callback` (there is no
`gcloud` for this — `gcloud iam oauth-clients` is Workforce Identity Federation, a
different product; a classic client is Cloud Console only). Provide
`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` as `strad-<env>-*` secrets, set
`auth.google.enabled: true`, and **verify a real sign-in in prod**. Only then set
`auth.consoleDevBypass.enabled: false` (or unset `ALLOW_DEV_AUTH`), and only then
delete `src/auth/dev.ts` and its call sites — `src/ui/console-auth.ts` imports
from it, so deleting it earlier leaves `/ui` with no fallback authenticator.
Staging depends on the bypass too. Upstream: tadasant/strad#6.

---

## 2b. CI-driven deploy is merge-gated (workflow_dispatch needs main)

**What.** `secrets-sync.yml` and `deploy-staging.yml` are complete and correct,
but two things about them only work once this PR merges:

1. `workflow_dispatch` workflows are only invocable when the file exists on the
   **default branch**. strad's `main` currently has just the initial commit, so
   `gh workflow run secrets-sync.yml` returns 404 until merge.
2. Until `secrets-sync.yml` has run, GCP Secret Manager has no `strad-staging-*`
   secrets, so `deploy-staging.yml` has nothing to inject.

So `deploy-staging.yml` **skips itself and stays green** when triggered
automatically (from a release) without its prerequisites — zimmer's
"safe no-op without the secret" idiom. A manual `workflow_dispatch` still fails
loudly, because there you explicitly asked to deploy.

**Why it isn't blocking tonight.** Staging is already live and proven E2E — it
was deployed directly via the DigitalOcean MCP from the build session (see hack
#3). The CI path is verified as far as it can go pre-merge: `build-and-push`
publishes the ghcr image, and the deploy job authenticates to GCP correctly.

**Undo.** Merge the PR. Then, once on `main`:
`gh workflow run secrets-sync.yml -f strad_tokens='…' -f admin_bootstrap_token='…'`
to seed GCP, and the next release deploys via CI end to end.

---

## 3. Tonight's staging was deployed from the agent session, not CI

**✅ RESOLVED (Phase 2).** `deploy-staging.yml` rebuilds staging from
`infra/strad.staging.yaml` on a **ghcr** image, with secrets from GCP Secret
Manager. Nothing hand-deploys it. The DOCR registry the first deploy used is
still provisioned and still bills — deleting it is hack #4 and issue #8.

**What.** The `strad-staging` App Platform app was first created directly through
the DigitalOcean MCP from the build session, using a hand-rendered spec and
locally-minted tokens. The **image it currently runs is
`registry.digitalocean.com/strad/strad:0.1.0` (DOCR)** — see hack #4.

**Why.** To prove the platform end-to-end tonight without waiting on the CI
merge. `deploy-staging.yml` is the real, intended path and is written to work;
this was the fast lane.

**Undo.** Merge the PR. `release-image.yml` → `deploy-staging.yml` then rebuilds
the app from `infra/strad.staging.yaml` on the ghcr image, with secrets from GCP
Secret Manager. After that, never hand-deploy again.

---

## 4. Staging currently runs a DOCR image; target is ghcr

**✅ RESOLVED (Phase 2).** Staging now deploys **ghcr** images via the CI deploy
path (`infra/strad.staging.yaml` references `ghcr.io/tadasant/…`). The DOCR
`strad` registry itself is still provisioned and still costs ~$5/mo — deleting
it is tracked in issue #8.

**What.** The live staging app pulls `registry.digitalocean.com/strad/strad:0.1.0`
from a DigitalOcean Container Registry named `strad`, not from ghcr.

**Why.** The build session had full DigitalOcean access but no `write:packages`
PAT for ghcr, so DOCR was the only registry it could push to without a human in
the loop. `GHCR_PULL_TOKEN` landed later.

**Undo.** The first CI release (hack #1) publishes to ghcr, and
`deploy-staging.yml` repoints the app at `ghcr.io/tadasant/strad` with
`registry_credentials` from `GHCR_PULL_TOKEN`. Once staging is confirmed on the
ghcr image, **delete the DOCR `strad` registry** (it bills ~$5/mo) with
`doctl registry delete strad`, or via the DO MCP.

---

## 5. GHCR pull tokens are shared between zimmer and strad

**What.** Staging pulls with `GHCR_PULL_TOKEN` (on `tadasant/strad`); prod (in
tadasant-internal) will reuse `GHCR_PULL_TOKEN_ZIMMER_TADASANT_INTERNAL` — the
same classic PAT zimmer already uses. `read:packages` on a classic PAT is
account-wide, so it can pull `ghcr.io/tadasant/strad` fine.

**Why.** Reusing the existing token avoids blocking on a new one.

**Undo.** Mint a dedicated `GHCR_PULL_TOKEN_STRAD_TADASANT_INTERNAL` (same value
is fine, its own name) so zimmer and strad can be rotated independently. Purely
hygiene; nothing breaks without it.

**Watch for.** If App Platform 403s pulling the image, the PAT is _fine-grained_
(package-scoped) rather than classic, and strad's package is not in its scope.
That is a one-line fix on the token — add the `strad` package. The deploy
workflow calls this out explicitly.

---

## 6. Static token records live in an env var, not a database

**What.** System tokens are stored as a JSON array in `STRAD_TOKENS` (only the
SHA-256 of each secret; plaintext shown once at mint). `EnvTokenStore` reads it.

**Why.** No datastore is provisioned, and env-var storage is enough to prove the
auth model. Minting/revoking means editing the secret and redeploying.

`auth.staticTokens.store` reserves the config seat: a single-value enum (`env`)
that no code reads, since `tokenStoreFromConfig` branches on `enabled` alone.

**Undo.** Implement a `TokenStore` backed by a real database (the interface in
`src/auth/tokens.ts` is already the right shape — records mirror a table row) and
build a `/console` UI for mint/revoke. Then `STRAD_TOKENS` goes away and `store`
grows its second value.

---

## 7. Console OAuth state is in-memory

**✅ RESOLVED.** The `state → codeVerifier` map is gone. The PKCE verifier, the
CSRF `state` and the post-login return path now travel in one signed, HttpOnly,
10-minute cookie (`strad_oauth_tx`, `src/auth/session.ts`) — the same sealing
primitive as the console session, under a separately derived key. No login state
lives on the server, so any replica can finish a login any other replica began,
and a redeploy mid-login is not a failed login. Upstream: tadasant/strad#11.

---

## 8. Secret backend: env vars at runtime, GCP at deploy time

**What.** With `gateway.secrets.provider: env` (the schema default, and what
prod runs), the runtime container reads secrets from `process.env`.
`deploy-staging.yml` reads `strad-staging-*` from GCP Secret Manager and injects
them as App Platform SECRET env vars.

**Note.** This is _not_ really a hack — it is a supported posture, and the one
that keeps strad deployable with no vendor attached: the container holds no GCP
credential. Its cost is explicit — a rotated secret does nothing
until the deploy runs again — and `gcp-parameter-store` is the answer for a
deployment that wants runtime rotation (see hack #27 and
`docs/.../operate/secrets.md`). This entry is listed here only because
`secrets-sync.yml`/`deploy-staging.yml` authenticate to GCP with **`GCP_SA_KEY`**,
a long-lived service-account key.

**Undo (the actual debt).** Provision **Workload Identity Federation** — a pool +
provider bound to `tadasant/strad` and `tadasant/tadasant-internal` — so
`google-github-actions/auth@v2` goes keyless. Then **delete `GCP_SA_KEY`** from
both repos.

---

## 9. good-eggs image is bootstrapped from the PR branch

**✅ RESOLVED.** Bootstrap `feat/*` push trigger removed; the image builds from
`main` (path-filtered).

**What.** Two workflows carry a `feat/good-eggs-supplementary` bootstrap trigger:

1. `release-goodeggs-image.yml` — same bootstrap as hack #1: the first
   `ghcr.io/tadasant/strad-server-good-eggs` image has to be pushed by CI (the
   session has no `write:packages` PAT), and the `GITHUB_TOKEN` push only works
   from a workflow in this repo.
2. `ci.yml` `on.push.branches` — this PR targets `feat/strad-core-platform`
   (PR #2), and `pull_request` CI reads the **base** branch's `ci.yml`, which only
   fires for PRs to `main`. A `push` event instead runs this branch's own
   `ci.yml`, so the branch is listed there to get a real typecheck/lint/test/build
   run on the PR's **strad-core** changes (appspec.ts, render-spec.ts, the new
   test, config). `servers/**` is outside the core toolchain (eslint/prettier/tsc
   ignore it) and is validated by `release-goodeggs-image.yml` instead.

**Undo.** Delete the `feat/good-eggs-supplementary` line from `on.push.branches`
in both `release-goodeggs-image.yml` and `ci.yml` before/after merge. Once this
PR retargets to `main` (after PR #2 merges), `pull_request` CI covers it normally.

---

## 10. good-eggs `shared/` is vendored, not a dependency

**What.** `servers/good-eggs/shared/` is copied **verbatim** from
[`pulsemcp/mcp-servers` `experimental/good-eggs/shared`](https://github.com/pulsemcp/mcp-servers/tree/main/experimental/good-eggs)
at commit `44f32a32afe27ffe9d00f23b24934c8242730f65`. Only `remote/` (the
streamable-HTTP entrypoint) is new; the 11 tools and all Playwright logic are
reused unchanged via `createMCPServer()`.

**Why.** The upstream package publishes a stdio `local/` server to npm; it has no
HTTP entrypoint and isn't published as a library strad could depend on. Vendoring
the shared source is the fastest way to reuse the tool logic without forking the
behaviour. strad's eslint/prettier/tsc are scoped away from `servers/**` so the
upstream code keeps its own formatting and toolchain.

**Undo.** When a shared fix is needed, make it upstream in `pulsemcp/mcp-servers`
and re-vendor (bump the commit noted in `servers/good-eggs/README.md`). Longer
term, have upstream publish `shared` as its own package and depend on it.

---

## 11. good-eggs pins Playwright to the base image's Chromium

**What.** `servers/good-eggs` builds `FROM mcr.microsoft.com/playwright:v1.61.1-noble`
(Chromium already bundled) and pins Playwright to `1.61.1` via an `overrides`
block in `servers/good-eggs/package.json`, instead of the PoC's
`node:22-bookworm` + `npx playwright install --with-deps chromium`.

**Why.** `cdn.playwright.dev` was flaky from the build environment (repeated
30s download timeouts), and downloading a browser at image-build time is a
needless point of failure. The Playwright base image carries a Chromium whose
revision (1228) matches Playwright 1.61.1 exactly, so the build never downloads a
browser. The `overrides` keeps `shared/package.json` verbatim (it declares
`^1.49.1`) while guaranteeing the installed Playwright matches the image.

**Cost.** The base image is large (~3.7GB — it ships Chromium, Firefox, and
WebKit). Only Chromium is used.

**Undo.** If image size matters, switch to `node:22-bookworm` and
`npx playwright install --with-deps chromium` (drop the base image and the
`overrides`), accepting the CDN dependency; or build a slimmer custom base that
carries only Chromium. When bumping Playwright, bump the base image tag and the
`overrides` version together so the browser revision stays matched.

---

## 12. good-eggs staging bundle deployed from the session, off DOCR not ghcr

**⊘ SUPERSEDED.** The component this describes no longer exists. The collapse
(hack #24) renders `core` and `bundle` — plus `bundle-zimmer-secrets`, which is
there for a second parameter store rather than for a capability (hack #34) — and
`bundle-goodeggs` is not one of them; good-eggs is now a mount inside
`ghcr.io/tadasant/strad-bundle`. Kept for history. Retained below as written.

**What.** Like the core (hacks #3/#4), the good-eggs `bundle-goodeggs` component
was added to `strad-staging` from the build session (`PUT /v2/apps/{id}` with a
rendered spec), not via `deploy-staging.yml`. And — like the core — the image it
actually **pulls** is DOCR (`registry.digitalocean.com/strad/strad-server-good-eggs:latest`),
not the ghcr image the committed config names.

**Why the DOCR detour.** `tadasant/strad` is **private**, so the pushed ghcr
package (`ghcr.io/tadasant/strad-server-good-eggs`, built green by
`release-goodeggs-image.yml`) inherits private visibility, and App Platform needs
`GHCR_PULL_TOKEN` to pull it. That token is a repo secret, not available to the
session. There is no simple REST call to flip a user package's visibility to
public either. DOCR is same-account, so App Platform pulls it with no credential
— exactly the reason the core is on DOCR tonight. So the session built both
images and pushed them to the DOCR `strad` registry, and rendered the spec with
those DOCR refs. **The committed `infra/strad.staging.yaml` still names the ghcr
image — that is the correct, intended source; only tonight's session-pull used DOCR.**
(The core was also rebuilt from this branch as `strad:goodeggs-e2e` and pushed to
DOCR, so staging runs known-good core code with the supplementary-image path.)

**Undo.** Merge the PR; `deploy-staging.yml` re-renders `infra/strad.staging.yaml`
(good-eggs included) and pulls the **ghcr** image with `GHCR_PULL_TOKEN`. First
confirm the `strad-server-good-eggs` package is in that token's scope (add it if a
pull 403s), then delete the DOCR `strad-server-good-eggs` repo alongside the core
one (hack #4).

---

## 13. good-eggs `/mcp` has no bearer auth of its own

**What.** The good-eggs container serves `/mcp` unauthenticated. Its only
protection is the network boundary: it is an internal-only App Platform component
(`internal_ports: [8080]`, no public route), reachable solely by the core over
the private network. This matches the proven browser-bundle PoC.

**Why.** The core→supplementary proxy path does not send an internal token by
default (unlike the builtin-in-bundle path), so wiring token auth means adding a
`headers:` entry on the config plus a check in `remote/`. Kept minimal for the
first cut; reachability is already gated by the private network.

**Undo (hardening).** Add `headers: { Authorization: "Bearer ${STRAD_INTERNAL_TOKEN}" }`
to the good-eggs server entry and have `remote/` reject requests without it
(`STRAD_INTERNAL_TOKEN` is already present in the bundle's env). Then the bundle
authenticates the core even if the private network is ever breached.

---

## 14. onepassword image is bootstrapped from the PR branch (stacked on good-eggs)

**✅ RESOLVED.** Bootstrap `feat/*` push trigger removed; the image builds from
`main` (path-filtered).

**What.** The onepassword supplementary bundle mirrors good-eggs (hack #9). Two
workflows carry a `feat/onepassword-supplementary` bootstrap trigger:

1. `release-onepassword-image.yml` — the first
   `ghcr.io/tadasant/strad-server-onepassword` image has to be pushed by CI (the
   session has no `write:packages` PAT), so the branch trigger mints it into ghcr
   now. The workflow also asserts `op --version` against the built image before
   pushing, so a broken `op` install can never be published.
2. `ci.yml` `on.push.branches` — this PR is **stacked on
   `feat/good-eggs-supplementary`** (its `supplementary-image` infra — the
   appspec.ts/render-spec.ts/config changes — is not on `main` yet), so the PR's
   base is that feature branch, not `main`. `pull_request` CI only fires for PRs
   to `main`, so a `push` runs this branch's own `ci.yml` to get a real
   typecheck/lint/test/build on the PR's one core-visible change,
   `test/onepassword.appspec.test.ts`. `servers/onepassword/**` is outside the
   core toolchain (eslint/prettier/tsc ignore it) and is validated by
   `release-onepassword-image.yml` instead.

**Undo.** Merge good-eggs (PR #4) to `main`, then merge this PR onto `main` and
delete the `feat/onepassword-supplementary` line from `on.push.branches` in both
`release-onepassword-image.yml` and `ci.yml`. From then, `pull_request` CI covers
it normally and images are cut only from `main`.

---

## 15. onepassword `shared/` is vendored, and its elicitation lib with it

**What.** `servers/onepassword/shared/` is copied **verbatim** from
[`pulsemcp/mcp-servers` `experimental/onepassword/shared`](https://github.com/pulsemcp/mcp-servers/tree/main/experimental/onepassword);
only `remote/` (the streamable-HTTP entrypoint) is new, reusing `createMCPServer()`.
Same rationale as good-eggs (hack #10). One extra wrinkle: `shared/` depends on
`@pulsemcp/mcp-elicitation`, which is **not published to npm** (it lives at
`libs/elicitation` in the upstream monorepo and is consumed there by a `file:`
path). So that library is vendored too, as `servers/onepassword/elicitation/`, a
third workspace built before `shared/`. It has no runtime deps of its own (only
`node:crypto`). `shared/package.json`'s dependency is repointed from the upstream
`file:../../../libs/elicitation` to a workspace `*` — the only edit to the
otherwise-verbatim `shared/`.

**Why.** Reusing the upstream tool logic (nine tools, credential redaction,
elicitation gating) without forking it. `op` itself is not an npm dependency at
all — it is a pinned binary baked into the image (see `servers/onepassword/Dockerfile`,
`ARG OP_VERSION`) and invoked via `child_process`.

**Undo.** When a shared fix is needed, make it upstream and re-vendor both dirs.
Longer term, have upstream publish `@pulsemcp/mcp-elicitation` and `shared` as
real packages and depend on them.

---

## 16. MCP Apps: gating is authoritative at the app-server, additive at the gateway

The `io.modelcontextprotocol/ui` inline-UI feature spans two layers, and they
gate differently because they are stateful in different ways.

1. **good-eggs `remote/` became session-ful.** Capability gating needs the
   client's `initialize` capabilities to govern the whole session (tools/list,
   resources/read, and tools/call all arrive on separate POSTs). The original
   per-POST-stateless endpoint saw the capabilities once and never again, so it
   could not gate. `remote/src/index.ts` now keys a Server per `Mcp-Session-Id`.
   The browser/login model is unchanged — one logged-in page in the factory
   closure, shared across sessions. This is the AUTHORITATIVE gate: a client that
   did not advertise the extension gets a byte-identical plain result.

2. **The core gateway advertises `resources` unconditionally.** strad's `/mcp` is
   deliberately session-LESS (it derives the toolset per request, never from a
   session — see router.ts). So it cannot gate the initialize response by client
   capabilities and still answer the follow-up resources/list POST, which carries
   none — and the SDK refuses to register a resources handler for a server that
   didn't declare the capability. The pragmatic resolution: the gateway always
   advertises `resources` and proxies them (union on list, route on read), and
   always advertises the UI extension to its upstreams so an app-server offers
   its `ui://` template. A non-App client simply never renders the `ui://`
   resource or the tool `_meta` it ignores. **Net:** through the gateway, the App
   surface is exposed to everyone but only rendered by clients that asked for it;
   the strict "byte-identical for non-App clients" guarantee is upheld at the
   app-owning server (good-eggs), which is session-ful.

**Undo.** If the gateway is ever made session-ful (an explicit reversal of the
router.ts design), it could gate `resources` and tool `_meta` on the end
client's capabilities, making the through-gateway surface byte-identical too.
Until then, the two-layer split above is the intended design, not a stopgap.

---

## 17. MCP-App PR stacks on the good-eggs branch; CI trigger is bootstrapped

**✅ RESOLVED.** Merged to `main`; the bootstrap CI branch trigger was removed.

The MCP-App work extends good-eggs, which only exists on
`feat/good-eggs-supplementary`, so its PR is STACKED on that branch (not `main`).
For a `pull_request`, GitHub reads the `on` filter from the BASE branch's
`ci.yml`, which only fires for base `main` — so a PR into the good-eggs branch
gets no `pull_request` CI. Same bootstrap as hacks #1/#9 and the
fetchpet+pointsyeah PR: `feat/good-eggs-mcp-app-ui` is added to
`on.push.branches` so a push runs THIS branch's `ci.yml`. That file also carries
a new `good_eggs` job that builds + runs the server's browser-free MCP-App tests,
since `servers/**` is otherwise out of the core toolchain and only image-built on
push.

**Undo.** Once good-eggs is on `main` and this stack retargets, drop
`feat/good-eggs-mcp-app-ui` from `on.push.branches`. The `good_eggs` job stays —
it is the standing check for `servers/good-eggs`.

---

## 18. An App Platform spec update DELETES any field it omits — including `domains`

Not a hack so much as a loaded gun, and it went off once.

`doctl apps update --spec` is a full **replace**, not a merge. A rendered spec
that omits `domains` does not "leave the domain alone" — App Platform **detaches**
the custom domain and stops serving and renewing its certificate. The failure is
nasty because the app stays perfectly healthy: `strad-staging-wy9v5.ondigitalocean.app`
kept answering 200 while `https://staging.strad.tadasant.com` started failing the
**TLS handshake** (curl 35). Nothing is unhealthy; the hostname is simply gone.

`render-spec.ts` only emitted `domains` when `--domain` was passed, and
`deploy-staging.yml` never passed it (the prod job did). So the first real
staging deploy silently dropped the domain.

Fixed in two layers, because one is not enough:

- `deploy-staging.yml` now passes `--domain staging.strad.tadasant.com`
  explicitly, so the deploy states which hostname it is claiming.
- `render-spec.ts` **defaults** `domains` from the config's own
  `gateway.publicUrl` when `--domain` is absent, so a future deploy that forgets
  the flag still cannot delete the domain. `--domain` still overrides, and a
  `*.ondigitalocean.app` publicUrl is ignored (that is the default ingress, not a
  custom domain). `test/render-spec.domains.test.ts` pins all of this.

The general rule for anything else added to the spec later (alerts, ingress
rules, env): **if it is not in the render, it is being deleted.**

---

## 19. fetchpet + pointsyeah were stacked on the good-eggs branch

**✅ RESOLVED (Phase 2).** The branch stacking was linearized onto `main`, and
both servers are now **enabled with real credentials** in staging and prod —
proven with live tool calls (fetchpet: 15 real claims; pointsyeah: real search
history, refresh token not stale). Kept here only as a record of the original
bootstrap.

**What.** The fetchpet + pointsyeah browser servers were added on top of
`feat/good-eggs-supplementary`, and the PR targets **that branch**, not `main`.

**Why.** `main` does not yet carry the good-eggs browser foundation: the
supplementary-image machinery (`render-spec.ts` bundle-secret injection, the
`servers/good-eggs/` scaffold, the release/CI wiring) lives on
`feat/good-eggs-supplementary`, which diverged from `main` before it merged.
These two servers reuse that exact foundation (same `supplementary-image` kind,
same per-bundle secret scoping, same Playwright base image), so they stack on it
rather than re-introducing it. When the good-eggs stack lands on `main`, this PR
comes with it.

**Also.** Both servers are registered in `infra/strad.staging.yaml` with
`enabled: false`. This OSS staging holds no credentials for them (real creds are
wired downstream in tadasant-internal, which flips them on). A disabled
supplementary image emits no App Platform component and demands no secret at
render (verified: `render-spec` skips it), so staging stays deployable with zero
new secrets. Their images are therefore **not** bootstrap-pushed from the PR
branch (unlike good-eggs in hack #9) — the `release-fetchpet-image.yml` /
`release-pointsyeah-image.yml` workflows fire on `main` + path only. `ci.yml`
carries a `feat/browser-servers-fetchpet-pointsyeah` push bootstrap for the same
reason as hack #9 (a PR to a non-`main` base doesn't fire `pull_request` CI).

**Note (pointsyeah browser reuse).** Upstream pointsyeah launches a fresh
Chromium on every `search_flights` call. On App Platform gVisor that ~1s launch
is pure waste, so `servers/pointsyeah/remote/` injects a browser-reusing
`PlaywrightSearchDeps` (one browser at startup, a new context per search) via the
shared factory's DI seam — `shared/` is left verbatim (see hack #10).

**Undo.** Once the good-eggs stack + this PR reach `main`: delete the
`feat/browser-servers-fetchpet-pointsyeah` line from `ci.yml on.push.branches`;
seed `strad-staging-FETCHPET_USERNAME` / `_PASSWORD` and
`strad-staging-POINTSYEAH_REFRESH_TOKEN` (or leave them to tadasant-internal),
then flip the two servers to `enabled: true`.

---

## 20. The dev-bypass /ui "session" is the bootstrap token in a cookie

**What.** A Google login now mints a real signed, expiring session
(`strad_console_session`, `src/auth/session.ts`), and the gate accepts it as a
first-class principal. The **bypass** half is what is still not a session: once
`ADMIN_BOOTSTRAP_TOKEN` is presented as `?token=…`, the gate moves it into an
**HttpOnly, SameSite=Lax, Secure-in-prod cookie** (`strad_console`) and redirects
to the clean URL, so the token is not left in the address bar, history or
screenshots — but that cookie holds the standing credential itself, re-validated
on every request.

**Crucial scope.** Identical to hack #2: this gate is `/console`-class only. It
CANNOT authenticate `/mcp` — that endpoint takes a static system token and
nothing else (`src/auth/index.ts`), and there is no code path from this cookie to
it. `/ui` is HUMAN-facing HTML; it is not the agent endpoint.

**Why.** Google Workspace OAuth credentials are not provisioned yet (hack #2), so
the bypass is still the only working door on a deployment without them. Reusing
the already-present bootstrap token as the cookie value avoids a second signing
key for a mechanism that is scheduled for deletion. The cookie holds a secret the
operator already has, HttpOnly so page JS cannot read it.

**Undo.** It goes away with the dev bypass itself (hack #2 undo), once Google
sign-in is verified working in prod.

---

## 21. Real per-server GCS creds for /ui/gcs are seeded in a later phase

**✅ RESOLVED (Phase 2).** That later phase happened. `gcs` is `enabled: true`,
scoped to `GCS_BUCKET: pulse_public`, with its service-account key seeded into
GCP Secret Manager for staging and prod. `/ui/gcs` browses a real bucket behind
the SSO gate (401 unauthenticated on both envs, verified).

**Correction (hack #28's fix).** The seeding was done and the credential really
did land on core — but the console could not READ it. It resolved
`consoleEnv:`'s `${GCS_PULSEMCP_SERVICE_ACCOUNT_KEY_JSON}` against core's
environment, where the RENDERER had filed the value under the KEY
`GCS_SERVICE_ACCOUNT_KEY_JSON` and never under the ref name. So `/ui/gcs` reported
"credentials are declared but not resolvable in the console" on a deployment that
had every credential in place, exactly as `/ui/secrets` did. The claim above was
true of the provisioning and false of the page until `src/ui/resolve.ts` learned to
read `consoleEnv:` by key.

**What.** The `gcs` server is registered in `infra/strad.staging.yaml` (its own
`bundle-gcs` bundle) with `enabled: false` and its bucket/credentials as
`${GCS_BUCKET}` / `${GCS_SERVICE_ACCOUNT_KEY_JSON}` refs. So `/ui/gcs` on staging
renders its shell behind the SSO gate and reports "credentials not yet
configured" — it does not browse a real bucket yet.

**Why.** This OSS staging holds no per-server GCS credentials (same posture as
fetchpet/pointsyeah, hack #19). A disabled supplementary image emits no App
Platform component and demands no secret at render, so staging stays deployable
with zero new secrets. The browse code path is proven end-to-end against a real
bucket from the build session (a dependency-free GCS JSON-API client:
`src/ui/gcs-client.ts`), just not wired to staging creds.

**Undo.** Seed `strad-staging-GCS_PROJECT_ID` / `-GCS_BUCKET` /
`-GCS_SERVICE_ACCOUNT_KEY_JSON` (real per-server creds live in tadasant-internal),
flip the `gcs` server to `enabled: true`, and confirm the `strad-bundle-api` ghcr
package is pullable by `GHCR_PULL_TOKEN`. Then `/ui/gcs` browses the live bucket.

---

## 22. Read-only is now POLICY, not PHYSICS

**This is a deliberate security-posture change, and it is the price of the
13-components-to-2 collapse. It was chosen with eyes open. Read it before you
lean on a `-ro` slug.**

Until now, `onepassword-ro` could not write to 1Password because the _container_
could not: it ran with `ENABLED_TOOLGROUPS=readonly`, so the write tools were not
registered — and, for 1Password specifically, it also held a **read-only service
account token**, so 1Password itself would have refused the write. Two locks, one
of them outside our code.

That property is exactly what made the deployment expensive. Capability was a
container env var; a component's env is the union of its servers' env maps; so
`gmail-ro` and `gmail-rw` could not share a container, and every variant bought
its own billed component (12 bundles for 26 servers).

Capability now lives in the gateway (`src/gateway/toolPolicy.ts`). One container
runs every upstream at **full** capability, and a `-ro` slug is read-only because
**strad declines the call**.

What we did to make that decline airtight:

- Enforcement is on the **action**, not the listing. A denied `tools/call` is
  rejected with `-32600` **before the adapter is touched** — no upstream request,
  no side effect. Filtering `tools/list` alone would be decoration: a client can
  call any name it likes, including one it saw last week on a different slug.
- `allow` is **exhaustive**. An upstream that grows a new write tool tomorrow does
  not silently gain it on a read-only slug.
- The bundle host **scrubs** `*_ENABLED_TOOLGROUPS`-shaped env vars at boot, so a
  stale one cannot half-restore the old behaviour (it would strip tools from the
  read-**write** slugs too).
- `test/toolPolicy.test.ts` proves the rejection against a real upstream **with a
  call counter**: if the gateway ever forwarded a denied call, the counter moves
  and CI goes red.

What we lost, precisely:

- **1Password's second lock.** One container holds one `OP_SERVICE_ACCOUNT_TOKEN`,
  and `onepassword-rw` needs the read-write one. So `onepassword-ro` is now
  read-only _only_ because strad says so. If we ever want the token back as a
  physical guarantee, it costs exactly one more component (a second bundle with
  the RO token and only the `onepassword-ro` slug pointed at it) — that is the
  price, and it is worth knowing it is available.
- **Blast radius of a gateway bug.** A bug in `toolPolicy.ts` is now a write
  capability, not a 500. That is why the policy is 40 lines and fail-closed.

## 23. The per-server images still exist, and must, until prod is re-pointed

`servers/bundle/` is now THE image, and `infra/strad.staging.yaml` uses only it.
But `servers/good-eggs/Dockerfile`, `servers/bundle-api/Dockerfile`,
`images/bundle-google/Dockerfile` etc. — and their release workflows — are all
still here, still building, still pushing `:latest`.

Deleting them would be the obvious tidy-up and it would be a **production
incident**. Production's config lives in tadasant-internal and still points at
`ghcr.io/tadasant/strad-server-*:latest`; App Platform re-pulls on every restart.
Delete the workflow and prod keeps running a now-unbuilt tag; change the images'
tool-group plumbing and prod's `-ro` components silently become read-write on the
next pull.

Same reason `servers/bundle-api/remote/src/index.ts` keeps its
`registerWithToggle` machinery: prod still runs that image, and the toggle is
still what makes prod's read-only variants read-only.

**Removal order:** re-point prod at `ghcr.io/tadasant/strad-bundle` (with `tools:`
policies) → confirm → _then_ delete the per-server images, their workflows and the
toggle plumbing.

## 24. Seventeen servers now share one process, and one Chromium

The collapsed bundle is one container running seventeen MCP servers and one
headless Chromium. An OOM there is a seventeen-server outage; it used to be a
one-server outage.

Mitigated where it could be:

- a browser server whose **login fails** is marked `degraded` in `/healthz`
  instead of exiting the process (the standalone images exit — correct for them).
  For fetchpet the mark is a report on the last attempt, not a verdict: the next
  tool call retries the login, and a success clears it. good-eggs still caches its
  first failure until the container restarts;
- **1Password** without an elicitation posture refuses to _mount_, not to boot;
- an **unhandled rejection** is logged, not fatal;
- a **dead Chromium** is relaunched on next use;
- the three browser servers share **one** browser (a context each), so peak RSS is
  ~1GB rather than ~1.6GB.

Not mitigated: a genuine process-level failure. The instance is `apps-s-1vcpu-2gb`
against a measured ~760MB working set with two browsers logging in at once, and
the binding constraint is **CPU** — one shared vCPU now serialises Chromium
rendering _and_ answers every Slack and Gmail call. If the OpenTelemetry data
(event-loop lag, CPU, RSS-vs-limit, Chromium launches/crashes) says we are
saturated, the next move is `apps-d-1vcpu-2gb` ($39, dedicated CPU) — not more RAM.

## 25. The bundle image cannot be rolled back to a published tag — RESOLVED, except for tag accumulation

**✅ RESOLVED.** `deploy-staging.yml` takes a `bundle_version` input that renders
`--bundle-image ghcr.io/tadasant/strad-bundle:<tag>`, and every deploy that does
not set it resolves a `sha-<commit>` bundle tag anyway. The reasoning below for
why the pair should move together still holds — nothing forces you to pin one and
not the other, and pinning the core alone leaves the bundle on the newest image
its ancestors published rather than on a tag that moves.

**The "Also" below is NOT resolved.** Branch and `sha-` tags accumulate in GHCR
with no garbage collection. That half is limitations.md #25 on its own.

**What (as it stood).** `deploy-staging.yml` can pin the **core** to any published tag
(`-f version=0.1.6`, `sha-<sha>`), because the core image is a render-time
argument. The bundle image is not: it is written into `infra/strad.staging.yaml`,
and the only thing that overrides it is `--bundle-image`, which the workflow
passes solely for a branch build. So staging's bundle is either whatever
`strad-bundle:latest` currently points at, or a branch build — never "the bundle
from three commits ago", even though `release-bundle-image.yml` does publish
`:sha-<sha>` for exactly that purpose.

**Why.** A `bundle_version` input is a second dimension on every deploy, and the
core/bundle pair is meant to move together. Rolling the core back without the
bundle is how you get a spec that routes paths the running bundle no longer
serves — the same skew this whole branch-deploy feature exists to avoid.

**Undo.** Add a `bundle_version` input that renders
`--bundle-image ghcr.io/tadasant/strad-bundle:<tag>`; the render-side override
already exists and needs no change. Do it when a bundle rollback is actually
needed, and decide then whether pinning one without the other should be allowed
at all.

**Also.** Branch tags accumulate in GHCR with no garbage collection. They are
cheap and nothing depends on them, but nothing prunes them either.

## 26. The secrets/parameters system is wired end-to-end but not yet live

strad now has a store-agnostic secrets/parameters system: Parameter Manager is
the index of everything, Secret Manager backs the secret parts, and everything is
addressed by the path `/strad/{env}/mcp/{slug}/{kind}/{VARIABLE}` (kind `static`
today; an `oauth` kind is issue #32). Three roles touch it, and they are three
DIFFERENT credentials on purpose:

- the MCP **viewer** (`secrets` server, on the bundle) — lists parameters, reads
  notes and NON-secret values, and in PROD cannot read a secret value: it holds
  neither `secretmanager.versions.access` nor `parameterVersions.render`, which
  are the two calls that return one (staging's is deliberately wider);
- the console **admin** (core only, from `consoleEnv:`, behind SSO) — reads and
  writes both kinds;
- the runtime **resolver** (deploy-time, `STRAD_PARAMS_*`) — reads values to
  inject a `params: true` server's env, never over MCP. It calls Parameter
  Manager ONLY: `:render` dereferences the secret under the parameter's own
  principal, so the resolver never touches Secret Manager itself.

What is NOT done, for staging: the per-server parameter values. The project, the
viewer/admin service accounts AND the resolver service account with its key are
all provisioned — the resolver was the outstanding one and the 2026-07-31
rehearsal created and proved it. `/strad/staging/mcp/` still holds zero
parameters, so a `params: true` supplementary server has nothing to receive. Prod
still needs its own resolver; staging's says nothing about it. Everything above is
tested against an in-memory fake, so the logic ships proven.

Posture nuance worth stating plainly: the resolver credential runs at DEPLOY time
(in CI / `render-spec`), NOT in the container, so "the running container holds no
cloud credential" still holds — the resolved values reach the bundle as ordinary
SECRET env vars, exactly like every other secret. With an empty per-server
namespace, a `params: true` supplementary server (`remote-filesystem-tmp-public`)
boots without its resolved parameters and degrades gracefully.

**And it has been, in staging, since the day it was configured.** The 2026-07-31
rehearsal confirmed it live: `remote-filesystem-tmp-public` is the one
`params: true` supplementary server in `infra/strad.staging.yaml`, and
`/strad/staging/mcp/` holds zero parameters. So that server has
never once received `REMOTE_FILESYSTEM_TMP_PUBLIC_GCS_CLIENT_EMAIL` or
`REMOTE_FILESYSTEM_TMP_PUBLIC_GCS_PRIVATE_KEY`. The resolver credential now
exists, so the cause is no longer a missing identity — it is an empty namespace,
and seeding it is the remaining fix. "Degrades gracefully" is
accurate and is exactly the problem: it degrades so gracefully that nothing said
so. `render-spec` has been printing `server "remote-filesystem-tmp-public" has
params: true but no resolver credential` on every deploy, in a step whose output
nobody reads, and `store:check` — the tool that answers this directly — existed
and had never been run. `deploy-staging.yml` now runs it on every deploy for
exactly that reason.

---

## 27. Runtime secret resolution runs on staging; prod is still on the env provider

**What.** `gateway.secrets.provider: gcp-parameter-store` makes a running gateway
resolve `${NAME}` from `/strad/{env}/gateway/static/` with a TTL, so a secret
rotated in the store reaches production without a deploy, and the app spec carries
exactly one secret — the store credential. It is implemented, tested end-to-end
against the in-memory fake (`test/secrets.rotation.test.ts` drives a real MCP
client through a real gateway to a real upstream that rejects a stale token), and
enabled on STAGING. Prod runs `provider: env`, unchanged byte-for-byte.

**Why prod is not on it.** Enabling a deployment needs its own resolver service
account (hack #26) and its gateway-namespace parameters seeded; prod additionally
needs workflow changes in `tadasant-internal` that are outside this repo. It ships
off by default so the capability can land and be reviewed without a flag day, and
staging is the worked example of switching it on.

**Known boundaries, by design, not by omission.**

- A `supplementary-image` server's `env:` is a container env var on a component
  the gateway does not run. Under the store provider the values are still read
  **from the store** at render time, so a human manages them in one place — but
  changing one needs a redeploy of that component. A supplementary server wanting
  live rotation must read the store itself, as `servers/secrets` does.
- The boot keys (`STRAD_TOKENS`, `STRAD_INTERNAL_TOKEN`, `ADMIN_BOOTSTRAP_TOKEN`,
  `GOOGLE_CLIENT_*`, `OTEL_EXPORTER_OTLP_HEADERS`) are hydrated from the store at
  startup — so they leave the app spec — but take effect on the next restart, not
  within the TTL. A token store and a shared internal token are boot-scoped by
  nature; claiming a rotation had landed while half the fleet still trusted the
  old value would be worse than saying so.
- `consoleEnv:` is deliberately **never** hydrated and stays deploy-time baked
  onto core. It carries the store-**admin** credential, and filing that inside the
  store would let the weaker resolver credential read the stronger one.

**The deploy preflight does not make the flip safe, and it is not trying to.**
`preflightSecrets()` checks `requiredSecretNames()` — the config's `${NAME}` refs
plus `CORE_BOOT_ENV_KEYS` — and of the boot keys counts as missing only the two a
deployment cannot work without. So a namespace can be missing most of what a real
config needs and still deploy green: the optional boot keys are reported and never
counted (`GOOGLE_CLIENT_ID` among them, which with `auth.google.enabled: true` is
a front-door outage on `/ui`, not a dormant one), and a `supplementary-image`
server's `env:` names are outside the check entirely. `scripts/check-store.ts`
(`npm run store:check -- --config <path>`) is the pre-flip counterpart: it counts
every name the deployment reads from the store, names the ones that are absent,
and has a `--mode report` that reports "these N of M are in" without failing, for
a migration that moves one server per day. `--resolve` additionally proves the
resolver can render what it found — the only way to catch a grant that is bound
but cannot `:render`. It reads metadata by default and prints no value in any mode.

**A live rehearsal against staging ran the flip end to end (2026-07-31), and this
hack is now retired for staging.** Two things that had been theory were settled,
and both went the other way from the first attempt earlier the same day:

1. **The resolver credential exists and works.** An earlier pass concluded staging
   had none; the identity was provisioned during the rehearsal and seeded as
   `strad-staging-STRAD_PARAMS_RESOLVER_SERVICE_ACCOUNT_KEY_JSON` alongside
   `strad-staging-STRAD_PARAMS_PROJECT_ID`. `check-store --mode report --resolve`
   now reports `render: 5 of 5 present name(s) resolved to a value` — presence AND
   resolvability, which are different questions.
2. **`STRAD_TOKENS` is render-safe, so the flip has an order rather than a
   blocker.** Under the store provider `render-spec` stops baking the boot keys
   and `preflightSecrets()` counts `STRAD_TOKENS` and `STRAD_INTERNAL_TOKEN` as
   required. `STRAD_TOKENS` is a JSON array of token records, and before the
   base64url encoding (hack #33) that shape could not be stored at all — which is
   why the earlier pass concluded no ordering could flip staging first and fix the
   encoding later. **That conclusion is retired.** The array is seeded, it renders
   against real Google, and the staging gateway authenticates `/mcp` against it
   with no baked copy to fall back on.

   What survives is an ORDERING requirement, not an impossibility: the encoder
   lives in the core image (`create`/`rotate`, and the runtime decode) and in the
   bundle image (the `secrets` MCP write client), so anything seeded by an image
   that predates it is written as raw bytes and refuses to render. Publish and pin
   both images before seeding a single name. Hack #33 also makes an image ROLLBACK
   of `core` past that commit a data hazard for everything seeded after it.

**And the property the whole migration exists for was measured, not argued.** A
seeded name resolved from the store; deleting it fell through to the environment;
and rewriting it in the store took effect in the running gateway within
`ttlSeconds`, from the same container, with no render and no deploy. The order and
the worked example are in `docs/src/content/docs/operate/secrets.md`, under
"Staging ran all four steps, and the property holds".

**Undo.** In order: publish + pin both images at or after the base64url encoding
(hack #33); provision the resolver SA (hack #26) and seed its key as
`strad-staging-STRAD_PARAMS_RESOLVER_SERVICE_ACCOUNT_KEY_JSON` alongside
`strad-staging-STRAD_PARAMS_PROJECT_ID`; seed `/strad/staging/gateway/static/*`;
confirm with `store:check --mode require --resolve`, which the staging deploy now
prints on every run; then flip `gateway.secrets.provider`. The cross-repo half is
tracked as issues against `tadasant/tadasant-internal`.

## 28. An unknown config key is silently ignored at boot; only the deploy gate is strict

**What.** The config schema is built from Zod objects, and Zod strips keys it does
not recognise. So `consoleEnvs:` where you meant `consoleEnv:` is valid YAML, parses
clean, renders clean, deploys clean — and does nothing at all. The gateway never
says a word. That is not hypothetical: `SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON`
reaching `/ui/secrets` in prod depends on one key being spelled right, and nothing
in the pipeline checked it.

**Why boot stays lenient.** The config and the image version independently. An image
that refused to boot on a key it had never heard of would turn a rollback into an
outage — the older image would reject the config the newer one wrote. A false
failure at boot costs an outage; a false pass at deploy costs a silent
misconfiguration. So the strictness lives at the gate, not in the container.

**The gate.** `scripts/check-config.ts` (`npm run config:check -- --config <path>`)
treats an unknown key as a hard failure, exit 1, with a `::error::` annotation and a
"did you mean" suggestion. It needs no credentials — every `${NAME}` gets a dummy —
so any repo holding a config can run it on every PR. `ci.yml`'s `config` job runs it
over all three configs in this repo; the internal repo runs it over
`strad.prod.yaml` (tadasant-internal#206).

**The residue.** Detection is a diff of the source document against the parse
result, so it cannot flag a typo'd key inside an OPEN map — an `env:` /
`consoleEnv:` variable name, a builtin's `options:`, or a role NAME under `roles:`
— because the schema keeps every key there by design. A misspelled ENV VAR name is
still silent. Only a misspelled CONFIG key is caught, and a role's own fields count
as config keys: `roles.admin.serverz` is reported. The "did you mean" suggestion is likewise best-effort: it can only name keys
the parse result carries, so an omitted optional key is not suggestable (the
unknown key is still reported).

**Undo.** Delete `src/config/strict.ts`, `scripts/check-config.ts`, the `config` CI
job and the `config:check` script. Nothing at runtime depends on any of it.

## 29. The console's secret badges prove presence, not that a credential works

**What.** `/ui` lists every configured MCP server and whether the secrets it
requires resolve, and `GET /api/secrets/readiness` returns the same derivation as
JSON. Neither establishes that a credential is still accepted — strad makes no
upstream call to check. So the good badge is `READY` ("everything it needs is
present"), never "healthy", and a server whose token was revoked yesterday reads
`READY` here while 401ing on every call.

**Why the state names are the mitigation.** The badge is trusted at a glance, so the
honesty has to be in the label and in the popout behind it rather than in a
footnote. `ready`, `check value`, `not seeded`, `unverified`, `unknown` and
`no secrets` each claim exactly one thing, and `src/ui/secret-status.ts` derives
them from the running config rather than asserting them. The two-badge collapse
keeps its own line: `READY` is only ever `ready` or `no secrets` — the states the
console ESTABLISHED — and `unverified`/`unknown` badge `ISSUE`, because a green on
"I could not check" is the one lie this surface cannot afford.

**The placeholder heuristic, and why it is narrow.** A value that is evidently
filler gets its own `check value` state: an unexpanded `${...}`, an empty string, or
an exact (case-folded, trimmed) match against a short list of well-known filler
strings, plus a few unmistakable substrings. Deliberately NOT entropy scoring: a
false "this looks fake" sends someone to rotate a working secret, and they cannot
verify without revealing it. Both directions of wrong are costly, so the rule only
fires on shapes no credential issuer emits. It catches the concrete case it was
written for — a `remote-http` bearer token seeded with a placeholder, which boots
fine, lists fine and 401s in isolation — and it will miss a plausible-looking dud.

**The scope gap, mostly closed — see #35.** Under `provider: env` a
`supplementary-image` server's `env:` is resolved at render time and baked onto its
own bundle; `appspec.ts` never broadcasts it, and the console renders in `core`. So
core cannot READ those values, and reporting `missing` would paint a healthy
27-server fleet entirely red. The console therefore does not read them: it ASKS the
component that holds them, over `POST /_strad/presence`
(`src/gateway/bundle-presence.ts`), and the component answers in presence and never
in values. `unverified` survives only where nothing could answer — the component is
down, or it runs an image predating the route — and the row says which. The
remaining edges are #35.

**What it does NOT do, on purpose.** No secret VALUE is rendered or serialised — not
revealed, excerpted, length-hinted, or put in a title attribute or a JSON field. The placeholder check reads a
value and returns a sentence about the SHAPE it matched; nothing in the renderer is
ever handed bytes. `test/ui.secret-status.test.ts` asserts that over a table of
values and asserts the rendered page contains none of them; `test/readiness.test.ts`
holds the same line for the JSON.

**The GSM / ENV badge is coupled to another product's UI, deliberately.** Those two
labels are Zimmer's Connectors page's labels, not strad's. The workflow is to read
that screen and this one and compare, so a divergent spelling defeats the badge —
which makes this a cross-repo coupling with no compile-time link. If Zimmer renames
a label, strad's is silently wrong. `test/ui.secret-status.test.ts` pins both
spellings and their tooltip expansions so the coupling is at least visible in a
diff; nothing can make it automatic from inside this repo. Zimmer's third label
(`Rails Credentials`) has no strad equivalent and is never rendered here.

**The one place outside text can reach the page.** A backend error message is the
only free-form string on the page that strad does not author, and rendering
`err.message` raw LEAKS A SECRET: a store read ends in `JSON.parse` over a
`:render`ed payload — the dereferenced secret in plaintext — and a corrupted
envelope throws a `SyntaxError` whose message embeds a window of that body. On a
cold cache `snapshot.ts` re-throws it raw rather than serving stale values.
Truncating does not help; the window is ~30 characters. `withDeadline` therefore
reuses `errorSummary()` from `snapshot.ts`, which passes a `ParameterStoreError`
message through (method + resource, query and `:verb` stripped) and reduces
anything else to its class name. `test/ui.secret-status.test.ts` builds the real
`SyntaxError` and asserts the value is absent from the rendered detail.

**Undo.** Delete `src/ui/secret-status.ts`, `src/http/readiness.ts`,
`test/ui.secret-status.test.ts`, `test/ui.console-index.test.ts`,
`test/readiness.test.ts`, the badge/popout half of `src/ui/index-page.ts`, the
`/api/secrets/readiness` route in `src/http/app.ts`, the `/secrets` redirect in
`src/ui/index.ts`, and the `secretProvider` option threaded through
`src/http/app.ts` and `src/index.ts`. Nothing else reads any of it.

## 30. Secret parameters written before strad granted them access are not repaired

**What.** `create()` now grants each secret parameter's own principal
`roles/secretmanager.secretAccessor` on the secret it points at, which is what makes
`:render` able to dereference the `__REF__`. Parameters written by an EARLIER strad
carry no such binding, and nothing in the code repairs them: `rotate()` adds a
Secret Manager version and never touches IAM, and there is no reconcile pass. They
keep failing every resolution with `400 SECRET_REFERENCE_ERROR` until a human runs
the backfill.

**Why not self-heal.** A resolver that repaired IAM would need
`secretmanager.secrets.setIamPolicy` in the gateway container — turning the one
deliberately read-only credential in the system into one that can rewrite the access
policy of every secret it reads. That trade is far worse than a one-time human loop.
Doing it in `rotate()` instead would put the same permission on the console's write
path for a case that only exists once, and would still miss every parameter nobody
rotates.

**Blast radius, today.** Small and knowable: prod runs `provider: env` and has no
live parameters, and staging has two `params: true` servers. The backfill loop is in
`docs/operate/secrets-iam.md` ("Backfilling parameters created before strad made
this grant"); it is idempotent, so running it over a store that is already correct
is a no-op.

**How you find out you needed it.** The failure names neither the parameter nor the
missing binding — the resolver reports a 400 while holding every permission the
error implicates, and a `testIamPermissions` probe of that credential comes back
clean. The render assertion at the end of that runbook section is the check.

**Undo.** Nothing to undo; this is a migration gap, not a mechanism. It closes when
every pre-existing secret parameter has been bound once.

## 31. The prod console's write-without-read role can escalate itself to read

**What.** A secret create must grant the parameter's own principal
`secretAccessor` on its secret, so the console's credential needs
`secretmanager.secrets.setIamPolicy`, bound at project level. That permission can
write any binding onto any secret in the project — including granting the console's
own service account `roles/secretmanager.secretAccessor`. The role withholds
`versions.access` and `parameterVersions.render`, and can grant itself the first
back in two API calls.

**Why it ships anyway.** It is inherent to a console that can create secret
parameters at all; removing `setIamPolicy` removes the create. What is fixable is
the CLAIM, so the docs now say plainly that write-without-read here is a speed bump
and an audit signal, not a wall: no bug, bad merge or prompt injection reads a
secret by accident, and anyone who does must first take a conspicuous, logged
policy-write. It is not a wall against a determined holder of the key — which
matters, because that key's rotation is deliberately deferred (`#215`).

**The real fix, not yet applied.** An IAM deny policy on
`secretmanager.googleapis.com/versions.access` and
`parametermanager.googleapis.com/parameterVersions.render` for that principal. Deny
is evaluated before allow and cannot be self-granted around. The command is in
`docs/operate/secrets-iam.md` under "Prod console: write, but never read"; it needs
project IAM admin, which no strad process holds.

**Undo.** Apply the deny policy and this entry closes. Nothing in the code changes
either way — this is an IAM-shaped limitation, not a mechanism in strad.

## 32. The bundle component still deploys a mutable tag — RESOLVED on staging, LIVE on prod

**✅ RESOLVED on staging.** `deploy-staging.yml` resolves `sha-<commit>` for the bundle
exactly as it does for the core (`scripts/resolve-image-tag.ts --kind bundle`),
passes it as `--bundle-image` on every deploy, and passes
`--require-immutable-images`, under which `render-spec` refuses to emit a spec in
which any component ships a tag that moves. `bundle_version` pins the bundle half
for a rollback, which also resolves hack #25. The entry below is kept because it
is the record of what the mutable tag actually did.

**One half is NOT resolved, and it is prod.** `strad-deploy-prod.yml` in
tadasant-internal renders through this same script and passes no
`--bundle-image`, so its supplementary components still ship `:latest` and are
still exposed to exactly this. It gets a `::warning::` naming every affected
component on every deploy rather than a failure, because failing a deploy over a
tag it has no way to change would break prod without fixing anything. The prod
change is two lines in that workflow — resolve a bundle tag the same way, pass
`--bundle-image` and `--require-immutable-images` — and it belongs to whoever
owns that repository.

**What (as it stood).** The core image is now pinned to an immutable tag on every deploy —
`sha-<commit>`, an explicit `version`, or a branch build — and `render-spec`
refuses `latest` for it outright. The **bundle** gets none of that. Its image is
written into `infra/strad.staging.yaml` as
`ghcr.io/tadasant/strad-bundle:latest`, on all 25 `supplementary-image` entries,
and the only thing that overrides it is `--bundle-image` for a branch build.

**Why it matters, and it has now bitten.** This is the same failure that took
staging down, one component over. App Platform may serve a mutable tag from
whatever it resolved last, so a bundle deploy can boot an image whose mounts do
not match the paths the spec routes — and unlike the core, nothing refuses it.

On **2026-07-31** that is exactly what staging was doing. Both `bundle` and
`bundle-zimmer-secrets` were running an image that predated PR #33 (2026-07-24):
they served 14 and 13 mounts respectively, with **no `/secrets`** and with
`/remote-filesystem` under the slug it was renamed away from. `release-bundle-image.yml`
had pushed a fresh `:latest` at 16:33 that same day and the containers restarted
at 16:42 — and still came up on the old image. So "the tag is usually fresh" was
true and did not help: what App Platform serves for a mutable tag is not decided
by what the registry holds.

The symptom was silent. `/mcp?servers=secrets` answered `200 {"tools":[]}` —
core POSTed to `/secrets`, Express answered `404 Cannot POST /secrets`, and the
gateway turned that into an empty list. `/healthz` was 200 with all 27 slugs
listed. Nothing was unhealthy; the `secrets` slug simply could not place a
secret, which is the entire point of it.

**Why it ships anyway.** The core had an immutable tag to reach for:
`release-image.yml` publishes `:<version>` and `:sha-<sha>` per commit, and the
core image is already a render-time argument. The bundle has `:sha-<sha>` too,
but it is a config value, not an argument — pinning it means either editing 24
`image:` lines per bundle release or adding the `bundle_version` input that hack
#25 declines to add. Fixing it properly is a change to how the bundle is
released, not a line in the deploy workflow, and it does not belong in an outage
fix.

**What now detects it.** Not the tag — the consequence. Core probes every mounted
slug's `tools/list` on an interval (`src/gateway/reachability.ts`), logs
`strad.tool_surface_degraded` when a slug's state changes to `unreachable` or
`empty`, and publishes the roster on `/healthz`. The staging deploy polls for
three minutes after the flip and fails if a slug of a kind we DEPLOY is
`unreachable` — a third-party `remote-http` having a bad afternoon is annotated,
not fatal. A stale bundle image no longer deploys green. It still deploys.

**Undone, exactly as written here.** `mutableImageComponents()` checks every
image in the rendered spec, `deploy-staging.yml` resolves the bundle's `sha-` tag
the way it always resolved the core's, and `--bundle-image` needed no change.
Hack #25 went with it.

The detection is still not a substitute, and is still worth having: it catches a
stale image only when the staleness happens to change a MOUNT. An image that
keeps every path and changes what a tool does is invisible to it, and the tag is
the only thing that can speak for that.

## 33. Secret values are base64url in Secret Manager, and the encoding is unverified against live Google

**What.** A secret parameter's bytes are stored base64url-encoded in Secret Manager,
and the Parameter Manager envelope carries `"encoding":"base64url"` to say so. The
value a human sees with `gcloud secrets versions access` is therefore not the value
— it has to be piped through `base64 -d`. strad's own reads (`resolve`, `reveal`,
the MCP `readValue`) decode it, so this is only visible to someone bypassing strad.

**Why.** A strad parameter is created with `parameter-format=JSON`, so `:render`
splices the secret's raw bytes into the payload TEXT and rejects a result that looks
structurally damaged. A value carrying `"`, `\`, `{`, `}` or a newline is a
`400 INVALID_ARGUMENT … injection detected` — which is every PEM key, every
service-account blob and the `STRAD_TOKENS` array. The alternative fixes are worse:
a non-JSON parameter format loses the envelope that carries the canonical path (the
id-collision guard depends on it), and per-value escaping means owning an escaping
scheme for someone else's parser.

**The part that is not verified.** `isRenderSafe` — the predicate that says which
characters break a render — is a LOWER BOUND assembled from one live repro (quotes
fail) and one live control (the five seeded prod names, one of which carries `,` and
`=`, render fine). Braces, brackets, backslashes and control characters are assumed
unsafe rather than demonstrated so. Nothing rests on the boundary being in exactly
the right place, because base64url emits `[A-Za-z0-9_-]` only and is inert under any
detector at least that permissive — but the predicate is also what the in-memory
double enforces, so if Google is STRICTER than this in some way we have not seen,
the double would still be the more permissive of the two.

**Live verification is DONE, against real Google.** Every test here runs against
strad's own double, which substitutes textually and refuses what `isRenderSafe`
refuses — a faithful model of the reported failure, but a model. The staging
runtime-secrets rehearsal closed that gap on the value that motivated the encoding:
`STRAD_TOKENS` — a JSON array of token records, carrying `"`, `[`, `]`, `{` and `}`
— is seeded as a secret parameter in `/strad/staging/gateway/static/` and
`:render`s from `strad-secrets-staging`. `check-store --resolve` reports
`render: 5 of 5 present name(s) resolved to a value`, and the end-to-end proof is
stronger than the roster: under `provider: gcp-parameter-store` `render-spec` does
NOT bake `STRAD_TOKENS` into the spec (it is in the `else` branch above), so the
staging gateway's only copy is the one it renders from the store — and a `/mcp`
request authenticated against it. The encoding round-trips through live
Parameter Manager and Secret Manager, byte-exact.

What remains a lower bound is `isRenderSafe`'s BOUNDARY, not the encoding: braces,
brackets and control characters are still assumed unsafe rather than demonstrated
so. Nothing rests on it, because base64url emits `[A-Za-z0-9_-]` only.

**Undo, and the one place this design fails SILENTLY.** Delete `encoding` from the
envelope and stop calling `encodeSecretValue`. Values written before it are
unaffected — an absent `encoding` has always meant the literal bytes — but values
written while it was on do not merely need re-seeding: code that predates this commit
does not know the field exists, so it hands a child process base64url TEXT as its
credential and reports success. Everything else here is built to fail loudly; this is
the exception, and it applies to an IMAGE ROLLBACK of `core` past this commit as much
as to a revert. That matters because rollback is a first-class path in this repo (boot
stays lenient on purpose so a rollback cannot become an outage). Before rolling `core`
back past this commit, re-seed every secret parameter written after it, or accept that
those names resolve to gibberish.

**The other half of that hazard is checked; the rollback half is not.** The same
silence applies ACROSS TREES, not just across time: `servers/secrets` is its own
npm project and writes to the same store, so a copy of the encoding that lost the
`encoding` field — or folded a path into a different resource id — would fail in
exactly this way, with both halves still answering. That copy is a vendored file
(`src/secrets/parameters/wire.ts` → `servers/secrets/shared/src/parameter-wire.ts`,
`npm run wire:sync`), and `test/parameter-wire.sync.test.ts` fails CI both when it
drifts and when that tree grows a second implementation beside it. Nothing about
that helps a ROLLBACK: an old image carries an old copy of both halves, in sync
with each other and wrong about the store. The paragraph above stands unchanged.

## 34. A second parameter store costs a second billed component

**What.** `infra/strad.staging.yaml` renders THREE App Platform components, not
two. The third, `bundle-zimmer-secrets`, runs the same bundle image as `bundle`
and is only ever routed `/secrets`. It exists because the secrets server reads
`SECRETS_PROJECT_ID` from `process.env` and the bundle host calls `loadConfig()`
with no argument — one container fronts one store — so a slug pointing at a second
GCP project needs a second container. About $12/month at `apps-s-1vcpu-1gb`, for a
store a human touches a few times a month.

**Why it ships anyway.** The alternatives are worse, not cheaper. A parallel
parameters console elsewhere would duplicate the viewer/admin split, the
reveal-flag-versus-IAM logic, `src/ui/param-routing.ts`'s delivery-state classifier
and the capability probe — a lot of load-bearing subtlety to rewrite. Folding both
stores into one GCP project under separate namespaces needs no extra component at
all, but `parameters.list` is authorized on the PROJECT and `SECRETS_NAMESPACES` is
a code-level guard that scopes answers rather than permissions, so it collapses
exactly the boundary the split credentials exist to draw.

**It also wastes most of the container.** The bundle image registers every upstream
at boot (~200MB of Node) though this one serves a single mount, because there is no
build that produces a secrets-only image and adding one would be a second image to
keep current.

**Undo.** An upstream `consoleOnly: true` (or `mcp: false`) flag on a server would
let a second store be console-only — no MCP surface, no second container, no cost.
For a store a human manages and no agent should enumerate that is arguably the
right shape rather than merely the cheaper one. It is not built, and nothing here
blocks on it.

## 35. The presence probe asserts about the process, and the process can lie by being old

**What.** `/ui` and `/api/secrets/readiness` now make a POSITIVE claim about a
secret that lives on a component core is not: `POST /_strad/presence` asks each
bundle what it holds, and the bundle answers with one of five words — `absent`,
`empty`, `unexpanded`, `placeholder`, `present` — and nothing else. That is what
turned "this entry could not be checked from the console" into "plumbed, via env,
on `bundle`, established at 09:12".

**The shape of the claim, and its limit.** It is a claim about the PROCESS, which
is the strongest one available and still not the same as "the deploy is correct".
A container that predates the last render holds the previous deploy's
environment: it can report `present` for a value that has since been rotated in
Secret Manager, or `absent` for one that the last render baked in but that the
running instance never restarted to receive. That is not a bug in the probe, it
is the actual state of the deployment — and it is precisely why `bootedAt` and
`image` are in every report and printed on every row. The console shows the
divergence rather than hiding it, but it does not resolve it, and a reader who
ignores the timestamp can still draw the wrong conclusion.

**The rejected designs, so the trade is legible.** Deriving from `render-spec`
would have been a claim about the last deploy, not the running process — a
rollback re-runs an older spec and App Platform can drop a var, so it would have
said "plumbed" about a process holding nothing. Probing the upstream with the
credential would confirm the credential works, and would be an ORACLE by
construction, would spend third-party calls on a page load, and could not tell
"credential rejected" from "upstream down". Reading the deployed spec from the
DigitalOcean API would need a new cloud credential in core and still describe the
spec rather than the process.

**Why it is not an oracle.** The key roster core sends is derived from the config
core is running, plus whatever the component reports under `STRAD_PARAM_KEYS`.
There is no path from a request parameter on `/ui` or `/api/secrets/readiness` to
a probed name, so no caller can ask strad whether a name of its choosing exists.
The defence is structural, not a filter — which matters, because prod's `/mcp`
credential structurally cannot read a value and prod's console credential is
write-without-read, and a presence surface that let an unprivileged caller
confirm a specific secret would dissolve both. The route itself takes the
existing `STRAD_INTERNAL_TOKEN`, which is strictly stronger than the surface, and
fails closed (503) when it is unset.

**The vendored module.** `src/secrets/presence.ts` is copied byte-identical into
`servers/bundle/host/src/presence.ts` because that tree is a separate npm project
and cannot import across the boundary. `npm run presence:sync` writes it,
`test/presence.sync.test.ts` fails CI on drift. Two copies of the placeholder
table would mean `change-me` reading as filler on one console row and as a
credential on the next, in one list, under one word.

**IT NEEDS AN IMAGE AND A PIN BUMP TO BECOME VISIBLE.** The core half degrades
gracefully — a component that answers 404 is reported `unsupported`, "rebuild and
repin", and its rows fall back to exactly the old `unverified` — so core can ship
first. But nothing on the fleet actually answers until
`ghcr.io/tadasant/strad-bundle` is rebuilt with `servers/bundle/host` and the
`image:` pins in the deployed config move to it. Until then prod's console reads
exactly as it does today, with a sentence naming the pin bump as the reason.

**Live verification is outstanding.** Every state in this feature is constructed
in tests — `test/presence.test.ts`, `test/presence.route.test.ts`,
`test/ui.secret-plumbing.test.ts` — including over a real socket. None of it has
been exercised against a live store or a live bundle: staging was down when this
landed and no staging credential was attached. A green unit suite is not the same
as having run it, and this repo has shipped a bug of exactly that shape before
(the `format: "JSON"` `__REF__` wrapping, which every test accepted).

**The fourth state's blast radius, stated honestly.** `cannot render` is derived
from `resolveDetailed()`, which renders each parameter under its own try/catch
instead of ending the loop at the first failure. So a namespace-wide refusal
costs a FULL pass where it used to cost one call — strictly more work in the
failure case, not merely more results. The loop is bounded at a fan-out of ten,
matching `list()`, so the cost is N/10 round trips rather than N; `resolve()`
still throws, now after the pass rather than during it, naming every hard
failure. That is the right trade for a diagnostic, and it is a real change in
cost that a namespace of hundreds would feel on the deploy path.

**The freshness of the diagnosis is bounded by a deadline, and can lose.**
`readStoreDiagnostics` gives the pair of reads six seconds together. On a large
namespace the render pass can exceed that, and then the whole diagnosis returns
null and `cannot render` is simply not drawn — the console degrades to the states
it had without it rather than to a wrong one.

**And it is bounded by a TTL, which is the trade that stops the amplification.**
The resolver client is cached per process so the pass does not re-mint an OAuth
token per page load, and `readStoreDiagnosticsCached` holds the RESULT for
`gateway.secrets.ttlSeconds`, capped at one minute — so a `/ui` reload and a hard
poller on `/api/secrets/readiness` cost one pass per minute rather than one per
request. What that buys in cost it pays for in freshness: a parameter seeded by
anything other than this console can take up to a minute to change a row, and the
store can be broken for up to a minute before the diagnosis says so. The
staleness is therefore printed rather than hidden — `StoreDiagnostics.ageMs`, the
console's "was read 12s ago", and `store.diagnosis.ageSeconds` in the readiness
JSON — and a write THROUGH the console drops the cache, so a rotation is not
contradicted by the row it was performed from. A pass whose index or render half
did NOT read is held for five seconds instead of the full TTL, because a shrug
cached for a minute would extend an outage; a namespace-wide render REFUSAL is
not that case — it is a complete answer, from the expensive full pass, and is
cached for the whole TTL.

**Undo.** Delete `src/secrets/presence.ts`, `src/secrets/store-diagnostics.ts`,
`src/gateway/bundle-presence.ts`, `src/http/presence.ts`,
`scripts/sync-presence.mjs`, `servers/bundle/host/src/presence.ts` and its route
in `servers/bundle/host/src/index.ts`, the `presence`/`store` options on
`ObserveOptions`, `readDeploymentSecretStatus`, the `unrenderable` state, the
`STRAD_PARAM_KEYS` env var in `src/deploy/appspec.ts`, and
`resolveDetailed`/`renderAll` in `src/secrets/parameters/gcp.ts`. The console
reverts to the `unverified` shrug, which is what it said before.

## 36. One un-renderable parameter makes the WHOLE gateway namespace resolve to nothing

**What.** `resolve()` in `src/secrets/parameters/gcp.ts` lists a namespace and
then calls `:render` on every parameter in it. Any hard render failure makes the
whole call fail. Above it, `SnapshotCache` treats that as a failed refresh —
which is the right posture for an outage (serve the last known good map, warn)
but means that with NO snapshot yet held, the error propagates and `${NAME}`
resolves for nothing in that namespace, not merely for the parameter at fault.

**Why it matters, concretely.** A store-backed gateway reads
`/strad/{env}/gateway/static/` for every `${NAME}` and for its boot keys. So a
single malformed parameter in that namespace is not a degraded name — it is a
gateway that comes up with no token store, no internal token and no config
reference resolved, and `/mcp` rejecting everything. The failure is
all-or-nothing and the blast radius is the deployment.

**The base64url encoding (hack #33) does not fix this, and should not be read as
having done so.** That change stops values _becoming_ un-renderable; this entry is
about what the READ PATH does when one is. The two remaining ways to get an
un-renderable parameter are both live: a parameter written before strad granted
it access to its own secret (hack #30) renders `400 SECRET_REFERENCE_ERROR`
forever until backfilled, and a parameter written by an image that predates the
encoding, then read by one that follows it, fails `decodeStoredValue`'s
round-trip guard by design. Either one, anywhere in
`/strad/{env}/gateway/static/`, takes the whole namespace with it.

So the sequencing in `docs/operate/secrets.md` is not a workaround for an
encoding bug that is now fixed — it is how you avoid discovering this entry the
hard way: pin both images, seed, verify with `store:check --resolve`, and only
then flip.

**What an operator can do about it.** `scripts/seed-store.ts` takes `--only NAME`
and `--exclude NAME`, so a run can be scoped to seed around a name rather than
having to seed it and then `--delete` it back out. That narrows the WRITE and
deliberately not the read-back, which still resolves the whole namespace — a
scoped run that fails on a name it never touched is reporting the truth about the
gateway, not a false alarm about someone else's parameter. Scoping is not a fix
for this entry and cannot be: the two ways to get an un-renderable parameter are
above, and neither is caused by seeding too much.

**Why it ships this way.** Per-parameter tolerance sounds obviously better and is
not. A resolver that returns a namespace with one name silently absent hands the
gateway a bag that looks complete, and the missing name surfaces later as one
failing request against one server — the exact "worse place to find out" that
`preflightSecrets` exists to avoid. Failing the whole read is loud, and the
snapshot cache already makes it survivable for a gateway that has read the
namespace once.

**Undo taken, for diagnosis only.** `resolve()` still fails the namespace when any
hard render fails, but it throws ONE error naming every name that could not
render, with value-free reasons. That keeps the failure whole while making the
diagnosis a single line instead of a bisection. `scripts/check-store.ts
--resolve` reports the same class of failures and is the tool to reach for before
a flip.

## 37. Exported logs are an allowlist, so most of stdout reaches no ingestor

**What.** strad ships its own structured events as OTLP logs, against the
per-event field allowlist in `src/telemetry/events.ts`. It does not ship the
stdout stream. Twelve event types are on the list; everything else strad writes —
and every `console.log` in a vendored server — reaches the container console and
stops there.

**Why it matters.** Three consequences an operator will meet:

- **`mcp.auth_failed` never reaches the ingestor.** It is emitted before
  authentication succeeds, so anyone who can POST `/mcp` could fill the batch
  queue and evict the signals that matter. `strad.mcp.auth_failures` counts the
  same thing by the same `reason`; the per-request detail is on stderr only.
- **A repeated fault is under-reported by up to a minute.** Every exportable
  event a client can drive is throttled to one record per slug per minute, for
  the same queue-starvation reason. The first occurrence always ships, and
  `strad.mcp.tool_surface` carries the same fact continuously, so the gap is in
  the narration rather than in the signal.
- **An upstream's error message is never in the ingestor.** `error` is on no
  allowlist; an event carrying one exports `errorKind()` instead. Diagnosing
  _what_ an upstream said still means reading the container console.

**Why it ships anyway.** The alternative was the status quo, and the status quo
cost a week: the `secrets` slug served zero tools on prod and staging, wrote
`mcp.list_tools_failed` on every request, and shipped none of it. Shipping the
stream instead would drag upstream-authored text — in that incident, a whole HTML
error page — across the boundary `src/telemetry/redact.ts` exists to defend. An
allowlist is the version of this that can be reasoned about; a `pino` transport
is not.

**Undo.** Add events and fields to `EXPORTABLE` as the need for them is
demonstrated, one at a time, each with an answer to "where does this value come
from at every call site". Do not widen it to a denylist: the point is that a
field nobody considered cannot ship.

## 38. A third-party bundle's boot env is BAKED, because it cannot read the store

**What.** Under `gateway.secrets.provider: gcp-parameter-store`, `render-spec`
stops baking the gateway's boot keys and lets each process hydrate them from the
store instead. That works for the core and for a bundle running the strad image.
It does not work for a `supplementary-image` component: it runs a third-party
image, it never executes `hydrateBootEnv`, and it holds no store credential —
`STRAD_IMAGE_ONLY_SECRET_KEYS` keeps the resolver key off it on purpose. So
`render-spec` reads that component's two boot keys —
`BUNDLE_BOOT_ENV_KEYS`: `STRAD_INTERNAL_TOKEN` and `OTEL_EXPORTER_OTLP_HEADERS` —
from the store at render time and bakes them onto it.

**What the render gates, and what it only warns about.** A REQUIRED boot key
(`STRAD_INTERNAL_TOKEN`) that resolves to nothing fails the deploy — preflight
asks `list()`, so a parameter that exists and reports a value can still render
empty, and that half is invisible to it. `bootEnvGaps()` then fails the deploy if
any component in the rendered spec holds neither a boot key it needs nor the
credential to fetch it; that one is a cross-check on the renderer, not on the
store. The OTLP header is deliberately not on the REQUIRED list — an ingestor
that needs no auth is ordinary — though it is still inside `bootEnvGaps()` once
the store yields a value. An ENDPOINT with no resolvable header is a
`::warning::` naming the parameter, and the staging deploy's telemetry report is
the behavioural half.

**Why it matters.** This gap took prod's cutover down and it did it quietly. The
bundle stopped exporting telemetry 44 seconds after a deploy every gate had
passed: `/healthz` 200 with all of prod's 26 slugs, `secrets` serving its 4
tools, `/mcp` 401, `/ui` 302 — nothing user-visible, and the blind component was
the one answering every supplementary slug. That is the same blindness that let a
dead `secrets` slug look healthy for a week (#32). The other name is quieter
still: without `STRAD_INTERNAL_TOKEN` the component's presence route fails closed, and
the console reports that the component refused the internal token rather than
saying what it holds.

**The cost, stated.** A baked value changes on a redeploy, not on a restart. So
rotating `OTEL_EXPORTER_OTLP_HEADERS` is a deploy, and rotating
`STRAD_INTERNAL_TOKEN` is a deploy _even for core_ — core hydrates it, the bundles
are handed it, and a restart of core alone would leave the two disagreeing.
`docs/.../operate/secrets.md` carries the table of which names rotate within
`ttlSeconds`, which need a restart, and which need a deploy.

**The rejected alternative.** Give bundle components the resolver credential so
hydration works as the comment claimed. It fails on both counts: it hands a
credential that reads the entire gateway namespace to every third-party image —
the posture the console's write-without-read role (#31) and the refused
`secretmanager.admin` grant were both built to protect — and it would not even
work, because nothing inside those images knows how to ask.

**The boundary, written down.** The required check is scoped to a store-backed
render that has a supplementary component, because that is the population being
handed a value it cannot fetch. A store-backed deployment whose bundles all run
the strad image is untouched by it: those hydrate, and `hydrateBootEnv` assigning
an empty string is the same hazard it always was.

**Undo.** A supplementary server that needs live rotation reads the store itself,
the way `servers/secrets` does. Short of that, the redeploy is the mechanism.

## 39. A crash report carries free text, and the filter in front of it is heuristic

**What.** `SENTRY_DSN` turns on an exception reporter (`src/telemetry/errors.ts`)
that sends uncaught exceptions, unhandled rejections and boot failures to a
GlitchTip instance. It is the ONE channel in strad that ships text strad did not
fully author: an exception message and a stack trace. Everything else — spans,
metrics, exported log records — ships shape and closed-set words only.

The filter in front of it has two halves, and they are not equally strong. The
first is exact and reliable: every credential-shaped env var this process holds
(and the string leaves of a JSON one like `STRAD_TOKENS`) is struck out **by
value**, so a stack that echoes a secret strad is actually holding cannot carry
it out. The second is **by shape** — PEM blocks, JWTs, `Bearer` lines, URL
userinfo, `secret-ish-key = value` pairs — and a shape rule only catches shapes
somebody thought of.

**Why it matters.** A credential strad does not hold in its own environment, in a
form none of those rules match — an upstream's opaque session cookie, say, echoed
into an error message by a library — could reach the ingestor inside an exception
message. The event allowlist bounds the blast radius (`request`, `user`, `extra`,
`breadcrumbs`, frame `vars` and source context are all dropped, so the only free
text is the message, the exception type and frame paths), and the reporter never
captures the `event()` fault path where upstream-authored text actually lives.
That is a smaller surface than "a stack trace", and it is not zero.

**Why it ships anyway.** The alternative is what came before: a crash produces no
telemetry at all. stdout is never shipped, so an OOM, an uncaught `TypeError` or a
boot that throws leaves nothing but a changed `service.instance.id`. A report
stripped of its message and stack would say "something happened", which is what we
already had. Off by default, and off means nothing is imported at all.

**Undo.** Add a shape rule when a real leak names one, and keep the event
allowlist deny-by-default. If a deployment cannot accept the residual risk, unset
`SENTRY_DSN` — that path is tested, not assumed.

## 40. The tool-surface monitor asks one question, so it can only catch one kind of failure

**What.** `src/gateway/reachability.ts` probes every mounted slug on an interval
and calls `adapter.listTools()`. That is the whole probe. It never issues
`resources/list`, never calls a tool, and never runs two methods against one slug
at the same time.

**Why it matters.** A slug can be broken in a way the monitor is structurally
incapable of seeing. It happened: for seven days in prod, `secrets` answered a
lone `tools/list` perfectly and failed `tools/list` for any client that asked for
resources concurrently (issue #81 — one method's failure closed the shared
upstream connection out from under the other). `strad_mcp_tool_surface` stayed at
4, `/healthz` stayed green, `curl` loops stayed green, and clients kept getting
`-32603`. The alert that eventually fired was on the `mcp.list_tools_failed` /
`mcp.list_resources_failed` event pair, not on the monitor — the monitor was, and
still is, blind to it.

The teardown bug itself is fixed and regression-tested
(`test/adapter.shared-connection.test.ts`). The blind spot is not: any future
failure that needs two methods in flight to appear will again be invisible to
`/healthz`.

And the channel that DID catch it is now quieter, deliberately. Gating
`resources/list` on the upstream's advertised capabilities means a tools-only
slug no longer produces `mcp.list_resources_failed` at all — correct, because
there was no failure, but it does mean the event pair that paged is no longer
watching those slugs. `mcp.list_tools_failed` still fires for a genuinely failing
listing, which is the half that matters.

**It happened a second way, and the same probe missed that too.** A `tools/list`
can be perfect and every `tools/call` can fail: fetchpet's login selector went
stale when Fetch redesigned its form, and the mount spent weeks in both staging
and prod listing four tools and returning `Login failed` for every call
(strad#28). Tool lists are static; a login is not. The bundle's `/healthz` does
report a per-mount `degraded` string for exactly this, and nothing reads it —
not core's probe, not the staging deploy's assertions, not a metric. Every deploy
in that window passed, and the only symptom was a `WARN` line on stdout, a stream
that reaches nobody (#37).

**Undo.** Two halves. Give the probe a mixed-method shape — a concurrent
`tools/list` + `resources/list` per slug, classifying a slug that answers one but
not both as `degraded`; the cost is a second round trip per slug per interval
against upstreams that are already CPU-starved (hack #24), which is why it is
written down here rather than done. And export the bundle's per-mount `degraded`
as a gauge alongside `strad.mcp.tool_surface`, asserted by the staging deploy the
way reachability is — the harder half of that is that "degraded" means something
different per server (a bad refresh token, a missing credential, a failed login
the next call retries), and a signal a deploy can fail on has to say which.

## 41. The service worker's cache version is bumped by hand, and nothing checks it

**What.** The console is installable, and its service worker precaches a fixed
shell — the icons, the manifest and one static offline page — into a cache named
by the `SHELL_CACHE` constant in `src/ui/pwa.ts`, currently `strad-shell-v1`. The
worker's `activate` deletes every cache whose name is not the current one, so
renaming the constant is also the eviction. Nothing renames it for you, and
nothing fails if you forget.

**Why it matters.** The worker's `install` only runs when the worker SCRIPT
changes. The shell LIST is interpolated into that script, so adding or removing a
path does change it, does re-install, and `addAll` re-fetches the whole list —
`Cache.put` replaces a matching entry, so every other shell entry is refreshed
along with it. Those edits are self-healing.

The edit that is not is a change to a cached BYTE that leaves the script
identical: the offline page's copy, or an icon. That content lives behind
`/pwa/offline` and `/pwa/icon-*`, the script is unchanged, no `install` fires,
and the stale copy is authoritative for as long as the installation lives.
Removing a path leaves a smaller mess: the withdrawn entry stays in the cache as
dead bytes against the origin's storage quota. It is never SERVED — the fetch
handler only reads for pathnames on the current list — it just sits there.

`?v=2` does not help either. The worker looks up `url.pathname`, which drops the
search, so a query-stringed shell URL is answered from the same cached entry as
the bare path. Renaming the cache really is the only remedy.

This is bounded. The shell is brand assets and a page whose entire content is
"the network is gone" — a stale one is cosmetic, and it is stale precisely
because it is the version that has no live data in it. It is not bounded by
anything in CI: no test compares the rendered offline page against the cache
name, because a test that did would have to be updated in exactly the same manual
step it is meant to enforce.

**Related, and deliberate:** an offline navigation to `/ui/gcs` renders the
offline page while the address bar still reads `/ui/gcs`. That is how a
navigation fallback works — the response is substituted, not redirected — and the
alternative (a redirect to `/pwa/offline`) would lose the URL the human was
trying to reach across the reconnect.

**Undo.** Derive the cache name from a content hash of the shell instead of a
literal: hash the offline HTML plus the icon bytes at module load and append it,
so any change to a cached byte renames the cache and evicts the old one. It is
five lines and was not done because the shell is four icons, a manifest and a
page, and a hash that turns over on every unrelated theme tweak evicts more often
than the problem justifies.

---

## 42. The installed console's sign-in leaves the app window, and iOS is untested

**What.** The console is installable (`display: standalone`, scope `/`). Open the
installed app on an expired session and `requireConsoleUi` answers `/ui` with a
302 to `/console/login`, which redirects on to `accounts.google.com`. That host
is outside the app's scope, so the browser takes the navigation out of the app
window and into a tab or an in-app browser; the trip returns through
`/console/oauth/callback` and lands back on `/ui`.

**Why it matters.** It is the one user-visible flow installing actually changes,
and it depends on the standalone window and the browser sharing a cookie jar.
That is ordinary on Chrome and Android. On iOS a `standalone` web app has
historically had its own storage partition, which is precisely the assumption
here — a session minted in the Safari tab that ran the OAuth round trip may not be
the session the app window reads, and the app would bounce back to sign-in in a
loop. **Nothing here has been exercised on iOS.** It is written down as unknown
rather than claimed as working.

The question does not arise today: `auth.google` is not provisioned, so the gate
answers `401` with a sign-in wall rendered in place (hack #2) and nothing leaves
the window. It arrives the day Google OAuth lands — the same day hack #2 is
undone, which is why the two should be tested together.

A smaller consequence of the same scope: an offline navigation to
`/console/oauth/callback` now renders the offline page rather than a browser
error. That consumes the trip without spending the authorization code, so nothing
is burned; sign in again once the network is back.

**Undo.** Test the flow on iOS Safari the day OAuth is provisioned, against a
real installed app rather than a simulator tab. If the partition does break it,
the fix is not in the manifest — it is to stop redirecting off-origin from a
gated navigation, i.e. render an in-scope interstitial that starts the OAuth trip
from a user gesture, so the return lands in the window that began it.

## 43. A link longer than seven days is signed with GCS's LEGACY V2 process

**What.** `remote-filesystem-tmp-public` returns a 14-day signed URL by default.
GCS's **V4** signing process caps expiry at seven days (604800s) — Google enforces
it and `@google-cloud/storage` throws rather than clamps — so fourteen days is not
reachable with V4 at all. It is reachable with **V2**, the older process, which has
no cap. Verified against the real bucket: 14-day and 365-day V2 URLs both serve
`200` anonymously.

So `servers/remote-filesystem/shared/src/links.ts` picks by duration: V4 at seven
days or less, V2 beyond it. The response says which, in `signing_version`.

**Why it matters.** Google recommends V4 and describes V2 as the legacy process.
If V2 is ever retired, every link longer than seven days stops being mintable —
`upload_file` and `refresh_link` would start failing for anything over the V4 cap,
loudly (the `StoreError` names the cap and tells the caller to ask for 7 days or
fewer). Links already handed out are unaffected; V2 URLs already in the wild are
validated by Google, not re-minted.

**Why not just ship 7 days.** Because the default was chosen for the human, not
the API: an artifact is usually looked at days after it is made, and a dead link
is the failure this server exists to avoid. And the exposure is bounded by
`refresh_link`, which was designed for exactly this: a dead link is one tool call
away from being alive again.

**What is deliberately NOT done.** No silent downgrade. A 14-day request never
quietly becomes a 7-day link — handing back a link that expires in half the time
the caller asked for is a worse failure than an error, because nothing surfaces it
until the link is already stale in someone's inbox.

**A related, separately-measured edge.** An object that was ever `allUsers`-public
keeps being served from Google's edge cache for up to an hour after its ACL is
tightened — verified: a cache-busting query string returns `403` while the bare URL
still serves the pre-restriction bytes. This server never creates a public object,
so it only bites on objects made public before it existed. `set_sensitivity`'s
description and the docs both say "no new readers", not "no readers".

**Undo.** If Google retires V2, drop `DEFAULT_LINK_DAYS` to 7 and delete
`signingVersionFor` — every link becomes V4 and the seven-day ceiling becomes the
product's ceiling. `refresh_link` absorbs the difference. If Google ever raises the
V4 cap, delete the V2 branch instead.

## 44. `upload_file` reads any local path outside a small denylist

**What.** `servers/remote-filesystem`'s `upload_file` accepts a `file://` URI and
uploads whatever it reads. It runs in the bundle, whose environment holds sixteen
other servers' credentials — one of them a whole Telegram account — so
`file:///proc/self/environ` was a one-call way to publish all of them. `readSource` now refuses `/proc`, `/sys`, `/dev`, `/app`,
`/root` and `/etc`.

**Why it is a hack.** A denylist is not a sandbox. Anything else the process can
read — a temp file another server wrote, a mounted config — is still reachable.
The actual boundary is the gateway: reaching this tool requires a token entitled
to the slug, and the entitlement is the control.

**Undo.** Replace the denylist with a configured upload root
(`_UPLOAD_ROOT`, default `/tmp`) and resolve every `file://` path inside it,
refusing anything that escapes after `realpath`. That is a behaviour change for
callers that pass absolute paths from elsewhere, which is why it is not the
first move.

---

## 45. fetchpet's vendored `shared/` has diverged from upstream

**What.** `servers/fetchpet/shared/` was copied from
[`pulsemcp/mcp-servers` `experimental/fetchpet/shared`](https://github.com/pulsemcp/mcp-servers/tree/main/experimental/fetchpet)
under the same terms as good-eggs (#10), and it no longer matches. The deltas, all
of them driven by running inside the collapsed bundle rather than as a standalone
stdio server:

| Delta                                         | Why                                                                                               |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `setSharedBrowserProvider()` in `server.ts`   | one Chromium for three browser servers; this one opens a context on it                            |
| `telemetry.ts`                                | a browser launch and a Chromium crash are things only this process sees                           |
| `login.ts` and a retried login in `server.ts` | the login form Fetch serves today, and a failure the next tool call retries (#40, strad#28)       |
| `test/`                                       | both of the above, over a fake browser, with no Fetch account — `ci.yml`'s `fetchpet` job runs it |

**Why.** The selector fix could not wait on an upstream round trip: the mount was
broken in prod. The shared-browser seam and the telemetry are strad-specific by
construction — upstream has no bundle to share a browser with.

**Undo.** Land the login fix upstream (it is not strad-specific — the form changed
for everyone) and re-vendor, keeping the seam and telemetry as a documented patch
set. `servers/fetchpet/README.md` carries the same table so the next re-vendor is a
merge with a list, not a diff read cold.

---

## 46. The pre-deploy allow-list check knows by hand which mounts it cannot enumerate

**What.** `check-tool-policy` matches every `tools: allow` / `tools: deny` entry
against the tool names the booted bundle image really serves. A few mounts show
CI a FLOOR rather than the whole surface — `secrets` derives its tools from a
capability probe that fails closed without a credential, `GCS_BUCKET` hides four
tools from `gcs`, and a browser server's surface follows the app it drives — so
those are skipped rather than checked. Which mounts those are is a hand-maintained
map, `PARTIAL_SURFACES` in `servers/bundle/scripts/smoke.mjs`.

**Why.** The alternative is a check that fails a correct config because CI holds
no credential, and a gate that reddens good PRs is a gate somebody disables. The
list is short, it sits beside the tool counts it belongs with, and every skip is
printed with its reason on a passing run — so under-coverage is visible in the log
rather than silent.

**The edge.** A mount that BECOMES credential-dependent and is not added to the
map turns a correct allow-list into a red PR. The failure is loud, names the slug
and the entry, and the fix is one line — but the first person to hit it will
reasonably think the config is wrong.

**Undo.** Have the mount declare its own surface stability, so the observer reads
it from the bundle host rather than from a list beside it. That is a change to
every tree's factory contract, which is why it is a list today.

## 47. Two repos' deploys share one machine, and coordinate only by not colliding

**✅ RESOLVED for this repo's staging deploy** — the rendered spec moved to
`$RUNNER_TEMP`, which no other job can name, and it is asserted immediately
before `doctl` reads it. The underlying condition — several runner processes on
one box, sharing `/tmp` — is unchanged.

**What.** `runs-on: self-hosted` means several runner _processes_ share one
machine and therefore share `/tmp`. `deploy-staging.yml` rendered its App
Platform spec to `/tmp/spec.json`; so does tadasant-internal's prod deploy, on
the same boxes. Nothing coordinated the two.

**How it failed.** On 2026-08-06, `Release image` run 31097159965 (commit #113)
and tadasant-internal's `Deploy strad production` run 31097336627 both landed on
`ci-runner-2`, as `tadasant-strad-ci-2` and `tadasant-internal-ci-2`:

| Time (UTC)    | What                                                                       |
| ------------- | -------------------------------------------------------------------------- |
| `11:29:37.57` | staging renders its spec — 82713 bytes, complete                           |
| `11:29:37.63` | staging attaches GHCR pull credentials to 3 components                     |
| `11:29:38.75` | **prod's render opens `/tmp/spec.json` for writing — 0 bytes**             |
| `11:29:40.05` | staging's `doctl apps update` reads it                                     |
| `11:29:40.75` | `400 … error validating app spec field ".name": .name in body is required` |
| `11:29:40.78` | prod's render finishes — 91302 bytes, naming `strad-prod`                  |

The staging render was byte-identical (82713 bytes, same preflight, same baked
boot keys) to the deploy that had gone green the day before, so the error named a
field the renderer has always set and pointed at a renderer that was innocent.

**Why doctl said nothing.** An empty document is valid YAML `null`. It decodes
into a zero-valued `godo.AppSpec` without error, and doctl PUTs it. The first
component that objects is DigitalOcean's request validator, and it objects about
the first required field of an empty object.

**The worse outcome that did not happen.** One second later on the clock and
staging's doctl would have read prod's _complete_ spec: valid, well-formed, and
carrying prod's images, prod's domains and prod's secrets. `doctl apps update
<staging-id> --spec <prod-spec>` would have replaced the staging app with it, and
the deploy would have gone green. That is why the guard checks the app NAME and
not merely that a name exists.

**The same shape, elsewhere, unfixed.** A shared path is one instance of "two
jobs agree on a name nobody coordinates", and this box has others:

- tadasant-internal's prod deploy still writes `/tmp/spec.json`, and is still
  exposed to any _other_ job on those runners that picks the same name.
  tadasant/strad#115.
- `ci.yml` runs its containers as the fixed names `strad-ci` / `bundle-ci`, on a
  fixed host port, from the fixed image tags `strad:ci` / `strad-bundle:ci`, on a
  shared docker daemon. The name and port collisions are loud. The TAG one is
  not: a concurrent job rebuilding `strad:ci` means this job's
  "`/mcp` with no token returns 401" assertion — the load-bearing one — can pass
  against an image the PR did not build. tadasant/strad#117.

**Undo.** Nothing to undo on this side; the collision needs both writers to agree
on a path, so moving one ends it. The durable fix for the CLASS is ephemeral
runners, so no two jobs ever share a filesystem or a daemon. Short of that, every
fixed name a job writes on a shared box wants a `${{ github.run_id }}` in it.

---

## 48. A restricted link opens as the reader's DEFAULT Google account

**What.** `is_sensitive: true` grants `domain-<viewer>` READER on the object and
hands back `https://storage.cloud.google.com/<bucket>/<path>`. That host is
cookie-authenticated, and a bare URL resolves against **one** of the reader's
signed-in Google accounts — the browser profile's default, account 0, which for
most people is a personal `gmail.com` address. That account is not in the granted
Workspace domain, so Google answers `403`.

The reader IS signed in to an account that would open it. Google never asked that
account, and the `403` is byte-identical to "you were never granted access", so it
reads as a broken grant and sends whoever debugs it to the wrong console.

`servers/remote-filesystem/shared/src/links.ts` therefore appends Google's account
selector, `?authuser=<address>`, when `_SENSITIVE_VIEWER_ACCOUNT` names one.

**Why it is a hack.** The account is configuration, and it is a **hint, not a
grant** — the `domain-` ACL still authorises the whole domain, so the two can
drift: an operator who names a departed employee sends every reader to an account
nobody is signed in to. `loadConfig` catches the two mechanical versions of that
(not an address, not inside the viewer domain) and cannot catch the semantic one.
That check runs where `loadConfig` does — when the store is first built, on the
first tool call after a deploy — so a bad value fails EVERY tool, not just a
sensitive upload. Deliberate, and consistent with `_LINK_DEFAULT_DAYS` and
`_UPLOAD_BASE_URL`, which already throw from the same function: a cosmetic
setting whose only other symptom is someone else's broken link is worth failing
loudly for. **The blast radius is wider than the reachability probe can see**,
though — `tools/list` never constructs the store, so the slug still answers and
`/healthz` stays green while every `tools/call` fails. The bundle host's
`degraded` computation keys on `GCS_BUCKET` and `SENSITIVE_VIEWER_DOMAIN` only,
and was deliberately not widened here (it lives outside this server's tree).

**Two more ways the hint and the grant disagree.** `access: "restricted"` is read
off the object's ACL, not off this deployment's config, so an object granted to
some OTHER `domain-` gets this deployment's `authuser` appended — an account
provably not on that object's ACL, where the bare URL might have worked. And the
domain check is an exact match, so a legitimate Workspace alias or subdomain
address (`dana@mail.example.com` under `example.com`) is rejected with no
workaround but leaving the variable unset.

**It puts a real work address in a URL.** Restricted links get pasted into PR
descriptions and chat. That is a minor disclosure the bare form did not make, and
it is the price of the parameter.

**Why not derive it.** The server never learns who the reader is. An MCP tool call
carries the agent's identity, not the human's, and the link is minted before
anyone opens it. Configuration is the only place the address can come from.

**Why not always emit one.** With no configured account we emit the bare URL
rather than guessing. `authuser` naming an account the reader is NOT signed in to
bounces them to a sign-in page — worse than the `403` for anyone whose default
account was already correct. The `sign_in_hint` on every restricted response
covers that case in words instead.

**What this does NOT fix.** A reader signed in to no Google account, or to no
account in the viewer domain, still cannot open the artifact — correctly. And an
object whose domain grant was dropped (an `is_sensitive: false` re-upload over the
same path silently re-writes the ACL) `403`s for everyone regardless of
`authuser`; `refresh_link` reporting `access: "link"` for something you believe is
sensitive is the tell.

**What is verified, and what is not.** Against the live bucket: the `domain-`
grant lands and reads back, the bare URL `302`s to Google sign-in, and
`?authuser=<address>` is accepted by that endpoint and echoed back decoded
through its `continue=` URL. What is NOT verified is the last step — that a
signed-in multi-account browser then RENDERS the object rather than `403`ing —
because it needs a real Workspace session nobody automating this has. Treat the
fix as strongly-evidenced, not proven, until someone confirms it in a browser.

**Undo.** Unset `_SENSITIVE_VIEWER_ACCOUNT` and links go back to the bare form.

## 49. The Telegram MTProto library is archived upstream

**What.** `servers/telegram` speaks MTProto through `telegram` — GramJS — whose
last release was February 2025 and whose npm page now carries a deprecation
notice pointing at [`teleproto`](https://www.npmjs.com/package/teleproto), a
maintained fork of the same code. strad installs the archived one.

**Why.** GramJS is what the session string is minted by, and `StringSession` is
that string's format; every instruction a human follows to produce the credential
is written against it. `teleproto` is API-compatible and reads the same session
strings, but it is a single-maintainer fork, and swapping the library that holds
a credential equivalent to a whole Telegram account is a decision to take
deliberately rather than to inherit from an npm warning.

**The edge.** Telegram raises its TL layer regularly and an archived client will
eventually meet a constructor it does not know. The methods this server calls
(`messages.getHistory`, `messages.search`, `messages.sendMessage`, dialogs) are
among the oldest and most stable in the protocol, so the likely failure is a
single unparsed field rather than a dead mount — but "likely" is the operative
word, and nothing in CI would catch it, because CI has no credential.

**Undo.** `createMtprotoClient` in `servers/telegram/shared/src/mtproto.ts` is the
only function that imports the library; everything above it drives a structural
`MtprotoClient` interface the tests implement directly. Swapping to `teleproto`
is that function, its two imports and the dependency line — no session re-mint,
no change to any tool.

## 50. The telegram slugs ship disabled, because an unseeded `${REF}` fails the render

**What.** `telegram-ro` and `telegram-rw` are in `infra/strad.staging.yaml` with
`enabled: false`. The mount is in the bundle image and the process registers it
either way — the BUNDLE's own `/healthz` lists it, degraded — but no strad slug
routes to it until a human flips them.

**Why.** `render-spec` resolves every `${NAME}` from GCP Secret Manager and fails
the whole deploy on one it cannot find. That is the right behaviour (a
half-authenticated gateway is worse than a refused deploy), and it means a server
whose credentials do not exist yet cannot ship enabled. `enabled: false` is
skipped at render, so the three unseeded refs cost nothing.

**The edge.** A disabled server is invisible where anyone would look: the
GATEWAY's `/healthz` reports the slugs strad routes, and a disabled one is not
among them, nor in the console, and `?servers=telegram-ro` is a 424. Only the
bundle's internal health route — which nothing outside the app can reach — knows
the mount is there at all.

**Undo.** Seed `strad-staging-TELEGRAM_API_ID`, `-TELEGRAM_API_HASH` and
`-TELEGRAM_STRING_SESSION` (`secrets-sync.yml`), then delete the two `enabled:`
lines. The allow-lists are already checked against the real image by
`policy:check`, so nothing else needs proving first.

## 51. Every image push is tried three times, and cannot tell a flake from a regression

**What.** `.github/actions/build-push` wraps `docker/build-push-action@v6` and runs
the identical build up to three times, 15s and 45s apart, whenever the step fails.
Every workflow step in this repo that pushes to ghcr goes through it.

**Why.** ghcr answers a blob `HEAD` with `403 Forbidden` in the middle of an
otherwise healthy push, on credentials that worked seconds earlier. On 2026-08-11
it turned `main` red ([run 31475413673](https://github.com/tadasant/strad/actions/runs/31475413673)):
the bundle built, the layers exported, `[auth] tadasant/strad-bundle:pull,push`
succeeded, and nine seconds into `pushing layers` one blob came back 403. The same
commit, re-run with nothing changed, pushed fine. Neither buildkit nor
`docker/build-push-action` retries a 403, so one refused blob costs a release and
a human's attention.

**The edge.** The retry cannot see WHY the step failed —
`docker/build-push-action` reports a broken `Dockerfile` and a refused blob the
same way, as a failed step. So:

- A retry after a failed PUSH is cheap: the layers are in the runner's buildkit
  cache, so it re-pushes rather than rebuilds. A retry after a failed BUILD is
  not — buildkit does not cache a failed layer, so that layer and everything
  after it run again on every attempt. A genuinely broken bundle `Dockerfile` is
  built three times, which is minutes of extra wall clock before the run goes
  red.
- A REAL ghcr permission change — the package's visibility flipped, the linked
  repository dropped, `packages: write` removed — looks exactly like the flake,
  three times, and then goes red anyway. The tell is the log: three
  `::warning::build/push attempt N failed` lines with the same 403 mean the
  registry is not flaking, it is refusing. Read them before re-running.
- The wrapper declares only the six inputs its call sites pass. A `with:` key it
  does not declare is DROPPED with a runner warning, not an error — so adding,
  say, `platforms:` or `secrets:` to a call site means declaring it on the
  wrapper first, or the build quietly runs without it.

Nothing here retries the ghcr login, the tag-digest check in `release-image.yml`,
or the deploy's image pull; each is a separate 403 with a separate fix.

`ci.yml`'s `lint` job runs `actionlint` over every workflow, which is what parses
this action on a PR — no PR job loads it otherwise, because the steps that use it
only run on `main`.

**Undo.** Point the ten call sites back at `docker/build-push-action@v6` (add
`push: true`, which the wrapper supplies) and delete `.github/actions/build-push`.

## 52. Two servers on ONE bundle still cannot hold two values for one name

**What.** A supplementary server's `env:` `${NAME}` now resolves from
`/strad/{env}/mcp/{slug}/static/` before `/strad/{env}/gateway/static/`, so two
servers CAN be given different values for one name — as long as they are on
different bundles. Two servers that share a bundle share a container, which has
one `process.env`, and no resolution scheme reaches inside that. `renderAppSpec`
throws when their namespaces disagree.

**Why it is not fixed.** The shared-bundle case is the capability-variant pattern
(`telegram-ro` / `telegram-rw`, `gmail-ro` / `gmail-rw`): two slugs, one mount,
one upstream process, told apart by the gateway's `tools:` policy. They share a
container BECAUSE they share a credential. Making them differ means giving each
its own component — a second billed App Platform service (~$12/month) for a
process that would otherwise be identical. That is a deployment decision, not a
renderer bug, so the renderer states it instead of guessing.

**The edge.**

- The failure is at RENDER time, not at config-check time. `check-config` holds
  no store credential, so it cannot know two identical `${NAME}` strings resolve
  to different values; the deploy is the first thing that can. A config that
  parses clean can still fail the render for this.
- The error names the two slugs and the key, never the values.
- Seeding a per-server namespace for a server that neither sets `params: true`
  nor references the name is a `::warning::`, not a failure — a store is also
  allowed to be a registry of values a human manages by hand. It ships green.
- Substitution only covers a `supplementary-image`'s `env:`. A `builtin`'s
  `options:` and a `remote-http`'s `url`/`headers` resolve IN-PROCESS at runtime,
  from the gateway namespace; their per-server path is `params: true`.

**Undo.** Drop `serverSecrets` from `renderAppSpec` and the per-server read from
`render-spec`; every `${NAME}` goes back to the one flat gateway namespace.

## What the human still needs to provision

A consolidated checklist, cross-referenced above. A checked box is kept rather
than deleted, because prod has to repeat most of what staging already did, and
because each one names the evidence that closed it.

- [x] **The secrets/parameters GCP project + three service accounts** (hack #26) —
      DONE for STAGING. All three exist; the resolver was the last one and the
      2026-07-31 rehearsal created it, seeded its key, and proved it renders. PROD
      still needs its own set — staging having them says nothing about prod. What
      remains for staging is the per-server VALUES, the last sentence of this item.
      The original spec, kept because prod has to repeat it:
      a project holding ONLY the `/strad/staging/mcp/*` parameters (its id is a
      LITERAL in `infra/strad.staging.yaml`, `strad-secrets-staging` — not a
      seeded secret, since a project id is not a credential). A fresh project needs
      billing linked (`gcloud billing projects link`) and `--organization`, plus
      `parametermanager` / `secretmanager` / `iam` enabled, before the SAs can be
      created. Exact predefined roles, verified live: the VIEWER SA gets
      `roles/parametermanager.parameterViewer` ONLY (no `secretmanager.versions.access`,
      and — load-bearing since secret parameters grant their own principal —
      NEVER `roles/parametermanager.parameterAccessor`, which carries
      `parameterVersions.render` and is the one remaining thing between `/mcp`
      and a prod secret value; staging's is deliberately wider, see
      `docs/operate/secrets-iam.md` §2)
      → seed key as `strad-staging-SECRETS_VIEWER_KEY_JSON`; the ADMIN SA gets
      `roles/parametermanager.admin` (note: `admin`, there is no `parameterAdmin`)
      plus `roles/secretmanager.admin` → `strad-staging-SECRETS_ADMIN_KEY_JSON`; the
      RESOLVER SA gets `roles/parametermanager.parameterViewer` plus
      `roles/parametermanager.parameterAccessor` (the accessor role is what carries
      `parameterVersions.render`; the viewer role does NOT, and a resolver holding
      only it lists every parameter and 403s on every value — it does not need
      `roles/secretmanager.secretAccessor`, because the deref runs as the
      parameter's own principal) →
      `strad-staging-STRAD_PARAMS_RESOLVER_SERVICE_ACCOUNT_KEY_JSON` (only needed for
      the deploy-time param injection of `remote-filesystem-tmp-public`). Only the SA
      KEYS are secret; seed them into strad's existing `strad-staging-*` Secret
      Manager project (where SLACK_BOT_TOKEN lives), not the params project. Then set
      both `REMOTE_FILESYSTEM_TMP_PUBLIC_GCS_CLIENT_EMAIL` (non-secret) and
      `REMOTE_FILESYSTEM_TMP_PUBLIC_GCS_PRIVATE_KEY` (secret) in the `/ui/secrets` console.

- [ ] **Google OAuth**: `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` as
      `strad-staging-*` (and `strad-prod-*`) secrets → removes hack #2. Tracked in
      issue #6.
- [ ] **Delete the DOCR `strad` registry** — staging is confirmed on the ghcr
      image (hack #4), and the registry it left behind still bills ~$5/mo.
      Tracked in issue #8.
- [ ] **Dedicated `GHCR_PULL_TOKEN_STRAD_TADASANT_INTERNAL`** for prod → resolves
      hack #5. If any pull 403s, add strad's package to the PAT scope.
- [ ] **Workload Identity Federation** pool + provider bound to both repos, then
      delete `GCP_SA_KEY` → resolves hack #8. Tracked in issue #9.
- [ ] **A datastore** for tokens (and a console mint/revoke UI) → resolves hack
      #6. Tracked in issue #10. Hack #7, the other half of the original item, is
      resolved: no login state lives on the server.
- [x] **The core bootstrap branch trigger is gone** — no workflow under
      `.github/workflows/` carries a `feat/*` push trigger, the images are cut
      from `main`, and `deploy-staging.yml` is what deploys staging. Cleared
      hacks #1 and #3.
- [x] **DNS**: `staging.strad.tadasant.com` resolves DNS-only in Cloudflare to the
      App Platform app, which issues the cert. It is `gateway.publicUrl` in
      `infra/strad.staging.yaml`; see `docs/operate/dns.md` for the wiring.
      Verify it still serves after any deploy — hack #18 is why.
- [x] **The good-eggs bootstrap branch trigger is gone** — cleared hack #9.
      Hack #12 is superseded rather than cleared: the `bundle-goodeggs` component
      it describes does not exist, because good-eggs is a mount in the collapsed
      bundle.
- [x] **The `strad-server-good-eggs` pull check is moot** — staging pulls only
      `ghcr.io/tadasant/strad-bundle`, so `GHCR_PULL_TOKEN` never reaches for that
      package. Prod re-pulls `…-good-eggs:latest` on every restart (hack #23) with
      zimmer's token, which is where its visibility is proven — and that shared
      token is its own debt, hack #5.
- [x] **`strad-staging-GOODEGGS_EMAIL` / `strad-staging-GOODEGGS_PASSWORD` are
      seeded** — `secrets-sync.yml` takes both, `infra/strad.staging.yaml` names
      them as `${…}` refs on an enabled server, and `renderAppSpec` throws on an
      unresolved ref, so a green CI deploy is the proof.
- [x] **The onepassword bootstrap branch trigger is gone** — cleared hack #14.
      The onepassword token (`OP_SERVICE_ACCOUNT_TOKEN`) and its `onepassword-ro`
      / `onepassword-rw` server configs are wired downstream in tadasant-internal,
      not in this repo.
- [x] **The fetchpet/pointsyeah bootstrap branch trigger is gone** — cleared the
      bootstrap half of hack #19.
- [x] **fetchpet / pointsyeah are activated** — both carry real credentials and
      neither is `enabled: false` in `infra/strad.staging.yaml`, proven with live
      tool calls (hack #19).
