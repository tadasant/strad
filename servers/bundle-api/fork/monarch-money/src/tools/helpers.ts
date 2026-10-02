import { MonarchAuthError } from '../monarch-client/graphql-transport.js';

export interface ToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

export function ok(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

/**
 * Serialize a value as the tool's text result.
 *
 * Uses compact JSON (no pretty-print indentation). The data is identical to
 * indented output, but list-heavy responses like `get_transactions` are far
 * smaller on the wire — a ~222-transaction page dropped from ~134 KB to roughly
 * half that. Consumers parse the payload rather than reading it raw, so the
 * whitespace carried no value.
 */
export function okJSON(value: unknown): ToolResult {
  return ok(JSON.stringify(value));
}

export function errorResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/**
 * How a human gets Monarch a fresh credential, in the one place it is written.
 * Every auth failure ends with this, because an expired session is the failure
 * this server sees most and the fix is the same each time.
 */
export const COOKIE_REFRESH_STEPS =
  'To refresh it: sign in at https://app.monarch.com, open DevTools → Network, select any ' +
  'request to api.monarch.com/graphql, and copy the whole value of its `Cookie` request header. ' +
  'Then either call `set_session_cookie` with it (verified against Monarch before anything is ' +
  'saved; on strad it is persisted to the parameter store when the slug lists MONARCH_COOKIE ' +
  'under paramsWritable:), or set MONARCH_COOKIE for this server in strad\'s console at ' +
  '/ui/secrets.';

/**
 * The message for a refused or missing credential: WHICH credential, WHY, and
 * the exact step that fixes it. Never carries a credential's bytes.
 */
export function authErrorMessage(err: MonarchAuthError): string {
  const status = err.status ? ` (Monarch answered ${err.status})` : '';
  let head: string;
  if (err.reason === 'missing') {
    head = 'Not authenticated with Monarch Money: no credential is configured (MONARCH_COOKIE, MONARCH_SESSION_TOKEN, or MONARCH_EMAIL + MONARCH_PASSWORD).';
  } else if (err.reason === 'csrf') {
    head = `Monarch cookie rejected by the CSRF check${status}: the cookie must include \`csrftoken\` as well as the session cookie. Copy the whole Cookie header, not part of it.`;
  } else if (err.method === 'cookie') {
    head = `Monarch cookie expired or was signed out${status}.`;
  } else if (err.method === 'token') {
    head =
      `Monarch rejected the session token${status}. Monarch's web app exposes no token to ` +
      'copy, so replace it with the session cookie, MONARCH_COOKIE, which takes precedence.';
  } else {
    head = `Not authenticated with Monarch Money: Monarch refused the request's credential${status}: ${err.message.replace(/\.?$/, '.')}`;
  }
  const hint = err.hint ? ` ${err.hint}` : '';
  const login = err.loginFailure
    ? ` A headless re-login with MONARCH_EMAIL/MONARCH_PASSWORD was attempted and did not succeed: ${err.loginFailure}.`
    : '';
  return `${head}${hint}${login} ${COOKIE_REFRESH_STEPS}`;
}

/**
 * Convert a thrown error into a user-facing tool result. Auth errors say which
 * credential failed and how to refresh it; everything else is surfaced verbatim
 * so the user can see Monarch's GraphQL message.
 */
export function errorFromException(err: unknown): ToolResult {
  if (err instanceof MonarchAuthError) return errorResult(authErrorMessage(err));
  const message = err instanceof Error ? err.message : String(err);
  return errorResult(`Monarch Money error: ${message}`);
}
