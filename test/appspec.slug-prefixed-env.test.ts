import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config/load.ts";
import { parseImage, renderAppSpec } from "../src/deploy/appspec.ts";
import { slugsWithPrefixedNames } from "../src/secrets/env-prefix.ts";

/**
 * PER-SLUG BOX NAMES, at the renderer.
 *
 * src/deploy/server-namespaces.ts decides which NAMESPACE a supplementary
 * server's `${NAME}` resolves from. This decides what the resolved value is
 * CALLED once it lands on the container — because a bundle is one container with
 * one `process.env`, and two servers that both want `TELEGRAM_API_HASH` need two
 * names, not two namespaces.
 *
 * THE RULE IS FLAT: every enabled supplementary server's `env:` is emitted twice,
 * under the bare name and under `<SLUG>__<NAME>`, with no condition attached.
 * Given a config you can compute the whole set by hand, per server, without
 * looking at any other server. An earlier version minted the second name only
 * where two values disagreed, which was correct and unreadable — what a variable
 * was called depended on what some other slug had been seeded.
 *
 * What is still conditional is READING, and it is checkable by eye: the bundle
 * host serves one instance per path, so only a slug that is the only one on
 * `path: /<its own slug>` can be handed its own names.
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

const perSlugKeys = (
  spec: ReturnType<typeof renderAppSpec>,
  component: string,
) =>
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

describe("every supplementary server is named, with no condition attached", () => {
  it("emits the bare name and the per-slug name for a server nobody seeded", () => {
    // The point of the whole change: no trigger, nothing to reason about. This
    // config has one server, one shared value and no per-server namespace at
    // all, and the per-slug name is there anyway.
    const warnings: string[] = [];
    const spec = render(CONFIG(TELEGRAM("telegram-ro", "/telegram")), {
      warnings,
    });
    const env = envOf(spec, "bundle");

    expect(env.TELEGRAM_API_HASH).toBe("fake-shared-hash");
    expect(env.TELEGRAM_RO__TELEGRAM_API_HASH).toBe("fake-shared-hash");
    expect(warnings).toEqual([]);
  });

  it("names capability variants too, even though they read the bare name", () => {
    // gmail-ro / gmail-rw / gmail-rw-external share `/gmail`, so they are one
    // instance in the container and read the bare name. They are still NAMED —
    // "what is this server's variable called" has one answer for every server.
    const spec = render(
      CONFIG(
        TELEGRAM("gmail-ro", "/gmail") +
          TELEGRAM("gmail-rw", "/gmail") +
          TELEGRAM("gmail-rw-external", "/gmail"),
      ),
    );
    expect(perSlugKeys(spec, "bundle")).toEqual([
      "GMAIL_RO__TELEGRAM_API_HASH",
      "GMAIL_RW_EXTERNAL__TELEGRAM_API_HASH",
      "GMAIL_RW__TELEGRAM_API_HASH",
    ]);
    expect(envOf(spec, "bundle").TELEGRAM_API_HASH).toBe("fake-shared-hash");
  });

  it("is the same set whether or not a per-server namespace was seeded", () => {
    // The property Tadas asked for, stated as a test: seeding changes VALUES,
    // never which names exist.
    const yaml = CONFIG(TELEGRAM("telegram-ro", "/telegram-ro"));
    expect(perSlugKeys(render(yaml), "bundle")).toEqual(
      perSlugKeys(
        render(yaml, { serverSecrets: { "telegram-ro": RO } }),
        "bundle",
      ),
    );
    expect(
      envOf(render(yaml, { serverSecrets: { "telegram-ro": RO } }), "bundle")
        .TELEGRAM_RO__TELEGRAM_API_HASH,
    ).toBe("fake-readonly-hash");
  });

  it("emits per-slug names as SECRETs, and keeps them off core", () => {
    const spec = render(CONFIG(TELEGRAM("telegram-ro", "/telegram")));
    const alias = spec.services
      .find((s) => s.name === "bundle")!
      .envs.find((e) => e.key === "TELEGRAM_RO__TELEGRAM_API_HASH")!;
    expect(alias.type).toBe("SECRET");
    expect(alias.scope).toBe("RUN_TIME");
    expect(perSlugKeys(spec, "core")).toEqual([]);
    expect(envOf(spec, "core").TELEGRAM_API_HASH).toBeUndefined();
  });

  it("names nothing for a disabled server", () => {
    // `enabled: false` is skipped wholesale, exactly as it was.
    const spec = render(
      CONFIG(
        TELEGRAM("telegram-ro", "/telegram") +
          `  - slug: telegram-rw
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:0.1.0
    bundle: bundle
    path: /telegram
    enabled: false
    entitlements: [admin]
    env:
      TELEGRAM_API_HASH: "\${TELEGRAM_API_HASH}"
`,
      ),
    );
    expect(perSlugKeys(spec, "bundle")).toEqual([
      "TELEGRAM_RO__TELEGRAM_API_HASH",
    ]);
  });
});

describe("two slugs of one tree, two credentials, one container", () => {
  const TWO_PATHS =
    TELEGRAM("telegram-ro", "/telegram-ro") +
    TELEGRAM("telegram-rw", "/telegram-rw");
  const SEEDED = { "telegram-ro": RO, "telegram-rw": RW };

  it("gives each its own value under its own name", () => {
    // The capability this exists for. Before it, the same configuration was a
    // hard error and the only answer was a second billed component.
    const spec = render(CONFIG(TWO_PATHS), { serverSecrets: SEEDED });
    const env = envOf(spec, "bundle");

    expect(env.TELEGRAM_RO__TELEGRAM_API_HASH).toBe("fake-readonly-hash");
    expect(env.TELEGRAM_RW__TELEGRAM_API_HASH).toBe("fake-readwrite-hash");
    // One bundle. The whole point is that this does NOT need a second container.
    expect(spec.services.map((s) => s.name).sort()).toEqual(["bundle", "core"]);
  });

  it("never removes or repoints a bare name", () => {
    // What makes an added slug safe for the slugs already there: every bare name
    // in the unseeded render survives, with its value, into the seeded one.
    const before = envOf(render(CONFIG(TWO_PATHS)), "bundle");
    const after = envOf(
      render(CONFIG(TWO_PATHS), { serverSecrets: { "telegram-rw": RW } }),
      "bundle",
    );
    for (const [key, value] of Object.entries(before)) {
      if (key.includes("__")) continue;
      expect(after[key]).toBe(value);
    }
  });

  it("does not let one server's own value cost another one its variable", () => {
    // gmail-ro / gmail-rw / gmail-rw-external share a path and a value; a fourth
    // slug on its own path is seeded a different one. The three that share keep
    // the bare name their (unmigrated) tree reads, in either declaration order.
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
      expect(env.GMAIL_RO__TELEGRAM_API_HASH).toBe("fake-shared-hash");
    }
  });
});

describe("what the renderer refuses", () => {
  it("refuses two values on slugs that share a path", () => {
    // One path is one instance holding one credential. Nothing to do with
    // naming — a second value has nowhere to go there whatever it is called.
    const thrown = throwsWith(() =>
      render(
        CONFIG(
          TELEGRAM("telegram-ro", "/telegram") +
            TELEGRAM("telegram-rw", "/telegram"),
        ),
        { serverSecrets: { "telegram-ro": RO, "telegram-rw": RW } },
      ),
    );
    expect(thrown).toMatch(/ONE mount/);
    expect(thrown).toMatch(/path: \/<its-own-slug>/);
    expect(thrown).not.toContain("fake-readonly-hash");
    expect(thrown).not.toContain("fake-readwrite-hash");
  });

  it("refuses two servers that need different values and neither can have an instance", () => {
    // `telegram-ro` shares the conventional `/telegram`; `telegram-rw` sits on a
    // path that is not its slug. Both read the bare name, and the bare name holds
    // one value.
    const thrown = throwsWith(() =>
      render(
        CONFIG(
          TELEGRAM("telegram-ro", "/telegram") +
            TELEGRAM("telegram-rw", "/telegram-elsewhere"),
        ),
        { serverSecrets: { "telegram-rw": RW } },
      ),
    );
    expect(thrown).toMatch(/neither can be given an instance of its own/);
    expect(thrown).toMatch(/path: \/<its-own-slug>/);
    expect(thrown).not.toContain("fake-readwrite-hash");
  });

  it("catches a same-path pair whatever order the config declares it in", () => {
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
});

describe("the one shape that cannot be named", () => {
  const DIGIT = TELEGRAM("1telegram", "/1telegram");

  it("says so by name, and leaves the server on its bare names", () => {
    // A slug starting with a digit mangles to `1TELEGRAM`, which is not a
    // portable variable name. This is the ONLY server that gets no per-slug
    // name, it is decidable from the slug alone, and it is said out loud.
    const warnings: string[] = [];
    const spec = render(CONFIG(TELEGRAM("telegram-ro", "/telegram") + DIGIT), {
      warnings,
    });
    const env = envOf(spec, "bundle");

    expect(env.TELEGRAM_API_HASH).toBe("fake-shared-hash");
    expect(perSlugKeys(spec, "bundle")).toEqual([
      "TELEGRAM_RO__TELEGRAM_API_HASH",
    ]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/1telegram/);
    expect(warnings[0]).toMatch(/cannot start with a digit/);
    expect(warnings[0]).not.toContain("fake-shared-hash");
  });

  it("still refuses to give it a value of its own", () => {
    const thrown = throwsWith(() =>
      render(CONFIG(TELEGRAM("telegram-ro", "/telegram") + DIGIT), {
        serverSecrets: { "1telegram": RW },
      }),
    );
    expect(thrown).toMatch(/neither can be given an instance of its own/);
    expect(thrown).toMatch(/1telegram/);
  });
});

describe("what per-slug names deliberately do NOT touch", () => {
  it("leaves a `params: true` server's variables under the names the store gave them", () => {
    // A managed parameter's NAME comes from its path in the store, not from
    // `env:`. There is no `env:` entry to name, so there is nothing here to
    // prefix — the mechanical reason, checkable from the config.
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
    expect(perSlugKeys(spec, "bundle")).toEqual([]);
  });

  it("leaves the broadcast env and core's own variables alone", () => {
    const spec = renderAppSpec({
      config: parseConfig(CONFIG(TELEGRAM("telegram-ro", "/telegram"))),
      appName: "strad-test",
      region: "nyc",
      image: IMAGE,
      env: [
        { key: "GRANOLA_TOKEN", value: "g", scope: "RUN_TIME", type: "SECRET" },
        { key: "STRAD_TOKENS", value: "t", scope: "RUN_TIME", type: "SECRET" },
      ],
      secrets: SHARED,
    });
    for (const component of ["core", "bundle"]) {
      const env = envOf(spec, component);
      expect(env.GRANOLA_TOKEN).toBe("g");
      expect(env.TELEGRAM_RO__GRANOLA_TOKEN).toBeUndefined();
      expect(env.TELEGRAM_RO__STRAD_TOKENS).toBeUndefined();
    }
    // The token store is core's own boot key, so it stops there rather than
    // riding the broadcast into a third-party image (CORE_ONLY_BOOT_ENV_KEYS).
    expect(envOf(spec, "core").STRAD_TOKENS).toBe("t");
    expect(envOf(spec, "bundle").STRAD_TOKENS).toBeUndefined();
  });
});

/**
 * THE TWO HALVES, COMPOSED.
 *
 * The renderer NAMES variables; the bundle host DISCOVERS a slug from the names
 * it finds and mounts an instance for it. Each half was tested and the pair was
 * not, and the gap between them was a real bug — the renderer emitted only the
 * names a server disagreed about, while the host needs a COMPLETE set of a tree's
 * required variables, so a slug could be configured, entitled, routed and 404.
 * Unconditional emission removes the gap by construction; this is what proves it.
 */
describe("the renderer's output and the bundle host's discovery", () => {
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
  const APP = {
    TELEGRAM_API_ID: "1111111",
    TELEGRAM_API_HASH: "fake-shared-hash",
    TELEGRAM_STRING_SESSION: "fake-session-one",
  };

  it("a slug that shares an app id is still discovered, because every name is emitted", () => {
    // Two Telegram accounts normally share one Telegram APPLICATION, so the id
    // and hash are identical and only the session string differs. Emitting only
    // what differs left the host finding two of three markers.
    const spec = render(
      CONFIG(
        server("telegram", "/telegram") + server("telegram-rw", "/telegram-rw"),
      ),
      {
        secrets: APP,
        serverSecrets: {
          "telegram-rw": { TELEGRAM_STRING_SESSION: "fake-session-two" },
        },
      },
    );
    const env = envOf(spec, "bundle");

    expect(env.TELEGRAM_RW__TELEGRAM_STRING_SESSION).toBe("fake-session-two");
    expect(env.TELEGRAM_RW__TELEGRAM_API_ID).toBe("1111111");
    expect(env.TELEGRAM_RW__TELEGRAM_API_HASH).toBe("fake-shared-hash");
    expect(env.TELEGRAM_STRING_SESSION).toBe("fake-session-one");

    // The host, given exactly this environment, finds both and mounts
    // `telegram-rw` at /telegram-rw. `telegram` is the conventional slug, which
    // `extraSlugs` filters out so it is mounted once, as always.
    expect(slugsWithPrefixedNames(env, MARKERS)).toEqual([
      "telegram",
      "telegram-rw",
    ]);
  });

  it("finds nothing for a slug that is not a mount of its own", () => {
    // Two slugs on the conventional path are one instance. They are named, but
    // the host mounts `/telegram` once and neither slug adds a mount.
    const spec = render(
      CONFIG(
        server("telegram-ro", "/telegram") + server("telegram-rw", "/telegram"),
      ),
      { secrets: APP },
    );
    const discovered = slugsWithPrefixedNames(envOf(spec, "bundle"), MARKERS);
    expect(discovered).toEqual(["telegram-ro", "telegram-rw"]);
    // Neither is the conventional `telegram` slug, so the host would try to mount
    // both — which is exactly why `extraSlugs` exists and why the paths in the
    // config are what decide routing. Nothing routes to them: the gateway sends
    // both slugs to `/telegram`.
    expect(discovered).not.toContain("telegram");
  });
});
