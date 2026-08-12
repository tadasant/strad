import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config/load.ts";
import { parseImage, renderAppSpec } from "../src/deploy/appspec.ts";
import { slugsWithPrefixedNames } from "../src/secrets/env-prefix.ts";

/**
 * SLUG-PREFIXED BOX NAMES, at the renderer.
 *
 * src/deploy/server-namespaces.ts decides which NAMESPACE a supplementary
 * server's `${NAME}` resolves from. This decides what the resolved value is
 * CALLED once it lands on the container — because a bundle is one container with
 * one `process.env`, and two servers that both want `TELEGRAM_API_HASH` need two
 * names, not two namespaces.
 *
 * The rule is strictly ADDITIVE, and most of these tests are about that. The
 * bare name belongs to the first server that declared it and is never taken
 * away; a server that resolves a DIFFERENT value gets `<SLUG>__<NAME>` of its
 * own. Dropping the contested bare name was the first design and it is wrong:
 * the drop is bundle-wide while the disagreement is between two servers, so a
 * third server that never disagreed with anyone would lose a variable it reads.
 *
 * Every value here is an obviously-fake placeholder. Nothing in this file is a
 * credential, and nothing in this file is shaped like one on purpose.
 */

const IMAGE = parseImage("ghcr.io/tadasant/strad:0.1.0");

const CONFIG = (servers: string, bundles = "  - name: bundle\n") => `
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

const TELEGRAM = (slug: string, path: string, bundle = "bundle") =>
  `  - slug: ${slug}
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:0.1.0
    bundle: ${bundle}
    path: ${path}
    entitlements: [admin]
    env:
      TELEGRAM_API_HASH: "\${TELEGRAM_API_HASH}"
`;

const SHARED = { TELEGRAM_API_HASH: "fake-shared-hash" };

const RO = { TELEGRAM_API_HASH: "fake-readonly-hash" };
const RW = { TELEGRAM_API_HASH: "fake-readwrite-hash" };

function render(
  yaml: string,
  bags: {
    secrets?: Record<string, string>;
    serverSecrets?: Record<string, Record<string, string>>;
    warnings?: string[];
  } = {},
) {
  return renderAppSpec({
    config: parseConfig(yaml),
    appName: "strad-test",
    region: "nyc",
    image: IMAGE,
    env: [],
    secrets: bags.secrets ?? SHARED,
    serverSecrets: bags.serverSecrets,
    onWarning: bags.warnings ? (m) => bags.warnings!.push(m) : undefined,
  });
}

const envOf = (spec: ReturnType<typeof renderAppSpec>, component: string) =>
  Object.fromEntries(
    (spec.services.find((s) => s.name === component)?.envs ?? []).map((e) => [
      e.key,
      e.value,
    ]),
  );

const aliasKeys = (spec: ReturnType<typeof renderAppSpec>, component: string) =>
  Object.keys(envOf(spec, component))
    .filter((k) => k.includes("__"))
    .sort();

const throwsWith = (fn: () => unknown): string => {
  try {
    fn();
  } catch (err) {
    return String(err);
  }
  return "";
};

describe("a deployment nothing contests", () => {
  it("emits the bare name it always emitted, and not one alias", () => {
    // The claim the 26 supplementary servers in prod rest on.
    const warnings: string[] = [];
    const spec = render(
      CONFIG(
        TELEGRAM("telegram-ro", "/telegram") +
          TELEGRAM("telegram-rw", "/telegram"),
      ),
      { warnings },
    );

    expect(envOf(spec, "bundle").TELEGRAM_API_HASH).toBe("fake-shared-hash");
    // An unambiguous bare name is read by every tree in the image, migrated or
    // not, so a second copy of a credential in the spec would buy nothing.
    expect(aliasKeys(spec, "bundle")).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("is unchanged when a seeded server is not a mount of its own", () => {
    // #125 layering with nobody to disagree with, on the conventional path:
    // telegram-ro's own value simply becomes the bundle's value, under the bare
    // name, as it did before.
    const spec = render(CONFIG(TELEGRAM("telegram-ro", "/telegram")), {
      serverSecrets: { "telegram-ro": RO },
    });
    expect(envOf(spec, "bundle").TELEGRAM_API_HASH).toBe("fake-readonly-hash");
    expect(aliasKeys(spec, "bundle")).toEqual([]);
  });

  it("names a seeded server on its own path even with nobody to disagree with", () => {
    // Seeding a namespace is the STABLE signal, and value inequality is not: if
    // per-slug names appeared only where two values differ, re-seeding this slug
    // to its neighbour's credential would drop them — and with them the instance
    // the bundle host mounts for it. A secret-store edit would take a working
    // slug off the air with a clean render.
    const spec = render(CONFIG(TELEGRAM("telegram-ro", "/telegram-ro")), {
      serverSecrets: { "telegram-ro": RO },
    });
    expect(envOf(spec, "bundle").TELEGRAM_API_HASH).toBe("fake-readonly-hash");
    expect(aliasKeys(spec, "bundle")).toEqual([
      "TELEGRAM_RO__TELEGRAM_API_HASH",
    ]);
  });

  it("is unchanged when two slugs on separate BUNDLES hold different values", () => {
    // The old answer still works, and still costs a container.
    const spec = render(
      CONFIG(
        TELEGRAM("telegram-ro", "/telegram", "bundle") +
          TELEGRAM("telegram-rw", "/telegram", "bundle-rw"),
        "  - name: bundle\n  - name: bundle-rw\n",
      ),
      { serverSecrets: { "telegram-ro": RO, "telegram-rw": RW } },
    );
    expect(envOf(spec, "bundle").TELEGRAM_API_HASH).toBe("fake-readonly-hash");
    expect(envOf(spec, "bundle-rw").TELEGRAM_API_HASH).toBe(
      "fake-readwrite-hash",
    );
    expect(aliasKeys(spec, "bundle")).toEqual([]);
    expect(aliasKeys(spec, "bundle-rw")).toEqual([]);
  });
});

describe("two slugs of one tree, two credentials, one container", () => {
  const TWO_PATHS =
    TELEGRAM("telegram-ro", "/telegram-ro") +
    TELEGRAM("telegram-rw", "/telegram-rw");
  const SEEDED = { "telegram-ro": RO, "telegram-rw": RW };

  it("keeps the bare name for the first declarant and names the dissenter", () => {
    // The headline. Before this, the same configuration was a hard error and the
    // only answer was a second container.
    const spec = render(CONFIG(TWO_PATHS), { serverSecrets: SEEDED });
    const env = envOf(spec, "bundle");

    // telegram-ro declared first, so the bare name carries its value and nothing
    // on the bundle loses a variable.
    expect(env.TELEGRAM_API_HASH).toBe("fake-readonly-hash");
    // Each is a mount of its own and each was seeded, so each gets its own name
    // — including the one that also owns the bare one.
    expect(env.TELEGRAM_RO__TELEGRAM_API_HASH).toBe("fake-readonly-hash");
    expect(env.TELEGRAM_RW__TELEGRAM_API_HASH).toBe("fake-readwrite-hash");
    expect(aliasKeys(spec, "bundle")).toEqual([
      "TELEGRAM_RO__TELEGRAM_API_HASH",
      "TELEGRAM_RW__TELEGRAM_API_HASH",
    ]);

    // One bundle. The whole point is that this does NOT need a second container.
    expect(spec.services.map((s) => s.name).sort()).toEqual(["bundle", "core"]);
  });

  it("never removes or repoints a name the component already held", () => {
    // The property that makes an added slug safe for the slugs already there:
    // every name in the no-dissent render survives, with its value, into the
    // dissenting one.
    const before = envOf(render(CONFIG(TWO_PATHS)), "bundle");
    const after = envOf(
      render(CONFIG(TWO_PATHS), { serverSecrets: { "telegram-rw": RW } }),
      "bundle",
    );
    for (const [key, value] of Object.entries(before)) {
      expect(after[key]).toBe(value);
    }
  });

  it("does not let a third server's disagreement cost an innocent one its variable", () => {
    // gmail-ro / gmail-rw / gmail-rw-external share one path and one value; a
    // fourth slug on its own path is seeded a different one. The three that
    // agreed keep the bare name their (unmigrated) tree reads — dropping it
    // would have taken three working slugs down to add one.
    const spec = render(
      CONFIG(
        TELEGRAM("gmail-ro", "/gmail") +
          TELEGRAM("gmail-rw", "/gmail") +
          TELEGRAM("gmail-rw-external", "/gmail") +
          TELEGRAM("gmail-personal", "/gmail-personal"),
      ),
      { serverSecrets: { "gmail-personal": RW } },
    );
    const env = envOf(spec, "bundle");
    expect(env.TELEGRAM_API_HASH).toBe("fake-shared-hash");
    expect(env.GMAIL_PERSONAL__TELEGRAM_API_HASH).toBe("fake-readwrite-hash");
  });

  it("emits the per-slug name as a SECRET, and keeps it off core", () => {
    const spec = render(CONFIG(TWO_PATHS), { serverSecrets: SEEDED });
    const alias = spec.services
      .find((s) => s.name === "bundle")!
      .envs.find((e) => e.key === "TELEGRAM_RW__TELEGRAM_API_HASH")!;
    expect(alias.type).toBe("SECRET");
    expect(alias.scope).toBe("RUN_TIME");
    expect(aliasKeys(spec, "core")).toEqual([]);
    expect(envOf(spec, "core").TELEGRAM_API_HASH).toBeUndefined();
  });

  it("says what it did, naming slugs and variables and never a value", () => {
    const warnings: string[] = [];
    const spec = render(CONFIG(TWO_PATHS), {
      serverSecrets: SEEDED,
      warnings,
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/TELEGRAM_RW__TELEGRAM_API_HASH/);
    expect(warnings[0]).toMatch(/telegram-rw/);
    for (const value of [
      "fake-readonly-hash",
      "fake-readwrite-hash",
      "fake-shared-hash",
    ]) {
      expect(warnings[0]).not.toContain(value);
    }
    // And nothing leaves a literal ref behind in the spec.
    expect(JSON.stringify(spec)).not.toContain("${TELEGRAM_API_HASH}");
  });
});

describe("what the renderer refuses", () => {
  it("refuses two values on slugs that share a path", () => {
    // Same path is one instance in the bundle host, serving both slugs from one
    // set of credentials. A second value has nowhere to go, whatever it is
    // called, so this stays a hard error — and the message says what the answer
    // is now.
    const thrown = throwsWith(() =>
      render(
        CONFIG(
          TELEGRAM("telegram-ro", "/telegram") +
            TELEGRAM("telegram-rw", "/telegram"),
        ),
        { serverSecrets: { "telegram-ro": RO, "telegram-rw": RW } },
      ),
    );
    expect(thrown).toMatch(/separate paths/);
    expect(thrown).toMatch(/ONE mount/);
    expect(thrown).not.toContain("fake-readonly-hash");
    expect(thrown).not.toContain("fake-readwrite-hash");
  });

  it("catches a same-path pair whatever order the config declares it in", () => {
    // The bug this replaced: only the FIRST server to declare a key was kept, so
    // a same-path pair declared second and third was compared against a
    // different-path server and never against each other — one mount, two
    // credentials, no error. Both orders must throw.
    const pair =
      TELEGRAM("b-ro", "/shared") +
      TELEGRAM("b-rw", "/shared") +
      TELEGRAM("a-solo", "/a-solo");
    const seeded = {
      serverSecrets: {
        "b-ro": RO,
        "b-rw": RW,
        "a-solo": { TELEGRAM_API_HASH: "fake-third-hash" },
      },
    };
    const pairFirst = throwsWith(() => render(CONFIG(pair), seeded));
    const soloFirst = throwsWith(() =>
      render(
        CONFIG(
          TELEGRAM("a-solo", "/a-solo") +
            TELEGRAM("b-ro", "/shared") +
            TELEGRAM("b-rw", "/shared"),
        ),
        seeded,
      ),
    );
    for (const thrown of [pairFirst, soloFirst]) {
      expect(thrown).toMatch(/"b-ro" and "b-rw"|"b-rw" and "b-ro"/);
      expect(thrown).toMatch(/path "\/shared"/);
    }
  });

  it("refuses a server that needs its own value and cannot be given one", () => {
    // Neither of these can be a mount of its own — `telegram-ro` shares the
    // conventional `/telegram`, `telegram-rw` sits on a path that is not its
    // slug — so neither can read anything but the bare name, and the bare name
    // holds one value. Refused at render, where it can still be fixed, rather
    // than shipped as a server quietly running on the other one's credential.
    const thrown = throwsWith(() =>
      render(
        CONFIG(
          TELEGRAM("telegram-ro", "/telegram") +
            TELEGRAM("telegram-rw", "/telegram-elsewhere"),
        ),
        { serverSecrets: { "telegram-rw": RW } },
      ),
    );
    expect(thrown).toMatch(/neither can be given a variable of its own/);
    expect(thrown).toMatch(/path: \/<its-own-slug>/);
    expect(thrown).not.toContain("fake-readwrite-hash");
  });

  it("refuses one whose slug cannot become a variable name", () => {
    // A leading digit mangles to something POSIX will not accept, so this server
    // can never be given a name of its own however it is pathed.
    const thrown = throwsWith(() =>
      render(
        CONFIG(
          TELEGRAM("telegram-ro", "/telegram") +
            TELEGRAM("1telegram", "/1telegram"),
        ),
        { serverSecrets: { "1telegram": RW } },
      ),
    );
    expect(thrown).toMatch(/neither can be given a variable of its own/);
    expect(thrown).toMatch(/1telegram/);
    expect(thrown).not.toContain("fake-readwrite-hash");
  });

  it("does not depend on the order a capability-variant group is declared in", () => {
    // gmail-ro/gmail-rw/gmail-rw-external share `/gmail` and one value; a fourth
    // slug on its own path is seeded a different one. The three sharing a path
    // can never be a mount of their own, so they own the bare name whether they
    // are declared before or after the dissenter — an earlier version compared
    // against whichever server came first and threw on one of the two orders.
    const variants =
      TELEGRAM("gmail-ro", "/gmail") +
      TELEGRAM("gmail-rw", "/gmail") +
      TELEGRAM("gmail-rw-external", "/gmail");
    const solo = TELEGRAM("gmail-personal", "/gmail-personal");
    const seeded = { serverSecrets: { "gmail-personal": RW } };

    for (const yaml of [CONFIG(variants + solo), CONFIG(solo + variants)]) {
      const env = envOf(render(yaml, seeded), "bundle");
      expect(env.TELEGRAM_API_HASH).toBe("fake-shared-hash");
      expect(env.GMAIL_PERSONAL__TELEGRAM_API_HASH).toBe("fake-readwrite-hash");
    }
  });
});

describe("what per-slug names deliberately do NOT touch", () => {
  it("leaves a `params: true` server's variables under the names the store gave them", () => {
    // A managed parameter's NAME comes from its path in the store, not from the
    // config, so there is no `env:` entry to prefix and nothing here that could
    // be made unique by prefixing. Left alone, deliberately.
    const spec = renderAppSpec({
      config: parseConfig(
        CONFIG(`  - slug: telegram-ro
    kind: supplementary-image
    params: true
    image: ghcr.io/tadasant/strad-bundle:0.1.0
    bundle: bundle
    path: /telegram
    entitlements: [admin]
`),
      ),
      appName: "strad-test",
      region: "nyc",
      image: IMAGE,
      env: [],
      resolvedParams: { "telegram-ro": { TELEGRAM_API_HASH: "fake-hash" } },
    });
    expect(envOf(spec, "bundle").TELEGRAM_API_HASH).toBe("fake-hash");
    expect(aliasKeys(spec, "bundle")).toEqual([]);
  });

  it("leaves the broadcast env and core's own variables alone", () => {
    const spec = renderAppSpec({
      config: parseConfig(
        CONFIG(
          TELEGRAM("telegram-ro", "/telegram-ro") +
            TELEGRAM("telegram-rw", "/telegram-rw"),
        ),
      ),
      appName: "strad-test",
      region: "nyc",
      image: IMAGE,
      env: [
        { key: "STRAD_TOKENS", value: "t", scope: "RUN_TIME", type: "SECRET" },
      ],
      secrets: SHARED,
      serverSecrets: { "telegram-rw": RW },
    });
    for (const component of ["core", "bundle"]) {
      const env = envOf(spec, component);
      expect(env.STRAD_TOKENS).toBe("t");
      expect(env.TELEGRAM_RW__STRAD_TOKENS).toBeUndefined();
    }
  });
});

/**
 * THE TWO HALVES, COMPOSED.
 *
 * The renderer NAMES variables; the bundle host DISCOVERS a slug from the names
 * it finds and mounts an instance for it. Each half was tested and the pair was
 * not, and the gap between them was a real bug: two Telegram accounts normally
 * share one Telegram application, so `TELEGRAM_API_ID` and `TELEGRAM_API_HASH`
 * are identical and only the session string differs. Emitting only the name that
 * DIFFERS left the host looking at two of three markers, discovering nothing, and
 * mounting nothing at the path the renderer had just made mandatory — a slug that
 * is configured, entitled, routed, and 404.
 *
 * So this asserts the property that actually matters: render a real two-account
 * config, hand the resulting environment to the host's own discovery function,
 * and get the dissenting slug back.
 */
describe("the renderer's output and the bundle host's discovery", () => {
  /** Telegram's three credential variables, as its config.ts declares them. */
  const TELEGRAM_ENV = `    env:
      TELEGRAM_API_ID: "\${TELEGRAM_API_ID}"
      TELEGRAM_API_HASH: "\${TELEGRAM_API_HASH}"
      TELEGRAM_STRING_SESSION: "\${TELEGRAM_STRING_SESSION}"
`;
  const server = (slug: string, path: string) =>
    `  - slug: ${slug}
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:0.1.0
    bundle: bundle
    path: ${path}
    entitlements: [admin]
` + TELEGRAM_ENV;

  const MARKERS = [
    "TELEGRAM_API_ID",
    "TELEGRAM_API_HASH",
    "TELEGRAM_STRING_SESSION",
  ];

  it("agrees: a dissenter that shares an app id is still discovered", () => {
    const spec = render(
      CONFIG(
        server("telegram", "/telegram") + server("telegram-rw", "/telegram-rw"),
      ),
      {
        secrets: {
          TELEGRAM_API_ID: "1111111",
          TELEGRAM_API_HASH: "fake-shared-hash",
          TELEGRAM_STRING_SESSION: "fake-session-one",
        },
        // ONLY the session differs — the app id and hash are the same
        // application, which is the normal shape of two accounts.
        serverSecrets: {
          "telegram-rw": { TELEGRAM_STRING_SESSION: "fake-session-two" },
        },
      },
    );
    const env = envOf(spec, "bundle");

    // The dissenter gets its WHOLE env, including the two names it agrees about.
    expect(env.TELEGRAM_RW__TELEGRAM_STRING_SESSION).toBe("fake-session-two");
    expect(env.TELEGRAM_RW__TELEGRAM_API_ID).toBe("1111111");
    expect(env.TELEGRAM_RW__TELEGRAM_API_HASH).toBe("fake-shared-hash");
    // The conventional mount is untouched.
    expect(env.TELEGRAM_STRING_SESSION).toBe("fake-session-one");

    // The incumbent gets a complete set too — a bundle either uses per-slug
    // names for every mount of its own or for none, so that `/telegram` and
    // `/telegram-rw` cannot end up one mounted and one not.
    expect(env.TELEGRAM__TELEGRAM_STRING_SESSION).toBe("fake-session-one");

    // And the host — given exactly this environment — finds both, and mounts
    // `telegram-rw` at /telegram-rw. `telegram` is its conventional slug, so the
    // host's `extraSlugs` filters it out and mounts it once, as it always did.
    expect(slugsWithPrefixedNames(env, MARKERS)).toEqual([
      "telegram",
      "telegram-rw",
    ]);
  });

  it("agrees the other way: no dissent means nothing to discover", () => {
    const spec = render(
      CONFIG(
        server("telegram-ro", "/telegram") + server("telegram-rw", "/telegram"),
      ),
      {
        secrets: {
          TELEGRAM_API_ID: "1111111",
          TELEGRAM_API_HASH: "fake-shared-hash",
          TELEGRAM_STRING_SESSION: "fake-session-one",
        },
      },
    );
    expect(slugsWithPrefixedNames(envOf(spec, "bundle"), MARKERS)).toEqual([]);
  });
});
