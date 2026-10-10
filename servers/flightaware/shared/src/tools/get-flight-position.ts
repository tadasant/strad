import {
  args,
  BILLING_NOTE,
  flightIdent,
  guard,
  ok,
  READ_ANNOTATIONS,
  rejectUnknown,
  type ToolContext,
  type ToolDefinition,
} from "./shared.js";

const PROPERTIES = {
  fa_flight_id: {
    type: "string",
    description:
      'The flight\'s fa_flight_id ("UAL4-1760000000-airline-0123"), from ' +
      "get_flight or search_flights. A flight NUMBER is not accepted here.",
  },
};

/** Where one flight is: the cheapest live read, one position and no track. */
export function getFlightPositionTool(ctx: ToolContext): ToolDefinition {
  return {
    name: "get_flight_position",
    description:
      "The latest reported position of one flight: lat/lon, altitude, " +
      "groundspeed, heading, whether it is climbing or descending, and when it " +
      "was reported. Only flights with a position in the last 24-48 hours. " +
      'Use this for "where is it now"; use get_flight_track for the path ' +
      "flown.\n\n" +
      `${BILLING_NOTE}\n\n` +
      'Example: {"ident":"UAL4","fa_flight_id":"UAL4-1760000000-airline-0123",' +
      '"origin":{"code":"KIAH",…},"destination":{"code":"EGLL",…},' +
      '"aircraft_type":"B789","last_position":{"altitude":370,' +
      '"altitude_change":"-","groundspeed":512,"heading":61,"latitude":52.31,' +
      '"longitude":-31.07,"timestamp":"2026-10-10T03:41:00Z","update_type":' +
      '"A"},"waypoint_count":148}\n\n' +
      "`altitude` is hundreds of feet; `altitude_change` is C (climbing), D " +
      "(descending) or - (level); `update_type` is the source: A ADS-B, Z " +
      "radar, O oceanic, P projected, M multilateration, S space-based, X " +
      "surface. Planned waypoints are reduced to a count.",
    inputSchema: {
      type: "object",
      properties: PROPERTIES,
      required: ["fa_flight_id"],
      additionalProperties: false,
    },
    annotations: { ...READ_ANNOTATIONS },
    handler: (raw) =>
      guard(ctx, async () => {
        const input = args(raw);
        rejectUnknown(input, PROPERTIES);
        const id = flightIdent(input, "fa_flight_id");
        const body = await ctx
          .client()
          .get<Record<string, unknown>>(
            `/flights/${encodeURIComponent(id)}/position`,
          );
        return ok(ctx, body ?? {});
      }),
  };
}
