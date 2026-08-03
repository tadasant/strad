import { logs, SeverityNumber, type Logger } from "@opentelemetry/api-logs";
import { errorKind } from "./redact.ts";

/**
 * strad's own structured events, on stdout AND in the obs stack.
 *
 * ## Why this exists, and why it did not before
 *
 * strad exported metrics and traces and deliberately no logs. The reasoning was
 * sound: stdout carries upstream error messages — arbitrary text strad did not
 * author — and shipping the stream wholesale would drive straight through the
 * boundary in redact.ts.
 *
 * The cost of that came due. The `secrets` slug served zero tools in production
 * for over a week; `mcp.list_tools_failed` named the failure on every single
 * request, and went to a stream with no ingestor. On App Platform, a log nobody
 * ships is a log nobody reads.
 *
 * So the answer is not "ship stdout" and it is not "ship nothing". It is: ship
 * the events strad AUTHORS, field by field, against an ALLOWLIST.
 *
 * ## The allowlist is the whole design
 *
 * `EXPORTABLE` names every event that may leave the process and, for each, the
 * exact fields that may go with it. A field not on the list is not exported —
 * not truncated, not redacted, not included. That is deliberate:
 *
 *   - It is a DENY-BY-DEFAULT list. A new field added to an existing log call
 *     does not silently start being exported, so nobody widens this boundary by
 *     editing an unrelated line. The exporter cannot leak a field its author
 *     never considered, because considering it is how a field gets on the list.
 *   - `error` is on NO list. Every upstream error message in this codebase lands
 *     in a field of that name, and the one that mattered here was a full HTML
 *     page from someone else's Express. Where an event carries one, the exporter
 *     substitutes `error.kind` — the classification from redact.ts, which is one
 *     of a fixed set of words strad wrote.
 *
 * Everything still goes to stdout in full, unchanged. An operator with a shell
 * sees the upstream's own words; the ingestor sees strad's.
 *
 * ## What is deliberately NOT on the list
 *
 * `mcp.auth_failed`. Its attributes are safe — `reason` is a closed set — but it
 * is emitted BEFORE authentication succeeds, so anyone who can reach `/mcp`
 * produces one exported record per request. A bot spraying bad bearer tokens
 * would fill the batch queue and evict `mcp.list_tools_failed`, which is the one
 * signal this file exists to deliver. `strad.mcp.auth_failures` already counts
 * the same thing, by the same `reason`, in a channel with no queue to starve.
 */

/**
 * evt -> the fields that may be exported with it.
 *
 * Add an event here only if you can say, for each field, WHERE ITS VALUE COMES
 * FROM at every call site that emits it. That is the part this table cannot
 * check for you: it guarantees which KEYS ship, never what is under them. A slug
 * that came from the config is ours. The same field populated from
 * `req.query.servers` is the caller's, and `mcp.unavailable` shipped exactly
 * that until a review caught it — a client could write any string it liked into
 * the ingestor by asking for a server that does not exist.
 *
 * The rule of thumb that survives that: a value is exportable if a hostile
 * client and a broken upstream can BOTH only ever cause it to take one of a set
 * of values this repo wrote down. A count is safe. A word from a closed set is
 * safe. A string that reached us over the wire is not, however harmless it looks.
 *
 * Keys are also globally consistent in TYPE across events, because an ingestor
 * that derives a schema (Elasticsearch and friends) treats the second type for a
 * key as a mapping conflict and drops the record. Hence `tool_count` and
 * `server_count` rather than reusing `tools` and `servers`, which are arrays
 * elsewhere in this table.
 */
export const EXPORTABLE: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    /** Boot. The roster proves which build is running and what it mounted. */
    "strad.listening": ["port", "mode", "bundle", "env", "servers", "tokens"],
    /** THE line this whole change exists for. `error` is excluded; see above. */
    "mcp.list_tools_failed": ["slug", "explicit"],
    "mcp.list_resources_failed": ["slug"],
    /** A slug that is mounted and serving nothing. */
    "strad.tool_surface_degraded": ["slug", "state", "reason"],
    "strad.tool_surface_recovered": ["slug", "tool_count"],
    "strad.tool_surface": ["server_count", "serving_count", "degraded"],
    /**
     * 424 fail-closed. `requested` and the raw `unavailable` list are NOT here:
     * both are the caller's own query string, echoed back. What ships is the
     * subset that names a CONFIGURED slug plus counts — enough to see "a client
     * keeps asking for `secrets` and being refused", which is the operational
     * question, with nothing a caller can write into.
     */
    "mcp.unavailable": [
      "principal",
      "requested_count",
      "unavailable",
      "unknown_count",
    ],
    /** Entries of the config's own `tools.allow`, not the upstream's names. */
    "mcp.policy_unmatched_tools": ["slug", "tools"],
    /** Secrets plumbing, where a silent failure has the same shape as this one. */
    "strad.secrets_hydrated": ["provider", "keys"],
    /** Clean SIGTERM or an OOM kill — the difference is one line, or its absence. */
    "strad.shutdown": ["signal"],
    /**
     * THE EVENT NAME AND NOTHING ELSE. Both of these already reduce their error
     * to a class name or a summary before logging, and both are still text this
     * repo did not fully author — a rendered secret can end up inside a store
     * client's exception. "This surface is failing" is the operational fact and
     * it needs no field at all; the message stays on stderr for whoever is
     * holding a shell.
     */
    "strad.readiness_failed": [],
    "strad.store_diagnostics_failed": [],
  });

/**
 * Events whose `error` field should become `error.kind`.
 *
 * Kept separate from the allowlist so the two rules read independently: the
 * allowlist says what MAY be exported, this says what a caught exception is
 * allowed to turn into.
 */
const CLASSIFY_ERROR = new Set([
  "mcp.list_tools_failed",
  "mcp.list_resources_failed",
]);

/** Set by startTelemetry once an SDK is running. Null means stdout only. */
let logger: Logger | null = null;

export function enableEventExport(name: string, version: string): void {
  logger = logs.getLogger(name, version);
}

export function disableEventExport(): void {
  logger = null;
}

/** Test seam: the current logger, so a test can assert it is or is not wired. */
export function eventExportEnabled(): boolean {
  return logger !== null;
}

/**
 * Events that fire on the REQUEST path, throttled per (evt, slug).
 *
 * EVERY exportable event a client can drive is here, and that is the rule rather
 * than a list of the noisy ones. `mcp.list_tools_failed` is emitted once per
 * failing slug per listing, so a client polling a 29-slug gateway can produce 29
 * records a second; `mcp.policy_unmatched_tools` fires on every `tools/list` for
 * a slug with one typo in its `tools.allow`; `mcp.unavailable` fires on every
 * 424. The batch processor's queue is shared, and a flood of one fact evicts the
 * others — which is the same argument that keeps `mcp.auth_failed` off the
 * allowlist entirely. The only difference here is that it takes a valid token.
 *
 * One record a minute per slug says exactly as much. `mcp.unavailable` carries
 * no slug, so it keys on one global bucket, which is the right granularity for
 * it anyway.
 *
 * stdout is never throttled. It has no queue to starve.
 */
const THROTTLED = new Set([
  "mcp.list_tools_failed",
  "mcp.list_resources_failed",
  "mcp.policy_unmatched_tools",
  "mcp.unavailable",
]);
const THROTTLE_MS = 60_000;
const lastExported = new Map<string, number>();

/**
 * Emit one structured event.
 *
 * ALWAYS writes the full payload to stdout/stderr — those streams are the
 * operator's own console and nothing here narrows them. Then, if the event is
 * exportable and an SDK is running, ships the allowlisted subset.
 *
 * Never throws. A telemetry pipeline must not be able to break a request path,
 * and this one is called from inside the gateway's error handling.
 */
export function event(payload: Record<string, unknown>): void {
  const evt = typeof payload.evt === "string" ? payload.evt : undefined;
  // A failure or a degradation goes to stderr — including `mcp.auth_failed`,
  // which the router used to write to stdout. That is a deliberate change and
  // the only one: everything a log scraper would key on now agrees with what the
  // event is, rather than with which call site happened to emit it.
  const fault = Boolean(
    evt && (evt.endsWith("_failed") || evt.endsWith("_degraded")),
  );
  const stream = fault ? console.error : console.log;

  try {
    stream(JSON.stringify(payload));
  } catch {
    // A circular reference or a BigInt in a payload is a bug in the caller, not
    // a reason to take down the request that was already failing.
    stream(JSON.stringify({ evt, unserializable: true }));
  }

  if (!logger || !evt) return;
  const allowed = EXPORTABLE[evt];
  if (!allowed) return;

  if (THROTTLED.has(evt)) {
    const key = `${evt}:${String(payload.slug ?? "")}`;
    const now = Date.now();
    const last = lastExported.get(key);
    if (last !== undefined && now - last < THROTTLE_MS) return;
    lastExported.set(key, now);
  }

  try {
    logger.emit({
      // From the FAULT rule, not from CLASSIFY_ERROR — those answer different
      // questions, and conflating them shipped `strad.tool_surface_degraded`
      // and `strad.readiness_failed` at INFO. `severity >= ERROR` is the first
      // filter any operator writes, and a fault invisible to it is a fault
      // nobody sees.
      severityNumber: fault ? SeverityNumber.ERROR : SeverityNumber.INFO,
      // The event name, not the message. A body is free text and free text is
      // how an upstream's words get in; there is nothing to put here that the
      // attributes do not already say in a queryable form.
      body: evt,
      attributes: exportableAttributes(evt, payload, allowed),
    });
  } catch {
    // An export failure is not this request's problem.
  }
}

/** Test seam: the throttle is process-global and would leak between cases. */
export function resetEventThrottle(): void {
  lastExported.clear();
}

function exportableAttributes(
  evt: string,
  payload: Record<string, unknown>,
  allowed: readonly string[],
): Record<string, string | number | boolean | string[]> {
  const out: Record<string, string | number | boolean | string[]> = {
    "strad.evt": evt,
  };

  for (const key of allowed) {
    const value = payload[key];
    if (value === undefined || value === null) continue;
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      out[key] = value;
    } else if (
      Array.isArray(value) &&
      value.every((v) => typeof v === "string")
    ) {
      out[key] = value as string[];
    }
    // Anything else — an object, a mixed array — is dropped rather than
    // stringified. A nested structure is exactly where an unreviewed field
    // hides, and JSON.stringify would carry it straight out.
  }

  // The classification, in place of the message. `errorKind` returns one of a
  // fixed set of words this repo wrote — "timeout", "connection", "http", … —
  // derived from the error's shape and never from its text.
  if (CLASSIFY_ERROR.has(evt) && payload.error !== undefined) {
    out["error.kind"] = errorKind(payload.error);
  }

  return out;
}
