# bundle-google

A strad **supplementary image**: the `gmail`, `google-calendar`, `google-docs`
and `google-sheets` MCP servers packaged into **one** container and served over
Streamable HTTP, each on its own path.

```
/gmail             -> gmail-workspace-mcp-server        (9 tools)
/google-calendar   -> google-calendar-workspace-mcp-server (7 tools)
/google-docs       -> google-docs-workspace-mcp-server   (14 tools)
/google-sheets     -> google-sheets-workspace-mcp-server  (11 tools)
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
- `src/gmail.ts` — **strad's own layer over the gmail tree**, kept outside it
  because it wraps rather than changes it. `vendor/gmail-shared` reads
  `process.env` directly, which is right for the one-server-per-process
  deployment upstream wrote it for and impossible in strad's collapsed bundle,
  where several gmail mounts share one process — one per slug, one per Google
  account. This module takes an INJECTED `env`, owns the name lists the bundle
  host's per-slug discovery keys on (`GMAIL_ENV_NAMES`,
  `GMAIL_OAUTH_APP_ENV_NAMES`, `missingCredentials()`), and is what the host
  imports as `dist/gmail.js`. `test/gmail.test.ts` is its suite. The requirement
  is strad's, not upstream's, and it needs nothing inside the tree, so it
  lives here.
- `src/docs.ts` — the same layer over `vendor/google-docs-shared`, for the
  same reason: google-docs has gmail's two auth modes, and the collapsed bundle
  mounts it once per Google account. Built to `dist/docs.js`; the tree stays
  verbatim. `test/docs.test.ts` is its suite.
- `src/confirm.ts` — **`send_email` asks a human first**, at the URL the CALL
  carries (`_meta["dev.strad/elicitation"]`, put there by strad core from the
  caller's `X-Elicitation-Url` for a slug with `confirmations: true`), never at
  a container-wide one. It wraps the server the vendored tools register on, so
  the tree and the elicitation library both stay verbatim, and it speaks the
  approval protocol itself: no redirects, no response body in an error, every
  request aborted at the deadline. It refuses the send when the call carries no
  channel or the container's `ELICITATION_*` env would route around it.
  It gates the Gmail send request by URL, so the fork's upload route for large
  messages has to keep matching; two tests there hold it to that.
  `test/confirm.test.ts` is its suite. See
  `docs/src/content/docs/servers/confirmations.md`.
- `src/standalone/` — **one server, without strad.** `serve.ts` runs a
  single factory over stdio or over Streamable HTTP at `/mcp` on a localhost
  port (`--transport`, `--port`/`PORT`, `--host`), and each file beside it is
  one server's entrypoint, built to `dist/standalone/<server>.js`. It reuses
  the factory this image mounts, so a standalone server is the bundled one.
  `gmail.ts`, `google-calendar.ts`, `google-docs.ts` and `google-drive.ts`
  are the four. Their how-tos are `vendor/gmail-shared/README.md`,
  `vendor/google-calendar-shared/README.md`,
  `vendor/google-docs-shared/README.md` and
  `vendor/google-drive-shared/README.md`, and `test/standalone.test.ts`
  runs both transports for each. `gmail.ts` and `google-docs.ts` go through
  `src/gmail.ts` and `src/docs.ts`, the layers `/gmail` and `/google-docs`
  mount, not the vendored factories. `gmail.ts` serves `readonly` and
  `readwrite` by default and refuses `readwrite_external` at startup:
  `send_email`'s confirmation channel comes from strad core, and a standalone
  process has no core to trust it from. Adding a server is one more
  entrypoint, a README in its tree, and a test case.
- `vendor/` — the upstream `shared/` factories, plus `@pulsemcp/mcp-elicitation`.
  Wired as npm workspaces.
  - `vendor/google-docs-shared/` — vendored verbatim from
    `github.com/pulsemcp/mcp-servers/experimental/google-docs`.
  - `vendor/google-calendar-shared/` — a **patched vendor** of
    `experimental/google-calendar`: upstream `0ed34de` plus one delta, the
    `GOOGLE_CALENDAR_AUTH_MODE=oauth` mode in `src/server.ts`. Its README's
    delta table lists it and `test/calendar-auth-mode.test.ts` defends it. A
    re-vendor has to re-apply it.
  - `vendor/gmail-shared/` — **a fork**, not a copy. strad owns it and changes
    land here; do not re-vendor over it. It adds attachments to
    `send_email` and `upsert_draft_email`, the sender's display name,
    plain-text reflow and the HTML part sent beside it, the sender-verification headers
    `get_email_conversation` returns, `delete_draft_email`, and attachments
    `download_email_attachments` returns as embedded resources rather than
    paths on the server's disk, and a Drafts folder link on the draft tools.
    `vendor/gmail-shared/FORK.md` lists every delta
    from upstream `0ed34de` and the tests that defend each one;
    `test/gmail-attachments.test.ts` is the main one. Its `README.md` is
    the how-to for running it without strad.
  - The only other edits to vendored code are one dependency line (gmail's
    elicitation dep → the vendored workspace) and a `types` field so the
    entrypoint typechecks. `vendor/google-calendar-shared/README.md` and
    `vendor/google-docs-shared/README.md` are strad's, beside the copied `src/`
    rather than in it. Each of them, `vendor/gmail-shared/README.md` and
    `vendor/google-drive-shared/README.md` is the how-to for running that
    server without strad.
- `vendor/mcp-elicitation/src/` — **generated. Do not edit it here.** The same
  library is also in `servers/onepassword/elicitation`, both copies are built
  into one bundle image, and that copy is the source: `npm run elicitation:sync`
  writes this one and `test/vendored.sync.test.ts` fails CI if they drift. Each
  file carries the banner saying so.
- `vendor/google-sheets-shared/` — **not** vendored from anywhere. It is strad's
  own server, written here, following the same shape as its neighbours so this
  entrypoint and the collapsed bundle host can load all four identically. It has
  unit tests (`npm test`), which the others do not.
- `vendor/google-drive-shared/` — strad's own Google Drive server, written here
  in google-sheets' shape: one Google account per OAuth refresh token, read
  out of an injected env. Three tiers: three read tools on `drive.readonly`,
  two create-only tools on `drive.file` (`readwrite`), and five that rename,
  move, copy, trash and restore an existing file on the full `drive` scope
  (`full`). No tool rewrites a file's content. **Neither this image's `src/index.ts`
  nor the collapsed bundle mounts it.** It runs only through
  `src/standalone/google-drive.ts`, and its README is the how-to.
  `vendor/google-drive-shared/test/` is its suite. See `HACKS.md` #124.
- `scripts/smoke.mjs` — connects a real MCP client to all four paths and lists
  tools; the credential-free boot test used by CI and `npm run smoke`.

## Develop

```bash
npm install
npm run build          # builds vendored shared packages, then the entrypoint
npm test               # the google-sheets, gmail fork and src/ (gmail, docs) suites (builds first)
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
| **Console reconnect hint** (not a credential) | `GMAIL_RECONNECT_URL` — the page named in an `invalid_grant` error |

**Attachments.** `send_email` and `upsert_draft_email` take `attachments`: up
to 10 files, 17 MB decoded in total, each an HTTPS `url` the server downloads
or `content_base64` with a `filename`. Through strad, `content_base64` is
bounded by core's 4 MB `/mcp` request body, so a file over about 3 MB has to
be a `url`. See `vendor/gmail-shared/FORK.md` and `HACKS.md` #117.

Scopes (service-account mode must have these authorized for DWD):
`gmail.readonly`, `gmail.modify`, `gmail.compose`, `gmail.send`.

A refresh token is ONE Google account, which is why `src/gmail.ts` reads an
injected env rather than `process.env`: the collapsed bundle mounts gmail once
per strad slug, each with its own account. This image keeps the single
conventional mount and hands it `process.env`.

**Two modes on one container is a trap the other servers here do not have.** A
per-slug mount in the collapsed bundle must inherit neither the bare
`GMAIL_OAUTH_REFRESH_TOKEN` nor the bare service-account trio — falling back to
the latter would serve a Workspace mailbox under a slug named for a personal
account, with every call succeeding. `GMAIL_ENV_NAMES` names all six so the host
can drop everything that is not the OAuth app pair; see
`servers/bundle/host/src/mounts.ts`.

### google-calendar (`/google-calendar`)

| Purpose | Variables |
| --- | --- |
| **Mode selector** | `GOOGLE_CALENDAR_AUTH_MODE` = `service_account` (default) \| `oauth`. Anything else fails every call, and the standalone entrypoint refuses to start |
| **Service account (domain-wide delegation)** — `service_account` mode | `GCAL_SERVICE_ACCOUNT_CLIENT_EMAIL`, `GCAL_SERVICE_ACCOUNT_PRIVATE_KEY`, `GCAL_IMPERSONATE_EMAIL` |
| **OAuth2 (one account's refresh token)** — `oauth` mode | `GOOGLE_CALENDAR_OAUTH_CLIENT_ID`, `GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET`, `GOOGLE_CALENDAR_OAUTH_REFRESH_TOKEN` |
| **Capability toggle** | `GOOGLE_CALENDAR_ENABLED_TOOLGROUPS` = `readonly` \| `readwrite` (default: all) |

The mode is named, not inferred from which variables are set, unlike gmail and
google-docs. A deployment with no `GOOGLE_CALENDAR_AUTH_MODE` keeps the service
account, whatever OAuth variables are present. An `oauth` deployment missing a
variable fails naming it, and never falls back to a service account. The OAuth
mode is a strad delta on the vendored tree (`HACKS.md` #125).

> The upstream stdio server reads a bare `ENABLED_TOOLGROUPS`. This bundle passes
> `GOOGLE_CALENDAR_ENABLED_TOOLGROUPS` through explicitly so the toggle is
> namespaced like the others and never collides with a sibling in the container.

Scope, in either mode: `https://www.googleapis.com/auth/calendar`.

### google-docs (`/google-docs`)

| Purpose | Variables |
| --- | --- |
| **Service account (domain-wide delegation)** | `GOOGLE_DOCS_SERVICE_ACCOUNT_CLIENT_EMAIL`, `GOOGLE_DOCS_SERVICE_ACCOUNT_PRIVATE_KEY`, `GOOGLE_DOCS_IMPERSONATE_EMAIL` |
| **OAuth2 (refresh token)** — takes precedence if all three set | `GOOGLE_DOCS_OAUTH_CLIENT_ID`, `GOOGLE_DOCS_OAUTH_CLIENT_SECRET`, `GOOGLE_DOCS_OAUTH_REFRESH_TOKEN` |
| **Capability toggle** | `GOOGLE_DOCS_ENABLED_TOOLGROUPS` = `readonly` \| `readwrite` \| `readwrite_external` (default: all) |
| **Console reconnect hint** (not a credential) | `GOOGLE_DOCS_RECONNECT_URL` — the page named in an `invalid_grant` error |

Scopes: `https://www.googleapis.com/auth/documents` **and the full
`https://www.googleapis.com/auth/drive`** (needed for comments/export/sharing of
docs the app did not create — `drive.file` is not enough). An OAuth mount that
only reads can be consented for `documents.readonly` + `drive.readonly`.

gmail's two-mode trap, again: `src/docs.ts` is the same per-account layer as
`src/gmail.ts`, over a tree that stays verbatim. `GOOGLE_DOCS_ENV_NAMES` names
all six variables so the collapsed bundle's host can drop everything that is not
the OAuth app pair from a per-slug mount, which would otherwise inherit the
conventional mount's service account and serve a Workspace user's documents.

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

**Optionally `https://www.googleapis.com/auth/drive.readonly`**, and only for
one thing: an `.xlsx`/`.csv` **uploaded** to Drive is invisible to the Sheets API
(`400 FAILED_PRECONDITION`), so the four read tools fall back to downloading it
from Drive and parsing the workbook in-process — `src/office/` in that tree. A
token without the scope serves native spreadsheets exactly as before and fails an
Office file with a message naming the scope. The scope is read-only but BROAD: it
reaches every file in the account's Drive. No write tool ever uses it. See
`HACKS.md` #102.

**Optionally `https://www.googleapis.com/auth/drive`**, and only for
`share_spreadsheet` — a Drive `permissions.create`, the one Drive write this
server makes. It is full Drive read and write, so it belongs on an
`-rw-external` slug; strad's gateway keeps the tool off `-ro` and `-rw` slugs by
their `tools: allow:` lists. A token without it fails the share naming the scope.

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
