/**
 * Resolve the immutable core image tag a staging deploy should ship.
 *
 * Given the branch's recent history, find the newest commit that actually
 * published an image and print its `sha-<commit>` tag. The deploy then hands
 * App Platform a tag that names one commit instead of `latest` — see
 * src/deploy/imageTag.ts for what that mutable tag did to staging.
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
import { resolveDeployTag } from "../src/deploy/imageTag.ts";

const { values } = parseArgs({
  options: {
    repository: { type: "string" },
    registry: { type: "string", default: "ghcr.io" },
    actor: { type: "string" },
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
const actor = values.actor ?? process.env.GITHUB_ACTOR ?? "github-actions";
const password = process.env.GHCR_PULL_TOKEN || process.env.GITHUB_TOKEN;

if (!password) {
  console.error(
    "::error::neither GHCR_PULL_TOKEN nor GITHUB_TOKEN is set; cannot read the registry",
  );
  process.exit(1);
}

const ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(",");

/** A pull-scoped bearer token for this repository. */
async function pullToken(): Promise<string> {
  const basic = Buffer.from(`${actor}:${password}`).toString("base64");
  const res = await fetch(
    `https://${registry}/token?service=${registry}&scope=repository:${repository}:pull`,
    { headers: { authorization: `Basic ${basic}` } },
  );
  if (!res.ok) {
    throw new Error(`could not obtain a pull token (HTTP ${res.status})`);
  }
  const body = (await res.json()) as { token?: string };
  if (!body.token) throw new Error("registry returned no pull token");
  return body.token;
}

const token = await pullToken();

/**
 * Does this tag exist?
 *
 * 404 is "no image for that commit" and is the ONLY negative. Anything else —
 * a 5xx, a network blip, a revoked credential — throws after a few attempts,
 * because treating an unreadable registry as an absent tag would silently walk
 * the deploy back to an older image every time GHCR had a bad minute.
 */
async function published(tag: string): Promise<boolean> {
  let last = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    let res: Response;
    try {
      res = await fetch(
        `https://${registry}/v2/${repository}/manifests/${tag}`,
        {
          method: "HEAD",
          headers: { authorization: `Bearer ${token}`, accept: ACCEPT },
        },
      );
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
      await new Promise((r) => setTimeout(r, attempt * 1000));
      continue;
    }
    if (res.status === 404) return false;
    if (res.ok) return true;
    last = `HTTP ${res.status}`;
    if (res.status < 500) break;
    await new Promise((r) => setTimeout(r, attempt * 1000));
  }
  throw new Error(`could not read ${repository}:${tag} (${last})`);
}

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

const resolved = await resolveDeployTag(shas, published);
const image = `${registry}/${repository}:${resolved.tag}`;

console.error(
  resolved.distance === 0
    ? `Deploying the image built for HEAD (${resolved.sha.slice(0, 12)}).`
    : `::warning::HEAD (${shas[0]?.slice(0, 12)}) published no image — ` +
        `deploying ${resolved.distance} commit(s) back, from ` +
        `${resolved.sha.slice(0, 12)}. A docs-only commit cuts no image.`,
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
