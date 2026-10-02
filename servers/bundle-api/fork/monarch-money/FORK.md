# monarch-money — a fork, not a vendor copy

Everything under `servers/bundle-api/upstream/` is copied verbatim: fixes go
upstream, then get re-vendored. This directory is one of three exceptions, and
it sits in `fork/` so that the difference is visible from the path.

**Forked from** `monarch-money-mcp-server-shared` v0.0.6, the `shared/` package
of [`pulsemcp/mcp-servers`](https://github.com/pulsemcp/mcp-servers)'s
monarch-money server (published as
[`monarch-money-mcp-server`](https://www.npmjs.com/package/monarch-money-mcp-server)).
The `version` field stays at `0.0.6`: it records the vendor point this fork
diverges from, and bumping it would misstate that. Nothing in strad publishes
this package — the image is the artifact.

## Why it is forked

Two divergences. The second, Monarch's move to cookie authentication, has its
own section below. The first was one defect, and the shape of it is why it could not wait for a round trip
through upstream: **`get_accounts(includeHoldings: true)` returned
`"holdings": []` for every account, on a workspace where fourteen accounts held
forty-four positions.** Not an error, not a missing key — a well-formed empty
array on all fifty-six accounts, reproduced twice twenty minutes apart.

An agent asked for that workspace's asset allocation, got nothing usable, and
fell back to bucketing from account names and transaction merchant strings. It
classified the money-market funds as equity and understated the money-market
allocation by roughly **twenty times**. A human caught it by noticing the number
looked wrong. Nothing in the analysis could have.

Filed as [tadasant/strad#183](https://github.com/tadasant/strad/issues/183).

### Two independent defects, and only one of them was diagnosable

**The query asked for a field that does not exist.** Upstream's
`Q_ACCOUNT_HOLDINGS` was:

```graphql
query GetAccountHoldings($accountId: UUID!) {
  account(id: $accountId) {
    id
    displayName
    holdings { id ticker name quantity costBasis value type closingPrice }
  }
}
```

`Account` has no `holdings` field. Monarch answers with `400` and a GraphQL
error body whose `locations` entry points at line 6 column 5 — the `holdings`
selection. That exact response is recorded in
`test/fixtures/account-holdings-400.json`.

**And the failure was swallowed twice over.** In the handler:

```ts
holdings: await client.getAccountHoldings(a.id).catch(() => []),
```

and, underneath it, in the client:

```ts
return data.account?.holdings ?? [];
```

The bare `.catch` discarded the error unconditionally, and the `??` collapsed a
null `account` into an empty portfolio with no error at all. The transport below
both of them already classified `MonarchAuthError` against `MonarchGraphQLError`
and retained Monarch's structured `errors` array; all of it was thrown away one
frame up. **Nobody could see the first defect because of the second one** — the
issue that reported this could rank the causes but not name one.

## The deltas

| File | Delta |
| --- | --- |
| `src/monarch-client/operations.ts` | `Q_ACCOUNT_HOLDINGS` → `Q_PORTFOLIO_HOLDINGS`, reshaped onto `portfolio(input:) { aggregateHoldings { edges { node { holdings { … } security { … } } } } }` |
| `src/monarch-client/client.ts` | `getAccountHoldings(accountId)` → `getHoldingsByAccount()`: one request, grouped by account id. Every structural absence throws instead of yielding `[]`, and a paginated connection is refused |
| `src/monarch-client/graphql-transport.ts` | Parse the body BEFORE branching on the HTTP status, so a `400` carrying GraphQL errors is a `MonarchGraphQLError`; `GraphQLError.locations` is typed and included in the message |
| `src/tools/accounts.ts` | The per-account `.catch(() => [])` is gone. One call, and a failure reaches the handler's existing `try/catch` |
| `src/types.ts` | `Holding` gains `typeDisplay` and a nested `security`; new `Security` interface |
| `src/monarch-client/client.integration-mock.ts` | `MockData.holdings` (flat) → `MockData.holdingsByAccount` (keyed), matching the shape the real client returns |
| `test/` | New. The fork's only defence — see below |

### The surface Monarch actually serves

Holdings are a **portfolio-wide** connection, not a field on an account.
`portfolio(input:)`'s `aggregateHoldings` edges group by SECURITY; each node's
`holdings` array is that security's per-account legs, each carrying
`account { id }`. So one request returns every account's holdings, and the
client regroups it by account.

That also removes the N+1 the old shape had by construction: one GraphQL
round-trip per account, fifty-six of them on the workspace where this was
reported, down to one for the whole portfolio.

Verified against the live `api.monarch.com` endpoint on 2026-09-05:

- **The operation name does not matter.** `GetPortfolioHoldings`, `GetHoldings`
  and the web client's `Web_GetHoldings` all return the same 200. The issue
  ranked "Monarch gates by operation name" as a live possibility, on the
  evidence that `Web_GetUploadBalanceHistorySession` in this same file carries
  Monarch's own prefix. It does not apply here, so the query keeps the plain
  name every other query in the file uses.
- **`ticker` and `name` are on the holding AND on the security.** The issue
  predicted they would live only on a nested `security`. They are on both, and
  they DIFFER: `holding.name` is the institution's string for the position
  ("Vanguard Money Market Reserves - Federal Money Market Fd USD MNT"),
  `security.name` is Monarch's canonical one ("Vanguard Federal Money Market
  Fund"). Both are surfaced, and `security.id` is the join key that identifies
  the same security held in two accounts.
- **`costBasis` is on the holding**, not only as `basis` at the aggregate level.
  It is null wherever the institution does not report one — commonly on
  money-market positions (15 of 44 in the observed response).
- **`ticker` is null** for institution-only funds with no public symbol, and
  `security.currentPrice` is null with it.
- **`type`/`typeDisplay` is the asset class** — `cash`, `equity`, `etf`,
  `mutual_fund`. This is the field whose absence produced the 20x error, and it
  is why the tool description now tells callers to bucket on it rather than
  guessing from a ticker or an account name.

### Silence is the bug, so every failure is loud

`holdings: []` has to mean "this account holds nothing" and nothing else. A
caller cannot tell an empty portfolio from a swallowed failure, and the second
one is what produces a confident wrong answer. So:

- The per-account `.catch` is gone. There is no per-account request left to
  catch, and the one call that remains propagates to the handler's `try/catch`,
  which returns `errorFromException(err)` — Monarch's own message, or the auth
  hint for a `MonarchAuthError`.
- Everything structural THROWS: a missing `portfolio`, `aggregateHoldings`,
  `edges`, `node` or `node.holdings`. A successful query cannot omit any of
  them, so their absence is a failed request or a changed schema. An empty
  `edges` array is the opposite — a real, genuinely empty portfolio — and
  returns an empty map.
- A holding that cannot be attributed to an account throws rather than being
  dropped. Silently dropping one understates a portfolio by exactly the amount
  nobody would notice.
- **A truncated page is refused.** `aggregateHoldings` is a Relay connection, so
  the query selects `pageInfo { hasNextPage }` and the client throws if it is
  true. Monarch rejects a `first:` argument and exposes no `totalCount`, so
  there is no cursor path to write — and returning the first page would report
  part of a portfolio as all of it. Observed `false` over the whole portfolio
  (31 aggregate nodes), so this has never fired; it is there because an
  undercount is precisely the failure nobody can see.

One gap this cannot close from inside the client: a holding whose account is not
in `getAccounts()` has no row to attach to in `get_accounts`, and falls out
without an error. `Q_ACCOUNTS` takes no filter and returns hidden accounts too,
so the two responses have always agreed — but they are two requests, and the
mismatch would be an undercount rather than a failure. It is noted at the call
site in `src/tools/accounts.ts`.

## The second divergence: authentication that survives Monarch's move to a cookie

Monarch's web app authenticates with an HttpOnly Django session cookie
(`sessionid`/`session_id` plus `csrftoken`) sent to
`https://api.monarch.com/graphql`, with `X-CSRFToken`, `Origin:
https://app.monarch.com` and `client-platform: web`, and no `Authorization:
Token <…>` header. A browser shows nobody a token to copy, so
`MONARCH_SESSION_TOKEN` is not something a human can produce. When the last
pasted token died, nothing said why: every tool answered "Not authenticated
with Monarch Money" and pointed at a login script this image does not ship, and an agent session
waited eleven days on it.

### The deltas

| File | Delta |
| --- | --- |
| `src/monarch-client/credentials.ts` | New. Two credential shapes, `cookie` and `token`, and the headers each one is sent with. Normalises a DevTools copy (a leading `Cookie:`, wrapping quotes, line breaks). `mergeSetCookies` folds a re-issued session into the cookie |
| `src/monarch-client/auth-manager.ts` | New. Resolves the credential **per request** from the live environment: `MONARCH_COOKIE` > `MONARCH_SESSION_TOKEN` > session store. On a refusal it runs one headless re-login (when configured) and retries the request once. `setCookie` verifies a cookie before storing it |
| `src/monarch-client/totp.ts` | New. RFC 6238, so `MONARCH_TOTP_SECRET` (the seed) can answer 2FA unattended. `MONARCH_TOTP` is a one-time code and dies after 30 s |
| `src/monarch-client/graphql-transport.ts` | Takes a `credential` instead of a `token`. Every 401/403 is a `MonarchAuthError` with a `reason` (`rejected`, `csrf`, `missing`), and never an MFA prompt. Reports `Set-Cookie` back to the manager |
| `src/monarch-client/auth.ts` | Classifies `CAPTCHA_REQUIRED` and the edge's `403 {"You":"Shall Not Pass"}` as `MonarchCaptchaRequiredError`, and `MFA_REQUIRED` as a TOTP prompt. A login that only sets a session cookie still succeeds |
| `src/monarch-client/client.ts` | `buildMonarchClient` takes the auth manager. The balance-history REST upload authenticates through it too |
| `src/tools/auth.ts` | New `set_session_cookie` (manage). `check_authentication` reports `method`/`source`/`headlessLogin`/`cookiePersistence` |
| `src/tools/helpers.ts` | `authErrorMessage`: which credential failed, why, and the exact refresh steps. Replaces the old hint about a login script |
| `src/auto-auth.ts` | Deleted. Boot-time resolution is `auth.warm()`, which logs in ahead of the first request only when login is the sole credential |

### Environment

| Variable | Meaning |
| --- | --- |
| `MONARCH_COOKIE` | The whole `Cookie` request header from a signed-in request to `api.monarch.com`. Takes precedence over every other credential |
| `MONARCH_SESSION_TOKEN` | A bearer token. Still honoured |
| `MONARCH_EMAIL`, `MONARCH_PASSWORD` | Opt-in headless re-login, tried once when a request is refused or no credential exists |
| `MONARCH_TOTP_SECRET` | The authenticator seed (base32, or the `otpauth://` URI), for 2FA during that login |
| `MONARCH_DEVICE_UUID` | Pins the `device-uuid` Monarch trusts after one paired login. Without it a container whose disk does not survive a deploy is a new device on every launch |
| `MONARCH_TOTP`, `MONARCH_EMAIL_OTP` | One-time codes, as before. Useful once, by hand, to pair a device |
| `MONARCH_COOKIE_SLUG` | Bundle host only: which gateway slug's namespace a runtime-set cookie is persisted to. Default `monarch-money-readwrite` |

### Headless login: best-effort, and the evidence for why

Some Monarch accounts can still log in headlessly through `POST
/auth/login/`, and some cannot. Since about mid-May 2026 a growing share get a
CAPTCHA. Sources, all checked on 2026-10-02:

- **Blocked.** pbassham/monarch-money-api `ccfe005` (2026-09-16) added
  `MONARCH_COOKIE` because Monarch "blocks scripted logins with bot protection".
  bradleyseanf/monarchmoneycommunity#40 (2026-05-15) recorded `403
  {"detail":"CAPTCHA is required to proceed.","error_code":"CAPTCHA_REQUIRED"}`,
  and that repo's maintainer hit it by 2026-06-04. hammem/monarchmoney#171
  reported logins refused from a cloud function and accepted from a home IP.
  echomodel/monarch-access#19 (2026-09-26) saw a `feat-cookie-auth-web` flag
  set and `403 {"You":"Shall Not Pass"}` from the login endpoint.
- **Working.** jamiew/monarch-mcp (2026-09-15) runs live tests on a fresh
  email/password/MFA-seed login. tyvsmith/monarch-money-remote-mcp#1 (merged
  2026-09-11) reports headless login verified from Cloud Run, on a trusted
  device UUID.

So the outcome depends on the account, the IP's reputation and whether the
device is trusted, and nobody has shown which of those decides it. The server
tries one login when a request is refused. It reports `CAPTCHA_REQUIRED` and
the bot block by name rather than as "MFA required". It waits 15 minutes
after ANY login attempt before the next one — including one that succeeded
but minted a credential Monarch then refused — so a login that cannot help
does not run once per tool call and push the account into a lockout. When login fails, the cookie is the fallback.

### The cookie, made durable on strad

The cookie still expires, and how long it lasts is not established. pbassham
says about 60 days, with no source. One observation, a single sample, saw the
expiry stay put after an API call, so polling the API probably does not extend
it. That is why there is no keepalive. What the server does instead:

- **Re-read live.** On a `paramsRefresh: [MONARCH_COOKIE]` slug, a cookie
  rotated in the store reaches this process within the refresh interval with
  no restart. The mount is `liveEnv`, and the manager reads `process.env` per
  request.
- **Settable over `/mcp`.** `set_session_cookie` runs a `me` query with the
  cookie. If Monarch accepts it, the cookie goes into the live environment and
  is persisted through core's `paramsWritable:` write-back to
  `/strad/{env}/mcp/<MONARCH_COOKIE_SLUG>/static/MONARCH_COOKIE`. A cookie
  Monarch refuses is stored nowhere.
- **Re-issued sessions are kept.** If a SUCCESSFUL response carries a
  `Set-Cookie` that changes the session cookie or `csrftoken`, the new value
  replaces the old in the environment and is persisted the same way, writes
  serialised so the newest lands last. Every other cookie is ignored, so an
  analytics or edge cookie rotating does not churn the parameter store, and a
  refusal that clears the session cannot write a dead cookie anywhere.
- **Expiry is loud.** Every auth failure names the credential ("Monarch cookie
  expired or was signed out (Monarch answered 401)"), says whether a re-login
  was tried and how it failed, and gives the refresh steps.

`test/auth.test.ts` pins all of it: the header set, live precedence, the
re-login and its cooldown, the CAPTCHA classification, verify-before-store, the
`Set-Cookie` fold, the RFC 6238 vectors, and that no message echoes a cookie.

## The sharp edge

A FORK has no upstream to diff against and no sync script to notice its loss: a
re-vendor that pastes `monarch-money/shared/src` over `fork/monarch-money/src`
reverts all of this with nothing to say so. What stands in for a drift test is
`test/holdings.test.ts` and `test/auth.test.ts`, run by `ci.yml`'s
`servers (bundle-api)` leg.

It asserts the two properties whose absence made a wrong answer look like a
right one:

1. **The query text** reads `portfolio(input:)` / `aggregateHoldings`, carries
   `account { id }` on each leg, selects `type`/`typeDisplay`/`security`, and
   does NOT select `account(id:`. A wrong query shape is invisible to a mocked
   client by construction — the mock returns the fixture whatever was asked for
   — which is exactly how this shipped, so the query string is asserted
   directly.
2. **Every fetch failure surfaces as an error**, never as `[]`: a null
   `portfolio`, a null `aggregateHoldings`, a null `edges`, an empty payload, a
   thrown transport error, and an auth error.

Plus the parse itself, against `test/fixtures/portfolio-holdings.json` — five
aggregate nodes recorded from a real 200 and **anonymized**: account, holding
and security ids replaced with synthetic ones, and quantities, values and cost
bases regenerated. Every SHAPE is verbatim, including which fields come back
null, because the shape is the only thing the parser can get wrong. The slice
covers one security held in four accounts, one account holding two securities
under two different nodes, a null ticker, a null cost basis, a synthetic ticker
(`US.DIRECT.INDEXING`) and all four asset classes.

A revert fails those. A revert that also deletes the tests does not — the same
hole `check-tool-policy` has, and the same answer: the test file is the artifact
under review.

## Not done here

The issue also suggested exposing holdings as its own `get_holdings` tool, since
the natural Monarch call is portfolio-wide. The issue gate rated that divergent
and did not clear it, so this fork fixes the existing
`get_accounts(includeHoldings)` path only. The portfolio-wide client method
(`getHoldingsByAccount`) is the piece such a tool would build on, if someone
files for it.

## Undo

Copy `monarch-money/shared/src` back over `fork/monarch-money/src`, `git mv
servers/bundle-api/fork/monarch-money servers/bundle-api/upstream/monarch-money`,
restore the `COPY` line in EACH of `servers/bundle/Dockerfile` and
`servers/bundle-api/Dockerfile`, point `loadApiTree` in
`servers/bundle/host/src/index.ts` back at `upstream/monarch-money/build/index.js`,
and move `fork/monarch-money` back to `upstream/monarch-money` in the
`bundle-api` workspaces and build script while dropping it from the test script.
`get_accounts(includeHoldings: true)` then reports every account as holding
nothing again, and the server goes back to a bearer token that Monarch's web
app no longer issues.
