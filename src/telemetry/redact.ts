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
 *   - No OTel LOG exporter is configured. strad's stdout already contains
 *     error messages (`mcp.list_tools_failed` logs `err.message`), and that is
 *     fine where it is: stdout is the operator's own console. Piping it to an
 *     external ingestor would drag those messages across the boundary this file
 *     exists to defend. If you ever add a log exporter, you must first redact
 *     those log lines.
 *
 * `test/telemetry.redaction.test.ts` pins all of this by driving a real tool
 * call whose arguments AND result are stuffed with a canary secret, then
 * asserting the canary appears nowhere in any exported span or metric.
 */

/** How an error is allowed to be described in telemetry: a fixed, closed set. */
export type ErrorKind =
  | "timeout"
  | "upstream_unavailable"
  | "upstream_error"
  | "not_selected"
  | "not_mounted"
  | "tool_error"
  | "unknown";

/**
 * Classify an error into one of a FIXED set of kinds.
 *
 * The output is drawn from `ErrorKind` and nothing else — it can never contain
 * a fragment of the underlying message. That is the point: `err.message` from
 * an upstream is attacker-influenced (or, more mundanely, secret-influenced)
 * text, and it must not reach a span.
 *
 * Matching on the message to CHOOSE a kind is safe — we read it, we do not
 * emit it.
 */
export function errorKind(err: unknown): ErrorKind {
  const message = err instanceof Error ? err.message : String(err);

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
 *
 * ── Why this deliberately does NOT call JSON.stringify ──────────────────────
 *
 * A tool result is the biggest object in the system: fetchpet, good-eggs and
 * pointsyeah return Chromium screenshots — multi-megabyte base64 blobs.
 * `JSON.stringify(result)` merely to MEASURE it would allocate a second copy of
 * that blob, on a 1GB box, on every call, and then throw it away. That is a
 * transient doubling of peak memory plus a synchronous multi-MB stringify
 * blocking the event loop — which is to say, precisely the OOM and the
 * saturation this telemetry exists to detect, manufactured by the telemetry
 * itself.
 *
 * So we walk the content blocks and SUM the lengths of the strings already sitting
 * in them. No allocation, no copy. The result is an ESTIMATE of payload size,
 * which is all a resource signal needs; it is not an exact wire-byte count and
 * does not claim to be.
 */
export function resultShape(result: unknown): {
  "mcp.tool.result_bytes": number;
  "mcp.tool.result_blocks": number;
  "mcp.tool.is_error": boolean;
} {
  const r = result as
    { content?: unknown[]; isError?: boolean } | null | undefined;
  const content = Array.isArray(r?.content) ? r.content : [];

  let bytes = 0;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    // `text` on a text block, `data` on an image/audio block (base64). Both are
    // already strings on the object — reading `.length` allocates nothing.
    const b = block as { text?: unknown; data?: unknown };
    if (typeof b.text === "string") bytes += b.text.length;
    if (typeof b.data === "string") bytes += b.data.length;
  }

  return {
    "mcp.tool.result_bytes": bytes,
    "mcp.tool.result_blocks": content.length,
    "mcp.tool.is_error": r?.isError === true,
  };
}

/**
 * Serialized size in bytes, without retaining the serialization.
 *
 * Used for tool ARGUMENTS only. Arguments are small — a search query, a vault
 * item reference — unlike results; see `resultShape` for why the big side of the
 * call is measured without serializing.
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
