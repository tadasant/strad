---
name: sync-docs
title: Sync Docs
description: >
  Pre-PR step: right before opening a pull request, review strad's documentation
  against the branch diff and update whatever has gone stale — README.md,
  AGENTS.md / CLAUDE.md, docs/, HACKS.md, strad.config.example.yaml — so docs
  ship in the same PR and never drift from code. Default, always-on: run it as the
  final pre-PR routine after staging changes and before creating the PR. Scoped
  strictly to this repo's own docs.
user-invocable: true
---

# Sync Docs

Keep strad's documentation in sync with the code change about to be PR'd. Docs
drift the moment a behavior, flag, path, command, schema, count, or convention
changes without the surrounding prose being updated. This skill closes that gap
as the last step before a PR is opened.

> Vendored copy of the central Reframe `sync-docs` skill, adapted to strad's
> documentation surface. Improvements worth sharing belong upstream too.

Drift has three shapes here, and all three are in scope.

**Code-vs-docs drift** is a doc that no longer matches the code the diff changed.

**Intra-doc drift** is a doc that no longer matches _itself_: a fact stated in
several places (a lead-in paragraph _and_ the table beneath it) gets updated in
one place but not the others, so the doc contradicts its own body. This is easy
to miss because the stale text isn't a renamed symbol you can grep for — it's a
still-plausible sentence whose _claim_ is now wrong.

**Count drift** is strad's own recurring failure, and it deserves its own name.
The repo has simultaneously claimed 13, 14, 22, 23, 25, and 26 "servers" in
different files, because those words count different things. Before you write a
number, know which of these you mean and grep for the others:

| The number | What it counts                                                                       | Where it's decided                                    |
| ---------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| **3**      | App Platform components                                                              | `renderAppSpec` output; `test/staging-config.test.ts` |
| **27**     | dependency trees the bundle Dockerfile builds into `/app/trees`                      | `servers/bundle/Dockerfile`, `TreeName` in `trees.ts` |
| **36**     | MCP servers mounted inside the bundle image                                          | `buildMounts()` in `servers/bundle/host/src/index.ts` |
| **45**     | `supplementary-image` _entries_ in the staging config (capability variants included) | `infra/strad.staging.yaml`                            |
| **48**     | total server slugs in staging (45 + `echo` + `deepwiki` + `anki`)                    | `infra/strad.staging.yaml`                            |

A slug is not a mount, and a mount is not a component. Say which one you mean.

## Brand and voice — non-negotiable for any prose you write

Three references travel with this skill and govern every word you add or rewrite:

- **`references/brand`** (`references/BRAND.md`) — what strad is, and the opinions
  that follow. It decides framing: selection is not authorization; it fails closed;
  auth is the only gate because there is no perimeter; capability is policy, not
  physics, and we say so.
- **`references/brand-voice`** (`references/BRAND_VOICE.md`) — how strad sounds:
  plain, direct, specific, honest, lowercase `strad`, and free of AI-slop tells.
- **`references/anti-slop-rubric`** (`references/ANTI_SLOP_RUBRIC.md`) — the
  gradeable per-page checklist, including the count-drift item above.

Read them before touching user-facing prose. When you fix a stale fact, fix it _in
strad's voice_ — don't leave slop behind just because it was there before.

## strad's documentation surface

Cast a wide net, then narrow to what the diff actually affects:

| Surface                                      | What it covers                                                                                                                                                    |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `README.md`                                  | Project overview, the one rule, the server kinds, auth, secrets, develop.                                                                                         |
| `AGENTS.md` (`CLAUDE.md` is a symlink to it) | House rules for humans and coding agents: conventions, architecture orientation, the docs rule.                                                                   |
| **`docs/`**                                  | **The documentation site** (Astro Starlight → Cloudflare Pages). Pages live in `docs/src/content/docs/**`. This is the canonical prose.                           |
| `HACKS.md`                                   | The numbered catalog of deliberate shims. Every entry has a status and an undo. `docs/src/content/docs/limitations.md` is its public face and must agree with it. |
| `strad.config.example.yaml`                  | The annotated example config. It is documentation — the docs link to it as "the whole surface" — and it goes stale exactly like a page does.                      |
| Doc comments                                 | The header comments in `src/gateway/`, `src/deploy/appspec.ts`, `src/telemetry/` carry real explanation, and they carry counts. They rot too.                     |

### Which docs-site page does this diff touch?

Pages are under `docs/src/content/docs/`:

| Code area                                                                     | Page                                                                                    |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `src/gateway/router.ts`, `src/gateway/registry.ts`, `src/gateway/adapters/**` | `intro/architecture.md`                                                                 |
| `src/gateway/entitlements.ts` (roles, `?servers=`, the 424)                   | `intro/concepts.md`, `auth/overview.md`                                                 |
| `src/gateway/toolPolicy.ts` (the `tools:` allow/deny policy)                  | `intro/architecture.md#capability`, `servers/adding.md`, `intro/concepts.md#capability` |
| `src/config/schema.ts` (any field, default, or `superRefine` rule)            | `servers/interface.md` **and** `strad.config.example.yaml`                              |
| `src/config/load.ts` (`STRAD_CONFIG` / `STRAD_CONFIG_YAML[_GZ_B64]`)          | `servers/interface.md#where-the-config-comes-from`                                      |
| `src/auth/**` (`tokens.ts`, `google.ts`, `dev.ts`)                            | `auth/overview.md`                                                                      |
| `src/deploy/appspec.ts`, `scripts/render-spec.ts`                             | `operate/deploy-model.md`                                                               |
| `src/deploy/config-inline.ts` (what `STRAD_CONFIG_YAML` carries)              | `operate/deploy-model.md`, `servers/interface.md`                                       |
| `src/telemetry/**`, `telemetry/bundle/instrument.mjs`                         | `operate/telemetry.md`                                                                  |
| `servers/bundle/**` (a mount added or removed, the Chromium, the `op` CLI)    | `intro/architecture.md#sizing`, `operate/telemetry.md`, and every count                 |
| `infra/strad.staging.yaml`                                                    | `operate/operations.md#the-staging-config`, `servers/adding.md`                         |
| `.github/workflows/**`                                                        | `operate/operations.md`                                                                 |
| `gateway.publicUrl`, custom domains, Cloudflare                               | `operate/dns.md`                                                                        |
| a new `HACKS.md` entry, or one resolved                                       | `limitations.md`                                                                        |
| the pitch, the vocabulary, the one rule                                       | `intro/what-strad-is.md`, `index.mdx`, `README.md`                                      |

**Two hard sync requirements — treat these as non-negotiable:**

- **`docs/src/content/docs/limitations.md` must stay in sync with `HACKS.md`.**
  Every open hack has a limitations entry; every resolved hack is gone from the
  page. Nothing tests that they agree, so they drift silently — and a limitations
  page that under-reports is worse than no page.
- **`servers/interface.md` must stay in sync with `src/config/schema.ts`.** Every
  field, every default, and every `superRefine` rule that refuses to boot. The
  schema is the contract; the page is its only prose.

**New brittleness goes on the limitations page.** If the diff introduces (or
reveals) a hack, a hardcoded assumption, a known-broken edge, or a "we don't know
yet," add it to `HACKS.md` _and_ `docs/src/content/docs/limitations.md`, _and_ as
an inline `:::caution` on the relevant page. That page is a deliberate feature of
this site, not a confession — under-reporting it is the failure mode.

**Adding a page?** It must also go into the `sidebar` array in
`docs/astro.config.mjs`. Starlight does not auto-discover pages into the nav.

**Diagrams** are Mermaid fenced code blocks, rendered client-side. If you changed
a flow or a topology that a diagram depicts, change the diagram. They are meant to
be accurate to the code, not illustrative — a diagram showing components that no
longer exist is worse than no diagram.

## Scope constraint — this repo only

**Only review and update documentation inside this repository.** Do not touch:

- Other repositories or checkouts on the machine — notably the private
  `tadasant-internal` repo, which owns strad's production config and deploy.
- Vendored trees: `servers/*/shared/`, `servers/*/upstream/`,
  `images/bundle-google/vendor/`, `node_modules/`, build output.

If you notice docs in another repo have likely gone stale because of this change,
**report it to the user** so they can follow up — do not edit across repo
boundaries.

## Procedure

1. **Inspect the diff about to be PR'd.**

   ```bash
   git fetch origin --quiet
   git diff origin/main...HEAD
   ```

   Note renamed/removed files, changed identifiers, changed config keys or
   defaults, new or removed servers, changed error codes, and changed counts.

2. **Find the docs each change touches.** Grep for the old names, flags, paths, or
   values the diff changed — those hits are your candidate stale spots:

   ```bash
   git grep -n "<old-name-or-flag-or-path>" -- '*.md' '*.mdx' '*.yaml' 'docs/src/' 'src/'
   ```

   A pure internal change that no doc mentions usually needs **no** doc edit —
   don't manufacture work.

3. **Update the stale docs** so they match the code in the diff. Keep edits
   minimal: fix what's wrong, update examples and output that no longer match,
   don't rewrite for style. strad's own conventions apply to doc prose too — **no
   temporal comments** ("now", "used to be", "as of this PR"); write the docs as
   the canonical current state.

4. **Reconcile each doc against itself, and against the counts.** For every
   section you touched:
   - **Re-read the whole section top to bottom**, not just the line you edited.
     If the diff changed a headline claim (a default, a "how many"), update the
     summary _and_ every table, example, diagram, and callout that restates it.
   - **Run the count check.** If your diff changed anything about the bundle, the
     config, or the components, grep every number:
     ```bash
     git grep -nEi '\b(nine|sixteen|thirteen|fourteen|twenty-(two|three|four|five|six|seven)|9|13|14|16|22|23|24|25|26)\b' -- '*.md' '*.mdx' 'src/' 'servers/bundle/' 'infra/'
     ```
     and make each hit say which thing it counts.

5. **Validate** what you touched:
   - Any JSON you edited still parses:
     ```bash
     node -e "for (const f of ['skills/skills.json','references/references.json']) { JSON.parse(require('fs').readFileSync(f)); console.log(f, 'OK'); }"
     ```
   - The config example still validates:
     ```bash
     npm run config:check -- --config strad.config.example.yaml
     ```
     This is the gate CI runs over every config in this repo, and it is a strict
     parse — an unknown key is a hard error there, so a typo in the example is
     caught rather than stripped in silence.
   - Commands and code samples in the docs are real — they exist in `package.json`
     scripts, `scripts/`, or `.github/workflows/`.
   - Internal links and file paths still resolve.
   - If you touched `limitations.md`, confirm `HACKS.md` says the same thing.
   - **The site still builds:** `cd docs && npm run build`. This is what the
     `docs_site` CI job runs — bad frontmatter, a broken link, or a page missing
     from the sidebar fails the PR.

6. **Report** which docs you updated and why, or state explicitly that the diff
   required no doc changes. Note any out-of-scope docs (`tadasant-internal`) that
   look stale so the user can follow up separately.

## Composition

- Runs as the documentation step of the pre-PR routine, before the commit, so doc
  edits ship in the same PR.
- Complements `wait-for-ci` rather than replacing it — this skill fixes docs, that
  one verifies the build.
