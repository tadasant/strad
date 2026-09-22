// Past orders: resolving a date to an order, and reading what was in it.
//
// FORK.md #11. `get_past_order_groceries` found an order by searching the drawn
// `/account/orders` page for the date text it was given. The list tool named
// dates off a different page ("Monday, September 21st", from `/reorder`) than
// the one searched ("Monday 9/21"), so the documented flow could not work, and
// the 2026-09-21 order read back "No items found" under five formats across two
// days while `9/13` read fine. The same list double-counted every order's items.
//
// Both now come from the payload: `storeData.populatedPastOrders` on the list,
// `storeData.order.items` on an order's page. The fixtures are trimmed from the
// live 2026-09-22 responses, with the delivery address redacted.
//
// They run against the TypeScript sources under vitest — no browser, no login.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  GoodEggsClient,
  setSharedBrowserProvider,
  pastOrdersFromStoreData,
  parseOrderDateQuery,
  findPastOrder,
  pastOrderItemsFromStoreData,
} from '../src/index.js';
import { renderPage } from './fixtures/page.mjs';

const BASE_URL = 'https://www.goodeggs.com';
const ORDERS_URL = `${BASE_URL}/account/orders`;
const SEP_21_ID = '6ab086f4262ac1d68453dfb6';
const SEP_13_ID = '6aa6d4b78be55da3124bc179';

function pastOrder(id, startAt, endAt, itemCount, stripeTotal) {
  return {
    id,
    status: 'paid',
    deliveryStatus: 'delivered',
    isEditable: false,
    deliveryDetails: { address: 'REDACTED' },
    deliveryWindow: { startAt, endAt },
    itemCount,
    totals: { stripeTotal },
  };
}

/** `/account/orders` as served on 2026-09-22, newest first. */
function ordersStoreData() {
  return {
    user: { id: '5f00000000000000000000aa' },
    foodhub: { slug: 'MAR1', tzid: 'America/Los_Angeles' },
    populatedUpcomingOrders: [],
    populatedPastOrders: [
      // A Monday 6–10am delivery: 13:00Z is 6am Pacific.
      pastOrder(SEP_21_ID, '2026-09-21T13:00:00.000Z', '2026-09-21T17:00:00.000Z', 11, 7813),
      pastOrder(SEP_13_ID, '2026-09-13T21:00:00.000Z', '2026-09-14T01:00:00.000Z', 28, 24828),
      pastOrder(
        '6aa1d0cafe3d96e5c5308fef',
        '2026-09-10T12:00:00.000Z',
        '2026-09-10T15:00:00.000Z',
        13,
        13147
      ),
      // A Friday 5–9pm delivery: its window STARTS on Saturday in UTC.
      pastOrder(
        '6a9ad50a954d968faadeb14e',
        '2026-09-05T00:00:00.000Z',
        '2026-09-05T04:00:00.000Z',
        23,
        22795
      ),
    ],
  };
}

function orderStoreData(id) {
  const items =
    id === SEP_21_ID
      ? [
          {
            id: `${id}|645a5e2d6ff0b30011be1cde`,
            quantity: 1,
            quantityDescription: '1 x 1.5 lb',
            subtotal: 599,
            product: {
              id: '645a5e2d6ff0b30011be1cde',
              photoUrl: 'https://images.goodeggs.com/potatoes.jpg',
              url: '/goodeggsproducesfbay/organic-baby-potatoes-medley/645a5e2d6ff0b30011be1cde',
              name: 'Organic Baby Potatoes Medley',
              retailUnits: '1.5 lb',
              vendor: { url: '/goodeggsproducesfbay', name: 'From Our Farmers' },
            },
          },
          {
            id: `${id}|5dbc6f848342b0000eaa8878`,
            quantity: 2,
            quantityDescription: '1 x 1 lb',
            subtotal: 2198,
            product: {
              id: '5dbc6f848342b0000eaa8878',
              url: '/beyondmeatsfbay/beyond-meat-plant-based-ground-beef/5dbc6f848342b0000eaa8878',
              name: 'Beyond Meat Plant-Based Ground Beef',
              retailUnits: '1 lb',
              vendor: { name: 'Beyond Meat' },
            },
          },
        ]
      : [
          {
            id: `${id}|68d5a66d8b9e78001285f407`,
            quantity: 1,
            subtotal: 1599,
            product: {
              id: '68d5a66d8b9e78001285f407',
              url: '/goodeggskitchen/grilled-chicken-delicata-harvest-bowl/68d5a66d8b9e78001285f407',
              name: 'Grilled Chicken Delicata Harvest Bowl',
              retailUnits: '16 oz',
              vendor: { name: 'Good Eggs Kitchen' },
            },
          },
        ];
  return { user: { id: '5f00000000000000000000aa' }, order: { id, items } };
}

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

test('the list names each order by its delivery day in Pacific time', () => {
  const orders = pastOrdersFromStoreData(ordersStoreData());
  assert.ok(orders);
  assert.deepEqual(
    orders.map((o) => [o.date, o.isoDate]),
    [
      ['Monday, September 21st', '2026-09-21'],
      ['Sunday, September 13th', '2026-09-13'],
      ['Thursday, September 10th', '2026-09-10'],
      // 2026-09-05T00:00Z is Friday evening in California, not Saturday.
      ['Friday, September 4th', '2026-09-04'],
    ]
  );
});

test('the list carries the real item count, not twice it', () => {
  // The old count summed every `a.js-product-link` under an order's header on
  // `/reorder`, and came out at exactly twice the real count: 56 for 28.
  const orders = pastOrdersFromStoreData(ordersStoreData());
  assert.deepEqual(
    orders.map((o) => o.itemCount),
    [11, 28, 13, 23]
  );
  assert.equal(orders[0].total, '$78.13');
  assert.equal(orders[0].orderId, SEP_21_ID);
  assert.equal(orders[0].deliveryStatus, 'delivered');
});

test('an unreadable list is null, never an empty one', () => {
  assert.equal(pastOrdersFromStoreData(null), null);
  assert.equal(pastOrdersFromStoreData({ user: {} }), null);
  assert.deepEqual(pastOrdersFromStoreData({ populatedPastOrders: [] }), []);
});

// ---------------------------------------------------------------------------
// Resolving a date
// ---------------------------------------------------------------------------

test('every format tried against the 2026-09-21 order resolves to it', () => {
  const orders = pastOrdersFromStoreData(ordersStoreData());
  for (const input of [
    '9/21',
    '09/21',
    '2026-09-21',
    'September 21st',
    'Monday, September 21st',
    'Monday 9/21',
    'Sep 21',
    '9/21/2026',
    'Delivered Monday, September 21st',
  ]) {
    const query = parseOrderDateQuery(input);
    assert.ok(query, `could not parse ${input}`);
    assert.equal(findPastOrder(orders, query)?.orderId, SEP_21_ID, input);
  }
});

test('a date with no order on it resolves to nothing, not to a neighbour', () => {
  const orders = pastOrdersFromStoreData(ordersStoreData());
  assert.equal(findPastOrder(orders, parseOrderDateQuery('9/22')), null);
  assert.equal(findPastOrder(orders, parseOrderDateQuery('2025-09-21')), null);
  // 9/5 is when the Friday order's window starts in UTC; it was delivered 9/4.
  assert.equal(findPastOrder(orders, parseOrderDateQuery('9/5')), null);
});

test('text with no date in it does not parse', () => {
  assert.equal(parseOrderDateQuery('last week'), null);
  assert.equal(parseOrderDateQuery('Monday'), null);
  assert.equal(parseOrderDateQuery('13/45'), null);
});

// ---------------------------------------------------------------------------
// Reading an order
// ---------------------------------------------------------------------------

test("an order's items come from its payload", () => {
  const items = pastOrderItemsFromStoreData(orderStoreData(SEP_21_ID), BASE_URL);
  assert.deepEqual(items, [
    {
      url: `${BASE_URL}/goodeggsproducesfbay/organic-baby-potatoes-medley/645a5e2d6ff0b30011be1cde`,
      name: 'Organic Baby Potatoes Medley',
      brand: 'From Our Farmers',
      price: '$5.99',
      quantity: '1.5 lb',
      quantityOrdered: 1,
      imageUrl: 'https://images.goodeggs.com/potatoes.jpg',
    },
    {
      url: `${BASE_URL}/beyondmeatsfbay/beyond-meat-plant-based-ground-beef/5dbc6f848342b0000eaa8878`,
      name: 'Beyond Meat Plant-Based Ground Beef',
      brand: 'Beyond Meat',
      price: '$21.98',
      quantity: '1 lb',
      quantityOrdered: 2,
      imageUrl: undefined,
    },
  ]);
});

test('a payload with no order items is null, so the caller falls back', () => {
  assert.equal(pastOrderItemsFromStoreData({ user: {} }, BASE_URL), null);
  assert.equal(pastOrderItemsFromStoreData(null, BASE_URL), null);
});

// ---------------------------------------------------------------------------
// Through the client
// ---------------------------------------------------------------------------

/** A Playwright `Page` stand-in that serves each URL its payload. */
class FakePage {
  constructor() {
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
    if (this.currentUrl === ORDERS_URL) return renderPage(ordersStoreData());
    const order = this.currentUrl.match(/\/account\/orders\/([0-9a-f]{24})$/);
    if (order) return renderPage(orderStoreData(order[1]));
    return renderPage({ user: { id: '5f00000000000000000000aa' }, basket: { items: [] } });
  }
  async evaluate() {
    throw new Error('the past-order path must not need a DOM scrape');
  }
}

async function withClient(page, fn) {
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
    return await fn(client);
  } finally {
    setSharedBrowserProvider(null);
  }
}

test('the date the list hands out reads that order back', async () => {
  const page = new FakePage();
  await withClient(page, async (client) => {
    const [newest] = await client.getPastOrderDates();
    const items = await client.getPastOrderGroceries(newest.date);
    assert.equal(items.length, 2);
    assert.equal(items[0].name, 'Organic Baby Potatoes Medley');
    assert.ok(page.visited.includes(`${ORDERS_URL}/${SEP_21_ID}`));
  });
});

test('a lookup already sitting on the orders list reloads it', async () => {
  // A failed lookup leaves the page on /account/orders. A lookup that trusted
  // that page would search the list as it was when it last loaded.
  const page = new FakePage();
  await withClient(page, async (client) => {
    await assert.rejects(client.getPastOrderGroceries('9/22'), /No past order was delivered/);
    assert.equal(page.currentUrl, ORDERS_URL);
    const before = page.visited.filter((u) => u === ORDERS_URL).length;
    await client.getPastOrderGroceries('9/13');
    const after = page.visited.filter((u) => u === ORDERS_URL).length;
    assert.equal(after, before + 1);
  });
});

test('a miss names the orders that do exist instead of claiming "no items"', async () => {
  await withClient(new FakePage(), async (client) => {
    await assert.rejects(
      client.getPastOrderGroceries('9/22'),
      /Orders on file: 2026-09-21, 2026-09-13, 2026-09-10, 2026-09-04/
    );
    await assert.rejects(client.getPastOrderGroceries('last week'), /Could not read a date/);
  });
});
