/**
 * Servers: list, read, metrics, actions, and the writes that change one —
 * create, power, rebuild, resize, snapshot, delete.
 *
 * ACTIONS ARE ASYNCHRONOUS. Every write returns at once with an action whose
 * `status` is `running`; whether it worked is only known by polling get_action
 * until `success` or `error`. Every write here says so and hands back the
 * action id, because "the API accepted it" and "the server is off" are
 * different facts and an agent that conflates them reports work done that is
 * not.
 *
 * NO TOOL HERE TURNS PROTECTION OFF. Hetzner's delete and rebuild protection is
 * the fence a human put up on purpose; a delete or rebuild against a protected
 * server fails with `protected`, and the error says a human lifts it.
 */

import { InputError } from "../errors.js";
import { listPage } from "../client.js";
import {
  args,
  BLAST_RADIUS,
  CREATE,
  DESTRUCTIVE,
  DESTRUCTIVE_IDEMPOTENT,
  enumValue,
  guard,
  idOrName,
  NAME_AND_LABEL_PROPERTIES,
  optionalBool,
  optionalInt,
  optionalLabels,
  optionalString,
  optionalStringArray,
  pageArgs,
  PAGE_PROPERTIES,
  pick,
  READ,
  requiredString,
  resourceId,
  type ClientFactory,
  type ToolDefinition,
} from "./shared.js";

type Row = Record<string, unknown>;

const SERVER_ID = {
  type: "integer",
  minimum: 1,
  description: "The server's numeric id, from list_servers.",
};

export function serverId(input: Record<string, unknown>): number {
  return resourceId(
    input,
    "server_id",
    "a server's numeric id (from list_servers)",
  );
}

export const SERVER_STATUSES = [
  "running",
  "initializing",
  "starting",
  "stopping",
  "off",
  "deleting",
  "migrating",
  "rebuilding",
  "unknown",
] as const;

/**
 * A server with the fields an agent acts on, and the addresses flattened. The
 * raw object nests the location two deep under `datacenter`, repeats the whole
 * server type with its price table, and carries traffic counters; get_server
 * returns it in full.
 */
export function summariseServer(raw: unknown): Row {
  const s = (raw && typeof raw === "object" ? raw : {}) as Row;
  const type = (s.server_type ?? {}) as Row;
  const dc = (s.datacenter ?? {}) as Row;
  const location = (dc.location ?? {}) as Row;
  const image = s.image as Row | null | undefined;
  const pub = (s.public_net ?? {}) as Row;
  const v4 = pub.ipv4 as Row | null | undefined;
  const v6 = pub.ipv6 as Row | null | undefined;
  const priv = Array.isArray(s.private_net) ? (s.private_net as Row[]) : [];
  const firewalls = Array.isArray(pub.firewalls)
    ? (pub.firewalls as Row[]).map((f) => f.id)
    : [];
  return {
    ...pick(s, ["id", "name", "status", "created", "locked"]),
    server_type: type.name,
    cores: type.cores,
    memory_gb: type.memory,
    disk_gb: s.primary_disk_size ?? type.disk,
    architecture: type.architecture,
    location: location.name,
    datacenter: dc.name,
    image: image ? (image.name ?? image.description) : null,
    public_ipv4: v4?.ip ?? null,
    public_ipv6: v6?.ip ?? null,
    private_ips: priv.map((n) => ({ network: n.network, ip: n.ip })),
    firewall_ids: firewalls,
    ...pick(s, ["protection", "rescue_enabled", "labels"]),
  };
}

export function listServersTool(factory: ClientFactory): ToolDefinition {
  return {
    name: "list_servers",
    description:
      "Servers (virtual machines) in the Hetzner Cloud project, one page at a " +
      "time, summarised: id, name, status, server_type, cores, memory_gb, " +
      "disk_gb, architecture, location, datacenter, image, public IPv4/IPv6, " +
      "private IPs, firewall_ids, protection, labels. Use get_server for the " +
      "full record.\n\n" +
      "`status`: running, initializing, starting, stopping, off, deleting, " +
      "migrating, rebuilding, unknown. `locked: true` means an action is " +
      "still running on it.\n\n" +
      'Example row: {"id":42,"name":"ci-runner-2","status":"running",' +
      '"server_type":"ccx53","cores":32,"memory_gb":128,"location":"fsn1",' +
      '"public_ipv4":"203.0.113.10","protection":{"delete":true,' +
      '"rebuild":true},"labels":{"role":"ci"}}',
    inputSchema: {
      type: "object",
      properties: {
        ...NAME_AND_LABEL_PROPERTIES,
        status: {
          type: "array",
          items: { type: "string", enum: [...SERVER_STATUSES] },
          description: 'Only servers in one of these states, e.g. ["off"].',
        },
        ...PAGE_PROPERTIES,
      },
      additionalProperties: false,
    },
    annotations: READ,
    handler: (raw) =>
      guard(factory, async (api) => {
        const input = args(raw);
        const status = optionalStringArray(input, "status");
        for (const s of status ?? []) {
          if (!(SERVER_STATUSES as readonly string[]).includes(s)) {
            throw new InputError(
              `\`status\` "${s}" is not one of: ${SERVER_STATUSES.join(", ")}.`,
            );
          }
        }
        const { page, perPage } = pageArgs(input);
        const result = await listPage<Row>(
          api(),
          "/servers",
          "servers",
          page,
          perPage,
          {
            name: optionalString(input, "name"),
            label_selector: optionalString(input, "label_selector"),
            status,
          },
        );
        return { ...result, items: result.items.map(summariseServer) };
      }),
  };
}

export function getServerTool(factory: ClientFactory): ToolDefinition {
  return {
    name: "get_server",
    description:
      "One server in full: the summary list_servers gives plus the complete " +
      "server type (with its prices), datacenter and image records, every " +
      "network interface, attached volume ids, backup window, ISO, placement " +
      "group, and this month's included / outgoing / ingoing traffic in bytes.",
    inputSchema: {
      type: "object",
      properties: { server_id: SERVER_ID },
      required: ["server_id"],
      additionalProperties: false,
    },
    annotations: READ,
    handler: (raw) =>
      guard(factory, async (api) => {
        const id = serverId(args(raw));
        const body = await api().request<{ server?: Row }>(`/servers/${id}`);
        return body?.server ?? {};
      }),
  };
}

export const METRIC_TYPES = ["cpu", "disk", "network"] as const;

/** The most points one series returns; the rest are summarised, not listed. */
export const MAX_POINTS = 120;
export const DEFAULT_POINTS = 30;
/** Hetzner keeps 30 days of metrics. */
export const MAX_METRIC_MINUTES = 30 * 24 * 60;

interface SeriesSummary {
  points: number;
  min: number | null;
  max: number | null;
  avg: number | null;
  last: number | null;
  last_at: string | null;
  /** `[iso, value]`, oldest first, thinned to at most `max_points`. */
  values: Array<[string, number]>;
}

/**
 * Hetzner returns each series as `[[unix_seconds, "string"], …]`. Summarised
 * here so the answer to "is the runner pegged" is `max`, not a 500-row table,
 * and thinned evenly (always keeping the newest point) so a chart still reads.
 */
export function summariseSeries(
  raw: unknown,
  maxPoints: number,
): SeriesSummary {
  const values = Array.isArray((raw as Row | undefined)?.values)
    ? ((raw as Row).values as unknown[])
    : [];
  const parsed: Array<[number, number]> = [];
  for (const v of values) {
    if (!Array.isArray(v) || v.length < 2) continue;
    const ts = Number(v[0]);
    const value = Number(v[1]);
    if (Number.isFinite(ts) && Number.isFinite(value)) parsed.push([ts, value]);
  }
  const iso = (ts: number) => new Date(ts * 1000).toISOString();
  const round = (n: number) => Math.round(n * 1000) / 1000;
  if (parsed.length === 0) {
    return {
      points: 0,
      min: null,
      max: null,
      avg: null,
      last: null,
      last_at: null,
      values: [],
    };
  }
  const nums = parsed.map(([, v]) => v);
  const stride = Math.max(1, Math.ceil(parsed.length / maxPoints));
  const thinned: Array<[number, number]> = [];
  for (
    let i = parsed.length - 1;
    i >= 0 && thinned.length < maxPoints;
    i -= stride
  ) {
    thinned.unshift(parsed[i]!);
  }
  const last = parsed[parsed.length - 1]!;
  return {
    points: parsed.length,
    min: round(Math.min(...nums)),
    max: round(Math.max(...nums)),
    avg: round(nums.reduce((a, b) => a + b, 0) / nums.length),
    last: round(last[1]),
    last_at: iso(last[0]),
    values: thinned.map(([ts, v]) => [iso(ts), round(v)]),
  };
}

export function getServerMetricsTool(factory: ClientFactory): ToolDefinition {
  return {
    name: "get_server_metrics",
    description:
      "CPU, disk or network metrics for one server over a recent window, each " +
      "series summarised (min, max, avg, last) with up to `max_points` evenly " +
      'spaced values. Use it to answer "is it busy / pegged / idle" before ' +
      "power-cycling anything.\n\n" +
      '`types` (default ["cpu"]):\n' +
      "- cpu — `cpu`: percent, where 100 is ONE core (a 32-core box tops out " +
      "near 3200)\n" +
      "- disk — `disk.0.iops.read|write` (ops/s) and " +
      "`disk.0.bandwidth.read|write` (bytes/s)\n" +
      "- network — `network.0.pps.in|out` (packets/s) and " +
      "`network.0.bandwidth.in|out` (bytes/s)\n\n" +
      'Example: {"server_id":42,"start":"…","end":"…","step_seconds":120,' +
      '"series":{"cpu":{"points":30,"min":2.1,"max":2975.4,"avg":1610.2,' +
      '"last":3011.9,"last_at":"…","values":[["…",2.1],…]}}}',
    inputSchema: {
      type: "object",
      properties: {
        server_id: SERVER_ID,
        types: {
          type: "array",
          items: { type: "string", enum: [...METRIC_TYPES] },
          description: 'Which metric families. Default ["cpu"].',
        },
        minutes: {
          type: "integer",
          minimum: 1,
          maximum: MAX_METRIC_MINUTES,
          description:
            "How far back from now. Default 60; at most 43200 (30 days, all Hetzner keeps).",
        },
        max_points: {
          type: "integer",
          minimum: 1,
          maximum: MAX_POINTS,
          description: `Values listed per series (1-${MAX_POINTS}). Default ${DEFAULT_POINTS}. The summary always covers every point.`,
        },
      },
      required: ["server_id"],
      additionalProperties: false,
    },
    annotations: READ,
    handler: (raw) =>
      guard(factory, async (api) => {
        const input = args(raw);
        const id = serverId(input);
        const types = optionalStringArray(input, "types") ?? ["cpu"];
        for (const t of types) {
          if (!(METRIC_TYPES as readonly string[]).includes(t)) {
            throw new InputError(
              `\`types\` "${t}" is not one of: ${METRIC_TYPES.join(", ")}.`,
            );
          }
        }
        const minutes = Math.min(
          optionalInt(input, "minutes", 1) ?? 60,
          MAX_METRIC_MINUTES,
        );
        const maxPoints = Math.min(
          optionalInt(input, "max_points", 1) ?? DEFAULT_POINTS,
          MAX_POINTS,
        );
        const end = new Date();
        const start = new Date(end.getTime() - minutes * 60_000);
        // A step that yields ~maxPoints samples, never under Hetzner's 1 s.
        const step = Math.max(1, Math.ceil((minutes * 60) / maxPoints));
        const body = await api().request<{
          metrics?: {
            start?: string;
            end?: string;
            step?: number;
            time_series?: Row;
          };
        }>(`/servers/${id}/metrics`, {
          query: {
            type: [...new Set(types)].join(","),
            start: start.toISOString(),
            end: end.toISOString(),
            step,
          },
        });
        const metrics = body?.metrics ?? {};
        const series: Record<string, SeriesSummary> = {};
        for (const [name, s] of Object.entries(metrics.time_series ?? {})) {
          series[name] = summariseSeries(s, maxPoints);
        }
        return {
          server_id: id,
          start: metrics.start ?? start.toISOString(),
          end: metrics.end ?? end.toISOString(),
          step_seconds: metrics.step ?? step,
          series,
        };
      }),
  };
}

const ACTION_STATUSES = ["running", "success", "error"] as const;

export function listServerActionsTool(factory: ClientFactory): ToolDefinition {
  return {
    name: "list_server_actions",
    description:
      "One server's actions, newest first: what was done to it (start_server, " +
      "stop_server, reboot_server, rebuild_server, change_server_type, " +
      "create_image, attach_volume, apply_firewall, …), when, and whether it " +
      "succeeded. Use it to see who rebooted a box, or which action holds a " +
      "`locked` server.\n\n" +
      'Example row: {"id":13,"command":"reboot_server","status":"success",' +
      '"progress":100,"started":"2026-11-16T09:00:00+00:00",' +
      '"finished":"2026-11-16T09:00:20+00:00","error":null}',
    inputSchema: {
      type: "object",
      properties: {
        server_id: SERVER_ID,
        status: {
          type: "string",
          enum: [...ACTION_STATUSES],
          description: "Only actions in this state.",
        },
        ...PAGE_PROPERTIES,
      },
      required: ["server_id"],
      additionalProperties: false,
    },
    annotations: READ,
    handler: (raw) =>
      guard(factory, async (api) => {
        const input = args(raw);
        const id = serverId(input);
        const status = enumValue(input, "status", ACTION_STATUSES);
        const { page, perPage } = pageArgs(input);
        return listPage<Row>(
          api(),
          `/servers/${id}/actions`,
          "actions",
          page,
          perPage,
          { status, sort: "id:desc" },
        );
      }),
  };
}

export function getActionTool(factory: ClientFactory): ToolDefinition {
  return {
    name: "get_action",
    description:
      "Poll one action — the `action_id` any write tool here handed back, on a " +
      "server, image, firewall or volume. `status` is running, success or " +
      "error; only `success` means the change happened, and `error` carries " +
      "Hetzner's reason. Poll every 5-10 s: a power change takes seconds, a " +
      "rebuild, resize or snapshot minutes.\n\n" +
      'Example: {"id":13,"command":"stop_server","status":"success",' +
      '"progress":100,"started":"…","finished":"…",' +
      '"resources":[{"id":42,"type":"server"}],"error":null}',
    inputSchema: {
      type: "object",
      properties: {
        action_id: {
          type: "integer",
          minimum: 1,
          description: "The action's id, from the write that started it.",
        },
      },
      required: ["action_id"],
      additionalProperties: false,
    },
    annotations: READ,
    handler: (raw) =>
      guard(factory, async (api) => {
        const id = resourceId(
          args(raw),
          "action_id",
          "an action's numeric id (the `action_id` a write returned)",
        );
        const body = await api().request<{ action?: Row }>(`/actions/${id}`);
        return body?.action ?? {};
      }),
  };
}

/** What every write returns: the action to poll, and how. */
function pollable(action: unknown, extra: Row = {}): Row {
  const a = (action && typeof action === "object" ? action : {}) as Row;
  return {
    ...extra,
    action_id: a.id,
    command: a.command,
    status: a.status,
    next: "Poll get_action with this action_id until status is success or error.",
  };
}

export function createServerTool(factory: ClientFactory): ToolDefinition {
  return {
    name: "create_server",
    description:
      "Create ONE server. It bills hourly from the moment it exists, whether " +
      "or not it is running. Returns the server (status `initializing`) and " +
      "the create `action_id`; poll get_action until `success`, then " +
      "get_server for its addresses.\n\n" +
      "Names come from list_server_types (`server_type`), list_images " +
      "(`image`) and list_locations (`location`). `ssh_keys` is REQUIRED: " +
      "without one Hetzner generates a root password, and this server never " +
      "returns a password, so the box would be unreachable.\n\n" +
      'Example: {"name":"build-3","server_type":"cpx31","image":"ubuntu-24.04",' +
      '"location":"fsn1","ssh_keys":["ci-deploy"],"labels":{"role":"ci"}}',
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: 'Hostname, unique in the project, e.g. "build-3".',
        },
        server_type: {
          type: "string",
          description:
            'Server type name, e.g. "cpx31", from list_server_types.',
        },
        image: {
          type: "string",
          description:
            'Image name ("ubuntu-24.04") or a snapshot\'s numeric id as a string, from list_images.',
        },
        location: {
          type: "string",
          description:
            'Location name, e.g. "fsn1", "nbg1", "hel1", "ash". Hetzner picks one if omitted.',
        },
        ssh_keys: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          description: "SSH key names or ids from list_ssh_keys. At least one.",
        },
        labels: {
          type: "object",
          additionalProperties: { type: "string" },
          description: 'Labels, e.g. {"role":"ci"}.',
        },
        firewall_ids: {
          type: "array",
          items: { type: "integer", minimum: 1 },
          description: "Firewalls to apply, from list_firewalls.",
        },
        network_ids: {
          type: "array",
          items: { type: "integer", minimum: 1 },
          description: "Private networks to attach, from list_networks.",
        },
        user_data: {
          type: "string",
          description: "cloud-init user data, run on first boot.",
        },
        start_after_create: {
          type: "boolean",
          description: "Boot it once created. Default true.",
        },
      },
      required: ["name", "server_type", "image", "ssh_keys"],
      additionalProperties: false,
    },
    annotations: CREATE,
    handler: (raw) =>
      guard(factory, async (api) => {
        const input = args(raw);
        const keys = optionalStringArray(input, "ssh_keys");
        if (!keys || keys.length === 0) {
          throw new InputError(
            "`ssh_keys` is required (at least one name or id from list_ssh_keys). " +
              "Without one Hetzner sets a root password, which this server never returns.",
          );
        }
        const body: Row = {
          name: requiredString(input, "name"),
          server_type: requiredString(input, "server_type"),
          image: requiredString(input, "image"),
          ssh_keys: keys.map(idOrName),
        };
        const location = optionalString(input, "location");
        if (location) body.location = location;
        const labels = optionalLabels(input);
        if (labels) body.labels = labels;
        const firewalls = idList(input, "firewall_ids", "a firewall id");
        if (firewalls)
          body.firewalls = firewalls.map((firewall) => ({ firewall }));
        const networks = idList(input, "network_ids", "a network id");
        if (networks) body.networks = networks;
        const userData = optionalString(input, "user_data");
        if (userData) body.user_data = userData;
        const start = optionalBool(input, "start_after_create");
        if (start !== undefined) body.start_after_create = start;

        const result = await api().request<{ server?: Row; action?: Row }>(
          "/servers",
          { method: "POST", body },
        );
        return pollable(result?.action, {
          server: summariseServer(result?.server),
        });
      }),
  };
}

/** An optional array of positive integer ids. */
function idList(
  input: Record<string, unknown>,
  key: string,
  what: string,
): number[] | undefined {
  const value = input[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new InputError(`\`${key}\` must be an array of numeric ids.`);
  }
  return value.map((v) =>
    resourceId({ [key]: v }, key, `an array of ${what}s`),
  );
}

export function deleteServerTool(factory: ClientFactory): ToolDefinition {
  return {
    name: "delete_server",
    description:
      "DELETE a server and its disk, permanently. There is no undo: anything " +
      "not in a snapshot or backup is gone, and its primary IPs are released " +
      "unless they have auto_delete off. Attached volumes are detached, not " +
      "deleted, and keep billing. A server with delete protection on is " +
      "refused with `protected`; this server cannot lift protection — a human " +
      "does, in the Hetzner console. Confirm the id with get_server first — " +
      "ids are not names." +
      BLAST_RADIUS,
    inputSchema: {
      type: "object",
      properties: { server_id: SERVER_ID },
      required: ["server_id"],
      additionalProperties: false,
    },
    annotations: DESTRUCTIVE_IDEMPOTENT,
    handler: (raw) =>
      guard(factory, async (api) => {
        const id = serverId(args(raw));
        const result = await api().request<{ action?: Row }>(`/servers/${id}`, {
          method: "DELETE",
        });
        return pollable(result?.action, { server_id: id });
      }),
  };
}

export const POWER_ACTIONS = [
  "poweron",
  "shutdown",
  "reboot",
  "poweroff",
  "reset",
] as const;

export function powerServerTool(factory: ClientFactory): ToolDefinition {
  return {
    name: "power_server",
    description:
      "Change one server's power state. Returns the action to poll with " +
      "get_action.\n\n" +
      "`action`:\n" +
      "- poweron — start a server that is off\n" +
      "- shutdown — graceful: sends ACPI shutdown, the OS stops its services. " +
      "The action succeeds once the signal is sent, not when the box is off; " +
      "poll get_server for status `off`\n" +
      "- reboot — graceful ACPI reboot\n" +
      "- poweroff — HARD cut, like pulling the plug: running jobs die " +
      "mid-write and unsynced data is lost. Prefer shutdown\n" +
      "- reset — HARD reset, like pressing the reset button; same loss as " +
      "poweroff. Use only for a hung box\n\n" +
      "Every action but poweron stops what is running on the server. Check " +
      "get_server_metrics first if you are unsure whether it is busy." +
      BLAST_RADIUS,
    inputSchema: {
      type: "object",
      properties: {
        server_id: SERVER_ID,
        action: {
          type: "string",
          enum: [...POWER_ACTIONS],
          description: "Which power action.",
        },
      },
      required: ["server_id", "action"],
      additionalProperties: false,
    },
    annotations: DESTRUCTIVE,
    handler: (raw) =>
      guard(factory, async (api) => {
        const input = args(raw);
        const id = serverId(input);
        const action = enumValue(input, "action", POWER_ACTIONS);
        if (action === undefined) {
          throw new InputError(
            `\`action\` is required: one of ${POWER_ACTIONS.join(", ")}.`,
          );
        }
        const result = await api().request<{ action?: Row }>(
          `/servers/${id}/actions/${action}`,
          { method: "POST" },
        );
        return pollable(result?.action, { server_id: id });
      }),
  };
}

export function rebuildServerTool(factory: ClientFactory): ToolDefinition {
  return {
    name: "rebuild_server",
    description:
      "WIPE a server's disk and reinstall it from an image, keeping its id, " +
      "IPs and type. Everything on the disk is lost, permanently — this is a " +
      "delete and re-create in one call. A server with rebuild protection on " +
      "is refused with `protected`; this server cannot lift protection. If " +
      "Hetzner generates a root password it is redacted, so rebuild only " +
      "onto an image or snapshot that carries your SSH access. Returns the " +
      "action to poll with get_action." +
      BLAST_RADIUS,
    inputSchema: {
      type: "object",
      properties: {
        server_id: SERVER_ID,
        image: {
          type: "string",
          description:
            'Image name ("ubuntu-24.04") or a snapshot\'s numeric id as a string, from list_images.',
        },
      },
      required: ["server_id", "image"],
      additionalProperties: false,
    },
    annotations: DESTRUCTIVE,
    handler: (raw) =>
      guard(factory, async (api) => {
        const input = args(raw);
        const id = serverId(input);
        const image = requiredString(input, "image");
        const result = await api().request<{
          action?: Row;
          root_password?: string | null;
        }>(`/servers/${id}/actions/rebuild`, {
          method: "POST",
          body: { image: idOrName(image) },
        });
        return pollable(result?.action, {
          server_id: id,
          ...(result?.root_password
            ? { root_password: result.root_password }
            : {}),
        });
      }),
  };
}

export function changeServerTypeTool(factory: ClientFactory): ToolDefinition {
  return {
    name: "change_server_type",
    description:
      "Move a server to another server type (more or fewer cores, RAM, disk). " +
      "The server must be OFF first: power_server `shutdown`, wait for status " +
      "`off`, then call this. `upgrade_disk: true` grows the disk too and is " +
      "PERMANENT — the server can then never move to a type with a smaller " +
      "disk; false (default) changes CPU and RAM only and stays reversible. " +
      "Takes minutes; poll get_action, then power_server `poweron`. The price " +
      "changes with the type — check list_server_types." +
      BLAST_RADIUS,
    inputSchema: {
      type: "object",
      properties: {
        server_id: SERVER_ID,
        server_type: {
          type: "string",
          description:
            'The new type\'s name, e.g. "ccx43", from list_server_types.',
        },
        upgrade_disk: {
          type: "boolean",
          description: "Also grow the disk (permanent). Default false.",
        },
      },
      required: ["server_id", "server_type"],
      additionalProperties: false,
    },
    annotations: DESTRUCTIVE,
    handler: (raw) =>
      guard(factory, async (api) => {
        const input = args(raw);
        const id = serverId(input);
        const result = await api().request<{ action?: Row }>(
          `/servers/${id}/actions/change_type`,
          {
            method: "POST",
            body: {
              server_type: requiredString(input, "server_type"),
              upgrade_disk: optionalBool(input, "upgrade_disk") ?? false,
            },
          },
        );
        return pollable(result?.action, { server_id: id });
      }),
  };
}

export function createServerImageTool(factory: ClientFactory): ToolDefinition {
  return {
    name: "create_server_image",
    description:
      "Snapshot a server's disk into a new image, which can later create or " +
      "rebuild a server. The server keeps running, but a snapshot of a " +
      "running server is only crash-consistent; for a clean one shut it down " +
      "first. Snapshots bill per GB-month until deleted with delete_image. " +
      "Returns the image (status `creating`) and the action to poll.\n\n" +
      'Example: {"server_id":42,"description":"ci-runner-2 before upgrade",' +
      '"labels":{"reason":"pre-upgrade"}}',
    inputSchema: {
      type: "object",
      properties: {
        server_id: SERVER_ID,
        description: {
          type: "string",
          description: "What the snapshot is, as it will show in list_images.",
        },
        labels: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "Labels for the image.",
        },
      },
      required: ["server_id"],
      additionalProperties: false,
    },
    annotations: CREATE,
    handler: (raw) =>
      guard(factory, async (api) => {
        const input = args(raw);
        const id = serverId(input);
        const body: Row = { type: "snapshot" };
        const description = optionalString(input, "description");
        if (description) body.description = description;
        const labels = optionalLabels(input);
        if (labels) body.labels = labels;
        const result = await api().request<{ image?: Row; action?: Row }>(
          `/servers/${id}/actions/create_image`,
          { method: "POST", body },
        );
        return pollable(result?.action, {
          image: pick(result?.image, [
            "id",
            "type",
            "status",
            "description",
            "created_from",
          ]),
        });
      }),
  };
}
