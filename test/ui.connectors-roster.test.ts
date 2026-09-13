import { sharedSecretProviders } from "../src/secrets/provider/index.ts";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tokenStoreFromConfig } from "../src/auth/index.ts";
import { parseConfig } from "../src/config/load.ts";
import { Registry } from "../src/gateway/registry.ts";
import { createApp } from "../src/http/app.ts";
import { EnvSecretProvider } from "../src/secrets/provider/index.ts";
import { badgeFor, sortEntries, type Entry } from "../src/ui/roster-page.ts";
import type { ServerConfig } from "../src/config/schema.ts";

/**
 * `/connectors` — the badges, the grouping, and the popout.
 *
 * `test/ui.secret-status.test.ts` covers the derivation; this file covers what
 * the roster does WITH it. Four claims, and each one is a decision that could
 * have gone the other way:
 *
 *   1. READY means OBSERVED. "Could not be checked" is an ISSUE, not a quiet
 *      green — otherwise a store outage renders a fleet of reassuring badges.
 *   2. THE BADGE TOOK THE SLUG'S SLOT. The slug was printed twice on every entry
 *      that declares no `title:`, and once is enough.
 *   3. THE ISSUE BADGE IS A CONTROL. It opens a popout naming the secret, the
 *      store, the project and the exact path — not a generic "something is
 *      wrong".
 *   4. THE ENTRIES THAT NEED SOMETHING COME FIRST. This is a working surface,
 *      not a scoreboard; sorting the greens to the top put the rows worth
 *      reading below the fold on a 35-entry roster.
 *
 * `test/connectors.render.test.ts` covers the OTHER half of the same page — the
 * editor controls, the source chips and the escaping — which needs a runtime
 * roster holder and is therefore driven through the renderer rather than HTTP.
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
  // Bound, and nothing is listening — which is what makes MANAGED_YAML's entry
  // `unverified` with a REASON ("unreachable") rather than an unwired shrug.
  STRAD_BUNDLE_URL_BUNDLE_INTERNAL: "http://127.0.0.1:1",
  STRAD_TOKENS: "[]",
};

let server: Server;
let html: string;

/** Boot a gateway on this YAML and return the `/ui` it renders, signed in. */
const boot = async (yaml: string): Promise<string> => {
  const config = parseConfig(yaml);
  const provider = new EnvSecretProvider(BAG);
  const registry = await Registry.build({
    config,
    secrets: sharedSecretProviders(provider),
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
    secretProvider: sharedSecretProviders(provider),
  });
  const s = app.listen(0);
  await new Promise<void>((r) => s.on("listening", () => r()));
  const addr = s.address();
  if (typeof addr === "string" || !addr) throw new Error("no port");
  const body = await (
    await fetch(`http://127.0.0.1:${addr.port}/connectors`, { headers: AUTH })
  ).text();
  s.close();
  return body;
};

beforeAll(async () => {
  const provider = new EnvSecretProvider(BAG);
  const registry = await Registry.build({
    config: CONFIG,
    secrets: sharedSecretProviders(provider),
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
    secretProvider: sharedSecretProviders(provider),
  });
  const s = app.listen(0);
  await new Promise<void>((r) => s.on("listening", () => r()));
  const addr = s.address();
  if (typeof addr === "string" || !addr) throw new Error("no port");
  server = s;
  html = await (
    await fetch(`http://127.0.0.1:${addr.port}/connectors`, { headers: AUTH })
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
    dedicated: boolean,
    enabled = true,
  ): Entry => ({
    server: { slug, enabled } as ServerConfig,
    badge,
    view: dedicated ? "gcs" : "overview",
  });

  it("puts ISSUE before READY, and a dedicated view before the overview", () => {
    // The order runs the other way from the one the roster shipped with, and
    // deliberately: the entries something has to be done about are why anyone
    // opens this page, and sorting the greens to the top is what pushed them
    // below the fold.
    const sorted = sortEntries([
      entry("ready-no-view", "READY", false),
      entry("issue-no-view", "ISSUE", false),
      entry("ready-view", "READY", true),
      entry("issue-view", "ISSUE", true),
    ]);
    expect(sorted.map((e) => e.server.slug)).toEqual([
      "issue-view",
      "issue-no-view",
      "ready-view",
      "ready-no-view",
    ]);
  });

  it("sorts a DISABLED server last, whatever its view", () => {
    // It carries no badge at all: strad does not mount it, so it needs no
    // secrets, and a green would be a claim about a server that answers nothing.
    const sorted = sortEntries([
      entry("off", undefined, true, false),
      entry("on", "READY", false),
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

describe("GET /connectors — badges", () => {
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

  it("prints the slug beside the name only where a title: differs from it", () => {
    // `beta` declares no `title:`, so the name IS the slug — printing it again
    // beside itself was the duplication this replaces.
    expect(html).not.toContain('<code class="conn-alt">beta</code>');
    expect(html).not.toContain('<code class="conn-alt">alpha</code>');
    // Where a `title:` genuinely differs, the slug is information rather than an
    // echo, and it still renders beside the name.
    expect(html).toContain('<code class="conn-alt">object-store-bad</code>');
  });

  it("orders the rows ISSUE-first, then by whether the entry has a view", () => {
    // The config declares them in the WRONG order on purpose — beta,
    // object-store-bad, alpha, object-store, retired — so a page that simply
    // echoed config order would fail this.
    const at = (needle: string) => {
      const i = html.indexOf(needle);
      expect(i, `${needle} is on the page`).toBeGreaterThan(-1);
      return i;
    };
    const bad = at(">Broken bucket</a>"); // ISSUE + view
    const beta = at(">beta</a>"); // ISSUE, overview only
    const objectStore = at(">object-store</a>"); // READY + view
    const alpha = at(">alpha</a>"); // READY, overview only
    const retired = at(">retired</a>"); // disabled

    expect(beta).toBeGreaterThan(bad);
    expect(objectStore).toBeGreaterThan(beta);
    expect(alpha).toBeGreaterThan(objectStore);
    expect(retired).toBeGreaterThan(alpha);
  });

  it("draws a heading over each group, with its count", () => {
    // The grouping is what makes the order legible rather than merely correct:
    // "three of these need something" is a claim a reader can act on, where a
    // silently reordered list is one they have to infer.
    for (const [label, count] of [
      ["Needs attention", 2],
      ["Ready", 2],
      ["Disabled", 1],
    ] as const) {
      expect(html).toContain(
        `<span class="conn-group-l">${label}</span><span class="conn-group-n">${count}</span>`,
      );
    }
  });
});

describe("GET /connectors — the store diagnosis is cached, and the page says so", () => {
  /** Boot with a counting store and render `/ui` twice on the one process. */
  const render = async (
    opts: { renderThrows?: boolean } = {},
  ): Promise<{
    first: string;
    second: string;
    lists: number;
    renders: number;
  }> => {
    let lists = 0;
    let renders = 0;
    const counting = {
      list: async (namespace: string) => {
        lists += 1;
        return [
          {
            path: `${namespace}ALPHA_TOKEN`,
            variable: "ALPHA_TOKEN",
            secret: true,
            hasValue: true,
            latestVersion: "v1",
          },
        ];
      },
      resolveDetailed: async () => {
        renders += 1;
        if (opts.renderThrows) throw new Error("render refused");
        return { values: { ALPHA_TOKEN: "value" }, unrenderable: [] };
      },
    };

    const provider = new EnvSecretProvider(BAG);
    const registry = await Registry.build({
      config: CONFIG,
      secrets: sharedSecretProviders(provider),
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
      secretProvider: sharedSecretProviders(provider),
      diagnosticStore: counting,
    });
    const s = app.listen(0);
    await new Promise<void>((r) => s.on("listening", () => r()));
    const addr = s.address();
    if (typeof addr === "string" || !addr) throw new Error("no port");
    const get = async (): Promise<string> =>
      (
        await fetch(`http://127.0.0.1:${addr.port}/connectors`, {
          headers: AUTH,
        })
      ).text();
    const first = await get();
    const second = await get();
    s.close();
    return { first, second, lists, renders };
  };

  it("reads the store once for two renders, and prints when it read it", async () => {
    // A page load costs a full index read plus a per-parameter render pass. The
    // TTL is what keeps a reloaded console — and the readiness endpoint next to
    // it — from paying that per request.
    const { first, second, lists, renders } = await render();
    expect(lists).toBe(1);
    expect(renders).toBe(1);

    // And the held verdict is not presented as a fresh one. The console's
    // posture is that it says what it established and WHEN. Matched as a shape
    // rather than as "just now": the exact age depends on a real clock over two
    // real renders, and what is under test is that an age is printed at all.
    for (const html of [first, second]) {
      expect(html).toMatch(/was read (just now|\d+s ago)/);
      expect(html).toContain("reused for up to 60s");
    }
  });

  it("names the half that failed, and the SHORTER window a half-read pass gets", async () => {
    // The index answered and the render did not, so `unrenderable` is not a
    // complete list. That pass is held for the failure backoff, not the TTL —
    // and the sentence whose whole job is to state the staleness bound has to
    // state the one that applies, not the healthy-case one.
    const { first, lists, renders } = await render({ renderThrows: true });
    expect(lists).toBe(1);
    expect(renders).toBe(1);
    expect(first).toContain("its per-parameter render did not answer");
    expect(first).toContain("reused for up to 5s");
    expect(first).not.toContain("reused for up to 60s");
  });

  it("says nothing about a diagnosis when there is no store to diagnose", async () => {
    // No resolver credential means the distinction was never drawn, and an age
    // sentence about an absent reading would be noise.
    expect(html).not.toContain("reused for up to");
  });
});

describe("GET /connectors with nothing enabled", () => {
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
      `class="empty">No servers are configured on this gateway.`,
    );
  });

  it("says the same when every server is DISABLED, not just when there are none", async () => {
    // `sorted.length` is non-zero here and `statuses.length` is not — the table
    // renders a row and the secret roster is still empty.
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

describe("GET /connectors — the ISSUE popout", () => {
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

// ---------------------------------------------------------------------------
// The playground icon: offered only where the playground OPENS
// ---------------------------------------------------------------------------
// A `params: true` server nothing could answer for — the dead-control shape
// ---------------------------------------------------------------------------

/**
 * The one entry with an `ISSUE` badge and NOT ONE requirement row.
 *
 * `params: true` means this server's credentials are managed parameters under
 * `/strad/{env}/mcp/{slug}/static/` rather than `${NAME}` references, so core
 * cannot enumerate them; the component that holds them is asked instead, and
 * here it cannot be reached. The status is `unverified` with zero requirements —
 * which is the exact shape that rendered a `<button data-fix-open="fix-...">`
 * over a `<dialog>` nobody emitted, and swallowed the click.
 */
const MANAGED_YAML = `
version: 1
gateway:
  name: strad
  env: test
auth:
  staticTokens: { enabled: true }
  consoleDevBypass: { enabled: true, roles: [admin] }
roles:
  admin: { servers: ["*"] }
bundles:
  - name: bundle-internal
servers:
  - slug: craigslist
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle-internal:sha-7344fb47
    bundle: bundle-internal
    path: /craigslist
    entitlements: [admin]
    params: true
`;

/** The other side of the rule: an entry that genuinely has nothing behind it. */
const NO_SECRETS_YAML = `
version: 1
gateway:
  name: strad
  env: test
auth:
  staticTokens: { enabled: true }
  consoleDevBypass: { enabled: true, roles: [admin] }
roles:
  admin: { servers: ["*"] }
bundles: []
servers:
  - slug: echo
    kind: builtin
    module: "./servers/echo.js"
    bundle: core
    entitlements: [admin]
`;

describe("GET /connectors — an ISSUE badge is never a dead control", () => {
  let managed: string;
  beforeAll(async () => {
    managed = await boot(MANAGED_YAML);
  });

  /** Every `data-fix-open` on the page, in document order. */
  const openers = (page: string): string[] =>
    [...page.matchAll(/data-fix-open="([^"]+)"/g)].map((m) => m[1]!);

  it("emits a <dialog> for EVERY opener the page renders", () => {
    // The invariant, stated over the whole page rather than over one slug: a
    // control whose target id was never emitted is a click into nothing, and
    // `FIX_DIALOG_SCRIPT` returns silently on the missing element. This is the
    // assertion that fails without hasFixDialog() — `craigslist` renders the
    // button and the dialog list, filtered on `requirements.length > 0`, skips
    // it.
    const found = openers(managed);
    expect(found).toContain("fix-craigslist");
    for (const id of found) {
      expect(managed).toContain(`<dialog class="fixdlg" id="${id}"`);
    }
    // And the same over the main fixture, so the rule is not a special case.
    for (const id of openers(html)) {
      expect(html).toContain(`<dialog class="fixdlg" id="${id}"`);
    }
  });

  it("asks the SAME predicate on both badge branches", () => {
    // The half that was missing. `openable` was consulted only on the READY
    // branch, so an ISSUE entry with nothing behind it got the button anyway —
    // which is the drift, not a symptom of it. Asserted as a property of the
    // rendered page: no chip-button anywhere without its dialog, on either
    // colour, across both fixtures.
    for (const page of [managed, html]) {
      const buttons = [
        // `[^>]*?` keeps the match INSIDE the opening tag. `[\s\S]*?` would run
        // past it, so a chip-button rendered with no data-fix-open would pair
        // with the NEXT button's id and this assertion would pass anyway.
        ...page.matchAll(
          /<button class="chip chip-(ok|bad) chip-badge chip-button"[^>]*?data-fix-open="([^"]+)"/g,
        ),
      ];
      expect(buttons.length).toBeGreaterThan(0);
      for (const [, , id] of buttons) {
        expect(page).toContain(`<dialog class="fixdlg" id="${id}"`);
      }
    }
  });

  it("keeps the ISSUE chip a BUTTON rather than degrading it to inert text", () => {
    // The other way to close the gap, and the wrong one: an inert chip asserts
    // "this needs attention" and offers no way to find out why — while the
    // banner above the grid says in so many words that the popouts explain it.
    expect(managed).toContain(
      'data-fix-open="fix-craigslist" aria-haspopup="dialog"',
    );
  });

  it("gives that popout something TRUE to say: which component, why, and where", () => {
    const at = managed.indexOf('<dialog class="fixdlg" id="fix-craigslist"');
    const body = managed.slice(at, managed.indexOf("</dialog>", at));
    // Which component holds it, and that this process is not it.
    expect(body).toContain("bundle-internal");
    expect(body).toContain("not visible here");
    // WHY it could not be checked — the probe outcome, not a shrug.
    expect(body).toContain("could not be reached from this process");
    // WHERE to look instead: the store, the namespace, the project, the route.
    expect(body).toContain("/strad/test/mcp/craigslist/static/");
    expect(body).toContain("<dt>project</dt>");
    expect(body).toContain(
      "/ui/secrets?ns=%2Fstrad%2Ftest%2Fmcp%2Fcraigslist%2Fstatic%2F",
    );
    // And it still does not pretend to know the answer.
    expect(body).toContain("could not be checked from the console");
  });

  it("leaves a no-secrets entry inert — that one really has nothing behind it", async () => {
    // The degradation that was always right stays right: `echo` references no
    // ${NAME} and manages no parameters, so its READY chip is a <span> and no
    // dialog is emitted for it. Widening the rule must not widen it to this.
    const page = await boot(NO_SECRETS_YAML);
    expect(page).toContain('<span class="chip chip-ok chip-badge"');
    expect(page).not.toContain('data-fix-open="fix-echo"');
    expect(page).not.toContain('id="fix-echo"');
  });
});

// ---------------------------------------------------------------------------

/**
 * `console` is granted every server; `theirs` grants only `agent`.
 *
 * That is the intersection in `entitledServers()` — role→servers AND
 * server→`entitlements:`, both directions — and it is the case the index used to
 * get wrong: `theirs` is enabled, so it drew an icon, and the page behind the
 * icon answered 424.
 */
const ROLES_YAML = (consoleRoles: string) => `
version: 1
gateway: { name: strad, env: test }
auth:
  staticTokens: { enabled: true }
  consoleDevBypass: { enabled: true, roles: ${consoleRoles} }
roles:
  console: { servers: ["*"] }
  agent: { servers: ["*"] }
servers:
  - slug: mine
    kind: remote-http
    url: https://mine.example.com/mcp
    entitlements: [console]
  - slug: theirs
    kind: remote-http
    url: https://theirs.example.com/mcp
    entitlements: [agent]
  - slug: retired
    kind: remote-http
    url: https://retired.example.com/mcp
    enabled: false
    entitlements: [console]
`;

const playIcon = (slug: string) =>
  `aria-label="Open the playground for ${slug}"`;
const copyIcon = (slug: string) => `aria-label="Copy the MCP URL for ${slug}"`;

describe("GET /connectors — the playground icon", () => {
  it("offers it only where THIS console identity may open the playground", async () => {
    // The icon and the page are one decision (`playgroundAccess`). `theirs` is
    // ENABLED and reached by `console: { servers: ["*"] }`, and its own
    // `entitlements:` still exclude this session — so /playground/theirs answers
    // 424 and the card must not offer it.
    const body = await boot(ROLES_YAML("[console]"));

    expect(body).toContain(playIcon("mine"));
    expect(body).not.toContain(playIcon("theirs"));
    // Still a disabled server, still no icon: the assertion that held before.
    expect(body).not.toContain(playIcon("retired"));

    // The ROW is there either way — roles are not a console ACL, and hiding an
    // entry would be a different (and wrong) change. Only the control is gone.
    expect(body).toContain('href="/ui/theirs">theirs</a>');
  });

  it("keeps the copy icon on a server this identity is not entitled to", async () => {
    // Deliberate. The copied URL is addressed to a TOKEN principal — a different
    // identity — so an operator copying the URL an agent's token will use is
    // doing something legitimate that their own console roles say nothing about.
    // `enabled` is the only property of the server the paste depends on.
    const body = await boot(ROLES_YAML("[console]"));

    expect(body).toContain(copyIcon("theirs"));
    expect(body).toContain(copyIcon("mine"));
    // A disabled server is mounted for nobody, so no token makes that URL work.
    expect(body).not.toContain(copyIcon("retired"));
  });

  it("offers it nowhere when the console principal holds NO roles", async () => {
    // The schema default for both console role arrays is `[]`
    // (src/config/schema.ts), so a config that omits `roles:` gets a console
    // entitled to nothing. The playground is fail-closed for it by design; every
    // card drawing an icon into that 424 was the defect.
    const body = await boot(ROLES_YAML("[]"));

    expect(body).not.toContain('aria-label="Open the playground for');
    // The page is otherwise unchanged: the cards, and the copy icons, remain.
    expect(body).toContain('href="/ui/mine">mine</a>');
    expect(body).toContain(copyIcon("mine"));
  });
});
