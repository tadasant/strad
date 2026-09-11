// What `search_for_freebie_groceries` is allowed to CLAIM (FORK.md #10).
//
// The sweep reads two pages — the homepage and /fresh-picks. Its upstream empty
// answer, "No free items or deals currently available.", was read as "no
// freebies this week" while two $0.00 samples were live and orderable
// (strad#191). The rule these encode: the description and every result name the
// two pages, and an empty one says it is not a statement about the store. The
// last test pins the other half — that the sweep visits those two pages and no
// others — so the strings cannot drift from what the client actually checks.
//
// Runs against the TypeScript sources under vitest — no browser, no login.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createRegisterTools, GoodEggsClient, setSharedBrowserProvider } from '../src/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { renderPage } from './fixtures/page.mjs';

const TOOL = 'search_for_freebie_groceries';
const PAGES = /the Good Eggs homepage and \/fresh-picks/;
const BASE_URL = 'https://www.goodeggs.com';

class FakeServer {
  constructor() {
    this.handlers = new Map();
  }
  setRequestHandler(schema, handler) {
    this.handlers.set(schema, handler);
  }
  async list() {
    return this.handlers.get(ListToolsRequestSchema)({ params: {} });
  }
  async call(name, args = {}) {
    return this.handlers.get(CallToolRequestSchema)({
      params: { name, arguments: args },
    });
  }
}

function toolServer(searchFreebieGroceries) {
  const client = { initialize: async () => {}, searchFreebieGroceries };
  const server = new FakeServer();
  createRegisterTools(
    () => client,
    async () => client
  )(server);
  return server;
}

const SAMPLE = {
  url: 'https://www.goodeggs.com/sunrise-orchards/organic-fuji-apple-sample/6a638703ed408b01b5745294',
  name: 'Organic Fuji Apple Sample',
  brand: 'Sunrise Orchards',
  price: '$0.00',
  discount: 'FREE',
};

// ---------------------------------------------------------------------------
// What the tool says
// ---------------------------------------------------------------------------

test('the description names the two pages and says an empty result is not "none available"', async () => {
  const { tools } = await toolServer(async () => []).list();
  const description = tools.find((t) => t.name === TOOL).description;

  assert.match(description, PAGES);
  assert.match(description, /does NOT search the catalog/);
  assert.match(description, /not "no free items available"/);
  // The route to the freebies it cannot see.
  assert.match(description, /\$0\.00 item\s+in a search_for_grocery result as a freebie/);
  // The promise it replaces.
  assert.doesNotMatch(description, /^Search for free items \(\$0\.00\) on Good Eggs\./);
  // A client cuts descriptions at 2048 characters (HACKS.md #82).
  assert.ok(description.length <= 2048, `description is ${description.length} characters`);
});

test('an empty sweep says what this check found on the two pages, and that it does not mean no freebies', async () => {
  const result = await toolServer(async () => []).call(TOOL);
  const text = result.content[0].text;

  assert.notEqual(result.isError, true);
  // The sentence an agent read as "no freebies this week".
  assert.doesNotMatch(text, /No free items or deals currently available/);
  assert.match(
    text,
    /^This check found no \$0\.00 items on the Good Eggs homepage and \/fresh-picks, the only two pages/
  );
  assert.match(text, /does NOT mean no free items are available/);
  assert.match(text, /search_for_grocery/);
});

test('a non-empty sweep names its pages, says others may exist, and does not call a $0.00 item a deal', async () => {
  const result = await toolServer(async () => [SAMPLE]).call(TOOL);
  const text = result.content[0].text;

  assert.notEqual(result.isError, true);
  assert.match(text, /^Found 1 \$0\.00 item on the Good Eggs homepage and \/fresh-picks:/);
  assert.match(text, /Organic Fuji Apple Sample/);
  assert.match(text, /URL: https:\/\/www\.goodeggs\.com\/sunrise-orchards\//);
  // One hit is not the whole list: the footer still points at the other route.
  assert.match(text, /other \$0\.00 items may be listed elsewhere/);
  assert.match(text, /\$0\.00 item in a search_for_grocery result as a freebie too\.$/);
  assert.doesNotMatch(text, /deals/);
});

test('a sweep of several items pluralises and renders every item', async () => {
  const result = await toolServer(async () => [
    SAMPLE,
    { ...SAMPLE, url: `${SAMPLE.url}0`, name: 'Organic Bosc Pear Sample' },
  ]).call(TOOL);
  const text = result.content[0].text;

  assert.match(text, /^Found 2 \$0\.00 items on the Good Eggs homepage and \/fresh-picks:/);
  assert.match(text, /1\. \*\*Organic Fuji Apple Sample\*\*/);
  assert.match(text, /2\. \*\*Organic Bosc Pear Sample\*\*/);
  assert.match(text, /other \$0\.00 items may be listed elsewhere/);
});

test('a failed sweep is an error that names the pages and says the answer is unknown, not none', async () => {
  const result = await toolServer(async () => {
    throw new Error('page.goto: Timeout 30000ms exceeded');
  }).call(TOOL);
  const text = result.content[0].text;

  assert.equal(result.isError, true);
  assert.match(
    text,
    /^Error checking the Good Eggs homepage and \/fresh-picks for \$0\.00 items: page\.goto: Timeout/
  );
  assert.match(text, /UNKNOWN\. Do not read this as there being none\./);
});

// ---------------------------------------------------------------------------
// What the sweep checks
// ---------------------------------------------------------------------------

/**
 * A Playwright `Page` stand-in for a login followed by the sweep. The in-page
 * DOM scrape runs in a browser, so `evaluate()` answers for it with whatever
 * `scrapedAt` holds for the page the fake is on.
 */
class FakePage {
  constructor(scrapedAt = {}) {
    this.scrapedAt = scrapedAt;
    this.currentUrl = 'about:blank';
    this.visited = [];
  }
  async goto(url) {
    this.visited.push(url);
    this.currentUrl = url;
  }
  async waitForTimeout() {}
  async fill() {}
  async click() {}
  async waitForURL() {
    this.currentUrl = `${BASE_URL}/home?recently-logged-in=true`;
  }
  url() {
    return this.currentUrl;
  }
  isClosed() {
    return false;
  }
  async content() {
    return renderPage({
      basket: { items: [], totals: { subtotal: 0 } },
      products: {},
      user: { id: '5f00000000000000000000aa', email: 'someone@example.com' },
    });
  }
  async evaluate() {
    return this.scrapedAt[this.currentUrl] ?? [];
  }
}

async function sweep(page) {
  const browser = {
    newContext: async () => ({ newPage: async () => page, close: async () => {} }),
  };
  setSharedBrowserProvider(async () => browser);
  try {
    const client = new GoodEggsClient({
      username: 'someone@example.com',
      password: 'hunter2',
      headless: true,
      timeout: 30000,
    });
    await client.initialize();
    page.visited = [];
    return await client.searchFreebieGroceries();
  } finally {
    setSharedBrowserProvider(null);
  }
}

test('the sweep visits the homepage and /fresh-picks, and nothing else', async () => {
  // Every string above names these two pages. If the sweep gains a third, this
  // fails, and the strings get widened with it rather than left understating it.
  const page = new FakePage();

  assert.deepEqual(await sweep(page), []);
  assert.deepEqual(page.visited, [BASE_URL, `${BASE_URL}/fresh-picks`]);
});

test('the sweep returns what both pages found, once each', async () => {
  const PEAR = { ...SAMPLE, url: `${SAMPLE.url}0`, name: 'Organic Bosc Pear Sample' };
  const page = new FakePage({
    [BASE_URL]: [SAMPLE],
    [`${BASE_URL}/fresh-picks`]: [SAMPLE, PEAR],
  });

  assert.deepEqual(await sweep(page), [SAMPLE, PEAR]);
});
