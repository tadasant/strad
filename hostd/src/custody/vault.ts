import { randomBytes } from "node:crypto";

/**
 * The custody vault: secrets this daemon captured and the model must never
 * see, held behind opaque handles, plus the browser tabs a secret is showing
 * in.
 *
 * IN MEMORY ONLY, like the grants (src/consent/grants.ts): a restart drops
 * every handle, which fails closed — the credential is re-minted, never
 * recovered from disk. A handle belongs to the custody grant that captured it
 * and dies with it, or at its TTL, or when it is deposited, discarded or
 * burned. The bytes are kept in a Buffer and zeroed when the handle ends.
 * JavaScript strings cannot be zeroed, so the match forms below
 * (`needles`) are released to the garbage collector rather than wiped — a
 * limit recorded in the docs, and the reason the vault holds nothing on disk.
 *
 * Three things make it LIVE, and while it is live the other servers on this
 * machine refuse whatever could read the secret back (src/custody/enforce.ts):
 * a held handle, a TAINTED tab — one a capture ran in, so the secret may still
 * be on the page — and a capture still in flight.
 */

export type HandleKind = "json" | "pem" | "token" | "text";

/** What a caller may know about a held value. Never a fragment of it. */
export interface HandleShape {
  length: number;
  kind: HandleKind;
  /** A well-known, non-secret prefix the value starts with, e.g. `ghp_`. */
  prefix?: string;
  /** Top-level key names, for a JSON object. Never values. */
  json_keys?: string[];
  /** Line count, for a multi-line value. */
  lines?: number;
}

export type HandleEnd =
  "deposited" | "discarded" | "burned" | "expired" | "grant_ended" | "cleared";

export interface HandleView {
  handle: string;
  state: "held" | HandleEnd;
  label?: string;
  source: string;
  shape: HandleShape;
  created_at: string;
  expires_at?: string;
  ended_at?: string;
  /** Where it went, for a deposited handle. */
  path?: string;
  version?: string;
  /** Why it ended, for a burned one. */
  reason?: string;
}

interface Held {
  id: string;
  grantId: string;
  label?: string;
  source: string;
  value: Buffer;
  needles: string[];
  shape: HandleShape;
  createdAt: number;
  expiresAt: number;
}

interface Ended {
  view: HandleView;
  grantId: string;
}

/** The value is too short to be a credential, and too short to filter for. */
export const MIN_SECRET_LENGTH = 8;
/** A needle shorter than this matches ordinary text too often to be useful. */
const MIN_NEEDLE_LENGTH = 8;
const MAX_ENDED = 50;

/**
 * Non-secret prefixes a credential announces itself with. Reported so a
 * caller can check it captured the right thing ("expected a GitHub token,
 * got a `ghp_`") without seeing any of it. Longest first, so `sk-ant-` wins
 * over `sk-`.
 */
const KNOWN_PREFIXES = [
  "github_pat_",
  "sk-ant-",
  "sk-proj-",
  "sk_live_",
  "sk_test_",
  "rk_live_",
  "rk_test_",
  "lin_api_",
  "dop_v1_",
  "glpat-",
  "xoxb-",
  "xoxp-",
  "xapp-",
  "ghp_",
  "gho_",
  "ghu_",
  "ghs_",
  "ghr_",
  "ntn_",
  "AKIA",
  "AIza",
  "ya29.",
  "SG.",
  "sk-",
];

/** Keys in a JSON credential whose string values are secret on their own. */
const SECRET_KEY = /key|secret|token|password|passwd|credential/i;

export function shapeOf(value: string): HandleShape {
  const lines = value.split("\n").length;
  const base = {
    length: value.length,
    ...(lines > 1 ? { lines } : {}),
  };
  const trimmed = value.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
        return { ...base, kind: "json", json_keys: Object.keys(parsed) };
    } catch {
      // not JSON after all; fall through
    }
  }
  if (trimmed.startsWith("-----BEGIN ")) return { ...base, kind: "pem" };
  if (!/\s/.test(trimmed)) {
    const prefix = KNOWN_PREFIXES.find((p) => trimmed.startsWith(p));
    return { ...base, kind: "token", ...(prefix ? { prefix } : {}) };
  }
  return { ...base, kind: "text" };
}

/**
 * Every form of `value` the egress filter looks for in a result.
 *
 * Exact matches on a KNOWN value, which is why this is stronger than masking:
 * nothing is guessed. The value itself; the forms a tool result could carry it
 * in (JSON-escaped, base64, base64url, URL-encoded); and for a JSON or PEM
 * credential, the secret parts on their own — the `private_key` of a service
 * account, and each long line of a PEM body — because a model shown a
 * fragment has still been shown the secret.
 */
export function needlesFor(value: string): string[] {
  const out = new Set<string>();
  const add = (s: string) => {
    if (s.length >= MIN_NEEDLE_LENGTH) out.add(s);
  };
  const forms = (s: string) => {
    add(s);
    add(JSON.stringify(s).slice(1, -1));
    add(Buffer.from(s, "utf8").toString("base64"));
    add(Buffer.from(s, "utf8").toString("base64url"));
    add(encodeURIComponent(s));
  };
  const linesOf = (s: string) => {
    for (const line of s.split("\n")) {
      const t = line.trim();
      if (t.length >= 24) forms(t);
    }
  };
  forms(value);
  forms(value.trim());
  const trimmed = value.trim();
  if (trimmed.startsWith("{")) {
    try {
      const walk = (v: unknown, key?: string): void => {
        if (typeof v === "string") {
          if (key && SECRET_KEY.test(key) && v.length >= 12) {
            forms(v);
            linesOf(v);
          }
        } else if (Array.isArray(v)) {
          for (const x of v) walk(x, key);
        } else if (v && typeof v === "object") {
          for (const [k, x] of Object.entries(v)) walk(x, k);
        }
      };
      walk(JSON.parse(trimmed));
    } catch {
      // not JSON; the whole-value forms above stand
    }
  }
  if (value.includes("-----BEGIN ")) linesOf(value);
  // A value captured with text around it ("Your token: abc…") is still a
  // secret in its credential-shaped part alone.
  for (const tok of value.split(/\s+/))
    if (tok.length >= 16 && /[0-9]/.test(tok) && /[A-Za-z]/.test(tok))
      forms(tok);
  return [...out];
}

export interface VaultOptions {
  handleTtlMs: number;
  now?: () => number;
  /** Anything that mirrors the vault's state (the status page). */
  onChange?: () => void;
}

export class Vault {
  private readonly held = new Map<string, Held>();
  private readonly ended: Ended[] = [];
  /**
   * The match forms of values that LEFT custody — deposited or discarded —
   * kept until their grant ends. The value is still live at its provider and
   * may still be on the clipboard, in a command's buffered output or in a
   * window; ending the handle must not end the filter.
   */
  private readonly watched = new Map<
    string,
    { grantId: string; needles: string[] }
  >();
  /** tab id → the custody grant that tainted it. */
  private readonly tainted = new Map<string, string>();
  private capturing = 0;

  constructor(private readonly opts: VaultOptions) {}

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  /** Take custody of `value`. The caller learns the handle and the shape. */
  hold(
    grantId: string,
    value: string,
    meta: { label?: string; source: string },
  ): { handle: string; shape: HandleShape; expiresAt: number } {
    if (value.length < MIN_SECRET_LENGTH)
      throw new Error(
        `the captured value is ${value.length} characters — too short to be a credential. Nothing was kept.`,
      );
    const now = this.now();
    const h: Held = {
      id: `h_${randomBytes(12).toString("base64url")}`,
      grantId,
      label: meta.label,
      source: meta.source,
      value: Buffer.from(value, "utf8"),
      needles: needlesFor(value),
      shape: shapeOf(value),
      createdAt: now,
      expiresAt: now + this.opts.handleTtlMs,
    };
    this.held.set(h.id, h);
    this.opts.onChange?.();
    return { handle: h.id, shape: h.shape, expiresAt: h.expiresAt };
  }

  /**
   * The value behind a handle, for the ONE caller that sends it anywhere —
   * `deposit`. Only to the grant that captured it.
   */
  reveal(handle: string, grantId: string): string | undefined {
    this.sweep();
    const h = this.held.get(handle);
    if (!h || h.grantId !== grantId) return undefined;
    return h.value.toString("utf8");
  }

  /** End a handle: zero its bytes and keep a tombstone with no value in it. */
  end(
    handle: string,
    state: HandleEnd,
    extra: { path?: string; version?: string; reason?: string } = {},
  ): boolean {
    const h = this.held.get(handle);
    if (!h) return false;
    this.held.delete(handle);
    h.value.fill(0);
    if (state === "deposited" || state === "discarded")
      this.watched.set(handle, { grantId: h.grantId, needles: h.needles });
    this.ended.unshift({
      grantId: h.grantId,
      view: {
        ...this.viewOf(h),
        state,
        ended_at: new Date(this.now()).toISOString(),
        expires_at: undefined,
        ...extra,
      },
    });
    this.ended.length = Math.min(this.ended.length, MAX_ENDED);
    this.opts.onChange?.();
    return true;
  }

  /** Every handle a grant captured ends with it. */
  endGrant(grantId: string): void {
    for (const h of [...this.held.values()])
      if (h.grantId === grantId) this.end(h.id, "grant_ended");
    for (const [id, w] of [...this.watched.entries()])
      if (w.grantId === grantId) this.watched.delete(id);
  }

  /** Owned by this grant and still held — without copying the value out. */
  owns(handle: string, grantId: string): boolean {
    this.sweep();
    return this.held.get(handle)?.grantId === grantId;
  }

  taint(tabId: string, grantId: string): void {
    this.tainted.set(tabId, grantId);
    this.opts.onChange?.();
  }

  untaint(tabId: string): void {
    if (this.tainted.delete(tabId)) this.opts.onChange?.();
  }

  isTainted(tabId: string): boolean {
    return this.tainted.has(tabId);
  }

  /** The tabs one grant tainted, for releasing them when it ends. */
  taintedBy(grantId: string): string[] {
    return [...this.tainted.entries()]
      .filter(([, g]) => g === grantId)
      .map(([tab]) => tab);
  }

  /** Mark a capture in flight; call the returned function when it is over. */
  beginCapture(): () => void {
    this.capturing += 1;
    this.opts.onChange?.();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.capturing -= 1;
      this.opts.onChange?.();
    };
  }

  sweep(): void {
    const now = this.now();
    for (const h of [...this.held.values()])
      if (now >= h.expiresAt) this.end(h.id, "expired");
  }

  /** Whether anything on this machine may be showing or holding a secret. */
  live(): boolean {
    this.sweep();
    return this.held.size > 0 || this.tainted.size > 0 || this.capturing > 0;
  }

  status(): { handles: number; tainted_tabs: number; capturing: number } {
    this.sweep();
    return {
      handles: this.held.size,
      tainted_tabs: this.tainted.size,
      capturing: this.capturing,
    };
  }

  /**
   * The handles whose value appears in any of `texts`, in any form: held
   * ones, and ones whose value left custody under a grant still running.
   */
  scan(texts: string[]): string[] {
    const hits: string[] = [];
    const hit = (needles: string[]) =>
      needles.some((n) => texts.some((t) => t.includes(n)));
    for (const h of this.held.values()) if (hit(h.needles)) hits.push(h.id);
    for (const [id, w] of this.watched) if (hit(w.needles)) hits.push(id);
    return hits;
  }

  /** Whether `handle` is held, as opposed to deposited or discarded. */
  isHeld(handle: string): boolean {
    return this.held.has(handle);
  }

  /** One grant's handles, live and recently ended. */
  list(grantId: string): HandleView[] {
    this.sweep();
    return [
      ...[...this.held.values()]
        .filter((h) => h.grantId === grantId)
        .map((h) => this.viewOf(h)),
      ...this.ended.filter((e) => e.grantId === grantId).map((e) => e.view),
    ];
  }

  /** Everything, for the kill switch: every handle ends, every taint drops. */
  clear(): void {
    for (const id of [...this.held.keys()]) this.end(id, "cleared");
    this.watched.clear();
    this.tainted.clear();
    this.opts.onChange?.();
  }

  private viewOf(h: Held): HandleView {
    return {
      handle: h.id,
      state: "held",
      ...(h.label ? { label: h.label } : {}),
      source: h.source,
      shape: h.shape,
      created_at: new Date(h.createdAt).toISOString(),
      expires_at: new Date(h.expiresAt).toISOString(),
    };
  }
}
