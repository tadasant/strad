# bundle-api — seven pure-API MCP servers in one strad bundle

`bundle-api` is a strad [`supplementary-image`](../../docs/src/content/docs/servers/adding.md)
bundle that hosts **seven credential-free, pure-HTTP/API MCP servers** in a
single internal Node process:

| slug | upstream server | tools |
| --- | --- | --- |
| `slack` | Slack workspace | messaging / channels |
| `serpapi-hotels` | SerpApi Google Hotels | hotel search |
| `tailscale` | Tailscale VPN | policy / devices / keys |
| `monarch-money` | Monarch Money | personal finance |
| `gcs` | Google Cloud Storage | object storage |
| `remote-filesystem` | GCS-backed filesystem | file read/write |
| `google-flights` | Google Flights | flight search |

None of these drives a browser or spawns a subprocess — they are all HTTP/API
wrappers — so unlike [good-eggs](../good-eggs) (which needs a Chromium base and
its own bundle) they colocate happily in one small `node:22-slim` image at ~$0
marginal cost each.

## Layout

```
servers/bundle-api/
  upstream/<slug>/   # VENDORED VERBATIM from pulsemcp/mcp-servers@44f32a32
                     #   (each server's shared/ tool-logic factory)
  remote/            # NEW streamable-HTTP host over all seven createMCPServer()s
  Dockerfile         # node:22-slim -> ghcr.io/tadasant/strad-bundle-api
```

The `upstream/<slug>` directories are each an upstream server's `shared/`
package, copied verbatim (fixes go upstream, then re-vendor — see HACKS.md).
`remote/src/index.ts` reuses each one's `createMCPServer()` factory; **no tool
logic is reimplemented**. It swaps stdio for an Express front door speaking
`StreamableHTTPServerTransport` (`sessionIdGenerator: undefined`), mounting each
server at `/<slug>`. strad's core gateway proxies to it over the private network
at `${bundle-api.PRIVATE_URL}/<slug>`.

Per request we mint a fresh, stateless MCP `Server` + transport and reuse the
factory's `registerHandlers`. Each factory is created ONCE at startup (tailscale
memoizes an OAuth client; monarch threads a single session store). Credentials
are read LAZILY, when a tool is invoked — this image holds none; strad injects
them onto the component at deploy time.

## Credentials (injected downstream, never baked in)

The image is credential-free. Each server reads its own env vars at runtime;
strad supplies them via the config `env:` map (`${NAME}` refs resolved onto this
bundle only). Non-exhaustive, per server:

- **slack** — `SLACK_BOT_TOKEN` (required)
- **serpapi-hotels** — `SERPAPI_API_KEY` (required)
- **tailscale** — `TAILSCALE_API_KEY` **or** `TAILSCALE_OAUTH_CLIENT_ID` + `TAILSCALE_OAUTH_CLIENT_SECRET`; optional `TAILSCALE_TAILNET`, `TAILSCALE_API_URL`
- **monarch-money** — optional at boot (`MONARCH_SESSION_TOKEN`, or `MONARCH_EMAIL` + `MONARCH_PASSWORD` [+ `MONARCH_TOTP`/`MONARCH_EMAIL_OTP`]); `MONARCH_SESSION_PASSPHRASE`, `MONARCH_STATE_DIR`
- **gcs** — `GCS_PROJECT_ID` (required) + auth (`GCS_SERVICE_ACCOUNT_KEY_JSON`/`_FILE`, or ADC); optional `GCS_BUCKET`
- **remote-filesystem** — `GCS_BUCKET` (required) + creds (`GCS_CLIENT_EMAIL` + `GCS_PRIVATE_KEY`, or `GOOGLE_APPLICATION_CREDENTIALS`, or ADC); optional `GCS_PROJECT_ID`, `GCS_ROOT_PATH`, `GCS_MAKE_PUBLIC`
- **google-flights** — none (public endpoints)

> **Colocation note.** `gcs` and `remote-filesystem` both read `GCS_PROJECT_ID`
> and `GCS_BUCKET`. In one process they share those values; give them distinct
> GCS config only if the downstream deployment needs it (it can, by splitting
> them into separate bundles — but that is a tadasant-internal config decision,
> not something this OSS image bakes in).

## Capability toggles

Several servers expose a **read-only / read-write / tool-group** env var, read
synchronously when a request registers handlers. This image only **exposes and
honors** them; it does NOT bake in read-only vs read-write variants — that split
is a tadasant-internal config decision.

| server | upstream env var | values | default |
| --- | --- | --- | --- |
| `slack` | `ENABLED_TOOLGROUPS` | `readonly`, `write` (CSV) | all groups |
| `tailscale` | `TOOL_GROUPS` | `policy`,`devices`,`keys` (+ `_readonly` each) | all, read+write |
| `monarch-money` | `MONARCH_ENABLED_TOOL_GROUPS` | `readonly`, `manage` | all tools |
| `gcs` | `GCS_ENABLED_TOOLGROUPS` | `readonly`, `readwrite`, `delete` (CSV) | all groups |
| `remote-filesystem` | `ENABLED_TOOLGROUPS` | `readonly`, `readwrite` | all groups |
| `serpapi-hotels` | — (none) | | |
| `google-flights` | — (none) | | |

`monarch-money` and `gcs` also accept exact-name allow/deny lists
(`MONARCH_ENABLED_TOOLS`/`MONARCH_DISABLED_TOOLS`,
`GCS_ENABLED_TOOLS`/`GCS_DISABLED_TOOLS`), and `gcs` accepts `GCS_BUCKET` to pin
all operations to one bucket. These are unique names and pass straight through.

### The `ENABLED_TOOLGROUPS` collision, and the slug-namespaced override

`slack` and `remote-filesystem` read the **same** upstream var,
`ENABLED_TOOLGROUPS`. A single process-wide value can't configure them
independently, so `remote/` ALSO accepts a **slug-namespaced override** for any
toggled server:

```
<SLUG>_<UPSTREAM_VAR>
```

e.g. `SLACK_ENABLED_TOOLGROUPS=readonly` and
`REMOTE_FILESYSTEM_ENABLED_TOOLGROUPS=readwrite` configure the two independently.
When set, the override is applied onto the bare upstream name for the duration
of that one registration only (synchronously, before any `await`, so it never
leaks across concurrent requests). Unset → the bare upstream var applies as-is.
The same slug-prefixed form works for every toggled server
(`TAILSCALE_TOOL_GROUPS`, `MONARCH_MONEY_MONARCH_ENABLED_TOOL_GROUPS`,
`GCS_GCS_ENABLED_TOOLGROUPS`), though only slack/remote-filesystem strictly need
it.

## Build

```
npm ci
npm run build   # builds every upstream/ workspace, then remote/
node remote/build/index.js
```
