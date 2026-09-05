import {
  capabilitiesFromHeld,
  NO_CAPABILITIES,
  PROBE_PERMISSIONS,
  type Capabilities,
} from "./capability-table.js";
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
 *
 * WHAT IS ASKED, AND WHAT THE ANSWER MEANS, IS NOT HERE. The ten permission
 * strings and the fold into four booleans are `./capability-table.js`, a module
 * vendored from core so that the console and this server derive their surfaces
 * from one table rather than from two that agree today. This file is the
 * transport around it: this tree's own token mint and its own `fetch`, which
 * genuinely differ from core's.
 *
 * ONE PROBE PER PROJECT, AND NEVER A SHARED ANSWER. This server fronts a LIST of
 * stores, each a different GCP project reached with a different service account,
 * and `projects:testIamPermissions` answers about exactly one project as exactly
 * one identity. So a `Capabilities` is only ever meaningful ALONGSIDE the project
 * it was asked about: `CapabilityLookup` is the only way a caller obtains one,
 * and it takes a project id.
 *
 * WHY THAT IS THE WHOLE POINT. A single flat answer shared across stores would
 * mean one over-grant on the most permissive project switching a capability on
 * for every other project in the list — including a production store whose entire
 * guarantee is that it cannot return a secret value. The failure would be silent:
 * the tool would simply start working. `anyPermits` below exists for the tool
 * LIST and for nothing else, and it is named so that a gate site reaching for it
 * by mistake reads wrong.
 */

export {
  capabilitiesFromHeld,
  NO_CAPABILITIES,
  PROBE_PERMISSIONS,
  type Capabilities,
};

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
    // An empty body is Google's way of saying "none of them" — an answer, not a
    // failure, and prod's normal one.
    return capabilitiesFromHeld(new Set(body.permissions ?? []));
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

/**
 * The capability of ONE store, by project id.
 *
 * Every gate in tools.ts goes through this, having first resolved the parameter
 * path to the store that owns it. A project this server does not front, or one
 * whose probe never ran, answers `NO_CAPABILITIES` — fail closed.
 */
export type CapabilityLookup = (project: string) => Promise<Capabilities>;

/**
 * The union, for the TOOL LIST alone.
 *
 * An MCP tool list is static per container and a multi-store server has a
 * heterogeneous surface: one store may permit a secret read while another must
 * never. There is no way to list a tool for one store and not another, so the
 * list is the union — a tool is offered when SOME store can back it — and every
 * handler then refuses per store using `CapabilityLookup`. Advertising the union
 * without enforcing per store would be the collapse this module exists to
 * prevent; the two halves ship together or not at all.
 *
 * `probed` is conjunctive on purpose: it means "every store answered", so a
 * report built from this cannot claim to have established something it did not.
 */
export function anyPermits(caps: Iterable<Capabilities>): Capabilities {
  const all = [...caps];
  if (all.length === 0) return NO_CAPABILITIES;
  return {
    readSecretValues: all.some((c) => c.readSecretValues),
    writeParameters: all.some((c) => c.writeParameters),
    writeSecretValues: all.some((c) => c.writeSecretValues),
    deleteParameters: all.some((c) => c.deleteParameters),
    probed: all.every((c) => c.probed),
    reason: all.find((c) => !c.probed)?.reason,
  };
}
