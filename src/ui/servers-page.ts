import { esc, layout } from "./render.ts";
import { serverConsolePath } from "./paths.ts";
import { SLUG_PATTERN, type StradConfig } from "../config/schema.ts";
import type { EntrySource, ServerOverlay } from "../config/overlay.ts";
import { RUNTIME_CREATABLE_KINDS, immutableFields } from "../config/overlay.ts";

/**
 * The connector editor's pages.
 *
 * Rendering only: every decision about what may be saved lives in
 * src/config/overlay.ts, and every decision about what to do with a POST lives
 * in src/ui/servers.ts. This file knows about `<input>`s.
 *
 * Same primitives as the rest of the console — `layout` and `esc` from
 * render.ts, and the `field` / `field-l` / `in` / `field-h` markup the
 * parameter forms already use. The HINT under every input is the point rather
 * than decoration: this form is where a human first meets `${NAME}` refs, the
 * difference between a `tools: allow` list and a `deny` one, and the fact that
 * a supplementary server's credentials come from a deploy. A form that makes
 * them look up the docs is a form they will fill in wrong.
 */

export const CONNECTORS_PREFIX = "/connectors";

export function connectorsPath(...rest: string[]): string {
  return [CONNECTORS_PREFIX, ...rest.map(encodeURIComponent)].join("/");
}

export interface Flash {
  tone: "ok" | "error";
  message: string;
  /** Validation problems, one per line, shown under the message. */
  detail?: string[];
}

export interface RosterOptions {
  config: StradConfig;
  overlay: ServerOverlay;
  sources: Map<string, EntrySource>;
  /** False when this gateway holds no credential that can write the overlay. */
  writable: boolean;
  signedInAs?: string;
  flash?: Flash;
}

function flashHtml(flash: Flash | undefined): string {
  if (!flash) return "";
  const detail =
    flash.detail && flash.detail.length > 0
      ? `<ul class="ex-why">${flash.detail
          .map((d) => `<li>${esc(d)}</li>`)
          .join("")}</ul>`
      : "";
  return `<div class="flash flash-${flash.tone === "ok" ? "ok" : "error"}"><div>${esc(
    flash.message,
  )}</div>${detail}</div>`;
}

function readOnlyBanner(writable: boolean): string {
  if (writable) return "";
  return `<div class="flash flash-error">
    <div>This gateway cannot write the roster.</div>
    <ul class="ex-why"><li>It holds no admin parameter credential
    (<code>SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON</code>), so a change here
    would have nowhere to go. The roster below is what the deployment is
    serving; editing it needs that credential on this component.</li></ul>
  </div>`;
}

const KIND_BLURB: Record<string, string> = {
  "remote-http":
    "An MCP server somewhere on the internet, reached over streamable HTTP. Nothing of strad's runs for it, so it can be added and used immediately.",
  "local-tunnel":
    "An MCP server on a human's own machine, reached through a tunnel. Same as remote-http, plus what to tell a caller when the machine is not there.",
  "supplementary-image":
    "A mount inside a container this deployment already runs. A new slug can point at an existing mount — that is how a read-only and a read-write view of one server are two entries — but its credentials come from the deploy.",
  builtin:
    "Compiled into the strad image. Cannot be added from here: the module has to ship with a build.",
};

function kindChip(kind: string): string {
  return `<span class="chip chip-plain">${esc(kind)}</span>`;
}

function sourceChip(source: EntrySource | undefined): string {
  return source === "store"
    ? `<span class="chip chip-ok" title="Added or edited through this console">console</span>`
    : `<span class="chip chip-plain" title="Declared in the checked-in config">config file</span>`;
}

/** `GET /connectors` — every entry the gateway is serving, and what to do to it. */
export function renderRoster(opts: RosterOptions): string {
  const { config, sources } = opts;

  const rows = config.servers
    .map((server) => {
      const source = sources.get(server.slug);
      const editable = opts.writable;
      const removed = "";
      const controls = editable
        ? `<div class="conn-acts">
             <a class="btn btn-ghost" href="${esc(connectorsPath(server.slug))}">Edit</a>
             <form method="post" action="${esc(connectorsPath(server.slug, "toggle"))}">
               <button class="btn btn-ghost" type="submit">${server.enabled ? "Disable" : "Enable"}</button>
             </form>
             <form method="post" action="${esc(connectorsPath(server.slug, "remove"))}">
               <button class="btn btn-danger" type="submit">Remove</button>
             </form>
           </div>`
        : `<div class="conn-acts"><a class="btn btn-ghost" href="${esc(connectorsPath(server.slug))}">View</a></div>`;

      return `<tr>
        <td class="conn-slug"><a href="${esc(serverConsolePath(server.slug))}">${esc(server.slug)}</a>${
          server.enabled ? "" : ` <span class="chip chip-off">disabled</span>`
        }</td>
        <td>${kindChip(server.kind)}</td>
        <td>${sourceChip(source)}</td>
        <td class="conn-title">${esc(server.title ?? server.description ?? "")}</td>
        <td class="conn-roles">${esc(server.entitlements.join(", ") || "—")}</td>
        <td>${controls}${removed}</td>
      </tr>`;
    })
    .join("\n");

  const addMenu = opts.writable
    ? `<section class="addbox">
         <h2 class="addbox-title">Add a connector</h2>
         <div class="card-grid">
           ${RUNTIME_CREATABLE_KINDS.map(
             (kind) => `<a class="card" href="${esc(
               `${connectorsPath("new")}?kind=${encodeURIComponent(kind)}`,
             )}">
               <div class="card-head"><span class="card-title">${esc(kind)}</span></div>
               <p class="card-desc">${esc(KIND_BLURB[kind] ?? "")}</p>
               <span class="card-cta">Add →</span>
             </a>`,
           ).join("\n")}
         </div>
       </section>`
    : "";

  const body = `
${flashHtml(opts.flash)}
${readOnlyBanner(opts.writable)}
<section class="panel">
  <div class="conn-head">
    <h1 class="state-title">Connectors</h1>
    <span class="conn-meta">revision ${esc(String(opts.overlay.revision))}${
      opts.overlay.updatedBy ? ` · ${esc(opts.overlay.updatedBy)}` : ""
    }${opts.overlay.updatedAt ? ` · ${esc(opts.overlay.updatedAt)}` : ""}</span>
  </div>
  <p class="state-sub">Every MCP server this gateway serves. An entry marked
  <em>console</em> lives in the runtime store and takes effect without a deploy;
  one marked <em>config file</em> comes from the checked-in document.</p>
  <table class="conn-table">
    <thead><tr>
      <th>Slug</th><th>Kind</th><th>Source</th><th>Title</th><th>Roles</th><th></th>
    </tr></thead>
    <tbody>${rows || `<tr><td colspan="6" class="empty">No servers.</td></tr>`}</tbody>
  </table>
</section>
${addMenu}
`;

  return layout({
    title: "Connectors",
    body,
    signedInAs: opts.signedInAs,
    brandHref: "/ui",
    brandSub: "connectors",
    footNote: "runtime roster · takes effect without a deploy",
    helpTitle: "Connector guide",
    help: GUIDE,
  });
}

export interface FormOptions {
  config: StradConfig;
  /** The entry being edited, raw. Absent for a create. */
  entry?: Record<string, unknown>;
  /** The slug being edited. Absent for a create. */
  slug?: string;
  kind: string;
  /** Entries of the same kind, offered as "copy from". */
  copyable: { slug: string; title?: string }[];
  /** Which entry the form was prefilled from, if any. */
  copiedFrom?: string;
  revision: number;
  source: EntrySource;
  signedInAs?: string;
  flash?: Flash;
}

function text(value: unknown): string {
  if (value === undefined || value === null) return "";
  return String(value);
}

function lines(value: unknown): string {
  return Array.isArray(value) ? value.map((v) => String(v)).join("\n") : "";
}

/** A `headers:` / `env:` map as `Name: value` lines — the shape a human types. */
function pairs(value: unknown): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "";
  }
  return Object.entries(value as Record<string, unknown>)
    .map(([k, v]) => `${k}: ${String(v)}`)
    .join("\n");
}

function field(
  label: string,
  control: string,
  hint: string,
  opts: { optional?: boolean; id?: string } = {},
): string {
  return `<div class="field">
    <label class="field-l"${opts.id ? ` for="${esc(opts.id)}"` : ""}>${esc(label)}${
      opts.optional ? ` <span class="field-opt">optional</span>` : ""
    }</label>
    ${control}
    <span class="field-h">${hint}</span>
  </div>`;
}

function input(
  name: string,
  value: string,
  attrs: {
    type?: string;
    id?: string;
    placeholder?: string;
    disabled?: boolean;
    pattern?: string;
  } = {},
): string {
  return `<input class="in" name="${esc(name)}" type="${esc(attrs.type ?? "text")}"${
    attrs.id ? ` id="${esc(attrs.id)}"` : ""
  }${attrs.placeholder ? ` placeholder="${esc(attrs.placeholder)}"` : ""}${
    attrs.pattern ? ` pattern="${esc(attrs.pattern)}"` : ""
  }${attrs.disabled ? " disabled" : ""} value="${esc(value)}" />`;
}

function area(name: string, value: string, rows = 4, id?: string): string {
  return `<textarea class="in" name="${esc(name)}"${id ? ` id="${esc(id)}"` : ""} rows="${rows}">${esc(
    value,
  )}</textarea>`;
}

function checkbox(name: string, checked: boolean, label: string): string {
  return `<label class="field-check"><input type="checkbox" name="${esc(name)}"${
    checked ? " checked" : ""
  } /> ${esc(label)}</label>`;
}

/** `GET /connectors/new` and `GET /connectors/:slug` — one form, two modes. */
export function renderForm(opts: FormOptions): string {
  const entry = opts.entry ?? {};
  const creating = opts.slug === undefined;
  const frozen = new Set(creating ? [] : immutableFields(opts.kind));
  const tools = (entry.tools ?? {}) as Record<string, unknown>;
  const roles = Object.keys(opts.config.roles);
  const entitled = new Set(
    Array.isArray(entry.entitlements) ? entry.entitlements.map(String) : [],
  );

  const copyPicker =
    creating && opts.copyable.length > 0
      ? `<div class="field">
           <label class="field-l" for="copyfrom">Start from an existing ${esc(opts.kind)} <span class="field-opt">optional</span></label>
           <select class="in in-select" id="copyfrom" name="copyFrom" onchange="this.form.submit()">
             <option value="">— blank —</option>
             ${opts.copyable
               .map(
                 (c) =>
                   `<option value="${esc(c.slug)}"${
                     c.slug === opts.copiedFrom ? " selected" : ""
                   }>${esc(c.slug)}${c.title ? ` — ${esc(c.title)}` : ""}</option>`,
               )
               .join("")}
           </select>
           <span class="field-h">Copies every field of that entry except the slug,
           so a second account or a narrower tool policy starts from one that
           already works. Nothing is saved until you press Save.</span>
         </div>`
      : "";

  const copyForm = creating
    ? `<form method="get" action="${esc(connectorsPath("new"))}" class="addform">
         <input type="hidden" name="kind" value="${esc(opts.kind)}" />
         ${copyPicker}
         <noscript><button class="btn btn-ghost" type="submit">Load</button></noscript>
       </form>`
    : "";

  const common = `
${field(
  "Slug",
  input("slug", text(entry.slug ?? ""), {
    id: "slug",
    placeholder: "gmail-personal",
    // The schema's own alphabet, not a second spelling of it.
    pattern: SLUG_PATTERN,
  }),
  `The name a client puts in <code>?servers=</code>, and the prefix on every
   tool this server exposes. Lowercase letters, digits and hyphens. Renaming an
   existing slug moves it; any client naming the old one gets a 424.`,
  { id: "slug" },
)}
${field(
  "Title",
  input("title", text(entry.title ?? ""), { id: "title" }),
  "Shown on the console roster. Purely for humans.",
  { optional: true, id: "title" },
)}
${field(
  "Description",
  input("description", text(entry.description ?? ""), { id: "description" }),
  "One line, for the console. Not sent to any client.",
  { optional: true, id: "description" },
)}
<div class="field">
  <span class="field-l">Roles</span>
  <div class="scope-list">
    ${
      roles.length > 0
        ? roles
            .map((r) => checkbox(`entitlement:${r}`, entitled.has(r), r))
            .join("\n")
        : `<span class="empty">This config declares no roles, so nothing can be entitled to this server.</span>`
    }
  </div>
  <span class="field-h">Which roles may select this server. A token holding
  none of them cannot reach it, whatever it puts in <code>?servers=</code>. A
  server with no role is configured and unreachable.</span>
</div>
<div class="field">
  <span class="field-l">Enabled</span>
  ${checkbox("enabled", entry.enabled !== false, "Serve this server")}
  <span class="field-h">Unchecked leaves the entry in place and stops routing
  it. A client asking for it is told it is disabled rather than that it does not
  exist.</span>
</div>
${field(
  "Timeout (ms)",
  input("timeoutMs", text(entry.timeoutMs ?? ""), {
    id: "timeoutMs",
    type: "number",
  }),
  "How long one call to this upstream may take. Blank uses the 120000ms default.",
  { optional: true, id: "timeoutMs" },
)}
`;

  const policy = `
${field(
  "Tools: allow",
  area("toolsAllow", lines(tools.allow), 4, "toolsAllow"),
  `One tool name per line. An allow list is EXHAUSTIVE — a tool not named here
   is refused on <code>tools/call</code> and hidden from <code>tools/list</code>,
   so a tool the upstream renames silently disappears. Leave blank to allow
   everything the upstream serves.`,
  { optional: true, id: "toolsAllow" },
)}
${field(
  "Tools: deny",
  area("toolsDeny", lines(tools.deny), 3, "toolsDeny"),
  "One tool name per line, subtracted from whatever the allow list left. Use this when you want everything except a handful.",
  { optional: true, id: "toolsDeny" },
)}
${field(
  "May be unseeded",
  area("mayBeUnseeded", lines(entry.mayBeUnseeded), 2, "mayBeUnseeded"),
  `One <code>\${NAME}</code> per line that this server may deploy WITHOUT. A
   miss on one of these reads as "not configured yet" rather than as a broken
   upstream — which is what keeps a slug shipped ahead of its credential out of
   the failure count.`,
  { optional: true, id: "mayBeUnseeded" },
)}
`;

  const headersField = field(
    "Headers",
    area("headers", pairs(entry.headers), 3, "headers"),
    `One <code>Name: value</code> per line. A value may be a
     <code>\${NAME}</code> ref, resolved from the parameter store on every call
     — so rotating the credential behind it needs no deploy and no restart. Put
     the secret in the store, not here.`,
    { optional: true, id: "headers" },
  );

  const oauthRefresh = (entry.oauthRefresh ?? {}) as Record<string, unknown>;
  const kindFields =
    opts.kind === "remote-http"
      ? `
${field(
  "URL",
  input("url", text(entry.url ?? ""), {
    id: "url",
    placeholder: "https://mcp.example.com/mcp",
  }),
  "The streamable-HTTP MCP endpoint. Re-resolved on every call, so a <code>${NAME}</code> ref here works too.",
  { id: "url" },
)}
${headersField}
<h2 class="conn-sub">OAuth refresh <span class="field-opt">optional</span></h2>
<p class="state-sub">For an upstream that issues short-lived access tokens.
strad holds the refresh token, mints a bearer before each call, and writes a
rotated refresh token back to the store itself — so an authorization done once
outlives its access token. Leave the token URL blank to skip this entirely.</p>
${field(
  "Token URL",
  input("oauthTokenUrl", text(oauthRefresh.tokenUrl ?? ""), {
    id: "oauthTokenUrl",
  }),
  "The provider's token endpoint. https, or http to loopback.",
  { optional: true, id: "oauthTokenUrl" },
)}
${field(
  "Client ID",
  input("oauthClientId", text(oauthRefresh.clientId ?? ""), {
    id: "oauthClientId",
  }),
  "Literal, or a <code>${NAME}</code> ref.",
  { optional: true, id: "oauthClientId" },
)}
${field(
  "Client secret",
  input("oauthClientSecret", text(oauthRefresh.clientSecret ?? ""), {
    id: "oauthClientSecret",
  }),
  `Must be exactly one <code>\${NAME}</code> — a literal here would put a
   credential in the config document. Create the parameter on this server's
   secrets page first.`,
  { optional: true, id: "oauthClientSecret" },
)}
${field(
  "Refresh token",
  input("oauthRefreshToken", text(oauthRefresh.refreshToken ?? ""), {
    id: "oauthRefreshToken",
  }),
  `Also exactly one <code>\${NAME}</code>. This is where the OAuth flow's result
   lands: authorize the other account, store the refresh token under that name,
   and name it here. Two servers may not share one.`,
  { optional: true, id: "oauthRefreshToken" },
)}
${field(
  "Client auth",
  `<select class="in in-select" name="oauthClientAuth" id="oauthClientAuth">
     ${["basic", "post"]
       .map(
         (v) =>
           `<option value="${v}"${oauthRefresh.clientAuth === v ? " selected" : ""}>${v}</option>`,
       )
       .join("")}
   </select>`,
  "How the client credentials are presented to the token endpoint. <code>basic</code> unless the provider says otherwise.",
  { optional: true, id: "oauthClientAuth" },
)}
${field(
  "Scope",
  input("oauthScope", text(oauthRefresh.scope ?? ""), { id: "oauthScope" }),
  "Sent with the refresh grant, when the provider wants one.",
  { optional: true, id: "oauthScope" },
)}
${field(
  "Resource",
  input("oauthResource", text(oauthRefresh.resource ?? ""), {
    id: "oauthResource",
  }),
  "RFC 8707 resource indicator, when the provider wants one.",
  { optional: true, id: "oauthResource" },
)}
`
      : opts.kind === "local-tunnel"
        ? `
${field(
  "URL",
  input("url", text(entry.url ?? ""), {
    id: "url",
    placeholder: "https://tunnel.example.com/",
  }),
  "Where the tunnel terminates. The machine behind it is usually NOT there, and that is the case this kind exists to handle well.",
  { id: "url" },
)}
${headersField}
${field(
  "Connect timeout (ms)",
  input("connectTimeoutMs", text(entry.connectTimeoutMs ?? ""), {
    id: "connectTimeoutMs",
    type: "number",
  }),
  "How long to wait for the machine before calling it absent. Short on purpose — blank uses 5000ms.",
  { optional: true, id: "connectTimeoutMs" },
)}
${field(
  "Recovery: machine",
  input(
    "recoveryMachine",
    text(
      (entry.recovery as Record<string, unknown> | undefined)?.machine ?? "",
    ),
    { id: "recoveryMachine" },
  ),
  "Whose machine this is. Shown to a caller when the upstream is unreachable, in strad's own words rather than a transport error.",
  { optional: true, id: "recoveryMachine" },
)}
${field(
  "Recovery: commands",
  area(
    "recoveryCommands",
    lines((entry.recovery as Record<string, unknown> | undefined)?.commands),
    3,
    "recoveryCommands",
  ),
  "One command per line — what to run on that machine to bring it back.",
  { optional: true, id: "recoveryCommands" },
)}
${field(
  "Recovery: notes",
  area(
    "recoveryNotes",
    lines((entry.recovery as Record<string, unknown> | undefined)?.notes),
    2,
    "recoveryNotes",
  ),
  "One note per line.",
  { optional: true, id: "recoveryNotes" },
)}
`
        : `
${field(
  "Image",
  input("image", text(entry.image ?? ""), {
    id: "image",
    disabled: frozen.has("image"),
  }),
  `The container image the component runs. ${
    frozen.has("image")
      ? "Fixed here: the component is already running this image, and only a deploy replaces it."
      : "Must be the image the chosen bundle already runs — a second image on one bundle is refused."
  }`,
  { id: "image" },
)}
${field(
  "Bundle",
  `<select class="in in-select" name="bundle" id="bundle"${frozen.has("bundle") ? " disabled" : ""}>
     ${opts.config.bundles
       .map(
         (b) =>
           `<option value="${esc(b.name)}"${entry.bundle === b.name ? " selected" : ""}>${esc(b.name)}</option>`,
       )
       .join("")}
   </select>`,
  "Which App Platform component serves it. Only a component this deployment already runs can be chosen — a new one is a deploy.",
  { id: "bundle" },
)}
${field(
  "Path",
  input("path", text(entry.path ?? ""), { id: "path", placeholder: "/gmail" }),
  `The mount inside that container. It has to be a mount the image ALREADY
   serves — pointing at a path nothing answers gives a slug that lists no tools.
   Copy it from an existing entry for the same upstream.`,
  { id: "path" },
)}
${headersField}
<p class="state-sub">Credentials for this mount come from the deploy, not from
here: <code>env:</code>, <code>params:</code> and the store declarations are
baked onto the container when the app spec is rendered, and a running container
cannot be handed a new variable. An entry added here therefore reuses the
credentials the mount already has — which is exactly what a second entry with a
narrower <code>tools:</code> policy wants.</p>
`;

  const frozenNote =
    !creating && frozen.size > 1
      ? `<p class="state-sub">Greyed-out fields are the ones only a deploy can
         move on a ${esc(opts.kind)} server: ${esc(
           [...frozen].filter((f) => f !== "kind").join(", "),
         )}. Change them in the checked-in config.</p>`
      : "";

  const body = `
${flashHtml(opts.flash)}
<section class="panel">
  <div class="breadcrumb"><a class="crumb" href="${esc(CONNECTORS_PREFIX)}">Connectors</a><span class="crumb-sep">/</span><span class="crumb crumb-current">${esc(
    creating ? `new ${opts.kind}` : (opts.slug ?? ""),
  )}</span></div>
  <h1 class="state-title">${esc(creating ? `Add a ${opts.kind} connector` : `Edit ${opts.slug ?? ""}`)}</h1>
  <p class="state-sub">${esc(KIND_BLURB[opts.kind] ?? "")}</p>
  ${frozenNote}
  ${
    !creating && opts.source === "file"
      ? `<p class="state-sub">This entry comes from the checked-in config. Saving
         it here writes a console copy that overrides the file until someone
         removes it — the file is still what a fresh deployment starts from.</p>`
      : ""
  }
</section>
${copyForm}
<section class="addbox">
  <form method="post" action="${esc(connectorsPath("save"))}" class="addform conn-form">
    <input type="hidden" name="kind" value="${esc(opts.kind)}" />
    <input type="hidden" name="revision" value="${esc(String(opts.revision))}" />
    ${opts.slug === undefined ? "" : `<input type="hidden" name="original" value="${esc(opts.slug)}" />`}
    ${common}
    ${kindFields}
    ${policy}
    <div class="field">
      <button class="btn btn-primary" type="submit">Save</button>
      <span class="field-h">Saved changes are validated against the whole
      config — every cross-entry rule, not just this form — and take effect on
      the next request. Nothing is written if validation fails.</span>
    </div>
  </form>
</section>
`;

  return layout({
    title: creating ? "Add a connector" : `Edit ${opts.slug ?? ""}`,
    body,
    signedInAs: opts.signedInAs,
    brandHref: "/ui",
    brandSub: "connectors",
    serverSlug: opts.slug,
    footNote: "runtime roster · takes effect without a deploy",
    helpTitle: "Connector guide",
    help: GUIDE,
  });
}

const GUIDE = `
<p>This page edits the gateway's <strong>server roster</strong> at runtime. A
change here is stored in the parameter store and applied to the running process
— no deploy, no restart.</p>
<h3>What can be added, and what cannot</h3>
<ul>
  <li><strong>remote-http</strong> and <strong>local-tunnel</strong> — fully.
  Nothing of strad's runs for them, so an entry saved here is routable on the
  next request.</li>
  <li><strong>supplementary-image</strong> — a new slug pointed at a mount this
  deployment is <em>already running</em>. Its credentials are baked onto the
  container by the deploy, so an entry added here reuses what the mount already
  has. That is how one upstream becomes a read-only and a read-write slug.</li>
  <li><strong>builtin</strong> — never. The module is imported out of the
  running image, so it has to ship with a build.</li>
</ul>
<h3>Where the file fits</h3>
<p>The checked-in config stays authoritative for everything nobody has touched.
This page stores a <em>diff</em> over it: entries added, entries overridden,
entries removed. Remove a console entry and the file's version comes back;
remove a file entry and the removal is remembered until someone re-adds it.</p>
<h3>Credentials</h3>
<p>No secret is typed into this form. Anything credential-shaped is a
<code>\${NAME}</code> ref, created on the server's own secrets page and
resolved from the store on every call — which is what lets it rotate without a
deploy.</p>
<h3>If a save is refused</h3>
<p>The whole merged config is validated, so a refusal can name a rule about a
<em>different</em> entry: a duplicate slug, a role nothing declares, two servers
minting from one refresh token. Nothing is written and nothing changes until it
passes.</p>
`;
