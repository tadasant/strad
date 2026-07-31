---
name: strad-deploy-staging
title: Deploy strad to Staging
description: >
  Deploy a strad change to the staging environment. Staging is a DigitalOcean App
  Platform app (`strad-staging`) rendered from `infra/strad.staging.yaml`. The
  `Deploy staging` workflow deploys a published image tag
  (`ghcr.io/tadasant/strad:<version>`, defaulting to the `sha-<commit>` built for
  the checked-out ref) — so the normal path is a
  merge to `main`, which builds the image and then deploys it — and a manual
  `workflow_dispatch` either re-pins staging to an existing tag (rollback) or,
  with `build: true`, builds the dispatched BRANCH's core and bundle images under
  branch-scoped tags and deploys those. Covers dispatching the run, deploying an
  unmerged branch and restoring `main`, the App-Platform full-replace hazard,
  verifying the live host, rollback, and what an agent session can and cannot do
  without DO/GCP credentials. Production is NOT deployed from this repo — it lives
  in tadasant-internal.
user-invocable: true
---

# Deploy strad to Staging

Staging is a **DigitalOcean App Platform** app named `strad-staging`, rendered
from `infra/strad.staging.yaml` into a spec and pushed with `doctl`. A deploy is
an App Platform spec update, not a rebuild of a host.

The single most important thing to internalize: **a deploy has two layers**, and a
change reaches staging through whichever one it lives in. The **spec layer**
(`infra/strad.staging.yaml`, `scripts/render-spec.ts`) is rendered from the ref
the workflow runs on. The **image layer** (everything inside the built container)
comes from an image tag. Those two must not disagree: a bare `workflow_dispatch`
used to render the ref's spec against whatever `:latest` pointed at, which took
staging down (see "the mutable tag" below). It now resolves the `sha-<commit>`
image built for that same ref, so both layers come from one commit.

## The critical facts

- **`Deploy staging` deploys an image tag by default, and can build a branch.**
  `.github/workflows/deploy-staging.yml` (workflow name: **`Deploy staging`**) is
  `workflow_call` + `workflow_dispatch`. `version` selects an already-published
  `ghcr.io/tadasant/strad` tag; omitted, the workflow resolves the `sha-<commit>`
  tag built for the checked-out ref. The `build` input (dispatch
  only) instead builds **both** images — core and bundle — from the dispatched ref
  and deploys those, which is how an unmerged branch gets onto staging.

- **The normal path to staging is a merge to `main`.** `release-image.yml` runs on
  push to `main` (ignoring `**/*.md` and `docs/**`): it computes the
  [effective version](https://docs.strad.tadasant.com/operate/deploy-model/#versioning),
  builds and pushes `ghcr.io/tadasant/strad:<version>` (+ `:latest`, `:sha-<sha>`),
  and then **calls `deploy-staging.yml` (`secrets: inherit`) with that version**.
  So merging to `main` builds the image _and_ rolls staging onto it in one chain.
  No manual step is required for the happy path.

- **With `build` left off, a manual `Deploy staging` re-pins staging to an
  existing published tag.** Use it to redeploy the current image, or to roll
  staging back to an earlier tag. It will fail if the tag was never published —
  in that mode it builds nothing.

  ```bash
  gh workflow run deploy-staging.yml -f version=<image-tag>   # e.g. 0.1.6, or omit for this ref's sha- image
  ```

- **To stage an UNMERGED branch, dispatch `Deploy staging` on it with
  `build: true`.** That is the whole procedure — one workflow, one run:

  ```bash
  gh workflow run deploy-staging.yml --ref "$(git rev-parse --abbrev-ref HEAD)" -f build=true
  ```

  It builds the core **and** bundle images from that ref, pushes them as
  `branch-<slug>-<sha12>` on `ghcr.io/tadasant/strad` and
  `ghcr.io/tadasant/strad-bundle`, and renders the branch's own
  `infra/strad.staging.yaml` against both (the bundle via `--bundle-image`, so the
  config's 23 `image:` lines need no edit). It moves **no** `:latest` tag
  and fires **no** `repository_dispatch` at `tadasant-internal`.

  **Do not dispatch `release-image.yml` (or `release-bundle-image.yml`) on a
  branch to do this.** Those are the release path: they move `:latest` and notify
  prod. Both refuse to run on any ref but `main`, so the attempt fails fast.

- **Restoring staging to `main` needs no teardown.** Dispatch `Deploy staging` on
  `main` with `build` left off, and it renders `main`'s config against the
  `sha-<commit>` image built for that commit —
  identical to what the release path does. The next merge to `main` also restores
  it on its own. A branch deploy is not durable state; nothing has to be cleaned
  up.

- **No deploy ships a mutable tag — this has actually bitten.** Dispatching
  `Deploy staging` on `main` at 96015c6 shipped `:latest`, and the container booted
  code from before PR #26: it rejected the current `infra/strad.staging.yaml` with
  a `each must serve a distinct path` rule that commit had deleted three weeks
  earlier, and staging went down. The same commit had deployed cleanly on
  `:0.1.38` hours before, and pinning `:0.1.33` brought it back. App Platform may
  satisfy a mutable tag from whatever it resolved last, and the spec gives no way
  to tell which image will boot. So `render-spec` now refuses a core image on
  `latest` / `main` / `edge` / `stable` (and a tag-less ref, which means
  `latest`), and the workflow resolves `sha-<commit>` instead. It walks back only
  past **docs-only** commits, which cut no image by design; a **code** commit with
  no image is a hard stop, because `release-image.yml` is still building (or
  failed) and deploying the previous commit's image against this commit's config
  is the same skew. If a deploy stops that way, wait for the release run to finish
  and re-dispatch, or dispatch with an explicit `version`.

- **A deploy is a full spec REPLACE — an omitted field is a deletion.** This has
  actually bitten: omitting `domains` from an update _detaches the custom domain_,
  and the app stays healthy on its `*.ondigitalocean.app` ingress while
  `staging.strad.tadasant.com` fails its TLS handshake, so nothing alerts.
  `render-spec` always emits `domains` (defaulted from `gateway.publicUrl`,
  and the deploy passes `--domain staging.strad.tadasant.com` explicitly). **Verify
  the custom domain still serves after any deploy.** See `HACKS.md` #18 and
  `docs/src/content/docs/operate/deploy-model.md`.

- **Staging is publicly reachable — but gated.** Unlike zimmer's tailnet-only
  droplet, `strad-staging` answers on the open internet: an unauthenticated
  `POST /mcp` must return `401`. That gate _is_ the product's whole posture, so the
  deploy's own smoke test asserts it (see Verifying). An agent session can curl the
  live host directly.

- **Secrets must be seeded first.** The deploy reads `strad-staging-*` from GCP
  Secret Manager. If none exist, a manual deploy fails loudly; seed them once with
  `secrets-sync.yml` (see Prerequisites).

## Prerequisites

The deploy needs, on the GitHub side (held by the runner/environment, not your
session): `DIGITALOCEAN_ACCESS_TOKEN`, a GCP credential (`GCP_SA_KEY` /
`GCP_PROJECT_ID`), and a durable `GHCR_PULL_TOKEN` (App Platform re-pulls the
private image on every restart/scale, so the ephemeral `GITHUB_TOKEN` is useless
there). It also needs `strad-staging-*` seeded in GCP Secret Manager. Seed them
with the `staging`-environment workflow (an agent or laptop cannot read GitHub
Actions secrets, so seeding happens entirely inside CI):

```bash
gh workflow run secrets-sync.yml \
  -f strad_tokens='<records-json>' \
  -f admin_bootstrap_token='<token>' \
  [-f internal_token='<token>']
```

The `Deploy staging` job's **preflight** is a deliberate "safe no-op": on an
_automatic_ release, missing prerequisites cause it to **skip and stay green**; a
_manual_ `workflow_dispatch` with the same gap **fails loudly** — you asked for a
deploy, so a missing prerequisite is an error.

## Dispatching a deploy

An agent session **can** do this — `gh workflow run` is all it takes. The GitHub
runner holds the DigitalOcean and GCP credentials, not your session.

```bash
# Re-deploy staging on the image built for this ref (or a specific tag):
gh workflow run deploy-staging.yml                     # resolves sha-<commit>
gh workflow run deploy-staging.yml -f version=0.1.6    # a specific published tag

# Build and deploy a branch, config and binary together:
gh workflow run deploy-staging.yml --ref my-branch -f build=true
```

Without `--ref`, GitHub reads the workflow _definition_ and renders the spec from
the default branch, and the `version` **input** selects which already-published
image to deploy. With `--ref`, both the definition and the spec come from that
ref — and `build=true` makes the images come from it too.

Watch the run:

```bash
gh run list --workflow=deploy-staging.yml --limit 3
gh run watch "$(gh run list --workflow=deploy-staging.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
```

What the run does, in order (all on a `self-hosted` runner, in the `staging`
environment, under the `staging-deploy` concurrency group): optionally **build**
the branch's core and bundle images (only when `build: true`; skipped otherwise,
which is why the deploy job runs on `always()`) → **preflight** the
prerequisites → authenticate to GCP (via `GCP_SA_KEY`) → read `strad-staging-*`
from Secret Manager (masked, into
`$GITHUB_ENV`) → **render the App Platform spec** with `scripts/render-spec.ts`
from `infra/strad.staging.yaml` (`--image ghcr.io/tadasant/strad:<version>`, plus
`--bundle-image` when a branch was built, `--app strad-staging`, `--region nyc`,
`--domain staging.strad.tadasant.com`) to
`/tmp/spec.json`, which is **never echoed** because it inlines secret values →
attach the durable GHCR pull credential → install `doctl` → `doctl apps
create/update --spec /tmp/spec.json --wait` for `strad-staging` → **smoke-test**
the live host.

## Verifying the deployed app

Staging is on the open internet, so you can verify it directly — no tailnet
required. The live host is the App Platform default ingress (or the custom
domain):

```bash
# The workflow's own smoke test, reproduced. HOST is the DefaultIngress or the custom domain.
curl -fsS "$HOST/healthz" && echo "STAGING HEALTHY"
# The gate that is the whole point — unauthenticated /mcp must be 401:
test "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$HOST/mcp")" = 401 && echo "MCP GATED"
```

The deploy job runs exactly these two assertions at the end (`/healthz` up **and**
`/mcp` == `401`) and fails the run if either regresses. A green `Deploy staging`
run is therefore legitimate evidence the app is up and gated — **cite the green run
and link it.** After any deploy, also confirm the **custom domain**
(`staging.strad.tadasant.com`) still serves, since an App Platform spec update can
silently detach it (see the full-replace hazard above).

If your session cannot reach the host for some reason, say so rather than
pretending to verify — the workflow's smoke-test step is the fallback evidence.

## Rolling back

There is no "redeploy previous" button. Roll back by dispatching `Deploy staging`
again with an earlier, already-published tag:

```bash
gh workflow run deploy-staging.yml -f version=<known-good-tag>   # e.g. 0.1.5 or sha-<sha>
```

`release-image.yml` publishes `:sha-<sha>` on every release, so any past `main`
commit has a durable, addressable **core** image tag to roll back to.

The **bundle** does not roll back this way. `version` pins only the core; the
bundle image comes from `infra/strad.staging.yaml` (`strad-bundle:latest`) and the
workflow's `--bundle-image` override is used only for a branch build. Rolling the
core back far enough that it disagrees with the live bundle will produce routes
the bundle no longer serves. See `HACKS.md` #25.

## Production is NOT deployed from this repo

strad is the upstream OSS gateway, and it deploys **only staging**. Production
lives in the private **`tadasant/tadasant-internal`** repo as its own App Platform
app, which consumes the **published** `ghcr.io/tadasant/strad` image plus its own
internal config (private `builtin` modules, prod secrets) — it does not rebuild
from this repo's source. On each release, `release-image.yml` fires a best-effort
cross-repo `repository_dispatch` (`event_type: strad-image-published`, payload
`{ version, sha }`) to notify it; the OSS release never depends on that call
succeeding. **Do not look for a prod deploy here, and do not try to deploy prod
from this repo.** See `docs/src/content/docs/operate/deploy-model.md`.

## What an agent session cannot do

The session itself holds **no** DigitalOcean, GCP, or GHCR credentials — the runner
and the `staging` environment assume them. So a session **cannot** inspect the App
Platform app directly (no `doctl`/DO API calls, no reading GitHub Actions
secrets). Dispatch the workflow and read its logs; that is the supported path. A
session **can** curl the public staging host to confirm health and the `401` gate.
If you need something the workflow does not surface, flag the gap rather than
inventing credentials.

## Related

- `docs/src/content/docs/operate/deploy-model.md` — the image-vs-deployment seam,
  versioning, the secrets seam, and the App Platform hard-won facts.
- `docs/src/content/docs/operate/operations.md` — every workflow (`ci`,
  `release-image`, `deploy-staging`, `secrets-sync`) end to end.
- `HACKS.md` #18 — the custom-domain detach hazard.
- `infra/strad.staging.yaml` — the staging config that renders to the spec.
