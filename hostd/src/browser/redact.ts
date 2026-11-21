/**
 * Token-shaped values are taken out of what the browser server's reads return,
 * BEFORE the result leaves the daemon.
 *
 * Why here and not in the agent: a page that renders credentials (a "your API
 * tokens" list, a settings page showing a DSN) is read with a call that carries
 * only a `tab_id` — no URL a pre-call hook could inspect — and anything after
 * the call is too late, because the value is already in the model's context.
 * The daemon is the last place that holds the text and the first place that
 * can decide what of it leaves.
 *
 * This is a heuristic, and it says so: a credential with no recognisable prefix
 * and too little length or entropy to look random passes through. Custody's
 * exact-value egress filter (`src/custody/enforce.ts`) is unaffected and still
 * runs after this, over every result. Custody's own capture tools do not pass
 * through here at all — they never return a value.
 */

export const REDACTED = "[redacted:token]";

/** Credentials with a published, unambiguous prefix. No entropy check needed. */
const PREFIXED: RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{30,}/g, // GitHub classic, OAuth, user-to-server, server, refresh
  /\bgithub_pat_[A-Za-z0-9_]{30,}/g, // GitHub fine-grained
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, // Slack bot/user/app-level/refresh
  /\bxapp-[A-Za-z0-9-]{10,}/g, // Slack app-level
  /\bsk-[A-Za-z0-9_-]{20,}/g, // OpenAI, Anthropic (sk-ant-), OpenRouter (sk-or-v1-)
  /\bgl(?:pat|dt|rt|ptt|cbt|oas|soat|ffct|imt|agent)-[A-Za-z0-9_-]{20,}/g, // GitLab
  /\b[sr]k_(?:live|test)_[A-Za-z0-9]{10,}/g, // Stripe secret / restricted
  /\bwhsec_[A-Za-z0-9+/=]{20,}/g, // Stripe / Standard Webhooks signing secret
  /\blin_(?:api|oauth)_[A-Za-z0-9]{20,}/g, // Linear
  /\bsntr[ysu]_[A-Za-z0-9+/=_]{20,}/g, // Sentry org / user / system tokens
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, // AWS access key id
  /\bAIza[0-9A-Za-z_-]{35}/g, // Google API key
  /\bya29\.[0-9A-Za-z_-]{20,}/g, // Google OAuth access token
  /\bGOCSPX-[A-Za-z0-9_-]{20,}/g, // Google OAuth client secret
  /\bnpm_[A-Za-z0-9]{36}/g, // npm
  /\bhf_[A-Za-z0-9]{30,}/g, // Hugging Face
  /\bdo[opr]_v1_[a-f0-9]{64}/g, // DigitalOcean
  /\bpat[A-Za-z0-9]{14}\.[a-f0-9]{64}/g, // Airtable
  /\bshp(?:at|ca|pa|ss)_[a-fA-F0-9]{32}/g, // Shopify
  /\bops_[A-Za-z0-9_-]{40,}/g, // 1Password service account
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
];

/** A whole PEM block, or a BEGIN whose END was cut off by a clip. */
const PEM =
  /-----BEGIN [A-Z0-9 ]+-----[\s\S]*?(?:-----END [A-Z0-9 ]+-----|$(?![\s\S]))/g;

/**
 * A URL's userinfo: `https://<key>@o1.ingest.sentry.io/2` (a Sentry/GlitchTip
 * DSN), `postgres://user:pass@host/db`. Redacted when it has a password, or a
 * user long enough to be a key. A short bare user (`git@`, `me@`) is left.
 */
const USERINFO =
  /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/?#@'"<>]+)@(?=[^\s/?#@'"<>])/gi;

/** A value right after a word that names a credential: `token: …`, `"api_key":"…"`. */
const LABELLED =
  /\b(token|secret|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|password|passwd|bearer|authorization|dsn)([\s"':=]{1,6})([A-Za-z0-9_\-+/=.~]{16,})/gi;

/** 48+ hex: long enough to skip a git SHA (40) and catch a 64-hex API token. */
const LONG_HEX =
  /(?<![A-Za-z0-9])(?<!sha(?:256|384|512)[:-])[0-9a-fA-F]{48,}(?![A-Za-z0-9])/g;

/** 40+ chars from the base64 / base64url alphabet. Kept only if it looks random. */
const LONG_B64 =
  /(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{40,}={0,2}(?![A-Za-z0-9+/_=-])/g;

function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/**
 * Random-looking: upper, lower AND digits, and high per-character entropy. A
 * slug (`how-to-reset-your-password-in-five-steps`), a path, or a word glued to
 * a word fails the mix; a base64 key passes it.
 */
export function looksRandom(s: string): boolean {
  if (!/[A-Z]/.test(s) || !/[a-z]/.test(s)) return false;
  if ((s.match(/[0-9]/g) ?? []).length < 2) return false;
  // A path is judged by its longest segment: a long URL path is many short
  // words, a key with a `/` in it is one long random run either side.
  if (s.includes("/")) {
    const longest = s
      .split("/")
      .reduce((a, b) => (b.length > a.length ? b : a));
    if (longest.length < 24) return false;
  }
  // 40 random base64 characters run ~4.9 bits each; CamelCase English ~4.2.
  return entropy(s) >= 4.5;
}

/** Hex is a 16-letter alphabet: a real token is ~4 bits/char, a run of `0`s is not. */
function looksRandomHex(s: string): boolean {
  return /[0-9]/.test(s) && /[a-fA-F]/.test(s) && entropy(s) >= 3.0;
}

/** Redact every token-shaped value in one string. */
export function redactText(input: string): { text: string; count: number } {
  let count = 0;
  const hit = () => {
    count++;
    return REDACTED;
  };
  let s = input.replace(PEM, hit);
  for (const re of PREFIXED) s = s.replace(re, hit);
  s = s.replace(USERINFO, (m, scheme: string, info: string) => {
    if (info.includes(REDACTED)) return m;
    const [user = "", pass] = info.split(/:(.*)/s, 2);
    if (pass === undefined && user.length < 16) return m;
    count++;
    return `${scheme}${REDACTED}@`;
  });
  s = s.replace(LABELLED, (m, word: string, sep: string, value: string) => {
    if (value === REDACTED || !/[0-9]/.test(value) || !/[A-Za-z]/.test(value))
      return m;
    if (entropy(value) < 3.0) return m;
    count++;
    return `${word}${sep}${REDACTED}`;
  });
  s = s.replace(LONG_HEX, (m) => (looksRandomHex(m) ? hit() : m));
  s = s.replace(LONG_B64, (m) => (looksRandom(m) ? hit() : m));
  return { text: s, count };
}

/**
 * Redact every string in a JSON-shaped value — object keys too — except the
 * values of `keep` keys (read_page's element `selector`, which click_element
 * needs verbatim and which a page does not put a credential in).
 */
export function redactValue<T>(
  value: T,
  keep: ReadonlySet<string> = new Set(),
): { value: T; count: number } {
  let count = 0;
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      const r = redactText(v);
      count += r.count;
      return r.text;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, inner] of Object.entries(v)) {
        const key = walk(k) as string;
        out[key] = keep.has(k) ? inner : walk(inner);
      }
      return out;
    }
    return v;
  };
  return { value: walk(value) as T, count };
}

/**
 * The pages whose whole point is to show a credential. `*` matches any run of
 * characters; a pattern matches the tab's whole URL. On these, read_page's
 * text and html formats and evaluate_script are refused outright; the
 * elements format (redacted, for finding a button) still works.
 */
export const DEFAULT_CREDENTIAL_PAGES: readonly string[] = [
  "*://*/profile/auth-tokens*", // GlitchTip
  "*://*/settings/*auth-tokens*", // Sentry, account and organization
  "https://github.com/settings/tokens*",
  "https://github.com/settings/personal-access-tokens*",
  "*://*/-/user_settings/personal_access_tokens*", // GitLab
  "*://*/-/profile/personal_access_tokens*",
];

export function credentialPageMatcher(
  patterns: readonly string[],
): (url: string) => string | undefined {
  const compiled = patterns.map((p) => ({
    p,
    re: new RegExp(
      `^${p
        .split("*")
        .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*")}$`,
      "i",
    ),
  }));
  return (url) => compiled.find((c) => c.re.test(url))?.p;
}

export function credentialPageRefusal(url: string, pattern: string): string {
  return (
    `Refused: ${url} matches the credential page pattern "${pattern}" (browser.credentialPages in the hostd config). ` +
    "Its text, html and scripts are not read, because a page like this shows credentials in full. " +
    'read_page format "elements" still works for finding a button; to take a credential, use the custody server.'
  );
}
