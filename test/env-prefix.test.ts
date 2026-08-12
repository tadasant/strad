import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config/load.ts";
import {
  envPrefixSlug,
  prefixedEnvName,
  slugEnvPrefix,
  slugEnvView,
  slugsWithPrefixedNames,
  SLUG_ENV_SEPARATOR,
} from "../src/secrets/env-prefix.ts";

/**
 * The rule that decides what a supplementary server's variable is CALLED on the
 * container — and, one file over in a different npm tree, how it is read back.
 *
 * The failure this guards is not a crash. A mangling the renderer and the host
 * disagree about produces a container that holds the credential under a name
 * nothing looks for: green deploy, clean boot log, every tool call failing on a
 * variable that is right there.
 */

describe("the box name of a slug's variable", () => {
  it("uppercases, turns dashes into underscores, and joins with two of them", () => {
    expect(slugEnvPrefix("telegram-ro")).toBe("TELEGRAM_RO");
    expect(prefixedEnvName("telegram-ro", "TELEGRAM_API_HASH")).toBe(
      "TELEGRAM_RO__TELEGRAM_API_HASH",
    );
    expect(SLUG_ENV_SEPARATOR).toBe("__");
  });

  it("round-trips a prefix back to the slug it came from", () => {
    for (const slug of [
      "telegram",
      "telegram-ro",
      "remote-filesystem-tmp-public",
      "monarch-money-readwrite",
      "gcs",
    ]) {
      expect(envPrefixSlug(slugEnvPrefix(slug)!)).toBe(slug);
    }
  });

  it("keeps a slug that is a PREFIX of another one distinct", () => {
    // The case that looks like a collision and is not: `telegram` reaching for a
    // variable literally called RO__X lands one underscore away from
    // `telegram-ro` reaching for X.
    expect(prefixedEnvName("telegram", "RO__X")).toBe("TELEGRAM__RO__X");
    expect(prefixedEnvName("telegram-ro", "X")).toBe("TELEGRAM_RO__X");
    expect(prefixedEnvName("telegram", "RO__X")).not.toBe(
      prefixedEnvName("telegram-ro", "X"),
    );
  });

  it("refuses to name a variable for a slug that would make one ambiguous", () => {
    // `a--b` + C and `a` + B__C are the same string once mangled. The schema
    // rejects the slug outright (below); this is the half of the guard that
    // travels with the rule.
    expect(slugEnvPrefix("a--b")).toBeNull();
    expect(prefixedEnvName("a--b", "C")).toBeNull();
    // A leading digit mangles to something POSIX will not accept as a variable
    // name. No alias, rather than an unusable one — the slug keeps working on
    // its bare names.
    expect(slugEnvPrefix("1password")).toBeNull();
  });
});

describe("the environment as one slug sees it", () => {
  const ENV = {
    TELEGRAM_API_HASH: "shared-hash",
    TELEGRAM_RO__TELEGRAM_API_HASH: "readonly-hash",
    TELEGRAM_API_ID: "shared-id",
  };

  it("prefers the per-slug name", () => {
    expect(slugEnvView(ENV, "telegram-ro").TELEGRAM_API_HASH).toBe(
      "readonly-hash",
    );
  });

  it("falls back to the bare name — which is every server that predates this", () => {
    // telegram-rw was given nothing of its own, so it reads exactly what it read
    // before per-slug names existed. This is the entire backward-compatibility
    // argument, and why this lands with no flag.
    expect(slugEnvView(ENV, "telegram-rw").TELEGRAM_API_HASH).toBe(
      "shared-hash",
    );
    // And a name nobody scoped is the bare one for everybody.
    expect(slugEnvView(ENV, "telegram-ro").TELEGRAM_API_ID).toBe("shared-id");
  });

  it("gives two slugs two independent views of one environment", () => {
    const ro = slugEnvView(ENV, "telegram-ro");
    const rw = slugEnvView(ENV, "telegram-rw");
    expect(ro.TELEGRAM_API_HASH).not.toBe(rw.TELEGRAM_API_HASH);
    // Neither view mutates the environment it was built from.
    expect(ENV.TELEGRAM_API_HASH).toBe("shared-hash");
  });

  it("leaves the prefixed key visible too, so nothing depends on it being consumed", () => {
    expect(slugEnvView(ENV, "telegram-ro").TELEGRAM_RO__TELEGRAM_API_HASH).toBe(
      "readonly-hash",
    );
  });

  it("ignores a key that is all prefix and no name", () => {
    const view = slugEnvView({ TELEGRAM_RO__: "x" }, "telegram-ro");
    expect(view[""]).toBeUndefined();
  });
});

describe("discovering which slugs the environment carries values for", () => {
  const NAMES = ["TELEGRAM_API_ID", "TELEGRAM_API_HASH"];

  it("finds a slug that holds EVERY name", () => {
    expect(
      slugsWithPrefixedNames(
        {
          TELEGRAM_RO__TELEGRAM_API_ID: "a",
          TELEGRAM_RO__TELEGRAM_API_HASH: "b",
          TELEGRAM_RW__TELEGRAM_API_ID: "c",
          TELEGRAM_RW__TELEGRAM_API_HASH: "d",
          TELEGRAM_API_ID: "e",
        },
        NAMES,
      ),
    ).toEqual(["telegram-ro", "telegram-rw"]);
  });

  it("does NOT mount a slug that holds only some of them", () => {
    // "any one name" was the first rule and it is too loose: the marker names
    // are a tree's ordinary variables, not reserved words, so ANY slug on the
    // bundle that happened to be given `SOMESLUG__TELEGRAM_API_ID` would stand
    // up a live, credentialed telegram instance at a path nobody asked for. A
    // partial set is not a server.
    expect(
      slugsWithPrefixedNames({ GCS__TELEGRAM_API_ID: "a" }, NAMES),
    ).toEqual([]);
    expect(
      slugsWithPrefixedNames({ FOO__TELEGRAM_API_HASH: "a" }, NAMES),
    ).toEqual([]);
  });

  it("finds nothing in an environment that only holds bare names", () => {
    // Which is every deployment today: the host adds no mounts and boots as it did.
    expect(
      slugsWithPrefixedNames(
        { TELEGRAM_API_ID: "a", TELEGRAM_API_HASH: "b" },
        NAMES,
      ),
    ).toEqual([]);
  });

  it("does not conjure a slug out of a variable that merely contains the separator", () => {
    // `FOO__BAR` un-mangles to `foo--bar`, which is not a legal slug and does not
    // round-trip — so it is rejected rather than mounted.
    expect(
      slugsWithPrefixedNames({ FOO__BAR__TELEGRAM_API_ID: "a" }, NAMES),
    ).toEqual([]);
  });
});

describe("the slug schema", () => {
  const yaml = (slug: string) => `
version: 1
gateway: { name: strad, env: test }
auth:
  staticTokens: { enabled: true, store: env }
roles:
  admin: { servers: ["*"] }
servers:
  - slug: ${slug}
    kind: remote-http
    url: https://example.com/mcp
    entitlements: []
`;

  it("rejects a doubled dash, because it would make two servers share a variable", () => {
    expect(() => parseConfig(yaml("a--b"))).toThrow(
      /doubled dash|single dashes/,
    );
  });

  it("rejects a leading or trailing dash", () => {
    expect(() => parseConfig(yaml("-lead"))).toThrow();
    expect(() => parseConfig(yaml("trail-"))).toThrow();
  });

  it("still accepts every slug shape this deployment actually uses", () => {
    for (const slug of [
      "gcs",
      "telegram-ro",
      "remote-filesystem-tmp-public",
      "monarch-money-readwrite",
      "google-docs-rw-external",
    ]) {
      expect(() => parseConfig(yaml(slug))).not.toThrow();
    }
  });
});
