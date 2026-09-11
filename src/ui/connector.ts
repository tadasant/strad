import type { Express, Request, RequestHandler, Response } from "express";
import type { StradConfig } from "../config/schema.ts";
import { asyncRoute } from "../http/async-route.ts";
import type { SecretBag } from "../secrets/index.ts";
import type { ConsoleSessions } from "../auth/session.ts";
import { sanitizeNext, stateMatches } from "../auth/session.ts";
import {
  consolePrincipal,
  refuseTokenSession,
  signedInLabel,
} from "./console-auth.ts";
import { esc, layout, renderMessage } from "./render.ts";
import { SERVER_ROUTE, serverConsolePath } from "./paths.ts";
import { event } from "../telemetry/index.ts";
import {
  clearConnectorTx,
  consoleSessionId,
  issueConnectorTx,
  readConnectorTx,
  type ConnectorTxPayload,
} from "../connectors/state.ts";
import {
  buildAuthorizeUrl,
  connectorFor,
  connectorRedirectUri,
  connectorStore,
  connectorTier,
  connectionNote,
  ConnectorError,
  unexpectedScopes,
  exchangeCode,
  readConnectorState,
  refreshTokenPath,
  requestedScopes,
  storeRefreshToken,
  type ConnectorDeps,
  type ConnectorErrorCode,
  type ConnectorServer,
  type ConnectorState,
} from "../connectors/index.ts";
import { CONNECTOR_CALLBACK_PATH } from "../connectors/index.ts";
import { errorSummary } from "../util/error-text.ts";
import {
  parameterPath,
  type ParameterStore,
} from "../secrets/parameters/index.ts";

/**
 * **Connect Google** / **Reconnect Google**, on a server slug's console page.
 *
 * The whole flow, in the order it happens:
 *
 *   POST /ui/<slug>/connect      seal a transaction, 302 to accounts.google.com
 *   GET  /ui/oauth/callback      verify, exchange, check, write, 302 back
 *   GET  /ui/<slug>              render the panel, in one of five states
 *
 * ## What the browser is allowed to say
 *
 * Almost nothing. The connect POST carries no fields at all — the slug is a path
 * parameter that must name a server whose CONFIG declares a connector, and every
 * other term of the grant (the account, the scopes, the target variable, the
 * redirect URI) is read out of that config. The callback carries an authorization
 * code and an opaque `state`, and the state is only ever compared, never parsed
 * for meaning. There is no request either route accepts that names a parameter
 * path, a variable, an email, a scope or another slug.
 *
 * ## What never leaves this file
 *
 * The authorization code, the access token, the refresh token and the client
 * secret. None is rendered, redirected with, returned as JSON, put in a URL,
 * logged, evented, counted or length-hinted. The success redirect carries
 * `?connected=1` and the failure redirect carries a code from a closed set of
 * strad's own words; both are booleans-in-spirit, and the page rebuilds its
 * sentence from config.
 *
 * ## Why the callback is behind the gate
 *
 * It could be public — completing it needs a sealed transaction bound to an
 * authenticated session, so a stranger reaching the route learns nothing. Gating
 * it anyway is strictly stronger and costs nothing: the browser returns from
 * Google as a top-level GET, which carries the SameSite=Lax session cookie, so
 * the human who started the flow is still signed in when they land.
 */

export interface ConnectorUiOptions extends ConnectorDeps {
  config: StradConfig;
  secrets: SecretBag;
  env: NodeJS.ProcessEnv;
  sessions?: ConsoleSessions | null;
  /**
   * Test seam: the transport the TOKEN EXCHANGE uses. Defaults to fetch.
   *
   * Its own seam rather than the console's `fetchImpl` (which is the bundle
   * presence probe's) because they stub different third parties, and a test that
   * had to fake Google in order to fake a bundle would fake neither well. This is
   * what lets the end-to-end test drive a fake Google token service through the
   * real Express app, real cookies, real sealed state and the real store.
   */
  connectorFetch?: typeof fetch;
}

/** Mount the two connector routes. `gate` is the console's SSO middleware. */
export function mountConnector(
  app: Express,
  gate: RequestHandler,
  opts: ConnectorUiOptions,
): void {
  // BEFORE `/ui/:server`, so a deployment that ever configured a slug called
  // `oauth` cannot shadow the callback. Two segments would not match `/ui/:server`
  // anyway; ordering it here means that stays true if the route ever gains an
  // optional segment.
  app.get(
    CONNECTOR_CALLBACK_PATH,
    gate,
    asyncRoute((req, res) => handleCallback(req, res, opts), renderUnexpected),
  );

  // POST, not GET: it mints a transaction and redirects to a third party, and a
  // GET would be reachable from an <img> tag on any page in the world. The
  // session cookie is SameSite=Lax, so a cross-site POST arrives with no cookie
  // and the gate 401s it — the same CSRF posture as every other console write.
  app.post(
    `${SERVER_ROUTE}/connect`,
    gate,
    refuseTokenSession,
    asyncRoute((req, res) => handleConnect(req, res, opts), renderUnexpected),
  );
}

// ---------------------------------------------------------------------------
// POST /ui/:server/connect
// ---------------------------------------------------------------------------

async function handleConnect(
  req: Request,
  res: Response,
  opts: ConnectorUiOptions,
): Promise<void> {
  const slug = req.params.server ?? "";
  const signedInAs = signedInLabel(res);
  const entry = connectorFor(opts.config, slug);

  if (!entry) {
    res
      .status(404)
      .type("html")
      .send(
        renderMessage({
          title: "Not found",
          signedInAs,
          heading: "No connector on this server",
          sub: `"${slug}" does not declare an oauth: connector on this gateway.`,
          tone: "warn",
          breadcrumbToIndex: true,
        }),
      );
    return;
  }

  const sealer = opts.sessions?.connector;
  const redirectUri = connectorRedirectUri(opts.config);
  if (!sealer || !redirectUri) {
    await renderConnectorPage(res, opts, entry, {
      signedInAs,
      status: 503,
      flash: {
        tone: "error",
        message: !redirectUri
          ? "This deployment declares no gateway.publicUrl, so strad cannot " +
            "build the exact redirect URI Google requires."
          : "This deployment has no console session key, so strad cannot seal " +
            "an authorization transaction. Set CONSOLE_SESSION_SECRET.",
      },
    });
    return;
  }

  // The state must be REFUSED before it is sealed if the setup is incomplete —
  // otherwise a human consents at Google and comes back to a flow that cannot
  // exchange, having granted access for nothing.
  const state = await readConnectorState(opts, entry);
  if (state.kind !== "ready" && state.kind !== "connected") {
    await renderConnectorPage(res, opts, entry, {
      signedInAs,
      status: 409,
      state,
      flash: {
        tone: "error",
        message:
          "This connector is not ready to authorize. See the setup below.",
      },
    });
    return;
  }

  const resolved = connectorStore(opts, entry);
  if (!resolved.store) {
    await renderConnectorPage(res, opts, entry, {
      signedInAs,
      status: 503,
      state,
      flash: { tone: "error", message: resolved.reason },
    });
    return;
  }

  const scopes = requestedScopes(entry.oauth);

  // Guarded, so a store failure is this page saying so rather than the generic
  // 500 — and so the message describes the OPERATION. `renderUnexpected` is the
  // catch of last resort, not the handler for the one call here that talks to a
  // third party.
  let clientId: string;
  try {
    clientId = await readOwnVariable(
      opts,
      resolved.store,
      entry,
      entry.oauth.clientIdVariable,
    );
  } catch {
    await renderConnectorPage(res, opts, entry, {
      signedInAs,
      status: 503,
      state,
      flash: {
        tone: "error",
        message:
          "strad could not read this server's OAuth client id from its own " +
          "namespace, so it cannot begin an authorization. Nothing was written.",
      },
    });
    return;
  }

  const pending = buildAuthorizeUrl({
    clientId,
    redirectUri,
    scopes,
    loginHint: entry.oauth.account,
  });

  issueConnectorTx(
    res,
    sealer,
    {
      state: pending.state,
      verifier: pending.verifier,
      slug: entry.server.slug,
      env: opts.config.gateway.env,
      account: entry.oauth.account,
      scopes,
      variable: entry.oauth.refreshTokenVariable,
      sid: consoleSessionId(consolePrincipal(res)),
      next: serverConsolePath(entry.server.slug),
    },
    opts.env,
  );

  event({ evt: "strad.connector_begin", slug: entry.server.slug });
  res.redirect(302, pending.url);
}

// ---------------------------------------------------------------------------
// GET /ui/oauth/callback
// ---------------------------------------------------------------------------

async function handleCallback(
  req: Request,
  res: Response,
  opts: ConnectorUiOptions,
): Promise<void> {
  const signedInAs = signedInLabel(res);
  const sealer = opts.sessions?.connector;
  const tx = sealer ? readConnectorTx(sealer, req.headers.cookie) : null;

  // Spend the transaction whatever happens next: a stale tab must not be able to
  // re-enter the flow, and the verifier should live no longer than one attempt.
  clearConnectorTx(res, opts.env);

  const refuse = (heading: string, sub: string, status = 400): void => {
    res
      .status(status)
      .type("html")
      .send(
        renderMessage({
          title: "Authorization refused",
          signedInAs,
          heading,
          sub,
          tone: "error",
          breadcrumbToIndex: true,
        }),
      );
  };

  // No transaction: a stale tab, a forgery, or a flow begun more than ten
  // minutes ago. None of them is an authorization, and none of them can be told
  // apart from the others without saying more than a refusal should.
  if (!tx) {
    refuse(
      "No authorization in progress",
      "strad has no record of a connector authorization for this browser. It " +
        "may have expired (they last ten minutes), already been completed, or " +
        "been begun somewhere else. Start again from the server's page.",
    );
    return;
  }

  // The state in the URL must be the one sealed for THIS browser. The signature
  // proves the cookie is strad's; this proves the callback is its partner.
  if (!stateMatches(String(req.query.state ?? ""), tx.state)) {
    refuse(
      "That authorization does not match",
      "The value Google returned is not the one strad issued for this browser. " +
        "Nothing was written. Start again from the server's page.",
    );
    return;
  }

  // The transaction is bound to the console session that began it. A transaction
  // cookie on its own is not an authorization.
  if (tx.sid !== consoleSessionId(consolePrincipal(res))) {
    refuse(
      "That authorization belongs to another session",
      "The console session that began this authorization is not the one " +
        "completing it. Nothing was written.",
      403,
    );
    return;
  }

  // A transaction sealed against another deployment cannot spend itself here.
  // The parameter path is composed from this value, so it is checked and not
  // merely carried.
  if (tx.env !== opts.config.gateway.env) {
    refuse(
      "That authorization belongs to another deployment",
      `It was begun against "${tx.env}" and this gateway is ` +
        `"${opts.config.gateway.env}". Nothing was written.`,
      403,
    );
    return;
  }

  const entry = connectorFor(opts.config, tx.slug);
  if (!entry) {
    refuse(
      "That server no longer has a connector",
      `"${tx.slug}" does not declare an oauth: connector on this ` +
        `gateway any more. Nothing was written.`,
      409,
    );
    return;
  }

  // The config may have been edited while the human was at Google. The terms the
  // human was SHOWN are the ones sealed; if the config now says something else,
  // the honest move is to refuse rather than to install a grant against terms
  // nobody agreed to.
  const scopes = requestedScopes(entry.oauth);
  const drifted =
    entry.oauth.account !== tx.account ||
    entry.oauth.refreshTokenVariable !== tx.variable ||
    scopes.length !== tx.scopes.length ||
    scopes.some((s, i) => s !== tx.scopes[i]);
  if (drifted) {
    refuse(
      "This server's connector changed mid-flow",
      "The account, scopes or target variable configured for this server are " +
        "not the ones this authorization was begun under. Nothing was written. " +
        "Start again from the server's page.",
      409,
    );
    return;
  }

  const redirectUri = connectorRedirectUri(opts.config);
  const resolved = connectorStore(opts, entry);
  if (!redirectUri || !resolved.store) {
    refuse(
      "strad cannot complete this authorization",
      redirectUri
        ? (resolved as { reason: string }).reason
        : "This deployment declares no gateway.publicUrl, so strad cannot " +
            "present the exact redirect URI Google requires.",
      503,
    );
    return;
  }
  const store = resolved.store;

  // ONE listing, read BEFORE the exchange, answering two questions: is the OAuth
  // application still seeded for this slug (refuse early rather than after a
  // human has granted access for nothing), and does the target parameter already
  // exist — which is what makes this a rotate rather than a create.
  const state = await readConnectorState(opts, entry);
  if (state.kind !== "ready" && state.kind !== "connected") {
    refuse(
      "This connector is no longer ready",
      state.kind === "incomplete"
        ? `${state.missing.join(" and ")} went missing from this server's own ` +
            `namespace while the authorization was in progress. Nothing was written.`
        : "strad cannot reach the parameter store this connector writes to. " +
            "Nothing was written.",
      state.kind === "incomplete" ? 409 : 503,
    );
    return;
  }

  const back = (query: string): void => {
    res.redirect(302, `${sanitizeNext(tx.next)}${query}`);
  };

  try {
    const grant = await exchangeCode(
      {
        clientId: await readOwnVariable(
          opts,
          store,
          entry,
          entry.oauth.clientIdVariable,
        ),
        clientSecret: await readOwnVariable(
          opts,
          store,
          entry,
          entry.oauth.clientSecretVariable,
        ),
        redirectUri,
        code: String(req.query.code ?? ""),
        verifier: tx.verifier,
        expectedAccount: entry.oauth.account,
        requiredScopes: entry.oauth.scopes,
      },
      opts.connectorFetch ?? fetch,
    );

    // NOTHING REACHED THE STORE UNTIL HERE. Identity verified, account matched,
    // every required scope granted, a refresh token in hand.
    const widened = unexpectedScopes(
      requestedScopes(entry.oauth),
      grant.grantedScopes,
    );
    await storeRefreshToken(
      store,
      refreshTokenPath(opts.config, entry),
      state.kind === "connected",
      grant.refreshToken,
      connectionNote(grant.email, grant.grantedScopes, new Date()),
    );

    event({
      evt: "strad.connector_connected",
      slug: entry.server.slug,
      variable: entry.oauth.refreshTokenVariable,
    });
    // A grant WIDER than the config asked for is stored — see
    // `unexpectedScopes` for why refusing it would cry wolf — but the page must
    // not go on calling this slug read-only over a credential Google will honour
    // writes for. `1` is a boolean; the page reads the scopes from the note.
    back(widened.length > 0 ? "?connected=wider" : "?connected=1");
  } catch (err) {
    // A CODE, NEVER A MESSAGE, and never the upstream's words. `code` is one of
    // ConnectorErrorCode; the page rebuilds the sentence from config, so no free
    // text reaches the URL, the access log or a screenshot.
    const code: ConnectorErrorCode | "store_failed" =
      err instanceof ConnectorError ? err.code : "store_failed";
    event({
      evt: "strad.connector_refused",
      slug: entry.server.slug,
      reason: code,
    });
    if (!(err instanceof ConnectorError)) {
      // The store's own failure, on stderr only: a store client's exception can
      // quote a rendered value, so it never becomes an event field or a page.
      console.error(
        `[strad] connector write failed for ${entry.server.slug}: ` +
          `${errorSummary(err)}`,
      );
    }
    back(`?error=${encodeURIComponent(code)}`);
  }
}

/**
 * Read ONE variable out of THIS slug's own namespace.
 *
 * `reveal()` on the console's admin store, against a path composed from the
 * config's slug and the config's variable name. Not the runtime provider, which
 * layers the gateway namespace behind the slug's own — that fallback is right for
 * a `${NAME}` and wrong for a credential a connector claims to own. See the
 * header of src/connectors/index.ts.
 *
 * The caller has already established, via `readConnectorState`, that the
 * parameter exists; a store failure here surfaces as a refusal.
 */
function readOwnVariable(
  opts: ConnectorUiOptions,
  store: ParameterStore,
  entry: ConnectorServer,
  variable: string,
): Promise<string> {
  return store.reveal(
    parameterPath(opts.config.gateway.env, entry.server.slug, variable),
  );
}

// ---------------------------------------------------------------------------
// GET /ui/:server — the connector panel
// ---------------------------------------------------------------------------

export interface ConnectorPageExtras {
  signedInAs?: string;
  status?: number;
  flash?: { tone: "ok" | "error"; message: string };
  /** Already-read state, when the caller has one. Read here otherwise. */
  state?: ConnectorState;
}

/**
 * The console detail page for a server with a connector.
 *
 * It states the terms BEFORE the button: which Google account, which tier, and
 * the exact scopes. That is not decoration — it is the only place a human can
 * check what they are about to grant, because Google's own consent screen
 * describes the OAuth app rather than the slug.
 */
export async function renderConnectorPage(
  res: Response,
  opts: ConnectorUiOptions,
  entry: ConnectorServer,
  extras: ConnectorPageExtras,
): Promise<void> {
  const state = extras.state ?? (await readConnectorState(opts, entry));
  const slug = entry.server.slug;
  const oauth = entry.oauth;
  const tier = connectorTier(oauth.scopes);
  const scopes = requestedScopes(oauth);
  const redirectUri = connectorRedirectUri(opts.config);
  const path = refreshTokenPath(opts.config, entry);

  const flash = extras.flash
    ? `<div class="flash flash-${extras.flash.tone}">${esc(extras.flash.message)}</div>`
    : "";

  const scopeRows = scopes
    .map((scope) => {
      const identity = !oauth.scopes.includes(scope);
      return `<li><code>${esc(scope)}</code>${
        identity
          ? ` <span class="chip chip-plain">identity</span>`
          : ` <span class="chip chip-secret">capability</span>`
      }</li>`;
    })
    .join("\n");

  const action = `${serverConsolePath(slug)}/connect`;
  const button = (label: string, hint: string): string => `
<form method="post" action="${esc(action)}" class="connect-form">
  <button class="btn btn-primary">${esc(label)}</button>
  <span class="field-h">${esc(hint)}</span>
</form>`;

  let statusBlock: string;
  switch (state.kind) {
    case "no_redirect_uri":
      statusBlock = notice(
        "warn",
        "No public URL on this deployment",
        "Google requires an exact, pre-registered redirect URI, and strad " +
          "derives it from gateway.publicUrl. Set that, redeploy, and this " +
          "connector becomes usable.",
      );
      break;
    case "no_store":
      statusBlock = notice(
        "warn",
        "No parameter store to write to",
        `${state.reason}. A connector stores its refresh token as a managed ` +
          `parameter, so this deployment cannot run one.`,
      );
      break;
    case "store_error":
      statusBlock = notice(
        "error",
        "The parameter store did not answer",
        state.reason,
      );
      break;
    case "incomplete":
      statusBlock = notice(
        "warn",
        "The OAuth application is not seeded for this server",
        `${state.missing.join(" and ")} ${
          state.missing.length === 1 ? "is" : "are"
        } missing from ${path.slice(0, path.lastIndexOf("/") + 1)}. Seed ` +
          `${state.missing.length === 1 ? "it" : "them"} there — a value under ` +
          `the gateway namespace, or under another slug, does not count: this ` +
          `connector reads only its own server's namespace.`,
      );
      break;
    case "ready":
      statusBlock = `
${notice(
  "info",
  "Not connected",
  `strad holds this server's OAuth application but no refresh token, so every ` +
    `tool call fails until a human consents. Connecting stores one.`,
)}
${button("Connect Google", `You will be sent to Google, signed in as ${oauth.account}.`)}`;
      break;
    case "connected":
      statusBlock = `
${notice(
  "info",
  "A credential is stored",
  state.presence.note
    ? `${state.presence.note}. strad cannot tell you whether Google still ` +
        `accepts it — only a real call can, and a token from an app in "testing" ` +
        `expires after seven days.`
    : `A refresh token is present for this server. strad did not record how it ` +
        `got there, and cannot tell you whether Google still accepts it.`,
)}
${button("Reconnect Google", "Rotates the stored refresh token. The current one stays until the new one is accepted.")}`;
      break;
  }

  const body = `
<nav class="breadcrumb"><a href="/ui" class="crumb">servers</a><span class="crumb-sep">/</span><span class="crumb crumb-current">${esc(slug)}</span></nav>

<section class="browse-head">
  <div class="scope"><span class="scope-l">provider</span><code>${esc(oauth.provider)}</code></div>
  <div class="scope"><span class="scope-l">account</span><code>${esc(oauth.account)}</code></div>
  <div class="scope"><span class="scope-l">tier</span><code>${esc(tier)}</code></div>
</section>

${flash}
${statusBlock}

<section class="panel">
  <div class="panel-head"><h2>What this authorization grants</h2>
    <span class="panel-note">requested verbatim · checked on the way back</span></div>
  <ul class="scope-list">
${scopeRows}
  </ul>
</section>

<section class="panel">
  <div class="panel-head"><h2>Where the credential goes</h2>
    <span class="panel-note">never displayed, never logged</span></div>
  <div class="field">
    <span class="field-l">Parameter</span>
    <code class="pathpart">${esc(path)}</code>
    <span class="field-h">Written as a secret parameter: the value lives in Secret Manager and
      the console is the only surface that can write it. No MCP tool can read it.</span>
  </div>
  <div class="field">
    <span class="field-l">Redirect URI</span>
    <code class="pathpart">${redirectUri ? esc(redirectUri) : "—"}</code>
    <span class="field-h">Register this exact string on the Google OAuth client. Each deployment
      has its own, because it is derived from gateway.publicUrl.</span>
  </div>
  <div class="field">
    <span class="field-l">When the server sees it</span>
    <span class="field-h">On its next deploy. A supplementary server's environment is baked at
      render time, so a token stored now reaches the container when the app is next deployed —
      not the moment this page says it was written.</span>
  </div>
</section>`;

  res
    .status(extras.status ?? 200)
    .type("html")
    .send(
      layout({
        title: `${slug} · connector`,
        serverSlug: slug,
        signedInAs: extras.signedInAs,
        body,
      }),
    );
}

/**
 * The flash for a callback that has just redirected back here.
 *
 * `?connected=1` and `?error=<code>` are the only two things the callback puts in
 * a URL, and `code` is checked against the closed set before it is used — an
 * unrecognised one becomes the generic refusal rather than being echoed, so no
 * query string can write text onto this page.
 */
export function connectorFlash(
  query: Request["query"],
  entry: ConnectorServer,
): { tone: "ok" | "error"; message: string } | undefined {
  if (query.connected === "1") {
    return {
      tone: "ok",
      message:
        `Connected. strad stored a refresh token for ${entry.oauth.account}. ` +
        `The server picks it up on its next deploy.`,
    };
  }
  if (query.connected === "wider") {
    return {
      tone: "error",
      message:
        `Connected, and Google granted MORE than this server asked for. The ` +
        `token is stored for ${entry.oauth.account}, and the stored note lists ` +
        `exactly what was granted — read it before relying on the tier above. ` +
        `strad's tool policy still withholds this slug's withheld tools, but ` +
        `Google will honour the wider grant for anything that reaches it.`,
    };
  }
  const raw = typeof query.error === "string" ? query.error : "";
  if (!raw) return undefined;
  return { tone: "error", message: refusalMessage(raw, entry) };
}

/** Closed set in, strad's own sentence out. Nothing from the URL is rendered. */
function refusalMessage(code: string, entry: ConnectorServer): string {
  const account = entry.oauth.account;
  switch (code) {
    case "account_mismatch":
      return (
        `Refused: the consent came back from a different Google account than ` +
        `${account}, which is the account this server is pinned to. The token ` +
        `was discarded and the stored credential is unchanged.`
      );
    case "scope_not_granted":
      return (
        `Refused: the consent did not grant every permission this server ` +
        `requires. Nothing was written. Try again and leave each requested ` +
        `permission ticked.`
      );
    case "no_refresh_token":
      return (
        `Refused: Google completed the consent but returned no refresh token, ` +
        `so there is nothing durable to store. Nothing was written. Revoking ` +
        `strad's access for ${account} at myaccount.google.com and connecting ` +
        `again forces a fresh grant.`
      );
    case "identity_unverified":
    case "no_identity":
      return (
        `Refused: strad could not prove which Google account consented, so it ` +
        `could not check the result against ${account}. Nothing was written.`
      );
    case "exchange_timed_out":
      return (
        `Refused: Google did not answer the authorization code exchange in ` +
        `time, so strad stopped waiting. Nothing was written and the stored ` +
        `credential is unchanged. Connecting again mints a fresh code; if it ` +
        `keeps timing out, check the Google Cloud status page before looking ` +
        `at this server's OAuth client.`
      );
    case "exchange_failed":
      return (
        `Refused: Google would not exchange the authorization code. It may have ` +
        `expired or been issued for a different OAuth client than the one this ` +
        `server's namespace holds. Nothing was written.`
      );
    case "store_failed":
      return (
        `The authorization succeeded but the parameter store refused the write, ` +
        `so the previous credential is still current. strad's logs name the ` +
        `failure; nothing about the token was recorded.`
      );
    default:
      return `Refused. Nothing was written.`;
  }
}

function notice(
  tone: "info" | "warn" | "error",
  title: string,
  sub: string,
): string {
  return `<div class="state state-${tone}">
  <p class="state-title">${esc(title)}</p>
  <p class="state-sub">${esc(sub)}</p>
</div>`;
}

function renderUnexpected(res: Response, err: unknown): void {
  // THE CLASS, NOT THE OBJECT. A store client's exception can quote a rendered
  // value, and this is the one handler every route funnels into — logging `err`
  // here would undo the discipline the rest of the file keeps.
  console.error(`[strad] connector route failed: ${errorSummary(err)}`);
  if (res.headersSent) return;
  res
    .status(500)
    .type("html")
    .send(
      renderMessage({
        title: "Error",
        heading: "Something went wrong",
        sub: "The console hit an unexpected error. Nothing was written.",
        tone: "error",
        breadcrumbToIndex: true,
      }),
    );
}

export type { ConnectorTxPayload };
