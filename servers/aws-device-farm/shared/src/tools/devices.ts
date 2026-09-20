import {
  args,
  boundedInt,
  enumString,
  guard,
  ok,
  optionalBool,
  optionalString,
  type DepsFactory,
  type ToolDefinition,
} from "./shared.js";

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;

const PLATFORMS = ["IOS", "ANDROID"] as const;
const POOL_TYPES = ["CURATED", "PRIVATE"] as const;

/**
 * Which phone to work on.
 *
 * DEFAULTS TO WHAT AN AGENT ACTUALLY WANTS: a real iPhone, free right now, that
 * can be driven interactively. Device Farm's own list is every device it owns
 * in arrival order, most of them Android tablets and half of them BUSY, and an
 * agent taking the first row of that gets a device it then waits behind.
 */
export function listDevicesTool(deps: DepsFactory): ToolDefinition {
  return {
    name: "list_devices",
    description:
      "Real phones and tablets this Device Farm project can use, newest OS " +
      "and most-available first. Defaults to iOS devices that are free right " +
      "now and can take a remote-access session — which is what an agent " +
      "about to drive an app wants; pass the filters to widen it.\n\n" +
      'Example: {"devices":[{"arn":"arn:aws:devicefarm:us-west-2::device:1A2B",' +
      '"name":"Apple iPhone 15 Pro","model":"iPhone 15 Pro","os":"17.5.1",' +
      '"platform":"IOS","form_factor":"PHONE","availability":"HIGHLY_AVAILABLE",' +
      '"remote_access_enabled":true,"resolution":"1179x2556"}],"returned":1}\n\n' +
      "`availability`: HIGHLY_AVAILABLE and AVAILABLE can be had now; BUSY " +
      "means somebody else has it and the session queues; " +
      "TEMPORARY_NOT_AVAILABLE means it is out of the fleet.\n\n" +
      "`remote_access_enabled` false means the device can still run an " +
      "automated run but cannot be driven interactively — Device Farm offers " +
      "only a SUBSET of its fleet for remote access.\n\n" +
      "The `arn` is what start_device_session and schedule_run take.\n\n" +
      "Use cases: picking a phone to reproduce a bug on; checking a specific " +
      "iOS version is in the fleet before promising a test on it; finding a " +
      "free device when a session failed on concurrency.",
    inputSchema: {
      type: "object",
      properties: {
        platform: {
          type: "string",
          enum: [...PLATFORMS],
          description: "IOS (default) or ANDROID.",
        },
        os_version: {
          type: "string",
          description:
            'Exactly this OS version, e.g. "17.5.1". Device Farm matches the ' +
            "string as written, so a partial version matches nothing.",
        },
        min_os_version: {
          type: "string",
          description:
            'At least this OS version, e.g. "17.0". Compared as a string by ' +
            "Device Farm, which is right within a major version and gets " +
            '"9.0" vs "10.0" wrong.',
        },
        model_contains: {
          type: "string",
          description:
            'Case-sensitive substring of the model, e.g. "iPhone 15" or "SE".',
        },
        available_only: {
          type: "boolean",
          description:
            "Only devices that can be had now (AVAILABLE or " +
            "HIGHLY_AVAILABLE). Default: true.",
        },
        remote_access_only: {
          type: "boolean",
          description:
            "Only devices that can be driven interactively. Default: true. " +
            "Set false when scheduling an automated run, which does not need it.",
        },
        limit: {
          type: "integer",
          description: `How many devices to return (1-${MAX_LIMIT}). Default: ${DEFAULT_LIMIT}.`,
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    handler: (raw) =>
      guard(async () => {
        const input = args(raw);
        const osVersion = optionalString(input, "os_version");
        const minOsVersion = optionalString(input, "min_os_version");
        const modelContains = optionalString(input, "model_contains");
        const { devices, truncated } = await (
          await deps()
        ).gateway.listDevices({
          platform: enumString(input, "platform", PLATFORMS) ?? "IOS",
          ...(osVersion === undefined ? {} : { os_version: osVersion }),
          ...(minOsVersion === undefined ? {} : { min_os_version: minOsVersion }),
          ...(modelContains === undefined ? {} : { model_contains: modelContains }),
          available_only: optionalBool(input, "available_only") ?? true,
          remote_access_only: optionalBool(input, "remote_access_only") ?? true,
          limit: boundedInt(input, "limit", DEFAULT_LIMIT, MAX_LIMIT),
        });
        return ok({
          devices,
          returned: devices.length,
          // Said rather than implied. A caller that reads an empty list and
          // concludes Device Farm has no iPhones is the failure this prevents:
          // the usual cause is `available_only` during a busy hour.
          ...(devices.length === 0
            ? {
                note:
                  "No device matched. The defaults are strict: available now, " +
                  "and remote-access capable. Try available_only=false to see " +
                  "what exists but is busy.",
              }
            : {}),
          ...(truncated ? { truncated: true } : {}),
        });
      }),
  };
}

/**
 * The saved device selections a run can name.
 *
 * A pool is Device Farm's own abstraction and `schedule_run` takes either one
 * of these or a list of device ARNs. CURATED pools ("Top Devices") are AWS's
 * and exist in every project; PRIVATE ones are the account's.
 */
export function listDevicePoolsTool(deps: DepsFactory): ToolDefinition {
  return {
    name: "list_device_pools",
    description:
      "Device pools in this project — the saved device selections schedule_run " +
      "can name instead of a list of device ARNs. Every project has AWS's " +
      "CURATED pools; PRIVATE ones are this account's own.\n\n" +
      'Example: {"pools":[{"arn":"arn:aws:devicefarm:us-west-2::devicepool:top",' +
      '"name":"Top Devices","type":"CURATED","max_devices":5,' +
      '"description":"Top devices"}],"returned":1}\n\n' +
      "A pool of five devices is FIVE runs' worth of device-minutes, billed " +
      "per device. For verifying one build, one device ARN from list_devices " +
      "is the cheaper instrument.\n\n" +
      "Use cases: running a regression across a curated fleet; reusing a pool " +
      "the console already has; checking what a saved pool actually contains " +
      "before a run spends on it.",
    inputSchema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: [...POOL_TYPES],
          description:
            "CURATED (AWS's own pools) or PRIVATE (this account's). Omit for both.",
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    handler: (raw) =>
      guard(async () => {
        const input = args(raw);
        const pools = await (
          await deps()
        ).gateway.listDevicePools(enumString(input, "type", POOL_TYPES));
        return ok({ pools, returned: pools.length });
      }),
  };
}
