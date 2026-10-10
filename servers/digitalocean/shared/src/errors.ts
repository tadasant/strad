/**
 * The failures this server classifies. Each class exists because its RECOVERY
 * differs: a scope a human has to add, a rate limit to wait out, an id that does
 * not exist, an argument the caller got wrong.
 */

/** DigitalOcean answered, and answered with a failure. */
export class DigitalOceanApiError extends Error {
  readonly status: number;
  /** DO's own error `id`, e.g. `not_found`, `unprocessable_entity`. */
  readonly code?: string;
  /** DO's `request_id`, which is what its support desk asks for. */
  readonly requestId?: string;

  constructor(
    message: string,
    status: number,
    code?: string,
    requestId?: string,
  ) {
    super(message);
    this.name = "DigitalOceanApiError";
    this.status = status;
    if (code !== undefined) this.code = code;
    if (requestId !== undefined) this.requestId = requestId;
  }
}

/** A caller-supplied argument this server refuses before spending a call on it. */
export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputError";
  }
}

/** The 30 s ceiling every outbound request carries. */
export class TimeoutError extends Error {
  constructor(what: string, ms: number) {
    super(
      `${what} did not answer within ${Math.round(ms / 1000)}s and was ` +
        `abandoned. A read is safe to retry. A WRITE may still have been ` +
        `applied — read the resource back before sending it again.`,
    );
    this.name = "TimeoutError";
  }
}
