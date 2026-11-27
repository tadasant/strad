import type { GlitchTipConfig } from "./config.js";
import { GlitchTipApiError, type GlitchTipClient, type Page } from "./client.js";

/**
 * Seven reads, and two writes behind a switch.
 *
 * The reads are what triaging an error needs: the organization, its projects
 * and teams, one project, issues (organization- or project-wide), one issue
 * with its latest event and comments, and the events of an issue or a project.
 *
 * The writes are `update_issue` (one issue's status) and `delete_project` (one
 * project, irreversibly, behind a typed confirmation). They are served only
 * when the instance's `GLITCHTIP_ALLOW_WRITE` is exactly `true`; otherwise they
 * are neither listed nor callable. GlitchTip's API can also assign, merge and
 * delete issues, rotate DSNs and manage members; none of that is here, so even
 * a write slug can do exactly these two things whatever its token may do.
 *
 * Every tool reads ONE page. Lists take `limit` (default 25; a larger value is
 * clamped to 100, GlitchTip's own page ceiling here) and `cursor`, and return `next_cursor` — null on the last page. Nothing walks.
 */

export interface ToolContext {
  client: GlitchTipClient;
  config: GlitchTipConfig;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint?: boolean;
    openWorldHint: boolean;
  };
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;
}

const READ = { readOnlyHint: true, destructiveHint: false, openWorldHint: true };

export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputError";
  }
}

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

/** A slug as GlitchTip mints them. Anything else could splice another path. */
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function optionalString(args: Record<string, unknown>, name: string): string | undefined {
  const v = args[name];
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string") throw new InputError(`\`${name}\` must be a string.`);
  return v;
}

function slug(value: string, what: string): string {
  if (!SLUG.test(value)) {
    throw new InputError(`\`${what}\` must be a slug (letters, digits, '.', '_', '-'); got ${JSON.stringify(value)}.`);
  }
  return encodeURIComponent(value);
}

function organization(args: Record<string, unknown>, ctx: ToolContext): string {
  const org = optionalString(args, "organization") ?? ctx.config.organization;
  if (!org) {
    throw new InputError(
      "No organization given, and this deployment sets no GLITCHTIP_ORGANIZATION_SLUG. " +
        "Pass `organization` (the slug in the GlitchTip URL).",
    );
  }
  return slug(org, "organization");
}

function issueId(args: Record<string, unknown>, name = "issue_id"): string {
  const v = args[name];
  const s = typeof v === "number" ? String(v) : v;
  if (typeof s !== "string" || !/^[0-9]{1,18}$/.test(s)) {
    throw new InputError(
      `\`${name}\` must be a numeric issue id, e.g. 1234 (the number in the issue's URL, ` +
        `or \`id\` from list_issues) — not the short id like PROJECT-12.`,
    );
  }
  return s;
}

function limit(args: Record<string, unknown>): number {
  const v = args.limit;
  if (v === undefined || v === null) return DEFAULT_LIMIT;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
    throw new InputError("`limit` must be a positive integer.");
  }
  return Math.min(v, MAX_LIMIT);
}

function cursor(args: Record<string, unknown>): string | undefined {
  return optionalString(args, "cursor");
}

const PAGE_PROPS = {
  limit: {
    type: "integer",
    minimum: 1,
    maximum: MAX_LIMIT,
    description: `Results per page. Default ${DEFAULT_LIMIT}, at most ${MAX_LIMIT}.`,
  },
  cursor: {
    type: "string",
    description: "The `next_cursor` from the previous call. Omit for the first page.",
  },
};

const ORG_PROP = {
  organization: {
    type: "string",
    description:
      "The organization slug. Defaults to this deployment's GLITCHTIP_ORGANIZATION_SLUG.",
  },
};

type Json = Record<string, unknown>;

function asList(body: unknown): Json[] {
  return Array.isArray(body) ? (body as Json[]) : [];
}

function pick(o: Json, keys: string[]): Json {
  const out: Json = {};
  for (const k of keys) if (o[k] !== undefined) out[k] = o[k];
  return out;
}

function issueSummary(i: Json): Json {
  const project = (i.project ?? {}) as Json;
  return {
    ...pick(i, ["id", "shortId", "title", "culprit", "level", "status", "count", "userCount", "firstSeen", "lastSeen", "numComments", "permalink"]),
    project: project.slug ?? null,
  };
}

function eventSummary(e: Json): Json {
  return pick(e, ["eventID", "id", "groupID", "dateCreated", "title", "message", "culprit", "platform", "tags"]);
}

function paged<T>(page: Page<unknown>, items: T[]): Json {
  return { items, count: items.length, next_cursor: page.nextCursor };
}

const getOrganization: ToolDefinition = {
  name: "get_organization",
  description:
    "One GlitchTip organization: its name, slug, its projects (slug, name, platform) " +
    "and its teams. Start here to learn which project slugs exist.",
  annotations: READ,
  inputSchema: { type: "object", properties: { ...ORG_PROP }, additionalProperties: false },
  async handler(args, ctx) {
    const org = organization(args, ctx);
    const { body } = await ctx.client.get<Json>(`/api/0/organizations/${org}/`);
    const o = body ?? {};
    return {
      ...pick(o, ["id", "slug", "name", "dateCreated", "status", "isAcceptingEvents"]),
      projects: asList(o.projects).map((p) => pick(p, ["id", "slug", "name", "platform"])),
      teams: asList(o.teams).map((t) => pick(t, ["id", "slug", "memberCount"])),
    };
  },
};

const listProjects: ToolDefinition = {
  name: "list_projects",
  description:
    "The organization's projects, one page at a time: id, slug, name, platform and " +
    "when each first received an event. `query` filters by name.",
  annotations: READ,
  inputSchema: {
    type: "object",
    properties: {
      ...ORG_PROP,
      query: { type: "string", description: "Filter projects by name." },
      ...PAGE_PROPS,
    },
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const org = organization(args, ctx);
    const page = await ctx.client.get<unknown>(`/api/0/organizations/${org}/projects/`, {
      query: optionalString(args, "query"),
      limit: limit(args),
      cursor: cursor(args),
    });
    return paged(
      page,
      asList(page.body).map((p) => ({
        ...pick(p, ["id", "slug", "name", "platform", "dateCreated", "firstEvent"]),
        teams: asList(p.teams).map((t) => t.slug),
      })),
    );
  },
};

const getProject: ToolDefinition = {
  name: "get_project",
  description: "One project in full, by its slug (from list_projects or get_organization).",
  annotations: READ,
  inputSchema: {
    type: "object",
    properties: { project: { type: "string", description: "The project slug." }, ...ORG_PROP },
    required: ["project"],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const org = organization(args, ctx);
    const project = optionalString(args, "project");
    if (!project) throw new InputError("`project` is required: a project slug.");
    const { body } = await ctx.client.get<Json>(
      `/api/0/projects/${org}/${slug(project, "project")}/`,
    );
    return body;
  },
};

const listTeams: ToolDefinition = {
  name: "list_teams",
  description: "The organization's teams, one page at a time: id, slug and member count.",
  annotations: READ,
  inputSchema: { type: "object", properties: { ...ORG_PROP, ...PAGE_PROPS }, additionalProperties: false },
  async handler(args, ctx) {
    const org = organization(args, ctx);
    const page = await ctx.client.get<unknown>(`/api/0/organizations/${org}/teams/`, {
      limit: limit(args),
      cursor: cursor(args),
    });
    return paged(page, asList(page.body).map((t) => pick(t, ["id", "slug", "dateCreated", "memberCount", "isMember"])));
  },
};

const SORTS = ["-last_seen", "-first_seen", "-count", "-priority", "last_seen", "first_seen", "count", "priority"];

const listIssues: ToolDefinition = {
  name: "list_issues",
  description:
    "Error groups (issues), newest activity first by default, one page at a time — " +
    "organization-wide, or one project's with `project`. Each is summarised: id (pass " +
    "it to get_issue / list_events), shortId, title, culprit, level, status, event and " +
    "user counts, first/last seen. `query` is GlitchTip's search syntax and defaults to " +
    '"is:unresolved"; pass "" for every status, or e.g. "is:resolved", "TypeError".',
  annotations: READ,
  inputSchema: {
    type: "object",
    properties: {
      ...ORG_PROP,
      project: { type: "string", description: "A project slug, to list only that project's issues." },
      query: { type: "string", description: 'Search. Default "is:unresolved".' },
      sort: { type: "string", enum: SORTS, description: "Default -last_seen (most recent activity first)." },
      environment: { type: "string", description: "Only issues seen in this environment." },
      start: { type: "string", description: "ISO 8601; only issues seen after it." },
      end: { type: "string", description: "ISO 8601; only issues seen before it." },
      ...PAGE_PROPS,
    },
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const org = organization(args, ctx);
    const project = optionalString(args, "project");
    const sort = optionalString(args, "sort");
    if (sort !== undefined && !SORTS.includes(sort)) {
      throw new InputError(`\`sort\` must be one of ${SORTS.join(", ")}.`);
    }
    const query = args.query === "" ? undefined : (optionalString(args, "query") ?? "is:unresolved");
    const environment = optionalString(args, "environment");
    const path = project
      ? `/api/0/projects/${org}/${slug(project, "project")}/issues/`
      : `/api/0/organizations/${org}/issues/`;
    const page = await ctx.client.get<unknown>(path, {
      query,
      sort,
      environment: environment === undefined ? undefined : [environment],
      start: optionalString(args, "start"),
      end: optionalString(args, "end"),
      limit: limit(args),
      cursor: cursor(args),
    });
    return paged(page, asList(page.body).map(issueSummary));
  },
};

function noneOn404(error: unknown): null {
  if (error instanceof GlitchTipApiError && error.status === 404) return null;
  throw error;
}

const getIssue: ToolDefinition = {
  name: "get_issue",
  description:
    "One issue in full, with its LATEST event (exception and stack trace, request, " +
    "tags, contexts, breadcrumbs) and the first page of its comments. `issue_id` is " +
    "the numeric id from list_issues or the issue's URL. Use list_events for older events.",
  annotations: READ,
  inputSchema: {
    type: "object",
    properties: { issue_id: { type: ["integer", "string"], description: "The numeric issue id." } },
    required: ["issue_id"],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const id = issueId(args);
    const [issue, latest, comments] = await Promise.all([
      ctx.client.get<Json>(`/api/0/issues/${id}/`),
      // An issue whose events have aged out answers 404 here: that is "none",
      // not a failure. Anything else — a token without event:read, a 5xx — is
      // the caller's to see, so it propagates.
      ctx.client.get<Json>(`/api/0/issues/${id}/events/latest/`).catch(noneOn404),
      ctx.client.get<unknown>(`/api/0/issues/${id}/comments/`).catch(noneOn404),
    ]);
    return {
      issue: issue.body,
      latest_event: latest?.body ?? null,
      comments: comments
        ? asList(comments.body).map((c) => ({
            ...pick(c, ["id", "dateCreated"]),
            text: (c.data as Json | undefined)?.text ?? null,
            user: (c.user as Json | undefined)?.email ?? null,
          }))
        : null,
    };
  },
};

const listEvents: ToolDefinition = {
  name: "list_events",
  description:
    "Events, newest first, one page at a time: one issue's (`issue_id`) or one " +
    "project's (`project`). Each is summarised (eventID, date, title, message, " +
    "culprit, tags); get_issue carries the latest event in full.",
  annotations: READ,
  inputSchema: {
    type: "object",
    properties: {
      issue_id: { type: ["integer", "string"], description: "List this issue's events." },
      project: { type: "string", description: "Or: list this project's events." },
      ...ORG_PROP,
      ...PAGE_PROPS,
    },
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const hasIssue = args.issue_id !== undefined && args.issue_id !== null && args.issue_id !== "";
    const project = optionalString(args, "project");
    if (hasIssue === (project !== undefined)) {
      throw new InputError("Pass exactly one of `issue_id` or `project`.");
    }
    const path = hasIssue
      ? `/api/0/issues/${issueId(args)}/events/`
      : `/api/0/projects/${organization(args, ctx)}/${slug(project!, "project")}/events/`;
    const page = await ctx.client.get<unknown>(path, { limit: limit(args), cursor: cursor(args) });
    return paged(page, asList(page.body).map(eventSummary));
  },
};

const STATUSES = ["resolved", "unresolved", "ignored"];

const updateIssue: ToolDefinition = {
  name: "update_issue",
  description:
    "WRITE. Set one issue's status to resolved, unresolved or ignored, by its numeric " +
    "`issue_id` (from list_issues). Changes nothing else on the issue. Returns the " +
    "issue's summary as GlitchTip answers it. Needs a token with event:write.",
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  inputSchema: {
    type: "object",
    properties: {
      issue_id: { type: ["integer", "string"], description: "The numeric issue id." },
      status: { type: "string", enum: STATUSES, description: "The status to set." },
    },
    required: ["issue_id", "status"],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const id = issueId(args);
    const status = optionalString(args, "status");
    if (status === undefined || !STATUSES.includes(status)) {
      throw new InputError(`\`status\` must be one of ${STATUSES.join(", ")}.`);
    }
    const body = await ctx.client.write<Json>("PUT", `/api/0/issues/${id}/`, { status });
    return { updated: true, issue: body ? issueSummary(body) : { id, status } };
  },
};

const deleteProject: ToolDefinition = {
  name: "delete_project",
  description:
    "WRITE, IRREVERSIBLE. Delete one GlitchTip project by slug, with every issue and " +
    "event in it; GlitchTip offers no undo. `confirm_project_slug` must repeat " +
    "`project` exactly, or nothing is sent. Needs a token with project:admin, whose " +
    "user is an Admin, Manager or Owner of the organization.",
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  inputSchema: {
    type: "object",
    properties: {
      project: { type: "string", description: "The slug of the project to delete." },
      confirm_project_slug: {
        type: "string",
        description: "The same slug again. Must equal `project` exactly.",
      },
      ...ORG_PROP,
    },
    required: ["project", "confirm_project_slug"],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const project = optionalString(args, "project");
    if (!project) throw new InputError("`project` is required: a project slug.");
    const confirm = optionalString(args, "confirm_project_slug");
    if (confirm !== project) {
      throw new InputError(
        "Refused: `confirm_project_slug` must equal `project` exactly. Deleting a " +
          "project is irreversible; nothing was sent.",
      );
    }
    const org = organization(args, ctx);
    await ctx.client.write("DELETE", `/api/0/projects/${org}/${slug(project, "project")}/`);
    return { deleted: true, organization: decodeURIComponent(org), project };
  },
};

export const TOOLS: readonly ToolDefinition[] = [
  getOrganization,
  listProjects,
  getProject,
  listTeams,
  listIssues,
  getIssue,
  listEvents,
];

/** Served only by an instance whose `GLITCHTIP_ALLOW_WRITE` is exactly `true`. */
export const WRITE_TOOLS: readonly ToolDefinition[] = [updateIssue, deleteProject];

export const TOOL_NAMES: readonly string[] = TOOLS.map((t) => t.name);
export const WRITE_TOOL_NAMES: readonly string[] = WRITE_TOOLS.map((t) => t.name);
