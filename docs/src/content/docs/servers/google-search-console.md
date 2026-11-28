---
title: Google Search Console
description: strad's own read-only Google Search Console MCP server — six tools over properties, search performance, sitemaps and URL inspection, one Google account per slug.
---

Read a site's Google Search performance and index status from an agent, as a
specific Google account.

`google-search-console` is strad's own MCP server — source in
`images/bundle-google/vendor/google-search-console-shared/`, mounted at
`/google-search-console` inside the bundle image. Google publishes no Search
Console MCP server, so this one is written against the
[Search Console API](https://developers.google.com/webmaster-tools/v1/api_reference_index).
It serves six tools, and every one of them reads.

## Tools

| Tool                     | What it reads                                                                                                                                       |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_sites`             | Every property the account can see, with its permission level. Call it first: the other tools match `site_url` exactly                             |
| `get_site`               | One property's permission level                                                                                                                     |
| `query_search_analytics` | Clicks, impressions, CTR and average position, grouped by query, page, country, device, date, hour or search appearance, with filters and paging |
| `list_sitemaps`          | The submitted sitemaps, or one sitemap index's children, with Google's processing status                                                           |
| `get_sitemap`            | One sitemap's status: submitted, last read, errors, warnings, URL counts                                                                            |
| `inspect_url`            | URL Inspection on Google's indexed copy: verdict, coverage, last crawl, canonicals, rich results                                                    |

A property is spelled the way Search Console stores it: `sc-domain:example.com`
for a Domain property, `https://www.example.com/` (with the trailing slash) for
a URL-prefix one. A bare `example.com` is refused with both spellings, rather
than sent and answered with a 403 that reads like a permissions problem.

`query_search_analytics` returns a header and tab-separated rows. It defaults to
the 28 days ending today in Pacific time (Search Console's day), `type: web`,
settled data only, and 100 rows;
`row_limit` goes to Google's ceiling of 25,000 and `start_row` pages, and the
output names the next `start_row` when a page came back full.

Nothing here submits or deletes a sitemap or adds a site. Those are the API's
only writes, and this server has no tool for them.

## One account per slug

The server authenticates the way [google-sheets](/servers/google-sheets/) does:
as a person, with an OAuth refresh token minted in strad's console. There is no
service-account mode. The bundle host mounts one instance per slug it finds the
OAuth client id and secret for, under
[that slug's own variable names](/operate/secrets/#what-a-servers-variables-are-called-on-the-box),
and a slug that has not been connected yet still mounts, `degraded`, so its
console page can offer the Connect button.

```yaml
- slug: google-search-console-someone
  kind: supplementary-image
  image: ghcr.io/tadasant/strad-bundle:latest
  bundle: bundle
  path: /google-search-console-someone
  entitlements: [admin, readonly]
  oauth:
    provider: google
    account: someone@example.com
    scopes:
      - https://www.googleapis.com/auth/webmasters.readonly
    clientIdVariable: GOOGLE_SEARCH_CONSOLE_OAUTH_CLIENT_ID
    clientSecretVariable: GOOGLE_SEARCH_CONSOLE_OAUTH_CLIENT_SECRET
    refreshTokenVariable: GOOGLE_SEARCH_CONSOLE_OAUTH_REFRESH_TOKEN
```

**Name the three variables.** An `oauth:` connector defaults to google-sheets'
names. A Search Console slug left on them is discovered by the google-sheets
tree and serves spreadsheets. See
[Connectors](/operate/connectors/#name-the-three-variables-the-servers-own-tree-reads).

**One scope, no tiers.** `webmasters.readonly` covers all six tools, and Google
refuses it every write the API has, so there is no `-rw` slug to make and no
`tools:` list to keep.

**A slug sees every property its account sees.** Search Console grants a
property to an account, and a token cannot be narrowed to one property. To expose
one domain, connect an account that has only that domain.

**A slug arrives by deploy.** google-search-console is not a store-served
instance tree: there is no `/_instance/google-search-console/{slug}` path, so a
slug created at runtime is not served until a deploy puts its variables on the
bundle. Check its slug into config and deploy.

The GCP project behind the OAuth client needs the Search Console API
(`searchconsole.googleapis.com`) enabled; a call that finds it disabled says so.

## Errors

A 401 drops the cached access token so the next call mints a fresh one. A
refresh token Google no longer accepts (`invalid_grant`) names the slug's
console page to reconnect at. A 403 is classified by Google's reason: a token
missing `webmasters.readonly`, the API disabled on the project, or a property
the account cannot see, which points back at `list_sites`. A 429 is retried
once after its `Retry-After`, capped at ten seconds, and a second one says to
wait.

## Without strad

`src/standalone/google-search-console.ts` runs the same server over stdio or on
a localhost port. `vendor/google-search-console-shared/README.md` in the
bundle-google image is the how-to.

## What it has not met

Every test fakes the network; no request from this server has reached Google.
[Limitation #173](/limitations/#173-google-search-console-is-strads-own-server-and-has-met-only-fakes)
has the rest.
