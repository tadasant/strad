import express, { type Express, type Request, type Response } from "express";
import type { ConsoleSessions } from "../auth/session.ts";
import type { StradConfig } from "../config/schema.ts";
import type { SecretBag } from "../secrets/index.ts";
import { requireConsoleUi, signedInLabel } from "./console-auth.ts";
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
import { renderLanding } from "./landing.ts";
import { resolveServerView, type ServerView } from "./resolve.ts";
import { resolverConfigured } from "./param-routing.ts";
import { revealPosture } from "./reveal.ts";
import {
  renderGcsBrowse,
  renderIndex,
  renderMessage,
  renderSecrets,
} from "./render.ts";

/**
 * Mount the human, SSO-gated resource browser.
 *
 * Routes:
 *   GET  /ui                    — index of every configured server
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

  app.get("/ui", gate, (_req, res) => {
    res.type("html").send(renderIndex(opts.config, signedInLabel(res)));
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
      namespace: selectNamespace(req.query.ns, view.namespaces),
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
  // action does not silently bounce them to the first namespace — and it is
  // validated against the managed list, never trusted, because it is the thing a
  // new parameter's path is built from.
  const namespace = selectNamespace(body.ns, view.namespaces);
  // A TYPED namespace that is malformed must not silently write somewhere else.
  // selectNamespace falls back for a stale link; a submitted form is an
  // intention, and the difference deserves an error rather than a surprise.
  const typedNs = typeof body.ns === "string" ? body.ns.trim() : "";
  const nsError = typedNs === "" ? null : validateNamespace(typedNs);

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
        await store.create({
          path: `${namespace}${prefix}${variable}`,
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
    await fail(describe(err), 502);
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

  const namespace = selectNamespace(extras.namespace, view.namespaces);
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
 * The console may only act on a WELL-FORMED canonical path inside a managed
 * namespace. The service account's project scope already bounds what it can
 * touch, so this is the second lock — but it turns "GCP says 403/404" into a
 * sentence a human can act on, and it keeps a hand-crafted form POST from naming
 * a path outside the namespace and getting an opaque backend error back.
 */
function assertWellFormed(path: string): void {
  if (!path) throw new Error("A parameter path is required.");
  if (!path.startsWith("/")) {
    throw new Error(`"${path}" is not an absolute parameter path.`);
  }
  if (path.includes("//") || path.split("/").includes("..")) {
    throw new Error(`"${path}" is not a well-formed parameter path.`);
  }
  if (validateVariableName(variableOf(path))) {
    throw new Error(`"${path}" does not end in a valid variable name.`);
  }
}

/** An error message that describes the failure and never the payload. */
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
export function selectNamespace(raw: unknown, namespaces: string[]): string {
  const fallback = namespaces[0] ?? "";
  if (typeof raw !== "string" || raw.trim() === "") return fallback;
  // Shape, not membership. The configured list is a convenience; the GCP project
  // is the boundary. A malformed value falls back rather than erroring, so a
  // stale bookmark lands somewhere sensible — a value that is merely UNLISTED is
  // honoured, which is the point.
  return validateNamespace(raw) === null ? normaliseNamespace(raw) : fallback;
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
