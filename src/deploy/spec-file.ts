/**
 * Read a rendered App Platform spec back off disk, and refuse to deploy one
 * that is not the spec this job rendered.
 *
 * ## Why this exists
 *
 * `render-spec` writes a file; `doctl apps update --spec <file>` reads it. Those
 * are two different steps, minutes apart, and NOTHING between them checked that
 * the bytes doctl reads are the bytes render-spec wrote.
 *
 * They were not, on 2026-08-06. Both this repo's staging deploy and
 * tadasant-internal's prod deploy wrote the same absolute path, `/tmp/spec.json`,
 * and both run on the same self-hosted machine (`ci-runner-2`) under different
 * runner processes — which share `/tmp`. Prod's render step opened that path for
 * writing at 11:29:38.75, truncating staging's spec to zero bytes; staging's
 * `doctl apps update` read it at 11:29:40.05, 1.3 seconds inside the two-second
 * window before prod finished writing at 11:29:40.78.
 *
 * doctl did not complain. An empty document parses as YAML `null`, decodes into
 * a zero-valued `godo.AppSpec` without error, and is PUT as `{"spec":{}}`. The
 * only symptom was DigitalOcean's answer to a spec with no fields at all:
 *
 *     400 error validating app spec field ".name": .name in body is required
 *
 * — a message about the FIRST required field of an empty object, which reads like
 * a renderer bug and is not one. The render was byte-identical (82713 bytes) to
 * the deploy that had succeeded the day before.
 *
 * The path collision is fixed at the source (`deploy-staging.yml` renders into
 * `$RUNNER_TEMP`, which is per-runner and wiped between jobs). This is the
 * second line: whatever the file is, it is checked immediately before it is
 * handed to doctl, so a spec that is empty, truncated, or simply somebody
 * else's fails HERE, by name, instead of arriving as an opaque 400.
 *
 * ## What it checks, and why each one
 *
 * `expectedName` is the load-bearing one and the reason this is not just a
 * `jq -e .name` in the workflow. Had prod's render finished one second earlier,
 * staging's doctl would have read a perfectly valid 91302-byte spec — PROD's,
 * naming `strad-prod`, carrying prod's images and prod's secrets — and pushed it
 * onto the staging app. That deploy would have gone green. Asserting the name
 * matches the app this job set out to deploy is what makes the near-miss loud.
 *
 * Nothing here prints spec CONTENT. The file holds secret values (see
 * `scripts/render-spec.ts`), so failures name fields and counts only.
 */

/** The parts of an App Platform spec this check has an opinion about. */
export interface SpecSummary {
  /** The spec's top-level `name` — the App Platform app it addresses. */
  name: string;
  /** Component names, in spec order. Safe to log; they are config, not secrets. */
  components: string[];
  /** Size of the file as read, in bytes. Useful in the run log as a tripwire. */
  bytes: number;
  /**
   * The spec re-serialised COMPACT, in bytes.
   *
   * `bytes` above is the file as written, and `render-spec` writes with an
   * indent — so the two differ by the formatting, and only this one is
   * comparable to the per-component figures below. Both are reported because
   * they answer different questions: `bytes` is what a byte count of the file
   * says (and is therefore what the observations behind
   * `LARGEST_ACCEPTED_SPEC_BYTES` are of), and this is what the parts add up to.
   */
  compactBytes: number;
  /**
   * Bytes per component, COMPACT and largest first — where the spec's size
   * actually went. Sums to a little under `compactBytes`, the remainder being
   * the spec's own top-level fields.
   *
   * Safe to log: it is a component name and a number, and both are config. It
   * exists because the total on its own answers nothing. When prod's spec was
   * refused for size on 2026-08-30 the deploy log carried one figure, so working
   * out which component had grown, and by what, took a session of archaeology
   * against two runs' worth of GitHub API. One line would have said it.
   */
  componentBytes: { name: string; bytes: number }[];
  /**
   * A sentence about the spec's size, when there is one worth saying, and
   * `undefined` otherwise. See `sizeAdvisory`.
   */
  sizeAdvisory?: string;
}

/**
 * The largest App Platform spec DigitalOcean has been observed to ACCEPT from
 * this repo's renderer: 131,010 bytes, `strad-prod`, 2026-08-30T04:01Z
 * (tadasant-internal run 33291566037).
 *
 * ## This is an observation, not a documented limit
 *
 * DigitalOcean publishes no app-spec size limit. What is known is two data
 * points, both from the same day and the same app: 131,010 bytes deployed, and
 * 141,342 bytes came back
 *
 *     400 error validating app spec field "App spec": size limit exceeded
 *
 * (run 33330369567, 19:18Z). So the real ceiling is somewhere in
 * `(131010, 141342]` and nothing here knows where. 128 KiB is 131,072 — 62 bytes
 * above the accepted spec — which makes it look like the answer and is not
 * evidence of anything. Do not turn this into a hard gate on that basis; a
 * wrongly-placed hard gate fails deploys that would have worked, which is worse
 * than the failure it is guarding.
 *
 * It is used only to WARN, and the warning's job is to make growth visible while
 * there is still room to act on it. What prod was actually in was headroom
 * nobody had measured — somewhere between 1 and 10,332 bytes, since the accepted
 * spec deployed and one 10,332 bytes larger did not.
 *
 * Raise this if a larger spec is observed to deploy; that is a better
 * measurement, not a weakening.
 */
export const LARGEST_ACCEPTED_SPEC_BYTES = 131_010;

import { isKnownInstanceSize } from "./instance-size.ts";

/**
 * The share of `LARGEST_ACCEPTED_SPEC_BYTES` above which the size is worth a
 * sentence in the deploy log. 80% of it is ~105 KB — far enough below the
 * unknown ceiling that a deploy which trips this still has room to land.
 */
const ADVISORY_FRACTION = 0.8;

/**
 * A sentence about `bytes`, or `undefined` when there is nothing to say.
 *
 * Never throws and never fails a deploy: every branch is advisory. The caller
 * decides whether that reaches the log as a `::warning::` or as plain text.
 */
export function sizeAdvisory(bytes: number): string | undefined {
  const evidence =
    `DigitalOcean documents no app-spec size limit; what is observed is ` +
    `${LARGEST_ACCEPTED_SPEC_BYTES} bytes accepted and 141342 rejected with ` +
    `"size limit exceeded", both on 2026-08-30, so the ceiling is somewhere ` +
    `between them.`;
  if (bytes > LARGEST_ACCEPTED_SPEC_BYTES) {
    return (
      `this spec is ${bytes} bytes — larger than any spec this deployment is ` +
      `known to have deployed. ${evidence} It may be refused. ` +
      `src/deploy/config-inline.ts covers where a strad spec's bytes go.`
    );
  }
  if (bytes > LARGEST_ACCEPTED_SPEC_BYTES * ADVISORY_FRACTION) {
    return (
      `this spec is ${bytes} bytes, within ` +
      `${LARGEST_ACCEPTED_SPEC_BYTES - bytes} of the largest one known to have ` +
      `deployed. ${evidence}`
    );
  }
  return undefined;
}

export interface AssertSpecOptions {
  /**
   * The app name this job rendered and therefore intends to update. A spec
   * naming anything else is another deployment's, and deploying it would
   * succeed while doing the wrong thing.
   */
  expectedName?: string;
}

/** A spec that cannot be deployed, with a message that says which way. */
export class SpecFileError extends Error {}

function fail(detail: string): never {
  throw new SpecFileError(detail);
}

/**
 * Where a JSON parse gave up, and nothing else.
 *
 * `SyntaxError.message` is the one diagnostic here that is built from the INPUT
 * rather than about it, so it is mined for the position and otherwise discarded.
 */
function jsonFaultPosition(err: unknown): string {
  const at =
    err instanceof Error ? /\bat position (\d+)/.exec(err.message)?.[1] : null;
  return at ? ` — the parse gave up at byte ${at}` : "";
}

/**
 * A value's SHAPE, for an error message, without quoting the value.
 *
 * Anything in a rendered spec may be a secret, so a failure describes what it
 * found by type and never by content. Only `null` and the primitive types are
 * safe to name, and none of them can carry a value from the file.
 */
function shapeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  const type = typeof value;
  return `${/^[aeiou]/.test(type) ? "an" : "a"} ${type}`;
}

/**
 * Assert `text` is a deployable App Platform spec, and summarise it.
 *
 * Throws `SpecFileError` with a message naming the specific defect. Returns the
 * name and component list on success — never the spec, which holds secrets.
 */
export function assertDeployableSpec(
  text: string,
  opts: AssertSpecOptions = {},
): SpecSummary {
  const bytes = Buffer.byteLength(text, "utf8");

  // The observed failure. An empty file is the one shape doctl accepts in
  // silence, so it is the one worth naming first and in full.
  if (text.trim() === "") {
    fail(
      `the spec file is empty (${bytes} bytes). Nothing wrote it, or something ` +
        `truncated it after the render — doctl decodes an empty document into a ` +
        `spec with no fields and PUTs it, which DigitalOcean reports as ` +
        `".name in body is required".`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    // A partially-written file: the render was interrupted, or another writer
    // is mid-flight on the same path.
    //
    // The parser's own message is NOT passed through. V8 quotes the first ten
    // bytes of the input back at you when the fault is near the start
    // (`Unexpected token 's', "s3cret-tok"... is not valid JSON`), and this
    // file holds secret values — so the branch that exists for "the bytes are
    // not what we wrote" would print the bytes. Position only.
    fail(
      `the spec file is not valid JSON (${bytes} bytes)${jsonFaultPosition(err)}.`,
    );
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail(`the spec file does not hold a JSON object (got ${shapeOf(parsed)}).`);
  }

  const spec = parsed as Record<string, unknown>;

  // `doctl apps update --spec` takes a BARE spec and rejects an unknown
  // top-level "spec" key. Catching the envelope here says so in one line
  // instead of leaving a Go decoder to.
  if ("spec" in spec && !("name" in spec)) {
    fail(
      `the spec file is wrapped in a top-level "spec" key. doctl takes a BARE ` +
        `App Platform spec and wraps it itself.`,
    );
  }

  const name = spec.name;
  if (typeof name !== "string" || name.trim() === "") {
    // Described by shape, never quoted: a foreign file could park anything at
    // `.name`, including an object holding a credential.
    fail(
      `the spec has no top-level "name" (got ` +
        `${name === undefined ? "nothing" : typeof name === "string" ? "a blank string" : shapeOf(name)}). ` +
        `DigitalOcean rejects this as ".name in body is required".`,
    );
  }

  if (opts.expectedName !== undefined && name !== opts.expectedName) {
    fail(
      `the spec names app "${name}", but this deploy rendered ` +
        `"${opts.expectedName}". Deploying it would push another deployment's ` +
        `config — and its secrets — onto the wrong app.`,
    );
  }

  // `services`, and only `services`, because that is the only component list
  // `renderAppSpec` emits — every strad component is a service today. An App
  // Platform spec may also carry `static_sites`, `workers`, `jobs` and
  // `functions`, so this check follows the renderer rather than the platform,
  // and the first spec that ships one of those has to widen it.
  const services = spec.services;
  if (!Array.isArray(services) || services.length === 0) {
    fail(
      `the spec has no components ("services" is ` +
        `${Array.isArray(services) ? "empty" : shapeOf(services)}). ` +
        `An App Platform update is a full replace, so deploying it would ` +
        `delete every component on the app.`,
    );
  }

  const components: string[] = [];
  const componentBytes: { name: string; bytes: number }[] = [];
  for (const [i, svc] of services.entries()) {
    const svcName =
      svc !== null && typeof svc === "object" && !Array.isArray(svc)
        ? (svc as Record<string, unknown>).name
        : undefined;
    if (typeof svcName !== "string" || svcName.trim() === "") {
      fail(`component ${i} has no "name".`);
    }
    components.push(svcName);
    // The size, on the bytes doctl reads. `render-spec` already refuses a
    // config naming a plan DigitalOcean does not sell, but this check sits on
    // the FILE rather than on the renderer, so it holds for a spec whoever
    // wrote it — a hand-edited `spec.json`, or a future second renderer. An
    // unknown slug here is the one defect in this list the API reports
    // clearly, and it still costs a full deploy to find out.
    const svcSize = (svc as Record<string, unknown>).instance_size_slug;
    if (typeof svcSize === "string" && !isKnownInstanceSize(svcSize)) {
      fail(
        `component "${svcName}" asks for instance size "${svcSize}", which ` +
          `names no App Platform plan. DigitalOcean answers the update with ` +
          `\`unknown instance size\`, and the deploy fails at its last step. ` +
          `See src/deploy/instance-size.ts for the plans it sells.`,
      );
    }
    // Re-serialised rather than measured against the source text: the file's
    // own formatting is the renderer's choice (it writes with indent 2) and is
    // not what the API weighs. A component's compact JSON is the closest thing
    // to its share of the payload doctl actually PUTs.
    componentBytes.push({
      name: svcName,
      bytes: Buffer.byteLength(JSON.stringify(svc), "utf8"),
    });
  }
  componentBytes.sort((a, b) => b.bytes - a.bytes);

  return {
    name,
    components,
    bytes,
    compactBytes: Buffer.byteLength(JSON.stringify(spec), "utf8"),
    componentBytes,
    sizeAdvisory: sizeAdvisory(bytes),
  };
}
