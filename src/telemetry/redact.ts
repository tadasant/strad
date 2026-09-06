/**
 * The secrets boundary for telemetry.
 *
 * strad proxies 1Password vault items, Gmail threads, Google Docs, grocery
 * carts and bank data. Tool ARGUMENTS and tool RESULTS routinely contain
 * credentials, TOTP seeds, email bodies and file contents. Telemetry leaves the
 * box and lands in an ingestor we do not control.
 *
 * So the rule, and it is absolute:
 *
 *   NOTHING that came from a tool argument, a tool result, a request body, a
 *   header, or a token may become a span attribute, a span event, a metric
 *   attribute, or an exception message.
 *
 * What may be recorded is SHAPE and IDENTITY: which server, which tool, how
 * many arguments, how many bytes, how long it took, whether it failed and in
 * which of a fixed set of ways. That is enough to answer "is this thing dying
 * of resource starvation", which is the entire point of the exercise, and it is
 * not enough to reconstruct a single secret.
 *
 * Two consequences worth stating out loud, because they look like omissions:
 *
 *   - `recordException()` is never called anywhere in strad's telemetry. The
 *     OTel API writes `exception.message` and `exception.stacktrace` as span
 *     event attributes, and an upstream MCP server's error message is arbitrary
 *     text that we did not author — it can, and in the wild does, echo the
 *     request back. We classify errors instead (see `errorKind`).
 *   - The stdout STREAM is never exported. It contains upstream error messages
 *     (`mcp.list_tools_failed` logs `err.message`), and that is fine where it
 *     is: stdout is the operator's own console. Piping the stream to an external
 *     ingestor would drag those messages across the boundary this file exists to
 *     defend. What IS exported is strad's own events, field by field, against
 *     the allowlist in `events.ts` — where `error` appears on no list and an
 *     event carrying one ships `errorKind()` instead. Adding a field to that
 *     list is a decision about this boundary; make it here, deliberately.
 *
 * `test/telemetry.redaction.test.ts` pins all of this by driving a real tool
 * call whose arguments AND result are stuffed with a canary secret, then
 * asserting the canary appears nowhere in any exported span, metric or log record.
 */

import { errorText } from "../util/error-text.ts";

/**
 * How an error is allowed to be described in telemetry: a fixed, closed set.
 *
 * The array is the source and the union is derived from it, not the other way
 * round. `errorKind()` checks membership at runtime, and a `new Set<ErrorKind>`
 * written out by hand type-checks every element it HAS without requiring every
 * element there is — so a member added to the union and forgotten in the set
 * would fall silently back to message matching, which is this file's own bug
 * reintroduced quietly.
 *
 * `local_machine_offline` is a `local-tunnel` server whose machine is not there.
 * It is the ONE upstream failure this repo documents as expected rather than
 * investigable — the server is a laptop and the laptop is off — so it must be
 * separable from every other kind, and above all from `unknown`, which is where
 * an unclassified fault lands.
 */
const ERROR_KINDS = [
  "timeout",
  "upstream_unavailable",
  "upstream_error",
  "local_machine_offline",
  // A slug whose `mayBeUnseeded:` credential has not been seeded yet. Its own
  // kind because it is the one failure that is neither an outage nor a bug: it
  // is a deploy that shipped ahead of a token on purpose, and it clears when a
  // human seeds a value. See src/gateway/unconfigured.ts.
  "server_unconfigured",
  "not_selected",
  "not_mounted",
  "tool_error",
  "unknown",
] as const;

export type ErrorKind = (typeof ERROR_KINDS)[number];

const ERROR_KIND_SET: ReadonlySet<string> = new Set<string>(ERROR_KINDS);

/**
 * An error that names its OWN kind instead of being pattern-matched.
 *
 * Message matching is a guess about someone else's prose. It is safe (we read
 * the message, we never emit it) and it is all we have for an error thrown by
 * the SDK or by `fetch` — but for an error strad CONSTRUCTS, guessing is
 * absurd: the constructor already knows. `LocalMachineOfflineError` is the case
 * that proved it. Its message is strad's own and deliberately reassuring
 * ("Nothing is wrong with strad."), which matches none of the patterns below,
 * so the one condition documented as expected exported as `unknown` — and paged
 * a production alert channel.
 *
 * An error declares its kind by carrying this field. `errorKind()` honours it
 * only when the value is a member of the closed set, so declaring one can never
 * widen what may be exported.
 */
export interface SelfClassifyingError {
  readonly telemetryKind: ErrorKind;
}

function declaredKind(err: unknown): ErrorKind | null {
  if (typeof err !== "object" || err === null) return null;
  const declared = (err as { telemetryKind?: unknown }).telemetryKind;
  return typeof declared === "string" && ERROR_KIND_SET.has(declared)
    ? (declared as ErrorKind)
    : null;
}

/**
 * Classify an error into one of a FIXED set of kinds.
 *
 * The output is drawn from `ErrorKind` and nothing else — it can never contain
 * a fragment of the underlying message. That is the point: `err.message` from
 * an upstream is attacker-influenced (or, more mundanely, secret-influenced)
 * text, and it must not reach a span.
 *
 * Matching on the message to CHOOSE a kind is safe — we read it, we do not
 * emit it. An error that declares its own kind skips the matching entirely; see
 * `SelfClassifyingError`.
 */
export function errorKind(err: unknown): ErrorKind {
  const declared = declaredKind(err);
  if (declared) return declared;

  const message = errorText(err);

  // The MCP SDK's request timeout. It defaults to 60s and fires at EVERY hop,
  // which is exactly the failure we want to be able to see, so it gets its own
  // kind rather than being lumped into upstream_error.
  if (/timed?[\s_-]?out|timeout|ETIMEDOUT/i.test(message)) return "timeout";
  if (
    /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed/i.test(
      message,
    )
  ) {
    return "upstream_unavailable";
  }
  if (/is not selected for this request/.test(message)) return "not_selected";
  if (/is not mounted/.test(message)) return "not_mounted";
  if (/^upstream MCP server /.test(message)) return "upstream_error";
  return "unknown";
}

/**
 * The SHAPE of a tool call's arguments. Counts and byte sizes only.
 *
 * Argument NAMES are deliberately excluded too. They are lower risk than values
 * — they come from the tool's own schema, not from the caller — but a caller can
 * pass keys we never declared, and "it's probably fine" is not a boundary. A
 * count and a byte size answer the resource question ("is someone shovelling a
 * 4MB payload through Chromium?") without ever touching content.
 */
export function argShape(args: unknown): {
  "mcp.tool.arg_count": number;
  "mcp.tool.args_bytes": number;
} {
  const count =
    args && typeof args === "object" && !Array.isArray(args)
      ? Object.keys(args as Record<string, unknown>).length
      : 0;
  return {
    "mcp.tool.arg_count": count,
    "mcp.tool.args_bytes": byteSize(args),
  };
}

/**
 * The SHAPE of a tool call's result. Byte size, content-block count, error flag.
 *
 * `isError` is a boolean the MCP protocol itself defines, not free text, so it
 * is safe — and it is how we separate "the tool ran and said no" from "the hop
 * blew up", which are very different resource stories.
 */
export function resultShape(result: unknown): {
  "mcp.tool.result_bytes": number;
  "mcp.tool.result_blocks": number;
  "mcp.tool.is_error": boolean;
} {
  const r = result as
    { content?: unknown[]; isError?: boolean } | null | undefined;
  return {
    "mcp.tool.result_bytes": byteSize(result),
    "mcp.tool.result_blocks": Array.isArray(r?.content) ? r.content.length : 0,
    "mcp.tool.is_error": r?.isError === true,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Free text, and the one channel that carries it
 *
 * Everything above answers the same way: do not emit the text, emit its shape.
 * That works because a span attribute is a field we CHOSE to write, and there is
 * always a count or a closed-set word that says as much.
 *
 * A crash report is the one place where it does not work. The whole content of
 * "strad died of an uncaught TypeError" is the message and the stack, and a
 * report stripped of both says only "something happened", which is what we
 * already have. So the exception reporter (see `errors.ts`) is the single
 * channel in strad that ships text it did not fully author, and this is the
 * filter that stands in front of it.
 *
 * The filter is narrow on purpose, and it is NOT a substitute for the boundary
 * above it:
 *
 *   - Only strad's OWN uncaught exceptions and unhandled rejections go through
 *     it. An upstream MCP server's error message never does — those are caught,
 *     classified by `errorKind()` and never reported (see `errors.ts` for why
 *     the `event()` fault path deliberately does not capture).
 *   - It scrubs by VALUE, not by hope: every credential-shaped env var this
 *     process holds is looked up and struck out of the text, including the
 *     string leaves of a JSON one like `STRAD_TOKENS`. A stack that echoes a
 *     token strad is actually holding cannot carry it out.
 *   - It scrubs by SHAPE as a second pass: PEM blocks, JWTs, `Bearer` lines,
 *     URL userinfo, and `secret-ish-key = value` pairs, for the credentials this
 *     process does not hold in its own environment (an upstream's, a caller's).
 *   - It truncates. A message long enough to be a payload is a payload.
 *
 * Over-redaction is the intended failure direction. A crash report that says
 * `[redacted]` where a filename should be is a mild annoyance; one that says
 * `Bearer eyJ…` is an incident.
 * ──────────────────────────────────────────────────────────────────────────── */

/** What `scrubText` writes in place of anything it strikes out. */
export const REDACTED = "[redacted]";

/**
 * Longer than any legitimate error message, short enough that a payload cannot
 * hide in one. Sentry truncates to `maxValueLength` (250) on its own; this
 * bounds what we hand it in the first place, including stack frames.
 */
const MAX_TEXT = 2048;

/**
 * An env var whose VALUE is treated as a credential.
 *
 * Matched on the NAME, deny-by-default in the direction that matters: a name
 * this misses costs us a scrub we would have liked, a name it catches
 * needlessly costs us a `[redacted]` in a crash report. `DSN` is here because
 * the reporter's own DSN is a write credential for the ingestor, and an error
 * thrown while talking to it would otherwise quote it back.
 */
const CREDENTIAL_ENV_NAME =
  /(TOKEN|SECRET|PASSWORD|PASSWD|PASS|CREDENTIAL|APIKEY|API_KEY|_KEY|KEY_JSON|PRIVATE|AUTH|DSN|HEADERS|COOKIE|SESSION|SIGNATURE|WEBHOOK)/i;

/**
 * Short enough to be a flag, a port or a boolean rather than a credential.
 * Striking out every occurrence of `true` would redact the English language.
 */
const MIN_SECRET_LENGTH = 8;

/**
 * Every credential-shaped value this process is holding, longest first.
 *
 * Longest-first matters: `STRAD_TOKENS` (the whole JSON document) and the
 * individual token inside it are both in this list, and replacing the long one
 * first means the report says `[redacted]` once instead of once per leaf.
 *
 * Read fresh on each call rather than captured at boot, so a value that arrived
 * by hydration — or by a rotation the provider picked up an hour in — is
 * scrubbed too.
 */
export function credentialValues(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const values = new Set<string>();
  for (const [name, value] of Object.entries(env)) {
    if (!value || value.length < MIN_SECRET_LENGTH) continue;
    if (!CREDENTIAL_ENV_NAME.test(name)) continue;
    values.add(value);
    // A JSON-valued credential (`STRAD_TOKENS` is an array of token records)
    // leaks one LEAF at a time, not the whole document — so the leaves are
    // secrets in their own right.
    for (const leaf of jsonStringLeaves(value)) values.add(leaf);
  }
  return [...values].sort((a, b) => b.length - a.length);
}

/** The string leaves of a JSON document, if it is one. Bounded, never throws. */
function jsonStringLeaves(raw: string): string[] {
  if (!/^\s*[[{]/.test(raw)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const out: string[] = [];
  const walk = (node: unknown, depth: number): void => {
    if (out.length >= 256 || depth > 6) return;
    if (typeof node === "string") {
      if (node.length >= MIN_SECRET_LENGTH) out.push(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    if (node && typeof node === "object") {
      for (const value of Object.values(node)) walk(value, depth + 1);
    }
  };
  walk(parsed, 0);
  return out;
}

/**
 * Credential SHAPES, for the secrets this process does not hold itself.
 *
 * Each entry rewrites the value and keeps enough of the shape that a reader can
 * still tell what kind of thing was there — "the Authorization header was
 * present and wrong" is a different bug from "there was no Authorization
 * header", and a blanket `[redacted]` erases the difference.
 */
const CREDENTIAL_SHAPES: ReadonlyArray<readonly [RegExp, string]> = [
  // A PEM block. This is the shape a GCP service-account key takes when it ends
  // up inside an exception, and it is the single worst thing that could ship.
  [
    /-----BEGIN [A-Z0-9 ]*-----[\s\S]*?-----END [A-Z0-9 ]*-----/g,
    `${REDACTED}:pem`,
  ],
  // A JWT. Three base64url segments; the first is always `eyJ` ("{"...).
  [
    /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g,
    `${REDACTED}:jwt`,
  ],
  // `Authorization: Bearer <token>`, and the Basic/Token spellings of it.
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{6,}/gi, `$1 ${REDACTED}`],
  // Userinfo in a URL: `https://user:password@host/…`.
  [/\/\/[^/\s:@]+:[^/\s@]+@/g, `//${REDACTED}@`],
  // `token=…`, `"api_key": "…"`, `password = …` — a credential-shaped KEY, in
  // a query string, a JSON fragment or a config echo, with its value. The
  // lookahead leaves an `Authorization: Bearer …` to the rule above, which has
  // already redacted it and keeps the scheme word; without it this would eat
  // the word `Bearer` as if it were the credential.
  [
    /((?:api[-_]?key|access[-_]?token|auth(?:orization)?|credential|passwd|password|private[-_]?key|refresh[-_]?token|secret|session|signature|token)["']?\s*[=:]\s*["']?)(?!(?:Bearer|Basic|Token)\b)[^\s,;&"'`)\]}]{4,}/gi,
    `$1${REDACTED}`,
  ],
];

/**
 * Strike every credential out of a piece of free text, then bound its length.
 *
 * `secrets` is the exact-value list from `credentialValues()`. It runs FIRST:
 * a value we know is a secret is struck out whatever it looks like, and only
 * then do the shape rules run over what is left.
 *
 * Never throws — this runs inside a crash reporter, and a reporter that throws
 * while reporting a crash is how a crash becomes a silence.
 */
export function scrubText(
  text: string,
  secrets: readonly string[] = [],
): string {
  // Truncate FIRST. Two of the shape rules scan to end-of-string for every
  // unmatched prefix (`-----BEGIN `, `//`), so running them over a multi-megabyte
  // message — an upstream's HTML body wrapped in an Error, a payload dumped into
  // one — is quadratic work on the one path that must not stall: the crash path.
  const truncated = text.length > MAX_TEXT;
  let out = truncated ? text.slice(0, MAX_TEXT) : text;
  try {
    for (const secret of secrets) {
      if (secret.length < MIN_SECRET_LENGTH) continue;
      out = out.split(secret).join(REDACTED);
    }
    for (const [pattern, replacement] of CREDENTIAL_SHAPES) {
      out = out.replace(pattern, replacement);
    }
  } catch {
    // Whatever went wrong in there, the text loses rather than the report.
    return REDACTED;
  }
  return truncated ? `${out}…[truncated]` : out;
}

/**
 * Serialized size in bytes, without retaining the serialization.
 *
 * A payload that cannot be serialized (a cycle, a BigInt) yields 0 rather than
 * throwing: telemetry must never be the thing that breaks a tool call.
 */
export function byteSize(value: unknown): number {
  if (value === undefined || value === null) return 0;
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
  } catch {
    return 0;
  }
}
