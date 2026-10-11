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
four kinds:

```yaml
servers:
  # 1. remote-http — proxy an MCP server that already exists on the internet.
  - slug: granola
    kind: remote-http
    url: https://mcp.granola.ai/mcp
    entitlements: [admin]
    headers:
      Authorization: "Bearer ${GRANOLA_TOKEN}" # ${...} = a secret, injected at deploy

  # 2. local-tunnel — an MCP server on a machine you own, behind a tunnel it
  #    dials out. While that machine is off it serves one tool that says so,
  #    and says what to run there.
  - slug: anki
    kind: local-tunnel
    url: https://your-tunnel-host.example/
    entitlements: [admin]
    recovery:
      commands:
        ["launchctl kickstart -k gui/$(id -u)/com.cloudflare.cloudflared"]

  # 3. supplementary-image — a server served by a container image, on one path
  #    of it. strad deploys the image as an internal-only component and proxies.
  - slug: good-eggs
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle
    path: /good-eggs
    entitlements: [admin]

  # 4. builtin — a module compiled into a strad image (for private/internal
  #    servers). The same interface as the public kinds; nothing special.
  - slug: echo
    kind: builtin
    module: "./servers/echo.js"
    bundle: core
    entitlements: [admin]
```

A `remote-http` server can also be written as an `mcpServers:` entry — draft
[SEP-2633](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2633)'s
`mcp.json` — which desugars into exactly the entry above before the schema sees
it. The YAML interface stays authoritative; the dialect covers the one kind the
format was designed for and refuses the rest by name. See
[the interface docs](https://strad.tadasant.com/servers/interface/#mcpservers--the-draft-sep-2633-input-dialect).

See [`strad.config.example.yaml`](./strad.config.example.yaml) for the whole
surface — roles, bundles, capability, and auth.

[`hostd/`](./hostd/README.md) is strad's own server for the `local-tunnel` kind:
a daemon for a machine you own that serves a shell and your running Chrome as
MCP servers, with an on-screen consent dialog and a kill switch. It also runs
over stdio with no tunnel, for a local MCP client.

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

strad's own deployment is **three** components: `core`; one `bundle` whose image
mounts thirty-one MCP servers and a single shared Chromium on `apps-s-1vcpu-2gb`; and
`bundle-zimmer-secrets`, that same image fronting a second parameter store.

`src/deploy/appspec.ts` turns the same config into a DigitalOcean App Platform
spec: the server list decides how many containers exist and how they're wired.

## Auth

- **Humans → `/console`.** Google Workspace OAuth, verified against the `hd`
  hosted-domain claim (not the email suffix — a personal account can spell a
  corporate address).
- **Machines → `/mcp`.** Static system tokens: `strad_<env>_<pubid>_<secret>`.
  Only the SHA-256 is stored; the plaintext is shown once at mint. Constant-time
  compare, soft revocation. `/mcp` says so out loud: it publishes [RFC
  9728](https://www.rfc-editor.org/rfc/rfc9728) protected-resource metadata at
  `/.well-known/oauth-protected-resource/mcp` and its `401` points at it. The
  document names no authorization server, because there is none to name. See
  [discovery](https://docs.strad.tadasant.com/auth/overview/#discovery-what-mcp-says-it-accepts).

The two doors share no credential, which is why the console's **playground**
(`/playground/<slug>` — list a server's tools and call them by hand, no model
involved) opens its MCP session inside the core process rather than presenting a
token to `/mcp`. See
[the console playground](https://strad.tadasant.com/auth/overview/#the-console-playground).

The console at `/connectors` is an installable PWA. Its service worker caches a fixed list
of brand assets and one offline page — never an authenticated response, never a
revealed secret. See [the console as an installed
app](https://docs.strad.tadasant.com/operate/console-pwa/).

```bash
npm run token:mint -- --label "my agent" --roles admin --env staging
```

## Develop

```bash
npm install
npm test            # unit + real-MCP-client end-to-end, in-process
npm run dev         # local server on :8080, against the zero-server stock config
npm run dev:agent   # a free port, the dev config, a console you can enter
npm run typecheck
npm run lint

# validate a config the way a deploy would — no secrets needed. An unknown key
# (`consoleEnvs:` for `consoleEnv:`) is an error here, not a silent strip.
npm run config:check -- --config infra/strad.staging.yaml
```

Requires Node 22 (uses native TypeScript execution). No database, no cache, no
build step in dev — `npm run dev:agent` is the whole local environment, and it
prints the URL it picked. For several isolated sessions at once there is a
containerized workspace in `.agent-containers/`; both are documented in
[Local development](https://docs.strad.tadasant.com/start/local/).

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
gateway is **running**. Add or rotate a secret a server references on the request
path and it reaches production with no deploy — instantly for a change written
through strad's own console or the `secrets` MCP server, or picked up by the
console's "Re-read the store" button. A change made any other way lands on the
daily fallback: a rotation within `ttlSeconds` (default 1 day), an addition
within `negativeTtlSeconds` (default 1 hour). Each process reads the store once
and holds that reading for the TTL, so the bill does not grow with the number of
servers. The gateway then
needs exactly **one** secret in the app spec: the key it uses to reach the store.
A key cannot be kept behind the lock it opens; that is the only exception.

Two categories keep a deploy, and both are honest about it: a name read once at
boot takes effect on the next restart, and anything baked onto another
container takes effect on the next deploy — a `supplementary-image` server's
`env:`, the two boot keys such a component cannot fetch for itself, and a
server's `consoleEnv:`. All of them are read _from the store_, so they are still
managed in one place. [Which name is
which](https://strad.tadasant.com/operate/secrets/#what-rotates-live-what-needs-a-restart-and-what-needs-a-redeploy).

Every `${NAME}` written on a server entry is resolved from **that server's own**
`/strad/{env}/mcp/{slug}/oauth/` and `/strad/{env}/mcp/{slug}/static/` namespaces before the shared
`/strad/{env}/gateway/static/` one, so two servers can write the same `${NAME}`
and be handed different values, and a credential belonging to one MCP server
lives under that server rather than in the deployment-wide namespace. A
supplementary image's `env:` is layered at render time; a `url:`, a `headers:`
map and a builtin's `options:` are layered at runtime, in strad's own process —
which is the only route to its own namespace that a `remote-http` or
`local-tunnel` server has, since strad runs no container for either. Nothing opts
in: an unseeded per-server namespace resolves exactly as it always did. Two servers sharing a bundle share one
container's environment, so **every** supplementary server's `env:` also lands
under per-slug names — `TELEGRAM_RW__TELEGRAM_API_HASH`, the slug uppercased with
`-` as `_` and `__` as the separator — with no condition attached, so a server's
names are computable from its own config entry. Bare names are never removed or
repointed. Which slugs can _read_ their own names is the part `path:` decides: the
bundle host runs one instance per path, so two slugs on one path are one instance
holding one credential, and the render fails rather than picking a winner. [A server's secrets live in that server's
namespace](https://strad.tadasant.com/operate/secrets/#a-servers-secrets-live-in-that-servers-namespace).

Fail-loud survives the move. `render-spec` preflights every referenced `${NAME}`
against the store and fails the deploy on a missing one — reading metadata only,
never a value. The one exception is explicit: a server may list the names it is
willing to deploy without (`mayBeUnseeded:`), and those warn, leave that slug
alone `unconfigured`, and start serving once a value is seeded. Every name nobody
listed still reds the deploy. That is a deploy gate, and it forgives the boot keys a correct
deployment may legitimately lack, so `npm run store:check -- --config <path>` is
the wider check to run before switching a live deployment onto the store: it
counts every name the deployment reads, names what is absent, and has a
`--mode report` for a migration in progress.

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

Crashes are the one thing that path cannot see: an uncaught exception goes through
no `event()` call, and stdout is never shipped. `SENTRY_DSN` turns on exception
reporting into a GlitchTip instance over the Sentry protocol — also **off by
default**, down to not importing the SDK — with every credential the process holds
struck out of the report first. See
[docs/operate/telemetry](https://strad.tadasant.com/operate/telemetry/).

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
