/**
 * The failures this server classifies, and why each one is its own type.
 *
 * Every class below exists because its RECOVERY differs. A caller that cannot
 * tell "this flight does not exist" from "your plan does not include this
 * endpoint" from "slow down" will retry the wrong one — and here a retry is not
 * free, it is another billed query.
 */

/**
 * AeroAPI answered with a failure. `title` and `detail` are AeroAPI's own error
 * fields (`{title, reason, detail, status}`), already scrubbed of the key and
 * capped in length by the client.
 */
export class AeroApiError extends Error {
  readonly status: number;
  readonly retryable: boolean;

  constructor(message: string, status: number, retryable = false) {
    super(message);
    this.name = "AeroApiError";
    this.status = status;
    this.retryable = retryable;
  }
}

/** 401: the key was rejected. A human mints a new one; no retry helps. */
export class AuthError extends AeroApiError {
  constructor(message: string, status: number) {
    super(message, status);
    this.name = "AuthError";
  }
}

/**
 * 402 / 403: the key is valid and the account may not make THIS query.
 *
 * Separate from `AuthError` because the fix is different: the key works for
 * other endpoints, and what is missing is a tier (or a positive balance) on the
 * account. Telling the caller to rotate the key would send a human to the wrong
 * page.
 */
export class PlanError extends AeroApiError {
  constructor(message: string, status: number) {
    super(message, status);
    this.name = "PlanError";
  }
}

/** 404: no such flight / airport / operator, or it aged out of the window. */
export class NotFoundError extends AeroApiError {
  constructor(message: string, status: number) {
    super(message, status);
    this.name = "NotFoundError";
  }
}

/**
 * 429: the account's per-second / per-minute rate limit.
 *
 * NOT retried inside the client. A tool call that sleeps and retries hides the
 * limit from the caller, which is the one party that can space its calls out;
 * the `Retry-After` AeroAPI sent is carried instead so the wait can be
 * scheduled.
 */
export class RateLimitError extends AeroApiError {
  readonly retryAfterSeconds?: number;

  constructor(message: string, status: number, retryAfterSeconds?: number) {
    super(message, status, true);
    this.name = "RateLimitError";
    if (retryAfterSeconds !== undefined)
      this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** A caller-supplied argument refused before spending a billed query on it. */
export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputError";
  }
}
