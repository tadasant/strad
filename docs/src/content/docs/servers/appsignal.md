---
title: AppSignal
description: How strad hosts the AppSignal MCP server — vendored from pulsemcp/mcp-servers with one delta, behind a layer that makes it one app per slug and read-only.
---

Read one [AppSignal](https://www.appsignal.com) app from an agent: exception,
performance, log and anomaly incidents and their samples, log search, slow
requests, deploy markers and metrics, plus a GraphQL escape hatch that only runs
queries. The server is the AppSignal MCP server from
[`pulsemcp/mcp-servers`](https://github.com/pulsemcp/mcp-servers) (MIT,
published to npm as `appsignal-mcp-server`), served at `/appsignal` in strad's
bundle image.

## How it is brought in

`servers/appsignal/shared` is upstream's `experimental/appsignal/shared` at
`cca9d52`, with one edit: `state.ts` scopes the app ID to one call. That makes the
tree **PATCHED VENDOR**: change it in strad, write the change down as a delta row
in `servers/appsignal/README.md`, and give it a test at the tree root, outside
the `shared/` a re-vendor overwrites.

The bundle host does not load upstream's server. It loads
`shared/src/strad/`, a layer of strad's own over upstream's tool definitions,
which is where strad's rules live:

- **Credentials are injected.** Upstream reads `process.env`. The layer builds
  the client per call from the environment the host hands this slug.
- **One app per mount.** Upstream can pick an app at runtime (`get_apps`,
  `select_app_id`) and stores it in one module-wide variable, which in a process
  serving several slugs would leak between them. The layer always runs
  upstream's locked mode: `APPSIGNAL_APP_ID` is required, and the tool list does
  not change at runtime.
- **Every tool reads.** AppSignal's GraphQL schema has mutations, and
  upstream's `custom_graphql_query` forwards any document. The layer parses it
  and refuses a `mutation` or `subscription` before anything is sent.
- **The key stays out of results.** AppSignal takes it in the URL's query
  string, so every result is scrubbed of it.

## Tools

Twenty, all read-only:

| Tool                                                                                      | What it reads                                                    |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `get_exception_incidents`, `get_exception_incident`, `get_exception_incident_sample`      | Exception incidents, one incident, one sample with its backtrace |
| `get_perf_incidents`, `get_perf_incident`, `get_perf_incident_sample`, `get_perf_incident_sample_timeline` | Performance incidents, samples and timelines |
| `get_log_incidents`, `get_log_incident`, `search_logs`                                    | Log incidents and log search                                     |
| `get_anomaly_incidents`, `get_anomaly_incident`                                           | Anomaly (alert) incidents                                        |
| `get_slow_requests`, `get_perf_samples`                                                   | The slowest requests and recent samples                          |
| `get_deploy_markers`                                                                      | Recent deploys and the exceptions each brought                   |
| `get_metrics`, `get_metrics_timeseries`                                                   | Metric lists and time series                                     |
| `get_graphql_schema`, `get_graphql_schema_details`                                        | The GraphQL schema shipped in the tree (no API call)             |
| `custom_graphql_query`                                                                    | Any GraphQL `query`                                              |

## Configuring a slug

| Variable            | Required | What it is                                                                        |
| ------------------- | -------- | --------------------------------------------------------------------------------- |
| `APPSIGNAL_API_KEY` | yes      | A personal API token, from AppSignal's **Personal settings**                      |
| `APPSIGNAL_APP_ID`  | yes      | The app's id, from its URL: `https://appsignal.com/<org>/sites/<app id>/…`         |

There is no base URL: AppSignal is one hosted service. One slug is one app, so
production and staging are two slugs, each on `path: /<its own slug>`, which the
bundle host mounts as two instances from their own `<SLUG>__APPSIGNAL_*`
variables:

```yaml
- slug: appsignal-example-prod
  kind: supplementary-image
  image: ghcr.io/tadasant/strad-bundle:<version>
  bundle: bundle
  path: /appsignal-example-prod
  entitlements: [admin]
  env:
    APPSIGNAL_API_KEY: "${APPSIGNAL_API_KEY}"
    APPSIGNAL_APP_ID: 0123456789abcdef01234567
```

Both variables are required to discover a per-slug instance, so an instance
never runs on a sibling's bare value. Without them, the conventional
`/appsignal` mount lists its twenty tools, reports itself `degraded`, serves the
two schema tools, and refuses every other call by naming what is missing.

## What a token can reach

:::caution
The token is broader than the slug, it travels in the request URL, and strad's
layer has met only fakes. See [Limitations #154](/limitations/).
:::


A personal API token reaches every app in every organisation its user belongs
to; AppSignal issues nothing narrower. `APPSIGNAL_APP_ID` scopes the seventeen app
tools, but `custom_graphql_query` can read any app the token can see by naming
it. A slug's real boundary is the user the token belongs to. See
[Limitations #154](/limitations/).
