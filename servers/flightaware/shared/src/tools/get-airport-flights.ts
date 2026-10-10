import { InputError } from "../errors.js";
import {
  airportCode,
  args,
  assertOrdered,
  BILLING_NOTE,
  guard,
  isoBound,
  ok,
  optionalEnum,
  optionalString,
  PAGING_PROPERTIES,
  pagingArgs,
  pagingResult,
  READ_ANNOTATIONS,
  rejectUnknown,
  type ToolContext,
  type ToolDefinition,
} from "./shared.js";

/**
 * The four boards, each its own AeroAPI endpoint and each answering under a key
 * named after itself. The combined `/airports/{id}/flights` is not offered: it
 * returns all four at once, which on a busy airport is four times the pages for
 * a question that is almost always about one of them.
 */
const BOARDS = [
  "arrivals",
  "departures",
  "scheduled_arrivals",
  "scheduled_departures",
] as const;

const FLIGHT_TYPES = ["Airline", "General_Aviation"] as const;

const PROPERTIES = {
  airport: {
    type: "string",
    description: 'ICAO (preferred: "KJFK"), IATA ("JFK") or FAA LID.',
  },
  board: {
    type: "string",
    enum: BOARDS,
    description:
      "`arrivals` — landed (newest first); `departures` — took off; " +
      "`scheduled_arrivals` — still to land, including en route; " +
      "`scheduled_departures` — still to leave.",
  },
  airline: {
    type: "string",
    description:
      'Only this airline, ICAO code preferred ("UAL"). Cannot be combined ' +
      "with `flight_type`.",
  },
  flight_type: {
    type: "string",
    enum: FLIGHT_TYPES,
    description:
      "Only airline flights, or only general aviation. Cannot be combined " +
      "with `airline`.",
  },
  start: {
    type: "string",
    description:
      'Window start, inclusive ("2026-10-09" or "2026-10-09T14:00:00Z"). No ' +
      "more than 10 days back or 2 days ahead. AeroAPI's default for " +
      "`arrivals` / `departures` is 24 hours ago.",
  },
  end: {
    type: "string",
    description: "Window end, exclusive. Same format and limits as `start`.",
  },
  ...PAGING_PROPERTIES,
};

/** An airport's arrivals or departures board, one board at a time. */
export function getAirportFlightsTool(ctx: ToolContext): ToolDefinition {
  return {
    name: "get_airport_flights",
    description:
      "One of an airport's flight boards: flights that have arrived, have " +
      "departed, are scheduled to arrive (including en route), or are " +
      "scheduled to depart. Each row has the flight's ident, fa_flight_id, " +
      "origin/destination, status, gates, delays and scheduled/estimated/" +
      "actual times.\n\n" +
      `${BILLING_NOTE} A busy airport fills a page (about 15 flights) in ` +
      "minutes, so narrow with `airline` and a `start`/`end` window before " +
      "raising `max_pages` or following `next_cursor`.\n\n" +
      'Example: {"airport":"KJFK","board":"scheduled_arrivals","flights":' +
      '[{"ident":"BAW117","fa_flight_id":"BAW117-1760000000-schedule-0001",' +
      '"operator":"BAW","origin":{"code":"EGLL",…},"destination":{"code":' +
      '"KJFK",…},"status":"En Route / Delayed","arrival_delay":1260,' +
      '"scheduled_in":"2026-10-09T19:45:00Z","estimated_in":' +
      '"2026-10-09T20:06:00Z","gate_destination":"B32","terminal_destination":' +
      '"8"}],"returned":1,"pages_billed":1,"next_cursor":"…"}\n\n' +
      "Times are UTC; delays are seconds. Null fields are omitted.",
    inputSchema: {
      type: "object",
      properties: PROPERTIES,
      required: ["airport", "board"],
      additionalProperties: false,
    },
    annotations: { ...READ_ANNOTATIONS },
    handler: (raw) =>
      guard(ctx, async () => {
        const input = args(raw);
        rejectUnknown(input, PROPERTIES);
        const id = airportCode(input, "airport");
        const board = optionalEnum(input, "board", BOARDS);
        if (board === undefined) {
          throw new InputError(
            `\`board\` is required: one of ${BOARDS.join(", ")}.`,
          );
        }
        const airline = optionalString(input, "airline")?.toUpperCase();
        if (airline !== undefined && !/^[A-Z0-9]{2,3}$/.test(airline)) {
          throw new InputError(
            `\`airline\`="${airline}" is not an airline code. Use ICAO ("UAL") ` +
              `or IATA ("UA").`,
          );
        }
        const flightType = optionalEnum(input, "flight_type", FLIGHT_TYPES);
        if (airline !== undefined && flightType !== undefined) {
          throw new InputError(
            "Pass `airline` OR `flight_type`, not both — AeroAPI refuses the " +
              "combination. An airline filter already means airline flights.",
          );
        }
        const start = isoBound(input, "start");
        const end = isoBound(input, "end");
        assertOrdered(start, end);
        const body = await ctx
          .client()
          .get<Record<string, unknown>>(
            `/airports/${encodeURIComponent(id)}/flights/${board}`,
            { airline, type: flightType, start, end, ...pagingArgs(input) },
          );
        const flights = Array.isArray(body?.[board]) ? body[board] : [];
        return ok(ctx, {
          airport: id,
          board,
          flights,
          returned: flights.length,
          ...pagingResult(body ?? {}),
        });
      }),
  };
}
