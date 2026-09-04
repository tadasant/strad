import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error — a plain .mjs script, deliberately not part of the TS program.
import * as manifest from "../scripts/sync-vendored.mjs";

const { copies, drifted, repoPath, select, VENDORED } = manifest;

/**
 * Vendored copies rot. This is the thing that notices — for every seam at once.
 *
 * Six seams cross an npm-tree boundary — nine files, since one of them is a
 * library that spans four — because a supplementary image is its own Docker
 * build context and `servers/bundle/host` and `servers/secrets` are their own
 * npm projects. Each has to exist twice, and the only thing standing between
 * that and slowly-diverging copies is this file.
 *
 * If it fails: edit the SOURCE named in the failure (never a copy), run
 * `npm run vendor:sync`, and commit both halves.
 *
 * The seam-specific checks — that the secrets tree has no second implementation
 * of a name the wire owns, that the bundle host still greps for the real marker
 * variables — are NOT here. They belong to their seams and live in
 * `test/parameter-wire.ownership.test.ts` and `test/env-prefix.markers.test.ts`.
 */
interface Entry {
  id: string;
  source: string;
  /** Present when `source` and `targets` are directories rather than files. */
  files?: string[];
  label: string;
  banner: string;
  targets: string[];
}

/** One `{ source, target }` pair per copy the entry owns. */
interface Copy {
  source: string;
  target: string;
}

const entries: Entry[] = VENDORED;

/** Every copy every entry owns — the manifest's answer, not a second one. */
const everyCopy = (): Copy[] => entries.flatMap((entry) => copies(entry));

/** The first line of every banner, and the only thing a copy is known by. */
const STAMP = "// GENERATED — DO NOT EDIT.";

/** Directories with nothing of ours in them, or a build of something that has. */
const SKIP = new Set(["node_modules", "dist", ".astro", "coverage"]);

/**
 * `scripts/sync-vendored.mjs` holds every banner as a string literal. It is the
 * renderer, not a copy — its own first line is a docblock, so the scan passes
 * over it either way, but say so rather than depend on that.
 */
const RENDERER = join("scripts", "sync-vendored.mjs");

/** Every file in the repo whose first line is the generated-copy stamp. */
function stamped(dir = ".", found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP.has(entry.name) && !entry.name.startsWith(".")) {
        stamped(path, found);
      }
      continue;
    }
    if (!/\.(ts|mjs|js)$/.test(entry.name) || path === RENDERER) continue;
    if (readFileSync(path, "utf8").startsWith(STAMP)) found.push(path);
  }
  return found;
}

/**
 * The manifest is the check, so a misread manifest is a check over nothing.
 *
 * `drifted()` returning `[]` because an entry lost its targets — or because the
 * whole list did — looks EXACTLY like "in sync", and six drift guards would
 * become zero with CI green. The per-seam tests this replaced got that
 * protection for free by naming their targets as literals. Here it has to be
 * asserted out loud.
 */
describe("the vendored-module manifest", () => {
  it("is not empty", () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  it("covers every seam we expect to have one", () => {
    // Naming them here means adding a seventh module that crosses an npm boundary
    // — or dropping one — is a deliberate act, not something that silently
    // ships with a guard that guards nothing.
    expect(entries.map((entry) => entry.id).sort()).toEqual([
      "elicitation",
      "envprefix",
      "paramroute",
      "presence",
      "telemetry",
      "wire",
    ]);
  });

  it("gives every entry at least one target", () => {
    for (const entry of entries) {
      expect(entry.targets.length, entry.id).toBeGreaterThan(0);
    }
  });

  it("names every module in a multi-file entry's source directory", () => {
    // `files:` is hand-maintained, and nothing else compares it to the tree. A
    // module ADDED to the source and hand-copied to the target is the one drift
    // this seam cannot see from the other side: the copy carries no stamp, so
    // the scan below does not claim it, and `--check` keeps reporting four
    // copies in sync while a fifth diverges forever. `files: []` is the same
    // fail-open with nothing named at all.
    //
    // Dropping a name is already caught — the orphaned target keeps its stamp
    // and "claims every generated copy" sees it — so this closes the direction
    // that was invisible.
    for (const entry of entries) {
      if (entry.files === undefined) continue;
      expect(entry.files.length, entry.id).toBeGreaterThan(0);
      const onDisk = readdirSync(repoPath(entry.source))
        .filter((name) => /\.ts$/.test(name))
        .sort();
      expect([...entry.files].sort(), entry.id).toEqual(onDisk);
    }
  });

  it("writes each copy from exactly one entry", () => {
    // Two entries claiming one path is last-write-wins on the sync and a
    // coin-flip on the check.
    const targets = everyCopy().map((copy) => copy.target);
    expect([...new Set(targets)].length).toBe(targets.length);
  });

  it("claims every generated copy in the repo", () => {
    // The manifest is the only thing that knows a copy exists. Drop a path from
    // an entry and the file stays on disk as an orphan: never rewritten, never
    // compared, and — because the entry still has six other targets and still
    // reports "in sync" — never mentioned again. For the telemetry seam that is
    // the dashboard quietly missing a container, arrived at from the other side.
    //
    // So the check runs in both directions, against the tree rather than a
    // literal: every file stamped with the banner is claimed by some entry, and
    // every path an entry claims is a file that carries the stamp.
    expect(stamped().sort()).toEqual(
      everyCopy()
        .map((copy) => copy.target)
        .sort(),
    );
  });

  it("refuses an --only id it does not know", () => {
    // The other half of the same fail-open: selecting nothing and checking it
    // exits 0, which reads as a clean tree.
    expect(() => select("presense")).toThrow(/unknown --only id/);
    expect(select("presence")).toHaveLength(1);
  });
});

describe.each(entries)("the vendored $id module", (entry) => {
  it("has a source to vendor from", () => {
    expect(existsSync(repoPath(entry.source)), entry.source).toBe(true);
    // For a `files:` entry that only says the directory is there. Name each
    // member too: a name that does not resolve makes `rendered()` throw ENOENT
    // from inside the check loop, which reaches CI as a raw stack trace with no
    // `::error::` line and no seam named.
    for (const copy of copies(entry) as Copy[]) {
      expect(existsSync(repoPath(copy.source)), copy.source).toBe(true);
    }
  });

  it("names its own source in the banner it stamps", () => {
    // The banner is inside the generated bytes and is the only thing telling a
    // reader of a copy where the original lives. A cloned entry that kept the
    // previous entry's banner sends them to the wrong file.
    expect(entry.banner).toContain(entry.source);
  });

  it("is byte-identical in every tree that speaks it", () => {
    expect(drifted(entry)).toEqual([]);
  });
});
