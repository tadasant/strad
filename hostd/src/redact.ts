import type { Config } from "./config.js";
import { screenText } from "./consent/display.js";
import { depositToken } from "./custody/deposit-wire.js";

/**
 * Everything this daemon WRITES DOWN — the audit log on disk, its in-memory
 * tail, the status page and `/state.json`, the banner's call text, a
 * notification Notification Center keeps — goes through here. Two passes, in
 * this order:
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
 * typed or set value in its summary at all (`src/computer/`), and a summary
 * made only of ids (`ID_ONLY_TOOLS`) skips the shape pass, which would
 * otherwise eat a long variable name or a destination called `…auth`. This
 * is the net under that, for the free text a summary has to carry — a shell
 * command, a script, a URL, a purpose — which is caller-authored and may
 * hold anything.
 */
export const MAX_RECORD_CHARS = 400;

/**
 * Bumped when what counts as redacted changes. Every audit entry is stamped
 * with the version it was redacted to, and `src/at-rest.ts` rewrites only
 * entries stamped lower (or not at all), so a re-run never cuts a new record.
 */
export const REDACTION_VERSION = 1;

/**
 * Tool calls whose summary carries only ids, coordinates, key names, handles,
 * slugs, variable names and destinations — nothing a caller could put a
 * secret in that the exact pass would not already catch.
 */
export const ID_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "activate_tab",
  "close_tab",
  "release_tab",
  "discard_handle",
  "deposit",
  "kill_command",
  "take_screenshot",
  "click",
  "move_mouse",
  "drag",
  "scroll",
  "imessage_get_attachment",
]);

/** The tool a summary is for: `run_command: …`, `imessage_list_chats search=…`. */
export function summaryTool(detail: string): string | undefined {
  return /^([a-z_]+)(?::|\s|$)/.exec(detail)?.[1];
}

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

/** A label the exact pass wrote: `[secret h_…]`, `[redacted shell key]`. */
const LABEL = /\[(?:secret h_[A-Za-z0-9_-]+|redacted [^\]\n]{1,80})\]/g;

/**
 * Known values first, then shapes, then the cap. The labels the first pass
 * wrote are set aside while the shape rules run, so no rule cuts one in two
 * (`Bearer [redacted] shell key]`). A rule may still swallow a label whole,
 * which leaves `[redacted]`: the value is gone either way.
 */
export function recordText(
  raw: string,
  known: Redactor = (s) => s,
  max = MAX_RECORD_CHARS,
  opts: { shapes?: boolean } = {},
): string {
  const exact = known(raw);
  if (opts.shapes === false) {
    const chars = [...exact.replace(/\s+/g, " ").trim()];
    return chars.length > max
      ? `${chars.slice(0, max - 1).join("")}…`
      : chars.join("");
  }
  const labels: string[] = [];
  const held = exact.replace(LABEL, (m) => {
    labels.push(m);
    return `\uE000${labels.length - 1}\uE001`;
  });
  return (
    screenText(held, max)
      .replace(
        /\uE000(\d+)\uE001/g,
        (_, i: string) => labels[Number(i)] ?? "[redacted]",
      )
      // A placeholder the cap cut in half.
      .replace(/\uE000\d*|\uE001/g, "")
  );
}
