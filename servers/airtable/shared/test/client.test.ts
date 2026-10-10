import { describe, expect, it } from "vitest";

import {
  buildSearchFormula,
  createClient,
  MAX_GET_URL_LENGTH,
} from "../src/client.js";
import {
  AirtableApiError,
  InputError,
  RateLimitError,
  TransportError,
} from "../src/errors.js";
import {
  airtable,
  fakeFetch,
  TABLE,
  TOKEN,
  type Route,
} from "./fake-airtable.js";

function client(
  route: Route = airtable,
  extra: { timeoutMs?: number; apiKey?: string } = {},
) {
  const fake = fakeFetch(route);
  return {
    ...fake,
    at: createClient({
      apiKey: extra.apiKey ?? TOKEN,
      fetch: fake.fetch,
      ...(extra.timeoutMs ? { timeoutMs: extra.timeoutMs } : {}),
    }),
  };
}

async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected a rejection");
}

describe("requests", () => {
  it("authenticates with a bearer token and asks for JSON", async () => {
    const { at, calls } = client();
    await at.listBases("itrNext");
    expect(calls[0]!.url.toString()).toBe(
      "https://api.airtable.com/v0/meta/bases?offset=itrNext",
    );
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]!.headers.accept).toBe("application/json");
    expect(calls[0]!.headers["content-type"]).toBeUndefined();
  });

  it("encodes a table NAME into the path", async () => {
    const { at, calls } = client(() => ({ body: { records: [] } }));
    await at.listRecords("appBase0000000001", "Q3 / Plans", { maxRecords: 5 });
    expect(calls[0]!.url.pathname).toBe(
      "/v0/appBase0000000001/Q3%20%2F%20Plans",
    );
  });

  it("sends view, formula, sort and fields, and sizes the page instead of sending maxRecords", async () => {
    const { at, calls } = client(() => ({ body: { records: [] } }));
    await at.listRecords("appBase0000000001", "tblTasks000000001", {
      maxRecords: 20,
      view: "Grid view",
      filterByFormula: "{Status} = 'Done'",
      sort: [{ field: "Due", direction: "desc" }, { field: "Name" }],
      fields: ["Name", "Due"],
    });
    const q = calls[0]!.url.searchParams;
    expect(q.get("pageSize")).toBe("20");
    expect(q.get("maxRecords")).toBeNull();
    expect(q.get("view")).toBe("Grid view");
    expect(q.get("filterByFormula")).toBe("{Status} = 'Done'");
    expect(q.get("sort[0][field]")).toBe("Due");
    expect(q.get("sort[0][direction]")).toBe("desc");
    expect(q.get("sort[1][field]")).toBe("Name");
    expect(q.get("sort[1][direction]")).toBeNull();
    expect(q.getAll("fields[]")).toEqual(["Name", "Due"]);
  });

  it("walks pages only up to maxRecords and hands back the cursor", async () => {
    const page = (n: number, from: number) =>
      Array.from({ length: n }, (_, i) => ({
        id: `rec${from + i}`,
        fields: {},
      }));
    const { at, calls } = client((call) => {
      const size = Number(call.url.searchParams.get("pageSize"));
      const offset = call.url.searchParams.get("offset");
      return {
        body: {
          records: page(size, offset ? 100 : 0),
          offset: offset ? "itrThird" : "itrSecond",
        },
      };
    });
    const result = await at.listRecords(
      "appBase0000000001",
      "tblTasks000000001",
      { maxRecords: 150 },
    );
    expect(calls.map((c) => c.url.searchParams.get("pageSize"))).toEqual([
      "100",
      "50",
    ]);
    expect(calls[1]!.url.searchParams.get("offset")).toBe("itrSecond");
    expect(result.records).toHaveLength(150);
    expect(result.offset).toBe("itrThird");
  });

  it("stops on the last page with no cursor", async () => {
    const { at, calls } = client(() => ({
      body: { records: [{ id: "recA", fields: {} }] },
    }));
    const result = await at.listRecords(
      "appBase0000000001",
      "tblTasks000000001",
      { maxRecords: 500, offset: "itrResume" },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.searchParams.get("offset")).toBe("itrResume");
    expect(result.offset).toBeUndefined();
  });

  it("writes with typecast", async () => {
    const { at, calls } = client();
    await at.createRecord("appBase0000000001", "tblTasks000000001", {
      Name: "Ship",
    });
    await at.updateRecords("appBase0000000001", "tblTasks000000001", [
      { id: "recA", fields: { Name: "x" } },
    ]);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.body).toEqual({
      fields: { Name: "Ship" },
      typecast: true,
    });
    expect(calls[0]!.headers["content-type"]).toBe("application/json");
    expect(calls[1]!.method).toBe("PATCH");
    expect(calls[1]!.body).toEqual({
      records: [{ id: "recA", fields: { Name: "x" } }],
      typecast: true,
    });
  });

  it("deletes by records[] in the query", async () => {
    const { at, calls } = client();
    const out = await at.deleteRecords(
      "appBase0000000001",
      "tblTasks000000001",
      ["recA", "recB"],
    );
    expect(calls[0]!.method).toBe("DELETE");
    expect(calls[0]!.url.searchParams.getAll("records[]")).toEqual([
      "recA",
      "recB",
    ]);
    expect(out).toEqual([{ id: "recA" }, { id: "recB" }]);
  });

  it("uploads attachments to the content host", async () => {
    const { at, calls } = client();
    await at.uploadAttachment(
      "appBase0000000001",
      "recOne00000000001",
      "My Files",
      "aGk=",
      "a.txt",
      "text/plain",
    );
    expect(calls[0]!.url.toString()).toBe(
      "https://content.airtable.com/v0/appBase0000000001/recOne00000000001/My%20Files/uploadAttachment",
    );
    expect(calls[0]!.body).toEqual({
      contentType: "text/plain",
      file: "aGk=",
      filename: "a.txt",
    });
  });
});

describe("search", () => {
  it("escapes the two characters that can break out of the string literal", () => {
    expect(buildSearchFormula('a"b\\c', ["fld1", "fld2"])).toBe(
      'OR(FIND("a\\"b\\\\c", {fld1}),FIND("a\\"b\\\\c", {fld2}))',
    );
  });

  it("searches every text field by default and accepts field names", async () => {
    const { at, calls } = client();
    const all = await at.searchRecords(
      "appBase0000000001",
      "Tasks",
      "x",
      undefined,
      { maxRecords: 10 },
    );
    expect(all.searchedFieldIds).toEqual([
      "fldName0000000001",
      "fldNotes000000001",
    ]);
    // The table was NAMED; the record read uses its ID.
    expect(calls[1]!.url.pathname).toBe(`/v0/appBase0000000001/${TABLE.id}`);
    const named = await at.searchRecords(
      "appBase0000000001",
      TABLE.id,
      "x",
      ["Notes"],
      { maxRecords: 10 },
    );
    expect(named.searchedFieldIds).toEqual(["fldNotes000000001"]);
  });

  it("refuses a non-text field before searching", async () => {
    const { at, calls } = client();
    const err = await rejection(
      at.searchRecords("appBase0000000001", TABLE.id, "x", ["Count"], {
        maxRecords: 10,
      }),
    );
    expect(err).toBeInstanceOf(InputError);
    expect(err.message).toContain("Count");
    expect(calls).toHaveLength(1);
  });
});

describe("errors", () => {
  it("makes a 429 a retryable RateLimitError that honours Retry-After", async () => {
    const { at } = client(() => ({
      status: 429,
      body: { errors: [] },
      headers: { "retry-after": "7" },
    }));
    const err = await rejection(at.getRecord("appBase0000000001", "t", "recA"));
    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as RateLimitError).retryAfterSeconds).toBe(7);
    expect((err as RateLimitError).retryable).toBe(true);
    expect(err.message).toContain("5 requests per second per base");
  });

  it("defaults the 429 wait to Airtable's 30 second penalty", async () => {
    const { at } = client(() => ({ status: 429 }));
    const err = (await rejection(at.listBases())) as RateLimitError;
    expect(err.retryAfterSeconds).toBe(30);
  });

  it("names the scope a 403 needed", async () => {
    const { at } = client(() => ({
      status: 403,
      body: {
        error: {
          type: "INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND",
          message: "Invalid permissions",
        },
      },
    }));
    const err = (await rejection(
      at.createComment("appX", "t", "recA", "hi"),
    )) as AirtableApiError;
    expect(err.status).toBe(403);
    expect(err.type).toBe("INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND");
    expect(err.retryable).toBe(false);
    expect(err.message).toContain("data.recordComments:write");
    expect(err.message).toContain("granted access to this base");
  });

  it("recognises a legacy API key on a 401", async () => {
    const { at } = client(
      () => ({
        status: 401,
        body: { error: { type: "AUTHENTICATION_REQUIRED", message: "x" } },
      }),
      {
        apiKey: "keyAbCdEfGhIjKlMn",
      },
    );
    const err = await rejection(at.listBases());
    expect(err.message).toContain("legacy Airtable API key");
    expect(err.message).toContain("Retrying will not help");
  });

  it("marks a 5xx retryable", async () => {
    const { at } = client(() => ({
      status: 503,
      text: "<html>upstream down</html>",
    }));
    const err = (await rejection(at.listBases())) as AirtableApiError;
    expect(err.retryable).toBe(true);
    expect(err.message).toContain("HTTP 503");
  });

  it("caps an upstream body rather than dumping it", async () => {
    const { at } = client(() => ({ status: 500, text: "x ".repeat(5000) }));
    const err = await rejection(at.listBases());
    expect(err.message.length).toBeLessThan(600);
  });

  it("never quotes the token back, even when Airtable echoes it", async () => {
    const { at } = client(() => ({
      status: 422,
      body: {
        error: {
          type: "INVALID_REQUEST_UNKNOWN",
          message: `bad header ${TOKEN}`,
        },
      },
    }));
    const err = await rejection(at.listBases());
    expect(err.message).not.toContain(TOKEN);
    expect(err.message).toContain("[redacted]");
  });

  it("gives up after the timeout with a retryable error", async () => {
    const hang: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new Error("aborted")),
        );
      });
    const at = createClient({ apiKey: TOKEN, fetch: hang, timeoutMs: 20 });
    const err = (await rejection(at.listBases())) as TransportError;
    expect(err).toBeInstanceOf(TransportError);
    expect(err.retryable).toBe(true);
    expect(err.message).toContain("did not answer");
  });
});

describe("field endpoints take IDs only", () => {
  it("create_field resolves a table NAME to its ID first", async () => {
    const { at, calls } = client();
    const out = await at.createField("appBase0000000001", "Tasks", {
      name: "Due",
      type: "date",
    });
    expect(out).toMatchObject({ id: "fldNew00000000001", name: "Due" });
    expect(calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual([
      "GET /v0/meta/bases/appBase0000000001/tables",
      `POST /v0/meta/bases/appBase0000000001/tables/${TABLE.id}/fields`,
    ]);
  });

  it("create_field with a table ID spends no schema read", async () => {
    const { at, calls } = client();
    await at.createField("appBase0000000001", TABLE.id, {
      name: "Due",
      type: "date",
    });
    expect(calls).toHaveLength(1);
  });

  it("update_field resolves a table name and a field name to IDs", async () => {
    const { at, calls } = client();
    const out = await at.updateField("appBase0000000001", "Tasks", "Notes", {
      name: "Details",
    });
    expect(out).toMatchObject({ id: "fldNotes000000001", name: "Details" });
    expect(calls[1]!.method).toBe("PATCH");
    expect(calls[1]!.url.pathname).toBe(
      `/v0/meta/bases/appBase0000000001/tables/${TABLE.id}/fields/fldNotes000000001`,
    );
  });

  it("update_field with a table ID and a field NAME still resolves the field", async () => {
    const { at, calls } = client();
    await at.updateField("appBase0000000001", TABLE.id, "Name", {
      description: "x",
    });
    expect(calls[1]!.url.pathname).toMatch(/\/fields\/fldName0000000001$/);
  });

  it("update_field with both IDs goes straight to the PATCH", async () => {
    const { at, calls } = client();
    await at.updateField("appBase0000000001", TABLE.id, "fldCount000000001", {
      name: "Total",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("PATCH");
  });

  it("update_field refuses a field the table does not have, listing the ones it does", async () => {
    const { at, calls } = client();
    const err = await rejection(
      at.updateField("appBase0000000001", "Tasks", "Nope", { name: "x" }),
    );
    expect(err).toBeInstanceOf(InputError);
    expect(err.message).toContain("Notes (fldNotes000000001)");
    expect(calls).toHaveLength(1);
  });
});

describe("a list that stops part-way", () => {
  const firstPage = {
    records: Array.from({ length: 100 }, (_, i) => ({
      id: `rec${i}`,
      fields: {},
    })),
    offset: "itrSecond",
  };

  it("keeps the records and the cursor when page 2 is rate-limited", async () => {
    const { at, calls } = client((call) =>
      call.url.searchParams.get("offset")
        ? { status: 429, headers: { "retry-after": "12" } }
        : { body: firstPage },
    );
    const result = await at.listRecords("appBase0000000001", TABLE.id, {
      maxRecords: 300,
    });
    expect(calls).toHaveLength(2);
    expect(result.records).toHaveLength(100);
    expect(result.offset).toBe("itrSecond");
    expect(result.stoppedEarly).toBe("rate_limited");
    expect(result.retryAfterSeconds).toBe(12);
  });

  it("keeps them when page 2 is lost in transit", async () => {
    const fake = fakeFetch(() => ({ body: firstPage }));
    let n = 0;
    const flaky: typeof fetch = async (input, init) => {
      n += 1;
      if (n === 2) throw new Error("socket hang up");
      return fake.fetch(input, init);
    };
    const at = createClient({ apiKey: TOKEN, fetch: flaky });
    const result = await at.listRecords("appBase0000000001", TABLE.id, {
      maxRecords: 300,
    });
    expect(result.records).toHaveLength(100);
    expect(result.offset).toBe("itrSecond");
    expect(result.stoppedEarly).toBe("transport_error");
    expect(result.retryAfterSeconds).toBeUndefined();
  });

  it("still fails when the FIRST page is rate-limited, resumed or not", async () => {
    const { at } = client(() => ({ status: 429 }));
    expect(
      await rejection(
        at.listRecords("appBase0000000001", TABLE.id, { maxRecords: 300 }),
      ),
    ).toBeInstanceOf(RateLimitError);
    expect(
      await rejection(
        at.listRecords("appBase0000000001", TABLE.id, {
          maxRecords: 300,
          offset: "itrResume",
        }),
      ),
    ).toBeInstanceOf(RateLimitError);
  });

  it("does not swallow a non-retryable failure on page 2", async () => {
    const { at } = client((call) =>
      call.url.searchParams.get("offset")
        ? { status: 403, body: { error: { type: "INVALID_PERMISSIONS" } } }
        : { body: firstPage },
    );
    expect(
      await rejection(
        at.listRecords("appBase0000000001", TABLE.id, { maxRecords: 300 }),
      ),
    ).toBeInstanceOf(AirtableApiError);
  });
});

describe("a formula too long for a URL", () => {
  const long = `OR(${Array.from({ length: 800 }, (_, i) => `{Name} = 'v${i}'`).join(",")})`;

  it("stays a GET while the URL fits", async () => {
    const { at, calls } = client();
    await at.listRecords("appBase0000000001", TABLE.id, {
      maxRecords: 5,
      filterByFormula: "{Name} = 'x'",
    });
    expect(calls[0]!.method).toBe("GET");
  });

  it("switches to POST …/listRecords with the parameters in the body", async () => {
    let n = 0;
    const { at, calls } = client(() => {
      n += 1;
      return {
        body: {
          records: [{ id: `rec${n}`, fields: {} }],
          ...(n === 1 ? { offset: "itrNext" } : {}),
        },
      };
    });
    const result = await at.listRecords("appBase0000000001", TABLE.id, {
      maxRecords: 150,
      view: "Grid view",
      filterByFormula: long,
      sort: [{ field: "Name", direction: "desc" }],
      fields: ["Name"],
    });
    expect(result.records.map((r) => r.id)).toEqual(["rec1", "rec2"]);
    expect(
      calls.map((c) => `${c.method} ${c.url.pathname}${c.url.search}`),
    ).toEqual([
      `POST /v0/appBase0000000001/${TABLE.id}/listRecords`,
      `POST /v0/appBase0000000001/${TABLE.id}/listRecords`,
    ]);
    expect(calls[0]!.body).toEqual({
      pageSize: 100,
      view: "Grid view",
      filterByFormula: long,
      sort: [{ field: "Name", direction: "desc" }],
      fields: ["Name"],
    });
    expect(calls[1]!.body).toMatchObject({
      pageSize: 100,
      offset: "itrNext",
      filterByFormula: long,
    });
  });

  it("switches at the threshold, not before", async () => {
    // A formula of exactly the length that would put the GET URL one past it.
    const { at, calls } = client(() => ({ body: { records: [] } }));
    const base = `https://api.airtable.com/v0/appBase0000000001/${TABLE.id}?pageSize=5&filterByFormula=`;
    const fits = "x".repeat(MAX_GET_URL_LENGTH - base.length);
    await at.listRecords("appBase0000000001", TABLE.id, {
      maxRecords: 5,
      filterByFormula: fits,
    });
    await at.listRecords("appBase0000000001", TABLE.id, {
      maxRecords: 5,
      filterByFormula: `${fits}x`,
    });
    expect(calls.map((c) => c.method)).toEqual(["GET", "POST"]);
  });

  it("search_records takes the same route for a long term over many fields", async () => {
    const { at, calls } = client();
    await at.searchRecords(
      "appBase0000000001",
      "Tasks",
      "y".repeat(8000),
      undefined,
      { maxRecords: 5 },
    );
    expect(calls[1]!.method).toBe("POST");
    expect(calls[1]!.url.pathname).toBe(
      `/v0/appBase0000000001/${TABLE.id}/listRecords`,
    );
  });
});

describe("records", () => {
  it("pass createdTime through", async () => {
    const { at } = client();
    const rec = await at.getRecord(
      "appBase0000000001",
      TABLE.id,
      "recOne00000000001",
    );
    expect(rec).toEqual({
      id: "recOne00000000001",
      createdTime: "2026-10-01T00:00:00.000Z",
      fields: { Name: "Launch" },
    });
    const page = await at.listRecords("appBase0000000001", TABLE.id, {
      maxRecords: 5,
    });
    expect(page.records[0]!.createdTime).toBe("2026-10-01T00:00:00.000Z");
  });
});

describe("an expired offset", () => {
  it("says to restart without it", async () => {
    const { at } = client(() => ({
      status: 422,
      body: {
        error: {
          type: "LIST_RECORDS_ITERATOR_NOT_AVAILABLE",
          message: "Iterator not available",
        },
      },
    }));
    const err = (await rejection(
      at.listRecords("appBase0000000001", TABLE.id, {
        maxRecords: 5,
        offset: "itrStale",
      }),
    )) as AirtableApiError;
    expect(err.status).toBe(422);
    expect(err.type).toBe("LIST_RECORDS_ITERATOR_NOT_AVAILABLE");
    expect(err.message).toContain("The offset expired");
    expect(err.message).toContain("no `offset`");
    expect(err.message).not.toContain("filterByFormula syntax");
  });
});
