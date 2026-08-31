import { beforeEach, describe, expect, it } from 'vitest';
import {
  extractUrlPattern,
  scrapeUniversal,
  scrapeWithStrategy,
} from '../src/scraping-strategies.js';
import type { IScrapingClients } from '../src/server.js';
import type { IStrategyConfigClient, StrategyConfigEntry } from '../src/strategy-config/index.js';

/**
 * The strategy chain is where the incident that motivated this fork lives.
 *
 * `OPTIMIZE_FOR=speed` + an invalid BrightData key + an empty Firecrawl key was
 * the production configuration, and upstream's chain turns that into "cannot
 * fetch anything at all": speed omits native, and an auth failure returns before
 * the remaining strategies run. Both are pinned here, in the shape a re-vendor
 * would break.
 */

/**
 * A page whose content is drawn client-side: a full document, a server-rendered
 * `ld+json` payload, and result rows that only exist once JavaScript runs. This
 * is the shape of https://sfbay.craigslist.org/search/apa in tadasant/strad#205,
 * and it extracts to zero characters.
 */
const CLIENT_RENDERED = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<title>SF bay area apartments / housing for rent - craigslist</title></head>
<body class="search"><div id="page-container"><div class="cl-search-page"></div></div>
<script type="application/ld+json" id="ld_searchpage_results">{"@context":"https://schema.org","itemListElement":[{"item":{"name":"Garden Areas, Washer/Dryers","@type":"Apartment"},"position":"0","@type":"ListItem"}]}</script></body></html>`;

/** What a JS-rendering strategy returns for the same URL. */
const RENDERED = `<html><body><article><h1>Apartments for rent</h1>
<p>Garden Areas, Washer/Dryers, Renovated Interiors — Santa Clara, 1br.</p></article></body></html>`;

/** A client set built from what each strategy should do. `undefined` = not configured. */
function clients(opts: {
  native?: { ok: boolean; status?: number; error?: string; body?: string };
  firecrawl?: { ok: boolean; error?: string; html?: string };
  brightData?: { ok: boolean; error?: string; body?: string };
  calls?: string[];
}): IScrapingClients {
  const log = opts.calls ?? [];
  const set: IScrapingClients = {
    native: {
      async scrape() {
        log.push('native');
        const n = opts.native;
        if (!n) return { success: false, error: 'native not stubbed' };
        return { success: n.ok, status: n.status ?? (n.ok ? 200 : 500), data: n.body, error: n.error };
      },
    },
  };

  if (opts.firecrawl) {
    set.firecrawl = {
      async scrape() {
        log.push('firecrawl');
        const f = opts.firecrawl!;
        return f.ok
          ? {
              success: true,
              data: { content: f.html ?? '', markdown: '', html: f.html ?? '', metadata: {} },
            }
          : { success: false, error: f.error };
      },
    };
  }

  if (opts.brightData) {
    set.brightData = {
      async scrape() {
        log.push('brightdata');
        const b = opts.brightData!;
        return b.ok ? { success: true, data: b.body ?? '' } : { success: false, error: b.error };
      },
    };
  }

  return set;
}

/** An in-memory strategy config, so nothing here touches the filesystem. */
function configClient(seed: StrategyConfigEntry[] = []): IStrategyConfigClient & {
  entries: StrategyConfigEntry[];
} {
  const entries = [...seed];
  return {
    entries,
    async loadConfig() {
      return entries;
    },
    async saveConfig(next) {
      entries.splice(0, entries.length, ...next);
    },
    async upsertEntry(entry) {
      const i = entries.findIndex((e) => e.prefix === entry.prefix);
      if (i >= 0) entries[i] = entry;
      else entries.push(entry);
    },
    async getStrategyForUrl(url) {
      const host = new URL(url).hostname;
      return entries.find((e) => host === e.prefix)?.default_strategy ?? null;
    },
  };
}

describe('scrapeUniversal', () => {
  beforeEach(() => {
    delete process.env.STRAD_FETCH_OPTIMIZE_FOR;
  });

  it('cost mode (the default) tries native first and stops there when it works', async () => {
    const calls: string[] = [];
    const result = await scrapeUniversal(
      clients({
        native: { ok: true, body: '<html><body><p>Hello from the page.</p></body></html>' },
        brightData: { ok: true },
        calls,
      }),
      { url: 'https://example.com/a' }
    );

    expect(result.success).toBe(true);
    expect(result.source).toBe('native');
    expect(calls).toEqual(['native']);
  });

  it('speed mode tries the paid strategies FIRST', async () => {
    process.env.STRAD_FETCH_OPTIMIZE_FOR = 'speed';
    const calls: string[] = [];
    const result = await scrapeUniversal(
      clients({
        native: { ok: true, body: 'native body' },
        firecrawl: { ok: true, html: 'firecrawl body' },
        brightData: { ok: true },
        calls,
      }),
      { url: 'https://example.com/a' }
    );

    expect(result.source).toBe('firecrawl');
    expect(calls).toEqual(['firecrawl']);
  });

  /** FORK DELTA 1. Upstream omits native in speed mode; this returns the page. */
  it('speed mode still falls back to native when no paid strategy is configured', async () => {
    process.env.STRAD_FETCH_OPTIMIZE_FOR = 'speed';
    const calls: string[] = [];
    const result = await scrapeUniversal(
      clients({ native: { ok: true, body: '<html>public page</html>' }, calls }),
      { url: 'https://example.com/a' }
    );

    expect(result.success).toBe(true);
    expect(result.source).toBe('native');
    expect(result.content).toBe('<html>public page</html>');
    expect(calls).toEqual(['native']);
  });

  /** FORK DELTA 1 + 2 together: the exact production configuration of the incident. */
  it('speed mode with a REJECTED BrightData key and no Firecrawl key still fetches', async () => {
    process.env.STRAD_FETCH_OPTIMIZE_FOR = 'speed';
    const calls: string[] = [];
    const result = await scrapeUniversal(
      clients({
        native: { ok: true, body: '<html>public page</html>' },
        brightData: { ok: false, error: 'Unauthorized: invalid token' },
        calls,
      }),
      { url: 'https://example.com/a' }
    );

    expect(result.success).toBe(true);
    expect(result.source).toBe('native');
    expect(calls).toEqual(['brightdata', 'native']);
  });

  /** FORK DELTA 2. Upstream returns at firecrawl's auth error and never tries brightdata. */
  it("an auth failure does not abort the strategies after it", async () => {
    const calls: string[] = [];
    const result = await scrapeUniversal(
      clients({
        native: { ok: false, status: 403, error: 'HTTP 403: Forbidden' },
        firecrawl: { ok: false, error: 'Unauthorized' },
        brightData: { ok: true, body: '<html>unblocked</html>' },
        calls,
      }),
      { url: 'https://example.com/a' }
    );

    expect(result.success).toBe(true);
    expect(result.source).toBe('brightdata');
    expect(calls).toEqual(['native', 'firecrawl', 'brightdata']);
  });

  it('names the rejected credentials when everything failed', async () => {
    const result = await scrapeUniversal(
      clients({
        native: { ok: false, status: 403, error: 'HTTP 403: Forbidden' },
        firecrawl: { ok: false, error: 'Unauthorized' },
        brightData: { ok: false, error: 'token expired' },
      }),
      { url: 'https://example.com/a' }
    );

    expect(result.success).toBe(false);
    expect(result.isAuthError).toBe(true);
    expect(result.error).toContain('Credentials REJECTED by: brightdata, firecrawl');
    // …and it still reports what the site itself said, which is a different fix.
    expect(result.diagnostics?.strategyErrors.native).toContain('403');
  });

  it('does not call a credential rejected by the site an auth failure', async () => {
    const result = await scrapeUniversal(
      clients({
        native: { ok: false, status: 500, error: 'HTTP 500: Internal Server Error' },
        brightData: { ok: false, error: 'target site returned 500' },
      }),
      { url: 'https://example.com/a' }
    );

    expect(result.success).toBe(false);
    expect(result.isAuthError).toBe(false);
    expect(result.error).not.toContain('REJECTED');
  });

  /**
   * FORK.md #10, and the defect in tadasant/strad#205. Native fetches the page
   * fine and there is nothing in it to extract, which is the canonical signal
   * for a client-rendered page — exactly what the paid strategies exist for.
   */
  it('escalates to the next strategy when a page fetches but extracts to nothing', async () => {
    const calls: string[] = [];
    const result = await scrapeUniversal(
      clients({
        native: { ok: true, body: CLIENT_RENDERED },
        brightData: { ok: true, body: RENDERED },
        calls,
      }),
      { url: 'https://sfbay.craigslist.org/search/apa' }
    );

    expect(result.success).toBe(true);
    expect(result.source).toBe('brightdata');
    expect(result.content).toBe(RENDERED);
    expect(calls).toEqual(['native', 'brightdata']);
    // Native's failure is a diagnostic, not a silence.
    expect(result.diagnostics?.strategyErrors.native).toContain('extracted 0 characters');
  });

  it('escalates past every strategy that cannot read the page', async () => {
    const calls: string[] = [];
    const result = await scrapeUniversal(
      clients({
        native: { ok: true, body: CLIENT_RENDERED },
        firecrawl: { ok: true, html: CLIENT_RENDERED },
        brightData: { ok: true, body: RENDERED },
        calls,
      }),
      { url: 'https://sfbay.craigslist.org/search/apa' }
    );

    expect(result.source).toBe('brightdata');
    expect(calls).toEqual(['native', 'firecrawl', 'brightdata']);
  });

  /** The "unknown, never empty" half. An empty body under a success footer is the bug. */
  it('reports UNKNOWN, not empty, when nothing can read the page', async () => {
    const result = await scrapeUniversal(
      clients({
        native: { ok: true, body: CLIENT_RENDERED },
        brightData: { ok: true, body: CLIENT_RENDERED },
      }),
      { url: 'https://sfbay.craigslist.org/search/apa' }
    );

    expect(result.success).toBe(false);
    expect(result.content).toBeNull();
    expect(result.source).toBe('none');
    expect(result.error).toContain('UNKNOWN, not empty');
    // Per-strategy diagnostics, so the caller can see it was FETCHED.
    expect(result.diagnostics?.strategiesAttempted).toEqual(['native', 'brightdata']);
    expect(result.diagnostics?.strategyErrors.native).toContain('extracted 0 characters');
    expect(result.diagnostics?.strategyErrors.brightdata).toContain('extracted 0 characters');
    // …and the bytes survive, for the caller who asked for raw ones.
    expect(result.fetched).toEqual({ source: 'native', content: CLIENT_RENDERED });
  });

  it('keeps "nothing could fetch it" distinct from "nothing could read it"', async () => {
    const result = await scrapeUniversal(
      clients({ native: { ok: false, status: 403, error: 'HTTP 403: Forbidden' } }),
      { url: 'https://example.com/a' }
    );

    expect(result.success).toBe(false);
    expect(result.fetched).toBeUndefined();
    expect(result.error).toContain('All strategies failed');
    expect(result.error).not.toContain('UNKNOWN');
  });

  /** The other direction: a short page is short, and must not cost a paid call. */
  it('does not escalate a page that is genuinely short but readable', async () => {
    const calls: string[] = [];
    const result = await scrapeUniversal(
      clients({
        native: { ok: true, body: '<html><body><p>Not found.</p></body></html>' },
        firecrawl: { ok: true, html: RENDERED },
        brightData: { ok: true, body: RENDERED },
        calls,
      }),
      { url: 'https://example.com/a' }
    );

    expect(result.success).toBe(true);
    expect(result.source).toBe('native');
    expect(calls).toEqual(['native']);
  });

  /** The path that already worked, pinned so this change cannot cost it. */
  it('still escalates on a native HTTP error', async () => {
    const calls: string[] = [];
    const result = await scrapeUniversal(
      clients({
        native: { ok: false, status: 403, error: 'HTTP 403: Forbidden' },
        brightData: { ok: true, body: RENDERED },
        calls,
      }),
      { url: 'https://sfbay.craigslist.org/search/apa' }
    );

    expect(result.source).toBe('brightdata');
    expect(calls).toEqual(['native', 'brightdata']);
    expect(result.diagnostics?.strategyErrors.native).toContain('403');
  });

  /**
   * An empty body is the one case where "empty" is the honest word: there are
   * no bytes to offer a caller and nothing to call unknown.
   */
  it('calls an empty body a failure, not an unknown', async () => {
    const result = await scrapeUniversal(clients({ native: { ok: true, body: '   ' } }), {
      url: 'https://example.com/a',
    });

    expect(result.success).toBe(false);
    expect(result.fetched).toBeUndefined();
    expect(result.error).toContain('All strategies failed');
    expect(result.error).not.toContain('UNKNOWN');
    expect(result.diagnostics?.strategyErrors.native).toBe('fetched an empty body');
  });

  it('reports the bytes of the FIRST unreadable strategy in chain order', async () => {
    process.env.STRAD_FETCH_OPTIMIZE_FOR = 'speed';
    const brightDataShell = `<html><head><title>b</title></head><body><div id="app"></div></body></html>`;

    const result = await scrapeUniversal(
      clients({
        native: { ok: true, body: CLIENT_RENDERED },
        brightData: { ok: true, body: brightDataShell },
      }),
      { url: 'https://sfbay.craigslist.org/search/apa' }
    );

    // speed puts brightdata first, so its bytes are the ones a caller would
    // have been handed before this check existed.
    expect(result.fetched).toEqual({ source: 'brightdata', content: brightDataShell });
  });

  it('reports every strategy it attempted, in order', async () => {
    const result = await scrapeUniversal(
      clients({
        native: { ok: false, status: 403, error: 'HTTP 403' },
        brightData: { ok: false, error: 'nope' },
      }),
      { url: 'https://example.com/a' }
    );

    expect(result.diagnostics?.strategiesAttempted).toEqual(['native', 'brightdata']);
  });
});

describe('scrapeWithStrategy', () => {
  beforeEach(() => {
    delete process.env.STRAD_FETCH_OPTIMIZE_FOR;
  });

  it('uses the strategy learned for a prefix before anything else', async () => {
    const calls: string[] = [];
    const result = await scrapeWithStrategy(
      clients({
        native: { ok: true, body: 'native' },
        brightData: { ok: true, body: 'brightdata' },
        calls,
      }),
      configClient([{ prefix: 'blocked.example', default_strategy: 'brightdata' }]),
      { url: 'https://blocked.example/thing' }
    );

    expect(result.source).toBe('brightdata');
    expect(calls).toEqual(['brightdata']);
  });

  it('records the strategy that worked, so the next call starts there', async () => {
    const config = configClient();
    await scrapeWithStrategy(
      clients({
        native: { ok: false, status: 403, error: 'HTTP 403' },
        brightData: { ok: true, body: 'unblocked' },
      }),
      config,
      { url: 'https://blocked.example/a/b' }
    );

    expect(config.entries).toEqual([
      {
        prefix: 'blocked.example/a/',
        default_strategy: 'brightdata',
        notes: 'Auto-discovered via universal fallback',
      },
    ]);
  });

  it('falls through to the whole chain when the learned strategy fails', async () => {
    const calls: string[] = [];
    const result = await scrapeWithStrategy(
      clients({
        native: { ok: true, body: 'native' },
        brightData: { ok: false, error: 'token expired' },
        calls,
      }),
      configClient([{ prefix: 'blocked.example', default_strategy: 'brightdata' }]),
      { url: 'https://blocked.example/thing' }
    );

    // brightdata once as the learned strategy, then the cost chain, which native
    // satisfies on its first step — so brightdata is not asked a second time.
    expect(result.success).toBe(true);
    expect(result.source).toBe('native');
    expect(calls).toEqual(['brightdata', 'native']);
  });

  /**
   * The sticky half of tadasant/strad#205. A strategy that read nothing must not
   * become the learned strategy for the prefix, or one unreadable answer becomes
   * every later answer for it.
   */
  it('does not learn a strategy that produced nothing extractable', async () => {
    const config = configClient();
    const result = await scrapeWithStrategy(
      clients({ native: { ok: true, body: CLIENT_RENDERED } }),
      config,
      { url: 'https://sfbay.craigslist.org/search/apa' }
    );

    expect(result.success).toBe(false);
    expect(config.entries).toEqual([]);
  });

  it('learns the strategy that COULD read the page, not the one that fetched it', async () => {
    const config = configClient();
    await scrapeWithStrategy(
      clients({
        native: { ok: true, body: CLIENT_RENDERED },
        brightData: { ok: true, body: RENDERED },
      }),
      config,
      { url: 'https://sfbay.craigslist.org/search/apa' }
    );

    expect(config.entries).toEqual([
      {
        prefix: 'sfbay.craigslist.org/search/',
        default_strategy: 'brightdata',
        notes: 'Auto-discovered via universal fallback',
      },
    ]);
  });

  it('falls through when a learned strategy stops being able to read the page', async () => {
    const calls: string[] = [];
    const result = await scrapeWithStrategy(
      clients({
        native: { ok: true, body: CLIENT_RENDERED },
        brightData: { ok: true, body: RENDERED },
        calls,
      }),
      configClient([{ prefix: 'sfbay.craigslist.org', default_strategy: 'native' }]),
      { url: 'https://sfbay.craigslist.org/search/apa' }
    );

    // native as the learned strategy, then the whole cost chain behind it.
    expect(result.success).toBe(true);
    expect(result.source).toBe('brightdata');
    expect(calls).toEqual(['native', 'native', 'brightdata']);
  });

  /**
   * The prefix in tadasant/strad#205 already HAS an entry naming `native`, and
   * the table is on disk, so it outlives the process. Leaving a learned entry
   * that has stopped working in place would make every later request re-run it,
   * fail, and fall through the whole chain again — for good.
   */
  it('corrects a learned strategy that has stopped being able to read the page', async () => {
    const config = configClient([
      { prefix: 'sfbay.craigslist.org', default_strategy: 'native' },
    ]);

    await scrapeWithStrategy(
      clients({
        native: { ok: true, body: CLIENT_RENDERED },
        brightData: { ok: true, body: RENDERED },
      }),
      config,
      { url: 'https://sfbay.craigslist.org/search/apa' }
    );

    expect(config.entries).toContainEqual({
      prefix: 'sfbay.craigslist.org/search/',
      default_strategy: 'brightdata',
      notes: 'Auto-discovered after native stopped working',
    });
  });

  it('does not rewrite a learned strategy that is still the one that worked', async () => {
    const config = configClient([{ prefix: 'example.com', default_strategy: 'native' }]);

    await scrapeWithStrategy(
      clients({ native: { ok: true, body: '<html><body><p>Still fine here.</p></body></html>' } }),
      config,
      { url: 'https://example.com/a/b' }
    );

    expect(config.entries).toEqual([{ prefix: 'example.com', default_strategy: 'native' }]);
  });

  it('survives a strategy config it cannot read', async () => {
    const broken: IStrategyConfigClient = {
      async loadConfig() {
        throw new Error('disk gone');
      },
      async saveConfig() {
        throw new Error('disk gone');
      },
      async upsertEntry() {
        throw new Error('disk gone');
      },
      async getStrategyForUrl() {
        throw new Error('disk gone');
      },
    };

    const result = await scrapeWithStrategy(clients({ native: { ok: true, body: 'ok' } }), broken, {
      url: 'https://example.com/a',
    });

    expect(result.success).toBe(true);
  });
});

describe('extractUrlPattern', () => {
  it.each([
    ['https://example.com', 'example.com'],
    ['https://example.com/', 'example.com'],
    ['https://example.com/one', 'example.com'],
    ['https://example.com/blog/2024/article', 'example.com/blog/2024/'],
    ['https://example.com:8443/a/b', 'example.com:8443/a/'],
    ['not a url', 'not a url'],
  ])('%s -> %s', (url, pattern) => {
    expect(extractUrlPattern(url)).toBe(pattern);
  });
});
