// MCP-App (io.modelcontextprotocol/ui) gating tests for the Good Eggs server.
//
// These run against the TypeScript sources (../src) under vitest — no browser, no
// real Good Eggs login. They pin the one property that matters: the App surface
// (ui:// resource, tool `_meta`, structured result) appears ONLY when the client
// advertised the extension, and a plain client's bytes are unchanged.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  createRegisterTools,
  clientSupportsApps,
  serializeForScript,
  renderSearchAppHtml,
  SEARCH_APP_URI,
  SEARCH_APP_MIME,
  MCP_APPS_EXTENSION,
} from '../src/index.js';

// A Server stand-in that just records the handlers registered against it, keyed
// by the (identity-stable) request schema, so a test can invoke them directly.
class FakeServer {
  constructor() {
    this.handlers = new Map();
  }
  setRequestHandler(schema, handler) {
    this.handlers.set(schema, handler);
  }
  has(schema) {
    return this.handlers.has(schema);
  }
  call(schema, request) {
    const handler = this.handlers.get(schema);
    if (!handler) throw new Error('no handler for schema');
    return handler(request);
  }
}

// A fixture product set with the full richness the text summary flattens away.
const PRODUCTS = [
  {
    url: 'https://www.goodeggs.com/sfbay/organic-apples/123',
    name: 'Organic Fuji Apples',
    brand: 'Sunrise Orchards',
    price: '$4.99',
    imageUrl: 'https://images.goodeggs.com/apples.jpg',
    discount: '10% off',
    isFavorite: true,
  },
  {
    url: 'https://www.goodeggs.com/sfbay/whole-milk/456',
    name: 'Whole Milk, 1 gal',
    brand: 'Straus',
    price: '$7.49',
    isFavorite: false,
  },
];

function fakeFactory() {
  return {
    initialize: async () => {},
    searchGroceries: async () => PRODUCTS,
  };
}

function register(appUi) {
  const server = new FakeServer();
  createRegisterTools(fakeFactory, undefined, { appUi })(server);
  return server;
}

const listReq = { params: {} };
const searchReq = { params: { name: 'search_for_grocery', arguments: { query: 'apples' } } };

test('clientSupportsApps: only capabilities.extensions with the exact key opts in', () => {
  assert.equal(clientSupportsApps({ extensions: { [MCP_APPS_EXTENSION]: {} } }), true);
  assert.equal(clientSupportsApps(undefined), false);
  assert.equal(clientSupportsApps({}), false);
  assert.equal(clientSupportsApps({ extensions: {} }), false);
  assert.equal(clientSupportsApps({ extensions: { 'some.other/ext': {} } }), false);
  // experimental is deliberately NOT treated as opt-in.
  assert.equal(clientSupportsApps({ experimental: { [MCP_APPS_EXTENSION]: {} } }), false);
});

test('serializeForScript neutralizes a </script> breakout', () => {
  const out = serializeForScript({ x: '</script><script>alert(1)</script>' });
  assert.equal(out.includes('<'), false, 'no raw < survives');
  assert.equal(out.includes('</script>'), false, 'no raw closing tag survives');
  assert.equal(out.includes('\\u003c'), true, 'angle brackets are unicode-escaped');
  // Still valid JSON that round-trips to the original value.
  assert.deepEqual(JSON.parse(out), { x: '</script><script>alert(1)</script>' });
});

test('APP client: ui:// resource is offered and reads back the HTML', async () => {
  const server = register(true);

  assert.equal(server.has(ListResourcesRequestSchema), true);
  assert.equal(server.has(ReadResourceRequestSchema), true);

  const list = await server.call(ListResourcesRequestSchema, listReq);
  assert.equal(list.resources.length, 1);
  assert.equal(list.resources[0].uri, SEARCH_APP_URI);
  assert.equal(list.resources[0].mimeType, SEARCH_APP_MIME);

  const read = await server.call(ReadResourceRequestSchema, {
    params: { uri: SEARCH_APP_URI },
  });
  assert.equal(read.contents[0].uri, SEARCH_APP_URI);
  assert.equal(read.contents[0].mimeType, SEARCH_APP_MIME);
  assert.equal(read.contents[0].text, renderSearchAppHtml());

  await assert.rejects(
    () => server.call(ReadResourceRequestSchema, { params: { uri: 'ui://good-eggs/nope' } }),
    /Unknown resource/
  );
});

test('APP client: search tool carries the _meta binding and structured result', async () => {
  const server = register(true);

  const tools = (await server.call(ListToolsRequestSchema, listReq)).tools;
  const search = tools.find((t) => t.name === 'search_for_grocery');
  assert.ok(search, 'search tool present');
  assert.equal(search._meta.ui.resourceUri, SEARCH_APP_URI);
  assert.equal(search._meta['ui/resourceUri'], SEARCH_APP_URI);

  const result = await server.call(CallToolRequestSchema, searchReq);
  assert.equal(result.structuredContent.query, 'apples');
  assert.deepEqual(result.structuredContent.products, PRODUCTS);
  assert.match(result.content[0].text, /^Found 2 groceries/);
});

test('PLAIN client: no resource, no _meta, no structuredContent (default and explicit false)', async () => {
  for (const server of [register(false), register(undefined)]) {
    assert.equal(server.has(ListResourcesRequestSchema), false, 'no resources handler');
    assert.equal(server.has(ReadResourceRequestSchema), false, 'no read handler');

    const tools = (await server.call(ListToolsRequestSchema, listReq)).tools;
    const search = tools.find((t) => t.name === 'search_for_grocery');
    assert.equal(search._meta, undefined, 'no _meta on a plain listing');

    const result = await server.call(CallToolRequestSchema, searchReq);
    assert.equal(result.structuredContent, undefined, 'no structured result for a plain client');
  }
});

test('the plain-text content block is byte-identical with and without the App surface', async () => {
  const appResult = await register(true).call(CallToolRequestSchema, searchReq);
  const plainResult = await register(false).call(CallToolRequestSchema, searchReq);
  assert.equal(appResult.content[0].text, plainResult.content[0].text);
});
