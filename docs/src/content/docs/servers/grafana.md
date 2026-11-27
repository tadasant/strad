---
title: Grafana
description: How strad hosts Grafana's own MCP server — a pinned Go binary baked into the bundle image and proxied to — why it is read-only at the binary rather than at the gateway, how a separate slug opts into writes, and how one mount backs more than one Grafana.
---

Query a Grafana from an agent: dashboards, Prometheus, Loki, alert rules,
incidents, and — through `grafana_api_request` — anything else its HTTP API
serves. The server is Grafana Labs' own
[`grafana/mcp-grafana`](https://github.com/grafana/mcp-grafana), pinned at
**v0.17.1**, running **inside strad's bundle image**.

That last part is the whole design. Everything else on this page follows from
one fact: Grafana ships this server as a **Go binary and a Docker image**, and as
nothing else.

## Why it is baked into the image

**No strad server kind runs a local command.** There is no
`command:` in the config schema, deliberately: a gateway whose config can spawn
processes on the box is a different security posture than one that cannot.

So a server with no npm package has two honest options: front it with a
`remote-http` slug and host it somewhere, or **put it in the image**. strad does
the second. `servers/bundle/Dockerfile` fetches the pinned release, verifies its
SHA-256 against a digest committed in this repo, and installs it at
`/usr/local/bin/mcp-grafana`. `servers/grafana/` is the other half: a small MCP
proxy that supervises the binary as a **stdio child process** and forwards
`tools/list` and `tools/call` to it.

From the outside it is an ordinary mount. A slug names `path: /grafana-registry`,
strad's gateway proxies to it over the private network, and nothing in the config
knows a Go binary is involved.

### What this replaced

The same server used to run **agent-side**, as a ~900-character `sh -c` in every
client's MCP config that curled the pinned release into `$TMPDIR`, verified it,
cached it and exec'd it — on every fresh session, on every machine. Two things
were wrong with that, and neither was the shell script:

- **The credential lived in the client.** A Grafana service-account token was an
  environment variable on whatever ran the agent, which is exactly the thing
  strad's parameter store exists to stop. Hosted here, the token is a
  `${GRAFANA_REGISTRY_SERVICE_ACCOUNT_TOKEN}` reference resolved at render time
  and injected onto one container.
- **Every machine re-downloaded the binary.** Baked into the image, it is pulled
  once per deploy.

## Read-only at the binary

By default the child process runs with two flags:

- **`-disable-write`** removes the 13 write tools (create/update/delete of
  dashboards, datasources, folders, annotations, incidents and snapshots) and
  narrows the alerting tools to their read actions. **65 tools become 52.**
- **`-disable-proxied`** removes "proxied" tools — tools `mcp-grafana`
  discovers at startup from MCP servers advertised by the Grafana's own
  **datasources**. Their names, schemas and side effects are authored by whoever
  administers that Grafana, `-disable-write` does not constrain them, and a
  surface that changes when a datasource does cannot be enumerated by the
  [pre-deploy tool-policy gate](/operate/deploy-model/).

This is a **deliberate exception** to how capability works everywhere else in the
bundle. Every other upstream in that image runs at full capability and strad's
gateway withholds tools per slug ([Concepts](/intro/concepts/)). A gateway policy
can only ever *withhold* a tool; a flag at the binary means the tool **is not in
the process**. For a fleet's observability control plane — where a wrong write is
an alert rule or a dashboard nobody notices is gone — the stronger guarantee is
worth the inconsistency.

The consequence is stated rather than hidden: **a read-write Grafana is a second
mount, never this one with a flag removed.**

## A write-enabled slug

A deployment that needs Grafana's write tools gives them to a **separate slug**,
on its own `path: /<its own slug>`, and opts that slug in under its own name:

```yaml
- slug: grafana-pulsemcp-prod-rw
  kind: supplementary-image
  image: ghcr.io/tadasant/strad-bundle:latest
  bundle: bundle
  path: /grafana-pulsemcp-prod-rw
  env:
    GRAFANA_PULSEMCP_PROD_RW__GRAFANA_URL: https://obs.pulsemcp.com
    GRAFANA_PULSEMCP_PROD_RW__GRAFANA_SERVICE_ACCOUNT_TOKEN: "${GRAFANA_PROD_RW_SERVICE_ACCOUNT_TOKEN}"
    GRAFANA_PULSEMCP_PROD_RW__GRAFANA_ALLOW_WRITE: "true"
```

What that does, exactly:

- **`<SLUG>__GRAFANA_ALLOW_WRITE` set to exactly `true`** starts that slug's child
  without `-disable-write`: the 13 write tools exist and the alerting tools keep
  their write actions, so the mount serves **65 tools**. Any other value — `1`,
  `yes`, `TRUE`, an empty string — or no value at all keeps it read-only.
- **`-disable-proxied` stays on.** Opting into Grafana's own writes is not opting
  into tools a datasource advertises; those are still authored by the Grafana's
  administrator and still off on every mount.
- **It is never inherited.** The bundle host reads the opt-in under the slug's
  own name and nowhere else. A bare `GRAFANA_ALLOW_WRITE` on the container — which
  the renderer emits beside the per-slug name when a server's `env:` writes the
  bare key — and another slug's value are both ignored, so every other Grafana
  slug, the conventional `/grafana` included, stays read-only.
- **A store-served instance follows the same rule.** It reads the opt-in from the
  container's `<SLUG>__GRAFANA_ALLOW_WRITE`, never from a value seeded in its
  namespace, so writes on an instance are a deploy-time decision that no runtime
  parameter write can make.
- **The child never sees it.** It decides the flags strad starts the binary with;
  it is not on the child's environment allowlist below.
- **The boot log says so.** The host logs `<slug>: WRITE-ENABLED …` when it loads
  the mount, and the child's start line reads `mcp-grafana up, WRITE-ENABLED …`
  rather than `mcp-grafana up, read-only …`.

The binary flag is the capability; the service-account token's Grafana role is
the authorisation. Give a write-enabled slug a token whose role can write, give
the read-only slugs Viewer tokens, and narrow the write slug further with
`tools:` if it should hold only some of the 65.

## One mount, more than one Grafana

A Grafana service-account token is *one Grafana*, the same way an OAuth refresh
token is [one Google account](/servers/google-sheets/). So the mount takes its
origin and its credential from the environment, and the bundle host stands up
**one instance — and one child process — per slug** that the container carries a
complete credential for.

| variable | what it is |
| --- | --- |
| `GRAFANA_URL` | the Grafana origin, e.g. `https://grafana.prod.registry.modelcontextprotocol.io` |
| `GRAFANA_SERVICE_ACCOUNT_TOKEN` | a service-account token; both are required for a per-slug instance |
| `GRAFANA_ORG_ID` | optional, for a Grafana with more than one organisation |
| `GRAFANA_ALLOW_WRITE` | optional; exactly `true` under the slug's own name makes it [write-enabled](#a-write-enabled-slug) |

A slug on `path: /<its own slug>` is handed its own values under
`<SLUG>__<NAME>`; that is the general
[per-slug variable mechanism](/operate/secrets/), and Grafana is one of the four
trees that reads it.

The conventional `/grafana` mount is **always** served, so the slug and its 52
tools are visible in the console before any credential exists. Be precise about
what it holds, though: the renderer emits every supplementary server's variables
under the **bare** name as well as the per-slug one, and an instance with no
per-slug names of its own falls back to the bare ones. So on a container where
`grafana-registry` is the only Grafana slug, `/grafana` comes up holding *that*
slug's URL and token rather than degraded. Nothing routes to it — no config entry
names `path: /grafana` — but it is a live mount, not an empty one, and a
deployment that wants `/grafana` to mean obs.tadasant.com should say so with its
own `grafana` slug rather than rely on the fallback.

Which means **adding a second Grafana is config alone**: a new slug, its own
`path: /<slug>`, its own two variables. No image change.

## The child gets an allowlisted environment

Every other mount in that image is code inside the host process. This one is a
separate executable, and a child spawned with the default environment inherits
**the whole container's**: a Slack bot token, a 1Password service-account token, a
GCP service-account key, six Google OAuth refresh tokens. `mcp-grafana` needs none
of them, and it has a tool that makes arbitrary HTTP requests to a host somebody
else configures.

So the child is given an explicit list and nothing else: the three Grafana
credential variables above (never `GRAFANA_ALLOW_WRITE`), plus `PATH`, `HOME`, `TMPDIR` and the two `SSL_CERT_*` names Go
reads for a private CA. `OTEL_*` is deliberately excluded — `mcp-grafana` can
export its own traces and logs, and those are records strad did not author
arriving outside [the telemetry allowlist](/operate/telemetry/).

## Not configured is a supported state

A mount with no credential still **lists its 52 tools** — `mcp-grafana` builds
its tool surface without contacting Grafana at all — and reports itself
`degraded` on the bundle's `/healthz`, naming the variables it is missing. Only
calls fail. One unconfigured server must never cost the other twenty mounts their
boot, and a slug that cannot be seen is a slug nobody can seed.

The same applies when the binary itself cannot be started: the mount degrades,
the container keeps serving, and the **next** call retries — a child that was
OOM-killed comes back rather than staying dead until a redeploy.

## The staging slug

`grafana-registry` points at
`https://grafana.prod.registry.modelcontextprotocol.io` — the observability plane
for the **MCP Registry's** own GKE cluster (VictoriaMetrics + VictoriaLogs + an
OpenTelemetry collector). It is a *different* Grafana from `obs.tadasant.com`,
which is the dashboard plane for the Tadas/Zimmer/strad fleet: use this one for
the registry's own traffic, and nothing else.

It ships `enabled: false` until its token is seeded, like every entry whose
secret is not in the store yet — [an unseeded `${NAME}` fails the whole
render](/operate/operations/#a-server-whose-secret-is-not-seeded-yet), not just
its own slug. Minting that token needs admin on the registry's Grafana, whose
only interactive login is Google OAuth restricted to `@modelcontextprotocol.io`,
so it comes from an MCP Registry maintainer rather than from a tadasant.com
account.

Two things are worth knowing before querying it:

- Its datasources are provisioned **without pinned UIDs**, so the VictoriaLogs
  UID is a Grafana-generated string rather than the friendly `VictoriaLogs` that
  `obs.tadasant.com` uses. Call `list_datasources` first.
- Logs come through `grafana_api_request` against the datasource proxy, e.g.
  `GET /api/datasources/proxy/uid/<UID>/select/logsql/query?query=*&start=15m&limit=100`,
  or through a [VictoriaLogs](/servers/victorialogs/) slug pointed at that same
  proxy URL, which speaks LogsQL natively. Staging has no such slug.

## Version bumps

The pin lives in `servers/bundle/Dockerfile` as `MCP_GRAFANA_VERSION` plus a
SHA-256 digest per architecture. Bumping it means changing all three; a digest
that does not match fails the build rather than shipping. If the release changes
the read surface, the bundle smoke test's `grafana: 52` fails CI (it counts the
conventional, read-only `/grafana`; a write-enabled slug's 65 is not asserted
there) — which is the
point of asserting a count nobody can predict from reading the diff. See
[Limitations #68](/limitations/).
