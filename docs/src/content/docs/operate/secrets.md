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

| Identity     | Roles                                                               | Where it runs                                                                                                                                                                                                                              |
| ------------ | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **viewer**   | `parametermanager.parameterViewer`                                  | the `secrets` MCP server, on the bundle. In **prod** it **cannot** read a secret value — no `secretmanager.versions.access` — so no tool, bug or prompt injection can pull one through `/mcp`. Staging's is deliberately wider; see below. |
| **admin**    | `parametermanager.admin` + `secretmanager.admin`                    | the SSO-gated console, core only, via `consoleEnv:`. Reads and writes both kinds.                                                                                                                                                          |
| **resolver** | `parametermanager.parameterViewer` + `secretmanager.secretAccessor` | **the gateway container**, and `render-spec` at deploy time. Reads values to inject them; writes nothing.                                                                                                                                  |

Three things follow, and each is deliberate:

- It is **not** the viewer key. The viewer cannot read a secret value by
  construction, so a gateway holding it would resolve every `${NAME}` to nothing.
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

## The console's parameters page

`/ui/secrets` is the human half of the `secrets` server, and the only place a
value can be written or a secret value read back. Three things about how it
addresses the store are worth knowing before you use it.

### It manages every namespace, not the first one

`SECRETS_NAMESPACES` is a comma-separated **list**. The page has a namespace
picker; the listing, every action and the create form all follow it, and the
selection rides in `?ns=` so a view is linkable. An `ns` that is not one of the
configured namespaces is ignored rather than honoured — it is the prefix a new
parameter's path is built from, so it is an allow-list, not a hint.

The two shapes a namespace usually takes:

| Namespace                      | Holds                                                                          |
| ------------------------------ | ------------------------------------------------------------------------------ |
| `/strad/{env}/mcp/`            | Per-server parameters, under `{slug}/static/`.                                 |
| `/strad/{env}/gateway/static/` | The deployment's own `${NAME}` references — the token store, the OAuth secret. |

Staging manages both on the **console** side and only the first on the **MCP**
side. The console's admin credential can already reach the whole project, so
listing the gateway namespace widens what a human can address, not what the
credential may do — while the agent-facing viewer stays scoped to the servers'
namespace and cannot enumerate the deployment's own keys.

:::caution
Reveal follows the namespace list. Once the deployment's own `${NAME}` references
live under `/strad/{env}/gateway/static/` and that namespace is managed by the
console, a signed-in admin — or a hijacked console session — can reveal
`GOOGLE_CLIENT_SECRET` and the token store in a browser, not just the servers'
credentials. That is the same admin credential either way; what changes is the
reach of one session. Weigh it against
[shorter console sessions](https://github.com/tadasant/strad/issues/46) and
[single-use login tokens](https://github.com/tadasant/strad/issues/43) before
adding the gateway namespace to a production console.
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
parameters at all. The explanations themselves live in collapsed accordions, so
the page stays a working surface rather than a manual.

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
