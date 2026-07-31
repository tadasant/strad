/**
 * Resolve the immutable image tag a staging deploy should ship.
 *
 * Given the branch's recent history, find the newest commit that actually
 * published an image and print its `sha-<commit>` tag. The deploy then hands
 * App Platform a tag that names one commit instead of `latest` — see
 * src/deploy/imageTag.ts for what that mutable tag did to staging, twice.
 *
 * `--kind` says WHICH image, and the only thing it changes is when a missing tag
 * is legitimate:
 *
 *   core    release-image.yml builds every commit except docs-only ones, so the
 *           walk steps past `**\/*.md` and `docs/**` and stops hard anywhere
 *           else.
 *   bundle  release-bundle-image.yml is `paths:`-filtered to the seven trees the
 *           image bakes, so most commits cut no bundle image and stepping past
 *           them is the normal case. That filter is READ from the workflow, not
 *           copied here.
 *
 * Either way a commit that SHOULD have published and did not is a hard stop: the
 * release is still building or it failed, and deploying an older image against
 * this commit's config is the exact skew this whole path prevents.
 *
 * Usage:
 *
 *   git log --first-parent --format=%H -n 50 \
 *     | node --experimental-transform-types scripts/resolve-image-tag.ts \
 *         --repository tadasant/strad >> "$GITHUB_OUTPUT"
 *
 *   git log --first-parent --format=%H -n 50 \
 *     | node --experimental-transform-types scripts/resolve-image-tag.ts \
 *         --repository tadasant/strad-bundle --kind bundle >> "$GITHUB_OUTPUT"
 *
 * Reads the sha list on stdin, one per line. Writes `key=value` lines on stdout
 * for GITHUB_OUTPUT (`image`, `tag`, `sha`, `distance`) and everything human on
 * stderr, so the two never mix.
 *
 * Credentials come from GHCR_PULL_TOKEN (or GITHUB_TOKEN) and are read from the
 * environment, never argv — this runs on a shared self-hosted runner where argv
 * is readable by anything that can run `ps`.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  BUNDLE_IMAGE_SOURCE,
  BUNDLE_RELEASE_WORKFLOW,
  changedFiles,
  CORE_IMAGE_SOURCE,
  fetchPullToken,
  isDocsOnly,
  isOutsidePathFilter,
  parsePathsFilter,
  registryProbe,
  resolveDeployTag,
  type Candidate,
} from "../src/deploy/imageTag.ts";

const { values } = parseArgs({
  options: {
    repository: { type: "string" },
    registry: { type: "string", default: "ghcr.io" },
    kind: { type: "string", default: "core" },
  },
});

if (!values.repository || !["core", "bundle"].includes(values.kind ?? "")) {
  console.error(
    "usage: resolve-image-tag --repository <owner/name> " +
      "[--kind core|bundle] [--registry ghcr.io]",
  );
  process.exit(1);
}

const repository = values.repository;
const registry = values.registry ?? "ghcr.io";
const kind = values.kind as "core" | "bundle";
const source = kind === "bundle" ? BUNDLE_IMAGE_SOURCE : CORE_IMAGE_SOURCE;
// GitHub Actions sets GITHUB_ACTOR in every step; the fallback is for a local run.
const actor = process.env.GITHUB_ACTOR ?? "github-actions";
const password = process.env.GHCR_PULL_TOKEN || process.env.GITHUB_TOKEN;

if (!password) {
  console.error(
    "::error::neither GHCR_PULL_TOKEN nor GITHUB_TOKEN is set; cannot read the registry",
  );
  process.exit(1);
}

async function main(): Promise<void> {
  const stdin = await new Promise<string>((resolve, reject) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (buf += chunk));
    process.stdin.on("end", () => resolve(buf));
    process.stdin.on("error", reject);
  });

  const shas = stdin
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

  // The bundle's `paths:` filter, read ONCE from the workflow that owns it —
  // eagerly, so a filter this script cannot parse fails here, naming the file,
  // rather than partway through a walk where it would look like a missing tag.
  const bundlePaths =
    kind === "bundle"
      ? parsePathsFilter(
          readFileSync(BUNDLE_RELEASE_WORKFLOW, "utf8"),
          BUNDLE_RELEASE_WORKFLOW,
        )
      : [];

  // Classify LAZILY. Whether a missing tag is legitimate depends on what the
  // commit touched, but only a commit the registry has no image for is ever
  // asked — and the walk stops at the first one that does, which on a healthy
  // `main` is HEAD. Classifying all 50 up front asked git about commits whose
  // answer was never read, and one of them (this repo's root commit) has no
  // parent to diff against, so the step died before it could deploy the image
  // HEAD had published all along.
  const candidates: Candidate[] = shas.map((sha) => ({
    sha,
    mayLackImage: () =>
      kind === "bundle"
        ? isOutsidePathFilter(changedFiles(sha), bundlePaths)
        : isDocsOnly(changedFiles(sha)),
  }));

  const token = await fetchPullToken({
    registry,
    repository,
    actor,
    password: password as string,
  });

  const resolved = await resolveDeployTag(
    candidates,
    registryProbe({ registry, repository, token }),
    source,
  );
  const image = `${registry}/${repository}:${resolved.tag}`;

  // A walk-back is a WARNING for the core, where HEAD normally publishes, and
  // ordinary for the bundle, where most commits do not touch a baked tree. Same
  // fact, different news — annotating every bundle deploy would train everyone
  // to scroll past the annotation that matters.
  if (resolved.distance === 0) {
    console.error(
      `Deploying the image built for HEAD (${resolved.sha.slice(0, 12)}).`,
    );
  } else if (kind === "bundle") {
    console.error(
      `HEAD (${shas[0]?.slice(0, 12)}) touched no tree the bundle image bakes; ` +
        `deploying the newest one that did, ${resolved.distance} commit(s) ` +
        `back (${resolved.sha.slice(0, 12)}).`,
    );
  } else {
    console.error(
      `::warning::HEAD (${shas[0]?.slice(0, 12)}) published no image — ` +
        `deploying ${resolved.distance} docs-only commit(s) back, from ` +
        `${resolved.sha.slice(0, 12)}.`,
    );
  }
  console.error(`Resolved ${kind} image: ${image}`);

  process.stdout.write(
    [
      `image=${image}`,
      `tag=${resolved.tag}`,
      `sha=${resolved.sha}`,
      `distance=${resolved.distance}`,
      "",
    ].join("\n"),
  );
}

try {
  await main();
} catch (err) {
  // An `::error::` annotation, not a raw unhandled rejection: the whole point of
  // this step is to say which commit it could not resolve and what to do next,
  // and a undici stack trace says neither.
  const message = err instanceof Error ? err.message : String(err);
  console.error(`::error::${message.replace(/\n/g, "%0A")}`);
  process.exit(1);
}
