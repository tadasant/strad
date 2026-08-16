import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config/load.ts";
import { parseImage, renderAppSpec } from "../src/deploy/appspec.ts";
import {
  coveredPerServer,
  groupByServer,
  seededByServer,
  substitutionBag,
  unreadParameters,
} from "../src/deploy/server-namespaces.ts";
import type { ParameterMeta } from "../src/secrets/parameters/types.ts";

/**
 * PER-SERVER SUBSTITUTION, at the renderer.
 *
 * The flaw: a `${NAME}` in a supplementary server's `env:` resolved from ONE
 * flat namespace keyed on the name, so a name was a deployment-wide singleton
 * and two servers could not be given different values for it. The fix layers the
 * server's own `/strad/{env}/mcp/{slug}/static/` over the shared one.
 *
 * Every value here is an obviously-fake placeholder. Nothing in this file is a
 * credential, and nothing in this file is shaped like one on purpose.
 */

const CONFIG = (servers: string, bundles: string) => `
version: 1
gateway:
  name: strad
  env: test
auth:
  staticTokens: { enabled: true, store: env }
roles:
  admin: { servers: ["*"] }
bundles:
${bundles}servers:
${servers}`;

const SUPPLEMENTARY = (
  slug: string,
  bundle: string,
  extra = "",
) => `  - slug: ${slug}
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:0.1.0
    bundle: ${bundle}
    path: /telegram
    entitlements: [admin]
    env:
      TELEGRAM_API_HASH: "\${TELEGRAM_API_HASH}"
${extra}`;

const IMAGE = parseImage("ghcr.io/tadasant/strad:0.1.0");

function render(
  yaml: string,
  bags: {
    secrets?: Record<string, string>;
    serverSecrets?: Record<string, Record<string, string>>;
  },
) {
  return renderAppSpec({
    config: parseConfig(yaml),
    appName: "strad-test",
    region: "nyc",
    image: IMAGE,
    env: [],
    secrets: bags.secrets,
    serverSecrets: bags.serverSecrets,
  });
}

const valueOf = (
  spec: ReturnType<typeof renderAppSpec>,
  component: string,
  key: string,
): string | undefined =>
  spec.services
    .find((s) => s.name === component)
    ?.envs.find((e) => e.key === key)?.value;

describe("per-server env namespaces", () => {
  // ==========================================================================
  // THE HEADLINE CASE
  // ==========================================================================
  it("gives two servers DIFFERENT values for the SAME env var name", () => {
    const yaml = CONFIG(
      SUPPLEMENTARY("telegram-ro", "bundle-ro") +
        SUPPLEMENTARY("telegram-rw", "bundle-rw"),
      "  - name: bundle-ro\n  - name: bundle-rw\n",
    );

    const spec = render(yaml, {
      // The shared namespace holds a value for the name too. Neither server
      // should get it: its own namespace wins.
      secrets: { TELEGRAM_API_HASH: "fake-shared-hash" },
      serverSecrets: {
        "telegram-ro": { TELEGRAM_API_HASH: "fake-readonly-hash" },
        "telegram-rw": { TELEGRAM_API_HASH: "fake-readwrite-hash" },
      },
    });

    expect(valueOf(spec, "bundle-ro", "TELEGRAM_API_HASH")).toBe(
      "fake-readonly-hash",
    );
    expect(valueOf(spec, "bundle-rw", "TELEGRAM_API_HASH")).toBe(
      "fake-readwrite-hash",
    );
    // ...and the shared value reached neither of them.
    expect(JSON.stringify(spec)).not.toContain("fake-shared-hash");
  });

  it("resolves a second name from the shared namespace on the same server", () => {
    // The layering is per NAME, not per server: a server with its own namespace
    // does not lose access to the shared one for everything else.
    const yaml = CONFIG(
      SUPPLEMENTARY(
        "telegram-ro",
        "bundle-ro",
        `      TELEGRAM_API_ID: "\${TELEGRAM_API_ID}"\n`,
      ),
      "  - name: bundle-ro\n",
    );
    const spec = render(yaml, {
      secrets: {
        TELEGRAM_API_HASH: "fake-shared-hash",
        TELEGRAM_API_ID: "111111",
      },
      serverSecrets: { "telegram-ro": { TELEGRAM_API_HASH: "fake-own-hash" } },
    });
    expect(valueOf(spec, "bundle-ro", "TELEGRAM_API_HASH")).toBe(
      "fake-own-hash",
    );
    expect(valueOf(spec, "bundle-ro", "TELEGRAM_API_ID")).toBe("111111");
  });

  // ==========================================================================
  // BACKWARD COMPATIBILITY — the hard requirement
  // ==========================================================================
  it("resolves from the gateway namespace, unchanged, when nothing is seeded per-server", () => {
    const yaml = CONFIG(
      SUPPLEMENTARY("telegram-ro", "bundle-ro"),
      "  - name: bundle-ro\n",
    );
    const shared = { secrets: { TELEGRAM_API_HASH: "fake-shared-hash" } };

    // No serverSecrets at all (every deployment that predates this), and an
    // empty bag for the server (a namespace that exists and holds nothing).
    const before = render(yaml, shared);
    const withEmpty = render(yaml, { ...shared, serverSecrets: {} });
    const withEmptyBag = render(yaml, {
      ...shared,
      serverSecrets: { "telegram-ro": {} },
    });

    expect(valueOf(before, "bundle-ro", "TELEGRAM_API_HASH")).toBe(
      "fake-shared-hash",
    );
    // Byte for byte: an unseeded per-server namespace changes nothing at all,
    // not the value, not the ordering, not one field of the spec.
    expect(JSON.stringify(withEmpty)).toBe(JSON.stringify(before));
    expect(JSON.stringify(withEmptyBag)).toBe(JSON.stringify(before));
  });

  it("still fails closed on a ref no namespace can resolve", () => {
    const yaml = CONFIG(
      SUPPLEMENTARY("telegram-ro", "bundle-ro"),
      "  - name: bundle-ro\n",
    );
    // A per-server bag holding some OTHER name must not make the missing one
    // pass: shipping the literal "${TELEGRAM_API_HASH}" is the failure this
    // throw exists to prevent.
    expect(() =>
      render(yaml, { serverSecrets: { "telegram-ro": { OTHER: "x" } } }),
    ).toThrow(/TELEGRAM_API_HASH/);
  });

  // ==========================================================================
  // ONE CONTAINER IS ONE ENVIRONMENT
  // ==========================================================================
  it("refuses two values for one name on servers that SHARE a bundle", () => {
    const yaml = CONFIG(
      SUPPLEMENTARY("telegram-ro", "bundle") +
        SUPPLEMENTARY("telegram-rw", "bundle"),
      "  - name: bundle\n",
    );
    expect(
      () =>
        render(yaml, {
          serverSecrets: {
            "telegram-ro": { TELEGRAM_API_HASH: "fake-readonly-hash" },
            "telegram-rw": { TELEGRAM_API_HASH: "fake-readwrite-hash" },
          },
        }),
      // One path is one mount: the error now offers a path of its own first,
      // and a separate bundle second.
    ).toThrow(/ONE mount in the container/);
  });

  it("allows two servers on one bundle to be seeded the SAME value", () => {
    // The capability-variant case: `telegram-ro` and `telegram-rw` are one
    // container by design, and one credential is exactly what they share.
    const yaml = CONFIG(
      SUPPLEMENTARY("telegram-ro", "bundle") +
        SUPPLEMENTARY("telegram-rw", "bundle"),
      "  - name: bundle\n",
    );
    const spec = render(yaml, {
      serverSecrets: {
        "telegram-ro": { TELEGRAM_API_HASH: "fake-same-hash" },
        "telegram-rw": { TELEGRAM_API_HASH: "fake-same-hash" },
      },
    });
    expect(valueOf(spec, "bundle", "TELEGRAM_API_HASH")).toBe("fake-same-hash");
  });

  it("does not leak a value into the collision message", () => {
    const yaml = CONFIG(
      SUPPLEMENTARY("telegram-ro", "bundle") +
        SUPPLEMENTARY("telegram-rw", "bundle"),
      "  - name: bundle\n",
    );
    try {
      render(yaml, {
        serverSecrets: {
          "telegram-ro": { TELEGRAM_API_HASH: "fake-readonly-hash" },
          "telegram-rw": { TELEGRAM_API_HASH: "fake-readwrite-hash" },
        },
      });
      expect.unreachable("the render should have thrown");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain("TELEGRAM_API_HASH");
      expect(message).not.toContain("fake-readonly-hash");
      expect(message).not.toContain("fake-readwrite-hash");
    }
  });
});

// ============================================================================
// The namespace bookkeeping, unit by unit
// ============================================================================

const meta = (path: string, hasValue = true): ParameterMeta => ({
  path,
  variable: path.split("/").pop()!,
  secret: true,
  hasValue,
});

describe("seededByServer", () => {
  it("groups a listing of /strad/{env}/mcp/ by slug", () => {
    const seeded = seededByServer("test", [
      meta("/strad/test/mcp/telegram-ro/static/TELEGRAM_API_HASH"),
      meta("/strad/test/mcp/telegram-ro/static/TELEGRAM_API_ID"),
      meta("/strad/test/mcp/telegram-rw/static/TELEGRAM_API_HASH"),
    ]);
    expect(seeded.get("telegram-ro")).toEqual([
      "TELEGRAM_API_HASH",
      "TELEGRAM_API_ID",
    ]);
    expect(seeded.get("telegram-rw")).toEqual(["TELEGRAM_API_HASH"]);
  });

  it("ignores anything that is not a static server parameter", () => {
    const seeded = seededByServer("test", [
      // The gateway namespace is a sibling of mcp/, not a member of it.
      meta("/strad/test/gateway/static/STRAD_TOKENS"),
      // A future `oauth` kind is not a static parameter.
      meta("/strad/test/mcp/gcs/oauth/TOKEN"),
      // Another environment entirely.
      meta("/strad/prod/mcp/gcs/static/GCS_BUCKET"),
      // Present, but with no value to resolve.
      meta("/strad/test/mcp/gcs/static/EMPTY", false),
    ]);
    expect([...seeded.keys()]).toEqual([]);
  });

  it("keys a DEEP path on its last segment, because the resolver does", () => {
    // `resolve()` filters on the namespace prefix and keys on the last segment,
    // so `{slug}/static/extra/TOKEN` really is injected — as `TOKEN`. Dropping
    // it here would call a path unread that the resolver reads.
    const seeded = seededByServer("test", [
      meta("/strad/test/mcp/gcs/static/extra/TOKEN"),
    ]);
    expect(seeded.get("gcs")).toEqual(["TOKEN"]);
  });

  it("hands back the paths no resolver reads, rather than dropping them", () => {
    const { seeded, unroutable } = groupByServer("test", [
      meta("/strad/test/mcp/gcs/statik/TYPO"),
      meta("/strad/test/mcp/gcs/oauth/TOKEN"),
      meta("/strad/test/mcp/BARE"),
      meta("/strad/test/mcp/gcs/static/GOOD"),
    ]);
    expect(seeded.get("gcs")).toEqual(["GOOD"]);
    expect(unroutable).toEqual([
      "/strad/test/mcp/BARE",
      "/strad/test/mcp/gcs/oauth/TOKEN",
      "/strad/test/mcp/gcs/statik/TYPO",
    ]);
  });
});

describe("unreadParameters", () => {
  const yaml = (extra: string, bundles: string) => CONFIG(extra, bundles);

  it("names a parameter seeded under a server that reads nothing", () => {
    // THE SILENT NO-OP THIS REPLACES: values seeded under a server without
    // `params: true` produced no env var, no warning, and a green deploy.
    const config = parseConfig(
      yaml(SUPPLEMENTARY("telegram-ro", "bundle"), "  - name: bundle\n"),
    );
    const findings = unreadParameters(
      config,
      new Map([["telegram-ro", ["TELEGRAM_API_HASH", "UNREFERENCED_NAME"]]]),
    );
    expect(findings).toHaveLength(1);
    // The referenced one is read; only the other is reported.
    expect(findings[0]!.variables).toEqual(["UNREFERENCED_NAME"]);
    expect(findings[0]!.message).toContain(
      "/strad/test/mcp/telegram-ro/static/",
    );
    expect(findings[0]!.message).toContain("params: true");
  });

  it("says nothing when every seeded name is referenced", () => {
    const config = parseConfig(
      yaml(SUPPLEMENTARY("telegram-ro", "bundle"), "  - name: bundle\n"),
    );
    expect(
      unreadParameters(
        config,
        new Map([["telegram-ro", ["TELEGRAM_API_HASH"]]]),
      ),
    ).toEqual([]);
  });

  it("reports a namespace whose slug names no enabled server", () => {
    const config = parseConfig(
      yaml(SUPPLEMENTARY("telegram-ro", "bundle"), "  - name: bundle\n"),
    );
    const findings = unreadParameters(
      config,
      new Map([["telegram", ["TELEGRAM_API_HASH"]]]),
    );
    expect(findings[0]!.message).toContain("no ENABLED server");
  });

  it("reads an UNHOSTED server's namespace, rather than calling it unread", () => {
    // This used to report "runs outside strad's infrastructure and has no
    // environment to inject. Its ${NAME} refs resolve from the gateway
    // namespace." That was true of the RENDERER and is no longer true of the
    // deployment: an unhosted server's url/headers are resolved in strad's own
    // process, through its own namespace first. Seeding a credential here is
    // the recommended shape, so reporting it as unread would tell an operator to
    // undo the right thing.
    const config = parseConfig(
      yaml(
        `  - slug: anki
    kind: local-tunnel
    url: https://tunnel.example.com/mcp
    entitlements: [admin]
    headers:
      Authorization: "Bearer \${ANKI_MCP_API_KEY}"
`,
        "  - name: bundle\n",
      ),
    );
    expect(
      unreadParameters(config, new Map([["anki", ["ANKI_MCP_API_KEY"]]])),
    ).toEqual([]);

    // ...and a name it does NOT reference is still reported, by the one rule
    // that was always real: nothing names it.
    const findings = unreadParameters(
      config,
      new Map([["anki", ["ANKI_MCP_API_KEY", "STRAY"]]]),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.variables).toEqual(["STRAY"]);
    expect(findings[0]!.message).toContain("local-tunnel");
  });

  it("reads a builtin's options: refs from its own namespace too", () => {
    const config = parseConfig(
      yaml(
        `  - slug: echo
    kind: builtin
    module: "./servers/echo.js"
    bundle: core
    entitlements: [admin]
    options:
      greeting: "\${ECHO_GREETING}"
`,
        "  - name: bundle\n",
      ),
    );
    expect(
      unreadParameters(config, new Map([["echo", ["ECHO_GREETING"]]])),
    ).toEqual([]);
  });

  it("counts a supplementary server's headers:, not just its env:", () => {
    // Those are the headers CORE sends when it proxies — resolved in core's
    // process, through the same per-server layer.
    const config = parseConfig(
      yaml(
        `  - slug: shop
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle
    entitlements: [admin]
    headers:
      Authorization: "Bearer \${SHOP_PROXY_TOKEN}"
`,
        "  - name: bundle\n",
      ),
    );
    expect(
      unreadParameters(config, new Map([["shop", ["SHOP_PROXY_TOKEN"]]])),
    ).toEqual([]);
  });

  it("stays quiet for a params: true server, whose namespace is read whole", () => {
    const config = parseConfig(
      yaml(
        SUPPLEMENTARY("telegram-ro", "bundle", "    params: true\n"),
        "  - name: bundle\n",
      ),
    );
    expect(
      unreadParameters(config, new Map([["telegram-ro", ["ANYTHING_AT_ALL"]]])),
    ).toEqual([]);
  });
});

describe("substitutionBag / coveredPerServer", () => {
  it("takes only the names the server's env: references", () => {
    const { bag } = substitutionBag(
      { TELEGRAM_API_HASH: "fake-hash", SOMETHING_ELSE: "fake-else" },
      new Set(["TELEGRAM_API_HASH", "NOT_RESOLVED"]),
    );
    expect(bag).toEqual({ TELEGRAM_API_HASH: "fake-hash" });
  });

  it("refuses a value that is an un-dereferenced __REF__ or empty", () => {
    // `resolve()` does not promise a VALUE: a `:render` that could not
    // dereference hands the pointer back, and an empty payload resolves to "".
    // Taking either would bake a non-credential onto the container AND suppress
    // the gateway namespace, which still holds a value that works. Both are
    // reported and dropped, so `coveredPerServer` says false and the fallback
    // stands.
    const { bag, unusable } = substitutionBag(
      {
        POINTER:
          '__REF__("//secretmanager.googleapis.com/projects/p/secrets/s/versions/latest")',
        EMPTY: "",
        GOOD: "fake-usable-value",
      },
      new Set(["POINTER", "EMPTY", "GOOD"]),
    );
    expect(bag).toEqual({ GOOD: "fake-usable-value" });
    expect(unusable.sort()).toEqual(["EMPTY", "POINTER"]);
    expect(
      coveredPerServer("POINTER", new Map([["s", new Set(["POINTER"])]]), {
        s: bag,
      }),
    ).toBe(false);
  });

  it("says a name is covered only when EVERY referencing server holds it", () => {
    const refs = new Map([
      ["telegram-ro", new Set(["TELEGRAM_API_HASH"])],
      ["telegram-rw", new Set(["TELEGRAM_API_HASH"])],
    ]);
    expect(
      coveredPerServer("TELEGRAM_API_HASH", refs, {
        "telegram-ro": { TELEGRAM_API_HASH: "fake-hash" },
      }),
    ).toBe(false);
    expect(
      coveredPerServer("TELEGRAM_API_HASH", refs, {
        "telegram-ro": { TELEGRAM_API_HASH: "fake-hash" },
        "telegram-rw": { TELEGRAM_API_HASH: "fake-hash" },
      }),
    ).toBe(true);
  });
});
