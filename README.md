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

  # 2. supplementary-image — a server served by a container image, on one path
  #    of it. strad deploys the image as an internal-only component and proxies.
  - slug: good-eggs
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle
    path: /good-eggs
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
surface — roles, bundles, capability, and auth.

## Capability: read-only is a policy the gateway enforces

Which **tools** a slug may use is a `tools:` policy on the entry, enforced by the
gateway on `tools/list` **and** on `tools/call` — a withheld tool is refused with
JSON-RPC `-32600` before the request reaches the upstream.

```yaml
- slug: gmail-ro
  kind: supplementary-image
  image: ghcr.io/tadasant/strad-bundle:latest
  bundle: bundle
  path: /gmail
  tools:
    allow: [list_email_conversations, get_email_conversation, ...]

- slug: gmail-rw # same image, same bundle, same path, same container
  kind: supplementary-image
  image: ghcr.io/tadasant/strad-bundle:latest
  bundle: bundle
  path: /gmail
  # no `tools:` — every tool this server has
```

`allow` is exhaustive; `deny` subtracts and wins over `allow`. Because the decision
is made at the gateway, a read-only and a read-write variant are the same container,
which is what keeps the deployment small. The trade is real: capability is now
**policy** (a gateway that declines), not **physics** (a process that lacks the
tool). See [`HACKS.md`](./HACKS.md) #22.

## Bundles

A **bundle** is one deployment component. `core` is the implicit public gateway;
every other bundle is an internal-only component on the private network, reached
at `${bundle.PRIVATE_URL}`.

- A bundle runs **one image**, but any number of servers may share it, each on its
  own `path` — and capability variants may even share a path.
- Lightweight `builtin` servers colocate in one bundle at ~zero marginal cost.
- Browser/Chromium servers share one browser, with a context per call. Don't run
  several Chromiums in one component; 1 vCPU serialises rendering.

strad's own deployment is **two** components: `core`, and one `bundle` whose image
mounts fourteen MCP servers and a single shared Chromium on `apps-s-1vcpu-2gb`.

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

One model per deployment, declared in the config as `gateway.secrets.provider`.
There is no second way inside strad — two ways to manage a credential means one
of them is out of date and nobody knows which. (Scoped to what strad controls: a
deployment may keep secrets in other systems, and strad does not speak for those.
What it promises is that every `${NAME}` a strad config references resolves
through exactly one provider, named in the config rather than inferred.)

**`env` (the default).** `${NAME}` resolves from the process environment. No
vendor, no cloud account: `npm run dev` and CI both run on this. Secrets reach
the container as deploy-time App Platform SECRET env vars, and the container
holds no cloud credential. The cost is that rotating one does nothing until the
deploy runs again.

**`gcp-parameter-store`.** `${NAME}` resolves from the parameter store while the
gateway is **running**. Add or rotate a secret and it reaches production with no
deploy — a rotation within `ttlSeconds` (default 60s), an addition within
`negativeTtlSeconds` (default 10s), and instantly for a change written through
strad's own console. The gateway then needs exactly **one** secret in the app
spec: the key it uses to reach the store. A key cannot be kept behind the lock it
opens; that is the only exception. (A `supplementary-image` server's `env:` and a
server's `consoleEnv:` are still baked — they are another container's environment
and the console's store-admin credential — but they are read _from the store_, so
they are still managed in one place.)

Fail-loud survives the move. `render-spec` preflights every referenced `${NAME}`
against the store and fails the deploy on a missing one — reading metadata only,
never a value.

The seam is `src/secrets/provider/` (`SecretProvider`: `get`, `invalidate`), over
the store-agnostic `ParameterResolver` in `src/secrets/parameters/`. No secret
value is ever logged. Full model, including what still needs a redeploy and why:
[docs/operate/secrets](https://strad.tadasant.com/operate/secrets/).

## Telemetry

strad emits OpenTelemetry traces and metrics over OTLP, biased toward one question:
is a component dying of memory or of CPU? It is **off by default** — with no
`OTEL_EXPORTER_OTLP_ENDPOINT` set, no SDK starts and nothing is exported.

Tool arguments and results never become span or metric attributes.
`src/telemetry/redact.ts` is the boundary and `test/telemetry.redaction.test.ts` is
the canary that enforces it.

## Docs

The documentation site lives in [`docs/`](./docs) (Astro Starlight). It is the
canonical prose for how strad works, and it is meant to stay true commit-by-commit:
the `docs_site` CI job builds it on every PR, and
[`AGENTS.md`](./AGENTS.md#documentation-lives-in-docs--update-it-in-the-same-pr) is
the rule that says a behavior change updates its page in the same PR.

```bash
cd docs && npm install && npm run dev
```

## Status

Early. See [`HACKS.md`](./HACKS.md) for the current list of deliberate
workarounds and what's needed to retire each one — and
[`docs/src/content/docs/limitations.md`](./docs/src/content/docs/limitations.md) for
the same list as prose.

## License

MIT — see [`LICENSE`](./LICENSE).
