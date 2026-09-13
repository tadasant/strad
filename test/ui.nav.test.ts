import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tokenStoreFromConfig } from "../src/auth/index.ts";
import { parseConfig } from "../src/config/load.ts";
import { Registry } from "../src/gateway/registry.ts";
import { createApp } from "../src/http/app.ts";
import {
  EnvSecretProvider,
  sharedSecretProviders,
} from "../src/secrets/provider/index.ts";
import { NAV_DESTINATIONS, type NavKey } from "../src/ui/nav.ts";
import {
  renderAuthorizeError,
  renderConsent,
  renderDomainRefusal,
} from "../src/ui/oauth-consent.ts";
import { renderOffline, renderSignIn } from "../src/ui/render.ts";
import { renderForm } from "../src/ui/servers-page.ts";

/**
 * The shared nav bar — src/ui/nav.ts, rendered by `layout()`.
 *
 * Four claims, and each is the thing that was actually broken before it existed:
 *
 *   1. EVERY console page carries it. A page that renders through `layout()`
 *      and forgets to opt in still gets the bar, because the default is on.
 *   2. EVERY destination in it is a page this app really serves. A nav item
 *      pointing at a route nobody registered is worse than no nav item: it
 *      teaches the reader the bar is unreliable.
 *   3. THE CURRENT PAGE IS MARKED, exactly once, and by `aria-current` rather
 *      than by colour alone.
 *   4. THE PAGES WITH NO SESSION DO NOT CARRY IT. Every link in the bar is
 *      gated, so on a sign-in refusal or an OAuth consent screen the bar would
 *      be four doors that answer 401.
 */

const YAML = `
version: 1
gateway:
  name: strad
  env: test
  publicUrl: https://staging.strad.example.com
auth:
  staticTokens: { enabled: true }
  consoleDevBypass: { enabled: true, roles: [admin] }
roles:
  admin: { servers: ["*"] }
servers:
  - slug: echo
    kind: builtin
    module: "./servers/echo.js"
    entitlements: [admin]
`;

const CONFIG = parseConfig(YAML);
const BOOTSTRAP = "bootstrap-secret-xyz";
const env: NodeJS.ProcessEnv = {
  ALLOW_DEV_AUTH: "true",
  ADMIN_BOOTSTRAP_TOKEN: BOOTSTRAP,
  STRAD_TOKENS: "[]",
};
const auth = { cookie: `strad_console=${BOOTSTRAP}` };

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const registry = await Registry.build({
    config: CONFIG,
    secrets: sharedSecretProviders(new EnvSecretProvider({})),
    mode: "core",
    env,
  });
  const app = createApp({
    config: CONFIG,
    registry,
    tokenStore: tokenStoreFromConfig(CONFIG, env),
    mode: "core",
    env,
    secrets: {},
  });
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const addr = server.address();
  if (typeof addr === "string" || !addr) throw new Error("no port");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => server?.close());

/** The hrefs the bar draws, in order. */
const HREFS = NAV_DESTINATIONS.map((d) => d.href);

/** Every `href` inside the nav element, in document order. */
function navHrefs(html: string): string[] {
  const bar = /<nav class="mainnav"[\s\S]*?<\/nav>/.exec(html);
  if (!bar) return [];
  return [...bar[0].matchAll(/href="([^"]+)"/g)].map((m) => m[1]!);
}

/** The href of the single link marked current, or undefined. */
function activeHref(html: string): string | undefined {
  const bar = /<nav class="mainnav"[\s\S]*?<\/nav>/.exec(html);
  if (!bar) return undefined;
  const marked = [
    ...bar[0].matchAll(/<a class="navlink navlink-on" href="([^"]+)"[^>]*>/g),
  ];
  expect(marked.length).toBeLessThanOrEqual(1);
  return marked[0]?.[1];
}

// ---------------------------------------------------------------------------

describe("the bar names every destination, on every page", () => {
  // Path -> the section it belongs to. The sub-pages are in here on purpose:
  // `/ui/echo` is not a fifth destination, it marks "connectors".
  const PAGES: [string, NavKey][] = [
    ["/", "gateway"],
    ["/connectors", "connectors"],
    ["/ui/echo", "connectors"],
    ["/playground", "playground"],
    ["/playground/echo", "playground"],
    ["/tokens", "tokens"],
  ];

  for (const [path, section] of PAGES) {
    it(`${path} draws all ${HREFS.length} links and marks ${section}`, async () => {
      // `/connectors` answers on every deployment, this one included: the roster
      // and the secret status do not need a config store, and only the editor
      // controls do.
      const res = await fetch(`${baseUrl}${path}`, { headers: auth });
      const html = await res.text();
      expect(navHrefs(html)).toEqual(HREFS);
      expect(activeHref(html)).toBe(
        NAV_DESTINATIONS.find((d) => d.key === section)!.href,
      );
    });
  }

  it("marks exactly one link, so no page claims to be two places at once", async () => {
    for (const [path] of PAGES) {
      const res = await fetch(`${baseUrl}${path}`, { headers: auth });
      const html = await res.text();
      expect(
        (html.match(/aria-current="page"/g) ?? []).length,
        `${path} marked more than one`,
      ).toBe(1);
    }
  });
});

describe("every destination is a page this app serves", () => {
  // The guard against the failure mode a nav bar introduces: a link to a route
  // nobody registered. Express answers an unregistered path with its own stock
  // 404, whose body is not HTML — so "did strad render this" is the assertion,
  // not the status code.
  for (const dest of NAV_DESTINATIONS) {
    it(`${dest.href} is answered by the console, not by Express`, async () => {
      const res = await fetch(`${baseUrl}${dest.href}`, {
        headers: auth,
        redirect: "manual",
      });
      expect(res.headers.get("content-type")).toContain("text/html");
      const html = await res.text();
      expect(html).toContain('<nav class="mainnav"');
      expect(html).not.toContain("Cannot GET");
    });
  }

  it("gates every one of them — an anonymous visitor gets none", async () => {
    for (const dest of NAV_DESTINATIONS) {
      const res = await fetch(`${baseUrl}${dest.href}`, {
        redirect: "manual",
      });
      expect(res.status, `${dest.href} let an anonymous caller in`).toBe(401);
    }
  });
});

describe("the pages reached without a console session carry no bar", () => {
  it("omits it from the sign-in refusal", async () => {
    const res = await fetch(`${baseUrl}/connectors`, { redirect: "manual" });
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain('class="mainnav"');
  });

  it("omits it from the offline shell, which is precached for everyone", () => {
    expect(renderOffline()).not.toContain('class="mainnav"');
    expect(
      renderSignIn({
        error: "invalid_bootstrap_token",
        message: "that token is not the one",
        devBypass: "active",
      }),
    ).not.toContain('class="mainnav"');
  });

  it("omits it from the /mcp OAuth screens, reached mid-flow", () => {
    const consent = renderConsent({
      clientName: "Some Client",
      redirectHost: "client.example.com",
      email: "a@tadasant.com",
      resource: "https://strad.example.com/mcp",
      roles: ["admin"],
      approval: "sealed",
      action: "/oauth/approve",
    });
    expect(consent).not.toContain('class="mainnav"');
    expect(renderDomainRefusal({ hostedDomain: "tadasant.com" })).not.toContain(
      'class="mainnav"',
    );
    expect(
      renderAuthorizeError({ heading: "Unknown client", detail: "no such id" }),
    ).not.toContain('class="mainnav"');
  });
});

describe("the entry form, which needs a config store to reach over HTTP", () => {
  it("marks connectors on it, so a form is not a fifth place to be", () => {
    const form = renderForm({
      config: CONFIG,
      kind: "remote-http",
      copyable: [],
      revision: 0,
      source: "store",
    });
    expect(activeHref(form)).toBe("/connectors");
  });
});

describe("the two paths the bar no longer names", () => {
  // Both were destinations and both are redirects now. A redirect carries no
  // bar, which is fine — what matters is that it lands somewhere the bar knows.
  for (const from of ["/ui", "/secrets"]) {
    it(`${from} redirects to a destination the bar does name`, async () => {
      const res = await fetch(`${baseUrl}${from}`, {
        headers: auth,
        redirect: "manual",
      });
      expect(res.status).toBe(302);
      const to = res.headers.get("location");
      expect(HREFS).toContain(to);
    });
  }
});
