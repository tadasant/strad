import { tokenMinter, type ServiceAccount } from "./google-auth.js";

/**
 * What THIS server's credential can do — asked of Google, at startup.
 *
 * The tool surface is derived from this rather than from a feature flag, and the
 * reason is not tidiness. A flag that claims write access on a read-only key
 * produces a server that ADVERTISES a tool and fails every call to it with an
 * opaque 403; a flag that claims read-only on a key that can in fact read secret
 * values produces a security property that exists in a config file and not in
 * IAM. The probe cannot drift from reality, because the thing it reports is the
 * thing Google will enforce.
 *
 * So: prod's viewer key is read-only, the probe says so, and the write tools are
 * never listed there — while staging's key can write, and they are. One image,
 * one code path, two surfaces, and neither is asserted by hand.
 *
 * THE VIEWER PROPERTY IS UNCHANGED BY THIS. In prod the credential holds no
 * `secretmanager.versions.access`, so `get_parameter` still cannot return a
 * secret value — and now it does not even offer to. The probe makes the surface
 * match the boundary; it does not move the boundary.
 *
 * FAIL CLOSED. A probe that cannot run yields no capabilities, so an unreachable
 * Cloud Resource Manager API degrades this server to the read-only surface it has
 * always had rather than opening anything.
 */

export const PROBE_PERMISSIONS = {
  readSecretValue: "secretmanager.versions.access",
  writeSecretValue: "secretmanager.versions.add",
  createSecret: "secretmanager.secrets.create",
  /**
   * The IAM half of a secret create. `create()` in write-client.ts grants the
   * PARAMETER's own principal `secretAccessor` on the secret it points at —
   * without it every `:render` of that parameter answers
   * `400 SECRET_REFERENCE_ERROR`. A credential that can write the values but not
   * the binding fails the create and rolls it back, so both belong in the
   * `writeSecretValues` answer. Kept identical to the src/ copy.
   */
  readSecretIamPolicy: "secretmanager.secrets.getIamPolicy",
  bindSecret: "secretmanager.secrets.setIamPolicy",
  createParameter: "parametermanager.parameters.create",
  /**
   * A secret create reads `policyMember.iamPolicyUidPrincipal` off the parameter
   * as the first call of the grant, so this is part of a secret write too.
   * Kept identical to the src/ copy.
   */
  readParameter: "parametermanager.parameters.get",
  writeParameter: "parametermanager.parameterVersions.create",
  deleteParameter: "parametermanager.parameters.delete",
  /**
   * The SECOND read path. `:render` derefs a `__REF__` as the PARAMETER's own
   * principal, not the caller's, so `render` without
   * `secretmanager.versions.access` returns a secret value — `create()` grants
   * that principal `secretAccessor`, so the path is open rather than theoretical.
   * `readValue` in write-client.ts uses exactly this call, so a credential
   * holding only `render` genuinely can read one. Kept identical to the src/ copy.
   */
  renderParameter: "parametermanager.parameterVersions.render",
} as const;

export interface Capabilities {
  /** May read a SECRET parameter's value (`:render` deref, or SM access). */
  readSecretValues: boolean;
  /** May create parameters and add versions. */
  writeParameters: boolean;
  /** May write SECRET values — needs both stores. */
  writeSecretValues: boolean;
  /** May delete a parameter. */
  deleteParameters: boolean;
  /** False means every flag above is a fail-closed default, not an observation. */
  probed: boolean;
  reason?: string;
}

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
  crmApiBase?: string;
  tokenUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const DEFAULT_CRM_BASE = "https://cloudresourcemanager.googleapis.com";

/** Never throws. See the header: a probe that fails narrows the surface. */
export async function probeCapabilities(
  cfg: ProbeConfig,
): Promise<Capabilities> {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const base = cfg.crmApiBase ?? DEFAULT_CRM_BASE;
  const timeoutMs = cfg.timeoutMs ?? 10_000;

  let token: string;
  try {
    token = await tokenMinter({
      account: cfg.account,
      tokenUrl: cfg.tokenUrl,
      fetchImpl,
    })();
  } catch (err) {
    return {
      ...NO_CAPABILITIES,
      reason: `could not mint an access token (${describe(err)})`,
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
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          permissions: Object.values(PROBE_PERMISSIONS),
        }),
        signal: controller.signal,
      },
    );
    if (!res.ok) {
      return {
        ...NO_CAPABILITIES,
        reason:
          `projects:testIamPermissions returned ${res.status}; ` +
          `cloudresourcemanager.googleapis.com may not be enabled on "${cfg.projectId}"`,
      };
    }
    const body = (await res.json()) as { permissions?: string[] };
    const held = new Set(body.permissions ?? []);
    const P = PROBE_PERMISSIONS;
    const params =
      held.has(P.createParameter) && held.has(P.writeParameter);
    return {
      // EITHER read path counts. See PROBE_PERMISSIONS.renderParameter.
      readSecretValues:
        held.has(P.readSecretValue) || held.has(P.renderParameter),
      writeParameters: params,
      // Both stores AND the binding: see PROBE_PERMISSIONS.bindSecret. A create
      // that cannot grant the parameter its own access rolls back.
      writeSecretValues:
        params &&
        held.has(P.createSecret) &&
        held.has(P.writeSecretValue) &&
        held.has(P.readParameter) &&
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

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
