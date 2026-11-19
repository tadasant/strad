---
title: VictoriaLogs
description: How strad hosts VictoriaMetrics' own MCP server for VictoriaLogs — a pinned Go binary in the bundle image, read-only, one instance per VictoriaLogs.
---

Query logs in a [VictoriaLogs](https://docs.victoriametrics.com/victorialogs/)
from an agent, in LogsQL: raw log lines, stats over time, hit counts, the most
frequent values of a field, and which streams and fields exist. The server is
VictoriaMetrics' own
[`VictoriaMetrics/mcp-victorialogs`](https://github.com/VictoriaMetrics/mcp-victorialogs)
(Apache-2.0), pinned at **v1.9.0**, running **inside strad's bundle image** at
`/victorialogs`.

It is the same shape as [Grafana](/servers/grafana/), and that page has the long
form of every choice below. VictoriaMetrics ships this server as a Go binary and
a Docker image and nothing else, and no strad server kind runs a local command,
so the binary is baked into the image: `servers/bundle/Dockerfile` fetches the
release, checks it against a SHA-256 digest committed in the repo, and installs
it at `/usr/local/bin/mcp-victorialogs`. `servers/victorialogs/` supervises it as
a stdio child and forwards `tools/list` and `tools/call`.

## Tools

Thirteen, every one annotated `readOnlyHint: true`. The binary wraps
VictoriaLogs' query API and nothing else, so there is no write to withhold and no
flag to pass:

| Tool                                                    | What it does                                                    |
| ------------------------------------------------------- | --------------------------------------------------------------- |
| `query`                                                 | Run a LogsQL query and return the matching log entries          |
| `stats_query`, `stats_query_range`                      | LogsQL `stats` at one instant, or over a range                  |
| `hits`                                                  | How many entries match, bucketed over time                      |
| `facets`                                                | The most frequent values of each field in the matching entries  |
| `field_names`, `field_values`                           | Which fields exist, and their values                            |
| `stream_field_names`, `stream_field_values`             | The same, for stream fields                                     |
| `streams`, `stream_ids`                                 | Which log streams match                                         |
| `flags`                                                 | The VictoriaLogs instance's non-default flags                   |
| `documentation`                                         | Search the VictoriaLogs docs embedded in the binary (no network) |

The tool list is read from the running binary on every `tools/list`, not copied
into this repo. The binary also declares prompts and resources (the same embedded
docs); strad forwards tools only.

## Configuring a slug

| Variable                   | Required | What it is                                                                                     |
| -------------------------- | -------- | ---------------------------------------------------------------------------------------------- |
| `VL_INSTANCE_ENTRYPOINT`   | yes      | The VictoriaLogs URL, or a proxy in front of one                                                |
| `VL_INSTANCE_BEARER_TOKEN` | no       | Sent as `Authorization: Bearer`                                                                |
| `VL_INSTANCE_HEADERS`      | no       | Extra headers, `Name=value,Name=value`, for a proxy that authenticates some other way           |
| `VL_DEFAULT_TENANT_ID`     | no       | `AccountID` or `AccountID:ProjectID`, for a multi-tenant VictoriaLogs                           |

A VictoriaLogs behind Grafana is reached through Grafana's datasource proxy, with
a Grafana service-account token as the bearer:

```yaml
- slug: victorialogs-example
  kind: supplementary-image
  image: ghcr.io/tadasant/strad-bundle:<version>
  bundle: bundle
  path: /victorialogs-example
  entitlements: [admin]
  env:
    VL_INSTANCE_ENTRYPOINT: https://grafana.example.com/api/datasources/proxy/uid/VictoriaLogs
    VL_INSTANCE_BEARER_TOKEN: "${GRAFANA_EXAMPLE_SERVICE_ACCOUNT_TOKEN}"
```

**One instance per slug.** An entrypoint is one VictoriaLogs, so a slug on
`path: /<its own slug>` gets its own mount and its own child process, built from
its own `<SLUG>__VL_INSTANCE_*` variables (the
[per-slug variable mechanism](/operate/secrets/)). Production and staging logs
are two slugs. Adding one is config alone.

Only the entrypoint is required, because a VictoriaLogs on a private network
commonly takes no credential. That makes one rule matter: **a per-slug instance
never inherits a sibling's bare token or headers.** The renderer gives each bare
name to the first slug that declares it, and a slug that declares no token of
its own would otherwise send another VictoriaLogs' credential to its own
entrypoint. The host drops them unless the slug carries its own.

## The child gets an allowlisted environment

The four variables above, `PATH`, `HOME`, `TMPDIR` and the two `SSL_CERT_*`
names, and nothing else from the container. `MCP_SERVER_MODE` is set to `stdio`
rather than inherited: a stray value would move the child onto a port and leave
the proxy waiting on a pipe. `MCP_DISABLED_TOOLS` is not passed, because the
gateway's `tools:` policy owns what a slug may call.

## Not configured is a supported state

The binary refuses to start without an entrypoint, and the mount still has to
list its tools so the console can show the slug. So an unconfigured mount starts
its child against `http://unconfigured.invalid`, a name that never resolves,
lists the binary's own thirteen tools, reports itself `degraded` on the bundle's
`/healthz`, and refuses every call by naming `VL_INSTANCE_ENTRYPOINT`. See
[Limitations #153](/limitations/).

:::caution
Through strad, this mount has met only a fake child and an entrypoint that does
not resolve. The same v1.9.0 binary ran against real VictoriaLogs from its Docker
image before strad hosted it. See [Limitations #153](/limitations/).
:::

## Version bumps

The pin is `MCP_VICTORIALOGS_VERSION` and a SHA-256 per architecture in
`servers/bundle/Dockerfile`. A digest that does not match fails the build. The
binary has no `--version`, so the digest is the only version check, and the
bundle smoke test's `victorialogs: 13` is what catches a changed surface.
