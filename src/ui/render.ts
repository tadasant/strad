import type { ServerConfig, StradConfig } from "../config/schema.ts";
import type { ListResult } from "./gcs-client.ts";
import type { ServerView } from "./resolve.ts";
import type { ParameterMeta } from "../secrets/parameters/index.ts";
import {
  classifyPath,
  paramsConsumers,
  prefixSuggestions,
  type Routing,
} from "./param-routing.ts";
import type { RevealPosture } from "./reveal.ts";

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
  /** Where the brand mark links. Defaults to the resource browser. */
  brandHref?: string;
  /** The word beside the brand mark. Defaults to "resource browser". */
  brandSub?: string;
  /**
   * Right-hand footer text. Defaults to the gated browser's own claim, which
   * would be a lie on the public landing page — hence the parameter.
   */
  footNote?: string;
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
    <a class="brand" href="${esc(opts.brandHref ?? "/ui")}">
      ${LOGO_SVG}
      <span class="brand-name">strad</span>
      <span class="brand-sub">${esc(opts.brandSub ?? "resource browser")}</span>
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
  <span>${esc(opts.footNote ?? "SSO-gated · humans only")}</span>
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
  /**
   * The running gateway config. The page reports what will actually READ a
   * parameter, and that is a property of the config, not of the store — see
   * param-routing.ts.
   */
  config: StradConfig;
  parameters: ParameterMeta[];
  /** The managed namespace being browsed. One of `view.namespaces`. */
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
  const {
    view,
    config,
    parameters,
    resolver,
    reveal: revealUi,
    revealNonSecret,
  } = opts;
  const slug = view.server.slug;
  const action = `/ui/${encodeURIComponent(slug)}`;
  const ns = opts.namespace;
  /** Every write posts the namespace back, so the page returns where it was. */
  const nsField = `<input type="hidden" name="ns" value="${esc(ns)}" />`;

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
            <input class="in in-sm" type="password" name="value" placeholder="new value" autocomplete="off" required />
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
  ${namespacePicker(action, view.namespaces, ns)}
  <div class="scope">
    <span class="scope-l">project</span><code>${esc(view.projectId)}</code>
  </div>
</section>

${deliveryBanner(config, resolver)}
${revealBanner(revealUi)}
${secretsHelp(config, slug, ns, view.namespaces, resolver, revealUi)}

${flash}
${reveal}
${listing}

<section class="addbox">
  <h2 class="addbox-title">Add a parameter</h2>
  <form method="post" action="${action}/create" class="addform">
    ${nsField}
    <div class="field">
      <span class="field-l">Namespace</span>
      <code class="pathpart">${esc(ns)}</code>
      <span class="field-h">Switch namespaces with the picker above.</span>
    </div>
    <label class="field">
      <span class="field-l">Path prefix <span class="field-opt">optional</span></span>
      <input class="in" id="pfx" type="text" name="prefix" list="prefix-options" autocapitalize="off" autocomplete="off"
             placeholder="${esc(examplePrefix(config))}" />
      <datalist id="prefix-options">${prefixOptions(config)}</datalist>
      <span class="field-h">The segments between the namespace and the variable name. For a
        server parameter this is <code>&lt;server-slug&gt;/static/</code> and it is what decides
        which server the value routes to.</span>
    </label>
    <label class="field">
      <span class="field-l">Variable name</span>
      <input class="in" id="varname" type="text" name="variable" required autocapitalize="off" autocomplete="off"
             pattern="[A-Za-z_][A-Za-z0-9_]*" placeholder="${esc(exampleVariable(config))}" />
      <span class="field-h">A valid environment variable name.</span>
    </label>
    <div class="field">
      <span class="field-l">Full path</span>
      <code class="pathpart pathpreview" id="pathpreview">${esc(ns)}&lt;VARIABLE&gt;</code>
    </div>
    <label class="field field-check">
      <input type="checkbox" name="secret" />
      <span><span class="field-l">Secret</span> <span class="field-h">Tick for a credential (private key, token) — see “Secret vs non-secret” above.</span></span>
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
    </label>
    <button class="btn btn-primary">Create parameter</button>
  </form>
</section>
${pathPreviewScript(ns)}`;

  return layout({
    title: `${slug} · parameters`,
    serverSlug: slug,
    signedInAs: opts.signedInAs,
    body,
  });
}

/**
 * The namespace picker.
 *
 * `SECRETS_NAMESPACES` has always been a LIST and the store has always been able
 * to list any of them — it was the console that addressed only the first. This
 * is a plain GET form so switching is an ordinary navigation the SSO gate already
 * covers; the `onchange` submit is enhancement, and the button is the fallback.
 */
function namespacePicker(
  action: string,
  namespaces: string[],
  selected: string,
): string {
  const options = namespaces
    .map(
      (n) =>
        `<option value="${esc(n)}"${n === selected ? " selected" : ""}>${esc(n)}</option>`,
    )
    .join("");
  return `
  <form class="nsform" method="get" action="${action}">
    <label class="scope-l" for="ns-select">namespace</label>
    <select class="in nsselect" id="ns-select" name="ns" onchange="this.form.submit()">${options}</select>
    <button class="btn nsgo">Switch</button>
    <span class="nscount">${namespaces.length} managed</span>
  </form>`;
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
    (s) => s.enabled && s.kind !== "remote-http",
  ).length;

  // Two independent conditions, and the banner must not claim delivery on the
  // strength of one. `params: true` with no resolver credential behind it is a
  // no-op: render-spec warns and ships the component without those values.
  const status = !consumers.length
    ? `<strong>No server on this gateway sets <code>params: true</code></strong>, so
       nothing stored here is delivered to a running MCP server — this is a registry.
       Wiring a server up is a config change plus a deploy.`
    : !resolver
      ? `${consumers.length} of ${total} servers set <code>params: true</code> (${consumers
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
function revealBanner(reveal: RevealPosture): string {
  if (reveal.allowed) return "";
  return `<p class="posture ${reveal.drift ? "posture-warn" : ""} posture-reveal">
  <strong>Reveal is not available here.</strong> ${esc(reveal.detail)}
</p>`;
}

/**
 * Every explanation on this page, collapsed.
 *
 * Progressive disclosure is the requirement, and it is also the honest shape:
 * the routing rules are genuinely intricate, and a human rotating a value they
 * already understand should not have to scroll past them.
 */
function secretsHelp(
  config: StradConfig,
  slug: string,
  namespace: string,
  namespaces: string[],
  resolver: boolean,
  reveal: RevealPosture,
): string {
  const env = config.gateway.env;
  const consumers = paramsConsumers(config);
  const wired = resolver ? consumers[0] : undefined;
  // Prefer a supplementary image for the counter-example: it is the shape a
  // human is most likely to be storing a credential for, and its alternative to
  // `params: true` (a hand-written `env:` entry) is the one worth naming.
  const unwiredCandidates = config.servers.filter(
    (s) =>
      s.enabled && s.kind !== "remote-http" && !s.params && s.slug !== slug,
  );
  const unwired =
    unwiredCandidates.find((s) => s.kind === "supplementary-image") ??
    unwiredCandidates[0];

  const wiredExample = wired
    ? `<li>
         <code>/strad/${esc(env)}/mcp/${esc(wired.slug)}/static/EXAMPLE_TOKEN</code>
         <span class="ex-ok">reaches the <code>${esc(wired.slug)}</code> server</span>
         <span class="ex-why">It sets <code>params: true</code>, so ${
           wired.when === "deploy"
             ? "<code>render-spec</code> resolves this path at deploy time and injects it onto that container — a new value lands on the next deploy"
             : `it is resolved in-process at runtime and refreshed within ${config.gateway.secrets.ttlSeconds}s`
         }.</span>
       </li>`
    : `<li>
         <code>/strad/${esc(env)}/mcp/${esc(consumers[0]?.slug ?? "&lt;server&gt;")}/static/EXAMPLE_TOKEN</code>
         <span class="ex-no">reaches nothing on this gateway</span>
         <span class="ex-why">${
           consumers.length
             ? `<code>${esc(consumers[0]!.slug)}</code> sets <code>params: true</code>, but this deployment
                carries no resolver credential, so the value is never fetched and never injected.`
             : `No server here sets <code>params: true</code>, so there is no
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
  <details class="acc">
    <summary>How a parameter here routes into strad</summary>
    <div class="acc-body">
      <p>A parameter is addressed by one canonical path, and every segment of it does work:</p>
      <pre class="acc-code"><span class="seg-ns">/strad/${esc(env)}/mcp/</span><span class="seg-pfx">&lt;server-slug&gt;/static/</span><span class="seg-var">&lt;VARIABLE_NAME&gt;</span></pre>
      <p class="seglegend"><span class="seg-ns">namespace</span> ·
        <span class="seg-pfx">path prefix</span> ·
        <span class="seg-var">variable</span></p>
      <p>The <b>namespace</b> is the fence this console may write inside. The <b>path prefix</b>
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
      <p class="acc-foot">Every row above carries a chip computed from this gateway's live
        config — <span class="chip chip-ok chip-route">delivered</span> means a server is wired to
        read that exact path, <span class="chip chip-warnish chip-route">not wired</span> means it
        is stored and nothing reads it.</p>
    </div>
  </details>

  <details class="acc">
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
      <p>A namespace is a path prefix this console is allowed to write inside, configured as
        <code>SECRETS_NAMESPACES</code> (a comma-separated list). This deployment manages:</p>
      <ul class="nslist">${namespaceList(namespaces, namespace)}</ul>
      <p>It is a <b>code-level guard, not the IAM boundary</b>. The real boundary is the GCP
        project: point this at a project that holds only these parameters, so the console's admin
        credential cannot reach strad's own deployment secrets even in principle.</p>
    </div>
  </details>
</div>`;
}

/** Every managed namespace, with the one being browsed marked. */
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

/** `<datalist>` entries: every server slug, flagged with whether it is wired. */
function prefixOptions(config: StradConfig): string {
  return prefixSuggestions(config)
    .map(
      (s) =>
        `<option value="${esc(s.prefix)}" label="${esc(
          s.wired ? `${s.slug} — params: true` : `${s.slug} — not wired`,
        )}"></option>`,
    )
    .join("");
}

/** A prefix worth showing as a placeholder: a wired server if one exists. */
function examplePrefix(config: StradConfig): string {
  const consumers = paramsConsumers(config);
  if (consumers[0]) return consumers[0].prefix;
  const any = prefixSuggestions(config)[0];
  return any ? any.prefix : "";
}

function exampleVariable(config: StradConfig): string {
  const consumers = paramsConsumers(config);
  const slug = consumers[0]?.slug;
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

/** JSON for an inline `<script>`: `</script>` in a value must not close it. */
function jsonForScript(value: string): string {
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
.posture-warn{border-left-color:#e0a63b;margin-bottom:.7rem}
.posture-reveal{margin-bottom:.7rem}

/* Namespace picker */
.nsform{display:flex;align-items:center;gap:.45rem;flex-wrap:wrap}
.nsselect{width:auto;min-width:13rem;font-size:.8rem;padding:.3rem .45rem}
.nsgo{font-size:.76rem}
.nscount{color:var(--g4);font-size:.7rem;text-transform:uppercase;letter-spacing:.05em}

/* Progressive disclosure: every explanation on the page lives in one of these. */
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
.field-check{flex-direction:row;align-items:flex-start;gap:.55rem}
.field-check input{margin-top:.2rem;width:1rem;height:1rem;flex:none;accent-color:var(--accent)}
.field-check .field-l{display:inline}
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
/* Landing page (/) */
.env-badge{font-family:var(--font-mono);font-size:.55em;text-transform:uppercase;letter-spacing:.06em;
  vertical-align:middle;border:1px solid var(--g5);border-radius:4px;padding:.15rem .45rem;
  color:var(--text-accent);margin-left:.5rem}
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
