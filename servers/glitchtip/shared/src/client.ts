/**
 * The thin HTTP layer over GlitchTip's Sentry-compatible API: one header, one
 * origin, one error shape, one pagination convention, one timeout.
 *
 *   AUTH is `Authorization: Bearer <token>`, sent only to the configured
 *   origin. Every path is built here from validated segments, nothing fetches
 *   a URL a response handed back, and a redirect is refused rather than
 *   followed with the token attached.
 *
 *   PAGINATION is Sentry's: `limit` and `cursor` in, a `Link` header out whose
 *   `rel="next"` entry carries `results` and the next `cursor` (as an attribute,
 *   and in its URL) when
 *   there is another page. This layer fetches exactly the page asked for.
 *
 *   METHODS are GET for every read, and PUT and DELETE for the two writes a
 *   slug with `GLITCHTIP_ALLOW_WRITE=true` serves. A write carries a JSON body
 *   only when it has one, and is never retried here: a timed-out write may
 *   have landed, so its error says to read before trying again.
 *
 *   EVERY REQUEST is bounded at 30 s.
 *
 * @see https://app.glitchtip.com/api/openapi.json (GlitchTip's OpenAPI)
 */

import type { GlitchTipConfig } from "./config.js";

export const REQUEST_TIMEOUT_MS = 30_000;

export type QueryValue = string | number | string[] | undefined;

export interface Page<T> {
  body: T;
  /** The cursor for the next page, or null when this is the last. */
  nextCursor: string | null;
}

export type WriteMethod = "PUT" | "DELETE";

export interface GlitchTipClient {
  get<T>(path: string, query?: Record<string, QueryValue>): Promise<Page<T>>;
  /** A write. `body` is sent as JSON when given; a 204 resolves to `undefined`. */
  write<T>(method: WriteMethod, path: string, body?: unknown): Promise<T | undefined>;
}

export class GlitchTipApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GlitchTipApiError";
  }
}

/** Remove the literal token from text this server did not write. */
export function scrubber(token: string): (text: string) => string {
  // Splitting on a short string would shred every message.
  if (token.length < 8) return (text) => text;
  return (text) => text.split(token).join("[redacted]");
}

/**
 * The `cursor` of the `rel="next"` link, unless that link says there are no
 * more results.
 *
 *   <https://…/?cursor=0:100:0>; rel="previous"; results="false"; cursor="0:0:1",
 *   <https://…/?cursor=0:100:0>; rel="next"; results="true"; cursor="0:100:0"
 */
export function nextCursor(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(/,(?=\s*<)/)) {
    if (!/;\s*rel="next"/.test(part)) continue;
    if (/;\s*results="false"/.test(part)) return null;
    const cursor = /;\s*cursor="([^"]*)"/.exec(part);
    if (cursor?.[1]) return cursor[1];
    // No `cursor` attribute: fall back to the `cursor` query parameter of the
    // next URL, which carries the same value.
    const url = /<([^>]*)>/.exec(part)?.[1];
    if (!url) return null;
    try {
      return new URL(url).searchParams.get("cursor") || null;
    } catch {
      return null;
    }
  }
  return null;
}

function advice(status: number, write: boolean): string {
  switch (status) {
    case 401:
      return (
        " GlitchTip rejected the token: it is invalid or was revoked. A human " +
        "creates a new one under Profile -> Auth Tokens. Retrying will not help."
      );
    case 403:
      return write
        ? " The token may not change this. update_issue needs event:write and " +
            "delete_project needs project:admin, and the token's user needs an " +
            "organization role that holds that scope (project:admin is Admin " +
            "and above)."
        : " The token may not read this. It needs the read scopes (org:read, " +
            "project:read, team:read, event:read), and its user needs access to " +
            "the organization or project.";
    case 404:
      return (
        " Nothing with that slug or id exists, or this token's user cannot " +
        "see it. list_projects and list_issues give valid slugs and ids."
      );
    case 429:
      return " Rate limited. Wait before calling again.";
    default:
      if (status < 500) return "";
      return write
        ? " GlitchTip is failing on its side. The write may or may not have " +
            "landed: read the issue or project before trying again."
        : " GlitchTip is failing on its side; a read is safe to retry shortly.";
  }
}

function detail(raw: string): string {
  try {
    const body = JSON.parse(raw) as unknown;
    if (body && typeof body === "object" && "detail" in body) {
      const d = (body as { detail: unknown }).detail;
      return (typeof d === "string" ? d : JSON.stringify(d)).slice(0, 300);
    }
  } catch {
    // Not JSON: an HTML error page from a proxy is not worth quoting in full.
  }
  return raw.replace(/\s+/g, " ").trim().slice(0, 200);
}

export interface CreateClientOptions {
  config: GlitchTipConfig;
  /** Injected in tests. Production uses the global. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export function createClient(options: CreateClientOptions): GlitchTipClient {
  const { config } = options;
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const scrub = scrubber(config.apiToken);

  async function send(
    method: "GET" | WriteMethod,
    path: string,
    query: Record<string, QueryValue>,
    body: unknown,
  ): Promise<{ body: unknown; response: Response }> {
    const url = new URL(`${config.baseUrl}${path}`);
    for (const [key, v] of Object.entries(query)) {
      if (v === undefined) continue;
      if (Array.isArray(v)) for (const item of v) url.searchParams.append(key, item);
      else url.searchParams.set(key, String(v));
    }
    const write = method !== "GET";
    const what = `GlitchTip (${method} ${path})`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${config.apiToken}`,
      Accept: "application/json",
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    let text: string;
    try {
      response = await doFetch(url.toString(), {
        method,
        signal: controller.signal,
        redirect: "error",
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      text = await response.text();
    } catch (err) {
      if (controller.signal.aborted) {
        throw new GlitchTipApiError(
          `${what} timed out after ${timeoutMs} ms.` +
            (write ? " The write may have landed: read before trying again." : ""),
          0,
        );
      }
      // undici reports every transport failure as "fetch failed" and keeps
      // the reason (DNS, TLS, a refused redirect) on `cause`.
      const inner = err instanceof Error ? (err as Error & { cause?: unknown }).cause : undefined;
      const cause =
        (err instanceof Error ? err.message : String(err)) +
        (inner instanceof Error ? ` (${inner.message})` : "");
      throw new GlitchTipApiError(
        scrub(
          `${what} failed before any answer: ${cause}. Check that ` +
            `GLITCHTIP_BASE_URL is the GlitchTip's own URL (a redirect is ` +
            `refused, so an http:// URL that redirects to https:// fails here).`,
        ),
        0,
      );
    } finally {
      clearTimeout(timer);
    }

    if (response.status >= 200 && response.status < 300) {
      try {
        return { body: text === "" ? undefined : JSON.parse(text), response };
      } catch {
        throw new GlitchTipApiError(
          `${what} answered ${response.status} with a body that is not JSON; ` +
            `GLITCHTIP_BASE_URL may point at something other than GlitchTip.`,
          response.status,
        );
      }
    }
    throw new GlitchTipApiError(
      scrub(
        `${what} answered HTTP ${response.status}: ${detail(text) || "no detail"}.` +
          advice(response.status, write),
      ),
      response.status,
    );
  }

  return {
    async get<T>(path: string, query: Record<string, QueryValue> = {}) {
      const { body, response } = await send("GET", path, query, undefined);
      return { body: body as T, nextCursor: nextCursor(response.headers.get("link")) };
    },
    async write<T>(method: WriteMethod, path: string, body?: unknown) {
      const answer = await send(method, path, {}, body);
      return answer.body as T | undefined;
    },
  };
}
