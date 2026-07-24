import express, { type Express, type Request, type Response } from "express";
import type { StradConfig } from "../config/schema.ts";
import type { SecretBag } from "../secrets/index.ts";
import { requireConsoleUi, signedInLabel } from "./console-auth.ts";
import { createGcsLister, GcsError, type GcsLister } from "./gcs-client.ts";
import {
  createGcpParameterStore,
  ParameterStoreError,
  validateVariableName,
  variableOf,
  type ParameterMeta,
  type ParameterStore,
} from "../secrets/parameters/index.ts";
import { renderLanding } from "./landing.ts";
import { resolveServerView, type ServerView } from "./resolve.ts";
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
}

export function mountConsoleUi(app: Express, opts: ConsoleUiOptions): void {
  const gate = requireConsoleUi({ config: opts.config, env: opts.env });
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
    await renderSecretsPage(res, view, opts, { signedInAs });
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

  const store = storeFor(view, opts);
  if (!store) {
    await renderSecretsPage(res, view, opts, { signedInAs });
    return;
  }

  const body = req.body as Record<string, unknown>;
  // A value is read into a local and never leaves this function except toward
  // the parameter store, or into the one-shot reveal panel.
  const value = typeof body.value === "string" ? body.value : "";
  const note = typeof body.note === "string" ? body.note.trim() : "";
  // A parameter is a SECRET one when the create form's checkbox is ticked.
  const secret = body.secret === "on" || body.secret === "true";
  // rotate/note/reveal/delete address an existing parameter by its canonical path.
  const path = typeof body.path === "string" ? body.path.trim() : "";
  const namespace = view.namespaces[0] ?? "";

  const fail = (message: string, status = 400) =>
    renderSecretsPage(res, view, opts, {
      signedInAs,
      flash: { tone: "error", message },
      status,
    });

  try {
    switch (action) {
      case "create": {
        const variable =
          typeof body.variable === "string" ? body.variable.trim() : "";
        const varError = validateVariableName(variable);
        const noteError = validateNote(note);
        if (varError ?? noteError) {
          await fail((varError ?? noteError) as string);
          return;
        }
        if (!value) {
          await fail("A value is required.");
          return;
        }
        await store.create({
          path: `${namespace}${variable}`,
          secret,
          value,
          note: note || undefined,
        });
        await renderSecretsPage(res, view, opts, {
          signedInAs,
          flash: {
            tone: "ok",
            message: `Created ${variable} (${secret ? "secret" : "non-secret"}).`,
          },
        });
        return;
      }

      case "rotate": {
        if (!value) {
          await fail("A new value is required to rotate.");
          return;
        }
        assertManaged(path, view.namespaces);
        await store.rotate(path, value);
        await renderSecretsPage(res, view, opts, {
          signedInAs,
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
        assertManaged(path, view.namespaces);
        await store.setNote(path, note);
        await renderSecretsPage(res, view, opts, {
          signedInAs,
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
        assertManaged(path, view.namespaces);
        const revealed = await store.reveal(path);
        await renderSecretsPage(res, view, opts, {
          signedInAs,
          revealed: { name: variableOf(path), value: revealed },
        });
        return;
      }

      case "delete": {
        assertManaged(path, view.namespaces);
        await store.destroy(path);
        await renderSecretsPage(res, view, opts, {
          signedInAs,
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

  let parameters: ParameterMeta[] = [];
  let flash = extras.flash;
  try {
    parameters = await store.list(view.namespaces[0] ?? "");
  } catch (err) {
    flash = flash ?? { tone: "error", message: describe(err) };
  }

  res
    .status(extras.status ?? 200)
    .type("html")
    .send(
      renderSecrets({
        view,
        parameters,
        signedInAs: extras.signedInAs,
        flash,
        revealed: extras.revealed,
      }),
    );
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
function assertManaged(path: string, namespaces: string[]): void {
  if (!path) throw new Error("A parameter path is required.");
  if (!namespaces.some((ns) => path.startsWith(ns))) {
    throw new Error(
      `"${path}" is outside this server's managed namespace (${namespaces.join(", ")}).`,
    );
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
