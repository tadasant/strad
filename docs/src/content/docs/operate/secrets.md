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

| Identity     | Roles                                                                     | Where it runs                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------ | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **viewer**   | `parametermanager.parameterViewer`, and **never** `parameterAccessor`     | the `secrets` MCP server, on the bundle. In **prod** it **cannot** read a secret value: it holds neither read path — no `secretmanager.versions.access`, and no `parameterVersions.render` (which lives in `parameterAccessor`). Withholding the accessor role is what closes the render path, so granting it — however reasonable it looks — opens `/mcp` to prod secret values. Staging's is deliberately wider; see below. |
| **admin**    | `parametermanager.admin` + `secretmanager.admin`                          | the SSO-gated console, core only, via `consoleEnv:`. Reads and writes both kinds.                                                                                                                                                                                                                                                                                                                                             |
| **resolver** | `parametermanager.parameterViewer` + `parametermanager.parameterAccessor` | **the gateway container**, and `render-spec` at deploy time. Reads values to inject them; writes nothing.                                                                                                                                                                                                                                                                                                                     |

**The resolver's second role is `parameterAccessor`, not `secretAccessor`, and
the difference is the whole grant.** Resolution is `list` + `:render` per
parameter, and `parametermanager.parameterVersions.render` lives in
`roles/parametermanager.parameterAccessor` alone. `parameterViewer` is get/list
only, so the two together are the minimum: the viewer half enumerates the
namespace, the accessor half renders it. A resolver granted `parameterViewer` +
`secretmanager.secretAccessor` — two real roles that apply cleanly — lists the
namespace fine and cannot render a single value.

That is not a naming quibble. `:render` does **not** dereference as the caller;
it dereferences as the _parameter's own_ principal, so a Secret Manager grant on
the resolver's service account is not what opens the secret half, and no resolver
code path calls Secret Manager directly. [Secrets IAM](/operate/secrets-iam/#3-the-runtime-resolver-render-and-nothing-else)
carries the exact `gcloud` and an audit assertion.

Three things follow, and each is deliberate:

- It is **not** the viewer key. The viewer's grant stops at `parameterViewer`, so
  a gateway holding it would enumerate the namespace and render none of it —
  every `${NAME}` would resolve to nothing.
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

## What "immediately" means

Not instant. The numbers, and where they come from:

| Change                                       | Visible within                     | Why                                                                                                                             |
| -------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **Rotating** an existing secret              | `ttlSeconds` (default 60s)         | The namespace snapshot is refreshed on the first read after it goes stale.                                                      |
| **Adding** a name that was absent            | `negativeTtlSeconds` (default 10s) | A miss forces one out-of-band refresh, rate limited so an unknown `${REF}` on a hot path can't list the store once per request. |
| A change written through strad's own console | immediately                        | The writer calls `invalidate()` on the process that wrote it. Other components converge within the TTL.                         |

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

An agent using the `secrets` server can add and rotate values but **cannot read a
secret value back** — its credential lacks `secretmanager.versions.access`, so
Google refuses the only call that would return one. The gateway resolving that
same secret at runtime uses a different, value-reading credential. Two identities,
one store; see [which identity, exactly](#which-identity-exactly) above.

If the name is **new to the config**, the next deploy's preflight will check it
exists — see below. If you only changed a value, nothing else is needed.

With `provider: env`, add it to whatever seeds the deploy job's environment and
re-run the deploy.

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
failure rather than a missing name, because the two have unrelated fixes. See
[Secrets IAM](/operate/secrets-iam/#3-the-runtime-resolver-render-and-nothing-else).

## What still needs a redeploy

Two categories, both honestly bounded:

**A supplementary image's `env:`.** Those are environment variables on a
_container strad does not run_. No amount of runtime resolution inside the
gateway can change what is in another component's environment. Under the store
provider the values are still read **from the store** at render time — so a human
still manages them in exactly one place — but changing one needs a redeploy of
that component. A supplementary server that wants live rotation should read the
store itself, the way `servers/secrets` does.

**The boot keys.** `STRAD_TOKENS`, `STRAD_INTERNAL_TOKEN`,
`ADMIN_BOOTSTRAP_TOKEN`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and
`OTEL_EXPORTER_OTLP_HEADERS` are read once, at boot, by code with no provider in
scope. Under the store provider they are **hydrated from the store** at startup —
so they leave the app spec entirely — but a change takes effect on the next
restart, not within the TTL. That is not a shortcut: a token store and a shared
internal token are boot-scoped by nature, and claiming a rotation had landed
while half the fleet still trusted the old value would be worse than saying so.

Hydration is scoped by mode. A **bundle** component receives only
`STRAD_INTERNAL_TOKEN` and `OTEL_EXPORTER_OTLP_HEADERS` — it serves no console
and no public route, so it is handed neither the token store nor the OAuth
client.

A server's `consoleEnv:` is **never** hydrated. It carries the console's
store-_admin_ credential, which can write and reveal, and two things depend on it
staying out of the store: hydration runs in every process including bundles, and
filing an admin credential inside the store would let the weaker resolver
credential read the stronger one. It stays deploy-time baked, onto core alone.

## Migrating

`envFallback: true` (the default) puts the environment behind the store, so names
can move one at a time and no window exists where a name resolves from neither.
Set it `false` once the move is done to make "the store is the only source"
enforceable rather than merely intended.

A provider that **throws** does not fall through to the environment. An
unreachable store is not a store that lacks the name, and silently falling back
to a stale env var during an outage is how a rotated credential comes back from
the dead.

## The Secrets Console: every server, and whether its secrets are there

`/secrets` is the fourth console entry on the landing page, and it answers one
question: **is the strad side of this connector broken?**

The preflight above is honest but late. A `${NAME}` that is not seeded is
discoverable at exactly one moment — the deploy, when `render-spec` refuses to
render — and that is no help at all to someone standing in front of a connector
returning 401 and wondering whose fault it is. This page derives the same answer
from the running config, before and independently of any deploy.

It is a **roster**, not an error log. Every enabled server is on it, healthy ones
included, because "slack is fine, gmail is not" is the answer and a page listing
only failures cannot give it. Servers needing attention are expanded by default;
the rest are collapsed.

It is behind `requireConsoleUi`, the same gate as `/ui` and `/console`.

### The six states, and what each one claims

| State         | What it means                                                                                                      |
| ------------- | ------------------------------------------------------------------------------------------------------------------ |
| `ready`       | Every `${NAME}` this server references resolves to a value. **Not** a claim the credential works — see below.      |
| `no secrets`  | The server declares no references at all. Nothing to seed.                                                         |
| `not seeded`  | The backend answered, and there is no such secret. The one unambiguous state, and the one the fix guidance is for. |
| `check value` | A value exists and is evidently filler — an unexpanded `${...}`, a well-known "change-me" string, an empty string. |
| `unverified`  | The value is scoped to a component this process is not, so the console cannot confirm it either way.               |
| `unknown`     | The secret backend could not be consulted. Not absent.                                                             |

**Seeded is not working, and the page does not pretend otherwise.** strad never
calls an upstream to prove a credential is accepted, so the good state is `ready`
— "everything it needs is present" — and never "healthy". This is not a
hypothetical distinction: a `remote-http` server carrying a placeholder bearer
token boots fine, lists every other server fine, and 401s in isolation. A page
that reported presence alone would call that healthy. The `check value` state
exists for exactly that shape.

**Not visible here is not missing.** The console renders in `core`. A
supplementary image's `env:` is resolved at render time and injected onto its own
_bundle_ — `appspec.ts` never broadcasts it — so core cannot see it, and a
presence check that answered "not seeded" would paint a healthy fleet entirely
red. That case is `unverified`, and the row says which process would have to be
asked. Under `gcp-parameter-store` the picture is better rather than worse: the
store holds the deploy-time source of truth for a bundle-scoped ref too, so those
deployments get a real answer for every name — the same answer `render-spec`
would compute, one deploy earlier.

**A `consoleEnv:` value is found under its KEY, not its ref name.** A rendered
spec carries the resolved value filed under the key the container reads; the ref
NAME is deliberately never injected anywhere. Asking the provider for the ref name
and believing the `null` is the bug that once had `/ui/secrets` reporting a
missing admin credential in production with the value sitting in core's
environment one line below.

### The GSM / ENV source badge

Each secret carries a second badge naming **which store holds it** — provenance,
not status, which is the chip beside it.

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
the page lying in the one place everybody reads.

### A `params: true` server reads `unverified`, not `no secrets`

A server that opts into parameter resolution takes its credentials from
`/strad/<env>/mcp/<slug>/static/*` rather than from `${NAME}` references, and this
page does not read that namespace. Reporting `no secrets` would be a false green
on a server whose credentials are simply managed elsewhere — `remote-filesystem-tmp-public`
in `infra/strad.staging.yaml` is exactly that shape. It reads `unverified`, and the
row says which namespace was not checked.

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
would silently strip it from its siblings. So one `${NAME}` legitimately appears
on several entries, and the page deduplicates by name. One unseeded secret shared
by four variants is one problem, and listing it four times would bury the other
three.

Disabled servers contribute nothing — the gateway does not mount them and
`render-spec` skips them, so their secrets are required by nothing.

### The fix guidance is the point

A `not seeded` or `check value` row names, per route: the store, the GCP project,
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

`/` is deliberately narrow — no `env:` keys, no urls, no headers. This page's
entire job is to name the missing thing and where it goes, so it prints NAMES and
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

A second panel lists `STRAD_TOKENS`, `STRAD_INTERNAL_TOKEN` and the console OAuth
client. They belong here because the loop this page serves starts with "point a
client at a strad URL with the shared API token": without `STRAD_TOKENS` every
`/mcp` request is rejected and no amount of per-server green means anything. Only
those first two are required; the rest render as `not set · optional`, because a
deployment with no console genuinely has no `GOOGLE_CLIENT_SECRET` and flagging
that red would train people to ignore the panel.

## The console's parameters page

`/ui/secrets` is the human half of the `secrets` server, and the only place a
value can be written or a secret value read back. Three things about how it
addresses the store are worth knowing before you use it.

### The namespace field is free text

`SECRETS_NAMESPACES` is a comma-separated **list**, and it seeds the picker's
suggestions — it does not bound what a human may address. The namespace field is
free text with the configured list offered as `<datalist>` suggestions; the
listing, every action and the create form follow it, and the selection rides in
`?ns=` so a view is linkable.

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
field offers this gateway's own server slugs as suggestions and shows the full
path it is about to write as you type.

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

Staging enables it (nothing in `strad-secrets-staging` is sensitive, and
round-tripping a value is how the store gets tested). Prod does not.

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
- **Staging** — read + write on a project holding nothing sensitive. The same
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
