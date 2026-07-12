import express, { type Express, type Request, type Response } from "express";
import type { StradConfig } from "../config/schema.ts";
import type { SecretBag } from "../secrets/index.ts";
import { requireConsoleUi, signedInLabel } from "./console-auth.ts";
import { createGcsLister, GcsError, type GcsLister } from "./gcs-client.ts";
import {
  createSecretsAdmin,
  SecretManagerError,
  validateNote,
  validateSecretName,
  type SecretsAdmin,
  type SecretMeta,
} from "./secretmanager-client.ts";
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
 *   GET  /ui/:server            — the per-server view (GCS browser, secrets
 *                                 manager, or a "no view yet" notice)
 *   POST /ui/:server/create     — ┐
 *   POST /ui/:server/rotate     — │ the gcp-secrets WRITE surface. Humans only.
 *   POST /ui/:server/note       — │ There is no MCP equivalent of any of these,
 *   POST /ui/:server/reveal     — │ and the credential that performs them is
 *   POST /ui/:server/delete     — ┘ injected on THIS component alone.
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
 * WHY NO VALUE IS EVER LOGGED. A value appears in exactly two places: the body
 * of a POST (create/rotate), and the one-shot reveal panel. It is never put in a
 * URL (so it cannot reach an access log, a proxy, a Referer header or a
 * bookmark), never interpolated into an error, and never handed to telemetry —
 * strad's telemetry records shape and identity only (src/telemetry/redact.ts),
 * and nothing here calls it.
 */

export interface ConsoleUiOptions {
  config: StradConfig;
  /** The same injected secret bag the registry resolves ${refs} against. */
  secrets: SecretBag;
  env: NodeJS.ProcessEnv;
  /** Override the GCS listing surface. Defaults to the real JSON-API client. */
  gcsList?: GcsLister;
  /** Override the Secret Manager admin surface. Defaults to the real REST client. */
  secretsAdmin?: (
    view: Extract<ServerView, { kind: "secrets" }>,
  ) => SecretsAdmin;
}

export function mountConsoleUi(app: Express, opts: ConsoleUiOptions): void {
  const gate = requireConsoleUi({ config: opts.config, env: opts.env });
  const gcsList = opts.gcsList ?? createGcsLister();

  // The secrets forms are urlencoded. Scoped to /ui so it cannot change how
  // /mcp parses a body.
  const form = express.urlencoded({ extended: false, limit: "64kb" });

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

  // GCS view. Credentials may not be injected yet (Phase 2) — render the shell.
  if (!view.account) {
    res.type("html").send(
      renderMessage({
        title: `${slug} · not configured`,
        serverSlug: slug,
        signedInAs,
        heading: "Credentials not yet configured",
        sub: `This server is scoped to a GCS bucket, but its credentials are not injected on this deployment. Real per-server GCS credentials are seeded in a later phase; the view lights up once they are.`,
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
// The secrets page, and the five actions that mutate it.
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
          sub: `"${slug}" is not a secrets-backed server on this gateway.`,
          tone: "warn",
          breadcrumbToIndex: true,
        }),
      );
    return;
  }

  const admin = adminFor(view, opts);
  if (!admin) {
    await renderSecretsPage(res, view, opts, { signedInAs });
    return;
  }

  const body = req.body as Record<string, unknown>;
  const name = typeof body.name === "string" ? body.name.trim() : "";
  // A value is read into a local and never leaves this function except toward
  // Secret Manager, or into the one-shot reveal panel.
  const value = typeof body.value === "string" ? body.value : "";
  const note = typeof body.note === "string" ? body.note.trim() : "";
  const namespace = view.namespaces[0] ?? "";

  try {
    switch (action) {
      case "create": {
        const nameError = validateSecretName(name, namespace);
        const noteError = validateNote(note);
        if (nameError ?? noteError) {
          await renderSecretsPage(res, view, opts, {
            signedInAs,
            flash: {
              tone: "error",
              message: (nameError ?? noteError) as string,
            },
            status: 400,
          });
          return;
        }
        if (!value) {
          await renderSecretsPage(res, view, opts, {
            signedInAs,
            flash: { tone: "error", message: "A value is required." },
            status: 400,
          });
          return;
        }
        await admin.create({ name, value, note: note || undefined });
        await renderSecretsPage(res, view, opts, {
          signedInAs,
          flash: { tone: "ok", message: `Created ${name}.` },
        });
        return;
      }

      case "rotate": {
        if (!value) {
          await renderSecretsPage(res, view, opts, {
            signedInAs,
            flash: {
              tone: "error",
              message: "A new value is required to rotate.",
            },
            status: 400,
          });
          return;
        }
        assertManaged(name, view.namespaces);
        await admin.addVersion(name, value);
        await renderSecretsPage(res, view, opts, {
          signedInAs,
          flash: {
            tone: "ok",
            message: `Rotated ${name}: a new version is now current.`,
          },
        });
        return;
      }

      case "note": {
        const noteError = validateNote(note);
        if (noteError) {
          await renderSecretsPage(res, view, opts, {
            signedInAs,
            flash: { tone: "error", message: noteError },
            status: 400,
          });
          return;
        }
        assertManaged(name, view.namespaces);
        await admin.setNote(name, note);
        await renderSecretsPage(res, view, opts, {
          signedInAs,
          flash: {
            tone: "ok",
            message: note
              ? `Note saved on ${name}.`
              : `Note cleared on ${name}.`,
          },
        });
        return;
      }

      case "reveal": {
        assertManaged(name, view.namespaces);
        const revealed = await admin.accessLatest(name);
        await renderSecretsPage(res, view, opts, {
          signedInAs,
          revealed: { name, value: revealed },
        });
        return;
      }

      case "delete": {
        assertManaged(name, view.namespaces);
        await admin.destroy(name);
        await renderSecretsPage(res, view, opts, {
          signedInAs,
          flash: {
            tone: "ok",
            message: `Deleted ${name} and all of its versions.`,
          },
        });
        return;
      }
    }
  } catch (err) {
    // Whatever went wrong, the message describes the OPERATION, never the value:
    // SecretManagerError carries a status and a path, and this file never
    // interpolates `value` into a string.
    await renderSecretsPage(res, view, opts, {
      signedInAs,
      flash: { tone: "error", message: describe(err) },
      status: 502,
    });
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
  const admin = adminFor(view, opts);

  if (!admin) {
    res.type("html").send(
      renderMessage({
        title: `${slug} · not configured`,
        serverSlug: slug,
        signedInAs: extras.signedInAs,
        heading: "The console's admin credential is not configured",
        sub:
          `This server manages secrets in Google Cloud Secret Manager, but the console's own ` +
          `service account is not injected on this deployment. It is deliberately a DIFFERENT ` +
          `credential from the one the MCP container holds — the MCP one cannot read a value — ` +
          `so the console cannot fall back to it. Detail: ${view.accountReason ?? "no credential"}`,
        tone: "warn",
        breadcrumbToIndex: true,
      }),
    );
    return;
  }

  let secrets: SecretMeta[] = [];
  let flash = extras.flash;
  try {
    secrets = await admin.list(view.namespaces[0] ?? "");
  } catch (err) {
    flash = flash ?? { tone: "error", message: describe(err) };
  }

  res
    .status(extras.status ?? 200)
    .type("html")
    .send(
      renderSecrets({
        view,
        secrets,
        signedInAs: extras.signedInAs,
        flash,
        revealed: extras.revealed,
      }),
    );
}

/**
 * The admin client, MEMOISED per (server, service account).
 *
 * It must not be rebuilt per request. The client caches its OAuth access token
 * for an hour (minting one costs an RSA signature and a round trip to Google),
 * and a fresh instance per call throws that cache away — which is exactly what
 * happened before this cache existed: every mutating request built one client in
 * handleSecretAction and a second in renderSecretsPage, so a single "save note"
 * cost two JWT signings and two token exchanges.
 *
 * createGcsLister() is constructed once in mountConsoleUi for the same reason;
 * this is the secrets equivalent, keyed because the credential can differ per
 * server slug (and must be re-keyed if it is ever rotated under us).
 */
const adminCache = new Map<string, SecretsAdmin>();

function adminFor(
  view: Extract<ServerView, { kind: "secrets" }>,
  opts: ConsoleUiOptions,
): SecretsAdmin | null {
  if (opts.secretsAdmin) return opts.secretsAdmin(view);
  if (!view.account) return null;

  const key = `${view.server.slug} ${view.projectId} ${view.account.client_email}`;
  const cached = adminCache.get(key);
  if (cached) return cached;

  const admin = createSecretsAdmin({
    projectId: view.projectId,
    account: view.account,
    apiBase: view.apiBase,
    tokenUrl: view.tokenUrl,
  });
  adminCache.set(key, admin);
  return admin;
}

/**
 * The console may only act on a WELL-FORMED name inside a managed namespace.
 *
 * The service account's project scope already bounds what it can touch, so this
 * is the second lock, not the only one — but it turns "Google says 403/404" into
 * a sentence a human can act on, and it keeps a hand-crafted form POST from
 * naming `strad-staging-STRAD_TOKENS`, or a path-shaped `mcp-x/versions/1`, and
 * getting an opaque Secret Manager error back.
 *
 * It runs on rotate / note / reveal / delete. `create` runs the same charset
 * check through validateSecretName, which additionally reports WHICH rule was
 * broken so the form can say so.
 */
function assertManaged(name: string, namespaces: string[]): void {
  if (!name) throw new Error("A secret name is required.");
  if (!namespaces.some((ns) => name.startsWith(ns))) {
    throw new Error(
      `"${name}" is outside this server's managed namespace (${namespaces.join(", ")}).`,
    );
  }
  if (!/^[A-Za-z0-9_-]{1,255}$/.test(name)) {
    throw new Error(
      `"${name}" is not a valid Secret Manager name (letters, digits, underscores and dashes only).`,
    );
  }
}

/** An error message that describes the failure and never the payload. */
function describe(err: unknown): string {
  if (err instanceof SecretManagerError) {
    if (err.status === 403) {
      return `Secret Manager denied the request (403). The console's service account needs roles/secretmanager.admin on this namespace.`;
    }
    if (err.status === 409) return `That secret already exists.`;
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
