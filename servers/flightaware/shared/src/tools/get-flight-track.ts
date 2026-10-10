import { downsample } from "../shape.js";
import {
  args,
  BILLING_NOTE,
  boundedInt,
  flightIdent,
  guard,
  ok,
  optionalBool,
  READ_ANNOTATIONS,
  rejectUnknown,
  type ToolContext,
  type ToolDefinition,
} from "./shared.js";

const DEFAULT_POINTS = 200;
const MAX_POINTS = 1000;

const PROPERTIES = {
  fa_flight_id: {
    type: "string",
    description:
      'The flight\'s fa_flight_id ("UAL4-1760000000-airline-0123"), from ' +
      "get_flight or search_flights.",
  },
  max_points: {
    type: "integer",
    minimum: 1,
    maximum: MAX_POINTS,
    description:
      `Most positions to return (1-${MAX_POINTS}, default ${DEFAULT_POINTS}). ` +
      "A longer track is evenly downsampled, first and last point kept. Does " +
      "not change the cost: AeroAPI bills the whole track either way.",
  },
  include_estimated_positions: {
    type: "boolean",
    description: "Include estimated (not reported) positions. Default false.",
  },
  include_surface_positions: {
    type: "boolean",
    description:
      "Include taxi movement on the ground at supported airports. Default false.",
  },
};

/**
 * The flown path. A long-haul track is thousands of points, so it is
 * downsampled to `max_points`, evenly, and the result says how many were
 * dropped — a caller must never mistake a thinned track for a short flight.
 */
export function getFlightTrackTool(ctx: ToolContext): ToolDefinition {
  return {
    name: "get_flight_track",
    description:
      "The path a flight has flown, as a time-ordered list of positions " +
      "(lat/lon, altitude, groundspeed, heading, timestamp), plus the distance " +
      "flown so far. Flights from the last ~10 days. For just the current " +
      "position, get_flight_position is smaller.\n\n" +
      `${BILLING_NOTE}\n\n` +
      "A long flight has thousands of points. The track is EVENLY DOWNSAMPLED " +
      `to \`max_points\` (default ${DEFAULT_POINTS}), keeping the first and ` +
      "last; `total_points` and `points_dropped` say how much was thinned.\n\n" +
      'Example: {"fa_flight_id":"UAL4-1760000000-airline-0123",' +
      '"actual_distance":2154,"positions":[{"altitude":12,"altitude_change":' +
      '"C","groundspeed":160,"heading":92,"latitude":29.98,"longitude":' +
      '-95.33,"timestamp":"2026-10-09T22:21:04Z","update_type":"A"},…],' +
      '"total_points":1312,"returned_points":200,"points_dropped":1112}\n\n' +
      "`altitude` is hundreds of feet, `actual_distance` statute miles.",
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
        const maxPoints = boundedInt(
          input,
          "max_points",
          DEFAULT_POINTS,
          MAX_POINTS,
        );
        const body = await ctx
          .client()
          .get<Record<string, unknown>>(
            `/flights/${encodeURIComponent(id)}/track`,
            {
              include_estimated_positions: optionalBool(
                input,
                "include_estimated_positions",
              ),
              include_surface_positions: optionalBool(
                input,
                "include_surface_positions",
              ),
            },
          );
        const all = Array.isArray(body?.positions) ? body.positions : [];
        const { kept, dropped } = downsample(all, maxPoints);
        return ok(ctx, {
          fa_flight_id: id,
          actual_distance: body?.actual_distance,
          positions: kept,
          total_points: all.length,
          returned_points: kept.length,
          points_dropped: dropped,
        });
      }),
  };
}
