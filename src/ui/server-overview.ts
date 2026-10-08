import type { ServerConfig } from "../config/schema.ts";
import { CONNECTORS_PREFIX, connectorsPath } from "./paths.ts";
import { connectUrl, playgroundHref } from "./playground.ts";
import { esc, layout } from "./render.ts";
import {
  badgeFor,
  type EntryBadge,
  type ServerSecretStatus,
} from "./secret-status.ts";

/**
 * `/ui/<slug>` for a server with no dedicated view — the read-only overview.
 *
 * Every row on `/connectors` links to its server's page, so every slug has to
 * have one worth landing on. Three kinds of server get a dedicated view (a connector's
 * Connect page, a parameter store, a bucket browser); everything else gets this:
 * what the entry is, whether it is mounted, what its badge says, and the doors
 * that lead somewhere from here. A per-kind view that lands in `handleServerView`
 * takes the slug over without moving the link.
 *
 * READ-ONLY, and declared, non-credential config only: the roster's badge and
 * summary, plus the kind, bundle and path, or the upstream host. No value, no
 * credential, no parameter path, no env — `/connectors/<slug>` already shows the
 * full declaration behind the same gate, so this adds no reach to the console and
 * nothing an agent lacks through `/mcp`. The upstream URL is reduced to its host:
 * a remote server's path is where a vendor puts a key when it puts one in the URL.
 */
export interface ServerOverviewOptions {
  server: ServerConfig;
  /** Absent for a DISABLED server, which is not on the secret roster. */
  status?: ServerSecretStatus;
  /** `playgroundAccess(...).ok` for this console identity. */
  playable: boolean;
  /**
   * Whether this deployment keeps a roster in a store, i.e. whether
   * `/connectors/<slug>` is a page rather than the "editor is off" 404. The
   * roster itself answers either way; the per-entry form does not.
   */
  editable: boolean;
  /** The origin for the MCP URL; empty when neither publicUrl nor Host is known. */
  base: string;
  signedInAs?: string;
}

export function renderServerOverview(opts: ServerOverviewOptions): string {
  const { server, status } = opts;
  const slug = server.slug;
  const title = server.title ?? slug;
  const mcpUrl = server.enabled && opts.base ? connectUrl(opts.base, slug) : "";

  const scope = scopeRows(server)
    .map(
      ([label, value]) =>
        `  <div class="scope"><span class="scope-l">${esc(label)}</span><code>${esc(value)}</code></div>`,
    )
    .join("\n");

  const badge = status ? badgeFor(status.state) : undefined;
  const secrets = !server.enabled
    ? `<p class="ov-note">Disabled. strad does not mount this server, so it needs no secrets and carries no badge.</p>`
    : status && badge
      ? `<p class="ov-badge"><span class="chip ${BADGE_CHIP[badge]} chip-badge">${badge}</span>
    <span class="ov-summary">${esc(status.summary)}</span></p>
  <p class="ov-note">The <a href="${CONNECTORS_PREFIX}">connectors roster</a> has the per-secret detail behind this badge.</p>`
      : `<p class="ov-note">No secret status is recorded for this server.</p>`;

  const connectorNote =
    server.oauth && !server.enabled
      ? `<p class="ov-note">This server declares an <code>oauth:</code> connector. Its Connect page answers only while the server is enabled.</p>`
      : "";

  const links = [
    opts.playable
      ? `<li><a href="${esc(playgroundHref(slug))}">Open the playground →</a> List this server's tools and call them by hand.</li>`
      : `<li>The playground is not open to this console identity for this server: it is disabled, or not entitled to the roles you signed in with.</li>`,
    opts.editable
      ? `<li><a href="${esc(connectorsPath(slug))}">Open this entry in the connectors editor →</a> Its full declaration, and the controls to change it.</li>`
      : `<li><a href="${esc(CONNECTORS_PREFIX)}">Back to the roster →</a> This gateway keeps no runtime roster, so its entries come from the checked-in config and there is no per-entry form to open.</li>`,
  ].join("\n    ");

  const body = `
<nav class="breadcrumb" aria-label="Breadcrumb"><a href="${CONNECTORS_PREFIX}" class="crumb">connectors</a><span class="crumb-sep">/</span><span class="crumb crumb-current">${esc(slug)}</span></nav>

<section class="intro">
  <h1>${esc(title)}</h1>
  <p class="lede">${esc(
    server.description ??
      "No dedicated console view for this server kind yet. This page is a read-only overview of the entry.",
  )}</p>
</section>

<section class="browse-head ov-scope">
${scope}
</section>

<section class="panel">
  <div class="panel-head"><h2>Secrets</h2><span class="panel-note">same reading as the roster</span></div>
  ${secrets}
  ${connectorNote}
</section>

<section class="panel">
  <div class="panel-head"><h2>From here</h2><span class="panel-note">read-only page</span></div>
  <ul class="ov-links">
    ${links}
  </ul>${
    mcpUrl
      ? `
  <div class="field">
    <span class="field-l">MCP URL</span>
    <code class="pathpart">${esc(mcpUrl)}</code>
    <span class="field-h">No credential is in it. The client sends its bearer token as a header.</span>
  </div>`
      : ""
  }
</section>
${OVERVIEW_CSS}`;

  return layout({
    title: `${slug} · overview`,
    serverSlug: slug,
    signedInAs: opts.signedInAs,
    body,
    nav: "connectors",
  });
}

/** The declared facts shown at the top, per kind. */
function scopeRows(server: ServerConfig): [string, string][] {
  const rows: [string, string][] = [
    ["kind", server.kind],
    ["slug", server.slug],
    ["state", server.enabled ? "enabled" : "disabled"],
  ];
  switch (server.kind) {
    case "remote-http":
    case "local-tunnel":
      rows.push(["upstream host", hostOf(server.url)]);
      break;
    case "supplementary-image":
      rows.push(["bundle", server.bundle], ["path", server.path]);
      break;
    case "builtin":
      rows.push(["bundle", server.bundle]);
      break;
  }
  return rows;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "unparseable";
  }
}

/** The roster's badge colours, so a slug's two pages agree. */
const BADGE_CHIP: Record<EntryBadge, string> = {
  READY: "chip-ok",
  ISSUE: "chip-bad",
  INACTIVE: "chip-inactive",
  UNVERIFIED: "chip-unverified",
};

const OVERVIEW_CSS = `<style>
.chip-bad{color:#e8776b;border-color:color-mix(in srgb,#e8776b 45%,var(--g5))}
.chip-unverified{color:var(--g3);border-color:var(--g4);border-style:dashed}
.chip-inactive{color:#9db4e8;border-color:color-mix(in srgb,#9db4e8 42%,var(--g5))}
.chip-ok{color:var(--text-accent);border-color:color-mix(in srgb,var(--accent) 45%,var(--g5))}
.chip-badge{font-weight:600;letter-spacing:.08em}
/* .scope carries margin-left:auto for the ONE chip a browse header usually has.
   Four of them share the free space instead, which reads as four columns nobody
   laid out. */
.ov-scope{gap:1.7rem}
.ov-scope .scope{margin-left:0}
.ov-badge{display:flex;align-items:baseline;gap:.6rem;flex-wrap:wrap;margin:0 0 .5rem}
.ov-summary{color:var(--g2);font-size:.9rem}
.ov-links{margin:0 0 1rem;padding-left:1.1rem;display:flex;flex-direction:column;gap:.45rem;
  color:var(--g2);font-size:.9rem}
.ov-links a,.ov-note a{color:var(--text-accent);font-weight:600}
.ov-note{color:var(--g3);font-size:.86rem;margin:0 0 .4rem}
</style>`;
