# fetchpet — strad supplementary-image server

The [Fetch Pet](https://www.fetchpet.com) MCP server, packaged as a strad
`supplementary-image` bundle: its own container, published to
`ghcr.io/tadasant/strad-server-fetchpet`, run as an **internal-only** App
Platform component that the strad core gateway proxies to over the private
network at `http://bundle-fetchpet:8080/mcp`. Its 4 tools are namespaced
`fetchpet__*` at the gateway.

## Layout

```
servers/fetchpet/
  shared/    # VENDORED VERBATIM from pulsemcp/mcp-servers (the tool logic)
  remote/    # NEW: streamable-HTTP entrypoint over shared/ (this repo)
  Dockerfile # builds shared -> remote, ships Chromium via the Playwright base
```

- **`shared/`** is copied unchanged from
  [`pulsemcp/mcp-servers` `experimental/fetchpet/shared`](https://github.com/pulsemcp/mcp-servers/tree/main/experimental/fetchpet).
  It holds the Playwright automation and the 4 claim tools
  (`prepare_claim_to_submit`, `submit_claim`, `get_claims`,
  `get_claim_details`). **Do not edit it here** — fixes belong upstream, then
  re-vendor. `remote/` reuses `createMCPServer()` from it; nothing is
  reimplemented.
- **`remote/`** is the only new logic: it swaps the upstream stdio transport for
  an Express + `StreamableHTTPServerTransport` front door. Mirrors the upstream
  `local/src/index.ts` step for step (and the merged `servers/good-eggs` remote).

## Browser lifecycle (proven on App Platform gVisor)

`chromium.launch()` costs ~1s every time with no cold-start to warm away, so the
browser is launched **once** at startup (background login) and kept alive;
`shared/` holds a single logged-in Fetch Pet page and reuses it. Per HTTP request
we mint a cheap, stateless MCP `Server` + transport that share that one browser.
Chromium runs `--no-sandbox --disable-dev-shm-usage` (set by `shared/`), peaks
~545MB RSS (→ size the bundle at 1GB), and is CPU-bound (1 vCPU serialises
rendering).

## Environment

| Var                    | Required | Notes                                                       |
| ---------------------- | -------- | ----------------------------------------------------------- |
| `FETCHPET_USERNAME`    | yes      | Fetch Pet account email. `FETCHPET_EMAIL` is accepted alias |
| `FETCHPET_PASSWORD`    | yes      | Fetch Pet account password                                  |
| `PORT`                 | no       | default `8080` (App Platform `internal_ports`)              |
| `HEADLESS`             | no       | forced to `true` in-container                               |
| `TIMEOUT`              | no       | Playwright operation timeout ms (shared default `30000`)    |
| `FETCHPET_DOWNLOAD_DIR`| no       | download dir (default `/tmp/fetchpet-downloads`)            |

`FETCHPET_USERNAME` / `FETCHPET_PASSWORD` are **credentials**; the rest are
optional capability/config. strad injects the credentials as SECRET env vars
scoped to this bundle only (see `src/deploy/appspec.ts`). No credential is baked
into the image.

## Build & run locally

```bash
cd servers/fetchpet
docker build -t strad-fetchpet:local .
docker run --rm -p 18082:8080 \
  -e FETCHPET_USERNAME=you@example.com \
  -e FETCHPET_PASSWORD=... \
  strad-fetchpet:local
# GET  http://localhost:18082/healthz
# POST http://localhost:18082/mcp   (streamable-HTTP MCP)
```

The image is published by `.github/workflows/release-fetchpet-image.yml`.
