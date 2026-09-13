import type { StradConfig } from "../config/schema.ts";
import { esc, layout } from "./render.ts";
import { NAV_DESTINATIONS } from "./nav.ts";

/**
 * The front door: `/`.
 *
 * strad's addressable surface is one endpoint plus a query string, which is
 * exactly the property that makes it hard to remember. `/mcp?servers=slack-readonly`
 * is not discoverable by looking at it. This page is the splash that makes that
 * one fact findable from a bookmark of the gateway's own hostname, plus the
 * doors into the console — and nothing else.
 *
 * ## Why there is no directory of servers on it
 *
 * There was, and it was the third rendering of the same list. `/connectors` now
 * carries every entry with its scope, its secret status and its controls
 * (src/ui/roster-page.ts), so a tile per slug here was a second, weaker answer
 * to a question one page already answers well — and it was the thing that made
 * the front page three screens long. What is left is what is NOT about any
 * particular server: the endpoint, and where to go next.
 *
 * IT IS GATED, like every other human surface. strad's model is that Google
 * identity comes before anything is exposed, and the endpoint of a gateway plus
 * the count of what sits behind it is something. The route sits behind
 * `requireConsoleUi` in `src/ui/index.ts`, the same gate as `/connectors` and
 * `/console`: today the bootstrap-token wall, and `hostedDomain`-checked Google
 * SSO (tadasant.com) the moment the OAuth credentials land, with no change
 * needed here. This page only ever asks whether the gate resolved a Principal.
 *
 * That gate is the security boundary, so what this page carries is a UX decision
 * rather than a disclosure one. It is still kept narrow, and narrower than it
 * was: no SLUG, and therefore no `url`, `headers:`, `env:`, `image`, `bundle`,
 * `path`, `module`, `tools:` policy, `entitlements`, title or description
 * either. test/landing.test.ts asserts each absence — defence in depth behind
 * the gate, and the thing that would have to be revisited before this could ever
 * be opened up.
 *
 * The one number it prints is how many servers are ENABLED. Disabled ones are
 * not counted: `Registry.build` does not mount them, so they are absent from
 * `/healthz` too, and counting them here would be the one net-new fact on the
 * page.
 */

export interface LandingOptions {
  config: StradConfig;
  /** Whether the console UI is mounted, i.e. whether its doors are worth naming. */
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
  const enabled = config.servers.filter((s) => s.enabled).length;

  const body = `
<section class="intro intro-splash">
  <h1>${esc(gateway.name)} <span class="env-badge">${esc(gateway.env)}</span></h1>
  <p class="lede">One MCP endpoint in front of ${enabled} server${
    enabled === 1 ? "" : "s"
  }. Point a client at it and select
    servers with <code>?servers=</code>.</p>
</section>

<section class="panel panel-first">
  <div class="panel-head">
    <h2>Endpoint</h2>
    <span class="panel-note">Bearer token required</span>
  </div>
  ${copyRow(mcpUrl, "The whole gateway — every server you are entitled to.")}
  ${copyRow(
    `${mcpUrl}?servers=<slug>`,
    "A subset. Comma-separate slugs to pick several; the slugs are on the connectors page.",
  )}
  <p class="copy-note">No credential goes in the URL. The client sends
    <code>Authorization: Bearer …</code>, minted on the tokens page.</p>
</section>

<section class="panel">
  <div class="panel-head"><h2>Console</h2></div>
  <div class="card-grid card-grid-tight">
${doorCards(opts.consoleMounted).join("\n")}
  </div>
</section>
${COPY_SCRIPT}
${LANDING_CSS}`;

  return layout({
    // layout() already suffixes " · strad", so passing gateway.name here would
    // render "strad · strad" on the common configuration.
    title: `${gateway.env} gateway`,
    body,
    signedInAs: opts.signedInAs,
    nav: "gateway",
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

/**
 * The doors.
 *
 * One per destination the shared nav bar names (src/ui/nav.ts) except this page
 * itself, plus the two the bar deliberately does not carry — the sign-in
 * endpoint and `/healthz`. The bar is chrome and a tile is a sentence about what
 * the page is for, so they are written separately; `test/landing.test.ts` is
 * what keeps a destination added to the bar from going missing here.
 *
 * One SENTENCE each, not a paragraph. The long-form descriptions were written
 * when this page was the only index of anything; the page they describe now says
 * all of it in its own words, one click away, and a splash whose tiles need
 * scrolling is not a splash.
 */
const DOOR_BLURB: Record<string, string> = {
  "/connectors":
    "Every server: what it is scoped to, whether its secrets are seeded, and — where the roster is editable — how to change it.",
  "/playground":
    "A human MCP client, one server at a time. No model is involved, and a call runs for real.",
  "/tokens":
    "The credentials /mcp accepts: mint one, see which are live, revoke one that should not be.",
};

function doorCards(consoleMounted: boolean): string[] {
  const cards = [
    ...NAV_DESTINATIONS.filter((d) => d.key !== "gateway").map((d) => ({
      href: d.href,
      title: d.label,
      desc: DOOR_BLURB[d.href] ?? d.hint,
      show: consoleMounted,
    })),
    {
      href: "/console",
      title: "sign in",
      desc: "The console session endpoint. Google SSO when configured, bootstrap token otherwise.",
      show: consoleMounted,
    },
    {
      href: "/healthz",
      title: "health",
      desc: "Liveness, mode, environment, and the list of servers this process actually mounted.",
      show: true,
    },
  ];

  return cards
    .filter((c) => c.show)
    .map(
      (c) => `    <a class="card card-link card-door" href="${c.href}">
      <div class="card-head"><span class="card-title">${esc(c.title)}</span><span class="card-cta">→</span></div>
      <p class="card-desc">${esc(c.desc)}</p>
    </a>`,
    );
}

/**
 * Progressive enhancement, not an SPA.
 *
 * Without JS the endpoint fields are still readable and selectable — degraded,
 * but not broken. With JS, one click copies.
 */
export const COPY_SCRIPT = `<script>
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

/**
 * Page-local styles: the splash's own proportions.
 *
 * Everything here narrows or tightens something the shared theme sets for pages
 * that carry a working surface. The tokens are the theme's, so the splash cannot
 * drift from the rest of the console.
 */
const LANDING_CSS = `<style>
.intro-splash .lede{margin-bottom:.9rem}
/* The ?servers= token reads as two when it breaks across a line. */
.intro-splash .lede code,.copy-note code{white-space:nowrap}
/* The first panel sits under the lede rather than a screen below it: on this
   page the endpoint IS the content, and .panel's 2.1rem is spacing between
   sections of a long page. */
.panel-first{margin-top:.4rem}
.card-door .card-head{justify-content:space-between}
</style>`;
