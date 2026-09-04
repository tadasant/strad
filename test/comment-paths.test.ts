import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every repo-relative path this repo's comments name, checked against the tree.
 *
 * The headers here are unusually load-bearing: they tell a reader where a rule is
 * asserted, which tree owns a copy, which workflow builds an image. A reader
 * believes them, and a false one is worse than no comment at all — it sends
 * someone looking for a file that is not there and leaves them unable to tell
 * whether the assertion was never written or the name is just wrong.
 *
 * The same header got it wrong twice. `src/secrets/presence.ts` named
 * test/presence.sync.test.ts after that suite was deleted (#178, fixed by #253),
 * and four lines away it named test/bundle-presence.test.ts, which has never
 * existed at all (#252, fixed by #278) — the module name with ".test.ts" glued
 * onto it, written in the header whose whole job is to say where the
 * no-bytes-of-the-value rule is asserted. Neither is backticked here, and that
 * is the convention this guard establishes: the backticks ARE the claim, so a
 * comment naming a file that is deliberately not there writes it bare. The two
 * names are exercised as strings further down, where nothing reads them as a
 * claim about the tree.
 *
 * `test/vendored.sync.test.ts` could not have caught either, and this is the
 * distinction that matters: it guards that a vendored copy is IDENTICAL, not
 * that it is TRUE. Both wrong names propagated to
 * `servers/bundle/host/src/presence.ts` perfectly in sync.
 *
 * ## What counts as a claim
 *
 * A backticked token, in a comment, that contains a `/` and whose first segment
 * is a tracked top-level entry of this repo. The anchor is what makes the scan
 * quiet enough to be a gate: without it `tools/list`, `roles/parametermanager.
 * parameterViewer`, `@google-cloud/storage`, `versions/latest` and `owner/name`
 * are all "paths", and the guard is 55 false positives instead of a check.
 *
 * Two forms are read rather than reported, because both are conventions this
 * repo really uses and an allowlist of instances would go stale the moment a
 * fourth one was written:
 *
 * - **Elision.** A `...` segment stands for zero or more segments, so
 *   `docs/.../operate/secrets.md` — the form CLAUDE.md and HACKS.md use
 *   throughout — resolves. It still has to resolve to SOMETHING: elide the path
 *   to a page that does not exist and this is red.
 * - **The doc-site route.** `docs/operate/secrets.md` is how the console and the
 *   renderer refer to a page whose file is
 *   `docs/src/content/docs/operate/secrets.md`. That is the route the Starlight
 *   site serves, it is the stable name, and it is what a human types. Resolved
 *   as a first-class second form, so renaming the page still reddens every
 *   comment that names it — which an allowlist would not.
 *
 * A token carrying `*`, `<`, `>` or whitespace is a pattern or a placeholder —
 * `docs/**`, `servers/<tree>` — not a claim about a file, and is not a candidate.
 *
 * ## Two things this deliberately does not check
 *
 * **`servers/**` is not walked.** Each tree there is its own npm project with its
 * own root, so a path in one is ambiguous by construction: the mounts.test.ts
 * that `servers/bundle/host/src/mounts.ts` names is relative to THAT tree, while
 * `docs/operate/secrets-iam.md` a few files away is relative to the repo. A
 * checker that accepted either would assert almost nothing. The vendored copies
 * lose nothing by the omission — they are byte-identical to a source under
 * `src/`, which IS walked, and `test/vendored.sync.test.ts` is what keeps them
 * that way. That is precisely the seam that failed twice.
 *
 * **A bare filename is not a claim.** `retry.ts`, `appspec.ts`,
 * `release-bundle-image.yml` — this repo names a sibling module or a workflow by
 * its basename constantly, and resolving those would mean inventing a second
 * convention (relative to the file? to `.github/workflows/`?) for a form that has
 * never been the one that rotted. Requiring a `/` is what keeps this a check on
 * repo-relative paths rather than a spell-checker for filenames.
 */

/** The trees walked. `servers/**` is excluded by design — see the header. */
const TREES = ["src", "scripts", "test"] as const;

/** Files whose comments are `//` and block comments. `agent-dev.sh` is not one. */
const SOURCE_FILE = /\.(?:ts|mts|cts|js|mjs|cjs)$/;

/** Never descended into, by the walk or by an elision. */
const NOT_SOURCE = new Set(["node_modules", ".git", "dist", "coverage"]);

/**
 * The top-level entries a comment may anchor a path at, taken from git rather
 * than from a constant so the set follows the repo.
 *
 * Reading it from the tree is what makes the anchor honest, and it is also the
 * one way this could fail open: delete `test/` and every claim anchored there
 * silently stops being checked. "the anchors this repo is built on" below is the
 * other half — the roots that must still be in the set for the scan to mean
 * anything.
 */
const ROOTS: ReadonlySet<string> = new Set(
  execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
    .split("\0")
    .filter(Boolean)
    .map((tracked) => tracked.split("/")[0] ?? tracked),
);

const REQUIRED_ROOTS = [
  ".github",
  "docs",
  "infra",
  "scripts",
  "servers",
  "src",
  "telemetry",
  "test",
] as const;

/** A `...` segment: zero or more path segments, elided. */
const ELISION = "...";

/** Where the doc-site route lands: `docs/operate/secrets.md` is a page under it. */
const DOC_SITE_ROOT = ["docs", "src", "content", "docs"] as const;

type Claim = {
  readonly file: string;
  readonly line: number;
  readonly path: string;
};

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (NOT_SOURCE.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(path));
    else if (SOURCE_FILE.test(entry.name)) found.push(path);
  }
  return found.sort();
}

function subdirectories(dir: string): string[] {
  try {
    return readdirSync(dir === "" ? "." : dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !NOT_SOURCE.has(entry.name))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** Walks `segments` down from `base`, expanding any `...` into real directories. */
function resolveFrom(base: string, segments: readonly string[]): boolean {
  if (segments.length === 0) return true;
  const [head = "", ...rest] = segments;
  if (head === ELISION) {
    if (resolveFrom(base, rest)) return true;
    return subdirectories(base).some((child) =>
      resolveFrom(join(base, child), segments),
    );
  }
  const next = join(base, head);
  return existsSync(next) && resolveFrom(next, rest);
}

/** Does this path name something in the repo, under either accepted form? */
export function resolvesInRepo(path: string): boolean {
  const segments = path.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0) return false;
  const forms = [segments];
  if (segments[0] === "docs" && segments.length > 1) {
    forms.push([...DOC_SITE_ROOT, ...segments.slice(1)]);
  }
  return forms.some((form) => resolveFrom("", form));
}

/** Is this backticked token a claim about a file, rather than prose? */
export function isPathClaim(token: string): boolean {
  if (!token.includes("/")) return false;
  if (/[*<>?\s]/.test(token)) return false;
  if (token.includes("://")) return false;
  return ROOTS.has(token.split("/")[0] ?? "");
}

/**
 * The comments in a source file, each with the line it starts on.
 *
 * Strings and template literals are skipped so that the `//` in a URL is not read
 * as a comment. A regex literal is not tracked: one cannot BEGIN `//` (that is a
 * comment) and this repo writes `\/` inside them, so the sequences that open a
 * comment do not occur in one. The failure mode if that ever stopped holding is a
 * visible false positive, not a silent pass.
 */
export function commentsOf(source: string): { line: number; text: string }[] {
  const found: { line: number; text: string }[] = [];
  let line = 1;
  let i = 0;
  while (i < source.length) {
    const pair = source.slice(i, i + 2);
    if (pair === "//") {
      const start = i + 2;
      while (i < source.length && source[i] !== "\n") i++;
      found.push({ line, text: source.slice(start, i) });
      continue;
    }
    if (pair === "/*") {
      const start = i + 2;
      const startLine = line;
      i += 2;
      while (i < source.length && source.slice(i, i + 2) !== "*/") {
        if (source[i] === "\n") line++;
        i++;
      }
      found.push({ line: startLine, text: source.slice(start, i) });
      i += 2;
      continue;
    }
    const quote = source[i];
    if (quote === '"' || quote === "'" || quote === "`") {
      i++;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === "\\") i++;
        else if (source[i] === "\n") line++;
        i++;
      }
      i++;
      continue;
    }
    if (source[i] === "\n") line++;
    i++;
  }
  return found;
}

/**
 * Every path claim in a file, with the line each one is written on.
 *
 * A backticked span may WRAP. Prettier does not reflow a comment, so a long path
 * gets broken by hand across two ` * ` lines, and a scan that required the span
 * to sit on one line would skip exactly the longest names — the ones most worth
 * checking. The continuation markers are stripped from the span so the two halves
 * rejoin; nothing outside a span is touched.
 */
export function claimsIn(file: string, source: string): Claim[] {
  const claims: Claim[] = [];
  for (const comment of commentsOf(source)) {
    for (const match of comment.text.matchAll(/`([^`]+)`/g)) {
      const token = (match[1] ?? "").replace(/\n\s*\*?[ \t]?/g, "").trim();
      if (!isPathClaim(token)) continue;
      const before = comment.text.slice(0, match.index);
      claims.push({
        file,
        line: comment.line + (before.match(/\n/g)?.length ?? 0),
        path: token,
      });
    }
  }
  return claims;
}

const CLAIMS: readonly Claim[] = TREES.flatMap((tree) =>
  sourceFiles(tree).flatMap((file) =>
    claimsIn(file, readFileSync(file, "utf8")),
  ),
);

describe("every repo-relative path a comment names", () => {
  it("resolves", () => {
    const broken = CLAIMS.filter((claim) => !resolvesInRepo(claim.path)).map(
      (claim) => `${claim.file}:${claim.line}  ${claim.path}`,
    );
    expect(broken).toEqual([]);
  });

  /**
   * A scan that found nothing would pass this file forever. These are the claims
   * the walk has to still be seeing for the green above to mean anything — the
   * first of them being the header both #178 and #252 got wrong.
   */
  it("is actually being found", () => {
    const seen = CLAIMS.map((claim) => `${claim.file} → ${claim.path}`);
    expect(seen).toContain(
      "src/secrets/presence.ts → test/presence.route.test.ts",
    );
    expect(seen).toContain("src/config/schema.ts → scripts/render-spec.ts");
    expect(seen).toContain(
      "src/secrets/parameters/wire.ts → servers/secrets/shared/src/parameter-wire.ts",
    );
    expect(CLAIMS.length).toBeGreaterThan(60);
  });

  it("comes from every tree this walks", () => {
    for (const tree of TREES) {
      expect(CLAIMS.some((claim) => claim.file.startsWith(`${tree}/`))).toBe(
        true,
      );
    }
  });
});

describe("the anchors this repo is built on", () => {
  it("are all still tracked", () => {
    for (const root of REQUIRED_ROOTS) expect(ROOTS.has(root)).toBe(true);
  });
});

describe("a path claim resolves", () => {
  /** The two names that were really written in `src/secrets/presence.ts`. */
  it("only when the file is there — #178 and #252 would both be red", () => {
    expect(resolvesInRepo("test/presence.sync.test.ts")).toBe(false);
    expect(resolvesInRepo("test/bundle-presence.test.ts")).toBe(false);
    expect(resolvesInRepo("test/presence.route.test.ts")).toBe(true);
  });

  it("for a directory as well as a file", () => {
    expect(resolvesInRepo("src/secrets")).toBe(true);
    expect(resolvesInRepo("src/secrets/")).toBe(true);
    expect(resolvesInRepo("src/sercets")).toBe(false);
  });

  it("through the doc-site route, and not past a page that moved", () => {
    expect(existsSync("docs/operate/secrets.md")).toBe(false);
    expect(resolvesInRepo("docs/operate/secrets.md")).toBe(true);
    expect(resolvesInRepo("docs/src/content/docs/operate/secrets.md")).toBe(
      true,
    );
    expect(resolvesInRepo("docs/operate/secrets-that-moved.md")).toBe(false);
  });

  it("through an elision, and not past a page that moved", () => {
    expect(resolvesInRepo("docs/.../operate/secrets.md")).toBe(true);
    expect(resolvesInRepo("docs/.../operate/secrets-that-moved.md")).toBe(
      false,
    );
    expect(resolvesInRepo("src/.../presence.ts")).toBe(true);
    expect(resolvesInRepo("src/.../presence.tsx")).toBe(false);
  });
});

describe("a token is a path claim", () => {
  it("when it is anchored at a top-level entry of this repo", () => {
    expect(isPathClaim("test/presence.test.ts")).toBe(true);
    expect(isPathClaim("servers/bundle/host/src/presence.ts")).toBe(true);
    expect(isPathClaim(".github/actions/build-push/action.yml")).toBe(true);
    expect(isPathClaim("docs/.../operate/secrets.md")).toBe(true);
  });

  /** The forms the anchor exists to keep out. Each is real, in a real comment. */
  it("and not when it is an MCP method, a role, a scope or a placeholder", () => {
    for (const token of [
      "tools/list",
      "tools/call",
      "resources/list",
      "roles/parametermanager.parameterViewer",
      "roles/secretmanager.viewer",
      "@google-cloud/storage",
      "@modelcontextprotocol/sdk",
      "locations/global",
      "versions/latest",
      "owner/name",
      "tadasant/strad",
      "gcs/static/FOO",
      "ghcr.io/someone-else/strad-bundle",
      "io.modelcontextprotocol/ui",
      "https://strad.tadasant.com/mcp",
      "presence.ts",
    ]) {
      expect(isPathClaim(token)).toBe(false);
    }
  });

  it("and not when it is a glob or a placeholder", () => {
    expect(isPathClaim("docs/**")).toBe(false);
    expect(isPathClaim("servers/**")).toBe(false);
    expect(isPathClaim("servers/<tree>")).toBe(false);
    expect(isPathClaim("src/foo.ts and src/bar.ts")).toBe(false);
  });
});

describe("the comment scan", () => {
  it("reads both comment forms and reports the line each claim is on", () => {
    const source = [
      "/**",
      " * A header naming `test/gone.test.ts`.",
      " */",
      "const x = 1;",
      "// and a line comment naming `src/gone.ts`",
    ].join("\n");
    expect(claimsIn("f.ts", source)).toEqual([
      { file: "f.ts", line: 2, path: "test/gone.test.ts" },
      { file: "f.ts", line: 5, path: "src/gone.ts" },
    ]);
  });

  it("rejoins a backticked path wrapped across two lines", () => {
    const source = [
      "/**",
      " * A page at `docs/src/content/docs/operate/",
      " * gone.md`.",
      " */",
    ].join("\n");
    expect(claimsIn("f.ts", source)).toEqual([
      { file: "f.ts", line: 2, path: "docs/src/content/docs/operate/gone.md" },
    ]);
  });

  it("does not read a string, a template literal, or the // in a URL", () => {
    const source = [
      'const url = "https://example.com/`src/nope.ts`";',
      "const t = `see `test/nope.test.ts` here`;",
      "const s = '// `src/nope.ts`';",
    ].join("\n");
    expect(claimsIn("f.ts", source)).toEqual([]);
  });
});
