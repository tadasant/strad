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
 */

/**
 * evt -> the fields that may be exported with it.
 *
 * Add an event here only if you can say, for each field, that its VALUES come
 * from strad's config or strad's vocabulary. A slug is config. A tool name is
 * the upstream's. A reason sentence written in this repo is ours; an error
 * message caught from a client is not.
 */
export const EXPORTABLE: Record<string, readonly string[]> = {
  /** Boot. The roster proves which build is running and what it mounted. */
  "strad.listening": ["port", "mode", "bundle", "env", "servers", "tokens"],
  /** THE line this whole change exists for. `error` is excluded; see above. */
  "mcp.list_tools_failed": ["slug", "explicit"],
  "mcp.list_resources_failed": ["slug"],
  /** A slug that is mounted and serving nothing. */
  "strad.tool_surface_degraded": ["slug", "state", "reason"],
  "strad.tool_surface_recovered": ["slug", "tools"],
  "strad.tool_surface": ["servers", "serving", "degraded"],
  /** 424 fail-closed, and the policy typo that silently narrows a toolset. */
  "mcp.unavailable": ["principal", "requested", "unavailable"],
  "mcp.policy_unmatched_tools": ["slug", "tools"],
  /** Auth. `reason` is an enum-ish string this repo authors, never a token. */
  "mcp.auth_failed": ["reason"],
  /** Secrets plumbing, where a silent failure has the same shape as this one. */
  "strad.secrets_hydrated": ["provider", "keys"],
};

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
 * Emit one structured event.
 *
 * ALWAYS writes the full payload to stdout — that stream is the operator's own
 * console and nothing here narrows it. Then, if the event is exportable and an
 * SDK is running, ships the allowlisted subset.
 *
 * Never throws. A telemetry pipeline must not be able to break a request path,
 * and this one is called from inside the gateway's error handling.
 */
export function event(payload: Record<string, unknown>): void {
  const line = JSON.stringify(payload);
  const evt = typeof payload.evt === "string" ? payload.evt : undefined;
  // Failures keep going to stderr, so `docker logs` and App Platform's error
  // stream still separate them the way they did before this existed.
  if (evt && (evt.endsWith("_failed") || evt.endsWith("_degraded"))) {
    console.error(line);
  } else {
    console.log(line);
  }

  if (!logger || !evt) return;
  const allowed = EXPORTABLE[evt];
  if (!allowed) return;

  try {
    logger.emit({
      severityNumber: CLASSIFY_ERROR.has(evt)
        ? SeverityNumber.ERROR
        : SeverityNumber.INFO,
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
