import { existsSync, readdirSync, readFileSync } from "node:fs";

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

/**
 * Every directory under `servers/` or `images/` that npm can install on its own
 * — one carrying its own `package-lock.json`.
 *
 * That lockfile is what makes a directory a TREE rather than a workspace of one:
 * `servers/onepassword/shared` has a `package.json` and is installed by its
 * parent, while `servers/bundle/host` has a lockfile and is installed by nobody
 * else. It is also exactly what a CI leg needs — `npm ci` is the first step of
 * every leg, and it refuses a directory without one.
 *
 * The `COPY` scan above cannot make this distinction: `COPY
 * servers/bundle/host/package.json` and `COPY servers/bundle-api/fork/slack/…`
 * read identically, and only one of the two names a tree. So the Dockerfile says
 * WHICH trees ship and this says WHAT unit a leg can address, and
 * `ci-server-trees.test.ts` uses the two together.
 *
 * The walk does not stop at a lockfile it finds. npm workspaces share their
 * root's lockfile, so a lockfile INSIDE a tree is not part of that tree — it is
 * another one, installed by nobody, which is exactly the shape that put
 * `servers/bundle/host` outside CI for its first weeks.
 */
export function installableTrees(): Set<string> {
  const trees = new Set<string>();

  const walk = (dir: string): void => {
    if (existsSync(`${dir}/package-lock.json`)) trees.add(dir);
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory() && e.name !== "node_modules")
        walk(`${dir}/${e.name}`);
    }
  };

  for (const root of ["servers", "images"]) walk(root);
  return trees;
}
