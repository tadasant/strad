import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { createMCPServer, type IScrapingClients } from '../src/server.js';
import { ResourceStorageFactory } from '../src/storage/index.js';
import type { IStrategyConfigClient } from '../src/strategy-config/index.js';

/**
 * The mount, driven the way the bundle host drives it: create the factory once,
 * register its handlers onto a fresh `Server` per request, and read what the
 * handlers return.
 *
 * The MCP SDK's `Server` does not expose its handler table, so these tests
 * register against a stand-in that records what was registered. That is the same
 * surface `registerHandlers` writes to, and it keeps the test free of a
 * transport.
 */
type Handler = (request: unknown) => Promise<unknown>;

class RecordingServer {
  handlers = new Map<string, Handler>();
  setRequestHandler(schema: { shape: { method: { value: string } } }, handler: Handler): void {
    this.handlers.set(schema.shape.method.value, handler);
  }
  async call(method: string, params: unknown = {}): Promise<any> {
    const handler = this.handlers.get(method);
    if (!handler) throw new Error(`no handler for ${method}`);
    return handler({ method, params });
  }
}

const stubClients = (body: string): IScrapingClients => ({
  native: {
    async scrape() {
      return { success: true, status: 200, data: body };
    },
  },
});

const stubConfig = (): IStrategyConfigClient => ({
  async loadConfig() {
    return [];
  },
  async saveConfig() {},
  async upsertEntry() {},
  async getStrategyForUrl() {
    return null;
  },
});

async function register(clients?: IScrapingClients): Promise<RecordingServer> {
  const { registerHandlers } = createMCPServer({ version: '9.9.9' });
  const recorder = new RecordingServer();
  await registerHandlers(
    recorder as unknown as Server,
    clients ? () => clients : undefined,
    stubConfig
  );
  return recorder;
}

describe('createMCPServer', () => {
  it('identifies itself as strad-fetch, not as the upstream it forks', () => {
    const { server } = createMCPServer({ version: '1.2.3' });
    // The SDK keeps the implementation info it was constructed with private, so
    // read it the way a client would see it after a handshake.
    expect((server as unknown as { _serverInfo: { name: string } })._serverInfo.name).toBe(
      'strad-fetch'
    );
  });

  /**
   * THE 5370 PROPERTY. Upstream's stdio entrypoint probed BrightData and
   * Firecrawl at boot and exited 1 on a rejected key, which killed the agent
   * session hosting it. Nothing in this tree can do that: there is no entrypoint
   * and no health check, so building the server with a garbage credential in the
   * environment must simply succeed.
   */
  it('builds and registers with a REJECTED credential in the environment', async () => {
    process.env.BRIGHTDATA_API_KEY = 'definitely-not-a-valid-key';
    try {
      const recorder = await register();
      expect(recorder.handlers.has('tools/list')).toBe(true);
    } finally {
      delete process.env.BRIGHTDATA_API_KEY;
    }
  });

  it('builds and registers with NO credentials at all', async () => {
    const recorder = await register();
    expect(recorder.handlers.has('tools/list')).toBe(true);
  });

  it('registers exactly the four handlers the gateway proxies', async () => {
    const recorder = await register();
    expect([...recorder.handlers.keys()].sort()).toEqual([
      'resources/list',
      'resources/read',
      'tools/call',
      'tools/list',
    ]);
    // Named through the SDK's own schemas, so a renamed method fails here.
    for (const schema of [
      ListToolsRequestSchema,
      CallToolRequestSchema,
      ListResourcesRequestSchema,
      ReadResourceRequestSchema,
    ]) {
      expect(recorder.handlers.has(schema.shape.method.value)).toBe(true);
    }
  });
});

describe('tools/list', () => {
  it('serves exactly one tool, named scrape', async () => {
    const recorder = await register();
    const listed = await recorder.call('tools/list');
    expect(listed.tools.map((t: { name: string }) => t.name)).toEqual(['scrape']);
  });

  /**
   * FORK DELTA — the surface is a CONSTANT. Upstream adds an `extract` parameter
   * when LLM_PROVIDER/LLM_API_KEY are set, so the same image advertises two
   * different tools depending on its environment; strad dropped the feature, and
   * this is the assertion that keeps a re-vendor from bringing it back.
   */
  it('advertises the same schema whether or not LLM credentials are present', async () => {
    const before = (await (await register()).call('tools/list')).tools[0].inputSchema;

    process.env.LLM_PROVIDER = 'anthropic';
    process.env.LLM_API_KEY = 'sk-whatever';
    try {
      const after = (await (await register()).call('tools/list')).tools[0].inputSchema;
      expect(after).toEqual(before);
      expect(Object.keys(after.properties)).not.toContain('extract');
    } finally {
      delete process.env.LLM_PROVIDER;
      delete process.env.LLM_API_KEY;
    }
  });

  it('requires only a url', async () => {
    const schema = (await (await register()).call('tools/list')).tools[0].inputSchema;
    expect(schema.required).toEqual(['url']);
    expect(Object.keys(schema.properties).sort()).toEqual([
      'cleanScrape',
      'forceRescrape',
      'maxChars',
      'resultHandling',
      'startIndex',
      'timeout',
      'url',
    ]);
  });
});

describe('tools/call scrape', () => {
  beforeEach(() => {
    ResourceStorageFactory.reset();
  });
  afterEach(() => {
    ResourceStorageFactory.reset();
  });

  it('rejects an unknown tool by name', async () => {
    const recorder = await register();
    await expect(recorder.call('tools/call', { name: 'nope', arguments: {} })).rejects.toThrow(
      'Unknown tool: nope'
    );
  });

  it('returns text for returnOnly, and says which strategy served it', async () => {
    const recorder = await register(stubClients('hello world'));
    const result = await recorder.call('tools/call', {
      name: 'scrape',
      arguments: {
        url: 'https://example.com/a',
        resultHandling: 'returnOnly',
        cleanScrape: false,
      },
    });

    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toContain('hello world');
    expect(result.content[0].text).toContain('Scraped using: native');
  });

  it('returns an embedded resource for saveAndReturn (the default)', async () => {
    const recorder = await register(stubClients('body text'));
    const result = await recorder.call('tools/call', {
      name: 'scrape',
      arguments: { url: 'https://example.com/a', cleanScrape: false },
    });

    expect(result.content[0].type).toBe('resource');
    expect(result.content[0].resource.text).toBe('body text');
    expect(result.content[0].resource.uri).toContain('memory://');
  });

  it('returns a bare link for saveOnly, and the resource is then readable', async () => {
    const recorder = await register(stubClients('link me'));
    const result = await recorder.call('tools/call', {
      name: 'scrape',
      arguments: { url: 'https://example.com/a', resultHandling: 'saveOnly', cleanScrape: false },
    });

    expect(result.content[0].type).toBe('resource_link');
    const read = await recorder.call('resources/read', { uri: result.content[0].uri });
    expect(read.contents[0].text).toBe('link me');
  });

  it('serves a second call to the same URL from cache', async () => {
    const recorder = await register(stubClients('cached body'));
    await recorder.call('tools/call', {
      name: 'scrape',
      arguments: { url: 'https://example.com/a', cleanScrape: false },
    });
    const second = await recorder.call('tools/call', {
      name: 'scrape',
      arguments: { url: 'https://example.com/a', resultHandling: 'returnOnly', cleanScrape: false },
    });

    expect(second.content[0].text).toContain('Served from cache');
  });

  it('rescrapes when told to', async () => {
    const recorder = await register(stubClients('fresh body'));
    await recorder.call('tools/call', {
      name: 'scrape',
      arguments: { url: 'https://example.com/a', cleanScrape: false },
    });
    const second = await recorder.call('tools/call', {
      name: 'scrape',
      arguments: {
        url: 'https://example.com/a',
        resultHandling: 'returnOnly',
        cleanScrape: false,
        forceRescrape: true,
      },
    });

    expect(second.content[0].text).not.toContain('Served from cache');
  });

  it('accepts a bare hostname and an invalid URL differently', async () => {
    const recorder = await register(stubClients('ok'));
    const good = await recorder.call('tools/call', {
      name: 'scrape',
      arguments: { url: ' example.com/a ', resultHandling: 'returnOnly', cleanScrape: false },
    });
    expect(good.isError).toBeUndefined();

    const bad = await recorder.call('tools/call', {
      name: 'scrape',
      arguments: { url: 'https://', resultHandling: 'returnOnly' },
    });
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toContain('Invalid arguments');
  });

  it('converts HTML to Markdown when cleaning is on', async () => {
    const recorder = await register(
      stubClients('<html><body><article><h1>Title</h1><p>Body.</p></article></body></html>')
    );
    const result = await recorder.call('tools/call', {
      name: 'scrape',
      arguments: { url: 'https://example.com/a', resultHandling: 'returnOnly' },
    });

    expect(result.content[0].text).toContain('Title');
    expect(result.content[0].text).not.toContain('<h1>');
  });

  it('reports a failed scrape as an error with per-strategy diagnostics', async () => {
    const recorder = await register({
      native: {
        async scrape() {
          return { success: false, status: 403, error: 'HTTP 403: Forbidden' };
        },
      },
    });
    const result = await recorder.call('tools/call', {
      name: 'scrape',
      arguments: { url: 'https://example.com/a' },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Strategies attempted: native');
    expect(result.content[0].text).toContain('403');
  });

  it('paginates with startIndex and maxChars', async () => {
    const recorder = await register(stubClients('abcdefghij'));
    const result = await recorder.call('tools/call', {
      name: 'scrape',
      arguments: {
        url: 'https://example.com/a',
        resultHandling: 'returnOnly',
        cleanScrape: false,
        startIndex: 2,
        maxChars: 3,
      },
    });

    expect(result.content[0].text).toContain('cde');
    expect(result.content[0].text).toContain('[Content truncated at 3 characters');
  });
});

describe('resources/list', () => {
  beforeEach(() => ResourceStorageFactory.reset());
  afterEach(() => ResourceStorageFactory.reset());

  it('is empty before anything is scraped', async () => {
    const recorder = await register();
    expect((await recorder.call('resources/list')).resources).toEqual([]);
  });

  it('lists what a scrape saved', async () => {
    const recorder = await register(stubClients('saved'));
    await recorder.call('tools/call', {
      name: 'scrape',
      arguments: { url: 'https://example.com/a', cleanScrape: false },
    });

    const listed = await recorder.call('resources/list');
    expect(listed.resources).toHaveLength(1);
    expect(listed.resources[0].uri).toContain('memory://raw/');
  });

  it('refuses a URI it does not hold', async () => {
    const recorder = await register();
    await expect(recorder.call('resources/read', { uri: 'memory://raw/nope' })).rejects.toThrow(
      'Resource not found'
    );
  });
});
