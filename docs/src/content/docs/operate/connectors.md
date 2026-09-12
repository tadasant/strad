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

| Field                  | Meaning                                                                                               |
| ---------------------- | ----------------------------------------------------------------------------------------------------- |
| `provider`             | `google` or `generic`. It decides which other fields the block carries                                |
| `account`              | The Google account this slug is pinned to. Checked against the verified `email` claim on the way back |
| `scopes`               | The exact capability scopes to request. strad adds `openid` and `email` itself                        |
| `clientIdVariable`     | Defaults to `GOOGLE_SHEETS_OAUTH_CLIENT_ID`                                                           |
| `clientSecretVariable` | Defaults to `GOOGLE_SHEETS_OAUTH_CLIENT_SECRET`                                                       |
| `refreshTokenVariable` | Defaults to `GOOGLE_SHEETS_OAUTH_REFRESH_TOKEN`. This is the one the flow writes                      |

The three variables are **names, not paths**. Core composes
`/strad/{env}/mcp/{slug}/{kind}/{VARIABLE}` from the slug, a kind and these
strings — and from nothing else, so there is no spelling of one that reaches
another server's namespace. The flow **writes** to `oauth/`; it **reads** the
client id and secret from `oauth/` first and `static/` second, which is the same
layering everything else applies.

### A credential that rotates on use: list it under `paramsWritable:` too

Some providers' refresh tokens are single-use: every refresh returns a new one and
kills the old one. X's are, and so are Reddit's and Dropbox's. The console mints the
first token, but the server spends it, so the server has to persist each successor
or the next restart comes back holding a dead one.

List the connector's variable under [`paramsWritable:`](/operate/secrets/#paramswritable-a-credential-that-rotates-on-use)
on the same server (it needs `params: true`). The write-back route sees that the
name belongs to this server's connector and rotates `oauth/`, the path the consent
wrote and the one every read prefers. So two things write `oauth/`: the consent
callback, which creates the parameter and records who consented, and the
write-back route, which rotates it. The route cannot create it, so a server that
rotates before anyone has connected gets a 404 and degrades. It also leaves the
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

Which is also the reason to leave `clientIdVariable` and `clientSecretVariable`
at their defaults. The host keys on the names the server's own tree reads, and
`google-sheets` reads `GOOGLE_SHEETS_OAUTH_CLIENT_ID` and
`GOOGLE_SHEETS_OAUTH_CLIENT_SECRET`. Renaming them in the config renames what
core seeds and reads, not what the container looks for, so the slug renders,
deploys, and is never mounted — with nothing in any log to say why.

And a mounted-but-unconnected slug reads its refresh token from **its own name or
not at all**. The per-slug environment otherwise falls back to the bare name, and
inheriting a bare `GOOGLE_SHEETS_OAUTH_REFRESH_TOKEN` some other server put on the
container would quietly point one slug at another account — plausibly a working
one, since the OAuth app is usually shared. The host drops it and says so in the
boot log; the mount stays degraded until the slug has a token of its own.

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

## What "connected" does and does not mean

The console says _a credential is stored_, not _this works_. A stored refresh
token is evidence that a human once consented; it is not evidence that Google
still accepts it, and the store cannot see a revocation. The only honest live
signal is a real call, and the console does not make one.

## Telemetry

Three events, all fields from the config: `strad.connector_begin`,
`strad.connector_connected` (slug, variable) and `strad.connector_refused` (slug,
reason). `reason` is the closed set of refusal codes. Nothing derived from a
credential is exported — see [Telemetry](/operate/telemetry/).

## Limits

There is no **Disconnect**. Removing a credential is a delete in the parameters
manager, and revoking the grant is a step at
[myaccount.google.com](https://myaccount.google.com/permissions) — strad does not
call Google's revocation endpoint. See
[Known limitations](/limitations/).
