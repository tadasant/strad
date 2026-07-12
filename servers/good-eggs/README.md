# good-eggs — strad supplementary-image server

The [Good Eggs](https://www.goodeggs.com) MCP server, packaged as a strad
`supplementary-image` bundle: its own container, published to
`ghcr.io/tadasant/strad-server-good-eggs`, run as an **internal-only** App
Platform component that the strad core gateway proxies to over the private
network at `http://bundle-goodeggs:8080/mcp`. Its 11 tools are namespaced
`good-eggs__*` at the gateway.

## Layout

```
servers/good-eggs/
  shared/    # VENDORED VERBATIM from pulsemcp/mcp-servers (the tool logic)
  remote/    # NEW: streamable-HTTP entrypoint over shared/ (this repo)
  Dockerfile # builds shared -> remote, installs Chromium
```

- **`shared/`** is copied unchanged from
  [`pulsemcp/mcp-servers` `experimental/good-eggs/shared`](https://github.com/pulsemcp/mcp-servers/tree/main/experimental/good-eggs)
  at commit `44f32a32afe27ffe9d00f23b24934c8242730f65`. It holds the Playwright
  automation and the 11 tools (`search_for_grocery`, `get_cart`, `get_favorites`,
  `add_to_cart`, …). **Do not edit it here** — fixes belong upstream, then
  re-vendor. `remote/` reuses `createMCPServer()` from it; nothing is
  reimplemented.
- **`remote/`** is the only new logic: it swaps the upstream stdio transport for
  an Express + `StreamableHTTPServerTransport` front door. Mirrors the upstream
  `local/src/index.ts` step for step.

## Browser lifecycle (proven on App Platform gVisor)

`chromium.launch()` costs ~1s every time with no cold-start to warm away, so the
browser is launched **once** at startup (background login) and kept alive;
`shared/` holds a single logged-in Good Eggs page and reuses it. Per HTTP request
we mint a cheap, stateless MCP `Server` + transport that share that one browser.
Chromium runs `--no-sandbox --disable-dev-shm-usage` (set by `shared/`), peaks
~545MB RSS (→ size the bundle at 1GB), and is CPU-bound (1 vCPU serialises
rendering).

## Environment

| Var | Required | Notes |
|-----|----------|-------|
| `GOODEGGS_EMAIL` | yes | strad secret; bridged to `GOOD_EGGS_USERNAME` |
| `GOODEGGS_PASSWORD` | yes | strad secret; bridged to `GOOD_EGGS_PASSWORD` |
| `PORT` | no | default `8080` (App Platform `internal_ports`) |
| `HEADLESS` | no | forced to `true` in-container |

strad injects `GOODEGGS_EMAIL` / `GOODEGGS_PASSWORD` (its naming). `remote/`
bridges them to the `GOOD_EGGS_USERNAME` / `GOOD_EGGS_PASSWORD` that `shared/`
reads.

## Build & run locally

```bash
cd servers/good-eggs
docker build -t strad-goodeggs:local .
docker run --rm -p 18081:8080 \
  -e GOODEGGS_EMAIL=you@example.com \
  -e GOODEGGS_PASSWORD=... \
  strad-goodeggs:local
# GET  http://localhost:18081/healthz
# POST http://localhost:18081/mcp   (streamable-HTTP MCP)
```

The image is published by `.github/workflows/release-goodeggs-image.yml`.
