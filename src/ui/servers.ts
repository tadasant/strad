import express, {
  type Express,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import { asyncRoute } from "../http/async-route.ts";
import { consolePrincipal, signedInLabel } from "./console-auth.ts";
import { renderMessage } from "./render.ts";
import {
  CONNECTORS_PREFIX,
  connectorsPath,
  renderForm,
  renderRoster,
  type Flash,
} from "./servers-page.ts";
import type { RuntimeConfig } from "../config/runtime.ts";
import { ConfigRejected } from "../config/runtime.ts";
import {
  AccessControlChanged,
  ImmutableFieldChanged,
  NotRuntimeCreatable,
  RUNTIME_CREATABLE_KINDS,
  SlugCollision,
  assertNoCollision,
  immutableFields,
  rawEntry,
  withRemoval,
  withRestore,
  withUpsert,
  type ServerOverlay,
} from "../config/overlay.ts";
import { ConfigStoreReadOnly, ConfigStoreTooLarge } from "../config/store.ts";
import { errorSummary } from "../util/error-text.ts";

/**
 * The console's connector editor: create, edit, disable and remove a server
 * entry without a deploy.
 *
 * ## Where it is mounted, and why not under /ui
 *
 * `/connectors`, at the top level. `/ui/:server` is a wildcard — the per-server
 * resource browser takes any slug — so `/ui/servers` would be one config entry
 * away from being shadowed by a server that happens to be called `servers`.
 * A separate prefix has no such collision and no ordering rule to remember.
 *
 * ## The same posture as every other console write
 *
 * Behind the shared `gate`, urlencoded bodies, and no CSRF token — because the
 * session and bypass cookies are HttpOnly and SameSite=Lax, so a cross-site
 * form POST arrives with no cookie and the gate answers 401. That argument is
 * written out at src/ui/index.ts, and this surface inherits it rather than
 * inventing a second answer.
 *
 * POST re-renders rather than redirecting, exactly as `handleSecretAction`
 * does: a refusal has to show the form the human was filling in, with what they
 * typed still in it and the reason above it.
 *
 * ## What it is NOT allowed to do
 *
 * Every rule about which kinds may be created and which fields may move lives
 * in src/config/overlay.ts, next to the reasoning. This file calls
 * `assertCreatable` / `assertEditable` and renders whatever they say. The
 * temptation is to duplicate a check here "for a better message"; the result of
 * doing that is two answers to the same question, and the form's answer being
 * the one that is wrong.
 */

export interface ServersUiOptions {
  runtimeConfig: () => RuntimeConfig | null;
  env: NodeJS.ProcessEnv;
}

export function mountServersUi(
  app: Express,
  gate: RequestHandler,
  opts: ServersUiOptions,
): void {
  const form = express.urlencoded({ extended: false, limit: "256kb" });

  app.get(
    CONNECTORS_PREFIX,
    gate,
    asyncRoute((req, res) => handleRoster(req, res, opts), renderUnexpected),
  );

  // BEFORE `/connectors/:slug`, or a server could not be called `new`.
  app.get(
    connectorsPath("new"),
    gate,
    asyncRoute((req, res) => handleNew(req, res, opts), renderUnexpected),
  );

  app.post(
    connectorsPath("save"),
    gate,
    form,
    asyncRoute((req, res) => handleSave(req, res, opts), renderUnexpected),
  );

  app.get(
    `${CONNECTORS_PREFIX}/:slug`,
    gate,
    asyncRoute((req, res) => handleEdit(req, res, opts), renderUnexpected),
  );

  for (const action of ["remove", "toggle", "restore"] as const) {
    app.post(
      `${CONNECTORS_PREFIX}/:slug/${action}`,
      gate,
      form,
      asyncRoute(
        (req, res) => handleMutate(action, req, res, opts),
        renderUnexpected,
      ),
    );
  }
}

/**
 * The 500 page for this surface.
 *
 * Passed in to `asyncRoute` rather than reached for, so this page's wording
 * stays separate from the secrets pages' — the same reason src/ui/index.ts
 * keeps its own. It never renders the error: an exception raised under a store
 * client can quote a rendered parameter value.
 */
function renderUnexpected(res: Response): void {
  res
    .status(500)
    .type("html")
    .send(
      renderMessage({
        title: "Error",
        heading: "Something went wrong",
        sub: "The roster editor failed on this request. Nothing was changed. The details are in the gateway's logs.",
        tone: "error",
        nav: "connectors",
      }),
    );
}

function unavailable(res: Response): void {
  res
    .status(404)
    .type("html")
    .send(
      renderMessage({
        title: "Not found",
        heading: "The roster editor is not enabled",
        sub: "This gateway's config does not set gateway.configStore.enabled, so its server roster comes from the checked-in document and changes with a deploy.",
        tone: "info",
        nav: "connectors",
      }),
    );
}

function notFound(res: Response, slug: string): void {
  res
    .status(404)
    .type("html")
    .send(
      renderMessage({
        title: "Not found",
        heading: `No server called ${slug}`,
        sub: "This gateway serves no entry with that slug.",
        tone: "info",
        nav: "connectors",
      }),
    );
}

function roster(
  res: Response,
  runtime: RuntimeConfig,
  flash?: Flash,
  status = 200,
): void {
  res
    .status(status)
    .type("html")
    .send(
      renderRoster({
        config: runtime.config(),
        overlay: runtime.overlay(),
        sources: runtime.sources(),
        writable: runtime.writable,
        signedInAs: signedInLabel(res),
        flash,
      }),
    );
}

function handleRoster(
  req: Request,
  res: Response,
  opts: ServersUiOptions,
): Promise<void> {
  void req;
  const runtime = opts.runtimeConfig();
  if (!runtime?.editable) {
    unavailable(res);
    return Promise.resolve();
  }
  roster(res, runtime);
  return Promise.resolve();
}

/** The entries a new one may be copied from: same kind, anything else goes. */
function copyable(
  runtime: RuntimeConfig,
  kind: string,
): { slug: string; title?: string }[] {
  return runtime
    .config()
    .servers.filter((s) => s.kind === kind)
    .map((s) => ({ slug: s.slug, ...(s.title ? { title: s.title } : {}) }));
}

function handleNew(
  req: Request,
  res: Response,
  opts: ServersUiOptions,
): Promise<void> {
  const runtime = opts.runtimeConfig();
  if (!runtime?.editable) {
    unavailable(res);
    return Promise.resolve();
  }

  const kind = String(req.query.kind ?? "");
  if (!(RUNTIME_CREATABLE_KINDS as readonly string[]).includes(kind)) {
    roster(res, runtime, {
      tone: "error",
      message: `A ${kind || "server"} cannot be added from the console.`,
      detail: [
        `Choose one of: ${RUNTIME_CREATABLE_KINDS.join(", ")}. A builtin has to ship with a build.`,
      ],
    });
    return Promise.resolve();
  }

  // "Copy from" is a GET so the prefilled form is a bookmarkable URL and a
  // reload does not re-post anything. The source entry is read RAW, so the form
  // shows what somebody wrote rather than what Zod filled in around it.
  const copyFrom = String(req.query.copyFrom ?? "");
  const source = copyFrom ? rawEntry(runtime.document(), copyFrom) : undefined;
  const entry = source ? withoutSlug(source) : { kind };

  res.type("html").send(
    renderForm({
      config: runtime.config(),
      entry,
      kind,
      copyable: copyable(runtime, kind),
      ...(copyFrom ? { copiedFrom: copyFrom } : {}),
      revision: runtime.overlay().revision,
      source: "store",
      signedInAs: signedInLabel(res),
    }),
  );
  return Promise.resolve();
}

/** A copied entry, minus the one field that must be unique. */
function withoutSlug(entry: Record<string, unknown>): Record<string, unknown> {
  const { slug: _slug, ...rest } = entry;
  return rest;
}

function handleEdit(
  req: Request,
  res: Response,
  opts: ServersUiOptions,
): Promise<void> {
  const runtime = opts.runtimeConfig();
  if (!runtime?.editable) {
    unavailable(res);
    return Promise.resolve();
  }

  const slug = String(req.params.slug);
  const entry = rawEntry(runtime.document(), slug);
  if (!entry) {
    notFound(res, slug);
    return Promise.resolve();
  }

  res.type("html").send(
    renderForm({
      config: runtime.config(),
      entry,
      slug,
      kind: String(entry.kind ?? ""),
      copyable: [],
      revision: runtime.overlay().revision,
      source: runtime.sources().get(slug) ?? "file",
      // The checked-in document declares it, so its access control is the
      // deploy's — see assertNoAccessControlChange.
      accessLocked: runtime.fileSlugs().has(slug),
      signedInAs: signedInLabel(res),
    }),
  );
  return Promise.resolve();
}

/**
 * Refuse a Save built against a roster somebody else has since changed.
 *
 * The form carries the revision it rendered. A mismatch means the overlay moved
 * underneath it — a second tab, a second console process — and applying anyway
 * would silently discard whatever that change was. This catches the collision a
 * human can actually cause; it is not a lock on the store, which has no
 * compare-and-swap (see src/config/overlay.ts).
 */
function revisionMatches(
  body: Record<string, unknown>,
  overlay: ServerOverlay,
): boolean {
  const claimed = Number(body.revision);
  return Number.isFinite(claimed) && claimed === overlay.revision;
}

async function handleSave(
  req: Request,
  res: Response,
  opts: ServersUiOptions,
): Promise<void> {
  const runtime = opts.runtimeConfig();
  if (!runtime?.editable) return unavailable(res);

  const body = (req.body ?? {}) as Record<string, unknown>;
  const kind = String(body.kind ?? "");
  const original =
    typeof body.original === "string" ? body.original : undefined;
  const before = original ? rawEntry(runtime.document(), original) : undefined;

  /**
   * The entry whose UNRENDERED fields this save carries through.
   *
   * On an EDIT that is the entry being edited — changing a title must not drop
   * a field the form has no input for. On a CREATE it is whatever the human
   * copied from, minus its slug, because otherwise "start from an existing one"
   * quietly means "start from the fields that happen to have inputs" and a
   * copied connector loses, say, its `oauth:` block.
   *
   * It never feeds `assertAcceptable`: a create stays a create.
   */
  const copiedFrom =
    typeof body.copiedFrom === "string" ? body.copiedFrom : undefined;

  /**
   * Whether the checked-in document declares the slug being written.
   *
   * Read from the BODY rather than from a parsed entry, because
   * `entryFromForm` can throw on malformed input and this has to be known in
   * order to redraw the form that reports the throw.
   */
  const targetSlug = String(body.slug ?? original ?? "");
  const accessLocked = runtime.fileSlugs().has(targetSlug);
  const carrySource =
    before ??
    (copiedFrom ? rawEntry(runtime.document(), copiedFrom) : undefined);
  const carry = carrySource ? withoutSlug(carrySource) : undefined;

  /**
   * Whether this save is an EDIT of an entry the roster currently holds, which
   * is what decides how a field the form rendered disabled is read back. A
   * create copied from another entry renders those fields ENABLED, so it owns
   * them; only an edit hands them back.
   */
  const editing = before !== undefined;

  const redraw = (flash: Flash, status = 400): void => {
    res
      .status(status)
      .type("html")
      .send(
        renderForm({
          config: runtime.config(),
          // What they typed, not what was stored — a refusal that clears the
          // form is a refusal that costs the work.
          entry: entryFromForm(body, carry, { accessLocked, editing }),
          ...(original ? { slug: original } : {}),
          kind,
          copyable: original ? [] : copyable(runtime, kind),
          ...(copiedFrom ? { copiedFrom } : {}),
          revision: runtime.overlay().revision,
          accessLocked,
          source: original
            ? (runtime.sources().get(original) ?? "file")
            : "store",
          signedInAs: signedInLabel(res),
          flash,
        }),
      );
  };

  if (!revisionMatches(body, runtime.overlay())) {
    return redraw(
      {
        tone: "error",
        message: "The roster changed while this form was open.",
        detail: [
          `This form was built on revision ${String(body.revision)}; the gateway is now on ${String(
            runtime.overlay().revision,
          )}. Nothing was written. Reload the roster and re-apply your change.`,
        ],
        // 409: the request was fine, the state it assumed was not.
      },
      409,
    );
  }

  let entry: Record<string, unknown>;
  try {
    entry = entryFromForm(body, carry, { accessLocked, editing });
    requireSlug(entry);
    // `original` is undefined on an Add, so an Add onto an existing slug is a
    // collision rather than a replace. On an Edit it is the slug being edited,
    // so only a RENAME onto somebody else trips this.
    assertNoCollision(runtime.config(), String(entry.slug), original);
    // The SAME call the `connectors` MCP tools make (src/servers/connectors.ts).
    // Two copies of "may I add this" is two answers, and the one the human sees
    // and the one the agent sees would eventually differ.
    runtime.assertAcceptable(entry, before);
  } catch (err) {
    if (
      err instanceof NotRuntimeCreatable ||
      err instanceof ImmutableFieldChanged ||
      err instanceof BadInput
    ) {
      return redraw({ tone: "error", message: err.message });
    }
    // 409: what they asked for is well-formed, the roster it assumed is not.
    if (err instanceof SlugCollision) {
      return redraw({ tone: "error", message: err.message }, 409);
    }
    if (err instanceof AccessControlChanged) {
      return redraw({ tone: "error", message: err.message }, 409);
    }
    throw err;
  }

  const next = withUpsert(runtime.overlay(), entry, {
    ...(original && original !== entry.slug ? { previousSlug: original } : {}),
    fileSlugs: runtime.fileSlugs(),
    ...(signedInLabel(res) ? { by: signedInLabel(res) } : {}),
  });

  try {
    await runtime.apply(next, consoleIdentity(res));
  } catch (err) {
    return redraw(refusal(err));
  }

  roster(res, runtime, {
    tone: "ok",
    message: `${String(entry.slug)} saved. It is live on this gateway now — no deploy, no restart.`,
  });
}

async function handleMutate(
  action: "remove" | "toggle" | "restore",
  req: Request,
  res: Response,
  opts: ServersUiOptions,
): Promise<void> {
  const runtime = opts.runtimeConfig();
  if (!runtime?.editable) return unavailable(res);

  const slug = String(req.params.slug);

  // Restore is the one action whose subject is NOT in the served roster — it
  // undoes a removal, so the entry it is about is the one the overlay is
  // currently subtracting.
  if (action === "restore") {
    if (!runtime.overlay().servers.removals.includes(slug)) {
      return notFound(res, slug);
    }
    try {
      await runtime.apply(
        withRestore(runtime.overlay(), slug, {
          ...(signedInLabel(res) ? { by: signedInLabel(res) } : {}),
        }),
        consoleIdentity(res),
      );
    } catch (err) {
      return roster(res, runtime, refusal(err), 400);
    }
    return roster(res, runtime, {
      tone: "ok",
      message: `${slug} restored. The checked-in config's entry is serving again.`,
    });
  }

  const entry = rawEntry(runtime.document(), slug);
  if (!entry) return notFound(res, slug);

  const overlay = runtime.overlay();
  const next =
    action === "remove"
      ? withRemoval(overlay, slug, {
          fileSlugs: runtime.fileSlugs(),
          ...(signedInLabel(res) ? { by: signedInLabel(res) } : {}),
        })
      : withUpsert(
          overlay,
          { ...entry, enabled: entry.enabled === false },
          {
            fileSlugs: runtime.fileSlugs(),
            ...(signedInLabel(res) ? { by: signedInLabel(res) } : {}),
          },
        );

  try {
    await runtime.apply(next, consoleIdentity(res));
  } catch (err) {
    return roster(res, runtime, refusal(err), 400);
  }

  roster(res, runtime, {
    tone: "ok",
    message:
      action === "remove"
        ? `${slug} removed. It is no longer routed.`
        : `${slug} ${entry.enabled === false ? "enabled" : "disabled"}.`,
  });
}

/** A refusal, rendered as the human-facing reason it was refused. */
function refusal(err: unknown): Flash {
  if (err instanceof ConfigRejected) {
    return {
      tone: "error",
      message:
        "That change would make the config invalid, so nothing was written.",
      detail: err.problems,
    };
  }
  if (
    err instanceof ConfigStoreReadOnly ||
    err instanceof ConfigStoreTooLarge
  ) {
    return { tone: "error", message: err.message };
  }
  // A store that would not answer, or a rebuild that failed. `errorSummary`
  // rather than `errorText`: this path has just been through a parameter-store
  // write, and src/util/error-text.ts is explicit that anything which could
  // have touched a store read or a rendered payload takes the summarising one.
  // A store client's exception can quote a rendered value, and the cost of
  // getting this wrong is a credential in an HTML page.
  return {
    tone: "error",
    message: "The change could not be applied, so nothing was written.",
    detail: [errorSummary(err)],
  };
}

class BadInput extends Error {}

function requireSlug(entry: Record<string, unknown>): void {
  const slug = entry.slug;
  if (typeof slug !== "string" || slug.trim() === "") {
    throw new BadInput("A slug is required.");
  }
}

/** Who is making the change, for the stored overlay's `updatedBy`. */
function consoleIdentity(res: Response): string | undefined {
  return consolePrincipal(res).label;
}

// ---------------------------------------------------------------------------
// The form -> entry conversion
// ---------------------------------------------------------------------------

function str(body: Record<string, unknown>, name: string): string {
  const raw = body[name];
  return typeof raw === "string" ? raw.trim() : "";
}

/** A textarea of one item per line, blank lines dropped. */
function list(body: Record<string, unknown>, name: string): string[] {
  return str(body, name)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/** A textarea of `Name: value` lines. */
function map(
  body: Record<string, unknown>,
  name: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of list(body, name)) {
    const at = line.indexOf(":");
    if (at < 0) throw new BadInput(`"${line}" is not a Name: value pair.`);
    out[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return out;
}

function num(body: Record<string, unknown>, name: string): number | undefined {
  const raw = str(body, name);
  if (raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new BadInput(`${name} must be a number.`);
  }
  return value;
}

/** Drop keys whose value is undefined, an empty string, or an empty container. */
function pruned(entry: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) {
    if (value === undefined) continue;
    if (value === "") continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      Object.keys(value).length === 0
    ) {
      continue;
    }
    out[key] = value;
  }
  return out;
}

/**
 * The posted form as a raw config entry.
 *
 * `before` is carried THROUGH rather than replaced. The form renders the fields
 * worth editing from a browser, and a config entry may legally carry others —
 * an edit that silently dropped whatever the form does not know about would
 * turn "change the title" into "delete four fields". So the result is the
 * original entry with the form's fields written over it, and only the form's
 * own fields are ever cleared by being left blank.
 *
 * `editing` is what tells a blank field apart from a field the form rendered
 * DISABLED, which is the same distinction `accessLocked` draws for the roles.
 */
export function entryFromForm(
  body: Record<string, unknown>,
  before?: Record<string, unknown>,
  opts: { accessLocked?: boolean; editing?: boolean } = {},
): Record<string, unknown> {
  const accessLocked = opts.accessLocked ?? false;
  const kind = str(body, "kind");

  const entitlements = Object.keys(body)
    .filter((k) => k.startsWith("entitlement:"))
    .map((k) => k.slice("entitlement:".length))
    .sort();

  const tools = pruned({
    allow: list(body, "toolsAllow"),
    deny: list(body, "toolsDeny"),
  });

  const common: Record<string, unknown> = {
    slug: str(body, "slug"),
    kind,
    title: str(body, "title"),
    description: str(body, "description"),
    entitlements,
    // An unchecked checkbox is absent from the body, so `enabled` is the one
    // field that must be written explicitly rather than pruned — otherwise
    // unchecking it would leave the previous value in place.
    enabled: body.enabled !== undefined,
    timeoutMs: num(body, "timeoutMs"),
    tools: Object.keys(tools).length > 0 ? tools : undefined,
    mayBeUnseeded: list(body, "mayBeUnseeded"),
  };

  const specific: Record<string, unknown> = kindFields(kind, body);

  // The form's own fields are authoritative — including when they are now
  // blank. Everything else on the original entry survives untouched.
  const owned = new Set([...Object.keys(common), ...formFieldsFor(kind)]);
  if (accessLocked) {
    // The form rendered these disabled, and a disabled input submits NOTHING —
    // so owning them here would read "the human cleared the roles" out of a
    // form that never offered them the chance. Hand them back to the carried
    // entry, which is where the checked-in values are.
    owned.delete("entitlements");
    owned.delete("tools");
    delete common.entitlements;
    delete common.tools;
  }
  if (opts.editing && before) {
    // Same rule, for the fields `renderForm` greys out on an edit. A disabled
    // `image:` input posts nothing, so owning it would hand `assertEditable` an
    // entry with no image — read as an image CHANGE, and refused. `kind` is
    // excluded because it rides a hidden input, which is never disabled.
    for (const field of immutableFields(kind)) {
      if (field === "kind") continue;
      owned.delete(field);
      delete common[field];
      delete specific[field];
    }
  }
  const carried = Object.fromEntries(
    Object.entries(before ?? {}).filter(([k]) => !owned.has(k)),
  );

  return {
    ...carried,
    ...pruned({ ...common, ...specific }),
    enabled: common.enabled,
  };
}

/** Every entry field this form OWNS, per kind — see `entryFromForm`. */
function formFieldsFor(kind: string): string[] {
  switch (kind) {
    case "remote-http":
      return ["url", "headers", "oauthRefresh"];
    case "local-tunnel":
      return ["url", "headers", "connectTimeoutMs", "recovery"];
    case "supplementary-image":
      return ["image", "bundle", "path", "headers"];
    default:
      return [];
  }
}

function kindFields(
  kind: string,
  body: Record<string, unknown>,
): Record<string, unknown> {
  switch (kind) {
    case "remote-http": {
      const oauthRefresh = pruned({
        tokenUrl: str(body, "oauthTokenUrl"),
        clientId: str(body, "oauthClientId"),
        clientSecret: str(body, "oauthClientSecret"),
        clientAuth: str(body, "oauthClientAuth"),
        refreshToken: str(body, "oauthRefreshToken"),
        scope: str(body, "oauthScope"),
        resource: str(body, "oauthResource"),
      });
      return {
        url: str(body, "url"),
        headers: map(body, "headers"),
        // Only when the token URL is there. A `clientAuth` defaulted by the
        // select, alone, would otherwise turn every remote-http entry into one
        // that declares an OAuth refresh it cannot perform.
        oauthRefresh: oauthRefresh.tokenUrl ? oauthRefresh : undefined,
      };
    }
    case "local-tunnel":
      return {
        url: str(body, "url"),
        headers: map(body, "headers"),
        connectTimeoutMs: num(body, "connectTimeoutMs"),
        recovery: pruned({
          machine: str(body, "recoveryMachine"),
          commands: list(body, "recoveryCommands"),
          notes: list(body, "recoveryNotes"),
        }),
      };
    case "supplementary-image":
      return {
        image: str(body, "image"),
        bundle: str(body, "bundle"),
        path: str(body, "path"),
        headers: map(body, "headers"),
      };
    default:
      return {};
  }
}
