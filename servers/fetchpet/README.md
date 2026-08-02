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
  shared/    # VENDORED from pulsemcp/mcp-servers (the tool logic), + strad deltas
  remote/    # NEW: streamable-HTTP entrypoint over shared/ (this repo)
  Dockerfile # builds shared -> remote, ships Chromium via the Playwright base
```

- **`shared/`** started as a copy of
  [`pulsemcp/mcp-servers` `experimental/fetchpet/shared`](https://github.com/pulsemcp/mcp-servers/tree/main/experimental/fetchpet).
  It holds the Playwright automation and the 4 claim tools
  (`prepare_claim_to_submit`, `submit_claim`, `get_claims`,
  `get_claim_details`). Keep it as close to upstream as the deltas below allow —
  a change that is not one of them belongs upstream, then re-vendored. `remote/`
  reuses `createMCPServer()` from it; nothing is reimplemented.

  The strad deltas, all of them driven by running inside the collapsed bundle:

  | Delta                                                    | Why                                                                                                       |
  | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
  | `setSharedBrowserProvider()` (`server.ts`)               | one Chromium for three browser servers; this one opens a context on it instead of launching its own         |
  | `telemetry.ts`                                           | a browser launch and a Chromium crash are the two things an operator needs, and only this process sees them |
  | `login.ts` + a retried login (`server.ts`)               | see below                                                                                                   |
  | `test/`                                                  | the two above, over a fake browser, with no Fetch account                                                   |

- **`remote/`** is the only new logic: it swaps the upstream stdio transport for
  an Express + `StreamableHTTPServerTransport` front door. Mirrors the upstream
  `local/src/index.ts` step for step (and the merged `servers/good-eggs` remote).

## Login

Fetch's sign-in page is a React app with floating labels: the email field is
`<input type="email">` with no `placeholder` and no `autocomplete`. `login.ts`
holds the two selectors, each a union over every shape the field has carried, and
they are used with a WAITING locator — a non-waiting `page.$` probe returns null
whenever the React tree has not rendered yet, which on a contended container is
most boots.

A failed login is **retried on the next tool call**. It is not cached for the life
of the process: the failed attempt closes its browser context, and the next caller
starts a fresh one. Concurrent callers share one attempt. Inside the bundle, the
host marks the mount `degraded` on a failure and clears the mark when an attempt
succeeds. The standalone container takes the other option the factory offers —
one server per process has nothing to serve without a login, so `remote/` exits
and lets App Platform restart it.

The cost, stated: while the login is broken, a tool call pays a whole login
attempt — up to `TIMEOUT` — before it fails, where it used to fail instantly on
the remembered error. That is the trade for not needing a redeploy to recover.

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
