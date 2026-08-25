---
title: Connectors
description: Connect and Reconnect Google for a server slug, from strad's own console — how the consent flow works, what it refuses, where the refresh token is stored, and why a slug can ship before it is connected.
---

Some MCP servers authenticate as a **person**, not as a service account. A person
has to sit in front of a browser and consent, once, and the artifact that consent
produces is a refresh token that has to reach a container.

The obvious ways to get one are all bad. The OAuth Playground shows the token on a
web page. A local script prints it to a shell. Either way the credential has been
somewhere before it reaches the store, and somebody has to copy and paste it.

strad runs the consent itself instead. A server slug with an `oauth:` block gets
**Connect Google** on its console page; the token goes from Google's token
endpoint into the parameter store without being rendered, returned or logged.

## What a human does

1. Seed the OAuth application under the slug's own namespace (once per slug):

   ```text
   /strad/{env}/mcp/<slug>/static/GOOGLE_SHEETS_OAUTH_CLIENT_ID
   /strad/{env}/mcp/<slug>/static/GOOGLE_SHEETS_OAUTH_CLIENT_SECRET
   ```

2. Open `/ui/<slug>` in the console. It states the Google account the slug is
   pinned to, whether the grant is read-only or read-write, and the exact scopes
   it is about to request.
3. Click **Connect Google**, consent as that account, and land back on the same
   page.
4. Deploy. The token reaches the container on the next render.

Step 4 is not a wart, and the console says so rather than implying otherwise: a
supplementary server's environment is baked at deploy time, so a credential
stored now is on the box after the next deploy, not the moment the page says it
was written.

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
| `provider`             | `google`. The only one strad implements; a config cannot name a provider there is no code for         |
| `account`              | The Google account this slug is pinned to. Checked against the verified `email` claim on the way back |
| `scopes`               | The exact capability scopes to request. strad adds `openid` and `email` itself                        |
| `clientIdVariable`     | Defaults to `GOOGLE_SHEETS_OAUTH_CLIENT_ID`                                                           |
| `clientSecretVariable` | Defaults to `GOOGLE_SHEETS_OAUTH_CLIENT_SECRET`                                                       |
| `refreshTokenVariable` | Defaults to `GOOGLE_SHEETS_OAUTH_REFRESH_TOKEN`. This is the one the flow writes                      |

The three variables are **names, not paths**. Core composes
`/strad/{env}/mcp/{slug}/static/{VARIABLE}` from the slug and these strings and
from nothing else, so there is no spelling of one that reaches another server's
namespace.

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
