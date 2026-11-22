/**
 * The read tools default to every calendar the user sees, not just `primary`.
 * A strad delta on the vendored tree (`vendor/google-calendar-shared/README.md`,
 * `HACKS.md` #166): upstream's `list_calendar_events` read `primary` unless an
 * agent named a calendar, so a calendar shared with the user was silently left
 * out of "what's on my calendar".
 *
 * Driven over a real MCP client, through the OAuth client and the real request
 * builders; only `fetch` and the token are stubbed. A re-vendor that drops the
 * delta fails here on the requests made and on the `**Calendar:**` lines.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { OAuth2Client } from 'google-auth-library';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createDefaultClient, createMCPServer } from 'google-calendar-workspace-mcp-server-shared';

const realFetch = globalThis.fetch;

type Cal = { id: string; summary: string; selected?: boolean; primary?: boolean };
type Ev = Record<string, unknown>;

let calendarList: Cal[] | number = [];
/** Events per calendar id, or an HTTP status that calendar answers with. */
let eventsBy: Record<string, Ev[] | number> = {};
let eventRequests: URL[] = [];
let freebusyBodies: Array<{ items: Array<{ id: string }> }> = [];
let calendarListRequests = 0;
let n = 0;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

beforeEach(() => {
  calendarList = [];
  eventsBy = {};
  eventRequests = [];
  freebusyBodies = [];
  calendarListRequests = 0;
  vi.spyOn(OAuth2Client.prototype, 'getAccessToken').mockResolvedValue({
    token: 'tok',
    res: null,
  } as never);
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const u = new URL(String(url));
    const path = decodeURIComponent(u.pathname);
    if (path.endsWith('/calendars/primary')) return json({ id: 'me@example.com' });
    if (path.endsWith('/users/me/calendarList')) {
      calendarListRequests += 1;
      if (typeof calendarList === 'number') return json({}, calendarList);
      return json({ items: calendarList });
    }
    const m = /\/calendars\/([^/]+)\/events$/.exec(path);
    if (m) {
      eventRequests.push(u);
      const id = m[1];
      const got = eventsBy[id];
      if (typeof got === 'number') return json({}, got);
      const items = (got ?? []).slice(0, Number(u.searchParams.get('maxResults') ?? 250));
      return json({ summary: id, timeZone: 'America/Los_Angeles', items });
    }
    if (path.endsWith('/freeBusy')) {
      const body = JSON.parse(String(init.body));
      freebusyBodies.push(body);
      const calendars: Record<string, unknown> = {};
      for (const { id } of body.items) {
        calendars[id] =
          id === 'denied@example.com'
            ? { busy: [], errors: [{ domain: 'global', reason: 'notFound' }] }
            : { busy: [{ start: '2026-12-01T17:00:00Z', end: '2026-12-01T18:00:00Z' }] };
      }
      return json({ timeMin: body.timeMin, timeMax: body.timeMax, calendars });
    }
    return json({}, 500);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

async function call(name: string, args: Record<string, unknown>) {
  n += 1;
  const env = {
    GOOGLE_CALENDAR_AUTH_MODE: 'oauth',
    GOOGLE_CALENDAR_OAUTH_CLIENT_ID: `all-cals-${n}`,
    GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET: 'secret',
    GOOGLE_CALENDAR_OAUTH_REFRESH_TOKEN: `refresh-${n}`,
  };
  const { server, registerHandlers } = createMCPServer({ version: '0' });
  await registerHandlers(server, () => createDefaultClient(env));
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 't', version: '0' });
  await client.connect(b);
  try {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as Array<{ text: string }>).map((c) => c.text).join('\n');
    return { result, text };
  } finally {
    await client.close();
  }
}

const timed = (id: string, start: string, extra: Ev = {}): Ev => ({
  id,
  iCalUID: `${id}@google.com`,
  summary: `Event ${id}`,
  start: { dateTime: start },
  end: { dateTime: start },
  ...extra,
});

function calendarRequested(): string[] {
  return eventRequests.map((u) =>
    decodeURIComponent(u.pathname.split('/calendars/')[1]).replace(/\/events$/, ''),
  );
}

/** Titles in the order the tool printed them. */
function titles(text: string): string[] {
  return [...text.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
}

function standardList() {
  calendarList = [
    { id: 'shared@example.com', summary: 'Partner', selected: true },
    { id: 'me@example.com', summary: 'Me', primary: true, selected: true },
    { id: 'hidden@example.com', summary: 'Unticked', selected: false },
    { id: 'holidays@group.v.calendar.google.com', summary: 'Holidays', selected: true },
  ];
}

test('with no calendar named, every selected calendar plus primary is searched, and unselected ones are not', async () => {
  standardList();
  eventsBy = {
    'me@example.com': [timed('a', '2026-12-01T17:00:00Z')],
    'shared@example.com': [timed('b', '2026-12-01T16:00:00Z')],
    'holidays@group.v.calendar.google.com': [],
  };
  const { result, text } = await call('list_calendar_events', {});
  expect(result.isError).toBeFalsy();
  // Primary first, then the list's own order; the unselected calendar is skipped.
  expect(calendarRequested()).toEqual([
    'me@example.com',
    'shared@example.com',
    'holidays@group.v.calendar.google.com',
  ]);
  expect(text).toContain('**Calendars searched:** all 3 calendars');
  expect(text).toContain('Narrow with calendar_ids');
  expect(text).toContain('**Calendar:** Partner (shared@example.com)');
  expect(text).toContain('**Calendar:** Me (me@example.com)');
  expect(text).not.toContain('hidden@example.com');
});

test("merged events are ordered by start across calendars, all-day before the same day's timed events, and truncated to max_results in total", async () => {
  standardList();
  eventsBy = {
    'me@example.com': [
      timed('m1', '2026-12-01T18:00:00Z'),
      timed('m2', '2026-12-03T18:00:00Z'),
      timed('m3', '2026-12-04T18:00:00Z'),
    ],
    'shared@example.com': [
      // 08:00 Los Angeles on Dec 1 is 16:00Z: before m1.
      {
        id: 's0',
        iCalUID: 's0@x',
        summary: 'Event s0',
        start: { date: '2026-12-01' },
        end: { date: '2026-12-02' },
      },
      timed('s1', '2026-12-01T16:00:00Z'),
      timed('s2', '2026-12-02T18:00:00Z'),
    ],
  };
  const { text } = await call('list_calendar_events', { max_results: 4 });
  expect(titles(text)).toEqual(['Event s0', 'Event s1', 'Event m1', 'Event s2']);
  expect(text).toContain('# Calendar Events (4 found)');
  expect(text).toContain('**More events match than are shown** (max_results 4)');
  // Each calendar is asked for max_results, ordered by start, so the merge is exact.
  for (const u of eventRequests) {
    expect(u.searchParams.get('maxResults')).toBe('4');
    expect(u.searchParams.get('orderBy')).toBe('startTime');
  }
});

test('the same occurrence on two calendars is listed once, naming the other calendar', async () => {
  standardList();
  const shared = timed('inv', '2026-12-01T17:00:00Z', { iCalUID: 'inv@google.com' });
  eventsBy = { 'me@example.com': [shared], 'shared@example.com': [{ ...shared }] };
  const { text } = await call('list_calendar_events', {});
  expect(titles(text)).toEqual(['Event inv']);
  expect(text).toContain('**Calendar:** Me (me@example.com)');
  expect(text).toContain('**Also on:** Partner (shared@example.com)');
});

test('calendar_ids narrows the search to the named calendars, without reading the calendar list', async () => {
  standardList();
  eventsBy = {
    'shared@example.com': [timed('b', '2026-12-01T16:00:00Z')],
    'me@example.com': [timed('a', '2026-12-01T17:00:00Z')],
  };
  const { text } = await call('list_calendar_events', { calendar_ids: ['shared@example.com'] });
  expect(calendarListRequests).toBe(0);
  expect(calendarRequested()).toEqual(['shared@example.com']);
  expect(titles(text)).toEqual(['Event b']);
  expect(text).toContain('**Calendar:** shared@example.com');
});

test('the single calendar_id still works, and combines with calendar_ids', async () => {
  eventsBy = { primary: [timed('p', '2026-12-01T17:00:00Z')], 'x@example.com': [] };
  const one = await call('list_calendar_events', { calendar_id: 'primary' });
  expect(calendarListRequests).toBe(0);
  expect(calendarRequested()).toEqual(['primary']);
  expect(titles(one.text)).toEqual(['Event p']);

  eventRequests = [];
  await call('list_calendar_events', {
    calendar_id: 'primary',
    calendar_ids: ['x@example.com', 'primary'],
  });
  expect(calendarRequested().sort()).toEqual(['primary', 'x@example.com']);
});

test('a calendar that errors is reported and does not fail the others', async () => {
  standardList();
  eventsBy = {
    'me@example.com': [timed('a', '2026-12-01T17:00:00Z')],
    'shared@example.com': 403,
  };
  const { result, text } = await call('list_calendar_events', {});
  expect(result.isError).toBeFalsy();
  expect(titles(text)).toEqual(['Event a']);
  expect(text).toContain('**Could not read 1 calendar**');
  expect(text).toMatch(/Partner \(shared@example\.com\): Permission denied/);
});

test('every calendar failing is an error; one named calendar failing reads as before', async () => {
  eventsBy = { 'nope@example.com': 404 };
  const { result, text } = await call('list_calendar_events', { calendar_id: 'nope@example.com' });
  expect(result.isError).toBe(true);
  expect(text).toBe('Error listing events: Calendar resource not found: nope@example.com');
});

test('an unreadable calendar list falls back to primary and says so', async () => {
  calendarList = 403;
  eventsBy = { primary: [timed('p', '2026-12-01T17:00:00Z')] };
  const { result, text } = await call('list_calendar_events', {});
  expect(result.isError).toBeFalsy();
  expect(calendarRequested()).toEqual(['primary']);
  expect(text).toContain('Could not read the calendar list');
  expect(titles(text)).toEqual(['Event p']);
});

test('the tool descriptions tell an agent the default is every calendar and how to narrow it', async () => {
  n += 1;
  const { server, registerHandlers } = createMCPServer({ version: '0' });
  await registerHandlers(server, () => createDefaultClient({}));
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 't', version: '0' });
  await client.connect(b);
  const { tools } = await client.listTools();
  await client.close();
  const list = tools.find((t) => t.name === 'list_calendar_events')!;
  expect(list.description).toMatch(/EVERY calendar/);
  expect(list.description).toMatch(/calendar_ids/);
  const props = list.inputSchema.properties as Record<string, { type?: string }>;
  expect(props.calendar_ids.type).toBe('array');
  expect(props.calendar_id.type).toBe('string');
  const fb = tools.find((t) => t.name === 'query_calendar_freebusy')!;
  expect(fb.inputSchema.required).toEqual(['time_min', 'time_max']);
  expect(fb.description).toMatch(/every calendar shown/);
});

test('freebusy with no calendar_ids checks every selected calendar and reports each, errors included', async () => {
  calendarList = [
    { id: 'me@example.com', summary: 'Me', primary: true, selected: true },
    { id: 'denied@example.com', summary: 'Denied', selected: true },
  ];
  const { result, text } = await call('query_calendar_freebusy', {
    time_min: '2026-12-01T00:00:00Z',
    time_max: '2026-12-02T00:00:00Z',
  });
  expect(result.isError).toBeFalsy();
  expect(freebusyBodies[0].items).toEqual([{ id: 'me@example.com' }, { id: 'denied@example.com' }]);
  expect(text).toContain('**Calendars checked:** all 2 calendars');
  expect(text).toContain('## Calendar: Me (me@example.com)');
  expect(text).toContain('**Busy Periods:** 1');
  expect(text).toContain('## Calendar: Denied (denied@example.com)');
  expect(text).toContain('- global: notFound');
});

test("freebusy with calendar_ids checks only those, and batches past Google's 50-calendar limit", async () => {
  const ids = Array.from({ length: 55 }, (_, i) => `c${i}@example.com`);
  const { result, text } = await call('query_calendar_freebusy', {
    time_min: '2026-12-01T00:00:00Z',
    time_max: '2026-12-02T00:00:00Z',
    calendar_ids: ids,
  });
  expect(result.isError).toBeFalsy();
  expect(calendarListRequests).toBe(0);
  expect(freebusyBodies.map((b) => b.items.length).sort((x, y) => y - x)).toEqual([50, 5]);
  expect(text).toContain('## Calendar: c54@example.com');
  expect(text).not.toContain('Calendars checked');
});

test('recurring instances on one calendar stay separate; an instance on two calendars collapses', async () => {
  standardList();
  const inst = (start: string) => timed(`r_${start}`, start, { iCalUID: 'series@google.com' });
  eventsBy = {
    'me@example.com': [inst('2026-12-01T17:00:00Z'), inst('2026-12-08T17:00:00Z')],
    'shared@example.com': [inst('2026-12-01T17:00:00Z')],
  };
  const { text } = await call('list_calendar_events', {});
  expect(titles(text)).toHaveLength(2);
  expect(text.match(/\*\*Also on:\*\*/g)).toHaveLength(1);
});

test('order_by updated merges by last-modified time, oldest first', async () => {
  standardList();
  eventsBy = {
    'me@example.com': [timed('new', '2026-12-01T10:00:00Z', { updated: '2026-11-20T00:00:00Z' })],
    'shared@example.com': [
      timed('old', '2026-12-05T10:00:00Z', { updated: '2026-11-01T00:00:00Z' }),
    ],
  };
  const { text } = await call('list_calendar_events', { order_by: 'updated' });
  expect(titles(text)).toEqual(['Event old', 'Event new']);
  for (const u of eventRequests) expect(u.searchParams.get('orderBy')).toBe('updated');
});

test('with single_events false and no order_by, the merge says it is approximate', async () => {
  standardList();
  eventsBy = { 'me@example.com': [timed('a', '2026-12-01T17:00:00Z')] };
  const { text } = await call('list_calendar_events', { single_events: false });
  for (const u of eventRequests) expect(u.searchParams.get('orderBy')).toBeNull();
  expect(text).toContain('the merge by start time is approximate');
});

test('a calendar with more pages sets the more-events notice even when the merge fits', async () => {
  calendarList = [{ id: 'me@example.com', summary: 'Me', primary: true, selected: true }];
  eventsBy = { 'me@example.com': [timed('a', '2026-12-01T17:00:00Z')] };
  const realList = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const res = await realList(url, init);
    if (!String(url).includes('/events')) return res;
    const body = await res.json();
    return json({ ...body, nextPageToken: 'next' });
  }) as typeof fetch;
  const { text } = await call('list_calendar_events', {});
  expect(text).toContain('**More events match than are shown**');
});

test('an explicit empty or blank calendar is refused rather than widened to every calendar', async () => {
  standardList();
  for (const args of [
    { calendar_id: '' },
    { calendar_id: '  ' },
    { calendar_ids: [] },
    { calendar_ids: [''] },
  ]) {
    const { result } = await call('list_calendar_events', args);
    expect(result.isError).toBe(true);
  }
  const fb = await call('query_calendar_freebusy', {
    time_min: '2026-12-01T00:00:00Z',
    time_max: '2026-12-02T00:00:00Z',
    calendar_ids: [],
  });
  expect(fb.result.isError).toBe(true);
  expect(eventRequests).toHaveLength(0);
  expect(freebusyBodies).toHaveLength(0);
  expect(calendarListRequests).toBe(0);
});

test('freebusy reports a failed batch against its calendars while the other batch answers', async () => {
  const ids = Array.from({ length: 51 }, (_, i) => `c${i}@example.com`);
  const realFb = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (String(url).endsWith('/freeBusy') && JSON.parse(String(init?.body)).items.length === 1) {
      return json({}, 403);
    }
    return realFb(url, init);
  }) as typeof fetch;
  const { result, text } = await call('query_calendar_freebusy', {
    time_min: '2026-12-01T00:00:00Z',
    time_max: '2026-12-02T00:00:00Z',
    calendar_ids: ids,
  });
  expect(result.isError).toBeFalsy();
  expect(text).toMatch(/## Calendar: c50@example\.com\n\n\*\*Errors:\*\*\n- Permission denied/);
  expect(text).toMatch(/## Calendar: c0@example\.com\n\n\*\*Busy Periods:\*\* 1/);
});

test('the default stops at 50 calendars and says how many it skipped', async () => {
  calendarList = Array.from({ length: 53 }, (_, i) => ({
    id: `c${i}@example.com`,
    summary: `C${i}`,
    selected: true,
    primary: i === 0,
  }));
  const { text } = await call('list_calendar_events', {});
  expect(eventRequests).toHaveLength(50);
  expect(text).toContain('3 more shown calendars were not queried');
});
