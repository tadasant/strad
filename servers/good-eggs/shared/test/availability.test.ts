// Whether a product can be had on the basket's day (FORK.md #14).
//
// The records below are trimmed from live www.goodeggs.com product pages read
// on 2026-11-02, the day six add_to_cart calls came back "did not take effect
// (a delivery day may need to be selected, or the item may be unavailable)".
// Two of those six are here as they were served: the large eggs `soldout` and
// the large onion `unavailable`, on every listed day. The yellow onion beside
// it is the available control.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  createRegisterTools,
  describeDay,
  extractStoreData,
  groceryDetailsFromStoreData,
  productAvailabilityFromHtml,
  productAvailabilityFromStoreData,
  unavailableAddMessage,
  type GoodEggsStoreData,
} from '../src/index.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { renderPage } from './fixtures/page.mjs';

const BASE_URL = 'https://www.goodeggs.com';
const EGGS_ID = '63c6ee8e6f64fc001241c7c7';
const LARGE_ONION_ID = '58db384a9693d1000a120221';
const ONION_ID = '642dc144b9053a0011ad6d54';
const LISTED = [
  '2026-11-02',
  '2026-11-03',
  '2026-11-04',
  '2026-11-05',
  '2026-11-06',
  '2026-11-07',
  '2026-11-23',
  '2026-11-24',
];

function days(status: string, quantity = 0) {
  return Object.fromEntries(LISTED.map((day) => [day, { status, quantity }]));
}

function liveStoreData(): GoodEggsStoreData {
  return {
    user: { id: 'u1' },
    currentFulfillmentDay: '2026-11-02',
    basket: { _id: 'b1', items: [], totals: { subtotal: 0 } },
    products: {
      [EGGS_ID]: {
        id: EGGS_ID,
        name: 'Organic Free Range Brown Eggs (Large)',
        basePrice: 699,
        retailPrice: 699,
        retailUnits: '1 dozen',
        url: `/judysfamilyfarm/organic-free-range-brown-eggs-large/${EGGS_ID}`,
        description:
          "<p>Judy's Family Farm Organic Brown Eggs was the first Certified Organic Egg in " +
          'California.</p>',
        currentProducer: { name: "Judy's Family Farm" },
        availabilitiesByDay: days('soldout'),
      },
      [LARGE_ONION_ID]: {
        id: LARGE_ONION_ID,
        name: 'Organic Large Yellow Onion',
        basePrice: 149,
        retailPrice: 149,
        retailUnits: '1 count',
        url: `/periandsons/organic-large-yellow-onion/${LARGE_ONION_ID}`,
        currentProducer: { name: 'Peri & Sons' },
        availabilitiesByDay: days('unavailable'),
      },
      [ONION_ID]: {
        id: ONION_ID,
        name: 'Organic Yellow Onion',
        basePrice: 99,
        retailPrice: 79,
        retailUnits: '1 count',
        url: `/periandsons/organic-yellow-onion/${ONION_ID}`,
        currentProducer: { name: 'Peri & Sons' },
        availabilitiesByDay: days('available', 43),
      },
    },
  };
}

test('a sold-out record is not addable on the delivery day, and has no next day', () => {
  const availability = productAvailabilityFromStoreData(liveStoreData(), EGGS_ID);
  assert.ok(availability);
  assert.equal(availability.deliveryDay, '2026-11-02');
  assert.deepEqual(availability.onDeliveryDay, { day: '2026-11-02', status: 'soldout', quantity: 0 });
  assert.equal(availability.addable, false);
  assert.equal(availability.nextAvailableDay, undefined);
  assert.equal(availability.days.length, LISTED.length);
});

test('the available control is addable', () => {
  const availability = productAvailabilityFromStoreData(liveStoreData(), ONION_ID);
  assert.equal(availability?.addable, true);
  assert.equal(availability?.onDeliveryDay?.quantity, 43);
});

test('the read works off a rendered page, with the id in any case', () => {
  const html = renderPage(liveStoreData());
  assert.equal(productAvailabilityFromHtml(html, LARGE_ONION_ID)?.addable, false);
  assert.equal(productAvailabilityFromHtml(html, LARGE_ONION_ID.toUpperCase())?.addable, false);
  assert.ok(extractStoreData(html));
});

test('no record, no product or no delivery day is unknown, never unavailable', () => {
  const storeData = liveStoreData();
  delete (storeData.products![ONION_ID] as { availabilitiesByDay?: unknown }).availabilitiesByDay;
  assert.equal(productAvailabilityFromStoreData(storeData, ONION_ID), null);
  assert.equal(productAvailabilityFromStoreData(storeData, '0123456789abcdef01234567'), null);

  const dayless = liveStoreData();
  dayless.currentFulfillmentDay = null;
  const availability = productAvailabilityFromStoreData(dayless, EGGS_ID);
  assert.equal(availability?.addable, undefined);
});

test('a malformed per-day entry is dropped rather than trusted', () => {
  const storeData = liveStoreData();
  (storeData.products![EGGS_ID] as { availabilitiesByDay?: unknown }).availabilitiesByDay = {
    '2026-11-02': { quantity: 0 },
    'not-a-day': { status: 'soldout' },
    '2026-11-03': { status: 'available', quantity: 4 },
  };
  const availability = productAvailabilityFromStoreData(storeData, EGGS_ID);
  assert.equal(availability?.onDeliveryDay, undefined);
  assert.equal(availability?.addable, undefined);
  assert.equal(availability?.nextAvailableDay, '2026-11-03');
});

test('days are labelled the way Good Eggs labels them', () => {
  assert.equal(describeDay('2026-11-02'), 'Mon 11/2');
  assert.equal(describeDay('2026-11-23'), 'Mon 11/23');
  assert.equal(describeDay('2026-12-31'), 'Thu 12/31');
  assert.equal(describeDay('soon'), 'soon');
});

test('the refusal says what Good Eggs said, that a retry is useless, and what to do', () => {
  const availability = productAvailabilityFromStoreData(liveStoreData(), LARGE_ONION_ID)!;
  assert.equal(
    unavailableAddMessage('Organic Large Yellow Onion', availability),
    "Organic Large Yellow Onion is unavailable for Mon 11/2, your basket's delivery day, so " +
      'nothing was sent and it is not in your cart. Retrying will not add it. It is not ' +
      'available on any day Good Eggs lists (through Tue 11/24). Choose a substitute and ' +
      'tell the user it was swapped.'
  );
});

test('a status other than soldout or unavailable is unknown, not a refusal', () => {
  const storeData = liveStoreData();
  (storeData.products![ONION_ID] as { availabilitiesByDay?: unknown }).availabilitiesByDay =
    days('limited', 2);
  assert.equal(productAvailabilityFromStoreData(storeData, ONION_ID)?.addable, undefined);
});

test('details come from the product record, not from the drawn page', () => {
  const details = groceryDetailsFromStoreData(
    liveStoreData(),
    ONION_ID,
    `${BASE_URL}/periandsons/organic-yellow-onion/${ONION_ID}`,
    BASE_URL
  );
  assert.deepEqual(details, {
    url: `${BASE_URL}/periandsons/organic-yellow-onion/${ONION_ID}`,
    name: 'Organic Yellow Onion',
    brand: 'Peri & Sons',
    price: '$0.79',
    originalPrice: '$0.99',
    unit: '1 count',
    availability: LISTED.map((day) => `${describeDay(day)}: available (43 left)`),
    deliveryDay: 'Mon 11/2',
    availableOnDeliveryDay: true,
    deliveryDayStatus: 'available',
  });
});

test('details for a sold-out product say so for the delivery day', () => {
  const details = groceryDetailsFromStoreData(liveStoreData(), EGGS_ID, 'u', BASE_URL);
  assert.equal(details?.availableOnDeliveryDay, false);
  assert.equal(details?.deliveryDayStatus, 'sold out');
  assert.equal(details?.availability?.[0], 'Mon 11/2: sold out');
  assert.equal(
    details?.description,
    "Judy's Family Farm Organic Brown Eggs was the first Certified Organic Egg in California."
  );
  assert.equal(details?.originalPrice, undefined);
});

// ---------------------------------------------------------------------------
// get_grocery_details, through the tool surface
// ---------------------------------------------------------------------------

class FakeServer {
  handlers = new Map<unknown, (request: unknown) => Promise<{ content: { text: string }[] }>>();
  setRequestHandler(schema: unknown, handler: (request: unknown) => Promise<never>) {
    this.handlers.set(schema, handler);
  }
  async call(name: string, args: Record<string, unknown> = {}) {
    return this.handlers.get(CallToolRequestSchema)!({ params: { name, arguments: args } });
  }
}

async function detailsText(productId: string, mutate?: (s: GoodEggsStoreData) => void) {
  const storeData = liveStoreData();
  mutate?.(storeData);
  const client = {
    initialize: async () => {},
    getGroceryDetails: async (url: string) =>
      groceryDetailsFromStoreData(storeData, productId, url, BASE_URL) ?? {
        url,
        name: 'Unknown',
        brand: '',
        price: '',
      },
  };
  const server = new FakeServer();
  createRegisterTools(
    () => client as never,
    async () => client as never
  )(server as never);
  const result = await server.call('get_grocery_details', {
    grocery_url: `${BASE_URL}/x/y/${productId}`,
  });
  return result.content[0].text;
}

test('get_grocery_details puts the delivery-day verdict before the description', async () => {
  const text = await detailsText(EGGS_ID);
  assert.match(text, /^\*\*Organic Free Range Brown Eggs \(Large\)\*\*\nBrand: Judy's Family Farm\n/);
  assert.match(text, /Unit: 1 dozen/);
  assert.match(
    text,
    /Your delivery day \(Mon 11\/2\): SOLD OUT\. add_to_cart cannot add it for this day\. No later listed day has it either\./
  );
  assert.match(text, /Availability by day: Mon 11\/2: sold out, Tue 11\/3: sold out/);
  assert.ok(text.indexOf('Your delivery day') < text.indexOf('Description:'));
  // The 2026-11-02 answers were 170-220K characters, almost all of it the page.
  assert.ok(text.length < 2_000, `details ran to ${text.length} characters`);
});

test('get_grocery_details says available, and says UNKNOWN when the page did not say', async () => {
  assert.match(await detailsText(ONION_ID), /Your delivery day \(Mon 11\/2\): available\./);
  const unknown = await detailsText(ONION_ID, (s) => {
    delete (s.products![ONION_ID] as { availabilitiesByDay?: unknown }).availabilitiesByDay;
  });
  assert.match(unknown, /Availability for your delivery day: UNKNOWN/);
  assert.doesNotMatch(unknown, /Available for delivery/);
});
