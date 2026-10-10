/**
 * The account, its money, and the catalogues a create call needs: which
 * regions, sizes, images and SSH keys exist. All GET.
 *
 * The catalogues are SUMMARISED. A raw `/v2/regions` row lists every size slug
 * the region sells and a raw `/v2/sizes` row lists every region it is sold in;
 * passing both through verbatim costs an agent thousands of tokens to learn a
 * slug. The fields kept are the ones droplet-create and db-cluster-create take.
 */

import { listPage } from "../client.js";
import {
  args,
  enumValue,
  guard,
  optionalBool,
  pageArgs,
  PAGE_PROPERTIES,
  READ,
  type ClientFactory,
  type ToolDefinition,
} from "./shared.js";

type Row = Record<string, unknown>;

/** A subset of a row's fields, in a stable order, skipping the absent ones. */
export function pick(row: unknown, keys: readonly string[]): Row {
  const source = (row && typeof row === "object" ? row : {}) as Row;
  const out: Row = {};
  for (const key of keys) if (source[key] !== undefined) out[key] = source[key];
  return out;
}

const NO_ARGS = {
  type: "object" as const,
  properties: {},
  additionalProperties: false,
};

const PAGED = {
  type: "object" as const,
  properties: { ...PAGE_PROPERTIES },
  additionalProperties: false,
};

export function accountGetInformationTool(
  factory: ClientFactory,
): ToolDefinition {
  return {
    name: "account-get-information",
    description:
      "The DigitalOcean account this server's token belongs to: email, team, " +
      "status, and the droplet / volume / floating-IP limits. Use it first to " +
      "confirm WHICH account you are about to act on.\n\n" +
      'Example: {"email":"tadas@example.com","uuid":"b6fr…","status":"active",' +
      '"droplet_limit":25,"email_verified":true,"team":{"name":"My Team"}}',
    inputSchema: NO_ARGS,
    annotations: READ,
    handler: () =>
      guard(factory, async (api) => {
        const body = await api().request<{ account?: Row }>("/account");
        return body?.account ?? {};
      }),
  };
}

export function balanceGetTool(factory: ClientFactory): ToolDefinition {
  return {
    name: "balance-get",
    description:
      "The account's current balance: `month_to_date_usage` (spend so far this " +
      "month), `account_balance` (owed, or negative for credit), " +
      "`month_to_date_balance` (the two combined) and when DigitalOcean last " +
      'computed it. Amounts are USD strings, e.g. "23.44". Needs the ' +
      "`billing:read` scope.",
    inputSchema: NO_ARGS,
    annotations: READ,
    handler: () =>
      guard(factory, async (api) =>
        api().request<Row>("/customers/my/balance"),
      ),
  };
}

export function billingHistoryListTool(factory: ClientFactory): ToolDefinition {
  return {
    name: "billing-history-list",
    description:
      "Billing history — invoices issued and payments received — newest " +
      "first, one page at a time. Each row is " +
      '{"description":"Invoice for May 2026","amount":"12.34","invoice_id":' +
      '"123","date":"2026-06-01T00:00:00Z","type":"Invoice"}; `type` is ' +
      "Invoice, Payment, Credit or similar. Needs `billing:read`.",
    inputSchema: PAGED,
    annotations: READ,
    handler: (raw) =>
      guard(factory, async (api) => {
        const { page, perPage } = pageArgs(args(raw));
        return listPage(
          api(),
          "/customers/my/billing_history",
          "billing_history",
          page,
          perPage,
        );
      }),
  };
}

export function regionListTool(factory: ClientFactory): ToolDefinition {
  return {
    name: "region-list",
    description:
      'DigitalOcean regions: `slug` (what a create call takes, e.g. "nyc3"), ' +
      "`name`, whether it is `available` for new resources, and its " +
      "`features`. The per-region size list is omitted — use size-list, " +
      "whose rows say which regions sell each size.",
    inputSchema: PAGED,
    annotations: READ,
    handler: (raw) =>
      guard(factory, async (api) => {
        const { page, perPage } = pageArgs(args(raw));
        const result = await listPage<Row>(
          api(),
          "/regions",
          "regions",
          page,
          perPage,
        );
        return {
          ...result,
          items: result.items.map((r) =>
            pick(r, ["slug", "name", "available", "features"]),
          ),
        };
      }),
  };
}

export function sizeListTool(factory: ClientFactory): ToolDefinition {
  return {
    name: "size-list",
    description:
      "Droplet sizes: `slug` (what droplet-create and the resize action take, " +
      'e.g. "s-1vcpu-1gb"), memory in MB, vCPUs, disk in GB, transfer in TB, ' +
      "USD price per month and per hour, whether it is `available`, and the " +
      "region slugs that sell it. Database sizes are a different catalogue " +
      '(e.g. "db-s-1vcpu-1gb") — DigitalOcean does not list them here.',
    inputSchema: PAGED,
    annotations: READ,
    handler: (raw) =>
      guard(factory, async (api) => {
        const { page, perPage } = pageArgs(args(raw));
        const result = await listPage<Row>(
          api(),
          "/sizes",
          "sizes",
          page,
          perPage,
        );
        return {
          ...result,
          items: result.items.map((s) =>
            pick(s, [
              "slug",
              "description",
              "memory",
              "vcpus",
              "disk",
              "transfer",
              "price_monthly",
              "price_hourly",
              "available",
              "regions",
            ]),
          ),
        };
      }),
  };
}

const IMAGE_TYPES = ["distribution", "application"] as const;

export function imageListTool(factory: ClientFactory): ToolDefinition {
  return {
    name: "image-list",
    description:
      "Images a droplet can be created or rebuilt from. `type: distribution` " +
      'is base OSes (slug e.g. "ubuntu-24-04-x64"), `type: application` is ' +
      "1-Click marketplace images, and `private: true` is this account's own " +
      "snapshots and backups (no slug — use the numeric `id`). Omit both for " +
      "everything, which is long. Each row: id, slug, name, distribution, " +
      "type, public, regions, min_disk_size (GB), status, created_at.",
    inputSchema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: [...IMAGE_TYPES],
          description:
            "distribution (base OSes) or application (1-Click apps).",
        },
        private: {
          type: "boolean",
          description: "true for only this account's snapshots and backups.",
        },
        ...PAGE_PROPERTIES,
      },
      additionalProperties: false,
    },
    annotations: READ,
    handler: (raw) =>
      guard(factory, async (api) => {
        const input = args(raw);
        const type = enumValue(input, "type", IMAGE_TYPES);
        const priv = optionalBool(input, "private");
        const { page, perPage } = pageArgs(input);
        const result = await listPage<Row>(
          api(),
          "/images",
          "images",
          page,
          perPage,
          {
            type,
            private: priv === true ? true : undefined,
          },
        );
        return {
          ...result,
          items: result.items.map((i) =>
            pick(i, [
              "id",
              "slug",
              "name",
              "distribution",
              "type",
              "public",
              "regions",
              "min_disk_size",
              "status",
              "created_at",
            ]),
          ),
        };
      }),
  };
}

export function keyListTool(factory: ClientFactory): ToolDefinition {
  return {
    name: "key-list",
    description:
      "SSH public keys registered on the account: id, name, fingerprint and " +
      "the public key. Pass an `id` or `fingerprint` in droplet-create's " +
      "`ssh_keys` to install it on a new droplet. These are PUBLIC keys; " +
      "DigitalOcean never holds the private half.",
    inputSchema: PAGED,
    annotations: READ,
    handler: (raw) =>
      guard(factory, async (api) => {
        const { page, perPage } = pageArgs(args(raw));
        return listPage(api(), "/account/keys", "ssh_keys", page, perPage);
      }),
  };
}
