---
title: Telemetry (OpenTelemetry / OTLP)
description: How strad emits traces and metrics over OTLP, what it deliberately never emits, and the resource-constraint signals that tell you whether a component is dying of memory or of CPU.
sidebar:
  order: 4
---

strad emits **OpenTelemetry traces and metrics over OTLP**. It is **off by
default**: with no `OTEL_EXPORTER_OTLP_ENDPOINT` set, no SDK starts, nothing is
exported, and the gateway behaves exactly as it did before. Turning it on is one
environment variable.

The instrumentation is biased hard toward one question — **is this component
failing because it ran out of resources, and if so, which resource?** — because
that is the question that is nearly impossible to answer from the outside. App
Platform restarts a component that gets OOM-killed and tells you almost nothing
about why.

## Turning it on

Seed two secrets in GCP Secret Manager (`deploy-staging.yml` already loads every
`strad-<env>-*` secret into the deploy job's environment, so **no workflow change
is needed** — seeding the secret is the whole job):

| Secret                                      | Required                         | Example                        |
| ------------------------------------------- | -------------------------------- | ------------------------------ |
| `strad-staging-OTEL_EXPORTER_OTLP_ENDPOINT` | yes                              | `https://otlp.example.com`     |
| `strad-staging-OTEL_EXPORTER_OTLP_HEADERS`  | only if your ingestor needs auth | `Authorization=Bearer <token>` |

`render-spec.ts` picks both up: the endpoint becomes a **GENERAL** env var (a
collector URL is not a credential, and an operator should be able to see what the
deployment is pointed at in the App Platform console), and the headers become a
**SECRET** env var, encrypted at rest, on the same path as every other credential.

On a **store-backed** deployment the header is not in the deploy environment at
all — it is read from `/strad/{env}/gateway/static/OTEL_EXPORTER_OTLP_HEADERS`.
The core and any strad-image bundle hydrate it themselves at boot; a third-party
`supplementary-image` component cannot, so the renderer reads it from the store
and bakes it onto that component. Rotating it is therefore a **deploy**, not a
restart, and a deploy where any component would end up without it
[fails](/operate/deploy-model/#the-exception-a-container-that-cannot-ask-the-store)
rather than shipping a container that exports into a rejection.

The endpoint must speak **OTLP over HTTP/protobuf** — the OTLP spec's default for
the HTTP transport, port `4318` on a standard collector. strad appends the signal
paths itself, so give it the base URL (`https://host:4318`), not
`https://host:4318/v1/traces`.

Optional knobs, all standard: `OTEL_SERVICE_NAME`, `OTEL_RESOURCE_ATTRIBUTES`,
`OTEL_EXPORTER_OTLP_PROTOCOL`, `OTEL_METRIC_EXPORT_INTERVAL` (defaults to 15s, not
the usual 60s — a 60s window can miss the entire memory ramp that precedes an OOM
kill), `OTEL_TRACES_SAMPLER`.

:::caution[Don't set `OTEL_SERVICE_NAME` unless you mean it]
Left unset, each component names itself from `STRAD_COMPONENT`: `strad-core`,
`strad-bundle`, `strad-bundle-zimmer-secrets`. Setting `OTEL_SERVICE_NAME`
collapses every process into **one** service name — which is exactly the
averaging that hides which component is dying.
If you do set it, split by the `strad.component` resource attribute, which is always
present.
:::

## What every component reports

Each process carries these resource attributes:

- `service.name` — `strad-core`, `strad-<component>`
- `service.version` — the **image tag actually deployed**, not the VERSION file
- `service.namespace` — `strad`
- `service.instance.id` — a fresh UUID **per process start**
- `deployment.environment` (and `.name`) — `staging` | `prod` | `dev`
- `strad.mode` (`core` | `bundle`), `strad.component`

## The resource-constraint signals

### Memory — the OOM predictor

| Metric                                                                  | Why                                                            |
| ----------------------------------------------------------------------- | -------------------------------------------------------------- |
| `strad.container.memory.limit`                                          | The **cgroup** limit — the only number the OOM killer consults |
| `strad.container.memory.usage`                                          | cgroup usage, **including child processes** (i.e. Chromium)    |
| `strad.container.memory.utilization`                                    | usage / limit, `0..1`. **This is the OOM predictor.**          |
| `strad.process.memory.rss` / `.heap.used` / `.heap.total` / `.external` | Where the memory went                                          |

The limit is read from the **cgroup** (`/sys/fs/cgroup/memory.max`), not from
`os.totalmem()`. This matters more than it sounds: inside the bundle's 2GB App
Platform container, `os.totalmem()` reports the _host's_ memory (tens of GB), so a
"percent memory used" computed the obvious way reads a comfortable single digit
while the kernel is about to kill you.

### CPU / saturation

| Metric                                         | Why                                                   |
| ---------------------------------------------- | ----------------------------------------------------- |
| `strad.eventloop.delay.p99` / `.mean` / `.max` | **The single best saturation signal for Node.**       |
| `strad.eventloop.utilization`                  | Fraction of the interval the loop was busy            |
| `strad.process.cpu.utilization`                | CPU-seconds per wall-second (`>1` = more than a core) |
| `strad.gc.duration`, `strad.gc.collections`    | GC pause distribution, by kind                        |

A saturated 1-vCPU box does not announce itself as "CPU: 100%". It announces
itself as an event loop that is 800ms behind — which is why every request suddenly
takes a second. Chromium is the expected culprit, and it shows up **here**, as lag
in the Node process waiting on it.

### Restarts

App Platform restarts a component on OOM. To make that loud:

- `service.instance.id` is regenerated per process, so
  **`count(distinct service.instance.id)` over a window is the restart count**.
- `strad.process.uptime` is a sawtooth. A reset to ~0 **is** a restart.

**The OOM fingerprint** is the two together: `strad.container.memory.utilization`
climbing toward 1.0, and then a new `service.instance.id` with uptime back at zero.

### Chromium

`good-eggs`, `fetchpet` and `pointsyeah` all drive a real headless Chromium — and
in the collapsed bundle they drive the **same one**, with a context per call. So
these metrics describe a single shared browser inside the `strad-bundle` process,
not one per server.

| Metric                          | Why                                                                                                   |
| ------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `strad.browser.launches`        | By outcome. In steady state this fires **once, at boot** — a nonzero rate means Chromium keeps dying. |
| `strad.browser.launch.duration` | Baseline ~1.06s. Watch it climb as the box saturates.                                                 |
| `strad.browser.active`          | Live browser processes                                                                                |
| `strad.browser.contexts.active` | Live contexts. Should return to ~0 between calls; if it climbs, contexts are leaking.                 |
| `strad.browser.crashes`         | Tagged `memory.pressure` = `high` \| `normal` \| `unknown`                                            |

That last attribute is the important one. Playwright reports an **OOM-killed**
Chromium and a Chromium that **crashed on a bad page** identically — a bare
`disconnected` event, no exit code, no reason. The container's memory pressure _at
the instant of the crash_ is the only thing that separates them, and it is gone a
second later, so we sample it there and bucket it. `memory.pressure=high` (≥0.85
utilisation) is the OOM fingerprint.

## MCP / gateway behaviour

**Spans**, nested into one waterfall:

```
mcp.request                     (SERVER; mode, principal kind, requested vs selected servers)
└── mcp.tools.call              (server slug, tool name, surface, arg count, byte sizes, outcome)
    └── mcp.upstream.call_tool  (CLIENT; server slug, upstream kind, timeout, outcome)
```

`strad.surface` on the tool-call span and its metrics is `mcp` for a call that
arrived at the endpoint and `playground` for one a signed-in human made from the
[console playground](/auth/overview/#the-console-playground). Both run the same
code, so without the attribute a latency graph would carry a human's thinking
time in the same series as an agent's calls. A playground call has no
`mcp.request` parent — it never crossed the HTTP endpoint.

W3C trace context (`traceparent`) is injected into every upstream hop, so the
bundle's spans join the core's trace. That is the difference between "the request
took 8s" and "the request took 8s, of which 7.6s was Chromium inside the bundle,
serving fetchpet".

**Metrics:** `strad.mcp.requests`, `strad.mcp.request.duration`,
`strad.mcp.in_flight` (concurrency), `strad.mcp.auth_failures` (401, by reason),
`strad.mcp.unavailable` (424 fail-closed, by server), `strad.mcp.unlistable` (a
`tools/list` that failed for a server the client named, by server),
`strad.mcp.tool_calls` and `strad.mcp.tool_call.duration` (by server + tool),
`strad.mcp.upstream.duration` (**per-server latency — this is what shows you
which server is starving the others**), `strad.mcp.upstream.errors`,
`strad.mcp.upstream.timeouts`, and `strad.mcp.tool_surface` (**is a slug serving
anything at all** — see below).

Timeouts get their own counter deliberately. The MCP SDK's request timeout
defaults to **60s and applies at every hop**, so a slow tool behind the gateway
dies at exactly 60s and presents as a mysterious platform failure. Counting them
separately turns that into a one-glance diagnosis.

### `strad.mcp.tool_surface` — is a slug serving anything at all?

A gauge: how many tools each mounted server's **upstream** is currently offering,
attributed by `mcp.server` and `mcp.upstream.kind`. The background monitor
([architecture](/intro/architecture/#adapters)) records it on every probe.

**It is the signal this fleet was missing.** A slug can be configured, entitled,
routed and dead, and the only symptom is a `tools/list` that comes back empty —
which reads exactly like a server that has no tools. That state ran for a week on
both environments and left nothing behind but a stdout line nothing ingested (the
[log exporter](#logs--strads-own-events-and-only-those) is new, and is the other
half of this fix). A gauge pinned at zero for a slug, on the other hand, is a
thing you can alert on:

```promql
min_over_time(strad_mcp_tool_surface{mcp_upstream_kind="supplementary-image"}[15m]) == 0
```

Scope it by `mcp_upstream_kind`. A `remote-http` is somebody else's server on the
public internet, and paging you at 3am because deepwiki is having an afternoon is
how an alert gets muted. Scope by component too (`service_name`) if you want one
page per fault: core and each bundle run their own monitor, so a slug mounted in
both is two series for one problem.

**Only immutable attributes are on it, deliberately.** The `state` word — `ok` /
`empty` / `unreachable` — is on `/healthz` and in the log line and is _not_ here.
OTLP defaults to cumulative temporality, under which every attribute set ever
recorded keeps being re-exported at its last value, with no expiry. A
`state="unreachable"` series would be minted by the first probe of nearly every
deploy, since core comes up before its bundles do, and would then sit at zero for
the life of the process — latching the alert above the first time anything
recovered. The value already carries the fact.

It measures the **upstream's** surface, not what a client sees: the `tools:`
allow-list is applied on the listing path and not in the probe, so a slug whose
policy filters every tool away reads healthy here. `mcp.policy_unmatched_tools` is
the signal for that one.

`strad.mcp.unlistable` is its request-side companion — a `tools/list` that failed
for a server the client named. It needs its own counter because that failure
answers with a JSON-RPC error inside an HTTP **200**, so it moves nothing else.

## What strad will never send

:::danger[The hard rule]
Tool **arguments**, tool **results**, request bodies, headers and tokens **never**
become span attributes, span events, metric attributes, or exception messages.
:::

strad proxies 1Password vault items, Gmail bodies, Google Docs and bank data.
Telemetry leaves the box and lands in an ingestor. A pipeline that exfiltrated
1Password contents to a third party would be far worse than the resource problem
the telemetry exists to diagnose.

What _is_ recorded is **shape and identity**: which server, which tool, how many
arguments, how many bytes, how long, and whether it failed — in one of a **fixed,
closed set** of error kinds (`timeout`, `upstream_unavailable`,
`local_machine_offline`, `not_selected`, …).

Two things that look like omissions and are not:

- **`recordException()` is never called.** It writes `exception.message` and
  `exception.stacktrace` as span-event attributes, and an upstream MCP server's
  error text is arbitrary text we did not author — it can echo the request back.
  Errors are _classified_ instead.
- **The stdout STREAM is never shipped.** It carries upstream error messages —
  arbitrary text strad did not author — and exporting it wholesale would drag
  those across this boundary. What is exported is strad's own events, field by
  field, against an allowlist. See below.

`test/telemetry.redaction.test.ts` pins all of this: it drives a real MCP tool
call with a credential-shaped canary planted in **both** the arguments and the
result, serialises every exported span, metric **and log record**, and asserts
the canary appears nowhere. It also asserts the useful signals _do_ emit —
otherwise it would pass happily on an implementation that exports nothing at all.

See `src/telemetry/redact.ts`.

## Logs — strad's own events, and only those

strad exports its structured events as OTLP logs. It does **not** export stdout.

That distinction is the entire design, and it was learned the expensive way. For
a long time there was no log exporter at all, on the reasoning above: stdout
carries upstream error text, so shipping the stream would breach the boundary.
Correct — and it cost a week. The `secrets` slug served zero tools in production;
`mcp.list_tools_failed` named the failure on every single request and went to a
stream with no ingestor. On App Platform, a log nobody ships is a log nobody
reads. The boundary held perfectly while the deployment was silently broken.

So `src/telemetry/events.ts` carries an **allowlist**: every event that may leave
the process, and for each one the exact fields that may go with it.

| Event                                                  | Why it is exported                                     |
| ------------------------------------------------------ | ------------------------------------------------------ |
| `mcp.list_tools_failed` / `mcp.list_resources_failed`  | a mounted slug is serving nothing                      |
| `mcp.local_machine_offline`                            | a `local-tunnel` host is off or refusing — not a fault |
| `strad.tool_surface_degraded` / `_recovered`           | which slug, and when it changed                        |
| `strad.tool_surface_offline`                           | a local-tunnel's machine is off — not degraded         |
| `strad.tool_surface`                                   | the fleet summary, on change                           |
| `mcp.unavailable`                                      | 424 fail-closed: a slug asked for and not entitled     |
| `mcp.policy_unmatched_tools`                           | a `tools:` typo silently narrowing a toolset           |
| `strad.readiness_failed` / `_store_diagnostics_failed` | the event name only — that surface is failing          |
| `strad.listening` / `strad.secrets_hydrated`           | what this build mounted, and which keys resolved       |
| `strad.shutdown`                                       | a clean SIGTERM. Its **absence** is an OOM kill        |

Three rules make it safe, and they are worth stating because the boundary is the
reason this exists at all rather than a `pino` transport:

1. **Deny by default.** A field not on its event's list is not exported — not
   truncated, not redacted, absent. Adding a field to a log call does not
   silently start shipping it; getting it on the list is how it ships.
2. **`error` is on no list.** Every upstream error message in this codebase lands
   in a field of that name — the one that mattered here was a full HTML page from
   someone else's Express. Where an event carries one, the exporter substitutes
   `error.kind`, the classification from `redact.ts`, which is one of a fixed set
   of words strad wrote.
3. **The streams still carry every event in full**, upstream text and all. An
   operator with a shell sees the upstream's own words; the ingestor sees
   strad's. One thing did change about them: an event whose name ends `_failed`
   or `_degraded` now goes to **stderr** regardless of which call site emitted
   it, so `mcp.auth_failed` moved off stdout. The stream now agrees with what the
   event is rather than with how it was written.

`ui.playground.tool_call` is on no list, and it is the rule working rather than an
oversight. The console playground writes one per call, naming the slug and the
tool — and the tool is a string a human typed into a text field, not a word from a
set this repo wrote down. It reaches stdout in full and the ingestor not at all;
`strad.mcp.tool_calls` with `strad.surface=playground` carries the same fact in a
channel nobody can write free text into.

Two things are deliberately absent. **`mcp.auth_failed`** is not exported at all:
its fields are safe, but it fires before authentication succeeds, so anyone who
can POST `/mcp` could fill the batch queue and evict the signals that matter.
`strad.mcp.auth_failures` counts the same thing by the same `reason`, in a
channel with no queue to starve. And the **424's requested-server list** is
filtered to slugs that actually exist in the config, with the rest reduced to a
count — `?servers=` is validated against nothing, so it is the one place a client
writes free text into strad's own vocabulary. The same filtering applies to the
`mcp.server` attribute on `strad.mcp.unavailable`, where an unfiltered value
would let any token holder mint metric series at will.

Every exportable event a client can drive — `mcp.list_tools_failed`,
`mcp.list_resources_failed`, `mcp.local_machine_offline`,
`mcp.policy_unmatched_tools` and `mcp.unavailable` — is throttled to one exported
record per slug per minute, for the same queue-starvation reason. A repeated
fault is therefore under-reported by up to a minute in the ingestor; the streams
are never throttled, and `strad.mcp.tool_surface` carries the same fact
continuously. Fault events export at `SeverityNumber.ERROR`, so
`severity >= ERROR` finds them.

### An offline `local-tunnel` is not a fault, and does not export as one

A machine you own being switched off is the advertised behaviour of
[`local-tunnel`](/servers/interface/#2-local-tunnel), not an incident. Two
things follow, and both were learned by paging a production alert channel over a
laptop somebody had closed:

- **`error.kind` has a member for it: `local_machine_offline`.** The other kinds
  are chosen by matching the error's message, which is safe (strad reads the
  text, never exports it) and is all there is for an error thrown by `fetch` or
  by the SDK. But `LocalMachineOfflineError`'s message is strad's _own_ — it ends
  "Nothing is wrong with strad" — so it matched nothing and classified as
  `unknown`, the same word an unclassified fault gets. It now declares its kind
  instead of being guessed at, and a declared kind is honoured only against the
  closed set, so declaring one can never widen what may be exported. This is the
  label on the hop's **span** and on `strad.mcp.upstream.errors`, and the hop
  asks the offline verdict directly rather than reading the declaration: it is
  instrumented inside the frame that later builds that error, so it only ever
  sees the raw `fetch` or SDK failure. Before this, one closed laptop was
  scattered across `upstream_unavailable`, `timeout` and `unknown` by how the
  tunnel happened to fail.
- **It is reported as `mcp.local_machine_offline`, never `mcp.list_tools_failed`
  or `mcp.list_resources_failed`.** An event whose name ends `_failed` exports at
  ERROR, which is what `severity >= ERROR` — the first filter any operator writes
  — is for. Naming a closed laptop a strad fault there is a false page, and it
  cannot be fixed from the alert's side: excluding `error.kind:unknown` would
  silently stop alerting on real unclassified faults, and naming slugs in the
  rule duplicates deployment topology and fails silent for the next tunnel anyone
  adds. **The event name is what carries the distinction in the log channel** —
  `mcp.local_machine_offline` is not in `CLASSIFY_ERROR` and carries no
  `error.kind` at all, because there is nothing left for one to say. The
  resources path matters as much as the tools path here: `resources` is
  advertised unconditionally, so an offline machine throws there on every session
  that lists them, whether or not anyone asked for that slug.

A client that names the slug gets a **successful** listing carrying one tool,
`<slug>__troubleshoot_host` — the slug stays connectable and says what to run on
the machine, rather than returning `200 {"tools":[]}`, which would read as "this
server has no tools". `explicit` on the record says who was asking: `true` when a
client named the slug, `false` when it was a fleet-wide listing.

Records are batched, not sent per-record: these are diagnostics, and a synchronous
round trip on the failure path would add latency to exactly the requests already
going badly. As with every other signal here, no `OTEL_EXPORTER_OTLP_ENDPOINT`
means no exporter and no behaviour change.

## Exception reporting — GlitchTip, over the Sentry protocol

Everything above stops at the process boundary. If strad **crashes** — an
uncaught `TypeError`, an unhandled rejection, a boot that throws — none of it
goes through `event()`, so none of it is exported. The stack lands on stdout,
which is never shipped, the component restarts, and the ingestor can tell you
`service.instance.id` changed but not one word about why.

strad closes that with a **Sentry-protocol** reporter pointed at a self-hosted
**GlitchTip**. Like OTLP, it is **off by default** and one environment variable
turns it on:

| Variable     | Type   | Example                                 |
| ------------ | ------ | --------------------------------------- |
| `SENTRY_DSN` | SECRET | `https://<key>@glitchtip.example.com/1` |

Unset — the default — and **nothing happens**: the SDK is behind a dynamic
`import()`, so it is not even loaded. No client, no process handler, no network,
and no log line. Set it and one `errors.started` line names the ingest host (never
the key) at boot.

It travels the same path as every other credential: seeded as
`strad-<env>-SENTRY_DSN` in GCP Secret Manager, injected as a SECRET env var by
`render-spec`, or — on a store-backed deployment — read from
`/strad/{env}/gateway/static/SENTRY_DSN` at boot like the other
[boot keys](/operate/secrets/#what-rotates-live-what-needs-a-restart-and-what-needs-a-redeploy).
Absent, the store roster reports it missing and the deploy is unaffected: it is
optional, like every other telemetry name.

Unlike `OTEL_EXPORTER_OTLP_HEADERS`, it does **not** reach a supplementary image.
Only strad's own process reports exceptions; a third-party container runs code
strad did not write, and a DSN is a write credential for the issue tracker.

:::caution[On a store-backed deployment this is core-only]
`SENTRY_DSN` is a name the **core** hydrates. It is deliberately not one of the
two a bundle hydrates, because that same list is what gets **baked** onto a
third-party supplementary image — adding it there would hand a DSN to every
container strad does not run. So under `gcp-parameter-store` a strad-image bundle
starts no reporter; under the `env` provider it gets the DSN as a broadcast
SECRET and does. Core is the process that answers `/mcp`, and it reports either
way.
:::

### What it reports

Uncaught exceptions, unhandled rejections, and boot failures — the last
explicitly, because `main().catch()` exits by a path no process handler ever
sees, and a boot that throws is the likeliest crash strad has. The reporter
therefore starts **before** the config is loaded, so a config that will not parse
is reported too; a deployment whose DSN is in the parameter store gets a second
start after hydration.

**A crash still behaves like a crash.** Both handlers preserve what Node does
with no listener registered: print, then exit non-zero. That takes two
deliberate departures from the SDK's defaults, because the mere presence of a
listener disables Node's own behaviour:

- The uncaught-exception integration runs with
  `exitEvenIfOtherHandlersAreRegistered: true`. Its default is to decline to
  exit if any _other_ `uncaughtException` listener exists — so one dependency
  adding one handler would leave a reported, unprinted, still-running process.
- strad registers its **own** `unhandledRejection` handler and does not install
  the SDK's. That integration's ignore list is unconditional and includes
  `AbortError` — the shape every timed-out store read in this codebase takes — so
  such a rejection would have been neither reported nor fatal.

Each event carries the identity OTLP already stamps — `environment` is
`deployment.environment` (`prod`, `staging`, `dev`), `release` is
`service.version` (the deployed image tag), and `strad.component` / `strad.mode`
are tags — so a GlitchTip issue and a Grafana log record line up without anyone
maintaining a mapping.

### What it deliberately does not report

**The `event()` fault path.** `mcp.list_tools_failed`, `strad.tool_surface_degraded`
and the rest are _not_ captured, and that is a decision:

- They already export as OTLP log records at ERROR severity, against a per-event
  field allowlist. Sending them twice buys no signal.
- They are the events an **upstream** can drive. `mcp.list_tools_failed` fires
  once per failing slug per listing, and its `error` is text strad did not author
  — the reason the allowlist ships `error.kind` instead. Feeding that into an
  issue tracker would fill it with someone else's HTML error page, grouped as a
  strad defect.

A caught, classified error is a condition strad handled. A crash is not. GlitchTip
holds the second kind.

### Secrets

This is the **one** channel in strad that ships free text, so it is also the one
with a filter in front of it:

- `sendDefaultPii: false`, and **no default integrations at all**. The SDK's
  defaults would attach request data (headers, cookies, query strings), console
  output as breadcrumbs — which is every upstream error message strad logs — and
  source-context lines read off disk. The only integrations installed are the two
  process handlers and `dedupe`.
- `beforeSend` **rebuilds the event from a key allowlist**, the same discipline as
  the log exporter's. `request`, `user`, `extra`, `breadcrumbs` and `modules` are
  dropped; so are stack-frame `vars` and source context. A field a future SDK
  version adds is dropped rather than shipped.
- Every string that survives goes through `scrubText()`: every credential-shaped
  env var this process holds is struck out **by value** (including the string
  leaves of a JSON one like `STRAD_TOKENS`), then PEM blocks, JWTs, `Bearer`
  lines, URL userinfo and `secret-ish-key = value` pairs are struck out by shape.
  Then it is truncated — a message long enough to be a payload is a payload.
- `tracesSampleRate: 0`, and `skipOpenTelemetrySetup: true` so the SDK never
  registers a tracer provider. Traces go to Tempo, from the OTel SDK above.

`test/telemetry.errors.test.ts` pins both ends: that an unset `SENTRY_DSN`
initialises nothing and installs no handler, and that a secret-bearing exception
does not survive `beforeSend` intact.

See `src/telemetry/errors.ts` and `src/telemetry/redact.ts`.

## The supplementary images

The gateway starts its own SDK in-process. A supplementary image can't — it isn't
strad — so each one boots through a **vendored OTEL bootstrap** instead:

```dockerfile
CMD ["node", "--import", "/app/host/otel/instrument.mjs", "/app/host/dist/index.js"]
```

`otel/instrument.mjs` is copied **byte-identical** into every image that has one.
Each image is its own Docker build context and cannot `COPY` from the repo root —
the same reason the `shared/` trees are vendored. `telemetry/bundle/instrument.mjs`
is the source of truth; `scripts/sync-telemetry.mjs` copies it to seven targets;
`test/telemetry.sync.test.ts` fails CI if any copy drifts.

Seven targets, because the per-server images (`bundle-api`, `good-eggs`, `fetchpet`,
`pointsyeah`, `onepassword`, `bundle-google`) still exist and are still built even
though only `strad-bundle` is deployed. See [Known limitations](/limitations/).

The telemetry env vars reach a supplementary component the same way — `appspec.ts`
forwards exactly the `OTEL_*` keys into a component that otherwise receives only its
own secrets. `test/appspec.telemetry.test.ts` pins that.

The bootstrap also publishes the Chromium hooks on `globalThis`, which the browser
servers call through a small local shim that no-ops when the bootstrap is absent.
That keeps the vendored `shared/` trees free of any dependency on strad.

## Failure modes (all of them safe)

Telemetry must never be able to take a live deployment down.

- **Endpoint unset** → no SDK starts, one `telemetry.disabled` log line, normal boot.
- **Endpoint malformed** → caught, logged as `telemetry.start_failed`, normal boot.
- **Collector unreachable at runtime** → the exporter retries and drops on a
  background timer. It never propagates into a request.
- **SIGTERM** → telemetry is flushed last, with its errors swallowed, so a dead
  collector cannot wedge the shutdown path. When a container is being killed for
  OOM, those last few seconds of memory metrics _are_ the diagnosis.
