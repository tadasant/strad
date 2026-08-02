import type { Express, Response } from "express";
import {
  ICON_192_PNG,
  ICON_512_PNG,
  ICON_MASKABLE_512_PNG,
  ICON_SVG,
} from "./pwa-icons.ts";

/**
 * The console as an installable app.
 *
 * strad's human surfaces are server-rendered documents with the theme inlined —
 * no build step, no client framework, no bundle (see render.ts). A PWA does not
 * require any of those things: it requires a manifest, a set of icons, and a
 * service worker, and all three are static text this module hands to Express.
 * Nothing here is compiled, bundled or generated at deploy time.
 *
 * WHAT IS INSTALLABLE. `/ui`, the SSO-gated console, is the `start_url`. That is
 * the surface a human returns to — the server roster, the secret states, the
 * parameter forms — and the one worth a home-screen icon and a window without an
 * address bar. The scope is `/`, so the landing page at `/` is inside the
 * installed app too; an install that dumped you back into a browser tab the
 * moment you clicked the brand mark would be a worse experience than no install.
 *
 * The docs site is NOT part of this. It is a separate Astro build deployed to
 * Cloudflare Pages, on a different origin, and a service worker cannot cross an
 * origin. If the docs should be installable that is a change in `docs/`.
 *
 * ── THE PART THAT MATTERS ───────────────────────────────────────────────────
 *
 * A service worker is a cache with a persistence guarantee, and this console
 * serves per-user authenticated HTML and, on one route, plaintext secret
 * material. A cache-first worker over `/ui/*` would write both to disk, outlive
 * sign-out, and hand them to whoever opens the browser next.
 *
 * So the worker below does not cache by strategy, it caches by LIST. `SHELL` is
 * a closed set of paths, fixed at build time, every one of which is served by
 * THIS module: the icons, the manifest, and one static offline page. All of them
 * are unauthenticated by construction — they carry no slug, no identity, no
 * config, and they are identical for every visitor, which is why they are also
 * mounted in front of the gate rather than behind it.
 *
 * There is exactly one cache write in the worker (`addAll(SHELL)`, during
 * install) and exactly one cache read (`match()`, for a request whose pathname
 * is in `SHELL`). A response from `/ui`, `/ui/:server`, `/console` or
 * `/ui/:server/reveal` cannot reach either, because no code path puts one there.
 * That is a property you can check by reading the worker, and
 * `test/pwa.worker.test.ts` checks it by running the worker.
 */

/** Where the worker lives. Root, so its scope is the whole origin. */
const SW_PATH = "/sw.js";

/** Where the manifest lives. */
const MANIFEST_PATH = "/manifest.webmanifest";

/**
 * Everything the service worker is permitted to cache.
 *
 * A path may be added here only if it is static, identical for every visitor,
 * and served in front of the SSO gate. Nothing under `/ui`, `/console`, `/mcp`
 * or `/api` can ever satisfy that.
 */
export const SHELL_PATHS = [
  "/pwa/offline",
  "/pwa/icon.svg",
  "/pwa/icon-192.png",
  "/pwa/icon-512.png",
  "/pwa/icon-maskable-512.png",
  MANIFEST_PATH,
] as const;

/**
 * The cache name, and the only cache this origin keeps.
 *
 * Bump it when `SHELL_PATHS` or the offline page changes: `activate` deletes
 * every cache whose name is not this one, so a bump is also the eviction.
 */
export const SHELL_CACHE = "strad-shell-v1";

/**
 * The console theme's background, from the `--bg` custom property in
 * render.ts's `THEME_CSS`. `layout()` pins `data-theme="dark"`, so there is one
 * answer rather than two, and the installed window's chrome matches the page it
 * frames instead of flashing white before the first paint.
 */
export const THEME_COLOR = "#0f1116";

function manifest(): Record<string, unknown> {
  return {
    // `id` is what the browser keys the installed app on. Pinning it means the
    // app survives a change of `start_url` instead of installing a second time.
    id: "/ui",
    name: "strad console",
    short_name: "strad",
    description:
      "The human console for a strad gateway: every configured server, what it is scoped to, and whether its secrets are seeded.",
    start_url: "/ui",
    scope: "/",
    display: "standalone",
    orientation: "any",
    background_color: THEME_COLOR,
    theme_color: THEME_COLOR,
    icons: [
      {
        src: "/pwa/icon.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "any",
      },
      { src: "/pwa/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/pwa/icon-512.png", sizes: "512x512", type: "image/png" },
      {
        src: "/pwa/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}

/**
 * The `<head>` tags every console page carries, and the registration call.
 *
 * Registration is deliberately unconditional across the console, including the
 * 401 sign-in wall: the worker caches nothing that depends on being signed in,
 * so there is no state to get wrong, and an install begun from the sign-in page
 * lands on `/ui` once the gate opens.
 *
 * `.catch()` swallows the failure because a browser that refuses the
 * registration — an insecure context, a disabled worker, a private window —
 * still has a perfectly good console. The PWA is an enhancement over a surface
 * that already works without it, which is the same bargain the rest of this UI
 * makes.
 */
export const PWA_HEAD = `<link rel="manifest" href="${MANIFEST_PATH}" />
<meta name="theme-color" content="${THEME_COLOR}" />
<link rel="icon" href="/pwa/icon.svg" type="image/svg+xml" />
<link rel="apple-touch-icon" href="/pwa/icon-192.png" />
<meta name="mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
<meta name="apple-mobile-web-app-title" content="strad" />
<script>
if ("serviceWorker" in navigator) {
  addEventListener("load", function () {
    navigator.serviceWorker.register(${JSON.stringify(SW_PATH)}, { scope: "/" }).catch(function () {});
  });
}
</script>`;

/**
 * The service worker, verbatim.
 *
 * Read the fetch handler as a sequence of ways to say "not mine". It claims a
 * request only when the request is a GET, same-origin, AND either its pathname
 * is in the shell list or it is a navigation. Everything else — every POST to
 * `/ui/:server/{create,rotate,reveal,delete}`, every cross-origin font, every
 * `/mcp` call — falls through with no `respondWith()` at all, which leaves the
 * browser's own network path untouched and unobserved.
 *
 * The navigation branch is the one to look at twice. It goes to the network
 * first and always; the cache is consulted only when the network THROWS, and
 * only ever for `/pwa/offline`. The authenticated response is returned to the
 * page and dropped — there is no `cache.put` in this file outside `addAll`.
 */
export const SERVICE_WORKER_JS = `/* strad console service worker. Generated from src/ui/pwa.ts — do not edit here. */
const CACHE = ${JSON.stringify(SHELL_CACHE)};
const OFFLINE = "/pwa/offline";

/*
 * The complete list of things this worker may ever store. Static, identical for
 * every visitor, and served in front of the console's SSO gate. Authenticated
 * HTML and secret material are not on it and cannot be added to it at runtime.
 */
const SHELL = ${JSON.stringify(SHELL_PATHS)};

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await cache.addAll(SHELL);
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      /* One cache per origin. A rename is therefore also a purge of the old one. */
      for (const key of await caches.keys()) {
        if (key !== CACHE) await caches.delete(key);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;

  /* Writes are POSTs — create, rotate, note, reveal, delete. Never ours. */
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  /*
   * The shell, and only the shell, is served from the cache.
   *
   * The test is exact string equality on the PATHNAME, against the current
   * list. Two consequences, both deliberate. A path that merely looks like a
   * shell path — "/pwa/offline/", "/PWA/offline", anything Express would still
   * route — does not match and goes to the network, which is the safe
   * direction. And a query string is ignored, so "?v=2" is NOT a cache-bust
   * escape hatch for a stale shell asset: renaming CACHE is the only remedy.
   * See HACKS.md #41.
   */
  if (SHELL.includes(url.pathname)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        const hit = await cache.match(url.pathname);
        return hit || fetch(request);
      })(),
    );
    return;
  }

  /*
   * A page. Network, always — this is where authenticated console HTML lives,
   * and the response is handed straight to the page without being stored. The
   * cache is touched only when the network fails, and only for the static
   * offline page.
   */
  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          return await fetch(request);
        } catch (err) {
          const cache = await caches.open(CACHE);
          const fallback = await cache.match(OFFLINE);
          if (fallback) return fallback;
          throw err;
        }
      })(),
    );
    return;
  }

  /* Anything else: not our business. No respondWith, no cache, no observation. */
});
`;

export interface PwaOptions {
  /**
   * The offline page, rendered once at mount.
   *
   * Once, because it has to be a fixed document: it is precached, so a version
   * that varied by request would freeze one request's answer on disk. It is
   * passed in rather than rendered here so this module stays free of the
   * renderer, which imports `PWA_HEAD` from it.
   */
  offlineHtml: string;
}

/**
 * Mount the PWA surface. IN FRONT OF THE GATE, on purpose.
 *
 * Each of these is a static brand asset with no reference to a slug, an
 * identity, a bucket or a config value, and each has to be fetchable for the
 * install to work at all: `<link rel="manifest">` is fetched WITHOUT credentials
 * unless it carries `crossorigin="use-credentials"`, so a gated manifest is a
 * 401 and an app that cannot be installed. The offline page is here for the same
 * reason it is safe to precache — it is the same document for everyone, and it
 * says nothing except that the network is gone.
 *
 * The gated surfaces are unchanged. `/`, `/ui`, `/ui/:server` and every POST
 * still sit behind `requireConsoleUi`.
 */
export function mountPwa(app: Express, opts: PwaOptions): void {
  app.get(MANIFEST_PATH, (_req, res) => {
    asset(res, "application/manifest+json; charset=utf-8", REVALIDATE).send(
      JSON.stringify(manifest(), null, 2),
    );
  });

  app.get(SW_PATH, (_req, res) => {
    asset(res, "text/javascript; charset=utf-8", REVALIDATE).send(
      SERVICE_WORKER_JS,
    );
  });

  app.get("/pwa/icon.svg", (_req, res) => {
    asset(res, "image/svg+xml; charset=utf-8", KEEP_AN_HOUR).send(ICON_SVG);
  });

  app.get("/pwa/icon-192.png", (_req, res) => {
    asset(res, "image/png", KEEP_AN_HOUR).send(ICON_192_PNG);
  });

  app.get("/pwa/icon-512.png", (_req, res) => {
    asset(res, "image/png", KEEP_AN_HOUR).send(ICON_512_PNG);
  });

  app.get("/pwa/icon-maskable-512.png", (_req, res) => {
    asset(res, "image/png", KEEP_AN_HOUR).send(ICON_MASKABLE_512_PNG);
  });

  app.get("/pwa/offline", (_req, res) => {
    asset(res, "text/html; charset=utf-8", REVALIDATE).send(opts.offlineHtml);
  });
}

/**
 * The two documents that CHANGE, and the worker script that carries them.
 *
 * `no-cache` rather than `no-store`: a browser may keep a copy, but must
 * revalidate it. That matters more than it looks, because `cache.addAll()` is
 * an ordinary fetch and will happily be answered from the HTTP cache — so a
 * freshness window here is a window in which a re-installing worker precaches
 * the OLD bytes, and an edit stays invisible even though the worker script
 * already changed. That is the sharp edge HACKS.md #41 describes; there is no
 * reason to widen it for two small documents and a 2 KB script.
 */
const REVALIDATE = "no-cache";

/**
 * The icons. Their bytes do not change without `pwa-icons.ts` changing, they
 * are the largest thing served here, and a stale one is a stale logo.
 */
const KEEP_AN_HOUR = "public, max-age=3600";

/** Headers shared by the static, ungated assets. */
function asset(res: Response, type: string, cacheControl: string): Response {
  return res
    .type(type)
    .set("Cache-Control", cacheControl)
    .set("X-Robots-Tag", "noindex");
}
