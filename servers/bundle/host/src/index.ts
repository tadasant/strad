#!/usr/bin/env node
/**
 * bundle — THE strad supplementary image. All 22 upstream MCP servers (22
 * mounts, see `buildMounts`), one container, one process, one Chromium, one
 * mcp-grafana child. The gateway's config names more SLUGS than that — 32
 * supplementary-image entries in infra/strad.staging.yaml — because capability
 * variants (gmail-ro, gmail-rw, …) are several slugs pointing at ONE mount here.
 *
 * TWENTY-TWO IS THE FLOOR, not a constant. Four trees (telegram,
 * remote-filesystem, google-sheets, grafana) mount ONE INSTANCE PER SLUG the
 * environment carries per-slug values for — see `extraSlugs` — so a container
 * told about `telegram-ro` and `telegram-rw` separately serves /telegram,
 * /telegram-ro and /telegram-rw. google-sheets and grafana are the cases a real
 * deployment uses: an OAuth refresh token IS one Google account and a
 * service-account token IS one Grafana, so each extra account is another mount
 * here. The conventional path is always mounted, so a config that asks for none
 * of this sees exactly the twenty-two it saw before.
 *
 * THIRTY-ONE of those are on one component. The other one, `zimmer-secrets`,
 * runs this same image as a SECOND component, and what makes it one is the SLUG
 * rather than the store: a second entitlement and a second console page. A
 * second STORE needs no second component — `loadSecrets()` below hands the tree
 * a LIST of them (`SECRETS_STORES`, derived from `mcpStores:`), each with its own
 * project, namespaces, viewer credential and probed capability, so one container
 * fronts as many as the config names. Nothing here knows which; it reads the
 * descriptor and mounts /secrets against all of them.
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
 * MOUNTS. Each server is served at its own path — /slack, /gmail, /strad-fetch,
 * … — which is exactly what a strad `supplementary-image` server's `path:` names.
 * Capability variants (gmail-ro, gmail-rw) are two strad slugs pointing at the
 * SAME path here. This host neither knows nor cares that they exist.
 *
 * BLAST RADIUS, honestly. Twenty-two servers now share a process. A crash is a
 * 22-server outage, not a 1-server outage. Everything below that CAN be made
 * survivable is: a browser server whose login fails is marked degraded rather
 * than killing the container (the standalone images exit — correct for them,
 * catastrophic here); a dead Chromium is relaunched on next use; an unhandled
 * rejection is logged, not fatal. What remains fatal is a genuine process-level
 * failure (OOM), and that is the risk the telemetry is there to watch.
 */
import express, { type Request, type Response } from "express";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { getSharedBrowser, closeSharedBrowser, browserIsUp, browserLaunchCount } from "./browser.js";
import { slugEnvView } from "./env-prefix.js";
import { requireInternalToken } from "./internal-auth.js";
import { errMessage, log, logError, logWarn } from "./log.js";
import {
  dropInheritedNames,
  extraSlugs,
  missingCredentialsDegraded,
  remoteFilesystemDegraded,
  scrubCapabilityEnv,
} from "./mounts.js";
import { PRESENCE_ROUTE, presenceResponse } from "./presence.js";
import { paramStoreFor, startParamRefresh } from "./param-store.js";
import { CORE_URL_ENV, createStoreRefreshClient } from "./param-route.js";
import { loadFromTree, treeSdk, type TreeName } from "./trees.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VERSION = (
  JSON.parse(
    readFileSync(join(__dirname, "..", "package.json"), "utf-8"),
  ) as { version: string }
).version;

const PORT = parseInt(process.env.PORT ?? "8080", 10);

/**
 * When THIS process started — the freshness half of what the presence route
 * reports. A container that predates the last render holds the previous deploy's
 * environment, and "the value is baked" and "the running process has it" are
 * different claims. This is what lets core tell them apart.
 */
const BOOTED_AT = new Date();

// --- the shape every vendored shared/ factory returns ------------------------

interface Created {
  server: unknown;
  registerHandlers: (server: unknown, ...rest: unknown[]) => Promise<void>;
  handleUpload?: (token: string, body: Buffer) => Promise<{
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
  }>;
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
  /**
   * True when this mount reads its credential out of `process.env` LATE — when
   * it builds a client per request — rather than snapshotting it at mount time.
   *
   * Only `paramsRefresh:` cares. A refreshed parameter lands in this process's
   * environment, and whether the upstream then uses it is this property. Leaving
   * it unset is the safe answer: the boot log says the refresh may not reach the
   * mount, which is true of every server that memoises a client or a connection
   * (telegram's MTProto session, a Grafana client, the X OAuth provider). Set it
   * only where the per-request path has been read and it really does re-read.
   */
  liveEnv?: boolean;
  /** Optional non-MCP upload endpoint exposed beside this mount. */
  upload?: (token: string, body: Buffer) => Promise<{
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
  }>;
}

async function buildMounts(): Promise<Mount[]> {
  const mounts: Mount[] = [];
  /**
   * Instances the ENVIRONMENT asked for, built after every conventional mount.
   *
   * A discovered slug is a name derived from `process.env`, and the routes below
   * are registered first-wins — so one that collides with a mount this image
   * already serves would SHADOW it, and `/secrets` answering with telegram's
   * tools is not a failure anyone would diagnose from the symptom. Deferring
   * them makes the conventional mount win, and the loop at the end refuses the
   * collision by name rather than silently.
   */
  const deferred: { slug: string; load: () => Promise<Mount> }[] = [];

  // --- bundle-api: six pure-API servers --------------------------------------
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
    // GCS_BUCKET) — see loadRemoteFilesystem for why the other one moved.
    register: (s) => api.gcs.registerHandlers(s),
  });

  mounts.push(await loadRemoteFilesystem("remote-filesystem-tmp-public"));
  for (const slug of extraSlugs(
    "remote-filesystem-tmp-public",
    REMOTE_FS_MARKER_NAMES,
  ))
    deferred.push({ slug, load: () => loadRemoteFilesystem(slug) });

  mounts.push({
    slug: "google-flights",
    tree: "bundle-api",
    serverName: "google-flights-mcp-server",
    capabilities: { resources: {}, tools: {} },
    register: (s) => api.flights.registerHandlers(s),
  });

  mounts.push(await loadXTwitter());

  mounts.push(await loadPulseSubregistry());

  mounts.push(await loadStradFetch());

  // grafana: the conventional mount, plus one per slug the environment carries a
  // whole Grafana credential for. The default is always served — degraded until
  // something gives it a URL and a token — so a config that names no Grafana at
  // all still shows the slug and its 52 read tools.
  const grafana = await loadGrafanaTree();
  mounts.push(loadGrafana(grafana, "grafana"));
  for (const slug of extraSlugs("grafana", grafana.GRAFANA_ENV_NAMES))
    deferred.push({ slug, load: async () => loadGrafana(grafana, slug) });

  mounts.push(await loadTelegram("telegram"));
  for (const slug of extraSlugs("telegram", TELEGRAM_MARKER_NAMES))
    deferred.push({ slug, load: () => loadTelegram(slug) });

  mounts.push(await loadBillSpend());

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

  // google-sheets is the one server in this tree whose CREDENTIAL is per slug: an
  // OAuth refresh token belongs to ONE Google account, and a deployment that wants
  // several accounts wants several mounts. The conventional path is always served
  // (degraded when nothing gave it a credential); each slug the environment
  // carries an OAuth CLIENT for gets its own.
  //
  // The client id and secret, NOT the refresh token: this is the one tree whose
  // credential is completed AFTER the deploy, by a human clicking Connect on the
  // slug's own console page, and that page only exists once the slug is deployed.
  // Discovering on all three would unmount every slug that has not been connected
  // yet — the exact state the renderer's inject-only-if-present produces — so the
  // console would offer a Connect button for a path the container does not serve.
  mounts.push(loadGoogleSheets(google.sheets, "google-sheets", false));
  for (const slug of extraSlugs(
    "google-sheets",
    google.sheets.GOOGLE_SHEETS_OAUTH_APP_ENV_NAMES,
  ))
    deferred.push({
      slug,
      load: async () => loadGoogleSheets(google.sheets, slug, true),
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

  // --- the instances the environment asked for, last -------------------------
  const taken = new Set(mounts.map((m) => m.slug));
  for (const { slug, load } of deferred) {
    if (taken.has(slug)) {
      logWarn(
        `NOT mounting a per-slug instance for "${slug}": /${slug} is already ` +
          `served by another server in this image, and mounting it here would ` +
          `shadow that one. Rename the strad slug.`,
      );
      continue;
    }
    taken.add(slug);
    mounts.push(await load());
  }

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
  flights: Created;
}

type Factory = (opts: Record<string, unknown>) => Created;

async function loadApiTree(): Promise<ApiTree> {
  const mod = async (slug: string): Promise<{ createMCPServer: Factory }> =>
    loadFromTree("bundle-api", `upstream/${slug}/build/index.js`);

  // slack is one of three servers in that tree strad FORKED rather than
  // vendored verbatim — its write tools carry the Slack-mrkdwn rules and a
  // post-hoc advisory that upstream does not have. It builds from fork/, not
  // upstream/. See servers/bundle-api/fork/slack/FORK.md.
  const slack = (await loadFromTree("bundle-api", "fork/slack/build/index.js")) as {
    createMCPServer: Factory;
  };
  const serpapi = await mod("serpapi-hotels");
  const tailscale = await mod("tailscale");
  const gcs = await mod("gcs");

  // google-flights is the second fork. Upstream's protobuf numbered two Info
  // fields wrong, so Google silently ignored cabin class AND passenger counts;
  // its baggage flags were read in the wrong order; and its date grid returned a
  // trailing price HISTORY rather than future departure dates. All three are
  // fixed here. See servers/bundle-api/fork/google-flights/FORK.md.
  const flights = (await loadFromTree(
    "bundle-api",
    "fork/google-flights/build/index.js",
  )) as { createMCPServer: Factory };

  // monarch-money is the third. Its holdings query asked for `account(id:) {
  // holdings }`, a field Monarch's schema does not have, and the handler wrapped
  // each request in `.catch(() => [])` — so every brokerage reported an empty
  // portfolio and nothing raised. It reads `portfolio.aggregateHoldings` here,
  // in one request, and a failed fetch is an error.
  // See servers/bundle-api/fork/monarch-money/FORK.md.
  const monarchMod = (await loadFromTree(
    "bundle-api",
    "fork/monarch-money/build/index.js",
  )) as {
    createMCPServer: Factory;
    createFileSessionStore: () => unknown;
    resolveSession: (opts: { sessionStore: unknown }) => Promise<unknown>;
  };

  // Warm monarch's session in the BACKGROUND: it may perform a real network
  // login, and a slow login must not delay the other twenty servers' readiness.
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
    flights: flights.createMCPServer({ version: VERSION }),
  };
}

/**
 * pulse-subregistry — PulseMCP's MCP server registry API.
 *
 * Tenant selection is environment-configured rather than mutable over MCP,
 * because this host is shared across requests.
 */
async function loadPulseSubregistry(): Promise<Mount> {
  const mod = (await loadFromTree(
    "pulse-subregistry",
    "shared/build/index.js",
  )) as { createMCPServer: Factory };

  const created = mod.createMCPServer({ version: VERSION });
  const hasApiKey = Boolean(process.env.PULSEMCP_SUBREGISTRY_API_KEY);

  return {
    slug: "pulse-subregistry",
    tree: "pulse-subregistry",
    serverName: "strad-pulse-subregistry",
    capabilities: { tools: {} },
    degraded: hasApiKey
      ? null
      : "PULSEMCP_SUBREGISTRY_API_KEY is not set; tools will list but calls will fail",
    register: (s) => created.registerHandlers(s),
  };
}

interface GoogleSheetsModule {
  createMCPServer: Factory;
  missingCredentials: (env: Record<string, string | undefined>) => string[];
  /** The variables ONE account's credential is made of. Owned by the tree. */
  GOOGLE_SHEETS_ENV_NAMES: readonly string[];
  /**
   * The OAuth app half of that credential — the two variables a human seeds
   * before consent, and the marker set per-slug discovery keys on. What it
   * leaves out is the per-account half, which is why the host derives that by
   * subtraction rather than naming the token itself.
   */
  GOOGLE_SHEETS_OAUTH_APP_ENV_NAMES: readonly string[];
}

/**
 * strad-fetch — web page retrieval, strad's fork of @pulsemcp/pulse-fetch.
 *
 * NOT DEGRADED WITHOUT A CREDENTIAL, and that is the point of the fork. The
 * native HTTP strategy needs no key and serves most public pages; BrightData and
 * Firecrawl buy coverage on sites that block a bare fetch. So an absent or
 * rejected key narrows what this mount can reach and never stops it serving —
 * which is why there is no `degraded` line here, unlike pulse-subregistry above.
 * servers/strad-fetch/FORK.md has the evidence for each delta.
 *
 * The factory is created ONCE: its resource cache is process-level and bounded,
 * so a URL one request scraped is a cache hit for the next.
 */
async function loadStradFetch(): Promise<Mount> {
  const mod = (await loadFromTree("strad-fetch", "shared/build/index.js")) as {
    createMCPServer: Factory;
  };

  const created = mod.createMCPServer({ version: VERSION });

  return {
    slug: "strad-fetch",
    tree: "strad-fetch",
    serverName: "strad-fetch",
    capabilities: { resources: {}, tools: {} },
    // Its default client factory reads FIRECRAWL_API_KEY and BRIGHTDATA_API_KEY
    // out of `process.env` when it is INVOKED, and `registerHandlers` runs per
    // request (see statelessHandler) — so a key rotated under this process is
    // used by the next call, with no restart. That is what `paramsRefresh:` on
    // this slug relies on.
    liveEnv: true,
    register: (s) => created.registerHandlers(s),
  };
}

interface GrafanaModule {
  createMCPServer: (opts: Record<string, unknown>) => {
    registerHandlers: (server: unknown) => Promise<void>;
    missing: string[];
    close: () => Promise<void>;
  };
  /** The tree owns what its credential IS — see loadGoogleSheets for why. */
  missingCredentials: (env: Record<string, string | undefined>) => string[];
  /** The variables ONE Grafana's credential is made of. Owned by the tree. */
  GRAFANA_ENV_NAMES: readonly string[];
}

async function loadGrafanaTree(): Promise<GrafanaModule> {
  return (await loadFromTree("grafana", "shared/build/index.js")) as GrafanaModule;
}

/**
 * grafana — Grafana Labs' own MCP server, hosted here rather than run as a
 * client-side binary.
 *
 * THE ONE UPSTREAM IN THIS IMAGE THAT IS NOT JAVASCRIPT. Grafana ships it as a
 * Go executable and a Docker image and nothing else, so there is no package to
 * import: the Dockerfile bakes the pinned, SHA-256-verified binary onto PATH and
 * the `grafana` tree supervises it over stdio, forwarding one MCP surface to it.
 * Everything below this line is the same as any other mount — which is the whole
 * point of doing it this way rather than teaching strad's config a `command:`.
 *
 * READ-ONLY AT THE BINARY. The child runs with `-disable-write` and
 * `-disable-proxied`: 52 read tools, and no write to withhold. That is a
 * deliberate exception to this container's rule that every upstream runs at FULL
 * capability and the gateway narrows it — the gateway can only ever withhold a
 * tool, and for a fleet's observability control plane the stronger guarantee is
 * worth the exception. See servers/grafana/shared/src/upstream.ts.
 *
 * ONE INSTANCE PER SLUG, and this is the mount that most needs it: a Grafana
 * credential is one Grafana. `grafana-registry` (the MCP Registry's cluster) and
 * a future `grafana` (obs.tadasant.com, the fleet's dashboard plane) are two
 * origins and two tokens, so they are two children of this process — the same
 * shape telegram and google-sheets take, for the same reason.
 */
function loadGrafana(mod: GrafanaModule, slug: string): Mount {
  const env = slugEnvView(process.env, slug);

  // Degraded, not unmounted, and for the usual reason: the tools must still LIST
  // so the console shows the slug and an agent can see what it would offer once
  // a token lands. mcp-grafana lists its 52 tools without ever reaching Grafana,
  // so this mount's surface is honest even here — only the calls fail.
  const missing = mod.missingCredentials(env);
  const unconfigured =
    missing.length > 0
      ? `${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not set; ` +
        `tools will list but every call will fail`
      : null;

  const mount: Mount = {
    slug,
    tree: "grafana",
    serverName: "strad-grafana",
    capabilities: { tools: {} },
    degraded: unconfigured,
    // Replaced below, once the supervisor it delegates to exists.
    register: async () => {},
  };

  const created = mod.createMCPServer({
    version: VERSION,
    env,
    slug,
    log: (line: string) => log(`${slug}: ${line}`),
    // A child that cannot be started is this mount's fault and nobody else's:
    // report it on /healthz rather than only in the error of whoever happened to
    // call next. A child that came up clears it — back to the missing-credential
    // state if that is still true, because a running binary with no token is
    // still a mount that fails every call.
    onDegraded: (reason: string | null) => {
      if (reason === null) {
        if (mount.degraded !== unconfigured) {
          mount.degraded = unconfigured;
          log(`${slug}: mcp-grafana is up (mount is no longer degraded)`);
        }
        return;
      }
      mount.degraded = reason;
      logWarn(
        `${slug}: ${reason} (this mount is degraded; the container keeps serving)`,
      );
    },
  });

  mount.register = (s) => created.registerHandlers(s);
  return mount;
}

interface GoogleTree {
  gmail: Factory;
  calendar: Factory;
  docs: Factory;
  sheets: GoogleSheetsModule;
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
  const sheets = await loadFromTree<GoogleSheetsModule>(
    "bundle-google",
    "vendor/google-sheets-shared/build/index.js",
  );
  return {
    gmail: gmail.createMCPServer,
    calendar: calendar.createMCPServer,
    docs: docs.createMCPServer,
    sheets,
  };
}

/**
 * google-sheets: one mount per Google ACCOUNT, and six strad slugs over three of
 * them.
 *
 * WHY THIS ONE IS DIFFERENT. Every other server in this tree authenticates as a
 * service account with domain-wide delegation — one credential, any user in the
 * Workspace. Sheets here authenticates as a PERSON: an OAuth refresh token minted
 * by that person for that account. A refresh token is one account by
 * construction, so `google-sheets-tadas412-*` and `google-sheets-tadas-tadasant-*`
 * cannot share a variable, in the same way `gcs` and the artifact store cannot
 * share GCS_BUCKET.
 *
 * The renderer already solves that: every supplementary server's variables are
 * ALSO baked under its own slug (`GOOGLE_SHEETS_TADAS412_RO__GOOGLE_SHEETS_OAUTH_REFRESH_TOKEN`),
 * and `slugEnvView` flattens one slug's prefixed names back to the bare ones this
 * server reads. So a config with six google-sheets slugs produces six mounts here,
 * each holding exactly one account's token, without this file knowing any of their
 * names.
 *
 * A slug is DISCOVERED on the OAuth app pair and MOUNTED whatever it holds, so
 * the six exist from the first deploy, before any of them has a token. That is
 * the state `degraded` below describes, and it is the only state in which a human
 * can mint the token: the Connect button lives on the slug's console page.
 *
 * The READ/WRITE half of a slug's name is NOT decided here. This mount serves all
 * eight tools and strad's gateway withholds the four writes from a `-ro` slug
 * (src/gateway/toolPolicy.ts) — the same trade every other capability variant in
 * this container makes. A deployment that wants Google to enforce it too can seed
 * the `-ro` slug a token consented only for `spreadsheets.readonly`; because the
 * credential is per slug, that costs nothing here.
 */
function loadGoogleSheets(
  sheets: GoogleSheetsModule,
  slug: string,
  perSlug: boolean,
): Mount {
  const view = slugEnvView(process.env, slug);
  // A DISCOVERED slug's ACCOUNT is its own or it has none. Everything the OAuth
  // app pair is not is the per-account half of the credential — the refresh token
  // — and a slug that has not been connected yet must not inherit a bare one from
  // whichever server put it on the box. See `dropInheritedNames`. The conventional
  // mount is the bare names' owner, so it keeps reading them.
  if (perSlug) {
    const app = new Set<string>(sheets.GOOGLE_SHEETS_OAUTH_APP_ENV_NAMES);
    dropInheritedNames(
      view,
      slug,
      sheets.GOOGLE_SHEETS_ENV_NAMES.filter((name) => !app.has(name)),
    );
  }
  const env = {
    ...view,
    // WHERE TO GO WHEN THE TOKEN DIES. `invalid_grant` is the normal end of a
    // refresh token's life (seven days for an app in "testing", or any password
    // change), and the recovery is one button on this slug's own console page.
    // The mount knows its slug and the box knows the gateway's public URL, so
    // the error can name the page rather than describing a procedure.
    ...(process.env.STRAD_PUBLIC_URL
      ? {
          GOOGLE_SHEETS_RECONNECT_URL: `${process.env.STRAD_PUBLIC_URL.replace(/\/$/, "")}/ui/${slug}`,
        }
      : {}),
  };
  // The tree owns what its credential IS. A copy of that list here would keep
  // gating on three names on the day the server starts needing four.
  const missing = sheets.missingCredentials(env);

  return {
    slug,
    tree: "bundle-google",
    serverName: "google-sheets-workspace-mcp-server",
    capabilities: { tools: {} },
    // Degraded, not unmounted: the tools must still LIST, so the console shows
    // the slug and an agent can see what it would offer once a token lands.
    degraded: missingCredentialsDegraded(missing),
    register: async (s) => {
      await sheets.createMCPServer({ version: VERSION, env }).registerHandlers(s);
    },
  };
}

/**
 * remote-filesystem-tmp-public — strad's own artifact store.
 *
 * THE COLLISION THIS SOLVES. `gcs` and this server both want `GCS_BUCKET`, and
 * they point at DIFFERENT buckets — which is why gcs used to need a component of
 * its own. One process cannot hold two values of one variable, so this server
 * never reads the bare names: it is constructed with an `envPrefix` and reads
 * every key under `REMOTE_FILESYSTEM_TMP_PUBLIC_*`. Delete the prefix and the two
 * servers silently share a bucket.
 *
 * Config is resolved LAZILY inside the server (on the first tool call), so a
 * missing bucket is one server's error, not a boot failure for the other
 * twenty — the same posture as secrets and 1Password.
 */
const REMOTE_FS_ENV_PREFIX = "REMOTE_FILESYSTEM_TMP_PUBLIC";

/**
 * The names that make a per-slug instance of this server worth building.
 *
 * NOTE THE DOUBLE PREFIX a second slug produces:
 * `REMOTE_FS_ARCHIVE__REMOTE_FILESYSTEM_TMP_PUBLIC_GCS_BUCKET`. It reads badly and
 * it is still correct — the two prefixes do different jobs. The inner one keeps
 * this server off the bare `GCS_*` names, which belong to the `gcs` server in the
 * same container; the outer one separates two instances of THIS server. Collapsing
 * them by dropping the inner prefix would make the bare-name fallback resolve
 * `GCS_BUCKET` to the gcs server's bucket, which is the exact bug config.ts exists
 * to prevent.
 */
const REMOTE_FS_MARKER_NAMES = [`${REMOTE_FS_ENV_PREFIX}_GCS_BUCKET`];

async function loadRemoteFilesystem(slug: string): Promise<Mount> {
  const mod = (await loadFromTree(
    "remote-filesystem",
    "shared/build/index.js",
  )) as { createMCPServer: Factory };

  const env = slugEnvView(process.env, slug);

  const created = mod.createMCPServer({
    version: VERSION,
    envPrefix: REMOTE_FS_ENV_PREFIX,
    // The instance reads THIS view, not the process environment. Two instances
    // in one process is the whole point, and it only works because nothing below
    // reaches back to a global.
    env,
    // Signed upload URLs carry the slug, and the route below is per-mount.
    uploadSlug: slug,
  });

  return {
    slug,
    tree: "remote-filesystem",
    serverName: "strad-remote-filesystem",
    capabilities: { tools: {} },
    // Degraded, not unmounted: the tools must still LIST so an agent can see
    // what this deployment would offer, and so the console shows the slug at all.
    degraded: remoteFilesystemDegraded(env, REMOTE_FS_ENV_PREFIX),
    register: (s) => created.registerHandlers(s),
    upload: created.handleUpload,
  };
}

/**
 * The strad slug this mount is served under, and therefore the parameter
 * namespace it reads and writes: `/strad/{env}/mcp/x-twitter/static/`.
 *
 * A CONSTANT, not `mount.slug` threaded through, because the two are the same
 * string for a reason: a strad `supplementary-image` server's `path:` is what
 * selects a mount in this image, and `paramsWritable:` is declared on that same
 * config entry. If x-twitter ever grows per-slug instances (as telegram and
 * remote-filesystem have), each instance's store handle has to be built from its
 * own slug — the write-back is per SERVER, and two X accounts are two
 * credentials.
 */
const X_SLUG = "x-twitter";

/** The variable a strad config must list under `paramsWritable:` for the below. */
const X_REFRESH_TOKEN_VAR = "X_OAUTH_REFRESH_TOKEN";

/**
 * X, with a refresh token that survives a restart.
 *
 * X's OAuth 2.0 refresh tokens are SINGLE-USE and ROTATING: every refresh
 * returns a new one and kills the one just spent. Without the two calls below,
 * this process rotates in memory, the container restarts, and it comes back
 * holding the value the deploy baked — which the previous process already spent
 * hours ago. Nothing looks wrong until the restart, and then every call 401s
 * until a human re-seeds by hand.
 *
 * So: read the current token from core at mount time (falling back to the baked
 * one when core cannot answer), and persist every rotation back. See
 * param-store.ts for which of those two is allowed to fail quietly.
 */
async function loadXTwitter(): Promise<Mount> {
  const x = (await loadFromTree("x-twitter", "shared/build/index.js")) as {
    createMCPServer: Factory;
    createXClientFromEnv: (
      env: NodeJS.ProcessEnv,
      persistence: {
        refreshToken?: string;
        onRefreshToken?: (token: string) => void | Promise<void>;
      },
    ) => unknown;
  };
  const created = x.createMCPServer({ version: VERSION });
  const params = paramStoreFor(X_SLUG);

  // AT MOUNT TIME, once. Not per request: this read is what the process starts
  // from, and re-reading it later would fight the in-memory rotation rather than
  // follow it.
  const stored = await params.get(X_REFRESH_TOKEN_VAR);

  const mount: Mount = {
    slug: X_SLUG,
    tree: "x-twitter",
    serverName: "pulsemcp-x-twitter-mcp-server",
    capabilities: { tools: {} },
    degraded: null,
    // The client caches its OAuth provider for the host process, so the factory
    // is built once here and memoised inside registerHandlers. Building it
    // LAZILY matters: `createXClientFromEnv` throws when no X credential is
    // configured at all, and a throw at boot would take all twenty-two mounts down
    // over one unconfigured server.
    register: (s) =>
      created.registerHandlers(s, () =>
        x.createXClientFromEnv(process.env, {
          refreshToken: stored,
          onRefreshToken: async (token: string) => {
            try {
              await params.put(X_REFRESH_TOKEN_VAR, token);
              if (mount.degraded) {
                mount.degraded = null;
                log(
                  `${X_SLUG}: refresh-token persistence recovered (mount is no longer degraded)`,
                );
              }
            } catch (err) {
              // LOUD, AND STILL SERVING. The token in memory is good for the
              // life of this process, so refusing to serve would be a
              // self-inflicted outage — but the NEXT restart now comes back
              // holding a credential X has already invalidated, and that is
              // exactly the thing nothing would otherwise notice until it broke.
              mount.degraded =
                `${X_REFRESH_TOKEN_VAR} could not be persisted: ${errMessage(err)} ` +
                `— this process is fine, the next restart will not be`;
              logError(
                X_SLUG,
                `${mount.degraded}. Check that the strad config lists ` +
                  `${X_REFRESH_TOKEN_VAR} under paramsWritable: for this server, ` +
                  `and that core can reach its parameter store.`,
              );
            }
          },
        }),
      ),
  };
  return mount;
}

/**
 * telegram — strad's own Telegram server, over MTProto with a USER session.
 *
 * MOUNTED EVEN WITH NO CREDENTIALS, degraded. Its three variables are a real
 * person's Telegram login, and a deployment that has not injected them yet
 * should still be able to SEE the tool surface — in the console, and from an
 * agent's tools/list — rather than lose the slug entirely. Every call then fails
 * with an error naming the three variables. Same posture as remote-filesystem,
 * and for the same reason: one server's missing config must not cost the other
 * twenty-one their boot.
 *
 * ONE INSTANCE PER SLUG. `telegram-ro` and `telegram-rw` are two strad slugs, and
 * for as long as they were two names for one mount they were also one MTProto
 * connection built from one set of credentials — the factory memoises it for the
 * life of the process. A second account therefore needs a second INSTANCE, not
 * merely a second variable, which is why this takes a slug and reads its own view
 * of the environment.
 */
const TELEGRAM_MARKER_NAMES = [
  "TELEGRAM_API_ID",
  "TELEGRAM_API_HASH",
  "TELEGRAM_STRING_SESSION",
];

async function loadTelegram(slug: string): Promise<Mount> {
  const mod = (await loadFromTree("telegram", "shared/build/index.js")) as {
    createMCPServer: Factory;
    missingCredentials: (env?: NodeJS.ProcessEnv) => string[];
  };

  const env = slugEnvView(process.env, slug);
  const created = mod.createMCPServer({ version: VERSION, env });
  const missing = mod.missingCredentials(env);

  return {
    slug,
    tree: "telegram",
    serverName: "strad-telegram",
    capabilities: { tools: {} },
    degraded: missingCredentialsDegraded(missing),
    register: (s) => created.registerHandlers(s),
  };
}

/**
 * bill-spend — strad's own BILL Spend & Expense server: re-codes card
 * transactions to the right chart-of-accounts value.
 *
 * MOUNTED EVEN WITH NO CREDENTIAL, degraded, for the same reason as telegram and
 * remote-filesystem: the token is a real company's admin credential, and a
 * deployment that has not injected it yet should still be able to SEE the tool
 * surface rather than lose the slug. Every call then fails with an error naming
 * the variable.
 *
 * ONE MOUNT, not one per slug. `bill-spend-ro` and `bill-spend-rw` are two strad
 * slugs pointing here, differing only in what the gateway's `tools:` policy lets
 * them call — one BILL token is one company, so unlike telegram there is no
 * second ACCOUNT a second instance would serve.
 */
async function loadBillSpend(): Promise<Mount> {
  const mod = (await loadFromTree("bill-spend", "shared/build/index.js")) as {
    createMCPServer: Factory;
    missingCredentials: (env?: NodeJS.ProcessEnv) => string[];
  };

  const env = slugEnvView(process.env, "bill-spend");
  const created = mod.createMCPServer({ version: VERSION, env });

  return {
    slug: "bill-spend",
    tree: "bill-spend",
    serverName: "strad-bill-spend",
    capabilities: { tools: {} },
    degraded: missingCredentialsDegraded(mod.missingCredentials(env)),
    register: (s) => created.registerHandlers(s),
  };
}

/**
 * As much of the secrets tree's config as this host reads back.
 *
 * Structural rather than imported: the tree is loaded at runtime out of
 * `/app/trees`, so there is no type to import at build time. It mirrors
 * `SecretsConfig` in servers/secrets/shared/src/config.ts.
 */
interface SecretsTreeConfig {
  stores: {
    project: string;
    viewerKeyVar: string;
    account: { client_email: string } | null;
    /** Why `account` is null, by SHAPE. Absent when the variable is just unset. */
    credentialError?: string;
  }[];
}

/**
 * secrets. Not mounted when it is not configured — the same posture as
 * 1Password: one server's missing config must not take the other twenty down.
 *
 * ONE MOUNT, N STORES. `loadConfig()` reads `SECRETS_STORES` when the config
 * declares `mcpStores:` and falls back to the single-store `SECRETS_PROJECT_ID`
 * reading otherwise; either way this host hands the whole config through and the
 * tree does the per-store work.
 */
async function loadSecrets(): Promise<Mount | null> {
  const mod = (await loadFromTree("secrets", "shared/build/index.js")) as {
    createMCPServer: Factory;
    loadConfig: (env?: NodeJS.ProcessEnv) => SecretsTreeConfig;
  };

  let config: SecretsTreeConfig;
  try {
    config = mod.loadConfig();
  } catch (err) {
    logWarn(
      `secrets NOT mounted: ${errMessage(err)}. ` +
        `It needs SECRETS_STORES, or SECRETS_PROJECT_ID and SECRETS_NAMESPACES; ` +
        `an unscoped secrets server would see every parameter in the project.`,
    );
    return null;
  }

  // The gateway re-read: the agent's copy of the console's "Re-read the store"
  // button. This process can reach core — it already does, for the parameter
  // write-back — and the secrets tree cannot, so the hook is built here and
  // handed in. Handed in only when it can work: with no core URL or no token
  // (a local run, the CI smoke container) the tool is not offered, the same
  // posture as a tool the credential cannot back.
  const refresh = createStoreRefreshClient({
    baseUrl: process.env[CORE_URL_ENV],
    token: process.env.STRAD_INTERNAL_TOKEN,
  });
  const unconfigured = refresh.unconfigured();
  if (unconfigured) {
    log(`secrets: refresh_gateway not offered (${unconfigured})`);
  }
  const created = mod.createMCPServer({
    version: VERSION,
    config,
    refreshGateway: unconfigured ? undefined : () => refresh.refresh(),
  });
  // PER STORE, because one container may front several. A store with no
  // credential degrades that store and not the mount: its siblings still list,
  // read and (where their own credential allows) write. Naming the variable is
  // the whole point of the message — with N stores, "the key is missing" without
  // saying WHICH key is not an actionable sentence.
  const unusable = config.stores.filter((store) => !store.account);

  return {
    slug: "secrets",
    tree: "secrets",
    serverName: "secrets-mcp-server",
    capabilities: { tools: {} },
    degraded:
      unusable.length === 0
        ? null
        : `${unusable
            .map((store) =>
              store.credentialError
                ? `${store.credentialError} (store "${store.project}")`
                : `${store.viewerKeyVar} is not set (store "${store.project}")`,
            )
            .join("; ")}. Tools will list, and calls against ` +
          `${unusable.length === 1 ? "that store" : "those stores"} will fail; ` +
          `every other store answers normally.`,
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
    // in a 21-server container that would be an outage caused by one server's
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
 * with twenty other servers on board, `process.exit(1)` is no longer a
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
      startBackgroundLogin: (
        onFail: (e: Error) => void,
        onRecovered?: () => void,
      ) => void;
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
    // good-eggs retries its login on the next tool call, so `degraded` here is a
    // report on the LAST attempt, not a verdict. It has to be cleared when an
    // attempt succeeds — otherwise /healthz keeps naming a mount that is serving.
    geCreated.startBackgroundLogin(
      (error: Error) => {
        geMount.degraded = `login failed: ${error.message}`;
        logWarn(
          `good-eggs: ${geMount.degraded} (this mount is degraded; the container keeps serving, and the next tool call retries the login)`,
        );
      },
      () => {
        geMount.degraded = null;
        log("good-eggs: login recovered on retry (mount is no longer degraded)");
      },
    );
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
      startBackgroundLogin: (
        onFail: (e: Error) => void,
        onRecovered?: () => void,
      ) => void;
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
    // fetchpet retries its login on the next tool call, so `degraded` here is a
    // report on the LAST attempt, not a verdict. It has to be cleared when an
    // attempt succeeds — otherwise /healthz keeps naming a mount that is serving.
    fpCreated.startBackgroundLogin(
      (error: Error) => {
        fpMount.degraded = `login failed: ${error.message}`;
        logWarn(
          `fetchpet: ${fpMount.degraded} (this mount is degraded; the container keeps serving, and the next tool call retries the login)`,
        );
      },
      () => {
        fpMount.degraded = null;
        log("fetchpet: login recovered on retry (mount is no longer degraded)");
      },
    );
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

  const mounts = await buildMounts();

  // A rotated credential reaching a RUNNING container, for the servers whose
  // config asked for it. Started after the mounts so it can say, per slug,
  // whether the mount it refreshes will actually observe the new value; returns
  // null (and logs nothing) on every deployment that set no `paramsRefresh:`,
  // which is all of them by default.
  const refresh = startParamRefresh({ mounts });
  // One pass at boot, so a value rotated between the last render and this start
  // is current sooner than a whole interval away.
  //
  // NOT AWAITED, and that is deliberate. A pass is one sequential read per
  // listed variable, each with its own timeout, so awaiting it would put a slow
  // or unreachable core directly in front of `listen()` below — twenty-two
  // mounts held off serving because one credential could not be re-read. The
  // container starting with the value the deploy baked is exactly the behaviour
  // every deployment has today, so falling back to it costs nothing; blocking
  // readiness on it would cost everything.
  void refresh?.runOnce().catch((err: unknown) => {
    logWarn(`initial parameter refresh failed: ${errMessage(err)}`);
    return [];
  });

  const app = express();
  app.disable("x-powered-by");

  // The gate every MCP mount below sits behind: the shared STRAD_INTERNAL_TOKEN
  // core presents on each proxied request, compared the way `/_strad/presence`
  // already compares it, fail-closed when the token is unset. See
  // `internal-auth.ts` for why "internal_ports: [8080]" was never the answer.
  const internalOnly = requireInternalToken(process.env, timingSafeEqual);

  // Liveness for App Platform. Reports every mount and whether it is degraded —
  // with 22 servers behind one health check, "ok: true" alone is not information.
  //
  // Deliberately OUTSIDE `internalOnly`. The platform's health prober holds no
  // token, and a 401 here is a component App Platform takes out of service — an
  // authorization fix that costs availability. It names slugs and paths and no
  // credential, which is what makes leaving it open affordable.
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
    if (!mount.upload) continue;
    app.post(
      `/${mount.slug}/upload/:token`,
      internalOnly,
      express.raw({ type: "*/*", limit: "100mb" }),
      (req, res) => {
        void mount
          .upload!(
            req.params.token,
            Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
          )
          .then((result) => {
            const text = result.content.map((c) => c.text).join("\n");
            res
              .status(result.isError ? 400 : 200)
              .type("application/json")
              .send(text);
          })
          .catch((err) => {
            logError(mount.slug, err);
            if (!res.headersSent) res.status(500).json(jsonRpcError(err));
          });
      },
    );
  }

  // Gmail attachments, GCS uploads and document bodies are big; the 100kb default
  // would truncate them into confusing protocol errors. Keep this AFTER the raw
  // upload routes so JSON artifacts are stored as bytes rather than parsed away.
  app.use(express.json({ limit: "20mb" }));

  // Presence, for the console that cannot see this process.
  //
  // A supplementary image's `env:` is resolved at deploy time and injected onto
  // THIS component — core never receives it (appspec.ts, consoleEnvVars). So
  // "is ${SLACK_BOT_TOKEN} plumbed?" is a question only this process can answer,
  // and until it did, strad's console printed a shrug for the whole fleet.
  //
  // It answers with the five words in presence.ts and nothing else: no value, no
  // length, no prefix, no hash. Behind the same internal token core already
  // presents to proxy /mcp here, and fail-closed when that token is unset.
  //
  // The route itself is `presenceResponse`, in the module vendored from core
  // (`npm run presence:sync`): core's console is the only caller and this image
  // is the server every deployment actually runs, so the wiring is one
  // implementation rather than two. What stays here is what only this process
  // knows — when it booted, and the version to report when the deploy baked no
  // STRAD_VERSION.
  app.post(PRESENCE_ROUTE, (req, res) => {
    const answer = presenceResponse({
      authorization: req.get("authorization"),
      body: req.body,
      env: process.env,
      bootedAt: BOOTED_AT,
      image: VERSION,
      timingSafeEqual,
    });
    res.status(answer.status).set(answer.headers).json(answer.body);
  });

  // Every mount, behind the internal token. `internalOnly` runs before the
  // handler rather than as `app.use`, so the two routes above it — `/healthz`
  // and `/_strad/presence` — keep the treatment each already had: one open, one
  // authorized inside `presenceResponse` with the same comparator and the same
  // two statuses. Double-gating presence would only change which of two
  // identical refusals a caller reads.
  for (const mount of mounts) {
    if (mount.sessionful) {
      const { post, session } = sessionfulHandler(mount);
      app.post(`/${mount.slug}`, internalOnly, (req, res) => void post(req, res));
      app.get(`/${mount.slug}`, internalOnly, (req, res) => void session(req, res));
      app.delete(`/${mount.slug}`, internalOnly, (req, res) => void session(req, res));
    } else {
      app.all(`/${mount.slug}`, internalOnly, statelessHandler(mount));
    }
  }

  // One stray rejection from one of twenty-two servers must not kill the other
  // twenty-one. The standalone images exit here (correct, when the process IS the
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
