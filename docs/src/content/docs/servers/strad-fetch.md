---
title: strad fetch
description: How strad fetches a web page, why the paid scraping credentials are an optimisation rather than a dependency, and what the fork of pulse-fetch changed to make that true.
---

Fetch a web page from an agent and get it back as Markdown. `strad-fetch` is
strad's own MCP server — source in `servers/strad-fetch/`, mounted at
`/strad-fetch` inside the bundle image.

It is a **fork** of PulseMCP's [`@pulsemcp/pulse-fetch`][upstream], and the fork is
not cosmetic. Every delta comes from one difference: upstream runs as an `npx`
subprocess inside a single client session, and strad runs it as one long-lived
mount that many sessions reach through the gateway.
`servers/strad-fetch/FORK.md` lists them with the evidence for each.

[upstream]: https://www.npmjs.com/package/@pulsemcp/pulse-fetch

## The tool

One tool, `scrape`. It takes a URL and returns the page, cleaned to semantic
Markdown by default.

| Parameter        | Default         | What it does                                                                    |
| ---------------- | --------------- | ------------------------------------------------------------------------------- |
| `url`            | _required_      | The page. A bare hostname is accepted and gets `https://`.                       |
| `resultHandling` | `saveAndReturn` | `returnOnly`, `saveAndReturn`, or `saveOnly` — see below.                         |
| `cleanScrape`    | `true`          | HTML → semantic Markdown, dropping nav and boilerplate. `false` for raw bytes.    |
| `maxChars`       | `100000`        | Truncate the returned text.                                                      |
| `startIndex`     | `0`             | Read from an offset — paginate a long page with `maxChars`.                        |
| `timeout`        | `60000`         | Page-load budget in milliseconds.                                                |
| `forceRescrape`  | `false`         | Skip the cache.                                                                  |

`saveAndReturn` stores the page as an MCP resource **and** returns its text;
`saveOnly` returns only a resource link; `returnOnly` returns text and stores
nothing. strad's gateway proxies resources as well as tools, so a link a `saveOnly`
call returns is readable through the same `/mcp` endpoint.

The surface does not change with the container's environment — one tool, seven
parameters, always. That is deliberate, and it is one of the fork's deltas:
upstream grows an eighth parameter when LLM credentials are present, which would
mean the image advertising one tool in CI and a different one in production.

## Three strategies, and why a missing key is not a failure

| Strategy     | Needs                | Good for                                    |
| ------------ | -------------------- | ------------------------------------------- |
| `native`     | nothing              | most public pages                            |
| `firecrawl`  | `FIRECRAWL_API_KEY`  | pages that need JavaScript rendered           |
| `brightdata` | `BRIGHTDATA_API_KEY` | pages behind anti-bot measures                |

The chain runs in order until one returns content, and the strategy that worked is
remembered per URL prefix, in a table under the container's temp directory. A
subsequent request to that prefix starts with the strategy that worked last time
and falls through the rest if it does not.

**`native` is always in the chain.** Upstream's `speed` mode omits it, which turns
a deployment with no working paid key into a deployment that cannot fetch
anything — including a plain public page. Here `speed` **demotes** native to last
rather than dropping it, so the paid credentials buy coverage on sites that block a
bare `fetch` and never stand between the tool and the open web.

**A rejected key does not stop the chain either.** Upstream returns as soon as a
strategy reports an authentication failure. Here it is recorded and the next
strategy runs; if everything fails, the error names the strategies whose
credentials were rejected — `Credentials REJECTED by: brightdata` — separately
from what the site itself said, because those are different things to fix.

Both deltas come from one incident. On 2026-08-16 the deployment ran
`OPTIMIZE_FOR=speed` with an empty Firecrawl key and an invalid BrightData key.
Upstream's chain had nothing that could succeed, so every fetch failed — and
because upstream's stdio entrypoint also **probes both credentials at boot and
exits 1** when one is rejected, the subprocess never started at all, which killed
the agent session hosting it.

## There is no boot-time credential probe

strad vendors only upstream's `shared/` package. The entrypoint that ran the health
check is not here, and neither is the health check. A rejected credential surfaces
in the result of a tool call that needed it, which is the only place it can be
acted on.

That is also why this mount is never reported `degraded` on the bundle's health
route, unlike `pulse-subregistry`: there is no credential whose absence stops it
serving.

## Configuration

Nothing is required. The image is credential-free; strad injects what it has
through the server's `env:` map.

| Variable                           | Default | What it does                                       |
| ---------------------------------- | ------- | -------------------------------------------------- |
| `BRIGHTDATA_API_KEY`               | unset   | Enables the `brightdata` strategy.                  |
| `FIRECRAWL_API_KEY`                | unset   | Enables the `firecrawl` strategy.                   |
| `STRAD_FETCH_OPTIMIZE_FOR`         | `cost`  | `cost` (native first) or `speed` (native last).      |
| `STRAD_FETCH_CACHE_MAX_ENTRIES`    | `512`   | Resource-cache entry cap.                           |
| `STRAD_FETCH_CACHE_MAX_BYTES`      | `64MB`  | Resource-cache byte cap.                            |
| `STRAD_FETCH_STRATEGY_CONFIG_PATH` | temp    | Where the learned strategy table lives.              |

The two credential names are bare because each names one vendor and nothing else in
the bundle image reads them — the same reasoning that leaves `SLACK_BOT_TOKEN`
bare. Everything else is namespaced, because the bundle is one container and a
generic name there is a claim on nineteen other mounts.

## The cache, and what it is shared with

A scraped page is cached in the process, so a repeated fetch of a URL is free. The
cache is **LRU-bounded** on entry count and total bytes — upstream's is unbounded,
which is correct for a subprocess the OS reclaims and an out-of-memory risk in a
container hosting twenty mounts.

It is also **one cache for every caller of the slug**, which is a limitation rather
than a feature: see [limitation #65](/limitations/#65-strad-fetchs-scraped-page-cache-is-shared-by-every-caller-of-the-slug).
