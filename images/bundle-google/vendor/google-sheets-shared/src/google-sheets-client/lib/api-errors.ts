export class GoogleApiError extends Error {
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
    message: string
  ) {
    super(message);
    this.name = 'GoogleApiError';
  }
}

function categorize(status: number): GoogleApiError['category'] {
  if (status === 401) return 'auth';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'server';
  if (status >= 400) return 'client';
  return 'unknown';
}

function categoryPrefix(category: GoogleApiError['category']): string {
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

/**
 * Recovery guidance for the failures a caller can actually do something about.
 *
 * The first one is the whole reason this function exists. A Drive file that is
 * not a NATIVE Google Sheet — an .xlsx someone uploaded, which Drive happily
 * opens in the Sheets UI — is invisible to the Sheets API: every call against it
 * is `400 FAILED_PRECONDITION`, with a message that says nothing about file
 * types. It reads exactly like a broken mount.
 *
 * The four READ tools no longer surface that hint: `isOfficeFileError` in
 * `src/office/load.ts` recognises this same response and reads the file from
 * Drive instead, replacing the error with one that names the Drive scope if the
 * download is what failed. So this branch is what a WRITE hits — and what any
 * caller of the client library gets if it does not take the Office path.
 */
function recoveryHint(status: number, detail: string): string | undefined {
  const text = detail.toLowerCase();

  if (
    status === 400 &&
    (text.includes('failed_precondition') ||
      text.includes('this operation is not supported for this document'))
  ) {
    return (
      'This Drive file is probably not a native Google Sheet — an uploaded .xlsx/.csv ' +
      'opens in the Sheets UI but the Sheets API cannot read it, and cannot write it at ' +
      'all. strad READS such a file by downloading it from Drive (the read tools do this ' +
      'automatically, given the drive.readonly scope). To make it writable, open it in ' +
      'Google Sheets and use File > Save as Google Sheets; that mints a NEW spreadsheet id ' +
      '(44 characters, where an uploaded file id is around 33), which this server can edit.'
    );
  }

  if (status === 403 && text.includes('has not been used in project')) {
    return 'The Google Sheets API is not enabled on the GCP project behind this OAuth client.';
  }

  if (status === 403 && text.includes('insufficient')) {
    return (
      'The refresh token was granted narrower scopes than this call needs. A token ' +
      'consented for https://www.googleapis.com/auth/spreadsheets.readonly can read but ' +
      'not write; writing needs https://www.googleapis.com/auth/spreadsheets. Re-consent ' +
      'the account to mint a token with the wider scope.'
    );
  }

  if (status === 403) {
    return (
      'The signed-in Google account can be authenticated but is not allowed to touch this ' +
      'file. Check that the account this refresh token belongs to is the one the file is ' +
      'shared with.'
    );
  }

  if (status === 404) {
    return (
      'No spreadsheet with that id is visible to the account this refresh token belongs ' +
      'to. Check the id, and check that the file is shared with that account — each strad ' +
      'google-sheets slug is ONE Google account.'
    );
  }

  return undefined;
}

/**
 * Throws a meaningful error for a non-OK Google API response.
 * Reads the body once, attempts to parse it as JSON for a Google API error message,
 * and falls back to the raw text otherwise.
 */
export async function throwForGoogleApiError(
  response: Response,
  operation: string
): Promise<never> {
  const bodyText = await response.text().catch(() => '');
  let detail = bodyText;
  try {
    const parsed = JSON.parse(bodyText) as {
      error?: { message?: string; status?: string };
    };
    if (parsed?.error?.message) {
      detail = parsed.error.status
        ? `${parsed.error.status}: ${parsed.error.message}`
        : parsed.error.message;
    }
  } catch {
    // bodyText is not JSON - keep as raw text
  }
  const category = categorize(response.status);
  const hint = recoveryHint(response.status, detail);
  const message =
    `${categoryPrefix(category)} (${operation}): ${response.status} ${response.statusText}` +
    `${detail ? ` - ${detail}` : ''}${hint ? `\n\nHint: ${hint}` : ''}`;
  throw new GoogleApiError(response.status, category, message);
}
