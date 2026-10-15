// `get_grocery_nutrition` and what it is allowed to claim (FORK.md #12).
//
// Good Eggs carries no nutrition on a product. The one structured source it
// links to is Good Eggs Kitchen's help-center tables, which cover kitchen
// products only and lag the catalog. So the rule these pin is the fork's usual
// one: every answer says WHICH case it is in — found, ambiguous, not in the
// tables, not published, unknown — and none of them is an empty answer that
// looks like "this product has no nutrition".
//
// The tables are the real Zendesk response cut down to a few real rows
// (fixtures/kitchen-nutrition.mjs); the product pages are real
// `storeData.productDetails` payloads trimmed to the fields read. No network,
// no browser, no login.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  createRegisterTools,
  GoodEggsClient,
  setSharedBrowserProvider,
  groceryNutritionFromHtml,
  parseKitchenNutritionArticles,
  matchKitchenRow,
  splitRecipeName,
  productImageFromUrl,
  HttpKitchenNutritionSource,
  setKitchenNutritionSource,
  KITCHEN_NUTRITION_API_URL,
} from '../src/index.js';
import { renderPage } from './fixtures/page.mjs';
import { KITCHEN_SECTION_RESPONSE } from './fixtures/kitchen-nutrition.mjs';

const ROWS = parseKitchenNutritionArticles(KITCHEN_SECTION_RESPONSE);
const rowsSource = (rows = ROWS) => {
  const source = {
    calls: 0,
    async getRows() {
      source.calls++;
      return rows;
    },
  };
  return source;
};

const CHOWDER_URL =
  'https://www.goodeggs.com/goodeggskitchen/corn-chowder/5cccb5efa4f746000e935c13';
const OAT_MILK_URL =
  'https://www.goodeggs.com/oatlysfbay/full-fat-oat-milk/62fed3989d755d001272a084';
const CDN =
  'https://images.goodeggs.com/cdn-cgi/image/width=840,height=525,fit=crop,format=auto,quality=80/';

/** A real kitchen product page payload (Corn Chowder, captured 2026-10-15). */
function chowderDetails(overrides: Record<string, unknown> = {}) {
  return {
    product: {
      id: '5cccb5efa4f746000e935c13',
      name: 'Corn Chowder',
      url: '/goodeggskitchen/corn-chowder/5cccb5efa4f746000e935c13',
      retailUnits: '28 oz',
      productType: 'Vegetarian Soup/Stew, Fresh',
      currentProducer: { name: 'Good Eggs Kitchen', slug: 'goodeggskitchen' },
      vendor: { name: 'Good Eggs Kitchen', slug: 'goodeggskitchen' },
      ...overrides,
    },
    photoUrl: `${CDN}7ccd1030-3026-48bb-b2b9-b301beb716f6.jpg`,
    photosUrls: [
      {
        url: `${CDN}7ccd1030-3026-48bb-b2b9-b301beb716f6.jpg`,
        alt: 'This is how Corn Chowder looks, 1. image reference',
      },
      {
        url: `${CDN}3847fc3b-7c88-49a6-bfb4-f75024e36007.jpg`,
        alt: 'This is how Corn Chowder looks, 2. image reference',
      },
    ],
  };
}

/** A real producer product page payload (Oatly Full Fat Oat Milk). */
function oatMilkDetails() {
  return {
    product: {
      id: '62fed3989d755d001272a084',
      name: 'Full Fat Oat Milk',
      url: '/oatlysfbay/full-fat-oat-milk/62fed3989d755d001272a084',
      retailUnits: '64 fl oz',
      productType: 'Oat Milk',
      currentProducer: { name: 'Oatly', slug: 'oatlysfbay' },
      vendor: { name: 'Oatly', slug: 'oatlysfbay' },
    },
    photoUrl: `${CDN}27e44621-20da-4530-8505-0ea631f38369.jpg`,
    photosUrls: [
      {
        url: `${CDN}27e44621-20da-4530-8505-0ea631f38369.jpg`,
        alt: 'This is how Full Fat Oat Milk looks, 1. image reference',
      },
    ],
  };
}

const page = (productDetails: unknown) => renderPage({ user: { id: 'u1' }, productDetails });
const row = (name: string) => ROWS.find((r) => r.recipeName === name)!;

// ---------------------------------------------------------------------------
// Parsing the published tables
// ---------------------------------------------------------------------------

test('a table row parses to the values it prints, keyed by header', () => {
  const chowder = row('Corn Chowder - 28 oz');
  assert.equal(chowder.facts.servingsPerPackage, 3.5);
  assert.equal(chowder.facts.servingSize, '227 gr');
  assert.equal(chowder.facts.calories, 240);
  assert.equal(chowder.facts.totalFatG, 12);
  assert.equal(chowder.facts.totalCarbohydrateG, 30);
  assert.equal(chowder.facts.proteinG, 8);
  assert.equal(chowder.articleTitle, 'Good Eggs Kitchen Soups & Broths');
  assert.match(chowder.articleUrl, /^https:\/\/help\.goodeggs\.com\/hc\/en-us\/articles\//);
  assert.equal(chowder.articleUpdatedAt, '2026-07-15T04:09:16Z');
});

test('a value that is not a plain number is kept as printed, not coerced', () => {
  // "less than 1" is not 0, and not 1 either.
  assert.equal(row('Pork Broth - 14 oz').facts.totalSugarsG, 'less than 1');
});

test('columns are mapped by header text: a table with no servings column does not shift', () => {
  // The real "Nutritional Facts - Grains, Beans, and Pasta" article has 17
  // columns. Positional parsing would read its calories (140) as serving size.
  const short = ROWS.filter(
    (r) => r.articleTitle === 'Good Eggs Kitchen Nutritional Facts - Grains, Beans, and Pasta',
  );
  assert.ok(short.length > 0);
  for (const r of short) {
    assert.equal(r.facts.servingsPerPackage, null);
    assert.equal(r.facts.servingSize, '1 Portions');
    assert.equal(r.facts.calories, 140);
    assert.equal(r.facts.totalFatG, 13);
  }
});

test('HTML entities in a recipe name are decoded', () => {
  assert.ok(ROWS.some((r) => r.recipeName === 'Baked Pasta with Pork & Beef Ragu - 20 oz'));
});

test('a response with no articles, or no rows, is an error rather than an empty table', () => {
  assert.throws(() => parseKitchenNutritionArticles({}), /no articles array/);
  assert.throws(() => parseKitchenNutritionArticles(null), /no articles array/);
  assert.throws(
    () => parseKitchenNutritionArticles({ articles: [{ title: 'x', body: '<p>moved</p>' }] }),
    /zero nutrition rows/,
  );
});

test('a recipe name splits into a name and a size label, in every spelling the tables use', () => {
  assert.deepEqual(splitRecipeName('Black Beans - 10 oz'), { base: 'Black Beans', size: '10 oz' });
  assert.deepEqual(splitRecipeName('Grana Padano- 2 oz'), { base: 'Grana Padano', size: '2 oz' });
  assert.deepEqual(splitRecipeName('Chicken Tenders-16oz'), {
    base: 'Chicken Tenders',
    size: '16oz',
  });
  assert.deepEqual(splitRecipeName('Miso Roasted Salmon - (2 each)'), {
    base: 'Miso Roasted Salmon',
    size: '(2 each)',
  });
  assert.deepEqual(splitRecipeName('Chicken Kale Caesar Salad'), {
    base: 'Chicken Kale Caesar Salad',
  });
  // A hyphen inside a word is part of the name.
  assert.deepEqual(splitRecipeName('Sun-Dried Tomato Pesto - 6 oz'), {
    base: 'Sun-Dried Tomato Pesto',
    size: '6 oz',
  });
});

// ---------------------------------------------------------------------------
// Matching a product to a row
// ---------------------------------------------------------------------------

test('a product matches its row on the whole name, and the size is checked', () => {
  const m = matchKitchenRow('Corn Chowder', '28 oz', ROWS);
  assert.equal(m.kind, 'found');
  assert.equal(m.kind === 'found' && m.row.recipeName, 'Corn Chowder - 28 oz');
  assert.equal(m.kind === 'found' && m.sizeMatches, true);
});

test('"&" and "and", case and punctuation fold; a substring never matches', () => {
  assert.equal(matchKitchenRow('Baked Pasta with Pork and Beef Ragu', '20 oz', ROWS).kind, 'found');
  assert.equal(matchKitchenRow('BLACK BEANS', '10 oz', ROWS).kind, 'found');
  // "Corn" is in "Corn Chowder"; it is not Corn Chowder.
  assert.equal(matchKitchenRow('Corn', '28 oz', ROWS).kind, 'no_row');
  assert.equal(matchKitchenRow('Corn Chowder with Bacon', '28 oz', ROWS).kind, 'no_row');
});

test('a parenthetical such as "(Frozen)" is dropped and tried once more', () => {
  const rows = parseKitchenNutritionArticles({
    articles: [
      {
        title: 'Good Eggs Kitchen Soups & Broths',
        html_url: 'https://help.goodeggs.com/hc/en-us/articles/1',
        body:
          '<table><tr><td>Recipe name</td><td>Calories</td></tr>' +
          '<tr><td>Brown Butter Squash Soup - 30 oz</td><td>210</td></tr></table>',
      },
    ],
  });
  const m = matchKitchenRow('Brown Butter Squash Soup (Frozen)', '30 oz', rows);
  assert.equal(m.kind, 'found');
});

test('one name with several sizes is told apart by the retail units', () => {
  const m = matchKitchenRow('Pork Broth', '14 oz', ROWS);
  assert.equal(m.kind, 'found');
  assert.equal(m.kind === 'found' && m.row.recipeName, 'Pork Broth - 14 oz');
  assert.equal(m.kind === 'found' && m.row.facts.calories, 20);
});

test('several sizes and units that single none out is ambiguous, with every candidate', () => {
  const m = matchKitchenRow('Pork Broth', '1 lb', ROWS);
  assert.equal(m.kind, 'ambiguous');
  assert.deepEqual(m.kind === 'ambiguous' && m.rows.map((r) => r.recipeName).sort(), [
    'Pork Broth - 14 oz',
    'Pork Broth - 28 oz',
  ]);
});

test('two articles disagreeing about one product is ambiguous, never one picked silently', () => {
  // Real data: "Achiote Marinade - 2 oz" is 70 kcal in one article and 140 in
  // another (where it is also repeated seven times). Identical repeats fold to
  // one; the disagreement does not.
  const m = matchKitchenRow('Achiote Marinade', '2 oz', ROWS);
  assert.equal(m.kind, 'ambiguous');
  assert.deepEqual(m.kind === 'ambiguous' && m.rows.map((r) => r.facts.calories).sort(), [140, 70]);
});

test('a lone row for a different size is found, but flagged', () => {
  const m = matchKitchenRow('Black Beans', '16 oz', ROWS);
  assert.equal(m.kind, 'found');
  assert.equal(m.kind === 'found' && m.sizeMatches, false);
});

// ---------------------------------------------------------------------------
// Image URLs
// ---------------------------------------------------------------------------

test('a page photo becomes an uncropped readable rendition and the original', () => {
  const img = productImageFromUrl(`${CDN}27e44621-20da-4530-8505-0ea631f38369.jpg`, 'alt text');
  assert.equal(
    img.url,
    'https://images.goodeggs.com/cdn-cgi/image/width=2000,fit=scale-down,format=jpeg,quality=85/27e44621-20da-4530-8505-0ea631f38369.jpg',
  );
  assert.equal(
    img.originalUrl,
    'https://images.goodeggs.com/27e44621-20da-4530-8505-0ea631f38369.jpg',
  );
  assert.equal(img.alt, 'alt text');
  // No crop survives into the rendition.
  assert.doesNotMatch(img.url, /fit=crop|height=/);
});

test('a photo URL not on the resizing CDN passes through untouched', () => {
  const img = productImageFromUrl('https://images.goodeggs.com/legacy.jpg');
  assert.equal(img.url, 'https://images.goodeggs.com/legacy.jpg');
  assert.equal(img.originalUrl, 'https://images.goodeggs.com/legacy.jpg');
});

// ---------------------------------------------------------------------------
// The answer, per case
// ---------------------------------------------------------------------------

test('a kitchen product with a row: structured facts, the source, and its photos', async () => {
  const result = await groceryNutritionFromHtml(
    page(chowderDetails()),
    CHOWDER_URL,
    rowsSource(),
    '5cccb5efa4f746000e935c13',
  );
  assert.equal(result.name, 'Corn Chowder');
  assert.equal(result.producer, 'Good Eggs Kitchen');
  assert.equal(result.retailUnits, '28 oz');
  assert.equal(result.nutrition.status, 'found');
  assert.equal(result.nutrition.sizeMatches, true);
  assert.equal(result.nutrition.facts?.calories, 240);
  assert.equal(result.nutrition.facts?.proteinG, 8);
  assert.equal(result.nutrition.matchedRow?.source.title, 'Good Eggs Kitchen Soups & Broths');
  assert.equal(result.images.length, 2);
  assert.match(result.imagesNote, /without a session/);
});

test('a producer product: not_published, the tables are never fetched, the photo URLs come back', async () => {
  const source = rowsSource();
  const result = await groceryNutritionFromHtml(page(oatMilkDetails()), OAT_MILK_URL, source);
  assert.equal(result.nutrition.status, 'not_published');
  assert.match(result.nutrition.note, /publishes no nutrition facts/);
  assert.equal(result.nutrition.facts, undefined);
  assert.equal(source.calls, 0);
  assert.equal(result.producer, 'Oatly');
  assert.equal(result.images.length, 1);
  assert.equal(
    result.images[0].originalUrl,
    'https://images.goodeggs.com/27e44621-20da-4530-8505-0ea631f38369.jpg',
  );
  // URLs only — never image bytes in the result.
  assert.doesNotMatch(JSON.stringify(result), /base64|data:image/);
});

test('a kitchen product whose tables cannot be read is UNKNOWN, and still carries its photos', async () => {
  const failing = {
    async getRows(): Promise<never> {
      throw new Error('the help center answered HTTP 403');
    },
  };
  const result = await groceryNutritionFromHtml(page(chowderDetails()), CHOWDER_URL, failing);
  assert.equal(result.nutrition.status, 'unknown');
  assert.match(result.nutrition.note, /UNKNOWN, not absent/);
  assert.match(result.nutrition.note, /HTTP 403/);
  assert.equal(result.images.length, 2);
});

test('a kitchen product with no row says so, naming how many rows were searched', async () => {
  const result = await groceryNutritionFromHtml(
    page(chowderDetails({ name: "Mary's Classic Roasted Chicken", retailUnits: '1 each' })),
    CHOWDER_URL,
    rowsSource(),
  );
  assert.equal(result.nutrition.status, 'not_in_kitchen_tables');
  assert.match(result.nutrition.note, new RegExp(`none of the ${ROWS.length} rows`));
});

test('an ambiguous kitchen product lists every candidate with its facts', async () => {
  const result = await groceryNutritionFromHtml(
    page(chowderDetails({ name: 'Pork Broth', retailUnits: '1 lb' })),
    CHOWDER_URL,
    rowsSource(),
  );
  assert.equal(result.nutrition.status, 'ambiguous');
  assert.equal(result.nutrition.candidates?.length, 2);
  assert.ok(result.nutrition.candidates?.every((c) => typeof c.facts.calories === 'number'));
  assert.equal(result.nutrition.facts, undefined);
});

test('a page with no product payload throws; it is not "no nutrition, no photos"', async () => {
  await assert.rejects(
    groceryNutritionFromHtml('<html><body>nothing here</body></html>', CHOWDER_URL, rowsSource()),
    /UNKNOWN, not absent/,
  );
  await assert.rejects(
    groceryNutritionFromHtml(renderPage({ user: null }), CHOWDER_URL, rowsSource()),
    /no product payload/,
  );
});

test('a page serving a different product than the URL asked for is refused', async () => {
  await assert.rejects(
    groceryNutritionFromHtml(
      page(oatMilkDetails()),
      CHOWDER_URL,
      rowsSource(),
      '5cccb5efa4f746000e935c13',
    ),
    /refusing to report another product/,
  );
});

// ---------------------------------------------------------------------------
// The HTTPS source
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('the source reads the public API, and reuses a good read', async () => {
  const urls: string[] = [];
  let now = 0;
  const source = new HttpKitchenNutritionSource({
    fetchImpl: (async (url: string) => {
      urls.push(url);
      return jsonResponse(KITCHEN_SECTION_RESPONSE);
    }) as unknown as typeof fetch,
    ttlMs: 1000,
    now: () => now,
  });
  assert.equal((await source.getRows()).length, ROWS.length);
  await source.getRows();
  assert.deepEqual(urls, [KITCHEN_NUTRITION_API_URL]);
  now = 1001;
  await source.getRows();
  assert.equal(urls.length, 2);
});

test('the source follows next_page', async () => {
  const [first, ...rest] = KITCHEN_SECTION_RESPONSE.articles;
  const source = new HttpKitchenNutritionSource({
    fetchImpl: (async (url: string) =>
      url === KITCHEN_NUTRITION_API_URL
        ? jsonResponse({ articles: [first], next_page: `${KITCHEN_NUTRITION_API_URL}&page=2` })
        : jsonResponse({ articles: rest, next_page: null })) as unknown as typeof fetch,
  });
  assert.equal((await source.getRows()).length, ROWS.length);
});

test('a failed read throws and is not cached, so the next call retries', async () => {
  let calls = 0;
  const source = new HttpKitchenNutritionSource({
    fetchImpl: (async () => {
      calls++;
      return calls === 1
        ? jsonResponse({ error: 'denied' }, 403)
        : jsonResponse(KITCHEN_SECTION_RESPONSE);
    }) as unknown as typeof fetch,
  });
  await assert.rejects(source.getRows(), /HTTP 403/);
  assert.equal((await source.getRows()).length, ROWS.length);
  assert.equal(calls, 2);
});

// ---------------------------------------------------------------------------
// The client and the tool
// ---------------------------------------------------------------------------

test('the client loads the product page and reads its served payload', async () => {
  const visited: string[] = [];
  let loggedIn = false;
  const fakePage = {
    current: 'about:blank',
    async goto(url: string) {
      visited.push(url);
      this.current = loggedIn ? url : 'https://www.goodeggs.com/home';
    },
    async waitForTimeout() {},
    async fill() {},
    async click() {},
    async waitForURL() {},
    url() {
      return this.current;
    },
    isClosed: () => false,
    async content() {
      return loggedIn ? page(chowderDetails()) : renderPage({ user: { id: 'u1' } });
    },
  };
  const browser = {
    newContext: async () => ({ newPage: async () => fakePage, close: async () => {} }),
  };
  setSharedBrowserProvider((async () => browser) as never);
  setKitchenNutritionSource(rowsSource());
  try {
    const client = new GoodEggsClient({
      username: 'someone@example.com',
      password: 'hunter2',
      headless: true,
      timeout: 30000,
    });
    await client.initialize();
    loggedIn = true;
    const result = await client.getGroceryNutrition(CHOWDER_URL);
    assert.equal(result.nutrition.status, 'found');
    assert.equal(visited.at(-1), CHOWDER_URL);
  } finally {
    setSharedBrowserProvider(null);
    setKitchenNutritionSource(null);
  }
});

class FakeServer {
  handlers = new Map<unknown, (req: unknown) => Promise<any>>();
  setRequestHandler(schema: unknown, handler: (req: unknown) => Promise<any>) {
    this.handlers.set(schema, handler);
  }
  async list() {
    return this.handlers.get(ListToolsRequestSchema)!({ params: {} });
  }
  async call(name: string, args: unknown = {}) {
    return this.handlers.get(CallToolRequestSchema)!({ params: { name, arguments: args } });
  }
}

function toolServer(getGroceryNutrition: (url: string) => Promise<unknown>) {
  const client = { initialize: async () => {}, getGroceryNutrition };
  const server = new FakeServer();
  createRegisterTools(
    () => client as never,
    async () => client as never,
  )(server as never);
  return server;
}

test("get_grocery_nutrition is listed, names every status, and fits a client's description cap", async () => {
  const { tools } = await toolServer(async () => ({})).list();
  const tool = tools.find((t: { name: string }) => t.name === 'get_grocery_nutrition');
  assert.ok(tool);
  for (const status of [
    'found',
    'ambiguous',
    'not_in_kitchen_tables',
    'not_published',
    'unknown',
  ]) {
    assert.match(tool.description, new RegExp(`- ${status} —`));
  }
  assert.match(tool.description, /never image bytes/);
  // A client cuts descriptions at 2048 characters (HACKS.md #82).
  assert.ok(
    tool.description.length <= 2048,
    `description is ${tool.description.length} characters`,
  );
});

test('the tool returns the answer as JSON', async () => {
  const answer = await groceryNutritionFromHtml(page(chowderDetails()), CHOWDER_URL, rowsSource());
  const result = await toolServer(async () => answer).call('get_grocery_nutrition', {
    grocery_url: CHOWDER_URL,
  });
  assert.notEqual(result.isError, true);
  assert.deepEqual(JSON.parse(result.content[0].text), answer);
});

test('a failed read is an error that says UNKNOWN, not absent', async () => {
  const result = await toolServer(async () => {
    throw new Error('page.goto: net::ERR_TIMED_OUT');
  }).call('get_grocery_nutrition', { grocery_url: CHOWDER_URL });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /UNKNOWN,\s+not absent/);
  assert.match(result.content[0].text, /ERR_TIMED_OUT/);
});

test('a URL off goodeggs.com is refused before any browsing', async () => {
  let called = false;
  const result = await toolServer(async () => {
    called = true;
    return {};
  }).call('get_grocery_nutrition', { grocery_url: 'https://example.com/x' });
  assert.equal(result.isError, true);
  assert.equal(called, false);
});

// ---------------------------------------------------------------------------
// The ways a partial or odd read could have come back as a confident answer
// ---------------------------------------------------------------------------

/** One article with a header and the given body rows, in the real table shape. */
function article(rowsHtml: string, header = ['Recipe name', 'Calories', 'Protein (g)']) {
  return {
    title: 'Good Eggs Kitchen Test',
    html_url: 'https://help.goodeggs.com/hc/en-us/articles/1',
    body:
      '<table><tbody><tr>' +
      header.map((h) => `<td><strong>${h}</strong></td>`).join('') +
      '</tr>' +
      rowsHtml +
      '</tbody></table>',
  };
}
const tr = (...cells: string[]) => `<tr>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`;

test('a name with an inner dash splits at the size, not at the first dash', () => {
  assert.deepEqual(splitRecipeName('Chicken - Lemon Herb - 16 oz'), {
    base: 'Chicken - Lemon Herb',
    size: '16 oz',
  });
  assert.deepEqual(splitRecipeName('Corn Chowder – 28 oz'), {
    base: 'Corn Chowder',
    size: '28 oz',
  });
  assert.deepEqual(splitRecipeName('Chicken Caesar Salad - Large'), {
    base: 'Chicken Caesar Salad',
    size: 'Large',
  });
  // A dash followed by something that is not a size stays in the name.
  assert.deepEqual(splitRecipeName('Chicken - Lemon Herb'), { base: 'Chicken - Lemon Herb' });
});

test('"Chicken" does not match "Chicken - Lemon Herb - 16 oz", and that product matches its own row', () => {
  const rows = parseKitchenNutritionArticles({
    articles: [article(tr('Chicken - Lemon Herb - 16 oz', '220', '30'))],
  });
  assert.equal(matchKitchenRow('Chicken', '16 oz', rows).kind, 'no_row');
  assert.equal(matchKitchenRow('Chicken - Lemon Herb', '16 oz', rows).kind, 'found');
});

test('named, decimal and hex entities decode, so an accented name still matches', () => {
  const rows = parseKitchenNutritionArticles({
    articles: [
      article(
        tr('Saut&eacute;ed Greens &ndash; 8 oz', '90', '3') +
          tr('Mac &#x26; Cheese &#8211; 12 oz', '400', '15'),
      ),
    ],
  });
  assert.deepEqual(
    rows.map((r) => r.recipeName),
    ['Sauteed Greens – 8 oz', 'Mac & Cheese – 12 oz'],
  );
  assert.equal(matchKitchenRow('Sautéed Greens', '8 oz', rows).kind, 'found');
  assert.equal(matchKitchenRow('Mac and Cheese', '12 oz', rows).kind, 'found');
});

test('only a storage qualifier is dropped: "(Vegan)" is a different product', () => {
  const rows = parseKitchenNutritionArticles({
    articles: [article(tr('Chicken Soup - 28 oz', '180', '12'))],
  });
  assert.equal(matchKitchenRow('Chicken Soup (Vegan)', '28 oz', rows).kind, 'no_row');
  assert.equal(matchKitchenRow('Chicken Soup (Frozen)', '28 oz', rows).kind, 'found');
});

test('two sizes with identical per-serving facts are still told apart by size', () => {
  const rows = parseKitchenNutritionArticles({
    articles: [article(tr('Pork Broth - 14 oz', '20', '3') + tr('Pork Broth - 28 oz', '20', '3'))],
  });
  const m = matchKitchenRow('Pork Broth', '28 oz', rows);
  assert.equal(m.kind, 'found');
  assert.equal(m.kind === 'found' && m.row.recipeName, 'Pork Broth - 28 oz');
  assert.equal(m.kind === 'found' && m.sizeMatches, true);
});

test('a row with a name and no values is a heading, not a product', () => {
  const rows = parseKitchenNutritionArticles({
    articles: [article(tr('Soups', '', '') + tr('Corn Chowder - 28 oz', '240', '8'))],
  });
  assert.deepEqual(
    rows.map((r) => r.recipeName),
    ['Corn Chowder - 28 oz'],
  );
});

test('any unreadable article makes the whole section unreadable, never a silent gap', () => {
  const good = article(tr('Corn Chowder - 28 oz', '240', '8'));
  const parse = (bad: unknown) => () => parseKitchenNutritionArticles({ articles: [good, bad] });
  assert.throws(parse({ title: 'x' }), /no body/);
  assert.throws(
    parse(article('<tr><td colspan="2">Black Beans - 10 oz</td><td>8</td></tr>')),
    /merged cells/,
  );
  assert.throws(
    parse(article(tr('Black Beans - 10 oz', '180'))),
    /row of 2 cells under a header of 3/,
  );
  // A header renamed out from under the parser.
  assert.throws(
    parse(article(tr('Black Beans - 10 oz', '180', '10'), ['Product', 'Calories', 'Protein (g)'])),
    /read no rows from/,
  );
});

test('a payload with no producer is UNKNOWN, not "Good Eggs publishes nothing"', async () => {
  const details = chowderDetails({ currentProducer: null, vendor: null });
  const source = rowsSource();
  const result = await groceryNutritionFromHtml(page(details), CHOWDER_URL, source);
  assert.equal(result.nutrition.status, 'unknown');
  assert.match(result.nutrition.note, /names no producer/);
  assert.equal(source.calls, 0);
});

test('a page with no product id is refused when the URL named one', async () => {
  await assert.rejects(
    groceryNutritionFromHtml(
      page(chowderDetails({ id: undefined })),
      CHOWDER_URL,
      rowsSource(),
      '5cccb5efa4f746000e935c13',
    ),
    /served product \(no id\)/,
  );
});

test('a resize of a remote source is passed through, not rewritten into a broken original', () => {
  const remote =
    'https://images.goodeggs.com/cdn-cgi/image/width=840/https://cdn.example.com/a.jpg';
  const img = productImageFromUrl(remote);
  assert.equal(img.url, remote);
  assert.equal(img.originalUrl, remote);
});

test('next_page off the help center section is refused before it is fetched', async () => {
  for (const next of [
    'http://169.254.169.254/latest/meta-data/',
    'https://help.goodeggs.com/api/v2/users.json',
    'https://evil.example.com/api/v2/help_center/en-us/sections/360007686892/articles.json',
  ]) {
    const urls: string[] = [];
    const source = new HttpKitchenNutritionSource({
      fetchImpl: (async (url: string) => {
        urls.push(url);
        return jsonResponse({ articles: KITCHEN_SECTION_RESPONSE.articles, next_page: next });
      }) as unknown as typeof fetch,
    });
    await assert.rejects(source.getRows(), /next_page off its own section/);
    assert.deepEqual(urls, [KITCHEN_NUTRITION_API_URL]);
  }
});

test('a section longer than the page cap throws rather than being read in part', async () => {
  let n = 0;
  const source = new HttpKitchenNutritionSource({
    fetchImpl: (async () =>
      jsonResponse({
        articles: KITCHEN_SECTION_RESPONSE.articles,
        next_page: `${KITCHEN_NUTRITION_API_URL}&page=${++n + 1}`,
      })) as unknown as typeof fetch,
  });
  await assert.rejects(source.getRows(), /runs past 5 pages/);
  assert.equal(n, 5);
});

test('concurrent calls share one read', async () => {
  let calls = 0;
  const source = new HttpKitchenNutritionSource({
    fetchImpl: (async () => {
      calls++;
      return jsonResponse(KITCHEN_SECTION_RESPONSE);
    }) as unknown as typeof fetch,
  });
  const results = await Promise.all([source.getRows(), source.getRows(), source.getRows()]);
  assert.equal(calls, 1);
  assert.ok(results.every((r) => r.length === ROWS.length));
});
