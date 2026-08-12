import { z } from 'zod';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { FlightsClientFactory } from '../server.js';
import { MAX_GRID_DAYS, DEFAULT_GRID_DAYS } from '../flights-client/flights-client.js';

export const GetDateGridSchema = z
  .object({
    origin: z.string().min(3).max(3).describe('Origin airport IATA code (e.g., "SFO")'),
    destination: z.string().min(3).max(3).describe('Destination airport IATA code (e.g., "LAX")'),
    departure_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe(
        'Anchor date for the grid in YYYY-MM-DD. The window is centred on this date. Defaults to 7 days from now.'
      ),
    return_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe('Return date in YYYY-MM-DD, held fixed while the departure date varies. Required for round_trip.'),
    window_days: z
      .number()
      .int()
      .min(1)
      .max(MAX_GRID_DAYS)
      .default(DEFAULT_GRID_DAYS)
      .describe(`Days in the grid, centred on the anchor. Default ${DEFAULT_GRID_DAYS}, max ${MAX_GRID_DAYS}.`),
    trip_type: z.enum(['one_way', 'round_trip']).default('one_way').describe('Trip type'),
    seat_class: z
      .enum(['economy', 'premium_economy', 'business', 'first'])
      .default('economy')
      .describe('Cabin class'),
    adults: z.number().int().min(1).max(9).default(1).describe('Number of adult passengers'),
    currency: z
      .string()
      .min(3)
      .max(3)
      .default('USD')
      .describe('Currency code for prices (e.g., "USD", "EUR")'),
  })
  // A round trip with no return leg is not a cheaper round trip, it is a
  // different query, and pricing a one-way under a round-trip request is a
  // silently wrong answer rather than a cheap one.
  .refine((v) => v.trip_type !== 'round_trip' || Boolean(v.return_date), {
    message: 'return_date is required when trip_type is round_trip',
    path: ['return_date'],
  });

export function getDateGridTool(_server: Server, clientFactory: FlightsClientFactory) {
  return {
    name: 'get_date_grid',
    description: `Get a date-price grid for a route: the lowest available price on each departure date in a window around your anchor date.

Returns one entry per date, the cheapest date overall, the window actually covered, and any dates with no offers. Use it when travel dates are flexible — find the cheapest day here, then call search_flights on that day for the itineraries.

Every date in the window is a separate live query, issued in sequence at least 1.5s apart, so the call costs about 1.5s per date and more when Google is slow: roughly 10s at the 7-day default, and a measured 7.2s for 5 dates. Ask for the window you need rather than the largest one. The whole grid stops at a 55s budget and reports any dates it did not reach in not_attempted_dates, so a wide window can come back partial rather than late.

Prices exclude basic economy, matching search_flights' default, so a price here is one search_flights will also show. Stops are not filtered, so a cheap day may be a long connection.

The window never starts before today; an anchor in the past is moved forward rather than returning dates that cannot be booked.

Read unavailable_dates (priced, no flights that day) and failed_dates (the request did not complete) as different things — only the first is about the route.`,
    inputSchema: {
      type: 'object' as const,
      properties: {
        origin: { type: 'string', description: 'Origin airport IATA code (e.g., "SFO")' },
        destination: {
          type: 'string',
          description: 'Destination airport IATA code (e.g., "LAX")',
        },
        departure_date: {
          type: 'string',
          description:
            'Anchor date in YYYY-MM-DD. The window is centred on this date. Default: 7 days from now.',
        },
        return_date: {
          type: 'string',
          description:
            'Return date in YYYY-MM-DD, held fixed while the departure date varies. Required when trip_type is round_trip.',
        },
        window_days: {
          type: 'number',
          description: `Days in the grid, centred on the anchor. Default: ${DEFAULT_GRID_DAYS}. Maximum: ${MAX_GRID_DAYS}. Each day costs one request (~1.5s).`,
        },
        trip_type: {
          type: 'string',
          enum: ['one_way', 'round_trip'],
          description: 'Trip type (default: one_way)',
        },
        seat_class: {
          type: 'string',
          enum: ['economy', 'premium_economy', 'business', 'first'],
          description: 'Cabin class (default: economy)',
        },
        adults: {
          type: 'number',
          description: 'Number of adult passengers (default: 1)',
        },
        currency: {
          type: 'string',
          description: 'Currency code for prices (default: USD)',
        },
      },
      required: ['origin', 'destination'],
    },
    handler: async (args: unknown) => {
      try {
        const parsed = GetDateGridSchema.parse(args);

        const client = clientFactory();
        const result = await client.getDateGrid(parsed);

        const query = {
          origin: parsed.origin,
          destination: parsed.destination,
          trip_type: parsed.trip_type,
          return_date: parsed.return_date ?? null,
          window_days: parsed.window_days,
          seat_class: parsed.seat_class,
          adults: parsed.adults,
        };

        if (result.date_grid.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  query,
                  date_grid: [],
                  cheapest: null,
                  currency: parsed.currency,
                  window: result.window,
                  unavailable_dates: result.unavailable_dates,
                  failed_dates: result.failed_dates,
                  not_attempted_dates: result.not_attempted_dates,
                  message:
                    'Every date priced successfully and none had offers. This may happen for routes with no service, or for a window Google has no fares for yet.',
                }),
              },
            ],
          };
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ query, ...result }),
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text', text: `Error getting date grid: ${message}` }],
          isError: true,
        };
      }
    },
  };
}
