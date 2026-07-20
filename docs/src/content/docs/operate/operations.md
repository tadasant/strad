---
title: Operations & CI
description: The GitHub Actions workflows that build, test, release, deploy, and seed secrets for strad — ci, release-image, deploy-staging, and secrets-sync.
sidebar:
  order: 2
---

strad's operations are a set of GitHub Actions workflows on self-hosted runners.
They enforce one premise: **the image is the deliverable**, so a PR that can't
produce a bootable image is a failing PR.

## `ci.yml` — the gate on every PR

Runs on PRs and pushes to `main`. Six jobs, all `runs-on: self-hosted`:

- **`lint`** — typecheck, ESLint, `prettier --check`.
- **`test`** — `vitest`: unit tests plus a real-MCP-client, in-process E2E.
- **`good_eggs`** — `servers/**` is outside the core TypeScript program, and the
  good-eggs image only builds on push, so a PR could otherwise break that server
  without CI noticing. This job builds it and runs its browser-free MCP-App gating
  tests.
- **`bundle_image`** — builds `servers/bundle/Dockerfile`, **boots the container**,
  and runs `scripts/smoke.mjs` against every mount of the running image, asserting
  the full-capability tool count for each (slack 9, tailscale 15, monarch-money 23,
  gmail 8, google-docs 11, google-calendar 7, 1Password 9, …). Those counts are the
  numbers the gateway's read-only allow-lists are carved out of, so if an upstream
  grows or renames a tool, this is where it surfaces. It also asserts the `op` CLI
  is really in the image.
- **`verify_lockfile`** — `npm install --package-lock-only` then
  `git diff --exit-code`, so `package-lock.json` can't drift.
- **`build_image`** — builds the core Docker image, boots it with
  `STRAD_TOKENS='[]'`, and asserts two things: `/healthz` is up, and **`/mcp` with
  no token returns `401`**. That last check is _the_ test given strad's
  open-internet posture — an unauthenticated MCP endpoint that ever returned tools
  would be the whole ball game.
- **`docs_site`** — `npm ci && npm run build` in `docs/`. The documentation site is
  meant to stay true commit-by-commit, so a broken link, bad frontmatter, or a page
  missing from the `sidebar` array fails the PR rather than the deploy.

## `release-image.yml` — mint and ship

Runs on push to `main` (ignoring `**/*.md` and `docs/**`) and on `workflow_dispatch`.
It is the **release** path, and it **refuses to run on any ref but `main`** — it
moves `:latest` and notifies prod, and neither should ever happen for unreviewed
code. To put a branch on staging, see [deploying a
branch](#deploying-a-branch-to-staging) below. `release-bundle-image.yml` carries
the same guard for the same reason.

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

<aside class="starlight-aside starlight-aside--note">

**Why `doctl` is installed without a token.** `digitalocean/action-doctl` will run
`doctl auth init` for you, which writes the token in cleartext to
`$HOME/.config/doctl/config.yaml`. The action has no `post:` step to tear that
file down, and the runners are `self-hosted` with a shared `/home/runner`. A
concurrent job can clobber it mid-run. So the workflow installs the binary with
`no_auth: "true"` and gives every step that invokes `doctl` its own
`DIGITALOCEAN_ACCESS_TOKEN`, which doctl reads natively.

Those steps also set `DIGITALOCEAN_CONTEXT: default`, which is load-bearing.
doctl only honors the token from the environment on the `default` context. On any
other context it reads that context's entry in the config file and ignores the
environment. A concurrent `doctl auth init --context <name>` writes a top-level
`context:` key into the shared file, which is enough to make a step send another
job's token. Pinning the context keeps the explicit token authoritative.

</aside>

### Deploying a branch to staging

Staging normally runs `main`'s config against `main`'s images. To put a **feature
branch** on it — config _and_ binary — dispatch `deploy-staging.yml` on that
branch with `build: true`:

```bash
gh workflow run deploy-staging.yml --ref my-branch -f build=true
```

That adds a `build` job ahead of the deploy. It builds **both** images — the core
and the bundle — from the dispatched ref and pushes them as
`ghcr.io/tadasant/strad:branch-<slug>-<sha12>` and
`ghcr.io/tadasant/strad-bundle:branch-<slug>-<sha12>`. The deploy then renders the
branch's own `infra/strad.staging.yaml` against those two tags, passing the bundle
one as `--bundle-image` so the config's 23 `image:` lines need no edit.

Three properties make this safe to hand to anyone, and each is **structural**
rather than a matter of passing the right input:

- **No `:latest` is ever moved.** The tag list is derived from the ref and
  asserted not to be `latest` before a push happens. The release tags live only in
  `release-image.yml` / `release-bundle-image.yml`, which refuse to run off
  `main`.
- **Prod is never notified.** `deploy-staging.yml` contains no
  `repository_dispatch` step at all, so a branch build cannot fire one.
- **The release path cannot trigger a build.** `build` is declared only on
  `workflow_dispatch`, not on `workflow_call`, so `release-image.yml` has no way
  to reach the build job.

A branch build also reads the shared buildx cache but never writes it, so it
cannot affect what `main` builds from.

**Restoring staging to `main`** needs no teardown: dispatch `deploy-staging.yml`
on `main` with `build` left off. It renders `main`'s config against `:latest`,
which is exactly what the release path does — so the next merge to `main` restores
staging on its own regardless.

<aside class="starlight-aside starlight-aside--caution">

Never push a branch bundle to `strad-bundle:latest`. Live staging pulls that tag
on every restart, and a bundle whose mounts have moved will serve paths the
_deployed_ spec does not route. Build and deploy have to happen together, which is
what the `build: true` dispatch does.

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

## The image workflows

Each container image strad publishes has its own release workflow, path-filtered
so a change to one server doesn't rebuild the rest:

| Workflow                        | Publishes                                        | Triggered by a change under                                                                                                                                 |
| ------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `release-image.yml`             | `ghcr.io/tadasant/strad`                         | the repo root / `src/`                                                                                                                                      |
| `release-bundle-image.yml`      | `ghcr.io/tadasant/strad-bundle` — **the** bundle | `servers/bundle/`, `servers/bundle-api/`, `servers/onepassword/`, `servers/good-eggs/`, `servers/fetchpet/`, `servers/pointsyeah/`, `images/bundle-google/` |
| `release-bundle-api-image.yml`  | `ghcr.io/tadasant/strad-bundle-api`              | `servers/bundle-api/`                                                                                                                                       |
| `release-goodeggs-image.yml`    | `ghcr.io/tadasant/strad-server-good-eggs`        | `servers/good-eggs/`                                                                                                                                        |
| `release-fetchpet-image.yml`    | `ghcr.io/tadasant/strad-server-fetchpet`         | `servers/fetchpet/`                                                                                                                                         |
| `release-pointsyeah-image.yml`  | `ghcr.io/tadasant/strad-server-pointsyeah`       | `servers/pointsyeah/`                                                                                                                                       |
| `release-onepassword-image.yml` | `ghcr.io/tadasant/strad-server-onepassword`      | `servers/onepassword/`                                                                                                                                      |
| `bundle-google-release.yml`     | `ghcr.io/tadasant/strad-server-bundle-google`    | `images/bundle-google/`                                                                                                                                     |

Everything below `release-bundle-image.yml` in that table is a **per-server image
that staging no longer deploys** — staging runs the one collapsed bundle. They are
still built and still pushed on purpose: production, in `tadasant-internal`, has not
been re-pointed at the collapsed bundle yet, and App Platform re-pulls `:latest` on
every restart. Deleting them before prod moves would be an outage, not a cleanup.
See [Known limitations](/limitations/).

`bundle-google-ci.yml` is the second CI workflow: it builds and smoke-tests the
`bundle-google` image on any PR touching `images/bundle-google/`.

## The staging config

`infra/strad.staging.yaml` is the live staging config, and it deliberately
exercises all three server kinds so the deploy path is proven end-to-end. It
declares twenty-five server slugs:

- `echo` — a `builtin` in `core`, in-process.
- `deepwiki` — a `remote-http` server (`https://mcp.deepwiki.com/mcp`), a
  credential-free canary.
- twenty-three `supplementary-image` entries, all on the one `bundle` component
  running `ghcr.io/tadasant/strad-bundle`. They land on the bundle image's fourteen
  mounts, because a read-only and a read-write variant of one upstream are two
  entries sharing one `path`.

Roles are `admin: ["*"]` and a deliberately narrow `echo-only: [echo]`, which
keeps the [424 fail-closed path](/intro/concepts/#the-424-contract) meaningful.
`google.enabled` is `false` (it flips true when OAuth creds land) and
`consoleDevBypass.enabled` is `true`.

`test/staging-config.test.ts` is the guard on all of this: it asserts the config
renders to exactly `["core", "bundle"]`, that the bundle is `apps-s-1vcpu-2gb`, that
no server carries a container-side capability toggle, and that each read-only
allow-list is a subset of the tier above it.

## Health and console surface

- **`/healthz`** is dependency-free and returns `mode`, `bundle`, `env`, and
  `servers` — used by the App Platform health check and the deploy smoke test.
- **`/mcp`** is handled by `app.all("/mcp", …)` and always requires a token.
- **`/console`** and `/console/oauth/callback` are mounted only in `core` mode.
  The OAuth `state → codeVerifier` map is in-memory (see [Known
  limitations](/limitations/)).
- **`/ui`** and `/ui/:server`, also core-only, are the human-facing server console.
  Its "session" is the bootstrap token in a cookie, which is a shim (see [Known
  limitations](/limitations/)).
