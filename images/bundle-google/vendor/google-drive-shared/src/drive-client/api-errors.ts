/**
 * A Drive API failure, classified, with the recovery a caller can act on.
 *
 * Drive answers several unrelated failures with the same status. A 403 can be a
 * scope the token was not consented for, a file the account cannot see, a
 * Google Doc too large to export, or a per-user rate limit — and only the
 * `reason` in the error body tells them apart. So the hint keys on that reason
 * first and on the status second.
 */
export class DriveApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly category:
      | 'auth'
      | 'forbidden'
      | 'not_found'
      | 'rate_limit'
      | 'server'
      | 'client'
      | 'unknown',
    public readonly reason: string | undefined,
    message: string
  ) {
    super(message);
    this.name = 'DriveApiError';
  }
}

/** Drive's per-user and per-project quota reasons, which arrive as a 403, not a 429. */
const RATE_LIMIT_REASONS = new Set([
  'userRateLimitExceeded',
  'rateLimitExceeded',
  'sharingRateLimitExceeded',
]);

function categorize(status: number, reason: string | undefined): DriveApiError['category'] {
  if (status === 429 || (reason && RATE_LIMIT_REASONS.has(reason))) return 'rate_limit';
  if (status === 401) return 'auth';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status >= 500) return 'server';
  if (status >= 400) return 'client';
  return 'unknown';
}

function categoryPrefix(category: DriveApiError['category']): string {
  switch (category) {
    case 'auth':
      return 'Authentication failed';
    case 'forbidden':
      return 'Permission denied';
    case 'not_found':
      return 'Not found';
    case 'rate_limit':
      return 'Rate limit exceeded';
    case 'server':
      return 'Google API server error';
    case 'client':
      return 'Bad request';
    default:
      return 'Request failed';
  }
}

function recoveryHint(status: number, reason: string | undefined, detail: string): string | undefined {
  const text = detail.toLowerCase();

  if (reason === 'exportSizeLimitExceeded' || text.includes('too large to be exported')) {
    return (
      'Google exports a Workspace file of at most 10MB. This one is larger: open it in ' +
      'the browser (get_file returns its link), or for a spreadsheet read it a range at a ' +
      'time through the google-sheets server.'
    );
  }

  if (reason === 'accessNotConfigured' || text.includes('has not been used in project')) {
    return 'The Google Drive API is not enabled on the GCP project behind this OAuth client.';
  }

  if (reason && RATE_LIMIT_REASONS.has(reason)) {
    return 'Drive is throttling this account. Wait a minute and retry, with fewer calls in flight.';
  }

  if (
    reason === 'insufficientPermissions' ||
    reason === 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' ||
    text.includes('insufficient authentication scopes')
  ) {
    return (
      'The refresh token was consented for narrower scopes than this call needs. Every read ' +
      'tool needs https://www.googleapis.com/auth/drive.readonly; create_folder and ' +
      'create_file need https://www.googleapis.com/auth/drive.file as well. Re-consent the ' +
      'account to mint a token with both.'
    );
  }

  if (status === 403 && (reason === 'insufficientFilePermissions' || reason === 'appNotAuthorizedToFile')) {
    return (
      'The account can see this file or folder but this credential may not write to it. ' +
      'Under the drive.file scope a write reaches only files and folders this OAuth app ' +
      'created, so a folder made by hand in Drive is out of reach: create the folder with ' +
      'create_folder first, or leave parent_folder_id out to write to My Drive.'
    );
  }

  if (status === 403) {
    return (
      'The signed-in Google account is not allowed to do this to the file. Check that the ' +
      'file is shared with the account this refresh token belongs to.'
    );
  }

  if (status === 404) {
    return (
      'No file or folder with that id is visible to the account this refresh token belongs ' +
      'to. Check the id (search_files finds it by name), and check that it is shared with ' +
      'that account. As a parent_folder_id, a folder this OAuth app did not create can also ' +
      'come back 404 under the drive.file scope.'
    );
  }

  return undefined;
}

/**
 * Throw a DriveApiError for a non-OK response. Reads the body once; Drive's
 * error JSON carries `error.message` and `error.errors[0].reason`.
 */
export async function throwForDriveApiError(response: Response, operation: string): Promise<never> {
  const bodyText = await response.text().catch(() => '');
  let detail = bodyText;
  let reason: string | undefined;
  try {
    const parsed = JSON.parse(bodyText) as {
      error?: {
        message?: string;
        status?: string;
        errors?: Array<{ reason?: string }>;
        details?: Array<{ reason?: string }>;
      };
    };
    if (parsed?.error?.message) detail = parsed.error.message;
    reason = parsed?.error?.errors?.[0]?.reason ?? parsed?.error?.details?.find((d) => d.reason)?.reason;
  } catch {
    // Not JSON: keep the raw text.
  }
  const category = categorize(response.status, reason);
  const hint = recoveryHint(response.status, reason, detail);
  const message =
    `${categoryPrefix(category)} (${operation}): ${response.status} ${response.statusText}` +
    `${detail ? ` - ${detail}` : ''}${hint ? `\n\nHint: ${hint}` : ''}`;
  throw new DriveApiError(response.status, category, reason, message);
}
