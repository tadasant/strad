/**
 * The failures this server classifies, and why each one is its own type.
 *
 * Every class below exists because its RECOVERY differs from the others'. An
 * agent driving a phone it is paying for by the minute needs to know whether to
 * retry, to wait, to fix its own argument, or to stop and tell a human that an
 * IAM policy is short an action — and "the API said 400" answers none of those.
 */

/** Device Farm answered, and answered with a failure. */
export class DeviceFarmApiError extends Error {
  /** AWS's own exception name — `ArgumentException`, `NotFoundException`, … */
  readonly awsErrorName: string;
  readonly status?: number;

  constructor(message: string, awsErrorName: string, status?: number) {
    super(message);
    this.name = "DeviceFarmApiError";
    this.awsErrorName = awsErrorName;
    if (status !== undefined) this.status = status;
  }
}

/**
 * The credential was rejected, or the policy behind it is short an action.
 *
 * ONE CLASS, TWO CAUSES, AND THE MESSAGE SEPARATES THEM. A rejected key and a
 * denied action both mean "no human-free retry helps", which is why they share a
 * type — but the fixes are different rooms: one is a new access key, the other
 * is one line in an IAM policy. `AccessDeniedException` names the action it
 * refused, so the message carries it: that string is the whole diagnosis when a
 * least-privilege policy was written without, say, `devicefarm:StopRun`.
 */
export class AuthError extends DeviceFarmApiError {
  constructor(message: string, awsErrorName: string, status?: number) {
    super(message, awsErrorName, status);
    this.name = "AuthError";
  }
}

/** An ARN that does not exist, or belongs to another account. */
export class NotFoundError extends DeviceFarmApiError {
  constructor(message: string, awsErrorName: string, status?: number) {
    super(message, awsErrorName, status);
    this.name = "NotFoundError";
  }
}

/**
 * An account limit, and the two that bite are the two that cost money.
 *
 * Remote-access concurrency defaults to TWO metered devices and automation
 * concurrency to five. The usual cause of this error is not a burst of work: it
 * is a session somebody forgot to stop, still billing at the metered rate. So
 * the recovery this error points at is `list_device_sessions` — find the
 * running one, and stop it.
 */
export class LimitError extends DeviceFarmApiError {
  constructor(message: string, awsErrorName: string, status?: number) {
    super(message, awsErrorName, status);
    this.name = "LimitError";
  }
}

/**
 * Device Farm throttled this call.
 *
 * The bucket is small — ten burst / one per second for everything that is not a
 * List or a Get — and an agent polling a run tightly reaches it. Retryable, and
 * slowly.
 */
export class RateLimitError extends DeviceFarmApiError {
  constructor(message: string, awsErrorName: string, status?: number) {
    super(message, awsErrorName, status);
    this.name = "RateLimitError";
  }
}

/** A caller-supplied argument this server refuses before spending a call on it. */
export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputError";
  }
}

/**
 * Device Farm took the build and could not process it.
 *
 * `CreateUpload` succeeds, the PUT succeeds, and the upload then goes to
 * `FAILED` with a `message` that is the only thing anybody can act on — most
 * often `IOS_APP_WRONG_PLATFORM_DEVICE_VALUE`, which is a SIMULATOR build. So
 * the message is carried verbatim rather than flattened into "upload failed",
 * and the upload ARN comes with it: the same ARN is what a retry must not
 * reuse.
 */
export class UploadFailedError extends Error {
  readonly uploadArn: string;
  readonly status: string;
  readonly detail?: string;

  constructor(uploadArn: string, status: string, detail?: string) {
    super(
      `Device Farm could not process the upload (status ${status})` +
        (detail ? `: ${detail}` : ".") +
        ` The most common cause for an .ipa is a SIMULATOR build — Device ` +
        `Farm needs a device build, whose Info.plist has ` +
        `CFBundleSupportedPlatforms = ["iPhoneOS"] and no "simulator" in it. ` +
        `Upload a fresh build; this ARN cannot be reused.`,
    );
    this.name = "UploadFailedError";
    this.uploadArn = uploadArn;
    this.status = status;
    if (detail !== undefined) this.detail = detail;
  }
}

/**
 * The remote access session is not in a state that can be driven.
 *
 * Distinct from a `NotFoundError` because the recovery is TIME, not a different
 * ARN: a session spends its first minute or two in PENDING / PREPARING while a
 * physical phone is allocated and the build is installed, and the Appium
 * endpoint does not exist until it is RUNNING. It is also what a session that
 * has already been stopped looks like, which is why the status is carried.
 */
export class SessionNotReadyError extends Error {
  readonly sessionArn: string;
  readonly status: string;

  constructor(sessionArn: string, status: string, detail?: string) {
    super(
      `The device session is ${status}, so there is nothing to drive yet` +
        (detail ? ` (${detail})` : "") +
        `. PENDING / PENDING_DEVICE / PREPARING mean a physical phone is ` +
        `still being allocated — wait a few seconds and call again. COMPLETED ` +
        `or STOPPING mean this session is over: start a new one with ` +
        `start_device_session.`,
    );
    this.name = "SessionNotReadyError";
    this.sessionArn = sessionArn;
    this.status = status;
  }
}

/**
 * The device's Appium endpoint answered with a WebDriver error.
 *
 * The W3C error CODE is what a caller branches on — `no such element` is a
 * screen that has not rendered yet or a wrong locator, `invalid session id` is
 * a session the device dropped, `timeout` is the endpoint's own four-minute
 * per-command ceiling — so it is kept beside the message rather than folded
 * into it.
 */
export class DriverError extends Error {
  readonly code: string;
  readonly sessionArn?: string;

  constructor(code: string, message: string, sessionArn?: string) {
    super(message);
    this.name = "DriverError";
    this.code = code;
    if (sessionArn !== undefined) this.sessionArn = sessionArn;
  }
}

/** The source URL a build was to be fetched from could not be read. */
export class SourceFetchError extends Error {
  readonly sourceUrl: string;
  readonly status?: number;

  constructor(sourceUrl: string, message: string, status?: number) {
    super(message);
    this.name = "SourceFetchError";
    this.sourceUrl = sourceUrl;
    if (status !== undefined) this.status = status;
  }
}
