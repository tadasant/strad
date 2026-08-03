/**
 * Error types for the X API client.
 */

/** Thrown when the X API returns a non-2xx HTTP status. */
export class XApiError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string, message?: string) {
    super(message ?? `X API request failed with status ${status}`);
    this.name = "XApiError";
    this.status = status;
    this.body = body;
  }

  /**
   * True when the app has no X API credits or API access. Refreshing a token
   * cannot fix this; the app owner must configure API access in X's developer
   * console.
   */
  get isClientNotEnrolled(): boolean {
    return this.status === 403 && this.body.includes("client-not-enrolled");
  }
}

/** Thrown when an OAuth token refresh fails. */
export class XAuthError extends Error {
  readonly status?: number;
  readonly body?: string;

  constructor(message: string, status?: number, body?: string) {
    super(message);
    this.name = "XAuthError";
    this.status = status;
    this.body = body;
  }
}
