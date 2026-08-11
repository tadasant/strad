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
  viewerAccount: "SENSITIVE_VIEWER_ACCOUNT",
  defaultLinkDays: "LINK_DEFAULT_DAYS",
  uploadBaseUrl: "UPLOAD_BASE_URL",
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

/** Default life of an upload lease returned by get_upload_url, in minutes. */
export const DEFAULT_UPLOAD_URL_MINUTES = 15;

/** Longest upload lease this server will mint. */
export const MAX_UPLOAD_URL_MINUTES = 60;

/** Largest body accepted by the temporary POST endpoint. */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

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
  /**
   * The one account within {@link viewerDomain} that restricted links should
   * name, e.g. "dana@tadasant.com". Optional, and only ever a HINT: it selects
   * which of the reader's signed-in Google accounts the browser front door
   * authenticates as. It grants nothing — the `domain-` ACL is what grants — so
   * every member of the domain can still open the artifact, whatever this says.
   * See `authenticatedBrowserUrl` for why a link without it 403s.
   */
  viewerAccount?: string;
  /** Default link life in days. Falls back to DEFAULT_LINK_DAYS. */
  defaultLinkDays: number;
  /**
   * Optional public origin used to make upload URLs absolute. When absent the
   * tool returns a root-relative URL; the core gateway serves the same path.
   */
  uploadBaseUrl?: string;
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

  const uploadBaseUrl = read("uploadBaseUrl");
  if (uploadBaseUrl !== undefined) {
    try {
      // URL parsing is intentionally stricter than "string that looks URL-ish":
      // callers paste this into curl, and a malformed base would create a lease
      // that cannot be used.
      new URL(uploadBaseUrl);
    } catch {
      throw new ConfigError(
        `${envName(prefix, "uploadBaseUrl")} must be a valid absolute URL when set.`,
      );
    }
  }

  const viewerDomain = read("viewerDomain");
  const viewerAccount = read("viewerAccount")?.trim();
  if (viewerAccount !== undefined) {
    // Checked at boot rather than at link time. This value's only job is to be
    // pasted into a URL a human clicks, and every way of getting it wrong fails
    // in the reader's browser — days later, as a 403 with no server-side trace.
    const at = viewerAccount.indexOf("@");
    if (at <= 0 || at !== viewerAccount.lastIndexOf("@") || at === viewerAccount.length - 1) {
      throw new ConfigError(
        `${envName(prefix, "viewerAccount")}="${viewerAccount}" must be a full email ` +
          `address (e.g. "dana@example.com"). Google's account selector takes an ` +
          `address, not a bare username or domain.`,
      );
    }
    if (!viewerDomain) {
      throw new ConfigError(
        `${envName(prefix, "viewerAccount")} is set but ${envName(prefix, "viewerDomain")} ` +
          `is not. The account is only a hint about WHICH signed-in account opens a ` +
          `restricted link; the domain is what actually grants access, so without it ` +
          `sensitive uploads are refused and the hint has nothing to point at.`,
      );
    }
    const accountDomain = viewerAccount.slice(at + 1);
    if (accountDomain.toLowerCase() !== viewerDomain.toLowerCase()) {
      throw new ConfigError(
        `${envName(prefix, "viewerAccount")}="${viewerAccount}" is not in ` +
          `${envName(prefix, "viewerDomain")}="${viewerDomain}". A restricted artifact is ` +
          `granted to the DOMAIN, so naming an account outside it would send every reader ` +
          `to an account that is not on the ACL.`,
      );
    }
  }

  return {
    bucket,
    projectId: read("projectId"),
    clientEmail: read("clientEmail"),
    privateKey: read("privateKey"),
    rootPath: read("rootPath"),
    viewerDomain,
    viewerAccount,
    defaultLinkDays,
    uploadBaseUrl: uploadBaseUrl?.replace(/\/$/, ""),
  };
}
