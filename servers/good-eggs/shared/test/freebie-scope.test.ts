// What `search_for_freebie_groceries` is allowed to CLAIM (FORK.md #10).
//
// The sweep reads two pages — the homepage and /fresh-picks. Its upstream empty
// answer, "No free items or deals currently available.", was read as "no
// freebies this week" while two $0.00 samples were live elsewhere on the site
// (strad#191). The rule these encode: every result names the two pages, and an
// empty one says it is not a statement about the store.
//
// Runs against the TypeScript sources under vitest — no browser, no login.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createRegisterTools } from '../src/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const TOOL = 'search_for_freebie_groceries';
const PAGES = /the Good Eggs homepage and \/fresh-picks/;

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

test('the description names the two pages and says an empty result is not "none available"', async () => {
  const { tools } = await toolServer(async () => []).list();
  const description = tools.find((t) => t.name === TOOL).description;

  assert.match(description, PAGES);
  assert.match(description, /does NOT search the catalog/);
  assert.match(description, /not "no free items available"/);
  // The route to the freebies it cannot see.
  assert.match(description, /\$0\.00 item in a\s+search_for_grocery result as a freebie/);
  // The promise it replaces.
  assert.doesNotMatch(description, /^Search for free items \(\$0\.00\) on Good Eggs\./);
  // A client cuts descriptions at 2048 characters (HACKS.md #82).
  assert.ok(description.length <= 2048, `description is ${description.length} characters`);
});

test('an empty sweep names the two pages and says it does not mean no freebies', async () => {
  const result = await toolServer(async () => []).call(TOOL);
  const text = result.content[0].text;

  assert.notEqual(result.isError, true);
  // The sentence an agent read as "no freebies this week".
  assert.doesNotMatch(text, /No free items or deals currently available/);
  assert.match(text, /^No \$0\.00 items on the Good Eggs homepage and \/fresh-picks, the only two pages/);
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
  assert.match(text, /other \$0\.00 items may be listed elsewhere\.$/);
  assert.doesNotMatch(text, /deals/);
});

test('a sweep of several items pluralises', async () => {
  const result = await toolServer(async () => [
    SAMPLE,
    { ...SAMPLE, url: `${SAMPLE.url}0`, name: 'Organic Bosc Pear Sample' },
  ]).call(TOOL);
  assert.match(result.content[0].text, /^Found 2 \$0\.00 items on/);
});

test('a failed sweep is an error that says the answer is unknown, not none', async () => {
  const result = await toolServer(async () => {
    throw new Error('page.goto: Timeout 30000ms exceeded');
  }).call(TOOL);
  const text = result.content[0].text;

  assert.equal(result.isError, true);
  assert.match(text, /^Error searching for freebies: page\.goto: Timeout/);
  assert.match(text, /UNKNOWN\. Do not read this as there being none\./);
});
