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
(hack #24) renders exactly two components — `core` and `bundle` — and
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

## 20. The human /ui console "session" is the bootstrap token in a cookie

**What.** The human resource browser at `/ui` (and `/ui/:server`) is gated by the
same console SSO as `/console` (see hack #2). Because a browser navigates between
pages, once `ADMIN_BOOTSTRAP_TOKEN` is presented as `?token=…`, the gate moves it
into an **HttpOnly, SameSite=Lax, Secure-in-prod cookie** (`strad_console`) and
redirects to the clean URL, so the token is not left in the address bar, history
or screenshots. That cookie is the entire "session" for now.

**Crucial scope.** Identical to hack #2: this gate is `/console`-class only. It
CANNOT authenticate `/mcp` — that endpoint takes a static system token and
nothing else (`src/auth/index.ts`), and there is no code path from this cookie to
it. `/ui` is HUMAN-facing HTML; it is not the agent endpoint.

**Why.** Google Workspace OAuth credentials are not provisioned yet (hack #2), so
the dev bypass is the only working door. Reusing the already-present bootstrap
token as the cookie value avoids inventing a signing key for a throwaway session
mechanism tonight. The cookie holds a secret the operator already has, HttpOnly
so page JS cannot read it.

**Undo.** When `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` land (hack #2 undo),
`/ui`'s gate redirects to real OAuth and the cookie becomes a proper signed,
expiring session (Redis or a signed cookie — same upgrade hack #7 wants for the
OAuth `state` map). Then this token-in-a-cookie stand-in goes away with the rest
of the dev bypass.

---

## 21. Real per-server GCS creds for /ui/gcs are seeded in a later phase

**✅ RESOLVED (Phase 2).** That later phase happened. `gcs` is `enabled: true`,
scoped to `GCS_BUCKET: pulse_public`, with its service-account key seeded into
GCP Secret Manager for staging and prod. `/ui/gcs` browses a real bucket behind
the SSO gate (401 unauthenticated on both envs, verified).

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

## 25. The secrets/parameters system is wired end-to-end but not yet live

strad now has a store-agnostic secrets/parameters system: Parameter Manager is
the index of everything, Secret Manager backs the secret parts, and everything is
addressed by the path `/strad/{env}/mcp/{slug}/{kind}/{VARIABLE}` (kind `static`
today; an `oauth` kind is issue #32). Three roles touch it, and they are three
DIFFERENT credentials on purpose:

- the MCP **viewer** (`secrets` server, on the bundle) — lists parameters, reads
  notes and NON-secret values, and cannot read a secret value (no
  `secretmanager.versions.access`);
- the console **admin** (core only, from `consoleEnv:`, behind SSO) — reads and
  writes both kinds;
- the runtime **resolver** (deploy-time, `STRAD_PARAMS_*`) — reads both stores'
  values to inject a `params: true` server's env, never over MCP.

What is NOT done, and needs a human with GCP access (see the checklist below and
`docs/.../limitations.md`): the secrets project, the three service accounts and
their keys, and the seeded parameter values. Everything above is tested against an
in-memory fake, so the logic ships proven; the live-GCP staging e2e is deferred.

Posture nuance worth stating plainly: the resolver credential runs at DEPLOY time
(in CI / `render-spec`), NOT in the container, so "the running container holds no
cloud credential" still holds — the resolved values reach the bundle as ordinary
SECRET env vars, exactly like every other secret. Until the resolver service
account exists, a `params: true` supplementary server (`remote-filesystem-tmp-public`)
boots without its resolved parameters and degrades gracefully.

## What the human still needs to provision

A consolidated checklist, cross-referenced above:

- [ ] **The secrets/parameters GCP project + three service accounts** (hack #25):
      a project holding ONLY the `/strad/staging/mcp/*` parameters (its id is a
      LITERAL in `infra/strad.staging.yaml`, `strad-secrets-staging` — not a
      seeded secret, since a project id is not a credential). A fresh project needs
      billing linked (`gcloud billing projects link`) and `--organization`, plus
      `parametermanager` / `secretmanager` / `iam` enabled, before the SAs can be
      created. Exact predefined roles, verified live: the VIEWER SA gets
      `roles/parametermanager.parameterViewer` ONLY (no `secretmanager.versions.access`)
      → seed key as `strad-staging-SECRETS_VIEWER_KEY_JSON`; the ADMIN SA gets
      `roles/parametermanager.admin` (note: `admin`, there is no `parameterAdmin`)
      plus `roles/secretmanager.admin` → `strad-staging-SECRETS_ADMIN_KEY_JSON`; the
      RESOLVER SA gets `roles/parametermanager.parameterViewer` plus
      `roles/secretmanager.secretAccessor` →
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
