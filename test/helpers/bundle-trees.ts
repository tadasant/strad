import { readFileSync } from "node:fs";

/**
 * The trees `servers/bundle/Dockerfile` bakes, read as TEXT.
 *
 * Three lists name this same set — the Dockerfile's build stages, the `paths:`
 * of `release-bundle-image.yml`, and the `servers` matrix in `ci.yml` — and each
 * pair of them is compared by a test rather than maintained in parallel. This is
 * the one reader they share, so a change to how the Dockerfile spells a `COPY`
 * moves every comparison at once instead of half of them.
 */
export const DOCKERFILE = "servers/bundle/Dockerfile";

/**
 * Every `<dir>/<tree>` the Dockerfile copies from, as a repo-relative path.
 *
 * Two roots, because the image is assembled from both: `servers/` holds the
 * trees strad owns or vendors per-server, `images/` holds the supplementary
 * images that are also deliverables on their own.
 *
 * Flags are skipped (`COPY --link servers/foo/…`) and the tree may be followed
 * by a slash or by whitespace (`COPY servers/foo ./foo`) — a `COPY` this misses
 * is a tree that silently drops out of every comparison below, which is the
 * failure these tests exist to prevent.
 */
export function bakedTrees(): Set<string> {
  const df = readFileSync(DOCKERFILE, "utf8");
  const trees = new Set<string>();
  for (const m of df.matchAll(
    /^COPY\s+(?:--[^\s]+\s+)*((?:servers|images)\/[a-z0-9-]+)(?:\/|\s)/gm,
  )) {
    trees.add(m[1]!);
  }
  return trees;
}
