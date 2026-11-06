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
`NODE_ENV=production` unless `ALLOW_DEV_AUTH_IN_PRODUCTION` is _explicitly_ `true`
as well, and it logs loudly at boot.

A caller who is refused is told which of two things happened:
`invalid_bootstrap_token` (the bypass is live, the token is wrong) or
`console_unavailable` (no console door at all). The first discloses that a bypass
is active, and only ever on a deployment that deliberately turned one on — see
`consoleDenial()` in `src/auth/dev.ts`, and "The two ways console auth says no"
in `docs/src/content/docs/auth/overview.md`.

**Crucial scope.** This bypass CANNOT authenticate `/mcp`. `/mcp` only ever
accepts a static system token — there is no code path from the bypass to it. On
the open internet, `/mcp` is never left ungated.

**What that scope stopped covering, since `/tokens`.** It is still true that no
console credential _authenticates_ `/mcp` — that endpoint reads the
`Authorization` header against the token store and nothing else. What is no
longer true is "there is no code path from the bypass to it": a console session
can **mint** a static token (`/tokens`, hack #6), and on a deployment whose
console door is the bypass, that means the bootstrap token can produce an
`admin` credential for `/mcp`. It is a fair characterisation of what a console
admin already was — the same session could rotate the `STRAD_TOKENS` parameter
itself from `/ui/secrets` and get there in two clicks instead of one — and it is
bounded the same way: `/tokens` writes only where
`auth.staticTokens.store: parameter-store` is set, which no config in this repo
sets, and the bypass is what hack #2 exists to delete. Stated rather than left
as a claim that has quietly stopped holding.

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
from it, so deleting it earlier leaves the console with no fallback authenticator.
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

**✅ RESOLVED** for a store-backed deployment. `auth.staticTokens.store:
parameter-store` reads the records from
`/strad/{env}/gateway/static/STRAD_TOKENS` **on the request path**
(`ParameterTokenStore`, `src/auth/tokens.ts`) and writes them from the SSO-gated
console at `/tokens` (`src/ui/tokens.ts`, `src/auth/token-admin.ts`). Mint and
revoke land on a running gateway — no restart, no deploy. The datastore is
Parameter Manager rather than a database: the records are a few hundred bytes,
the store is already there and already credentialed, and invariant 2 puts
config-adjacent state in it. `env` is still the default and still works exactly
as below.

**What remains.** `STRAD_TOKENS` has not "gone away" — it is the same NAME under
both backings, which is deliberate: it is what makes the migration a config flip
with no data move, and what keeps a rollback to an older image working. Two
narrower residuals, both stated on the limitations page:

1. **No compare-and-swap.** Parameter Manager has none, so every write is a
   read-modify-write whose read is a live `:render` through the gateway's
   resolver immediately before the write (the console's own credential cannot
   read on prod; see `docs/operate/secrets-iam.md#token-admin`). Two humans minting inside that window lose one of the two mints. Same
   as hack #91.
2. **"Effective on the next request" assumes ONE core instance.** A write drops
   the reading held by the process that made it, and core runs
   `instance_count: 1` (`src/deploy/appspec.ts`). Nothing enforces that for this
   feature's sake, and a second core instance would keep serving a revoked token
   from its own snapshot for up to `gateway.secrets.ttlSeconds` — a day by
   default — with nothing saying so. The same shape `appspec.ts` already refuses
   for a bundle hosting writable params, and the fix is the same: broadcast the
   invalidation, or refuse the combination.
3. **Staleness during a store outage.** `StoreSecretProvider` serves its last
   known good reading when a re-read fails, so a revocation made while the store
   is unreachable lands when the store answers again. Nothing is ADMITTED from a
   stale reading — an unknown token is unknown — and it is strictly less stale
   than the boot-scoped env var, whose bound was "until the next deploy".

**What.** Under `auth.staticTokens.store: env` (the default) system tokens are
stored as a JSON array in `STRAD_TOKENS` (only the SHA-256 of each secret;
plaintext shown once at mint). `EnvTokenStore` reads it, once, at boot.

**Why.** It keeps strad deployable with no vendor attached — the same argument as
hack #8 for secrets generally. Its cost is explicit: minting or revoking means
editing the secret and redeploying, and `/tokens` renders read-only and says so.

**Undo.** `auth.staticTokens.store: parameter-store`, on a deployment that
already sets `gateway.secrets.provider: gcp-parameter-store`. The schema refuses
the combination without it (there would be nothing to read the records from). A
deployment whose parameter does not exist yet has it created, secret, at the
first mint, seeded from whatever the gateway is currently serving.

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

## 10. good-eggs `shared/` is a FORK — there is no upstream to fix

**What.** `servers/good-eggs/shared/` began as a verbatim copy of
[`pulsemcp/mcp-servers` `experimental/good-eggs/shared`](https://github.com/pulsemcp/mcp-servers/tree/main/experimental/good-eggs)
at `44f32a32afe27ffe9d00f23b24934c8242730f65` and is now first-party: strad owns
it and fixes land here. `servers/good-eggs/FORK.md` lists every delta.

**Why.** The copy carried a "fixes belong upstream, then re-vendor" note that had
nowhere to point. The npm package the defects were reported against,
`good-eggs-mcp-server@0.1.11`, declares no `repository`, `homepage` or `bugs`
URL, and no matching repo exists under `pulsemcp` or `tadasant`. So a real
defect — `get_cart` reporting an empty cart against a 43-item basket, adds
reported as failures, removals refused as "item not found" — had no sanctioned
place to be fixed. Same call as `strad-fetch` and `bundle-api/fork/*`: a server
whose bugs return confident wrong answers becomes first-party.

The fork has taken a second defect on the same reasoning: the post-login wait
used Playwright's default `waitUntil: 'load'`, an event the page Good Eggs lands
on does not fire, so on 2026-08-28 every authenticated call on every tool timed
out after 30 seconds (strad#195). And a third, on what made that outage LAST:
`createMCPServer()` latched the failure of its one boot login, and the bundle
host degrades the mount rather than restarting it, so nothing cleared the latch
and a transient blip bricked the mount until a redeploy (strad#196). A failed
attempt is discarded and the next tool call starts a fresh one, with the host
clearing `degraded` when one succeeds.

**Cost.** A fork has no upstream to argue with it and no sync script to notice a
loss, so `shared/test/` is the only thing defending the deltas. CI runs it as
`servers (good-eggs)` on every PR. strad's eslint/prettier/tsc stay scoped away
from `servers/**`, so this tree keeps its own toolchain.

**Undo.** If upstream ever publishes `shared` as a library with these fixes in
it, depend on it and delete the fork.

---

## 11. The browser images pin Playwright to the base image's Chromium

**What.** `servers/good-eggs`, `servers/fetchpet`, `servers/pointsyeah` and
`servers/bundle` all build `FROM mcr.microsoft.com/playwright:v1.61.1-noble`
(Chromium already bundled) and pin Playwright to `1.61.1` — via an `overrides`
block in the three server trees, and a direct dependency in
`servers/bundle/host` — instead of the PoC's `node:22-bookworm` +
`npx playwright install --with-deps chromium`.

**Why.** `cdn.playwright.dev` was flaky from the build environment (repeated
30s download timeouts), and downloading a browser at image-build time is a
needless point of failure. The Playwright base image carries a Chromium whose
revision (1228) matches Playwright 1.61.1 exactly, so the build never downloads a
browser. The `overrides` keeps each tree's `shared/package.json` verbatim (they
declare `^1.49.1`, `^1.49.1` and `^1.58.2`) while guaranteeing the installed
Playwright matches the image; `servers/bundle/host` has no workspace to keep
verbatim, so it declares the version directly.

**Cost.** The base image is large (~3.7GB — it ships Chromium, Firefox, and
WebKit). Only Chromium is used.

**Undo.** If image size matters, switch to `node:22-bookworm` and
`npx playwright install --with-deps chromium` (drop the base image and the
`overrides`), accepting the CDN dependency; or build a slimmer custom base that
carries only Chromium. When bumping Playwright, bump the base image tag and the
`overrides` version together so the browser revision stays matched —
`test/playwright-pin.test.ts` fails the PR that misses one, and it reads the
versions in this entry too.

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

## 13. A supplementary component's `/mcp` has no bearer auth of its own

**✅ RESOLVED.** Core presents the internal token to every `supplementary-image`
component, and the `strad-bundle` host refuses a mount request without it.

**What.** The `strad-bundle` container — thirty-one mounts, and every upstream
credential behind them — serves every mount unauthenticated. Its only protection
is the network boundary: an internal-only App Platform component
(`internal_ports: [8080]`, no public route), reachable by core over the private
network. That is a REACHABILITY property, not an authorization one, and
`src/gateway/router.ts` says so in as many words about the other half of the same
seam. Anything else that gets into the VPC can talk to the mounts directly.

**Why.** The core→supplementary proxy path sends no internal token, unlike the
builtin-in-bundle path, so the entry described the remedy as a config change:
a `headers:` entry on the server entry plus a check in the image. That was the
wrong shape. Thirty-three `supplementary-image` entries would each have had to
remember the block, and the one that forgot would be silently open.

**Undone by.** Two halves, in code rather than in config:

- `withInternalToken()` in `src/gateway/registry.ts` adds
  `Authorization: Bearer ${STRAD_INTERNAL_TOKEN}` to every `supplementary-image`
  adapter, unconditionally and with no config entry involved. A configured
  `Authorization` still wins — that one names an upstream's credential, not
  strad's.
- `requireInternalToken()` in `servers/bundle/host/src/internal-auth.ts` gates
  every mount on it, through the same `authorizePresence` comparator
  `/_strad/presence` already used: **401** for a missing or wrong token, **503**
  when `STRAD_INTERNAL_TOKEN` is unset, and nothing served either way.

`/healthz` stays open deliberately — App Platform's prober holds no credential,
and a 401 there is a component taken out of service.

**What remains.** Nothing of the shape this entry had. Each component holds its
own token, derived by core (#63), so a sibling container's token is refused here
and the gate authenticates "core, or something holding the root" rather than "a
strad container".

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

## 15. onepassword `shared/` is vendored, and its elicitation lib with it — twice

**What.** `servers/onepassword/shared/` is copied **verbatim** from
[`pulsemcp/mcp-servers` `experimental/onepassword/shared`](https://github.com/pulsemcp/mcp-servers/tree/main/experimental/onepassword);
only `remote/` (the streamable-HTTP entrypoint) is new, reusing `createMCPServer()`.
The upstream package publishes a stdio server, not a library strad could depend
on, so the shared source is copied rather than imported. Fixes belong upstream,
then re-vendor — unlike good-eggs (#10), which is a fork. One extra wrinkle: `shared/` depends on
`@pulsemcp/mcp-elicitation`, which is **not published to npm** (it lives at
`libs/elicitation` in the upstream monorepo and is consumed there by a `file:`
path). So that library is vendored too, as `servers/onepassword/elicitation/`, a
third workspace built before `shared/`. It has no runtime deps of its own (only
`node:crypto`). `shared/package.json`'s dependency is repointed from the upstream
`file:../../../libs/elicitation` to a workspace `*` — the only edit to the
otherwise-verbatim `shared/`.

**And the elicitation library exists twice.** `images/bundle-google` needs the
same unpublished package for its send-email confirmation, and it is its own
Docker build context (`servers/bundle/Dockerfile`, the `build-google` stage), so
it cannot reach into `servers/onepassword/`. Both trees land in the SAME bundle
image under `/app/trees`, and both copies gate an irreversible act through the
library's `requestConfirmation()`: the google one before an email is sent, the
onepassword one before `get_item`, `create_login`, `create_secure_note`,
`share_item` and `create_api_credential` reveal or mint a credential. Its
`readElicitationConfig()` is what decides whether they prompt at all. (What
refuses to MOUNT 1Password is `checkElicitationSafety()` in `shared/`, and that
one reads env vars only — it does not go through this library.) A timeout
tightened in one tree and not the other would be two confirmation semantics under
one `/mcp` with nothing saying so, so the seam is in the `VENDORED` manifest
(`npm run elicitation:sync`, checked by `test/vendored.sync.test.ts`) with
`servers/onepassword/elicitation/src` as the source — the copy a deliberate
change arrives at, since `servers/onepassword/test/` exercises it. The seam
covers the four `src/*.ts` modules, and the same test asserts that list is every
`.ts` file in the source directory; the trees' `package.json`, `tsconfig.json`
and markdown are identical too and stay out, because none of them can carry a
`//` banner.

**Why.** Reusing the upstream tool logic (nine tools, credential redaction,
elicitation gating) without forking it. `op` itself is not an npm dependency at
all — it is a pinned binary baked into the image (see `servers/onepassword/Dockerfile`,
`ARG OP_VERSION`) and invoked via `child_process`.

**Tests.** The tree's Vitest suite is at `servers/onepassword/test/`, at the tree
ROOT rather than inside `shared/`, and imports the vendored TypeScript sources
from there. A re-vendor overwrites `shared/` and never touches `test/`, so the
suite is not part of the merge. The belief that it would have to be is why this
tree had no tests for as long as it did.

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
a new CI job for good-eggs that builds + runs its browser-free MCP-App tests,
since `servers/**` is otherwise out of the core toolchain and only image-built on
push.

**Undo.** Once good-eggs is on `main` and this stack retargets, drop
`feat/good-eggs-mcp-app-ui` from `on.push.branches`. The good-eggs CI leg stays —
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

**Note (pointsyeah tests).** `servers/pointsyeah/shared/` is a verbatim vendor
copy of the same upstream monorepo that hacks #15 and #45 describe, so the tree's
Vitest suite is at `servers/pointsyeah/test/`, at the tree ROOT rather than inside
`shared/`, and imports the vendored TypeScript sources from there. A re-vendor
overwrites `shared/` and never touches `test/`, so the suite is not part of the
merge. The belief that it would have to be is why this tree had no tests for as
long as it did.

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
nothing else (`src/auth/index.ts`), and the cookie is never read there. `/ui` is
HUMAN-facing HTML; it is not the agent endpoint. Since `/tokens` (hack #6) a
console session can _mint_ such a token where the parameter-store backing is
configured, which is the same reach a console admin already had through the
secrets page; hack #2 carries the reasoning.

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
  read-only _only_ because strad says so. The token can come back as a
  physical guarantee at no cost in components: the bundle host mounts a
  1Password instance per slug (#118), so `onepassword-ro` on
  `path: /onepassword-ro` with `ONEPASSWORD_RO__OP_SERVICE_ACCOUNT_TOKEN` set to
  the read-only token is its own mount on the same container. That is a config
  change in the deployment, not here.
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

## 24. Twenty-eight servers share one process, and one Chromium

The collapsed bundle is one container running thirty-one MCP servers and one
headless Chromium. An OOM there is a thirty-one-server outage; it used to be a
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
  within the TTL. A token store and an internal-token root are boot-scoped by
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
a front-door outage on the whole console, not a dormant one), and a `supplementary-image`
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

**What.** `/connectors` lists every configured MCP server and whether the secrets it
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
cold view `view.ts` re-throws it raw rather than serving stale values.
Truncating does not help; the window is ~30 characters. The catch that turns a
failed read into a printable row therefore reuses `errorSummary()` from
`view.ts`, which passes a `ParameterStoreError` message through (method +
resource, query and `:verb` stripped) and reduces anything else to its class
name. That catch sits in `src/ui/secret-status.ts` — in the caller, NOT inside
the shared deadline wrapper in `src/util/deadline.ts`, which is generic and
knows nothing about secrets. The defence is the caller's, and it is written at
the site that needs it so that a second caller of the same wrapper cannot
inherit it by accident or omit it by accident. `test/ui.secret-status.test.ts`
builds the real `SyntaxError` and asserts the value is absent from the rendered
detail, and asserts the same of the deadline's own exit.

**Undo.** Delete `src/ui/secret-status.ts`, `src/http/readiness.ts`,
`test/ui.secret-status.test.ts`, `test/ui.connectors-roster.test.ts`,
`test/readiness.test.ts`, the badge/popout half of `src/ui/roster-page.ts`, the
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

## 32. The bundle component still deploys a mutable tag — RESOLVED on staging, one repository LIVE on prod

**✅ RESOLVED on staging.** `deploy-staging.yml` resolves `sha-<commit>` for the bundle
exactly as it does for the core (`scripts/resolve-image-tag.ts --kind bundle`),
passes it as `--bundle-image` on every deploy, and passes
`--require-immutable-images`, under which `render-spec` refuses to emit a spec in
which any component ships a tag that moves. `bundle_version` pins the bundle half
for a rollback, which also resolves hack #25. The entry below is kept because it
is the record of what the mutable tag actually did.

**✅ RESOLVED on prod, for `ghcr.io/tadasant/strad-bundle`.**
`strad-deploy-prod.yml` in tadasant-internal resolves a bundle tag the same way,
passes it as `--bundle-image`, and passes `--require-immutable-images` as a hard
gate.

**What is NOT resolved is the SECOND first-party image.** Prod's config mounts
`ghcr.io/tadasant/strad-bundle-internal` as well, behind the `craigslist` slug.
`--require-immutable-images` refuses a moving tag on **any** component, so that
second repository has to be pinned too — and it is pinned BY HAND, as a literal
`:sha-…` written into `strad.prod.yaml` in tadasant-internal.

A hand-written sha does not move when a new image publishes, and nothing reads it
back: the deploy renders green, App Platform pulls the digest the operator typed
weeks ago, and prod runs the previous code with no symptom at all. That is a
worse failure than the `:latest` this entry is about, because `:latest` at least
drifts toward the truth.

`--bundle-image` is **repeatable**, once per image repository, which is the
upstream half of removing that pin — each occurrence is matched on its own and
each must match something, so a second override cannot mask a first that has gone
stale. The downstream half is two changes in tadasant-internal, and until they
land the hand-pin is live: resolve a `strad-bundle-internal` tag and pass a second
`--bundle-image` in `strad-deploy-prod.yml`, then put
`ghcr.io/tadasant/strad-bundle-internal:latest` back in the config where the sha
is. See [tadasant/tadasant-internal#1952](https://github.com/tadasant/tadasant-internal/issues/1952).

Once it lands, the per-override rule couples the two: disabling `craigslist` —
the only slug on `strad-bundle-internal` — fails every prod render with "matched
no supplementary server" until the same change drops that `--bundle-image`. That
is intended; the alternative is a deploy that believes it pinned an image nothing
runs.

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
`npm run wire:sync`), and CI fails both when it drifts (`test/vendored.sync.test.ts`,
over every vendored seam at once) and when that tree grows a second implementation
beside it (`test/parameter-wire.ownership.test.ts`). Nothing about
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

**What.** `/connectors` and `/api/secrets/readiness` now make a POSITIVE claim about a
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
There is no path from a request parameter on `/connectors` or `/api/secrets/readiness` to
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
`test/vendored.sync.test.ts` fails CI on drift. Two copies of the placeholder
table would mean `change-me` reading as filler on one console row and as a
credential on the next, in one list, under one word. It carries the ROUTE as
well — `presenceResponse`, the authorize-then-parse-then-answer wiring — for the
same reason at one remove: the copy the fleet runs is the host image's, so a
second handler is one of the two dropping `cache-control: no-store` and the
console rendering a cached "absent" for a credential that is present. Each tree
keeps only the three-line express adapter, and injects its own `node:crypto`
`timingSafeEqual` so the module stays import-free. It also holds `bearerToken`
and `constantTimeEquals` — the single `Authorization` parse and comparator every
door authenticates with, in either image — because `authorizePresence` gates on
them and a vendored file cannot import a sibling.

**IT NEEDS AN IMAGE AND A PIN BUMP TO BECOME VISIBLE.** The core half degrades
gracefully — a component that answers 404 is reported `unsupported`, "rebuild and
repin", and its rows fall back to exactly the old `unverified` — so core can ship
first. But nothing on the fleet actually answers until
`ghcr.io/tadasant/strad-bundle` is rebuilt with `servers/bundle/host` and the
`image:` pins in the deployed config move to it. Until then prod's console reads
exactly as it does today, with a sentence naming the pin bump as the reason.

**ON A `params: true` SERVER THE GAP IS TOTAL, NOT PARTIAL.** Such a server may
declare no `${NAME}` references at all, and then a component that cannot answer
leaves its entry with ZERO requirement rows — not a row reading `unverified`, but
no rows. That is the state `/connectors` explains least well by construction, and it
produced a DEAD CONTROL in prod (#259, on `craigslist`): `badgeMarkup()` rendered
an `ISSUE` button and the dialog list, filtered on `requirements.length > 0`,
emitted no `<dialog>` for it, so `FIX_DIALOG_SCRIPT` found no element and
swallowed the click. The popout is built from the probe outcome — which component
holds the value, which of the five ways the PROBE went unanswered (`unwired`,
`unsupported`, `unreachable`, `unmanifested`, `silent`), and the
`/strad/<env>/mcp/<slug>/static/*` prefix to look under — and the badge and the
dialog ask ONE predicate, `hasFixDialog()`, derived from what the popout will
render and consulted on BOTH badge branches, so the pairing is structural rather
than a convention two functions have to keep. None of that is an observation: the
state stays `unverified`, and making it green is the same pin bump, on that
component's image.

`unmanifested` and `silent` are two reasons rather than one on purpose. A
component that named NO managed parameters for this slug is running a spec
rendered before the slug had `params: true`, and the move is to redeploy it; one
that manifested its parameters and listed none HERE is reporting an empty
namespace, and the move is to seed it. Collapsing them tells an operator to
overwrite a credential that is already in place.

**THE MANAGED NAMESPACE IS A REQUIREMENT, NOT A BRANCH.** An unchecked one is
folded into the ordinary worst-first ranking as `unobservable` — above `present`,
below every piece of bad news — so it demotes a green and never overwrites a red,
whatever the server declares beside it. As an all-or-nothing branch reached only
at zero rows it was skippable by one resolving `${NAME}` in `env:`:
`requirements.length === 1`, worst `present`, badge `READY` over a credential
nothing checked (#265). The scope rides along on the graded entry too, so the
popout names the namespace that went unchecked rather than mentioning it
nowhere.

Two things that entry must NOT say, and both were written and rejected. It does
not say the resolved `${NAME}` is "not what this server runs on" — `optionsFor`
merges a builtin's parameters OVER its resolved `options:`, so the reference is
part of what it runs on and only the namespace went unchecked. And it does not
print the `unverified` headline, whose "this page could not check this server's
credentials" would sit directly above a row that resolved, checked by this gateway
process; a partially established entry gets its own first line.

**A BUILTIN GETS THE SAME PANEL SHAPE AND NONE OF THE SAME SENTENCES.** `params:`
is a field on a BUILTIN too, whose bundle defaults to `core`: a strad process
resolves those parameters itself, per tool call, through the resolver TTL, so the
container vocabulary (private URL, image pin, redeploy the container, a value
that lands at the NEXT DEPLOY) would be false about it. That is why it had no
panel at all — an inert `ISSUE` chip where it has no rows, its `${NAME}` rows and
the summary sentence where it has some — a floor rather than an answer. #264 is
the answer: three more reasons, answered from the config and the environment
rather than from a probe. `resolverCredential()` reproduces `resolverFromEnv`'s
three exits rather than approximating them, so a key JSON that is SET and
unparseable is told apart from an absent one; the two take opposite actions and
the panel names which. THE TWO DOORS DISAGREE ON THAT ONE SHAPE.
`storeReadiness()` in `src/http/readiness.ts` derives `resolverCredential` from
set-ness (`STRAD_PARAMS_PROJECT_ID` and the key JSON both present), so on a
deployment whose key JSON is set and unparseable `/api/secrets/readiness` says a
credential IS present and `params: true` servers resolve their parameters, while
the console panel says the key does not parse. The JSON field is self-consistent
about what it measures — its own `detail` says "are not both set" — and changing
what a published field means is a wider decision than the panel that surfaced
it, so it is written down here rather than folded in. `in-process` is this process resolving them within
`gateway.secrets.ttlSeconds`; `delegated` is a builtin mounted in another
component, which does the same with its own resolver while core proxies;
`inert` is a deployment with no `STRAD_PARAMS_*` credential, where `Registry.build`
gets a null resolver and skips the merge, so the parameters are read by NOTHING
and seeding the namespace changes nothing. Every line is per-reason including the
chip and the evidence line, because those two were the wrong-vocabulary half.

THE BADGE STILL NEVER GOES GREEN. `expectedKeys()` enumerates only bundles
holding supplementary images, so `core` is never probed and the gap is
unconditional and permanent for every `params: true` builtin; `/api/secrets/readiness`
reports `ready: false` for as long as one is configured (#265). Explaining where
a value resolves is not observing that it did. Staging's `echo` is that shape:
`params: true` with one `${STRAD_ENV}` in `options:`, and it reads `unverified`
rather than `READY`.

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

**And it is answered from the process's one reading of the store, which is what
stops the amplification.** The diagnosis reads through the SAME store client the
gateway resolves through (`diagnosticStore` is the runtime resolver, from
`src/index.ts`), and that client holds one reading for `gateway.secrets.ttlSeconds`
(#69). `readStoreDiagnosticsCached` additionally holds the pass's RESULT for up to
one minute, so a hard poller does not re-slice per request and a store that is
DOWN costs one attempted pass per backoff. What that buys in cost it pays for in
freshness: a parameter seeded by anything other than this console can take up to
the TTL to change a row, and the store can be broken for that long before the
diagnosis says so. The staleness is therefore printed rather than hidden —
`StoreDiagnostics.ageMs` is the age of the READING, not of the pass; the
console's "was read 12s ago"; and `store.diagnosis.ageSeconds` in the readiness
JSON — and a write THROUGH the console drops the reading, so a rotation is not
contradicted by the row it was performed from. A pass whose index or render half
did NOT read is held for five seconds instead of the full TTL, because a shrug
cached for a minute would extend an outage; a namespace-wide render REFUSAL is
not that case — it is a complete answer, from the expensive full pass, and is
cached for the whole TTL.

**Undo.** Move `bearerToken` and `constantTimeEquals` out first — every door in
both trees authenticates with them, and the host's internal-token gate imports
them from the vendored copy. Then delete `src/secrets/presence.ts`,
`src/secrets/store-diagnostics.ts`,
`src/gateway/bundle-presence.ts`, `src/http/presence.ts`,
the `presence` entry in `scripts/sync-vendored.mjs`,
`servers/bundle/host/src/presence.ts` and the route that mounts it in
`servers/bundle/host/src/index.ts`, the
`presence`/`store` options on
`ObserveOptions`, `readDeploymentSecretStatus`, the `unrenderable` state, the
`STRAD_PARAM_KEYS` env var in `src/deploy/appspec.ts`, and
`resolveDetailed`/`renderAll` in `src/secrets/parameters/gcp.ts`. The console
reverts to the `unverified` shrug, which is what it said before.

## 36. One un-renderable parameter makes the WHOLE gateway namespace resolve to nothing

**What.** `resolve()` in `src/secrets/parameters/gcp.ts` lists a namespace and
then calls `:render` on every parameter in it. Any hard render failure makes the
whole call fail. Above it, `NamespaceView` treats that as a failed read —
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
stdout stream. Thirty-two event types are on the list and seven are deliberately
off it, each with its reason beside it in `NOT_EXPORTED`; everything else strad
writes — and every `console.log` in a vendored server — reaches the container
console and stops there.

**Why it matters.** Five consequences an operator will meet:

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
- **A tool the capability policy withholds is a slug and a count, and no more.**
  `mcp.tool_denied` exports its slug, and `strad.mcp.tool_denials` counts the
  refusal per slug. The `tool` the caller asked for is free text a client writes;
  `principal` is a token `pubid` through `/mcp` but a signed-in human's Google
  `sub` through the console playground, which builds the same server. Both stay
  on the stream. "How often is this slug refusing calls" is a query; "which tool,
  and who" is a read of the container console.
- **The lines that would tell you the exporter is off are on the console only.**
  `telemetry.disabled`, `telemetry.start_failed`, `errors.started` and
  `errors.start_failed` all fire at a moment when the exporter that would carry
  them is not running — two because it failed to start, one because none is
  configured, and `errors.started` because `startErrorReporter` runs ahead of
  `startTelemetry`. Blind by construction rather than by redaction: their fields
  would all pass the field test. `telemetry.started` is the one of the five that
  does export, as its name and nothing else, so a boot that dies between the SDK
  starting and `strad.listening` is no longer the same silence as a container
  that never started.

**Why it ships anyway.** The alternative was the status quo, and the status quo
cost a week: the `secrets` slug served zero tools on prod and staging, wrote
`mcp.list_tools_failed` on every request, and shipped none of it. Shipping the
stream instead would drag upstream-authored text — in that incident, a whole HTML
error page — across the boundary `src/telemetry/redact.ts` exists to defend. An
allowlist is the version of this that can be reasoned about; a `pino` transport
is not.

**Undo.** Add events and fields to `EXPORTABLE` as the need for them is
demonstrated, one at a time, each with an answer to "where does this value come
from at every call site" — and move the entry out of `NOT_EXPORTED` in the same
edit. `mcp.tool_denied` and `telemetry.started` are what that looks like done:
each carries its own per-field trace, and the first is paired with the counter
that answers the fields it cannot export. Do not widen it to a denylist: the
point is that a field nobody considered cannot ship. `test/telemetry.event-export-decisions.test.ts` holds the two tables
against the call sites, so an event with no verdict fails the build rather than
quietly reaching nobody.

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
(strad#28). Tool lists are static; a login is not. Every deploy in that window
passed, and the only symptom was a `WARN` line on stdout, a stream that reaches
nobody (#37). The same shape recurred in prod on 2026-08-28: `good-eggs` listed
its tools while every authenticated call returned `Login failed:
page.waitForURL: Timeout 30000ms exceeded` (strad#195).

That second blind spot is REPORTED and not GATED. The bundle's `/healthz` carries
a per-mount `degraded` string for exactly this case, and core reads it on the
probe interval (`src/gateway/mount-health.ts`, strad#92): a
`strad.mcp.mount_degraded` gauge at 1 per slug, `strad.mount_state` on change (at
Info), `mountDegraded` and `mountUnread` on core's `/healthz`, and a `::warning::`
from the staging deploy. What crosses is one BIT per slug. The
bundle's reason — `login failed: ${error.message}`, upstream text — is dropped
where it is parsed, so the WHY is still only on the bundle's own `/healthz` and in
its container log. Three edges of that:

- **Nothing fails on it.** The staging deploy annotates and exits 0. A bit cannot
  say whether a mount is a failed login the next call retries, a credential
  nobody has set, or a refresh token to re-set through a tool, and only some of
  those are a deploy's fault.
- **The gauge holds its last value while a bundle cannot be read.** A slug with
  no reading records nothing, and under cumulative temporality the last recorded
  value keeps exporting. `mountUnread` on core's `/healthz` names the slugs,
  `strad.mount_report` says when a bundle's report became unreadable and when it
  came back, and `strad.mcp.tool_surface` carries a bundle that is down.
- **The deploy's read is one moment.** The step waits for a core observation
  newer than the one its first read saw, which is after most boot-time logins
  have failed or succeeded; a login that fails later is on the gauge and not in
  the run.
- **It does not page.** `strad.mount_state` ships at Info, not as a `_degraded`
  fault: one bit cannot tell a failed login from a credential deferred on purpose
  (a `mayBeUnseeded:` waiver on a bundle's `env:`), and the deferred case is
  documented as paging nobody. The gauge is the alert channel, scoped by slug.

**Undo.** Two halves. Give the probe a mixed-method shape — a concurrent
`tools/list` + `resources/list` per slug, classifying a slug that answers one but
not both as `degraded`; the cost is a second round trip per slug per interval
against upstreams that are already CPU-starved (hack #24), which is why it is
written down here rather than done. And make the bundle's report GATEABLE: have
the bundle host author a closed-set class where it SETS `degraded`, per mount
(`login_failed`, `credential_missing`, `token_invalid`), carry it beside the
reason on its `/healthz`, and let the staging deploy fail on the classes that are
this deploy's fault. Classifying the reason in core instead would decide the
class by pattern-matching an upstream's error message. The export half of this is
done; the class is what is left.

## 41. The service worker's cache version is bumped by hand, and nothing checks it

**What.** The console is installable, and its service worker precaches a fixed
shell — the icons, the manifest and one static offline page — into a cache named
by the `SHELL_CACHE` constant in `src/ui/pwa.ts`, currently `strad-shell-v2`. The
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
installed app on an expired session and `requireConsoleUi` answers `/connectors` with a
302 to `/console/login`, which redirects on to `accounts.google.com`. That host
is outside the app's scope, so the browser takes the navigation out of the app
window and into a tab or an in-app browser; the trip returns through
`/console/oauth/callback` and lands back on `/connectors`.

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
uploads whatever it reads. It runs in the bundle, whose environment holds twenty
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
as a vendor copy — the upstream package publishes a stdio server, not a library
strad could depend on — and it no longer matches. (good-eggs, #10, went the other
way and is a fork; this tree is still a copy.) The deltas, all
of them driven by running inside the collapsed bundle rather than as a standalone
stdio server:

| Delta                                         | Why                                                                                                         |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `setSharedBrowserProvider()` in `server.ts`   | one Chromium for three browser servers; this one opens a context on it                                      |
| `telemetry.ts`                                | a browser launch and a Chromium crash are things only this process sees                                     |
| `login.ts` and a retried login in `server.ts` | the login form Fetch serves today, and a failure the next tool call retries (#40, strad#28)                 |
| `test/`                                       | both of the above, over a fake browser, with no Fetch account — `ci.yml`'s `servers (fetchpet)` leg runs it |

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

**The same shape, elsewhere.** A shared path is one instance of "two jobs agree
on a name nobody coordinates", and this box has had others:

- tadasant-internal's prod deploy still writes `/tmp/spec.json`, and is still
  exposed to any _other_ job on those runners that picks the same name.
  tadasant/strad#115.
- The docker daemon is shared the same way, and any job that builds an image and
  runs it can claim a fixed `<something>:ci` tag. The name and host-port
  collisions that follow are loud; the TAG one is not, because a concurrent job
  rebuilding the tag between a build and its `docker run` moves the assertion
  onto an image the run never built, and it passes. Closed in all three of
  strad's own workflows — `ci.yml` (tadasant/strad#117), `bundle-google-ci.yml`
  (tadasant/strad#119) and `release-onepassword-image.yml`'s verification build
  (tadasant/strad#126) — by suffixing the tag with the run id and the run
  attempt, labelling everything `strad-ci`, and sweeping what a killed runner
  leaked. Three `*.isolation.test.ts` files read the workflows as
  text and fail the PR that puts a fixed name back.

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

## 50. Three slugs ship disabled, because an unseeded `${REF}` fails the render

**What.** `telegram-ro`, `telegram-rw` and `pulse-subregistry` are in
`infra/strad.staging.yaml` with `enabled: false`. The mount is in the bundle image
and the process registers it either way — the BUNDLE's own `/healthz` lists it,
degraded — but no strad slug routes to it until a human flips them.

**Why.** `render-spec` resolves every `${NAME}` from GCP Secret Manager and fails
the whole deploy on one it cannot find. That is the right behaviour (a
half-authenticated gateway is worse than a refused deploy), and it means a server
whose credentials do not exist yet cannot ship enabled. `enabled: false` is
skipped at render, so the four unseeded refs cost nothing.

It is also all-or-nothing, which is what makes the rule worth writing down: the
render is ONE spec, so a single unseeded name stops the deploy for every other
slug in the file. `pulse-subregistry` landed enabled ahead of its credential on
2026-08-14 and reddened `main` until it was gated.

**The edge.** A disabled server is invisible where anyone would look: the
GATEWAY's `/healthz` reports the slugs strad routes, and a disabled one is not
among them, nor in the console, and `?servers=telegram-ro` is a 424. Only the
bundle's internal health route — which nothing outside the app can reach — knows
the mount is there at all.

**Undo.** Per slug, seed the names it references and delete its `enabled:` line —
`TELEGRAM_API_ID`, `TELEGRAM_API_HASH` and `TELEGRAM_STRING_SESSION` for the
telegram pair, `PULSEMCP_SUBREGISTRY_API_KEY` for `pulse-subregistry` — and add
each seeded name to `PROVISIONED_STATICS` in `test/staging-config.test.ts`, which
fails CI when the config and the store disagree. The allow-lists are already
checked against the real image by `policy:check`, so nothing else needs proving
first.

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
- …and so did a third thing, until #57 closed it: a credential a CONCURRENT job
  had logged out of. That one also produced three identical 403s and also was not
  the registry refusing, so read #57's error strings — `oauth token: denied` and
  `anonymous token … 403` — before believing this bullet and going to check the
  package's settings.
- The wrapper declares only the ten inputs its call sites pass. A `with:` key
  it does not declare is DROPPED with a runner warning, not an error — so adding,
  say, `platforms:` or `secrets:` to a call site means declaring it on the
  wrapper first, or the build quietly runs without it. `builder:` is the one
  input it refuses to build without; see #53.

Nothing here retries the ghcr login, the tag-digest check in `release-image.yml`,
or the deploy's image pull; each is a separate 403 with a separate fix.

`ci.yml`'s `lint` job runs `actionlint` over every workflow, which PARSES this
action on a PR; `ci.yml`'s `build_image` and `bundle_image` jobs RUN it, with
`push: false`, which is a different and stronger thing (#73). A build-only run
takes exactly one attempt: there is no registry to refuse it, so a failure is the
`Dockerfile` and rebuilding it twice more would only spend a PR's wall clock.

**Undo.** Point the fourteen call sites back at `docker/build-push-action@v6` (add
`push: true`, which the wrapper supplies) and delete `.github/actions/build-push`.

## 52. Two servers on ONE bundle still cannot hold two values for one name

**⚠️ MOSTLY RESOLVED by #56** — two servers on one bundle CAN now hold two values,
provided they are two MOUNTS (different `path:`). Two slugs on the SAME path are
still one instance of one server in one container, and that half is not a
resolution problem at all — it is what "capability variant" means. The renderer
still throws for it, with a message that now offers separate paths first. The
paragraph below is the state before #56; the cost it names (a second billed
component) is no longer the only answer.

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
- A render pays for the layer in STORE ENUMERATIONS. `list()` walks every
  managed parameter in the project and filters by prefix, and `resolve()` calls
  it again — so a render costs one extra enumeration for the `/strad/{env}/mcp/`
  listing, plus one per slug that turns out to need a value (those run
  concurrently). A store with nothing seeded per-server pays only the first.
- Substitution only covers a `supplementary-image`'s `env:`. A `builtin`'s
  `options:` and a `remote-http`'s `url`/`headers` resolve IN-PROCESS at runtime,
  from the gateway namespace; their per-server path is `params: true`.

**Undo.** Drop `serverSecrets` from `renderAppSpec` and the per-server read from
`render-spec`; every `${NAME}` goes back to the one flat gateway namespace.

## 53. The buildx builder is a box-wide name, and nothing in a workflow says so

**✅ RESOLVED** — every job creates its builder with `use: false` and every build
names it explicitly. The underlying condition — one docker daemon, one
`$HOME`, several concurrent runner processes — is unchanged.

**What.** `docker/setup-buildx-action` defaults to `use: true`, which runs
`docker buildx create --name builder-<uuid> --use`. The `--use` writes
`~/.docker/buildx/current`. `runs-on: self-hosted` means every job on the box
runs as the same user, so there is exactly ONE of that file for the whole
machine — and a `docker buildx build` with no `--builder` reads it.

The per-job builder NAME is a uuid and never collides, which is precisely what
makes this invisible: nothing in a workflow file, and nothing in `docker buildx
ls`, says two jobs are sharing anything. The shared thing is the pointer, not the
builder.

**How it failed.** On 2026-08-11, [CI run 31482543537](https://github.com/tadasant/strad/actions/runs/31482543537)
on `main` went red in `bundle_image` alone; the other thirteen jobs passed and no
assertion of ours ran. Three jobs on one box:

| Time (UTC)    | What                                                                                     |
| ------------- | ---------------------------------------------------------------------------------------- |
| `10:35:25.19` | `bundle_image` creates `builder-6813d177…` `--use`                                       |
| `10:36:11.29` | `Release image` creates `builder-7cb9f269…` `--use` — **the pointer is now its**         |
| `10:36:16.07` | `Release image` builds, on `builder-7cb9f269…`                                           |
| `10:36:23.45` | **`bundle_image` builds — no `--builder`, so also on `builder-7cb9f269…`**               |
| `10:36:43.93` | `Release image` finishes; post-cleanup begins                                            |
| `10:36:44.23` | `docker buildx rm builder-7cb9f269…`                                                     |
| `10:36:54.31` | `bundle_image` dies: `rpc error … received prior goaway … debug data: "graceful_stop"`   |
| `10:36:54.85` | `builder-7cb9f269… removed` — the `rm` took **10.6s**, draining the build it was killing |
| `10:36:55.51` | `bundle_image` removes its own builder, in **0.26s**. It had never used it.              |

The 10.6s against 0.26s is the whole proof: one buildkit was busy, and it was not
the one `bundle_image` created.

**Why nothing caught it.** The victim is whichever build is in flight when a
concurrent job's post-cleanup fires, so it lands on a random job, at a random
step, with an error naming buildkit's transport rather than anything in this
repo — the shape everyone reads as "infrastructure flake, hit re-run". The
re-run passes, because the collision needs two jobs to overlap in a ~30-second
window.

**The quieter half.** A build that lands on another job's builder and is NOT
killed simply succeeds there, against a different local image store and a
different inline cache. Nothing reports it. `--load` puts the image in the
daemon, which is shared, so even that looks right.

**The fix, both halves.** No job WRITES the pointer (`use: false`) and no build
READS it (`builder: ${{ steps.buildx.outputs.name }}` on all fourteen build
steps, plus a `builder` input on `.github/actions/build-push` that its guard step
refuses to run without). `test/workflow-buildx-builder.test.ts` parses every
workflow AND every local action, and fails the PR that drops either half, orders
a setup step after the build that reads it — which interpolates to the empty
string, the same silent fallback — or hand-rolls a build command in a `run:`
block without `--builder`. `docker build` counts: since Docker 23 it IS buildx,
and `bake` and `compose build` read the same pointer.

The guard step runs the thing it guards, rather than grepping it for `exit 1`: a
guard whose test is inverted still contains that string and still reads fine.

**The blind spot next door, and what it then cost.** `ci.yml`'s `actionlint` step
follows a `uses:` to a local action and validates its INTERFACE — not the shell
inside it, and not its prose. At the time nothing else in a PR build loaded
`build-push` either, because every step that used it ran on `main` only. So the
whole file was effectively unlinted on the PR path, and an expression written
anywhere in it as an EXAMPLE is fatal: there is no backslash escape, and the
runner template-parses the entire manifest when it LOADS it. #73 closed the
second half of that — `ci.yml` builds both of its images through the action, so
the manifest is loaded and its steps run on every pull request — and the
assertions below still stand, because a green load proves the file parses and not
that a description is free of examples.

The first version of this fix knew that about `run:` blocks and wrote the guard's
message in prose to avoid it — then put `${{ steps.<id>.outputs.name }}` in the
`builder` input's `description:`, one screen above, as documentation. A
description is prose to a human and an expression context to the parser, and the
only contexts it has there are the ones that exist before any step runs:

    ./.github/actions/build-push/action.yml (Line: 46, Col: 18):
    Unrecognized named-value: 'steps'.

That is not a step failing. The manifest fails validation, the action fails to
load, and the step calling it fails instantly — all eight release workflows on
`main`, on one commit, seconds in, before any build ran. actionlint was green on
it. `test/workflow-buildx-builder.test.ts` asserts all three spellings of the
rule: `\${{` appears in no shell step, `${{` appears in no `name:` or
`description:` of any local action manifest, and no `inputs.*.default` reaches
for `steps`, `needs` or `job`. `outputs.*.value` is excluded — that one is a
real, deferred expression context, which is why `digest` works, and a plain
`inputs.*.default` is too. It reads `action.yaml` as well as `action.yml`, at any
depth, because a manifest it does not find is a manifest it cannot fail.

**What is deliberately NOT here.** No retry around the build. A retry would have
turned this red run green, but it treats the symptom: with an explicit
`--builder` nothing on the box can reach this job's builder, so there is no
transport failure left to retry. It would also cost what #51 costs — buildkit
does not cache a failed layer, so a genuinely broken bundle `Dockerfile` would be
built three times, twelve dependency trees each.

**Undo.** Drop `use: false` and the `builder:` inputs and delete the test. Every
build then resolves the shared pointer again.

## 54. A bundle build that fails or is cancelled blocks every later deploy, not just its own

**What.** `deploy-staging.yml` resolves the bundle's `sha-<commit>` tag by
walking first-parent history and stopping at the newest commit that published
one. A commit inside `release-bundle-image.yml`'s `paths:` filter is REQUIRED to
have published, so the walk stops there whether or not an image exists — the
alternative is deploying an older bundle against this commit's config, which is
the skew the whole path exists to prevent.

The consequence is that the stop is not confined to the deploy that first hits
it. Most commits touch no baked tree, so the walk steps past them and arrives at
the same broken ancestor on every subsequent merge. One failed bundle build wedges
`main` until something publishes a bundle image again.

**How it failed.** #127 (`450ad5c`) added a `builder:` input to
`.github/actions/build-push/action.yml` and wrote `${{ steps.… }}` in its
`description:`. The runner template-parses a manifest when it LOADS it, so every
workflow calling that action died instantly — including the bundle release for
that same commit, which had edited `release-bundle-image.yml` and therefore owed
an image ([run 31499320064](https://github.com/tadasant/strad/actions/runs/31499320064),
failed in 37s). #53 has the rest of that story.

#129 (`6d2dd22`) fixed the manifest. It touches `.github/actions/`, `HACKS.md`,
`docs/` and `test/` — nothing the bundle bakes — so it published no bundle image
either. `Release image` on `main` then failed in `deploy-staging / deploy`
([run 31503763883](https://github.com/tadasant/strad/actions/runs/31503763883)),
16m51s in, at "Resolve an immutable bundle image tag": it had waited the full 900
seconds for `sha-450ad5c…`, whose build had failed fourteen minutes before the
deploy even started. Every later merge would have failed the same way.

**Two things made it cost more than it had to.**

The wait could not tell "still building" from "already dead". Both end in the
same timeout and the error said so: "is slower than that, or it failed". The run's
state was one API call away the whole time.

The remedy the error offered was wrong for this case. "Re-run it" checks out the
same commit, and that commit's tree is the bug — every re-run of that build fails
identically, forever. #130 fixed that sentence, and it is the one printed on
every path where the run's state cannot be read.

**The fix.** The resolver takes an optional `releaseRun` lookup
(`releaseRunLookup` in `src/deploy/imageTag.ts`, the job's own `GITHUB_TOKEN` and
`actions: read`) and asks it about a commit that owes an image and has none. A run
that has CONCLUDED without success ends the wait immediately and names itself;
one still queued or in flight is exactly what the wait is for. A lookup that
throws is swallowed into a note on the error the walk was going to produce
anyway — the diagnosis is not allowed to become the failure.

`ImageSource.republish` is the same advice for a run already known to be dead,
kept separate from `remedy` because the two are printed in different situations.
`remedy` still has to hedge — the image may yet arrive, so it offers the wait
first. `republish` is reached only where there is nothing to wait for, so it
drops the wait and says the one thing that works: dispatch
`release-bundle-image.yml` on `main`, which builds HEAD and publishes
`sha-<HEAD>`, ending the walk at distance 0 before it can reach the stuck commit.
That is what cleared this one, in 40 seconds.

**What is deliberately NOT here.** No fallback to an older bundle when the owed
image is missing — that is the outage in #33's clothing. No ordering change
either: making `release-image.yml` call the bundle build instead of racing it
would have surfaced #127's breakage sooner but changed nothing here, because the
deploy that failed was for a LATER commit that owes no bundle image at all. The
wedge is a property of the walk, not of the race.

**A CANCELLED build is the same wedge for a build nobody broke.** On 2026-09-04
the self-hosted runner host restarted mid-build: `a278b5ed`'s bundle build was
cancelled 100 seconds in, three unrelated jobs on two other runners died in the
same second, and the commit itself was fine. `main` was undeployable anyway —
every staging deploy hard-stopped on the missing `sha-a278b5ed…` — and nothing
alerted, because `alert-ci-failure.yml` stays quiet on `cancelled` on purpose
(`ci.yml`'s `cancel-in-progress` makes cancellation routine). A human re-ran the
build nine minutes later and that was the whole fix.

`reheal-bundle-image.yml` makes that re-run without one. It listens for `Release
bundle image` completing and re-runs it when the conclusion is `cancelled`, the
attempt is the first, and the event is `push` — never a `failure` (that is the
loop this entry's `republish` exists to break), never twice (a re-run adds an
ATTEMPT to the same run, so one heal per run), and never a `workflow_dispatch`
build, which is one a human may have stopped deliberately. It runs on
`ubuntu-latest` rather than the self-hosted runners, for the reason
`alert-ci-failure.yml` does: the runners going down is the event it heals.

`deadRun` had to meet it halfway. A deploy already inside its 900-second wait
polls every twenty seconds, so it would otherwise reach the cancellation and stop
in the minute before the re-run it is waiting for even starts — the heal cannot
win that race alone. So a cancellation the listener WILL heal is no longer a dead
run, and `healIsComing` decides that by restating the listener's three guards
rather than assuming it fires: `ReleaseRun.runAttempt` and `ReleaseRun.event` are
read from the Actions API for exactly that, and both want positive evidence, so a
field the API stops reporting reads as "no heal" the same way the listener's
`if:` would. A cancellation it declines is dead like any other verdict — waiting
on one would spend the budget on a build nothing is bringing back, which is worse
than the stop it replaced.

`ImageSource.reheal` is what keeps this off the core. The listener watches
`Release bundle image` and nothing else, so a cancelled `release-image.yml` run
is never held open and its message names no heal — it still gets the re-run
advice, which is right for any interruption.

**Still open in this shape.** A `failure` wedges `main` exactly as before. So
does a cancellation on attempt 2, and so does one of a `workflow_dispatch` build.
And when the heal does not fire at all, the deploy now spends its full budget
before saying so — the error names the interruption and says to re-run it, which
`ImageSource.republish` would not have.

**Undo.** Drop `releaseRun` from the `resolveDeployTag` call in
`scripts/resolve-image-tag.ts`; delete `releaseRunLookup`, `ReleaseRun`,
`deadRun` and `ImageSource.republish` from `src/deploy/imageTag.ts`; drop
`actions: read` from `deploy-staging.yml` and from any caller that grants it
down; drop `GITHUB_TOKEN` from the two tag steps; and delete the corresponding
tests. The walk then waits out its budget on every dead build again. Dropping
only a caller's grant is the same undo with no symptom — the lookup 403s and is
swallowed — which is what `test/staging-on-demand.test.ts` asserts over every
caller of `deploy-staging.yml` there is. Staging is on demand (#85), so today
there is no caller at all and only the workflow's own grant is load-bearing;
that test is what keeps the coupling honest when one returns. To undo the
cancellation half:
delete `.github/workflows/reheal-bundle-image.yml`, drop `healIsComing` and the
`INTERRUPTED` branch in `deadRun`, drop `ReleaseRun.runAttempt`,
`ReleaseRun.event` and `ImageSource.reheal` with it, and drop
`interruptedAdvice` from `resolveDeployTag`. A cancelled build then wedges `main` until a human
notices the deploy that failed because of it.

## 55. The slack server is a FORK, and nothing detects a re-vendor that reverts it

**What.** `servers/bundle-api/upstream/<slug>/` is vendored verbatim from
[`pulsemcp/mcp-servers`](https://github.com/pulsemcp/mcp-servers) — three of the six
servers in that tree, under the same terms as good-eggs (#10). Slack is not. It
lives in `servers/bundle-api/fork/slack/`, forked at
`b1f13fedeb9be97ac03514d637a4616f760b6dee`, and strad has edited its tool
definitions. `google-flights` (#58) and `monarch-money` (#80) are the other two
forks in that tree.

The delta is the Slack message format. Slack renders mrkdwn, mrkdwn is not
Markdown, and `~text~` is STRIKETHROUGH — so an agent that writes `~750 som` and
`~$9` in one message has written one struck-through run covering everything
between them. Upstream's three write tools describe their text as "Supports
Slack markdown formatting", which is the assumption that produces the bug, and
they never mention the tilde. The fork rewrites those descriptions and appends a
post-hoc advisory to a successful send. `fork/slack/FORK.md` carries the file-by-file
table so the next re-vendor is a merge with a list rather than a diff read cold.

The fork also ADDS four tools upstream does not have: `slack_send_dm`,
`slack_get_dm`, `slack_get_dms` and `slack_find_user`. Upstream can post to a
channel and to a thread and cannot address a person at all, and Slack's DM flow
is two calls (`conversations.open` for the `D…` channel, then the ordinary
`chat.postMessage`) — which is a dance an agent should not have to know. The
scopes those calls need are #59.

**Why.** Two other vendored trees carry the same divergence risk (#15, #19, #45),
and the rule everywhere else is that fixes go upstream and get re-vendored. This
one cannot wait on that round trip in the way those could: the failure ships
public messages to a channel of humans, with a success result attached, every
time an agent guesses. The description fix IS worth having upstream — it is not
strad-specific — and `pulsemcp/pulsemcp#5071` asks for it. Until it lands there,
the running server is the only place the fix reaches a session.

**The sharp edge.** The eight VENDORED seams in this repo (`scripts/sync-vendored.mjs`)
each have a sync script and a drift test, because the failure of a silent
divergence is a silent one. A FORK has the opposite problem and no such
guard: there is no upstream to diff against, and a re-vendor that pastes
`experimental/slack/shared/src` over `fork/slack/src` reverts the delta with
nothing to say so. What stands in for the drift test is
`servers/bundle-api/fork/slack/test/mrkdwn.test.ts`, run by `ci.yml`'s
`servers (bundle-api)` leg: it asserts that every write tool leads with the tilde rule,
that none of them still says "Supports Slack markdown formatting", that the
registered tool set is exactly the expected thirteen names, and that the bytes
handed to `chat.postMessage` are the bytes the caller passed. `test/dm.test.ts`
pins the DM tools' behaviour and asserts the read-only tier is exactly its seven
names. A revert fails those. A revert that also deletes the tests does
not — the same hole `check-tool-policy` has (#46), and the same answer: the test
file is the artifact under review.

**The advisory is after the fact, and heuristic.** It cannot prevent the bad
message, because nothing errors — the check runs on the text that was already
sent, and its value is naming the ids to repair with. Its linter is deliberately
lenient on a strikethrough's closing edge (it over-reports rather than missing
one) and deliberately silent about `_italics_`, which would fire on every
`snake_case` identifier and train a reader to skip the whole advisory. It does
not escape or rewrite the caller's text, and a test pins that: `~` has
legitimate uses, and a server that silently edits the words a caller chose fails
exactly as quietly as the bug it is preventing.

**Undo.** Copy `experimental/slack/shared/src` back over `fork/slack/src`,
`git mv servers/bundle-api/fork/slack servers/bundle-api/upstream/slack`, restore
the two `COPY` lines in EACH of `servers/bundle/Dockerfile` and
`servers/bundle-api/Dockerfile` (the manifest one and the source one), point
`loadApiTree` in
`servers/bundle/host/src/index.ts` back at `upstream/${slug}/build/index.js`, and
drop the `bundle-api` CI leg. It also means dropping the DM tools: the `slack`
slug goes back to nine tools and `slack-readonly`'s allow-list back to four, in
both `infra/strad.staging.yaml` and `strad.config.example.yaml` — plus the counts
in `servers/bundle/scripts/smoke.mjs`, `test/staging-config.test.ts` and
`.github/workflows/ci.yml`.

## 56. Per-slug box names are emitted for every server; eleven of twenty trees can read one

**What.** Every enabled `supplementary-image` server's resolved `env:` is emitted
onto its bundle TWICE: under the bare name it always had, and under
`<SLUG>__<NAME>` — the slug uppercased, `-` to `_`, joined with `__`. That is what
lets one container hold two values for one variable.

**THERE IS NO CONDITION ON THE NAMING, and there used to be.** The first version
minted the second name only where a bundle had a real disagreement, then where a
per-server namespace had been seeded. Both were correct and both were wrong to
ship: you could not look at a server and know what its variables were called,
because the answer depended on what some OTHER slug had been seeded. Tadas called
that out — "it should just be explicit in every case" — and he is right. The rule
is now flat: given a config, the whole set of names is computable per server, by
hand, with no reference to any other server and no knowledge of the store.

**NOTHING IS REMOVED.** The bare names keep their values, so every tree in the
image that reads `process.env` directly goes on reading them, and the core and
bundle images can deploy in any order. That was the reasoning against the first
design's other half — dropping a contested bare name is bundle-wide while the
disagreement is between two servers, so a third slug loses a variable it reads —
and it survives unchanged.

**WHAT REMAINS CONDITIONAL IS READING, NOT NAMING**, and it is a property of the
config you can check by eye rather than a fact about the secret store. The bundle
host serves ONE INSTANCE PER PATH, so a slug is handed its own names only if it is
the only slug on its path and that path is `/<its own slug>` (the host mounts a
discovered slug at the slug, having no config to read a path out of). Capability
variants sharing `/gmail` are one process; they are named like everything else and
they read the bare names. Two slugs on one path resolving one variable differently
is therefore still a hard error — one process cannot hold two credentials, whatever
the variables are called.

**WHAT IT COSTS A RENDERED SPEC.** One extra variable per supplementary `env:`
entry. Measured against `main`: prod's `bundle` goes 36 -> 87 variables and
staging's 34 -> 83, nothing removed, no value changed on any component, `core`
untouched; the serialized spec roughly doubles (8.0KB -> 16.8KB for prod). This is
the property the conditional was buying and it is the price of being legible. It
is safe for the reason above — nothing is removed — but it does mean each
supplementary credential appears twice in the spec, encrypted at rest by
DigitalOcean both times.

**Two categories cannot be named**, both decidable from the config alone:

- **A slug starting with a digit.** `1PASSWORD__X` is not a portable variable
  name. That server has no per-slug names, reads the bare ones exactly as it
  always did, and the render warns naming the slug.
- **A `params: true` server's variables.** They are not in `env:` — a managed
  parameter's name comes from its path in the store — so there is no declaration
  to prefix. Prod's `telegram-ro` is `params: true`, so giving it a credential of
  its own means moving it to explicit `env:` refs first.

**The edges.**

- **Only `telegram`, `remote-filesystem`, `bundle-google` (for `google-sheets`),
  `grafana`, `bill-spend`, `aws-device-farm`, `whatsapp`, `liveoak`, `airtable`,
  `flightaware` and `digitalocean` read an injected env.** The other nine trees
  are vendored upstream code reading `process.env`, often lazily at call time
  (`onepassword` builds its client per call off `OP_SERVICE_ACCOUNT_TOKEN`). A single process cannot overlay `process.env`
  per-request without a race, so each tree needs its own seam and gets it when it
  needs one. The renderer cannot tell which tree an image contains, so a slug of
  another tree given its own path renders, warns, and serves nothing;
  reachability is what reports it.
- **The host still infers which slugs to mount from variable names.** It never
  sees strad's config, so it scans `process.env` for a COMPLETE set of a tree's
  required variables under a slug prefix. That is the one inference left in the
  scheme. It is why a slug must be pathed at `/<its own slug>` to be reachable,
  and why a slug that is NOT its own mount may still be discovered and mounted at
  `/<slug>` — an inert route nothing forwards to, since the gateway routes by the
  config's `path:`. Requiring the complete set is what keeps a single unrelated
  `SOMESLUG__TELEGRAM_API_ID` from standing up a credentialed telegram instance.
- **The console's presence probe asks about bare names only**
  (`src/gateway/bundle-presence.ts`). For a slug reading its own names it reports
  the bare variable healthy and says nothing about the per-slug one.
- **Everything is decided from the SET of servers on a bundle, never during the
  walk.** Two order-dependence bugs were caught in review: a same-path pair
  declared second and third was compared only against a different-path server and
  rendered clean, and a capability-variant group threw or not depending on whether
  it was declared before or after the server that disagreed with it.
- **`remote-filesystem` ends up double-prefixed.** A second slug reads
  `REMOTE_FS_ARCHIVE__REMOTE_FILESYSTEM_TMP_PUBLIC_GCS_BUCKET`; the inner prefix
  keeps it off the bare `GCS_*` names the `gcs` server owns in the same container,
  and the env view falls back to bare names, so collapsing the two would point it
  at the wrong bucket.
- **The mangling rule is vendored across an npm boundary** (`npm run
envprefix:sync`), like `presence.ts` and `wire.ts` — one entry each in the
  `VENDORED` manifest in `scripts/sync-vendored.mjs`, all checked by
  `test/vendored.sync.test.ts`. A drift means the renderer names a variable one
  way and the host reads another: green deploy, clean boot log, every call
  failing on a variable that is right there.
- **What that check cannot see is the NAMES.** `test/env-prefix.markers.test.ts`
  is the other half: it greps the two trees for the marker variables the host
  actually discovers a second instance by. A byte-identical rule applied to a
  variable nobody spells that way any more fails exactly as quietly.
- **The slug schema got tighter to make the rule injective.** No `--`, no leading
  or trailing `-`. Without it `a--b` + `C` and `a` + `B__C` are one variable. No
  slug in staging or prod has ever used either shape.
- **The bundle host's suite covers the discovery, not the mounting.**
  `servers/bundle/host` has one (`npm test`, vitest over its TypeScript
  sources), and `extraSlugs` is in it: the complete-set rule, the default slug,
  the sort, the discovery log line, and remote-filesystem's double prefix. What
  is still uncovered is everything that needs `/app/trees` to exist —
  `buildMounts()` itself, the deferred-instance loop that refuses a discovered
  slug colliding with a mount this image already serves, and the two loaders that
  build a per-slug instance. Those are still reached only by the `bundle_image`
  job, which asserts the mount SET against a booted container and exercises no
  branch. The suite itself runs on every PR, as the `servers (bundle/host)` leg:
  a leg's `tree:` is its path, so a nested tree is spelled `bundle/host`, and
  `test/ci-server-trees.test.ts` resolves each baked path to the lockfile-owning
  trees inside it rather than comparing the `COPY` paths alone.

**Undo.** Delete the per-slug post-pass in `src/deploy/appspec.ts` (the path-group
loop and the two checks after it) and restore the unconditional throw; drop `env:`
from the two trees' `createMCPServer` options; collapse `extraSlugs`/`deferred`
back to a single `loadTelegram()` / `loadRemoteFilesystem()` call; delete
`src/secrets/env-prefix.ts`, its vendored copy and its entry in
`scripts/sync-vendored.mjs`. The slug schema
can stay tight either way.

## 57. The ghcr credential is a box-wide file, and the slowest build loses it

**✅ RESOLVED** — every job that logs in points `DOCKER_CONFIG` at
`$RUNNER_TEMP/docker` first. The underlying condition — one docker daemon, one
`$HOME`, several concurrent runner processes — is unchanged, and is the same one
behind #53.

**What.** `~/.docker/config.json` is where `docker login` puts a registry
credential. `runs-on: self-hosted` means every job runs as the same user, so
there is exactly ONE of that file for the machine. Nine jobs in this repo run
`docker/login-action` against ghcr, each writing `auths["ghcr.io"]` with its own
job's `GITHUB_TOKEN` — and each running `docker logout ghcr.io` in a post step,
because `logout: true` is that action's default.

So the last job to log in owns the credential every concurrent build pushes with,
and the first job to finish deletes it. A buildx CLI reads that file ONCE, at
startup, and a long build pushes with whatever it read there — which by then can
belong to a job that has ended, and GitHub revokes a job's `GITHUB_TOKEN` the
moment it does.

**How it failed.** On 2026-08-12, [run 31561342124](https://github.com/tadasant/strad/actions/runs/31561342124)
took `main` red on `Release bundle image`, three attempts, three 403s, on commit
`2b40c2f`. Three jobs from one push, on one box:

| Time (UTC)    | What                                                                                                                |
| ------------- | ------------------------------------------------------------------------------------------------------------------- |
| `03:50:53.46` | the bundle job logs in to ghcr with its own token                                                                   |
| `03:50:53.99` | the bundle-API job logs in — **the shared entry is now its token**                                                  |
| `03:50:59.38` | the bundle's buildx starts, loading `config.json` once: the bundle-API job's token                                  |
| `03:51:45.75` | the bundle-API job's post step: `docker logout ghcr.io`                                                             |
| `03:51:49`    | the bundle-API job ENDS, so GitHub revokes the token buildx is holding                                              |
| `03:52:18.70` | `Release image` logs in, writing its own token to the emptied file                                                  |
| `03:53:07`    | the bundle finishes and pushes, with the token it read at `03:50:59`: `failed to fetch oauth token: denied: denied` |
| `03:53:22.97` | `Release image`'s post step: `docker logout ghcr.io`                                                                |
| `03:53:24`    | retry 2's fresh buildx finds NO ghcr entry, asks for an anonymous token: `403`                                      |
| `03:54:15`    | retry 3, the same, and the job goes red                                                                             |

`Release bundle-api image` and `Release image` both pushed fine in that same push,
which is the whole tell: each was short enough to finish while its own credential
was still the one in the file. **The bug selects for the slowest build**, which is
the bundle, every time — and the two sibling successes are what make it read as
"something specific to the bundle" rather than a race.

**Why nothing caught it.** Every symptom points away from this repo. A revoked
token and an absent one produce `oauth token: denied` and `anonymous token … 403`,
which are the errors ghcr returns for a package whose visibility flipped or whose
`packages: write` was removed — so #51's own guidance ("three identical 403s mean
the registry is refusing, not flaking — check the package's settings") reads the
evidence correctly and sends you to the wrong place. Meanwhile the retry makes it
worse rather than better: each attempt re-reads a file that is emptier than the
last, so the FIRST attempt carries the most information and the one that decides
the job carries the least.

**The fix.** `.github/actions/docker-config` writes
`DOCKER_CONFIG=$RUNNER_TEMP/docker` through `$GITHUB_ENV`, and every job that logs
in calls it first. `RUNNER_TEMP` is per runner installation and emptied between
jobs — the same private-path argument `deploy-staging.yml` makes for
`$RUNNER_TEMP/spec.json` (#47, the `/tmp/spec.json` collision). One variable
moves the docker CLI, BOTH of `docker/login-action`'s steps and buildx's auth
provider together, so the post-step logout stays on and empties only this job's
own file.

**What a fresh config directory does NOT inherit, and why that is safe here.**
`~/.docker` holds more than `auths`: `cli-plugins/` (buildx IS a CLI plugin),
`contexts/` and `currentContext`, `proxies`, `credHelpers`. An isolated directory
starts empty, so a box that kept any of those in `$HOME` would lose them — and a
buildx the CLI cannot find would fail every release job on `main`, on the first
run after the merge, since nothing on the PR path executes these workflows.
Checked against the runner's own log rather than assumed
([run 31561342124](https://github.com/tadasant/strad/actions/runs/31561342124)):
`docker info` reports `Path: /usr/libexec/docker/cli-plugins/docker-buildx` — the
system plugin directory, which the CLI searches regardless of `DOCKER_CONFIG` —
and `Context: default`, so there is no context to carry either. **Re-check both if
the runner is ever rebuilt with a rootless or manually-installed docker**, where
buildx lands in `~/.docker/cli-plugins` and the daemon is selected by a context.
Seeding the directory from `$HOME` would be the fix, minus `credsStore` and
`credHelpers` — a credential helper is box-wide state and would put this race
straight back.

Three details are load-bearing, and each is a line away from being gone:

- It is written through `$GITHUB_ENV`, not a job-level `env:`, because
  `runner.temp` is NOT available in `jobs.<id>.env` — it expands to the empty
  string there, which names `/docker`, an absolute path the whole box shares.
  That is the same trap `deploy-staging.yml` documents at its `steps:`.
- It runs before `docker/setup-buildx-action`, not just before the login: buildx
  keeps its builder metadata under `$DOCKER_CONFIG/buildx`, and a builder created
  in one config directory cannot be removed by a post step reading another.
- `logout:` stays at its default. `logout: false` is the obvious other fix and is
  worse — it stops a job DELETING the shared credential while leaving it
  OVERWRITING one, and leaves a live ghcr token in a box-wide file after the job
  ends.

`test/workflow-docker-config.test.ts` fails the PR that drops the step, reorders
it, turns `logout` off, or hand-rolls a `docker login` in a `run:` block; it also
RUNS the action's shell to prove the path derives from `RUNNER_TEMP` and that an
empty `RUNNER_TEMP` refuses rather than falling back.

**What is deliberately NOT here.** A `concurrency:` group serialising the release
workflows would also end it, and would cost every push the SUM of its builds
rather than the longest — the bundle alone is twelve dependency trees. Isolation
costs a `mkdir`.

**Undo.** Delete `.github/actions/docker-config`, its nine call sites and the
test. Every job then logs in to the same file again.

## 58. The google-flights date grid costs one request per date, a premium seat has no legroom to report, and the fare brand is not the cabin

**What.** `servers/bundle-api/fork/google-flights/` is the second FORK in that
tree (#55 is the first, #80 the third), taken from the published `google-flights-mcp-server`
v0.2.6. Three defects are fixed there — cabin class and passenger counts encoded
at protobuf field numbers Google skips as unknown, the two baggage entries read
in the wrong order, and a `get_date_grid` that returned a trailing 61-day price
HISTORY instead of future departure dates. `fork/google-flights/FORK.md` carries
the evidence for each. What follows is what is left.

**The grid is N requests, and that is inherent.** Google's search response
contains no forward-looking date grid to read: the only future date anywhere in
the document is the anchor the caller asked for. So the grid is assembled by
searching each date, one request apiece, in sequence. A date costs
`max(1.5s, Google's own response time)`: the limiter's interval runs start to
start, so a slow response replaces the gap rather than being absorbed by it.
Measured at 7.2s for 5 dates — the floor dominating — which puts the 7-day
default near 10s.

Two ceilings, not one: `window_days` caps at 31, and the whole grid abandons at a
55s wall-clock budget, reporting unreached dates in `not_attempted_dates`. The
budget is the load-bearing one. The MCP SDK's default per-request timeout is 60s
(strad's gateway allows 120s, but a client on the default does not), and a client
that times out does NOT stop this loop — it would keep scraping for a caller that
has gone. A truncated grid that says it truncated is usable; a timed-out one
costs the requests and returns nothing.

So a genuinely wide date search is not something this tool can serve, and the
honest answer to "cheapest month" is several calls or none. If Google exposes a
calendar RPC, that is the better source and this becomes one request again.

**`segments[].legroom` is `null` on a lie-flat seat, and that is the payload's
answer rather than a missing index.** It was recorded here as a suspected parser
gap — premium payloads only became inspectable once the cabin field number was
fixed — and dumping one settles it. A business offer for the SAME physical flight
differs from its economy twin in five values that could name an amenity, and in
nothing else of the kind: `leg[13]` 1→5, `leg[14]` `"31 in"`→`null`, `leg[16]`
1→3, `leg[30]` `"31 inches"`→`null`, and the price. (The booking token and the
page's own opaque ids differ too.) No string matching `/\d+\s*(in|inches|cm)/`, and none saying "lie flat",
"angled" or "reclining", occurs anywhere in a premium document.

The cabin does not predict it, which is what would have made a cabin-keyed
workaround wrong rather than merely unnecessary. `leg[16]` IS the cabin (1
economy, 2 premium economy, 3 business, 4 first); the predicate is `leg[13]`, how
Google classified the SEAT. Over 372 legs from eight searches across two routes
and four cabins, a measurement is present on every one of the 51 legs at
`leg[13] <= 3` and on none of the 321 at 4 and above. Codes 1–3 are BANDS — a
code covers a range of measurements, and which range depends on the cabin — and 4
and up are seat TYPES, five of them observed (code 7 does not occur, so "4 and
above" is not a proven ceiling). Cabin sits on both sides: premium-economy legs
on LAX→JFK report `"35 inches"` and `"37 inches"`, and one AKL→JFK business
itinerary reports `"30 inches"` on its economy connection and `null` on the
premium legs either side of it, in the same offer. `leg[13]` is not translated into a label either —
the codes above 3 have no text anywhere in the payload to establish what they
name, and `"lie flat seat"` invented from an ordinal is the same failure as a
baggage count invented from an absent flag.

**`fare_brand` is the one that remains untrustworthy.** It is a tier WITHIN the
requested cabin, not a product name: a business-class result whose tier reads
`"Economy Flex"` is not an economy fare. Upstream's own comment concedes the
mapping is a best-effort read of undocumented numeric codes. Like the legroom
null, it is stated in the tool description instead of being papered over with a
plausible-looking transformation, which is the same call `parseExtensions` makes
when it reports an absent baggage entry as `null` rather than as zero.

**The sharp edge is the same one #55 has.** A fork has no upstream to diff
against, and a re-vendor that pastes the published package over `fork/google-flights/src`
reverts every fix with nothing to say so. What stands in for a drift test is
`servers/bundle-api/fork/google-flights/test/fork.test.ts`, run by `ci.yml`'s
`servers (bundle-api)` leg. It asserts the ENCODED `tfs` bytes rather than a round-trip
through this repo's own schema — a round-trip would pass on the broken numbering,
because the bug was a disagreement with a schema that lives at Google, not an
inconsistency here — and it asserts the grid's window as literal dates, because
which dates came back _was_ the bug. A revert fails those by name. A revert that
also deletes the tests does not (#46).

**Undo.** Copy the published package's `shared/` back over
`fork/google-flights/src`, `git mv servers/bundle-api/fork/google-flights
servers/bundle-api/upstream/google-flights`, restore the `COPY` lines in EACH of
`servers/bundle/Dockerfile` and `servers/bundle-api/Dockerfile`, point
`loadApiTree` in `servers/bundle/host/src/index.ts` back at
`upstream/${slug}/build/index.js`, and drop `fork/google-flights` from the
`bundle-api` workspaces, build and test scripts. Tool names and tool count are
unchanged by the fork, so no `tools:` policy moves either way.

## 59. A DM needs Slack scopes the channel tools never asked for, and one of them is not installed

**What.** The four DM tools the slack fork adds (#55) call five Slack methods the
nine channel tools never touch, and each is gated on its own OAuth scope:

| Call                               | Scope                   | Used by                                                                                                |
| ---------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------ |
| `conversations.open`               | `im:write`              | `slack_send_dm`                                                                                        |
| `conversations.list?types=im`      | `im:read`               | `slack_get_dms`, `slack_get_dm`, and `slack_send_dm`'s fallback                                        |
| `conversations.list?types=im,mpim` | `mpim:read` **as well** | `slack_get_dms` with `include_group_dms: true`                                                         |
| `users.list` / `users.info`        | `users:read`            | `slack_find_user`, resolving any recipient not named by id, and confirming the name behind one that is |
| `users.lookupByEmail`              | `users:read.email`      | naming a recipient by email address                                                                    |

`chat.postMessage` into a `D…` channel needs nothing beyond the `chat:write` the
server already had, and `conversations.history` on one needs `im:history`.

The last enumeration of the installed app's scopes — `auth.test`'s
`x-oauth-scopes` header, read against the live API on 2026-08-14 — returned
`channels:history`, `channels:read`, `groups:history`, `groups:read`,
`files:read`, `files:write`, `reactions:write`, `chat:write`, `im:history`,
`im:read` and `users:read`, and **not `im:write`, `mpim:read` or
`users:read.email`**. Every claim below about what fails is measured against that
set. Adding a scope means editing the Slack app's configuration and reinstalling
it — a human action in Slack's UI that no code in this repo can take.

**Tadas reports having added `im:write` on 2026-08-15, and that has NOT been
re-verified here.** Re-enumerating the scopes needs the bot token, which is not
reachable from an ordinary strad session: `SLACK_BOT_TOKEN` is injected into the
`slack-workspace` MCP server's process, not into the agent's environment, and no
tool that server exposes calls `conversations.open`, `users.list` or
`users.lookupByEmail`. The 1Password copy of the token declined its reveal twice,
which is the approval gate answering rather than something to work around. Treat
the scope set above as the last measured truth and re-run `auth.test` from
somewhere that holds the token before relying on `im:write`.

**What a live DM test on 2026-08-15 did and did not settle.** Two messages were
sent through the deployed server's `chat.postMessage`, addressed by USER id
rather than by channel id, and both were delivered:

| Recipient                      | Prior DM channel                                                    | Result                            |
| ------------------------------ | ------------------------------------------------------------------- | --------------------------------- |
| `U0BGU04U6F6` (a person)       | `D0BHN8SKH8Q`, created at app-install time, zero messages in it     | delivered, `ts` 1786783069.838599 |
| `U0BPJ1Z8L13` (an app account) | none — `conversations.list?types=im` did not list one on 2026-08-14 | delivered, `ts` 1786783106.193319 |

The second row is the interesting one: a message reached a recipient this bot had
never had a conversation with. **It still does not settle `im:write`,** and the
reason is worth writing down rather than rediscovering. Slack documents
`chat.postMessage` as opening the conversation itself when `channel` is a user id
("a direct message conversation will be opened if it isn't open already"), under
`chat:write` alone. So a successful send is consistent with BOTH "`im:write` was
added yesterday" and "`im:write` was never needed for this path", and nothing
available here distinguishes them. Only `auth.test` does.

That second possibility is the more useful one, because it would make this entire
entry moot: `slack_send_dm` calls `conversations.open` FIRST and only then posts,
which is what drags `im:write` in. Posting straight to the user id — and taking
the `D…` id off the response, which `chat.postMessage` returns — would need no
scope the channel tools do not already have. It is a hypothesis, not a finding,
because it cannot be told apart from the other explanation without the scope
list; issue #150 carries it. Do not refactor on it until an `auth.test` says
which world this is: if `im:write` IS installed, removing the
`conversations.open` path would trade a working call for an unverified one.

**The consequence, precisely.** `conversations.open` is what creates a DM channel
that does not exist yet. Without `im:write`, `slack_send_dm` falls back to
`conversations.list?types=im` and uses the DM channel if one is already open — so
sending to anyone the bot has ever exchanged a DM with WORKS today, and sending
to a first-time recipient fails with an error naming the scope and the other way
out (have them DM the bot once, which opens the conversation from their side).
Group-DM listing and by-email addressing fail with the scope named, on the call
rather than at boot: the tools list either way, because a tool surface that
changes shape with a credential is a worse debugging story than a call that says
what it needs.

**Why anyway.** The motivating case is Zimmer DMing Tadas when a Claude account
falls into `needs_reauth`, and that conversation has existed since 2026-05-30 —
so the capability that matters is live now rather than after a human edits an app
config. Withholding the whole surface until every scope is present would trade a
working alert for a tidier dependency.

**Undo:** add `im:write` (and `mpim:read` / `users:read.email` if group DMs or
email addressing are wanted) to the Slack app's bot token scopes, reinstall the
app to the workspace, and rotate `SLACK_BOT_TOKEN` in the parameter store. No
code changes: the fallback is a `missing_scope` retry, so it simply stops firing.

## 60. A local-tunnel that is not answering answers with a tool about itself

**What.** `kind: local-tunnel` is the one kind exempt from the rule that a server
NAMED in `?servers=` fails the whole listing when its upstream cannot be listed
(`src/gateway/mcpServer.ts`). Rather than failing, and rather than dropping out,
the slug keeps its place and serves ONE tool that is not its own:
`<slug>__troubleshoot_host` (`src/gateway/troubleshoot.ts`). Calling it re-probes
the machine and returns the `recovery:` block from the config — which machine,
which failure, what to run there. The only other record is a
`mcp.local_machine_offline` event — Info-severity, because nothing failed, and
throttled to one exported record per slug per minute.

So a listing contains a tool the upstream never offered, and a caller that lists
`anki` while the laptop is shut gets one tool where forty-one used to be. That is
a gateway inventing tool surface, which is a thing a proxy should be reluctant to
do, and it is the cost here.

**Why anyway.** MCP has no in-band way to say "this part of your selection is
unavailable right now" in a successful `tools/list`. A `_meta` field on the result
would be the place and no client reads one. The three alternatives are all worse:
a shorter list says nothing (a client concluding "Anki has no tools" is drawing a
wrong conclusion from a correct response); an error takes the healthy servers
named beside it down; and an empty list is indistinguishable from a server that
genuinely has none. A tool is the one channel every client already renders and
every agent already reads.

The invented tool is bounded in ways that matter. It is LISTED only while the host
is unavailable, takes no arguments, reaches nothing but that slug's own upstream,
and returns text strad and the operator wrote — never an upstream's prose. It is
exempt from the `tools:` policy on purpose (an `allow:` list written for the real
toolset would otherwise filter away the one tool explaining the outage), which is
safe precisely because it is not one of the upstream's capabilities.

**Two consequences of that exemption, both deliberate and both costs.** The tool
is ANSWERABLE on a local-tunnel slug at any time, not only while its host is down
— the listing decides when to offer it, the call path decides who answers it, and
tying the second to the first would need state this stateless endpoint has no way
to carry. That is also what lets somebody who has just run the commands ask again
and be told the machine is back. And because it is answered rather than forwarded,
it permanently SHADOWS an upstream tool of the same name on a local-tunnel slug:
such a tool is unreachable through strad, and the caller gets strad's answer
instead of an error. The name is specific enough that no MCP server on a laptop is
likely to have chosen it, which is the whole mitigation.

**The console reads that substitution as a signal, which extends the same bet.**
`/playground/<slug>` cannot classify by error — it runs its MCP session over an
in-memory transport, so an adapter's error arrives as an `McpError` with a message
and no class — so it infers "this host is unavailable" from the SURFACE: this
kind, exactly one tool, and the tool is `<slug>__troubleshoot_host`
(`hostUnavailable` in `src/ui/playground.ts`). A healthy local-tunnel whose
upstream happens to serve exactly one tool of that name is therefore described in
the console as unavailable, and its own tool is the one the page points at. The
mitigation is the name, again — and the blast radius is one console page's
wording, not a listing, a call, or anything `/mcp` serves.

**Two failures reach it, and a 403 is now one of them.** `LocalHostUnavailableError`
has two subclasses: offline (502/503/504, 52x, refused connections, handshake
timeouts) and refused (401/403). The refused case USED to fail the whole listing,
deliberately, on the grounds that a broken credential silently removing one server
from a fleet goes unnoticed for weeks. That reasoning was about silence, and this
removes the silence — the slug says out loud that it was refused and that a
credential rather than a laptop is the problem. Anything else a machine answers
with (a 404 on a wrong path, a 500) is still an ordinary broken upstream and still
fails a named listing: nobody at that machine can fix those.

**What it reports.** A machine that is off is `offline` on `/healthz` — its own
state word — and is left OUT of the snapshot's `degraded` list, so the one field
a caller tests says there is nothing to go and look at. That is deliberate and
was asked for: the slug is still connectable, and filing a laptop somebody shut
beside a bundle that will not start meant a fleet with one sleeping machine never
read as healthy. The per-slug state still says what is true.

The exemption is narrow. A host that REFUSES stays `unreachable` and stays
degraded — it is answering, a credential has gone stale, and it will not clear
until somebody rotates it — as do a 404 and a 500 from that machine. The staging
deploy gate is unaffected either way: it filters on `kind` and never counted a
local-tunnel.

**Undo:** delete the degraded branch in `listToolsFor`'s catch
(`src/gateway/mcpServer.ts`) so an unavailable local-tunnel host is treated like
any other unlistable named server. Several tests in `test/local-tunnel.test.ts`
then fail, which is the intended alarm.

## 61. A server's own namespace is read at runtime, so one bad parameter in it takes that slug down

**What.** Every `${NAME}` written on a server entry now resolves from
`/strad/{env}/mcp/{slug}/static/` before the shared gateway namespace, at runtime,
in strad's own process (`src/secrets/provider/index.ts`). The layer is a
`StoreSecretProvider` over that namespace, chained in front of the shared one — and
`ChainSecretProvider` deliberately does NOT fall through on a throw.

`resolve()` renders a whole namespace and fails hard on any parameter in it that
will not render (#36). So seeding a slug's namespace widens that entry's blast
radius by one namespace: a malformed parameter under `/strad/prod/mcp/anki/static/`
fails `anki`'s ref resolution outright, rather than missing and letting the gateway
namespace answer — even for a name the gateway namespace holds and that worked
before anyone seeded anything.

**Why anyway.** Falling through on a throw is the worse failure, and it is the one
`ChainSecretProvider` was written to refuse: an unreachable store would silently
demote a server to whatever the shared namespace happens to hold, which is how a
rotated credential comes back from the dead. It is also the semantics a
`params: true` server has had for the same namespace all along, resolved by the
registry's parameter cache — so both halves of `/mcp/{slug}/static/` fail the same
way, rather than one of them being quietly more forgiving.

Two things bound it. The layer is LAZY, so a slug nobody seeded and nobody asks
about never reads at all; and `StoreSecretProvider` serves a stale snapshot on a
refresh that throws, so only a FIRST read failing propagates.

The honest version of "lazy" is _seeded by nobody but CALLED_: that slug does read
its empty namespace, and a throw there fails a name the shared namespace holds.
What keeps this from being a real availability regression is that an EMPTY
namespace cannot hard-fail on a parameter — there is none to render — so it can
only fail on transport, and transport hits the shared layer in the same breath.
The cases that genuinely differ are all ones where somebody seeded something
broken under that slug.

**Two smaller costs of the same layer, recorded here rather than as entries of
their own:**

- A newly SEEDED per-server name appears within `ttlSeconds` (a day) rather
  than `negativeTtlSeconds` (an hour), unless it was seeded through the console
  or the `secrets` MCP server, or somebody presses **Re-read the store**. The layer sets `negativeTtlMs: Infinity`, because a miss on it is the
  normal case — most names live in the shared namespace — and chasing a miss
  drops the process's whole reading of the store (#69), so chasing every miss
  would cost a full re-read per gateway-resolved name per slug. Rotation of an
  existing per-server value is unaffected; the shared layer keeps its miss
  re-read.
- A fleet pays one namespace read per TTL per slug that both references a
  `${NAME}` and is actually called, on top of the one shared read. Same shape as
  the render-time cost in limitation #52, moved to the request path and cached.

**Exit.** Whatever fixes #36 fixes this: a `resolve()` that can report a per-name
failure without failing the namespace would let the layer miss cleanly on the bad
name and answer normally for the rest.

**Nothing detects it ahead of time yet.** `store:check --resolve` renders the
GATEWAY namespace only — it `list()`s `/strad/{env}/mcp/` to decide coverage and
never `resolve()`s it, and `scripts/check-store.ts` says so on the `perServer`
line ("and NOT render-checked"). So a per-server parameter that lists fine and
will not render passes every gate and fails on the request path. Extending
`--resolve` to the per-server namespaces it already enumerates is the cheap half
of the exit, and is worth doing before the deep fix.

## 62. A `paramsWritable` write is single-writer only because the render says so

**What.** `paramsWritable:` lets a supplementary server persist a credential that
rotated under it, by POSTing to core (`/_strad/params/{slug}/{VARIABLE}`), which
performs the write with the store-admin credential it already holds. The write is
a plain `store.rotate()`. There is no compare-and-set on the parameter's version,
so two processes writing the same variable are last-write-wins.

What keeps that from mattering is a check in `renderAppSpec`: a component hosting
a server with a non-empty `paramsWritable:` may not have `instance_count > 1`. The
correctness of the whole mechanism rests on that one refusal.

**Why anyway.** For the credentials this exists for, CAS would not help. X's
refresh tokens are SINGLE-USE: replica A spending the token invalidates it at X,
so replica B is already holding a dead value before any write happens. There is no
merge, and no version check recovers it — the damage is at the upstream, not in
the store. The useful thing to do with that topology is refuse it, at render, where
it costs a deploy rather than a silent outage.

**What it costs.** A server that persists a credential cannot scale horizontally.
For the current fleet that is free — every bundle runs `instance_count: 1` — but it
is a real constraint written into the config schema's blast radius, and the render
error is the only place it is enforced. A deployment that grows a genuinely
concurrent write-back need (a credential that is NOT single-use, several replicas)
has to implement the CAS first.

**Four smaller edges of the same path:**

- **The boot read makes the store authoritative at boot, which is a behaviour
  change for the names on the list.** A container that previously always started
  from its baked environment now starts from whatever the store holds for those
  names. That is the point — it is what closes the render/rotate race — but it
  means a bad value written to a `paramsWritable` name takes effect on the next
  restart with no deploy in between. The fallback only covers the store failing to
  ANSWER, not the store answering with something wrong.
- **A failed write degrades a mount that is still fully working.** The mount's
  `degraded` string on `/healthz` is a statement about the NEXT restart, not about
  this process, and it is the only shape available: the alternative is a silent
  loss that surfaces hours later as a total outage. Read a degraded x-twitter as
  "re-seed before this restarts", not as "it is down".
- **A console Reconnect does not reach a running process.** A connector's
  variable on `paramsWritable:` is rotated under `oauth/` once a consent has
  written it there. Reconnecting writes a fresh grant there, but the running process still
  holds the token it booted with, and its next rotation writes over the reconnect
  — last-write-wins, with no compare-and-set. Restart the component after a
  reconnect. The same window exists for a hand re-seed of any `paramsWritable:`
  name.
- **Twin slugs on one mount share one copy, by a config rule.** `x-twitter`
  and `x-twitter-rw` share a bundle and a path, so they are one process and one
  token provider, and the render check refuses a second replica.
  What keeps the twin from holding a SECOND copy of the token is the schema's
  one-writer-per-mount rule: a name may be on only one twin's `paramsWritable:`,
  and no twin may put it on its own `oauth:` connector. Two costs follow. The
  owner's consent carries the union of the scopes (`bookmark.write` included), so
  the read tier is bounded by its `tools:` policy alone. And disabling the owner
  strands the twin, because a disabled server's namespace is not rendered.

**Exit.** A compare-and-set `put()` — read the parameter's latest version id,
write conditional on it, re-read on conflict — plus dropping the render check, for
any credential that is not single-use at the upstream. Worth doing when a second
consumer appears; not worth doing for a token whose upstream has already made the
concurrency decision for us.

## 63. One internal token means any container can reach any writable parameter — RESOLVED, except on a strad-image bundle

**✅ RESOLVED for every `supplementary-image` component.** The exit below is
built. `STRAD_INTERNAL_TOKEN` is a ROOT that stays on core; every other
component is baked its OWN token, derived from it,

    token(component) = base64url(HMAC-SHA256(root, "strad-internal-token/v1:" + component))

under the same variable name, so nothing on the component side changed
(`src/auth/internal-token.ts`, `componentTokenEnv` in `src/deploy/appspec.ts`).
Core presents the matching token when it proxies `/mcp` and when it asks a
component's presence route (`internalHeaders(env, component)`), and every
`/_strad/` route core serves reads the caller's component OFF the credential
(`internalCaller`) and refuses a slug whose `bundle:` is another component's,
with the same 403 a name on no allowlist gets. The root is refused by every
door: no component holds it. So:

- A container on component A cannot read or rotate a `paramsWritable:` /
  `paramsRefresh:` name of a server on component B. It reaches its own
  servers' names and nothing else. (`test/param-route.test.ts`, "a caller on
  another component".)
- A component cannot ask ANOTHER component's presence route, or reach its `/mcp`
  mounts: each verifies only its own token. (`test/bundle.test.ts`.)
- `POST /_strad/store/refresh` accepts any component's own token and is not
  narrowed further: it names no slug, writes nothing, and is floored.

**How the tokens come into existence: DERIVED, not seeded.** Chosen because it
adds no secret and no human step in any environment — a component added to the
config is issued its token by the next render, and the only secret is the root
that already existed. What that costs, stated rather than hidden:

- **A leaked root is every component's token.** The root is on core only; a
  supplementary image never holds it under either provider.
- **Rotating one component rotates all of them.** Rotating the root is one
  redeploy, as it always was.
- **A strad-image bundle is NOT isolated from the root.** It is baked its own
  derived token and does not hydrate the root, but under
  `gcp-parameter-store` it holds the resolver key, which can read the gateway
  namespace, root included. That component runs strad's own code and was
  already inside core's trust boundary for that reason (it can read every
  gateway value); for it, per-component tokens narrow accidents, not
  attacks. Staging's non-core components are both `supplementary-image`s.
- **Re-keying is not atomic.** A deploy that changes the root — or the first
  deploy of per-component tokens, which changes what every component holds —
  replaces core and the components as separate containers. While an old one
  overlaps a new one, core's calls to it answer `401` and the console reports
  that it refused the token; a boot-time parameter read falls back to the
  baked value; and a `paramsWritable:` write-back fails loudly, which for a
  single-use refresh token means the rotation it carried is lost and the slug
  needs re-seeding. The window is the deploy's overlap, the same one every
  root rotation already had.

Independent random tokens per component would isolate a leaked root, at the
price of one secret per component per environment that only a human can create
in prod. Switching to that later is a renderer change: `componentTokenEnv` reads
a seeded value instead of deriving one, and `internalCaller` compares against
the same list.

The original entry, kept because it is the reasoning the design answers:

**What.** The parameter write-back routes (`/_strad/params/{slug}/{VARIABLE}`,
#62) authenticated with `STRAD_INTERNAL_TOKEN`. That was ONE token, and
`BUNDLE_BOOT_ENV_KEYS` broadcast it to every supplementary component, because it
was the same token core presented to proxy `/mcp` to each of them. Nothing bound
a caller to the slug it addressed — the reachable set was the UNION of every
enabled server's `paramsWritable:`, for any container holding the token, and the
presence route had the same shape.

**What does NOT fix it.** A component-identity header checked against
`server.bundle`. The caller would be choosing its own identity, so it narrows the
ACCIDENT (a mount asking for the wrong name) and not the ATTACK, while reading in
the code like a boundary. That is why the identity is a property of the
credential: a caller cannot present a token for a component it is not.

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

- [ ] **Slack scope `im:write`** on the workspace's Slack app, then reinstall and
      rotate `SLACK_BOT_TOKEN` → resolves the live half of hack #59. Without it
      `slack_send_dm` reaches anyone the bot has an open DM with and nobody else.
      `mpim:read` (group-DM listing) and `users:read.email` (addressing someone by
      email) are the same edit, and both are optional. **Reported done by Tadas on
      2026-08-15 and left unchecked deliberately**: the box closes on a measured
      `auth.test`, and no strad session holds the token to run one (#59). Run it
      from anywhere that does, then check this and correct #59's scope list. The
      same `auth.test` decides issue #150, which — if `im:write` turns out never
      to have been needed — deletes this item rather than checking it.
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

## 64. A google-sheets credential is a human-minted refresh token, and in testing mode it expires in 7 days

**What.** `google-sheets` is the one server in the bundle that authenticates as a
PERSON rather than as a service account: an OAuth refresh token for one Google
account, minted once by that person in a browser and seeded into the parameter
store. Nothing in strad can mint one, refresh a revoked one, or notice in advance
that one is about to stop working.

**Why it is this way.** The three accounts Tadas wants served include a consumer
`gmail.com` account, which domain-wide delegation cannot reach at all — a DWD
credential is scoped to a Workspace domain. Per-account OAuth is the only model
that covers all three, and it has the side benefit of being the narrowest
credential available: one account, not "impersonate anyone in the domain".

**The sharp edge.** While the OAuth app is in **testing** mode — which is what
whitelisting a handful of accounts as test users means — Google expires refresh
tokens after **seven days**. Every tool call then fails with `invalid_grant`, and
the only fix is a human re-running consent and re-seeding the value. The failure
is loud and self-describing (the server appends that instruction to the error),
but it is not automatic, and the seven-day clock is not visible from anywhere in
strad. Publishing the OAuth app removes the expiry; nothing else does.

**Also.** A refresh token carries the scopes it was consented for, so an `-ro`
slug seeded with a `spreadsheets.readonly` token is read-only in Google as well as
in the gateway — which is strictly better than hack #22's position. Whether that
is true depends on which token a human pasted where, and nothing verifies it.

## 65. strad-fetch's scraped-page cache is shared by every caller of the slug

**What.** `strad-fetch` stores each scraped page as an MCP resource in a
process-level cache, and the bundle host builds its factory ONCE. So the cache is
one cache for the whole container: any client entitled to the `strad-fetch` slug
can `resources/list` the URLs every other client has scraped and
`resources/read` their content, until an entry is evicted.

**Why.** It is upstream's design, and upstream's deployment made it private for
free — `@pulsemcp/pulse-fetch` runs as one stdio subprocess per client session, so
"process-level" and "session-private" were the same sentence. Behind a gateway
they are not. Keeping the cache is what makes a repeated fetch cheap, and the
alternative — a cache keyed per token — is a real piece of work for a property no
caller has asked for yet.

**Blast radius today: small, and not zero.** Both slugs that can reach it in
staging are `admin`; in prod the `zimmer` role reaches it, and every Zimmer agent
session authenticates as the same principal. So this leaks scraped pages between
one person's own agent sessions, not between tenants. What it is NOT is a
credential leak: nothing in the cache is a secret this deployment holds, only
public pages someone fetched.

**The edge.** The URLs are the more interesting half. A `resources/list` names
every page any session fetched, which is a rough transcript of what those sessions
were researching — visible to a caller who scraped nothing.

**Undo.** `ResourceStorageFactory` is a singleton over one `MemoryResourceStorage`
(`servers/strad-fetch/shared/src/storage/`). Keying instances by an identity the
gateway passes through would scope it; nothing above the factory holds a reference,
so the change is contained to that file and the host's `loadStradFetch`. Setting
`STRAD_FETCH_CACHE_MAX_ENTRIES=0`-ish is NOT the workaround it looks like — a
non-positive value is ignored, deliberately, because a store that holds nothing
would make every `saveOnly` call return a dead link.

## 66. A connector's credential reaches the container on the next deploy, and there is no Disconnect

**What.** strad's console can now run a Google OAuth consent for a server slug and
write the resulting refresh token into that slug's parameter namespace
(`docs/.../operate/connectors.md`). Two things it deliberately does not do.

**The activation boundary is a deploy.** A supplementary image's environment is
baked at render time, so a credential a human stores through the console reaches
the container when the app is next deployed — not when the page says it was
written. The console states this rather than implying success; there is no
"applying…" state and no restart button.

Live rotation is not impossible here — `paramsWritable:` (hack #62) already
carries a value from the store to a running container — but it is the wrong shape
for this one. That path exists so a process can persist a credential that rotated
UNDER it, and it is single-writer by construction. A connector rotation is
initiated by a human on a different component, and making the bundle poll for one
would be a second mechanism with a second set of failure modes for a value that
changes a handful of times a year.

**There is no Disconnect.** Removing a stored credential is a delete in the
parameters manager, and revoking the grant at Google is a step at
myaccount.google.com; strad does not call Google's revocation endpoint. A generic
Disconnect is only meaningful if it does both, and doing the second means holding
a live credential purely to destroy it. Deliberately out of scope for the first
provider.

**And a stored token is not a working one.** The console says "a credential is
stored", never "this works". Google expires a refresh token from an app in
"testing" after seven days (hack #64) and revokes on a password change; the store
cannot see either. The only honest live signal is a real call, and the console
does not make one.

## 67. A lapsed good-eggs session is detected but never repaired

**What.** `servers/good-eggs/` signs in ONCE, in `initialize()`, and holds the
Playwright context for the life of the container. Nothing re-establishes that
session.

Since FORK.md #5 and #7 the server can at least _tell_ when the session is gone:
the basket read and the favorites read both decide it from the `storeData.user`
the page carries rather than from the markup it drew, so a lapsed login produces
a loud "the contents are UNKNOWN, not empty" instead of a false empty — and, when
the page carries a payload this tree recognises, instead of a list of somebody
else's recommendations. What it cannot do is fix it. The tool stays
broken until the container restarts.

**Why not.** Re-logging in mid-call means driving the sign-in form again from
inside a tool handler, with a second call possibly in flight on the same page,
and inventing a retry policy for a credential that may genuinely have been
revoked. Detecting the lapse truthfully is what stops the _harm_; repairing it
is a larger change, and a restart clears it today.

**Adjacent, and worse.** strad#196: a boot-time login failure is LATCHED —
`createMCPServer()` sets `loginFailed` and `getReadyClient()` short-circuits on
it forever, cleared only by a `cleanup()` the collapsed bundle never calls. So
even a transient failure never retries. `fetchpet` already has the retry
good-eggs lacks.

**Undo.** Give `GoodEggsClient` a `reauthenticate()` and call it from the read
paths that currently throw on an unconfirmed session, guarded so two concurrent
tool calls cannot drive the sign-in form at once. Clear the login latch in the
same change.

## 68. The Grafana mount runs a downloaded binary, and its version is pinned in three places

**What.** `grafana` is the only upstream in the bundle image that is not
JavaScript. Grafana publishes `mcp-grafana` as a Go executable and a Docker image
and nothing else, so `servers/bundle/Dockerfile` fetches the pinned release,
checks it against a SHA-256 in the Dockerfile, and installs it on PATH;
`servers/grafana` supervises it as a stdio child and proxies to it.

Three things must move together on a version bump, and nothing checks that they
have:

- `MCP_GRAFANA_VERSION` and BOTH `MCP_GRAFANA_SHA256_*` digests in the Dockerfile
  — a version bumped without its digests fails the build, which is the good case.
- The tool count in `servers/bundle/scripts/smoke.mjs` (`grafana: 52`), if the
  release adds or removes a read tool. This one fails CI loudly, which is the
  point of asserting a count nobody can predict from the diff.
- The prose in `docs/servers/grafana.md`, which names the version and the count.

**Why.** The alternative to a pinned digest is resolving `latest` at build time,
which means a rebuild of an old commit produces a different image — the thing
pinning `op` already exists to prevent. The alternative to baking it at all is
what this replaced: a ~900-character `sh -c` in every client's MCP config that
curled the release into `$TMPDIR` on every fresh session, which put the
credential in the client rather than in the store and re-downloaded the binary
per machine.

**What is NOT a limitation here.** The digest is stronger than what it replaced,
not weaker: the bootstrap compared the tarball against a `checksums.txt` fetched
from the same server, which detects a corrupted download and nothing else. The
digest in this repo is reviewed in a diff, so a re-tagged release fails the
build.

**Undo.** If Grafana ever publishes an npm package, this becomes an ordinary
tree: delete the fetch stage, drop the `binary` seam, and import the server the
way every other mount is imported.

## 69. A namespace is not addressable, so reading one means reading the whole store

**What.** A parameter's namespace lives inside its version ENVELOPE, not on a
Parameter Manager label. So `list(namespace)` cannot ask for a namespace: it pages
every `managed-by: strad` parameter in the project, reads a version of each one to
recover its envelope, and filters afterwards. `resolve()` calls `list()`, so
resolving N namespaces cost N x P version reads for P parameters — and both factors
grow when servers are added. Six new `google-sheets-*` slugs took that past
Parameter Manager's per-project read quota: the render 429'd and a production deploy
died before `doctl` was called.

The shape is unchanged. What changed, twice, is how often it is paid.

First the two DEPLOY-TIME readers — `render-spec` and `store:check` — which are
one-shot and read-only, so they hold one reading of the store for the run
(`snapshotTtlMs` on the client) and enumerate once per process instead of once
per namespace. At the shape a render actually has — one store-wide `list()` then
fourteen namespace `resolve()`s over 56 parameters, counted against the in-memory
fake — that is 1751 requests down to 169.

Then the RUNNING GATEWAY (#239). It read six or seven namespaces — the gateway's
own, every `${NAME}`-referencing slug's, every `params: true` builtin's, the
console diagnosis's — each on its own 60-second `SnapshotCache`, and the
reachability poller kept every one of them hot. Cost was namespaces x P x 1440 a
day: ~3.2M billed reads in August, ~665k API calls a day flat around the clock
on September 1, the largest line on the account, and growing by P every time a
server was added. Secrets change a few times a month. So the gateway's store
client now holds ONE reading for `gateway.secrets.ttlSeconds` — a day by
default, which is also the maximum (#309) — and every namespace slices it: the
providers, the registry's `params:` resolution and the console's diagnosis,
which reads through the same client instance rather than one of its own. The
provider layer's own TTL is gone (`SnapshotCache` became `NamespaceView`, a
single-flight, last-known-good view with no timer), because two timers over one
value only smear the bound. Counted at production's shape
(`test/secrets.read-accounting.test.ts`): one reachability tick cost 10
enumerations and 388 billed reads before, and now costs one enumeration and 68 —
once per TTL rather than once per minute: 1,632 reads a day at an hour's TTL, 68
at the default day's, instead of 558,720 per core process.

**What that costs.** A rotation nobody announced — written straight into the
parameter store some other way, by hand with `gcloud` say — lands within a day, not a minute,
or when somebody presses the button. A write through the console, or through the parameter write-back route,
drops the reading and lands at once — which it did NOT before this change: the
console only ever dropped the diagnosis cache, so the "instant on the process
that wrote it" the docs promised was never true of the runtime provider. The
console also grew a **Re-read the store** button, the explicit signal for a
value written elsewhere — and the `secrets` MCP server its counterpart,
`refresh_gateway`, over the parameter write-back wire with a 30-second floor on
core, so an agent's rotation lands at once too and an agent in a loop cannot
recreate the bill. The floor is trailing-edge: a call it holds off is owed one
re-read when it passes, because with the TTL at a day a second write ten
seconds after the first would otherwise be a day late. A render that met a transient failure is not held (the
next reader renders again); a `400` is, until the TTL or a write. The console's
diagnosis is now as old as the reading and prints that age rather than the
pass's.

Then the CONSOLE. Its admin client held nothing, so every load of a secrets page
and every action on it enumerated the project live: at production's ~130
parameters, 261 requests per page load (two per parameter, ten at a time), 525
for a reveal, which lists and then re-renders. That is what made every console
click slow, and a few clicks inside a minute were enough to exhaust the quota:
one `.../versions` listing came back `429`, the enumeration threw, and the page
rendered "No parameters in this namespace yet". Three changes, counted in
`test/console.read-accounting.test.ts`:

- The admin client holds a reading for five minutes (`CONSOLE_SNAPSHOT_TTL_MS`
  in `src/ui/store-client.ts`). A write through it no longer drops the reading:
  it marks the one parameter it touched, and the next read re-reads that one
  and keeps the rest, so a rotate-and-re-render costs about three requests
  instead of 264. The **Re-read the store** button and `refresh_gateway` drop
  it outright (`forgetConsoleStores`).
- Every client remembers the envelopes it has read, keyed by version id and
  `createTime`. A version is immutable, so a re-enumeration still lists every
  parameter's versions (P requests, none of them billed) but GETs only the ones
  that moved.
- A parameter whose read fails is kept apart instead of failing the
  enumeration. The console shows the rest and names it; the strict `list()`,
  and so `resolve()`, still throw its error, and a reading with a gap is not
  held.

**What is still true.** A single cold read still costs 2P, and a warm one P:
a store that grew to 500 parameters would cost 500 version listings per
re-read, per process, however few namespaces it needed. A value written outside
strad shows on the console within five minutes, or at once on **Re-read the
store**.

**Why not.** The real fix is to put the namespace on a parameter LABEL so the
listing can filter server-side. That means a schema change plus a backfill of every
parameter already seeded in staging and prod, and a reader that tolerates both
shapes during the migration — a bigger change than the outage warranted, and one
that wants its own PR.

**The retry, and its ceiling.** `call()` retries a refused request — `429` or a
transient `5xx`, on an IDEMPOTENT method only — with exponential backoff and
jitter, bounded at three retries and at most 2.8s of backoff, under a 6s ceiling a
server-named `Retry-After` is measured against (`DEFAULT_RETRY_BUDGET` in
`src/http/retry.ts`, the module the store and the deploy's registry walk both
read their rules from). A write is never retried, not even on a `429`: a refusal
from a fronting proxy can post-date the write, and a retried `POST` that landed
comes back `409`, which sends `create()`'s rollback down the branch that strands
a versionless parameter. That clears a burst that overran the quota for a second
or two. It does NOT clear a quota exhausted for a whole minute: the budget
runs out and the original `429` is thrown. The bound is deliberate — the store's
other invariant is that every read SETTLES, and a budget long enough to cross a
minute boundary would put minutes of sleep on a deploy's critical path, multiplied
by every call in a store-wide read. A `Retry-After` longer than the remaining budget
gives up immediately rather than sleeping past the bound.

**Undo.** Label a parameter with its namespace at `create()`, backfill the existing
ones, and filter the listing server-side. Then an enumeration costs the namespace
rather than the project, the deploy readers can drop their reuse, and the retry
stops being load-bearing. The gateway's one-reading-per-process stays worth
having regardless: it is what makes the read rate independent of the poller.

## 70. Nothing escalates a slug that sits `unconfigured` forever

**What.** `mayBeUnseeded:` (src/deploy/unseeded.ts) lets a server deploy ahead of
its credential: the render warns instead of exiting 1, and that slug alone comes
up `unconfigured` until somebody seeds a value. Removing the deploy-time gate
removes the thing that used to guarantee somebody dealt with it — a red deploy is
hard to ignore, and a warning in a run log is not.

The state is visible in four places: `/healthz` (`servers[].state` and a top-level
`unconfigured` list), the connectors roster (chip `awaiting credential`, counted
as actionable), `/api/secrets/readiness`, and one `strad.tool_surface_unconfigured`
log line per boot and per state change. What none of them do is ESCALATE. A slug
waiting a week looks exactly like a slug waiting ten minutes, and no alert fires
either way — deliberately, because the same event at ERROR severity would page a
production channel about a credential a human already decided to defer.

**What holds it up in the meantime.** The waiver is per NAME, unanimous across the
servers referencing it, and an entry naming a `${NAME}` its server references
nowhere is a hard error in both `render-spec` and `config:check`. So the failure
mode this entry describes is a slug somebody deliberately deferred and then
forgot — not a typo, which still reds the deploy.

**Why not.** An alert wants a threshold ("unconfigured for more than N days"),
which wants a memory of when the state started, which the tool-surface monitor
does not have — it holds a current snapshot, not a history. The honest home for
this is the alerting stack reading `strad.tool_surface_unconfigured` out of the
log pipeline with a `for:` duration, which is a Grafana change and not a strad one.

**The other half, and it is a real asymmetry.** How fast a seeded value takes
effect depends on where the reference is read. A `url:`, `headers:` or builtin
`options:` ref under `gcp-parameter-store` is resolved on the request path, so the
slug activates within `negativeTtlSeconds` with no redeploy — which is the whole
point of the feature. A `supplementary-image`'s `env:`, and everything under
`provider: env`, is BAKED onto a container strad does not run: seeding the value
does nothing until the next deploy. Both are supported and the render says which
it is in the warning, but "no PR" and "no deploy" are not the same promise, and
only the first holds for every case. The baked half is also thinner in what it
reports: `unconfigured` is a state STRAD'S OWN process derives from a resolution
it performs, so a slug whose only waived name is a `supplementary-image` `env:`
variable ships without that variable and reads as whatever its own server says
about itself.

**Undo.** Add a `since` timestamp to the tool-surface monitor's per-slug state and
export it as a gauge, then alert on it. Or reinstate the hard failure by deleting
`mayBeUnseeded:` from the schema — every path that reads it falls back to today's
behaviour, which is the pre-change one.

## 71. A refreshed parameter only reaches an upstream that re-reads its environment

**What.** `paramsRefresh:` (src/config/schema.ts, src/secrets/param-route.ts) keeps
a listed parameter current in a supplementary container's `process.env` without a
redeploy. What it cannot do is make the MCP server inside that container LOOK at
the new value. That is a property of the upstream, and this image runs
thirty-one of them, most written by other people.

The split is real and it is not subtle:

- `strad-fetch` builds its scraping clients inside a factory the bundle host
  invokes PER REQUEST (`servers/strad-fetch/shared/src/server.ts` reads
  `BRIGHTDATA_API_KEY` and `FIRECRAWL_API_KEY` when it is called, and
  `statelessHandler` calls `registerHandlers` per POST). A rotated key is used by
  the next tool call. This is the case the feature was built for, and the mount
  is marked `liveEnv: true` for it.
- `telegram` snapshots `slugEnvView(process.env, slug)` at mount time and the tree
  memoises ONE MTProto session for the life of the process. `grafana` and
  `google-sheets` build a client per mount. `gmail` and `google-docs` joined them
  when they gained per-slug mounts: the injected env each reads is a snapshot taken at mount time,
  which is exactly what makes two accounts in one process independent of each
  other, and its OAuth/service-account client is cached per credential so a tool
  call does not re-authenticate to Google. `x-twitter` caches its OAuth provider
  deliberately, because the token rotates in memory and re-reading would fight it.
  For all of those the refreshed value sits in the environment, correct and unused,
  until the container restarts.

**Why not.** Making every mount re-readable means re-running its loader when a
value moves, and the loaders are the expensive part of this image: a Chromium
page, an MTProto login, a memoised session store. Rebuilding one mid-flight to
pick up a credential is a bigger blast radius than the staleness it fixes, and for
`x-twitter` it would be actively wrong — its refresh token rotates in memory and a
re-read would hand the process a value its own last refresh already spent.

**What stops it being silent**, which is the part that matters. `Mount.liveEnv` in
`servers/bundle/host/src/index.ts` records which mounts re-read per call, and
`startParamRefresh` logs one line per opted-in slug at boot: an unmarked mount gets
a WARN naming the variables and saying the value will be current in the
environment and may go unused. So pointing `paramsRefresh:` at the wrong slug is a
line in the boot log, not a rotation that quietly does nothing.

**Undo.** Per mount, and only where the upstream supports it: give the tree a way
to re-read its credential (a factory called per request, as strad-fetch has) and
set `liveEnv: true`. The general fix is a mount-level `reload()` on the `Mount`
interface that `refreshParamsOnce`'s `onChange` calls, which is a change to each
tree rather than to this seam.

---

## 72. The App Platform spec has a size nobody documents, and nothing measured it

**What.** A DigitalOcean App Platform spec is refused past some size, and
DigitalOcean publishes no figure for it. strad's renderer had no notion of the
limit at all, so the first thing that ever mentioned it was the API:

```
400 error validating app spec field "App spec": size limit exceeded
```

Every `strad-prod` deploy failed on that from 2026-08-30T16:09Z until the
config's inlined form (`src/deploy/config-inline.ts`) shrank the spec.

**The evidence, and its limits.** Two runs, same app, same day:

| Run                                    | Components | Rendered spec | Result                |
| -------------------------------------- | ---------- | ------------- | --------------------- |
| tadasant-internal 33291566037 (04:01Z) | 2          | 131,010 bytes | accepted              |
| tadasant-internal 33330369567 (19:18Z) | 3          | 141,342 bytes | `size limit exceeded` |

So the ceiling is somewhere in `(131010, 141342]`. **128 KiB is 131,072 — 62 bytes
above the accepted spec — and that is a coincidence, not a measurement.** It is
the obvious inference and it is not evidence of anything; treat it as a range
until a larger spec is observed to deploy. Related: an agent guessing rather than
checking a DigitalOcean identifier is what caused the failure immediately before
this one (`apps-s-1vcpu-512mb`, tadasant/strad#209).

**Why this was invisible.** The spec's size is not a property anything owned.
`render-spec` emitted it, `assert-spec` printed a byte count that no one had a
threshold for, and the deploy job printed another. Production spent an unknown
period on headroom nobody had measured — somewhere between 1 and 10,332 bytes,
which is all the two runs above establish — and the first symptom of crossing the
line was a total outage of the deploy path — not of one component, of everything.

**What is done about it.** Two things, neither of which is a claim to know the
limit:

- **The bytes were mostly prose.** `STRAD_CONFIG_YAML` was 66,019 of the 141,342
  — the config file inlined verbatim, comments and all, on the core component,
  and 44,209 bytes of that file were comment-only lines. `render-spec` now bakes
  the document re-emitted without them, checked lossless against the original
  before the schema sees either, and falls back to the file's own text if the
  round trip does not hold or does not shrink. Prod's spec: 141,342 → ~96,238.
- **And then the rest of it was YAML.** On 2026-10-08 the spec crossed again —
  132,740 bytes, on the deploy that added a second WhatsApp bridge — with a
  stripped `STRAD_CONFIG_YAML` of 34,018 bytes and nothing left in it to strip.
  `render-spec` now gzips the stripped document into `STRAD_CONFIG_YAML_GZ_B64`
  when that is smaller in spec bytes, and boot decodes it. The emitted value is
  decoded with boot's own function before it is used and must come back byte for
  byte; a small config gzips larger and travels plain. `STRAD_CONFIG_YAML` beside
  it carries a config that fails the schema on purpose, so an image too old to
  read the compressed form refuses to boot rather than falling through to its
  stock zero-server config file. Prod's spec: 132,740 → 106,203. The cost is that
  the config is no longer readable in the App Platform console's env view — a
  `base64 -d | gunzip` away, and the file in the repo is the readable copy.
- **`assert-spec` reports the size and where it is** — the total, plus bytes per
  component — and warns past ~80% of the largest spec known to have deployed.
- **`render-spec` refuses to emit a spec past 131,010 bytes**
  (`src/deploy/spec-size.ts`), naming the count, the ceiling, the overshoot and
  the components and variables the bytes are in. A hard gate on an inferred
  number would fail deploys that would have worked — so this one is not on an
  inferred number. It is on the largest spec `strad-prod` is OBSERVED to have
  deployed, across all 176 prod renders that logged their own size, which means
  no size known to work is refused and every size above it is one nobody has
  evidence about. `--max-spec-bytes` raises it without a PR to this repo, which
  matters because prod renders this script straight from `main`.

**What it does NOT fix.** The other 45% of the spec is `bundle`'s 93 credential
variables, roughly half of them the per-slug aliases of #56. That is real
duplication, it grows with the server count, and shrinking it means changing how
credentials reach a container — tadasant/tadasant-internal#213, which injects one
bootstrap credential instead of baking a set. This entry buys that redesign time;
it does not remove the need for it.

**Undo.** To drop only the gzip, bake `inlineConfigYaml(raw).yaml` as
`STRAD_CONFIG_YAML` in `scripts/render-spec.ts` instead of `bakeConfigEnv`'s
vars; boot still reads the plain form. To drop all of it, delete
`src/deploy/config-inline.ts` and bake `raw` again, and delete the
`specSizeReport` call at the end of `scripts/render-spec.ts`. The spec goes back
to carrying every comment in the config file, and to being refused by
DigitalOcean rather than by the renderer.

## 73. The release path executes on a pull request, but only as far as the push

**What.** `ci.yml`'s `build_image` and `bundle_image` jobs build through
`.github/actions/build-push` with `push: false`, so the action every release
workflow shares is LOADED and RUN on every pull request. It was not, and that is
what this entry is about; what a PR still cannot exercise is the second half of
the release path.

**Why.** Of the sixteen workflows in this repo, two ran on `pull_request`. All
eight release workflows and `deploy-staging.yml` did not, and `build-push` was
loaded by nothing else — so the first execution of a change to the release path
was also its first production run, and its failure mode is a red `main` plus, when
an image fails to publish, a wedged deploy for every later commit (#54).

That is not a hypothesis. #127 (`450ad5c`) wrote an expression into an input
`description:`, merged green, and took all eight release workflows down inside
twenty seconds — eight `#alerts` posts from one merge — and it took #129, #130 and
#131 to settle. #53 has that story; this entry is the gap that let it merge.

**What a PR covers.** The manifest parses and LOADS (the #53 failure, which
`actionlint` is green on). Every input a call site passes is declared, and one that
is not is a runner warning on a step that ran rather than a surprise on `main`.
The builder guard runs. `docker/setup-buildx-action` → `builder:` → buildx holds
together end to end, on the shared self-hosted daemon, twice.

**What it does NOT cover, deliberately.** Everything downstream of the push:

- the ghcr login, and `packages: write`;
- the push itself, and therefore the three-403 retry of #51;
- `release-image.yml`'s tag-digest verification, which reads the registry back;
- the `VERSION`-offset version arithmetic, which needs the `main` history;
- `deploy-staging.yml`'s tag resolution (#54) and the deploy.

All five need a registry credential, and the point of a PR-time build is that a
`pull_request` run holds none. Reaching them would mean giving a workflow that a
fork can trigger something to push WITH, which trades this gap for a worse one.
So the boundary is drawn at the credential, and it is drawn twice: no
`pull_request`-reachable workflow runs `docker/login-action` or asks for
`packages: write`, and `build-push` folds `github.event_name` into its effective
`push` itself — once, in one file, rather than as a condition ten call sites
across nine workflows could each forget. `test/workflow-pr-build-coverage.test.ts` holds all three
halves still: that an unfiltered `pull_request` workflow really does run the
action, that nothing reaches `docker/build-push-action` around it, and — by
RUNNING the mode script rather than reading it — that a pull request cannot
publish.

**The cost.** Nothing measurable: `ci.yml` already built both images, and both
already passed `push: false` to `docker/build-push-action` directly. This routes
them through the wrapper instead. `release-onepassword-image.yml`'s verification
build and `bundle-google-ci.yml`'s build went the same way, so "every image build
in this repo goes through `build-push`" holds without qualification — which is
what makes the PR-time coverage hard to remove by accident.

**Undo.** Point `ci.yml`'s two builds back at `docker/build-push-action@v6`. The
release path goes back to being unexecuted until it is merged.

## 74. strad-fetch decides a page was read by counting characters

**What.** `servers/strad-fetch/shared/src/clean/extraction.ts` decides whether a
strategy could read a page by cleaning it and comparing the result against a
floor of **8 characters**. Under the floor, the strategy is treated as unable to
read the page and the chain escalates; at or above it, the page was read.

**Why it is a hack.** "How much text came out" is a proxy for "is there anything
here a caller can act on", and it is a coarse one in both directions:

- **A shell that renders something is indistinguishable from a page.** A
  client-rendered page whose static markup carries a nav bar, a cookie banner or
  a skip link extracts to a few dozen characters of exactly that, clears the
  floor, and is served as the page's content. The defect this fixes
  (tadasant/strad#205, a craigslist search page) extracted to _zero_, which is
  the easy case. A ratio — bytes fetched against characters extracted — would
  see the harder one, but there is no measurement behind a ratio yet, and a
  wrong one escalates real pages to paid strategies.
- **A very short real page is one bad cleaner release from "unknown".** The
  floor sits below every extraction measured that carries a sentence, so it has
  headroom today. It has no test against a real corpus, only against fixtures.

**Why it is this and not something better.** The alternative is judging content
rather than counting it, and everything in reach for that is worse: a model call
(cost, and this fork removed LLM extraction for good reasons — FORK.md #4), or a
per-site rule table (the thing the learned-strategy cache already is, and it
cannot bootstrap itself). A floor near zero catches the failure that was actually
reported without claiming anything about quality.

**Two edges it leaves open.** The verdict is reached on at most the first 256KB
of a document, so a page whose entire content sits past that much head and script
is judged on a prefix that never reached it. And a `cleanScrape: false` call that
saves an unreadable page caches the raw bytes without the note saying they could
not be read, so a later cache hit on the same URL serves them plainly — one
container lifetime, since the store is in memory.

**How you would know.** A page that reports as read but whose content is a
navigation menu. `cleanScrape: false` shows what was served.

**Undo.** Delete `src/clean/extraction.ts` and the `acceptIfReadable` /
`acceptSingleIfReadable` helpers in `scraping-strategies.ts`. The chain goes back
to accepting any 200 with a body, and a client-rendered page goes back to being a
successful scrape of an empty document.

---

## 75. The App Platform plan list is a hand-copied snapshot of DigitalOcean's plan table

**What.** `APP_INSTANCE_SIZES` and `LEGACY_APP_INSTANCE_SIZES` in
`src/deploy/instance-size.ts` are a transcription of the "Current Plans" and
"Legacy Plans" tables at
<https://docs.digitalocean.com/products/app-platform/details/pricing/>, read on
2026-09-02. `check-config` and `render-spec` refuse a `bundles[].instanceSizeSlug`
that is in neither, and `assertDeployableSpec` refuses a rendered spec whose
`instance_size_slug` is — on the bytes `doctl` reads, so a spec strad's own
renderer did not write is covered too.

**Why it is a hack.** The list is authoritative somewhere else and static here.
DigitalOcean publishes it as an API — `GET /v2/apps/tiers/instance_sizes` — and
nothing reads that. So the day DigitalOcean adds a plan, a config naming it is
**refused by strad and accepted by App Platform**: the check is wrong in the
tight direction, and the operator's fix is to edit this repo rather than the
config they were editing. The error message names every accepted value, which is
what makes that diagnosable rather than mystifying.

**Why it is this and not the API.** A gate that calls a vendor API is a gate that
fails when the vendor is slow, and `check-config` is meant to run on every pull
request in a repo with no cloud credentials at all — reaching the network would
cost it exactly the property that makes it cheap to run. A build-time fetch (a
generated file, checked in, refreshed by CI) is the honest middle and is not
built.

**Why it is not in the config schema.** `parseConfig` also runs at BOOT, in every
container, and the config versions independently of the image. A schema that
refused a plan it had not heard of would make an older image reject the config a
newer one wrote — a rollback turned into a crash loop, over a field nothing at
runtime reads. Same split as `src/config/strict.ts` and `assertImmutableCoreImage`:
lenient library, strict deploy gate.

**What it is deliberately not.** `MUTABLE_TAGS` in `src/deploy/imageTag.ts` is a
denylist for the mirror-image reason: it covers tag schemes another repo owns and
may extend at will, so being wrong in the tight direction there blocks a deploy
someone else made legitimate. The plan list is DigitalOcean's own, small, public,
and changes on the order of once a year.

**How you would know.** `instanceSizeSlug "<a plan that does exist>" names no App
Platform plan`, on a slug you just read off the pricing page.

**Undo.** Delete `src/deploy/instance-size.ts` and its four call sites —
`unknownInstanceSizes` + `legacyInstanceSizes` in `scripts/check-config.ts`,
`assertKnownInstanceSizes` + `legacyInstanceSizes` in `scripts/render-spec.ts` —
plus the `isKnownInstanceSize` pass in `assertDeployableSpec`
(`src/deploy/spec-file.ts`), and their imports. Any string goes back to reaching
`instance_size_slug` verbatim, and a name DigitalOcean does not sell goes back to
failing at `doctl apps update` after the merge.

**The better fix, when it is worth building.** Generate the two arrays from
`GET /v2/apps/tiers/instance_sizes` at build time — checked in, refreshed by a
scheduled CI job — so the list stops being a snapshot without the gate ever
touching the network.

---

## 76. Superseded Secret Manager versions are pruned by one writer of three

**What.** `.github/workflows/secrets-sync.yml` destroys every superseded version
of a `strad-staging-*` secret after it adds a new one, so each of those secrets
carries exactly one live version. Secret Manager bills every version that is not
`DESTROYED` — a disabled one still counts — and every consumer reads
`versions/latest`, so a superseded version is pure cost and a stale copy of a
credential (tadasant/strad#240).

**Why it is a hack.** The sync workflow is one of three things in this repo that
add Secret Manager versions, and the only one that cleans up after itself:

- `src/secrets/parameters/gcp.ts` — `rotate()`, behind the console's rotate and
  the parameter write-back route — POSTs `:addVersion` to the `strad-secrets-*`
  project and never destroys the version it superseded.
- `servers/secrets/shared/src/write-client.ts` — the `secrets` MCP server's
  write tools — the same shape, the same project.

So a credential rotated through the console or the MCP server accumulates one
enabled version per rotation, and the old value stays readable by anything that
holds `secretAccessor` on that secret. Tracked in tadasant/strad#241.

**A precondition the first run depends on.** Destroying needs
`secretmanager.versions.destroy` on the service account behind `GCP_SA_KEY`, and
this repo does not record which role that account holds. If it is only
`secretVersionAdder` plus `secretAccessor`, the first sync after this landed adds
every new version (the values go live) and then fails red on every destroy,
leaving the superseded versions in place. Tracked in tadasant/strad#242.

**Undo.** Give both TypeScript clients the same post-add prune (list, destroy
every version other than the one just added that is not already `DESTROYED`),
teach their fakes the `:destroy` verb, and add `versions.destroy` to the custom
console role in `docs/.../operate/secrets-iam.md`. Then record `GCP_SA_KEY`'s
role next to the other principals on that page.

---

## 77. The console roster still describes a multi-store slug by its FIRST store

**✅ RESOLVED.** The roster asks which store's namespaces COVER a path instead of
reading a project off the config: `storeProjectForPath()` in
`src/ui/secret-status.ts` flattens the declared stores through
`resolveServerView` — the same both-dimensions flattening `storeForPath` applies
to the write-back route — and every parameter path `fixTargets()` prints is
named with the project that owns it. A path no store covers, and a path two
stores in different projects both claim, fall back to the deployment default
rather than stating one of two answers confidently. `storeProject()` still
answers for the DEPLOYMENT, which is what the page header and
`/api/secrets/readiness` want. A `strad-<env>-*` Secret Manager secret gets neither
answer: it is NOT a parameter path, so no namespace covers it, and the deployment
default is the parameter store's project, which is the wrong project for a name the
deploy reads out of its own `GCP_PROJECT_ID`. That route names no project at all —
#86, and not this entry.

**What.** `consoleStores:` puts N parameter stores on one `/ui/<slug>` page. The
console ROSTER did not change with it: it still renders one row per
secrets slug, and `storeProject()` in `src/ui/secret-status.ts` answers "which
GCP project holds the parameter store" with a single id. The order is: the
RESOLVER's own `STRAD_PARAMS_PROJECT_ID` if this process holds one, else the
first enabled supplementary server that declares a project at all — and within
that server `consoleEnv.SECRETS_PROJECT_ID`, then `env.SECRETS_PROJECT_ID`, then
`consoleStores[0]`. So a slug declaring `consoleStores:` is described by its
first entry only when nothing earlier in that order answered; a leftover
`SECRETS_PROJECT_ID` outvotes the list entirely. `check-config` emits a
`::warning::` when that name and the first store disagree, which makes the
mismatch visible without changing the order.

**Why it was a hack.** `storeProject()` feeds the copy-pasteable `gcloud`
commands the roster prints for a missing secret. On a multi-store slug whose
second store owns the namespace a missing name lives in, the printed command
named the wrong `--project` — it would fail, legibly, rather than write anywhere
wrong, but it was a wrong answer handed to a human who asked for a right one.

---

## 78. A multi-store `/mcp` lists `get_secret_value` on every store, and refuses per store

**What.** `mcpStores:` lets one secrets container front several GCP projects.
An MCP tool list is static per container — a client caches one listing per
session — so there is no way to offer `get_secret_value` for the staging store
and omit it for the production one. strad lists the **union**: the tool exists
when at least one store's credential can back it, and every call is then checked
against the store the requested path resolves to.

**Why it is a hack.** It changes the SHAPE of a guarantee that was previously
structural. When production had a container of its own, the guarantee was "the
tool does not exist" — no listing, no handler, nothing to get wrong. On a shared
container it is "the handler refuses, and Google refuses underneath it". The
outcome is the same and the second half is the one that was always load-bearing
(the production store is read with its own viewer credential, which holds neither
`secretmanager.versions.access` nor `parametermanager.parameterVersions.render`),
but a runtime refusal is a different kind of thing from an absent tool, and it is
worth saying so rather than letting the two be conflated.

What keeps the refusal honest is that a capability is never shared: the probe
runs once per store, memoised by project id; `storeForPath` binds a path to
exactly one store; and `check-config` refuses two stores sharing a viewer
credential (by key name AND by `${REF}`), a project id, or overlapping
namespaces — with the container checking the credential a third way, by
`client_email`, at boot. `list_managed_namespaces`
reports capabilities per store, so the union listing is not the only thing an
agent is told.

**It only applies to a container that mixes postures.** A deployment whose stores
all refuse secret reads lists no `get_secret_value` at all, exactly as before — so
this is a property of putting a permissive store and a restrictive one in one
container, which is a deliberate config decision.

**Undo.** Two directions, neither free. Take the intersection instead (the tool
exists only if every store permits it), which restores "absent" at the cost of
the staging read the write surface exists to test end to end. Or give strad a way
to express entitlement per NAMESPACE rather than per slug — `entitlements.ts`
names slugs and `toolPolicy.ts` names tool names — at which point one store per
container stops being the only way to split reach.

---

## 79. strad-fetch's URL guard is a denylist, so it refuses what is known to be private

**What.** The `native` strategy refuses to fetch anything but `http`/`https`, and
refuses three shapes of private destination
(`servers/strad-fetch/shared/src/scraping-client/url-guard.ts`, `FORK.md` #11):
loopback, link-local, RFC1918, carrier-grade NAT, multicast and reserved
**addresses** — as literals, as the IPv6 forms that carry an IPv4 address, and as
resolved addresses, on the resolution that decides the socket; single-label and
special-use **names**, which is how strad's own private network is addressed
(`${bundle.PRIVATE_URL}` is `http://bundle-name:8080`, `src/deploy/appspec.ts`);
and any **connection** whose host fails either check, which is what covers
redirect hops and IP literals.

**Why it is a hack.** It is a denylist: it refuses what is known to be private
rather than permitting what is known to be public. So a private service behind an
ordinary dotted name that resolves outside every listed range is still reachable,
and every new form of private addressing is a rule somebody has to remember to
add. An allowlist — a set of destinations the tool may reach — is the shape that
fails closed, and it is not a shape a general-purpose web fetcher can have.

**What is still unmeasured, and why it no longer decides anything.** What
`169.254.169.254` and the private component network actually ANSWER from inside
an App Platform container was never established — answering it means probing a
live deployment, which is a decision about production rather than about a PR.
The guard was built so that it does not need to know: the metadata address is
refused by range and the component network by name, both without a connection
being opened. The unmeasured fact would only matter if a private destination
existed that is neither.

**Three narrower edges.**

- The guard is on `native` only. The paid strategies fetch from a third party's
  network rather than from this container, so a private URL still costs a call to
  Firecrawl or BrightData before the chain gives up.
- `STRAD_FETCH_ALLOW_PRIVATE_HOSTS` exempts a **host**, not a host and port —
  the variable names hosts, and a DNS lookup has no port to match on — so
  allowlisting a development service on one port exempts every port on that host.
  It is also less operator-only than it reads: strad-fetch declares no `params:`,
  but it shares a bundle with a server that does, and a namespace on that bundle
  accepts any well-shaped variable name (`src/secrets/parameters/namespace.ts`),
  so whoever can write that namespace — the `secrets` slug, or a console user —
  can put this name on the shared bundle environment at the next deploy.
- A redirect is refused at the connector, so the error names the host that was
  refused without saying a redirect is what pointed at it.

**Undo.** Nothing here needs a change of shape. Extending the guard to the paid
strategies is a call site; `STRAD_FETCH_ALLOW_PRIVATE_HOSTS` could take
`host:port` entries the day a deployment needs one; and the parameter route
closes when a shadowing check covers a name no server declared, rather than only
a name two servers both declare (`src/deploy/appspec.ts`).

## 80. monarch-money is a FORK, and nothing detects a re-vendor that reverts it

**What.** `servers/bundle-api/upstream/<slug>/` is vendored verbatim from
[`pulsemcp/mcp-servers`](https://github.com/pulsemcp/mcp-servers) — three of the
six servers in that tree, under the same terms as good-eggs (#10). monarch-money
is not. It lives in `servers/bundle-api/fork/monarch-money/`, forked at
`monarch-money-mcp-server-shared@0.0.6`, and strad has edited its holdings path.
slack (#55) and google-flights (#58) are the other two forks in that tree.

The delta is `get_accounts(includeHoldings: true)`, which reported
`"holdings": []` for EVERY account — reproduced twice, twenty minutes apart,
across all fifty-six accounts on a workspace where fourteen of them held
forty-four positions. Two defects had to hold at once for that to be invisible.
The query asked for `account(id:) { holdings }`, a field Monarch's schema does
not have, so every request came back `400`. And the handler wrapped each one in
`.catch(() => [])`, over a `?? []` in the client, so every `400` became an empty
portfolio. Neither half raised anything anywhere.

Holdings are a portfolio-wide connection: `portfolio(input:) { aggregateHoldings
{ edges { node { holdings { … } security { … } } } } }`, grouped by security,
each node's `holdings` carrying the `account { id }` of its leg. The fork reads
that in ONE request and regroups by account, which also retires the old shape's
N+1 — one round-trip per account, fifty-six of them here.

**Why.** The rule everywhere else is that fixes go upstream and get re-vendored,
and two other vendored trees carry the same divergence risk (#15, #19, #45). This
one cannot wait on that round trip, for the reason #55 could not: the failure
does not cost a retry, it costs the decision made on top of it. An agent asked
for this workspace's asset allocation, got fifty-six empty arrays, and fell back
to bucketing from account names and transaction merchant strings — classifying
the money-market funds as equity and understating that allocation by roughly
**twenty times**. A human caught it by noticing the number looked wrong. Nothing
in the analysis could have. `tadasant/strad#183` is the report.

**Silence is the defect, so every failure is loud.** `holdings: []` has to mean
"this account holds nothing" and nothing else, because a caller cannot tell an
empty portfolio from a swallowed failure and the second one is what produces a
confident wrong answer. The per-account `.catch` is gone and the one remaining
call propagates to the handler's existing `try/catch`. Everything structural
throws rather than yielding an empty map — a missing `portfolio`,
`aggregateHoldings`, `edges`, `node` or `node.holdings`, since a successful query
cannot omit any of them — while an empty `edges` array is a genuinely empty
portfolio and stays one. A holding that cannot be attributed to an account
throws rather than being dropped. And because `aggregateHoldings` is a Relay
connection that Monarch will not let this client page — `first:` is rejected,
`totalCount` is not a field — the query selects `pageInfo { hasNextPage }` and
the client refuses a truncated page rather than reporting part of a portfolio as
all of it. It has never been true (31 nodes, `hasNextPage: false`); it is asked
because an undercount is the failure nobody can see.

The transport is fixed on the same principle. It branched on `!response.ok`
BEFORE parsing, so Monarch's `400` — which carries a well-formed GraphQL error
body — became a generic Error holding two hundred truncated characters of JSON.
It parses first now, so that response is a `MonarchGraphQLError` with its
`errors` array intact. That matters more than it sounds: Monarch's message is
the same generic `Something went wrong while processing: None on request_id:
None.` for every malformed query, so the `locations` entry is the ONLY thing
identifying the field it rejected, and the message now names it.

**The sharp edge.** A FORK has no upstream to diff against and no sync script to
notice its loss: a re-vendor that pastes `monarch-money/shared/src` over
`fork/monarch-money/src` reverts all of it with nothing to say so. What stands in
is `servers/bundle-api/fork/monarch-money/test/holdings.test.ts`, run by
`ci.yml`'s `servers (bundle-api)` leg. It asserts the QUERY TEXT — that it reads
`portfolio(input:)` and `aggregateHoldings`, carries `account { id }`, selects
`type`/`typeDisplay`/`security`, and does not select `account(id:` — because a
wrong query shape is invisible to a mocked client by construction, which is
exactly how this shipped. And it asserts that every way the fetch can fail comes
back as an error rather than as `[]`. A revert fails those. A revert that also
deletes the tests does not — the same hole `check-tool-policy` has (#46), and the
same answer: the test file is the artifact under review.

**The fixture is anonymized, and that is a real limit.**
`test/fixtures/portfolio-holdings.json` is five aggregate nodes from a real 200,
with account, holding and security ids replaced and quantities, values and cost
bases regenerated. Every shape is verbatim — which fields are present, which come
back null, the nesting — because the shape is the only thing the parser can get
wrong, and the alternative is a household's positions in a git history. What no
recorded fixture can cover is the schema MOVING again: the query text assertions
pin the shape this fork was verified against on 2026-09-05, and nothing in CI
talks to `api.monarch.com`. The next schema change presents exactly as this one
did, minus the silence.

**Undo.** Copy `monarch-money/shared/src` back over `fork/monarch-money/src`,
`git mv servers/bundle-api/fork/monarch-money
servers/bundle-api/upstream/monarch-money`, restore the `COPY` line in EACH of
`servers/bundle/Dockerfile` and `servers/bundle-api/Dockerfile`, point
`loadApiTree` in `servers/bundle/host/src/index.ts` back at
`upstream/monarch-money/build/index.js`, and move the workspace back in the
`bundle-api` workspaces and build script while dropping it from the test script.
Tool names and tool count are unchanged either way — the delta is entirely in
what `get_accounts` returns — so `check-tool-policy` and the smoke counts do not
move.

---

## 81. The env-name rule is one module, and three vendored files still hold a copy

**What.** "What is a legal environment-variable name" —
`/^[A-Za-z_][A-Za-z0-9_]*$/`, and its `${NAME}` reference form — now lives once,
in `src/config/env-name.ts`, and every module in the core tree imports it. Three
do not: `src/secrets/presence.ts`, `src/secrets/param-route.ts` and
`src/secrets/env-prefix.ts` each keep their own literal.

**Why.** Those three are vendored byte-for-byte into `servers/bundle/host/src/`
(`scripts/sync-vendored.mjs`), which is a separate npm tree with its own
lockfile. A vendored module can only import something that crosses the boundary
with it and resolves at the SAME relative path in both trees — so importing the
rule would mean either a ninth seam in the manifest, or moving the rule out of
`src/config/` to a path that happens to work from both sides. Neither is worth a
forty-character regex, and both make `schema.ts` — the most import-constrained
consumer, and the reason the module is under `src/config/` at all — import it
from further away.

**Why it is not the drift this consolidated.** The five copies the rule had
inside ONE npm tree were held together by nothing. These three are held by a
test: `test/env-name.test.ts` reads all three as text and asserts that every
mention of the character class in them is a verbatim occurrence of
`ENV_NAME_SOURCE`. That is a grep, and a grep is the right strength for "two
files still spell one thing the same way" — the same shape as
`test/env-prefix.markers.test.ts`. `test/vendored.sync.test.ts` covers the other
half, that each vendored COPY matches its source.

**Undo.** Add `src/config/env-name.ts` to the `VENDORED` manifest as a ninth
seam and let the three import it, on the day one of them needs something else
from the module too. Until then the grep is cheaper than the seam.

---

## 82. Tool descriptions are written to a client's 2048-character cut

**What.** Every tool description in `servers/remote-filesystem/` is held at or
under 2048 characters by `DESCRIPTION_BUDGET` in
`servers/remote-filesystem/shared/src/tools/shared.ts`, asserted over every tool
the server defines. `servers/bill-spend/` and `servers/aws-device-farm/` hold
the same budget, each under its own copy of the constant — `list_transactions`
reached 2148 characters in bill-spend and lost the paragraph saying its date
filters are day-granular. Four of the seven were over that line: `upload_file` at 4111
characters, `get_upload_url` at 3580, `refresh_link` at 3463 and
`set_sensitivity` at 2589. All four were rewritten to fit.

**Why.** 2048 is not an MCP limit; the protocol puts no ceiling on `description`
at all. It is what Claude Code cuts a description to, and it reports the cut in
its own connection log rather than to the server, so the tail of a long
description is text no agent on that client ever reads. Production's log for the
`remote-filesystem-tmp-public` slug named all four tools on 2026-09-02, when
`upload_file` was 2791 characters and losing 743 of them. The signed-URL handling
added since (#194, landed in #246) had taken it to 4111 by the time it was fixed,
so more than half of it was arriving nowhere.

**What it costs.** The shared link-handling block is 1067 characters and three
tools carry it verbatim, so half of each of those budgets goes before the tool
says anything about itself. The four rewritten descriptions land between 1991 and
2002 characters, which leaves 46 to 57 characters of room each. An addition to
any of them costs a removal. Five things came out for that reason, and
`docs/servers/artifact-store.md` carries all five with no budget of its own: the
example artifact response `upload_file` and `refresh_link` used to show, the
`access`-values glossary on `upload_file` (including what a `public` artifact
means), the multi-replica caveat on `get_upload_url`'s upload token, three
sentences of motivation from the link-handling block, and the long form of the
`is_sensitive` argument. Only the example response was new prose on that page;
the rest was already there. The `is_sensitive` parameter description keeps its
own copy of the argument, because a parameter description is not what this client
cuts.

**Undo.** The number belongs to a client, so it moves when the client does. If
Claude Code raises or drops the cut, change the one constant and the four
descriptions can breathe again. The structural fix is a client that fetches the
long form on demand, from an MCP resource beside the tool, and no client does
that today.

## 83. The console will not print an unexpected error's message

**What.** `describe()` and `renderUnexpected()` in `src/ui/index.ts` used to
render `err.message` into the HTML page. They now go through `errorSummary()`
(`src/util/error-text.ts`), which passes a `ParameterStoreError`'s message
through — it is a method plus a resource path, and carries no value — and reduces
everything else to its class name. `currentEnvelope()` in
`src/secrets/parameters/gcp.ts` was the one store read behind the console's
parameter actions whose `decodeEnvelope` had no `try` around it, so it now throws an
`UnreadablePayloadError` naming the resource and DROPS the parse error rather
than chaining it as a `cause`.

**Why.** `JSON.parse` embeds about ten characters of its input in the
`SyntaxError` it throws — `Unexpected token 's', ..."value":sk-live-CA"... is not
valid JSON`. A parameter payload is a credential on a non-secret parameter and
the envelope around one on a secret parameter, so on `GET /ui/:server` and the
six `POST /ui/:server/*` actions that window rendered as visible text on a page
whose entire claim is that it never prints bytes. The repo had already decided
this — `errorSummary` exists for it, and three separate comments explain it —
and had routed the console's own catch-all around the decision.

**What it costs.** Debuggability, in the one branch where nothing else was
available. An operator who hits a failure strad did not anticipate sees the class
and a sentence saying the message was withheld and why, rather than the upstream's
own words. Everything the console actually produces in the field is written
around that: a 403 names the IAM binding to add, a 409 says the parameter already
exists, a timeout says the bound is on this end so a write may still have landed,
a store the container cannot reach names the transport code, a payload that will
not decode says rotating clears it, and a malformed path still says which rule it
broke. The
class is logged under `strad.console_render_failed`, whose export carries the
event name alone.

**Undo.** There is no version of this that prints the upstream's message safely,
because the message is the leak. What would shrink the remaining cost is more
strad-authored branches in `describe()`: every failure that gets one is a failure
the fallthrough never has to answer for. `test/ui.secrets.error-text.test.ts` is
the canary — it plants a credential inside a payload that will not parse and
asserts that neither the value nor the window reaches the page or the log.

## 84. BILL's coding write can answer 200 SUCCESS and change nothing, so strad sends every body shape until one demonstrably lands

**What.** `set_transaction_coding` in `servers/bill-spend` does not send one
request. `servers/bill-spend/shared/src/wire.ts` enumerates TWO body shapes for
`PUT /v3/spend/transactions/{id}/custom-fields`, and the write walks them in
order, **re-reading the transaction and diffing it after every attempt**. Nothing
in that server treats BILL's reply as evidence: a result carries `verified: true`
only for a change that was observed on a subsequent read, and the shape that
worked comes back as `wire_variant`. When no shape reaches the requested state,
the tool fails with `persisted: false` and the whole attempt table rather than
reporting the success BILL claimed. That failure asserts "did NOT change" and
"treat this as UNCODED", which are claims about the TRANSACTION rather than
about the request, so they are checked: a transaction that moved while this
write did not — a person editing it in the BILL web app between the PUT and the
read-back — comes back `changed: true` with the before and after instead.

**Why.** The endpoint answers HTTP 200 `{"status":"SUCCESS"}` to updates it
discards. That was measured, not inferred: sending two values to a
`multiSelect: false` field against a live BILL sandbox company comes back
SUCCESS with the field EXACTLY AS IT WAS — probed across an empty field, a coded
one, two values, three, and a list containing the value already selected, every
one SUCCESS and every one dropped whole. It is the mistake an agent makes by
treating a single-select field as multi-select. The consumer is an unattended
agent editing someone's books, where believing the reply means reporting forty
transactions re-coded and changing none of them.

The ladder itself was built for a second reason that turned out to be smaller
than it looked. BILL's own
[API reference](https://developer.bill.com/reference/updatetransactioncustomfields)
says the array items are `{customFieldId, selectedValues[], note}`; its
[Transactions guide](https://developer.bill.com/docs/transaction-management)'s
worked example says `customFieldUuid`. The live endpoint settled it —
`customFieldUuid` is a hard `400 customFieldId: must not be null`, so the guide's
example is simply wrong and that rung is gone. A community field note claiming
the `tty_…` / `tvl_…` uuid forms are accepted and dropped is also FALSE: both
identifier forms persist, in both slots, mixed freely. What remains of the ladder
is not about BILL's documentation at all — it is about which identifier forms a
caller happens to hold, since a field read out of a `list_transactions` result
carries no base64 `id` to send.

**What it costs.** Calls, against a budget of 60 per token per minute. A verified
write is four to five requests — the lock check, the before-state, the field's
value catalog (cached five minutes), the PUT, the read-back — so roughly a dozen
transactions a minute. The ladder itself is paid for once: the winning shape is
memoised for the life of the process, and a memoised shape that stops working
loses one attempt and hands back to the ladder. It also costs a claim this repo
cannot make anywhere else — that the number of round trips per write is
irreducible. It is not; it is what verification costs when the API will lie.

**Undo.** The rung that never wins has already been deleted; what is left is two
shapes that both persist and that need different identifier forms, so there is
nothing further to trim until a caller can be guaranteed to hold the base64 `id`.
The read-back is NOT part of the undo, and the live company is why: a
single-select field handed two values is answered SUCCESS and left untouched, so
the diff is the only thing that separates "coded" from "reported as coded". The
diff is also against the state read BEFORE the PUT, not against the requested
state — a request for the state a field is already in satisfies "matches what was
asked for" vacuously, and reporting that as a change is the same lie one size
down.
`servers/bill-spend/shared/test/write-verification.test.ts` is the canary — its
fake answers SUCCESS to every shape and applies only the one it was told to
honour, so a server that started trusting the reply goes red there.

---

## 85. Staging is archived rather than deleted, because an App Platform app cannot be recreated onto its own custom domain

**What.** `strad-staging` is on demand. `teardown-staging.yml` puts it to sleep
nightly by setting `maintenance.archive: true` on the live spec, which stops
App Platform billing for all three components; `deploy-staging.yml` brings it
back, and needs no change to do so. What the workflow does NOT do is
`doctl apps delete`, which is the obvious implementation and the one the
originating issue proposed.

**Why.** The app serves `staging.strad.tadasant.com` on a certificate App
Platform issues and renews for that app, reached by a Cloudflare CNAME naming
that app's own starter hostname. Deleting the app costs both ends of that:

- DigitalOcean's [own
  instruction](https://docs.digitalocean.com/products/app-platform/how-to/manage-domains/#remove-a-custom-domain)
  is to remove a custom domain BEFORE deleting the app, because a domain left
  attached "may continue pointing to the deleted app for up to 24 hours, making
  the domain unavailable for use with a new app until DNS updates". A nightly
  delete and a next-morning create land inside that window every time.
- The starter hostname is assigned per app after its first successful
  deployment. `staging.strad.tadasant.com` CNAMEs
  `strad-staging-wy9v5.ondigitalocean.app`; a recreated app answers on some other
  five characters, and that record lives in Cloudflare, where nothing in this
  repo holds a credential. The "up" direction would stop being free and start
  being a human editing DNS.

Cert issuance is the third cost and the smallest: prod's certificate carries
`notBefore` 77 minutes after that app was created, so a recreation would also
serve nothing on the custom domain for about an hour after the DNS was fixed.

**What it costs.** An archived app is not a deleted one, so the assumption that
`doctl apps list` shows only live apps is now wrong for `strad-staging`.
Anything that reads liveness from the app's existence — a monitor, a future
script — sees an app that is present and serving App Platform's offline page.
`teardown-staging.yml`'s read-back reports the archive state for exactly that
reason. Archiving also does not stop billing for databases or dedicated egress
IPs; `strad-staging` has neither, and a spec that grows one silently keeps
billing through the night.

**Undo.** Delete the `schedule:` block from `teardown-staging.yml` and staging
stays up at roughly $49/month; the `workflow_dispatch` half is worth keeping
either way. There is no per-run way to hold staging past 07:00 UTC for a long
investigation — re-dispatch `deploy-staging.yml`, or edit the cron. What is NOT
undoable is the archive-instead-of-delete decision: the delete route becomes
viable only if the custom domain stops being App Platform's to issue — a
Cloudflare-terminated proxy, say, which `docs/operate/dns` explains this
deployment deliberately does not use for the gateway. Hack #18 is the same
full-replace rule pointed the other way, and it is what makes the restore free: a
spec with no `maintenance` block clears `archive`, so the renderer needed no
change.

---

## 86. The console's `gcloud secrets` recipe names the PARAMETER STORE's project

**✅ RESOLVED.** It names no project. Both Secret Manager routes — the baked
`strad-<env>-*` one and the `consoleEnv:`-only one, which is Secret-Manager-only
by construction — set `FixTarget.project` to null and print
`--project "$DEPLOY_SECRETS_PROJECT"`, over a comment saying what to set it to:
the project the deploy reads `strad-<env>-*` out of, its own `GCP_PROJECT_ID`,
NOT this deployment's parameter store. The variable rather than dropping the flag
is the whole safety property — a variable nobody filled in is not a project id,
unset or pasted whole with its `…` placeholder, and `gcloud` refuses either, so a
blind paste writes nothing, whereas a dropped
flag would fall through to whatever `gcloud config` has set, which for an
operator who has been working in the parameter store is the very project this
exists to stop writing to, and it would succeed. A command a human has to
complete beats one that is confidently wrong; the recipe already asks for
`$VALUE`, and now asks for one more. The declared-project alternative was
weighed and refused: a `deploySecretsProject:` in the config is a second copy of
a fact that lives in the deploy environment, and a copy that drifts fails exactly
the way this entry describes — silently. `storeProject()` is untouched and still
answers for the parameter store, which is what it is named for, and no store
selection or resolution path moved. Fixes tadasant/strad#315.

**What.** The roster prints a paste-ready Secret Manager recipe for a missing
`${NAME}` — `gcloud secrets create strad-<env>-<NAME> --project <P> …` — and `<P>`
is `storeProject()`, whose own doc says what it answers: _"Which GCP project
holds the parameter store."_ Its whole chain reads parameter-store facts. The
deploy workflow reads `strad-<env>-*` from `secrets.GCP_PROJECT_ID` instead, and
`infra/strad.staging.yaml` does not merely permit those to differ — it INSTRUCTS
that they differ, so that the parameter store's viewer and admin cannot reach
strad's own secrets.

**Why it was a hack.** The console reads no deploy-environment fact, so it had
nothing better to reach for and printed the one project id it holds. It was the
one route on this page that did NOT fail legibly: a paste against the wrong
`--project` SUCCEEDS, the operator believes the name is seeded, and the next
deploy fails on the same name with nothing pointing at where the value went.
The parameter-path routes beside it resolve per namespace (#77) and this one
cannot, because a Secret Manager name is not a parameter path — there is no
namespace to resolve it by.

---

## 87. BILL's transaction filters are day-granular, so strad widens every date window rather than narrowing one

**What.** `list_transactions` in `servers/bill-spend` cannot ask BILL for an
instant. `GET /v3/spend/transactions` takes one `filters` parameter whose grammar
is `{field}:{op}:{value}`, split on `:` and `,` with **no quoting and no escape**,
and on a time field the only value it accepts is a bare `yyyy-MM-dd`. So
`servers/bill-spend/shared/src/filters.ts` reduces the caller's instant to a date
floors each bound to its UTC day and moves it OUTWARD — a lower bound back one
day, an upper bound forward two. The result echoes the terms actually sent as
`filters_applied`, and the tool description tells a caller to narrow against each
row's own `occurred_time` if it needs the instant rather than the day.

The two sizes differ because flooring has ALREADY moved the bound backwards by
its own time of day: the safe direction below, the dangerous one above. A single
day above leaves `2026-09-06T23:00Z` bounded by midnight on the 7th — an hour of
margin, which any zone east of UTC eats — and an earlier revision of this shipped
exactly that, with prose claiming zone-independence it had not earned.

**Why.** Two measurements against the sandbox, both of which cost the fleet real
work. First, the four date parameters were **entirely broken** until this: an
ISO-8601 instant carries four colons, so `updatedTime:gte:2026-09-01T00:00:00Z`
came back `422 Invalid filter request format. Expect (field:operator:value).` —
which is why session #15633 had to cursor-page a whole transaction history and
filter client-side to get a four-month window, and why `updated_after`, the
documented mechanism for an incremental sweep, swept nothing.

Second, a date is resolved to the instant that day **starts** at, not the day it
covers: against a company whose transactions all occurred at `2026-09-06T06:03Z`,
`occurredTime:lte:2026-09-06` matched nothing and `occurredTime:lte:2026-09-07`
matched all of them. The naive truncation is therefore not merely imprecise, it
**drops a sweep's most recent day** — silently, which is the failure mode this
server exists to refuse.

The widening exists at all because BILL does not document which zone that
midnight is in, and measuring it would not help: a Spend & Expense company has
its own locale, so the boundary is a per-company fact this server cannot carry —
and the sandbox cannot even settle the sandbox, its transactions sharing one
timestamp three minutes from the only boundary that separates UTC from US
Mountain. The two sizes are chosen so the caller's instant is inside the window
under every offset from UTC-12 to UTC+14, so the answer stops mattering. Too wide is a row a caller can see and discard; too
narrow is a transaction nobody learns about.

**Undo.** BILL accepting a time-of-day on `occurredTime` / `updatedTime`, or
documenting the zone. The first removes the widening; the second shrinks it.
Neither is announced, so `servers/bill-spend/shared/test/filters.test.ts` checks
the bracketing property across every hour of the day and every offset from UTC-12
to UTC+14, and the tool echoes what it sent.

---

## 88. Nothing in BILL's Spend & Expense API marks a transaction reviewed, so strad ships no tool that claims to

**What.** `bill-spend-rw` re-codes a transaction and cannot tick it off. There is
no `set_transaction_review_status` tool, and the gap is stated in
`list_transactions`'s own description rather than left for a caller to discover.
The one review-related affordance that exists is a READ: `is_reviewed` filters,
so a sweep can skip what a human already reviewed in the web app.

**Why.** The API does not expose it, established by calling the sandbox rather
than by reading the docs — which is the standard this product earned in #84.
BILL's own documentation index enumerates the whole Spend & Expense transaction
family: list, get, update, the 3DS challenge, the three receipt endpoints and the
three custom-field endpoints. There is no review or approval endpoint among them,
and all eight plausible paths — `/reviews`, `/review`, `/approve`,
`/approvals` and `/status` under a transaction; `/v3/spend/reviews`,
`/v3/spend/review-policies` and `/v3/spend/transaction-reviews` — answer `404
Page Not Found`. The router discriminates: `PATCH` on a transaction answers `405` and
names the allowed methods, so a 404 there means the route is absent rather than
the verb wrong.

The one transaction mutator, `PUT /v3/spend/transactions/{id}`, documents exactly
one body field — `budgetId` — and its behaviour is #84's all over again: seven
different review-shaped bodies (`isReviewed`, `reviewed`, `reviewStatus`,
`review`, `reviews`, `reviewers` and `status: APPROVED`) each came back **HTTP
200 with a full transaction body and `updatedTime` moved**, while `reviews` and
`reviewers` stayed empty and `isReviewed:eq:true` went on matching nothing. A
tool built on that reply would report an unattended monthly sweep as forty
transactions reviewed with none of them changed, which is the worst outcome this
server has a house rule against.

BILL is also where the boundary sits: the apiToken behind this mount is unscoped
ADMIN on a company's card program, and the five-tool surface is the only thing
withholding card issuance. A sixth tool is a decision about that boundary, and a
sixth tool that does not work is that decision made for nothing.

**Undo.** BILL shipping a review endpoint on the Spend & Expense v3 API. Until
then a human ticks transactions off in the BILL web app, and the read-side
`is_reviewed` filter is what keeps a sweep from proposing the same rows twice.

---

## 89. The console link opens a parameter LIST, so `open_secrets_manager` names the parameter in prose

**What.** `open_secrets_manager` hands an agent a URL for a human to open, and
that URL addresses a STORE (`?project=`) and a namespace (`?ns=`) — never a
parameter. The parameter travels in the tool's `instructions` instead, which tell
the agent to name it in the message it sends. On a namespace with dozens of rows
the human scans rather than clicks.

**Why.** The console has no per-parameter page and its rendered rows carry no
identity to link to, so honouring a parameter in the URL means a new query key on
`/ui/:server`, a per-row anchor in `render.ts` and a selected state — a console
affordance that does not exist. The tool did splice the canonical path on as
`?param=`, which cost the same scan and additionally told the human they were
being sent to the parameter: `/ui/:server` reads `project` and `ns` and nothing
else, so the key was dropped on arrival. Between building the affordance and
retracting the claim, the issue picked the retraction (#273), and the emitted key
set is now pinned by `the tool writes no key the page it opens does not read` in
`servers/secrets/shared/test/console-link.test.ts`.

**Undo.** Build the console side: a stable per-row anchor in the secrets page
render, a `?param=` read on `/ui/:server` that selects that row, and a fallback to
the plain page when the name matches nothing — the console already falls back that
way on an unrecognised `?project=`. Then the helper writes the key again and the
test's `PAGE_READS` grows by one.

---

## 90. The good-eggs freebie tool checks two pages, so it says so rather than claiming the store

**What.** `search_for_freebie_groceries` sweeps `$0.00` tiles off the Good Eggs
homepage and `/fresh-picks` and nowhere else. Its description and every result,
errors included, name those two pages. An empty result says what this check
found, says it does NOT mean no free items are available, and points the caller
at `$0.00` items in `search_for_grocery` results. `servers/good-eggs/FORK.md` #10 has the before and after.

**Why.** Its upstream answer to an empty sweep was _"No free items or deals
currently available."_ On the 2026-08-23 shop that sentence stood while two `$0.00`
"TRY ME!" samples were live and orderable. A keyword search for something else
surfaced them (#191). The grocery agent reads a negative answer from this tool as
"no freebies this week", so the gap between what the sweep measured and what the
sentence claimed cost the user free items. The issue offered two fixes, a
catalog-wide `$0.00` sweep or a narrower promise, and the narrower promise is what
shipped.

**Undo.** Build the sweep: find whether Good Eggs' search or catalog can be asked
for `$0.00` items, traverse it, and widen the description to match what the new
traversal really covers. Until then, a caller that wants every freebie reads the
prices on its own `search_for_grocery` results too.

---

## 91. A rotated refresh token with nowhere to land dies at the next restart

**What.** A `remote-http` server with `oauthRefresh:` mints its upstream access
tokens from a refresh token `${NAME}`, and a provider that rotates refresh tokens
on use hands back a new one on every exchange and kills the one just spent. Core
writes the new one to the parameter store — the server's own namespace, or the
gateway's when that is where the name is — through the same `rotate()` the
bundle write-back route uses (`createParameterWriteBack`, `src/http/params.ts`).
Where the name resolves from the ENVIRONMENT instead — `gateway.secrets.provider:
env`, or a name that only `envFallback` supplies under the store provider — there
is nothing strad can write. The rotation is held in memory, every rotation is
refused on stderr and as `strad.param_write_failed`, and everything keeps working
until the process restarts and reads the seeded value again, which the provider
invalidated hours ago. Then every call on that slug fails with `invalid_grant`
until a human authorizes again and re-seeds.

Two narrower windows sit beside it. The write-back REVEALS the parameter before
it writes and refuses when the stored value is not one this minter's lineage
produced — a human re-seeding another account between the exchange and the write
would otherwise be overwritten by the old account's rotation, and the slug would
serve the old account again in silence. A read-then-write is not a
compare-and-set, so a re-seed landing between those two calls is still
overwritten. And a rolling deploy runs two cores for the minutes the old one
stays healthy: two minters, one refresh token. A provider that rotates on use
refuses whichever spends it second, which re-reads the store within
`ttlSeconds`; a provider that revokes the token family on reuse leaves the slug
dead until a human authorizes again. Same window `paramsWritable:` has (#62).

**Why.** The two environment paths are, by design, paths strad cannot write:
`process.env` is fixed at spawn, and the whole point of the env provider is a
deployment with no cloud credential attached. Failing the refresh instead — so a
rotation with no home is loud immediately — would turn a working slug into a
broken one on the first exchange, for a deployment where the operator may have
chosen a provider that does not rotate. The write-back also stops at a parameter
it could not check: on anything but a definite 404 for the server's own path it
does not fall through to the gateway's, because writing a layer the reader never
reaches is a token nothing spends, which is worse than a held one.

**Undo.** Run under `gcp-parameter-store` and get the refresh token into the
store — with the console's **Connect** on the slug's page, which writes it under
`/strad/{env}/mcp/{slug}/oauth/`, or seeded by hand under the server's `static/`
or the gateway's namespace. Nothing about the minter changes; the write-back
finds a parameter and lands, checking `oauth/` first. The authorization strad
runs itself, and what it cannot do, is #111.

---

## 92. `/mcp` publishes protected-resource metadata that names no authorization server

**✅ RESOLVED.** strad is now its own authorization server for `/mcp` (#94), so
the document names one — the same origin — and
`/.well-known/oauth-authorization-server` answers. The member is still absent,
and every `/oauth/*` route is still a `404`, on a deployment where
`auth.mcpOAuth` is off or unseeded; that half of the reasoning below stands
unchanged.

**What.** `/.well-known/oauth-protected-resource/mcp` — and the same document at
the bare `/.well-known/oauth-protected-resource`, which is the MCP SDK's fallback
path — serves RFC 9728 protected-resource metadata for `/mcp`, and a `401` from
`/mcp` names that URL in `resource_metadata` on its `WWW-Authenticate`. The
document carries `resource`, `resource_name`, `bearer_methods_supported:
["header"]` and `resource_documentation`, and it OMITS `authorization_servers`.
`/.well-known/oauth-authorization-server` is still a `404`.

So a compliant client can now discover strad, read what it accepts, and still not
OAuth into it. It learns that in one `200` instead of by being told out of band,
which is the whole of the change — the credential `/mcp` accepts is unchanged: a
static `strad_<env>_<pubid>_<secret>` token in `Authorization: Bearer`, and
nothing else.

**Why.** `authorization_servers` is optional in RFC 9728 §2, and strad has no
authorization server to name. Google Workspace OAuth here is the HUMAN console
door — `/console` and `/ui`, resolved in `src/ui/console-auth.ts`, which never
consults the `/mcp` token store. Naming it would be a worse answer than the `404`
this replaces: a client would run a full consent flow and be `401`ed with a valid
access token at the end of it. Choosing an authorization server for `/mcp`, and
mapping an OAuth identity onto `roles`, is a product decision nobody has made.

The metadata half does not wait on that decision, and is worth having without it:
the resource identifier, the `header`-only bearer method and the pointer at the
docs are all true today, and the `404`s they replace were indistinguishable, from
outside, from an OAuth flow that is merely misconfigured.

Core only. A bundle's `/mcp` is a private-network hop authenticated with that
component's own `STRAD_INTERNAL_TOKEN`, no MCP client discovers it, and a pointer from
there would name a path it does not serve — so it serves no well-known route and
its `401` carries the two parameters it always did.

The origin in both halves — `gateway.publicUrl`, else the request's `Host` — is
refused unless it is a bare http(s) origin (`safeOrigin` in
`src/auth/protected-resource.ts`): no path, userinfo, query or fragment, and no
character a URI cannot carry, because the origin is interpolated into a
`quoted-string` on the `401` and `z.string().url()` accepts a `"`. A refusal is
the same answer as no origin: the route is a `404`, the `401` has two parameters,
and a refused `publicUrl` is warned about at boot. No CORS headers on either half,
deliberately — strad's browser surface is same-origin — and `Cache-Control:
no-store` on the document, because on a deployment with no `publicUrl` it is
derived from the request in hand.

**Undo.** Decide on an authorization server for `/mcp`, add
`authorization_servers` to the document in `src/auth/protected-resource.ts`, and
accept its access tokens alongside static ones in `src/auth/index.ts` with a
mapping onto `roles`. tadasant/strad#53 carries the decision.

---

## 93. The `mcp.json` dialect carries one of four kinds, and refuses the rest by name

**What.** strad accepts draft
[SEP-2633](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2633)'s
`mcpServers:` map as an input dialect for its server list
(`src/config/mcp-json.ts`), desugared into `servers:` before the schema sees the
document. It covers `kind: remote-http` and nothing else. Everything the format
can say that strad cannot honour is a HARD ERROR rather than a default:
`type: "stdio"`, `type: "sse"`, the `oauth` object, `command` / `args` / `env` on
a remote entry, pipe-chained interpolation (`${env:A | value:b}`), the `input`
and `op` schemes and every other scheme, a bare `${NAME}`, and a `${...}` in
`title` or `description`, and a `value:` literal carrying `$`, `{` or `}` — the
SEP defines no escape, and a literal is spliced into a value that is scanned for
`${NAME}` later. A `mcpServers` key that is not a legal strad slug is
also a hard error, with the slug it would have been offered as a suggestion but
never applied.

And one thing that is NOT an error, which is the sharper edge: an entry with no
`strad: { entitlements: [...] }` attaches a server with `entitlements: []` —
configured, routed, and reachable by nobody. `npm run config:check` warns and
boot emits `strad.mcp_json_unentitled`, and neither fails anything.

**Why.** SEP-2633 is an OPEN DRAFT, not a merged standard. Its reference
implementation section is a `TODO`, so there is no published JSON schema to
validate against — nothing in strad names a `$schema` — and its `oauth` object is
being renegotiated upstream (SEP-2742). Binding more of it than the part that has
a direct analog would be betting the config contract on a moving target, in the
one file where a mistranslated field silently changes what a mount executes. So
the YAML interface stays authoritative, the dialect is additive, and a document
that does not write `mcpServers:` takes exactly the code path it always did.

The three kinds with no expression are not an oversight in the format: `mcp.json`
is a CLIENT config. `supplementary-image` is deployment topology consumed by
`src/deploy/appspec.ts`, `builtin` is an in-process import, and `bundles:` is the
container an image lands in — none of which a client has. The deepest mismatch is
`entitlements` / `roles`: `mcp.json` is a single-principal file, and strad's
two-way agreement (`src/gateway/entitlements.ts`) presumes the config's reader is
not its only user, which is the assumption `mcp.json` is written under. `[]` is
the only fail-closed answer available, and a fail-closed answer nothing says out
loud is indistinguishable on a gateway from a routing bug nobody has noticed —
hence the warning and the event.

`${env:NAME}` is REWRITTEN to `${NAME}` at desugar time rather than taught to the
resolver, because four things read the reference form (the renderer, the
request-time provider, the unseeded-waiver gate, the console roster) and a second
form understood by only some of them is a credential baked under a name nothing
reads. Pipe chains are the one SEP form that cannot survive that rewrite: strad
resolves a reference once, and the renderer that bakes it in CI cannot see the
fallback the request-time provider would take.

**Undo.** Widen it when the SEP does — a published JSON schema and a settled
`oauth` object are the two events that change the calculus. `type: "sse"` becomes
expressible the day strad grows an SSE adapter. `type: "stdio"`,
`supplementary-image` and `builtin` do not converge and should not be forced to:
the honest resolution there is the one the gateway/multi-principal gap suggests,
which is feedback to the SEP rather than code here.

---

## 94. strad's authorization server has no datastore, and four properties follow

**What.** `/mcp` accepts access tokens from strad's own OAuth 2.1 authorization
server (`src/auth/mcp-oauth/`, mounted by `src/http/oauth.ts`), which delegates
identity to Google. strad has no database, so every value the flow hands out is a
self-contained sealed blob rather than a row: a dynamic client registration is
the `client_id`, and the authorization code, access token and refresh token are
encrypted payloads under six HKDF-derived keys. Four consequences, none of them
hidden:

1. **An authorization code is single-use against a per-process set**, not a
   table. It holds sixty seconds of entries and is bounded by the code's TTL
   rather than by traffic. strad core runs one instance; scaled wider, a code
   replayed against a different replica inside its sixty-second window would not
   be caught by it.

2. **Refresh tokens are not rotated.** Rotation detects the replay of a stolen
   token, and detecting it needs a record of the token just spent. There is
   nowhere to keep one, so a new opaque string while the old stayed valid would
   be the appearance of rotation without the property.

3. **Revocation happens at Google, per user and per OAuth client.** A strad
   refresh token embeds the Google refresh token behind the grant, so
   `POST /oauth/revoke` calls Google, and so does nothing else: there is no
   strad-side denylist, because an in-memory one would come back to life on the
   next deploy. Google revokes the whole grant for that account and that client,
   so revoking one connector signs the account out of every strad OAuth connector
   it holds.

4. **An access token cannot be revoked before it expires.** It is verified with
   no lookup. The one-hour default lifetime is therefore also the revocation
   window, which is what the five-minute floor on
   `auth.mcpOAuth.accessTokenTtlSeconds` is for.

And a fifth thing that is absent rather than degraded: **there is no console page
listing or revoking issued grants**, because there is no list — a stateless token
leaves no record to render. What the console could honestly show is the door's
configuration and a link to Google's own access page.

Two more properties follow from open registration rather than from the missing
datastore, and they belong beside the four above because they are the same kind
of thing — stated, not worked around:

5. **strad's domain is an open redirector to anyone who can POST.** Registration
   takes no credential, and RFC 6749 §4.1.2.1 requires an authorization error to
   be delivered to the client's registered `redirect_uri`. Compose them and a
   stranger registers `redirect_uris: ["https://evil.example/x"]`, then sends
   somebody `GET /oauth/authorize?client_id=…&redirect_uri=https://evil.example/x
&response_type=bogus` — which `302`s off strad's domain with no cookie, no
   consent and no Google hop. This is inherent to every authorization server with
   open dynamic registration; the value it has is phishing (a link that begins
   with the gateway's hostname), not access, since nothing about it yields a
   token. The alternative is to render those errors as pages, which would break
   the machine-readable error the spec exists to give a legitimate client.

6. **One browser runs one authorization at a time.** The in-flight transaction is
   a single cookie at a fixed name, so a second `/oauth/authorize` started in the
   same browser overwrites the first, and the first tab comes back to "this
   sign-in has expired". Ten-minute window, one human, and the fix is to start
   that connection again.

**Why.** The alternative to the first four is a database, and adding one to strad for
this is a larger decision than this feature: the console session took the same
stateless road for the same reasons (no datastore, more than one replica
possible, a redeploy must not sign everyone out), and `STRAD_TOKENS` is the
static door's version of the same debt (#6).

The properties that actually matter are all recovered without one, and by leaning
on Google rather than by pretending:

- PKCE is mandatory and `S256`-only, which covers the replay window (1) — whoever
  intercepts a code does not hold the verifier.
- Every refresh re-verifies the identity against Google and re-runs the Workspace
  test on a **fresh** ID token, so a non-expiring refresh token (Tadas's explicit
  instruction) is bounded by a live check rather than by a claim strad sealed an
  hour ago. That is also what makes revocation (3) durable: it survives every
  restart, because the state is not strad's.

**Undo.** A `GrantStore` interface with one Postgres implementation makes 1, 2
and 4 go away together — spent codes become rows, refresh tokens rotate with the
old one marked dead, and an access-token denylist becomes possible. 3 stays
Google's shape unless strad mints its own grant identity, which it should not. 5
is a console page over that store, and is the natural second half of this work;
until there is a store there is nothing for it to read. 5 goes away only by
closing registration, which would take the acceptance test with it; 6 by keying
the transaction cookie per authorization, which is a small change nobody has
needed yet.

## 95. A Slack download link is single-use against a per-process set

**What.** `slack_download_file` returns a short-lived signed URL rather than
bytes or a path (`servers/bundle-api/fork/slack/src/download-link.ts`). The token
is an HMAC over the file id, an expiry and a random nonce, and the link is
single-use: the nonce is marked spent in a `Map` held by the mount's process.

**Why it is in memory.** There is nowhere else. A bundle component has no
database and no shared cache, and the artifact store's upload leases next door
make the same trade for the same reason. Writing one would mean giving every
supplementary container a datastore to hold a fact that is worthless fifteen
minutes later.

**What follows.**

1. **A restart forgets which nonces were spent**, so a link could be replayed
   across one — but only inside its own expiry, which is the outer bound on the
   whole mechanism anyway. A deploy is the realistic way to get there, and it
   invalidates every outstanding link by a different route: the signing key is
   derived from `STRAD_INTERNAL_TOKEN`, so rotating that token voids them all.

2. **Single-use is per replica.** `bundle-slack-zimmer` runs one instance. Scaled
   wider, a link replayed against a different replica inside its window would not
   be caught — the same shape as the authorization-code set in #94.

3. **The set is bounded at ten thousand live nonces**, oldest dropped first.
   Eviction can only ever shorten a nonce's protection to less than its own
   expiry; it cannot extend one, and the signature's `exp` is checked
   independently.

**The token is in the URL path**, so it reaches App Platform's edge access log.
That is what the fifteen-minute expiry and the single use are for. The expiry is
fixed at fifteen minutes — no deployment configures it — and the module will not
sign for longer than an hour whatever it is asked for. The FILENAME is deliberately kept
out of the URL and served in `Content-Disposition` instead, so the one part of
this that is durable in a log names nothing about the file.

**Not a hack, and worth saying:** no bytes are stored anywhere. The mount streams
from Slack on the GET, so there is no temporary file and no bucket object to
retain, expire or clean up.

---

## 96. The runtime roster can add a slug, not a credential

**What.** `gateway.configStore.enabled` lets a human add, edit, disable and
remove a `servers:` entry from the console at `/connectors`, and an agent do the
same over `/mcp` through the `connectors` builtin, with the change live on the
next request and no deploy. Two things it does not do, and the first is the one
somebody will expect.

**A second account of an existing bundled server still needs a deploy — except
on the three trees a store-served instance covers (#100).** "Add a second gmail
account and use it immediately" is the shape this feature looks like it
delivers, and for gmail it does not. A `supplementary-image` mount's credentials
reach its container as environment variables the renderer bakes into the app
spec at render time, and a process's environment is fixed at spawn — so a new
`GMAIL_PERSONAL_*` value cannot reach a running container at all. The bundle
host compounds it: it discovers the extra slugs it should mount by looking for
prefixed marker variables in its own `process.env` (`servers/bundle/host/src/mounts.ts`),
so a slug whose variables are not there is a slug that container does not serve,
whatever the roster says. `assertCreatable` refuses the fields that would lie
(`env`, `params`, `paramsWritable`, `paramsRefresh`, `consoleEnv`,
`consoleStores`, `mcpStores`) rather than accept an entry the deployment cannot
honour. What IS deliverable at runtime is a second slug onto a mount that is
ALREADY deployed and already credentialed — the `gmail-ro` / `gmail-rw` pattern,
two entries on one `path:` differing by `tools:` — and the two unhosted kinds,
`remote-http` and `local-tunnel`, which run in core's own process and are
genuinely add-and-use. The exception is a store-served instance —
`path: /_instance/{tree}/{its own slug}` for telegram, google-sheets or grafana,
with `params: true` — which bakes nothing: the host learns about it from core and
reads its own namespace, so `assertCreatable` accepts `params: true` on one and
still refuses the other six fields.

**The overlay parameter has no compare-and-swap.** Parameter Manager offers
none, so the write is a read-modify-write. The console carries the `revision` it
rendered and refuses a stale Save with a `409`, which catches the collision a
human causes — a second tab, a second console process. Two writes landing inside
one read-modify-write window still lose one, silently, and the loser is whichever
wrote first. What bounds it is that writes are rare and come from one place:
core is the only component holding the admin credential, whether the write
arrives as a console form or a tool call. `RuntimeConfig` serialises `apply` and
`poll` within a process, so the remaining window is strictly cross-process.

The MCP door inherits that window rather than widening it: `save_connector`
takes `expectedRevision` optionally, so a caller that read the roster first gets
the same refusal, and one that did not gets the same last-writer-wins.

**Neither gap means a runtime write is unbounded.** Four rules bound what one
may reach, as distinct from who may make one. A runtime-authored entry's
`${NAME}` refs resolve against that slug's own `/strad/{env}/mcp/{slug}/static/`
namespace and nothing else (`forServerIsolated`, `src/secrets/provider/index.ts`),
so a connector `url:` cannot read core's process environment and send it off-box.
A runtime write may not change `entitlements:`, `tools:` or the slug's upstream
identity — `kind:`, and a supplementary `bundle:` and `path:` — on a slug the
checked-in document declares (`assertNoAccessControlChange`,
`src/config/overlay.ts`), keyed on the document so remove-then-recreate is bound
too. A runtime write reaches no mount its AUTHOR does not already reach
(`assertWithinReach`, same file): a new supplementary slug may only land on a
`bundle:` + `path:` the writing principal reaches through a checked-in slug, and
a CREDENTIAL DESTINATION on a checked-in slug may only be moved by an author that
slug's `entitlements:` admit. There are four of those and not one — `url:`,
`oauthRefresh.tokenUrl`, and a connector's `oauth.tokenUrl` / `oauth.authorizeUrl`
— because the OAuth endpoints are POSTed the client secret and the long-lived
refresh token, which outlive the bearer they mint; a bound that watched `url:`
alone would be one field wide. And a runtime write may NAME a credential and may not CARRY one
(`assertSecretsByReference`, `src/config/secret-position.ts`): the overlay is a
non-secret parameter, so a literal saved into `headers:`, into `url:`'s userinfo
or into `oauthRefresh:`'s grant would be a credential at rest in the clear. Disabling a connector that carries one is refused too, because disable
re-upserts the entry; removing it is always allowed.
`docs/src/content/docs/operate/runtime-config.md` has all four.

**THE NAME-A-CREDENTIAL RULE HAS TWO POSITIONS IT DOES NOT COVER**, and the reason is the
same in both: a ref-only rule there would refuse the ordinary case. A **URL
query parameter** — `https://api.example.com/mcp?key=abc` — is a literal
credential and is accepted, because nothing can tell it from `?version=2`
without refusing every URL that carries a query. Userinfo is different and IS
refused: `user:pass@` is a credential by definition. And a **builtin's
`options:`** is an untyped bag whose ordinary contents are non-secret literals
(`echo`'s `greeting`), so the reachable surface there is editing the options of
a builtin the checked-in document already declares — a builtin cannot be created
at runtime. Closing either needs a typed statement of which fields carry a
credential, per kind and per builtin, which is a schema change rather than a
rule. `docs/src/content/docs/operate/runtime-config-plan.md` carries it as a
later phase.

**AND THE REACH RULE IS MEASURED IN MOUNTS, NOT IN TOOLS.** A writer that already
reaches a mount may create a second slug on it with a WIDER tool surface than the
checked-in slug it reaches that mount through — so a role the deploy gave
read-only access to a container can hand itself that container's write tools.
Closing it means a created slug may serve no more than its author already
reaches there, and that trades a workflow rather than being free: it narrows the
wildcard role too, on any mount whose only checked-in slug is the narrow one —
three of the 27 distinct `bundle:` + `path:` mounts the prod roster declared on
2026-09-13, the `google-sheets-*-ro` ones — where it could no longer create the
wider half of a `-ro` / `-rw` pair without a deploy. (A mount is not a slug, and
that count is a dated read of `strad/infra/strad.prod.yaml` in the private
`tadasant/tadasant-internal`, not something this repo can re-derive.) Left open
deliberately, as a posture decision for the operator rather than a defect. The
operator took it on 2026-09-13 and kept the workflow, and it is re-taken if a
`connectors` write tool is granted to a role other than `admin` — which is what
bounds the widening today, since the four write tools are `admin`-only in
production. `save_connector` is the one of the four the widening actually runs
through, being the only one that composes an entry and so the only one that
reaches `assertAcceptable`; the trigger is drawn at the grant because that is
the unit the decision is taken in.
`docs/src/content/docs/operate/runtime-config-plan.md` carries the decision and
that condition as the open half of phase 2, and
`test/connectors.isolation.test.ts` asserts the behaviour that was chosen so
that re-taking it must update the record.

**AND IT BOUNDS WHAT A WRITE REACHES, NOT WHAT A WRITER STOPS.**
`set_connector_enabled`, `remove_connector` and `restore_connector` compose no
entry, so they never reach `assertAcceptable` and no bound here touches them: a
narrow writer holding the write tools can disable or remove any connector in the
roster, including one it cannot reach. Availability rather than disclosure, and
deliberate in the other direction — refusing a removal is what would leave a
broken connector nobody can switch off, a removal of a checked-in slug is a
standing instruction the console shows and `restore_connector` undoes, and
nothing is SERVED that was not served before. Stated here because the reach bound
is easy to read as "the write tools are now safe for a narrow role", and this is
the half it does not cover.

**Why.** The first is physics, not policy: nothing in a running App Platform
container can be handed a new environment variable, and a feature that pretended
otherwise would ship a Save button whose result is a mount that lists no tools.
The second is a store limitation strad cannot fix from the client side.

**Undo.** For the first: a credential path that a running container reads rather
than receives — the same move `paramsRefresh:` makes, widened from "a value
behind an already-listed name" to "a name the spec never listed", which needs the
bundle host to discover mounts from the store instead of from `process.env`.
#100's store-served instances are that path for the three trees that build from
an injected environment; the rest need a tree that does, or a process per
credential. For the second: a stored document with an
`etag`-style precondition, or a single writer elected per deployment.

---

## 97. A console session cannot be revoked one at a time, and one in use renews to its cap

**What.** The Google console session is a signed cookie with no server-side
record (`src/auth/session.ts`). It slides: past half its window
(`auth.google.session.slidingTtlSeconds`, 48 hours by default) the console gate
re-issues it, and an absolute cap counted from the Google sign-in
(`absoluteTtlSeconds`, 7 days by default) refuses it however recently it was
renewed. Nothing can end ONE session early. The only revocation is rotating
`CONSOLE_SESSION_SECRET` (or `GOOGLE_CLIENT_SECRET`, when that is the key), which
signs everyone out.

**Why.** strad has no datastore, and the console may run more than one replica,
so a session table would have the failure #11 fixed for the OAuth transaction: a
session minted on one replica unknown to another, and every restart a sign-out.
A fixed 12-hour life would bound a stolen cookie at 12 hours, at the price of a
sign-in every day. Renewal (#46) trades that for the cap: a stolen cookie the
thief keeps using renews itself just as the owner's does, and stays live until 7
days after the owner signed in.
The cap can be lowered in config and never raised past 30 days, and a cookie that
cannot say when its sign-in was is refused rather than uncapped.

**Undo.** A durable server-side session store, shared with #43's single-use login
tokens rather than built twice: each renewal checks a revocation list, and the
console lists and ends individual sessions. That is the issue's option C, deferred
until per-session revocation is a requirement on its own.

---

## 98. Console login tokens live in core's memory

**What.** A console login token (`POST /console/tokens`, `src/auth/console-tokens.ts`)
and the 30-minute session it is exchanged for are records in a `Map` inside the
core process. Nothing persists them and nothing shares them. A restart — every
deploy is one — ends every outstanding token and every token session.

**Why.** Single-use and revocable both need server-side state: a stateless HMAC
has nowhere to write "used" or "revoked". strad has no datastore (hack #6), and core
is exactly one process — `renderAppSpec` hard-codes its `instance_count: 1` — so
the process's memory is a complete store for it. The compare-and-set is atomic
because `exchange()` is synchronous and Node runs one turn at a time; a store
that lived across a network hop would need a real conditional write instead.

Every way the one-process premise can break fails closed:

- a restart between mint and exchange makes the token `invalid_token` — no
  cookie, and the actor re-mints;
- a restart mid-session makes the cookie stop resolving — the sign-in wall;
- a second core replica makes a mint on one unknown to the other (`401`, no
  cookie), and makes a revoke that lands on the wrong one answer `404
unknown_token` rather than claim a revocation. A token is consumed where it
  lives, so single use still holds.

What is lost is availability, never safety: nothing here can issue a session
that should not exist, or let a token be spent twice.

**Scope.** The routes exist only where `auth.consoleTokenLogin.enabled` is true
and `gateway.env` is exactly `dev`, `local`, `test` or `staging`. A token
session can view the console and cannot act through it — no reveal, no store
write, no connector, no playground tool call — so an automated actor cannot drive
the console's write forms at all; that would need a mint-time capability, which
is not built. Minting takes a standing console credential: `ADMIN_BOOTSTRAP_TOKEN`
(through the bypass, hack #2) or a Google session. When tadasant/strad#6 deletes
the bypass, a Google session is the only minter, so a CI job that mints for
itself needs a standing credential that survives it; choosing one is that
issue's decision, not this one.

**Undo.** Move the records to the same shared store as hack #6's
database-backed `TokenStore` (tadasant/strad#10), with the compare-and-set as a conditional write
there (`UPDATE … SET status='consumed' WHERE jti=$1 AND status='active'`,
checking the row count). Do it before core runs more than one replica, not after.

---

## 99. An `oauth:` connector reads its OAuth client through the console, which is the one read production's console is set up not to have

**✅ RESOLVED — the grant is no longer a hand-run step.** Both halves of it are
strad's now, and both are derived from config rather than from a request
(`isConnectorClientPath()` in `src/connectors/index.ts` is the one derivation):

- A secret parameter created at a declared connector's `oauth.clientIdVariable`
  or `oauth.clientSecretVariable`, under that slug's own `static/` namespace,
  also binds the console's own service account `secretAccessor` on that one
  secret — `create({ consoleReadable })` → `bindSecretAccessors()` in
  `src/secrets/parameters/gcp.ts`, the same read-modify-write that already
  granted the parameter's own principal, with a second member in it.
- Every connector that already exists was seeded before that, so the connector
  page offers **Grant read on this client** beside the `client_unreadable`
  refusal: `POST /ui/<slug>/grant-client`, which is `grantConsoleRead()` on the
  two client paths.

**The grant is VERIFIED, not assumed**, and that is the whole reason the repair
is worth having rather than a doc paragraph. The §1 deny policy (#31) is
evaluated before any allow and cannot be granted around, so on a deployment that
applied it the `setIamPolicy` returns 200 and the value stays unreadable. The
store reads the value back and drops it, and the page reports what actually
happened — reusing `clientReadFailure()`, the same sentence the refusal it
repairs is built from, and naming `strad-console-no-read` as the likely cause. A
button that claimed success there would move the failure from before the consent
screen to after it, which is strictly worse than the `gcloud` loop it replaces.

**What the entry is still recording.** Two things.

First, the fork: a deployment that applied the deny policy has decided its
connectors need a human, and gets told so rather than handed a button that cannot
work. Automating this is only coherent for a deployment that accepts §1's own
posture — which §1 states plainly, under _"This role can escalate to read. Say it
out loud."_: the console holds `setIamPolicy` at project level and is two API
calls from granting itself read, so write-without-read there is a speed bump and
an audit signal rather than a wall. The button changes how ergonomic that
self-grant is, not whether it is possible.

Second, the cost: the self-grant that #31 describes as a conspicuous, logged act
is now a routine one, on two named secrets per connector. What replaces the
conspicuousness is a record rather than its absence —
`strad.connector_client_granted` (slug, variable, result) at the moment it
happens, and `strad.connector_client_grant_failed` at ERROR when the binding
landed and bought nothing.

**What is still never granted.** The `oauth/` kind, for either path. The client
id goes out in every authorization URL and the client secret is one a human typed
and holds a copy of; the credential strad mints under `oauth/` is one no person
has ever seen. A client hand-seeded under `oauth/` is refused by the button, with
a sentence saying so, and keeps the manual grant — which stays documented as the
fallback in `docs/operate/secrets-iam.md`.

**Undo.** A connector that never needs the console to read its client at all,
which would close the exception rather than automate it. Two options, and
choosing between them is a posture decision rather than a code one:

1. Seed the client id as a non-secret parameter. It is public by design (it goes
   out in every authorization URL), so the connect POST then needs no Secret
   Manager read. That halves the grant and does not remove it.
2. Run the code exchange where the client secret already is. The slug's own
   container has both values in its environment, baked at deploy. Core would hand
   the bundle host the code and the PKCE verifier over the internal route the
   parameter write-back already uses, and the host would return the refresh token
   for core to store. Core then never reads a client secret at all, and §1's
   write-without-read holds with no exceptions. The cost is a new internal route,
   and a second thing an internal-token holder (#63) can drive.

---

## 100. What a store-served instance does not cover

**What.** A `supplementary-image` server on `path: /_instance/{tree}/{slug}` is
credentialed at runtime: core lists it to its bundle (`GET /_strad/instances`) and
serves that slug's own namespace (`GET /_strad/instances/{slug}`), and the bundle
host builds the instance from those values (`src/secrets/param-route.ts`,
`src/http/instances.ts`). Six edges, and the boundary that bounds them.

**The caller is the component that serves the slug, and no other.** Both
routes read the caller's component off its own internal token (#63,
`internalCaller` in `src/auth/internal-token.ts`): the list answers for that
component only, and the env route serves a slug only when its `bundle:` is the
caller's. `bundle-zimmer-secrets`, a third-party image, or any other component
asking for a slug it does not serve gets the same 403 as a slug that is not an
instance.

**Three trees, one account per slug.** `telegram`, `google-sheets` and `grafana`
only, because they build from an injected environment.
`remote-filesystem-tmp-public` is not one yet (its upload and download routes key
on the mount path), and gmail, calendar, docs and every tree that reads
`process.env` once cannot be. An instance path must name its own slug, so two
slugs cannot share one instance: a `-ro` / `-rw` pair over one account is two
instances with the same values seeded twice.

**A telegram rebuild does not close the connection it replaces.** A grafana
instance is closed when it is replaced (its child process stops). telegram's
MTProto connection is memoised inside the tree with no close, so any change to
the slug's namespace — not only a rotated credential — leaves the previous
connection open until the container restarts. It is a leak, not a second
identity: nothing routes to the replaced instance.

**A sync is a poll.** One list call per component per
`STRAD_INSTANCE_SYNC_SECONDS` (default 60), plus one env call per instance, each
a slice of core's one reading of the store rather than a store read — paid on
every component whether or not it runs an instance.

**A namespace outlives its entry.** An instance reads whatever its slug's
namespace holds, including values a removed slug left behind or a consent
somebody else gave. A writer who creates an instance under that slug is served
that account. That is not a reach this change adds: a runtime-created
`remote-http` entry already reads the same namespace through
`forServerIsolated` and can send it to a URL of its choosing. Both are bounded by
who holds the `connectors` write tools, and neither by the namespace itself.

**Nothing checks the image.** An instance only runs on a component running the
strad bundle image, which is the only thing with a reconciler. An instance entry
on a component running another image is listed to it and never served.

**Health lags the first sync.** The host lists a built instance on `/healthz` at
its path, and one core listed but that could not be built as degraded with the
reason. Before its first sync it lists neither, so a component serving only
instances reads as unrecognised to core's mount health for up to one sync.

**Why.** The alternative to the route is a credential on the container, which is
what the viewer/admin/resolver split exists to refuse; the route is what keeps
the container holding none. The tree limit is a property of the trees, not of
the mechanism. The leak is the telegram tree's, and closing it is a change there.

**Undo.** A `close()` on the telegram tree. An instance tree for remote-filesystem once its
routes key on the slug.

---

## 101. strad-hostd is installed, permissioned and logged in to Cloudflare by hand, on the machine

`hostd/` is the daemon behind the `shell-*` and `browser-use-*-headless`
`local-tunnel` slugs (`docs/servers/hostd.md`, `docs/servers/hostd-design.md`).
Operating it starts with steps AGENTS.md's "Ops without box access" rule calls a
design defect, and this entry is the marker that rule asks for:

- `./hostd/install/install.sh` is run in a terminal on the laptop. It installs a
  LaunchAgent and runs `cloudflared tunnel login`, which opens a browser.
- macOS TCC prompts ("node would like to access files in your Documents
  folder") can only be answered at the screen.
- Chrome's remote debugging is a toggle at `chrome://inspect/#remote-debugging`,
  or the extension of #112, installed from `chrome://extensions` or a profile.
- The Messages server's helper is granted Full Disk Access in System Settings
  (#115).
- The Cloudflare Access application and its service token are made in
  Cloudflare's dashboard.
- An upgrade is `git pull` and the install script again. It can run unattended
  through a Mac-gated worker over the `shell-*` slug, which is still the box-access
  route. `hostd/install/launchd.sh` is what keeps that from stranding the machine:
  on an upgrade, nothing but a launchd-run one-shot unloads a service.

**Why it cannot be designed out the usual way.** The rule exists because a
container strad deploys can always be reached by a deploy. This box is a personal
laptop that strad does not deploy to and must never hold a credential for: the
whole security argument is that the machine dials out and nothing dials in. A
channel that let strad push code or config to the laptop would be a standing
remote-code-execution path with no dialog in front of it, which is the thing the
consent gate exists to prevent.

**What stays off the box.** Everything after install. The slugs, their
entitlements and their `recovery:` text are config and ship by deploy. The three
secrets per slug are seeded at `/ui/secrets`. Whether the machine is up is on
`/healthz` and in `troubleshoot_host`. No strad-side step needs the laptop.

**Two behaviours that follow, worth knowing before they surprise someone:**

- An unanswered consent dialog is a DENIAL by default, so with nobody at the
  laptop every `request_control` fails with `timeout`. That is the shipped
  posture, not a fault. `consent.onTimeout: "allow"` in
  `~/.strad-hostd/config.json` makes the dialog a veto window, and is again a
  file on the box.
- The macOS halves have never run in CI, which is Linux: the `osascript` dialog
  (and that its JXA `NSAlert` ignores every key, which only a Mac can show),
  the LaunchAgent, the installer's `cloudflared` branch, and Chrome 144's
  debugging toggle against a real default profile. The design page lists what was
  run and what was reasoned about. The installer's restart paths run against a
  real launchd on a macOS runner, on a throwaway agent. The `5` that stopped the
  first unattended run (#457) reproduces on that runner as a `bootstrap` into an
  unfinished `bootout`. Nobody has shown that on the laptop, so the installer prints
  what would prove it. The post-restart `/healthz` check and rollback run only if
  the installer outlives the restart.

**Undo.** A signed, notarized app with an auto-updater would take upgrades off
the terminal and give TCC a stable identity to grant. It would not remove the
first install, the TCC clicks or the Cloudflare login, and nothing should.

---

## 102. An Office workbook in Drive is read by strad's own parser, not by Google

**What.** A `.xlsx`, `.xlsm`, `.csv` or `.tsv` **uploaded** to Drive rather than
converted to a native Google Sheet is invisible to the Sheets API: every call
against it is `400 FAILED_PRECONDITION: … The document must not be an Office
file.` The four read tools of `google-sheets` now fall back to downloading the
file from Drive (`files.get?alt=media`) and parsing the workbook in-process —
`images/bundle-google/vendor/google-sheets-shared/src/office/`, a ZIP reader, an
XML scanner and a SpreadsheetML reader written here.

**Why.** The alternatives are worse. `files.export` converts only NATIVE
Workspace documents and cannot touch an uploaded binary. `files.copy` with
`mimeType: application/vnd.google-apps.spreadsheet` works, and leaves a second
file in the owner's Drive every time an agent reads a spreadsheet — a write, in a
read tier. The npm packages that read xlsx are large, and the popular one has
been unmaintained on npm since 0.18.5 with a live prototype-pollution advisory;
this process holds three Google accounts' refresh tokens beside thirty other
MCP servers.

**What it costs, and what a caller is told.** Every Office-backed result carries
a provenance line saying so, because the read is not equivalent:

- Values are **as the file was last saved**. A formula cell serves its stored
  result; `value_render_option: FORMULA` serves the formula text.
- There is **no number formatting**. `FORMATTED_VALUE` returns `1234` where the
  Sheets API would return `$1,234.00`. Dates and durations are the exceptions —
  a date-formatted serial renders as `2025-01-21` and an elapsed `[h]:mm` cell as
  `36:00:00`, because in those two cases the raw number carries no recoverable
  meaning. `UNFORMATTED_VALUE` returns the stored number, which is what the
  Sheets API returns under that option too.
- `namedRanges` is empty; an .xlsx's defined names are formulas, not grid ranges.
- The reported `gid` is the workbook's own `sheetId`, not a Sheets gid. It is
  stable within the file and `get_spreadsheet` reports the same number
  `sheet_gid` then resolves.
- **No write tool works.** Writing one back would be a Drive WRITE scope, a
  re-encoded workbook and a last-writer-wins race against whoever has the file
  open. The five write tools that edit a file refuse and name the conversion.
- One workbook is read **whole**: 20MB downloaded (bounded on the stream, since
  Drive's `size` is optional), 500,000 cells parsed, 128MB inflated — each
  refused past that with a message. A native spreadsheet is read a range at a
  time and has no such ceiling.
- Legacy `.xls`, `.xlsb` and `.ods` are refused by name, and so is a UTF-16
  `.csv`: decoded as UTF-8 it is plausible-looking nonsense rather than an
  error, which is worse than a refusal.

**The scope.** The fallback needs
`https://www.googleapis.com/auth/drive.readonly` on the slug, which is broader
than the Sheets scopes it sits beside — it reaches every file in the account's
Drive, not only spreadsheets. Google offers nothing narrower that can download a
file the app did not create: `drive.file` covers app-created files only, and
`drive.metadata.readonly` cannot read content. A slug WITHOUT the scope serves
native spreadsheets exactly as before, and an Office file fails with a message
naming the scope, the config field and the Reconnect button.

**Undo.** Convert the file: File > Save as Google Sheets in the Sheets UI mints a
native spreadsheet, and every tool here then works against it live, formatted and
writable. That is the better outcome in every case where a human can do it; this
path exists for the files where nobody has.

## 103. The Device Farm server is shipped whole and has never made a live call

`servers/aws-device-farm/` is built, tested and baked into the bundle image at
`/aws-device-farm`. **No environment declares a slug for it, and no AWS account
exists.** Every line of it is written from AWS's published API and documented
behaviour; the suite runs against injected fakes, and the first real request is a
step in `docs/servers/aws-device-farm-setup`.

**Why it shipped this way.** An unresolved `${NAME}` fails the `render-spec`
run, and the render is the WHOLE spec — so a slug that lands before its secret
is seeded takes every other server's deploy down with it. Shipping the mount
without a slug costs nothing (the image carries one more tree and one more
`degraded` mount) and keeps the seeded-credential step a paste rather than a
second PR.

**The human-owned steps this implies**, which AGENTS.md's "ops without box
access" rule asks be written down where they are incurred: creating the AWS
account, creating the Device Farm project, writing the IAM policy, minting the
access key, and placing three values at `/ui/secrets`. None is a shell on a
container — provisioning a vendor account and a first API key is a boundary an
agent must not cross, and the rest goes through the console. The setup page is
the runbook.

**Four claims the first live call will settle,** in order of how likely they are
to bite:

1. whether the Appium endpoint accepts a session created with `platformName:
iOS` and `appium:automationName: XCUITest` and nothing else, which is what
   `drivers.ts` sends — Device Farm injects the installed build as `appium:app`,
   so naming one here would override what the session installed;
2. whether the iOS predicate `hasKeyboardFocus == 1` names the field a coordinate
   tap just focused on a real device, which is what `type_text` relies on when it
   is given `x`/`y` rather than a label;
3. how long a remote access session really takes to become drivable, which
   decides whether `start_device_session`'s 180-second default wait is generous
   or tight;
4. whether `"2"` is the right `appium:version` to default on iOS 27 and later,
   where Device Farm requires one and rejects the request without it — the SDK
   documents "2 or 3" and says the service may reject a version the device does
   not have.

**A fourth thing that is a choice rather than an unknown:** `upload_app` BUFFERS
the build in memory. The pre-signed S3 PUT Device Farm hands back needs a
`Content-Length` and a source URL is not obliged to declare one, so the download
is read with a running ceiling — `AWS_DEVICE_FARM_MAX_UPLOAD_MB`, 192 by default
— and abandoned mid-flight if it exceeds it. On a 2 GB box shared with a Chromium
that ceiling is a real bound, and a build larger than it cannot be uploaded
without raising it.

**Undo.** A slug in `infra/strad.staging.yaml` and in prod's config, once the
credential is seeded; the exact block is in the setup page. The buffering goes
away if Device Farm ever accepts a chunked PUT, or if strad grows a place to
spool a build to disk.

## 104. A spreadsheet `create_spreadsheet` makes lands in the Drive root, shared with no one

**What.** `google-sheets`' `create_spreadsheet` is `spreadsheets.create` and
nothing else. It needs only `https://www.googleapis.com/auth/spreadsheets` — the
scope every `-rw` slug already holds; Google's discovery document lists `drive`,
`drive.file` and `spreadsheets` as each sufficient — and the file lands in the
ROOT of the slug account's My Drive, owned by that account and shared with no
one. Filing it in a folder and deleting it are Drive API writes this server
never makes, so neither is a tool. Sharing is one — `share_spreadsheet`, a
`permissions.create` on the full `drive` scope, held only by an `-rw-external`
slug — so on a `-rw` slug the new file stays shared with no one.

It is also not idempotent. A call that times out after Google made the file and
is then retried leaves two files, and nothing here can remove the first. The tool
description says so, and asks a caller to look before it retries.

**Why.** Adding a Drive write scope to three Google accounts to put a file in a
folder is a much bigger grant than the feature, and a `drive.file` grant would
reach only files this app created — so it could file a new spreadsheet but not
one a human made. The tab titles and the frozen header row ride in the same one
request, so a failure never leaves a half-built file behind.

**Undo.** A `move_spreadsheet` behind `drive.file`, on a slug whose operator has
decided that scope is worth it. The create stays on
`spreadsheets` either way.

## 105. A client id metadata document is fetched on an unauthenticated request, and trusted only at `/authorize`

**What.** strad's authorization server accepts an `https` URL as a `client_id`
(OAuth Client ID Metadata Documents, `src/auth/mcp-oauth/cimd.ts`) and fetches
the document behind it at `GET /oauth/authorize`. It is on whenever
`auth.mcpOAuth` is — there is no separate switch — and it is additive to dynamic
registration. Four properties follow, stated rather than worked around:

1. **Anyone can make strad fetch a public `https` URL.** The fetch is guarded —
   `https` only, every resolved address must be public (checked inside the
   socket's own lookup, so a rebinding name has no second answer to give), no
   redirects, 5 KiB, five seconds — but the destination is the caller's choice.
   One `/oauth/authorize` is at most one fetch, and failures are not cached (the
   draft forbids it), so a caller who repeats the request repeats the fetch. At
   most 16 fetches are open at once across the process; past that a new
   `/authorize` is refused as busy rather than queued, so a caller looping
   against a host that trickles its answer holds sixteen sockets, not
   unbounded ones — and can, for that window, make a real client's sign-in
   fail until it retries. The
   IPv4 half of the address rule is a denylist of special-use ranges, like
   strad-fetch's (#79); the IPv6 half admits global unicast only.

2. **A metadata document cannot vouch for a loopback redirect URI.** Any program
   on a machine can present `https://vscode.dev/oauth/client-metadata.json` and
   listen on `127.0.0.1:33418` itself. The consent screen names the publishing
   host and, when the code goes to a loopback listener, says in words that any
   program on the machine could be claiming that name. Nothing stronger is
   possible without client attestation.

3. **The token endpoint does not re-fetch.** A grant is bound to its client by
   the fingerprint sealed into the code and the refresh token at `/authorize`,
   which is where the document was checked. Re-fetching on refresh would make
   every connector's life depend on its publisher's uptime, and would add nothing
   to the binding. The cost: a publisher that withdraws its document, or removes a
   redirect URI, does not end grants already issued. Revocation stays Google's
   (#94).

4. **The document cache is per process.** `Cache-Control` is respected, bounded
   to an hour, five minutes when absent, never for `no-store`/`no-cache`, never
   for a failure. A redeploy or a second replica fetches again.

**Why.** CIMD is what the MCP authorization spec (2025-11-25) prefers for clients
with no prior relationship to the server, and claude.ai and VS Code both publish
one. Fetching the document is the mechanism; the guards bound what the fetch can
reach, not whether it happens.

**Undo.** (1) narrows with a per-host allowlist (`auth.mcpOAuth` could grow one),
at the cost of an operator edit for every new client — the thing open
registration exists to avoid. (2) needs attestation the spec does not yet
define. (3) and (4) need a datastore, like the rest of #94.

## 106. A flow-through grant is held by a component, and bounded by its pins and the source's code

**What.** `reaches:` (src/config/reach.ts) lets a hosted server call another
slug's tools through `/_strad/reach/{slug}/mcp`, as itself. Core proves the
caller's COMPONENT with its derived internal token, and then trusts the slug
named in the path as long as it lives on that component. Every server on one
component shares a process environment, and so the same token, so any server
there could exercise a neighbour's grant. Past the pinned arguments, which fix
an argument to one exact value, nothing at the gateway bounds WHAT the source
does with the target's tools: a grant on `update_sheet_values` pinned to one
spreadsheet can still write any cell of that spreadsheet.

**Why.** A per-server credential inside a shared container is not something the
bundle hosts can hold apart today, and a richer pin language (column ranges,
path prefixes) is a second policy dialect per upstream. The first grant is one
spreadsheet, one private server, on a component that runs only first-party code.

**Undo.** Per-server tokens (the component token extended with the slug, handed
to each mount rather than to the process), and pin forms beyond exact equality
where a real grant needs them.

## 107. The console's MCP Apps host isolates with a CSP sandbox, not the spec's separate-origin proxy

**What.** SEP-1865 describes, for web hosts, a sandbox PROXY iframe served from a
different origin, with the app's HTML handed to it over `postMessage`.
`/apps/:server/frame` (src/ui/apps.ts) serves the app's HTML from the console's
own origin instead, under a `Content-Security-Policy: sandbox allow-scripts …`
header without `allow-same-origin`, which gives the document an opaque origin,
and `connect-src 'none'`. The host also implements only `ui/initialize`, `ping`,
`ui/open-link` and `tools/call`, plus the `tool-input` / `tool-result`
notifications. It has no model, so `ui/message` and `ui/update-model-context`
answer "not supported".

**Why.** strad has one public origin and no second one to serve a proxy from.
The CSP sandbox gives the property the proxy exists for (the app cannot touch
the console's origin) without one.

**And its history.** In Chromium, a traversal to an entry the frame pushed
reloads the opaque-origin frame, and so does the host setting the frame's
`#hash` (`location.replace`, or a new `src`). The host closes an app whose frame
loads twice. So the frame cannot own Back: the host pushes entries on the app's
request (`x-strad/hash {hash, push: true}`) and sends the restored hash down on
`popstate`. An app that does not opt in gets no in-app Back.

**Undo.** A second hostname for app frames, when strad has a reason to own one.
That undoes the isolation half; whether a frame on its own origin keeps its own
history through a traversal is untested.

---

## 108. The computer-use servers are signed, permissioned and re-approved by hand, on the Mac

`hostd/ax/` is `strad-hostd-ax`, the native helper behind the
`computer-use-*-headless` and `computer-use-*` `local-tunnel` slugs and the
on-screen banner (`docs/servers/hostd.md`, `docs/servers/hostd-design.md`). It
adds three steps to #101 that only the person at the Mac can take, and one that
recurs:

- **A signing identity.** macOS keys the Accessibility and Screen Recording
  grants on the helper's code signature, and an ad-hoc signature is the
  binary's hash, so `hostd/install/sign-helper.sh` signs with a Developer ID
  certificate or with a self-signed one it creates in the login keychain and
  trusts for code signing. The trust step asks for the login password in a
  dialog. The self-signed branch has run on no machine.
- **Two grants in System Settings.** Accessibility for both servers and Screen
  Recording for the foreground one, added by hand or through the helper's
  `--request-access`, and only meaningful if TCC attributes them to the helper
  rather than to `node`, which is why the helper runs as its own LaunchAgent
  (`com.strad.hostd-ax`) and not as a child of the daemon. Reasoned from how
  launchd resets the responsible process; not yet observed.
- **The monthly Screen Recording re-prompt.** macOS 15 asks again, about
  monthly, whether an app that captures the screen without the system picker
  may keep doing so. `CGDisplayCreateImage` is such a capture, and so is
  ScreenCaptureKit without the picker. Nothing in strad, the daemon or the
  helper can answer it. Until the owner clicks, `take_screenshot` fails with
  `screen_recording_denied`; the headless server is unaffected.

**Why it cannot be designed out.** The same reason as #101: the box is a
personal laptop that strad holds no credential for and must never push code
to. The grants are the machine's owner deciding what a program on it may see,
which is the one decision that should stay on the machine.

**And one boundary that is not there.** The helper's socket is a file every
process of the owner can open, a shell-slug command included. The helper
honours one controlling connection and refuses every op that acts on the
machine unless that connection's last `set_state` carried a covering grant,
which closes the cheap path while the daemon is up. It is not a privilege
boundary: two processes of one macOS user cannot keep secrets from each other,
so a process running as the owner can stop the daemon, edit its config, unload
a LaunchAgent or replace the helper binary. That is the shell slug's blast
radius, named in #159 from the start, and why every hostd slug stays
`admin`-only.

**What stays off the box.** As #101: the slugs, their entitlements and
`recovery:` text ship by deploy, the keys are seeded at `/ui/secrets`, and
`get_control_status` on either server reports `helper: {running, accessibility,
screen_recording}` so a caller, and the console through it, can tell "grant
lapsed" from "helper down" without a shell.

**Undo.** A Developer ID certificate removes the self-signed branch and its
password dialog. The `com.apple.developer.persistent-content-capture`
entitlement removes the monthly prompt, and Apple issues it on application to
VNC-class products. The grants themselves are the owner's, and stay.

## 109. The WhatsApp bridge is an unofficial linked device, one socket, with its state in a bucket

`servers/whatsapp/` sits in WhatsApp chats as a LINKED DEVICE of one real
account, through Baileys (`docs/servers/whatsapp.md`). Meta's Cloud API cannot
join a group a consumer created, so there is no official route to the
requirement. What that costs:

- **Terms of Service.** Automating an account this way is against WhatsApp's
  ToS, and the account can be banned. Every tool description says so. Sending
  is human-paced (typing indicator, 3 s spacing, refused past 6/minute or
  60/hour), which lowers the risk and does not remove it. Baileys is
  `7.0.0-rc14`, pinned exactly: the 7.x line is the one that speaks WhatsApp's
  LID addressing, and it has not left release candidates.
- **One instance.** A linked device is one socket; two processes holding its
  state kick each other off and both write its Signal ratchets. The renderer
  refuses `instanceCount > 1` for any bundle serving `/whatsapp`
  (`SINGLE_SOCKET_PATHS`), and the server's own lease in GCS makes the newest
  process the owner across the overlap an App Platform deploy creates. The
  older process stops within 30 s, or at its next state write or reconnect if
  that comes first (each re-reads the lease). State an old process wrote in
  that window and the new one overwrote is lost; a Signal session that loses a
  ratchet step recovers through WhatsApp's retry receipts, and a message can
  arrive late or as "waiting for this message" once.
- **The device cannot be named.** It pairs as Baileys' `Browsers.macOS("Chrome")`
  preset (`PAIRING_BROWSER`), so the phone lists it as Chrome on Mac OS. The
  pairing-code request carries the OS and browser, and the phone refuses a code
  whose OS it does not recognise ("Couldn't link device"): a custom name such as
  "Zimmer (read-only)" in the OS slot failed every prod pairing on 2026-10-08.
  There is no other slot to put a name in. Baileys' own README allows a
  custom browser name for QR pairing only.
- **The QR's text is pairing key material.** `whatsapp_pair {"method":"qr"}`
  returns the payload as text beside the PNG, so a client that cannot draw an
  image can still render it. That payload ends in the device's
  `advSecretKey`, which stays in its login after pairing, so it lands in the
  caller's transcript. It is not enough to act as the device: that needs the
  Signal keys, which never leave the sealed state. The bridge never logs it.
- **State in a bucket, not a database.** The Signal state and the buffer are
  sealed objects under `WHATSAPP_GCS_PREFIX` (the prefix is part of each
  object's AAD, so moving them is as breaking as a new key), written on a 2 s
  debounce and on SIGTERM. A crash loses up to that window: the same
  retry-receipt recovery for keys, and messages RECEIVED in it are missing
  from the buffer. A SENT message's id is written before it is sent.
- **The bucket is reached by a hand-written GCS client, not
  `@google-cloud/storage`.** That client, and its service-account token fetch,
  run on gaxios 6 and node-fetch 2. node-fetch 2.7 calls a chunked response
  `Premature close` whenever any `data` listener is still on the socket as the
  response closes. On prod's `bundle-whatsapp-tadas`, on 0.4.106, every token
  POST to `www.googleapis.com/oauth2/v4/token` failed that way: three tries
  out of three, inside each of four outer tries, on every call. The same
  library, in the same image, works from the `bundle` component and from
  anywhere it was tried by hand, and what leaves the listener there was never
  found: there is no shell on that box, by design. So `GcsBlobStore` signs its
  own service-account JWT (RS256, `node:crypto`), trades it at
  `oauth2.googleapis.com/token`, and makes five JSON-API requests (metadata,
  pinned download, multipart upload with `ifGenerationMatch`, delete, paged
  list) on Node's own `fetch`. undici's parser knows whether it saw the last
  chunk, so a body reported cut off was cut off. Every call still runs inside
  `transport()`: up to 4 tries, 250 ms backoff doubling, no new try after
  15 s, a 30 s cap on each request. A transport error retries, and so do 408,
  429 and 5xx when the call is replayable; a 401 gets one more try with a
  fresh token. An unconditional write replays only when it certainly was not
  applied (the token fetch failed, or GCS answered 401 or 429), because one
  that may have landed could overwrite a newer process's lease. Each retry logs
  the error's whole `cause` chain with its codes. Past the budget a tool says
  `transient; retry`. The 15 s bounds when a try may START, not how long it
  runs: a try is a token request and an object request of up to 30 s each, and
  a read is two calls in a row, so a GCS that hangs rather than refuses can
  hold one tool call for a few minutes. The
  cost is a second GCS client to keep honest: `test/gcs.test.ts` drives this
  one against a fake JSON API and a fake token endpoint that checks the JWT's
  signature, and nothing in CI talks to real GCS.
- **No history API.** A linked device gets one history sync when it pairs and
  whatever its socket receives after. A gap WhatsApp does not replay on
  reconnect is a gap in `whatsapp_get_messages`.
- **The phone must come online every ~14 days**, or WhatsApp logs the device out
  and a human pairs again. That is WhatsApp's rule, surfaced as
  `last_disconnect_reason: "logged_out"`.
- **Key rotation is not supported.** A new `WHATSAPP_STATE_ENCRYPTION_KEY` makes
  the stored state unreadable; the server reports `state_unreadable` and does
  not connect. The recovery is the old key, or `whatsapp_logout` and a new pair.

**What stays off the box.** Pairing is `whatsapp_pair`, a tool call from the
console playground or an agent; the phone gets a code, and nobody opens a shell
to scan a QR. The four variables are seeded at `/ui/secrets`.

**Undo.** An official API that can join a consumer group would replace all of
it. Short of that: a key-rotation path (read under a previous key, write under
the new one), and moving the Signal store to a database with transactions if
strad ever has one.

## 110. monarch-money's session cookie still expires, and a human still copies it

Monarch's web app authenticates with an HttpOnly session cookie, and a growing
share of accounts get a CAPTCHA on a scripted login (`403 CAPTCHA_REQUIRED`, or
the edge's `403 {"You":"Shall Not Pass"}`) — sources in
`servers/bundle-api/fork/monarch-money/FORK.md`. So the monarch fork's durable
path is a cookie a human lifted out of a signed-in browser, and that cookie
expires on Monarch's schedule, which nobody has measured. One sample says an API
call does not slide it, which is why there is no keepalive.

What strad does about it, without anyone opening a shell:

- `MONARCH_COOKIE` outranks `MONARCH_SESSION_TOKEN` and is read from
  `process.env` per request. With `params: true` and `paramsRefresh:
[MONARCH_COOKIE]` on the slug, a value rotated in `/ui/secrets` reaches the
  running container within `paramRefreshSeconds`.
- `set_session_cookie` (manage) verifies a cookie with a `me` query, then puts
  it in the live environment, then persists it through core's
  `paramsWritable: [MONARCH_COOKIE]` write-back into
  `/strad/{env}/mcp/<MONARCH_COOKIE_SLUG>/static/MONARCH_COOKIE`. That slug
  defaults to `monarch-money-readwrite`, because `-readwrite` and `-readonly`
  share one mount and one environment. The write reaches one parameter, the
  one the config names. A cookie Monarch refuses is stored nowhere.
- A `Set-Cookie` that re-issues the session replaces the old value and is
  persisted the same way.
- `MONARCH_EMAIL` + `MONARCH_PASSWORD` (+ `MONARCH_TOTP_SECRET`,
  `MONARCH_DEVICE_UUID`) turn on one headless re-login per refusal, retried at
  most once every 15 minutes. Whether it gets past Monarch depends on the
  account and on the egress IP. Until someone runs it, it is best-effort.

**What it costs.** The refresh is still a human copying a request header out of
DevTools, every time the cookie dies, unless headless login works for the
account. The cookie also travels through an agent's context when it is set over
`/mcp`. Tool arguments are never recorded by telemetry, and the tool does not
echo the cookie, but the agent's transcript does hold it.

**Undo / the real fix.** A browser extension on the signed-in profile can read
the HttpOnly cookie with `chrome.cookies` and push it to strad on its own. That
would close the loop with no human step. It belongs on the strad-hostd browser
bridge, once that bridge has a seam for it.

## 111. A `remote-http` Connect discovers its upstream, registers only public clients, and has met no real one

**What.** `POST /ui/<slug>/connect` on a `remote-http` server with
`oauthRefresh:` runs the MCP authorization flow from strad's own egress
(`src/connectors/upstream.ts`, `src/ui/upstream-connector.ts`): an
unauthenticated `initialize` for the `401`'s `resource_metadata`, the RFC 9728
and RFC 8414 documents, RFC 7591 registration, code + PKCE with `resource=`. It
writes the `${NAME}`s the block declares under the slug's `oauth/` kind and drops
the process's cached reading.

- Whether it works for a given upstream is decided by that upstream's firewall.
  From a DigitalOcean droplet (the Zimmer host, 2026-10-06) Rippling's
  Cloudflare answers `/mcp` with its `401`, bearer or not, and serves a `403`
  block page on EVERY other path on `mcp.rippling.com`, both `.well-known`
  documents included. Prod's App Platform egress got the same `403` on the
  protected-resource metadata that day. `app.rippling.com` —
  its OpenID configuration, its token endpoint (`/api/o/token/`) and an RFC 7591
  registration endpoint (`/api/o/register/`) that its metadata does not
  advertise — answers normally. What `mcp.rippling.com`'s own metadata names
  was never read from a cloud address. Two ways past the block, both covering
  the two metadata GETs and nothing else:
  - **Pasted metadata.** A `metadata_blocked` refusal opens a form on the page
    that links the refused document; a human opens it in their own browser and
    pastes the JSON. strad checks it as if it had fetched it, and also
    requires its `resource` and `issuer`. Manual: two
    copy-pastes on a blocked upstream.
  - **`oauthRefresh.discoveryProxy: { via: brightdata }`.** A document that
    answers strad `403` is re-read through BrightData's Web Unlocker, with
    `BRIGHTDATA_API_KEY` from the `apiKeyFrom` slug's namespace
    (`strad-fetch`'s). This is a deliberate workaround for the upstream's bot
    protection, and it hands the upstream's metadata URLs to a third party.
    Nothing carrying a credential goes through it — the function refuses any
    method but GET.
    Registration, the code exchange and every refresh still go out from strad.
    Connect GETs the token endpoint first and refuses (`token_endpoint_blocked`)
    on a non-JSON `403` a firewall signed (`cf-ray`, `server: cloudflare`,
    `AkamaiGHost`), before anything is registered or anyone signs in: a
    firewall there means no refresh would ever succeed, and neither workaround
    helps.
- The transaction cookie is HMAC-signed, not encrypted, so a client strad
  registers is always public (`token_endpoint_auth_method: none`); a confidential
  registration answer is refused. A confidential client is registered by hand and
  seeded, and its secret is read from the store at the callback.
- Every Connect registers a fresh client and abandons the last one at the
  upstream.
- No identity proof, as with `provider: generic`.
- Other core replicas see the write within `ttlSeconds`.
- The token URL, client id and resource are written before the refresh token; a
  store failure between them leaves a mismatched set until the next Connect.

**Why.** Encrypting the transaction to carry a client secret, or holding a
pending registration server-side, would add a second sealing primitive or the
server-side state `src/connectors/state.ts` exists to avoid, for upstreams that
the MCP spec already steers toward public clients. A WAF on someone else's
metadata cannot be routed around by strad alone. Pasting moves one public GET to
a human's browser. The proxy moves it to a third party, a choice the
deployment's owner made for one slug. Neither carries a credential, and the
refresh path, which runs on every token expiry, never leaves strad's egress.

**Undo.** Get the upstream to allow the deployment's egress, and drop
`discoveryProxy:`. Verify against a real upstream that allows App Platform
egress, and record it here.

## 112. The Chrome extension makes the owner's real profile drivable with no prompt, by anything holding a hostd key

`hostd/extension/` is an MV3 extension, and `hostd/src/browser/bridge.ts` is
the daemon side of it (`docs/servers/hostd.md`, `docs/servers/hostd-design.md`).
It exists because the two routes Chrome offers into the default profile cannot
run unattended: `--remote-debugging-port` is ignored there since Chrome 136,
and the `chrome://inspect/#remote-debugging` toggle (144+) asks "Allow remote
debugging?" on EVERY connection and never remembers the answer. An extension
installed in the profile attaches `chrome.debugger` to its tabs with no
per-connection prompt, and once the extension is connected the browser server
uses it ahead of `DevToolsActivePort`.

**The trade-off, plainly.** The owner's real, signed-in Chrome — every account
they are logged in to — becomes drivable, with no Chrome prompt, by anything
that holds a hostd browser key and gets past the consent window. Unattended use
is the point, so that window is `consent.onTimeout: "allow"` with
`windowSeconds` at its minimum, which makes the dialog a veto nobody is there
to cast. A prompt injection that lands in one agent's page therefore reaches
every one of the owner's logged-in sessions. The daemon's own boundaries are
what remain: the key per server, the grant per task, the audit log, the kill
switch — which now also detaches `chrome.debugger` from every tab — and the
`admin`-only entitlement on the strad side. None of them is Chrome asking.

**What is on the box, by hand (adds to #101).**

- Installing the extension unpacked, from `chrome://extensions` with
  Developer mode on, paired by pasting the token into its options page. It
  holds while developer mode does, and each attach shows a "started debugging
  this browser" bar unless Chrome runs with `--silent-debugger-extension-api`.
  The durable route — a configuration profile `strad-hostd extension` writes,
  which force-installs the extension from the daemon with the token in
  managed storage, cannot be disabled from `chrome://extensions`, and attaches
  with no bar — works only on a Mac Chrome considers managed: Chromium's
  `policy_loader_common.cc` filters a force-install from outside the Web Store
  as a sensitive policy, and `policy_loader_mac.mm` applies that unless the
  Mac is MDM-enrolled or domain-bound. On a personal Mac the entry shows
  `[BLOCKED]` in `chrome://policy`. The daemon still serves the CRX and the
  CLI still writes the profile, labelled for what it is.
- `consent.onTimeout: "allow"` in `~/.strad-hostd/config.json`, for the
  unattended posture.
- A key per local session: `strad-hostd key add browser <name>`, then
  `claude mcp add --transport http …`.

**What has run, and what has not.** The real extension runs in a real
Chromium in CI (`hostd/test/extension.test.ts`): it pairs over the socket,
attaches inside the profile, every browser tool works through it, two sessions
share one attachment, and the kill switch takes the debugger off every tab.
That Chromium is `--load-extension`ed; branded Chrome 137+ ignores that flag,
so the unpacked route in Google Chrome, and on a managed Mac the profile,
managed storage and the infobar's absence, have run on no Mac. The CRX3
packer and the update manifest are checked byte-for-byte against the format;
that Chrome accepts a loopback `http://` update URL, and blocks the
force-install on an unmanaged Mac, are both read from Chromium's source and
not yet observed. A rogue listener on the daemon's port is tested against the
real extension: it gets a nonce and nothing else.

**Undo.** Chrome offering a remembered "always allow" for remote debugging on
the default profile would retire the extension; nothing suggests it will.
Widening the entitlement past `admin` should not happen while this is the
posture.

## 113. A confirmation reaches the session the CALLER names, and the console has none

**What.** gmail's `send_email` asks a human before it sends, at the URL the
`/mcp` request names in `X-Elicitation-Url` (`src/gateway/elicitation.ts`,
`images/bundle-google/src/confirm.ts`). Five properties follow, stated rather
than worked around:

1. **strad trusts the caller to name its own session.** The allowlist
   (`gateway.elicitation.allowedUrlPrefixes`) decides where the bundle may fetch,
   not whose session it is. A caller holding another session's URL can raise a
   prompt on that session. It cannot answer one: Zimmer's token route creates
   and polls and does not respond, so the person who sees the prompt still
   decides. The URL is per session and minted from Zimmer's secret, so holding
   another session's means having read that session's environment.
2. **The console cannot send mail.** The playground has no prompt surface, so a
   human signed in to `/ui` gets the same refusal as a headless caller with no
   header. A `skipConfirmations: true` slug (5) is the exception.
3. **A window is only as long as the CALLER's hop holds it.** strad's own hop
   holds any `timeoutMs`: the bundle sends a progress keepalive every 30s, so
   the 300s body timeout in core's `fetch` never fires. The caller's hop to core
   is the caller's client and any ingress in front of strad, and strad sees
   neither limit. It relays the keepalives only to a caller that sent a
   progressToken; for any other caller, core's response is silent until the
   human answers. A window longer than that hop holds is SAFE but useless: the
   drop closes core's request to the bundle, the bundle's call signal fires,
   and the answer becomes `cancel`. The mailbox, and the Gmail send request
   itself, also refuse for a dropped call. What remains is a send whose request
   had already reached Gmail when the drop arrived. Nothing in this repo has measured how long
   App Platform's ingress, or Zimmer's MCP client, holds a silent `/mcp`
   response open, so there is no config guard. The limit belongs to the
   caller, not to the config.
4. **A container-wide `ELICITATION_*` setting is a refusal, not a fallback.**
   `ELICITATION_ENABLED=false`, `ELICITATION_REQUEST_URL` or `ELICITATION_POLL_URL`
   on the bundle makes `send_email` refuse every call, because the vendored tool
   reads them from `process.env` and would skip the prompt or send it to one
   address for everybody.
5. **`skipConfirmations: true` trusts the config about whose mailbox it is.**
   The slug's confirmed tools run with nobody asked, which is right for a
   mailbox that is the agent's own (Zimmer's) and wrong for a person's. strad
   cannot tell the two apart from the credential, so the reviewed config line is
   the only check. It cannot be set by a runtime roster write, it is refused
   beside `confirmations: true` and on a mount a sibling slug gates, and it
   reaches only that slug's calls.

**Undo.** 2 is a console prompt that answers the same protocol. 3 is a measured
caller-side bound, recorded here, or a caller that always sends a progressToken.
1, 4 and 5 are the design.

## 114. A WhatsApp attachment buffered before descriptors were kept is recovered from the phone, best effort

**What.** `whatsapp_get_attachment` (`servers/whatsapp/shared/src/tools/get-attachment.ts`)
downloads a media message with the media key and CDN path it carried on arrival,
which `normalize.ts` keeps on the buffered record as `media`. Records buffered
before that have neither, and nothing derives them. `recoverDescriptor` in
`bridge.ts` asks the phone twice at once — `requestPlaceholderResend` for the
message's key, and `fetchMessageHistory(50, …)` anchored on the next buffered
message — and waits up to 30 s for either answer to be ingested and merged.

1. **It needs the phone online and still holding the message.** Neither is
   strad's to fix.
2. **Untested against a real phone.** CI drives both through `test/fake-socket.ts`.
   That a phone honours a placeholder resend for a message that decrypted fine
   is WhatsApp's behaviour; Baileys designed the call for undecryptable ones.
3. **Spent download links are an in-memory ledger.** One instance makes it the
   whole ledger; a restart forgets it, within the 15-minute expiry.
4. **The CDN transport is strad's.** Baileys 7.0.0-rc14's `downloadMediaMessage`
   pipes `fetched` into its decipher with no error listener on `fetched` (an
   uncaught exception in the bundle on a dropped connection) and gates its
   `reuploadRequest` on `error.status`, which its Boom never sets.
   `cdnMediaDownloader` in `socket.ts` uses Baileys' `getMediaKeys` and
   `getUrlFromDirectPath` with its own `fetch`, and checks the MAC and
   `fileEncSha256` Baileys does not.

**Undo.** 1–2 lapse once pre-change messages age out of the buffer (30 days by
default). 3 is the design while the component is single-instance. 4 reverts to
`downloadMediaMessage` when Baileys forwards source errors and tests
`output.statusCode`.

## 115. The Messages server reads chat.db through a helper granted Full Disk Access by hand, and is only as fresh as the Mac is awake

`hostd/messages/` is `strad-hostd-messages`, the native helper behind the
read-only `imessage-*` `local-tunnel` slug (`/messages/mcp` on strad-hostd;
`docs/servers/hostd.md`, `docs/servers/hostd-design.md`). It reads
`~/Library/Messages/chat.db`, which macOS guards with Full Disk Access. What
that costs:

1. **Full Disk Access is granted by hand, at the Mac.** There is no API that
   asks for it; the owner drags the helper into System Settings › Privacy &
   Security › Full Disk Access (`strad-hostd messages --grant` opens the list
   and shows the binary in Finder). It lands on the helper, not on `node`,
   only because the helper runs as its own LaunchAgent
   (`com.strad.hostd-messages`) and is signed with a stable identity under its
   own identifier. Reasoned from the responsible-process rule, as in #108; not
   yet observed on the owner's Mac.
2. **It is only as fresh as the Mac.** iMessage exists only on Apple hardware.
   A Mac that is asleep or off receives nothing, and the nightly sweep reads
   nothing new; with Messages in iCloud on, a Mac that wakes catches up and the
   ROWID cursor then picks up what arrived meanwhile. Without Messages in
   iCloud, what arrived while the Mac slept may never reach this database.
   Nothing in strad keeps the Mac awake.
3. **The socket is a Full Disk Access oracle for chat.db.** The helper's
   socket is mode 0600 and answers any process of the owner, and its `query`
   op runs any single read-only statement against chat.db — so a process
   running as the owner without Full Disk Access can read every message
   through it. It is narrower than the alternative (Full Disk Access on
   `node`, which would hand every file the grant reaches to every Node script
   and to the shell slug): the connection is `SQLITE_OPEN_READONLY`, ATTACH is
   denied so no database beyond chat.db and the Contacts files the helper
   enumerates itself is reachable, and attachments are read by id
   from chat.db, never by a caller's path, and only under the database's own
   directory. As in #108, two processes of one macOS user cannot keep secrets
   from each other; it is not a privilege boundary. The same socket reads the
   owner's Contacts databases the same way (below), so it is an oracle for
   those too.
4. **The unattended read is allowed on timeout.** `strad-hostd init` and
   `add messages` write `onTimeout: "allow"` on this one server, so a nightly
   sweep with nobody at the screen is granted after the dialog's window
   (`approved_by: "timeout"`). The machine-wide default stays `deny`. With
   nobody there, the dialog refuses nothing; what bounds the slug is its key,
   Cloudflare Access, its `admin`-only entitlement, the grant's notification
   and audit line, and the kill switch.
5. **The schema is Apple's and undocumented.** Every column beyond the stable
   few is looked up and read as NULL where missing; `attributedBody` is read
   with the deprecated `NSUnarchiver` behind an Objective-C `@try`, with a byte
   scan as fallback. A macOS release that moves the body elsewhere shows up as
   `text: null` on messages that have text.
6. **Contact names come from Contacts' own files, under the same grant.**
   `sender_name` and each participant's `name` are matched from the
   `AddressBook-v22.abcddb` files under
   `~/Library/Application Support/AddressBook` (the top-level one and each `Sources/<id>/`), read as
   SQLite under the Full Disk Access the helper already holds, not through
   Contacts.framework, which asks for a separate Contacts grant a LaunchAgent
   cannot answer unattended. That Full Disk Access reaches those files is
   documented by other tools that read them, not yet observed on the owner's
   Mac; `get_control_status` reports `helper.contacts`. The Core Data schema
   (`ZABCDRECORD`, `ZABCDPHONENUMBER`, `ZABCDEMAILADDRESS`) is Apple's and
   undocumented, like chat.db's. Numbers match on E.164, with the Mac's
   region supplying a missing country code, and fall back to the national
   number only for a contact number that is not valid in the Mac's region and
   that exactly one name claims. A short code is never named. The book is read once per ten
   minutes, so a contact added since then is unnamed until the next read. A
   book that cannot be read adds a `contacts_warning` and never fails the
   read of the messages: names are null if it has never been read, and the
   last read's if a re-read failed.

**Why it cannot be designed out.** 1 and 2 are #101's: the box is a personal
Mac. 3 and 6 are what reading a TCC-guarded file from a daemon costs on macOS.

**What stays off the box.** The slug, its entitlement and `recovery:` text
ship by deploy; the key is seeded at `/ui/secrets`; `get_control_status`
reports `helper: {running, full_disk_access, chat_db, contacts}`, and `request_control`
refuses with `helper_unavailable` before any dialog when the grant is missing.

**Undo.** 1 and 3 go if Apple ships a Messages API, which it has not. 2 goes
with an always-on Mac (a Mac mini signed in to the same Apple ID) running the
same install. 4 is the owner's setting: `"onTimeout": "deny"` on
`capabilities.messages` in `~/.strad-hostd/config.json`.

---

## 116. The LiveOak server speaks an unpublished wire, and holds a login that skips MFA

**What.** `servers/liveoak/` logs in to `secure.liveoak.bank`'s AWS Cognito pool
(`us-east-1_RDbe8eaw5`) through `amazon-cognito-identity-js`, the portal's own
client, and reads statements from `api.liveoak-production.apiture.com`
(`docs/servers/liveoak.md`). Both were read out of the portal's public bundle
(`main-es2015.*.js`): the `cognito:{poolId,appClientId}` block, the document
center's `getDocuments({category:["accountStatements","customerStatements"]})`
query, and `window.open(_links["apiture:document"].href)`.

1. **Untested against LiveOak.** CI runs the real client library against
   `test/fakes.ts`, which does the server half of SRP and device SRP, and a fake
   API. That proves the exchange against Cognito's protocol, not against
   LiveOak's pool settings (device tracking, challenge lifetime) or Apiture's
   response shapes beyond the three fields the portal reads.
2. **The remembered device is a credential.** `device-store.ts` seals the
   device key, group key and device password with
   `LIVEOAK_STATE_ENCRYPTION_KEY` into `{LIVEOAK_GCS_PREFIX}/device.sealed`.
   With the password they log in with no phone. No rotation path: a new key
   makes the object unreadable, and `enrol_device {"force":true}` re-enrols.
3. **The pending MFA challenge is process memory.** A deploy between
   `enrol_device` and `confirm_device` drops it.
4. **Spent download links are an in-memory ledger per instance**, the same
   bound as #114.
5. **Read-only is enforced by `apiture.ts`, not by the token**, whose scopes
   include `banking/write`. `test/server.test.ts` asserts every API request is a
   GET.
6. **A device confirmed but not stored is held in process memory.** Cognito
   confirms and remembers the device inside `sendMFACode`, before the GCS
   write, so a failed write cannot be ordered first. `enrol_device` probes the
   store before logging in, which makes this rare. When it happens anyway, the
   keys wait in memory for the next `enrol_device`, and a restart before that
   loses them and leaves an orphaned remembered device on the account.

**Undo.** 1 lapses with the first real enrolment and statement fetch in prod;
anything it finds is a fix here. 2 wants a key-rotation path. 3, 4 and 6 are
the design while the bundle runs one instance. 5 is the design for as long as
LiveOak issues one token for everything.

## 117. gmail attachments: `content_base64` is capped by core's body limit, and a URL's host is checked before the fetch, not by it

**What.** `vendor/gmail-shared` in `images/bundle-google` is a fork
(`images/bundle-google/vendor/gmail-shared/FORK.md`), and its first delta gives
`send_email` and `upsert_draft_email` an `attachments` array: an HTTPS `url`
the server downloads, or `content_base64`. Up to 10 files, 17 MB decoded.

1. **`content_base64` is bounded at about 3 MB, not 17.** Core parses `/mcp`
   with `express.json({ limit: "4mb" })` (`src/http/app.ts`), and base64 inside
   JSON costs 4/3. A larger inline file is a `413` at core, before the bundle
   sees it. `url` has no such bound, and it is the route for anything sizeable:
   upload to the artifact store, pass the signed link.
2. **The private-address check runs before the fetch, not inside it.** Every
   hop is refused if its host is a private literal (loopback, RFC 1918, CGNAT,
   link-local, and the IPv6 forms that carry them), `localhost`, `*.internal`,
   or a name ANY of whose resolved addresses is private. The fetch then
   resolves the name again, so a name whose answer changes between the two
   lookups (DNS rebinding) is not caught. It matters more here than for a
   plain fetch: `upsert_draft_email` needs no confirmation, and
   `download_email_attachments` reads a draft's files back, so a fetched body
   is readable by the caller. `strad-fetch` checks at the connector
   (#79); this tree does not.
3. **Resolution counts against the confirmation window.** `send_email`
   downloads its attachments before it asks the human (so the prompt lists
   what will be sent), within one 60-second budget for every download, and
   that time comes out of the same deadline the human answers in.
4. **It is a fork.** A re-vendor from `pulsemcp/mcp-servers` reverts it with no
   failing build, only the attachment tests failing.

**Undo.** 1 goes if core's `/mcp` body limit is raised past 25 MB, a decision
about every slug and not this one. 2 goes with a fetch whose connector checks
the address it actually connects to, as `strad-fetch`'s does. 3 and 4 are the
design: strad's servers improve here.

## 118. 1Password asks the calling session, and what that leaves out

**What.** The 1Password mounts in the bundle put every reveal
(`onepassword_get_item` on an item with a sensitive field, and
`onepassword_share_item`) and every create to the human attached to the session
that made the call, through the `confirmations: true` channel gmail's
`send_email` uses (`servers/onepassword/remote/src/confirm.ts`, docs
`servers/confirmations.md`). `DANGEROUSLY_SKIP_ELICITATIONS` is stripped from the
process on every call, and one slug's own `<SLUG>__OP_ELICITATION_WRITE=false`
lets its creates, never its reveals or shares, run unasked. Each slug with its
own token on `path: /<slug>` is its own mount. What that costs, stated:

1. **The console and `admin` tokens cannot see a password.** Neither has a
   prompt surface, so a reveal is refused; metadata and the listings still work.
   Staging lists no `gateway.elicitation.allowedUrlPrefixes`, so nothing reveals
   there at all.
2. **The approval protocol client exists twice**: gmail's
   `images/bundle-google/src/confirm.ts` and this one. They are separate npm
   trees and Docker contexts, and gmail's was being changed by tadasant/strad#407
   at the same time, so this one is a port rather than an extraction. A fix to
   one (a redirect rule, the deadline margin) has to reach the other by hand.
3. **No whitelist and no read posture.** `OP_WHITELISTED_ITEMS` and
   `OP_ELICITATION_READ` are removed rather than honoured: the vendored tool
   reads them from a process every 1Password mount shares, so either would
   apply to every account at once.
4. **The `onepassword://config` resource reports what the vendored tool is
   told**, which is "ask about writes" on every mount, including a provisioning
   one whose writes are answered inside the bundle, and whether the BARE token
   is set rather than the mount's own.
5. **"Sensitive" is the vendored tool's heuristic.** A field is gated if its
   type is concealed or its label mentions a password, secret, token, key,
   credential, CVV or PIN. A secure note's body is none of those, so
   `onepassword_get_item` and `onepassword_get_item_metadata` return it unasked.
6. **The provisioning posture asks before a share**, which the npx
   `1password-pulsemcp-provisioning` entry did not: a share link reveals an
   existing item to whoever opens it, so no posture skips it. An unattended
   mint-store-share pass now stops once, at the share.
7. **A per-slug token's keys are written already per-slug**
   (`ONEPASSWORD_TADAS_ALL__OP_SERVICE_ACCOUNT_TOKEN`), because the schema's
   env-collision check refuses one bare name with two values on a bundle even
   when each slug is its own instance. The renderer then emits a doubled alias
   the host ignores. `grafana-obs` in prod does the same.

**Undo.** 1 is a console prompt that answers the protocol (#113 has the same
item). 2 is one module vendored to both trees through `scripts/sync-vendored.mjs`
once #407 has landed. 3 would need the vendored tool to take its posture per
mount rather than from `process.env`, which is an upstream change, and so is 5
(count a note's body as sensitive). 6 is the design. 7 is relaxing the schema
check for own-path slugs, which the renderer already polices.

## 119. airtable, flightaware and digitalocean have met only fakes, and one of them replaces a package that never existed

**What.** `servers/airtable/`, `servers/flightaware/` and `servers/digitalocean/`
are strad's own servers over three HTTPS APIs, one static key each. They replace
three npx entries in the Zimmer catalog (`airtable-mcp-server@1.13.0`,
`flightaware-mcp-server@latest`, `@digitalocean/mcp@1.0.51`).

1. **Untested against the real APIs.** Each tree's suite drives a real MCP
   client against an injected fake `fetch` in the upstream's documented shapes.
   Request and error shapes, pagination metadata, AeroAPI's billing of
   `max_pages` and DigitalOcean's log-link flow come from published references,
   not observed traffic.
2. **`flightaware-mcp-server` is not on npm** (the registry answers 404), so the
   catalog entry it replaces never started and there was no surface to match.
   The eight tools were designed from the catalog's description and the AeroAPI
   v4 OpenAPI document.
3. **DigitalOcean covers droplets, apps and databases, not the rest.** The npx
   binary serves about two hundred tools across eighteen services; this serves
   twenty-nine. DigitalOcean's own hosted remote servers
   (`https://<service>.mcp.digitalocean.com/mcp`) are the route to the rest, as a
   `remote-http` slug.
4. **DigitalOcean's redaction is by name pattern.** Database passwords, keys,
   tokens, secret-named app env values, URI userinfo and credential query
   parameters are stripped from every result by key-name pattern and by URI shape
   (`servers/digitalocean/shared/src/secrets.ts`), and a spec carrying the
   `[redacted]` marker is refused rather than written back. A credential
   DigitalOcean returns under a name the pattern does not match passes through
   until it is added there. A token without `database:view_credentials` is the
   second fence.

5. **DigitalOcean's log host is assumed.** `apps-get-logs` fetches log links only
   from hosts ending `.digitaloceanspaces.com` or `.digitalocean.com`, with no
   redirects. DigitalOcean does not document the host, so a link elsewhere fails
   naming it.

**Undo.** 1 and 5 lapse with the first real call on each slug; anything they
find is a fix here. 2 and 3 are the design. 4 goes if DigitalOcean ever returns
credentials only to a scope the token can be denied, which it does not today.

## 120. image-diff and svg-tracer read URLs, not files, and run one job at a time per bundle

**What.** `servers/image-tools` is strad's own image-diff and svg-tracer, which
replace the `@pulsemcp/image-diff-mcp-server` and
`@pulsemcp/svg-tracer-mcp-server` npx packages. Those read a path off the
agent's disk and wrote their outputs back to it. A mount in the bundle can do
neither, so:

1. **Inputs are http(s) URLs on the public internet.** A local file has to be
   uploaded first (the artifact store's `upload_file`) and its signed link
   passed. The fetch refuses private, loopback, link-local and metadata
   addresses at the connector, every redirect hop included (the same guard as
   `strad-fetch`, #79), so an image on a private network or behind a VPN
   cannot be compared at all. `IMAGE_TOOLS_ALLOW_PRIVATE_HOSTS` names hosts to
   let through, for a development gateway; it is empty everywhere.
2. **Outputs come back inline, not as files.** The heatmap and composite are
   PNG image content, downscaled to 1568px on the long edge (`scale` says by
   how much; cluster boxes stay in full-resolution pixels). The SVG is a string
   in the JSON, refused past 1M characters. Nothing is uploaded, so there is no
   URL to hand on: an agent that wants a link uploads the result itself.
3. **Bounded hard.** 25MB and 10 megapixels per image (a 2x-DPR full-page
   screenshot is over that and must be cropped or downscaled first), 30s per
   fetch, 60s per job. The job runs in a worker thread that is terminated at
   its deadline, so a slow trace stops costing CPU when it stops being waited
   for.
4. **One job at a time across both mounts, per bundle process.** A diff at the
   pixel limit holds ~400MB and the container is shared with Chromium. Up to
   two more callers wait, up to 20s each, and are then refused as busy; a third
   is refused at once, because a waiting caller already holds its fetched
   bytes. Fetch, wait and job sum to 110s, under core's 120s default
   `timeoutMs`. A cancelled call leaves the queue or has its worker stopped.
   Under concurrent use from several sessions that is a real queue, and it is
   per instance.

**Undo.** 1 is the design for a remote server; a flow-through grant onto the
artifact store could let the tools accept an upload id as well as a URL. 2
could return a signed link through the same grant. 3 and 4 move with the
bundle's size: a larger instance, or these mounts on their own component,
raises both.

## 121. gmail reflows a plain-text body it judges hard-wrapped, by a heuristic, and sends HTML beside it

**What.** `vendor/gmail-shared` in `images/bundle-google` is a fork, and its
third delta (`FORK.md` §3) rewrites the `plaintext_body` of `send_email` and
`upsert_draft_email` before it is sent. Agents hard-wrap prose at 72-80
columns, and a `text/plain` part shows each of those newlines as a hard break,
so on a phone every paragraph came out as alternating long and two-word lines.
The fork joins those lines back into paragraphs and sends every text part
`quoted-printable`. Which newlines were "soft" is a guess:

1. **A line is joined onto the one before only when that one looks cut by a
   wrap.** It is at least 40 characters, its block's widest line is between 50
   and 100 (a wrap width), and the next line's first word would not have fit
   after it, and it does not end in a colon. Blank lines, list items, `>`
   quotes, headings, `|` table rows, rules, bare URLs, label rows
   (`Status: merged`), short lines ending in a comma (`Best regards,`),
   `P.S.` lines, indented lines outside a list and fenced code are never
   joined, and nothing below a `-- ` signature separator is touched. A block
   with no line past 50, or any line past 100, is left alone.
2. **So a short line that matches none of those, written directly under a
   long line, can be pulled into it.** A name alone on a line under a
   paragraph whose last line is long is joined onto that line. A blank line
   above it keeps it, and so does any line short enough that its first word
   would have fit.
3. **There is no opt-out.** A caller that needs every newline kept as written
   (a poem, an ASCII diagram not indented) sends `html_body`, or indents it.
4. **It is a fork.** A re-vendor from `pulsemcp/mcp-servers` drops
   `body-text.ts` and puts the raw body back on the wire, with only
   `images/bundle-google/test/gmail-body-text.test.ts` failing.
5. **A `plaintext_body` sent alone carries an HTML part the caller did not
   write.** Gmail breaks a `text/plain`-only message at about 70 columns when
   it shows it, and ignores `format=flowed`, so a reflowed paragraph still
   arrived broken. The fork adds `plainTextToHtml` of the reflowed text as the
   `text/html` alternative, and every HTML-capable client shows that instead:
   escaped text, a `<br>` per line break, bare URLs linked by their own text.
   It is a rendering, not a rewrite, so it cannot give a link anchor text; the
   tool descriptions ask callers for an `html_body` when there are links.

**Undo.** 1 and 2 go if every caller writes each paragraph as one line, which
the tool descriptions ask for, and a reflow is no longer needed. 3 is a
`preserve_line_breaks` argument, if a caller ever needs it. 5 goes when
Gmail lays out `text/plain` at the reader's width, or when every caller sends
its own `html_body`.

## 122. nutrition-facts ships its data in the image, and calls FatSecret only through a proxy

**What.** `servers/nutrition-facts` answers from two local datasets and one live
API, and each has an edge:

1. **The local data is fixed at image build time.** The bundle Dockerfile's
   `nutrition-facts` stage downloads USDA FDC's Foundation, SR Legacy and FNDDS
   releases and NYC Open Data's MenuStat CSV, each pinned by SHA-256 in
   `shared/src/data/sources.ts`, and bakes ~2 MB of gzipped JSON into the image.
   A newer USDA release reaches production only through a PR that changes the
   pin. A download that changes under its URL fails the bundle build by name —
   a public host this repo does not control can therefore red a bundle build;
   the fix is reviewing the new file and updating the digest. MenuStat's pin is
   the likeliest to trip: it is a SHA over a Socrata `rows.csv` export, which
   is generated on request rather than stored, so a change in how NYC Open Data
   renders the same rows would change the bytes. Mirroring the file to a bucket
   strad controls would remove that exposure.
2. **USDA Branded is not local.** Its 449 MB release would add hundreds of MB to
   every bundle pull and an index the bundle could not hold beside Chromium. It
   is read live from the FDC API, with an optional `USDA_FDC_API_KEY`, and only
   for a named brand. Without the key, brand lookups rely on FatSecret.
3. **MenuStat stops at 2018.** It is the last data year MenuStat collected; newer
   menu items are missing and older ones may have changed. FatSecret's current
   menus are the counterweight, and a near-tie goes to FatSecret.
4. **FatSecret's caches and quota counter are per process.** The bundle has no
   shared store, so a restart or a second instance starts both from zero. The
   counter stops at 4,500 of the 5,000 daily calls to leave that margin; it
   cannot guarantee it.
5. **FatSecret is called only through `FATSECRET_PROXY_URL`.** A FatSecret key
   answers only IPs allowlisted by hand in the FatSecret Platform console
   (single addresses on Basic), and strad's App Platform components have no
   fixed egress IP. Every FatSecret request — the OAuth token POST and every
   API call — goes through a forward proxy with dedicated exit IPs (a
   BrightData dedicated-IP zone, via undici's `ProxyAgent`), and those IPs are
   the allowlist. Not Web Unlocker: it rotates exits and only carries GETs.
   There is no direct fallback; without the variable FatSecret is not called.
   The allowlist entry is a human step in a vendor console, once per IP, and
   the proxy is a dependency whose outage is FatSecret's.

**Undo.** 1 is the design: data that changes yearly is a reviewed PR, not a
runtime download. 2 goes if the bundle gets a larger instance or a disk, and
Branded is baked as a SQLite index. 4 needs a shared store (none exists). 5
goes only if FatSecret stops checking caller IPs; the console step is the
vendor's, and is recorded in `docs/servers/nutrition-facts`.

## 123. gmail returns the headers that say who sent a message, and leaves the verdict to the reader

**What.** `vendor/gmail-shared` in `images/bundle-google` is a fork, and its
fourth delta (`FORK.md` §4) makes `get_email_conversation` return every
`Received`, `Authentication-Results`, `ARC-Authentication-Results`, `Received-SPF`,
`DKIM-Signature`, `From`, `Sender`, `Reply-To`, `Return-Path`, `Message-ID`,
`In-Reply-To`, `References`, `Auto-Submitted` and `List-Id`, verbatim, each
with its position in the message, and the names a message lacks as `absent`.
`From:` is text the sender wrote, and neither tadasant.com (no DMARC record)
nor gmail.com (`p=none`) makes Gmail refuse a forged one, so these headers are
the only evidence of who sent a message. What they cannot do on their own:

1. **The server reports, it does not judge.** It does not parse an
   authserv-id or pick a verdict. The reader takes the TOPMOST
   `Authentication-Results` (the lowest `index`), checks that its first token
   is the receiving server (`mx.google.com`), and reads `dkim=` / `dmarc=`
   there. Any lower one may have been written by the sender, and a reader that
   searches for the first `dmarc=pass` anywhere in the list is fooled by it.
2. **"Topmost is the receiving server's" holds only when the receiving server
   wrote one.** Mail between two accounts of one Google Workspace may be
   delivered inside Google without passing mx.google.com's inbound checks, and
   may carry no `Authentication-Results` of Google's. That has not been
   checked on a live message. If so, real internal mail lists the header under
   `absent`, which fails safe, but only when the sender wrote none either.
   A sender inside the Workspace who writes
   `Authentication-Results: mx.google.com; dkim=pass; dmarc=pass` makes that
   forged one the topmost, and position alone cannot tell it from Google's.
   `Received` is returned so the reader can: Google's sits directly under the `Received` in which
   mx.google.com accepted the message from the outside hop, with no
   sender-written header above it. A reader that cannot place it there treats
   the message as unverified.
3. **A forwarded or list-relayed message is judged at its last hop.** The top
   `Authentication-Results` is about the forwarder or the list, and the
   original sender's result is only in the ARC chain, which nothing here
   validates.
4. **It is a fork.** A re-vendor from `pulsemcp/mcp-servers` drops
   `sender-verification.ts` and the section, with only
   `images/bundle-google/test/gmail-sender-verification.test.ts` failing.

**Undo.** 2 is answered by reading one same-domain message's headers in a real
mailbox. If they lack Google's header, internal mail needs another signal, and
that belongs in the reader, not here.

## 124. google-drive runs only on its own, and has met only fakes

**What.** `images/bundle-google/vendor/google-drive-shared` is strad's own Google
Drive MCP server, in three tiers. `readonly` is `search_files`, `get_file` and
`read_file` on `drive.readonly`. `readwrite` adds `create_folder` and
`create_file` on `drive.file`. `full` adds `update_file_metadata`,
`move_file`, `copy_file`, `trash_file` and `restore_file` on the full `drive`
scope. It is built into both the bundle-google image and the bundle image, and
**neither one mounts it**. No environment declares a slug for it, so the only
way to run it is the standalone entrypoint, `dist/standalone/google-drive.js`,
described in that tree's README.
Its suite runs against a faked `fetch` and a fake client. No request has reached
Google.

`readwrite` stays create-only so that it can stay on `drive.file`, which cannot
touch a file a human made. Renaming, moving or trashing those files needs
`drive`, so those tools are a tier of their own rather than an addition to
`readwrite`. Permanent delete and sharing are in no tier, and neither is
overwriting a file's content: Drive can only replace a whole file, and a Google
Doc rebuilt that way from Markdown loses its formatting. Editing a document in
place is a job for a Google Docs server, not this one.

Three claims the first live call settles:

1. Drive's `text/markdown` export of a Google Doc is what `read_file` returns by
   default. The format is documented, and the output has not been looked at.
2. A `drive.file` token can create inside a folder that `create_folder` made,
   and is refused in a folder made by hand. The error hints assume Drive refuses
   with a 403 `insufficientFilePermissions` or `appNotAuthorizedToFile`, or with
   a 404. The `full` tools on a `drive.file` token are assumed to be refused the
   same way on a file this client did not create.
3. A multipart upload whose metadata names a Google type and whose media is
   text, Markdown or HTML converts into a Doc, and CSV or TSV into a Sheet.
   Other pairings are refused before the call. Slides are not offered, since
   Drive builds a deck only from a .pptx or .odp.

**Undo.** Mount it in the bundle host, which means a per-slug OAuth mount like
google-sheets, a `google-drive-*` slug, the console's Connect flow for its
scopes, and the counts in `servers/bundle/scripts/smoke.mjs`. The first real
calls through that slug settle 1 to 3.

## 125. google-calendar has a personal OAuth mode that strad added to a vendored tree

**What.** `images/bundle-google/vendor/google-calendar-shared` is a copy of
`pulsemcp/mcp-servers`' `experimental/google-calendar/shared`, and upstream
signs in only as a service account with domain-wide delegation, which cannot
reach a personal `@gmail.com` calendar. strad adds a second mode to its copy.
`GOOGLE_CALENDAR_AUTH_MODE=oauth` signs in as one account with
`GOOGLE_CALENDAR_OAUTH_CLIENT_ID`, `_CLIENT_SECRET` and `_REFRESH_TOKEN`.
Unset, or `service_account`, keeps the service account, so no existing
deployment changes. The tree is a PATCHED VENDOR, and its README's delta table
lists the change.

Five things about it are not obvious:

1. **The mode is named, not inferred.** gmail and google-docs pick OAuth when
   its three variables are complete and fall back to a service account
   otherwise. Calendar does neither. A stray OAuth variable on a
   service-account deployment changes nothing, and an `oauth` deployment
   missing its token fails naming it rather than quietly using the service
   account. An unknown value fails every call, and the standalone entrypoint
   refuses to start on one.
2. **The vendored error text is reworded, not edited.** `api-errors.ts` words a
   401 and a 403 for a service account ("verify domain-wide delegation"). The
   OAuth client matches those two messages by their opening words and replaces
   them, so the vendored file stays as upstream wrote it. If upstream rewords
   them, the OAuth mode shows the service-account wording again. The 401
   still reaches the client as an error, but its token cache is no longer
   dropped, so a token Google rejected before its expiry is reused until it
   expires.
3. **The account's address comes from its primary calendar.** A service
   account is told which user it acts as. A refresh token is not, so the OAuth
   client reads `calendars/primary` once for the `&authuser=` on event links. A
   failed read means links without `authuser`, retried after five minutes.
4. **An unknown mode is a boot failure only standalone.** The standalone
   entrypoint exits 2 on one. Inside a strad bundle the server still boots and
   lists its tools, and every call fails naming `GOOGLE_CALENDAR_AUTH_MODE`.
   Neither bundle host checks the variable at boot.
5. **The refresh token is minted and rotated by hand.** gmail and google-docs
   OAuth mounts get theirs from the console's Connect Google flow
   (`src/connectors/`). Calendar has no connector, so an `oauth` deployment's
   token comes from a consent flow run outside strad (the tree's README uses
   the OAuth Playground), and is replaced by hand when it dies. A consent
   screen in Testing mode kills it every 7 days. That is a routine step outside
   any deploy, which the operability rule in `AGENTS.md` names a defect, and it
   is why no deployment sets the mode yet.

Both hosts, this image's `src/index.ts` and the collapsed bundle's host, mount
the server with no client factory, so they read the mode from `process.env`
with no change of their own. No deployment sets the mode yet, and no request in
either mode has reached Google from CI.

**Undo.** Point 5 is undone by giving calendar a connector, the way gmail and
google-docs have one: a per-slug OAuth mount the console's Connect flow seeds.
If upstream gains an OAuth mode, re-vendor and drop the delta, then map
`GOOGLE_CALENDAR_AUTH_MODE` onto whatever upstream reads. Until then, a
re-vendor has to re-apply the row in the tree's README, and
`images/bundle-google/test/calendar-auth-mode.test.ts` fails if it does not.

---

## 126. good-eggs nutrition comes from Good Eggs Kitchen's help-center tables, and only covers those

**What.** `get_grocery_nutrition` reads `storeData.productDetails` off the
product page for the product's name, producer, retail units and photos. When the
producer is `goodeggskitchen` it also reads the Good Eggs Kitchen nutrition
section through Zendesk's public Help Center API
(`help.goodeggs.com/api/v2/help_center/en-us/sections/360007686892/articles.json`),
parses the per-category HTML tables, and matches the product to a row by its
whole folded name, split by retail units when one name has several sizes. Every
other product gets `nutrition.status: not_published` and its photo URLs.
`servers/good-eggs/FORK.md` #12 has the evidence.

**Why.** Good Eggs exposes nutrition nowhere else. The product payload, the
page's markup and the product page's own JavaScript carry no nutrition fields.
The bundle's only nutrition reference is the "View Nutritional Information"
link it renders for `goodeggskitchen` products, and that link is this section.
Each product has one or two photos, and the ones checked were front of pack or
plated food, not a Nutrition Facts panel. The tables are the only structured
source, and they lag the catalog. On 2026-10-15, 3 of the 15 kitchen products on
the producer page had a row. Most articles were last edited in 2020–2022. One
product, Achiote Marinade 2 oz, appears in two articles with different values
(70 kcal and 140 kcal).

**Undo.** If Good Eggs starts publishing nutrition on the product payload, read
it from there and drop the help-center read. Until then a caller that needs
macros for a `not_published` or `not_in_kitchen_tables` product takes the
producer, name and retail units to a nutrition database, or reads the label off
a photo when one shows it.

---

## 127. The console masks a value field with CSS, not with a password input

**What.** Every field on the parameters console that takes a value is a
`<textarea>` with `-webkit-text-security: disc`: the create form, each row's
Rotate field, and the bulk editor's Rows view (`src/ui/render.ts`). A browser
without that property shows the value as it is typed. The fields carry
`spellcheck="false"` and Grammarly's opt-out attributes, but an extension that
ignores those can still read a textarea, where it would have skipped a password
input. A value with no line break except at the end has that trailing line break
dropped (`src/ui/index.ts`). A multi-line value is stored exactly as pasted.

**Why.** A browser strips line breaks from an `<input type="password">`, so a
pasted PEM key was stored as one line that no key parser accepts. Zimmer's APNs
key spent twelve days like that. No input element is both masked and
multi-line. The trailing-newline rule keeps the old field's behaviour for a
one-line token: Enter in a textarea adds a line break where it used to submit,
and a terminal copy often ends in one.

**Undo.** If browsers ship a masked multi-line input, use it. Until then, a
deployment that needs masking in every browser can fall back to a password input
for values known to be one line, at the cost of the PEM case.

---

## 128. good-eggs adds through Good Eggs' undocumented basket endpoint, measured live only against an anonymous basket

**What.** `add_to_cart` sends `POST /api/basket/update-item` with
`{ productId, quantity, shouldSubscribe: false }` from inside the product page.
That is the request the page's own "Add to basket" button sends. The button is
kept as the fallback after a definite refusal. `quantity` is the line's new
total, so the update is sent only when the prior total is known and below the
request. An unknown prior total means no add at all.
`servers/good-eggs/FORK.md` #13 has the evidence.

**Why.** Clicking a drawn button failed about two adds in three during the
2026-10-19 shop ([strad#439](https://github.com/tadasant/strad/issues/439)),
because the button was not found visible in time. The request does not depend on
the page drawing. It is read out of the site's own traffic, and Good Eggs
publishes no API. The endpoint, its total-not-increment meaning and its answer
shapes were measured on 2026-10-19 against an anonymous basket. No live
signed-in account was used, because nothing in this repo may write to the
household's real basket to test it.

**Undo.** Nothing to undo while Good Eggs serves the endpoint. If it moves or
changes shape, a non-2xx answer reports `Good Eggs refused the basket update …`
and falls back to the button, which is the old behaviour. A 2xx in a shape this
code cannot read is not followed by the button, because it may have applied. The
basket re-read reports what landed. Re-read the button's
request from the browser's network panel and update `BASKET_UPDATE_PATH` and
`parseBasketUpdateResponse()`.

**The same update, for a product Good Eggs will not sell.** For a product sold
out or unavailable on the basket's day, Good Eggs answers the update with a 2xx
naming the product and then leaves the line out of the basket (measured
2026-11-02, six times in one shop). So `add_to_cart` reads the product's
`availabilitiesByDay` from the page payload first. A product listed as `soldout`
or `unavailable` for `currentFulfillmentDay` gets no request and a failure that
says which. A missing record, or any other status, means the add is sent and
the basket re-read decides.
`servers/good-eggs/FORK.md` #14 has the evidence. If Good Eggs renames the field,
the check reads as unknown and the answer is the basket re-read's: "does not
appear in your cart afterward".

---

## 129. google-docs reads every tab, a strad delta on a vendored tree

**What.** `images/bundle-google/vendor/google-docs-shared` is a copy of
`pulsemcp/mcp-servers`' `experimental/google-docs/shared`, and upstream calls
`documents.get` without `includeTabsContent`. Without that flag the Docs API
returns only the first tab's content, in the top-level `body`, and nothing
says other tabs exist. Every read tool saw one tab and called it the document.
strad's copy asks for every tab. `get_document` and `get_document_outline`
walk the tab tree, nested child tabs included, and each takes an optional
`tab_id`. A `?tab=` in a pasted URL is deliberately NOT read: Docs puts
`?tab=t.0` on nearly every URL, single-tab documents included, so honouring it
would read the first tab alone again. The tree
is a PATCHED VENDOR, and its README's delta table lists the change.

Four things about it are not obvious:

1. **A single-tab document is unchanged.** One tab is read the way a document
   fetched without the flag is: its content is lifted back to the top level,
   so `format=json` keeps `body`, `lists`, `namedStyles` and the rest there,
   and the text output has no tab sections. The text is identical; the JSON
   has the same fields and values, though its key order can differ from
   Google's own legacy response. A test compares the two directly.
2. **A multi-tab `format=json` changes shape.** With no `tab_id` it is the
   full resource, and the content is under `tabs[].documentTab.body` with no
   top-level `body`. A caller that read `body` off a multi-tab document was
   reading the first tab alone. With a `tab_id` it is that tab with its
   `body` at the top level and its `tabProperties` beside it.
3. **A write with no tab still goes to the first tab.** `append_text` with no
   `tab_id` fetches without the flag, so its end index is the first tab's, which
   is where a `batchUpdate` request with no `tabId` lands. `update_document`'s
   description says how to target another tab, and the wrappers take a `tab_id`
   (#136).
4. **Export is not per tab.** Drive's `files.export` has no tab parameter, so
   `export_document` exports whatever Drive gives for the whole document, and
   its description points at `get_document` with `tab_id` for one tab. What
   Drive puts in an export of a multi-tab document has not been measured.

No request with the flag has reached Google from CI. The tests fake the Docs
API, and answer the way its reference says: the first tab alone without the
flag, every tab with it.

**Undo.** If upstream starts reading tabs, re-vendor and drop the delta. Until
then a re-vendor has to re-apply the row in the tree's README, and
`images/bundle-google/test/docs-tabs.test.ts` and the tab tests in
`images/bundle-google/test/standalone.test.ts` fail if it does not.

## 130. gmail's `delete_draft_email` deletes permanently, and asks nobody

**What.** `delete_draft_email` (`images/bundle-google/vendor/gmail-shared`,
`FORK.md` delta 5) sends Gmail's `users.drafts.delete`, which removes the
draft for good: it is not moved to Trash and cannot be restored. The tool is
on the `-rw` and `-rw-external` tiers and is not a confirmed tool, so an agent
on either tier can delete any draft in the mailbox, including one a person
wrote and meant to keep, and no human is asked.

**Why.** It is a draft mutation, not a send. `upsert_draft_email`, on the same
tiers and also unconfirmed, can already replace a draft's whole content, which
loses it just as surely. Asking a human for every discard would put a prompt
in front of the clean-up the tool exists for: an agent removing a draft it
superseded so nobody sends the wrong one.

**What bounds it.** One draft per call, by ID. The draft is read first and a
non-draft ID is refused, so no message or thread is touched, and every draft
call refuses an ID that is not draft-shaped before it builds a URL. The answer
names the draft's recipient and subject.

**Undo.** Add `delete_draft_email` to `CONFIRMED_TOOLS` in
`images/bundle-google/src/confirm.ts` and make the tool call
`requestConfirmation()`, if a deleted draft someone wanted ever turns up.
Withhold the tool from a slug with its `tools: allow` list in the meantime.

## 131. MCP Events tracks a draft SEP, in poll mode only, and the Slack feed has met only fakes

**What.** strad serves MCP Events (`events/list`, `events/poll`, the
`io.modelcontextprotocol/events` extension) from draft SEP-3415, pinned at
commit `b08e4f9dd684f39d846d94089487fbeb28e666f5` in
`docs/mcp-events-spec-pin.md`. Only poll mode is built: no `events/stream`, no
webhooks, no `list_changed`, no `server/discover`. The error codes (`-32023`,
`-32024`) are the draft's provisional numbers. The `Mcp-Method` / `Mcp-Name`
headers are accepted and not checked. Results carry no `resultType`.

The one event source is Slack's `message_posted`
(`servers/bundle-api/fork/slack/src/events/`): one Socket Mode socket, a sealed
7-day ring buffer in GCS and a lease, the WhatsApp bridge's pattern. The socket,
the envelope ack, the backfill and GCS have met fakes only. Nothing in CI has
held a real Socket Mode connection, and no deployment has seeded
`SLACK_APP_TOKEN` yet.

**Why.** Zimmer's deterministic triggers want a feed of Slack messages from the
server strad already runs, rather than a second Slack client polling with its
own copy of the bot token. Poll is the one mode Zimmer can consume with no
public ingress.

**What it costs.**

- A change to the draft can break the wire. Re-read the live SEP against the
  pin before changing anything here.
- Backfill sees a thread reply in a gap only if the thread's parent is less than
  48 hours older than the gap, and each read stops at 10 pages of 200. A read cut
  short is counted on `slack_events_status` as `reads_cut_short`.
- The buffer is one object, rewritten at most every couple of seconds. Events
  buffered since the last write are lost if the process dies; the next
  connection's backfill recovers what Slack still returns.
- A superseded process answers polls from the owner's persisted buffer, which
  lags the owner's memory by up to one flush (a couple of seconds).
- Making the GCS bucket and the service account that writes it is a one-off
  step by hand in GCP, outside any deploy, as it is for the WhatsApp bridge.
  Seeding the six variables is done through the console and a deploy. The
  bucket is the one step an agent cannot do without project IAM.
- The single-instance rule is enforced by the lease, not by the renderer.
  `SINGLE_SOCKET_PATHS` names `/whatsapp` and not `/slack`, because the shared
  bundle serves `/slack` with no app token and must stay free to scale.
- `tools:` policy does not narrow events. A `-readonly` slug on the same mount
  as one with an app token would see the same events.

**Undo.** Unseed `SLACK_APP_TOKEN`: the mount goes inert, lists no event types
and stops advertising the extension. Removing the feature is deleting
`src/gateway/events.ts`, its hooks in `mcpServer.ts`, `router.ts` and the HTTP
adapter, and `fork/slack/src/events/`.

## 132. google-docs adds and answers comments, a strad delta on a vendored tree

**What.** `add_comment` and `reply_to_comment` are strad's additions to
`images/bundle-google/vendor/google-docs-shared`, a PATCHED VENDOR (#129). They
call Drive's `comments.create` and `replies.create`. Both are in the
`readwrite` group, so a `-ro` slug never lists them and a `-rw` slug lists them
beside `update_document`. They write as the mount's account, which is the
author Docs shows.

Three things about them are not obvious:

1. **Drive cannot attach a comment to text.** Google Docs does not honour an
   `anchor` sent to Drive's `comments.create`, so a comment made there shows in
   the comments panel and highlights nothing. `add_comment` sends no anchor,
   and uses this path only for a comment on the document as a whole. A comment
   on a passage is the Docs API's `insertComment`, #135.
2. **Resolving is a reply.** Drive has no "resolve" call. A reply carrying
   `action: resolve` (or `reopen`) is how the editor does it, so
   `reply_to_comment` takes `resolve: true | false` and may be sent with no
   text.
3. **Google sends the notifications.** A comment or reply may notify people
   who already have access to the document, per their own Docs notification
   settings, as one made in the editor does. Neither tool grants anyone access,
   which is why both sit on `-rw` beside the other edits and not on
   `-rw-external` with `share_document`.

No scope changed: the read-write tiers already consent the full `drive` scope,
which covers both calls. No request has reached Google from CI. The tests fake
the Drive API, against the shapes its reference documents.

**Undo.** If upstream gains comment writes, re-vendor and drop the delta. Until
then a re-vendor has to re-apply the row in the tree's README, and
`images/bundle-google/test/docs-comments.test.ts` and the comment tests in
`images/bundle-google/test/standalone.test.ts` fail if it does not.

## 133. The bundle restarts itself when its event loop wedges, and its heap size is a rule of thumb

**What.** On 2026-11-02 prod's bundle (tadasant/strad#458) ran with its V8 heap
pinned at the ceiling, heap used 537 MB of a 548 MB heap total, while the
garbage collector ran back to back and event-loop utilization sat at 1.0 for
over an hour. The process stayed alive, so nothing restarted it, and 66 slugs
were unreachable until a human did. Three changes:

1. `servers/bundle/host/src/watchdog.ts` samples event-loop utilization every
   5 seconds. After 60 seconds at or above 0.9, `/healthz` answers 503. After
   180 seconds (`STRAD_BUNDLE_WATCHDOG_EXIT_SECONDS`) the host closes its mounts,
   with the same 5-second bound SIGTERM gets, and exits 1 so App Platform
   restarts the container.
2. The renderer gives a `strad-bundle` component a `liveness_health_check` on
   `/healthz` (period 10s, timeout 5s, 12 failures, 120s initial delay). This
   catches what the watchdog cannot: a loop blocked by one synchronous call
   never runs the watchdog's timer.
3. The renderer starts a `strad-bundle` component with
   `NODE_OPTIONS=--max-old-space-size=` half the plan's memory.

The incident's container memory read 2.50 GB, and cgroup usage cannot exceed
the cgroup's `memory.max`, so the container really had more than 1 GiB. That
is why a 1024 MB heap on the 2 GB plan is not expected to turn the thrash into
repeated OOM kills.

**Why it is a hack.**

- **The heap figure is a rule of thumb, not a measurement.** The other half of
  the plan is left for Chromium (about 545 MB at peak), mcp-grafana and Node's
  off-heap memory. If it is wrong, the kernel OOM-kills the container, and the
  container restarts. That is the outcome we want instead of thrashing, but it
  is still a restart.
- **Why Node picked a 1 GiB-sized ceiling on a 2 GB plan is not established.**
  Node 24 under a 1 GiB cgroup gets a 560 MB `heap_size_limit` and under 2 GiB
  gets 1120 MB, measured with `docker run -m`. The 548 MB heap total in the
  incident matches the first. The host logs the limit and the memory Node sized
  it from at boot, and `strad.process.memory.heap.limit` exports it, so the next
  look can settle it. The explicit flag makes the question moot for the bundle.
- **No leak was found.** The heap had been sitting near 500 MB before the
  growth, which is a large footprint for one process serving 31 mounts. With a
  ceiling about 10 MB above it, normal variation was enough to tip it over. If
  `heap.used` climbs steadily toward the new 1 GB ceiling, that is a leak this
  change does not fix.
- **A restart drops in-flight calls** on every slug the component serves. A
  minute-long busy spell does not trigger it; three minutes of saturation does.

**Undo.** If the bundle is split, or measured to need less, set
`bundles[].liveness: false` and a server-level `NODE_OPTIONS`. Remove the
watchdog only together with the liveness check, never instead of it.

## 134. gmail returns attachments as embedded resources, and a client that ignores them gets a summary

**What.** `download_email_attachments` wrote attachments to `/tmp` on the
bundle container and answered with the paths, so a remote caller got a path
to a disk it cannot reach (2026-11-02, a ~1 MB PDF a session could not open).
It now returns each attachment in the result as an MCP embedded resource, a
base64 `blob`, or decoded `text` for small UTF-8 text, and writes nothing to disk
(`images/bundle-google/vendor/gmail-shared/FORK.md` delta 6).

**Why it is a hack.**

- **Where the bytes land is the client's choice.** Claude Code saves a binary
  resource to a local file and gives the model the path. A client that drops
  embedded resources shows only the summary, and the caller has to call again
  with `inline=true`, which puts the base64 in the text. The summary says so.
- **The whole attachment rides one response.** Up to 25 MB decoded, about
  33 MB as base64, held in the bundle's memory and core's while it passes
  through. Gmail receives messages up to 50 MB, so a single attachment over
  25 MB cannot be fetched in either mode.
- **Small text attachments enter the model's context by default.** Text under
  100 KB comes back as text, where `inline=true` used to be needed. It is
  sender-written, the same as a message body from `get_email_conversation`.
- **It is a fork delta.** A re-vendor of upstream's tool restores the `/tmp`
  default with no failing build; only
  `images/bundle-google/test/gmail-download-attachments.test.ts` notices.

**Undo.** strad already has a link for getting bytes out of a mount: core's
sealed, single-use `/mcp-download/<slug>/<token>`, which slack, whatsapp and
liveoak use. It needs `STRAD_PUBLIC_URL` and a per-slug public-slug variable
on the bundle, deploy-time config only, and has no 25 MB ceiling. Moving
attachments over a threshold onto it would lift the cap and keep large blobs
out of both processes' memory.

## 135. google-docs suggests edits and anchors comments, and only part of that is seen live

**What.** Comments and suggestions in the Docs API are generally available as
of 2026-09-30. Two strad deltas on
`images/bundle-google/vendor/google-docs-shared` use them. They add no tool
name, so no `tools.allow:` list changes.

1. **`suggest: true`** on `insert_content` (with refusals, #136), `append_text`,
   `insert_text`,
   `replace_text` and `update_document` sends `writeControl: { writeMode: "SUGGEST" }`. Omitted, the
   request carries no `writeControl` and is a direct edit.
2. **`add_comment`'s `quoted_text`** is the passage the comment attaches to.
   The tool reads the document with `SUGGESTIONS_INLINE`, finds the passage in
   the body of each tab and sends `insertComment` with that range. Without
   `quoted_text`, the comment is a Drive comment on the whole document.

Seven things about them are not obvious:

1. **A 200 can carry a failure.** Google says a batch can commit its text
   changes while the comment or suggestion fails to save, and reports that as
   `commentUpdateState: ALL_FAILED_UNKNOWN_REASON`. `batchUpdate` turns that
   into an error for every caller, because a retry could apply the edit twice.
   What the document holds after such a failure, in suggest mode, is the thing
   nobody has measured. It might be the edit as a direct change.
2. **A suggest-mode result is labelled `UNCONFIRMED` when it names no suggestion
   and `commentUpdateState` is not `ALL_SAVED`.** It is not an error, since the
   request succeeded, but the caller asked that nothing change directly and
   that answer cannot promise it. `ALL_SAVED` with no ids counts as saved. A
   batch whose entries name a suggestion for some requests only gets a `Check`
   line, so one id does not vouch for its siblings.
3. **`quoted_text` that is missing or repeated is refused, not guessed.** A
   comment on the wrong passage is worse than none. The search covers table
   cells, but only the body, because headers, footers and footnotes are other
   segments, and not a table of contents, whose text is generated from the
   headings. For those, `update_document` takes a raw `insertComment`. Its
   `assigneeEmailAddress` is reachable the same way.
4. **Inline text holds both sides of a suggestion.** A passage a person reads
   straight across a pending replacement is in no single run, so the search
   also runs with pending deletions left out and with pending insertions left
   out. Matches from all three count, so a repeat in any of them is refused.
   The indexes stay those of the inline document, which are the only ones a
   `batchUpdate` can use.
5. **The comment's range is measured on one revision and sent against it.**
   `targetRevisionId` makes Docs merge a collaborator's edit from between the
   read and the write. Docs gives a `revisionId` only to an account with edit
   access, so a comment-only account sends none and an edit in that window can
   shift its range.
6. **Tabs work as they do for direct edits.** A request with no `tabId` goes
   to the first tab and `replace_text` reaches every tab unless `tab_id` narrows
   it, in suggest mode too. `append_text`, `insert_text` and `insert_content`
   take a `tab_id` (#136). An anchored comment carries its tab's id on the range.
7. **`suggest` refuses requests on threads.** `acceptSuggestion`,
   `insertComment` and the like are not edits to propose, and Google does not
   say what `SUGGEST` does to them. That refusal is strad's rule. The other
   refusals are Google's.

**Unverified against Google.** From the reference, read 2026-11-06: the
`writeControl` and `insertComment` shapes, `Range.tabId`, the refused requests,
`commentUpdateState`, that `documents.batchUpdate` accepts the `documents` scope.
Not seen on a live document: whether a `replaceAllText` makes one suggestion or
many and what `occurrencesChanged` then says; whether a comment-only account can call `batchUpdate` at all; and whether `insertComment`'s `commentId` is an ID Drive's
`replies.create` accepts, which `reply_to_comment` depends on. The tests fake
both APIs.

**Seen live, on 0.4.154 (session 27002).** All of it on one account's own
suggestions, and nothing failed. `replace_text` under `suggest` matches text inside
a pending insertion and rewrites that suggestion: banana to mango, then mango to
papaya, returned the same suggestion id and mango was gone. Text in a pending
deletion does not match. A quote across a pending replacement reads both sides,
`papayabanana`, in `add_comment`'s "Anchored to" and in `list_comments`, and the
anchor is right. Not tried: that overwrite on another author's suggestion.

**Seen live, on 0.4.155 (the rollout of #463).** `suggest` with `tab_id` on
`insert_text`, `append_text` and `replace_text`, and `update_document` by `tabId`,
each stayed in its tab, and `suggestionResponses` carried the ids the tools returned.

**Undo.** If upstream gains these, re-vendor and drop the delta. Until then a
re-vendor has to re-apply the row in the tree's README, and
`images/bundle-google/test/docs-suggest-anchor.test.ts` fails if it does not.

## 136. google-docs edits by heading, and `insert_content` cannot suggest everywhere

**What.** `images/bundle-google/vendor/google-docs-shared` gains one tool,
`insert_content`, and `tab_id` on `append_text`, `insert_text` and `replace_text`.
`get_document` gains `heading`, `heading_id`, `occurrence`, `start_index`,
`end_index`, `include_styles`, `skip_tables` and `format=outline_with_indices`.
`get_document_outline` lines gain the start index and heading id. Issue #463 is
why: an agent told to add one H3 section to the second tab of a document gave up,
because `format=json` was truncated before it reached the heading and every index
had to be counted by hand.

**A new tool, not parameters on `insert_text`.** Its required inputs differ, an
anchor and a position rather than an index, and its input is markdown rather than
literal text. An `insert_text` that did both would need a mode that JSON Schema
cannot show as "exactly one of". The cost is a `tools.allow:` line on every `-rw`
slug.

Ten things about it are not obvious:

1. **Two insertion shapes, because Docs refuses one position.** Text cannot go at
   a table's start index. The normal shape is `text\n` at the start of the next
   paragraph, which leaves that paragraph's newline, style and heading id alone.
   Where no paragraph follows, above a table or at a tab's end, it is `\ntext`
   inside the closing newline of the one before. That splits it. A heading above a
   table keeps its heading id: live, direct and as a suggestion, pending, accepted
   and rejected. At a tab's end the id was not checked. Item 10 is what the split
   costs under `suggest`.

2. **New text takes its neighbour's look.** Docs styles inserted text from what
   surrounds it, so text above a heading starts out as that heading, and text
   above a list item starts out in the list. The batch takes bullets off, sets
   paragraph styles, resets the text style, and only then applies the content's
   own styling. The order matters.
3. **`createParagraphBullets` removes leading tabs and can shift indexes**, which
   is how Docs expresses nesting. The dialect refuses nested lists, and the parser
   drops a tab that arrives at the start of an item through a code span or link.
   The requests also run last and bottom-up, so a shift cannot reach a range still
   to come.
4. **`insertText` strips control characters and the private use area** with no
   word to the caller. The parser removes them first, or every later range would
   be off by what Google dropped.
5. **Ranges are computed in JavaScript string units**, which are the UTF-16 code
   units Docs indexes in. That is the whole reason emoji cannot throw them off.
6. **A heading is matched on folded text, in tiers.** A prefix must end on a word
   boundary, so `Phase 1` is never `Phase 10`. Exact, then prefix, then the
   same two with leading symbols ignored, because a reader calls `🖼️ Agent Run
Lifecycle` "Agent Run Lifecycle". U+FE0F is folded too. All three views of a
   heading with a pending suggestion count, as for `add_comment` (#135). A repeat
   is refused with each match listed, and a tab is never guessed.
7. **A section ends at the next heading of the same or a higher level**, so an
   H2's section holds its H3s, and TITLE and SUBTITLE count as the highest level.
   An H1 with no later H1 runs to the end of the tab.
8. **The write names the revision it measured**, `targetRevisionId`, so Docs
   carries the indexes over a collaborator's edit. In suggest mode it goes with
   `writeMode: SUGGEST`. `WriteControl` puts `writeMode` outside the mutually
   exclusive revision pair, so the reference allows both; no live call has
   confirmed it.

9. **`get_document` keeps the account's default suggestion view**, so a read-only
   slug reads as it always did. `insert_content` asks for `SUGGESTIONS_INLINE`
   itself, because #135 records it as the only mode whose indexes a `batchUpdate`
   can use. Indexes read through `format=outline_with_indices` are only good for
   a write if the account's default is inline, which #135 records for anyone
   beyond view access.
10. **`suggest` is refused where content ends on an existing newline it would have
    to restyle.** In the `\ntext` shape the last paragraph ends on the neighbour's
    newline, and under `SUGGEST` that newline is existing text. It keeps its style
    and id, and the paragraph reset becomes a separate suggestion competing with
    the insertion. Live, on a heading above a table: while pending that paragraph
    read `HEADING_2` under the heading's own id, so `heading_id` lookups matched two
    headings. Accepting the ids in the order the tool returned them left a real
    `HEADING_2` under a new id, in both runs (one paragraph and two). Reverse order,
    in one run, gave `NORMAL_TEXT`. Rejecting all restored the document. By Google's
    reference, and not run live, no other shape reaches the gap: `\ntext\n` would
    leave an empty heading on the old newline, and the newline in front of a table
    cannot be deleted. A direct write of a spacer paragraph first is a live edit that
    a rejecting reviewer cannot undo. So `suggestRefusal` in `content-requests.ts`
    refuses, after the read that shows the shape and before any write, unless the
    neighbour and the content's last paragraph are both plain: `NORMAL_TEXT` and not
    a list item. In the allowed case `contentRequests` sends no paragraph reset to
    the old newline, so no rival suggestion exists there, and the last paragraph
    keeps whatever direct formatting that newline has. The live failure covers a
    heading neighbour.
    A tab's last paragraph when it is a heading takes the same code path and was not
    run under `suggest`. A list item, or content ending in a heading or list on a
    plain line, is refused from the same reasoning and was not run live either.

**Left out on purpose.** `delete_section` and `replace_section`, the issue's
nice-to-have. They delete live text on an anchor that has never met Google, and
`deleteContentRange` through `update_document` does the job with the range a
section read returns. A marker-paragraph proposal mode, because `suggest` (#135)
is a real suggestion. An `index` anchor on `insert_content`: `insert_text` with
`tab_id` reaches a non-heading paragraph, as plain text.

**Seen on real Google** (rollout of #463, `0.4.155`, on a scratch document). The
issue's edit landed correctly, in one call, with the other tab unchanged. Later
requests in a `SUGGEST` batch see the text an earlier one suggested: every proposed
style sat on the right run. No suggest call drew a 400 with `targetRevisionId`,
though the outgoing request was not captured. A heading above a table kept its id.
Suggestion counts differ by shape: one id for content above a heading, across five
paragraphs including a list, and on a heading above a table one id per paragraph
plus one, two for one and three for two, which is the shape item 10 refuses.

**Not seen on a live document.** The Docs editor's Accept all on the refused shape.
`suggest` on a tab's last paragraph, on any neighbour, so the count there. Whether a
heading at a tab's end keeps its id. The stable
facts from the reference, read 2026-11-06, are the table start index, the stripped
characters, the bullet behaviour, that an unset field in the mask resets it, and the
`tabsCriteria` shape. The tests apply requests to
`images/bundle-google/test/fixtures/docs-simulator.ts`, a model strad wrote. Its
split and suggestion rules follow the live results above, and beyond those cases it
is an assumption. Written from the reference alone, it missed item 10.

**Undo.** If upstream gains these, re-vendor and drop the delta. Until then a
re-vendor has to re-apply the row in the tree's README, and
`images/bundle-google/test/docs-anchored-edits.test.ts` fails if it does not.
