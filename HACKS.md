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

**Undo.** Implement a `TokenStore` backed by a real database (the interface in
`src/auth/tokens.ts` is already the right shape — records mirror a table row) and
build a `/console` UI for mint/revoke. Then `STRAD_TOKENS` goes away.

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
there for a second parameter store rather than for a capability (hack #33) — and
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
fetchpet/pointsyeah, hack #14). A disabled supplementary image emits no App
Platform component and demands no secret at render, so staging stays deployable
with zero new secrets. The browse code path is proven end-to-end against a real
bucket from the build session (a dependency-free GCS JSON-API client:
`src/ui/gcs-client.ts`), just not wired to staging creds.

**Undo.** Seed `strad-staging-GCS_PROJECT_ID` / `-GCS_BUCKET` /
`-GCS_SERVICE_ACCOUNT_KEY_JSON` (real per-server creds live in tadasant-internal),
flip the `gcs` server to `enabled: true`, and confirm the `strad-bundle-api` ghcr
package is pullable by `GHCR_PULL_TOKEN`. Then `/ui/gcs` browses the live bucket.

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

## 24. Fifteen servers now share one process, and one Chromium

The collapsed bundle is one container running fifteen MCP servers and one
headless Chromium. An OOM there is a fifteen-server outage; it used to be a
one-server outage.

Mitigated where it could be:

- a browser server whose **login fails** is marked `degraded` in `/healthz`
  instead of exiting the process (the standalone images exit — correct for them);
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

## 25. The bundle image cannot be rolled back to a published tag

**What.** `deploy-staging.yml` can pin the **core** to any published tag
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

## 32. The bundle component still deploys a mutable tag

**What.** The core image is now pinned to an immutable tag on every deploy —
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
`strad.tool_surface_degraded` for any slug that is `unreachable` or `empty`, and
publishes the list on `/healthz` as `degraded`; the staging deploy fails if that
list is non-empty three minutes after the flip. A stale bundle image no longer
deploys green. It still deploys.

**Undo.** Extend `assertImmutableCoreImage` to every image in the rendered spec,
and give `deploy-staging.yml` the same `sha-` resolution for the bundle that it
does for the core (`--bundle-image` already exists and needs no change). Do it
together with hack #25, which wants the same input for the same reason. The
detection above is not a substitute: it catches a stale image only when the
staleness happens to change a MOUNT. An image that keeps every path and changes
what a tool does is still invisible.

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
still throws, now after the pass rather than during it, naming the first hard
failure. That is the right trade for a diagnostic, and it is a real change in
cost that a namespace of hundreds would feel on the deploy path.

**The freshness of the diagnosis is bounded by a deadline, and can lose.**
`readStoreDiagnostics` gives the pair of reads six seconds together. On a large
namespace the render pass can exceed that, and then the whole diagnosis returns
null and `cannot render` is simply not drawn — the console degrades to the states
it had without it rather than to a wrong one. The resolver client is cached per
process so the pass does not also re-mint an OAuth token per page load, but no
result cache exists yet: every `/ui` render and every `/api/secrets/readiness`
call performs the reads afresh, which makes the readiness endpoint an amplifier
for a caller that polls it hard.

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
then calls `:render` on every parameter in it, in sequence, and does not catch
per parameter. The first `:render` that throws aborts the whole call. Above it,
`SnapshotCache` treats that as a failed refresh — which is the right posture for
an outage (serve the last known good map, warn) but means that with NO snapshot
yet held, the error propagates and `${NAME}` resolves for nothing in that
namespace, not merely for the parameter at fault.

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

**Undo.** If the all-or-nothing behaviour is judged worse than the alternative,
collect per-parameter failures in `resolve()` and throw ONE error naming every
name that could not render, rather than the first — that keeps the failure whole
while making the diagnosis a single line instead of a bisection.
`scripts/check-store.ts --resolve` already reports it this way and is the tool to
reach for before a flip.

## What the human still needs to provision

A consolidated checklist, cross-referenced above:

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
      `strad-staging-*` (and `strad-prod-*`) secrets → removes hack #2.
- [ ] **Merge the PR**, then drop the bootstrap branch trigger → removes hacks
      #1 and #3.
- [ ] **Confirm staging on the ghcr image, then delete the DOCR `strad`
      registry** → removes hack #4.
- [ ] **Dedicated `GHCR_PULL_TOKEN_STRAD_TADASANT_INTERNAL`** for prod → resolves
      hack #5. If any pull 403s, add strad's package to the PAT scope.
- [ ] **Workload Identity Federation** pool + provider bound to both repos, then
      delete `GCP_SA_KEY` → resolves hack #8.
- [ ] **A datastore** for tokens (and a console mint/revoke UI) → resolves hacks
      #6 and #7.
- [ ] **DNS**: `staging.strad.tadasant.com` → the App Platform app (handled by a
      parallel session via Cloudflare; grey-cloud/DNS-only, App Platform issues
      the cert).
- [ ] **Merge the PR**, then drop the good-eggs bootstrap branch trigger →
      removes hacks #9 and #12.
- [ ] **Confirm the `strad-server-good-eggs` ghcr package is pullable by
      `GHCR_PULL_TOKEN`** (add it to the PAT scope, or set the package public)
      → resolves the visibility watch in hack #12.
- [ ] **Seed `strad-staging-GOODEGGS_EMAIL` / `strad-staging-GOODEGGS_PASSWORD`
      in GCP** (via `secrets-sync.yml`) so the CI deploy has the good-eggs
      credentials, not just the session-driven deploy.
- [ ] **Merge good-eggs (PR #4) to `main`, then this PR**, then drop the
      `feat/onepassword-supplementary` bootstrap trigger → removes hack #14.
      The onepassword token (`OP_SERVICE_ACCOUNT_TOKEN`) and its `onepassword-ro`
      / `onepassword-rw` server configs are wired downstream in tadasant-internal,
      not in this repo.
- [ ] **Land the good-eggs stack + the fetchpet/pointsyeah PR on `main`**, then
      drop the `feat/browser-servers-fetchpet-pointsyeah` bootstrap trigger →
      removes hack #14.
- [ ] **To activate fetchpet / pointsyeah**: seed
      `strad-staging-FETCHPET_USERNAME` / `_PASSWORD` and
      `strad-staging-POINTSYEAH_REFRESH_TOKEN` (real creds live in
      tadasant-internal), confirm the two `strad-server-*` ghcr packages are
      pullable by `GHCR_PULL_TOKEN`, then flip both to `enabled: true` in
      `infra/strad.staging.yaml`.
