# good-eggs — strad supplementary-image server

The [Good Eggs](https://www.goodeggs.com) MCP server, packaged as a strad
`supplementary-image` bundle: its own container, published to
`ghcr.io/tadasant/strad-server-good-eggs`, run as an **internal-only** App
Platform component that the strad core gateway proxies to over the private
network at `http://bundle-goodeggs:8080/mcp`. Its 12 tools are namespaced
`good-eggs__*` at the gateway.

## Layout

```
servers/good-eggs/
  shared/    # FORKED tool logic — strad owns this (see FORK.md)
  remote/    # streamable-HTTP entrypoint over shared/
  FORK.md    # every delta from upstream, and the incident behind each
  Dockerfile # builds shared -> remote, installs Chromium
```

- **`shared/`** is a **fork** of
  [`pulsemcp/mcp-servers` `experimental/good-eggs/shared`](https://github.com/pulsemcp/mcp-servers/tree/main/experimental/good-eggs)
  at `44f32a32afe27ffe9d00f23b24934c8242730f65`. It holds the Playwright
  automation and the 12 tools (`search_for_grocery`, `get_cart`, `get_favorites`,
  `add_to_cart`, `get_grocery_nutrition`, …). **Fix it here.** The deltas — and the reason there is no
  upstream to send them to — are in [`FORK.md`](FORK.md). `shared/test/` is what
  defends them; CI runs it as `servers (good-eggs)` on every PR.
- **`remote/`** swaps the upstream stdio transport for an Express +
  `StreamableHTTPServerTransport` front door, reusing `createMCPServer()`.

## Reading the basket

`get_cart`, the post-add verification and the pre-remove lookup all read the
`storeData` payload Good Eggs renders into every page, not the drawn markup. The
markup depends on which of two basket layouts the account is served, and the
payload does not — which is why the scrape they replaced reported an empty cart
against a 43-item basket. `shared/src/basketState.ts` is that read, and FORK.md
#1 is the evidence.

## Login

A failed login is **retried on the next tool call**. It is not cached for the life
of the process: the failed attempt closes its browser context, and the next caller
starts a fresh one. Concurrent callers share one attempt. Inside the bundle, the
host marks the mount `degraded` on a failure and clears the mark when an attempt
succeeds. The standalone container takes the other option the factory offers —
one server per process has nothing to serve without a login, so `remote/` exits
and lets App Platform restart it.

The cost, stated: while the login is broken, a tool call pays a whole login
attempt — up to `TIMEOUT`, 30s by default — before it fails, where a remembered
error failed instantly. On a container that shares one vCPU and one ~545MB
Chromium with twenty other mounts, that attempt is not free. It is the trade for
not needing a redeploy to recover, and `shared/src/server.ts` plus FORK.md #9 are
the evidence.

## Browser lifecycle (proven on App Platform gVisor)

`chromium.launch()` costs ~1s every time with no cold-start to warm away, so the
browser is launched **once** at startup (background login) and kept alive;
`shared/` holds a single logged-in Good Eggs page and reuses it. A failed login
closes its browser CONTEXT rather than the browser, and the retry opens a fresh
one. Per HTTP request
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
