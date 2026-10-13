/**
 * The failures a tool reports, classified, because each has a different next
 * move and only one of them is the agent's to make.
 */

/** A value in this instance's configuration is missing or unusable. A human fixes it in the store. */
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

/**
 * The host did not answer at all: no address, nothing listening, or no reply
 * before the connect timeout. On this fleet the usual cause is a host that is
 * powered off on purpose (Zimmer staging is spun down when idle), so the
 * message is an instruction — bring it up, then `ssh_check_connection` — and
 * never "do not retry". Distinct from {@link HostKeyMismatchError} (a host DID
 * answer, as the wrong machine) and from a rejected key (the right machine
 * answered and refused us): neither of those is fixed by powering anything on.
 */
export class SshUnreachableError extends Error {
  constructor(
    /** What the network said, in a few words: "connection refused", "timed out after 15000 ms". */
    readonly reason: string,
    target: string,
    hint: string | undefined,
  ) {
    super(
      `UNREACHABLE: ${target} did not answer: ${reason}. Nothing was sent to it ` +
        `and the private key was not used. ` +
        (hint
          ? `About this host: ${hint} `
          : `If this host is meant to be always on, treat it as an outage. `) +
        `Once it is up, call ssh_check_connection to confirm, then retry this ` +
        `call — no reconnect of the MCP session is needed.`,
    );
    this.name = "SshUnreachableError";
  }
}

/**
 * The host presented a key that is not pinned. Never retried and never
 * downgraded: either the host was rebuilt (a human re-pins it after checking) or
 * something is answering in its place.
 */
export class HostKeyMismatchError extends Error {
  constructor(
    readonly presented: { type: string | null; fingerprint: string },
    readonly pinned: Array<{ type: string | null; fingerprint: string }>,
    target: string,
  ) {
    super(
      `REFUSED: ${target} presented host key ${presented.fingerprint}` +
        `${presented.type ? ` (${presented.type})` : ""}, which is not the pinned ` +
        `key (${pinned.map((p) => p.fingerprint).join(", ")}). Nothing was sent ` +
        `and the private key was not used. If the host was legitimately rebuilt, ` +
        `a human must verify the new key out of band and re-seed SSH_HOST_KEY; ` +
        `otherwise treat this as a possible interception and do not retry.`,
    );
    this.name = "HostKeyMismatchError";
  }
}
