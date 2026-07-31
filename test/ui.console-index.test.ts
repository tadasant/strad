import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tokenStoreFromConfig } from "../src/auth/index.ts";
import { parseConfig } from "../src/config/load.ts";
import { Registry } from "../src/gateway/registry.ts";
import { createApp } from "../src/http/app.ts";
import { EnvSecretProvider } from "../src/secrets/provider/index.ts";
import { badgeFor, sortEntries, type Entry } from "../src/ui/index-page.ts";
import type { ServerConfig } from "../src/config/schema.ts";

/**
 * `/ui` — the badges, the ordering, and the popout.
 *
 * `test/ui.secret-status.test.ts` covers the derivation; this file covers what
 * the index does WITH it. Three claims, and each one is a decision that could
 * have gone the other way:
 *
 *   1. READY means OBSERVED. "Could not be checked" is an ISSUE, not a quiet
 *      green — otherwise a store outage renders a fleet of reassuring badges.
 *   2. THE BADGE TOOK THE SLUG'S SLOT. The slug was printed twice on every entry
 *      that declares no `title:`, and once is enough.
 *   3. THE ISSUE BADGE IS A CONTROL. It opens a popout naming the secret, the
 *      store, the project and the exact path — not a generic "something is
 *      wrong".
 */

// ---------------------------------------------------------------------------
// A fixture with all four sort ranks, in deliberately WRONG config order
// ---------------------------------------------------------------------------

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
bundles:
  - name: bundle
  - name: bundle-bad
servers:
  - slug: beta
    kind: remote-http
    url: https://beta.example.com/mcp
    headers: { Authorization: "Bearer \${BETA_TOKEN}" }
    entitlements: [admin]
  # Its OWN bundle. It points at a different bucket than object-store under the
  # same bare GCS_* names, and two servers declaring one env key with different
  # values on ONE bundle is a config-time error now (src/config/schema.ts). Two
  # bundles are two containers, each reading its own environment — which is
  # exactly what makes the bare names correct here.
  - slug: object-store-bad
    kind: supplementary-image
    title: Broken bucket
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle-bad
    path: /gcs-bad
    entitlements: [admin]
    env:
      GCS_BUCKET: "demo-bucket-bad"
      GCS_SERVICE_ACCOUNT_KEY_JSON: "\${GCS_BAD_KEY_JSON}"
  - slug: alpha
    kind: remote-http
    url: https://alpha.example.com/mcp
    headers: { Authorization: "Bearer \${ALPHA_TOKEN}" }
    entitlements: [admin]
  - slug: object-store
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle
    path: /gcs
    entitlements: [admin]
    env:
      GCS_BUCKET: "demo-bucket"
      GCS_SERVICE_ACCOUNT_KEY_JSON: "\${GCS_KEY_JSON}"
    consoleEnv:
      GCS_SERVICE_ACCOUNT_KEY_JSON: "\${GCS_KEY_JSON}"
  - slug: retired
    kind: remote-http
    url: https://retired.example.com/mcp
    enabled: false
    headers: { Authorization: "Bearer \${RETIRED_TOKEN}" }
    entitlements: [admin]
`;

const CONFIG = parseConfig(YAML);

const BOOTSTRAP = "bootstrap-secret-xyz";
const AUTH = { authorization: `Bearer ${BOOTSTRAP}` };

/** `object-store` and `alpha` resolve; `object-store-bad` and `beta` do not. */
const BAG: Record<string, string> = {
  ALPHA_TOKEN: "alpha-real-credential-value",
  GCS_KEY_JSON:
    '{"client_email":"svc@demo.iam.gserviceaccount.com","private_key":"GcsKeyNeverShown"}',
  STRAD_TOKENS: "[]",
  STRAD_INTERNAL_TOKEN: "internal-token-value",
  ADMIN_BOOTSTRAP_TOKEN: BOOTSTRAP,
};

const ENV: NodeJS.ProcessEnv = {
  ALLOW_DEV_AUTH: "true",
  ADMIN_BOOTSTRAP_TOKEN: BOOTSTRAP,
  STRAD_BUNDLE_URL_BUNDLE: "http://127.0.0.1:1",
  STRAD_BUNDLE_URL_BUNDLE_BAD: "http://127.0.0.1:1",
  STRAD_TOKENS: "[]",
};

let server: Server;
let html: string;

beforeAll(async () => {
  const provider = new EnvSecretProvider(BAG);
  const registry = await Registry.build({
    config: CONFIG,
    secrets: provider,
    mode: "core",
    env: ENV,
  });
  const app = createApp({
    config: CONFIG,
    registry,
    tokenStore: tokenStoreFromConfig(CONFIG, ENV),
    mode: "core",
    env: ENV,
    secrets: BAG,
    secretProvider: provider,
  });
  const s = app.listen(0);
  await new Promise<void>((r) => s.on("listening", () => r()));
  const addr = s.address();
  if (typeof addr === "string" || !addr) throw new Error("no port");
  server = s;
  html = await (
    await fetch(`http://127.0.0.1:${addr.port}/ui`, { headers: AUTH })
  ).text();
});

afterAll(() => server?.close());

// ---------------------------------------------------------------------------
// badgeFor
// ---------------------------------------------------------------------------

describe("badgeFor", () => {
  it("is READY only for a state the console ESTABLISHED", () => {
    expect(badgeFor("ready")).toBe("READY");
    expect(badgeFor("no-secrets")).toBe("READY");
  });

  it("is ISSUE for a definite problem", () => {
    expect(badgeFor("missing")).toBe("ISSUE");
    expect(badgeFor("placeholder")).toBe("ISSUE");
  });

  it("is ISSUE for 'could not be checked', which is NOT a quiet green", () => {
    // The deliberate half. A bundle-scoped value is genuinely invisible to this
    // process and may well be fine — but READY has to mean observed, or a total
    // store outage renders a fleet of reassuring badges over an unusable
    // gateway. The popout carries the distinction; the badge does not pretend.
    expect(badgeFor("unverified")).toBe("ISSUE");
    expect(badgeFor("unknown")).toBe("ISSUE");
  });
});

// ---------------------------------------------------------------------------
// sortEntries
// ---------------------------------------------------------------------------

describe("sortEntries", () => {
  const entry = (
    slug: string,
    badge: "READY" | "ISSUE" | undefined,
    hasView: boolean,
    enabled = true,
  ): Entry => ({
    server: { slug, enabled } as ServerConfig,
    badge,
    hasView,
  });

  it("puts READY before ISSUE, and a browsable entry before one with no view", () => {
    const sorted = sortEntries([
      entry("issue-no-view", "ISSUE", false),
      entry("ready-no-view", "READY", false),
      entry("issue-view", "ISSUE", true),
      entry("ready-view", "READY", true),
    ]);
    expect(sorted.map((e) => e.server.slug)).toEqual([
      "ready-view",
      "ready-no-view",
      "issue-view",
      "issue-no-view",
    ]);
  });

  it("sorts a DISABLED server last, whatever its view", () => {
    // It carries no badge at all: strad does not mount it, so it needs no
    // secrets, and a green would be a claim about a server that answers nothing.
    const sorted = sortEntries([
      entry("off", undefined, true, false),
      entry("on", "ISSUE", false),
    ]);
    expect(sorted.map((e) => e.server.slug)).toEqual(["on", "off"]);
  });

  it("keeps config order inside a rank", () => {
    const sorted = sortEntries([
      entry("c", "READY", true),
      entry("a", "READY", true),
      entry("b", "READY", true),
    ]);
    expect(sorted.map((e) => e.server.slug)).toEqual(["c", "a", "b"]);
  });
});

// ---------------------------------------------------------------------------
// The rendered page
// ---------------------------------------------------------------------------

describe("GET /ui — badges", () => {
  it("badges the two entries whose secrets resolve READY", () => {
    // Two READY badges, two ISSUE badges, and no badge at all on the disabled
    // entry — five servers, four badges.
    //
    // BOTH kinds are now buttons that open a popout, and that is the point of
    // the change rather than a side effect: a READY entry carries a POSITIVE
    // claim — which secret, from which source, established by which process —
    // and that is the answer someone came to the page for.
    //
    // Counted on the ENTRY badge's own markup: the lede renders an example chip
    // of each to explain them, and a looser count would be satisfied by those
    // alone with every entry unbadged.
    const ready =
      html.split('class="chip chip-ok chip-badge chip-button"').length - 1;
    const issue =
      html.split('class="chip chip-bad chip-badge chip-button"').length - 1;
    expect(ready).toBe(2);
    expect(issue).toBe(2);
    expect(html.split("data-fix-open=").length - 1).toBe(4);
  });

  it("badges an unresolvable secret ISSUE, with a control that opens a popout", () => {
    expect(html).toContain('data-fix-open="fix-beta"');
    expect(html).toContain('data-fix-open="fix-object-store-bad"');
    // A real button, so it is keyboard-reachable and announced as a control.
    expect(html).toMatch(
      /<button class="chip chip-bad chip-badge chip-button" type="button"/,
    );
    expect(html).toContain('aria-haspopup="dialog"');
  });

  it("puts the badge where the DUPLICATED slug was", () => {
    // `beta` declares no `title:`, so the heading IS the slug — printing it
    // again in the foot was the duplication this replaces.
    expect(html).not.toContain('<code class="card-slug">beta</code>');
    expect(html).not.toContain('<code class="card-slug">alpha</code>');
    // Where a `title:` genuinely differs, the slug is information rather than an
    // echo, and it still renders beside the badge.
    expect(html).toContain('<code class="card-slug">object-store-bad</code>');
  });

  it("orders the grid READY-first, then by whether the entry has a view", () => {
    // The config declares them in the WRONG order on purpose — beta,
    // object-store-bad, alpha, object-store, retired — so a page that simply
    // echoed config order would fail this.
    const at = (needle: string) => {
      const i = html.indexOf(needle);
      expect(i, `${needle} is on the page`).toBeGreaterThan(-1);
      return i;
    };
    const objectStore = at(">object-store</a>"); // READY + view
    const alpha = at('<span class="card-title">alpha</span>'); // READY, no view
    const bad = at(">Broken bucket</a>"); // ISSUE + view
    const beta = at('<span class="card-title">beta</span>'); // ISSUE, no view
    const retired = at('<span class="card-title">retired</span>'); // disabled

    expect(alpha).toBeGreaterThan(objectStore);
    expect(bad).toBeGreaterThan(alpha);
    expect(beta).toBeGreaterThan(bad);
    expect(retired).toBeGreaterThan(beta);
  });
});

describe("GET /ui with nothing enabled", () => {
  const boot = async (yaml: string) => {
    const config = parseConfig(yaml);
    const provider = new EnvSecretProvider(BAG);
    const registry = await Registry.build({
      config,
      secrets: provider,
      mode: "core",
      env: ENV,
    });
    const app = createApp({
      config,
      registry,
      tokenStore: tokenStoreFromConfig(config, ENV),
      mode: "core",
      env: ENV,
      secrets: BAG,
      secretProvider: provider,
    });
    const s = app.listen(0);
    await new Promise<void>((r) => s.on("listening", () => r()));
    const addr = s.address();
    if (typeof addr === "string" || !addr) throw new Error("no port");
    const body = await (
      await fetch(`http://127.0.0.1:${addr.port}/ui`, { headers: AUTH })
    ).text();
    s.close();
    return body;
  };

  const EMPTY = `
version: 1
gateway: { name: strad, env: test }
auth:
  staticTokens: { enabled: true }
  consoleDevBypass: { enabled: true, roles: [admin] }
roles: { admin: { servers: ["*"] } }
servers: []
`;

  it("does NOT claim every server is READY over an empty grid", async () => {
    // The core ships with ZERO servers (src/config/schema.ts), so this is the
    // very first screen of a fresh install. "Every server is READY" above "No
    // servers are configured on this gateway" is an unearned green of exactly
    // the kind this module refuses everywhere else: nothing was checked because
    // there was nothing to check.
    const body = await boot(EMPTY);
    expect(body).not.toContain("Every server is READY");
    expect(body).toContain("No servers are enabled on this gateway");
    expect(body).toContain(
      `<p class="empty">No servers are configured on this gateway.</p>`,
    );
  });

  it("says the same when every server is DISABLED, not just when there are none", async () => {
    // `sorted.length` is non-zero here and `statuses.length` is not — the grid
    // renders a card and the roster is still empty.
    const body = await boot(
      EMPTY.replace(
        "servers: []",
        `servers:
  - slug: off-server
    kind: remote-http
    url: https://x.example.com/mcp
    enabled: false
    headers: { Authorization: "Bearer \${OFF_TOKEN}" }
    entitlements: [admin]`,
      ),
    );
    expect(body).not.toContain("Every server is READY");
    expect(body).toContain("No servers are enabled on this gateway");
    expect(body).toContain('<span class="chip chip-off">disabled</span>');
  });
});

describe("GET /ui — the ISSUE popout", () => {
  const popout = () => {
    const at = html.indexOf('<dialog class="fixdlg" id="fix-beta"');
    expect(at).toBeGreaterThan(-1);
    return html.slice(at, html.indexOf("</dialog>", at));
  };

  it("exists for every entry that has a secret to report on, READY included", () => {
    // A READY entry has something to show — which secret, from which source,
    // established by which process and how recently. Hiding that would be the
    // same mistake as the shrug: information the console holds and does not
    // show.
    expect(html).toContain('id="fix-beta"');
    expect(html).toContain('id="fix-object-store-bad"');
    expect(html).toContain('id="fix-alpha"');
    expect(html).toContain('id="fix-object-store"');
    // A DISABLED server carries no badge and no popout: strad does not mount it,
    // so it needs no secrets and `deriveServerStatuses` skips it entirely.
    expect(html).not.toContain('id="fix-retired"');
  });

  it("names the secret, the state, and what kind of problem it is", () => {
    const body = popout();
    expect(body).toContain("${BETA_TOKEN}");
    expect(body).toContain(
      '<span class="chip chip-bad chip-route">not seeded</span>',
    );
    expect(body).toContain("A secret this server needs is not seeded");
  });

  it("names the exact GCP resource, project and command — not a generic error", () => {
    const body = popout();
    // Both routes: the canonical parameter path and the Secret Manager secret
    // the deploy bakes in.
    expect(body).toContain("/strad/test/gateway/static/BETA_TOKEN");
    expect(body).toContain("strad-test-BETA_TOKEN");
    expect(body).toContain("gcloud secrets create strad-test-BETA_TOKEN");
    expect(body).toContain("gcloud secrets versions add");
    expect(body).toContain("<dt>project</dt>");
  });

  it("says 'could not be checked' rather than 'broken' for an unobservable one", () => {
    const at = html.indexOf('<dialog class="fixdlg" id="fix-object-store-bad"');
    const body = html.slice(at, html.indexOf("</dialog>", at));
    expect(body).toContain("could not be checked from the console");
    expect(body).toContain("not the same as healthy");
  });

  it("degrades without JS: the buttons hide and the panels render inline", () => {
    expect(html).toContain("<noscript><style>");
    expect(html).toContain(".chip-button{display:none}");
    expect(html).toContain(".fixdlg{display:block;position:static");
  });

  it("leaks NO secret value", () => {
    for (const value of Object.values(BAG)) {
      if (value.length < 12) continue;
      expect(html).not.toContain(value);
    }
    expect(html).not.toContain("NeverShown");
  });
});
