/**
 * MCP App (inline UI) for Good Eggs — the `io.modelcontextprotocol/ui` extension.
 *
 * This is the whole "MCP App" surface for good-eggs, kept in one file so the
 * gating rule and the HTML it gates live next to each other.
 *
 * The contract (see SEP-1865 / the `io.modelcontextprotocol/ui` extension):
 *
 *   - A client OPTS IN by advertising the extension in its `initialize`
 *     capabilities: `{ extensions: { "io.modelcontextprotocol/ui": {} } }`.
 *   - Only then do we register the `ui://good-eggs/search-results` resource and
 *     attach the `_meta` pointer to the `search_for_grocery` tool. A client that
 *     did NOT advertise the extension sees the exact same byte-for-byte plain
 *     result it always did — no resource, no `_meta`, no `structuredContent`.
 *   - The resource is a SELF-CONTAINED HTML document (inline styles + one inline
 *     script, no network of its own). The host renders it in a sandboxed iframe
 *     and hands it the tool's result over a postMessage JSON-RPC bridge; the app
 *     paints a product grid from that data.
 *
 * Why the gate matters: strad's whole premise is "byte-identical for clients
 * that didn't ask for more." An MCP App is opt-in UI layered on an unchanged
 * tool surface — never a fork of it.
 */

/**
 * The extension key a client advertises to say "I can render MCP Apps."
 * This exact string is the wire contract; do not abbreviate it.
 */
export const MCP_APPS_EXTENSION = 'io.modelcontextprotocol/ui';

/** The `ui://` resource this app is served from. Format: `ui://<app>/<template>`. */
export const SEARCH_APP_URI = 'ui://good-eggs/search-results';

/** The human-facing resource name. */
export const SEARCH_APP_NAME = 'search-results';

/**
 * `text/html` with the app-template profile marker (SEP-1865). Hosts key off the
 * `;profile=mcp-app` parameter to know this HTML is an app template, not a
 * document to display raw.
 */
export const SEARCH_APP_MIME = 'text/html;profile=mcp-app';

/**
 * The tool this app is bound to. The host preloads the bound `ui://` resource
 * from the tool listing and renders it when this tool is called.
 */
export const SEARCH_APP_TOOL = 'search_for_grocery';

/**
 * A minimal structural view of the client's advertised `initialize`
 * capabilities. We only care about `extensions`; everything else is passed
 * through verbatim by the transport and is none of our business.
 *
 * NB: we read this off the RAW `initialize` body (not a schema-parsed copy) so
 * the opt-in `extensions` keys survive — a strict parse can drop unknown keys.
 */
export interface AppClientCapabilities {
  extensions?: Record<string, unknown>;
  experimental?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Does this client support MCP Apps?
 *
 * True only if it advertised the extension under `capabilities.extensions`. The
 * value can be `{}` (opt-in with no options), so we test key presence, not
 * truthiness — and we deliberately do NOT treat `experimental` as opt-in, to
 * match the finalized extension surface.
 */
export function clientSupportsApps(
  capabilities: AppClientCapabilities | undefined
): boolean {
  const extensions = capabilities?.extensions;
  return Boolean(
    extensions &&
      typeof extensions === 'object' &&
      Object.prototype.hasOwnProperty.call(extensions, MCP_APPS_EXTENSION)
  );
}

/**
 * The `_meta` pointer that binds `search_for_grocery` to this app.
 *
 * Two keys on purpose: the nested `ui.resourceUri` is the finalized SEP-1865
 * shape; the flat `ui/resourceUri` is the deprecated key today's hosts still
 * read. Emitting both keeps the binding working across host versions.
 */
export function searchAppToolMeta(): Record<string, unknown> {
  return {
    ui: { resourceUri: SEARCH_APP_URI },
    'ui/resourceUri': SEARCH_APP_URI,
  };
}

/**
 * Escape a value for safe inlining inside a `<script>` element.
 *
 * The self-contained HTML embeds a tiny static bootstrap blob as JSON. Even
 * though that blob is fully server-controlled today, embedding ANYTHING in a
 * `<script>` demands the classic hardening, or a future value containing
 * `</script>` (or a line/para separator that a JSON string permits raw but a
 * JS parser treats as a newline) breaks out of the element. We escape:
 *   - `<` / `>`  -> unicode escapes, which neutralizes `</script>` and `<!--`
 *   - `&`        -> unicode escape, for good measure inside HTML
 *   - U+2028 / U+2029 -> the two code points that are valid in JSON strings but
 *     terminate a JS statement, a notorious inline-JSON footgun.
 */
export function serializeForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * Render the self-contained MCP App HTML for the product-search grid.
 *
 * The document is STATIC: no per-call tool data is interpolated into it. All
 * product data arrives at runtime over the postMessage bridge (as the triggering
 * tool's result) and is rendered into the DOM via `textContent`, never via HTML
 * string concatenation — so there is no server-data injection surface to escape.
 * The only embedded value is the static bootstrap blob below, and that goes
 * through `serializeForScript`.
 */
export function renderSearchAppHtml(): string {
  const bootstrap = {
    appName: 'good-eggs-search-app',
    appVersion: '0.1.0',
    appUri: SEARCH_APP_URI,
    searchTool: SEARCH_APP_TOOL,
    addToCartTool: 'add_to_cart',
  };

  // NOTE: the closing `</script>` for the app code is written split as
  // `<\/script>` inside this template literal so it cannot prematurely close the
  // element when this string is itself embedded somewhere during testing.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Good Eggs — Search results</title>
<style>
  :root {
    --bg: #ffffff;
    --ink: #1f2a24;
    --muted: #6b7a70;
    --line: #e6ebe6;
    --brand: #2f7d4f;
    --brand-ink: #ffffff;
    --chip: #eef6ef;
    --shadow: 0 1px 2px rgba(31, 42, 36, 0.06), 0 6px 16px rgba(31, 42, 36, 0.06);
    --radius: 14px;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; }
  body {
    background: var(--bg);
    color: var(--ink);
    font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
    padding: 16px;
  }
  header {
    display: flex;
    align-items: baseline;
    gap: 10px;
    flex-wrap: wrap;
    margin-bottom: 14px;
  }
  .logo {
    font-weight: 700;
    letter-spacing: -0.2px;
    color: var(--brand);
    display: inline-flex;
    align-items: center;
    gap: 7px;
  }
  .logo .egg { font-size: 16px; }
  h1 { font-size: 15px; margin: 0; font-weight: 650; }
  .sub { color: var(--muted); font-size: 13px; }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: 12px;
  }
  .card {
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: #fff;
    box-shadow: var(--shadow);
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  .thumb {
    aspect-ratio: 4 / 3;
    background: linear-gradient(135deg, #f3f7f3, #e9f1ea);
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
  }
  .thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .thumb .placeholder { font-size: 30px; opacity: 0.5; }
  .fav {
    position: absolute; top: 8px; right: 8px;
    background: rgba(255,255,255,0.9);
    border-radius: 999px; width: 26px; height: 26px;
    display: flex; align-items: center; justify-content: center;
    font-size: 14px; box-shadow: var(--shadow);
  }
  .discount {
    position: absolute; top: 8px; left: 8px;
    background: var(--brand); color: var(--brand-ink);
    font-size: 11px; font-weight: 700; padding: 3px 7px; border-radius: 999px;
  }
  .body { padding: 10px 11px 12px; display: flex; flex-direction: column; gap: 4px; flex: 1; }
  .brand { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.3px; }
  .name { font-weight: 620; font-size: 13.5px; line-height: 1.3; }
  .price { font-weight: 700; margin-top: 2px; }
  .spacer { flex: 1; }
  .add {
    margin-top: 8px;
    appearance: none; border: 0; cursor: pointer;
    background: var(--brand); color: var(--brand-ink);
    font-weight: 650; font-size: 13px;
    padding: 8px 10px; border-radius: 10px;
    display: inline-flex; align-items: center; justify-content: center; gap: 6px;
    transition: filter 0.12s ease;
  }
  .add:hover { filter: brightness(0.95); }
  .add:disabled { opacity: 0.6; cursor: default; }
  .empty, .waiting {
    color: var(--muted); padding: 28px 8px; text-align: center;
    border: 1px dashed var(--line); border-radius: var(--radius);
  }
  a.name-link { color: inherit; text-decoration: none; }
  a.name-link:hover { text-decoration: underline; }
</style>
</head>
<body>
<header>
  <span class="logo"><span class="egg">🥚</span>Good Eggs</span>
  <h1 id="title">Search results</h1>
  <span class="sub" id="subtitle"></span>
</header>
<main id="root">
  <div class="waiting" id="waiting">Waiting for search results…</div>
</main>

<script id="app-bootstrap" type="application/json">${serializeForScript(bootstrap)}</script>
<script>
"use strict";
(function () {
  var BOOT = {};
  try {
    BOOT = JSON.parse(document.getElementById("app-bootstrap").textContent || "{}");
  } catch (e) { BOOT = {}; }

  // --- postMessage JSON-RPC bridge to the host ------------------------------
  var nextId = 1;
  var pending = {};
  function post(message) {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage(message, "*");
    }
  }
  function notify(method, params) {
    post({ jsonrpc: "2.0", method: method, params: params || {} });
  }
  function request(method, params) {
    var id = nextId++;
    post({ jsonrpc: "2.0", id: id, method: method, params: params || {} });
    return new Promise(function (resolve, reject) {
      pending[id] = { resolve: resolve, reject: reject };
    });
  }

  // --- tiny DOM builder; all text via textContent (no HTML injection) -------
  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (attrs[k] == null) return;
        if (k === "class") node.className = attrs[k];
        else if (k === "text") node.textContent = attrs[k];
        else if (k.slice(0, 2) === "on") node.addEventListener(k.slice(2), attrs[k]);
        else node.setAttribute(k, attrs[k]);
      });
    }
    (children || []).forEach(function (c) {
      if (c == null) return;
      node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return node;
  }

  // --- extract the product array from a tool-result payload -----------------
  function dataFrom(payload) {
    if (!payload) return null;
    if (payload.structuredContent && typeof payload.structuredContent === "object") {
      return payload.structuredContent;
    }
    var content = payload.content || [];
    for (var i = 0; i < content.length; i++) {
      if (content[i] && content[i].type === "text" && typeof content[i].text === "string") {
        try { return JSON.parse(content[i].text); } catch (e) {}
      }
    }
    return null;
  }

  function productCard(p) {
    var thumbKids = [];
    if (p.imageUrl) {
      thumbKids.push(el("img", { src: p.imageUrl, alt: p.name || "", loading: "lazy" }));
    } else {
      thumbKids.push(el("div", { class: "placeholder", text: "🥬" }));
    }
    if (p.discount) thumbKids.push(el("div", { class: "discount", text: p.discount }));
    if (p.isFavorite) thumbKids.push(el("div", { class: "fav", text: "❤️", title: "In your favorites" }));

    var nameNode = p.url
      ? el("a", { class: "name-link", href: p.url, target: "_blank", rel: "noreferrer", text: p.name || "Unnamed" })
      : document.createTextNode(p.name || "Unnamed");

    var addBtn = el("button", {
      class: "add",
      text: "Add to cart",
      onclick: function () {
        if (!p.url) return;
        addBtn.disabled = true;
        addBtn.textContent = "Adding…";
        request("tools/call", {
          name: BOOT.addToCartTool || "add_to_cart",
          arguments: { grocery_url: p.url, quantity: 1 },
        }).then(function () {
          addBtn.textContent = "✓ Added";
        }).catch(function () {
          addBtn.disabled = false;
          addBtn.textContent = "Add to cart";
        });
      },
    });

    return el("div", { class: "card" }, [
      el("div", { class: "thumb" }, thumbKids),
      el("div", { class: "body" }, [
        p.brand ? el("div", { class: "brand", text: p.brand }) : null,
        el("div", { class: "name" }, [nameNode]),
        p.price ? el("div", { class: "price", text: p.price }) : null,
        el("div", { class: "spacer" }),
        addBtn,
      ]),
    ]);
  }

  function render(data) {
    var root = document.getElementById("root");
    var subtitle = document.getElementById("subtitle");
    root.textContent = "";

    var products = (data && (data.products || data.results || data.items)) || [];
    var query = data && data.query;

    if (query) subtitle.textContent = "for “" + query + "”";

    if (!products.length) {
      root.appendChild(el("div", { class: "empty", text: "No products to show." }));
      reportSize();
      return;
    }

    subtitle.textContent = (query ? "for “" + query + "” · " : "") + products.length + " item" + (products.length === 1 ? "" : "s");

    var grid = el("div", { class: "grid" });
    products.forEach(function (p) { grid.appendChild(productCard(p)); });
    root.appendChild(grid);
    reportSize();
  }

  // --- auto-resize: tell the host how tall we are ---------------------------
  function reportSize() {
    var h = Math.ceil(document.documentElement.scrollHeight);
    notify("ui/notifications/size-changed", { width: null, height: h });
  }
  if (window.ResizeObserver) {
    new ResizeObserver(function () { reportSize(); }).observe(document.body);
  }

  // --- inbound host messages ------------------------------------------------
  window.addEventListener("message", function (event) {
    var msg = event.data;
    if (!msg || msg.jsonrpc !== "2.0") return;

    // A response to one of our requests.
    if (msg.id != null && (msg.result !== undefined || msg.error !== undefined)) {
      var waiter = pending[msg.id];
      if (waiter) {
        delete pending[msg.id];
        if (msg.error) waiter.reject(msg.error);
        else waiter.resolve(msg.result);
      }
      return;
    }

    // The triggering tool's result (or its input echo) — render it.
    if (msg.method === "ui/notifications/tool-result" || msg.method === "ui/notifications/tool-input") {
      render(dataFrom(msg.params));
      return;
    }
  });

  // --- init handshake -------------------------------------------------------
  // Hosts (e.g. Claude) require appInfo/appCapabilities, NOT MCP-core
  // clientInfo/capabilities, or they reject the frame.
  request("ui/initialize", {
    protocolVersion: "2026-01-26",
    appInfo: { name: BOOT.appName || "good-eggs-search-app", version: BOOT.appVersion || "0.1.0" },
    appCapabilities: {},
  }).then(function (result) {
    notify("ui/notifications/initialized", {});
    // Some hosts hand the triggering tool result inline on init.
    if (result && result.toolResult) render(dataFrom(result.toolResult));
  }).catch(function () {
    // Not in an MCP-App host (e.g. opened standalone) — nothing to wait for.
  });
})();
<\/script>
</body>
</html>`;
}
