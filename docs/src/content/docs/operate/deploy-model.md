---
title: Deploy model
description: The OSS repo mints the image; tadasant-internal consumes it plus its own internal config for prod. The zimmer→internal pattern, applied to strad.
sidebar:
  order: 1
---

strad's deploy model separates **the image** from **the deployment**. The
open-source repo builds and publishes the image; a private repo consumes that
image with its own config to run production. This is the same seam zimmer uses —
the OSS core is a reusable artifact, and the private repo is where the real
config, private servers, and prod secrets live.

## The two repos

```mermaid
flowchart LR
    subgraph oss["tadasant/strad (OSS)"]
        RI["release-image.yml"]
        DS["deploy-staging.yml"]
        IMG["ghcr.io/tadasant/strad:&lt;version&gt;"]
        STG["strad-staging<br/>(App Platform)"]
    end
    subgraph internal["tadasant/tadasant-internal (private)"]
        CFG["internal config<br/>+ private builtins baked in"]
        PROD["strad prod<br/>(App Platform)"]
    end
    RI -->|"build + push"| IMG
    RI -->|"deploy same image"| DS --> STG
    RI -->|"repository_dispatch<br/>strad-image-published {version, sha}"| CFG
    IMG -->|"pulled by"| PROD
    CFG --> PROD
```

- **`tadasant/strad` mints the image.** `release-image.yml` builds and pushes
  `ghcr.io/tadasant/strad:<version>` (plus `:latest` and `:sha-<sha>`) using the
  built-in `GITHUB_TOKEN` — which can write packages owned by the repo, so no
  personal access token is needed for the push.
- **`tadasant/strad` also runs staging** from the same image, via
  `deploy-staging.yml`, using `infra/strad.staging.yaml` as its config. Dispatched
  on a feature branch with `build: true`, the same workflow builds that branch's
  core and bundle images under branch-scoped tags and deploys them — without
  moving `:latest` or touching the handshake below. See [deploying a
  branch](/operate/operations/#deploying-a-branch-to-staging).
- **A deploy ships an immutable tag — for every component.** `:latest` exists for
  humans and for `docker pull`; no deploy uses it. `render-spec` refuses a core
  image on a mutable tag outright, and `deploy-staging.yml` resolves
  `sha-<commit>` for the core **and** the bundle. Under
  `--require-immutable-images` — which the staging deploy passes —
  `render-spec` refuses to emit a spec in which any component at all ships a tag
  that moves; without it, the same finding is a warning naming every component,
  because prod renders this script against a config in another repository whose
  `image:` lines it cannot change. See [which image a deploy
  ships](/operate/operations/#which-image-a-deploy-ships).
- **`tadasant-internal` runs prod.** It is a separate, deliberate act with a
  different DigitalOcean token. It consumes the published image plus its **own
  internal config** — private `builtin` modules baked into its own image, or a
  `STRAD_CONFIG` path — and deploys it.

## Versioning

The scheme is deterministic with no commit-back (borrowed from zimmer):

- A committed **`VERSION`** file is the manual floor (currently `0.1.0`).
- The **effective version** is `MAJOR.MINOR.(BASE_PATCH + commits_since_VERSION_last_changed)`.
- To bump minor or major, edit `VERSION` in a PR — which resets the patch offset.

## The cross-repo handshake

On each release, strad fires a cross-repo `repository_dispatch` to
`tadasant/tadasant-internal`:

- `event_type: strad-image-published`, payload `{ version, sha }`.
- Sent via `GH_STRAD_SYNC_TOKEN_TADASANT_INTERNAL`.

The dispatch is **best-effort**: a no-op if the token is unset, and a _warning_
(never a build failure) if it's rejected — "tadasant-internal polls on its own
schedule." The OSS release never depends on the private repo being reachable.

## The secrets seam

Secrets never live in the repo. Which of two paths they take is declared by the
config's `gateway.secrets.provider`, and a deployment gets exactly one — see
[Secrets](/operate/secrets/) for the full model.

### `provider: env` (the default)

```mermaid
flowchart LR
    GSM["GCP Secret Manager<br/>strad-&lt;env&gt;-*"] -->|"CI reads (masked)"| JOB["deploy job env"]
    JOB -->|"SECRET-typed env vars<br/>baked into the spec"| SPEC["App Platform spec<br/>(encrypted at rest by DO)"]
    SPEC -->|"process.env"| RUN["running container<br/>(no cloud credential)"]
```

`scripts/render-spec.ts` reads `strad-<env>-*` from GCP Secret Manager into the
job env, then renders SECRET-typed env vars into the App Platform spec (encrypted
at rest by DigitalOcean). The container just reads `process.env`. `render-spec`'s
output contains secret values, so it is written to a file and **never logged**.
`collectSecretRefs` walks the _parsed_ config (not raw YAML — so `${…}` inside a
comment isn't mistaken for a real ref), and an unresolved `${…}` fails the render
loudly instead of producing a crash-looping deploy.

The cost of this path is that **a rotated secret does nothing until the deploy
workflow runs again.** The value is in the spec, not read at boot.

### `provider: gcp-parameter-store`

```mermaid
flowchart LR
    SPEC["App Platform spec<br/>one gateway secret:<br/>the store credential"] -->|"process.env"| RUN["running container"]
    RUN -->|"reads at runtime, cached with a TTL"| PS["Parameter Manager + Secret Manager<br/>/strad/&lt;env&gt;/gateway/static/*"]
    PS -.->|"preflight: which names EXIST?<br/>(metadata only, no value read)"| CI["render-spec"]
```

The gateway needs one credential in the spec — the service-account key it uses to
reach the store. Everything the gateway resolves **on the request path** is read
while it runs, so adding or rotating one of those needs no deploy: a rotation
lands within `ttlSeconds` (default 60s), an addition within `negativeTtlSeconds`
(default 10s). A boot key is a restart and a baked one is a deploy — see
[what rotates live](/operate/secrets/#what-rotates-live-what-needs-a-restart-and-what-needs-a-redeploy).

`render-spec` still fails loudly on a reference to a secret that does not exist —
that is the **preflight**, which asks the store which names exist and never asks
for a value. What it does not do is bake one: a baked copy would silently outrank
a rotated stored one, and there would be two ways again.

#### The exception: a container that cannot ask the store

"Read it at runtime instead" is a claim about strad's own process. A
`supplementary-image` component does not run strad — it is a third-party image —
and it holds no store credential, because that key reaches the strad image and
stops there. It cannot hydrate, and giving it the credential would not change
that, since nothing inside it knows how to ask.

So `render-spec` reads that component's two boot keys — `STRAD_INTERNAL_TOKEN`
and `OTEL_EXPORTER_OTLP_HEADERS` — **from the store** and bakes them onto it,
exactly as it already does for that component's `env:`. One place to manage them;
a redeploy to change them.

Both of those keys fail silently when absent — a bundle with no OTLP header
exports into rejection about a minute after a green deploy, with `/healthz` still
200 — so the render checks rather than trusts, in three places that answer
different questions:

| Check                                        | Fails the deploy when                                                                                                                                                                                  |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `preflightSecrets()`                         | the store does not **hold** a required name. It reads metadata, so it cannot tell whether the value renders.                                                                                           |
| the required-boot-key check in `render-spec` | a required boot key resolves to **nothing** — the parameter is there, `list()` reports a value, and `:render` returns empty. Presence is not resolvability, and this is the half preflight cannot see. |
| `bootEnvGaps()`                              | a component in the **rendered spec** holds neither a boot key it needs nor the credential to fetch it. A cross-check on the renderer itself.                                                           |

The OTLP header is deliberately not on the **required** list: an ingestor that
needs no auth is ordinary, and demanding a header would fail correct deploys. (It
is still inside `bootEnvGaps` — once the store yields a value, a component
missing it is a gap like any other.) An **endpoint with no resolvable header** is
warned about by name instead, because it is
indistinguishable from a healthy deploy right up until the ingestor starts
refusing batches — and the staging deploy's [telemetry
report](/operate/operations/#deploy-stagingyml--put-it-on-app-platform) is what
catches it after the fact.

### Deploy-time parameter resolution

A `supplementary-image` server with `params: true` gets its managed parameters —
everything under `/strad/{env}/mcp/{slug}/static/*` in the [parameters
system](/intro/architecture/#the-secrets-and-parameters-system) — resolved **here,
at render time**, by the **resolver** credential (`STRAD_PARAMS_*`, read from the
deploy environment). `render-spec` calls `resolveServerParams()` for each such
server, pulling non-secret values from Parameter Manager and secret values from
Secret Manager, and hands the resulting map to `renderAppSpec` as `resolvedParams`.
Those values land as SECRET env vars **scoped onto that server's bundle** — the same
per-bundle scoping as a `${REF}` in `env:`, and the running container still holds no
cloud credential.

The resolver is **optional by design**: with no `STRAD_PARAMS_*` credential set,
`resolverFromEnv()` returns `null`, resolution is a no-op, and a `params: true`
server boots without those values rather than failing the render. That is what lets
the feature ship ahead of the resolver service account existing — see [Known
limitations](/limitations/).

Deploy-time is the _only_ option for a supplementary image, and the reason is
architectural rather than incidental: its `env:` is the environment of a container
the gateway process does not run, so nothing inside strad can change it while it
runs. A `bundle: core` builtin with `params: true` resolves **at runtime**, on
every call, and does pick up a change without a restart.

The render also bakes **`STRAD_PARAM_KEYS`** onto each component that carries a
`params: true` server: a `GENERAL` (not `SECRET`) env var holding
`{"<slug>": ["VARIABLE", ...]}`. Names only, and only when at least one server on
the component uses `params:` — so a spec diff moves only when the thing it
describes does.

It exists because a managed parameter is not a `${NAME}` reference: the config
does not name it, so the console running on `core` cannot enumerate it, and the
only honest thing it could say about a `params: true` server was that it had not
looked. With the names on the component, the component's
[presence route](/operate/secrets/#the-presence-route-a-component-answering-for-itself)
answers for each one — presence, never a value.

## App Platform: the hard-won facts

These are encoded in `src/deploy/appspec.ts` because each one cost something to
learn:

- **A spec update is a full REPLACE. An omitted field is a deletion.** This is the
  one that has actually bitten. Omitting `domains` from an update _detaches the
  custom domain_, and the app stays perfectly healthy on its `*.ondigitalocean.app`
  ingress while the real hostname fails its TLS handshake — so nothing alerts.
  `render-spec` now always emits `domains`, defaulting it from
  `gateway.publicUrl`. Verify the custom domain still serves after any deploy. See
  `HACKS.md` #18.
- **Internal components use `internal_ports: [8080]` and must _omit_
  `http_port`.** `http_port` is what mints a public route; setting both is a hard
  API rejection. Omitting it is what keeps a bundle private.
- **Don't hand-write `ingress` rules** — let App Platform derive them.
- **`${bundle.PRIVATE_URL}` → `http://bundle-name:8080`** — a private in-VPC hop
  (~3.9ms) with no public-edge hairpin (~58ms).
- **Deploy from a registry image, not a GitHub source.** App Platform's GitHub
  integration needs an interactive OAuth handshake and can't be driven headlessly
  from CI.
- The **core** service gets `STRAD_MODE=core`, `NODE_ENV=production`, the whole
  config inline as `STRAD_CONFIG_YAML`, a `/healthz` health check, and a
  `STRAD_BUNDLE_URL_<BUNDLE>` env per bundle (bound to `${bundle.PRIVATE_URL}`).
- **What a bundle component gets depends on whose image it runs.** A bundle of
  `builtin` servers runs the strad image and gets `STRAD_MODE=bundle` +
  `STRAD_BUNDLE=<name>`. A bundle of `supplementary-image` servers runs _their_
  image and gets only its own resolved `env:` map (SECRET-typed), any
  `params: true`-resolved parameters (also SECRET-typed), the identity vars
  (`STRAD_COMPONENT`, `STRAD_ENV`, `STRAD_VERSION`, and `STRAD_PUBLIC_URL` when
  `gateway.publicUrl` is set), and the telemetry vars — never `STRAD_MODE`, never
  the config, never the token secrets it has no use for. `STRAD_PUBLIC_URL` is
  non-secret and lets strad-owned bundle code mint absolute URLs for routes that
  core publicly proxies, such as remote-filesystem upload leases. A server's
  `consoleEnv:` is pointedly **not** here — it lands on core alone. The blast
  radius of a compromised upstream image is bounded by what it was handed.
  (`parseImage` handles GHCR / DOCR / Docker Hub refs.)

## What strad's own config renders to

`infra/strad.staging.yaml` produces exactly **three** components — `core`,
`bundle` and `bundle-zimmer-secrets` — and `test/staging-config.test.ts` asserts
that. `core` runs `ghcr.io/tadasant/strad` with `http_port: 8080`; `bundle` runs
`ghcr.io/tadasant/strad-bundle` at `apps-s-1vcpu-2gb` with `internal_ports: [8080]`
and no public route.

`bundle-zimmer-secrets` runs the **same** bundle image at the default
`apps-s-1vcpu-1gb`, and it is the one component that is not there for capability.
Capability is config, and config can be shared; a parameter STORE is
`process.env`, and a container has exactly one of those. It exists so a second
`secrets` slug can front a different project — see [Two stores, one
gateway](/operate/secrets/#two-stores-one-gateway) for the shape and its cost.

Prod, in `tadasant-internal`, is a separate config against the same renderer.

## Checking a config before it deploys

`scripts/check-config.ts` validates a config the way a deploy would, without
deploying and without a single credential. `render-spec` needs the real secrets
and emits the real spec; this needs neither, which is what makes it runnable on
every pull request — including from a repo that holds a config but no cloud
access.

```bash
node --experimental-transform-types scripts/check-config.ts \
  --config infra/strad.staging.yaml

# or, from this repo
npm run config:check -- --config infra/strad.staging.yaml
```

| Flag              | Meaning                                           |
| ----------------- | ------------------------------------------------- |
| `--config <path>` | **required** — the config file to check           |
| `--image <ref>`   | image ref to render with; only affects the render |
| `--app <name>`    | app name to render with; only affects the render  |

| Exit | Meaning                                                          |
| ---- | ---------------------------------------------------------------- |
| `0`  | the config is valid; the referenced secret **names** are printed |
| `1`  | at least one problem; every problem is printed and annotated     |
| `2`  | the script was called wrong (no `--config`, unreadable file)     |

Every problem is emitted as a `::error file=<config>::…` workflow command on
stderr, so GitHub annotates the run, and repeated as a list on stdout. Output is
names and structure only — it never prints a value, and the values it renders
with are dummies anyway.

Four checks, in order:

1. **Schema.** The same `parseConfig` the gateway boots with — types, required
   fields, and the cross-field rules (an undefined role, two images in one bundle,
   a `tools:` block with neither `allow` nor `deny`).
2. **Unknown keys.** The check the others cannot do. Zod strips what it does not
   recognise, so `consoleEnvs:` for `consoleEnv:` passes every other check here and
   does nothing at runtime. Detection is a **diff**, not a second strict schema: the
   document is parsed with the real schema, and any key present in the YAML but
   absent from the result was stripped. A copy of the schema would have to be edited
   in lockstep with the real one, and forgetting would mean a check that quietly
   stopped checking; a diff has nothing to drift from. Keys inside an open map are
   the declarer's vocabulary, not the schema's, and are never flagged: an `env:` /
   `consoleEnv:` variable name, a builtin's `options:`, and a **role name** under
   `roles:` (the role's own fields, like `servers:`, _are_ checked).
3. **Render.** The full `renderAppSpec`, with a dummy value substituted for every
   `${NAME}`. This is a smoke test — the dummy bag covers exactly the names the
   renderer resolves, so a schema-valid config essentially always renders — and it
   is what produces the real spec check 4 inspects.
4. **Console scope.** Two things a rendered spec can prove, and nothing else can:
   every key a server declares under `consoleEnv:` reaches the `core` component,
   and no two servers claim one key with different values. The first is the
   invariant `/ui` depends on. The second matters because `consoleEnvVars()` merges
   every enabled server's map into one flat environment, so a collision means the
   last declaration silently wins and the other server's console runs as the wrong
   identity.

A collision between two servers' `env:` maps in one bundle is **not** a check
here — it is rejected earlier, by the schema itself, along with the
`consoleEnv:`-against-`core` half. That is the better place for it: a schema rule
fires at boot as well as at this gate. See [`env:` may be bare; `consoleEnv:` must
be
slug-namespaced](/servers/interface/#env-may-be-bare-consoleenv-must-be-slug-namespaced).

What the schema still cannot see is a `params: true` server's variables. They land
on the same component environment, but their names come from **paths in the store**
and their values do not exist until render time — so neither the schema nor this
script, which has no store and no credentials, can know them. `renderAppSpec` can,
and it throws when one server's resolved parameter would shadow a sibling's
variable on the same bundle. That case matters more than an ordinary config
collision because it is reachable by a human action rather than a config edit: the
console creates parameters, and a parameter's path decides its variable name. A
server shadowing its **own** `env:` key with its own parameter stays legal — that
is the migration path off a hand-written `${REF}`.

**It is strict where the gateway is lenient, and that asymmetry is deliberate.**
`parseConfig` at boot keeps ignoring unknown keys, because the config and the image
version independently: an image that refused to boot on a key it had never heard of
would turn a rollback into an outage — the older image would reject the config the
newer one wrote. A false failure at boot costs an outage; a false pass at deploy
costs a silent misconfiguration. So the strictness lives at the gate.

## Checking the STORE before a config that reads from it deploys

`check-config` answers "is this config well-formed". It cannot answer "does the
store this config will read from actually hold what it names", because that needs
a credential and a live namespace. `scripts/check-store.ts` is the credentialed
counterpart — same flag shape, same annotations, same exit-code discipline — and
it is the check to run before flipping `gateway.secrets.provider` to
`gcp-parameter-store`.

```bash
npm run store:check -- --config infra/strad.staging.yaml            # the gate
npm run store:check -- --config infra/strad.staging.yaml --mode report  # daily
```

| Flag                 | Meaning                                                        |
| -------------------- | -------------------------------------------------------------- |
| `--config <path>`    | **required** — the config whose names are counted              |
| `--mode <m>`         | `require` (default, a finding is exit 1) or `report` (exit 0)  |
| `--namespace <path>` | override the namespace `gateway.env` implies; may not be empty |
| `--resolve`          | also render what was found; report by name what came back      |

| Exit | Meaning                                                                                       |
| ---- | --------------------------------------------------------------------------------------------- |
| `0`  | every expected name is present — or `--mode report` produced its report                       |
| `1`  | a finding: a missing name, a name that would not render, or a `consoleEnv:` name in the store |
| `2`  | called wrong: no `--config`, unreadable file, config does not parse                           |
| `3`  | the store could not be consulted at all — not a verdict about what is seeded                  |

It runs standalone from a checkout with the resolver key in the environment: no
image, no pin bump, no deploy. [Secrets](/operate/secrets/#is-the-namespace-complete-store-check)
documents what it counts and why that differs from the deploy preflight.

For the workflows that drive all of this, see [Operations &
CI](/operate/operations/). For the domain wiring, see [DNS &
domains](/operate/dns/).
