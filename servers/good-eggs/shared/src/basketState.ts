import type { CartItem } from './types.js';

/**
 * Good Eggs is a server-rendered Redux app. Every page it serves — the basket,
 * a product page, a category listing — carries the whole client store inline:
 *
 *   <script>window._goodeggs.initReactRedux(window._goodeggs.entrypoint, {"storeData":{…}});</script>
 *
 * `storeData.basket` in that payload is the basket the server believes you have,
 * rendered per request against the session cookie. It is the SAME state the page
 * then draws itself from, which makes it authoritative in a way the drawn markup
 * is not: the markup depends on which layout variant the account is bucketed
 * into, and the payload does not.
 *
 * That distinction is the whole reason this module exists. See FORK.md #1.
 */

const SCRIPT_MARKER = 'initReactRedux(';

/** A basket line item as it appears in `storeData.basket.items`. */
export interface StoreBasketItem {
  /** Line-item id — NOT the product id. Keys `totals.lineItemTotals`. */
  id?: string;
  product?: { id?: string } | null;
  /** Present on some renders in place of `product.id`. */
  productId?: string;
  quantity?: number;
  /**
   * Line subtotal in CENTS. Good Eggs does NOT put this on the item — it keys
   * it by line-item id under `basket.totals.lineItemTotals` — but some renders
   * carry it here, so both are read.
   */
  subtotal?: number;
  basetotal?: number;
  hasBottleDeposit?: boolean;
  shouldSubscribe?: boolean;
}

/** A product as it appears in the `storeData.products` map, keyed by product id. */
export interface StoreProduct {
  id?: string;
  name?: string;
  url?: string;
  photoUrl?: string;
  retailUnits?: string;
  retailPrice?: number;
  basePrice?: number;
  currentProducer?: { name?: string } | null;
  hasVariableProducers?: boolean;
  /** Promotional price in cents; `retailPrice` already reflects it when set. */
  promoPrice?: number;
  /** HTML. */
  description?: string;
  /** Per-day `{ status, quantity }`, keyed by ISO day. Read by `availability.ts`. */
  availabilitiesByDay?: unknown;
}

/** Per-line totals, keyed by LINE-ITEM id (not product id). */
export interface StoreLineItemTotal {
  id?: string;
  subtotal?: number;
  basetotal?: number;
  subscriptionDiscount?: number;
  subtotalMinusSubscriptionDiscount?: number;
  bottleDeposit?: number;
}

export interface StoreBasketTotals {
  subtotal?: number;
  lineItemTotals?: Record<string, StoreLineItemTotal> | null;
  totalDue?: number;
  tax?: number;
  deliveryFee?: number;
  promoDiscount?: number;
  totalSavings?: number;
}

export interface GoodEggsStoreData {
  basket?: {
    _id?: string;
    items?: StoreBasketItem[];
    totals?: StoreBasketTotals;
  } | null;
  products?: Record<string, StoreProduct> | null;
  currentFulfillmentDay?: string | null;
  selectedFulfillmentOffer?: unknown;
  user?: unknown;
}

/**
 * Scan a JSON-ish source string from `start` (which must index the opening
 * brace) and return the index of the matching closing brace, honouring string
 * literals and escapes. Returns -1 if the braces never balance.
 *
 * A regex cannot do this: the payload is ~130KB of nested objects whose string
 * values contain `{`, `}` and escaped quotes (producer bios, marketing copy).
 */
function matchBrace(source: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < source.length; i++) {
    const char = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth++;
    else if (char === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Pull `storeData` out of a rendered Good Eggs page.
 *
 * Returns null when the page carries no payload — a sign-in redirect, an error
 * page, or a markup change. Callers must treat null as "the basket could not be
 * read", never as "the basket is empty": conflating those two is what told a
 * user his 43-item cart was empty.
 */
export function extractStoreData(html: string): GoodEggsStoreData | null {
  let searchFrom = 0;
  for (;;) {
    const marker = html.indexOf(SCRIPT_MARKER, searchFrom);
    if (marker === -1) return null;
    searchFrom = marker + SCRIPT_MARKER.length;

    const open = html.indexOf('{', marker);
    if (open === -1) return null;
    const close = matchBrace(html, open);
    if (close === -1) continue;

    try {
      const parsed = JSON.parse(html.slice(open, close + 1)) as {
        storeData?: GoodEggsStoreData;
      };
      if (parsed && typeof parsed === 'object' && parsed.storeData) return parsed.storeData;
    } catch {
      // Not the payload we're after (or truncated) — keep scanning.
    }
  }
}

/** The product id a basket line refers to, whichever shape the payload used. */
export function basketItemProductId(item: StoreBasketItem): string {
  return item.product?.id || item.productId || '';
}

/** Format a Good Eggs cent amount the way the site does. */
export function formatCents(cents: number | undefined): string {
  if (typeof cents !== 'number' || !Number.isFinite(cents)) return '';
  return `$${(cents / 100).toFixed(2)}`;
}

export interface BasketSnapshot {
  items: CartItem[];
  /** Basket subtotal in cents, when the payload carried totals. */
  subtotalCents?: number;
  /** Where the snapshot came from — `json` is authoritative. */
  source: 'json' | 'dom';
  /**
   * Whether the page that carried this payload was signed in.
   *
   * A signed-out page serves a perfectly readable payload for an ANONYMOUS
   * basket, which is empty. Reporting that as the user's empty cart is the same
   * false sentence this module exists to stop, arriving by a different route,
   * so callers must refuse a snapshot with this false.
   */
  signedIn: boolean;
}

/**
 * Turn a page's `storeData` into cart items.
 *
 * Line data (quantity, subtotal) comes from `basket.items`; presentation
 * (name, url, producer, unit) comes from the `products` map the same payload
 * ships. A line whose product is missing from that map is still returned — with
 * the id it has — because dropping it would understate the cart, which is the
 * failure mode this whole module exists to prevent.
 */
export function cartItemsFromStoreData(
  storeData: GoodEggsStoreData,
  baseUrl: string
): CartItem[] {
  const items = storeData.basket?.items ?? [];
  const products = storeData.products ?? {};
  const lineItemTotals = storeData.basket?.totals?.lineItemTotals ?? {};

  return items.map((item) => {
    const productId = basketItemProductId(item);
    const product = products[productId] ?? {};
    // The line's money is filed under its LINE-ITEM id, one level away from the
    // item itself; `item.subtotal` is the fallback for renders that inline it.
    const subtotal = (item.id ? lineItemTotals[item.id]?.subtotal : undefined) ?? item.subtotal;
    const relativeUrl = product.url || '';
    const url = relativeUrl
      ? relativeUrl.startsWith('http')
        ? relativeUrl
        : `${baseUrl}${relativeUrl}`
      : '';

    return {
      productId,
      url,
      name: product.name || 'Unknown item',
      brand: product.currentProducer?.name || '',
      unit: product.retailUnits || undefined,
      quantity: typeof item.quantity === 'number' ? item.quantity : 1,
      price: formatCents(subtotal),
      imageUrl: product.photoUrl || undefined,
      subscribed: item.shouldSubscribe === true,
    };
  });
}

/**
 * Build a full snapshot (items + subtotal) from a rendered page's HTML.
 *
 * Null means the basket could not be READ. That covers a page with no payload,
 * and equally a payload whose `basket` carries no `items` array — a shape change
 * or a partial render, which would otherwise read as a zero-item basket and be
 * indistinguishable from a true one.
 */
export function basketSnapshotFromHtml(html: string, baseUrl: string): BasketSnapshot | null {
  const storeData = extractStoreData(html);
  if (!storeData?.basket || !Array.isArray(storeData.basket.items)) return null;
  return {
    items: cartItemsFromStoreData(storeData, baseUrl),
    subtotalCents: storeData.basket.totals?.subtotal,
    source: 'json',
    // `user` is the slice the store always carries; a signed-out page renders it
    // null, which is exactly what an anonymous session looks like.
    signedIn: storeData.user != null,
  };
}

/**
 * The name Good Eggs gives a product, read from the payload rather than the
 * heading.
 *
 * The alternative is the first `h1, [class*="title"]` on the page, which on a
 * product page with no delivery day chosen is the day picker — so results get
 * reported against an item called "Select a delivery day". See FORK.md #4.
 */
export function productNameFromHtml(html: string, productId: string): string | undefined {
  const storeData = extractStoreData(html);
  const name = storeData?.products?.[productId]?.name;
  return name || undefined;
}
