# AGENTS.md — strad

Guidance for humans and coding agents working in this repository. (`CLAUDE.md` is
a symlink to this file.)

## What this is

strad is a self-hosted MCP gateway: one endpoint in front of many MCP servers,
selected per request. TypeScript on Node 22 (native TypeScript execution — there
is no build step for `src/` in dev), Express, `@modelcontextprotocol/sdk`, Zod for
the config schema, Vitest for tests. It deploys to DigitalOcean App Platform from
a GHCR image.

## Working here

**Production invariants.** Before starting work, read the desired invariants for
the Tadasant production deployment — some of them are about strad directly. The
`check-invariants-before-starting-work` skill loads them, and the canonical source
is `artifacts/references/PRODUCTION_INVARIANTS.md` (reference id
`production-invariants`) in the private `tadasant/tadasant-internal`. They are
_desired_ invariants: not all of them hold, and work in this repo should move
toward them, not away. If a change moves away from one, say so.

- Use a feature branch off the latest `main`; `main` is protected and lands via PR.
- `npm test` (Vitest) runs unit tests plus a real-MCP-client, in-process E2E.
- `npm run typecheck`, `npm run lint`, `npm run format:check` — all three gate CI.
  The typecheck covers one program: `src/`, `test/` AND `scripts/`. The scripts run
  under `node --experimental-transform-types`, which strips types and checks
  nothing, so `tsc` is the only thing that type-checks them — including
  `render-spec.ts`, which emits the deployed App Platform spec. The two `.mjs`
  scripts in `scripts/` are outside it; `allowJs` is off.
- `npm run config:check -- --config <path>` validates a config the way a deploy
  would, with no secrets. An unknown key is a hard error there — the schema is
  Zod-default, so `consoleEnvs:` for `consoleEnv:` is otherwise stripped in
  silence. CI runs it over every config in this repo; edit one, run it.
- `npm run policy:check -- --tools <dump> --config <path>` is the other config
  gate: every `tools: allow` / `tools: deny` entry must name a tool the mount
  really serves. The dump is `smoke.mjs --json` from the booted bundle image, so
  the `bundle_image` CI job is where it runs. An allow list is exhaustive, so a
  typo'd or renamed entry narrows a slug's surface by one and errors nowhere.
  Anything CI cannot enumerate is skipped WITH A REASON, never failed.
- SIX seams are VENDORED across an npm-tree boundary — nine files, since one of
  them is a library that spans four — and ONE manifest owns all of them: the
  `VENDORED` array in `scripts/sync-vendored.mjs`. Edit the
  source, never the copy; run the sync and commit both halves.
  `npm run vendor:sync` writes every copy, `-- --check` fails if any has drifted,
  `-- --only <id>` does one seam, and `test/vendored.sync.test.ts` runs the check
  over the whole manifest in CI. The per-seam aliases below are thin wrappers on
  `--only <id>`; adding a seventh seam is one entry in the manifest, not a seventh
  copy of the script. An entry is one `source` file copied to each of its
  `targets`, unless it declares `files:` — then `source` and every target are
  DIRECTORIES and each name in `files` crosses between them, so a library that
  spans several modules is still one id and one failure.
  - `npm run telemetry:sync` (`--only telemetry`) re-vendors
    `telemetry/bundle/instrument.mjs` into the seven supplementary images that
    boot through it. Each image is its own Docker build context and cannot COPY
    from the repo root, so an image whose copy rots is a dashboard quietly
    missing a container.
  - `npm run presence:sync` (`--only presence`) re-vendors
    `src/secrets/presence.ts` into the bundle host tree. A drifted copy means one
    component calls `change-me` filler and the other calls it a credential, on
    the same console row.
  - `npm run wire:sync` (`--only wire`) re-vendors
    `src/secrets/parameters/wire.ts` — the id fold, the value encoding, the
    envelope shape — into `servers/secrets`. Both halves address the SAME GCP
    parameter, and a drift here is the one failure in this subsystem that is
    silent (`HACKS.md` #33). `test/parameter-wire.ownership.test.ts` is the
    seam's other half: it fails if that tree grows a second implementation of a
    name the wire owns, which byte-identity alone cannot see.
  - `npm run paramroute:sync` (`--only paramroute`) re-vendors
    `src/secrets/param-route.ts` — the parameter write-back wire, BOTH ends of
    it: the route shape and body core validates, and the client the host calls
    with. Core serves the route and the host is its only caller, so a drift is a
    container persisting a rotated credential to a URL core does not serve — loud
    on the write (the mount degrades), silent on the boot read, which falls back
    to the baked env and looks exactly like a deployment nobody has rotated yet.
  - `npm run envprefix:sync` (`--only envprefix`) re-vendors
    `src/secrets/env-prefix.ts` — the slug → box-variable-name mangling — into
    the bundle host tree. The renderer NAMES a variable and the host is the only
    thing that reads it back, so a drift puts the credential on the container
    under a name nothing looks for: green deploy, clean boot log, every call
    failing on a variable that is right there.
    `test/env-prefix.markers.test.ts` is the seam's other half: it greps both
    trees for the marker variables discovery actually looks for.
  - `npm run elicitation:sync` (`--only elicitation`) re-vendors the four
    `src/*.ts` modules of `servers/onepassword/elicitation` — the unpublished
    `@pulsemcp/mcp-elicitation` — into `images/bundle-google/vendor/`. Both trees
    are built into the SAME bundle image from separate Docker contexts, and both
    consumers gate an irreversible act through the library's
    `requestConfirmation()`: the google copy before an email is SENT, the
    onepassword copy before five tools reveal or mint a credential. A drift is
    two confirmation semantics under one `/mcp`. The seam's other half is in the
    test: `files:` must name every `.ts` file in the source directory, because a
    fifth module added and hand-copied is the one drift byte-identity cannot see.
    The trees' `package.json`, `tsconfig.json` and markdown are identical too and
    stay out of the seam — none of them can carry a `//` banner.
- `npm run dev` starts the gateway on `:8080` against `strad.config.yaml` — the
  stock config, which has zero servers and a console nobody can enter.
- `npm run dev:agent` (`scripts/agent-dev.sh`) is the one to reach for instead:
  a FREE port, `strad.config.dev.yaml` (console bypass on, `echo` mounted), and
  the dev env vars defaulted. `--background` nohups it and polls `/healthz`, so a
  boot crash is reported as one. No Docker and no root — strad has no database,
  no cache and no build step in dev, so there is nothing to containerize for
  correctness. `.agent-containers/` is the heavier path (a workspace container
  per session, `ac.sh clone|status|open|attach|logs|stop|destroy`) and buys
  isolation, not capability. Both are in `docs/.../start/local.md`.
- `servers/**` is **outside** the core TypeScript program (see `eslint.config.js`).
  Each server tree has its own lockfile and is built by its own image.

## Documentation lives in `docs/` — update it in the same PR

`docs/` is the strad documentation site (Astro Starlight, deployed to Cloudflare
Pages). It is the canonical prose for how strad works, and the premise is that it
stays true commit-by-commit.

**If your PR changes behavior, update the page that describes that behavior in the
same PR.** If it introduces a limitation, a hack, or a known-broken edge, add it to
`HACKS.md` and to `docs/src/content/docs/limitations.md` — that page is a feature,
not a confession.

| You changed…                                                                          | Update…                                                                                                                  |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `src/gateway/router.ts`, `registry.ts`, `adapters/**`, `reachability.ts`              | `intro/architecture.md`                                                                                                  |
| `src/gateway/entitlements.ts` (roles, `?servers=`, the 424)                           | `intro/concepts.md`, `auth/overview.md`                                                                                  |
| `src/gateway/toolPolicy.ts` (the `tools:` allow/deny policy)                          | `intro/architecture.md`, `intro/concepts.md`, `servers/adding.md`                                                        |
| `src/deploy/tool-surface.ts`, `scripts/check-tool-policy.ts` (the pre-deploy gate)    | `operate/deploy-model.md`, `operate/operations.md`                                                                       |
| `src/config/schema.ts` — any field, default, or `superRefine` rule                    | `servers/interface.md` **and** `strad.config.example.yaml`                                                               |
| `src/auth/**`                                                                         | `auth/overview.md`                                                                                                       |
| `src/connectors/**`, `src/ui/connector.ts` — the console's Google consent flow        | `operate/connectors.md`, `auth/overview.md`, `servers/interface.md`, `operate/secrets.md`, `operate/deploy-model.md`     |
| `src/deploy/appspec.ts`, `scripts/render-spec.ts`                                     | `operate/deploy-model.md`                                                                                                |
| `src/deploy/spec-file.ts`, `scripts/assert-spec.ts` — the pre-`doctl` spec check      | `operate/operations.md`, `limitations.md`                                                                                |
| `src/deploy/spec-size.ts` — the size ceiling, the warn band, what the refusal says    | `operate/deploy-model.md`, `operate/operations.md`, `limitations.md`                                                     |
| `src/deploy/config-inline.ts` — what `STRAD_CONFIG_YAML` carries, and the spec's size | `operate/deploy-model.md`, `servers/interface.md`, `limitations.md`                                                      |
| `src/secrets/presence.ts`, `src/gateway/bundle-presence.ts`, `src/http/presence.ts`   | `operate/secrets.md`, `auth/overview.md`, `intro/architecture.md`                                                        |
| `src/secrets/parameters/wire.ts` — the id fold, the value encoding, the envelope      | `operate/secrets.md`, `limitations.md`, and `npm run wire:sync`                                                          |
| `src/ui/secret-status.ts` — a state, a label, or the source badge                     | `operate/secrets.md`, `limitations.md`                                                                                   |
| `src/ui/pwa.ts`, `pwa-icons.ts` — the manifest, the worker, what it may cache         | `operate/console-pwa.md`, `auth/overview.md`                                                                             |
| `servers/remote-filesystem/**` — a tool, the link model, the sensitivity model        | `servers/artifact-store.md`, `limitations.md`                                                                            |
| `servers/telegram/**` — a tool, the credential model, the read/write split            | `servers/telegram.md`, `limitations.md`                                                                                  |
| `servers/grafana/**` — the pinned version, the read-only flags, the env allowlist     | `servers/grafana.md`, `limitations.md`, and the counts in `servers/bundle/scripts/smoke.mjs`                             |
| `servers/good-eggs/**` — the basket read, a cart tool, what a result may claim        | `limitations.md`, and `servers/good-eggs/FORK.md`                                                                        |
| `servers/strad-fetch/**` — a strategy, the cache bounds, an env name, the tool        | `servers/strad-fetch.md`, `limitations.md`, and `servers/strad-fetch/FORK.md`                                            |
| `scripts/check-config.ts`, `src/config/strict.ts` — the config CI gate                | `operate/deploy-model.md`, `servers/interface.md`                                                                        |
| `scripts/check-store.ts`, `src/deploy/store-check.ts` — the pre-flip gate             | `operate/deploy-model.md`, `operate/secrets.md`                                                                          |
| `src/deploy/preflight.ts` — what a deploy demands of the store                        | `operate/secrets.md`, `limitations.md`                                                                                   |
| `src/deploy/unseeded.ts`, `src/gateway/unconfigured.ts` — the `mayBeUnseeded:` waiver | `operate/secrets.md`, `servers/interface.md`, `servers/adding.md`, `operate/deploy-model.md`, `limitations.md`           |
| `src/deploy/server-namespaces.ts` — the per-server/gateway resolution order           | `operate/secrets.md`, `operate/deploy-model.md`, `servers/interface.md`                                                  |
| `src/deploy/instance-size.ts` — the closed App Platform plan set, and its two gates   | `servers/interface.md`, `operate/deploy-model.md`, `limitations.md`                                                      |
| `src/secrets/env-prefix.ts` — the slug → box-variable-name mangling                   | `operate/secrets.md`, `limitations.md`, and `npm run envprefix:sync`                                                     |
| `scripts/sync-vendored.mjs` — a seam added to `VENDORED`, or the mechanism itself     | this file's vendored-modules bullet, and `operate/telemetry.md` if the telemetry entry moved                             |
| `servers/onepassword/elicitation/src/**` — the elicitation library itself             | `limitations.md`, `servers/onepassword/README.md`, and `npm run elicitation:sync`                                        |
| `src/secrets/param-route.ts`, `src/http/params.ts` — the credential write-back path   | `operate/secrets.md`, `servers/interface.md`, `operate/deploy-model.md`, `limitations.md`, and `npm run paramroute:sync` |
| `scripts/resolve-image-tag.ts`, `src/deploy/imageTag.ts`                              | `operate/operations.md`                                                                                                  |
| `src/telemetry/**`, `telemetry/bundle/instrument.mjs`                                 | `operate/telemetry.md`                                                                                                   |
| `servers/bundle/**` — a mount added or removed, the Chromium, the `op` CLI            | `intro/architecture.md`, `operate/telemetry.md`, and every count                                                         |
| `infra/strad.staging.yaml`                                                            | `operate/operations.md`, `servers/adding.md`                                                                             |
| `.github/workflows/**`                                                                | `operate/operations.md`                                                                                                  |
| `.agent-containers/**`, `scripts/agent-dev.sh`, `strad.config.dev.yaml`               | `start/local.md`, and `.agent-containers/README.md` + `VERIFY.md`                                                        |
| custom domains, `gateway.publicUrl`                                                   | `operate/dns.md`                                                                                                         |
| a `HACKS.md` entry added or resolved                                                  | `limitations.md`                                                                                                         |

Pages are `docs/src/content/docs/**`. A new page must also be added to the
`sidebar` array in `docs/astro.config.mjs` — Starlight does not auto-discover it.
`cd docs && npm run build` is what CI runs; the `docs_site` job fails the PR if it
breaks.

Diagrams are Mermaid fenced code blocks, rendered client-side. Keep them accurate
to the code rather than illustrative. A diagram showing components that no longer
exist is worse than no diagram.

**Counts are load-bearing, and this repo has gotten them wrong.** Five different
numbers describe "how many servers," and they count different things:

| The number | What it counts                                                                                     |
| ---------- | -------------------------------------------------------------------------------------------------- |
| **3**      | App Platform components: `core`, `bundle`, `bundle-zimmer-secrets`                                 |
| **13**     | dependency trees the bundle Dockerfile builds into `/app/trees`                                    |
| **21**     | MCP servers mounted inside the bundle image (`buildMounts()`)                                      |
| **30**     | `supplementary-image` entries in `infra/strad.staging.yaml` (capability variants included)         |
| **33**     | total server slugs in staging (30 + `echo` builtin + `deepwiki` remote-http + `anki` local-tunnel) |

A slug is not a mount, and a mount is not a component. Before you write a number,
grep for the others.

`bundle-zimmer-secrets` is the third component and the only one that is not there
for capability. What makes it a component is the SLUG, not the store: a second
entitlement and a second console page. A second STORE needs no second component —
`mcpStores:` gives one `secrets` slug a list of them, each with its own project,
namespaces, viewer credential and probed capability, rendered onto the bundle as
a `SECRETS_STORES` descriptor.

Two secrets SLUGS in ONE bundle is still silently wrong, and for the same reason
it always was: a bundle is a container is one `process.env`, the secrets tree
reads it by the bare name, and one store would answer under two slugs. The
`superRefine` in `src/config/schema.ts` rejects it — both shapes of it, a shared
`SECRETS_PROJECT_ID` and two servers declaring `mcpStores:` on one bundle. What
that rule cannot see is a `params: true` variable — its NAME comes from a path in
the store — so `renderAppSpec` throws separately when a resolved parameter would
shadow a sibling's variable on the same bundle.

**Brand and voice.** All user-facing prose (docs, README, console copy) follows
`references/BRAND.md` (what strad is and the opinions that follow) and
`references/BRAND_VOICE.md` (plain, direct, honest, lowercase `strad`, no AI slop).
Both travel with the `sync-docs` skill. Write new prose in that voice; don't leave
slop behind when you fix a stale fact.

## Architecture (orientation)

- `src/index.ts` — boot: mode → config → telemetry → secrets → registry → app.
- `src/gateway/router.ts` — the `/mcp` handler. Authenticates, resolves the
  selection, builds a fresh stateless MCP `Server` per request, and proxies.
- `src/gateway/entitlements.ts` — who may reach which server. The query string
  proposes; the token disposes.
- `src/gateway/toolPolicy.ts` — which _tools_ a slug may use. Enforced on
  `tools/list` and on `tools/call`.
- `src/gateway/adapters/` — the one `ServerAdapter` interface (`listTools`,
  `callTool`, `close`) that every server kind reduces to.
- `src/gateway/reachability.ts` — which slugs actually SERVE tools. A slug can be
  configured, entitled, routed and dead, and the only symptom is an empty
  `tools/list`. Probed on an interval, logged when it changes for the worse,
  published on `/healthz` as `degraded`, asserted by the staging deploy.
- `src/config/schema.ts` — the Zod config schema. It is the product's contract.
- `src/config/strict.ts` — the deploy-time strict parse. Zod strips unknown keys
  and boot stays lenient on purpose (a rollback must not become an outage), so
  "did I typo a key" is answered here, by `scripts/check-config.ts`.
- `src/deploy/appspec.ts` — turns the config into a DigitalOcean App Platform spec.
  The server list decides the container topology.
- `servers/bundle/` — one image, 21 mounted MCP servers, one shared Chromium,
  assembled from THIRTEEN independently-built dependency trees.
- `servers/remote-filesystem/` — strad's own artifact store, behind the
  `remote-filesystem-tmp-public` slug. `is_sensitive` picks the KIND of link;
  GCS's 7-day V4 ceiling is why the 14-day default is signed with V2.
- `servers/strad-fetch/` — strad's own web-fetching server, behind the
  `strad-fetch` slug. A fork of `@pulsemcp/pulse-fetch` whose point is what
  happens when a credential is absent or rejected: native HTTP always stays in
  the strategy chain, so a bad BrightData key costs coverage rather than the
  fetch. `servers/strad-fetch/FORK.md` has the deltas and the incident behind
  each.
- `servers/good-eggs/` — the Good Eggs grocery server, behind the `good-eggs`
  slug. A fork, not a vendor copy: the package its defects were reported against
  declares no repository, so there was no upstream to fix. Its cart reads come
  from the `storeData` payload every page renders rather than from the drawn
  markup — the markup depends on which of two basket layouts the account is
  served, and a scrape that knew one of them reported an empty cart against a
  43-item basket. `servers/good-eggs/FORK.md` has the deltas.
- `servers/telegram/` — strad's own Telegram server, behind `telegram-ro` and
  `telegram-rw`. MTProto with a USER session, because the Bot API cannot read the
  history of a group its account does not administer. The credential is a
  logged-in account; the library lives behind one function in `mtproto.ts`.

The prose for all of the above is in `docs/`.

## AI artifacts

`skills/` and `references/` are an AIR catalog, indexed by `skills/skills.json` and
`references/references.json`. They are read by the agent orchestrator, not by strad
at runtime. Only strad-specific artifacts belong here — generic workflow skills
(`pr`, `wait-for-ci`) come from the orchestrator's default set, and duplicating one
collides on shortname.

`skills/sync-docs/` is default-on for this repo: run it as the last step before
opening any PR.

## Conventions

- Lowercase `strad` everywhere in prose, including sentence-initial.
- No temporal comments ("now", "used to be") — write code and docs as the
  canonical current state.
- A backticked repo-relative path in a comment is a CLAIM, and
  `test/comment-paths.test.ts` checks it: under `src/`, `scripts/` and `test/`,
  every one has to resolve. The same header named a suite that had been deleted
  and then one that never existed (#178, #252), in both cases telling a reader
  where a leak rule is asserted. Two forms resolve as conventions rather than
  errors — an elided `docs/.../operate/secrets.md`, and the doc-site route
  `docs/operate/secrets.md` (or `docs/operate/secrets`, the route Starlight
  actually serves) for a page whose file is
  `docs/src/content/docs/operate/secrets.md`. A trailing `:174` line reference
  and a `#heading` fragment are stripped before resolving, so both are fine to
  write. A comment that must name a file
  which is NOT there writes it without backticks; the backticks are the claim.
  `servers/**` is not walked, because each tree there has its own root — the
  vendored copies are checked at their source under `src/`.
- Don't add backwards-compat shims during refactors; update all call sites.
- Never commit secrets. How they reach the container depends on
  `gateway.secrets.provider` (see `docs/.../operate/secrets.md`), and there is one
  path per deployment:
  - `env` (the default) — secrets arrive as App Platform SECRET env vars at
    deploy time, and the running container holds no cloud credential.
  - `gcp-parameter-store` — the container holds exactly ONE credential, the
    resolver key that reaches the store, and reads everything else at runtime.
    The resolver identity is `parametermanager.parameterViewer` +
    `parametermanager.parameterAccessor` (the second is what `:render` needs;
    `parameterViewer` alone lists everything and 403s on every value) — never the
    `secrets` server's viewer key, never the console's admin key, never CI's
    `GCP_SA_KEY`. A secret parameter also grants its OWN principal
    `secretmanager.secretAccessor` on its secret; `create()` does that, and
    without it every `:render` is a `400 SECRET_REFERENCE_ERROR`.
    A secret value is stored BASE64URL-encoded in Secret Manager, and its
    envelope carries `"encoding":"base64url"`. `:render` splices the bytes into
    the JSON payload as TEXT and rejects a structurally damaged result, so a raw
    `"`, `\`, `{`, `}` or newline is a `400 … injection detected` — i.e. every PEM
    key and every JSON blob. An ABSENT `encoding` means the literal bytes, which
    is what parameters written before this carry; do not make it mean "unknown".
    Because that grant exists, `:render` is a live read path for secret values,
    and **the `secrets` MCP credential must NEVER hold
    `roles/parametermanager.parameterAccessor`** — withholding it is the only
    thing keeping `/mcp` away from a prod secret value. `parameterViewer` is the
    read role; `parameterAccessor` is the deref, despite the names.
    A credential that only strad's own process needs must be scoped to the strad
    image (`STRAD_IMAGE_ONLY_SECRET_KEYS` in `src/deploy/appspec.ts`): a plain
    SECRET in the app spec is BROADCAST to every supplementary container.
- Telemetry never records tool arguments or results. See `src/telemetry/redact.ts`;
  `test/telemetry.redaction.test.ts` is the canary that enforces it — over spans,
  metrics AND exported log records.
- Exception reporting (`src/telemetry/errors.ts`, `SENTRY_DSN`, off by default) is
  the ONE channel that ships free text: strad's own crashes, message and stack. It
  reports uncaught exceptions, unhandled rejections and boot failures, and
  deliberately NOT the `event()` fault path — those carry upstream-authored text
  and already export as allowlisted log records. Everything it sends is rebuilt
  from a key allowlist and scrubbed by `scrubText()`. Widening either is a
  decision about the same boundary; make it in `redact.ts`, deliberately.
- Logs: the stdout STREAM is never shipped (it carries upstream text we did not
  author). strad's own events are, field by field, against the allowlist in
  `src/telemetry/events.ts` — deny by default, and `error` is on no list. Use
  `event()` rather than `console.log(JSON.stringify(...))` for anything an
  operator would need in an incident; a line that only reaches stdout, on App
  Platform, reaches nobody.

## Known sharp edge

**An App Platform spec update is a full replace: an omitted field is a deletion.**
This already detached a custom domain once and took `staging.strad.tadasant.com` to
a TLS handshake failure while the app stayed healthy on its `*.ondigitalocean.app`
ingress. `render-spec` now defaults `domains` from `gateway.publicUrl`, but verify
the custom domain still serves after any deploy. See `HACKS.md` #18.
