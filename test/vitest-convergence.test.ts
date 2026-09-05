import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
