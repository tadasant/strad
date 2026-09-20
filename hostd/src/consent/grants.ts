import { randomBytes } from "node:crypto";

import type { CapabilityId } from "../capabilities.js";

export type EndReason = "ended" | "killed" | "expired" | "idle" | "disabled";

export interface GrantView {
  id: string;
  capability: CapabilityId;
  server: string;
  purpose: string;
  createdAt: number;
  expiresAt: number;
  lastUsedAt: number;
  calls: number;
  lastTool?: string;
}

export interface Grant extends GrantView {
  /**
   * Aborts when the grant ends, for ANY reason. A capability hangs whatever it
   * started — child processes, a DevTools socket — on this, which is what makes
   * the kill button kill the work and not just the permission to start more.
   */
  signal: AbortSignal;
}

interface Held extends Grant {
  controller: AbortController;
}

/**
 * The grants in force. In memory only, deliberately: a daemon restart ends every
 * grant, and a grant that survived the process that showed its dialog would be a
 * permission nobody can see.
 */
export class GrantStore {
  private readonly grants = new Map<string, Held>();

  constructor(
    private readonly opts: {
      idleMs: number;
      now?: () => number;
      onEnd?: (grant: GrantView, reason: EndReason) => void;
    },
  ) {}

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  create(input: {
    capability: CapabilityId;
    server: string;
    purpose: string;
    ttlMs: number;
  }): Grant {
    const controller = new AbortController();
    const now = this.now();
    const grant: Held = {
      id: `g_${randomBytes(16).toString("base64url")}`,
      capability: input.capability,
      server: input.server,
      purpose: input.purpose,
      createdAt: now,
      expiresAt: now + input.ttlMs,
      lastUsedAt: now,
      calls: 0,
      controller,
      signal: controller.signal,
    };
    this.grants.set(grant.id, grant);
    return grant;
  }

  /**
   * The grant a tool call may run under, or why not. A grant is for ONE
   * capability: a browser grant presented to the shell server is not a grant.
   */
  use(
    id: unknown,
    capability: CapabilityId,
    tool: string,
  ): { ok: true; grant: Grant } | { ok: false; reason: string } {
    this.sweep();
    if (typeof id !== "string" || id.length === 0) {
      return { ok: false, reason: "no grant_id was given" };
    }
    const grant = this.grants.get(id);
    if (!grant || grant.capability !== capability) {
      return {
        ok: false,
        reason:
          "that grant_id is not active — it expired, was ended, or was killed by the machine's owner",
      };
    }
    grant.lastUsedAt = this.now();
    grant.calls += 1;
    grant.lastTool = tool;
    return { ok: true, grant };
  }

  end(id: string, reason: EndReason): boolean {
    const grant = this.grants.get(id);
    if (!grant) return false;
    this.grants.delete(id);
    grant.controller.abort(new Error(`grant ${reason}`));
    this.opts.onEnd?.(view(grant), reason);
    return true;
  }

  endAll(reason: EndReason): number {
    const ids = [...this.grants.keys()];
    for (const id of ids) this.end(id, reason);
    return ids.length;
  }

  /** End what has run out. Called on every use and on a timer. */
  sweep(): void {
    const now = this.now();
    for (const g of [...this.grants.values()]) {
      if (now >= g.expiresAt) this.end(g.id, "expired");
      else if (now - g.lastUsedAt >= this.opts.idleMs) this.end(g.id, "idle");
    }
  }

  active(capability?: CapabilityId): GrantView[] {
    this.sweep();
    return [...this.grants.values()]
      .filter((g) => !capability || g.capability === capability)
      .map(view);
  }
}

function view(g: Held): GrantView {
  const { controller: _c, signal: _s, ...rest } = g;
  return rest;
}
