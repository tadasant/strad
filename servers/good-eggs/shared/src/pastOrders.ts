import { formatCents, type GoodEggsStoreData } from './basketState.js';
import type { GroceryItem, PastOrder } from './types.js';

/**
 * Past orders, read from the page payload rather than the drawn markup.
 *
 * `/account/orders` carries `storeData.populatedPastOrders` — every order's id,
 * delivery window and item count — and `/account/orders/{id}` carries
 * `storeData.order.items`. Resolving a date to an order is then a comparison of
 * calendar dates, not a substring search of page text.
 *
 * A text search of the drawn page cannot do this: the orders page draws
 * "Monday 9/21", `/reorder` names the same order "Monday, September 21st", and
 * which link a date's text lands on depends on how the page is drawn. See
 * FORK.md #11.
 */

/** The timezone Good Eggs draws delivery days in when the payload names none. */
export const DEFAULT_ORDER_TIMEZONE = 'America/Los_Angeles';

/** An order as it appears in `storeData.populatedPastOrders`. */
export interface StorePastOrder {
  id?: string;
  status?: string;
  deliveryStatus?: string;
  deliveryWindow?: { startAt?: string; endAt?: string } | null;
  itemCount?: number;
  totals?: { stripeTotal?: number } | null;
}

/** A line of `storeData.order.items` on an order's own page. */
export interface StoreOrderItem {
  id?: string;
  quantity?: number;
  quantityDescription?: string;
  subtotal?: number;
  product?: {
    id?: string;
    name?: string;
    url?: string;
    photoUrl?: string;
    retailUnits?: string;
    vendor?: { name?: string } | null;
  } | null;
}

export interface PastOrdersStoreData extends GoodEggsStoreData {
  populatedPastOrders?: StorePastOrder[] | null;
  order?: { id?: string; items?: StoreOrderItem[] | null } | null;
  foodhub?: { tzid?: string } | null;
}

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

function ordinal(day: number): string {
  const tens = day % 100;
  if (tens >= 11 && tens <= 13) return `${day}th`;
  switch (day % 10) {
    case 1:
      return `${day}st`;
    case 2:
      return `${day}nd`;
    case 3:
      return `${day}rd`;
    default:
      return `${day}th`;
  }
}

interface CalendarDate {
  year: number;
  month: number;
  day: number;
  weekday: string;
}

function dayFormatter(timeZone: string): Intl.DateTimeFormat {
  const options: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    weekday: 'long',
  };
  try {
    return new Intl.DateTimeFormat('en-US', { ...options, timeZone });
  } catch {
    // A zone name this runtime does not know must not take the whole list down.
    return new Intl.DateTimeFormat('en-US', { ...options, timeZone: DEFAULT_ORDER_TIMEZONE });
  }
}

/** The calendar day an instant falls on in `timeZone`. */
function calendarDate(iso: string, timeZone: string): CalendarDate | null {
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return null;
  const parts = dayFormatter(timeZone).formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    weekday: get('weekday'),
  };
}

/**
 * Every past order the payload carries, newest first as Good Eggs sends them.
 *
 * Null means the list could not be READ — no payload, or no
 * `populatedPastOrders` array — which callers must not report as "no orders".
 */
export function pastOrdersFromStoreData(storeData: PastOrdersStoreData | null): PastOrder[] | null {
  if (!storeData || !Array.isArray(storeData.populatedPastOrders)) return null;
  const timeZone = storeData.foodhub?.tzid || DEFAULT_ORDER_TIMEZONE;

  const orders: PastOrder[] = [];
  for (const order of storeData.populatedPastOrders) {
    const startAt = order.deliveryWindow?.startAt;
    const when = startAt ? calendarDate(startAt, timeZone) : null;
    if (!order.id || !when) continue;
    const mm = String(when.month).padStart(2, '0');
    const dd = String(when.day).padStart(2, '0');
    const monthName = MONTHS[when.month - 1];
    orders.push({
      date: `${when.weekday}, ${monthName[0].toUpperCase()}${monthName.slice(1)} ${ordinal(when.day)}`,
      isoDate: `${when.year}-${mm}-${dd}`,
      orderId: order.id,
      itemCount: typeof order.itemCount === 'number' ? order.itemCount : undefined,
      total: formatCents(order.totals?.stripeTotal ?? undefined) || undefined,
      deliveryStatus: order.deliveryStatus || undefined,
    });
  }
  return orders;
}

export interface OrderDateQuery {
  month: number;
  day: number;
  year?: number;
}

/**
 * Read the date a caller asked for, in any of the shapes they have been told
 * to send or plausibly would: `2026-09-21`, `9/21`, `09/21/2026`,
 * `September 21st`, `Sep 21`, `Monday, September 21st`, `Monday 9/21`.
 * Returns null for anything with no month and day in it.
 */
export function parseOrderDateQuery(input: string): OrderDateQuery | null {
  const text = input.trim().toLowerCase();

  const iso = text.match(/\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})\b/);
  if (iso)
    return valid({
      year: Number(iso[1]),
      month: Number(iso[2]),
      day: Number(iso[3]),
    });

  const slashed = text.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?\b/);
  if (slashed) {
    const year = slashed[3]
      ? Number(slashed[3].length === 2 ? `20${slashed[3]}` : slashed[3])
      : undefined;
    return valid({ month: Number(slashed[1]), day: Number(slashed[2]), year });
  }

  const named = text.match(/\b([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b(?:,?\s+(\d{4}))?/g);
  for (const candidate of named ?? []) {
    const parts = candidate.match(/^([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?/);
    if (!parts) continue;
    const month = MONTHS.findIndex((m) => m.startsWith(parts[1]) && parts[1].length >= 3);
    if (month === -1) continue;
    return valid({
      month: month + 1,
      day: Number(parts[2]),
      year: parts[3] ? Number(parts[3]) : undefined,
    });
  }

  return null;
}

function valid(query: OrderDateQuery): OrderDateQuery | null {
  if (query.month < 1 || query.month > 12 || query.day < 1 || query.day > 31) return null;
  return query;
}

/**
 * The order delivered on the date asked for. Without a year the newest order on
 * that month and day wins, since the list is newest first; on one day, a
 * delivered order wins over one that was not.
 */
export function findPastOrder(orders: PastOrder[], query: OrderDateQuery): PastOrder | null {
  const matches = orders.filter((order) => {
    if (!order.isoDate) return false;
    const [year, month, day] = order.isoDate.split('-').map(Number);
    if (month !== query.month || day !== query.day) return false;
    return query.year === undefined || year === query.year;
  });
  if (matches.length === 0) return null;
  const newestDay = matches[0].isoDate;
  const sameDay = matches.filter((order) => order.isoDate === newestDay);
  return sameDay.find((order) => order.deliveryStatus === 'delivered') ?? sameDay[0];
}

/**
 * An order page's line items. Null means the payload carried no `order.items`
 * array — the caller falls back to the markup rather than reporting an empty
 * order.
 */
export function pastOrderItemsFromStoreData(
  storeData: PastOrdersStoreData | null,
  baseUrl: string
): GroceryItem[] | null {
  const items = storeData?.order?.items;
  if (!Array.isArray(items)) return null;

  return items.map((item) => {
    const product = item.product ?? {};
    const relativeUrl = product.url || '';
    const url = relativeUrl
      ? relativeUrl.startsWith('http')
        ? relativeUrl
        : `${baseUrl}${relativeUrl}`
      : '';
    return {
      url,
      name: product.name || 'Unknown item',
      brand: product.vendor?.name || '',
      price: formatCents(item.subtotal),
      quantity: product.retailUnits || item.quantityDescription || '',
      quantityOrdered: typeof item.quantity === 'number' ? item.quantity : 1,
      imageUrl: product.photoUrl || undefined,
    };
  });
}
