/**
 * The rules a WRITE to a parameter must obey, and the ranking every reader holds
 * it to.
 *
 * ## Why this file exists on its own
 *
 * `servers/secrets` is a separate npm project with its own lockfile and its own
 * image, so it cannot import this one — and its write client mutates the SAME
 * two-store backend the console admin and the runtime resolver mutate. So these
 * rules are duplicated across the boundary by VENDORING: `npm run writerules:sync`
 * copies this file verbatim into
 * `servers/secrets/shared/src/parameter-write-rules.ts`, and
 * `test/vendored.sync.test.ts` fails CI when the copy drifts.
 * `test/parameter-write-rules.ownership.test.ts` is the seam's other half: byte
 * identity cannot see that tree growing a SECOND implementation beside the copy.
 *
 * Edit this file. Never edit the copy.
 *
 * ## Why the check is not optional
 *
 * Every rule below fails SILENTLY when the two halves disagree — the same reason
 * `wire.ts` is vendored (`HACKS.md` #33), arrived at from the mutating side.
 *
 * - **Ranking.** Parameter Manager has no `latest` alias for a parameter version,
 *   so "the current version" is a decision each caller makes for itself. Three of
 *   them make it — the console/resolver client, the `secrets` server's viewer, and
 *   its write client — and all three take the greatest NUMERIC suffix among
 *   ENABLED versions. Ranking by list order is the trap: Parameter Manager lists
 *   lexicographically, so `v9` sorts after `v12`.
 * - **Minting.** A writer that mints an id whose suffix is not a number writes a
 *   version every reader skips. `Date.now().toString(36)` is unique, legal, and
 *   ends in a letter most of the time — which reads as suffix 0 and sorts BELOW
 *   `v1`. The tool reports success and the value never takes effect.
 * - **The grant.** A secret parameter is born unresolvable: Parameter Manager
 *   dereferences a `__REF__` as the PARAMETER's own principal, not as whoever
 *   called `:render`, so every render is `400 SECRET_REFERENCE_ERROR` until that
 *   principal holds `secretAccessor` on the secret. Whichever half wrote the
 *   parameter has to add the binding, and has to add the same one.
 *
 * ## What belongs here
 *
 * The pure decisions, and nothing else. The HTTP that lists versions, POSTs one,
 * and reads-then-writes an IAM policy stays at each call site: the trees mint their
 * own tokens, page differently and raise different error types, and none of those
 * differences is a disagreement about which version is current or about what the
 * policy should say. That is the line — what the halves must AGREE on lives here;
 * how each of them talks to Google is its own.
 */

/** One parameter version, as a `parameterVersions.list` page describes it. */
export interface ListedVersion {
  name?: string;
  disabled?: boolean;
}

/**
 * The version id at the end of a `…/versions/{vid}` resource name.
 *
 * `undefined` in, `undefined` out: a listed version with no `name` is one there
 * is nothing to say about, and it is skipped rather than ranked or deleted.
 */
export function versionIdOf(name: string | undefined): string | undefined {
  return name?.split("/").pop();
}

/** The trailing run of digits in a version id, or 0 when it ends in anything else. */
function versionNumber(vid: string): number {
  return Number(/(\d+)$/.exec(vid)?.[1] ?? "0");
}

/**
 * The greatest `v{n}` among a parameter's ENABLED versions, or undefined.
 *
 * The caller lists the versions (paging is theirs); this is the part that has to
 * be the same everywhere. `n` comes back alongside `vid` because it is the number
 * the ranking actually compared, so a caller reasoning about the ordering reads it
 * rather than forming a second opinion about the same string.
 */
export function rankVersions(
  listed: ListedVersion[],
): { vid: string; n: number } | undefined {
  let best: { vid: string; n: number } | undefined;
  for (const v of listed) {
    if (v.disabled) continue;
    const vid = versionIdOf(v.name);
    if (!vid) continue;
    const n = versionNumber(vid);
    if (!best || n > best.n) best = { vid, n };
  }
  return best;
}

/**
 * The id the next version gets: `v{n+1}`, from the same suffix `rankVersions`
 * reads. `undefined` — a parameter with no enabled version — mints `v1`.
 */
export function nextVersionId(current: string | undefined): string {
  return `v${(current ? versionNumber(current) : 0) + 1}`;
}

/**
 * The role a parameter's own principal needs on every secret it references.
 *
 * `:render` does NOT dereference a `__REF__` as the caller — it derefs as the
 * PARAMETER, so the caller's `secretAccessor` is the wrong grant to reason about
 * and granting it to the resolver does not make a single reference resolve.
 */
export const SECRET_ACCESSOR_ROLE = "roles/secretmanager.secretAccessor";

/**
 * One binding in a Secret Manager IAM policy.
 *
 * `condition` is carried opaquely and never interpreted — it exists here so a
 * read-modify-write preserves a conditional binding it does not understand rather
 * than dropping it on the way back.
 */
export interface IamBinding {
  role: string;
  members?: string[];
  condition?: unknown;
}

/** A Secret Manager IAM policy, as `getIamPolicy` returns it. */
export interface IamPolicy {
  bindings?: IamBinding[];
  etag?: string;
  version?: number;
}

/**
 * `policy` with `principal` holding `secretAccessor` — or `null` when it already
 * does and there is nothing to write.
 *
 * The caller does the two HTTP calls around this, and the READ half of them has a
 * requirement this function cannot enforce: it must ask for
 * `options.requestedPolicyVersion=3`. Without it IAM answers with a version-1
 * VIEW that omits every CONDITIONAL binding, and writing that view back deletes
 * them — a read-modify-write that cannot see part of what it is rewriting is a
 * destructive one.
 *
 * The binding this appends to is an UNCONDITIONAL one, specifically. One role may
 * appear in several bindings distinguished by `condition`, and appending the
 * principal to a conditional one grants access only while that condition holds —
 * which fails exactly like no grant at all, from a policy that reads as correct.
 *
 * `policy` is not mutated: the bindings and their member lists are copied before
 * the edit, so a caller that logs or retries against what it read still holds
 * what it read.
 */
export function withSecretAccessor(
  policy: IamPolicy,
  principal: string,
): IamPolicy | null {
  const bindings = (policy.bindings ?? []).map((b) => ({
    ...b,
    members: [...(b.members ?? [])],
  }));
  const binding = bindings.find(
    (b) => b.role === SECRET_ACCESSOR_ROLE && b.condition === undefined,
  );
  if (binding?.members.includes(principal)) return null;
  if (binding) binding.members.push(principal);
  else bindings.push({ role: SECRET_ACCESSOR_ROLE, members: [principal] });
  return { ...policy, bindings };
}
