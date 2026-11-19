import { isIPv4, isIPv6 } from "node:net";
import type { Principal } from "../auth/index.ts";

/**
 * WHO a metric data point is about, as a bounded label value.
 *
 * The attribute is `strad.principal`, on `strad.mcp.requests`,
 * `strad.mcp.tool_calls`, `strad.mcp.unavailable`, `strad.mcp.tool_denials` and
 * `strad.mcp.source_networks`. It exists because a stolen static token used at a
 * normal rate is otherwise indistinguishable from the agent it was stolen from:
 * without it, a counter says server, tool and outcome, and nothing about whose
 * request it was.
 *
 * Two rules decide every value below, and both are about what may become a
 * metric attribute (see src/telemetry/redact.ts):
 *
 * 1. NEVER THE CREDENTIAL, NOR ANYTHING THAT VERIFIES ONE. A static token's
 *    `pubid` is its non-secret lookup key — the console lists it, the logs
 *    already carry it — and nothing about the secret half can be recovered or
 *    checked from it. No hash of anything is ever a value here.
 *
 * 2. BOUNDED BY WHAT IS CONFIGURED, NOT BY WHAT IS SENT. Every value is either a
 *    fixed word or an identifier that has already been VERIFIED: a `pubid` that
 *    matched a record in the token roster, or a `reach:` slug from checked-in
 *    config. A caller who presents a token strad does not accept is
 *    `unauthenticated`, one value, however many distinct strings it sends — so
 *    an attacker cannot mint series. A console login token (`jti`) is minted
 *    per sign-in and has no ceiling, so the kind is the value and the id is
 *    dropped.
 *
 * 3. NO PERSON'S ACCOUNT IDENTIFIER. A human's identity — an OAuth access token
 *    or a console session — is a Google `sub`, which is the person's, not a
 *    value this repo wrote down. src/telemetry/events.ts keeps it off every
 *    exported record for that reason, and a metric attribute is the same
 *    boundary, so those principals are their KIND (`oauth`, `google`). The
 *    stolen-credential question this label answers is about the static tokens
 *    an agent holds, and each of those is named.
 */
export const UNAUTHENTICATED = "unauthenticated";

/** A bundle's `/mcp`: the only caller it accepts is core, with its own token. */
export const INTERNAL = "internal";

export function principalAttr(p: Pick<Principal, "kind" | "id">): string {
  switch (p.kind) {
    case "system-token":
      return `token:${p.id}`;
    case "mcp-oauth":
      return "oauth";
    case "google":
      return "google";
    case "console-token":
      return "console-token";
    case "console-bypass":
      return "console-bypass";
  }
}

/** A flow-through caller (src/http/reach.ts): the source slug, from config. */
export function reachPrincipalAttr(sourceSlug: string): string {
  return `reach:${sourceSlug}`;
}

/**
 * The network a client address belongs to: its IPv4 /24 or its IPv6 /48.
 *
 * In-memory only. The result is a map key in `SourceNetworks` and is never a
 * metric attribute, a log field or a span attribute — the gauge exports the
 * COUNT of these and nothing else. Null for anything that is not an address.
 */
export function networkOf(address: string | undefined): string | null {
  if (!address) return null;
  let ip = address.trim();
  // An IPv4 client on a dual-stack socket arrives as `::ffff:a.b.c.d`.
  if (ip.toLowerCase().startsWith("::ffff:") && isIPv4(ip.slice(7))) {
    ip = ip.slice(7);
  }
  if (isIPv4(ip)) {
    return `${ip.split(".").slice(0, 3).join(".")}.0/24`;
  }
  if (isIPv6(ip)) {
    const groups = expandIPv6(ip.split("%")[0]!);
    return groups ? `${groups.slice(0, 3).join(":")}::/48` : null;
  }
  return null;
}

/** The eight hextets of an IPv6 address, lowercase and unpadded. */
function expandIPv6(ip: string): string[] | null {
  const [head, tail, extra] = ip.toLowerCase().split("::");
  if (extra !== undefined) return null;
  const parse = (s: string | undefined): string[] =>
    s ? s.split(":").filter((g) => g.length > 0) : [];
  let left = parse(head);
  let right = parse(tail);
  // An embedded IPv4 tail (`::ffff:1.2.3.4`, `64:ff9b::1.2.3.4`) is two hextets.
  const toHex = (parts: string[]): string[] => {
    const last = parts[parts.length - 1];
    if (!last || !isIPv4(last)) return parts;
    const o = last.split(".").map(Number);
    return [
      ...parts.slice(0, -1),
      ((o[0]! << 8) | o[1]!).toString(16),
      ((o[2]! << 8) | o[3]!).toString(16),
    ];
  };
  if (tail === undefined) left = toHex(left);
  else right = toHex(right);
  const missing = 8 - left.length - right.length;
  if (tail === undefined ? missing !== 0 : missing < 0) return null;
  const groups = [...left, ...Array<string>(missing).fill("0"), ...right];
  return groups.map((g) => parseInt(g, 16).toString(16));
}

/** How far back `strad.mcp.source_networks` looks. */
export const SOURCE_NETWORK_WINDOW_MS = 60 * 60 * 1000;

/**
 * The most networks remembered per principal. The gauge saturates here: past
 * it, "this key is being used from everywhere" is already the whole answer, and
 * the cap is what keeps the tracker's memory bounded by the number of
 * principals rather than by the number of addresses an attacker controls.
 */
export const SOURCE_NETWORK_CAP = 64;

/**
 * Distinct source networks per principal, over a trailing window.
 *
 * Per process. Each core instance sees only the requests routed to it, so with
 * more than one instance the per-instance gauges are lower bounds on the truth
 * and are not additive — the same /24 can appear on two instances.
 */
export class SourceNetworks {
  /** principal → (network → last seen, ms). Insertion order is recency. */
  private readonly seen = new Map<string, Map<string, number>>();

  constructor(
    private readonly windowMs = SOURCE_NETWORK_WINDOW_MS,
    private readonly cap = SOURCE_NETWORK_CAP,
  ) {}

  record(principal: string, address: string | undefined, now = Date.now()) {
    const network = networkOf(address);
    if (network === null) return;
    let nets = this.seen.get(principal);
    if (!nets) {
      nets = new Map();
      this.seen.set(principal, nets);
    }
    // Delete-then-set moves it to the end, so the first key is the stalest.
    nets.delete(network);
    nets.set(network, now);
    if (nets.size > this.cap) {
      nets.delete(nets.keys().next().value!);
    }
  }

  /**
   * The count per principal, pruning anything older than the window.
   *
   * A principal whose networks have all aged out stays, at zero, rather than
   * vanishing: a gauge that stops being reported is harder to alert on than one
   * that reads 0, and the set of principals is bounded anyway.
   */
  counts(now = Date.now()): Map<string, number> {
    const out = new Map<string, number>();
    for (const [principal, nets] of this.seen) {
      for (const [network, at] of nets) {
        if (now - at <= this.windowMs) break;
        nets.delete(network);
      }
      out.set(principal, nets.size);
    }
    return out;
  }
}

let tracker = new SourceNetworks();

/** The process's tracker: the router records into it, the gauge reads it. */
export function sourceNetworks(): SourceNetworks {
  return tracker;
}

/** Test seam. */
export function resetSourceNetworks(): void {
  tracker = new SourceNetworks();
}
