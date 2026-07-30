import {
  mintAccessToken,
  SCOPE_CLOUD_PLATFORM,
  type FetchLike,
  type MintedToken,
  type ServiceAccount,
} from "./service-account.ts";

/**
 * What a credential can actually DO, asked of Google rather than declared.
 *
 * A feature flag says what a surface should OFFER. This says what the identity
 * behind it is PERMITTED. They are different questions and both are needed: the
 * flag is the product decision and the IAM grant is the boundary that cannot be
 * bypassed. Neither substitutes for the other, and where they disagree the
 * narrower one wins.
 *
 * The reason to probe rather than configure is that a flag can lie. A config
 * claiming write access on a read-only key produces a surface that lists a tool
 * and fails every call to it, with a Google 403 as the only explanation; a config
 * claiming read-only on a key that can in fact read secret values produces a
 * security property that exists in prose and not in IAM. A probe cannot drift,
 * because the thing it reports is the thing that will be enforced.
 *
 * `projects:testIamPermissions` on Cloud Resource Manager is the right call for
 * this: it takes arbitrary project-grantable permission strings and returns the
 * subset the caller holds. It is a QUERY, not an escalation — it reveals only
 * what this credential could already discover by trying the operation.
 *
 * WHEN THE PROBE CANNOT RUN we fail CLOSED but say so distinctly. "The store
 * denied this" and "I could not find out" want different words in front of a
 * human, and reporting the second as the first is how someone ends up widening
 * IAM to fix an unenabled API.
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
   * console that must not read secret values has to be denied `render` as well
   * as `versions.access`; withholding only the latter is not sufficient, and
   * `roles/parametermanager.admin` includes `render`.
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

export interface ProbeConfig {
  projectId: string;
  account: ServiceAccount;
  /** Test seams. Default to the real APIs. */
  crmApiBase?: string;
  tokenUrl?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

const DEFAULT_CRM_BASE = "https://cloudresourcemanager.googleapis.com";
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Ask Google which of `PROBE_PERMISSIONS` this credential holds on the project.
 *
 * Never throws. A probe is a capability question asked at startup or per page
 * render, and a store outage must not take the surface down — it must narrow it.
 */
export async function probeCapabilities(
  cfg: ProbeConfig,
): Promise<Capabilities> {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const base = cfg.crmApiBase ?? DEFAULT_CRM_BASE;
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const wanted = Object.values(PROBE_PERMISSIONS);

  let token: MintedToken;
  try {
    token = await mintAccessToken(cfg.account, {
      scope: SCOPE_CLOUD_PLATFORM,
      tokenUrl: cfg.tokenUrl,
      fetchImpl,
    });
  } catch (err) {
    // A malformed or rejected key. Report the SHAPE — the key is the payload.
    return {
      ...NO_CAPABILITIES,
      reason: `could not mint an access token for this credential (${describe(err)})`,
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(
      `${base}/v1/projects/${encodeURIComponent(cfg.projectId)}:testIamPermissions`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ permissions: wanted }),
        signal: controller.signal,
      },
    );
    if (!res.ok) {
      return {
        ...NO_CAPABILITIES,
        reason:
          `projects:testIamPermissions returned ${res.status}. The Cloud Resource Manager API ` +
          `may not be enabled on "${cfg.projectId}", or this credential may lack any access to it.`,
      };
    }
    const body = (await res.json()) as { permissions?: string[] };
    const held = new Set(body.permissions ?? []);
    const P = PROBE_PERMISSIONS;
    return {
      // EITHER read path counts. See PROBE_PERMISSIONS.renderParameter.
      readSecretValues:
        held.has(P.readSecretValue) || held.has(P.renderParameter),
      // A non-secret write needs the parameter half only.
      writeParameters:
        held.has(P.createParameter) && held.has(P.writeParameter),
      // A secret write needs BOTH stores — the secret and its first version —
      // AND the binding that makes the resulting `__REF__` resolvable. All three
      // are part of one `create()`, and a credential missing the last one fails
      // it and rolls back, so claiming otherwise offers a create that cannot land.
      writeSecretValues:
        held.has(P.createParameter) &&
        held.has(P.writeParameter) &&
        held.has(P.createSecret) &&
        held.has(P.writeSecretValue) &&
        held.has(P.readSecretIamPolicy) &&
        held.has(P.bindSecret),
      deleteParameters: held.has(P.deleteParameter),
      probed: true,
    };
  } catch (err) {
    return {
      ...NO_CAPABILITIES,
      reason: `projects:testIamPermissions did not complete (${describe(err)})`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The probe, MEMOISED with a TTL.
 *
 * An IAM grant changes on human timescales, and the probe costs a token mint
 * plus a round trip — doing it per page render would add latency to every view
 * for an answer that is stable for hours. The TTL bounds how long a REVOKED
 * permission keeps being offered; the operation itself still fails closed at
 * Google, so a stale `true` costs a legible error, not a leak.
 */
export function cachedProbe(
  cfg: ProbeConfig,
  ttlMs = 5 * 60_000,
  now: () => number = () => Date.now(),
  /**
   * A FAILED probe is cached far more briefly than a successful one. A grant
   * changes on human timescales, so five minutes is right for an answer; a
   * network blip is not an answer, and caching it that long would withhold
   * reveal long after the cause had passed.
   */
  failureTtlMs = 15_000,
): () => Promise<Capabilities> {
  let at = 0;
  let inFlight: Promise<Capabilities> | undefined;
  let value: Capabilities | undefined;

  return () => {
    const ttl = value?.probed === false ? failureTtlMs : ttlMs;
    if (value && now() - at < ttl) return Promise.resolve(value);
    inFlight ??= probeCapabilities(cfg)
      .then((caps) => {
        value = caps;
        at = now();
        return caps;
      })
      .finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  };
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
