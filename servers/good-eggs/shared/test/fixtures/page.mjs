// Fixtures for the Good Eggs page payload.
//
// The wrapper below is the real one, copied from a live www.goodeggs.com
// response: `storeData` rides inside a call to `initReactRedux`, in an inline
// <script>, after two other <script> tags. The extractor has to find it in
// bytes shaped exactly like this, so the fixture keeps the shape and shrinks
// only the data.

/** Wrap a storeData object the way Good Eggs serves it. */
export function renderPage(storeData, { extraScripts = true } = {}) {
  const payload = JSON.stringify({ storeData });
  const before = extraScripts
    ? '<script src="/js/web/common.4d7ac0e.js" crossorigin="anonymous"></script>' +
      '<script>window._goodeggs.init();</script>'
    : '';
  return (
    '<!DOCTYPE html><html><head><title>Good Eggs</title></head><body>' +
    '<div id="root"></div>' +
    before +
    `<script>window._goodeggs.initReactRedux(window._goodeggs.entrypoint, ${payload});</script>` +
    '<script>(function(){window.analytics=window.analytics||[];})();</script>' +
    '</body></html>'
  );
}

export const TOMATOES_ID = '60e6218fab4cb10013484c3e';
export const ONION_ID = '5ed67507d485740c50baf6bf';

export const TOMATOES_URL =
  'https://www.goodeggs.com/organicdryfarmedearlygirltomatoes/organic-dry-farmed-early-girl-tomatoes/60e6218fab4cb10013484c3e';
export const ONION_URL =
  'https://www.goodeggs.com/goodeggs/organic-yellow-onion/5ed67507d485740c50baf6bf';

/** Product entries in the shape `storeData.products` really carries. */
export const PRODUCTS = {
  [TOMATOES_ID]: {
    id: TOMATOES_ID,
    name: 'Organic Dry-Farmed Early Girl Tomatoes',
    basePrice: 599,
    retailPrice: 599,
    retailUnits: '1 lb',
    maxQuantity: 100,
    photoUrl: 'https://images.goodeggs.com/tomatoes.jpg',
    url: '/organicdryfarmedearlygirltomatoes/organic-dry-farmed-early-girl-tomatoes/60e6218fab4cb10013484c3e',
    // Real producer records carry prose with braces and quotes in it; the
    // extractor's brace matching has to survive that.
    currentProducer: {
      name: 'Blue House Farm',
      shortDescription:
        'A farm that says {things} like "we grow it" and \\ uses backslashes, because real copy does.',
    },
  },
  [ONION_ID]: {
    id: ONION_ID,
    name: 'Organic Yellow Onion',
    basePrice: 129,
    retailPrice: 129,
    retailUnits: '1 each',
    photoUrl: 'https://images.goodeggs.com/onion.jpg',
    url: '/goodeggs/organic-yellow-onion/5ed67507d485740c50baf6bf',
    currentProducer: { name: 'Good Eggs' },
  },
};

/** A storeData with a two-line basket. */
export function storeDataWithBasket() {
  return {
    user: { id: 'u1' },
    currentFulfillmentDay: '2026-08-24',
    // Set even on a healthy page — this is NOT a signal that the add failed.
    selectedFulfillmentOffer: null,
    // Deep-copied: a test that deletes a product must not reach the next test.
    products: structuredClone(PRODUCTS),
    basket: {
      _id: '6a8ae8db89687807ec04e853',
      // Line ids and the lineItemTotals indirection are the real shape,
      // captured from a live basket: the money is NOT on the item.
      items: [
        {
          id: `basket-item:${TOMATOES_ID}`,
          product: { id: TOMATOES_ID },
          quantity: 2,
          shouldSubscribe: false,
        },
        {
          id: `basket-item:${ONION_ID}`,
          product: { id: ONION_ID },
          quantity: 1,
          shouldSubscribe: false,
        },
      ],
      totals: {
        subtotal: 1327,
        totalDue: 2826,
        tax: 0,
        deliveryFee: 0,
        promoDiscount: 0,
        totalSavings: 0,
        lineItemTotals: {
          [`basket-item:${TOMATOES_ID}`]: {
            id: `basket-item:${TOMATOES_ID}`,
            subtotal: 1198,
            basetotal: 1198,
            subscriptionDiscount: 0,
            bottleDeposit: 0,
          },
          [`basket-item:${ONION_ID}`]: {
            id: `basket-item:${ONION_ID}`,
            subtotal: 129,
            basetotal: 129,
            subscriptionDiscount: 0,
            bottleDeposit: 0,
          },
        },
      },
      promoCodes: [],
    },
  };
}

/** A storeData whose basket really is empty. */
export function storeDataWithEmptyBasket() {
  return {
    user: null,
    currentFulfillmentDay: '2026-08-24',
    selectedFulfillmentOffer: null,
    products: {},
    basket: { _id: 'b0', items: [], totals: { subtotal: 0, totalDue: 1499 }, promoCodes: [] },
  };
}
