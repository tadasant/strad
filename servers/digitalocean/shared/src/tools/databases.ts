/**
 * Managed database clusters: list, read, backups, firewall, users, and create,
 * resize or delete one.
 *
 * EVERY RESULT HERE IS REDACTED, and that is the reason this file exists in
 * the shape it does. DigitalOcean's cluster and user reads return the admin
 * password, every user's password, and connection URIs with the password
 * spliced in. The agent sees that a database exists, its engine, size, host,
 * port, user names and firewall — never what authenticates against it. The
 * walk itself is in secrets.ts and runs over every result in tools/shared.ts;
 * the descriptions say so because an agent asked "what is the DB password"
 * should answer "this server does not return it", not guess.
 */

import { InputError } from "../errors.js";
import { pick } from "./account.js";
import {
  args,
  CREATE,
  DESTRUCTIVE,
  DESTRUCTIVE_IDEMPOTENT,
  enumValue,
  guard,
  optionalInt,
  optionalString,
  optionalStringArray,
  pageArgs,
  PAGE_PROPERTIES,
  READ,
  requiredString,
  uuid,
  type ClientFactory,
  type ToolDefinition,
} from "./shared.js";

type Row = Record<string, unknown>;

const CLUSTER_ID = {
  type: "string",
  description: "The cluster's id (a UUID), from db-cluster-list.",
};

const FROM_LIST = "db-cluster-list";

const REDACTION_NOTE =
  "Passwords, access keys and the password inside every connection URI are " +
  'returned as "[redacted]": this server never returns database ' +
  "credentials. A human reads them in the DigitalOcean control panel.";

const ONE_CLUSTER = {
  type: "object" as const,
  properties: { cluster_id: CLUSTER_ID },
  required: ["cluster_id"],
  additionalProperties: false,
};

export function summariseCluster(raw: unknown): Row {
  const c = (raw && typeof raw === "object" ? raw : {}) as Row;
  return {
    ...pick(c, [
      "id",
      "name",
      "engine",
      "version",
      "status",
      "region",
      "size",
      "num_nodes",
      "storage_size_mib",
      "created_at",
      "tags",
      "private_network_uuid",
      "db_names",
    ]),
    connection: pick(c.connection, ["host", "port", "user", "database", "ssl"]),
  };
}

export function dbClusterListTool(factory: ClientFactory): ToolDefinition {
  return {
    name: "db-cluster-list",
    description:
      "Managed database clusters on the account, summarised: id, name, " +
      "engine (pg, mysql, valkey, redis, mongodb, kafka, opensearch), " +
      "version, status (creating, online, resizing, migrating, forking), " +
      "region, size, num_nodes, storage, tags and the public host / port / " +
      "user / database. Filter by `tag_name`. db-cluster-get has the rest. " +
      "No credentials: " +
      REDACTION_NOTE,
    inputSchema: {
      type: "object",
      properties: {
        tag_name: {
          type: "string",
          description: "Only clusters carrying this tag.",
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
        const { page, perPage } = pageArgs(input);
        // DigitalOcean does not paginate this endpoint: one request returns
        // every cluster. The page is cut HERE so the result is bounded the same
        // way every other list is, and `total` is exact.
        const body = await api().request<{ databases?: Row[] }>("/databases", {
          query: { tag_name: tag },
        });
        const all = Array.isArray(body?.databases) ? body.databases : [];
        const start = (page - 1) * perPage;
        const hasNext = start + perPage < all.length;
        return {
          items: all.slice(start, start + perPage).map(summariseCluster),
          page,
          per_page: perPage,
          total: all.length,
          has_next_page: hasNext,
          ...(hasNext ? { next_page: page + 1 } : {}),
        };
      }),
  };
}

export function dbClusterGetTool(factory: ClientFactory): ToolDefinition {
  return {
    name: "db-cluster-get",
    description:
      "One database cluster in full: engine, version, status, size, nodes, " +
      "storage, maintenance window, public and private connection details " +
      "(host, port, user, database, ssl), standby connections, users and " +
      "database names. " +
      REDACTION_NOTE,
    inputSchema: ONE_CLUSTER,
    annotations: READ,
    handler: (raw) =>
      guard(factory, async (api) => {
        const id = uuid(args(raw), "cluster_id", FROM_LIST);
        const body = await api().request<{ database?: Row }>(
          `/databases/${id}`,
        );
        return body?.database ?? {};
      }),
  };
}

export function dbClusterListBackupsTool(
  factory: ClientFactory,
): ToolDefinition {
  return {
    name: "db-cluster-list-backups",
    description:
      "The automatic backups DigitalOcean holds for a cluster (daily, kept " +
      "7 days): each {created_at, size_gigabytes}. A restore is a NEW cluster " +
      "created from one, which this server does not do. Not available for " +
      "every engine (Kafka, for one, has none).",
    inputSchema: ONE_CLUSTER,
    annotations: READ,
    handler: (raw) =>
      guard(factory, async (api) => {
        const id = uuid(args(raw), "cluster_id", FROM_LIST);
        const body = await api().request<{ backups?: Row[] }>(
          `/databases/${id}/backups`,
        );
        const backups = Array.isArray(body?.backups) ? body.backups : [];
        return { cluster_id: id, backups, count: backups.length };
      }),
  };
}

export function dbClusterGetFirewallRulesTool(
  factory: ClientFactory,
): ToolDefinition {
  return {
    name: "db-cluster-get-firewall-rules",
    description:
      'Who may connect to a cluster (its "trusted sources"). Each rule is ' +
      '{"uuid":"…","type":"droplet|k8s|ip_addr|tag|app","value":"…",' +
      '"created_at":"…"}. NO RULES MEANS OPEN: a cluster with an empty list ' +
      "accepts connections from any address that has the password.",
    inputSchema: ONE_CLUSTER,
    annotations: READ,
    handler: (raw) =>
      guard(factory, async (api) => {
        const id = uuid(args(raw), "cluster_id", FROM_LIST);
        const body = await api().request<{ rules?: Row[] }>(
          `/databases/${id}/firewall`,
        );
        const rules = Array.isArray(body?.rules) ? body.rules : [];
        return { cluster_id: id, rules, open_to_all: rules.length === 0 };
      }),
  };
}

export function dbClusterListUsersTool(factory: ClientFactory): ToolDefinition {
  return {
    name: "db-cluster-list-users",
    description:
      "The users of a cluster: name, role (primary for the admin, normal " +
      "otherwise) and engine-specific settings. " +
      REDACTION_NOTE,
    inputSchema: ONE_CLUSTER,
    annotations: READ,
    handler: (raw) =>
      guard(factory, async (api) => {
        const id = uuid(args(raw), "cluster_id", FROM_LIST);
        const body = await api().request<{ users?: Row[] }>(
          `/databases/${id}/users`,
        );
        const users = Array.isArray(body?.users) ? body.users : [];
        return { cluster_id: id, users, count: users.length };
      }),
  };
}

export const DB_ENGINES = [
  "pg",
  "mysql",
  "valkey",
  "redis",
  "mongodb",
  "kafka",
  "opensearch",
] as const;

export function dbClusterCreateTool(factory: ClientFactory): ToolDefinition {
  return {
    name: "db-cluster-create",
    description:
      "Create a managed database cluster. It bills from creation and takes " +
      "several minutes to come up; poll db-cluster-get until `status` is " +
      "`online`. With no firewall rules it accepts connections from " +
      "anywhere with the password — add trusted sources in the control " +
      "panel. " +
      REDACTION_NOTE +
      '\n\nSizes are database slugs, e.g. "db-s-1vcpu-1gb" (not droplet ' +
      "slugs). num_nodes is 1-3 (1 = no standby).\n\n" +
      'Example: {"name":"app-db","engine":"pg","version":"17","region":' +
      '"nyc3","size":"db-s-1vcpu-1gb","num_nodes":1}',
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Cluster name, unique on the account.",
        },
        engine: {
          type: "string",
          enum: [...DB_ENGINES],
          description: "Database engine.",
        },
        version: {
          type: "string",
          description:
            'Engine major version, e.g. "17" for pg. Latest if omitted.',
        },
        region: { type: "string", description: 'Region slug, e.g. "nyc3".' },
        size: {
          type: "string",
          description: 'Database size slug, e.g. "db-s-1vcpu-1gb".',
        },
        num_nodes: {
          type: "integer",
          minimum: 1,
          maximum: 3,
          description: "Nodes, 1-3.",
        },
        storage_size_mib: {
          type: "integer",
          minimum: 1,
          description: "Disk in MiB, for sizes that allow extra storage.",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Tags to apply.",
        },
        private_network_uuid: {
          type: "string",
          description: "VPC to place it in; the region default if omitted.",
        },
      },
      required: ["name", "engine", "region", "size", "num_nodes"],
      additionalProperties: false,
    },
    annotations: CREATE,
    handler: (raw) =>
      guard(factory, async (api) => {
        const input = args(raw);
        const engine = enumValue(input, "engine", DB_ENGINES);
        if (engine === undefined) {
          throw new InputError(
            `\`engine\` is required: one of ${DB_ENGINES.join(", ")}.`,
          );
        }
        const nodes = optionalInt(input, "num_nodes", 1);
        if (nodes === undefined || nodes > 3) {
          throw new InputError(
            "`num_nodes` is required and must be 1, 2 or 3.",
          );
        }
        const body: Row = {
          name: requiredString(input, "name"),
          engine,
          region: requiredString(input, "region"),
          size: requiredString(input, "size"),
          num_nodes: nodes,
        };
        const version = optionalString(input, "version");
        if (version) body.version = version;
        const storage = optionalInt(input, "storage_size_mib", 1);
        if (storage !== undefined) body.storage_size_mib = storage;
        const tags = optionalStringArray(input, "tags");
        if (tags) body.tags = tags;
        const vpc = optionalString(input, "private_network_uuid");
        if (vpc) body.private_network_uuid = vpc;
        const result = await api().request<{ database?: Row }>("/databases", {
          method: "POST",
          body,
        });
        return {
          database: result?.database ?? {},
          next: "Poll db-cluster-get until status is online.",
        };
      }),
  };
}

export function dbClusterResizeTool(factory: ClientFactory): ToolDefinition {
  return {
    name: "db-cluster-resize",
    description:
      "Change a cluster's size, node count or storage. The cluster goes to " +
      "`resizing` and is migrated to new nodes; connections drop briefly at " +
      "the switch, and storage can be GROWN but never shrunk. Pass the full " +
      "target `size` and `num_nodes` even if only one changes (read them " +
      "from db-cluster-get). Returns once DigitalOcean accepts it; poll " +
      "db-cluster-get until `status` is `online` again.",
    inputSchema: {
      type: "object",
      properties: {
        cluster_id: CLUSTER_ID,
        size: {
          type: "string",
          description: 'Target size slug, e.g. "db-s-2vcpu-4gb".',
        },
        num_nodes: {
          type: "integer",
          minimum: 1,
          maximum: 3,
          description: "Target node count, 1-3.",
        },
        storage_size_mib: {
          type: "integer",
          minimum: 1,
          description: "Target disk in MiB (grow only).",
        },
      },
      required: ["cluster_id", "size", "num_nodes"],
      additionalProperties: false,
    },
    annotations: DESTRUCTIVE,
    handler: (raw) =>
      guard(factory, async (api) => {
        const input = args(raw);
        const id = uuid(input, "cluster_id", FROM_LIST);
        const nodes = optionalInt(input, "num_nodes", 1);
        if (nodes === undefined || nodes > 3) {
          throw new InputError(
            "`num_nodes` is required and must be 1, 2 or 3.",
          );
        }
        const body: Row = {
          size: requiredString(input, "size"),
          num_nodes: nodes,
        };
        const storage = optionalInt(input, "storage_size_mib", 1);
        if (storage !== undefined) body.storage_size_mib = storage;
        await api().request(`/databases/${id}/resize`, { method: "PUT", body });
        return {
          accepted: true,
          cluster_id: id,
          requested: body,
          next: "Poll db-cluster-get until status is online.",
        };
      }),
  };
}

export function dbClusterDeleteTool(factory: ClientFactory): ToolDefinition {
  return {
    name: "db-cluster-delete",
    description:
      "DELETE a managed database cluster and ALL ITS DATA, permanently, " +
      "including its automatic backups. There is no undo. Confirm the id " +
      "and name with db-cluster-get first, and say what you are about to " +
      "delete before you do it.",
    inputSchema: ONE_CLUSTER,
    annotations: DESTRUCTIVE_IDEMPOTENT,
    handler: (raw) =>
      guard(factory, async (api) => {
        const id = uuid(args(raw), "cluster_id", FROM_LIST);
        await api().request(`/databases/${id}`, { method: "DELETE" });
        return { deleted: true, cluster_id: id };
      }),
  };
}
