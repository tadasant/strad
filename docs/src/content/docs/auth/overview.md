---
title: Auth architecture
description: strad's two doors — Google Workspace OAuth for humans, and static system tokens or strad's own OAuth 2.1 authorization server for agents — and why ?servers= is a selection hint, never an authorization boundary.
sidebar:
  order: 1
---

strad runs on the **open internet**. There is no VPN, tailnet, or IP allowlist in
front of it — so auth is the only gate, and it is strict. There are two doors, and
they never cross:

- **`/mcp`** — machines and interactive MCP clients. Either a **static system
  token**, minted out of band and long-lived, or an **access token from strad's
  own OAuth 2.1 authorization server**, which authenticates the human behind it
  with Google.
- **`/console`** — humans. Google Workspace OAuth.

Which door accepts which credential is enforced **in code**, not config. The MCP
authenticator accepts exactly those two — not a console session, not the dev
bypass, not a console login token, and emphatically not "no header means dev mode." The prefix on the
presented credential decides which, and it decides exclusively: an `strad_oat_…`
token is never offered to the static store, and a `strad_<env>_…` token never
reaches the OAuth verifier.

## Every door reads `Authorization` the same way

Different doors take different credentials, but every one that reads an
`Authorization` header reads it by one rule: `/mcp` and `/api/secrets/readiness`
(a static token), the console gate and `/console` (the bootstrap token,
when it comes as a header rather than `?token=`), and a component's own
`STRAD_INTERNAL_TOKEN` wherever one is asked for — a strad-image bundle's
`/mcp`, every `strad-bundle` mount (`/<slug>` and `/<slug>/upload/:token`),
`/_strad/presence` on either image, and core's `/_strad/params`,
`/_strad/store/refresh` and `/_strad/reach/{slug}/mcp`.

- **The scheme is required.** `Authorization: Bearer <credential>`, with the scheme
  in any case (`bearer`, `BEARER` — scheme names are case-insensitive) and a space
  before the credential. A tab there is refused.
- **A header that is only the credential is refused.** `Authorization: <token>`
  gets the door's ordinary `401`, and so does another scheme or a `Bearer` with
  nothing after it. A hand-rolled `curl` against a component needs the scheme too:
  `curl -H "Authorization: Bearer $STRAD_INTERNAL_TOKEN" …`, run where the
  variable holds that component's token — core holds the root, which no component
  accepts.
- **One comparator.** Every compare is constant-time over utf-8 bytes, and a
  length mismatch is a plain no rather than a throw. What it compares differs by
  door: the bootstrap and internal tokens directly, and a static token by the
  SHA-256 of its secret against the stored hash.

The parse (`bearerToken`) and the comparator are written once, in
`src/secrets/presence.ts`. That module is vendored byte-identical into the bundle
host image and carries the internal-token gate, so the host's mounts and its
presence route read and compare the token with the same code core does. Core
reaches them through `src/auth/credential.ts`. `test/auth-header.doors.test.ts`
asks every door in the strad image the same questions — including a scheme-less
header carrying the right credential — and the host's own suite asks its mounts.

## `/mcp` — static system tokens (agents)

A static token is what a headless agent holds. It is the load-bearing credential
for every machine client, it is unchanged by the OAuth flow described below, and
`/mcp` accepts either.

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
- One failure is **not** a `401`: `unavailable`, meaning the record store could
  not be read at all. Nothing was decided about the credential, so nothing is
  claimed about it — the request fails with the route guard's
  `500 {"error":"internal_error"}` and the fact ships as
  `strad.token_store_unavailable`. Answering `401` would tell every agent holding
  a perfectly good token to throw it away and re-authenticate, over a read that
  timed out. It is still **fail-closed**: an unreadable store is not an empty
  store and is certainly not an open one, and nothing is admitted from either.
  One failed read is not `unavailable` on its own: a read with nothing held
  (a cold start, or the first read after a secret write) is retried first if
  it failed fast — at most two retries and 600ms of added sleep — so only a
  store that stays unreadable answers `500`.
- An unknown `pubid` still hashes and compares against a dummy all-zero hash, so
  there's no timing oracle distinguishing "no such token" from "wrong secret."
- `401`s carry
  `WWW-Authenticate: Bearer realm="strad", error="invalid_token", resource_metadata="…"`.
  The last parameter is the discovery pointer; see below.

### Where the records live

Two backings, chosen by `auth.staticTokens.store`. They read the **same name**
and the **same JSON array**, so moving between them is a config change with no
data to move — and a rollback to an older image keeps working.

| `auth.staticTokens.store` | The records are…                                                 | Mint / revoke                              |
| ------------------------- | ---------------------------------------------------------------- | ------------------------------------------ |
| `env` (default)           | the `STRAD_TOKENS` environment variable, read **once at boot**   | edit the deployment's secret, redeploy     |
| `parameter-store`         | `/strad/{env}/gateway/static/STRAD_TOKENS`, read **per request** | the console at `/tokens` — live, no deploy |

`parameter-store` requires `gateway.secrets.provider: gcp-parameter-store`; the
config schema refuses the combination without it, because there would be nothing
to read the records from.

**The store layer is read on its own, without the environment behind it.** Every
other gateway `${NAME}` resolves through the store _chained in front of_
`process.env`, so a name that has not been moved to the store yet still resolves
— that is what makes the migration off deploy-time baking reversible. `/mcp`'s
roster is the one name where that would be wrong, because boot hydration puts a
copy of it in `process.env`: a parameter later destroyed, or one that renders to
nothing, would fall through to a roster frozen at the last restart and start
admitting every token that was live then, revocations included. So the token
store reads the store layer alone, where a miss is a miss and a miss admits
nobody.

The parameter is a **secret** parameter, and that is not decoration: a non-secret
parameter's value is readable by the `secrets` MCP server's viewer credential,
and while a record carries no secret it does carry every token's label, roles and
id — which is the gateway's own access-control list.

### Managing tokens: the `/tokens` console

`/tokens` is behind the same SSO gate as the rest of the console.

- **Mint** — a label and one or more roles, ticked from the closed set the
  config's `roles:` declares. The plaintext is rendered into that response and
  nowhere else: never a URL, never an error, never telemetry. Reloading loses it.
- **Revoke** — soft, and final. `revokedAt` is set, the record stays so the
  roster can still say the credential existed, and the write drops this process's
  reading of the store, so it takes effect on the next request rather than within
  `gateway.secrets.ttlSeconds`. (That last part assumes one core instance, which
  is what strad deploys — see [Known limitations](/limitations/).) There is
  deliberately no un-revoke; mint a new token.
- **Forget** — drops a record that is already revoked, so the roster does not
  grow forever. Refused for an active one: that would be a revocation with
  nothing left to say the credential ever existed.

Under `store: env` the page still renders the roster, read-only, and says why it
cannot write.

**Two credentials, one each way.** A mint or revoke reads the records the store
holds right now, changes them, and writes them back. The write goes through the
console's admin credential. The read does not, because on prod that credential
holds no read path at all ([secrets IAM §1](/operate/secrets-iam/#1-prod-console-write-but-never-read)).
It goes through the gateway's resolver, by `:render` — the same read `/mcp` makes
of the same parameter on every request. So `/tokens` needs no read grant that
`/mcp` does not already need, and the console still cannot read a secret. When
either half is refused, the page says which credential, which permission, and
links [Token admin](/operate/secrets-iam/#token-admin) rather than answering a
bare 502.

<aside class="starlight-aside starlight-aside--caution">

**There is no `/mcp` equivalent of this page, deliberately.** A tool that minted
`/mcp` credentials would let any token that reached it mint a stronger and
durable one, so the roles on a compromised token would stop bounding the
compromise. A tool that revoked them could lock every agent out of the gateway.
Even the read is the gateway's access-control list handed to whoever holds one
token. All three are human actions behind Google SSO — the same exception the
[secret write surface](/operate/secrets/) takes.

</aside>

### Discovery: what `/mcp` says it accepts

A client that holds no token gets a `401`, and a `401` on its own is ambiguous —
it looks the same whether a gateway takes static tokens by design or has an OAuth
flow that is merely misconfigured. strad answers the question directly, with
[RFC 9728](https://www.rfc-editor.org/rfc/rfc9728) protected-resource metadata.

**The document** describes the `/mcp` endpoint and is served, unauthenticated,
from two paths:

- `/.well-known/oauth-protected-resource/mcp` — the canonical one. RFC 9728 §3.1
  forms the metadata URL by inserting the well-known string _between_ the host and
  the resource's path, so the resource `https://strad.tadasant.com/mcp` is
  described at
  `https://strad.tadasant.com/.well-known/oauth-protected-resource/mcp`.
- `/.well-known/oauth-protected-resource` — the same document at the bare path,
  which is the MCP SDK's fallback when the path-aware probe `404`s, and the path a
  human reaches for first.

```json
{
  "resource": "https://strad.tadasant.com/mcp",
  "resource_name": "strad",
  "bearer_methods_supported": ["header"],
  "resource_documentation": "https://docs.strad.tadasant.com/auth/overview/"
}
```

`resource` is the declared `gateway.publicUrl` plus `/mcp`, falling back to the
origin the request arrived on when a deployment declares no `publicUrl`.
`bearer_methods_supported` is `["header"]` and nothing else: strad reads the
credential from `Authorization` and never from a `?access_token=` query parameter
or a form body.

**The origin has to be one strad is willing to repeat back**: a bare `http(s)`
scheme, host and port, whether it came from `publicUrl` or from the request's
`Host`. Anything else — a path, userinfo, a query, a fragment, or a character a
URI cannot contain, such as the `"` that would end the header's quoted parameter
early — is refused, and a refusal is the same answer as no origin at all: the
route answers `404 {"error":"no_resource_identifier"}` and the `401` carries only
`realm` and `error`. A declared `publicUrl` that is refused is also said at boot,
because from outside it looks exactly like a deployment that declared nothing.
strad mounts `/mcp` and this document at the root of its origin, which is why a
`publicUrl` with a path is refused rather than described: the RFC 9728 pointer
for it would name a path nothing serves.

The document is served with `Cache-Control: no-store` and without CORS headers.
The first because, on a deployment with no `publicUrl`, the identifier is derived
from the `Host` and forwarded scheme of the request in hand, and a cached
`http://` identifier handed to an `https://` client fails the origin comparison a
compliant client makes. The second because strad's browser surface is
same-origin; a browser-hosted MCP client on another origin cannot read this
document or the `401`'s header, and nothing here claims otherwise.

**The pointer.** A `401` from `/mcp` names that URL in its `WWW-Authenticate`,
so discovery works from the error rather than from a guess at a well-known path:

```
WWW-Authenticate: Bearer realm="strad", error="invalid_token",
  resource_metadata="https://strad.tadasant.com/.well-known/oauth-protected-resource/mcp"
```

`realm` and `error` are unchanged and still come first — a client that reads only
those two reads exactly what it always did.

Both are **core only**. A bundle component's `/mcp` is a private-network hop
authenticated with that component's own `STRAD_INTERNAL_TOKEN`; no MCP client discovers it,
so it serves no well-known path and its `401` carries no pointer.

### `authorization_servers` names strad itself, when strad is running one

`authorization_servers` is the one RFC 9728 member whose presence is a decision
rather than a formality, and the decision is made per deployment.

**When `auth.mcpOAuth` is configured and usable**, strad _is_ the authorization
server for `/mcp`. The issuer is the same origin, and the document says so:

```json
{
  "resource": "https://strad.tadasant.com/mcp",
  "resource_name": "strad",
  "authorization_servers": ["https://strad.tadasant.com"],
  "scopes_supported": ["mcp"],
  "bearer_methods_supported": ["header"],
  "resource_documentation": "https://docs.strad.tadasant.com/auth/overview/"
}
```

**When it is not** — the flag is off, or the Google OAuth client is not seeded,
or there is no signing key — the member is absent and every `/oauth/*` route is a
`404`. That is not tidiness. Advertising an issuer whose `/authorize` does not
answer, or whose tokens `/mcp` would refuse, is worse than the `404` it replaces:
a client would run a whole consent flow and be `401`ed holding a valid access
token. One resolution (`resolveMcpOAuth`) decides what this document says, which
routes exist, and which credentials `/mcp` accepts, so the three cannot disagree.

## `/mcp` — OAuth 2.1 (interactive clients)

An MCP client that takes a URL and nothing else — claude.ai's custom-connector
dialog is the one this was built for — cannot be handed a static token. There is
no field to paste it into. So strad runs its **own OAuth 2.1 authorization
server** in front of `/mcp`, and delegates the question of _who the human is_ to
Google.

Paste `https://strad.tadasant.com/mcp?servers=granola` into the connector dialog,
sign in with a `tadasant.com` Google account, approve, and the connector is
connected. Nothing is copied or pasted.

### The endpoints

| Endpoint                                      | What it is                                                       |
| --------------------------------------------- | ---------------------------------------------------------------- |
| `/.well-known/oauth-authorization-server`     | [RFC 8414](https://www.rfc-editor.org/rfc/rfc8414) metadata      |
| `/.well-known/oauth-authorization-server/mcp` | the same document at the path-suffixed URL the MCP SDK probes    |
| `POST /oauth/register`                        | [RFC 7591](https://www.rfc-editor.org/rfc/rfc7591) registration  |
| _(none)_                                      | a client id metadata document: the `client_id` is an `https` URL |
| `GET /oauth/authorize`                        | authorization code + PKCE; the Google sign-in starts here        |
| `GET /oauth/callback/google`                  | Google comes back; the domain is enforced here                   |
| `POST /oauth/approve`                         | the consent screen's decision                                    |
| `POST /oauth/token`                           | `authorization_code` and `refresh_token`                         |
| `POST /oauth/revoke`                          | [RFC 7009](https://www.rfc-editor.org/rfc/rfc7009) revocation    |

The metadata advertises `code` as the only response type, `authorization_code`
and `refresh_token` as the grants, `S256` as the only PKCE method, and `none` as
the only token-endpoint auth method. It sets
`authorization_response_iss_parameter_supported`, and every authorization
response carries `iss` ([RFC 9207](https://www.rfc-editor.org/rfc/rfc9207)), so a
client talking to more than one server cannot be tricked into exchanging a code
at the wrong one. It sets `client_id_metadata_document_supported` beside
`registration_endpoint`, so a client can pick either way of identifying itself.
With `auth.mcpOAuth.dynamicRegistration: false` the `registration_endpoint`
member is gone and `POST /oauth/register` answers `404`.

**Scope narrows, and nothing else does anything.** There are two kinds of scope
value. `mcp`, or no scope at all, asks for everything the client's ceiling
grants. `slug:<name>` asks for that one slug, and a token issued for
`slug:granola slug:linear-ro` reaches those two slugs and no others, whatever
its roles reach. Any other word is ignored, as it always was: a client that
sends `openid` still gets a connection. A scope can never add anything — the
ceiling is server-side config (see
[per-client policy](#per-client-policy-and-slug-scopes) below) — so the only
refusal is `invalid_scope` for a `slug:` the ceiling does not reach, named in
the error, because quietly dropping it would hand the client a smaller toolset
than it asked for with nothing saying why. The token response's `scope` is what
the access token actually carries: `mcp` for an unnarrowed grant, otherwise its
`slug:` set.

`scopes_supported`, in both metadata documents, is `["mcp"]`. With
`auth.mcpOAuth.advertiseSlugScopes: true` it also lists one `slug:<name>` per
slug some client's ceiling reaches. That is off by default because both
documents are unauthenticated, and the list is the gateway's roster.

The metadata documents and the `register` / `token` / `revoke` endpoints answer
with `Access-Control-Allow-Origin: *` and a preflight, because a browser-resident
client calls them cross-origin. None of them reads a cookie, and
`Access-Control-Allow-Credentials` is deliberately never set. `/oauth/authorize`
and `/oauth/approve` get no CORS at all: they are top-level navigations carrying
the transaction cookie.

### Registration is open, and that is safe here

Registration takes no initial access token, no allowlist, and no human step. It
has to: there is nowhere for a human to pre-register claude.ai, and an allowlist
that admitted it would have to be edited by hand for the next client.

**Registering grants nothing.** A `client_id` is a name plus a set of redirect
URIs. To get a token, the holder still has to send a real human through Google,
that human still has to be a member of the configured Workspace, and that human
still has to approve the client _by name_ on strad's own consent screen.

`grant_types` and `response_types` are **narrowed rather than refused**, as RFC
7591 §2 allows. Real clients list grants strad does not serve — claude.ai's
metadata names the JWT-bearer grant, VS Code's the device grant — so a
registration is accepted as long as it includes `authorization_code` (and `code`),
and the response names the subset that was registered. A registration that
leaves out `authorization_code` — `["refresh_token"]` alone, say — is refused. A
`token_endpoint_auth_method` other than `none` is still refused by name: a
client that expects to authenticate with a secret would fail at the token
endpoint instead.

What _is_ checked is the shape of the redirect URIs, because that is where an
authorization code is delivered: `https:` only, or `http:` on `localhost` /
`127.0.0.1` / `[::1]` (the [RFC 8252](https://www.rfc-editor.org/rfc/rfc8252)
§7.3 rule for a native client); no fragment; no userinfo; at most eight, each at
most 512 characters.

There is **no client table**. The `client_id` _is_ the registration: a signed,
sealed record carrying the name and the redirect URIs. Any replica can validate
a registration any other replica issued, and a tampered `client_id` is not a
client — which is what stops someone adding a redirect URI to steal a code. It
also means the registration travels in every `/oauth/authorize` URL, which is
why the redirect URIs are capped in total as well as individually.

One thing open registration composes into, stated rather than worked around:
because an authorization error must be delivered to the registered
`redirect_uri`, **strad's domain is an open redirector to anyone who can POST**.
Registering `https://evil.example/x` and handing somebody an `/oauth/authorize`
link on strad's hostname `302`s them off it — with no cookie, no consent and no
Google hop, so nothing about it yields a token. The value is phishing rather than
access, and it is inherent to open dynamic registration. See
[Known limitations](/limitations/).

### Client ID Metadata Documents

The [MCP authorization spec](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization#client-id-metadata-documents)
prefers a second way for a client to identify itself, and strad serves it beside
registration: [OAuth Client ID Metadata
Documents](https://datatracker.ietf.org/doc/draft-ietf-oauth-client-id-metadata-document/).
The client skips `/oauth/register` and sends an `https` URL as its `client_id`.
The URL serves a JSON document naming the client and its redirect URIs —
claude.ai's is `https://claude.ai/oauth/mcp-oauth-client-metadata`, VS Code's
`https://vscode.dev/oauth/client-metadata.json`. It is on whenever
`auth.mcpOAuth` is; there is no separate key.

At `GET /oauth/authorize` strad fetches the document and checks it:

- The URL is `https`, has a path, and has no userinfo, fragment or `.`/`..`
  segment. It must already be in normalized form, because client ids are
  compared as plain strings.
- The document's `client_id` equals the URL **exactly**. A document at one URL
  cannot speak for another.
- `redirect_uris` is present and each entry passes the same rules as a
  registration's; the request's `redirect_uri` must be an exact match against
  it. `token_endpoint_auth_method`, when present, is `none`, and a
  `client_secret` is refused. `grant_types` and `response_types`, when present,
  must include `authorization_code` and `code`; anything else they list is
  ignored.

The fetch is the dangerous part, because an unauthenticated caller chooses the
URL. It is `https` only; every address the name resolves to must be public —
checked inside the socket's own DNS lookup, so the address vetted is the address
dialled and a rebinding name gets no second answer — with loopback, RFC 1918,
link-local (including `169.254.169.254`), CGNAT and reserved space refused, and
IPv6 restricted to global unicast. Redirects are not followed. The read stops at
5 KiB and the whole exchange at five seconds, and at most sixteen fetches run at
once — past that a sign-in is refused as busy rather than queued. Nothing inside the document —
`logo_uri`, `jwks_uri` — is ever fetched.

A good document is cached for its `Cache-Control: max-age`, at most an hour, five
minutes when it says nothing, and not at all for `no-store`/`no-cache`. Failures
and invalid documents are never cached. The token endpoint never fetches: the
grant was bound to its client at `/authorize`, so a refresh does not depend on
the publisher's uptime.

Every failure is a page, never a redirect — nothing about the redirect URI has
been verified yet. See [Known limitations](/limitations/) for what this costs.

### The flow, and what each step refuses

1. **`GET /oauth/authorize`.** The `client_id` must be one strad issued, or a
   metadata-document URL whose document passes the checks above, and the
   `redirect_uri` must be an **exact string match** against that client's
   registration or document. Neither of those failures is redirected: bouncing an error to an
   unverified URI is the open redirect the exact match exists to prevent, so both
   render a page instead. Past that point, every error is a proper OAuth error
   response back to the verified URI.

   **PKCE is mandatory and `S256` only.** A missing `code_challenge` is refused,
   `plain` is refused by name, and an absent `code_challenge_method` is _not_
   assumed to be `plain`.

2. **Google.** strad sends the browser to Google with `access_type=offline` and
   `prompt=consent`. Those two are what make this a _grant_ rather than a
   sign-in: they are why Google hands back a refresh token, which is the handle
   everything below depends on. `hd=tadasant.com` is also sent — as a hint to the
   account chooser, and not as the enforcement.

3. **`GET /oauth/callback/google`.** The ID token is verified (RS256, JWKS,
   issuer, audience — the same verifier the console login uses, because one of it
   is the point), and then the **Workspace test**: the `hd` claim must equal the
   configured domain, _and_ the email must end in it. A non-member gets a
   readable page saying the gateway is restricted to that domain and naming the
   account they signed in with — **not** a redirect carrying
   `error=access_denied`, which a client would render as "connection failed" and
   which would leave the human guessing.

4. **The consent screen.** Registration is open, so any client can arrive with a
   name and a destination it chose for itself. Google's consent screen cannot
   help — it asks whether the human trusts _strad_. This screen names the client,
   the account, the endpoint and the roles the grant will carry, lists the slugs
   it would reach as checkboxes, and is where the human approves or denies. The
   list is what the client asked for by `slug:` scope, or — for `mcp` — every
   slug its ceiling reaches today, all ticked. Unticking any narrows the grant to
   the rest; unticking all of them is a denial. Leaving every box ticked on an
   `mcp` request grants `mcp`, which keeps following the ceiling as the roster
   changes. The posted boxes are intersected with the sealed list the page
   offered, so the form can only untick. A client listed in
   `auth.mcpOAuth.clients` with a `name` is also shown under the operator's
   name. It also says who vouches for the name: "published by
   `claude.ai`" for a metadata-document client, "self-registered" for a
   registered one. When the code is going to a loopback listener it warns that
   any program on the machine could claim that name.

5. **`POST /oauth/token`.** The code is single-use, expires in sixty seconds, is
   bound to the client it was issued to, and is only redeemable with the PKCE
   verifier that matches its challenge.

### Per-client policy and slug scopes

Every client has a **ceiling**: a set of roles, and optionally a slug allowlist.
A client listed in `auth.mcpOAuth.clients` — by its exact metadata-document URL —
gets its entry's; every other client gets `auth.mcpOAuth.roles` and no allowlist.
A token then reaches

```
entitledServers(ceiling roles)  ∩  client servers allowlist  ∩  grant's slugs
```

where the first two come from the **deployed config**, applied at every request
and every refresh, and only the third comes from the token. A deploy that
narrows an entry therefore narrows tokens already issued. An entry
**replaces** the defaults rather than intersecting with them, so a listed
client's `roles` may be wider than `auth.mcpOAuth.roles` — the shape for "no
roles for unknown clients, `admin` for claude.ai" — and delisting a client
while `allowUnlistedClients` is `true` moves its live tokens onto the global
roles. `Principal.slugs` is the
last two intersected, and `entitledServers` applies it after the two-way role
check, so it can only remove.

```yaml
auth:
  mcpOAuth:
    enabled: true
    roles: [admin] # the ceiling for any unlisted client
    clients:
      - clientId: https://claude.ai/oauth/mcp-oauth-client-metadata
        name: claude.ai
        roles: [admin] # defaults to auth.mcpOAuth.roles
        servers: [granola, linear-ro] # optional allowlist inside those roles
        accessTokenTtlSeconds: 900 # optional; defaults to the global one
    allowUnlistedClients: true # default; false admits listed clients only
    dynamicRegistration: true # default; false turns POST /oauth/register off
    advertiseSlugScopes: false # default; true lists slug:<name> in scopes_supported
```

- **`allowUnlistedClients: false`** closes the server to the list. An unlisted
  client gets a page at `/oauth/authorize`, `invalid_client` at the token
  endpoint, and a `401` at `/mcp` — so flipping it revokes an unlisted client's
  refresh tokens at once and its access tokens within one access-token lifetime.
  A dynamically registered client's id is a sealed blob minted at registration,
  so it cannot be listed: with this off, only metadata-document clients connect.
- **`dynamicRegistration: false`** stops new registrations. Clients already
  registered keep their ids, subject to `allowUnlistedClients`.
- **A refresh may ask for less, never more.** A `scope` naming `slug:` values
  must lie inside the grant (or, for an `mcp` grant, inside the ceiling today);
  the access token carries the subset and the refresh token keeps the grant's
  scope. A refresh naming no slug — `mcp`, or nothing — gets the grant as given,
  which is what a client whose human unticked boxes it never saw will send.

The empty defaults change nothing about any grant: with no `clients` block every
client gets the global roles and TTL, and a token minted before slug scopes
existed verifies to exactly the principal it always did. A token carries a slug
set only when its client asked for `slug:` scopes or its human unticked a box.

A narrowed grant is sealed as payload version `2`; an unnarrowed one stays `1`,
exactly the shape minted before. A build that predates slug scopes opens only
version `1`, so **rolling back** makes every narrowed token and refresh token
fail (the client signs in again) rather than read as the whole ceiling.

The roster editor honours the same set: a narrowed token's `save_connector`,
`set_connector_enabled`, `remove_connector` and `restore_connector` may name
only slugs inside it.

### Access tokens expire hourly; refresh tokens never expire

**Access tokens live one hour** (`auth.mcpOAuth.accessTokenTtlSeconds`, floor 5
minutes, ceiling a day; a listed client may set its own). One hour is the conventional default and what an MCP
client expects to refresh against. It is also the revocation window, and that is
the reason for the floor: an access token is verified with no lookup, so it
cannot be revoked before it expires.

**Refresh tokens never expire.** They carry no `exp` at all — not a long one, not
a sliding one.

That is only safe because of what is inside them. A strad refresh token embeds
the **Google refresh token** for the grant, and `POST /oauth/token` with
`grant_type=refresh_token` spends it: strad calls Google, gets a **fresh ID
token**, and re-runs the Workspace test on _that_. Two things follow.

- **The domain is re-enforced on every refresh**, against Google rather than
  against a claim strad sealed an hour ago. An account that has left the
  Workspace, been suspended or been deleted fails here. Re-pointing the
  deployment at another Workspace ends every live grant too — at the next
  refresh after the deploy that changed it, since a strad config change is a
  deploy.
- **Revocation is durable and individual, and does not need a database.**
  Revoking strad from the account's own Google security page, from the Workspace
  admin console, or through `POST /oauth/revoke` — which calls Google — kills the
  grant permanently. It survives every restart and every redeploy, because the
  state lives at Google and not in strad.

Two consequences, stated rather than worked around:

- **Google revokes per user and per OAuth client, not per token.** Revoking one
  connector signs that account out of every strad OAuth connector it holds. On a
  single-Workspace deployment that is the expected reading of "revoke my access".
- **An access token already issued stays valid until it expires**, up to an hour
  after a revocation. That is the ordinary bearer-token trade, and it is what the
  one-hour lifetime is for.

An access token's audience comes from the **grant being spent** — carried in the
code, and then in the refresh token — rather than from a resource recomputed at
token time. So the value a client sent as `resource=` at `/oauth/authorize` is
the value its token is checked against at `/mcp`.

**Refresh tokens are not rotated.** Rotation's value is detecting the replay of a
stolen token, and detecting it requires a server-side record of the token just
spent. strad has nowhere to keep one — so minting a new opaque string while the
old one stayed valid would be the _appearance_ of rotation without the property.
The same token comes back.

The blunt instrument behind all of this is **`STRAD_OAUTH_KEY`**. Rotating it
invalidates every access token, every refresh token and every dynamic client
registration at once, and leaves console sessions signed in. Absent, the key is
derived from `CONSOLE_SESSION_SECRET`, else `GOOGLE_CLIENT_SECRET` — so the flow
works on any deployment that already has a console OAuth client, with no second
secret to seed.

### Audience binding, and the `?servers=` trap

Tokens are bound to a resource
([RFC 8707](https://www.rfc-editor.org/rfc/rfc8707)). The canonical resource
identifier is `https://strad.tadasant.com/mcp` — the origin plus the literal
path, **with the query stripped**.

The URL a human pastes is `…/mcp?servers=granola`, so clients send resource
indicators both ways. A resource indicator is normalised — query and fragment
dropped, a trailing slash dropped — before it is compared, and the audience check
at `/mcp` compares the token's `aud` against the canonical identifier and never
against the URL the request arrived on.

This is not an edge case, it is the acceptance test: `?servers=` is a
[selection hint and never an authorization boundary](#servers-is-a-selection-hint-not-an-auth-boundary),
so one token has to work at every query string that endpoint answers on. A token
minted for `…/mcp` is valid at `…/mcp?servers=granola`, at `…/mcp?servers=a,b`,
and at `…/mcp` bare.

A token whose `aud` names a _different_ gateway is refused. So is a token
presented when strad cannot determine its own origin — the audience check is
never skipped on the one request where it would matter most.

### No datastore, and what that costs

strad has no database, so none of the OAuth state above is written down
anywhere. (The one thing `/mcp` auth does persist is the static-token roster,
and it is a parameter rather than a database — see
[Where the records live](#where-the-records-live). Nothing in this section
shares that path.) Client
registrations, authorization codes, access tokens and refresh tokens are all
**self-contained values** sealed with a key only the process holds — HMAC where
the contents are public (a registration), AES-256-GCM where they are not (an
authorization code and a refresh token both carry a Google refresh token, and a
code travels through a browser's address bar). Six derived keys, one per kind of
value, so a refresh token presented as an access token is unreadable garbage
rather than a type confusion.

The one exception is **single-use codes**, which are a set of sixty-second
entries in memory. It is per process, and strad core runs one instance; on a
deployment scaled wider, a code replayed against another replica inside its
sixty-second window would not be caught there. What catches it is PKCE, which is
mandatory here — whoever replays an intercepted code does not hold the verifier.
See [Known limitations](/limitations/).

### Authorization is unchanged

An OAuth identity maps onto the **existing role model**. `auth.mcpOAuth.roles`
names the roles a verified member of the domain holds, and from there
`?servers=<slug>` behaves exactly as it does for a static token: the two-way
agreement between a role's `servers` and a server's `entitlements`, the same
`424` for a slug the principal cannot have.

Roles are read from **config at verification time**, never from the token — the
same rule the console session follows, and for the same reason: tightening the
config has to take effect on tokens already issued, not only on the ones minted
after it. Be precise about _when_, though: a strad config change is a **deploy**
(the document is baked into the app spec), so "already issued" means it lands
when the process restarts rather than within the hour. The same goes for the
hosted domain, which is re-checked on every access token and every refresh
against the config this process booted with.

`auth.mcpOAuth.roles` is deliberately **not** defaulted from `auth.google.roles`.
That grant is the console's, and inheriting it would mean flipping a flag
silently widened what `/mcp` hands out. The default is `[]`, which is
fail-closed — the flow completes, the token verifies, and every `?servers=` gets
a `424` — and boot warns when it is empty.

### A role is not a human

Holding a role decides which tools a caller may reach. It does not stand in for
a person saying yes. A tool that needs a human's confirmation before it acts,
gmail's `send_email` or a 1Password reveal or write, asks at the URL the request
names in `X-Elicitation-Url`, and refuses when the request names none. That
applies to an `admin` token and to the console playground as well: neither has a
prompt to show, so neither sends a mail or sees a password.
The header is checked against `gateway.elicitation.allowedUrlPrefixes`, sent
only to a slug that declares `confirmations: true`, and never logged. When an
edge in front of that URL wants strad's own credential, such as a Cloudflare
Access service token, the slug's `confirmationHeaders:` carry it. Core resolves
them, and they go only to a URL that passed the allowlist. A slug whose mailbox
is the agent's own can declare `skipConfirmations: true` instead: its confirmed
tools run without a human, it never receives the header, and every other slug
keeps asking. See [Confirming a tool before it acts](/servers/confirmations/).

### Configuring it

```yaml
auth:
  mcpOAuth:
    enabled: true
    # Optional: falls back to auth.google.hostedDomain.
    hostedDomain: tadasant.com
    roles: [admin]
    accessTokenTtlSeconds: 3600
```

Enabling the flag is not enough on its own, exactly as it is not for
`auth.google`. All of these must also hold, or the server does not run and says
why at boot:

- `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are both set.
- There is key material — `STRAD_OAUTH_KEY`, else `CONSOLE_SESSION_SECRET`, else
  `GOOGLE_CLIENT_SECRET`, and at least 24 characters of it.
- A hosted domain is declared. A config that enables the flow and declares none
  is a **hard error** at `npm run config:check`: a flow with no domain to enforce
  admits the first Google account that arrives at it.

The Google OAuth client must list `<publicUrl>/oauth/callback/google` as an
authorized redirect URI. It is the **same OAuth client** the console login uses —
one client, one consent screen, one secret to seed — and the two flows differ
only in what they ask Google for: the console asks who this is, and this one asks
for an offline grant it can re-verify and revoke.

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

`test/auth.google.test.ts` is the canary on all of it, and it needs no credential:
it generates an RSA keypair, publishes the public half as the JWKS, and signs its
own tokens. A token that is correctly signed, unexpired and carries
`email_verified: true` for an `@tadasant.com` address is still refused when `hd`
is absent or wrong — that case is the email-suffix impersonation the check exists
for. `alg: none` and an HS256 token signed with the verifying public key as the
HMAC secret are both refused at the algorithm check.

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

The **authorized redirect URI** to register on the OAuth client is derived from
`gateway.publicUrl`, so it is per-deployment: `${gateway.publicUrl}/console/oauth/callback`.
For prod that is `https://strad.tadasant.com/console/oauth/callback`; for staging,
whose `publicUrl` is `https://staging.strad.tadasant.com` (`infra/strad.staging.yaml`),
it is `https://staging.strad.tadasant.com/console/oauth/callback`. Register each
deployment's own URI — a client that names only prod's fails staging with
`redirect_uri_mismatch`. strad prints the exact string at boot when sign-in is
live, so there is something to compare against.

`gateway.publicUrl` is therefore **required** for Google sign-in. Without it the
redirect URI would be the relative string `/console/oauth/callback`, which Google
rejects, so an unset `publicUrl` keeps the gate on its 401 rather than sending
anyone into that.

### Both calls to Google are bounded at ten seconds

The callback makes two outbound calls — the code exchange at
`oauth2.googleapis.com/token`, then the JWKS fetch behind the ID-token
verification — and both are on the one route. Node's `fetch` has no overall
timeout of its own, so a Google endpoint that accepts the connection and then
stalls holds a request for undici's 300-second header timeout, and forever if it
trickles bytes. That is a sign-in that hangs rather than fails, holding an Express
handler and a socket for every attempt a human makes at a login that is never
going to arrive.

So each call carries a ten-second deadline, the request is **cancelled** when it
expires, and the expiry arrives as the same `AuthError` every other refusal on
this path uses — `google token exchange timed out after 10000ms`. Ten seconds is
strad talking to Google rather than a configured upstream, so it is a constant and
not a config key; a healthy handshake answers in well under a second.

The JWKS fetch is additionally **single-flight**: concurrent sign-ins on a cold
cache join one request rather than making one each, and the shared promise is
dropped the moment it settles either way, so a failed fetch is never cached.

The ID-token verifier is shared with the [connector consent
flow](/operate/connectors/), which calls it from its own callback, so that route
is bounded by the same ten seconds. What does not travel with it is the error
class: `AuthError` is this route's word, and one raised inside the verifier
reaches the connector callback as a failure it reports generically. That is true
of every verifier refusal on that route rather than of the deadline in
particular.

`next` is sanitised to a same-origin absolute path. A scheme-relative `//host`, a
full URL, a backslash, or **any** C0 control character or DEL falls back to
`/connectors`
— not just CR/LF, because a browser also strips TAB and FF while parsing a URL, so
`/<TAB>/host` would resolve as `//host`. The callback cannot be turned into an
open redirect.

### The console session

A verified identity becomes a **signed, expiring, stateless cookie**
(`strad_console_session`), and that cookie is what `/`, `/connectors` and
`/ui/:server` accept. It is HttpOnly, `SameSite=Lax`, `Secure` under `NODE_ENV=production`,
and scoped to `/`. Re-authenticating is a redirect, not a password.

It runs on two clocks, both set under `auth.google.session`
([config](/servers/interface/#authgooglesession)):

- **A sliding window, 48 hours by default.** Once a cookie is more than half way
  through its window, the console gate re-issues it with a fresh one on the next
  request: one extra `Set-Cookie` on an ordinary page, and no server-side record.
  A cookie nobody uses dies 48 hours after it was last sealed.
- **An absolute cap, 7 days by default,** counted from the Google sign-in. The
  cookie carries that instant as `authAt`, and renewal copies it forward and
  never moves it. Past the cap the session is refused however recently it was
  renewed, and the human goes back through Google.

So an active human signs in about once a week, and the sign-in they meet is a
redirect against a live Google session. Why these numbers: renewal happens past
the half-way mark, so a window has to be twice the longest gap it should forgive.
48 hours means any request in the second day of a window renews it, so a human
who comes back every working day stays signed in and a weekend away does not. A 24-hour window
would not end the daily bounce: a session renewed at 9am and used until 6pm is
dead the next morning. The cap is 7 days because it is the number that bounds
the case renewal makes worse, below.

Stateless is a deliberate choice over a server-side session table. strad has no
datastore, and a human's session should not depend on core staying one replica: a
table breaks on both — a login begun on replica A cannot be finished on replica
B, and a redeploy signs everyone out. An HMAC has neither problem. The **same** primitive
carries the in-flight OAuth transaction, so no login state lives on the server at
all.

What that costs is per-session revocation: a cookie is valid until it expires,
and there is no list of sessions to strike one from. Renewal makes that window
**slide**. A stolen cookie that the thief keeps using renews itself exactly as the
owner's does, so it stays live until the absolute cap, up to 7 days after the
owner signed in. A stolen cookie nobody uses dies inside one sliding window. The
same goes for a person removed from the Workspace: strad does not ask Google
again after sign-in, so a session they already hold runs its clocks out. The
cap is what keeps the first case from being forever, so it has no off switch:
config can move it, never past 30 days, and a cookie that cannot say when its
sign-in was is refused rather than uncapped. A cookie minted before `authAt`
existed was never renewed, so its `iat` is its sign-in, and the cap counts from
there. Three things bound a session.

- The two clocks. Both are read from the **current** config on every request,
  not from the cookie, so changing either one applies to sessions already
  issued. That cuts both ways: raising the cap extends every live session,
  including one somebody stole. Setting them equal gives a fixed session that never slides.
- `hd` is re-checked against the **current** config on every request, and roles are
  read from the **current** `auth.google.roles` rather than from the cookie. The
  cookie carries a verified identity (`sub`, `email`, `hd`, an optional `name`)
  plus `v`, `iat`, `authAt` and `exp` — no grant of any kind. Re-pointing
  `hostedDomain` invalidates every session already issued, on the next request.
- Rotating the signing key invalidates every session at once. That is the
  **only** way to revoke a session before its clocks run out, and it signs
  everyone out, not just the cookie you are worried about. It is a secret
  rotation rather than a deploy of new code. Revoking one session at a time needs
  a server-side session store, which strad does not have (#46, #43).

The signing key is `CONSOLE_SESSION_SECRET` when set, and otherwise **derived**
(HKDF-SHA256) from `GOOGLE_CLIENT_SECRET`, which is necessarily present whenever
there is a Google login to sign — so sign-in works the moment the OAuth client is
provisioned, with no second secret to seed and no silent "signed in, but the
cookie never verifies" state. Set `CONSOLE_SESSION_SECRET` when you want to
invalidate sessions without touching the OAuth client — but make it long. Key
material under 24 characters is **refused**, not weakened-and-accepted: the cookie
format is public, so a short key is brute-forced offline against a cookie the
attacker already holds and every session becomes forgeable. A rejected key leaves
the gate on its 401 and says so at boot. The session key and the
OAuth-transaction key are two separate HKDF derivations, so a value sealed for one
is unforgeable garbage to the other.

**CSRF on the callback** is the `state` parameter bound to the browser: it is
sealed into `strad_oauth_tx`, and the callback requires the cookie to verify _and_
its `state` to constant-time match the one in the URL. A callback with no
transaction cookie — a stale tab, a forged link, a login begun more than ten
minutes ago — is a `400`, not a login.

The cookie is cleared before the code exchange, which spends the transaction for
the browser: a stale tab cannot re-enter the flow, and the PKCE verifier stops
being live. That is a `Set-Cookie` on the response, so it binds a browser and not
a script that kept the value — what actually makes a captured callback URL
useless is Google's authorization code being single-use.

`auth.google.enabled` alone is **not** enough to make the gate redirect to Google.
The OAuth client credentials and a session key must both be present; otherwise the
gate keeps its honest `401` sign-in page and strad warns at boot. The alternative
is worse than the `401`: a half-configured deployment that redirects to Google and
dead-ends there is a console reachable by nobody, with nothing to point at.

`GET /console/logout` drops every console cookie — the Google session, the dev
bypass's, and a [token session](#console-login-tokens-the-automated-actors-door)'s,
which it also ends on the server — so "sign out" means signed out however the
caller got in.

### What the gate checks, and what it does not

The console gate asks whether a request resolves to a **Principal**, not what that
principal may do. Any verified member of `hostedDomain` therefore reaches every
console surface — `/ui/secrets` and the [secret roster](/operate/secrets/) on
`/connectors` included — whatever `auth.google.roles` says: a
`roles: []` that reads like "signed in, no permissions" grants the same console as
`roles: [admin]`. Roles are carried on the Principal and consumed by
`entitledServers()` for the `/mcp` selection; they are not a console ACL, and the
dev bypass's `consoleDevBypass.roles` works the same way. Treat `hostedDomain` as
the console's authorization boundary, and keep the Workspace membership that
clears it tight.

One decision reads those roles, and it is the one that issues MCP calls rather
than rendering config: [the playground](#the-console-playground) resolves what it
may reach through `entitledServers()`, so `roles: []` reaches every console page
and no server's tools. The icon on `/connectors` that opens it is the same
decision, so a row whose playground would refuse does not offer one.

### What the console serves, and how you get between the pages

Four destinations, and every page draws the same bar naming all four. That bar is
one definition — `NAV_DESTINATIONS` in `src/ui/nav.ts`, rendered by `layout()` —
so a page cannot disagree with its siblings about what this console can do, and a
destination added there appears everywhere at once.

| Destination  | Path          | What it is for                                                                                      |
| ------------ | ------------- | --------------------------------------------------------------------------------------------------- |
| `gateway`    | `/`           | A splash: the `/mcp` endpoint to paste into a client, and the doors into the console.               |
| `connectors` | `/connectors` | Every server — its scope, whether its secrets are seeded, and the roster editor where there is one. |
| `playground` | `/playground` | Open a server by hand: list the tools it serves you, and call one.                                  |
| `tokens`     | `/tokens`     | Mint and revoke the credentials `/mcp` accepts.                                                     |

A per-server or per-action route is **not** a fifth destination — it marks the
destination it belongs to. `/ui/slack` and `/ui/slack/connect` both light up
`connectors`; `/playground/slack` lights up `playground`; `/connectors/slack` and
`/connectors/new` light up `connectors` too. The bar's mark is a section, not a
URL, and it is carried by `aria-current="page"` as well as by colour.

Split five ways, three of those were the same list of servers: `/` as a directory
tile per slug, `/ui` as the same slugs again with their scope and secret status,
and `/connectors` as the same slugs a third time with the editor controls. Nobody
wants any of those in isolation — you read a status in order to decide what to
change — so the status is on the entry, the editor is on the entry, and `/` keeps
only the thing that is about no particular server. `/ui` and `/secrets` are both
`302`s to `/connectors`; both URLs were published, and a `404` for a page whose
content moved teaches nobody anything.

`/connectors` is served on **every** deployment, whether or not
`gateway.configStore.enabled` is set, and it renders the same roster and the same
badges either way. What the flag gates is the **editor**: the Edit / Disable /
Remove controls on each row, the "add a connector" menu, and the "removed"
section. Without a store the page says so in place of them, so nobody goes
hunting for controls that were never going to be there.

The bar is omitted on exactly the pages reached **without** a console session: the
`401` sign-in refusal, the precached offline page, and the `/mcp` OAuth consent
and refusal screens. Every link in it is gated, so drawing it there would
advertise four doors that answer `401`. `/console`, `/console/login` and
`/console/logout` are not in it either — they are the session endpoints, not
pages.

### The console playground

`/playground/:server` is a human MCP client in the console: it lists a server's
tools and calls them with arguments a human types. `/playground` with no server is
the picker: every configured slug, with the ones this console session may open as
links and the ones it may not named with the reason — `disabled` is a config
change, `not entitled` is a role change. It is derived from the same
`playgroundAccess()` the `/connectors` rows ask, so the two cannot disagree about which
slugs open. That makes it the one console
surface that has to answer an MCP question, and the two doors share no credential
— a browser holding a console session cannot present a bearer token to `/mcp`,
and `/mcp` reads no cookie.

Three ways to bridge that, and strad takes the third.

- **Teach `/mcp` to accept a console session.** Refused. The endpoint's single
  credential type is the security model, and a cookie-authenticated `/mcp` is a
  CSRF target the moment it is not a preflighted JSON `POST`.
- **Ask the human to paste a bearer token.** Honest, and it moves a long-lived
  credential into a browser tab. The store keeps only a SHA-256, so a token's
  plaintext exists at mint time and nowhere else — most operators would mint a
  **new** permanent token to read a tool list once.
- **Keep the session on the server.** The page's two `POST` routes run an MCP
  session in the core process: an SDK `Client` linked by an in-memory transport
  to the same `Server` object `/mcp` builds per request
  (`src/gateway/mcpServer.ts`). A real `initialize`, a real `tools/list`, a real
  `tools/call`, through the real adapters and the real `tools:` policy. No token
  is minted, held or presented, and `/mcp` is untouched.

What it deliberately does not do is cross the HTTP boundary, and the page says so
rather than claiming a hop it did not make.

**Roles decide what it shows, and that is a departure from the rule above.** Every
other console surface renders config, so a Principal is enough. This one issues
MCP calls, so it applies the MCP rule: `entitledServers()` then
`resolveSelection()`, on the console Principal, exactly as the endpoint does. A
server the identity is not entitled to answers `424` here as it does there, and a
deployment whose `auth.google.roles` is empty gets a console whose playground
opens on nothing. That is fail-closed and intended — the playground is the console
session's own entitlement rendered, not a privileged view of the registry.

**The icon that offers it runs the same decision.** `/connectors` draws a
playground icon on a row only where `playgroundAccess()` — the function the page
itself decides on — says this session may open it. Two things put that beyond "is
the server enabled": `entitledServers()` intersects role→servers with the server's
own `entitlements:`, so a server can be mounted and still be one the console's
role does not reach, and both console role arrays default to `[]`. On either, the
row renders and the icon does not. The row stays because roles are not a console
ACL. The control that would land on a `424` is what is withheld.

The **copy** icon beside it is deliberately not gated this way. What it copies is
`/mcp?servers=<slug>`, addressed to a token principal — a different identity — so
an operator copying the URL an agent's token will use is doing something their own
console roles say nothing about. It is withheld only for a `disabled` server,
which is mounted for nobody and refused whatever token presents it.

**CSRF** rests on the same `SameSite=Lax` cookie as every other console write: a cross-site
`POST` arrives without it and the gate `401`s. Both routes additionally require
`Content-Type: application/json`, which a cross-site `<form>` cannot send and
which puts any scripted attempt behind a CORS preflight this app answers for
nobody.

**A call is real.** The tool runs against the real upstream with the real
credentials — it sends the email, writes the row. The read-only variant of a slug
is what to inspect when that matters. Arguments and results reach no ingestor:
the tool-call span carries the slug, the tool name, the argument count and byte
size and nothing else, tagged `strad.surface=playground` so a human poking at a
tool is not counted as an agent calling it.

**A result is shown as it arrived**, one block per content item, then
`structuredContent`, then the raw JSON-RPC result. Text is written with
`textContent`, never parsed as HTML. The one item drawn rather than printed is an
`image` block of a raster type (`image/png`, `image/jpeg`, `image/gif`,
`image/webp`) whose `data` is plain base64: it becomes an `<img>` on a `data:`
URL. That is what makes `whatsapp_pair {"method":"qr"}` scannable from a laptop.
SVG is markup and stays printed as JSON, as does any payload that is not base64.

### `/api/secrets/readiness` is not a console surface

The one authenticated surface on core that the Google gate does **not** guard.
Its consumer is a platform app holding one long-lived `STRAD_API_KEY`, and a
machine has no Google identity to put in front of a redirect — so it
authenticates through `authenticateMcp` against `STRAD_TOKENS`, exactly as `/mcp`
does, including the environment check that stops a `prod` token reading
`staging`'s roster. It answers a `401` to a console session cookie and to the dev
bypass alike.

Authorization there is **narrower** than `/mcp`'s, not absent. `/mcp` narrows the
same credential through `entitledServers()` and hands back whatever subset the
token holds; a readiness report that authenticated the same way and then answered
for _every_ server would be a strict widening on the identical token — a
per-server role would learn every slug, every referenced secret name, the
canonical paths and the project id. The report cannot be meaningfully narrowed
instead, because `ready` is a claim about the whole gateway and a per-token subset
would make the same field mean different things to different callers. So the
credential has to match the scope: a token entitled to every enabled server, or a
`403`. Zimmer's `admin` token (`servers: ["*"]`) clears it; a per-server token
does not. See [Secrets](/operate/secrets/#get-apisecretsreadiness--the-same-answer-for-a-machine).

### `POST /_strad/presence` is a bundle surface, and core does not serve it

The other authenticated surface the Google gate does not guard — because it is not
on core at all. Every component that holds secrets in its own process environment
serves it: the `strad-bundle` host image, and the strad image in
`STRAD_MODE=bundle`. Core is the only caller. Both serve the same handler — it is
vendored across the npm-tree boundary with the presence vocabulary — so the
fail-closed rule below is one rule and not two copies of one.

It takes the component's own **`STRAD_INTERNAL_TOKEN`**, the token core derives
from its root for that component and already presents to proxy `/mcp` to it, so
another component's token, or the root, is a `401`. That choice is the security
argument rather than a convenience: the token is strictly stronger than the
surface — a holder can already proxy `/mcp` to every server on the component — so
mounting the route widens nothing. With the token unset the route answers `503`
rather than serving anonymously; "on the private network" is a reachability
property, not an authorization one.

**It cannot be turned into a presence oracle.** The names core asks about come
from the config core is running plus what the component itself reports under
`STRAD_PARAM_KEYS`. No request parameter on `/connectors` or
`/api/secrets/readiness`
reaches a probed name, so no caller — however privileged — can ask strad whether a
name of its own choosing exists. That matters because prod's `/mcp` credential
structurally cannot read a secret value and prod's console credential is
write-without-read: a surface that let an unprivileged caller confirm a specific
secret would dissolve both. The answer vocabulary is presence, source and
freshness; contents are not in it. See
[Secrets](/operate/secrets/#the-presence-route-a-component-answering-for-itself).

### The PWA surface is in front of the gate, because it has to be

The console is installable, and the three things that make it so —
`/manifest.webmanifest`, `/sw.js`, and the icons under `/pwa/` — answer an
anonymous request. That is not an oversight. A browser fetches
`<link rel="manifest">` **without credentials** unless the tag carries
`crossorigin="use-credentials"`, so a gated manifest is a `401` and an app nobody
can install.

Serving them ungated is acceptable for the same reason the service worker is
allowed to cache them: each is a static brand asset, byte-identical for every
visitor, naming no server, no bucket, no identity, no config value and no
hostname. `/pwa/offline` — the one page the worker precaches — is in the same
category, and it takes no arguments so it cannot accidentally leave that
category. `test/pwa.test.ts` asserts each absence against what an anonymous
caller can actually pull.

Nothing else moved. `/`, `/connectors`, `/ui/:server` and every console `POST` still sit
behind `requireConsoleUi`, and the worker declines to cache or even observe any
of them. See [The console as an installed
app](/operate/console-pwa/#what-the-service-worker-caches).

### Console dev bypass (temporary)

While Google OAuth credentials are being provisioned, a human can enter `/console`
with the `ADMIN_BOOTSTRAP_TOKEN`. It is **triple-guarded**: it requires
`auth.consoleDevBypass.enabled`, `ALLOW_DEV_AUTH=true`, and
(`NODE_ENV != production` **or** `ALLOW_DEV_AUTH_IN_PRODUCTION`), plus the
presented bootstrap token — and it logs loudly. **Crucially, it grants only a
console session and cannot authenticate `/mcp`.**

It sits **alongside** Google sign-in rather than behind it: the gate resolves a
Google session first and falls back to the bypass, so a deployment can have both.
Staging depends on the bypass, and it is the only STANDING credential an
automated actor can hold for the console — which is why a
[console login token](#console-login-tokens-the-automated-actors-door) exists, so
the actor holds something that dies in minutes instead (see
[Known limitations](/limitations/)). Deleting it is a
separate change, after Google sign-in is verified working in prod — in that order,
because `src/ui/console-auth.ts` imports from `src/auth/dev.ts` and removing the
module first leaves the console with no fallback authenticator.

### Console login tokens: the automated actor's door

A CI job or an agent driving the console with Playwright needs a session, and
handing it the bootstrap token puts a standing console credential in a job log,
a transcript or a browser profile, where it outlives the task. So the standing
credential **mints** a single-use token and the actor **exchanges** it:

| Route                              | Takes                                                              | Answers                                                                                                |
| ---------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `POST /console/tokens`             | a standing credential; optional JSON `{"roles": [...]}`            | `201` with `token` (`<jti>.<secret>`, shown once), `jti`, `roles`, `expiresAt`                         |
| `POST /console/token-login`        | `{"token": "…"}` as an `application/json` **body**                 | `200` and the `strad_console_token` cookie, or a refusal and **no** cookie                             |
| `POST /console/tokens/:jti/revoke` | a standing credential, **or** the token itself as `{"token": "…"}` | `200` with the token's `status` and whether a live session was ended; `404` for a jti it does not hold |

```sh
# In the job that holds the standing credential:
curl -s -X POST https://staging.strad.tadasant.com/console/tokens \
  -H "Authorization: Bearer $ADMIN_BOOTSTRAP_TOKEN"
# → {"token":"3f2a…c9.Xk…","jti":"3f2a…c9","roles":["admin"],"expiresAt":"…",…}

# In the actor, which only ever sees the token:
curl -s -c jar -X POST https://staging.strad.tadasant.com/console/token-login \
  -H 'content-type: application/json' -d '{"token":"3f2a…c9.Xk…"}'
curl -s -b jar https://staging.strad.tadasant.com/connectors
```

A Playwright actor does the same thing with `context.request.post(…)`, which
puts the cookie in the browser context the page then navigates in.

**A standing credential** is a Google session or the bootstrap token (as a
`Bearer` header or the bypass cookie). A token session is **not** one, so it
cannot mint its own successor and outlive its thirty minutes one hop at a time.
Nor is `?token=`: these are `POST` routes a script calls, not pages a browser
lands on.

**JSON only, wherever a cookie is involved.** The exchange sets a cookie, and a
mint or revoke may be authenticated by one, so each takes an `application/json`
body (`415 json_required` otherwise). A cross-origin page can POST a form with a
human's cookies attached, but it cannot send JSON without a CORS preflight, and
strad answers none. That is what stops a cross-origin page — a sibling
subdomain included — from minting with a human's session, or making strad set a
token session in a human's browser. (A sibling subdomain can still toss a cookie
of its own at the parent domain. The gate ranks a token session last, below both
standing credentials, so such a cookie can never shadow a human's real sign-in.)
A mint body
with a field other than `roles` is a `400`, because the alternative is a
misspelled narrowing that quietly mints the minter's full roles.

**Single use is the point.** The token is `<jti>.<secret>` — a 16-hex-character
lookup key and 32 random bytes, of which only the SHA-256 is kept. The exchange
is a compare-and-set from `active` to `consumed`, and it is atomic because it is
**synchronous**: nothing between the check and the write yields to the event
loop, so two exchanges racing in on two sockets are ordered and exactly one of
them sees `active`. `test/console-tokens.test.ts` races 25 of them over
pre-opened sockets. That makes a failed exchange mean something. An actor whose
fresh, unused token comes back `token_consumed` has learned that somebody else
spent it. The right response is to revoke it — the actor posts the same token,
as a JSON body, to `/console/tokens/<jti>/revoke`, which needs no standing
credential and ends the session the other party got — raise the alarm, and mint
once more. Retrying the same token is never right. The price of revoking by
possession is that anyone who later reads a spent token out of a job log can end
the session it opened; that is a denial of service, never an entry, and it is
why the token belongs nowhere that outlives the run. Any standing credential can
revoke any token, whoever minted it — the console's roles are not an ACL (see
[what the gate checks](#what-the-gate-checks-and-what-it-does-not)).

| The refusal      | Status | When                                                                                        |
| ---------------- | ------ | ------------------------------------------------------------------------------------------- |
| `invalid_token`  | `401`  | Garbled, unknown, or the secret half is wrong. Nothing is disclosed.                        |
| `token_expired`  | `401`  | Real, but not exchanged within ten minutes of the mint.                                     |
| `token_consumed` | `409`  | Real, and already exchanged. The tripwire.                                                  |
| `token_revoked`  | `409`  | Real, and revoked — including by having been put in a URL.                                  |
| `token_in_query` | `400`  | The token arrived as `?token=`, with any method and any body. It is revoked if it was live. |
| `json_required`  | `415`  | The body was not `application/json`.                                                        |

A caller only learns a token's state if it holds the secret. A wrong secret
against a real jti is `invalid_token`, and it does not spend the token: knowing
the public half is not enough to burn it.

**A token in any URL is burned.** A URL lands in access logs and `Referer`, so
core scans the URL of every request it receives — raw and percent-decoded, path
and query, whatever the route and whatever the parameter is called — for
anything shaped like a login token, and revokes each one whose secret verifies.
That runs before any route and before the body parser, so neither a 404 nor a
malformed body can leave one live, and a token in a URL opens nothing. The
exchange route also refuses such a request outright, with `token_in_query`.
`/ui?token=` is the bypass's sign-in, which makes it the likeliest place for one
to be pasted by mistake.

**The session** the exchange opens is thirty minutes, absolute, never renewed.
Its cookie, `strad_console_token`, is HttpOnly, `SameSite=Lax`, `Secure` under
`NODE_ENV=production`, scoped to `/`, and its `Max-Age` is the session's lifetime,
so the browser drops it when the server stops honouring it. The roles are the
minter's, fixed at mint — narrowed if the mint asked for a subset, and a request
for a role the minter does not hold is a `403`. Unlike the Google session, this
one is a server-side record, so revoking the token or signing out ends it for
every copy of the cookie.

**It can look, and it cannot act.** A token session loads every console page —
the roster, each server's parameters, the playground and its tool lists — and may
re-read the store. It is refused with a `403` on everything that reads a stored
value, writes the store, or makes an upstream act: `reveal`, `create`, `rotate`,
`note` and `delete` under `/ui/:server`, a connector's `connect` and its
`grant-client` — the widest-consequence of them, since it edits an IAM policy to
let the console read a secret back — the
playground's `tools/call`, minting, revoking or forgetting an `/mcp` token on
`/tokens` — which hands out a standing credential for the agent door, the
widest write the console has — and every runtime roster write under
`/connectors`, since an entry may name a stored credential by reference. The
rule is enforced by structure, not by review: `test/console-tokens.test.ts`
walks every mounted route and fails on any write behind the console gate that
does not refuse a token session, so a console write added later cannot quietly
skip it. That is a rule on the principal's kind, not its roles,
because the secret actions read no role and the token's whole premise is a
credential whose leak is over in minutes. Thirty minutes of `reveal` would read
the bootstrap token out of the store, and thirty minutes of `rotate` would plant a
`STRAD_TOKENS` record whose secret the writer chose — either one outlives the
session by as long as anyone likes. Driving the console's write forms therefore
still takes a standing credential.

**Where the records live, and why that is enough.** In core's memory. Core is one
process — it is rendered with `instance_count: 1` — and every config change is a
deploy, which is a restart, which empties the store. Each way that premise can
break fails closed: a restart turns an unexchanged token into `invalid_token` and
a session into the sign-in wall, and a second replica would answer a mint made on
the other one with `invalid_token` and a revoke with `404`. None of them issues a
session that should not exist. What a shared store would add is availability, and
it is written down as [a known limitation](/limitations/).

**It never exists in production.** The routes are mounted only when
`auth.consoleTokenLogin.enabled` is true **and** `gateway.env` is one of `dev`,
`local`, `test` or `staging` — an allowlist, matched exactly, so a production
deployment called `prod`, `production` or anything nobody wrote down fails
closed. There is no acknowledgement that turns them on there. Such a deployment
answers all three paths with the same `404` as a path strad never heard of, and
its gate never consults a token session. The test is `gateway.env`, not
`NODE_ENV`: staging runs `NODE_ENV=production`, and staging is where this is for.
`gateway.env` is also what binds every `/mcp` token (`strad_<env>_…`), so a
production deployment claiming to be `staging` would reject its own agents — the
claim cannot be wrong quietly. It does not depend on the dev bypass either, so it
outlives it: after [#6](https://github.com/tadasant/strad/issues/6), a Google
session is what mints.

`/mcp` is untouched. It reads the `Authorization` header against the static token
store and never a cookie; the login token and the session cookie are both a `401`
there.

Every mint, exchange and revoke is an event, and a refusal of a token whose secret
verified is `console.token_exchange_failed` — exported at ERROR, throttled per jti
and state — because it is a broken automation or a stolen token. See
[Telemetry](/operate/telemetry/).

### The two ways console auth says no

A caller who is turned away is in one of exactly two situations, and they need
opposite fixes. `consoleDenial()` in `src/auth/dev.ts` decides which, and both
`/console` (JSON) and the console's sign-in wall (HTML) render its answer, so the two
surfaces cannot drift into disagreeing.

| The 401                   | What it means                                                                           | The fix             |
| ------------------------- | --------------------------------------------------------------------------------------- | ------------------- |
| `invalid_bootstrap_token` | The dev bypass is **live** here. The token presented was missing or did not match.      | Fix your token.     |
| `console_unavailable`     | No console door at all: no usable Google OAuth, and a guard is holding the bypass shut. | Fix the deployment. |

Both carry `devBypass`: `"active"` in the first case, and the guard that is
holding — `auth.consoleDevBypass.enabled is false`, `ALLOW_DEV_AUTH is not 'true'`,
`ADMIN_BOOTSTRAP_TOKEN is not set`, `NODE_ENV=production requires
ALLOW_DEV_AUTH_IN_PRODUCTION=true as well` — in the second. One request answers
"is the bypass switched off, or is my token wrong", which is the question an
operator actually has. A request with no credential at all gets
`invalid_bootstrap_token` too: on a deployment whose only door is the bypass,
"you presented nothing" and "you presented the wrong thing" have the same fix.

Naming the first case tells an unauthenticated caller that a dev bypass is live
on that deployment, and that is deliberate. The answer only ever differs on a
deployment that clears the whole triple guard and has a token set — an operator's
explicit, loudly-logged decision to hold the console with one shared secret.
A deployment that has not (real prod, which fails closed on a copied staging spec)
gets `console_unavailable` naming the guard that holds it, which is the same thing
that refusal has always carried. It is **not** gated on `NODE_ENV`, which would
blind the one environment this is for: staging runs `NODE_ENV=production` with
both dev-auth acknowledgements set.

This is a narrower rule than the one `/mcp` follows above, where **every** failure
is one opaque `401` — and the difference is what is being distinguished. There, the
distinctions are halves of a credential: which token, which field was right. Here
it is whether a door exists at all, not how close an attempt came to opening it.
Nothing about the token itself — length, prefix, how close an attempt was — is
disclosed, and `/mcp` keeps its opaque `401`.

## Connector authorization: a third OAuth flow, and not the login one

`/console/oauth/callback` signs a **human into strad**. A connector's callback,
`/ui/oauth/callback`, obtains a **credential for a server** — and they agree on
almost nothing:

|                 | Console login                         | Connector authorization                                     |
| --------------- | ------------------------------------- | ----------------------------------------------------------- |
| Provider        | Google, always                        | `google`, or `generic` against endpoints the config names   |
| OAuth client    | the deployment's (`GOOGLE_CLIENT_ID`) | the **slug's own**, from its parameter namespace            |
| Scopes          | `openid email profile`                | the slug's capability scopes, plus `openid email` on Google |
| Identity check  | the Workspace `hd` claim              | the pinned `account` on Google; **none** on `generic`       |
| Grant type      | online                                | offline, however that provider spells it                    |
| What comes back | a session cookie                      | a durable credential, written to the slug's `oauth` kind    |
| Callback path   | `/console/oauth/callback`             | `/ui/oauth/callback`                                        |
| Signing key     | `INFO_TX` (derived)                   | `INFO_CONNECTOR` (derived, domain-separated)                |

Overloading one callback with both would mean one redirect URI, one client and one
consent posture serving two jobs that share none of them. The **one** thing a
Google connector shares with the login flow is the ID-token verifier — RS256,
Google's JWKS, issuer and audience — because a second implementation of the only
proof of identity in either flow is a second place to get it wrong.

**One callback path serves every provider.** Which server is being connected, and
under which provider and terms, is read from the sealed transaction cookie and
never from the request.

**A `remote-http` server with `oauthRefresh:` connects through the same two
routes.** Its terms are not configured but **discovered**: the connect POST asks
the upstream for its protected-resource metadata (RFC 9728) and its authorization
server's metadata (RFC 8414), registers a public client (RFC 7591) whose one
redirect URI is `/ui/oauth/callback`, and seals what it found — the client id, the
token endpoint, the resource and the issuer — into the same signed transaction
under provider `mcp`. The callback dispatches on that sealed provider after every
check above has passed. Two consequences of the cookie being signed and not
encrypted: strad only ever registers a **public** client (a secret would ride in
the browser), and a configured confidential client's secret is read from the
store at the callback, never carried. No identity is proved, exactly as for
`generic`. See [Connectors](/operate/connectors/#remote-http-with-oauthrefresh-connect-an-upstream-mcp-server).

### `provider: generic` proves no identity, and says so

A Google connector checks the verified `email` claim against the `account:` the
slug is pinned to and refuses a mismatch with nothing written. Plain OAuth 2.0 has
no equivalent — nothing in RFC 6749 says whose account a token belongs to — so a
`generic` connector stores whatever account the human was signed in as at the
provider. The console states that above the button rather than implying a check it
cannot make, the stored note claims no account, and the page renders the account
as `not checked`.

That is a real reduction in what strad can promise about a `generic` credential,
and it is the reason `google` stays a first-class variant rather than a
configuration of the generic one. What a generic flow still checks: that the
durable credential the config named actually came back, and — when the provider
names its scopes at all — that every configured scope was granted.

The grant is bound as tightly as the flow allows. PKCE (S256) is unconditional,
the redirect URI is derived from `gateway.publicUrl` and never from a request, and
the authorization parameters strad composes — `client_id`, `redirect_uri`,
`response_type`, `scope`, `state`, `code_challenge`, `code_challenge_method` —
cannot be overridden by config. The endpoints, `clientAuth` and `credential` are
sealed into the transaction alongside the provider, so a config edited while a
consent is in flight cannot redirect where a live authorization code is sent.

Both halves of a connector flow are behind the same SSO gate as every other console
surface, and the in-flight transaction is bound to the console session that began
it: a transaction cookie on its own is not an authorization. The mechanics, the
refusals and what is never exposed are on
[Connectors](/operate/connectors/).

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
  `authorize_url` of `${publicUrl}/ui/<slug>` — the console page for that
  server, or, for a slug that names nothing, the console's own not-found. It is
  never silently dropped.

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
