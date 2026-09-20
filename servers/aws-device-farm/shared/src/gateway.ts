/**
 * Device Farm's API, reduced to the handful of operations an agent verifying an
 * app on a real phone actually performs — and to result shapes that fit in a
 * context window.
 *
 * WHAT IS LEFT OUT IS THE POINT. Device Farm answers with device objects
 * carrying a CPU record, a heap size, a fleet name and an instance list; a run
 * carries a network profile, a radio map and twenty more fields. An agent
 * choosing a phone needs the model, the OS and whether it is free, and a
 * `list_devices` that returned everything would cost thousands of tokens per
 * call to say so. Every projection below is deliberate; the raw field is one
 * `get_run` or one console click away.
 *
 * COST IS A FIRST-CLASS RESULT. Every shape that can report `deviceMinutes`
 * does, because this is the only server in this repo where an idle mistake
 * bills by the minute against somebody's card.
 */

import type { DeviceFarmApi } from "./client.js";
import { InputError } from "./errors.js";

/**
 * The public metered rate, as a number this server can multiply.
 *
 * It is $0.17 per device-minute for both automated runs and remote access, on
 * top of a one-time 1,000 free device-minute trial; the alternative is an
 * unmetered slot at $250/month, and automation slots and remote-access slots
 * are bought SEPARATELY. A quoted estimate is labelled with this basis wherever
 * it appears, because the rate is AWS's to change and this constant is not.
 */
export const METERED_USD_PER_MINUTE = 0.17;

export const COST_BASIS =
  `$${METERED_USD_PER_MINUTE.toFixed(2)}/device-minute, the public metered ` +
  `rate. Minutes covered by the 1,000-minute free trial or by an unmetered ` +
  `slot cost nothing, and this estimate does not know which you have — ` +
  `get_account_status does.`;

/** Device Farm's availability ladder, worst to best. */
export const AVAILABILITY = [
  "TEMPORARY_NOT_AVAILABLE",
  "BUSY",
  "AVAILABLE",
  "HIGHLY_AVAILABLE",
] as const;

export interface DeviceSummary {
  arn: string;
  name?: string;
  model?: string;
  os?: string;
  platform?: string;
  form_factor?: string;
  manufacturer?: string;
  availability?: string;
  remote_access_enabled?: boolean;
  resolution?: string;
}

export interface DevicePoolSummary {
  arn: string;
  name?: string;
  type?: string;
  description?: string;
  max_devices?: number;
}

export interface UploadSummary {
  arn: string;
  name?: string;
  type?: string;
  status?: string;
  created?: string;
  message?: string;
}

export interface DeviceMinutes {
  total?: number;
  metered?: number;
  unmetered?: number;
}

export interface RunSummary {
  arn: string;
  name?: string;
  type?: string;
  platform?: string;
  status?: string;
  result?: string;
  message?: string;
  counters?: Record<string, number>;
  device_minutes?: DeviceMinutes;
  estimated_metered_cost_usd?: number;
  cost_basis?: string;
  console_url?: string;
  jobs?: JobSummary[];
}

export interface JobSummary {
  arn: string;
  device?: string;
  os?: string;
  status?: string;
  result?: string;
  message?: string;
}

export interface SessionSummary {
  arn: string;
  name?: string;
  status?: string;
  result?: string;
  message?: string;
  device?: DeviceSummary;
  app_upload?: string;
  created?: string;
  started?: string;
  stopped?: string;
  device_minutes?: DeviceMinutes;
  estimated_metered_cost_usd?: number;
  cost_basis?: string;
  /**
   * Whether the session's Appium endpoint exists yet. The URL ITSELF IS NEVER
   * RETURNED — it carries its own authorisation in its path, so anyone holding
   * the string can drive the phone. The driving tools resolve it internally.
   */
  drivable?: boolean;
}

export interface ArtifactSummary {
  arn: string;
  name?: string;
  type?: string;
  extension?: string;
  /** A pre-signed URL. Device Farm expires these; re-list to get a fresh one. */
  url?: string;
}

const ISO = (value: unknown): string | undefined =>
  value instanceof Date ? value.toISOString() : undefined;

function money(minutes: number | undefined): number | undefined {
  if (minutes === undefined) return undefined;
  return Math.round(minutes * METERED_USD_PER_MINUTE * 100) / 100;
}

function deviceMinutes(raw: unknown): DeviceMinutes | undefined {
  const m = raw as DeviceMinutes | undefined;
  if (!m) return undefined;
  return { total: m.total, metered: m.metered, unmetered: m.unmetered };
}

export function summarizeDevice(raw: Record<string, unknown>): DeviceSummary {
  const res = raw.resolution as { width?: number; height?: number } | undefined;
  return {
    arn: String(raw.arn ?? ""),
    name: raw.name as string | undefined,
    model: raw.model as string | undefined,
    os: raw.os as string | undefined,
    platform: raw.platform as string | undefined,
    form_factor: raw.formFactor as string | undefined,
    manufacturer: raw.manufacturer as string | undefined,
    availability: raw.availability as string | undefined,
    remote_access_enabled: raw.remoteAccessEnabled as boolean | undefined,
    resolution:
      res?.width && res?.height ? `${res.width}x${res.height}` : undefined,
  };
}

function summarizeSession(raw: Record<string, unknown>): SessionSummary {
  const endpoints = raw.endpoints as { remoteDriverEndpoint?: string } | undefined;
  const minutes = deviceMinutes(raw.deviceMinutes);
  return {
    arn: String(raw.arn ?? ""),
    name: raw.name as string | undefined,
    status: raw.status as string | undefined,
    result: raw.result as string | undefined,
    message: raw.message as string | undefined,
    device: raw.device
      ? summarizeDevice(raw.device as Record<string, unknown>)
      : undefined,
    app_upload: raw.appUpload as string | undefined,
    created: ISO(raw.created),
    started: ISO(raw.started),
    stopped: ISO(raw.stopped),
    device_minutes: minutes,
    estimated_metered_cost_usd: money(minutes?.metered),
    cost_basis: minutes?.metered === undefined ? undefined : COST_BASIS,
    drivable: Boolean(endpoints?.remoteDriverEndpoint),
  };
}

function summarizeRun(raw: Record<string, unknown>, jobs?: JobSummary[]): RunSummary {
  const minutes = deviceMinutes(raw.deviceMinutes);
  return {
    arn: String(raw.arn ?? ""),
    name: raw.name as string | undefined,
    type: raw.type as string | undefined,
    platform: raw.platform as string | undefined,
    status: raw.status as string | undefined,
    result: raw.result as string | undefined,
    message: raw.message as string | undefined,
    counters: raw.counters as Record<string, number> | undefined,
    device_minutes: minutes,
    estimated_metered_cost_usd: money(minutes?.metered),
    cost_basis: minutes?.metered === undefined ? undefined : COST_BASIS,
    console_url: raw.webUrl as string | undefined,
    jobs,
  };
}

export interface ListDevicesQuery {
  platform?: "IOS" | "ANDROID";
  os_version?: string;
  min_os_version?: string;
  model_contains?: string;
  remote_access_only?: boolean;
  available_only?: boolean;
  limit: number;
}

export interface ScheduleRunRequest {
  app_arn?: string;
  test_type: string;
  test_package_arn?: string;
  test_spec_arn?: string;
  device_pool_arn?: string;
  device_arns?: string[];
  name?: string;
  job_timeout_minutes?: number;
  skip_app_resign?: boolean;
  video_capture?: boolean;
}

export interface StartSessionRequest {
  device_arn: string;
  app_arn?: string;
  name?: string;
  skip_app_resign?: boolean;
  /**
   * The major Appium server version for the session's endpoint. Device Farm
   * REQUIRES one on iOS 27 and later and rejects the request without it; on
   * older devices it is optional and the service picks.
   */
  appium_version?: string;
}

/** How many pages of a paginated list this server will walk for one call. */
const MAX_PAGES = 10;

export interface DeviceFarmGateway {
  accountStatus(): Promise<Record<string, unknown>>;
  listDevices(query: ListDevicesQuery): Promise<{
    devices: DeviceSummary[];
    truncated: boolean;
  }>;
  listDevicePools(type?: string): Promise<DevicePoolSummary[]>;
  listUploads(type: string | undefined, limit: number): Promise<UploadSummary[]>;
  /** `CreateUpload` — reserves an ARN and a pre-signed PUT for the bytes. */
  createUpload(input: {
    name: string;
    type: string;
    contentType: string;
  }): Promise<{ upload: UploadSummary; url: string }>;
  getUpload(arn: string): Promise<UploadSummary>;
  scheduleRun(request: ScheduleRunRequest): Promise<RunSummary>;
  getRun(arn: string): Promise<RunSummary>;
  stopRun(arn: string): Promise<RunSummary>;
  listRunArtifacts(
    arn: string,
    kinds: string[],
  ): Promise<Record<string, ArtifactSummary[]>>;
  startSession(request: StartSessionRequest): Promise<SessionSummary>;
  getSession(arn: string): Promise<SessionSummary>;
  listSessions(limit: number): Promise<SessionSummary[]>;
  stopSession(arn: string): Promise<SessionSummary>;
  installToSession(sessionArn: string, appArn: string): Promise<void>;
  /** The raw session record, endpoints included. Internal to the driver pool. */
  rawSession(arn: string): Promise<Record<string, unknown>>;
}

export interface CreateGatewayOptions {
  api: DeviceFarmApi;
  projectArn: string;
}

/** Where a device sits on the availability ladder; -1 when Device Farm said nothing. */
function availabilityRank(value: string | undefined): number {
  return value === undefined
    ? -1
    : (AVAILABILITY as readonly string[]).indexOf(value);
}

export function createGateway(options: CreateGatewayOptions): DeviceFarmGateway {
  const { api, projectArn } = options;

  // A plain function rather than a method reference: `getSession` calls it, and
  // a gateway whose methods are destructured — which is what a tool file does —
  // would lose `this` and fail at the call site rather than at the boundary.
  const rawSession = async (arn: string): Promise<Record<string, unknown>> => {
    const res = await api.getRemoteAccessSession({ arn });
    return (res.remoteAccessSession ?? {}) as Record<string, unknown>;
  };

  async function pages<T>(
    fetchPage: (token?: string) => Promise<{ items: T[]; nextToken?: string }>,
    limit: number,
  ): Promise<{ items: T[]; truncated: boolean }> {
    const items: T[] = [];
    let token: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = await fetchPage(token);
      items.push(...result.items);
      token = result.nextToken;
      if (items.length >= limit || !token) break;
    }
    return { items: items.slice(0, limit), truncated: items.length > limit || Boolean(token) };
  }

  return {
    async accountStatus() {
      const res = await api.getAccountSettings();
      const s = (res.accountSettings ?? {}) as Record<string, unknown>;
      const trial = s.trialMinutes as { total?: number; remaining?: number } | undefined;
      return {
        aws_account: s.awsAccountNumber,
        free_trial_minutes_remaining: trial?.remaining,
        free_trial_minutes_total: trial?.total,
        // `unmeteredDevices` is a map of platform -> slot count. Present and
        // zero is the ordinary pay-as-you-go answer, and it is the one an agent
        // has to see: every minute it spends is billed.
        unmetered_automation_slots: s.unmeteredDevices,
        unmetered_remote_access_slots: s.unmeteredRemoteAccessDevices,
        max_slots: s.maxSlots,
        default_job_timeout_minutes: s.defaultJobTimeoutMinutes,
        skip_app_resign_default: s.skipAppResign,
        metered_rate_usd_per_minute: METERED_USD_PER_MINUTE,
        cost_basis: COST_BASIS,
      };
    },

    async listDevices(query) {
      // Only what Device Farm's filter grammar can say. `IN` is allowed on ARN,
      // OS_VERSION, MODEL, MANUFACTURER and INSTANCE_ARN and on nothing else,
      // and a boolean attribute takes the literal TRUE / FALSE — so
      // availability is filtered HERE, after the walk, rather than sent as an
      // `IN` the API would answer with an ArgumentException.
      const filters: { attribute: string; operator: string; values: string[] }[] = [];
      if (query.platform)
        filters.push({ attribute: "PLATFORM", operator: "EQUALS", values: [query.platform] });
      if (query.os_version)
        filters.push({ attribute: "OS_VERSION", operator: "EQUALS", values: [query.os_version] });
      if (query.min_os_version)
        filters.push({
          attribute: "OS_VERSION",
          operator: "GREATER_THAN_OR_EQUALS",
          values: [query.min_os_version],
        });
      if (query.model_contains)
        filters.push({ attribute: "MODEL", operator: "CONTAINS", values: [query.model_contains] });
      if (query.remote_access_only)
        filters.push({
          attribute: "REMOTE_ACCESS_ENABLED",
          operator: "EQUALS",
          values: ["TRUE"],
        });

      // The whole fleet (up to MAX_PAGES of it) is walked BEFORE ranking, so
      // "most available, newest OS first" is true of the fleet and not merely of
      // whichever devices AWS happened to list first. The walk is bounded by
      // pages, not by `limit`, for exactly that reason.
      const { items, truncated: pagesLeft } = await pages<Record<string, unknown>>(
        async (token) => {
          // Scoped to the project rather than the account: the project is what
          // the credential is for, and a device the project cannot use is not a
          // device an agent can start a session on.
          const res = await api.listDevices({
            arn: projectArn,
            filters,
            ...(token ? { nextToken: token } : {}),
          });
          return { items: (res.devices ?? []) as Record<string, unknown>[], nextToken: res.nextToken };
        },
        Number.MAX_SAFE_INTEGER,
      );

      const usable = items
        .map(summarizeDevice)
        .filter(
          (d) =>
            !query.available_only ||
            availabilityRank(d.availability) >= availabilityRank("AVAILABLE"),
        );

      // Most available first, then the newest OS: an agent that takes the
      // first row should get a phone it can have NOW, on a recent iOS.
      const ranked = usable.sort((a, b) => {
        const av = availabilityRank(b.availability) - availabilityRank(a.availability);
        if (av !== 0) return av;
        return (b.os ?? "").localeCompare(a.os ?? "", undefined, { numeric: true });
      });
      return {
        devices: ranked.slice(0, query.limit),
        truncated: pagesLeft || ranked.length > query.limit,
      };
    },

    async listDevicePools(type) {
      const res = await api.listDevicePools({
        arn: projectArn,
        ...(type ? { type } : {}),
      });
      return ((res.devicePools ?? []) as Record<string, unknown>[]).map((p) => ({
        arn: String(p.arn ?? ""),
        name: p.name as string | undefined,
        type: p.type as string | undefined,
        description: p.description as string | undefined,
        max_devices: p.maxDevices as number | undefined,
      }));
    },

    async listUploads(type, limit) {
      const { items } = await pages<Record<string, unknown>>(
        async (token) => {
          const res = await api.listUploads({
            arn: projectArn,
            ...(type ? { type } : {}),
            ...(token ? { nextToken: token } : {}),
          });
          return { items: (res.uploads ?? []) as Record<string, unknown>[], nextToken: res.nextToken };
        },
        limit,
      );
      return items.map((u) => ({
        arn: String(u.arn ?? ""),
        name: u.name as string | undefined,
        type: u.type as string | undefined,
        status: u.status as string | undefined,
        created: ISO(u.created),
        message: u.message as string | undefined,
      }));
    },

    async createUpload(input) {
      const res = await api.createUpload({
        projectArn,
        name: input.name,
        type: input.type,
        contentType: input.contentType,
      });
      const upload = (res.upload ?? {}) as Record<string, unknown>;
      return {
        upload: {
          arn: String(upload.arn ?? ""),
          name: upload.name as string | undefined,
          type: upload.type as string | undefined,
          status: upload.status as string | undefined,
          created: ISO(upload.created),
          message: upload.message as string | undefined,
        },
        url: String(upload.url ?? ""),
      };
    },

    async getUpload(arn) {
      const res = await api.getUpload({ arn });
      const upload = (res.upload ?? {}) as Record<string, unknown>;
      return {
        arn: String(upload.arn ?? ""),
        name: upload.name as string | undefined,
        type: upload.type as string | undefined,
        status: upload.status as string | undefined,
        created: ISO(upload.created),
        message: upload.message as string | undefined,
      };
    },

    async scheduleRun(request) {
      const named = (request.device_arns ?? []).length > 0;
      if (!request.device_pool_arn && !named) {
        throw new InputError(
          "A run needs devices: pass either `device_pool_arn` (from " +
            "list_device_pools) or `device_arns` (from list_devices). Device " +
            "Farm refuses a run that names neither.",
        );
      }
      if (request.device_pool_arn && named) {
        // Two answers to "which devices" is a question about which one was
        // meant, and a run is minutes on every device it lands on.
        throw new InputError(
          "Pass `device_pool_arn` or `device_arns`, not both: a run on a pool " +
            "AND a list is two different bills, and this refuses to guess which.",
        );
      }
      const res = await api.scheduleRun({
        projectArn,
        ...(request.app_arn ? { appArn: request.app_arn } : {}),
        ...(request.name ? { name: request.name } : {}),
        ...(request.device_pool_arn
          ? { devicePoolArn: request.device_pool_arn }
          : {
              deviceSelectionConfiguration: {
                filters: [
                  {
                    attribute: "ARN",
                    operator: "IN",
                    values: request.device_arns,
                  },
                ],
                maxDevices: request.device_arns!.length,
              },
            }),
        test: {
          type: request.test_type,
          ...(request.test_package_arn ? { testPackageArn: request.test_package_arn } : {}),
          ...(request.test_spec_arn ? { testSpecArn: request.test_spec_arn } : {}),
        },
        executionConfiguration: {
          // Video is the evidence. It is on by default in Device Farm and it is
          // named here anyway, because a run that produced no video is a run
          // nobody can review and the default is AWS's to change.
          videoCapture: request.video_capture ?? true,
          ...(request.job_timeout_minutes
            ? { jobTimeoutMinutes: request.job_timeout_minutes }
            : {}),
          ...(request.skip_app_resign === undefined
            ? {}
            : { skipAppResign: request.skip_app_resign }),
        },
      });
      return summarizeRun((res.run ?? {}) as Record<string, unknown>);
    },

    async getRun(arn) {
      const res = await api.getRun({ arn });
      const jobs = await api
        .listJobs({ arn })
        .then((j: { jobs?: Record<string, unknown>[] }) =>
          (j.jobs ?? []).map((job) => ({
            arn: String(job.arn ?? ""),
            device: (job.device as { name?: string } | undefined)?.name,
            os: (job.device as { os?: string } | undefined)?.os,
            status: job.status as string | undefined,
            result: job.result as string | undefined,
            message: job.message as string | undefined,
          })),
        )
        // A run that has not started yet has no jobs, and a jobs call that
        // fails must not cost the caller the run's own status — which is the
        // field it is polling for.
        .catch(() => undefined);
      return summarizeRun((res.run ?? {}) as Record<string, unknown>, jobs);
    },

    async stopRun(arn) {
      const res = await api.stopRun({ arn });
      return summarizeRun((res.run ?? {}) as Record<string, unknown>);
    },

    async listRunArtifacts(arn, kinds) {
      const out: Record<string, ArtifactSummary[]> = {};
      for (const kind of kinds) {
        const { items } = await pages<Record<string, unknown>>(
          async (token) => {
            const res = await api.listArtifacts({
              arn,
              type: kind,
              ...(token ? { nextToken: token } : {}),
            });
            return {
              items: (res.artifacts ?? []) as Record<string, unknown>[],
              nextToken: res.nextToken,
            };
          },
          200,
        );
        out[kind.toLowerCase()] = items.map((a) => ({
          arn: String(a.arn ?? ""),
          name: a.name as string | undefined,
          type: a.type as string | undefined,
          extension: a.extension as string | undefined,
          url: a.url as string | undefined,
        }));
      }
      return out;
    },

    async startSession(request) {
      const res = await api.createRemoteAccessSession({
        projectArn,
        deviceArn: request.device_arn,
        ...(request.app_arn ? { appArn: request.app_arn } : {}),
        ...(request.name ? { name: request.name } : {}),
        ...(request.skip_app_resign === undefined
          ? {}
          : { skipAppResign: request.skip_app_resign }),
        ...(request.appium_version === undefined
          ? {}
          : { configuration: { parameters: { "appium:version": request.appium_version } } }),
      });
      return summarizeSession((res.remoteAccessSession ?? {}) as Record<string, unknown>);
    },

    rawSession,

    async getSession(arn) {
      return summarizeSession(await rawSession(arn));
    },

    async listSessions(limit) {
      const { items } = await pages<Record<string, unknown>>(
        async (token) => {
          const res = await api.listRemoteAccessSessions({
            arn: projectArn,
            ...(token ? { nextToken: token } : {}),
          });
          return {
            items: (res.remoteAccessSessions ?? []) as Record<string, unknown>[],
            nextToken: res.nextToken,
          };
        },
        limit,
      );
      return items.map(summarizeSession);
    },

    async stopSession(arn) {
      const res = await api.stopRemoteAccessSession({ arn });
      return summarizeSession((res.remoteAccessSession ?? {}) as Record<string, unknown>);
    },

    async installToSession(sessionArn, appArn) {
      await api.installToRemoteAccessSession({
        remoteAccessSessionArn: sessionArn,
        appArn,
      });
    },
  };
}
