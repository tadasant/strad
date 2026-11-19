# appsignal — AppSignal in the strad bundle

Read-only access to one [AppSignal](https://www.appsignal.com) app: exception,
performance, log and anomaly incidents and their samples, log search, slow
requests, deploy markers, metrics, and a GraphQL escape hatch that only runs
queries. One personal API token and one app ID per slug.

The server is the AppSignal MCP server from
[`pulsemcp/mcp-servers`](https://github.com/pulsemcp/mcp-servers) (MIT), the
one published to npm as `appsignal-mcp-server`. strad hosts it in the bundle
image at `/appsignal`.

## Regime: PATCHED VENDOR

```
servers/appsignal/
  shared/            # pulsemcp/mcp-servers experimental/appsignal/shared, + delta 1
  shared/src/strad/  # strad's layer: the ONLY module the bundle host imports
  test/              # the delta's tests (outside shared/, which a re-vendor overwrites)
```

`shared/` is upstream `experimental/appsignal/shared` at **`cca9d52`** — the
commit it was last verified identical to — except for the rows below. Change
it here: strad improves its own servers rather than going upstream first.
Write any new change down as a row, with a test in `test/` that fails if a
re-vendor reverts it.

| Delta                           | Where                     | Why                                                                                                                                                                                                                                                         |
| ------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. A per-call app scope         | `shared/src/state.ts`     | Upstream reads the app ID from `process.env` or one module-wide variable. The bundle runs several AppSignal mounts in one process, each its own app, so `runWithAppId()` scopes it to one call chain with `AsyncLocalStorage`. Outside a scope, unchanged. |
| 2. strad's layer                | `shared/src/strad/`       | A new directory, not an edit. It is where the rules below live, so a re-vendor that copies upstream `src/` over `shared/src/` leaves them alone.                                                                                                              |
| 3. `schema.graphql` is copied   | `package.json` (tree root) | `get_graphql_schema` reads `build/graphql/schema.graphql` at call time, and upstream's `shared` build is a bare `tsc` that does not put it there. The root build copies it.                                                                                   |

Re-measure the regime with:

```bash
gh api repos/pulsemcp/mcp-servers/tarball/main > /tmp/up.tar.gz
mkdir -p /tmp/upx && tar xzf /tmp/up.tar.gz -C /tmp/upx
diff -rq /tmp/upx/pulsemcp-mcp-servers-*/experimental/appsignal/shared servers/appsignal/shared
```

The expected answer is `state.ts` differs and `strad/` exists only here, plus
anything upstream has changed since `cca9d52`.

## What the layer does

**Credentials are injected.** Upstream builds its client from
`process.env.APPSIGNAL_API_KEY`. The layer builds it per call from the
environment the bundle host hands it, which reads `<SLUG>__APPSIGNAL_API_KEY`
ahead of the bare name. That is what makes per-slug instances possible.

**One app per mount.** Upstream's app selection (`get_apps`, `select_app_id`,
`change_app_id`) writes one module-wide variable and changes the tool list
when it does. In a process that builds a fresh MCP server per request, a
selection would leak between slugs and between callers, and the gateway's
`tools:` policy would be checking a list that moves. So the layer always runs
upstream's **locked** mode: `APPSIGNAL_APP_ID` is required, and every call runs
inside `runWithAppId()` for it.

**`custom_graphql_query` runs queries only.** AppSignal's GraphQL schema has
mutations: archive an alert or a trigger, bulk-update incidents, create an app,
and more. Upstream forwards any document. The layer parses it and refuses a
`mutation` or `subscription` before anything is sent, so every tool on this
mount reads.

**The key stays out of results.** AppSignal's GraphQL API takes the key in the
URL's query string, so an error that quotes the request would quote the key.
Every text result is scrubbed of it.

## Environment

| Variable            | Required | What it is                                                                                         |
| ------------------- | -------- | -------------------------------------------------------------------------------------------------- |
| `APPSIGNAL_API_KEY` | yes      | A personal API token: appsignal.com → your avatar → **Personal settings** → **Personal API token** |
| `APPSIGNAL_APP_ID`  | yes      | The 24-character id in the app's URL: `https://appsignal.com/<org>/sites/<app id>/…`               |

There is no base-URL variable: AppSignal is one hosted service, and upstream's
client talks to `https://appsignal.com/graphql`.

A personal token reaches every app in every organisation its user belongs to,
and AppSignal issues nothing narrower. The app ID is what scopes a slug; the
token does not.

Without either variable the mount still lists its tools, so the console shows
what the slug would offer. The two schema tools work, since they read a file
shipped in this tree, and every other call fails naming the missing variable.

## Tools

Twenty, all read-only, in upstream's order:

| Tool                                                                            | What it reads                                                     |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `get_graphql_schema`, `get_graphql_schema_details`                              | The AppSignal GraphQL schema shipped in this tree (no API call)   |
| `get_exception_incidents`, `get_exception_incident`, `get_exception_incident_sample` | Exception incidents, one incident, one sample with its backtrace |
| `get_perf_incidents`, `get_perf_incident`, `get_perf_incident_sample`, `get_perf_incident_sample_timeline` | Performance incidents, their samples and timelines |
| `get_log_incidents`, `get_log_incident`, `search_logs`                          | Log incidents and log search                                      |
| `get_anomaly_incidents`, `get_anomaly_incident`                                 | Anomaly (alert) incidents                                         |
| `get_slow_requests`, `get_perf_samples`                                         | The slowest requests and recent performance samples               |
| `get_deploy_markers`                                                            | Recent deploys and the exceptions each brought                    |
| `get_metrics`, `get_metrics_timeseries`                                         | Metric lists and time series                                      |
| `custom_graphql_query`                                                          | Any GraphQL `query` against the API                               |

## Tests

```bash
cd servers/appsignal && npm ci && npm test
```

The suite drives the layer through a real MCP client over an in-memory
transport, against injected AppSignal clients, plus one call through upstream's
real client with `fetch` stubbed. Nothing in CI talks to AppSignal. The queries
themselves are upstream's, which ran against the real API as the npm package
PulseMCP used for its own apps; strad's layer has met only fakes.
