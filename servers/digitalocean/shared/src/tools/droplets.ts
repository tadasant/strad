/**
 * Droplets: list, read, create, delete, and act on one (power, resize,
 * snapshot, …).
 *
 * ACTIONS ARE ASYNCHRONOUS. A create, delete or power change returns at once
 * with an action whose `status` is `in-progress`; whether it worked is only
 * known by polling droplet-action-get until `completed` or `errored`. Every
 * write here says so and hands back the action id to poll, because "the API
 * accepted it" and "the droplet is off" are different facts and an agent that
 * conflates them reports work done that is not.
 */

import { InputError } from "../errors.js";
import { listPage } from "../client.js";
import { pick } from "./account.js";
import {
  args,
  CREATE,
  DESTRUCTIVE,
  DESTRUCTIVE_IDEMPOTENT,
  dropletId,
  enumValue,
  guard,
  optionalBool,
  optionalString,
  optionalStringArray,
  pageArgs,
  PAGE_PROPERTIES,
  READ,
  requiredString,
  type ClientFactory,
  type ToolDefinition,
} from "./shared.js";

type Row = Record<string, unknown>;

const DROPLET_ID = {
  type: "integer",
  minimum: 1,
  description: "The droplet's numeric id, from droplet-list.",
};

/**
 * A droplet with the fields an agent acts on, and the addresses flattened.
 * The raw object nests the IPs three deep in `networks` and repeats the whole
 * size and image records; droplet-get returns it in full.
 */
export function summariseDroplet(raw: unknown): Row {
  const d = (raw && typeof raw === "object" ? raw : {}) as Row;
  const networks = (d.networks ?? {}) as { v4?: Row[]; v6?: Row[] };
  const v4 = Array.isArray(networks.v4) ? networks.v4 : [];
  const v6 = Array.isArray(networks.v6) ? networks.v6 : [];
  const address = (rows: Row[], type: string) =>
    rows.find((n) => n.type === type)?.ip_address;
  const region = d.region as Row | undefined;
  return {
    ...pick(d, [
      "id",
      "name",
      "status",
      "memory",
      "vcpus",
      "disk",
      "locked",
      "created_at",
      "size_slug",
    ]),
    region: region?.slug,
    image: pick(d.image, ["id", "slug", "name", "distribution"]),
    public_ipv4: address(v4, "public"),
    private_ipv4: address(v4, "private"),
    public_ipv6: address(v6, "public"),
    ...pick(d, ["tags", "vpc_uuid", "features"]),
  };
}

export function dropletListTool(factory: ClientFactory): ToolDefinition {
  return {
    name: "droplet-list",
    description:
      "Droplets (virtual machines) on the account, one page at a time, " +
      "summarised: id, name, status (new, active, off, archive), memory MB, " +
      "vcpus, disk GB, size_slug, region, image, public/private IPv4, IPv6, " +
      "tags. Filter by `tag_name` or exact `name` (not both). Use droplet-get " +
      "for the full record.\n\n" +
      'Example row: {"id":3164444,"name":"web-1","status":"active",' +
      '"size_slug":"s-1vcpu-1gb","region":"nyc3","public_ipv4":"104.236.32.182",' +
      '"tags":["web"]}',
    inputSchema: {
      type: "object",
      properties: {
        tag_name: {
          type: "string",
          description: "Only droplets carrying this tag.",
        },
        name: {
          type: "string",
          description: "Only droplets with exactly this name.",
        },
        ...PAGE_PROPERTIES,
      },
      additionalProperties: false,
    },
    annotations: READ,
    handler: (raw) =>
      guard(factory, async (api) => {
        const input = args(raw);
        const tag = optionalString(input, "tag_name");
        const name = optionalString(input, "name");
        if (tag !== undefined && name !== undefined) {
          throw new InputError(
            "Pass `tag_name` or `name`, not both — DigitalOcean filters by one at a time.",
          );
        }
        const { page, perPage } = pageArgs(input);
        const result = await listPage<Row>(
          api(),
          "/droplets",
          "droplets",
          page,
          perPage,
          {
            tag_name: tag,
            name,
          },
        );
        return { ...result, items: result.items.map(summariseDroplet) };
      }),
  };
}

export function dropletGetTool(factory: ClientFactory): ToolDefinition {
  return {
    name: "droplet-get",
    description:
      "One droplet in full: the summary droplet-list gives plus the complete " +
      "size and image records, kernel, backup and snapshot ids, volume ids, " +
      "next backup window and every network interface.",
    inputSchema: {
      type: "object",
      properties: { droplet_id: DROPLET_ID },
      required: ["droplet_id"],
      additionalProperties: false,
    },
    annotations: READ,
    handler: (raw) =>
      guard(factory, async (api) => {
        const id = dropletId(args(raw));
        const body = await api().request<{ droplet?: Row }>(`/droplets/${id}`);
        return body?.droplet ?? {};
      }),
  };
}

export function dropletActionGetTool(factory: ClientFactory): ToolDefinition {
  return {
    name: "droplet-action-get",
    description:
      "Poll one droplet action — the id droplet-create, droplet-delete's " +
      "follow-up or droplet-action handed back. `status` is in-progress, " +
      "completed or errored; only `completed` means the change happened. " +
      "Poll every 5-10 s: a power change takes seconds, a resize or snapshot " +
      "minutes.\n\n" +
      'Example: {"id":36804636,"status":"completed","type":"power_off",' +
      '"started_at":"2026-10-09T12:00:00Z","completed_at":"2026-10-09T12:00:12Z",' +
      '"resource_id":3164444,"resource_type":"droplet","region_slug":"nyc3"}',
    inputSchema: {
      type: "object",
      properties: {
        droplet_id: DROPLET_ID,
        action_id: {
          type: "integer",
          minimum: 1,
          description: "The action's id, from the write that started it.",
        },
      },
      required: ["droplet_id", "action_id"],
      additionalProperties: false,
    },
    annotations: READ,
    handler: (raw) =>
      guard(factory, async (api) => {
        const input = args(raw);
        const id = dropletId(input);
        const actionId = dropletId(
          input,
          "action_id",
          "an action's numeric id (the `action_id` droplet-create or droplet-action returned)",
        );
        const body = await api().request<{ action?: Row }>(
          `/droplets/${id}/actions/${actionId}`,
        );
        return body?.action ?? {};
      }),
  };
}

/** A numeric-looking string as a number, anything else as itself. */
function idOrSlug(value: string): string | number {
  return /^\d+$/.test(value) ? Number(value) : value;
}

export function dropletCreateTool(factory: ClientFactory): ToolDefinition {
  return {
    name: "droplet-create",
    description:
      "Create ONE droplet. It starts billing as soon as it exists. Returns the " +
      "droplet (status `new`, no IP yet) and the create `action_id`; poll " +
      "droplet-action-get until `completed`, then droplet-get for its " +
      "address.\n\n" +
      "Slugs come from region-list, size-list and image-list; SSH key ids or " +
      "fingerprints from key-list. Without `ssh_keys` DigitalOcean emails a " +
      "root password to the account owner — pass a key.\n\n" +
      'Example: {"name":"web-2","region":"nyc3","size":"s-1vcpu-1gb",' +
      '"image":"ubuntu-24-04-x64","ssh_keys":["3b:16:bf:…"],"tags":["web"]}',
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: 'Hostname: letters, digits, `.` and `-`. E.g. "web-2".',
        },
        region: { type: "string", description: 'Region slug, e.g. "nyc3".' },
        size: { type: "string", description: 'Size slug, e.g. "s-1vcpu-1gb".' },
        image: {
          type: "string",
          description:
            'Image slug ("ubuntu-24-04-x64") or a private image\'s numeric id as a string.',
        },
        ssh_keys: {
          type: "array",
          items: { type: "string" },
          description: "SSH key ids or fingerprints from key-list.",
        },
        backups: {
          type: "boolean",
          description: "Enable weekly backups (extra cost). Default false.",
        },
        ipv6: {
          type: "boolean",
          description: "Assign an IPv6 address. Default false.",
        },
        monitoring: {
          type: "boolean",
          description: "Install the metrics agent. Default false.",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Tags to apply.",
        },
        vpc_uuid: {
          type: "string",
          description: "VPC to join; the region's default VPC if omitted.",
        },
        user_data: {
          type: "string",
          description: "cloud-init user data, run on first boot.",
        },
      },
      required: ["name", "region", "size", "image"],
      additionalProperties: false,
    },
    annotations: CREATE,
    handler: (raw) =>
      guard(factory, async (api) => {
        const input = args(raw);
        const body: Row = {
          name: requiredString(input, "name"),
          region: requiredString(input, "region"),
          size: requiredString(input, "size"),
          image: idOrSlug(requiredString(input, "image")),
        };
        const keys = optionalStringArray(input, "ssh_keys");
        if (keys) body.ssh_keys = keys.map(idOrSlug);
        for (const flag of ["backups", "ipv6", "monitoring"]) {
          const value = optionalBool(input, flag);
          if (value !== undefined) body[flag] = value;
        }
        const tags = optionalStringArray(input, "tags");
        if (tags) body.tags = tags;
        const vpc = optionalString(input, "vpc_uuid");
        if (vpc) body.vpc_uuid = vpc;
        const userData = optionalString(input, "user_data");
        if (userData) body.user_data = userData;

        const result = await api().request<{
          droplet?: Row;
          links?: { actions?: Row[] };
        }>("/droplets", { method: "POST", body });
        const actionId = result?.links?.actions?.[0]?.id;
        return {
          droplet: summariseDroplet(result?.droplet),
          ...(actionId === undefined ? {} : { action_id: actionId }),
          next: "Poll droplet-action-get with this droplet_id and action_id until status is completed.",
        };
      }),
  };
}

export function dropletDeleteTool(factory: ClientFactory): ToolDefinition {
  return {
    name: "droplet-delete",
    description:
      "DELETE a droplet and its disk, permanently. There is no undo and no " +
      "recycle bin: anything not in a snapshot or backup is gone. Snapshots, " +
      "backups and attached volumes are NOT deleted and keep billing. Confirm " +
      "the id with droplet-get first — ids are not names.",
    inputSchema: {
      type: "object",
      properties: { droplet_id: DROPLET_ID },
      required: ["droplet_id"],
      additionalProperties: false,
    },
    annotations: DESTRUCTIVE_IDEMPOTENT,
    handler: (raw) =>
      guard(factory, async (api) => {
        const id = dropletId(args(raw));
        await api().request(`/droplets/${id}`, { method: "DELETE" });
        return {
          deleted: true,
          droplet_id: id,
          note: "DigitalOcean accepted the delete (HTTP 204). droplet-get will 404 once it has finished.",
        };
      }),
  };
}

export const DROPLET_ACTION_TYPES = [
  "power_on",
  "power_off",
  "shutdown",
  "reboot",
  "power_cycle",
  "resize",
  "snapshot",
  "rename",
  "enable_backups",
  "disable_backups",
  "enable_ipv6",
] as const;

type DropletActionType = (typeof DROPLET_ACTION_TYPES)[number];

export function dropletActionTool(factory: ClientFactory): ToolDefinition {
  return {
    name: "droplet-action",
    description:
      "Act on one droplet. Returns the action ({id, status: in-progress, " +
      "type, …}); poll droplet-action-get until `completed` or `errored`.\n\n" +
      "`type`:\n" +
      "- power_on / reboot (graceful) / shutdown (graceful, then off)\n" +
      "- power_off — a hard cut, like pulling the plug; prefer shutdown\n" +
      "- power_cycle — hard off then on\n" +
      "- resize — needs `size`; the droplet must be OFF first. `disk: true` " +
      "grows the disk too and is PERMANENT (it can never be resized down); " +
      "false (default) changes CPU/RAM only and is reversible\n" +
      "- snapshot — optional `name`; best taken while off. Snapshots bill " +
      "per GB-month\n" +
      "- rename — needs `name`\n" +
      "- enable_backups / disable_backups — disabling deletes nothing already " +
      "taken but stops new ones\n" +
      "- enable_ipv6\n\n" +
      "Power, resize and backups changes can take a running service down; " +
      "say what you are about to do before you do it.",
    inputSchema: {
      type: "object",
      properties: {
        droplet_id: DROPLET_ID,
        type: {
          type: "string",
          enum: [...DROPLET_ACTION_TYPES],
          description: "Which action.",
        },
        size: {
          type: "string",
          description: 'resize only: the new size slug, e.g. "s-2vcpu-4gb".',
        },
        disk: {
          type: "boolean",
          description:
            "resize only: also grow the disk (permanent). Default false.",
        },
        name: {
          type: "string",
          description:
            "rename: the new name (required). snapshot: the snapshot's name (optional).",
        },
      },
      required: ["droplet_id", "type"],
      additionalProperties: false,
    },
    annotations: DESTRUCTIVE,
    handler: (raw) =>
      guard(factory, async (api) => {
        const input = args(raw);
        const id = dropletId(input);
        const type = enumValue(input, "type", DROPLET_ACTION_TYPES);
        if (type === undefined) {
          throw new InputError(
            `\`type\` is required: one of ${DROPLET_ACTION_TYPES.join(", ")}.`,
          );
        }
        const body: Row = { type };
        const extras: Record<DropletActionType, () => void> = {
          resize: () => {
            body.size = requiredString(input, "size");
            body.disk = optionalBool(input, "disk") ?? false;
          },
          snapshot: () => {
            const name = optionalString(input, "name");
            if (name) body.name = name;
          },
          rename: () => {
            body.name = requiredString(input, "name");
          },
          power_on: () => {},
          power_off: () => {},
          shutdown: () => {},
          reboot: () => {},
          power_cycle: () => {},
          enable_backups: () => {},
          disable_backups: () => {},
          enable_ipv6: () => {},
        };
        extras[type]();
        const result = await api().request<{ action?: Row }>(
          `/droplets/${id}/actions`,
          {
            method: "POST",
            body,
          },
        );
        return result?.action ?? {};
      }),
  };
}
