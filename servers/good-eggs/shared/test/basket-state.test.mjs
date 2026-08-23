// The basket read path.
//
// These pin the behaviour behind FORK.md #1: the basket is read from the
// payload Good Eggs renders into every page, and an unreadable basket is never
// reported as an empty one. Both are the fixes for a session in which the
// server told a user his 43-item, $340.70 cart was empty, then refused to
// remove items it claimed were not there.
//
// They run against the BUILT output with node:test — no browser, no login.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractStoreData,
  cartItemsFromStoreData,
  basketSnapshotFromHtml,
  productNameFromHtml,
  formatCents,
  findCartItemForUrl,
} from '../build/index.js';
import {
  renderPage,
  storeDataWithBasket,
  storeDataWithEmptyBasket,
  PRODUCTS,
  TOMATOES_ID,
  TOMATOES_URL,
  ONION_URL,
} from './fixtures/page.mjs';

const BASE_URL = 'https://www.goodeggs.com';

test('extractStoreData finds the payload in a real-shaped page', () => {
  const html = renderPage(storeDataWithBasket());
  const storeData = extractStoreData(html);

  assert.ok(storeData, 'payload should be found');
  assert.equal(storeData.basket.items.length, 2);
  assert.equal(storeData.basket.totals.subtotal, 1327);
});

test('extractStoreData survives braces, quotes and backslashes inside strings', () => {
  // A regex would stop at the first `}` inside the producer bio. Real payloads
  // are ~130KB of exactly this.
  const storeData = extractStoreData(renderPage(storeDataWithBasket()));
  assert.match(
    storeData.products[TOMATOES_ID].currentProducer.shortDescription,
    /\{things\} like "we grow it" and \\ uses backslashes/
  );
});

test('extractStoreData keeps scanning past a script that is not the payload', () => {
  const html = renderPage(storeDataWithBasket()).replace(
    '<div id="root"></div>',
    '<div id="root"></div><script>initReactRedux({"notTheStore":true});</script>'
  );
  const storeData = extractStoreData(html);
  assert.ok(storeData, 'the real payload should still be found');
  assert.equal(storeData.basket.items.length, 2);
});

test('extractStoreData returns null when the page carries no payload', () => {
  assert.equal(extractStoreData('<html><body>Sign in to continue</body></html>'), null);
  assert.equal(extractStoreData(''), null);
});

test('extractStoreData returns null rather than throwing on a truncated payload', () => {
  const html = renderPage(storeDataWithBasket());
  // Chop the document mid-payload, the way a failed response would.
  assert.equal(extractStoreData(html.slice(0, html.indexOf('"basket"') + 40)), null);
});

test('cartItemsFromStoreData joins basket lines to the products map', () => {
  const items = cartItemsFromStoreData(storeDataWithBasket(), BASE_URL);

  assert.equal(items.length, 2);
  assert.deepEqual(items[0], {
    productId: TOMATOES_ID,
    url: `${BASE_URL}${PRODUCTS[TOMATOES_ID].url}`,
    name: 'Organic Dry-Farmed Early Girl Tomatoes',
    brand: 'Blue House Farm',
    unit: '1 lb',
    quantity: 2,
    price: '$11.98',
    imageUrl: 'https://images.goodeggs.com/tomatoes.jpg',
  });
  assert.equal(items[1].name, 'Organic Yellow Onion');
  assert.equal(items[1].price, '$1.29');
});

test('cartItemsFromStoreData accepts the productId shape as well as product.id', () => {
  const storeData = storeDataWithBasket();
  storeData.basket.items[0] = { id: 'line-1', productId: TOMATOES_ID, quantity: 3 };

  const items = cartItemsFromStoreData(storeData, BASE_URL);
  assert.equal(items[0].productId, TOMATOES_ID);
  assert.equal(items[0].quantity, 3);
});

test('a line subtotal inlined on the item is read when lineItemTotals has none', () => {
  const storeData = storeDataWithBasket();
  delete storeData.basket.totals.lineItemTotals;
  storeData.basket.items[0].subtotal = 1198;

  const items = cartItemsFromStoreData(storeData, BASE_URL);
  assert.equal(items[0].price, '$11.98');
  // No total anywhere is an empty price, not a wrong one.
  assert.equal(items[1].price, '');
});

test('cartItemsFromStoreData keeps a line whose product is missing from the map', () => {
  // Dropping it would UNDERSTATE the cart, which is the failure this whole
  // module exists to prevent. The id is what removal matches on, so the line is
  // still actionable.
  const storeData = storeDataWithBasket();
  delete storeData.products[TOMATOES_ID];

  const items = cartItemsFromStoreData(storeData, BASE_URL);
  assert.equal(items.length, 2);
  assert.equal(items[0].productId, TOMATOES_ID);
  assert.equal(items[0].name, 'Unknown item');
  assert.equal(items[0].url, '');
});

test('a cart item is still findable by url when its product data is missing', () => {
  const storeData = storeDataWithBasket();
  delete storeData.products[TOMATOES_ID];
  const items = cartItemsFromStoreData(storeData, BASE_URL);

  const found = findCartItemForUrl(items, TOMATOES_URL);
  assert.ok(found, 'productId should carry the match when the url cannot');
  assert.equal(found.quantity, 2);
});

test('basketSnapshotFromHtml reports the items and the subtotal', () => {
  const snapshot = basketSnapshotFromHtml(renderPage(storeDataWithBasket()), BASE_URL);

  assert.equal(snapshot.source, 'json');
  assert.equal(snapshot.items.length, 2);
  assert.equal(snapshot.subtotalCents, 1327);
  assert.equal(formatCents(snapshot.subtotalCents), '$13.27');
});

test('basketSnapshotFromHtml distinguishes an empty basket from an unreadable one', () => {
  // An empty basket is a snapshot with no items...
  const empty = basketSnapshotFromHtml(renderPage(storeDataWithEmptyBasket()), BASE_URL);
  assert.equal(empty.items.length, 0);
  assert.equal(empty.subtotalCents, 0);

  // ...and an unreadable page is null. Collapsing these two is the bug.
  assert.equal(basketSnapshotFromHtml('<html><body>Sign in</body></html>', BASE_URL), null);
});

test('productNameFromHtml names the product from the payload', () => {
  const html = renderPage(storeDataWithBasket());
  assert.equal(productNameFromHtml(html, TOMATOES_ID), 'Organic Dry-Farmed Early Girl Tomatoes');
  assert.equal(productNameFromHtml(html, 'nosuchproduct'), undefined);
  assert.equal(productNameFromHtml('<html></html>', TOMATOES_ID), undefined);
});

test('formatCents renders whole and fractional dollars, and nothing for nothing', () => {
  assert.equal(formatCents(0), '$0.00');
  assert.equal(formatCents(34070), '$340.70');
  assert.equal(formatCents(undefined), '');
  assert.equal(formatCents(Number.NaN), '');
});

test('the onion is matched by its own url, not the tomatoes', () => {
  const items = cartItemsFromStoreData(storeDataWithBasket(), BASE_URL);
  assert.equal(findCartItemForUrl(items, ONION_URL).name, 'Organic Yellow Onion');
  assert.equal(findCartItemForUrl(items, TOMATOES_URL).quantity, 2);
});
