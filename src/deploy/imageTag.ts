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
 *
 * ## Two images, and the second one proved the first one's point
 *
 * The rule above was written for the CORE image and applied only there. The
 * BUNDLE kept `ghcr.io/tadasant/strad-bundle:latest`, written into the config on
 * every `supplementary-image` entry, and on 2026-07-31 staging was running a
 * bundle image that predated PR #33 (2026-07-24): 14 mounts, no `/secrets`, and
 * `/remote-filesystem` under the slug it had been renamed away from.
 * `release-bundle-image.yml` had pushed a fresh `:latest` at 16:33 that day and
 * the containers restarted at 16:42 — and still came up on the old digest. App
 * Platform had resolved that tag once and kept the answer, because the spec's
 * image block for those components was byte-identical on every deploy.
 *
 * The symptom was silence: core POSTed `initialize` to `/secrets`, Express
 * answered 404, and the gateway turned an unreachable upstream into
 * `200 {"tools":[]}`. So this module resolves a `sha-<commit>` tag for BOTH
 * images, and `mutableImageComponents` lets the deploy refuse a spec that ships
 * a mutable one on any component at all.
 *
 * The two images differ in ONE way, and it is the walk-back rule.
 * `release-image.yml` builds every commit except docs-only ones, so a core
 * commit with no image is a hard stop. `release-bundle-image.yml` is
 * `paths:`-filtered to what the image is assembled from, so MOST commits
 * legitimately cut no bundle image and walking past them is the normal case.
 * That difference is the whole of `ImageSource`.
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
 * A component of a rendered spec, as far as this module cares.
 *
 * Structural rather than the `AppSpec` type from appspec.ts: this file is about
 * tags, and depending on the whole spec shape to read one string would couple
 * the deploy gate to a type it has no other use for.
 */
export interface ImageComponent {
  name: string;
  image?: { registry?: string; repository: string; tag?: string };
}

/** A component whose spec ships a tag that moves, and the image it names. */
export interface MutableImage {
  component: string;
  /** `owner/name:tag`, as App Platform shows it — enough to go look it up. */
  ref: string;
  tag: string;
}

/**
 * Every component in a rendered spec that ships a mutable tag.
 *
 * `assertImmutableCoreImage` guards the ONE image the deploy passes as an
 * argument. This guards the rest — the `supplementary-image` entries, whose tag
 * comes from the config rather than the command line, and which is where the
 * bundle spent a week serving a digest App Platform had cached before the
 * `/secrets` mount existed.
 *
 * It reports rather than throws because the answer is not the same everywhere.
 * A deploy that OWNS the images it ships (this repo's staging deploy, which
 * resolves a `sha-` tag for both) should refuse a mutable one outright. A deploy
 * that consumes someone else's config — prod renders through this same script
 * from tadasant-internal — cannot be made to fail on a tag it has no way to
 * change yet. So `scripts/render-spec.ts` warns on this list always and fails on
 * it under `--require-immutable-images`, and the caller picks.
 *
 * A missing tag reads as `latest`, exactly as `parseImage` and every registry
 * treat it: an omitted tag is the mutable one, not an unknown one.
 */
export function mutableImageComponents(
  services: readonly ImageComponent[],
): MutableImage[] {
  const found: MutableImage[] = [];
  for (const service of services) {
    if (!service.image) continue;
    const tag = service.image.tag ?? "latest";
    if (!isMutableTag(tag)) continue;
    const owner = service.image.registry ? `${service.image.registry}/` : "";
    found.push({
      component: service.name,
      ref: `${owner}${service.image.repository}:${tag}`,
      tag,
    });
  }
  return found;
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

/** Where the bundle image's `paths:` filter is written down. */
export const BUNDLE_RELEASE_WORKFLOW =
  ".github/workflows/release-bundle-image.yml";

/**
 * The `paths:` filter a release workflow triggers on, read from the workflow.
 *
 * READ, not copied. `release-bundle-image.yml`'s list is already the answer to
 * "which commits cut a bundle image", and a second copy here would be a list
 * that drifts — which is the exact failure `test/bundle-release-paths.test.ts`
 * exists to catch one file over. A tree added to that workflow and not to this
 * predicate would make the resolver walk PAST the commit that built the image
 * it wanted.
 *
 * Deliberately a text parse, not a YAML one: this repo does not depend on a YAML
 * parser for workflows anywhere else, and the shape being read is three lines
 * long. It fails loudly on anything it does not recognise rather than returning
 * a short list, because a short list here silently deploys an older image.
 */
export function parsePathsFilter(workflow: string, source: string): string[] {
  const lines = workflow.split("\n");
  const start = lines.findIndex((line) => /^\s*paths:\s*$/.test(line));
  if (start === -1) {
    throw new Error(`${source} has no \`paths:\` filter to read`);
  }

  const paths: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "" || /^\s*#/.test(line)) continue;
    // Strip a trailing comment BEFORE deciding whether the line is a list item.
    // `- "servers/secrets/**" # keep in step with the Dockerfile` is a perfectly
    // ordinary thing to write, and reading it as "the block ended here" would
    // drop every entry below it — a short list, which is the one outcome the
    // doc comment above promises this cannot produce.
    const body = line.replace(/\s+#.*$/, "");
    if (!/^\s*-/.test(body)) break; // the next key ends the block
    const entry = /^\s*-\s*(?:"([^"]+)"|'([^']+)'|(\S+))\s*$/.exec(body);
    if (!entry) {
      throw new Error(
        `${source}: cannot read \`paths:\` entry ${JSON.stringify(line.trim())}. ` +
          `A list item this parser cannot read must stop the deploy — treating ` +
          `it as the end of the block would silently shorten the filter.`,
      );
    }
    paths.push((entry[1] ?? entry[2] ?? entry[3])!);
  }

  if (paths.length === 0) {
    throw new Error(`${source}'s \`paths:\` filter parsed to nothing`);
  }
  return paths;
}

/**
 * Does one file match one `paths:` pattern?
 *
 * Only the two shapes that workflow actually uses — `dir/**` and a literal path
 * — and an UNSUPPORTED pattern throws rather than returning false. GitHub's
 * filter syntax is larger than this (`**\/*.md`, `!negation`, `?`), and a
 * pattern this cannot evaluate must stop the deploy: quietly reading it as "no
 * match" would classify a commit that DID publish an image as one that could
 * not have, and walk the deploy back onto an older bundle.
 */
export function matchesPathFilter(file: string, pattern: string): boolean {
  // Checked FIRST, because `!dir/**` ends with `/**` and would otherwise take
  // the prefix branch and quietly match nothing — inverting the filter's meaning
  // for every file, which reads as "no commit could have published an image".
  if (!pattern.startsWith("!")) {
    if (pattern.endsWith("/**")) return file.startsWith(pattern.slice(0, -2));
    if (!pattern.includes("*")) return file === pattern;
  }
  throw new Error(
    `unsupported \`paths:\` pattern "${pattern}". ` +
      `matchesPathFilter understands "dir/**" and literal paths only; ` +
      `teach it the new shape rather than letting it guess.`,
  );
}

/**
 * Did this commit touch nothing the given `paths:` filter watches — and so
 * legitimately publish no image?
 *
 * The empty-list guard is the same one `isDocsOnly` carries and for the same
 * reason: a commit whose changed files could not be determined must not read as
 * "of course it has no image", which would walk the deploy past a commit we
 * know nothing about.
 */
export function isOutsidePathFilter(
  files: readonly string[],
  patterns: readonly string[],
): boolean {
  return (
    files.length > 0 &&
    !files.some((file) =>
      patterns.some((pattern) => matchesPathFilter(file, pattern)),
    )
  );
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
export function changedFiles(
  sha: string,
  repo?: string,
  source: ImageSource = CORE_IMAGE_SOURCE,
): string[] {
  const parent = firstParent(sha, repo);
  if (parent) return lines(git(repo, "diff", "--name-only", parent, sha));
  if (recordsParent(sha, repo)) {
    throw new Error(
      `cannot tell what ${sha.slice(0, 12)} changed: its parent is not in ` +
        `this checkout (shallow clone).\n` +
        `Deepen the deploy's \`fetch-depth\`, or ${source.remedy}.`,
    );
  }
  return lines(git(repo, "ls-tree", "-r", "--name-only", sha));
}

export interface Candidate {
  sha: string;
  /**
   * Whether this commit having NO image is legitimate — the walk may step past
   * it — rather than a release that is still building or has failed.
   *
   * What that means differs per image, which is the whole of `ImageSource`
   * below: for the core it is "touched only `**\/*.md` and `docs/**`"; for the
   * bundle it is "touched nothing release-bundle-image.yml watches".
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
  mayLackImage: () => boolean;
}

/**
 * Which image is being resolved, in the words its failures need.
 *
 * The walk is identical for both; only what it can say for itself differs. A
 * core commit with no image means "the release is still building" and the way
 * out is an explicit `version`. A bundle commit with no image means the tree it
 * touched is watched by `release-bundle-image.yml` and that run has not landed,
 * and the way out is re-running it. Getting that sentence wrong sends whoever
 * reads a red deploy at 3am to the wrong workflow.
 */
export interface ImageSource {
  /** What this commit changed that demanded an image, e.g. "code". */
  subject: string;
  /** The workflow that publishes the tag. */
  workflow: string;
  /** What to do about it, as an imperative clause. */
  remedy: string;
}

export const CORE_IMAGE_SOURCE: ImageSource = {
  subject: "code",
  workflow: "release-image.yml",
  remedy:
    "wait for the release to finish, or dispatch with an explicit `version`",
};

export const BUNDLE_IMAGE_SOURCE: ImageSource = {
  subject: "a tree the bundle image bakes",
  workflow: BUNDLE_RELEASE_WORKFLOW,
  remedy:
    "wait for that build to finish, re-run it, or dispatch with an explicit `bundle_version`",
};

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
 * The walk-back exists for ONE reason: a commit can advance `main` without
 * publishing this image, by design. `release-image.yml` carries
 * `paths-ignore: ["**\/*.md", "docs/**"]` and this repo lands docs in the same
 * PR as the code, so a docs-only merge cuts no core image;
 * `release-bundle-image.yml` carries the inverse, a `paths:` filter naming what
 * the image is built from, so MOST commits cut no bundle image at all. Failing
 * those deploys would punish a commit that has nothing wrong with it, and the
 * newest ancestor that DID publish is the image that should be running anyway.
 *
 * It exists for no other reason, which is why a commit that SHOULD have
 * published and did not is a hard failure rather than another step back. A
 * missing tag there means the release is still building or has failed — and
 * walking past it would deploy an older image against THIS commit's config,
 * which is precisely the new-config-meets-old-code outage this module exists to
 * prevent. Better a red deploy that says "wait for the release" than a green one
 * that quietly ships the wrong pair.
 *
 * A `published` that rejects propagates. A registry the deploy cannot read must
 * not look like a registry that is missing a tag — that would silently ship an
 * older image every time GHCR had a bad minute.
 *
 * `mayLackImage` is asked ONLY about a commit the registry has already said has
 * no image, and only until the walk stops. On a healthy `main` that is zero
 * calls for the core: HEAD published, and nothing else is classified at all.
 *
 * ## Waiting, and why only one of the two images needs it
 *
 * The core never races its own release: `release-image.yml` pushes the image and
 * THEN calls the deploy, in that order, in one workflow. The bundle has no such
 * ordering — `release-bundle-image.yml` is a separate trigger on the same push,
 * and it bakes Chromium and nine npm trees while the core's release is already
 * calling the deploy. So on a merge that touches a baked tree, `sha-<HEAD>`
 * reliably does not exist yet, and a bare hard stop would turn EVERY such deploy
 * red — nine of them in the three weeks before this was written.
 *
 * `options.waitMs` closes that gap without weakening the stop: a commit that is
 * REQUIRED to have an image is re-asked until it appears or the budget runs out,
 * and only then does it fail. It buys the bundle the same ordering the core gets
 * for free. It is never reached on a healthy deploy, because the first probe
 * already answered.
 */
export interface DeployTagOptions {
  source?: ImageSource;
  /**
   * How long to keep re-asking for a tag a commit is REQUIRED to have, in ms.
   * Zero (the default) fails on the first miss, which is right for the core.
   */
  waitMs?: number;
  /** Test seams. Unset in production. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** How often to re-ask while waiting. Slow enough not to hammer the registry. */
const WAIT_POLL_MS = 20_000;

export async function resolveDeployTag(
  candidates: readonly Candidate[],
  published: (tag: string) => Promise<boolean>,
  options: DeployTagOptions = {},
): Promise<ResolvedTag> {
  const source = options.source ?? CORE_IMAGE_SOURCE;
  const waitMs = options.waitMs ?? 0;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? (() => Date.now());

  if (candidates.length === 0) {
    throw new Error(
      "no commits to resolve an image tag from. " +
        "Does the checkout have history (fetch-depth)?",
    );
  }

  for (const [distance, candidate] of candidates.entries()) {
    const tag = shaTag(candidate.sha);
    if (await published(tag)) return { tag, sha: candidate.sha, distance };
    if (!candidate.mayLackImage()) {
      // This commit owes an image. Wait for the build that owes it, if the
      // caller allotted time — a rejecting `published` still propagates, so an
      // unreadable registry never spends the budget looking like an absent tag.
      const deadline = now() + waitMs;
      let waited = false;
      while (now() < deadline) {
        waited = true;
        await sleep(WAIT_POLL_MS);
        if (await published(tag)) return { tag, sha: candidate.sha, distance };
      }
      throw new Error(
        `commit ${candidate.sha.slice(0, 12)} changed ${source.subject} but ` +
          `published no image (${tag})` +
          (waited
            ? `, and none appeared in ${Math.round(waitMs / 1000)}s of waiting. ` +
              `${source.workflow} is slower than that, or it failed.\n`
            : `. ${source.workflow} is probably still building it, or it failed.\n`) +
          `Deploying an older image against this commit's config is the skew ` +
          `this check exists to prevent, so this is a hard stop: ` +
          `${source.remedy}.`,
      );
    }
  }

  throw new Error(
    `no published image in the last ${candidates.length} commits ` +
      `(${candidates[0]?.sha.slice(0, 12)}…` +
      `${candidates[candidates.length - 1]?.sha.slice(0, 12)}), and none of ` +
      `them was required to publish one (${source.workflow}). ` +
      `Deepen the walk, or ${source.remedy}.`,
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
