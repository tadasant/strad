import { CONNECTORS_PREFIX } from "./paths.ts";

/**
 * The console's shared navigation bar — every top-level destination, in one
 * place, rendered by `layout()` on every page.
 *
 * ## Why it exists
 *
 * A console whose pages each link only to themselves is a console you can only
 * use by knowing its URLs, and a human who bookmarks one page has no way to
 * discover the other three. The cure is a bar every page draws from the SAME
 * list: a destination added here appears everywhere at once, and no page can
 * quietly disagree with its siblings about what this console can do.
 *
 * ## What is in it, and what is not
 *
 * Top-level destinations only — a page a human would bookmark. A per-server or
 * per-action route (`/ui/:server`, `/playground/:server`, `/connectors/:slug`,
 * `/tokens/mint`, the `/console/*` auth endpoints, the `/ui` and `/secrets`
 * redirects) is NOT one: it is a page you arrive at from a destination, and it
 * marks that destination active rather than adding a fifth item. `active` is
 * therefore a SECTION, not a URL — `/ui/slack` and `/connectors` both light up
 * "connectors".
 *
 * ## Why there is one servers destination and not two
 *
 * There were two, and they were the same list of servers answering different
 * questions: `/ui` said what each server is scoped to and whether its secrets
 * resolve, `/connectors` added, edited and removed the entries. Nobody wants
 * either in isolation — you read the status in order to decide what to change —
 * so the status is on the entry now and `/ui` is a redirect. `/` keeps its place
 * as the front door and is a splash: the endpoint to paste into a client, and
 * the doors into the console.
 *
 * ## Why it is not conditional
 *
 * `/connectors` answers on every deployment: with the roster, the per-server
 * secret status and the editor when `gateway.configStore.enabled` is set, and
 * with the roster and the status alone when it is not (src/ui/servers.ts).
 * Shaping the bar around that flag would mean threading it into every render
 * function — including the message and error pages, which hold no config — to
 * buy a bar that is one item shorter on some deployments and, on the pages that
 * could not be told, wrong. A bar with a fixed shape is one a reader can learn.
 *
 * The bar is omitted entirely on the pages reached WITHOUT a console session —
 * the sign-in refusal, the offline shell, and the `/mcp` OAuth consent and
 * refusal screens (src/ui/oauth-consent.ts). Every link in it is gated, so on
 * those pages it would advertise four doors that answer 401.
 *
 * No `esc()` here on purpose: every label and href below is a literal in this
 * module, and keeping it free of `src/ui/render.ts` is what lets render.ts
 * import this one for its CSS without a cycle.
 */

/** A top-level console destination. The page it names marks itself active. */
export type NavKey = "gateway" | "connectors" | "playground" | "tokens";

export interface NavDestination {
  key: NavKey;
  href: string;
  label: string;
  /** The `title=` tooltip: one line on what the page is for. */
  hint: string;
}

/**
 * Every top-level destination, in reading order.
 *
 * `gateway` first because it is the front door — the endpoint to paste into a
 * client. The three working surfaces follow in the order a human meets them:
 * what is configured and how to change it, how to try it, and what may call it.
 */
export const NAV_DESTINATIONS: readonly NavDestination[] = [
  {
    key: "gateway",
    href: "/",
    label: "gateway",
    hint: "The endpoint to paste into an MCP client",
  },
  {
    key: "connectors",
    href: CONNECTORS_PREFIX,
    label: "connectors",
    hint: "Every server: its scope, whether its secrets are seeded, and the roster editor",
  },
  {
    key: "playground",
    href: "/playground",
    label: "playground",
    hint: "Open a server by hand: list its tools and call one",
  },
  {
    key: "tokens",
    href: "/tokens",
    label: "tokens",
    hint: "Mint and revoke the credentials /mcp accepts",
  },
];

export function renderNav(active?: NavKey): string {
  const links = NAV_DESTINATIONS.map((d) => {
    const on = d.key === active;
    return `<a class="navlink${on ? " navlink-on" : ""}" href="${d.href}" title="${d.hint}"${
      on ? ` aria-current="page"` : ""
    }>${d.label}</a>`;
  }).join("");

  return `<nav class="mainnav" aria-label="Console sections"><div class="mainnav-inner">${links}</div></nav>`;
}

/**
 * The bar's styling, spliced into `THEME_CSS` (src/ui/render.ts) rather than
 * kept as a second stylesheet — the console has one theme and one place it is
 * written down.
 *
 * It scrolls horizontally rather than wrapping: a bar that reflows to two rows
 * moves the page content down by a different amount on every device, and the
 * labels are long enough that four of them can still overflow a 360px phone.
 * The scrollbar is hidden because the items are legible enough to show there is
 * more to the right.
 */
export const NAV_CSS = `
.mainnav{border-top:1px solid var(--g5)}
.mainnav-inner{max-width:60rem;margin:0 auto;padding:0 1.5rem;display:flex;
  gap:.1rem;overflow-x:auto;scrollbar-width:none;-ms-overflow-style:none}
.mainnav-inner::-webkit-scrollbar{display:none}
.navlink{white-space:nowrap;color:var(--g2);font-size:.86rem;font-weight:500;
  padding:.55rem .7rem;border-bottom:2px solid transparent;
  transition:color .15s ease,border-color .15s ease}
.navlink:hover{color:var(--white);border-bottom-color:var(--g4)}
.navlink-on{color:var(--text-accent);border-bottom-color:var(--accent)}
@media (max-width:34rem){
  .mainnav-inner{padding:0 .75rem}
  .navlink{padding:.5rem .4rem;font-size:.82rem}
}
`;
