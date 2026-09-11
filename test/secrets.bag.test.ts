import { afterEach, describe, expect, it } from "vitest";
import { loadSecrets, resolveMap } from "../src/secrets/index.ts";

/**
 * The boot-time secret bag (`src/secrets/index.ts`).
 *
 * `loadSecrets` runs at every boot, and a wrong bag fails quietly: a key that
 * goes missing surfaces much later as an unresolved `consoleEnv:` reference, or
 * not at all. So the bag's contents are asserted exactly — every string-valued
 * entry of the environment in, the same entries out, nothing added and nothing
 * dropped.
 */

const PROBE = "STRAD_TEST_SECRET_BAG_PROBE";

describe("loadSecrets", () => {
  afterEach(() => {
    delete process.env[PROBE];
  });

  it("is exactly the string-valued entries of the env it is given", () => {
    const env: NodeJS.ProcessEnv = {
      TOK: "abc",
      EMPTY: "",
      MULTILINE: "-----BEGIN KEY-----\nabc\n-----END KEY-----\n",
      JSON_BLOB: '{"a":"b"}',
      UNSET: undefined,
    };
    expect(loadSecrets(env)).toStrictEqual({
      TOK: "abc",
      EMPTY: "",
      MULTILINE: "-----BEGIN KEY-----\nabc\n-----END KEY-----\n",
      JSON_BLOB: '{"a":"b"}',
    });
  });

  it("reads process.env when given nothing, as boot calls it", () => {
    process.env[PROBE] = "probe-value";
    const expected = Object.fromEntries(
      Object.entries(process.env).filter(([, v]) => typeof v === "string"),
    );
    const bag = loadSecrets();
    expect(bag[PROBE]).toBe("probe-value");
    expect(bag).toStrictEqual(expected);
  });

  it("is a frozen snapshot, not a view of the env", () => {
    const env: NodeJS.ProcessEnv = { TOK: "abc" };
    const bag = loadSecrets(env);
    expect(Object.isFrozen(bag)).toBe(true);

    env.TOK = "rotated";
    env.LATE = "late";
    expect(bag).toStrictEqual({ TOK: "abc" });
  });

  it("returns an empty bag for an empty env", () => {
    expect(loadSecrets({})).toStrictEqual({});
  });
});

describe("resolveMap", () => {
  it("substitutes every ${NAME} in every value", () => {
    expect(
      resolveMap(
        { Authorization: "Bearer ${TOK}", Basic: "${USER}:${TOK}", Plain: "x" },
        { TOK: "abc", USER: "u" },
      ),
    ).toStrictEqual({
      Authorization: "Bearer abc",
      Basic: "u:abc",
      Plain: "x",
    });
  });

  it("substitutes an empty value rather than treating it as missing", () => {
    expect(resolveMap({ h: "[${EMPTY}]" }, { EMPTY: "" })).toStrictEqual({
      h: "[]",
    });
  });

  it("throws rather than shipping the literal placeholder as a credential", () => {
    expect(() => resolveMap({ h: "Bearer ${MISSING}" }, {})).toThrow(
      /unresolved secret reference \$\{MISSING\}/,
    );
  });

  it("resolves against a bag loadSecrets built", () => {
    expect(
      resolveMap({ h: "Bearer ${TOK}" }, loadSecrets({ TOK: "abc" })),
    ).toStrictEqual({ h: "Bearer abc" });
  });
});
