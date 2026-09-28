import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Express, RequestHandler, Request, Response } from "express";
import { asyncRoute, jsonFailure } from "../http/async-route.ts";
import { compileToolPolicies } from "../gateway/toolPolicy.ts";
import { denamespace } from "../gateway/adapters/types.ts";
import { event } from "../telemetry/index.ts";
import {
  consolePrincipal,
  refuseTokenSession,
  signedInLabel,
} from "./console-auth.ts";
import {
  decide,
  requireJson,
  withSession,
  type PlaygroundOptions,
} from "./playground.ts";
import { esc, jsonForScript, renderMessage } from "./render.ts";

/**
 * `/apps/:server` — the console as an MCP Apps HOST.
 *
 * An MCP App is a page a SERVER ships over MCP: a `ui://` resource with
 * mimeType `text/html;profile=mcp-app`, which a host renders in a sandboxed
 * frame and talks to over `postMessage`. The gateway already relays resources
 * (src/gateway/mcpServer.ts), so any MCP-Apps client pointed at `/mcp` can
 * render one. This makes strad's own console one of those clients, which is
 * how a server whose code strad does not hold — a private image, say — gets a
 * page behind the console's sign-in without strad serving that code as its own.
 *
 * ## The page is the server's, so it runs in NO origin at all
 *
 * The frame is `GET /apps/:server/frame`, and its response carries a
 * `Content-Security-Policy` whose `sandbox` directive (without
 * `allow-same-origin`) gives the document an OPAQUE origin — whether it is
 * framed or opened directly. It cannot read the console's cookies or storage,
 * cannot call a console route with the session, and cannot fetch anything
 * (`connect-src 'none'`). Images, fonts and media load only from the
 * `https://` origins the resource declares under `_meta.ui.csp.resourceDomains`
 * (the MCP Apps field for exactly this), and nothing else loads at all.
 *
 * ## Everything it can DO goes through the bridge on this page
 *
 * The host page answers four JSON-RPC methods from its own frame and no other
 * window: `ui/initialize`, `ping`, `ui/open-link` (http(s) only, new tab,
 * no opener) and `tools/call`. A tool call is POSTed to
 * `/apps/:server/tools/call`, which is the playground's call route under
 * another surface name: the signed-in human's own entitlement, the slug's
 * `tools:` policy on the action, `refuseTokenSession`, and the JSON-only CSRF
 * lock. The route re-namespaces every name onto THIS slug, so an app can call
 * its own server's tools and nothing else. It is the same authority the
 * playground page already gives the same human over the same server — the app
 * is a nicer face on it, not a new capability.
 */

/** The MCP Apps mimeType for an HTML UI resource. */
export const MCP_APP_MIME = "text/html;profile=mcp-app";

/** The console URL of one server's app. */
export function appHref(slug: string): string {
  return `/apps/${encodeURIComponent(slug)}`;
}

/**
 * An `https://` origin the CSP may name, or null.
 *
 * Strict because the value is spliced into a header: a `;` or a space would
 * add a directive of the server's choosing. Scheme, host and an optional port,
 * with an optional leading `*.` wildcard label — nothing else survives.
 */
export function cspOrigin(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return /^https:\/\/(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:\d{1,5})?$/i.test(
    value,
  )
    ? value.toLowerCase()
    : null;
}

/** The frame's whole policy. `domains` has already been through `cspOrigin`. */
export function frameCsp(domains: readonly string[]): string {
  const extra = domains.length ? ` ${domains.join(" ")}` : "";
  return [
    "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox",
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    `img-src data: blob:${extra}`,
    `font-src data:${extra}`,
    `media-src data: blob:${extra}`,
    "connect-src 'none'",
    "frame-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-ancestors 'self'",
  ].join("; ");
}

interface AppResource {
  uri: string;
  html: string;
  domains: string[];
  /**
   * The bare name of the tool that declares this UI, when one does. The host
   * page calls it and hands the page its result, as the spec's lifecycle does.
   */
  tool?: string;
  /** Whether that tool is annotated `readOnlyHint: true`. See `autoTool`. */
  toolReadOnly?: boolean;
}

/** `_meta.ui.resourceUri` (or the deprecated flat `ui/resourceUri`), or null. */
export function toolResourceUri(meta: unknown): string | null {
  const m = meta as
    { ui?: { resourceUri?: unknown }; "ui/resourceUri"?: unknown } | undefined;
  const uri = m?.ui?.resourceUri ?? m?.["ui/resourceUri"];
  return typeof uri === "string" && uri.startsWith("ui://") ? uri : null;
}

/** `_meta.ui.visibility`, defaulting to the spec's `["model", "app"]`. */
export function toolVisibility(meta: unknown): string[] {
  const v = (meta as { ui?: { visibility?: unknown } } | undefined)?.ui
    ?.visibility;
  return Array.isArray(v) ? v.map(String) : ["model", "app"];
}

/** `_meta.ui.csp.resourceDomains`, from wherever the resource put it. */
function declaredDomains(...metas: unknown[]): string[] {
  const out = new Set<string>();
  for (const meta of metas) {
    const ui = (meta as { ui?: { csp?: { resourceDomains?: unknown } } })?.ui;
    const list = ui?.csp?.resourceDomains;
    if (!Array.isArray(list)) continue;
    for (const d of list) {
      const origin = cspOrigin(d);
      if (origin) out.add(origin);
    }
  }
  return [...out];
}

/**
 * The server's app, found the way the spec finds one: a TOOL whose
 * `_meta.ui.resourceUri` names it ("Resource Discovery", SEP-1865), fetched
 * with `resources/read`. A server that lists an app resource no tool points at
 * is still rendered — without an initiating tool call. `uri` narrows the
 * choice when a server ships several. Null when it ships none.
 */
async function loadApp(
  client: Client,
  slug: string,
  uri: string | undefined,
): Promise<AppResource | null> {
  const tools = (await client.listTools()).tools;
  const declaring = tools.find((t) => {
    const declared = toolResourceUri(t._meta);
    return declared !== null && (uri === undefined || declared === uri);
  });
  let target = declaring ? toolResourceUri(declaring._meta)! : uri;
  let listedMeta: unknown;
  if (!target) {
    const listed = await client.listResources();
    const entry = listed.resources.find((r) => r.mimeType === MCP_APP_MIME);
    if (!entry) return null;
    target = entry.uri;
    listedMeta = entry._meta;
  }
  const read = await client.readResource({ uri: target });
  for (const content of read.contents) {
    if (content.uri !== target || !("text" in content)) continue;
    if (content.mimeType !== undefined && content.mimeType !== MCP_APP_MIME) {
      continue;
    }
    const parsed = declaring ? denamespace(declaring.name) : null;
    return {
      uri: target,
      html: content.text,
      domains: declaredDomains(listedMeta, content._meta),
      tool: parsed && parsed.slug === slug ? parsed.tool : undefined,
      toolReadOnly: declaring?.annotations?.readOnlyHint === true,
    };
  }
  return null;
}

/**
 * Whether this GET is the console's own navigation, rather than one a link on
 * another site (or an app's popup, whose origin is opaque) started.
 *
 * It matters because loading the host CALLS a tool: the session cookie is
 * SameSite=Lax, so it rides on a cross-site top-level GET, and a link would
 * otherwise run a tool as whoever clicked it. `Sec-Fetch-Site` is absent on old
 * browsers and non-browser clients, which are treated as the console's own.
 */
function sameOriginNavigation(req: Request): boolean {
  const site = req.get("sec-fetch-site");
  return site === undefined || site === "same-origin" || site === "none";
}

/**
 * The tool the host may call on load: the declaring tool, only when it says it
 * changes nothing. A declaring tool that writes waits for the page to ask.
 */
function autoTool(found: AppResource): string | undefined {
  return found.tool && found.toolReadOnly ? found.tool : undefined;
}

/**
 * Every plain link opens a new tab, never the frame itself.
 *
 * The bridge answers the frame's WINDOW, and every document the frame ever
 * holds has the same opaque origin, so a third-party page navigated into it
 * would inherit the bridge. `<base target="_blank">` sends plain links out as
 * popups instead (a popup is a different window and is not answered), and the
 * host tears the bridge down if the frame loads a second document anyway.
 */
export function withBlankTarget(html: string): string {
  const base = '<base target="_blank">';
  // After `<head>`, else after the doctype (ahead of it would put the page in
  // quirks mode), else first.
  const anchor =
    /<head(\s[^>]*)?>/i.exec(html) ?? /^\s*<!doctype[^>]*>/i.exec(html);
  if (anchor) {
    const at = anchor.index + anchor[0].length;
    return html.slice(0, at) + base + html.slice(at);
  }
  return base + html;
}

/**
 * The host page's own policy: nothing may frame it, and IT may frame exactly
 * one path — this slug's frame route.
 *
 * `frame-src` is what makes the bridge's "first document" rule hold without a
 * race. The frame's window is the bridge's only identity, and a document that
 * navigated in (a `target="_self"` link, `location =`, a meta refresh) would
 * run its scripts before the host could notice the second load. Refusing every
 * other URL in the frame means no such document ever loads. The source is
 * scheme-less, so it inherits the page's scheme behind a TLS-terminating proxy;
 * a Host header that is not a plain host[:port] frames nothing.
 */
export function hostCsp(req: Request, slug: string): string {
  const host = req.get("host") ?? "";
  const frame = /^[a-z0-9.-]+(:\d{1,5})?$/i.test(host)
    ? `${host}${appHref(slug)}/frame`
    : "'none'";
  return `frame-ancestors 'none'; frame-src ${frame}`;
}

function queryUri(req: Request): string | undefined {
  return typeof req.query.uri === "string" && req.query.uri.startsWith("ui://")
    ? req.query.uri
    : undefined;
}

export function mountApps(
  app: Express,
  gate: RequestHandler,
  opts: PlaygroundOptions,
): void {
  const policies = compileToolPolicies(opts.config);

  // The host page. Deliberately NOT the console layout: the app is the page,
  // and a phone should spend its screen on it, so the chrome is one thin bar.
  app.get(
    "/apps/:server",
    gate,
    asyncRoute(async (req: Request, res: Response) => {
      const slug = req.params.server ?? "";
      const signedInAs = signedInLabel(res);
      const decision = decide(res, opts.config, slug);
      if (!decision.ok) {
        res
          .status(decision.status)
          .type("html")
          .send(
            renderMessage({
              title: `${slug} · app`,
              signedInAs,
              heading: decision.heading,
              sub: decision.detail,
              tone: "warn",
              nav: "playground",
            }),
          );
        return;
      }
      await withSession(
        req,
        res,
        opts,
        policies,
        async (client, server) => {
          const found = await loadApp(client, server.slug, queryUri(req));
          if (!found) {
            res
              .status(404)
              .type("html")
              .send(
                renderMessage({
                  title: `${server.slug} · app`,
                  signedInAs,
                  heading: "This server ships no app",
                  sub:
                    `${server.slug} lists no ${MCP_APP_MIME} resource, so there ` +
                    `is nothing to render. Its tools are in the playground.`,
                  tone: "info",
                  nav: "playground",
                }),
              );
            return;
          }
          res
            .set("Cache-Control", "no-store")
            .set("Content-Security-Policy", hostCsp(req, server.slug))
            .set("X-Frame-Options", "DENY");
          if (!sameOriginNavigation(req)) {
            // Arrived from another site: no tool runs until the human clicks,
            // and the click is a same-origin navigation.
            res.type("html").send(
              renderOpenPrompt({
                title: server.title ?? server.slug,
                href: req.originalUrl,
                signedInAs,
              }),
            );
            return;
          }
          res.type("html").send(
            renderAppHost({
              slug: server.slug,
              title: server.title ?? server.slug,
              uri: found.uri,
              tool: autoTool(found),
              signedInAs,
            }),
          );
        },
        "app",
      );
    }, jsonFailure("apps_page")),
  );

  // The frame: the server's own HTML, in an opaque origin. See the header.
  app.get(
    "/apps/:server/frame",
    gate,
    asyncRoute(async (req: Request, res: Response) => {
      await withSession(
        req,
        res,
        opts,
        policies,
        async (client, server) => {
          const found = await loadApp(client, server.slug, queryUri(req));
          if (!found) {
            res.status(404).type("text").send("no app");
            return;
          }
          res
            .set("Content-Security-Policy", frameCsp(found.domains))
            .set("X-Content-Type-Options", "nosniff")
            .set("Referrer-Policy", "no-referrer")
            .set("Cache-Control", "no-store")
            .type("html")
            .send(withBlankTarget(found.html));
        },
        "app",
      );
    }, jsonFailure("apps_frame")),
  );

  // The bridge's one door into a server. The playground's call route, under
  // the "app" surface, with the same three locks in front of it.
  app.post(
    "/apps/:server/tools/call",
    gate,
    refuseTokenSession,
    requireJson,
    asyncRoute(
      async (req: Request, res: Response) => {
        const body = req.body as {
          tool?: unknown;
          arguments?: unknown;
          initial?: unknown;
        };
        const tool = typeof body?.tool === "string" ? body.tool : "";
        if (!tool) {
          res
            .status(400)
            .json({ ok: false, error: "A tool name is required." });
          return;
        }
        if (
          body.arguments !== undefined &&
          (typeof body.arguments !== "object" ||
            body.arguments === null ||
            Array.isArray(body.arguments))
        ) {
          res
            .status(400)
            .json({ ok: false, error: "Arguments must be a JSON object." });
          return;
        }
        const args = (body.arguments ?? {}) as Record<string, unknown>;
        await withSession(
          req,
          res,
          opts,
          policies,
          async (client, server) => {
            // Always THIS slug. A namespaced name for another slug is taken
            // as a bare name here, and fails as one.
            const parsed = denamespace(tool);
            const bare =
              parsed && parsed.slug === server.slug ? parsed.tool : tool;
            const name = `${server.slug}__${bare}`;
            // VISIBILITY, as the spec puts it: "Host MUST reject `tools/call`
            // requests from apps for tools that don't include `app` in
            // visibility". A tool the listing does not carry is left to the
            // gateway, which refuses it on the action anyway.
            const listed = (await client.listTools()).tools.find(
              (t) => t.name === name,
            );
            //
            // The ONE exception is the host's own opening call: the spec makes
            // it host-initiated, not app-initiated, so a model-only declaring
            // tool still opens its UI. Only for a tool that declares a UI and
            // says it changes nothing — the same rule the host page applies
            // before it makes the call at all (`autoTool`).
            const opening =
              body.initial === true &&
              Object.keys(args).length === 0 &&
              listed !== undefined &&
              toolResourceUri(listed._meta) !== null &&
              listed.annotations?.readOnlyHint === true;
            if (!listed) {
              res.status(404).json({
                ok: false,
                error: `${server.slug} does not list a tool named ${bare}.`,
              });
              return;
            }
            if (!opening && !toolVisibility(listed._meta).includes("app")) {
              res.status(403).json({
                ok: false,
                error: `${bare} is not callable from an app (its visibility excludes "app").`,
              });
              return;
            }
            event({
              evt: "ui.app.tool_call",
              principal: consolePrincipal(res).id,
              server: server.slug,
              tool: bare,
            });
            const result = await client.callTool({
              name,
              arguments: args,
            });
            res.json({ ok: true, result });
          },
          "app",
        );
      },
      jsonFailure("apps_call", {
        ok: false,
        error: "The console hit an unexpected error.",
      }),
    ),
  );
}

/** The page a cross-site arrival gets: one same-origin link, and no tool run. */
export function renderOpenPrompt(opts: {
  title: string;
  href: string;
  signedInAs?: string;
}): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>${esc(opts.title)} · strad</title>
<style>
  body { margin: 0; font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f6f5f2; color: #333; }
  main { max-width: 32rem; margin: 18vh auto; padding: 0 20px; text-align: center; }
  a.open { display: inline-block; margin-top: 12px; padding: 10px 22px; border-radius: 999px; background: #111; color: #fff; text-decoration: none; font-weight: 600; }
  p.who { color: #888; font-size: 13px; }
</style>
</head>
<body>
<main>
  <h1>${esc(opts.title)}</h1>
  <p>You followed a link from outside the console. Opening this app runs its tools as you.</p>
  <a class="open" href="${esc(opts.href)}">Open</a>
  ${opts.signedInAs ? `<p class="who">${esc(opts.signedInAs)}</p>` : ""}
</main>
<script>
  // The server never sees the fragment, so the link it wrote has none: carry
  // this page's hash over, or a shared #listing is lost on the click.
  document.querySelector("a.open").hash = location.hash;
</script>
</body>
</html>`;
}

/**
 * The host page's address-bar hand-over, as browser source: the host page
 * inlines it, and `test/ui.apps.test.ts` runs it in `node:vm`. The frame is
 * opaque-origin and cannot read this page's URL, so the app's own state in the
 * address bar (`?updated=`, `#listing`) reaches it only on its src, and comes
 * back only as a notification the host mirrors.
 *
 * Two params are the HOST's and never the app's. `uri` picks which `ui://`
 * page to frame; `token` is the console gate's sign-in token, which must never
 * reach third-party page code, nor be planted on the address bar by it. Both
 * are dropped on the way in, bracketed `qs` forms included, and on the way back
 * `uri` is kept from the address bar while `token` is never written. Every
 * other param is the app's. It rides after the frame route's own `uri`, and
 * `frame-src` matches the path, so it widens nothing the frame may load.
 */
export const ADDRESS_JS = `
function isHostParam(k) {
  return /^(uri|token)(\\[|$)/.test(k);
}
function appParams(search) {
  const all = new URLSearchParams(search);
  const out = new URLSearchParams();
  all.forEach((v, k) => { if (!isHostParam(k)) out.append(k, v); });
  return out;
}
function frameSrcFor(base, search, hash) {
  const extra = appParams(search).toString();
  const src = extra ? base + (base.indexOf("?") === -1 ? "?" : "&") + extra : base;
  return src + (hash.length > 1 ? hash : "");
}
function hostUrlFor(pathname, search, hash, appSearch) {
  const keep = new URLSearchParams(search);
  const out = new URLSearchParams();
  if (keep.has("uri")) out.set("uri", keep.get("uri"));
  appParams(appSearch.replace(/^[?]/, "")).forEach((v, k) => out.append(k, v));
  const q = out.toString();
  return pathname + (q ? "?" + q : "") + hash;
}`;

/** The host page: a thin bar, the sandboxed frame, and the bridge. */
export function renderAppHost(opts: {
  slug: string;
  title: string;
  uri: string;
  /** The tool that declares this UI. Called once the page has initialized. */
  tool?: string;
  signedInAs?: string;
}): string {
  const frameSrc = `${appHref(opts.slug)}/frame?uri=${encodeURIComponent(opts.uri)}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="robots" content="noindex, nofollow" />
<title>${esc(opts.title)} · strad</title>
<style>
  html, body { margin: 0; height: 100%; background: #f6f5f2; }
  body { display: flex; flex-direction: column; font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #444; }
  .bar { display: flex; align-items: center; gap: 10px; padding: 6px 14px; border-bottom: 1px solid #e4e1db; background: #fff; flex: none; }
  .bar a { color: inherit; text-decoration: none; }
  .bar .brand { font-weight: 650; color: #111; }
  .bar .slug { color: #888; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bar .who { margin-left: auto; color: #888; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  iframe { flex: 1; width: 100%; border: 0; display: block; background: #fff; }
</style>
</head>
<body>
<div class="bar">
  <a class="brand" href="/connectors">strad</a>
  <a class="slug" href="/playground/${esc(encodeURIComponent(opts.slug))}" title="open this server in the playground">${esc(opts.slug)}</a>
  ${opts.signedInAs ? `<span class="who">${esc(opts.signedInAs)}</span>` : ""}
</div>
<noscript><p style="padding:16px">This app needs JavaScript.</p></noscript>
<script>
(() => {
  const slug = ${jsonForScript(opts.slug)};
  const initialTool = ${opts.tool ? jsonForScript(opts.tool) : "null"};
  // Built here rather than in the markup so it loads EXACTLY ONE document,
  // with the address bar's query (minus uri) and hash already on it: the frame
  // is opaque-origin and cannot see this page's URL, so both are handed over
  // on its src, and their changes are mirrored back (x-strad/search and
  // x-strad/hash below). ADDRESS_JS is the whole rule.
${ADDRESS_JS}
  // History belongs to THIS page. The frame cannot keep its own: a traversal
  // or a parent-set fragment reloads an opaque-origin frame, which the bridge
  // below treats as the app navigating away. So an app that wants Back asks for
  // an entry (x-strad/hash with push: true) and is told the hash Back or
  // Forward restored (popstate, below). Its query only ever replaces.
  let frameSearch = location.search;
  const hashOf = (h) => { try { return new URL(h || "#", location.href).hash; } catch (_) { return null; } };
  // Hashes sent down on Back / Forward that the app has not caught up with.
  let followed = [];
  const frame = document.createElement("iframe");
  frame.id = "app";
  frame.title = ${jsonForScript(opts.title)};
  frame.setAttribute("sandbox", "allow-scripts allow-popups allow-popups-to-escape-sandbox");
  frame.referrerPolicy = "no-referrer";
  frame.src = frameSrcFor(${jsonForScript(frameSrc)}, location.search, location.hash);
  // THE BRIDGE BELONGS TO THE FIRST DOCUMENT. Every document this frame could
  // hold has the same opaque origin, so the window is the only identity — and
  // a second load means the app navigated the frame somewhere. Fail closed:
  // drop the frame and the bridge with it.
  let loads = 0;
  let bridgeOpen = true;
  frame.addEventListener("load", () => {
    loads += 1;
    if (loads === 1) { try { frame.focus(); } catch (_) {} return; }
    bridgeOpen = false;
    frame.remove();
    const p = document.createElement("p");
    p.style.padding = "16px";
    p.textContent = "The app navigated away from itself, so it was closed. Reload to open it again.";
    document.body.appendChild(p);
  });
  document.body.appendChild(frame);
  // Back / Forward (or a hash typed into the address bar): tell the app the
  // hash it is at now. The query stays the app's latest — an older entry can
  // carry one the app has since replaced, and the address bar shows the app.
  window.addEventListener("popstate", () => {
    followed.push(location.hash);
    try { history.replaceState(history.state, "", hostUrlFor(location.pathname, location.search, location.hash, frameSearch)); } catch (_) {}
    send({ jsonrpc: "2.0", method: "x-strad/hash", params: { hash: location.hash.replace(/^#/, "") } });
  });
  // Keys go to whichever document has focus. Focus the app on load (above),
  // and forward the navigation keys pressed on THIS page into it, so a click on
  // the bar does not silently break arrow-key paging.
  const FORWARDED = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Escape"];
  window.addEventListener("keydown", (e) => {
    if (!FORWARDED.includes(e.key) || e.altKey || e.ctrlKey || e.metaKey) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    e.preventDefault();
    send({ jsonrpc: "2.0", method: "x-strad/key", params: { key: e.key } });
  });
  const callTool = async (name, args, initial) => {
    const r = await fetch("/apps/" + encodeURIComponent(slug) + "/tools/call", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ tool: name, arguments: args || {}, initial: initial === true }),
    });
    let body = null;
    try { body = await r.json(); } catch (_) {}
    if (body && body.ok) return body.result;
    throw new Error((body && body.error) || ("HTTP " + r.status));
  };
  // The spec's lifecycle: the tool that declares this UI is CALLED, and the
  // page gets its input and result as notifications once it has initialized.
  let started = false;
  const startInitialTool = async () => {
    if (started || !initialTool) return;
    started = true;
    send({ jsonrpc: "2.0", method: "ui/notifications/tool-input", params: { arguments: {} } });
    let result;
    try { result = await callTool(initialTool, {}, true); }
    catch (err) { result = { isError: true, content: [{ type: "text", text: String((err && err.message) || err) }] }; }
    send({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: result });
  };
  const send = (msg) => bridgeOpen && frame.contentWindow && frame.contentWindow.postMessage(msg, "*");
  const theme = () => (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  window.addEventListener("message", async (e) => {
    // Only this page's own frame. Its origin is opaque ("null"), so the
    // window, not the origin, is what identifies it.
    if (!bridgeOpen || e.source !== frame.contentWindow) return;
    const m = e.data;
    if (!m || m.jsonrpc !== "2.0" || typeof m.method !== "string") return;
    if (m.id === undefined || m.id === null) {
      // Notifications need no answer. "initialized" is the one the host waits
      // for before it sends the page anything.
      if (m.method === "ui/notifications/initialized") void startInitialTool();
      if (m.method === "x-strad/search") {
        const q = m.params && m.params.search;
        if (typeof q === "string") {
          frameSearch = q;
          try { history.replaceState(null, "", hostUrlFor(location.pathname, location.search, location.hash, q)); } catch (_) {}
        }
      }
      if (m.method === "x-strad/hash") {
        const h = String((m.params && m.params.hash) || "");
        const at = hashOf(h ? "#" + h : "");
        // The app following a hash sent down, after the address bar has moved
        // on again (Back pressed twice): stale, and the next report settles it.
        if (at !== location.hash && followed.includes(at)) return;
        followed = [];
        // An entry only for a step the person took (a click in the frame
        // activates this page too), and never for the hash already showing:
        // an app cannot fill the tab's history, and neither its echo of a Back
        // nor its first report on load is a step Back has to go through.
        const act = navigator.userActivation;
        const stepped = !act || act.isActive;
        const how = m.params && m.params.push === true && stepped && at !== location.hash ? "pushState" : "replaceState";
        try { history[how](null, "", h ? "#" + h : location.pathname + location.search); } catch (_) {}
      }
      return;
    }
    const reply = (body) => send(Object.assign({ jsonrpc: "2.0", id: m.id }, body));
    const params = m.params || {};
    try {
      switch (m.method) {
        case "ui/initialize":
          return reply({ result: {
            protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : "2026-01-26",
            hostInfo: { name: "strad console", version: "1" },
            hostCapabilities: { openLinks: {}, serverTools: {} },
            hostContext: { theme: theme(), displayMode: "fullscreen", platform: "web" },
          } });
        case "ping":
          return reply({ result: {} });
        case "ui/open-link": {
          const url = String(params.url || "");
          if (!/^https?:\\/\\//i.test(url)) return reply({ error: { code: -32602, message: "only http(s) links open" } });
          window.open(url, "_blank", "noopener,noreferrer");
          return reply({ result: {} });
        }
        case "tools/call":
          try { return reply({ result: await callTool(params.name, params.arguments) }); }
          catch (err) { return reply({ error: { code: -32000, message: String((err && err.message) || err) } }); }
        default:
          return reply({ error: { code: -32601, message: "method not supported by this host: " + m.method } });
      }
    } catch (err) {
      reply({ error: { code: -32603, message: String((err && err.message) || err) } });
    }
  });
})();
</script>
</body>
</html>`;
}
