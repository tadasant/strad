# google-search-console, without strad

This is strad's Google Search Console MCP server. It reads one Google account's
Search Console properties: search performance, sitemaps and URL inspection. It
writes nothing. You can run it on its own, with no strad gateway: over
**stdio** for a local MCP client, or over **Streamable HTTP** on a localhost
port.

The server is strad's own. It was written here, not vendored, and has the same
shape as `../google-sheets-shared`. The standalone entrypoint is
`../../src/standalone/google-search-console.ts`. In strad, the bundle mounts it
at `/google-search-console` and once per slug with an `oauth:` connector; see
strad's `docs/servers/google-search-console`.

## Tools

Six, all reads, on one scope, `https://www.googleapis.com/auth/webmasters.readonly`:

| Tool                     | Search Console API call         |
| ------------------------ | ------------------------------- |
| `list_sites`             | `sites.list`                    |
| `get_site`               | `sites.get`                     |
| `query_search_analytics` | `searchanalytics.query`         |
| `list_sitemaps`          | `sitemaps.list`                 |
| `get_sitemap`            | `sitemaps.get`                  |
| `inspect_url`            | `urlInspection.index.inspect`   |

There is no tool group toggle. A `webmasters.readonly` token cannot add a site
or submit or delete a sitemap, and no tool here tries.

`site_url` is the property as Search Console stores it: `sc-domain:example.com`
for a Domain property, or the full URL with its trailing slash for a URL-prefix
property, `https://www.example.com/`. `list_sites` returns the exact strings.

## Build

You need Node 22 or later. The server is one npm workspace of the
`images/bundle-google` package, so install and build from there:

```bash
git clone https://github.com/tadasant/strad.git
cd strad/images/bundle-google
npm ci
npm run build
```

The entrypoint is then `dist/standalone/google-search-console.js`. The examples
below run from `images/bundle-google`.

## Credentials

The server signs in as **one Google account** with an OAuth refresh token. It
sees every property that account sees in Search Console. There is no
service-account mode.

| Variable                                    | What it is                                                         |
| ------------------------------------------- | ------------------------------------------------------------------ |
| `GOOGLE_SEARCH_CONSOLE_OAUTH_CLIENT_ID`     | your OAuth client's id                                             |
| `GOOGLE_SEARCH_CONSOLE_OAUTH_CLIENT_SECRET` | its secret                                                         |
| `GOOGLE_SEARCH_CONSOLE_OAUTH_REFRESH_TOKEN` | a refresh token for the account, consented for `webmasters.readonly` |

**Getting a refresh token** with the OAuth Playground:

1. In a Google Cloud project, enable the **Google Search Console API**, and
   create an OAuth client of type **Web application** with the authorized
   redirect URI `https://developers.google.com/oauthplayground`.
2. Open <https://developers.google.com/oauthplayground>, click the gear, tick
   **Use your own OAuth credentials** and paste the client id and secret.
3. In "Input your own scopes", enter
   `https://www.googleapis.com/auth/webmasters.readonly`. Click **Authorize
   APIs** and sign in as the account that has the properties.
4. Click **Exchange authorization code for tokens** and copy the refresh token.

While the OAuth consent screen is in **Testing** mode, Google expires the
refresh token after 7 days. Every call then fails with `invalid_grant`, and the
error says to mint a new token.

None of the credentials is needed to start. The server reads them on the first
tool call, so with nothing set it still boots and answers `tools/list`, and
every tool call returns an error naming the missing variables.

## Run it locally (stdio)

```bash
GOOGLE_SEARCH_CONSOLE_OAUTH_CLIENT_ID=1234-abc.apps.googleusercontent.com \
GOOGLE_SEARCH_CONSOLE_OAUTH_CLIENT_SECRET=GOCSPX-... \
GOOGLE_SEARCH_CONSOLE_OAUTH_REFRESH_TOKEN=1//0g... \
node dist/standalone/google-search-console.js
```

Start it with `node` directly, not through `npm run`: npm prints a banner to
stdout, and in stdio mode stdout carries only protocol messages.

For Claude Code:

```bash
claude mcp add google-search-console \
  -e GOOGLE_SEARCH_CONSOLE_OAUTH_CLIENT_ID=1234-abc.apps.googleusercontent.com \
  -e GOOGLE_SEARCH_CONSOLE_OAUTH_CLIENT_SECRET=GOCSPX-... \
  -e GOOGLE_SEARCH_CONSOLE_OAUTH_REFRESH_TOKEN=1//0g... \
  -- node /absolute/path/to/strad/images/bundle-google/dist/standalone/google-search-console.js
```

## Run it as an HTTP service on localhost

```bash
node dist/standalone/google-search-console.js --transport http --port 3200
# [google-search-console] serving MCP on http://127.0.0.1:3200/mcp
```

`--transport`, `--port` (else `PORT`, default `3000`) and `--host` (default
`127.0.0.1`) work as for the other standalone servers in this image. `GET
/healthz` returns `{"ok":true,"server":"google-search-console"}` and never
contacts Google.

**The HTTP endpoint has no authentication.** Anyone who can reach the port can
read the account's Search Console data. Keep it on loopback, or put something
that authenticates in front of it. That is what strad adds.

## Limits

- `query_search_analytics` returns at most 25,000 rows per call (100 by
  default). Page with `start_row`.
- Search Console data runs two to three days behind. The default window, the
  28 days ending today in Pacific time, has empty final days unless `data_state` is
  `all`.
- `inspect_url` reads Google's indexed copy. The API has no live test and no
  request-indexing call, and Google allows 2,000 inspections a day per property.

## Tests

From `images/bundle-google`, `npm test` runs:

- `vendor/google-search-console-shared/test/` — every request's URL, method
  and body (including how a property is encoded into the path), the 429 retry
  and the 401/403 hints; the OAuth client's one-exchange-per-burst, hashed
  cache key, `invalid_grant` hint and 401 refresh; and each tool against a fake
  client.
- `test/standalone.test.ts` — both transports against the built entrypoint,
  with no credentials set.

Nothing in CI calls Google (`HACKS.md` #173).
