# bundle-api — six pure-API MCP servers in one strad bundle

`bundle-api` is a strad [`supplementary-image`](../../docs/src/content/docs/servers/adding.md)
bundle that hosts **six credential-free, pure-HTTP/API MCP servers** in a
single internal Node process:

| slug | upstream server | tools |
| --- | --- | --- |
| `slack` | Slack workspace (**forked** — see [`fork/slack/FORK.md`](fork/slack/FORK.md)) | messaging / channels |
| `serpapi-hotels` | SerpApi Google Hotels | hotel search |
| `tailscale` | Tailscale VPN | policy / devices / keys |
| `monarch-money` | Monarch Money | personal finance |
| `gcs` | Google Cloud Storage | object storage |
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
  fork/slack/        # FORKED from the same monorepo @b1f13fe, and edited here
  remote/            # NEW streamable-HTTP host over all six createMCPServer()s
  Dockerfile         # node:22-slim -> ghcr.io/tadasant/strad-bundle-api
```

The `upstream/<slug>` directories are each an upstream server's `shared/`
package, copied verbatim (fixes go upstream, then re-vendor — see HACKS.md).
`remote/src/index.ts` reuses each one's `createMCPServer()` factory; **no tool
logic is reimplemented**. It swaps stdio for an Express front door speaking
`StreamableHTTPServerTransport` (`sessionIdGenerator: undefined`), mounting each
server at `/<slug>`. strad's core gateway proxies to it over the private network
at `${bundle-api.PRIVATE_URL}/<slug>`.

`fork/slack` is the one exception, and it sits under a different directory so
that the exception is visible from the path. Both hashes above are repo HEADs at
the moment a copy was taken, not commits that touched the server in question —
`b1f13fe` is simply where slack was last verified byte-identical to upstream,
which is the version the fork diverges from. Slack's message format is mrkdwn,
not Markdown, `~text~` is strikethrough, and a message that uses `~` as an
"approximately" sign posts successfully with whole paragraphs struck through —
no error, anywhere. Upstream's write tools call the format "Slack markdown" and
never mention the tilde, so the fix has to live in the tool definitions. What
changed, and why it warns rather than rewrites, is in
[`fork/slack/FORK.md`](fork/slack/FORK.md). `npm test` at this level runs the
fork's suite, which is what stops a re-vendor from quietly reverting it.

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
- **google-flights** — none (public endpoints)

> **Colocation note.** `gcs` is the only server here that reads `GCS_*`.
> strad's artifact store — the one that used to collide with it on `GCS_BUCKET` —
> is [`servers/remote-filesystem`](../remote-filesystem), a tree of its own, and
> it reads slug-namespaced names instead.

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
| `serpapi-hotels` | — (none) | | |
| `google-flights` | — (none) | | |

`monarch-money` and `gcs` also accept exact-name allow/deny lists
(`MONARCH_ENABLED_TOOLS`/`MONARCH_DISABLED_TOOLS`,
`GCS_ENABLED_TOOLS`/`GCS_DISABLED_TOOLS`), and `gcs` accepts `GCS_BUCKET` to pin
all operations to one bucket. These are unique names and pass straight through.

### The slug-namespaced toggle override

Several upstreams read the same generic var names (`ENABLED_TOOLGROUPS`), and a
single process-wide value can't configure two servers independently. So `remote/`
ALSO accepts a **slug-namespaced override** for any toggled server:

```
<SLUG>_<UPSTREAM_VAR>
```

e.g. `SLACK_ENABLED_TOOLGROUPS=readonly` configures slack without touching any
other server that reads the same bare name.
When set, the override is applied onto the bare upstream name for the duration
of that one registration only (synchronously, before any `await`, so it never
leaks across concurrent requests). Unset → the bare upstream var applies as-is.
The same slug-prefixed form works for every toggled server
(`TAILSCALE_TOOL_GROUPS`, `MONARCH_MONEY_MONARCH_ENABLED_TOOL_GROUPS`,
`GCS_GCS_ENABLED_TOOLGROUPS`).

## Build

```
npm ci
npm run build   # builds every upstream/ workspace, then remote/
node remote/build/index.js
```
