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

Runs on PRs and pushes to `main`. Fourteen jobs, all `runs-on: self-hosted`:

- **`lint`** — typecheck, ESLint, `prettier --check`.
- **`test`** — `vitest`: unit tests plus a real-MCP-client, in-process E2E.
- **`good_eggs`** — `servers/**` is outside the core TypeScript program, and the
  good-eggs image only builds on push, so a PR could otherwise break that server
  without CI noticing. This job builds it and runs its browser-free MCP-App gating
  tests.
- **`fetchpet`** — the same shape as `good_eggs`, for the `fetchpet` server tree.
  fetchpet drives a login form nobody here controls, and a redesign of it took the
  mount down in both environments — it listed its four tools and failed every call
  for weeks. Its tests run over a fake browser: they pin the login selectors against
  the form Fetch actually serves, and prove a failed login is retried on the next
  tool call rather than cached for the life of the container.
- **`secrets`** — the same shape as `good_eggs`, for the `secrets` server tree. Its
  tests _are_ the security review: they drive the server through a real MCP client
  against a fake Parameter Manager that models the two-store split, and assert that
  no tool can return a secret value and that the viewer credential cannot reach one.
  They also pin the capability probe's permission strings, because the whole tool
  surface is derived from them and a name Google does not recognise reads as "not
  granted" rather than as an error — see [Secrets IAM](/operate/secrets-iam/).
- **`remote_filesystem`** — the same shape as `good_eggs`, for the
  `remote-filesystem` server tree. Its whole product is the link it hands a human,
  and its tests pin the two things that decide one: `is_sensitive` picks the kind of
  link, and GCS's 7-day V4 ceiling is what forces V2 for the 14-day default.
- **`bundle_api`** — `npm ci`, `npm run build`, `npm test` over the `bundle-api`
  tree. Five of its six servers are verbatim vendor copies and get no tests here,
  for the reason the `onepassword` job below spells out. The sixth, `slack`, is a
  **fork** — see [limitations #55](/limitations/#55-the-slack-server-is-a-fork-and-only-its-tests-defend-the-delta).
  Slack renders mrkdwn, mrkdwn is not Markdown, `~text~` is strikethrough, and a
  message using `~` for "approximately" posts successfully with paragraphs struck
  out. The fork's write tools lead with that rule and warn in the tool result
  after the fact. That delta has no sync script and no upstream to diff against,
  so its tests are what stops a re-vendor from silently reverting it.
- **`onepassword`** and **`pointsyeah`** — build-only jobs, one per tree: `npm ci`
  then `npm run build`, which is `tsc` over every workspace in the ordering the
  image's Dockerfile uses. There is no test step, and that is deliberate: the
  `shared/` half of each tree is a verbatim vendor copy of `pulsemcp/mcp-servers`,
  so a test written here would become a merge conflict on every re-vendor. A test
  for that logic belongs upstream. What the build catches is a type error —
  including one in 1Password's `shared/src/tools/sanitize.ts`, which is credential
  redaction — at PR time rather than at bundle-image build time.
- **`bundle_image`** — builds `servers/bundle/Dockerfile`, **boots the container**,
  and runs `scripts/smoke.mjs` against every mount of the running image, asserting
  the full-capability tool count for each (slack 9, tailscale 15, monarch-money 23,
  gmail 8, google-docs 11, google-calendar 7, 1Password 9, secrets 4, …). Those
  counts are the numbers the gateway's read-only allow-lists are carved out of, so
  if an upstream grows or renames a tool, this is where it surfaces. For `secrets`
  the count of 4 is a security assertion: a fifth tool on a server whose contract is
  "no tool returns a secret value" is what CI should catch. It also asserts the `op`
  CLI is really in the image.

  This job is also where the configs meet the tools. It dumps every mount's real
  tool **names** (`smoke.mjs --json`) and runs
  [`check-tool-policy`](/operate/deploy-model/#checking-a-tools-policy-against-the-tools-that-exist)
  over every config in the repo, so a `tools: allow` entry naming a tool no mount
  serves fails the PR instead of silently narrowing that slug's surface in
  production. A slug it cannot enumerate is skipped and named, never failed.

- **`verify_lockfile`** — `npm install --package-lock-only` then
  `git diff --exit-code`, so `package-lock.json` can't drift.
- **`build_image`** — builds the core Docker image, boots it with
  `STRAD_TOKENS='[]'`, and asserts two things: `/healthz` is up, and **`/mcp` with
  no token returns `401`**. That last check is _the_ test given strad's
  open-internet posture — an unauthenticated MCP endpoint that ever returned tools
  would be the whole ball game.
- **`config`** — runs [`check-config`](/operate/deploy-model/#checking-a-config-before-it-deploys)
  over `strad.config.yaml`, `strad.config.example.yaml` and
  `infra/strad.staging.yaml`. It needs no secrets, because the check substitutes a
  dummy value for every `${NAME}`. A key the schema does not define — `consoleEnvs:`
  for `consoleEnv:` — is stripped silently by Zod and does nothing at runtime, so
  this is the job that turns that into a failed PR.
- **`docs_site`** — `npm ci && npm run build` in `docs/`. The documentation site is
  meant to stay true commit-by-commit, so a broken link, bad frontmatter, or a page
  missing from the `sidebar` array fails the PR rather than the deploy.

<aside class="starlight-aside starlight-aside--note">

**Why `ci.yml`'s two docker jobs name everything per run.** `bundle_image` and
`build_image` both build an image and boot it, on a self-hosted box whose docker
daemon every concurrent job shares. So the container name, the image tag and the
host port are all suffixed or assigned per run: the tag is
`ci-<run id>-<run attempt>`, the container carries the same suffix, and the port
is published as `-p 127.0.0.1::8080` and read back with `docker port`, rather than
bound to a fixed `-p 8080:8080`.

Two of the three failures that prevents are loud — a duplicate `--name`, a bound
host port — and the third is not. Given a shared `strad:ci`, a concurrent job can
rebuild that tag between our build and our `docker run`, and then the `/mcp`
returns-`401` assertion, which is _the_ test in this repo, runs against someone
else's image and passes. Nothing errors. The same shared name also means the
`if: always()` teardown reaps a container another job is still testing.
`test/ci-workflow.isolation.test.ts` reads the workflow as text and fails the PR
that puts any of those identifiers back.

The port readback is the one part that could fail quietly, so it doesn't: an empty
or non-numeric answer from `docker port` fails the step by name instead of
degrading into a `curl` connection-refused against a malformed URL. Binding to
`127.0.0.1` rather than every interface is what keeps that answer to one line, and
keeps a booted gateway off the runner box's public address.

What per-run names cost is the fixed names' one accidental virtue: a leaked
`bundle-ci` was reaped by the next run that wanted that name, and nothing wants
`bundle-ci-<run>`. So teardown deletes this run's container and this run's image
(buildx's cache is not the daemon's image store, so nothing rebuilds slower for
it), and each job opens by pruning anything labelled `strad-ci` that a run over a
day old left behind — far longer than any job here runs, so the sweep can never
reach a concurrent one.

`bundle-google-ci.yml`, the [second CI workflow](#the-image-workflows), names its
container and its image the same way, for the same reasons. It publishes no host
port, so only the other two failures apply there.

</aside>

<aside class="starlight-aside starlight-aside--note">

**Why every job names the buildx builder it builds on.** The container, the tag
and the port are the shared names a workflow can see. `~/.docker/buildx/current`
is the one it cannot. `docker/setup-buildx-action` defaults to `use: true`, which
means `docker buildx create --use`, which writes that file — and there is one of
it per machine, because every job runs as the same user. A `docker buildx build`
with no `--builder` reads it, so a build lands in whichever job on the box
created a builder most recently, and dies with `graceful_stop` when that job's
post-cleanup removes it mid-stream. That took `main` red on 2026-08-11.

The builder each job creates is a uuid and never collides, which is exactly what
hid this: nothing collides, nothing errors until the unrelated job finishes. So
every job here sets up buildx with `use: false` — never writing the pointer — and
every build step passes `builder: ${{ steps.buildx.outputs.name }}` — never
reading it. `.github/actions/build-push` takes the builder as an input and fails
before its first attempt if a call site omits it, because an omitted input
interpolates to the empty string and reads as "no `--builder`".
`test/workflow-buildx-builder.test.ts` parses every workflow and every local
action, and fails the PR that drops either half. See
[limitations #53](/limitations/#53-the-buildx-builder-is-a-box-wide-name-and-nothing-in-a-workflow-says-so).

</aside>

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
3. Go back to the registry and check that all three tags resolve to the digest
   that was just built.
4. Fire the cross-repo `repository_dispatch` to `tadasant-internal`
   (best-effort).
5. Call `deploy-staging.yml` (`secrets: inherit`) with the new version.

`:latest` is mutable, and what a platform does with a mutable tag is not
something the tag's publisher controls. A `:latest` that has drifted off the
commit it was built from boots old code against new config and rolls the deploy
back, hours later and far from the change that caused it. A release that pushed
successfully but left `:latest` somewhere else is a failed release, and step 3
makes the run go red.

That check guards the push. It cannot guard the pull — so **no deploy ships a
mutable tag at all**. See [which image a deploy
ships](#which-image-a-deploy-ships).

## `deploy-staging.yml` — put it on App Platform

A `workflow_call` + `workflow_dispatch` job in the `staging` environment. Its
defining idiom is the **preflight "safe no-op"**:

- On an **automatic** release, if prerequisites (`DIGITALOCEAN_ACCESS_TOKEN`,
  `GCP_SA_KEY`) are missing, it **skips and stays green**.
- A **manual** `workflow_dispatch` with the same gap **fails loudly**.

Three of its steps are `continue-on-error` reports — they exit non-zero and go
yellow rather than failing a deploy that is otherwise healthy. One runs before
the render; the other two run after the smoke test:

| Report                              | Answers                                                                                                                                                                                                                                               |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the parameter-store roster (before) | which names the gateway namespace holds, and which of them the resolver can actually render                                                                                                                                                           |
| **telemetry** (after)               | whether each component's exporter is being **accepted**. It greps that component's own run log for `telemetry.started` and for OTLP export failures, 45s after the deploy — one export interval is 15s, and a boot-only check would see none of this. |
| the secrets credentials (after)     | what each `secrets` key can do, probed the way the containers probe it                                                                                                                                                                                |

The telemetry one exists because a component with an endpoint and no auth header
boots perfectly and is refused on every batch, about a minute later, with nothing
else in the job noticing — see [Known limitations](/limitations/) #38.

### The rendered spec is job-private, and checked before the PUT

The deploy renders a spec to a file and hands that file to `doctl` several steps
later. Two things make that handoff safe, and both were added after it failed.

**The file lives in `$RUNNER_TEMP`, not `/tmp`.** `runs-on: self-hosted` means
several runner _processes_ share one machine, and they share `/tmp` with each
other. This repo's staging deploy and tadasant-internal's prod deploy both wrote
`/tmp/spec.json`, and on 2026-08-06 they overlapped on the same box: prod's
render opened that path for writing and truncated staging's finished spec, and
staging's `doctl apps update` read the empty file 1.3 seconds later. `runner.temp`
is per runner installation and emptied between jobs, so no other job can name it.

**The spec is asserted immediately before `doctl` reads it**, by
`scripts/assert-spec.ts` (`src/deploy/spec-file.ts`) — once after the render, for
attribution, and once in the deploy step. It checks the file parses, carries a
non-empty top-level `name`, has components, and **names the app this job set out
to deploy**. That last check is the important one: an empty spec is merely a
failed deploy, but a _valid_ spec belonging to another deployment would have
pushed prod's images and prod's secrets onto staging and gone green.

Neither guard is visible in a healthy run. See
[Known limitations](/limitations/) #47 for what the failure looked like.

### Which image a deploy ships

A deploy never hands App Platform a mutable tag — for **either** image. There are
two, they are resolved separately, and both end up naming one commit.

#### The core image

The core image comes from the first of these that applies:

1. **A branch build** (`build: true`) — the `branch-<slug>-<sha>` tag it just
   pushed.
2. **An explicit `version` input** — `ghcr.io/tadasant/strad:<version>`. This is
   the release path, and it is how you pin a rollback. It pins the core only —
   the bundle is still resolved below, so a rollback taken while a bundle build
   is in flight wants `bundle_version` too.
3. **Otherwise, `sha-<commit>`**, resolved from the checked-out history by
   `scripts/resolve-image-tag.ts`.

There is deliberately no fallback past those three: `render-spec` refuses a core
image on `latest` (or `main`, `edge`, `stable`, or a tag-less ref, which means
`latest`), so a gap fails the deploy instead of shipping an unknown image.

Step 3 walks back through first-parent history, but **only past docs-only
commits**. `release-image.yml` ignores `**/*.md` and `docs/**`, so a docs-only
merge advances `main` without cutting an image, and stepping over one is safe —
the newest ancestor that did publish is the code that should be running anyway.
The step says how far back it went.

A commit that changed **code** and has no image is a **hard stop**, not another
step back. A missing tag there means `release-image.yml` is still building or has
failed, and deploying the previous commit's image against this commit's config is
exactly the new-config-meets-old-code skew this whole path exists to prevent. The
deploy fails and tells you to wait for the release or pass an explicit `version`.
A registry it cannot read is likewise an error, never a silent walk-back to
something older.

The core recovers from a failed release on its own, which is why its remedy stops
there. `release-image.yml` builds every non-docs commit, so the commit that fixes
a broken build is itself a commit that publishes, and the walk stops on it. The
bundle has no such property — see [when the bundle build
failed](#when-the-bundle-build-failed-dispatch-it-rather-than-re-run-it) below.

The walk asks what a commit changed **only** about a commit the registry has no
image for, and only until it stops — so on a healthy `main` it runs no diff at
all, because HEAD published. That matters beyond speed: it means a commit the
walk never reaches cannot fail the deploy. Classifying the whole window up front
did exactly that, dying on the repo's root commit (`git diff <root>^1 <root>` is
a fatal) while already holding HEAD's image as the answer.
A root commit is read as its whole tree, which is what it introduced. A
commit whose parent is simply **not in the checkout** — the edge of a shallow
`fetch-depth` — is unknowable rather than docs-only, so the step says so and
stops instead of stepping past a commit nothing can vouch for.

**Why.** Dispatching this workflow on `main` at 96015c6 shipped `:latest` and the
container booted code from before PR #26 — it rejected the current
`infra/strad.staging.yaml` with a `each must serve a distinct path` rule that
commit had deleted three weeks earlier, and staging went down. The same commit
had deployed cleanly on `:0.1.38` hours before, and pinning `:0.1.33` brought it
straight back.

Re-cutting the release does not fix it. `release-image.yml` ran on `main` at
96015c6 and its verify step confirmed `:<version>`, `:latest` and `:sha-<sha>`
all resolved to one digest at push time; eleven hours later `:latest` was serving
pre-#26 code again, with nothing in this repo having written the tag in between.
Whatever moves it is external, so this repo cannot make `:latest` trustworthy —
only stop depending on it. A tag that names one commit has no "most recent" for
anything to disagree about.

#### The bundle image

The same three-step precedence, one image over:

1. **A branch build** (`build: true`) — the `branch-<slug>-<sha>` bundle it just
   pushed.
2. **An explicit `bundle_version` input** — `ghcr.io/tadasant/strad-bundle:<tag>`.
   This is how you pin or roll back the bundle half on its own; `version` pins
   the core and says nothing about this one.
3. **Otherwise, `sha-<commit>`**, resolved by the same
   `scripts/resolve-image-tag.ts` with `--kind bundle`.

There is no `latest` fallback left here either. The deploy always passes
`--bundle-image` and `--require-immutable-images`, which makes `render-spec`
refuse to emit a spec in which **any** component ships a tag that moves.

Step 3 also **waits**, which the core's does not need to. `release-image.yml`
pushes the core and then calls the deploy, in that order, in one workflow;
`release-bundle-image.yml` is a separate trigger on the same push and takes
several minutes longer. So on a merge that touches a baked tree, the bundle's
`sha-<commit>` does not exist yet when the deploy starts, and without a wait
every such merge would deploy red. The step re-asks for up to 15 minutes before
it gives up — only in the case that would otherwise be a hard stop.

The wait assumes the image is **coming**. When it is not — the run that owed it
has already finished without publishing — the step asks the Actions API for that
run's state and stops immediately, with the run's URL, rather than spending the
budget on a build that ended before the deploy began. A run still queued or in
flight is exactly what the wait is for, and is left alone. The lookup needs
`actions: read`, which `deploy-staging.yml` requests and every caller of it has
to grant as well; without it the step falls back to waiting out the budget, which
is what it did before. Either way the deploy stays stopped until an image exists —
see [when the bundle build failed](#when-the-bundle-build-failed-dispatch-it-rather-than-re-run-it)
below for the move that publishes one.

The walk-back rule is the one thing that differs from the core, and it is
inverted. `release-image.yml` builds every commit except docs-only ones;
`release-bundle-image.yml` has a `paths:` filter — twelve entries: the ten trees
the Dockerfile bakes, the bundle host, and the workflow itself — so **most**
commits cut no bundle image and stepping past them is the normal case, not an
exception. `--kind bundle` reads that filter out of
the workflow rather than keeping a second copy of the list. A commit that **did**
touch a baked tree and has no image is still a hard stop, for the same reason as
the core.

**Why.** On 2026-07-31, `POST /mcp?servers=secrets` returned `200 {"tools":[]}`
on staging and prod, and had never returned anything else in any window the
telemetry could see. The `secrets` server serves four tools with no credential at
all, so an empty list meant the upstream call failed —
`strad_mcp_upstream_errors_total{mcp_upstream_op="connect"}` equalled the request
count exactly.

The bundle container was healthy and 32 hours old. Its own boot line was the only
thing that said what was wrong:

```
streamable-HTTP on :8080 — 14 servers: /slack … /onepassword /good-eggs /fetchpet /pointsyeah
```

Fourteen mounts, not fifteen: no `/secrets`, and `/remote-filesystem` under the
slug PR #33 had renamed it away from a week earlier. Core POSTed `initialize` to
`/secrets`, Express answered 404, and the gateway turned a dead upstream into an
empty tool list.

`strad-bundle:latest` is written into all 27 `supplementary-image` entries, so
those components' image block was byte-identical on every deploy and App Platform
kept serving the digest it had resolved for that tag once —
`sha256:6bb4e861…` on every `main` deploy for days, including one that had
finished twenty minutes before this was diagnosed, while
`release-bundle-image.yml` pushed three fresh `:latest` images that same day. The
tag being fresh in the registry never mattered: what App Platform serves for a
mutable tag is not decided by what the registry holds.

Three slugs were dead, not one — `secrets`, `zimmer-secrets` (its own component,
same image, same cached digest) and `remote-filesystem-tmp-public`, whose path
that same PR had renamed.

##### When the bundle build FAILED, dispatch it rather than re-run it

A build that is **late** and a build that **failed** take different moves, and the
wrong one loops. A re-run replays the workflow at the commit that failed, so a
commit whose own source broke the build fails again and the tag it owes can never
appear. The core survives that, because every non-docs commit publishes: the
commit that fixes the build is itself the commit the walk stops on. The bundle
does not, because most commits cut no bundle image — so a fix that touches no
baked tree rebuilds nothing, and the failed commit stays the newest one owing an
image, hard-stopping every deploy from then on.

`release-bundle-image.yml` carries `workflow_dispatch` and refuses any ref but
`main`, so the way out is to **dispatch it on `main`**. That publishes an image
for HEAD, which is where the walk starts, so it resolves at distance 0 and the
commit that owes an image is never asked about. This is also why the hard stop's
own message names a dispatch and not a re-run.

**Why.** `450ad5cb` put a `${{ }}` expression inside a `description:` in
`.github/actions/build-push/action.yml`. GitHub parses expressions in an action
manifest even inside a doc string, so all eight release workflows failed the
moment they reached that action — and that commit had edited
`release-bundle-image.yml`, one of the paths the bundle watches, so it owed an
image and published none. `6d2dd228` fixed the manifest and touched no baked
tree, so no bundle build fired. `450ad5cb` stayed the newest commit owing a
bundle image, and every `Deploy strad production` walked back to it, waited out
the full fifteen minutes, and hard-stopped — until `release-bundle-image.yml` was
dispatched on `main`.

That split is deliberate: an automatic release shouldn't turn red just because the
account isn't seeded yet, but a human asking for a deploy should hear "no." When
prerequisites are present it: authenticates to GCP
(`google-github-actions/auth@v2`, preferring Workload Identity Federation, falling
back to `GCP_SA_KEY`), installs `gcloud`, reads `strad-staging-*` from Secret
Manager (masked, into `$GITHUB_ENV` — same skip-vs-error split if none are found),
installs `doctl`, resolves both image tags, renders the spec to
`$RUNNER_TEMP/spec.json` (never echoed), attaches a durable
GHCR pull credential, asserts the spec is still the one this job
rendered, runs `doctl apps create/update --spec … --wait` for
`strad-staging`, and finally smoke-tests the live host (`/healthz` up, `/mcp` ==
`401`, and **every slug we deploy actually serving tools**). The last of those
reads `/healthz`'s `toolSurfaces` and polls for up to three minutes, because core
comes up before the bundles do. A `supplementary-image` or bundle-hosted
`builtin` still `unreachable` at the end fails the deploy; a third-party
`remote-http` that is merely having a bad afternoon, and any slug that
_answers_ with no tools, are annotated instead — the credential story has its own
non-gating report further down. That check exists because a green deploy of a
healthy app once left three slugs serving nothing at all — see
[Known limitations](/limitations/).

**Before it renders, it reports what the parameter store holds.** Every deploy
runs `store:check --mode report --resolve` over
`/strad/staging/gateway/static/` and prints the roster: every name this
deployment would read from the store, which of them are seeded, and — the part
nothing else answers — which of the seeded ones the resolver credential can
actually `:render`. Presence is not resolvability, and a namespace can be
complete and still resolve to nothing.

It is **report mode and non-fatal**, and on a store-backed staging that is a
deliberate choice rather than a stage of the migration. `--mode require` counts the
22 supplementary `env:` names too, and those are still resolved from the deploy
environment on purpose, so requiring them would fail every deploy over a decision
nobody has taken. Nothing load-bearing rests on this step's exit code either way:
`render-spec`'s own preflight fails closed on the names that must be in the store.
The point is to make the roster visible on every run rather than only when someone
remembers to look — the migration's blind spot was never the check. Move it to
`--mode require` and drop `continue-on-error` when the supplementary names move
into the store too.

It prints names, counts and states, and no value in any mode. Exit 3 is "the store
could not be consulted at all", which on a store-backed deployment means the
resolver credential itself has stopped working — the step says so as an error
rather than softening it.

The roster has a third column now: **served per-server**. A supplementary `env:`
name that every referencing server holds under its own
`/strad/{env}/mcp/{slug}/static/` is listed there rather than as missing — the
deployment resolves it, this namespace is simply not where. See [two servers, one
variable name](/operate/secrets/#two-servers-one-variable-name).

## Seeding the store from the deploy environment

`scripts/seed-store.ts` moves a deployment's `${NAME}` values out of the deploy
environment and into `/strad/{env}/gateway/static/`, which is the one-time step the
provider flip needs and which nothing else can do: the console is SSO-gated and
per-value, and the `secrets` MCP server is fenced out of the gateway namespace on
purpose. It runs from `deploy-staging.yml`, is **dry-run unless `--commit`**, skips
names the store already holds unless `--rotate`, and reads back everything it
writes through `:render` — comparing by SHA-256, because a value that stores fine
and cannot render is the failure that takes a whole namespace down.

Seven dispatch inputs drive it, all off by default:

| Input         | What it does                                                                |
| ------------- | --------------------------------------------------------------------------- |
| `seed`        | Run the seeder before rendering. Off on every ordinary deploy.              |
| `seed_rotate` | Overwrite names the store already holds instead of skipping them.           |
| `seed_set`    | An extra `NAME=VALUE` the environment does not carry.                       |
| `seed_delete` | Comma-separated names to REMOVE from the gateway namespace.                 |
| `seed_names`  | Comma-separated: seed ONLY these names (`--only`).                          |
| `seed_except` | Comma-separated: seed everything EXCEPT these (`--exclude`).                |
| `seed_only`   | Seed and stop — no image-tag resolve, no render, no deploy. Implies `seed`. |

`seed_only` is what lets the store change **under a running gateway**: an ordinary
deploy restarts the process, which destroys the thing a rotation test is trying to
observe.

**`seed_names` is not `seed_only`.** One says which NAMES to seed, the other says
which STEPS to run, and they are dispatched from the same form. The script's own
flags are `--only` and `--exclude`; the inputs are named apart from them so the
two questions cannot be confused in the one place they are asked together.

### Scoping a seeding run

`--only NAME` and `--exclude NAME` (repeatable) narrow a run to a subset of the
derived set. They exist because the read side is all-or-nothing — `resolve()`
renders a namespace as a unit and throws as a unit
([limitation #36](/limitations/#36-one-un-renderable-parameter-makes-the-whole-gateway-namespace-resolve-to-nothing))
— so without a scope, an operator who wants one name handled apart from the rest
has to seed it and then `--delete` it back out.

They are **mutually exclusive**, and they disagree about an unmatched name on
purpose: `--only NOPE` is an error, because the caller named something to seed
that would not be seeded, while `--exclude NOPE` is a note, because the caller
asked for a name not to be seeded and it will not be.

Two things a scope deliberately does not narrow:

- **`--delete`.** Already explicit, every name spelled out, so there is nothing to
  narrow — and a scope that filtered it could silently disarm a deletion.
- **The read-back.** The verify step resolves the whole namespace, because that is
  what the gateway reads. A scoped run whose own names round-trip can still fail
  on a name it never touched, and it should: that failure is the true statement
  that this gateway would come up with nothing. It runs on every `--commit`, even
  one that writes nothing because its names were already seeded — re-running a
  scoped seed to ask "does this namespace render" is a thing operators do, and it
  has to answer.

A scoped run says so in its header (`3 of 8 name(s) … — SCOPED by --only`) and
lists what it held back, so it cannot be misread later as a complete one.

**`seed_set` is for non-secret canaries only.** Its value passes through a workflow
input and is echoed in the run's log — the masking applied to Secret Manager values
does not cover it. Never put a credential there. `seed_names` and `seed_except`
carry the same hazard for the same reason: they are echoed as names, so a value
pasted into one by mistake lands in the log. They take NAMES, never values.

`seed_names` and `seed_except` do nothing on their own — like `seed_set` and
`seed_delete`, they only apply to a run that `seed` (or `seed_only`) turned on.

**Then it reports what the secrets credentials can do.** The secrets surfaces are
probe-derived — the MCP server lists `get_secret_value` and the write tools only
if its credential holds the permissions, and the console offers reveal on the same
basis — so a grant that did not land looks exactly like a deliberate narrowing:
nothing errors, the surface is just smaller. The step runs
`scripts/probe-capabilities.ts` (the same probe the containers run, see
[Secrets IAM](/operate/secrets-iam/)) against both staging keys and prints five
booleans each. It is **non-fatal**: a narrow credential is a legitimate posture —
it is prod's — so this reports and never gates. It prints booleans only; the keys
are read from the environment and never echoed, and `testIamPermissions` returns
no secret material. A probe that cannot complete emits a `::warning::`, which is
almost always `cloudresourcemanager.googleapis.com` not being enabled on the
project rather than anything about the grant.

If any of that fails, a last step dumps the `core` and `bundle` containers' own
logs for the newest deployment. App Platform reports only which component exited
non-zero, never why; the why is in the container's log. The step never fails the
job — the deploy already did — it only adds the evidence.

It covers every failure from the secrets read onward, which is why `doctl` is
installed there rather than beside the deploy that first uses it. When it cannot
reach the API — no `doctl` on `PATH`, an `apps list` that errors — it says so
and stops, rather than reporting "no strad-staging app". Every way of failing to
ask lands in the same empty result as a genuinely absent app, and the difference
matters most on exactly the failures this step exists for.

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
on `main` with `build` left off. It renders `main`'s config against the
`sha-<commit>` image built for that commit — so the next merge to `main` restores
staging on its own regardless.

<aside class="starlight-aside starlight-aside--caution">

Never push a branch bundle to `strad-bundle:latest`. It is the tag the config's
`image:` lines still name, so anything that resolves it — a fresh App Platform
deploy, a `docker pull`, a human checking what shipped — would get a bundle whose
mounts have moved out from under the routes the deployed spec carries. Build and
deploy have to happen together, which is what the `build: true` dispatch does.

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

| Workflow                        | Publishes                                        | Triggered by a change under                                                                                                                                                     |
| ------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `release-image.yml`             | `ghcr.io/tadasant/strad`                         | the repo root / `src/`                                                                                                                                                          |
| `release-bundle-image.yml`      | `ghcr.io/tadasant/strad-bundle` — **the** bundle | `servers/bundle/`, `servers/bundle-api/`, `servers/onepassword/`, `servers/secrets/`, `servers/good-eggs/`, `servers/fetchpet/`, `servers/pointsyeah/`, `images/bundle-google/` |
| `release-bundle-api-image.yml`  | `ghcr.io/tadasant/strad-bundle-api`              | `servers/bundle-api/`                                                                                                                                                           |
| `release-goodeggs-image.yml`    | `ghcr.io/tadasant/strad-server-good-eggs`        | `servers/good-eggs/`                                                                                                                                                            |
| `release-fetchpet-image.yml`    | `ghcr.io/tadasant/strad-server-fetchpet`         | `servers/fetchpet/`                                                                                                                                                             |
| `release-pointsyeah-image.yml`  | `ghcr.io/tadasant/strad-server-pointsyeah`       | `servers/pointsyeah/`                                                                                                                                                           |
| `release-onepassword-image.yml` | `ghcr.io/tadasant/strad-server-onepassword`      | `servers/onepassword/`                                                                                                                                                          |
| `bundle-google-release.yml`     | `ghcr.io/tadasant/strad-server-bundle-google`    | `images/bundle-google/`                                                                                                                                                         |

Everything below `release-bundle-image.yml` in that table is a **per-server image
that staging no longer deploys** — staging runs the one collapsed bundle. They are
still built and still pushed on purpose: production, in `tadasant-internal`, has not
been re-pointed at the collapsed bundle yet, and its spec still names those
repositories. Deleting them before prod moves would be an outage, not a cleanup.
See [Known limitations](/limitations/).

`bundle-google-ci.yml` is the second CI workflow: it builds and smoke-tests the
`bundle-google` image on any PR touching `images/bundle-google/`.

<aside class="starlight-aside starlight-aside--note">

**Why it names its container and its image per run.** Like every other job here
it is `runs-on: self-hosted`, and its concurrency group is per-ref — so two PRs
run it at the same time, on one box, against one docker daemon. So the container
name and the image tag both carry `ci-<run id>-<run attempt>`:
`strad-server-bundle-google:ci-…` and `bundle-google-ci-…`.

Two failures follow from a shared name, and one of them is loud: a duplicate
`--name`, or an `if: always()` teardown deleting the container a concurrent job is
still testing. The other is not. Given a shared `strad-server-bundle-google:ci`, a
concurrent job can rebuild that tag between this job's build and its `docker run`,
and the smoke test then enumerates three mounts of an image this PR never built,
and passes. Nothing errors.
`test/bundle-google-workflow.isolation.test.ts` reads the workflow as text and
fails the PR that puts either identifier back.

A third failure in the same class does not arise here: two jobs competing for one
fixed `-p 8080:8080`. This job publishes no host port at all, because the health
probe is node's `fetch` and the smoke client both run inside the container.

What per-run names cost is the fixed names' one accidental virtue: a leaked
`bundle-google-ci` was reaped by the next run that wanted that name, and nothing
will ever want `bundle-google-ci-<run>`. So teardown deletes this run's container
and this run's image (buildx's cache is not the daemon's image store, so nothing
rebuilds slower for it), and the job opens by sweeping anything labelled
`strad-ci` that a run over a day old left behind — far longer than any job here
runs, so the sweep can never reach a concurrent one. The sweep is in two halves,
because `docker container prune` reaps only STOPPED containers and the leak worth
reclaiming is the opposite: a teardown that never ran because the runner was
killed leaves its container UP, and a running container pins its image against the
image prune as well. So the workflow lists running containers by label and checks
their age itself — `docker ps` has no `until` filter — and then prunes the stopped
ones and the images.

</aside>

### Every push to ghcr is retried

No step in this repo pushes to ghcr with `docker/build-push-action` directly.
Each one goes through `.github/actions/build-push`, a composite action that runs
the identical build up to three times, 15s and 45s apart, and lets the third
decide the run.

ghcr answers a blob `HEAD` with `403 Forbidden` from time to time, in the middle
of a push whose credentials worked seconds earlier — the build is done, the layers
are exported, and one blob is refused. Neither buildkit nor the action retries a
403, so a single refused blob turns a good release red and waits for a human to
click re-run. On the retry the layers are in the runner's buildkit cache, so it
re-pushes rather than rebuilds.

It cannot tell a refused blob from a broken `Dockerfile`; both are just a failed
step. A failed BUILD is therefore rebuilt on every attempt — buildkit does not
cache a failed layer — so a broken bundle costs minutes before it goes red. And
three `build/push attempt N failed` warnings carrying the same 403 mean the
registry is refusing rather than flaking: the next place to look is the package's
visibility and linked repository, not the re-run button. See
[Known limitations](/limitations/).

The four `docker/build-push-action` steps that remain direct
(`release-onepassword-image.yml`'s verification build, `bundle-google-ci.yml`,
and two in `ci.yml`) build with `push: false`. They never touch a registry, so
there is nothing there to flake.

Nothing on the PR path loads the wrapper, so `ci.yml`'s `lint` job runs
`actionlint` over every workflow to catch a malformed `action.yml` before the
next release. Know what that does and does not buy: actionlint validates an
action's INTERFACE, and does not evaluate the prose in it. The runner
template-parses the entire manifest when it loads it, so a `${{ … }}` written as
an EXAMPLE in an input `description:` is evaluated against a scope that has no
`steps` — the action then fails to LOAD, and every step calling it fails
instantly. That reddened all eight release workflows at once on 2026-08-11, green
actionlint and all. `test/workflow-buildx-builder.test.ts` is what covers it: no
`${{` in the `name:` or `description:` of any local action manifest. See
[Known limitations](/limitations/).

## The staging config

`infra/strad.staging.yaml` is the live staging config, and it deliberately
exercises all three server kinds so the deploy path is proven end-to-end. It
declares twenty-nine server slugs:

- `echo` — a `builtin` in `core`, in-process.
- `deepwiki` — a `remote-http` server (`https://mcp.deepwiki.com/mcp`), a
  credential-free canary.
- twenty-six `supplementary-image` entries on the one `bundle` component running
  `ghcr.io/tadasant/strad-bundle`. They land on the bundle image's seventeen mounts,
  because a read-only and a read-write variant of one upstream are two entries
  sharing one `path`. Two of them — `telegram-ro` and `telegram-rw` — carry
  `enabled: false` until their secrets are seeded, so they are skipped at render;
  see [Telegram](/servers/telegram/#not-configured-is-a-supported-state).
- `zimmer-secrets` — a twenty-seventh `supplementary-image` entry, running that same
  image on its **own** component, `bundle-zimmer-secrets`. It is the only server
  that leaves the one bundle, and the only reason to leave it: a parameter store is
  `process.env`. See [Two stores, one
  gateway](/operate/secrets/#two-stores-one-gateway).

Roles are `admin: ["*"]`, a deliberately narrow `echo-only: [echo]` — which
keeps the [424 fail-closed path](/intro/concepts/#the-424-contract) meaningful —
and `zimmer: [zimmer-secrets, secrets, echo]`, the role Zimmer's own sessions
hold. `google.enabled` is `false` (it flips true when OAuth creds land) and
`consoleDevBypass.enabled` is `true`.

The breadth of `zimmer` is a security decision rather than a default, and it is
asserted rather than described. Twenty-one of staging's slugs carry a real
third-party credential, backed by the **same accounts prod uses** — one Slack
workspace, one Gmail tenant, one 1Password service account — so `admin` there
would be a far larger grant than it looks. The three it does name are bounded
rather than harmless: `zimmer-secrets` and `secrets` are two **separate GCP
projects**, each fenced again by its own `SECRETS_NAMESPACES`, and `echo` is a
builtin with no credential at all. Both stores hold per-server credentials and
staging's `secrets` key can read a secret value, so "separate project plus fence"
is the claim, not "nothing sensitive".
`test/staging-config.test.ts` asserts the list from both directions, because
entitlement is an intersection and a slug could otherwise add `zimmer` to its own
`entitlements:` unnoticed.

`echo` carries `params: true`, which makes it the deployment's **rotation
observatory**. A builtin with `params: true` re-resolves
`/strad/staging/mcp/echo/static/*` over its `options:` on every tool call, through
the same TTL cache the runtime secret provider uses, so `whoami` reports what a
running gateway currently resolves. Nothing else in this config is observable that
way — a supplementary image's `env:` and its two boot keys are baked at render
time, and the core's boot keys are read once at startup — so without it, "a
rotated secret takes effect without a redeploy" can be asserted but not watched.
It is inert on a deployment with no resolver credential: `Registry.build` gets a
null resolver and skips the merge. Point that parameter at a canary and never at a
credential; it is returned over `/mcp` verbatim to anyone entitled to the slug.

Take that literally when reading a config that is not this one. A deployment with
no `params: true` server and no request-path `${NAME}` on a reachable server has
**nothing** that rotates within `ttlSeconds`, whatever the TTL says; every name it
holds is a restart or a deploy. [What rotates
live](/operate/secrets/#what-rotates-live-what-needs-a-restart-and-what-needs-a-redeploy)
is the table to check before telling anyone a rotation will land on its own.

The `secrets` entry gives its two halves **different** namespace lists on purpose:
the console (`consoleEnv:`) manages `/strad/staging/mcp/` and
`/strad/staging/gateway/static/`, the MCP container (`env:`) only the first. A
an agent cannot enumerate the deployment's own `${NAME}` references. On the
console side the list is only a set of suggestions — the field is free text
unless `SECRETS_NAMESPACES_STRICT` is set.

`test/staging-config.test.ts` is the guard on all of this: it asserts the config
renders to exactly `["core", "bundle", "bundle-zimmer-secrets"]`, that the bundle
is `apps-s-1vcpu-2gb`, that no server carries a container-side capability toggle,
and that each read-only allow-list is a subset of the tier above it. A fourth
component appearing there is a billed regression, which is why the list is pinned
rather than counted. `test/staging-config.multi-store.test.ts` is the guard on the
second store specifically: which project, namespace and credential land on which
component, and which admin identity each console page resolves to.

## Health and console surface

- **`/`** is the front door: a server-rendered directory of the gateway's
  endpoint, its consoles, and every **enabled** server, with a copy button for
  each server's `?servers=` URL. Core-only — a bundle component is internal and
  has no front door. It sits behind the **same SSO gate as `/ui` and `/console`**,
  never a softer door: strad requires identity before exposing anything, and an
  index of what the gateway fronts is something. Today that means the bootstrap
  token; once `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` land it is Google sign-in
  restricted to the configured `auth.google.hostedDomain`, with no code change.
  Behind the gate it still withholds anything credential-shaped — a `remote-http`
  server's upstream `url`, `headers:`, the `env:` map, the `image` ref, `bundle`,
  `path`, `module`, `tools:` policy, and `entitlements` — as defence in depth.
  **Disabled** servers are omitted: the page answers "what can I connect to", and
  a connect URL for a disabled server is one the gateway would reject.
- **`/healthz`** is dependency-free and returns `mode`, `bundle`, `env`, and
  `servers` — used by the App Platform health check and the deploy smoke test. It
  also carries `toolSurfaces` and `degraded`: the last observation from the
  background tool-surface monitor, naming the slugs that are mounted but serving
  **no tools**, each with its `state` (`ok` / `empty` / `unreachable`), its tool
  count and its `kind`. Listing the slugs and stopping there was compatible with
  three of them being dead, which is exactly what happened. `ok` stays `true`
  regardless — this route is liveness, and a sick upstream is not a reason for
  App Platform to restart core. The values are read, never computed on request,
  so the route stays instant, and no upstream-authored text appears in them: a
  state word, a count and a kind, about slugs this route already named.
- **`/mcp`** is handled by `app.all("/mcp", …)` and always requires a token.
- **`/console`**, `/console/login`, `/console/oauth/callback` and
  `/console/logout` are mounted only in `core` mode. Login state — the PKCE
  verifier, the CSRF `state`, the return path — is a signed 10-minute cookie, not
  a server-side map, so the console survives a restart and spans replicas. See
  [Auth](/auth/overview/#the-sign-in-round-trip).
- **`/ui`** and `/ui/:server`, also core-only, are the human-facing server console,
  behind the same gate as `/`. `/ui` carries the secret roster — a `READY` or
  `ISSUE` badge per entry — and `/secrets` 302s to it. An entry carries up to two
  controls, on two different rules: a link to that server's playground, on the
  entries this console identity may actually open (see
  [the console playground](/auth/overview/#the-console-playground)), and a copy
  button for its `${publicUrl}/mcp?servers=<slug>` URL, which contains no
  credential, on every **enabled** entry whatever the reader's roles. A disabled
  entry carries neither, because both lead somewhere the gateway refuses.
  With `gateway.publicUrl` unset, that URL falls back to the origin the request
  arrived on — the same fallback `/` takes, and the reason to set `publicUrl` on
  any deployment where the `Host` header is not the gateway's own name.
  A Google login mints a signed 12-hour session cookie; the dev bypass's cookie is
  still the bootstrap token itself, which is a shim (see
  [Known limitations](/limitations/)).
- **`/playground/:server`**, core-only and behind the same gate, is a human MCP
  client for one server: it lists the tools that server serves _you_ and calls
  them with arguments you type. No model is involved. Its two `POST` routes
  (`/tools/list`, `/tools/call`) open a real MCP session **inside the process**
  against the same server object `/mcp` builds, so entitlements and the `tools:`
  policy apply identically — see
  [the console playground](/auth/overview/#the-console-playground). A bare
  `/playground` 302s to `/ui`, which is the picker.
- **`/api/secrets/readiness`** is core-only and is the one authenticated surface
  there that the console gate does **not** guard: its consumer is a machine, so it
  takes a static bearer token through the same path `/mcp` does. It returns the
  console's derivation as JSON — names, paths and states, never a value. See
  [Secrets](/operate/secrets/#get-apisecretsreadiness--the-same-answer-for-a-machine).
