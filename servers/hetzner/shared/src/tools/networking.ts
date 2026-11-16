/**
 * What surrounds a server: firewalls, private networks, primary IPs and
 * volumes. All four are readable; firewalls and volumes are writable, because
 * those are the changes an operator of a box actually makes. Networks and
 * primary IPs are read-only on purpose: moving a box's public address or its
 * private network is a change to everything that talks to it, and belongs in
 * the console, by a human.
 */

import { InputError } from "../errors.js";
import { listPage } from "../client.js";
import {
  args,
  BLAST_RADIUS,
  DESTRUCTIVE,
  enumValue,
  guard,
  NAME_AND_LABEL_PROPERTIES,
  optionalBool,
  optionalString,
  pageArgs,
  PAGE_PROPERTIES,
  pick,
  READ,
  resourceId,
  type ClientFactory,
  WRITE,
  type ToolDefinition,
} from "./shared.js";
import { serverId } from "./servers.js";

type Row = Record<string, unknown>;

const SERVER_ID = {
  type: "integer",
  minimum: 1,
  description: "The server's numeric id, from list_servers.",
};

const FIREWALL_ID = {
  type: "integer",
  minimum: 1,
  description: "The firewall's numeric id, from list_firewalls.",
};

const VOLUME_ID = {
  type: "integer",
  minimum: 1,
  description: "The volume's numeric id, from list_volumes.",
};

function firewallId(input: Record<string, unknown>): number {
  return resourceId(
    input,
    "firewall_id",
    "a firewall's numeric id (from list_firewalls)",
  );
}

function volumeId(input: Record<string, unknown>): number {
  return resourceId(
    input,
    "volume_id",
    "a volume's numeric id (from list_volumes)",
  );
}

/** What a firewall/volume write returns: the action(s) to poll. */
function pollableActions(actions: unknown, extra: Row = {}): Row {
  const list = Array.isArray(actions) ? (actions as Row[]) : [];
  return {
    ...extra,
    action_ids: list.map((a) => a.id),
    actions: list.map((a) => pick(a, ["id", "command", "status"])),
    next: "Poll get_action with each action_id until status is success or error.",
  };
}

export function listFirewallsTool(factory: ClientFactory): ToolDefinition {
  return {
    name: "list_firewalls",
    description:
      "Firewalls in the project, each in full: its rules and what it is " +
      "applied to. A Hetzner firewall is DEFAULT-DENY inbound once applied: " +
      "only traffic a rule names gets in. Outbound is open unless an `out` " +
      "rule exists, after which only named outbound traffic leaves.\n\n" +
      'Example row: {"id":38,"name":"ci","rules":[{"direction":"in",' +
      '"protocol":"tcp","port":"22","source_ips":["0.0.0.0/0","::/0"],' +
      '"destination_ips":[],"description":"ssh"}],' +
      '"applied_to":[{"type":"server","server":{"id":42}}],"labels":{}}',
    inputSchema: {
      type: "object",
      properties: { ...NAME_AND_LABEL_PROPERTIES, ...PAGE_PROPERTIES },
      additionalProperties: false,
    },
    annotations: READ,
    handler: (raw) =>
      guard(factory, async (api) => {
        const input = args(raw);
        const { page, perPage } = pageArgs(input);
        return listPage<Row>(api(), "/firewalls", "firewalls", page, perPage, {
          name: optionalString(input, "name"),
          label_selector: optionalString(input, "label_selector"),
        });
      }),
  };
}

export function listNetworksTool(factory: ClientFactory): ToolDefinition {
  return {
    name: "list_networks",
    description:
      "Private networks in the project, each in full: IP range, subnets " +
      "(with network zone), routes, and the ids of the servers attached. A " +
      "server's own address on a network is in list_servers' `private_ips`.\n\n" +
      'Example row: {"id":4711,"name":"ci-net","ip_range":"10.0.0.0/16",' +
      '"subnets":[{"type":"cloud","ip_range":"10.0.1.0/24",' +
      '"network_zone":"eu-central","gateway":"10.0.0.1"}],"routes":[],' +
      '"servers":[42],"protection":{"delete":false},"labels":{}}',
    inputSchema: {
      type: "object",
      properties: { ...NAME_AND_LABEL_PROPERTIES, ...PAGE_PROPERTIES },
      additionalProperties: false,
    },
    annotations: READ,
    handler: (raw) =>
      guard(factory, async (api) => {
        const input = args(raw);
        const { page, perPage } = pageArgs(input);
        return listPage<Row>(api(), "/networks", "networks", page, perPage, {
          name: optionalString(input, "name"),
          label_selector: optionalString(input, "label_selector"),
        });
      }),
  };
}

export function listPrimaryIpsTool(factory: ClientFactory): ToolDefinition {
  return {
    name: "list_primary_ips",
    description:
      "Primary IPs (a server's public IPv4 / IPv6) in the project: the " +
      "address, which server it is assigned to (`assignee_id`, null when " +
      "unassigned and still billing), `auto_delete` (released with its " +
      "server or kept), reverse DNS and protection. Read-only here: moving a " +
      "box's public address is a console job.\n\n" +
      'Example row: {"id":101,"name":"ci-runner-2-v4","type":"ipv4",' +
      '"ip":"203.0.113.10","assignee_id":42,"assignee_type":"server",' +
      '"auto_delete":false,"location":"fsn1",' +
      '"protection":{"delete":true},"dns_ptr":[…]}',
    inputSchema: {
      type: "object",
      properties: {
        ...NAME_AND_LABEL_PROPERTIES,
        ip: {
          type: "string",
          description: "Only the primary IP with exactly this address.",
        },
        ...PAGE_PROPERTIES,
      },
      additionalProperties: false,
    },
    annotations: READ,
    handler: (raw) =>
      guard(factory, async (api) => {
        const input = args(raw);
        const { page, perPage } = pageArgs(input);
        const result = await listPage<Row>(
          api(),
          "/primary_ips",
          "primary_ips",
          page,
          perPage,
          {
            name: optionalString(input, "name"),
            label_selector: optionalString(input, "label_selector"),
            ip: optionalString(input, "ip"),
          },
        );
        return {
          ...result,
          items: result.items.map((p) => ({
            ...pick(p, [
              "id",
              "name",
              "type",
              "ip",
              "assignee_id",
              "assignee_type",
              "auto_delete",
              "blocked",
            ]),
            location:
              ((p.location ?? {}) as Row).name ??
              (((p.datacenter ?? {}) as Row).location as Row | undefined)?.name,
            ...pick(p, ["protection", "dns_ptr", "labels", "created"]),
          })),
        };
      }),
  };
}

export function listVolumesTool(factory: ClientFactory): ToolDefinition {
  return {
    name: "list_volumes",
    description:
      "Block storage volumes in the project: size GB, location, the server " +
      "it is attached to (`server`, null when detached and still billing), " +
      "the Linux device path, filesystem, status and protection.\n\n" +
      'Example row: {"id":9001,"name":"ci-cache","size":500,"server":42,' +
      '"location":"fsn1","linux_device":"/dev/disk/by-id/scsi-0HC_Volume_9001",' +
      '"format":"ext4","status":"available","protection":{"delete":false}}',
    inputSchema: {
      type: "object",
      properties: {
        ...NAME_AND_LABEL_PROPERTIES,
        status: {
          type: "string",
          enum: ["available", "creating"],
          description: "Only volumes in this state.",
        },
        ...PAGE_PROPERTIES,
      },
      additionalProperties: false,
    },
    annotations: READ,
    handler: (raw) =>
      guard(factory, async (api) => {
        const input = args(raw);
        const { page, perPage } = pageArgs(input);
        const result = await listPage<Row>(
          api(),
          "/volumes",
          "volumes",
          page,
          perPage,
          {
            name: optionalString(input, "name"),
            label_selector: optionalString(input, "label_selector"),
            status: enumValue(input, "status", ["available", "creating"]),
          },
        );
        return {
          ...result,
          items: result.items.map((v) => ({
            ...pick(v, ["id", "name", "size", "server"]),
            location: ((v.location ?? {}) as Row).name,
            ...pick(v, [
              "linux_device",
              "format",
              "status",
              "protection",
              "labels",
              "created",
            ]),
          })),
        };
      }),
  };
}

/** "any", one port 1-65535, or a range lo-hi within it with lo < hi. */
function validPort(port: string): boolean {
  if (port === "any") return true;
  const m = /^(\d{1,5})(?:-(\d{1,5}))?$/.exec(port);
  if (!m) return false;
  const lo = Number(m[1]);
  const hi = m[2] === undefined ? lo : Number(m[2]);
  return lo >= 1 && hi <= 65535 && lo <= hi && (m[2] === undefined || lo < hi);
}

export const RULE_DIRECTIONS = ["in", "out"] as const;
export const RULE_PROTOCOLS = ["tcp", "udp", "icmp", "esp", "gre"] as const;

/**
 * One firewall rule, checked for the shape Hetzner needs before the whole
 * rule set is replaced — a rule Hetzner refuses fails the set, and a rule it
 * accepts but that means something else (an `in` rule with no sources) is a
 * hole or a lockout.
 */
function firewallRule(raw: unknown, i: number): Row {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new InputError(`\`rules[${i}]\` must be an object.`);
  }
  const r = raw as Row;
  const direction = enumValue(r, "direction", RULE_DIRECTIONS);
  const protocol = enumValue(r, "protocol", RULE_PROTOCOLS);
  if (!direction || !protocol) {
    throw new InputError(
      `\`rules[${i}]\` needs \`direction\` (in|out) and \`protocol\` (${RULE_PROTOCOLS.join("|")}).`,
    );
  }
  const rule: Row = { direction, protocol };
  const port = optionalString(r, "port");
  if (protocol === "tcp" || protocol === "udp") {
    if (!port || !validPort(port)) {
      throw new InputError(
        `\`rules[${i}].port\` is required for ${protocol}: "22", "8000-9000" or "any".`,
      );
    }
    rule.port = port;
  } else if (port) {
    throw new InputError(`\`rules[${i}].port\` applies to tcp and udp only.`);
  }
  const ipsKey = direction === "in" ? "source_ips" : "destination_ips";
  const ips = r[ipsKey];
  if (
    !Array.isArray(ips) ||
    ips.length === 0 ||
    ips.some((ip) => typeof ip !== "string" || ip.trim() === "")
  ) {
    throw new InputError(
      `\`rules[${i}].${ipsKey}\` is required for an "${direction}" rule: CIDRs, e.g. ["0.0.0.0/0","::/0"].`,
    );
  }
  rule[ipsKey] = (ips as string[]).map((ip) => ip.trim());
  const description = optionalString(r, "description");
  if (description) rule.description = description;
  return rule;
}

export function setFirewallRulesTool(factory: ClientFactory): ToolDefinition {
  return {
    name: "set_firewall_rules",
    description:
      "REPLACE every rule of one firewall with `rules`. A full replace, not " +
      "an append: read the current rules with list_firewalls, edit that " +
      "list, and send all of it. It takes effect on every server the " +
      "firewall is applied to within seconds. Inbound is default-deny, so a " +
      "rule set that drops the SSH rule locks every one of those servers " +
      "out of SSH, and one that drops a service's port takes that service " +
      "off the internet. An empty list is refused unless `clear_all: true`.\n\n" +
      "Each rule: `direction` in|out, `protocol` tcp|udp|icmp|esp|gre, " +
      '`port` ("22", "8000-9000", "any"; tcp/udp only), `source_ips` ' +
      "for in or `destination_ips` for out, optional `description`.\n\n" +
      'Example: {"firewall_id":38,"rules":[{"direction":"in","protocol":"tcp",' +
      '"port":"22","source_ips":["0.0.0.0/0","::/0"],"description":"ssh"}]}' +
      BLAST_RADIUS,
    inputSchema: {
      type: "object",
      properties: {
        firewall_id: FIREWALL_ID,
        rules: {
          type: "array",
          items: {
            type: "object",
            properties: {
              direction: { type: "string", enum: [...RULE_DIRECTIONS] },
              protocol: { type: "string", enum: [...RULE_PROTOCOLS] },
              port: { type: "string" },
              source_ips: { type: "array", items: { type: "string" } },
              destination_ips: { type: "array", items: { type: "string" } },
              description: { type: "string" },
            },
            required: ["direction", "protocol"],
            additionalProperties: false,
          },
          description: "The complete new rule set.",
        },
        clear_all: {
          type: "boolean",
          description:
            "Required to send an empty `rules`, which blocks ALL inbound traffic to every server the firewall is on.",
        },
      },
      required: ["firewall_id", "rules"],
      additionalProperties: false,
    },
    annotations: { ...DESTRUCTIVE, idempotentHint: true },
    handler: (raw) =>
      guard(factory, async (api) => {
        const input = args(raw);
        const id = firewallId(input);
        if (!Array.isArray(input.rules)) {
          throw new InputError("`rules` is required and must be an array.");
        }
        const rules = (input.rules as unknown[]).map(firewallRule);
        if (rules.length === 0 && optionalBool(input, "clear_all") !== true) {
          throw new InputError(
            "`rules` is empty, which blocks all inbound traffic to every server " +
              "this firewall is applied to. Pass `clear_all: true` if that is " +
              "really intended; nothing was sent.",
          );
        }
        const result = await api().request<{ actions?: Row[] }>(
          `/firewalls/${id}/actions/set_rules`,
          { method: "POST", body: { rules } },
        );
        return pollableActions(result?.actions, {
          firewall_id: id,
          rules: rules.length,
        });
      }),
  };
}

function applyOrRemove(
  factory: ClientFactory,
  mode: "apply" | "remove",
): ToolDefinition {
  const apply = mode === "apply";
  return {
    name: apply ? "apply_firewall" : "remove_firewall",
    description: apply
      ? "Apply a firewall to one server. From then on the server's inbound " +
        "traffic is DEFAULT-DENY except what the firewall's rules (and any " +
        "other firewall already on it) allow — check its rules with " +
        "list_firewalls first, or the server can drop off SSH and every " +
        "service it runs. Returns the action(s) to poll." +
        BLAST_RADIUS
      : "Take a firewall off one server. The server is then reachable on " +
        "every port its OS listens on, unless another firewall still covers " +
        "it — removing the last firewall opens it to the internet. Returns " +
        "the action(s) to poll." +
        BLAST_RADIUS,
    inputSchema: {
      type: "object",
      properties: { firewall_id: FIREWALL_ID, server_id: SERVER_ID },
      required: ["firewall_id", "server_id"],
      additionalProperties: false,
    },
    annotations: { ...DESTRUCTIVE, idempotentHint: true },
    handler: (raw) =>
      guard(factory, async (api) => {
        const input = args(raw);
        const id = firewallId(input);
        const server = serverId(input);
        const result = await api().request<{ actions?: Row[] }>(
          `/firewalls/${id}/actions/${apply ? "apply_to_resources" : "remove_from_resources"}`,
          {
            method: "POST",
            body: {
              [apply ? "apply_to" : "remove_from"]: [
                { type: "server", server: { id: server } },
              ],
            },
          },
        );
        return pollableActions(result?.actions, {
          firewall_id: id,
          server_id: server,
        });
      }),
  };
}

export function applyFirewallTool(factory: ClientFactory): ToolDefinition {
  return applyOrRemove(factory, "apply");
}

export function removeFirewallTool(factory: ClientFactory): ToolDefinition {
  return applyOrRemove(factory, "remove");
}

export function attachVolumeTool(factory: ClientFactory): ToolDefinition {
  return {
    name: "attach_volume",
    description:
      "Attach a volume to a server in the same location. With `automount: " +
      "true` Hetzner mounts it under /mnt; otherwise it appears as a block " +
      "device (list_volumes' `linux_device`) for the OS to mount. A volume is " +
      "on one server at a time. Returns the action to poll with get_action.",
    inputSchema: {
      type: "object",
      properties: {
        volume_id: VOLUME_ID,
        server_id: SERVER_ID,
        automount: {
          type: "boolean",
          description: "Mount it automatically. Default false.",
        },
      },
      required: ["volume_id", "server_id"],
      additionalProperties: false,
    },
    annotations: WRITE,
    handler: (raw) =>
      guard(factory, async (api) => {
        const input = args(raw);
        const id = volumeId(input);
        const server = serverId(input);
        const result = await api().request<{ action?: Row }>(
          `/volumes/${id}/actions/attach`,
          {
            method: "POST",
            body: {
              server,
              automount: optionalBool(input, "automount") ?? false,
            },
          },
        );
        return pollableActions(result?.action ? [result.action] : [], {
          volume_id: id,
          server_id: server,
        });
      }),
  };
}

export function detachVolumeTool(factory: ClientFactory): ToolDefinition {
  return {
    name: "detach_volume",
    description:
      "Detach a volume from whatever server has it. The OS is NOT asked " +
      "first: anything writing to it fails, and an unsynced write is lost. " +
      "Unmount it on the server before calling. The volume and its data stay " +
      "and keep billing. Returns the action to poll with get_action." +
      BLAST_RADIUS,
    inputSchema: {
      type: "object",
      properties: { volume_id: VOLUME_ID },
      required: ["volume_id"],
      additionalProperties: false,
    },
    annotations: DESTRUCTIVE,
    handler: (raw) =>
      guard(factory, async (api) => {
        const id = volumeId(args(raw));
        const result = await api().request<{ action?: Row }>(
          `/volumes/${id}/actions/detach`,
          { method: "POST", body: {} },
        );
        return pollableActions(result?.action ? [result.action] : [], {
          volume_id: id,
        });
      }),
  };
}
