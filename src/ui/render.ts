import type { ServerConfig, StradConfig } from "../config/schema.ts";
import type { ListResult } from "./gcs-client.ts";
import type { ServerView } from "./resolve.ts";
import type { ParameterMeta } from "../secrets/parameters/index.ts";

/**
 * Server-rendered HTML for the human resource browser.
 *
 * Every page is a full document with the theme inlined — no build step, no
 * client framework, no bundle. Navigation is plain `<a href>` with a `?prefix=`
 * query, so descending a folder and walking the breadcrumb back are ordinary GET
 * requests that the same SSO gate covers. Progressive enhancement, not an SPA.
 *
 * The palette, type scale and card/table styling are lifted from the strad docs
 * site (docs/src/styles/custom.css): the Zimmer teal theme, IBM Plex Sans for
 * text, JetBrains Mono for code. A resource server that serves a browser view
 * behind the SSO gate should look like it belongs to the same product.
 */

export interface LayoutOptions {
  title: string;
  /** Slug shown in the header badge, if this is a per-server page. */
  serverSlug?: string;
  signedInAs?: string;
  body: string;
}

export function layout(opts: LayoutOptions): string {
  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>${esc(opts.title)} · strad</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;650&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />
<style>${THEME_CSS}</style>
</head>
<body>
<header class="topbar">
  <div class="topbar-inner">
    <a class="brand" href="/ui">
      ${LOGO_SVG}
      <span class="brand-name">strad</span>
      <span class="brand-sub">resource browser</span>
    </a>
    <div class="topbar-right">
      ${
        opts.serverSlug
          ? `<span class="server-badge"><span class="dot"></span>${esc(opts.serverSlug)}</span>`
          : ""
      }
      ${
        opts.signedInAs
          ? `<span class="whoami" title="signed in via console SSO">${esc(opts.signedInAs)}</span>`
          : ""
      }
    </div>
  </div>
</header>
<main class="page">
${opts.body}
</main>
<footer class="foot">
  <span>strad · human console</span>
  <span class="foot-sep">·</span>
  <span>SSO-gated · humans only</span>
</footer>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// The index: every configured server, with a link to its view.
// ---------------------------------------------------------------------------

export function renderIndex(
  config: StradConfig,
  signedInAs: string | undefined,
): string {
  const cards = config.servers.map((s) => serverCard(s)).join("\n");

  const body = `
<section class="intro">
  <h1>Resource browser</h1>
  <p class="lede">A human-facing, SSO-gated view of the resources scoped to each
    MCP server on this strad gateway. Pick a server to browse what it can see.</p>
</section>
<div class="card-grid">
${cards || `<p class="empty">No servers are configured on this gateway.</p>`}
</div>`;

  return layout({ title: "Resource browser", signedInAs, body });
}

function serverCard(server: ServerConfig): string {
  const hasGcs = serverLooksGcs(server);
  const hasSecrets = serverLooksSecrets(server);
  const hasView = hasGcs || hasSecrets;
  const kindLabel = server.kind;
  const title = server.title ?? server.slug;
  const desc =
    server.description ??
    (hasSecrets
      ? "Add, rotate, reveal and delete the non-secret and secret parameters this server manages."
      : hasGcs
        ? "Browse the object store this server is scoped to."
        : "No browser view for this server kind yet.");

  const cta = hasSecrets ? "Manage →" : "Browse →";

  const inner = `
    <div class="card-head">
      <span class="card-title">${esc(title)}</span>
      <span class="chip chip-${esc(kindLabel)}">${esc(kindLabel)}</span>
      ${server.enabled ? "" : `<span class="chip chip-off">disabled</span>`}
    </div>
    <p class="card-desc">${esc(desc)}</p>
    <div class="card-foot">
      <code>${esc(server.slug)}</code>
      ${hasView ? `<span class="card-cta">${cta}</span>` : `<span class="card-muted">No view</span>`}
    </div>`;

  return hasView
    ? `<a class="card card-link" href="/ui/${encodeURIComponent(server.slug)}">${inner}</a>`
    : `<div class="card">${inner}</div>`;
}

// ---------------------------------------------------------------------------
// The GCS browse view.
// ---------------------------------------------------------------------------

export interface GcsBrowseOptions {
  view: Extract<ServerView, { kind: "gcs" }>;
  /** Relative prefix under the server's configured root (may be ""). */
  relPrefix: string;
  result: ListResult;
  signedInAs?: string;
}

export function renderGcsBrowse(opts: GcsBrowseOptions): string {
  const { view, relPrefix, result } = opts;
  const slug = view.server.slug;

  const folders = result.prefixes
    .map((full) => {
      const rel = stripRoot(full, view.prefix);
      const name = lastSegment(rel);
      const href = `/ui/${encodeURIComponent(slug)}?prefix=${encodeURIComponent(rel)}`;
      return `
      <a class="row folder-row" href="${href}">
        <span class="row-icon">${FOLDER_SVG}</span>
        <span class="row-name">${esc(name)}</span>
        <span class="row-meta">folder</span>
      </a>`;
    })
    .join("\n");

  const objects = result.objects
    // GCS returns the prefix's own placeholder object (name === fullPrefix) when
    // one exists; it is not a file the human placed, so drop it.
    .filter((o) => o.name !== view.prefix + relPrefix)
    .map((o) => {
      const name = lastSegment(o.name);
      return `
      <div class="row object-row">
        <span class="row-icon">${FILE_SVG}</span>
        <span class="row-name" title="${esc(o.name)}">${esc(name)}</span>
        <span class="row-size">${o.size != null ? humanSize(o.size) : "—"}</span>
        <span class="row-time">${o.updated ? esc(formatTime(o.updated)) : "—"}</span>
      </div>`;
    })
    .join("\n");

  const totalBytes = result.objects.reduce((n, o) => n + (o.size ?? 0), 0);

  const listing =
    result.prefixes.length === 0 && result.objects.length === 0
      ? `<div class="state">
           <div class="state-icon">${FOLDER_SVG}</div>
           <p class="state-title">This location is empty</p>
           <p class="state-sub">No folders or objects under this prefix.</p>
         </div>`
      : `
      <div class="listing">
        ${
          folders
            ? `<div class="group-label">Folders · ${result.prefixes.length}</div>${folders}`
            : ""
        }
        ${
          objects
            ? `<div class="group-label objects-label">
                 <span>Objects · ${result.objects.length}</span>
                 <span class="col-labels"><span>size</span><span>updated</span></span>
               </div>${objects}`
            : ""
        }
      </div>`;

  const body = `
${breadcrumb(view, relPrefix)}
<section class="browse-head">
  <div class="stat"><span class="stat-n">${result.prefixes.length}</span><span class="stat-l">folders</span></div>
  <div class="stat"><span class="stat-n">${result.objects.length}</span><span class="stat-l">objects</span></div>
  <div class="stat"><span class="stat-n">${humanSize(totalBytes)}</span><span class="stat-l">on this page</span></div>
  <div class="scope">
    <span class="scope-l">bucket</span>
    <code>${esc(view.bucket)}</code>
    ${view.prefix ? `<span class="scope-l">root</span><code>${esc(view.prefix)}</code>` : ""}
  </div>
</section>
${result.nextPageToken ? `<p class="truncated">Showing the first page. This location has more than one page of results.</p>` : ""}
${listing}`;

  return layout({
    title: `${slug} · ${relPrefix || "/"}`,
    serverSlug: slug,
    signedInAs: opts.signedInAs,
    body,
  });
}

function breadcrumb(
  view: Extract<ServerView, { kind: "gcs" }>,
  relPrefix: string,
): string {
  const slug = view.server.slug;
  const root = `/ui/${encodeURIComponent(slug)}`;
  const rootLabel = view.prefix ? trimSlash(view.prefix) : view.bucket;

  const crumbs: string[] = [
    relPrefix
      ? `<a href="${root}" class="crumb">${esc(rootLabel)}</a>`
      : `<span class="crumb crumb-current">${esc(rootLabel)}</span>`,
  ];

  const segs = relPrefix.split("/").filter(Boolean);
  let acc = "";
  segs.forEach((seg, i) => {
    acc += `${seg}/`;
    const last = i === segs.length - 1;
    crumbs.push(`<span class="crumb-sep">/</span>`);
    crumbs.push(
      last
        ? `<span class="crumb crumb-current">${esc(seg)}</span>`
        : `<a href="${root}?prefix=${encodeURIComponent(acc)}" class="crumb">${esc(seg)}</a>`,
    );
  });

  return `<nav class="breadcrumb">${crumbs.join("")}</nav>`;
}

// ---------------------------------------------------------------------------
// The parameters view — the human half of the `secrets` server.
// ---------------------------------------------------------------------------

export interface SecretsViewOptions {
  view: Extract<ServerView, { kind: "secrets" }>;
  parameters: ParameterMeta[];
  signedInAs?: string;
  /** A one-shot banner after an action ("Created FOO"). */
  flash?: { tone: "ok" | "error"; message: string };
  /**
   * A revealed value, shown ONCE, in response to an explicit click.
   *
   * It is rendered into the page and nowhere else: never logged, never in a
   * URL (the reveal is a POST, so it cannot be bookmarked or land in a proxy
   * log), never in telemetry. Reloading the page loses it, which is correct.
   */
  revealed?: { name: string; value: string };
}

export function renderSecrets(opts: SecretsViewOptions): string {
  const { view, parameters } = opts;
  const slug = view.server.slug;
  const action = `/ui/${encodeURIComponent(slug)}`;
  const defaultNs = view.namespaces[0] ?? "";

  const rows = parameters
    .map((p) => {
      const kind = p.secret
        ? `<span class="chip chip-secret">secret</span>`
        : `<span class="chip chip-plain">non-secret</span>`;
      return `
      <div class="row secret-row">
        <span class="row-icon">${p.secret ? KEY_SVG : TAG_SVG}</span>
        <span class="row-name" title="${esc(p.path)}">${esc(p.variable)}</span>
        <span class="row-kind">${kind}</span>
        <span class="row-note">${p.note ? esc(p.note) : `<span class="row-nonote">no note</span>`}</span>
        <span class="row-ver">${
          p.hasValue
            ? `<span class="chip chip-ok">${esc(p.latestVersion ?? "set")}</span>`
            : `<span class="chip chip-off">no value</span>`
        }</span>
        <span class="row-time">${p.updatedAt ? esc(formatTime(p.updatedAt)) : "—"}</span>
        <span class="row-actions">
          <form method="post" action="${action}/reveal" class="inline">
            <input type="hidden" name="path" value="${esc(p.path)}" />
            <button class="btn btn-ghost" ${p.hasValue ? "" : "disabled"}>Reveal</button>
          </form>
          <form method="post" action="${action}/rotate" class="inline rotate-form">
            <input type="hidden" name="path" value="${esc(p.path)}" />
            <input class="in in-sm" type="password" name="value" placeholder="new value" autocomplete="off" required />
            <button class="btn btn-ghost">Rotate</button>
          </form>
          <form method="post" action="${action}/note" class="inline">
            <input type="hidden" name="path" value="${esc(p.path)}" />
            <input class="in in-sm" type="text" name="note" placeholder="note…" value="${esc(p.note ?? "")}" maxlength="512" />
            <button class="btn btn-ghost">Save note</button>
          </form>
          <form method="post" action="${action}/delete" class="inline"
                onsubmit="return confirm('Delete ${esc(p.variable)} and every version of it? This cannot be undone.')">
            <input type="hidden" name="path" value="${esc(p.path)}" />
            <button class="btn btn-danger">Delete</button>
          </form>
        </span>
      </div>`;
    })
    .join("\n");

  const listing = parameters.length
    ? `<div class="listing">
         <div class="group-label objects-label">
           <span>Parameters · ${parameters.length}</span>
           <span class="col-labels"><span>note</span><span>value</span><span>updated</span><span>actions</span></span>
         </div>
         ${rows}
       </div>`
    : `<div class="state">
         <div class="state-icon">${KEY_SVG}</div>
         <p class="state-title">No parameters in this namespace yet</p>
         <p class="state-sub">Add one below. Agents can see a parameter's name, kind and note — and, for a non-secret parameter, its value; never a secret value.</p>
       </div>`;

  const reveal = opts.revealed
    ? `<section class="reveal">
         <div class="reveal-head">
           <span class="reveal-title">${esc(opts.revealed.name)}</span>
           <span class="reveal-warn">shown once · not logged · reload to clear</span>
         </div>
         <pre class="reveal-value">${esc(opts.revealed.value)}</pre>
       </section>`
    : "";

  const flash = opts.flash
    ? `<div class="flash flash-${opts.flash.tone}">${esc(opts.flash.message)}</div>`
    : "";

  const secretCount = parameters.filter((p) => p.secret).length;

  const body = `
<nav class="breadcrumb"><a href="/ui" class="crumb">resource browser</a><span class="crumb-sep">/</span><span class="crumb crumb-current">${esc(slug)}</span></nav>

<section class="browse-head">
  <div class="stat"><span class="stat-n">${parameters.length}</span><span class="stat-l">parameters</span></div>
  <div class="stat"><span class="stat-n">${secretCount}</span><span class="stat-l">secret</span></div>
  <div class="scope">
    <span class="scope-l">project</span><code>${esc(view.projectId)}</code>
    <span class="scope-l">namespace</span><code>${esc(view.namespaces.join(", "))}</code>
  </div>
</section>

<p class="posture">
  <strong>Parameter Manager indexes everything; Secret Manager backs the secret parts.</strong>
  The <code>${esc(slug)}</code> MCP server runs as a viewer service account: it can list
  parameters, their notes and versions, and read <em>non-secret</em> values — and it holds no
  <code>secretmanager.versions.access</code>, so no tool, bug or prompt injection can pull a
  <em>secret</em> value through <code>/mcp</code>. Adding, rotating, revealing and deleting
  happen on this page, as a human, behind SSO, with a different admin credential the MCP
  container never sees.
</p>

${flash}
${reveal}
${listing}

<section class="addbox">
  <h2 class="addbox-title">Add a parameter</h2>
  <form method="post" action="${action}/create" class="addform">
    <label class="field">
      <span class="field-l">Variable name</span>
      <input class="in" type="text" name="variable" required autocapitalize="off" autocomplete="off"
             pattern="[A-Za-z_][A-Za-z0-9_]*" placeholder="REMOTE_FILESYSTEM_TMP_PUBLIC_GCS_CLIENT_EMAIL" />
      <span class="field-h">A valid environment variable name. Stored at <code>${esc(defaultNs)}&lt;VARIABLE&gt;</code>.</span>
    </label>
    <label class="field field-check">
      <input type="checkbox" name="secret" />
      <span><span class="field-l">Secret</span> <span class="field-h">Tick for a credential (private key, token). The value goes to Secret Manager and can never be read over <code>/mcp</code>. Leave unticked for a non-secret value (e.g. a service-account email), which is stored in Parameter Manager and IS readable by agents.</span></span>
    </label>
    <label class="field">
      <span class="field-l">Note <span class="field-opt">optional</span></span>
      <input class="in" type="text" name="note" maxlength="512"
             placeholder="What is this for? Who issued it? When should it rotate?" />
      <span class="field-h">Agents CAN read this note, for either kind.</span>
    </label>
    <label class="field">
      <span class="field-l">Value</span>
      <input class="in" type="password" name="value" required autocomplete="off" />
      <span class="field-h">A secret value goes straight to Secret Manager. A non-secret value goes to Parameter Manager.</span>
    </label>
    <button class="btn btn-primary">Create parameter</button>
  </form>
</section>`;

  return layout({
    title: `${slug} · parameters`,
    serverSlug: slug,
    signedInAs: opts.signedInAs,
    body,
  });
}

// ---------------------------------------------------------------------------
// States: no viewer, credentials missing, error, not found.
// ---------------------------------------------------------------------------

export function renderMessage(opts: {
  title: string;
  serverSlug?: string;
  signedInAs?: string;
  heading: string;
  sub: string;
  tone?: "info" | "warn" | "error";
  icon?: string;
  breadcrumbToIndex?: boolean;
}): string {
  const tone = opts.tone ?? "info";
  const body = `
${opts.breadcrumbToIndex ? `<nav class="breadcrumb"><a href="/ui" class="crumb">resource browser</a></nav>` : ""}
<div class="state state-${tone}">
  <div class="state-icon">${opts.icon ?? INFO_SVG}</div>
  <p class="state-title">${esc(opts.heading)}</p>
  <p class="state-sub">${esc(opts.sub)}</p>
</div>`;
  return layout({
    title: opts.title,
    serverSlug: opts.serverSlug,
    signedInAs: opts.signedInAs,
    body,
  });
}

/** The 401 shown when the SSO gate is not satisfied and Google OAuth is off. */
export function renderSignIn(reason: string): string {
  const body = `
<div class="state state-warn signin">
  <div class="state-icon">${LOCK_SVG}</div>
  <p class="state-title">Sign in required</p>
  <p class="state-sub">This console is gated by strad's SSO. Google Workspace
    sign-in is not yet configured on this deployment, so entry is via the console
    dev bypass — present the bootstrap token as <code>?token=…</code>.</p>
  <p class="state-detail">${esc(reason)}</p>
</div>`;
  return layout({ title: "Sign in", body });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The `secrets` detector: it declares a secrets/parameters project. */
export function serverLooksSecrets(server: ServerConfig): boolean {
  const env =
    server.kind === "supplementary-image"
      ? { ...server.env, ...server.consoleEnv }
      : server.kind === "builtin"
        ? server.options
        : {};
  return Object.keys(env).includes("SECRETS_PROJECT_ID");
}

export function serverLooksGcs(server: ServerConfig): boolean {
  const env =
    server.kind === "supplementary-image"
      ? server.env
      : server.kind === "builtin"
        ? server.options
        : {};
  const keys = Object.keys(env);
  return (
    keys.includes("GCS_BUCKET") ||
    keys.includes("GCS_SERVICE_ACCOUNT_KEY_JSON") ||
    keys.includes("GCS_CLIENT_EMAIL")
  );
}

function stripRoot(full: string, root: string): string {
  return full.startsWith(root) ? full.slice(root.length) : full;
}

function lastSegment(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const i = trimmed.lastIndexOf("/");
  return i === -1 ? trimmed : trimmed.slice(i + 1);
}

function trimSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

export function humanSize(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(
    units.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1024)),
  );
  const value = bytes / Math.pow(1024, i);
  const rounded =
    value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1);
  return `${rounded} ${units[i]}`;
}

export function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const now = Date.now();
  const diff = now - d.getTime();
  const day = 86_400_000;
  if (diff >= 0 && diff < day) {
    const hours = Math.floor(diff / 3_600_000);
    if (hours < 1) return "just now";
    return `${hours}h ago`;
  }
  if (diff >= 0 && diff < 30 * day) {
    return `${Math.floor(diff / day)}d ago`;
  }
  return d.toISOString().slice(0, 10);
}

export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ---------------------------------------------------------------------------
// Inline SVGs (no external asset requests).
// ---------------------------------------------------------------------------

const LOGO_SVG = `<svg class="logo" width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="2.5" y="2.5" width="19" height="19" rx="4.5" stroke="currentColor" stroke-width="1.6"/><path d="M8 9.2c0-1 .9-1.7 2.2-1.7 1.2 0 2 .5 2.4 1.3M8 14.8c0 1 1 1.7 2.4 1.7s2.4-.7 2.4-1.8c0-2.4-4.6-1.4-4.6-3.7 0-1 .9-1.6 2.1-1.6M16 8v8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;

const FOLDER_SVG = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.2c.5 0 1 .22 1.3.62L11.2 7H19.5A1.5 1.5 0 0 1 21 8.5v9A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5v-11Z" fill="currentColor" fill-opacity="0.14" stroke="currentColor" stroke-width="1.5"/></svg>`;

const FILE_SVG = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 3.5h7L18.5 9v11a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 20V5A1.5 1.5 0 0 1 6 3.5Z" stroke="currentColor" stroke-width="1.5"/><path d="M13 3.5V9h5.5" stroke="currentColor" stroke-width="1.5"/></svg>`;

const LOCK_SVG = `<svg width="34" height="34" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="4.5" y="10.5" width="15" height="9.5" rx="2" stroke="currentColor" stroke-width="1.5"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" stroke="currentColor" stroke-width="1.5"/></svg>`;

const KEY_SVG = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="8" cy="12" r="4" stroke="currentColor" stroke-width="1.5"/><path d="M12 12h8M17.5 12v3M20 12v2.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;

const TAG_SVG = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 12.5V5.5A1.5 1.5 0 0 1 5.5 4h7l7.5 7.5a1.5 1.5 0 0 1 0 2.1l-6.4 6.4a1.5 1.5 0 0 1-2.1 0L4 12.5Z" stroke="currentColor" stroke-width="1.5"/><circle cx="8.5" cy="8.5" r="1.3" fill="currentColor"/></svg>`;

const INFO_SVG = `<svg width="34" height="34" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="8.5" stroke="currentColor" stroke-width="1.5"/><path d="M12 11v5M12 8h.01" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`;

// ---------------------------------------------------------------------------
// Theme — the docs palette (docs/src/styles/custom.css), inlined and adapted
// from a Starlight page to a standalone document.
// ---------------------------------------------------------------------------

const THEME_CSS = `
:root{
  --font-sans:"IBM Plex Sans",system-ui,-apple-system,"Segoe UI",sans-serif;
  --font-mono:"JetBrains Mono",ui-monospace,"SF Mono",Menlo,monospace;
  --white:#f2f3f6;--g1:#d8dbe2;--g2:#b4b9c4;--g3:#868c99;--g4:#5a606d;
  --g5:#333844;--g6:#1e212a;--g7:#171921;--black:#0f1116;
  --accent-low:#0b2f2b;--accent:#158b7d;--accent-high:#b9e8e0;--text-accent:#5ec7b8;
  --bg:#0f1116;--bg-code:#20242e;
}
*{box-sizing:border-box}
html{scrollbar-gutter:stable}
body{
  margin:0;background:var(--bg);color:var(--g1);
  font-family:var(--font-sans);line-height:1.6;
  -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;
  min-height:100vh;display:flex;flex-direction:column;
}
a{color:inherit;text-decoration:none}
code{font-family:var(--font-mono);font-size:.84em;background:var(--bg-code);
  border:1px solid var(--g5);border-radius:4px;padding:.08em .38em;color:var(--g1);}

/* Top bar */
.topbar{border-bottom:1px solid var(--g5);background:color-mix(in srgb,var(--bg) 88%,transparent);
  position:sticky;top:0;z-index:5;backdrop-filter:blur(8px);}
.topbar-inner{max-width:60rem;margin:0 auto;padding:.7rem 1.5rem;
  display:flex;align-items:center;justify-content:space-between;gap:1rem;}
.brand{display:flex;align-items:center;gap:.55rem;color:var(--white);}
.brand .logo{color:var(--text-accent)}
.brand-name{font-weight:650;letter-spacing:-.01em;font-size:1.05rem}
.brand-sub{color:var(--g3);font-size:.82rem;font-weight:500;
  padding-left:.55rem;margin-left:.15rem;border-left:1px solid var(--g5);}
.topbar-right{display:flex;align-items:center;gap:.7rem}
.server-badge{display:inline-flex;align-items:center;gap:.4rem;font-family:var(--font-mono);
  font-size:.8rem;color:var(--accent-high);background:color-mix(in srgb,var(--accent) 12%,transparent);
  border:1px solid color-mix(in srgb,var(--accent) 35%,var(--g5));border-radius:999px;padding:.2rem .6rem;}
.server-badge .dot{width:.45rem;height:.45rem;border-radius:50%;background:var(--text-accent);
  box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 25%,transparent);}
.whoami{color:var(--g3);font-size:.8rem;font-family:var(--font-mono)}

/* Page */
.page{max-width:60rem;margin:0 auto;padding:1.9rem 1.5rem 3rem;width:100%;flex:1}

.intro h1{font-size:2rem;font-weight:650;letter-spacing:-.02em;color:var(--white);margin:0 0 .5rem}
.intro .lede{color:var(--g2);font-size:1.02rem;max-width:40rem;margin:0 0 1.6rem}

/* Server cards */
.card-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(16.5rem,1fr));gap:1rem}
.card{border:1px solid var(--g5);border-radius:.6rem;background:var(--g7);padding:1.05rem 1.15rem;
  display:flex;flex-direction:column;gap:.55rem;transition:border-color .15s ease,transform .15s ease}
.card-link:hover{border-color:color-mix(in srgb,var(--accent) 50%,var(--g5));transform:translateY(-1px)}
.card-head{display:flex;align-items:center;gap:.5rem;flex-wrap:wrap}
.card-title{font-weight:600;font-size:1.08rem;color:var(--white)}
.card-desc{color:var(--g2);font-size:.9rem;margin:0;flex:1}
.card-foot{display:flex;align-items:center;justify-content:space-between;margin-top:.2rem}
.card-cta{color:var(--text-accent);font-weight:600;font-size:.86rem}
.card-muted{color:var(--g4);font-size:.82rem}
.chip{font-size:.68rem;font-family:var(--font-mono);text-transform:uppercase;letter-spacing:.04em;
  border:1px solid var(--g5);border-radius:4px;padding:.1rem .4rem;color:var(--g3)}
.chip-off{color:var(--g4);border-style:dashed}

/* Breadcrumb */
.breadcrumb{display:flex;align-items:center;gap:.15rem;flex-wrap:wrap;font-family:var(--font-mono);
  font-size:.86rem;margin-bottom:1.25rem;color:var(--g3)}
.crumb{color:var(--text-accent);padding:.15rem .3rem;border-radius:4px}
.crumb:hover{background:color-mix(in srgb,var(--accent) 12%,transparent)}
.crumb-current{color:var(--g1);font-weight:500}
.crumb-sep{color:var(--g4);padding:0 .1rem}

/* Browse head */
.browse-head{display:flex;align-items:center;gap:1.6rem;flex-wrap:wrap;
  padding:1.05rem 1.2rem;border:1px solid var(--g5);border-radius:.6rem;background:var(--g7);margin-bottom:1.3rem}
.stat{display:flex;flex-direction:column;line-height:1.2}
.stat-n{font-size:1.4rem;font-weight:650;color:var(--white);letter-spacing:-.01em;font-variant-numeric:tabular-nums}
.stat-l{font-size:.72rem;text-transform:uppercase;letter-spacing:.06em;color:var(--g3)}
.scope{margin-left:auto;display:flex;align-items:center;gap:.5rem;flex-wrap:wrap;font-size:.82rem}
.scope-l{color:var(--g4);text-transform:uppercase;letter-spacing:.05em;font-size:.68rem}
.truncated{font-size:.82rem;color:var(--g3);margin:-.6rem 0 1rem}

/* Listing */
.listing{border:1px solid var(--g5);border-radius:.6rem;overflow:hidden;background:var(--g7)}
.group-label{padding:.55rem 1.1rem;font-size:.72rem;text-transform:uppercase;letter-spacing:.06em;
  color:var(--g3);background:var(--g6);border-bottom:1px solid var(--g5);
  display:flex;align-items:center;justify-content:space-between}
.objects-label{border-top:1px solid var(--g5)}
.col-labels{display:flex;gap:0;font-size:.68rem}
.col-labels span{width:6.5rem;text-align:right}
.row{display:flex;align-items:center;gap:.75rem;padding:.6rem 1.1rem;border-bottom:1px solid var(--g6);
  color:var(--g1);font-size:.92rem}
.row:last-child{border-bottom:none}
.folder-row:hover{background:color-mix(in srgb,var(--accent) 8%,transparent)}
.object-row:hover{background:var(--g6)}
.row-icon{display:flex;color:var(--text-accent);flex:none}
.object-row .row-icon{color:var(--g3)}
.row-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--font-mono);font-size:.86rem}
.folder-row .row-name{color:var(--white);font-weight:500}
.row-meta{color:var(--g4);font-size:.76rem;font-family:var(--font-mono)}
.row-size,.row-time{width:6.5rem;text-align:right;color:var(--g3);font-size:.8rem;
  font-family:var(--font-mono);font-variant-numeric:tabular-nums;flex:none}
.row-time{color:var(--g4)}

/* Empty / message states */
.state{display:flex;flex-direction:column;align-items:center;text-align:center;gap:.5rem;
  padding:3.2rem 1.5rem;border:1px solid var(--g5);border-radius:.6rem;background:var(--g7)}
.state-icon{color:var(--g4);margin-bottom:.3rem}
.state-title{font-size:1.1rem;font-weight:600;color:var(--white);margin:0}
.state-sub{color:var(--g2);margin:0;max-width:34rem}
.state-detail{color:var(--g4);font-size:.82rem;font-family:var(--font-mono);margin:.4rem 0 0}
.state-warn .state-icon{color:#e0a63b}
.state-error .state-icon{color:#e5706e}
.signin code{font-size:.8em}
.empty{color:var(--g3)}

/* Secrets view — the only WRITE surface in the console. */
.posture{margin:0 0 1.2rem;padding:.75rem 1rem;border:1px solid var(--g5);border-left:3px solid var(--accent);
  border-radius:.4rem;background:var(--g7);color:var(--g2);font-size:.85rem;line-height:1.5}
.posture strong{color:var(--white)}
.secret-row{gap:.6rem;flex-wrap:wrap}
.secret-row .row-name{flex:0 0 15rem;color:var(--white);font-weight:500}
.row-kind{flex:none}
.row-note{flex:1;min-width:8rem;color:var(--g2);font-size:.82rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.row-nonote{color:var(--g4);font-style:italic}
.row-ver{flex:none;width:5.5rem;text-align:right}
.row-actions{display:flex;align-items:center;gap:.35rem;flex:none;flex-wrap:wrap}
.chip-ok{color:var(--text-accent);border-color:var(--accent)}
.chip-secret{color:#e0a63b;border-color:color-mix(in srgb,#e0a63b 45%,var(--g5));text-transform:none;letter-spacing:0}
.chip-plain{color:var(--g3);border-color:var(--g5);text-transform:none;letter-spacing:0}
.field-check{flex-direction:row;align-items:flex-start;gap:.55rem}
.field-check input{margin-top:.2rem;width:1rem;height:1rem;flex:none;accent-color:var(--accent)}
.field-check .field-l{display:inline}
form.inline{display:flex;align-items:center;gap:.25rem;margin:0}
.btn{font:inherit;font-size:.76rem;padding:.32rem .6rem;border-radius:.35rem;cursor:pointer;
  border:1px solid var(--g5);background:var(--g6);color:var(--g1);white-space:nowrap}
.btn:hover:not(:disabled){border-color:var(--accent);color:var(--white)}
.btn:disabled{opacity:.4;cursor:not-allowed}
.btn-primary{background:var(--accent);border-color:var(--accent);color:#fff;font-size:.85rem;padding:.5rem 1rem;font-weight:600}
.btn-primary:hover{background:var(--accent-high);color:#fff}
.btn-danger:hover{border-color:#e5706e;color:#e5706e}
.in{font:inherit;font-size:.85rem;padding:.45rem .6rem;border-radius:.35rem;border:1px solid var(--g5);
  background:var(--bg);color:var(--white);width:100%;font-family:var(--font-mono)}
.in:focus{outline:none;border-color:var(--accent)}
.in-sm{font-size:.74rem;padding:.28rem .4rem;width:8.5rem}
.addbox{margin-top:1.5rem;border:1px solid var(--g5);border-radius:.6rem;background:var(--g7);padding:1.2rem 1.4rem}
.addbox-title{margin:0 0 .9rem;font-size:1rem;color:var(--white)}
.addform{display:flex;flex-direction:column;gap:.9rem;max-width:34rem}
.field{display:flex;flex-direction:column;gap:.3rem}
.field-l{font-size:.78rem;color:var(--g2);font-weight:600}
.field-opt{color:var(--g4);font-weight:400;text-transform:uppercase;font-size:.66rem;letter-spacing:.05em}
.field-h{font-size:.72rem;color:var(--g4)}
.flash{padding:.6rem .9rem;border-radius:.4rem;margin-bottom:1rem;font-size:.85rem;border:1px solid}
.flash-ok{border-color:var(--accent);background:color-mix(in srgb,var(--accent) 10%,transparent);color:var(--white)}
.flash-error{border-color:#e5706e;background:color-mix(in srgb,#e5706e 10%,transparent);color:var(--white)}
.reveal{border:1px solid #e0a63b;border-radius:.6rem;padding:.9rem 1.1rem;margin-bottom:1.2rem;
  background:color-mix(in srgb,#e0a63b 8%,transparent)}
.reveal-head{display:flex;justify-content:space-between;align-items:center;gap:1rem;margin-bottom:.5rem;flex-wrap:wrap}
.reveal-title{font-family:var(--font-mono);font-size:.9rem;color:var(--white);font-weight:600}
.reveal-warn{font-size:.7rem;text-transform:uppercase;letter-spacing:.05em;color:#e0a63b}
.reveal-value{margin:0;padding:.6rem .8rem;border-radius:.35rem;background:var(--bg-code);color:var(--white);
  font-family:var(--font-mono);font-size:.85rem;overflow-x:auto;white-space:pre-wrap;word-break:break-all}

/* Footer */
.foot{max-width:60rem;margin:0 auto;padding:1.2rem 1.5rem;width:100%;
  border-top:1px solid var(--g5);color:var(--g4);font-size:.8rem;display:flex;gap:.6rem}
.foot-sep{color:var(--g5)}

/* Light theme */
:root[data-theme="light"]{
  --white:#16181d;--g1:#2a2d34;--g2:#3c3f48;--g3:#5c616c;--g4:#888e9a;
  --g5:#e2e4e9;--g6:#f0f1f4;--g7:#f6f7f9;--black:#fff;
  --accent-low:#d4f0ea;--accent:#0f766e;--accent-high:#0a4a44;--text-accent:#0f766e;
  --bg:#fff;--bg-code:#eef0f3;
}
@media (prefers-color-scheme:light){
  :root:not([data-theme="dark"]){
    --white:#16181d;--g1:#2a2d34;--g2:#3c3f48;--g3:#5c616c;--g4:#888e9a;
    --g5:#e2e4e9;--g6:#f0f1f4;--g7:#f6f7f9;--black:#fff;
    --accent-low:#d4f0ea;--accent:#0f766e;--accent-high:#0a4a44;--text-accent:#0f766e;
    --bg:#fff;--bg-code:#eef0f3;
  }
}
`;
