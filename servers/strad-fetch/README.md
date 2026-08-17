# strad-fetch — strad bundle tree

`strad-fetch` is strad's fork of PulseMCP's `pulse-fetch` MCP server. It fetches a
web page and returns it as Markdown, trying the cheapest strategy that works and
remembering which one did.

It is packaged like `pulse-subregistry` and `remote-filesystem`: a `shared/` MCP
server tree inside the main `ghcr.io/tadasant/strad-bundle` image. The bundle host
serves it at `/strad-fetch`.

**The fork is not cosmetic** — it changes what happens when a credential is
missing or rejected, which is the reason it exists. Read
[`FORK.md`](FORK.md) before changing anything here or re-vendoring from upstream.

## The tool

One tool, `scrape`. Give it a URL; it returns the page, cleaned to semantic
Markdown by default, either inline, as an MCP resource, or both
(`resultHandling`). Repeat calls to a URL are served from the in-process cache
unless `forceRescrape` is set.

## Strategies

| strategy     | needs                | good for                                     |
| ------------ | -------------------- | -------------------------------------------- |
| `native`     | nothing              | most public pages; always available           |
| `firecrawl`  | `FIRECRAWL_API_KEY`  | pages that need JavaScript rendered           |
| `brightdata` | `BRIGHTDATA_API_KEY` | pages behind anti-bot measures                |

The chain is tried in order until one returns content, and the strategy that
worked is remembered per URL prefix. **A missing or rejected paid key costs
coverage on protected sites, never the fetch itself** — `native` is in the chain
in both optimisation modes, which is the delta that matters most against upstream.

## Environment

None of it is required.

- `BRIGHTDATA_API_KEY` — enables the `brightdata` strategy.
- `FIRECRAWL_API_KEY` — enables the `firecrawl` strategy.
- `STRAD_FETCH_OPTIMIZE_FOR` — `cost` (default: native first) or `speed`
  (the paid strategies first, native last).
- `STRAD_FETCH_CACHE_MAX_ENTRIES` — resource cache entry cap. Default 512.
- `STRAD_FETCH_CACHE_MAX_BYTES` — resource cache byte cap. Default 64MB.
- `STRAD_FETCH_STRATEGY_CONFIG_PATH` — where the learned strategy table lives.
  Defaults to a file under the OS temp directory, per container.

The image is credential-free. strad injects the API keys, when it has them, onto
the bundle component through the staging/prod config.

## Tests

```
npm test        # builds, then runs the strategy, storage and tool suites
```

CI runs the same thing in the `strad_fetch` job, and the bundle's smoke test
asserts the mount lists exactly one tool.
