/**
 * Resolve the immutable core image tag a staging deploy should ship.
 *
 * Given the branch's recent history, find the newest commit that actually
 * published an image and print its `sha-<commit>` tag. The deploy then hands
 * App Platform a tag that names one commit instead of `latest` — see
 * src/deploy/imageTag.ts for what that mutable tag did to staging.
 *
 * It walks back ONLY past docs-only commits, which cut no image by design. A
 * commit that changed code and has no image is a hard stop: the release is
 * still building or it failed, and deploying the previous commit's image
 * against this commit's config is the exact skew this whole path prevents.
 *
 * Usage:
 *
 *   git log --first-parent --format=%H -n 50 \
 *     | node --experimental-transform-types scripts/resolve-image-tag.ts \
 *         --repository tadasant/strad >> "$GITHUB_OUTPUT"
 *
 * Reads the sha list on stdin, one per line. Writes `key=value` lines on stdout
 * for GITHUB_OUTPUT (`image`, `tag`, `sha`, `distance`) and everything human on
 * stderr, so the two never mix.
 *
 * Credentials come from GHCR_PULL_TOKEN (or GITHUB_TOKEN) and are read from the
 * environment, never argv — this runs on a shared self-hosted runner where argv
 * is readable by anything that can run `ps`.
 */
import { parseArgs } from "node:util";
import {
  changedFiles,
  fetchPullToken,
  isDocsOnly,
  registryProbe,
  resolveDeployTag,
  type Candidate,
} from "../src/deploy/imageTag.ts";

const { values } = parseArgs({
  options: {
    repository: { type: "string" },
    registry: { type: "string", default: "ghcr.io" },
  },
});

if (!values.repository) {
  console.error(
    "usage: resolve-image-tag --repository <owner/name> [--registry ghcr.io]",
  );
  process.exit(1);
}

const repository = values.repository;
const registry = values.registry ?? "ghcr.io";
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

  // Classify each commit before asking the registry anything: whether a missing
  // tag is legitimate depends on what the commit touched, not on the registry.
  const candidates: Candidate[] = shas.map((sha) => ({
    sha,
    docsOnly: isDocsOnly(changedFiles(sha)),
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
  );
  const image = `${registry}/${repository}:${resolved.tag}`;

  console.error(
    resolved.distance === 0
      ? `Deploying the image built for HEAD (${resolved.sha.slice(0, 12)}).`
      : `::warning::HEAD (${shas[0]?.slice(0, 12)}) published no image — ` +
          `deploying ${resolved.distance} docs-only commit(s) back, from ` +
          `${resolved.sha.slice(0, 12)}.`,
  );
  console.error(`Resolved core image: ${image}`);

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
