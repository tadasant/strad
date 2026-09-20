/**
 * The five environment variables this server runs on, and the errors a human
 * gets when one of them is wrong.
 *
 * ONE IAM PRINCIPAL, AND IT IS NOT THE CONTAINER'S. The AWS SDK's default
 * credential chain reads `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` out of
 * the process environment, and this server shares a process with twenty-two
 * others. So the credential is read under NAMES OF ITS OWN and passed to the
 * client explicitly, and the default chain is never consulted: a stray AWS
 * variable belonging to some other mount must not become the identity this
 * server schedules paid device runs with. `loadConfig` fails when the two names
 * below are absent rather than falling back to anything.
 *
 * THE REGION IS A CLOSED SET OF ONE. Device Farm's device cloud is served from
 * `us-west-2` and from nowhere else — the AWS general reference lists exactly
 * one endpoint, `devicefarm.us-west-2.amazonaws.com`. A deployment that sets
 * anything else is not choosing a nearer rack, it is choosing a hostname that
 * does not resolve to Device Farm, so the value is validated here against the
 * regions Device Farm is known to serve. If AWS adds one, this constant is what
 * needs editing — that is a smaller failure than silently signing requests for
 * an endpoint that answers nothing.
 */

export const ENV = {
  accessKeyId: "AWS_DEVICE_FARM_ACCESS_KEY_ID",
  secretAccessKey: "AWS_DEVICE_FARM_SECRET_ACCESS_KEY",
  projectArn: "AWS_DEVICE_FARM_PROJECT_ARN",
  region: "AWS_DEVICE_FARM_REGION",
  maxUploadMb: "AWS_DEVICE_FARM_MAX_UPLOAD_MB",
} as const;

/** Every region AWS serves the Device Farm control plane from. */
export const REGIONS = ["us-west-2"] as const;

export type DeviceFarmRegion = (typeof REGIONS)[number];

/**
 * How much of a build this server will hold in memory at once.
 *
 * An upload is buffered rather than streamed, because the pre-signed S3 PUT
 * Device Farm hands back needs a `Content-Length` and a source URL is not
 * obliged to declare one. The bundle is a 2 GB box shared with a Chromium, so
 * the ceiling is a real bound and not a formality — see
 * `docs/limitations.md`.
 */
export const DEFAULT_MAX_UPLOAD_MB = 192;

/** The ceiling the variable may raise the default to. Device Farm's own file limit is 4 GB. */
export const MAX_UPLOAD_MB_CEILING = 1024;

export interface DeviceFarmConfig {
  accessKeyId: string;
  /** Secret. Never logged, never returned in an error — see logging.ts. */
  secretAccessKey: string;
  /** `arn:aws:devicefarm:us-west-2:<account>:project:<uuid>` — the one project this mount works in. */
  projectArn: string;
  region: DeviceFarmRegion;
  maxUploadBytes: number;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * How to get the credential. Repeated in the config error because the error is
 * the only documentation an agent mid-call can see.
 */
const HOW_TO_GET_IT =
  `${ENV.accessKeyId} and ${ENV.secretAccessKey} are an IAM access key for a ` +
  `user whose only policy is the Device Farm actions this server calls, and ` +
  `${ENV.projectArn} is the ARN of the Device Farm project it works in ` +
  `(Device Farm console -> Project settings, or \`aws devicefarm ` +
  `list-projects\`). A human places all three in strad's secret store through ` +
  `the console at /ui/secrets; an agent never holds the value. The full ` +
  `walkthrough is docs/servers/aws-device-farm-setup.`;

/** The variables this deployment is missing, in declaration order. */
export function missingCredentials(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  // The PROJECT ARN counts. Unlike a region or an upload ceiling it has no
  // default that could be right, and every call this server makes names it — a
  // deployment without one lists tools that all fail, which is what `degraded`
  // on /healthz is for.
  return [ENV.accessKeyId, ENV.secretAccessKey, ENV.projectArn].filter(
    (name) => (env[name] ?? "").trim() === "",
  );
}

export function readRegion(
  env: NodeJS.ProcessEnv = process.env,
): DeviceFarmRegion {
  const raw = env[ENV.region]?.trim();
  if (raw === undefined || raw === "") return REGIONS[0];
  // Safe to quote — a region name is not a credential — and quoting it is what
  // makes a pasted "us-west-2 " diagnosable.
  if (!(REGIONS as readonly string[]).includes(raw)) {
    throw new ConfigError(
      `${ENV.region}="${raw}" is not a region AWS Device Farm is served from. ` +
        `Use one of: ${REGIONS.join(", ")}. Device Farm's device cloud lives ` +
        `in ${REGIONS[0]} only — the devices are physical phones in one place ` +
        `— so this is not a latency choice. Omit the variable entirely for ` +
        `${REGIONS[0]}.`,
    );
  }
  return raw as DeviceFarmRegion;
}

export function readMaxUploadBytes(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env[ENV.maxUploadMb]?.trim();
  if (raw === undefined || raw === "") return DEFAULT_MAX_UPLOAD_MB * 1024 * 1024;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_UPLOAD_MB_CEILING) {
    throw new ConfigError(
      `${ENV.maxUploadMb}="${raw}" is not a whole number of megabytes between ` +
        `1 and ${MAX_UPLOAD_MB_CEILING}. It bounds how much of a build this ` +
        `server holds in memory while uploading it; the default is ` +
        `${DEFAULT_MAX_UPLOAD_MB}.`,
    );
  }
  return parsed * 1024 * 1024;
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
): DeviceFarmConfig {
  // The region and the ceiling are read FIRST, so a deployment with a typo in
  // one of them hears about the thing a human can fix without minting anything.
  const region = readRegion(env);
  const maxUploadBytes = readMaxUploadBytes(env);
  const missing = missingCredentials(env);
  if (missing.length > 0) {
    throw new ConfigError(
      `AWS Device Farm is not configured: ${missing.join(", ")} ` +
        `${missing.length === 1 ? "is" : "are"} not set. ${HOW_TO_GET_IT}`,
    );
  }
  const projectArn = env[ENV.projectArn]!.trim();
  if (!projectArn.startsWith("arn:aws:devicefarm:")) {
    throw new ConfigError(
      `${ENV.projectArn}="${projectArn}" is not a Device Farm ARN. It must ` +
        `start with "arn:aws:devicefarm:" — the project ARN, not the project ` +
        `name and not the console URL.`,
    );
  }
  return {
    accessKeyId: env[ENV.accessKeyId]!.trim(),
    secretAccessKey: env[ENV.secretAccessKey]!.trim(),
    projectArn,
    region,
    maxUploadBytes,
  };
}
