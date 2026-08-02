---
title: The console as an installed app
description: The strad console is a Progressive Web App — installable from the browser, with a service worker that caches its brand shell and, deliberately, nothing else.
sidebar:
  order: 5
---

The strad console is installable. Open `/ui` in a browser that offers it, install,
and you get a home-screen or dock icon that opens the console in its own window
with no address bar.

Nothing about how the console is built changed to make that true. The pages are
still whole server-rendered documents with the theme inlined — no build step, no
client framework, no bundle. A Progressive Web App needs three things on top of
that — a manifest, icons, a service worker — plus, in strad's case, one page of
its own. All of it is static text Express hands out:

| Path                               | What it is                                         |
| ---------------------------------- | -------------------------------------------------- |
| `/manifest.webmanifest`            | The app manifest: name, icons, colours, start URL. |
| `/sw.js`                           | The service worker. Scope `/`.                     |
| `/pwa/icon.svg`, `/pwa/icon-*.png` | The mark, at the sizes an installer asks for.      |
| `/pwa/offline`                     | One static page, shown when the gateway is gone.   |

They are built by `src/ui/pwa.ts` and the icons are inlined in
`src/ui/pwa-icons.ts` as base64 PNG. That is not squeamishness about binaries: the
runtime is `dist/` and nothing else — the Dockerfile compiles `src/` and copies
the output — so an asset that is not a TypeScript module never reaches the
container.

## What is installable, and what is not

**The console is.** `start_url` is `/ui` and `scope` is `/`, so the server
roster, every per-server view and the landing page at `/` are all inside the
installed window. Clicking the brand mark stays in the app instead of throwing you
back into a browser tab.

**These docs are not.** This site is a separate Astro build on a different origin,
deployed to Cloudflare Pages. A service worker cannot cross an origin, and there
is no manifest here. Making the docs installable would be a change in `docs/`,
not in the gateway.

**`/mcp` is not, and could not be.** It is a JSON-RPC endpoint for agents. There
is nothing to install.

## What the service worker caches

This is the part worth reading carefully, because the console is a bad candidate
for a naive service worker. It serves per-user authenticated HTML behind the SSO
gate, and `POST /ui/:server/reveal` returns plaintext secret material. A
cache-first worker over `/ui/*` would write both to disk, outlive sign-out, and
hand them to whoever opens the browser next on a shared machine.

So the worker does not cache by _strategy_. It caches by **list**:

```js
const SHELL = [
  "/pwa/offline",
  "/pwa/icon.svg",
  "/pwa/icon-192.png",
  "/pwa/icon-512.png",
  "/pwa/icon-maskable-512.png",
  "/manifest.webmanifest",
];
```

Every entry is static, identical for every visitor, and served **in front of** the
SSO gate — which is also why serving them ungated is safe. None of them carries a
slug, an identity, a bucket, a config value or a hostname.

The worker has exactly one cache write, `cache.addAll(SHELL)` during install, and
exactly one cache read, a `match()` for a request whose pathname is in that list.
A response from `/ui`, `/ui/:server`, `/console` or a reveal cannot reach either,
because there is no code path that would put one there.

Every other request is declined outright:

| Request                                              | What the worker does                |
| ---------------------------------------------------- | ----------------------------------- |
| Any `POST` — create, rotate, note, reveal, delete    | Nothing. No `respondWith()` at all. |
| Any cross-origin GET (the fonts)                     | Nothing.                            |
| A subresource GET — `/api/secrets/readiness`, `/mcp` | Nothing.                            |
| A shell path                                         | Served from the cache.              |
| A page navigation                                    | Network, always. Never stored.      |

"Nothing" is literal: with no `respondWith()`, the browser's own network path
handles the request, unobserved and unstored.

## Offline

The one navigation the worker answers from the cache is the one where the network
threw. Open the installed app with the gateway unreachable and you get
`/pwa/offline` — a static page that says the connection is gone and offers a
retry.

It says nothing else, and that is deliberate. A precached document is written once
and shown to whoever opens the app next, so a version that varied by request, by
signed-in identity or by config would freeze one visitor's answer on disk. It
names no server, no bucket and no person, and it does not claim the session is
still good.

There is no offline console. The console is a live view of a running gateway — the
roster, the secret states, the parameter forms are all read from it on request —
so there is nothing meaningful to serve from a cache, and the things that _would_
be worth caching are exactly the things that must not be.

## Updating it

The cache is named `strad-shell-v1`, in `SHELL_CACHE`. The worker's `activate`
deletes every cache whose name is not the current one, so **renaming the cache is
also the eviction**. Bump it whenever a cached byte changes without the worker
script changing — an edit to the offline page's copy is the case that matters.

Three of the routes are served `Cache-Control: no-cache`: `/sw.js`, so a deploy
that changes the worker takes effect on the next visit; and `/manifest.webmanifest`
and `/pwa/offline`, because `cache.addAll()` is an ordinary fetch and would
otherwise be answered from the HTTP cache — a freshness window there is a window
in which a re-installing worker precaches the _old_ bytes. The icons keep an hour;
their bytes do not change without `pwa-icons.ts` changing.

`?v=2` is not an escape hatch. The worker looks up `url.pathname`, which drops the
search, so a query-stringed shell URL is answered from the same cached entry as
the bare path. Renaming the cache is the remedy.

## Signing in, and signing out

Sign-out is unchanged: `GET /console/logout` drops both console cookies. The
service worker is left registered, which is harmless — it holds no authenticated
response, so there is nothing for a purge to remove. The next visit to `/ui` hits
the network, finds no session, and gets the sign-in wall like any other browser.

The registration script runs on the sign-in wall too, so an install can be started
before signing in. It lands on `/ui`, which is gated, and the gate does its job.

Signing in is the one flow the install genuinely changes, and it is worth knowing
about before you install.

:::caution[Sign-in leaves the app window]
With Google sign-in live, opening the installed app on an expired session does
not show a sign-in page inside the app. `requireConsoleUi` answers `/ui` with a
302 to `/console/login`, which redirects on to `accounts.google.com` — an
**out-of-scope** navigation from a `display: standalone` window, so the browser
hands it to a tab or an in-app browser and the app window is left behind. You come
back through `/console/oauth/callback` and land on `/ui`.

That round trip is ordinary on Chrome and Android. It has **not** been exercised
on iOS, where a standalone window has historically had its own storage partition —
which is exactly the thing this flow depends on. See
[Known limitations](/limitations/#42-the-installed-consoles-sign-in-leaves-the-app-window).

Under today's dev bypass the question does not arise: the gate answers `401` with
a sign-in wall rendered in place, and nothing leaves the window.
:::

One smaller consequence of the same scope: an offline navigation to
`/console/oauth/callback` renders the offline page rather than a browser error.
That consumes the trip without spending the authorization code, so the code is
still good — sign in again once the network is back.

## Theme

`theme_color` and `background_color` are both `#0f1116` — the `--bg` custom
property from the console's inlined stylesheet. `layout()` pins
`data-theme="dark"`, so there is one answer rather than two, and the installed
window's chrome matches the page it frames instead of flashing white before the
first paint.
