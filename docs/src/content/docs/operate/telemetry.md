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

| Metric                                                                                  | Why                                                                                                 |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `strad.container.memory.limit`                                                          | The **cgroup** limit — the only number the OOM killer consults                                      |
| `strad.container.memory.usage`                                                          | cgroup usage, **including child processes** (i.e. Chromium)                                         |
| `strad.container.memory.utilization`                                                    | usage / limit, `0..1`. **This is the OOM predictor.**                                               |
| `strad.process.memory.rss` / `.heap.used` / `.heap.total` / `.heap.limit` / `.external` | Where the memory went. `.heap.limit` is the ceiling V8 enforces; `.heap.total` only grows toward it |

Two of the bundle's tenants are **not** in the Node numbers and **are** in the
cgroup one: the shared Chromium, and the `mcp-grafana` child the Grafana mount
supervises. A third is half in: the worker thread an image-diff or svg-tracer
call runs in counts toward `rss` but not toward `heap.*`, which measure the main
isolate only. `strad.process.memory.rss` will look calm while
`strad.container.memory.utilization` climbs, which is the whole reason the
container metric is the one to alert on.

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
`strad.mcp.tool_denials` (**tools/call refusals by the capability policy, by
server and by nothing else** — see below),
`strad.mcp.upstream.duration` (**per-server latency — this is what shows you
which server is starving the others**), `strad.mcp.upstream.errors`,
`strad.mcp.upstream.timeouts`, `strad.mcp.tool_surface` (**is a slug serving
anything at all** — see below), and `strad.mcp.mount_degraded` (**does the bundle
say a slug's mount is unwell** — below that).

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

### `strad.mcp.mount_degraded` — does the bundle say a mount is unwell?

A gauge: **1** when the bundle hosting a `supplementary-image` slug's mount reports
that mount degraded, **0** when it reports it serving. Same two attributes as
`strad.mcp.tool_surface` — `mcp.server` and `mcp.upstream.kind`, both from the
config — so the two join slug for slug. Recorded by core only, on every probe of
the monitor, from one `GET /healthz` per bundle (`src/gateway/mount-health.ts`).

It covers the tool surface's blind spot. A mount can list every tool and fail every
call: fetchpet's login selector went stale and it listed four tools and answered
`Login failed` to each of them for weeks, while `strad.mcp.tool_surface` read 4.
Tool lists are static and a login is not, and only the bundle knows — its own
`/healthz` says so, per mount. This is the reading of it:

```promql
max_over_time(strad_mcp_mount_degraded[15m]) == 1
  and on (mcp_server) strad_mcp_tool_surface > 0
```

That is "lists its tools, and its bundle says its calls fail" — the case above.

**One bit, and never the reason.** The bundle's `degraded` value is text core did
not author: `login failed: ${error.message}`, where the message is a browser
library's, quoting whatever page the login died on. core reads it for its
truthiness and drops it at the parse, so no gauge, event, stream line, `/healthz`
field or deploy annotation can carry it. A closed-set classification
(`login_failed`, `credential_missing`) would say more, and is deliberately not
here: the bundle sends prose rather than a class, so core would be picking the
class by pattern-matching an upstream's error message; and a class would have to be
an attribute, which under cumulative temporality re-exports forever at its last
value, the same trap the `state` word is kept off `tool_surface` for. The reason is
on the bundle's own `/healthz` and in its container log.

A slug with no reading records nothing, so while a bundle's report cannot be read
the series holds its last value. core's `/healthz` names those slugs in
`mountUnread`, `strad.mount_report` (below) says when a bundle's report became
unreadable and when it came back, and `strad.mcp.tool_surface` shows a bundle that
is down. The event that goes with the gauge, `strad.mount_state`, ships at **Info**:
one bit cannot tell a failed login from a credential a human deferred on purpose,
and the deferred case pages nobody, so alert on the gauge and scope it by slug. It
is reported and never gated on — see
[known limitations #40](/limitations/#40-the-tool-surface-monitor-asks-one-question-so-it-can-only-catch-one-kind-of-failure).

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
`local_machine_offline`, `server_unconfigured`, `not_selected`, …).

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

| Event                                                                                  | Why it is exported                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mcp.list_tools_failed` / `mcp.list_resources_failed`                                  | a mounted slug is serving nothing. A transient failure (`429`, `5xx`, a dropped socket, a DNS try-again) is retried first, so for one of those this fires only once that budget is spent; `attempts` and `retry` say which case it was                                                                                                                                                                         |
| `mcp.list_retry`                                                                       | one transient listing failure the retry budget absorbed (`listing`, `attempt`, `delay_ms`, `error.kind`) — Info, not a fault                                                                                                                                                                                                                                                                                   |
| `mcp.local_machine_offline`                                                            | a `local-tunnel` host is off or refusing — not a fault                                                                                                                                                                                                                                                                                                                                                         |
| `strad.tool_surface_degraded` / `_recovered`                                           | which slug, and when it changed                                                                                                                                                                                                                                                                                                                                                                                |
| `strad.tool_surface_offline`                                                           | a local-tunnel's machine is off — not degraded                                                                                                                                                                                                                                                                                                                                                                 |
| `strad.tool_surface_unconfigured`                                                      | a slug waiting on a `mayBeUnseeded:` credential, or an `oauth:` slug nobody has connected                                                                                                                                                                                                                                                                                                                      |
| `mcp.server_unconfigured`                                                              | the same, on a listing that named the slug                                                                                                                                                                                                                                                                                                                                                                     |
| `strad.tool_surface`                                                                   | the fleet summary, on change                                                                                                                                                                                                                                                                                                                                                                                   |
| `strad.mount_state`                                                                    | a mount went `degraded` or `ok` by its bundle's account — config slug and bundle, no reason. Info: a bit cannot tell a failed login from a deferral                                                                                                                                                                                                                                                            |
| `strad.mount_report`                                                                   | a bundle's mount report went unreadable or came back — `outcome` is `ok` / `unreachable` / `unrecognised` / `unwired`                                                                                                                                                                                                                                                                                          |
| `mcp.unavailable`                                                                      | 424 fail-closed: a slug asked for and not entitled                                                                                                                                                                                                                                                                                                                                                             |
| `mcp.policy_unmatched_tools`                                                           | a `tools:` typo silently narrowing a toolset                                                                                                                                                                                                                                                                                                                                                                   |
| `mcp.tool_denied`                                                                      | a `tools/call` the capability policy withheld — the config slug, and neither the tool name the caller asked for nor the principal                                                                                                                                                                                                                                                                              |
| `mcp.events_list_failed`                                                               | one selected slug's `events/list` failed after its handshake advertised MCP Events, so its event types are missing from the union — the slug, and nothing the upstream said. An unconfigured, offline or tools-only slug is skipped without one ([MCP Events](/servers/events/))                                                                                                                               |
| `strad.readiness_failed` / `_store_diagnostics_failed` / `strad.console_render_failed` | the event name only — that surface is failing                                                                                                                                                                                                                                                                                                                                                                  |
| `strad.route_failed`                                                                   | a route handler rejected and nothing under it caught — the route word, plus `error.kind`. A STREAMING route (`mcp_download`) emits the same record and then destroys the connection rather than ending it, so a truncated artifact is reported as a failed transfer instead of a short success                                                                                                                 |
| `strad.listening` / `strad.secrets_hydrated`                                           | what this build mounted, and which keys resolved                                                                                                                                                                                                                                                                                                                                                               |
| `strad.mcp_json_unentitled`                                                            | slugs the [`mcp.json` dialect](/servers/interface/#mcpservers--the-draft-sep-2633-input-dialect) attached with no entitlements — routed, reachable by nobody                                                                                                                                                                                                                                                   |
| `strad.shutdown`                                                                       | a clean SIGTERM. Its **absence** is an OOM kill                                                                                                                                                                                                                                                                                                                                                                |
| `strad.param_written` / `_write_failed` / `_refused`                                   | a server persisting a credential that rotated under it. `_write_failed` carries `reason` (`env_provider`, `no_store`, `no_reader`, `store_mismatch`, `read_failed`, `not_ours`, `write_failed`, `not_held`) and the store's numeric `status` when one answered                                                                                                                                                 |
| `strad.param_read`                                                                     | a server reading one of its own parameters live — a `paramsWritable:` boot read, or a `paramsRefresh:` poll. The deploy record a runtime rotation would otherwise not leave                                                                                                                                                                                                                                    |
| `strad.instance_read` / `strad.instance_read_failed` / `strad.instance_refused`        | a bundle host reading one [store-served instance's](/operate/secrets/#store-served-instances--a-mount-credentialed-from-its-own-namespace) own namespace through core — on every sync, so it is a heartbeat per instance as much as a record: `slug`, `tree` and a count of values, never a name or a value. The read failing, with `slug`. A request for a slug that is not a served instance, with no fields |
| `strad.upstream_token_refreshed` / `_refresh_failed`                                   | a `remote-http` server with `oauthRefresh:` minting an upstream access token: the slug, whether the refresh token rotated, and on failure one of four reason words                                                                                                                                                                                                                                             |
| `console.token_minted` / `_exchanged` / `_revoked` / `_exchange_failed`                | a console login token's life, by its public `jti`. `_exchange_failed` is a refusal of a token whose secret verified — replayed after use, revoked, expired, or put in a URL — and it is the tripwire, at ERROR                                                                                                                                                                                                 |
| `strad.connector_begin` / `_connected` / `_refused`                                    | a human consenting, in the console, for one slug                                                                                                                                                                                                                                                                                                                                                               |
| `strad.connector_connect_failed`                                                       | the deployment could not carry a connect through, at `begin` or `callback` — the config slug and a closed `reason`, at ERROR. On an OAuth client the console could not read, also the config `variable`, a closed `failure` word and the store's HTTP `status` as a number                                                                                                                                     |
| `strad.connector_client_granted`                                                       | the console bound its OWN credential `secretAccessor` on one of this slug's OAuth client secrets — the config slug and `variable`, and `result` (`granted` when the IAM policy was written, `already` when it already said so). A deliberate widening of what the console can read, so it is a record rather than a line on stderr                                                                             |
| `strad.connector_client_grant_failed`                                                  | that grant did not take — the config slug, a closed `reason`, and on a read failure the config `variable`, a closed `failure` word and the store's HTTP `status`, at ERROR. `reason: denied` is the one to alert on: the binding landed and the value still could not be read, which is what an IAM deny policy looks like                                                                                     |
| `strad.config_applied` / `strad.config_reloaded`                                       | the runtime server roster changed — the resulting slug list and the overlay `revision`. The first is a write through a door, the second is this process picking up another's. WHO made the change is deliberately absent: it is a person's email, and the stored overlay already carries it for the console                                                                                                    |
| `strad.config_reload_failed`                                                           | a roster the process would not adopt — `reason` is one of `unreadable` / `invalid` / `rebuild_failed`, computed here rather than taken from an exception                                                                                                                                                                                                                                                       |
| `telemetry.started`                                                                    | the event name only — the strad image's exporter came up. Its own fields are already resource attributes of the record carrying it                                                                                                                                                                                                                                                                             |

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

The connector events are the newest and the tightest. `slug` and `variable` come
from the **config** — the flow reads the slug out of sealed state and the variable
out of that server's `oauth:` block, never from a request — and `reason` on a
refusal is a `ConnectorErrorCode`: a closed set of strad's own words
(`account_mismatch`, `scope_not_granted`, `no_refresh_token`, …). Google's own
error bodies are read for nothing at all, not even for a message, so there is no
upstream text on this path to redact. `strad.connector_connect_failed` adds a
closed `stage` (`begin` or `callback`), and when the console cannot read the
slug's OAuth client, a closed `failure` word and the store's HTTP `status` as a
number, never its status text. The store's summary names the Secret Manager
resource, and it rides under `error`, which is on no list. Nothing derived from the credential — no
length, no prefix, no digest — exists anywhere in the flow to be exported. See
[Connectors](/operate/connectors/).

The **424's requested-server list** is filtered to slugs that actually exist in
the config, with the rest reduced to a count — `?servers=` is validated against
nothing, so it is one of the two places a client's own bytes reach strad's
vocabulary; the other is the tool name on a `tools/call`, which
[a policy refusal](#a-policy-refusal-the-count-and-the-slug-together) returns to. The same filtering applies to the `mcp.server` attribute on
`strad.mcp.unavailable`, where an unfiltered value would let any token holder
mint metric series at will.

Every exportable event a client can drive — `mcp.list_tools_failed`,
`mcp.list_resources_failed`, `mcp.list_retry`, `mcp.local_machine_offline`,
`mcp.server_unconfigured`, `mcp.policy_unmatched_tools`, `mcp.unavailable`,
`mcp.tool_denied`, `mcp.events_list_failed`, `strad.route_failed` and `console.token_exchange_failed` — is throttled to one exported record per bucket per minute,
for the same queue-starvation reason. The bucket is the slug, except for
`strad.route_failed`, which carries none and buckets on the route instead, so a
flood on one route cannot hide another route's first record, and
`console.token_exchange_failed`, which buckets on the token's `jti` and the
refusal's `state`. `strad.connector_client_grant_failed` is throttled per slug
beside `strad.connector_connect_failed`, for the same reason — a signed-in
session can press the repair button as often as it likes. A repeated fault is
therefore under-reported by up to a minute in the ingestor; the streams are never
throttled, and `strad.mcp.tool_surface` carries the same fact continuously. Fault events export at `SeverityNumber.ERROR`, so
`severity >= ERROR` finds them.

### The second table: what does not leave, and why

An empty slot in a deny-by-default allowlist reads the same whether it is a
verdict or nobody looking, and those are not the same fact. So `EXPORTABLE` has a
counterpart in the same file: **`NOT_EXPORTED`**, keyed the same way, whose values
are the reason. Eight events are on it.

| Event                                           | Why it stays on the stream                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `console.token_login_refused`                   | the unauthenticated half of the console token exchange — a garbled or unknown token, or none. `reason` is a closed set, but anyone who can reach the route produces one record per request: `mcp.auth_failed`'s argument, on the console door. A refusal of a token whose secret verified is `console.token_exchange_failed`, and that one ships                                          |
| `mcp.auth_failed`                               | its fields are safe, but it fires before authentication succeeds, so anyone who can POST `/mcp` could fill the batch queue and evict the signals that matter. `strad.mcp.auth_failures` counts the same thing by the same `reason`, in a channel with no queue to starve                                                                                                                  |
| `mcp.request`                                   | it fires on every authenticated request, which is `mcp.auth_failed`'s queue-starvation argument one token further in. Its fields would pass the field test — by that line `resolveSelection` has matched every requested slug against the entitled set — but the volume is the objection. The `mcp.request` span carries requested and selected; `strad.mcp.requests` counts the outcomes |
| `ui.playground.tool_call`                       | two of its three fields are ours, and `tool` is a string a human typed into a console text field. That leaves a slug-only shape — which `strad.mcp.tool_calls` with `strad.surface=playground` and `mcp.server` already carries, so an export minus `tool` would add nothing but a second spelling                                                                                        |
| `telemetry.disabled` / `telemetry.start_failed` | they fire around the lifecycle of the exporter that would carry them — one because none is configured, one because it failed to start — so `event()` finds no logger. One path is the exception: a throw from the runtime metrics or the browser hooks reaches `telemetry.start_failed` with a logger wired, and what it would add over its own name is `error`, which is on no list      |
| `errors.started` / `errors.start_failed`        | the same, one layer over: `startErrorReporter` runs before `startTelemetry`, so there is no log exporter yet to reach. `errors.started`'s fields are all safe and all unreachable                                                                                                                                                                                                         |

Those last four are the boot lines, and none of them is here for a redaction
reason — their fields would all pass the field test. Writing them down is the
point rather than an apology: when telemetry goes quiet, the line saying why is
on the container console and nowhere else.

### A policy refusal: the count and the slug, together

A `tools/call` the capability policy withholds throws **ahead of** the
`strad.mcp.tool_calls` block, so a refusal reaches that counter on no path at
all. It is answered by a pair instead, and the pair is the design:

- **`strad.mcp.tool_denials`**, a counter attributed by `mcp.server`,
  `strad.mode` and `strad.surface` — and by nothing else. It is deliberately not
  an `outcome` on `strad.mcp.tool_calls`, whose attributes include `mcp.tool`: a
  refusal happens precisely because no such tool exists, so the name on it is an
  unbounded series any token holder could mint.
- **the `mcp.tool_denied` record**, carrying `slug` and nothing else. By the
  line that logs it the slug has survived `selected.includes()` and
  `registry.get()`, so it is one of the config's own slugs rather than the raw
  string off the wire.

Two fields stay in the payload and off the allowlist. `tool` is the caller's own
bytes. `principal` is subtler, and is why the trace has to reach the call site:
through `router.ts` it is the token record's `pubid`, read out of the store — but
`buildGatewayServer` serves both doors, and through the
[playground](/auth/overview/#the-console-playground) the same field is the Google
`sub` of the signed-in human. One allowlist entry cannot say "ours here, theirs
there", so it does not ship.

The stream carries all three for whoever is diagnosing which tool a caller
wanted; the ingestor gets the slug and the count. This is the same answer
`strad.mcp.auth_failures` gives for `mcp.auth_failed`: when the field cannot
ship, the count does.

### The boot line that says the exporter came up

`telemetry.started` exports its **name and nothing else**, and the empty field
list is the verdict rather than a shortcut. Core's next exported record is
`strad.listening`, and between the two sits `Registry.build` — every stdio
process spawned, every remote upstream connected. A boot that dies in there
leaves a running exporter and no record at all, so "the container never started"
and "the container started, telemetry was fine, and boot died mounting a server"
look identical from the ingestor. With this on the list they do not: one of them
has a `telemetry.started` and nothing after it.

**It ships from the strad image alone**, and the entry claims nothing wider. The
bundle and every supplementary image boot through
`telemetry/bundle/instrument.mjs`, which configures a trace exporter and a metric
reader and no log record processor — so those containers ship no log records at
all, and their copy of this line is a `console.log`.

None of its five fields is exported. `service`, `component` and `environment` are
already resource attributes of every exported record (`service.name`,
`strad.component`, `deployment.environment`), so exporting them again is a second
spelling of the same field; a record that arrived has proved its own `endpoint`;
and `browser` belongs to the Chromium observables it installs, which report
themselves. `startTelemetry`'s `log` seam defaults to `event()` so that the entry
means something; the seam is still injectable, because a test wants the payload
rather than the stream. One consequence worth knowing: `telemetry.start_failed`
lands on **stderr**, under `event()`'s rule that a `_failed` name goes to stderr
whatever emitted it.

Every `evt:` literal under `src/` appears in exactly one of the two tables.
`test/telemetry.event-export-decisions.test.ts` reads the call sites as text and
fails the build for an event in both or in neither — so a new `event()` call is a
verdict somebody wrote, not a record that quietly reaches nobody. It also demands
that `evt` be written as a string literal, because one built from a variable would
be invisible to that scan.

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
is the source of truth; it is the `telemetry` entry in the vendoring manifest
(`scripts/sync-vendored.mjs`), `npm run telemetry:sync` copies it to seven targets,
and `test/vendored.sync.test.ts` fails CI if any copy drifts.

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
