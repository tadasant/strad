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

The endpoint must speak **OTLP over HTTP/protobuf** — the OTLP spec's default for
the HTTP transport, port `4318` on a standard collector. strad appends the signal
paths itself, so give it the base URL (`https://host:4318`), not
`https://host:4318/v1/traces`.

Optional knobs, all standard: `OTEL_SERVICE_NAME`, `OTEL_RESOURCE_ATTRIBUTES`,
`OTEL_EXPORTER_OTLP_PROTOCOL`, `OTEL_METRIC_EXPORT_INTERVAL` (defaults to 15s, not
the usual 60s — a 60s window can miss the entire memory ramp that precedes an OOM
kill), `OTEL_TRACES_SAMPLER`.

:::caution[Don't set `OTEL_SERVICE_NAME` unless you mean it]
Left unset, each component names itself: `strad-core`, `strad-bundle-fetchpet`,
`strad-bundle-op-rw`, and so on. Setting `OTEL_SERVICE_NAME` collapses all ~13
processes into **one** service name — which is exactly the averaging that hides
which component is dying. If you do set it, split by the `strad.component`
resource attribute, which is always present.
:::

## What every component reports

Each of the ~13 processes carries these resource attributes:

- `service.name` — `strad-core`, `strad-<bundle>`
- `service.version` — the **image tag actually deployed**, not the VERSION file
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

The limit is read from the **cgroup**, not from `os.totalmem()`. This matters more
than it sounds: inside a 1GB App Platform container, `os.totalmem()` reports the
_host's_ memory (tens of GB), so a "percent memory used" computed the obvious way
reads a comfortable ~4% while the kernel is about to kill you.

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

`fetchpet`, `pointsyeah` and `good-eggs` each drive a real headless Chromium.

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
└── mcp.tools.call              (server slug, tool name, arg count, byte sizes, outcome)
    └── mcp.upstream.call_tool  (CLIENT; server slug, upstream kind, timeout, outcome)
```

W3C trace context (`traceparent`) is **injected** into every upstream hop, and
**extracted** on the way in — so a bundle running the strad image continues the
core's trace instead of starting a new one, and the whole request reads as a
single waterfall. (Injecting without extracting is a no-op with extra steps; a
test pins both halves.)

:::note[Scope of tracing]
Trace stitching works for **strad-image bundles**. The six **supplementary**
images (fetchpet, pointsyeah, good-eggs, bundle-api, onepassword, bundle-google)
run third-party server code and emit **metrics only** — no spans of their own.
The core's `mcp.upstream.*` span still measures each of those hops end-to-end
from the outside, so you can see _that_ bundle-fetchpet took 7.6s; you just can't
see inside it. Instrumenting those servers' own handlers is a separate job.
:::

**Metrics:** `strad.mcp.requests`, `strad.mcp.request.duration`,
`strad.mcp.in_flight` (concurrency), `strad.mcp.auth_failures` (401, by reason),
`strad.mcp.unavailable` (424 fail-closed, by server), `strad.mcp.tool_calls` and
`strad.mcp.tool_call.duration` (by server + tool), `strad.mcp.upstream.duration`
(**per-server latency — this is what shows you which server is starving the
others**), `strad.mcp.upstream.errors`, and `strad.mcp.upstream.timeouts`.

Timeouts get their own counter deliberately. The MCP SDK's request timeout
defaults to **60s and applies at every hop**, so a slow tool behind the gateway
dies at exactly 60s and presents as a mysterious platform failure. Counting them
separately turns that into a one-glance diagnosis.

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
closed set** of error kinds (`timeout`, `upstream_unavailable`, `not_selected`, …).

Two things that look like omissions and are not:

- **`recordException()` is never called.** It writes `exception.message` and
  `exception.stacktrace` as span-event attributes, and an upstream MCP server's
  error text is arbitrary text we did not author — it can echo the request back.
  Errors are _classified_ instead.
- **No OTLP log exporter is configured.** strad's stdout does contain upstream
  error messages, and that is fine where it is — stdout is the operator's own
  console. Shipping it to an external ingestor would drag those messages across
  this boundary. If you ever add a log exporter, redact those lines first.

`test/telemetry.redaction.test.ts` pins all of this: it drives a real MCP tool
call with a credential-shaped canary planted in **both** the arguments and the
result, serialises every exported span and metric, and asserts the canary appears
nowhere. It also asserts the useful signals _do_ emit — otherwise it would pass
happily on an implementation that exports nothing at all.

See `src/telemetry/redact.ts`.

## The bundle images

Every supplementary image (`fetchpet`, `pointsyeah`, `good-eggs`, `bundle-api`,
`onepassword`, `bundle-google`) boots via:

```dockerfile
CMD ["node", "--import", "./otel/instrument.mjs", "remote/build/index.js"]
```

`otel/instrument.mjs` is **vendored, byte-identical**, into each image — each image
is its own Docker build context and cannot `COPY` from the repo root, the same
reason `shared/` is vendored. Edit `telemetry/bundle/instrument.mjs`, run
`npm run telemetry:sync`, and commit both; `test/telemetry.sync.test.ts` fails CI
if a copy drifts.

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
