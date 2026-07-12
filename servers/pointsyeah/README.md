# pointsyeah — strad supplementary-image server

The [PointsYeah](https://www.pointsyeah.com) award-flight search MCP server,
packaged as a strad `supplementary-image` bundle: its own container, published
to `ghcr.io/tadasant/strad-server-pointsyeah`, run as an **internal-only** App
Platform component that the strad core gateway proxies to over the private
network at `http://bundle-pointsyeah:8080/mcp`. Its 3 tools are namespaced
`pointsyeah__*` at the gateway.

## Layout

```
servers/pointsyeah/
  shared/    # VENDORED VERBATIM from pulsemcp/mcp-servers (the tool logic)
  remote/    # NEW: streamable-HTTP entrypoint over shared/ (this repo)
  Dockerfile # builds shared -> remote, ships Chromium via the Playwright base
```

- **`shared/`** is copied unchanged from
  [`pulsemcp/mcp-servers` `experimental/pointsyeah/shared`](https://github.com/pulsemcp/mcp-servers/tree/main/experimental/pointsyeah).
  It holds the Cognito auth + award-search logic and the 3 tools
  (`set_refresh_token`, `search_flights`, `get_search_history`). **Do not edit it
  here** — fixes belong upstream, then re-vendor.
- **`remote/`** is the only new logic: it swaps the upstream stdio transport for
  an Express + `StreamableHTTPServerTransport` front door, and injects a
  browser-reusing `PlaywrightSearchDeps` (see below). Nothing in `shared/` is
  reimplemented.

## Browser lifecycle (the strad-specific change)

Most of PointsYeah's work is plain `fetch()` (Cognito auth, result polling,
history). A browser is used **only** by `search_flights`, to let the site
perform its client-side request encryption. Upstream `defaultClientFactory()`
launches a **fresh Chromium per search** and tears it down after — on App
Platform gVisor that ~1s launch cost is paid every call.

`remote/` instead injects a `PlaywrightSearchDeps` that launches **one** browser
at process start, keeps it alive, and opens a fresh browser **context** per
search (cookie-isolated, ~700ms). The context is closed after each search; the
browser is not. `shared/` is untouched — the reuse is purely which dependency
object `PointsYeahClient` is constructed with. Chromium runs
`--no-sandbox --disable-dev-shm-usage`, peaks ~545MB RSS (→ 1GB bundle), and is
CPU-bound (1 vCPU serialises rendering).

## Environment

| Var                       | Required | Notes                                                                       |
| ------------------------- | -------- | --------------------------------------------------------------------------- |
| `POINTSYEAH_REFRESH_TOKEN`| no       | AWS Cognito refresh token. Optional — can be set at runtime via `set_refresh_token`. Expires in ~30–90 days |
| `ENABLED_TOOLGROUPS`      | no       | comma-separated groups to enable (`readonly`,`write`,`admin`; default all)   |
| `PORT`                    | no       | default `8080` (App Platform `internal_ports`)                              |

`POINTSYEAH_REFRESH_TOKEN` is the **credential** but is not required to boot: the
server always starts and registers all tools; auth-requiring tools return a
"call set_refresh_token" error until a token is present. strad injects it as a
SECRET env var scoped to this bundle only. No credential is baked into the image.

## Build & run locally

```bash
cd servers/pointsyeah
docker build -t strad-pointsyeah:local .
docker run --rm -p 18083:8080 \
  -e POINTSYEAH_REFRESH_TOKEN=... \
  strad-pointsyeah:local
# GET  http://localhost:18083/healthz
# POST http://localhost:18083/mcp   (streamable-HTTP MCP)
```

The image is published by `.github/workflows/release-pointsyeah-image.yml`.
