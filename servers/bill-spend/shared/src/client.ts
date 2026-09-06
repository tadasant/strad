/**
 * The thin HTTP layer over BILL Spend & Expense: one header, one base URL, one
 * error shape, one pagination convention.
 *
 * Everything above this file works in BILL's vocabulary and knows nothing about
 * transport. Everything BILL-specific about transport is here:
 *
 *   AUTH is a single static token in a header literally named `apiToken`. Not
 *   `Authorization: Bearer`. Getting this wrong is the fastest way to end up
 *   reading the AP/AR API's documentation, which wants a `sessionId` and a
 *   `devKey` and shares nothing with this one but a hostname.
 *
 *   ERRORS come back as an ARRAY of `BdcError` objects, not an object. A caller
 *   that reads `body.message` reads undefined on every failure BILL has.
 *
 *   PAGINATION is a cursor: `max` on the way in, `nextPage` / `prevPage` on the
 *   way back. The ceilings differ per endpoint (transactions cap at 50, custom
 *   fields and values at 100) and the caller states which it is asking for.
 *
 *   THE RATE LIMIT is 60 calls per token per MINUTE, which is low enough that a
 *   sweep of a few dozen transactions can reach it. Retried here with backoff
 *   rather than surfaced immediately, because the caller cannot do anything
 *   smarter than wait, and one server sharing a token with a human's browser
 *   session should be the one that yields.
 *
 * @see https://developer.bill.com/docs/authentication-with-api-token
 * @see https://developer.bill.com/docs/spend-expense-api
 */

import type { BillConfig } from "./config.js";
import {
  AuthError,
  BillApiError,
  RateLimitError,
  type BdcError,
} from "./errors.js";
import { logWarning } from "./logging.js";

/** BILL's documented ceiling on `max`, per endpoint family. */
export const PAGE_MAX = {
  /** `GET /v3/spend/transactions` — 1-50, default 20. */
  transactions: 50,
  /** `GET /v3/spend/custom-fields` and its `/values` — 1-100. */
  customFields: 100,
} as const;

export interface Page<T> {
  results: T[];
  nextPage?: string;
  prevPage?: string;
}

export interface RequestOptions {
  method?: "GET" | "PUT" | "POST";
  /** Query parameters. `undefined` values are dropped rather than sent empty. */
  query?: Record<string, string | number | undefined>;
  body?: unknown;
}

/**
 * What the tools call. Structural on purpose: the tests drive this interface
 * directly rather than intercepting `fetch`, so a suite that passes is evidence
 * about the request this server BUILDS and the reply it INTERPRETS, not about a
 * mock of an HTTP library.
 */
export interface BillHttp {
  request<T>(path: string, options?: RequestOptions): Promise<T>;
  /** The status of the last response, for a caller that needs to report it. */
  readonly environment: string;
}

/** Statuses worth trying again. 429 is the rate limit; 5xx is BILL being unwell. */
function isTransient(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

/**
 * BILL's `Retry-After`, in seconds, when it sent one.
 *
 * The header is defined in both seconds and HTTP-date forms; only the numeric
 * one is honoured, because a date form we misparse would be worse than the
 * backoff we would otherwise use.
 */
function retryAfterSeconds(headers: Headers): number | undefined {
  const raw = headers.get("retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw.trim());
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

/**
 * BILL's error array, defensively.
 *
 * A gateway in front of BILL can answer with HTML, and a 502 from a load
 * balancer is not shaped like anything BILL documents. Anything that is not the
 * documented array becomes an empty list, and the caller falls back to the
 * status.
 */
export function parseErrors(body: unknown): BdcError[] {
  if (!Array.isArray(body)) return [];
  return body.filter(
    (e): e is BdcError => typeof e === "object" && e !== null,
  );
}

/** One line a human can act on, out of BILL's array. */
export function describeErrors(errors: BdcError[], status: number): string {
  if (errors.length === 0) return `BILL answered HTTP ${status}`;
  return errors
    .map((e) =>
      [e.code, e.message ?? e.detail].filter(Boolean).join(": "),
    )
    .join("; ");
}

/**
 * Remove the literal token from text this server did not write.
 *
 * The shape rule in logging.ts is a BACKSTOP — it catches a credential-looking
 * run in text nobody anticipated, and it necessarily has a length threshold,
 * below which it cannot fire without also destroying every uuid this server
 * returns. This is the exact rule, and it belongs here because this is the only
 * module that holds the value.
 *
 * It matters because BILL echoes request material into some of its errors, and
 * an auth failure is exactly the case where it might echo the credential. Both
 * rules run: this one on the way out of the client, the shape rule again at the
 * tool boundary.
 */
function scrubber(token: string): (text: string) => string {
  // A short or empty token would make `split`/`join` catastrophic — splitting on
  // "" inserts the replacement between every character. `loadConfig` cannot
  // produce one, and a caller constructing a config by hand can.
  if (token.length < 8) return (text) => text;
  return (text) => text.split(token).join("[redacted]");
}

export interface CreateHttpOptions {
  config: BillConfig;
  /** Injected in tests. Production uses the global. */
  fetchImpl?: typeof fetch;
  /** Injected in tests, so a retry path costs no wall clock. */
  sleep?: (ms: number) => Promise<void>;
  /** How many times a transient failure is retried. */
  maxRetries?: number;
}

const DEFAULT_MAX_RETRIES = 3;

export function createHttp(options: CreateHttpOptions): BillHttp {
  const { config } = options;
  const doFetch = options.fetchImpl ?? fetch;
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const scrub = scrubber(config.apiToken);

  async function once(
    path: string,
    opts: RequestOptions,
  ): Promise<{ status: number; headers: Headers; body: unknown }> {
    const url = new URL(`${config.baseUrl}${path}`);
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value === undefined) continue;
      url.searchParams.set(key, String(value));
    }

    const response = await doFetch(url.toString(), {
      method: opts.method ?? "GET",
      headers: {
        // The whole credential, and the header name is exactly this.
        apiToken: config.apiToken,
        Accept: "application/json",
        ...(opts.body === undefined
          ? {}
          : { "Content-Type": "application/json" }),
      },
      ...(opts.body === undefined
        ? {}
        : { body: JSON.stringify(opts.body) }),
    });

    // A 204 and an HTML error page both fail to parse; neither is a reason to
    // throw something with no status in it.
    let body: unknown = undefined;
    const text = await response.text();
    if (text !== "") {
      try {
        body = JSON.parse(text);
      } catch {
        body = undefined;
      }
    }
    return { status: response.status, headers: response.headers, body };
  }

  return {
    environment: config.environment,

    async request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
      let attempt = 0;
      for (;;) {
        const { status, headers, body } = await once(path, opts);
        if (status >= 200 && status < 300) return body as T;

        const errors = parseErrors(body);
        // Scrubbed HERE, once, so no error constructed below can carry the
        // token even if BILL echoed it back into its own message.
        const described = scrub(describeErrors(errors, status));

        if (status === 401 || status === 403) {
          throw new AuthError(
            `BILL rejected this token (HTTP ${status}: ${described}). The ` +
              `${config.environment} token this server holds is not valid for ` +
              `the ${config.environment} environment — check that it is a Spend ` +
              `& Expense apiToken (not an AP/AR devKey) and that it was minted ` +
              `in the same environment this deployment points at. Retrying will ` +
              `not help.`,
            status,
            errors,
          );
        }

        if (isTransient(status) && attempt < maxRetries) {
          const after = retryAfterSeconds(headers);
          // BILL's own guidance is 2^n seconds. Its `Retry-After` wins when it
          // sends one, because it knows when the window rolls over and we do not.
          const waitMs = after !== undefined ? after * 1000 : 2 ** attempt * 1000;
          logWarning(
            `HTTP ${status} on ${opts.method ?? "GET"} ${path}; retry ` +
              `${attempt + 1}/${maxRetries} in ${waitMs}ms`,
          );
          await sleep(waitMs);
          attempt += 1;
          continue;
        }

        if (status === 429) {
          throw new RateLimitError(
            `BILL is rate-limiting this token (${described}). The limit is 60 ` +
              `calls per token per minute and this deployment has spent it. ` +
              `Wait a minute before calling again, and prefer one list_transactions ` +
              `page over many single reads.`,
            status,
            errors,
            retryAfterSeconds(headers),
          );
        }

        throw new BillApiError(described, status, errors);
      }
    },
  };
}

/**
 * Walk a cursor-paginated endpoint until `limit` results or the pages run out.
 *
 * BOUNDED BY DESIGN, and the bound is the caller's `limit` rather than a page
 * count: this server's rate budget is 60 calls a minute, and an unbounded walk
 * of a large chart of accounts would spend it inside one tool call. The result
 * says whether it stopped early, so a caller reading a truncated list knows it
 * is truncated rather than concluding a value does not exist.
 */
export async function paginate<T>(
  http: BillHttp,
  path: string,
  query: Record<string, string | number | undefined>,
  limit: number,
  pageMax: number,
): Promise<{ results: T[]; truncated: boolean; pages: number }> {
  const results: T[] = [];
  let cursor: string | undefined = undefined;
  let pages = 0;

  while (results.length < limit) {
    const page: Page<T> = await http.request<Page<T>>(path, {
      query: {
        ...query,
        max: Math.min(pageMax, limit - results.length),
        ...(cursor ? { nextPage: cursor } : {}),
      },
    });
    pages += 1;
    const batch = page.results ?? [];
    results.push(...batch);
    // An empty page with a cursor would loop forever; BILL does not do that, and
    // this server does not depend on it not doing it.
    if (!page.nextPage || batch.length === 0) {
      return { results, truncated: false, pages };
    }
    cursor = page.nextPage;
  }
  return { results: results.slice(0, limit), truncated: true, pages };
}
