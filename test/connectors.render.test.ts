import { describe, expect, it } from "vitest";
import { parseConfig, parseYamlDocument } from "../src/config/load.ts";
import {
  EMPTY_OVERLAY,
  assertEditable,
  withUpsert,
} from "../src/config/overlay.ts";
import { entryFromForm } from "../src/ui/servers.ts";
import { renderForm } from "../src/ui/servers-page.ts";
import { renderConnectors } from "../src/ui/roster-page.ts";
import type { Principal } from "../src/auth/index.ts";

/**
 * The console renders with template literals and one `esc()`, so escaping is a
 * property somebody has to keep true rather than one the types enforce. This
 * pins it: a regression here is a stored XSS on an admin console that can edit
 * the server list, which is about as bad as this product gets.
 *
 * The roster half is driven through `renderConnectors` rather than over HTTP,
 * because the editor controls only exist when there is a runtime holder and a
 * writable store — which over HTTP would mean a parameter store. The renderer
 * takes the same `roster` shape the route builds from that holder, so what is
 * exercised here is the markup the route emits.
 *
 * And `entryFromForm` — the most intricate pure function in this surface — is
 * exercised directly rather than only through HTTP, because its
 * owned-vs-carried rule is exactly the kind of thing an end-to-end test passes
 * over without noticing.
 */

/** A signed-in console identity entitled to nothing, which is enough here: the
 * only control roles decide is the playground icon, and these tests are about
 * the editor controls and the escaping. */
const PRINCIPAL: Principal = {
  kind: "console-bypass",
  id: "test",
  label: "test",
  roles: [],
};

/** The roster as the route renders it, with whatever roster state is passed. */
function roster(
  config: Parameters<typeof renderConnectors>[0]["config"],
  rosterState?: Parameters<typeof renderConnectors>[0]["roster"],
): string {
  return renderConnectors({
    config,
    statuses: [],
    boot: [],
    env: {},
    principal: PRINCIPAL,
    ...(rosterState ? { roster: rosterState } : {}),
  });
}

const BASE_YAML = `
version: 1
gateway: { name: strad, env: test }
auth:
  staticTokens: { enabled: true }
roles:
  admin: { servers: ["*"] }
servers:
  - slug: alpha
    kind: remote-http
    url: https://alpha.example.com/mcp
    entitlements: [admin]
`;

const BASE_DOC = parseYamlDocument(BASE_YAML);
const CONFIG = parseConfig(BASE_YAML);

/** The shapes that break out of each place a value lands in the markup. */
const NASTY = `"><script>alert(1)</script>`;

describe("escaping", () => {
  it("escapes a hostile title and description on the roster", () => {
    const hostile = parseConfig(
      BASE_YAML.replace(
        "    entitlements: [admin]",
        `    title: '${NASTY}'\n    description: '${NASTY}'\n    entitlements: [admin]`,
      ),
    );
    const html = roster(hostile, {
      overlay: EMPTY_OVERLAY,
      sources: new Map([["alpha", "file"]]),
      writable: true,
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    // The description lands in a `title=` attribute as well as in the body, and
    // an attribute is the place an unescaped quote breaks out cheapest.
    expect(html).not.toMatch(/title="[^"]*"><script/);
  });

  it("escapes a hostile slug everywhere the roster puts one", () => {
    // A slug cannot actually be this — the schema forbids it — but the roster
    // must not be the thing standing between a bad slug and an injection. It
    // reaches the name, the href, the popout ids and the four form actions.
    const html = roster(
      { ...CONFIG, servers: [{ ...CONFIG.servers[0]!, slug: NASTY }] },
      { overlay: EMPTY_OVERLAY, sources: new Map(), writable: true },
    );
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toMatch(/action="[^"]*"><script/);
  });

  it("escapes the author and timestamp the overlay carries", () => {
    const html = roster(CONFIG, {
      overlay: {
        version: 1,
        revision: 2,
        updatedBy: NASTY,
        updatedAt: NASTY,
        servers: { upserts: [], removals: [NASTY] },
      },
      sources: new Map(),
      writable: true,
    });
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  it("offers the editor controls only where a write would land", () => {
    // Three states, and the page has to tell them apart: no runtime holder at
    // all, a holder with nothing to write through, and a writable one. The
    // roster, the badges and the links are the same in all three — it is only
    // the controls that come and go.
    const none = roster(CONFIG);
    const readOnly = roster(CONFIG, {
      overlay: EMPTY_OVERLAY,
      sources: new Map([["alpha", "file"]]),
      writable: false,
    });
    const writable = roster(CONFIG, {
      overlay: EMPTY_OVERLAY,
      sources: new Map([["alpha", "file"]]),
      writable: true,
    });

    for (const html of [none, readOnly, writable]) {
      // The half that must never depend on the store.
      expect(html).toContain('<a class="conn-name" href="/ui/alpha">alpha</a>');
      expect(html).toContain("<h1>Connectors");
    }

    for (const html of [none, readOnly]) {
      expect(html).not.toContain('action="/connectors/alpha/remove"');
      expect(html).not.toContain('href="/connectors/new?kind=remote-http"');
    }

    // THE MIDDLE STATE KEEPS THE DOOR AND LOSES THE CONTROLS, and that is the
    // half worth pinning: `handleEdit` gates on `editable`, not `writable`, so
    // `/connectors/alpha` is a page on a gateway that holds a store it cannot
    // write — and that page is the only place an entry's FULL declaration is
    // shown. Dropping the link with the buttons would take it away from a
    // reader the route would have served.
    expect(readOnly).toContain(
      '<a class="btn-ghost" href="/connectors/alpha">View</a>',
    );
    // With no store at all the route answers the "editor is off" 404, so the
    // door would lead from a working page to a dead one.
    expect(none).not.toContain('href="/connectors/alpha"');
    expect(writable).toContain('action="/connectors/alpha/remove"');
    expect(writable).toContain('action="/connectors/alpha/toggle"');
    expect(writable).toContain('href="/connectors/alpha"');
    expect(writable).toContain('href="/connectors/new?kind=remote-http"');

    // And each of the three says which one it is, rather than leaving a reader
    // to work out why the buttons are missing.
    expect(none).toContain("sets no <code>gateway.configStore:</code>");
    expect(readOnly).toContain("cannot write the roster");
    expect(writable).not.toContain("cannot write the roster");
  });

  it("draws every entry, including one nothing derived a status for", () => {
    // The grouping is a PARTITION and it has to be total. A group set with a
    // hole does not render a row out of place, it drops it: the entry vanishes
    // from the table while the counts above keep claiming it is there. An
    // enabled entry with no badge is the shape that finds it, and it belongs
    // under "needs attention" — nothing was established about it, which is what
    // ISSUE means everywhere else on this page.
    const html = roster(CONFIG, {
      overlay: EMPTY_OVERLAY,
      sources: new Map([["alpha", "file"]]),
      writable: true,
    });
    expect(html).toContain('<a class="conn-name" href="/ui/alpha">alpha</a>');
    expect(html).toContain(
      '<span class="conn-group-l">Needs attention</span><span class="conn-group-n">1</span>',
    );
    expect(html).not.toContain("No servers are configured on this gateway.");
  });

  it("shows where an entry is declared only when something can say", () => {
    // The source chip is the one fact only the runtime holder knows. Without a
    // holder every entry comes from the file, and a chip repeating that on every
    // row is a column of noise.
    expect(roster(CONFIG)).not.toContain(">config file<");
    expect(
      roster(CONFIG, {
        overlay: EMPTY_OVERLAY,
        sources: new Map([["alpha", "store"]]),
        writable: true,
      }),
    ).toContain(">console<");
  });

  it("escapes every value the edit form puts back into an input", () => {
    const html = renderForm({
      config: CONFIG,
      entry: {
        slug: NASTY,
        kind: "remote-http",
        title: NASTY,
        description: NASTY,
        url: NASTY,
        headers: { [NASTY]: NASTY },
        tools: { allow: [NASTY] },
        mayBeUnseeded: [NASTY],
        oauthRefresh: {
          tokenUrl: NASTY,
          clientId: NASTY,
          scope: NASTY,
          authorizeParams: { [NASTY]: NASTY },
        },
      },
      slug: NASTY,
      kind: "remote-http",
      copyable: [{ slug: NASTY, title: NASTY }],
      copiedFrom: NASTY,
      revision: 1,
      source: "store",
      signedInAs: NASTY,
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    // And specifically: nothing broke out of an attribute.
    expect(html).not.toMatch(/value="[^"]*"><script/);
  });

  it("does not resolve a prototype member out of the kind blurb", () => {
    const html = renderForm({
      config: CONFIG,
      kind: "toString",
      copyable: [],
      revision: 0,
      source: "store",
    });
    expect(html).not.toContain("native code");
  });
});

describe("the form does not render a control the save path would reject", () => {
  const supplementary = {
    slug: "shop",
    kind: "supplementary-image",
    image: "ghcr.io/example/bundle:latest",
    bundle: "bundle",
    path: "/shop",
  };

  it("greys out path: on an edit, and says why", () => {
    const html = renderForm({
      config: CONFIG,
      entry: supplementary,
      slug: "shop",
      kind: "supplementary-image",
      copyable: [],
      revision: 1,
      source: "file",
    });
    expect(html).toMatch(/name="path"[^>]*disabled/);
    expect(html).toMatch(/belongs to the\s+container/);
    // And the note naming the frozen fields agrees with the rule.
    expect(html).toContain("image, bundle, path");
  });

  it("leaves it editable on a create, where choosing the mount is the point", () => {
    const html = renderForm({
      config: CONFIG,
      entry: { kind: "supplementary-image" },
      kind: "supplementary-image",
      copyable: [],
      revision: 0,
      source: "store",
    });
    expect(html).toMatch(/name="path"/);
    expect(html).not.toMatch(/name="path"[^>]*disabled/);
  });
});

describe("entryFromForm", () => {
  const form = (over: Record<string, string> = {}) => ({
    kind: "remote-http",
    slug: "sample",
    url: "https://sample.example.com/mcp",
    enabled: "on",
    "entitlement:admin": "on",
    ...over,
  });

  it("builds an entry from the fields the form owns", () => {
    expect(entryFromForm(form())).toEqual({
      slug: "sample",
      kind: "remote-http",
      entitlements: ["admin"],
      enabled: true,
      url: "https://sample.example.com/mcp",
    });
  });

  it("omits what was left blank rather than writing empty values", () => {
    const entry = entryFromForm(form());
    expect(entry).not.toHaveProperty("title");
    expect(entry).not.toHaveProperty("tools");
    expect(entry).not.toHaveProperty("headers");
  });

  it("writes `enabled: false` explicitly, because an unchecked box is absent", () => {
    const { enabled: _drop, ...rest } = form();
    expect(entryFromForm(rest).enabled).toBe(false);
  });

  it("CARRIES a field the form does not render", () => {
    // The rule that makes "edit the title" safe on an entry with fields this
    // form has no input for.
    const carried = entryFromForm(form({ title: "New title" }), {
      kind: "remote-http",
      oauth: { provider: "google", account: "a@b.com" },
      somethingFuture: "kept",
    });
    expect(carried.oauth).toEqual({ provider: "google", account: "a@b.com" });
    expect(carried.somethingFuture).toBe("kept");
    expect(carried.title).toBe("New title");
  });

  it("lets a blank field CLEAR one the form owns, over the carried value", () => {
    const cleared = entryFromForm(form(), {
      kind: "remote-http",
      title: "was here",
      headers: { Authorization: "Bearer x" },
    });
    expect(cleared).not.toHaveProperty("title");
    expect(cleared).not.toHaveProperty("headers");
  });

  it("parses headers as Name: value lines", () => {
    const entry = entryFromForm(
      form({ headers: "Authorization: Bearer ${T}\nX-Trace: on" }),
    );
    expect(entry.headers).toEqual({
      Authorization: "Bearer ${T}",
      "X-Trace": "on",
    });
  });

  it("refuses a headers line that is not a pair", () => {
    expect(() => entryFromForm(form({ headers: "no-colon-here" }))).toThrow(
      /Name: value/,
    );
  });

  it("only declares oauthRefresh when a token URL was given", () => {
    // The select supplies `clientAuth` unconditionally, so without this guard
    // every remote-http entry would claim an OAuth refresh it cannot perform.
    expect(
      entryFromForm(form({ oauthClientAuth: "basic" })),
    ).not.toHaveProperty("oauthRefresh");
    const withFlow = entryFromForm(
      form({
        oauthTokenUrl: "https://o.example.com/token",
        oauthClientAuth: "post",
      }),
    );
    expect(withFlow.oauthRefresh).toMatchObject({
      tokenUrl: "https://o.example.com/token",
      clientAuth: "post",
    });
  });

  it("parses oauthRefresh.authorizeParams, clears it when blanked, and carries what it has no input for", () => {
    const before = {
      kind: "remote-http",
      oauthRefresh: {
        tokenUrl: "https://o.example.com/token",
        authorizeParams: { access_type: "offline" },
        registration: { clientName: "Client (strad)" },
        discoveryProxy: { via: "brightdata" },
      },
    };
    const saved = entryFromForm(
      form({
        oauthTokenUrl: "https://o.example.com/token",
        oauthAuthorizeParams: "access_type: offline\nprompt: consent",
      }),
      before,
      { editing: true },
    );
    expect(saved.oauthRefresh).toEqual({
      tokenUrl: "https://o.example.com/token",
      authorizeParams: { access_type: "offline", prompt: "consent" },
      registration: { clientName: "Client (strad)" },
      discoveryProxy: { via: "brightdata" },
    });
    const cleared = entryFromForm(
      form({ oauthTokenUrl: "https://o.example.com/token" }),
      before,
      { editing: true },
    );
    expect(cleared.oauthRefresh).not.toHaveProperty("authorizeParams");
    expect(cleared.oauthRefresh).toHaveProperty("registration");
    // No token URL is no OAuth refresh at all: nothing is carried into one.
    expect(entryFromForm(form(), before, { editing: true })).not.toHaveProperty(
      "oauthRefresh",
    );
    // A COPY carries neither opt-in: they are one slug's.
    const copied = entryFromForm(
      form({ oauthTokenUrl: "https://o.example.com/token" }),
      before,
    );
    expect(copied.oauthRefresh).toEqual({
      tokenUrl: "https://o.example.com/token",
    });
  });

  it("refuses a non-numeric timeout rather than coercing it", () => {
    expect(() => entryFromForm(form({ timeoutMs: "soon" }))).toThrow(
      /must be a number/,
    );
  });

  it("hands a frozen field back on an EDIT, because a disabled input posts nothing", () => {
    // The form greys out `image:`, `bundle:` and `path:` on an edit. A disabled
    // input submits NOTHING, so owning those here would post an entry with no
    // image — which `assertEditable` reads as an image CHANGE and refuses. That
    // made every console edit of a supplementary entry unsaveable, including
    // one that only changed the title.
    const before = {
      kind: "supplementary-image",
      image: "ghcr.io/example/bundle:latest",
      bundle: "bundle",
      path: "/shop",
    };
    const body = {
      kind: "supplementary-image",
      slug: "shop",
      title: "New title",
      enabled: "on",
      "entitlement:admin": "on",
    };
    const edited = entryFromForm(body, before, { editing: true });
    expect(edited).toMatchObject({
      image: "ghcr.io/example/bundle:latest",
      bundle: "bundle",
      path: "/shop",
      title: "New title",
    });
    expect(() =>
      assertEditable({ ...before, slug: "shop" }, edited),
    ).not.toThrow();
  });

  it("still OWNS those fields on a create, where the form renders them enabled", () => {
    // "Copy from an existing one" carries a `before` too, and there the human
    // is choosing the mount — so a blank path is a blank path.
    const created = entryFromForm(
      {
        kind: "supplementary-image",
        slug: "shop-ro",
        image: "ghcr.io/example/bundle:latest",
        bundle: "bundle",
        path: "/vault",
        enabled: "on",
      },
      { kind: "supplementary-image", path: "/shop" },
    );
    expect(created.path).toBe("/vault");
  });

  it("round-trips through the overlay into a valid config", () => {
    const entry = entryFromForm(form({ title: "Sample" }));
    const merged = withUpsert(EMPTY_OVERLAY, entry, {
      fileSlugs: new Set(["alpha"]),
    });
    expect(merged.servers.upserts[0]).toMatchObject({ slug: "sample" });
    void BASE_DOC;
  });
});
