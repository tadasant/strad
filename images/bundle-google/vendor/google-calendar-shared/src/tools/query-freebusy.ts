import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { z } from 'zod';
import type { ClientFactory } from '../server.js';
import { logError } from '../logging.js';
import type { FreeBusyResponse } from '../types.js';
import { calendarLabel, resolveCalendars, settleAll } from '../utils/calendar-fanout.js';

/** Google's freeBusy.query takes at most 50 calendars a request. */
const FREEBUSY_BATCH = 50;

export const QueryFreebusySchema = z.object({
  time_min: z
    .string()
    .describe('Start time for the query in RFC3339 format (e.g., "2024-01-01T00:00:00Z").'),
  time_max: z
    .string()
    .describe('End time for the query in RFC3339 format (e.g., "2024-01-01T23:59:59Z").'),
  calendar_ids: z
    .array(z.string())
    .optional()
    .describe(
      'Calendar IDs to check availability for, to narrow the query. Use "primary" for the user\'s primary calendar. ' +
        'Omit it to check every calendar shown in the user\'s calendar list (the "Selected: Yes" ones in list_calendars, plus primary).',
    ),
  timezone: z
    .string()
    .optional()
    .describe('Time zone for the query (e.g., "America/New_York"). Optional.'),
});

export function queryFreebusyTool(server: Server, clientFactory: ClientFactory) {
  return {
    name: 'query_calendar_freebusy',
    description:
      'Queries free/busy information for one or more calendars within a specified time range. ' +
      'Returns time periods when calendars are busy (have events scheduled). ' +
      'Useful for finding available meeting times, checking if someone is free, or scheduling around existing events. ' +
      "By default it checks every calendar shown in the user's calendar list, their own and the ones shared with them, each reported separately; pass calendar_ids to narrow it.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        time_min: {
          type: 'string',
          description: QueryFreebusySchema.shape.time_min.description,
        },
        time_max: {
          type: 'string',
          description: QueryFreebusySchema.shape.time_max.description,
        },
        calendar_ids: {
          type: 'array',
          items: { type: 'string' },
          description: QueryFreebusySchema.shape.calendar_ids.description,
        },
        timezone: {
          type: 'string',
          description: QueryFreebusySchema.shape.timezone.description,
        },
      },
      required: ['time_min', 'time_max'],
    },
    handler: async (args: unknown) => {
      try {
        const parsed = QueryFreebusySchema.parse(args);
        const client = clientFactory();

        const resolved = await resolveCalendars(client, parsed.calendar_ids ?? []);
        const batches: (typeof resolved.targets)[] = [];
        for (let i = 0; i < resolved.targets.length; i += FREEBUSY_BATCH) {
          batches.push(resolved.targets.slice(i, i + FREEBUSY_BATCH));
        }
        const settled = await settleAll(batches, (batch) =>
          client.queryFreebusy({
            timeMin: parsed.time_min,
            timeMax: parsed.time_max,
            items: batch.map((t) => ({ id: t.id })),
            timeZone: parsed.timezone,
          }),
        );
        const first = settled.find((s) => s.ok) as
          { ok: true; value: FreeBusyResponse } | undefined;
        if (!first) {
          const errors = [...new Set(settled.map((s) => (s.ok ? '' : s.error)))].join('; ');
          throw new Error(errors);
        }
        const result = first.value;

        let output = `# Free/Busy Information\n\n`;
        const freebusyTimeOptions = parsed.timezone ? { timeZone: parsed.timezone } : undefined;
        output += `**Time Range:** ${new Date(result.timeMin).toLocaleString(undefined, freebusyTimeOptions)} to ${new Date(result.timeMax).toLocaleString(undefined, freebusyTimeOptions)}\n`;
        if (parsed.timezone) {
          output += `**Times shown in:** ${parsed.timezone}\n`;
        }
        if (parsed.calendar_ids === undefined) {
          output += `**Calendars checked:** ${resolved.scope}. Narrow with calendar_ids.\n`;
        }
        if (resolved.warning) {
          output += `**Note:** ${resolved.warning}\n`;
        }
        output += '\n';

        for (const [b, batch] of batches.entries()) {
          const outcome = settled[b];
          for (const target of batch) {
            const calendarId = target.id;
            output += `## Calendar: ${calendarLabel(target)}\n\n`;

            if (!outcome.ok) {
              output += `**Errors:**\n- ${outcome.error}\n\n---\n\n`;
              continue;
            }
            const calendarInfo = outcome.value.calendars?.[calendarId];
            if (!calendarInfo) {
              output += `**Errors:**\n- Google returned nothing for this calendar\n\n---\n\n`;
              continue;
            }

            if (calendarInfo.errors && calendarInfo.errors.length > 0) {
              output += `**Errors:**\n`;
              for (const error of calendarInfo.errors) {
                output += `- ${error.domain}: ${error.reason}\n`;
              }
              output += '\n---\n\n';
              continue;
            }

            const busyPeriods = calendarInfo.busy || [];

            if (busyPeriods.length === 0) {
              output += `**Status:** Free for the entire time range\n\n`;
            } else {
              output += `**Busy Periods:** ${busyPeriods.length}\n\n`;
              for (const period of busyPeriods) {
                const start = new Date(period.start).toLocaleString(undefined, freebusyTimeOptions);
                const end = new Date(period.end).toLocaleString(undefined, freebusyTimeOptions);
                output += `- ${start} to ${end}\n`;
              }
              output += '\n';
            }

            output += '---\n\n';
          }
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
        logError('query-freebusy-tool', error);
        return {
          content: [
            {
              type: 'text',
              text: `Error querying free/busy: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  };
}
