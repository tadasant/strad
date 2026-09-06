import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  calledWorkflow,
  workflow,
  workflowFiles,
} from "./helpers/workflow-graph.js";

/**
 * Staging is on demand, and that is two decisions rather than one.
 *
 * The first is that merging to `main` no longer deploys it. `strad-staging` was
 * never off because the deploy hung off the release trigger, and `main` moves
 * several times a day — so a teardown alone would have been undone by the next
 * merge. Re-adding the call is one `uses:`, and the diff that did it would look
 * like a restoration rather than a regression.
 *
 * The second is that the teardown ARCHIVES the app instead of deleting it, and
 * that one is not a preference. `strad-staging` serves
 * `staging.strad.tadasant.com` on a certificate App Platform issues for that
 * app, reached by a Cloudflare CNAME naming that app's own starter hostname.
 * Delete the app and DigitalOcean's own documentation says the domain "may
 * continue pointing to the deleted app for up to 24 hours, making the domain
 * unavailable for use with a new app" — and the recreated app would answer on a
 * different starter hostname anyway, in a DNS zone nothing in this repo holds a
 * credential for. `doctl apps delete` is therefore the one command this workflow
 * must never grow, and it is the obvious command for a file called
 * `teardown-staging.yml` to grow.
 *
 * Both decisions fail silently. A staging that is up costs money and looks
 * healthy; a staging that was deleted rather than archived comes back on a
 * hostname whose TLS handshake fails while the app itself is perfectly green,
 * which is HACKS.md #18's failure mode reached by a different route.
 */

const TEARDOWN = ".github/workflows/teardown-staging.yml";
const DEPLOY = ".github/workflows/deploy-staging.yml";
const RELEASE = ".github/workflows/release-image.yml";

/** Every `run:` script in a workflow, jobs that only `uses:` another aside. */
function scripts(file: string): string {
  return Object.values(workflow(file).jobs ?? {})
    .flatMap((j) => j.steps ?? [])
    .map((s) => s.run ?? "")
    .join("\n");
}

describe("the release path does not deploy staging", () => {
  it("release-image.yml calls no other workflow", () => {
    const jobs = Object.entries(workflow(RELEASE).jobs ?? {});
    // Guard the guard: a workflow that failed to parse has no jobs, and every
    // assertion about what is absent from it would pass.
    expect(jobs.length).toBeGreaterThan(0);
    expect(
      jobs
        .filter(([, body]) => calledWorkflow(body.uses))
        .map(([name]) => name),
      `release-image.yml delegates to another workflow again. Staging is on ` +
        `demand: a deploy on every merge to \`main\` is what kept it billing ` +
        `30 days a month for ~5 days of use.`,
    ).toEqual([]);
  });

  it("nothing else stands staging up automatically either", () => {
    // The regression is not specific to release-image.yml — the same `uses:`
    // in any workflow with an automatic trigger puts staging back on the
    // release path under a different name.
    for (const file of workflowFiles()) {
      const doc = workflow(file);
      const calls = Object.values(doc.jobs ?? {}).some(
        (j) => calledWorkflow(j.uses) === DEPLOY,
      );
      if (!calls) continue;
      const triggers = Object.keys(doc.on ?? {});
      expect(
        triggers.filter((t) => t !== "workflow_dispatch"),
        `${file} calls ${DEPLOY} on ${triggers.join(", ")}. Staging comes up ` +
          `when someone asks for it, not when something merges.`,
      ).toEqual([]);
    }
  });

  it("any caller of deploy-staging.yml grants it `actions: read`", () => {
    // There is no caller today, which is the point of the two tests above — but
    // the coupling outlives the caller and fails silently when it returns. A
    // called workflow may narrow its caller's permissions and never widen them,
    // so a caller that forgets this regresses the image-tag steps to a
    // 900-second blind wait with the suite green and no annotation anywhere.
    for (const file of workflowFiles()) {
      const doc = workflow(file);
      for (const [job, body] of Object.entries(doc.jobs ?? {})) {
        if (calledWorkflow(body.uses) !== DEPLOY) continue;
        // A job-level block REPLACES the workflow-level one rather than merging
        // with it, so wherever it exists it is the whole answer.
        const perms =
          typeof body.permissions === "object"
            ? body.permissions
            : typeof doc.permissions === "object"
              ? doc.permissions
              : undefined;
        expect(
          perms?.actions,
          `${file} (${job}) calls ${DEPLOY} without granting \`actions: read\`.`,
        ).toBe("read");
      }
    }
  });

  it("release-image.yml still reaches prod, which was never downstream of the deploy", () => {
    // The whole safety argument for removing the deploy job: prod is notified by
    // a STEP inside build-and-push, not by anything the removed job fed.
    const release = readFileSync(RELEASE, "utf8");
    expect(release).toContain("strad-image-published");
    expect(release).toContain(
      "https://api.github.com/repos/tadasant/tadasant-internal/dispatches",
    );
  });
});

describe("teardown-staging.yml", () => {
  it("exists", () => {
    // Guard the guard: every assertion below reads this file.
    expect(existsSync(TEARDOWN), `${TEARDOWN} is missing`).toBe(true);
  });

  const doc = workflow(TEARDOWN);
  const run = scripts(TEARDOWN);

  it("runs nightly and on request", () => {
    expect(Object.keys(doc.on ?? {}).sort()).toEqual([
      "schedule",
      "workflow_dispatch",
    ]);
    // A `schedule:` with no cron is a workflow that never fires, and the bill it
    // exists to stop is invisible either way.
    const schedule = doc.on?.schedule as { cron?: string }[] | undefined;
    expect(schedule?.length).toBeGreaterThan(0);
    for (const entry of schedule ?? [])
      expect(entry.cron, "a schedule entry with no cron").toMatch(/\S/);
  });

  it("archives rather than deletes, because the domain does not survive a delete", () => {
    expect(
      run,
      `${TEARDOWN} runs \`doctl apps delete\`. Deleting the app takes ` +
        `staging.strad.tadasant.com with it for up to 24 hours and gives the ` +
        `replacement a different *.ondigitalocean.app hostname, which the ` +
        `Cloudflare CNAME names by hand. Archive it instead.`,
    ).not.toMatch(/doctl\s+apps\s+delete/);
    expect(
      run,
      `${TEARDOWN} does not set \`maintenance.archive\`, which is the only ` +
        `thing that stops App Platform billing for the components.`,
    ).toContain(".maintenance.archive = $want");
  });

  it("refuses to act on an app that is not strad-staging", () => {
    // The one thing between this workflow and archiving prod is a name resolved
    // out of a list, and archiving is a full outage of whatever it hits. The
    // spec that comes back has to agree.
    expect(run).toMatch(
      /NAME.*!=.*"strad-staging"|"\$NAME" != "strad-staging"/,
    );
    expect(run).toContain("Refusing to touch it");
  });

  it("cannot race a deploy", () => {
    // Both workflows PUT the whole app spec. Sharing the group with
    // `cancel-in-progress: false` makes the second one queue; a separate group
    // lets a scheduled archive read the spec before a deploy's PUT and write it
    // back after, handing staging the image the deploy had just replaced.
    const mine = (
      doc as unknown as {
        concurrency?: { group?: string; "cancel-in-progress"?: boolean };
      }
    ).concurrency;
    const theirs = (
      workflow(DEPLOY) as unknown as { concurrency?: { group?: string } }
    ).concurrency;
    expect(theirs?.group, `${DEPLOY} declares no concurrency group`).toMatch(
      /\S/,
    );
    expect(
      mine?.group,
      `${TEARDOWN} does not share ${DEPLOY}'s concurrency group, so a ` +
        `scheduled archive can interleave with a deploy.`,
    ).toBe(theirs?.group);
    expect(mine?.["cancel-in-progress"]).toBe(false);
  });

  it("holds no credential it does not need", () => {
    // It talks to DigitalOcean and to nothing else: no ghcr login, no GCP, no
    // checkout of this repo. `packages: write` here would put a registry
    // credential on a nightly schedule for no reason.
    expect(doc.permissions).toEqual({ contents: "read" });
    expect(run).not.toMatch(/GCP_SA_KEY|GHCR_PULL_TOKEN|GITHUB_TOKEN/);
  });

  it("says so rather than going green when it cannot ask", () => {
    // `awk` exits 0 on no match, so an unreachable API produces the same empty
    // app id as an app that genuinely is not there. A nightly run that reported
    // "nothing to archive" through an outage would hide exactly the bill this
    // workflow exists to stop.
    expect(run).toContain("doctl apps list failed");
  });
});
