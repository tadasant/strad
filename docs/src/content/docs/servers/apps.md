---
title: Apps in the console
description: The strad console as an MCP Apps host. How a server ships a page over MCP, how the console renders it behind its sign-in, and what the page can and cannot do.
---

A server can ship its own page over MCP, and the console renders it at
`/apps/<slug>`, behind the same Google sign-in as the rest of the console. The
page is the **server's** code, not strad's. That is how a private server gets a
UI without its source living in this repo.

This follows the MCP Apps extension,
[SEP-1865](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx).
`/mcp` already relays `tools/list`, `resources/read` and `tools/call`, so any MCP
Apps client pointed at `/mcp?servers=<slug>` can render the same page. The
console is one more such client.

## What a server ships

- A **resource** with a `ui://` URI and mimeType `text/html;profile=mcp-app`:
  one self-contained HTML document.
- A **tool** whose `_meta.ui.resourceUri` names it. That is the tool the host
  calls to open the app, and whose result the page receives.
- Optionally `_meta.ui.csp.resourceDomains` on the resource: the `https://`
  origins its images, fonts and media load from.

## What the console does

`GET /apps/<slug>` checks the signed-in human's entitlement to the slug, the
same check the playground makes. It finds the tool that carries
`_meta.ui.resourceUri` (the deprecated flat `ui/resourceUri` is also read) and
renders a thin bar plus a sandboxed iframe. A server whose app resource no tool
names is still rendered, just without an initiating tool call.

The iframe loads `GET /apps/<slug>/frame`, which does a `resources/read` and
serves the HTML with a `Content-Security-Policy` of its own:

- `sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox`, without
  `allow-same-origin`. The document gets an **opaque origin**, whether it is
  framed or opened directly. It cannot read the console's cookies or storage, or
  call a console route as the signed-in human.
- `connect-src 'none'`: no `fetch`, no XHR, no WebSocket.
- Images, fonts and media only from `data:`, `blob:` and the declared
  `resourceDomains`. Each entry must be a bare `https://` origin, so one
  carrying a `;` or a path is dropped rather than spliced into the header.

Once the page sends `ui/notifications/initialized`, the host calls the
declaring tool and sends the page `ui/notifications/tool-input` and
`ui/notifications/tool-result`, as the spec's lifecycle does. That opening call
is host-initiated, so it is not bound by the tool's `visibility`. Two guards keep
it from being a way to run a tool by link:

- It happens only for a declaring tool annotated `readOnlyHint: true`. A tool
  that writes waits for the page to ask.
- A GET of `/apps/<slug>` that another site started (`Sec-Fetch-Site` other
  than `same-origin` or `none`) gets a page that says so and runs nothing. The
  console's session cookie is `SameSite=Lax`, so it rides on a cross-site
  top-level GET, and this is the check that makes that harmless. The host page
  itself refuses to be framed.

The bridge also belongs to the FIRST document the frame loads. Every document
the frame could hold has the same opaque origin, so the window is the only
identity. The served page gets `<base target="_blank">`, which sends plain links
out as new tabs rather than into the frame. If the frame loads a second document
anyway, the host removes the frame and the bridge with it.

## What the page can do

The host answers JSON-RPC over `postMessage` from its own frame and no other
window:

| Method | Answer |
| --- | --- |
| `ui/initialize` | host info, and `hostContext` with the theme |
| `ping` | `{}` |
| `ui/open-link` | opens an `http(s)` URL in a new tab, without an opener |
| `tools/call` | runs one of **this server's** tools |

Notifications the host acts on: `ui/notifications/initialized`, and the two
`x-strad/` ones below.

A `tools/call` is POSTed to `/apps/<slug>/tools/call`. It is the playground's
call route under another surface name, so it gets the same locks: the human's
own entitlement, the slug's `tools:` policy on the action, no console-login-token
sessions, and a JSON-only body a cross-site form cannot send. Every name is
re-namespaced onto this slug, so a page cannot reach another server. A tool whose
`_meta.ui.visibility` leaves out `"app"` is refused, as the spec requires.

So an app gives a human nothing the playground does not already give them over
the same server. It is a better face on the same authority.

## Two console extensions

Both are prefixed `x-strad/` because the spec does not define them. An app that
ignores them still works, and other hosts never send them.

- **Keys.** Key presses go to whichever document has focus, and a click on the
  console bar would take it from the app. So the host focuses the frame on load
  and forwards `←` `→` `↑` `↓` and `Esc`, pressed anywhere on the host page and
  outside a text field, as a notification
  `x-strad/key {key: "ArrowLeft" | …}`. An app should route it through its own
  `keydown` handler.
- **Location.** The frame has an opaque origin and cannot see the address bar.
  The host appends its own `#hash` to the frame's `src`, so the app can read where
  a link or a refresh meant to land. An app that sends `x-strad/hash {hash}` has
  it mirrored onto the address bar with `history.replaceState`.

## What it does not do

- **No model.** The console is a deterministic client: it calls the declaring
  tool on load and whatever the page asks for after that. `ui/message`,
  `ui/update-model-context` and the other methods that exist for an LLM host
  answer "not supported".
- **No separate-origin sandbox proxy.** The spec describes a sandbox proxy
  iframe on a different origin for web hosts. The console gets its isolation
  from the CSP `sandbox` directive instead: an opaque origin with no network.
  [Known limitations](/limitations/) carries the difference.
