# bundle — THE strad supplementary image

Fourteen MCP servers. One container. One Chromium. One `op` binary.

```
/slack /serpapi-hotels /tailscale /monarch-money /gcs /remote-filesystem
/google-flights /gmail /google-calendar /google-docs /onepassword
/good-eggs /fetchpet /pointsyeah
```

strad's staging app is now **two components**: `core` (the public gateway) and
`bundle` (this). It used to be thirteen.

## Why this could not exist before

A server's capability used to be a **container** env var —
`GMAIL_ENABLED_TOOLGROUPS=readonly` produced a process that did not contain a
write tool. An App Platform component's env is the **union** of its servers' env
maps, so `gmail-ro` (`=readonly`) and `gmail-rw` (`=readwrite`) wanted two values
of one variable. They could not share a container, so **every capability variant
bought its own billed component**: 12 bundles for 26 servers.

Capability now lives in the **gateway** (`src/gateway/toolPolicy.ts`): each strad
server config carries a `tools:` allow/deny policy that strad enforces on
`tools/list` *and* on `tools/call`. So this container runs every upstream at
**full capability**, and `gmail-ro` and `gmail-rw` are two strad slugs pointing at
the same path in this one container.

This host therefore **scrubs** every `*_ENABLED_TOOLGROUPS`-shaped variable out of
its environment at boot. A stale one would not just be ignored — it would strip
write tools from the read-**write** slugs too, and the failure would look like an
upstream bug.

## How six projects become one image

`Dockerfile`'s build context is the **repo root**, because the servers live in six
different places:

| tree | source | servers |
| --- | --- | --- |
| `bundle-api` | `servers/bundle-api` | slack, serpapi-hotels, tailscale, monarch-money, gcs, remote-filesystem, google-flights |
| `bundle-google` | `images/bundle-google` | gmail, google-calendar, google-docs |
| `onepassword` | `servers/onepassword` | onepassword (+ the `op` CLI, baked in) |
| `good-eggs` | `servers/good-eggs` | good-eggs |
| `fetchpet` | `servers/fetchpet` | fetchpet |
| `pointsyeah` | `servers/pointsyeah` | pointsyeah |

Each is built **in its own stage, with its own lockfile and its own
`node_modules`**, exactly as its standalone image builds it, and lands at
`/app/trees/<name>`. Nothing is merged. Merging six dependency trees is how you
find out in production that two of them wanted different Playwright versions.

`host/` imports across the trees **by path** (`src/trees.ts`). Node resolves each
shared package's own imports from its own tree, so no upstream server runs
anything different than it did before. Each mount also builds its `Server` and
transport from **its own tree's copy of the MCP SDK**, so the Zod schemas its
handlers register with and the server they are registered on always match.

## One Chromium, three browser servers

good-eggs, fetchpet and pointsyeah each used to launch a browser, because each
used to be its own component. Three Chromiums on one shared vCPU is three ~545MB
peaks fighting over one core — and CPU, not RAM, is what binds a headless Chromium
here.

So the host launches **one** browser (`src/browser.ts`), with the same
playwright-extra stealth plugin the servers used to apply themselves — stealth
patches the `Browser` object, so contexts opened on it by any of the three are
evasion-equipped — and hands it to each through a `setSharedBrowserProvider` seam.
Each server still opens its **own context**: good-eggs' logged-in session cannot
see fetchpet's cookies. If the browser dies, the next caller relaunches it.

Measured, two browser servers logging in at once: **one** Chromium process tree,
~940MB RSS across it (mostly shared), ~760MB container working set. Hence the 2GB
instance in `infra/strad.staging.yaml`.

## The GCS_BUCKET collision

`gcs` and `remote-filesystem` **both read `GCS_BUCKET`**, and they point at
different buckets. That is why `gcs` used to need a component to itself, and it is
the one thing gateway-side capability does *not* solve — it is a credential, not a
capability.

One process cannot hold two values of one variable, so `remote-filesystem` stops
reading the environment: the host hands it an explicit client built from
`REMOTE_FILESYSTEM_GCS_*`. `gcs` keeps the bare names.

## Blast radius, honestly

Fourteen servers share a process. A crash is a fourteen-server outage. Everything
that *can* be made survivable is:

- a browser server whose **login fails** is marked `degraded` in `/healthz`; the
  container keeps serving. (The standalone images `process.exit(1)` here — correct
  when the process *is* the server, catastrophic when it is thirteen others too.)
- **1Password without an elicitation posture** refuses to mount, rather than
  refusing to boot.
- an **unhandled rejection** is logged, not fatal.
- a **dead Chromium** is relaunched on next use.

What is still fatal is a genuine process-level failure — OOM above all. That is
what the OpenTelemetry instrumentation is there to watch: event-loop lag, RSS
against the container limit, and Chromium launches/crashes.

## Smoke test

```
docker exec <container> node /app/scripts/smoke.mjs [--tools]
```

Lists tools from every mount and asserts the full-capability counts. It needs no
credentials, which is why CI runs it on every PR.
