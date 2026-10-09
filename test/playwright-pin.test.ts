import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * One Chromium, four npm trees, and nothing that made them agree.
 *
 * `servers/bundle/host/src/browser.ts` launches ONE browser and hands the
 * `Browser` object to good-eggs, fetchpet and pointsyeah through their
 * `setSharedBrowserProvider` seam. Those are three separate trees with three
 * separate `node_modules` and three separate copies of `playwright-core`, and
 * the browser they share comes out of the base image — whose Chromium matches
 * exactly one Playwright version and no other. So the base image tag and every
 * npm pin have to be the same version, in four Dockerfiles and four
 * `package.json` files at once.
 *
 * Nothing checked that. The bundle smoke (`servers/bundle/scripts/smoke.mjs`)
 * sets all three browser servers to `null` in `EXPECT` — "just list" — and
 * listing tools never launches Chromium. A bumped base tag with an unbumped
 * `overrides`, or the reverse, therefore builds green, boots green, lists tools
 * green, and fails on the first browser-driven tool call in production with
 * `Executable doesn't exist at /ms-playwright/chromium-<rev>` — or, worse for the
 * collapsed bundle, hands a `Browser` minted by one copy of `playwright-core` to
 * a tree holding a different one.
 *
 * This is the hazard the `VENDORED` seams exist for: a value that must be
 * identical in npm trees that cannot import each other. It crosses a
 * Dockerfile/`package.json` boundary rather than a `.ts` one, so byte-vendoring
 * does not apply and a guard has to.
 *
 * No version literal appears in this file. The version is read out of the image
 * that carries the Chromium and everything else is compared against it — a guard
 * that restated the number would just be one more place to bump.
 *
 * If it fails: pick ONE version and write it everywhere this file names —
 * including the prose, which is where the rule is actually recorded.
 *
 * ## Two pins per tree, except the host, which needs one
 *
 * The three server trees pin `playwright` AND `playwright-core`, because their
 * workspaces declare ranges (`^1.49.1`, `^1.58.2`) and `playwright-extra`
 * declares `playwright-core: "*"` as a peer — without the override npm resolves
 * those freely. `servers/bundle/host` declares `playwright` as a direct exact
 * dependency, and `playwright` depends on its own `playwright-core` exactly, so
 * a second pin there would add a place to bump and buy nothing. What it would
 * NOT buy is the case that matters: a dependency pulling a NESTED second copy of
 * `playwright-core`, which no `package.json` pin can prevent. The lockfile check
 * below asserts that directly, for all four trees.
 *
 * ## The failure this file could have instead of the one it prevents
 *
 * A guard that reads a file and finds nothing passes vacuously, and looks exactly
 * like a guard that found agreement. That is the real risk here, because the
 * strings live in formats nobody type-checks: a `FROM` line that later takes its
 * base from a build arg, an `overrides` block that becomes a `dependencies` one,
 * a lockfile key that moves, a numbered prose entry that gets renumbered. So
 * every file is asserted to have yielded at least one version string, and the two
 * sweeps at the end assert the lists themselves are complete — a fifth image or a
 * fifth tree fails rather than going unguarded.
 */

/** `mcr.microsoft.com/playwright:v<version>-noble`, wherever it is written. */
const IMAGE_TAG = /mcr\.microsoft\.com\/playwright:v(\d+\.\d+\.\d+)-noble/g;

/** `Playwright 1.61.1` / `Playwright to \`1.61.1\`` — the bare restatements. */
const PROSE_VERSION = /playwright(?:\s+to)?\s+`?(\d+\.\d+\.\d+)`?/gi;

/** `(rev 1228)` / `revision (1228)` — the number the version exists to match. */
const CHROMIUM_REV = /\brev(?:ision)?\s*\(?(\d{3,5})\)?/gi;

/** An npm version with no range operator in front of it. */
const EXACT = /^\d+\.\d+\.\d+$/;

/**
 * The image that carries the Chromium, and so the ground truth for everything
 * else — read out of the file that decides it rather than restated.
 */
const GROUND_TRUTH = "servers/bundle/Dockerfile";

/** Every image built on that base. The sweep below asserts there is no fifth. */
const IMAGES = [
  GROUND_TRUTH,
  "servers/good-eggs/Dockerfile",
  "servers/fetchpet/Dockerfile",
  "servers/pointsyeah/Dockerfile",
] as const;

/** Every npm tree that ends up with a copy of `playwright-core` in that image. */
const TREES = [
  "servers/bundle/host",
  "servers/good-eggs",
  "servers/fetchpet",
  "servers/pointsyeah",
] as const;

/**
 * This file. It names the image string in a doc comment and a regex, so the
 * sweep would otherwise report it as an unguarded fifth declaration.
 */
const SELF = join("test", "playwright-pin.test.ts");

/** Directories with nothing of ours in them, or a build of something that has. */
const SKIP = new Set(["node_modules", "dist", ".astro", "coverage"]);

function read(path: string): string {
  return readFileSync(path, "utf8");
}

/** Every first capture group of a global regex, in order. */
function captured(text: string, pattern: RegExp): string[] {
  return [...text.matchAll(pattern)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );
}

function tags(text: string): string[] {
  return captured(text, IMAGE_TAG);
}

/**
 * Docker's predefined build args. They need no `ARG` declaration to be usable in
 * a `FROM`, so an unresolved one is not the failure the `$` assertion looks for.
 */
const PREDEFINED = new Set([
  "TARGETPLATFORM",
  "TARGETOS",
  "TARGETARCH",
  "TARGETVARIANT",
  "BUILDPLATFORM",
  "BUILDOS",
  "BUILDARCH",
  "BUILDVARIANT",
]);

interface Base {
  /** 1-indexed, so a failure points at a line a human can open. */
  line: number;
  /** The image this stage ultimately builds on, with `ARG`s expanded. */
  ref: string;
}

/**
 * Every stage of a Dockerfile, resolved to the image it ultimately builds on.
 *
 * Only ARGs declared BEFORE the first `FROM` are in scope for a `FROM` line —
 * that is Docker's rule, and it is why `servers/bundle/Dockerfile` declares
 * `ARG PW=` at the top and then writes `FROM ${PW}` for every stage. An ARG this
 * function cannot resolve keeps its `$`, so the assertion below can see it.
 *
 * A stage built on another stage (`FROM build AS final`) resolves through to
 * that stage's own base, so the last entry is always the layer that ships.
 */
function bases(path: string): Base[] {
  const lines = read(path).split("\n");
  const args = new Map<string, string>();
  for (const line of lines) {
    if (/^\s*FROM\s/i.test(line)) break;
    const arg = /^\s*ARG\s+([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (arg?.[1] && arg[2] !== undefined) {
      args.set(arg[1], arg[2].trim().replace(/^["']|["']$/g, ""));
    }
  }

  const expand = (ref: string): string =>
    ref.replace(
      /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
      (whole, braced?: string, bare?: string) => {
        const name = braced ?? bare ?? "";
        return args.get(name) ?? (PREDEFINED.has(name) ? "<build-arg>" : whole);
      },
    );

  const stages = new Map<string, string>();
  const found: Base[] = [];
  lines.forEach((line, index) => {
    const from = /^\s*FROM\s+(.*)$/i.exec(line);
    if (!from?.[1]) return;
    const tokens = from[1]
      .trim()
      .split(/\s+/)
      .filter((token) => !token.startsWith("--"));
    const named = expand(tokens[0] ?? "");
    const ref = stages.get(named.toLowerCase()) ?? named;
    found.push({ line: index + 1, ref });
    const as = tokens.findIndex((token) => /^as$/i.test(token));
    const stage = as >= 0 ? tokens[as + 1] : undefined;
    if (stage) stages.set(stage.toLowerCase(), ref);
  });
  return found;
}

interface Pin {
  where: string;
  version: string;
}

/** Every `playwright` / `playwright-core` version a `package.json` declares. */
function pins(path: string): Pin[] {
  const manifest = JSON.parse(read(path)) as Record<
    string,
    Record<string, string> | undefined
  >;
  const found: Pin[] = [];
  for (const field of [
    "overrides",
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ]) {
    for (const name of ["playwright", "playwright-core"]) {
      const version = manifest[field]?.[name];
      if (version) found.push({ where: `${path} ${field}.${name}`, version });
    }
  }
  return found;
}

/**
 * Every copy of `playwright` / `playwright-core` a lockfile resolves — at any
 * nesting, not just the hoisted one. A nested second copy is the failure mode
 * that an explicit `package.json` pin would NOT catch, and it is the version
 * that actually has to match the image's Chromium.
 */
function locked(tree: string): Pin[] {
  const path = `${tree}/package-lock.json`;
  const lock = JSON.parse(read(path)) as {
    packages?: Record<string, { version?: string }>;
  };
  return Object.entries(lock.packages ?? {})
    .filter(([key]) => /(^|\/)node_modules\/playwright(-core)?$/.test(key))
    .map(([key, entry]) => ({
      where: `${path} ${key}`,
      version: entry.version ?? "<none>",
    }));
}

/**
 * A slice of a file that states the rule, and nothing else.
 *
 * Scoped rather than whole-file in both directions. `HACKS.md` is forty entries
 * and `limitations.md` is nineteen hundred lines: a truthful sentence elsewhere
 * naming a different Playwright version would fail a whole-file scan, and — the
 * inverse, and worse — entry #11 could be deleted or renumbered while some other
 * part of the file still mentioned the pin, and the scan would call that
 * agreement.
 */
interface Prose {
  path: string;
  /** The slice that must state the pin, or `null` if the anchor is gone. */
  section(text: string): string | null;
}

/** The `comments` block of a `package.json` — the documentation string itself. */
function comments(text: string): string | null {
  const manifest = JSON.parse(text) as { comments?: Record<string, string> };
  return manifest.comments ? JSON.stringify(manifest.comments) : null;
}

/** One entry of a numbered markdown catalog, from its heading to the next. */
function entry(heading: string, next: string) {
  return (text: string): string | null => {
    const start = text.indexOf(heading);
    if (start < 0) return null;
    const rest = text.slice(start + heading.length);
    const end = rest.indexOf(next);
    return heading + (end < 0 ? rest : rest.slice(0, end));
  };
}

const PROSE: Prose[] = [
  ...TREES.map((tree) => ({ path: `${tree}/package.json`, section: comments })),
  {
    path: "HACKS.md",
    section: entry("## 11. The browser images pin Playwright", "\n## "),
  },
  {
    path: "docs/src/content/docs/limitations.md",
    section: entry("### 11. Playwright is pinned", "\n### "),
  },
];

/** Every file under the repo root, skipping build output and dependencies. */
function walk(dir = ".", found: string[] = []): string[] {
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, item.name);
    if (item.isDirectory()) {
      if (!SKIP.has(item.name) && !item.name.startsWith(".")) walk(path, found);
      continue;
    }
    // Lockfiles name `playwright` on thousands of lines and are megabytes of it.
    // They are read by `locked()`, from an explicit list, not swept.
    if (item.name === "package-lock.json") continue;
    if (statSync(path).size > 1_000_000) continue;
    found.push(path);
  }
  return found;
}

const REPO = walk();

const PIN = tags(read(GROUND_TRUTH))[0];
const PINNED_IMAGE = `mcr.microsoft.com/playwright:v${PIN}-noble`;

describe("the Playwright pin", () => {
  it("is read out of the image that carries the Chromium", () => {
    // Everything below compares against this. If it is undefined, every other
    // assertion in the file compares two undefineds and passes.
    expect(PIN, `${GROUND_TRUTH} names no Playwright base image`).toMatch(
      EXACT,
    );
  });
});

describe.each(IMAGES)("the base image tags in %s", (path) => {
  it("resolves every FROM to a real image reference", () => {
    // The named risk: a Dockerfile that later takes its base from a build arg
    // this file does not follow. Then the tag is not in the text, the version
    // list for this file is empty, and a guard that only looked for tags would
    // report agreement it never checked. An unresolved `$` fails instead.
    for (const base of bases(path)) {
      expect(
        base.ref,
        `${path}:${base.line} — unresolved build arg`,
      ).not.toMatch(/\$/);
    }
  });

  it("names the pinned Playwright image, at least once", () => {
    expect(
      tags(read(path)).length,
      `${path} names no Playwright base image`,
    ).toBeGreaterThan(0);
  });

  it("names no other Playwright version", () => {
    for (const version of tags(read(path))) {
      expect(version, `${path} builds on a different Chromium`).toBe(PIN);
    }
  });

  it("ships the layer that carries the Chromium", () => {
    // The stage that matters is the LAST one: the runtime layer is what runs the
    // browser. A build stage on the Playwright base and a runtime stage on
    // something slimmer agrees with every version string in the file and still
    // has no Chromium in it.
    const runtime = bases(path).at(-1);
    expect(
      runtime?.ref,
      `${path} — the final FROM is not the pinned image`,
    ).toBe(PINNED_IMAGE);
  });
});

describe.each(TREES)("the npm pins in %s", (tree) => {
  it("declares a Playwright version at all", () => {
    // An `overrides` block renamed, moved or dropped takes the pin with it, and
    // the tree quietly goes back to resolving whatever its workspaces' `^`
    // ranges allow.
    expect(
      pins(`${tree}/package.json`).length,
      `${tree}/package.json pins neither playwright nor playwright-core`,
    ).toBeGreaterThan(0);
  });

  it("pins it exactly, to the version the image carries", () => {
    for (const pin of pins(`${tree}/package.json`)) {
      // A `^` or `~` here is the same bug arriving slowly: the tree installs
      // whatever npm resolves on the day the image is built.
      expect(pin.version, `${pin.where} is not an exact version`).toMatch(
        EXACT,
      );
      expect(pin.version, `${pin.where} disagrees with ${GROUND_TRUTH}`).toBe(
        PIN,
      );
    }
  });
});

describe.each(TREES)("the lockfile in %s", (tree) => {
  it("resolves playwright-core at all", () => {
    const core = locked(tree).filter((pin) =>
      pin.where.endsWith("node_modules/playwright-core"),
    );
    expect(
      core.length,
      `${tree}/package-lock.json resolves no playwright-core`,
    ).toBeGreaterThan(0);
  });

  it("resolves every copy to the pinned version", () => {
    for (const pin of locked(tree)) {
      expect(pin.version, `${pin.where} disagrees with ${GROUND_TRUTH}`).toBe(
        PIN,
      );
    }
  });
});

describe.each(PROSE)("the prose in $path", (prose) => {
  it("still has the entry that states the rule", () => {
    expect(
      prose.section(read(prose.path)),
      `${prose.path} — the entry stating the pin is gone or renamed`,
    ).not.toBeNull();
  });

  it("states the pinned version", () => {
    const section = prose.section(read(prose.path)) ?? "";
    const versions = [...tags(section), ...captured(section, PROSE_VERSION)];
    expect(
      versions.length,
      `${prose.path} no longer states the pin`,
    ).toBeGreaterThan(0);
    for (const version of versions) {
      expect(
        version,
        `${prose.path} documents a version strad does not install`,
      ).toBe(PIN);
    }
  });
});

describe("the Chromium revision the prose names", () => {
  // The version exists to match this number, and the number is restated in nine
  // comments that nothing derives. A bump that gets every version string right
  // and leaves the revision behind produces nine wrong explanations of why the
  // pin is what it is. Its true value cannot be known here — only that every
  // copy of it says the same thing.
  const stated = [
    ...IMAGES.map((path) => ({ where: path, text: read(path) })),
    ...PROSE.map((prose) => ({
      where: prose.path,
      text: prose.section(read(prose.path)) ?? "",
    })),
  ].flatMap(({ where, text }) =>
    captured(text, CHROMIUM_REV).map((rev) => ({ where, rev })),
  );

  it("is stated somewhere", () => {
    expect(
      stated.length,
      "no file explains which Chromium the pin is for",
    ).toBeGreaterThan(0);
  });

  it("is the same revision everywhere it is stated", () => {
    for (const pin of stated) {
      expect(pin.rev, `${pin.where} names a different Chromium`).toBe(
        stated[0]?.rev,
      );
    }
  });
});

describe("the lists this file guards", () => {
  // `IMAGES`, `TREES` and `PROSE` are literals, because a globbed list can go
  // empty and report agreement. The cost of a literal is that a fifth image or
  // a fifth tree would simply be unguarded — so the tree is swept for the same
  // declarations and the two are compared, the way `vendored.sync.test.ts`
  // compares its manifest against every stamped copy on disk.

  it("name every file that builds on the Playwright image", () => {
    const swept = REPO.filter(
      (path) =>
        path !== SELF && read(path).includes("mcr.microsoft.com/playwright"),
    );
    expect(swept.sort()).toEqual(
      [...IMAGES, ...PROSE.map((prose) => prose.path)].sort(),
    );
  });

  it("name every tree that pins Playwright exactly", () => {
    // A range (`^1.49.1` in a workspace) is not a pin — it is the thing the
    // `overrides` exists to override, and it is allowed to say anything the pin
    // satisfies. An EXACT version is a claim about the image's Chromium, and
    // only these four trees get to make one.
    const swept = REPO.filter(
      (path) =>
        path.endsWith("package.json") &&
        pins(path).some((pin) => EXACT.test(pin.version)),
    );
    expect(swept.sort()).toEqual(
      TREES.map((tree) => join(tree, "package.json")).sort(),
    );
  });
});
