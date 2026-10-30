---
title: Operations & CI
description: The GitHub Actions workflows that build, test, release, deploy, tear down, and seed secrets for strad — ci, release-image, deploy-staging, teardown-staging, and secrets-sync.
sidebar:
  order: 2
---

strad's operations are a set of GitHub Actions workflows on self-hosted runners.
They enforce one premise: **the image is the deliverable**, so a PR that can't
produce a bootable image is a failing PR.

## `ci.yml` — the gate on every PR

Runs on PRs and pushes to `main`. Ten jobs, all `runs-on: self-hosted` — one
of which, `servers`, is a twenty-two-leg matrix over the server trees:

- **`lint`** — typecheck, ESLint, `prettier --check`. The typecheck is one
  program over `src/`, `test/` and `scripts/`. `scripts/` matters because those
  files run under `node --experimental-transform-types`, which strips types
  without checking them, and one of them — `render-spec.ts` — emits the App
  Platform spec a deploy applies. The `test` job spawns that renderer end to end,
  so a type error that is also a runtime fault on a covered path reddens there —
  but one that is invisible at runtime (a widened union, a renamed field on a
  branch no suite walks) has nothing else to catch it, and without this job it
  would surface first in the deploy, against the real app.
- **`test`** — `vitest`: unit tests plus a real-MCP-client, in-process E2E.
- **`servers`** — one matrix leg per server tree the bundle image bakes: `npm ci`
  in `servers/<tree>`, then `npm run build`, `npm test`, or both. `servers/**` is
  outside the core TypeScript program and the bundle image only cuts on a push to
  `main`, so without these legs a PR can break a server tree and merge green — a
  type error surfaces first as a failed release build, and a behavioural
  regression surfaces first in production. Each leg reports as `servers (<tree>)`,
  and `fail-fast: false` keeps one broken tree from cancelling the other nineteen.

  A leg's `tree:` **is** its path under `servers/`, so a tree that is not a direct
  child is spelled with a slash: `bundle/host` runs in `servers/bundle/host` and
  reports as `servers (bundle/host)`.

  **The tree list is not maintained by hand.**
  `test/ci-server-trees.test.ts` compares the matrix against the trees
  `servers/bundle/Dockerfile` bakes and fails until a new one is named, the same
  technique `bundle-release-paths.test.ts` uses on the release workflow's
  `paths:`. A hand-maintained list has already failed twice here: `onepassword`
  and `pointsyeah` were baked with no job at all, and after two more jobs were
  hand-written for them, `x-twitter` landed the same way — four functional
  suites, baked into the image, run by nothing. It happened a fourth time to the
  bundle host, and that one the comparison could not see: the Dockerfile copies
  `servers/bundle`, the npm tree is `servers/bundle/host` one level deeper, and a
  leg for it read as naming a tree the image does not bake. So the comparison
  resolves each baked path to the **lockfile-owning** trees at or inside it — the
  unit `npm ci` can address — and a nested tree that lands uncovered fails it the
  same way a top-level one does. One baked tree is deliberately not a leg, and the
  test names the job that covers it: `images/bundle-google` is a supplementary
  image in its own right, gated by
  [`bundle-google-ci.yml`](#the-image-workflows). `servers/bundle` needs no
  exemption — it owns no lockfile, so it is not a tree; its host is.

  **Nor is the runner each leg uses.** A leg runs whatever its tree's `npm test`
  runs, so a tree added on a different runner — or with no `test` script at all —
  is green here and asserts nothing, which looks identical to a tree that passed.
  That happened twice after the repo converged on Vitest: `servers/grafana` and
  `images/bundle-google` both arrived on `node --test`, one of them running its
  suite against a stale `build/` rather than its sources. So
  `test/vitest-convergence.test.ts` holds both halves — the vitest major and
  config shape of every package that declares one, and, for every **tree**, that
  its `test` script exists and resolves through `npm run test --workspace <x>`
  down to a command that really runs vitest. It also fails on any tracked
  `*.test.mjs`, because no `include:` in this repo matches that name: such a file
  is collected by nothing and reports like a suite that passed.

  What each leg is for:

  - **`good-eggs`** — build (typechecks `shared` + `remote`) and its browser-free
    tests: the MCP-App gating, the basket read, what a cart result may claim, the
    favorites read, the login wait, and — as for `fetchpet` below — that a failed
    login is retried on the next tool call rather than cached for the life of the
    container.
  - **`fetchpet`** — tests. fetchpet drives a login form nobody here controls, and
    a redesign of it took the mount down in both environments — it listed its four
    tools and failed every call for weeks. Its tests run over a fake browser: they
    pin the login selectors against the form Fetch actually serves, and prove a
    failed login is retried on the next tool call rather than cached for the life
    of the container.
  - **`secrets`** — tests, which _are_ the security review: they drive the server
    through a real MCP client against a fake Parameter Manager that models the
    two-store split, and assert that no tool can return a secret value and that
    the viewer credential cannot reach one. They also pin the capability probe's
    permission strings, because the whole tool surface is derived from them and a
    name Google does not recognise reads as "not granted" rather than as an
    error — see [Secrets IAM](/operate/secrets-iam/).
  - **`remote-filesystem`** — tests. Its whole product is the link it hands a
    human, and they pin the two things that decide one: `is_sensitive` picks the
    kind of link, and GCS's 7-day V4 ceiling is what forces V2 for the 14-day
    default.
  - **`telegram`** — tests. It reads a real person's private messages with a
    credential that _is_ their account, so its tests cover the tool surface (the
    read-only tier does not build `send_message`), the mapping and paging below
    it, and the no-credentials path — the state this server ships in, where it
    must still mount and list rather than take the bundle down.
  - **`image-tools`** — tests. Two servers that fetch a URL a caller chose, from
    inside the bundle, so the suites that matter are the SSRF guard (private,
    loopback, link-local and metadata addresses refused, redirects included, a
    signed link's query never echoed back) and the bounds: bytes, pixels, and a
    job's deadline enforced by terminating its worker thread. Both tools run end
    to end through a real MCP client against a loopback fixture.
  - **`nutrition-facts`** — tests. The data builders run over CSV fixtures shaped
    like each real USDA and MenuStat release, quirks included, and the four tools
    run through a real MCP client against a fake FatSecret and FDC: the cache,
    the daily budget, the IP-allowlist error, the attribution, and every lookup
    still answering with FatSecret unconfigured. No network; the real data is
    downloaded when the bundle image is built.
  - **`x-twitter`** — tests: timeline, search, lookups and private bookmarks. The
    functional suites read no credentials, so they run here like the rest; only
    `test:e2e`, which CI does not run, resolves X API keys.
  - **`bundle-api`** — build and tests over the `bundle-api` tree. Three of its six
    servers are verbatim vendor copies with no tests here yet: a test written
    _inside_ a vendored copy is a merge conflict on every re-vendor and belongs
    upstream, and nobody has yet given them the tree-root treatment `pointsyeah`
    and `onepassword` have. The other three are **forks**, and none has a
    sync script or an upstream to diff against, so their tests are the only thing
    that stops a re-vendor from silently reverting them. All three fork suites run
    under Vitest against their TypeScript sources, and `npm test` in each is
    `npm run build && vitest run`, so each fork is typechecked before its own
    suite runs; the leg's separate build step is what typechecks the three
    vendored trees and `remote/`. `slack` — see
    [limitations #55](/limitations/#55-the-slack-server-is-a-fork-and-only-its-tests-defend-the-delta) —
    renders mrkdwn, which is not Markdown: `~text~` is strikethrough, so a message
    using `~` for "approximately" posts successfully with paragraphs struck out,
    and the fork's write tools lead with that rule and warn in the tool result
    after the fact. It also adds the four DM tools upstream has no equivalent for,
    whose OAuth scopes are [limitations #59](/limitations/#59-a-dm-needs-slack-scopes-the-channel-tools-never-asked-for).
    `google-flights` — see [limitations #58](/limitations/#58-the-google-flights-date-grid-costs-one-request-per-date-a-premium-seat-has-no-legroom-to-report-and-the-fare-brand-is-not-the-cabin) —
    fixes three defects that each returned a confident wrong answer: cabin class
    and passenger counts encoded at protobuf field numbers Google skips as
    unknown, baggage flags read in the wrong order, and a date grid that returned
    a trailing price history instead of future departures.
    `monarch-money` — see [limitations #80](/limitations/#80-monarch-money-is-a-fork-and-no-recorded-fixture-can-see-the-schema-move-again) —
    asked for `account(id:) { holdings }`, which Monarch's schema does not have, and
    swallowed the resulting 400 in a bare `.catch(() => [])`, so every account
    reported an empty portfolio. Its suite asserts the query TEXT, because a wrong
    query shape is invisible to a mocked client, and that every fetch failure comes
    back as an error rather than as an empty list.
  - **`pointsyeah`** — tests, and no separate build leg, because `npm test` is
    `npm run build && vitest run`: the same `tsc` over both workspaces, in the
    ordering the image's Dockerfile uses, runs first, so a type error still fails
    the PR rather than the bundle-image build. The `shared/` half of the tree is a
    verbatim vendor copy of `pulsemcp/mcp-servers`, so a test written _inside it_
    would become a merge conflict on every re-vendor and belongs upstream — but
    that is an argument about where the file lives, not about whether the code is
    testable, so the suite lives in `servers/pointsyeah/test/`, at the **tree
    root**, and imports the vendored TypeScript sources from outside them. It
    covers the PointsYeah client's request-building (the Cognito refresh envelope,
    the search URL the site is navigated to, the Cognito cookies injected into the
    browser, and the raw — never `Bearer` — id token the API expects) and its
    response-shaping (token expiry taken from the access token's own `exp` claim,
    the `create_task` envelope, and how an HTTP failure becomes an error carrying
    its status code). `fetch` is stubbed and the Playwright surface is the
    injected one, so the suite opens no socket, launches no browser, and needs no
    PointsYeah credential.
  - **`onepassword`** — tests, and no separate build leg, because `npm test` is
    `npm run build && vitest run`: the same `tsc` over every workspace in the
    Dockerfile's ordering runs first, so a type error — 1Password's
    `shared/src/tools/sanitize.ts` is credential redaction — still fails the PR.
    Its `shared/` half is the same kind of verbatim vendor copy `pointsyeah`'s is,
    and the re-vendor argument above is why the suite lives in
    `servers/onepassword/test/`, at the **tree root** rather than inside
    `shared/`: a re-vendor overwrites `shared/` and never touches `test/`. From
    there it imports the vendored TypeScript sources directly and covers the `op`
    client's request-building (the argv each call assembles, and that the
    service-account token travels in the environment rather than in argv) and its
    response-shaping (list sanitization, share-URL parsing, and how a CLI failure
    becomes a not-found, an authentication, or a command error).
    `child_process.spawn` is faked, so the suite spawns no process, reaches no
    network, and needs no 1Password credential.
  - **`pulse-subregistry`** — tests. Forked from the unpublished PulseMCP
    reference implementation; the bundle smoke test only proves the tool list,
    while this suite pins defaults, query construction, truncation and error
    handling.
  - **`strad-fetch`** — tests. strad's fork of `@pulsemcp/pulse-fetch`. The
    bundle smoke test only proves the tool list; this suite pins the two
    behavioural deltas the fork exists for — `speed` demotes native rather than
    skipping it, and a rejected credential does not abort the strategies after
    it — plus the cache bounds a shared container needs and a stdio subprocess
    did not.
  - **`grafana`** — tests. The proxy in front of the pinned `mcp-grafana` Go
    binary. Its suite runs against a fake MCP child rather than the real
    executable, and pins the seam: that the child is spawned with
    `-disable-write` and `-disable-proxied` (a read-only mount becoming
    read-write is silent otherwise), that it receives an allowlisted environment
    rather than the bundle's twenty other credentials, that tools and results are
    forwarded verbatim, and that a child which dies is replaced on the next call.
    The binary's own tool count is asserted by `bundle_image`, against the real
    thing. No separate build leg, because `npm test` is
    `npm run build && vitest run` — `tsc` over `src/` runs first, so a type error
    there still fails the PR rather than the bundle-image build. The suite itself
    runs under Vitest against the TypeScript sources, like every other tree's.
  - **`bundle/host`** — tests, and no separate build leg, because `npm test` is
    `npm run build && vitest run` — `tsc` over `src/`, so a type error there
    still fails the PR. The host is the process every bundle container runs: it
    mounts every tree in the image, 31 mounts, which staging's 41
    supplementary-image slugs resolve to. Its suite runs over its TypeScript
    sources with no `/app/trees` to mount: the per-slug environment
    discovery, the two `degraded` verdicts, the presence route's wiring and the
    per-tree SDK cache. `bundle_image` does not substitute for it — that job
    asserts the mount **set** against a booted container and exercises no branch,
    so a dropped precedence inside one of the `degraded` verdicts is red here and
    green everywhere else.

- **`hostd`** — `npm ci`, a Chromium, and `npm test` in `hostd/`, then the install
  script with `--no-agent`. [strad-hostd](/servers/hostd/) is not a leg of
  `servers`: that matrix is the set of trees the bundle image bakes, and this code
  runs on a laptop. It hands out a shell on a personal machine, so its suite is
  the security review: nothing runs without a grant, an unanswered dialog is a
  denial, each server's key opens only that server, the status page answers only
  to loopback with a token, and ending a grant kills the process group it started.
  The browser suite drives a real Chromium, and with `CI` set a missing browser
  fails the suite rather than skipping it. The two computer-use servers run
  against a stand-in for the native helper that speaks its protocol in-process.
  The macOS halves — the `osascript` dialog, the LaunchAgents, the installer's
  `cloudflared` branch, the signing script — run nowhere in CI; the helper
  itself has its own workflow, below.
- **`bundle_image`** — builds `servers/bundle/Dockerfile`, **boots the container**,
  and runs `scripts/smoke.mjs` against every mount of the running image, asserting
  the full-capability tool count for each (slack 14, tailscale 15, monarch-money 24,
  gmail 9, google-docs 13, google-calendar 7, 1Password 9, secrets 4, …). Those
  counts are the numbers the gateway's read-only allow-lists are carved out of, so
  if an upstream grows or renames a tool, this is where it surfaces. For `secrets`
  the count of 4 is a security assertion: a fifth tool on a server whose contract is
  "no tool returns a secret value" is what CI should catch. It also asserts the `op`
  CLI is really in the image.

  It then boots a **second** container, with `SECRETS_STORES` in place of the
  single-store `SECRETS_PROJECT_ID`, and asserts the `secrets` mount comes up
  under it with the read-only four. That is the only place the descriptor seam is
  exercised end to end: `renderAppSpec` composes that variable from `mcpStores:`
  and the secrets tree — a different npm project, in a different image layer —
  reads it back, and nothing in either type system sees both ends, so a renamed
  field would otherwise be a green PR and a mount that declines to start.
  Credential-free like the first container, so both stores fail closed and no
  write tool or `get_secret_value` may appear.

  Then a **third**, to assert the mounts' internal-token gate in the direction
  that matters. Both containers above are started with a throwaway
  `STRAD_INTERNAL_TOKEN`, and the job checks that a mount answers `401` to a
  request presenting none, to one presenting the wrong token, and to the right
  token with no `Bearer` scheme, `200` to the right one, and that `/healthz` still answers `200` with no token at all — App
  Platform's prober holds none. The third container is started **without** the
  token, and every mount must answer `503` and serve nothing. The failure
  direction here is _open_: a green smoke proves only the served half, and a gate
  wired to the wrong env name looks exactly like a fix.

  This job is also where the configs meet the tools. It dumps every mount's real
  tool **names** (`smoke.mjs --json`) and runs
  [`check-tool-policy`](/operate/deploy-model/#checking-a-tools-policy-against-the-tools-that-exist)
  over every config in the repo, so a `tools: allow` entry, or a `reaches:`
  grant's tool, naming a tool no mount serves fails the PR instead of silently
  narrowing that slug's surface in production. A slug it cannot enumerate is skipped and named, never failed.

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
- **`dev_env`** — both [local development](/start/local/) paths, end to end. First
  the no-Docker one: `npm ci`, then `npm run dev:agent -- --background`, which
  only exits 0 once `/healthz` answered. Then the container one: build
  `.agent-containers/Dockerfile.dev`, boot the workspace, run `setup.sh` and
  `run.sh` inside it, and demand the gateway serves — not merely a 200, but a
  `/healthz` naming the `echo` server, since mounting one is why the dev config
  exists. It also asserts the three properties that are decisions rather than
  accidents: `node_modules` comes from the named volume and not the host bind
  mount, `/var/run/docker.sock` is **not** in the container, and re-running
  `run.sh` is a no-op rather than an `EADDRINUSE` crash.

  That order is load bearing. The compose stack mounts a named volume at
  `/app/node_modules` inside a bind-mounted checkout, so if the directory does not
  already exist the **daemon creates it, as root** — and the host `npm ci` that
  follows is then an `EACCES` on a workspace the runner owns. Installing first
  means the mount point is already the runner's, and it sharpens the volume
  assertion: with the host tree populated, a non-empty tree inside the container
  is the volume rather than the bind mount showing through.

  The dev environment's users are newcomers and agents — the two populations
  least able to debug it, and the two most likely to read a broken boot as
  "strad is broken". Nothing else in CI touches either path.

<aside class="starlight-aside starlight-aside--note">

**Why `ci.yml`'s three docker jobs name everything per run.** `bundle_image`,
`build_image` and `dev_env` all build an image and boot it, on a self-hosted box
whose docker daemon every concurrent job shares. So the container name, the image
tag, the compose project and the host port are all suffixed or assigned per run:
the tag is `ci-<run id>-<run attempt>`, the container carries the same suffix,
`dev_env`'s compose project is `strad-dev-ci-<run id>-<run attempt>`, and the port
is published as `-p 127.0.0.1::8080` (or `APP_PORT=0`) and read back with
`docker port`, rather than bound to a fixed `-p 8080:8080`.

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

<aside class="starlight-aside starlight-aside--note">

**Why every job logs in to its own docker config.** The pointer is not the only
box-wide file in `$HOME`. `~/.docker/config.json` holds the registry credential,
and nine jobs here run `docker/login-action` against ghcr — each writing
`auths["ghcr.io"]` with its own job's `GITHUB_TOKEN`, and each running `docker
logout ghcr.io` in a post step, because `logout: true` is that action's default.
So the last job to log in owns the credential every concurrent build pushes with,
and the first job to finish deletes it.

A buildx CLI reads that file once, at startup, and a long build pushes with
whatever it read. On 2026-08-12 the bundle release loaded a sibling job's token,
pushed with it three minutes later — 78 seconds after that job had ended and
GitHub had revoked it — and then retried twice against a file a second job's
logout had emptied, asking ghcr for an anonymous token and taking two 403s. Three
attempts, three refusals, `main` red, and nobody had touched the package's
permissions. The two sibling image jobs in that same push both succeeded: the bug
selects for the slowest build, which is always the bundle.

So every job that logs in calls `./.github/actions/docker-config` first, which
points `DOCKER_CONFIG` at `$RUNNER_TEMP/docker` — per runner installation, and
emptied between jobs, the same private-path argument the deploy makes for its
rendered spec. One variable moves the CLI, both of `docker/login-action`'s steps
and buildx's auth provider together, so the post-step logout stays on and empties
only this job's own file. It is called before `docker/setup-buildx-action` as well
as before the login, since buildx keeps its builder metadata in the same
directory. `test/workflow-docker-config.test.ts` fails the PR that drops it,
reorders it, or hand-rolls a `docker login` in a `run:` block. See
[limitations #57](/limitations/#57-the-ghcr-credential-is-a-box-wide-file-and-the-slowest-build-loses-it).

</aside>

## `hostd-ax.yml` — the one macOS workflow

strad-hostd's two native helpers — `strad-hostd-ax` behind the computer-use
servers, `strad-hostd-messages` behind the Messages server — are Swift and
build only on a Mac. Everything else in this repository runs on the
self-hosted Linux runner, so this is the one workflow on GitHub-hosted
`macos-15` runners, two jobs, and on a private repository those minutes are
billed. It is path-filtered to `hostd/ax/**`, `hostd/messages/**`, the
daemon's `hostd/src/messages/**` (the Messages smoke test runs its queries),
both helpers' LaunchAgent plists, the signing script and itself, and runs on a
PR and on `main`.

It proves the helper compiles, ad-hoc signs, speaks its JSON-lines protocol over
stdio (`hostd/ax/smoke.mjs`), answers `hello`, lists apps and displays, and
refuses every guarded op with the right code on a runner that holds no
Accessibility or Screen Recording grant. It also lints both LaunchAgent plists.
A runner has nobody to click a grant, so reading a real Accessibility tree, a
real screenshot and the banner under a real grant are exercised on the owner's
Mac and nowhere else; [limitation #108](/limitations/) says so.

The `messages` job builds and ad-hoc signs `strad-hostd-messages`, builds a
fixture chat.db with `hostd/messages/fixture.swift`, and drives the helper over
stdio with `hostd/messages/smoke.mjs`: an `attributedBody` NSArchiver wrote is
decoded, writes and ATTACH are refused, a TIFF is converted by `sips`, an
attachment outside the database's directory is refused, and the daemon's own
queries run through it. A runner has no real Messages history and its grants
are the image's, so a real `~/Library/Messages` under a grant the owner clicked
is read only on the owner's Mac; [limitation
#115](/limitations/) says so.

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

It does **not** deploy anywhere. It used to end by calling `deploy-staging.yml`
with the version it had just cut, and that one line is why staging was never off:
`main` moves several times a day, so any teardown was undone by the next merge.
Staging is [on demand](#teardown-stagingyml--put-it-to-sleep) now.

That trade is real and it is worth naming. Every image this workflow cut used to
be smoke-tested on real infrastructure within minutes of the merge, and now
nothing is until someone dispatches `deploy-staging.yml`. What is left in its
place is the pre-merge half: `ci.yml` builds both images through the same shared
action on every PR, and `bundle_image` boots the bundle and enumerates its tools.
Neither of those puts the image on App Platform.

Prod was never downstream of the deploy and is unaffected. It is reached by the
`repository_dispatch` **step** in step 4, inside the build job.

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

**It also reports the spec's size, and where the size is.** Two lines on stderr:
the file's byte count, then the same spec compact with the byte count per
component, largest first. Both are names and numbers — the spec itself holds
secret values and is never echoed.

```
[assert-spec] /run/spec.json: "strad-prod", 96238 bytes, 3 component(s): core, bundle, bundle-internal.
[assert-spec] 87422 bytes compact: bundle 58204, core 27196, bundle-internal 1915
```

The two totals differ by the renderer's indentation, which is why the second
line carries its own: the per-component figures are compact, so they add up to
that one and not to the first.

Past ~80% of the largest spec this deployment is known to have deployed, that
becomes a `::warning::`. Here it stays a warning, because the refusal has already
happened by then: `render-spec` gates on the same number before it writes the
file, and a spec that reaches `assert-spec` past the ceiling got there because
someone passed `--max-spec-bytes` — a deliberate act this script has no business
overruling. What this line is for is the state prod was actually in on 2026-08-30
— headroom nobody had measured, somewhere between 1 and 10,332 bytes, until the
API started answering `size limit exceeded`. See
[Known limitations](/limitations/) #72.

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
   is in flight wants `bundle_version` too. The spec is rendered by the
   DISPATCHED ref's tooling, not the pinned image's, so a rollback to an image
   older than the gzipped config (`STRAD_CONFIG_YAML_GZ_B64`) must be dispatched
   from a ref of that age: the image cannot read the compressed form, refuses
   to boot on its tripwire, and App Platform keeps the deployment it has.
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

##### When GHCR refuses the walk

The walk is up to 50 sequential `HEAD`s at one GHCR repository, plus the
pull-scoped token it needs first — which is exactly the shape that earns a rate
limit. A `429`, a `500`, a `502`, a `503`, a `504` or a connection that never
answered is retried. On a probe a `404` is "no image for that commit" and is
the only negative; anything else — a `401`, a `403`, a `501`, and a `404` from
the token endpoint — is a settled answer and fails at once.

That is the same policy the parameter store runs on, from the same module
(`src/http/retry.ts`), rather than a second opinion written beside the registry
calls. Two things follow. A `Retry-After` is **honoured**: a registry that names
a delay is saying when it will answer, and sleeping less than that spends an
attempt on a request already known to be refused. And the backoff is
**jittered**, so 50 probes refused in the same second do not all come back in
the same millisecond.

The budget is sized for the walk, not for one call: **three tries and at most
3s of added sleep, per probe**. Multiplied across a fully-refused 50-commit walk
that is 150s, which is where it has always been. A rate limit that outlasts two
backoffs is GHCR throttling the walk itself, and the answer to that is a
shorter walk — a `version` input, or a deploy from a commit that published —
not a longer sleep. A `Retry-After` longer than the remaining 3s gives up on the
first answer rather than fifty times over.

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

`--bundle-image` is repeatable, once per image repository. Staging names one, so
it passes one; a config mounting a second first-party image passes a second
occurrence for it. Matching is by registry and repository, not by component name
or argument order, and **each occurrence has to match something on its own** — a
sibling that did match does not excuse one that did not. That is deliberate:
without it, adding a second override would be a way to let the first one go stale
in silence, which is the failure the flag exists to prevent. It also means
disabling the last slug on a repository has to drop that repository's
`--bundle-image` in the same change, or the render fails. Two occurrences naming
the same repository are refused rather than resolved.

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
flight is exactly what the wait is for, and is left alone; so is a run
[the self-heal](#when-the-bundle-build-was-cancelled-it-re-runs-itself) is about
to re-run, which the step decides by restating that listener's three guards
rather than by assuming it fires. The lookup needs
`actions: read`, which `deploy-staging.yml` requests and every caller of it has
to grant as well; without it the step falls back to waiting out the budget, which
is what it did before. Either way the deploy stays stopped until an image exists —
see [when the bundle build failed](#when-the-bundle-build-failed-dispatch-it-rather-than-re-run-it)
below for the move that publishes one.

The walk-back rule is the one thing that differs from the core, and it is
inverted. `release-image.yml` builds every commit except docs-only ones;
`release-bundle-image.yml` has a `paths:` filter — one entry per thing that
changes the image: the twenty-two trees the Dockerfile bakes, the bundle host, the
workflow itself, and the shared release body it delegates to — so **most**
commits cut no bundle image
and stepping past them is the normal case, not an exception. `--kind bundle` reads
that filter out of the workflow rather than keeping a second copy of the list. A
commit that **did** touch a baked tree and has no image is still a hard stop, for
the same reason as the core.

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

`strad-bundle:latest` is written into all 29 `supplementary-image` entries, so
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

##### When the bundle build was CANCELLED, it re-runs itself

A cancellation is not a verdict. `failure` says the tree at that commit does not
build; `cancelled` says something interrupted the build, and the tree that was
building a second earlier still builds. So the re-run the section above talks you
out of is the _whole_ remedy here — and `reheal-bundle-image.yml` makes it
without a human.

It listens for `Release bundle image` completing and re-runs the run when all
three of these hold:

| Guard                       | Why                                                                                                                  |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `conclusion == 'cancelled'` | the one conclusion that says nothing about the commit. A `failure` re-run is the loop above.                         |
| `run_attempt == 1`          | a re-run adds an attempt to the _same_ run, so this listener fires again when that attempt ends. One heal per run.   |
| `event == 'push'`           | a `workflow_dispatch` build is one a human started and may deliberately stop. Undoing that is worse than leaving it. |

It runs on `ubuntu-latest`, not the self-hosted runners, for the same reason
`alert-ci-failure.yml` does: the runners going down is precisely the event it
heals, and a heal that runs on the broken thing cannot run.

The tag walk meets it halfway. A deploy already inside its fifteen-minute wait
polls every twenty seconds, so a cancellation landing mid-wait would otherwise
hard-stop the deploy in the minute before the re-run it is waiting for even
starts. So it holds the wait open for a cancellation this listener will heal —
and it decides that by asking the Actions API for the same three facts the
guards above test, rather than by assuming. A cancellation the listener
**declines** — a second attempt, a dispatched build, an attempt number or
trigger the API did not report — is dead like any other verdict: waiting on it
would spend the whole budget on a build nothing is bringing back, which is worse
than the hard stop it replaced. Either way the message says _re-run it_ rather
than _dispatch it_ — the advice for a failure is the wrong advice for an
interruption.

The core image gets that wording too, and nothing else. This listener watches
`Release bundle image` and no other workflow, so a cancelled `release-image.yml`
run is never held open and its message names no heal. `ImageSource.reheal` is
what carries the difference — beside the walk-back rule, which until now was the
only thing separating the two images.

**Two things this deliberately does not do.** It never re-runs a `failure`, so
the loop above stays impossible. And it heals once — an attempt 2 that is
cancelled again means the CI host is unhealthy, and hammering it would not make
it healthy.

**Why.** On 2026-09-04 the self-hosted runner host restarted mid-build.
`a278b5ed`'s bundle build was cancelled 100 seconds in; three unrelated jobs on
two other runners died in the same second; nothing was wrong with the commit.
`main` was left undeployable — every staging deploy hard-stopped on the missing
`sha-a278b5ed…` — until somebody re-ran the build by hand nine minutes later.
Nothing alerted either: `alert-ci-failure.yml` stays quiet on `cancelled` on
purpose, because `ci.yml`'s `cancel-in-progress` makes cancellation routine, so
the first anyone heard of it was the deploy failing.

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

**It then reports, and never gates on, which mounts their bundle calls degraded.**
After the telemetry report, a step waits for a core observation newer than the one
its first read saw — the bundles' logins run in the background at boot and take
up to ~30s to fail — and prints `/healthz`'s `mountDegraded` as a `::warning::`,
and `mountUnread` as a second one, since "nothing degraded" only covers the mounts
that were read. A mount that
lists its tools and fails every call is what the smoke test cannot see (fetchpet
did it for weeks), but "degraded" means a different thing per server, so the step
exits 0 on it; it goes yellow only when it could not read the list at all, and
`continue-on-error` keeps that off the job. What it prints is config slugs — the
bundle's reason is not on core's `/healthz` to print. See
[known limitations #40](/limitations/#40-the-tool-surface-monitor-asks-one-question-so-it-can-only-catch-one-kind-of-failure).

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
variable name](/operate/secrets/#a-servers-secrets-live-in-that-servers-namespace).

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
  `release-image.yml`, which refuses to run off `main`, and in the shared body
  `release-bundle-image.yml` calls — which refuses off-`main` for that caller
  because that caller asks it to, with `refuse-off-main: true`. The other four
  callers of that body do not ask, and their `:latest` is not a tag any live
  deployment tracks.
- **Prod is never notified.** `deploy-staging.yml` contains no
  `repository_dispatch` step at all, so a branch build cannot fire one.
- **The release path cannot trigger a build.** `build` is declared only on
  `workflow_dispatch`, not on `workflow_call`, so `release-image.yml` has no way
  to reach the build job.

A branch build also reads the shared buildx cache but never writes it, so it
cannot affect what `main` builds from.

**Restoring staging to `main`** is one dispatch: run `deploy-staging.yml` on
`main` with `build` left off. It renders `main`'s config against the
`sha-<commit>` image built for that commit. Nothing restores it on its own —
merging to `main` no longer deploys staging, so a branch left on staging stays
there until someone replaces it or the nightly
[teardown](#teardown-stagingyml--put-it-to-sleep) archives it.

<aside class="starlight-aside starlight-aside--caution">

Never push a branch bundle to `strad-bundle:latest`. It is the tag the config's
`image:` lines still name, so anything that resolves it — a fresh App Platform
deploy, a `docker pull`, a human checking what shipped — would get a bundle whose
mounts have moved out from under the routes the deployed spec carries. Build and
deploy have to happen together, which is what the `build: true` dispatch does.

</aside>

## `teardown-staging.yml` — put it to sleep

Staging is **on demand**. This workflow is the "down" direction:
`workflow_dispatch` plus a nightly `schedule:` at 07:00 UTC. The "up" direction is
`deploy-staging.yml`, unchanged.

```bash
gh workflow run teardown-staging.yml                    # sleep now
gh workflow run teardown-staging.yml -f restore=true    # wake on the archived spec
gh workflow run deploy-staging.yml                      # wake on current main
```

It **archives** the app — `maintenance.archive: true` on the live spec — rather
than deleting it. Archiving stops App Platform billing for all three components
(~$49/month: `core` $12, `bundle` $25, `bundle-zimmer-secrets` $12) while keeping
the app id, the starter hostname, the custom domain and its certificate.

### Why not just delete the app

`deploy-staging.yml` is create-or-update, so deleting the app looks free — the
next deploy would rebuild it from the rendered spec. The domain is what makes it
not free:

- DigitalOcean instructs you to remove a custom domain **before** deleting its
  app, because a domain left attached may keep pointing at the deleted app for
  **up to 24 hours**, unavailable to a new app meanwhile. A nightly delete and a
  next-morning create land inside that window every time.
- `staging.strad.tadasant.com` CNAMEs `strad-staging-wy9v5.ondigitalocean.app` —
  the app's own starter hostname, assigned per app after its first successful
  deployment. A recreated app answers on different characters, and that record
  lives in Cloudflare, which no credential in this repo can write. See
  [DNS & domains](/operate/dns/).
- Certificate issuance is the smallest of the three, and not free either: prod's
  certificate carries `notBefore` 77 minutes after that app was created.

None of that applies to an archive. The app never stops existing, so nothing is
re-issued and nothing is re-pointed.

### The restore is free, and that is hack #18 pointing the right way

An App Platform spec update is a full replace, so a spec with **no** `maintenance`
block clears `archive`. `maintenance.archive` is a `bool` with `omitempty` in
DigitalOcean's API client, which means their documented restore — write
`archive: false` — puts the same bytes on the wire as omitting the block. So
`render-spec` needed no change and `deploy-staging.yml` needed no new step: a
deploy restores staging as a side effect of deploying it.

`restore=true` is the cheap inverse for when you want back exactly what was
archived: it skips the GCP secret read, the render and the smoke test, though it
still restarts every container and waits for the deployment. It deliberately is
not a deploy, and the run prints the image tags it is restoring so nobody
mistakes an archived spec for current `main`.

### What it refuses to do

| Guard                                                                               | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No `doctl apps delete`, ever                                                        | see above; asserted in `test/staging-on-demand.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                          |
| Re-reads the spec and refuses any app not named `strad-staging`                     | the only thing between a nightly cron and archiving prod is a name resolved out of a list, and an archive is a full outage of whatever it hits                                                                                                                                                                                                                                                                                                                   |
| Re-reads it AGAIN after the update, and fails if `maintenance.archive` did not land | `doctl` decodes the spec with `encoding/json`, which drops a field it does not know — so a `doctl` predating `AppMaintenanceSpec` would PUT, return success, deploy, and leave the app billing. Same rule as [limitations #84](/limitations/)                                                                                                                                                                                                                    |
| Shares `deploy-staging.yml`'s `staging-deploy` concurrency group                    | both workflows PUT the whole spec; queuing rather than racing stops an archive from reading the spec before a deploy's PUT and writing it back after. It costs something: GitHub keeps at most **one pending run** per group, so an archive queued behind a deploy is cancelled if anything else enters the group first — one night's saving, lost silently, since `alert-ci-failure.yml` does not alert on `cancelled`. Losing a deploy is the worse of the two |
| Fails loudly when `doctl apps list` fails                                           | `awk` exits 0 on no match, so an unreachable API and an absent app produce the same empty id — a green "nothing to archive" through an outage would hide the bill this exists to stop                                                                                                                                                                                                                                                                            |
| No token but `DIGITALOCEAN_ACCESS_TOKEN`                                            | it talks to DigitalOcean and nothing else: no checkout, no ghcr login, no GCP                                                                                                                                                                                                                                                                                                                                                                                    |

A scheduled run with no DO token skips and stays green; a `workflow_dispatch` with
the same gap fails loudly. Same idiom as `deploy-staging.yml`'s preflight.

An archived app **still exists** — `doctl apps list` shows it, and
`https://staging.strad.tadasant.com` serves App Platform's offline page over a
live certificate. Read liveness from `maintenance.archive`, not from the app's
presence.

## Seeding secrets

`secrets-sync.yml` is a `workflow_dispatch` job (in the `staging` environment)
that upserts
`strad-staging-{STRAD_TOKENS, STRAD_INTERNAL_TOKEN, ADMIN_BOOTSTRAP_TOKEN}` into
GCP Secret Manager — creating the secret or adding a new version — and then
**destroys every other version of the secret it just wrote**, enabled or
disabled, so each secret carries exactly one live version. Secret Manager bills
every version that is not `DESTROYED` (a disabled one still counts), every
consumer reads `versions/latest`, and nothing else ever cleans a superseded
version up. `STRAD_INTERNAL_TOKEN` is auto-generated (`openssl rand -hex 24`) if
you omit it.

What the prune destroys, precisely: the versions of a secret this run added a
version to, other than the one `versions add` returned. It never deletes a secret,
never touches the version it just added, refuses to destroy anything unless that
version is visibly `ENABLED` in the listing, and never destroys a version numbered
above it — numbers are monotonic, so a higher one is another writer's `latest`. A
wrong selection here would destroy `latest`, and the next deploy would render
without that credential. The workflow runs one at a time (a `concurrency` group,
like the deploy), so that shape does not arise from two dispatches. A secret the
run created (one version) is not pruned, and a secret whose `versions add` failed
ends the run before its prune. The log carries version numbers and states, never
a value.

If a prune fails after its add succeeded — a listing or a destroy answers an
error — the new value is already live, so the run carries on with the remaining
secrets and then **fails at the end** naming the secrets whose superseded versions
remain. Re-running with the same inputs finishes the job (it adds one more
version and destroys everything else), or destroy them by hand with
`gcloud secrets versions destroy`. Destroying needs
`secretmanager.versions.destroy` on the service account behind `GCP_SA_KEY`:
`roles/secretmanager.admin` and `roles/secretmanager.secretVersionManager` carry
it; `roles/secretmanager.secretVersionAdder` does not. The shell behind all of
this is exercised in CI against a stub `gcloud`
(`test/secrets-sync.prune.test.ts`).

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

| Workflow                        | Publishes                                        | Triggered by a change under                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `release-image.yml`             | `ghcr.io/tadasant/strad`                         | the repo root / `src/`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `release-bundle-image.yml`      | `ghcr.io/tadasant/strad-bundle` — **the** bundle | `servers/bundle/`, `servers/bundle-api/`, `servers/onepassword/`, `servers/secrets/`, `servers/remote-filesystem/`, `servers/good-eggs/`, `servers/fetchpet/`, `servers/pointsyeah/`, `servers/x-twitter/`, `servers/pulse-subregistry/`, `servers/strad-fetch/`, `servers/grafana/`, `servers/telegram/`, `servers/whatsapp/`, `servers/bill-spend/`, `servers/aws-device-farm/`, `servers/liveoak/`, `servers/airtable/`, `servers/flightaware/`, `servers/digitalocean/`, `servers/image-tools/`, `servers/nutrition-facts/`, `images/bundle-google/` |
| `release-bundle-api-image.yml`  | `ghcr.io/tadasant/strad-bundle-api`              | `servers/bundle-api/`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `release-goodeggs-image.yml`    | `ghcr.io/tadasant/strad-server-good-eggs`        | `servers/good-eggs/`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `release-fetchpet-image.yml`    | `ghcr.io/tadasant/strad-server-fetchpet`         | `servers/fetchpet/`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `release-pointsyeah-image.yml`  | `ghcr.io/tadasant/strad-server-pointsyeah`       | `servers/pointsyeah/`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `release-onepassword-image.yml` | `ghcr.io/tadasant/strad-server-onepassword`      | `servers/onepassword/`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `bundle-google-release.yml`     | `ghcr.io/tadasant/strad-server-bundle-google`    | `images/bundle-google/`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

Five of those workflows hold no build of their own. `release-bundle-image.yml`,
`release-bundle-api-image.yml`, `release-goodeggs-image.yml`,
`release-fetchpet-image.yml` and `release-pointsyeah-image.yml` are a `paths:`
filter, a concurrency group, and a call to **`release-supplementary-image.yml`** —
the reusable workflow that holds the shared body: checkout, isolate the docker
config, log in to ghcr, create a job-scoped buildx builder, build and push
`:latest` and `:sha-<commit>`. A caller passes `context:` and `image:`, plus
`file:`, `cache-scope:` and `refuse-off-main:` when it needs them.

The bundle is the caller that needs all three, and each of those three defaults
to the value that is wrong for it: `refuse-off-main: true` because
`strad-bundle:latest` is what live staging tracks, `cache-scope: bundle` because
this build is large enough to evict every one-tree image out of the shared gha
scope, and `file: servers/bundle/Dockerfile` because its `context:` is the repo
root — twenty-two trees, so the root is the only context that can `COPY` them all.
Dropped, each of the three fails silently rather than loudly, which is why
`test/workflow-release-callers.test.ts` asserts all three on that caller by
name.

One copy of that body rather than one per server is the point. Every cross-cutting
fix to the release path — naming the buildx builder, retrying the ghcr push,
isolating the docker config — was three separate changes each applied by hand to
nine to eleven files, and a copy that missed one is invisible in review.

Two things about that shape are worth knowing:

- **The `github` context inside a called workflow is the caller's.** `github.sha` is
  the commit that triggered the caller and `github.ref` is the ref it ran on, so
  the `sha-` tag and the off-`main` guard mean what they meant when the body lived
  in the caller.
- **Each caller watches the shared file in its own `paths:`.** A change to the body
  therefore cuts real images, rather than first executing on whatever unrelated
  commit next touches one of those trees.

`release-image.yml` (the core image) is deliberately not a caller — it does
considerably more than build and push. Neither is `release-onepassword-image.yml`,
whose `op` verification is described below: it builds, loads and asserts the
pinned CLI inside the artifact before publishing, which is a body no other
release has.

Everything below `release-bundle-image.yml` in that table is a **per-server image
that staging no longer deploys** — staging runs the one collapsed bundle. They are
still built and still pushed on purpose: production, in `tadasant-internal`, has not
been re-pointed at the collapsed bundle yet, and its spec still names those
repositories. Deleting them before prod moves would be an outage, not a cleanup.
See [Known limitations](/limitations/).

<aside class="starlight-aside starlight-aside--note">

**Why `release-onepassword-image.yml` tags its verification image per run.** That
workflow builds the image, loads it locally, and runs `op --version` inside it
before publishing — asserting the pinned CLI against the real artifact rather than
against the Dockerfile it came from. It is `runs-on: self-hosted` like everything
else here, so the tag it verifies is a name on a daemon the whole box shares.
Its own `concurrency` group keeps two runs of _it_ from overlapping; every other
job on the box is unaffected by that, and is what the tag has to be safe from.
Under a fixed `strad-server-onepassword:ci`, a concurrent job rebuilding that tag
between the build and the `docker run` moves the assertion onto an image this run
never built — and it passes, because both came from the same Dockerfile. Nothing
errors, and the release publishes having verified someone else's artifact. So the
verification tag is `strad-server-onepassword:ci-<run id>-<run attempt>`, the
image and its containers carry the `strad-ci` label, the job opens with the same
day-old sweep `bundle-google-ci.yml` uses — the two prunes `ci.yml` runs, plus
the running-container pass those two prunes cannot reach — and an `if: always()`
teardown removes this run's tag and no other.

The published tags are deliberately not part of that: `:latest` and
`:sha-<commit>` are the release, and App Platform pulls them by name. A per-run
tag there would be a mispublish rather than a fix, so
`test/release-onepassword-workflow.isolation.test.ts` asserts both directions —
the verification tag carries the run id, and the published two do not.

</aside>

`bundle-google-ci.yml` is the second CI workflow: it builds and smoke-tests the
`bundle-google` image on any PR touching `images/bundle-google/`. Its
`unit_tests` job runs `npm test` in that tree — `npm run build && vitest run`,
so `tsc` over every workspace runs first and a type error still fails the PR. The
suite itself runs under Vitest against the TypeScript sources, like every other
tree's.

It covers the code in that image strad WROTE, which is the code whose bugs would
be silent. `vendor/google-sheets-shared` and `vendor/google-drive-shared` are the
two servers here strad authored rather than vendored. Sheets' A1 arithmetic
decides which cell a write lands in, and a credential-free smoke test never
addresses a cell. Drive's suite covers what each request sends, including the
multipart upload a create is. `src/gmail.ts` is the
per-account layer over the gmail tree; it decides which MAILBOX a mount reads,
and a smoke test that counts tools would never see it read the wrong one.
`src/docs.ts` is the same layer over the google-docs tree, deciding whose Drive.
`vendor/gmail-shared` is a fork, and two suites cover its deltas:
`test/gmail-attachments.test.ts` covers the MIME an attachment is sent as, the
input it refuses, and what a download URL may reach, and
`test/gmail-from-name.test.ts` covers the display name a `From` header carries.
The three `vendor/` packages that are still copies get no tests here — one
written inside a copy is a merge conflict on the next re-vendor and belongs
upstream.

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

### Every image build goes through one action, and every push is retried

No step in this repo builds an image with `docker/build-push-action` directly.
All fourteen go through `.github/actions/build-push`, a composite action that
decides whether the run publishes and, when it does, runs the identical build up
to three times, 15s and 45s apart, letting the third decide the run.

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

Four of the fourteen call sites pass `push: false` and only build:
`release-onepassword-image.yml`'s verification build, `bundle-google-ci.yml`, and
the two in `ci.yml`. Those take exactly one attempt — nothing left the runner, so
a failure is the `Dockerfile` and not a registry, and rebuilding it twice more
would only spend wall clock reaching the same red.

### The release path runs before it is merged

`ci.yml`'s `build_image` and `bundle_image` jobs build through
`.github/actions/build-push`, which is why every pull request LOADS and RUNS the
action every image build in this repo shares. Before that, nothing on the PR path
could load it — every call site sat in a release workflow or in
`deploy-staging.yml`, none of which a pull request reaches — so the first
execution of a change to the release path was also its first production run. On 2026-08-11 that was eight release workflows red within twenty
seconds of one merge, and three more merges to settle.

`ci.yml`'s `lint` job still runs `actionlint` over every workflow, and the two are
not the same check. actionlint validates an action's INTERFACE and evaluates
neither its prose nor its shell; the runner template-parses the entire manifest
when it LOADS it, so a `${{ … }}` written as an EXAMPLE in an input `description:`
is evaluated against a scope that has no `steps`, the action fails to load, and
every step calling it fails instantly — green actionlint and all. That is the
2026-08-11 failure. Running the action on a PR is what catches it;
`test/workflow-buildx-builder.test.ts` catches it a second way, by refusing `${{`
in the `name:` or `description:` of any local action manifest.

**A pull request builds; it never publishes.** That is not a condition repeated at
each call site. `build-push` folds `github.event_name` into its own effective
`push`, in one place, so a `push: true` call site reached from a pull request
builds and publishes nothing — and an unrecognised spelling of the input is an
error rather than a falsy value, because a release that silently pushed nothing
would go green and starve the next deploy. The prior lock is that a
`pull_request`-triggered run holds no credential to push with: no workflow
reachable from that event runs `docker/login-action` or asks for `packages:
write`. `test/workflow-pr-build-coverage.test.ts` asserts both, and asserts the
coverage itself — that an unfiltered `pull_request` workflow really does run the
action, and that nothing reaches `docker/build-push-action` around it.

What a PR therefore cannot exercise is everything downstream of the push: the
ghcr login, the push and its retry, `release-image.yml`'s tag-digest
verification, the `VERSION` arithmetic, and the deploy. All five need a registry
credential. See [Known limitations](/limitations/).

## The staging config

`infra/strad.staging.yaml` is the live staging config, and it deliberately
exercises all four server kinds so the deploy path is proven end-to-end. It
declares forty-four server slugs:

- `echo` — a `builtin` in `core`, in-process.
- `deepwiki` — a `remote-http` server (`https://mcp.deepwiki.com/mcp`), a
  credential-free canary.
- `anki` — a `local-tunnel`, shipped `enabled: false` on `https://anki.invalid/`,
  a host reserved by RFC 2606 that resolves nowhere. Staging does not borrow the
  machine; it only proves the kind parses and survives a render. Turning it on is
  a hostname in `url` and a flip of the flag. The URL ends at the hostname because
  the add-on serves at the **root** of its port — a `/mcp` suffix would address a
  path nothing serves, and that `404` is an ordinary upstream error rather than an
  unreachable machine, so it would fail a `?servers=` listing outright instead of
  keeping its place with the troubleshooting tool. Like `deepwiki` it costs no
  component.
- thirty-nine `supplementary-image` entries on the one `bundle` component running
  `ghcr.io/tadasant/strad-bundle`. They land on twenty-seven paths, because a
  read-only and a read-write variant of one upstream are two entries sharing one
  `path`: twenty-six of the bundle image's thirty-one baked mounts, plus
  `/grafana-registry`, a per-slug instance the host stands up for that slug's own
  Grafana credential. Nine of them — `telegram-ro`, `telegram-rw`,
  `pulse-subregistry`, `grafana-registry`, `liveoak`, `airtable`, `flightaware`,
  `digitalocean-tadasant-ro` and `digitalocean-tadasant-rw` — carry `enabled: false`
  until their secrets are seeded, so they are skipped at render; see
  [Telegram](/servers/telegram/#not-configured-is-a-supported-state) and
  [A server whose secret is not seeded yet](#a-server-whose-secret-is-not-seeded-yet).
- `zimmer-secrets` — the fortieth `supplementary-image` entry, running that same
  image on its **own** component, `bundle-zimmer-secrets`, because a parameter
  store is `process.env`. See [Two stores, one
  gateway](/operate/secrets/#two-stores-one-gateway).
- `whatsapp-zimmer` — the forty-first, on its own bundle, `bundle-whatsapp`, at
  one instance: it holds the one [WhatsApp](/servers/whatsapp/) linked-device
  socket, and a second replica would open a second socket on the same device. It
  ships `enabled: false` until its secrets are seeded, so the bundle renders no
  component yet.

Roles are `admin: ["*"]`, a deliberately narrow `echo-only: [echo]` — which
keeps the [424 fail-closed path](/intro/concepts/#the-424-contract) meaningful —
and `zimmer: [zimmer-secrets, secrets, echo]`, the role Zimmer's own sessions
hold. `google.enabled` is `false` (it flips true when OAuth creds land),
`mcpOAuth.enabled` is `false` for the same reason and at the same moment — both
need `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`, and the OAuth client must also
list `https://staging.strad.tadasant.com/oauth/callback/google` among its
authorized redirect URIs — and `consoleDevBypass.enabled` is `true`. Flipping
`mcpOAuth` without those seeded is not a dead end: the authorization server does
not run, publishes no metadata, says why at boot, and `/mcp` keeps accepting
static tokens exactly as it does now. See
[Auth](/auth/overview/#mcp--oauth-21-interactive-clients).

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

### A server whose secret is not seeded yet

The render fails closed on a `${NAME}` the store does not hold, and it fails the
**whole spec** — `render-spec` exits 1 and `deploy-staging` never reaches
`doctl`. That is the property worth having (a half-authenticated gateway is worse
than no deploy), and its cost is an ordering rule: **the secret is seeded before
the entry ships enabled.**

A PR cannot seed a secret — staging's store is written by a human in the console,
at `/ui/secrets` — so an entry that arrives ahead of its credential lands
`enabled: false` and is turned on afterwards in a one-line diff. `telegram-ro`,
`telegram-rw` and `pulse-subregistry` are all in that state.

Merging one enabled instead is not a partial outage, it is a full stop: on
2026-08-14, `pulse-subregistry` landed with an unseeded
`PULSEMCP_SUBREGISTRY_API_KEY` and the next `Release image` run on `main` failed
at "Render the App Platform spec", blocking staging for **all thirty** slugs. The
guard is `PROVISIONED_STATICS` in `test/staging-config.test.ts`: the names
staging's store holds, asserted against `bakedSecretNames()` — the same function
`render-spec` derives its demand from. An enabled entry naming anything else
fails CI on the PR rather than the deploy after it.

## Health and console surface

- **`/`** is the front door, and it is a **splash**: the gateway's name and
  environment, the `/mcp` endpoint and its `?servers=` form as copyable fields,
  and a card per door — every nav destination except this page, plus `/console`
  and `/healthz`, which the bar deliberately does not carry. Core-only — a bundle
  component is
  internal and has no front door. It sits behind the **same SSO gate as
  `/connectors` and `/console`**, never a softer door: strad requires identity
  before exposing anything, and even the count of what the gateway fronts is
  something. Today that means the bootstrap token; once
  `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` land it is Google sign-in restricted
  to the configured `auth.google.hostedDomain`, with no code change.
  It carried a directory tile per **enabled** server until that became the third
  rendering of the same list; the roster lives on `/connectors` now, and `/`
  names **no slug at all** — and therefore no title, description, upstream `url`,
  `headers:`, `env:` map, `image` ref, `bundle`, `path`, `module`, `tools:`
  policy or `entitlements`. `test/landing.test.ts` asserts each absence. The one
  number it prints is how many servers are **enabled**; a disabled server is
  absent from `/healthz` too, so counting it here would be the page's only
  net-new fact.
- **`/healthz`** is dependency-free and returns `mode`, `bundle`, `env`, and
  `servers` — used by the App Platform health check and the deploy smoke test. It
  also carries `toolSurfaces`, `degraded` and `unconfigured`: the last
  observation from the background tool-surface monitor, naming the slugs that are
  mounted but serving **no tools**, each with its `state` (`ok` / `empty` /
  `unreachable` / `offline` / `unconfigured`), its tool count and its `kind`.
  Two of those states are deliberately out of `degraded`: `offline` is a
  `local-tunnel` whose machine is switched off, which is that kind's normal
  state, and `unconfigured` is a slug that
  [declared `mayBeUnseeded:`](/operate/secrets/#maybeunseeded--deploying-a-server-ahead-of-its-credential)
  for a credential nobody has seeded yet — a deploy that shipped ahead of a token
  on purpose. The latter gets its own top-level list, because "go and look" and
  "go and seed" are different actions. Slugs only: which `${NAME}` is missing
  stays in the logs and the console, since this route is unauthenticated. Listing the slugs and stopping there was compatible with
  three of them being dead, which is exactly what happened. `ok` stays `true`
  regardless — this route is liveness, and a sick upstream is not a reason for
  App Platform to restart core. The values are read, never computed on request,
  so the route stays instant, and no upstream-authored text appears in them: a
  state word, a count and a kind, about slugs this route already named. In core it
  also carries `mountDegraded`, and a `mount` word (`ok` / `degraded`) on each
  `supplementary-image` surface it read: what the bundle hosting that slug says
  about its mount — a mount can list its tools and fail every call on a stale
  login. It is a third list rather than part of `degraded`, and `mountUnread`
  beside it names the slugs no reading covered, so an unreadable bundle never
  reads as all clear. Slugs and words only; the bundle's own reason stays on the
  bundle's `/healthz`.
- **`/mcp`** is handled by `app.all("/mcp", …)` and always requires a token.
- **`/console`**, `/console/login`, `/console/oauth/callback` and
  `/console/logout` are mounted only in `core` mode. Login state — the PKCE
  verifier, the CSRF `state`, the return path — is a signed 10-minute cookie, not
  a server-side map, so the console survives a restart and spans replicas. See
  [Auth](/auth/overview/#the-sign-in-round-trip).
- **`POST /console/tokens`**, **`POST /console/token-login`** and
  **`POST /console/tokens/:jti/revoke`** — mint, exchange and revoke a
  single-use console login token, for an automated actor that must not hold the
  bootstrap token. Core-only, and mounted only where
  `auth.consoleTokenLogin.enabled` is true and `gateway.env` is `dev`, `local`,
  `test` or `staging`; everywhere else they are an ordinary `404`. Mint takes a
  standing console credential, revoke takes one or the token itself, and the
  exchange takes the token as a JSON body, never the URL, and sets a 30-minute
  `strad_console_token` cookie. That session can view the console and not act
  through it. Unlike the rest of the console's state these records live in
  core's memory, so a restart ends every outstanding token and token session.
  See [Auth](/auth/overview/#console-login-tokens-the-automated-actors-door).
- **`/connectors`** and `/ui/:server`, also core-only, are the human-facing
  server console, behind the same gate as `/`. `/connectors` is the roster: every
  configured server with its scope, a `READY`, `ISSUE`, `INACTIVE` or `UNVERIFIED`
  secret badge (only `ISSUE` counts as an issue), a link to
  its own `/ui/<slug>` page, and — where `gateway.configStore.enabled` is set and
  the store is writable — Edit / Disable / Remove and an "add a connector" menu.
  The roster and the badges are served whether or not there is a store; only the
  editor half depends on one. `/ui` and `/secrets` both `302` to it, because both
  URLs were published. The `/ui` redirect is **exact-path**: `/ui/:server` and
  `/ui/oauth/callback` — the latter registered with Google as a redirect URI —
  are untouched by it.
  A row carries up to two controls beyond the editor's, on two different rules: a
  link to that server's playground, on the entries this console identity may
  actually open (see
  [the console playground](/auth/overview/#the-console-playground)), and a copy
  button for its `${publicUrl}/mcp?servers=<slug>` URL, which contains no
  credential, on every **enabled** entry whatever the reader's roles. A disabled
  entry carries neither, because both lead somewhere the gateway refuses.
  With `gateway.publicUrl` unset, that URL falls back to the origin the request
  arrived on — the same fallback `/` takes, and the reason to set `publicUrl` on
  any deployment where the `Host` header is not the gateway's own name.
  A Google login mints a signed session cookie that renews while it is used and
  dies at an absolute cap counted from sign-in (seven days by default, see
  [the console session](/auth/overview/#the-console-session)); the dev bypass's
  cookie is still the bootstrap token itself, which is a shim (see
  [Known limitations](/limitations/)).
- **`/playground/:server`**, core-only and behind the same gate, is a human MCP
  client for one server: it lists the tools that server serves _you_ and calls
  them with arguments you type. No model is involved. Its two `POST` routes
  (`/tools/list`, `/tools/call`) open a real MCP session **inside the process**
  against the same server object `/mcp` builds, so entitlements and the `tools:`
  policy apply identically — see
  [the console playground](/auth/overview/#the-console-playground). A bare
  `/playground` is the picker: every configured slug, with the ones this console
  session may open as links and the ones it may not named with the reason.
- **`/api/secrets/readiness`** is core-only and is the one authenticated surface
  there that the console gate does **not** guard: its consumer is a machine, so it
  takes a static bearer token through the same path `/mcp` does. It returns the
  console's derivation as JSON — names, paths and states, never a value. See
  [Secrets](/operate/secrets/#get-apisecretsreadiness--the-same-answer-for-a-machine).
