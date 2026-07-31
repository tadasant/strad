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

/**
 * Tags that name "whatever was pushed most recently" rather than one build.
 *
 * `latest` is the only one this repo publishes, and `parseImage` invents it for
 * a tag-less ref — so `--image ghcr.io/tadasant/strad` is caught here too,
 * which is the shape most likely to be typed by hand.
 */
const MUTABLE_TAGS = new Set(["latest", "main", "edge", "stable"]);

export function isMutableTag(tag: string): boolean {
  return MUTABLE_TAGS.has(tag);
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

export interface ResolvedTag {
  /** The tag to deploy, e.g. `sha-96015c6…`. */
  tag: string;
  /** The commit that tag names. */
  sha: string;
  /** How far back from HEAD it was found. 0 is HEAD itself. */
  distance: number;
}

/**
 * The newest commit in `shas` that actually published an image.
 *
 * `shas` is first-parent history, newest first. The walk-back exists because
 * not every commit cuts an image: release-image.yml carries
 * `paths-ignore: ["**\/*.md", "docs/**"]`, and this repo lands docs in the same
 * PR as the code — so a docs-only merge advances `main` without publishing a
 * `sha-` tag. Failing that deploy would be punishing a commit that has nothing
 * wrong with it; the newest ancestor that DID publish is the code that should
 * be running anyway.
 *
 * A `published` that rejects propagates. A registry the deploy cannot read must
 * not look like a registry that is missing a tag — that would silently ship an
 * older image every time GHCR had a bad minute.
 */
export async function resolveDeployTag(
  shas: readonly string[],
  published: (tag: string) => Promise<boolean>,
): Promise<ResolvedTag> {
  if (shas.length === 0) {
    throw new Error(
      "no commits to resolve an image tag from. " +
        "Does the checkout have history (fetch-depth)?",
    );
  }

  for (const [distance, sha] of shas.entries()) {
    const tag = shaTag(sha);
    if (await published(tag)) return { tag, sha, distance };
  }

  throw new Error(
    `no published image for any of the last ${shas.length} commits ` +
      `(${shas[0]?.slice(0, 12)}…${shas[shas.length - 1]?.slice(0, 12)}). ` +
      `Has release-image.yml run for this branch? ` +
      `Dispatch with an explicit \`version\` to deploy a known tag.`,
  );
}
