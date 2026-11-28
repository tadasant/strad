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

The chain runs in order until one returns content that can actually be read, and
the strategy that worked is remembered per URL prefix, in a table under the
container's temp directory. A subsequent request to that prefix starts with the
strategy that worked last time and falls through the rest if it does not.

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

## A strategy has to be able to READ the page, not just fetch it

"The response had a body" and "the page had content" are different questions, and
the chain answers the first while reporting the second unless something makes it
look. A page that draws its content client-side answers 200 with a full document
whose rendered markup is empty — so the bytes are there, the clean finds nothing,
and the fetch looks like a success against a page with nothing on it.

So a strategy is accepted on **what can be extracted from what it fetched**. The
page is cleaned before the strategy is accepted; if the extraction comes back with
under 8 characters of readable content, that is treated as *this strategy could
not read this page* and the chain escalates to one that renders JavaScript, which
is what firecrawl and brightdata are in the chain for.

Three consequences, and they are the point:

- **A strategy that read nothing is never learned for the prefix.** Otherwise one
  unreadable answer becomes every later answer for every URL under it.
- **When nothing can read the page, the result says the content is UNKNOWN**, with
  the per-strategy diagnostics — how many bytes each one fetched and how much came
  out. It is never an empty body under a `Scraped using: native` footer, because
  that states an absence nothing observed.
- **`cleanScrape: false` still returns the raw bytes**, with a note that nothing
  could be extracted from them. It is the way to look at what was actually served,
  and it is exactly the tool for this situation.

The floor is 8 characters and applies only to content the cleaner is **lossy**
over — that is, HTML. It is low on purpose: a false escalation spends a paid
credential *and* turns a genuinely short page into "unknown", which is the same
over-claiming in the other direction. JSON, XML and plain text are exempt; they
come back byte-identical from the cleaner, so holding `{"ok":true}` to a character
floor would escalate it to a strategy that returns the same eleven bytes.

Reaching a verdict costs at most one clean of the first 256KB. The cleaner's cost
tracks the content it *extracts*, not the size of the document — a 906KB
client-rendered shell cleans in under a second because there is nothing in it,
while 2MB of prose takes forty — so capping the input bounds the expensive case
without exempting the shells the check is for. A page over the cap is judged on
its prefix and cleaned in full by the tool afterwards, exactly as it was before.

The check runs whatever `cleanScrape` says, because `cleanScrape` chooses what is
*displayed* and must not change which strategy is chosen or remembered — otherwise
two callers asking for the same page in different formats teach the deployment
different things about it.

:::caution[It is a length floor, and that is its limit]
"Was the page read" is decided by counting characters, which is a proxy for "is
there anything here". A client-rendered page whose shell renders a nav bar or a
cookie banner extracts to a few dozen characters of exactly that, clears the
floor, and is served as the page's content. The case that was reported extracted
to zero, which is the easy one. See
[limitation #74](/limitations/#74-strad-fetch-decides-a-page-was-read-by-counting-characters).
:::

## The native strategy fetches the public internet only

`url` is a free-form string and `native` is a bare `fetch` from the bundle
container — the container that hosts forty mounts, not the agent's own
sandbox. Without a guard, an entitled caller could point `scrape` at
`http://127.0.0.1:<port>`, at `http://169.254.169.254/…`, or at whatever the
private component network answers, and read the response back as tool output.

So the native strategy checks three things:

- **The scheme.** `http` and `https`. `file:`, `data:`, `ftp:` and the rest are
  refused before anything is dispatched.
- **The address.** Loopback, link-local, RFC1918, carrier-grade NAT, multicast and
  reserved space, as IPv4 and IPv6 literals — including the IPv6 spellings that
  carry an IPv4 address, `::ffff:127.0.0.1` and `2002:7f00:1::` among them — and
  as **resolved** addresses, so a name that points into one of those ranges is
  refused too.
- **The name.** A single-label host, and the special-use suffixes (`.internal`,
  `.local`, `.localdomain`, `.home.arpa`, `.alt`, `.localhost`). This is the rule
  that covers strad's own private network rather than the range check: a bundle
  is reached at `${bundle.PRIVATE_URL}`, which is `http://bundle-name:8080`, so
  every component is one bare label. Public DNS serves no single-label name, so
  refusing them costs no legitimate fetch.
- **Every connection the fetch opens**, not just the URL the caller passed. The
  resolved-address check runs on the resolution that decides the socket, so there
  is no second lookup to race, and a **redirect** into a private address is
  refused at the hop: a public page that 302s to `http://127.0.0.1:8080/` opens a
  new connection through the same guarded dispatcher.

A refusal is the native strategy's failure, in the shape every other failure has
— `Refusing to fetch …: 169.254.169.254 is a link-local address (169.254.0.0/16)
— the cloud metadata range` — so it reaches the caller rather than a log, and the
paid strategies are still tried behind it.

`STRAD_FETCH_ALLOW_PRIVATE_HOSTS` is the escape hatch: a comma-separated list of
**bare hosts** — no port; an entry exempts every port on that host — that may be
reached anyway, empty by default. It is for pointing a development gateway at a
service on the same box, and it is a list rather than an off switch on purpose.

:::caution[It is a denylist, not an allowlist]
The guard refuses what is known to be private rather than permitting what is
known to be public, so a private service behind an ordinary dotted name that
resolves outside every listed range is still reachable, and each new form of
private addressing is a rule somebody has to remember to add. It also covers
`native` only — the paid strategies fetch from a third party's network rather
than from this container. See
[limitation #79](/limitations/#79-strad-fetchs-url-guard-is-a-denylist-so-it-refuses-what-is-known-to-be-private).
:::

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
| `STRAD_FETCH_ALLOW_PRIVATE_HOSTS`  | empty   | Bare hosts (no port) the native strategy may reach anyway. |

The two credential names are bare because each names one vendor and nothing else in
the bundle image reads them — the same reasoning that leaves `SLACK_BOT_TOKEN`
bare. Everything else is namespaced, because the bundle is one container and a
generic name there is a claim on twenty other mounts.

## The cache, and what it is shared with

A scraped page is cached in the process, so a repeated fetch of a URL is free. The
cache is **LRU-bounded** on entry count and total bytes — upstream's is unbounded,
which is correct for a subprocess the OS reclaims and an out-of-memory risk in a
container hosting forty mounts.

It is also **one cache for every caller of the slug**, which is a limitation rather
than a feature: see [limitation #65](/limitations/#65-strad-fetchs-scraped-page-cache-is-shared-by-every-caller-of-the-slug).
