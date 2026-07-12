---
title: Operations & CI
description: The GitHub Actions workflows that build, test, release, deploy, and seed secrets for strad — ci, release-image, deploy-staging, and secrets-sync.
sidebar:
  order: 2
---

strad's operations are four GitHub Actions workflows. Together they enforce one
premise: **the image is the deliverable**, so a PR that can't produce a bootable
image is a failing PR.

## `ci.yml` — the gate on every PR

Runs on PRs and pushes to `main` (self-hosted runners):

- **`lint`** — typecheck, ESLint, `prettier --check`.
- **`test`** — `vitest`: unit tests plus a real-MCP-client, in-process E2E.
- **`verify_lockfile`** — `npm install --package-lock-only` then
  `git diff --exit-code`, so `package-lock.json` can't drift.
- **`build_image`** — builds the Docker image, boots it with `STRAD_TOKENS='[]'`,
  and asserts two things: `/healthz` is up, and **`/mcp` with no token returns
  `401`**. That last check is *the* test given strad's open-internet posture — an
  unauthenticated MCP endpoint that ever returned tools would be the whole ball
  game.

## `release-image.yml` — mint and ship

Runs on push to `main` (plus a temporary bootstrap branch and `workflow_dispatch`):

1. Compute the [effective version](/operate/deploy-model/#versioning).
2. Log in to GHCR and build + push `ghcr.io/tadasant/strad:<version>` (+ `:latest`,
   `:sha-<sha>`).
3. Fire the cross-repo `repository_dispatch` to `tadasant-internal`
   (best-effort).
4. Call `deploy-staging.yml` (`secrets: inherit`) with the new version.

## `deploy-staging.yml` — put it on App Platform

A `workflow_call` + `workflow_dispatch` job in the `staging` environment. Its
defining idiom is the **preflight "safe no-op"**:

- On an **automatic** release, if prerequisites (`DIGITALOCEAN_ACCESS_TOKEN`,
  `GCP_SA_KEY`) are missing, it **skips and stays green**.
- A **manual** `workflow_dispatch` with the same gap **fails loudly**.

That split is deliberate: an automatic release shouldn't turn red just because the
account isn't seeded yet, but a human asking for a deploy should hear "no." When
prerequisites are present it: authenticates to GCP
(`google-github-actions/auth@v2`, preferring Workload Identity Federation, falling
back to `GCP_SA_KEY`), installs `gcloud`, reads `strad-staging-*` from Secret
Manager (masked, into `$GITHUB_ENV` — same skip-vs-error split if none are found),
renders the spec to `/tmp/spec.json` (never echoed), attaches a durable GHCR pull
credential, installs `doctl`, runs `doctl apps create/update --spec … --wait` for
`strad-staging`, and finally smoke-tests the live host (`/healthz` up, `/mcp` ==
`401`).

<aside class="starlight-aside starlight-aside--note">

**Why a durable pull token?** App Platform re-pulls the private image on every
restart and scale event, so it needs a long-lived credential
(`scripts/attach-registry-creds.mjs` attaches `tadasant:${GHCR_PULL_TOKEN}`), not
the ephemeral `GITHUB_TOKEN` that only exists during the workflow run.

</aside>

## Seeding secrets

`secrets-sync.yml` is a `workflow_dispatch` job (in the `staging` environment)
that idempotently upserts
`strad-staging-{STRAD_TOKENS, STRAD_INTERNAL_TOKEN, ADMIN_BOOTSTRAP_TOKEN}` into
GCP Secret Manager — creating the secret or adding a new version.
`STRAD_INTERNAL_TOKEN` is auto-generated (`openssl rand -hex 24`) if you omit it.

The rationale is that **an agent or a laptop cannot read GitHub Actions secrets** —
only a workflow runs with them in scope. So `GCP_SA_KEY` never touches a terminal;
the seeding happens entirely inside CI. Run it once to seed, and again on any value
change:

```bash
gh workflow run secrets-sync.yml \
  -f strad_tokens='<records-json>' \
  -f admin_bootstrap_token='<token>' \
  [-f internal_token='<token>']
```

## The staging config

`infra/strad.staging.yaml` is the live staging config, and it deliberately
exercises all three server kinds so the deploy path is proven end-to-end:

- `echo` — a `builtin` in `core`.
- `bundled` — a `builtin` in `bundle-api`, proving the private-network hop.
- `deepwiki` — a `remote-http` server (`https://mcp.deepwiki.com/mcp`), a
  credential-free canary.

Roles are `admin: ["*"]` and a deliberately narrow `echo-only: [echo]`, which
keeps the [424 fail-closed path](/intro/concepts/#the-424-contract) meaningful.
`google.enabled` is `false` (it flips true when OAuth creds land) and
`consoleDevBypass.enabled` is `true`.

## Health and console surface

- **`/healthz`** is dependency-free and returns `mode`, `bundle`, `env`, and
  `servers` — used by the App Platform health check and the deploy smoke test.
- **`/mcp`** is handled by `app.all("/mcp", …)` and always requires a token.
- **`/console`** and `/console/oauth/callback` are mounted only in `core` mode.
  The OAuth `state → codeVerifier` map is currently in-memory (see [Known
  limitations](/limitations/)).
