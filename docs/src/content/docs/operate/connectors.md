---
title: Connectors
description: Connect and Reconnect a server slug from strad's own console — how the consent flow works for Google and for any OAuth 2.0 provider, what it refuses, where the credential is stored, and why a slug can ship before it is connected.
---

Some MCP servers authenticate as a **person**, not as a service account. A person
has to sit in front of a browser and consent, once, and the artifact that consent
produces is a refresh token that has to reach a container.

The obvious ways to get one are all bad. The OAuth Playground shows the token on a
web page. A local script prints it to a shell. Either way the credential has been
somewhere before it reaches the store, and somebody has to copy and paste it.

strad runs the consent itself instead. A server slug with an `oauth:` block gets
a **Connect** button on its console page; the token goes from the provider's token
endpoint into the parameter store without being rendered, returned or logged.

It lands under the **`oauth` kind** — `/strad/{env}/mcp/{slug}/oauth/{VARIABLE}` —
which is the namespace for credentials strad minted rather than ones a human
typed. See [the two kinds](/operate/secrets/#the-two-kinds-static-and-oauth).

## What a human does

1. Seed the OAuth application under the slug's own namespace (once per slug):

   ```text
   /strad/{env}/mcp/<slug>/static/GOOGLE_SHEETS_OAUTH_CLIENT_ID
   /strad/{env}/mcp/<slug>/static/GOOGLE_SHEETS_OAUTH_CLIENT_SECRET
   ```

   On a deployment whose console credential withholds
   `secretmanager.versions.access` (production, per
   [Secrets IAM](/operate/secrets-iam/#1-prod-console-write-but-never-read)), a
   client value stored as a secret parameter also needs
   `roles/secretmanager.secretAccessor` for the console's service account, **on
   those two secrets only** — the connector reads its OAuth client through the
   console, and without that grant **Connect** refuses. Creating either value
   from the console makes that binding as part of the create, so seeding a
   connector today needs no extra step. A connector seeded before that offers
   **Grant read on this client** on its own page, beside the refusal; see
   [When the console cannot read the client](#when-the-console-cannot-read-the-client).

2. Open `/ui/<slug>` in the console. It states which provider, which account the
   slug is pinned to (or that strad cannot check one), whether the grant is
   read-only or read-write, and the exact scopes it is about to request.
3. Click **Connect**, consent, and land back on the same page. The credential is
   written to `/strad/{env}/mcp/<slug>/oauth/<VARIABLE>`.
4. Deploy. The token reaches the container on the next render.

Step 4 is not a wart, and the console says so rather than implying otherwise: a
supplementary server's environment is baked at deploy time, so a credential
stored now is on the box after the next deploy, not the moment the page says it
was written.

An agent cannot do any of step 3: consent is a browser handshake with Google. A
deployment that mounts the [`connectors`
builtin](/operate/runtime-config/#the-oauth-leg-is-a-handoff-not-a-flow) gives it
the next best thing, `describe_connector_authorization`, which hands back the
console URL for the person to open and the parameter path the token lands at.

## The configuration

```yaml
- slug: google-sheets-tadas412-ro
  kind: supplementary-image
  image: ghcr.io/tadasant/strad-bundle:latest
  bundle: bundle
  path: /google-sheets-tadas412-ro
  entitlements: [zimmer]
  oauth:
    provider: google
    account: tadas412@gmail.com
    scopes:
      - https://www.googleapis.com/auth/spreadsheets.readonly
  tools:
    allow:
      [
        get_spreadsheet,
        get_sheet_values,
        batch_get_sheet_values,
        find_in_spreadsheet,
      ]
```

| Field                  | Meaning                                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `provider`             | `google` or `generic`. It decides which other fields the block carries                                             |
| `account`              | The Google account this slug is pinned to. Checked against the verified `email` claim on the way back              |
| `scopes`               | The exact capability scopes to request. strad adds `openid` and `email` itself                                     |
| `clientIdVariable`     | The variable **this server's own tree reads** for the OAuth client id. Defaults to `GOOGLE_SHEETS_OAUTH_CLIENT_ID` |
| `clientSecretVariable` | The same, for the secret. Defaults to `GOOGLE_SHEETS_OAUTH_CLIENT_SECRET`                                          |
| `refreshTokenVariable` | The same, for the token — and this is the one the flow **writes**. Defaults to `GOOGLE_SHEETS_OAUTH_REFRESH_TOKEN` |

The three variables are **names, not paths**. Core composes
`/strad/{env}/mcp/{slug}/{kind}/{VARIABLE}` from the slug, a kind and these
strings — and from nothing else, so there is no spelling of one that reaches
another server's namespace. The flow **writes** to `oauth/`; it **reads** the
client id and secret from `oauth/` first and `static/` second, which is the same
layering everything else applies.

### A credential that rotates on use: list it under `paramsWritable:` too

Some providers' refresh tokens are single-use: every refresh returns a new one and
kills the old one. X's are. The console mints the
first token, but the server spends it, so the server has to persist each successor
or the next restart comes back holding a dead one.

List the connector's variable under [`paramsWritable:`](/operate/secrets/#paramswritable--a-credential-that-rotates-on-use)
on the same server (it needs `params: true`). The write-back route sees that the
name belongs to this server's connector and rotates `oauth/`, the path the consent
wrote and the one every read prefers. If the store holds only a copy seeded by
hand under `static/`, for example a token set up before the connector existed,
the route rotates that copy until someone connects. So two things write `oauth/`: the consent
callback, which creates the parameter and records who consented, and the
write-back route, which rotates it. The route cannot create it, so a server that rotates when neither kind holds the
name gets a 404 and degrades. It also leaves the
parameter secret and the consent note alone. [`paramsRefresh:`](/operate/secrets/#paramsrefresh--a-rotation-that-lands-without-a-deploy)
follows the same rule for a re-read.

**Reconnect** writes a fresh grant over the same path, and the server picks it up
at its next boot. Restart it after reconnecting. A process that is still running
holds the token it booted with, and its next rotation writes over the reconnect:
the route has no compare-and-set, the same window a hand re-seed of any
`paramsWritable:` name has.

## `provider: generic` — any OAuth 2.0 provider

`google` is an implementation: strad knows the endpoints, asks for an ID token,
and refuses a consent that came back from the wrong account. `generic` is a
declaration — the config names the endpoints and strad runs plain RFC 6749
authorization-code-with-PKCE against them.

```yaml
- slug: linear-ro
  kind: supplementary-image
  image: ghcr.io/tadasant/strad-bundle:latest
  bundle: bundle
  path: /linear-ro
  entitlements: [zimmer]
  oauth:
    provider: generic
    label: Linear
    authorizeUrl: https://linear.app/oauth/authorize
    tokenUrl: https://api.linear.app/oauth/token
    scopes: [read]
    authorizeParams:
      access_type: offline
    clientIdVariable: LINEAR_OAUTH_CLIENT_ID
    clientSecretVariable: LINEAR_OAUTH_CLIENT_SECRET
    refreshTokenVariable: LINEAR_OAUTH_TOKEN
```

| Field             | Meaning                                                                                                  |
| ----------------- | -------------------------------------------------------------------------------------------------------- |
| `authorizeUrl`    | Where the browser is sent. Required, https (http only to a loopback host)                                |
| `tokenUrl`        | Where the code is exchanged, server to server. Required, same rule                                       |
| `label`           | What the console calls the provider. Defaults to the authorize URL's host                                |
| `scopes`          | Requested verbatim, space-delimited. May be empty                                                        |
| `authorizeParams` | Extra query parameters — `access_type: offline`, `duration: permanent`, `prompt: consent`                |
| `clientAuth`      | `post` (default) puts the client secret in the body; `basic` puts it in an `Authorization: Basic` header |
| `credential`      | Which token-response field is durable: `refresh_token` (default) or `access_token`                       |

The three variable names are **required** here. Google's defaults are Google's; a
Linear credential silently landing in `GOOGLE_SHEETS_OAUTH_REFRESH_TOKEN` is a
wrong answer that renders clean.

**Every field a generic connector cannot work without is required**, and that is
deliberate. Zod strips an unknown key, so an _optional_ `authorizeUrl:` misspelled
once would parse clean, deploy clean, and send a human to the wrong provider.
Required means the same typo is a parse error on the config gate instead.

`authorizeParams` cannot set a parameter strad composes itself — `client_id`,
`redirect_uri`, `response_type`, `scope`, `state`, `code_challenge`,
`code_challenge_method`. Those carry the terms of the grant and the PKCE
challenge, and the config gate refuses each by name.

### What a generic connector does NOT do

**It proves no identity, so there is no `account:`.** OpenID Connect is what makes
Google's account pinning possible, and nothing in plain OAuth 2.0 says whose
account a token belongs to. A generic connector stores whatever account the human
was signed in as at the provider, and the console says exactly that above the
button rather than implying a check it cannot make. If that matters for a given
provider, the answer is a first-class variant like `google`, not a field.

**It does not refresh.** The durable credential is stored and injected. For an
upstream that needs short-lived bearers minted from it, see `oauthRefresh:`.

**A scope check happens only when the provider speaks.** RFC 6749 §5.1 makes
`scope` optional in a token response and required only when the grant differs from
the request, so silence is taken as "what you asked for". When the provider does
name its scopes, every configured one must be among them or the consent is
refused and nothing is written.

**The tier is derived, not declared.** A slug is read-only when every capability
scope ends in `.readonly`, and read-write otherwise. A label in the config would
be a second source of truth for something the scopes already say, and the failure
mode of a wrong one is a page promising "read-only" above a button that requests
write.

### A connector's variables are never `${NAME}` references

This is the part worth reading twice, because it is what keeps a fleet
deployable.

`render-spec` exits 1 on the first `${NAME}` it cannot resolve, and it renders the
**whole** app spec. So a slug that declared
`GOOGLE_SHEETS_OAUTH_REFRESH_TOKEN: "${GOOGLE_SHEETS_OAUTH_REFRESH_TOKEN}"` in its
`env:` would fail every other server's deploy — and it would do so until the token
existed, which cannot happen until a human has completed the console flow, which
needs the slug deployed first. That is a cycle, and it takes the fleet down rather
than one slug.

So the renderer **injects** a connector's three variables from the slug's own
namespace, each one only if the store holds it, and the config gate refuses a
`${NAME}` reference to any of them by name. An unconnected slug therefore renders
with two variables and no third: it deploys, mounts, lists its tools, and reports
itself degraded — which is the state the Google Sheets server is already built to
survive. The ordering is one-phase:

```text
seed client id + secret  →  deploy (slug mounts, degraded)
                         →  connect in the console
                         →  next deploy picks the token up
```

An unconnected slug costs its own capability and nobody else's.

The two seeded variables do a second job on the way in: the bundle host never
sees strad's config, so a slug's own client id and secret are the only evidence
it has that a mount was asked for. It discovers on that pair — deliberately not
on the token, which would unmount every slug that has not been connected yet, and
a slug has to be mounted before its console page can connect it. Seed one of the
two without the other and the slug renders but does not mount.

#### Name the three variables the server's own tree reads

That is the whole rule, and it is not "leave them at their defaults". The bundle
host keys discovery on the client id and secret **under the names the upstream
itself reads**, and it reads the token under that name too. Get them wrong and
core seeds and reads one name while the container looks for another: the slug
renders, deploys, and is never mounted — with nothing in any log to say why.

The defaults are `google-sheets`' set, because google-sheets was the first server
to consume them. That is history, not a recommendation:

| Server          | Set the three to                                                                                |
| --------------- | ----------------------------------------------------------------------------------------------- |
| `google-sheets` | `GOOGLE_SHEETS_OAUTH_CLIENT_ID` / `..._CLIENT_SECRET` / `..._REFRESH_TOKEN` — i.e. the defaults |
| `gmail`         | `GMAIL_OAUTH_CLIENT_ID` / `GMAIL_OAUTH_CLIENT_SECRET` / `GMAIL_OAUTH_REFRESH_TOKEN`             |
| `google-docs`   | `GOOGLE_DOCS_OAUTH_CLIENT_ID` / `..._CLIENT_SECRET` / `..._REFRESH_TOKEN`                       |
| anything else   | Whatever that tree reads. Check its README before writing the block                             |

```yaml
- slug: gmail-tadas412-ro
  kind: supplementary-image
  image: ghcr.io/tadasant/strad-bundle:latest
  bundle: bundle
  path: /gmail-tadas412-ro
  entitlements: [admin]
  oauth:
    provider: google
    account: tadas412@gmail.com
    scopes:
      - https://www.googleapis.com/auth/gmail.readonly
    clientIdVariable: GMAIL_OAUTH_CLIENT_ID
    clientSecretVariable: GMAIL_OAUTH_CLIENT_SECRET
    refreshTokenVariable: GMAIL_OAUTH_REFRESH_TOKEN
```

And a mounted-but-unconnected slug reads its refresh token from **its own name or
not at all**. The per-slug environment otherwise falls back to the bare name, and
inheriting a bare `GOOGLE_SHEETS_OAUTH_REFRESH_TOKEN` some other server put on the
container would quietly point one slug at another account — plausibly a working
one, since the OAuth app is usually shared. The host drops it and says so in the
boot log; the mount stays degraded until the slug has a token of its own.

**gmail is the sharp case here**, and it is why the host drops a list of names
rather than just the token. That server has two auth modes, and a strad bundle
carries both: the conventional `/gmail` mount authenticates as a service account
impersonating a Workspace user, so `GMAIL_SERVICE_ACCOUNT_CLIENT_EMAIL`,
`GMAIL_SERVICE_ACCOUNT_PRIVATE_KEY` and `GMAIL_IMPERSONATE_EMAIL` are on the same
container under bare names. A per-slug gmail mount that inherited those would not
be unconfigured — it would be **a different person's mailbox**, served under a
slug named for the connected account, with every call succeeding. So the host
drops every per-account name in **both** modes, and an unconnected gmail slug
degrades naming `GMAIL_OAUTH_REFRESH_TOKEN` alone.

**google-docs is the same case.** The conventional `/google-docs` mount
impersonates a Workspace user through `GOOGLE_DOCS_SERVICE_ACCOUNT_*` and
`GOOGLE_DOCS_IMPERSONATE_EMAIL`, so a per-slug docs mount drops those too and an
unconnected one degrades naming `GOOGLE_DOCS_OAUTH_REFRESH_TOKEN`. A docs slug
left on the google-sheets default names is worse than unmounted: the sheets tree
discovers it and serves spreadsheets at its path. The scopes per tier:

| Tier           | Scopes                                 | What enforces the tier                                 |
| -------------- | -------------------------------------- | ------------------------------------------------------ |
| `-ro`          | `documents.readonly`, `drive.readonly` | Google and the gateway's `tools:` list                 |
| `-rw`          | `documents`, `drive`                   | The gateway alone: `tools:` withholds `share_document` |
| `-rw-external` | `documents`, `drive`                   | Nothing narrower; this tier is the full eleven         |

`-rw` cannot be narrowed on Google's side: deleting and sharing both go through
the Drive API on documents the app never created, which `drive.file` cannot
reach, so the write tiers hold the same grant and differ only by policy — the
same trade as the service-account tiers.

### The credential arrives under the slug's own variable name, and only that one

A connector's variables are baked onto the container as
`GOOGLE_SHEETS_TADAS412_RO__GOOGLE_SHEETS_OAUTH_REFRESH_TOKEN` — the
[per-slug name](/operate/secrets/#what-a-servers-variables-are-called-on-the-box)
— and **never** under the bare `GOOGLE_SHEETS_OAUTH_REFRESH_TOKEN`.

That is load-bearing rather than tidy. The bundle host builds a slug's
environment by starting from the whole container environment and overlaying the
per-slug names, so a slug with no per-slug name of its own **falls back to the
bare one**. Six slugs of one OAuth app on one bundle all default to the same
three variable names; if the bare name carried a value, the first slug connected
would hand its credential to every sibling that was not — and an unconnected
`-ro` mount would come up holding the `-rw` slug's write token, fully functional,
while its console page said "not connected".

Two rules make that unrepresentable:

- the renderer emits a connector's variables under the per-slug alias alone; and
- the config gate refuses a connector on any path but `/<its own slug>`, because
  that is the only path the bundle host mounts a per-slug instance at.

A slug therefore reads its own credential or it reads nothing.

### Only a `supplementary-image`, and only an enabled one

`oauth:` on another kind is refused by the config gate, and a disabled server has
no connector page at all. Both are the same failure: a consent that succeeds and
writes a real Google credential into a namespace no render will ever read.

A `remote-http` server has no container to inject onto, and its consent runs
differently: see [`remote-http` with
`oauthRefresh:`](#remote-http-with-oauthrefresh-connect-an-upstream-mcp-server)
below.

## What the flow refuses

The browser proposes almost nothing. The connect action carries no fields; the
callback carries an authorization code and an opaque `state`. Everything else —
the slug, the account, the scopes, the target variable, the redirect URI — is read
from the config and from state strad sealed itself.

- **A missing, expired, replayed or mismatched `state`.** Ten-minute TTL, HMAC
  over the whole transaction, single-use, and constant-time compared.
- **A transaction from another console session.** The state is bound to the
  session that began it, so a transaction cookie on its own is not an
  authorization.
- **A transaction from another deployment.** Staging's cannot be spent at prod.
- **A config that changed mid-flow.** If the account, the scopes or the target
  variable are no longer what the human was shown, nothing is written.
- **The wrong Google account.** Verified against the signed ID token's `email`
  claim, not against whichever account the chooser was on. Refused, and the token
  is discarded.
- **A narrowed consent.** If Google reports granting less than the config
  requires — a human unticked a box — nothing is written. Storing that token would
  leave a slug that reads "connected" and fails on its first real call.

A grant that is **wider** than the config asked for is _not_ refused, and that is
a deliberate asymmetry: Google substitutes its own spellings for the identity
scopes (`email` comes back as `…/auth/userinfo.email`), so a strict
"nothing extra" rule would refuse correct consents on a technicality. What strad
does instead is refuse to keep quiet about it — the page says the grant was
wider, and the stored note lists exactly what Google granted, so the derived tier
never silently overstates how narrow the stored credential is.

- **A consent with no refresh token.** An access token alone is an hour of
  capability and nothing to store, so it is a failure rather than a partial
  success.
- **An OAuth application seeded somewhere else.** A client id under
  `/strad/{env}/gateway/static/`, or under a sibling slug, does not make a
  connector ready. This flow reads that slug's namespace and no other.

### When strad itself cannot begin

Some refusals are about the deployment rather than the consent, and **Connect**
answers them before anyone is sent to the provider: no `gateway.publicUrl`, no
`CONSOLE_SESSION_SECRET`, a connector that is not ready (the OAuth application
missing, or the store not answering), or an OAuth client the console could not
read. The last is the one production hits: the console's credential lacks
`secretmanager.versions.access` on a client value stored as a secret parameter.
It is also the only one of them with a button behind it — see below.

Each one renders the slug's own page with the reason in a flash, at **409**, never
a 5xx. The App Platform ingress treats an upstream 5xx as its own failure and
swaps the body for its generic edge page, so a refusal answered 503 would reach
the human as "Error code: 503" and nothing else. A store failure names the permission
and the resource it was refused on, and never the value: a message the store
did not write is reduced to its error class. The callback applies the same rule
to its own setup refusals, and a client it cannot read comes back to the page
as `client_unreadable` rather than as a failed write.

### When the console cannot read the client

`client_unreadable` is the refusal production meets first, and it is the one the
page can repair. The console's credential can create a secret and not read one
back — the posture
[Secrets IAM §1](/operate/secrets-iam/#1-prod-console-write-but-never-read)
prescribes — and an `oauth:` connector is the one thing that needs the exception,
because the consent flow reads this slug's own client id before it redirects and
both halves at the callback.

So the refusal carries a **Grant read on this client** button. Pressing it binds
`roles/secretmanager.secretAccessor` for the console's own service account on
this slug's client-id and client-secret secrets, under its `static/` namespace,
and on nothing else. Never at project level, and never on the `oauth/` kind: a
client hand-seeded there is refused with a sentence saying so, because `oauth/`
holds the credential strad minted and no person has seen, and the console being
unable to read it back is the whole meaning of that kind. A create from the
console makes the same binding on its own, so this button is for the connectors
that predate it.

**It verifies rather than assumes.** After the binding, strad reads both values
back. An IAM deny policy — §1 recommends `strad-console-no-read` — is evaluated
before any allow and cannot be granted around, so on a deployment that applied
one the write succeeds and the read still fails. The page says exactly that,
names the permission and the resource, and names the deny policy as the likely
cause, rather than reporting success and letting **Connect** fail after the human
has consented. A deployment that applied the deny policy has decided its
connectors need a human, and gets told so.

The button is only offered in reply to a read that failed — the refusal itself,
or a callback that came back `client_unreadable`. A connector nobody has failed
to connect does not show it.

### Security posture

- PKCE with `S256`. The verifier travels in the sealed cookie and never in a URL.
- `access_type=offline` and `prompt=consent`, so a **reconnect** actually returns a
  new refresh token. Without the forced consent Google returns none and a rotation
  can never happen.
- `include_granted_scopes` is deliberately **not** set: incremental authorization
  would hand a `-ro` slug whatever its `-rw` sibling had previously been granted
  on the same OAuth client.
- The redirect URI is exact and derived from `gateway.publicUrl`. Staging and
  production have different ones, and each must be registered on the Google OAuth
  client.
- The connector flow has its own OAuth client, its own callback path and its own
  derived signing key. It does not share any of them with console **login**
  (`/console/oauth/callback`), which returns a session rather than a credential.
- No server-side state, so the flow works across core replicas and survives a
  redeploy mid-consent.
- The code exchange is bounded at **ten seconds** and the request is cancelled
  when the bound expires. Node's `fetch` has no overall timeout, so an unbounded
  exchange holds the callback for undici's 300-second header timeout against a
  token endpoint that stalls — and an authorization code is single-use and
  short-lived, so waiting past the point the exchange could have worked buys
  nothing. The refusal is its own code (`exchange_timed_out`), separate from
  `exchange_failed`: Google refusing a code and Google not answering send a human
  to different places, and the page's sentence for each says so.

### What is never exposed

The authorization code, the access token, the refresh token and the client secret
appear in no HTML, no URL, no redirect, no JSON response, no log line, no span and
no exception report. A failure redirects with a code from a closed set of strad's
own words (`account_mismatch`, `scope_not_granted`, …) and the page rebuilds its
sentence from config — Google's own error text is read for nothing, not even for a
message.

What strad does record beside the stored token is a note: the verified email, the
granted scopes, and when. That is what the console shows on a reconnect.

## Reconnect

**Reconnect Google** rotates the stored parameter. The write happens only after
the exchange has succeeded, the identity has been verified and every required
scope has come back granted — so a failed reconnect leaves the previous credential
current. That is what makes it safe to click on a slug whose token has already
been revoked.

Reconnect is the answer to `invalid_grant`. Google expires a refresh token from an
app still in "testing" after seven days, and revokes on a password change or a
withdrawn consent.

**It is also the answer to a scope that was added to the config.** A token carries
the scopes it was minted with; editing `scopes:` and deploying changes what the
next consent asks for and nothing about the credential already in the store. So
widening a slug — adding `drive.readonly` to a `google-sheets` slug so it can
[read Office files](/servers/google-sheets/#office-files-in-drive-are-read-too),
say — is two steps: deploy, then press Reconnect once per slug and consent as that
account. Until the second step the calls that need the new scope fail, and the
console still reports the slug connected, because it is.

## What "connected" does and does not mean

The console says _a credential is stored_, not _this works_. A stored refresh
token is evidence that a human once consented; it is not evidence that Google
still accepts it, and the store cannot see a revocation. The only honest live
signal is a real call, and the console does not make one.

## Telemetry

Six events. Every field comes from the config or from a closed set of strad's
own words:

- `strad.connector_begin` (slug) and `strad.connector_connected` (slug,
  variable): a flow that started, and one that stored a credential.
- `strad.connector_refused` (slug, reason): the callback refused the consent.
  `reason` is a refusal code (`account_mismatch`, `scope_not_granted`,
  `store_failed`, …).
- `strad.connector_connect_failed` (slug, stage, reason): the **deployment**
  could not carry a connect through. `stage` is `begin` (the Connect POST) or
  `callback` (the return from the provider), and `reason` is one of
  `no_redirect_uri`, `no_session_key`, `incomplete`, `store_error`, `no_store`
  or `client_unreadable`. The name ends `_failed`, so it ships at **ERROR** and
  goes to stderr. The human did nothing wrong in any of these branches, so every
  one of them is the deployment failing. It is throttled to one exported record
  a minute per slug; stderr gets every one.

On `client_unreadable` it also carries `variable` (the config's name for the
value that could not be read), `failure` (`denied`, `not_found`, `unreadable`,
`timeout`, `store`, `credential` or `unexpected`) and `status`, the store's HTTP
status as a number. So `slug=google-sheets-tadas412-ro reason=client_unreadable
failure=denied status=403` is enough to know which grant is missing. The store's
own one-line summary, which names the Secret Manager resource, rides in the same
payload on stderr and is not exported.

- `strad.connector_client_granted` (slug, variable, result) and
  `strad.connector_client_grant_failed` (slug, reason, variable, failure,
  status): the console binding its own credential read access to one of this
  slug's client values. `result` is `granted` (the IAM policy was written) or
  `already`. On the failure, `reason` is `not_ready`, `no_store`, `unsupported`,
  `not_eligible`, `write_refused` or `denied` — and `denied` is the one worth
  alerting on, because it means the binding landed and the value still could not
  be read, which is what a deny policy looks like. It ends `_failed`, so it ships
  at ERROR, and it is throttled the same way.

Nothing derived from a credential is exported — see [Telemetry](/operate/telemetry/).

## `remote-http` with `oauthRefresh:`: connect an upstream MCP server

A [`remote-http`](/servers/interface/#oauthrefresh--a-bearer-that-expires-minted-by-strad)
server with `oauthRefresh:` already mints its access tokens from a refresh token
and writes a rotated one back. Its console page, `/ui/<slug>`, is where the
first refresh token comes from. There is nothing to add to the config: the
`oauthRefresh:` block's own `${NAME}`s are what Connect writes.

```yaml
- slug: rippling
  kind: remote-http
  url: https://mcp.rippling.com/mcp
  entitlements: [zimmer]
  oauthRefresh:
    tokenUrl: "${RIPPLING_TOKEN_URL}"
    clientId: "${RIPPLING_CLIENT_ID}"
    refreshToken: "${RIPPLING_REFRESH_TOKEN}"
    resource: "${RIPPLING_RESOURCE}"
  mayBeUnseeded:
    [
      RIPPLING_TOKEN_URL,
      RIPPLING_CLIENT_ID,
      RIPPLING_REFRESH_TOKEN,
      RIPPLING_RESOURCE,
    ]
```

:::caution
Discovery and every refresh go out from strad's own egress, a cloud provider's
addresses, and some upstreams' firewalls refuse them. Rippling's Cloudflare
answers `/mcp` normally and serves a `403` page on its metadata documents to a
DigitalOcean address. [Blocked metadata](#blocked-metadata-paste-it-or-proxy-it)
below covers the two ways past that. A blocked token endpoint has no way past it.
See [Known limitations](/limitations/) #111.
:::

That slug deploys inactive (`unconfigured`). A human opens `/ui/rippling`, clicks
**Connect**, signs in at the upstream, and lands back on the page. The request
after that is served. Nothing is redeployed.

What happens behind the button, in order:

1. **Discover.** strad sends the upstream an unauthenticated `initialize` and reads
   the `401`'s `WWW-Authenticate: Bearer resource_metadata="…"` (RFC 9728),
   falling back to `/.well-known/oauth-protected-resource{path}`. That document
   names the authorization server, whose metadata comes from the RFC 8414 path,
   then the two OpenID Connect paths. An upstream with no protected-resource
   metadata that still answers `401` is taken as its own authorization server
   (the MCP spec's fallback). Every endpoint the upstream names must be
   https; plain http is followed only when the configured `url:` is itself on
   loopback, which is a local test rig and never a deployment.
2. **Pick a client.** A literal `clientId` is a pre-registered client and is used
   as is. A `${NAME}` is registered fresh (RFC 7591) when the server offers
   registration and the block declares no `clientSecret`: a **public** client,
   `token_endpoint_auth_method: none`, whose one redirect URI is this
   deployment's `/ui/oauth/callback`. With no registration endpoint, or with a
   `clientSecret`, the value already seeded under the slug's own namespace is
   used, and its absence is a refusal that names the redirect URI to register
   and where to seed the id.
3. **Authorize.** Code + PKCE (S256) with `resource=` (RFC 8707). Scopes are the
   literal `oauthRefresh.scope:`, or else what the `401` asked for, or else the
   resource's `scopes_supported`, plus `offline_access` when the authorization
   server lists it. With none of those, `scope` is left off.
4. **Exchange and store.** The callback exchanges the code at the discovered
   token endpoint, with the same client and `resource`, and insists on a refresh
   token. Then it writes, under `/strad/{env}/mcp/{slug}/oauth/`: the token URL,
   the client id (only when strad registered it) and the resource for whichever
   of them are `${NAME}`s, and the refresh token last, as a secret parameter. It
   drops the process's cached reading of the store, and the minter takes the new
   lineage on the next request.

Between steps 1 and 2, strad GETs the token endpoint once. A `403` page signed
by a firewall (`cf-ray`, `cf-mitigated` or `server: cloudflare`, or
`server: AkamaiGHost`) is `token_endpoint_blocked`. It means the code exchange
and every refresh would be refused too, so Connect stops before it registers a
client or sends anyone to sign in. Anything else passes: an OAuth server answers
that GET with an error of its own, usually a `405` or a `400`, and a `403` page
nobody signed is what an ordinary server sends a GET on a POST-only path.

A literal `tokenUrl` that is not the discovered token endpoint is refused before
anything is registered: a refresh token minted at one endpoint and spent at
another is a slug that never works. `url:` and `scope:` must be literals, and a
`${NAME}` inside a longer string is reported on the page instead of a button.

**Rotation lands where Connect wrote.** Core's `oauthRefresh:` write-back
checks the slug's `oauth/` path first, then `static/`, then the gateway's, the
order the resolver reads in. See
[Secrets](/operate/secrets/#oauthrefresh--a-rotating-refresh-token-on-a-remote-http-server).

### Blocked metadata: paste it, or proxy it

The two metadata documents are public, so who fetches them changes nothing about
what they say. When a firewall refuses strad, there are two ways to read them
anyway. Both cover those two GETs and nothing else.

**Paste.** A `metadata_blocked` refusal opens a **Connect with metadata you
paste** form on the page. It links the document strad was refused. Open it in
your own browser, copy the whole JSON into the box, and submit. If the
authorization server's document is refused next, the page links that one and
keeps what you already pasted. strad checks a pasted document the way it checks a
fetched one, and more strictly. A fetched document may omit `resource` or
`issuer`, but a pasted one must carry both, because nothing but its own text
vouches for it. `resource` must cover the upstream, the issuer must be the one
the protected-resource document names, every endpoint must be https, and S256
must be offered when methods are listed. It still cannot tell you whether the
endpoints a pasted document names are the upstream's real ones. Paste only what
the linked address showed you.

**Proxy.** With `oauthRefresh.discoveryProxy:`, a metadata document that answers
strad `403` is read again through BrightData's Web Unlocker, so the button stays
"click Connect, sign in, done":

```yaml
oauthRefresh:
  # ...
  discoveryProxy: { via: brightdata, apiKeyFrom: strad-fetch }
```

The key is `BRIGHTDATA_API_KEY`, read from the `apiKeyFrom` slug's own namespace
(`oauth/`, then `static/`). That is `strad-fetch`'s, which already escalates to
BrightData. The console reads it at Connect time, only when a document has
actually answered `403`. Nothing goes to the proxy while the upstream serves
strad. The proxy accepts GET only, so no code, client or token goes through it.
This sends the upstream's metadata URLs to a third party and gets around the
upstream's bot protection, which is why it is opt-in per slug. Its refusals are
`proxy_key_unreadable` (no key where `apiKeyFrom` points) and `proxy_failed`
(BrightData itself said no, or answered without the target's status). An
unblocking proxy can take tens of seconds per document, so each metadata read on
such a slug gets 60 seconds rather than discovery's usual 10.

### What it refuses, and how it says so

Every refusal before the redirect is a `409` on the slug's page, in strad's own
words, with nothing registered or written. The one that matters most:

- **`metadata_blocked`.** A metadata document answered `401` or `403`. Metadata
  is public by design, so this is nearly always a web application firewall
  refusing the deployment's egress. Rippling's Cloudflare does exactly this to a
  DigitalOcean address. The page names the URL and the status, and opens the
  paste form linking it.
- **`token_endpoint_blocked`.** The token endpoint answered a firewall's `403` page. Nothing
  above helps: the refresh runs from strad on every expiry, so the upstream has to
  allow the deployment's egress.

The rest: `upstream_unreachable`, `metadata_unavailable`, `metadata_invalid`,
`resource_mismatch` (the metadata describes another resource), `issuer_mismatch`,
`insecure_endpoint`, `pkce_unsupported` (S256 not listed), `token_url_mismatch`,
`registration_failed`, `registration_confidential` (a client secret came back),
`no_client`, `proxy_failed`, `proxy_key_unreadable`, `not_connectable`, and `env_provider`: under
`gateway.secrets.provider: env` the gateway reads its names from the environment,
so a store write would reach nothing. No upstream response body is quoted. The
only upstream-supplied text on the page is a URL strad parsed and checked.

After the redirect, the callback runs every check the `oauth:` flow runs (state,
session, deployment), then refuses a transaction whose upstream URL or
`oauthRefresh:` block changed mid-flow, and maps an exchange failure to
`?error=exchange_failed`, `exchange_timed_out`, `no_refresh_token`,
`client_unreadable` or `store_failed`.

### What it does not do

It proves no identity (the page says `account: not checked`), it registers a new
client on every Connect and never deletes the old one, and it has been tested
against a fake authorization server rather than a real provider. See
[Known limitations](/limitations/) #111.

## Limits

There is no **Disconnect**. Removing a credential is a delete in the parameters
manager, and revoking the grant is a step at
[myaccount.google.com](https://myaccount.google.com/permissions) — strad does not
call Google's revocation endpoint. See
[Known limitations](/limitations/).
