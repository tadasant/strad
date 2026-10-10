import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";

import {
  createMCPServer,
  missingCredentials,
  parseToolGroups,
  toolNames,
  type ToolGroup,
} from "../src/index.js";
import { DESCRIPTION_BUDGET } from "../src/tools/shared.js";
import { airtable, fakeFetch, TOKEN, type Route } from "./fake-airtable.js";

/**
 * The server as an agent meets it: a real MCP client over an in-memory
 * transport, against a fake Airtable.
 */

const READS = [
  "list_records",
  "search_records",
  "list_bases",
  "list_tables",
  "describe_table",
  "get_record",
  "list_comments",
];
const ALL = [
  ...READS,
  "create_record",
  "update_records",
  "delete_records",
  "create_table",
  "update_table",
  "create_field",
  "update_field",
  "create_comment",
  "upload_attachment",
];

async function connect(
  opts: {
    env?: NodeJS.ProcessEnv;
    toolGroups?: ToolGroup[];
    route?: Route;
  } = {},
) {
  const fake = fakeFetch(opts.route ?? airtable);
  const { server, registerHandlers } = createMCPServer({
    version: "0.0.0-test",
    env: opts.env ?? { AIRTABLE_API_KEY: TOKEN },
    fetch: fake.fetch,
    ...(opts.toolGroups ? { toolGroups: opts.toolGroups } : {}),
  });
  await registerHandlers(server);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await client.callTool({ name, arguments: args })) as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    const text = result.content[0]!.text;
    let json: Record<string, unknown> | undefined;
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      json = undefined;
    }
    return { isError: result.isError === true, text, json };
  };
  return { client, call, calls: fake.calls };
}

const B = "appBase0000000001";
const T = "tblTasks000000001";
const R = "recOne00000000001";

/** One well-formed call per tool. */
const HAPPY: Record<string, Record<string, unknown>> = {
  list_bases: {},
  list_tables: { baseId: B, detailLevel: "identifiersOnly" },
  describe_table: { baseId: B, tableId: "Tasks" },
  list_records: { baseId: B, tableId: T, maxRecords: 5 },
  search_records: { baseId: B, tableId: T, searchTerm: "Launch" },
  get_record: { baseId: B, tableId: T, recordId: R },
  list_comments: { baseId: B, tableId: T, recordId: R },
  create_record: { baseId: B, tableId: T, fields: { Name: "Ship" } },
  update_records: {
    baseId: B,
    tableId: T,
    records: [{ id: R, fields: { Name: "Shipped" } }],
  },
  delete_records: { baseId: B, tableId: T, recordIds: [R] },
  create_table: {
    baseId: B,
    name: "Vendors",
    fields: [{ name: "Name", type: "singleLineText" }],
  },
  update_table: { baseId: B, tableId: T, name: "Todo" },
  create_field: {
    baseId: B,
    tableId: T,
    nested: { field: { name: "Due", type: "date" } },
  },
  update_field: {
    baseId: B,
    tableId: T,
    fieldId: "fldName0000000001",
    description: "The title",
  },
  create_comment: { baseId: B, tableId: T, recordId: R, text: "Looks good" },
  upload_attachment: {
    baseId: B,
    recordId: R,
    attachmentFieldIdOrName: "Files",
    file: "data:text/plain;base64,aGVsbG8=",
    filename: "a.txt",
    contentType: "text/plain",
  },
};

describe("tools/list", () => {
  it("serves all sixteen by default, and exactly the reads under readonly", async () => {
    const all = await connect();
    expect(
      (await all.client.listTools()).tools.map((t) => t.name).sort(),
    ).toEqual([...ALL].sort());
    const ro = await connect({ toolGroups: ["readonly"] });
    expect(
      (await ro.client.listTools()).tools.map((t) => t.name).sort(),
    ).toEqual([...READS].sort());
    expect(toolNames(["readonly"]).sort()).toEqual([...READS].sort());
    expect(toolNames(["readwrite"]).sort()).toEqual([...ALL].sort());
  });

  it("reads ENABLED_TOOLGROUPS, failing closed to readonly on a typo", async () => {
    expect(parseToolGroups(undefined)).toEqual(["readonly", "readwrite"]);
    expect(parseToolGroups("readwrite")).toEqual(["readwrite"]);
    expect(parseToolGroups("read-write")).toEqual(["readonly"]);
    const typo = await connect({
      env: { AIRTABLE_API_KEY: TOKEN, ENABLED_TOOLGROUPS: "rw" },
    });
    expect(
      (await typo.client.listTools()).tools.map((t) => t.name).sort(),
    ).toEqual([...READS].sort());
  });

  it("annotates every tool fully, and keeps descriptions inside the budget", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    for (const t of tools) {
      expect(t.description!.length, t.name).toBeLessThanOrEqual(
        DESCRIPTION_BUDGET,
      );
      expect(t.annotations, t.name).toMatchObject({ openWorldHint: true });
      for (const key of [
        "readOnlyHint",
        "destructiveHint",
        "idempotentHint",
      ] as const) {
        expect(typeof t.annotations![key], `${t.name}.${key}`).toBe("boolean");
      }
      expect(t.annotations!.readOnlyHint, t.name).toBe(READS.includes(t.name));
    }
    const destructive = tools
      .filter((t) => t.annotations!.destructiveHint)
      .map((t) => t.name)
      .sort();
    expect(destructive).toEqual([
      "delete_records",
      "update_field",
      "update_records",
      "update_table",
    ]);
  });
});

describe("a happy call for every tool", () => {
  for (const name of ALL) {
    it(name, async () => {
      const { call, calls } = await connect();
      const result = await call(name, HAPPY[name]!);
      expect(result.isError, result.text).toBe(false);
      expect(result.json).toBeDefined();
      expect(calls.length).toBeGreaterThan(0);
      if (READS.includes(name)) {
        // A read is a GET — or, for the two record lists, the POST
        // …/listRecords form a long formula takes, which is still a read.
        const lists = name === "list_records" || name === "search_records";
        expect(
          calls.every(
            (c) =>
              c.method === "GET" ||
              (lists &&
                c.method === "POST" &&
                c.url.pathname.endsWith("/listRecords")),
          ),
        ).toBe(true);
      }
    });
  }

  it("list_records reports whether more remain", async () => {
    const { call } = await connect({
      route: () => ({
        body: { records: [{ id: "recA", fields: {} }], offset: "itrMore" },
      }),
    });
    const r = await call("list_records", {
      baseId: B,
      tableId: T,
      maxRecords: 1,
    });
    expect(r.json).toEqual({
      records: [{ id: "recA", fields: {} }],
      returned: 1,
      more: true,
      offset: "itrMore",
    });
  });

  it("list_records returns what it has when page 2 is rate-limited", async () => {
    const { call, calls } = await connect({
      route: (c) =>
        c.url.searchParams.get("offset")
          ? { status: 429, headers: { "retry-after": "9" } }
          : {
              body: {
                records: [
                  {
                    id: "recA",
                    createdTime: "2026-10-01T00:00:00.000Z",
                    fields: {},
                  },
                ],
                offset: "itrSecond",
              },
            },
    });
    const r = await call("list_records", {
      baseId: B,
      tableId: T,
      maxRecords: 200,
    });
    expect(calls).toHaveLength(2);
    expect(r.isError).toBe(false);
    expect(r.json).toEqual({
      records: [
        { id: "recA", createdTime: "2026-10-01T00:00:00.000Z", fields: {} },
      ],
      returned: 1,
      more: true,
      offset: "itrSecond",
      stopped_early: "rate_limited",
      retry_after_seconds: 9,
    });
  });

  it("search_records returns what it has when page 2 is lost in transit", async () => {
    let records = 0;
    const route: Route = (c) => {
      if (c.url.pathname.startsWith("/v0/meta/")) return airtable(c);
      records += 1;
      if (records === 2) throw new Error("ECONNRESET");
      return {
        body: { records: [{ id: "recA", fields: {} }], offset: "itrSecond" },
      };
    };
    const { call } = await connect({ route });
    const r = await call("search_records", {
      baseId: B,
      tableId: T,
      searchTerm: "x",
      maxRecords: 200,
    });
    expect(r.isError).toBe(false);
    expect(r.json).toMatchObject({
      returned: 1,
      more: true,
      offset: "itrSecond",
      stopped_early: "transport_error",
    });
    expect(r.json!.retry_after_seconds).toBeUndefined();
  });

  it("list_records still errors when the first page is rate-limited", async () => {
    const { call } = await connect({ route: () => ({ status: 429 }) });
    const r = await call("list_records", {
      baseId: B,
      tableId: T,
      maxRecords: 200,
    });
    expect(r.isError).toBe(true);
    expect(r.json).toMatchObject({
      error: "RateLimitError",
      retry_after_seconds: 30,
    });
  });

  it("list_records sends a long formula as POST …/listRecords", async () => {
    const { call, calls } = await connect();
    const formula = `OR(${Array.from({ length: 800 }, (_, i) => `{Name} = 'v${i}'`).join(",")})`;
    const r = await call("list_records", {
      baseId: B,
      tableId: T,
      filterByFormula: formula,
    });
    expect(r.isError, r.text).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url.pathname).toBe(`/v0/${B}/${T}/listRecords`);
    expect(calls[0]!.body).toMatchObject({
      filterByFormula: formula,
      pageSize: 100,
    });
  });

  it("create_field takes a table NAME", async () => {
    const { call, calls } = await connect();
    const r = await call("create_field", {
      baseId: B,
      tableId: "Tasks",
      nested: { field: { name: "Due", type: "date" } },
    });
    expect(r.isError, r.text).toBe(false);
    expect(calls.at(-1)!.url.pathname).toBe(
      `/v0/meta/bases/${B}/tables/${T}/fields`,
    );
  });

  it("update_field takes a table NAME and a field NAME", async () => {
    const { call, calls } = await connect();
    const r = await call("update_field", {
      baseId: B,
      tableId: "Tasks",
      fieldId: "Notes",
      name: "Details",
    });
    expect(r.isError, r.text).toBe(false);
    expect(r.json).toMatchObject({
      field: { id: "fldNotes000000001", name: "Details" },
    });
    expect(calls.at(-1)!.url.pathname).toBe(
      `/v0/meta/bases/${B}/tables/${T}/fields/fldNotes000000001`,
    );
  });

  it("search_records and create_comment keep the caller's spaces", async () => {
    const { call, calls } = await connect();
    await call("search_records", {
      baseId: B,
      tableId: T,
      searchTerm: " Launch ",
    });
    expect(calls.at(-1)!.url.searchParams.get("filterByFormula")).toContain(
      'FIND(" Launch ", ',
    );
    await call("create_comment", {
      baseId: B,
      tableId: T,
      recordId: R,
      text: "  indented\n",
    });
    expect(calls.at(-1)!.body).toEqual({ text: "  indented\n" });
  });

  it("records carry createdTime", async () => {
    const { call } = await connect();
    const r = await call("get_record", { baseId: B, tableId: T, recordId: R });
    expect(r.json).toMatchObject({
      id: R,
      createdTime: "2026-10-01T00:00:00.000Z",
    });
  });

  it("list_records clamps maxRecords at 1000", async () => {
    let pages = 0;
    const { call, calls } = await connect({
      route: () => {
        pages += 1;
        return {
          body: {
            records: Array.from({ length: 100 }, (_, i) => ({
              id: `rec${pages}-${i}`,
              fields: {},
            })),
            offset: `itr${pages}`,
          },
        };
      },
    });
    const r = await call("list_records", {
      baseId: B,
      tableId: T,
      maxRecords: 50000,
    });
    expect(calls).toHaveLength(10);
    expect(r.json!.returned).toBe(1000);
    expect(r.json!.more).toBe(true);
  });

  it("list_tables honours detailLevel", async () => {
    const { call } = await connect();
    const r = await call("list_tables", {
      baseId: B,
      detailLevel: "tableIdentifiersOnly",
    });
    expect(r.json).toEqual({ tables: [{ id: T, name: "Tasks" }] });
  });

  it("upload_attachment strips a data: prefix", async () => {
    const { call, calls } = await connect();
    await call("upload_attachment", HAPPY.upload_attachment!);
    expect((calls[0]!.body as { file: string }).file).toBe("aGVsbG8=");
  });

  it("upload_attachment normalises base64url to standard, padded base64", async () => {
    const { call, calls } = await connect();
    const bytes = Buffer.from([0xfb, 0xff, 0xbf, 0xfe]);
    const url = bytes.toString("base64url");
    expect(url).toMatch(/[-_]/);
    expect(url).not.toContain("=");
    const r = await call("upload_attachment", {
      ...HAPPY.upload_attachment,
      file: url,
    });
    expect(r.isError, r.text).toBe(false);
    const sent = (calls[0]!.body as { file: string }).file;
    expect(sent).toBe(bytes.toString("base64"));
    expect(Buffer.from(sent, "base64")).toEqual(bytes);
  });
});

describe("no credential", () => {
  it("lists tools, and fails a call naming the variable without touching the network", async () => {
    expect(missingCredentials({})).toEqual(["AIRTABLE_API_KEY"]);
    expect(missingCredentials({ AIRTABLE_API_KEY: "  " })).toEqual([
      "AIRTABLE_API_KEY",
    ]);
    expect(missingCredentials({ AIRTABLE_API_KEY: TOKEN })).toEqual([]);
    const { client, call, calls } = await connect({ env: {} });
    expect((await client.listTools()).tools).toHaveLength(16);
    const r = await call("list_bases");
    expect(r.isError).toBe(true);
    expect(r.text).toContain("AIRTABLE_API_KEY");
    expect(r.text).toContain("https://airtable.com/create/tokens");
    expect(r.text).toContain("schema.bases:read");
    expect(calls).toHaveLength(0);
  });
});

describe("the token never reaches a caller", () => {
  it("not from an error body that echoes it", async () => {
    const { call } = await connect({
      route: () => ({
        status: 401,
        body: {
          error: {
            type: "AUTHENTICATION_REQUIRED",
            message: `token ${TOKEN} rejected`,
          },
        },
      }),
    });
    for (const name of ALL) {
      const r = await call(name, HAPPY[name]!);
      expect(r.isError, name).toBe(true);
      expect(r.text, name).not.toContain(TOKEN);
      expect(r.text, name).not.toContain(TOKEN.slice(18));
    }
  });

  it("not from a successful record that holds it", async () => {
    const { call } = await connect({
      route: () => ({ body: { id: R, fields: { Secret: TOKEN } } }),
    });
    const r = await call("get_record", { baseId: B, tableId: T, recordId: R });
    expect(r.isError).toBe(false);
    expect(r.text).not.toContain(TOKEN);
  });

  it("a 429 is a structured, retryable failure", async () => {
    const { call } = await connect({ route: () => ({ status: 429 }) });
    const r = await call("list_bases");
    expect(r.isError).toBe(true);
    expect(r.json).toMatchObject({
      error: "RateLimitError",
      retryable: true,
      retry_after_seconds: 30,
    });
  });
});

describe("input validation", () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["list_records", { tableId: T }, "baseId"],
    ["list_records", { baseId: B, tableId: T, maxRecords: 0 }, "maxRecords"],
    [
      "list_records",
      { baseId: B, tableId: T, sort: [{ field: "x", direction: "up" }] },
      "direction",
    ],
    ["list_tables", { baseId: B, detailLevel: "everything" }, "detailLevel"],
    ["create_record", { baseId: B, tableId: T, fields: "Name=Ship" }, "fields"],
    [
      "update_records",
      {
        baseId: B,
        tableId: T,
        records: Array.from({ length: 11 }, (_, i) => ({
          id: `rec${i}`,
          fields: {},
        })),
      },
      "at most 10",
    ],
    ["delete_records", { baseId: B, tableId: T, recordIds: [] }, "recordIds"],
    [
      "search_records",
      { baseId: B, tableId: T, searchTerm: "   " },
      "searchTerm",
    ],
    [
      "create_comment",
      { baseId: B, tableId: T, recordId: R, text: " \n " },
      "text",
    ],
    ["update_table", { baseId: B, tableId: T }, "nothing to change"],
    ["create_field", { baseId: B, tableId: T, field: { name: "x" } }, "nested"],
    [
      "upload_attachment",
      { ...HAPPY.upload_attachment, file: "not base64!" },
      "base64",
    ],
    [
      "upload_attachment",
      {
        ...HAPPY.upload_attachment,
        file: Buffer.alloc(5 * 1024 * 1024 + 1).toString("base64"),
      },
      "5 MB",
    ],
  ];
  for (const [name, input, needle] of cases) {
    it(`${name} refuses ${needle}`, async () => {
      const { call, calls } = await connect();
      const r = await call(name, input);
      expect(r.isError).toBe(true);
      expect(r.text).toContain(needle);
      expect(calls).toHaveLength(0);
    });
  }
});
