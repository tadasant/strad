import { esc, layout } from "./render.ts";

/**
 * The two pages a human sees inside the `/mcp` OAuth flow.
 *
 * There are exactly two, and both exist because the alternative is a redirect
 * carrying an error code into a client that will render it as "connection
 * failed".
 *
 * **Consent.** Registration at this authorization server is open
 * (`src/auth/mcp-oauth/clients.ts`), and so are client id metadata documents
 * (`src/auth/mcp-oauth/cimd.ts`), so any client can arrive with a name and a
 * redirect URI. A registered client chose both for itself; a metadata-document
 * client's are published by the host that serves its document, and the screen
 * names that host, because it is the one thing about the client a caller
 * cannot pick. Google's consent
 * screen cannot help here: it asks whether the human trusts STRAD, which they
 * do — it says nothing about the third party that sent them. This screen is
 * where the name and the destination of that third party are put in front of
 * the person before a token exists, which is the whole reason an authorization
 * server has one.
 *
 * **Refusal.** A non-member of the Workspace domain has done nothing wrong and
 * cannot fix anything by retrying; what they need is the sentence that says so.
 * Redirecting them back with `error=access_denied` would put that sentence
 * nowhere — the client would show its own generic failure, and the human would
 * be left guessing whether they used the wrong account or strad is broken.
 *
 * Both use the console's `layout()`, so the pages a human meets on strad's
 * domain look like strad rather than like a raw framework error, and neither is
 * behind the console's SSO gate — they are reached mid-flow, by someone who by
 * definition does not have a console session.
 */

export interface ConsentPageOptions {
  /** The client's registered `client_name`, when it declared one. */
  clientName?: string;
  /**
   * For a metadata-document client, the host that serves the document. Absent
   * for a dynamically registered client, whose name nobody vouched for.
   */
  clientHost?: string;
  /** The host of the redirect URI the code would be delivered to. */
  redirectHost: string;
  /**
   * The code goes to a listener on the human's own machine. A metadata
   * document cannot vouch for one of those: any local program can present a
   * well-known client's URL and listen on its port.
   */
  loopbackRedirect?: boolean;
  /** The Google account that just authenticated. */
  email: string;
  /** The resource the grant is for — the canonical `/mcp` URL. */
  resource: string;
  /** The roles the grant carries — the client's ceiling. */
  roles: string[];
  /**
   * The slugs the grant would reach, one checkbox each, all ticked. Unticking
   * narrows the grant to the rest. Absent renders the page without the list.
   */
  slugs?: string[];
  /** True when the CLIENT asked for these slugs by `slug:` scope. */
  narrowed?: boolean;
  /** The operator's name for a client listed in `auth.mcpOAuth.clients`. */
  configuredName?: string;
  /** The encrypted pending-grant blob, posted back to `/oauth/approve`. */
  approval: string;
  /** Where the decision is posted. */
  action: string;
}

export function renderConsent(opts: ConsentPageOptions): string {
  const who = opts.clientName ? esc(opts.clientName) : "An MCP client";
  /** The same, for the middle of a sentence. */
  const whoInline = opts.clientName ? who : "an MCP client";
  const identifiedBy = opts.clientHost
    ? `published by <code>${esc(opts.clientHost)}</code>`
    : `self-registered — the name is the client's own claim`;
  const loopbackWarning = opts.loopbackRedirect
    ? `
  <p class="state-detail consent-warning">
    The code goes to a program on this computer, not to a website. Any program
    on this machine can claim to be ${whoInline} that way${
      opts.clientHost
        ? `, whatever <code>${esc(opts.clientHost)}</code> publishes`
        : ""
    }. Approve only if you started this yourself, just now, from ${whoInline} on this
    computer.
  </p>`
    : "";
  const slugList = opts.slugs
    ? opts.slugs.length
      ? `
  <fieldset class="card consent-detail consent-slugs">
    <legend>${
      opts.narrowed
        ? `Servers ${whoInline} asked for`
        : `Servers this connection would reach`
    }</legend>
    <input type="hidden" name="slug_choice" value="1" />
    <p class="state-detail">Untick any it should not reach. The token is confined to the ones left ticked.</p>
    ${opts.slugs
      .map(
        (slug) =>
          `<label><input type="checkbox" name="slug" value="${esc(slug)}" checked /> <code>${esc(slug)}</code></label>`,
      )
      .join("\n    ")}
  </fieldset>`
      : `
  <p class="state-detail">This client's roles reach no servers, so the grant will reach none.</p>`
    : "";
  const configured = opts.configuredName
    ? `<dt>Configured as</dt><dd>${esc(opts.configuredName)} — listed by this gateway's operator</dd>`
    : "";
  const roles = opts.roles.length
    ? opts.roles.map((r) => `<code>${esc(r)}</code>`).join(" ")
    : `<span class="state-detail">none — this grant will reach no servers</span>`;

  const body = `
<div class="state consent">
  <p class="state-title">Connect ${who} to strad?</p>
  <p class="state-sub">
    It is asking to call strad's MCP endpoint as <strong>${esc(opts.email)}</strong>.
    Approving sends an authorization code to <code>${esc(opts.redirectHost)}</code>,
    which it exchanges for a token.
  </p>
  <div class="card consent-detail">
    <dl>
      <dt>Client</dt><dd>${who}, ${identifiedBy}</dd>
      ${configured}
      <dt>Endpoint</dt><dd><code>${esc(opts.resource)}</code></dd>
      <dt>Signed in as</dt><dd>${esc(opts.email)}</dd>
      <dt>Delivered to</dt><dd><code>${esc(opts.redirectHost)}</code></dd>
      <dt>Roles</dt><dd>${roles}</dd>
    </dl>
  </div>${loopbackWarning}
  <p class="state-detail">
    Only approve this if you started it. The token is short-lived and refreshes
    until you revoke strad's access to your Google account.
  </p>
  <form method="post" action="${esc(opts.action)}" class="consent-form">${slugList}
    <input type="hidden" name="approval" value="${esc(opts.approval)}" />
    <div class="consent-actions">
    <button class="btn btn-danger" type="submit" name="decision" value="deny">Deny</button>
    <button class="btn btn-primary" type="submit" name="decision" value="allow">Approve</button>
    </div>
  </form>
</div>
<style>
.consent-detail{max-width:30rem;width:100%;text-align:left;margin:.4rem 0}
.consent-detail dl{display:grid;grid-template-columns:auto 1fr;gap:.35rem .9rem;margin:0}
.consent-detail dt{color:var(--g3);font-size:.82rem}
.consent-detail dd{margin:0;color:var(--g1);font-size:.86rem;overflow-wrap:anywhere}
.consent-actions{display:flex;gap:.6rem;margin-top:.8rem}
.consent-warning{max-width:30rem;color:var(--g1)}
.consent-form{display:flex;flex-direction:column;align-items:center;width:100%}
.consent-slugs{border:1px solid var(--g4,#ccc);padding:.6rem .9rem;display:flex;flex-direction:column;gap:.25rem;max-height:18rem;overflow:auto}
.consent-slugs legend{color:var(--g3);font-size:.82rem;padding:0 .3rem}
.consent-slugs label{font-size:.86rem;color:var(--g1)}
</style>`;

  return layout({
    title: "Authorize",
    body,
    nav: false,
    brandHref: "/",
    brandSub: "authorize",
    footLead: "strad · MCP authorization",
    footNote: "OAuth 2.1 · authorization request",
  });
}

/**
 * The refusal. It names the domain and the account, because "restricted to
 * tadasant.com" plus "you are signed in as x@gmail.com" is the whole diagnosis
 * and the fix is to sign in again with the other account.
 */
export function renderDomainRefusal(opts: {
  hostedDomain: string;
  email?: string;
  clientName?: string;
}): string {
  const body = `
<div class="state state-error">
  <p class="state-title">This gateway is restricted to ${esc(opts.hostedDomain)} accounts</p>
  <p class="state-sub">
    ${
      opts.email
        ? `You signed in as <strong>${esc(opts.email)}</strong>, which is not a
           member of the <code>${esc(opts.hostedDomain)}</code> Google Workspace.`
        : `The account you signed in with is not a member of the
           <code>${esc(opts.hostedDomain)}</code> Google Workspace.`
    }
    No token has been issued${opts.clientName ? ` to ${esc(opts.clientName)}` : ""}.
  </p>
  <p class="state-sub">
    If you have a ${esc(opts.hostedDomain)} account, start the connection again
    and pick it at Google's account chooser.
  </p>
</div>`;

  return layout({
    title: "Not authorized",
    body,
    nav: false,
    brandHref: "/",
    brandSub: "authorize",
    footLead: "strad · MCP authorization",
    footNote: "OAuth 2.1 · authorization refused",
  });
}

/**
 * Everything that goes wrong BEFORE strad is willing to redirect.
 *
 * An unreadable `client_id` or a `redirect_uri` that is not one the client
 * registered must not be redirected to — that is the open-redirect the exact
 * match in `resolveRedirectUri` exists to prevent, and bouncing an error to an
 * unverified URI would hand it back. So those two are rendered here instead.
 */
export function renderAuthorizeError(opts: {
  heading: string;
  detail: string;
}): string {
  const body = `
<div class="state state-error">
  <p class="state-title">${esc(opts.heading)}</p>
  <p class="state-sub">${esc(opts.detail)}</p>
  <p class="state-detail">strad did not redirect you, because the address it was given could not be verified.</p>
</div>`;
  return layout({
    title: "Authorization failed",
    body,
    nav: false,
    brandHref: "/",
    brandSub: "authorize",
    footLead: "strad · MCP authorization",
    footNote: "OAuth 2.1 · authorization request",
  });
}
