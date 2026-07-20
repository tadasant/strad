import type { ServerConfig, StradConfig } from "../config/schema.ts";
import { esc, layout, serverLooksGcs } from "./render.ts";

/**
 * The front door: `/`.
 *
 * strad's addressable surface is one endpoint plus a query string, which is
 * exactly the property that makes it hard to remember. `/mcp?servers=slack-readonly`
 * is not discoverable by looking at it, and neither is the fact that `gcs` has a
 * browser view while `deepwiki` does not. This page is the index that makes the
 * gateway navigable from a bookmark of its own hostname.
 *
 * IT IS GATED, like every other human surface. strad's model is that Google
 * identity comes before anything is exposed, and an index of what this gateway
 * fronts — the slugs, what each is, which have a browser view — is something.
 * The route sits behind `requireConsoleUi` in `src/ui/index.ts`, the same gate as
 * `/ui` and `/console`: today the bootstrap-token wall, and `hostedDomain`-checked
 * Google SSO (tadasant.com) the moment the OAuth credentials land, with no change
 * needed here. This page only ever asks whether the gate resolved a Principal.
 *
 * That gate is the security boundary, so the tile contents are a UX decision
 * rather than a disclosure one. They are still kept narrow, because there is no
 * reason for a directory to carry credentials: no `url`, `headers:`, `env:`,
 * `image`, `bundle`, `path`, `module`, `tools:` policy, or `entitlements`.
 * test/landing.test.ts asserts each absence — defence in depth behind the gate,
 * and the thing that would have to be revisited before this could ever be opened
 * up.
 *
 * DISABLED servers are not rendered. Not for secrecy — the gate handles that —
 * but because this page answers "what can I connect to", and a connect URL for a
 * disabled server is one the gateway would reject.
 */

export interface LandingOptions {
  config: StradConfig;
  /** Whether the console UI is mounted, i.e. whether `/ui` is worth linking. */
  consoleMounted: boolean;
  /**
   * Origin the request arrived on, e.g. "https://staging.strad.example.com".
   * Used only when `gateway.publicUrl` is unset.
   */
  requestOrigin?: string;
  /** Identity the gate resolved, shown in the header. */
  signedInAs?: string;
}

export function renderLanding(opts: LandingOptions): string {
  const { config } = opts;
  const gateway = config.gateway;
  // publicUrl is optional in the schema, and the entire point of this panel is a
  // string you can paste into an MCP client. A relative "/mcp" is pasteable
  // nowhere, so fall back to the origin the request actually arrived on — the app
  // sets `trust proxy`, so behind App Platform that is the public hostname.
  // Config still wins: it is the deployment's own declaration of where it lives.
  const base = (gateway.publicUrl ?? opts.requestOrigin ?? "").replace(
    /\/$/,
    "",
  );
  const mcpUrl = `${base}/mcp`;

  // Disabled servers are omitted — see the header comment. A connect URL for
  // one is a URL the gateway would reject.
  const enabled = config.servers.filter((s) => s.enabled);

  const body = `
<section class="intro">
  <h1>${esc(gateway.name)} <span class="env-badge">${esc(gateway.env)}</span></h1>
  <p class="lede">One MCP endpoint in front of ${enabled.length} server${
    enabled.length === 1 ? "" : "s"
  }. Point a client at the endpoint below and select
    servers with <code>?servers=</code>, or browse the human consoles.</p>
</section>

<section class="panel">
  <div class="panel-head">
    <h2>Endpoint</h2>
    <span class="panel-note">Bearer token required</span>
  </div>
  ${copyRow(mcpUrl, "The whole gateway — every server you are entitled to.")}
  ${copyRow(
    `${mcpUrl}?servers=<slug>`,
    "A subset. Comma-separate slugs to pick several.",
  )}
</section>

<section class="panel">
  <div class="panel-head"><h2>Consoles</h2></div>
  <div class="card-grid">
${consoleCards(opts.consoleMounted).join("\n")}
  </div>
</section>

<section class="panel">
  <div class="panel-head">
    <h2>Servers</h2>
    <span class="panel-note">${enabled.length} enabled</span>
  </div>
${
  enabled.length
    ? `  <div class="card-grid">
${enabled.map((s) => serverTile(s, mcpUrl)).join("\n")}
  </div>`
    : `  <p class="empty">No servers are enabled on this gateway.</p>`
}
</section>
${COPY_SCRIPT}`;

  return layout({
    // layout() already suffixes " · strad", so passing gateway.name here would
    // render "strad · strad" on the common configuration.
    title: `${gateway.env} gateway`,
    body,
    signedInAs: opts.signedInAs,
    brandHref: "/",
    brandSub: "gateway",
    footNote: "SSO-gated · humans only",
  });
}

/** A copyable URL. Without JS the input is still visible and selectable. */
function copyRow(url: string, note: string): string {
  return `
  <div class="copy-row">
    <input class="copy-url" readonly value="${esc(url)}" aria-label="${esc(url)}" />
    <button class="copy-btn" type="button" data-copy>Copy</button>
  </div>
  <p class="copy-note">${esc(note)}</p>`;
}

function consoleCards(consoleMounted: boolean): string[] {
  const cards = [
    {
      href: "/ui",
      title: "Resource browser",
      desc: "Browse what each server is scoped to — buckets, objects, parameters. SSO-gated.",
      cta: "Open →",
      show: consoleMounted,
    },
    {
      href: "/console",
      title: "Sign in",
      desc: "The console session endpoint. Google SSO when configured, bootstrap token otherwise.",
      cta: "Sign in →",
      show: consoleMounted,
    },
    {
      href: "/healthz",
      title: "Health",
      desc: "Liveness, mode, environment, and the list of servers this process actually mounted.",
      cta: "Check →",
      show: true,
    },
  ];

  return cards
    .filter((c) => c.show)
    .map(
      (c) => `    <a class="card card-link" href="${c.href}">
      <div class="card-head"><span class="card-title">${esc(c.title)}</span></div>
      <p class="card-desc">${esc(c.desc)}</p>
      <div class="card-foot"><code>${esc(c.href)}</code><span class="card-cta">${esc(c.cta)}</span></div>
    </a>`,
    );
}

/**
 * One server.
 *
 * The connect URL is NOT rendered as a visible field here. It is the same 40-odd
 * characters on every tile with only the slug varying, so showing it 26 times
 * both drowns the page and — at tile width — truncates to `https://staging.st…`,
 * hiding the one part that differs. The slug is displayed; the full URL rides on
 * the button's data attribute and arrives on the clipboard, which is what anyone
 * actually wants from it.
 */
function serverTile(server: ServerConfig, mcpUrl: string): string {
  const title = server.title ?? server.slug;
  const desc = server.description ?? "";
  const browsable = serverLooksGcs(server);
  const selectUrl = `${mcpUrl}?servers=${encodeURIComponent(server.slug)}`;

  return `    <div class="card server-tile">
      <div class="card-head">
        <span class="card-title">${esc(title)}</span>
        <span class="chip chip-${esc(server.kind)}">${esc(server.kind)}</span>
      </div>
      ${desc ? `<p class="card-desc">${esc(desc)}</p>` : ""}
      ${
        // Most servers declare no `title:`, so the heading IS the slug. Printing
        // it again underneath is noise on the majority of tiles.
        title === server.slug
          ? ""
          : `<div class="tile-slug"><code>${esc(server.slug)}</code></div>`
      }
      <div class="tile-actions">
        <button class="btn-ghost" type="button" data-copy data-url="${esc(selectUrl)}"
          title="${esc(selectUrl)}">Copy URL</button>
        ${
          browsable
            ? `<a class="card-cta" href="/ui/${encodeURIComponent(server.slug)}">Browse →</a>`
            : ""
        }
      </div>
    </div>`;
}

/**
 * Progressive enhancement, not an SPA.
 *
 * Without JS the endpoint fields are still readable and selectable, and each
 * tile's button still carries the URL in its `title` tooltip — degraded, but not
 * broken. With JS, one click copies. Two sources because the endpoint panel
 * shows its URL in an input and a tile keeps it in `data-url`.
 */
const COPY_SCRIPT = `<script>
document.addEventListener("click", function (e) {
  var btn = e.target.closest("[data-copy]");
  if (!btn) return;
  var input = btn.parentElement.querySelector(".copy-url");
  var text = btn.getAttribute("data-url") || (input && input.value);
  if (!text) return;
  if (input) input.select();
  var done = function () {
    var was = btn.textContent;
    btn.textContent = "Copied";
    setTimeout(function () { btn.textContent = was; }, 1200);
  };
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(done, function () {});
  } else if (input && document.execCommand("copy")) {
    done();
  }
});
</script>`;
