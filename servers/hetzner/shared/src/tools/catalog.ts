/**
 * What a server is made of and where it can go — images, server types,
 * locations, datacenters — and the project's SSH keys. Mostly reads; the
 * writes are deleting a snapshot and adding or removing an SSH key.
 */

import { InputError } from "../errors.js";
import { listPage } from "../client.js";
import {
  args,
  BLAST_RADIUS,
  CREATE,
  DESTRUCTIVE_IDEMPOTENT,
  enumValue,
  guard,
  NAME_AND_LABEL_PROPERTIES,
  optionalBool,
  optionalLabels,
  optionalString,
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

export const IMAGE_TYPES = ["system", "snapshot", "backup", "app"] as const;

export function summariseImage(raw: unknown): Row {
  return pick(raw, [
    "id",
    "type",
    "status",
    "name",
    "description",
    "os_flavor",
    "os_version",
    "architecture",
    "image_size",
    "disk_size",
    "created",
    "created_from",
    "bound_to",
    "deprecated",
    "protection",
    "labels",
  ]);
}

export function listImagesTool(factory: ClientFactory): ToolDefinition {
  return {
    name: "list_images",
    description:
      "Images a server can be created or rebuilt from, one page at a time.\n\n" +
      "`type`:\n" +
      '- system — Hetzner\'s OS images; pass the `name` ("ubuntu-24.04")\n' +
      "- snapshot — this project's snapshots (create_server_image); pass the " +
      "numeric `id`. Billed per GB-month\n" +
      "- backup — automatic backups, `bound_to` the server they belong to\n" +
      "- app — Hetzner's one-click app images\n\n" +
      "`image_size` is the stored size in GB (what a snapshot bills on), " +
      "`disk_size` the disk it needs.\n\n" +
      'Example row: {"id":114690387,"type":"system","status":"available",' +
      '"name":"ubuntu-24.04","os_flavor":"ubuntu","architecture":"x86"}',
    inputSchema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: [...IMAGE_TYPES],
          description: "Only images of this type.",
        },
        architecture: {
          type: "string",
          enum: ["x86", "arm"],
          description: "Only images for this CPU architecture.",
        },
        ...NAME_AND_LABEL_PROPERTIES,
        include_deprecated: {
          type: "boolean",
          description: "Include deprecated system images. Default false.",
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
          "/images",
          "images",
          page,
          perPage,
          {
            type: enumValue(input, "type", IMAGE_TYPES),
            architecture: enumValue(input, "architecture", ["x86", "arm"]),
            name: optionalString(input, "name"),
            label_selector: optionalString(input, "label_selector"),
            include_deprecated: optionalBool(input, "include_deprecated"),
            sort: "id:desc",
          },
        );
        return { ...result, items: result.items.map(summariseImage) };
      }),
  };
}

/**
 * A server type with its prices flattened to one row per location, gross
 * monthly and hourly in EUR — the number a human compares — instead of
 * Hetzner's nested net/gross objects.
 */
export function summariseServerType(raw: unknown): Row {
  const t = (raw && typeof raw === "object" ? raw : {}) as Row;
  const prices = Array.isArray(t.prices) ? (t.prices as Row[]) : [];
  return {
    ...pick(t, [
      "id",
      "name",
      "description",
      "cores",
      "memory",
      "disk",
      "cpu_type",
      "architecture",
      "storage_type",
      "deprecated",
    ]),
    prices_eur: prices.map((p) => ({
      location: p.location,
      monthly_gross: (p.price_monthly as Row | undefined)?.gross,
      hourly_gross: (p.price_hourly as Row | undefined)?.gross,
    })),
  };
}

export function listServerTypesTool(factory: ClientFactory): ToolDefinition {
  return {
    name: "list_server_types",
    description:
      "Server types (sizes) with cores, memory GB, disk GB, `cpu_type` " +
      "(shared or dedicated), architecture (x86 or arm) and the gross EUR " +
      "price per location, monthly and hourly. What create_server and " +
      "change_server_type take as `server_type`.\n\n" +
      'Example row: {"id":96,"name":"ccx53","cores":32,"memory":128,' +
      '"disk":600,"cpu_type":"dedicated","architecture":"x86",' +
      '"prices_eur":[{"location":"fsn1","monthly_gross":"…","hourly_gross":"…"}]}',
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: 'Only the type with exactly this name, e.g. "ccx53".',
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
          "/server_types",
          "server_types",
          page,
          perPage,
          { name: optionalString(input, "name") },
        );
        return { ...result, items: result.items.map(summariseServerType) };
      }),
  };
}

export function listLocationsTool(factory: ClientFactory): ToolDefinition {
  return {
    name: "list_locations",
    description:
      "Hetzner locations: `name` (what create_server takes as `location`), " +
      "city, country and network zone. Private networks span one network " +
      "zone.\n\n" +
      'Example row: {"id":1,"name":"fsn1","description":"Falkenstein DC Park 1",' +
      '"country":"DE","city":"Falkenstein","network_zone":"eu-central"}',
    inputSchema: {
      type: "object",
      properties: { ...PAGE_PROPERTIES },
      additionalProperties: false,
    },
    annotations: READ,
    handler: (raw) =>
      guard(factory, async (api) => {
        const { page, perPage } = pageArgs(args(raw));
        const result = await listPage<Row>(
          api(),
          "/locations",
          "locations",
          page,
          perPage,
        );
        return {
          ...result,
          items: result.items.map((l) =>
            pick(l, [
              "id",
              "name",
              "description",
              "country",
              "city",
              "network_zone",
            ]),
          ),
        };
      }),
  };
}

export function listDatacentersTool(factory: ClientFactory): ToolDefinition {
  return {
    name: "list_datacenters",
    description:
      "Datacenters (a location has one or more) and which server type ids " +
      "each can create right now: `server_types.available` is what has " +
      "capacity today, `supported` what it offers at all, " +
      "`available_for_migration` what change_server_type can move to there. " +
      "Use it when a create fails for capacity. Match ids against " +
      "list_server_types.\n\n" +
      'Example row: {"id":4,"name":"fsn1-dc14","location":"fsn1",' +
      '"server_types":{"available":[1,3,96],"supported":[…],' +
      '"available_for_migration":[…]}}',
    inputSchema: {
      type: "object",
      properties: { ...PAGE_PROPERTIES },
      additionalProperties: false,
    },
    annotations: READ,
    handler: (raw) =>
      guard(factory, async (api) => {
        const { page, perPage } = pageArgs(args(raw));
        const result = await listPage<Row>(
          api(),
          "/datacenters",
          "datacenters",
          page,
          perPage,
        );
        return {
          ...result,
          items: result.items.map((d) => ({
            ...pick(d, ["id", "name", "description"]),
            location: ((d.location ?? {}) as Row).name,
            ...pick(d, ["server_types"]),
          })),
        };
      }),
  };
}

export function listSshKeysTool(factory: ClientFactory): ToolDefinition {
  return {
    name: "list_ssh_keys",
    description:
      "SSH public keys stored in the project: id, name, fingerprint, the " +
      "public key itself, labels. These are what create_server's `ssh_keys` " +
      "takes (by name or id). A key here is only installed on servers created " +
      "or rebuilt after it was added; removing one does not take it off any " +
      "server.\n\n" +
      'Example row: {"id":7,"name":"ci-deploy",' +
      '"fingerprint":"b7:2f:30:a0:…","public_key":"ssh-ed25519 AAAA… ci",' +
      '"labels":{}}',
    inputSchema: {
      type: "object",
      properties: {
        ...NAME_AND_LABEL_PROPERTIES,
        fingerprint: {
          type: "string",
          description: 'Only the key with this MD5 fingerprint, "b7:2f:…".',
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
          "/ssh_keys",
          "ssh_keys",
          page,
          perPage,
          {
            name: optionalString(input, "name"),
            fingerprint: optionalString(input, "fingerprint"),
            label_selector: optionalString(input, "label_selector"),
          },
        );
        return {
          ...result,
          items: result.items.map((k) =>
            pick(k, [
              "id",
              "name",
              "fingerprint",
              "public_key",
              "labels",
              "created",
            ]),
          ),
        };
      }),
  };
}

export function deleteImageTool(factory: ClientFactory): ToolDefinition {
  return {
    name: "delete_image",
    description:
      "DELETE a snapshot or backup image, permanently. There is no undo; a " +
      "server can no longer be rebuilt or restored from it. Hetzner's own " +
      "system images cannot be deleted. An image with delete protection on " +
      "is refused with `protected`; this server cannot lift protection. " +
      "Confirm the id with list_images (type snapshot or backup) first." +
      BLAST_RADIUS,
    inputSchema: {
      type: "object",
      properties: {
        image_id: {
          type: "integer",
          minimum: 1,
          description: "The image's numeric id, from list_images.",
        },
      },
      required: ["image_id"],
      additionalProperties: false,
    },
    annotations: DESTRUCTIVE_IDEMPOTENT,
    handler: (raw) =>
      guard(factory, async (api) => {
        const id = resourceId(
          args(raw),
          "image_id",
          "an image's numeric id (from list_images)",
        );
        await api().request(`/images/${id}`, { method: "DELETE" });
        return {
          deleted: true,
          image_id: id,
          note: "Hetzner accepted the delete (HTTP 204). It is gone.",
        };
      }),
  };
}

export function createSshKeyTool(factory: ClientFactory): ToolDefinition {
  return {
    name: "create_ssh_key",
    description:
      "Add an SSH PUBLIC key to the project, so create_server and " +
      "rebuild_server can install it. It is NOT added to any server that " +
      "already exists. Never pass a private key.\n\n" +
      'Example: {"name":"ci-deploy","public_key":"ssh-ed25519 AAAAC3Nz… ci@host"}',
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "A name unique in the project.",
        },
        public_key: {
          type: "string",
          description:
            'The OpenSSH public key line, "ssh-ed25519 AAAA… comment".',
        },
        labels: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "Labels for the key.",
        },
      },
      required: ["name", "public_key"],
      additionalProperties: false,
    },
    annotations: CREATE,
    handler: (raw) =>
      guard(factory, async (api) => {
        const input = args(raw);
        const publicKey = requiredString(input, "public_key");
        if (/PRIVATE KEY/.test(publicKey)) {
          throw new InputError(
            "`public_key` looks like a PRIVATE key. Pass the `.pub` line " +
              '("ssh-ed25519 AAAA…"); nothing was sent.',
          );
        }
        const body: Row = {
          name: requiredString(input, "name"),
          public_key: publicKey,
        };
        const labels = optionalLabels(input);
        if (labels) body.labels = labels;
        const result = await api().request<{ ssh_key?: Row }>("/ssh_keys", {
          method: "POST",
          body,
        });
        return result?.ssh_key ?? {};
      }),
  };
}

export function deleteSshKeyTool(factory: ClientFactory): ToolDefinition {
  return {
    name: "delete_ssh_key",
    description:
      "Remove an SSH key from the project. Servers that already have it keep " +
      "it in their authorized_keys — this does not revoke access to any " +
      "machine. It only stops the key being installed on new or rebuilt " +
      "servers.",
    inputSchema: {
      type: "object",
      properties: {
        ssh_key_id: {
          type: "integer",
          minimum: 1,
          description: "The key's numeric id, from list_ssh_keys.",
        },
      },
      required: ["ssh_key_id"],
      additionalProperties: false,
    },
    annotations: DESTRUCTIVE_IDEMPOTENT,
    handler: (raw) =>
      guard(factory, async (api) => {
        const id = resourceId(
          args(raw),
          "ssh_key_id",
          "an SSH key's numeric id (from list_ssh_keys)",
        );
        await api().request(`/ssh_keys/${id}`, { method: "DELETE" });
        return { deleted: true, ssh_key_id: id };
      }),
  };
}
