/**
 * A fake `fetch` that records every request and answers from a router. It is
 * the only Airtable this suite has met — the shapes below are Airtable's
 * documented ones, not observed traffic.
 */

export interface Call {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

export interface Reply {
  status?: number;
  body?: unknown;
  /** Raw text, for a non-JSON body. */
  text?: string;
  headers?: Record<string, string>;
}

export type Route = (call: Call) => Reply | Promise<Reply>;

export function fakeFetch(route: Route) {
  const calls: Call[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const call: Call = {
      url,
      method: init?.method ?? "GET",
      headers,
      ...(typeof init?.body === "string"
        ? { body: JSON.parse(init.body) }
        : {}),
    };
    calls.push(call);
    const reply = await route(call);
    const text =
      reply.text ??
      (reply.body === undefined ? "" : JSON.stringify(reply.body));
    return new Response(text, {
      status: reply.status ?? 200,
      headers: reply.headers ?? {},
    });
  }) as typeof fetch;
  return { fetch: fn, calls };
}

export const TOKEN = `patAbCdEfGhIjKlMn.${"0123456789abcdef".repeat(4)}`;

export const TABLE = {
  id: "tblTasks000000001",
  name: "Tasks",
  primaryFieldId: "fldName0000000001",
  fields: [
    { id: "fldName0000000001", name: "Name", type: "singleLineText" },
    { id: "fldNotes000000001", name: "Notes", type: "multilineText" },
    {
      id: "fldCount000000001",
      name: "Count",
      type: "number",
      options: { precision: 0 },
    },
  ],
  views: [{ id: "viwGrid0000000001", name: "Grid view", type: "grid" }],
};

const RECORD = {
  id: "recOne00000000001",
  createdTime: "2026-10-01T00:00:00.000Z",
  fields: { Name: "Launch" },
};
const COMMENT = {
  id: "comOne00000000001",
  createdTime: "2026-10-01T00:00:00.000Z",
  lastUpdatedTime: null,
  text: "Looks good",
  author: { id: "usrAda00000000001", email: "ada@example.com", name: "Ada" },
};

/** Every endpoint the sixteen tools call, answered plausibly. */
export const airtable: Route = (call) => {
  const p = call.url.pathname;
  const m = call.method;
  if (call.url.host === "content.airtable.com") {
    return {
      body: {
        id: "recOne00000000001",
        createdTime: RECORD.createdTime,
        fields: {
          fldFiles000000001: [
            { id: "attX", url: "https://example.com/f", filename: "a.txt" },
          ],
        },
      },
    };
  }
  if (p === "/v0/meta/bases" && m === "GET") {
    return {
      body: {
        bases: [
          {
            id: "appBase0000000001",
            name: "Roadmap",
            permissionLevel: "create",
          },
        ],
      },
    };
  }
  if (p === "/v0/meta/bases/appBase0000000001/tables" && m === "GET")
    return { body: { tables: [TABLE] } };
  if (p === "/v0/meta/bases/appBase0000000001/tables" && m === "POST") {
    return {
      body: {
        id: "tblNew00000000001",
        name: (call.body as { name: string }).name,
        fields: [],
        views: [],
      },
    };
  }
  // The field endpoints route by ID only, as Airtable's do: a table or field
  // NAME in these paths falls through to the 404 below.
  if (
    p === "/v0/meta/bases/appBase0000000001/tables/tblTasks000000001/fields" &&
    m === "POST"
  ) {
    return { body: { id: "fldNew00000000001", ...(call.body as object) } };
  }
  const fieldPatch =
    /^\/v0\/meta\/bases\/appBase0000000001\/tables\/tblTasks000000001\/fields\/(fld[A-Za-z0-9]{14})$/.exec(
      p,
    );
  if (fieldPatch && m === "PATCH") {
    const field = TABLE.fields.find((f) => f.id === fieldPatch[1]);
    if (field)
      return {
        body: { id: field.id, type: field.type, ...(call.body as object) },
      };
  }
  if (
    p === "/v0/meta/bases/appBase0000000001/tables/tblTasks000000001" &&
    m === "PATCH"
  ) {
    return { body: { id: "tblTasks000000001", ...(call.body as object) } };
  }
  if (p.endsWith("/comments") && m === "GET")
    return { body: { comments: [COMMENT], offset: null } };
  if (p.endsWith("/comments") && m === "POST")
    return { body: { ...COMMENT, text: (call.body as { text: string }).text } };
  if (/^\/v0\/appBase0000000001\/[^/]+$/.test(p)) {
    if (m === "GET") return { body: { records: [RECORD] } };
    if (m === "POST")
      return {
        body: {
          id: "recNew00000000001",
          createdTime: RECORD.createdTime,
          fields: (call.body as { fields: object }).fields,
        },
      };
    if (m === "PATCH")
      return {
        body: { records: (call.body as { records: object[] }).records },
      };
    if (m === "DELETE") {
      return {
        body: {
          records: call.url.searchParams
            .getAll("records[]")
            .map((id) => ({ id, deleted: true })),
        },
      };
    }
  }
  // The long-formula form of a list: the same read, its parameters in a body.
  if (/^\/v0\/appBase0000000001\/[^/]+\/listRecords$/.test(p) && m === "POST")
    return { body: { records: [RECORD] } };
  if (/^\/v0\/appBase0000000001\/[^/]+\/rec[^/]+$/.test(p) && m === "GET")
    return { body: RECORD };
  return { status: 404, body: { error: "NOT_FOUND" } };
};
