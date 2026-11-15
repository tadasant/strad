import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config/load.ts";
import {
  foldEnvCopies,
  parseImage,
  renderAppSpec,
  type EnvVar,
} from "../src/deploy/appspec.ts";
import {
  applyEnvCopies,
  ENV_COPIES_VAR,
  formatEnvCopies,
  parseEnvCopies,
} from "../src/secrets/env-prefix.ts";

/**
 * STRAD_ENV_COPIES: each per-slug value baked once, restored at boot.
 *
 * The property everything here defends is that the container's environment
 * (the spec, with the copies applied the way the bundle host applies them) is
 * the environment an unfolded render would have produced, name for name and
 * value for value. Every value is an obviously-fake placeholder.
 */

const v = (key: string, value: string): EnvVar => ({
  key,
  value,
  scope: "RUN_TIME",
  type: "SECRET",
});
const asEnv = (envs: EnvVar[]) =>
  Object.fromEntries(envs.map((e) => [e.key, e.value])) as Record<
    string,
    string | undefined
  >;
const restored = (envs: EnvVar[]) => {
  const env = asEnv(envs);
  applyEnvCopies(env);
  return env;
};

describe("the copy list's wire", () => {
  it("abbreviates PREFIX__SOURCE to PREFIX__ and reads it back", () => {
    const text = formatEnvCopies([
      ["TOKEN", ["A__TOKEN", "B_C__TOKEN", "OTHER_NAME"]],
      ["X", ["P__X"]],
    ]);
    expect(text).toBe("TOKEN=A__,B_C__,OTHER_NAME;X=P__");
    expect(parseEnvCopies(text)).toEqual([
      ["TOKEN", ["A__TOKEN", "B_C__TOKEN", "OTHER_NAME"]],
      ["X", ["P__X"]],
    ]);
  });

  it("does not abbreviate a target that IS `__SOURCE` with nothing before it", () => {
    const text = formatEnvCopies([["X", ["__X"]]]);
    expect(parseEnvCopies(text)).toEqual([["X", ["__X"]]]);
  });

  it("refuses a name it could not read back", () => {
    for (const bad of ["A__", "1A", "A-B", "A,B", ENV_COPIES_VAR]) {
      expect(() => formatEnvCopies([["SRC", [bad]]])).toThrow(ENV_COPIES_VAR);
    }
    expect(() => formatEnvCopies([["SRC__", ["T"]]])).toThrow();
  });

  it("refuses a malformed list rather than guessing", () => {
    for (const bad of ["A", "=B", "A=", "A=B,,C", "A=B;", "A=B C"]) {
      expect(() => parseEnvCopies(bad), bad).toThrow(ENV_COPIES_VAR);
    }
  });
});

describe("applyEnvCopies", () => {
  it("sets each target from its source and removes the list", () => {
    const env: Record<string, string | undefined> = {
      TOKEN: "fake-token",
      [ENV_COPIES_VAR]: "TOKEN=A__,B__",
    };
    expect(applyEnvCopies(env)).toEqual({
      copied: 2,
      missingSources: [],
      alreadySet: [],
    });
    expect(env).toEqual({
      TOKEN: "fake-token",
      A__TOKEN: "fake-token",
      B__TOKEN: "fake-token",
    });
  });

  it("is a no-op on an environment that carries no list", () => {
    const env = { TOKEN: "fake-token" };
    expect(applyEnvCopies(env).copied).toBe(0);
    expect(env).toEqual({ TOKEN: "fake-token" });
  });

  it("never overwrites, and reports a missing source instead of inventing a value", () => {
    const env: Record<string, string | undefined> = {
      TOKEN: "fake-token",
      A__TOKEN: "fake-literal",
      [ENV_COPIES_VAR]: "TOKEN=A__;GONE=B__",
    };
    const result = applyEnvCopies(env);
    expect(result).toEqual({
      copied: 0,
      missingSources: ["GONE"],
      alreadySet: ["A__TOKEN"],
    });
    expect(env.A__TOKEN).toBe("fake-literal");
    expect("B__GONE" in env).toBe(false);
  });
});

describe("foldEnvCopies", () => {
  it("folds a per-slug name onto the bare name holding its value", () => {
    const envs = [
      v("TOKEN", "fake-shared"),
      v("A__TOKEN", "fake-shared"),
      v("B__TOKEN", "fake-own"),
    ];
    const folded = foldEnvCopies(envs, new Set(["A__TOKEN", "B__TOKEN"]));
    expect(folded.map((e) => e.key)).toEqual([
      "TOKEN",
      "B__TOKEN",
      ENV_COPIES_VAR,
    ]);
    expect(folded.at(-1)).toEqual({
      key: ENV_COPIES_VAR,
      value: "TOKEN=A__",
      scope: "RUN_TIME",
      type: "GENERAL",
    });
    expect(restored(folded)).toEqual(asEnv(envs));
  });

  it("bakes a value no bare name holds once, and copies it to every other slug", () => {
    // Twelve slugs on one OAuth client: the id travels once.
    const slugs = ["A", "B", "C"].map((p) => `${p}__CLIENT_ID`);
    const envs = slugs.map((k) => v(k, "fake-client-id"));
    const folded = foldEnvCopies(envs, new Set(slugs));
    expect(folded.map((e) => e.key)).toEqual(["A__CLIENT_ID", ENV_COPIES_VAR]);
    expect(folded.at(-1)!.value).toBe("A__CLIENT_ID=B__CLIENT_ID,C__CLIENT_ID");
    expect(restored(folded)).toEqual(asEnv(envs));
  });

  it("leaves alone what it must not fold", () => {
    const envs = [
      v("TOKEN", "fake"),
      v("STRAD_TAILNET_AUTHKEY", "fake-tail"),
      v("A__TAIL", "fake-tail"), // a tailnet key is never a source
      v("A__EMPTY", ""), // never an empty value
      v("EMPTY", ""),
      v("A__WEIRD__", "fake"), // reserved by the abbreviation
      v("B__DUP", "fake"), // a name that appears twice
      v("B__DUP", "fake"),
      v("NOT_PER_SLUG", "fake"), // only per-slug names fold
    ];
    const folded = foldEnvCopies(
      envs,
      new Set(["A__TAIL", "A__EMPTY", "A__WEIRD__", "B__DUP"]),
    );
    expect(folded).toEqual(envs);
  });

  it("refuses a server that sets the list's own name", () => {
    expect(() =>
      foldEnvCopies(
        [v(ENV_COPIES_VAR, "x"), v("A__X", "y")],
        new Set(["A__X"]),
      ),
    ).toThrow(/reserved for the renderer/);
  });
});

describe("the renderer", () => {
  const CONFIG = (image: string) => `
version: 1
gateway: { name: strad, env: test }
auth:
  staticTokens: { enabled: true, store: env }
roles:
  admin: { servers: ["*"] }
bundles:
  - name: bundle
servers:
  - slug: telegram-ro
    kind: supplementary-image
    image: ${image}
    bundle: bundle
    path: /telegram-ro
    entitlements: [admin]
    env:
      TELEGRAM_API_HASH: "\${TELEGRAM_API_HASH}"
      TELEGRAM_API_ID: "\${TELEGRAM_API_ID}"
  - slug: telegram-rw
    kind: supplementary-image
    image: ${image}
    bundle: bundle
    path: /telegram-rw
    entitlements: [admin]
    env:
      TELEGRAM_API_HASH: "\${TELEGRAM_API_HASH}"
      TELEGRAM_API_ID: "\${TELEGRAM_API_ID}"
`;
  const render = (image: string) =>
    renderAppSpec({
      config: parseConfig(CONFIG(image)),
      appName: "strad-test",
      region: "nyc",
      image: parseImage("ghcr.io/tadasant/strad:0.1.0"),
      env: [],
      secrets: { TELEGRAM_API_HASH: "fake-hash", TELEGRAM_API_ID: "fake-id" },
      serverSecrets: { "telegram-rw": { TELEGRAM_API_HASH: "fake-rw-hash" } },
    }).services.find((s) => s.name === "bundle")!.envs;

  it("folds on a strad-bundle component, and the restored environment is the full one", () => {
    const envs = render("ghcr.io/tadasant/strad-bundle:0.1.0");
    const keys = envs.map((e) => e.key);
    // Baked literally: the bare names, and the one per-slug value of its own.
    expect(keys).toContain("TELEGRAM_API_HASH");
    expect(keys).toContain("TELEGRAM_RW__TELEGRAM_API_HASH");
    // Folded: everything that repeats a value already on the component.
    expect(keys).not.toContain("TELEGRAM_RO__TELEGRAM_API_HASH");
    expect(keys).not.toContain("TELEGRAM_RO__TELEGRAM_API_ID");
    expect(keys).not.toContain("TELEGRAM_RW__TELEGRAM_API_ID");

    const env = restored(envs);
    expect(env).toMatchObject({
      TELEGRAM_API_HASH: "fake-hash",
      TELEGRAM_API_ID: "fake-id",
      TELEGRAM_RO__TELEGRAM_API_HASH: "fake-hash",
      TELEGRAM_RO__TELEGRAM_API_ID: "fake-id",
      TELEGRAM_RW__TELEGRAM_API_HASH: "fake-rw-hash",
      TELEGRAM_RW__TELEGRAM_API_ID: "fake-id",
    });
    expect(env[ENV_COPIES_VAR]).toBeUndefined();
  });

  it("restores exactly what a non-folding image is handed literally", () => {
    // The same config on an image the renderer does not fold for is the
    // unfolded render. Same names, same values, apart from the image tag.
    const folded = restored(render("ghcr.io/tadasant/strad-bundle:0.1.0"));
    const literal = asEnv(render("ghcr.io/example/other-bundle:0.1.0"));
    expect(literal[ENV_COPIES_VAR]).toBeUndefined();
    delete folded.STRAD_VERSION;
    delete literal.STRAD_VERSION;
    // NODE_OPTIONS is the strad-bundle heap ceiling, not part of this.
    delete folded.NODE_OPTIONS;
    expect(folded).toEqual(literal);
  });
});
