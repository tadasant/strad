import { describe, expect, it } from "vitest";

import { createGateway, type BillGateway } from "../src/gateway.js";
import { toolDefinitions } from "../src/tools.js";
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
      "updatedTime:gte:2026-09-01T00:00:00.000Z,isLocked:eq:false,transactionType:eq:CLEAR",
    );
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
    const { call } = build({ acceptsVariant: "customFieldUuid/uuid" });
    const result = await call("set_transaction_coding", {
      transaction_id: "txn_open_0001",
      field: "tty_gl_0001",
      value_ids: ["Y3VzdG9tZmllbGR2YWx1ZTo5MDI"],
    });
    expect(result.isError).toBe(false);
    expect(result.json!.verified).toBe(true);
    expect(result.json!.wire_variant).toBe("customFieldUuid/uuid");
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
    expect(attempts).toHaveLength(3);
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
