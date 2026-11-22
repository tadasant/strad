import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { z } from 'zod';
import type { ClientFactory } from '../server.js';
import type { CalendarEvent, CalendarEventList } from '../types.js';
import { logError } from '../logging.js';
import { buildCalendarEventUrl } from '../utils/calendar-helpers.js';
import { showAsLine } from '../utils/show-as.js';
import {
  calendarLabel,
  eventStartMs,
  occurrenceKey,
  resolveCalendars,
  settleAll,
  type CalendarTarget,
} from '../utils/calendar-fanout.js';

export const ListEventsSchema = z.object({
  calendar_ids: z
    .array(z.string())
    .optional()
    .describe(
      'Calendar IDs to list events from, to narrow the search (e.g. ["primary", "someone@example.com"]). ' +
        'Omit it, and calendar_id, to search every calendar shown in the user\'s calendar list (the "Selected: Yes" ones in list_calendars, plus primary): the user\'s own calendars and the ones shared with them. ' +
        'Use "primary" for the user\'s primary calendar alone.',
    ),
  calendar_id: z
    .string()
    .optional()
    .describe(
      'One calendar ID to list events from. The same as calendar_ids with one entry; if both are given, both are searched. ' +
        'Omit both to search every shown calendar.',
    ),
  time_min: z
    .string()
    .optional()
    .describe(
      'Lower bound (inclusive) for event start time in RFC3339 format (e.g., "2024-01-01T00:00:00Z"). Defaults to current time if not specified.',
    ),
  time_max: z
    .string()
    .optional()
    .describe(
      'Upper bound (exclusive) for event start time in RFC3339 format (e.g., "2024-12-31T23:59:59Z").',
    ),
  max_results: z
    .number()
    .positive()
    .max(250)
    .optional()
    .default(10)
    .describe(
      'Maximum number of events to return in total, across every calendar searched. Defaults to 10, maximum is 250. ' +
        'The result says when more events matched than were shown.',
    ),
  query: z.string().optional().describe('Free text search query to filter events.'),
  single_events: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      'Whether to expand recurring events into instances. Defaults to true to show individual occurrences.',
    ),
  order_by: z
    .enum(['startTime', 'updated'])
    .optional()
    .describe(
      'Order of events. "startTime" orders by start time (requires single_events=true; the default when single_events is true), "updated" orders by last modification time, oldest first.',
    ),
});

interface CalendarResult {
  target: CalendarTarget;
  list: CalendarEventList;
}

export function listEventsTool(server: Server, clientFactory: ClientFactory) {
  return {
    name: 'list_calendar_events',
    description:
      'Lists events within an optional time range. ' +
      'By default it searches EVERY calendar shown in the user\'s calendar list (their own calendars and the calendars shared with them, the "Selected: Yes" ones in list_calendars, plus primary) and merges the results by start time; ' +
      'each event says which calendar it came from. ' +
      'Pass calendar_ids (or calendar_id) to narrow the search to specific calendars, e.g. ["primary"] for the user\'s own primary calendar only. ' +
      'Returns event details including title, time, location, attendees, and description. ' +
      'Useful for checking upcoming meetings, finding events by search query, or reviewing a specific time period. ' +
      'Shows the next 10 events unless max_results says otherwise. A calendar that cannot be read is named in the result and does not fail the others.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        calendar_ids: {
          type: 'array',
          items: { type: 'string' },
          description: ListEventsSchema.shape.calendar_ids.description,
        },
        calendar_id: {
          type: 'string',
          description: ListEventsSchema.shape.calendar_id.description,
        },
        time_min: {
          type: 'string',
          description: ListEventsSchema.shape.time_min.description,
        },
        time_max: {
          type: 'string',
          description: ListEventsSchema.shape.time_max.description,
        },
        max_results: {
          type: 'number',
          description: ListEventsSchema.shape.max_results.description,
        },
        query: {
          type: 'string',
          description: ListEventsSchema.shape.query.description,
        },
        single_events: {
          type: 'boolean',
          description: ListEventsSchema.shape.single_events.description,
        },
        order_by: {
          type: 'string',
          enum: ['startTime', 'updated'],
          description: ListEventsSchema.shape.order_by.description,
        },
      },
    },
    handler: async (args: unknown) => {
      try {
        const parsed = ListEventsSchema.parse(args);
        const client = clientFactory();

        const explicit = [
          ...(parsed.calendar_ids ?? []),
          ...(parsed.calendar_id !== undefined ? [parsed.calendar_id] : []),
        ];
        const [resolved, accountEmail] = await Promise.all([
          resolveCalendars(client, explicit),
          client.getAccountEmail(),
        ]);

        // Each calendar is asked for up to max_results, ordered, so the merged
        // first max_results are the true first max_results across all of them.
        const orderBy = parsed.order_by ?? (parsed.single_events ? 'startTime' : undefined);
        const settled = await settleAll(resolved.targets, (target) =>
          client.listEvents(target.id, {
            timeMin: parsed.time_min,
            timeMax: parsed.time_max,
            maxResults: parsed.max_results,
            q: parsed.query,
            singleEvents: parsed.single_events,
            orderBy,
          }),
        );

        const ok: CalendarResult[] = [];
        const failed: Array<{ target: CalendarTarget; error: string }> = [];
        settled.forEach((s, i) => {
          const target = resolved.targets[i];
          if (s.ok) {
            ok.push({
              target: {
                id: target.id,
                summary: target.summary ?? s.value?.summary,
              },
              list: s.value,
            });
          } else {
            failed.push({ target, error: s.error });
          }
        });

        if (ok.length === 0) {
          const detail =
            failed.length === 1
              ? failed[0].error
              : failed.map((f) => `${calendarLabel(f.target)}: ${f.error}`).join('; ');
          return {
            content: [{ type: 'text', text: `Error listing events: ${detail}` }],
            isError: true,
          };
        }

        const merged = mergeEvents(ok, parsed.order_by === 'updated');
        const shown = merged.slice(0, parsed.max_results);
        const more = merged.length > shown.length || ok.some((r) => Boolean(r.list.nextPageToken));
        const single = resolved.targets.length === 1;

        let output = '';
        if (shown.length === 0) {
          output += 'No events found matching the criteria.\n\n';
        } else {
          output += `# Calendar Events (${shown.length} found)\n\n`;
        }

        if (single) {
          output += `**Calendar:** ${ok[0].list.summary ?? ok[0].target.id}\n`;
          if (ok[0].list.timeZone) output += `**Time Zone:** ${ok[0].list.timeZone}\n`;
        } else {
          output += `**Calendars searched:** ${resolved.scope}. Narrow with calendar_ids.\n`;
          for (const r of ok) output += `  - ${calendarLabel(r.target)}\n`;
        }
        if (resolved.warning) output += `**Note:** ${resolved.warning}\n`;
        if (failed.length > 0) {
          output += `**Could not read ${failed.length} calendar${failed.length === 1 ? '' : 's'}** (their events are missing below):\n`;
          for (const f of failed) output += `  - ${calendarLabel(f.target)}: ${f.error}\n`;
        }
        if (more) {
          output += `**More events match than are shown** (max_results ${parsed.max_results}). Raise max_results, narrow time_min/time_max, or narrow calendar_ids.\n`;
        }
        output += '\n';

        for (const { event, calendars } of shown) {
          output += `## ${event.summary || '(No title)'}\n\n`;
          output += `**Event ID:** ${event.id}\n`;
          output += `**Calendar:** ${calendarLabel(calendars[0])}\n`;
          if (calendars.length > 1) {
            output += `**Also on:** ${calendars.slice(1).map(calendarLabel).join(', ')}\n`;
          }

          // Start time
          if (event.start?.dateTime) {
            const startOptions = event.start.timeZone
              ? { timeZone: event.start.timeZone }
              : undefined;
            output += `**Start:** ${new Date(event.start.dateTime).toLocaleString(undefined, startOptions)}`;
            if (event.start.timeZone) {
              output += ` (${event.start.timeZone})`;
            }
            output += '\n';
          } else if (event.start?.date) {
            output += `**Start:** ${event.start.date} (All day)\n`;
          }

          // End time
          if (event.end?.dateTime) {
            const endOptions = event.end.timeZone ? { timeZone: event.end.timeZone } : undefined;
            output += `**End:** ${new Date(event.end.dateTime).toLocaleString(undefined, endOptions)}`;
            if (event.end.timeZone) {
              output += ` (${event.end.timeZone})`;
            }
            output += '\n';
          } else if (event.end?.date) {
            output += `**End:** ${event.end.date} (All day)\n`;
          }

          // Location
          if (event.location) {
            output += `**Location:** ${event.location}\n`;
          }

          // Show as Free / Busy
          output += showAsLine(event);

          // Status
          if (event.status) {
            output += `**Status:** ${event.status}\n`;
          }

          // Organizer
          if (event.organizer) {
            output += `**Organizer:** ${event.organizer.displayName || event.organizer.email}\n`;
          }

          // Attendees
          if (event.attendees && event.attendees.length > 0) {
            output += `**Attendees:** ${event.attendees.length}\n`;
            for (const attendee of event.attendees) {
              const name = attendee.displayName || attendee.email;
              const status = attendee.responseStatus || 'needsAction';
              output += `  - ${name} (${status})\n`;
            }
          }

          // Description
          if (event.description) {
            const truncated =
              event.description.length > 200
                ? event.description.substring(0, 200) + '...'
                : event.description;
            output += `**Description:** ${truncated}\n`;
          }

          // Link — `?eid=&authuser=<email>` form so multi-account readers don't 404.
          const eventUrl = buildCalendarEventUrl(event.htmlLink, accountEmail);
          if (eventUrl) {
            output += `**Link:** ${eventUrl}\n`;
          }

          output += '\n---\n\n';
        }

        return {
          content: [
            {
              type: 'text',
              text: output,
            },
          ],
        };
      } catch (error) {
        logError('list-events-tool', error);
        return {
          content: [
            {
              type: 'text',
              text: `Error listing events: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  };
}

interface MergedEvent {
  event: CalendarEvent;
  /** The calendars this occurrence is on, in search order. The first is where it was read from. */
  calendars: CalendarTarget[];
  sortKey: number;
  /** Position in the search: calendar order, then the calendar's own order. Breaks ties stably. */
  seq: number;
}

/**
 * Merges every calendar's events into one list: by start time (or by
 * last-modified time, oldest first, for order_by=updated), all-day events
 * before that day's timed ones. The same occurrence on two calendars (an
 * invite both people have) is listed once, read from the first calendar
 * searched, with the others named.
 */
export function mergeEvents(results: CalendarResult[], byUpdated: boolean): MergedEvent[] {
  const byKey = new Map<string, MergedEvent>();
  const out: MergedEvent[] = [];
  let seq = 0;
  for (const { target, list } of results) {
    for (const event of list.items ?? []) {
      const key = occurrenceKey(event);
      const existing = byKey.get(key);
      if (existing) {
        if (!existing.calendars.some((c) => c.id === target.id)) existing.calendars.push(target);
        continue;
      }
      const raw = byUpdated ? Date.parse(event.updated ?? '') : eventStartMs(event, list.timeZone);
      const sortKey = Number.isNaN(raw) ? Infinity : raw;
      const merged: MergedEvent = {
        event,
        calendars: [target],
        sortKey,
        seq: seq++,
      };
      byKey.set(key, merged);
      out.push(merged);
    }
  }
  out.sort((a, b) => (a.sortKey === b.sortKey ? a.seq - b.seq : a.sortKey - b.sortKey));
  return out;
}
