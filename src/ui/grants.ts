import express, {
  type Express,
  type RequestHandler,
  type Response,
} from "express";
import type { GrantRecord } from "../auth/mcp-oauth/grant-store.ts";
import { grantDeadline, type McpOAuth } from "../auth/mcp-oauth/index.ts";
import { asyncRoute } from "../http/async-route.ts";
import { event } from "../telemetry/index.ts";
import { errorSummary } from "../util/error-text.ts";
import { refuseTokenSession, signedInLabel } from "./console-auth.ts";
import { esc, formatTime, layout } from "./render.ts";

/**
 * `/tokens/grants` — the OAuth grants strad's authorization server holds a
 * record for (`src/auth/mcp-oauth/grant-store.ts`), and a Revoke on each.
 *
 * Routes:
 *   GET  /tokens/grants         — every record: client, account, slugs, when it
 *                                 was created and last used, its deadline
 *   POST /tokens/grants/revoke  — revoke one grant (and every child under it)
 *
 * Under the tokens destination rather than one of its own: it is the same
 * question — which credentials does `/mcp` accept, and how do I stop one — for
 * the other kind of credential.
 *
 * ## Why there is no `/mcp` counterpart
 *
 * For the reason `/tokens` has none (`src/ui/tokens.ts`): a revoke tool is a
 * denial-of-service primitive against the gateway's own front door, and the
 * list is every account and client holding a grant. The agent-side door to
 * revocation already exists and is the standard one — `POST /oauth/revoke`
 * (RFC 7009), where possessing a token is the authority to revoke it.
 *
 * ## CSRF
 *
 * The same argument as `/tokens`: the console session is a SameSite=Lax
 * cookie, so a cross-site form POST arrives without it and the gate refuses it.
 */

export interface GrantsUiOptions {
  oauth: McpOAuth | null;
}

export function mountGrantsConsole(
  app: Express,
  gate: RequestHandler,
  opts: GrantsUiOptions,
): void {
  const form = express.urlencoded({ extended: false, limit: "16kb" });

  app.get(
    "/tokens/grants",
    gate,
    asyncRoute(async (_req, res) => {
      await renderGrants(res, opts, {});
    }, unexpected),
  );

  app.post(
    "/tokens/grants/revoke",
    gate,
    refuseTokenSession,
    form,
    asyncRoute(async (req, res) => {
      const grants = opts.oauth?.grants;
      const body = req.body as Record<string, unknown>;
      const gid = typeof body.gid === "string" ? body.gid.trim() : "";
      if (!grants) {
        res.status(404);
        await renderGrants(res, opts, {
          flash: { tone: "error", message: "Grant records are off here." },
        });
        return;
      }
      if (!/^[A-Za-z0-9_-]{16,64}$/.test(gid)) {
        res.status(400);
        await renderGrants(res, opts, {
          flash: { tone: "error", message: "That is not a grant id." },
        });
        return;
      }
      let done: boolean;
      try {
        done = await grants.store.revoke(gid, "console");
      } catch (err) {
        res.status(503);
        await renderGrants(res, opts, {
          flash: {
            tone: "error",
            message:
              "The grant store did not take the revocation. This gateway " +
              `already refuses the grant, but a restart would forget that. ` +
              `Try again. (${errorSummary(err)})`,
          },
        });
        return;
      }
      if (done)
        event({ evt: "mcp_oauth.grant", action: "revoked", reason: "console" });
      res.status(done ? 200 : 404);
      await renderGrants(res, opts, {
        flash: done
          ? {
              tone: "ok",
              message: `Revoked grant ${gid}. Its access tokens stop working on their next request, and its refresh token is refused.`,
            }
          : { tone: "error", message: `No grant ${gid}.` },
      });
    }, unexpected),
  );
}

interface Flash {
  tone: "ok" | "error";
  message: string;
}

async function renderGrants(
  res: Response,
  opts: GrantsUiOptions,
  extra: { flash?: Flash },
): Promise<void> {
  const grants = opts.oauth?.grants ?? null;
  let records: GrantRecord[] = [];
  let readError: string | null = null;
  if (grants) {
    try {
      records = await grants.store.list();
    } catch (err) {
      readError = errorSummary(err);
    }
  }
  res.type("html").send(
    renderGrantsPage({
      oauth: opts.oauth,
      records,
      readError,
      ...(extra.flash ? { flash: extra.flash } : {}),
      signedInAs: signedInLabel(res),
    }),
  );
}

export interface GrantsPageOptions {
  oauth: McpOAuth | null;
  records: GrantRecord[];
  readError: string | null;
  flash?: Flash;
  signedInAs?: string;
  now?: number;
}

export function renderGrantsPage(opts: GrantsPageOptions): string {
  const { oauth, records } = opts;
  const grants = oauth?.grants ?? null;
  const now = opts.now ?? Date.now();
  const flash = opts.flash
    ? `<div class="flash flash-${opts.flash.tone}">${esc(opts.flash.message)}</div>`
    : "";

  if (!oauth || !grants) {
    const body = `
${flash}
<div class="state">
  <p class="state-title">${oauth ? "Grant records are off" : "This gateway is not an OAuth authorization server"}</p>
  <p class="state-sub">${
    oauth
      ? "OAuth grants here are stateless: their tokens are sealed values strad keeps no record of, so there is nothing to list, refresh tokens do not rotate, and revoking one revokes the account's Google grant — every connector at once. Set <code>auth.mcpOAuth.grants.enabled: true</code> to give each new grant a record."
      : "<code>auth.mcpOAuth</code> is off, or cannot run, on this deployment."
  }</p>
  <p class="state-links"><a href="/tokens">Back to tokens</a></p>
</div>`;
    return layout({
      title: "oauth grants",
      signedInAs: opts.signedInAs,
      body,
      nav: "tokens",
    });
  }

  // A child is live only while every ancestor is, which is what `/mcp`
  // enforces; a parent this list does not hold (swept) counts as dead.
  const byGid = new Map(records.map((r) => [r.gid, r]));
  const live = (r: GrantRecord, depth = 0): boolean => {
    if (r.state !== "active" || depth > 8) return false;
    const deadline = grantDeadline(r, oauth.policies.forFingerprint(r.cid));
    if (deadline !== null && deadline <= now) return false;
    if (!r.parentGid) return true;
    const parent = byGid.get(r.parentGid);
    return parent !== undefined && live(parent, depth + 1);
  };
  const sorted = [...records].sort(
    (a, b) => Number(live(b)) - Number(live(a)) || b.createdAt - a.createdAt,
  );
  const liveCount = records.filter(live).length;

  const rows = sorted
    .map((r) => {
      const policy = oauth.policies.forFingerprint(r.cid);
      const deadline = grantDeadline(r, policy);
      const client =
        (policy?.listed && policy.name) || r.clientName || "unnamed client";
      const status =
        r.state === "active" && r.parentGid && !live(r)
          ? `<span class="chip chip-off">parent ended</span>`
          : statusChip(r, deadline, now);
      const lastUsed = grants.store.lastUsed(r);
      const slugs = r.slugs
        ? r.slugs.map((s) => `<code>${esc(s)}</code>`).join(" ")
        : `<span class="row-nonote">all its client may reach (mcp)</span>`;
      return `
      <div class="row secret-row">
        <span class="row-name" title="${esc(r.gid)}"><span class="row-var">${esc(client)}</span><span class="row-pfx">${esc(r.identity.email)}${r.exchange ? ` · child token${r.exchange.label ? ` <code>${esc(r.exchange.label)}</code>` : ""}` : ""}${r.parentGid ? ` · under ${esc(r.parentGid)}` : ""}${r.fromLegacy ? " · upgraded" : ""}</span></span>
        <span class="row-kind">${status}</span>
        <span class="row-note">${slugs}</span>
        <span class="row-time" title="${esc(iso(r.createdAt))}">${esc(formatTime(iso(r.createdAt)))}</span>
        <span class="row-time"${lastUsed ? ` title="${esc(iso(lastUsed))}"` : ""}>${lastUsed ? esc(formatTime(iso(lastUsed))) : "—"}</span>
        <span class="row-time"${deadline ? ` title="${esc(iso(deadline))}"` : ""}>${deadline ? esc(new Date(deadline).toISOString().slice(0, 16).replace("T", " ")) : "never"}</span>
        <span class="row-actions">${
          r.state === "revoked"
            ? ""
            : `<form method="post" action="/tokens/grants/revoke" class="inline" data-confirm="${esc(
                r.exchange
                  ? `Revoke this child token for ${client}${r.exchange.label ? ` (label ${r.exchange.label})` : ""}? It stops working on its next request; its parent grant is untouched.`
                  : `Revoke this grant for ${client} (${r.identity.email})? Its tokens stop working on their next request, and the client has to sign in again.`,
              )}">
            <input type="hidden" name="gid" value="${esc(r.gid)}" /><button class="btn btn-danger">Revoke</button>
          </form>`
        }</span>
      </div>`;
    })
    .join("\n");

  const listing = records.length
    ? `<div class="listing">
         <div class="group-label objects-label">
           <span>Grants · ${records.length}</span>
           <span class="col-labels"><span>status</span><span>slugs</span><span>created</span><span>last used</span><span>expires (UTC)</span><span>actions</span></span>
         </div>
         ${rows}
       </div>`
    : `<div class="state${opts.readError ? " state-error" : ""}">
         <p class="state-title">${opts.readError ? "The grant store could not be read" : "No grants yet"}</p>
         <p class="state-sub">${
           opts.readError
             ? "Record-backed tokens whose grant is not already cached in this process are failing while this lasts. Nothing has been admitted."
             : "A grant appears here when someone connects an MCP client through the OAuth flow."
         }</p>
         ${opts.readError ? `<p class="state-detail">${esc(opts.readError)}</p>` : ""}
       </div>`;

  const body = `
<section class="browse-head">
  <div class="stat"><span class="stat-n">${liveCount}</span><span class="stat-l">live</span></div>
  <div class="stat"><span class="stat-n">${records.length - liveCount}</span><span class="stat-l">ended</span></div>
  <div class="scope">
    <span class="scope-l">store</span><code>${esc(grants.store.kind)}</code>
    <span class="scope-l">legacy tokens</span><code>${esc(grants.legacy)}</code>
  </div>
</section>
${flash}
${listing}
<p class="state-links"><a href="/tokens">System tokens</a></p>
<script>
document.addEventListener("submit", function (e) {
  var form = e.target;
  if (!(form instanceof HTMLFormElement)) return;
  var message = form.getAttribute("data-confirm");
  if (message && !window.confirm(message)) e.preventDefault();
});
</script>`;

  return layout({
    title: "oauth grants",
    signedInAs: opts.signedInAs,
    body,
    nav: "tokens",
    helpTitle: "Grants guide",
    help: `
<p>Each row is one OAuth grant: one account's consent to one MCP client. Its refresh token rotates on
every use; presenting a spent one again revokes the grant, because that is what a stolen copy looks like.</p>
<h3>Revoking</h3>
<p>Revoke here, or have the client call <code>POST /oauth/revoke</code>. It ends this grant and every
grant minted under it, on their next request. Other grants — other connectors for the same account —
are untouched. Nothing is revoked at Google.</p>
<h3>Child tokens</h3>
<p>A row marked <em>child token</em> was minted by a confidential client through token exchange
(RFC 8693) under the grant it names: one access token, no refresh token, a subset of the grant's slugs.
Its label is the client's own tag for it — Zimmer sends the agent session id. Revoking a child ends only
that token; revoking its parent ends every child under it.</p>
<h3>Last used</h3>
<p>The last refresh is recorded durably; use at <code>/mcp</code> is tracked by this process only, so
after a restart "last used" falls back to the last refresh.</p>
<h3>Stateless tokens are not listed</h3>
<p>Tokens issued without a record (before records were on) have nothing to list. They are governed by
<code>auth.mcpOAuth.grants.legacyTokens</code>.</p>`,
  });
}

function statusChip(
  r: GrantRecord,
  deadline: number | null,
  now: number,
): string {
  if (r.state === "revoked") {
    return `<span class="chip chip-off" title="${esc(r.revokedReason ?? "")}">revoked</span>`;
  }
  if (r.state === "pending") {
    return `<span class="chip chip-plain">pending</span>`;
  }
  if (deadline !== null && deadline <= now) {
    return `<span class="chip chip-off">expired</span>`;
  }
  return `<span class="chip chip-ok">live</span>`;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function unexpected(res: Response, err: unknown): void {
  console.error(`[strad] /tokens/grants failed: ${errorSummary(err)}`);
  res
    .status(500)
    .type("html")
    .send(
      layout({
        title: "grants · error",
        nav: "tokens",
        body: `<div class="state state-error">
        <p class="state-title">Something went wrong</p>
        <p class="state-detail">${esc(errorSummary(err))}</p>
        <p class="state-links"><a href="/tokens/grants">Back to grants</a></p>
      </div>`,
      }),
    );
}
