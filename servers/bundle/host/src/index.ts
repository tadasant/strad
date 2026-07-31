#!/usr/bin/env node
/**
 * bundle — THE strad supplementary image. All 15 upstream MCP servers (15
 * mounts, see `buildMounts`), one container, one process, one Chromium. The
 * gateway's config names more SLUGS than that — 25 supplementary-image entries
 * in infra/strad.staging.yaml — because capability variants (gmail-ro, gmail-rw,
 * …) are several slugs pointing at ONE mount here.
 *
 * TWENTY-FOUR of those are on one component. The twenty-fifth, `zimmer-secrets`,
 * runs this same image as a SECOND component, because it fronts a second
 * parameter store and `loadSecrets()` below reads `process.env` — one container,
 * one store. Nothing here knows that; it just finds a different SECRETS_PROJECT_ID
 * and mounts /secrets against it.
 *
 * WHAT THIS REPLACES. Eleven components: bundle-api, bundle-api-ro, bundle-gcs,
 * bundle-google-{ro,rw,rw-external}, bundle-op-{ro,rw}, bundle-goodeggs,
 * bundle-fetchpet, bundle-pointsyeah. Most of them existed for ONE reason: a
 * server's capability was a container env var (`GMAIL_ENABLED_TOOLGROUPS`), and
 * a component's env is the union of its servers' env maps — so gmail-ro and
 * gmail-rw wanted two values of one variable and could not share a box. With
 * capability moved to the GATEWAY (src/gateway/toolPolicy.ts), that constraint
 * is gone: this process runs every server at FULL capability and strad decides,
 * per slug, per call, what may run.
 *
 * Which means this file must NOT re-introduce the thing we just deleted. It
 * scrubs every `*_ENABLED_TOOLGROUPS`-shaped variable out of the environment at
 * boot (see `scrubCapabilityEnv`): a stale one would silently strip write tools
 * from the read-WRITE slugs too, and the failure would look like an upstream bug.
 *
 * MOUNTS. Each server is served at its own path — /slack, /gmail, /onepassword,
 * … — which is exactly what a strad `supplementary-image` server's `path:` names.
 * Capability variants (gmail-ro, gmail-rw) are two strad slugs pointing at the
 * SAME path here. This host neither knows nor cares that they exist.
 *
 * BLAST RADIUS, honestly. Fifteen servers now share a process. A crash is a
 * 15-server outage, not a 1-server outage. Everything below that CAN be made
 * survivable is: a browser server whose login fails is marked degraded rather
 * than killing the container (the standalone images exit — correct for them,
 * catastrophic here); a dead Chromium is relaunched on next use; an unhandled
 * rejection is logged, not fatal. What remains fatal is a genuine process-level
 * failure (OOM), and that is the risk the telemetry is there to watch.
 */
import express, { type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { getSharedBrowser, closeSharedBrowser, browserIsUp, browserLaunchCount } from "./browser.js";
import { errMessage, log, logError, logWarn } from "./log.js";
import { loadFromTree, treeSdk, type TreeName } from "./trees.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VERSION = (
  JSON.parse(
    readFileSync(join(__dirname, "..", "package.json"), "utf-8"),
  ) as { version: string }
).version;

const PORT = parseInt(process.env.PORT ?? "8080", 10);

// --- the shape every vendored shared/ factory returns ------------------------

interface Created {
  server: unknown;
  registerHandlers: (server: unknown, ...rest: unknown[]) => Promise<void>;
}

interface Mount {
  /** URL path segment. Matches the `path:` of the strad servers that select it. */
  slug: string;
  tree: TreeName;
  serverName: string;
  capabilities: Record<string, unknown>;
  /** Register this server's handlers onto a fresh Server for one request. */
  register: (server: unknown, opts: { appUi: boolean }) => Promise<void>;
  /**
   * good-eggs alone is SESSION-ful: whether a connection gets the MCP-App
   * (`ui://`) surface is decided from the client's initialize capabilities, and
   * a stateless per-POST server never sees them again. Keep its model intact.
   */
  sessionful?: boolean;
  /** Non-null when this server is up but cannot serve (e.g. login failed). */
  degraded?: string | null;
}

/**
 * Capability is the gateway's job now. Any surviving container-side toggle would
 * silently narrow EVERY slug served from this process — including the read-write
 * ones — so it does not merely get ignored, it gets removed.
 */
function scrubCapabilityEnv(): void {
  const SHAPE =
    /(^|_)(ENABLED_TOOLGROUPS|ENABLED_TOOL_GROUPS|TOOL_GROUPS|ENABLED_TOOLS|DISABLED_TOOLS)$/;
  for (const key of Object.keys(process.env)) {
    if (!SHAPE.test(key)) continue;
    logWarn(
      `ignoring ${key}: capability is enforced by the strad gateway now ` +
        `(tools.allow / tools.deny in the server config), not by this container. ` +
        `Leaving it set would strip tools from the read-write slugs too.`,
    );
    delete process.env[key];
  }
}

async function buildMounts(): Promise<Mount[]> {
  const mounts: Mount[] = [];

  // --- bundle-api: seven pure-API servers -----------------------------------
  // Factories are called ONCE (tailscale memoizes a client; monarch needs a
  // single session store threaded through), and their registerHandlers is reused
  // against a fresh Server per request.
  const api = await loadApiTree();

  mounts.push({
    slug: "slack",
    tree: "bundle-api",
    serverName: "slack-workspace-mcp-server",
    capabilities: { tools: {} },
    register: (s) => api.slack.registerHandlers(s),
  });

  mounts.push({
    slug: "serpapi-hotels",
    tree: "bundle-api",
    serverName: "serpapi-hotels-mcp-server",
    capabilities: { resources: {}, tools: {} },
    register: (s) => api.serpapi.registerHandlers(s),
  });

  mounts.push({
    slug: "tailscale",
    tree: "bundle-api",
    serverName: "tailscale-vpn-mcp-server",
    capabilities: { tools: {} },
    register: (s) => api.tailscale.registerHandlers(s),
  });

  mounts.push({
    slug: "monarch-money",
    tree: "bundle-api",
    serverName: "mcp-server-monarch-money",
    capabilities: { tools: {} },
    register: (s) => api.monarch.registerHandlers(s),
  });

  mounts.push({
    slug: "gcs",
    tree: "bundle-api",
    serverName: "gcs-mcp-server",
    capabilities: { resources: {}, tools: {} },
    // gcs keeps the bare GCS_* names (GCS_PROJECT_ID, GCS_SERVICE_ACCOUNT_KEY_JSON,
    // GCS_BUCKET) — see remote-filesystem below for why it is the one that moved.
    register: (s) => api.gcs.registerHandlers(s),
  });

  mounts.push({
    // The strad slug is `remote-filesystem-tmp-public` (it stores screenshots on a GCS
    // bucket); the vendored upstream is still pulsemcp's `remote-filesystem`.
    slug: "remote-filesystem-tmp-public",
    tree: "bundle-api",
    serverName: "remote-filesystem-mcp-server",
    capabilities: { resources: {}, tools: {} },
    // THE collision this collapse had to solve. gcs and remote-filesystem-tmp-public
    // both read `GCS_BUCKET` from the environment, and they point at DIFFERENT
    // buckets — which is why gcs used to need a component of its own. One process
    // cannot hold two values of one variable, so remote-filesystem-tmp-public stops
    // reading the environment at all: we hand it an explicit client built from
    // its own slug-namespaced vars (REMOTE_FILESYSTEM_TMP_PUBLIC_GCS_*). No collision.
    register: (s) => api.remoteFs.registerHandlers(s, remoteFsClientFactory()),
  });

  mounts.push({
    slug: "google-flights",
    tree: "bundle-api",
    serverName: "google-flights-mcp-server",
    capabilities: { resources: {}, tools: {} },
    register: (s) => api.flights.registerHandlers(s),
  });

  // --- bundle-google: gmail / calendar / docs --------------------------------
  // These build per request (their factories are cheap and hold no client), which
  // is exactly what the bundle-google image does today.
  const google = await loadGoogleTree();

  mounts.push({
    slug: "gmail",
    tree: "bundle-google",
    serverName: "gmail-workspace-mcp-server",
    capabilities: { tools: {} },
    register: async (s) => {
      await google.gmail({ version: VERSION }).registerHandlers(s);
    },
  });

  mounts.push({
    slug: "google-calendar",
    tree: "bundle-google",
    serverName: "google-calendar-workspace-mcp-server",
    capabilities: { tools: {} },
    register: async (s) => {
      await google.calendar({ version: VERSION }).registerHandlers(s);
    },
  });

  mounts.push({
    slug: "google-docs",
    tree: "bundle-google",
    serverName: "google-docs-workspace-mcp-server",
    capabilities: { tools: {} },
    register: async (s) => {
      await google.docs({ version: VERSION }).registerHandlers(s);
    },
  });

  // --- secrets --------------------------------------------------------------
  // The odd one out, and deliberately so: this server's CREDENTIAL is what makes
  // it safe, not its code. It runs against Google Cloud Parameter Manager (the
  // index of everything) with a viewer service account — it can list parameters
  // and read NON-SECRET values, and it holds no secretmanager.versions.access, so
  // it cannot read a SECRET value. Not "does not"; cannot. Google refuses.
  //
  // Secret values live in Secret Manager, written and read in strad's SSO-gated
  // console, which holds a different (admin) service account that never reaches
  // this container (see the `consoleEnv:` scope in src/config/schema.ts). Nothing
  // about this mount can undo that: there is no write tool here, and no key that
  // could perform one.
  const secretsMount = await loadSecrets();
  if (secretsMount) mounts.push(secretsMount);

  // --- onepassword ----------------------------------------------------------
  // The `op` CLI is baked into this image (see the Dockerfile) and shelled out to
  // per call. The upstream refuses to start without an elicitation posture; here
  // that refusal is scoped to the MOUNT, not the container — 1Password declining
  // to serve must not take Slack down with it.
  const op = await loadOnePassword();
  if (op) mounts.push(op);

  // --- browser servers, sharing ONE Chromium --------------------------------
  for (const mount of await loadBrowserMounts()) mounts.push(mount);

  return mounts;
}

// ---------------------------------------------------------------------------
// tree loaders
// ---------------------------------------------------------------------------

interface ApiTree {
  slack: Created;
  serpapi: Created;
  tailscale: Created;
  monarch: Created;
  gcs: Created;
  remoteFs: Created;
  flights: Created;
}

type Factory = (opts: Record<string, unknown>) => Created;

async function loadApiTree(): Promise<ApiTree> {
  const mod = async (slug: string): Promise<{ createMCPServer: Factory }> =>
    loadFromTree("bundle-api", `upstream/${slug}/build/index.js`);

  const slack = await mod("slack");
  const serpapi = await mod("serpapi-hotels");
  const tailscale = await mod("tailscale");
  const gcs = await mod("gcs");
  const remoteFs = await mod("remote-filesystem");
  const flights = await mod("google-flights");

  const monarchMod = (await loadFromTree(
    "bundle-api",
    "upstream/monarch-money/build/index.js",
  )) as {
    createMCPServer: Factory;
    createFileSessionStore: () => unknown;
    resolveSession: (opts: { sessionStore: unknown }) => Promise<unknown>;
  };

  // Warm monarch's session in the BACKGROUND: it may perform a real network
  // login, and a slow login must not delay the other fourteen servers' readiness.
  const sessionStore = monarchMod.createFileSessionStore();
  void monarchMod
    .resolveSession({ sessionStore })
    .catch((err: unknown) =>
      logWarn(`monarch-money: background session resolution failed: ${errMessage(err)}`),
    );

  return {
    slack: slack.createMCPServer({ version: VERSION }),
    serpapi: serpapi.createMCPServer({
      version: VERSION,
      apiKey: process.env.SERPAPI_API_KEY,
    }),
    tailscale: tailscale.createMCPServer({ version: VERSION }),
    monarch: monarchMod.createMCPServer({ version: VERSION, sessionStore }),
    gcs: gcs.createMCPServer({ version: VERSION }),
    remoteFs: remoteFs.createMCPServer({ version: VERSION }),
    flights: flights.createMCPServer({ version: VERSION }),
  };
}

/** remote-filesystem-tmp-public' GCS client, built from ITS OWN env names. See the mount. */
function remoteFsClientFactory(): () => unknown {
  return () => {
    const bucket = process.env.REMOTE_FILESYSTEM_TMP_PUBLIC_GCS_BUCKET;
    if (!bucket) {
      throw new Error(
        "REMOTE_FILESYSTEM_TMP_PUBLIC_GCS_BUCKET must be configured. (In this bundle, " +
          "remote-filesystem-tmp-public does NOT read GCS_BUCKET — that name belongs to " +
          "the gcs server, which points at a different bucket.)",
      );
    }
    return new remoteFsGcsClient({
      bucket,
      projectId: process.env.REMOTE_FILESYSTEM_TMP_PUBLIC_GCS_PROJECT_ID,
      clientEmail: process.env.REMOTE_FILESYSTEM_TMP_PUBLIC_GCS_CLIENT_EMAIL,
      privateKey: process.env.REMOTE_FILESYSTEM_TMP_PUBLIC_GCS_PRIVATE_KEY,
      rootPath: process.env.REMOTE_FILESYSTEM_TMP_PUBLIC_GCS_ROOT_PATH,
      makePublic: process.env.REMOTE_FILESYSTEM_TMP_PUBLIC_GCS_MAKE_PUBLIC === "true",
    });
  };
}

// Resolved at boot in main() — the class, from remote-filesystem's own tree.
let remoteFsGcsClient: new (config: Record<string, unknown>) => unknown;

interface GoogleTree {
  gmail: Factory;
  calendar: Factory;
  docs: Factory;
}

async function loadGoogleTree(): Promise<GoogleTree> {
  const gmail = await loadFromTree<{ createMCPServer: Factory }>(
    "bundle-google",
    "vendor/gmail-shared/build/index.js",
  );
  const calendar = await loadFromTree<{ createMCPServer: Factory }>(
    "bundle-google",
    "vendor/google-calendar-shared/build/index.js",
  );
  const docs = await loadFromTree<{ createMCPServer: Factory }>(
    "bundle-google",
    "vendor/google-docs-shared/build/index.js",
  );
  return {
    gmail: gmail.createMCPServer,
    calendar: calendar.createMCPServer,
    docs: docs.createMCPServer,
  };
}

/**
 * secrets. Not mounted when it is not configured — the same posture as
 * 1Password: one server's missing config must not take the other fifteen down.
 */
async function loadSecrets(): Promise<Mount | null> {
  const mod = (await loadFromTree("secrets", "shared/build/index.js")) as {
    createMCPServer: Factory;
    loadConfig: (env?: NodeJS.ProcessEnv) => unknown;
  };

  let config: unknown;
  try {
    config = mod.loadConfig();
  } catch (err) {
    logWarn(
      `secrets NOT mounted: ${errMessage(err)}. ` +
        `It needs SECRETS_PROJECT_ID and SECRETS_NAMESPACES; ` +
        `an unscoped secrets server would see every parameter in the project.`,
    );
    return null;
  }

  const created = mod.createMCPServer({ version: VERSION, config });
  const hasKey = Boolean(process.env.SECRETS_SERVICE_ACCOUNT_KEY_JSON);

  return {
    slug: "secrets",
    tree: "secrets",
    serverName: "secrets-mcp-server",
    capabilities: { tools: {} },
    degraded: hasKey
      ? null
      : "SECRETS_SERVICE_ACCOUNT_KEY_JSON is not set; tools will list but list_parameters will fail",
    register: (s) => created.registerHandlers(s),
  };
}

async function loadOnePassword(): Promise<Mount | null> {
  const mod = (await loadFromTree(
    "onepassword",
    "shared/build/index.js",
  )) as {
    createMCPServer: Factory;
    OnePasswordClient: new (token: string) => unknown;
    checkElicitationSafety: () => { safe: boolean; reason?: string };
  };

  const safety = mod.checkElicitationSafety();
  if (!safety.safe) {
    // Fail closed — but only for 1Password. The upstream exits the process here;
    // in a 14-server container that would be an outage caused by one server's
    // config. Refuse to MOUNT it instead: strad's gateway then reports it as
    // unavailable, and every other server keeps serving.
    logWarn(
      "onepassword NOT mounted: no elicitation mechanism configured. This server " +
        "redacts secret fields unless a reveal is confirmed, and a stateless HTTP " +
        "transport cannot serve a native prompt. Set ELICITATION_REQUEST_URL + " +
        "ELICITATION_POLL_URL, or DANGEROUSLY_SKIP_ELICITATIONS=true.",
    );
    return null;
  }
  if (safety.reason === "dangerously_skip") {
    logWarn(
      "onepassword: DANGEROUSLY_SKIP_ELICITATIONS=true — secrets are revealed without approval.",
    );
  }

  const created = mod.createMCPServer({ version: VERSION });
  const token = process.env.OP_SERVICE_ACCOUNT_TOKEN;

  return {
    slug: "onepassword",
    tree: "onepassword",
    serverName: "onepassword-mcp-server",
    capabilities: { resources: {}, tools: {} },
    degraded: token
      ? null
      : "OP_SERVICE_ACCOUNT_TOKEN is not set; tools will list but calls will fail",
    register: (s) =>
      created.registerHandlers(
        s,
        () => new mod.OnePasswordClient(process.env.OP_SERVICE_ACCOUNT_TOKEN ?? ""),
      ),
  };
}

/**
 * good-eggs, fetchpet, pointsyeah — three servers, ONE Chromium.
 *
 * Each keeps its own login, its own context and its own cookies; only the
 * browser PROCESS is shared (browser.ts). And unlike their standalone images,
 * a login failure here degrades the one mount instead of exiting the process:
 * with fourteen other servers on board, `process.exit(1)` is no longer a
 * proportionate response to Good Eggs changing a form field.
 */
async function loadBrowserMounts(): Promise<Mount[]> {
  const mounts: Mount[] = [];

  // A container has no display.
  if (!process.env.HEADLESS) process.env.HEADLESS = "true";

  // --- good-eggs ------------------------------------------------------------
  const ge = (await loadFromTree("good-eggs", "shared/build/index.js")) as {
    createMCPServer: (opts: Record<string, unknown>) => {
      registerHandlers: (server: unknown, opts?: { appUi: boolean }) => Promise<void>;
      cleanup: () => Promise<void>;
      startBackgroundLogin: (onFail: (e: Error) => void) => void;
    };
    setSharedBrowserProvider: (p: (() => Promise<unknown>) | null) => void;
    clientSupportsApps: (caps: unknown) => boolean;
  };
  ge.setSharedBrowserProvider(getSharedBrowser);

  // strad injects GOODEGGS_*; the shared logic reads GOOD_EGGS_*.
  if (!process.env.GOOD_EGGS_USERNAME && process.env.GOODEGGS_EMAIL)
    process.env.GOOD_EGGS_USERNAME = process.env.GOODEGGS_EMAIL;
  if (!process.env.GOOD_EGGS_PASSWORD && process.env.GOODEGGS_PASSWORD)
    process.env.GOOD_EGGS_PASSWORD = process.env.GOODEGGS_PASSWORD;

  const geCreated = ge.createMCPServer({ version: VERSION });
  const geMount: Mount = {
    slug: "good-eggs",
    tree: "good-eggs",
    serverName: "good-eggs-mcp-server",
    capabilities: { tools: {}, resources: {} },
    sessionful: true,
    degraded: null,
    register: (s, opts) => geCreated.registerHandlers(s, { appUi: opts.appUi }),
  };
  goodEggsSupportsApps = ge.clientSupportsApps;

  if (process.env.GOOD_EGGS_USERNAME && process.env.GOOD_EGGS_PASSWORD) {
    geCreated.startBackgroundLogin((error: Error) => {
      geMount.degraded = `login failed: ${error.message}`;
      logWarn(`good-eggs: ${geMount.degraded} (this mount is degraded; the container keeps serving)`);
    });
  } else {
    geMount.degraded = "GOODEGGS_EMAIL / GOODEGGS_PASSWORD are not set";
    logWarn(`good-eggs: ${geMount.degraded}`);
  }
  mounts.push(geMount);

  // --- fetchpet -------------------------------------------------------------
  const fp = (await loadFromTree("fetchpet", "shared/build/index.js")) as {
    createMCPServer: (opts: Record<string, unknown>) => {
      registerHandlers: (server: unknown) => Promise<void>;
      cleanup: () => Promise<void>;
      startBackgroundLogin: (onFail: (e: Error) => void) => void;
    };
    setSharedBrowserProvider: (p: (() => Promise<unknown>) | null) => void;
  };
  fp.setSharedBrowserProvider(getSharedBrowser);

  if (!process.env.FETCHPET_USERNAME && process.env.FETCHPET_EMAIL)
    process.env.FETCHPET_USERNAME = process.env.FETCHPET_EMAIL;

  const fpCreated = fp.createMCPServer({ version: VERSION });
  const fpMount: Mount = {
    slug: "fetchpet",
    tree: "fetchpet",
    serverName: "fetchpet-mcp-server",
    capabilities: { tools: {} },
    degraded: null,
    register: (s) => fpCreated.registerHandlers(s),
  };

  if (process.env.FETCHPET_USERNAME && process.env.FETCHPET_PASSWORD) {
    fpCreated.startBackgroundLogin((error: Error) => {
      fpMount.degraded = `login failed: ${error.message}`;
      logWarn(`fetchpet: ${fpMount.degraded} (this mount is degraded; the container keeps serving)`);
    });
  } else {
    fpMount.degraded = "FETCHPET_USERNAME / FETCHPET_PASSWORD are not set";
    logWarn(`fetchpet: ${fpMount.degraded}`);
  }
  mounts.push(fpMount);

  // --- pointsyeah -----------------------------------------------------------
  // pointsyeah injects its browser through a deps object rather than a provider,
  // so it gets a CONTEXT on the shared browser per search, closing the context
  // (never the browser) when the search ends.
  const py = (await loadFromTree("pointsyeah", "shared/build/index.js")) as {
    createMCPServer: (opts: Record<string, unknown>) => {
      registerHandlers: (server: unknown, factory: () => unknown) => Promise<void>;
    };
    PointsYeahClient: new (deps: unknown) => unknown;
    setRefreshToken: (t: string) => void;
    setAuthenticated: (b: boolean) => void;
  };
  const pyAuth = (await loadFromTree(
    "pointsyeah",
    "shared/build/pointsyeah-client/lib/auth.js",
  )) as { refreshCognitoTokens: (token: string) => Promise<unknown> };

  const pyClient = new py.PointsYeahClient(pointsYeahPlaywrightDeps());
  const pyCreated = py.createMCPServer({ version: VERSION });
  const pyMount: Mount = {
    slug: "pointsyeah",
    tree: "pointsyeah",
    serverName: "pointsyeah-mcp-server",
    capabilities: { resources: {}, tools: {} },
    degraded: null,
    register: (s) => pyCreated.registerHandlers(s, () => pyClient),
  };

  const pyToken = process.env.POINTSYEAH_REFRESH_TOKEN;
  if (pyToken) {
    void pyAuth
      .refreshCognitoTokens(pyToken)
      .then(() => {
        py.setRefreshToken(pyToken);
        py.setAuthenticated(true);
        log("pointsyeah: refresh token validated");
      })
      .catch((err: unknown) => {
        pyMount.degraded = `refresh token invalid: ${errMessage(err)} (use set_refresh_token)`;
        logWarn(`pointsyeah: ${pyMount.degraded}`);
      });
  } else {
    pyMount.degraded =
      "POINTSYEAH_REFRESH_TOKEN not set; search requires set_refresh_token first";
    logWarn(`pointsyeah: ${pyMount.degraded}`);
  }
  mounts.push(pyMount);

  return mounts;
}

let goodEggsSupportsApps: (caps: unknown) => boolean = () => false;

/**
 * A `PlaywrightSearchDeps` for pointsyeah, over the SHARED browser: one context
 * per search, closed when the search ends. (Upstream launched a whole browser
 * per search; the standalone image already fixed that — this keeps the fix and
 * shares the browser with good-eggs and fetchpet on top.)
 */
function pointsYeahPlaywrightDeps(): unknown {
  return {
    launchBrowser: async () => {
      const browser = await getSharedBrowser();
      const context = (await browser.newContext()) as {
        addCookies: (c: unknown) => Promise<void>;
        newPage: () => Promise<PlaywrightPage>;
        close: () => Promise<void>;
      };
      return {
        addCookies: (cookies: unknown) => context.addCookies(cookies),
        newPage: async () => {
          const page = await context.newPage();
          return {
            goto: (url: string, options?: unknown) =>
              page.goto(url, options).then(() => {}),
            waitForResponse: (
              predicate: (r: { url: () => string; json: () => Promise<unknown> }) => boolean,
              options?: unknown,
            ) =>
              page
                .waitForResponse(predicate, options)
                .then((res) => ({ url: () => res.url(), json: () => res.json() })),
            close: () => page.close(),
          };
        },
        // The CONTEXT closes; the browser lives on for the next search — and for
        // good-eggs and fetchpet, who are using it too.
        close: () => context.close(),
      };
    },
  };
}

interface PlaywrightPage {
  goto(url: string, options?: unknown): Promise<unknown>;
  waitForResponse(
    predicate: (r: { url: () => string; json: () => Promise<unknown> }) => boolean,
    options?: unknown,
  ): Promise<{ url: () => string; json: () => Promise<unknown> }>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function jsonRpcError(err: unknown): unknown {
  return {
    jsonrpc: "2.0",
    error: { code: -32603, message: errMessage(err) },
    id: null,
  };
}

/** Stateless: a fresh Server + transport per request, from the mount's OWN SDK. */
function statelessHandler(mount: Mount) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const sdk = await treeSdk(mount.tree);
      const server = new sdk.Server(
        { name: mount.serverName, version: VERSION },
        { capabilities: mount.capabilities },
      );
      await mount.register(server, { appUi: false });

      const transport = new sdk.StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      res.on("close", () => {
        void transport.close().catch(() => {});
        void server.close().catch(() => {});
      });

      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      logError(mount.slug, err);
      if (!res.headersSent) res.status(500).json(jsonRpcError(err));
    }
  };
}

/**
 * Session-ful, for good-eggs only.
 *
 * Its MCP-App surface is gated on capabilities the client advertises ONCE, at
 * initialize. A stateless server never sees them again on the tools/list that
 * follows, so it cannot gate — hence a Server bound to a session. The expensive
 * thing (the logged-in page, on the shared browser) still lives outside the
 * session and is shared across all of them.
 */
function sessionfulHandler(mount: Mount) {
  const transports: Record<string, InstanceType<Awaited<ReturnType<typeof treeSdk>>["StreamableHTTPServerTransport"]>> =
    {};

  const post = async (req: Request, res: Response): Promise<void> => {
    try {
      const sdk = await treeSdk(mount.tree);
      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      if (sessionId && transports[sessionId]) {
        await transports[sessionId]!.handleRequest(req, res, req.body);
        return;
      }

      if (!sessionId && sdk.isInitializeRequest(req.body)) {
        const capabilities = (req.body as { params?: { capabilities?: unknown } })
          ?.params?.capabilities;
        const appUi = goodEggsSupportsApps(capabilities);

        const server = new sdk.Server(
          { name: mount.serverName, version: VERSION },
          { capabilities: { tools: {}, ...(appUi ? { resources: {} } : {}) } },
        );
        await mount.register(server, { appUi });

        const transport = new sdk.StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid: string) => {
            transports[sid] = transport;
          },
        });
        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid && transports[sid]) delete transports[sid];
          void server.close().catch(() => {});
        };

        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
      }

      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Bad Request: no valid session" },
        id: null,
      });
    } catch (err) {
      logError(mount.slug, err);
      if (!res.headersSent) res.status(500).json(jsonRpcError(err));
    }
  };

  const session = async (req: Request, res: Response): Promise<void> => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }
    await transports[sessionId]!.handleRequest(req, res);
  };

  return { post, session };
}

async function main(): Promise<void> {
  scrubCapabilityEnv();

  // remote-filesystem's GCS client class, from its own tree (see the mount).
  const rfs = (await loadFromTree(
    "bundle-api",
    "upstream/remote-filesystem/build/index.js",
  )) as { GCSClient: new (config: Record<string, unknown>) => unknown };
  remoteFsGcsClient = rfs.GCSClient;

  const mounts = await buildMounts();

  const app = express();
  app.disable("x-powered-by");
  // Gmail attachments, GCS uploads and document bodies are big; the 100kb default
  // would truncate them into confusing protocol errors.
  app.use(express.json({ limit: "20mb" }));

  // Liveness for App Platform. Reports every mount and whether it is degraded —
  // with 15 servers behind one health check, "ok: true" alone is not information.
  app.get("/healthz", (_req, res) => {
    res.status(200).json({
      ok: true,
      component: "bundle",
      version: VERSION,
      chromium: { up: browserIsUp(), launches: browserLaunchCount() },
      servers: mounts.map((m) => ({
        slug: m.slug,
        path: `/${m.slug}`,
        ...(m.degraded ? { degraded: m.degraded } : {}),
      })),
    });
  });

  for (const mount of mounts) {
    if (mount.sessionful) {
      const { post, session } = sessionfulHandler(mount);
      app.post(`/${mount.slug}`, (req, res) => void post(req, res));
      app.get(`/${mount.slug}`, (req, res) => void session(req, res));
      app.delete(`/${mount.slug}`, (req, res) => void session(req, res));
    } else {
      app.all(`/${mount.slug}`, statelessHandler(mount));
    }
  }

  // One stray rejection from one of fifteen servers must not kill the other
  // fourteen. The standalone images exit here (correct, when the process IS the
  // server); this one logs.
  process.on("unhandledRejection", (reason) => {
    logError("unhandledRejection", reason);
  });

  const shutdown = (signal: string): void => {
    log(`received ${signal}, closing Chromium and exiting`);
    void closeSharedBrowser().finally(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  app.listen(PORT, "0.0.0.0", () => {
    log(
      `streamable-HTTP on :${PORT} — ${mounts.length} servers: ${mounts.map((m) => `/${m.slug}`).join(" ")}`,
    );
  });
}

main().catch((error: unknown) => {
  logError("main", error);
  process.exit(1);
});
