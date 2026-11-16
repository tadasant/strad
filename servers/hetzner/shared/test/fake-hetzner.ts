/**
 * A fake Hetzner Cloud API as an injectable `fetch`: a route table keyed on
 * "METHOD /path", every request recorded with its headers and body.
 *
 * The shapes are Hetzner's documented ones (https://docs.hetzner.cloud/): the
 * `{"error": {"code", "message", "details"}}` envelope, `meta.pagination`, and
 * the `root_password` a create or rebuild answers with — so the redaction
 * tests run against the shape that leaks, not a sanitised one.
 */

export const TOKEN = "Hz" + "a1B2c3D4".repeat(7) + "e5F6g7";
export const BASE = "https://api.test.hetzner.cloud/v1";

export const SERVER_ID = 42;
export const ACTION_ID = 13;
export const IMAGE_ID = 9100;
export const FIREWALL_ID = 38;
export const VOLUME_ID = 9001;
export const SSH_KEY_ID = 7;
export const ROOT_PASSWORD = "YItygq1v3GxRDvXNUhEs";

export interface Recorded {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: unknown;
  redirect?: string;
}

export interface Reply {
  status?: number;
  body?: unknown;
  /** Raw text instead of JSON. */
  text?: string;
}

type Route = (req: Recorded) => Reply;

export const SERVER = {
  id: SERVER_ID,
  name: "ci-runner-2",
  status: "running",
  created: "2026-01-01T00:00:00+00:00",
  locked: false,
  primary_disk_size: 600,
  rescue_enabled: false,
  backup_window: null,
  protection: { delete: true, rebuild: true },
  labels: { role: "ci" },
  server_type: {
    id: 96,
    name: "ccx53",
    cores: 32,
    memory: 128,
    disk: 600,
    cpu_type: "dedicated",
    architecture: "x86",
  },
  datacenter: {
    id: 4,
    name: "fsn1-dc14",
    location: { id: 1, name: "fsn1", city: "Falkenstein", country: "DE" },
  },
  image: { id: 114690387, name: "ubuntu-24.04", type: "system" },
  public_net: {
    ipv4: { id: 101, ip: "203.0.113.10", blocked: false },
    ipv6: { id: 102, ip: "2001:db8::/64", blocked: false },
    floating_ips: [],
    firewalls: [{ id: FIREWALL_ID, status: "applied" }],
  },
  private_net: [{ network: 4711, ip: "10.0.1.2", alias_ips: [] }],
  volumes: [VOLUME_ID],
  included_traffic: 21990232555520,
  outgoing_traffic: 123456789,
  ingoing_traffic: 987654321,
};

export function action(command: string, id = ACTION_ID) {
  return {
    id,
    command,
    status: "running",
    progress: 0,
    started: "2026-11-16T09:00:00+00:00",
    finished: null,
    resources: [{ id: SERVER_ID, type: "server" }],
    error: null,
  };
}

function page(key: string, items: unknown[], total = items.length) {
  return {
    [key]: items,
    meta: {
      pagination: {
        page: 1,
        per_page: 25,
        previous_page: null,
        next_page: null,
        last_page: 1,
        total_entries: total,
      },
    },
  };
}

export class FakeHetzner {
  readonly calls: Recorded[] = [];
  private readonly routes = new Map<string, Route>();
  /** Applied to every response body, e.g. to make it echo the token. */
  mutate: (text: string) => string = (t) => t;

  constructor() {
    const r = (key: string, reply: Reply | Route) => this.on(key, reply);
    const id = SERVER_ID;

    r("GET /v1/servers", { body: page("servers", [SERVER]) });
    r(`GET /v1/servers/${id}`, { body: { server: SERVER } });
    r(`GET /v1/servers/${id}/metrics`, (req) => {
      const start = Date.parse(req.url.searchParams.get("start") ?? "") / 1000;
      const values = Array.from({ length: 60 }, (_, i) => [
        start + i * 60,
        String(i === 59 ? 3011.9 : 100 + i),
      ]);
      return {
        body: {
          metrics: {
            start: req.url.searchParams.get("start"),
            end: req.url.searchParams.get("end"),
            step: Number(req.url.searchParams.get("step")),
            time_series: { cpu: { values } },
          },
        },
      };
    });
    r(`GET /v1/servers/${id}/actions`, {
      body: page("actions", [
        { ...action("reboot_server"), status: "success" },
      ]),
    });
    r(`GET /v1/actions/${ACTION_ID}`, {
      body: { action: { ...action("stop_server"), status: "success" } },
    });
    r("GET /v1/images", {
      body: page("images", [
        {
          id: IMAGE_ID,
          type: "snapshot",
          status: "available",
          name: null,
          description: "before upgrade",
          image_size: 12.5,
          disk_size: 600,
          created_from: { id, name: "ci-runner-2" },
          protection: { delete: false },
          labels: {},
          architecture: "x86",
          rapid_deploy: false,
        },
      ]),
    });
    r("GET /v1/server_types", {
      body: page("server_types", [
        {
          id: 96,
          name: "ccx53",
          description: "CCX53 Dedicated CPU",
          cores: 32,
          memory: 128,
          disk: 600,
          cpu_type: "dedicated",
          architecture: "x86",
          storage_type: "local",
          deprecated: false,
          prices: [
            {
              location: "fsn1",
              price_hourly: { net: "0.4", gross: "0.476" },
              price_monthly: { net: "250", gross: "297.5" },
              included_traffic: 1,
              price_per_tb_traffic: { net: "1", gross: "1.19" },
            },
          ],
        },
      ]),
    });
    r("GET /v1/locations", {
      body: page("locations", [
        {
          id: 1,
          name: "fsn1",
          description: "Falkenstein DC Park 1",
          country: "DE",
          city: "Falkenstein",
          latitude: 50.47612,
          longitude: 12.370071,
          network_zone: "eu-central",
        },
      ]),
    });
    r("GET /v1/datacenters", {
      body: page("datacenters", [
        {
          id: 4,
          name: "fsn1-dc14",
          description: "Falkenstein 1 virtual DC 14",
          location: { id: 1, name: "fsn1" },
          server_types: {
            supported: [1, 96],
            available: [96],
            available_for_migration: [96],
          },
        },
      ]),
    });
    r("GET /v1/ssh_keys", {
      body: page("ssh_keys", [
        {
          id: SSH_KEY_ID,
          name: "ci-deploy",
          fingerprint: "b7:2f:30:a0:2f:6c:58:6c:21:04:58:61:ba:06:3b:2f",
          public_key:
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGd9ZXhhbXBsZWtleWZvcnRlc3Rz ci",
          labels: {},
          created: "2026-01-01T00:00:00+00:00",
        },
      ]),
    });
    r("GET /v1/firewalls", {
      body: page("firewalls", [
        {
          id: FIREWALL_ID,
          name: "ci",
          rules: [
            {
              direction: "in",
              protocol: "tcp",
              port: "22",
              source_ips: ["0.0.0.0/0", "::/0"],
              destination_ips: [],
              description: "ssh",
            },
          ],
          applied_to: [{ type: "server", server: { id } }],
          labels: {},
        },
      ]),
    });
    r("GET /v1/networks", {
      body: page("networks", [
        {
          id: 4711,
          name: "ci-net",
          ip_range: "10.0.0.0/16",
          subnets: [],
          routes: [],
          servers: [id],
        },
      ]),
    });
    r("GET /v1/primary_ips", {
      body: page("primary_ips", [
        {
          id: 101,
          name: "ci-runner-2-v4",
          type: "ipv4",
          ip: "203.0.113.10",
          assignee_id: id,
          assignee_type: "server",
          auto_delete: false,
          blocked: false,
          datacenter: { id: 4, name: "fsn1-dc14" },
          protection: { delete: true },
          dns_ptr: [{ ip: "203.0.113.10", dns_ptr: "ci.example.com" }],
          labels: {},
        },
      ]),
    });
    r("GET /v1/volumes", {
      body: page("volumes", [
        {
          id: VOLUME_ID,
          name: "ci-cache",
          size: 500,
          server: id,
          location: { id: 1, name: "fsn1" },
          linux_device: `/dev/disk/by-id/scsi-0HC_Volume_${VOLUME_ID}`,
          format: "ext4",
          status: "available",
          protection: { delete: false },
          labels: {},
        },
      ]),
    });

    r("POST /v1/servers", (req) => ({
      status: 201,
      body: {
        server: {
          ...SERVER,
          id: 43,
          ...(req.body as object),
          status: "initializing",
        },
        action: action("create_server", 14),
        next_actions: [action("start_server", 15)],
        root_password: null,
      },
    }));
    for (const verb of ["poweron", "poweroff", "reboot", "reset", "shutdown"]) {
      r(`POST /v1/servers/${id}/actions/${verb}`, {
        status: 201,
        body: { action: action(`${verb}_server`) },
      });
    }
    r(`POST /v1/servers/${id}/actions/rebuild`, {
      status: 201,
      body: { action: action("rebuild_server"), root_password: ROOT_PASSWORD },
    });
    r(`POST /v1/servers/${id}/actions/change_type`, {
      status: 201,
      body: { action: action("change_server_type") },
    });
    r(`POST /v1/servers/${id}/actions/create_image`, {
      status: 201,
      body: {
        image: {
          id: IMAGE_ID + 1,
          type: "snapshot",
          status: "creating",
          description: "snap",
          created_from: { id, name: "ci-runner-2" },
        },
        action: action("create_image"),
      },
    });
    r(`DELETE /v1/servers/${id}`, {
      body: { action: action("delete_server") },
    });
    r(`DELETE /v1/images/${IMAGE_ID}`, { status: 204 });
    r("POST /v1/ssh_keys", (req) => ({
      status: 201,
      body: {
        ssh_key: { id: 8, fingerprint: "aa:bb", ...(req.body as object) },
      },
    }));
    r(`DELETE /v1/ssh_keys/${SSH_KEY_ID}`, { status: 204 });
    for (const verb of [
      "set_rules",
      "apply_to_resources",
      "remove_from_resources",
    ]) {
      r(`POST /v1/firewalls/${FIREWALL_ID}/actions/${verb}`, {
        status: 201,
        body: { actions: [action(verb), action(verb, ACTION_ID + 1)] },
      });
    }
    for (const verb of ["attach", "detach"]) {
      r(`POST /v1/volumes/${VOLUME_ID}/actions/${verb}`, {
        status: 201,
        body: { action: action(`${verb}_volume`) },
      });
    }
  }

  /** Replace one route's reply. */
  on(key: string, reply: Reply | Route): void {
    this.routes.set(key, typeof reply === "function" ? reply : () => reply);
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const method = (init?.method ?? "GET").toUpperCase();
    const body =
      typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    this.calls.push({
      method,
      url,
      headers,
      body,
      ...(init?.redirect ? { redirect: init.redirect } : {}),
    });

    const route = this.routes.get(`${method} ${url.pathname}`);
    const reply: Reply = route
      ? route(this.calls[this.calls.length - 1]!)
      : {
          status: 404,
          body: {
            error: {
              code: "not_found",
              message: "server with ID '999' not found",
              details: {},
            },
          },
        };
    const status = reply.status ?? 200;
    const text = this.mutate(
      reply.text ??
        (reply.body === undefined ? "" : JSON.stringify(reply.body)),
    );
    return new Response(status === 204 ? null : text, { status });
  };
}
