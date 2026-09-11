import express, {
  type Express,
  type RequestHandler,
  type Response,
} from "express";
import type { StradConfig } from "../config/schema.ts";
import { asyncRoute } from "../http/async-route.ts";
import {
  forgetTokenRecord,
  mintTokenRecord,
  offerableRoles,
  readTokenRecords,
  revokeTokenRecord,
  tokensParameterPath,
  tokenWritability,
  type TokenAdminOptions,
} from "../auth/token-admin.ts";
import {
  TOKENS_VARIABLE,
  UnreadableTokenRecords,
  type TokenRecord,
} from "../auth/tokens.ts";
import { errorSummary } from "../util/error-text.ts";
import { signedInLabel } from "./console-auth.ts";
import { esc, formatTime, layout } from "./render.ts";
import { COPY_SCRIPT } from "./landing.ts";

/**
 * `/tokens` — mint and revoke the credentials `/mcp` accepts.
 *
 * Routes:
 *   GET  /tokens         — every record: label, roles, when it was minted, and
 *                          whether it still works
 *   POST /tokens/mint    — mint one. The plaintext is rendered into THIS
 *                          response and is unrecoverable afterwards
 *   POST /tokens/revoke  — soft revocation: the record stays, verification fails
 *   POST /tokens/forget  — drop a REVOKED record. Refused for an active one
 *
 * ## Why there is no `/mcp` counterpart, and why that is the decision
 *
 * strad has two front doors and a capability behind only one of them is normally
 * a defect (`strad-sync-console-mcp-parity`). This whole class is the deliberate
 * exception, and it is the same exception the `secrets` write surface already
 * takes (`src/ui/index.ts`): the credential that mints `/mcp` credentials must
 * not itself be reachable from `/mcp`.
 *
 *   - A mint tool is a privilege-ESCALATION primitive. Any token that reached it
 *     could mint a token holding roles it does not hold, and a durable one, so
 *     the roles on a compromised token would stop bounding the compromise.
 *   - A revoke tool is a DENIAL-OF-SERVICE primitive against the gateway's own
 *     front door, up to and including locking every agent out of it.
 *   - Even a read is the gateway's access-control list — every label, role and
 *     id — handed to whoever holds one token.
 *
 * All three are things a human behind Google SSO should be able to do and an
 * agent holding a bearer token should not. The asymmetry is the security
 * property, not a gap in the surface.
 *
 * ## Where the plaintext goes
 *
 * Into this response's HTML and nowhere else. Never a URL (so it cannot reach an
 * access log, a proxy, a `Referer` or a bookmark), never an error, never
 * telemetry — the events this path emits carry a `pubid`, which is the
 * non-secret half by construction. Every write renders the page directly rather
 * than redirecting, which is also what keeps the one-shot panel from surviving a
 * reload.
 *
 * ## CSRF
 *
 * Same argument as the secrets writes: the session is an HttpOnly, SameSite=Lax
 * cookie (`src/ui/console-auth.ts`), so a cross-site form POST arrives without it
 * and the gate 401s it before any of this runs.
 */

export interface TokensUiOptions extends TokenAdminOptions {
  env: NodeJS.ProcessEnv;
}

export function mountTokensConsole(
  app: Express,
  gate: RequestHandler,
  opts: TokensUiOptions,
): void {
  // Scoped to these routes so it cannot change how /mcp parses a body.
  const form = express.urlencoded({ extended: false, limit: "64kb" });

  app.get(
    "/tokens",
    gate,
    asyncRoute(async (_req, res) => {
      await renderTokens(res, opts, {});
    }, unexpected),
  );

  app.post(
    "/tokens/mint",
    gate,
    form,
    asyncRoute(async (req, res) => {
      const body = req.body as Record<string, unknown>;
      const out = await mintTokenRecord(opts, {
        label: typeof body.label === "string" ? body.label : "",
        roles: rolesFrom(body.roles),
      });
      if (!out.ok) {
        res.status(out.status);
        await renderTokens(res, opts, {
          flash: { tone: "error", message: out.reason },
        });
        return;
      }
      await renderTokens(res, opts, {
        flash: {
          tone: "ok",
          message: `Minted "${out.minted.record.label}" (${out.minted.record.pubid}).`,
        },
        minted: out.minted,
      });
    }, unexpected),
  );

  for (const action of ["revoke", "forget"] as const) {
    app.post(
      `/tokens/${action}`,
      gate,
      form,
      asyncRoute(async (req, res) => {
        const body = req.body as Record<string, unknown>;
        const pubid = typeof body.pubid === "string" ? body.pubid.trim() : "";
        const out =
          action === "revoke"
            ? await revokeTokenRecord(opts, pubid)
            : await forgetTokenRecord(opts, pubid);
        if (!out.ok) {
          res.status(out.status);
          await renderTokens(res, opts, {
            flash: { tone: "error", message: out.reason },
          });
          return;
        }
        await renderTokens(res, opts, {
          flash: {
            tone: "ok",
            message:
              action === "revoke"
                ? `Revoked "${out.record.label}" (${out.record.pubid}). It stops working on the next request.`
                : `Forgot "${out.record.label}" (${out.record.pubid}).`,
          },
        });
      }, unexpected),
    );
  }
}

/**
 * Roles from the form, as a set.
 *
 * Express hands back a string for one checked box and an array for several, and
 * `[]` for none. Deduped and trimmed because a hand-crafted POST is the only way
 * to get a repeat, and a record carrying `["admin","admin"]` would read as two
 * grants of one thing forever after.
 */
function rolesFrom(raw: unknown): string[] {
  const values = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  const out = new Set<string>();
  for (const v of values) {
    if (typeof v !== "string") continue;
    const role = v.trim();
    if (role) out.add(role);
  }
  return [...out];
}

interface PageState {
  flash?: { tone: "ok" | "error"; message: string };
  /** Rendered ONCE, in the response to the mint that produced it. */
  minted?: { plaintext: string; record: TokenRecord };
}

async function renderTokens(
  res: Response,
  opts: TokensUiOptions,
  state: PageState,
): Promise<void> {
  let records: TokenRecord[] = [];
  let readError: string | null = null;
  try {
    records = await readTokenRecords(opts);
  } catch (err) {
    // The roster is the page; a store that cannot be read is the page's news,
    // not a 500. It is also exactly what /mcp is seeing right now, so the page
    // says so in those words — and says WHICH, since `UnreadableTokenRecords`
    // carries a sentence strad wrote (see src/auth/tokens.ts) while anything
    // else is reduced to a class name plus, for a store error, its method and
    // resource.
    readError =
      err instanceof UnreadableTokenRecords ? err.message : errorSummary(err);
  }

  res
    // `no-store` on every render, not only the mint. The mint response carries a
    // plaintext, and the roster is the gateway's access-control list — neither
    // belongs in a shared cache or a back-button snapshot. Browsers do not cache
    // a POST response and the service worker caches only the shell
    // (src/ui/pwa.ts), so this is belt and braces; it costs one header.
    .set("Cache-Control", "no-store")
    .type("html")
    .send(
      renderTokensPage({
        config: opts.config,
        records,
        readError,
        blocked: tokenWritability(opts),
        signedInAs: signedInLabel(res),
        ...state,
      }),
    );
}

export interface TokensPageOptions extends PageState {
  config: StradConfig;
  records: TokenRecord[];
  /** Why the roster is empty, when it is empty because of a failure. */
  readError: string | null;
  /** Why mint/revoke are not offered, or null when they are. */
  blocked: string | null;
  signedInAs?: string;
}

export function renderTokensPage(opts: TokensPageOptions): string {
  const { config, records, blocked } = opts;
  const live = records.filter((r) => !r.revokedAt);
  const roles = offerableRoles(config);

  const rows = [...records]
    .sort(sortRecords)
    .map((r) => {
      const revoked = Boolean(r.revokedAt);
      return `
      <div class="row secret-row">
        <span class="row-icon">${revoked ? BAN_SVG : KEY_SVG}</span>
        <span class="row-name" title="${esc(r.pubid)}"><span class="row-var">${esc(r.label)}</span><span class="row-pfx">strad_${esc(config.gateway.env)}_${esc(r.pubid)}_…</span></span>
        <span class="row-kind">${
          revoked
            ? `<span class="chip chip-off">revoked</span>`
            : `<span class="chip chip-ok">live</span>`
        }</span>
        <span class="row-note">${
          r.roles.length
            ? r.roles
                .map(
                  (role) => `<span class="chip chip-plain">${esc(role)}</span>`,
                )
                .join(" ")
            : `<span class="row-nonote">no roles — entitled to nothing</span>`
        }</span>
        <span class="row-time" title="${esc(r.createdAt ?? "unknown")}">${r.createdAt ? esc(formatTime(r.createdAt)) : "—"}</span>
        <span class="row-time"${revoked ? ` title="${esc(r.revokedAt as string)}"` : ""}>${revoked ? esc(formatTime(r.revokedAt as string)) : "—"}</span>
        <span class="row-actions">${rowActions(r, blocked)}</span>
      </div>`;
    })
    .join("\n");

  const listing = records.length
    ? `<div class="listing">
         <div class="group-label objects-label">
           <span>Tokens · ${records.length}</span>
           <span class="col-labels"><span>roles</span><span>minted</span><span>revoked</span><span>actions</span></span>
         </div>
         ${rows}
       </div>`
    : `<div class="state${opts.readError ? " state-error" : ""}">
         <div class="state-icon">${KEY_SVG}</div>
         <p class="state-title">${opts.readError ? "The token store could not be read" : "No tokens yet"}</p>
         <p class="state-sub">${
           opts.readError
             ? "This is what /mcp is seeing too: with no records it rejects every request. Nothing has been admitted."
             : "/mcp rejects every request until one exists. Mint one below."
         }</p>
         ${opts.readError ? `<p class="state-detail">${esc(opts.readError)}</p>` : ""}
       </div>`;

  const minted = opts.minted
    ? `<section class="reveal">
         <div class="reveal-head">
           <span class="reveal-title">${esc(opts.minted.record.label)}</span>
           <span class="reveal-warn">shown once · not logged · reload to lose it</span>
         </div>
         <div class="copy-row">
           <input class="copy-url" readonly value="${esc(opts.minted.plaintext)}" aria-label="the minted token" />
           <button class="copy-btn" type="button" data-copy>Copy</button>
         </div>
         <p class="copy-note">Only the SHA-256 of this was stored. strad cannot show it again, and nobody — including whoever runs this gateway — can recover it. Put it wherever the agent reads its credential from before you leave this page.</p>
       </section>`
    : "";

  const flash = opts.flash
    ? `<div class="flash flash-${opts.flash.tone}">${esc(opts.flash.message)}</div>`
    : "";

  const mintBox = blocked
    ? `<section class="addbox">
         <h2 class="addbox-title">Minting is not available on this gateway</h2>
         <p class="field-h">${esc(blocked)}</p>
         <p class="field-h">Mint one with <code>npm run token:mint</code> and add the record it prints to <code>${esc(TOKENS_VARIABLE)}</code>, then redeploy. To manage tokens from here instead, set <code>auth.staticTokens.store: parameter-store</code> (it needs <code>gateway.secrets.provider: gcp-parameter-store</code>).</p>
       </section>`
    : `<section class="addbox">
    <h2 class="addbox-title">Mint a token</h2>
    <form method="post" action="/tokens/mint" class="addform">
      <label class="field">
        <span class="field-l">Label</span>
        <input class="in" type="text" name="label" required maxlength="120" autocomplete="off"
               placeholder="tadas laptop · ci deploy probe · zimmer orchestrator" />
        <span class="field-h">Who or what holds this credential. It is the only thing the roster, the logs and a future revoke have to go on.</span>
      </label>
      <div class="field">
        <span class="field-l">Roles</span>
        ${
          roles.length
            ? roles
                .map(
                  (r) => `<label class="field field-check">
          <input type="checkbox" name="roles" value="${esc(r.role)}" />
          <span><span class="field-l">${esc(r.role)}</span> <span class="field-h">${
            r.servers.length
              ? `reaches ${r.servers.map((s) => `<code>${esc(s)}</code>`).join(", ")}`
              : "reaches no enabled server on this gateway"
          }</span></span>
        </label>`,
                )
                .join("\n")
            : `<span class="field-h">This gateway declares no roles under <code>roles:</code>, so there is nothing a token could be entitled to. Add one to the config first.</span>`
        }
        <span class="field-h">Entitlement is decided server-side from these. A request may ask for fewer servers than its roles reach, never more.</span>
      </div>
      <button class="btn btn-primary"${roles.length ? "" : " disabled"}>Mint token</button>
    </form>
  </section>`;

  const body = `
<nav class="breadcrumb"><a href="/ui" class="crumb">servers</a><span class="crumb-sep">/</span><span class="crumb crumb-current">tokens</span></nav>

<section class="browse-head">
  <div class="stat"><span class="stat-n">${live.length}</span><span class="stat-l">live</span></div>
  <div class="stat"><span class="stat-n">${records.length - live.length}</span><span class="stat-l">revoked</span></div>
  <div class="scope">
    <span class="scope-l">store</span><code>${esc(storeLabel(config))}</code>
  </div>
</section>

${flash}
${minted}
${listing}
${mintBox}
${COPY_SCRIPT}
${CONFIRM_SCRIPT}`;

  return layout({
    title: "system tokens",
    signedInAs: opts.signedInAs,
    body,
    helpTitle: "Token guide",
    help: tokensGuide(config, blocked),
  });
}

/**
 * Revoked last, then newest first.
 *
 * The list is a working surface: the thing a human came here to act on is a live
 * token, and a tombstone is history. Sorting by `createdAt` alone would scatter
 * the dead ones through the live ones as they accumulate.
 */
function sortRecords(a: TokenRecord, b: TokenRecord): number {
  const dead = Number(Boolean(a.revokedAt)) - Number(Boolean(b.revokedAt));
  if (dead !== 0) return dead;
  return (b.createdAt ?? "").localeCompare(a.createdAt ?? "");
}

/**
 * The per-row confirmation, as DATA rather than as script.
 *
 * The obvious spelling — `onsubmit="return confirm('Revoke ${esc(label)}?')"` —
 * is a stored-XSS hole, and `esc()` does not close it. A label is free text a
 * human types; `esc` turns `\'` into `&#39;`, and inside a double-quoted
 * attribute the HTML parser decodes that entity BEFORE the JavaScript is
 * compiled, so `x\'); alert(1); //` closes the string and runs. The console can
 * mint an admin `/mcp` token, so "script runs when an operator clicks Revoke"
 * is as bad as it sounds.
 *
 * So the sentence travels in an attribute VALUE, where `esc` is sufficient and
 * nothing is ever compiled, and one delegated listener reads it — the same shape
 * `COPY_SCRIPT` uses. With JavaScript off there is no confirmation and the form
 * submits, which is the pre-existing behaviour of every `onsubmit` guard in this
 * console and is why the server re-checks everything it is told.
 */
function rowActions(record: TokenRecord, blocked: string | null): string {
  if (blocked) {
    return `<button class="btn btn-ghost" disabled title="${esc(blocked)}">Read only</button>`;
  }
  const field = `<input type="hidden" name="pubid" value="${esc(record.pubid)}" />`;
  if (record.revokedAt) {
    return `<form method="post" action="/tokens/forget" class="inline"
                  data-confirm="${esc(`Forget the record for ${record.label}? It is already revoked; this only removes it from the roster.`)}">
      ${field}<button class="btn btn-ghost">Forget</button>
    </form>`;
  }
  return `<form method="post" action="/tokens/revoke" class="inline"
                data-confirm="${esc(`Revoke ${record.label}? Whatever holds it stops working on its next request, and it cannot be un-revoked.`)}">
    ${field}<button class="btn btn-danger">Revoke</button>
  </form>`;
}

/** One delegated listener for every `data-confirm` form on the page. */
const CONFIRM_SCRIPT = `<script>
document.addEventListener("submit", function (e) {
  var form = e.target;
  if (!(form instanceof HTMLFormElement)) return;
  var message = form.getAttribute("data-confirm");
  if (message && !window.confirm(message)) e.preventDefault();
});
</script>`;

/** Where the records live, in the words the config used. */
function storeLabel(config: StradConfig): string {
  return config.auth.staticTokens.store === "parameter-store"
    ? tokensParameterPath(config)
    : `${TOKENS_VARIABLE} (environment)`;
}

function tokensGuide(config: StradConfig, blocked: string | null): string {
  return `
<p>These are the credentials <code>/mcp</code> accepts. A token looks like
<code>strad_${esc(config.gateway.env)}_&lt;id&gt;_&lt;secret&gt;</code> and is presented as
<code>Authorization: Bearer …</code>. Everything else about a request — the console session, the dev
bypass — is a different door and cannot authenticate <code>/mcp</code>.</p>

<h3>Only the hash is stored</h3>
<p>The secret half is 32 random bytes. strad stores its SHA-256 and shows the plaintext exactly once,
in the response to the mint. There is no "show it again": if it is lost, revoke the record and mint
another.</p>

<h3>Revocation is soft, and final</h3>
<p>Revoking sets <code>revokedAt</code> and leaves the record in place, so the roster keeps saying that
credential existed and when it stopped working. It takes effect on the next request — this process
drops its reading of the store as part of the write, so there is no TTL to wait out. There is
deliberately no un-revoke: mint a new token instead. Once a record is revoked you can Forget it, which
is the only way to remove one.</p>

<h3>Roles decide entitlement</h3>
<p>A token's roles come from the record, server-side, and never from anything the caller sends. What a
role reaches is <code>roles:</code> in the config. A request may narrow itself with <code>?servers=</code>;
it can never widen past its roles.</p>

<h3>Where the records live</h3>
<p>${
    config.auth.staticTokens.store === "parameter-store"
      ? `In the parameter store, at <code>${esc(tokensParameterPath(config))}</code> — one secret parameter holding a JSON array. It is read on the request path, so a mint or a revoke here is live on a running gateway with no deploy and no restart.`
      : `In this container's <code>${esc(TOKENS_VARIABLE)}</code> environment variable, read once at boot. Changing it is an edit to the deployment's secret and a redeploy. Set <code>auth.staticTokens.store: parameter-store</code> to manage them from here instead.`
  }</p>
${blocked ? `<p><strong>This gateway is read-only here.</strong> ${esc(blocked)}</p>` : ""}

<h3>There is no agent equivalent of this page</h3>
<p>Deliberately. A tool that mints <code>/mcp</code> credentials would let any token that reached it mint
a stronger one; a tool that revokes them could lock every agent out. Both are human actions behind
Google SSO, the same way the secret write surface is.</p>`;
}

/**
 * The unexpected-failure page.
 *
 * Its own, rather than the secrets console's `renderUnexpected`: that one talks
 * about parameters and namespaces, and a reader who lands on it from here would
 * be told to check something that has nothing to do with what they clicked.
 */
function unexpected(res: Response, err: unknown): void {
  console.error(`[strad] /tokens failed: ${errorSummary(err)}`);
  res
    .status(500)
    .type("html")
    .send(
      layout({
        title: "tokens · error",
        body: `<div class="state state-error">
        <p class="state-title">Something went wrong</p>
        <p class="state-sub">No record was changed — every write here refuses before it writes rather than half-way through. Try again; if it keeps happening, the gateway's logs carry the reason.</p>
        <p class="state-detail">${esc(errorSummary(err))}</p>
        <p class="state-links"><a href="/tokens">Back to tokens</a></p>
      </div>`,
      }),
    );
}

const KEY_SVG = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="8" cy="12" r="4" stroke="currentColor" stroke-width="1.5"/><path d="M12 12h8M17.5 12v3M20 12v2.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;
const BAN_SVG = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="8.5" stroke="currentColor" stroke-width="1.5"/><path d="M6 18L18 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;
