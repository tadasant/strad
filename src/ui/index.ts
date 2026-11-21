import express, { type Express, type Request, type Response } from "express";
import type { ConsoleTokenStore } from "../auth/console-tokens.ts";
import type { ConsoleSessions } from "../auth/session.ts";
import type { RuntimeConfig } from "../config/runtime.ts";
import { mountServersUi } from "./servers.ts";
import type { Flash } from "./servers-page.ts";
import type { StradConfig } from "../config/schema.ts";
import { asyncRoute } from "../http/async-route.ts";
import type { SecretBag } from "../secrets/index.ts";
import {
  consolePrincipal,
  refuseTokenSession,
  requireConsoleUi,
  signedInLabel,
} from "./console-auth.ts";
import { createGcsLister, GcsError, type GcsLister } from "./gcs-client.ts";
import {
  cachedProbe,
  NO_CAPABILITIES,
  normalisePathPrefix,
  parameterId,
  ParameterStoreError,
  UnreadablePayloadError,
  normaliseNamespace,
  validateNamespace,
  validatePathPrefix,
  validateVariableName,
  variableOf,
  type Capabilities,
  type ParameterListing,
  type ParameterMeta,
  type ParameterResolver,
  type ParameterStore,
} from "../secrets/parameters/index.ts";
import { DeadlineError } from "../util/deadline.ts";
import { errorSummary, errorText } from "../util/error-text.ts";
import { event } from "../telemetry/index.ts";
import type { BundlePresence } from "../gateway/bundle-presence.ts";
import type { Registry } from "../gateway/registry.ts";
import { mountApps } from "./apps.ts";
import { mountPlayground } from "./playground.ts";
import { renderLanding } from "./landing.ts";
import {
  resolveServerView,
  secretsPages,
  type SecretsStore,
  type ServerView,
} from "./resolve.ts";
import { resolverConfigured } from "./param-routing.ts";
import { revealPosture } from "./reveal.ts";
import { renderConnectors } from "./roster-page.ts";
import { renderServerOverview } from "./server-overview.ts";
import { originFor, playgroundAccess } from "./playground.ts";
import { entitledServers } from "../gateway/entitlements.ts";
import { forgetConsoleStores, storeFor } from "./store-client.ts";
import { mountTokensConsole } from "./tokens.ts";
import { mountGrantsConsole } from "./grants.ts";
import type { McpOAuth } from "../auth/mcp-oauth/index.ts";
import {
  CONNECTORS_PREFIX,
  SERVER_ROUTE,
  serverConsolePath,
  UI_PREFIX,
} from "./paths.ts";
import {
  connectorFlash,
  mountConnector,
  offersClientRepair,
  renderConnectorPage,
} from "./connector.ts";
import {
  connectorFor,
  grantAuthority,
  isConnectorClientPath,
} from "../connectors/index.ts";
import { upstreamConnectorFor } from "../connectors/upstream.ts";
import {
  renderUpstreamConnectorPage,
  upstreamFlash,
} from "./upstream-connector.ts";
import {
  forgetDeploymentDiagnosis,
  readDeploymentSecretStatus,
} from "./secret-status.ts";
import type { ServerSecretProviders } from "../secrets/provider/index.ts";
import {
  renderGcsBrowse,
  renderMessage,
  renderOffline,
  renderSecrets,
} from "./render.ts";
import { mountPwa } from "./pwa.ts";
import {
  planBulkCreate,
  planIsWritable,
  refillCsv,
  type BulkPlanLine,
  type BulkReport,
  type BulkReportLine,
} from "./bulk-params.ts";

/**
 * Mount the human, SSO-gated console.
 *
 * Routes:
 *   GET  /connectors            — the consolidated servers view: every configured
 *                                 server, what it is scoped to, whether its
 *                                 secrets are seeded, and — where the roster is
 *                                 editable — the controls to change it. Rendered
 *                                 here because it needs the deployment-wide
 *                                 secret-status reading; everything else under
 *                                 the prefix is src/ui/servers.ts.
 *   GET  /ui                    — 302 to /connectors. The roster and the secret
 *                                 status belong on the entries they describe
 *                                 rather than on a destination of their own.
 *   GET  /secrets               — 302 to /connectors, same reasoning applied one
 *                                 move earlier: the secret roster is part of the
 *                                 roster it describes.
 *   GET  /ui/:server            — the per-server page (connector, GCS browser,
 *                                 parameters manager, or the read-only overview
 *                                 every other kind gets — src/ui/server-overview.ts). The
 *                                 parameters manager takes `?project=<gcp id>`:
 *                                 ONE page fronts N parameter stores, each with
 *                                 its own project, namespaces, bounds and admin
 *                                 credential. See consoleStores: in schema.ts.
 *   POST /ui/:server/create     — ┐
 *   POST /ui/:server/bulk       — │ (many creates, one CSV — bulk-params.ts)
 *   POST /ui/:server/rotate     — │ the `secrets` WRITE surface. Humans only.
 *   POST /ui/:server/note       — │ There is no MCP equivalent of any of these,
 *   POST /ui/:server/reveal     — │ and the admin credential that performs them
 *   POST /ui/:server/delete     — ┘ is injected on THIS component alone.
 *
 * This is HUMAN-facing HTML behind the console SSO gate. It is NOT the /mcp
 * agent endpoint and shares no auth with it (see console-auth.ts). Only mounted
 * on the core gateway, alongside /console.
 *
 * WHY THE WRITES ARE SAFE FROM CSRF. The session is an HttpOnly, SameSite=Lax
 * cookie (console-auth.ts). A cross-site form POST does not carry a Lax cookie,
 * so a third-party page cannot drive these endpoints on a signed-in admin's
 * behalf — the request arrives unauthenticated and the gate 401s it.
 *
 * WHY NO SECRET VALUE IS EVER LOGGED. A value appears in exactly two places: the
 * body of a POST (create/rotate), and the one-shot reveal panel. It is never put
 * in a URL (so it cannot reach an access log, a proxy, a Referer header or a
 * bookmark), never interpolated into an error, and never handed to telemetry —
 * strad's telemetry records shape and identity only (src/telemetry/redact.ts),
 * and nothing here calls it.
 */

/** A note may be at most this many bytes (kept small; it is metadata, not prose). */
const MAX_NOTE_BYTES = 4096;

function validateNote(note: string): string | null {
  if (Buffer.byteLength(note, "utf8") > MAX_NOTE_BYTES) {
    return `A note may be at most ${MAX_NOTE_BYTES} bytes.`;
  }
  return null;
}

export interface ConsoleUiOptions {
  config: StradConfig;
  /**
   * strad's own `/mcp` authorization server, when this deployment runs one.
   * `/tokens/grants` lists and revokes its grant records.
   */
  mcpOAuth?: McpOAuth | null;
  /**
   * The mounted servers, for the playground.
   *
   * The console renders from the CONFIG everywhere else — what a server is
   * scoped to and whether its secrets are seeded are both config questions. The
   * playground asks the only question config cannot answer ("what does this
   * thing actually serve, right now"), and that needs the adapters.
   */
  registry: Registry;
  /** The same injected secret bag the registry resolves ${refs} against. */
  secrets: SecretBag;
  env: NodeJS.ProcessEnv;
  /** Override the GCS listing surface. Defaults to the real JSON-API client. */
  gcsList?: GcsLister;
  /** Override the parameter store. Defaults to the real Parameter/Secret Manager client. */
  parametersStore?: (
    view: Extract<ServerView, { kind: "secrets" }>,
    store: SecretsStore,
  ) => ParameterStore;
  /**
   * Override the capability probe. Defaults to asking Google what the console's
   * service account may do (src/secrets/parameters/capabilities.ts).
   *
   * Tests inject this to drive the four flag/credential combinations without a
   * network, which is the only way to cover the fail-closed paths.
   */
  capabilities?: (
    view: Extract<ServerView, { kind: "secrets" }>,
    store: SecretsStore,
  ) => Promise<Capabilities>;
  /**
   * The RUNTIME secret provider — the same one the router resolves `${NAME}` with.
   *
   * The index asks it whether each referenced name resolves. It is the
   * right seam rather than the boot bag alone because it is the only one that can
   * answer for a store-backed deployment, where a name lives in the parameter
   * store and never in `process.env`. Absent, the index falls back to the bag,
   * which is exactly correct under the `env` provider.
   */
  secretProvider?: ServerSecretProviders;
  /**
   * Test seam: the transport the bundle presence probe uses. Defaults to fetch.
   *
   * The probe is what lets this page assert about a secret that lives on a
   * component core is not — see src/gateway/bundle-presence.ts.
   */
  fetchImpl?: typeof fetch;
  /** Test seam: an already-probed bundle report, skipping the transport. */
  presence?: BundlePresence;
  /**
   * Test seam: the store the four-state diagnosis reads. Defaults to
   * `resolverFromEnv(env)`; explicit `null` disables the diagnosis.
   */
  diagnosticStore?: Pick<ParameterStore, "list" | "resolveDetailed"> | null;
  /**
   * The gateway's resolver, for the one read the console's own credential may
   * not make: the token roster `/tokens` rewrites. See src/auth/token-admin.ts.
   * Absent under the `env` provider, where `/tokens` offers no forms anyway.
   */
  resolver?: Pick<ParameterResolver, "renderPath" | "projectId"> | null;
  /** Session sealers, so the gate can verify a Google login (src/auth/session.ts). */
  sessions?: ConsoleSessions | null;
  /** Whether Google sign-in can complete end to end. See resolveConsoleAuth(). */
  googleReady?: boolean;
  /** The console login token store, where token login is live. See resolveConsoleTokens(). */
  consoleTokens?: ConsoleTokenStore | null;
  /** Test seam: the transport a connector's token exchange uses. See ConnectorUiOptions. */
  connectorFetch?: typeof fetch;
  /**
   * The runtime roster holder, when this deployment has one.
   *
   * A getter, because the app this mounts into is rebuilt on every roster
   * change and the holder is what rebuilds it — see AppOptions.runtimeConfig.
   * Absent or returning null means `gateway.configStore:` is off: `/connectors`
   * is still served — the shared nav bar links it from every page — and every
   * route under it answers with the page that says the editor is off.
   */
  runtimeConfig?: () => RuntimeConfig | null;
}

export function mountConsoleUi(app: Express, opts: ConsoleUiOptions): void {
  const gate = requireConsoleUi({
    config: opts.config,
    env: opts.env,
    sessions: opts.sessions,
    googleReady: opts.googleReady,
    consoleTokens: opts.consoleTokens,
  });
  const gcsList = opts.gcsList ?? createGcsLister();

  // The parameter forms are urlencoded. Scoped to /ui so it cannot change how
  // /mcp parses a body.
  const form = express.urlencoded({ extended: false, limit: "64kb" });

  // What makes the console installable: the manifest, the icons, the service
  // worker and its one offline page. These are NOT behind `gate` — they are
  // static brand assets with no slug, identity or config in them, and a browser
  // fetches `<link rel="manifest">` without credentials, so a gated manifest is
  // a 401 and an app nobody can install. See src/ui/pwa.ts for what the worker
  // is allowed to cache, which is these paths and nothing else.
  mountPwa(app, { offlineHtml: renderOffline() });

  // The front door: a splash carrying the endpoint to paste into an MCP client
  // and the doors into the console. Behind the SAME gate as every other console
  // surface: strad requires Google identity before exposing anything, and even
  // the count of what this gateway fronts is something. Once
  // GOOGLE_CLIENT_ID/SECRET land, this is tadasant.com-only SSO with no further
  // change here — the gate resolves a Principal and this route only ever asks
  // whether it got one.
  app.get("/", gate, (req, res) => {
    const host = req.get("host");
    res.type("html").send(
      renderLanding({
        config: opts.config,
        consoleMounted: true,
        signedInAs: signedInLabel(res),
        // Only used when gateway.publicUrl is unset. `trust proxy` is on, so
        // this is the public hostname, not the container's own host:port.
        requestOrigin: host ? `${req.protocol}://${host}` : undefined,
      }),
    );
  });

  // The consolidated servers view. `asyncRoute` (src/http/async-route.ts), here
  // and on every other console route: Express 4 does not catch a rejected async
  // handler, so an unexpected error becomes a 500 page rather than a hung
  // request — and, in this process, rather than an exit. `renderUnexpected` is
  // passed in rather than reached for, which is what keeps this page's wording
  // separate from the connector's (see the note on that function).
  //
  // It is registered here rather than in src/ui/servers.ts because the page is
  // the secret roster as much as it is the connector roster, and the reading
  // behind that is this module's. `renderRoster` below is the same render, handed
  // to the write paths so a refusal re-draws the page it was made from.
  const renderRoster = (
    req: Request,
    res: Response,
    flash?: Flash,
    status = 200,
  ): Promise<void> => handleConnectors(req, res, opts, flash, status);

  app.get(
    CONNECTORS_PREFIX,
    gate,
    asyncRoute((req, res) => renderRoster(req, res), renderUnexpected),
  );

  // The roster and the per-server secret status live on `/connectors`, on the
  // entries they describe. This redirect exists because the URL was published —
  // bookmarks, an earlier PWA `start_url`, the docs — and a 404 for a page whose
  // content simply moved teaches nobody anything. Exact-path, so `/ui/:server`
  // and `/ui/oauth/callback` are untouched: the per-server pages are unmoved and
  // the OAuth redirect URI is registered with Google.
  //
  // Behind the gate rather than in front of it so an anonymous request still
  // 401s: an open redirect to a gated page is not a leak, but a door that
  // answers differently to an anonymous caller is one fewer thing to reason
  // about.
  app.get(UI_PREFIX, gate, (_req, res) => {
    res.redirect(302, CONNECTORS_PREFIX);
  });

  // `/playground/:server` and its two POST routes. Same gate, same process, and
  // deliberately NOT under `/ui/:server` — that path is the per-server resource
  // browser and its `:server` param already means "a slug with a viewer". See
  // src/ui/playground.ts for how it authenticates without touching either gate.
  mountPlayground(app, gate, { config: opts.config, registry: opts.registry });
  // The console as an MCP Apps host: a server's own `ui://` page, sandboxed.
  // See src/ui/apps.ts.
  mountApps(app, gate, { config: opts.config, registry: opts.registry });

  // Connect / Reconnect Google, for a server whose config declares `oauth:`.
  // Same gate, same process, and its callback lives at a fixed path so the slug
  // is never a thing a browser proposes — see src/ui/connector.ts.
  mountConnector(app, gate, {
    config: opts.config,
    secrets: opts.secrets,
    env: opts.env,
    sessions: opts.sessions,
    parametersStore: opts.parametersStore,
    connectorFetch: opts.connectorFetch,
    runtimeConfig: opts.runtimeConfig,
    afterUpstreamWrite: () => forgetStoreReading(opts),
  });

  // `/tokens` — mint and revoke the credentials /mcp accepts. Same gate, same
  // process, and top-level rather than under `/ui/:server` because it is not
  // about a server: the records belong to the deployment. See src/ui/tokens.ts
  // for why it has no /mcp counterpart.
  mountTokensConsole(app, gate, {
    config: opts.config,
    secrets: opts.secrets,
    env: opts.env,
    secretProvider: opts.secretProvider,
    reader: opts.resolver,
    parametersStore: opts.parametersStore,
  });

  // `/tokens/grants` — the OAuth grants the authorization server holds a
  // record for, and a Revoke on each. See src/ui/grants.ts.
  mountGrantsConsole(app, gate, { oauth: opts.mcpOAuth ?? null });

  // Create / edit / remove a server entry, when this deployment keeps its
  // roster in a store. Mounted at its own top-level prefix rather than under
  // `/ui/:server` — see src/ui/servers.ts for why that wildcard makes `/ui/...`
  // the wrong home for it.
  //
  // ALWAYS mounted, including when there is no runtime holder to edit through.
  // `GET /connectors` answers on every deployment — the roster and the secret
  // status do not depend on a store — and the routes under it answer a
  // store-less gateway with the page that says the editor is off
  // (`unavailable()` there). A thunk that returns null is the shape of "no
  // store", and the handlers already read it that way.
  mountServersUi(app, gate, {
    runtimeConfig: opts.runtimeConfig ?? (() => null),
    env: opts.env,
    // A write re-draws the page it was made from. Passing the render rather
    // than a second, thinner roster is what keeps the flash from landing on a
    // page that disagrees with the one the human was looking at.
    renderRoster: (res, flash, status) =>
      renderRoster(res.req, res, flash, status),
  });

  // The secret roster is on `/connectors`, on the entry it describes, and this
  // URL was published too. Sent straight there rather than through `/ui`: a
  // redirect to a redirect is a hop nobody needs. Same gate, same reasoning as
  // above.
  app.get("/secrets", gate, (_req, res) => {
    res.redirect(302, CONNECTORS_PREFIX);
  });

  app.get(
    SERVER_ROUTE,
    gate,
    asyncRoute(
      (req, res) => handleServerView(req, res, opts, gcsList),
      renderUnexpected,
    ),
  );

  for (const action of [
    "create",
    "bulk",
    "rotate",
    "note",
    "reveal",
    "delete",
    "refresh",
  ] as const) {
    app.post(
      `${SERVER_ROUTE}/${action}`,
      gate,
      // Every action but `refresh` reads a stored value or writes the store,
      // which a login token's session may not do. See refuseTokenSession.
      ...(action === "refresh" ? [] : [refuseTokenSession]),
      form,
      asyncRoute(
        (req, res) => handleSecretAction(action, req, res, opts),
        renderUnexpected,
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// GET /connectors — the consolidated servers view
// ---------------------------------------------------------------------------

/**
 * Read every referenced `${NAME}` once, derive a status per server, render the
 * roster.
 *
 * The reading is `readSecretStatus`, the same call `/api/secrets/readiness`
 * makes. A badge here and a JSON field there derived by two different code paths
 * would eventually disagree, and the endpoint's whole value is that a platform
 * app can trust it says what this page says.
 *
 * `flash` and `status` are what make this the same function the write paths in
 * src/ui/servers.ts return through: a refused save re-renders THIS page with the
 * reason on top, rather than a second roster that would have to be kept in step
 * with it.
 */
async function handleConnectors(
  req: Request,
  res: Response,
  opts: ConsoleUiOptions,
  flash?: Flash,
  status = 200,
): Promise<void> {
  // Absent when this deployment keeps no roster in a store, which takes the
  // editor away and leaves every other half of the page standing.
  const runtime = opts.runtimeConfig?.() ?? null;

  // THE LIVE DOCUMENT, not the one this app was built with. A roster write
  // applies by REBUILDING the app (`gateway.reload()`), and the POST that
  // caused it is still running inside the closure of the app it replaced — so
  // `opts.config` here is the roster as it was BEFORE the write. Rendering that
  // under the write's own flash is the page contradicting itself: "added saved,
  // it is live on this gateway now" over a table with no `added` row, a Disable
  // button on the entry you just disabled, and a removed slug listed as serving
  // and as subtracted at once. The overlay half is read live a few lines down,
  // which is what makes the mismatch visible rather than merely stale.
  const config = runtime?.config() ?? opts.config;

  const { statuses, boot, storeDiagnosis } = await readDeploymentSecretStatus({
    config,
    bag: opts.secrets,
    env: opts.env,
    secretProvider: opts.secretProvider,
    fetchImpl: opts.fetchImpl,
    presence: opts.presence,
    store: opts.diagnosticStore,
  });

  // The origin the request arrived on, used only when `gateway.publicUrl` is
  // unset. `trust proxy` is on, so behind App Platform this is the public
  // hostname rather than the container's own host:port. It is what makes the
  // copied `?servers=` URL pasteable on a deployment that declares no publicUrl
  // — the same fallback the landing page takes.
  const host = req.get("host");

  res
    .status(status)
    .type("html")
    .send(
      renderConnectors({
        config,
        statuses,
        boot,
        storeDiagnosis,
        env: opts.env,
        // The console identity, for the one control on the page that is not a
        // rendering of config: the playground icon. See rowIcons().
        principal: consolePrincipal(res),
        signedInAs: signedInLabel(res),
        requestOrigin: host ? `${req.protocol}://${host}` : undefined,
        ...(runtime?.editable
          ? {
              roster: {
                overlay: runtime.overlay(),
                sources: runtime.sources(),
                writable: runtime.writable,
              },
            }
          : {}),
        ...(flash ? { flash } : {}),
      }),
    );
}

// ---------------------------------------------------------------------------
// GET /ui/:server
// ---------------------------------------------------------------------------

async function handleServerView(
  req: Request,
  res: Response,
  opts: ConsoleUiOptions,
  gcsList: GcsLister,
): Promise<void> {
  const slug = req.params.server ?? "";
  const signedInAs = signedInLabel(res);

  // A DECLARATION BEATS A DETECTOR. `resolveServerView` sniffs a server's env for
  // a bucket or a parameters project; `oauth:` is a thing the config says out
  // loud, so it is answered first and the sniffing never runs for a slug that
  // declares one. (Nothing declares both today — the `secrets` slug has no
  // connector — but the ordering says which concept owns the page if one ever
  // did.)
  const connector = connectorFor(opts.config, slug);
  if (connector) {
    await renderConnectorPage(
      res,
      {
        config: opts.config,
        secrets: opts.secrets,
        env: opts.env,
        sessions: opts.sessions,
        parametersStore: opts.parametersStore,
        connectorFetch: opts.connectorFetch,
        runtimeConfig: opts.runtimeConfig,
      },
      connector,
      {
        signedInAs,
        flash: connectorFlash(req.query, connector),
        // A callback that came back `client_unreadable` lands here, and the
        // repair for it is one button. See `offersClientRepair`.
        repair: offersClientRepair(req.query),
      },
    );
    return;
  }

  // A `remote-http` server that mints its bearer with `oauthRefresh:` gets the
  // same kind of page: its Connect. See src/ui/upstream-connector.ts.
  const upstream = upstreamConnectorFor(opts.config, slug);
  if (upstream) {
    await renderUpstreamConnectorPage(
      res,
      {
        config: opts.config,
        secrets: opts.secrets,
        env: opts.env,
        sessions: opts.sessions,
        parametersStore: opts.parametersStore,
        connectorFetch: opts.connectorFetch,
        runtimeConfig: opts.runtimeConfig,
      },
      upstream,
      { signedInAs, flash: upstreamFlash(req.query, upstream) },
    );
    return;
  }

  const view = resolveServerView(opts.config, slug, opts.secrets);

  if (view.kind === "not_found") {
    res
      .status(404)
      .type("html")
      .send(
        renderMessage({
          title: "Not found",
          signedInAs,
          heading: "No such server",
          sub: `No server named "${slug}" is configured on this gateway.`,
          tone: "warn",
          nav: "connectors",
        }),
      );
    return;
  }

  if (view.kind === "no_viewer") {
    // Every index card links here, so a kind with no dedicated view still gets a
    // page worth landing on: the read-only overview. Its badge is the SAME
    // reading the index renders, not a second derivation of it.
    const { statuses } = await readDeploymentSecretStatus({
      config: opts.config,
      bag: opts.secrets,
      env: opts.env,
      secretProvider: opts.secretProvider,
      fetchImpl: opts.fetchImpl,
      presence: opts.presence,
      store: opts.diagnosticStore,
    });
    const host = req.get("host");
    res.type("html").send(
      renderServerOverview({
        server: view.server,
        status: statuses.find((s) => s.server.slug === slug),
        // `/connectors/<slug>` answers only where there is a roster to edit; on
        // a deployment without one it is the "editor is off" 404, so the
        // overview must not offer it as a door.
        editable: opts.runtimeConfig?.()?.editable === true,
        playable: playgroundAccess(
          opts.config,
          entitledServers(consolePrincipal(res), opts.config),
          slug,
        ).ok,
        base: originFor(
          opts.config,
          host ? `${req.protocol}://${host}` : undefined,
        ),
        signedInAs,
      }),
    );
    return;
  }

  if (view.kind === "secrets") {
    // A GET is a NAVIGATION, so an unrecognised `?project=` falls back to the
    // first store rather than erroring — a stale bookmark from before a store
    // was renamed should land somewhere useful. A POST does not get this
    // latitude; see handleSecretAction.
    const store = selectStore(view, req.query.project);
    if (!store) {
      await renderNoStores(res, view, signedInAs);
      return;
    }
    await renderSecretsPage(res, view, store, opts, {
      signedInAs,
      namespace: selectNamespace(
        req.query.ns,
        store.namespaces,
        store.namespacesStrict,
      ),
    });
    return;
  }

  // GCS view with no resolvable credential. Render the shell — and say WHY,
  // using the reason resolve.ts computed rather than a generic apology. The
  // usual cause is scope (env: is bundle-only; the console needs consoleEnv:),
  // not an unseeded secret, and the two need different fixes.
  if (!view.account) {
    res.type("html").send(
      renderMessage({
        title: `${slug} · credentials unavailable`,
        serverSlug: slug,
        signedInAs,
        heading: "Credentials not available to the console",
        sub:
          view.accountReason ??
          "This server is scoped to a GCS bucket, but the console cannot resolve its credentials.",
        tone: "warn",
        nav: "connectors",
      }),
    );
    return;
  }

  const relPrefix = sanitizePrefix(req.query.prefix);
  const fullPrefix = view.prefix + relPrefix;

  try {
    const result = await gcsList(view.account, {
      bucket: view.bucket,
      prefix: fullPrefix,
      delimiter: "/",
    });
    res
      .type("html")
      .send(renderGcsBrowse({ view, relPrefix, result, signedInAs }));
  } catch (err) {
    const isGcs = err instanceof GcsError;
    // `errorText`, not `errorSummary`: this branch is a GCS object listing, and
    // its response body is bucket metadata rather than anything the store holds.
    const detail = isGcs ? `${err.status} — ${err.message}` : errorText(err);
    res
      .status(502)
      .type("html")
      .send(
        renderMessage({
          title: `${slug} · error`,
          serverSlug: slug,
          signedInAs,
          heading: "Could not list this bucket",
          sub: `GCS rejected the request. This is usually a credential or bucket-permission problem. Detail: ${detail}`,
          tone: "error",
          nav: "connectors",
        }),
      );
  }
}

// ---------------------------------------------------------------------------
// The parameters page, and the six actions on it.
// ---------------------------------------------------------------------------

type SecretAction =
  "create" | "bulk" | "rotate" | "note" | "reveal" | "delete" | "refresh";

/**
 * A write just changed what the store holds, so drop what it told us.
 *
 * Two things hold the old answer, and both are dropped here. The runtime
 * providers read through the resolver client, which holds ONE reading of the
 * store for `gateway.secrets.ttlSeconds` (a day by default): without the
 * `invalidate()`, a credential rotated through this console would keep being
 * served to `/mcp`, from this very process, until that reading aged out — the
 * one promise the console makes that a TTL is not allowed to break. And the
 * index's store diagnosis (see secrets/store-diagnostics.ts) establishes a
 * state — "the parameter EXISTS and its value cannot be produced, rotate it" —
 * that is checked BEFORE the live read, so without the forget a human who does
 * exactly what the row told them to do lands back on `/ui` and is told to do it
 * again, one click after the console flashed that it worked.
 *
 * Called for the three actions that change the store's answer, and for the
 * explicit `refresh` action. `note` does not: it writes metadata neither reads.
 * `reveal` writes nothing at all.
 */
function forgetStoreReading(opts: ConsoleUiOptions): void {
  opts.secretProvider?.invalidate();
  forgetDeploymentDiagnosis({ env: opts.env, store: opts.diagnosticStore });
}

/**
 * Whether the console can ACTUALLY read the OAuth client it has just created —
 * as a sentence for the create flash, and a boolean for its colour.
 *
 * `create({ consoleReadable: true })` has already written the binding. This
 * re-runs the same grant the connector page's repair button does, which is a
 * no-op on the policy (the member is already there) and a READ of the value,
 * and the read is the entire point: an IAM deny policy is evaluated before any
 * allow and cannot be granted around, so on a deployment that applied
 * `strad-console-no-read` the binding lands and buys nothing. Saying "granted"
 * there would move the failure past the consent screen — see
 * docs/operate/secrets-iam.md.
 *
 * NO VALUE, AND NOTHING DERIVED FROM ONE. `grantConsoleRead` reads the value and
 * drops it; only the boolean comes back, and the failure is described by shape
 * rather than by the store's message, which on this path could quote a client
 * secret.
 */
async function describeClientGrant(
  store: ParameterStore,
  path: string,
): Promise<{ ok: boolean; note: string }> {
  const grant = await store
    .grantConsoleRead?.(path)
    .catch(() => null)
    .then((g) => g ?? null);
  if (!grant) {
    return {
      ok: false,
      note:
        ` It is a connector's OAuth client, so strad also bound this console's own ` +
        `service account read access to that one secret — but could not confirm ` +
        `the read afterwards. Open that server's own page and use Grant read on ` +
        `this client, which reports what actually happened.`,
    };
  }
  if (grant.readable) {
    return {
      ok: true,
      note:
        ` It is a connector's OAuth client, so strad also granted this console's ` +
        `own service account read access to that one secret, and read it back — ` +
        `Connect has what it needs.`,
    };
  }
  return {
    ok: false,
    note:
      ` It is a connector's OAuth client, so strad also bound this console's own ` +
      `service account read access to that one secret — and the value still ` +
      `cannot be read, so Connect will refuse. A binding that is in place and ` +
      `grants nothing is what an IAM deny policy looks like: deny is evaluated ` +
      `before allow and cannot be granted around. strad-console-no-read, on the ` +
      `Secrets IAM page, is the one this deployment may have applied.`,
  };
}

/**
 * A value as the console's textareas submit it, as the store should hold it.
 * See the comment where handleSecretAction reads `body.value`.
 */
export function formValue(raw: string): string {
  const lf = raw.replace(/\r\n?/g, "\n");
  const body = lf.replace(/\n+$/, "");
  return body.includes("\n") ? lf : body;
}

/**
 * Write ONE new parameter — the single form and every line of a bulk add go
 * through here, so the two cannot drift on what a create does.
 *
 * Returns what `describeClientGrant` found when the path is a connector's OAuth
 * client, else null. The caller drops the store reading (`forgetStoreReading`).
 */
async function createParameter(
  store: ParameterStore,
  opts: ConsoleUiOptions,
  p: { path: string; secret: boolean; value: string; note: string },
): Promise<{ ok: boolean; note: string } | null> {
  // DERIVED FROM THE CHECKED-IN CONFIG, NEVER FROM THE FORM. The path was
  // composed out of a namespace, a prefix and a variable name the human typed,
  // and `isConnectorClientPath` asks whether an ENABLED server's own `oauth:`
  // block names that variable in that slug's `static/` namespace. There is no
  // field on either form that can say "let the console read this" — and
  // `grantAuthority` is why a runtime roster write cannot say it either.
  const consoleReadable =
    p.secret && isConnectorClientPath(grantAuthority(opts), p.path);
  await store.create({
    path: p.path,
    secret: p.secret,
    value: p.value,
    note: p.note || undefined,
    consoleReadable,
  });
  // VERIFIED, NOT ASSUMED — the same rule the repair button follows, for the
  // same reason. An IAM deny policy is evaluated before any allow, so the
  // binding the create just wrote can land and grant nothing; a flash claiming
  // the console can now read it would send a human to Connect, which would then
  // 403 after the consent screen. Reading it back is the only thing that can
  // tell those apart, and it costs one call on the one create in a hundred that
  // is a connector's client.
  return consoleReadable ? describeClientGrant(store, p.path) : null;
}

/**
 * The bulk add: every line checked first, then written one at a time.
 *
 * TWO KINDS OF FAILURE, TWO RULES. A line that fails a CHECK — a bad name, an
 * unreadable quote, a path that already exists, a namespace the store refuses —
 * stops the whole batch before anything is written: it is a typo, and a partial
 * write would leave the human working out which half landed. A line the STORE
 * refuses once writing has started does not stop the rest; it is reported on its
 * own line, next to the ones that were created. Either way every line is
 * accounted for in the report, and nothing is dropped in silence.
 *
 * The value of a line goes to the store and nowhere else. The report and the
 * refilled editor carry paths, names, kinds and notes, never a value — see
 * `refillCsv`.
 */
async function handleBulkCreate(
  res: Response,
  ctx: {
    view: Extract<ServerView, { kind: "secrets" }>;
    selected: SecretsStore;
    store: ParameterStore;
    opts: ConsoleUiOptions;
    signedInAs: string | undefined;
    namespace: string;
    nsError: string | null;
    csv: unknown;
  },
): Promise<void> {
  const { view, selected, store, opts, signedInAs, namespace } = ctx;
  const page = (
    flash: { tone: "ok" | "error"; message: string },
    bulk: BulkReport,
    status = 200,
  ) =>
    renderSecretsPage(res, view, selected, opts, {
      signedInAs,
      namespace,
      flash,
      bulk,
      status,
    });

  if (typeof ctx.csv !== "string") {
    await page(
      { tone: "error", message: "A single block of lines is required." },
      { lines: [], refill: "" },
      400,
    );
    return;
  }

  // A batch the namespace check or emptiness already refuses costs no store read.
  // Anything else reads the store afresh: the Duplicate column is a claim about
  // what exists NOW, and the console's held reading can be minutes old.
  const fresh = !(ctx.nsError || ctx.csv.trim() === "");
  if (fresh) store.forget?.();
  const existing = fresh
    ? (await store.list(namespace)).map((p) => p.path)
    : [];
  const plan = planBulkCreate(ctx.csv, {
    namespace,
    namespaceError: ctx.nsError,
    existing,
    validateVariable: validateVariableName,
    validatePrefix: validatePathPrefix,
    normalisePrefix: normalisePathPrefix,
    validateNote,
    checkPath: (path) => {
      try {
        assertWellFormed(path);
        return null;
      } catch (err) {
        return err instanceof ConsoleInputError
          ? err.message
          : "Malformed path.";
      }
    },
    idOf: parameterId,
  });

  const unreadable: BulkReportLine[] = plan.unreadable.map((e) => ({
    line: e.line,
    path: "",
    variable: "",
    secret: true,
    status: "invalid",
    message: `This line could not be read: ${e.message}`,
  }));

  if (!planIsWritable(plan)) {
    const invalid =
      plan.lines.filter((l) => l.error).length + unreadable.length;
    const lines = [
      ...unreadable,
      ...plan.lines.map((l): BulkReportLine => ({
        line: l.line,
        path: l.path,
        variable: l.variable,
        secret: l.secret,
        status: l.error ? "invalid" : "skipped",
        ...(l.error ? { message: l.error } : {}),
      })),
    ].sort((a, b) => a.line - b.line);
    await page(
      {
        tone: "error",
        message:
          plan.batchError ??
          `Nothing was created: ${invalid} of ${lines.length} line${lines.length === 1 ? "" : "s"} ` +
            `need fixing first. The lines are back in the editor below, without their values.`,
      },
      { lines, refill: refillCsv(plan.lines, plan.unreadable) },
      400,
    );
    return;
  }

  const report: BulkReportLine[] = [];
  const notCreated: BulkPlanLine[] = [];
  let created = 0;
  let firstFailure: unknown = null;
  for (const l of plan.lines) {
    const base = {
      line: l.line,
      path: l.path,
      variable: l.variable,
      secret: l.secret,
    };
    try {
      const grant = await createParameter(store, opts, l);
      created += 1;
      report.push({
        ...base,
        status: "created",
        ...(grant ? { message: grant.note.trim(), warn: !grant.ok } : {}),
      });
    } catch (err) {
      firstFailure ??= err;
      notCreated.push(l);
      // `describe` prints a sentence strad wrote, or a class name — never an
      // upstream message, which on this path could quote the value.
      report.push({ ...base, status: "failed", message: describe(err) });
    }
  }
  // A create that timed out may still have landed, so any attempt drops the
  // reading — not only a confirmed one.
  if (plan.lines.length > 0) forgetStoreReading(opts);

  const failed = plan.lines.length - created;
  await page(
    {
      tone: failed === 0 && !report.some((r) => r.warn) ? "ok" : "error",
      message:
        failed === 0
          ? `Created ${created} parameter${created === 1 ? "" : "s"} in ${namespace}.`
          : `Created ${created} of ${plan.lines.length}. ${failed} failed at the store and ` +
            `${failed === 1 ? "is" : "are"} back in the editor below, without ${failed === 1 ? "its value" : "their values"}.`,
    },
    { lines: report, refill: refillCsv(notCreated) },
    created > 0 || firstFailure === null ? 200 : statusFor(firstFailure),
  );
}

async function handleSecretAction(
  action: SecretAction,
  req: Request,
  res: Response,
  opts: ConsoleUiOptions,
): Promise<void> {
  const slug = req.params.server ?? "";
  const signedInAs = signedInLabel(res);
  const view = resolveServerView(opts.config, slug, opts.secrets);

  if (view.kind !== "secrets") {
    res
      .status(404)
      .type("html")
      .send(
        renderMessage({
          title: "Not found",
          signedInAs,
          heading: "No such secrets server",
          sub: `"${slug}" is not a parameters-backed server on this gateway.`,
          tone: "warn",
          nav: "connectors",
        }),
      );
    return;
  }

  const body = req.body as Record<string, unknown>;

  // WHICH STORE THIS WRITE LANDS IN. Every form on the page posts `project` back
  // for the same reason it posts `ns` back — an action must return where it was
  // — but the two are not treated the same when the value is unrecognised.
  //
  // A namespace falls back (a stale link is a navigation). A PROJECT does not:
  // it names the GCP project and the credential a create, rotate or delete will
  // use, and silently falling back to the first store would write a value into a
  // project the human did not name, using a different service account, and
  // report success. That is unrecoverable by inspection — the write succeeded,
  // just not where anyone will look for it.
  const rawProject = body.project;
  const chosen = selectStoreStrict(view, rawProject);
  if (!chosen) {
    const fallback = view.stores[0];
    if (!fallback) {
      await renderNoStores(res, view, signedInAs);
      return;
    }
    res
      .status(400)
      .type("html")
      .send(
        renderMessage({
          title: `${slug} · unknown store`,
          serverSlug: slug,
          signedInAs,
          heading: "That store is not configured on this console",
          sub:
            `This form named a parameter store this console does not front, so ` +
            `nothing was written. Configured stores: ` +
            `${view.stores.map((st) => st.projectId).join(", ")}.`,
          tone: "warn",
          nav: "connectors",
        }),
      );
    return;
  }
  const store_ = chosen;

  // Which namespace the human was looking at. It comes back on every form so an
  // action does not silently bounce them to the first namespace. Its SHAPE is
  // checked, not its membership — see selectNamespace.
  const namespace = selectNamespace(
    body.ns,
    store_.namespaces,
    store_.namespacesStrict,
  );
  // A TYPED namespace that is malformed must not silently write somewhere else.
  // selectNamespace falls back for a stale link; a submitted form is an
  // intention, and the difference deserves an error rather than a surprise.
  const rawNs = body.ns;
  const typedNs = typeof rawNs === "string" ? rawNs.trim() : "";
  const nsError =
    rawNs !== undefined && typeof rawNs !== "string"
      ? // A repeated `ns=` makes Express hand us an array. Falling back silently
        // would write to a namespace the form did not name.
        "A single namespace is required."
      : typedNs === ""
        ? null
        : (validateNamespace(typedNs) ??
          // STRICT IS CHECKED AGAINST THE SELECTED STORE, never a union across
          // the page. A union would let a namespace belonging to a sibling
          // project pass while THIS project is selected — a bound that does not
          // bind, which is worse than no bound because it reads like one.
          (store_.namespacesStrict &&
          !store_.namespaces.includes(normaliseNamespace(typedNs))
            ? `"${normaliseNamespace(typedNs)}" is not one of the configured namespaces for ` +
              `${store_.label} (${store_.namespaces.join(", ")}), and this store is strict.`
            : null));

  const store = storeFor(view, store_, opts);
  if (!store) {
    await renderSecretsPage(res, view, store_, opts, { signedInAs, namespace });
    return;
  }

  // A value is read into a local and never leaves this function except toward
  // the parameter store, or into the one-shot reveal panel.
  //
  // The value fields are textareas, so a pasted PEM keeps its line breaks — and
  // a browser submits every line break in a textarea as CRLF. A key stored with
  // `\r\n` is one some parsers reject, so a line break is stored as `\n`,
  // whichever form it arrived in: the same rule `parseBulkCsv` applies to a
  // quoted value. A ONE-LINE value loses a trailing line break, as it did in
  // the password input this field replaced: Enter in a textarea adds one, a
  // terminal copy often ends in one, and a token stored as `tok\n` fails
  // upstream with nothing on the page to show why. A multi-line value is kept
  // exactly — a PEM's final newline included. Nothing else is trimmed.
  const value = typeof body.value === "string" ? formValue(body.value) : "";
  const note = typeof body.note === "string" ? body.note.trim() : "";
  // A parameter is a SECRET one when the create form's checkbox is ticked.
  const secret = body.secret === "on" || body.secret === "true";
  // rotate/note/reveal/delete address an existing parameter by its canonical path.
  const path = typeof body.path === "string" ? body.path.trim() : "";

  const fail = (message: string, status = 400) =>
    renderSecretsPage(res, view, store_, opts, {
      signedInAs,
      namespace,
      flash: { tone: "error", message },
      status,
    });

  try {
    switch (action) {
      case "create": {
        const variable =
          typeof body.variable === "string" ? body.variable.trim() : "";
        // The prefix is the segments BETWEEN the namespace and the variable —
        // `{slug}/static/` for a server parameter. It is what routes a value to
        // one MCP server; without it the path is `{namespace}{VARIABLE}`, which
        // no resolver reads.
        const prefixRaw =
          typeof body.prefix === "string" ? body.prefix.trim() : "";
        const varError = validateVariableName(variable);
        const prefixError = validatePathPrefix(prefixRaw);
        const noteError = validateNote(note);
        if (nsError ?? varError ?? prefixError ?? noteError) {
          await fail(
            (nsError ?? varError ?? prefixError ?? noteError) as string,
          );
          return;
        }
        if (!value) {
          await fail("A value is required.");
          return;
        }
        const prefix = normalisePathPrefix(prefixRaw);
        const fullPath = `${namespace}${prefix}${variable}`;
        assertWellFormed(fullPath);
        let grant: Awaited<ReturnType<typeof createParameter>>;
        try {
          grant = await createParameter(store, opts, {
            path: fullPath,
            secret,
            value,
            note,
          });
        } catch (err) {
          if (!(err instanceof ParameterStoreError && err.status === 409)) {
            throw err;
          }
          // The held listing is what missed it. This store's alone: dropping
          // every console store would re-enumerate every project on the next
          // page load.
          store.forget?.();
          const answer = await collided(store, fullPath, secret);
          await renderSecretsPage(res, view, store_, opts, {
            signedInAs,
            namespace,
            flash: { tone: "error", message: answer.message },
            addVersion: answer.addVersion ? { path: fullPath } : undefined,
            status: 409,
          });
          return;
        }
        forgetStoreReading(opts);
        await renderSecretsPage(res, view, store_, opts, {
          signedInAs,
          namespace,
          flash: {
            // The CREATE succeeded either way — the message leads with that. The
            // tone is about what needs doing next: a grant that did not take is
            // a connector that will still refuse, and a green flash would send a
            // human to Connect to find that out after the consent screen.
            tone: grant && !grant.ok ? "error" : "ok",
            message:
              `Created ${prefix}${variable} (${secret ? "secret" : "non-secret"}) at ${namespace}${prefix}${variable}.` +
              (grant?.note ?? ""),
          },
        });
        return;
      }

      case "bulk": {
        await handleBulkCreate(res, {
          view,
          selected: store_,
          store,
          opts,
          signedInAs,
          namespace,
          nsError,
          csv: body.csv,
        });
        return;
      }

      case "rotate": {
        if (!value) {
          await fail("A new value is required to rotate.");
          return;
        }
        assertWellFormed(path);
        await store.rotate(path, value);
        forgetStoreReading(opts);
        await renderSecretsPage(res, view, store_, opts, {
          signedInAs,
          namespace,
          flash: {
            tone: "ok",
            message: `Rotated ${variableOf(path)}: a new value is now current.`,
          },
        });
        return;
      }

      case "note": {
        const noteError = validateNote(note);
        if (noteError) {
          await fail(noteError);
          return;
        }
        assertWellFormed(path);
        await store.setNote(path, note);
        await renderSecretsPage(res, view, store_, opts, {
          signedInAs,
          namespace,
          flash: {
            tone: "ok",
            message: note
              ? `Note saved on ${variableOf(path)}.`
              : `Note cleared on ${variableOf(path)}.`,
          },
        });
        return;
      }

      case "reveal": {
        // The hidden button is presentation; this is the gate. A form POST is
        // trivially hand-crafted, so the same posture that decides what to
        // render has to decide what to honour — and it fails closed.
        //
        // The kind is read from the store rather than taken from the request:
        // a POST claiming `secret=false` to dodge the capability check is
        // exactly the request this gate exists to refuse. A path with no listed
        // parameter is treated as SECRET, which is the strict answer.
        assertWellFormed(path);
        // Live, not from the console's held reading: a parameter re-created
        // as a secret elsewhere must not be gated as the non-secret it was.
        const isSecret = store.isSecret
          ? ((await store.isSecret(path).catch(() => true)) ?? true)
          : ((
              await store.list(namespace).catch((): ParameterMeta[] => [])
            ).find((p) => p.path === path)?.secret ?? true);

        const posture = revealPosture(
          store_.revealEnabled,
          await capabilitiesFor(view, store_, opts),
          isSecret,
        );
        if (!posture.allowed) {
          await fail(
            `Reveal is not available on this deployment. ${posture.detail}`,
            403,
          );
          return;
        }
        const revealed = await store.reveal(path);
        await renderSecretsPage(res, view, store_, opts, {
          signedInAs,
          namespace,
          revealed: { name: variableOf(path), value: revealed },
        });
        return;
      }

      case "delete": {
        assertWellFormed(path);
        await store.destroy(path);
        forgetStoreReading(opts);
        await renderSecretsPage(res, view, store_, opts, {
          signedInAs,
          namespace,
          flash: {
            tone: "ok",
            message: `Deleted ${variableOf(path)} and all of its versions.`,
          },
        });
        return;
      }

      case "refresh": {
        // The explicit signal. A value written by anything OTHER than this
        // console — `gcloud`, the seed script, another deployment's console —
        // reaches this process within `gateway.secrets.ttlSeconds` on its own,
        // which is a day by default. This is the way to not wait: it drops
        // the process's reading of the store, and the next `${NAME}` read, the
        // next tool call on a `params: true` builtin and the next `/ui` load
        // all reach Parameter Manager. Nothing is written.
        forgetStoreReading(opts);
        // And the console's own reading, which a write through strad patches
        // but a write from anywhere else does not reach.
        forgetConsoleStores();
        await renderSecretsPage(res, view, store_, opts, {
          signedInAs,
          namespace,
          flash: {
            tone: "ok",
            message:
              "Dropped this process's reading of the store. The next read reaches " +
              "Parameter Manager, so a value written outside this console is " +
              "current now rather than within gateway.secrets.ttlSeconds.",
          },
        });
        return;
      }
    }
  } catch (err) {
    // Whatever went wrong, the message describes the OPERATION, never the value:
    // ParameterStoreError carries a status and a resource, and this file never
    // interpolates `value` into a string.
    //
    // The STATUS has to distinguish "you asked for something wrong" from "the
    // store failed". A malformed path and an id collision are the caller's, and
    // answering 502 for them is both a lie and — behind an ingress that treats an
    // upstream 5xx as its own failure — a response the human never sees.
    await fail(describe(err), statusFor(err));
  }
}

interface PageExtras {
  signedInAs?: string;
  /** The managed namespace to list. Defaults to the first when absent. */
  namespace?: string;
  flash?: { tone: "ok" | "error"; message: string };
  revealed?: { name: string; value: string };
  /** The per-line outcome of a bulk add. See handleBulkCreate. */
  bulk?: BulkReport;
  /** A create that collided: offer a new version of this path. See `collided`. */
  addVersion?: { path: string };
  status?: number;
}

async function renderSecretsPage(
  res: Response,
  view: Extract<ServerView, { kind: "secrets" }>,
  selected: SecretsStore,
  opts: ConsoleUiOptions,
  extras: PageExtras,
): Promise<void> {
  const slug = view.server.slug;
  const store = storeFor(view, selected, opts);
  // The two degraded branches below replace the whole page, picker included, so
  // they carry their own way back to a healthy sibling. See renderMessage's
  // `otherStores`.
  const otherStores = view.stores
    .filter((s) => s.projectId !== selected.projectId)
    .map((s) => ({
      href: `${serverConsolePath(slug)}?project=${encodeURIComponent(s.projectId)}`,
      label: s.label,
    }));
  // Every page, degraded or not, names the other PAGES — see siblingStrip. A
  // slug that declares `oauth:` is left out whatever its env says:
  // handleServerView answers its connector first, so `/ui/<slug>` is a consent
  // page, and listing it here would name a secrets page that does not exist.
  const siblingPages = secretsPages(opts.config, opts.secrets).filter(
    (p) => p.slug !== slug && !connectorFor(opts.config, p.slug),
  );

  // No namespace is not "the whole project" — it is a misconfiguration. The MCP
  // half refuses to mount without one (servers/secrets/shared/src/config.ts) on
  // exactly this reasoning: an empty prefix matches every parameter the
  // credential can see, and a create would write a namespace-less path.
  if (selected.namespaces.length === 0) {
    res.type("html").send(
      renderMessage({
        title: `${slug} · not configured`,
        serverSlug: slug,
        signedInAs: extras.signedInAs,
        heading: "No managed namespace is configured",
        sub:
          `No namespace is configured for ${selected.label}, and an empty namespace would scope ` +
          `the console to every parameter in the project. Set at least one path prefix — e.g. ` +
          `"/strad/${opts.config.gateway.env}/mcp/" — under this store's namespaces: (or, on a ` +
          `single-store config, SECRETS_NAMESPACES under this server's consoleEnv:).`,
        tone: "warn",
        nav: "connectors",
        otherStores,
        siblingPages,
      }),
    );
    return;
  }

  if (!store) {
    res.type("html").send(
      renderMessage({
        title: `${slug} · not configured`,
        serverSlug: slug,
        signedInAs: extras.signedInAs,
        heading: "The console's admin credential is not configured",
        sub:
          `This server manages parameters in Google Cloud Parameter Manager and Secret ` +
          `Manager, but the console's own service account is not injected on this deployment. ` +
          `It is deliberately a DIFFERENT credential from the one the MCP container holds — the ` +
          `MCP one cannot read a secret value — so the console cannot fall back to it. Nor can it ` +
          `fall back to another store's key: each store on this page carries its OWN admin ` +
          `credential, by design. Store: ${selected.label}. Detail: ${selected.accountReason ?? "no credential"}`,
        tone: "warn",
        nav: "connectors",
        otherStores,
        siblingPages,
      }),
    );
    return;
  }

  const namespace = selectNamespace(
    extras.namespace,
    selected.namespaces,
    selected.namespacesStrict,
  );
  const caps = await capabilitiesFor(view, selected, opts);
  const reveal = revealPosture(selected.revealEnabled, caps);
  const revealNonSecret = revealPosture(selected.revealEnabled, caps, false);

  // `listDetailed` where the store has it: a parameter that could not be read
  // is NAMED under the rows that could, rather than failing the whole listing
  // into "No parameters in this namespace yet". A listing that failed outright
  // is `listFailure`, which the page renders as its own state — an empty
  // namespace and an unread one are different facts.
  let listing: ParameterListing = { parameters: [], unreadable: [] };
  let listFailure: string | undefined;
  try {
    listing = store.listDetailed
      ? await store.listDetailed(namespace)
      : { parameters: await store.list(namespace), unreadable: [] };
  } catch (err) {
    listFailure = describe(err);
  }

  res
    .status(extras.status ?? 200)
    .type("html")
    .send(
      renderSecrets({
        view,
        store: selected,
        config: opts.config,
        parameters: listing.parameters,
        unreadable: listing.unreadable.map((u) => ({
          id: u.id,
          reason: describe(u.error),
        })),
        listFailure,
        readAt: listing.readAt,
        namespace,
        resolver: resolverConfigured(opts.env),
        reveal,
        revealNonSecret,
        siblingPages,
        signedInAs: extras.signedInAs,
        flash: extras.flash,
        revealed: extras.revealed,
        bulk: extras.bulk,
        addVersion: extras.addVersion,
      }),
    );
}

/**
 * Which STORE this request is about.
 *
 * `?project=<id>` addresses one entry of `view.stores`; absent or unrecognised,
 * the first store wins. That fallback is right for a NAVIGATION and wrong for a
 * WRITE, so the mutating path uses `selectStoreStrict` instead — see the note in
 * handleSecretAction for why silently redirecting a write is the one failure in
 * this subsystem nobody would diagnose.
 *
 * Returns undefined only when the server fronts no store at all.
 */
export function selectStore(
  view: Extract<ServerView, { kind: "secrets" }>,
  raw: unknown,
): SecretsStore | undefined {
  return selectStoreStrict(view, raw) ?? view.stores[0];
}

/**
 * The same selection with NO fallback: an unrecognised id is `undefined`, not
 * "the first one".
 *
 * A repeated `project=` makes Express hand us an array, which is the same class
 * of ambiguity a repeated `ns=` is, and gets the same answer: refuse.
 */
export function selectStoreStrict(
  view: Extract<ServerView, { kind: "secrets" }>,
  raw: unknown,
): SecretsStore | undefined {
  // An ABSENT project is only an answer when there is one store to mean. On a
  // multi-store page it is the same ambiguity as an unrecognised one — every
  // form on the page posts the field, so a request without it is stale or
  // hand-crafted, and defaulting it would write to whichever store happens to
  // be declared first.
  if (raw === undefined || (typeof raw === "string" && raw.trim() === "")) {
    return view.stores.length === 1 ? view.stores[0] : undefined;
  }
  if (typeof raw !== "string") return undefined;
  return view.stores.find((s) => s.projectId === raw.trim());
}

/**
 * A secrets-shaped server that fronts no store at all.
 *
 * DEFENSIVE, and config cannot currently reach it: `resolveSecretsView` returns
 * a store per `consoleStores:` entry or exactly one from the `SECRETS_*` env
 * vars, and `declaresSecrets` only says "secrets" when one of those two holds —
 * so a `secrets` view always carries at least one store. It exists because
 * `stores[0]` is `SecretsStore | undefined` under `noUncheckedIndexedAccess`
 * and SOMETHING has to answer for the empty case. Saying so beats inventing a
 * placeholder store, and beats a non-null assertion that would go quietly wrong
 * if a third way of declaring a store is ever added.
 */
function renderNoStores(
  res: Response,
  view: Extract<ServerView, { kind: "secrets" }>,
  signedInAs?: string,
): void {
  const slug = view.server.slug;
  res.type("html").send(
    renderMessage({
      title: `${slug} · not configured`,
      serverSlug: slug,
      signedInAs,
      heading: "No parameter store is configured",
      sub:
        `The "${slug}" server is declared as a parameters console but names no store. ` +
        `Add at least one entry under consoleStores: (project, namespaces, adminKeyVar), or ` +
        `set SECRETS_PROJECT_ID under this server's consoleEnv:.`,
      tone: "warn",
      nav: "connectors",
    }),
  );
}

/**
 * The capability probe, MEMOISED per (server, project, service account).
 *
 * Keyed the same way the store is, and for the same reason: the answer is a
 * property of the CREDENTIAL, so it must be recomputed if the credential is
 * rotated under us, and must not be recomputed per request. The inner
 * `cachedProbe` adds the TTL; this map stops a fresh prober being built (and its
 * cache thrown away) on every page render.
 *
 * The project and the credential are in the key because one console page fronts
 * SEVERAL stores, each with its own project and its own service account. What a
 * key can do is answer differently per store on one page; what it must never do
 * is answer for store A out of a probe of store B.
 */
const probeCache = new Map<string, () => Promise<Capabilities>>();

async function capabilitiesFor(
  view: Extract<ServerView, { kind: "secrets" }>,
  selected: SecretsStore,
  opts: ConsoleUiOptions,
): Promise<Capabilities> {
  if (opts.capabilities) return opts.capabilities(view, selected);
  if (!selected.account) return NO_CAPABILITIES;

  const key = `${view.server.slug} ${selected.projectId} ${selected.account.client_email}`;
  let prober = probeCache.get(key);
  if (!prober) {
    prober = cachedProbe({
      projectId: selected.projectId,
      account: selected.account,
      crmApiBase: view.crmApiBase,
      tokenUrl: view.tokenUrl,
    });
    probeCache.set(key, prober);
  }
  return prober();
}

/**
 * The console may only act on a WELL-FORMED path. The GCP project bounds what
 * the credential can touch; this bounds the SPELLING, and that is a separate and
 * necessary job.
 *
 * The reason is `parameterId`: it folds a path to a flat id by lowercasing and
 * collapsing every non-alphanumeric run to `-`. So `/strad/prod/mcp/gcs/static/T`,
 * `/STRAD/prod/mcp/gcs/static/T`, `/strad/prod/./mcp/gcs/static/T` and
 * `/strad-prod/mcp/gcs/static/T` are FOUR spellings of ONE resource. A rotate or
 * a delete naming any of them would hit the parameter written under the first —
 * and `path` arrives from a hidden form field, so it is chosen by the caller.
 *
 * Applying the same alphabet the create path applies (`validatePathPrefix`) kills
 * `//`, `.`, `..`, uppercase and whitespace in one rule, and makes the mutating
 * actions symmetric with create rather than laxer than it.
 *
 * The store checks the envelope's own path as well (see gcp.ts) — this is the
 * cheap lock, that is the one that holds.
 */
function assertWellFormed(path: string): void {
  if (!path) throw new ConsoleInputError("A parameter path is required.");
  if (path.length > 512) {
    throw new ConsoleInputError(
      "A parameter path may be at most 512 characters.",
    );
  }
  if (!path.startsWith("/")) {
    throw new ConsoleInputError(`"${path}" is not an absolute parameter path.`);
  }
  // Checked on the RAW path, before any normalisation: an empty segment folds to
  // the same id as none, so `…/mcp//VAR` and `…/mcp/VAR` are one resource.
  if (path.includes("//") || path.split("/").includes("..")) {
    throw new ConsoleInputError(
      `"${path}" is not a well-formed parameter path.`,
    );
  }
  const variable = variableOf(path);
  if (validateVariableName(variable)) {
    throw new ConsoleInputError(
      `"${path}" does not end in a valid variable name.`,
    );
  }
  // Everything between the leading slash and the variable is namespace+prefix,
  // and both use one alphabet. `validatePathPrefix` returns null for "", so a
  // bare `/VARIABLE` still passes.
  const lead = path.slice(1, path.length - variable.length - 1);
  if (validatePathPrefix(lead)) {
    throw new ConsoleInputError(
      `"${path}" is not a well-formed parameter path.`,
    );
  }
}

/**
 * Something the console itself refused, in a sentence the console itself wrote.
 *
 * The class is the point, not the message. Every other kind of failure on these
 * routes has been somewhere near a store read, and `describe()` will not print
 * such an error's message — see its header. Validation has NOT: this is thrown
 * by `assertWellFormed` over a path the caller typed, before any request is
 * made, so its text is strad's own and safe to show back.
 */
class ConsoleInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConsoleInputError";
  }
}

/**
 * What a create that met `409 ALREADY_EXISTS` tells the human, and whether it can
 * offer them the way through.
 *
 * "That parameter already exists" on its own is a dead end whenever the
 * parameter is not on the page — and a 409 is exactly the case where the human
 * did not see it, or they would have rotated it rather than created it. So the
 * store is asked, live, what is at the path, and only a confirmed answer earns
 * either the form or advice to delete anything:
 *
 *   - LISTED at exactly this path (a managed parameter — see
 *     `READABLE_MANAGERS` in `src/secrets/parameters/wire.ts`): the page offers
 *     a new version of it, unless the create asked for a SECRET and the
 *     parameter is not one — a rotate keeps the parameter's kind, and a
 *     credential written into a non-secret envelope is readable by anything
 *     holding `parameterViewer`, the `/mcp` viewer included;
 *   - an id that folds onto a DIFFERENT path: no version can be added here;
 *   - a parameter at this path that is not listed: some other tool's, and
 *     strad does not write into it;
 *   - CONFIRMED absent as a parameter (no Parameter Manager parameter, or one
 *     with no version): a write that stopped part-way, and only then is
 *     deleting the leftovers the advice;
 *   - anything else — a throttled or failed read — says so and advises
 *     nothing destructive.
 *
 * `listDetailed` (or `list`) runs over the parent of the path; the caller has
 * dropped the held reading, so it is a fresh read. `isSecret` reads the
 * envelope directly and ignores the label, which is what tells "not managed"
 * apart from "not there".
 */
async function collided(
  store: ParameterStore,
  path: string,
  wantedSecret: boolean,
): Promise<{ message: string; addVersion: boolean }> {
  const id = parameterId(path);
  const parent = path.slice(0, path.lastIndexOf("/") + 1);
  const unknown = {
    addVersion: false,
    message:
      `${path} could not be created: the store says a resource with its id ` +
      `("${id}") already exists, and reading it back to find out what it is ` +
      `failed. Nothing was written. Re-read the store and look for it in the ` +
      `list, or try again in a minute.`,
  };
  let listed: ParameterMeta | undefined;
  let held: boolean | undefined;
  try {
    const listing = store.listDetailed
      ? (await store.listDetailed(parent)).parameters
      : await store.list(parent);
    listed = listing.find((p) => p.path === path);
    if (!listed && store.isSecret) held = await store.isSecret(path);
  } catch (err) {
    if (err instanceof ParameterStoreError && err.status === 404) {
      return {
        addVersion: false,
        message:
          `${path} folds to the store id "${id}", and a different parameter already ` +
          `holds that id, so this path cannot be created as typed. Rotate that ` +
          `parameter from its row, or choose a name that differs by more than case ` +
          `or punctuation.`,
      };
    }
    return unknown;
  }
  if (listed) {
    if (wantedSecret && !listed.secret) {
      return {
        addVersion: false,
        message:
          `${path} already exists as a NON-SECRET parameter, so nothing was ` +
          `created. A new version keeps that kind, which would store this value ` +
          `where any parameter viewer can read it. To hold a secret here, delete ` +
          `the parameter from its row and create it again as a secret.`,
      };
    }
    return {
      addVersion: true,
      message:
        `${path} already exists (${listed.secret ? "secret" : "non-secret"}), so ` +
        `nothing was created. To change its value, add a new version below.`,
    };
  }
  if (held !== undefined) {
    return {
      addVersion: false,
      message:
        `${path} already exists, but it was not written by strad or Zimmer (its ` +
        `managed-by label is neither), so this console does not list it or write ` +
        `into it. Nothing was created. Change it with the tool that owns it.`,
    };
  }
  if (!store.isSecret) return unknown;
  return {
    addVersion: false,
    message:
      `Google Cloud already holds a resource with this parameter's id ("${id}"), ` +
      `but strad cannot read it as a parameter: it has no version yet, or only ` +
      `its Secret Manager half exists — a write that stopped part-way, by strad ` +
      `or another tool. Nothing was created. Delete the Parameter Manager ` +
      `parameter and the Secret Manager secret named "${id}" in this store's ` +
      `project, then create it again.`,
  };
}

/**
 * 4xx for the caller's mistakes, 502 only for the store's.
 *
 * `assertWellFormed` throws a `ConsoleInputError` for a path the caller chose;
 * the store throws `ParameterStoreError` carrying Google's own status, and a 404
 * there is the id-collision guard saying "that is not your parameter". Neither
 * is a bad gateway.
 *
 * A timeout is the store failing to answer, so it takes the store's status. What
 * is left is genuinely unexpected — nothing on these routes knows whose fault it
 * is — and 500 is the honest answer for it.
 */
function statusFor(err: unknown): number {
  if (err instanceof ParameterStoreError) {
    if (err.status === 404) return 404;
    if (err.status === 403) return 403;
    if (err.status === 409) return 409;
    return 502;
  }
  if (err instanceof ConsoleInputError) return 400;
  // A store that did not answer, and one this container could not reach, are
  // both the gateway's upstream failing. 500 is left for the genuinely
  // unexplained, which is the only thing `describe()` cannot write a sentence for.
  if (isTimeout(err) || transportCode(err)) return 502;
  return 500;
}

/**
 * What the console tells a human about a failure, without telling them a secret.
 *
 * The rule is `errorSummary`'s (`src/util/error-text.ts`) and this is the surface
 * it was written for. Every route that reaches here — `GET /ui/:server` and the
 * six `POST /ui/:server/*` actions — reads the parameter store, and a store read
 * ends in `decodeEnvelope` -> `JSON.parse` over a payload that is a credential on
 * a non-secret parameter and the envelope around one on a secret parameter.
 * `JSON.parse` puts a window of its input in the `SyntaxError` it throws. So the
 * fallthrough prints a CLASS, never a message.
 *
 * A class name alone is a real loss for the operator, which is why the
 * fallthrough is the last branch rather than the only one. Every failure this
 * console actually produces in the field gets a sentence strad wrote — the store
 * refusing the credential, a name collision, a request that timed out, a version
 * whose payload will not decode — and each of those sentences says what to do
 * next, which the upstream's message never did anyway.
 */
function describe(err: unknown): string {
  if (err instanceof UnreadablePayloadError) {
    return (
      `The current version of that parameter is not a strad envelope, so the console ` +
      `cannot read it. Something other than strad wrote this version, or it is ` +
      `truncated. Rotating writes a fresh version and clears it; reveal and note will ` +
      `keep failing until something does.`
    );
  }
  if (err instanceof ParameterStoreError) {
    if (err.status === 403) {
      return `The store denied the request (403). The console's service account needs write access to this namespace's Parameter Manager and Secret Manager.`;
    }
    if (err.status === 409) return `That parameter already exists.`;
    // Method plus resource, query and `:verb` stripped — the one error shape on
    // this path whose message is known not to carry a value.
    return err.message;
  }
  if (isTimeout(err)) {
    return (
      `The store did not answer in time. Parameter Manager bounds every attempt ` +
      `(gateway.secrets.timeoutMs), so this is the store being slow or unreachable ` +
      `rather than a refusal. The bound is on THIS end, so a write that timed out ` +
      `may still have landed — re-read the parameter before retrying. If it keeps ` +
      `timing out, check the Google Cloud status page for Parameter Manager.`
    );
  }
  const transport = transportCode(err);
  if (transport) {
    return (
      `The console could not reach the parameter store (${transport}). Nothing was ` +
      `sent, so nothing was written. This is DNS, the network or TLS between this ` +
      `container and googleapis.com rather than anything about the parameter.`
    );
  }
  if (err instanceof ConsoleInputError) return err.message;
  // `ValueEncodingError` (`src/secrets/parameters/wire.ts`) is the other error on
  // this path whose message strad wrote: a parameter path and the encoding token
  // its envelope declared, with no value anywhere in it. It is what a reveal of a
  // parameter written by a newer strad looks like, and the class alone would send
  // an operator looking in the wrong place.
  if (err instanceof Error && err.name === "ValueEncodingError") {
    return err.message;
  }
  return (
    `The console hit an unexpected ${errorSummary(err)}. Its message is withheld ` +
    `deliberately: an error raised while reading the parameter store can carry a ` +
    `window of the payload it failed on, and on this path that payload is a ` +
    `credential. The class is logged with the request under ` +
    `strad.console_render_failed.`
  );
}

/**
 * A request that ran out of time, whoever bounded it.
 *
 * The one that fires on these routes is the store's per-attempt
 * `AbortSignal.timeout` (`src/secrets/parameters/gcp.ts`), which surfaces as
 * undici's `TimeoutError` — matched by NAME because it is a `DOMException`, not
 * an `Error` subclass this file can name.
 *
 * `DeadlineError` (`src/util/deadline.ts`) is here for completeness rather than
 * because a console route produces one today: both of its call sites catch
 * internally. It costs one `instanceof` and it means a third caller that does
 * let one through is already answered.
 */
function isTimeout(err: unknown): boolean {
  if (err instanceof DeadlineError) return true;
  return (
    err instanceof Error &&
    (err.name === "TimeoutError" || err.name === "AbortError")
  );
}

/**
 * A request that never got an answer, named by the code the runtime gave it.
 *
 * `fetch` reports every transport failure as one opaque `TypeError: fetch
 * failed` and puts the real diagnosis on `cause.code` — `ENOTFOUND`,
 * `ECONNREFUSED`, `CERT_HAS_EXPIRED`. Without this branch an unreachable store
 * is the console's least useful page: a `TypeError`, withheld, for the most
 * ordinary outage there is.
 *
 * The code is a runtime constant, not text from a response, so it is safe to
 * print — and the shape test is what keeps that true rather than assumed. A
 * `cause` that does not carry one still gets the sentence, without a code.
 */
function transportCode(err: unknown): string | null {
  if (!(err instanceof TypeError) || !("cause" in err)) return null;
  const code: unknown = (err.cause as { code?: unknown } | undefined)?.code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]*$/.test(code)
    ? code
    : "no code";
}

function renderUnexpected(res: Response, err: unknown): void {
  // The page prints a class and no message, so without this the operator has
  // nothing else to look at — the express handler is the end of the line here.
  // By class, not by message, and `errorSummary` is why: see `describe()`. The
  // export carries the NAME ALONE (`src/telemetry/events.ts`); the class stays
  // on stderr.
  event({ evt: "strad.console_render_failed", error: errorSummary(err) });
  if (res.headersSent) return;
  res
    .status(500)
    .type("html")
    .send(
      renderMessage({
        title: "Error",
        signedInAs: signedInLabel(res),
        heading: "Something went wrong",
        sub: describe(err),
        tone: "error",
        nav: "connectors",
      }),
    );
}

/**
 * Which namespace this request is about.
 *
 * `SECRETS_NAMESPACES` seeds the picker's suggestions; it does not bound what a
 * human may address. The fence is the GCP PROJECT — see servers/secrets/README.md
 * — and a list checked in code over the same credential would add no security,
 * only a redeploy between a human and a namespace they can already reach.
 *
 * What IS checked is shape: the value arrives from a query string or a form
 * field and becomes the prefix of a written path, so it must be a well-formed
 * absolute path prefix with no traversal.
 */
export function selectNamespace(
  raw: unknown,
  namespaces: string[],
  strict = false,
): string {
  const fallback = namespaces[0] ?? "";
  if (typeof raw !== "string" || raw.trim() === "") return fallback;
  if (validateNamespace(raw) !== null) return fallback;
  const normalised = normaliseNamespace(raw);
  // `strict` restores the configured list as a LIMIT rather than a set of
  // suggestions. Off by default: free text is right for an operator, whose
  // credential already reaches the whole project. On, it is defence in depth
  // against a hijacked session — see SECRETS_NAMESPACES_STRICT in resolve.ts.
  if (strict && !namespaces.includes(normalised)) return fallback;
  return normalised;
}

/**
 * A `?prefix=` is a relative path UNDER the server's configured root. Normalise
 * it to a safe GCS prefix: strip leading slashes and any `..` segments (GCS keys
 * don't traverse, but a `..` in a prefix is never something we want to honour),
 * and ensure a single trailing slash so it names a "folder".
 */
export function sanitizePrefix(raw: unknown): string {
  if (typeof raw !== "string" || raw === "") return "";
  const segments = raw
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s !== "" && s !== "." && s !== "..");
  if (segments.length === 0) return "";
  return `${segments.join("/")}/`;
}
