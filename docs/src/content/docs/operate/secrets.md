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
    ttlSeconds: 86400
    negativeTtlSeconds: 3600
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

| Change                                                                                                                                                                      | Visible within                                    | Why                                                                                                                                                                                                                                                            |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A change written through strad's own console or the `secrets` MCP server's write tools; the console's **Re-read the store** button; the MCP server's `refresh_gateway` tool | immediately                                       | The writer drops the process's reading of the store, so the next read reaches it. These are the routes to rotate by. Other components converge within the TTL.                                                                                                 |
| **Rotating** a secret read on the request path, from outside strad                                                                                                          | `ttlSeconds` (default 1 day)                      | The process's reading of the store is replaced on the first read after it ages past the TTL. Only request-path `${NAME}` references — a boot key or a baked one is [a restart or a deploy](#what-rotates-live-what-needs-a-restart-and-what-needs-a-redeploy). |
| **Adding** a name that was absent, from outside strad                                                                                                                       | `negativeTtlSeconds` (default 1 hour)             | A miss drops the reading and reads again, rate limited so an unknown `${REF}` on a hot path — or a slug deployed ahead of its credential — cannot re-read the store once per request.                                                                          |
| **Seeding** a name a slug declared [`mayBeUnseeded`](#maybeunseeded--deploying-a-server-ahead-of-its-credential)                                                            | `negativeTtlSeconds`, then one reachability probe | The same mechanism as any newly-added name. The slug goes from `unconfigured` to serving with no redeploy.                                                                                                                                                     |
| A brand-new **secret** parameter                                                                                                                                            | up to ~2 minutes                                  | Its `__REF__` resolves only once the IAM binding `create()` made has propagated. Until then `:render` answers `400 SECRET_REFERENCE_ERROR` — see the caution above; that window looks exactly like the bug.                                                    |

The defaults are a day and an hour, on purpose, and the next section says why.
The first row is the mechanism; the TTLs are the fallback for a writer that did
not say anything. A deployment that rotates by hand and wants a shorter bound
can set either knob lower; the cost is stated there too.

Three behaviours matter more than the numbers:

- **Concurrent reads are single-flighted.** A burst of requests on a cold
  process opens one read of the store, not one each — and every namespace the
  process serves shares that one read.
- **A failed read serves the last known good values** and logs a warning
  naming the provider and the error — never a secret, never a value. A store
  outage must not take `/mcp` down. Only the very first read propagates its
  error, because there is nothing to serve and reporting a config problem for
  what is an outage would be a lie. A render that failed on a throttle, a server
  error or a timeout is not remembered either: the next reader renders again,
  rather than inheriting one bad moment for the length of the TTL.
- **Every store read carries a 10s deadline**, and a failed read backs off for
  5s before being retried. Both exist for the same reason: a request that HANGS
  is worse than one that fails, because a never-settling read pins every
  concurrent reader behind the single-flight it shares — the availability claim
  above rests on reads eventually settling. The backoff keeps an outage from
  costing one failed call and one log line per request.

### One reading of the store per process

A process reads the store **once**, and holds that reading for `ttlSeconds`.
Every namespace it serves — the gateway's own, each server's
`/mcp/{slug}/static/`, a `params: true` builtin's, the one the console's
diagnosis asks about — is a slice of the same reading. Nothing re-reads the
store on its own cadence: not the reachability poller, not a `/connectors` reload, not
a poll of `/api/secrets/readiness`. The store is read again when the reading
has aged past the TTL and something asks, when a write goes through the console
or the parameter write-back route, when the console's **Re-read the store**
button is pressed or the `secrets` MCP server's `refresh_gateway` tool is called
(which its write tools do for you), or when a `${NAME}` the reading does not
hold is asked for (at most once per `negativeTtlSeconds`).

That is the whole cost model, and it is why the defaults are a day and an hour
rather than a minute and ten seconds. Parameter Manager bills every
`GetParameterVersion` and every `RenderParameterVersion`; a namespace is not
addressable, so reading one means reading a version of **every** parameter in
the project ([limitation #69](/limitations/#69-a-namespace-is-not-addressable-so-reading-one-means-reading-the-whole-store)).
Production's August bill was ~3.2M billed reads — the largest line on the
account, flat around the clock, growing with every server added — because each
of the six or seven namespaces the gateway read had its own 60-second timer and
each refresh cost the project's full parameter count. Secrets there change a
few times a month.

Counted against the in-memory fake at production's shape (34 parameters, one
gateway namespace, six server namespaces, a `params: true` builtin and the
console's diagnosis; `test/secrets.read-accounting.test.ts`), one reachability
tick costs:

| Shape                                                       | Enumerations per tick | Billed reads per tick | Billed reads per day                             |
| ----------------------------------------------------------- | --------------------- | --------------------- | ------------------------------------------------ |
| One reading per namespace, `ttlSeconds: 60` (what prod ran) | 10                    | 388                   | 558,720 per core process, re-driven every minute |
| One reading per process, `ttlSeconds: 3600`                 | 1                     | 68 (2 x 34)           | 1,632                                            |
| One reading per process, `ttlSeconds: 86400` (the default)  | 1                     | 68 (2 x 34)           | 68                                               |

Per process: a deployment with two bundle components that host `params: true`
builtins reads once per process on each. The bill no longer moves when a server
is added — a new namespace is a new slice, not a new timer — and moves by one
`GetParameterVersion` plus one `RenderParameterVersion` per TTL when a parameter
is. At the default TTL that is 68 reads a day — about 2,000 a month, inside
Parameter Manager's free allowance of 10,000. One thing multiplies it: a
`${NAME}` the shared namespace does not hold (one still served from the
environment behind `envFallback`, or a `mayBeUnseeded` name nobody has seeded)
is a miss on every ask, so the reading is re-taken every `negativeTtlSeconds`
instead — 24 a day, 1,632 reads, the hour-TTL row above.

What the long default costs is the bound on a change nobody announced — a
value written straight into the parameter store some other way, by hand with
`gcloud` say: a day (an hour for a newly added gateway-namespace name), not a
minute, unless somebody presses the button. The console and the `secrets` MCP server's write tools
are the routes to rotate by — a write through either lands at once — and each
has an explicit re-read for a rotation made elsewhere, with no write: the
console's **Re-read the store** button, and the MCP server's `refresh_gateway`
tool, which reaches core over the parameter write-back wire and is held to one
re-read per 30 seconds so an agent in a loop cannot recreate the old bill. A call
inside those 30 seconds is not dropped: core owes it one re-read when the floor
passes, so two writes ten seconds apart both land within the half-minute. The
write-back route drops the reading too, so a credential a container rotated on
use is current on core the moment it is persisted.

The console's secrets pages read through a different client — the admin
credential — and it holds a reading of its own, for five minutes. A page load
or a namespace switch inside that window reads nothing. A write through the
console re-reads only the parameter it wrote and keeps the rest, so the row you
just rotated is current on the page the action returns and the action costs a
few requests rather than two per parameter in the project. **Re-read the store**
and `refresh_gateway` drop this reading too; a value written with `gcloud` shows
on its own within five minutes. If one parameter cannot be read — a throttled
request, say — the page lists everything else and names the one it could not
read, rather than reporting an empty namespace. A listing that fails outright
says so as its own state. `test/console.read-accounting.test.ts` counts it: at
production's ~130 parameters a page load was 261 requests and a reveal 525; a
repeat load is now 0 and an action 2 to 5.

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

### `STRAD_TOKENS` is a parameter you can also manage from `/tokens`

`/strad/{env}/gateway/static/STRAD_TOKENS` is an ordinary secret parameter and
appears in the parameters console like any other. With
`auth.staticTokens.store: parameter-store` it is also the **live** token store:
the gateway reads it through the runtime provider on every `/mcp` request, and
the console at `/tokens` mints and revokes into it. That page is the one to use —
it writes well-formed records, shows the plaintext once, and drops this process's
reading of the store so a revoke takes effect on the next request rather than
within `ttlSeconds`.

Rotating it through the **parameters** page instead is still just a rotate, and
it still works; you are writing the whole JSON array by hand, and a payload that
is not an array of `{pubid, hash, roles}` fails every `/mcp` request closed until
it is fixed. There is nothing to re-encode either way: the array's `"`, `[` and
`{` are exactly why it is stored base64url, which is the next section.

With `auth.staticTokens.store: env` this parameter is read once, at boot, by
hydration — and `/tokens` says so and offers no forms.

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
`test/vendored.sync.test.ts` fails CI when the copy drifts, and
`test/parameter-wire.ownership.test.ts` fails when that tree grows a second
implementation of a name the shared file owns. It is checked
rather than asked-for-politely because a disagreement here is the one failure in
this subsystem that is silent: both halves keep answering, and one of them hands a
process bytes that are not the value. See [Known limitations](/limitations/) #33.

**The rules for a parameter's VERSIONS travel the same way.** Parameter Manager
has no `latest` alias, so "the current version of this parameter" is a decision
every caller makes for itself — and all of them make it the same way: skip the
disabled versions, take the greatest NUMERIC suffix, and mint the next one as
`v{n+1}`. Ranking by list order is the trap, because Parameter Manager lists
lexicographically and `v9` sorts after `v12`. The third rule is the grant that
makes a written secret readable at all: `:render` dereferences a `__REF__` as the
PARAMETER's own principal, so that principal needs `secretAccessor` on the secret
or every render is a `400 SECRET_REFERENCE_ERROR`. All three live in
`src/secrets/parameters/write-rules.ts`, vendored into
`servers/secrets/shared/src/parameter-write-rules.ts` by
`npm run writerules:sync`, guarded by `test/vendored.sync.test.ts` and
`test/parameter-write-rules.ownership.test.ts`. What is NOT shared is the HTTP
around them — each tree lists, POSTs and read-modify-writes the IAM policy with
its own token and its own error type, and none of those differences is a
disagreement about which version is current or about what the policy should say.
A disagreement about the RULES is the silent one: a writer that ranks or mints
differently writes a version every reader skips, so the rotate reports success
while the console, the resolver and every container keep serving the old
value.

## A server's secrets live in that server's namespace

**Every `${NAME}` written on a server entry resolves from that server's own
namespace first**, whatever the kind and whatever the field:

| Order | Namespace                               | Holds                                          |
| ----- | --------------------------------------- | ---------------------------------------------- |
| 1     | `/strad/{env}/mcp/{slug}/oauth/{NAME}`  | A credential strad **minted**. **Wins.**       |
| 2     | `/strad/{env}/mcp/{slug}/static/{NAME}` | A value a human **typed** for that one server. |
| 3     | `/strad/{env}/gateway/static/{NAME}`    | The deployment-wide value. The fallback.       |

Layers 1 and 2 are the two **kinds** one server's namespace is divided into —
see [The two kinds](#the-two-kinds-static-and-oauth) below. The gateway namespace
is for things that genuinely belong to the gateway — `STRAD_TOKENS`,
`GOOGLE_CLIENT_SECRET`, a name several servers deliberately share. A credential
that belongs to one MCP server belongs under that server.

Before this, only the second namespace existed, so a name was a deployment-wide
singleton: `telegram-ro` and `telegram-rw` both write `${TELEGRAM_API_HASH}` and
could not be given different credentials, whatever was seeded where.

### An entry authored at runtime reads layer 1 only

A server entry added through [`gateway.configStore`](/operate/runtime-config/) —
from the console at `/connectors`, or from the `connectors` builtin over `/mcp` —
resolves its `${NAME}` refs against `/strad/{env}/mcp/{slug}/static/` and stops
there. Layer 2 is not behind it.

The caller of a runtime write chooses both the name and the URL it is
interpolated into, so a chain ending at the gateway namespace and core's process
environment would let such an entry read a credential it has no claim on and send
it to a host that caller picked. `forServerIsolated` is the narrowed provider;
[what a runtime write may
reach](/operate/runtime-config/#who-may-write-and-what-a-write-may-reach) has the
reasoning and the other bound that goes with it.

An entry the checked-in config declares is unaffected — both layers, in the order
above. The bound follows provenance, not the ref syntax.

### A connector's variables are read from that namespace WITHOUT being referenced

An `oauth:` connector names three variables — the OAuth client id, the client
secret, and the refresh token the console flow writes — and none of them is a
`${NAME}`. The renderer reads them out of that slug's own namespaces — `oauth/`
ahead of `static/` — and injects them, each one only if the store holds it; the
config gate refuses a `${NAME}` reference to any of them by name.

That is not a stylistic preference. `render-spec` fails the **whole** app spec on
one unresolvable reference, and the refresh token cannot exist until a human has
completed the console consent flow — which needs the slug deployed first. A
reference would make one unconnected slug a fleet-wide deploy failure. Injection
makes it a degraded mount and nothing else.

There is no fallback for these three: the gateway namespace is not consulted, and
neither is a sibling slug's. A client id seeded once at the gateway would make six
Google Sheets slugs all look ready while none of them owned a credential. Seed
them per slug. See [Connectors](/operate/connectors/).

**Two of the three are also the one secret the console may read back.** The
consent flow reveals the client id before it redirects and both halves at the
callback, with the console's own credential — which on a
[§1 deployment](/operate/secrets-iam/#1-prod-console-write-but-never-read) can
write a secret and not read one. So creating either of them at
`{slug}/static/` also binds the console's service account `secretAccessor` on
that one secret, and a connector seeded before that offers the same grant from
its own page. Which paths qualify comes from the config's `oauth:` blocks and
from nowhere else, the `oauth/` kind is never granted, and the grant is verified
by reading the value back — a deny policy beats it, and saying so is the point.
See [An `oauth:` connector reads its own OAuth
client](/operate/secrets-iam/#an-oauth-connector-reads-its-own-oauth-client).

### The two kinds: `static` and `oauth`

The canonical path is `/strad/{env}/mcp/{slug}/{kind}/{VARIABLE}`, and `kind`
names **where the value came from**:

| Kind     | Written by                                                                                                                                                                                                  | Typical contents                                                                                                                                                 |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `static` | a human, in the console, who creates it; the write-back route, which rotates an existing one for a `paramsWritable:` name                                                                                   | an API key, an OAuth client id and client secret                                                                                                                 |
| `oauth`  | strad's own consent callback, which creates it; the write-back route, which rotates it for a [`paramsWritable:`](#paramswritable--a-credential-that-rotates-on-use) name; core's `oauthRefresh:` write-back | the refresh token (or long-lived access token) a human authorized; for a `remote-http` Connect, also the discovered token URL, registered client id and resource |

Both resolve the same way. Everything on this page that is true of a `static`
parameter is true of an `oauth` one: `params: true` injects it, a `${NAME}`
substitutes from it, the `secrets` MCP server lists it as metadata and can never
read its value, and a secret one lives in Secret Manager behind a `__REF__`
pointer.

**`oauth` wins over `static` for the same variable name.** A value a human typed
months ago and a consent completed this morning disagree; the fresh grant is the
one a call should carry. That ordering is also what makes the kind safe to adopt:
a deployment whose connector token was written under `static/` before the kind
existed keeps working untouched, and the next **Reconnect** writes to `oauth/` and
takes precedence from then on. The console says which path the current credential
is being read from whenever the two differ.

**Two writers, one credential.** The consent callback is the only thing that
_creates_ an `oauth/` parameter. The write-back route can only `rotate()` one that
already exists, which is what a provider with single-use refresh tokens needs: the
container spends the consented token, the provider hands back its successor, and
core writes that successor over the same path. It is the same credential
continuing, through the same admin credential, and a rotation leaves the
parameter secret and the consent note intact. A rotation before anyone has
consented is a 404, not a quiet create.

A value the consent wrote under `oauth/` is one **no person has ever seen** — it went from the
provider's token endpoint into Secret Manager without being rendered, returned or
logged. That is the reason the kind exists as a separate namespace rather than as
a naming convention: "a human typed this" and "strad minted this" are different
provenance claims, and the path is where the claim lives.

A third spelling is not a kind. `{slug}/statik/TOKEN` is stored, listed, and read
by nothing — `render-spec` warns about it by name rather than resolving it.

### The same rule, applied at two times

The layering is one rule with two implementations, because the two halves of a
config are resolved at different moments:

| The ref                                            | Resolved                               | By                                |
| -------------------------------------------------- | -------------------------------------- | --------------------------------- |
| A supplementary image's `env:`                     | At **render time**, baked onto the box | `src/deploy/server-namespaces.ts` |
| A `url:`, a `headers:` map, a builtin's `options:` | At **runtime**, per request            | `src/secrets/provider`            |

The runtime half is what makes this work for a kind strad runs **no container
for**. `remote-http` and `local-tunnel` servers get no component, no image and no
deploy-time environment, so `params: true` and the render-time layer are both
closed to them — the gateway namespace was the only place their credentials could
live. Now their own namespace is read first, in strad's own process, on the
request path.

```yaml
# A local-tunnel server's three credentials, all its own.
- slug: anki
  kind: local-tunnel
  url: https://anki.example.com/
  headers:
    CF-Access-Client-Id: "${ANKI_CF_ACCESS_CLIENT_ID}"
    CF-Access-Client-Secret: "${ANKI_CF_ACCESS_CLIENT_SECRET}"
    Authorization: "Bearer ${ANKI_MCP_API_KEY}"
```

```
/strad/prod/mcp/anki/static/ANKI_CF_ACCESS_CLIENT_ID
/strad/prod/mcp/anki/static/ANKI_CF_ACCESS_CLIENT_SECRET
/strad/prod/mcp/anki/static/ANKI_MCP_API_KEY
```

Because a runtime ref is read on the request path rather than baked, **rotating
one of these needs no redeploy** — a new value is picked up at once through the
console, and within `gateway.secrets.ttlSeconds` from anywhere else. That is the
one behavioural difference from the render-time half, where a supplementary
`env:` still reaches its container only at the next deploy.

:::note[A newly _seeded_ per-server name takes up to `ttlSeconds`, not `negativeTtlSeconds`]
The per-server layer deliberately does not chase a miss. A miss there is the
normal case — most names live in the shared namespace and always will — and
chasing one drops the process's whole reading of the store, so chasing every
miss would cost a full re-read per gateway-resolved name per slug. The ordinary
TTL still replaces it, and the console's **Re-read the store** button — or the
`secrets` MCP server's `refresh_gateway` tool — replaces it now. The shared layer keeps its miss-driven re-read, which is where a
brand-new name usually appears.
:::

### Under `gateway.secrets.provider: env` there is no second layer

An `env` deployment reads every `${NAME}` out of `process.env`, which is flat.
Per-server namespaces are a parameter-store feature; a value filed under one
resolves for nobody on an `env` deployment. The console says so rather than
offering it as a fix.

**Nothing opts in.** A server nobody seeded has an empty first layer, falls back
to the shared namespace, and renders exactly what it rendered before — that is
the whole compatibility story, and it is why there is no flag. A flag would only
have rebuilt the trap: seed the values, forget the flag, get a green deploy that
injected nothing.

**It is not `params: true`, and does not change it.** That flag injects a
namespace _wholesale_ — every variable in it becomes an env var, named by the
store. This substitutes into `${NAME}` references the config already makes, and
injects nothing the config does not name. One server may use both, out of one
namespace.

```yaml
# Different values for one name, on ONE bundle — because they are two mounts.
- slug: telegram-ro
  kind: supplementary-image
  bundle: bundle
  path: /telegram-ro # ← its own path, so its own instance in the container
  env:
    TELEGRAM_API_HASH: "${TELEGRAM_API_HASH}" # ← /strad/prod/mcp/telegram-ro/static/
- slug: telegram-rw
  kind: supplementary-image
  bundle: bundle
  path: /telegram-rw
  env:
    TELEGRAM_API_HASH: "${TELEGRAM_API_HASH}" # ← /strad/prod/mcp/telegram-rw/static/
```

### What a server's variables are called on the box

A namespace decides which value a server _resolves_. It does not decide where the
value can _go_ — a bundle is a component is a container with one `process.env`,
and one name holds one value. So **every** supplementary server's `env:` is
emitted twice onto its bundle:

| On the box                       | Carries                                                      |
| -------------------------------- | ------------------------------------------------------------ |
| `TELEGRAM_API_HASH`              | The bare name it always had. Never removed, never repointed. |
| `TELEGRAM_RW__TELEGRAM_API_HASH` | The same variable, named for `telegram-rw`.                  |

The per-slug name is the slug uppercased with `-` turned into `_`, joined to the
variable with `__`. **There is no condition on this.** Given a config you can
compute the whole set by hand, one server at a time, without looking at any other
server and without knowing what has been seeded anywhere. A server reads its own
name first and falls back to the bare one, so a server whose per-slug name holds
the same value reads the same thing either way.

An earlier version minted the second name only where two servers resolved one
variable differently. That was correct and unreadable: what a variable was called
depended on what some _other_ slug happened to have been seeded, so you could not
look at a server and know its own names.

### What is still conditional is reading, not naming

The bundle host serves **one instance per path**. So a slug can only be handed its
own names — as opposed to merely having them exist — if the host can build a
separate instance for it, which needs the slug to be **the only one on its path**
and that path to be **`/<its own slug>`** (the host mounts a discovered slug at the
slug, having no config to read a path out of).

That is a property of the config you can check by eye. `gmail-ro`, `gmail-rw` and
`gmail-rw-external` all serve `/gmail`: one process, one set of credentials. Their
per-slug names exist on the container like everyone else's; what they read is the
bare name. Which is why two slugs on one path resolving one variable to different
values is still a hard error — one process cannot hold two credentials, whatever
the variables are called.

Two categories cannot be named at all, both decidable from the config alone:

- **A slug starting with a digit.** `1PASSWORD__X` is not a portable variable
  name, so that server has no per-slug names and reads the bare ones. The render
  says so by name.
- **A `params: true` server's variables**, because they are not in `env:` at all —
  a managed parameter's name comes from its path in the store. There is no
  declaration to name.

### What this changes about a rendered spec

Emitting unconditionally means the app spec gains one variable per supplementary
`env:` entry. Measured against `main`: prod's `bundle` goes from 36 to 87
variables and staging's from 34 to 83, with **nothing removed and no value
changed** on any component, and `core` untouched. Every server therefore reads
exactly what it read before, which is also why the core and bundle images can
deploy in any order — an image that knows nothing about per-slug names finds every
bare name where it always was.

:::caution[Two slugs on one path is still one credential]
`render-spec` **fails the deploy** when two slugs that share a `path:` resolve one
name to different values, rather than picking one:

```
bundle "bundle": servers "telegram-ro" and "telegram-rw" both set
TELEGRAM_API_HASH under env:, both serve path "/telegram", and the two
resolve to DIFFERENT values… One path on one bundle is ONE mount in the
container: one process, one set of credentials… Give each its own path —
path: /<its-own-slug> — or its own bundle, or seed them the same value.
```

That is the capability-variant pattern (`telegram-ro` / `telegram-rw`, `gmail-ro`
/ `gmail-rw`): two slugs, one mount, one upstream process, told apart by the
gateway's `tools:` policy. They share a container **because** they share a
credential, and seeding both with the same value is correct and supported.
:::

### A parameter nothing reads now says so

Seeding `/strad/{env}/mcp/{slug}/static/` for a server that references nothing by
that name used to be a **silent no-op**: no injected variable, no warning, a green
deploy. The render now warns, by name:

```
::warning::/strad/prod/mcp/telegram-rw/static/ holds 3 parameter(s) nothing reads
(TELEGRAM_API_HASH, TELEGRAM_API_ID, TELEGRAM_STRING_SESSION): the
supplementary-image "telegram-rw" names no ${NAME} by that name.
```

There is **one** rule behind that warning and it is the same for every kind: does
the server reference the name? A seeded variable under an unhosted or builtin slug
used to be reported as unread on the grounds that no mechanism could ever read it,
and that is no longer true.

It warns rather than fails, because a store is also allowed to be a registry of
values a human manages by hand. The same judgement drives the chip on each row of
the console's parameters page, so the answer is the same in both places.

### The gates know about the second layer

Three of them, and each would otherwise refuse a store that is correct:

- **`render-spec`'s preflight** — a name held by every server that references it
  is reported as served per-server, not missing. This is the load-bearing one: it
  exits 1 on an unresolvable name, so without it, filing a credential where it
  belongs would red **every** deploy.
- **`scripts/check-store.ts`** — the pre-flip gate reports the same names under
  `perServer` rather than `missing`.
- **The console's secret roster** — a row is resolved through the referencing
  server's own provider, so a per-server-seeded credential reads green, and the
  server's own namespace is offered first as the place to fix a missing one.

Coverage is **all-or-nothing per name**. If two servers reference `${SHARED}` and
only one of them holds it, the other still falls through to the gateway namespace,
so the name is missing and the deploy fails. The gateway's own boot keys
(`STRAD_TOKENS`, `STRAD_INTERNAL_TOKEN`, …) can never be covered this way: no
server references them, and the process reads them for itself.

## One parameter in this store is not a credential

A deployment with `gateway.configStore.enabled: true` keeps its **runtime server
overlay** — the entries a human added or changed through the console — in the
same store, as one non-secret parameter:

```
/strad/{env}/gateway/config/SERVERS
```

The namespace is deliberate. `config/` is not `static/`, and only `static/` is
read for `${NAME}` resolution, so the overlay can never resolve as a variable
some server happens to reference. Nothing else is kept under `config/`.

It is a **non-secret** parameter: its value is a config document — slugs, urls,
role names, `${NAME}` references — and holds no credential. Anything
credential-shaped inside it is a reference to something under `static/`, resolved
per request like every other one.

The two credentials are the ones already on the deployment. Reads go through the
**resolver** key the container already carries. Writes go through the **admin**
key, on core only, via `consoleEnv:` — the same `SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON`
the console's secrets pages use. A gateway holding the resolver key and not the
admin key serves the roster read-only and says which credential is missing.
Nothing new is granted: the admin identity could already write any parameter in
this store.

The document is capped at 64 KiB, the same bound the write-back route below
applies. Full model: [Runtime config](/operate/runtime-config/).

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

## `mayBeUnseeded:` — deploying a server ahead of its credential

That preflight had a second effect nobody chose. Adding a server whose credential
nobody had seeded yet failed the render for the **whole fleet**, so onboarding one
carried a human gate: seed the token, _then_ merge the PR. A config change and a
store write had to be ordered by a person, every time.

A server can now name the `${NAME}`s it is willing to deploy without:

```yaml
- slug: apify
  kind: remote-http
  url: https://mcp.apify.com/mcp
  entitlements: [admin]
  headers:
    Authorization: "Bearer ${APIFY_TOKEN}"
  mayBeUnseeded: [APIFY_TOKEN]
```

The deploy then **warns instead of failing**, that slug alone comes up inactive,
and every other server deploys exactly as before.

It does not mean "this server works without the value". It means the deploy may
proceed without it.

### Three properties, and the third is the reason for the shape

**A listed name warns.** `render-spec` prints one `::warning::unseeded secret
<NAME> …` per name — greppable by that prefix — saying which slugs shipped
inactive and what to seed. The summary line counts them apart from the ones that
resolved.

**An unlisted name still reds the deploy.** Nothing about the default moved. A
`${NAME}` no server waived fails the render by name, as it always did.

**A waiver that waives nothing is itself an error.** This is why the marker is a
_list of names_ rather than a flag on the server. `mayBeUnseeded: true` beside a
typo'd `${APIFY_TOKN}` would degrade forever in silence — exactly the failure this
repo has already been bitten by. A list cannot: the typo'd reference is a name
nobody waived, so it still fails, _and_ the useless entry is reported as the
mistake it is. `npm run config:check` and `render-spec` both refuse it.

A fourth rule falls out of the same reasoning: **a name is waived only when every
enabled server that references it waives it.** One server deferring a token
another server needs is not a deferral — the second server would come up dead,
which is the fleet-wide failure spelt differently.

### What the slug looks like while it waits

Not "down", and not "gone". It gets its own state everywhere state is reported —
**for a reference strad's own process resolves**: a `url:`, a `headers:` map, a
builtin's `options:`. A `supplementary-image`'s `env:` is a variable on a
container strad does not run, so a waiver there means the component simply ships
without it and the slug's state is whatever that server reports about itself. When
that server is a bundle mount that reports itself `degraded` for the missing
variable, core reads it as one bit: the slug appears in `/healthz`'s
`mountDegraded`, [`strad.mcp.mount_degraded`](/operate/telemetry/#stradmcpmount_degraded--does-the-bundle-say-a-mount-is-unwell)
reads 1, and `strad.mount_state` logs it at **Info**. One bit cannot tell this
deferral from a failed login, which is why that event is not a fault and pages
nothing; an alert on the gauge is scoped by slug, and should leave a deferred slug
out.

| Surface                            | Says                                                              |
| ---------------------------------- | ----------------------------------------------------------------- |
| `/healthz`                         | `servers[].state: "unconfigured"`, and the slug in `unconfigured` |
| `/healthz` `degraded`              | **not** listed — nothing is broken                                |
| `/console`                         | badge `INACTIVE`, chip `awaiting credential`; not an issue        |
| `/api/secrets/readiness`           | `state: "unconfigured"`, ranked just under `missing`              |
| `tools/list` for `?servers=<slug>` | an error naming the slug and the `${NAME}`                        |
| `tools/list` with no `?servers=`   | the slug contributes no tools; every other server is unaffected   |
| logs                               | `strad.tool_surface_unconfigured`, at Info — it does not page     |

Keeping it out of `degraded` is load-bearing rather than cosmetic: `degraded` is
what the staging deploy gate asserts on, so counting a deliberate deferral there
would red the deploy this feature exists to let through, one layer further down
than the preflight that used to.

Nothing ever sends the literal `${APIFY_TOKEN}` upstream. Resolution throws before
a request is built, which is the whole reason the slug has a state at all. For the
same reason, the render **drops** an `env:` / `consoleEnv:` entry whose `${NAME}`
was waived and resolved to nothing, rather than baking an empty string: a blank
credential is one the container would try to use.

### How fast it activates once you seed it

That depends on where the value is read, and the two are not close.

| The reference                                                         | Activates                                                                                                                                                                  |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A `url:`, `headers:` or builtin `options:` ref, `gcp-parameter-store` | at once if seeded through strad's console or the `secrets` MCP server; otherwise within `negativeTtlSeconds` (default 1 hour) of the store write. No redeploy, no restart. |
| The same, seeded in the server's own `/mcp/{slug}/static/` namespace  | at once through the console or the `secrets` MCP server; otherwise within `ttlSeconds` (default 1 day) — that layer does not chase a miss.                                 |
| A `supplementary-image`'s `env:`, or anything under `provider: env`   | **next deploy.** It is baked onto a container strad does not run.                                                                                                          |

`/healthz` and the console follow within one reachability probe (60s) of the
value resolving. In every case it is a store write and a wait — never a PR.

:::caution[Nothing alerts on a slug that sits unconfigured forever]
The state is visible on `/healthz`, in the console's actionable count, and in a
log line per boot. Nothing escalates if a slug stays there for a week. That is
the residual cost of removing the deploy-time gate, and closing it is an alerting
change rather than a strad one.
:::

## A refused read is not an answer about the parameter

Parameter Manager enforces a per-project, per-minute read quota, and a deploy is
the workload that runs into it: `store:check --resolve` reads the whole store, and
`render-spec` reads it again seconds later.

A `429` out of that burst says nothing about the parameter. It is there, the
credential is right, the request was simply refused. Treating it like a `403`
aborted a production deploy before `doctl` was reached.

So the store client separates the two:

- **A refusal on a read is retried.** `429`, `500`, `502`, `503` and `504` on a
  `GET`, `HEAD` or `DELETE` get exponential backoff with jitter: up to three
  retries, and at most **2.8s** of backoff. A `Retry-After` header is honoured
  verbatim when it fits the call's 6s ceiling, and declined outright when it does
  not — a `Retry-After: 600` costs one attempt, not ten minutes of a deploy step.
- **Answers are not retried.** `401`, `403`, `404`, `409` and everything else fail
  on the first response, unchanged, with the status a caller switches on intact. A
  permission error retried is the same error reported one backoff later.
- **Nor is anything on a write.** Not even a `429`. A refusal that reaches us from
  a fronting proxy may have been emitted _after_ the backend applied the write, and
  nothing in the response tells the two apart. Retrying a `POST` that landed
  returns `409 ALREADY_EXISTS` — which `create()` reads as "not mine to delete", so
  it skips the parameter rollback, removes the backing secret it did make, and
  strands a versionless parameter `destroy()` cannot remove. The deploy path this
  retry exists for is every-request-a-`GET`, so the line costs nothing.

The budget is small on purpose. Every read must still SETTLE — the runtime provider
serves stale values when a refresh rejects, but has nothing to react to if a promise
never settles — so retrying widens that bound rather than removing it.

Every attempt is bounded, and so is the bearer it travels with. The store gives
each request a deadline minted fresh for that attempt — a signal that has already
fired would abort the next one instantly — and it gives the service-account token
exchange it makes on the way a deadline of the same length, because a bearer
fetched for a read is part of that read rather than a call with a bound of its
own.

The shared exchange also carries a **ten-second** default for callers that name no
deadline at all, which is what the capability probe and the console's bucket
browser reach it through: no mint anywhere waits on a stalled token endpoint for
undici's 300 seconds. Its expiry is a `408` rather than a `504` because no retry
policy should read a deadline this end enforced as "not now" — `408` is outside
the transient set above, so a caller that loops on status reports the bound once
rather than spending four of them on an endpoint that is already silent.

None of that is specific to Parameter Manager, so none of it lives there. The
policy — which statuses mean "not now", how `Retry-After` is read, how the
backoff is jittered, and what a budget bounds — is `src/http/retry.ts`, and the
store is one of its two callers. The other is the registry walk that resolves
which image a deploy ships, which meets the same `429` against GHCR for the same
reason: a burst of reads in a few seconds. See [when GHCR refuses the
walk](/operate/operations/#when-ghcr-refuses-the-walk). The budgets differ —
each caller sizes its own — but the rules do not, which is the point of having
one module rather than three.

:::caution[The retry survives a blip, not an exhausted quota]
Three retries and at most 2.8s of backoff clear a burst that overran the quota for
a second or two. They do not clear a quota exhausted for the
whole minute — the budget runs out and the deploy fails as it did before, just
later. Reading the store fewer times is the other lever, and it is the one below;
retrying harder is not. See [Known
limitations](/limitations/#69-a-namespace-is-not-addressable-so-reading-one-means-reading-the-whole-store).
:::

## One enumeration per deploy, not one per namespace

A parameter's namespace lives inside its version **envelope**, not on a Parameter
Manager label. So `list(namespace)` cannot ask the store for a namespace — it pages
every `managed-by: strad` parameter in the project, reads a version of each one to
recover its envelope, and filters afterwards.

`resolve()` calls `list()`. Resolving N namespaces therefore cost **N x P version
reads** for P parameters, and both factors grow every time a server is added. That
is what put a deploy over the quota, and adding a retry would only have made it fail
more slowly.

Every reader that resolves more than one namespace therefore holds **one
reading per process** (`snapshotTtlMs` on the store client). `render-spec` and
`store:check` are one-shot and read-only, and hold it for the length of the run:
counted against the in-memory GCP fake for the shape a render actually has — one
store-wide `list()` followed by fourteen namespace `resolve()`s over 56
parameters — that is **1751 requests before, 169 after**. The running gateway
holds it for `gateway.secrets.ttlSeconds`; [what that costs and
buys](#one-reading-of-the-store-per-process) is above. Namespaces resolved
concurrently share the enumeration already in flight rather than starting their
own, and a refused enumeration is never held.

The gateway and the console leave it **off**, which is the default. They write, and
a store that answers from a cache reports a parameter someone just created as
absent — the console writes and re-lists in the same breath. Every write through a
store drops its roster regardless, so the reuse cannot outlive a change made through
it.

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

| Counted                                                                       | Why                                                      |
| ----------------------------------------------------------------------------- | -------------------------------------------------------- |
| every `${NAME}` in a remote-http url/header/`oauthRefresh:` or builtin option | resolved on the request path                             |
| **every** core boot key, optional-at-boot included                            | hydrated at startup; optional there is not optional here |
| every `supplementary-image` `env:` name                                       | read from the store at render time                       |
| _not_ a `consoleEnv:` name                                                    | deploy-environment only — see below                      |

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

| The name                                                                                                                                         | Rotating it takes effect          | Because                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A `${NAME}` in a `remote-http` server's `url`/`headers`, or a `builtin`'s `options`                                                              | within `ttlSeconds`               | Resolved on the **request path** by the runtime provider.                                                                                                                                                                                                                                                                                           |
| A `remote-http` server's `oauthRefresh:` refresh token                                                                                           | within `ttlSeconds`               | Resolved on the request path like any other `${NAME}`; a value strad has never held starts a new token lineage, and the old account's access token is dropped before the next request. A token the provider **rotated** is written back by core — see [`oauthRefresh:`](#oauthrefresh--a-rotating-refresh-token-on-a-remote-http-server).           |
| A `params: true` **supplementary image's** managed parameters                                                                                    | on the next **deploy**            | Resolved at render time onto that server's own component. Unless the name is on that server's [`paramsRefresh:`](#paramsrefresh--a-rotation-that-lands-without-a-deploy) list (**within `paramRefreshSeconds`**, no deploy) or its [`paramsWritable:`](#paramswritable--a-credential-that-rotates-on-use) list (re-read at **boot**).               |
| A **store-served instance's** namespace                                                                                                          | within `ttlSeconds` plus one sync | Read by core when the bundle host syncs, and rebuilt into the instance when a value moved. A value written through the console drops core's reading at once, so it lands on the next sync — see [Store-served instances](#store-served-instances--a-mount-credentialed-from-its-own-namespace).                                                     |
| A `params: true` **builtin's** managed parameters                                                                                                | within `ttlSeconds`               | Resolved by **core itself**, per tool call: `optionsFor` merges the namespace over the resolved `options:` through the same TTL cache the runtime provider uses. No deploy is in the loop, which is what makes staging's `echo` a live rotation observatory.                                                                                        |
| The core boot keys — `STRAD_TOKENS`, `ADMIN_BOOTSTRAP_TOKEN`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `CONSOLE_SESSION_SECRET`, `SENTRY_DSN` | on the next **restart**           | Hydrated from the store once, at boot, by code with no provider in scope. **`STRAD_TOKENS` is the exception under `auth.staticTokens.store: parameter-store`**: the token store reads it through the runtime provider on the request path instead, so it rotates within `ttlSeconds` — and at once when the change is made in `/tokens`. See below. |
| `STRAD_INTERNAL_TOKEN`, `OTEL_EXPORTER_OTLP_HEADERS`                                                                                             | on the next **deploy**            | Hydrated on core and **baked** on every supplementary component — see below. The internal token is baked on every non-core component, the strad image included, as that component's own token derived from core's root. A restart moves only one side, and for the internal token both sides must agree.                                            |
| A supplementary image's `env:`                                                                                                                   | on the next **deploy**            | Environment variables on a container strad does not run.                                                                                                                                                                                                                                                                                            |
| A `consoleEnv:` name                                                                                                                             | on the next **deploy**            | Never in the store at all: it is the console's store-_admin_ credential, baked from the deploy environment onto core.                                                                                                                                                                                                                               |

`ttlSeconds` is the answer for **request-path references and nothing else** —
plus one thing that is not a rotation at all: it is also how old the console's
and the readiness endpoint's
[store diagnosis](#the-diagnosis-is-answered-from-the-processs-reading-of-the-store-and-says-how-old-it-is)
may be, because both are answered from the same reading. And it bounds a
rotation made **outside** strad only: one made through the console lands at
once. A deployment whose config has no request-path `${NAME}`, no `params: true`
server and no `paramsRefresh:` entry has no name that rotates live, however the
TTL is set. That is a real deployment shape, not a hypothetical: check your own
config before promising anyone a rotation that lands without a deploy.

### Which boot keys a third-party container holds

The same ones, whichever provider the deployment uses. The provider decides where
a value is read from. It never decides which names a container ends up holding.

| Boot key                                                                                                                    | `core`            | a `supplementary-image` component                                                                                                          |
| --------------------------------------------------------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `OTEL_EXPORTER_OTLP_HEADERS` — `BUNDLE_BOOT_ENV_KEYS`                                                                       | yes               | yes: baked from the store under `gcp-parameter-store`, carried by the broadcast under `env`                                                |
| `STRAD_INTERNAL_TOKEN`                                                                                                      | yes, the **root** | its **own** token under the same name, derived from the root at render time and baked as a SECRET on that component alone — never the root |
| `STRAD_TOKENS`, `ADMIN_BOOTSTRAP_TOKEN`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `CONSOLE_SESSION_SECRET`, `SENTRY_DSN` | yes               | **never**                                                                                                                                  |

Under `env`, `render-spec` puts every boot key it has a value for in the app-level
env as a SECRET, and app-level SECRETs are broadcast to every supplementary component. The
broadcast drops the second and third rows. Its exclusions, `STRAD_IMAGE_ONLY_SECRET_KEYS` in
`src/deploy/appspec.ts`, are the store credential plus `CORE_ONLY_BOOT_ENV_KEYS`,
and that set is **derived**: `CORE_BOOT_ENV_KEYS` minus `BUNDLE_BOOT_ENV_KEYS`,
both in `src/secrets/provider/hydrate.ts`. A boot key added to
`CORE_BOOT_ENV_KEYS` therefore stays off third-party containers by default. The
one way to put a boot key inside one is to add it to `BUNDLE_BOOT_ENV_KEYS`, which
widens the store path's bake and the `env` path's broadcast in the same edit. That
coupling is intended: both paths answer one question, and they answer it from one
array.

`STRAD_INTERNAL_TOKEN` is in `CORE_ONLY_BOOT_ENV_KEYS` because what core holds
under it is the root. Every non-core component, the strad-image bundle included,
holds a variable by the same name, but its value is
`base64url(HMAC-SHA256(root, "strad-internal-token/v1:" + component))`, written by
`componentTokenEnv` in `src/deploy/appspec.ts`. That entry is authoritative: a
server's own `env:` cannot shadow the name. Core presents the matching token when
it calls a component, and reads a component's identity off the token when the
component calls it, so a container's token opens its own doors and no one
else's. [Limitation #63](/limitations/#63-one-internal-token-means-any-container-can-reach-any-writable-parameter)
has the design and what it costs.

The last row is the `/mcp` token store, the console's bypass token, its OAuth
client and its session-cookie key, plus the exception reporter's DSN. The sharp
ones are the console's. `CONSOLE_SESSION_SECRET` signs the session cookie, and
when it is unset the key is derived from `GOOGLE_CLIENT_SECRET`, so a container
holding either one can mint a console session, and the console is the door that
reveals and writes secrets. `ADMIN_BOOTSTRAP_TOKEN` opens the same door wherever
the dev bypass is on. The token store holds hashes, not tokens, but it still hands
over every token's id and roles, and a third-party image has no use for them. A
server that genuinely needs a value under one of these names declares it in its
own `env:`, which lands on its component alone.

### Why the bundle boot env is baked rather than hydrated

Hydration runs in strad's own process — the core, and a bundle component running
the strad image. A `supplementary-image` component is a **third-party container**.
It does not run strad, it deliberately holds no store credential (that key
reaches the strad image and stops there), and handing it one would not help,
because nothing inside it knows how to ask.

`SENTRY_DSN` is deliberately **not** one of those names, though it looks like
telemetry that should travel with the OTLP header. Only strad's own process
reports exceptions, so a third-party container has no use for one — and a DSN is a
write credential for the issue tracker, which is not a thing to broadcast to every
supplementary image. It reaches the core and any strad-image bundle and stops
there, like the store credential.

So the two names a bundle needs are produced **by the renderer** and baked onto
those components: the OTLP header read from the store, and the internal token
derived per component from the root, which the renderer also reads from the store. A human still manages them in exactly one place; the
cost is that changing one is a deploy. Both fail _silently_ when absent, which is
why the renderer refuses to emit a spec where a component holds neither the value
nor the credential to fetch it:

- **`OTEL_EXPORTER_OTLP_HEADERS`** — the exporter still starts and still sends;
  the ingestor rejects every batch. The component answering every supplementary
  slug goes blind about a minute after a deploy that reported success, with
  `/healthz` still 200 and every slug still listed.
- **`STRAD_INTERNAL_TOKEN`** — the component's presence route and its mounts fail
  closed, so the console stops being able to say what that container holds and
  reports that the component does not hold the token core derives for it. A
  render with any non-core component fails when the root resolves to nothing,
  and `bootEnvGaps()` fails one where a non-core component lacks its token.

A supplementary server that wants genuinely live rotation should read the store
itself, the way `servers/secrets` does — or, for the specific case of a
credential that rotates on use, declare it under
[`paramsWritable:`](#paramswritable--a-credential-that-rotates-on-use).

A server's `consoleEnv:` is **never** hydrated. It carries the console's
store-_admin_ credential, which can write and reveal, and two things depend on it
staying out of the store: hydration runs in every process running the strad
image, bundles included, and filing an admin credential inside the store would
let the weaker resolver credential read the stronger one. It stays deploy-time
baked, onto core alone.

## `paramsWritable:` — a credential that rotates on use

Some credentials are invalidated by being used. X's OAuth 2.0 refresh tokens are
the shape: every refresh returns a brand-new refresh token and kills the one you
just spent. Nothing above covers that, and the gap is worse than it looks:

1. The process refreshes, gets a new token, holds it in memory. Everything works.
2. The container restarts — a deploy, a platform move, an OOM.
3. It comes back holding the value the last render baked, which the previous
   process spent hours ago. Every call 401s, forever, until a human re-seeds by
   hand.

`paramsWritable:` closes that. It is an allowlist, per server, of variables that
server may write back to its own namespace:

```yaml
- slug: x-twitter
  kind: supplementary-image
  params: true
  paramsWritable: [X_OAUTH_REFRESH_TOKEN]
```

It requires `params: true` — that flag is what makes
`/strad/{env}/mcp/{slug}/` (both kinds, `oauth/` first) this server's environment
in the first place, and writing a namespace nothing injects would be a credential
going nowhere. Each entry is a **variable name**, never a path, so there is no
spelling of one that addresses another server's namespace or the gateway's.

### Which kind it writes: the one the read would pick

A name the same server does **not** declare on its [`oauth:` connector](/operate/connectors/)
is read and written under `static/`, and nowhere else.

A name the connector **does** declare may live under either kind, so the route
takes the highest one the store holds: `oauth/` when a consent has written it,
`static/` when only a hand-seeded copy exists. That is the precedence every
layered read applies, so the copy the route rotates is the copy the next boot and
the next render read. Which kinds are candidates comes from the config, and which
candidate wins comes from the store. Nothing comes from the request: the route has
no URL segment, body field or header for a kind.

That is what gives a consented credential that rotates on use both a console
consent and durability:

```yaml
- slug: x-twitter
  kind: supplementary-image
  params: true
  paramsWritable: [X_OAUTH_REFRESH_TOKEN]
  oauth:
    provider: generic
    refreshTokenVariable: X_OAUTH_REFRESH_TOKEN
    # ...
```

The consent writes `oauth/X_OAUTH_REFRESH_TOKEN`, every rotation after it
rotates that same path, and the boot read and the next render both read it back.
A rotation written to `static/` while the `oauth/` copy exists would land under a
copy that permanently shadows it, and the credential would die at the next
restart with nothing failing.

Adding a connector to a server whose token was seeded under `static/` changes
nothing until someone connects: rotations keep landing in `static/`, which is
still the only copy. The first **Reconnect** writes `oauth/`, and from then on
rotations go there.

A rotation never creates a parameter. If neither kind holds the name, the write
is a 404, and the mount degrades.

What counts as a legal variable name is **one rule**, in `src/config/env-name.ts`,
and everything that gates on it imports it from there: the config check above, the
write-back route's own second check, the console's create form (its browser
`pattern=` attribute is built from the same string), and the scanners that decide
which `${NAME}` references get baked and which get resolved at request time. Two
of those gates sit on either side of a deploy, so a disagreement between them
would be silent — a credential baked under a name nothing reads. Three modules
that are vendored into the bundle host's own npm tree still hold a copy of the
literal; a test greps them, and [Limitations](/limitations/) #81 says why.

**Seed the parameter first.** The write is a `rotate()`, which needs a parameter
to rotate: create the name in `/ui/secrets` (or with `store:seed`) under that
server's namespace before the first deploy. For a connector's refresh token, the
console consent creates it. Until it exists the boot read gets a
404 and the container falls back to its baked value — which works, and quietly
keeps working, right up until the first rotation has nowhere to land.

### The write goes through core, not through a new credential

The container answering `/mcp` holds no cloud credential, and that is the point
of the whole [three-role split](#gcp-parameter-store--runtime-resolution).
Handing it `secretmanager.versions.add`, even scoped to one secret, would add a
fourth credential class to exactly the box the split exists to keep weak.

So the server calls **core**, which already holds the store-admin credential and
already owns a write path that does the hard parts correctly — the base64url
envelope and the per-parameter `secretAccessor` grant. Three routes, each
authenticated with the calling component's own `STRAD_INTERNAL_TOKEN` — the token
core derives for that component, from which core reads who is calling:

```
POST /_strad/params/{slug}/{VARIABLE}   body: { value }   -> rotate
GET  /_strad/params/{slug}/{VARIABLE}                     -> current value
POST /_strad/store/refresh                                -> drop core's reading of the store
```

No new credential, no new IAM, no new encoding path. The third route carries no
path and no value: it is what the `secrets` MCP server's `refresh_gateway` tool
calls (and its write tools call after a write), the agent's copy of the console's
**Re-read the store** button, and core holds it to one re-read per 30 seconds.

This is the **first bundle → core call** in strad; every other authenticated call
runs the other way. So every non-core component now gets `STRAD_CORE_URL`, bound
to `${core.PRIVATE_URL}` by the renderer, alongside the `STRAD_BUNDLE_URL_*`
bindings core has always had for the reverse direction.

The name in the URL is **not trusted**. Core looks the `{slug}`/`{VARIABLE}` pair
up in that server's own `paramsWritable:` list and builds the store path out of
the config's strings; the request's bytes are used for one thing, an equality
test. The server must also be on the **caller's own component**: its `bundle:` has
to name the component whose token was presented. Anything that does not match — an
unknown slug, a disabled server, a variable that is not on the list, a server on
another component — is the same 403, so the route cannot be used to enumerate the
config either. A bearer that is no component's token, the root included, is a
`401`; a core that holds no root answers `503`.

### The boot read is not optional

Without the `GET` there is a window that silently bricks the credential:

1. Container A refreshes at T, persists R2, holds R2.
2. A deploy starts at T+1; `render-spec` reads R2 and bakes it.
3. Container A refreshes again at T+1.5 and persists R3. R2 is now dead.
4. Container B boots with the baked R2 and 401s on its first call.

Reading the writable names from core **at boot** rather than trusting the baked
env removes it. The baked value stays the fallback: if core is unreachable, the
parameter has never been seeded, or the answer is a shape the caller does not
understand, the container uses what the deploy gave it. A core outage degrades
this; it does not break it.

### A failed write is loud

The other direction is the opposite. A `put()` that fails means the **next
restart** comes back holding a dead credential, while everything looks fine right
now — the worst failure available here, because nothing points at when it broke.
So it is never swallowed: the mount is marked **degraded** in the bundle's
`/healthz`, the reason is logged at error, and the server **keeps serving**,
because the in-memory token is still good for the life of this process.

### One writer, enforced at render

A credential that is single-use has exactly one valid value at a time. Two
replicas do not merely race to write it — each refresh **invalidates the other's
token at the upstream**, and no retry recovers it. `renderAppSpec` therefore
refuses to render a component with `instance_count > 1` that hosts a server with
a non-empty `paramsWritable:`.

That refusal is load-bearing: it is what makes a plain write correct instead of
needing a compare-and-set on the parameter version. If a `paramsWritable`
component ever has to scale out, the CAS comes first and the render check is
relaxed after, not the other way round.

### What this grants, stated plainly

The allowlist bounds **which names** are reachable, and the caller's token bounds
**which caller**.

Each component holds its own `STRAD_INTERNAL_TOKEN`, derived from core's root, and
core reads the caller's component off it. So a container reaches the
`paramsWritable:` names of the servers on its own component — plus, for the `GET`
alone, their
[`paramsRefresh:`](#paramsrefresh--a-rotation-that-lands-without-a-deploy) names —
and nothing on any other component. The `GET` is a value read on the public
component, so a component's token is a read credential for its own servers' names
on those lists. The design and what it costs, including the one topology it does
not isolate, are
[limitation #63](/limitations/#63-one-internal-token-means-any-container-can-reach-any-writable-parameter).

What the allowlist bounds is real too. The list is
**opt-in and empty by default** — a name is on it because a human wrote it in the
config. Nothing outside it is reachable at all: not another server's ordinary
parameters, not the gateway namespace, not a secret this deployment has not
deliberately marked as rotating. And every name on it is by construction a
credential that **rotates**, so losing one costs a re-seed rather than a durable
secret.

Against the alternative — a Secret Manager credential on the container answering
`/mcp` — this is a materially smaller grant, and it keeps the property the
three-role split exists for: the box on the public path holds no cloud
credential.

### What it does not do

It is `supplementary-image` only. A `builtin` on the core bundle runs inside
strad's own process and has the resolver in scope already; a builtin on another
bundle has no consumer for this today, and an unused capability on a write path
is not a thing to ship speculatively.

## Store-served instances — a mount credentialed from its own namespace

The two sections below move a **value** behind a name the render already listed.
A store-served instance moves the names too, which is what lets a
`supplementary-image` slug be created at runtime and credentialed without a
deploy.

A server on `path: /_instance/{tree}/{its own slug}` with `params: true` has no
credential on its container. The bundle host:

1. asks core which instances it should run — `GET /_strad/instances?bundle=`,
   answered from core's current config, which a roster write rebuilds;
2. reads each one's own namespace — `GET /_strad/instances/{slug}`, both kinds
   layered, `oauth/` ahead of `static/`, usable values only;
3. builds a `telegram`, `google-sheets` or `grafana` instance from exactly those
   values plus `PATH`, `HOME` and the CA settings — and **no** bare name from the
   container, so a half-seeded instance degrades rather than completing itself
   from a sibling's credential.

It re-syncs every `STRAD_INSTANCE_SYNC_SECONDS` (default 60, floor 15), and on the
first request for an instance it does not hold — at most once per five seconds. A
value that moved rebuilds that instance and releases the one it replaces; an
entry that went away removes it. A list core could not answer, or answered in a
protocol the host does not know, changes nothing: only core answering readably
without an instance removes it.

| What changed                                                             | Reaches the instance                                                                                   |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| A slug created or removed at runtime                                     | on the next request for it, or the next sync                                                           |
| A value seeded or rotated in the console                                 | on the next sync — the console's write drops core's reading at once                                    |
| A value written outside the console — the `secrets` MCP server, `gcloud` | on the next sync after core's reading ages out (within `ttlSeconds`), or right after `refresh_gateway` |

Both routes are core-only, behind the calling component's own
`STRAD_INTERNAL_TOKEN`, and compose the
namespace from the config's own slug rather than the URL's. The env route gives
one answer — `403 instance_not_served` — for an unknown slug, a disabled one and
one that is not an instance, so it is not an oracle for which slugs hold
credentials.

**No new credential and no new IAM.** Core reads the namespace as a slice of the
one snapshot its resolver already holds, and hands the values only to the
component the slug is on: the list answers for the caller's own component, and
the env route refuses a slug on any other with the same `403`. See
[Known limitations](/limitations/) #100.

## `paramsRefresh:` — a rotation that lands without a deploy

A `params: true` supplementary server's credentials are resolved by `render-spec`
and **baked onto its component as environment variables**, and a container's
environment is fixed when it spawns. So rotating one of those credentials in the
store changed nothing until somebody redeployed — the containers went on serving
the value the last render read. That is the one credential path in strad that was
not already live: a gateway `${NAME}`, a `builtin`'s `params:` and an unhosted
server's `${NAME}` all resolve at runtime.

`paramsRefresh:` closes it. It is an allowlist, per server, of variables that
server **re-reads on an interval** while it is running:

```yaml
- slug: strad-fetch
  kind: supplementary-image
  params: true
  paramsRefresh: [BRIGHTDATA_API_KEY]
```

Rotate `BRIGHTDATA_API_KEY` in the console and the running container picks it up
within `gateway.secrets.paramRefreshSeconds` (default 300, floor 30). No deploy,
no restart.

### It is off unless you write it

The list defaults to `[]`, on every server. A deployment that does not name a
variable here behaves exactly as it did — the renderer emits no manifest, the
container starts no loop, and nothing makes a single extra read. This is
deliberate: a change in secret resolution touches every slug on the deployment,
and prod runs more than forty of them.

It requires `params: true`, for the same reason `paramsWritable:` does and for
one more. That flag is what makes `/strad/{env}/mcp/{slug}/` this server's
environment at all, so re-reading a namespace nothing injects would keep a value
current that nothing reads. And because `params: true` already bakes that whole
namespace onto this component at render time, **the read discloses nothing new**:
the container is already holding these values. What the read adds is freshness.

It reads through the same kind rule as the write. A name the server also declares
on its `oauth:` connector is re-read from `oauth/` when the store holds a usable
value there, and from `static/` otherwise. Every other name is re-read from
`static/`. So a refresh never swaps a consented credential for a stale hand-typed
copy, and a client secret seeded under `static/` still refreshes.

### How it travels

The container never sees strad's config. `renderAppSpec` therefore bakes the
names onto the component as `STRAD_PARAM_REFRESH` (a `{slug: [NAME]}` map) and
`STRAD_PARAM_REFRESH_SECONDS`, both **`GENERAL`, not `SECRET`** — they hold
variable names, and those are already in the store, in the console and in the
spec beside them.

The read itself goes over the route that already existed for
[`paramsWritable:`](#paramswritable--a-credential-that-rotates-on-use):
`GET /_strad/params/{slug}/{VARIABLE}` on **core**, which is the component
holding the store-admin credential. No new credential reaches the container, and
no new IAM is involved. Core still composes the store path out of the config's
own slug and the config's own variable name — the request's bytes are used for an
equality test and nothing else — so a name no config listed is a 403 even when it
sits in a namespace this very component already holds baked.

### A listed name may not be a sibling's variable

One bundle is one container with one environment. A refreshable name that another
server on the same bundle already owns would have that server's credential
overwritten — and, unlike an ordinary config collision, it would happen when a
human seeds the value in the console rather than when anything deploys, which is
the hardest kind of change to correlate with a symptom. `renderAppSpec` refuses
that config outright, and it refuses it whether or not the name is seeded yet:
the check reads the names the CONFIG declares, not the ones the render happened
to resolve.

A server shadowing its own `env:` key with its own refreshable name is not a
collision. That is the documented migration path off a hand-written `${REF}`, and
it stays a deliberate single-server override.

### A listed name that is not seeded yet

It stays on the list, and that is useful rather than an oversight. The render
bakes nothing for it (there is no value to bake), the container comes up without
it, and the first poll after somebody seeds the value is what puts it on the box.
So `paramsRefresh:` covers **seeding a credential after the deploy** as well as
rotating one — which is the half of
[`mayBeUnseeded:`](#maybeunseeded--deploying-a-server-ahead-of-its-credential)
that otherwise still needed a redeploy.

### Why it polls instead of resolving per request

A `builtin`'s `params:` resolves on the tool-call path behind a TTL cache. That
would be the obvious thing to copy here and it is the wrong shape: a request-path
read costs whatever the traffic costs, and Parameter Manager rate limits are not
hypothetical — a 429 from it failed three consecutive production deploys. A poll
costs **one read per listed variable per component per interval**, which is a
constant you can multiply out before you turn it on. `paramRefreshSeconds` has a
floor of 30 in the schema, and the container clamps the environment variable to
the same floor independently, so a spec written by something other than this
renderer cannot talk a container down to one second.

### What it cannot do: make an upstream re-read

The refresh puts the current value in the container's environment. Whether the
**mount** then uses it is a property of that upstream, not of strad.

`strad-fetch` builds its scraping clients from `process.env` inside a factory the
bundle host invokes per request, so a rotated key is used by the next call. A
server that snapshots its credential at mount time and memoises a connection —
telegram's MTProto session, a Grafana client, X's OAuth provider — does not, and
goes on using the boot value until the container restarts.

The bundle host says so rather than leaving it silent: it logs, per opted-in slug
at boot, whether that mount is known to read its credential per call. Point
`paramsRefresh:` at a slug whose mount does not, and you get a warning naming the
variables and saying the value will be current in the environment and possibly
unused. See [limitation #71](/limitations/#71-a-refreshed-parameter-only-reaches-an-upstream-that-re-reads-its-environment).

### What it grants

The same reach `paramsWritable:` has, and no more. A container presents its own
component's token, so it can read the `paramsRefresh:` names of the servers on
that component and nothing else — every one of them a value already baked onto
that same component. The design is recorded as
[limitation #63](/limitations/#63-one-internal-token-means-any-container-can-reach-any-writable-parameter).

## `oauthRefresh:` — a rotating refresh token on a `remote-http` server

A `remote-http` server with
[`oauthRefresh:`](/servers/interface/#oauthrefresh--a-bearer-that-expires-minted-by-strad)
is proxied by **core**, and core mints its upstream access tokens from the
refresh token `${NAME}` the block names. Some providers rotate that refresh
token on every use, which is the same trap `paramsWritable:` exists for — except
there is no bundle to call a route: the process that just spent the token is the
one holding the store-admin credential. So the write is the route with the HTTP
taken out (`createParameterWriteBack` in `src/http/params.ts`): the same
`storeForPath`, the same `rotate()`, the same invalidation of the process's
reading, the same `strad.param_written` / `strad.param_write_failed` events.

**It writes where the reader reads.** A server's `${NAME}` resolves from
`/strad/{env}/mcp/{slug}/oauth/` first, `/strad/{env}/mcp/{slug}/static/` second
and `/strad/{env}/gateway/static/` third, so the write follows the same order and
stops at the first parameter that exists, moving on only after a definite 404.
`oauth/` is where the console's Connect stores the token it minted, so a rotation
of that token lands there; a token seeded by hand under `static/` is rotated
there. A parameter that could not be checked stops the walk, because writing a
lower layer while a higher one may still hold the value would persist a token
nothing reads. The rotated value is held in memory for the life of the process
either way; what the write buys is the next restart.

**It reads before it writes.** Between the exchange that rotated the token and
the write, a human can re-seed the slug with another account's token in
`/ui/secrets`. A blind write after that would put the old account's rotation on
top of the new seed, and the slug would serve the old account again with nothing
failing — the credential-shaped silence this whole design is built against. So
the write-back reveals the parameter first and writes only if the value held is
one this minter's lineage produced (the seed, or a rotation it was handed);
otherwise it refuses, `strad.param_write_failed` fires, and the seed stands.
That shrinks the window to the gap between two store calls; there is no
compare-and-set on the store to close it.

**Seed the parameter first, in one of those two places.** A refresh token that
resolves from the environment — `envFallback` under the store provider, or
`gateway.secrets.provider: env` — cannot be written back. Every rotation is
refused on stderr and as `strad.param_write_failed`, the rotation is held in
memory, and a restart reads the seeded value, which the provider has already
killed. That is
[limitation #91](/limitations/#91-a-rotated-refresh-token-with-nowhere-to-land-dies-at-the-next-restart).

**One writer, mostly.** Two enabled servers minting from one `${NAME}` are
refused by the config schema, so a name in the gateway namespace is still one
server's refresh token, and core runs as one instance (`instance_count: 1`,
`src/deploy/appspec.ts`). What that does not cover is a rolling deploy: App
Platform keeps the old core serving until the new one is healthy, and for that
window two processes hold a minter for the slug. With a provider that rotates on
use, whichever spends the token second is refused and re-reads the store within
`ttlSeconds`; with a provider that revokes the whole token family on reuse, the
slug is dead until a human authorizes again. Same window `paramsWritable:` has,
recorded in the same limitation.

**The first token comes from Connect.** The slug's console page runs the
authorization against the upstream — discovery, a registered client, code +
PKCE — and writes the refresh token (and the token URL, client id and resource,
where those are `${NAME}`s) under the slug's **`oauth` kind**, then drops this
process's cached reading, so the next request is served with no redeploy. A
`mayBeUnseeded:` entry for each name lets the slug deploy ahead of it. Seeding the
token by hand in `/ui/secrets` still works and is rotated where it was seeded. See
[Connectors](/operate/connectors/#remote-http-with-oauthrefresh-connect-an-upstream-mcp-server).

A slug with `oauthRefresh.discoveryProxy:` has Connect read one more value, and
only when a metadata document answered strad `403`: `BRIGHTDATA_API_KEY`, from
the `apiKeyFrom` slug's own `oauth/` then `static/` namespace, through the
console's admin credential. On prod that is the key `strad-fetch` already holds,
so there is nothing new to seed. It is read at Connect time and never put on any
server's environment, so it adds nothing to the deploy gate. See
[Connectors](/operate/connectors/#blocked-metadata-paste-it-or-proxy-it).

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

## The connectors roster: every server, and whether its secrets are there

`/connectors` is the console's one view of the servers, and it answers three
questions about the same list: what is each server scoped to, **is the strad side
of this connector broken?**, and — where the roster is editable — what do I change
about it.

They live on one page because nobody wants any of them in isolation: the second is
asked _about_ a server, standing in front of the list of servers, and the third is
what you do having read the second. So the answer is on the entry rather than one
navigation away. `/ui` and `/secrets` are both 302s to `/connectors` — both URLs
were published, and a page whose content moved teaches nobody anything by 404ing.

**The roster does not depend on `gateway.configStore:`.** A deployment that keeps
its roster in the checked-in document still gets every row and every badge, with
the popout behind each; what it loses is the editor controls, and the page says
which of the two it is. See [the console
flow](/operate/runtime-config/#the-console-flow) for the editing half.

The preflight above is honest but late. A `${NAME}` that is not seeded is
discoverable at exactly one moment — the deploy, when `render-spec` refuses to
render — and that is no help at all to someone standing in front of a connector
returning 401 and wondering whose fault it is. This page derives the same answer
from the running config, before and independently of any deploy.

It is a **roster**, not an error log. Every server is on it, healthy ones
included, because "slack is fine, gmail is not" is the answer and a page listing
only failures cannot give it.

It is behind `requireConsoleUi`, the same gate as `/console`.

### Four badges, and where they sit

Every enabled entry carries exactly one of four badges, in a column of its own, so
that on a 35-row roster the one thing that varies from line to line is in the same
place every time. Most servers declare no `title:`, so the name _is_ the slug and
printing it again beside itself was pure duplication; where a `title:` does
differ, the slug still renders beside the name, because there it is information
rather than an echo.

| Badge        | What it claims                                                                                                                                            |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `READY`      | Everything this server needs was **observed** to be present, or it needs nothing at all. **Not** a claim the credential works.                            |
| `ISSUE`      | Something is **known to be wrong**: not seeded, a parameter that will not render, or a placeholder. The only badge the header's "issues" counts.          |
| `INACTIVE`   | Short only of names the config lists under `mayBeUnseeded:`, so it was deployed inactive on purpose. A plan halfway through, not a fault.                 |
| `UNVERIFIED` | This page could not establish the answer either way: the value is somewhere core cannot read and nothing that can read it answered, or the store did not. |

Every badge with something behind it is a real `<button>` bound to a per-entry
`<dialog>`, so it is keyboard-reachable and announced as a control. Without
JavaScript the buttons hide and every panel renders inline at the foot of the page.

**"Could not be checked" is neither green nor red, deliberately.** `READY` has to
mean observed, or a total store outage renders a fleet of reassuring badges over an
unusable gateway. And `ISSUE` has to mean broken, or the headline count is the
number of servers this page could not see: prod's roster once read 29 issues, most
of them serving. So `UNVERIFIED` gets a grey, dashed chip and a count of its own,
and stays out of the issue count. `INACTIVE` is blue for the same reason — it is
parked, not broken — and keeps its own group so a deferral stays on the page until
somebody seeds it.

One mapping decides all of this, `badgeFor` in `src/ui/secret-status.ts`, and
the roster, the per-server overview and
[`/api/secrets/readiness`](#get-apisecretsreadiness--the-same-answer-for-a-machine)
all bucket by it.

### Grouping and ordering

Five headings, worst first: **needs attention** (`ISSUE`), **inactive**,
**unverified**, **ready**, then **disabled**, each with its count. The entries something has to be done about are
why anyone opens this page, and sorting the greens to the top is what puts exactly
the wrong rows below the fold on a 35-entry roster.

Within each group, servers with a dedicated console view come before servers that
only have the overview, and config order breaks the remaining ties. A disabled
server carries no badge at all — strad does not mount it, so it needs no secrets,
and a green would be a claim about a server that answers nothing.

The grouping is a **partition**, and the code derives both it and the sort from
one function (`groupOf` in `src/ui/roster-page.ts`). A partition with a hole does
not render a row out of place, it drops the row off the page while the counts
above it keep claiming it is there — so an enabled entry nothing derived a status
for lands under **needs attention**, which is what "nothing was established" means
everywhere else here.

### Which servers have a console view

**Every row links to `/ui/<slug>`**, its name and its call to action both, and
every slug answers there. These per-server pages did **not** move when the roster
did: `/ui/:server` is unchanged, and so is `/ui/oauth/callback`, which Google
holds as a registered redirect URI. The redirect on `/ui` is exact-path for
exactly that reason. What the page is depends on what the **config
declares**, not on the slug, asked in this order:

| The server declares                                                | `/ui/<slug>` is                          | The row says |
| ------------------------------------------------------------------ | ---------------------------------------- | ------------ |
| `oauth:`, and is enabled                                           | the [Connect page](/operate/connectors/) | `Manage →`   |
| `SECRETS_PROJECT_ID`                                               | the parameter store for that project     | `Manage →`   |
| `GCS_BUCKET`, `GCS_SERVICE_ACCOUNT_KEY_JSON` or `GCS_CLIENT_EMAIL` | the object browser for that bucket       | `Browse →`   |
| none of these                                                      | a read-only overview                     | `Details →`  |

The overview is what every other kind gets until it has a view of its own: the
kind, the slug, whether it is enabled, its bundle and path or its upstream host
(the host only, never the URL's path), the same badge and summary the roster
draws, its MCP URL, and links to its playground and — where there is a runtime
roster to edit — its entry in the connectors editor. It shows declared, non-credential config and nothing else, and it has no
form on it.

A disabled `oauth:` server is not answered as a connector — the console answers a
connector only while it is enabled — so it gets whatever the rest of its config
declares: the parameter store or the bucket browser if it declares one, the
overview otherwise. A server that somehow declared both a parameters project and a
bucket gets the parameter store.

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

The roster link and the page are **one decision**: `serverLooksGcs` and
`serverLooksSecrets` in `src/ui/resolve.ts` are the same predicates
`resolveServerView` branches on. A detector that could read the config more
narrowly than its resolver is how you get a working page nothing links to, so
there is only the one reading.

The row's playground icon is the second instance of that shape, failing the
other way round: it is offered through `playgroundAccess()` in
`src/ui/playground.ts`, the same function the playground page decides on. A
detector WIDER than its resolver is how you get an icon that lands on a `424`.
See [the console playground](/auth/overview/#the-console-playground).

### The seven states behind the badges

The popout names which of these it is, because "not seeded", "cannot render" and
"could not be checked" want three different responses.

| State                 | Badge        | What it means                                                                                                                       |
| --------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `ready`               | `READY`      | Everything this server needs was observed to be present. **Not** a claim the credential works — see below.                          |
| `no secrets`          | `READY`      | The server declares no references at all. Nothing to seed.                                                                          |
| `not seeded`          | `ISSUE`      | Nothing has a value for it, and something that would know said so. The one unambiguous state, and the one the fix guidance is for.  |
| `cannot render`       | `ISSUE`      | The parameter **exists** and its value cannot be produced. Neither absent nor healthy: creating it again fails with 409. Rotate it. |
| `check value`         | `ISSUE`      | A value exists and is evidently filler — an unexpanded `${...}`, a well-known "change-me" string, an empty string.                  |
| `awaiting credential` | `INACTIVE`   | Not seeded yet, and the server listed the name under `mayBeUnseeded:`, so it was deployed inactive on purpose.                      |
| `unverified`          | `UNVERIFIED` | The value is somewhere core cannot read, and nothing that can read it answered. The row says why.                                   |
| `unknown`             | `UNVERIFIED` | The secret backend could not be consulted. Not absent.                                                                              |

#### Not in the store is not the same as not seeded

On a store-backed deployment, a `${NAME}` that only a supplementary image's `env:`
uses is baked onto that component at deploy time, and `render-spec` reads it as
`available[name] ?? process.env[name]`: the store first, then the deploy
environment, which the deploy workflow fills from `strad-<env>-*` in Secret
Manager. A deployment midway through moving its `env:` names into the store keeps
the rest there, and core cannot see them. So when the store does not hold such a
name and the bundle did not answer the presence probe, the row reads `not checked`
and the server `UNVERIFIED`, not `not seeded`: the render refuses a missing value,
so it had one at the last successful deploy. Prod's roster once called twenty
working servers `not seeded` on exactly this shape.

Two exceptions keep it `not seeded`, because the reasoning is false about them: a
name the server waived (`mayBeUnseeded:`), which the render omits rather than
refuses, and a store-served instance, which is served from the store and never
from a deploy. And when the bundle **does** answer and does not hold the key, that
is a real absence on the container, and it stays `not seeded` whatever the store
says.

Both badges open. A `READY` entry carries a positive claim — which secret, from
which source, established by which process — and that is usually what somebody
came to the page for. Only a server with no secrets at all has nothing behind its
badge.

**No badge is ever a control that does nothing.** The button and the `<dialog>`
are rendered by two different pieces of `src/ui/roster-page.ts`, and they ask one
predicate — `hasFixDialog()` — rather than each deciding for itself. It is
derived from what the popout will actually render, requirement rows or an
unobservable scope, so the two cannot disagree about a state neither anticipated,
and **both** badge colours consult it. One predicate rather than two is the whole
of the guarantee: a button whose `data-fix-open` names an id nobody emitted is a
click into silence, which is what a badge over an empty panel degrades to. See
[limitation #35](/limitations/) for the shape that hit it in production.

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

### The diagnosis is answered from the process's reading of the store, and says how old it is

Those two questions are not free. `resolveDetailed()` renders every parameter
rather than stopping at the first failure, so a namespace-wide refusal costs a
full pass — bounded at a fan-out of ten, so N/10 round trips. Performed against
the store per request, that would make a caller polling `/api/secrets/readiness`
hard an amplifier against Parameter Manager, and a reloaded console a smaller
one.

It is not performed against the store. The diagnosis reads through the **same
store client the gateway resolves `${NAME}` through**, and that client holds
[one reading of the store per process](#one-reading-of-the-store-per-process)
for `gateway.secrets.ttlSeconds`. Inside the TTL the pair of reads is memory. The
pass's result is additionally held for up to a minute, so a hard poller does
not re-slice it per request, and so a store that is _down_ — a reading that has
aged out and cannot be replaced — costs one attempted pass per backoff rather
than one per request. Concurrent callers share one pass, and the pass keeps the
six-second deadline it always had — nothing here can make a slow store hang a
page that would otherwise have degraded.

What that costs is freshness, so the age is printed rather than hidden — and
the age printed is the age of the **reading**, not of the pass:

- the console footnote says when the store was read, and how long the pass is
  reused for;
- `/api/secrets/readiness` carries `store.diagnosis.ageSeconds` alongside
  `indexRead` and `renderRead`.

A value written by something other than this console can therefore take up to
`ttlSeconds` to change a row — the same bound the running gateway's own `${NAME}`
reads carry — and a store that breaks can look healthy for that long. A write
**through the console** is not in that window: `create`, `rotate` and `delete`
drop the reading and the pass outright, so the row a rotation was performed from
is correct on the next page load. The **Re-read the store** button and the
`secrets` MCP server's `refresh_gateway` tool do the same with no write.

A pass whose index or render half did **not** answer is held for five seconds
only (or the TTL, if that is shorter). Holding a shrug for a full minute would
extend an outage past its end; re-reading it per request would leave a broken
store getting hammered by exactly the poller this exists to bound. A
namespace-wide render **refusal** is not that case — the store answered,
completely, from the expensive pass — and it is held for the whole TTL.

**Seeded is not working, and the page does not pretend otherwise.** strad never
calls an upstream to prove a credential is accepted, so the good state is `ready`
— "everything it needs is present" — and never "healthy". This is not a
hypothetical distinction: a `remote-http` server carrying a placeholder bearer
token boots fine, lists every other server fine, and 401s in isolation. A page
that reported presence alone would call that healthy. The `check value` state
exists for exactly that shape.

**Not checked is not missing — so the component is asked.** The console
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

### The headline counts what is broken

The header shows `ready` and `issues`, plus `inactive` and `unverified` when either
is not zero. `issues` counts the `ISSUE` badge and nothing else. The banner reads
"N servers need attention" when there is an issue, then names the inactive and
unverified ones after it as what they are. With no issue it reads "Nothing is
known to be broken", followed by the same counts, and only an all-`READY` roster
gets "Every server is READY". A green headline over a page of `unknown` rows would
be the page lying in the one place everybody reads, so a store outage lands on
"nothing is known to be broken", never on the green line.

### A `params: true` server is graded on its managed parameters

A server that opts into parameter resolution takes its credentials from
`/strad/<env>/mcp/<slug>/static/*` rather than from `${NAME}` references. The
config therefore does not name them, and core cannot enumerate them — so unaided
the console can only say `unverified`, "this page does not read that namespace",
about the servers least likely to be checked by anything else.
`remote-filesystem-tmp-public` in `infra/strad.staging.yaml` is exactly that
shape.

`render-spec` knows the names, because it resolved them. `appspec.ts` bakes them
onto the component as `STRAD_PARAM_KEYS`, a **GENERAL** (not `SECRET`) env var
holding `{"<slug>": ["VARIABLE", ...]}` — names only, and names are what the
console prints anyway. The component reports presence for each one on the
presence route, and the server is graded on them like anything else.

Where the component **did not answer at all** — unreachable, an image that
predates the presence route, or no private URL bound — core asks the **store**
instead. So does a `params: true` builtin or a store-served instance, which read
the store at runtime anyway. Its resolver already holds a snapshot of the whole
store, so each of the server's own namespaces (`oauth/` then `static/`) is a
slice of a roster it already enumerated, and the render is memoised per snapshot.
The cost is that core now renders every managed parameter of those servers once
per snapshot (`ttlSeconds`), and holds the rendered values in that snapshot as it
already does for the gateway namespace. Only names reach the page. A parameter
that renders reads `plumbed`, with a detail saying it came from the store and
reaches a supplementary image's container at the next deploy. One the store
refuses reads `cannot render`. A partial reading, a transient failure (a 429, a
5xx, a timeout), or namespaces that hold nothing leave the `unverified` sentence
standing. An empty namespace cannot tell "nobody seeded it" from "a connector
consent that has not happened", so it claims neither.

A component that **answered** and named nothing for the slug keeps its word: it
has said its container holds none of them, and a value seeded since the last
deploy does not make that a green. The `unverified` sentence stands there too,
with the reason the component gave.

**It stands whatever else the server declares**, and that is the point. The
managed namespace is a requirement of its own, ranked `unobservable` — above
`present`, below every piece of bad news — so an unchecked one demotes a green
and never overwrites a red. Grading the entry on the `${NAME}` references it
happens to declare BESIDE its parameters hands it a `READY` for having checked a
part rather than the whole, with the credentials it takes from the store checked
by nothing. That is worse than saying nothing: a reader investigates an
`UNVERIFIED` badge and nobody investigates a green one. `echo` in `infra/strad.staging.yaml`
is that shape — `params: true` and one `${STRAD_ENV}` in its `options:` — and it
reads `unverified`.

The sentence the console prints is careful about which claim it is making. A
resolved `${NAME}` **is** part of what the server runs on: `optionsFor` merges a
builtin's parameters _over_ its resolved `options:`, and a supplementary image's
`env:` is injected beside its parameters. So the entry says those names are not
_all_ of what it needs, never that they are irrelevant — and the popout's first
line says the same ("the references below resolve, but they are not everything
this server needs"), rather than the `unverified` headline's "this page could not
check this server's credentials" over rows that were.

An entry that declares nothing else has **zero requirement rows**, and it is the
one the console can say the least about. Its popout is built from the probe
outcome rather than from a row. It is ordered for the reader who came to act: a
chip naming the state, then **numbered steps** (the first is the one to take
first; for most reasons it is "open this prefix in the parameters console",
which answers the question the page could not), then **where the values live** and when a write there takes effect,
and last, folded into a `<details>`, **why** the page could not check. The
mechanism is true and kept; it is just not the first thing anyone needs. The
panel answers these questions:

| The panel says                 | Where it comes from                                                                                                                       |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **which component** holds it   | the server's `bundle:`. `core` when the process that _would_ resolve them is this one, which is a builtin and nothing else.               |
| **why this page cannot check** | the probe outcome for a supplementary image; for a builtin, which process does the resolving. Nine reasons (below).                       |
| **where the values live**      | the store, the project, and `/strad/<env>/mcp/<slug>/static/*` — with a link straight into the parameters console at that prefix.         |
| **when a write takes effect**  | a deploy for a supplementary image, whose environment is baked at render time; `gateway.secrets.ttlSeconds` for a builtin, which is read. |

The reasons, which want different responses. Five are **probe outcomes** from a `supplementary-image` — three about the component, two about what it said:

| Reason         | The probe outcome                                                                                                                                                                                       | What closes it                                                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `unwired`      | no `${<bundle>.PRIVATE_URL}` bound, so nothing was asked                                                                                                                                                | redeploy through the deploy workflow, whose render binds it                                                              |
| `unsupported`  | the component answered `404` or `405` — an image predating the presence route                                                                                                                           | rebuild and repin that component's image                                                                                 |
| `unreachable`  | it did not answer, or refused. Not always an outage: a `401`/`403` is the component not holding the token core derives for it — rendered from a different root, or from none — and the panel says which | chase the component itself first — one core cannot talk to is not answering core's requests either                       |
| `unmanifested` | it answered and named no managed parameters for this slug at all — no entry, not an empty list                                                                                                          | redeploy that component; its `STRAD_PARAM_KEYS` predates this slug's `params: true`, and it says nothing about the store |
| `silent`       | it manifested its parameters and listed none under this slug                                                                                                                                            | seed the namespace — the last render found nothing beneath it                                                            |

The last two look alike and want opposite first moves, which is why they are two. Telling an operator to seed a value on the strength of a stale manifest is how a working credential gets rewritten.

The other three are about a `params: true` **builtin**, where nothing was probed because there was nothing to probe. A builtin has no container: `optionsFor` (`src/gateway/registry.ts`) merges everything under its static namespace over its resolved `options:` on every tool call, out of the resolver's own snapshot of the store. So the question is not which container went unasked but which process does the resolving — and the answer to "when does a write take effect" is a TTL rather than a deploy:

| Reason       | What is true instead                                                                                                                                                                                                                        | What closes it                                                                                                                                                                                                  |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `in-process` | `bundle: core` and this deployment holds a resolver credential. **This** process resolves them, per tool call, within `gateway.secrets.ttlSeconds`                                                                                          | nothing — the value lands within the TTL, or on the very next tool call when the write went through this console, which drops the snapshot. The page just never read it                                         |
| `delegated`  | the builtin is mounted in another component, which runs the strad image in bundle mode and resolves them there with its own resolver. Core proxies the call and never holds the values                                                      | likewise nothing, and likewise within the TTL — on that component. Where core holds no credential the panel says that instead: the app spec gives that component core's, so a write most likely reaches nothing |
| `inert`      | no _usable_ `STRAD_PARAMS_*` credential — unset, or a key JSON the resolver cannot parse — so `Registry.build` gets a null resolver, skips the merge outright, and the server runs on its `options:` alone. The panel says which of the two | fix the credential. **Do not seed first** — nothing reads the namespace until it works                                                                                                                          |

`inert` reproduces `resolverFromEnv`'s three exits rather than approximating them, because a key JSON that is set and unparseable resolves exactly as much as an absent one — nothing — and "set the variables" is the wrong instruction for a deployment that has set them. It is keyed off the credential and not off `gateway.secrets.provider`, because the registry keys off it that way: `params:` resolution is wired to `STRAD_PARAMS_*` rather than to the provider flip, so a `provider: env` deployment that sets the credential does resolve a builtin's parameters. That is why staging's `echo` was a usable rotation observatory before the flip.

A builtin is never probed and cannot be. `expectedKeys` (`src/gateway/bundle-presence.ts`) enumerates only the bundles holding supplementary images, and a bundle may not hold both kinds — so `core` is asked nothing, and a `delegated` builtin's component is asked nothing either.

On a server that declares `${NAME}` references too, the panel renders **below**
those rows. The rows are about names this server references; the panel is about
the credentials it runs on, and they are different questions — the rows cannot
answer the second one, which is precisely why the entry is not `READY`.

The two families share a shape and almost no vocabulary, which is why a builtin takes three more reasons rather than a widened predicate. Every line of the panel is per-reason, including the ones that read like boilerplate: the chip ("not checked"), and steps that say "rebuild the image and bump its pin" or "redeploy the component", are all false about a builtin core mounts, whose values this process does hold. `delegated` is the exception that proves the split — its values are genuinely elsewhere, so it keeps the container chip and takes the builtin's account of when a write lands. A confidently wrong panel is worse than an inert badge, which is why a builtin got no panel at all before [#264](https://github.com/tadasant/strad/issues/264) and its badge degraded to inert text instead.

The panel is still not a green. Nothing here was observed, the state stays
`unverified`, and the badge stays `UNVERIFIED` — the change is that the badge now
leads somewhere. That holds for a builtin too: `in-process` says the parameters
resolve somewhere this page cannot see, not that they resolve.

#### A name declared twice is two claims, and both are ranked

Nothing stops a `params: true` server from declaring `${FOO}` in its `env:` while
its component manifests a managed parameter also called `FOO` — naming a managed
parameter after the credential the config already references is the natural thing
to write, and neither the schema nor `config:check` says a word about it.

Those are two observations about two different things. The `${NAME}` row says
this deployment can **resolve** a value for that reference out of the gateway
namespace. The managed-parameter row says whether the **running container** holds
a variable of that name, as the component itself reported it. So the entry
carries **both rows**, and the same worst-first ranking that grades everything
else decides the badge. The store resolving `${FOO}` does not outrank a
component saying it holds no `FOO`: a green earned by discarding the
contradicting evidence is the false green this whole page exists to avoid. The
reverse holds too — a container holding `FOO` does not cover for a reference that
does not resolve.

There is deliberately **no precedence** between them. Either direction would have
to throw away a live observation, and whichever way it pointed it would buy a
false green in that direction. Ranking both is the only reading under which no
source's bad news is thrown away.

The popout tells them apart: a reference renders as `${FOO}`, and a managed
parameter renders as the variable it is — `FOO`, with a `managed parameter` chip
— because their remediation is different and offering the wrong one sends a
reader to create a resource that changes nothing about the row they are looking
at. The count follows the same logic: a colliding name is **two** requirements
and not one written twice, because there are two values to seed at two paths, so
an entry reads "1 of 2 required secrets not seeded: FOO (managed parameter)"
rather than the bare "FOO, FOO" that would read as the page repeating itself.

Two things a colliding name does **not** get. A `mayBeUnseeded:` waiver is a
statement about a `${NAME}` — the schema validates it against the names a server
references — so it never covers the managed row beside it, and a server whose
only outstanding credential is a manifested parameter stays `missing` rather than
being relabelled the deferral it is not. And in `/api/secrets/readiness` the two
entries carry the same `name`, so the managed one is marked `"managed": true` and
routed to its own namespace; see below.

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
`test/vendored.sync.test.ts` fails CI on drift) so that `change-me` reads as
filler whichever process holds it.

**One route, not two that agree.** That module carries both ends: the vocabulary
and `presenceResponse`, the handler that authorizes, parses and answers. Each
component keeps only the three-line express adapter over it — core in
`STRAD_MODE=bundle`, and the host image, which is what a bundle of
`supplementary-image` servers actually runs. The wiring is part of the seam
rather than each tree's own because the tree that serves it in production is the
one a second copy would rot in unwatched, and two things it decides are
load-bearing: authorization runs before parsing, so a `401` says the same thing
whatever the body was, and an answer carries `cache-control: no-store` — a
cached `absent` is exactly what would keep a fixed connector looking broken on
this page.

**It cannot be turned into an oracle.** The key roster core sends is derived from
the config core is running, plus whatever the component itself reports under
`STRAD_PARAM_KEYS`. There is no path from a request parameter — on `/connectors` or on
`/api/secrets/readiness` — to a probed name, so no caller can ask strad whether a
name of its choosing exists. The defence is structural rather than a filter.

**Authentication is the component's own `STRAD_INTERNAL_TOKEN`**, the same
credential core presents to proxy `/mcp` to that component. Core derives it from
its root for that component alone, so another component's token, or the root,
gets a `401`. It is strictly stronger than this surface, so mounting the route
widens nothing. With no token configured the
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

A `not seeded` or `check value` popout names, per route: the store, the exact
resource name or canonical path, a paste-ready `gcloud` command, and the GCP project
— except on the `strad-<env>-*` route, whose project is not a fact this process holds,
for the reason set out further down this section. The
route offered **first** is decided by what the deployment declares, because the two
are not interchangeable:

- `provider: env` → GCP Secret Manager, `strad-<env>-<NAME>`, then redeploy.
- `provider: gcp-parameter-store` → the referencing server's own
  `/strad/<env>/mcp/<slug>/static/<NAME>` **first**, then
  `/strad/<env>/gateway/static/<NAME>`, each with a link straight to the
  parameters console that can write it.

The server's own namespace leads because that is where a credential belonging to
one server goes, and because it resolves without a redeploy. Where a name is
referenced by several servers the row says so: a value under one of them covers
that slug alone, and the rest still fall back to the shared namespace.

On an `env` deployment the order is reversed and the per-server route is dropped
entirely — there is no store in that read path. A `params: true` server's own
namespace is still listed there, **last, and labelled as not a fix for that row**:
a managed parameter does not resolve a `${NAME}` reference on a deployment that
resolves references from the environment. Moving a credential there is a config
change (drop the `${NAME}` entry from that server's `env:`), not a value you can
add to unblock the current deploy.

**The project is a question about the PATH, not about the deployment.** Each route
above names a different parameter path, and on a deployment whose
[`consoleStores:`](#one-console-page-many-stores) partition the namespaces between
projects those paths can live in different ones — so the project printed beside a
route is the project of the store whose `namespaces:` **cover** that route's path.
It is the same **namespace test** `storeForPath` applies to a write, over stores
flattened across both dimensions (several secrets slugs, several stores per
slug), so the index reads the same declarations the page that writes to it reads.
The two are not one function and do not answer identically — `storeForPath` falls
back to a lone candidate that covers nothing, where this falls back to the
deployment default. Falling back here costs a less specific answer; there it
costs a refused write.

Where the namespaces decide nothing the deployment's default answers instead: the
resolver's own `STRAD_PARAMS_PROJECT_ID` if this process holds one, else the
`secrets` server's declared `SECRETS_PROJECT_ID`, else its first declared store,
else the `strad-secrets-<env>` convention. The convention is last because a
deployment that named its project something else would otherwise be handed a
command that fails; when it _is_ a guess, the page says so. Three cases fall back
this way, and none of them states one of two answers confidently: no store
declares a namespace at all, the path lies outside every declared namespace, or
two stores in different projects both claim it — the ambiguity `storeForPath`
refuses outright for a write.

**A `strad-<env>-<NAME>` Secret Manager route names no project at all**, and that
is the honest answer rather than a missing one. It is not a parameter path, so no
namespace covers it and there is no per-path answer to give — and the deployment
default is not an answer either: it is the **parameter store's** project, while
the deploy workflow reads `strad-<env>-*` from its own `GCP_PROJECT_ID`, which
`infra/strad.staging.yaml` instructs should be a different project so that the
store's viewer and admin cannot reach strad's own secrets. That project is a
deploy-environment fact the running gateway holds nothing about, so the route
says which project to look for and the recipe leaves it to you:

```sh
# Set this to the project your deploy reads strad-staging-* from — the
# deploy workflow's GCP_PROJECT_ID, NOT this deployment's parameter store.
export DEPLOY_SECRETS_PROJECT=…
gcloud secrets create strad-staging-SLACK_BOT_TOKEN --project "$DEPLOY_SECRETS_PROJECT" --replication-policy automatic
printf %s "$VALUE" | gcloud secrets versions add strad-staging-SLACK_BOT_TOKEN --project "$DEPLOY_SECRETS_PROJECT" --data-file=-
```

The variable rather than a dropped `--project` is deliberate. A variable nobody
filled in is not a project id — unset it expands to empty, pasted whole it is
still the `…` placeholder — and `gcloud` refuses either, so a blind paste writes
nothing; a dropped flag would fall through to whatever `gcloud config` has
set, and for an operator who has been working in the parameter store that is the
one project this exists to stop writing to — and it would succeed. This route was
the only one on the page that could put a credential somewhere plausible and
wrong without saying so.

**A covering namespace outranks the resolver's own `STRAD_PARAMS_PROJECT_ID`,**
which is one store among several on a partitioned deployment and simply the wrong
project for a path another store owns. Where the two disagree about a namespace
the gateway resolves `${NAME}` references from, the resolver is the one telling
the truth about what gets READ — a console store declaring a namespace in a
project the resolver does not read would send a human to create a value nothing
resolves. Nothing checks that they agree, and `check-config` structurally cannot:
which project the resolver holds is a deploy-environment fact, not a config one.

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
`READY` means anything. That one is a roster rather than a value, so the panel
links to [`/tokens`](/auth/overview/#managing-tokens-the-tokens-console), which
says which credentials are live and mints or revokes one. Only
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
    "detail": "gateway.secrets.provider is \"env\": …",
    "diagnosis": { "ageSeconds": 12, "indexRead": true, "renderRead": true }
  },
  "servers": {
    "total": 12,
    "ready": 8,
    "issues": 2,
    "inactive": 0,
    "unverified": 2,
    "states": {
      "ready": 5,
      "no-secrets": 3,
      "missing": 1,
      "unconfigured": 0,
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
  "inactive": [],
  "unverified": [
    {
      "slug": "remote-filesystem-tmp-public",
      "state": "unverified",
      "summary": "Its credentials are managed parameters under …",
      "secrets": []
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

A secret entry carries `"managed": true` when it is a **managed parameter**
rather than a `${NAME}` reference. Its `path` is then its server's static
namespace (`/strad/<env>/mcp/<slug>/static/<NAME>`) and it has no
`secretManagerName`, because neither the gateway namespace nor `strad-<env>-*` is
a route to it. That flag is also what tells two entries apart where one name
carries both claims, which is a shape `issues[].secrets` can hold: `name` alone
is not a key.

**`issues[]`, `inactive[]` and `unverified[]` are the console's badges.** Each
server that is not `READY` lands in exactly one of them, by the same `badgeFor`
the roster uses, with the same entry shape. `issues[]` and `servers.issues` are
what is known to be broken; a deferral and an unchecked server are in their own
lists and counts, so a caller asking "is anything broken" reads `servers.issues`.

`state` on a server and on a secret takes any of the values in the table above,
`unrenderable` included. The field is additive: `ready` keeps its meaning (a
conservative presence claim, `false` whenever any server is not `ready` or
`no-secrets`), and a consumer keying on `ready`, `env`, `store`,
`servers.total`/`ready`, `issues[].slug`/`summary` or `boot[]` needs no change
for it. A consumer that exhaustively switches on the state gets one more
arm.

**`ready: false` is the resting state of any deployment carrying an unchecked
managed namespace, and there is no seeding that clears it.** `unverified` is a
server state like any other, so a `params: true` server whose parameters neither
a component nor the store answered for puts the deployment in `unverified[]` and
holds `ready` at `false` — with an empty `secrets[]`, because the entry has no outstanding
`${NAME}` to list, and the sentence in `summary` carrying the whole of it. Where
the server is a `supplementary-image` the exit is real: rebuild and repin the
component so it manifests `STRAD_PARAM_KEYS`, and the rows fill in. Where it is a
**builtin** there is no exit at all — core is never probed, so the gap is
permanent. The console explains that gap rather than only asserting it
([#264](https://github.com/tadasant/strad/issues/264)); it does not close it,
because explaining where a value resolves is not observing that it did. Staging carries
both (`remote-filesystem-tmp-public` and `echo`) and reports `ready: false` for
that reason rather than for a missing credential. Read `servers.states` rather
than `ready` if you need to tell "a value nobody seeded" from "a namespace nobody
answered for": the two rank apart there and are the same boolean here.

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
no-store`, because the answer changes the moment someone seeds a value. What is
bounded rather than instant is the store reading behind it, and by one number:
`ttlSeconds`. Each `${NAME}` lookup happens per request and is answered from the
process's one reading of the store, which that TTL governs; the store's own
account of itself is
[answered from the same reading](#the-diagnosis-is-answered-from-the-processs-reading-of-the-store-and-says-how-old-it-is),
and reports its age in `store.diagnosis`.

**`ready` means observed.** It is `true` only when the store is wired, every
enabled server's secrets resolved, _and_ every required boot key is present. A
server that could not be checked makes it `false` — and so does an inactive one —
though neither is counted in `servers.issues`. `servers.states` carries the full breakdown for a caller that wants
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
value can be written or a secret value read back. A few things about how it
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
| `/strad/{env}/mcp/`            | Per-server parameters, under `{slug}/static/` and `{slug}/oauth/`.             |
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
   [§1 downgrade](/operate/secrets-iam/) it cannot reveal anything except the
   OAuth client secrets an `oauth:` connector has been
   [granted per secret](/operate/secrets-iam/#an-oauth-connector-reads-its-own-oauth-client).
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

The prefix is the routing key. `{slug}/{kind}/` is what makes a parameter belong
to one MCP server; without it the console could only ever write
`{namespace}{VARIABLE}`, which is a well-formed path that no resolver reads. The
field is the same combobox as the namespace picker: it opens this gateway's own
server slugs on click — each labelled with whether that server sets
`params: true` — and shows the full path it is about to write as you type.

### Several at once: bulk add

Under the single form, **Add several parameters** takes one parameter per line:

```
prefix,VARIABLE,kind,value,note
telegram-rw/static/,TELEGRAM_API_ID,plain,1234567,App id
telegram-rw/static/,TELEGRAM_API_HASH,secret,0123456789abcdef
telegram-rw/static/,TELEGRAM_STRING_SESSION,,"1BV…,with,commas",GramJS session
```

- `prefix` is the path prefix above, and may be empty. Every line lands in the
  namespace being browsed.
- `kind` is `secret` or `plain`. **Empty means secret**: a value nobody marked is
  treated as the credential it probably is, because agents can read a non-secret
  value.
- `note` is optional, and so is its column.
- Quoting is RFC 4180. A value or note holding a comma, a quote or a line break
  goes in double quotes, with a quote inside written `""`. A quoted value keeps
  its leading and trailing spaces; an unquoted field is trimmed.
- Blank lines, `#` lines and a first line of `prefix,variable,kind,…` are skipped. At
  most 100 lines at once.

With JavaScript the text is one of two views. **Rows** is an editable row per
parameter, each with a **Duplicate** control that copies the row below itself —
prefix, name, kind and note, not the value — and focuses the copied name, so one
row is the template for the next. **CSV** is the raw text, for pasting. A preview
under either checks every line as you type and keeps the button off until all of
them pass; it masks a secret value and shows a non-secret one. With JavaScript off
the textarea is the whole form.

The server parses the text again with the same parser — the browser runs
`src/ui/bulk-params.ts` inlined, not a second copy — and handles the two kinds of
failure differently:

- **A line that fails a check** (a bad name or prefix, an unreadable quote, a path
  that already exists, two lines folding onto one parameter, a namespace a strict
  store refuses) stops the batch before anything is written. Half a batch landing
  would leave you working out which half.
- **A line the store refuses** once writing has started does not stop the rest.

Either way every line is reported, by number, with its outcome. The lines that did
not land go back into the editor **without their values** — a value, secret or
not, is never sent back to the page — so you re-type the values and nothing else.
A line too broken to read comes back as a `#` comment naming its number. A line
break inside a quoted value is stored as `\n`, though a browser submits a
textarea's line breaks as `\r\n`.
Each line is written through the same create as the single form, behind the same
gate, refusing a login-token session the same way.

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

### It names the other secrets pages on this gateway

A gateway can carry more than one secrets page — `/ui/secrets` and
`/ui/zimmer-secrets` in the [layout below](#two-stores-one-gateway), one per slug.
The `/connectors` roster lists all of them, but a page you reach directly (a bookmark, the
link `open_secrets_manager` hands you) shows only its own namespaces. A namespace
that is not there is usually on another page, and without a pointer "where is
it?" looks like "it is gone".

So when the gateway has more than one, each page lists the others under its
breadcrumb: the slug, linking to `/ui/<slug>`, and each of that page's stores by
project and namespaces. Where a sibling fronts several stores
([`consoleStores:`](#one-console-page-many-stores)), each project links straight
to its own store with `?project=`. A disabled sibling is marked, as it is on the
roster. On a gateway with one secrets page there is no strip.

The list is the roster's list. It asks `serverLooksSecrets`, the same predicate
behind the roster's `Manage →` links, so the two cannot disagree about which pages
exist. It describes each sibling the way that page resolves itself. The one slug
it leaves out is one that also declares [`oauth:`](/operate/connectors/): the
console answers a connector before it looks at env, so that slug's `/ui/<slug>` is
a consent page, not a secrets page. It is
navigation, not authorization: the console gate never reads `entitlements:`, so a
console-only slug with `entitlements: []` has a page and is listed. It shows
declared config only — slug, project, namespaces — and never a parameter, a value,
a status or a credential. `test/ui.secrets.sibling-pages.test.ts` pins all of it.

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

### The console's probe is bounded, and a page render cannot inherit a stall

The console memoises the probe per store — one prober per slug, project and
service account, for the life of the process — because a token mint and a round
trip on every page render would be latency paid for an answer that is stable for
hours. An answer is kept for five minutes. A non-answer is kept for fifteen
seconds — the bound the `/mcp` door uses for the same thing, for the reason it
was written down with: a network blip is not an answer.

Concurrent renders join one in-flight probe rather than each minting their own,
and **that sharing is only safe because the probe is guaranteed to end.** The
probe's own legs do not guarantee it on this page's terms: each carries a bound
belonging to its own caller — the mint's ten-second default and the permissions
call's `timeoutMs` — and neither of them answers "how long may a page render
wait". An unbounded mint answered it worst of all, and that is the incident behind
this paragraph: Node's `fetch` has no overall timeout, so a token endpoint that
accepts a connection and then stalls holds the request until undici gives up at
300 seconds, or forever if it trickles bytes. A shared entry cleared when the
probe settles is an entry such a mint never clears, which made `GET /ui/:server`
for that store hang on every later request until core was redeployed, with nothing
logged and nothing timing out. Rotating a credential through this console is
exactly what an operator could then not do.

So a caller waits at most **six seconds**, and the abandoned request is cancelled
rather than left running. Six is the number the `/mcp` mount uses for the same
probe about the same credential; two doors disagreeing on how long a caller waits
would be a difference with nothing behind it. Past the deadline the call gets
`NO_CAPABILITIES` with a reason saying so — which is unprobed, so it is kept for
fifteen seconds and the next render asks again. Fail closed is untouched: an
unanswered probe never grants a capability, it just stops being the last word.

The console does not log the deadline where the `/mcp` mount logs it to stderr,
because the two doors have different readers: the reason travels to the human in
front of the console as the unverified-capability line on the page itself, rather
than into a log they would have to go and read.

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

### Both doors ask the same question, out of one file

The console asks it too — its reveal control and its write affordances are gated
on the same probe about the same kind of credential — and the two run in
different npm trees, which cannot import from each other. So the part that must
not differ is **vendored**: `src/secrets/parameters/capability-table.ts` holds
the ten permission strings and the fold into four booleans, and is copied
byte-for-byte into `servers/secrets/shared/src/capability-table.ts` by
`npm run capabilities:sync`. CI fails on a drift.

What each tree keeps is the **transport** — its own token mint, its own `fetch`,
its own timeout — because those genuinely differ and nothing rests on them
matching. What gets asked, and what the answer is taken to mean, does rest on it,
and the failure of two hand-kept copies is silent in both directions: widen one
and the MCP surface lists a write tool for a credential the console has already
decided cannot finish the write, producing a 403 with no explanation; narrow one
— a plausible typo is enough — and a permission Google does not recognise simply
comes back outside the held set, reads as "not granted", and withholds a tool
from a credential that holds it.

The sharpest case is the read disjunction. `readSecretValues` is
`secretmanager.versions.access` **or** `parametermanager.parameterVersions.render`,
because [`:render` derefs as the parameter's own principal](/operate/secrets-iam/#never-grant-the-secrets-mcp-credential-parameteraccessor),
so a credential holding only `render` can still read a secret value. A copy that
lost the second half would leave the one server whose contract is "no tool
returns a secret value" reporting itself read-only while holding a credential
that can read one.

### An answer is remembered; an absence is not

The probe runs once per store and the answer is kept for the life of the
container — it is a property of one credential on one project, and re-asking on
every `tools/list` would put an OAuth mint and a round trip per store on every
listing.

**What counts as the answer is `probed`, and nothing else.** A
`testIamPermissions` that came back with a permission set is one — including the
denial that is prod's normal state, a credential told it holds none of them. That
is kept for the life of the container, because it changes when a human edits IAM
and not before.

Everything else is an **absence** of an answer, and an absence expires after
fifteen seconds so the next call asks again: a token mint that failed, a
`testIamPermissions` that did not come back, and — deliberately — the ones that
look permanent, a 403 because Cloud Resource Manager is not enabled on the
project or a 401 on a revoked key. The probe reports whether it got an answer, not
why it did not, and reading a cause out of the reason string would be this code
second-guessing Google's; `testIamPermissions` stays the only authority. The cost
of not guessing is one probe per store per fifteen seconds while a fault persists,
and it is worth paying — the cost of guessing wrong is the bug this replaced.

Fifteen seconds is the same bound the console has always used for the same thing,
and for the reason it was written down with: a network blip is not an answer.
Before the `/mcp` side had it, one failed mint at the first listing pinned a store
to no capabilities for the whole life of the container, with the read path working
perfectly beside it and a redeploy the only cure
([#270](https://github.com/tadasant/strad/issues/270)).

Three consequences worth knowing:

- **The call that hit the failure still fails closed.** An unestablished
  capability is never a yes. `list_managed_namespaces` reports
  `capabilitiesProbed: false` with the reason, exactly as before; the retry
  changes what the _next_ call sees, not what this one is allowed to do.
- **The tool list can widen mid-session.** A container whose first probe could not
  reach Google lists the read-only surface, and lists the real one once a probe
  gets through. A client holding the earlier listing keeps it until it lists
  again — which is why every handler re-checks the capability per call.
- **A caller waits six seconds for a probe, not indefinitely**, and the abandoned
  request is cancelled rather than left running. The token mint passes no abort
  signal of its own, so a connection that hangs rather than fails would otherwise
  park every concurrent listing on it and pile a fresh socket up every fifteen
  seconds. Six is under the gateway's ten-second reachability timeout on purpose:
  a slow probe should leave the slug reporting unknown capabilities, not
  reporting itself unreachable.

A persistent fault says so on stderr **once** — on the first failure and on any
change of reason — rather than once per retry.

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

### One console page, many stores

The layout above gives you two consoles — `/ui/secrets` and `/ui/zimmer-secrets`
— because for a long time the config said one console page was one project. It is
not, and never was: it was a property of one TypeScript type, which now carries a
**list** of stores.

`consoleStores:` puts N stores on ONE page, selected with `?project=<gcp id>`:

```yaml
- slug: secrets
  bundle: bundle
  path: /secrets
  env:
    # The /mcp half, which has a list of its own — see mcpStores: below.
    SECRETS_PROJECT_ID: "strad-secrets-prod"
    SECRETS_NAMESPACES: "/strad/prod/mcp/"
    SECRETS_SERVICE_ACCOUNT_KEY_JSON: "${SECRETS_VIEWER_KEY_JSON}"
  consoleEnv:
    # One admin key per store. Never one identity granted on both projects.
    SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON: "${SECRETS_ADMIN_KEY_JSON}"
    ZIMMER_SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON: "${ZIMMER_SECRETS_ADMIN_KEY_JSON}"
  consoleStores:
    - project: strad-secrets-prod
      label: strad prod
      namespaces: [/strad/prod/mcp/, /strad/prod/gateway/static/]
      adminKeyVar: SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON
      namespacesStrict: true
    - project: zimmer-secrets-prod
      label: zimmer prod
      namespaces: [/zimmer/production/mcp/]
      adminKeyVar: ZIMMER_SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON
```

A store picker appears when there is more than one; with one store the page is
byte-for-byte what it was. Every form on the page posts the selected project back,
and a form naming a project this console does not front is **refused**, not
quietly redirected to the first store — a create that succeeds against the wrong
project under the wrong service account, and reports success, is the one failure
here nobody would diagnose.

**One admin key per store, always.** `adminKeyVar` is required on every entry, and
`check-config` rejects two entries naming the same one — so "the same service
account for all of these" cannot be written as one shared key name. Two projects
behind one identity is a strictly larger blast radius than the two identities it
replaces, and the two-identity split on this deployment was chosen deliberately.

**Two names carrying one `${REF}` is warned about, not refused.** The key name is
the variable; the `${NAME}` behind it is the credential, so two separate
`consoleEnv:` keys can still be one service account on two projects. That is the
same collapse — and unlike the rules above it is sometimes correct: one identity
granted on `strad-secrets-prod` and `strad-secrets-staging` is two projects inside
one system, which this deployment runs on purpose. `check-config` and
`render-spec` therefore emit a `::warning::` naming both projects and the ref
rather than failing, and a reviewer says "yes, both strad projects" or "no, that
crosses a system boundary":

```
::warning::server "secrets": consoleStores "strad-secrets-prod", "zimmer-secrets-prod"
all resolve their admin credential from ${SECRETS_ADMIN_KEY_JSON}, under different
consoleEnv: keys — so ONE service account reaches 2 projects, and a leaked key for
any of them is a leaked key for all of them. …
```

The [`/mcp` half](#the-mcp-half-mcpstores) **refuses** the identical shape, and
the asymmetry is deliberate: a shared viewer credential collapses the per-store
capability probe, so production's "you may not read a secret value" would be
answered by staging's key. Sharing an admin credential costs blast radius, which a
human can weigh; sharing a viewer credential costs a guarantee, which nobody can.

**Two stores may not claim one path.** Overlapping `namespaces:` is refused at
parse time, exactly as it is on the `/mcp` half. The console's version of the
hazard is a write: `storeForPath` refuses an ambiguous path at request time, so
without the config rule the first symptom would be a create or rotate failing on a
path a human just typed, in a deployment that rendered and deployed clean.

**A leftover `SECRETS_PROJECT_ID` is warned about.** `storeProject()` — the
DEPLOYMENT-wide default, which the roster footnote and
[`/api/secrets/readiness`](#get-apisecretsreadiness--the-same-answer-for-a-machine)
report — prefers it over a server's own `consoleStores:`, so on a multi-store page
a stale one (the single-store shape this list replaced) makes the roster
name a different project from the one the store page defaults to. The annotation
fires only for the server that default would actually answer from, since
`storeProject()` consults the first candidate and stops; a deployment whose
resolver sets `STRAD_PARAMS_PROJECT_ID` overrides the whole order anyway. It fails
legibly rather than writing anywhere wrong, which is why it is a warning; drop it,
or make it name the first store. The roster's copy-pasteable `gcloud` commands are
not affected: each parameter path names the store whose namespaces cover it, and
falls back to this default only where they decide nothing — and the
`strad-<env>-*` Secret Manager recipe names no project at all.

**Two stores sharing one `${REF}` is reported across the whole deployment**, not
one server's list — a bundle carries one secrets slug, so a strad store and a
Zimmer store sharing an admin credential arrive as two slugs, and that is the
crossing worth seeing. An overlapping namespace across two slugs is warned about
too: `storeForPath` resolves a write against every secrets slug's stores at once,
so the ambiguity is real, but a path nobody writes to could be sitting in a config
that works today — which is why that half reports rather than refuses.

It names a `consoleEnv:` key rather than carrying a `${REF}` of its own, and
`check-config` fences that name on three sides: the key **is** declared under this
server's `consoleEnv:`, the key is **not** a key of any server's `env:`, and the
`${NAME}` behind it does not appear in any server's `env:` either, under any key.
That third one is the difference between a fence and the appearance of one — the
credential travels by ref, so the same admin key under a different `env:` variable
name lands on a bundle exactly as surely. `consoleEnv:` is the one scope the
renderer lands on core and stops, so the indirection is what keeps a store-admin
credential off the container that answers `/mcp`.

**A degraded store does not take the page down with it.** If the selected store's
credential is unseeded or malformed, the page says so — and offers links to the
other stores, because with no `?project=` the selected store is the first one and
otherwise a single unseeded key would strand every healthy sibling behind a
hand-typed query string.

**`namespacesStrict` and `reveal` are per store.** They have to be. A page-level
`namespacesStrict` is checked against the union of every store's namespaces, so
you could type a Zimmer namespace while the strad store is selected and strict
would wave it through. A page-level `reveal` would either offer reveal on a
production store or withhold it from a staging one. What has **not** changed is
what strict bounds: **create**, and not rotate/note/delete, which address an
existing parameter by its canonical path.

Because a store's namespaces come from its own entry rather than from a
`SECRETS_NAMESPACES` that the MCP half also reads, a console store can be given a
wider namespace list than any container — which is what the note two sections
below used to say you could not do for a second slug.

#### The `/mcp` half: `mcpStores:`

`consoleStores:` is the console's list. `mcpStores:` is the agent's, and it is a
separate field because the credential each carries is separate — an admin key
that lands on core alone, and a viewer key that lands on the bundle:

```yaml
- slug: secrets
  bundle: bundle
  path: /secrets
  env:
    SECRETS_CONSOLE_URL: "https://strad.tadasant.com/ui/secrets"
    # One VIEWER key per store, each under its own name.
    SECRETS_SERVICE_ACCOUNT_KEY_JSON: "${SECRETS_VIEWER_KEY_JSON}"
    ZIMMER_SECRETS_VIEWER_SERVICE_ACCOUNT_KEY_JSON: "${ZIMMER_SECRETS_VIEWER_KEY_JSON}"
  mcpStores:
    - project: strad-secrets-prod
      label: strad prod
      namespaces: [/strad/prod/mcp/]
      viewerKeyVar: SECRETS_SERVICE_ACCOUNT_KEY_JSON
    - project: zimmer-secrets-prod
      label: zimmer prod
      namespaces: [/zimmer/production/mcp/]
      viewerKeyVar: ZIMMER_SECRETS_VIEWER_SERVICE_ACCOUNT_KEY_JSON
```

Absent, the container resolves ONE store the old way, out of
`SECRETS_PROJECT_ID` / `SECRETS_NAMESPACES` / `SECRETS_SERVICE_ACCOUNT_KEY_JSON`.
Present, it **replaces** that reading entirely — `renderAppSpec` emits a
non-secret `SECRETS_STORES` descriptor onto the bundle (project ids, namespaces,
and the NAME of each store's key) and the container reads that. Declaring both
shapes is refused by `check-config` rather than resolved to one of them.

`SECRETS_CONSOLE_URL` is where `open_secrets_manager` sends a human, and the link
it hands back is that value carrying one key of the tool's own making: `project=`,
**the store the path resolved to**. The value may carry a query string of its own
— `.../ui/secrets?project=zimmer-secrets-prod` is how one console page fronting
several stores addresses a particular one — and `project` is joined onto it with
`&`, replacing rather than duplicating a key it already carried. Every other key
the operator wrote passes through untouched, including a `param=` left over from
an older link. A value with no scheme, such as a bare `/ui/secrets`, is used as
written — apart from a trailing slash on its path, and a re-encoding of any query
it carried.

**The link opens a parameter list, not a parameter.** The console has no
per-parameter page: `/ui/:server` reads `project` and `ns` off the query string
and renders the rows of one namespace. So the tool lands a human on the right
store, and the parameter is named in the message the agent sends — the part a URL
cannot carry, which is why `instructions` tells the agent to say it. A `?param=`
carrying the canonical path would be dropped on arrival, since the console reads
no such key, so the link carries none
([#273](https://github.com/tadasant/strad/issues/273), and
[limitation 89](/limitations/#89-the-console-link-opens-a-parameter-list-not-a-parameter)).

**The resolved store beats the configured one.** One container fronts N stores
behind ONE `SECRETS_CONSOLE_URL`, so a `?project=` written into that variable is
right for at most one of them, and a link naming no store at all falls back to
whichever store the console lists first — the same failure with a different
constant. The path addresses exactly one store, and that answer is the one the link
carries. This is `open_secrets_manager` calling the same `storeForPath` every other
path-taking tool calls, for the only case where the answer is a label rather than a
gate: the tool reads nothing, so an argument that resolves to no store — a bare
variable name, which the tool accepts — costs the link its `project` and a `note`
saying so, not the call.

A `?ns=` the override orphans is dropped with it. A namespace belongs to exactly
one store, so rewriting `project` from A to B leaves an `ns` that B does not
manage — and the console takes a free-text `ns` unless a store sets
`namespacesStrict`, so it would list store A's namespace under store B: an empty
table on a page that looks entirely correct. It is kept only when the resolved
store claims it.

The console's `consoleStores:` is configured separately from the MCP server's
`mcpStores:`, so a resolved project id can name a store this console does not front.
There `selectStore` falls back to the first store rather than erroring — the same
landing a link naming no store would have got. The one case the override loses
information is a console whose project set is **disjoint** from the MCP server's,
where the operator's constant named a store the console does have; no config here
is shaped that way, and the answer if one ever is would be to reconcile the two
lists.

##### The path selects the store, and the store selects the capability

This is the part that makes several projects behind one MCP server safe, and it
is worth stating exactly, because it is the difference between a guarantee and a
convention.

A **capability** is a property of one credential on one project.
`projects:testIamPermissions` answers about exactly one of each, so the secrets
server probes **once per store** and memoises the answer **by project id** (an
answer, not a failure to get one — see
[above](#an-answer-is-remembered-an-absence-is-not)). Every
tool that takes a canonical path resolves it to exactly one store first, and from
then on uses that store's namespaces, that store's viewer credential and that
store's probed capability. There is no union anywhere on a call path.

Three config rules keep that resolution unambiguous, and `check-config` enforces
all three, so each is inexpressible rather than merely discouraged:

- **two stores may not share one viewer credential** — not under one
  `viewerKeyVar`, and not under two `env:` keys carrying one `${REF}`. The key
  name is the variable; the ref is the credential, and it is the credential this
  is about: one service account on two projects is two stores that probe **one
  answer**, which is the collapse the per-project probe exists to prevent. The
  container checks it a third way at boot, by `client_email`, for a descriptor
  that reached it some other way.
- **two stores may not name one project id.** It is the store's address, in a
  refusal and in the capability report.
- **two stores may not declare overlapping namespaces.** A path both could claim
  is a path whose capability depends on declaration order.

Two more fences sit around the field rather than inside it. `SECRETS_STORES` may
never be written by hand under `env:` — it is derived, and a hand-written one
would reach the container having passed none of the rules above. And only **one**
server per bundle may declare `mcpStores:`, because the tree reads that variable
by its bare name out of a container's single environment, so two would put one
list on the box under both slugs.

`viewerKeyVar` names an `env:` key rather than carrying a `${REF}`, exactly as
`adminKeyVar` names a `consoleEnv:` one. An admin key cannot be borrowed here:
`viewerKeyVar` must be a key of this server's own `env:`, and the
`consoleStores:` rules already refuse an `adminKeyVar` whose key **or** whose
`${REF}` appears in any server's `env:` under any name.

##### The tool list is a union; the enforcement is not

An MCP tool list is static per container — a client caches one listing per
session — so there is no way to offer `get_secret_value` for one store and
withhold it for another _by omission_. strad takes the **union**: the tool is
listed when at least one store's credential can back it. Every call is then
checked against the store its path addresses.

That is a deliberate change in the shape of production's guarantee, and it should
be read plainly. When production had a container to itself, the guarantee was
_"the tool does not exist."_ On a container it shares with a store that can read,
the guarantee is:

1. **The handler refuses.** `get_secret_value` resolves the path to the
   production store and reads _that store's_ probed capability. Staging's `yes`
   is not production's answer, and cannot be.
2. **Google refuses underneath it.** The production store is read with the
   production store's own viewer credential, which holds neither
   `secretmanager.versions.access` nor `parametermanager.parameterVersions.render`
   on that project. If every line of (1) were deleted, the call would still 403.

(2) is the load-bearing half, as it always was; (1) is what makes the refusal
legible instead of an opaque 403. `list_managed_namespaces` reports capabilities
**per store**, so the union listing is never the only thing an agent is told.

What has **not** changed: entitlements name slugs and the `tools:` policy names
tool names, so a slug whose `mcpStores:` names several projects is one entitlement
spanning all of them — everyone entitled to that slug reaches every store on it.
Splitting reach between two sets of parameters still means two slugs.

##### The console's list and the MCP's are separate, and only one direction is loud

`consoleStores:` and `mcpStores:` need not name the same projects — they carry
different credentials, and the console's list may legitimately be the wider one.
The **reverse** is worth a word from the renderer: a store on `mcpStores:` with no
console page behind it is managed parameter state an agent can create, rotate and
delete, and which a human cannot inspect or undo through the console. `check-config`
and `render-spec` emit a `::warning::` naming it — a warning and not a failure,
because an agent-only store is a posture a deployment may choose.

### One bundle, one `process.env`

A bundle is a component, which is a container, which is one `process.env`. That is
why a **store** needs no bundle of its own — `mcpStores:` puts the list in one
variable — while two secrets **slugs** in one bundle cannot work:
`renderAppSpec` merges a bundle's servers' `env:` maps last-wins, with no error,
so both slugs would answer from whichever store won. That is a wrong answer, not
a failure, which is why `scripts/check-config.ts`
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
therefore **cannot** be given a wider namespace list than its MCP half this way,
the way `secrets` does (one namespace under `env:`, two under `consoleEnv:`).
That works for the first slug precisely because its key is bare in both maps — and
bare is what a second slug may not use. Making the namespaced form an override
would fix it, and would also change the `gcs` pair, so it is not a local change.
[`consoleStores:`](#one-console-page-many-stores) sidesteps it instead: a store's
namespaces are declared on the store, so they are never read through the fallback
at all.

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
  store.ts    StoreSecretProvider  — a parameter store: one namespace, sliced from the resolver's reading
  view.ts     NamespaceView        — single-flight and last-known-good over one namespace; no TTL of its own
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

### Two ways to turn an error into text, and which one a store path uses

An error message is text strad did not necessarily write, so there are exactly
two ways to turn one into a string and both live in `src/util/error-text.ts`:

| function            | what it prints                                                                                                  | use it when                                                                          |
| ------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `errorSummary(err)` | a `ParameterStoreError`'s message, which is a method plus a resource path; **the class name** for anything else | anything that could have touched a store read, a rendered payload, or a secret value |
| `errorText(err)`    | the message, whatever it says                                                                                   | the message is strad's own or an upstream's, and no secret is in scope               |

**Every path that reads the parameter store uses `errorSummary`.** The reason is
`JSON.parse`: V8 puts about ten characters of its input into the `SyntaxError` it
throws, and on a store path that input is a parameter payload — which is a
credential on a non-secret parameter, and the envelope around one on a secret
parameter. The token endpoint's 200 body is the same problem in a different
place: it carries the minted `access_token`.

So a parse on a store path is never left unwrapped, and the wrapper **drops** the
original rather than chaining it as a `cause` — a `cause` travels, and anything
that stringifies the chain puts the window back. Three do it:
`currentEnvelope` raises an `UnreadablePayloadError` naming the resource,
`mintAccessToken` (`src/secrets/parameters/service-account.ts`) raises a
`ServiceAccountAuthError`, and `renderOne` returns a fixed reason rather than
throwing at all.

`src/secrets/param-route.ts` is the one file that reduces to a class name by
hand instead of calling `errorSummary`. It is vendored byte-for-byte into the
bundle host's own npm tree and must stay import-free, so importing the shared
function would mean a ninth vendoring seam; the rule is inlined at each of its
two sites, with the reason written beside it.

A class name on its own is not much use to an operator, so the console does not
stop there. `describe()` in `src/ui/index.ts` writes strad's own sentence for
every failure the console actually produces — the store refusing the credential
(403), a name collision (409), a request that timed out, a store this container
could not reach (named by its transport code), a version whose payload declares
an encoding this build does not know, a version whose payload will not decode at
all, and a path the console itself rejected — and only falls through to the bare
class for something genuinely unexpected. That fallthrough says what
was withheld and why, and the class is logged under
`strad.console_render_failed`, whose export carries the event name alone.

`test/ui.secrets.error-text.test.ts` is the canary: it plants a credential inside
a payload that will not parse, drives `GET /ui/:server` and the four `POST`
actions that read the envelope, and asserts that neither the value nor the
ten-character window reaches the HTML page or the log.
