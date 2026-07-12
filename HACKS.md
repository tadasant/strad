# HACKS.md

A running catalogue of every deliberate workaround in strad, why it exists, and
what a human must provision to remove it. Each entry is a debt with an owner.

Ordered roughly by how much you'd want to fix it.

---

## 1. First ghcr image is bootstrapped from the PR branch

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
`GOOGLE_CLIENT_SECRET`) are being provisioned by the human and were not available
tonight. The full Google provider is built and tested (`src/auth/google.ts`,
including the `hd` hosted-domain check); it lights up the moment the creds exist.

**Undo.** Provide `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` (as
`strad-staging-*` secrets), set `auth.google.enabled: true`, and set
`auth.consoleDevBypass.enabled: false` (or just unset `ALLOW_DEV_AUTH`). Then
delete `src/auth/dev.ts` and its call sites.

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

**What.** The OAuth `state → codeVerifier` map in `src/http/app.ts` is a plain
`Map`. It does not survive a restart and is not shared across replicas.

**Why.** Fine for a single-instance console; not worth a session store tonight.

**Undo.** Back it with Redis or signed, expiring cookies before the console runs
multi-instance.

---

## 8. Secret backend: env vars at runtime, GCP at deploy time

**What.** The runtime container reads secrets from `process.env`
(`EnvSecretSource`). CI (`deploy-staging.yml`) reads `strad-staging-*` from GCP
Secret Manager and injects them as App Platform SECRET env vars.

**Note.** This is _not_ really a hack — it is the intended design: the container
holds no GCP credential, which sidesteps a bootstrap "one key to rule them all".
It is listed here only because `secrets-sync.yml`/`deploy-staging.yml`
authenticate to GCP with **`GCP_SA_KEY`**, a long-lived service-account key.

**Undo (the actual debt).** Provision **Workload Identity Federation** — a pool +
provider bound to `tadasant/strad` and `tadasant/tadasant-internal` — so
`google-github-actions/auth@v2` goes keyless. Then **delete `GCP_SA_KEY`** from
both repos.

---

## 9. good-eggs image is bootstrapped from the PR branch

**What.** `release-goodeggs-image.yml` triggers on `main` **and** on the feature
branch `feat/good-eggs-supplementary`. Same bootstrap as hack #1, for the same
reason: the first `ghcr.io/tadasant/strad-server-good-eggs` image has to be
pushed by CI (the session has no `write:packages` PAT), and the built-in
`GITHUB_TOKEN` push only works from a workflow in this repo.

**Undo.** Delete the `feat/good-eggs-supplementary` line from
`on.push.branches` in `release-goodeggs-image.yml` before/after merge.

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

## 12. good-eggs staging bundle deployed from the agent session; ghcr visibility

**What.** Like the core (hack #3), the good-eggs `bundle-goodeggs` component was
added to `strad-staging` directly via the DigitalOcean MCP from the build
session, not via `deploy-staging.yml`. The image is pulled from
`ghcr.io/tadasant/strad-server-good-eggs`.

**Why.** Same as hack #2b — the CI deploy path is merge-gated. This proves the
supplementary-image path end-to-end now.

**Watch for (ghcr visibility).** `tadasant/strad` is a **private** repo, so the
new package inherits private visibility. App Platform can only pull it with a
credential in scope of `GHCR_PULL_TOKEN` (which `attach-registry-creds.mjs`
auto-attaches to any GHCR component). If a pull 403s, either the package is not in
the (fine-grained) PAT's scope — add it — or make the package public. The
session-driven deploy used <SEE_DEPLOY_NOTE>.

**Undo.** Merge the PR; the next CI deploy re-renders `infra/strad.staging.yaml`
(good-eggs included) with GHCR creds from `GHCR_PULL_TOKEN`.

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

## What the human still needs to provision

A consolidated checklist, cross-referenced above:

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
