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
