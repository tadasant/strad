import type { ConsoleDenial } from "../auth/dev.ts";
// The `pattern=` on the variable-name input below. HTML anchors `pattern`
// implicitly, so the UNANCHORED source string is exactly what belongs there —
// the same string `isEnvName` sits between `^` and `$`. One rule, both gates.
import { ENV_NAME_SOURCE } from "../config/env-name.ts";
import { isUnhosted } from "../config/schema.ts";
import type { StradConfig } from "../config/schema.ts";
import type { ListResult } from "./gcs-client.ts";
import type {
  SecretsPageSummary,
  SecretsStore,
  ServerView,
} from "./resolve.ts";
import type { ParameterMeta } from "../secrets/parameters/index.ts";
import { serverConsolePath } from "./paths.ts";
import { CONSOLE_SNAPSHOT_TTL_MS } from "./store-client.ts";
import {
  classifyPath,
  paramsConsumers,
  prefixSuggestions,
  type Routing,
} from "./param-routing.ts";
import type { RevealPosture } from "./reveal.ts";
import { NAV_CSS, renderNav, type NavKey } from "./nav.ts";
import { PWA_HEAD } from "./pwa.ts";
import {
  MAX_BULK_RECORDS,
  formatBulkRow,
  parseBulkCsv,
  parseBulkKind,
  type BulkReport,
} from "./bulk-params.ts";

/**
 * Server-rendered HTML for the human console.
 *
 * Every page is a full document with the theme inlined — no build step, no
 * client framework, no bundle. Navigation is plain `<a href>` with a `?prefix=`
 * query, so descending a folder and walking the breadcrumb back are ordinary GET
 * requests that the same SSO gate covers. Progressive enhancement, not an SPA.
 *
 * The console is also installable, and that changed none of the above: a PWA
 * needs a manifest, icons and a service worker, which are three static files
 * Express serves (src/ui/pwa.ts). `PWA_HEAD` below is the `<head>` half of it.
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
  /**
   * The shared nav bar (src/ui/nav.ts), and which top-level destination this
   * page belongs to.
   *
   * Default-on, deliberately: "every console page carries the nav" is the
   * property, and a default that had to be opted into would be one page away
   * from being false again. `undefined` draws the bar with nothing marked — for
   * a page that is a console page but none of the five destinations. `false`
   * omits it, and only the pages reached WITHOUT a console session pass it: the
   * sign-in refusal, the offline shell, and the `/mcp` OAuth screens, where
   * every link in the bar would answer 401.
   */
  nav?: NavKey | false;
  /** Where the brand mark links. Defaults to the consolidated servers view. */
  brandHref?: string;
  /**
   * Widen the page frame — header, content and footer together.
   *
   * 60rem is the measure for PROSE, and every console page but one is mostly
   * prose. The connectors roster is a table of short facts per slug, and at
   * 60rem its last column wraps its own controls onto three lines — which costs
   * more vertical space than the extra width ever does. All three bars move
   * together, because widening only the content leaves the nav and the footer
   * visibly out of register with it.
   */
  wide?: boolean;
  /** The word beside the brand mark. Defaults to "console". */
  brandSub?: string;
  /**
   * Right-hand footer text. Defaults to the gated browser's own claim, which
   * would be a lie on the public landing page — hence the parameter.
   */
  footNote?: string;
  /**
   * Left-hand footer text. Same reasoning one step further: the OAuth consent
   * and refusal screens (`src/ui/oauth-consent.ts`) are reached mid-flow by a
   * human who has no console session and may never get one, so calling them
   * "human console" names the wrong surface.
   */
  footLead?: string;
  /**
   * Heading and accessible name for the Help dialog. Defaults to the console
   * guide; a page whose guide is about something narrower says so.
   */
  helpTitle?: string;
  /**
   * A guide, rendered into a `<dialog>` and opened by a Help control in the top
   * right. The working surface stays a working surface; the explanation is one
   * click away rather than scrolled past on every visit.
   *
   * PRE-ESCAPED HTML, built by this module. Never pass caller-supplied text.
   */
  help?: string;
}

export function layout(opts: LayoutOptions): string {
  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>${esc(opts.title)} · strad</title>
${PWA_HEAD}
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;650&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />
<style>${THEME_CSS}</style>
</head>
<body${opts.wide ? ` class="wide"` : ""}>
<header class="topbar">
  <div class="topbar-inner">
    <a class="brand" href="${esc(opts.brandHref ?? "/connectors")}">
      ${LOGO_SVG}
      <span class="brand-name">strad</span>
      <span class="brand-sub">${esc(opts.brandSub ?? "console")}</span>
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
      ${opts.help ? helpButton() : ""}
    </div>
  </div>
  ${opts.nav === false ? "" : renderNav(opts.nav)}
</header>
<main class="page">
${opts.body}
</main>
${opts.help ? helpDialog(opts.help, opts.helpTitle ?? "Console guide") : ""}
<footer class="foot">
  <span>${esc(opts.footLead ?? "strad · human console")}</span>
  <span class="foot-sep">·</span>
  <span>${esc(opts.footNote ?? "SSO-gated · humans only")}</span>
</footer>
</body>
</html>`;
}

/**
 * The Help control, and the guide behind it.
 *
 * A `<dialog>` rather than a route, so the guide is one click away and one
 * `Escape` back — no navigation, no losing the namespace you were on, and no
 * second page to keep in step with the first. `showModal()` gives the focus trap
 * and backdrop for free.
 *
 * WITH NO JS a `<dialog>` is `display:none` and the button is a dead control, so
 * "the content is still in the document" would be true only for a scraper. The
 * `<noscript>` block below inverts it: the button disappears and the guide
 * renders inline, which is where it lived before this control existed. A missing
 * `showModal` falls back to the `open` attribute for the same reason.
 */
function helpButton(): string {
  return `<button class="helpbtn" type="button" data-help-open aria-haspopup="dialog" title="Open the guide">${QUESTION_SVG}<span>Help</span></button>`;
}

function helpDialog(inner: string, title: string): string {
  return `<dialog class="helpdlg" id="help-dialog" aria-label="${esc(title)}">
  <div class="helpdlg-head">
    <h2>${esc(title)}</h2>
    <button class="btn" type="button" data-help-close aria-label="Close">Close</button>
  </div>
  <div class="helpdlg-body">${inner}</div>
</dialog>
<noscript><style>
  .helpbtn{display:none}
  .helpdlg{display:block;position:static;max-width:none;width:auto;margin:1.4rem 0;max-height:none}
  .helpdlg-head button{display:none}
  .helpdlg-body{max-height:none;overflow:visible}
</style></noscript>
<script>
(function () {
  var dlg = document.getElementById("help-dialog");
  if (!dlg) return;
  var modal = typeof dlg.showModal === "function";
  document.addEventListener("click", function (e) {
    if (!(e.target instanceof Element)) return;
    if (e.target.closest("[data-help-open]")) {
      if (modal) dlg.showModal(); else dlg.setAttribute("open", "");
      return;
    }
    if (e.target.closest("[data-help-close]")) {
      if (modal) dlg.close(); else dlg.removeAttribute("open");
      return;
    }
    // A click on the backdrop — outside the dialog's own box — closes it.
    if (modal && e.target === dlg) dlg.close();
  });
})();
</script>`;
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
      const href = `${serverConsolePath(slug)}?prefix=${encodeURIComponent(rel)}`;
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
    nav: "connectors",
  });
}

function breadcrumb(
  view: Extract<ServerView, { kind: "gcs" }>,
  relPrefix: string,
): string {
  const slug = view.server.slug;
  const root = serverConsolePath(slug);
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

  return `<nav class="breadcrumb" aria-label="Breadcrumb">${crumbs.join("")}</nav>`;
}

// ---------------------------------------------------------------------------
// The parameters view — the human half of the `secrets` server.
// ---------------------------------------------------------------------------

export interface SecretsViewOptions {
  view: Extract<ServerView, { kind: "secrets" }>;
  /**
   * The store this render is scoped to — one entry of `view.stores`.
   *
   * The page is a page; the STORE is the project, the namespaces, the bounds and
   * the credential. Every count, every path and every form on this render belongs
   * to this one entry, and nothing on the page is a union across the others.
   */
  store: SecretsStore;
  /**
   * The running gateway config. The page reports what will actually READ a
   * parameter, and that is a property of the config, not of the store — see
   * param-routing.ts.
   */
  config: StradConfig;
  parameters: ParameterMeta[];
  /**
   * Parameters that exist and could not be read, and may belong to this
   * namespace. The page names them under the rows it could read, so a listing
   * one throttled request short is visibly incomplete rather than silently so.
   */
  unreadable?: { id: string; reason: string }[];
  /**
   * The listing failed outright. Rendered as its own state: "the store did not
   * answer" and "this namespace is empty" call for different things.
   */
  listFailure?: string;
  /** When the reading this page shows was taken, epoch ms. */
  readAt?: number;
  /** The namespace being browsed. May be one the config never listed. */
  namespace: string;
  /**
   * Whether this deployment carries the resolver credential.
   *
   * `params: true` with no `STRAD_PARAMS_*` behind it delivers nothing, so the
   * page cannot report delivery from the config alone. See param-routing.ts.
   */
  resolver: boolean;
  /**
   * Whether this console offers reveal, and if not why. The flag decides what is
   * offered; the console's service account decides what is possible. See
   * reveal.ts — both must say yes.
   */
  reveal: RevealPosture;
  /**
   * The same question asked for a NON-secret parameter, whose value needs no
   * secret-read permission. Kept separate rather than recomputed per row so the
   * renderer stays a pure function of what it is handed.
   */
  revealNonSecret: RevealPosture;
  /**
   * The OTHER secrets pages on this gateway — every one but this — for the
   * strip under the breadcrumb. Empty on a gateway with one, and then there is
   * no strip. See siblingStrip.
   */
  siblingPages: SecretsPageSummary[];
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
  /**
   * What the last bulk add did, line by line, and the lines to put back in its
   * editor. Carries no value — see refillCsv in bulk-params.ts.
   */
  bulk?: BulkReport;
}

export function renderSecrets(opts: SecretsViewOptions): string {
  const {
    view,
    store,
    config,
    parameters,
    resolver,
    reveal: revealUi,
    revealNonSecret,
  } = opts;
  const slug = view.server.slug;
  const action = serverConsolePath(slug);
  const ns = opts.namespace;
  /**
   * Every form posts the namespace AND the store back, so an action returns
   * where it was.
   *
   * The store field is not a convenience. A create, rotate or delete that
   * arrived without it would be resolved against the page's first store, so on a
   * multi-store console the write would land in the wrong GCP project under the
   * wrong service account — see handleSecretAction, which refuses an
   * unrecognised one rather than falling back.
   */
  const nsField =
    `<input type="hidden" name="ns" value="${esc(ns)}" />` +
    `<input type="hidden" name="project" value="${esc(store.projectId)}" />`;

  const rows = parameters
    .map((p) => {
      const kind = p.secret
        ? `<span class="chip chip-secret">secret</span>`
        : `<span class="chip chip-plain">non-secret</span>`;
      const routing = classifyPath(config, p.path, resolver);
      // A non-secret value sits in the envelope this page already read, so
      // showing it needs no secret-read permission — only the flag. See
      // revealPosture's `secret` parameter.
      const rowReveal = p.secret ? revealUi : revealNonSecret;
      const prefix = p.path.startsWith(ns)
        ? p.path.slice(ns.length, p.path.length - p.variable.length)
        : "";
      return `
      <div class="row secret-row">
        <span class="row-icon">${p.secret ? KEY_SVG : TAG_SVG}</span>
        <span class="row-name" title="${esc(p.path)}">${
          prefix ? `<span class="row-pfx">${esc(prefix)}</span>` : ""
        }<span class="row-var">${esc(p.variable)}</span></span>
        <span class="row-kind">${kind}${deliveryChip(routing)}</span>
        <span class="row-note">${p.note ? esc(p.note) : `<span class="row-nonote">no note</span>`}</span>
        <span class="row-ver">${
          p.hasValue
            ? `<span class="chip chip-ok">${esc(p.latestVersion ?? "set")}</span>`
            : `<span class="chip chip-off">no value</span>`
        }</span>
        <span class="row-time">${p.updatedAt ? esc(formatTime(p.updatedAt)) : "—"}</span>
        <span class="row-actions">
          ${
            rowReveal.allowed
              ? `<form method="post" action="${action}/reveal" class="inline">
            <input type="hidden" name="path" value="${esc(p.path)}" />${nsField}
            <button class="btn btn-ghost" ${p.hasValue ? "" : "disabled"}>Reveal</button>
          </form>`
              : `<button class="btn btn-ghost" disabled title="${esc(rowReveal.detail)}">${esc(rowReveal.label)}</button>`
          }
          <form method="post" action="${action}/rotate" class="inline rotate-form">
            <input type="hidden" name="path" value="${esc(p.path)}" />${nsField}
            <textarea class="in in-sm in-value in-masked" name="value" rows="1" placeholder="new value" spellcheck="false" data-gramm="false" data-enable-grammarly="false"
                      autocapitalize="off" autocomplete="off" required></textarea>
            <button class="btn btn-ghost">Rotate</button>
          </form>
          <form method="post" action="${action}/note" class="inline">
            <input type="hidden" name="path" value="${esc(p.path)}" />${nsField}
            <input class="in in-sm" type="text" name="note" placeholder="note…" value="${esc(p.note ?? "")}" maxlength="512" />
            <button class="btn btn-ghost">Save note</button>
          </form>
          <form method="post" action="${action}/delete" class="inline"
                onsubmit="return confirm('Delete ${esc(p.variable)} and every version of it? This cannot be undone.')">
            <input type="hidden" name="path" value="${esc(p.path)}" />${nsField}
            <button class="btn btn-danger">Delete</button>
          </form>
        </span>
      </div>`;
    })
    .join("\n");

  const unreadable = opts.unreadable ?? [];
  const unreadableBanner = unreadable.length
    ? `<div class="flash flash-error">${unreadable.length} parameter${
        unreadable.length === 1 ? "" : "s"
      } in this project could not be read and may belong to this namespace, so the list below may be incomplete. Re-read the store to try again. ${esc(
        // Grouped by reason: a burst of 429s is one sentence and a list of
        // ids, not the same sentence once per parameter.
        [
          ...unreadable
            .reduce((by, u) => {
              by.set(u.reason, [...(by.get(u.reason) ?? []), u.id]);
              return by;
            }, new Map<string, string[]>())
            .entries(),
        ]
          .map(([reason, ids]) => `${ids.join(", ")}: ${reason}`)
          .join(" "),
      )}</div>`
    : "";

  const listing = opts.listFailure
    ? `<div class="state">
         <div class="state-icon">${KEY_SVG}</div>
         <p class="state-title">Could not read this namespace</p>
         <p class="state-sub">The store did not answer, so this is not an empty namespace — it is an unread one. Re-read the store to try again. Detail: ${esc(opts.listFailure)}</p>
       </div>`
    : parameters.length
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
         <p class="state-sub">Add one above. Agents can see a parameter's name, kind and note — and, for a non-secret parameter, its value; never a secret value.</p>
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
<nav class="breadcrumb" aria-label="Breadcrumb"><a href="/connectors" class="crumb">connectors</a><span class="crumb-sep">/</span><span class="crumb crumb-current">${esc(slug)}</span></nav>
${siblingStrip(opts.siblingPages)}

<section class="browse-head">
  <div class="stat"><span class="stat-n">${opts.listFailure ? "—" : parameters.length}</span><span class="stat-l">parameters</span></div>
  <div class="stat"><span class="stat-n">${opts.listFailure ? "—" : secretCount}</span><span class="stat-l">secret</span></div>
  ${storePicker(action, view.stores, store)}
  ${namespacePicker(action, store.namespaces, ns, store.projectId)}
  ${
    view.stores.length > 1
      ? ""
      : `<div class="scope">
    <span class="scope-l">project</span><code>${esc(store.projectId)}</code>
  </div>`
  }
  <form method="post" action="${action}/refresh" class="inline reread-form"
        title="This console holds one reading of the store for ${Math.round(CONSOLE_SNAPSHOT_TTL_MS / 60_000)} minutes, and the gateway's resolver for gateway.secrets.ttlSeconds (${config.gateway.secrets.ttlSeconds}s). A write through this console shows at once; a value written outside strad lands within those on its own. This drops both readings so the next read reaches Parameter Manager now. Nothing is written.${
          opts.readAt === undefined
            ? ""
            : ` This reading was taken ${Math.max(0, Math.round((Date.now() - opts.readAt) / 60_000))} min ago.`
        }">
    ${nsField}
    <button class="btn">Re-read the store</button>
  </form>
</section>

${deliveryBanner(config, resolver)}
${driftBanner(revealUi)}
${flash}
${unreadableBanner}
${reveal}
<section class="addbox">
  <h2 class="addbox-title">Add a parameter</h2>
  <form method="post" action="${action}/create" class="addform">
    ${nsField}
    <div class="field">
      <span class="field-l">Namespace</span>
      <code class="pathpart">${esc(ns)}</code>
      <span class="field-h">${
        store.namespacesStrict
          ? "Pick one above. This store is strict: a namespace outside its configured list is refused on create."
          : "Type or pick one above; the suggestions are a convenience, not a limit."
      }</span>
    </div>
    <div class="field">
      <label class="field-l" for="pfx">Path prefix <span class="field-opt">optional</span></label>
      ${comboBox({
        id: "pfx",
        name: "prefix",
        placeholder: examplePrefix(config),
        options: prefixOptions(config),
        listLabel: "Server prefixes on this gateway",
        emptyNote:
          "No server prefix matches. Any prefix is still allowed — it simply routes to nothing.",
        describedBy: "pfx-help",
      })}
      <span class="field-h" id="pfx-help">The segments between the namespace and the variable name. For a
        server parameter this is <code>&lt;server-slug&gt;/static/</code> and it is what decides
        which server the value routes to.</span>
    </div>
    <label class="field">
      <span class="field-l">Variable name</span>
      <input class="in" id="varname" type="text" name="variable" required autocapitalize="off" autocomplete="off"
             pattern="${ENV_NAME_SOURCE}" placeholder="${esc(exampleVariable(config))}" />
      <span class="field-h">A valid environment variable name.</span>
    </label>
    <div class="field">
      <span class="field-l">Full path</span>
      <code class="pathpart pathpreview" id="pathpreview">${esc(ns)}&lt;VARIABLE&gt;</code>
    </div>
    <label class="field field-check">
      <input type="checkbox" name="secret" />
      <span><span class="field-l">Secret</span> <span class="field-h">Tick for a credential (private key, token). See the guide under Help.</span></span>
    </label>
    <label class="field">
      <span class="field-l">Note <span class="field-opt">optional</span></span>
      <input class="in" type="text" name="note" maxlength="512"
             placeholder="What is this for? Who issued it? When should it rotate?" />
      <span class="field-h">Agents CAN read this note, for either kind.</span>
    </label>
    <div class="field value-field">
      <label class="field-l" for="addvalue">Value</label>
      <textarea class="in in-value in-masked" id="addvalue" name="value" rows="4" required spellcheck="false" data-gramm="false" data-enable-grammarly="false"
                autocapitalize="off" autocomplete="off" aria-describedby="addvalue-help"></textarea>
      <span class="field-h" id="addvalue-help">Multi-line values (a PEM key) are kept as pasted.
        <label class="value-show"><input type="checkbox" class="value-show-box" /> show</label></span>
    </div>
    <button class="btn btn-primary">Create parameter</button>
  </form>
</section>
${bulkBox(action, nsField, ns, store.namespacesStrict, config, opts.bulk)}
${listing}

${pathPreviewScript(ns)}
${comboBoxScript()}
${bulkClientScript(
  ns,
  parameters.map((p) => p.path),
)}`;

  return layout({
    title: `${slug} · parameters`,
    serverSlug: slug,
    signedInAs: opts.signedInAs,
    body,
    nav: "connectors",
    helpTitle: "Parameters guide",
    help: secretsGuide(
      config,
      slug,
      ns,
      store.namespaces,
      resolver,
      revealUi,
      store.projectId,
    ),
  });
}

/**
 * The store picker: which parameter store this page is showing.
 *
 * A `<select>`, deliberately — and the contrast with the namespace field one
 * function below is the reason to say so. A namespace is FREE TEXT because every
 * namespace in a project is addressable and the configured list is only a set of
 * suggestions. A store is not: the set is CLOSED at exactly the entries the
 * config declares, because each one carries its own admin service account and
 * there is no credential with which to reach a project nobody listed. A combobox
 * would invite typing an id that cannot resolve.
 *
 * Rendered only when there is a choice to make. One store is the shape every
 * config had before `consoleStores:`, and a one-option dropdown on that page
 * would be a control that does nothing.
 *
 * A plain GET form, so switching is an ordinary navigation the SSO gate already
 * covers and the result is linkable. `ns` is deliberately NOT carried across:
 * namespaces belong to a store, and forwarding one store's namespace into
 * another would select a prefix that store does not manage — the landing
 * namespace is the new store's own first one.
 */
function storePicker(
  action: string,
  stores: SecretsStore[],
  selected: SecretsStore,
): string {
  if (stores.length <= 1) return "";
  const options = stores
    .map(
      (s) =>
        `<option value="${esc(s.projectId)}"${
          s.projectId === selected.projectId ? " selected" : ""
        }>${esc(s.label)}${
          s.label === s.projectId ? "" : ` · ${esc(s.projectId)}`
        }</option>`,
    )
    .join("");
  return `
  <form class="storeform" method="get" action="${action}">
    <label class="scope-l" for="store-input">store</label>
    <select class="in in-select" id="store-input" name="project" onchange="this.form.submit()">
      ${options}
    </select>
    <noscript><button class="btn nsgo">Go</button></noscript>
  </form>`;
}

/**
 * The other secrets pages on this gateway, under the breadcrumb.
 *
 * The index lists every page, but a reader who lands on one directly — a
 * bookmark, a link out of `open_secrets_manager` — sees only this page's
 * namespaces and nothing saying there are others. "Why can't I see namespace X
 * here?" was asked twice on one deployment by someone on the right console and
 * the wrong page. The strip is the answer on the page the question is asked on.
 *
 * It names a sibling by slug, and each of its stores by project and namespaces:
 * what the reader would see by opening it, and nothing more. A project links to
 * its own store when the sibling fronts several, so the click lands where the
 * namespace is rather than on that page's first store.
 *
 * Nothing at all on a gateway with one secrets page. "The others:" followed by
 * nothing is a sentence with no content, and the breadcrumb already leads back
 * to the index.
 */
function siblingStrip(siblings: SecretsPageSummary[]): string {
  if (siblings.length === 0) return "";
  const items = siblings
    .map((page) => {
      const href = serverConsolePath(page.slug);
      const stores = page.stores
        .map((s) => {
          const project = s.projectId
            ? page.stores.length > 1
              ? `<a class="sibling-project" href="${href}?project=${encodeURIComponent(s.projectId)}"><code>${esc(s.projectId)}</code></a>`
              : `<code>${esc(s.projectId)}</code>`
            : "";
          const namespaces = s.namespaces
            .map((n) => `<span class="sibling-ns">${esc(n)}</span>`)
            .join("");
          return `<span class="sibling-store">${project}${namespaces}</span>`;
        })
        .join("");
      return `
    <li class="sibling"><a class="sibling-slug" href="${href}">${esc(page.slug)}</a>${
      page.enabled ? "" : `<span class="chip chip-off">disabled</span>`
    }${stores}</li>`;
    })
    .join("");
  return `<nav class="siblings" aria-label="Other secrets pages on this gateway">
  <p class="siblings-l">One of ${siblings.length + 1} secrets pages on this gateway. A namespace that is not on this page may be on another:</p>
  <ul class="sibling-list">${items}
  </ul>
</nav>`;
}

/**
 * The namespace field: free text, with `SECRETS_NAMESPACES` offered as
 * suggestions.
 *
 * A plain GET form, so switching is an ordinary navigation the SSO gate already
 * covers and the result is linkable. The suggestions are a convenience; what
 * bounds the value is its SHAPE (see validateNamespace) and, underneath that,
 * the project the credential is scoped to. Hence a combobox rather than a
 * `<select>` — see comboBox for what that costs and buys.
 */
function namespacePicker(
  action: string,
  namespaces: string[],
  selected: string,
  projectId: string,
): string {
  return `
  <form class="nsform" method="get" action="${action}">
    <input type="hidden" name="project" value="${esc(projectId)}" />
    <label class="scope-l" for="ns-input">namespace</label>
    ${comboBox({
      id: "ns-input",
      name: "ns",
      value: selected,
      placeholder: "/strad/prod/mcp/",
      options: namespaces.map((n) => ({ value: n })),
      listLabel: "Suggested namespaces",
      emptyNote:
        "No suggestion matches. Any namespace in this project is still valid.",
      submitOnChoose: true,
      wrapClass: "combo-ns",
    })}
    <button class="btn nsgo">Go</button>
  </form>`;
}

// ---------------------------------------------------------------------------
// The combobox: a dropdown you can also type into.
// ---------------------------------------------------------------------------

export interface ComboOption {
  value: string;
  /** Secondary text shown under the value in the menu. */
  label?: string;
}

interface ComboBoxOptions {
  /** The input's id. The listbox and datalist ids are derived from it. */
  id: string;
  name: string;
  value?: string;
  placeholder?: string;
  options: ComboOption[];
  /** Accessible name for the popup listbox, and for the caret that opens it. */
  listLabel: string;
  /** Shown under the menu when nothing matches what was typed. */
  emptyNote: string;
  /** Choosing an option submits the owning form. For a GET navigation only. */
  submitOnChoose?: boolean;
  /** Id of the element describing this field, for `aria-describedby`. */
  describedBy?: string;
  wrapClass?: string;
}

/**
 * A free-text input whose suggestions open as a DROPDOWN, not a typeahead.
 *
 * A native `<datalist>` only reveals itself once you type, so a field backed by
 * one cannot tell you that a set of known values exists — you have to already
 * know what to type in order to discover what you could have typed. A `<select>`
 * would fix the discovery and break the field: every namespace in the project is
 * addressable, not just the configured suggestions, and the same is true of a
 * path prefix. So: click or focus opens the whole list, typing filters it, and
 * anything you type is still submittable.
 *
 * PROGRESSIVE ENHANCEMENT. The markup is an ordinary `<input list=…>` and a
 * `<datalist>`, so with no JS the field is free text with the native typeahead
 * and the caret and menu are hidden. The script removes `list=` from the input as
 * it takes over, and it is also what puts the combobox ARIA on: a `role=combobox`
 * whose `aria-expanded` nothing can ever flip would announce a control that is
 * not there. A field with no suggestions is rendered as the plain input it is.
 */
function comboBox(o: ComboBoxOptions): string {
  const listId = `${o.id}-listbox`;
  const dataId = `${o.id}-options`;
  const described = o.describedBy
    ? ` aria-describedby="${esc(o.describedBy)}"`
    : "";
  const input = (extra: string) =>
    `<input class="in" id="${esc(o.id)}" type="text" name="${esc(o.name)}"
             value="${esc(o.value ?? "")}"${described}${extra}
             autocapitalize="off" autocomplete="off" spellcheck="false"
             placeholder="${esc(o.placeholder ?? "")}" />`;

  if (!o.options.length) return input("");

  const options = o.options
    .map(
      (op, i) =>
        `<li class="combo-opt" role="option" id="${esc(o.id)}-o${i}" data-value="${esc(op.value)}"><span class="combo-val">${esc(op.value)}</span>${
          op.label ? `<span class="combo-lbl">${esc(op.label)}</span>` : ""
        }</li>`,
    )
    .join("");
  const suggestions = o.options
    .map(
      (op) =>
        `<option value="${esc(op.value)}"${op.label ? ` label="${esc(op.label)}"` : ""}></option>`,
    )
    .join("");
  const wrap = ["combo", o.wrapClass].filter(Boolean).join(" ");
  return `<div class="${esc(wrap)}" data-combo${o.submitOnChoose ? " data-combo-submit" : ""}>
      ${input(` list="${esc(dataId)}"`)}
      <button class="combo-caret" type="button" tabindex="-1" data-combo-toggle
              aria-label="${esc(o.listLabel)}">${CARET_SVG}</button>
      <ul class="combo-menu" id="${esc(listId)}" role="listbox" aria-label="${esc(o.listLabel)}" hidden>${options}</ul>
      <p class="combo-none" role="status" hidden>${esc(o.emptyNote)}</p>
      <datalist id="${esc(dataId)}">${suggestions}</datalist>
    </div>`;
}

/**
 * The one script that drives every combobox on the page.
 *
 * Keyboard is the whole reason this is more than a click handler: `ArrowDown`
 * opens and walks the list, `Enter` takes the active option, `Escape` closes it
 * and — pressed again — puts back the last value the field committed, so
 * dismissing the menu never costs you the namespace you were on.
 * `aria-activedescendant` moves
 * the assistive-technology cursor without touching what you typed, which is also
 * why restoring is possible at all.
 *
 * A programmatic change dispatches `input`, because the full-path preview listens
 * for it (see pathPreviewScript) and a value set by a click must reach it.
 */
function comboBoxScript(): string {
  return `<noscript><style>.combo-caret{display:none}</style></noscript>
<script>
(function () {
  Array.prototype.forEach.call(document.querySelectorAll("[data-combo]"), init);

  function init(box) {
    var input = box.querySelector("input");
    var menu = box.querySelector("[role=listbox]");
    var toggle = box.querySelector("[data-combo-toggle]");
    var none = box.querySelector(".combo-none");
    if (!input || !menu) return;
    var opts = Array.prototype.slice.call(menu.querySelectorAll("[role=option]"));
    if (!opts.length) return;

    var submits = box.hasAttribute("data-combo-submit");
    var active = -1;
    var committed = input.value;
    var quiet = false;

    // Our menu replaces the native one; leaving both would double the popup. The
    // ARIA goes on here, with the behaviour it describes.
    input.removeAttribute("list");
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-controls", menu.id);
    input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-expanded", "false");
    markCurrent();

    function shown() {
      return opts.filter(function (o) { return !o.hidden; });
    }
    function isOpen() {
      return box.hasAttribute("data-open");
    }
    function markCurrent() {
      opts.forEach(function (o) {
        o.classList.toggle("is-current", o.getAttribute("data-value") === committed);
      });
    }
    /** The menu is shown only when open AND something matches; else the note is. */
    function paint() {
      var any = shown().length !== 0;
      menu.hidden = !isOpen() || !any;
      if (none) none.hidden = !isOpen() || any;
      input.setAttribute("aria-expanded", menu.hidden ? "false" : "true");
    }
    function filter(term) {
      var q = term.trim().toLowerCase();
      opts.forEach(function (o) {
        var v = o.getAttribute("data-value").toLowerCase();
        o.hidden = q !== "" && v.indexOf(q) === -1;
      });
      paint();
    }
    function open(all) {
      box.setAttribute("data-open", "");
      filter(all ? "" : input.value);
      setActive(-1);
    }
    function close() {
      box.removeAttribute("data-open");
      paint();
      setActive(-1);
    }
    function setActive(i) {
      var list = shown();
      opts.forEach(function (o) {
        o.classList.remove("is-active");
        o.removeAttribute("aria-selected");
      });
      active = i < 0 || i >= list.length ? -1 : i;
      if (active < 0) {
        input.removeAttribute("aria-activedescendant");
        return;
      }
      var el = list[active];
      el.classList.add("is-active");
      el.setAttribute("aria-selected", "true");
      input.setAttribute("aria-activedescendant", el.id);
      if (el.scrollIntoView) el.scrollIntoView({ block: "nearest" });
    }
    function move(delta) {
      var list = shown();
      if (!list.length) return;
      if (!isOpen()) { open(true); }
      list = shown();
      var next = active < 0
        ? (delta > 0 ? 0 : list.length - 1)
        : (active + delta + list.length) % list.length;
      setActive(next);
    }
    function setValue(v) {
      quiet = true;
      input.value = v;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      quiet = false;
    }
    function choose(el) {
      setValue(el.getAttribute("data-value"));
      committed = input.value;
      markCurrent();
      close();
      input.focus();
      if (submits && input.form) {
        if (input.form.requestSubmit) input.form.requestSubmit();
        else input.form.submit();
      }
    }

    input.addEventListener("focus", function () { if (!isOpen()) open(true); });
    // Focus alone cannot carry this: a field that is already focused fires no
    // focus event, so a click after Escape would do nothing at all.
    input.addEventListener("mousedown", function (e) {
      if (e.button !== 0) return;
      if (isOpen()) close();
      else open(true);
    });
    input.addEventListener("input", function () {
      if (quiet) return;
      open(false);
    });
    input.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown") { e.preventDefault(); move(1); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); move(-1); return; }
      if (e.key === "Enter") {
        var list = shown();
        if (isOpen() && active >= 0 && list[active]) {
          e.preventDefault();
          choose(list[active]);
        }
        return;
      }
      if (e.key === "Home" && isOpen()) { e.preventDefault(); setActive(0); return; }
      if (e.key === "End" && isOpen()) {
        e.preventDefault();
        setActive(shown().length - 1);
        return;
      }
      if (e.key === "Escape") {
        // First Escape dismisses the menu; a second puts back the last value
        // this field committed, so neither costs you where you were.
        if (isOpen()) close();
        else if (input.value !== committed) setValue(committed);
        return;
      }
      if (e.key === "Tab") close();
    });

    // mousedown on the menu would blur the input before the click lands.
    menu.addEventListener("mousedown", function (e) { e.preventDefault(); });
    menu.addEventListener("click", function (e) {
      var el = e.target.closest ? e.target.closest("[role=option]") : null;
      if (el) choose(el);
    });
    if (toggle) {
      // Keep focus on the input: a caret that stole it would blur the field and
      // then re-open the menu through the focus handler it just closed.
      toggle.addEventListener("mousedown", function (e) { e.preventDefault(); });
      toggle.addEventListener("click", function () {
        if (isOpen()) close();
        else { input.focus(); open(true); }
      });
    }
    document.addEventListener("mousedown", function (e) {
      if (isOpen() && !box.contains(e.target)) close();
    });
  }
})();
</script>`;
}

/** The chip that says whether anything reads a path. */
function deliveryChip(routing: Routing): string {
  const cls =
    routing.state === "delivered"
      ? "chip-ok"
      : routing.state === "not-wired"
        ? "chip-warnish"
        : "chip-off";
  return `<span class="chip ${cls} chip-route" title="${esc(routing.detail)}">${esc(routing.label)}</span>`;
}

/**
 * The one thing that must be visible WITHOUT opening an accordion.
 *
 * Everything else on this page is progressive disclosure. This is not, because
 * the failure it prevents — storing a credential that reaches nothing and
 * believing you configured a server — is silent, and a human who never opens the
 * accordion is exactly the human it happens to.
 */
function deliveryBanner(config: StradConfig, resolver: boolean): string {
  const consumers = paramsConsumers(config);
  const total = config.servers.filter(
    (s) => s.enabled && !isUnhosted(s),
  ).length;

  // Two independent conditions, and the banner must not claim delivery on the
  // strength of one. `params: true` with no resolver credential behind it is a
  // no-op: render-spec warns and ships the component without those values.
  const status = !consumers.length
    ? `<strong>No server on this gateway reads a managed parameter</strong> — none sets
       <code>params: true</code>, and none references a <code>\${NAME}</code> under
       <code>env:</code> — so nothing stored here is delivered to a running MCP server:
       this is a registry. Wiring a server up is a config change plus a deploy.`
    : !resolver
      ? `${consumers.length} of ${total} servers read a managed parameter (${consumers
          .map((c) => `<code>${esc(c.slug)}</code>`)
          .join(
            ", ",
          )}), but <strong>this deployment carries no resolver credential</strong>
         (<code>STRAD_PARAMS_*</code>), so none of it is resolved and nothing stored here reaches
         a running MCP server — this is a registry.`
      : `<strong>${consumers.length} of ${total}</strong> servers on this gateway consume managed
         parameters: ${consumers
           .map((c) => `<code>${esc(c.slug)}</code>`)
           .join(", ")}. A path outside those is a registry entry only.`;

  return `<p class="posture posture-warn">
  Storing a parameter here does not, by itself, send it anywhere. ${status}
</p>`;
}

/**
 * The reveal posture, when it is not simply "on and permitted".
 *
 * Shown outside the accordions in exactly one case beyond the ordinary: DRIFT,
 * where the flag and the credential disagree. That is a claim about what this
 * deployment can do rather than what it offers, and a reader who never opens an
 * accordion should still not come away with a wrong model of it.
 */
/**
 * The ONE reveal case that stays on the page: DRIFT.
 *
 * The ordinary "not offered" states are a product decision and belong in the
 * guide with everything else. Drift is different — it is a claim about what this
 * deployment CAN do rather than what it offers, and a reader who never opens the
 * guide should still not come away with a wrong model of their own blast radius.
 * That is the same test `deliveryBanner` passes, and the reason both survive on a
 * page that is otherwise chrome-free: each appears only when something is wrong.
 */
function driftBanner(reveal: RevealPosture): string {
  if (reveal.allowed || !reveal.drift) return "";
  return `<p class="posture posture-warn posture-reveal">
  <strong>Reveal is hidden, not impossible.</strong> ${esc(reveal.detail)}
</p>`;
}

function revealStatus(reveal: RevealPosture): string {
  return reveal.allowed
    ? `<li><b>Reveal</b> <span class="ex-ok">available</span> — the flag is on and this
         console's service account may read a secret value.</li>`
    : `<li><b>Reveal</b> <span class="ex-no">${esc(reveal.label)}</span> — ${esc(reveal.detail)}</li>`;
}

/**
 * Every explanation on this page, collapsed.
 *
 * Progressive disclosure is the requirement, and it is also the honest shape:
 * the routing rules are genuinely intricate, and a human rotating a value they
 * already understand should not have to scroll past them.
 */
function secretsGuide(
  config: StradConfig,
  slug: string,
  namespace: string,
  namespaces: string[],
  resolver: boolean,
  reveal: RevealPosture,
  projectId: string,
): string {
  const env = config.gateway.env;
  const consumers = paramsConsumers(config);
  // Prefer a `params: true` consumer for the worked example: it is the shape
  // the guide is explaining, and an `env-ref` consumer's namespace only answers
  // for names its config already writes — a poor "store anything here" example.
  // Prefer a `params: true` consumer for the worked example: it is the shape the
  // guide explains, and an `env-ref` consumer's namespace only answers for names
  // its config already writes — a poor "store anything here" example.
  const candidate = consumers.find((c) => c.via === "params") ?? consumers[0];
  const wired = resolver ? candidate : undefined;
  // Prefer a supplementary image for the counter-example: it is the shape a
  // human is most likely to be storing a credential for, and its alternative to
  // `params: true` (a hand-written `env:` entry) is the one worth naming.
  const reading = new Set(consumers.map((c) => c.slug));
  const unwiredCandidates = config.servers.filter(
    (s) =>
      s.enabled && !isUnhosted(s) && !reading.has(s.slug) && s.slug !== slug,
  );
  const unwired =
    unwiredCandidates.find((s) => s.kind === "supplementary-image") ??
    unwiredCandidates[0];

  const wiredExample = wired
    ? `<li>
         <code>/strad/${esc(env)}/mcp/${esc(wired.slug)}/static/EXAMPLE_TOKEN</code>
         <span class="ex-ok">reaches the <code>${esc(wired.slug)}</code> server</span>
         <span class="ex-why">It ${
           wired.via === "params"
             ? "sets <code>params: true</code>"
             : "references that name under <code>env:</code>"
         }, so ${
           wired.when === "deploy"
             ? "<code>render-spec</code> resolves this path at deploy time and injects it onto that container — a new value lands on the next deploy"
             : `it is resolved in-process at runtime and refreshed within ${config.gateway.secrets.ttlSeconds}s`
         }.</span>
       </li>`
    : `<li>
         <code>/strad/${esc(env)}/mcp/${esc(candidate?.slug ?? "&lt;server&gt;")}/static/EXAMPLE_TOKEN</code>
         <span class="ex-no">reaches nothing on this gateway</span>
         <span class="ex-why">${
           candidate
             ? `<code>${esc(candidate.slug)}</code> ${
                 candidate.via === "params"
                   ? "sets <code>params: true</code>"
                   : "references a <code>${NAME}</code> under <code>env:</code>"
               }, but this deployment
                carries no resolver credential, so the value is never fetched and never injected.`
             : `No server here reads a managed parameter, so there is no
                <code>&lt;server&gt;</code> for which this example would be delivered.`
         }</span>
       </li>`;

  const unwiredExample = unwired
    ? `<li>
         <code>/strad/${esc(env)}/mcp/${esc(unwired.slug)}/static/EXAMPLE_TOKEN</code>
         <span class="ex-no">stored, delivered nowhere</span>
         <span class="ex-why"><code>${esc(unwired.slug)}</code> does not set <code>params: true</code>;
           it takes its configuration from the <code>${
             unwired.kind === "builtin" ? "options:" : "env:"
           }</code> map in strad's config instead. The value sits here, listed and rotatable, and no
           process reads it.</span>
       </li>`
    : "";

  const gatewayDelivered =
    config.gateway.secrets.provider !== "env" && resolver;

  return `
<div class="helpstack">
  <details class="acc" open>
    <summary>This deployment, right now</summary>
    <div class="acc-body">
      <p>Everything below is read from the running config and from what Google says this
        console's credential may do — not from documentation that could have gone stale.</p>
      <ul class="nslist">
        <li><b>Project</b> <code>${esc(projectId)}</code> — the real fence. A namespace is a
          path prefix inside it, and the project's IAM bindings are the blast radius.</li>
        <li><b>Browsing</b> <code>${esc(namespace)}</code></li>
        <li><b>Suggested namespaces</b> ${
          namespaces.length
            ? namespaces.map((n) => `<code>${esc(n)}</code>`).join(" ")
            : '<span class="ex-no">none configured</span>'
        } — a convenience only; you may type any namespace in this project.</li>
        <li><b>Parameter delivery</b> ${
          !consumers.length
            ? `<span class="ex-no">nothing is delivered</span> — no server here sets <code>params: true</code>.`
            : !resolver
              ? `<span class="ex-no">nothing is delivered</span> — ${consumers.length} server(s) set
                 <code>params: true</code>, but this deployment carries no resolver credential
                 (<code>STRAD_PARAMS_*</code>).`
              : `<span class="ex-ok">${consumers.length} server(s)</span> consume managed parameters:
                 ${consumers.map((c) => `<code>${esc(c.slug)}</code>`).join(", ")}.`
        }</li>
        ${revealStatus(reveal)}
      </ul>
    </div>
  </details>

  <details class="acc" open>
    <summary>How a parameter here routes into strad</summary>
    <div class="acc-body">
      <p>A parameter is addressed by one canonical path, and every segment of it does work:</p>
      <pre class="acc-code"><span class="seg-ns">/strad/${esc(env)}/mcp/</span><span class="seg-pfx">&lt;server-slug&gt;/static/</span><span class="seg-var">&lt;VARIABLE_NAME&gt;</span></pre>
      <p class="seglegend"><span class="seg-ns">namespace</span> ·
        <span class="seg-pfx">path prefix</span> ·
        <span class="seg-var">variable</span></p>
      <p>The <b>namespace</b> is where a parameter lives inside the project. The <b>path prefix</b>
        is the routing key: <code>&lt;server-slug&gt;/static/</code> names the MCP server that will
        resolve the value. The <b>variable</b> becomes the environment variable that server's
        process runs with.</p>
      <p>Three things must all be true before a value reaches a server:</p>
      <ol>
        <li>The path sits under <code>/strad/${esc(env)}/mcp/&lt;server-slug&gt;/static/</code>.
          Nothing outside that prefix is read. Everything under it is, and resolution keys on the
          path's <em>last</em> segment — so extra depth still arrives, under that last name, and
          two such paths ending in the same name collide.</li>
        <li>That server's entry in strad's config sets <code>params: true</code>. Without it the
          server never asks the store for anything, and the value is stored and unread.</li>
        <li>The deployment holds the <em>resolver</em> credential (<code>STRAD_PARAMS_*</code>) —
          a third identity, distinct from this console's admin key and from the MCP server's
          viewer key. Without it, <code>params: true</code> resolves to nothing and the deploy
          says so.</li>
      </ol>
      <p><b>When</b> depends on the server kind. A supplementary image's parameters are resolved
        at <b>deploy</b> time and baked onto its container, so a rotation needs a redeploy of that
        component. A builtin, which runs a strad image, resolves at <b>runtime</b>, refreshed within
        <code>gateway.secrets.ttlSeconds</code> (${config.gateway.secrets.ttlSeconds}s).</p>
      <p>The second namespace shape, <code>/strad/${esc(env)}/gateway/static/&lt;NAME&gt;</code>,
        is not a server's environment — it backs the <code>\${NAME}</code> references the config
        makes outside any one server. ${
          gatewayDelivered
            ? `This gateway reads it at runtime (<code>gateway.secrets.provider: ${esc(config.gateway.secrets.provider)}</code>) — a name is read only if some config value actually references it.`
            : `This gateway runs <code>gateway.secrets.provider: env</code>, so it resolves <code>\${NAME}</code> from its process environment; a value here is deploy-time input at most.`
        }</p>
      <p class="acc-foot">Every row on the page carries a chip computed from this gateway's live
        config — <span class="chip chip-ok chip-route">delivered</span> means a server is wired to
        read that exact path, <span class="chip chip-warnish chip-route">not wired</span> means it
        is stored and nothing reads it.</p>
    </div>
  </details>

  <details class="acc" open>
    <summary>Examples, from this gateway's own servers</summary>
    <div class="acc-body">
      <ul class="exlist">
        ${wiredExample}
        ${unwiredExample}
        <li>
          <code>/strad/${esc(env)}/gateway/static/EXAMPLE_TOKEN</code>
          <span class="${gatewayDelivered ? "ex-ok" : "ex-no"}">${
            gatewayDelivered
              ? "resolves <code>${EXAMPLE_TOKEN}</code> in the config at runtime"
              : "not read at runtime on this gateway"
          }</span>
          <span class="ex-why">The gateway namespace backs config-level
            <code>\${NAME}</code> references — a remote server's bearer token, a builtin's option —
            rather than one server's environment.</span>
        </li>
        <li>
          <code>${esc(namespace)}EXAMPLE_TOKEN</code>
          <span class="ex-no">stored, delivered nowhere</span>
          <span class="ex-why">No path prefix, so it names no server. This is the shape you get
            by leaving the prefix field empty; it is fine for a credential you only want recorded,
            and wrong for one you expect a server to pick up.</span>
        </li>
      </ul>
    </div>
  </details>

  <details class="acc">
    <summary>Secret vs non-secret, and what an agent can see</summary>
    <div class="acc-body">
      <p><b>Parameter Manager indexes everything; Secret Manager backs the secret parts.</b>
        Tick <em>Secret</em> for a credential — a private key, a token. Its value goes to Secret
        Manager and Parameter Manager holds only a reference to it. Leave it unticked for
        configuration — a service-account email, a bucket name — which lives in Parameter Manager
        as a literal.</p>
      <p>The <code>${esc(slug)}</code> MCP server runs as a <em>viewer</em> service account: it can
        list parameters, their notes and versions, and read <em>non-secret</em> values. It holds no
        <code>secretmanager.versions.access</code>, so no tool, bug or prompt injection can pull a
        <em>secret</em> value through <code>/mcp</code> — Google refuses the call, rather than this
        code declining it.</p>
      <p>Adding, rotating and deleting happen on this page, as a human, behind SSO, with a
        different admin credential the MCP container never sees. Notes are readable by agents for
        both kinds — that is what makes them useful, and why a note should not contain a value.</p>
      <p><b>Revealing</b> is a separate decision, and it is two of them. A deployment opts in with
        <code>SECRETS_REVEAL_ENABLED</code>, and the console's service account must hold
        <code>secretmanager.versions.access</code>. The flag decides what this page offers; IAM
        decides what is possible; both must agree, and the narrower one wins. ${
          reveal.allowed
            ? "On this deployment both say yes, so a secret value can be displayed once, to a human, on an explicit click."
            : esc(reveal.detail)
        }</p>
    </div>
  </details>

  <details class="acc">
    <summary>Namespaces, and where the fence actually is</summary>
    <div class="acc-body">
      <p>A namespace is a path prefix inside the project. <code>SECRETS_NAMESPACES</code> seeds
        the suggestions this console offers — it does not bound what you may address, because a
        list checked in code sits over the same credential the console already holds. You may
        type any namespace in this project. Suggested here:</p>
      <ul class="nslist">${namespaceList(namespaces, namespace)}</ul>
      <p><b>The project is the boundary</b>, and it is the only one: point this console at a
        project that holds only these parameters, so its admin credential cannot reach strad's own
        deployment secrets even in principle. The <em>MCP</em> half is scoped differently and
        harder — <code>SECRETS_NAMESPACES</code> there is a hard fence, because an agent is not an
        operator.</p>
    </div>
  </details>
</div>`;
}

/** The suggested namespaces. The one being browsed is marked when it is among them. */
function namespaceList(namespaces: string[], selected: string): string {
  return namespaces
    .map(
      (n) =>
        `<li><code>${esc(n)}</code>${
          n === selected ? ` <span class="ex-ok">currently browsing</span>` : ""
        }</li>`,
    )
    .join("");
}

/** Suggestions: every server slug, flagged with whether it is wired. */
function prefixOptions(config: StradConfig): ComboOption[] {
  return prefixSuggestions(config).map((s) => ({
    value: s.prefix,
    label: s.wired
      ? `${s.slug} — ${s.via === "params" ? "params: true" : "env: ${NAME}"}`
      : `${s.slug} — not wired`,
  }));
}

/** A prefix worth showing as a placeholder: a wired server if one exists. */
function examplePrefix(config: StradConfig): string {
  const consumers = paramsConsumers(config);
  const first = consumers.find((c) => c.via === "params") ?? consumers[0];
  if (first) return first.prefix;
  const any = prefixSuggestions(config)[0];
  return any ? any.prefix : "";
}

function exampleVariable(config: StradConfig): string {
  const consumers = paramsConsumers(config);
  const slug = (consumers.find((c) => c.via === "params") ?? consumers[0])
    ?.slug;
  if (!slug) return "EXAMPLE_API_TOKEN";
  return `${slug.toUpperCase().replace(/-/g, "_")}_API_TOKEN`;
}

/**
 * The full-path preview.
 *
 * Progressive enhancement: without JS the field still shows the composition with
 * a `<VARIABLE>` placeholder, and the server composes the same path either way.
 * With JS it updates as you type, which is the point — "which path am I about to
 * write" is the question this whole page exists to answer.
 */
function pathPreviewScript(namespace: string): string {
  return `<script>
(function () {
  var ns = ${jsonForScript(namespace)};
  var pfx = document.getElementById("pfx");
  var name = document.getElementById("varname");
  var out = document.getElementById("pathpreview");
  if (!pfx || !name || !out) return;
  function norm(v) {
    var t = v.trim().replace(/^\\/+/, "").replace(/\\/+$/, "");
    return t === "" ? "" : t + "/";
  }
  function update() {
    out.textContent = ns + norm(pfx.value) + (name.value.trim() || "<VARIABLE>");
  }
  pfx.addEventListener("input", update);
  name.addEventListener("input", update);
  update();
})();
</script>`;
}

/**
 * Bulk add: many creates from one block of CSV, with a row editor on top.
 *
 * The TEXTAREA is what is submitted, always, so the form works with no JS at
 * all: paste, submit, read the per-line report. With JS the same textarea
 * becomes one of two views — "Rows", an editable row per parameter with a
 * Duplicate control on each, and "CSV", the raw text — and a live preview
 * checks every line before the button lights. Rows are written back into the
 * textarea on submit, so the server only ever parses one format.
 *
 * VALUES. A row's value is a masked textarea, so a multi-line value (a PEM
 * key) pastes into a row intact. The preview masks a secret value
 * as the table does with reveal off; a non-secret one is shown, as agents can
 * read it anyway. Neither leaves the page until submit, and nothing the server
 * sends back contains one — the refilled lines have their values blanked.
 */
function bulkBox(
  action: string,
  nsField: string,
  ns: string,
  strict: boolean,
  config: StradConfig,
  report: BulkReport | undefined,
): string {
  const example = examplePrefix(config) || "my-server/static/";
  const sample = [
    `${example},API_TOKEN,secret,tok_123,Issued by the vendor console`,
    `${example},API_BASE_URL,plain,https://api.example.com`,
    `${example},CLIENT_LIST,secret,"a,b,c","Quoted: it has commas"`,
  ].join("\n");
  const options = prefixOptions(config)
    .map(
      (o) =>
        `<option value="${esc(o.value)}">${esc(o.label ?? o.value)}</option>`,
    )
    .join("");
  return `
<section class="addbox bulkbox" id="bulk">
  <h2 class="addbox-title">Add several parameters</h2>
  <p class="field-h bulk-lede">Every line lands in <code>${esc(ns)}</code>${
    strict ? ", and this store is strict" : ""
  }. Each one goes through the same create as the form above, and every line is
    checked before any line is written.</p>
  <form method="post" action="${action}/bulk" class="bulkform" id="bulk-form" autocomplete="off">
    ${nsField}
    <div class="bulk-tabs" id="bulk-tabs" hidden>
      <button type="button" class="btn bulk-tab" data-mode="rows" aria-pressed="true">Rows</button>
      <button type="button" class="btn bulk-tab" data-mode="csv" aria-pressed="false">CSV</button>
      <span class="field-h">Paste CSV into the CSV view; switch to Rows to edit it line by line.</span>
    </div>
    <div class="bulk-rows" id="bulk-rows" hidden>
      <div class="bulk-row bulk-row-head" aria-hidden="true">
        <span>#</span><span>path prefix</span><span>variable</span><span>secret</span><span>value</span><span>note</span><span></span>
      </div>
      <div id="bulk-rows-body"></div>
      <datalist id="bulk-prefixes">${options}</datalist>
      <button type="button" class="btn" id="bulk-add-row">+ Add row</button>
    </div>
    <div class="bulk-csv" id="bulk-csv-wrap">
      <textarea class="in bulk-text" id="bulk-csv" name="csv" rows="8" spellcheck="false"
        autocapitalize="off" autocomplete="off" placeholder="${esc(sample)}">${esc(report?.refill ?? "")}</textarea>
      <details class="bulk-format">
        <summary class="field-h">Format</summary>
        <p class="field-h">One parameter per line: <code>prefix,VARIABLE,kind,value,note</code>.</p>
        <ul class="field-h">
          <li><code>prefix</code> is the path prefix, as above — <code>&lt;server-slug&gt;/static/</code> for a server parameter. It may be empty.</li>
          <li><code>kind</code> is <code>secret</code> or <code>plain</code>. Empty means secret.</li>
          <li><code>note</code> is optional, and the column can be left off.</li>
          <li>A value or note with a comma, a quote or a line break goes in double quotes, with a quote inside written <code>""</code>: <code>"a,b"</code>, <code>"say ""hi"""</code>. Quoting also keeps a value's leading and trailing spaces.</li>
          <li>Blank lines, lines starting with <code>#</code>, and a first line of <code>prefix,variable,kind,…</code> are skipped.</li>
          <li>At most ${MAX_BULK_RECORDS} lines at once.</li>
        </ul>
      </details>
    </div>
    <div class="bulk-preview" id="bulk-preview" hidden aria-live="polite"></div>
    <div class="bulk-submit">
      <button class="btn btn-primary" id="bulk-submit">Create all</button>
      <span class="field-h" id="bulk-summary"></span>
    </div>
  </form>
  ${report && report.lines.length ? bulkReport(report) : ""}
</section>`;
}

/** The server's per-line answer to a bulk add. Paths and outcomes, no values. */
function bulkReport(report: BulkReport): string {
  const label: Record<string, string> = {
    created: "created",
    failed: "failed",
    invalid: "not valid",
    skipped: "not written",
  };
  const rows = report.lines
    .map(
      (l) => `<tr class="bulk-out-${l.status}${l.warn ? " bulk-out-warn" : ""}">
        <td class="bulk-n">${l.line}</td>
        <td><code>${esc(l.path || l.variable || "—")}</code></td>
        <td>${l.path || l.variable ? (l.secret ? `<span class="chip chip-secret">secret</span>` : `<span class="chip chip-plain">non-secret</span>`) : ""}</td>
        <td><span class="bulk-status">${esc(label[l.status] ?? l.status)}</span>${
          l.message ? ` <span class="bulk-msg">${esc(l.message)}</span>` : ""
        }</td>
      </tr>`,
    )
    .join("");
  return `<table class="bulk-table bulk-result" id="bulk-result">
    <thead><tr><th>line</th><th>path</th><th>kind</th><th>outcome</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

/**
 * The bulk editor's behaviour: rows, duplicate, the CSV view, the preview.
 *
 * The parser and the row formatter are the SERVER's functions, inlined by
 * `toString()` — see bulk-params.ts for why there is one parser and not two.
 * Every user-typed string reaches the DOM through `textContent` or `.value`,
 * never `innerHTML`.
 */
function bulkClientScript(namespace: string, existing: string[]): string {
  return `<script>
(function () {
  ${parseBulkCsv.toString()}
  ${parseBulkKind.toString()}
  ${formatBulkRow.toString()}
  var NS = ${jsonForScript(namespace)};
  var EXISTING = JSON.parse(${jsonForScript(JSON.stringify(existing))});
  var MAX = ${MAX_BULK_RECORDS};
  var ENV = new RegExp(${jsonForScript(`^${ENV_NAME_SOURCE}$`)});
  var form = document.getElementById("bulk-form");
  var text = document.getElementById("bulk-csv");
  var rowsWrap = document.getElementById("bulk-rows");
  var body = document.getElementById("bulk-rows-body");
  var csvWrap = document.getElementById("bulk-csv-wrap");
  var tabs = document.getElementById("bulk-tabs");
  var preview = document.getElementById("bulk-preview");
  var submit = document.getElementById("bulk-submit");
  var summary = document.getElementById("bulk-summary");
  if (!form || !text || !body || !tabs || !preview || !submit) return;
  var mode = "rows";

  // The lowercase-and-collapse half of parameterId's fold
  // (src/secrets/parameters/wire.ts), for duplicate detection only: two paths
  // that fold together are one parameter.
  function fold(p) {
    return p.replace(/^\\/+/, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  }
  var existingIds = {};
  EXISTING.forEach(function (p) { existingIds[fold(p)] = true; });

  function normPrefix(v) {
    var t = v.trim().replace(/^\\/+/, "").replace(/\\/+$/, "");
    return t === "" ? "" : t + "/";
  }
  function prefixError(v) {
    var t = v.trim();
    if (t === "") return null;
    if (t.length > 200) return "A path prefix may be at most 200 characters.";
    var segs = normPrefix(t).slice(0, -1).split("/");
    for (var i = 0; i < segs.length; i++) {
      if (!/^[a-z0-9][a-z0-9._-]*$/.test(segs[i])) {
        return "A path prefix is lowercase segments: letters, digits, dots, dashes, underscores.";
      }
    }
    return null;
  }

  function el(tag, cls, txt) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt !== undefined) e.textContent = txt;
    return e;
  }

  // --- rows -----------------------------------------------------------------
  function makeRow(r) {
    var row = el("div", "bulk-row");
    var n = el("span", "bulk-n");
    var prefix = el("input", "in in-row bulk-prefix");
    prefix.type = "text"; prefix.setAttribute("list", "bulk-prefixes");
    prefix.placeholder = "server/static/"; prefix.value = r.prefix;
    prefix.setAttribute("aria-label", "Path prefix");
    var variable = el("input", "in in-row bulk-var");
    variable.type = "text"; variable.placeholder = "VARIABLE"; variable.value = r.variable;
    variable.setAttribute("aria-label", "Variable name");
    variable.autocapitalize = "off";
    var secretWrap = el("label", "bulk-secret");
    var secret = el("input");
    secret.type = "checkbox"; secret.checked = parseBulkKind(r.kind) !== false;
    secret.setAttribute("aria-label", "Secret");
    secretWrap.appendChild(secret);
    // A textarea, not a password field: a password field strips line breaks,
    // so a PEM pasted here would be stored as one line. rows=1 keeps the grid;
    // the field grows by dragging, and the dots are the in-masked rule.
    var value = el("textarea", "in in-row in-value in-masked bulk-val");
    value.rows = 1; value.placeholder = "value"; value.spellcheck = false;
    value.setAttribute("autocomplete", "off"); value.setAttribute("autocapitalize", "off");
    value.setAttribute("data-gramm", "false"); value.setAttribute("data-enable-grammarly", "false");
    value.setAttribute("aria-label", "Value");
    value.value = r.value;
    var note = el("input", "in in-row bulk-note");
    note.type = "text"; note.placeholder = "note (optional)"; note.value = r.note;
    note.setAttribute("aria-label", "Note");
    var acts = el("span", "bulk-acts");
    var dup = el("button", "btn bulk-dup", "Duplicate");
    dup.type = "button";
    dup.title = "Copy this row below, without its value";
    var del = el("button", "btn btn-danger bulk-del", "\\u00d7");
    del.type = "button"; del.title = "Remove this row"; del.setAttribute("aria-label", "Remove this row");
    acts.appendChild(dup); acts.appendChild(del);
    [n, prefix, variable, secretWrap, value, note, acts].forEach(function (c) { row.appendChild(c); });
    row._f = { prefix: prefix, variable: variable, secret: secret, value: value, note: note };
    var msg = el("span", "bulk-row-msg");
    row.appendChild(msg);
    row._msg = msg;
    dup.addEventListener("click", function () {
      var copy = makeRow({
        prefix: prefix.value, variable: variable.value,
        kind: secret.checked ? "secret" : "plain", value: "", note: note.value
      });
      row.parentNode.insertBefore(copy, row.nextSibling);
      renumber(); update();
      copy._f.variable.focus();
      copy._f.variable.select();
    });
    del.addEventListener("click", function () {
      row.parentNode.removeChild(row);
      if (!body.children.length) body.appendChild(makeRow(blank()));
      renumber(); update();
    });
    return row;
  }
  function blank() { return { prefix: "", variable: "", kind: "secret", value: "", note: "" }; }
  function renumber() {
    Array.prototype.forEach.call(body.children, function (r, i) {
      r.querySelector(".bulk-n").textContent = String(i + 1);
    });
  }
  function rowData(r) {
    var f = r._f;
    return {
      prefix: f.prefix.value.trim(), variable: f.variable.value.trim(),
      kind: f.secret.checked ? "secret" : "plain",
      value: f.value.value,
      note: f.note.value.trim()
    };
  }
  function isBlankRow(d) {
    return !d.prefix && !d.variable && !d.value && !d.note;
  }
  function rowsToCsv() {
    var out = [];
    Array.prototype.forEach.call(body.children, function (r) {
      var d = rowData(r);
      if (!isBlankRow(d)) out.push(formatBulkRow(d));
    });
    return out.join("\\n");
  }
  function loadRows(records) {
    body.textContent = "";
    records.forEach(function (r) { body.appendChild(makeRow(r)); });
    if (!records.length) body.appendChild(makeRow(blank()));
    renumber();
  }

  // --- checking ---------------------------------------------------------------
  // The server checks every line again; this is so the human sees it first.
  function check(records) {
    var seen = {};
    return records.map(function (r) {
      var kind = parseBulkKind(r.kind);
      var path = NS + normPrefix(r.prefix) + r.variable;
      var err =
        prefixError(r.prefix) ||
        (!r.variable ? "A variable name is required." : null) ||
        (r.variable.length > 200 ? "A variable name may be at most 200 characters." : null) ||
        (!ENV.test(r.variable) ? "Not a valid environment variable name." : null) ||
        (path.length > 512 ? "A parameter path may be at most 512 characters." : null) ||
        (kind === null ? 'Kind must be "secret" or "plain".' : null) ||
        (r.value === "" ? "A value is required." : null) ||
        (new Blob([r.note]).size > 4096 ? "A note may be at most 4096 bytes." : null) ||
        (seen[fold(path)] ? "Line " + seen[fold(path)] + " already creates this path." : null) ||
        (existingIds[fold(path)] ? "Already exists. Rotate it from the table instead." : null);
      if (!err) seen[fold(path)] = r.line;
      return { line: r.line, path: path, secret: kind !== false, value: r.value, error: err };
    });
  }

  function current() {
    if (mode === "rows") {
      var recs = [];
      Array.prototype.forEach.call(body.children, function (r, i) {
        var d = rowData(r);
        if (isBlankRow(d)) return;
        d.line = i + 1;
        recs.push(d);
      });
      return { records: recs, errors: [] };
    }
    return parseBulkCsv(text.value);
  }

  function update() {
    var parsed = current();
    var checked = check(parsed.records);
    var bad = parsed.errors.length;
    checked.forEach(function (c) { if (c.error) bad++; });
    var total = checked.length + parsed.errors.length;

    // Per-row marks in the row view.
    if (mode === "rows") {
      var byLine = {};
      checked.forEach(function (c) { byLine[c.line] = c; });
      Array.prototype.forEach.call(body.children, function (r, i) {
        var c = byLine[i + 1];
        r.classList.toggle("bulk-row-bad", !!(c && c.error));
        r._msg.textContent = c && c.error ? c.error : "";
      });
    }

    preview.textContent = "";
    preview.hidden = total === 0;
    if (total) {
      var table = el("table", "bulk-table");
      var head = el("tr");
      ["line", "full path", "kind", "value", "check"].forEach(function (h) { head.appendChild(el("th", "", h)); });
      var thead = el("thead"); thead.appendChild(head); table.appendChild(thead);
      var tb = el("tbody");
      var lines = checked.map(function (c) { return c; });
      parsed.errors.forEach(function (e) {
        lines.push({ line: e.line, path: "", secret: true, value: "", error: "Cannot be read: " + e.message, unreadable: true });
      });
      lines.sort(function (a, b) { return a.line - b.line; });
      lines.forEach(function (c) {
        var tr = el("tr", c.error ? "bulk-out-invalid" : "bulk-out-ok");
        tr.appendChild(el("td", "bulk-n", String(c.line)));
        var p = el("td"); p.appendChild(el("code", "", c.path || "—")); tr.appendChild(p);
        var k = el("td");
        if (!c.unreadable) k.appendChild(el("span", "chip " + (c.secret ? "chip-secret" : "chip-plain"), c.secret ? "secret" : "non-secret"));
        tr.appendChild(k);
        var v = el("td", "bulk-mask");
        v.textContent = c.unreadable ? "" : c.value === "" ? "—" : c.secret ? "\\u2022\\u2022\\u2022\\u2022\\u2022\\u2022 hidden" : c.value;
        tr.appendChild(v);
        tr.appendChild(el("td", "", c.error || "ready"));
        tb.appendChild(tr);
      });
      table.appendChild(tb);
      preview.appendChild(table);
    }

    var tooMany = total > MAX;
    submit.disabled = total === 0 || bad > 0 || tooMany;
    submit.textContent = total ? "Create " + total + " parameter" + (total === 1 ? "" : "s") : "Create all";
    summary.textContent = tooMany
      ? "At most " + MAX + " at once."
      : bad ? bad + " line" + (bad === 1 ? " needs" : "s need") + " fixing before anything can be created." : "";
  }

  function setMode(m) {
    if (m === mode) return;
    if (m === "rows") {
      var parsed = parseBulkCsv(text.value);
      if (parsed.errors.length) {
        update();
        summary.textContent = "Fix the lines that cannot be read before switching to rows.";
        return;
      }
      loadRows(parsed.records);
    } else {
      text.value = rowsToCsv();
    }
    mode = m;
    rowsWrap.hidden = m !== "rows";
    csvWrap.hidden = m !== "csv";
    Array.prototype.forEach.call(tabs.querySelectorAll(".bulk-tab"), function (b) {
      b.setAttribute("aria-pressed", String(b.getAttribute("data-mode") === m));
    });
    update();
  }

  tabs.hidden = false;
  tabs.addEventListener("click", function (e) {
    var b = e.target.closest(".bulk-tab");
    if (b) setMode(b.getAttribute("data-mode"));
  });
  document.getElementById("bulk-add-row").addEventListener("click", function () {
    var last = body.lastElementChild;
    var r = makeRow(blank());
    if (last) r._f.secret.checked = last._f.secret.checked;
    body.appendChild(r);
    renumber(); update();
    r._f.prefix.focus();
  });
  body.addEventListener("input", update);
  body.addEventListener("change", update);
  text.addEventListener("input", update);
  form.addEventListener("submit", function (e) {
    if (mode === "rows") text.value = rowsToCsv();
    update();
    if (submit.disabled) e.preventDefault();
  });

  // Start in rows when the text (a refill, or nothing) reads cleanly.
  var initial = parseBulkCsv(text.value);
  if (initial.errors.length) {
    mode = "csv";
    rowsWrap.hidden = true;
    tabs.querySelector('[data-mode="rows"]').setAttribute("aria-pressed", "false");
    tabs.querySelector('[data-mode="csv"]').setAttribute("aria-pressed", "true");
  } else {
    loadRows(initial.records);
    rowsWrap.hidden = false;
    csvWrap.hidden = true;
  }
  update();
})();
</script>`;
}

/** JSON for an inline `<script>`: `</script>` in a value must not close it. */
export function jsonForScript(value: string): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
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
  /**
   * The nav section this refusal belongs to — the page the reader was trying to
   * reach, not the one they got. A 424 on `/playground/slack` still marks
   * "playground", so the bar tells them where they are rather than going blank
   * on exactly the page they are most lost on.
   */
  nav?: NavKey;
  /**
   * Other stores on this console page, offered as links.
   *
   * A multi-store secrets page whose SELECTED store is broken — an unseeded
   * admin key, no namespace — renders this message instead of the parameter
   * table, and the message has no store picker in it. With no `?project=` the
   * selected store is the first one, so without these links one unseeded
   * credential would make every OTHER store on the page reachable only by
   * hand-typing a query string. Under the old page-per-project layout each page
   * failed on its own; this keeps that true.
   */
  otherStores?: { href: string; label: string }[];
  /**
   * The other secrets PAGES on this gateway, for the same strip a healthy
   * secrets page carries. A broken page is where a reader is likeliest to be
   * looking for somewhere else to go. See siblingStrip.
   */
  siblingPages?: SecretsPageSummary[];
}): string {
  const tone = opts.tone ?? "info";
  const others = opts.otherStores?.length
    ? `<p class="state-sub state-links">Other stores on this page: ${opts.otherStores
        .map((s) => `<a href="${esc(s.href)}">${esc(s.label)}</a>`)
        .join(" · ")}</p>`
    : "";
  const body = `
${siblingStrip(opts.siblingPages ?? [])}
<div class="state state-${tone}">
  <div class="state-icon">${opts.icon ?? INFO_SVG}</div>
  <p class="state-title">${esc(opts.heading)}</p>
  <p class="state-sub">${esc(opts.sub)}</p>
  ${others}
</div>`;
  return layout({
    title: opts.title,
    serverSlug: opts.serverSlug,
    signedInAs: opts.signedInAs,
    body,
    nav: opts.nav,
  });
}

/**
 * The 401 shown when the SSO gate is not satisfied and Google OAuth is off.
 *
 * It says one of two things, and which one is not cosmetic: telling a human to
 * present a bootstrap token on a deployment where no token can be accepted
 * sends them to hunt for a credential that was never the problem. The
 * `ConsoleDenial` decides; this only renders it.
 */
export function renderSignIn(denial: ConsoleDenial): string {
  const sub =
    denial.error === "invalid_bootstrap_token"
      ? `This console is gated by strad's SSO. Google Workspace sign-in is not
         yet configured on this deployment, so entry is via the console dev
         bypass — present the bootstrap token as <code>?token=…</code>.`
      : `This console is gated by strad's SSO. Neither door is open on this
         deployment: Google Workspace sign-in is not usable here — it is either
         unconfigured or missing its credentials — and the console dev bypass is
         not active. No token will get you in until an operator changes that.`;
  const body = `
<div class="state state-warn signin">
  <div class="state-icon">${LOCK_SVG}</div>
  <p class="state-title">Sign in required</p>
  <p class="state-sub">${sub}</p>
  <p class="state-detail">${esc(`dev bypass: ${denial.devBypass}`)}</p>
</div>`;
  return layout({ title: "Sign in", body, nav: false });
}

/**
 * The offline fallback, shown when the installed app is opened with no network.
 *
 * It is the ONE page the service worker precaches, and everything about it
 * follows from that. It takes no arguments, because a precached document is
 * written once and served to whoever opens the app next — a version that varied
 * by request, by signed-in identity or by config would freeze one visitor's
 * answer on disk. So it names no server, no bucket and no person, and it does
 * not claim the session is still good: it says the network is gone, and offers
 * the retry that will find out.
 */
export function renderOffline(): string {
  const body = `
<div class="state state-warn">
  <div class="state-icon">${OFFLINE_SVG}</div>
  <p class="state-title">No connection</p>
  <p class="state-sub">The console is a live view of a running gateway — the
    server roster, the secret states and the parameter forms are all read from it
    on request, so there is nothing useful to show while it is unreachable.</p>
  <p class="state-detail">Reconnect and reload. You may need to sign in again.</p>
  <p><a class="btn" href="/connectors">Retry</a></p>
</div>`;
  return layout({
    title: "Offline",
    body,
    nav: false,
    footNote: "offline · nothing cached",
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

const QUESTION_SVG = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.6"/><path d="M9.6 9.3a2.4 2.4 0 1 1 3.2 2.26c-.5.19-.8.67-.8 1.2v.54" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M12 16.7h.01" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>`;

const CARET_SVG = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M7 10l5 5 5-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const INFO_SVG = `<svg width="34" height="34" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="8.5" stroke="currentColor" stroke-width="1.5"/><path d="M12 11v5M12 8h.01" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`;

const OFFLINE_SVG = `<svg width="34" height="34" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4.5 9.5a10.5 10.5 0 0 1 5-2.6M14.5 7a10.5 10.5 0 0 1 5 2.5M7.5 13a6.5 6.5 0 0 1 2.2-1.3M14.5 11.8a6.5 6.5 0 0 1 2 1.2M10.4 16.3a2.5 2.5 0 0 1 3.2 0" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M12 19h.01" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/><path d="M3.5 3.5l17 17" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;

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

/* Shared nav — src/ui/nav.ts owns the markup this styles. */
${NAV_CSS}
/* Page */
.page{max-width:60rem;margin:0 auto;padding:1.9rem 1.5rem 3rem;width:100%;flex:1}
/* One measure for the whole frame. See LayoutOptions.wide. */
body.wide .page,body.wide .topbar-inner,body.wide .mainnav-inner,body.wide .foot{max-width:76rem}

.intro h1{font-size:2rem;font-weight:650;letter-spacing:-.02em;color:var(--white);margin:0 0 .5rem}
.intro .lede{color:var(--g2);font-size:1.02rem;max-width:40rem;margin:0 0 1.6rem}

/* Server cards */
.card-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(16.5rem,1fr));gap:1rem}
/* Same grid, for a set of short doors rather than a set of paragraphs. */
.card-grid-tight{grid-template-columns:repeat(auto-fill,minmax(14rem,1fr));gap:.7rem}
.card-grid-tight .card{padding:.8rem .95rem;gap:.35rem}
.card-grid-tight .card-title{font-size:.95rem}
.card-grid-tight .card-desc{font-size:.82rem;line-height:1.5}
.card{border:1px solid var(--g5);border-radius:.6rem;background:var(--g7);padding:1.05rem 1.15rem;
  display:flex;flex-direction:column;gap:.55rem;transition:border-color .15s ease,transform .15s ease}
.card-link:hover{border-color:color-mix(in srgb,var(--accent) 50%,var(--g5));transform:translateY(-1px)}
.card-head{display:flex;align-items:center;gap:.5rem;flex-wrap:wrap}
.card-title{font-weight:600;font-size:1.08rem;color:var(--white)}
.card-desc{color:var(--g2);font-size:.9rem;margin:0;flex:1}
.card-foot{display:flex;align-items:center;justify-content:space-between;margin-top:.2rem}
.card-cta{color:var(--text-accent);font-weight:600;font-size:.86rem}
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

/* Sibling secrets pages */
.siblings{font-size:.82rem;color:var(--g3);margin:-.6rem 0 1.25rem}
.siblings-l{margin:0 0 .35rem}
.sibling-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:.3rem}
.sibling{display:flex;align-items:baseline;gap:.6rem;flex-wrap:wrap;font-family:var(--font-mono)}
.sibling-slug{color:var(--text-accent);font-weight:500}
.sibling-slug:hover,.sibling-project:hover code{text-decoration:underline}
.sibling-store{display:inline-flex;align-items:baseline;gap:.45rem;flex-wrap:wrap}
.sibling-store+.sibling-store::before{content:"·";color:var(--g4)}
.sibling-ns{color:var(--g2)}

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
.posture-warn{border-left-color:#e0a63b;margin-bottom:.7rem}
.posture-reveal{margin-bottom:.7rem}

.state-links{margin-top:.6rem}
.state-links a{color:var(--text-accent);text-decoration:none}
.state-links a:hover{text-decoration:underline}

/* Store picker: which of the console's parameter stores this page is showing. */
.storeform{display:flex;align-items:center;gap:.45rem;flex-wrap:wrap}
.in-select{padding:.32rem .5rem;font-size:.8rem;min-width:14rem}

/* Namespace picker */
.nsform{display:flex;align-items:center;gap:.45rem;flex-wrap:wrap}
.nsgo{font-size:.76rem}
.reread-form{margin-left:auto}
.nscount{color:var(--g4);font-size:.7rem;text-transform:uppercase;letter-spacing:.05em}

/* Combobox: a free-text field whose suggestions open as a dropdown. */
.combo{position:relative}
.combo-ns{min-width:24rem}
.combo .in{padding-right:1.6rem}
.combo-caret{position:absolute;top:0;right:0;height:100%;width:1.6rem;display:flex;align-items:center;
  justify-content:center;padding:0;border:0;border-radius:.35rem;background:transparent;color:var(--g3);
  cursor:pointer;transition:color .12s ease}
.combo-caret:hover{color:var(--text-accent)}
.combo[data-open] .combo-caret{color:var(--text-accent);transform:rotate(180deg)}
.combo-menu{position:absolute;z-index:20;top:calc(100% + .25rem);left:0;min-width:100%;max-width:min(30rem,86vw);
  max-height:15rem;overflow-y:auto;margin:0;padding:.25rem;list-style:none;border:1px solid var(--g5);
  border-radius:.4rem;background:var(--g6);box-shadow:0 10px 26px rgba(0,0,0,.38)}
.combo-opt{display:flex;flex-direction:column;gap:.05rem;padding:.32rem .5rem;border-radius:.3rem;cursor:pointer}
.combo-opt[hidden]{display:none}
.combo-opt:hover,.combo-opt.is-active{background:color-mix(in srgb,var(--accent) 20%,transparent)}
.combo-opt.is-active{outline:1px solid color-mix(in srgb,var(--accent) 55%,var(--g5))}
.combo-val{font-family:var(--font-mono);font-size:.78rem;color:var(--g1);word-break:break-all}
.combo-opt.is-current .combo-val{color:var(--text-accent);font-weight:500}
.combo-lbl{font-size:.7rem;color:var(--g4)}
.combo-none{position:absolute;z-index:20;top:calc(100% + .25rem);left:0;min-width:100%;
  max-width:min(30rem,86vw);margin:0;padding:.45rem .6rem;border:1px solid var(--g5);
  border-radius:.4rem;background:var(--g6);box-shadow:0 10px 26px rgba(0,0,0,.38);
  font-size:.72rem;color:var(--g4);line-height:1.45}

/* Help: a control in the top bar, and the guide it opens. */
.helpbtn{display:inline-flex;align-items:center;gap:.35rem;font:inherit;font-size:.8rem;
  cursor:pointer;background:transparent;color:var(--g2);border:1px solid var(--g5);
  border-radius:999px;padding:.2rem .6rem}
.helpbtn:hover{border-color:var(--accent);color:var(--text-accent)}
.helpdlg{border:1px solid var(--g5);border-radius:.7rem;background:var(--g7);color:var(--g1);
  max-width:52rem;width:calc(100vw - 3rem);max-height:82vh;padding:0;overflow:hidden}
.helpdlg::backdrop{background:rgba(0,0,0,.6);backdrop-filter:blur(2px)}
.helpdlg-head{display:flex;align-items:center;justify-content:space-between;gap:1rem;
  padding:.9rem 1.2rem;border-bottom:1px solid var(--g5);background:var(--g6);
  position:sticky;top:0}
.helpdlg-head h2{margin:0;font-size:1rem;color:var(--white)}
.helpdlg-body{padding:1rem 1.2rem 1.4rem;overflow-y:auto;max-height:calc(82vh - 3.6rem)}
.helpdlg-body .helpstack{margin-bottom:0}

/* Progressive disclosure: every explanation in the guide lives in one of these. */
.helpstack{display:flex;flex-direction:column;gap:.4rem;margin-bottom:1.3rem}
.acc{border:1px solid var(--g5);border-radius:.45rem;background:var(--g7)}
.acc>summary{cursor:pointer;list-style:none;padding:.55rem .9rem;font-size:.84rem;font-weight:600;
  color:var(--g1);display:flex;align-items:center;gap:.5rem}
.acc>summary::-webkit-details-marker{display:none}
.acc>summary::before{content:"▸";color:var(--text-accent);font-size:.8rem;flex:none}
.acc[open]>summary::before{content:"▾"}
.acc>summary:hover{color:var(--white)}
.acc-body{padding:.2rem 1.1rem 1rem;font-size:.83rem;color:var(--g2);line-height:1.62;
  border-top:1px solid var(--g6)}
.acc-body p{margin:.7rem 0}
.acc-body b{color:var(--white);font-weight:600}
.acc-body ol,.acc-body ul{margin:.6rem 0;padding-left:1.2rem}
.acc-body li{margin:.35rem 0}
.acc-code{margin:.6rem 0;padding:.6rem .8rem;border-radius:.35rem;background:var(--bg-code);
  color:var(--g1);font-family:var(--font-mono);font-size:.74rem;overflow-x:auto;line-height:1.5}
.acc-code b{color:var(--text-accent);font-weight:500}
.seg-ns{color:var(--g3)}
.seg-pfx{color:var(--text-accent);font-weight:500}
.seg-var{color:#e0a63b;font-weight:500}
.seglegend{font-family:var(--font-mono);font-size:.72rem;margin:-.2rem 0 .8rem;color:var(--g4)}
.acc-foot{color:var(--g3);font-size:.78rem}
.exlist{list-style:none;padding:0}
.exlist li{display:flex;flex-direction:column;gap:.2rem;padding:.55rem 0;border-bottom:1px solid var(--g6)}
.exlist li:last-child{border-bottom:none}
.exlist code{word-break:break-all}
.ex-ok{color:var(--text-accent);font-size:.76rem;font-weight:600}
.ex-no{color:#e0a63b;font-size:.76rem;font-weight:600}
.ex-why{color:var(--g3);font-size:.78rem}
.nslist{list-style:none;padding:0}
.nslist li{display:flex;align-items:center;gap:.5rem;flex-wrap:wrap}

/* The path a value is about to be written to. */
.pathpart{align-self:flex-start;font-size:.78rem;word-break:break-all;max-width:100%}
.pathpreview{color:var(--text-accent);border-color:color-mix(in srgb,var(--accent) 45%,var(--g5))}
.row-pfx{display:block;color:var(--g4);font-size:.72rem;font-weight:400;word-break:break-all}
.chip-route{text-transform:none;letter-spacing:0}
.chip-warnish{color:#e0a63b;border-color:color-mix(in srgb,#e0a63b 45%,var(--g5))}
.secret-row{gap:.6rem;flex-wrap:wrap}
.secret-row .row-name{flex:0 0 17rem;color:var(--white);font-weight:500;
  white-space:normal;overflow:visible;line-height:1.3}
.row-var{word-break:break-all}
.row-kind{flex:none}
.row-note{flex:1;min-width:8rem;color:var(--g2);font-size:.82rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.row-nonote{color:var(--g4);font-style:italic}
.row-ver{flex:none;width:5.5rem;text-align:right}
.row-actions{display:flex;align-items:center;gap:.35rem;flex:none;flex-wrap:wrap}
.chip-ok{color:var(--text-accent);border-color:var(--accent)}
.chip-secret{color:#e0a63b;border-color:color-mix(in srgb,#e0a63b 45%,var(--g5));text-transform:none;letter-spacing:0}
.chip-plain{color:var(--g3);border-color:var(--g5);text-transform:none;letter-spacing:0}
form.inline{display:flex;align-items:center;gap:.25rem;margin:0}
.btn{font:inherit;font-size:.76rem;padding:.32rem .6rem;border-radius:.35rem;cursor:pointer;
  display:inline-block;border:1px solid var(--g5);background:var(--g6);color:var(--g1);white-space:nowrap}
.btn:hover:not(:disabled){border-color:var(--accent);color:var(--white)}
.btn:disabled{opacity:.4;cursor:not-allowed}
.btn-primary{background:var(--accent);border-color:var(--accent);color:#fff;font-size:.85rem;padding:.5rem 1rem;font-weight:600}
.btn-primary:hover{background:var(--accent-high);color:#fff}
.btn-danger:hover{border-color:#e5706e;color:#e5706e}
.in{font:inherit;font-size:.85rem;padding:.45rem .6rem;border-radius:.35rem;border:1px solid var(--g5);
  background:var(--bg);color:var(--white);width:100%;font-family:var(--font-mono)}
.in:focus{outline:none;border-color:var(--accent)}
/* The connector form calls these "greyed out" and lists them by name, so they
   have to actually look it — a field that reads as editable and refuses the
   save is the control that page is not supposed to render. */
.in:disabled{opacity:.45;cursor:not-allowed}
.in-sm{font-size:.74rem;padding:.28rem .4rem;width:8.5rem}
/* A value field is a textarea, never a password input: a password
   input strips line breaks on paste, so a PEM key would land as one line. The
   dots are text-security, which a browser without it ignores and shows the
   value as typed. */
.in-value{resize:vertical;line-height:1.4}
textarea.in-sm{height:1.8rem;min-height:1.8rem;vertical-align:middle}
textarea.in-row{height:1.95rem;min-height:1.95rem}
.in-masked{-webkit-text-security:disc}
.value-field:has(.value-show-box:checked) .in-masked{-webkit-text-security:none}
.value-show{margin-left:.4rem;cursor:pointer;white-space:nowrap}
.value-show input{vertical-align:middle;accent-color:var(--accent)}
.addbox + .listing,.addbox + .state{margin-top:1.5rem}
.addbox{margin-top:1.5rem;border:1px solid var(--g5);border-radius:.6rem;background:var(--g7);padding:1.2rem 1.4rem}
.addbox-title{margin:0 0 .9rem;font-size:1rem;color:var(--white)}
.addform{display:flex;flex-direction:column;gap:.9rem;max-width:34rem}
.field{display:flex;flex-direction:column;gap:.3rem}
.field-check{flex-direction:row;align-items:flex-start;gap:.55rem}
.field-check input{margin-top:.2rem;width:1rem;height:1rem;flex:none;accent-color:var(--accent)}
.field-check .field-l{display:inline}
.field-l{font-size:.78rem;color:var(--g2);font-weight:600}
.field-opt{color:var(--g4);font-weight:400;text-transform:uppercase;font-size:.66rem;letter-spacing:.05em}
.field-h{font-size:.72rem;color:var(--g4)}
.bulk-lede{margin:-.4rem 0 .9rem}
.bulkform{display:flex;flex-direction:column;gap:.8rem}
.bulk-tabs{display:flex;align-items:center;gap:.4rem;flex-wrap:wrap}
.bulk-tab[aria-pressed="true"]{border-color:var(--accent);color:var(--white);background:color-mix(in srgb,var(--accent) 18%,var(--g6))}
.bulk-row{display:grid;grid-template-columns:1.6rem 1.3fr 1.5fr 3.2rem 1.2fr 1.2fr 7.4rem;
  gap:.4rem;align-items:center;margin-bottom:.4rem}
.bulk-row-head{font-size:.66rem;text-transform:uppercase;letter-spacing:.05em;color:var(--g4);margin-bottom:.25rem}
.bulk-row-head span:nth-child(4){text-align:center}
.bulk-n{font-family:var(--font-mono);font-size:.72rem;color:var(--g4);text-align:right}
.in-row{font-size:.78rem;padding:.32rem .45rem;min-width:0}
.bulk-secret{display:flex;justify-content:center}
.bulk-secret input{width:1rem;height:1rem;accent-color:var(--accent)}
.bulk-acts{display:flex;gap:.3rem}
.bulk-row-msg{grid-column:2/-1;font-size:.72rem;color:#e5706e}
.bulk-row-msg:empty{display:none}
.bulk-row-bad .in-row{border-color:color-mix(in srgb,#e5706e 60%,var(--g5))}
.bulk-text{min-height:9rem;resize:vertical;font-size:.78rem;line-height:1.45}
.bulk-format{margin-top:.4rem}
.bulk-format summary{cursor:pointer}
.bulk-format ul{margin:.3rem 0 0;padding-left:1.1rem;display:flex;flex-direction:column;gap:.2rem}
.bulk-submit{display:flex;align-items:center;gap:.8rem;flex-wrap:wrap}
.bulk-table{width:100%;border-collapse:collapse;font-size:.78rem;margin-top:.2rem}
.bulk-table th{text-align:left;font-size:.66rem;text-transform:uppercase;letter-spacing:.05em;color:var(--g4);
  font-weight:600;padding:.35rem .5rem;border-bottom:1px solid var(--g5)}
.bulk-table td{padding:.4rem .5rem;border-top:1px solid var(--g6);vertical-align:top;color:var(--g2)}
.bulk-table code{font-size:.74rem;word-break:break-all;color:var(--white)}
.bulk-table .chip{white-space:nowrap}
.bulk-mask{font-family:var(--font-mono);font-size:.74rem;word-break:break-all}
.bulk-result{margin-top:1rem}
.bulk-status{font-weight:600}
.bulk-out-created .bulk-status,.bulk-out-ok td:last-child{color:var(--text-accent)}
.bulk-out-failed .bulk-status,.bulk-out-invalid .bulk-status,.bulk-out-invalid td:last-child{color:#e5706e}
.bulk-out-warn .bulk-status,.bulk-out-skipped .bulk-status{color:#e0a63b}
.bulk-msg{color:var(--g3)}
@media (max-width:46rem){
  .bulk-row{grid-template-columns:1.4rem 1fr 1fr}
  .bulk-row-head{display:none}
  .bulk-row .bulk-secret{justify-content:flex-start}
  .bulk-acts{grid-column:2/-1}
}
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
/* Landing page (/) */
.env-badge{font-family:var(--font-mono);font-size:.55em;text-transform:uppercase;letter-spacing:.06em;
  vertical-align:middle;border:1px solid var(--g5);border-radius:4px;padding:.15rem .45rem;
  color:var(--text-accent);margin-left:.5rem}
.scope-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:.45rem}
.scope-list li{display:flex;align-items:center;gap:.5rem;flex-wrap:wrap;font-size:.82rem}
.scope-list code{font-family:var(--font-mono);font-size:.76rem;word-break:break-all}
.connect-form{display:flex;align-items:center;gap:.9rem;flex-wrap:wrap;margin-top:1rem}
.panel{margin-top:2.1rem}
.panel-head{display:flex;align-items:baseline;justify-content:space-between;gap:1rem;
  margin-bottom:.85rem;border-bottom:1px solid var(--g5);padding-bottom:.45rem}
.panel-head h2{font-size:1rem;margin:0;letter-spacing:.01em}
.panel-note{font-family:var(--font-mono);font-size:.74rem;color:var(--g4)}
.copy-row{display:flex;gap:.4rem}
.copy-url{flex:1;min-width:0;font-family:var(--font-mono);font-size:.82rem;
  background:var(--bg-code);color:var(--g1);border:1px solid var(--g5);border-radius:6px;
  padding:.45rem .6rem}
.copy-url:focus{outline:2px solid var(--accent);outline-offset:1px}
.copy-btn{white-space:nowrap;cursor:pointer;font-size:.82rem;font-weight:600;
  background:var(--accent);color:#fff;border:1px solid var(--accent);border-radius:6px;
  padding:.45rem .75rem}
.copy-btn:hover{background:var(--accent-high)}
.copy-note{color:var(--g3);font-size:.82rem;margin:.35rem 0 1rem}
.btn-ghost{cursor:pointer;font-size:.78rem;font-weight:600;font-family:var(--font-mono);
  background:transparent;color:var(--g2);border:1px solid var(--g5);border-radius:6px;
  padding:.3rem .6rem}
.btn-ghost:hover{border-color:var(--accent);color:var(--text-accent)}
.server-tile{gap:.5rem}
.tile-slug{min-width:0}
.tile-slug code{font-size:.82rem;color:var(--text-accent);word-break:break-all}
.tile-actions{display:flex;align-items:center;justify-content:space-between;gap:.6rem;
  margin-top:auto;padding-top:.2rem}

/* The connectors roster (src/ui/roster-page.ts). A real table, because the
   roster is a grid of short facts per slug rather than the variable-length
   rows .listing is shaped for. It lives in the theme rather than on that page
   because the entry form's sibling markup (src/ui/servers-page.ts) shares it. */
.conn-table{width:100%;border-collapse:collapse;margin-top:1rem;
  border:1px solid var(--g5);border-radius:.6rem;overflow:hidden;background:var(--g7)}
.conn-table th{text-align:left;padding:.6rem .8rem;font-size:.7rem;font-weight:600;
  text-transform:uppercase;letter-spacing:.06em;color:var(--g3);
  background:var(--g6);border-bottom:1px solid var(--g5);white-space:nowrap}
.conn-table td{padding:.65rem .8rem;border-top:1px solid var(--g6);vertical-align:middle;
  font-size:.86rem}
.conn-table tr:first-child td{border-top:none}
.conn-acts{display:flex;gap:.35rem;justify-content:flex-end;flex-wrap:wrap}
.conn-acts form{display:inline}
.conn-form{max-width:42rem}
.conn-form .field{margin-bottom:1.1rem}
.conn-sub{font-size:.95rem;font-weight:600;color:var(--white);margin:1.6rem 0 .3rem}

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
