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

**Ops without box access.** The "Operability" invariant has a design side that
every strad PR has to meet. A feature is a design defect if operating it needs a
shell on a running container (`doctl apps console`) or a step applied by hand
outside the deploy: a one-off script, an edit to the live app spec, a manual
restart. Every operational step a feature implies (seeding or rotating a
credential, re-encoding a stored parameter, a config change) goes through a
deploy, an idempotent or scheduled job, strad's own console / API / `/mcp`
surface, or a GitHub Actions workflow. A PR that cannot avoid such a step says so
in its body and records the step in `HACKS.md` and
`docs/src/content/docs/limitations.md`, so it never ships as an unmarked
"then run X on the box". Break-glass access is for incidents; routine operation
does not use it.

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
- ELEVEN seams are VENDORED across an npm-tree boundary — eighteen files, since
  two of them are libraries that span four and five — and ONE manifest owns all of them: the
  `VENDORED` array in `scripts/sync-vendored.mjs`. Edit the
  source, never the copy; run the sync and commit both halves.
  `npm run vendor:sync` writes every copy, `-- --check` fails if any has drifted,
  `-- --only <id>` does one seam, and `test/vendored.sync.test.ts` runs the check
  over the whole manifest in CI. The per-seam aliases below are thin wrappers on
  `--only <id>`; adding a twelfth seam is one entry in the manifest, not a
  twelfth copy of the script. An entry is one `source` file copied to each of its
  `targets`, unless it declares `files:` — then `source` and every target are
  DIRECTORIES and each name in `files` crosses between them, so a library that
  spans several modules is still one id and one failure.
  - `npm run telemetry:sync` (`--only telemetry`) re-vendors
    `telemetry/bundle/instrument.mjs` into the seven supplementary images that
    boot through it. Each image is its own Docker build context and cannot COPY
    from the repo root, so an image whose copy rots is a dashboard quietly
    missing a container.
  - `npm run presence:sync` (`--only presence`) re-vendors
    `src/secrets/presence.ts` into the bundle host tree. It carries BOTH ends of
    `POST /_strad/presence` — the vocabulary and `presenceResponse`, the route
    those words are spoken through — because the copy the fleet runs is the host
    image's. A drifted copy means one component calls `change-me` filler and the
    other calls it a credential, on the same console row; a second handler means
    one of them stops answering `cache-control: no-store` and the console renders
    a cached "absent" for a credential that is present. Each tree keeps only the
    three-line express adapter, and injects its own `node:crypto`
    `timingSafeEqual` — the module stays import-free. It also carries
    `bearerToken` and `constantTimeEquals`, the one `Authorization` parse and
    the one comparator every door in BOTH trees authenticates with; core binds
    them in `src/auth/credential.ts`. A drifted copy is the host's mounts
    answering a header differently from core's doors.
  - `npm run wire:sync` (`--only wire`) re-vendors
    `src/secrets/parameters/wire.ts` — the id fold, the value encoding, the
    envelope shape — into `servers/secrets`. Both halves address the SAME GCP
    parameter, and a drift here is the one failure in this subsystem that is
    silent (`HACKS.md` #33). `test/parameter-wire.ownership.test.ts` is the
    seam's other half: it fails if that tree grows a second implementation of a
    name the wire owns, which byte-identity alone cannot see.
  - `npm run capabilities:sync` (`--only capabilities`) re-vendors
    `src/secrets/parameters/capability-table.ts` — the ten IAM permission strings
    and the fold into four booleans — into `servers/secrets`. Each tree keeps its
    own transport; what is shared is what gets asked and what the answer MEANS,
    because both doors derive a SURFACE from it: the `secrets` server's whole
    tool list and the console's reveal and write affordances. A drift is silent
    both ways — a widened copy lists a write tool for a credential that cannot
    finish the write, and a one-character typo is a permission Google does not
    recognise, which comes back outside the held set and withholds a tool from a
    credential that holds it.
  - `npm run paramroute:sync` (`--only paramroute`) re-vendors
    `src/secrets/param-route.ts` — the parameter write-back wire, BOTH ends of
    it: the route shape and body core validates, and the client the host calls
    with. Core serves the route and the host is its only caller, so a drift is a
    container persisting a rotated credential to a URL core does not serve — loud
    on the write (the mount degrades), silent on the boot read, which falls back
    to the baked env and looks exactly like a deployment nobody has rotated yet. It
    also carries the store-served instance wire — the list and env shapes, the
    client and the reconciler — where a drift is every instance on a component
    left unbuilt, reported only as a list or env the host could not read.
  - `npm run envprefix:sync` (`--only envprefix`) re-vendors
    `src/secrets/env-prefix.ts` — the slug → box-variable-name mangling — into
    the bundle host tree. The renderer NAMES a variable and the host is the only
    thing that reads it back, so a drift puts the credential on the container
    under a name nothing looks for: green deploy, clean boot log, every call
    failing on a variable that is right there.
    `test/env-prefix.markers.test.ts` is the seam's other half: it greps both
    trees for the marker variables discovery actually looks for. It also carries
    `STRAD_ENV_COPIES`, the list of per-slug names the renderer bakes once and
    the host restores at boot (`HACKS.md` #146) — a drift there is every folded
    per-slug name missing from a running bundle.
  - `npm run writerules:sync` (`--only writerules`) re-vendors
    `src/secrets/parameters/write-rules.ts` — the version ranking, the `v{n+1}`
    mint, and the `secretAccessor` policy edit that makes a secret parameter's
    `__REF__` renderable — into `servers/secrets`. It is the MUTATING half of the
    same parameter the wire addresses, and every rule in it fails silently: a
    writer that ranks or mints differently writes a version every reader skips
    (the rotate reports success and the old value keeps being served), and a
    parameter written without the grant renders `400 SECRET_REFERENCE_ERROR` for
    every reader forever. Only the decisions are shared — the listing, the POST
    and the read-modify-write around the policy stay at each call site, including
    the `options.requestedPolicyVersion=3` the read must ask for.
    `test/parameter-write-rules.ownership.test.ts` is the seam's other half: byte
    identity cannot see the tree growing a second implementation beside the copy,
    nor either half quietly ceasing to import it.
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
  - `npm run statestore:sync` (`--only statestore`) re-vendors
    `src/state/store.ts` — strad's STATE STORE: the GCS client, the AES-256-GCM
    seal, the single-writer lease, and the rules for the ONE shared bucket
    (`STRAD_STATE_GCS_*`, a folder per consumer under its own root, a key per
    consumer) — into `servers/whatsapp/shared/src/state-store.ts`,
    `servers/bundle-api/fork/slack/src/events/state-store.ts`,
    `servers/messenger/shared/src/state-store.ts` and
    `images/bundle-google/src/events/state-store.ts`. Core does not run
    it; it lives under `src/` so the root `tsc`, ESLint and Vitest cover the one
    copy that is edited. A drift is two servers disagreeing about the bucket they
    share — whose folder is whose, what a lease means — and its first symptom is
    one server's state appearing to be gone. A new stateful server is a third
    target, not a fourth GCS client (`HACKS.md` #138).
  - `npm run eventswebhook:sync` (`--only eventswebhook`) re-vendors the
    MCP Events WEBHOOK ENGINE — `servers/bundle-api/fork/slack/src/events/webhook/`:
    the registry, the Standard Webhooks signing, the SSRF-guarded transport,
    the delivery engine and the cursor's wire form — into
    `images/bundle-google/src/events/webhook/`, where Gmail's
    `message_received` runs on it, and
    `servers/whatsapp/shared/src/events/webhook/`, where WhatsApp's does.
    Edit it in the Slack tree. A drift is two
    webhook semantics under one `/mcp`: a receiver right about one source's
    signatures, retries or cursors would be wrong about the other's.
  - `npm run deposit:sync` (`--only deposit`) re-vendors
    `src/secrets/deposit-wire.ts` — BOTH ends of `POST /_strad/deposit`: the
    route path, the body and receipt, and `depositToken`, the bearer core and
    strad-hostd each DERIVE from the custody slug's key rather than store —
    into `hostd/src/custody/deposit-wire.ts`. Core serves the route and the
    custody server on the owner's Mac is its only caller. A drift is every
    deposit refused, loudly, on that machine (`HACKS.md` #141).
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
- `hostd/` is **strad-hostd**, the daemon that runs on a machine a person owns and
  serves the shell, browser, two computer-use and a read-only Messages MCP
  server behind `local-tunnel` slugs. It is its own npm tree (`cd hostd && npm ci && npm test`)
  and is NOT under `servers/`: everything there is baked into the bundle image,
  and this code never runs in a strad container. `hostd/extension/` is the
  Chrome extension the browser server prefers when it is connected — the one
  route into the owner's default profile with no per-connection prompt — and
  the daemon packs and serves it itself (`src/extension/`); bump its
  `manifest.json` version when it changes, or a force-installed Chrome keeps
  the old copy. Root ESLint and Prettier cover
  its source; the root `tsc` does not. `hostd/ax/` is `strad-hostd-ax`, the Swift
  helper the computer-use servers and the on-screen banner go through, and
  `hostd/messages/` is `strad-hostd-messages`, the read-only helper that holds
  Full Disk Access for the Messages server. Both build only on macOS, and
  `.github/workflows/hostd-ax.yml` is the ONE workflow in this repository on
  macOS runners, path-filtered to them. The Node suite
  runs on Linux against fake helpers, so the macOS halves — the `osascript`
  consent dialog, the real LaunchAgents (the installer's restart paths run on a
  throwaway agent in that workflow's `launchd` job), the installer's `cloudflared`
  branch, the signing script, a real Accessibility tree, a real screenshot, the real
  chat.db under a real Full Disk Access grant — are exercised by nothing but
  the owner's Mac. Do not describe them as tested.

## Documentation lives in `docs/` — update it in the same PR

`docs/` is the strad documentation site (Astro Starlight, deployed to Cloudflare
Pages). It is the canonical prose for how strad works, and the premise is that it
stays true commit-by-commit.

**If your PR changes behavior, update the page that describes that behavior in the
same PR.** If it introduces a limitation, a hack, or a known-broken edge, add it to
`HACKS.md` and to `docs/src/content/docs/limitations.md` — that page is a feature,
not a confession.

| You changed…                                                                                                                         | Update…                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/gateway/router.ts`, `registry.ts`, `adapters/**`, `reachability.ts`                                                             | `intro/architecture.md`                                                                                                                                                              |
| `src/gateway/entitlements.ts` (roles, `?servers=`, the 424)                                                                          | `intro/concepts.md`, `auth/overview.md`                                                                                                                                              |
| `src/gateway/elicitation.ts`, `images/bundle-google/src/confirm.ts` — a confirmed tool, the header, the allowlist                    | `servers/confirmations.md`, `auth/overview.md`, `servers/interface.md`, `limitations.md`, **and** `strad.config.example.yaml`                                                        |
| `src/gateway/toolPolicy.ts` (the `tools:` allow/deny policy)                                                                         | `intro/architecture.md`, `intro/concepts.md`, `servers/adding.md`                                                                                                                    |
| `src/config/reach.ts`, `src/http/reach.ts` — a flow-through grant, the `/_strad/reach` route                                         | `servers/flow-through.md`, `intro/architecture.md`, `limitations.md`, `servers/interface.md`, **and** `strad.config.example.yaml`                                                    |
| `src/ui/apps.ts` — the console as an MCP Apps host, and what an app may do there                                                     | `servers/apps.md`, `intro/architecture.md`, `limitations.md`                                                                                                                         |
| `src/deploy/tool-surface.ts`, `scripts/check-tool-policy.ts` (the pre-deploy gate)                                                   | `operate/deploy-model.md`, `operate/operations.md`                                                                                                                                   |
| `src/config/schema.ts` — any field, default, or `superRefine` rule                                                                   | `servers/interface.md` **and** `strad.config.example.yaml`                                                                                                                           |
| `src/config/env-name.ts` — the env-var name rule, its `${…}` form, or the length cap                                                 | `servers/interface.md`, `operate/secrets.md`, `limitations.md`, and the three vendored literals `test/env-name.test.ts` greps                                                        |
| `src/auth/**`                                                                                                                        | `auth/overview.md`                                                                                                                                                                   |
| `src/connectors/**`, `src/ui/connector.ts` — the console's Google consent flow                                                       | `operate/connectors.md`, `auth/overview.md`, `servers/interface.md`, `operate/secrets.md`, `operate/deploy-model.md`                                                                 |
| `src/deploy/appspec.ts`, `scripts/render-spec.ts`                                                                                    | `operate/deploy-model.md`                                                                                                                                                            |
| `src/deploy/spec-file.ts`, `scripts/assert-spec.ts` — the pre-`doctl` spec check                                                     | `operate/operations.md`, `limitations.md`                                                                                                                                            |
| `src/deploy/spec-size.ts` — the size ceiling, the warn band, what the refusal says                                                   | `operate/deploy-model.md`, `operate/operations.md`, `limitations.md`                                                                                                                 |
| `src/deploy/config-inline.ts` — what `STRAD_CONFIG_YAML` carries, and the spec's size                                                | `operate/deploy-model.md`, `servers/interface.md`, `limitations.md`                                                                                                                  |
| `src/secrets/presence.ts`, `src/gateway/bundle-presence.ts`, `src/http/presence.ts`                                                  | `operate/secrets.md`, `auth/overview.md`, `intro/architecture.md`, and `npm run presence:sync`                                                                                       |
| `src/secrets/parameters/wire.ts` — the id fold, the value encoding, the envelope                                                     | `operate/secrets.md`, `limitations.md`, and `npm run wire:sync`                                                                                                                      |
| `src/secrets/parameters/write-rules.ts` — the ranking, the mint, the render grant                                                    | `operate/secrets.md`, and `npm run writerules:sync`                                                                                                                                  |
| `src/ui/secret-status.ts` — a state, a label, or the source badge                                                                    | `operate/secrets.md`, `limitations.md`                                                                                                                                               |
| `src/ui/pwa.ts`, `pwa-icons.ts` — the manifest, the worker, what it may cache                                                        | `operate/console-pwa.md`, `auth/overview.md`                                                                                                                                         |
| `src/ui/nav.ts` — a console destination added, removed, relabelled or reordered                                                      | `auth/overview.md`, the doors in `src/ui/landing.ts`, `operate/runtime-config.md`, `operate/operations.md`                                                                           |
| `src/ui/roster-page.ts` — the roster, a badge, the grouping, an editor control                                                       | `operate/secrets.md`, `operate/runtime-config.md`, `operate/operations.md`, `auth/overview.md`                                                                                       |
| `src/ui/landing.ts` — what the splash at `/` carries, and what it withholds                                                          | `operate/operations.md`, `auth/overview.md`, and the absences `test/landing.test.ts` asserts                                                                                         |
| `src/state/store.ts` — the shared state store: a variable, the folder rule, the seal, the lease                                      | `operate/state-store.md`, `servers/whatsapp.md`, `servers/events.md`, `limitations.md`, and `npm run statestore:sync`                                                                |
| `servers/remote-filesystem/**` — a tool, the link model, the sensitivity model                                                       | `servers/artifact-store.md`, `limitations.md`                                                                                                                                        |
| `hostd/**` — a tool, the consent gate, the kill switch, the banner, the helper, the install                                          | `servers/hostd.md`, `servers/hostd-design.md`, `hostd/README.md`, `limitations.md`, and `operate/operations.md` if `hostd-ax.yml` moves with it                                      |
| `hostd/src/custody/**`, `src/http/deposit.ts`, `src/secrets/deposit-wire.ts` — custody, the hold, the deposit route                  | `servers/hostd-custody.md`, `operate/secrets.md`, `operate/secrets-iam.md`, `limitations.md`, and `npm run deposit:sync`                                                             |
| `servers/telegram/**` — a tool, the credential model, the read/write split                                                           | `servers/telegram.md`, `limitations.md`                                                                                                                                              |
| `servers/messenger/**` — a tool, the login steps, the snapshot, the bridge or its pin                                                | `servers/messenger.md`, `limitations.md`, `servers/messenger/README.md`, and the counts in `servers/bundle/scripts/smoke.mjs`                                                        |
| `servers/bill-spend/**` — a tool, the write's body shapes, the read-back rule                                                        | `servers/bill-spend.md`, `limitations.md`, and the counts in `servers/bundle/scripts/smoke.mjs`                                                                                      |
| `servers/aws-device-farm/**` — a tool, the driving wire, the cost model                                                              | `servers/aws-device-farm.md`, `servers/aws-device-farm-setup.md`, `limitations.md`, and the counts in `servers/bundle/scripts/smoke.mjs`                                             |
| `servers/liveoak/**` — a tool, the login or device flow, what the bank's API is sent                                                 | `servers/liveoak.md`, `limitations.md`, and the counts in `servers/bundle/scripts/smoke.mjs`                                                                                         |
| `servers/ssh/**` — a tool, the host-key pin, what an SSH slug may be entitled to                                                     | `servers/ssh.md`, `limitations.md`, `strad.config.example.yaml`, and the counts in `servers/bundle/scripts/smoke.mjs`                                                                |
| `servers/image-tools/**` — a tool, the URL guard, a bound in `limits.ts`, the alignment                                              | `servers/image-tools.md`, `limitations.md`, and the counts in `servers/bundle/scripts/smoke.mjs`                                                                                     |
| `servers/nutrition-facts/**` — a tool, a pinned source, the matching or range rules, the FatSecret budget                            | `servers/nutrition-facts.md`, `limitations.md`, and the counts in `servers/bundle/scripts/smoke.mjs`                                                                                 |
| `servers/{airtable,flightaware,digitalocean}/**` — a tool, a tier, what a result may carry                                           | `servers/airtable.md`, `servers/flightaware.md`, `servers/digitalocean.md`, `limitations.md`, and the counts in `servers/bundle/scripts/smoke.mjs`                                   |
| `servers/hetzner/**` — a tool, a tier, the blast-radius text, what a result may carry                                                | `servers/hetzner.md`, `limitations.md`, the `hetzner-pulse-ro` allow list in `infra/strad.staging.yaml`, and the counts in `servers/bundle/scripts/smoke.mjs`                        |
| `servers/glitchtip/**` — a tool, the path guard, the https rule, the result cap                                                      | `servers/glitchtip.md`, `limitations.md`, and the counts in `servers/bundle/scripts/smoke.mjs`                                                                                       |
| `servers/vendor-billing/**` — a tool, a vendor request, the scrubber, the table-identifier patterns                                  | `servers/vendor-billing.md`, `limitations.md`, and the counts in `servers/bundle/scripts/smoke.mjs`                                                                                  |
| `servers/postgres/**` — a tool, the statement guard, the read-only transaction, the TLS rule, a cap                                  | `servers/postgres.md`, `limitations.md`, and the counts in `servers/bundle/scripts/smoke.mjs`                                                                                        |
| `servers/grafana/**` — the pinned version, the read-only flags and write opt-in, the env allowlist                                   | `servers/grafana.md`, `limitations.md`, and the counts in `servers/bundle/scripts/smoke.mjs`                                                                                         |
| `servers/victorialogs/**` — the pinned version, the env allowlist, the unconfigured placeholder                                      | `servers/victorialogs.md`, `limitations.md`, and the counts in `servers/bundle/scripts/smoke.mjs`                                                                                    |
| `servers/good-eggs/**` — the basket read, a cart tool, what a result may claim                                                       | `limitations.md`, and `servers/good-eggs/FORK.md`                                                                                                                                    |
| `servers/strad-fetch/**` — a strategy, the cache bounds, an env name, the tool                                                       | `servers/strad-fetch.md`, `limitations.md`, and `servers/strad-fetch/FORK.md`                                                                                                        |
| `scripts/check-config.ts`, `src/config/strict.ts` — the config CI gate                                                               | `operate/deploy-model.md`, `servers/interface.md`                                                                                                                                    |
| `src/config/overlay.ts` — what a runtime roster write may create, edit or move                                                       | `operate/runtime-config.md`                                                                                                                                                          |
| `src/config/overlay.ts` — what a write may REACH, measured from its author                                                           | `operate/runtime-config.md`, `limitations.md`, `operate/runtime-config-plan.md`, `intro/architecture.md`                                                                             |
| `src/config/secret-position.ts` — which fields a runtime write may only reference                                                    | `operate/runtime-config.md`, `limitations.md`, `operate/runtime-config-plan.md`                                                                                                      |
| `src/config/mcp-json.ts`, `mcp-json-refs.ts` — the draft SEP-2633 input dialect                                                      | `servers/interface.md`, `servers/adding.md`, `limitations.md`, **and** `strad.config.example.yaml`                                                                                   |
| `scripts/check-store.ts`, `src/deploy/store-check.ts` — the pre-flip gate                                                            | `operate/deploy-model.md`, `operate/secrets.md`                                                                                                                                      |
| `src/deploy/preflight.ts` — what a deploy demands of the store                                                                       | `operate/secrets.md`, `limitations.md`                                                                                                                                               |
| `src/deploy/unseeded.ts`, `src/gateway/unconfigured.ts` — the `mayBeUnseeded:` waiver                                                | `operate/secrets.md`, `servers/interface.md`, `servers/adding.md`, `operate/deploy-model.md`, `limitations.md`                                                                       |
| `src/deploy/server-namespaces.ts` — the per-server/gateway resolution order                                                          | `operate/secrets.md`, `operate/deploy-model.md`, `servers/interface.md`                                                                                                              |
| `src/deploy/instance-size.ts` — the closed App Platform plan set, and its two gates                                                  | `servers/interface.md`, `operate/deploy-model.md`, `limitations.md`                                                                                                                  |
| `src/secrets/parameters/capability-table.ts` — a permission string, or the fold                                                      | `operate/secrets.md`, and `npm run capabilities:sync`                                                                                                                                |
| `src/secrets/env-prefix.ts` — the slug → box-variable-name mangling                                                                  | `operate/secrets.md`, `limitations.md`, and `npm run envprefix:sync`                                                                                                                 |
| `scripts/sync-vendored.mjs` — a seam added to `VENDORED`, or the mechanism itself                                                    | this file's vendored-modules bullet, and `operate/telemetry.md` if the telemetry entry moved                                                                                         |
| `servers/onepassword/elicitation/src/**` — the elicitation library itself                                                            | `limitations.md`, `servers/onepassword/README.md`, and `npm run elicitation:sync`                                                                                                    |
| `src/secrets/param-route.ts`, `src/http/params.ts` — the credential write-back path                                                  | `operate/secrets.md`, `servers/interface.md`, `operate/deploy-model.md`, `limitations.md`, and `npm run paramroute:sync`                                                             |
| `src/http/instances.ts` — the store-served instance routes, what an instance is served                                               | `operate/secrets.md`, `operate/runtime-config.md`, `operate/telemetry.md`, `limitations.md`, and `npm run paramroute:sync` if the wire in `src/secrets/param-route.ts` moves with it |
| `scripts/resolve-image-tag.ts`, `src/deploy/imageTag.ts`                                                                             | `operate/operations.md`                                                                                                                                                              |
| `src/http/retry.ts` — the transient-status set, `Retry-After`, a budget's ceilings                                                   | `operate/operations.md`, `operate/secrets.md`, `limitations.md`                                                                                                                      |
| `src/http/async-route.ts` — the one async-route guard, or a route's failure answer                                                   | `intro/architecture.md`, `operate/telemetry.md`                                                                                                                                      |
| `servers/bundle-api/fork/slack/src/events/**`, `images/bundle-google/src/events/**` — an event type, an argument, the webhook engine | `servers/events.md`, `limitations.md`, `docs/mcp-events-spec-pin.md`, and `npm run eventswebhook:sync` if `webhook/` moved                                                           |
| `servers/whatsapp/shared/src/events/**` — the WhatsApp event, an argument, the payload                                               | `servers/events.md`, `servers/whatsapp.md`, `limitations.md`, `docs/mcp-events-spec-pin.md`                                                                                          |
| `src/telemetry/**`, `telemetry/bundle/instrument.mjs`                                                                                | `operate/telemetry.md`                                                                                                                                                               |
| `servers/bundle/**` — a mount added or removed, the Chromium, the `op` CLI                                                           | `intro/architecture.md`, `operate/telemetry.md`, and every count                                                                                                                     |
| `infra/strad.staging.yaml`                                                                                                           | `operate/operations.md`, `servers/adding.md`                                                                                                                                         |
| `.github/workflows/**`                                                                                                               | `operate/operations.md`                                                                                                                                                              |
| `.agent-containers/**`, `scripts/agent-dev.sh`, `strad.config.dev.yaml`                                                              | `start/local.md`, and `.agent-containers/README.md` + `VERIFY.md`                                                                                                                    |
| custom domains, `gateway.publicUrl`                                                                                                  | `operate/dns.md`                                                                                                                                                                     |
| a `HACKS.md` entry added or resolved                                                                                                 | `limitations.md`                                                                                                                                                                     |

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
| **29**     | dependency trees the bundle Dockerfile builds into `/app/trees`                                    |
| **38**     | MCP servers mounted inside the bundle image (`buildMounts()`)                                      |
| **45**     | `supplementary-image` entries in `infra/strad.staging.yaml` (capability variants included)         |
| **48**     | total server slugs in staging (45 + `echo` builtin + `deepwiki` remote-http + `anki` local-tunnel) |

A slug is not a mount, and a mount is not a component. Before you write a number,
grep for the others.

`bundle-zimmer-secrets` is the third component and the only one that is not there
for capability. What makes it a component is the SLUG, not the store: a second
entitlement and a second console page. A second STORE needs no second component —
`mcpStores:` gives one `secrets` slug a list of them, each with its own project,
namespaces, viewer credential and probed capability, rendered onto the bundle as
a `SECRETS_STORES` descriptor. `bundle-whatsapp` becomes a fourth once
`whatsapp-zimmer` is enabled, and it is not there for capability either: it holds
the one WhatsApp linked-device socket, at one instance. While that slug is
disabled it renders no component. `bundle-messenger` is the same shape for the
same reason: it holds the one Messenger device connection (`messenger-tadas`,
`messenger-tadas-admin`), at one instance, and renders nothing while disabled.

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
- `src/config/reach.ts`, `src/http/reach.ts` — FLOW-THROUGH. A hosted server's
  `reaches:` grant, consented to by the target's `reachableFrom:`, lets it call
  that slug's named tools through core as itself, with pinned arguments checked
  on every call. No new credential: the caller proves its component with its
  derived internal token. One hop, checked-in config only.
- `src/ui/apps.ts` — the console as an MCP Apps host (SEP-1865). `/apps/{slug}`
  renders a server's `ui://` page in an opaque-origin frame and runs its tool
  calls as the signed-in human, through the playground's call path.
- `src/config/schema.ts` — the Zod config schema. It is the product's contract.
- `src/config/mcp-json.ts` — draft SEP-2633's `mcp.json` as an INPUT DIALECT, not
  a replacement. `mcpServers:` is desugared into `servers:` before the schema
  sees the document, so the `ServerConfig` union is unchanged and nothing
  downstream knows the dialect exists. It covers `kind: remote-http` and refuses
  everything else by name — the format is a CLIENT config and has no way to say
  deployment topology or a two-way entitlement. `HACKS.md` #93 is the reasoning.
- `src/config/strict.ts` — the deploy-time strict parse. Zod strips unknown keys
  and boot stays lenient on purpose (a rollback must not become an outage), so
  "did I typo a key" is answered here, by `scripts/check-config.ts`.
- `src/deploy/appspec.ts` — turns the config into a DigitalOcean App Platform spec.
  The server list decides the container topology.
- `servers/bundle/` — one image, 38 mounted MCP servers, one shared Chromium,
  assembled from TWENTY-NINE independently-built dependency trees.
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
- `servers/aws-device-farm/` — strad's own AWS Device Farm server: a REAL iPhone,
  driven live. Device Farm has two modes and only one of them is interactive —
  a remote access session publishes `endpoints.remoteDriverEndpoint`, a plain
  W3C WebDriver URL, and that URL IS the credential (it authorises by its own
  path), so it never leaves the server. NEITHER mode can hear audio: a device
  farm sells the device, not the output signal, so "is it playing" has to come
  from the app's own instrumentation, read off the screen or written to a
  customer-artifact path. No slug points at it in any environment yet —
  `HACKS.md` #103 and `docs/servers/aws-device-farm-setup`.
- `servers/telegram/` — strad's own Telegram server, behind `telegram-ro` and
  `telegram-rw`. MTProto with a USER session, because the Bot API cannot read the
  history of a group its account does not administer. The credential is a
  logged-in account; the library lives behind one function in `mtproto.ts`.
- `hostd/` — strad-hostd. ONE daemon on the owner's machine, SEVERAL logical MCP
  servers (`/shell/mcp`, `/browser/mcp`), because strad entitles a slug and not a
  tool, so "may run a shell" and "may drive my browser" are only separate grants
  if they are separate slugs. strad pools one upstream connection per slug and
  forwards a tool's name and arguments and nothing else, so consent cannot hang
  on "a connection": `request_control(purpose)` shows a dialog on the machine and
  returns a `grant_id` that every other tool requires. An unanswered dialog is a
  denial. The status page and kill switch are a second loopback listener the
  tunnel never routes. `HACKS.md` #101 is what it costs the ops-without-box-access
  rule.
  Its opt-in `custody` server captures a credential in the owner's browser into
  an in-memory HANDLE and deposits it through core's write-only, create-only
  `POST /_strad/deposit` — the value never reaches a model. While the vault
  holds anything, the daemon itself refuses shell, computer-use and browser
  reads, and filters every result for the held values (`HACKS.md` #141).
- `servers/liveoak/` — strad's own LiveOak Bank server, behind `liveoak`. Lists
  and fetches account statements so the password never reaches a model: the
  login is Cognito SRP through the portal's own client library, as a REMEMBERED
  DEVICE enrolled once by SMS code (`enrol_device`, `confirm_device`) and sealed
  in GCS, and the bank's Apiture API is sent GET and nothing else. The wire was
  read out of the portal's public JavaScript and has met only fakes in CI —
  `HACKS.md` #116.
- `servers/airtable/`, `servers/flightaware/`, `servers/digitalocean/` — strad's
  own servers over three HTTPS APIs, one static key each, mounted through one
  host loader. airtable keeps the npx package's sixteen tool and argument names;
  flightaware is read-only and BILLED per query, so every tool makes one request
  and returns a cursor; digitalocean is two slugs on one mount (`-ro` allows the
  nineteen reads) and redacts database passwords from every result. All three
  have met only fakes — `HACKS.md` #119.
- `servers/hetzner/` — strad's own Hetzner Cloud server, behind `hetzner-pulse-ro`
  and `hetzner-pulse-rw` on one mount and one `HCLOUD_TOKEN`. Hetzner publishes
  no MCP server, so it is written against the Cloud API. Its token's project
  holds one box, the CI runner that runs PulseMCP's production CI and tadasant's,
  so every tool that can take it down says so in its description, nothing here
  can lift delete or rebuild protection, and no result carries a root password.
  Met only fakes — `HACKS.md` #145.
- `servers/victorialogs/` — VictoriaMetrics' `mcp-victorialogs`, the second
  pinned Go binary in the bundle image, supervised over stdio the way grafana's
  is. Thirteen tools, all reads. Only the entrypoint is required, so a per-slug
  instance never inherits a sibling's bare token, and an unconfigured mount
  points its child at a `.invalid` host so the binary starts and lists.
  `HACKS.md` #153.
- `servers/glitchtip/` — strad's own GlitchTip server: seven reads (the
  organization, projects, teams, issues, one issue with its latest event,
  events) over the Sentry-compatible `/api/0/`. Two writes, `update_issue`
  (an issue's status) and `delete_project` (typed confirmation), are listed
  only when the slug's OWN `<SLUG>__GLITCHTIP_ALLOW_WRITE` is exactly `true`;
  a bare or sibling's switch opens nothing. One slug is one GlitchTip —
  `GLITCHTIP_BASE_URL` plus a token, both required for a per-slug instance. Written, not vendored: the AGPL-3.0
  `@karsten684/glitchtip-mcp-server` is not something strad links.
  `HACKS.md` #155.
- `servers/vendor-billing/` — strad's own billing reads for a cost-collection
  agent: OpenRouter credits and key usage, OpenAI organization costs by day and
  project, and Google Cloud month-to-date from a Cloud Billing BigQuery export.
  Every request is fixed: no tool takes a URL, a path, a query or a body. Each
  tool is configured on its own and answers `not configured` by variable name
  while the others work, and every credential is scrubbed from results and
  upstream errors. The export table is spliced into SQL only after strict
  identifier checks. `HACKS.md` #158.
- `servers/postgres/` — strad's own read-only Postgres server: list schemas,
  list tables, describe a table, and ONE read-only statement per call. One slug
  is one database — `DATABASE_URI`, `sslmode=require` or stricter, refused
  otherwise. Every call is its own `BEGIN TRANSACTION READ ONLY` … `ROLLBACK`
  with a `SET LOCAL` statement timeout (so it works behind a transaction-mode
  PgBouncer), multi-statement input is refused before and by the server, and
  rows come through a cursor capped at `max_rows`. The role is the boundary;
  these are on top of it. Its suite runs against a real Postgres in Docker.
  `HACKS.md` #161.
- `servers/image-tools/` — strad's own `image-diff` and `svg-tracer`, two
  mounts over one tree, replacing two npx packages that read the agent's disk.
  Inputs are URLs, fetched behind an SSRF guard at the connector (derived from
  `strad-fetch`'s); results come back inline. The pixel work runs in a worker
  thread per call, one call at a time per process, so a large diff neither
  stalls the bundle's event loop nor stacks memory beside Chromium.
- `servers/nutrition-facts/` — strad's own nutrition evidence server, behind
  `nutrition-facts`. USDA FoodData Central (Foundation, SR Legacy, FNDDS) and
  MenuStat are DOWNLOADED AT IMAGE BUILD TIME, each pinned by SHA-256 in
  `shared/src/data/sources.ts`, and baked as ~2 MB of gzipped JSON — nothing
  large in git, nothing fetched at boot. FatSecret is the one live source,
  cached for 23 hours under a 4,500-a-day budget, and every credential is
  optional: unconfigured, it answers locally and says FatSecret is
  `unavailable`. `HACKS.md` #122.
- `servers/ssh/` — strad's own SSH server: break-glass `ssh_execute` and SFTP
  on ONE host per slug, each a store-served instance at `/_instance/ssh/{slug}`
  reading the private key and a PINNED host key from its own namespace. No
  trust on first use: a slug with no pin never connects, and a host presenting
  any other key is refused before the key signs anything. An SSH slug cannot be
  created at runtime (`assertCreatable`), so its roles only ever come from
  checked-in config — and `ssh-tadasant-zimmer-prod` stays `[admin]`, because
  Zimmer sessions run on that host. `HACKS.md` #137.
- `servers/messenger/` — strad's own Facebook Messenger server, READ-ONLY,
  behind `messenger-tadas` (four reads) and `messenger-tadas-admin` (+ login and
  logout). Two halves: the TypeScript MCP tree, and `bridge/`, a Go program that
  runs mautrix-meta's network connector HEADLESS — bridgev2's Matrix side
  implemented against a SQLite table instead of a homeserver — on loopback. The
  bridge is AGPL-3.0 and a separate process, never linked; its whole state is one
  SQLite file, snapshotted sealed to the shared state bucket. The login is a
  human driving Meta's own app-login steps through the admin tools.
  `HACKS.md` #148.
- `servers/bill-spend/` — strad's own BILL Spend & Expense server, behind
  `bill-spend-ro` and `bill-spend-rw`. Re-codes card transactions to the right
  chart-of-accounts value, which BILL carries as CUSTOM-FIELD VALUES rather than
  as any `glAccount` field. The write endpoint can answer 200 SUCCESS and discard
  the update, so `set_transaction_coding` sends each known body shape and
  RE-READS the transaction to diff it — `wire.ts` is the ladder, `HACKS.md` #84
  is the reasoning. The token is unscoped ADMIN and BILL issues no narrower one,
  so the five-tool surface is the only boundary: nothing here can issue a card.

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
    SECRET in the app spec is BROADCAST to every supplementary container. A boot
    key needs no entry there. Adding it to `CORE_BOOT_ENV_KEYS` keeps it off
    third-party containers, because the set is derived. Adding it to
    `BUNDLE_BOOT_ENV_KEYS` is what hands it to them, under either provider.
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
