/**
 * The failures this server classifies, and why each one is its own type.
 *
 * A bare 4xx passed through to an agent is the worst available answer here: the
 * caller is working on financial records, and "the API said 400" tells it
 * nothing about whether to retry, to ask a human, or to stop. Every class below
 * exists because its RECOVERY differs from the others'.
 */

/** One entry of BILL's error array: `[{timestamp, code, severity, category, message, detail, help}]`. */
export interface BdcError {
  code?: string;
  severity?: string;
  category?: string;
  message?: string;
  detail?: string;
  help?: string;
}

/**
 * BILL answered, and answered with a failure.
 *
 * The status and BILL's own `code` are both kept: the status says what kind of
 * failure it was, and the code (`BDC_1144`, …) is what BILL's documentation is
 * indexed by, so an operator can look it up.
 */
export class BillApiError extends Error {
  readonly status: number;
  readonly errors: BdcError[];

  constructor(message: string, status: number, errors: BdcError[] = []) {
    super(message);
    this.name = "BillApiError";
    this.status = status;
    this.errors = errors;
  }
}

/**
 * The token was rejected. No retry helps; a human mints a new one.
 *
 * Separate from `BillApiError` because it is the one failure whose fix is
 * outside the running system entirely, and because it is what a deployment
 * pointed at the wrong BILL environment looks like from the inside.
 */
export class AuthError extends BillApiError {
  constructor(message: string, status: number, errors: BdcError[] = []) {
    super(message, status, errors);
    this.name = "AuthError";
  }
}

/**
 * 60 calls per token per minute, and this deployment hit it.
 *
 * Retried inside the client with backoff first (see client.ts); this is what a
 * caller sees once that budget is spent, and it exists so the caller slows down
 * rather than treating it as a permanent failure.
 */
export class RateLimitError extends BillApiError {
  /** Seconds BILL asked us to wait, when it said. */
  readonly retryAfterSeconds?: number;

  constructor(
    message: string,
    status: number,
    errors: BdcError[] = [],
    retryAfterSeconds?: number,
  ) {
    super(message, status, errors);
    this.name = "RateLimitError";
    if (retryAfterSeconds !== undefined)
      this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * The transaction is locked, so BILL will not accept a coding change for it.
 *
 * Refused BEFORE the write rather than after: "You cannot update custom fields
 * in a locked transaction" is documented, the pre-check is one GET, and the
 * alternative is a PUT whose failure mode is the one this whole server is built
 * around — a 200 that changed nothing. There is no API call that unlocks a
 * transaction, so the recovery is a human in the BILL web app, and this error
 * says so rather than inviting a retry.
 */
export class LockedTransactionError extends Error {
  readonly transactionId: string;

  constructor(transactionId: string) {
    super(
      `Transaction ${transactionId} is LOCKED (isLocked: true), and BILL does ` +
        `not accept custom-field updates on a locked transaction. Nothing was ` +
        `written and retrying will not help. A human unlocks it in the BILL ` +
        `Spend & Expense web app (the transaction's Lock/unlock custom fields ` +
        `control); the usual reason it is locked is that an accounting sync ` +
        `already exported it.`,
    );
    this.name = "LockedTransactionError";
    this.transactionId = transactionId;
  }
}

/** One PUT this server sent, and what came back. Never carries a credential. */
export interface WriteAttempt {
  /** Which body shape was sent — see wire.ts. */
  variant: string;
  /** The body key used for the field: `customFieldId` or `customFieldUuid`. */
  fieldKey: string;
  /** Which identifier form the values were sent in: `id` or `uuid`. */
  valueForm: string;
  /** BILL's HTTP status, and its `status` field when it answered 200. */
  httpStatus: number;
  reportedStatus?: string;
  /** What the read-back showed afterwards, as display values. */
  observedAfter: string[];
  /** The note the read-back showed, when the write asked for one. */
  observedNote?: string;
  persisted: boolean;
}

/**
 * BILL reported success and the transaction did not change.
 *
 * THIS IS THE FAILURE THE SERVER EXISTS TO CATCH. `PUT
 * /v3/spend/transactions/{id}/custom-fields` can answer HTTP 200
 * `{"status":"SUCCESS"}` having discarded the update — BILL's own API reference
 * and its Transactions guide disagree about the request body (`customFieldId`
 * vs `customFieldUuid`), and a community implementer reports that the `tty_…` /
 * `tvl_…` UUID forms are accepted and dropped while only the base64 `id` form
 * writes. For an unattended agent working on someone's books, believing that
 * reply is how you report forty transactions re-coded and change none of them.
 *
 * So this is raised after every body shape this server knows has been tried and
 * READ BACK, and it carries all of them. That list is the diagnostic: it says,
 * per shape, what BILL answered and what the transaction looked like afterwards.
 */
export class WriteNotPersistedError extends Error {
  readonly transactionId: string;
  readonly attempts: WriteAttempt[];

  constructor(transactionId: string, attempts: WriteAttempt[]) {
    const reported = attempts
      .map(
        (a) =>
          `${a.variant} -> HTTP ${a.httpStatus}` +
          (a.reportedStatus ? ` ${a.reportedStatus}` : "") +
          `, read-back showed [${a.observedAfter.join(", ") || "nothing"}]`,
      )
      .join("; ");
    super(
      `The coding of transaction ${transactionId} did NOT change. ` +
        `${attempts.length} request ${attempts.length === 1 ? "shape was" : "shapes were"} ` +
        `tried and each was verified by re-reading the transaction: ${reported}. ` +
        `Treat this transaction as UNCODED. BILL can answer 200 SUCCESS and ` +
        `discard the update, which is why this is reported as a failure rather ` +
        `than as the success BILL claimed. Most likely causes: the value ids do ` +
        `not belong to that custom field (get them from list_coding_options for ` +
        `this exact field), the field does not apply to this transaction's ` +
        `budget, or the field is not selectable on this transaction at all ` +
        `(check get_transaction_coding).`,
    );
    this.name = "WriteNotPersistedError";
    this.transactionId = transactionId;
    this.attempts = attempts;
  }
}

/** A caller-supplied argument this server refuses before spending a call on it. */
export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputError";
  }
}
