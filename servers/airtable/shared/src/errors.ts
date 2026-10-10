/**
 * The failures this server classifies. Each class exists because its RECOVERY
 * differs: fix the arguments, fix the token, wait, or report it.
 */

/**
 * Airtable answered, and answered with a failure.
 *
 * `type` is Airtable's own error code (`INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND`,
 * `UNKNOWN_FIELD_NAME`, …) — the thing its documentation is indexed by.
 * `retryable` is the one bit a caller has to decide on without reading prose.
 */
export class AirtableApiError extends Error {
  readonly status: number;
  readonly type?: string;
  readonly retryable: boolean;

  constructor(
    message: string,
    status: number,
    type?: string,
    retryable = false,
  ) {
    super(message);
    this.name = "AirtableApiError";
    this.status = status;
    if (type !== undefined) this.type = type;
    this.retryable = retryable;
  }
}

/**
 * Airtable's limit is 5 requests per second PER BASE, and after a 429 it asks
 * clients to wait 30 seconds before the next one. Not retried inside the call:
 * a tool call that silently sleeps half a minute looks hung, and the caller is
 * the one that knows whether it is mid-sweep and should slow down.
 */
export class RateLimitError extends AirtableApiError {
  readonly retryAfterSeconds: number;

  constructor(message: string, retryAfterSeconds: number) {
    super(message, 429, "RATE_LIMITED", true);
    this.name = "RateLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** The request never got an answer: a timeout or a network failure. */
export class TransportError extends AirtableApiError {
  constructor(message: string) {
    super(message, 0, "TRANSPORT", true);
    this.name = "TransportError";
  }
}

/** A caller-supplied argument this server refuses before spending a call on it. */
export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputError";
  }
}
