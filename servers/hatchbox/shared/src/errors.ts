/**
 * The failures a tool reports, classified, because each has a different next
 * move and only one of them is the agent's to make.
 */

/** A value in this slug's configuration is missing or unusable. A human fixes it. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** The caller's arguments are wrong. The message says what to send instead. */
export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputError";
  }
}

/** Hatchbox answered, and not with success. */
export class HatchboxApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = "HatchboxApiError";
  }
}

/** The SSH read of the app's environment failed: connection, host key, login or command. */
export class SshReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SshReadError";
  }
}
