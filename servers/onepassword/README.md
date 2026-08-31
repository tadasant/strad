# onepassword — strad supplementary-image server

The [1Password](https://developer.1password.com/docs/cli/) MCP server, packaged
as a strad `supplementary-image` bundle: its own container, published to
`ghcr.io/tadasant/strad-server-onepassword`, run as an **internal-only** App
Platform component that the strad core gateway proxies to over the private
network at `http://bundle-onepassword:8080/mcp`. Its tools are namespaced
`onepassword__*` at the gateway.

It talks to 1Password by shelling out to the **1Password CLI (`op`)**, which is
**baked into the image at a pinned version** (`op` is not an npm dependency).

## Layout

```
servers/onepassword/
  elicitation/  # VENDORED @pulsemcp/mcp-elicitation (shared/ imports it; unpublished on npm)
  shared/       # VENDORED VERBATIM from pulsemcp/mcp-servers (the tool logic)
  remote/       # NEW: streamable-HTTP entrypoint over shared/ (this repo)
  test/         # NEW: the tree's Vitest suite (kept OUT of the vendored shared/)
  Dockerfile    # bakes in a pinned `op`, builds elicitation -> shared -> remote
```

- **`shared/`** is copied unchanged from
  [`pulsemcp/mcp-servers` `experimental/onepassword/shared`](https://github.com/pulsemcp/mcp-servers/tree/main/experimental/onepassword).
  It holds the nine tools (`onepassword_list_vaults`, `onepassword_list_items`,
  `onepassword_get_item`, `onepassword_get_item_metadata`,
  `onepassword_list_items_by_tag`, `onepassword_create_login`,
  `onepassword_create_secure_note`, `onepassword_share_item`,
  `onepassword_create_api_credential`), the credential redaction, and the
  elicitation gating. **Do not edit it here** — fixes belong upstream, then
  re-vendor. `remote/` reuses `createMCPServer()` from it; nothing is
  reimplemented.
- **`elicitation/`** is `@pulsemcp/mcp-elicitation`, vendored from
  [`pulsemcp/mcp-servers` `libs/elicitation`](https://github.com/pulsemcp/mcp-servers/tree/main/libs/elicitation)
  because it is not published to npm and `shared/` depends on it. It has no
  runtime dependencies of its own (only `node:crypto`).
- **`remote/`** is the only new logic: it swaps the upstream stdio transport for
  an Express + `StreamableHTTPServerTransport` (stateless,
  `sessionIdGenerator: undefined`) front door. Mirrors the upstream
  `local/src/index.ts` step for step.

## The `op` CLI (baked in, pinned)

The shared client shells out to `op` via `child_process.spawn('op', …)` with no
configurable binary path, so `op` must be on `PATH` inside the container. The
Dockerfile installs a **pinned** version (`ARG OP_VERSION`, currently `2.34.1`)
from 1Password's version-scoped CDN path and asserts `op --version` at build
time. It never resolves "latest" — bump by editing `OP_VERSION` in a commit. The
image is credential-free; `op` reads its token from the environment at runtime.

## Environment

| Var | Required | Notes |
|-----|----------|-------|
| `OP_SERVICE_ACCOUNT_TOKEN` | yes | 1Password service-account token. strad injects it as a per-bundle SECRET; the image ships none. |
| `ENABLED_TOOLGROUPS` | no | **The read-only vs read-write lever.** Comma-separated `readonly,write`. Unset = all tools. `readonly` = the five read tools only (write tools — create login / secure note / API credential, share links — are filtered out of both `ListTools` and `CallTool`). This is how a deployment encodes `onepassword-ro` vs `onepassword-rw` as two configs over one image. |
| `OP_ELICITATION_READ` | no | Prompt before revealing credential fields. Default `true`. |
| `OP_ELICITATION_WRITE` | no | Prompt before create/share. Default `false`. |
| `OP_WHITELISTED_ITEMS` | no | Comma-separated item titles/IDs that bypass read elicitation. |
| `ELICITATION_REQUEST_URL` / `ELICITATION_POLL_URL` | see below | HTTP elicitation fallback endpoints. |
| `DANGEROUSLY_SKIP_ELICITATIONS` | see below | `true` disables ALL prompts (reveals every secret without approval). |
| `PORT` | no | default `8080` (App Platform `internal_ports`). |

**Elicitation is required to boot.** This server redacts secret fields by default
and only reveals them behind a confirmation prompt. A stateless streamable-HTTP
transport cannot round-trip a *native* MCP elicitation, so the operator must pick
a posture explicitly — either configure the HTTP fallback
(`ELICITATION_REQUEST_URL` + `ELICITATION_POLL_URL`) or set
`DANGEROUSLY_SKIP_ELICITATIONS=true`. With neither, the server refuses to start
(the safe default for a credentials manager, inherited from upstream).

## Read-only / read-write

The server exposes writes (create login / secure note / API credential, and mint
share URLs) as well as reads. The capability boundary is `ENABLED_TOOLGROUPS`;
the confirmation-friction boundary is `OP_ELICITATION_READ` /
`OP_ELICITATION_WRITE`. A downstream deployment can therefore ship the **one
image** as two strad server configs pointing at it — e.g. an `onepassword-ro`
config with `ENABLED_TOOLGROUPS=readonly` and an `onepassword-rw` config without
it — differing only in environment. This repo does not define those variants.

## Tests

```bash
cd servers/onepassword
npm ci
npm test          # npm run build && vitest run --config vitest.config.ts
```

Vitest over the TypeScript sources, matching the repo root and the other strad
server trees. The suite covers the 1Password client's **request-building** (the
`op` argv each call assembles, and the fact that the service-account token
travels in the environment rather than in argv) and its **response-shaping**
(list sanitization, share-URL parsing, and the CLI-error classification into
`OnePasswordNotFoundError` / `OnePasswordAuthenticationError` /
`OnePasswordCommandError`).

Two things about how it is arranged:

- **The tests live in `test/` at the tree root, not in `shared/`.** `shared/` is
  a verbatim vendor copy (HACKS.md #15) that a re-vendor overwrites, so a test
  file added there would be a merge conflict every time. From the tree root the
  suite imports the vendored TypeScript sources directly.
- **`npm run build` stays in front of `vitest run`.** Testing sources rather
  than `build/` would otherwise drop the accidental smoke test that a `tsc`
  failure fails `npm test`.

`child_process.spawn` is faked, so the suite starts no process, reaches no
network and reads no credential. It needs no 1Password account and no token.

## Build & run locally

```bash
cd servers/onepassword
docker build -t strad-onepassword:local .
docker run --rm strad-onepassword:local op --version   # -> 2.34.1

docker run --rm -p 18082:8080 \
  -e OP_SERVICE_ACCOUNT_TOKEN=ops_... \
  -e DANGEROUSLY_SKIP_ELICITATIONS=true \
  strad-onepassword:local
# GET  http://localhost:18082/healthz
# POST http://localhost:18082/mcp   (streamable-HTTP MCP)
```

The image is published by `.github/workflows/release-onepassword-image.yml`.
