import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import { parseConfig } from "../src/config/load.ts";
import {
  assertImmutableCoreImage,
  changedFiles,
  fetchPullToken,
  isDocsOnly,
  isMutableTag,
  registryProbe,
  resolveDeployTag,
  shaTag,
  type Candidate,
} from "../src/deploy/imageTag.ts";
import { parseImage } from "../src/deploy/appspec.ts";
import type {
  ServerConfig,
  SupplementaryImageServer,
} from "../src/config/schema.ts";

const isSupplementary = (s: ServerConfig): s is SupplementaryImageServer =>
  s.kind === "supplementary-image";

/**
 * The outage this file exists to prevent.
 *
 * A `Deploy staging` dispatch on main shipped `ghcr.io/tadasant/strad:latest`
 * and the container booted code from before PR #26 — old enough to still carry
 * the "each must serve a distinct path" rule that PR deleted. It rejected the
 * current `infra/strad.staging.yaml` at boot and took staging down, while the
 * same commit deployed on `:0.1.38` (and later `:0.1.33`) came up fine.
 *
 * Two halves, and both are pinned here:
 *
 *   1. THE CONFIG IS VALID. The capability pairs share a path on purpose. If
 *      anyone reintroduces a distinct-path rule, this fails here rather than in
 *      a container at 3am.
 *
 *   2. THE DEPLOY SHIPS AN IMMUTABLE TAG. A mutable tag is an image the spec
 *      does not determine, which is how new config met old code.
 */

const STAGING = new URL("../infra/strad.staging.yaml", import.meta.url);

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);

describe("the staging config the outage rejected", () => {
  it("parses, and keeps the capability pairs on ONE shared path", () => {
    const config = parseConfig(
      readFileSync(STAGING, "utf8"),
      "infra/strad.staging.yaml",
    );

    // The exact shape the stale image refused: two slugs, one bundle, one path,
    // told apart by their tool policy rather than by their route.
    const onSlack = config.servers
      .filter(isSupplementary)
      .filter((s) => s.path === "/slack");
    expect(onSlack.map((s) => s.slug).sort()).toEqual([
      "slack",
      "slack-readonly",
    ]);
    expect(new Set(onSlack.map((s) => s.bundle)).size).toBe(1);
  });

  it("shares a path for every capability pair, not just slack", () => {
    const config = parseConfig(
      readFileSync(STAGING, "utf8"),
      "infra/strad.staging.yaml",
    );
    const byPath = new Map<string, string[]>();
    for (const s of config.servers.filter(isSupplementary)) {
      byPath.set(s.path, [...(byPath.get(s.path) ?? []), s.slug]);
    }
    // If this drops to zero, either the pairs were split onto distinct paths or
    // a distinct-path rule came back. Both are the regression.
    const shared = [...byPath.values()].filter((slugs) => slugs.length > 1);
    expect(shared.length).toBeGreaterThan(0);
  });
});

describe("isMutableTag", () => {
  it("catches the tags that name a moving target", () => {
    for (const tag of ["latest", "main", "edge", "stable"]) {
      expect(isMutableTag(tag)).toBe(true);
    }
  });

  it("is case-insensitive, since a registry tag need not be lowercase", () => {
    expect(isMutableTag("Latest")).toBe(true);
    expect(isMutableTag("LATEST")).toBe(true);
  });

  it("passes a version, a commit tag and a branch tag", () => {
    expect(isMutableTag("0.1.38")).toBe(false);
    expect(isMutableTag(`sha-${A}`)).toBe(false);
    expect(isMutableTag("branch-fix-thing-96015c6638a7")).toBe(false);
  });
});

describe("assertImmutableCoreImage", () => {
  it("refuses the exact ref that took staging down", () => {
    const ref = "ghcr.io/tadasant/strad:latest";
    expect(() => assertImmutableCoreImage(ref, parseImage(ref).tag)).toThrow(
      /mutable tag "latest"/,
    );
  });

  it("refuses a tag-less ref, which parseImage turns into :latest", () => {
    const ref = "ghcr.io/tadasant/strad";
    expect(parseImage(ref).tag).toBe("latest");
    expect(() => assertImmutableCoreImage(ref, parseImage(ref).tag)).toThrow(
      /mutable tag "latest"/,
    );
  });

  it("names the shapes that are allowed instead", () => {
    expect(() =>
      assertImmutableCoreImage("ghcr.io/tadasant/strad:latest", "latest"),
    ).toThrow(/:sha-<commit>/);
  });

  it("allows a version tag and a commit tag", () => {
    const version = "ghcr.io/tadasant/strad:0.1.38";
    expect(() =>
      assertImmutableCoreImage(version, parseImage(version).tag),
    ).not.toThrow();
    const commit = `ghcr.io/tadasant/strad:sha-${A}`;
    expect(() =>
      assertImmutableCoreImage(commit, parseImage(commit).tag),
    ).not.toThrow();
  });
});

describe("shaTag", () => {
  it("builds the tag release-image.yml publishes", () => {
    expect(shaTag(A)).toBe(`sha-${A}`);
  });

  it("refuses anything that is not a full commit sha", () => {
    // An abbreviated sha would build a tag that never resolves, and the deploy
    // would blame a missing image rather than the truncation.
    expect(() => shaTag(A.slice(0, 12))).toThrow(/not a full commit sha/);
    expect(() => shaTag("")).toThrow(/not a full commit sha/);
  });
});

describe("isDocsOnly", () => {
  it("accepts the paths release-image.yml ignores", () => {
    expect(isDocsOnly(["README.md"])).toBe(true);
    expect(isDocsOnly(["docs/src/content/docs/intro.md"])).toBe(true);
    expect(isDocsOnly(["HACKS.md", "docs/astro.config.mjs"])).toBe(true);
  });

  it("rejects a commit that touched any code", () => {
    expect(isDocsOnly(["README.md", "src/index.ts"])).toBe(false);
    expect(isDocsOnly(["infra/strad.staging.yaml"])).toBe(false);
  });

  it("treats an EMPTY list as not docs-only", () => {
    // `every` on an empty array is true, which would license a walk-back past a
    // commit we know nothing about — the one thing this predicate prevents.
    expect(isDocsOnly([])).toBe(false);
  });
});

/**
 * A throwaway repo, driven by real git — the failure this file exists to fix was
 * git's, not a mock's, and a stub of `git diff` would have agreed with the code.
 */
const trash: string[] = [];

function scratchRepo(): {
  dir: string;
  git: (...args: string[]) => string;
  commit: (file: string, message: string) => string;
} {
  const dir = mkdtempSync(join(tmpdir(), "strad-image-tag-"));
  trash.push(dir);
  const git = (...args: string[]): string =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  git("config", "commit.gpgsign", "false");
  const commit = (file: string, message: string): string => {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), `${message}\n`);
    git("add", file);
    git("commit", "-q", "-m", message);
    return git("rev-parse", "HEAD");
  };
  return { dir, git, commit };
}

afterAll(() => {
  for (const dir of trash) rmSync(dir, { recursive: true, force: true });
});

describe("changedFiles", () => {
  it("diffs an ordinary commit against its parent", () => {
    const r = scratchRepo();
    r.commit("README.md", "root");
    const sha = r.commit("app.ts", "code");
    expect(changedFiles(sha, r.dir)).toEqual(["app.ts"]);
  });

  it("diffs a MERGE against its first parent, not its second", () => {
    // On `main` every candidate is a squash or a merge; second-parent files are
    // the PR's internal history and would make every merge look like a code
    // change even when the PR was docs-only.
    const r = scratchRepo();
    r.commit("README.md", "root");
    r.commit("app.ts", "base");
    r.git("checkout", "-q", "-b", "side");
    r.commit("docs/page.md", "docs on a branch");
    r.git("checkout", "-q", "main");
    r.commit("other.ts", "main moved on");
    r.git("merge", "-q", "--no-ff", "-m", "merge side", "side");
    const merge = r.git("rev-parse", "HEAD");
    expect(changedFiles(merge, r.dir)).toEqual(["docs/page.md"]);
  });

  it("reads the ROOT commit's whole tree instead of dying on `<sha>^1`", () => {
    // The exact failure that blocked every staging deploy:
    //   fatal: ambiguous argument '0c824d8…^1': unknown revision
    // A root commit introduced its entire tree, so that tree IS its change.
    const r = scratchRepo();
    const root = r.commit("README.md", "root");
    expect(() =>
      execFileSync("git", ["diff", "--name-only", `${root}^1`, root], {
        cwd: r.dir,
        stdio: "pipe",
      }),
    ).toThrow();
    expect(changedFiles(root, r.dir)).toEqual(["README.md"]);
  });

  it("classifies strad's own root commit as docs-only", () => {
    // `main`'s root added README.md and nothing else, so the resolver may step
    // over it — the walk-back's rule, applied to the commit that broke it.
    const r = scratchRepo();
    const root = r.commit("README.md", "root");
    expect(isDocsOnly(changedFiles(root, r.dir))).toBe(true);
  });

  it("REFUSES to guess when the parent was not fetched (shallow clone)", () => {
    // `fetch-depth: N` grafts the Nth commit to look parentless. It is not a
    // root: its parent exists, this checkout just does not have it. Calling that
    // docs-only would walk the deploy past a commit nothing can vouch for.
    const r = scratchRepo();
    r.commit("README.md", "root");
    r.commit("app.ts", "code");
    const dest = mkdtempSync(join(tmpdir(), "strad-image-tag-shallow-"));
    trash.push(dest);
    const clone = join(dest, "shallow");
    execFileSync(
      "git",
      ["clone", "-q", "--depth", "1", `file://${r.dir}`, clone],
      {
        stdio: "pipe",
      },
    );
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: clone,
      encoding: "utf8",
    }).trim();
    expect(() => changedFiles(head, clone)).toThrow(
      /parent is not in this checkout \(shallow clone\)[\s\S]*fetch-depth/,
    );
  });

  it("tells a SIGNED shallow boundary from a root, despite the gpgsig header", () => {
    // The boundary of a `fetch-depth: 50` checkout of `main` is a GitHub merge
    // or squash commit, and those are signed. Root-vs-shallow is decided by
    // reading the raw commit object, so the multi-line `gpgsig` header — armor
    // blank line and all — sits between the parse and the `parent` line it
    // looks for. Git space-prefixes every continuation line, including the
    // blank one, so the header block survives; nothing else in the suite proves
    // it, because scratch repos commit unsigned.
    const r = scratchRepo();
    r.commit("README.md", "root");
    r.commit("src/app.ts", "code");
    const tree = r.git("rev-parse", "HEAD^{tree}");
    const parent = r.git("rev-parse", "HEAD~1");
    const who = "test <test@example.com> 1700000000 +0000";
    const signed = execFileSync(
      "git",
      ["hash-object", "-t", "commit", "-w", "--stdin"],
      {
        cwd: r.dir,
        encoding: "utf8",
        input:
          `tree ${tree}\nparent ${parent}\nauthor ${who}\ncommitter ${who}\n` +
          "gpgsig -----BEGIN PGP SIGNATURE-----\n" +
          " \n" + // the armor's blank line, as git stores it
          " iQIzBAABCgAdFiEEfake\n" +
          " -----END PGP SIGNATURE-----\n" +
          "\nsigned merge\n",
      },
    ).trim();
    r.git("update-ref", "refs/heads/main", signed);

    const dest = mkdtempSync(join(tmpdir(), "strad-image-tag-signed-"));
    trash.push(dest);
    const clone = join(dest, "shallow");
    execFileSync(
      "git",
      ["clone", "-q", "--depth", "1", `file://${r.dir}`, clone],
      { stdio: "pipe" },
    );
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: clone,
      encoding: "utf8",
    }).trim();
    expect(head).toBe(signed);
    // Not "a root commit whose tree is src/app.ts" — a boundary it cannot read.
    expect(() => changedFiles(head, clone)).toThrow(
      /parent is not in this checkout \(shallow clone\)/,
    );
  });

  it("does NOT let a root commit that carries CODE be stepped over", () => {
    // The asymmetric half of the root-commit case. strad's own root added only
    // README.md, so the docs-only test above would pass even if the tree were
    // ignored entirely; this is what proves it is read.
    const r = scratchRepo();
    const root = r.commit("src/index.ts", "root with code");
    expect(changedFiles(root, r.dir)).toEqual(["src/index.ts"]);
    expect(isDocsOnly(changedFiles(root, r.dir))).toBe(false);
  });
});

const SCRIPT = fileURLToPath(
  new URL("../scripts/resolve-image-tag.ts", import.meta.url),
);
const REGISTRY_STUB = new URL("./fixtures/registry-stub.mjs", import.meta.url)
  .href;

/** Run the real script in `repo`, with only the registry stubbed. */
function runResolver(
  repo: string,
  publishedTag: string,
): { status: number; stdout: string; stderr: string } {
  const shas = execFileSync(
    "git",
    ["log", "--first-parent", "--format=%H", "-n", "50"],
    { cwd: repo, encoding: "utf8" },
  );
  const run = spawnSync(
    process.execPath,
    [
      "--experimental-transform-types",
      "--import",
      REGISTRY_STUB,
      SCRIPT,
      "--repository",
      "tadasant/strad",
    ],
    {
      cwd: repo,
      input: shas,
      encoding: "utf8",
      env: {
        ...process.env,
        GHCR_PULL_TOKEN: "stub",
        STRAD_TEST_PUBLISHED_TAG: publishedTag,
      },
    },
  );
  return { status: run.status ?? -1, stdout: run.stdout, stderr: run.stderr };
}

describe("scripts/resolve-image-tag.ts", () => {
  it("resolves HEAD's image over a window that CONTAINS the root commit", () => {
    // The deploy failure, end to end: this window holds a root commit, and the
    // script must never ask what it changed, because HEAD published and the walk
    // stops there. Classifying up front made this exact shape a `fatal`.
    const r = scratchRepo();
    r.commit("README.md", "root");
    const head = r.commit("src/app.ts", "code");
    const out = runResolver(r.dir, `sha-${head}`);
    expect(out.stderr).not.toMatch(/fatal|ambiguous argument/);
    expect(out.status).toBe(0);
    // stdout is $GITHUB_OUTPUT and must carry nothing else.
    expect(out.stdout).toBe(
      [
        `image=ghcr.io/tadasant/strad:sha-${head}`,
        `tag=sha-${head}`,
        `sha=${head}`,
        "distance=0",
        "",
      ].join("\n"),
    );
    expect(out.stderr).toContain("Deploying the image built for HEAD");
  });

  it("deploys HEAD even when the window's far end is an unreadable boundary", () => {
    // Where laziness is not an optimisation but the fix. `fetch-depth: 50`
    // grafts the far commit, and asking what IT changed is unanswerable — so a
    // pass that classifies the whole window fails a deploy whose answer (HEAD's
    // own image) was in hand. This is the shape `main` takes once it passes 50
    // first-parent commits, so it outlives the root commit that exposed it.
    const r = scratchRepo();
    r.commit("README.md", "root");
    r.commit("src/one.ts", "one");
    const head = r.commit("src/two.ts", "two");
    const dest = mkdtempSync(join(tmpdir(), "strad-image-tag-window-"));
    trash.push(dest);
    const clone = join(dest, "shallow");
    execFileSync(
      "git",
      ["clone", "-q", "--depth", "2", `file://${r.dir}`, clone],
      { stdio: "pipe" },
    );
    const out = runResolver(clone, `sha-${head}`);
    expect(out.stderr).not.toMatch(/shallow clone|fatal/);
    expect(out.status).toBe(0);
    expect(out.stdout).toContain(`image=ghcr.io/tadasant/strad:sha-${head}`);
  });

  it("classifies the root commit rather than dying on it, when the walk gets there", () => {
    const r = scratchRepo();
    r.commit("README.md", "root");
    r.commit("docs/page.md", "docs");
    const out = runResolver(r.dir, "sha-nothing-is-published");
    expect(out.status).toBe(1);
    expect(out.stderr).not.toMatch(/fatal|ambiguous argument/);
    expect(out.stderr).toMatch(
      /no published image in the last 2 commits[\s\S]*all of them are docs-only/,
    );
  });
});

/**
 * Newest-first candidates. `docsOnly` is a spy, because WHETHER it is called is
 * as load-bearing as what it answers — see the laziness test below.
 */
const docs = (sha: string): Candidate => ({ sha, docsOnly: vi.fn(() => true) });
const code = (sha: string): Candidate => ({
  sha,
  docsOnly: vi.fn(() => false),
});

describe("resolveDeployTag", () => {
  it("takes HEAD when HEAD published an image", async () => {
    const published = vi.fn().mockResolvedValue(true);
    await expect(
      resolveDeployTag([code(A), code(B), code(C)], published),
    ).resolves.toEqual({ tag: `sha-${A}`, sha: A, distance: 0 });
    expect(published).toHaveBeenCalledTimes(1);
  });

  it("classifies NOTHING when HEAD published — the outage this fixes", async () => {
    // Every staging deploy died here. The caller classified all 35 commits on
    // `main` up front, one of them the root commit, and `git diff <root>^1
    // <root>` is a fatal — so the step failed while holding the answer, which
    // was HEAD's own image. A commit the walk never reaches must never be asked
    // about at all.
    const published = vi.fn().mockResolvedValue(true);
    const candidates = [code(A), code(B), code(C)];
    await expect(resolveDeployTag(candidates, published)).resolves.toEqual({
      tag: `sha-${A}`,
      sha: A,
      distance: 0,
    });
    for (const c of candidates) expect(c.docsOnly).not.toHaveBeenCalled();
  });

  it("asks only about commits the registry has no image for", async () => {
    const published = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const candidates = [docs(A), docs(B), docs(C)];
    await resolveDeployTag(candidates, published);
    // A: probed, absent, so classified. B: probed and found. C: untouched.
    expect(candidates[0]!.docsOnly).toHaveBeenCalledTimes(1);
    expect(candidates[1]!.docsOnly).not.toHaveBeenCalled();
    expect(candidates[2]!.docsOnly).not.toHaveBeenCalled();
  });

  it("propagates a classification error rather than guessing", async () => {
    // `changedFiles` throws when a commit's parent is not in the checkout. That
    // is unknowable, not docs-only: swallowing it would walk the deploy back
    // past a commit nothing can vouch for.
    const published = vi.fn().mockResolvedValue(false);
    const unknowable: Candidate = {
      sha: A,
      docsOnly: () => {
        throw new Error("its parent is not in this checkout (shallow clone)");
      },
    };
    await expect(
      resolveDeployTag([unknowable, docs(B)], published),
    ).rejects.toThrow(/parent is not in this checkout/);
    expect(published).toHaveBeenCalledTimes(1);
  });

  it("walks back past DOCS-ONLY commits, which cut no image by design", async () => {
    const published = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    await expect(
      resolveDeployTag([docs(A), docs(B), code(C)], published),
    ).resolves.toEqual({ tag: `sha-${C}`, sha: C, distance: 2 });
  });

  it("HARD STOPS on a code commit with no image, rather than walking back", async () => {
    // The regression that would reintroduce the outage: merge a code PR, then
    // deploy while release-image.yml is still building. Walking back would ship
    // the PREVIOUS commit's image against THIS commit's config — new config
    // meeting old code, exactly what this module exists to prevent.
    const published = vi
      .fn()
      .mockResolvedValueOnce(false) // HEAD: code, not built yet
      .mockResolvedValueOnce(true); // its parent: would have been used
    await expect(
      resolveDeployTag([code(A), code(B)], published),
    ).rejects.toThrow(/changed code but published no image/);
    // It must not have even asked about the parent.
    expect(published).toHaveBeenCalledTimes(1);
  });

  it("says what to do about the hard stop", async () => {
    const published = vi.fn().mockResolvedValue(false);
    await expect(resolveDeployTag([code(A)], published)).rejects.toThrow(
      /still building it, or it failed[\s\S]*explicit `version`/,
    );
  });

  it("throws when every commit in range is docs-only and none published", async () => {
    const published = vi.fn().mockResolvedValue(false);
    await expect(
      resolveDeployTag([docs(A), docs(B)], published),
    ).rejects.toThrow(/no published image in the last 2 commits/);
  });

  it("throws on an empty history rather than inventing a tag", async () => {
    const published = vi.fn().mockResolvedValue(true);
    await expect(resolveDeployTag([], published)).rejects.toThrow(
      /no commits to resolve an image tag from/,
    );
    expect(published).not.toHaveBeenCalled();
  });

  it("propagates a registry error instead of walking back past it", async () => {
    // An unreadable registry must not look like a missing tag: that would
    // silently ship an older image every time GHCR had a bad minute.
    const published = vi.fn().mockRejectedValue(new Error("HTTP 503"));
    await expect(
      resolveDeployTag([docs(A), docs(B)], published),
    ).rejects.toThrow(/HTTP 503/);
    expect(published).toHaveBeenCalledTimes(1);
  });
});

/** A probe wired to a scripted fetch, with sleeps stubbed out. */
function probe(responses: (Response | Error)[]) {
  const calls = { n: 0 };
  const fetchImpl = vi.fn(async () => {
    const next = responses[calls.n++] ?? responses[responses.length - 1];
    if (next instanceof Error) throw next;
    return next as Response;
  });
  return {
    calls,
    fetchImpl,
    published: registryProbe({
      registry: "ghcr.io",
      repository: "tadasant/strad",
      token: "t",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async () => {},
    }),
  };
}

const res = (status: number): Response =>
  ({ status, ok: status >= 200 && status < 300 }) as Response;

describe("registryProbe", () => {
  it("reports a published tag", async () => {
    const p = probe([res(200)]);
    await expect(p.published("sha-x")).resolves.toBe(true);
    expect(p.calls.n).toBe(1);
  });

  it("reports 404 as absent — the ONLY negative", async () => {
    const p = probe([res(404)]);
    await expect(p.published("sha-x")).resolves.toBe(false);
    expect(p.calls.n).toBe(1);
  });

  it("does NOT treat 403 as absent, and does not retry it", async () => {
    // A revoked credential must fail the deploy, not silently walk it back to
    // an older image.
    const p = probe([res(403)]);
    await expect(p.published("sha-x")).rejects.toThrow(/HTTP 403/);
    expect(p.calls.n).toBe(1);
  });

  it("retries a 5xx and succeeds", async () => {
    const p = probe([res(503), res(200)]);
    await expect(p.published("sha-x")).resolves.toBe(true);
    expect(p.calls.n).toBe(2);
  });

  it("retries a 429 rather than failing — a long walk-back provokes it", async () => {
    const p = probe([res(429), res(429), res(404)]);
    await expect(p.published("sha-x")).resolves.toBe(false);
    expect(p.calls.n).toBe(3);
  });

  it("retries a network error, then gives up with the reason", async () => {
    const p = probe([new Error("fetch failed")]);
    await expect(p.published("sha-x")).rejects.toThrow(/fetch failed/);
    expect(p.calls.n).toBe(3);
  });
});

describe("fetchPullToken", () => {
  const base = {
    registry: "ghcr.io",
    repository: "tadasant/strad",
    actor: "a",
    password: "p",
    sleep: async () => {},
  };

  it("returns the token", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ token: "tok" }),
    }));
    await expect(
      fetchPullToken({
        ...base,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).resolves.toBe("tok");
  });

  it("retries a transient failure — it is an EARLIER single point of failure", async () => {
    let n = 0;
    const fetchImpl = vi.fn(async () => {
      if (++n === 1) throw new Error("fetch failed");
      return {
        ok: true,
        status: 200,
        json: async () => ({ token: "tok" }),
      };
    });
    await expect(
      fetchPullToken({
        ...base,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).resolves.toBe("tok");
    expect(n).toBe(2);
  });

  it("does not retry a bad credential", async () => {
    let n = 0;
    const fetchImpl = vi.fn(async () => {
      n++;
      return { ok: false, status: 401, json: async () => ({}) };
    });
    await expect(
      fetchPullToken({
        ...base,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/HTTP 401/);
    expect(n).toBe(1);
  });
});
