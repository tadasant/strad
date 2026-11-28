/**
 * A Search Console API failure, classified, with the recovery a caller can act on.
 *
 * Search Console answers several unrelated failures with a 403: a token consented
 * for the wrong scope, an account with no access to the property, the API not
 * enabled on the OAuth client's project, and a per-user quota. Only the body's
 * `reason` (or `status`) and message tell them apart, so the hint keys on those
 * first and on the HTTP status second.
 */
export const WEBMASTERS_READONLY_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';

export class SearchConsoleApiError extends Error {
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
    this.name = 'SearchConsoleApiError';
  }
}

/** Quota reasons Google sends as a 403 as well as a 429. */
const RATE_LIMIT_REASONS = new Set([
  'userRateLimitExceeded',
  'rateLimitExceeded',
  'quotaExceeded',
  'RATE_LIMIT_EXCEEDED',
  'RESOURCE_EXHAUSTED',
]);

const SCOPE_REASONS = new Set(['insufficientPermissions', 'ACCESS_TOKEN_SCOPE_INSUFFICIENT']);

function categorize(status: number, reason: string | undefined): SearchConsoleApiError['category'] {
  if (status === 429 || (reason && RATE_LIMIT_REASONS.has(reason))) return 'rate_limit';
  if (status === 401) return 'auth';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status >= 500) return 'server';
  if (status >= 400) return 'client';
  return 'unknown';
}

function categoryPrefix(category: SearchConsoleApiError['category']): string {
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

  if (status === 429 || (reason && RATE_LIMIT_REASONS.has(reason)) || text.includes('quota')) {
    return (
      'Search Console is throttling this account or project. Wait a minute and retry with fewer ' +
      'calls in flight. URL inspection has a daily per-property quota of its own (2,000 a day), ' +
      'so inspect a handful of URLs rather than a whole sitemap.'
    );
  }

  if (status === 401) {
    return (
      'Google did not accept the access token. The next call mints a fresh one from the refresh ' +
      'token; if this keeps happening, the refresh token has been revoked and the account has to ' +
      'be connected again.'
    );
  }

  if (
    reason === 'accessNotConfigured' ||
    reason === 'SERVICE_DISABLED' ||
    text.includes('has not been used in project') ||
    text.includes('is disabled')
  ) {
    return (
      'The Google Search Console API is not enabled on the GCP project behind this OAuth client. ' +
      'Enable searchconsole.googleapis.com there and retry.'
    );
  }

  if ((reason && SCOPE_REASONS.has(reason)) || text.includes('insufficient authentication scopes')) {
    return (
      `The refresh token was not consented for ${WEBMASTERS_READONLY_SCOPE}, which every tool ` +
      'here needs. Connect the account again with that scope.'
    );
  }

  if (status === 403) {
    return (
      'The signed-in Google account has no access to this property, or the site_url is not ' +
      'spelled exactly as Search Console stores it. Call list_sites and pass a site_url from it ' +
      'verbatim: a Domain property is "sc-domain:example.com", a URL-prefix property is the full ' +
      'URL with its trailing slash, e.g. "https://www.example.com/". For inspect_url, the ' +
      'inspection_url must also sit under that property.'
    );
  }

  if (status === 404) {
    return (
      'Search Console has no such property or sitemap for this account. Call list_sites (or ' +
      'list_sitemaps) and pass the exact string it returns.'
    );
  }

  return undefined;
}

/**
 * Throw a SearchConsoleApiError for a non-OK response. Reads the body once;
 * Google's error JSON carries `error.message`, and the reason in either
 * `error.errors[0].reason` (v3) or `error.details[].reason` / `error.status` (v1).
 */
export async function throwForApiError(response: Response, operation: string): Promise<never> {
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
    reason =
      parsed?.error?.errors?.[0]?.reason ??
      parsed?.error?.details?.find((d) => d.reason)?.reason ??
      (parsed?.error?.status === 'RESOURCE_EXHAUSTED' ? 'RESOURCE_EXHAUSTED' : undefined);
  } catch {
    // Not JSON: keep the raw text.
  }
  const category = categorize(response.status, reason);
  const hint = recoveryHint(response.status, reason, detail);
  const message =
    `${categoryPrefix(category)} (${operation}): ${response.status} ${response.statusText}` +
    `${detail ? ` - ${detail}` : ''}${hint ? `\n\nHint: ${hint}` : ''}`;
  throw new SearchConsoleApiError(response.status, category, reason, message);
}
