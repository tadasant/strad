/**
 * The failures this server classifies. Each class exists because its RECOVERY
 * differs: a token a human has to replace, a rate limit to wait out, an id that
 * does not exist, an argument the caller got wrong.
 */

/** Hetzner answered, and answered with a failure. */
export class HetznerApiError extends Error {
  readonly status: number;
  /** Hetzner's own `error.code`, e.g. `not_found`, `protected`, `locked`. */
  readonly code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "HetznerApiError";
    this.status = status;
    if (code !== undefined) this.code = code;
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
