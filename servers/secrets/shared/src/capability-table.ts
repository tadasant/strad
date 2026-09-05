// GENERATED — DO NOT EDIT.
// Vendored from src/secrets/parameters/capability-table.ts by `npm run capabilities:sync`.
// Edit the source, run the sync, and commit both. CI fails if these drift.
/**
 * The capability probe's TABLE and its FOLD: ten of Google's permission strings,
 * and what an answer about them is taken to MEAN.
 *
 * ONE QUESTION, TWO DOORS. strad has two surfaces that ask it about the same
 * kind of credential — the console gates reveal and the write affordances on the
 * answer (`src/ui/index.ts`), and the `secrets` MCP server derives its ENTIRE
 * tool list from it (`servers/secrets/shared/src/tools.ts`). They live in
 * different npm trees and cannot import across the boundary, so this module is
 * VENDORED: `npm run capabilities:sync`, checked by `test/vendored.sync.test.ts`.
 * Edit this file, never the copy.
 *
 * What differs between the two is TRANSPORT — each tree mints its own token and
 * makes its own `fetch` — and that is deliberately not here. What must not
 * differ is which permissions are asked about and what the answer means, because
 * a drift there is silent in BOTH directions. Widen one copy and the MCP surface
 * keeps listing a write tool for a credential the console has just decided
 * cannot complete the write; narrow one copy — a plausible-looking typo is
 * enough — and a permission Google does not recognise simply comes back outside
 * the held set, reads as "not granted", and withholds a tool from a credential
 * that holds it. Neither says anything.
 *
 * IT IMPORTS NOTHING, and that is a constraint rather than a coincidence: the
 * copy is compiled by `servers/secrets`' own `tsc`, in a tree where nothing this
 * file could import exists.
 */

/** The permissions strad cares about, and what each one unlocks. */
export const PROBE_PERMISSIONS = {
  /** Read a SECRET value — the console's reveal, the resolver's inject. */
  readSecretValue: "secretmanager.versions.access",
  /** Add a new secret version — rotate, and the write half of create. */
  writeSecretValue: "secretmanager.versions.add",
  /** Create a Secret Manager secret — the other write half of create. */
  createSecret: "secretmanager.secrets.create",
  /**
   * Read and set a secret's IAM policy — the THIRD write half of a secret
   * create, and the one that is easy to forget because no value passes through
   * it.
   *
   * `create()` grants the parameter's own principal `secretAccessor` on the
   * secret it points at, because `:render` derefs as the parameter rather than
   * as the caller. Without these two permissions the create fails partway and
   * rolls back — so a credential that holds every value-writing permission and
   * not these cannot write a secret parameter at all. Probing for them is what
   * keeps the console from advertising a create it will not complete.
   */
  readSecretIamPolicy: "secretmanager.secrets.getIamPolicy",
  bindSecret: "secretmanager.secrets.setIamPolicy",
  /** Create a parameter — the index entry every parameter needs. */
  createParameter: "parametermanager.parameters.create",
  /**
   * Read a parameter resource. A secret create needs it: the grant above reads
   * `policyMember.iamPolicyUidPrincipal` off the parameter, and that read is the
   * FIRST call of the grant — so without this a create dies after both stores
   * have been written and rolls back.
   */
  readParameter: "parametermanager.parameters.get",
  /** Add a parameter version — every write goes through one. */
  writeParameter: "parametermanager.parameterVersions.create",
  /** Delete a parameter. */
  deleteParameter: "parametermanager.parameters.delete",
  /**
   * The SECOND read path, and the reason `versions.access` alone is not the
   * whole answer.
   *
   * Parameter Manager's `:render` dereferences a `__REF__` into the secret's
   * value, and it does NOT deref as the caller — it derefs as the PARAMETER's
   * own principal. So a credential holding `render` but not `versions.access`
   * still gets a secret value back, because `create()` grants that principal
   * `secretAccessor` on every secret it writes — without which nothing resolves
   * at all.
   *
   * This path is therefore OPEN, and `render` is a read permission in full. A
   * credential that must not read secret values has to be denied `render` as
   * well as `versions.access`; withholding only the latter is not sufficient,
   * and `roles/parametermanager.admin` includes `render`.
   *
   * OPERATIONAL INVARIANT, and it is load-bearing rather than defence-in-depth:
   * prod's `secrets` MCP credential must never hold
   * `roles/parametermanager.parameterAccessor`. That role carries `render`, and
   * withholding it is now the ONLY thing keeping `/mcp` away from a prod secret
   * value. `parameterViewer` is the read role; `parameterAccessor` is the deref,
   * which their names do not suggest. `test/parameters.store.test.ts` asserts
   * the property so it fails CI rather than opening quietly.
   */
  renderParameter: "parametermanager.parameterVersions.render",
} as const;

export interface Capabilities {
  /** Can this credential read a SECRET parameter's value? */
  readSecretValues: boolean;
  /** Can it create parameters and add versions (non-secret writes)? */
  writeParameters: boolean;
  /** Can it write SECRET values (create a secret, add a version)? */
  writeSecretValues: boolean;
  /** Can it delete a parameter? */
  deleteParameters: boolean;
  /**
   * Did the probe actually complete? False means every flag above is a
   * fail-closed DEFAULT, not an observation.
   */
  probed: boolean;
  /** Why the probe did not complete, for a message a human can act on. */
  reason?: string;
}

/** Fail closed: no capability is assumed without an answer from Google. */
export const NO_CAPABILITIES: Capabilities = Object.freeze({
  readSecretValues: false,
  writeParameters: false,
  writeSecretValues: false,
  deleteParameters: false,
  probed: false,
});

/**
 * What the permissions Google says this credential holds add up to.
 *
 * Pure, and deliberately separate from the call that obtains `held`: this is the
 * half that has to be the same on both doors, and the transport is the half that
 * legitimately is not.
 *
 * `probed: true` is part of the answer rather than something a caller adds. A
 * fold only happens on a `testIamPermissions` that CAME BACK — including the
 * empty answer that is prod's normal state, a credential told it holds none of
 * them. Every path that did not come back returns `NO_CAPABILITIES` and a reason
 * instead, and the difference between "denied" and "could not find out" is the
 * one this whole subsystem is careful about.
 */
export function capabilitiesFromHeld(held: Set<string>): Capabilities {
  const P = PROBE_PERMISSIONS;
  // A non-secret write needs the parameter half only.
  const writeParameters =
    held.has(P.createParameter) && held.has(P.writeParameter);
  return {
    // EITHER read path counts. See PROBE_PERMISSIONS.renderParameter.
    readSecretValues:
      held.has(P.readSecretValue) || held.has(P.renderParameter),
    writeParameters,
    // A secret write needs BOTH stores — the secret and its first version — AND
    // the binding that makes the resulting `__REF__` resolvable. All three are
    // part of one `create()`, and a credential missing the last one fails it and
    // rolls back, so claiming otherwise offers a create that cannot land.
    writeSecretValues:
      writeParameters &&
      held.has(P.createSecret) &&
      held.has(P.writeSecretValue) &&
      held.has(P.readParameter) &&
      held.has(P.readSecretIamPolicy) &&
      held.has(P.bindSecret),
    deleteParameters: held.has(P.deleteParameter),
    probed: true,
  };
}
