---
title: Secrets
description: Where a strad deployment's secrets live, when they are read, and how to add one.
---

strad has one secret model per deployment, declared in the config. There is no
second way **inside strad**, and that is the point: two ways to manage a
credential means one of them is out of date and nobody knows which.

That claim is scoped to what strad controls, deliberately. A deployment can still
have secrets living elsewhere — a password manager, the credential store of
whatever orchestrates the deploy — and strad cannot and does not try to speak for
those. What it can promise is that every `${NAME}` a strad config references
resolves through exactly one provider, and that the provider is named in the
config rather than inferred.

```yaml
gateway:
  secrets:
    provider: env # or: gcp-parameter-store
    ttlSeconds: 60
    negativeTtlSeconds: 10
    envFallback: true
```

## The two providers

### `env` — the default

`${NAME}` resolves from the process environment. Nothing cloud-specific is
involved: `npm run dev` works, CI works, and an OSS deployment can run strad with
no vendor account at all.

Secrets reach the container as deploy-time environment variables.
`scripts/render-spec.ts` emits a `SECRET`-typed env var for every `${NAME}` the
config references, DigitalOcean encrypts them at rest, and the running container
holds no cloud credential of any kind. A referenced-but-unset name fails the
render, loudly, before anything ships.

The trade is stated plainly: **a secret changed in this model does nothing until
the deploy workflow runs again.** The value is baked into the App Platform spec,
so not even a restart picks it up.

### `gcp-parameter-store` — runtime resolution

`${NAME}` resolves from the [parameters
system](/intro/architecture/#the-secrets-and-parameters-system) **while the
gateway is running**, under `/strad/{env}/gateway/static/`. Add or rotate a
secret in the store and it reaches production without a deploy.

The gateway itself needs exactly **one** credential in the app spec: the
service-account key it uses to reach the store. Every secret the gateway resolves
lives in the store instead. A key cannot be kept behind the lock it opens; that
is the whole exception, and it is the only one _for the gateway_.

Two other kinds of value are still baked, and neither is a gateway secret: a
`supplementary-image` server's `env:` (the environment of a container strad does
not run) and a server's `consoleEnv:` (the console's store-admin credential, which
must stay out of the store — see below). Both are read _from the store_ at render
time, so they are still managed in one place. A deployment with no supplementary
servers and no console really does ship one secret.

#### Which identity, exactly

This matters more than it looks, because three different service accounts touch
this store and handing the container the wrong one silently collapses the
[three-credential split](/auth/overview/#the-secrets-console-three-credentials).

The gateway gets the **resolver** identity, injected as
`STRAD_PARAMS_RESOLVER_SERVICE_ACCOUNT_KEY_JSON`:

| Identity     | Roles                                                                     | Where it runs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------ | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **viewer**   | `parametermanager.parameterViewer`, and **never** `parameterAccessor`     | the `secrets` MCP server, on the bundle. In **prod** it **cannot** read a secret value — it holds neither of the two read paths: no `secretmanager.versions.access`, and no `parameterVersions.render` (that lives in `parameterAccessor`). Withholding `parameterAccessor` is now the ONLY thing closing the render path, so granting it — however reasonable it looks — opens `/mcp` to prod secret values. See [Secrets IAM](/operate/secrets-iam/#never-grant-the-secrets-mcp-credential-parameteraccessor). Staging's is deliberately wider; see below. |
| **admin**    | `parametermanager.admin` + `secretmanager.admin`                          | the SSO-gated console, core only, via `consoleEnv:`. Reads and writes both kinds.                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **resolver** | `parametermanager.parameterViewer` + `parametermanager.parameterAccessor` | **the gateway container**, and `render-spec` at deploy time. Reads values to inject them; writes nothing. Both roles are required — `parameterViewer` does **not** include `parameterVersions.render`, so a resolver holding it alone lists every parameter and 403s on every value. See [Secrets IAM](/operate/secrets-iam/#the-resolvers-roles-parameterviewer-is-not-enough).                                                                                                                                                                             |

Three things follow, and each is deliberate:

- It is **not** the viewer key. The viewer cannot read a secret value by
  construction, so a gateway holding it would resolve every `${NAME}` to nothing.
  A resolver key that is missing `parameterAccessor` fails the same way for a
  different reason, and the two are easy to confuse: the viewer is denied the
  _value_, the under-granted resolver is denied the _deref_.
- It is **not** the admin key. The gateway never needs to write, and a
  write-capable credential in the process that answers `/mcp` would make the
  console's separate identity pointless.
- It is **not** CI's `GCP_SA_KEY`. That key exists to drive deploys and is far
  broader than reading one namespace; putting it in a long-lived container would
  trade a scoped read credential for a deploy credential. `GCP_SA_KEY` stays in
  GitHub Actions, and is itself tracked debt — see
  [Known limitations](/limitations/) #8, whose fix is Workload Identity
  Federation.

Read-only is real here, not just intended: the resolver has no write role, so a
compromised gateway cannot alter a secret, only read the ones its namespace
holds.

:::caution[A secret parameter must be granted access to its own secret]
`:render` dereferences a `__REF__` as **the parameter's own principal**, not as the
resolver. That principal needs `roles/secretmanager.secretAccessor` on the secret,
and `create()` grants it — but nothing repairs parameters written by an earlier
strad, which fail every resolution with `400 SECRET_REFERENCE_ERROR`.

The failure does not point at the cause: the resolver holds every permission the
error implicates, and a `testIamPermissions` probe of it comes back clean, so any
health indicator built on that probe stays green while nothing resolves. If you
have parameters that predate this, run the one-time backfill in
[Secrets IAM](/operate/secrets-iam/#backfilling-parameters-created-before-strad-made-this-grant)
— it is idempotent. See [Known limitations](/limitations/) #30.
:::

## What "immediately" means

Not instant. The numbers, and where they come from:

| Change                                         | Visible within                     | Why                                                                                                                                                                                                                                          |
| ---------------------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Rotating** a secret read on the request path | `ttlSeconds` (default 60s)         | The namespace snapshot is refreshed on the first read after it goes stale. Only request-path `${NAME}` references — a boot key or a baked one is [a restart or a deploy](#what-rotates-live-what-needs-a-restart-and-what-needs-a-redeploy). |
| **Adding** a name that was absent              | `negativeTtlSeconds` (default 10s) | A miss forces one out-of-band refresh, rate limited so an unknown `${REF}` on a hot path can't list the store once per request.                                                                                                              |
| A change written through strad's own console   | immediately                        | The writer calls `invalidate()` on the process that wrote it. Other components converge within the TTL.                                                                                                                                      |
| A brand-new **secret** parameter               | up to ~2 minutes                   | Its `__REF__` resolves only once the IAM binding `create()` made has propagated. Until then `:render` answers `400 SECRET_REFERENCE_ERROR` — see the caution above; that window looks exactly like the bug.                                  |

Two behaviours matter more than the numbers:

- **Concurrent reads are single-flighted.** A burst of requests on a cold cache
  opens one connection to the store, not one each.
- **A failed refresh serves the last known good values** and logs a warning
  naming the provider and the error — never a secret, never a value. A store
  outage must not take `/mcp` down. Only the very first read propagates its
  error, because there is nothing to serve and reporting a config problem for
  what is an outage would be a lie.
- **Every store read carries a 10s deadline**, and a failed refresh backs off for
  5s before being retried. Both exist for the same reason: a request that HANGS
  is worse than one that fails, because a never-settling read pins every
  concurrent reader behind the single-flight it shares — the availability claim
  above rests on reads eventually settling. The backoff keeps an outage from
  costing one failed call and one log line per request.

## Adding a secret

With `provider: gcp-parameter-store`:

1. Add it at `/strad/{env}/gateway/static/{NAME}` — through the SSO-gated
   `/ui/secrets` console, or through the `secrets` MCP server (a server slug on
   this gateway, reached at `/mcp?servers=secrets` like any other).
2. Reference it in the config as `${NAME}`.
3. That's it. No deploy.

An agent using the `secrets` server **in prod** can add and rotate values but
**cannot read a secret value back** — its credential holds neither of the two
calls that return one: `secretmanager.versions.access` and Parameter Manager's
`:render`. Both matter, because `:render` dereferences under the parameter's own
principal rather than the caller's, so withholding `versions.access` alone would
not shut it. **Staging's credential is deliberately wider** and can read values;
see [Secrets IAM](/operate/secrets-iam/). The gateway resolving that same secret at
runtime uses a different credential again. Two identities, one store; see
[which identity, exactly](#which-identity-exactly) above.

If the name is **new to the config**, the next deploy's preflight will check it
exists — see below. If you only changed a value, nothing else is needed.

With `provider: env`, add it to whatever seeds the deploy job's environment and
re-run the deploy.

### Secret or not: the one question to ask

Not "will this value store cleanly" — that used to matter and no longer does, see
[what a secret value looks like in the store](#what-a-secret-value-looks-like-in-the-store)
below. The only question is who may read it:

> Mark it **`secret: true`** unless you would be comfortable with the value
> appearing in an agent's transcript.

A **non-secret** value lives in the Parameter Manager envelope in the clear. Anything
holding `parametermanager.parameterViewer` reads it with an ordinary `get` — and that
includes the `secrets` MCP server the agents talk to. That is the point of a
non-secret parameter, not a leak: a bucket name, a region, a public client id.

A **secret** value lives in Secret Manager behind a `__REF__`, and reaching it takes
one of two calls prod's MCP credential does not hold. Cost: one extra API call per
read, and a value the console shows only behind an explicit reveal.

When in doubt, `secret: true`. Hash-only material — `STRAD_TOKENS` holds SHA-256
digests, not token plaintext — is still the gateway's auth table, so it is
`secret: true` too. The rule is about the blast radius of the value being read, not
about whether reading it is immediately catastrophic.

### What a secret value looks like in the store

A secret parameter's bytes are stored **base64url-encoded** in Secret Manager, and
its Parameter Manager envelope records `"encoding":"base64url"`:

```json
{
  "path": "/strad/prod/gateway/static/STRAD_TOKENS",
  "secret": true,
  "encoding": "base64url",
  "value": "__REF__(\"//secretmanager.googleapis.com/projects/…/versions/latest\")"
}
```

**Why.** The parameter is created with `parameter-format=JSON`, and `:render` does
not rebuild that JSON — it splices the secret's raw bytes into the payload **text**
where the `__REF__(…)` token sits, then rejects a result that looks structurally
damaged. A value containing `"`, `\`, `{`, `}` or a newline breaks the envelope and
comes back `400 INVALID_ARGUMENT … injection detected`. That is not an edge case: it
is every PEM key, every service-account JSON blob, and any value that is itself
JSON. Encoding makes the substituted text `[A-Za-z0-9_-]` and the problem goes away.

**What it means day to day:**

| If you…                                                       | Then…                                                                                                      |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| add or rotate through the console or the `secrets` MCP server | nothing. You type the real value; strad encodes and decodes it.                                            |
| read through `reveal`, the resolver, or MCP `readValue`       | nothing. All three decode.                                                                                 |
| read with `gcloud secrets versions access`                    | you get base64url. Pipe it through `base64 -d`.                                                            |
| seed a secret **by hand**, outside strad                      | encode it, and add `"encoding":"base64url"` to the envelope — or omit both, and strad reads it as literal. |
| have parameters written before this change                    | they carry no `encoding` field, which means the literal bytes. **No re-seeding.** See below.               |

**Parameters written before this change keep working.** An absent `encoding` field
means the literal bytes, so the names seeded into `strad-secrets-prod` earlier — none
of which contains a structural character, which is why they render at all — resolve
and reveal exactly as before. They are upgraded automatically the first time they are
rotated: the envelope gains its `encoding` before the new bytes are written, so a
rotate that half-fails reads as a loud error rather than as a plausible wrong value.

:::note[A structural value seeds and renders. This is measured, not argued]
`STRAD_TOKENS` — a JSON array of token records, packed with `"`, `[`, `]`, `{` and
`}` — is seeded as a secret parameter in `strad-secrets-staging` and renders. The
roster reports `render: 5 of 5 present name(s) resolved to a value`, and the
gateway proves it end to end: under `provider: gcp-parameter-store` the boot keys
are **not** baked into the app spec, so the only `STRAD_TOKENS` the staging
gateway has is the one it renders from the store — and `/mcp` authenticates
against it.

So no value is too quote-heavy to seed — base64url emits `[A-Za-z0-9_-]` and
nothing else, whatever went in — and the only limit on length is Secret Manager's
own, about 48 KiB of raw value once the encoding is paid for. What is still a
lower bound is `isRenderSafe`'s **boundary** — which raw characters Parameter
Manager would have refused — and nothing rests on it, because no encoded value
contains any of them. See [Known limitations](/limitations/) #33.
:::

**Non-secret values are left literal.** They carry no `__REF__`, so `:render`
substitutes nothing into them and there is nothing to survive; encoding them would
only make the console and the `secrets` MCP viewer show base64 to a human who asked
for a value.

**Three roles write and read these parameters, from two npm trees.** The console
admin and the runtime resolver live in `src/`; the `secrets` MCP server is its own
project with its own lockfile and cannot import from there. So the rules they must
agree on — the path-to-resource-id fold, the value encoding, the envelope shape,
and the predicate that recognises an un-dereferenced `__REF__` — live in one file,
`src/secrets/parameters/wire.ts`, which is vendored into
`servers/secrets/shared/src/parameter-wire.ts` by `npm run wire:sync`.
`test/parameter-wire.sync.test.ts` fails CI when the copy drifts, and when that
tree grows a second implementation of a name the shared file owns. It is checked
rather than asked-for-politely because a disagreement here is the one failure in
this subsystem that is silent: both halves keep answering, and one of them hands a
process bytes that are not the value. See [Known limitations](/limitations/) #33.

## Fail-loud, without reading a value

Baking every `${NAME}` into the spec has one genuinely good property: a reference
to a secret that does not exist fails the _deploy_. Runtime resolution would trade
that for a failure at 3am, on one request, to one server.

So the check is kept and the read is dropped. `render-spec` runs a **preflight**:
it asks the store which names exist and compares that with what the config
references. A missing name fails the deploy, by name.

It reads metadata only. `list()` returns paths, notes and a has-value flag; for a
secret parameter the underlying Parameter Manager payload holds a `__REF__`
pointer at Secret Manager, not the secret. Nothing in the preflight path calls
`:render` or `reveal`. A credential with no `secretmanager.versions.access`
passes it happily, which is the proof.

## Is the namespace complete? (store-check)

The preflight above is a **deploy gate**, and it is scoped like one. It checks the
names the gateway resolves at runtime — the config's `${NAME}` refs plus the core
boot keys. Every `${NAME}` the config references is always counted missing; of the
**boot keys**, only `STRAD_TOKENS` and `STRAD_INTERNAL_TOKEN` are. Both halves are
correct for a deploy and insufficient for the one moment that matters most:
switching a live deployment from `env` to `gcp-parameter-store`.

Two names make the difference concrete. `GOOGLE_CLIENT_ID` is **optional at
boot**, so a namespace without it preflights clean — and with
`auth.google.enabled: true` that is a front door that does not open. A
`supplementary-image` server's `env:` names are outside the preflight entirely
(they are baked at render time, and `render-spec` fails on a missing one) — but
under this provider they are read _from the store_, so they have to be seeded
before the flip, and the deploy is the first thing that looks.

`scripts/check-store.ts` counts **everything the deployment reads from the
store**:

| Counted                                                       | Why                                                      |
| ------------------------------------------------------------- | -------------------------------------------------------- |
| every `${NAME}` in a remote-http url/header or builtin option | resolved on the request path                             |
| **every** core boot key, optional-at-boot included            | hydrated at startup; optional there is not optional here |
| every `supplementary-image` `env:` name                       | read from the store at render time                       |
| _not_ a `consoleEnv:` name                                    | deploy-environment only — see below                      |

```bash
# The gate. Run it immediately before the flip; a missing name is exit 1.
npm run store:check -- --config infra/strad.staging.yaml

# The daily driver. Same enumeration, same names, exit 0 — a partially seeded
# namespace mid-migration is the expected state, not an error.
npm run store:check -- --config infra/strad.staging.yaml --mode report

# Presence is not resolvability. Also render what it found, and report by NAME
# which names came back with a value.
npm run store:check -- --config infra/strad.staging.yaml --resolve
```

| Flag                 | Meaning                                                                                                                    |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `--config <path>`    | **required** — the config whose names are counted                                                                          |
| `--mode require`     | the default: a finding is exit 1, annotated `::error`                                                                      |
| `--mode report`      | the same report, exit 0, annotated `::notice`                                                                              |
| `--namespace <path>` | override the namespace `gateway.env` implies. It cannot be empty — an empty prefix matches every parameter in the project. |
| `--resolve`          | also render what was found, and report by name what came back                                                              |

`--mode require` is the default deliberately: a checker that never fails unless
asked repeats the mistake it exists to fix. The mode changes the verdict and never
the facts, so a day's report and the final gate cannot disagree about what is
seeded.

**It never prints a value**, in any mode. The default check is `list()` —
metadata, and for a secret parameter a `__REF__` pointer rather than a secret.
`--resolve` does render values in order to prove the resolver can, and reports
names alone.

**A `consoleEnv:` name found in the store fails the gate.** It is the opposite of
a missing name and it is still a finding: nothing reads the copy there —
`render-spec` takes that value from the deploy environment — and the resolver
credential, the one the flip hands to the gateway process, can. That is the one
thing the [three-credential
split](/auth/overview/#the-secrets-console-three-credentials) exists to prevent,
so the fix named is "delete it from the store", not "seed it".

A name declared under **both** `env:` and `consoleEnv:` is not excluded. Some
component genuinely reads it from the store for the `env:` declaration, so it is
counted like any other expected name.

**It runs standalone from a checkout.** No image, no pin bump, no deploy: Node 22,
this repo, and the resolver's `STRAD_PARAMS_*` environment. That is the same
credential the container will hold, so a namespace this passes against is one that
credential can read.

**`--resolve` is how you find out the grant is wrong.** A resolver holding
`parametermanager.parameterViewer` and nothing else lists the namespace perfectly
and renders none of it; `:render` needs
`roles/parametermanager.parameterAccessor`. The check reports that as a render
failure rather than a missing name, because the two have unrelated fixes — and it
catches the other half too, the parameter's own principal lacking access to its
secret, which no probe of the resolver's service account can see. See [the
resolver's roles](/operate/secrets-iam/#the-resolvers-roles-parameterviewer-is-not-enough)
and [why a parameter must be granted access to its own
secret](/operate/secrets-iam/#why-a-parameter-must-be-granted-access-to-its-own-secret).

## What rotates live, what needs a restart, and what needs a redeploy

`ttlSeconds` governs one of these three, not all of them. Which one a name falls
into is decided by _who reads it_, and that is a property of the name rather than
of the store:

| The name                                                                                                                                         | Rotating it takes effect | Because                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A `${NAME}` in a `remote-http` server's `url`/`headers`, or a `builtin`'s `options`                                                              | within `ttlSeconds`      | Resolved on the **request path** by the runtime provider.                                                                                                  |
| A `params: true` server's managed parameters                                                                                                     | on the next **deploy**   | Resolved at render time onto that server's own component.                                                                                                  |
| The core boot keys — `STRAD_TOKENS`, `ADMIN_BOOTSTRAP_TOKEN`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `CONSOLE_SESSION_SECRET`, `SENTRY_DSN` | on the next **restart**  | Hydrated from the store once, at boot, by code with no provider in scope.                                                                                  |
| `STRAD_INTERNAL_TOKEN`, `OTEL_EXPORTER_OTLP_HEADERS`                                                                                             | on the next **deploy**   | Hydrated on core, **baked** on every supplementary component — see below. A restart moves only one side, and for the internal token both sides must agree. |
| A supplementary image's `env:`                                                                                                                   | on the next **deploy**   | Environment variables on a container strad does not run.                                                                                                   |
| A `consoleEnv:` name                                                                                                                             | on the next **deploy**   | Never in the store at all: it is the console's store-_admin_ credential, baked from the deploy environment onto core.                                      |

So `ttlSeconds` is the answer for **request-path references and nothing else**. A
deployment whose config has no request-path `${NAME}` and no `params: true`
server has no name that rotates live, however the TTL is set. That is a real
deployment shape, not a hypothetical: check your own config before promising
anyone a rotation that lands without a deploy.

### Why the bundle boot env is baked rather than hydrated

Hydration runs in strad's own process — the core, and a bundle component running
the strad image. A `supplementary-image` component is a **third-party container**.
It does not run strad, it deliberately holds no store credential (that key
reaches the strad image and stops there), and handing it one would not help,
because nothing inside it knows how to ask.

`SENTRY_DSN` is deliberately **not** one of those names. Only strad's own process
reports exceptions, so a third-party container has no use for one — and a DSN is a
write credential for the issue tracker, which is not a thing to broadcast to every
supplementary image. It reaches the core and any strad-image bundle and stops
there, like the store credential.

So the two names a bundle needs are read **from the store, by the renderer**, and
baked onto those components. A human still manages them in exactly one place; the
cost is that changing one is a deploy. Both fail _silently_ when absent, which is
why the renderer refuses to emit a spec where a component holds neither the value
nor the credential to fetch it:

- **`OTEL_EXPORTER_OTLP_HEADERS`** — the exporter still starts and still sends;
  the ingestor rejects every batch. The component answering every supplementary
  slug goes blind about a minute after a deploy that reported success, with
  `/healthz` still 200 and every slug still listed.
- **`STRAD_INTERNAL_TOKEN`** — the component's presence route fails closed, so
  the console stops being able to say what that container holds and reports that
  it refused the internal token.

A supplementary server that wants genuinely live rotation should read the store
itself, the way `servers/secrets` does.

A server's `consoleEnv:` is **never** hydrated. It carries the console's
store-_admin_ credential, which can write and reveal, and two things depend on it
staying out of the store: hydration runs in every process running the strad
image, bundles included, and filing an admin credential inside the store would
let the weaker resolver credential read the stronger one. It stays deploy-time
baked, onto core alone.

## Migrating

`envFallback: true` (the default) puts the environment behind the store, so names
can move one at a time and no window exists where a name resolves from neither.
Set it `false` once the move is done to make "the store is the only source"
enforceable rather than merely intended.

A provider that **throws** does not fall through to the environment. An
unreachable store is not a store that lacks the name, and silently falling back
to a stale env var during an outage is how a rotated credential comes back from
the dead.

### The flip is one step, and it has an order

Turning `gateway.secrets.provider` to `gcp-parameter-store` is not incremental,
whatever `envFallback` suggests. `render-spec` stops baking the boot keys the
moment the provider changes, and `preflightSecrets()` then requires
`STRAD_TOKENS` and `STRAD_INTERNAL_TOKEN` to be in the store. There is no
half-flipped state: a deployment either reads its token store from the store or
from the environment.

So the order matters, and each step gates the next:

1. **The resolver identity must exist.** `STRAD_PARAMS_PROJECT_ID` and
   `STRAD_PARAMS_RESOLVER_SERVICE_ACCOUNT_KEY_JSON` in the deploy environment,
   holding `parametermanager.parameterViewer` **and**
   `parametermanager.parameterAccessor`. Without it `render-spec` exits before it
   renders anything. It is not the viewer key, not the console admin key, and not
   CI's `GCP_SA_KEY` — see [Secrets IAM](/operate/secrets-iam/).
2. **Both images must carry the base64url encoding, before one name is seeded.**
   A secret parameter's value is spliced into the envelope's JSON text by
   `:render`, so it is stored encoded to survive that. The encoder lives in the
   core image (`create`, `rotate`, and the runtime decode) and in the bundle
   image (the `secrets` MCP write client), so a name seeded by an image that
   predates it is written as raw bytes and refuses to render. Publish and pin
   both, then seed — never the other way round. Rolling `core` back past that
   commit afterwards is a data hazard, not a rollback; see
   [limitation #33](/limitations/#33-secret-values-are-base64url-in-secret-manager-and-only-the-boundary-is-unverified).
3. **Seed, then verify by rendering.** `store:seed` (`scripts/seed-store.ts`) is
   the seeder — dry-run unless `--commit`, and it reads back every name it writes
   through `:render`. `store:check --mode require --resolve`
   is the gate: presence is not resolvability, and this is the only check that
   proves the resolver can actually read what was seeded. The staging deploy runs
   it in report mode on every run. It matters more than it sounds: by
   [limitation #36](/limitations/#36-one-un-renderable-parameter-makes-the-whole-gateway-namespace-resolve-to-nothing)
   a single parameter that cannot render takes the **whole namespace** with it,
   so a namespace that is complete but unrenderable is a gateway with no token
   store. `--only NAME` and `--exclude NAME` scope which names a run writes, for
   when one name has to be handled apart from the rest.
4. **Then flip.**

### Seed every name, including the structural ones

Seed the whole set. There is no shape of value that has to be held back, and
holding one back is the more dangerous choice. Under `provider:
gcp-parameter-store`, `render-spec` stops baking the boot keys into the app spec,
so the store is the only place a flipped deployment has them: a `STRAD_TOKENS`
left out is a gateway with no token store, `/mcp` rejecting every request. The
next deploy's `preflightSecrets` refuses a config whose required names are not in
the store, so this is normally caught before it ships — but the point of seeding
is to not need that catch, and the one name most worth being careful with is the
one it is most tempting to skip.

The question step 2 exists to settle is **which image wrote a value**, and it is
easy to misread as a question about the value:

| The question                                              | The answer                                                                                                                         |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Is this value too quote-heavy, too structural, too long?  | Not a question. `create()` and `rotate()` encode **every** `secret: true` value unconditionally — no shape branch, no size branch. |
| Was this value written by an image carrying the encoding? | The one that matters. Written before it, the bytes are raw; written after, they are base64url, and the envelope says which.        |

So the answer is version-dependent, and the version is the writer's, not the
value's:

- **A fresh seed** — `store:seed` on a pinned image — writes base64url for every
  secret name. Nothing is held back.
- **A name already in the store from before the encoding** carries no `encoding`
  field, which means the literal bytes, and keeps resolving. No re-seeding, and
  `--rotate` upgrades it in place if you want the encoding anyway.
- **The one broken case** is a structural value written by a pre-encoding image:
  raw bytes that `:render` refuses, forever, and it takes the whole namespace with
  it. That parameter cannot be repaired by seeding _around_ it — rotate it (which
  upgrades the envelope) or delete it.

Size is not the dimension either, though it is the one with an actual number. A
secret parameter's envelope holds a `__REF__` pointer, not the bytes, so the
parameter payload does not grow with the value at all; the bytes land in Secret
Manager, whose per-secret ceiling is 64 KiB. That ceiling applies to what is
stored, which is the **encoded** value, and base64url spends a third of it — so
the effective ceiling on a raw secret is about 48 KiB. An 802-byte value
base64urls to roughly 1,070 bytes, which is about 1.6% of it.

### Staging ran all four steps, and the property holds

Staging completed this order on 2026-07-31 and is the worked example. All four
steps passed, and the three properties the migration exists for were measured
against a running gateway rather than argued from the code:

- **A seeded `${NAME}` resolves from the store.** `echo`'s
  `greeting: "${STRAD_ENV}"` returned the store's value, not the container's.
- **An unseeded `${NAME}` still resolves from the environment.** Deleting the
  same name from the store returned the container's `STRAD_ENV` instead. This is
  the `envFallback` no-regression property, and it is observable only at runtime:
  `preflightSecrets()` runs in `render-spec`, so it constrains the next DEPLOY,
  not the running process.
- **A rotated value takes effect with no redeploy.** The name was rewritten in
  the store with a seed-only dispatch that renders and deploys nothing. Within
  `ttlSeconds` the running gateway returned the new value, from the same
  container — the pod's hostname was unchanged across the transition.

Read the third one for exactly what it says: `echo`'s `greeting: "${STRAD_ENV}"`
is a **request-path** reference, which is the one class that rotates within the
TTL. Staging can demonstrate it because staging's config contains such a
reference. A deployment whose only `${NAME}` sits on a server nothing reaches,
and which sets `params: true` on no server, has nothing that rotates live — see
[what rotates live](#what-rotates-live-what-needs-a-restart-and-what-needs-a-redeploy)
before promising otherwise.

`STRAD_TOKENS` was the name step 2 was written for, and it is proved live:
seeded as a secret parameter, it renders, and because a store-backed spec does
not bake the boot keys the staging gateway has no other copy to fall back on. A
`/mcp` request authenticating against that deployment is an end-to-end read of it.

## The console index: every server, and whether its secrets are there

`/ui` is the console, and it answers two questions about the same list: what is
each server scoped to, and **is the strad side of this connector broken?**

The two live on one page because nobody wants the second question in isolation: it
is asked _about_ a server, standing in front of the list of servers, so the answer
belongs on the entry rather than one navigation away. `/secrets` is a 302 to
`/ui` — the URL was published, and a page whose content moved teaches nobody
anything by 404ing.

The preflight above is honest but late. A `${NAME}` that is not seeded is
discoverable at exactly one moment — the deploy, when `render-spec` refuses to
render — and that is no help at all to someone standing in front of a connector
returning 401 and wondering whose fault it is. The index derives the same answer
from the running config, before and independently of any deploy.

It is a **roster**, not an error log. Every server is on it, healthy ones
included, because "slack is fine, gmail is not" is the answer and a page listing
only failures cannot give it.

It is behind `requireConsoleUi`, the same gate as `/console`.

### Two badges, and where they sit

Every enabled entry carries exactly one of two badges, in the slot the duplicated
slug used to occupy. Most servers declare no `title:`, so the heading _is_ the
slug and printing it again underneath was pure duplication; where a `title:` does
differ, the slug still renders beside the badge, because there it is information
rather than an echo.

| Badge   | What it claims                                                                                                                                   |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `READY` | Every `${NAME}` this server references was **observed** to resolve, or it references none at all. **Not** a claim the credential works.          |
| `ISSUE` | Anything else — including "could not be checked from here". Click it: it opens a popout naming the secret, the state, and the exact path to fix. |

`ISSUE` is a real `<button>` bound to a per-entry `<dialog>`, so it is
keyboard-reachable and announced as a control. Without JavaScript the buttons hide
and every panel renders inline at the foot of the page.

**"Could not be checked" is an `ISSUE`, deliberately.** A bundle-scoped value is
genuinely invisible to core and may well be fine — but `READY` has to mean
observed, or a total store outage renders a fleet of reassuring badges over an
unusable gateway. The popout carries the distinction; the badge does not pretend.

### Ordering

`READY` first, then `ISSUE`. Within each group, servers with a console view come
before servers without one, and config order breaks the remaining ties. Disabled
servers sort last and carry no badge at all — strad does not mount them, so they
need no secrets, and a green would be a claim about a server that answers nothing.

### Which servers have a console view

A server has a console view because its **config declares one**, not because of
its slug. Two shapes light up, and an entry that matches neither is listed without
a link:

| The server declares                                                | `/ui/<slug>` is                      |
| ------------------------------------------------------------------ | ------------------------------------ |
| `SECRETS_PROJECT_ID`                                               | the parameter store for that project |
| `GCS_BUCKET`, `GCS_SERVICE_ACCOUNT_KEY_JSON` or `GCS_CLIENT_EMAIL` | the object browser for that bucket   |

A server that somehow declared both gets the parameter store: the secrets check
runs first.

"Declares" means the same thing here as everywhere else the console reads config —
a `supplementary-image`'s `env:` and `consoleEnv:` together, a `builtin`'s
string-valued `options:`, and nothing at all for a `remote-http` server, which
holds no env for the console to read. A slug-namespaced name counts as its bare
form: `REMOTE_FILESYSTEM_TMP_PUBLIC_GCS_BUCKET` is a `GCS_BUCKET` for
`remote-filesystem-tmp-public`, so a server that has to move off a bare name to
stop colliding with a sibling is still recognised.

**A link is not a promise that the browser can list.** The declaration is what
lights the link; whether the page can do anything depends on the credential being
reachable from **core**, which a bundle-scoped `env:` or a `params: true`
injection is not — `remote-filesystem-tmp-public` on staging is exactly that, and
its page names the bucket and says the credentials are not available to the
console. That is the honest state, and it is the one that tells you to repeat the
key under `consoleEnv:`; hiding the entry instead only makes the page harder to
find.

The index link and the page are **one decision**: `serverLooksGcs` and
`serverLooksSecrets` in `src/ui/resolve.ts` are the same predicates
`resolveServerView` branches on. A detector that could read the config more
narrowly than its resolver is how you get a working page nothing links to, so
there is only the one reading.

The card's playground icon is the second instance of that shape, failing the
other way round: it is offered through `playgroundAccess()` in
`src/ui/playground.ts`, the same function the playground page decides on. A
detector WIDER than its resolver is how you get an icon that lands on a `424`.
See [the console playground](/auth/overview/#the-console-playground).

### The seven states behind the badges

The popout names which of these it is, because "not seeded", "cannot render" and
"could not be checked" want three different responses.

| State           | Badge   | What it means                                                                                                                       |
| --------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `ready`         | `READY` | Every `${NAME}` this server references was observed to resolve. **Not** a claim the credential works — see below.                   |
| `no secrets`    | `READY` | The server declares no references at all. Nothing to seed.                                                                          |
| `not seeded`    | `ISSUE` | The backend answered, and there is no such secret. The one unambiguous state, and the one the fix guidance is for.                  |
| `cannot render` | `ISSUE` | The parameter **exists** and its value cannot be produced. Neither absent nor healthy: creating it again fails with 409. Rotate it. |
| `check value`   | `ISSUE` | A value exists and is evidently filler — an unexpanded `${...}`, a well-known "change-me" string, an empty string.                  |
| `unverified`    | `ISSUE` | The component holding the value did not answer, so nothing established it either way. The row says which of the two reasons it is.  |
| `unknown`       | `ISSUE` | The secret backend could not be consulted. Not absent.                                                                              |

Both badges open. A `READY` entry carries a positive claim — which secret, from
which source, established by which process — and that is usually what somebody
came to the page for. Only a server with no secrets at all has nothing behind its
badge.

### `cannot render`: the parameter is there and the value will not come out

A secret parameter is a Parameter Manager entry whose payload holds a `__REF__`
pointer into Secret Manager, and `:render` is what dereferences it. Parameter
Manager refuses to dereference a payload whose rendered value carries a quote, a
brace or a newline — which is every structural credential, a service-account key
or a PEM — and answers `400 injection detected`.

That leaves a parameter that exists, is indexed, has a version, and hands nothing
back. Both of the obvious labels are lies about it: `not seeded` sends someone to
create a resource that is already there (and `create` on an existing path fails
with 409), and `unknown` says the store did not answer when it answered very
clearly. So it gets its own state, and the row says to **rotate** the value —
which rewrites the payload — rather than to seed one.

The console tells this apart from a store outage by asking the store two
questions rather than one: `list()` reads the index without dereferencing
anything, and `resolveDetailed()` renders each parameter under its own
`try`/`catch` so one refusal does not end the loop and cost the other names their
answer. `resolve()` keeps its fail-fast contract for the injection path, where a
child process started with half its environment is worse than one that does not
start, but its error names every hard render failure in that namespace.

This diagnosis runs wherever core holds a resolver credential, **including on a
`provider: env` deployment** — those still resolve `params: true` servers from
the store at deploy time, and a parameter that cannot render fails that deploy.
It turns "you find out during the deploy" into a row on a page.

**Seeded is not working, and the page does not pretend otherwise.** strad never
calls an upstream to prove a credential is accepted, so the good state is `ready`
— "everything it needs is present" — and never "healthy". This is not a
hypothetical distinction: a `remote-http` server carrying a placeholder bearer
token boots fine, lists every other server fine, and 401s in isolation. A page
that reported presence alone would call that healthy. The `check value` state
exists for exactly that shape.

**Not visible here is not missing — so the component is asked.** The console
renders in `core`. A supplementary image's `env:` is resolved at render time and
injected onto its own _bundle_ — `appspec.ts` never broadcasts it — so core
cannot see it, and a presence check that answered "not seeded" would paint a
healthy fleet entirely red. Unaided, the honest answer is therefore
"could not be checked", for most of the fleet, on every `provider: env`
deployment. That is honest and useless.

So the component answers for itself. See
[the presence route](#the-presence-route-a-component-answering-for-itself) below:
core asks each bundle what it actually holds, the bundle replies in presence and
never in values, and the row says `plumbed` with the source and the process that
established it. `unverified` survives for the cases where nothing could answer,
and the row says which: the component is down, or it runs an image that predates
the route.

**A `consoleEnv:` value is found under its KEY, not its ref name.** A rendered
spec carries the resolved value filed under the key the container reads; the ref
NAME is deliberately never injected anywhere. Asking the provider for the ref name
and believing the `null` is the bug that once had the console reporting a
missing admin credential in production with the value sitting in core's
environment one line below.

### The GSM / ENV source badge

Inside a popout, each secret carries a second badge naming **which store holds
it** — provenance, not status, which is the chip beside it.

| Badge | Meaning                                                                                                                                                                                                                                                                                                 |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GSM` | Google Secret Manager holds the bytes. Either read at runtime through the parameter store (whose secret parameters are `__REF__` pointers into Secret Manager), or seeded as `strad-<env>-<NAME>` and baked into the app spec at deploy time. On a `not seeded` row it names where the value has to go. |
| `ENV` | strad reads it straight out of its own process environment.                                                                                                                                                                                                                                             |

Every `consoleEnv:` name is `ENV` by design, on both providers: it is read from the
deploy environment only and never from the store, because it carries the console's
store-admin credential.

An `unknown` row carries no badge — a backend that could not be consulted cannot be
named as the source either.

### The headline is three-way, not two

The banner above the roster reads "N servers need attention" when something is
actionable, and "every server's secrets resolve" when nothing is. Neither is true
during an outage, so there is a third: **"nothing is known to be broken, but N
servers could not be checked."** `unknown` and `unverified` are not problems and
they are not health, and a green headline over a page of `unknown` rows would be
the page lying in the one place everybody reads. The presence route shrinks that
third case to near-nothing; it does not remove it, and it must not.

### A `params: true` server is graded on its managed parameters

A server that opts into parameter resolution takes its credentials from
`/strad/<env>/mcp/<slug>/static/*` rather than from `${NAME}` references. The
config therefore does not name them, and core cannot enumerate them — so the
unaided the console can only say `unverified`, "this page does not read that
namespace", about the servers least likely to be checked by anything else.
`remote-filesystem-tmp-public` in `infra/strad.staging.yaml` is exactly that
shape.

`render-spec` knows the names, because it resolved them. `appspec.ts` bakes them
onto the component as `STRAD_PARAM_KEYS`, a **GENERAL** (not `SECRET`) env var
holding `{"<slug>": ["VARIABLE", ...]}` — names only, and names are what the
console prints anyway. The component reports presence for each one on the
presence route, and the server is graded on them like anything else.

Where the component reports no parameters for a slug — an image without the
manifest, or a deploy that resolved none — the old `unverified` sentence stands,
because nothing established anything.

### The presence route: a component answering for itself

`POST /_strad/presence`, on every component that holds secrets in its own process
environment: the bundle host image, and the strad image in `STRAD_MODE=bundle`.
It is **not** mounted on core, which reads its own environment directly.

```
POST /_strad/presence            Authorization: Bearer $STRAD_INTERNAL_TOKEN
{ "keys": ["SLACK_BOT_TOKEN"] }

200 {
  "protocol": 1,
  "component": "bundle",
  "image": "0.4.2",
  "bootedAt": "2026-07-30T09:12:00.000Z",
  "observedAt": "2026-07-31T07:00:00.000Z",
  "keys": { "SLACK_BOT_TOKEN": { "presence": "present", "reason": null } },
  "paramKeys": { "remote-filesystem-tmp-public": ["…_GCS_PRIVATE_KEY"] }
}
```

**The five words.** `absent`, `empty`, `unexpanded`, `placeholder`, `present` —
and nothing else. No value, no length, no prefix, no hash, no character class.
The rule lives in `src/secrets/presence.ts`, which is vendored byte-identical
into `servers/bundle/host/src/presence.ts` (`npm run presence:sync`;
`test/presence.sync.test.ts` fails CI on drift) so that `change-me` reads as
filler whichever process holds it.

**It cannot be turned into an oracle.** The key roster core sends is derived from
the config core is running, plus whatever the component itself reports under
`STRAD_PARAM_KEYS`. There is no path from a request parameter — on `/ui` or on
`/api/secrets/readiness` — to a probed name, so no caller can ask strad whether a
name of its choosing exists. The defence is structural rather than a filter.

**Authentication is the existing `STRAD_INTERNAL_TOKEN`**, the same credential
core presents to proxy `/mcp` to that component. It is strictly stronger than
this surface, so mounting the route widens nothing. With no token configured the
route answers `503` rather than serving anonymously: on the private network is a
reachability property, not an authorization one.

**Freshness is part of the answer.** `bootedAt` and `image` are reported because
a container that predates the last render holds the previous deploy's
environment, and "the value was baked" and "the process has it" are different
claims. Each console row prints which process established it and when.

**An old image degrades to the old behaviour.** A component that answers `404`
is reported as `unsupported` — a pin bump, not an outage — and its rows fall back
to `unverified` with that sentence. This is what lets core deploy ahead of the
bundle image rather than in lockstep with it.

**The labels are not strad's own invention, and that is the point.** Zimmer's
Connectors page uses the same two, so the two screens can be read side by side and
compared, which is the whole loop this page exists to serve. Zimmer additionally
shows `Rails Credentials`; strad has no equivalent and never renders it. If
Zimmer's labels change, these change with them —
`test/ui.secret-status.test.ts` pins both spellings and their tooltips so a
divergence fails CI rather than quietly defeating the feature.

### One shared secret is one problem

Every capability variant of a server family declares its credentials identically,
on purpose: a component's environment is the union of its servers' `env:` maps, so
with the secret on only one variant, setting `enabled: false` on _that_ variant
would silently strip it from its siblings. So one `${NAME}` legitimately makes several entries
`ISSUE` at once, and each popout says which others share it. One unseeded secret
behind four badges is one problem, and listing it four times would bury the other
three.

Disabled servers contribute nothing — the gateway does not mount them and
`render-spec` skips them, so their secrets are required by nothing.

### The fix guidance is the point

A `not seeded` or `check value` popout names, per route: the store, the GCP project,
the exact resource name or canonical path, and a paste-ready `gcloud` command. The
route offered **first** is decided by what the deployment declares, because the two
are not interchangeable:

- `provider: env` → GCP Secret Manager, `strad-<env>-<NAME>`, then redeploy.
- `provider: gcp-parameter-store` → `/strad/<env>/gateway/static/<NAME>`, read at
  runtime, with a link straight to the parameters console that can write it.

A server with `params: true` also gets its own namespace listed —
`/strad/<env>/mcp/<slug>/static/<NAME>` — but **last, and labelled as not a fix for
that row**. A managed parameter does not resolve a `${NAME}` reference: the
renderer looks a referenced name up in the gateway namespace and then the deploy
environment, and fails before server-parameter resolution runs at all. Moving a
credential there is a config change (drop the `${NAME}` entry from that server's
`env:`), not a value you can add to unblock the current deploy.

The project is read from the deployment rather than assumed: the resolver's own
`STRAD_PARAMS_PROJECT_ID` if this process holds one, else the `secrets` server's
declared `SECRETS_PROJECT_ID`, else the `strad-secrets-<env>` convention. The
convention is last because a deployment that named its project something else
would otherwise be handed a command that fails; when it _is_ a guess, the page
says so.

A `consoleEnv:`-only name gets one route and it is not the store — that value is
read from the deploy environment only, because it carries the console's
store-admin credential and filing it inside the store would let the weaker
resolver credential read the stronger one.

### It prints names and paths, never values

`/` is deliberately narrow — no `env:` keys, no urls, no headers. Naming the
missing thing and where it goes is this page's entire job, so it prints NAMES and
PATHS. The line it holds instead is the one that matters: **no secret value is
ever rendered.** Not revealed, not excerpted, not length-hinted, not in a title
attribute. The placeholder check reads a value and returns a sentence about the
_shape_ it matched; nothing on the page is ever handed bytes.

### It degrades rather than hanging

Every name is read concurrently under its own deadline. A store that hangs costs
the page one timeout, not one per secret; a store that throws costs it one
`unknown` row. One server whose status cannot be determined does not break the
page or delay the others.

### The gateway's own boot keys

A panel below the grid lists `STRAD_TOKENS`, `STRAD_INTERNAL_TOKEN` and the
console OAuth client. They belong here because the loop this page serves starts
with "point a client at a strad URL with the shared API token": without
`STRAD_TOKENS` every `/mcp` request is rejected and no amount of per-server
`READY` means anything. Only
those first two are required; the rest render as `not set · optional`, because a
deployment with no console genuinely has no `GOOGLE_CLIENT_SECRET` and flagging
that red would train people to ignore the panel.

## `GET /api/secrets/readiness` — the same answer, for a machine

A platform app that points agents at strad needs to know whether Google Secret
Manager and Parameter Manager are wired up before it tells a human that a
connector is usable. The console answers that, and a console is not an answer a
program can hold: it would have to be scraped, and a scraper breaks the first time
the copy changes.

```bash
curl -H "Authorization: Bearer $STRAD_API_KEY" \
  https://staging.strad.tadasant.com/api/secrets/readiness
```

```json
{
  "ready": false,
  "env": "staging",
  "store": {
    "provider": "env",
    "wired": true,
    "project": "strad-secrets-staging",
    "projectGuessed": false,
    "gatewayNamespace": "/strad/staging/gateway/static/",
    "resolverCredential": false,
    "detail": "gateway.secrets.provider is \"env\": …"
  },
  "servers": {
    "total": 12,
    "ready": 8,
    "issues": 4,
    "states": {
      "ready": 5,
      "no-secrets": 3,
      "missing": 1,
      "unrenderable": 0,
      "placeholder": 1,
      "unverified": 2,
      "unknown": 0
    }
  },
  "issues": [
    {
      "slug": "granola",
      "state": "missing",
      "summary": "1 of 1 required secret not seeded: GRANOLA_TOKEN.",
      "secrets": [
        {
          "name": "GRANOLA_TOKEN",
          "state": "missing",
          "source": "GSM",
          "deliveries": ["gateway"],
          "path": "/strad/staging/gateway/static/GRANOLA_TOKEN",
          "secretManagerName": "strad-staging-GRANOLA_TOKEN",
          "detail": "Not seeded: ${GRANOLA_TOKEN} does not resolve …"
        }
      ]
    }
  ],
  "boot": [
    {
      "name": "STRAD_TOKENS",
      "state": "present",
      "required": true,
      "detail": "…"
    }
  ]
}
```

`state` on a server and on a secret takes any of the values in the table above,
`unrenderable` included. The field is additive: `ready` keeps its meaning (a
conservative presence claim, `false` whenever any server is not `ready` or
`no-secrets`), and a consumer keying on `ready`, `env`, `store`,
`servers.total`/`ready`/`issues`, `issues[].slug`/`summary` or `boot[]` needs no
change for it. A consumer that exhaustively switches on the state gets one more
arm.

Four shape decisions, each of which could have gone the other way:

**A static bearer token, never OAuth.** The consumer is a machine holding one
long-lived credential, and the Google-SSO path exists to put a human identity in
front of the console. So this authenticates exactly the way `/mcp` does — through
`authenticateMcp`, against the same `STRAD_TOKENS` roster, with the same
environment check, so a token minted for `prod` cannot read `staging`'s roster.
No new credential and nothing to rotate separately. Authorization is narrower than
`/mcp`'s rather than absent: the report is deployment-wide, so it takes a token
entitled to every enabled server and answers `403` to anything less. See
[Auth](/auth/overview/#apisecretsreadiness-is-not-a-console-surface).

**Always `200`, with the verdict in the body.** The tempting alternative is
503-when-not-ready. An App Platform ingress treats an upstream 5xx as its own
failure and can rewrite it, so the body a caller sees would be the ingress's — and
"not ready" is a correct, complete, successfully computed answer. Only auth
failures (`401`) and an unhandled crash (`500`) are non-200. `cache-control:
no-store`, because the answer changes the moment someone seeds a value.

**`ready` means observed.** It is `true` only when the store is wired, every
enabled server's secrets resolved, _and_ every required boot key is present. A
server that could not be checked makes it `false`, exactly as it makes the console
badge `ISSUE`. `servers.states` carries the full breakdown for a caller that wants
to treat `unverified` differently from `missing`.

**`store` is separate from `servers`.** "Can this gateway reach the store at all"
and "is every credential seeded" are different failures with different fixes — a
missing parameter is a value to create, a missing resolver credential is a deploy.
Under `provider: env`, `store.wired` is `true` by definition: there is no store to
wire, the deploy bakes values in, and reporting `false` would make every `env`
deployment permanently un-ready for something that is not a fault.

It is mounted on **core only**, alongside the console it mirrors: a `consoleEnv:`
value lands on core under its declared key and nowhere else, so a bundle asked the
same question would answer with strictly less information. And it is derived by
the same `readSecretStatus` call the console uses — a JSON field and a badge
computed by two paths would drift, and the endpoint's whole value is that it says
what the page says.

It prints names, paths and states. **It never prints a value**, for the same
reason the console does not; `test/readiness.test.ts` is the canary.

## The console's parameters page

`/ui/secrets` is the human half of the `secrets` server, and the only place a
value can be written or a secret value read back. Three things about how it
addresses the store are worth knowing before you use it.

### The namespace field is free text

`SECRETS_NAMESPACES` is a comma-separated **list**, and it seeds the picker's
suggestions — it does not bound what a human may address. The namespace field is
free text with the configured list offered as suggestions; the listing, every
action and the create form follow it, and the selection rides in `?ns=` so a view
is linkable.

The field is a **combobox**, not a `<select>`. Clicking or focusing it opens the
whole suggestion list, typing filters that list, and `ArrowUp`/`ArrowDown`,
`Enter` and `Escape` work as they do in a native control — `Escape` closes the
menu, and pressed again it puts back the namespace you arrived on. Anything you
type is still submittable, because the suggestions are not the fence. With
JavaScript off the same markup is an ordinary `<input list=…>` with a
`<datalist>`: free text and the browser's native typeahead.

**The fence is the GCP project, not the list.** A list checked in code sits over
the same credential the console already holds, so it would add no security —
only a redeploy between an operator and a namespace they can already reach.
What _is_ checked is shape: a namespace must be an absolute, lowercase,
slash-separated path prefix with no traversal, and never a bare `/` (which would
cover every parameter in the project).

The two directions of a bad value are handled differently on purpose. A **GET**
with a malformed `?ns=` falls back to the first configured namespace, so a stale
link still lands somewhere. A **POST** with one is an **error**, because a
submitted form is an intention and silently writing to a different namespace
would be the worst of both.

The two shapes a namespace usually takes:

| Namespace                      | Holds                                                                          |
| ------------------------------ | ------------------------------------------------------------------------------ |
| `/strad/{env}/mcp/`            | Per-server parameters, under `{slug}/static/`.                                 |
| `/strad/{env}/gateway/static/` | The deployment's own `${NAME}` references — the token store, the OAuth secret. |

Staging manages both on the **console** side and only the first on the **MCP**
side. The console's admin credential can already reach the whole project, so
listing the gateway namespace widens what is SUGGESTED, not what the credential
may do — and, unless `SECRETS_NAMESPACES_STRICT` is set, not what a session can
address either — while the agent-facing viewer stays scoped to the servers'
namespace and cannot enumerate the deployment's own keys.

:::caution[Reveal reaches any namespace this console can address]
Once the deployment's own `${NAME}` references live under
`/strad/{env}/gateway/static/`, a signed-in admin — **or a hijacked console
session** — can reveal `GOOGLE_CLIENT_SECRET` and the token store in a browser,
not just the servers' credentials. It is the same admin credential either way;
what changes is the reach of one session.

The namespace field is free text, so **not listing a namespace no longer keeps a
session away from it.** Two things do:

1. **`SECRETS_REVEAL_ENABLED`** — absent means off, which is prod's default. A
   session cannot reveal what the deployment does not offer, and after the
   [§1 downgrade](/operate/secrets-iam/) it cannot reveal at all.
2. **`SECRETS_NAMESPACES_STRICT=true`** on the server's `consoleEnv:` — restores
   `SECRETS_NAMESPACES` as a hard limit on the console rather than a set of
   suggestions. Set it where you want the deploy-time fence back.

Weigh both against [shorter console
sessions](https://github.com/tadasant/strad/issues/46) and [single-use login
tokens](https://github.com/tadasant/strad/issues/43).
:::

### A path is namespace + prefix + variable

The create form takes a **path prefix** — the segments between the namespace and
the variable name — separately from the variable:

```
/strad/staging/mcp/  remote-filesystem-tmp-public/static/  GCS_PRIVATE_KEY
└──── namespace ──┘  └──────────── path prefix ─────────┘  └── variable ──┘
```

The prefix is the routing key. `{slug}/static/` is what makes a parameter belong
to one MCP server; without it the console could only ever write
`{namespace}{VARIABLE}`, which is a well-formed path that no resolver reads. The
field is the same combobox as the namespace picker: it opens this gateway's own
server slugs on click — each labelled with whether that server sets
`params: true` — and shows the full path it is about to write as you type.

### The guide lives behind a Help control

The working surface stays a working surface. Everything explanatory — the routing
rules, worked examples, the secret/non-secret split, what a namespace is worth —
is in a `<dialog>` opened by **Help** in the top bar and closed by `Escape`, the
backdrop, or the button. No navigation, so the namespace you were browsing
survives.

The guide opens with **"This deployment, right now"**: the project, the namespace
being browsed, the suggested namespaces, whether anything is actually being
delivered, and the reveal posture — every line read from the running config and
the capability probe rather than from prose that could have gone stale.

The page itself keeps one line, and only when something is wrong: that storing a
parameter does not by itself send it anywhere.

### It says whether anything will actually read the path

**Storing a parameter does not deliver it.** A value under
`/strad/{env}/mcp/{slug}/static/` reaches that server only when the server's
config entry sets [`params: true`](/servers/interface/) _and_ the deployment holds
the resolver credential. Those are two independent conditions, and the second is
invisible in the config — `params: true` with no `STRAD_PARAMS_*` behind it is a
no-op that `render-spec` warns about and ships anyway. Otherwise the store is a
registry: the parameter is listed, rotatable and read by nothing.

Because that is silent when it goes wrong, the page computes the answer from the
running config rather than describing it in prose. Every row carries a chip —
`delivered · deploy`, `delivered · runtime`, `not wired`, `unrouted` — and a
banner above the listing counts how many servers on this gateway consume managed
parameters at all. The explanations live in the Help guide, so the page stays a working surface
rather than a manual.

`src/ui/param-routing.ts` is the single source of that judgement, and
`test/ui.secrets.routing.test.ts` pins both halves of it against their own
fixtures: neither a config without a `params: true` server nor a deployment
without the resolver credential may render a page claiming a value is delivered.

One subtlety the chips encode. Resolution lists everything under
`{slug}/static/` and keys the result on the path's **last** segment, so a deeper
path like `{slug}/static/extra/TOKEN` _is_ injected — as `TOKEN` — and collides
with any sibling ending in the same name. The row says so rather than calling the
path unrouted, because "nothing reads this" is the more dangerous thing to be
wrong about.

## Reveal, and why a flag is not a boundary

Displaying a stored secret value is the one console action with no undo, so it is
gated twice, by two independent things:

| Layer            | Where                                                            | Answers                                 |
| ---------------- | ---------------------------------------------------------------- | --------------------------------------- |
| **Feature flag** | `SECRETS_REVEAL_ENABLED` on the server's `consoleEnv:`           | what this deployment's console _offers_ |
| **IAM grant**    | `secretmanager.versions.access` on the console's service account | what that identity is _permitted_       |

**Both must say yes, and the narrower one wins.** The flag is convenience and
clarity; the grant is the boundary that cannot be bypassed. Neither substitutes
for the other — a flag alone is a UI decision wearing a security costume, and a
grant alone offers a button in an environment that decided not to have one.

Absent means off. A new environment cannot inherit reveal by forgetting to think
about it.

Staging enables it, because `strad-secrets-staging` is a separate project from the
one holding strad's own `strad-<env>-*` secrets and round-tripping a value is how
the store gets tested. What a reveal there returns is a real per-server
credential; the bound is the project, not the contents. Prod does not.

### When they disagree

Fail closed, and say _which way_, because the two directions need opposite fixes:

- **flag on, credential cannot** — the control is withheld rather than offered and
  403ed. The fix is an IAM grant.
- **flag off, credential can** — the control is withheld, and the page reports
  **drift**: the UI decision is holding and the boundary is not. The fix is to
  narrow the service account.

A probe that cannot run at all (Cloud Resource Manager not enabled, say) is
reported as _unverified_ rather than as a denial, because "I could not find out"
and "you are not allowed" send a reader to different pages.

The hidden button is presentation. `POST /ui/:server/reveal` re-checks the same
posture and refuses with a 403, so a hand-crafted form post gets nowhere.

## The MCP tool surface is probed, not configured

`servers/secrets` asks Google what its own credential may do
(`projects:testIamPermissions`) and derives its tool list from the answer.

- **Prod** — a Parameter Manager viewer. Four read-only tools, and `/mcp` cannot
  read a secret value.
- **Staging** — read + write on a project separate from the one holding strad's
  own `strad-<env>-*` secrets. That project holds per-server credentials, so
  `get_secret_value` there returns real secrets; the bound is separation, not
  harmlessness (issue #59). The same
  image additionally offers `create_parameter`, `set_parameter_value`,
  `set_parameter_note`, `delete_parameter` and `get_secret_value`.

A flag was the alternative and is worse: one claiming write access on a read-only
key produces a server that advertises a tool and fails every call to it with an
opaque 403, and one claiming read-only on a key that can read secret values
produces a property that exists in prose and not in IAM. The probe cannot drift,
because what it reports is what Google will enforce.

Every handler re-checks the capability rather than trusting that it was listed — a
`tools/list` a client cached a minute ago is not an authorization. A probe that
cannot run yields the read-only surface; nothing is opened by a failure.

The exact grants, per environment, with audit assertions, are in
[`servers/secrets/README.md`](https://github.com/tadasant/strad/blob/main/servers/secrets/README.md).

## Two stores, one gateway

The `secrets` server is store-**agnostic**: it takes a `SECRETS_PROJECT_ID`, a
`SECRETS_NAMESPACES` prefix list and a credential. So a second slug pointed at a
second project gets the same console, the same MCP tools, the same viewer/admin
split and the same reveal flag — instead of a second parameters console written
somewhere else. Staging does this for Zimmer's own store, as `zimmer-secrets`.

**One bundle per store.** That is the whole mechanism, and the second slug is
identical to the first except for its `bundle:` line and its own project,
namespaces and credentials:

```yaml
bundles:
  - name: bundle
  - name: bundle-zimmer-secrets

servers:
  - slug: secrets
    bundle: bundle
    path: /secrets
    env:
      SECRETS_PROJECT_ID: "strad-secrets-staging"
      SECRETS_SERVICE_ACCOUNT_KEY_JSON: "${SECRETS_VIEWER_KEY_JSON}"
    consoleEnv:
      SECRETS_PROJECT_ID: "strad-secrets-staging"
      SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON: "${SECRETS_ADMIN_KEY_JSON}"

  # Same image, same path, DIFFERENT bundle.
  - slug: zimmer-secrets
    bundle: bundle-zimmer-secrets
    path: /secrets
    env:
      SECRETS_PROJECT_ID: "zimmer-secrets-staging"
      SECRETS_SERVICE_ACCOUNT_KEY_JSON: "${ZIMMER_SECRETS_VIEWER_KEY_JSON}"
    consoleEnv:
      # Only what the console alone needs — see the fallback note below.
      ZIMMER_SECRETS_SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON: "${ZIMMER_SECRETS_ADMIN_KEY_JSON}"
```

### Why one bundle cannot hold both

A bundle is a component, which is a container, which is one `process.env`. The
secrets server reads `SECRETS_PROJECT_ID` from it and the bundle host calls
`loadConfig()` with no argument, so a container fronts exactly **one** store —
and `renderAppSpec` merges a bundle's servers' `env:` maps last-wins, with no
error. Two secrets slugs in one bundle therefore answer from one store under two
slugs. That is a wrong answer, not a failure, which is why
`scripts/check-config.ts` now
[rejects it](/operate/deploy-model/#checking-a-config-before-it-deploys) (check 5).

The gateway resolves each slug's private URL **per bundle** and only then appends
`path:`, so the same `/secrets` in two bundles is two containers. Two slugs on one
path in _one_ bundle is the capability-variant pattern, and stays legal.

### `env:` is bare, `consoleEnv:` is slug-namespaced

This asymmetry is the other thing to get right, and getting it backwards is
silent.

- **`env:`** lands on that slug's own container, which holds nothing else — so it
  uses the bare `SECRETS_*` names the server actually reads.
- **`consoleEnv:`** is merged into the **one** `core` component along with every
  other server's, so bare names there would collide. `/ui/secrets` would render
  strad's project while holding the **other** store's admin credential — a page
  that looks entirely correct and acts on the wrong project. The console maps
  `ZIMMER_SECRETS_SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON` back down to
  `SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON` for that slug alone
  (`withNamespacedFallback`).

**The mapping is a fallback, not an override** (`out[bare] ??= value`), and
`env:` and `consoleEnv:` are merged before it runs. So a namespaced key whose
bare form the slug **also** declares under `env:` is inert — the `env:` value
wins and the namespaced one does nothing while looking like it does something.
Declare under `consoleEnv:` only what the console alone needs: the admin
credential, the reveal flag, `SECRETS_NAMESPACES_STRICT`. The project and
namespace come from `env:` and the console reads them there.

One consequence worth knowing before you hit it: a second store's console
therefore **cannot** be given a wider namespace list than its MCP half, the way
`secrets` does (one namespace under `env:`, two under `consoleEnv:`). That works
for the first slug precisely because its key is bare in both maps — and bare is
what a second slug may not use. Making the namespaced form an override would fix
it, and would also change the `gcs` pair, so it is not a local change.

### The credential, which is IAM and not markup

The MCP-facing (`env:`) credential must be a **viewer** on the second project:
`parametermanager.parameterViewer` and nothing that renders. A resolver identity
is the tempting reuse and is the wrong one — it holds
`parametermanager.parameterAccessor`, which carries `parameterVersions.render`,
and `:render` dereferences a secret parameter as the _parameter's own_ principal,
which was granted `secretAccessor` at create time. It is a live read path to a
secret value. Because the tool surface is
[probed rather than configured](#the-mcp-tool-surface-is-probed-not-configured), a
slug handed that key does not merely look wrong — it lists `get_secret_value` and
the call succeeds.

### The cost

One more billed App Platform component, at the default `apps-s-1vcpu-1gb`. It
runs the full bundle image (every upstream registers at boot, ~200MB of Node)
even though it is only ever routed `/secrets` and never launches Chromium.

Whether that is worth it for a store a human touches a few times a month is a
budget call. The alternatives are worse rather than cheaper: a parallel console
elsewhere duplicates the viewer/admin split, the reveal-flag-versus-IAM logic, the
delivery-state classifier and the capability probe; and folding the second store
into the first project under its own namespace needs no component at all but
collapses the boundary the split credentials exist to draw — `parameters.list` is
authorized on the **project**, and `SECRETS_NAMESPACES` is a code-level guard that
scopes answers, not permissions.

## The seam

```
src/secrets/provider/
  types.ts    SecretProvider — get(name) -> value | null, invalidate()
  env.ts      EnvSecretProvider    — process.env; the vendor-neutral default
  store.ts    StoreSecretProvider  — a parameter store, cached with the TTLs above
  chain.ts    ChainSecretProvider  — store first, environment behind it
  hydrate.ts  boot-key hydration, scoped by core/bundle
  resolve.ts  ${NAME} resolution against a provider
```

`StoreSecretProvider` is built on `ParameterResolver`, which is store-agnostic —
it speaks paths and values, not projects or secret ids. A second backend (AWS
SSM + Secrets Manager, a self-hosted store) implements that interface and nothing
above it changes.

Adapters take a **thunk**, not a value. `HttpServerAdapter` resolves its URL and
headers on every operation, fingerprints the result, and rebuilds its MCP
connection when the fingerprint changes — an established transport still carries
the old `Authorization` header, so keeping it would make a rotation invisible
until the next restart. `BuiltinServerAdapter` resolves its options per call.
Resolving into constructor arguments at boot is what makes "rotate a
credential" mean "redeploy the gateway".

## Never log a value

- No secret value is ever written to a log, an error message, or a span
  attribute.
- `SecretNotFoundError` carries the reference **name** and nothing else.
- The endpoint fingerprint is a SHA-256 digest, never logged.
- Boot-time hydration logs the **names** it filled in, never name–value pairs.
- `render-spec`'s output contains secret values — every `${NAME}` under the `env`
  provider, and the baked supplementary/console values under either. It is
  written to a file and never echoed into a build log.
- A multi-line secret must have **every line** masked in GitHub Actions —
  `::add-mask::` matches within a single line only. A service-account key has
  leaked into a public Actions log this way before.

`test/secrets.provider.test.ts` carries the canary that enforces the first four.
