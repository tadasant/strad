/**
 * strad delta: the read tools default to every calendar in the user's list,
 * not just `primary`. See this tree's README delta table and `HACKS.md` #166.
 */
import type { ICalendarClient } from '../server.js';
import type { Calendar, CalendarEvent } from '../types.js';

/** One calendar a read fans out to. `summary` is what the calendar list calls it, when known. */
export interface CalendarTarget {
  id: string;
  summary?: string;
}

export interface ResolvedCalendars {
  targets: CalendarTarget[];
  /** True when the caller named the calendars; false for the default set. */
  explicit: boolean;
  /** How the set was chosen, in words an agent can act on. */
  scope: string;
  /** Set when the calendar list could not be read and the tool fell back to primary. */
  warning?: string;
}

/** Most calendars the default fan-out queries. More are skipped and named as skipped. */
export const MAX_DEFAULT_CALENDARS = 50;
/** Calendar-list pages the default follows (250 calendars a page). */
const MAX_CALENDAR_LIST_PAGES = 4;
/** Concurrent per-calendar requests. */
const CONCURRENCY = 8;

/**
 * Explicit ids are taken as given, de-duplicated, in order. With none, the
 * default set is every calendar in the user's calendar list that is shown in
 * Google Calendar (`selected`), plus the primary calendar always. If the list
 * is empty or cannot be read, the default is `primary` alone and `warning`
 * says why.
 */
export async function resolveCalendars(
  client: ICalendarClient,
  explicit: string[],
): Promise<ResolvedCalendars> {
  const ids = [...new Set(explicit.map((id) => id.trim()).filter(Boolean))];
  if (ids.length > 0) {
    return {
      targets: ids.map((id) => ({ id })),
      explicit: true,
      scope: ids.length === 1 ? 'the named calendar' : `the ${ids.length} named calendars`,
    };
  }

  let all: Calendar[];
  try {
    all = await listAllCalendars(client);
  } catch (error) {
    return {
      targets: [{ id: 'primary' }],
      explicit: false,
      scope: 'the primary calendar only',
      warning: `Could not read the calendar list (${errorText(error)}), so only the primary calendar was queried.`,
    };
  }

  const shown = all.filter((c) => c.id && (c.selected === true || c.primary === true));
  // Primary first, then the list's own order.
  shown.sort((a, b) => Number(b.primary === true) - Number(a.primary === true));
  if (shown.length === 0) {
    return { targets: [{ id: 'primary' }], explicit: false, scope: 'the primary calendar only' };
  }
  const targets = shown.slice(0, MAX_DEFAULT_CALENDARS).map((c) => ({
    id: c.id,
    summary: c.summary,
  }));
  const skipped = shown.length - targets.length;
  return {
    targets,
    explicit: false,
    scope: `all ${targets.length} calendars shown in the user's calendar list (the "Selected: Yes" ones in list_calendars, plus primary)`,
    warning:
      skipped > 0
        ? `${skipped} more shown calendars were not queried (the default stops at ${MAX_DEFAULT_CALENDARS}). Name them with calendar_ids.`
        : undefined,
  };
}

async function listAllCalendars(client: ICalendarClient): Promise<Calendar[]> {
  const out: Calendar[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_CALENDAR_LIST_PAGES; page++) {
    const result = await client.listCalendars({ maxResults: 250, pageToken });
    out.push(...(result?.items ?? []));
    pageToken = result?.nextPageToken;
    if (!pageToken) break;
  }
  return out;
}

export type Settled<T> = { ok: true; value: T } | { ok: false; error: string };

/** Runs `fn` over `items` with bounded concurrency; one failure never fails the rest. */
export async function settleAll<I, T>(
  items: I[],
  fn: (item: I) => Promise<T>,
): Promise<Settled<T>[]> {
  const results: Settled<T>[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { ok: true, value: await fn(items[i]) };
      } catch (error) {
        results[i] = { ok: false, error: errorText(error) };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
  return results;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function calendarLabel(target: CalendarTarget): string {
  return target.summary && target.summary !== target.id
    ? `${target.summary} (${target.id})`
    : target.id;
}

/**
 * Milliseconds since the epoch at which an event starts. An all-day event
 * starts at local midnight in `timeZone` (the calendar's), so it sorts before
 * that day's timed events rather than at UTC midnight. `Infinity` when the
 * event carries no start, so it sorts last.
 */
export function eventStartMs(event: CalendarEvent, timeZone?: string): number {
  if (event.start?.dateTime) {
    const ms = Date.parse(event.start.dateTime);
    return Number.isNaN(ms) ? Infinity : ms;
  }
  if (event.start?.date) {
    return zonedMidnight(event.start.date, timeZone);
  }
  return Infinity;
}

function zonedMidnight(date: string, timeZone?: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return Infinity;
  const utc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (!timeZone) return utc;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(new Date(utc));
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    const asIfUtc = Date.UTC(
      get('year'),
      get('month') - 1,
      get('day'),
      get('hour'),
      get('minute'),
      get('second'),
    );
    return utc - (asIfUtc - utc);
  } catch {
    return utc;
  }
}

/** The same occurrence on two calendars (an invite on both) shares an iCalUID and a start. */
export function occurrenceKey(event: CalendarEvent): string {
  const start = event.start?.dateTime
    ? String(Date.parse(event.start.dateTime))
    : (event.start?.date ?? '');
  return `${event.iCalUID ?? event.id}|${start}`;
}
