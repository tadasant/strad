# bundle-google

A strad **supplementary image**: the `gmail`, `google-calendar`, `google-docs`
and `google-sheets` MCP servers packaged into **one** container and served over
Streamable HTTP, each on its own path.

```
/gmail             -> gmail-workspace-mcp-server        (8 tools)
/google-calendar   -> google-calendar-workspace-mcp-server (7 tools)
/google-docs       -> google-docs-workspace-mcp-server   (11 tools)
/google-sheets     -> google-sheets-workspace-mcp-server  (8 tools)
```

All four are **pure Google API** servers — no browser, no subprocess — so they
colocate happily in one process. strad registers each as a `supplementary-image`
server sharing this one `image` + `bundle` and differing only by `path`; the
gateway proxies `?servers=gmail` to `${bundle-google.PRIVATE_URL}/gmail`.

The published image is **credential-free**. Each server reads its own auth env
vars lazily, only when a tool is actually called — so the image boots, lists
tools and passes health checks with no secrets present. The real credentials are
injected downstream (tadasant-internal) as App Platform SECRET env vars.

## Layout

- `src/index.ts` — the Streamable-HTTP entrypoint. Mirrors strad's own `/mcp`
  handler: a **fresh** `Server` + `StreamableHTTPServerTransport`
  (`sessionIdGenerator: undefined`) is built per request and torn down on close.
- `vendor/` — the upstream `shared/` factories, vendored verbatim from
  `github.com/pulsemcp/mcp-servers/experimental/{gmail,google-calendar,google-docs}`,
  plus `@pulsemcp/mcp-elicitation`. Wired as npm workspaces. The only edit to
  vendored code is one dependency line (gmail's elicitation dep → the vendored
  workspace) and a `types` field so the entrypoint typechecks.
- `vendor/mcp-elicitation/src/` — **generated. Do not edit it here.** The same
  library is also in `servers/onepassword/elicitation`, both copies are built
  into one bundle image, and that copy is the source: `npm run elicitation:sync`
  writes this one and `test/vendored.sync.test.ts` fails CI if they drift. Each
  file carries the banner saying so.
- `vendor/google-sheets-shared/` — **not** vendored from anywhere. It is strad's
  own server, written here, following the same shape as its neighbours so this
  entrypoint and the collapsed bundle host can load all four identically. It has
  unit tests (`npm test`), which the others do not.
- `scripts/smoke.mjs` — connects a real MCP client to all four paths and lists
  tools; the credential-free boot test used by CI and `npm run smoke`.

## Develop

```bash
npm install
npm run build          # builds vendored shared packages, then the entrypoint
npm test               # the google-sheets unit suite (builds first)
node dist/index.js &   # serves on :8080
npm run smoke          # asserts all four servers list their tools
```

## Environment variables

Set only the variables for the auth mode you use. Everything is optional at boot
(credential-free); a mode's variables are validated lazily on the first tool
call.

### gmail (`/gmail`)

| Purpose | Variables |
| --- | --- |
| **Service account (domain-wide delegation)** | `GMAIL_SERVICE_ACCOUNT_CLIENT_EMAIL`, `GMAIL_SERVICE_ACCOUNT_PRIVATE_KEY`, `GMAIL_IMPERSONATE_EMAIL` |
| **OAuth2 (refresh token)** — takes precedence if all three set | `GMAIL_OAUTH_CLIENT_ID`, `GMAIL_OAUTH_CLIENT_SECRET`, `GMAIL_OAUTH_REFRESH_TOKEN` |
| **Capability toggle** | `GMAIL_ENABLED_TOOLGROUPS` = `readonly` \| `readwrite` \| `readwrite_external` (comma-sep; default: all) |

Scopes (service-account mode must have these authorized for DWD):
`gmail.readonly`, `gmail.modify`, `gmail.compose`, `gmail.send`.

### google-calendar (`/google-calendar`)

| Purpose | Variables |
| --- | --- |
| **Service account (domain-wide delegation)** — the ONLY mode; no OAuth path | `GCAL_SERVICE_ACCOUNT_CLIENT_EMAIL`, `GCAL_SERVICE_ACCOUNT_PRIVATE_KEY`, `GCAL_IMPERSONATE_EMAIL` |
| **Capability toggle** | `GOOGLE_CALENDAR_ENABLED_TOOLGROUPS` = `readonly` \| `readwrite` (default: all) |

> The upstream stdio server reads a bare `ENABLED_TOOLGROUPS`. This bundle passes
> `GOOGLE_CALENDAR_ENABLED_TOOLGROUPS` through explicitly so the toggle is
> namespaced like the others and never collides with a sibling in the container.

Scope: `https://www.googleapis.com/auth/calendar`.

### google-docs (`/google-docs`)

| Purpose | Variables |
| --- | --- |
| **Service account (domain-wide delegation)** | `GOOGLE_DOCS_SERVICE_ACCOUNT_CLIENT_EMAIL`, `GOOGLE_DOCS_SERVICE_ACCOUNT_PRIVATE_KEY`, `GOOGLE_DOCS_IMPERSONATE_EMAIL` |
| **OAuth2 (refresh token)** — takes precedence if all three set | `GOOGLE_DOCS_OAUTH_CLIENT_ID`, `GOOGLE_DOCS_OAUTH_CLIENT_SECRET`, `GOOGLE_DOCS_OAUTH_REFRESH_TOKEN` |
| **Capability toggle** | `GOOGLE_DOCS_ENABLED_TOOLGROUPS` = `readonly` \| `readwrite` \| `readwrite_external` (default: all) |

Scopes: `https://www.googleapis.com/auth/documents` **and the full
`https://www.googleapis.com/auth/drive`** (needed for comments/export/sharing of
docs the app did not create — `drive.file` is not enough).

### Common

- `PORT` — listen port (default `8080`; App Platform sets it).
- `BUNDLE_GOOGLE_VERSION` — baked by the release workflow; reported in
  `serverInfo` / `/healthz`.

### google-sheets (`/google-sheets`)

| Purpose | Variables |
| --- | --- |
| **OAuth2 (refresh token)** — the ONLY mode; no service-account path | `GOOGLE_SHEETS_OAUTH_CLIENT_ID`, `GOOGLE_SHEETS_OAUTH_CLIENT_SECRET`, `GOOGLE_SHEETS_OAUTH_REFRESH_TOKEN` |

Scope: `https://www.googleapis.com/auth/spreadsheets` for the write tools,
`…/spreadsheets.readonly` for a token that must not be able to write.

A refresh token is ONE Google account, which is why this server reads an injected
env rather than `process.env`: the collapsed bundle mounts it once per strad slug,
each with its own account. This image keeps the single conventional mount. See
`docs/src/content/docs/servers/google-sheets.md`.

## ⚠️ Domain-wide delegation is a human/admin dependency

Service-account mode does not work until a **Google Workspace admin** authorizes
the service account's client ID for the scopes above in
**Admin Console → Security → API Controls → Domain-wide Delegation**. Until then,
token acquisition fails and tool calls error (listing tools still works — the
image stays credential-free). This is a downstream provisioning step, not
something this image can satisfy on its own.

## Registration in strad

See the commented block in [`strad.config.example.yaml`](../../strad.config.example.yaml).
Four `supplementary-image` entries share `image` + `bundle: bundle-google`,
differing by `path`. The real credential wiring (and the readonly/readwrite/
readwrite_external split) lives in tadasant-internal.
