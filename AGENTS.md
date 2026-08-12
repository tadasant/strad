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

- Use a feature branch off the latest `main`; `main` is protected and lands via PR.
- `npm test` (Vitest) runs unit tests plus a real-MCP-client, in-process E2E.
- `npm run typecheck`, `npm run lint`, `npm run format:check` — all three gate CI.
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
- Three modules are VENDORED across an npm-tree boundary, and each has a sync
  script and a drift test. Edit the source, never the copy; run the sync and
  commit both halves.
  - `npm run presence:sync` re-vendors `src/secrets/presence.ts` into the bundle
    host tree. `test/presence.sync.test.ts` fails CI on drift, and a drifted copy
    means one component calls `change-me` filler and the other calls it a
    credential, on the same console row.
  - `npm run wire:sync` re-vendors `src/secrets/parameters/wire.ts` — the id
    fold, the value encoding, the envelope shape — into `servers/secrets`.
    `test/parameter-wire.sync.test.ts` fails CI on drift, and also fails if that
    tree grows a second implementation of a name the wire owns. Both halves
    address the SAME GCP parameter, and a drift here is the one failure in this
    subsystem that is silent (`HACKS.md` #33).
  - `npm run envprefix:sync` re-vendors `src/secrets/env-prefix.ts` — the slug →
    box-variable-name mangling — into the bundle host tree.
    `test/env-prefix.sync.test.ts` fails CI on drift. The renderer NAMES a
    variable and the host is the only thing that reads it back, so a drift puts
    the credential on the container under a name nothing looks for: green deploy,
    clean boot log, every call failing on a variable that is right there.
- `npm run dev` starts the gateway on `:8080` against `strad.config.yaml`.
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

| You changed…                                                                        | Update…                                                                 |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `src/gateway/router.ts`, `registry.ts`, `adapters/**`, `reachability.ts`            | `intro/architecture.md`                                                 |
| `src/gateway/entitlements.ts` (roles, `?servers=`, the 424)                         | `intro/concepts.md`, `auth/overview.md`                                 |
| `src/gateway/toolPolicy.ts` (the `tools:` allow/deny policy)                        | `intro/architecture.md`, `intro/concepts.md`, `servers/adding.md`       |
| `src/deploy/tool-surface.ts`, `scripts/check-tool-policy.ts` (the pre-deploy gate)  | `operate/deploy-model.md`, `operate/operations.md`                      |
| `src/config/schema.ts` — any field, default, or `superRefine` rule                  | `servers/interface.md` **and** `strad.config.example.yaml`              |
| `src/auth/**`                                                                       | `auth/overview.md`                                                      |
| `src/deploy/appspec.ts`, `scripts/render-spec.ts`                                   | `operate/deploy-model.md`                                               |
| `src/deploy/spec-file.ts`, `scripts/assert-spec.ts` — the pre-`doctl` spec check    | `operate/operations.md`, `limitations.md`                               |
| `src/secrets/presence.ts`, `src/gateway/bundle-presence.ts`, `src/http/presence.ts` | `operate/secrets.md`, `auth/overview.md`, `intro/architecture.md`       |
| `src/secrets/parameters/wire.ts` — the id fold, the value encoding, the envelope    | `operate/secrets.md`, `limitations.md`, and `npm run wire:sync`         |
| `src/ui/secret-status.ts` — a state, a label, or the source badge                   | `operate/secrets.md`, `limitations.md`                                  |
| `src/ui/pwa.ts`, `pwa-icons.ts` — the manifest, the worker, what it may cache       | `operate/console-pwa.md`, `auth/overview.md`                            |
| `servers/remote-filesystem/**` — a tool, the link model, the sensitivity model      | `servers/artifact-store.md`, `limitations.md`                           |
| `servers/telegram/**` — a tool, the credential model, the read/write split          | `servers/telegram.md`, `limitations.md`                                 |
| `scripts/check-config.ts`, `src/config/strict.ts` — the config CI gate              | `operate/deploy-model.md`, `servers/interface.md`                       |
| `scripts/check-store.ts`, `src/deploy/store-check.ts` — the pre-flip gate           | `operate/deploy-model.md`, `operate/secrets.md`                         |
| `src/deploy/preflight.ts` — what a deploy demands of the store                      | `operate/secrets.md`, `limitations.md`                                  |
| `src/deploy/server-namespaces.ts` — the per-server/gateway resolution order         | `operate/secrets.md`, `operate/deploy-model.md`, `servers/interface.md` |
| `src/secrets/env-prefix.ts` — the slug → box-variable-name mangling                 | `operate/secrets.md`, `limitations.md`, and `npm run envprefix:sync`    |
| `scripts/resolve-image-tag.ts`, `src/deploy/imageTag.ts`                            | `operate/operations.md`                                                 |
| `src/telemetry/**`, `telemetry/bundle/instrument.mjs`                               | `operate/telemetry.md`                                                  |
| `servers/bundle/**` — a mount added or removed, the Chromium, the `op` CLI          | `intro/architecture.md`, `operate/telemetry.md`, and every count        |
| `infra/strad.staging.yaml`                                                          | `operate/operations.md`, `servers/adding.md`                            |
| `.github/workflows/**`                                                              | `operate/operations.md`                                                 |
| custom domains, `gateway.publicUrl`                                                 | `operate/dns.md`                                                        |
| a `HACKS.md` entry added or resolved                                                | `limitations.md`                                                        |

Pages are `docs/src/content/docs/**`. A new page must also be added to the
`sidebar` array in `docs/astro.config.mjs` — Starlight does not auto-discover it.
`cd docs && npm run build` is what CI runs; the `docs_site` job fails the PR if it
breaks.

Diagrams are Mermaid fenced code blocks, rendered client-side. Keep them accurate
to the code rather than illustrative. A diagram showing components that no longer
exist is worse than no diagram.

**Counts are load-bearing, and this repo has gotten them wrong.** Five different
numbers describe "how many servers," and they count different things:

| The number | What it counts                                                                             |
| ---------- | ------------------------------------------------------------------------------------------ |
| **3**      | App Platform components: `core`, `bundle`, `bundle-zimmer-secrets`                         |
| **10**     | dependency trees the bundle Dockerfile builds into `/app/trees`                            |
| **17**     | MCP servers mounted inside the bundle image (`buildMounts()`)                              |
| **27**     | `supplementary-image` entries in `infra/strad.staging.yaml` (capability variants included) |
| **29**     | total server slugs in staging (27 + the `echo` builtin + the `deepwiki` remote-http)       |

A slug is not a mount, and a mount is not a component. Before you write a number,
grep for the others.

`bundle-zimmer-secrets` is the third component and the only one that is not there
for capability. Capability is config and config can be shared; a parameter STORE
is `process.env`, and a container has one of those — so a second `secrets` slug
fronting a second GCP project needs a second bundle. Two secrets slugs in ONE
bundle is the obvious way to write it and is silently wrong (one store answers
under two slugs); the `superRefine` in `src/config/schema.ts` rejects it. What that
rule cannot see is a `params: true` variable — its NAME comes from a path in the
store — so `renderAppSpec` throws separately when a resolved parameter would shadow
a sibling's variable on the same bundle.

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
  `callTool`, `close`) that all three server kinds reduce to.
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
- `servers/bundle/` — one image, 17 mounted MCP servers, one shared Chromium,
  assembled from TEN independently-built dependency trees.
- `servers/remote-filesystem/` — strad's own artifact store, behind the
  `remote-filesystem-tmp-public` slug. `is_sensitive` picks the KIND of link;
  GCS's 7-day V4 ceiling is why the 14-day default is signed with V2.
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
