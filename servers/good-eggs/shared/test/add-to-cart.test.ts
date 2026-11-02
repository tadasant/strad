// How add_to_cart puts an item in the basket (FORK.md #13, strad#439).
//
// During the 2026-10-19 shop two adds in three answered "Could not find the
// add-to-cart button" on in-stock products whose pages had a visible "Add to
// basket" button, and a retry of the same product could go either way. The
// add depended on the drawn page: a fixed 3-second wait, then a 10-second wait
// for a button to become visible. Good Eggs' own button sends one request,
// `POST /api/basket/update-item`, and that request is the add here. The button
// is the fallback after a definite refusal.
//
// These run the real `addToCart()` over a fake page through
// `setSharedBrowserProvider`, the way `favorites-truthfulness.test.ts` does. The
// fake keeps a server-side basket: the payload it renders reads from it, the
// basket update writes to it, and the button click adds to it. The response
// bodies are copied from live www.goodeggs.com answers.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  GoodEggsClient,
  setSharedBrowserProvider,
  parseBasketUpdateResponse,
  BASKET_UPDATE_PATH,
  ADD_BUTTON_SELECTOR,
} from '../src/index.js';
import { renderPage, PRODUCTS, TOMATOES_ID, TOMATOES_URL } from './fixtures/page.mjs';

const POST_LOGIN_URL = 'https://www.goodeggs.com/home?recently-logged-in=true';
const BASKET_URL = 'https://www.goodeggs.com/basket';
const NO_PAYLOAD_HTML = '<!doctype html><html><body><div id="root"></div></body></html>';

/** The body Good Eggs answered a live update with, for a given line. */
function acceptedBody(productId: string, quantity: number): string {
  return JSON.stringify({
    basketItem: {
      id: `basket-item:${productId}`,
      quantity,
      shouldSubscribe: false,
      product: { id: productId },
    },
    totals: { subtotal: 1648 },
  });
}

const REFUSED_BODY = JSON.stringify({
  error: { type: 'UNEXPECTED_EXCEPTION', message: 'Product could not be added to basket' },
});

interface FakeOptions {
  /** Quantity of the tomatoes already in the basket. */
  prior?: number;
  /** Whether that existing line is a Subscribe & Save line. */
  priorSubscribed?: boolean;
  /** Whether the page's add button ever becomes visible. */
  buttonRenders?: boolean;
  /** Overrides the update endpoint's answer. */
  updateAnswer?: { status: number; body: string };
  /** The in-page fetch itself throws (a navigation tore the context down). */
  updateThrows?: boolean;
  /** What /basket serves: the payload, or nothing readable. */
  basketPage?: 'payload' | 'no-payload';
  /** Whether the product page's payload is signed in. */
  productPageSignedIn?: boolean;
  /**
   * The tomatoes' `availabilitiesByDay`. Defaults to available on the delivery
   * day; `null` leaves the record out, the way an older payload would.
   */
  availability?: Record<string, { status: string; quantity: number }> | null;
}

/** The basket's delivery day in every fake payload. A Monday. */
const DELIVERY_DAY = '2026-11-02';

/** Every day the 2026-11-02 live records listed, at one status. */
function everyDay(status: string, quantity = 0) {
  const days = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07'];
  return Object.fromEntries(days.map((day) => [day, { status, quantity }]));
}

/**
 * A Playwright `Page` stand-in for the login, the basket read and the add.
 * `basket` is the server's state; everything the page shows is drawn from it.
 */
class FakePage {
  currentUrl = 'about:blank';
  loggedIn = false;
  basket = new Map<string, number>();
  updates: Array<{ productId: string; quantity: number; shouldSubscribe: boolean }> = [];
  buttonWaits: string[] = [];
  clicks = 0;
  priorSubscribed = false;
  opts: FakeOptions;

  constructor(opts: FakeOptions = {}) {
    this.opts = opts;
    if (opts.prior) this.basket.set(TOMATOES_ID, opts.prior);
    this.priorSubscribed = opts.priorSubscribed ?? false;
  }

  private storeData(signedIn: boolean) {
    const products = structuredClone(PRODUCTS) as Record<string, Record<string, unknown>>;
    const availability =
      this.opts.availability === undefined ? everyDay('available', 40) : this.opts.availability;
    if (availability) products[TOMATOES_ID].availabilitiesByDay = availability;
    return {
      user: signedIn ? { id: 'u1' } : null,
      currentFulfillmentDay: DELIVERY_DAY,
      products,
      basket: {
        _id: 'b1',
        items: [...this.basket.entries()]
          .filter(([, quantity]) => quantity > 0)
          .map(([id, quantity]) => ({
            id: `basket-item:${id}`,
            product: { id },
            quantity,
            shouldSubscribe: id === TOMATOES_ID && this.priorSubscribed,
          })),
        totals: { subtotal: 0, lineItemTotals: {} },
      },
    };
  }

  async goto(url: string) {
    this.currentUrl = url;
  }
  async waitForTimeout() {}
  async fill() {}
  async click() {}
  async waitForURL() {
    this.currentUrl = POST_LOGIN_URL;
  }
  url() {
    return this.currentUrl;
  }
  isClosed() {
    return false;
  }
  async $() {
    return null;
  }
  async content() {
    if (!this.loggedIn) return renderPage(this.storeData(true));
    if (this.currentUrl === BASKET_URL) {
      return this.opts.basketPage === 'no-payload'
        ? NO_PAYLOAD_HTML
        : renderPage(this.storeData(true));
    }
    return renderPage(this.storeData(this.opts.productPageSignedIn ?? true));
  }
  async evaluate(
    _fn: unknown,
    arg?: { path?: string; productId: string; quantity: number; shouldSubscribe: boolean }
  ) {
    if (arg?.path !== BASKET_UPDATE_PATH) return 'Unknown item';
    this.updates.push({
      productId: arg.productId,
      quantity: arg.quantity,
      shouldSubscribe: arg.shouldSubscribe,
    });
    if (this.opts.updateThrows) {
      // The request went out and was applied; only its answer was lost.
      this.basket.set(arg.productId, arg.quantity);
      throw new Error('Execution context was destroyed');
    }
    if (this.opts.updateAnswer) return this.opts.updateAnswer;
    // Measured 2026-11-02: for a product it will not sell on the basket's day,
    // Good Eggs answers the update with a 2xx and leaves the line out.
    const today = this.opts.availability?.[DELIVERY_DAY];
    if (today && (today.status === 'soldout' || today.status === 'unavailable')) {
      return { status: 200, body: acceptedBody(arg.productId, arg.quantity) };
    }
    // The live endpoint SETS the line's total.
    this.basket.set(arg.productId, arg.quantity);
    return { status: 200, body: acceptedBody(arg.productId, arg.quantity) };
  }
  async waitForSelector(selector: string) {
    this.buttonWaits.push(selector);
    // Good Eggs draws "Add to basket" only for a product NOT in the basket; a
    // line already there reads "in basket", which the selector does not match.
    if (!this.opts.buttonRenders || (this.basket.get(TOMATOES_ID) ?? 0) > 0) {
      throw new Error('Timeout 10000ms exceeded.');
    }
    return {
      click: async () => {
        this.clicks++;
        // The button posts the selected quantity, 1 here, as the line's total.
        this.basket.set(TOMATOES_ID, 1);
      },
    };
  }
}

async function addOver(page: FakePage, quantity = 1, url = TOMATOES_URL) {
  const browser = {
    newContext: async () => ({ newPage: async () => page, close: async () => {} }),
  };
  setSharedBrowserProvider(async () => browser as never);
  try {
    const client = new GoodEggsClient({
      username: 'someone@example.com',
      password: 'hunter2',
      headless: true,
      timeout: 30000,
    });
    await client.initialize();
    page.loggedIn = true;
    return await client.addToCart(url, quantity);
  } finally {
    setSharedBrowserProvider(null);
  }
}

// ---------------------------------------------------------------------------
// The basket update is the add
// ---------------------------------------------------------------------------

test('the add is the request the site sends, and it needs no button', async () => {
  // strad#439: the button never became visible in time, so the add was never
  // sent. Here the button never renders at all, and the add still lands.
  const page = new FakePage({ buttonRenders: false });
  const result = await addOver(page);

  assert.deepEqual(page.updates, [{ productId: TOMATOES_ID, quantity: 1, shouldSubscribe: false }]);
  assert.deepEqual(page.buttonWaits, [], 'waited on a button the add does not need');
  assert.equal(result.success, true);
  assert.equal(result.verified, true);
  assert.equal(result.quantity, 1);
  assert.match(result.message, /Successfully added Organic Dry-Farmed Early Girl Tomatoes/);
});

test('the quantity sent is the total the line should end at', async () => {
  const page = new FakePage({ prior: 1 });
  const result = await addOver(page, 3);

  assert.equal(page.updates.length, 1);
  assert.equal(page.updates[0].quantity, 3);
  assert.equal(result.success, true);
  assert.equal(result.quantity, 3);
});

test('a line already at the requested quantity is not sent an update that could lower it', async () => {
  // The update SETS a total. Posting 1 against a line of 2 would remove one.
  const page = new FakePage({ prior: 2 });
  const result = await addOver(page, 1);

  assert.deepEqual(page.updates, []);
  assert.equal(page.clicks, 0);
  assert.equal(page.basket.get(TOMATOES_ID), 2);
  assert.equal(result.success, true);
  assert.match(result.message, /already in your cart at quantity 2/);
});

test('an accepted update the basket does not show is still a failure', async () => {
  // A 200 is not proof the line landed (a delivery day may need choosing); the
  // basket re-read decides.
  const page = new FakePage({
    updateAnswer: { status: 200, body: acceptedBody(TOMATOES_ID, 1) },
  });
  const result = await addOver(page);

  assert.equal(result.success, false);
  assert.equal(result.verified, true);
  assert.match(result.message, /Sent the add/);
  assert.match(result.message, /did not take effect/);
});

// ---------------------------------------------------------------------------
// The button is the fallback, and a failure says why
// ---------------------------------------------------------------------------

test('a refused update falls back to the button', async () => {
  const page = new FakePage({
    updateAnswer: { status: 500, body: REFUSED_BODY },
    buttonRenders: true,
  });
  const result = await addOver(page);

  assert.equal(page.updates.length, 1);
  assert.equal(page.clicks, 1);
  assert.deepEqual(page.buttonWaits, [ADD_BUTTON_SELECTOR]);
  assert.equal(result.success, true);
  assert.match(result.message, /Successfully added/);
});

test('a refused update with no button says what Good Eggs answered', async () => {
  const page = new FakePage({
    updateAnswer: { status: 500, body: REFUSED_BODY },
    buttonRenders: false,
  });
  const result = await addOver(page);

  assert.equal(result.success, false);
  assert.equal(result.verified, true);
  assert.match(
    result.message,
    /Good Eggs refused the basket update with HTTP 500: Product could not be added to basket/
  );
  assert.match(result.message, /add-to-cart button was not found either/);
});

test('an update whose answer was lost is not followed by the button', async () => {
  // The request reached Good Eggs and was applied; a click on top of it could
  // double the line. The basket re-read decides instead.
  const page = new FakePage({ updateThrows: true, buttonRenders: true });
  const result = await addOver(page);

  assert.equal(page.updates.length, 1);
  assert.equal(page.clicks, 0);
  assert.deepEqual(page.buttonWaits, []);
  assert.equal(page.basket.get(TOMATOES_ID), 1);
  assert.equal(result.success, true);
});

test('a 2xx this code cannot read is not followed by the button', async () => {
  const page = new FakePage({
    updateAnswer: { status: 200, body: '{"ok":true}' },
    buttonRenders: true,
  });
  const result = await addOver(page);

  assert.equal(page.clicks, 0);
  assert.equal(result.success, false);
  assert.match(result.message, /Sent the add/);
});

test('a subscribed line keeps its Subscribe & Save setting', async () => {
  const page = new FakePage({ prior: 1, priorSubscribed: true });
  await addOver(page, 2);

  assert.deepEqual(page.updates, [{ productId: TOMATOES_ID, quantity: 2, shouldSubscribe: true }]);
});

test('a URL whose id is in another case still finds the existing line', async () => {
  // A miss would read the prior as 0 and post a total of 1 over a line of 2.
  const page = new FakePage({ prior: 2 });
  const upper = TOMATOES_URL.replace(TOMATOES_ID, TOMATOES_ID.toUpperCase());
  const result = await addOver(page, 1, upper);

  assert.deepEqual(page.updates, []);
  assert.equal(page.basket.get(TOMATOES_ID), 2);
  assert.match(result.message, /already in your cart at quantity 2/);
});

test('a URL with no product id sends nothing and says so', async () => {
  const page = new FakePage({ buttonRenders: true });
  const result = await addOver(page, 1, 'https://www.goodeggs.com/bluehousefarm/tomatoes/not-an-id');

  assert.deepEqual(page.updates, []);
  assert.equal(page.clicks, 0);
  assert.equal(result.success, false);
  assert.match(result.message, /the URL carries no Good Eggs product id/);
});

// ---------------------------------------------------------------------------
// An unknown prior total
// ---------------------------------------------------------------------------

test('a failed basket read borrows the product page payload for the prior total', async () => {
  // /basket serves nothing readable before the add, but the product page
  // carries the same signed-in basket.
  const page = new FakePage({ prior: 1, basketPage: 'no-payload' });
  const result = await addOver(page, 2);

  assert.equal(page.updates.length, 1);
  assert.equal(page.updates[0].quantity, 2);
  // The read-back fails too, so the outcome is UNVERIFIED — not a failure.
  assert.equal(result.verified, false);
});

test('with no readable prior total anywhere, no add is attempted', async () => {
  // An anonymous product page is not this account's basket, so the prior
  // total stays unknown. The update posts a total and so does the button, so
  // either could lower the line.
  const page = new FakePage({
    prior: 3,
    basketPage: 'no-payload',
    productPageSignedIn: false,
    buttonRenders: true,
  });
  const result = await addOver(page, 1);

  assert.deepEqual(page.updates, []);
  assert.equal(page.clicks, 0);
  assert.equal(page.basket.get(TOMATOES_ID), 3);
  assert.match(result.message, /no add was attempted/);
});

// ---------------------------------------------------------------------------
// A product Good Eggs will not sell on the basket's day (FORK.md #14)
// ---------------------------------------------------------------------------
//
// The 2026-11-02 shop: six adds answered "Sent the add …, but it does not
// appear in your cart afterward. The add did not take effect (a delivery day
// may need to be selected, or the item may be unavailable)". Every one of the
// six was `soldout` or `unavailable` on every listed day in its own payload
// record, and the agent read "may" as "something went wrong" and substituted
// in silence.

test('a product sold out on the delivery day is refused before anything is sent', async () => {
  const page = new FakePage({ availability: everyDay('soldout'), buttonRenders: true });
  const result = await addOver(page);

  assert.deepEqual(page.updates, [], 'sent an update Good Eggs would accept and drop');
  assert.equal(page.clicks, 0);
  assert.equal(result.success, false);
  assert.equal(result.verified, true);
  assert.equal(result.unavailable, true);
  assert.equal(result.quantity, 0);
  assert.match(
    result.message,
    /^Organic Dry-Farmed Early Girl Tomatoes is sold out for Mon 11\/2, your basket's delivery day/
  );
  assert.match(result.message, /Retrying will not add it/);
  assert.match(result.message, /not available on any day Good Eggs lists \(through Sat 11\/7\)/);
  assert.match(result.message, /Choose a substitute/);
  assert.doesNotMatch(result.message, /may need to be selected/);
});

test('an unavailable product names the next day it can be had', async () => {
  const availability = {
    ...everyDay('unavailable'),
    '2026-11-04': { status: 'available', quantity: 12 },
  };
  const page = new FakePage({ availability });
  const result = await addOver(page);

  assert.deepEqual(page.updates, []);
  assert.equal(result.unavailable, true);
  assert.match(result.message, /is unavailable for Mon 11\/2/);
  assert.match(result.message, /next available on Wed 11\/4/);
});

test('without the pre-check, the same product reads as the vague failure', async () => {
  // What production said on 2026-11-02: the update is accepted and dropped.
  // With no availability record the add still goes out, and the re-read
  // reports it. This pins that the fake reproduces the live behaviour, so the
  // two tests above are testing the pre-check and not the fake.
  const page = new FakePage({ availability: null });
  page.opts.updateAnswer = { status: 200, body: acceptedBody(TOMATOES_ID, 1) };
  const result = await addOver(page);

  assert.equal(page.updates.length, 1);
  assert.equal(result.success, false);
  assert.equal(result.unavailable, undefined);
  assert.match(result.message, /does not appear in your cart afterward/);
});

test('an available product is sent as before', async () => {
  const page = new FakePage({ availability: everyDay('available', 3) });
  const result = await addOver(page);

  assert.equal(page.updates.length, 1);
  assert.equal(result.success, true);
  assert.equal(result.unavailable, undefined);
});

test('a record with no entry for the delivery day is unknown, and the add goes ahead', async () => {
  const page = new FakePage({ availability: { '2026-11-23': { status: 'available', quantity: 5 } } });
  const result = await addOver(page);

  assert.equal(page.updates.length, 1);
  assert.equal(result.success, true);
});

test('a line already in the cart is reported as met, even once the product sells out', async () => {
  const page = new FakePage({ prior: 2, availability: everyDay('soldout') });
  const result = await addOver(page, 1);

  assert.deepEqual(page.updates, []);
  assert.equal(result.success, true);
  assert.match(result.message, /already in your cart at quantity 2/);
});

test('a line below the request on a sold-out product is refused, and keeps its quantity', async () => {
  const page = new FakePage({ prior: 1, availability: everyDay('soldout') });
  const result = await addOver(page, 3);

  assert.deepEqual(page.updates, []);
  assert.equal(page.basket.get(TOMATOES_ID), 1);
  assert.equal(result.success, false);
  assert.equal(result.quantity, 1);
  assert.match(result.message, /is sold out for Mon 11\/2/);
  // It IS in the cart, at 1; saying otherwise invites a substitute on top.
  assert.match(result.message, /Your cart still holds 1, and no more can be added/);
  assert.doesNotMatch(result.message, /it is not in your cart/);
});

test('a status nobody has measured is unknown, so the add goes ahead', async () => {
  const page = new FakePage({ availability: everyDay('limited', 3) });
  const result = await addOver(page);

  assert.equal(page.updates.length, 1);
  assert.equal(result.success, true);
  assert.equal(result.unavailable, undefined);
});

// ---------------------------------------------------------------------------
// get_grocery_details, through the real client (FORK.md #14)
// ---------------------------------------------------------------------------

async function detailsOver(page: FakePage, url = TOMATOES_URL) {
  const browser = {
    newContext: async () => ({ newPage: async () => page, close: async () => {} }),
  };
  setSharedBrowserProvider(async () => browser as never);
  try {
    const client = new GoodEggsClient({
      username: 'someone@example.com',
      password: 'hunter2',
      headless: true,
      timeout: 30000,
    });
    await client.initialize();
    page.loggedIn = true;
    return await client.getGroceryDetails(url);
  } finally {
    setSharedBrowserProvider(null);
  }
}

test('details come from the payload, through a URL whose id is in another case', async () => {
  const page = new FakePage({ availability: everyDay('soldout') });
  const details = await detailsOver(
    page,
    TOMATOES_URL.replace(TOMATOES_ID, TOMATOES_ID.toUpperCase())
  );

  assert.equal(details.name, 'Organic Dry-Farmed Early Girl Tomatoes');
  assert.equal(details.brand, 'Blue House Farm');
  assert.equal(details.price, '$5.99');
  assert.equal(details.deliveryDay, 'Mon 11/2');
  assert.equal(details.availableOnDeliveryDay, false);
  assert.equal(details.deliveryDayStatus, 'sold out');
});

// ---------------------------------------------------------------------------
// The response parse, against live bodies
// ---------------------------------------------------------------------------

test('an accepted answer carries the line total Good Eggs now holds', () => {
  assert.deepEqual(parseBasketUpdateResponse(200, acceptedBody(TOMATOES_ID, 3), TOMATOES_ID), {
    kind: 'accepted',
    quantity: 3,
  });
});

test("a refusal carries Good Eggs' own reason", () => {
  assert.deepEqual(parseBasketUpdateResponse(500, REFUSED_BODY, TOMATOES_ID), {
    kind: 'refused',
    reason:
      'Good Eggs refused the basket update with HTTP 500: Product could not be added to basket',
  });
});

test('a 200 for another product is unknown, and a non-2xx without JSON is refused', () => {
  assert.equal(
    parseBasketUpdateResponse(200, acceptedBody('5ed67507d485740c50baf6bf', 1), TOMATOES_ID).kind,
    'unknown'
  );
  const html = parseBasketUpdateResponse(403, '<html>Just a moment...</html>', TOMATOES_ID);
  assert.deepEqual(html, {
    kind: 'refused',
    reason: 'Good Eggs refused the basket update with HTTP 403',
  });
});

test('the fallback button wait filters hidden matches before picking one', () => {
  // `waitForSelector(..., { state: 'visible' })` judges only the FIRST match,
  // so a hidden duplicate earlier in the document would hold the wait to its
  // timeout beside a visible button.
  assert.match(ADD_BUTTON_SELECTOR, />> visible=true$/);
});
