// What the cart tools are allowed to ASSERT.
//
// Every case here is a sentence the server said during the 2026-08-18 shop that
// was not true. The rule they encode: a result may only claim what was
// measured. An unread basket is "unknown", never "empty" and never "the add did
// not take effect".
//
// Runs against the BUILT output with node:test — no browser, no login.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  reconcileAddResult,
  createRegisterTools,
  cartItemsFromStoreData,
} from '../build/index.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { storeDataWithBasket, TOMATOES_URL, ONION_URL } from './fixtures/page.mjs';

const BASE_URL = 'https://www.goodeggs.com';
const CART = cartItemsFromStoreData(storeDataWithBasket(), BASE_URL);

function addParams(overrides = {}) {
  return {
    groceryUrl: TOMATOES_URL,
    requestedQuantity: 1,
    itemName: 'Organic Dry-Farmed Early Girl Tomatoes',
    priorQuantity: 0,
    priorQuantityKnown: true,
    cartItems: CART,
    buttonFound: true,
    cartReadable: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// add_to_cart
// ---------------------------------------------------------------------------

test('a confirmed add says so', () => {
  const result = reconcileAddResult(addParams());
  assert.equal(result.success, true);
  assert.equal(result.verified, true);
  assert.match(result.message, /Successfully added/);
});

test('an unreadable basket after the add is UNVERIFIED, not a failure', () => {
  // This is the exact case that produced "Clicked add for Select a delivery
  // day, but it does not appear in your cart afterward. The add did not take
  // effect" on adds that had in fact succeeded.
  const result = reconcileAddResult(
    addParams({ cartItems: [], cartReadable: false })
  );

  assert.equal(result.verified, false);
  assert.doesNotMatch(result.message, /did not take effect/);
  assert.doesNotMatch(result.message, /does not appear in your cart/);
  assert.match(result.message, /UNVERIFIED/);
  assert.match(result.message, /Do not re-add/);
});

test('an unreadable basket with no button found is still UNVERIFIED', () => {
  const result = reconcileAddResult(
    addParams({ cartItems: [], cartReadable: false, buttonFound: false })
  );
  assert.equal(result.verified, false);
  assert.equal(result.success, false);
  assert.match(result.message, /UNVERIFIED/);
});

test('an UNVERIFIED add claims nothing in its FIELDS either, not just its prose', () => {
  // `success` must not be derived from the click, and `quantity` must be absent
  // rather than 0 — a 0 is indistinguishable from a measured absence.
  for (const buttonFound of [true, false]) {
    const result = reconcileAddResult(
      addParams({ cartItems: [], cartReadable: false, buttonFound })
    );
    assert.equal(result.success, false, `buttonFound=${buttonFound}`);
    assert.equal(result.verified, false);
    assert.equal(result.quantity, undefined);
  }
});

test('a readable basket that really lacks the item IS a failure', () => {
  // The message must stay available for the genuine case — the fix is about
  // when it is said, not about never saying it.
  const result = reconcileAddResult(addParams({ cartItems: [], cartReadable: true }));
  assert.equal(result.success, false);
  assert.equal(result.verified, true);
  assert.match(result.message, /did not take effect/);
});

test('an unmeasured prior quantity is not credited to this call', () => {
  const result = reconcileAddResult(addParams({ priorQuantityKnown: false }));
  assert.equal(result.success, true);
  assert.match(result.message, /whether this call is what put it there is unknown/);
  assert.doesNotMatch(result.message, /Successfully added/);
});

test('an unmeasured prior quantity with an absent item is still a failure', () => {
  const result = reconcileAddResult(
    addParams({ priorQuantityKnown: false, cartItems: [] })
  );
  assert.equal(result.success, false);
  assert.match(result.message, /did not take effect/);
});

test('an item already at the requested quantity is not reported as a fresh add', () => {
  const result = reconcileAddResult(addParams({ priorQuantity: 2, requestedQuantity: 2 }));
  assert.equal(result.success, true);
  assert.match(result.message, /already in your cart/);
});

// ---------------------------------------------------------------------------
// get_cart / remove_from_cart, through the tool surface
// ---------------------------------------------------------------------------

class FakeServer {
  constructor() {
    this.handlers = new Map();
  }
  setRequestHandler(schema, handler) {
    this.handlers.set(schema, handler);
  }
  async call(name, args = {}) {
    return this.handlers.get(CallToolRequestSchema)({
      params: { name, arguments: args },
    });
  }
}

/** A client stub: only the cart surface, everything else throws if touched. */
function fakeClient(overrides) {
  return {
    initialize: async () => {},
    getBasket: async () => ({ items: CART, subtotalCents: 1327, source: 'json' }),
    getCart: async function () {
      return (await this.getBasket()).items;
    },
    removeFromCart: async () => ({ success: true, verified: true, message: 'removed' }),
    addToCart: async () => ({ success: true, verified: true, message: 'added', quantity: 1 }),
    ...overrides,
  };
}

function toolServer(client) {
  const server = new FakeServer();
  createRegisterTools(
    () => client,
    async () => client
  )(server);
  return server;
}

test('get_cart reports the products, the item count and the subtotal', () => {
  const server = toolServer(fakeClient());
  return server.call('get_cart').then((result) => {
    const text = result.content[0].text;
    assert.match(text, /2 products/);
    assert.match(text, /3 total items/);
    assert.match(text, /subtotal \$13\.27/);
    // Labelled as a LINE subtotal: `Price:` means a unit price in every sibling
    // tool, and 2 x $5.99 rendered as `Price: $11.98` is read back as one.
    assert.match(text, /Line subtotal: \$11\.98/);
    assert.doesNotMatch(text, /\n {3}Price:/);
    assert.match(text, /Organic Dry-Farmed Early Girl Tomatoes/);
    assert.match(text, /Organic Yellow Onion/);
  });
});

test('get_cart reports an unreadable basket as UNKNOWN, never as empty', async () => {
  // The sentence this replaces — "Your cart is empty. Add items to your cart on
  // Good Eggs to see them here." — was returned against a 43-item basket, and
  // is what led the agent to tell the user he had removed items he had not
  // touched.
  const server = toolServer(
    fakeClient({
      getBasket: async () => {
        throw new Error('the page carried no basket payload');
      },
    })
  );

  const result = await server.call('get_cart');
  const text = result.content[0].text;
  assert.equal(result.isError, true);
  assert.doesNotMatch(text, /cart is empty/);
  assert.match(text, /UNKNOWN, not empty/);
  assert.match(text, /no basket payload/);
});

test('get_cart reports a lapsed login as UNKNOWN, not as an empty cart', async () => {
  const server = toolServer(
    fakeClient({
      getBasket: async () => {
        throw new Error('the page is not signed in, so the basket it carries is an anonymous one');
      },
    })
  );

  const result = await server.call('get_cart');
  assert.equal(result.isError, true);
  assert.doesNotMatch(result.content[0].text, /cart is empty/);
  assert.match(result.content[0].text, /not signed in/);
  assert.match(result.content[0].text, /UNKNOWN, not empty/);
});

test('get_cart still reports a genuinely empty basket as empty', async () => {
  const server = toolServer(
    fakeClient({ getBasket: async () => ({ items: [], subtotalCents: 0, source: 'json' }) })
  );

  const result = await server.call('get_cart');
  assert.match(result.content[0].text, /Your cart is empty/);
  assert.notEqual(result.isError, true);
});

test('add_to_cart does not prefix an unverified result with "Failed to", and is not an error', async () => {
  const server = toolServer(
    fakeClient({
      addToCart: async () => ({
        success: false,
        verified: false,
        message: 'Clicked add for Onion, but the basket could not be read back. UNVERIFIED.',
      }),
    })
  );

  const result = await server.call('add_to_cart', { grocery_url: ONION_URL });
  assert.doesNotMatch(result.content[0].text, /Failed to add/);
  assert.match(result.content[0].text, /UNVERIFIED/);
  // Unknown is not failed: an isError here reads as "the add did not happen".
  assert.notEqual(result.isError, true);
});

test('add_to_cart still reports a measured failure as an error', async () => {
  const server = toolServer(
    fakeClient({
      addToCart: async () => ({
        success: false,
        verified: true,
        message: 'Clicked add for Onion, but it does not appear in your cart afterward.',
      }),
    })
  );

  const result = await server.call('add_to_cart', { grocery_url: ONION_URL });
  assert.match(result.content[0].text, /Failed to add to cart:/);
  assert.equal(result.isError, true);
});

test('remove_from_cart does not prefix an unverified result with "Failed to"', async () => {
  const server = toolServer(
    fakeClient({
      removeFromCart: async () => ({
        success: false,
        verified: false,
        message: 'Clicked remove for Onion, but the basket could not be read back, UNVERIFIED',
      }),
    })
  );

  const result = await server.call('remove_from_cart', { grocery_url: ONION_URL });
  assert.doesNotMatch(result.content[0].text, /Failed to remove/);
  assert.match(result.content[0].text, /UNVERIFIED/);
});

test('remove_from_cart still reports a genuine failure as one', async () => {
  const server = toolServer(
    fakeClient({
      removeFromCart: async () => ({
        success: false,
        verified: true,
        message: 'Item not found in cart (the basket has 2 products, none of them this one).',
      }),
    })
  );

  const result = await server.call('remove_from_cart', { grocery_url: ONION_URL });
  assert.match(result.content[0].text, /Failed to remove from cart: Item not found/);
  assert.equal(result.isError, true);
});
