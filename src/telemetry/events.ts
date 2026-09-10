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
 * `NOT_EXPORTED`, below — a second table, keyed the same way, whose values are
 * the REASON. An event's absence from the allowlist otherwise reads the same
 * whether it is a redaction verdict or nobody looking, and those are not the
 * same fact. Every `evt:` literal under `src/` appears in exactly one of the two
 * tables, and `test/telemetry.event-export-decisions.test.ts` fails the build
 * for one that appears in both or in neither.
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
    /**
     * A `local-tunnel` slug that served its troubleshooting tool instead of its
     * own, because its machine was not answering.
     *
     * Deliberately NOT a `_failed` event: nothing failed. It answers "how often
     * is the laptop actually there", which is the only operational question
     * this kind of server raises, and it does so without implying an incident.
     * That is load-bearing rather than tidy — the same condition reported as
     * `mcp.list_tools_failed` ships at ERROR severity and pages an alert rule
     * keyed on it, which is what happened before this event covered every path.
     *
     * `explicit` says whether a client named the slug, and is the one field the
     * older `_failed` record carried that would otherwise be lost. It is a
     * boolean strad computes, not a value from the wire. `state` is a closed
     * set of strad's own words — `offline` or `refused` — and it is the one
     * field here worth alerting on: a machine that is off is somebody's laptop,
     * and one that REFUSES is a credential that has gone stale and will not fix
     * itself. `listed` says whether the slug's own tools made it into the
     * listing, which for this event is always false.
     */
    "mcp.local_machine_offline": ["slug", "listed", "explicit", "state"],
    /** A slug that is mounted and serving nothing. */
    "strad.tool_surface_degraded": ["slug", "state", "reason"],
    "strad.tool_surface_recovered": ["slug", "tool_count"],
    /**
     * A `local-tunnel` slug whose machine is switched off.
     *
     * Its own event rather than a `_degraded` one with a gentler `state`, and
     * the split is the point: `_degraded` is what an alert rule keys on and what
     * a human reads as "go and look at this". A laptop being off is neither, so
     * it ships at Info under a name nothing pages on — while still answering
     * "how often is that machine actually there", which is the only operational
     * question this kind raises.
     */
    "strad.tool_surface_offline": ["slug", "kind"],
    /**
     * A slug waiting on a `mayBeUnseeded:` credential nobody has seeded yet.
     *
     * Its own event, at Info, for the same reason `_offline` has one: `_degraded`
     * is what an alert rule keys on, and a deploy that shipped ahead of a token
     * on purpose is not something to page a human about at 3am. What it IS is a
     * thing a human finishes later, so it still ships — "which slugs are still
     * waiting" is the operational question this feature creates.
     *
     * `names` is the list of `${NAME}`s, which strad's own config authored. No
     * value, and nothing from an upstream.
     */
    "strad.tool_surface_unconfigured": ["slug", "kind", "names"],
    "strad.tool_surface": [
      "server_count",
      "serving_count",
      "degraded",
      "unconfigured",
    ],
    /**
     * A slug that could not be listed because a `mayBeUnseeded:` credential has
     * not been seeded yet.
     *
     * Its own event, at Info, so `mcp.list_tools_failed` and
     * `mcp.list_resources_failed` keep meaning "a fault" — see the branches in
     * gateway/mcpServer.ts. `names` comes from strad's own config; there is no
     * value in it and nothing from an upstream.
     */
    "mcp.server_unconfigured": ["slug", "explicit", "names"],
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
    /**
     * A server persisted a rotated credential, or failed to.
     *
     * Both fields come from the CONFIG — `writableTarget` returns the config's
     * own strings for exactly this reason, so a caller cannot write a slug or a
     * variable name of its choosing into the ingestor by spelling a URL. The
     * failure event carries no `error`: what an operator needs is that this
     * server's next restart is now holding a dead credential, and the store
     * client's exception can quote a rendered value.
     */
    "strad.param_written": ["slug", "variable"],
    "strad.param_write_failed": ["slug", "variable"],
    /**
     * A component asked core to drop its reading of the parameter store — the
     * `secrets` MCP server's `refresh_gateway` tool, or its write tools after a
     * write. `refreshed` is false when the floor held the request off: the
     * reading was younger than the floor and was left alone.
     */
    "strad.store_refreshed": ["refreshed"],
    /**
     * A hosted server read the CURRENT value of one of its own parameters —
     * either the once-at-boot read a `paramsWritable:` server does, or a
     * `paramsRefresh:` poll.
     *
     * This is the deploy record that runtime refresh would otherwise not have.
     * Baking a credential into a spec leaves a rendered artifact an operator can
     * read back mid-incident; re-reading one under a running process leaves
     * nothing, unless this says so. Same two config-owned fields as the writes
     * above, and emphatically not the value.
     */
    "strad.param_read": ["slug", "variable"],
    /**
     * THE EVENT NAME AND NOTHING ELSE, for the same reason the two above carry
     * config strings only: this one fires when the lookup FAILED, so the only
     * slug and variable in scope are the caller's own bytes. A refusal is
     * usually a typo'd `paramsWritable:` entry, and "this is happening at all"
     * is the operational fact; core's stderr carries which name.
     */
    "strad.param_refused": [],
    /**
     * The console connector flow: a human consenting, in strad's own UI, to
     * hand one server slug a credential for their Google account.
     *
     * `slug` and `variable` come from the CONFIG — the flow reads the slug out
     * of sealed state and the variable out of that server's `oauth:` block, and
     * neither is ever taken from a request, so a caller cannot write a string of
     * its choosing into the ingestor. `reason` is a ConnectorErrorCode: a closed
     * set of strad's own words (`account_mismatch`, `scope_not_granted`, …).
     *
     * What is NOT here is the whole point. No token, no code, no client secret,
     * no email, no length, no fingerprint — and no upstream text: Google's error
     * bodies are read for nothing, so a refusal ships the classification and
     * stops. `strad.connector_refused` on a rising edge is the operational
     * signal (a token that will not rotate is a server about to go dark), and the
     * reason is enough to tell "wrong account" from "the store is down".
     */
    "strad.connector_begin": ["slug"],
    "strad.connector_connected": ["slug", "variable"],
    "strad.connector_refused": ["slug", "reason"],
    /** Clean SIGTERM or an OOM kill — the difference is one line, or its absence. */
    "strad.shutdown": ["signal"],
    /**
     * THE EVENT NAME AND NOTHING ELSE. All three already reduce their error to a
     * class name or a summary before logging, and all three are still text this
     * repo did not fully author — a rendered secret can end up inside a store
     * client's exception. "This surface is failing" is the operational fact and
     * it needs no field at all; the message stays on stderr for whoever is
     * holding a shell.
     */
    "strad.readiness_failed": [],
    "strad.store_diagnostics_failed": [],
    "strad.console_render_failed": [],
    /**
     * A route whose handler rejected with nothing underneath it catching —
     * emitted by the one guard every async route wears
     * (`src/http/async-route.ts`). Without that guard the same condition is a
     * container exit, so this line is the difference between "a request failed"
     * and "the component restarted", which is the operational question it
     * answers.
     *
     * `route` is a word written down at the mount site — `mcp`, `readiness`,
     * `params_write` — never a path or a slug from the wire. `error.kind` comes
     * from the same closed vocabulary CLASSIFY_ERROR uses, computed by the
     * renderer rather than substituted here, because this renderer keeps the
     * message out of `error` in the first place: an exception raised under /mcp
     * can quote a request body or an upstream's response, and neither is text
     * this repo authored. What lands in `error` is the class, and it stays on
     * stderr.
     *
     * These failures are no longer fatal, so they no longer reach the exception
     * reporter, which used to see them as unhandled rejections and carry a
     * stack. This record and the `internal_error` request outcome are what
     * replace it.
     */
    "strad.route_failed": ["route", "error.kind"],
  });

/**
 * evt -> why it does not leave the process.
 *
 * The counterpart to `EXPORTABLE`, and it exists because the two things an
 * empty slot can mean — "we decided this must not ship" and "nobody looked" —
 * look identical from here, and one of them is how a boundary erodes. Every
 * `evt:` literal under `src/` is in exactly one of the two tables, and
 * `test/telemetry.event-export-decisions.test.ts` reads the call sites as TEXT
 * to check it, so the lists are compared rather than maintained in parallel.
 *
 * An entry here is a REDACTION VERDICT. Moving one up to
 * `EXPORTABLE` takes the same per-field "where does this value come from at
 * every call site" answer that table demands, one event at a time — the rule
 * being that a hostile client and a broken upstream can BOTH only ever make the
 * value one of a set this repo wrote down.
 *
 * Five of these never reach `event()` at all: `startTelemetry` and
 * `startErrorReporter` write through their own injectable `log` seam, because
 * they run around the lifecycle of the very exporter an export would need. It
 * is worth saying where those lines are, since an operator hunting a silent
 * deployment goes looking for them: stdout, and nowhere else.
 *
 * Both tables are held against event NAMES. Neither says an entry is
 * EFFECTIVE — an `EXPORTABLE` entry for a call site that does not go through
 * `event()` would ship nothing at all, and the five above are what that looks
 * like.
 */
export const NOT_EXPORTED: Readonly<Record<string, string>> = Object.freeze({
  "mcp.auth_failed":
    "Its attributes are safe — `reason` is a closed set — but it is emitted " +
    "BEFORE authentication succeeds, so anyone who can reach /mcp produces one " +
    "exported record per request. A bot spraying bad bearer tokens would fill " +
    "the batch queue and evict mcp.list_tools_failed, which is the one signal " +
    "this file exists to deliver. strad.mcp.auth_failures already counts the " +
    "same thing, by the same `reason`, in a channel with no queue to starve.",
  "mcp.request":
    "It fires on EVERY authenticated request, which is the queue-starvation " +
    "argument that keeps mcp.auth_failed off the list, one token further in. " +
    "Its fields would survive the field test — resolveSelection has already " +
    "matched every slug in `requested` against the entitled set, so an " +
    "unconfigured string never reaches this line — but the volume is the " +
    "objection. The mcp.request span carries requested and selected as " +
    "attributes, and strad.mcp.requests counts the outcomes.",
  "mcp.tool_denied":
    "`tool` is denamespaced from the tool name the CALLER sent, so a client " +
    "could write any string it liked into the ingestor by calling a tool that " +
    "does not exist. `server` is not that — by this line the slug has already " +
    "been matched against the selection, which comes from the config — so an " +
    "exportable SHAPE, the slug and a count, is available and is not written " +
    "yet. It is work rather than a table move: the refusal throws ahead of the " +
    "strad.mcp.tool_calls block, so it reaches no counter either.",
  "ui.playground.tool_call":
    "The tool name is typed by a human into a text field in the console, so it " +
    "is not a word from a set this repo wrote down. strad.mcp.tool_calls with " +
    "strad.surface=playground counts the call in a channel with no queue to " +
    "starve.",
  "telemetry.disabled":
    "Emitted through startTelemetry's own `log` seam rather than event(), on " +
    "the path where no OTLP endpoint is configured — there is no exporter to " +
    "carry it, which is precisely what it says.",
  "telemetry.started":
    "Same seam, and the same reason from the other side: it announces the " +
    "exporter that would have to carry it, which the arrival of any other " +
    "record already proves. It is a boot-time fact for whoever is reading the " +
    "container console.",
  "telemetry.start_failed":
    "The exporter did not come up, so the only channel that could carry this " +
    "is the one that is missing. Impossible by construction, and worth writing " +
    "down: when telemetry goes quiet, this line is on stdout and nowhere else.",
  "errors.started":
    "Emitted through startErrorReporter's `log` seam, which runs BEFORE " +
    "startTelemetry — the log exporter does not exist yet, so an event() would " +
    "reach the same stream by a longer route.",
  "errors.start_failed":
    "The same blind spot as telemetry.start_failed, one layer over: exception " +
    "reporting failed to start, and the record saying so can only go to stdout.",
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
 * failing slug per listing, so a client polling a 27-slug gateway can produce 27
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
  "mcp.local_machine_offline",
  // A slug waiting on a deferred credential fires this on every tools/list and
  // resources/list a client sends, for as long as the value is pending — which
  // is exactly the unbounded, client-driven shape this set exists for. Left out,
  // it would evict genuine faults from the shared batch queue.
  "mcp.server_unconfigured",
  "mcp.policy_unmatched_tools",
  "mcp.unavailable",
  // A handler that rejects is a bug rather than a routine refusal, so this one
  // is expected to be silent — but the surface it guards is /mcp, whose input a
  // caller controls, and "a bug a client can drive on demand" is exactly the
  // shape this set exists for. It keys on `route` rather than `slug` (see the
  // key below), so a flood on one route does not hide the first record from
  // another. stdout is not throttled.
  "strad.route_failed",
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
    // `route` beside `slug` because the newest member of this set carries no
    // slug: without it, one failing route's 60s bucket would swallow every
    // other route's first record.
    const key = `${evt}:${String(payload.slug ?? payload.route ?? "")}`;
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
