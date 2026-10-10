/**
 * The thin HTTP layer over AeroAPI v4: one header, one base URL, one error
 * shape, one pagination convention — and the rules that keep a tool call from
 * spending more than it says.
 *
 *   AUTH is a static key in a header named `x-apikey`. Not `Authorization`.
 *
 *   BILLING is per query, and on a list endpoint per RESULT SET: AeroAPI
 *   answers a list in pages (15 flights a page on most endpoints) and bills
 *   each page it returns. `max_pages` on the way in is how many pages ONE
 *   request may come back with; this server forwards a small, capped value and
 *   never walks `links.next` on its own. The caller gets the cursor and decides
 *   whether the next page is worth paying for.
 *
 *   PAGINATION is `links.next`, a URI-reference such as
 *   `/flights/search?query=...&cursor=abc`. Only its `cursor` parameter is
 *   handed back — the caller repeats its own arguments and adds `cursor`, so it
 *   never has to (and cannot) smuggle a path through it.
 *
 *   ERRORS are `{title, reason, detail, status}`. They are summarised and
 *   capped here, and scrubbed of the literal key before any error is built.
 *
 *   NO RETRIES. A 429 or a 5xx is reported, not re-sent: a retried query can be
 *   a second billed query, and the caller is the only party that knows whether
 *   it still wants the answer.
 *
 * @see https://www.flightaware.com/aeroapi/portal/documentation
 */

import { ENV, type AeroConfig } from "./config.js";
import {
  AeroApiError,
  AuthError,
  NotFoundError,
  PlanError,
  RateLimitError,
} from "./errors.js";
import { logWarning, scrubLiteral } from "./logging.js";

/** Every request is bounded; an unanswered socket must not park a tool call. */
export const REQUEST_TIMEOUT_MS = 30_000;

/** The ceiling on `max_pages` any tool forwards. Each page is billed. */
export const MAX_PAGES_CAP = 3;

/** How much of an upstream error body reaches a caller. */
const ERROR_TEXT_CAP = 300;

export type Query = Record<string, string | number | boolean | undefined>;

export interface AeroClient {
  get<T>(path: string, query?: Query): Promise<T>;
}

export interface CreateClientOptions {
  config: AeroConfig;
  /** Injected in tests. Production uses the global. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** AeroAPI's error body, defensively: a load balancer can answer with HTML. */
export function describeError(body: unknown, status: number): string {
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    const parts = [b.title, b.detail ?? b.reason]
      .filter((p): p is string => typeof p === "string" && p.trim() !== "")
      .map((p) => p.trim());
    if (parts.length > 0) {
      const text = parts.join(": ");
      return text.length > ERROR_TEXT_CAP
        ? `${text.slice(0, ERROR_TEXT_CAP)}…`
        : text;
    }
  }
  return `AeroAPI answered HTTP ${status}`;
}

/**
 * `Retry-After` in seconds. RFC 9110 allows two forms — delta-seconds or an
 * HTTP-date — and the date form is turned into the seconds left until it, so
 * the caller is handed one unit whichever one AeroAPI (or a proxy in front of
 * it) sent. A date already past is 0: the wait is over.
 */
export function retryAfterSeconds(
  headers: Headers,
  now: number = Date.now(),
): number | undefined {
  const raw = headers.get("retry-after")?.trim();
  if (!raw) return undefined;
  if (/^\d+$/.test(raw)) return Number(raw);
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, Math.ceil((at - now) / 1000));
}

export function createClient(options: CreateClientOptions): AeroClient {
  const { config } = options;
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const scrub = (text: string) => scrubLiteral(text, config.apiKey);

  return {
    async get<T>(path: string, query: Query = {}): Promise<T> {
      const url = new URL(`${config.baseUrl}${path}`);
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined) continue;
        url.searchParams.set(key, String(value));
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      let text: string;
      try {
        response = await doFetch(url.toString(), {
          method: "GET",
          headers: { "x-apikey": config.apiKey, Accept: "application/json" },
          signal: controller.signal,
        });
        text = await response.text();
      } catch (err) {
        if (controller.signal.aborted) {
          throw new AeroApiError(
            `AeroAPI did not answer GET ${path} within ${timeoutMs / 1000}s. ` +
              `The query may or may not have been billed; wait before retrying.`,
            0,
            true,
          );
        }
        throw new AeroApiError(
          scrub(
            `Could not reach AeroAPI for GET ${path}: ` +
              (err instanceof Error ? err.message : String(err)),
          ),
          0,
          true,
        );
      } finally {
        clearTimeout(timer);
      }

      let body: unknown = undefined;
      let parsed = false;
      if (text !== "") {
        try {
          body = JSON.parse(text);
          parsed = true;
        } catch {
          body = undefined;
        }
      }

      const status = response.status;
      if (status >= 200 && status < 300) {
        // A 2xx that is not a JSON object is a proxy or a captive portal, not
        // AeroAPI. Read as `{}` it would become "no flights" — a confident,
        // wrong, billed answer — so it is a failure the caller can retry.
        const isObject =
          parsed &&
          body !== null &&
          typeof body === "object" &&
          !Array.isArray(body);
        if (text !== "" && !isObject) {
          logWarning(`HTTP ${status} with a non-JSON body on GET ${path}`);
          throw new AeroApiError(
            `AeroAPI answered HTTP ${status} with a non-JSON body for GET ` +
              `${path}. Something between here and FlightAware answered ` +
              `instead; retry later.`,
            status,
            true,
          );
        }
        return body as T;
      }

      // Scrubbed HERE, once, so nothing built below can carry the key even if
      // AeroAPI echoed it back into its own message.
      const described = scrub(describeError(body, status));

      if (status === 401) {
        throw new AuthError(
          `AeroAPI rejected the key (HTTP 401: ${described}). Check that ` +
            `${ENV.apiKey} is a current AeroAPI v4 key — a key deleted or ` +
            `regenerated in the AeroAPI portal stops working at once. In strad ` +
            `the variable may carry a slug prefix (e.g. ` +
            `FLIGHTAWARE__${ENV.apiKey}). Retrying will not help.`,
          status,
        );
      }
      if (status === 402 || status === 403) {
        throw new PlanError(
          `AeroAPI refused this query for this account (HTTP ${status}: ` +
            `${described}). The key is valid; the account's AeroAPI tier does ` +
            `not include this endpoint, or the account is out of credit. A ` +
            `human checks the plan and billing in the AeroAPI portal. Retrying ` +
            `will not help.`,
          status,
        );
      }
      if (status === 404) {
        // The flight window is a fact about /flights/ only; an airport or an
        // operator does not age out.
        const window = path.startsWith("/flights/")
          ? ` or the flight may be older than AeroAPI's ~10-day window`
          : "";
        throw new NotFoundError(
          `AeroAPI found nothing at GET ${path} (HTTP 404: ${described}). The ` +
            `identifier may be wrong${window}.`,
          status,
        );
      }
      if (status === 429) {
        const after = retryAfterSeconds(response.headers);
        throw new RateLimitError(
          `AeroAPI is rate-limiting this account (HTTP 429: ${described}). ` +
            `Wait${after === undefined ? "" : ` ${after}s`} before the next ` +
            `call, and space calls out — the limit is per account tier.`,
          status,
          after,
        );
      }
      if (status === 400) {
        throw new AeroApiError(
          `AeroAPI rejected the request (HTTP 400: ${described}). Fix the ` +
            `arguments rather than retrying.`,
          status,
        );
      }
      if (status >= 500) {
        logWarning(`HTTP ${status} on GET ${path}`);
        throw new AeroApiError(
          `AeroAPI failed (HTTP ${status}: ${described}). This is on ` +
            `FlightAware's side; retry later.`,
          status,
          true,
        );
      }
      throw new AeroApiError(
        `AeroAPI answered HTTP ${status}: ${described}`,
        status,
      );
    },
  };
}

/**
 * The `cursor` out of a `links.next` URI-reference, or undefined at the end.
 *
 * Only the cursor is extracted: the rest of the link restates the caller's own
 * arguments, and following a server-supplied path verbatim is a way to be
 * steered to an endpoint the caller never asked for.
 */
export function nextCursor(links: unknown): string | undefined {
  if (!links || typeof links !== "object") return undefined;
  const next = (links as Record<string, unknown>).next;
  if (typeof next !== "string" || next === "") return undefined;
  try {
    const cursor = new URL(next, "https://aeroapi.invalid").searchParams.get(
      "cursor",
    );
    return cursor === null || cursor === "" ? undefined : cursor;
  } catch {
    return undefined;
  }
}
