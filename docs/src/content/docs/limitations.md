---
title: Known limitations
description: The shims, gaps, and deferred work in the current strad build — drawn straight from HACKS.md. Read this before you treat anything as finished.
sidebar:
  order: 1
---

These docs are honest about what's finished and what isn't. The list below is
drawn straight from the repo's [`HACKS.md`](https://github.com/tadasant/strad/blob/main/HACKS.md),
ordered roughly by fix priority. Each item names the shim, why it exists, and how
it gets undone.

## 1. First ghcr image bootstrapped from a PR branch

`release-image.yml` temporarily also triggers on `feat/strad-core-platform` to
mint `0.1.0` once. No `write:packages` PAT was available, and the push path uses
the built-in `GITHUB_TOKEN`, which only works in-repo. **Undo:** delete the
`feat/strad-core-platform` line from `on.push.branches` around merge; thereafter
images cut only from `main`.

## 2. Console dev bypass stands in for Google OAuth

`/console` is currently enterable with `ADMIN_BOOTSTRAP_TOKEN`. It is
triple-guarded, hard-disabled under `NODE_ENV=production` unless `ALLOW_DEV_AUTH`
is explicitly true, and logs loudly. **It cannot authenticate `/mcp`.** The Google
provider — including the `hd` claim check — is fully built and tested. **Undo:**
provide `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` as `strad-staging-*`, set
`auth.google.enabled: true` and `consoleDevBypass.enabled: false` (or unset
`ALLOW_DEV_AUTH`), and delete `src/auth/dev.ts` and its call sites. See
[Auth](/auth/overview/#console-dev-bypass-temporary).

## 2b. CI-driven deploy is merge-gated

`workflow_dispatch` workflows are only invocable from the default branch, and
Secret Manager isn't seeded until `secrets-sync.yml` runs — so
`deploy-staging.yml` [skips-and-stays-green](/operate/operations/#deploy-stagingyml--put-it-on-app-platform)
on an auto-release without prerequisites (a manual dispatch fails loudly).
**Undo:** merge the PR, then run `secrets-sync.yml`.

## 3. Tonight's staging deployed from an agent session, not CI

`strad-staging` was first created via the DigitalOcean MCP with a hand-rendered
spec and locally-minted tokens. **Undo:** merge, then let `release-image.yml` →
`deploy-staging.yml` rebuild from `infra/strad.staging.yaml` on the ghcr image;
never hand-deploy again.

## 4. Staging runs a DOCR image; the target is ghcr

The live app currently pulls `registry.digitalocean.com/strad/strad:0.1.0` (DOCR),
because the build session had DO access but no `write:packages` PAT. **Undo:** the
first CI release publishes to ghcr; the deploy repoints to
`ghcr.io/tadasant/strad` with `GHCR_PULL_TOKEN`; then **delete the DOCR `strad`
registry** (~$5/mo) via `doctl registry delete strad`.

## 5. GHCR pull tokens shared between zimmer and strad

Staging uses `GHCR_PULL_TOKEN`; prod reuses zimmer's
`GHCR_PULL_TOKEN_ZIMMER_TADASANT_INTERNAL` (a classic PAT with `read:packages` is
account-wide). **Undo:** mint a dedicated
`GHCR_PULL_TOKEN_STRAD_TADASANT_INTERNAL` for hygiene. **Watch:** a 403 on pull
means the PAT is fine-grained and strad's package isn't in its scope — add it.

## 6. Static token records live in an env var, not a database

Token records are a JSON array in `STRAD_TOKENS` (SHA-256 hashes only). Mint or
revoke means editing the secret and redeploying. **Undo:** implement a DB-backed
`TokenStore` (the interface is already the right shape) plus a `/console`
mint/revoke UI, and drop `STRAD_TOKENS`. See [Auth](/auth/overview/#mcp--static-system-tokens-agents).

## 7. Console OAuth state is in-memory

The OAuth `state → codeVerifier` map is a plain `Map` in `src/http/app.ts`; it
doesn't survive a restart or span replicas. **Undo:** back it with Redis or signed
expiring cookies before running a multi-instance console.

## 8. Secret backend: env at runtime, GCP at deploy time

This is **not really a hack** — it's the intended design (the container holds no
GCP credential). It's listed only because `secrets-sync.yml` and
`deploy-staging.yml` authenticate to GCP with a long-lived `GCP_SA_KEY`. **The
real debt / undo:** provision **Workload Identity Federation** (a pool + provider
bound to `tadasant/strad` and `tadasant/tadasant-internal`) so
`google-github-actions/auth@v2` goes keyless, then **delete `GCP_SA_KEY`** from
both repos.

---

## Human-provisioning checklist

The one-time human steps that clear most of the list above:

- Provide Google OAuth secrets — removes **#2**.
- Merge the PR and drop the bootstrap-branch trigger — **#1**, **#3**.
- Confirm staging is on ghcr, then delete the DOCR registry — **#4**.
- Mint a dedicated strad GHCR pull token — **#5**.
- Provision WIF, then delete `GCP_SA_KEY` — **#8**.
- Stand up a datastore + a console mint/revoke UI — **#6**, **#7**.
- Add the Cloudflare DNS record `staging.strad.tadasant.com` → the App Platform
  app (DNS-only; App Platform issues the cert) — see [DNS &
  domains](/operate/dns/).
