/**
 * Thin GraphQL transport for the Monarch Money API.
 *
 * Why a custom client? The full surface we expose (40+ tools spanning accounts,
 * transactions, budgets, rules, and net worth) is wider than any maintained
 * TypeScript client we evaluated, so a small in-house transport gives us
 * direct control over typing, retries, and error mapping with no extra
 * dependency. It is intentionally minimal — just enough to POST a GraphQL
 * operation, surface auth/network errors, and return the typed `data` payload.
 */

import { authHeaders, type AuthMethod, type MonarchCredential } from './credentials.js';

export interface GraphQLError {
  message: string;
  path?: (string | number)[];
  /**
   * Where in the query text Monarch rejected. Its own error messages are
   * uniformly `Something went wrong while processing: None on request_id:
   * None.`, so this is frequently the ONLY thing distinguishing "you asked for
   * a field that does not exist" from "the whole request was bad" — see
   * `Q_PORTFOLIO_HOLDINGS`.
   */
  locations?: Array<{ line: number; column: number }>;
  extensions?: Record<string, unknown>;
}

/**
 * `message`, plus the query coordinates Monarch pointed at, when it gave any.
 * Monarch's messages do not name the offending field, so a message without the
 * location is not actionable.
 */
function describeError(e: GraphQLError): string {
  const at = (e.locations ?? []).map((l) => `${l.line}:${l.column}`).join(', ');
  return at ? `${e.message} (at ${at})` : e.message;
}

export interface GraphQLResponse<T> {
  data?: T;
  errors?: GraphQLError[];
}

export interface GraphQLTransport {
  request<T>(operation: { query: string; variables?: Record<string, unknown> }): Promise<T>;
}

export interface CreateGraphQLTransportOptions {
  endpoint?: string;
  /** How this transport authenticates — a session cookie or a token. See `credentials.ts`. */
  credential: MonarchCredential;
  fetchImpl?: typeof fetch;
  /** Optional client identifier sent in the `x-cio-client-platform` header. */
  clientPlatform?: string;
  /**
   * Stable identifier echoed back in the `device-uuid` header. Mirrors the
   * value persisted by the auth flow so GraphQL calls share the same trusted
   * device identity that login negotiated.
   */
  deviceUuid?: string;
  /**
   * Called with a response's `Set-Cookie` headers, when it carried any. The
   * auth manager folds them into the live cookie so a session Monarch
   * re-issues survives a restart (see `mergeSetCookies`).
   */
  onSetCookie?: (setCookies: string[]) => void;
}

const DEFAULT_ENDPOINT = 'https://api.monarch.com/graphql';

/** Why Monarch did not accept the request's credential. */
export type AuthFailureReason =
  /** Monarch answered 401/403 or a "not authenticated" GraphQL error. */
  | 'rejected'
  /** Django refused the request's CSRF pairing — a cookie without its `csrftoken`. */
  | 'csrf'
  /** No credential is configured at all. */
  | 'missing'
  /** The configured credential is malformed and was never sent. */
  | 'malformed';

export class MonarchAuthError extends Error {
  /** Which credential was refused. Set by the auth manager when it knows. */
  method?: AuthMethod | 'none';
  /** Set when a re-login was attempted after the refusal and did not succeed. */
  loginFailure?: string;
  constructor(
    message = 'Monarch session token is missing or invalid',
    public readonly reason: AuthFailureReason = 'rejected',
    public readonly status?: number
  ) {
    super(message);
    this.name = 'MonarchAuthError';
  }
}

export class MonarchGraphQLError extends Error {
  constructor(
    message: string,
    public readonly errors: GraphQLError[]
  ) {
    super(message);
    this.name = 'MonarchGraphQLError';
  }
}

export function createGraphQLTransport(options: CreateGraphQLTransportOptions): GraphQLTransport {
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  const fetchImpl = options.fetchImpl ?? fetch;
  const clientPlatform = options.clientPlatform ?? 'web';

  return {
    async request<T>({
      query,
      variables,
    }: {
      query: string;
      variables?: Record<string, unknown>;
    }): Promise<T> {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'x-cio-client-platform': clientPlatform,
        'x-cio-site-id': 'monarch-money-mcp',
        ...authHeaders(options.credential, options.deviceUuid),
      };

      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ query, variables: variables ?? {} }),
      });

      const setCookies = response.headers.getSetCookie?.() ?? [];
      if (setCookies.length > 0) options.onSetCookie?.(setCookies);

      const text = await response.text();

      // EVERY 401/403 is an authentication failure here — never "MFA required".
      // MFA is a property of the LOGIN endpoint (auth.ts); GraphQL either
      // accepts the credential or does not. The one 403 that means something
      // else is Django's CSRF refusal, which a cookie missing its `csrftoken`
      // earns, and which re-pasting the same cookie would not fix.
      if (response.status === 401 || response.status === 403) {
        if (/csrf/i.test(text)) {
          throw new MonarchAuthError(
            `Monarch refused the request's CSRF check (${response.status}). The cookie must ` +
              `include \`csrftoken\` alongside \`sessionid\` — copy the whole Cookie header.`,
            'csrf',
            response.status
          );
        }
        throw new MonarchAuthError(
          `Monarch returned ${response.status} ${response.statusText}`.trim(),
          'rejected',
          response.status
        );
      }

      // Parse BEFORE branching on the HTTP status. Monarch answers a
      // malformed-for-the-schema query with `400` AND a well-formed GraphQL
      // error body — `{"errors":[{"message":"Something went wrong while
      // processing: None on request_id: None.","locations":[{...}]}]}` — and
      // the `locations` entry is the only thing that says WHICH field it
      // rejected. Throwing on `!response.ok` first turned that into a generic
      // Error carrying 200 truncated characters of JSON and no structure, so
      // the one caller that could have acted on it never saw it.
      let parsed: GraphQLResponse<T> | null = null;
      try {
        parsed = JSON.parse(text) as GraphQLResponse<T>;
      } catch {
        parsed = null;
      }

      if (parsed?.errors && parsed.errors.length > 0) {
        const isAuthError = parsed.errors.some((e) =>
          /unauthor|not authenticated|forbidden/i.test(e.message)
        );
        if (isAuthError) {
          throw new MonarchAuthError(
            parsed.errors.map((e) => e.message).join('; '),
            'rejected',
            response.status
          );
        }
        throw new MonarchGraphQLError(
          `Monarch GraphQL errors: ${parsed.errors.map(describeError).join('; ')}`,
          parsed.errors
        );
      }

      if (!response.ok) {
        throw new Error(
          `Monarch API request failed: ${response.status} ${response.statusText}${text ? ` - ${text.slice(0, 200)}` : ''}`
        );
      }

      if (!parsed) {
        throw new Error(
          `Monarch API returned a non-JSON response (status ${response.status}): ${text.slice(0, 200)}`
        );
      }

      if (!parsed.data) {
        throw new Error('Monarch API returned an empty response');
      }

      return parsed.data;
    },
  };
}
