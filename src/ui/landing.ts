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
 * WHAT IT DELIBERATELY DOES NOT DO: it is a directory, not a door. Every link on
 * it lands on a surface that enforces its own gate — `/mcp` still demands a
 * system token, `/ui` still demands console SSO. Listing a server here grants
 * nothing.
 *
 * WHY IT IS PUBLIC. It reveals the set of configured slugs, which `/healthz`
 * already returns unauthenticated to anyone who asks, so this adds no disclosure
 * that the gateway did not already make. What it does NOT publish is the part
 * that would be new: a `remote-http` server's upstream `url`, any `headers:`,
 * the `env:`/`consoleEnv:` maps, and the `entitlements` — i.e. everything that
 * says how to reach a server or who may. Keep it that way. If this gateway ever
 * wants the slug list itself to be private, gating this route is one line in
 * `src/http/app.ts` — but `/healthz` has to be dealt with in the same breath, or
 * the tightening is theatre.
 */

export interface LandingOptions {
  config: StradConfig;
  /** Whether the console UI is mounted, i.e. whether `/ui` is worth linking. */
  consoleMounted: boolean;
}

export function renderLanding(opts: LandingOptions): string {
  const { config } = opts;
  const gateway = config.gateway;
  // publicUrl is optional in the schema. Falling back to a relative path keeps
  // every link on this page correct even when it is unset — a copyable absolute
  // URL is nicer, but a wrong one is worse than a relative one.
  const base = (gateway.publicUrl ?? "").replace(/\/$/, "");
  const mcpUrl = `${base}/mcp`;

  const enabled = config.servers.filter((s) => s.enabled);
  const disabled = config.servers.filter((s) => !s.enabled);

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
    <span class="panel-note">${enabled.length} enabled${
      disabled.length ? ` · ${disabled.length} disabled` : ""
    }</span>
  </div>
  <div class="card-grid">
${
  enabled.length
    ? enabled.map((s) => serverTile(s, mcpUrl)).join("\n")
    : `<p class="empty">No servers are configured on this gateway.</p>`
}
  </div>
${
  disabled.length
    ? `<details class="disabled-wrap">
  <summary>${disabled.length} disabled server${disabled.length === 1 ? "" : "s"}</summary>
  <div class="card-grid">
${disabled.map((s) => serverTile(s, mcpUrl)).join("\n")}
  </div>
</details>`
    : ""
}
</section>
${COPY_SCRIPT}`;

  return layout({
    // layout() already suffixes " · strad", so passing gateway.name here would
    // render "strad · strad" on the common configuration.
    title: `${gateway.env} gateway`,
    body,
    brandHref: "/",
    brandSub: "gateway",
    footNote: "public directory · every link is gated",
  });
}

/** A copyable URL. Without JS the input is still visible and selectable. */
function copyRow(url: string, note: string): string {
  return `
  <div class="copy-row">
    <input class="copy-url" readonly value="${esc(url)}" aria-label="${esc(url)}" />
    <button class="btn copy-btn" type="button" data-copy>Copy</button>
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
  const browsable = server.enabled && serverLooksGcs(server);
  const selectUrl = `${mcpUrl}?servers=${encodeURIComponent(server.slug)}`;

  return `    <div class="card server-tile">
      <div class="card-head">
        <span class="card-title">${esc(title)}</span>
        <span class="chip chip-${esc(server.kind)}">${esc(server.kind)}</span>
        ${server.enabled ? "" : `<span class="chip chip-off">disabled</span>`}
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
        <button class="btn btn-ghost" type="button" data-copy data-url="${esc(selectUrl)}"
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
