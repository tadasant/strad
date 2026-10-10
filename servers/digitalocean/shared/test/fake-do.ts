/**
 * A fake DigitalOcean API as an injectable `fetch`: a route table keyed on
 * "METHOD /path", every request recorded with its headers and body.
 *
 * The fixtures carry the credential material the real API returns — database
 * passwords, URIs with the password in them, Kafka access keys — so the
 * redaction tests run against the shape that leaks, not a sanitised one.
 */

export const TOKEN = "dop_v1_" + "a1b2c3d4".repeat(8);
export const BASE = "https://api.test.digitalocean.com/v2";
export const LOGS_ORIGIN = "https://nyc3.test.digitaloceanspaces.com";

export const APP_ID = "4f6c71e2-1e90-4762-9fee-6cc4a0a9f2cf";
export const DEPLOY_ACTIVE = "b6bb1e17-7bc7-4b5d-8a5b-3c8f8a2b1a01";
export const DEPLOY_LATEST = "c7cc2f28-8cd8-4c6e-9b6c-4d9f9b3c2b02";
export const DB_ID = "9cc10173-e9ea-4176-9dbc-a4cee4c4ff30";

export const DB_PASSWORD = "AVNS_s3cr3tPassw0rd";
export const USER_PASSWORD = "AVNS_userPassw0rd2";

export interface Recorded {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: unknown;
  /** The `redirect` mode the caller asked for, if any. */
  redirect?: string;
}

export interface Reply {
  status?: number;
  body?: unknown;
  /** Raw text instead of JSON. */
  text?: string;
  /** Response headers, e.g. a redirect's `location`. */
  headers?: Record<string, string>;
}

type Route = (req: Recorded) => Reply;

const DROPLET = {
  id: 3164444,
  name: "web-1",
  memory: 1024,
  vcpus: 1,
  disk: 25,
  locked: false,
  status: "active",
  created_at: "2026-01-01T00:00:00Z",
  size_slug: "s-1vcpu-1gb",
  region: { slug: "nyc3", name: "New York 3" },
  image: {
    id: 1,
    slug: "ubuntu-24-04-x64",
    name: "24.04",
    distribution: "Ubuntu",
  },
  networks: {
    v4: [
      { ip_address: "104.236.32.182", type: "public" },
      { ip_address: "10.128.0.2", type: "private" },
    ],
    v6: [],
  },
  tags: ["web"],
  vpc_uuid: "vpc-1",
  features: ["monitoring"],
};

const CONNECTION = {
  protocol: "postgresql",
  uri: `postgresql://doadmin:${DB_PASSWORD}@db-host.b.db.ondigitalocean.com:25060/defaultdb?sslmode=require`,
  database: "defaultdb",
  host: "db-host.b.db.ondigitalocean.com",
  port: 25060,
  user: "doadmin",
  password: DB_PASSWORD,
  ssl: true,
};

export const CLUSTER = {
  id: DB_ID,
  name: "app-db",
  engine: "pg",
  version: "17",
  status: "online",
  region: "nyc3",
  size: "db-s-1vcpu-1gb",
  num_nodes: 1,
  storage_size_mib: 10240,
  created_at: "2026-01-01T00:00:00Z",
  tags: ["prod"],
  db_names: ["defaultdb"],
  connection: CONNECTION,
  private_connection: {
    ...CONNECTION,
    host: "private-db-host.b.db.ondigitalocean.com",
    uri: `postgresql://doadmin:${DB_PASSWORD}@private-db-host.b.db.ondigitalocean.com:25060/defaultdb`,
  },
  standby_connection: { ...CONNECTION, host: "replica-db-host" },
  standby_private_connection: {
    ...CONNECTION,
    host: "private-replica-db-host",
  },
  users: [
    { name: "doadmin", role: "primary", password: DB_PASSWORD },
    { name: "app", role: "normal", password: USER_PASSWORD },
    {
      name: "kafka-user",
      role: "normal",
      password: USER_PASSWORD,
      access_cert:
        "-----BEGIN CERTIFICATE-----\nMIIabc\n-----END CERTIFICATE-----",
      access_key:
        "-----BEGIN PRIVATE KEY-----\nMIIdef\n-----END PRIVATE KEY-----",
    },
  ],
};

const APP = {
  id: APP_ID,
  spec: {
    name: "strad",
    region: "nyc",
    services: [
      {
        name: "core",
        envs: [
          {
            key: "DATABASE_URL",
            value: `postgres://app:${USER_PASSWORD}@db-host:25060/app`,
            type: "GENERAL",
          },
          { key: "API_KEY", value: "EV[1:abc:def]", type: "SECRET" },
        ],
      },
    ],
    workers: [{ name: "jobs" }],
  },
  region: { slug: "nyc" },
  live_url: "https://strad-abc.ondigitalocean.app",
  default_ingress: "https://strad-abc.ondigitalocean.app",
  active_deployment: { id: DEPLOY_ACTIVE, phase: "ACTIVE", cause: "manual" },
  created_at: "2026-01-01T00:00:00Z",
};

const LATEST_DEPLOYMENT = {
  id: DEPLOY_LATEST,
  phase: "ERROR",
  cause: "commit 1a2b pushed",
  created_at: "2026-10-09T00:00:00Z",
  progress: {
    success_steps: 3,
    error_steps: 1,
    total_steps: 6,
    steps: [
      {
        name: "build",
        status: "ERROR",
        steps: [
          {
            name: "build-core",
            component_name: "core",
            status: "ERROR",
            reason: { code: "BuildJobFailed", message: "exit 1" },
          },
        ],
      },
      { name: "deploy", status: "PENDING" },
    ],
  },
};

export const LOG_TEXT =
  Array.from({ length: 450 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";

function page(
  key: string,
  items: unknown[],
  total = items.length,
  next = false,
) {
  return {
    [key]: items,
    meta: { total },
    links: next ? { pages: { next: `${BASE}/x?page=2` } } : {},
  };
}

export class FakeDigitalOcean {
  readonly calls: Recorded[] = [];
  readonly routes = new Map<string, Route>();
  /** Every reply's text is passed through this, so a test can make it echo. */
  mutate: (text: string) => string = (t) => t;

  constructor() {
    const r = (key: string, reply: Route | Reply) =>
      this.routes.set(key, typeof reply === "function" ? reply : () => reply);

    r("GET /v2/account", {
      body: {
        account: {
          email: "t@example.com",
          uuid: "u-1",
          status: "active",
          droplet_limit: 25,
        },
      },
    });
    r("GET /v2/customers/my/balance", {
      body: {
        month_to_date_balance: "23.44",
        account_balance: "12.23",
        month_to_date_usage: "11.21",
        generated_at: "2026-10-09T00:00:00Z",
      },
    });
    r("GET /v2/customers/my/billing_history", {
      body: page(
        "billing_history",
        [
          {
            description: "Invoice for Sep 2026",
            amount: "12.34",
            invoice_id: "1",
            date: "2026-10-01T00:00:00Z",
            type: "Invoice",
          },
        ],
        45,
        true,
      ),
    });
    r("GET /v2/regions", {
      body: page("regions", [
        {
          slug: "nyc3",
          name: "New York 3",
          available: true,
          features: ["backups"],
          sizes: ["s-1vcpu-1gb"],
        },
      ]),
    });
    r("GET /v2/sizes", {
      body: page("sizes", [
        {
          slug: "s-1vcpu-1gb",
          memory: 1024,
          vcpus: 1,
          disk: 25,
          transfer: 1,
          price_monthly: 6,
          price_hourly: 0.00893,
          available: true,
          regions: ["nyc3"],
          description: "Basic",
        },
      ]),
    });
    r("GET /v2/images", {
      body: page("images", [
        {
          id: 1,
          slug: "ubuntu-24-04-x64",
          name: "24.04",
          distribution: "Ubuntu",
          type: "base",
          public: true,
          regions: ["nyc3"],
          min_disk_size: 7,
          status: "available",
          created_at: "2026-01-01T00:00:00Z",
          description: "long",
        },
      ]),
    });
    r("GET /v2/account/keys", {
      body: page("ssh_keys", [
        {
          id: 512189,
          fingerprint: "3b:16:bf:e4",
          public_key:
            "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQCxyzxyzxyzxyzxyzxyzxyzxyzxyzxyzxyzxyzxyz me",
          name: "laptop",
        },
      ]),
    });
    r("GET /v2/droplets", { body: page("droplets", [DROPLET], 1) });
    r("GET /v2/droplets/3164444", { body: { droplet: DROPLET } });
    r("GET /v2/droplets/3164444/actions/36804636", {
      body: {
        action: {
          id: 36804636,
          status: "completed",
          type: "power_off",
          resource_id: 3164444,
        },
      },
    });
    r("POST /v2/droplets", (req) => ({
      status: 202,
      body: {
        droplet: {
          ...DROPLET,
          id: 3164500,
          status: "new",
          name: (req.body as { name: string }).name,
          networks: { v4: [], v6: [] },
        },
        links: {
          actions: [
            { id: 36805022, rel: "create", href: `${BASE}/actions/36805022` },
          ],
        },
      },
    }));
    r("DELETE /v2/droplets/3164444", { status: 204 });
    r("POST /v2/droplets/3164444/actions", (req) => ({
      status: 201,
      body: {
        action: {
          id: 36804637,
          status: "in-progress",
          type: (req.body as { type: string }).type,
          resource_id: 3164444,
        },
      },
    }));

    r("GET /v2/apps", { body: page("apps", [APP], 1) });
    r(`GET /v2/apps/${APP_ID}`, { body: { app: APP } });
    r(`GET /v2/apps/${APP_ID}/deployments`, {
      body: page("deployments", [LATEST_DEPLOYMENT], 7, true),
    });
    r(`GET /v2/apps/${APP_ID}/deployments/${DEPLOY_ACTIVE}`, {
      body: {
        deployment: {
          id: DEPLOY_ACTIVE,
          phase: "ACTIVE",
          progress: { success_steps: 6, total_steps: 6, steps: [] },
        },
      },
    });
    const logs = () => ({
      body: {
        live_url: "wss://live.example/x",
        historic_urls: [`${LOGS_ORIGIN}/logs/abc?X-Amz-Signature=sig`],
      },
    });
    r(`GET /v2/apps/${APP_ID}/deployments/${DEPLOY_ACTIVE}/logs`, logs);
    r(`GET /v2/apps/${APP_ID}/deployments/${DEPLOY_LATEST}/logs`, logs);
    r(
      `GET /v2/apps/${APP_ID}/deployments/${DEPLOY_LATEST}/components/core/logs`,
      logs,
    );
    r(
      `GET /v2/apps/${APP_ID}/deployments/${DEPLOY_ACTIVE}/components/core/logs`,
      logs,
    );
    r("POST /v2/apps", (req) => ({
      body: { app: { ...APP, spec: (req.body as { spec: unknown }).spec } },
    }));
    r(`PUT /v2/apps/${APP_ID}`, (req) => ({
      body: { app: { ...APP, spec: (req.body as { spec: unknown }).spec } },
    }));
    r(`POST /v2/apps/${APP_ID}/deployments`, {
      body: {
        deployment: {
          id: DEPLOY_LATEST,
          phase: "PENDING_BUILD",
          cause: "manual",
          created_at: "2026-10-09T00:00:00Z",
        },
      },
    });
    r(`DELETE /v2/apps/${APP_ID}`, { body: { id: APP_ID } });

    r("GET /v2/databases", {
      body: { databases: [CLUSTER, { ...CLUSTER, id: "other", name: "db-2" }] },
    });
    r(`GET /v2/databases/${DB_ID}`, { body: { database: CLUSTER } });
    r(`GET /v2/databases/${DB_ID}/backups`, {
      body: {
        backups: [{ created_at: "2026-10-08T00:00:00Z", size_gigabytes: 0.03 }],
      },
    });
    r(`GET /v2/databases/${DB_ID}/firewall`, {
      body: {
        rules: [
          {
            uuid: "r-1",
            type: "app",
            value: APP_ID,
            created_at: "2026-01-01T00:00:00Z",
          },
        ],
      },
    });
    r(`GET /v2/databases/${DB_ID}/users`, { body: { users: CLUSTER.users } });
    r("POST /v2/databases", (req) => ({
      status: 201,
      body: {
        database: { ...CLUSTER, ...(req.body as object), status: "creating" },
      },
    }));
    r(`PUT /v2/databases/${DB_ID}/resize`, { status: 202 });
    r(`DELETE /v2/databases/${DB_ID}`, { status: 204 });

    this.routes.set(`GET ${new URL(LOGS_ORIGIN).host}/logs/abc`, () => ({
      text: LOG_TEXT,
    }));
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
    const req: Recorded = {
      method,
      url,
      headers,
      body,
      ...(init?.redirect ? { redirect: init.redirect } : {}),
    };
    this.calls.push(req);

    const apiKey = `${method} ${url.pathname}`;
    const route =
      url.origin === new URL(BASE).origin
        ? this.routes.get(apiKey)
        : this.routes.get(`${method} ${url.host}${url.pathname}`);
    const reply: Reply = route
      ? route(req)
      : {
          status: 404,
          body: {
            id: "not_found",
            message: "The resource you were accessing could not be found.",
          },
        };
    const status = reply.status ?? 200;
    // What `fetch` itself does with `redirect: "error"`: no response at all.
    if (status >= 300 && status < 400 && init?.redirect === "error") {
      throw new TypeError("fetch failed: unexpected redirect");
    }
    const text = this.mutate(
      reply.text ??
        (reply.body === undefined ? "" : JSON.stringify(reply.body)),
    );
    return new Response(status === 204 || status === 302 ? null : text, {
      status,
      ...(reply.headers ? { headers: reply.headers } : {}),
    });
  };
}
