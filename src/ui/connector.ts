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
  genericTerms,
  issueConnectorTx,
  readConnectorTx,
  type ConnectorTxPayload,
} from "../connectors/state.ts";
import {
  beginAuthorization,
  completeAuthorization,
  connectorClientVariables,
  connectorFor,
  grantAuthority,
  connectorRedirectUri,
  connectorStore,
  connectorTerms,
  connectorVariablePath,
  connectionNote,
  ConnectorError,
  credentialKind,
  isConnectorClientPath,
  unexpectedScopes,
  readConnectorState,
  refreshTokenPath,
  storeRefreshToken,
  type ConnectorDeps,
  type ConnectorErrorCode,
  type ConnectorPresence,
  type ConnectorServer,
  type ConnectorState,
  type ConnectorTerms,
} from "../connectors/index.ts";
import { CONNECTOR_CALLBACK_PATH } from "../connectors/index.ts";
import { errorSummary } from "../util/error-text.ts";
import { ServiceAccountAuthError } from "../secrets/parameters/service-account.ts";
import {
  ParameterStoreError,
  staticNamespace,
  UnreadablePayloadError,
  type ConsoleReadGrant,
  type ParameterStore,
} from "../secrets/parameters/index.ts";

/**
 * **Connect** / **Reconnect**, on a server slug's console page.
 *
 * The whole flow, in the order it happens:
 *
 *   POST /ui/<slug>/connect      seal a transaction, 302 to the provider
 *   GET  /ui/oauth/callback      verify, exchange, check, write, 302 back
 *   GET  /ui/<slug>              render the panel, in one of five states
 *   POST /ui/<slug>/grant-client bind the console's own read on the client
 *
 * ONE pair of routes for every provider. Which provider a slug uses is a
 * property of its config (`oauth.provider`), dispatched in
 * src/connectors/index.ts, and it changes nothing about the transaction, the
 * cookie, the gate or the target path. A per-provider route would be a second
 * place for the sealed-state checks below to be got wrong.
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
 * it anyway is strictly stronger and costs nothing: the browser returns from the
 * provider as a top-level GET, which carries the SameSite=Lax session cookie, so
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
   * had to fake a provider in order to fake a bundle would fake neither well.
   * This is what lets the end-to-end test drive a fake token service through the
   * real Express app, real cookies, real sealed state and the real store.
   */
  connectorFetch?: typeof fetch;
}

/** Mount the three connector routes. `gate` is the console's SSO middleware. */
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
    // It writes the store. A token session could never have begun the flow —
    // `connect` refuses it and the transaction is bound to the principal — so
    // this is the second lock, not the first. See refuseTokenSession.
    refuseTokenSession,
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

  // The repair for the refusal above. A POST for the same reason `connect` is
  // one — it writes an IAM policy — and behind the same two locks.
  app.post(
    `${SERVER_ROUTE}/grant-client`,
    gate,
    refuseTokenSession,
    asyncRoute(
      (req, res) => handleGrantClient(req, res, opts),
      renderUnexpected,
    ),
  );
}

// ---------------------------------------------------------------------------
// POST /ui/:server/connect
// ---------------------------------------------------------------------------

/**
 * Why the deployment could not carry a connect through, as one word from a
 * closed set strad wrote.
 *
 * The four readiness words are `ConnectorState` kinds, shipped as they are, so
 * the event and the panel under the flash agree on what state the connector was
 * in. `no_session_key` and `client_unreadable` are the two refusals the state
 * cannot see: one is about the console's own key, the other only surfaces when
 * the value is actually read.
 */
type ConnectRefusal =
  | Exclude<ConnectorState["kind"], "ready" | "connected">
  | "no_session_key"
  | "client_unreadable";

/**
 * `strad.connector_connect_failed`: the DEPLOYMENT could not carry a connect
 * through, at either end of the flow.
 *
 * `begin` is the POST behind the button, `callback` is the return from the
 * provider. What they share is that the human did nothing wrong — the POST
 * carries no fields, and a callback that reached these branches has already
 * passed every check on the transaction — so each is the deployment failing,
 * which is why the name ends `_failed` and ships at ERROR on stderr. A refusal
 * of the CONSENT (wrong account, narrowed scopes, a spent transaction) is
 * `strad.connector_refused` instead.
 *
 * Every field is the config's or a word from a closed set. `error` is on no
 * allowlist, so the store's own one-line summary reaches stderr only.
 */
function connectFailed(
  stage: "begin" | "callback",
  slug: string,
  reason: ConnectRefusal,
  detail: Record<string, string | number> = {},
): void {
  event({
    evt: "strad.connector_connect_failed",
    slug,
    stage,
    reason,
    ...detail,
  });
}

/** The event fields a failed client read adds, beside `reason`. */
function clientReadDetail(
  variable: string,
  read: ClientRead,
  err: unknown,
): Record<string, string | number> {
  return {
    variable,
    failure: read.failure,
    ...(read.status === undefined ? {} : { status: read.status }),
    error: errorSummary(err),
  };
}

async function handleConnect(
  req: Request,
  res: Response,
  opts: ConnectorUiOptions,
): Promise<void> {
  const slug = req.params.server ?? "";
  const signedInAs = signedInLabel(res);
  const entry = connectorFor(opts.config, slug);

  // NO EVENT. There is no connector here to have failed, and `slug` is the
  // caller's own path segment rather than a config value, so it may not reach
  // the ingestor (see `EXPORTABLE` in src/telemetry/events.ts).
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
          nav: "connectors",
        }),
      );
    return;
  }

  // EVERY REFUSAL BELOW IS A 409, NEVER A 5xx. The App Platform ingress treats
  // an upstream 5xx as its own failure and replaces the body with its generic
  // edge page (the trap src/http/readiness.ts is shaped around), so the human
  // would see "Error code: 503" and none of the sentence that says why. 409 is
  // what a connector that is not ready gets, and rendering in place — rather
  // than redirecting with `?error=` — keeps the specific reason off the URL,
  // where the page accepts only a closed set of codes.
  //
  // And every one is an event: see `connectFailed`.
  const refuse = async (
    reason: ConnectRefusal,
    message: string,
    state?: ConnectorState,
    detail: Record<string, string | number> = {},
  ): Promise<void> => {
    connectFailed("begin", entry.server.slug, reason, detail);
    await renderConnectorPage(res, opts, entry, {
      signedInAs,
      status: 409,
      state,
      flash: { tone: "error", message },
      // THE ONE REFUSAL WITH A BUTTON BEHIND IT. Every other branch here needs a
      // config change, a redeploy or a human seeding a value; this one is a
      // binding the console's own credential is already permitted to write, so
      // the fix belongs beside the sentence that diagnosed it rather than in a
      // doc a human has to go and find.
      repair: reason === "client_unreadable",
    });
  };

  const sealer = opts.sessions?.connector;
  const redirectUri = connectorRedirectUri(opts.config);
  if (!redirectUri) {
    await refuse(
      "no_redirect_uri",
      "This deployment declares no gateway.publicUrl, so strad cannot " +
        "build the exact redirect URI the provider requires.",
    );
    return;
  }
  if (!sealer) {
    await refuse(
      "no_session_key",
      "This deployment has no console session key, so strad cannot seal " +
        "an authorization transaction. Set CONSOLE_SESSION_SECRET.",
    );
    return;
  }

  // The state must be REFUSED before it is sealed if the setup is incomplete —
  // otherwise a human consents at the provider and comes back to a flow that
  // cannot exchange, having granted access for nothing.
  const state = await readConnectorState(opts, entry);
  if (state.kind !== "ready" && state.kind !== "connected") {
    await refuse(
      state.kind,
      "This connector is not ready to authorize. See the setup below.",
      state,
    );
    return;
  }

  const resolved = connectorStore(opts, entry);
  if (!resolved.store) {
    await refuse("no_store", resolved.reason, state);
    return;
  }

  const terms = connectorTerms(entry.oauth);
  const scopes = terms.scopes;

  // Guarded, so a store failure is this page saying so rather than the generic
  // 500 — and so the message describes the OPERATION. `renderUnexpected` is the
  // catch of last resort, not the handler for the one call here that talks to a
  // third party.
  const clientIdVariable = entry.oauth.clientIdVariable;
  let clientId: string;
  try {
    clientId = await readOwnVariable(
      opts,
      resolved.store,
      entry,
      state.presence,
      clientIdVariable,
    );
  } catch (err) {
    const read = clientReadFailure(
      err,
      clientIdVariable,
      connectorVariablePath(
        opts.config,
        entry,
        state.presence,
        clientIdVariable,
      ),
    );
    await refuse(
      "client_unreadable",
      `strad cannot read this server's OAuth client, so it cannot begin an ` +
        `authorization: ${read.sentence} Nothing was written.`,
      state,
      clientReadDetail(clientIdVariable, read, err),
    );
    return;
  }

  const pending = beginAuthorization(entry, { clientId, redirectUri });

  issueConnectorTx(
    res,
    sealer,
    {
      state: pending.state,
      verifier: pending.verifier,
      slug: entry.server.slug,
      env: opts.config.gateway.env,
      provider: entry.oauth.provider,
      terms: genericTerms(entry.oauth),
      // A provider that proves no account seals the empty string, and the drift
      // check below compares it to the same empty string. The transaction records
      // the terms the human was SHOWN, and "no account was pinned" is one of them.
      account: terms.account ?? "",
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

  // A 4xx whatever the cause, including strad's own setup: the App Platform
  // ingress rewrites an upstream 5xx into its own edge page, and the sentence
  // saying why would never reach the human. See `handleConnect`.
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
          nav: "connectors",
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

  // The config may have been edited while the human was at the provider. The
  // terms the human was SHOWN are the ones sealed; if the config now says
  // something else, the honest move is to refuse rather than to install a grant
  // against terms nobody agreed to.
  //
  // `provider` and `terms` are in the comparison and in the sealed payload,
  // which means a transaction sealed by an image that predates either field
  // reads as drifted and is refused. That is the safe direction, and it costs at
  // most the consents in flight during one deploy — each recoverable by clicking
  // Connect again.
  //
  // `terms` carries a generic provider's endpoints, `clientAuth` and
  // `credential`: the fields that decide where a live authorization code and
  // this slug's client secret are SENT, and what ends up stored under the name
  // the human authorized.
  const terms = connectorTerms(entry.oauth);
  const scopes = terms.scopes;
  const drifted =
    entry.oauth.provider !== tx.provider ||
    genericTerms(entry.oauth) !== (tx.terms ?? "") ||
    (terms.account ?? "") !== tx.account ||
    entry.oauth.refreshTokenVariable !== tx.variable ||
    scopes.length !== tx.scopes.length ||
    scopes.some((s, i) => s !== tx.scopes[i]);
  if (drifted) {
    refuse(
      "This server's connector changed mid-flow",
      "The provider, account, scopes or target variable configured for this " +
        "server are not the ones this authorization was begun under. Nothing " +
        "was written. Start again from the server's page.",
      409,
    );
    return;
  }

  const redirectUri = connectorRedirectUri(opts.config);
  const resolved = connectorStore(opts, entry);
  if (!redirectUri || !resolved.store) {
    connectFailed(
      "callback",
      entry.server.slug,
      redirectUri ? "no_store" : "no_redirect_uri",
    );
    refuse(
      "strad cannot complete this authorization",
      redirectUri
        ? (resolved as { reason: string }).reason
        : "This deployment declares no gateway.publicUrl, so strad cannot " +
            "present the exact redirect URI the provider requires.",
      409,
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
    connectFailed("callback", entry.server.slug, state.kind);
    refuse(
      "This connector is no longer ready",
      state.kind === "incomplete"
        ? `${state.missing.join(" and ")} went missing from this server's own ` +
            `namespace while the authorization was in progress. Nothing was written.`
        : "strad cannot reach the parameter store this connector writes to. " +
            "Nothing was written.",
      409,
    );
    return;
  }

  const back = (query: string): void => {
    res.redirect(302, `${sanitizeNext(tx.next)}${query}`);
  };

  // The OAuth client, read BEFORE the exchange and outside its `try`. Inside it,
  // a read the store refused would surface as `store_failed` — "the
  // authorization succeeded but the parameter store refused the write" — and
  // send an operator to the write grants when it was the client secret the
  // console could not read. The connect POST reads only the client id, so a
  // deployment that can read that one secret and not this one gets exactly here.
  let client: { clientId: string; clientSecret: string };
  let reading = entry.oauth.clientIdVariable;
  try {
    const clientId = await readOwnVariable(
      opts,
      store,
      entry,
      state.presence,
      reading,
    );
    reading = entry.oauth.clientSecretVariable;
    const clientSecret = await readOwnVariable(
      opts,
      store,
      entry,
      state.presence,
      reading,
    );
    client = { clientId, clientSecret };
  } catch (err) {
    const read = clientReadFailure(
      err,
      reading,
      connectorVariablePath(opts.config, entry, state.presence, reading),
    );
    connectFailed(
      "callback",
      entry.server.slug,
      "client_unreadable",
      clientReadDetail(reading, read, err),
    );
    back(`?error=client_unreadable`);
    return;
  }

  try {
    const grant = await completeAuthorization(
      entry,
      {
        ...client,
        redirectUri,
        code: String(req.query.code ?? ""),
        verifier: tx.verifier,
      },
      opts.connectorFetch ?? fetch,
    );

    // NOTHING REACHED THE STORE UNTIL HERE. Whatever identity the provider can
    // prove is verified, every required scope is granted, a durable credential is
    // in hand.
    const widened = unexpectedScopes(scopes, grant.grantedScopes);
    // ROTATE ONLY WHAT IS ALREADY AT THE TARGET PATH. A slug whose credential
    // still sits under `static/` reads as `connected` and yet has nothing under
    // `oauth/`, and rotating a parameter that does not exist is a failure where
    // a create was meant.
    await storeRefreshToken(
      store,
      refreshTokenPath(opts.config, entry),
      credentialKind(opts.config, entry, state.presence) === "oauth",
      grant.token,
      connectionNote(grant.identity, grant.grantedScopes, new Date()),
    );

    event({
      evt: "strad.connector_connected",
      slug: entry.server.slug,
      variable: entry.oauth.refreshTokenVariable,
    });
    // A grant WIDER than the config asked for is stored — see
    // `unexpectedScopes` for why refusing it would cry wolf — but the page must
    // not go on calling this slug read-only over a credential the provider will
    // honour writes for. `1` is a boolean; the page reads the scopes from the note.
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

// ---------------------------------------------------------------------------
// POST /ui/:server/grant-client
// ---------------------------------------------------------------------------

/**
 * Why the console could not repair its own read access, as one word from a
 * closed set.
 *
 * `denied` is the one that matters and the one this route exists to report
 * honestly: the binding was written, the store took it, and the value still
 * cannot be read. On a deployment that applied the `strad-console-no-read` deny
 * policy from docs/operate/secrets-iam.md §1 that is the permanent answer, and
 * the whole point of reading the value back is that this route says so instead
 * of claiming success and letting **Connect** fail after the consent screen.
 */
type GrantRefusal =
  | Exclude<ConnectorState["kind"], "ready" | "connected">
  | "unsupported"
  | "not_eligible"
  | "write_refused"
  | "denied";

/**
 * `strad.connector_client_granted` / `_grant_failed`: the console binding its
 * OWN credential read access to one slug's OAuth client.
 *
 * Every field is the config's or a word strad wrote. `variable` is the name out
 * of that server's `oauth:` block; `result` is `granted` (the policy was
 * written) or `already` (it already said this). `failure` and `status` on the
 * failure are the SAME closed vocabulary `strad.connector_connect_failed` uses
 * for a client read, because they classify the same read with the same function.
 *
 * The value that was read back is not here, not counted, and not hinted at —
 * `grantConsoleRead` reads it and drops it, and only the boolean comes back.
 */
function grantFailed(
  slug: string,
  reason: GrantRefusal,
  detail: Record<string, string | number> = {},
): void {
  event({
    evt: "strad.connector_client_grant_failed",
    slug,
    reason,
    ...detail,
  });
}

/**
 * Bind this console's own service account `secretAccessor` on ONE slug's OAuth
 * client id and client secret, and then prove it worked by reading them.
 *
 * ## What the browser says: the slug, and nothing else
 *
 * The POST carries no fields. The two variable names come out of that server's
 * `oauth:` block, the paths come from `connectorVariablePath` (the copy presence
 * actually found), and every one of them is put through `isConnectorClientPath`
 * before a binding is written — so the set of secrets this route can grant the
 * console read on is closed by config. There is no spelling of the URL that
 * reaches a refresh token, a sibling slug, or a parameter under `oauth/`.
 *
 * ## Why it is verified rather than reported
 *
 * `setIamPolicy` succeeding says the policy now carries the member. It does not
 * say the member can read, because an IAM DENY policy is evaluated before any
 * allow and cannot be granted around — and §1 of docs/operate/secrets-iam.md
 * recommends exactly such a policy for this service account. A button that
 * claimed success there would move the failure from before the consent screen to
 * after it, which is worse than the hand-run `gcloud` loop it replaces. So the
 * store reads the value back, and this page reports what actually happened using
 * `clientReadFailure` — the same sentence the refusal it repairs is built from.
 */
async function handleGrantClient(
  req: Request,
  res: Response,
  opts: ConnectorUiOptions,
): Promise<void> {
  const slug = req.params.server ?? "";
  const signedInAs = signedInLabel(res);
  const entry = connectorFor(opts.config, slug);

  // NO EVENT, for the reason `handleConnect` gives: there is no connector here
  // to have failed, and `slug` is the caller's own path segment.
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
          nav: "servers",
        }),
      );
    return;
  }

  // 409 AND NEVER A 5xx, and the page keeps offering the repair: see
  // `handleConnect` for why the edge makes that a rule rather than a preference.
  const refuse = async (
    reason: GrantRefusal,
    message: string,
    state?: ConnectorState,
    detail: Record<string, string | number> = {},
  ): Promise<void> => {
    grantFailed(entry.server.slug, reason, detail);
    await renderConnectorPage(res, opts, entry, {
      signedInAs,
      status: 409,
      state,
      flash: { tone: "error", message },
      repair: true,
    });
  };

  // THE STATE'S OWN KIND is the reason, exactly as `handleConnect` ships it, and
  // the sentence stays neutral about which of the four it was. `store_error` is
  // why: the store did not answer, so "there is no OAuth client here" would be
  // asserting a fact strad could not establish.
  const state = await readConnectorState(opts, entry);
  if (state.kind !== "ready" && state.kind !== "connected") {
    await refuse(
      state.kind,
      "strad cannot see an OAuth client to grant read access to on this " +
        "server. See the setup below. Nothing was changed.",
      state,
    );
    return;
  }

  const resolved = connectorStore(opts, entry);
  if (!resolved.store) {
    await refuse("no_store", resolved.reason, state);
    return;
  }
  const store = resolved.store;
  const grant = store.grantConsoleRead?.bind(store);
  if (!grant) {
    await refuse(
      "unsupported",
      `This deployment's parameter store (${store.backend}) does not express ` +
        `per-secret access grants, so strad cannot repair this from the ` +
        `console. Nothing was changed.`,
      state,
    );
    return;
  }

  // The two CLIENT variables, from config, in the order the flow reads them —
  // the client id first, because that is the one the connect POST needs and the
  // one whose failure a human sees before consenting.
  const targets = connectorClientVariables(entry.oauth).map((variable) => ({
    variable,
    path: connectorVariablePath(opts.config, entry, state.presence, variable),
  }));

  // THE FENCE, AND EVERY PATH PASSES IT BEFORE ANY OF THEM IS WRITTEN. Checked
  // in its own pass rather than inside the loop because a refusal on the SECOND
  // variable after the first was already bound would be a page saying "nothing
  // was changed" over a binding that had just been made permanent.
  //
  // Two things it refuses. A client hand-seeded under `oauth/`: that kind is the
  // one strad mints the refresh token into, and the console being unable to read
  // it back is what the kind means. And a variable the CHECKED-IN config does
  // not nominate — `grantAuthority` reads the declared document, so a runtime
  // roster write that edited this slug's `oauth:` block cannot aim the grant at
  // a secret the deploy never approved.
  const declared = grantAuthority(opts);
  for (const { variable, path } of targets) {
    if (isConnectorClientPath(declared, path)) continue;
    await refuse(
      "not_eligible",
      `${variable} for this server is held at ${path}, which is not a path ` +
        `this deployment's checked-in config nominates as this slug's OAuth ` +
        `client, so strad will not grant itself read access to it. Only a ` +
        `connector's client id and client secret under its own static/ ` +
        `namespace are eligible — the oauth/ kind holds credentials strad ` +
        `minted and no person has seen, and an oauth: block added by a runtime ` +
        `roster write nominates nothing. Nothing was changed.`,
      state,
      { variable },
    );
    return;
  }

  for (const { variable, path } of targets) {
    let outcome: ConsoleReadGrant;
    try {
      outcome = await grant(path);
    } catch (err) {
      // The BINDING ITSELF was refused — usually the console credential lacking
      // `secretmanager.secrets.setIamPolicy`, which is a different problem from
      // the read being denied and deserves different words.
      const read = clientReadFailure(err, variable, path);
      await refuse(
        "write_refused",
        `strad could not write the binding for ${variable}: ${read.sentence} ` +
          `Nothing was changed.`,
        state,
        clientReadDetail(variable, read, err),
      );
      return;
    }

    if (!outcome.readable) {
      const read = clientReadFailure(outcome.error, variable, path);
      await refuse(
        "denied",
        `This console's own service account ` +
          `${outcome.changed ? "is now bound" : "was already bound"} ` +
          `roles/secretmanager.secretAccessor on the secret behind ${path}, ` +
          `and the value still cannot be read — so Connect would still refuse. ` +
          `${read.sentence}` +
          (read.failure === "denied"
            ? ` A binding that is in place and grants nothing is what an IAM ` +
              `deny policy looks like: deny is evaluated before allow and ` +
              `cannot be granted around. strad-console-no-read, on the Secrets ` +
              `IAM page, is the one this deployment may have applied — a ` +
              `deployment that has it has decided connectors need a human.`
            : ""),
        state,
        clientReadDetail(variable, read, outcome.error),
      );
      return;
    }

    event({
      evt: "strad.connector_client_granted",
      slug: entry.server.slug,
      variable,
      result: outcome.changed ? "granted" : "already",
    });
  }

  await renderConnectorPage(res, opts, entry, {
    signedInAs,
    state,
    flash: {
      tone: "ok",
      message:
        `strad can now read this server's OAuth client. Both halves were read ` +
        `back after the binding, so Connect has what it needs. The grant is on ` +
        `those two secrets only — this server's stored credential stays ` +
        `unreadable to the console.`,
    },
  });
}

/**
 * Read ONE variable out of THIS slug's own namespaces.
 *
 * `reveal()` on the console's admin store, against the path PRESENCE FOUND —
 * `oauth/` if the slug holds a copy there, `static/` otherwise, which is the
 * same layering a resolver applies. Not the runtime provider, which layers the
 * gateway namespace behind the slug's own; that fallback is right for a
 * `${NAME}` and wrong for a credential a connector claims to own. See the header
 * of src/connectors/index.ts.
 *
 * The caller has already established, via `readConnectorState`, that the
 * parameter exists; a store failure here surfaces as a refusal.
 */
function readOwnVariable(
  opts: ConnectorUiOptions,
  store: ParameterStore,
  entry: ConnectorServer,
  presence: ConnectorPresence,
  variable: string,
): Promise<string> {
  return store.reveal(
    connectorVariablePath(opts.config, entry, presence, variable),
  );
}

/** What went wrong reading the OAuth client, as a word from a closed set. */
type ClientReadFailure =
  | "denied"
  | "not_found"
  | "unreadable"
  | "timeout"
  | "store"
  | "credential"
  | "unexpected";

/** A failed client read: the sentence for the page, the words for the event. */
interface ClientRead {
  sentence: string;
  failure: ClientReadFailure;
  /** The store's HTTP status, when it answered with one. */
  status?: number;
}

/**
 * `projects/<project>/secrets/<id>`, when the refused call was Secret Manager's.
 *
 * Read off a `ParameterStoreError`'s message, which the store builds from a
 * method and a resource and nothing else (`call()` in
 * src/secrets/parameters/gcp.ts): the one error shape on this path known not to
 * carry a value, which is why `errorSummary` already passes it through.
 * `test/connector.refusals.test.ts` drives the real client, so a change to that
 * shape fails there rather than quietly dropping the resource from the page.
 */
const SECRET_ACCESS = /^GET (projects\/[^/\s]+\/secrets\/[^/\s]+)\/versions\//;

/**
 * Why a `reveal()` of one of this slug's OAuth client variables failed, in a
 * sentence an operator can act on — plus the closed word and the status the
 * event carries.
 *
 * The case this exists for is a secret client variable on a deployment whose
 * console credential holds no `secretmanager.versions.access`, which is how
 * docs/operate/secrets-iam.md §1 tells prod to run the console. Parameter
 * Manager lists the variable happily, the connector reads as ready, and the
 * reveal is refused. The sentence names the permission and the exact resource
 * rather than the role, because the grant it points at is per secret — see
 * that page's section on connectors.
 *
 * NO MESSAGE BUT STRAD'S OWN. A `ParameterStoreError` is built from a method,
 * a resource and a status, and a `ServiceAccountAuthError` from strad's own
 * sentences about a token exchange; neither can carry a value. Anything else is
 * reduced to its class, for the reason `errorSummary` gives: an exception raised
 * while reading a payload can quote a window of it, and here the payload is an
 * OAuth client secret.
 */
function clientReadFailure(
  err: unknown,
  variable: string,
  path: string,
): ClientRead {
  if (err instanceof UnreadablePayloadError) {
    return {
      failure: "unreadable",
      status: err.status,
      sentence:
        `the current version of ${path} is not a strad envelope, so the ` +
        `console cannot read ${variable}. Rotating it writes a fresh version.`,
    };
  }
  if (err instanceof ParameterStoreError) {
    const secret = SECRET_ACCESS.exec(err.message)?.[1];
    if (err.status === 403 && secret) {
      return {
        failure: "denied",
        status: 403,
        sentence:
          `Secret Manager refused the console's credential ` +
          `secretmanager.versions.access on ${secret}, the secret behind ` +
          `${path}, so reading ${variable} failed (403). An oauth: connector ` +
          `reads its client through the console, so that service account needs ` +
          `roles/secretmanager.secretAccessor on this slug's own client-id ` +
          `and client-secret secrets — on those secrets only, never on the ` +
          `project. If that grant is already in place, an IAM deny policy on ` +
          `the project overrides it. The Secrets IAM page has the exact grant.`,
      };
    }
    if (err.status === 403) {
      return {
        failure: "denied",
        status: 403,
        sentence:
          `the store refused the console's credential reading ${path} ` +
          `(${err.message}).`,
      };
    }
    if (err.status === 404) {
      return {
        failure: "not_found",
        status: 404,
        sentence:
          `the store has no readable value for ${variable} at ${path} ` +
          `(${err.message}). It was listed a moment ago, so it was deleted, ` +
          `moved, or has no version yet — reload this page.`,
      };
    }
    return {
      failure: "store",
      status: err.status,
      sentence: `the store refused reading ${path} (${err.message}).`,
    };
  }
  if (err instanceof ServiceAccountAuthError) {
    return {
      failure: "credential",
      status: err.status,
      sentence:
        `the console's service-account key could not get an access token ` +
        `(${err.message}), so nothing reached the store. The key is rejected ` +
        `or revoked, or Google's token endpoint is failing — this is not a ` +
        `permission on the secret.`,
    };
  }
  if (
    err instanceof Error &&
    (err.name === "TimeoutError" || err.name === "AbortError")
  ) {
    return {
      failure: "timeout",
      sentence:
        `the store did not answer in time reading ${path}. This is the store ` +
        `being slow or unreachable rather than a refusal; try again.`,
    };
  }
  return {
    failure: "unexpected",
    sentence:
      `reading ${path} hit an unexpected ${errorSummary(err)}. Its message is ` +
      `withheld: an error raised while reading this value can quote it.`,
  };
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
  /**
   * Offer the read-access repair — the button for `POST /<slug>/grant-client`.
   *
   * Set by the `client_unreadable` refusal, by the callback that came back with
   * that code, and by the repair route's own answers, so the panel is the reply
   * to a refusal rather than a permanent fixture. A connector nobody has failed
   * to connect does not need it, and a page that offered every slug a button to
   * widen the console's read access would be advertising the escalation rather
   * than repairing one deployment's connector.
   */
  repair?: boolean;
}

/**
 * Does this query string describe a client the console could not read?
 *
 * `client_unreadable` is the only code the callback redirects with that a button
 * on this page can do anything about, and it is checked against that exact
 * literal — the same closed set `refusalMessage` reads, so nothing in a URL can
 * turn on an affordance that writes IAM by spelling something new.
 */
export function offersClientRepair(query: Request["query"]): boolean {
  return query.error === "client_unreadable";
}

/**
 * The console detail page for a server with a connector.
 *
 * It states the terms BEFORE the button: which provider, which account (or that
 * strad cannot check one), which tier, and the exact scopes. That is not
 * decoration — it is the only place a human can check what they are about to
 * grant, because a provider's own consent screen describes the OAuth app rather
 * than the slug.
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
  const terms = connectorTerms(oauth);
  const tier = terms.tier;
  const scopes = terms.scopes;
  const redirectUri = connectorRedirectUri(opts.config);
  const path = refreshTokenPath(opts.config, entry);
  // WHERE THE CURRENT CREDENTIAL IS, which is not always where the next one goes.
  // A slug connected before the `oauth` kind existed still reads from `static/`,
  // and a page that showed only the write target would be describing a parameter
  // the deployment is not using.
  const heldAt =
    state.kind === "ready" || state.kind === "connected"
      ? state.presence.pathOf[oauth.refreshTokenVariable]
      : undefined;

  const flash = extras.flash
    ? `<div class="flash flash-${extras.flash.tone}">${esc(extras.flash.message)}</div>`
    : "";

  // The repair, offered only in reply to a read that failed. `static/` is named
  // out loud because the fence is real: a client hand-placed under `oauth/` is
  // refused, and a human reading this should know that before pressing it.
  const repairBlock = extras.repair
    ? `
<section class="panel">
  <div class="panel-head"><h2>Let strad read this server's OAuth client</h2>
    <span class="panel-note">two secrets, never the project</span></div>
  <div class="field">
    <span class="field-h">This console's service account can write a secret and not read one
      back, which is how strad's Secrets IAM page says to run it. An <code>oauth:</code> connector
      is the one exception — the consent flow reads this slug's own client id and client secret to
      begin and to exchange. Granting binds
      <code>roles/secretmanager.secretAccessor</code> for this console's service account on those
      two secrets, under this server's <code>static/</code> namespace, and on nothing else. The
      credential this connector stores under <code>oauth/</code> stays unreadable.</span>
  </div>
  <form method="post" action="${esc(`${serverConsolePath(slug)}/grant-client`)}" class="connect-form">
    <button class="btn btn-primary">Grant read on this client</button>
    <span class="field-h">strad writes the binding and then reads the client id and secret back.
      If a deny policy overrides the grant, this page says so rather than reporting success.</span>
  </form>
</section>`
    : "";

  const scopeRows = scopes
    .map((scope) => {
      const identity = !terms.capabilityScopes.includes(scope);
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
        `${terms.label} requires an exact, pre-registered redirect URI, and ` +
          `strad derives it from gateway.publicUrl. Set that, redeploy, and this ` +
          `connector becomes usable.`,
      );
      break;
    case "no_store":
      statusBlock = notice(
        "warn",
        "No parameter store to write to",
        `${state.reason}. A connector stores its credential as a managed ` +
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
        // THE STATIC NAMESPACE, not `path`'s. `path` is the credential's WRITE
        // target and moved to the `oauth` kind; the client id and secret are
        // what a human types, and `oauth/` is the kind strad writes. Deriving
        // this directory from `path` sent an operator to seed a value into the
        // consent flow's own namespace — which the create form does not even
        // suggest a prefix for, and which muddies the provenance the kind exists
        // to state.
        `${state.missing.join(" and ")} ${
          state.missing.length === 1 ? "is" : "are"
        } missing from ${staticNamespace(opts.config.gateway.env, slug)}. Seed ` +
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
  `strad holds this server's OAuth application but no stored credential, so ` +
    `every tool call fails until a human consents. Connecting stores one.`,
)}
${button(
  `Connect ${terms.label}`,
  terms.account
    ? `You will be sent to ${terms.label}, signed in as ${terms.account}.`
    : `You will be sent to ${terms.label}. strad cannot check which account ` +
        `consents, so make sure you are signed in as the right one first.`,
)}`;
      break;
    case "connected":
      statusBlock = `
${notice(
  "info",
  "A credential is stored",
  state.presence.note
    ? `${state.presence.note}. strad cannot tell you whether ${terms.label} ` +
        `still accepts it — only a real call can.` +
        (oauth.provider === "google"
          ? ` A Google token from an app in "testing" expires after seven days.`
          : "")
    : `A credential is present for this server. strad did not record how it ` +
        `got there, and cannot tell you whether ${terms.label} still accepts it.`,
)}
${button(
  `Reconnect ${terms.label}`,
  "Rotates the stored credential. The current one stays until the new one is accepted.",
)}`;
      break;
  }

  const body = `
<nav class="breadcrumb" aria-label="Breadcrumb"><a href="/connectors" class="crumb">connectors</a><span class="crumb-sep">/</span><span class="crumb crumb-current">${esc(slug)}</span></nav>

<section class="browse-head">
  <div class="scope"><span class="scope-l">provider</span><code>${esc(oauth.provider)}</code></div>
  <div class="scope"><span class="scope-l">account</span><code>${esc(terms.account ?? "not checked")}</code></div>
  <div class="scope"><span class="scope-l">tier</span><code>${esc(tier)}</code></div>
</section>

${flash}
${statusBlock}
${repairBlock}

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
    <span class="field-h">The <code>oauth</code> kind: a value strad minted, which no person has
      ever seen. Written as a secret parameter — the value lives in Secret Manager and the console
      is the only surface that can write it. No MCP tool can read it.</span>
  </div>${
    heldAt && heldAt !== path
      ? `
  <div class="field">
    <span class="field-l">Currently read from</span>
    <code class="pathpart">${esc(heldAt)}</code>
    <span class="field-h">This slug's credential predates the <code>oauth</code> kind and still
      sits under <code>static/</code>. It keeps working — a server reads <code>oauth/</code> first
      and falls back to <code>static/</code> — and the next Reconnect writes to the path above,
      which takes precedence from then on.</span>
  </div>`
      : ""
  }
  <div class="field">
    <span class="field-l">Redirect URI</span>
    <code class="pathpart">${redirectUri ? esc(redirectUri) : "—"}</code>
    <span class="field-h">Register this exact string on the ${esc(terms.label)} OAuth client. Each
      deployment has its own, because it is derived from gateway.publicUrl.</span>
  </div>
  <div class="field">
    <span class="field-l">When the server sees it</span>
    <span class="field-h">On its next deploy. A supplementary server's environment is baked at
      render time, so a credential stored now reaches the container when the app is next deployed —
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
        nav: "connectors",
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
  const terms = connectorTerms(entry.oauth);
  const forWhom = terms.account ? ` for ${terms.account}` : "";
  if (query.connected === "1") {
    return {
      tone: "ok",
      message:
        `Connected. strad stored a ${terms.label} credential${forWhom}. ` +
        `The server picks it up on its next deploy.`,
    };
  }
  if (query.connected === "wider") {
    return {
      tone: "error",
      message:
        `Connected, and ${terms.label} granted MORE than this server asked for. ` +
        `The credential is stored${forWhom}, and the stored note lists exactly ` +
        `what was granted — read it before relying on the tier above. strad's ` +
        `tool policy still withholds this slug's withheld tools, but ` +
        `${terms.label} will honour the wider grant for anything that reaches it.`,
    };
  }
  const raw = typeof query.error === "string" ? query.error : "";
  if (!raw) return undefined;
  return { tone: "error", message: refusalMessage(raw, terms) };
}

/** Closed set in, strad's own sentence out. Nothing from the URL is rendered. */
function refusalMessage(code: string, terms: ConnectorTerms): string {
  const account = terms.account ?? "the configured account";
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
    case "no_credential":
      return (
        `Refused: ${terms.label} completed the consent but its token response ` +
        `did not carry the field this server's oauth.credential: names as the ` +
        `durable one, so there is nothing long-lived to store. Nothing was ` +
        `written. The usual fix is an extra authorization parameter under ` +
        `oauth.authorizeParams: asking for offline access — or this provider's ` +
        `durable credential is the other field, and oauth.credential: should ` +
        `name it.`
      );
    case "identity_unverified":
    case "no_identity":
      return (
        `Refused: strad could not prove which Google account consented, so it ` +
        `could not check the result against ${account}. Nothing was written.`
      );
    case "exchange_timed_out":
      return (
        `Refused: ${terms.label} did not answer the authorization code exchange ` +
        `in time, so strad stopped waiting. Nothing was written and the stored ` +
        `credential is unchanged. Connecting again mints a fresh code; if it ` +
        `keeps timing out, check that provider's status page before looking ` +
        `at this server's OAuth client.`
      );
    case "exchange_failed":
      return (
        `Refused: ${terms.label} would not exchange the authorization code. It ` +
        `may have expired or been issued for a different OAuth client than the ` +
        `one this server's namespace holds. Nothing was written.`
      );
    case "client_unreadable":
      return (
        `Refused: ${terms.label} completed the consent, but strad could not ` +
        `read this server's OAuth client from its own namespace to exchange ` +
        `the code, so nothing was exchanged and nothing was written. The usual ` +
        `cause is the console's service account lacking ` +
        `secretmanager.versions.access on the client-id or client-secret ` +
        `secret — an oauth: connector needs roles/secretmanager.secretAccessor ` +
        `on this slug's own client-id and client-secret secrets. strad's logs ` +
        `name which variable, and why, under strad.connector_connect_failed.`
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
        nav: "connectors",
      }),
    );
}

export type { ConnectorTxPayload };
