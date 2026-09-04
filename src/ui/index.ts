import express, { type Express, type Request, type Response } from "express";
import type { ConsoleSessions } from "../auth/session.ts";
import type { StradConfig } from "../config/schema.ts";
import type { SecretBag } from "../secrets/index.ts";
import {
  consolePrincipal,
  requireConsoleUi,
  signedInLabel,
} from "./console-auth.ts";
import { createGcsLister, GcsError, type GcsLister } from "./gcs-client.ts";
import {
  cachedProbe,
  createGcpParameterStore,
  NO_CAPABILITIES,
  normalisePathPrefix,
  ParameterStoreError,
  normaliseNamespace,
  validateNamespace,
  validatePathPrefix,
  validateVariableName,
  variableOf,
  type Capabilities,
  type ParameterMeta,
  type ParameterStore,
} from "../secrets/parameters/index.ts";
import type { BundlePresence } from "../gateway/bundle-presence.ts";
import type { Registry } from "../gateway/registry.ts";
import { mountPlayground } from "./playground.ts";
import { renderLanding } from "./landing.ts";
import {
  resolveServerView,
  type SecretsStore,
  type ServerView,
} from "./resolve.ts";
import { resolverConfigured } from "./param-routing.ts";
import { revealPosture } from "./reveal.ts";
import { renderIndex } from "./index-page.ts";
import { SERVER_ROUTE, serverConsolePath, UI_PREFIX } from "./paths.ts";
import {
  connectorFlash,
  mountConnector,
  renderConnectorPage,
} from "./connector.ts";
import { connectorFor } from "../connectors/index.ts";
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

/**
 * Mount the human, SSO-gated console.
 *
 * Routes:
 *   GET  /ui                    — the index: every configured server, what it is
 *                                 scoped to, and whether its secrets are seeded
 *   GET  /secrets               — 302 to /ui. The secret roster was a page of its
 *                                 own; it is now part of the index it describes.
 *   GET  /ui/:server            — the per-server view (GCS browser, parameters
 *                                 manager, or a "no view yet" notice). The
 *                                 parameters manager takes `?project=<gcp id>`:
 *                                 ONE page fronts N parameter stores, each with
 *                                 its own project, namespaces, bounds and admin
 *                                 credential. See consoleStores: in schema.ts.
 *   POST /ui/:server/create     — ┐
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
  /** Session sealers, so the gate can verify a Google login (src/auth/session.ts). */
  sessions?: ConsoleSessions | null;
  /** Whether Google sign-in can complete end to end. See resolveConsoleAuth(). */
  googleReady?: boolean;
  /** Test seam: the transport a connector's token exchange uses. See ConnectorUiOptions. */
  connectorFetch?: typeof fetch;
}

export function mountConsoleUi(app: Express, opts: ConsoleUiOptions): void {
  const gate = requireConsoleUi({
    config: opts.config,
    env: opts.env,
    sessions: opts.sessions,
    googleReady: opts.googleReady,
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

  // The front door. Behind the SAME gate as every other console surface: strad
  // requires Google identity before exposing anything, and the index of what
  // this gateway fronts is something. Once GOOGLE_CLIENT_ID/SECRET land, this
  // is tadasant.com-only SSO with no further change here — the gate resolves a
  // Principal and this route only ever asks whether it got one.
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

  app.get(UI_PREFIX, gate, async (req, res) => {
    // Express 4 does not catch a rejected async handler, so guard it here: any
    // unexpected error becomes a 500 page rather than a hung request.
    try {
      await handleIndex(req, res, opts);
    } catch (err) {
      renderUnexpected(res, err);
    }
  });

  // `/playground/:server` and its two POST routes. Same gate, same process, and
  // deliberately NOT under `/ui/:server` — that path is the per-server resource
  // browser and its `:server` param already means "a slug with a viewer". See
  // src/ui/playground.ts for how it authenticates without touching either gate.
  mountPlayground(app, gate, { config: opts.config, registry: opts.registry });

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
  });

  // The secret roster used to live here, as its own destination. It does not any
  // more — it is on `/ui`, on the entry it describes. The redirect stays because
  // the URL was published (bookmarks, the AIR catalog, docs), and a 404 for a
  // page whose content simply moved teaches nobody anything.
  //
  // It is behind the gate rather than in front of it so an anonymous request to
  // `/secrets` still 401s: an open redirect to a gated page is not a leak, but a
  // door that answers differently to an anonymous caller is one fewer thing to
  // reason about.
  app.get("/secrets", gate, (_req, res) => {
    res.redirect(302, UI_PREFIX);
  });

  app.get(SERVER_ROUTE, gate, async (req, res) => {
    // Express 4 does not catch a rejected async handler, so guard it here: any
    // unexpected error becomes a 500 page rather than a hung request.
    try {
      await handleServerView(req, res, opts, gcsList);
    } catch (err) {
      renderUnexpected(res, err);
    }
  });

  for (const action of [
    "create",
    "rotate",
    "note",
    "reveal",
    "delete",
    "refresh",
  ] as const) {
    app.post(`${SERVER_ROUTE}/${action}`, gate, form, async (req, res) => {
      try {
        await handleSecretAction(action, req, res, opts);
      } catch (err) {
        renderUnexpected(res, err);
      }
    });
  }
}

// ---------------------------------------------------------------------------
// GET /ui — the console index
// ---------------------------------------------------------------------------

/**
 * Read every referenced `${NAME}` once, derive a status per server, render the
 * roster.
 *
 * The reading is `readSecretStatus`, the same call `/api/secrets/readiness`
 * makes. A badge here and a JSON field there derived by two different code paths
 * would eventually disagree, and the endpoint's whole value is that a platform
 * app can trust it says what this page says.
 */
async function handleIndex(
  req: Request,
  res: Response,
  opts: ConsoleUiOptions,
): Promise<void> {
  const { statuses, boot, storeDiagnosis } = await readDeploymentSecretStatus({
    config: opts.config,
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

  res.type("html").send(
    renderIndex({
      config: opts.config,
      statuses,
      boot,
      storeDiagnosis,
      env: opts.env,
      // The console identity, for the one control on the page that is not a
      // rendering of config: the playground icon. See cardIcons().
      principal: consolePrincipal(res),
      signedInAs: signedInLabel(res),
      requestOrigin: host ? `${req.protocol}://${host}` : undefined,
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
      },
      connector,
      { signedInAs, flash: connectorFlash(req.query, connector) },
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
          breadcrumbToIndex: true,
        }),
      );
    return;
  }

  if (view.kind === "no_viewer") {
    res.type("html").send(
      renderMessage({
        title: `${slug} · no view`,
        serverSlug: slug,
        signedInAs,
        heading: "No browser view for this server",
        sub: `The "${slug}" server (kind: ${view.server.kind}) has no human resource view yet. The GCS browser is wired first; other kinds follow the same pattern.`,
        tone: "info",
        breadcrumbToIndex: true,
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
        breadcrumbToIndex: true,
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
    const detail = isGcs
      ? `${err.status} — ${err.message}`
      : err instanceof Error
        ? err.message
        : String(err);
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
          breadcrumbToIndex: true,
        }),
      );
  }
}

// ---------------------------------------------------------------------------
// The parameters page, and the five actions that mutate it.
// ---------------------------------------------------------------------------

type SecretAction =
  "create" | "rotate" | "note" | "reveal" | "delete" | "refresh";

/**
 * A write just changed what the store holds, so drop what it told us.
 *
 * Two things hold the old answer, and both are dropped here. The runtime
 * providers read through the resolver client, which holds ONE reading of the
 * store for `gateway.secrets.ttlSeconds` (an hour by default): without the
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
          breadcrumbToIndex: true,
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
          breadcrumbToIndex: true,
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
  const value = typeof body.value === "string" ? body.value : "";
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
        await store.create({
          path: fullPath,
          secret,
          value,
          note: note || undefined,
        });
        forgetStoreReading(opts);
        await renderSecretsPage(res, view, store_, opts, {
          signedInAs,
          namespace,
          flash: {
            tone: "ok",
            message: `Created ${prefix}${variable} (${secret ? "secret" : "non-secret"}) at ${namespace}${prefix}${variable}.`,
          },
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
        const listed = await store
          .list(namespace)
          .catch((): ParameterMeta[] => []);
        const isSecret = listed.find((p) => p.path === path)?.secret ?? true;

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
        // which is an hour by default. This is the way to not wait: it drops
        // the process's reading of the store, and the next `${NAME}` read, the
        // next tool call on a `params: true` builtin and the next `/ui` load
        // all reach Parameter Manager. Nothing is written.
        forgetStoreReading(opts);
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
        breadcrumbToIndex: true,
        otherStores,
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
        breadcrumbToIndex: true,
        otherStores,
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

  let parameters: ParameterMeta[] = [];
  let flash = extras.flash;
  try {
    parameters = await store.list(namespace);
  } catch (err) {
    flash = flash ?? { tone: "error", message: describe(err) };
  }

  res
    .status(extras.status ?? 200)
    .type("html")
    .send(
      renderSecrets({
        view,
        store: selected,
        config: opts.config,
        parameters,
        namespace,
        resolver: resolverConfigured(opts.env),
        reveal,
        revealNonSecret,
        signedInAs: extras.signedInAs,
        flash,
        revealed: extras.revealed,
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
      breadcrumbToIndex: true,
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
 * The parameter store, MEMOISED per (server, project, service account).
 *
 * It must not be rebuilt per request. The client caches its OAuth access token
 * for an hour (minting one costs an RSA signature and a round trip to Google),
 * and a fresh instance per call throws that cache away. It is keyed because the
 * credential differs per STORE — one page fronts several, each addressing its
 * own GCP project as its own identity — and the key is what stops one store's
 * client answering for another's.
 *
 * What the key does NOT see is a rotated PRIVATE KEY under an unchanged
 * `client_email`, which is the normal shape of a service-account key rotation:
 * this process keeps signing with the old one until core restarts. That is
 * pre-existing and bounded by a redeploy; it is written down here rather than
 * implied away, because the number of keys under it grows with the number of
 * stores on a page.
 */
const storeCache = new Map<string, ParameterStore>();

export function storeFor(
  view: Extract<ServerView, { kind: "secrets" }>,
  selected: SecretsStore,
  opts: Pick<ConsoleUiOptions, "parametersStore">,
): ParameterStore | null {
  if (opts.parametersStore) return opts.parametersStore(view, selected);
  if (!selected.account) return null;

  const key = `${view.server.slug} ${selected.projectId} ${selected.account.client_email}`;
  const cached = storeCache.get(key);
  if (cached) return cached;

  const store = createGcpParameterStore({
    projectId: selected.projectId,
    location: selected.location,
    account: selected.account,
    pmApiBase: view.pmApiBase,
    smApiBase: view.smApiBase,
    tokenUrl: view.tokenUrl,
  });
  storeCache.set(key, store);
  return store;
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
  if (!path) throw new Error("A parameter path is required.");
  if (path.length > 512) {
    throw new Error("A parameter path may be at most 512 characters.");
  }
  if (!path.startsWith("/")) {
    throw new Error(`"${path}" is not an absolute parameter path.`);
  }
  // Checked on the RAW path, before any normalisation: an empty segment folds to
  // the same id as none, so `…/mcp//VAR` and `…/mcp/VAR` are one resource.
  if (path.includes("//") || path.split("/").includes("..")) {
    throw new Error(`"${path}" is not a well-formed parameter path.`);
  }
  const variable = variableOf(path);
  if (validateVariableName(variable)) {
    throw new Error(`"${path}" does not end in a valid variable name.`);
  }
  // Everything between the leading slash and the variable is namespace+prefix,
  // and both use one alphabet. `validatePathPrefix` returns null for "", so a
  // bare `/VARIABLE` still passes.
  const lead = path.slice(1, path.length - variable.length - 1);
  if (validatePathPrefix(lead)) {
    throw new Error(`"${path}" is not a well-formed parameter path.`);
  }
}

/** An error message that describes the failure and never the payload. */
/**
 * 4xx for the caller's mistakes, 502 only for the store's.
 *
 * `assertWellFormed` throws a plain Error for a path the caller chose; the store
 * throws `ParameterStoreError` carrying Google's own status, and a 404 there is
 * the id-collision guard saying "that is not your parameter". Neither is a bad
 * gateway.
 */
function statusFor(err: unknown): number {
  if (err instanceof ParameterStoreError) {
    if (err.status === 404) return 404;
    if (err.status === 403) return 403;
    if (err.status === 409) return 409;
    return 502;
  }
  // A plain Error here is validation — assertWellFormed and friends.
  return 400;
}

function describe(err: unknown): string {
  if (err instanceof ParameterStoreError) {
    if (err.status === 403) {
      return `The store denied the request (403). The console's service account needs write access to this namespace's Parameter Manager and Secret Manager.`;
    }
    if (err.status === 409) return `That parameter already exists.`;
    return `${err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}

function renderUnexpected(res: Response, err: unknown): void {
  const detail = err instanceof Error ? err.message : String(err);
  if (res.headersSent) return;
  res
    .status(500)
    .type("html")
    .send(
      renderMessage({
        title: "Error",
        signedInAs: signedInLabel(res),
        heading: "Something went wrong",
        sub: `The console hit an unexpected error rendering this view. Detail: ${detail}`,
        tone: "error",
        breadcrumbToIndex: true,
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
