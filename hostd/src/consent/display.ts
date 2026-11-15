/**
 * Text headed for the owner's SCREEN: the banner's in-flight and recent calls,
 * and the session a caller says it acts for.
 *
 * A call summary is caller-authored (a shell command, a URL, a selector, a
 * script), and the banner sits on a screen that a screenshot, a screen share or
 * somebody standing behind the owner can see. So what it carries is scrubbed of
 * the obvious secrets — `Authorization` headers, `password=`-shaped pairs,
 * credential-looking flags, URL userinfo, well-known token prefixes, JWTs,
 * private keys and long opaque runs — and capped. It is a heuristic and the
 * docs say so: it catches the shapes above, not a password typed as a bare
 * word. The audit log on disk is not touched by any of this.
 */
export const MAX_SCREEN_CHARS = 240;

const UNPRINTABLE =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

const SECRET_NAME =
  "[A-Za-z0-9_.-]*(?:token|secret|passw(?:or)?d|passwd|pwd|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|credentials?|cookie|session[_-]?id|signature)";

const RULES: [RegExp, string][] = [
  // A PEM private key, whole or cut off by an earlier cap.
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
    "[redacted key]",
  ],
  // `Authorization: Bearer x`, `authorization=Basic x`, a cookie header.
  [
    /\b((?:proxy-)?authorization|cookie|set-cookie|x-api-key)(\s*[:=]\s*)(?:(bearer|basic|token|digest)\s+)?[^\s"',;]+/gi,
    "$1$2$3 [redacted]",
  ],
  [/\bbearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, "Bearer [redacted]"],
  // `scheme://user:password@host`.
  [/\b([a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:)[^@\s/]+@/gi, "$1[redacted]@"],
  // `password=x`, `"api_key": "x"`, `?token=x`, `--token=x`.
  [
    new RegExp(`(${SECRET_NAME}["']?\\s*[:=]\\s*["']?)[^\\s"'&;,)}]+`, "gi"),
    "$1[redacted]",
  ],
  // `--password x`, `-p` is too common to guess at; the flag form only.
  [
    new RegExp(`(\\s--?${SECRET_NAME}\\s+["']?)[^\\s"']+`, "gi"),
    "$1[redacted]",
  ],
  // Well-known token shapes, wherever they appear.
  [
    /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|ya29\.[0-9A-Za-z_-]{20,})/g,
    "[redacted]",
  ],
  // A JWT.
  [
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g,
    "[redacted jwt]",
  ],
];

/** A long run that looks like key material rather than a word, path or hash. */
function looksOpaque(run: string): boolean {
  if (/^[0-9a-f]+$/i.test(run)) return run.length >= 48; // a git SHA is 40
  if (!/[0-9]/.test(run) || !/[a-z]/.test(run) || !/[A-Z]/.test(run))
    return false;
  // A path made of short segments is a path.
  return Math.max(...run.split("/").map((s) => s.length)) >= 24;
}

/** Scrub and cap one line of caller-authored text for the banner. */
export function screenText(raw: string, max = MAX_SCREEN_CHARS): string {
  let s = raw.slice(0, 4000).replace(UNPRINTABLE, " ");
  for (const [re, to] of RULES) s = s.replace(re, to);
  s = s.replace(/[A-Za-z0-9+/=_-]{40,}/g, (run) =>
    looksOpaque(run) ? `[redacted ${run.length} chars]` : run,
  );
  s = s.replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export interface SessionClaim {
  /** What the banner prints, e.g. "session 28427". */
  label: string;
  /** Only ever an https URL: the banner opens it on a click. */
  url?: string;
}

const MAX_SESSION_CHARS = 200;

/**
 * The session a caller SAYS it acts for, from `request_control`'s optional
 * `session` argument. strad forwards a tool's name and arguments and nothing
 * else, so nothing on the wire identifies the session behind a call; this is
 * the caller's own claim, shown as one, and it grants nothing.
 *
 * An https URL becomes a link; anything else is a label with no link, so a
 * caller cannot make the banner open a `file:` URL or a custom scheme. A
 * malformed value is dropped rather than refused: it is display, and a bad
 * label must not cost a caller its grant.
 */
export function normalizeSession(raw: unknown): SessionClaim | undefined {
  if (typeof raw !== "string") return undefined;
  const value = raw.replace(UNPRINTABLE, " ").replace(/\s+/g, " ").trim();
  if (value.length === 0 || value.length > MAX_SESSION_CHARS) return undefined;
  let url: URL | undefined;
  try {
    url = new URL(value);
  } catch {
    url = undefined;
  }
  if (url) {
    if (url.protocol !== "https:" || url.username || url.password)
      return undefined;
    const id = /\/sessions\/([A-Za-z0-9_-]+)\/?$/.exec(url.pathname)?.[1];
    return {
      label: id ? `session ${id}` : screenText(url.host + url.pathname, 80),
      url: url.toString(),
    };
  }
  if (/^\d+$/.test(value)) return { label: `session ${value}` };
  return { label: screenText(value, 80) };
}
