import { z } from 'zod';
import type { ClientFactory } from '../server.js';
import type { SessionStore } from '../monarch-client/session-store.js';
import {
  authErrorMessage,
  errorFromException,
  errorResult,
  ok,
  okJSON,
  type ToolResult,
} from './helpers.js';
import type { MonarchAuthManager } from '../monarch-client/auth-manager.js';
import { MonarchAuthError } from '../monarch-client/graphql-transport.js';
import type { RegisteredTool } from '../tools.js';

const CHECK_DESCRIPTION = `Check whether the Monarch Money MCP server can authenticate, which credential it is using, and what to do when it cannot.

When authenticated, returns:
\`\`\`json
{
  "authenticated": true,
  "method": "cookie",
  "source": "MONARCH_COOKIE",
  "email": "you@example.com",
  "id": "user_123",
  "name": "Your Name",
  "headlessLogin": false,
  "cookiePersistence": true
}
\`\`\`

\`method\` is \`cookie\` (Monarch's browser session cookie) or \`token\` (a bearer token). \`source\` says where it came from: \`MONARCH_COOKIE\`, \`MONARCH_SESSION_TOKEN\`, \`login\` (minted by a headless login with \`MONARCH_EMAIL\`/\`MONARCH_PASSWORD\`), or \`stored\` (saved by \`monarch_login_with_token\`). Precedence is cookie > token > stored, and a refused credential triggers one headless re-login when email and password are configured.

When not authenticated, returns an error naming the credential that failed and the exact steps to refresh it.

**Use cases:**
- Confirm the server is ready before running other tools
- Diagnose auth errors from other tools
- Find out whether a refreshed cookie will survive a restart (\`cookiePersistence\`)`;

const SET_COOKIE_DESCRIPTION = `Install a fresh Monarch Money session cookie — the fix when other tools report that the Monarch cookie expired.

Monarch's web app authenticates with an HttpOnly session cookie. To get one: sign in at https://app.monarch.com, open DevTools → Network, select any request to api.monarch.com/graphql, and copy the whole value of its \`Cookie\` request header. A leading \`Cookie:\` and wrapping quotes are tolerated.

The cookie is verified against Monarch FIRST (a \`me\` query); a cookie Monarch refuses is not saved anywhere. Once verified it is used immediately, and — when the deployment configured a write-back (on strad: the slug lists \`MONARCH_COOKIE\` under \`paramsWritable:\`) — persisted, so the next restart reads it too. The result says whether it was persisted.

The cookie is a credential: it is never echoed back or logged.

**Use cases:**
- Restore access after the session cookie expires
- Move the server from a pasted token to cookie auth`;

const TOKEN_DESCRIPTION = `Save a pre-obtained Monarch Money bearer token to encrypted on-disk storage. Prefer \`set_session_cookie\`: Monarch's web app exposes no token to copy, and \`MONARCH_COOKIE\` / \`MONARCH_SESSION_TOKEN\` in the environment take precedence over a stored token.

The token is written to \`~/.monarch-money-mcp/session.enc\` (or \`MONARCH_STATE_DIR/session.enc\` when set), encrypted with AES-256-GCM. Once saved, all other tools will pick it up automatically — no env var configuration needed.

The tool will validate the token by calling Monarch's \`me\` endpoint before saving. An invalid token returns an error and is not persisted.

**Use cases:**
- Migrate a token captured from a browser session into the server
- Restore access after a session expiry without re-running the login script
- Rotate the on-disk token to a freshly issued one`;

export function authTools(
  clientFactory: ClientFactory,
  sessionStore: SessionStore,
  auth: MonarchAuthManager
): RegisteredTool[] {
  const StatusSchema = z.object({});
  const checkAuthentication: RegisteredTool = {
    name: 'check_authentication',
    description: CHECK_DESCRIPTION,
    groups: ['readonly', 'manage'],
    inputSchema: { type: 'object', properties: {}, required: [] },
    handler: async (args): Promise<ToolResult> => {
      StatusSchema.parse(args ?? {});
      try {
        const client = await clientFactory();
        const me = await client.whoami();
        // Read AFTER the call: a refusal on the way may have re-logged-in, and
        // what answers is the credential that is in use now.
        const status = await auth.status();
        return okJSON({
          authenticated: true,
          method: status.method,
          source: status.source,
          email: me.email,
          id: me.id,
          name: me.name,
          headlessLogin: status.headlessLogin,
          totpSecret: status.totpSecret,
          cookiePersistence: status.cookiePersistence,
          ...(status.persistTarget ? { persistTarget: status.persistTarget } : {}),
        });
      } catch (err) {
        return errorFromException(err);
      }
    },
  };

  const CookieSchema = z.object({
    cookie: z.string().min(1),
  });
  const setSessionCookie: RegisteredTool = {
    name: 'set_session_cookie',
    description: SET_COOKIE_DESCRIPTION,
    groups: ['manage'],
    inputSchema: {
      type: 'object',
      properties: {
        cookie: {
          type: 'string',
          description:
            'The whole value of the `Cookie` request header from a signed-in request to api.monarch.com.',
        },
      },
      required: ['cookie'],
    },
    handler: async (args): Promise<ToolResult> => {
      try {
        const { cookie } = CookieSchema.parse(args ?? {});
        const result = await auth.setCookie(cookie);
        const durability = result.persisted
          ? `Persisted${auth.persistTarget ? ` to ${auth.persistTarget}` : ''}, so it survives a restart.`
          : result.persistNote;
        return ok(
          `Monarch accepted the cookie: authenticated as ${result.me.email} (id: ${result.me.id}). ` +
            `It is in use now. ${durability}`
        );
      } catch (err) {
        if (err instanceof MonarchAuthError) {
          return errorResult(
            `The cookie was NOT saved: ${authErrorMessage(err)}`
          );
        }
        return errorFromException(err);
      }
    },
  };

  const TokenSchema = z.object({
    token: z.string().min(1).describe('Monarch Money session token (a JWT-like string).'),
    email: z
      .string()
      .optional()
      .describe('Optional email address associated with the token, stored alongside it.'),
  });
  const loginWithToken: RegisteredTool = {
    name: 'monarch_login_with_token',
    description: TOKEN_DESCRIPTION,
    groups: ['manage'],
    inputSchema: {
      type: 'object',
      properties: {
        token: {
          type: 'string',
          description: 'Monarch Money session token (a JWT-like string).',
        },
        email: {
          type: 'string',
          description: 'Optional email address associated with the token.',
        },
      },
      required: ['token'],
    },
    handler: async (args): Promise<ToolResult> => {
      try {
        const parsed = TokenSchema.parse(args ?? {});
        // Verified with THIS token, not with whatever the precedence picks —
        // an environment cookie or token would otherwise vouch for it.
        let me: { id: string; email: string; name: string };
        try {
          me = await auth.verify({ method: 'token', token: parsed.token, source: 'stored' });
        } catch (err) {
          const why = err instanceof MonarchAuthError ? authErrorMessage(err) : String(err instanceof Error ? err.message : err);
          return errorResult(`Token validation failed; the token was NOT persisted.\n${why}`);
        }
        const existing = await sessionStore.load().catch(() => null);
        await sessionStore.save({
          token: parsed.token,
          via: 'token',
          email: parsed.email ?? me.email ?? existing?.email,
          obtainedAt: new Date().toISOString(),
          deviceUuid: existing?.deviceUuid,
        });
        const status = await auth.status();
        const shadowed =
          status.source === 'MONARCH_COOKIE' || status.source === 'MONARCH_SESSION_TOKEN'
            ? ` Note: ${status.source} is set in the environment and takes precedence over a stored token.`
            : '';
        return ok(
          `Saved session token to ${sessionStore.path()} and validated against Monarch.\n` +
            `Authenticated as: ${me.email} (id: ${me.id}).${shadowed}`
        );
      } catch (err) {
        return errorFromException(err);
      }
    },
  };

  return [checkAuthentication, setSessionCookie, loginWithToken];
}
