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
 * touched is watched by `release-bundle-image.yml` and that run has not landed.
 * Getting that sentence wrong sends whoever reads a red deploy at 3am to the
 * wrong workflow.
 *
 * ## A build that FAILED is not a build that is late, and only the BUNDLE's
 * ## remedy can say so
 *
 * A re-run replays the workflow at the commit that failed, so a commit whose own
 * source broke the build fails again and the tag it owes can never appear. Which
 * move DOES work depends on the walk-back rule, and the two images differ.
 *
 * All of which is about a build that FAILED. A build that was CANCELLED — a
 * runner host restarting under it, most often — learned nothing about the
 * commit, so the re-run this section talks a reader out of is exactly the right
 * move there, and `reheal-bundle-image.yml` makes it without one.
 * `interruptedAdvice` in `resolveDeployTag` is what a reader gets instead of the
 * two strings below.
 *
 * The core self-heals, because `release-image.yml` builds every non-docs commit:
 * the commit that fixes the build is itself a commit that publishes, and the
 * walk stops there. Its remedy therefore names the wait and the `version` pin
 * and nothing else — on the core path the commit the walk stops at is normally
 * HEAD, so "dispatch on `main`" would rebuild the failing source and IS the
 * re-run.
 *
 * The bundle does not self-heal, because most commits cut no bundle image, and
 * that is how `450ad5cb` (#127) parked every prod deploy. It put a `${{ }}`
 * expression inside a `description:` in `.github/actions/build-push/action.yml`;
 * GitHub parses expressions in an action manifest even inside a doc string, so
 * all eight release workflows failed the moment they reached that action, and
 * that commit — which touched `release-bundle-image.yml`, one of the paths the
 * bundle watches — published nothing. `6d2dd228` (#129) fixed the manifest and
 * touched no baked tree, so no bundle build fired, and `450ad5cb` stayed the
 * newest commit owing a bundle image: no image, no build coming, and every prod
 * deploy hard-stopping here after fifteen minutes of waiting.
 *
 * A DISPATCH is what ends that. `release-bundle-image.yml` carries
 * `workflow_dispatch` and refuses any ref but `main`, and a dispatch publishes
 * an image for HEAD — which is where this walk starts, so it resolves at
 * distance 0 and the commit that owes an image is never asked about.
 */
export interface ImageSource {
  /** What this commit changed that demanded an image, e.g. "code". */
  subject: string;
  /** The workflow that publishes the tag. */
  workflow: string;
  /** What to do about it, as an imperative clause. */
  remedy: string;
  /**
   * The same advice for a run that has already CONCLUDED without publishing, as
   * an imperative clause.
   *
   * `remedy` covers a run whose image may still arrive, so it offers the wait
   * first and hedges the rest. This one is printed only where the walk KNOWS
   * there is nothing coming, and it drops the wait entirely — the section above
   * is the whole of why, and it is not repeated here.
   */
  republish: string;
}

export const CORE_IMAGE_SOURCE: ImageSource = {
  subject: "code",
  workflow: "release-image.yml",
  remedy:
    "wait for the release to finish, or re-dispatch this deploy with an " +
    "explicit `version`",
  republish:
    "re-run that release, or re-dispatch this deploy with an explicit " +
    "`version` naming an image that exists",
};

export const BUNDLE_IMAGE_SOURCE: ImageSource = {
  subject: "a tree the bundle image bakes",
  workflow: BUNDLE_RELEASE_WORKFLOW,
  // The workflow's name is interpolated rather than spelled again: a rename that
  // updated `workflow` and not this string would send the reader to a file that
  // no longer exists, in the one sentence that has to be right.
  remedy:
    `wait for that build to finish, dispatch ` +
    `${BUNDLE_RELEASE_WORKFLOW.split("/").pop()} on \`main\` if it FAILED ` +
    `(a re-run rebuilds the same commit), or re-dispatch this deploy with an ` +
    `explicit \`bundle_version\``,
  // Interpolated for the same reason `remedy` is: this sentence names the
  // workflow a reader is about to go dispatch, and a rename that updated one
  // string and not the other would send them to a file that is not there.
  republish:
    `re-run that build if its tree can still build; when the failure is IN ` +
    `that commit a re-run only rebuilds it, so dispatch ` +
    `${BUNDLE_RELEASE_WORKFLOW.split("/").pop()} on \`main\` instead — it ` +
    `publishes \`sha-<main HEAD>\`, which ends the walk before it ever ` +
    `reaches this commit`,
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
 *
 * ## Waiting for a build that is already dead
 *
 * The wait assumes the missing image is COMING. When the release run for that
 * commit has already concluded without success, it is not, and the fifteen
 * minutes buy nothing but a later error — 16m51s of a shared runner on
 * 2026-08-11, ending in "it is slower than that, or it failed" with no way to
 * tell which. `options.releaseRun` answers that question directly: a run that
 * has CONCLUDED unsuccessfully ends the wait at once and names itself, and a
 * run that is still going is why the wait is right to continue.
 *
 * It is an optimisation on the diagnosis, never a new way to fail. A lookup that
 * throws is swallowed and reported in the error that the walk was going to
 * produce anyway.
 *
 * ## Waiting for a build that was interrupted
 *
 * A `cancelled` run is the one conclusion that is not a verdict on the commit,
 * and `reheal-bundle-image.yml` re-runs the first one automatically. So a first
 * cancellation is a build that is COMING BACK, and the wait is held open for it
 * — see `deadRun`. Without that, a cancellation landing while a deploy is
 * already waiting would hard-stop the deploy in the minute before the re-run it
 * is waiting for even starts, which is a race the self-heal cannot win on its
 * own. A second attempt cancelled again is dead like any other verdict.
 */
export interface DeployTagOptions {
  source?: ImageSource;
  /**
   * How long to keep re-asking for a tag a commit is REQUIRED to have, in ms.
   * Zero (the default) fails on the first miss, which is right for the core.
   */
  waitMs?: number;
  /**
   * The state of the release run that owes the missing image, if it can be
   * read. Asked ONLY about a commit that is required to publish and has not, so
   * a healthy deploy never calls it. Return `null` when the workflow has no run
   * for that commit at all.
   */
  releaseRun?: (sha: string) => Promise<ReleaseRun | null>;
  /** Test seams. Unset in production. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** A run of the workflow that owes an image, as far as this module cares. */
export interface ReleaseRun {
  /** `queued`, `in_progress`, `completed` — whatever the API reports. */
  status: string;
  /** `success`, `failure`, `cancelled`… and `null` until it completes. */
  conclusion: string | null;
  /**
   * Which attempt the state above describes. A re-run adds an attempt to the
   * SAME run rather than creating a second one, so this is the only field that
   * distinguishes "cancelled once" from "cancelled again after a re-run" —
   * which is the whole difference between a wait worth having and a wait that
   * ends the same way in fifteen minutes. Defaults to 1 where a caller cannot
   * read it.
   */
  runAttempt?: number;
  /** Where to go look. */
  url: string;
}

/**
 * A conclusion that is not a verdict on the commit.
 *
 * `failure`, `timed_out` and `startup_failure` all say the tree at that commit
 * does not build, and a re-run rebuilds it to the same end. `cancelled` says
 * only that something INTERRUPTED the build — a runner host restarting under
 * it, most often — and the tree that was building a second earlier still
 * builds. `reheal-bundle-image.yml` re-runs exactly this case, once, so a
 * cancelled FIRST attempt is a build that is coming back rather than one that
 * is over.
 */
const INTERRUPTED = "cancelled";

/**
 * The run, if it has finished without publishing: waiting for it is waiting
 * forever. `null` for a run still queued or in flight, which is what the wait is
 * FOR — returning the run rather than a boolean keeps that distinction in the
 * type, where a `run is ReleaseRun` predicate would have narrowed a live run
 * away in the else branch.
 *
 * `null` too for a first attempt that was merely INTERRUPTED, and that is not a
 * softening of the stop. The self-heal above re-runs such a run within about a
 * minute, and this walk polls every twenty seconds — so without this, a
 * cancellation landing while a deploy is already waiting would hard-stop that
 * deploy in the window before the re-run it is waiting for even starts. A
 * second attempt that is cancelled again IS dead: the self-heal declined it,
 * nothing else is coming, and the budget would buy the same error later.
 */
function deadRun(run: ReleaseRun | null): ReleaseRun | null {
  if (run === null) return null;
  // A `conclusion` of null is NOT a verdict. `completed` can arrive before the
  // conclusion settles, and reading the absence of "success" as failure would
  // turn that instant into an unrecoverable hard stop — announced, absurdly, as
  // "has already CONCLUDED (no conclusion)". Only an explicit non-success
  // verdict ends the wait.
  const done =
    run.status === "completed" &&
    run.conclusion !== null &&
    run.conclusion !== "success";
  if (!done) return null;
  if (run.conclusion === INTERRUPTED && (run.runAttempt ?? 1) === 1)
    return null;
  return run;
}

/** How often to re-ask while waiting. Slow enough not to hammer the registry. */
const WAIT_POLL_MS = 20_000;

/** How long one Actions-API lookup may take before it is not worth having. */
const LOOKUP_TIMEOUT_MS = 10_000;

export async function resolveDeployTag(
  candidates: readonly Candidate[],
  published: (tag: string) => Promise<boolean>,
  options: DeployTagOptions = {},
): Promise<ResolvedTag> {
  const source = options.source ?? CORE_IMAGE_SOURCE;
  const waitMs = options.waitMs ?? 0;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? (() => Date.now());
  // Cleared after a lookup throws: one unreadable API is a note in the error,
  // not a call re-made on every poll for fifteen minutes.
  let releaseRun = options.releaseRun;

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
      //
      // Unless that build is already dead, which `lookUp` is here to notice:
      // then the wait has nothing to wait for and the error is available now.
      const owed = `commit ${candidate.sha.slice(0, 12)} changed ${source.subject} but published no image (${tag})`;
      const skew =
        `Deploying an older image against this commit's config is the skew ` +
        `this check exists to prevent, so this is a hard stop`;
      let lookupFailure = "";
      const lookUp = async (): Promise<ReleaseRun | null> => {
        if (!releaseRun) return null;
        try {
          return await releaseRun(candidate.sha);
        } catch (err) {
          // The diagnosis is not allowed to become the failure. Report what
          // could not be read in the error the walk was going to throw anyway.
          lookupFailure =
            `\n(could not read ${source.workflow} runs for that commit: ` +
            `${err instanceof Error ? err.message : String(err)})`;
          releaseRun = undefined;
          return null;
        }
      };
      // Said wherever the walk reports a run that ended in a cancellation, and
      // it replaces the source's advice rather than adding to it: `remedy` and
      // `republish` both talk a reader out of a re-run, because both were
      // written for a build the COMMIT broke. Here the commit is fine and the
      // re-run is the entire fix.
      const interruptedAdvice =
        `That run was CANCELLED, not failed, so nothing was learned about the ` +
        `commit and a re-run of it will publish. reheal-bundle-image.yml re-runs ` +
        `the first such cancellation by itself; a cancellation still sitting ` +
        `here means that heal did not fire, or has already spent its one ` +
        `attempt on a CI host that is not healthy. Re-run it`;
      const advice = (run: ReleaseRun): string =>
        run.conclusion === INTERRUPTED ? interruptedAdvice : source.republish;
      const dead = (run: ReleaseRun): Error =>
        new Error(
          `${owed}, and ${source.workflow} has already CONCLUDED for it ` +
            `(${run.conclusion}): ${run.url}\n` +
            `That image is not coming, so there is nothing to wait for. ` +
            `${skew} — ${advice(run)}.`,
        );

      let run = await lookUp();
      let gone = deadRun(run);
      if (gone) throw dead(gone);

      const deadline = now() + waitMs;
      let waited = false;
      while (now() < deadline) {
        waited = true;
        await sleep(WAIT_POLL_MS);
        if (await published(tag)) return { tag, sha: candidate.sha, distance };
        run = await lookUp();
        gone = deadRun(run);
        if (gone) throw dead(gone);
      }
      // A run that exists and has not concluded is worth waiting for, so the
      // remedy is `remedy`. NO run — for a commit the filter says owes an image,
      // asked minutes after the push that would have created one — is a
      // different animal: nothing is coming, and "wait for that build" names a
      // build that does not exist. Say `republish` there instead.
      //
      // A run still sitting on a FIRST cancellation is the third case, and it
      // is the one this budget was spent on: `deadRun` held the wait open for a
      // self-heal that never re-ran it. `remedy` would tell the reader to wait
      // for a build that is already over.
      const noRun = run === null && releaseRun !== undefined;
      const stillInterrupted =
        run !== null &&
        run.status === "completed" &&
        run.conclusion === INTERRUPTED;
      throw new Error(
        `${owed}` +
          (waited
            ? `, and none appeared in ${Math.round(waitMs / 1000)}s of waiting. ` +
              `${source.workflow} is slower than that, or it failed.\n`
            : `. ${source.workflow} is probably still building it, or it failed.\n`) +
          (run
            ? `Its run is ${run.status} (${run.conclusion ?? "no conclusion yet"}): ${run.url}\n`
            : noRun
              ? `${source.workflow} has no run for that commit at all.\n`
              : "") +
          `${skew}: ${
            stillInterrupted
              ? interruptedAdvice
              : noRun
                ? source.republish
                : source.remedy
          }.${lookupFailure}`,
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

export interface ReleaseRunOptions {
  /**
   * `owner/name` of the repo whose Actions runs to read — the SOURCE repo, not
   * the image's. `tadasant/strad` publishes `tadasant/strad-bundle`, and only
   * the first has workflow runs.
   */
  repository: string;
  /** The workflow file. A path is fine; the API wants its basename. */
  workflow: string;
  /** Needs `actions: read`. The GHCR pull token is package-scoped and will not do. */
  token: string;
  /** `GITHUB_API_URL`, for GHES. */
  api?: string;
  fetchImpl?: typeof fetch;
}

/**
 * The run of `workflow` that decides whether the image is still coming, or
 * `null` if the commit has no run at all.
 *
 * A LIVE run wins over a concluded one, whatever the timestamps say, and only
 * then is the newest of the concluded ones taken. The question this answers is
 * "is anything still going to publish this?", and one queued or in-flight run
 * makes the answer yes no matter how many failures sit beside it.
 *
 * Recency alone is not enough for that. Re-running a workflow adds an ATTEMPT to
 * the existing run rather than creating a second one, so `created_at` stays at
 * the original push — while a `workflow_dispatch` for the same sha IS a separate
 * run, and a failed dispatch can be newer than a push run somebody has since
 * restarted. Picking the newest there would report `failure` over a build that
 * is running, which is exactly the wrong answer to have quickly.
 *
 * Throws on anything it cannot read. `resolveDeployTag` swallows that — this is
 * a better error message, not a gate.
 */
export function releaseRunLookup(
  opts: ReleaseRunOptions,
): (sha: string) => Promise<ReleaseRun | null> {
  const doFetch = opts.fetchImpl ?? fetch;
  const api = opts.api ?? "https://api.github.com";
  const file = opts.workflow.split("/").pop();

  return async function releaseRun(sha: string): Promise<ReleaseRun | null> {
    const url =
      `${api}/repos/${opts.repository}/actions/workflows/${file}/runs` +
      `?head_sha=${sha}&per_page=100`;
    const res = await doFetch(url, {
      headers: {
        authorization: `Bearer ${opts.token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
      },
      // A stalled API must not cost more than the wait it is here to cut short.
      // The catch upstream covers a rejection; nothing else bounds the latency.
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    const body = (await res.json()) as {
      workflow_runs?: {
        status?: string | null;
        conclusion?: string | null;
        run_attempt?: number | null;
        html_url?: string;
        created_at?: string;
      }[];
    };
    const runs = body.workflow_runs ?? [];
    if (runs.length === 0) return null;
    const live = runs.find((r) => r.status !== "completed");
    const chosen =
      live ??
      runs.reduce((a, b) =>
        (b.created_at ?? "") > (a.created_at ?? "") ? b : a,
      );
    return {
      status: chosen.status ?? "unknown",
      conclusion: chosen.conclusion ?? null,
      // A run the API cannot count attempts for is treated as a first attempt,
      // which is the reading that keeps waiting rather than the one that stops.
      runAttempt: chosen.run_attempt ?? 1,
      url: chosen.html_url ?? url,
    };
  };
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
