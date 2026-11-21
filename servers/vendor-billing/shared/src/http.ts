/**
 * The one HTTP call every tool makes, and the one error shape it fails with.
 *
 * Every URL is built by this server from constants and validated parts:
 * nothing fetches a URL a caller or a response supplied (a response's ids are
 * at most an encoded path segment on the same fixed host), and a redirect is
 * refused rather than followed with a credential attached. Every request is
 * bounded by a timeout.
 *
 * AN UPSTREAM ERROR IS QUOTED SPARINGLY. Only the vendor's own `message` (or
 * `error_description`) is kept, cut to 300 characters, and never a header.
 * The caller scrubs the whole error again before it leaves the server.
 */

export const REQUEST_TIMEOUT_MS = 30_000;

export class UpstreamError extends Error {
  constructor(
    message: string,
    /** 0 is a failure before any HTTP answer. */
    readonly status: number,
  ) {
    super(message);
    this.name = "UpstreamError";
  }
}

export interface HttpOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /**
   * An absolute `Date.now()` past which no request starts, and which bounds
   * the one in flight. A tool that makes several requests sets it, so the
   * whole call ends inside the gateway's own tool-call timeout with this
   * server's error rather than a generic one.
   */
  deadline?: number;
}

/** A deadline `ms` from now, for a tool that makes more than one request. */
export function deadlineIn(ms: number, http: HttpOptions): HttpOptions {
  return { ...http, deadline: Math.min(http.deadline ?? Infinity, Date.now() + ms) };
}

export interface JsonRequest {
  /** How the request reads in an error, e.g. "OpenRouter (GET /credits)". */
  what: string;
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
  /** What a status means for THIS vendor, appended to the error. */
  advice?: (status: number) => string;
}

/** The vendor's own explanation, if the body carries one, and nothing else. */
export function upstreamDetail(raw: string): string {
  try {
    const body = JSON.parse(raw) as Record<string, unknown>;
    const err = body?.error;
    if (err && typeof err === "object") {
      const m = (err as Record<string, unknown>).message;
      if (typeof m === "string") return m.slice(0, 300);
    }
    if (typeof err === "string") {
      const d = body.error_description;
      return (typeof d === "string" ? `${err}: ${d}` : err).slice(0, 300);
    }
    if (typeof body?.message === "string") return body.message.slice(0, 300);
  } catch {
    // Not JSON: an HTML error page from a proxy is not worth quoting.
  }
  return "";
}

export async function requestJson<T>(request: JsonRequest, options: HttpOptions = {}): Promise<T> {
  const doFetch = options.fetchImpl ?? fetch;
  const left = options.deadline === undefined ? Infinity : options.deadline - Date.now();
  if (left <= 0) {
    throw new UpstreamError(`${request.what} was not attempted: this call ran out of time. A read is safe to retry.`, 0);
  }
  const timeoutMs = Math.min(options.timeoutMs ?? REQUEST_TIMEOUT_MS, left);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  let text: string;
  try {
    response = await doFetch(request.url, {
      method: request.method,
      headers: { Accept: "application/json", ...request.headers },
      ...(request.body !== undefined ? { body: request.body } : {}),
      redirect: "error",
      signal: controller.signal,
    });
    text = await response.text();
  } catch (err) {
    if (controller.signal.aborted) {
      throw new UpstreamError(`${request.what} timed out after ${timeoutMs} ms. A read is safe to retry.`, 0);
    }
    const inner = err instanceof Error ? (err as Error & { cause?: unknown }).cause : undefined;
    const cause =
      (err instanceof Error ? err.message : String(err)) +
      (inner instanceof Error ? ` (${inner.message})` : "");
    throw new UpstreamError(`${request.what} failed before any answer: ${cause}.`, 0);
  } finally {
    clearTimeout(timer);
  }

  if (response.status >= 200 && response.status < 300) {
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new UpstreamError(`${request.what} answered ${response.status} with a body that is not JSON.`, response.status);
    }
    // Every answer this server reads is an object; `null` or a bare value is
    // not one, and is refused here rather than crashing a reader below.
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      throw new UpstreamError(`${request.what} answered ${response.status} with a body that is not a JSON object.`, response.status);
    }
    return body as T;
  }
  const detail = upstreamDetail(text);
  throw new UpstreamError(
    `${request.what} answered HTTP ${response.status}${detail ? `: ${detail}` : ""}.` +
      (request.advice?.(response.status) ?? genericAdvice(response.status)),
    response.status,
  );
}

export function genericAdvice(status: number): string {
  if (status === 429) return " Rate limited. Wait before calling again.";
  if (status >= 500) return " The vendor is failing on its side; a read is safe to retry shortly.";
  return "";
}
