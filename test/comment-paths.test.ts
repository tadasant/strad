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
 * Several forms are READ rather than reported, because each is a convention this
 * repo really uses and an allowlist of instances would go stale the moment one
 * more was written. Reading a form still checks it; an allowlist would exempt it:
 *
 * - **Elision.** A `...` segment stands for zero or more segments, so
 *   `docs/.../operate/secrets.md` — the form CLAUDE.md and HACKS.md use
 *   throughout — resolves. It still has to resolve to SOMETHING: elide the path
 *   to a page that does not exist and this is red.
 * - **The doc-site route.** `docs/operate/secrets.md` is how the console and the
 *   renderer refer to a page whose file is
 *   `docs/src/content/docs/operate/secrets.md`. That is the route the Starlight
 *   site serves, it is the stable name, and it is what a human types — and the
 *   route it really serves has no extension at all, so `docs/operate/secrets`
 *   is the same page and resolves too. Because the form is resolved rather than
 *   allowlisted, renaming the page still reddens every comment that names it.
 * - **A place inside a file.** A trailing `:174` line reference and a `#heading`
 *   fragment are stripped before resolving. Both point INTO a file without
 *   changing which file is claimed, and both are ordinary — issue #279 names
 *   `src/ui/resolve.ts:174` in exactly that form.
 *
 * A token carrying `*`, `<`, `>`, `?` or whitespace is a pattern or a
 * placeholder — `docs/**`, `servers/<tree>` — not a claim about a file, and is
 * not a candidate. Neither is one with a `.` or `..` segment, which would walk
 * out of the repo and so is not a repo-relative path at all.
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

/**
 * Does this path name something in the repo, under any accepted form?
 *
 * A `:174` line reference and a `#heading` fragment are stripped first. Both are
 * ordinary ways to point at a place IN a file — issue #279 names
 * `src/ui/resolve.ts:174` in exactly that form — and neither changes which file
 * is being claimed.
 *
 * The doc-site route is tried with the page's extension supplied, because the
 * route Starlight actually serves has none: `docs/operate/secrets` and
 * `docs/operate/secrets.md` are the same page, and a guard that took only the
 * second would redden the first for spelling the route correctly.
 */
function resolvesInRepo(path: string): boolean {
  const bare = path.replace(/#.*$/, "").replace(/:\d+(?::\d+)?$/, "");
  const segments = bare.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0) return false;
  // `.` and `..` would walk out of the repo, which is not a repo-relative path.
  if (segments.some((segment) => segment === "." || segment === ".."))
    return false;
  const forms = [segments];
  if (segments[0] === "docs" && segments.length > 1) {
    const route = [...DOC_SITE_ROOT, ...segments.slice(1)];
    const last = route[route.length - 1] ?? "";
    forms.push(route);
    if (!/\.[a-z]+$/.test(last)) {
      for (const suffix of [".md", ".mdx", "/index.md", "/index.mdx"]) {
        forms.push([...route.slice(0, -1), ...`${last}${suffix}`.split("/")]);
      }
    }
  }
  return forms.some((form) => resolveFrom("", form));
}

/** Is this backticked token a claim about a file, rather than prose? */
function isPathClaim(token: string): boolean {
  if (!token.includes("/")) return false;
  if (/[*<>?\s]/.test(token)) return false;
  return ROOTS.has(token.split("/")[0] ?? "");
}

/**
 * The comments in a source file, each with the line its text starts on.
 *
 * Read a line at a time, and this is the load-bearing property rather than a
 * simplification: quote state is dropped at every newline, so a `"` inside a
 * regex literal — `/["\\{}[\]]/` is a real one in
 * `src/secrets/parameters/wire.ts` — costs the rest of THAT LINE and nothing
 * more. A whole-file scanner that tracked strings without also tracking regexes
 * read that `"` as opening a string, ran to the next one hundreds of lines away,
 * and silently swallowed every comment in between. A guard that fails open is
 * worse than no guard, so the scan is built to be unable to fail that way: the
 * only state crossing a line boundary is whether a block comment is open, and
 * that is anchored on `/*` and `*` + `/` rather than on a quote.
 *
 * Consecutive `//` lines are one comment, so a claim wrapped across two of them
 * rejoins exactly as it does inside a block comment.
 */
function commentsOf(source: string): { line: number; text: string }[] {
  const found: { line: number; text: string }[] = [];
  let open: { line: number; text: string } | null = null;
  let lastLineComment = -1;
  const flush = () => {
    if (open) found.push(open);
    open = null;
  };
  source.split("\n").forEach((raw, index) => {
    const line = index + 1;
    let rest = raw;
    if (open) {
      const end = rest.indexOf("*/");
      if (end === -1) {
        open.text += `\n${rest}`;
        return;
      }
      open.text += `\n${rest.slice(0, end)}`;
      flush();
      rest = rest.slice(end + 2);
    }
    let quote = "";
    let i = 0;
    while (i < rest.length) {
      const c = rest[i];
      if (quote !== "") {
        if (c === "\\") i += 2;
        else {
          if (c === quote) quote = "";
          i++;
        }
        continue;
      }
      if (c === '"' || c === "'" || c === "`") {
        quote = c;
        i++;
        continue;
      }
      if (c === "/" && rest[i + 1] === "/") {
        const text = rest.slice(i + 2);
        const previous = found[lastLineComment];
        if (previous !== undefined && lastLineComment === found.length - 1) {
          previous.text += `\n${text}`;
        } else {
          found.push({ line, text });
          lastLineComment = found.length - 1;
        }
        return;
      }
      if (c === "/" && rest[i + 1] === "*") {
        const end = rest.indexOf("*/", i + 2);
        if (end === -1) {
          open = { line, text: rest.slice(i + 2) };
          return;
        }
        found.push({ line, text: rest.slice(i + 2, end) });
        i = end + 2;
        continue;
      }
      i++;
    }
  });
  flush();
  return found;
}

/**
 * Every path claim in a file, with the line each one is written on.
 *
 * A backticked span may WRAP. Prettier does not reflow a comment, so a long path
 * gets broken by hand across two lines, and a scan that required the span to sit
 * on one line would skip exactly the longest names — the ones most worth
 * checking. A hand-broken path breaks at a `/`, so ONLY a newline that follows
 * one is closed up; any other newline survives into the token, where the
 * whitespace rule rejects it. That is what keeps a fenced list of two files in a
 * doc comment from fusing into one nonexistent path.
 */
function claimsIn(file: string, source: string): Claim[] {
  const claims: Claim[] = [];
  for (const comment of commentsOf(source)) {
    for (const match of comment.text.matchAll(/`([^`]+)`/g)) {
      const token = (match[1] ?? "")
        .replace(/\/[ \t]*\n[ \t]*\*?[ \t]*/g, "/")
        .trim();
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

/** CRLF is normalised on read so a Windows checkout scans identically to CI. */
function claimsUnder(tree: string): Claim[] {
  return sourceFiles(tree).flatMap((file) =>
    claimsIn(file, readFileSync(file, "utf8").replace(/\r\n/g, "\n")),
  );
}

const BY_TREE: ReadonlyMap<string, readonly Claim[]> = new Map(
  TREES.map((tree) => [tree, claimsUnder(tree)]),
);

const CLAIMS: readonly Claim[] = TREES.flatMap(
  (tree) => BY_TREE.get(tree) ?? [],
);

describe("every repo-relative path a comment names", () => {
  it("resolves", () => {
    const broken = CLAIMS.filter((claim) => !resolvesInRepo(claim.path)).map(
      (claim) => `${claim.file}:${claim.line}  ${claim.path}`,
    );
    expect(broken).toEqual([]);
  });

  /**
   * A scan that found nothing would pass this file forever, and a scan that
   * silently lost HALF the corpus would too. These are the claims the walk has to
   * still be seeing — the first of them being the header both #178 and #252 got
   * wrong, and the second written 200 lines past a regex literal carrying a `"`,
   * which is what a scanner desync eats first.
   */
  it("is actually being found", () => {
    const seen = CLAIMS.map((claim) => `${claim.file} → ${claim.path}`);
    expect(seen).toContain(
      "src/secrets/presence.ts → test/presence.route.test.ts",
    );
    expect(seen).toContain(
      "src/deploy/imageTag.ts → .github/actions/build-push/action.yml",
    );
    expect(seen).toContain("src/config/schema.ts → scripts/render-spec.ts");
    expect(seen).toContain(
      "src/secrets/parameters/wire.ts → servers/secrets/shared/src/parameter-wire.ts",
    );
  });

  /**
   * Floors, not exact counts: a claim comes and goes with ordinary editing, but
   * a tree dropping to a fraction of its real total is a scanner that stopped
   * reading rather than a repo that stopped claiming. The real numbers when this
   * was written were 69, 7 and 76.
   */
  it("in a quantity that says the scan is still reading", () => {
    const floors: Record<string, number> = { src: 55, scripts: 5, test: 55 };
    const counted = TREES.map(
      (tree) => `${tree}: ${(BY_TREE.get(tree) ?? []).length}`,
    );
    const thin = TREES.filter(
      (tree) => (BY_TREE.get(tree) ?? []).length < (floors[tree] ?? 1),
    );
    expect({ thin, counted }).toEqual({ thin: [], counted });
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

  it("past a line reference and a heading fragment", () => {
    expect(resolvesInRepo("src/ui/resolve.ts:174")).toBe(true);
    expect(resolvesInRepo("src/ui/resolve.ts:174:12")).toBe(true);
    expect(resolvesInRepo("src/ui/resolev.ts:174")).toBe(false);
    expect(resolvesInRepo("docs/operate/secrets.md#the-resolver")).toBe(true);
    expect(resolvesInRepo("docs/operate/no-page.md#the-resolver")).toBe(false);
  });

  /** The route Starlight serves has no extension. Both spellings are one page. */
  it("for the extensionless doc-site route", () => {
    expect(resolvesInRepo("docs/operate/secrets")).toBe(true);
    expect(resolvesInRepo("docs/operate/secrets/")).toBe(true);
    expect(resolvesInRepo("docs/operate/no-page")).toBe(false);
  });

  it("never by walking out of the repo", () => {
    expect(resolvesInRepo("src/../src/secrets/presence.ts")).toBe(false);
    expect(resolvesInRepo("src/./secrets/presence.ts")).toBe(false);
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

  /**
   * The desync that made a whole-file scanner fail open. Quote state is dropped
   * at every newline, so the `"` inside the regex costs its own line and nothing
   * after it.
   */
  it("keeps reading past a regex literal that carries a quote", () => {
    const source = [
      'const RENDER_UNSAFE = /["\\{}[\\]]/;',
      "// A claim written after it, naming `src/gone.ts`.",
    ].join("\n");
    expect(claimsIn("f.ts", source)).toEqual([
      { file: "f.ts", line: 2, path: "src/gone.ts" },
    ]);
  });

  it("rejoins a wrap across two // lines, and fuses nothing else", () => {
    const wrapped = [
      "// A page at `docs/src/content/docs/operate/",
      "// gone.md`.",
    ].join("\n");
    expect(claimsIn("f.ts", wrapped)).toEqual([
      { file: "f.ts", line: 1, path: "docs/src/content/docs/operate/gone.md" },
    ]);

    // Two paths listed one per line are two tokens, not one fused non-path.
    const listed = [
      "/**",
      " * `src/deploy/appspec.ts",
      " * src/deploy/preflight.ts`",
      " */",
    ].join("\n");
    expect(claimsIn("f.ts", listed)).toEqual([]);
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
