#!/usr/bin/env node
/**
 * bundle — THE strad supplementary image. All 32 upstream MCP servers (32
 * mounts, see `buildMounts`), one container, one process, one Chromium, one
 * mcp-grafana child. The gateway's config names more SLUGS than that — 41
 * supplementary-image entries in infra/strad.staging.yaml — because capability
 * variants (gmail-ro, gmail-rw, …) are several slugs pointing at ONE mount here.
 * `/aws-device-farm` is the one that runs the other way round: it is mounted
 * here and named by no slug yet, because its credential is not seeded. `/ssh`
 * is named by none BY DESIGN: every SSH host is its own store-served instance
 * at `/_instance/ssh/{slug}`, and the conventional mount is the degraded one.
 *
 * THIRTY-TWO IS THE FLOOR, not a constant. Seven trees (telegram,
 * remote-filesystem, google-sheets, gmail, google-docs, grafana, onepassword)
 * mount ONE INSTANCE PER SLUG the environment carries per-slug values for — see
 * `extraSlugs` — so a container told about `telegram-ro` and `telegram-rw`
 * separately serves /telegram, /telegram-ro and /telegram-rw. google-sheets,
 * gmail, google-docs, grafana and onepassword are
 * the cases a real deployment uses: an OAuth refresh token IS one Google account,
 * a service-account token IS one Grafana, and a 1Password service-account token
 * IS one 1Password account at one vault scope, so each extra account is another
 * mount here. The conventional path is always mounted, so a config that asks for
 * none of this sees exactly the thirty-two it saw before.
 *
 * STORE-SERVED INSTANCES are the other way in, and the one that needs no deploy.
 * A strad server on `path: /_instance/{tree}/{slug}` puts nothing on this
 * container: this process asks core which instances it should run
 * (`createInstanceReconciler`, vendored from strad's src/secrets/param-route.ts),
 * fetches each one's own namespace through core, and builds a telegram,
 * google-sheets, grafana or ssh instance from exactly those values. They are served
 * at their instance path, listed on /healthz, and kept in step on an interval —
 * and on the first request for one this process does not hold yet, which is what
 * makes a slug created at runtime servable on that request.
 *
 * THIRTY-NINE of those are on one component. The other two each run this same
 * image on a component of their own. `zimmer-secrets` is one, and what makes it
 * one is the SLUG rather than the store: a second entitlement and a second
 * console page. `whatsapp-zimmer` is the other, on `bundle-whatsapp`, because
 * the one linked-device socket must open in exactly one container at one
 * instance (see `loadWhatsApp`); it renders no component while disabled. A
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
 * BLAST RADIUS, honestly. Thirty-two servers share a process. A crash is
 * a 32-server outage, not a 1-server outage. Everything below that CAN be made
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
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

import { getSharedBrowser, closeSharedBrowser, browserIsUp, browserLaunchCount } from "./browser.js";
import { prefixedEnvName, slugEnvView } from "./env-prefix.js";
import { requireInternalToken } from "./internal-auth.js";
import { errMessage, log, logError, logWarn } from "./log.js";
import {
  dropInheritedNames,
  extraSlugs,
  instanceEnv,
  missingCredentialsDegraded,
  onePasswordConfirmsWrites,
  remoteFilesystemDegraded,
  scrubCapabilityEnv,
} from "./mounts.js";
import { PRESENCE_ROUTE, presenceResponse } from "./presence.js";
import { paramStoreFor, startParamRefresh } from "./param-store.js";
import {
  CORE_URL_ENV,
  createInstanceClient,
  createInstanceReconciler,
  createStoreRefreshClient,
  INSTANCE_PATH_PREFIX,
  instancePath,
  instanceSyncSeconds,
  type InstanceTree,
} from "./param-route.js";
import { startTailnet } from "./tailnet.js";
import { loadFromTree, treeSdk, type TreeName } from "./trees.js";
import {
  WATCHDOG_DEFAULTS,
  createWatchdog,
  heapBootLine,
  watchdogExitAfterMs,
  type WatchdogState,
} from "./watchdog.js";

/** Two decimals, for a 0..1 figure in a log line or a health body. */
function round(n: number): number {
  return Math.round(n * 100) / 100;
}

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
  handleDownload?: (token: string) => Promise<DownloadOutcome>;
  close?: () => Promise<void>;
}

/**
 * What a mount answers when a signed download link is presented.
 *
 * The body is a live stream, never a Buffer: the route below pipes it, so an
 * attachment of any size costs this process a fixed amount of memory.
 */
type DownloadOutcome =
  | {
      ok: true;
      filename: string;
      contentType: string;
      contentLength?: number;
      body: ReadableStream<Uint8Array>;
    }
  | { ok: false; status: number; error: string };

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
  /** Gateway slugs served at this mount's path besides `slug`; see `RefreshableMount`. */
  servedAs?: readonly string[];
  /** Optional non-MCP upload endpoint exposed beside this mount. */
  upload?: (token: string, body: Buffer) => Promise<{
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
  }>;
  /**
   * Optional non-MCP download endpoint exposed beside this mount — the mirror
   * of `upload`, and the other half of the same idea: bytes that are too big,
   * or too binary, to travel inside a tool result cross the boundary over plain
   * HTTP instead. The mount decides whether the presented token is good.
   */
  download?: (token: string) => Promise<DownloadOutcome>;
  /**
   * Where this mount is served, when that is not `/${slug}`. Set only on a
   * store-served instance, whose path is `/_instance/{tree}/{slug}`.
   */
  path?: string;
  /**
   * Release what the mount holds — a child process, a connection. Called when a
   * store-served instance is replaced by a rebuild or removed.
   */
  close?: () => Promise<void>;
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
    download: api.slack.handleDownload,
    // The MCP Events ingest (fork/slack/src/events): one Socket Mode socket and
    // a sealed buffer in strad's shared state store, opened only where
    // SLACK_APP_TOKEN, SLACK_EVENTS_STATE_ENCRYPTION_KEY and STRAD_STATE_GCS_*
    // are set. Inert everywhere else. `close` flushes
    // the buffer on SIGTERM; `events/list` and `events/poll` are registered
    // by the tree's own `registerHandlers`.
    close: api.slack.close,
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
    // Its auth manager reads MONARCH_COOKIE and MONARCH_SESSION_TOKEN out of
    // `process.env` on EVERY request, so a cookie `paramsRefresh:` re-reads is
    // used by the next call with no restart.
    liveEnv: true,
    servedAs: [
      "monarch-money-readwrite",
      "monarch-money-readonly",
      monarchCookieSlug(),
    ],
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

  mounts.push(await loadWhatsApp());

  mounts.push(await loadBillSpend());

  mounts.push(await loadAwsDeviceFarm());

  mounts.push(await loadLiveOak());

  // ssh: one instance per HOST, and ONLY as a store-served instance (see
  // INSTANCE_BUILDERS). The conventional `/ssh` lists the tools and can never
  // connect: it is handed no environment at all, so no baked variable on this
  // container can credential it — and there is no per-slug discovery either,
  // because a slug the environment conjures is one the runtime roster could
  // alias, and who may reach a shell is the checked-in config's call alone.
  mounts.push(await loadSsh("ssh", {}));

  // Three API-key servers, one credential each and one mount each. Read-only
  // and read-write variants are separate slugs on the same path, told apart by
  // the gateway's `tools:` policy.
  mounts.push(await loadKeyedApiServer("airtable", "strad-airtable"));
  mounts.push(await loadKeyedApiServer("flightaware", "strad-flightaware"));
  mounts.push(await loadKeyedApiServer("digitalocean", "strad-digitalocean"));

  mounts.push(...(await loadImageTools()));
  mounts.push(await loadNutritionFacts());

  // --- bundle-google: gmail / calendar / docs / sheets ------------------------
  // calendar builds its server per request. Its service-account client is built
  // per call; its `GOOGLE_CALENDAR_AUTH_MODE=oauth` client is cached per
  // credential inside the tree, which reads `process.env`, so this host passes
  // nothing for either mode. gmail, google-docs and google-sheets cache their
  // CLIENT per credential,
  // because a client built per request would re-authenticate to Google on every
  // tool call.
  const google = await loadGoogleTree();

  // gmail is the SECOND server in this tree whose credential can be per slug,
  // and one of three with two auth modes (google-docs and calendar are the
  // others; only calendar's mode is named rather than inferred). The conventional `/gmail` keeps
  // serving the service-account credential the `gmail-ro` / `gmail-rw` /
  // `gmail-rw-external` slugs are entitled to; each slug the environment carries
  // an OAuth CLIENT for gets its own mount, holding one person's mailbox.
  //
  // Discovery is on the OAuth app pair rather than the refresh token for the
  // reason spelled out over google-sheets below: the token is minted after the
  // deploy, by a human clicking Connect on the slug's console page, and that
  // page only exists once the slug is mounted.
  mounts.push(loadGmail(google.gmail, "gmail", false));
  for (const slug of extraSlugs(
    "gmail",
    google.gmail.GMAIL_OAUTH_APP_ENV_NAMES,
  ))
    deferred.push({ slug, load: async () => loadGmail(google.gmail, slug, true) });

  mounts.push({
    slug: "google-calendar",
    tree: "bundle-google",
    serverName: "google-calendar-workspace-mcp-server",
    capabilities: { tools: {} },
    register: async (s) => {
      await google.calendar({ version: VERSION }).registerHandlers(s);
    },
  });

  // google-docs has gmail's shape exactly: two auth modes, a conventional
  // service-account mount the `google-docs-ro` / `-rw` / `-rw-external` slugs
  // share, and one per-slug mount per Google account an `oauth:` connector
  // seeds an OAuth client for. Discovered on the app pair for the same reason.
  mounts.push(loadGoogleDocs(google.docs, "google-docs", false));
  for (const slug of extraSlugs(
    "google-docs",
    google.docs.GOOGLE_DOCS_OAUTH_APP_ENV_NAMES,
  ))
    deferred.push({
      slug,
      load: async () => loadGoogleDocs(google.docs, slug, true),
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
  // per call. A service-account token IS one 1Password account at one scope, so
  // each slug the environment carries its own token for gets its own mount at
  // `/<slug>`, beside the conventional `/onepassword`. See `loadOnePassword`.
  const op = await loadOnePasswordTree();
  mounts.push(loadOnePassword(op, "onepassword", false));
  for (const slug of extraSlugs("onepassword", ONEPASSWORD_MARKER_NAMES))
    deferred.push({ slug, load: async () => loadOnePassword(op, slug, true) });

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

/**
 * The env var naming the GATEWAY slug this image's `/slack` mount is served as.
 *
 * WHY IT CANNOT BE DERIVED. Every other per-mount URL in this host is built from
 * `mount.slug`, which works because those mounts' slug and `path:` are the same
 * word. Slack is the exception in the fleet: prod serves `slack`, `slack-readonly`
 * and `slack-zimmer` — three slugs, two workspaces, two containers — all at
 * `path: /slack`. This process knows it is serving `/slack` and cannot know which
 * of the three the gateway is routing to it, so the deployment has to say.
 *
 * UNSET FALLS BACK TO `slack`, which is right for the shared bundle and wrong
 * for `bundle-slack-zimmer`: links there would be addressed to the OTHER
 * container. That misrouting is a broken download either way, but it is a clean
 * one — `deriveKey` also folds in a fingerprint of this mount's bot token, so
 * the receiving container refuses the signature with a 403 instead of accepting
 * it and then failing obscurely against a file id its workspace never had.
 */
const SLACK_PUBLIC_SLUG_VAR = "SLACK_PUBLIC_SLUG";

/** The variable monarch's session cookie lives in, on the box and in the store. */
const MONARCH_COOKIE_VAR = "MONARCH_COOKIE";

/**
 * The env var naming the GATEWAY slug whose namespace monarch's cookie is
 * persisted to — the one that lists `MONARCH_COOKIE` under `paramsWritable:`.
 *
 * It cannot be derived, for slack's reason: `monarch-money-readwrite` and
 * `monarch-money-readonly` are two slugs at one `path: /monarch-money`, one
 * mount and one `process.env`. The cookie is ONE value for both, so it is
 * written to one slug's namespace and the other reads the same environment.
 * Unset falls back to `monarch-money-readwrite`, the slug that carries the
 * manage tools.
 */
const MONARCH_COOKIE_SLUG_VAR = "MONARCH_COOKIE_SLUG";

function monarchCookieSlug(): string {
  return process.env[MONARCH_COOKIE_SLUG_VAR]?.trim() || "monarch-money-readwrite";
}

function slackDownloadConfig():
  | {
      publicSlug: string;
      publicBaseUrl: string;
      internalToken: string;
      workspaceToken: string;
    }
  | undefined {
  const publicBaseUrl = process.env.STRAD_PUBLIC_URL;
  const internalToken = process.env.STRAD_INTERNAL_TOKEN;
  const workspaceToken = process.env.SLACK_BOT_TOKEN;

  // The first two are rendered onto every bundle component by
  // `src/deploy/appspec.ts`, so their absence means this image is running
  // outside a strad deployment. The third is the mount's own credential, and
  // without it there is nothing to download from either. In all three cases the
  // tool says downloads are unavailable rather than minting a dead URL.
  const missing = !publicBaseUrl
    ? "STRAD_PUBLIC_URL"
    : !internalToken
      ? "STRAD_INTERNAL_TOKEN"
      : !workspaceToken
        ? "SLACK_BOT_TOKEN"
        : undefined;
  if (missing || !publicBaseUrl || !internalToken || !workspaceToken) {
    logWarn(
      `slack: ${missing} is not set; ` +
        `slack_download_file will report that attachments cannot be served`,
    );
    return undefined;
  }

  const publicSlug = process.env[SLACK_PUBLIC_SLUG_VAR] || "slack";
  log(`slack: download links will be minted for gateway slug "${publicSlug}"`);
  return { publicSlug, publicBaseUrl, internalToken, workspaceToken };
}

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
    createMCPServer: (opts: Record<string, unknown>) => Created & {
      auth: { warm: () => Promise<void> };
    };
    createFileSessionStore: () => unknown;
  };

  // A cookie set at runtime (`set_session_cookie`, or a session Monarch
  // re-issues) is written back through core to THIS slug's own namespace —
  // `paramsWritable: [MONARCH_COOKIE]` is the fence, and core refuses a slug or
  // a name the config did not list. See monarchCookieSlug for why the slug is
  // configured rather than derived.
  const cookieSlug = monarchCookieSlug();
  const cookieParams = paramStoreFor(cookieSlug);
  const monarchCreated = monarchMod.createMCPServer({
    version: VERSION,
    sessionStore: monarchMod.createFileSessionStore(),
    persistCookie: (cookie: string) => cookieParams.put(MONARCH_COOKIE_VAR, cookie),
    persistTarget: `the strad parameter store (${cookieSlug} / ${MONARCH_COOKIE_VAR})`,
  });
  // Warm a headless login in the BACKGROUND: it is a real network call, and a
  // slow login must not delay the other mounts' readiness. Never throws.
  void monarchCreated.auth.warm();

  return {
    slack: slack.createMCPServer({ version: VERSION, download: slackDownloadConfig() }),
    serpapi: serpapi.createMCPServer({
      version: VERSION,
      apiKey: process.env.SERPAPI_API_KEY,
    }),
    tailscale: tailscale.createMCPServer({ version: VERSION }),
    monarch: monarchCreated,
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

/**
 * strad's own layer over the vendored gmail tree
 * (`images/bundle-google/src/gmail.ts`). Same shape as
 * {@link GoogleSheetsModule}, plus the one thing sheets has no need of: a list
 * that spans BOTH of gmail's auth modes.
 */
interface GmailModule {
  createMCPServer: Factory;
  missingCredentials: (env: Record<string, string | undefined>) => string[];
  /**
   * Every variable that decides WHICH MAILBOX a mount reads — the OAuth three
   * AND the service-account three. No mount needs all six; this is the set the
   * marker pair is subtracted from to get what a discovered slug may not
   * inherit, and for that it has to span both modes. See `dropInheritedNames`.
   */
  GMAIL_ENV_NAMES: readonly string[];
  /**
   * The OAuth app pair, and the marker set per-slug discovery keys on — the two
   * variables a human seeds before consent. What it leaves out is every
   * per-account name, which is why the host derives those by subtraction rather
   * than naming them here.
   */
  GMAIL_OAUTH_APP_ENV_NAMES: readonly string[];
}

/**
 * strad's own layer over the vendored google-docs tree
 * (`images/bundle-google/src/docs.ts`). {@link GmailModule}'s shape, for
 * gmail's reason: two auth modes on one container, so the drop list spans both.
 */
interface GoogleDocsModule {
  createMCPServer: Factory;
  missingCredentials: (env: Record<string, string | undefined>) => string[];
  /** Both modes' variables — what the marker pair is subtracted from. */
  GOOGLE_DOCS_ENV_NAMES: readonly string[];
  /** The OAuth app pair, and the marker set per-slug discovery keys on. */
  GOOGLE_DOCS_OAUTH_APP_ENV_NAMES: readonly string[];
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
function loadGrafana(
  mod: GrafanaModule,
  slug: string,
  // A store-served instance passes the environment core served it. Every other
  // caller reads this slug's view of the container.
  env: Record<string, string | undefined> = slugEnvView(process.env, slug),
): Mount {
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
  // The child is this mount's; a rebuilt or removed instance must not leave it
  // running against the credential it was replaced for.
  mount.close = () => created.close();
  return mount;
}

interface GoogleTree {
  gmail: GmailModule;
  calendar: Factory;
  docs: GoogleDocsModule;
  sheets: GoogleSheetsModule;
}

async function loadGoogleTree(): Promise<GoogleTree> {
  // NOT `vendor/gmail-shared/build/index.js`. That tree is forked from
  // pulsemcp/mcp-servers and reads `process.env` directly, which is right
  // for the one-server-per-process deployment it was written for and fatal here:
  // several gmail mounts in one process would all serve the last credential
  // loaded. `dist/gmail.js` is strad's own layer over it — the injected env, the
  // two credential modes, and the name lists discovery keys on — built from
  // images/bundle-google/src/gmail.ts by that image's own `npm run build`.
  const gmail = await loadFromTree<GmailModule>(
    "bundle-google",
    "dist/gmail.js",
  );
  const calendar = await loadFromTree<{ createMCPServer: Factory }>(
    "bundle-google",
    "vendor/google-calendar-shared/build/index.js",
  );
  // `dist/docs.js`, not the vendored tree, for gmail's reason: the tree reads
  // `process.env`, and several docs mounts in one process need an injected env.
  const docs = await loadFromTree<GoogleDocsModule>(
    "bundle-google",
    "dist/docs.js",
  );
  const sheets = await loadFromTree<GoogleSheetsModule>(
    "bundle-google",
    "vendor/google-sheets-shared/build/index.js",
  );
  return {
    gmail,
    calendar: calendar.createMCPServer,
    docs,
    sheets,
  };
}

/**
 * gmail: the conventional mount, plus one mount per Google ACCOUNT the
 * environment carries an OAuth app for.
 *
 * TWO AUTH MODES ON ONE CONTAINER, which is what makes this different from
 * google-sheets and is the whole reason this function is careful.
 *
 *   - The CONVENTIONAL `/gmail` mount is a SERVICE ACCOUNT with domain-wide
 *     delegation, impersonating one Workspace user. `gmail-ro`, `gmail-rw` and
 *     `gmail-rw-external` are three strad slugs over it, differing only by the
 *     gateway's `tools:` policy. It reads the bare names, exactly as it always
 *     has, and this change does not touch what it serves.
 *   - A DISCOVERED mount is a PERSON: an OAuth refresh token minted by that
 *     person, for that account, through the console consent flow an `oauth:`
 *     connector puts on the slug's own page. A refresh token is one account by
 *     construction, so each account is another mount here.
 *
 * WHY THE DROP IS NOT OPTIONAL. `slugEnvView` falls back to the bare name for
 * anything a slug has no name of its own for, and for sheets the worst case of
 * that is a mount holding another Google account's spreadsheets token. Here the
 * worst case is bigger: an unconnected `gmail-personal-ro` would fall back to
 * `GMAIL_SERVICE_ACCOUNT_*` + `GMAIL_IMPERSONATE_EMAIL`, which are on this box
 * for the conventional mount — and serve Tadas's WORK mailbox under a slug named
 * for his personal account, with `missingCredentials()` reporting nothing wrong
 * and every call succeeding. So a discovered slug reads every per-account name
 * from its own prefix or not at all; the subtraction below is where that is
 * decided, and the tree owns both lists so it stays true when a fourth name
 * joins either mode.
 *
 * The READ/WRITE half of a slug's name is NOT decided here. This mount serves
 * all nine tools and strad's gateway withholds from a `-ro` slug
 * (src/gateway/toolPolicy.ts) — the same trade every capability variant in this
 * container makes. A deployment that wants Google to enforce it too can consent
 * the `-ro` slug for `gmail.readonly` alone; because the credential is per slug,
 * that costs nothing here.
 *
 * THE ENV IS A SNAPSHOT, taken here, and that is the same trade google-sheets
 * makes for the same reason: a live view of `process.env` is what makes two
 * instances of one tree in one process stop being independent. The cost is that
 * this mount is not `liveEnv`, so a `paramsRefresh:` value landing in the
 * environment does not reach it until a restart — which is what leaving that
 * flag unset already tells `startParamRefresh` to warn about, and no config
 * declares `paramsRefresh:` on a gmail slug today.
 */
function loadGmail(gmail: GmailModule, slug: string, perSlug: boolean): Mount {
  const view = slugEnvView(process.env, slug);
  if (perSlug) {
    const app = new Set<string>(gmail.GMAIL_OAUTH_APP_ENV_NAMES);
    dropInheritedNames(
      view,
      slug,
      gmail.GMAIL_ENV_NAMES.filter((name) => !app.has(name)),
    );
  }
  const env = {
    ...view,
    // WHERE TO GO WHEN THE TOKEN DIES — same as google-sheets, same reason:
    // `invalid_grant` is the normal end of a refresh token's life and the
    // recovery is one button on this slug's own console page.
    ...(process.env.STRAD_PUBLIC_URL
      ? {
          GMAIL_RECONNECT_URL: `${process.env.STRAD_PUBLIC_URL.replace(/\/$/, "")}/ui/${slug}`,
        }
      : {}),
  };
  // The tree owns what its credential IS, and which mode this environment is in.
  const missing = gmail.missingCredentials(env);

  return {
    slug,
    tree: "bundle-google",
    serverName: "gmail-workspace-mcp-server",
    capabilities: { tools: {} },
    // Degraded, not unmounted: the tools must still LIST, so the console shows
    // the slug and an agent can see what it would offer once a token lands —
    // and a slug has to be mounted for its console page to offer the Connect
    // button that mints one.
    degraded: missingCredentialsDegraded(missing),
    register: async (s) => {
      await gmail.createMCPServer({ version: VERSION, env }).registerHandlers(s);
    },
  };
}

/**
 * google-docs: the conventional service-account mount, plus one mount per Google
 * ACCOUNT the environment carries an OAuth app for.
 *
 * {@link loadGmail} line for line, and for the same reason: the conventional
 * `/google-docs` mount impersonates a Workspace user through
 * `GOOGLE_DOCS_SERVICE_ACCOUNT_*` + `GOOGLE_DOCS_IMPERSONATE_EMAIL` under bare
 * names, so an unconnected `google-docs-personal-ro` that inherited them would
 * serve the Workspace user's documents under a slug named for a personal
 * account, with every call succeeding. A discovered slug reads every
 * per-account name from its own prefix or not at all.
 *
 * The `-ro` / `-rw` / `-rw-external` half of a slug's name is the gateway's
 * `tools:` policy, not this mount: it serves all eleven tools.
 */
function loadGoogleDocs(
  docs: GoogleDocsModule,
  slug: string,
  perSlug: boolean,
): Mount {
  const view = slugEnvView(process.env, slug);
  if (perSlug) {
    const app = new Set<string>(docs.GOOGLE_DOCS_OAUTH_APP_ENV_NAMES);
    dropInheritedNames(
      view,
      slug,
      docs.GOOGLE_DOCS_ENV_NAMES.filter((name) => !app.has(name)),
    );
  }
  const env = {
    ...view,
    // WHERE TO GO WHEN THE TOKEN DIES — same as gmail and google-sheets.
    ...(process.env.STRAD_PUBLIC_URL
      ? {
          GOOGLE_DOCS_RECONNECT_URL: `${process.env.STRAD_PUBLIC_URL.replace(/\/$/, "")}/ui/${slug}`,
        }
      : {}),
  };
  const missing = docs.missingCredentials(env);

  return {
    slug,
    tree: "bundle-google",
    serverName: "google-docs-workspace-mcp-server",
    capabilities: { tools: {} },
    degraded: missingCredentialsDegraded(missing),
    register: async (s) => {
      await docs.createMCPServer({ version: VERSION, env }).registerHandlers(s);
    },
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
 * construction, so `google-sheets-personal-*` and `google-sheets-tadas-tadasant-*`
 * cannot share a variable, in the same way `gcs` and the artifact store cannot
 * share GCS_BUCKET.
 *
 * The renderer already solves that: every supplementary server's variables are
 * ALSO baked under its own slug (`GOOGLE_SHEETS_PERSONAL_RO__GOOGLE_SHEETS_OAUTH_REFRESH_TOKEN`),
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
 * eleven tools and strad's gateway withholds the six writes and the share from a
 * `-ro` slug, and the share from a `-rw` one (src/gateway/toolPolicy.ts) — the
 * same trade every other capability variant in
 * this container makes. A deployment that wants Google to enforce it too can seed
 * the `-ro` slug a token consented only for `spreadsheets.readonly`; because the
 * credential is per slug, that costs nothing here.
 */
function loadGoogleSheets(
  sheets: GoogleSheetsModule,
  slug: string,
  perSlug: boolean,
  // A store-served instance's environment, which holds its own namespace and no
  // bare name at all — so there is nothing for it to inherit, and the drop below
  // has nothing to do.
  served?: Record<string, string | undefined>,
): Mount {
  const view = served ?? slugEnvView(process.env, slug);
  // A DISCOVERED slug's ACCOUNT is its own or it has none. Everything the OAuth
  // app pair is not is the per-account half of the credential — the refresh token
  // — and a slug that has not been connected yet must not inherit a bare one from
  // whichever server put it on the box. See `dropInheritedNames`. The conventional
  // mount is the bare names' owner, so it keeps reading them.
  if (perSlug && !served) {
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
 * namespace it reads and writes: `/strad/{env}/mcp/x-twitter/{kind}/`.
 *
 * This host never names the kind. Core resolves it from its own config:
 * `oauth/` when the x-twitter server also declares X_OAUTH_REFRESH_TOKEN on an
 * `oauth:` connector (the console consent minted it there), `static/` when it
 * does not. The route this calls carries only the slug and the variable.
 *
 * A CONSTANT, not `mount.slug` threaded through, because the two are the same
 * string for a reason: a strad `supplementary-image` server's `path:` is what
 * selects a mount in this image, and `paramsWritable:` is declared on that same
 * config entry. If x-twitter ever grows per-slug instances (as telegram and
 * remote-filesystem have), each instance's store handle has to be built from its
 * own slug — the write-back is per SERVER, and two X accounts are two
 * credentials.
 *
 * `x-twitter-rw` is NOT such an instance. It is a capability twin: same bundle,
 * same path, so this one mount, this one client and this slug's namespace. One
 * account is one token, and the schema's one-writer-per-mount rule keeps the
 * twin from declaring a second copy of it.
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
    // configured at all, and a throw at boot would take all thirty-two mounts down
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
 * thirty their boot.
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

async function loadTelegram(
  slug: string,
  // A store-served instance passes the environment core served it.
  env: Record<string, string | undefined> = slugEnvView(process.env, slug),
): Promise<Mount> {
  const mod = (await loadFromTree("telegram", "shared/build/index.js")) as {
    createMCPServer: Factory;
    missingCredentials: (env?: NodeJS.ProcessEnv) => string[];
  };

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
 * whatsapp — strad's own WhatsApp server, and the long-lived WhatsApp client
 * behind it: ONE linked device, paired by code through its own tool.
 *
 * MOUNTED IN EVERY CONTAINER, CONNECTED IN AT MOST ONE. The tree's factory
 * opens a socket only when its four variables are present, and a component's
 * environment is its own servers' `env:` maps — so the container a
 * `path: /whatsapp` slug is bundled onto connects, and every other container
 * running this image lists the seven tools degraded and never touches WhatsApp.
 * Two sockets on one linked device kick each other off, which is why the
 * component that holds it must run one instance (the renderer refuses more).
 *
 * ONE MOUNT, not one per slug: one linked device is one account, and a second
 * account wants a second component with its own bucket prefix, not a second
 * instance in this process.
 *
 * `close` is what the shutdown path calls, so a deploy's SIGTERM flushes the
 * Signal state to GCS before the process exits. `download` serves the links
 * `whatsapp_get_attachment` mints, addressed to the gateway slug named by
 * `WHATSAPP_PUBLIC_SLUG` — every WhatsApp slug is `path: /whatsapp`, so, as
 * with slack's, the slug cannot be derived here.
 */
async function loadWhatsApp(): Promise<Mount> {
  const mod = (await loadFromTree("whatsapp", "shared/build/index.js")) as {
    createMCPServer: (options: { version: string; env: NodeJS.ProcessEnv }) => Created & {
      close: () => Promise<void>;
      handleDownload: (token: string) => Promise<DownloadOutcome>;
    };
    missingCredentials: (env?: NodeJS.ProcessEnv) => string[];
  };

  const env = slugEnvView(process.env, "whatsapp");
  const created = mod.createMCPServer({ version: VERSION, env });

  return {
    slug: "whatsapp",
    tree: "whatsapp",
    serverName: "strad-whatsapp",
    capabilities: { tools: {} },
    degraded: missingCredentialsDegraded(mod.missingCredentials(env)),
    register: (s) => created.registerHandlers(s),
    // whatsapp_get_attachment's single-use links land here, through core's
    // `/mcp-download/:slug/:token`. The tree verifies the token, fetches and
    // decrypts the file from WhatsApp, and stores nothing.
    download: created.handleDownload,
    close: () => created.close(),
  };
}

/**
 * How each store-served instance tree is built from what core served it.
 *
 * The loaders named here already take an injected environment, which is the
 * whole qualification: an instance is a second copy of a tree inside this one
 * process, and only a tree that reads its credential out of what it is handed
 * can be one. `instanceEnv` is what it is handed — the served namespace plus a
 * few non-credential process variables, and never a bare name from the
 * container. The trees are loaded out of `/app/trees` on first use; the module
 * cache makes every later build free.
 *
 * A `Record` over `InstanceTree`, so a tree added to the vendored list and not
 * given a builder here fails the build rather than a request.
 */
const INSTANCE_BUILDERS: Record<
  InstanceTree,
  (slug: string, served: Record<string, string>) => Promise<Mount>
> = {
  telegram: (slug, served) => loadTelegram(slug, instanceEnv(served)),
  grafana: async (slug, served) =>
    loadGrafana(await loadGrafanaTree(), slug, instanceEnv(served)),
  "google-sheets": async (slug, served) =>
    loadGoogleSheets((await loadGoogleTree()).sheets, slug, true, instanceEnv(served)),
  ssh: (slug, served) => loadSsh(slug, instanceEnv(served)),
};

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
 * airtable, flightaware, digitalocean — strad's own servers over three plain
 * HTTPS APIs, each run on one static key (`AIRTABLE_API_KEY`,
 * `AEROAPI_API_KEY`, `DIGITALOCEAN_API_TOKEN`).
 *
 * One loader because the three are the same shape as bill-spend and differ only
 * in the tree: the env view is the mount's, so `<SLUG>__<NAME>` is read ahead of
 * the bare name; the key is read on each call rather than at boot; and with no
 * key the mount is degraded rather than dropped, so its tools still list and
 * every call fails naming the variable.
 */
async function loadKeyedApiServer(
  tree: "airtable" | "flightaware" | "digitalocean",
  serverName: string,
): Promise<Mount> {
  const mod = (await loadFromTree(tree, "shared/build/index.js")) as {
    createMCPServer: Factory;
    missingCredentials: (env?: NodeJS.ProcessEnv) => string[];
  };

  const env = slugEnvView(process.env, tree);
  const created = mod.createMCPServer({ version: VERSION, env });

  return {
    slug: tree,
    tree,
    serverName,
    capabilities: { tools: {} },
    degraded: missingCredentialsDegraded(mod.missingCredentials(env)),
    register: (s) => created.registerHandlers(s),
  };
}

/**
 * aws-device-farm — strad's own AWS Device Farm server: puts a build on a REAL
 * iPhone, drives it over the remote-access session's Appium endpoint, and pulls
 * back the artifacts a run records.
 *
 * MOUNTED EVEN WITH NO CREDENTIAL, degraded, for the same reason as bill-spend
 * and telegram: the tool surface still lists, so the console and an agent can
 * see what this deployment WOULD offer, and every call fails with an error
 * naming the variable.
 *
 * ONE MOUNT, and the state it holds is the reason it is built once rather than
 * per request. The module keeps one WebDriver session per live phone, and
 * establishing one RELAUNCHES the app under test — so a mount rebuilt per
 * request would turn an agent's sequence of taps into a sequence of cold
 * starts.
 */
async function loadAwsDeviceFarm(): Promise<Mount> {
  const mod = (await loadFromTree(
    "aws-device-farm",
    "shared/build/index.js",
  )) as {
    createMCPServer: Factory;
    missingCredentials: (env?: NodeJS.ProcessEnv) => string[];
  };

  const env = slugEnvView(process.env, "aws-device-farm");
  const created = mod.createMCPServer({ version: VERSION, env });

  return {
    slug: "aws-device-farm",
    tree: "aws-device-farm",
    serverName: "strad-aws-device-farm",
    capabilities: { tools: {} },
    degraded: missingCredentialsDegraded(mod.missingCredentials(env)),
    register: (s) => created.registerHandlers(s),
  };
}

/**
 * liveoak — strad's own LiveOak Bank server: lists and fetches account
 * statements, read-only, logging in as a remembered device whose keys are
 * sealed in GCS.
 *
 * MOUNTED EVEN WITH NO CREDENTIAL, degraded, for the same reason as bill-spend:
 * the tool surface still lists, and every call fails with an error naming the
 * variables.
 *
 * ONE MOUNT, built once, because the module holds state between calls that a
 * per-request build would lose: an enrolment waiting for its MFA code, a login
 * reused for a few minutes, and each statement's bytes until its link is
 * spent. `download` serves the links `get_statement` mints, addressed to the
 * gateway slug named by `LIVEOAK_PUBLIC_SLUG`.
 */
async function loadLiveOak(): Promise<Mount> {
  const mod = (await loadFromTree("liveoak", "shared/build/index.js")) as {
    createMCPServer: (options: { version: string; env: NodeJS.ProcessEnv }) => Created & {
      handleDownload: (token: string) => Promise<DownloadOutcome>;
    };
    missingCredentials: (env?: NodeJS.ProcessEnv) => string[];
  };

  const env = slugEnvView(process.env, "liveoak");
  const created = mod.createMCPServer({ version: VERSION, env });

  return {
    slug: "liveoak",
    tree: "liveoak",
    serverName: "strad-liveoak",
    capabilities: { tools: {} },
    degraded: missingCredentialsDegraded(mod.missingCredentials(env)),
    register: (s) => created.registerHandlers(s),
    download: created.handleDownload,
  };
}

/**
 * image-diff and svg-tracer — strad's own image servers: compare two images
 * and cluster what differs, and trace a bitmap to SVG. TWO MOUNTS, ONE TREE:
 * they are separate MCP servers (separate slugs, separate grants) that share a
 * guarded fetcher and one worker gate, so this loads the module once and builds
 * both from it.
 *
 * Inputs are http(s) URLs, not paths — the npx packages these replace read the
 * agent's own disk, which a mount in this container cannot. The fetch refuses
 * private and link-local addresses, which matters more here than anywhere: this
 * process can reach every other component on the app's private network.
 *
 * No credential, so never degraded. The pixel work runs in a worker thread per
 * call, one call at a time across both mounts, so a large diff neither stalls
 * the other mounts' event loop nor doubles its own memory peak.
 */
async function loadImageTools(): Promise<Mount[]> {
  const mod = (await loadFromTree("image-tools", "shared/build/index.js")) as {
    createMCPServer: (
      kind: "image-diff" | "svg-tracer",
      options: { version: string; env: NodeJS.ProcessEnv },
    ) => Created;
  };

  return (["image-diff", "svg-tracer"] as const).map((slug) => {
    const created = mod.createMCPServer(slug, { version: VERSION, env: process.env });
    return {
      slug,
      tree: "image-tools",
      serverName: `strad-${slug}`,
      capabilities: { tools: {} },
      register: (s) => created.registerHandlers(s),
    };
  });
}

/**
 * nutrition-facts — strad's own nutrition evidence server: USDA FoodData
 * Central and MenuStat from data files baked into this image, FatSecret live.
 *
 * NEVER DEGRADED FOR A MISSING CREDENTIAL. Every credential it reads is
 * optional: without FatSecret's it answers from the local data and reports
 * FatSecret `unavailable` in every result. What DOES degrade it is a missing
 * data file — an image built wrong — because then every local lookup fails.
 *
 * ONE MOUNT, built once: the factory holds the parsed data, FatSecret's token,
 * both response caches and the daily call counter, all of which a per-request
 * build would throw away.
 */
async function loadNutritionFacts(): Promise<Mount> {
  const mod = (await loadFromTree("nutrition-facts", "shared/build/index.js")) as {
    createMCPServer: Factory;
    missingDataFiles: (dir?: string) => string[];
  };

  const env = slugEnvView(process.env, "nutrition-facts");
  const created = mod.createMCPServer({ version: VERSION, env });
  // The same directory the server reads: NUTRITION_FACTS_DATA_DIR, else the tree's own.
  const missing = mod.missingDataFiles(env.NUTRITION_FACTS_DATA_DIR?.trim() || undefined);

  return {
    slug: "nutrition-facts",
    tree: "nutrition-facts",
    serverName: "strad-nutrition-facts",
    capabilities: { tools: {} },
    degraded: missing.length
      ? `local data file${missing.length === 1 ? "" : "s"} ${missing.join(", ")} missing from the image; USDA and MenuStat lookups will fail`
      : null,
    register: (s) => created.registerHandlers(s),
  };
}

/**
 * ssh — strad's own SSH server: break-glass command execution and SFTP on ONE
 * host, authenticated by a private key from the store, against a pinned host
 * key and nothing else.
 *
 * ONE INSTANCE PER HOST, because a host is an identity in the way a Telegram
 * login is: its address, its account, its key and its pin belong together and
 * must never be completed from a sibling's. A store-served instance is handed
 * its own namespace and nothing else (`instanceEnv`). Nothing here reads
 * `process.env` for this tree — not the bare names, not prefixed ones.
 *
 * MOUNTED EVEN WITH NO CREDENTIAL, degraded, like bill-spend: the tools list,
 * `ssh_connection_info` says what is missing, and every other call fails naming
 * the variables — without opening a connection.
 *
 * BUILT ONCE PER SLUG and holding nothing between calls: each tool call opens
 * its own connection and closes it, so there is no standing session on a
 * production host inside this shared process.
 */
async function loadSsh(
  slug: string,
  // The environment core served a store-served instance, or `{}` for the
  // conventional mount. Never a view of this process's environment.
  env: Record<string, string | undefined>,
): Promise<Mount> {
  const mod = (await loadFromTree("ssh", "shared/build/index.js")) as {
    createMCPServer: (options: {
      version: string;
      label: string;
      env: NodeJS.ProcessEnv;
    }) => Created;
    missingCredentials: (env?: NodeJS.ProcessEnv) => string[];
  };

  const created = mod.createMCPServer({ version: VERSION, label: slug, env });

  return {
    slug,
    tree: "ssh",
    serverName: "strad-ssh",
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

/** The variable that IS a 1Password mount's account, and what discovers a per-slug one. */
const ONEPASSWORD_TOKEN_VAR = "OP_SERVICE_ACCOUNT_TOKEN";
const ONEPASSWORD_MARKER_NAMES = [ONEPASSWORD_TOKEN_VAR];

/** The one per-slug posture a 1Password mount takes; see `onePasswordConfirmsWrites`. */
const ONEPASSWORD_WRITE_POSTURE_VAR = "OP_ELICITATION_WRITE";

interface OnePasswordTree {
  /** Built once: only its `registerHandlers` is used, onto each request's server. */
  server: {
    registerHandlers: (server: unknown, factory: () => unknown) => Promise<void>;
  };
  OnePasswordClient: new (token: string) => object;
  confirm: {
    withConfirmation: <S extends object>(
      server: S,
      options: { confirmWrites?: boolean; label?: string },
    ) => S;
    guardWrites: <T extends object>(client: T) => T;
    forceAskEverything: (env?: NodeJS.ProcessEnv) => string[];
  };
}

/**
 * Load the tree once, and pin the vendored tools' posture to "always ask".
 *
 * The vendored tools read whether to ask from `process.env`, which every
 * 1Password mount in this process shares, so a bare
 * `DANGEROUSLY_SKIP_ELICITATIONS=true` from any one slug would switch the prompt
 * off for all of them. Instead the tools always ask, and strad's own layer
 * (`remote/src/confirm.ts` in the onepassword tree) decides per mount whether
 * that question goes to the calling session's human or, for a write on a mount
 * that does not confirm writes, is answered here.
 */
async function loadOnePasswordTree(): Promise<OnePasswordTree> {
  const mod = (await loadFromTree("onepassword", "shared/build/index.js")) as {
    createMCPServer: (opts: { version: string }) => OnePasswordTree["server"];
    OnePasswordClient: OnePasswordTree["OnePasswordClient"];
  };
  const confirm = (await loadFromTree(
    "onepassword",
    "remote/build/confirm.js",
  )) as OnePasswordTree["confirm"];
  const overridden = confirm.forceAskEverything(process.env);
  if (overridden.length > 0) {
    logWarn(
      `onepassword: ignoring ${overridden.join(", ")} — strad confirms every ` +
        `1Password reveal through the calling session, and a write unless the ` +
        `slug sets <SLUG>__${ONEPASSWORD_WRITE_POSTURE_VAR}=false. A container-wide ` +
        `value would apply to every 1Password mount in this process at once.`,
    );
  }
  return {
    server: mod.createMCPServer({ version: VERSION }),
    OnePasswordClient: mod.OnePasswordClient,
    confirm,
  };
}

/**
 * 1Password: one mount per SERVICE-ACCOUNT TOKEN.
 *
 * A token is one 1Password account at one vault scope, so `onepassword-tadas-all`
 * and `onepassword-pulsemcp-rw` cannot share a variable any more than two Google
 * accounts can. The renderer bakes each supplementary server's variables under
 * its own slug as well (`ONEPASSWORD_TADAS_ALL__OP_SERVICE_ACCOUNT_TOKEN`), and a
 * slug on `path: /<its own slug>` is mounted here holding exactly that token.
 * The conventional `/onepassword` keeps the bare token, which is what slugs
 * sharing that path read.
 *
 * A DISCOVERED slug's token is its own or it has none. It never inherits the
 * bare one: that is a different account's credential, and a mount serving it
 * under this slug's name would answer for the wrong vaults with nothing failing.
 *
 * WHO IS ASKED. Every reveal (`onepassword_get_item` on an item with a sensitive
 * field) is put to the human attached to the calling session, through the
 * channel core forwards to a `confirmations: true` slug. Every write is too,
 * unless this slug sets `OP_ELICITATION_WRITE=false` under its own name, which is
 * the provisioning posture. A call that needs a human and has none to ask is
 * refused before it runs. See `servers/confirmations.md` in the docs.
 */
function loadOnePassword(op: OnePasswordTree, slug: string, perSlug: boolean): Mount {
  // Read per CALL, not once: a `paramsRefresh:` rotation lands in this
  // process's environment, and the next `op` run should use it.
  const tokenNow = (quiet = true): string | undefined => {
    const view = slugEnvView(process.env, slug);
    if (perSlug) dropInheritedNames(view, slug, ONEPASSWORD_MARKER_NAMES, process.env, quiet);
    return view[ONEPASSWORD_TOKEN_VAR] || undefined;
  };
  const token = tokenNow(false);

  const confirmWrites = onePasswordConfirmsWrites(slug, perSlug);
  if (!confirmWrites) {
    logWarn(
      `${slug}: 1Password WRITES run without asking anyone ` +
        `(${prefixedEnvName(slug, ONEPASSWORD_WRITE_POSTURE_VAR)}=false). ` +
        `Reveals still ask the calling session.`,
    );
  }

  return {
    slug,
    tree: "onepassword",
    serverName: "onepassword-mcp-server",
    capabilities: { resources: {}, tools: {} },
    degraded: missingCredentialsDegraded(token ? [] : [ONEPASSWORD_TOKEN_VAR]),
    liveEnv: true,
    register: (s) =>
      op.server.registerHandlers(
        op.confirm.withConfirmation(s as object, { confirmWrites, label: "1Password" }),
        () => op.confirm.guardWrites(new op.OnePasswordClient(tokenNow() ?? "")),
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
  // BEFORE the mounts: it removes the tailnet key from `process.env`, which a
  // conventional mount would otherwise read along with everything else. Null,
  // and nothing started, unless the renderer gave this component `tailnet:`.
  const tailnet = startTailnet();

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
  // or unreachable core directly in front of `listen()` below — thirty-two
  // mounts held off serving because one credential could not be re-read. The
  // container starting with the value the deploy baked is exactly the behaviour
  // every deployment has today, so falling back to it costs nothing; blocking
  // readiness on it would cost everything.
  void refresh?.runOnce().catch((err: unknown) => {
    logWarn(`initial parameter refresh failed: ${errMessage(err)}`);
    return [];
  });

  // STORE-SERVED INSTANCES — the mounts no deploy named. See the header.
  //
  // The first sync is NOT awaited, for the reason the refresh pass above is
  // not: a slow core must not stand in front of `listen()` for thirty-two
  // mounts that need nothing from it. A request that arrives before the sync
  // lands takes the miss path in the route below, which syncs then.
  const instances = createInstanceReconciler<Mount>({
    client: createInstanceClient({
      baseUrl: process.env[CORE_URL_ENV],
      token: process.env.STRAD_INTERNAL_TOKEN,
      // The renderer names each component after its bundle, so this is the
      // bundle core routes this process's instances to.
      bundle: process.env.STRAD_COMPONENT,
    }),
    build: async (tree, slug, served) => {
      const mount = await INSTANCE_BUILDERS[tree](slug, served);
      // Set on the object the loader returned rather than on a copy: grafana's
      // loader keeps a reference and writes `degraded` onto it later.
      mount.path = instancePath(tree, slug);
      return mount;
    },
    dispose: (mount) => mount.close?.(),
    note: (level, message) => (level === "warn" ? logWarn : log)(message),
  });
  void instances.sync();
  // Unref'd: an interval must never be what keeps a container alive.
  setInterval(() => void instances.sync(), instanceSyncSeconds(process.env) * 1000).unref();

  // Started before the routes, so `/healthz` always has a state to report. The
  // exit is late-bound to `shutdown`, defined further down.
  let wedgedExit: (state: WatchdogState) => void = () => {};
  const watchdog = createWatchdog({
    saturation: WATCHDOG_DEFAULTS.saturation,
    unhealthyAfterMs: WATCHDOG_DEFAULTS.unhealthyAfterMs,
    exitAfterMs: watchdogExitAfterMs(process.env),
    onWedged: (state) => wedgedExit(state),
    onUnhealthy: (state) =>
      logWarn(
        `event loop saturated for ${Math.round(state.saturatedMs / 1000)}s ` +
          `(utilization ${round(state.utilization)}); /healthz now answers 503`,
      ),
  });
  const stopWatchdog = watchdog.start(WATCHDOG_DEFAULTS.intervalMs);
  log(heapBootLine());

  const app = express();
  app.disable("x-powered-by");

  // The gate every MCP mount below sits behind: this component's own
  // STRAD_INTERNAL_TOKEN, which core presents on each proxied request, compared
  // the way `/_strad/presence` already compares it, fail-closed when the token
  // is unset. See
  // `internal-auth.ts` for why "internal_ports: [8080]" was never the answer.
  const internalOnly = requireInternalToken(process.env, timingSafeEqual);

  // Liveness for App Platform. Reports every mount and whether it is degraded —
  // with 32 servers behind one health check, "ok: true" alone is not information.
  //
  // Deliberately OUTSIDE `internalOnly`. The platform's health prober holds no
  // token, and a 401 here is a component App Platform takes out of service — an
  // authorization fix that costs availability. It names slugs and paths and no
  // credential, which is what makes leaving it open affordable.
  //
  // 503 once the watchdog has seen the event loop saturated for a minute, so the
  // rendered `liveness_health_check` restarts a wedged container. A probe that
  // never gets an answer fails the same way. See `watchdog.ts`.
  app.get("/healthz", (_req, res) => {
    const loop = watchdog.state();
    res.status(loop.unhealthy ? 503 : 200).json({
      ok: !loop.unhealthy,
      component: "bundle",
      version: VERSION,
      loop: {
        utilization: round(loop.utilization),
        saturatedSeconds: Math.round(loop.saturatedMs / 1000),
        heapUsedMB: Math.round(loop.heapUsed / 2 ** 20),
        heapLimitMB: Math.round(loop.heapLimit / 2 ** 20),
      },
      chromium: { up: browserIsUp(), launches: browserLaunchCount() },
      // Reported, never folded into `ok`: a tailnet that will not come up costs
      // the tailnet hosts, and a liveness restart would cost every mount.
      ...(tailnet ? { tailnet: tailnet.state() } : {}),
      servers: [
        ...[
          ...mounts,
          ...[...instances.held().values()].map((held) => held.value),
        ].map((m) => ({
          slug: m.slug,
          path: m.path ?? `/${m.slug}`,
          ...(m.degraded ? { degraded: m.degraded } : {}),
        })),
        // Listed by core and NOT built — its credentials could not be read, or
        // its build threw. Reported at its path as degraded, so core's mount
        // health sees a broken instance rather than one it has never heard of.
        ...[...instances.unbuilt()].map(([slug, { tree, reason }]) => ({
          slug,
          path: instancePath(tree, slug),
          degraded: `not built: ${reason}`,
        })),
      ],
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

  // The download half, mirroring the upload routes above. Registered in the same
  // place and for the same reason: it carries BYTES rather than JSON, so it must
  // be in front of any body parser.
  //
  // NO `express.raw` HERE — a GET has no body to read, and the RESPONSE is what
  // streams. `pipeline` is what makes that true end to end: it propagates
  // backpressure from the socket back to Slack, and destroys the source if the
  // caller hangs up, so a 500MB attachment nobody finishes downloading does not
  // go on being fetched into a process that has stopped reading it.
  for (const mount of mounts) {
    if (!mount.download) continue;
    app.get(`/${mount.slug}/download/:token`, internalOnly, (req, res) => {
      void mount
        .download!(req.params.token)
        .then(async (outcome) => {
          if (!outcome.ok) {
            res.status(outcome.status).type("application/json").send({ error: outcome.error });
            return;
          }

          res.status(200);
          res.setHeader("content-type", outcome.contentType);
          if (outcome.contentLength !== undefined) {
            res.setHeader("content-length", String(outcome.contentLength));
          }
          // The filename lives HERE and nowhere else — never in the URL, which
          // would put it in every access log between here and the caller. See
          // the header comment in the fork's `src/download-link.ts`.
          res.setHeader(
            "content-disposition",
            `attachment; filename*=UTF-8''${encodeURIComponent(outcome.filename)}`,
          );
          // Signed, single-use and short-lived: there is nothing here a cache
          // could usefully hold, and a cached copy would outlive the link.
          res.setHeader("cache-control", "no-store");
          // The content type comes from Slack, which took it from whoever
          // uploaded the file. `Content-Disposition: attachment` already stops a
          // browser rendering it, but this origin also serves the SSO'd console,
          // so the sniffing argument is not one worth leaving open.
          res.setHeader("x-content-type-options", "nosniff");

          await pipeline(Readable.fromWeb(outcome.body), res);
        })
        .catch((err: unknown) => {
          logError(mount.slug, err);
          // Headers are already out once the body has begun, so the only honest
          // signal left is to destroy the connection — a truncated response that
          // ended in a clean 200 would look like a complete file.
          if (res.headersSent) res.destroy();
          else res.status(502).json(jsonRpcError(err));
        });
    });
  }

  // Gmail attachments, GCS uploads and document bodies are big; the 100kb default
  // would truncate them into confusing protocol errors.
  //
  // Named and attached PER ROUTE rather than mounted with `app.use`. A global
  // parser runs in stack-registration order, so it would run in front of every
  // mount's `internalOnly` — and an unauthenticated caller would get 20MB of its
  // body read and parsed before being told no. The raw upload routes above make
  // the same point from the other side: JSON artifacts there are stored as bytes
  // rather than parsed away, which is why they had to be registered first.
  const jsonBody = express.json({ limit: "20mb" });

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
  app.post(PRESENCE_ROUTE, jsonBody, (req, res) => {
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

  // Every mount, behind the internal token — and `internalOnly` comes BEFORE
  // `jsonBody`, so an unauthorized request is refused without its body having
  // been read. The gate is attached per route rather than with `app.use` so the
  // two routes above keep the treatment each already had: `/healthz` open for a
  // prober that holds no credential, and `/_strad/presence` authorized inside
  // `presenceResponse` with the same comparator and the same two statuses.
  // Double-gating presence would only change which of two identical refusals a
  // caller reads.
  for (const mount of mounts) {
    if (mount.sessionful) {
      const { post, session } = sessionfulHandler(mount);
      app.post(`/${mount.slug}`, internalOnly, jsonBody, (req, res) => void post(req, res));
      app.get(`/${mount.slug}`, internalOnly, jsonBody, (req, res) => void session(req, res));
      app.delete(`/${mount.slug}`, internalOnly, jsonBody, (req, res) => void session(req, res));
    } else {
      app.all(`/${mount.slug}`, internalOnly, jsonBody, statelessHandler(mount));
    }
  }

  // The store-served instances, behind the same gate. ONE route rather than one
  // per instance, because the set changes under a running process: the lookup
  // happens per request, against whatever the reconciler holds now.
  //
  // A MISS SYNCS, bounded. Core only routes a slug here once its config names
  // it, so a request for an instance this process does not hold is usually a
  // slug created since the last sync — and answering it now, rather than a sync
  // interval later, is what "created at runtime, used on the next request"
  // means. `syncOnMiss` refuses to start a second sync inside its floor, so a
  // caller hammering a path nothing serves costs core one list call per floor.
  app.all(`${INSTANCE_PATH_PREFIX}/:tree/:slug`, internalOnly, jsonBody, (req, res) => {
    const find = (): Mount | undefined => {
      const held = instances.held().get(req.params.slug ?? "");
      return held && held.tree === req.params.tree ? held.value : undefined;
    };
    void (async () => {
      let mount = find();
      if (!mount) {
        await instances.syncOnMiss();
        mount = find();
      }
      if (!mount) {
        res.status(404).json({
          error: "instance_not_served",
          message:
            `this component serves no store-served instance at ${req.path}. ` +
            `Core has not routed one here, or its credentials could not be read.`,
        });
        return;
      }
      await statelessHandler(mount)(req, res);
    })().catch((err: unknown) => {
      logError("instance", err);
      if (!res.headersSent) res.status(500).json({ error: "instance_failed" });
    });
  });

  // One stray rejection from one of thirty-two servers must not kill the other
  // thirty. The standalone images exit here (correct, when the process IS the
  // server); this one logs.
  process.on("unhandledRejection", (reason) => {
    logError("unhandledRejection", reason);
  });

  // Once only. SIGTERM from a liveness restart and the watchdog's own exit tend
  // to land together on a wedged loop, and a second pass would run every
  // `close()` twice at once, whatsapp's GCS flush included.
  let shuttingDown = false;
  const shutdown = (signal: string, code = 0): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    stopWatchdog();
    log(`received ${signal}, closing mounts and Chromium, then exiting`);
    // A mount with `close` holds state worth saving — whatsapp flushes its
    // Signal state to GCS here. Bounded, because App Platform escalates a
    // slow exit to SIGKILL and a hung close must not cost the rest.
    const closing = Promise.allSettled([
      ...mounts.map((m) => m.close?.()),
      // Logs the ephemeral node out, so it leaves the tailnet now rather than
      // when the control plane notices it went quiet.
      tailnet?.stop(),
    ]);
    const bounded = Promise.race([
      closing,
      new Promise((resolve) => setTimeout(resolve, 5_000).unref()),
    ]);
    void bounded
      .then(() => closeSharedBrowser())
      .finally(() => process.exit(code));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // The exit half of the watchdog. Non-zero, so App Platform restarts the
  // container: a fresh process serves every slug again in about a minute, where
  // a thrashing one served none of them for as long as nobody looked. The
  // close is the same bounded one SIGTERM gets, so whatsapp still flushes.
  wedgedExit = (state) => {
    logError(
      "watchdog",
      `event loop saturated for ${Math.round(state.saturatedMs / 1000)}s ` +
        `(utilization ${round(state.utilization)}, heap ` +
        `${Math.round(state.heapUsed / 2 ** 20)} of ` +
        `${Math.round(state.heapLimit / 2 ** 20)} MB). Exiting so the ` +
        `container restarts; see tadasant/strad#458.`,
    );
    // NOT unref'd, and outside the bounded close: Chromium's teardown is not
    // bounded, a thrashing process runs it late, and no SIGKILL follows an
    // exit nobody asked for. Whatever the close does, the process is gone in 15s.
    setTimeout(() => process.exit(1), 15_000);
    shutdown("watchdog", 1);
  };

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
