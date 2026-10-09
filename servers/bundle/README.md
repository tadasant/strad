# bundle — THE strad supplementary image

Twenty-five MCP servers. One container. One Chromium. One `op` binary. One
`mcp-grafana` binary.

```
/slack /serpapi-hotels /tailscale /monarch-money /gcs /remote-filesystem-tmp-public
/x-twitter /telegram /whatsapp /bill-spend /aws-device-farm /liveoak /pulse-subregistry
/strad-fetch /grafana
/google-flights /gmail /google-calendar /google-docs /google-sheets
/onepassword /secrets
/good-eggs /fetchpet /pointsyeah
```

Twenty-five is the floor, not a constant: four of those mounts (`/telegram`,
`/remote-filesystem-tmp-public`, `/google-sheets`, `/grafana`) are re-mounted once
more per slug the container holds a separate credential for. `/google-sheets` is
the one a real deployment uses that way — an OAuth refresh token is one Google
account, so six `google-sheets-*` slugs over three accounts are three more mounts.
`/grafana` is the same shape for the same reason: a Grafana service-account token
is one Grafana, so `grafana-registry` is its own mount and its own child process.

strad's staging app is **three components**: `core` (the public gateway),
`bundle` (this), and `bundle-zimmer-secrets` — a second copy of this image that
exists only because a parameter store is `process.env` and a container has one of
those. `bundle-whatsapp` becomes a fourth once `whatsapp-zimmer` is enabled: a
third copy of this image, at one instance, that holds the one WhatsApp
linked-device socket. It used to be thirteen, for a much worse reason.

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

`grafana` is the one exception, and it is deliberate: its child process runs with
`-disable-write`, so the 13 write tools are not in it to withhold. See below.

This host therefore **scrubs** every `*_ENABLED_TOOLGROUPS`-shaped variable out of
its environment at boot. A stale one would not just be ignored — it would strip
write tools from the read-**write** slugs too, and the failure would look like an
upstream bug.

## How seventeen projects become one image

`Dockerfile`'s build context is the **repo root**, because the servers live in
seventeen different places:

| tree | source | servers |
| --- | --- | --- |
| `bundle-api` | `servers/bundle-api` | slack, serpapi-hotels, tailscale, monarch-money, gcs, google-flights |
| `bundle-google` | `images/bundle-google` | gmail, google-calendar, google-docs, google-sheets |
| `onepassword` | `servers/onepassword` | onepassword (+ the `op` CLI, baked in) |
| `secrets` | `servers/secrets` | secrets (Google Parameter + Secret Manager viewer) |
| `remote-filesystem` | `servers/remote-filesystem` | remote-filesystem-tmp-public (strad's artifact store) |
| `x-twitter` | `servers/x-twitter` | x-twitter |
| `pulse-subregistry` | `servers/pulse-subregistry` | pulse-subregistry |
| `strad-fetch` | `servers/strad-fetch` | strad-fetch (web fetching, strad's own fork) |
| `grafana` | `servers/grafana` | grafana (proxies the pinned `mcp-grafana` Go binary, baked in) |
| `telegram` | `servers/telegram` | telegram (MTProto, a user session) |
| `whatsapp` | `servers/whatsapp` | whatsapp (a WhatsApp linked device, Baileys) |
| `bill-spend` | `servers/bill-spend` | bill-spend (BILL Spend & Expense transaction coding) |
| `aws-device-farm` | `servers/aws-device-farm` | aws-device-farm (a real iPhone, driven over the session's Appium endpoint) |
| `liveoak` | `servers/liveoak` | liveoak (LiveOak Bank statements, read-only, as a remembered Cognito device) |
| `good-eggs` | `servers/good-eggs` | good-eggs |
| `fetchpet` | `servers/fetchpet` | fetchpet |
| `pointsyeah` | `servers/pointsyeah` | pointsyeah |

Each is built **in its own stage, with its own lockfile and its own
`node_modules`**, exactly as its standalone image builds it, and lands at
`/app/trees/<name>`. Nothing is merged. Merging seventeen dependency trees is how
you find out in production that two of them wanted different Playwright versions.

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

## The one upstream that is not JavaScript

Grafana ships its MCP server as a **Go binary** and a Docker image, and as
nothing else — there is no npm package to build into a tree. no strad server kind
runs a local command, so the way to host it is to bake it: `Dockerfile` fetches the pinned release, verifies its SHA-256
against a digest **in this repo** (not against the checksums file the same server
serves), and puts it on PATH. `servers/grafana` is the other half — an MCP proxy
that supervises the binary over stdio and forwards `tools/list` and `tools/call`
to it.

**Read-only at the binary, not at the gateway.** The child runs with
`-disable-write` (drops the 13 write tools, narrows alerting to its read actions:
65 tools become 52) and `-disable-proxied` (Grafana datasources can advertise
external MCP servers whose tools `-disable-write` does not constrain, and whose
names change under a mount that is supposed to enumerate 52). A gateway policy
can only ever *withhold* a tool; this is the stronger claim, and for a fleet's
observability control plane it is worth the exception. Writes are added by
adding a second mount, never by loosening this one.

**One child per slug.** A Grafana service-account token is one Grafana, so
`grafana-registry` (the MCP Registry's cluster) and a future `grafana`
(obs.tadasant.com) are two mounts and two child processes, discovered from the
environment exactly as telegram's and google-sheets' extra instances are.

**The child gets an allowlisted environment**, not this container's. Every other
mount is code inside the host process; this one is a separate executable, and a
child spawned with the default environment would inherit a Slack token, a
1Password token, a GCP service-account key and six Google refresh tokens. It gets
`GRAFANA_URL`, `GRAFANA_SERVICE_ACCOUNT_TOKEN`, an optional `GRAFANA_ORG_ID` and
four process variables. `servers/grafana/shared/src/config.ts` is that list.

## The GCS_BUCKET collision

`gcs` and `remote-filesystem-tmp-public` both want `GCS_BUCKET`, and they point at
different buckets. That is why `gcs` used to need a component to itself, and it is
the one thing gateway-side capability does *not* solve — it is a credential, not a
capability.

One process cannot hold two values of one variable, so the artifact store never
reads the bare names. The host constructs it with
`envPrefix: "REMOTE_FILESYSTEM_TMP_PUBLIC"` and every key it needs — bucket,
project, credentials, viewer domain — is read under that prefix. `gcs` keeps the
bare names. See `servers/remote-filesystem/README.md`.

## The one server whose safety is not in this image

`secrets` lists parameter NAMES, KINDS and NOTES from Google Parameter Manager,
and reads NON-SECRET values — but it can never return a SECRET value, and not
because of anything in this container. It is because the service account strad
injects here holds Parameter Manager viewer access and NOT
`secretmanager.versions.access`, so Google refuses the secret. The credential that
CAN read a secret value lives on the **core** component, behind the console's SSO
gate, and never reaches this process (see `consoleEnv:` in `src/config/schema.ts`).

This host must not undo that. There is no write tool to add, and no key here that
could perform one. See [`servers/secrets/README.md`](../secrets/README.md).

## Blast radius, honestly

Twenty-five servers share a process. A crash is a twenty-five-server outage. Everything
that *can* be made survivable is:

- a browser server whose **login fails** is marked `degraded` in `/healthz`; the
  container keeps serving. (The standalone images `process.exit(1)` here — correct
  when the process *is* the server, catastrophic when it is twenty-four others too.)
  For fetchpet the mark is a report on the last attempt: the next tool call retries
  the login and a success clears it, so a form that changed and was fixed does not
  cost a redeploy. good-eggs still holds its first failure until the container
  restarts.
- **1Password without an elicitation posture** refuses to mount, rather than
  refusing to boot.
- **secrets without a managed namespace** refuses to mount — an unscoped
  secrets server would see every parameter in the project — rather than mounting
  wide open.
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
upstream credentials, which is why CI runs it on every PR. For `secrets` the count
(4) is a security assertion: a fifth tool on a server whose contract is "no tool
returns a SECRET value" is exactly what CI should catch.

It does need the one credential the mounts are gated on: it reads
`STRAD_INTERNAL_TOKEN` out of the container's own environment and presents it as a
bearer token, exactly as core does. A deployed container always has it. A
container run without one fails closed and every mount answers `503`, which the
script reports as such rather than as a broken mount.
