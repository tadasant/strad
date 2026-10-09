# X MCP server

strad's X.com MCP server reads your home timeline, a user's post history, bookmarks, recent search results, and looks up individual posts and users through the X API v2 using OAuth 2.0 user context. It can also add and remove your own **private** bookmarks.

## Safety: No Public Actions by Design

This server does reads plus **private bookmark writes only**. It **never** posts, replies, likes, retweets, quotes, follows, mutes, blocks, or sends DMs — it performs no public action of any kind. The only mutations it can make are adding/removing tweets in **your own private bookmark collection**, which no one else can see. This guarantee is enforced structurally, not just by convention:

- **No public-mutation tools exist.** The only write tools are `create_bookmark` and `remove_bookmark` (see below). No code path issues any non-`GET` request other than those two bookmark endpoints.
- **No public-mutation scopes are requested.** The server and its OAuth setup flow only ever request `tweet.read users.read bookmark.read bookmark.write offline.access`. `bookmark.write` is the sole write scope and grants access only to your private bookmarks; `tweet.write`, `like.write`, `follows.write`, `dm.write`, etc. are never requested, so even a compromised token could not post, like, follow, or DM.

Functional and integration tests assert the absence of any tool whose name contains a public-mutation verb (`post`, `reply`, `retweet`, `like`, `follow`, `dm`, `mute`, `block`).

## Tool groups

The implementation defines two groups:

| Group       | Tools                                                                                                                       |
| ----------- | --------------------------------------------------------------------------------------------------------------------------- |
| `readonly`  | `get_my_account`, `get_user`, `get_home_timeline`, `get_user_tweets`, `get_bookmarks`, `search_recent_tweets`, `get_tweets` |
| `readwrite` | everything in `readonly` **plus** `create_bookmark`, `remove_bookmark`                                                      |

Inside strad, capability is enforced by the gateway's per-slug `tools:` policy, not by a container environment variable. Configure a read-only slug with the seven read tools, and opt in to the two bookmark tools only where private bookmark changes are intended.

## Tools

| Tool                   | Group     | Description                                                          | X API v2 endpoint                                  |
| ---------------------- | --------- | -------------------------------------------------------------------- | -------------------------------------------------- |
| `get_my_account`       | readonly  | The authenticated user's profile                                     | `GET /2/users/me`                                  |
| `get_user`             | readonly  | Look up a user by `@handle`                                          | `GET /2/users/by/username/:username`               |
| `get_home_timeline`    | readonly  | Reverse-chronological home timeline                                  | `GET /2/users/:id/timelines/reverse_chronological` |
| `get_user_tweets`      | readonly  | A user's own tweet history (reaches back further than recent search) | `GET /2/users/:id/tweets`                          |
| `get_bookmarks`        | readonly  | The authenticated user's bookmarks                                   | `GET /2/users/:id/bookmarks`                       |
| `search_recent_tweets` | readonly  | Search tweets from the last 7 days                                   | `GET /2/tweets/search/recent`                      |
| `get_tweets`           | readonly  | Look up one or more tweets by id (≤100)                              | `GET /2/tweets`                                    |
| `create_bookmark`      | readwrite | Add a tweet to your **private** bookmarks                            | `POST /2/users/:id/bookmarks`                      |
| `remove_bookmark`      | readwrite | Remove a tweet from your **private** bookmarks                       | `DELETE /2/users/:id/bookmarks/:tweet_id`          |

All tweet-returning tools request rich expansions and fields: author profile, `created_at`, `public_metrics`, `referenced_tweets`, and `note_tweet` (so long-form tweets are returned in full rather than truncated).

### On search reach

`search_recent_tweets` is limited to the **last 7 days** by the X API's standard recent-search endpoint. For older posts from a specific account, use `get_user_tweets`, which pages back through a user's timeline (the API exposes up to ~3,200 of their most recent tweets). Full-archive search (`GET /2/tweets/search/all`) is **not** exposed — it requires a higher, separately-gated API access level.

## strad bundle mount

The bundle host mounts this server at `/x-twitter` from `servers/x-twitter/shared/build/index.js`. Two slugs serve that one mount, and the gateway's per-slug `tools:` policy is the only difference between them:

| Slug           | Tools                                                                                                                       |
| -------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `x-twitter`    | `get_my_account`, `get_user`, `get_home_timeline`, `get_user_tweets`, `get_bookmarks`, `search_recent_tweets`, `get_tweets` |
| `x-twitter-rw` | all of the above, plus `create_bookmark` and `remove_bookmark`                                                              |

Tool names and behaviour match the standalone `pulsemcp-x-twitter-mcp-server` package with `X_TWITTER_ENABLED_TOOLGROUPS=readonly,readwrite`. Inside strad the gateway picks the tier, not that variable.

### Two slugs, one rotating refresh token

The refresh token is single-use, so the two slugs cannot each hold a copy. Whichever one refreshed first would invalidate the other's. They share it instead:

- **One mount, one client.** The host calls `createMCPServer` once for `/x-twitter`, and `registerHandlers` memoises the X client for the mount's lifetime, whichever slug a request came in on. Both slugs' calls go through one `RefreshTokenProvider`, which collapses concurrent refreshes into one exchange. Each rotation persists in order, because `onRefreshToken` is awaited.
- **One owner of the credential.** `x-twitter` owns `params: true`, `paramsWritable: [X_OAUTH_REFRESH_TOKEN]` and the `oauth:` connector. `x-twitter-rw` declares none of them. strad's config check refuses a twin that lists the variable under its own `paramsWritable:` or names it on its own `oauth:` connector, because either one creates a second copy of the token in a namespace the mount never reads.
- **One replica.** The render refuses `instanceCount` above 1 on a component with a `paramsWritable:` server.

Two consequences:

- **The consent asks for the union of the scopes,** `bookmark.write` included, and it happens on `x-twitter`. The read tier is then bounded by its `tools:` policy alone, not also by its token.
- **Do not disable `x-twitter` to withdraw the read tier.** A disabled server is not rendered, so its namespace (and with it the token) never reaches the container, and `x-twitter-rw` stops working. Take the read tier out of a role's `servers:` instead.

`tests/functional/shared-credential.test.ts` proves the runtime half, and strad's `test/params-writable.shared-mount.test.ts` proves the config half.

### A write on a token without `bookmark.write`

X answers 403, and reads keep working, so nothing else points at the scope. The bookmark tools say so. When the provider knows what X granted (refresh-token mode, after the first refresh), the error names the granted scopes, says `bookmark.write` is missing, and says the fix is a new consent with it added. In static-access-token mode it names the scope as the likeliest cause.

## Prerequisites: X API access tier

The endpoints use X API credits. Create an app and configure its OAuth permissions in the [X Developer Console](https://console.x.com/) before connecting the server. X bills reads by returned resource and bookmark changes per request; set a budget before enabling broad searches.

## Authentication

The server authenticates with **OAuth 2.0 Authorization Code + PKCE** using a **confidential client** (client id + client secret). It supports two modes.

### Option 1: Refresh-token mode

You supply a long-lived refresh token once; the server exchanges it for short-lived access tokens as needed and rotates the refresh token in memory.

Required environment variables:

| Variable                | Description                                              |
| ----------------------- | -------------------------------------------------------- |
| `X_OAUTH_CLIENT_ID`     | OAuth 2.0 client id (confidential client)                |
| `X_OAUTH_CLIENT_SECRET` | OAuth 2.0 client secret                                  |
| `X_OAUTH_REFRESH_TOKEN` | Refresh token minted via the one-time consent flow below |

### Option 2: Static access-token mode

You inject a short-lived access token that some external process refreshes and rotates. The server uses it as-is and does **not** refresh it itself. This mirrors how other servers in this harness (e.g. Zoom, Slack) are run in CI and production, where a central refresher hands out fresh tokens.

| Variable               | Description                                            |
| ---------------------- | ------------------------------------------------------ |
| `X_OAUTH_ACCESS_TOKEN` | A valid, unexpired OAuth 2.0 user-context access token |

## Minting a refresh token

X does not offer a non-interactive way to obtain a user-context token — a human must authorize the app in a browser once. From this repo, use the local setup command:

```bash
npm --prefix servers/x-twitter install
npm --prefix servers/x-twitter/local run dev -- oauth-setup <client_id> <client_secret>
```

Or pass credentials via environment variables:

```bash
X_OAUTH_CLIENT_ID=... X_OAUTH_CLIENT_SECRET=... npm --prefix servers/x-twitter/local run dev -- oauth-setup
```

The command:

1. Generates a PKCE `code_verifier`/`code_challenge` (S256). The verifier is never printed.
2. Starts a loopback HTTP server on `http://localhost:3000/callback` (override the port with `PORT=...`).
3. Prints an X consent URL requesting the scopes `tweet.read users.read bookmark.read bookmark.write offline.access` (`bookmark.write` is the only write scope — private bookmarks only).
4. Waits for you to sign in, authorize, and be redirected back with an authorization code.
5. Exchanges the code (with the PKCE verifier and HTTP Basic client auth) for tokens and prints the resulting `X_OAUTH_REFRESH_TOKEN`.

**Before running it**, register the redirect URI on your X app in the developer portal:

```
http://localhost:3000/callback
```

### ⚠️ X refresh tokens are single-use and rotate

Unlike Google, **X refresh tokens rotate on every use**: each token refresh returns a _new_ refresh token and invalidates the previous one. Refresh tokens also expire (~6 months).

Implications:

- **Refresh-token mode** keeps the rotated token in memory for the life of the process. On its own that is not restart-safe after the first successful refresh: a restarted process reads the originally configured `X_OAUTH_REFRESH_TOKEN`, which X has already invalidated.
- **A host can make it restart-safe** by supplying `XTokenPersistence` to `createTokenProviderFromEnv` / `createXClientFromEnv` — the current token to start from, and an `onRefreshToken` hook that stores each new one. Without it the behaviour is unchanged, which is the right default for a standalone run with nowhere to store anything.
- **On strad, that host is the bundle**, and the store is strad's parameter store. Declare the variable writable and the credential survives restarts with no re-seeding:

  ```yaml
  params: true
  paramsWritable: [X_OAUTH_REFRESH_TOKEN]
  ```

  The container holds no cloud credential: it persists through core, which owns the store-admin key. See strad's docs, [a credential that rotates on use](https://strad.tadasant.com/operate/secrets/#paramswritable-a-credential-that-rotates-on-use).

- **Static access-token mode** remains the option for a deployment with its own central refresher. strad does not include one.

## strad configuration

```yaml
- slug: x-twitter
  kind: supplementary-image
  image: ghcr.io/tadasant/strad-bundle:latest
  bundle: bundle
  path: /x-twitter
  entitlements: [admin]
  params: true
  paramsWritable: [X_OAUTH_REFRESH_TOKEN]
  oauth:
    provider: generic
    label: X
    authorizeUrl: https://x.com/i/oauth2/authorize
    tokenUrl: https://api.x.com/2/oauth2/token
    clientAuth: basic
    # The union of both tiers' needs: bookmark.write is for x-twitter-rw.
    scopes:
      [tweet.read, users.read, bookmark.read, bookmark.write, offline.access]
    clientIdVariable: X_OAUTH_CLIENT_ID
    clientSecretVariable: X_OAUTH_CLIENT_SECRET
    refreshTokenVariable: X_OAUTH_REFRESH_TOKEN
  tools:
    allow:
      - get_my_account
      - get_user
      - get_home_timeline
      - get_user_tweets
      - get_bookmarks
      - search_recent_tweets
      - get_tweets

# Same bundle, same path: one mount. No credential of its own.
- slug: x-twitter-rw
  kind: supplementary-image
  image: ghcr.io/tadasant/strad-bundle:latest
  bundle: bundle
  path: /x-twitter
  entitlements: [admin]
```

## Development

This server follows the `local/` + `shared/` workspace split. strad's bundle image imports only `shared/build/index.js`.

```bash
# Build
npm --prefix servers/x-twitter run build

# Functional tests (mocked X API — no network)
npm --prefix servers/x-twitter test

# E2E tests (real X API — requires credentials)
npm --prefix servers/x-twitter run test:e2e
```

E2E tests read credentials from `X_OAUTH_*` environment variables or a decrypted `tests/e2e/.env`, and skip gracefully when none are present.
