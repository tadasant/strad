/**
 * The thin HTTP layer over the Hetzner Cloud API: one header, one base URL, one
 * error shape, one pagination convention, one timeout.
 *
 *   AUTH is `Authorization: Bearer <token>` on every request, and every request
 *   goes to the configured API origin. Nothing here fetches a URL a response
 *   handed back, so the token has exactly one destination.
 *
 *   ERRORS are `{"error": {"code": "not_found", "message": "...", "details":
 *   {...}}}`. The code is what the advice below keys on: `protected`, `locked`
 *   and `token_readonly` each want a different next move from the caller.
 *
 *   PAGINATION is `page` / `per_page` in (Hetzner caps `per_page` at 50), and
 *   `meta.pagination` out. This layer fetches exactly the page asked for;
 *   nothing here walks.
 *
 *   EVERY REQUEST is bounded at 30 s by an AbortController. A request that hangs
 *   is otherwise a tool call that hangs inside a process shared with the rest of
 *   the bundle.
 *
 * @see https://docs.hetzner.cloud/
 */

import type { HetznerConfig } from "./config.js";
import { HetznerApiError, TimeoutError } from "./errors.js";

export const REQUEST_TIMEOUT_MS = 30_000;

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  /**
   * Query parameters. `undefined` values are dropped rather than sent empty; an
   * array is sent as the key repeated, which is how Hetzner takes `status=` and
   * `type=` filters with more than one value.
   */
  query?: Record<string, QueryValue>;
  body?: unknown;
}

export type QueryValue = string | number | boolean | string[] | undefined;

export interface HetznerClient {
  /** The parsed JSON body; `undefined` for a 204 with none. */
  request<T>(path: string, options?: RequestOptions): Promise<T>;
}

export interface CreateClientOptions {
  config: HetznerConfig;
  /** Injected in tests. Production uses the global. */
  fetchImpl?: typeof fetch;
  /** Injected in tests, so the timeout path costs no wall clock. */
  timeoutMs?: number;
}

/**
 * Remove the literal token from text this server did not write. The shape rule
 * in logging.ts is the backstop; this is the exact rule, and it lives here
 * because this is the only module that holds the value.
 */
export function scrubber(token: string): (text: string) => string {
  // Splitting on a short or empty string would shred every message.
  if (token.length < 8) return (text) => text;
  return (text) => text.split(token).join("[redacted]");
}

/** Summarise an error body: Hetzner's `error.message` if it sent one, else a capped slice. */
function describe(
  status: number,
  body: unknown,
  raw: string,
): { text: string; code?: string } {
  if (body && typeof body === "object") {
    const error = (body as Record<string, unknown>).error;
    if (error && typeof error === "object") {
      const e = error as Record<string, unknown>;
      const message = typeof e.message === "string" ? e.message : undefined;
      const code = typeof e.code === "string" ? e.code : undefined;
      if (message !== undefined) {
        const details = fieldDetails(e.details);
        return {
          text: (message + details).slice(0, 500),
          ...(code === undefined ? {} : { code }),
        };
      }
    }
  }
  // An HTML page from a load balancer is not worth quoting in full.
  const snippet = raw.replace(/\s+/g, " ").trim().slice(0, 200);
  return { text: snippet === "" ? `HTTP ${status}` : snippet };
}

/**
 * `invalid_input` carries `details.fields: [{name, messages[]}]`, which is the
 * part that says WHICH argument was wrong. Appended so the caller can fix it.
 */
function fieldDetails(details: unknown): string {
  if (!details || typeof details !== "object") return "";
  const fields = (details as { fields?: unknown }).fields;
  if (!Array.isArray(fields)) return "";
  const parts = fields
    .map((f) => {
      const field = (f ?? {}) as { name?: unknown; messages?: unknown };
      const messages = Array.isArray(field.messages)
        ? field.messages.filter((m) => typeof m === "string").join("; ")
        : "";
      return typeof field.name === "string"
        ? `${field.name}: ${messages || "invalid"}`
        : "";
    })
    .filter((p) => p !== "");
  return parts.length === 0 ? "" : ` (${parts.join(", ")})`;
}

/**
 * What the failure MEANS for the caller's next move, appended to Hetzner's
 * message. Keyed on the error code first, because Hetzner answers several
 * different situations with the same status (a read-only token and a protected
 * server are both 403).
 */
function advice(status: number, code: string | undefined): string {
  switch (code) {
    case "token_readonly":
      return (
        " The token is a Read token and this call writes. A human mints a " +
        "Read & Write token for the project; retrying will not help."
      );
    case "protected":
      return (
        " The resource has delete or rebuild protection on. This server cannot " +
        "turn protection off, on purpose: a human does that in the Hetzner " +
        "console after deciding the resource really should go."
      );
    case "locked":
      return (
        " Another action is still running on this resource. Poll its actions " +
        "(list_server_actions or get_action) until it finishes, then retry."
      );
    case "resource_limit_exceeded":
      return " The project is at a Hetzner resource limit; a human raises it with Hetzner support.";
    case "uniqueness_error":
      return " Something with that name or value already exists in the project.";
    case "placement_error":
    case "resource_unavailable":
      return " Hetzner has no capacity for that server type at that location right now; try another location or type.";
    case "server_not_stopped":
      return " The server must be off first: power_server with `shutdown`, poll the action, then retry.";
  }
  switch (status) {
    case 401:
      return (
        " Hetzner rejected the token: it is invalid or was deleted. A human " +
        "mints a new one in the project's Security -> API tokens. Retrying " +
        "will not help."
      );
    case 403:
      return " The token may not do this. Retrying will not help.";
    case 404:
      return " Nothing with that id exists in this project (a token sees one project only).";
    case 409:
      return " The resource's state conflicts with the request; read it back and retry once it has settled.";
    case 422:
    case 400:
      return " Hetzner refused the arguments; the message above says which.";
    case 429:
      return (
        " Rate limited (Hetzner allows 3,600 requests an hour per project " +
        "token, refilling one a second). Wait before calling again."
      );
    default:
      return status >= 500
        ? " Hetzner is failing on its side; a read is safe to retry shortly."
        : "";
  }
}

async function withTimeout<T>(
  what: string,
  ms: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await run(controller.signal);
  } catch (err) {
    if (controller.signal.aborted) throw new TimeoutError(what, ms);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export function createClient(options: CreateClientOptions): HetznerClient {
  const { config } = options;
  const hFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const scrub = scrubber(config.apiToken);

  return {
    async request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
      const method = opts.method ?? "GET";
      const url = new URL(`${config.baseUrl}${path}`);
      for (const [key, value] of Object.entries(opts.query ?? {})) {
        if (value === undefined) continue;
        if (Array.isArray(value)) {
          for (const v of value) url.searchParams.append(key, v);
        } else {
          url.searchParams.set(key, String(value));
        }
      }

      const what = `Hetzner Cloud (${method} ${path})`;
      const { status, text } = await withTimeout(
        what,
        timeoutMs,
        async (signal) => {
          let response: Response;
          try {
            response = await hFetch(url.toString(), {
              method,
              signal,
              // The token goes to the API origin and nowhere else; a redirect
              // to another host is refused rather than followed with it.
              redirect: "error",
              headers: {
                Authorization: `Bearer ${config.apiToken}`,
                Accept: "application/json",
                ...(opts.body === undefined
                  ? {}
                  : { "Content-Type": "application/json" }),
              },
              ...(opts.body === undefined
                ? {}
                : { body: JSON.stringify(opts.body) }),
            });
          } catch (err) {
            if (signal.aborted) throw err;
            // No answer at all: DNS, TLS, a dropped connection, or a redirect
            // this client refuses to follow with the token attached.
            const cause = err instanceof Error ? err.message : String(err);
            throw new HetznerApiError(
              scrub(
                `${what} failed before any answer: ${cause}. A read is safe ` +
                  `to retry; a WRITE may still have been applied — read the ` +
                  `resource back before sending it again.`,
              ),
              0,
            );
          }
          return { status: response.status, text: await response.text() };
        },
      );

      let body: unknown = undefined;
      if (text !== "") {
        try {
          body = JSON.parse(text);
        } catch {
          body = undefined;
        }
      }
      if (status >= 200 && status < 300) return body as T;

      const described = describe(status, body, text);
      // Scrubbed HERE, once: an auth failure is exactly the case where an
      // upstream might echo the credential back.
      throw new HetznerApiError(
        scrub(
          `Hetzner answered HTTP ${status} to ${method} ${path}` +
            (described.code ? ` (${described.code})` : "") +
            `: ${described.text}.${advice(status, described.code)}`,
        ),
        status,
        described.code,
      );
    },
  };
}

export interface Page<T> {
  items: T[];
  page: number;
  per_page: number;
  /** Hetzner's `meta.pagination.total_entries`, when it sent one. */
  total?: number;
  has_next_page: boolean;
  /** Pass this back as `page` to continue; absent on the last page. */
  next_page?: number;
}

/** Hetzner's list envelope: the collection under its own key, plus meta.pagination. */
interface ListEnvelope {
  meta?: {
    pagination?: {
      total_entries?: number | null;
      next_page?: number | null;
    };
  };
  [key: string]: unknown;
}

/**
 * Exactly ONE page of a collection. The caller asks for the next one; this
 * never walks, because a project's hourly budget is 3,600 requests and an
 * agent rarely needs every row.
 */
export async function listPage<T>(
  client: HetznerClient,
  path: string,
  key: string,
  page: number,
  perPage: number,
  query: Record<string, QueryValue> = {},
): Promise<Page<T>> {
  const body = await client.request<ListEnvelope>(path, {
    query: { ...query, page, per_page: perPage },
  });
  const raw = body?.[key];
  const items = Array.isArray(raw) ? (raw as T[]) : [];
  const pagination = body?.meta?.pagination;
  const total = pagination?.total_entries;
  const next = pagination?.next_page;
  const hasNext =
    typeof next === "number" ||
    (typeof total === "number" && page * perPage < total);
  return {
    items,
    page,
    per_page: perPage,
    ...(typeof total === "number" ? { total } : {}),
    has_next_page: hasNext,
    ...(hasNext
      ? { next_page: typeof next === "number" ? next : page + 1 }
      : {}),
  };
}
