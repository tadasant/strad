import {
  args,
  assertOrdered,
  BILLING_NOTE,
  flightIdent,
  guard,
  isoBound,
  ok,
  optionalEnum,
  PAGING_PROPERTIES,
  pagingArgs,
  pagingResult,
  READ_ANNOTATIONS,
  rejectUnknown,
  type ToolContext,
  type ToolDefinition,
} from "./shared.js";

const IDENT_TYPES = ["designator", "registration", "fa_flight_id"] as const;

const PROPERTIES = {
  ident: {
    type: "string",
    description:
      'A flight ident ("UAL4" — ICAO preferred over IATA "UA4", which can be ' +
      'ambiguous), an aircraft registration ("N123HQ"), or an fa_flight_id ' +
      '("UAL4-1700000000-airline-0123").',
  },
  ident_type: {
    type: "string",
    enum: IDENT_TYPES,
    description:
      "Force how `ident` is read. By default AeroAPI reads it as a " +
      "registration when it can; pass `designator` for a flight number that " +
      "happens to look like a tail number.",
  },
  start: {
    type: "string",
    description:
      'Only flights scheduled to depart at or after this ("2026-10-09" or ' +
      '"2026-10-09T14:00:00Z"). No more than 10 days back or 2 days ahead.',
  },
  end: {
    type: "string",
    description:
      "Only flights scheduled to depart BEFORE this (exclusive). Same format " +
      "and limits as `start`.",
  },
  ...PAGING_PROPERTIES,
};

/**
 * Status of one flight, or every recent and scheduled leg flown under an ident
 * or by an aircraft — the tool to start from, because it is the one that turns
 * a flight number into the `fa_flight_id` the position and track tools need.
 */
export function getFlightTool(ctx: ToolContext): ToolDefinition {
  return {
    name: "get_flight",
    description:
      "Status of a flight: scheduled, estimated and actual gate and runway " +
      "times, delays, gates, terminals, baggage claim, aircraft type, route and " +
      "progress. Pass a flight ident or registration to get its legs from up " +
      "to 10 days back to 2 days ahead (newest first), or an fa_flight_id for " +
      "exactly one " +
      "flight. Use the `fa_flight_id` of the leg you want with " +
      "get_flight_position or get_flight_track.\n\n" +
      `${BILLING_NOTE} Narrow with \`start\`/\`end\` rather than paging.\n\n` +
      'Example: {"flights":[{"ident":"UAL4","fa_flight_id":"UAL4-1760000000-' +
      'airline-0123","operator":"UAL","flight_number":"4","registration":' +
      '"N2639U","origin":{"code":"KIAH","code_iata":"IAH","name":"Houston ' +
      'Bush Int\'ctl","city":"Houston","timezone":"America/Chicago"},' +
      '"destination":{"code":"EGLL","code_iata":"LHR",…},"status":"En Route / ' +
      'On Time","departure_delay":420,"progress_percent":38,"aircraft_type":' +
      '"B789","scheduled_out":"2026-10-09T22:00:00Z","actual_out":' +
      '"2026-10-09T22:07:00Z","estimated_in":"2026-10-10T12:05:00Z",' +
      '"gate_origin":"E2"}],"returned":1,"pages_billed":1}\n\n' +
      "Times are UTC. Delays are in seconds. Null fields are omitted. Flights " +
      "older than ~10 days are not available here.",
    inputSchema: {
      type: "object",
      properties: PROPERTIES,
      required: ["ident"],
      additionalProperties: false,
    },
    annotations: { ...READ_ANNOTATIONS },
    handler: (raw) =>
      guard(ctx, async () => {
        const input = args(raw);
        rejectUnknown(input, PROPERTIES);
        const ident = flightIdent(input, "ident");
        const identType = optionalEnum(input, "ident_type", IDENT_TYPES);
        const start = isoBound(input, "start");
        const end = isoBound(input, "end");
        assertOrdered(start, end);
        const body = await ctx
          .client()
          .get<Record<string, unknown>>(
            `/flights/${encodeURIComponent(ident)}`,
            {
              ident_type: identType,
              start,
              end,
              ...pagingArgs(input),
            },
          );
        const flights = Array.isArray(body?.flights) ? body.flights : [];
        return ok(ctx, {
          flights,
          returned: flights.length,
          ...pagingResult(body ?? {}),
        });
      }),
  };
}
