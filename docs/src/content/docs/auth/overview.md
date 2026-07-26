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

### The sign-in round trip

```
GET /ui/secrets            no session      → 302 /console/login?next=%2Fui%2Fsecrets
GET /console/login         seals the PKCE verifier + state + next into
                           strad_oauth_tx (HttpOnly, 10 min, Path=/console)
                                           → 302 accounts.google.com
GET /console/oauth/callback                → verify hd, mint strad_console_session
                                           → 302 /ui/secrets
```

The **authorized redirect URI** to register on the OAuth client is
`${gateway.publicUrl}/console/oauth/callback` — for prod,
`https://strad.tadasant.com/console/oauth/callback`.

`next` is sanitised to a same-origin absolute path; a scheme-relative `//host`, a
full URL, a backslash or a CR/LF all fall back to `/ui`, so the callback cannot be
turned into an open redirect.

### The console session

A verified identity becomes a **signed, expiring, stateless cookie**
(`strad_console_session`), and that cookie is what `/`, `/ui` and `/ui/:server`
accept. It is HttpOnly, `SameSite=Lax`, `Secure` under `NODE_ENV=production`,
scoped to `/`, and lives **12 hours absolute** — no sliding renewal, so the clock
starts at sign-in and nothing an attacker holds can extend it. Re-authenticating
is a redirect, not a password.

Stateless is a deliberate choice over a server-side session table. strad has no
datastore, and the console component may run more than one replica: a table breaks
on both — a login begun on replica A cannot be finished on replica B, and a
redeploy signs everyone out. An HMAC has neither problem. The **same** primitive
carries the in-flight OAuth transaction, so no login state lives on the server at
all.

What that costs is per-session revocation: a cookie is valid until it expires.
Three things bound it.

- The 12-hour absolute lifetime.
- `hd` is re-checked against the **current** config on every request, and roles are
  read from the **current** `auth.google.roles` rather than from the cookie. The
  cookie carries identity (`sub`, `email`, `hd`) and nothing else — tightening
  `auth.google` takes effect immediately for sessions already issued.
- Rotating the signing key invalidates every session at once. That is the kill
  switch, and it is a secret rotation rather than a deploy of new code.

The signing key is `CONSOLE_SESSION_SECRET` when set, and otherwise **derived**
(HKDF-SHA256) from `GOOGLE_CLIENT_SECRET`, which is necessarily present whenever
there is a Google login to sign — so sign-in works the moment the OAuth client is
provisioned, with no second secret to seed and no silent "signed in, but the
cookie never verifies" state. Set `CONSOLE_SESSION_SECRET` when you want to
invalidate sessions without touching the OAuth client. The session key and the
OAuth-transaction key are two separate HKDF derivations, so a value sealed for one
is unforgeable garbage to the other.

**CSRF on the callback** is the `state` parameter bound to the browser: it is
sealed into `strad_oauth_tx`, and the callback requires the cookie to verify _and_
its `state` to constant-time match the one in the URL. The cookie is cleared
before the code exchange, so a captured callback URL cannot be replayed. A
callback with no transaction cookie — a stale tab, a forged link — is a `400`, not
a login.

`auth.google.enabled` alone is **not** enough to make the gate redirect to Google.
The OAuth client credentials and a session key must both be present; otherwise the
gate keeps its honest `401` sign-in page and strad warns at boot. The alternative
is worse than the `401`: a half-configured deployment that redirects to Google and
dead-ends there is a console reachable by nobody, with nothing to point at.

`GET /console/logout` drops the session.

### Console dev bypass (temporary)

While Google OAuth credentials are being provisioned, a human can enter `/console`
with the `ADMIN_BOOTSTRAP_TOKEN`. It is **triple-guarded**: it requires
`auth.consoleDevBypass.enabled`, `ALLOW_DEV_AUTH=true`, and
(`NODE_ENV != production` **or** `ALLOW_DEV_AUTH_IN_PRODUCTION`), plus the
presented bootstrap token — and it logs loudly. **Crucially, it grants only a
console session and cannot authenticate `/mcp`.**

It sits **alongside** Google sign-in rather than behind it: the gate resolves a
Google session first and falls back to the bypass, so a deployment can have both.
Staging depends on the bypass, and it is the only way an automated actor reaches
the console at all (see [Known limitations](/limitations/)). Deleting it is a
separate change, after Google sign-in is verified working in prod — in that order,
because `src/ui/console-auth.ts` imports from `src/auth/dev.ts` and removing the
module first leaves `/ui` with no fallback authenticator.

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
