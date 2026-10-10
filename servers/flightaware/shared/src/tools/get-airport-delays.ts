import {
  airportCode,
  args,
  BILLING_NOTE,
  guard,
  ok,
  READ_ANNOTATIONS,
  rejectUnknown,
  type ToolContext,
  type ToolDefinition,
} from "./shared.js";

const PROPERTIES = {
  airport: {
    type: "string",
    description: 'ICAO (preferred: "KSFO"), IATA ("SFO") or FAA LID.',
  },
};

/** Airport-wide delay programs — one cheap read before a board of flights. */
export function getAirportDelaysTool(ctx: ToolContext): ToolDefinition {
  return {
    name: "get_airport_delays",
    description:
      "Airport-wide delays in effect right now and why: weather, volume, " +
      "equipment, runway, an ATC program. One record per airport with the " +
      "worst delay's category and colour, and every reported reason. Answers " +
      '"is something wrong at this airport" without listing its flights. A ' +
      "single flight can be late with no airport delay reported; get_flight " +
      "has per-flight delays.\n\n" +
      `${BILLING_NOTE}\n\n` +
      'Example: {"airport":"KSFO","category":"weather","color":"red",' +
      '"delay_secs":5400,"reasons":[{"category":"weather","color":"red",' +
      '"delay_secs":5400,"reason":"Ground delay program: low ceilings"}]}\n\n' +
      "`color` is red (over 1 hour), yellow (15-60 minutes) or green (under " +
      "15). `delay_secs` is for ordering, not for display.",
    inputSchema: {
      type: "object",
      properties: PROPERTIES,
      required: ["airport"],
      additionalProperties: false,
    },
    annotations: { ...READ_ANNOTATIONS },
    handler: (raw) =>
      guard(ctx, async () => {
        const input = args(raw);
        rejectUnknown(input, PROPERTIES);
        const id = airportCode(input, "airport");
        const body = await ctx
          .client()
          .get<Record<string, unknown>>(
            `/airports/${encodeURIComponent(id)}/delays`,
          );
        return ok(ctx, body ?? {});
      }),
  };
}
