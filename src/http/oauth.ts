import express, { type Express, type Request, type Response } from "express";
import { metadataBaseUrl } from "../auth/protected-resource.ts";
import {
  clientFingerprint,
  readClient,
  registerClient,
  resolveRedirectUri,
} from "../auth/mcp-oauth/clients.ts";
import {
  APPROVAL_TTL_MS,
  CODE_CHALLENGE_METHOD,
  mintAccessToken,
  mintCode,
  mintRefreshToken,
  readCode,
  readRefreshToken,
  TX_TTL_MS,
  validChallenge,
  verifierMatches,
  type AuthorizationRequest,
  type PendingApproval,
} from "../auth/mcp-oauth/grants.ts";
import { HostedDomainRefused } from "../auth/mcp-oauth/google.ts";
import type { McpOAuth } from "../auth/mcp-oauth/index.ts";
import {
  APPROVE_PATH,
  AUTHORIZATION_SERVER_ROUTES,
  authorizationServerMetadata,
  AUTHORIZE_PATH,
  canonicalResource,
  GOOGLE_CALLBACK_PATH,
  MCP_SCOPE,
  normalizeResource,
  REGISTER_PATH,
  REVOKE_PATH,
  TOKEN_PATH,
} from "../auth/mcp-oauth/metadata.ts";
import { stateMatches, unsealCookie, type Sealer } from "../auth/session.ts";
import type { StradConfig } from "../config/schema.ts";
import { event } from "../telemetry/index.ts";
import {
  renderAuthorizeError,
  renderConsent,
  renderDomainRefusal,
} from "../ui/oauth-consent.ts";
import { asyncRoute, jsonFailure } from "./async-route.ts";

/**
 * strad's own OAuth 2.1 authorization server, in front of `/mcp`.
 *
 * ## What a client actually walks
 *
 *   1. `GET /.well-known/oauth-protected-resource/mcp` — the RFC 9728 document
 *      (`src/auth/protected-resource.ts`). It names this server.
 *   2. `GET /.well-known/oauth-authorization-server` — RFC 8414 metadata.
 *   3. `POST /oauth/register` — RFC 7591, because claude.ai's connector dialog
 *      takes a URL and nothing else and there is no place to pre-register.
 *   4. `GET /oauth/authorize` — validated, then the browser goes to Google.
 *   5. `GET /oauth/callback/google` — Google comes back; the Workspace domain is
 *      enforced here, on verified claims.
 *   6. The consent screen, and `POST /oauth/approve`.
 *   7. `POST /oauth/token` — `authorization_code`, then `refresh_token` forever.
 *
 * ## Two rules that shape every handler below
 *
 * **A redirect is a privilege, not a default.** An error is redirected back to
 * the client ONLY once the `client_id` has been verified and the `redirect_uri`
 * matched exactly against that client's registration. Before that, an error is a
 * rendered page: bouncing `error=` to an unverified URI is the open redirect the
 * exact match exists to prevent.
 *
 * **The origin is resolved per request, and never from the URL's path or
 * query.** `metadataBaseUrl` is the same function the protected-resource
 * document and the `401` use, so the issuer this server advertises, the resource
 * its tokens are bound to and the identifier `/mcp` compares against cannot be
 * three different strings.
 */

/** The in-flight browser transaction. Its own name and its own path. */
const TX_COOKIE = "strad_mcp_oauth_tx";

interface TxPayload {
  v: 1;
  /** The `state` we sent GOOGLE, which Google echoes back. */
  state: string;
  /** The PKCE verifier for the strad ↔ Google leg. */
  verifier: string;
  /** The redirect URI given to Google, replayed verbatim on the exchange. */
  googleRedirectUri: string;
  /** The client's request, validated, awaiting an identity. */
  request: AuthorizationRequest;
  clientName?: string;
  exp: number;
}

export interface McpOAuthRoutesOptions {
  config: StradConfig;
  oauth: McpOAuth;
  env: NodeJS.ProcessEnv;
  log?: (payload: Record<string, unknown>) => void;
  /** Test seam: the clock every TTL in the flow is measured on. */
  now?: () => number;
}

export function mountMcpOAuth(app: Express, opts: McpOAuthRoutesOptions): void {
  const { config: cfg, oauth, env } = opts;
  const log = opts.log ?? event;
  const now = opts.now ?? (() => Date.now());
  const declared = cfg.gateway.publicUrl;
  const form = express.urlencoded({ extended: false, limit: "64kb" });

  const origin = (req: Request): string | null =>
    metadataBaseUrl(req, declared);

  /**
   * The public, credential-free documents and endpoints get permissive CORS.
   *
   * A browser-resident MCP client reads the two metadata documents and calls
   * `/oauth/register`, `/oauth/token` and `/oauth/revoke` with `fetch`, from its
   * own origin — without these headers those calls fail in the browser and the
   * connector never comes up. `*` is the right value and not a widening: every
   * one of these routes is unauthenticated, reads no cookie, and returns only
   * what the caller already sent or a token the caller must present PKCE for.
   * `Access-Control-Allow-Credentials` is deliberately absent, which is what
   * keeps a cookie from ever riding one of these requests.
   *
   * `/oauth/authorize` and `/oauth/approve` get none of this: they are
   * top-level browser navigations, they carry the transaction cookie, and a
   * cross-origin script has no business reading either.
   */
  const cors = (_req: Request, res: Response, next: () => void): void => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set(
      "Access-Control-Allow-Headers",
      "content-type, mcp-protocol-version",
    );
    res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.set("Access-Control-Max-Age", "600");
    next();
  };

  // --- discovery ----------------------------------------------------------
  //
  // `no-store` for the same reason the protected-resource document takes it: a
  // deployment that declares no `gateway.publicUrl` derives its issuer from the
  // request's `Host` and forwarded scheme, and a cache keyed on the URL alone
  // could hand an `http://` issuer to an `https://` client — which a compliant
  // client compares and refuses.
  for (const route of AUTHORIZATION_SERVER_ROUTES) {
    app.options(route, cors, (_req, res) => res.status(204).end());
    app.get(route, cors, (req, res) => {
      res.set("Cache-Control", "no-store");
      const base = origin(req);
      if (base === null) {
        res.status(404).json({ error: "no_issuer_identifier" });
        return;
      }
      res.json(authorizationServerMetadata(base));
    });
  }

  // --- RFC 7591 dynamic client registration -------------------------------
  app.options(REGISTER_PATH, cors, (_req, res) => res.status(204).end());
  app.post(REGISTER_PATH, cors, (req, res) => {
    res.set("Cache-Control", "no-store");
    const outcome = registerClient(
      req.body,
      oauth.keys.client,
      MCP_SCOPE,
      now(),
    );
    if (!outcome.ok) {
      refused("register", outcome.error);
      res
        .status(400)
        .json({ error: outcome.error, error_description: outcome.description });
      return;
    }
    res.status(201).json(outcome.response);
  });

  // --- the authorization endpoint -----------------------------------------
  app.get(AUTHORIZE_PATH, (req, res) => {
    res.set("Cache-Control", "no-store");
    const base = origin(req);
    if (base === null) {
      // Nothing downstream can be built without one: no issuer to put in `iss`,
      // no resource to bind a token to, and no absolute redirect URI to hand
      // Google. Said as a page, because a human is looking at it.
      page(
        res,
        500,
        renderAuthorizeError({
          heading: "This gateway cannot run an authorization flow",
          detail:
            "It has no public URL. An operator must set gateway.publicUrl to the " +
            "origin this deployment is reached at.",
        }),
      );
      return;
    }

    const clientId = single(req.query.client_id);
    const client = clientId ? readClient(clientId, oauth.keys.client) : null;
    if (!clientId || !client) {
      refused("authorize", "unknown_client");
      page(
        res,
        400,
        renderAuthorizeError({
          heading: "Unknown client",
          detail:
            "The client_id on this request was not issued by this gateway, or " +
            "the key that signed it has been rotated. The client should register " +
            "again.",
        }),
      );
      return;
    }

    const redirectUri = resolveRedirectUri(
      client,
      single(req.query.redirect_uri),
    );
    if (redirectUri === null) {
      refused("authorize", "redirect_uri_mismatch");
      page(
        res,
        400,
        renderAuthorizeError({
          heading: "Redirect address not registered",
          detail:
            "The redirect_uri on this request is not one this client registered, " +
            "or the client registered several and named none.",
        }),
      );
      return;
    }

    // Past this line the destination is verified, so an error is the client's
    // to handle and travels as an OAuth error response (RFC 6749 §4.1.2.1).
    const clientState = single(req.query.state);
    const fail = (error: string, description: string): void => {
      refused("authorize", error);
      res.redirect(
        302,
        errorRedirect(redirectUri, base, error, description, clientState),
      );
    };

    if (single(req.query.response_type) !== "code") {
      fail(
        "unsupported_response_type",
        'strad issues authorization codes only: response_type must be "code".',
      );
      return;
    }

    // PKCE IS MANDATORY, and `plain` is refused rather than downgraded to.
    // OAuth 2.1 requires S256 for public clients, and a `plain` challenge is a
    // challenge an attacker who intercepted the authorization request already
    // holds — it protects nothing, so accepting it would be advertising a
    // defence strad does not have.
    const method = single(req.query.code_challenge_method);
    const challenge = single(req.query.code_challenge);
    if (!challenge) {
      fail(
        "invalid_request",
        "code_challenge is required: this authorization server requires PKCE.",
      );
      return;
    }
    if (method !== CODE_CHALLENGE_METHOD) {
      fail(
        "invalid_request",
        `code_challenge_method must be "${CODE_CHALLENGE_METHOD}". ` +
          '"plain" is refused, and an absent method is not assumed to be it.',
      );
      return;
    }
    if (!validChallenge(challenge)) {
      fail(
        "invalid_request",
        "code_challenge must be the base64url SHA-256 of the verifier.",
      );
      return;
    }

    // RFC 8707. The client may name the resource it wants a token for; the
    // query is stripped before comparing, so the `?servers=granola` URL a human
    // pasted names the same resource as the bare one. See
    // `src/auth/mcp-oauth/metadata.ts`.
    const resource = canonicalResource(base);
    const requestedResource = single(req.query.resource);
    if (
      requestedResource !== undefined &&
      normalizeResource(requestedResource) !== resource
    ) {
      fail(
        "invalid_target",
        `this authorization server issues tokens for ${resource} only.`,
      );
      return;
    }

    // SCOPE IS IGNORED, not refused, and RFC 6749 §3.3 is explicit that an
    // authorization server may issue a scope other than the one asked for as
    // long as it says so in the response — which `/oauth/token` does, always
    // answering `scope: "mcp"`.
    //
    // Refusing an unrecognised scope would be the stricter reading and the
    // wrong trade here. Scope grants NOTHING on this gateway: what a principal
    // may reach is decided entirely by `roles` and the two-way entitlement,
    // server-side, on every request (`src/gateway/entitlements.ts`). So a
    // client asking for a scope it invented cannot widen anything, and the only
    // effect of an `invalid_scope` would be a connector that fails to set up
    // over a word that was never going to matter.

    const request: AuthorizationRequest = {
      cid: clientFingerprint(clientId),
      redirectUri,
      challenge,
      ...(clientState !== undefined ? { state: clientState } : {}),
      resource,
      issuer: base,
    };

    const googleRedirectUri = `${base}${GOOGLE_CALLBACK_PATH}`;
    const pending = oauth.google.beginAuth(googleRedirectUri);
    const payload: TxPayload = {
      v: 1,
      state: pending.state,
      verifier: pending.codeVerifier,
      googleRedirectUri,
      request,
      ...(client.name ? { clientName: client.name } : {}),
      exp: now() + TX_TTL_MS,
    };
    setTxCookie(res, oauth.keys.tx, payload, env);
    res.redirect(302, pending.url);
  });

  // --- Google comes back ---------------------------------------------------
  //
  // Wrapped, because everything before `completeAuth` runs outside this
  // handler's own `try` — unsealing the cookie, clearing it, the state
  // comparison — and any of them throwing on a route a browser reaches
  // unauthenticated would be an unhandled rejection, which exits this process.
  app.get(
    GOOGLE_CALLBACK_PATH,
    asyncRoute(async (req, res) => {
      res.set("Cache-Control", "no-store");
      const tx = unsealCookie<TxPayload>(
        oauth.keys.tx,
        req.headers.cookie,
        TX_COOKIE,
      );
      // Spend the transaction whatever happens next. What actually stops a
      // replayed callback is Google's own single-use authorization code;
      // clearing this keeps a stale tab from re-entering the flow and bounds
      // how long the verifier lives.
      clearTxCookie(res, env);

      if (!tx || !validTx(tx)) {
        refused("callback", "unknown_state");
        page(
          res,
          400,
          renderAuthorizeError({
            heading: "This sign-in has expired",
            detail:
              "strad has no record of the authorization it belongs to. Start the " +
              "connection again from your MCP client.",
          }),
        );
        return;
      }

      const { request } = tx;

      // Google's own refusal — the human pressed Cancel, or the consent failed
      // on Google's side. The client registered this URI, so it is told.
      const googleError = single(req.query.error);
      if (googleError) {
        refused("callback", "google_refused");
        res.redirect(
          302,
          errorRedirect(
            request.redirectUri,
            request.issuer,
            "access_denied",
            "Google did not complete the sign-in.",
            request.state,
          ),
        );
        return;
      }

      // The signature proves the cookie is ours; this proves the callback is
      // its partner, which is the CSRF check.
      if (!stateMatches(single(req.query.state) ?? "", tx.state)) {
        refused("callback", "state_mismatch");
        page(
          res,
          400,
          renderAuthorizeError({
            heading: "This sign-in could not be verified",
            detail:
              "The response from Google does not match the request this browser " +
              "started. Start the connection again from your MCP client.",
          }),
        );
        return;
      }

      let grant;
      try {
        grant = await oauth.google.completeAuth(
          single(req.query.code) ?? "",
          tx.verifier,
          tx.googleRedirectUri,
        );
      } catch (err) {
        if (err instanceof HostedDomainRefused) {
          // THE constraint, and the one refusal that is deliberately not a
          // redirect. A human who signed in with the wrong account needs the
          // sentence; the client would render `access_denied` as "connection
          // failed" and the sentence would reach nobody.
          denied("wrong_domain");
          page(
            res,
            403,
            renderDomainRefusal({
              hostedDomain: err.expectedDomain,
              ...(err.email ? { email: err.email } : {}),
              ...(tx.clientName ? { clientName: tx.clientName } : {}),
            }),
          );
          return;
        }
        refused("callback", "google_exchange_failed");
        res.redirect(
          302,
          errorRedirect(
            request.redirectUri,
            request.issuer,
            "server_error",
            "strad could not complete the sign-in with Google.",
            request.state,
          ),
        );
        return;
      }

      const approval: PendingApproval = {
        v: 1,
        ...request,
        identity: grant.identity,
        googleRefreshToken: grant.refreshToken,
        ...(tx.clientName ? { clientName: tx.clientName } : {}),
        exp: now() + APPROVAL_TTL_MS,
      };

      page(
        res,
        200,
        renderConsent({
          ...(tx.clientName ? { clientName: tx.clientName } : {}),
          redirectHost: hostOf(request.redirectUri),
          email: grant.identity.email,
          resource: request.resource,
          roles: oauth.roles,
          approval: oauth.keys.approval.seal(approval),
          action: APPROVE_PATH,
        }),
      );
    }, jsonFailure("mcp_oauth_callback")),
  );

  // --- the human's decision ------------------------------------------------
  app.post(APPROVE_PATH, form, (req, res) => {
    res.set("Cache-Control", "no-store");
    const body = req.body as Record<string, unknown>;
    const approval = oauth.keys.approval.open<PendingApproval>(
      typeof body.approval === "string" ? body.approval : undefined,
    );
    if (!approval || approval.exp <= now()) {
      refused("approve", "approval_expired");
      page(
        res,
        400,
        renderAuthorizeError({
          heading: "This authorization has expired",
          detail:
            "Consent was not given within ten minutes. Start the connection " +
            "again from your MCP client.",
        }),
      );
      return;
    }

    if (body.decision !== "allow") {
      denied("declined");
      res.redirect(
        302,
        errorRedirect(
          approval.redirectUri,
          approval.issuer,
          "access_denied",
          "The account holder declined this connection.",
          approval.state,
        ),
      );
      return;
    }

    const code = mintCode(oauth.keys.code, approval, approval.cid, now());
    const url = new URL(approval.redirectUri);
    url.searchParams.set("code", code);
    if (approval.state !== undefined)
      url.searchParams.set("state", approval.state);
    // RFC 9207: the authorization response names its issuer, so a client that
    // talks to more than one server cannot be tricked into exchanging a code at
    // the wrong one. Advertised in the metadata document beside it, and taken
    // from the authorization request rather than from this request's `Host`.
    if (approval.issuer) url.searchParams.set("iss", approval.issuer);
    res.redirect(302, url.toString());
  });

  // --- the token endpoint --------------------------------------------------
  app.options(TOKEN_PATH, cors, (_req, res) => res.status(204).end());
  app.post(
    TOKEN_PATH,
    cors,
    form,
    asyncRoute(async (req, res) => {
      // RFC 6749 §5.1: a token response is never cached, anywhere.
      res.set("Cache-Control", "no-store");
      res.set("Pragma", "no-cache");
      const body = req.body as Record<string, unknown>;
      const grantType = str(body.grant_type);

      // Note what this endpoint does NOT need: the request's origin. Every
      // audience it stamps comes from the grant being spent, so a token
      // exchange is answerable without re-deriving what this deployment is.
      if (grantType === "authorization_code") {
        await codeGrant(req, res);
        return;
      }
      if (grantType === "refresh_token") {
        await refreshGrant(req, res);
        return;
      }
      tokenError(
        res,
        400,
        "unsupported_grant_type",
        "this server supports authorization_code and refresh_token.",
      );
    }, jsonFailure("mcp_oauth_token")),
  );

  // --- RFC 7009 revocation -------------------------------------------------
  app.options(REVOKE_PATH, cors, (_req, res) => res.status(204).end());
  app.post(
    REVOKE_PATH,
    cors,
    form,
    asyncRoute(async (req, res) => {
      res.set("Cache-Control", "no-store");
      const body = req.body as Record<string, unknown>;
      const payload = readRefreshToken(oauth.keys.refresh, str(body.token));

      // RFC 7009 §2.2: an unknown, malformed or already-dead token is a 200.
      // Saying otherwise turns this endpoint into an oracle for which tokens
      // exist, and there is nothing a client could usefully do with the answer.
      if (payload) {
        // Revocation happens AT GOOGLE, not here, and that is the point: strad
        // has no datastore, so anything it "revoked" in memory would come back
        // to life on the next deploy. Killing the Google grant behind the token
        // is durable, survives every restart, and is the same act as revoking
        // strad from the account's own security page.
        //
        // Google revokes the whole grant for this user and this OAuth client,
        // so revoking one connector signs that account out of every strad OAuth
        // connector it holds. That is stated in docs/auth/overview.md rather
        // than worked around; on a single-Workspace deployment it is the
        // expected reading of "revoke my access".
        const killed = await oauth.google.revoke(payload.googleRefreshToken);
        log({ evt: "mcp_oauth.revoked", outcome: killed ? "ok" : "failed" });
      }
      res.status(200).end();
    }, jsonFailure("mcp_oauth_revoke")),
  );

  // -----------------------------------------------------------------------

  async function codeGrant(req: Request, res: Response): Promise<void> {
    const body = req.body as Record<string, unknown>;
    const clientId = str(body.client_id);
    const code = readCode(oauth.keys.code, str(body.code), now());

    if (!clientId || !readClient(clientId, oauth.keys.client)) {
      tokenError(res, 401, "invalid_client", "unknown client_id.");
      return;
    }
    if (!code) {
      tokenError(res, 400, "invalid_grant", "the code is unknown or expired.");
      return;
    }
    // The code belongs to the client it was issued to. Without this, a client
    // that merely overheard a code could redeem it as itself.
    if (code.cid !== clientFingerprint(clientId)) {
      tokenError(
        res,
        400,
        "invalid_grant",
        "this code was issued to another client.",
      );
      return;
    }
    // RFC 6749 §4.1.3: the `redirect_uri`, when the authorization carried one,
    // must be repeated identically. `sent()` and not `str()` here, because
    // `str()` reads an EMPTY parameter as an absent one — and `redirect_uri=`
    // with nothing after it is a parameter the caller sent, so it has to fail
    // the comparison rather than skip it.
    const redirectUri = sent(body.redirect_uri);
    if (redirectUri !== undefined && redirectUri !== code.redirectUri) {
      tokenError(
        res,
        400,
        "invalid_grant",
        "redirect_uri does not match the authorization.",
      );
      return;
    }
    // PKCE. The check that makes an intercepted code useless.
    const verifier = str(body.code_verifier);
    if (!verifier || !verifierMatches(verifier, code.challenge)) {
      tokenError(
        res,
        400,
        "invalid_grant",
        "code_verifier does not match the code_challenge.",
      );
      return;
    }
    // SINGLE USE. See `SpentCodes` — this is the flow's only server-side state,
    // and PKCE is what covers the case it cannot (a replay landing on another
    // replica within the code's sixty-second life).
    if (!oauth.spent.spend(code.jti, now())) {
      tokenError(res, 400, "invalid_grant", "this code has already been used.");
      return;
    }
    // RFC 8707 §2.2: a `resource` on the token request narrows, and may only
    // name what the authorization was for. `sent()`, for the reason above.
    const requested = sent(body.resource);
    if (
      requested !== undefined &&
      normalizeResource(requested) !== code.resource
    ) {
      tokenError(
        res,
        400,
        "invalid_target",
        `this grant is for ${code.resource}.`,
      );
      return;
    }

    const refresh = mintRefreshToken(
      oauth.keys.refresh,
      {
        cid: code.cid,
        resource: code.resource,
        identity: code.identity,
        googleRefreshToken: code.googleRefreshToken,
      },
      now(),
    );
    issueTokens(
      res,
      "authorization_code",
      clientId,
      code.resource,
      code.cid,
      code.identity,
      refresh,
    );
  }

  async function refreshGrant(req: Request, res: Response): Promise<void> {
    const body = req.body as Record<string, unknown>;
    const clientId = str(body.client_id);
    const payload = readRefreshToken(
      oauth.keys.refresh,
      str(body.refresh_token),
    );

    if (!clientId || !readClient(clientId, oauth.keys.client)) {
      tokenError(res, 401, "invalid_client", "unknown client_id.");
      return;
    }
    if (!payload) {
      tokenError(res, 400, "invalid_grant", "the refresh token is unknown.");
      return;
    }
    if (payload.cid !== clientFingerprint(clientId)) {
      tokenError(
        res,
        400,
        "invalid_grant",
        "this refresh token was issued to another client.",
      );
      return;
    }

    // THE RE-CHECK. Not a re-read of the `hd` strad sealed an hour ago — a
    // fresh id_token from Google, verified, with the Workspace test applied to
    // it. This is what makes a non-expiring refresh token safe: an account that
    // has left the Workspace, been suspended, or revoked strad's access fails
    // here, permanently, with no strad state involved.
    let identity;
    try {
      identity = await oauth.google.refresh(payload.googleRefreshToken);
    } catch (err) {
      const reason =
        err instanceof HostedDomainRefused
          ? "the account is no longer a member of the required Google Workspace."
          : "the Google grant behind this refresh token is no longer valid.";
      denied(
        err instanceof HostedDomainRefused ? "wrong_domain" : "google_dead",
      );
      tokenError(res, 400, "invalid_grant", reason);
      return;
    }
    // Belt and braces, and worth being precise about what it is NOT. The
    // provider was built with this same `hostedDomain` from this same
    // `resolveMcpOAuth`, and `enforceDomain` already ran inside `refresh()` —
    // so on any real deployment this branch is unreachable, and it is not a
    // re-read of live config. Changing `auth.mcpOAuth.hostedDomain` is a config
    // change, and a strad config change is a DEPLOY (the document is baked into
    // the app spec), so it lands when this process restarts rather than at the
    // next refresh.
    //
    // What it does buy is that a future provider which took its domain from
    // somewhere else cannot quietly become the only thing enforcing the
    // constraint. The check is one comparison on a path that already made a
    // network call.
    if (identity.hd !== oauth.hostedDomain) {
      denied("wrong_domain");
      tokenError(
        res,
        400,
        "invalid_grant",
        "this gateway no longer admits that Workspace.",
      );
      return;
    }

    const requested = sent(body.resource);
    if (
      requested !== undefined &&
      normalizeResource(requested) !== payload.resource
    ) {
      tokenError(
        res,
        400,
        "invalid_target",
        `this grant is for ${payload.resource}.`,
      );
      return;
    }

    // The SAME refresh token comes back, deliberately — see
    // docs/auth/overview.md. Rotation's value is detecting the replay of a
    // stolen token, which needs a server-side record of the one just spent;
    // strad has nowhere to keep one, so minting a new string while the old one
    // stayed valid would be the appearance of rotation without the property.
    issueTokens(
      res,
      "refresh_token",
      clientId,
      payload.resource,
      payload.cid,
      identity,
      str(body.refresh_token) ?? "",
    );
  }

  /**
   * The token response, for both grants.
   *
   * The audience is the GRANT's own resource, carried in the code or the
   * refresh token, rather than a resource recomputed from this request. The two
   * are the same string on any ordinary deployment; taking it from the grant is
   * what keeps a token from being minted for one origin against an
   * authorization given for another, and it means the value a client sent as
   * `resource=` at `/oauth/authorize` is the value its token is checked against
   * at `/mcp`.
   *
   * It is set ALWAYS, whether or not the client named one. A token with no
   * audience would be a token usable at any strad, and the check at `/mcp`
   * would have nothing to compare against.
   */
  function issueTokens(
    res: Response,
    grant: "authorization_code" | "refresh_token",
    clientId: string,
    resource: string,
    cid: string,
    identity: PendingApproval["identity"],
    refreshToken: string,
  ): void {
    const access = mintAccessToken(
      oauth.keys.access,
      { cid, aud: resource, identity, ttlMs: oauth.accessTokenTtlMs },
      now(),
    );
    log({
      evt: "mcp_oauth.granted",
      grant,
      client: clientIdOf(clientId, oauth.keys.client),
    });
    res.json({
      access_token: access,
      token_type: "Bearer",
      expires_in: Math.floor(oauth.accessTokenTtlMs / 1000),
      refresh_token: refreshToken,
      // Always `mcp`, whatever was asked for. See the scope comment on
      // `/oauth/authorize`; RFC 6749 §3.3 requires saying so when the issued
      // scope differs from the requested one, and this is that.
      scope: MCP_SCOPE,
    });
  }

  /**
   * A refusal BEFORE any human has been identified — an unregistered client, a
   * missing PKCE challenge, a stale transaction.
   *
   * Every field is a word this file wrote down, but the record is not exported,
   * and the reason is `mcp.auth_failed`'s verbatim: these fire on public,
   * unauthenticated routes, so anyone who can reach the gateway can produce one
   * per request and evict the records this pipeline exists to deliver.
   */
  function refused(stage: string, reason: string): void {
    log({ evt: "mcp_oauth.refused", stage, reason });
  }

  /**
   * A refusal AFTER a verified Google identity — the domain gate, or a human
   * pressing Deny, or a grant Google will no longer refresh.
   *
   * Its own event rather than a `refused` with another `stage`, because the
   * volume argument that keeps that one off the wire does not reach here:
   * producing one of these costs a real, completed sign-in at
   * accounts.google.com. It is also the record an operator actually wants —
   * "someone is being turned away at the Workspace check" is the shape of both
   * a misconfigured domain and an account that has left it.
   */
  function denied(reason: string): void {
    log({ evt: "mcp_oauth.denied", reason });
  }
}

// ---------------------------------------------------------------------------
// Small shared pieces
// ---------------------------------------------------------------------------

/**
 * An HTML answer from the authorization flow, with the three headers every page
 * in it needs.
 *
 * `no-store` because a consent screen carries a pending grant and a refusal
 * names an account, and neither belongs in a shared cache or a back-button
 * replay.
 *
 * `no-referrer` because the consent screen is rendered AT
 * `/oauth/callback/google?code=<google's authorization code>&state=…`, and
 * `layout()` pulls stylesheets from `fonts.googleapis.com`. A modern browser
 * sends only the origin cross-origin, so this is not a live leak — but a page
 * whose own URL carries an authorization code should not be relying on a
 * browser default to keep it out of a third party's logs.
 *
 * The other two are the anti-clickjacking pair, and a consent screen is the
 * canonical thing they exist for: an "Approve" button an attacker can frame
 * invisibly and trick someone into clicking is a grant nobody meant to give.
 * Reaching this page already needs the transaction cookie and the matching
 * `state`, so the attack is not obviously reachable here — these are defence in
 * depth, on the one surface where the industry's answer is unambiguous. Both,
 * not one: `frame-ancestors` is the modern rule and `X-Frame-Options` is what
 * an older browser reads.
 */
function page(res: Response, status: number, html: string): void {
  res
    .status(status)
    .type("html")
    .set("Cache-Control", "no-store")
    .set("Referrer-Policy", "no-referrer")
    .set("X-Frame-Options", "DENY")
    .set("Content-Security-Policy", "frame-ancestors 'none'")
    .send(html);
}

/** RFC 6749 §5.2 — the token endpoint's error shape. */
function tokenError(
  res: Response,
  status: number,
  error: string,
  description: string,
): void {
  res.status(status).json({ error, error_description: description });
}

/** RFC 6749 §4.1.2.1 — an authorization error, delivered to a verified URI. */
function errorRedirect(
  redirectUri: string,
  issuer: string,
  error: string,
  description: string,
  state: string | undefined,
): string {
  const url = new URL(redirectUri);
  url.searchParams.set("error", error);
  url.searchParams.set("error_description", description);
  if (state !== undefined) url.searchParams.set("state", state);
  if (issuer) url.searchParams.set("iss", issuer);
  return url.toString();
}

/**
 * One value, or undefined.
 *
 * Express parses `?a=1&a=2` into an array and `?a[b]=1` into an object, and a
 * handler that does `String(req.query.x)` on either gets `"1,2"` or
 * `"[object Object]"` — a string that then fails a comparison for a reason
 * nobody can read. Every query parameter in this file goes through here, so a
 * repeated parameter is an ABSENT one rather than a mangled one.
 */
function single(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * The same rule for a form body, with an empty value read as absent.
 *
 * Right for the fields where empty and missing mean the same thing — a
 * `client_id=` with nothing after it is not a client id. Wrong for the two
 * fields that are compared against the grant, which use `sent()` instead.
 */
function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * A form field exactly as the caller sent it, empty string included.
 *
 * For `redirect_uri` and `resource` on the token endpoint, where the check is
 * "if you sent one, it must match". Folding `""` into `undefined` there turns a
 * value that cannot match into a check that does not run.
 */
function sent(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** The client's own short id, for a log line. Never the whole registration. */
function clientIdOf(clientId: string, sealer: Sealer): string {
  return readClient(clientId, sealer)?.id ?? "unknown";
}

function hostOf(uri: string): string {
  try {
    return new URL(uri).host;
  } catch {
    return uri;
  }
}

/** The MAC proves we sealed it; this proves it has the shape we sealed. */
function validTx(tx: TxPayload): boolean {
  const r = tx.request as AuthorizationRequest | undefined;
  return (
    typeof tx.state === "string" &&
    tx.state !== "" &&
    typeof tx.verifier === "string" &&
    typeof tx.googleRedirectUri === "string" &&
    typeof r === "object" &&
    r !== null &&
    typeof r.cid === "string" &&
    typeof r.redirectUri === "string" &&
    typeof r.challenge === "string" &&
    typeof r.resource === "string"
  );
}

/**
 * SameSite=Lax, not Strict, and the reasoning is the console's
 * (`src/auth/session.ts`): the browser arrives back from accounts.google.com as
 * a top-level GET navigation, and Strict would withhold this cookie on exactly
 * that request and break every sign-in.
 *
 * The path is `/oauth`, narrower than the console session's `/`: only the two
 * routes under it ever read this.
 */
function cookieFlags(env: NodeJS.ProcessEnv) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: env.NODE_ENV === "production",
    path: "/oauth",
  };
}

function setTxCookie(
  res: Response,
  sealer: Sealer,
  payload: TxPayload,
  env: NodeJS.ProcessEnv,
): void {
  res.cookie(TX_COOKIE, sealer.seal(payload), {
    ...cookieFlags(env),
    maxAge: TX_TTL_MS,
  });
}

function clearTxCookie(res: Response, env: NodeJS.ProcessEnv): void {
  res.clearCookie(TX_COOKIE, cookieFlags(env));
}
