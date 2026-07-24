import type { Express, Request, Response } from "express";
import type { StradConfig } from "../config/schema.ts";
import type { SecretBag } from "../secrets/index.ts";
import { requireConsoleUi, signedInLabel } from "./console-auth.ts";
import { createGcsLister, GcsError, type GcsLister } from "./gcs-client.ts";
import { renderLanding } from "./landing.ts";
import { resolveServerView } from "./resolve.ts";
import { renderGcsBrowse, renderIndex, renderMessage } from "./render.ts";

/**
 * Mount the human, SSO-gated resource browser.
 *
 * Routes:
 *   GET /ui             — index of every configured server, linking to its view
 *   GET /ui/:server     — the per-server view (GCS browser for GCS-backed
 *                         servers; a "no view yet" notice for other kinds)
 *
 * This is HUMAN-facing HTML behind the console SSO gate. It is NOT the /mcp
 * agent endpoint and shares no auth with it (see console-auth.ts). Only mounted
 * on the core gateway, alongside /console.
 */

export interface ConsoleUiOptions {
  config: StradConfig;
  /** The same injected secret bag the registry resolves ${refs} against. */
  secrets: SecretBag;
  env: NodeJS.ProcessEnv;
  /** Override the GCS listing surface. Defaults to the real JSON-API client. */
  gcsList?: GcsLister;
}

export function mountConsoleUi(app: Express, opts: ConsoleUiOptions): void {
  const gate = requireConsoleUi({ config: opts.config, env: opts.env });
  const gcsList = opts.gcsList ?? createGcsLister();

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
      const detail = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) {
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
    }
  });
}

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
