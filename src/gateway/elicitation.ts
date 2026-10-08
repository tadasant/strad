/**
 * The caller's confirmation channel: where a human is asked before a tool acts.
 *
 * Some upstream tools refuse to act without a human's yes (gmail's
 * `send_email`). They ask through the pulsemcp fallback-elicitation protocol:
 * POST the question to a URL, poll `<url>/<request-id>` for the answer. The URL
 * has to reach a human attached to the session that made the call. One shared
 * bundle process cannot know which session that is, so the CALLER says, on
 * every `/mcp` request, in the `X-Elicitation-Url` header. A Zimmer session
 * sends its own per-session elicitation URL, whose path carries a token that
 * names exactly that session and nothing else.
 *
 * Core does three things with it, and this module is all three:
 *
 *   1. READ it off the request ({@link elicitationChannelFrom}).
 *   2. HOLD IT TO AN ALLOWLIST of URL prefixes
 *      (`gateway.elicitation.allowedUrlPrefixes`). The bundle will fetch this
 *      URL, so an unchecked header is a request the caller can aim anywhere on
 *      strad's private network, and an origin alone would still let it pick
 *      any path on a trusted host. A URL that fails is not dropped in silence:
 *      it becomes a `refused` channel carrying the reason, and the confirmed
 *      tool's refusal repeats it.
 *   3. FORWARD it on the upstream `tools/call` as `_meta` under
 *      {@link ELICITATION_META_KEY} ({@link elicitationMeta}), only to a
 *      `supplementary-image` slug that declares `confirmations: true`. Every
 *      other mount, a third party's URL included, never sees it. Core never
 *      forwards a client's own `_meta`, so an upstream can trust that key as
 *      core's word.
 *
 * A request with no header carries no channel, and a confirmed tool refuses.
 * That includes the console playground and the flow-through route, which never
 * build one, and an `admin` token, which holds every role and still has no
 * human attached.
 */

/** The request header a caller names its confirmation URL in. */
export const ELICITATION_URL_HEADER = "x-elicitation-url";

/** The `_meta` key core forwards the channel under. Mirrored in the bundle. */
export const ELICITATION_META_KEY = "dev.strad/elicitation";

/** A channel to forward, or the reason the caller's was refused. */
export type ElicitationChannel = { url: string } | { refused: string };

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Plain `http` carries the URL, which is a credential, in the clear. It is
 * allowed only where nothing crosses a network: a loopback host, for tests and
 * local development.
 */
function cleartextProblem(url: URL): string | null {
  if (url.protocol === "https:") return null;
  if (url.protocol === "http:" && LOOPBACK.has(url.hostname)) return null;
  return url.protocol === "http:"
    ? "plain http is accepted only for a loopback host"
    : "not a web URL";
}

/**
 * Why `value` cannot be an entry in `gateway.elicitation.allowedUrlPrefixes`,
 * or null when it can. The config schema calls this; it lives here so the rule
 * and the check that relies on it cannot drift apart.
 */
export function elicitationPrefixProblem(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "an allowed URL prefix must be an absolute URL";
  }
  const cleartext = cleartextProblem(url);
  if (cleartext) return `an allowed URL prefix: ${cleartext}`;
  if (url.username || url.password || url.search || url.hash) {
    return "an allowed URL prefix carries no userinfo, query or fragment";
  }
  if (url.href !== value || !url.pathname.endsWith("/")) {
    return (
      "an allowed URL prefix is written in normal form and its path ends in " +
      "`/` (e.g. https://zimmer.example.com/api/v1/elicitations/session/), so " +
      "it cannot match a sibling path that merely starts the same way"
    );
  }
  return null;
}

/**
 * The channel this request carries, or undefined when it names none.
 *
 * The header's value is a credential (the token in its path is what lets a
 * POST create a prompt on that session), so nothing here logs it, and the
 * refusal reasons name the origin, never the path.
 */
export function elicitationChannelFrom(
  header: string | string[] | undefined,
  allowedUrlPrefixes: readonly string[],
): ElicitationChannel | undefined {
  if (header === undefined) return undefined;
  // Node joins a repeated header into one value with ", ", and an array only
  // arrives from a caller that built one by hand. A URL never contains either a
  // comma-space or whitespace, so both forms are refused rather than resolved
  // by picking one.
  const value = (Array.isArray(header) ? header.join(", ") : header).trim();
  if (!value || /[\s,]/.test(value)) {
    return {
      refused: `the ${ELICITATION_URL_HEADER} header must be exactly one URL`,
    };
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { refused: `the ${ELICITATION_URL_HEADER} header is not a URL` };
  }
  const cleartext = cleartextProblem(url);
  if (cleartext) {
    return { refused: `the ${ELICITATION_URL_HEADER} header: ${cleartext}` };
  }
  if (url.username || url.password) {
    return {
      refused: `the ${ELICITATION_URL_HEADER} header may not carry userinfo`,
    };
  }
  // The query and fragment go: the bundle appends `/<request-id>` to poll,
  // which would land inside either one. What is compared is the parser's
  // normal form, so `..` and `%2e%2e` segments are already resolved.
  url.search = "";
  url.hash = "";
  const href = url.toString();
  if (allowedUrlPrefixes.length === 0) {
    return {
      refused:
        "this gateway accepts no confirmation channel " +
        "(gateway.elicitation.allowedUrlPrefixes is empty)",
    };
  }
  const allowed = allowedUrlPrefixes.some(
    (prefix) => href.startsWith(prefix) && href.length > prefix.length,
  );
  if (!allowed) {
    return {
      refused:
        `a URL on ${url.origin} that is not under any of ` +
        "gateway.elicitation.allowedUrlPrefixes",
    };
  }
  return { url: href };
}

/**
 * How long the human gets: shorter than the hop, so the bundle stops
 * accepting an answer before core stops waiting.
 *
 * The order matters. An answer accepted after its `tools/call` timed out would
 * send mail the caller was told had failed, possibly twice if the caller
 * retried. So the deadline is the upstream timeout minus a margin: a quarter
 * of it, at most 15s. The bundle aborts its own requests at the deadline and
 * treats any later answer as expired.
 */
export function confirmationTtlMs(timeoutMs: number): number {
  return timeoutMs - Math.min(15_000, Math.floor(timeoutMs / 4));
}

/** The `_meta` to put on an upstream `tools/call`. */
export function elicitationMeta(
  channel: ElicitationChannel,
  slug: string,
  timeoutMs: number,
): Record<string, unknown> {
  return {
    [ELICITATION_META_KEY]:
      "refused" in channel
        ? { refused: channel.refused }
        : { url: channel.url, slug, ttlMs: confirmationTtlMs(timeoutMs) },
  };
}
