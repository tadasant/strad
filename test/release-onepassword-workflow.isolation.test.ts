import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * `release-onepassword-image.yml`'s verification build must not name an image
 * the whole runner box shares.
 *
 * It is `runs-on: self-hosted` against the same ONE docker daemon every other
 * job uses. A fixed `strad-server-onepassword:ci` is a name any concurrent job
 * can claim, and the window between this job's build and its `docker run` is
 * unguarded: a rebuild in that window moves the `op --version` assertion — the
 * whole point of the job, per its own comment, "Assert it against the real
 * artifact, not the source" — onto an image this run never built. It passes,
 * because both images came from the same Dockerfile. Nothing errors, the run is
 * green, and the release publishes having verified someone else's artifact.
 *
 * So the tag carries `github.run_id`. That is a property of TEXT nobody
 * imports, and it is one `tags: strad-server-onepassword:ci` away from being
 * gone again, so it is asserted here rather than left to review. Same shape as
 * `test/ci-workflow.isolation.test.ts` and
 * `test/bundle-google-workflow.isolation.test.ts`, whose workflows this one was
 * simply not in the scope of.
 *
 * The mirror-image failure matters more here than in either of those, because
 * this workflow is a RELEASE: the tags in `Build and push` are what App
 * Platform pulls, and a per-run one there would publish an image nothing can
 * find. So this file guards BOTH directions — the verification tag must be
 * run-scoped, and the published ones must not be.
 */

const WORKFLOW = ".github/workflows/release-onepassword-image.yml";

function workflow(): string {
  return readFileSync(WORKFLOW, "utf8");
}

/**
 * The workflow with comment-only lines dropped. The comments here NAME the
 * thing this file forbids — "a fixed `strad-server-onepassword:ci` is a name
 * any of them can claim" — so scanning them would fail on the prose that
 * explains the fix.
 */
function code(): string {
  return workflow()
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
}

/** A run-scoped identifier: interpolates the run id, so no two runs share it. */
const PER_RUN = /\$\{\{\s*github\.run_id\s*\}\}/;

/**
 * …and the attempt. A re-run of a run whose first attempt leaked its image
 * reuses the run id, so the id alone would put the retry back in the collision
 * it is retrying out of.
 */
const PER_ATTEMPT = /\$\{\{\s*github\.run_attempt\s*\}\}/;

/** The published tags. These are the release; nothing below may run-scope them. */
const PUBLISHED = [
  "ghcr.io/tadasant/strad-server-onepassword:latest",
  "ghcr.io/tadasant/strad-server-onepassword:sha-${{ github.sha }}",
];

describe("release-onepassword-image.yml cannot verify a concurrent job's artifact", () => {
  it("builds the verification image under a per-run tag", () => {
    const tags = tagsOf("Build (load) for verification");

    // Guard the guard: a regex that matched nothing would pass by asserting
    // over an empty list.
    expect(tags.length).toBe(1);

    expect(
      tags[0]!,
      `${WORKFLOW} builds ${tags[0]}, a tag a concurrent job can rebuild ` +
        `between this job's build and its \`op --version\` run — a ` +
        `wrong-artifact green on a release.`,
    ).toMatch(/^\$\{\{\s*env\.[A-Z_]+\s*\}\}$/);

    // …and the env var it names — that one, not merely some var in the job —
    // is where the run id actually is. Reading any `*_IMAGE:` here instead
    // would pass on a workflow that declares a per-run var, leaves it unused,
    // and builds `${{ env.VERIFY_TAG }}` off a fixed one: exactly the shape a
    // half-finished refactor leaves behind.
    const name = tags[0]!.match(/env\.([A-Z_]+)/)![1]!;
    const value = envValue(name);

    expect(
      value,
      `${WORKFLOW} builds \`\${{ env.${name} }}\`, and no job-level ` +
        `\`${name}:\` declares what that is.`,
    ).not.toBeNull();
    expect(
      value!,
      `${WORKFLOW} builds ${name}=${value}, which no run can call its own.`,
    ).toMatch(PER_RUN);
    expect(
      value!,
      `${WORKFLOW} builds ${name}=${value}, which carries the run id but not ` +
        `the ATTEMPT — so a re-run of a run whose first attempt leaked the tag ` +
        `retries straight back into the collision it is retrying out of.`,
    ).toMatch(PER_ATTEMPT);
  });

  it("leaves the PUBLISHED tags alone", () => {
    // The other direction, and the worse failure: this is a release workflow,
    // and a run-scoped tag here publishes an image App Platform cannot pull.
    // Whoever run-scopes the verification tag must not "fix" these too.
    const tags = tagsOf("Build and push");

    // Named individually rather than compared as a list: a seventh tag is a
    // decision someone may legitimately make, and it must go through the loop
    // below rather than redden this line with a diff of two arrays.
    for (const required of PUBLISHED) {
      expect(
        tags,
        `${WORKFLOW} no longer publishes ${required}, which is what App ` +
          `Platform pulls.`,
      ).toContain(required);
    }

    for (const tag of tags) {
      expect(
        tag,
        `${WORKFLOW} publishes ${tag}, a tag scoped to one CI run. App ` +
          `Platform pulls \`:latest\`; a per-run tag is a mispublish.`,
      ).not.toMatch(PER_RUN);
      expect(tag).not.toMatch(PER_ATTEMPT);
    }
  });

  it("runs the image it just built, by that same per-run tag", () => {
    // A literal image ref on the `docker run` would reach whichever job's build
    // currently holds that name — which is the wrong-artifact failure itself,
    // however the build step is tagged.
    const images = new Set(
      [...code().matchAll(/^\s+([A-Z][A-Z0-9_]*_IMAGE):\s+/gm)].map(
        (m) => m[1]!,
      ),
    );
    const runs = dockerRuns();

    expect(
      images.size,
      `${WORKFLOW} declares no \`*_IMAGE\` env var, so there is nothing for ` +
        `its \`docker run\`s to be checked against.`,
    ).toBeGreaterThanOrEqual(1);
    // Guard the guard only — the invariant is what each run NAMES, not how
    // many of them there are.
    expect(runs.length).toBeGreaterThanOrEqual(1);

    for (const line of runs) {
      const referenced = [...line.matchAll(/"\$([A-Z][A-Z0-9_]*)"/g)].map(
        (m) => m[1]!,
      );
      expect(
        referenced.some((ref) => images.has(ref)),
        `${WORKFLOW} runs \`${line.trim()}\`, which does not name the image ` +
          `this job built (${[...images].join(", ")}). A literal tag there ` +
          `runs whichever job's image currently holds it.`,
      ).toBe(true);
      expect(
        line,
        `${WORKFLOW} runs \`${line.trim()}\`, which names a bare ` +
          `\`strad-server-onepassword\` tag — the shared name this file exists ` +
          `to keep out of the daemon.`,
      ).not.toMatch(/(?<!\/)strad-server-onepassword:/);
    }
  });

  it("binds no fixed host port", () => {
    // This job asserts everything from a `--rm` one-shot `docker run`, so it
    // publishes nothing and this list is legitimately EMPTY — no guard-the-guard
    // minimum for that reason. The point is that ADDING a fixed `-p 8080:8080`
    // would hand it a box-wide resource the second concurrent job cannot bind.
    //
    // Read off the `docker run` lines rather than the whole file, unlike the
    // sibling tests: this workflow's verify step runs `grep -oP`, and a `-p`
    // scan over every line reads that as a port publication.
    const runs = dockerRuns();
    const publishes = runs
      .flatMap((line) => [
        ...line.matchAll(
          /(?:^|\s)(?:-[a-zA-Z]*p|--publish)[=\s]?\s*([\d.:[\]]+)/g,
        ),
      ])
      .map((m) => m[1]!);

    for (const spec of publishes) {
      expect(
        spec,
        `${WORKFLOW} publishes ${spec}, which binds a fixed host port every ` +
          `concurrent job competes for. Leave the host port empty.`,
      ).toMatch(/^(?:[\d.]+)?::\d+$/);
    }

    // Bare `-P` picks free ports too, so it survives the check above by taking
    // no argument at all — but it binds them on EVERY interface, which puts
    // whatever the container serves on the runner box's public address for the
    // life of the job.
    for (const line of runs) {
      expect(
        line,
        `${WORKFLOW} runs \`${line.trim()}\`, publishing with \`-P\`, which ` +
          `picks free ports but binds them on every interface. Name the ` +
          `loopback address instead.`,
      ).not.toMatch(/(?:^|\s)-[a-zA-Z]*P(?:\s|$)/);
    }
  });

  it("labels what it creates, and sweeps what earlier runs leaked", () => {
    // A per-run tag costs the fixed tag's one accidental virtue: a leaked
    // `strad-server-onepassword:ci` was reclaimed by the next run that wanted
    // that name, and nothing will ever want `…:ci-<run>`. The label is how the
    // sweep finds a leak; without it, a failed teardown is permanent.
    const wf = code();
    const sweep = step("Sweep what earlier runs leaked");
    const why =
      `without it a leaked image or container is never reclaimed, because ` +
      `nothing will ever want this run's tag again`;

    expect(
      wf,
      `the verification image carries no \`strad-ci\` label — ${why}`,
    ).toMatch(/labels:\s+strad-ci=1/);
    expect(
      wf,
      `the verification containers carry no \`strad-ci\` label — ${why}`,
    ).toMatch(/--label strad-ci=1/);

    // Stopped containers, then the images they were holding a reference to.
    expect(sweep, `no container sweep — ${why}`).toContain(
      "docker container prune -f --filter label=strad-ci --filter until=24h",
    );
    expect(sweep, `no image sweep — ${why}`).toContain(
      "docker image prune -af --filter label=strad-ci --filter until=24h",
    );

    // …and the RUNNING ones, which `docker container prune` does not touch and
    // which are exactly what a killed runner leaves behind. `docker ps` has no
    // `until` filter, so the workflow checks the age itself.
    expect(
      sweep,
      `nothing sweeps a leaked RUNNING container. \`docker container prune\` ` +
        `reaps stopped ones only, and a \`--rm\` run whose runner was killed ` +
        `leaves its container up — pinning its image against the image prune too.`,
    ).toMatch(/docker ps -q --filter label=strad-ci/);
    expect(
      sweep,
      `the running-container sweep has no age check, so it could remove a ` +
        `container a concurrent job is still using.`,
    ).toMatch(/86400/);
  });

  it("tears down by the per-run tag, so it cannot reap a concurrent job's", () => {
    // Scoped to the teardown step. The sweep step also removes containers, but
    // by id and only once they are a day old — reading the two together would
    // mean asserting one rule over two steps that deliberately differ.
    const teardown = step("Tear down the verification image");
    const removed = [...wf_rm(teardown)];

    expect(
      teardown,
      `${WORKFLOW}'s teardown is not \`if: always()\`, so a failed ` +
        `verification leaks its image forever.`,
    ).toMatch(/if:\s*always\(\)/);
    expect(removed.length).toBeGreaterThanOrEqual(1);

    for (const target of removed) {
      expect(
        target,
        `${WORKFLOW} tears down ${target} under \`if: always()\`, which would ` +
          `delete an image a concurrent job is still verifying.`,
      ).toMatch(/^"\$[A-Z_]+"$/);
    }
  });
});

/** Every line of the job that starts a container. */
function dockerRuns(): string[] {
  return code()
    .split("\n")
    .filter((line) => /docker run\b/.test(line));
}

/** The value of a job-level `env:` key, or null if the job declares no such key. */
function envValue(name: string): string | null {
  const m = code().match(new RegExp(`^\\s+${name}:[^\\S\\n]+(\\S.*)$`, "m"));
  return m ? m[1]!.trim() : null;
}

/** Every `docker rm -f <x>` / `docker rmi -f <x>` target in the given text. */
function* wf_rm(wf: string): Generator<string> {
  for (const m of wf.matchAll(/docker rmi?\s+-f\s+(\S+)/g)) yield m[1]!;
}

/** One step of the job, by its `name:`, as text — its own body only. */
function step(name: string): string {
  const wf = code();
  const start = wf.indexOf(`- name: ${name}`);
  expect(start, `${WORKFLOW} has no step named "${name}"`).toBeGreaterThan(-1);

  const body = wf.slice(start);
  const next = body.slice(1).search(/^ {6}- (?:name|uses):/m);
  return next === -1 ? body : body.slice(0, next + 1);
}

/**
 * The `tags:` a step builds, as a list — one entry for the inline form, one per
 * line for the block form the publish step uses.
 */
function tagsOf(name: string): string[] {
  const body = step(name);
  // `tags: |` opens the block form; anything else on that line is the tag.
  const inline = body.match(/^\s+tags:[^\S\n]+(?!\|\s*$)(\S.*)$/m);
  if (inline) return [inline[1]!.trim()];

  const block = body.match(/^(\s+)tags:\s*\|\s*\n((?:\1\s+\S.*\n?)+)/m);
  expect(block, `${WORKFLOW}'s "${name}" step declares no \`tags:\``).not.toBe(
    null,
  );
  return block![2]!
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}
