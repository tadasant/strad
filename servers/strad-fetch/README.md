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

The chain is tried in order until one returns content something can be read out
of, and the strategy that worked is remembered per URL prefix. **A missing or
rejected paid key costs coverage on protected sites, never the fetch itself** —
`native` is in the chain in both optimisation modes, which is the delta that
matters most against upstream.

**The native strategy fetches the public internet only.** `url` is a free-form
string and `native` is a bare `fetch` from a container that hosts twenty-one
mounts, so the strategy checks the scheme (`http`/`https` only) and refuses
loopback, link-local, RFC1918, carrier-grade NAT, multicast and reserved
addresses — as literals, as the IPv6 forms carrying an IPv4 address, and as
resolved addresses, on the resolution that decides the socket. Redirects are
checked at every hop. A refusal is reported as that strategy's failure. See
`FORK.md` #11.

**A strategy has to be able to READ the page, not just fetch it.** A page that
draws its content client-side answers 200 with a full document that extracts to
nothing, so it is treated as unread: the chain escalates to a strategy that
renders JavaScript, the strategy that read nothing is never remembered for the
prefix, and if none of them can read it the result says the content is UNKNOWN
rather than returning an empty body under a success footer. `cleanScrape: false`
still returns the raw bytes. See `FORK.md` #10.

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
- `STRAD_FETCH_ALLOW_PRIVATE_HOSTS` — comma-separated hosts the native strategy
  may reach despite the address check. Empty by default; it is the local-
  development escape hatch, not an off switch.

The image is credential-free. strad injects the API keys, when it has them, onto
the bundle component through the staging/prod config.

## Tests

```
npm test        # builds, then runs the strategy, storage, tool and URL-guard suites
```

CI runs the same thing in the `servers (strad-fetch)` job, and the bundle's smoke test
asserts the mount lists exactly one tool.
