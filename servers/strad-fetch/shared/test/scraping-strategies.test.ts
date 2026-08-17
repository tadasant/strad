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
      clients({ native: { ok: true, body: '<html>hi</html>' }, brightData: { ok: true }, calls }),
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
