# strad-fetch — what this fork changes, and why

Forked from **`@pulsemcp/pulse-fetch` 0.3.3**, whose source is
`productionized/pulse-fetch` in `pulsemcp/mcp-servers` at **`b1f13fe`** — the
commit this tree was last verified identical to, not a commit that touched the
server.

Only the upstream `shared/` package is here. Upstream also ships a `local/`
stdio entrypoint; the first delta below is that it is not vendored.

strad ran this server as `npx -y @pulsemcp/pulse-fetch@latest` inside every agent
session before this fork. That is the deployment these deltas are about: one
process per session, per-session memory, and a credential handed to every session
that starts. Behind strad it is one long-lived mount in a container shared with
twenty other servers, reached through the gateway with a strad token. Most of
what follows is that difference.

## 1. No stdio entrypoint, and no boot-time credential probe

**Upstream.** `local/src/index.ts` calls `runHealthChecks()` before connecting the
transport. That function POSTs to `api.brightdata.com/request` and
`api.firecrawl.dev/v1/scrape` with whatever keys are set, treats a `401` as a
failure, and the entrypoint then prints the failures and calls `process.exit(1)`.

**Here.** Neither the entrypoint nor `healthcheck.ts` is vendored. The bundle host
imports `createMCPServer()` and registers its handlers per request; there is no
code path that probes a credential before serving, and none that can exit the
process.

**Why.** On 2026-08-16 the deployment's BrightData key was invalid. The health
check failed, the subprocess exited 1, and its MCP client treated the failed
handshake as fatal — which killed Zimmer session 5370 and about two hours of
research it was holding. The session had never called the server. A rejected
credential now surfaces where it belongs: in the result of a tool call that needed
it.

(That an optional stdio server can kill a session that never used it is a defect
in the harness, not in this server, and is tracked separately as
`tadasant/zimmer#521`. This fork removes strad's exposure to it; it does not fix
it.)

## 2. `speed` demotes the native strategy instead of skipping it

**Upstream.** `scrapeUniversal` reads `OPTIMIZE_FOR`. In `cost` (the default) it
tries native → firecrawl → brightdata. In `speed` it tries **firecrawl →
brightdata only** — native is not in the chain at all.

**Here.** `speed` is `firecrawl → brightdata → native`. Same intent — pay the
unblockers first, because the sites you reach for them with will refuse a bare
`fetch` — without making them a dependency.

**Why.** strad's configuration was `OPTIMIZE_FOR=speed`, `FIRECRAWL_API_KEY=""`
and an invalid `BRIGHTDATA_API_KEY`. Upstream's speed chain therefore had no
strategy that could succeed, so **every** scrape failed, including plain public
pages a bare `fetch` returns in full. A paid key should buy coverage on protected
sites; it should not be the thing standing between the tool and `example.com`.

## 3. A rejected credential no longer aborts the strategies after it

**Upstream.** When firecrawl or brightdata reports an error whose text looks like
an auth failure, `scrapeUniversal` returns that failure immediately —
`isAuthError: true` — without running the remaining strategies.

**Here.** An auth failure is recorded in `diagnostics.strategyErrors` like any
other failure, the chain continues, and the names of the strategies whose
credentials were rejected are reported **only if nothing worked** — appended to
the error as `Credentials REJECTED by: …`, so "the key is bad" stays
distinguishable from "the site did not answer". `isAuthError` survives as a field
on the final result rather than as a reason to stop.

**Why.** Same incident. One bad key defeating strategies that would have worked is
the failure mode this server exists to avoid, and the diagnosis is worth more
attached to a successful fetch's absence than to an aborted one.

## 4. No LLM extraction

**Upstream.** `extract/` adds an `extract` parameter to the `scrape` tool: a
natural-language query, answered by Anthropic or OpenAI, over the fetched page.
The parameter — and the tool's advertised input schema — **appear only when
`LLM_PROVIDER` and `LLM_API_KEY` are set**.

**Here.** `extract/` is not vendored, the `extracted` resource type is gone, and
`scrape`'s input schema is a constant.

**Why**, three reasons that point the same way:

- `LLM_PROVIDER`, `LLM_API_KEY`, `LLM_MODEL` and `LLM_API_BASE_URL` are names no
  server should claim on a container shared by twenty others.
- A tool whose schema depends on its container's environment advertises one
  surface in CI and another in production. strad's pre-deploy tool-policy gate
  reads the surface out of the built image; a surface that varies is a gate that
  cannot mean much.
- Every caller of this mount is an agent — an LLM with the page in front of it.
  Paying a second model to summarise what the first one is about to read is a
  cost with no matching benefit here.

It also drops `@anthropic-ai/sdk` and `openai` from the tree.

## 5. Generic environment names are namespaced

The bundle is one container, so a bare name is a claim on every other mount. The
tuning variables moved under `STRAD_FETCH_`; the two credentials did not, because
`BRIGHTDATA_API_KEY` and `FIRECRAWL_API_KEY` name one vendor each and nothing else
in the image reads them — the same reasoning that leaves `SLACK_BOT_TOKEN` and
`SERPAPI_API_KEY` bare.

| upstream                        | here                                |
| ------------------------------- | ----------------------------------- |
| `OPTIMIZE_FOR`                  | `STRAD_FETCH_OPTIMIZE_FOR`          |
| `STRATEGY_CONFIG_PATH`          | `STRAD_FETCH_STRATEGY_CONFIG_PATH`  |
| `DEBUG`                         | `STRAD_FETCH_DEBUG`                 |
| `MCP_RESOURCE_STORAGE`          | removed (see 6)                     |
| `MCP_RESOURCE_FILESYSTEM_ROOT`  | removed (see 6)                     |
| `LLM_*`                         | removed (see 4)                     |
| `BRIGHTDATA_API_KEY`            | unchanged                           |
| `FIRECRAWL_API_KEY`             | unchanged                           |

## 6. The resource cache is bounded, and memory-only

**Upstream.** `MCP_RESOURCE_STORAGE` chooses between an in-memory `Map` and a
directory on disk. The memory store grows for the life of the process and evicts
nothing.

**Here.** Memory only, with an LRU bound on both entry count (512) and total bytes
(64MB), overridable through `STRAD_FETCH_CACHE_MAX_ENTRIES` and
`STRAD_FETCH_CACHE_MAX_BYTES`. A read counts as a use, so a page under active
reading is not evicted by a burst of one-off scrapes.

**Why.** Unbounded is correct for a subprocess the OS reclaims when a session
ends. In a long-lived container it is the one failure the bundle cannot degrade
around — an OOM kill takes all twenty-one mounts with it. The filesystem backend
went with it because App Platform gives this container no persistent volume, so it
was memory with extra steps and a slower way to fail.

## 7. A cache hit returns what the call would have produced

**Upstream.** One scrape writes TWO resources — the raw bytes and, when cleaning
succeeded, the Markdown — and `writeMulti` stamps both with the same timestamp.
The cache lookup then takes the newest entry for the URL, which is a tie that a
stable sort breaks by insertion order: raw is written first, so raw always wins.

**Here.** The lookup filters by the resource KIND the caller's `cleanScrape` flag
implies, so a default (cleaning) call matches the cleaned entry and a
`cleanScrape: false` call matches the raw one. A kind that is not cached is a miss,
and the scrape runs.

**Why.** Otherwise the first call to a URL returns Markdown and the second returns
raw HTML with a `text/html` mime type — same tool, same arguments, a different
answer, and no error anywhere. Upstream reaches this through
`findByUrlAndExtract(url, undefined)`, whose filter ("entries with no extraction
prompt") excludes nothing when nothing writes extracted entries; dropping the
extraction feature (delta 4) made that visible rather than causing it.

## 8. `strad-fetch`, not `pulse-fetch`

The MCP server name is `strad-fetch`, the slug and mount path are `/strad-fetch`,
and the native fetcher's `User-Agent` is
`Mozilla/5.0 (compatible; strad-fetch/1.0; +https://strad.tadasant.com)` — a site
operator who rate-limits this traffic should be able to tell whose it is. The tool
is still called `scrape`.

## 9. Dead code that could not have run

Four modules had no importer, and one of them could not have compiled: `validation.ts`
imports `zod-to-json-schema`, which is not a dependency of the package. Removed
along with `responses.ts`, `errors.ts`, `scraping-client/scraping-client.ts` and
the root `types.ts` (whose `ToolResponse` existed for `responses.ts`).

`strategy-config/default-config.ts` also lost a branch that read a packaged
`scraping-strategies.md` three directories above the built module. No layout this
package ships has ever contained that file, so every deployment took the
hard-coded fallback; the fallback is now the only path, written out plainly.

## 10. A strategy is accepted on what could be READ out of it

**Upstream.** `scrapeUniversal` accepts a strategy on `success && data` — bytes
came back. The cleaner runs afterwards, in the tool, entirely outside the chain.

**Here.** Each candidate is cleaned *before* it is accepted
(`shared/src/clean/extraction.ts`), and an extraction under **8 characters** of
HTML is that strategy's failure, recorded in `diagnostics.strategyErrors` like
any other. The chain escalates, the strategy that read nothing is never written
back as the learned strategy for the prefix, and if no strategy can read the
page the result says the content is **UNKNOWN** — never an empty body under a
`Scraped using: …` footer. The extraction travels back on the result, so the
tool renders the clean the chain already computed rather than doing it twice.

**Why.** `strad-fetch__scrape` against `https://sfbay.craigslist.org/search/apa`
returned, in its entirety:

```

---
Scraped using: native
```

Craigslist draws its result rows client-side, so native fetched a full document
and the cleaner correctly found nothing in the undrawn markup — and that empty
extraction was reported as a successful scrape. Two harms, and the second is why
it stuck: a caller cannot tell "this page has no content" from "this deployment
could not read this page", and the empty result was cached as the learned
strategy for the prefix, so every later request for it read nothing too
(tadasant/strad#205). It is the same conflation as delta 5 of
`servers/good-eggs/FORK.md` — *an unreadable basket is "unknown", never
"empty"* — and the remedy is the same: a result may only claim what was measured.

**The floor is 8 characters, measured against this cleaner, and it is
deliberately near the bottom.** The reported failure extracts to exactly zero;
the shortest page measured that carries a sentence (`<p>Not found.</p>`) extracts
to ten. A false escalation spends a paid credential *and* turns a short-but-real
page into "unknown", which is this same over-claiming pointed the other way.

**It applies only to what `detectContentType` calls HTML**, because only a lossy
clean can turn a fetched page into nothing — JSON, XML and plain text come back
byte-identical from a pass-through cleaner, and holding `{"ok":true}` to a
character floor would escalate it to a strategy that returns the same eleven
bytes. That made the detector load-bearing in a way it had not been: it knew
`<?xml` and `<rss` and sent everything else with a `<` in it to the HTML
cleaner, so an SVG image and an Atom feed shipped without a declaration were
cleaned as HTML, extracted to nothing, and would have been reported UNKNOWN. It
now recognises `<feed`, `<svg`, `<urlset` and `<sitemapindex` as roots too —
which also stops those being answered with empty Markdown on a default call.

**The check cleans at most 256KB to reach a verdict.** The cleaner's cost tracks
the content it EXTRACTS rather than the size of the document: a 906KB
client-rendered shell cleans in 833ms because there is nothing in it, while
846KB of prose takes 5.8s and 2MB takes 42s. A size ceiling would therefore have
exempted exactly the shells this check is for and left the expensive case
unbounded; capping the INPUT holds it to about a second at any document size. A
partial clean is a verdict only — its text is not handed back, because a prefix
rendered as the whole page is worse than the raw bytes, so a document over the
cap is cleaned again by the tool exactly as it was before this delta.

**Two things it deliberately does not do.** It does not read the caller's
`cleanScrape` flag: that is a *display* option, and letting it reach the chain
would mean a `cleanScrape: false` call and a `cleanScrape: true` call learning
different strategies for the same prefix. And it does not gate the raw path — a
`cleanScrape: false` call for a page nothing could read still gets the bytes that
were fetched, under a note saying they could not be extracted from. That is the
documented debugging escape hatch, and it was the workaround for this defect.

## Re-vendoring

`npm test` in this tree is what stops a re-vendor from silently reverting any of
the above: the strategy-chain deltas (2, 3, 10), the fixed tool schema (4), the
cache bounds (6), the cache-hit kind (7) and the server name (8) each have an
assertion that fails if upstream's behaviour comes back. Read this file first, re-apply, run the suite.
