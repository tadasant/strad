import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { installableTrees } from "./helpers/bundle-trees.js";

// The runner is the one dependency every package in this repo shares, and it
// drifted to THREE majors — root on 2, `servers/x-twitter` on 3, the rest on 4 —
// in the two weeks the #154 conversion program was landing. Nothing failed:
// `expect` matchers, `vi.spyOn` reset semantics and fake timers all behave
// differently across those majors, so the cost was a test that was not portable
// between the places it gets copied from and to. This suite is the thing that
// notices. It is the same shape as `test/vendored.sync.test.ts` — an invariant
// the repo decided on, asserted rather than remembered.
//
// It walks the git index rather than the filesystem so that a tree's
// `node_modules/` cannot answer for it.
//
// TWO rules live here, and they answer different questions. The first — "one
// Vitest, everywhere" — is about the vitest a package already declares: which
// major, and which options its config sets. The second — "one HARNESS,
// everywhere" — is about whether a package declares one at all, and it exists
// because the first cannot see the failure that actually recurred. `#154` was
// closed once by converting twelve packages, and then two trees added after it
// (`servers/grafana`, `images/bundle-google`) shipped on `node --test` and one
// of them ran its suite against a stale `build/`. Every check in this repo was
// green throughout, because a suite that runs a different runner and a suite
// that runs nothing at all both report exactly like a suite that passed.

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/** The one range every package that declares Vitest must declare. */
const RANGE = "^4.1.9";

/** The two options every `vitest.config.ts` must set. */
const ENVIRONMENT = "node";
const TEST_TIMEOUT = 20_000;

/**
 * Configs that deliberately set a LARGER timeout, with the reason. Both drive
 * live x-twitter network calls and are run by hand, never by the `servers`
 * matrix; holding them to 20s would be a regression, not convergence.
 */
const LARGER_TIMEOUT_IS_DELIBERATE: Record<string, number> = {
  "servers/x-twitter/vitest.config.integration.ts": 30000,
  "servers/x-twitter/vitest.config.e2e.ts": 60000,
};

function tracked(pattern: string): string[] {
  return execFileSync("git", ["ls-files", pattern], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);
}

function read(relative: string): string {
  return readFileSync(path.join(REPO_ROOT, relative), "utf8");
}

describe("one Vitest, everywhere", () => {
  it("finds the packages and the configs at all, so an empty walk cannot pass", () => {
    // Every assertion below is over a list. A glob that stopped matching would
    // make all of them vacuously true, which is the shape of a guard that
    // guards nothing.
    expect(declaringPackages().length).toBeGreaterThan(10);
    expect(configs().length).toBeGreaterThan(10);
  });

  it(`declares ${RANGE} in every package.json that declares vitest at all`, () => {
    const off = declaringPackages()
      .filter(([, range]) => range !== RANGE)
      .map(([file, range]) => `${file}: ${range}`);
    expect(off).toEqual([]);
  });

  it("moves @vitest/* companions with it — a lone bump is a peer conflict on `npm ci`", () => {
    // `servers/x-twitter` declares `@vitest/ui`, and npm refuses to install it
    // against a different vitest major. Anything else in the `@vitest/`
    // namespace is the same pair.
    const off: string[] = [];
    for (const file of tracked("**/package.json")) {
      if (file.includes("node_modules/")) continue;
      const pkg = JSON.parse(read(file)) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      for (const [name, range] of Object.entries(deps)) {
        if (name.startsWith("@vitest/") && range !== RANGE) {
          off.push(`${file}: ${name} ${range}`);
        }
      }
    }
    expect(off).toEqual([]);
  });

  it(`sets environment: "${ENVIRONMENT}" in every vitest config`, () => {
    const off = configs()
      .filter(
        ([, source]) =>
          !source.includes(`environment: "${ENVIRONMENT}"`) &&
          !source.includes(`environment: '${ENVIRONMENT}'`),
      )
      .map(([file]) => file);
    expect(off).toEqual([]);
  });

  it(`sets testTimeout: ${TEST_TIMEOUT} in every vitest config that does not say why it differs`, () => {
    const off: string[] = [];
    for (const [file, source] of configs()) {
      const match = /testTimeout:\s*([0-9_]+)/.exec(source);
      if (!match) {
        off.push(`${file}: no testTimeout`);
        continue;
      }
      const value = Number(match[1]!.replaceAll("_", ""));
      const allowed = LARGER_TIMEOUT_IS_DELIBERATE[file];
      if (allowed !== undefined) {
        // A deliberate exception must still be the value this file records, and
        // it must be LARGER — the reason for every exception so far is a live
        // network call, and nothing about a shared box argues for a tighter one.
        expect(value, file).toBe(allowed);
        expect(value, file).toBeGreaterThan(TEST_TIMEOUT);
        continue;
      }
      if (value !== TEST_TIMEOUT) off.push(`${file}: ${value}`);
    }
    expect(off).toEqual([]);
  });

  it("lists no exception for a config that is gone", () => {
    // An exception outliving its file would silently widen the rule for a path
    // nobody serves.
    const present = new Set(configs().map(([file]) => file));
    const stale = Object.keys(LARGER_TIMEOUT_IS_DELIBERATE).filter(
      (file) => !present.has(file),
    );
    expect(stale).toEqual([]);
  });
});

describe("one HARNESS, everywhere", () => {
  // The convergence above is about the vitest a package already declares. It has
  // nothing to say about a package that declares none — which is the hole two
  // trees walked through after the #154 conversion program closed. `servers/grafana`
  // and `images/bundle-google` were both added on `node --test` against their
  // compiled `build/`, both ran green in CI, and nothing anywhere went red,
  // because "runs a different runner" and "runs no tests at all" look exactly
  // like "passes" from outside. That is the whole difficulty of this class of
  // regression, and it is why the rule is asserted rather than remembered.
  //
  // The unit is the TREE — a directory carrying its own `package-lock.json`,
  // which is what `npm ci` can address and therefore what a CI leg runs in. It
  // is deliberately NOT every package: `servers/bundle-api/upstream/gcs` and its
  // siblings are verbatim vendor copies whose tests belong upstream, and
  // demanding a suite of each would be demanding a merge conflict on the next
  // re-vendor.

  it("finds the trees at all, so an empty walk cannot pass", () => {
    expect(harnessUnits().length).toBeGreaterThan(10);
  });

  it("runs no suite on `node --test`", () => {
    const off: string[] = [];
    for (const file of tracked("**/package.json")) {
      if (file.includes("node_modules/")) continue;
      const pkg = JSON.parse(read(file)) as {
        scripts?: Record<string, string>;
      };
      for (const [name, script] of Object.entries(pkg.scripts ?? {})) {
        if (/\bnode\s+--test\b/.test(script))
          off.push(`${file}: ${name}: ${script}`);
      }
    }
    expect(
      off,
      "the repo runs one test runner. A package on `node --test` is a suite " +
        "written against different `expect` matchers, different spy semantics " +
        "and different fake timers from every other suite here — portable " +
        "nowhere, and invisible until someone tries to move a test",
    ).toEqual([]);
  });

  it("names no test file `.test.mjs`, which no `include:` in this repo matches", () => {
    // The other half of the same rule, and the one byte-level check that catches
    // the silent case: a `.mjs` suite added beside a converted tree's `.ts` ones
    // is matched by no `include:` here, so it is collected by nothing, run by
    // nothing, and reports exactly like a suite that passed.
    const off = tracked("**/*.test.mjs").filter(
      (file) => !file.includes("node_modules/"),
    );
    expect(off).toEqual([]);
  });

  it("gives every tree a `test` script that ends at vitest", () => {
    const off: string[] = [];
    for (const tree of harnessUnits()) {
      const leaves = leafTestCommands(tree);
      // A tree that resolved to nothing would pass the loop below vacuously —
      // the same shape as the empty-walk failure the first test guards against,
      // one level down.
      expect(
        leaves.length,
        `${tree}: its \`test\` script resolves to no command at all`,
      ).toBeGreaterThan(0);
      for (const leaf of leaves) {
        if (!/\bvitest\b/.test(leaf)) off.push(`${tree}: ${leaf}`);
      }
    }
    expect(
      off,
      "every tree's `npm test` must end at vitest, following " +
        "`npm run test --workspace <x>` through to the command that actually " +
        "runs a suite",
    ).toEqual([]);
  });
});

/**
 * Every unit `npm ci` can address, which is every unit a CI leg can run in: the
 * repo root, plus each directory under `servers/` or `images/` carrying its own
 * lockfile. `installableTrees()` is the same reader `ci-server-trees.test.ts`
 * compares the `servers` matrix against, so "a tree" means one thing in both.
 */
function harnessUnits(): string[] {
  return [".", ...[...installableTrees()].sort()];
}

type Pkg = { name?: string; scripts?: Record<string, string> };

/**
 * Every `package.json` inside one tree, keyed by BOTH its path from that tree's
 * root and its `name` — because `--workspace` takes either, and this repo uses
 * both (`--workspace shared`, `--workspace google-sheets-workspace-mcp-server-shared`).
 *
 * The walk stops at a nested lockfile: that directory is a tree in its own right
 * and answers for itself, which is what keeps `servers/bundle/host` from being
 * counted as part of the repo root.
 */
function packagesUnder(tree: string): Map<string, Pkg> {
  const found = new Map<string, Pkg>();
  const walk = (dir: string, rel: string): void => {
    const manifest = path.join(dir, "package.json");
    if (existsSync(manifest)) {
      const pkg = JSON.parse(readFileSync(manifest, "utf8")) as Pkg;
      found.set(rel === "" ? "." : rel, pkg);
      if (pkg.name) found.set(pkg.name, pkg);
    }
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const child = path.join(dir, e.name);
      if (existsSync(path.join(child, "package-lock.json"))) continue;
      walk(child, rel === "" ? e.name : `${rel}/${e.name}`);
    }
  };
  walk(path.join(REPO_ROOT, tree), "");
  return found;
}

/**
 * A tree's `test` script, resolved through every `npm run test --workspace <x>`
 * it delegates to, down to the commands that actually run something.
 *
 * The delegation is real and several levels of it exist: `servers/grafana`
 * forwards to one workspace, `servers/bundle-api` to three, and only the leaf
 * says which runner is used. Checking the tree's own script alone would read
 * `npm run test --workspace shared` as neither vitest nor `node --test`.
 */
function leafTestCommands(tree: string): string[] {
  const packages = packagesUnder(tree);
  const leaves: string[] = [];
  const seen = new Set<string>();

  const visit = (key: string): void => {
    if (seen.has(key)) return;
    seen.add(key);
    const pkg = packages.get(key);
    expect(
      pkg,
      `${tree}: \`--workspace ${key}\` names no package in this tree`,
    ).toBeDefined();
    const script = pkg!.scripts?.test;
    expect(
      script,
      `${tree}: \`${key}\` has no \`test\` script — a tree that ships source ` +
        `and runs nothing is the failure this file exists to make loud`,
    ).toBeDefined();
    const delegated = [...script!.matchAll(/--workspace(?:=|\s+)(\S+)/g)].map(
      (m) => m[1]!,
    );
    if (delegated.length === 0) leaves.push(script!);
    else for (const ref of delegated) visit(ref);
  };

  visit(".");
  return leaves;
}

/** Every tracked `package.json` that declares `vitest`, with the range it declares. */
function declaringPackages(): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const file of tracked("**/package.json")) {
    if (file.includes("node_modules/")) continue;
    const pkg = JSON.parse(read(file)) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const range = pkg.devDependencies?.vitest ?? pkg.dependencies?.vitest;
    if (range) out.push([file, range]);
  }
  return out;
}

/** Every tracked `vitest.config*.ts`, with its source. */
function configs(): Array<[string, string]> {
  return tracked("**/vitest.config*.ts")
    .filter((file) => !file.includes("node_modules/"))
    .map((file) => [file, read(file)] as [string, string]);
}
