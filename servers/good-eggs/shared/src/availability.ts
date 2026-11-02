import { extractStoreData, formatCents, type GoodEggsStoreData } from './basketState.js';
import type { GroceryDetails } from './types.js';

/**
 * Whether Good Eggs will sell a product on the basket's delivery day, read from
 * the page's own `storeData` payload. See FORK.md #14.
 *
 * Every product record carries `availabilitiesByDay`, keyed by ISO day:
 *
 *   "availabilitiesByDay":{"2026-11-02":{"status":"soldout","quantity":0}, …}
 *
 * and the payload names the day the basket is for in `currentFulfillmentDay`.
 * Measured live on 2026-11-02, the statuses are `available` (with the units
 * left), `soldout` and `unavailable`. The page's "Sorry, this product is sold
 * out." / "… is unavailable." banner is drawn from the same record. The page's
 * "Available for Delivery" strip is NOT: it is the day picker, and it lists
 * every day for a product that can be had on none of them.
 */

/**
 * The statuses that mean Good Eggs will not sell the product that day, as
 * measured. Any other status is treated as unknown rather than as a refusal,
 * so a status nobody has seen yet sends the add and lets the basket decide.
 */
const NOT_FOR_SALE = new Set(['soldout', 'unavailable']);

/** One day's entry in a product's `availabilitiesByDay`. */
export interface DayAvailability {
  /** ISO day, e.g. `2026-11-02`. */
  day: string;
  /** Good Eggs' own word for it: `available`, `soldout`, `unavailable`, … */
  status: string;
  /** Units Good Eggs says it has left that day, when it says. */
  quantity?: number;
}

export interface ProductAvailability {
  /** The basket's delivery day (`currentFulfillmentDay`), when the payload names one. */
  deliveryDay?: string;
  /** This product's entry for that day, when it has one. */
  onDeliveryDay?: DayAvailability;
  /** Every day the product record lists, oldest first. */
  days: DayAvailability[];
  /** The first listed day after the delivery day on which it is `available`. */
  nextAvailableDay?: string;
  /**
   * Whether an add for the delivery day can land: `true` on `available`,
   * `false` on `soldout` or `unavailable`, and `undefined` otherwise (no entry,
   * no delivery day, or a status not in that list), so the add goes ahead and
   * the basket re-read decides.
   */
  addable?: boolean;
}

/** The product record's per-day entries, oldest first. Malformed entries are dropped. */
function daysFromRecord(record: unknown): DayAvailability[] {
  if (!record || typeof record !== 'object') return [];
  const days: DayAvailability[] = [];
  for (const [day, value] of Object.entries(record as Record<string, unknown>)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !value || typeof value !== 'object') continue;
    const { status, quantity } = value as { status?: unknown; quantity?: unknown };
    if (typeof status !== 'string' || !status) continue;
    days.push({
      day,
      status,
      ...(typeof quantity === 'number' && Number.isFinite(quantity) ? { quantity } : {}),
    });
  }
  return days.sort((a, b) => a.day.localeCompare(b.day));
}

/**
 * Availability of `productId` from a parsed payload. Null when the payload does
 * not carry the product, or carries it with no per-day record at all, which is
 * "unknown" and never "unavailable".
 */
export function productAvailabilityFromStoreData(
  storeData: GoodEggsStoreData,
  productId: string
): ProductAvailability | null {
  const product = findProduct(storeData, productId);
  if (!product) return null;
  const days = daysFromRecord((product as { availabilitiesByDay?: unknown }).availabilitiesByDay);
  if (days.length === 0) return null;

  const deliveryDay =
    typeof storeData.currentFulfillmentDay === 'string' && storeData.currentFulfillmentDay
      ? storeData.currentFulfillmentDay
      : undefined;
  const onDeliveryDay = deliveryDay ? days.find((d) => d.day === deliveryDay) : undefined;
  const nextAvailableDay = days.find(
    (d) => d.status === 'available' && (!deliveryDay || d.day > deliveryDay)
  )?.day;

  return {
    deliveryDay,
    onDeliveryDay,
    days,
    nextAvailableDay,
    addable:
      onDeliveryDay?.status === 'available'
        ? true
        : onDeliveryDay && NOT_FOR_SALE.has(onDeliveryDay.status)
          ? false
          : undefined,
  };
}

/** The payload's record for a product, matched on its id in any case. */
function findProduct(storeData: GoodEggsStoreData, productId: string) {
  const products = storeData.products ?? {};
  return (
    products[productId] ??
    Object.values(products).find((p) => p?.id?.toLowerCase() === productId.toLowerCase())
  );
}

/** `productAvailabilityFromStoreData` over a rendered page. */
export function productAvailabilityFromHtml(
  html: string,
  productId: string
): ProductAvailability | null {
  const storeData = extractStoreData(html);
  return storeData ? productAvailabilityFromStoreData(storeData, productId) : null;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** `2026-11-02` → `Mon 11/2`, the way Good Eggs labels a day. */
export function describeDay(day: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return day;
  const [, y, m, d] = match;
  // Noon UTC keeps the calendar date the same in every timezone.
  const weekday = WEEKDAYS[new Date(`${y}-${m}-${d}T12:00:00Z`).getUTCDay()];
  return `${weekday} ${Number(m)}/${Number(d)}`;
}

/** `soldout` → `sold out`: Good Eggs' status in the words its page uses. */
export function describeStatus(status: string): string {
  return status === 'soldout' ? 'sold out' : status;
}

/**
 * The add_to_cart failure for a product Good Eggs will not sell on the basket's
 * day. It says what Good Eggs said, that retrying cannot help, and what can.
 */
export function unavailableAddMessage(
  name: string,
  availability: ProductAvailability,
  inCart = 0
): string {
  const day = availability.onDeliveryDay!;
  const status = describeStatus(day.status);
  const when = `${describeDay(day.day)}, your basket's delivery day`;
  const listed = availability.days.filter((d) => d.day >= day.day);
  const nowhere = listed.length > 0 && listed.every((d) => d.status !== 'available');
  const held =
    inCart > 0
      ? `nothing was sent. Your cart still holds ${inCart}, and no more can be added for that day.`
      : 'nothing was sent and it is not in your cart.';
  const next = availability.nextAvailableDay
    ? ` It is next available on ${describeDay(availability.nextAvailableDay)}, which only ` +
      `helps if the whole basket moves to that day.`
    : nowhere
      ? ` It is not available on any day Good Eggs lists (through ` +
        `${describeDay(listed[listed.length - 1].day)}).`
      : '';
  return (
    `${name} is ${status} for ${when}, so ${held} ` +
    `Retrying will not add it.${next} Choose a substitute and tell the user it was swapped.`
  );
}

/** HTML description → plain text, entities for the few characters Good Eggs escapes. */
function plainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/p>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * `get_grocery_details` from the product's own payload record. Null when the
 * payload does not carry the product, so the caller falls back to the page.
 */
export function groceryDetailsFromStoreData(
  storeData: GoodEggsStoreData,
  productId: string,
  url: string,
  baseUrl: string
): GroceryDetails | null {
  const product = findProduct(storeData, productId);
  if (!product?.name) return null;

  const price = product.retailPrice;
  const base = product.basePrice;
  const discounted = typeof price === 'number' && typeof base === 'number' && base > price;
  const description = product.description ? plainText(product.description) : '';
  const productUrl = product.url
    ? product.url.startsWith('http')
      ? product.url
      : `${baseUrl}${product.url}`
    : url;

  const details: GroceryDetails = {
    url: productUrl,
    name: product.name.slice(0, 300),
    brand: product.currentProducer?.name || '',
    price: formatCents(price),
    ...(discounted ? { originalPrice: formatCents(base) } : {}),
    ...(product.retailUnits ? { unit: product.retailUnits } : {}),
    ...(description ? { description: description.slice(0, 1_000) } : {}),
    ...(product.photoUrl ? { imageUrl: product.photoUrl } : {}),
  };

  const availability = productAvailabilityFromStoreData(storeData, productId);
  if (availability) {
    details.availability = availability.days.map(
      (d) =>
        `${describeDay(d.day)}: ${describeStatus(d.status)}` +
        (d.status === 'available' && typeof d.quantity === 'number' ? ` (${d.quantity} left)` : '')
    );
    if (availability.deliveryDay) details.deliveryDay = describeDay(availability.deliveryDay);
    if (availability.onDeliveryDay) {
      details.availableOnDeliveryDay = availability.addable === true;
      details.deliveryDayStatus = describeStatus(availability.onDeliveryDay.status);
    }
    // Only meaningful when the delivery day is out.
    if (availability.addable !== true && availability.nextAvailableDay) {
      details.nextAvailableDay = describeDay(availability.nextAvailableDay);
    }
  }
  return details;
}
