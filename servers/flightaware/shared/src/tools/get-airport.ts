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
    description:
      'ICAO (preferred: "KJFK", "EGLL"), IATA ("JFK") or FAA LID ("O07").',
  },
};

/** Static facts about an airport, and the code translation the others need. */
export function getAirportTool(ctx: ToolContext): ToolDefinition {
  return {
    name: "get_airport",
    description:
      "Static information about an airport: name, city, state, country, " +
      "ICAO/IATA/LID codes, type, elevation, lat/lon and timezone. Use it to " +
      "turn an IATA code into the ICAO code the other tools prefer, or to get " +
      "an airport's timezone for reading UTC flight times.\n\n" +
      `${BILLING_NOTE}\n\n` +
      'Example: {"airport_code":"KJFK","code_icao":"KJFK","code_iata":"JFK",' +
      '"code_lid":"JFK","name":"John F Kennedy Intl","type":"Airport",' +
      '"elevation":13,"city":"New York","state":"NY","country_code":"US",' +
      '"latitude":40.64,"longitude":-73.78,"timezone":"America/New_York",' +
      '"wiki_url":"https://en.wikipedia.org/wiki/…"}\n\n' +
      "An ambiguous code can come back with `alternatives` — other airports it " +
      "might mean. Use the ICAO code to be sure.",
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
          .get<Record<string, unknown>>(`/airports/${encodeURIComponent(id)}`);
        return ok(ctx, body ?? {});
      }),
  };
}
