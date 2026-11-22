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
 * word. The audit log, the status page and the notifications go through the
 * same rules, after an exact pass over every value the daemon knows
 * (`src/redact.ts`).
 */
export const MAX_SCREEN_CHARS = 240;

const UNPRINTABLE =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g;

const SECRET_NAME =
  "[A-Za-z0-9_.-]*(?:auth|token|secret|passw(?:or)?d|passwd|pwd|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|credentials?|cookie|session[_-]?id|signature)";

const RULES: [RegExp, string][] = [
  // A PEM private key, whole or cut off by an earlier cap.
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
    "[redacted key]",
  ],
  // A cookie header, every pair of it: to the closing quote or the end.
  [/\b((?:set-)?cookie)(\s*[:=]\s*)[^"'\n]+/gi, "$1$2[redacted]"],
  // `Authorization: Bearer x`, `authorization=Basic x`.
  [
    /\b((?:proxy-)?authorization|x-api-key)(\s*[:=]\s*)(?:(bearer|basic|token|digest)\s+)?[^\s"',;]+/gi,
    "$1$2$3 [redacted]",
  ],
  // `curl -u user:password`.
  [/(\s(?:-u|--user)\s+["']?[^:\s"']+:)[^\s"']+/g, "$1[redacted]"],
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
    /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|xapp-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9_-]{20,}|[sr]k_(?:live|test)_[A-Za-z0-9]{10,}|dop_v1_[0-9a-f]{20,}|npm_[A-Za-z0-9]{20,}|pypi-[A-Za-z0-9_-]{20,}|lin_api_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|ya29\.[0-9A-Za-z_-]{20,})/g,
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
  if (!/[0-9]/.test(run) || !/[a-z]/i.test(run)) return false;
  // A path made of short segments is a path; one long segment with digits
  // and letters in it is a key whatever its case.
  return Math.max(...run.split("/").map((s) => s.length)) >= 32;
}

/** Scrub and cap one line of caller-authored text for the banner. */
export function screenText(raw: string, max = MAX_SCREEN_CHARS): string {
  // What is typed into the foreground may be a password typed as a word, which
  // no pattern catches: it is reduced to its length. A summary carries only
  // the length already; this shape is what an older daemon's audit holds.
  const typed = /^type_text: ("(?:[^"\\]|\\.)*")$/s.exec(raw)?.[1];
  if (typed !== undefined) {
    let n = typed.length - 2;
    try {
      n = (JSON.parse(typed) as string).length;
    } catch {
      // the escaped length is close enough
    }
    return `type_text: ${n >= 80 ? "80+" : n} chars`;
  }
  // The same for a value set into a field through Accessibility.
  const set = /^set_value: (.*?) = (".*)$/s.exec(raw);
  if (set) {
    const [, element = "", value = ""] = set;
    const n = value.length >= 120 ? "118+" : Math.max(0, value.length - 2);
    return `set_value: ${screenText(element, 120)} = (text, ${n} chars)`;
  }
  let s = raw.slice(0, 4000).replace(UNPRINTABLE, " ");
  for (const [re, to] of RULES) s = s.replace(re, to);
  s = s.replace(/[A-Za-z0-9+/=_-]{32,}/g, (run) =>
    looksOpaque(run) ? `[redacted ${run.length} chars]` : run,
  );
  s = s.replace(/\s+/g, " ").trim();
  const chars = [...s];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : s;
}

export interface SessionClaim {
  /** What the banner prints, e.g. "zimmer.example.com · session 28427". */
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
    // The link goes where the label says: its host is in the label, and a
    // query or fragment (a token, say) is dropped rather than shown or kept.
    url.search = "";
    url.hash = "";
    const id = /\/sessions\/([A-Za-z0-9_-]+)\/?$/.exec(url.pathname)?.[1];
    return {
      label: id
        ? `${url.host} · session ${id}`
        : label(url.host + url.pathname.replace(/\/$/, "")),
      url: url.toString(),
    };
  }
  if (/^\d+$/.test(value)) return { label: `session ${value}` };
  return { label: label(value) };
}

/** A label never carries the arrow the banner draws for a real link. */
function label(text: string): string {
  return screenText(text.replace(/[↗⇗➚➶]/g, ""), 80);
}
