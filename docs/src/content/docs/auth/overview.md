---
title: Auth architecture
description: strad's two doors — Google Workspace OAuth for humans and static system tokens for agents — and why ?servers= is a selection hint, never an authorization boundary.
sidebar:
  order: 1
---

strad runs on the **open internet**. There is no VPN, tailnet, or IP allowlist in
front of it — so auth is the only gate, and it is strict. There are two doors, and
they never cross:

- **`/mcp`** — machines. Static system tokens only.
- **`/console`** — humans. Google Workspace OAuth.

Which door accepts which credential is enforced **in code**, not config. The MCP
authenticator accepts nothing but a static token — not a console session, not the
dev bypass, and emphatically not "no header means dev mode."

## `/mcp` — static system tokens (agents)

Every `/mcp` request must present a static token in `Authorization: Bearer …`.

**Token format:** `strad_<env>_<pubid>_<secret>` — for example
`strad_staging_7f3a91c2_i8Kx…`. The `secret` is 32 random bytes, base64url. Only
the **SHA-256 of the secret** is ever stored (`TokenRecord.hash`, hex); the
plaintext is shown once at mint time and is otherwise unrecoverable.

**`pubid`** (4 random bytes, hex) is a non-secret O(1) lookup key — safe to log.
The `roles` on the record are the only thing downstream authorization reads.

**Minting:**

```bash
npm run token:mint -- --label "my agent" --roles admin --env staging
```

**Verification** is written to leak nothing:

- Parsing splits on the first **three** underscores only, because base64url
  itself contains `_`.
- The hash compare is **constant-time**; it also checks the env matches and that
  the token isn't soft-revoked (`revokedAt` — the record stays, verification
  fails).
- **Every** failure returns the same `401`. The internal `reason`
  (`malformed` / `unknown` / `revoked` / `mismatch` / `wrong_env`) is logs-only —
  "telling a caller why tells an attacker which half they got right."
- An unknown `pubid` still hashes and compares against a dummy all-zero hash, so
  there's no timing oracle distinguishing "no such token" from "wrong secret."
- `401`s carry `WWW-Authenticate: Bearer realm="strad", error="invalid_token"`.

<aside class="starlight-aside starlight-aside--caution">

Token records currently live in the `STRAD_TOKENS` env var (a JSON array of
SHA-256 hashes), not a database. Mint/revoke means editing the secret and
redeploying. A DB-backed store and a console mint/revoke UI are planned — see
[Known limitations](/limitations/).

</aside>

## `/console` — Google Workspace OAuth (humans)

The human surface authenticates with Google, and the security check is the **`hd`
(hosted-domain) claim** on the verified ID token — **not** the email suffix.

That distinction is the whole point: a personal Gmail account can set its profile
email to `someone@tadasant.com` (and even have `email_verified: true`), but the
`hd` claim is only emitted for a real Google Workspace member of that domain. So
strad checks `hd`, not the string after the `@`.

The verification is a full RS256 JWT check — JWKS with a `Cache-Control`-honoring
cache, plus issuer / audience / expiry checks — and PKCE (S256) is used even
though strad is a confidential client. `hd` is _also_ passed as an account-chooser
hint on the auth URL, but that hint is **not** the security control; the verified
claim is. Any verified member gets the roles from `auth.google.roles`.

The provider is constructed from `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`. When
those are absent it returns `null` and strad falls back to the console dev bypass
(below).

### Console dev bypass (temporary)

While Google OAuth credentials are being provisioned, a human can enter `/console`
with the `ADMIN_BOOTSTRAP_TOKEN`. It is **triple-guarded**: it requires
`auth.consoleDevBypass.enabled`, `ALLOW_DEV_AUTH=true`, and
(`NODE_ENV != production` **or** `ALLOW_DEV_AUTH_IN_PRODUCTION`), plus the
presented bootstrap token — and it logs loudly. **Crucially, it grants only a
console session and cannot authenticate `/mcp`.** It is slated for deletion once
OAuth lands — see [Known limitations](/limitations/).

## Entitlement: the token disposes

Once a caller is authenticated, the servers they may reach are computed
**server-side** by `entitledServers()`, intersecting two directions that must both
agree:

1. A role the caller holds names the server (`roles.<role>.servers`; `*` = all).
2. The server lists that role under its `entitlements`.

Neither side grants access alone. (`Object.hasOwn` is used on the roles map to
avoid `__proto__` role-injection attacks.)

`resolveSelection()` then applies `?servers=`:

- **Empty** `?servers=` → everything entitled, sorted.
- **Non-empty** → the requested set, **provided** each is entitled. A
  requested-but-unavailable server is a hard `424` with a per-server `status`
  (`not_configured` / `not_entitled` / `disabled`) and an
  `authorize_url` of `${publicUrl}/console/servers/<slug>`. It is never silently
  dropped.

## `?servers=` is a selection hint, not an auth boundary

This is worth stating on its own, because it is the load-bearing idea:

> **The query string proposes. The token disposes.**

`?servers=` can only ever **narrow** the token-derived entitled set. A token
minted for `/mcp` is valid at `?servers=anything` — the query string cannot widen
access. The grounding is RFC 8707: resource indicators bind a token to a
_resource_, and a query string is not one, so it cannot function as a credential
scope. It is a convenience for selecting _which_ of your entitled servers you want
this request — nothing more.

## The secrets console: three credentials

The [secrets and parameters
system](/intro/architecture/#the-secrets-and-parameters-system) is where the
two-doors rule pays off most concretely. Managing a secret value touches a store
through **three** credentials, and they are three different service accounts on
purpose — the split is the security posture, not an accident of deployment.

| Role         | Lives on                         | Reached via          | Can read a secret value?         |
| ------------ | -------------------------------- | -------------------- | -------------------------------- |
| **viewer**   | the bundle (answers `/mcp`)      | the `secrets` server | **no** — lacks `versions.access` |
| **admin**    | core only (behind SSO)           | `/ui/secrets`        | yes — that is "reveal"           |
| **resolver** | deploy-time (CI / `render-spec`) | never a request      | yes — to inject a child's env    |

- The **viewer** is the agent path. The `secrets` MCP server lists parameters,
  reads notes, and reads non-secret values. It **cannot** read a secret value: its
  service account holds Parameter Manager viewer access and not
  `secretmanager.versions.access`, so Google answers `403` to the only call that
  would return one. A bug, a bad merge, or a prompt injection that reaches for a
  secret value hits that wall — the credential in the process cannot fetch one.
- The **admin** is the human path. It reads and writes both kinds (add, rotate,
  reveal, delete) from the SSO-gated `/ui/secrets`. Its key arrives through
  `consoleEnv:`, which the deploy layer puts on **core alone**. The bundle never
  holds it, so there is no code path from `/mcp` to a secret value. A plain
  broadcast SECRET would not do — that reaches every component; `consoleEnv:` is the
  scope that reaches core and stops.
- The **resolver** injects a `params: true` server's env at deploy time. It reads
  both stores' resolved values and hands them to the child process as SECRET env
  vars, never over strad's own MCP channel. Its `STRAD_PARAMS_*` credential runs in
  CI, so the running container still holds no cloud credential.

If the admin or resolver key ever reached the bundle, the viewer's "cannot read a
secret" guarantee would be gone. Keeping them apart is the whole design.
