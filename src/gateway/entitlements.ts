import type { Principal } from "../auth/index.ts";
import type { StradConfig } from "../config/schema.ts";
import { serverConsolePath } from "../ui/paths.ts";

/**
 * The rule strad is built around:
 *
 *   THE QUERY STRING PROPOSES. THE TOKEN DISPOSES.
 *
 * `?servers=a,b` is a *filter*, never an authorization boundary. A token minted
 * for /mcp is valid at /mcp?servers=anything — RFC 8707 resource indicators bind
 * a token to a resource, and the query string is not a resource. So the query
 * string can only ever NARROW the entitled set. It can never widen it.
 *
 * Entitlement is computed here, server-side, from the principal's roles and the
 * config. Nothing the caller sends contributes to it.
 */

export function entitledServers(
  principal: Principal,
  cfg: StradConfig,
): Set<string> {
  const allSlugs = cfg.servers.filter((s) => s.enabled).map((s) => s.slug);

  const granted = new Set<string>();

  for (const roleName of principal.roles) {
    // Object.hasOwn, not `cfg.roles[roleName]`: a token record carrying the
    // role "__proto__" would otherwise resolve to Object.prototype (truthy),
    // and `role.servers` would be undefined and throw. hasOwn also means an
    // inherited property can never be mistaken for a configured role.
    if (!Object.hasOwn(cfg.roles, roleName)) continue;
    const role = cfg.roles[roleName];
    if (!role) continue; // unknown role grants nothing

    for (const entry of role.servers) {
      if (entry === "*") {
        for (const slug of allSlugs) granted.add(slug);
      } else if (allSlugs.includes(entry)) {
        granted.add(entry);
      }
    }
  }

  // A role may name a server, but the server also declares which roles may use
  // it. Both must agree. Intersecting the two directions means neither side can
  // grant access on its own.
  const out = new Set<string>();
  for (const slug of granted) {
    const server = cfg.servers.find((s) => s.slug === slug);
    if (!server) continue;
    if (server.entitlements.some((r) => principal.roles.includes(r))) {
      out.add(slug);
    }
  }

  return out;
}

export interface Selection {
  ok: true;
  /** The servers to mount for this request. */
  selected: string[];
}

export interface SelectionFailure {
  ok: false;
  /** Servers the caller asked for but is not entitled to / that don't exist. */
  unavailable: UnavailableServer[];
}

export interface UnavailableServer {
  slug: string;
  status: "not_configured" | "not_entitled" | "disabled";
  /** Where a human would go to fix it, when that is a meaningful thing to do. */
  authorize_url?: string;
}

/**
 * Resolve `?servers=` against the entitled set.
 *
 * Absent/empty `?servers=` means "everything I'm entitled to".
 *
 * A requested server that is not available is a hard failure — we do NOT
 * silently drop it. A client that asked for `slack` and got a toolset without
 * Slack in it would look like a broken Slack integration; a 424 with a list of
 * what's missing is something a client can act on.
 */
export function resolveSelection(
  requested: string[],
  entitled: Set<string>,
  cfg: StradConfig,
  publicUrl?: string,
): Selection | SelectionFailure {
  if (requested.length === 0) {
    return { ok: true, selected: [...entitled].sort() };
  }

  const unavailable: UnavailableServer[] = [];
  const selected: string[] = [];

  for (const slug of requested) {
    if (entitled.has(slug)) {
      selected.push(slug);
      continue;
    }

    const configured = cfg.servers.find((s) => s.slug === slug);
    unavailable.push({
      slug,
      status: !configured
        ? "not_configured"
        : !configured.enabled
          ? "disabled"
          : "not_entitled",
      ...(publicUrl
        ? {
            // Path and encoding both come from src/ui/paths.ts — the module
            // the console registers this route from — so the link a client is
            // sent to cannot drift away from the page that serves it.
            authorize_url: `${publicUrl.replace(/\/$/, "")}${serverConsolePath(slug)}`,
          }
        : {}),
    });
  }

  if (unavailable.length > 0) return { ok: false, unavailable };
  return { ok: true, selected };
}

/** Parse `?servers=a,b,c` — tolerant of repeats, whitespace and empty items. */
export function parseServersParam(value: unknown): string[] {
  const raw = Array.isArray(value) ? value.join(",") : String(value ?? "");
  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    const slug = part.trim();
    if (slug) seen.add(slug);
  }
  return [...seen];
}
