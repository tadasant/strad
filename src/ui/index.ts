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
import { resolveServerView, type ServerView } from "./resolve.ts";
import { resolverConfigured } from "./param-routing.ts";
import { revealPosture } from "./reveal.ts";
import { renderIndex } from "./index-page.ts";
import { readDeploymentSecretStatus } from "./secret-status.ts";
import type { SecretProvider } from "../secrets/provider/index.ts";
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
 *                                 manager, or a "no view yet" notice)
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
  secretProvider?: SecretProvider;
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

  app.get("/ui", gate, async (req, res) => {
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
    res.redirect(302, "/ui");
  });

  app.get("/ui/:server", gate, async (req, res) => {
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
  ] as const) {
    app.post(`/ui/:server/${action}`, gate, form, async (req, res) => {
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
  const { statuses, boot } = await readDeploymentSecretStatus({
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
    await renderSecretsPage(res, view, opts, {
      signedInAs,
      namespace: selectNamespace(
        req.query.ns,
        view.namespaces,
        view.namespacesStrict,
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

type SecretAction = "create" | "rotate" | "note" | "reveal" | "delete";

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
  // Which namespace the human was looking at. It comes back on every form so an
  // action does not silently bounce them to the first namespace. Its SHAPE is
  // checked, not its membership — see selectNamespace.
  const namespace = selectNamespace(
    body.ns,
    view.namespaces,
    view.namespacesStrict,
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
          (view.namespacesStrict &&
          !view.namespaces.includes(normaliseNamespace(typedNs))
            ? `"${normaliseNamespace(typedNs)}" is not one of this console's configured namespaces ` +
              `(${view.namespaces.join(", ")}), and SECRETS_NAMESPACES_STRICT is on.`
            : null));

  const store = storeFor(view, opts);
  if (!store) {
    await renderSecretsPage(res, view, opts, { signedInAs, namespace });
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
    renderSecretsPage(res, view, opts, {
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
        await renderSecretsPage(res, view, opts, {
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
        await renderSecretsPage(res, view, opts, {
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
        await renderSecretsPage(res, view, opts, {
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
          view.revealEnabled,
          await capabilitiesFor(view, opts),
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
        await renderSecretsPage(res, view, opts, {
          signedInAs,
          namespace,
          revealed: { name: variableOf(path), value: revealed },
        });
        return;
      }

      case "delete": {
        assertWellFormed(path);
        await store.destroy(path);
        await renderSecretsPage(res, view, opts, {
          signedInAs,
          namespace,
          flash: {
            tone: "ok",
            message: `Deleted ${variableOf(path)} and all of its versions.`,
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
  opts: ConsoleUiOptions,
  extras: PageExtras,
): Promise<void> {
  const slug = view.server.slug;
  const store = storeFor(view, opts);

  // No namespace is not "the whole project" — it is a misconfiguration. The MCP
  // half refuses to mount without one (servers/secrets/shared/src/config.ts) on
  // exactly this reasoning: an empty prefix matches every parameter the
  // credential can see, and a create would write a namespace-less path.
  if (view.namespaces.length === 0) {
    res.type("html").send(
      renderMessage({
        title: `${slug} · not configured`,
        serverSlug: slug,
        signedInAs: extras.signedInAs,
        heading: "No managed namespace is configured",
        sub:
          `SECRETS_NAMESPACES is empty for this server, and an empty namespace would scope the ` +
          `console to every parameter in the project. Set it to at least one path prefix — e.g. ` +
          `"/strad/${opts.config.gateway.env}/mcp/" — under this server's consoleEnv:.`,
        tone: "warn",
        breadcrumbToIndex: true,
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
          `MCP one cannot read a secret value — so the console cannot fall back to it. Detail: ${view.accountReason ?? "no credential"}`,
        tone: "warn",
        breadcrumbToIndex: true,
      }),
    );
    return;
  }

  const namespace = selectNamespace(
    extras.namespace,
    view.namespaces,
    view.namespacesStrict,
  );
  const caps = await capabilitiesFor(view, opts);
  const reveal = revealPosture(view.revealEnabled, caps);
  const revealNonSecret = revealPosture(view.revealEnabled, caps, false);

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
 * The capability probe, MEMOISED per (server, service account, project).
 *
 * Keyed the same way the store is, and for the same reason: the answer is a
 * property of the CREDENTIAL, so it must be recomputed if the credential is
 * rotated under us, and must not be recomputed per request. The inner
 * `cachedProbe` adds the TTL; this map stops a fresh prober being built (and its
 * cache thrown away) on every page render.
 */
const probeCache = new Map<string, () => Promise<Capabilities>>();

async function capabilitiesFor(
  view: Extract<ServerView, { kind: "secrets" }>,
  opts: ConsoleUiOptions,
): Promise<Capabilities> {
  if (opts.capabilities) return opts.capabilities(view);
  if (!view.account) return NO_CAPABILITIES;

  const key = `${view.server.slug} ${view.projectId} ${view.account.client_email}`;
  let prober = probeCache.get(key);
  if (!prober) {
    prober = cachedProbe({
      projectId: view.projectId,
      account: view.account,
      crmApiBase: view.crmApiBase,
      tokenUrl: view.tokenUrl,
    });
    probeCache.set(key, prober);
  }
  return prober();
}

/**
 * The parameter store, MEMOISED per (server, service account).
 *
 * It must not be rebuilt per request. The client caches its OAuth access token
 * for an hour (minting one costs an RSA signature and a round trip to Google),
 * and a fresh instance per call throws that cache away. It is keyed because the
 * credential can differ per server slug (and must be re-keyed if rotated under us).
 */
const storeCache = new Map<string, ParameterStore>();

function storeFor(
  view: Extract<ServerView, { kind: "secrets" }>,
  opts: ConsoleUiOptions,
): ParameterStore | null {
  if (opts.parametersStore) return opts.parametersStore(view);
  if (!view.account) return null;

  const key = `${view.server.slug} ${view.projectId} ${view.account.client_email}`;
  const cached = storeCache.get(key);
  if (cached) return cached;

  const store = createGcpParameterStore({
    projectId: view.projectId,
    location: view.location,
    account: view.account,
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
