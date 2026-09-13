import type { Server } from "node:http";
import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import {
  InMemoryLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { tokenStoreFromConfig } from "../src/auth/index.ts";
import { parseConfig } from "../src/config/load.ts";
import { isConnectorClientPath } from "../src/connectors/index.ts";
import { Registry } from "../src/gateway/registry.ts";
import { createApp } from "../src/http/app.ts";
import { createFakeGcp, type FakeGcp } from "../src/secrets/parameters/fake.ts";
import {
  ParameterStoreError,
  type ParameterStore,
} from "../src/secrets/parameters/index.ts";
import { parameterId } from "../src/secrets/parameters/wire.ts";
import {
  EnvSecretProvider,
  sharedSecretProviders,
} from "../src/secrets/provider/index.ts";
import {
  disableEventExport,
  enableEventExport,
  resetEventThrottle,
} from "../src/telemetry/events.ts";

/**
 * The console reading a connector's own OAuth client — the grant that makes
 * **Connect** work, made and PROVED rather than assumed.
 *
 * Seeding an `oauth:` connector's client is not enough on a console run the way
 * docs/operate/secrets-iam.md §1 prescribes: the credential can create the two
 * secrets and cannot read them back, so the first press of **Connect** 403s.
 * There are two halves to fixing it and this suite holds both to the same bar.
 *
 *   CREATE grants, and only where config says. The flag is derived from the
 *   server's own `oauth:` block by `isConnectorClientPath`, so the binding lands
 *   on that slug's client id and client secret and on nothing else — not a
 *   sibling parameter in the same namespace, not the refresh token, not the same
 *   variable name under a slug with no connector.
 *
 *   REPAIR is verified. The console binds itself and then READS THE VALUE BACK,
 *   because an IAM deny policy is evaluated before any allow and cannot be
 *   granted around: on a deployment that applied `strad-console-no-read`, the
 *   `setIamPolicy` succeeds and the read still fails. A button that claimed
 *   success there would move the failure to after the consent screen, which is
 *   worse than the hand-run `gcloud` loop it replaces. The deny-policy shape has
 *   a test of its own below, and it asserts the binding IS present and the page
 *   says so anyway.
 *
 * The store is the real GCP client over the fake's two maps, and the console is
 * `storeAs(WRITE_ONLY_CONSOLE)` — the prod credential, spelled out — so every
 * 403 here is the fake refusing the same call Google would.
 */

const BOOTSTRAP = "bootstrap-secret-for-the-client-grant-suite";
const SESSION_KEY = "a-console-session-secret-of-adequate-length";
const SLUG = "google-sheets-tadas412-ro";
/** A second connector slug, to prove a grant does not spill sideways. */
const OTHER_SLUG = "google-sheets-tadas412-rw";
/** A slug with no `oauth:` block at all, holding the same variable NAMES. */
const PLAIN_SLUG = "gcs";
const ENV = "test";
const ns = (slug: string, kind = "static") =>
  `/strad/${ENV}/mcp/${slug}/${kind}/`;
const NS = ns(SLUG);
const CLIENT_ID_VAR = "GOOGLE_SHEETS_OAUTH_CLIENT_ID";
const CLIENT_SECRET_VAR = "GOOGLE_SHEETS_OAUTH_CLIENT_SECRET";
const REFRESH_VAR = "GOOGLE_SHEETS_OAUTH_REFRESH_TOKEN";
const CLIENT_ID = "6-CLIENT-ID-CANARY.apps.googleusercontent.com";
const CLIENT_SECRET = "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LEAK";
const REFRESH_TOKEN = "1//REFRESH-TOKEN-CANARY-NOBODY-HAS-SEEN-THIS";

const CANARIES = [CLIENT_ID, CLIENT_SECRET, REFRESH_TOKEN];

/** Secret Manager's direct read permission — the one §1 withholds. */
const ACCESS_PERMISSION = "secretmanager.versions.access";

/**
 * The prod console: both custom roles from secrets-iam.md §1, spelled out.
 * Everything it needs to list, write and delete — and no
 * `secretmanager.versions.access`, which is the whole point of the file.
 */
const WRITE_ONLY_CONSOLE: readonly string[] = [
  "secretmanager.secrets.create",
  "secretmanager.secrets.delete",
  "secretmanager.secrets.get",
  "secretmanager.secrets.list",
  "secretmanager.secrets.getIamPolicy",
  "secretmanager.secrets.setIamPolicy",
  "secretmanager.versions.add",
  "secretmanager.versions.list",
  "parametermanager.parameters.create",
  "parametermanager.parameters.delete",
  "parametermanager.parameters.get",
  "parametermanager.parameters.list",
  "parametermanager.parameters.update",
  "parametermanager.parameterVersions.create",
  "parametermanager.parameterVersions.delete",
  "parametermanager.parameterVersions.get",
  "parametermanager.parameterVersions.list",
  "parametermanager.parameterVersions.update",
];

const CONFIG_YAML = `
version: 1
gateway:
  name: strad
  env: ${ENV}
  publicUrl: https://strad.example
auth:
  staticTokens: { enabled: true }
  consoleDevBypass: { enabled: true, roles: [admin] }
roles:
  admin: { servers: ["*"] }
bundles:
  - name: bundle
servers:
  - slug: secrets
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle
    path: /secrets
    entitlements: [admin]
    env:
      SECRETS_PROJECT_ID: "demo-project"
      SECRETS_NAMESPACES: "/strad/${ENV}/mcp/"
    consoleEnv:
      SECRETS_PROJECT_ID: "demo-project"
      SECRETS_NAMESPACES: "/strad/${ENV}/mcp/"
      SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON: "\${ADMIN_KEY}"
  - slug: ${PLAIN_SLUG}
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle
    path: /${PLAIN_SLUG}
    entitlements: [admin]
  - slug: ${SLUG}
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle
    path: /${SLUG}
    entitlements: [admin]
    oauth:
      provider: google
      account: tadas412@gmail.com
      scopes: [https://www.googleapis.com/auth/spreadsheets.readonly]
  - slug: ${OTHER_SLUG}
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle
    path: /${OTHER_SLUG}
    entitlements: [admin]
    oauth:
      provider: google
      account: tadas412@gmail.com
      scopes: [https://www.googleapis.com/auth/spreadsheets]
`;

const CONFIG = parseConfig(CONFIG_YAML);

const SECRETS: Record<string, string> = {
  ADMIN_KEY: JSON.stringify({
    client_email: "strad-secrets-admin@demo.iam.gserviceaccount.com",
    private_key:
      "-----BEGIN PRIVATE KEY-----\\nfake\\n-----END PRIVATE KEY-----",
  }),
};

const BASE_ENV: NodeJS.ProcessEnv = {
  ALLOW_DEV_AUTH: "true",
  ADMIN_BOOTSTRAP_TOKEN: BOOTSTRAP,
  CONSOLE_SESSION_SECRET: SESSION_KEY,
  STRAD_BUNDLE_URL_BUNDLE: "http://127.0.0.1:1",
  STRAD_TOKENS: "[]",
};

let fake: FakeGcp;
/** The prod console credential: writes everything, reads no secret value. */
let consoleStore: ParameterStore;
/** Which store the NEXT `parametersStore` call hands the app. Swapped per case. */
let pick: () => ParameterStore;

/** The secret id behind a path, as `gcloud secrets` would take it. */
const secretOf = (path: string) => parameterId(path);

/** The members of one secret's unconditional `secretAccessor` binding. */
function accessorsOf(path: string): string[] {
  return (fake.secretPolicies.get(secretOf(path)) ?? [])
    .filter(
      (b) =>
        b.role === "roles/secretmanager.secretAccessor" &&
        b.condition === undefined,
    )
    .flatMap((b) => b.members);
}

/** Is the CONSOLE'S OWN service account bound on this parameter's secret? */
const consoleCanReach = (path: string) =>
  accessorsOf(path).includes(fake.callerMember);

/** Did `reveal()` come back with the value, or did the store refuse? */
async function readable(path: string): Promise<boolean> {
  try {
    await consoleStore.reveal(path);
    return true;
  } catch {
    return false;
  }
}

interface App {
  baseUrl: string;
  server: Server;
}

async function boot(): Promise<App> {
  const registry = await Registry.build({
    config: CONFIG,
    secrets: sharedSecretProviders(new EnvSecretProvider(SECRETS)),
    mode: "core",
    env: BASE_ENV,
  });
  const app = createApp({
    config: CONFIG,
    registry,
    tokenStore: tokenStoreFromConfig(CONFIG, BASE_ENV),
    mode: "core",
    env: BASE_ENV,
    secrets: SECRETS,
    parametersStore: () => pick(),
    // The provider is never reached: every case here refuses before the
    // exchange, or never gets as far as pressing Connect.
    connectorFetch: (async () => {
      throw new Error("unexpected connector fetch");
    }) as typeof fetch,
  });
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const addr = server.address();
  if (typeof addr === "string" || !addr) throw new Error("no port");
  return { baseUrl: `http://127.0.0.1:${addr.port}`, server };
}

let main: App;

beforeAll(async () => {
  fake = createFakeGcp();
  main = await boot();
});

afterAll(() => {
  main?.server.close();
});

let exporter: InMemoryLogRecordExporter;
let streams: string[] = [];

beforeEach(async () => {
  exporter = new InMemoryLogRecordExporter();
  logs.disable();
  logs.setGlobalLoggerProvider(
    new LoggerProvider({
      processors: [new SimpleLogRecordProcessor({ exporter })],
    }),
  );
  enableEventExport("strad-test", "0.0.0");
  resetEventThrottle();
  streams = [];
  for (const method of ["log", "error", "warn"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      streams.push(args.map(String).join(" "));
    });
  }

  fake.parameters.clear();
  fake.secrets.clear();
  fake.secretPolicies.clear();
  fake.denied.clear();
  consoleStore = fake.storeAs(WRITE_ONLY_CONSOLE);
  pick = () => consoleStore;
});

afterEach(() => {
  disableEventExport();
  logs.disable();
  vi.restoreAllMocks();
});

/**
 * Seed one slug's OAuth application the way production did: two SECRET
 * parameters, created WITHOUT the console grant — which is every connector that
 * exists today, because they were all seeded before it.
 */
async function seedUngranted(slug = SLUG): Promise<void> {
  for (const [variable, value] of [
    [CLIENT_ID_VAR, CLIENT_ID],
    [CLIENT_SECRET_VAR, CLIENT_SECRET],
  ] as const) {
    await consoleStore.create({
      path: `${ns(slug)}${variable}`,
      secret: true,
      value,
    });
  }
}

const auth = { authorization: `Bearer ${BOOTSTRAP}` };

function post(path: string): Promise<Response> {
  return fetch(`${main.baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...auth },
    body: "",
    redirect: "manual",
  });
}

const connect = (slug = SLUG) => post(`/ui/${slug}/connect`);
const grantClient = (slug = SLUG) => post(`/ui/${slug}/grant-client`);

/** The HTML flash, unescaped, so a sentence can be matched as a human reads it. */
function flashOf(html: string): string {
  const m = /<div class="flash flash-(?:ok|error)">([^<]*)<\/div>/.exec(html);
  return (m?.[1] ?? "")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** Is the repair panel — the button and its form — on this page? */
const offersRepair = (html: string) =>
  html.includes(`action="/ui/${SLUG}/grant-client"`) &&
  html.includes("Grant read on this client");

/** The exported records for one event, as an ingestor would receive them. */
function exported(evt: string) {
  return exporter.getFinishedLogRecords().filter((r) => r.body === evt);
}

/** Nothing anywhere — page, export, streams — may carry a seeded value. */
function assertNoCanary(html: string): void {
  const everything = [
    html,
    JSON.stringify(exporter.getFinishedLogRecords().map((r) => r.attributes)),
    ...streams,
  ].join("\n");
  for (const canary of CANARIES) expect(everything).not.toContain(canary);
}

// ---------------------------------------------------------------------------
// 1. Create grants — on the right secret, and on no other
// ---------------------------------------------------------------------------

describe("creating a declared connector's OAuth client grants the console read on that secret only", () => {
  it("binds the console on both client halves, and on nothing else in the namespace", async () => {
    // The two client halves, flagged the way the console's create form flags
    // them: from config, via the one predicate.
    for (const [variable, value] of [
      [CLIENT_ID_VAR, CLIENT_ID],
      [CLIENT_SECRET_VAR, CLIENT_SECRET],
    ] as const) {
      const path = `${NS}${variable}`;
      expect(isConnectorClientPath(CONFIG, path)).toBe(true);
      await consoleStore.create({
        path,
        secret: true,
        value,
        consoleReadable: true,
      });
    }
    // A neighbour in the SAME namespace, under the same slug, that the config's
    // `oauth:` block does not name.
    const neighbour = `${NS}SOME_OTHER_TOKEN`;
    expect(isConnectorClientPath(CONFIG, neighbour)).toBe(false);
    await consoleStore.create({
      path: neighbour,
      secret: true,
      value: "neighbour-value",
      consoleReadable: isConnectorClientPath(CONFIG, neighbour),
    });

    expect(consoleCanReach(`${NS}${CLIENT_ID_VAR}`)).toBe(true);
    expect(consoleCanReach(`${NS}${CLIENT_SECRET_VAR}`)).toBe(true);
    expect(consoleCanReach(neighbour)).toBe(false);

    // The grant is a READ that works, not a line in a policy.
    expect(await readable(`${NS}${CLIENT_ID_VAR}`)).toBe(true);
    expect(await readable(`${NS}${CLIENT_SECRET_VAR}`)).toBe(true);
    expect(await readable(neighbour)).toBe(false);

    // And the parameter's OWN principal is still there: the grant that makes
    // `:render` work is the one this rides alongside, never a replacement.
    expect(accessorsOf(`${NS}${CLIENT_ID_VAR}`)).toContain(
      fake.principalOf(secretOf(`${NS}${CLIENT_ID_VAR}`)),
    );
    // Asserted through the RESOLVER's credential, not the console's: `:render`
    // derefs as the parameter, and the console holds no `render` permission at
    // all (that is §1's other half). What is being proved is that the second
    // member did not displace the first.
    expect(await fake.store.resolve(NS)).toMatchObject({
      [CLIENT_ID_VAR]: CLIENT_ID,
      [CLIENT_SECRET_VAR]: CLIENT_SECRET,
    });
  });

  it("leaves a non-connector secret create exactly as it was", async () => {
    const path = `${ns(PLAIN_SLUG)}GCS_BUCKET_TOKEN`;
    await consoleStore.create({ path, secret: true, value: "a-bucket-token" });
    expect(accessorsOf(path)).toEqual([fake.principalOf(secretOf(path))]);
    expect(await readable(path)).toBe(false);
  });

  it("grants nothing under a slug with no oauth: block, even for the same variable name", async () => {
    const path = `${ns(PLAIN_SLUG)}${CLIENT_ID_VAR}`;
    expect(isConnectorClientPath(CONFIG, path)).toBe(false);
    await consoleStore.create({
      path,
      secret: true,
      value: CLIENT_ID,
      consoleReadable: isConnectorClientPath(CONFIG, path),
    });
    expect(consoleCanReach(path)).toBe(false);
    expect(await readable(path)).toBe(false);
  });

  it("never grants the refresh token, which is the credential the kind exists to protect", async () => {
    for (const kind of ["static", "oauth"]) {
      const path = `${ns(SLUG, kind)}${REFRESH_VAR}`;
      expect(isConnectorClientPath(CONFIG, path)).toBe(false);
      await consoleStore.create({
        path,
        secret: true,
        value: REFRESH_TOKEN,
        consoleReadable: isConnectorClientPath(CONFIG, path),
      });
      expect(consoleCanReach(path)).toBe(false);
      expect(await readable(path)).toBe(false);
    }
  });

  it("does not reach the oauth/ kind, even for the client variables", async () => {
    // A human MAY seed the client under `oauth/`. strad will not grant itself
    // read there: that kind is where the credential nobody has seen is written.
    const path = `${ns(SLUG, "oauth")}${CLIENT_ID_VAR}`;
    expect(isConnectorClientPath(CONFIG, path)).toBe(false);
  });

  it("does not reach a DISABLED server's connector", () => {
    const disabled = parseConfig(
      CONFIG_YAML.replace(
        `  - slug: ${SLUG}\n`,
        `  - slug: ${SLUG}\n    enabled: false\n`,
      ),
    );
    expect(isConnectorClientPath(disabled, `${NS}${CLIENT_ID_VAR}`)).toBe(
      false,
    );
    // …and the other connector on the same gateway is untouched by that.
    expect(
      isConnectorClientPath(disabled, `${ns(OTHER_SLUG)}${CLIENT_ID_VAR}`),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Rotate keeps it; delete-then-recreate rebuilds it
// ---------------------------------------------------------------------------

describe("the binding survives a rotate and is rebuilt by a re-seed", () => {
  it("a rotate adds a version and keeps the grant", async () => {
    const path = `${NS}${CLIENT_ID_VAR}`;
    await consoleStore.create({
      path,
      secret: true,
      value: CLIENT_ID,
      consoleReadable: true,
    });
    await consoleStore.rotate(path, `${CLIENT_ID}-v2`);
    expect(consoleCanReach(path)).toBe(true);
    expect(await consoleStore.reveal(path)).toBe(`${CLIENT_ID}-v2`);
  });

  it("a delete destroys the binding with the secret, and the re-create restores it", async () => {
    const path = `${NS}${CLIENT_ID_VAR}`;
    await consoleStore.create({
      path,
      secret: true,
      value: CLIENT_ID,
      consoleReadable: true,
    });
    expect(consoleCanReach(path)).toBe(true);

    await consoleStore.destroy(path);
    // An IAM policy does not outlive its resource.
    expect(fake.secretPolicies.has(secretOf(path))).toBe(false);

    await consoleStore.create({
      path,
      secret: true,
      value: CLIENT_ID,
      consoleReadable: true,
    });
    expect(consoleCanReach(path)).toBe(true);
    expect(await readable(path)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. The repair path, through the real console
// ---------------------------------------------------------------------------

describe("a connector whose client is present but unreadable is repaired from its own page", () => {
  it("the refusal offers the repair, the repair works, and Connect then begins", async () => {
    await seedUngranted();

    // The production state: listed as ready, refused on the read.
    const refusal = await connect();
    expect(refusal.status).toBe(409);
    const refusalHtml = await refusal.text();
    expect(flashOf(refusalHtml)).toContain(
      "strad cannot read this server's OAuth client",
    );
    expect(offersRepair(refusalHtml)).toBe(true);
    assertNoCanary(refusalHtml);

    // One press.
    const repaired = await grantClient();
    expect(repaired.status).toBe(200);
    const repairedHtml = await repaired.text();
    expect(flashOf(repairedHtml)).toContain(
      "strad can now read this server's OAuth client",
    );
    assertNoCanary(repairedHtml);

    // The binding landed on both halves, and on nothing else.
    expect(consoleCanReach(`${NS}${CLIENT_ID_VAR}`)).toBe(true);
    expect(consoleCanReach(`${NS}${CLIENT_SECRET_VAR}`)).toBe(true);
    expect(await readable(`${NS}${CLIENT_ID_VAR}`)).toBe(true);
    expect(await readable(`${NS}${CLIENT_SECRET_VAR}`)).toBe(true);

    // Two records, one per half, naming the config's variable and nothing else.
    const records = exported("strad.connector_client_granted");
    expect(records).toHaveLength(2);
    expect(records.map((r) => r.attributes)).toEqual([
      {
        "strad.evt": "strad.connector_client_granted",
        slug: SLUG,
        variable: CLIENT_ID_VAR,
        result: "granted",
      },
      {
        "strad.evt": "strad.connector_client_granted",
        slug: SLUG,
        variable: CLIENT_SECRET_VAR,
        result: "granted",
      },
    ]);

    // And now the button the human pressed in the first place carries through:
    // a 302 to Google, which is as far as this suite lets it go.
    const began = await connect();
    expect(began.status).toBe(302);
    expect(began.headers.get("location")).toContain(
      "accounts.google.com/o/oauth2/v2/auth",
    );
  });

  it("a second press is idempotent and says the policy already said so", async () => {
    await seedUngranted();
    await grantClient();
    resetEventThrottle();
    exporter.reset();

    const again = await grantClient();
    expect(again.status).toBe(200);
    expect(
      exported("strad.connector_client_granted").map(
        (r) => r.attributes?.result,
      ),
    ).toEqual(["already", "already"]);
    // Exactly one member, not two copies of it.
    expect(
      accessorsOf(`${NS}${CLIENT_ID_VAR}`).filter(
        (m) => m === fake.callerMember,
      ),
    ).toHaveLength(1);
  });

  it("a deny policy: the binding lands, the read still fails, and the page says so", async () => {
    await seedUngranted();
    // `strad-console-no-read` from secrets-iam.md §1. Deny is evaluated before
    // allow, so the setIamPolicy below succeeds and buys nothing.
    fake.denied.add(ACCESS_PERMISSION);

    const res = await grantClient();
    expect(res.status).toBe(409);
    const html = await res.text();
    const flash = flashOf(html);

    // NO SUCCESS CLAIM, and the binding really was written.
    expect(consoleCanReach(`${NS}${CLIENT_ID_VAR}`)).toBe(true);
    expect(flash).not.toContain("strad can now read");
    expect(flash).toContain("the value still cannot be read");
    expect(flash).toContain("Connect would still refuse");
    // The existing refusal sentence, reused: the permission and the resource.
    expect(flash).toContain(
      `Secret Manager refused the console's credential ${ACCESS_PERMISSION} on ` +
        `projects/strad-secrets-test/secrets/${secretOf(`${NS}${CLIENT_ID_VAR}`)}`,
    );
    // And the likely cause, named.
    expect(flash).toContain("deny policy");
    expect(flash).toContain("strad-console-no-read");
    // The page keeps offering the repair — pressing it again is harmless, and
    // hiding it would leave a human with a sentence and no next step.
    expect(offersRepair(html)).toBe(true);
    assertNoCanary(html);

    const records = exported("strad.connector_client_grant_failed");
    expect(records).toHaveLength(1);
    expect(records[0]!.severityNumber).toBe(SeverityNumber.ERROR);
    expect(records[0]!.attributes).toEqual({
      "strad.evt": "strad.connector_client_grant_failed",
      slug: SLUG,
      reason: "denied",
      variable: CLIENT_ID_VAR,
      failure: "denied",
      status: 403,
    });
    expect(exported("strad.connector_client_granted")).toHaveLength(0);

    // Connect is still refused, which is the honest end state.
    expect((await connect()).status).toBe(409);
  });

  it("refuses a client held under oauth/, where the console is not to be given read", async () => {
    // Seeded into the kind strad mints into. Presence finds it there, and the
    // fence refuses it there.
    for (const [variable, value] of [
      [CLIENT_ID_VAR, CLIENT_ID],
      [CLIENT_SECRET_VAR, CLIENT_SECRET],
    ] as const) {
      await consoleStore.create({
        path: `${ns(SLUG, "oauth")}${variable}`,
        secret: true,
        value,
      });
    }

    const res = await grantClient();
    expect(res.status).toBe(409);
    const html = await res.text();
    expect(flashOf(html)).toContain("is not this slug's own static/ namespace");
    expect(consoleCanReach(`${ns(SLUG, "oauth")}${CLIENT_ID_VAR}`)).toBe(false);
    expect(
      exported("strad.connector_client_grant_failed")[0]!.attributes,
    ).toMatchObject({ reason: "not_eligible", variable: CLIENT_ID_VAR });
    assertNoCanary(html);
  });

  it("refuses when there is no OAuth client seeded at all", async () => {
    const res = await grantClient();
    expect(res.status).toBe(409);
    expect(flashOf(await res.text())).toContain(
      "There is no OAuth client on this server to grant read access to",
    );
    expect(
      exported("strad.connector_client_grant_failed")[0]!.attributes,
    ).toMatchObject({ reason: "not_ready" });
  });

  it("says so, rather than offering a button that does nothing, when the store cannot express it", async () => {
    await seedUngranted();
    pick = () => {
      const { grantConsoleRead: _dropped, ...rest } = consoleStore;
      return rest as ParameterStore;
    };

    const res = await grantClient();
    expect(res.status).toBe(409);
    expect(flashOf(await res.text())).toContain(
      "does not express per-secret access grants",
    );
    expect(
      exported("strad.connector_client_grant_failed")[0]!.attributes,
    ).toMatchObject({ reason: "unsupported" });
  });

  it("a refused setIamPolicy is reported as the write failing, not as a deny policy", async () => {
    await seedUngranted();
    const refused = new ParameterStoreError(
      "POST projects/strad-secrets-test/secrets/s:setIamPolicy failed: 403 Forbidden",
      403,
    );
    pick = () =>
      ({
        ...consoleStore,
        grantConsoleRead: () => Promise.reject(refused),
      }) as ParameterStore;

    const res = await grantClient();
    expect(res.status).toBe(409);
    const flash = flashOf(await res.text());
    expect(flash).toContain("could not write the binding");
    expect(flash).not.toContain("deny policy");
    expect(
      exported("strad.connector_client_grant_failed")[0]!.attributes,
    ).toMatchObject({ reason: "write_refused", status: 403 });
  });

  it("404s for a slug with no connector, and writes no event about it", async () => {
    const res = await grantClient(PLAIN_SLUG);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("No connector on this server");
    expect(exported("strad.connector_client_grant_failed")).toHaveLength(0);
  });

  it("does not offer the repair on a page nobody has failed to connect", async () => {
    await seedUngranted();
    const page = await fetch(`${main.baseUrl}/ui/${SLUG}`, { headers: auth });
    const html = await page.text();
    expect(page.status).toBe(200);
    expect(offersRepair(html)).toBe(false);

    // …but the callback's own `client_unreadable` return does.
    const returned = await fetch(
      `${main.baseUrl}/ui/${SLUG}?error=client_unreadable`,
      { headers: auth },
    );
    expect(offersRepair(await returned.text())).toBe(true);
  });
});
