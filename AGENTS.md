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

| You changed…                                                               | Update…                                                           |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `src/gateway/router.ts`, `registry.ts`, `adapters/**`                      | `intro/architecture.md`                                           |
| `src/gateway/entitlements.ts` (roles, `?servers=`, the 424)                | `intro/concepts.md`, `auth/overview.md`                           |
| `src/gateway/toolPolicy.ts` (the `tools:` allow/deny policy)               | `intro/architecture.md`, `intro/concepts.md`, `servers/adding.md` |
| `src/config/schema.ts` — any field, default, or `superRefine` rule         | `servers/interface.md` **and** `strad.config.example.yaml`        |
| `src/auth/**`                                                              | `auth/overview.md`                                                |
| `src/deploy/appspec.ts`, `scripts/render-spec.ts`                          | `operate/deploy-model.md`                                         |
| `scripts/check-config.ts`, `src/config/strict.ts` — the config CI gate     | `operate/deploy-model.md`, `servers/interface.md`                 |
| `scripts/check-store.ts`, `src/deploy/store-check.ts` — the pre-flip gate  | `operate/deploy-model.md`, `operate/secrets.md`                   |
| `src/deploy/preflight.ts` — what a deploy demands of the store             | `operate/secrets.md`, `limitations.md`                            |
| `src/telemetry/**`, `telemetry/bundle/instrument.mjs`                      | `operate/telemetry.md`                                            |
| `servers/bundle/**` — a mount added or removed, the Chromium, the `op` CLI | `intro/architecture.md`, `operate/telemetry.md`, and every count  |
| `infra/strad.staging.yaml`                                                 | `operate/operations.md`, `servers/adding.md`                      |
| `.github/workflows/**`                                                     | `operate/operations.md`                                           |
| custom domains, `gateway.publicUrl`                                        | `operate/dns.md`                                                  |
| a `HACKS.md` entry added or resolved                                       | `limitations.md`                                                  |

Pages are `docs/src/content/docs/**`. A new page must also be added to the
`sidebar` array in `docs/astro.config.mjs` — Starlight does not auto-discover it.
`cd docs && npm run build` is what CI runs; the `docs_site` job fails the PR if it
breaks.

Diagrams are Mermaid fenced code blocks, rendered client-side. Keep them accurate
to the code rather than illustrative. A diagram showing components that no longer
exist is worse than no diagram.

**Counts are load-bearing, and this repo has gotten them wrong.** Four different
numbers describe "how many servers," and they count different things:

| The number | What it counts                                                                             |
| ---------- | ------------------------------------------------------------------------------------------ |
| **2**      | App Platform components: `core` and `bundle`                                               |
| **15**     | MCP servers mounted inside the bundle image (`buildMounts()`)                              |
| **24**     | `supplementary-image` entries in `infra/strad.staging.yaml` (capability variants included) |
| **26**     | total server slugs in staging (24 + the `echo` builtin + the `deepwiki` remote-http)       |

A slug is not a mount, and a mount is not a component. Before you write a number,
grep for the others.

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
- `src/config/schema.ts` — the Zod config schema. It is the product's contract.
- `src/config/strict.ts` — the deploy-time strict parse. Zod strips unknown keys
  and boot stays lenient on purpose (a rollback must not become an outage), so
  "did I typo a key" is answered here, by `scripts/check-config.ts`.
- `src/deploy/appspec.ts` — turns the config into a DigitalOcean App Platform spec.
  The server list decides the container topology.
- `servers/bundle/` — one image, 14 mounted MCP servers, one shared Chromium.

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
    Because that grant exists, `:render` is a live read path for secret values,
    and **the `secrets` MCP credential must NEVER hold
    `roles/parametermanager.parameterAccessor`** — withholding it is the only
    thing keeping `/mcp` away from a prod secret value. `parameterViewer` is the
    read role; `parameterAccessor` is the deref, despite the names.
    A credential that only strad's own process needs must be scoped to the strad
    image (`STRAD_IMAGE_ONLY_SECRET_KEYS` in `src/deploy/appspec.ts`): a plain
    SECRET in the app spec is BROADCAST to every supplementary container.
- Telemetry never records tool arguments or results. See `src/telemetry/redact.ts`;
  `test/telemetry.redaction.test.ts` is the canary that enforces it.

## Known sharp edge

**An App Platform spec update is a full replace: an omitted field is a deletion.**
This already detached a custom domain once and took `staging.strad.tadasant.com` to
a TLS handshake failure while the app stayed healthy on its `*.ondigitalocean.app`
ingress. `render-spec` now defaults `domains` from `gateway.publicUrl`, but verify
the custom domain still serves after any deploy. See `HACKS.md` #18.
