/**
 * Which image tag a deploy is allowed to ship, and how to find one.
 *
 * App Platform is handed a tag, not a digest. A MUTABLE tag is therefore a
 * deploy the platform is free to satisfy from whatever it resolved the last
 * time it saw that tag, and there is no way to tell from the spec which image
 * will actually boot.
 *
 * That is not theoretical. A `Deploy staging` dispatch on `main` at 96015c6
 * shipped `ghcr.io/tadasant/strad:latest` and the container booted code from
 * before PR #26: it rejected `infra/strad.staging.yaml` with a "each must serve
 * a distinct path" rule that commit had deleted three weeks earlier. The
 * release path, which ships `:<version>`, had deployed that same commit
 * successfully hours before, and a dispatch pinned to `:0.1.33` brought staging
 * straight back up. The config was never wrong; the mutable tag was.
 *
 * And re-cutting the release does not fix it — issue #38 recorded the same
 * failure on 2026-07-20 and suggested exactly that. release-image.yml ran on
 * main at 96015c6 on 2026-07-30 and its verify step confirmed `:<version>`,
 * `:latest` and `:sha-<sha>` all resolved to ONE digest at push time. Eleven
 * hours later `:latest` was serving pre-#26 code again. Whatever moves that tag
 * is outside this repo — nothing here has written it in between — so this repo
 * cannot make `:latest` trustworthy. It can only stop depending on it.
 *
 * So a deploy ships an IMMUTABLE tag. `sha-<commit>` is published by
 * release-image.yml for every commit it builds and names exactly one commit, so
 * there is no "most recent" for anything to disagree about.
 */
import { execFileSync } from "node:child_process";

/**
 * Tags that name "whatever was pushed most recently" rather than one build.
 *
 * This is a DENYLIST, and deliberately so. An allowlist of known-good shapes
 * (`<semver>`, `sha-…`, `branch-…`) would be stricter, but `render-spec` is
 * shared with prod in tadasant-internal, which renders its own config with its
 * own tag scheme — a shape this repo has never seen is not this repo's to
 * reject. What IS worth rejecting is a tag that exists and MOVES, and `latest`
 * is the only one anything here publishes. A typo'd tag needs no gate: it
 * resolves to nothing and the pull fails loudly.
 *
 * Matched case-insensitively; `parseImage` invents `latest` for a tag-less ref,
 * so `--image ghcr.io/tadasant/strad` is caught here too.
 */
const MUTABLE_TAGS = new Set(["latest", "main", "edge", "stable"]);

export function isMutableTag(tag: string): boolean {
  return MUTABLE_TAGS.has(tag.toLowerCase());
}

/** `sha-<commit>`, the immutable tag release-image.yml publishes per commit. */
export function shaTag(sha: string): string {
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(
      `not a full commit sha: "${sha}". ` +
        `A deploy tag must name one commit exactly.`,
    );
  }
  return `sha-${sha}`;
}

/**
 * Refuse a core image on a mutable tag.
 *
 * This is a DEPLOY-time gate, not a schema rule, and it lives beside the strict
 * config parse for the same reason: `renderAppSpec` shapes specs for tests and
 * for whoever embeds it, and has no business demanding a version number. Every
 * real deploy goes through `scripts/render-spec.ts`, so guarding there covers
 * every spec that ever reaches App Platform.
 */
export function assertImmutableCoreImage(ref: string, tag: string): void {
  if (!isMutableTag(tag)) return;
  throw new Error(
    `--image "${ref}" deploys the mutable tag "${tag}".\n` +
      `App Platform may serve a mutable tag from whatever it resolved last, ` +
      `which boots old code against new config and fails the deploy.\n` +
      `Pass an immutable tag instead: :<version> (e.g. 0.1.38) or ` +
      `:sha-<commit>, both published by release-image.yml.`,
  );
}

/**
 * The paths `release-image.yml` ignores, and therefore the ONLY reason a commit
 * on `main` may legitimately have no image of its own.
 *
 * Keep in step with that workflow's `paths-ignore`.
 */
export function isIgnoredPath(file: string): boolean {
  return file.endsWith(".md") || file.startsWith("docs/");
}

/**
 * Did this commit change only things that cut no image?
 *
 * An EMPTY list is deliberately not docs-only. `every` on an empty array is
 * true, which would silently license a walk-back past a commit we know nothing
 * about — the one thing this predicate exists to prevent.
 */
export function isDocsOnly(files: readonly string[]): boolean {
  return files.length > 0 && files.every(isIgnoredPath);
}

/**
 * `repo` is the checkout to ask; the deploy asks the one it is standing in.
 *
 * `core.quotePath=false` because the default C-quotes a non-ASCII path
 * (`"docs/\303\251.md"`), which `isIgnoredPath` then matches as neither `.md`
 * nor `docs/` — a docs-only commit that reads as code. The larger `maxBuffer` is
 * for `ls-tree -r`, which lists a whole tree where a diff lists one commit's
 * worth of paths; the 1 MB default would `ENOBUFS` on a big root commit.
 */
function git(repo: string | undefined, ...args: string[]): string {
  return execFileSync("git", ["-c", "core.quotePath=false", ...args], {
    encoding: "utf8",
    cwd: repo,
    maxBuffer: 64 * 1024 * 1024,
  });
}

function lines(out: string): string[] {
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/**
 * The commit a diff should be taken against, or `null` when there is none.
 *
 * `git rev-list --parents -n 1 <sha>` prints the commit followed by its parents,
 * which is the walker's view — so a commit grafted by a shallow fetch reports no
 * parents here even though its parent exists upstream. That is the answer we
 * want: `<sha>^1` would fail on exactly these commits.
 */
function firstParent(sha: string, repo?: string): string | null {
  const fields = lines(git(repo, "rev-list", "--parents", "-n", "1", sha))[0];
  return fields?.split(" ")[1] ?? null;
}

/**
 * Does the commit OBJECT record a parent?
 *
 * The graft a shallow fetch applies lives in `.git/shallow`, not in the object,
 * so the raw commit still carries its `parent` headers. This is what tells a
 * true root commit ("there is nothing before me") apart from a shallow boundary
 * ("there is, and this checkout does not have it") — `firstParent` reports null
 * for both.
 */
function recordsParent(sha: string, repo?: string): boolean {
  const header = git(repo, "cat-file", "commit", sha).split("\n\n")[0] ?? "";
  return /^parent /m.test(header);
}

/**
 * Files a commit changed, against its FIRST parent (so merges work).
 *
 * NOT every commit has one, and assuming otherwise broke every staging deploy:
 * `git diff --name-only <root>^1 <root>` is a `fatal: ambiguous argument`, and
 * this repo's root commit sat inside the 50-commit window the resolver reads.
 *
 * A root commit introduced its whole tree, so that tree IS its change. A commit
 * whose parent was simply not fetched is a different thing entirely — nothing
 * here can say what it changed, and guessing in either direction is worse than
 * saying so: "docs-only" would walk the deploy back past an unknown commit, and
 * "code" would report a build failure that never happened.
 */
export function changedFiles(sha: string, repo?: string): string[] {
  const parent = firstParent(sha, repo);
  if (parent) return lines(git(repo, "diff", "--name-only", parent, sha));
  if (recordsParent(sha, repo)) {
    throw new Error(
      `cannot tell what ${sha.slice(0, 12)} changed: its parent is not in ` +
        `this checkout (shallow clone).\n` +
        `Deepen the deploy's \`fetch-depth\`, or dispatch with an explicit ` +
        `\`version\`.`,
    );
  }
  return lines(git(repo, "ls-tree", "-r", "--name-only", sha));
}

export interface Candidate {
  sha: string;
  /**
   * Whether this commit touched only `**\/*.md` and `docs/**`.
   *
   * A thunk, and that is load-bearing rather than a style choice: a commit the
   * walk never reaches must never be classified. The walk stops at the first
   * commit that published an image, which on a healthy `main` is HEAD, so
   * classifying the whole window spends a git process per commit on answers
   * nothing reads — and it lets a question that cannot be answered about some
   * far-back commit fail a deploy that was fine. Classifying all 35 commits on
   * `main` up front did exactly that: it reached the root commit, which has no
   * parent to diff against, and died holding HEAD's image as the answer.
   */
  docsOnly: () => boolean;
}

export interface ResolvedTag {
  /** The tag to deploy, e.g. `sha-96015c6…`. */
  tag: string;
  /** The commit that tag names. */
  sha: string;
  /** How far back from HEAD it was found. 0 is HEAD itself. */
  distance: number;
}

/**
 * The newest commit in `candidates` that actually published an image.
 *
 * `candidates` is first-parent history, newest first.
 *
 * The walk-back exists for ONE reason: `release-image.yml` carries
 * `paths-ignore: ["**\/*.md", "docs/**"]`, and this repo lands docs in the same
 * PR as the code, so a docs-only merge advances `main` without publishing a
 * `sha-` tag. Failing that deploy would punish a commit that has nothing wrong
 * with it, and the newest ancestor that DID publish is the code that should be
 * running anyway.
 *
 * It exists for no other reason, which is why a CODE commit with no image is a
 * hard failure rather than another step back. A missing tag there means the
 * release is still building or has failed — and walking past it would deploy
 * the previous commit's image against THIS commit's config, which is precisely
 * the new-config-meets-old-code outage this module exists to prevent. Better a
 * red deploy that says "wait for the release" than a green one that quietly
 * ships the wrong pair.
 *
 * A `published` that rejects propagates. A registry the deploy cannot read must
 * not look like a registry that is missing a tag — that would silently ship an
 * older image every time GHCR had a bad minute.
 *
 * `docsOnly` is asked ONLY about a commit the registry has already said has no
 * image, and only until the walk stops. On a healthy `main` that is zero calls:
 * HEAD published, and nothing else is classified at all.
 */
export async function resolveDeployTag(
  candidates: readonly Candidate[],
  published: (tag: string) => Promise<boolean>,
): Promise<ResolvedTag> {
  if (candidates.length === 0) {
    throw new Error(
      "no commits to resolve an image tag from. " +
        "Does the checkout have history (fetch-depth)?",
    );
  }

  for (const [distance, candidate] of candidates.entries()) {
    const tag = shaTag(candidate.sha);
    if (await published(tag)) return { tag, sha: candidate.sha, distance };
    if (!candidate.docsOnly()) {
      throw new Error(
        `commit ${candidate.sha.slice(0, 12)} changed code but published no ` +
          `image (${tag}). release-image.yml is probably still building it, ` +
          `or it failed.\n` +
          `Deploying an older image against this commit's config is the skew ` +
          `this check exists to prevent, so this is a hard stop: wait for the ` +
          `release to finish, or dispatch with an explicit \`version\`.`,
      );
    }
  }

  throw new Error(
    `no published image in the last ${candidates.length} commits ` +
      `(${candidates[0]?.sha.slice(0, 12)}…` +
      `${candidates[candidates.length - 1]?.sha.slice(0, 12)}), and all of ` +
      `them are docs-only. Dispatch with an explicit \`version\`.`,
  );
}

export interface RegistryOptions {
  registry: string;
  repository: string;
  token: string;
  fetchImpl?: typeof fetch;
  /** Overridable so tests do not actually sleep. */
  sleep?: (ms: number) => Promise<void>;
}

const ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(",");

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/**
 * A "does this tag exist?" probe against a registry.
 *
 * 404 is "no image for that commit" and is the ONLY negative. A 5xx, a 429, or
 * a network error is retried; anything else (401, 403) is fatal. Treating an
 * unreadable registry as an absent tag would silently walk the deploy back to
 * an older image every time GHCR had a bad minute.
 *
 * 429 is retried rather than fatal because a long walk-back is exactly what
 * provokes it: up to 50 sequential HEADs at one registry.
 */
export function registryProbe(
  opts: RegistryOptions,
): (tag: string) => Promise<boolean> {
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;

  return async function published(tag: string): Promise<boolean> {
    let last = "";
    for (let attempt = 1; attempt <= 3; attempt++) {
      let res: Response;
      try {
        res = await doFetch(
          `https://${opts.registry}/v2/${opts.repository}/manifests/${tag}`,
          {
            method: "HEAD",
            headers: {
              authorization: `Bearer ${opts.token}`,
              accept: ACCEPT,
            },
          },
        );
      } catch (err) {
        last = err instanceof Error ? err.message : String(err);
        if (attempt < 3) await sleep(attempt * 1000);
        continue;
      }
      if (res.status === 404) return false;
      if (res.ok) return true;
      last = `HTTP ${res.status}`;
      if (res.status < 500 && res.status !== 429) break;
      if (attempt < 3) await sleep(attempt * 1000);
    }
    throw new Error(`could not read ${opts.repository}:${tag} (${last})`);
  };
}

/**
 * A pull-scoped bearer token.
 *
 * Retried on the same reasoning as the probe above, and for a stronger one: it
 * is a strictly EARLIER single point of failure, so one transient blip here
 * fails a deploy that had nothing wrong with it.
 */
export async function fetchPullToken(opts: {
  registry: string;
  repository: string;
  actor: string;
  password: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}): Promise<string> {
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const basic = Buffer.from(`${opts.actor}:${opts.password}`).toString(
    "base64",
  );
  let last = "";

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await doFetch(
        `https://${opts.registry}/token?service=${opts.registry}` +
          `&scope=repository:${opts.repository}:pull`,
        { headers: { authorization: `Basic ${basic}` } },
      );
      if (res.ok) {
        const body = (await res.json()) as { token?: string };
        if (body.token) return body.token;
        last = "registry returned no pull token";
      } else {
        last = `HTTP ${res.status}`;
        // 401/403 will not improve on a retry; a bad credential is a bad
        // credential.
        if (res.status < 500 && res.status !== 429) break;
      }
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    if (attempt < 3) await sleep(attempt * 1000);
  }

  throw new Error(`could not obtain a pull token (${last})`);
}
