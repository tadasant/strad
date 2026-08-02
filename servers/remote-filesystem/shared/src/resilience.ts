/**
 * Two fixes for one production symptom: `ERR_STREAM_PREMATURE_CLOSE`
 * ("Invalid response body ... Premature close") out of the GCS SDK's OAuth token
 * exchange. Both are load-bearing on App Platform and neither is theoretical —
 * without them, uploads fail in bursts and no amount of retrying helps.
 */

import http from "node:http";
import https from "node:https";

/**
 * Open a fresh socket per request instead of reusing a pooled keep-alive one.
 *
 * Node 19+ defaults the global agent to `keepAlive: true`. The SDK's auth path
 * (`google-auth-library` -> `gtoken` -> `gaxios` -> `node-fetch` 2.x) reuses
 * those pooled sockets to mint a token. When a middlebox in the egress path
 * resets a keep-alive connection, node-fetch surfaces it as a premature close
 * and the whole operation dies — DETERMINISTICALLY, per request, because every
 * attempt rides the same poisoned socket. Retry cannot heal it; only not being
 * on that path can.
 *
 * gtoken builds its own gaxios instance with no per-client agent hook, so the
 * process-global agent is the only reachable place to turn keep-alive off. This
 * tree's sole outbound traffic is GCS, so process-global is effectively scoped.
 *
 * Idempotent — safe to call on every client construction.
 */
export function disableHttpKeepAlive(): void {
  if (keepAliveOption(https.globalAgent) !== false) {
    https.globalAgent = new https.Agent({ keepAlive: false });
  }
  if (keepAliveOption(http.globalAgent) !== false) {
    http.globalAgent = new http.Agent({ keepAlive: false });
  }
}

function keepAliveOption(agent: http.Agent): boolean | undefined {
  return (agent as http.Agent & { options?: http.AgentOptions }).options
    ?.keepAlive;
}

/**
 * Error text that identifies a transient connection-level failure.
 *
 * Deliberately EXCLUDED: `ENOTFOUND`, `ECONNREFUSED`, `EHOSTUNREACH`,
 * `ENETUNREACH`. Those are configuration errors wearing a network costume — a
 * wrong endpoint, nothing listening, a sandbox with no egress — and retrying
 * them burns the whole backoff budget before surfacing the real cause.
 */
const TRANSIENT_PATTERNS = [
  "premature close",
  "unexpected connection closure",
  "socket hang up",
  "econnreset",
  "etimedout",
  "eai_again",
  "epipe",
  "socket connection timeout",
];

/** Message/code text from an error and its nested causes, flattened for matching. */
function errorText(err: unknown, depth = 0): string {
  if (!err || depth > 5) return "";
  const e = err as {
    message?: unknown;
    code?: unknown;
    cause?: unknown;
    errors?: unknown;
  };
  const parts: string[] = [];
  if (typeof e.message === "string") parts.push(e.message);
  if (typeof e.code === "string" || typeof e.code === "number") {
    parts.push(String(e.code));
  }
  // GCS ApiError carries its reasons in a nested array.
  if (Array.isArray(e.errors)) {
    for (const nested of e.errors) parts.push(errorText(nested, depth + 1));
  }
  if (e.cause && e.cause !== err) parts.push(errorText(e.cause, depth + 1));
  return parts.join(" ");
}

export function isTransientConnectionError(err: unknown): boolean {
  const haystack = errorText(err).toLowerCase();
  return haystack !== "" && TRANSIENT_PATTERNS.some((p) => haystack.includes(p));
}

export interface RetryOptions {
  /** Total attempts, including the first. Default 4. */
  maxAttempts?: number;
  /** Delay before the first retry, in ms. Default 250. */
  initialDelayMs?: number;
  /** Ceiling on any single backoff, in ms. Default 4000. */
  maxDelayMs?: number;
  /** Backoff multiplier. Default 2. */
  multiplier?: number;
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
  /** Injectable for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `fn`, retrying with exponential backoff on a transient connection error.
 * Everything else — a 403, a missing object, a bad key — is rethrown at once,
 * because a permanent error retried four times is just a slower permanent error.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 4;
  const initialDelayMs = options.initialDelayMs ?? 250;
  const maxDelayMs = options.maxDelayMs ?? 4000;
  const multiplier = options.multiplier ?? 2;
  const sleep = options.sleep ?? defaultSleep;

  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      if (attempt >= maxAttempts || !isTransientConnectionError(err)) throw err;
      const delayMs = Math.min(
        initialDelayMs * multiplier ** (attempt - 1),
        maxDelayMs,
      );
      options.onRetry?.(err, attempt, delayMs);
      await sleep(delayMs);
    }
  }
}
