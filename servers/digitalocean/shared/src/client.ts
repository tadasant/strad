/**
 * The thin HTTP layer over the DigitalOcean API: one header, one base URL, one
 * error shape, one pagination convention, one timeout.
 *
 *   AUTH is `Authorization: Bearer <token>` on every request to the API origin,
 *   and on NOTHING else. App Platform logs are served from signed URLs on a
 *   different origin; `fetchExternalText` fetches those with no credential at
 *   all, because a bearer token sent to a host that is not
 *   api.digitalocean.com is a token handed to whoever runs that host.
 *
 *   A LOG LINK IS FETCHED ON A SHORT LEASH. The host must be DigitalOcean's
 *   (`LOG_HOST_SUFFIXES`), a redirect is an error rather than a hop to a host
 *   nobody checked, and the body is STREAMED into a ring buffer that keeps its
 *   last `LOG_FETCH_CAP_BYTES` — a log of any size costs this process at most
 *   that, and the tail is the part apps-get-logs returns anyway.
 *
 *   ERRORS are `{"id": "not_found", "message": "...", "request_id": "..."}`.
 *
 *   PAGINATION is `page` / `per_page` in, `meta.total` and `links.pages.next`
 *   out. This layer fetches exactly the page asked for; nothing here walks.
 *
 *   EVERY REQUEST is bounded at 30 s by an AbortController. A request that hangs
 *   is otherwise a tool call that hangs inside a process shared with the rest of
 *   the bundle.
 *
 * @see https://docs.digitalocean.com/reference/api/digitalocean/
 */

import { DEFAULT_BASE_URL, type DigitalOceanConfig } from "./config.js";
import { DigitalOceanApiError, TimeoutError } from "./errors.js";

export const REQUEST_TIMEOUT_MS = 30_000;

/** The most of a stored log held in memory: its last 2 MB. */
export const LOG_FETCH_CAP_BYTES = 2 * 1024 * 1024;

/**
 * Where a log link may point: DigitalOcean-owned domains. Spaces (object
 * storage, `*.digitaloceanspaces.com`) and DigitalOcean's own
 * `*.digitalocean.com`, minus the API host. NOT `*.ondigitalocean.app`: that is
 * where customers' apps live, so a host there is anyone's. The exact host
 * App Platform signs its links for is not documented; these suffixes are the
 * permissive reading of "DigitalOcean's storage".
 */
export const LOG_HOST_SUFFIXES = [
  ".digitaloceanspaces.com",
  ".digitalocean.com",
] as const;

export interface ExternalText {
  /** The text kept: the whole body, or its last `kept_bytes` when truncated. */
  text: string;
  /** Every byte the body carried, kept or not. */
  bytes: number;
  kept_bytes: number;
  /** The body was larger than the cap and only its end was kept. */
  truncated: boolean;
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  /** Query parameters. `undefined` values are dropped rather than sent empty. */
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}

export interface DigitalOceanClient {
  /** The parsed JSON body; `undefined` for a 202/204 with none. */
  request<T>(path: string, options?: RequestOptions): Promise<T>;
  /**
   * GET a URL on a DigitalOcean storage host with no credential and no
   * redirects, returning at most the last `LOG_FETCH_CAP_BYTES` of its text.
   * Used for the signed log links App Platform hands back.
   */
  fetchExternalText(url: string): Promise<ExternalText>;
}

export interface CreateClientOptions {
  config: DigitalOceanConfig;
  /** Injected in tests. Production uses the global. */
  fetchImpl?: typeof fetch;
  /** Injected in tests, so the timeout path costs no wall clock. */
  timeoutMs?: number;
  /** Injected in tests, so the cap is reachable without a 2 MB fixture. */
  logCapBytes?: number;
}

/**
 * Read a body to its end, keeping only the last `cap` bytes: chunks are queued
 * and dropped from the front as the total passes the cap, so memory is bounded
 * by the cap plus one chunk whatever the body's size. A cut that lands inside a
 * line drops that partial first line, and a cut inside a UTF-8 sequence drops
 * the broken character.
 */
export async function readTail(
  body: ReadableStream<Uint8Array> | null,
  cap: number,
): Promise<ExternalText> {
  const chunks: Uint8Array[] = [];
  let held = 0;
  let bytes = 0;
  if (body) {
    const reader = body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.length === 0) continue;
      bytes += value.length;
      chunks.push(value);
      held += value.length;
      while (chunks.length > 0 && held - chunks[0]!.length >= cap) {
        held -= chunks.shift()!.length;
      }
    }
  }
  let buf = Buffer.concat(chunks);
  const truncated = bytes > cap;
  if (buf.length > cap) buf = buf.subarray(buf.length - cap);
  let text = buf.toString("utf8");
  if (truncated) {
    const newline = text.indexOf("\n");
    text =
      newline === -1 ? text.replace(/^\uFFFD+/, "") : text.slice(newline + 1);
  }
  return {
    text,
    bytes,
    kept_bytes: Buffer.byteLength(text, "utf8"),
    truncated,
  };
}

/**
 * Is `host` one a log link may point at? See LOG_HOST_SUFFIXES. The configured
 * API host and the production one are both excluded, so a test or staging base
 * URL does not open the real API to a credential-less request.
 */
export function isLogHost(host: string, apiHost: string): boolean {
  const h = host.toLowerCase();
  return (
    h !== apiHost.toLowerCase() &&
    h !== new URL(DEFAULT_BASE_URL).hostname &&
    LOG_HOST_SUFFIXES.some((suffix) => h.endsWith(suffix))
  );
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

/** Summarise an error body: DO's `message` if it sent one, else a capped slice. */
function describe(
  status: number,
  body: unknown,
  raw: string,
): {
  text: string;
  code?: string;
  requestId?: string;
} {
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    const message = typeof b.message === "string" ? b.message : undefined;
    const code = typeof b.id === "string" ? b.id : undefined;
    const requestId =
      typeof b.request_id === "string" ? b.request_id : undefined;
    if (message !== undefined) {
      return {
        text: message.slice(0, 500),
        ...(code === undefined ? {} : { code }),
        ...(requestId === undefined ? {} : { requestId }),
      };
    }
  }
  // An HTML page from a load balancer is not worth quoting in full.
  const snippet = raw.replace(/\s+/g, " ").trim().slice(0, 200);
  return { text: snippet === "" ? `HTTP ${status}` : snippet };
}

/** What the status MEANS for the caller's next move, appended to DO's message. */
function advice(status: number): string {
  switch (status) {
    case 401:
      return (
        " DigitalOcean rejected the token: it is invalid, expired or revoked. " +
        "A human mints a new one at https://cloud.digitalocean.com/account/api/tokens. " +
        "Retrying will not help."
      );
    case 403:
      return (
        " The token is valid but lacks the scope this call needs (custom-scoped " +
        "tokens carry only the scopes chosen when they were minted — see the " +
        "server README for the list). Retrying will not help."
      );
    case 404:
      return " Nothing with that id exists on this account (or the token cannot see it).";
    case 422:
      return " DigitalOcean refused the arguments; the message above says which.";
    case 429:
      return (
        " Rate limited (DigitalOcean allows 5,000 requests an hour and 250 a " +
        "minute per token). Wait before calling again."
      );
    default:
      return status >= 500
        ? " DigitalOcean is failing on its side; a read is safe to retry shortly."
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

export function createClient(options: CreateClientOptions): DigitalOceanClient {
  const { config } = options;
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const scrub = scrubber(config.apiToken);
  const apiHost = new URL(config.baseUrl).hostname;
  const logCap = options.logCapBytes ?? LOG_FETCH_CAP_BYTES;

  return {
    async request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
      const method = opts.method ?? "GET";
      const url = new URL(`${config.baseUrl}${path}`);
      for (const [key, value] of Object.entries(opts.query ?? {})) {
        if (value === undefined) continue;
        url.searchParams.set(key, String(value));
      }

      const { status, text } = await withTimeout(
        `DigitalOcean (${method} ${path})`,
        timeoutMs,
        async (signal) => {
          const response = await doFetch(url.toString(), {
            method,
            signal,
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
      throw new DigitalOceanApiError(
        scrub(
          `DigitalOcean answered HTTP ${status} to ${method} ${path}` +
            (described.code ? ` (${described.code})` : "") +
            `: ${described.text}.${advice(status)}` +
            (described.requestId ? ` request_id: ${described.requestId}` : ""),
        ),
        status,
        described.code,
        described.requestId,
      );
    },

    async fetchExternalText(raw: string): Promise<ExternalText> {
      let url: URL;
      try {
        url = new URL(raw);
      } catch {
        throw new DigitalOceanApiError(
          "DigitalOcean returned a log link that is not a URL.",
          502,
        );
      }
      // HTTPS only, on a DigitalOcean storage host on the default port, and
      // never the API host: the request below carries no credential, and the
      // API without one would only 401.
      if (
        url.protocol !== "https:" ||
        url.port !== "" ||
        !isLogHost(url.hostname, apiHost)
      ) {
        throw new DigitalOceanApiError(
          `DigitalOcean returned a log link this server will not follow ` +
            `(${url.protocol}//${url.host}); only an https link on ` +
            `DigitalOcean's log storage (a host ending ` +
            `${LOG_HOST_SUFFIXES.join(" or ")}) is fetched.`,
          502,
        );
      }
      return withTimeout("The log storage link", timeoutMs, async (signal) => {
        let response: Response;
        try {
          // NO Authorization header, deliberately. The link is pre-signed; the
          // DigitalOcean token is for api.digitalocean.com and nowhere else.
          // NO redirects: the host was checked, the one a 3xx names was not.
          response = await doFetch(url.toString(), {
            method: "GET",
            signal,
            redirect: "error",
          });
        } catch (err) {
          if (signal.aborted) throw err;
          throw new DigitalOceanApiError(
            `Fetching the logs from their signed link failed before any ` +
              `answer (a redirect, which this server refuses, fails this ` +
              `way too). Call apps-get-logs again for a fresh link.`,
            502,
          );
        }
        // A fetch that ignores `redirect: "error"` still does not get to hop.
        if (response.status >= 300 && response.status < 400) {
          await response.body?.cancel();
          throw new DigitalOceanApiError(
            `The log storage link answered with a redirect (HTTP ` +
              `${response.status}), which this server does not follow.`,
            502,
          );
        }
        if (response.status < 200 || response.status >= 300) {
          await response.body?.cancel();
          throw new DigitalOceanApiError(
            scrub(
              `Fetching the logs from their signed link failed with HTTP ` +
                `${response.status}. The link expires within minutes; call ` +
                `apps-get-logs again for a fresh one.`,
            ),
            response.status,
          );
        }
        return readTail(response.body, logCap);
      });
    },
  };
}

export interface Page<T> {
  items: T[];
  page: number;
  per_page: number;
  /** DigitalOcean's `meta.total`, when it sent one. */
  total?: number;
  has_next_page: boolean;
  /** Pass this back as `page` to continue; absent on the last page. */
  next_page?: number;
}

/** DigitalOcean's list envelope: the collection under its own key, plus meta/links. */
interface ListEnvelope {
  meta?: { total?: number };
  links?: { pages?: { next?: string } };
  [key: string]: unknown;
}

/**
 * Exactly ONE page of a collection. The caller asks for the next one; this
 * never walks, because a large account would spend a rate budget inside one
 * tool call and an agent rarely needs every row.
 */
export async function listPage<T>(
  client: DigitalOceanClient,
  path: string,
  key: string,
  page: number,
  perPage: number,
  query: Record<string, string | number | boolean | undefined> = {},
): Promise<Page<T>> {
  const body = await client.request<ListEnvelope>(path, {
    query: { ...query, page, per_page: perPage },
  });
  const raw = body?.[key];
  const items = Array.isArray(raw) ? (raw as T[]) : [];
  const total = body?.meta?.total;
  const hasNext =
    typeof body?.links?.pages?.next === "string" ||
    (typeof total === "number" && page * perPage < total);
  return {
    items,
    page,
    per_page: perPage,
    ...(typeof total === "number" ? { total } : {}),
    has_next_page: hasNext,
    ...(hasNext ? { next_page: page + 1 } : {}),
  };
}
