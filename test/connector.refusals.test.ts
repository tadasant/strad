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
import { CONNECTOR_TX_COOKIE } from "../src/connectors/state.ts";
import { Registry } from "../src/gateway/registry.ts";
import { createApp } from "../src/http/app.ts";
import { createFakeGcp, type FakeGcp } from "../src/secrets/parameters/fake.ts";
import {
  ParameterStoreError,
  UnreadablePayloadError,
  type ParameterStore,
} from "../src/secrets/parameters/index.ts";
import { ServiceAccountAuthError } from "../src/secrets/parameters/service-account.ts";
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
 * Every way the connect POST can refuse, driven through the real Express app,
 * and the three things each refusal owes the people on either side of it.
 *
 *   1. A STATUS THE EDGE PASSES THROUGH. Never a 5xx: the App Platform ingress
 *      treats an upstream 5xx as its own failure and replaces the body with its
 *      generic edge page — see src/http/readiness.ts — so the human would see
 *      "Error code: 503" and nothing else.
 *   2. THE SPECIFIC REASON, ON THE PAGE. Enough to act on: which permission,
 *      on which resource.
 *   3. A STRUCTURED EVENT, EXPORTED, AT ERROR, ON STDERR. The export is
 *      asserted through a real OTel logger, so what is checked is what an
 *      ingestor would receive — and none of it may carry a value.
 *
 * The production case is `client_unreadable`, reproduced exactly: the client id
 * is a SECRET parameter, and the console's credential holds the write-only
 * roles docs/operate/secrets-iam.md §1 prescribes — so Parameter Manager lists
 * the connector as ready and Secret Manager refuses the read.
 */

const BOOTSTRAP = "bootstrap-secret-for-the-refusal-suite";
const SESSION_KEY = "a-console-session-secret-of-adequate-length";
const SLUG = "google-sheets-tadas412-ro";
const NS = `/strad/test/mcp/${SLUG}/static/`;
const CLIENT_ID_VAR = "GOOGLE_SHEETS_OAUTH_CLIENT_ID";
const CLIENT_SECRET_VAR = "GOOGLE_SHEETS_OAUTH_CLIENT_SECRET";
const CLIENT_ID = "6-CLIENT-ID-CANARY.apps.googleusercontent.com";
const CLIENT_SECRET = "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LEAK";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

const CANARIES = [CLIENT_ID, CLIENT_SECRET];

/**
 * The prod console: both custom roles from secrets-iam.md §1, spelled out.
 * Everything it needs to list, write and delete — and no
 * `secretmanager.versions.access`.
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

function configYaml(publicUrl: boolean): string {
  return `
version: 1
gateway:
  name: strad
  env: test
${publicUrl ? "  publicUrl: https://strad.example\n" : ""}auth:
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
      SECRETS_NAMESPACES: "/strad/test/mcp/"
    consoleEnv:
      SECRETS_PROJECT_ID: "demo-project"
      SECRETS_NAMESPACES: "/strad/test/mcp/"
      SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON: "\${ADMIN_KEY}"
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
`;
}

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
/** Which store the NEXT `parametersStore` call hands the app. Swapped per case. */
let pick: () => ParameterStore;
let tokenRequests = 0;

const connectorFetch: typeof fetch = (async (input: unknown) => {
  if (String(input) !== TOKEN_ENDPOINT) {
    throw new Error(`unexpected connector fetch: ${String(input)}`);
  }
  tokenRequests += 1;
  return new Response(JSON.stringify({ error: "invalid_grant" }), {
    status: 400,
    headers: { "content-type": "application/json" },
  });
}) as typeof fetch;

interface App {
  baseUrl: string;
  server: Server;
}

async function boot(opts: {
  publicUrl?: boolean;
  env?: NodeJS.ProcessEnv;
}): Promise<App> {
  const config = parseConfig(configYaml(opts.publicUrl ?? true));
  const env = opts.env ?? BASE_ENV;
  const registry = await Registry.build({
    config,
    secrets: sharedSecretProviders(new EnvSecretProvider(SECRETS)),
    mode: "core",
    env,
  });
  const app = createApp({
    config,
    registry,
    tokenStore: tokenStoreFromConfig(config, env),
    mode: "core",
    env,
    secrets: SECRETS,
    parametersStore: () => pick(),
    connectorFetch,
  });
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const addr = server.address();
  if (typeof addr === "string" || !addr) throw new Error("no port");
  return { baseUrl: `http://127.0.0.1:${addr.port}`, server };
}

let main: App;
let noPublicUrl: App;
let noSessionKey: App;

beforeAll(async () => {
  fake = createFakeGcp();
  main = await boot({});
  noPublicUrl = await boot({ publicUrl: false });
  const { CONSOLE_SESSION_SECRET: _dropped, ...withoutKey } = BASE_ENV;
  noSessionKey = await boot({ env: withoutKey });
});

afterAll(() => {
  for (const app of [main, noPublicUrl, noSessionKey]) app?.server.close();
});

// --- what leaves the process -------------------------------------------------

let exporter: InMemoryLogRecordExporter;
/** Every line written to stdout, stderr or the warn stream, for the canary sweep. */
let streams: string[] = [];
/** The stderr lines alone, which is where a `_failed` event must land. */
let stderr: string[] = [];

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
  stderr = [];
  for (const method of ["log", "error", "warn"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      const line = args.map(String).join(" ");
      streams.push(line);
      if (method === "error") stderr.push(line);
    });
  }

  tokenRequests = 0;
  pick = () => fake.store;
  fake.parameters.clear();
  fake.secrets.clear();
  // Both halves of the OAuth application are SECRET, which is how production
  // seeded them — and why the connect POST's first read goes to Secret Manager.
  await fake.store.create({
    path: `${NS}${CLIENT_ID_VAR}`,
    secret: true,
    value: CLIENT_ID,
  });
  await fake.store.create({
    path: `${NS}${CLIENT_SECRET_VAR}`,
    secret: true,
    value: CLIENT_SECRET,
  });
});

afterEach(() => {
  disableEventExport();
  logs.disable();
  vi.restoreAllMocks();
});

const auth = { authorization: `Bearer ${BOOTSTRAP}` };

function connect(app: App = main): Promise<Response> {
  return fetch(`${app.baseUrl}/ui/${SLUG}/connect`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...auth },
    body: "",
    redirect: "manual",
  });
}

/** The exported records for one event, as an ingestor would receive them. */
function exported(evt: string) {
  return exporter.getFinishedLogRecords().filter((r) => r.body === evt);
}

/** The one `strad.connector_connect_failed` line on stderr, parsed. */
function stderrEvent(): Record<string, unknown> {
  const lines = stderr.filter((s) =>
    s.includes('"evt":"strad.connector_connect_failed"'),
  );
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0]!) as Record<string, unknown>;
}

/** A store whose `reveal()` rejects with `err`, and is otherwise the fake's. */
function revealRejects(err: unknown): () => ParameterStore {
  return () =>
    ({ ...fake.store, reveal: () => Promise.reject(err) }) as ParameterStore;
}

/**
 * The HTML flash, unescaped, so a sentence can be matched as a human reads it.
 * `esc()` is what put the entities there; the assertion is on the words.
 */
function flashOf(html: string): string {
  const m = /<div class="flash flash-error">([^<]*)<\/div>/.exec(html);
  return (m?.[1] ?? "")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/**
 * The three obligations, asserted together for one refusal.
 *
 * Returns the flash so a case can hold it to the specific sentence it owes.
 */
async function refusal(
  res: Response,
  expectedAttributes: Record<string, unknown>,
): Promise<string> {
  const html = await res.text();

  // 1. A status the edge passes through.
  expect(res.status).toBe(409);

  // 2. A reason, on the page.
  const flash = flashOf(html);
  expect(flash).not.toBe("");

  // 3. Exactly one record, at ERROR, carrying exactly the allowlisted fields —
  // and not `error`, which holds the store's own summary and stays on stderr,
  // where the whole payload goes.
  const records = exported("strad.connector_connect_failed");
  expect(records).toHaveLength(1);
  expect(records[0]!.severityNumber).toBe(SeverityNumber.ERROR);
  expect(records[0]!.attributes).toEqual({
    "strad.evt": "strad.connector_connect_failed",
    slug: SLUG,
    stage: "begin",
    ...expectedAttributes,
  });
  expect(stderrEvent().reason).toBe(expectedAttributes.reason);

  // Nothing began: no transaction cookie, no redirect to the provider.
  expect(res.headers.get("location")).toBeNull();
  expect(res.headers.getSetCookie().join(";")).not.toContain(
    CONNECTOR_TX_COOKIE,
  );

  // No value anywhere: not the page, not the export, not the streams.
  const everything = [
    html,
    JSON.stringify(exporter.getFinishedLogRecords().map((r) => r.attributes)),
    ...streams,
  ].join("\n");
  for (const canary of CANARIES) expect(everything).not.toContain(canary);

  return flash;
}

// ---------------------------------------------------------------------------

describe("the connect POST refuses with a 409 the edge passes through, says why, and says so in the logs", () => {
  it("client_unreadable: a console credential with no secretmanager.versions.access — the production case", async () => {
    pick = () => fake.storeAs(WRITE_ONLY_CONSOLE);

    const flash = await refusal(await connect(), {
      reason: "client_unreadable",
      variable: CLIENT_ID_VAR,
      failure: "denied",
      status: 403,
    });

    // The permission, the exact resource, and the grant that fixes it — the
    // resource named the way `gcloud secrets add-iam-policy-binding` takes it.
    const secret = `projects/strad-secrets-test/secrets/${parameterId(`${NS}${CLIENT_ID_VAR}`)}`;
    expect(flash).toContain("strad cannot read this server's OAuth client");
    expect(flash).toContain(
      `Secret Manager refused the console's credential secretmanager.versions.access on ${secret}`,
    );
    expect(flash).toContain(`${NS}${CLIENT_ID_VAR}`);
    expect(flash).toContain("roles/secretmanager.secretAccessor");
    expect(flash).toContain("never on the project");
    // A 403 with the grant in place is the deny policy, and the page says so.
    expect(flash).toContain("deny policy");
    expect(flash).toContain("Nothing was written.");

    // The store's own summary is kept, on stderr beside the event.
    expect(stderrEvent().error).toBe(
      `ParameterStoreError: GET ${secret}/versions/latest failed: 403 Forbidden`,
    );
  });

  it("client_unreadable: a Parameter Manager 403 names the path and the store's words, not a Secret Manager grant", async () => {
    pick = revealRejects(
      new ParameterStoreError(
        "GET projects/p/locations/global/parameters/x/versions/v1 failed: 403 Forbidden",
        403,
      ),
    );
    const flash = await refusal(await connect(), {
      reason: "client_unreadable",
      variable: CLIENT_ID_VAR,
      failure: "denied",
      status: 403,
    });
    expect(flash).toContain(
      `the store refused the console's credential reading ${NS}${CLIENT_ID_VAR}`,
    );
    expect(flash).not.toContain("secretAccessor");
  });

  it("client_unreadable: a 404 says the value went away since it was listed", async () => {
    pick = revealRejects(
      new ParameterStoreError(
        `secret "${NS}${CLIENT_ID_VAR}" has no version to reveal`,
        404,
      ),
    );
    const flash = await refusal(await connect(), {
      reason: "client_unreadable",
      variable: CLIENT_ID_VAR,
      failure: "not_found",
      status: 404,
    });
    expect(flash).toContain("has no version to reveal");
    expect(flash).toContain("reload this page");
  });

  it("client_unreadable: a store 5xx carries its status, so a down store is not read as a missing grant", async () => {
    pick = revealRejects(
      new ParameterStoreError(
        "GET projects/p/secrets/s/versions/latest failed: 503 Service Unavailable",
        503,
      ),
    );
    const flash = await refusal(await connect(), {
      reason: "client_unreadable",
      variable: CLIENT_ID_VAR,
      failure: "store",
      status: 503,
    });
    expect(flash).toContain("503 Service Unavailable");
    expect(flash).not.toContain("secretAccessor");
  });

  it("client_unreadable: a payload that is not an envelope says to rotate it", async () => {
    pick = revealRejects(new UnreadablePayloadError(`projects/p/secrets/s`));
    const flash = await refusal(await connect(), {
      reason: "client_unreadable",
      variable: CLIENT_ID_VAR,
      failure: "unreadable",
      status: 502,
    });
    expect(flash).toContain("is not a strad envelope");
  });

  it("client_unreadable: a key that cannot mint a token is the credential, not a permission on the secret", async () => {
    pick = revealRejects(
      new ServiceAccountAuthError(
        "token exchange failed: 400 Bad Request",
        400,
      ),
    );
    const flash = await refusal(await connect(), {
      reason: "client_unreadable",
      variable: CLIENT_ID_VAR,
      failure: "credential",
      status: 400,
    });
    expect(flash).toContain("could not get an access token");
    expect(flash).toContain("not a permission on the secret");
  });

  it("client_unreadable: a timeout reads as the store being slow, not as a refusal", async () => {
    pick = () => {
      const store = fake.store;
      return {
        ...store,
        reveal: () =>
          Promise.reject(
            Object.assign(new Error("operation timed out"), {
              name: "TimeoutError",
            }),
          ),
      } as ParameterStore;
    };

    const flash = await refusal(await connect(), {
      reason: "client_unreadable",
      variable: CLIENT_ID_VAR,
      failure: "timeout",
    });
    expect(flash).toContain("did not answer in time");
  });

  it("client_unreadable: an unexpected error is named by class, and its message withheld", async () => {
    pick = () => {
      const store = fake.store;
      return {
        ...store,
        // A parse error quoting the payload it choked on: the shape that makes
        // anything but the class unsafe to print.
        reveal: () =>
          Promise.reject(new SyntaxError(`Unexpected token in "${CLIENT_ID}"`)),
      } as ParameterStore;
    };

    const flash = await refusal(await connect(), {
      reason: "client_unreadable",
      variable: CLIENT_ID_VAR,
      failure: "unexpected",
    });
    expect(flash).toContain("unexpected SyntaxError");
    expect(flash).toContain("withheld");
  });

  it("no_redirect_uri: a deployment with no gateway.publicUrl", async () => {
    const flash = await refusal(await connect(noPublicUrl), {
      reason: "no_redirect_uri",
    });
    expect(flash).toContain("declares no gateway.publicUrl");
  });

  it("no_session_key: a deployment with no CONSOLE_SESSION_SECRET", async () => {
    const flash = await refusal(await connect(noSessionKey), {
      reason: "no_session_key",
    });
    expect(flash).toContain("Set CONSOLE_SESSION_SECRET");
  });

  it("incomplete: the OAuth application is not seeded", async () => {
    await fake.store.destroy(`${NS}${CLIENT_SECRET_VAR}`);
    const res = await connect();
    const html = await res.clone().text();
    const flash = await refusal(res, { reason: "incomplete" });
    expect(flash).toContain("not ready to authorize");
    // The panel under the flash names what is missing, and where.
    expect(html).toContain(`${CLIENT_SECRET_VAR} is missing from ${NS}`);
  });

  it("store_error: the store will not list the slug's namespace", async () => {
    pick = () => fake.storeAs([]);
    const res = await connect();
    const html = await res.clone().text();
    const flash = await refusal(res, { reason: "store_error" });
    expect(flash).toContain("not ready to authorize");
    expect(html).toContain("The parameter store did not answer");
  });

  it("no_store: there is no store to read the connector's state from", async () => {
    pick = () => null as unknown as ParameterStore;
    const flash = await refusal(await connect(), { reason: "no_store" });
    expect(flash).toContain("not ready to authorize");
  });

  it("no_store: the store resolved for the state is gone by the time it is used", async () => {
    // The only way to reach this branch: the readiness read found a store, and
    // the second resolution — the one the connect POST uses — did not.
    let calls = 0;
    pick = () =>
      (calls++ === 0 ? fake.store : null) as unknown as ParameterStore;
    const flash = await refusal(await connect(), { reason: "no_store" });
    expect(flash).toContain("has no admin service account");
  });
});

describe("the callback", () => {
  /** Begin a flow on a store that can read the client id, and return the cookie. */
  async function begin(): Promise<{ cookie: string; state: string }> {
    const res = await connect();
    expect(res.status).toBe(302);
    const cookie = res.headers
      .getSetCookie()
      .find((c) => c.startsWith(`${CONNECTOR_TX_COOKIE}=`))!
      .split(";")[0]!;
    const state =
      new URL(res.headers.get("location")!).searchParams.get("state") ?? "";
    return { cookie, state };
  }

  const callback = (cookie: string, state: string) =>
    fetch(
      `${main.baseUrl}/ui/oauth/callback?state=${encodeURIComponent(state)}&code=4%2F0AX-CODE`,
      { headers: { ...auth, cookie }, redirect: "manual" },
    );

  it("names an unreadable client SECRET as that, rather than as a refused write — and never exchanges", async () => {
    // The client id readable, the client secret not: the connect POST, which
    // reads only the id, succeeds, and the human is sent to consent.
    await fake.store.destroy(`${NS}${CLIENT_ID_VAR}`);
    await fake.store.create({
      path: `${NS}${CLIENT_ID_VAR}`,
      secret: false,
      value: CLIENT_ID,
    });
    pick = () => fake.storeAs(WRITE_ONLY_CONSOLE);
    const { cookie, state } = await begin();

    const res = await callback(cookie, state);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      `/ui/${SLUG}?error=client_unreadable`,
    );
    // The code was never spent against a client strad could not read.
    expect(tokenRequests).toBe(0);

    // The deployment failing, not the consent: ERROR, on stderr, stage
    // `callback`, naming the variable that could not be read.
    const records = exported("strad.connector_connect_failed");
    expect(records.map((r) => r.attributes)).toEqual([
      {
        "strad.evt": "strad.connector_connect_failed",
        slug: SLUG,
        stage: "callback",
        reason: "client_unreadable",
        variable: CLIENT_SECRET_VAR,
        failure: "denied",
        status: 403,
      },
    ]);
    expect(records[0]!.severityNumber).toBe(SeverityNumber.ERROR);
    expect(stderrEvent().variable).toBe(CLIENT_SECRET_VAR);
    expect(exported("strad.connector_refused")).toEqual([]);

    const page = await fetch(`${main.baseUrl}${res.headers.get("location")}`, {
      headers: auth,
    });
    const flash = flashOf(await page.text());
    expect(flash).toContain("could not read this server's OAuth client");
    expect(flash).toContain("secretmanager.versions.access");
    expect(flash).toContain("client-id or client-secret secret");
    expect(flash).not.toContain("refused the write");

    const everything = [
      flash,
      JSON.stringify(records.map((r) => r.attributes)),
      ...streams,
    ].join("\n");
    for (const canary of CANARIES) expect(everything).not.toContain(canary);
  });

  it("answers a store that stopped listing mid-flow with a 409, not a 503", async () => {
    const { cookie, state } = await begin();
    pick = () => fake.storeAs([]);

    const res = await callback(cookie, state);
    expect(res.status).toBe(409);
    expect(await res.text()).toContain(
      "strad cannot reach the parameter store this connector writes to",
    );
    expect(tokenRequests).toBe(0);
    expect(
      exported("strad.connector_connect_failed").map((r) => r.attributes),
    ).toEqual([
      {
        "strad.evt": "strad.connector_connect_failed",
        slug: SLUG,
        stage: "callback",
        reason: "store_error",
      },
    ]);
  });

  it("answers a store that is gone by the callback with a 409, not a 503", async () => {
    const { cookie, state } = await begin();
    pick = () => null as unknown as ParameterStore;

    const res = await callback(cookie, state);
    expect(res.status).toBe(409);
    expect(await res.text()).toContain(
      "strad cannot complete this authorization",
    );
    expect(tokenRequests).toBe(0);
    expect(
      exported("strad.connector_connect_failed").map((r) => r.attributes),
    ).toEqual([
      {
        "strad.evt": "strad.connector_connect_failed",
        slug: SLUG,
        stage: "callback",
        reason: "no_store",
      },
    ]);
    expect(stderrEvent().stage).toBe("callback");
  });
});
