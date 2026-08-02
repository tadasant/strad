/**
 * Configuration, read from the environment under a SLUG-NAMESPACED prefix.
 *
 * WHY A PREFIX AND NOT THE BARE `GCS_*` NAMES. This server and the `gcs` server
 * live in one container (the strad bundle) and point at DIFFERENT buckets. One
 * process cannot hold two values of `GCS_BUCKET`, so this server never reads the
 * bare names: the bundle host constructs it with
 * `envPrefix: "REMOTE_FILESYSTEM_TMP_PUBLIC"` and every key below is looked up
 * under that prefix. Delete the prefix and the two servers silently share a
 * bucket, which is the bug this indirection exists to prevent.
 */

/** The suffixes appended to the env prefix. */
export const ENV_SUFFIXES = {
  bucket: "GCS_BUCKET",
  projectId: "GCS_PROJECT_ID",
  clientEmail: "GCS_CLIENT_EMAIL",
  privateKey: "GCS_PRIVATE_KEY",
  rootPath: "GCS_ROOT_PATH",
  viewerDomain: "SENSITIVE_VIEWER_DOMAIN",
  defaultLinkDays: "LINK_DEFAULT_DAYS",
} as const;

/**
 * The default life of a link handed to a human, in days.
 *
 * Fourteen, not seven, is a deliberate product choice: an artifact is usually
 * looked at days after it is made, and a dead link is the failure this server
 * exists to avoid. Seven days is the ceiling of GCS's V4 signing process, so a
 * link longer than that is signed with V2 — see links.ts, which owns that
 * decision and explains the tradeoff.
 */
export const DEFAULT_LINK_DAYS = 14;

/** The longest link this server will mint. A year is already generous. */
export const MAX_LINK_DAYS = 365;

export interface StoreConfig {
  /** The one bucket every operation is scoped to. */
  bucket: string;
  projectId?: string;
  /** Service-account credentials. Absent means Application Default Credentials. */
  clientEmail?: string;
  privateKey?: string;
  /** Optional prefix confinement. Unset in production — see README. */
  rootPath?: string;
  /**
   * The Google Workspace domain that may open a SENSITIVE artifact, e.g.
   * "tadasant.com". Sensitive uploads are refused when this is unset, because
   * storing an artifact nobody can open is a worse outcome than a loud failure.
   */
  viewerDomain?: string;
  /** Default link life in days. Falls back to DEFAULT_LINK_DAYS. */
  defaultLinkDays: number;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** The env var name this deployment uses for a given config key. */
export function envName(
  prefix: string,
  key: keyof typeof ENV_SUFFIXES,
): string {
  return prefix ? `${prefix}_${ENV_SUFFIXES[key]}` : ENV_SUFFIXES[key];
}

export function loadConfig(
  prefix: string,
  env: NodeJS.ProcessEnv = process.env,
): StoreConfig {
  const read = (key: keyof typeof ENV_SUFFIXES): string | undefined => {
    const value = env[envName(prefix, key)];
    return value && value.trim() !== "" ? value : undefined;
  };

  const bucket = read("bucket");
  if (!bucket) {
    throw new ConfigError(
      `${envName(prefix, "bucket")} must be configured. ` +
        `This server does NOT read the bare GCS_BUCKET — that name belongs to the ` +
        `gcs server, which points at a different bucket in the same container.`,
    );
  }

  const rawDays = read("defaultLinkDays");
  let defaultLinkDays = DEFAULT_LINK_DAYS;
  if (rawDays !== undefined) {
    const parsed = Number(rawDays);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > MAX_LINK_DAYS) {
      throw new ConfigError(
        `${envName(prefix, "defaultLinkDays")}="${rawDays}" is not a number of days between 1 and ${MAX_LINK_DAYS}.`,
      );
    }
    defaultLinkDays = parsed;
  }

  return {
    bucket,
    projectId: read("projectId"),
    clientEmail: read("clientEmail"),
    privateKey: read("privateKey"),
    rootPath: read("rootPath"),
    viewerDomain: read("viewerDomain"),
    defaultLinkDays,
  };
}
