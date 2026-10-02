/**
 * The credentials Monarch's API accepts, and the headers each one travels as.
 *
 * Monarch's web app authenticates with an HttpOnly Django session cookie
 * (`sessionid`, plus `csrftoken`) against `https://api.monarch.com/graphql`,
 * and sends no `Authorization: Token …` header, so the cookie is the
 * credential a human can lift out of DevTools. The token form serves a token
 * minted by the REST login (`auth.ts`) or pasted by hand.
 *
 * Nothing here logs, and no error built here carries a credential's bytes.
 */

export type MonarchCredential =
  | {
      method: 'cookie';
      /** The full browser `Cookie` header value, normalised by `normaliseCookieHeader`. */
      cookie: string;
    }
  | {
      method: 'token';
      token: string;
      /**
       * Where the token came from: `env` is `MONARCH_SESSION_TOKEN`, `login` is
       * one this process minted with `MONARCH_EMAIL`/`MONARCH_PASSWORD`, and
       * `stored` is one a previous run or `monarch_login_with_token` saved.
       */
      source: 'env' | 'login' | 'stored';
    };

export type AuthMethod = 'cookie' | 'token';

export const MONARCH_WEB_ORIGIN = 'https://app.monarch.com';

/**
 * A `Cookie` header value as a human pastes it, made into one a request can
 * carry. Tolerates the shapes a copy out of DevTools actually arrives in: a
 * leading `Cookie:` (from "Copy request headers"), wrapping quotes (from a
 * curl's `-b '…'`), and line breaks. Returns null when nothing is left.
 */
export function normaliseCookieHeader(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  // Line breaks become spaces; any other byte outside visible ASCII is dropped.
  // A header value carrying one makes `fetch` throw an error that QUOTES the
  // whole value, and that error would reach a tool result.
  let value = raw
    .replace(/[\r\n]+/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[^\x20-\x7e]/g, '')
    .trim();
  value = value.replace(/^cookie\s*:\s*/i, '');
  if (
    value.length >= 2 &&
    ((value.startsWith("'") && value.endsWith("'")) ||
      (value.startsWith('"') && value.endsWith('"')))
  ) {
    value = value.slice(1, -1).trim();
  }
  const pairs = parseCookieHeader(value);
  if (pairs.size === 0) return null;
  return serialiseCookies(pairs);
}

/** `a=1; b=2` into an ordered map. Pairs without a name or `=` are dropped. */
export function parseCookieHeader(value: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of value.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    if (!name) continue;
    out.set(name, part.slice(eq + 1).trim());
  }
  return out;
}

function serialiseCookies(pairs: Map<string, string>): string {
  return [...pairs].map(([k, v]) => `${k}=${v}`).join('; ');
}

/** The `csrftoken` cookie's value, which Django expects echoed as `X-CSRFToken`. */
export function csrfTokenFrom(cookie: string): string | undefined {
  const value = parseCookieHeader(cookie).get('csrftoken');
  return value ? value : undefined;
}

/**
 * The names Monarch's session cookie has been observed under. pbassham's client
 * documents `sessionid`; two other clients observed `session_id`. Neither is
 * REQUIRED before a cookie is sent — Monarch's answer is the test — but a
 * refused cookie carrying neither gets a hint (`MonarchAuthError.hint`) that
 * the wrong header was copied.
 */
export const SESSION_COOKIE_NAMES = ['sessionid', 'session_id'] as const;

/**
 * A hint for a refused cookie, or null when it carries a session cookie. Names
 * cookies, never values.
 */
export function cookieHint(cookie: string): string | null {
  const pairs = parseCookieHeader(cookie);
  if (SESSION_COOKIE_NAMES.some((n) => pairs.get(n))) return null;
  const names = [...pairs.keys()];
  return (
    `The cookie carries no \`sessionid\`/\`session_id\` (it has ${names.length} ` +
    `cookie${names.length === 1 ? '' : 's'}${names.length ? `: ${names.slice(0, 8).join(', ')}` : ''}). ` +
    `Copy the whole \`Cookie\` request header from a request to api.monarch.com in ` +
    `DevTools → Network, not \`document.cookie\` — the session cookie is HttpOnly and ` +
    `only the request header shows it.`
  );
}

/** The headers a GraphQL or REST request carries for `credential`. */
export function authHeaders(
  credential: MonarchCredential,
  deviceUuid?: string
): Record<string, string> {
  const headers: Record<string, string> = { 'client-platform': 'web' };
  if (credential.method === 'cookie') {
    headers.Cookie = credential.cookie;
    const csrf = csrfTokenFrom(credential.cookie);
    if (csrf) headers['X-CSRFToken'] = csrf;
    // Django's CSRF check on an HTTPS request compares Origin/Referer against
    // its trusted origins; the web app's own origin is the one it trusts.
    headers.Origin = MONARCH_WEB_ORIGIN;
    headers.Referer = `${MONARCH_WEB_ORIGIN}/`;
  } else {
    headers.Authorization = `Token ${credential.token}`;
  }
  if (deviceUuid) headers['device-uuid'] = deviceUuid;
  return headers;
}

/**
 * Fold a response's `Set-Cookie` headers into a cookie, returning the new value
 * when the SESSION changed — a session cookie (`SESSION_COOKIE_NAMES`) or
 * `csrftoken` set to a new value or deleted — and null otherwise.
 *
 * This is how a session Monarch re-issues is kept rather than lost when the
 * process restarts. Every other cookie is ignored, including ones the request
 * carried: a DevTools copy holds analytics and edge cookies that rotate on
 * their own schedule, and each change would otherwise be a parameter-store
 * write. An expiry in the past or `Max-Age=0` deletes.
 */
export function mergeSetCookies(
  cookie: string,
  setCookies: readonly string[],
  now: Date = new Date()
): string | null {
  if (setCookies.length === 0) return null;
  const tracked = new Set<string>([...SESSION_COOKIE_NAMES, 'csrftoken']);
  const pairs = parseCookieHeader(cookie);
  let changed = false;
  for (const header of setCookies) {
    const [first, ...attrs] = header.split(';');
    const eq = first.indexOf('=');
    if (eq <= 0) continue;
    const name = first.slice(0, eq).trim();
    const value = first.slice(eq + 1).trim();
    if (!tracked.has(name)) continue;
    let expired = value === '';
    for (const attr of attrs) {
      const [k, ...rest] = attr.split('=');
      const key = k.trim().toLowerCase();
      const v = rest.join('=').trim();
      if (key === 'max-age' && Number(v) <= 0) expired = true;
      if (key === 'expires') {
        const at = Date.parse(v);
        if (!Number.isNaN(at) && at <= now.getTime()) expired = true;
      }
    }
    if (expired) {
      if (pairs.delete(name)) changed = true;
    } else if (pairs.get(name) !== value) {
      pairs.set(name, value);
      changed = true;
    }
  }
  return changed ? serialiseCookies(pairs) : null;
}
