/**
 * The server end to end, through a real MCP client over an in-memory transport,
 * against a fake GlitchTip that answers in the shapes of GlitchTip's published
 * OpenAPI (https://app.glitchtip.com/api/openapi.json).
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { afterEach, describe, expect, it } from "vitest";

import {
  createMCPServer,
  GLITCHTIP_ENV_NAMES,
  MAX_RESULT_CHARS,
  missingCredentials,
  nextCursor,
  TOOL_NAMES,
  WRITE_TOOL_NAMES,
} from "../src/index.js";

const BASE = "https://glitchtip.example.com";
const TOKEN = "gt-test-token-0123456789abcdef";
const ENV = {
  GLITCHTIP_BASE_URL: BASE,
  GLITCHTIP_API_TOKEN: TOKEN,
  GLITCHTIP_ORGANIZATION_SLUG: "acme",
};

interface Seen {
  url: URL;
  init: RequestInit;
}

type Route = (url: URL, init: RequestInit) => { status?: number; body: unknown; link?: string };

function fakeGlitchTip(routes: Record<string, Route>) {
  const seen: Seen[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    seen.push({ url, init: init ?? {} });
    const route = routes[url.pathname];
    if (!route) return new Response(JSON.stringify({ detail: "Not Found" }), { status: 404 });
    const r = route(url, init ?? {});
    if (r.status === 204) return new Response(null, { status: 204 });
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (r.link) headers.link = r.link;
    return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers,
    });
  }) as typeof fetch;
  return { seen, fetchImpl };
}

const ISSUE = {
  id: "42",
  shortId: "WEB-7",
  title: "TypeError: x is undefined",
  culprit: "app/views.py in index",
  level: "error",
  status: "unresolved",
  count: "12",
  userCount: 3,
  firstSeen: "2026-11-01T00:00:00Z",
  lastSeen: "2026-11-19T00:00:00Z",
  numComments: 1,
  permalink: `${BASE}/acme/issues/42`,
  project: { id: "5", slug: "web", name: "Web", platform: "python" },
  metadata: { type: "TypeError" },
};

const NEXT_LINK =
  `<${BASE}/api/0/organizations/acme/issues/?cursor=0:0:1>; rel="previous"; results="false"; cursor="0:0:1", ` +
  `<${BASE}/api/0/organizations/acme/issues/?cursor=0:25:0>; rel="next"; results="true"; cursor="0:25:0"`;

const ROUTES: Record<string, Route> = {
  "/api/0/organizations/acme/": () => ({
    body: {
      id: "1",
      slug: "acme",
      name: "Acme",
      projects: [{ id: "5", slug: "web", name: "Web", platform: "python", extra: "dropped" }],
      teams: [{ id: "9", slug: "backend", memberCount: 4 }],
    },
  }),
  "/api/0/organizations/acme/projects/": () => ({
    body: [{ id: "5", slug: "web", name: "Web", platform: "python", teams: [{ slug: "backend" }] }],
  }),
  "/api/0/projects/acme/web/": () => ({ body: { id: "5", slug: "web", name: "Web" } }),
  "/api/0/organizations/acme/teams/": () => ({ body: [{ id: "9", slug: "backend", memberCount: 4 }] }),
  "/api/0/organizations/acme/issues/": () => ({ body: [ISSUE], link: NEXT_LINK }),
  "/api/0/projects/acme/web/issues/": () => ({ body: [ISSUE] }),
  "/api/0/issues/42/": () => ({ body: ISSUE }),
  "/api/0/issues/42/events/latest/": () => ({
    body: { eventID: "abc", title: ISSUE.title, entries: [{ type: "exception", data: {} }] },
  }),
  "/api/0/issues/42/comments/": () => ({
    body: [{ id: "c1", dateCreated: "2026-11-19T01:00:00Z", data: { text: "looking" }, user: { id: "3", email: "dev@example.com" } }],
  }),
  "/api/0/issues/42/events/": () => ({
    body: [{ eventID: "abc", dateCreated: "2026-11-19T00:00:00Z", title: "t", entries: ["dropped"] }],
  }),
  "/api/0/projects/acme/web/events/": () => ({ body: [{ eventID: "def", title: "u" }] }),
};

const clients: Client[] = [];

async function connect(env: Record<string, string | undefined> = ENV, routes = ROUTES) {
  const fake = fakeGlitchTip(routes);
  const created = createMCPServer({ version: "test", env, fetch: fake.fetchImpl });
  const server = new Server({ name: "strad-glitchtip", version: "test" }, { capabilities: { tools: {} } });
  await created.registerHandlers(server);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "test" });
  await client.connect(clientSide);
  clients.push(client);
  return { client, seen: fake.seen, created };
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as Array<{ text: string }>)[0].text;
  let json: any;
  try {
    json = result.isError ? undefined : JSON.parse(text);
  } catch {
    json = undefined; // a cut result is no longer JSON; the test reads `text`
  }
  return { result, text, json };
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

describe("the tool surface", () => {
  it("is exactly the seven reads, every one annotated read-only", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      "get_organization",
      "list_projects",
      "get_project",
      "list_teams",
      "list_issues",
      "get_issue",
      "list_events",
    ]);
    expect([...TOOL_NAMES]).toEqual(tools.map((t) => t.name));
    for (const t of tools) {
      expect(t.annotations?.readOnlyHint).toBe(true);
      expect(t.annotations?.destructiveHint).toBe(false);
    }
  });

  it("lists with no credential, and every call names what is missing and sends nothing", async () => {
    expect([...GLITCHTIP_ENV_NAMES]).toEqual(["GLITCHTIP_BASE_URL", "GLITCHTIP_API_TOKEN"]);
    expect(missingCredentials({})).toEqual(["GLITCHTIP_BASE_URL", "GLITCHTIP_API_TOKEN"]);
    const { client, seen, created } = await connect({});
    expect(created.missing).toEqual(["GLITCHTIP_BASE_URL", "GLITCHTIP_API_TOKEN"]);
    expect((await client.listTools()).tools).toHaveLength(7);
    const { result, text } = await call(client, "list_issues");
    expect(result.isError).toBe(true);
    expect(text).toContain("GLITCHTIP_BASE_URL and GLITCHTIP_API_TOKEN are not set");
    expect(seen).toHaveLength(0);
  });
});

describe("every request", () => {
  it("is a GET to the configured origin, with the bearer token and no redirects", async () => {
    const { client, seen } = await connect();
    for (const [name, args] of [
      ["get_organization", {}],
      ["list_projects", {}],
      ["get_project", { project: "web" }],
      ["list_teams", {}],
      ["list_issues", {}],
      ["get_issue", { issue_id: 42 }],
      ["list_events", { issue_id: "42" }],
    ] as const) {
      const { result } = await call(client, name, args);
      expect(result.isError, name).toBeFalsy();
    }
    expect(seen.length).toBeGreaterThanOrEqual(9);
    for (const s of seen) {
      expect(s.url.origin).toBe(BASE);
      expect(s.init.method).toBe("GET");
      expect(s.init.redirect).toBe("error");
      expect((s.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    }
  });

  it("keeps a base URL's path prefix, and drops a trailing slash", async () => {
    const { client, seen } = await connect({ ...ENV, GLITCHTIP_BASE_URL: "https://example.com/glitchtip/" }, {
      "/glitchtip/api/0/organizations/acme/teams/": () => ({ body: [] }),
    });
    const { result } = await call(client, "list_teams");
    expect(result.isError).toBeFalsy();
    expect(seen[0].url.pathname).toBe("/glitchtip/api/0/organizations/acme/teams/");
  });
});

describe("the tools", () => {
  it("get_organization summarises projects and teams", async () => {
    const { client } = await connect();
    const { json } = await call(client, "get_organization");
    expect(json.slug).toBe("acme");
    expect(json.projects).toEqual([{ id: "5", slug: "web", name: "Web", platform: "python" }]);
    expect(json.teams).toEqual([{ id: "9", slug: "backend", memberCount: 4 }]);
  });

  it("list_issues defaults to unresolved, organization-wide, and returns the next cursor", async () => {
    const { client, seen } = await connect();
    const { json } = await call(client, "list_issues", { limit: 500 });
    expect(seen[0].url.pathname).toBe("/api/0/organizations/acme/issues/");
    expect(seen[0].url.searchParams.get("query")).toBe("is:unresolved");
    expect(seen[0].url.searchParams.get("limit")).toBe("100");
    expect(json.next_cursor).toBe("0:25:0");
    expect(json.items[0]).toMatchObject({ id: "42", shortId: "WEB-7", project: "web", count: "12" });
    expect(json.items[0].metadata).toBeUndefined();
  });

  it("list_issues scopes to a project, and passes an empty query as none", async () => {
    const { client, seen } = await connect();
    const { json } = await call(client, "list_issues", {
      project: "web",
      query: "",
      sort: "-count",
      environment: "production",
      cursor: "0:25:0",
    });
    const url = seen[0].url;
    expect(url.pathname).toBe("/api/0/projects/acme/web/issues/");
    expect(url.searchParams.has("query")).toBe(false);
    expect(url.searchParams.get("sort")).toBe("-count");
    expect(url.searchParams.getAll("environment")).toEqual(["production"]);
    expect(url.searchParams.get("cursor")).toBe("0:25:0");
    expect(json.next_cursor).toBeNull();
  });

  it("get_issue carries the latest event and comments", async () => {
    const { client } = await connect();
    const { json } = await call(client, "get_issue", { issue_id: "42" });
    expect(json.issue.id).toBe("42");
    expect(json.latest_event.eventID).toBe("abc");
    expect(json.comments).toEqual([{ id: "c1", dateCreated: "2026-11-19T01:00:00Z", text: "looking", user: "dev@example.com" }]);
  });

  it("get_issue survives an issue with no events left", async () => {
    const routes = { ...ROUTES };
    delete routes["/api/0/issues/42/events/latest/"];
    const { client } = await connect(ENV, routes);
    const { json } = await call(client, "get_issue", { issue_id: 42 });
    expect(json.latest_event).toBeNull();
  });

  it("get_issue surfaces a failure on the latest event instead of reporting none", async () => {
    const { client } = await connect(ENV, {
      ...ROUTES,
      "/api/0/issues/42/events/latest/": () => ({ status: 403, body: { detail: "You do not have permission" } }),
    });
    const { result, text } = await call(client, "get_issue", { issue_id: 42 });
    expect(result.isError).toBe(true);
    expect(text).toContain("HTTP 403");
  });

  it("list_events reads an issue's or a project's events, summarised", async () => {
    const { client, seen } = await connect();
    const byIssue = await call(client, "list_events", { issue_id: 42 });
    expect(byIssue.json.items[0]).toEqual({ eventID: "abc", dateCreated: "2026-11-19T00:00:00Z", title: "t" });
    const byProject = await call(client, "list_events", { project: "web" });
    expect(byProject.json.items[0].eventID).toBe("def");
    expect(seen.map((s) => s.url.pathname)).toEqual([
      "/api/0/issues/42/events/",
      "/api/0/projects/acme/web/events/",
    ]);
    const both = await call(client, "list_events", { issue_id: 42, project: "web" });
    expect(both.result.isError).toBe(true);
  });

  it("an explicit organization overrides the default", async () => {
    const { client, seen } = await connect(ENV, {
      "/api/0/organizations/other/teams/": () => ({ body: [] }),
    });
    await call(client, "list_teams", { organization: "other" });
    expect(seen[0].url.pathname).toBe("/api/0/organizations/other/teams/");
  });
});

describe("input that could reach another path", () => {
  it.each([
    ["get_project", { project: "../../users" }],
    ["get_project", { project: "web/../x" }],
    ["list_teams", { organization: "acme/../../x" }],
    ["get_issue", { issue_id: "42/../43" }],
    ["get_issue", { issue_id: "WEB-7" }],
  ])("%s %j is refused before anything is sent", async (name, args) => {
    const { client, seen } = await connect();
    const { result } = await call(client, name, args);
    expect(result.isError).toBe(true);
    expect(seen).toHaveLength(0);
  });

  it("no organization anywhere is a clear error", async () => {
    const { client } = await connect({ GLITCHTIP_BASE_URL: BASE, GLITCHTIP_API_TOKEN: TOKEN });
    const { result, text } = await call(client, "list_projects");
    expect(result.isError).toBe(true);
    expect(text).toContain("GLITCHTIP_ORGANIZATION_SLUG");
  });

  it.each([
    "ftp://x.example",
    "https://user:pw@x.example",
    "https://x.example/?a=1",
    "not a url",
    "http://glitchtip.example.com",
  ])(
    "base URL %s is refused",
    async (url) => {
      const { client, seen } = await connect({ ...ENV, GLITCHTIP_BASE_URL: url });
      const { result } = await call(client, "list_teams");
      expect(result.isError).toBe(true);
      expect(seen).toHaveLength(0);
    },
  );
});

describe("plain http", () => {
  it.each(["http://localhost:8000", "http://10.0.0.5", "http://192.168.1.2", "http://glitchtip.internal", "http://[::1]:8000"])(
    "is accepted for the private host %s",
    async (url) => {
      const { client, seen } = await connect({ ...ENV, GLITCHTIP_BASE_URL: url }, {});
      await call(client, "list_teams");
      expect(seen).toHaveLength(1);
    },
  );
});

describe("errors", () => {
  it("a request that gets no answer says why, from the transport's cause", async () => {
    const created = createMCPServer({
      version: "test",
      env: ENV,
      fetch: (async () => {
        throw Object.assign(new TypeError("fetch failed"), { cause: new Error("unexpected redirect") });
      }) as typeof fetch,
    });
    const server = new Server({ name: "s", version: "t" }, { capabilities: { tools: {} } });
    await created.registerHandlers(server);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    const client = new Client({ name: "t", version: "t" });
    await client.connect(a);
    clients.push(client);
    const { result, text } = await call(client, "list_teams");
    expect(result.isError).toBe(true);
    expect(text).toContain("fetch failed (unexpected redirect)");
    expect(text).toContain("redirect is refused");
  });

  it("a request that hangs is cut off at the timeout", async () => {
    const created = createMCPServer({
      version: "test",
      env: ENV,
      timeoutMs: 20,
      fetch: ((_: unknown, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        })) as typeof fetch,
    });
    const server = new Server({ name: "s", version: "t" }, { capabilities: { tools: {} } });
    await created.registerHandlers(server);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    const client = new Client({ name: "t", version: "t" });
    await client.connect(a);
    clients.push(client);
    const { text } = await call(client, "list_teams");
    expect(text).toContain("timed out after 20 ms");
  });

  it("a token straddling the result cap is scrubbed before the cut", async () => {
    const { client } = await connect(ENV, {
      "/api/0/projects/acme/web/": () => ({
        // Places the token across the 60,000th character of the rendered JSON.
        body: { slug: "web", pad: "x".repeat(MAX_RESULT_CHARS - 40), note: TOKEN },
      }),
    });
    const { text } = await call(client, "get_project", { project: "web" });
    expect(text).not.toContain(TOKEN.slice(0, 12));
  });

  it("a 401 says the token was rejected, and never echoes it", async () => {
    const { client } = await connect(ENV, {
      "/api/0/organizations/acme/teams/": () => ({ status: 401, body: { detail: `Invalid token ${TOKEN}` } }),
    });
    const { result, text } = await call(client, "list_teams");
    expect(result.isError).toBe(true);
    expect(text).toContain("HTTP 401");
    expect(text).toContain("rejected the token");
    expect(text).not.toContain(TOKEN);
    expect(text).toContain("[redacted]");
  });

  it("a success that echoes the token is scrubbed too", async () => {
    const { client } = await connect(ENV, {
      "/api/0/projects/acme/web/": () => ({ body: { slug: "web", note: TOKEN } }),
    });
    const { text } = await call(client, "get_project", { project: "web" });
    expect(text).not.toContain(TOKEN);
  });

  it("a 404 says how to find a valid slug or id", async () => {
    const { client } = await connect();
    const { text } = await call(client, "get_project", { project: "nope" });
    expect(text).toContain("HTTP 404");
    expect(text).toContain("list_projects");
  });

  it("a non-JSON success says the URL may not be GlitchTip", async () => {
    const { client } = await connect(ENV, {
      "/api/0/organizations/acme/teams/": () => ({ body: "<html>login</html>" }),
    });
    const { text } = await call(client, "list_teams");
    expect(text).toContain("not JSON");
  });

  it("a huge result is cut, and says so", async () => {
    const { client } = await connect(ENV, {
      "/api/0/projects/acme/web/": () => ({ body: { slug: "web", blob: "x".repeat(MAX_RESULT_CHARS * 2) } }),
    });
    const { text } = await call(client, "get_project", { project: "web" });
    expect(text.length).toBeLessThan(MAX_RESULT_CHARS + 500);
    expect(text).toContain(`cut at ${MAX_RESULT_CHARS}`);
  });
});

describe("nextCursor", () => {
  it("reads the next cursor only when the link says there are results", () => {
    expect(nextCursor(NEXT_LINK)).toBe("0:25:0");
    expect(nextCursor(NEXT_LINK.replace('rel="next"; results="true"', 'rel="next"; results="false"'))).toBeNull();
    expect(nextCursor(null)).toBeNull();
    expect(nextCursor("")).toBeNull();
    // No cursor attribute: the next URL's own cursor parameter.
    expect(nextCursor(`<${BASE}/api/0/x/?cursor=0:50:0>; rel="next"; results="true"`)).toBe("0:50:0");
    // Attribute order and spacing do not matter.
    expect(nextCursor(`<${BASE}/x/>;results="true";  rel="next";cursor="c1"`)).toBe("c1");
  });
});

describe("the write tier", () => {
  const RW = { ...ENV, GLITCHTIP_ALLOW_WRITE: "true" };
  const WRITE_ROUTES: Record<string, Route> = {
    ...ROUTES,
    "/api/0/issues/42/": (_url, init) =>
      init.method === "PUT"
        ? { body: { ...ISSUE, status: JSON.parse(String(init.body)).status } }
        : { body: ISSUE },
    "/api/0/projects/acme/web/": (_url, init) =>
      init.method === "DELETE" ? { status: 204, body: null } : { body: { id: "5", slug: "web" } },
  };

  it.each([undefined, "false", "TRUE", "1", "yes", " true", ""])(
    "GLITCHTIP_ALLOW_WRITE=%j lists the seven reads, and a write is an unknown tool",
    async (value) => {
      const { client, seen } = await connect({ ...ENV, GLITCHTIP_ALLOW_WRITE: value }, WRITE_ROUTES);
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual([...TOOL_NAMES]);
      for (const name of WRITE_TOOL_NAMES) {
        const { result, text } = await call(client, name, {
          issue_id: 42,
          status: "resolved",
          project: "web",
          confirm_project_slug: "web",
        });
        expect(result.isError).toBe(true);
        expect(text).toContain("Unknown tool");
      }
      expect(seen).toHaveLength(0);
    },
  );

  it("GLITCHTIP_ALLOW_WRITE=true adds update_issue and delete_project, annotated as writes", async () => {
    const { client } = await connect(RW, WRITE_ROUTES);
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(9);
    expect(tools.map((t) => t.name)).toEqual([...TOOL_NAMES, "update_issue", "delete_project"]);
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.update_issue.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(byName.delete_project.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(byName.delete_project.description).toContain("IRREVERSIBLE");
    for (const name of TOOL_NAMES) expect(byName[name].annotations?.readOnlyHint).toBe(true);
  });

  it("update_issue PUTs only the status to /api/0/issues/{id}/", async () => {
    const { client, seen } = await connect(RW, WRITE_ROUTES);
    const { result, json } = await call(client, "update_issue", { issue_id: 42, status: "resolved" });
    expect(result.isError).toBeFalsy();
    expect(seen).toHaveLength(1);
    expect(seen[0].url.href).toBe(`${BASE}/api/0/issues/42/`);
    expect(seen[0].init.method).toBe("PUT");
    expect(seen[0].init.redirect).toBe("error");
    expect(JSON.parse(String(seen[0].init.body))).toEqual({ status: "resolved" });
    const headers = seen[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(headers["Content-Type"]).toBe("application/json");
    expect(json).toMatchObject({ updated: true, issue: { id: "42", status: "resolved", project: "web" } });
  });

  it.each([
    [{ issue_id: 42, status: "muted" }],
    [{ issue_id: 42 }],
    [{ issue_id: "WEB-7", status: "resolved" }],
    [{ issue_id: "42/../43", status: "resolved" }],
  ])("update_issue %j is refused before anything is sent", async (args) => {
    const { client, seen } = await connect(RW, WRITE_ROUTES);
    const { result } = await call(client, "update_issue", args);
    expect(result.isError).toBe(true);
    expect(seen).toHaveLength(0);
  });

  it("delete_project DELETEs /api/0/projects/{org}/{project}/ with no body", async () => {
    const { client, seen } = await connect(RW, WRITE_ROUTES);
    const { result, json } = await call(client, "delete_project", {
      project: "web",
      confirm_project_slug: "web",
    });
    expect(result.isError).toBeFalsy();
    expect(seen).toHaveLength(1);
    expect(seen[0].url.href).toBe(`${BASE}/api/0/projects/acme/web/`);
    expect(seen[0].init.method).toBe("DELETE");
    expect(seen[0].init.redirect).toBe("error");
    expect(seen[0].init.body).toBeUndefined();
    expect(json).toEqual({ deleted: true, organization: "acme", project: "web" });
  });

  it.each([
    [{ project: "web", confirm_project_slug: "Web" }],
    [{ project: "web", confirm_project_slug: "web " }],
    [{ project: "web", confirm_project_slug: "" }],
    [{ project: "web" }],
    [{ project: "../x", confirm_project_slug: "../x" }],
  ])("delete_project %j is refused, and nothing is sent", async (args) => {
    const { client, seen } = await connect(RW, WRITE_ROUTES);
    const { result } = await call(client, "delete_project", args);
    expect(result.isError).toBe(true);
    expect(seen).toHaveLength(0);
  });

  it("a mismatched confirmation says the delete was refused", async () => {
    const { client } = await connect(RW, WRITE_ROUTES);
    const { text } = await call(client, "delete_project", { project: "web", confirm_project_slug: "api" });
    expect(text).toContain("Refused");
    expect(text).toContain("irreversible");
  });

  it("a 403 on a write names the write scope, and the token is scrubbed", async () => {
    const { client } = await connect(RW, {
      "/api/0/issues/42/": () => ({ status: 403, body: { detail: `no scope for ${TOKEN}` } }),
    });
    const { result, text } = await call(client, "update_issue", { issue_id: 42, status: "ignored" });
    expect(result.isError).toBe(true);
    expect(text).toContain("PUT /api/0/issues/42/");
    expect(text).toContain("event:write");
    expect(text).not.toContain(TOKEN);
  });

  it("a 5xx on a write does not call it safe to retry", async () => {
    const { client } = await connect(RW, {
      "/api/0/projects/acme/web/": () => ({ status: 502, body: "bad gateway" }),
    });
    const { text } = await call(client, "delete_project", { project: "web", confirm_project_slug: "web" });
    expect(text).toContain("HTTP 502");
    expect(text).toContain("may or may not have landed");
    expect(text).not.toContain("safe to retry");
  });
});
