import { esc, layout } from "./render.ts";
import { CONNECTORS_PREFIX, connectorsPath } from "./paths.ts";
import {
  INSTANCE_PATH_PREFIX,
  INSTANCE_TREES,
} from "../secrets/param-route.ts";
import { SLUG_PATTERN, type StradConfig } from "../config/schema.ts";
import type { EntrySource } from "../config/overlay.ts";
import { immutableFields } from "../config/overlay.ts";
import { CREDENTIAL_SCHEMES } from "../config/secret-position.ts";

/**
 * The connector ENTRY FORM — `/connectors/new` and `/connectors/<slug>`.
 *
 * The roster it belongs to is src/ui/roster-page.ts: one page listing every
 * server with its scope, its secret status and these controls. This file is the
 * form you land on from a row, and the two shared pieces the roster needs from
 * it — the flash markup and the per-kind blurb.
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

export interface Flash {
  tone: "ok" | "error";
  message: string;
  /** Validation problems, one per line, shown under the message. */
  detail?: string[];
}

/**
 * The flash the write paths hand back, shown at the top of whichever page
 * re-renders. Exported because the roster it lands on is rendered by
 * src/ui/roster-page.ts, which is where the servers view lives.
 */
export function flashHtml(flash: Flash | undefined): string {
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

/**
 * `KIND_BLURB[kind]` with no prototype members.
 *
 * `kind` arrives from the wire, and a plain index lookup resolves `toString`
 * and friends out of `Object.prototype` — so a POST with `kind=toString`
 * renders a native-function body as the page's subtitle. Escaped, so it is
 * cosmetic rather than an injection; still not something to ship.
 *
 * Exported because the "add a connector" menu is on the roster page, which is
 * src/ui/roster-page.ts, and one blurb per kind is one blurb per kind.
 */
export function kindBlurb(kind: string): string {
  return Object.hasOwn(KIND_BLURB, kind) ? (KIND_BLURB[kind] ?? "") : "";
}

export interface FormOptions {
  config: StradConfig;
  /**
   * Whether the checked-in config declares this slug.
   *
   * True locks the role checkboxes and the two tools fields, because
   * `assertNoAccessControlChange` will refuse a write that moves them. A form
   * that offers a control the save path rejects is a form that wastes the
   * human's typing and teaches them the page is unreliable.
   */
  accessLocked?: boolean;
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

/**
 * One labelled form row.
 *
 * `control` and `hint` are PRE-ESCAPED HTML built by this module — the hints
 * carry `<code>` spans on purpose — and `label` is escaped here. That split is
 * the same one `layout`'s `help` makes in src/ui/render.ts, and it carries the
 * same warning: never pass caller-supplied text as `control` or `hint`. Every
 * value that came off the wire reaches this function through `input`, `area` or
 * `checkbox`, each of which escapes it.
 */
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

function area(
  name: string,
  value: string,
  rows = 4,
  id?: string,
  disabled = false,
): string {
  return `<textarea class="in" name="${esc(name)}"${id ? ` id="${esc(id)}"` : ""} rows="${rows}"${
    disabled ? " disabled" : ""
  }>${esc(value)}</textarea>`;
}

function checkbox(
  name: string,
  checked: boolean,
  label: string,
  disabled = false,
): string {
  return `<label class="field-check"><input type="checkbox" name="${esc(name)}"${
    checked ? " checked" : ""
  }${disabled ? " disabled" : ""} /> ${esc(label)}</label>`;
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
            .map((r) =>
              checkbox(
                `entitlement:${r}`,
                entitled.has(r),
                r,
                opts.accessLocked,
              ),
            )
            .join("\n")
        : `<span class="empty">This config declares no roles, so nothing can be entitled to this server.</span>`
    }
  </div>
  <span class="field-h">Which roles may select this server. A token holding
  none of them cannot reach it, whatever it puts in <code>?servers=</code>. A
  server with no role is configured and unreachable.${
    opts.accessLocked
      ? ` <strong>Fixed here:</strong> the checked-in config declares this
         server, and who reaches it stays with the deploy. Change it there, or
         point a new slug at the same upstream.`
      : ""
  }</span>
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
  area("toolsAllow", lines(tools.allow), 4, "toolsAllow", opts.accessLocked),
  `One tool name per line. An allow list is EXHAUSTIVE — a tool not named here
   is refused on <code>tools/call</code> and hidden from <code>tools/list</code>,
   so a tool the upstream renames silently disappears. Leave blank to allow
   everything the upstream serves.${
     opts.accessLocked
       ? ` <strong>Fixed here:</strong> the checked-in config declares this
          server, so its tool policy stays with the deploy.`
       : ""
   }`,
  { optional: true, id: "toolsAllow" },
)}
${field(
  "Tools: deny",
  area("toolsDeny", lines(tools.deny), 3, "toolsDeny", opts.accessLocked),
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
    `One <code>Name: value</code> per line. Each value must be one
     <code>\${NAME}</code> ref, optionally after an auth scheme
     (${CREDENTIAL_SCHEMES.map((scheme) => `<code>${esc(scheme)}</code>`).join(", ")}) — for example
     <code>Authorization: Bearer \${GRANOLA_TOKEN}</code>. A runtime write stores
     the reference and never the value, and the ref is resolved from the
     parameter store on every call, so rotating the credential behind it needs
     no deploy and no restart. A literal is refused here, including one that is
     not a secret — strad cannot tell the difference, so put that in the store
     too, as an ordinary non-secret parameter.`,
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
  `The streamable-HTTP MCP endpoint. Re-resolved on every call, so a
   <code>\${NAME}</code> ref here works too. A <code>user:password@</code> before
   the host is refused — send it as <code>Authorization: Basic \${NAME}</code>.`,
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
  `Where the tunnel terminates. The machine behind it is usually NOT there, and
   that is the case this kind exists to handle well. A
   <code>user:password@</code> before the host is refused — send it as a header.`,
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
        : opts.kind === "builtin"
          ? `<p class="state-sub">A builtin's <code>module:</code>, <code>bundle:</code>
             and <code>params:</code> are what the running image compiled in, so
             they are not editable here at all — only the fields above, which the
             gateway decides for itself on every request. Change the rest in the
             checked-in config and deploy.</p>`
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
  input("path", text(entry.path ?? ""), {
    id: "path",
    placeholder: "/gmail",
    disabled: frozen.has("path"),
  }),
  frozen.has("path")
    ? `The mount inside that container. Fixed here: it chooses which upstream
       this slug reaches, and the credential at the other end belongs to the
       container rather than to this entry — so re-pointing it would reach a
       server this entry's roles were never granted. Point a new slug at the
       mount you want instead.`
    : `The mount inside that container. It has to be a mount the image ALREADY
       serves — pointing at a path nothing answers gives a slug that lists no
       tools. Copy it from an existing entry for the same upstream.`,
  { id: "path" },
)}
${headersField}
<p class="state-sub">Credentials for an ordinary mount come from the deploy, not
from here: <code>env:</code>, <code>params:</code> and the store declarations are
baked onto the container when the app spec is rendered, and a running container
cannot be handed a new variable. An entry added here therefore reuses the
credentials the mount already has — which is exactly what a second entry with a
narrower <code>tools:</code> policy wants.</p>
<p class="state-sub">The exception is a store-served instance:
<code>path: ${INSTANCE_PATH_PREFIX}/{tree}/{this slug}</code> with
<code>params: true</code>, for ${INSTANCE_TREES.join(", ")}. It is credentialed
from this slug's own namespace — seed it on the slug's secrets page first — and
served on its first request, with no deploy.</p>
`;

  const frozenNote =
    !creating && frozen.size > 1
      ? `<p class="state-sub">Greyed-out fields are the ones a runtime write may
         not move on a ${esc(opts.kind)} server: ${esc(
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
  <p class="state-sub">${esc(kindBlurb(opts.kind))}</p>
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
    ${
      // Which entry this one was copied from, so the save carries through the
      // fields this form does not render. Without it "copy from an existing
      // one" silently means "copy the fields that happen to have inputs".
      opts.copiedFrom === undefined
        ? ""
        : `<input type="hidden" name="copiedFrom" value="${esc(opts.copiedFrom)}" />`
    }
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
    nav: "connectors",
    brandHref: "/",
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
  <li><strong>supplementary-image, as a store-served instance</strong> —
  <code>path: /_instance/{tree}/{its own slug}</code> with
  <code>params: true</code>, for telegram, google-sheets or grafana. It brings its
  own credential, read from the slug's namespace, so a second account is live on
  its first request with no deploy.</li>
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
