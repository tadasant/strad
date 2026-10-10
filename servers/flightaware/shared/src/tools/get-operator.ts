import {
  args,
  BILLING_NOTE,
  guard,
  ok,
  operatorCode,
  READ_ANNOTATIONS,
  rejectUnknown,
  type ToolContext,
  type ToolDefinition,
} from "./shared.js";

const PROPERTIES = {
  operator: {
    type: "string",
    description: 'ICAO code (preferred: "UAL", "BAW") or IATA code ("UA").',
  },
};

/** Who an airline code belongs to. */
export function getOperatorTool(ctx: ToolContext): ToolDefinition {
  return {
    name: "get_operator",
    description:
      "Who an operator (airline) code belongs to: name, short name, ICAO and " +
      "IATA codes, radio callsign, country, location, phone and website. Use " +
      "it to decode the `operator` on a flight, or to find the ICAO code the " +
      "search and airport-board tools prefer.\n\n" +
      `${BILLING_NOTE}\n\n` +
      'Example: {"icao":"UAL","iata":"UA","callsign":"United","name":' +
      '"United Airlines","shortname":"United","country":"US","location":' +
      '"Chicago, IL","phone":"+1-800-864-8331","url":"https://www.united.com"}' +
      "\n\nAn IATA code shared by more than one operator can come back with " +
      "`alternatives`. Use the ICAO code to be sure.",
    inputSchema: {
      type: "object",
      properties: PROPERTIES,
      required: ["operator"],
      additionalProperties: false,
    },
    annotations: { ...READ_ANNOTATIONS },
    handler: (raw) =>
      guard(ctx, async () => {
        const input = args(raw);
        rejectUnknown(input, PROPERTIES);
        const id = operatorCode(input, "operator");
        const body = await ctx
          .client()
          .get<Record<string, unknown>>(`/operators/${encodeURIComponent(id)}`);
        return ok(ctx, body ?? {});
      }),
  };
}
