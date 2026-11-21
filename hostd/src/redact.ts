import type { Config } from "./config.js";
import { screenText } from "./consent/display.js";
import { depositToken } from "./custody/deposit-wire.js";

/**
 * Everything this daemon WRITES DOWN — the audit log on disk, its in-memory
 * tail, the status page, a notification Notification Center keeps — goes
 * through here. Two passes, in this order:
 *
 * 1. KNOWN values, matched exactly: every secret the custody vault holds or
 *    has just deposited (labelled with its handle, so the record still says
 *    WHICH secret), and the daemon's own keys — each server's and client's
 *    bearer, each custody destination's key and the deposit bearer derived
 *    from it. Nothing is guessed: if the bytes are a value we know, they go.
 * 2. SHAPES, by heuristic (`screenText`): bearer headers, `password=` pairs,
 *    well-known token prefixes, JWTs, PEM keys, long opaque runs, and what
 *    was typed into the foreground reduced to its length.
 *
 * The structural half is at the source: a tool's `summarize` never puts a
 * typed or set value in its summary at all (`src/computer/`). This is the net
 * under that, for the free text a summary has to carry — a shell command, a
 * script, a URL, a purpose — which is caller-authored and may hold anything.
 */
export const MAX_RECORD_CHARS = 400;

/** Exact replacement of known values, longest first so a prefix cannot split one. */
export function replaceKnown(
  text: string,
  known: { label: string; needles: string[] }[],
): string {
  const pairs = known
    .flatMap((k) => k.needles.map((n) => ({ n, label: k.label })))
    .filter((p) => p.n.length > 0)
    .sort((a, b) => b.n.length - a.n.length);
  let out = text;
  for (const { n, label } of pairs) {
    if (out.includes(n)) out = out.split(n).join(`[${label}]`);
  }
  return out;
}

/** The daemon's own secrets, read live: `key add` and `/reload-keys` move them. */
export function configSecrets(
  config: Config,
): { label: string; needles: string[] }[] {
  const out: { label: string; needles: string[] }[] = [];
  for (const [id, cap] of Object.entries(config.capabilities)) {
    if (cap.key) {
      out.push({ label: `redacted ${id} key`, needles: [cap.key] });
      if (id === "custody")
        out.push({
          label: "redacted deposit bearer",
          needles: [depositToken(cap.key)],
        });
    }
    for (const [client, key] of Object.entries(cap.clientKeys ?? {}))
      out.push({ label: `redacted ${id}/${client} key`, needles: [key] });
  }
  for (const [name, d] of Object.entries(config.custody.destinations)) {
    out.push({
      label: `redacted ${name} destination key`,
      needles: [d.key, depositToken(d.key)],
    });
  }
  return out;
}

export type Redactor = (text: string) => string;

/** Known values first, then shapes, then the cap. */
export function recordText(
  raw: string,
  known: Redactor = (s) => s,
  max = MAX_RECORD_CHARS,
): string {
  return screenText(known(raw), max);
}
