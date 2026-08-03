# x-twitter — strad's X/Twitter MCP server

The server behind the `x-twitter-readonly` and `x-twitter-readwrite` slugs.
It is strad's local fork of PulseMCP's internal `x-twitter` server, adapted as a
private bundle tree rather than an unpublished npm package.

The safety contract is narrow: read X content and manage the authenticated
user's private bookmarks. There are no public mutation tools here: no posting,
replying, liking, retweeting, following, blocking, muting or DM tools.

## Tools

| tool | tier | what it does |
| --- | --- | --- |
| `get_my_account` | readonly | read the authenticated user's profile |
| `get_user` | readonly | look up a public user profile by handle |
| `get_home_timeline` | readonly | read the authenticated user's home timeline |
| `get_user_tweets` | readonly | read a user's recent tweet history |
| `get_bookmarks` | readonly | read the authenticated user's private bookmarks |
| `search_recent_tweets` | readonly | search recent public tweets |
| `get_tweets` | readonly | look up tweets by id |
| `create_bookmark` | readwrite | add a tweet to the authenticated user's private bookmarks |
| `remove_bookmark` | readwrite | remove a tweet from the authenticated user's private bookmarks |

The bundle host runs the full surface. strad exposes capability variants through
gateway policy: the read-only slug allows the seven read tools, and the
read-write slug allows all nine.

## Configuration

The server supports two OAuth 2.0 credential modes.

| variable | required | meaning |
| --- | --- | --- |
| `X_OAUTH_CLIENT_ID` | with refresh mode | X OAuth 2.0 client id |
| `X_OAUTH_CLIENT_SECRET` | with refresh mode | X OAuth 2.0 client secret |
| `X_OAUTH_REFRESH_TOKEN` | with refresh mode | user-context refresh token with `tweet.read`, `users.read`, `bookmark.read`, `bookmark.write`, `offline.access` |
| `X_OAUTH_ACCESS_TOKEN` | with static mode | short-lived user-context access token supplied by an external refresher |

Refresh-token mode is checked first. X refresh tokens rotate on every use, so
the process keeps the latest refresh token in memory for its lifetime. Static
access-token mode is for deployments where another system injects a fresh access
token and restarts the bundle before expiry.

## Build and test

```
npm ci
npm run build
npm test
```
