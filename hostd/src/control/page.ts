import type { AuditEntry } from "../audit.js";
import type { BridgeState } from "../browser/bridge.js";
import type { GrantView } from "../consent/grants.js";

export interface ControlState {
  machine: string;
  disabled: boolean;
  tunnel: string;
  consent: { mode: string; windowSeconds: number; onTimeout: string };
  servers: { id: string; name: string }[];
  pending: { server: string; purpose: string; since: number }[];
  grants: (GrantView & { running: string[] })[];
  /** Absent when no enabled server needs the native helper. */
  helper?: { connected: boolean; error?: string };
  /** Absent when the browser server is not enabled. */
  extension?: BridgeState;
  audit: AuditEntry[];
  now: number;
}

/** Every dynamic string on this page is caller- or command-authored. Escape all of it. */
export function esc(s: unknown): string {
  return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  return m < 90 ? `${m} min` : `${Math.round(m / 60)} h`;
}

const CSS = `
:root{color-scheme:light dark;--bg:#fafaf8;--fg:#1b1b18;--mute:#6b6b63;--line:#deded6;--card:#fff;--red:#b3261e;--redbg:#fdecea;--green:#1d6b3a;--greenbg:#e6f4ea;--amber:#8a5a00;--amberbg:#fff4d6}
@media(prefers-color-scheme:dark){:root{--bg:#161614;--fg:#ecece6;--mute:#9a9a90;--line:#33332e;--card:#1f1f1c;--redbg:#3a1614;--red:#ff8a80;--greenbg:#12301d;--green:#7bd99a;--amberbg:#3a2c08;--amber:#ffcf66}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{max-width:860px;margin:0 auto;padding:28px 20px 60px}
h1{font-size:20px;margin:0 0 2px}h2{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--mute);margin:30px 0 10px}
.sub{color:var(--mute);margin:0 0 18px}
.banner{display:flex;gap:16px;align-items:center;justify-content:space-between;padding:16px 18px;border-radius:10px;border:1px solid var(--line)}
.banner.on{background:var(--greenbg);color:var(--green)}.banner.off{background:var(--redbg);color:var(--red)}
.banner strong{font-size:16px}.banner p{margin:2px 0 0;font-size:13px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin-bottom:10px}
.card.pending{background:var(--amberbg);color:var(--amber);border-color:transparent}
.row{display:flex;gap:14px;align-items:flex-start;justify-content:space-between}
.name{font-weight:600}.purpose{margin:4px 0 8px}.meta{color:var(--mute);font-size:13px}
code,.cmd{font:12.5px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}.cmd{display:block;margin-top:6px;color:var(--mute);white-space:pre-wrap;word-break:break-all}
button{font:inherit;font-weight:600;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--fg);padding:7px 14px;cursor:pointer;white-space:nowrap}
button.danger{background:var(--red);border-color:var(--red);color:#fff}
@media(prefers-color-scheme:dark){button.danger{color:#1b1b18}}
form{margin:0}.actions{display:flex;gap:8px}
.empty{color:var(--mute);padding:14px 16px;border:1px dashed var(--line);border-radius:10px}
table{width:100%;border-collapse:collapse;font-size:13px}td{padding:5px 8px 5px 0;border-top:1px solid var(--line);vertical-align:top}td.t{color:var(--mute);white-space:nowrap}td.k{white-space:nowrap;font-weight:600}
`;

export function renderPage(state: ControlState, token: string): string {
  const form = (action: string, label: string, cls = "", extra = "") =>
    `<form method="post" action="${action}"><input type="hidden" name="token" value="${esc(token)}">${extra}<button class="${cls}">${esc(label)}</button></form>`;

  const banner = state.disabled
    ? `<div class="banner off"><div><strong>Remote control is OFF</strong><p>Every request is refused${state.tunnel === "off" ? "" : " and the tunnel is down"}. Nothing can reach this machine through strad-hostd.</p></div>${form("/enable", "Turn back on")}</div>`
    : `<div class="banner on"><div><strong>Remote control is ON</strong><p>Requests show a ${state.consent.windowSeconds}-second dialog. Unanswered requests are <b>${state.consent.onTimeout === "allow" ? "allowed" : "denied"}</b>.</p></div>${form("/disable", "Disable everything", "danger")}</div>`;

  const pending = state.pending
    .map(
      (p) =>
        `<div class="card pending"><div class="name">Asking now: ${esc(p.server)}</div><div class="purpose">${esc(p.purpose)}</div><div class="meta" style="color:inherit">dialog on screen for ${ago(state.now - p.since)}</div></div>`,
    )
    .join("");

  const grants = state.grants.length
    ? state.grants
        .map(
          (g) => `<div class="card"><div class="row"><div>
<div class="name">${esc(g.server)}</div>
<div class="purpose">${esc(g.purpose)}</div>
<div class="meta">started ${ago(state.now - g.createdAt)} ago · expires in ${ago(g.expiresAt - state.now)} · ${g.calls} call${g.calls === 1 ? "" : "s"}${g.lastTool ? ` · last: <code>${esc(g.lastTool)}</code> ${ago(state.now - g.lastUsedAt)} ago` : ""}</div>
${g.running.map((c) => `<span class="cmd">▶ ${esc(c)}</span>`).join("")}
</div>${form("/kill", "Kill", "danger", `<input type="hidden" name="grant" value="${esc(g.id)}">`)}</div></div>`,
        )
        .join("")
    : `<div class="empty">Nobody has control of this machine right now.</div>`;

  const audit = state.audit.length
    ? `<table>${state.audit
        .map(
          (a) =>
            `<tr><td class="t">${esc(a.at.slice(11, 19))}</td><td class="k">${esc(a.kind)}</td><td>${esc(a.capability ?? "")}</td><td>${esc(a.detail)}</td></tr>`,
        )
        .join("")}</table>`
    : `<div class="empty">Nothing yet.</div>`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="4"><title>strad-hostd — ${esc(state.machine)}</title><style>${CSS}</style></head><body><main>
<h1>strad-hostd</h1><p class="sub">${esc(state.machine)} · serving ${state.servers.map((s) => `<code>${esc(s.name)}</code>`).join(", ") || "nothing"} · tunnel: ${esc(state.tunnel)}${
    state.helper
      ? ` · native helper: ${state.helper.connected ? "connected" : `not reachable${state.helper.error ? ` (${esc(state.helper.error)})` : ""}`}`
      : ""
  }${
    state.extension
      ? ` · Chrome extension: ${
          state.extension.connected
            ? `connected${state.extension.version ? ` (v${esc(state.extension.version)}` : ""}${state.extension.attachedTabs ? `, attached to ${state.extension.attachedTabs} tab${state.extension.attachedTabs === 1 ? "" : "s"}` : ""}${state.extension.version ? ")" : ""}`
            : "not connected"
        }`
      : ""
  }</p>
${banner}
<h2>In control now</h2>${pending}${grants}
${state.grants.length > 1 ? `<div class="actions" style="margin-top:10px">${form("/kill-all", "Kill all", "danger")}</div>` : ""}
<h2>Recent activity</h2>${audit}
</main></body></html>`;
}
