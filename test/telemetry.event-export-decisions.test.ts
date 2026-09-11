import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { EXPORTABLE, NOT_EXPORTED } from "../src/telemetry/events.ts";

/**
 * Every event strad emits has an export verdict, and it is written down.
 *
 * `src/telemetry/events.ts` is a deny-by-default allowlist: an event missing
 * from `EXPORTABLE` reaches no ingestor. That is the right default and it has
 * one failure mode — a slot that is empty because nobody looked reads exactly
 * like a slot that is empty on purpose. The file this test guards was written
 * after `mcp.list_tools_failed` named a week-long production outage on every
 * request and went to a stream with no ingestor; an event added later, and
 * silently unexported, is that same shape again.
 *
 * So the two tables are compared against the CALL SITES rather than maintained
 * in parallel with them — the same move `test/bundle-release-paths.test.ts`
 * makes with the Dockerfile and the release workflow. `src/**` is read as text,
 * every `evt:` literal is collected, and the set has to equal
 * `EXPORTABLE` ∪ `NOT_EXPORTED` exactly: nothing emitted without a verdict,
 * nothing carrying a verdict that is no longer emitted, nothing in both.
 *
 * ## The scan's holes, stated
 *
 * A text scan cannot see an `evt` built from a variable, so the first case
 * below makes the literal a rule: any `evt:` that is not immediately a string
 * literal fails. Three holes survive that, and they are small in different
 * ways.
 *
 *   - A payload object assembled somewhere else and handed to `event()` by
 *     reference carries no `evt:` of its own. No call site does that; every one
 *     passes an inline object literal.
 *   - The scan reads comments and strings too, so a doc comment that writes
 *     `evt: "x"` is counted as a call site. That direction is loud — it demands
 *     a verdict for an event nothing emits — rather than silent.
 *   - `src/telemetry/events.ts` itself is exempt, because `evt` is a parameter
 *     there. An `event()` call added inside the pipeline module is unseen.
 *
 * And the tables are held against event NAMES: this says nothing about whether
 * an `EXPORTABLE` entry is EFFECTIVE, which is a distinction the four
 * `telemetry.*` / `errors.*` verdicts turn on. The last case below pins the one
 * place that distinction is load-bearing today.
 */

const SRC = "src";

/** The module that IMPLEMENTS the pipeline, where `evt` is a parameter. */
const MACHINERY = join("src", "telemetry", "events.ts");

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sources(path, out);
    else if (entry.name.endsWith(".ts")) out.push(path);
  }
  return out;
}

/** Each `evt:` under `src/`, as (file, the text right after the colon). */
function evtOccurrences(): { file: string; rest: string }[] {
  const found: { file: string; rest: string }[] = [];
  for (const file of sources(SRC)) {
    if (file === MACHINERY) continue;
    const text = readFileSync(file, "utf8");
    // `evt"?\s*:` rather than `evt:`, so a quoted key — `"evt": "x.y"`, which
    // prettier would leave alone in an object that has one — is seen too.
    for (const m of text.matchAll(/\bevt"?\s*:/g)) {
      const from = m.index + m[0].length;
      found.push({ file, rest: text.slice(from, from + 80) });
    }
  }
  return found;
}

describe("every emitted event has a written-down export verdict", () => {
  it("writes every evt as a string literal, so the scan below can see it", () => {
    const computed = evtOccurrences().filter(
      (o) => !/^\s*"[^"]+"/.test(o.rest),
    );
    expect(
      computed.map((o) => `${o.file}: evt:${o.rest.split("\n")[0]}`),
      "an `evt` built from a variable is invisible to a text scan, which would " +
        "make the allowlist check below quietly incomplete — write the literal",
    ).toEqual([]);
  });

  it("emits nothing that is in neither table, and nothing that is in both", () => {
    // A non-literal is the case above's job. Skipped rather than asserted on
    // here, so that failure reports the rule it broke instead of throwing on a
    // null match before this case's own assertions run.
    const emitted = new Set(
      evtOccurrences().flatMap((o) => {
        const m = /^\s*"([^"]+)"/.exec(o.rest);
        return m ? [m[1]!] : [];
      }),
    );

    const exportable = Object.keys(EXPORTABLE);
    const notExported = Object.keys(NOT_EXPORTED);

    // Guard the guard: a regex that silently matched nothing would make every
    // assertion below pass by comparing empty sets. Two events by name, one
    // from each table, rather than a count somebody has to maintain.
    expect(emitted.has("mcp.list_tools_failed")).toBe(true);
    expect(emitted.has("mcp.auth_failed")).toBe(true);

    const both = exportable.filter((evt) => evt in NOT_EXPORTED).sort();
    expect(
      both,
      "an event cannot both ship and not ship — one of the two entries is stale",
    ).toEqual([]);

    const undecided = [...emitted]
      .filter((evt) => !(evt in EXPORTABLE) && !(evt in NOT_EXPORTED))
      .sort();
    expect(
      undecided,
      "emitted from src/ and in neither EXPORTABLE nor NOT_EXPORTED — decide, " +
        "in src/telemetry/events.ts: allowlist the fields whose values this " +
        "repo authored at every call site, or say in one sentence why it stays " +
        "on stdout",
    ).toEqual([]);

    const unemitted = [...exportable, ...notExported]
      .filter((evt) => !emitted.has(evt))
      .sort();
    expect(
      unemitted,
      "carries a verdict in src/telemetry/events.ts and is emitted nowhere " +
        "under src/ — the call site went away and the entry outlived it",
    ).toEqual([]);

    // The same statement as a count. Redundant with the three assertions above
    // by construction, and it is what a reader checks by hand.
    expect(emitted.size).toBe(exportable.length + notExported.length);
  });

  it("gives every NOT_EXPORTED entry a reason, not a placeholder", () => {
    // The value is the whole point of the table. A one-word entry is the empty
    // slot again, wearing a reason's clothes.
    for (const [evt, why] of Object.entries(NOT_EXPORTED)) {
      expect(why.length, `${evt} needs a reason`).toBeGreaterThan(60);
    }
  });

  it("keeps the events an operator hunts a silent deployment with exportable", () => {
    // Named rather than left to the set comparison: these are the records the
    // allowlist exists to deliver, and a verdict moving one of them into
    // NOT_EXPORTED would satisfy every assertion above.
    for (const evt of [
      "mcp.list_tools_failed",
      "strad.tool_surface_degraded",
      "strad.listening",
    ]) {
      expect(EXPORTABLE[evt], `${evt} must still be exported`).toBeDefined();
    }
  });

  it("keeps the refusal record down to the one field that is ours", () => {
    // `mcp.tool_denied`'s payload carries two strings this repo did not author,
    // and both are one word away from shipping. `tool` is everything after the
    // `__` in the name a caller sent, and a refusal happens precisely because
    // no such tool is there to constrain it. `principal` is a token `pubid`
    // through router.ts — but `buildGatewayServer` is shared, and through
    // ui/playground.ts the same field is a signed-in human's Google `sub`.
    //
    // Stated by name rather than left to the deny-by-default rule, because
    // deny-by-default only protects a field nobody names. These two are already
    // in the payload, so widening is a one-word edit that errors nowhere.
    expect(EXPORTABLE["mcp.tool_denied"]).toEqual(["slug"]);
  });

  it("keeps telemetry.started's allowlist entry EFFECTIVE", () => {
    // The distinction this file's header ends on: a table held against event
    // NAMES cannot see whether an entry ships a byte. `telemetry.started` is
    // emitted through startTelemetry's injectable `log` seam, so its entry
    // means something only while that seam DEFAULTS to `event()` — restore the
    // bare console.log and the verdict silently becomes the opposite one.
    //
    // A text scan, and it buys less than the scan above: it cannot see `event`
    // rebound to something else, and it is why the behaviour is pinned
    // separately in test/telemetry.redaction.test.ts. What it does catch is the
    // edit somebody actually makes — reverting the default while the allowlist
    // entry stays, which no other test in the suite would notice.
    //
    // The other two lines out of that seam are on NOT_EXPORTED and stay correct
    // either way: they fire when no exporter is running.
    const src = readFileSync(join("src", "telemetry", "index.ts"), "utf8");
    expect(
      /opts\.log\s*\?\?\s*event\b/.test(src),
      "startTelemetry's log seam no longer defaults to event(), so its " +
        "EXPORTABLE entry for telemetry.started ships nothing",
    ).toBe(true);
  });
});
