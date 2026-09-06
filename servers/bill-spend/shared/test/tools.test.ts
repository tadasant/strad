import { describe, expect, it } from "vitest";

import { createGateway, type BillGateway } from "../src/gateway.js";
import { toolDefinitions } from "../src/tools.js";
import { WIRE_VARIANTS } from "../src/wire.js";
import { FakeBill, fixture } from "./fake-bill.js";

/**
 * The tools as an agent meets them: the arguments they accept, the filters they
 * compose out of those arguments, and what a failure looks like on the wire.
 */

function build(overrides: Parameters<typeof fixture>[0] = {}) {
  const bill = new FakeBill(fixture(overrides));
  const gateway: BillGateway = createGateway({ http: bill });
  const tools = toolDefinitions(async () => gateway);
  const tool = (name: string) => {
    const found = tools.find((t) => t.name === name);
    if (!found) throw new Error(`no tool ${name}`);
    return found;
  };
  const call = async (name: string, args: unknown) => {
    const result = await tool(name).handler(args);
    return {
      isError: result.isError === true,
      text: result.content[0]!.text,
      json: (() => {
        try {
          return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
        } catch {
          return undefined;
        }
      })(),
    };
  };
  return { bill, tools, tool, call };
}

describe("every tool description", () => {
  it("fits the 2048 characters a client will actually show an agent", () => {
    // HACKS.md #82: 2048 is not an MCP limit, it is where Claude Code cuts a
    // description — and it reports the cut in its own log rather than to the
    // server, so the tail of a longer one is text no agent ever reads. This tool
    // grew past it once already, losing the paragraph saying date filters are
    // day-granular. The long form lives in `docs/servers/bill-spend.md`, which
    // has no budget.
    const { tools } = build();
    const over = tools
      .filter((t) => t.description.length > 2048)
      .map((t) => `${t.name} (${t.description.length})`);
    expect(over).toEqual([]);
  });
});

describe("list_coding_fields", () => {
  it("ranks the field whose name looks like a chart of accounts first", async () => {
    const { call } = build();
    const result = await call("list_coding_fields", {});
    const fields = result.json!.fields as Array<Record<string, unknown>>;
    expect(fields[0]!.name).toBe("GL Account");
    expect(fields[0]!.likely_coding_field).toBe(true);
    // And it is a GUESS, never a filter: the other field is still returned.
    expect(fields.map((f) => f.name)).toContain("Project");
    expect(fields[1]!.likely_coding_field).toBe(false);
  });

  it("returns both identifier forms, because the write needs the base64 one", async () => {
    const { call } = build();
    const fields = (await call("list_coding_fields", {})).json!.fields as Array<
      Record<string, unknown>
    >;
    expect(fields[0]!.id).toBe("Y3VzdG9tZmllbGQ6MTAx");
    expect(fields[0]!.uuid).toBe("tty_gl_0001");
  });

  it("lists each field ONCE when BILL ignores the retired filter", async () => {
    // MEASURED, ON A LIVE COMPANY. "Everything" needs a union of two walks
    // because `retired` is `eq`-only and defaults to false — but
    // `/v3/spend/custom-fields` ACCEPTS `retired:eq:true` and does not apply it,
    // so both walks come back with every field and the union doubled each one.
    // A caller reading a chart of accounts listed twice has no way to tell that
    // from a company that really has two fields of the same name.
    const { call } = build({ ignoresRetiredFilterOnFields: true });
    const fields = (
      await call("list_coding_fields", { include_retired: true })
    ).json!.fields as Array<Record<string, unknown>>;
    expect(fields.map((f) => f.name)).toEqual(["GL Account", "Project"]);
  });

  it("hides a retired field by DEFAULT even though BILL returns it", async () => {
    // The other half of the same measurement. The endpoint ignores
    // `retired:eq:false` as readily as it ignores `retired:eq:true`, so the
    // default walk comes back carrying retired fields — and an agent reading
    // that result would code a transaction to a dead account. Filtered locally,
    // so it is right under either behaviour.
    const { call } = build({
      ignoresRetiredFilterOnFields: true,
      fields: [
        ...fixture().fields,
        {
          id: "Y3VzdG9tZmllbGQ6MzAz",
          uuid: "tty_old_0003",
          name: "Old Account",
          retired: true,
          values: [],
        },
      ],
    });
    const names = ((await call("list_coding_fields", {})).json!.fields as Array<
      Record<string, unknown>
    >).map((f) => f.name);
    expect(names).not.toContain("Old Account");
    expect(names).toContain("GL Account");
  });

  it("still finds a retired field when BILL DOES apply the filter", async () => {
    // The other half of the same union: the dedupe must not cost the second
    // walk its results on an endpoint that honours the filter.
    const { call } = build({
      fields: [
        ...fixture().fields,
        {
          id: "Y3VzdG9tZmllbGQ6MzAz",
          uuid: "tty_old_0003",
          name: "Old Account",
          retired: true,
          values: [],
        },
      ],
    });
    const withRetired = (
      await call("list_coding_fields", { include_retired: true })
    ).json!.fields as Array<Record<string, unknown>>;
    expect(withRetired.map((f) => f.name)).toContain("Old Account");

    const without = (await call("list_coding_fields", {})).json!
      .fields as Array<Record<string, unknown>>;
    expect(without.map((f) => f.name)).not.toContain("Old Account");
  });
});

describe("list_coding_options", () => {
  it("returns the `id` beside the `uuid` — the whole reason this tool exists", async () => {
    const { call } = build();
    const result = await call("list_coding_options", { field: "tty_gl_0001" });
    const options = result.json!.options as Array<Record<string, unknown>>;
    for (const option of options) {
      expect(option.id, "every option must carry the form that writes").toBeTypeOf(
        "string",
      );
      expect(option.uuid).toBeTypeOf("string");
    }
    expect(options.map((o) => o.value)).toContain("Internet/Phone");
  });

  it("filters locally by substring", async () => {
    const { call } = build();
    const result = await call("list_coding_options", {
      field: "tty_gl_0001",
      query: "internet",
    });
    expect(result.json!.returned).toBe(1);
  });

  it("refuses a call with no field rather than guessing one", async () => {
    const { call } = build();
    const result = await call("list_coding_options", {});
    expect(result.isError).toBe(true);
    expect(result.text).toContain("`field` is required");
  });
});

describe("list_transactions", () => {
  it("composes ONE comma-separated filters parameter, which is BILL's grammar", async () => {
    // Several `filters=` parameters is the obvious other guess, and BILL would
    // apply one of them — a sweep that believes it is incremental and is not.
    const { bill, call } = build();
    await call("list_transactions", {
      updated_after: "2026-09-01T00:00:00Z",
      is_locked: false,
      transaction_type: "CLEAR",
    });
    const query = bill.calls.at(-1)!.query;
    expect(query.filters).toBe(
      "updatedTime:gte:2026-08-31,isLocked:eq:false,transactionType:eq:CLEAR",
    );
  });

  it("sends BILL a DATE, because an ISO instant is four colons of broken grammar", async () => {
    // The bug this replaced: `updatedTime:gte:2026-09-01T00:00:00.000Z` is a
    // 422 "Invalid filter request format. Expect (field:operator:value)." from
    // BILL, because the grammar is split on `:` and the instant carries four of
    // them. Every date filter on this tool failed, so the incremental sweep the
    // description promises was a full-history scan.
    const { bill, call } = build();
    await call("list_transactions", {
      occurred_after: "2026-05-01T00:00:00Z",
      occurred_before: "2026-08-31T23:59:59Z",
      updated_after: "2026-09-01T00:00:00Z",
      updated_before: "2026-09-30T00:00:00Z",
    });
    expect(bill.calls.at(-1)!.query.filters).toBe(
      [
        "updatedTime:gte:2026-08-31",
        "updatedTime:lte:2026-10-01",
        "occurredTime:gte:2026-04-30",
        "occurredTime:lte:2026-09-01",
      ].join(","),
    );
  });

  it("rounds each bound OUTWARD, so the window can only be too wide", async () => {
    // BILL resolves a filter date to the instant that day STARTS at, in a zone
    // it does not document. Rounding inward would silently drop a sweep's most
    // recent day; rounding outward costs rows the caller can see and discard.
    const { bill, call } = build();
    await call("list_transactions", {
      occurred_after: "2026-09-06T23:59:00Z",
      occurred_before: "2026-09-06T00:00:01Z",
    });
    const terms = (bill.calls.at(-1)!.query.filters as string).split(",");
    expect(terms).toContain("occurredTime:gte:2026-09-05");
    expect(terms).toContain("occurredTime:lte:2026-09-07");
  });

  it("takes a bare date as readily as an instant", async () => {
    const { bill, call } = build();
    await call("list_transactions", { occurred_after: "2026-09-01" });
    expect(bill.calls.at(-1)!.query.filters).toBe("occurredTime:gte:2026-08-31");
  });

  it("echoes the terms it actually sent, which are not the ones asked for", async () => {
    const { call } = build();
    const result = await call("list_transactions", {
      occurred_after: "2026-09-01T12:00:00Z",
    });
    expect(result.json!.filters_applied).toEqual(["occurredTime:gte:2026-08-31"]);
  });

  it("filters on is_reviewed, the only review-related thing this API offers", async () => {
    // BILL accepts `isReviewed` as a filter field, does not return it on a
    // transaction, and exposes no endpoint that SETS it. A sweep can skip what a
    // human already ticked off; it cannot tick anything off.
    const { bill, call } = build();
    await call("list_transactions", { is_reviewed: false });
    expect(bill.calls.at(-1)!.query.filters).toBe("isReviewed:eq:false");
  });

  it("never builds a term BILL's grammar cannot parse", async () => {
    // THE CANARY FOR THE WHOLE BUG CLASS. A filter term is positional, split on
    // `:` and `,`, with no escape — so a value carrying either character is not
    // a filter that matches something else, it is a request BILL rejects. This
    // asserts the shape of every term the tool can emit, so a filter added later
    // with an unsanitised value fails here rather than in a sweep.
    const { bill, call } = build();
    await call("list_transactions", {
      occurred_after: "2026-05-01T00:00:00Z",
      occurred_before: "2026-08-31T23:59:59Z",
      updated_after: "2026-09-01T00:00:00Z",
      updated_before: "2026-09-30T00:00:00Z",
      is_locked: false,
      is_reviewed: false,
      merchant_name: "Comcast",
      transaction_type: "CLEAR",
    });
    const terms = (bill.calls.at(-1)!.query.filters as string).split(",");
    expect(terms).toHaveLength(8);
    for (const term of terms) {
      expect(term).toMatch(/^[A-Za-z]+:(eq|gte|lte):[^,:]+$/);
    }
  });

  it("refuses a date it cannot parse instead of sending a filter BILL ignores", async () => {
    // The dangerous failure is the one that does NOT error: an unparseable
    // filter dropped by BILL turns "since yesterday" into "everything".
    const { bill, call } = build();
    const result = await call("list_transactions", { updated_after: "yesterday" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("ISO-8601");
    expect(bill.calls).toEqual([]);
  });

  it("refuses a merchant name containing the filter separator", async () => {
    const { call } = build();
    const result = await call("list_transactions", {
      merchant_name: "Acme, Inc",
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("comma");
  });

  it("refuses a merchant name containing a colon, which breaks the same grammar", async () => {
    // The date bug in its other costume: BILL answers `merchantName:eq:Foo: Bar`
    // with the same 422 it answers an ISO instant with.
    const { bill, call } = build();
    const result = await call("list_transactions", {
      merchant_name: "Foo: The Store",
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("colon");
    expect(bill.calls).toEqual([]);
  });

  it("refuses an unknown transaction type rather than widening the read", async () => {
    const { call } = build();
    const result = await call("list_transactions", {
      transaction_type: "SETTLED",
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("CLEAR");
  });

  it("clamps a limit above BILL's own cap rather than earning a 400", async () => {
    const { bill, call } = build();
    await call("list_transactions", { limit: 500 });
    expect(Number(bill.calls.at(-1)!.query.max)).toBe(50);
  });

  it("surfaces is_locked and the current coding, which is what a sweep reads", async () => {
    const { call } = build();
    const result = await call("list_transactions", {});
    const rows = result.json!.transactions as Array<Record<string, unknown>>;
    const locked = rows.find((r) => r.uuid === "txn_locked_0002")!;
    expect(locked.is_locked).toBe(true);
    const open = rows.find((r) => r.uuid === "txn_open_0001")!;
    const fields = open.custom_fields as Array<Record<string, unknown>>;
    const gl = fields.find((f) => f.name === "GL Account")!;
    expect(gl.selected_values).toEqual([
      { uuid: "tvl_0901", value: "Internet/Phone" },
    ]);
    // uuid ONLY here — the base64 id is not in this endpoint's payload, and
    // pretending otherwise is how a caller writes the form that gets dropped.
    expect(JSON.stringify(gl)).not.toContain("Y3VzdG9t");
  });
});

describe("get_transaction_coding", () => {
  it("returns both identifier forms and whether a write is even possible", async () => {
    const { call } = build();
    const result = await call("get_transaction_coding", {
      transaction_id: "txn_open_0001",
    });
    expect(result.json!.writable).toBe(true);
    expect(result.json!.is_locked).toBe(false);
    const fields = result.json!.fields as Array<Record<string, unknown>>;
    const gl = fields.find((f) => f.name === "GL Account")!;
    expect(gl.id).toBe("Y3VzdG9tZmllbGQ6MTAx");
    expect(gl.uuid).toBe("tty_gl_0001");
    expect(gl.selected_values).toEqual([
      {
        id: "Y3VzdG9tZmllbGR2YWx1ZTo5MDE",
        uuid: "tvl_0901",
        value: "Internet/Phone",
      },
    ]);
  });

  it("says writable: false for a locked transaction", async () => {
    const { call } = build();
    const result = await call("get_transaction_coding", {
      transaction_id: "txn_locked_0002",
    });
    expect(result.json!.writable).toBe(false);
    expect(result.json!.is_locked).toBe(true);
  });
});

describe("set_transaction_coding as a caller sees it", () => {
  it("reports the shape that persisted, so which one works stops being folklore", async () => {
    const { call } = build({ acceptsVariant: "customFieldId/uuid" });
    const result = await call("set_transaction_coding", {
      transaction_id: "txn_open_0001",
      field: "tty_gl_0001",
      value_ids: ["Y3VzdG9tZmllbGR2YWx1ZTo5MDI"],
    });
    expect(result.isError).toBe(false);
    expect(result.json!.verified).toBe(true);
    expect(result.json!.wire_variant).toBe("customFieldId/uuid");
  });

  it("returns the attempt table as STRUCTURE when nothing persisted", async () => {
    // Flattening this into a sentence would throw away the only evidence anyone
    // has about which body shape BILL honours.
    const { call } = build({ acceptsVariant: null });
    const result = await call("set_transaction_coding", {
      transaction_id: "txn_open_0001",
      field: "tty_gl_0001",
      value_ids: ["Y3VzdG9tZmllbGR2YWx1ZTo5MDI"],
    });
    expect(result.isError).toBe(true);
    expect(result.json!.persisted).toBe(false);
    const attempts = result.json!.attempts as Array<Record<string, unknown>>;
    expect(attempts).toHaveLength(WIRE_VARIANTS.length);
    expect(attempts[0]!.reportedStatus).toBe("SUCCESS");
    expect(attempts[0]!.persisted).toBe(false);
  });

  it("marks a locked transaction as not retryable", async () => {
    const { call } = build();
    const result = await call("set_transaction_coding", {
      transaction_id: "txn_locked_0002",
      field: "tty_gl_0001",
      value_ids: ["Y3VzdG9tZmllbGR2YWx1ZTo5MDI"],
    });
    expect(result.isError).toBe(true);
    expect(result.json!.retryable).toBe(false);
    expect(result.json!.is_locked).toBe(true);
    expect(result.json!.persisted).toBe(false);
  });

  it("refuses value_ids that is not an array, and names the clear-it form", async () => {
    const { bill, call } = build();
    const result = await call("set_transaction_coding", {
      transaction_id: "txn_open_0001",
      field: "tty_gl_0001",
      value_ids: "Y3VzdG9tZmllbGR2YWx1ZTo5MDI",
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("array");
    expect(result.text).toContain("[]");
    expect(bill.writes).toEqual([]);
  });
});

describe("the tool definitions themselves", () => {
  it("names every tool in snake_case, verb-first, without a server prefix", () => {
    const { tools } = build();
    for (const tool of tools) {
      expect(tool.name).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(tool.name.length).toBeLessThan(25);
      // The client already prefixes with the server name; `bill_` here would be
      // `bill-spend__bill_list_...` to a caller.
      expect(tool.name.startsWith("bill")).toBe(false);
    }
  });

  it("closes every input schema, so a mistyped argument is refused not ignored", () => {
    const { tools } = build();
    for (const tool of tools) {
      expect(tool.inputSchema.additionalProperties, tool.name).toBe(false);
    }
  });

  it("marks exactly one tool as not read-only", () => {
    const { tools } = build();
    const writers = tools.filter((t) => t.annotations?.readOnlyHint === false);
    expect(writers.map((t) => t.name)).toEqual(["set_transaction_coding"]);
  });

  it("tells every description reader where the value ids come from", () => {
    const { tool } = build();
    // The id-vs-uuid trap is a contract, not a footnote: the two tools that can
    // walk into it both say so.
    expect(tool("list_coding_options").description).toContain(
      "set_transaction_coding takes value IDS from here",
    );
    expect(tool("set_transaction_coding").description).toContain(
      "list_coding_options",
    );
    expect(tool("set_transaction_coding").description).toContain("verified");
  });
});
