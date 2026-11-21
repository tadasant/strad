---
title: Staging OAuth rehearsal
description: How strad's own /mcp authorization server is exercised end to end on staging, with throwaway test clients and nothing but echo.
---

strad's own authorization server ([Auth](/auth/overview/#mcp--oauth-21-interactive-clients))
replaces long-lived static tokens with short-lived, scoped ones. Every feature
that does that is opt-in, and each one is proven on staging before production
turns it on. This page is how.

The test is `scripts/staging-oauth-e2e.ts`. It drives a real staging gateway with
two throwaway clients, its own locally generated key pair and the `echo` builtin,
and asserts what each step should return.

## What staging is configured to do

`infra/strad.staging.yaml` turns the authorization server on with every opt-in
feature, and closes it to everything except the test:

| Setting                                                        | Why                                                                                         |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `roles: [echo-only]`                                           | staging shares production's third-party accounts, so a grant reaches `echo` and only `echo` |
| `allowUnlistedClients: false`, `dynamicRegistration: false`    | no client but the two below can complete a grant                                            |
| `clients:` — `staging-confidential`, `staging-public`          | each capped to `servers: [echo]`, 300 s access tokens, 1 h refresh tokens                   |
| `privateKeyJwt: true`, the confidential client's `jwksUri` pin | RFC 7523 client authentication, keys taken from the pinned set only                         |
| `advertiseSlugScopes: true`                                    | `scopes_supported` lists `slug:echo`                                                        |
| `grants.enabled: true`, `store: gcs`                           | grant records, rotation with replay detection, per-token revocation, `/tokens/grants`       |

`test/staging-oauth-e2e.test.ts` checks that every policy in that block reaches
`echo` and nothing else, and that each committed client document is one strad
accepts.

The two clients are client ID metadata documents served by this docs site, from
`docs/public/oauth-test-clients/`:

- `https://docs.strad.tadasant.com/oauth-test-clients/staging-confidential.json`,
  `token_endpoint_auth_method: private_key_jwt`, keys at
  `staging-confidential.jwks.json` beside it.
- `https://docs.strad.tadasant.com/oauth-test-clients/staging-public.json`, a
  public client.
- `staging-unlisted.json`, which no config lists. It exists so the test can
  watch an unlisted client get refused.

Each one lists `http://127.0.0.1:53682/callback` and `:53683/callback` as its
redirect URIs, so a code only ever goes back to the machine running the test.
A change to them reaches strad once the docs site deploys from `main`.

## Enabled before its secrets, and still healthy

The flag is on, and the server still doesn't run until staging has a Google OAuth
client. `resolveMcpOAuth` needs `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in
`/strad/staging/gateway/static/`. Without them it logs the reason at boot,
publishes no metadata (`/.well-known/oauth-authorization-server` is a `404`),
and `/mcp` keeps taking static tokens as before. The block adds no `${NAME}`, so
the render demands nothing new.

What the rehearsal needs, and whether staging has it:

| Need                                                                                                                                 | Where                                                                                                                               | Staging today                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| A Google OAuth client (Web application, `tadasant.com`) with redirect URI `https://staging.strad.tadasant.com/oauth/callback/google` | Google Cloud Console, then `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` in `/strad/staging/gateway/static/`                          | absent ([#6](https://github.com/tadasant/strad/issues/6))                                      |
| The key the server seals with                                                                                                        | `STRAD_OAUTH_KEY`, else `CONSOLE_SESSION_SECRET`, else `GOOGLE_CLIENT_SECRET`                                                       | falls back to `GOOGLE_CLIENT_SECRET` once that exists; a dedicated `STRAD_OAUTH_KEY` is better |
| The grant store                                                                                                                      | `STRAD_STATE_GCS_BUCKET` / `_CLIENT_EMAIL` / `_PRIVATE_KEY` in `/strad/staging/gateway/static/`, a bucket that credential can write | absent: no staging component uses the state store yet                                          |
| The confidential client's private key                                                                                                | the machine running the test, never the store                                                                                       | generated with `keygen` (below)                                                                |
| A human who can sign in to the `tadasant.com` Workspace                                                                              | a browser                                                                                                                           | every run, once                                                                                |

With the Google client and no grant store, sign-in reaches the consent screen,
and consent answers `503 temporarily_unavailable`, because a new grant needs a
record. Seed both together.

## Running it

Staging sleeps every night (`teardown-staging.yml`). Dispatch `deploy-staging.yml`
on `main` first.

**1. Hold a key the published set knows.** The confidential client only accepts
assertions signed by a key in `staging-confidential.jwks.json`. If you don't hold
one:

```sh
node --experimental-transform-types scripts/staging-oauth-e2e.ts keygen \
  --key ~/.config/strad-oauth-test/staging-confidential.private.jwk.json
```

That writes the private JWK (mode 600, never printed) and adds the public half
to the set. Open a PR with the set change and merge it. strad re-fetches the set
when it sees an unknown `kid`, so no staging deploy is needed. The set holds up
to sixteen keys, so each operator can keep their own. Delete a key you have lost.

**2. Check what no sign-in is needed for.**

```sh
node --experimental-transform-types scripts/staging-oauth-e2e.ts check
```

This checks both metadata documents: the issuer, `private_key_jwt` with ES256,
client ID metadata documents, no registration endpoint, `slug:echo` as the only
slug scope, a revocation endpoint. It checks that `/oauth/register` answers `404`
and that the three client documents are served as JSON under their own URL. It
also checks two authorize-time refusals: `slug:secrets` is `invalid_scope`, and
the unlisted client gets `403`. Exit `2` means the authorization server isn't
running at all, and says why.

**3. Run the confidential client.**

```sh
node --experimental-transform-types scripts/staging-oauth-e2e.ts run --client confidential
```

It prints an authorize URL. Open it, sign in with a `tadasant.com` account and
click Allow. If the browser is on the same machine, the loopback listener catches
the code. If it isn't, the last page fails to load. Paste its address into the
terminal. Everything after that runs unattended:

| Step                | Asserts                                                                                                                                |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| code exchange       | refused without an assertion (`401 invalid_client`), then tokens with scope `slug:echo` and `expires_in` ≤ 300                         |
| `/mcp`              | `?servers=echo` lists and calls `echo__echo`, `?servers=secrets` is `424`                                                              |
| refresh             | the refresh token rotates, a refresh without an assertion is `401`, the previous token inside the 30 s grace still works               |
| access-token revoke | the revoked token gets `401`, a sibling from the same grant still works                                                                |
| grant revoke        | refused without an assertion, then the refresh token revokes the grant: its access token gets `401`, its refresh token `invalid_grant` |

**4. Run the public client.** `run --client public` repeats steps 1 to 4 of that
table, minus the assertions. It then ends differently: it waits out the grace and
presents the spent refresh token again. That replay must revoke the whole grant.

**5. Durability across a restart (optional).** `run ... --keep <file>` stops
before the terminal step and writes the live tokens to `<file>` (mode 600).
Redeploy staging, then `resume --state <file>`. The kept refresh token must
rotate, which only the durable record in GCS can make happen. Then it runs the
terminal step.

After a run, `/tokens/grants` in the staging console lists the test grants, and
the revoked ones are marked revoked.

## What it does not cover

- **Token exchange.** It isn't on `main` yet. When it lands, it adds a step after
  the code exchange, a child grant under the test grant, and the check that
  revoking the parent kills the child.
- **A different Workspace.** The test signs in as a member. The `hd` refusal is
  covered by the unit suites with a fake Google, not here.
- **A human-free run.** Every grant starts with a Google sign-in, and nothing in
  this repo holds a Workspace password. That's on purpose.
