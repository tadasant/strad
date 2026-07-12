# strad

A self-hosted MCP platform. **One endpoint, many MCP servers, selected per
request.**

```
https://your-strad.example.com/mcp?servers=slack,granola
```

Point any MCP client at that URL, present a token, and you get a single merged
toolset drawn from exactly the servers you asked for — proxied, namespaced, and
access-controlled server-side. strad is the thing that sits between your agents
and the sprawl of MCP servers they'd otherwise each have to be configured for.

The core ships with **zero servers baked in.** It is a platform, not a bundle of
integrations. You attach servers through one clean configuration interface.

---

## The one rule

> **The query string proposes. The token disposes.**

`?servers=…` can only ever _narrow_ what a caller is entitled to. It is never an
authorization boundary — a token minted for `/mcp` is valid at `?servers=anything`
(RFC 8707: a token is bound to a resource, and the query string is not one).
Entitlement is computed server-side from the caller's roles and the config.
Nothing the caller sends can widen it.

And it **fails closed**: ask for a server you can't have, and you get
`424 Failed Dependency` with a machine-readable list of what's missing and where
to authorize it — never a `401` that would march the client into a pointless
OAuth loop against the gateway.

## How it works

- **Stateless.** A fresh MCP server is built per request; the toolset is derived
  from `(token, URL)` every time, never from session state. This is what keeps
  `?servers=` conformant with the MCP 2026-07-28 spec, which removes sessions and
  forbids varying the toolset per connection while explicitly allowing variation
  by per-request input.
- **Namespaced tools.** Every tool is exposed as `<server>__<tool>`, e.g.
  `granola__list_meetings`.
- **Auth is the only gate.** strad is meant to run on the open internet. `/mcp`
  requires a static system token, always. Humans use `/console` (Google
  Workspace OAuth).

## Attaching a server

Everything lives in one config file. Adding a server is one entry. There are
three kinds:

```yaml
servers:
  # 1. remote-http — proxy an MCP server that already exists on the internet.
  - slug: granola
    kind: remote-http
    url: https://mcp.granola.ai/mcp
    entitlements: [admin]
    headers:
      Authorization: "Bearer ${GRANOLA_TOKEN}" # ${...} = a secret, injected at deploy

  # 2. supplementary-image — a server published as its own container image.
  #    strad deploys it as an internal-only component and proxies to it.
  - slug: good-eggs
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-server-good-eggs:latest
    bundle: bundle-browser
    entitlements: [admin]

  # 3. builtin — a module compiled into a strad image (for private/internal
  #    servers). The same interface as the public kinds; nothing special.
  - slug: echo
    kind: builtin
    module: "./servers/echo.js"
    bundle: core
    entitlements: [admin]
```

See [`strad.config.example.yaml`](./strad.config.example.yaml) for the whole
surface — roles, bundles, and auth.

## Bundles

A **bundle** is one deployment component. `core` is the implicit public gateway;
every other bundle is an internal-only component on the private network, reached
at `${bundle.PRIVATE_URL}`.

- Lightweight `builtin` servers colocate in one bundle at ~zero marginal cost.
- A `supplementary-image` server always gets its own bundle (one component runs
  one image).
- Browser/Chromium servers want their own bundle — 1 vCPU serialises rendering
  and peak RSS is ~545MB, so budget 1GB.

`src/deploy/appspec.ts` turns the same config into a DigitalOcean App Platform
spec: the server list decides how many containers exist and how they're wired.

## Auth

- **Humans → `/console`.** Google Workspace OAuth, verified against the `hd`
  hosted-domain claim (not the email suffix — a personal account can spell a
  corporate address).
- **Machines → `/mcp`.** Static system tokens: `strad_<env>_<pubid>_<secret>`.
  Only the SHA-256 is stored; the plaintext is shown once at mint. Constant-time
  compare, soft revocation.

```bash
npm run token:mint -- --label "my agent" --roles admin --env staging
```

## Develop

```bash
npm install
npm test            # unit + real-MCP-client end-to-end, in-process
npm run dev         # local server on :8080
npm run typecheck
npm run lint
```

Requires Node 22 (uses native TypeScript execution).

## Secrets

The runtime container holds **no cloud credentials.** Secrets live in Google
Cloud Secret Manager (`strad-<env>-<NAME>`); CI reads them and injects them as
App Platform SECRET env vars at deploy time. The process just reads `process.env`
— the source is pluggable behind `loadSecrets()` (`src/secrets/`).

## Status

Early. See [`HACKS.md`](./HACKS.md) for the current list of deliberate
workarounds and what's needed to retire each one.

## License

MIT — see [`LICENSE`](./LICENSE).
