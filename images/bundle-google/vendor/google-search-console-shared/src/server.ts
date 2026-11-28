import { createHash } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { OAuth2Client } from 'google-auth-library';
import { createRegisterTools } from './tools.js';
import { WEBMASTERS_READONLY_SCOPE } from './client/api-errors.js';
import type {
  SearchAnalyticsRequest,
  SearchAnalyticsResponse,
  SiteEntry,
  Sitemap,
  SitemapsListResponse,
  SitesListResponse,
  UrlInspectionRequest,
  UrlInspectionResponse,
} from './types.js';

/**
 * The one scope a refresh token for this server needs. Read-only: it can list
 * properties, query performance, read sitemaps and inspect URLs, and Google
 * refuses it every write the API has (adding a site, submitting or deleting a
 * sitemap). That is why this server has one tier and no tool groups.
 */
export const GOOGLE_SEARCH_CONSOLE_SCOPES = {
  readonly: WEBMASTERS_READONLY_SCOPE,
} as const;

/**
 * The variables ONE instance of this server reads, out of an injected `env`
 * rather than `process.env`: a strad bundle runs one instance per slug in one
 * process, one Google account each, and a module that reached for the global
 * would hand every account the last one's credential.
 */
export const GOOGLE_SEARCH_CONSOLE_ENV_NAMES = [
  'GOOGLE_SEARCH_CONSOLE_OAUTH_CLIENT_ID',
  'GOOGLE_SEARCH_CONSOLE_OAUTH_CLIENT_SECRET',
  'GOOGLE_SEARCH_CONSOLE_OAUTH_REFRESH_TOKEN',
] as const;

/**
 * The OAuth APP half of the credential: everything but the account's token.
 * The bundle host discovers a per-slug mount on these two, because the token is
 * minted after the deploy, on the slug's own console page.
 */
export const GOOGLE_SEARCH_CONSOLE_OAUTH_APP_ENV_NAMES = [
  'GOOGLE_SEARCH_CONSOLE_OAUTH_CLIENT_ID',
  'GOOGLE_SEARCH_CONSOLE_OAUTH_CLIENT_SECRET',
] as const;

/** Where a human goes to re-consent. Not a credential. */
export const GOOGLE_SEARCH_CONSOLE_RECONNECT_URL_ENV = 'GOOGLE_SEARCH_CONSOLE_RECONNECT_URL';

export type EnvLike = Readonly<Record<string, string | undefined>>;

/** Which of {@link GOOGLE_SEARCH_CONSOLE_ENV_NAMES} this environment does not carry. */
export function missingCredentials(env: EnvLike): string[] {
  return GOOGLE_SEARCH_CONSOLE_ENV_NAMES.filter((name) => !env[name]);
}

/** Everything the tools can ask Search Console for. Every method reads. */
export interface IGoogleSearchConsoleClient {
  listSites(): Promise<SitesListResponse>;
  getSite(siteUrl: string): Promise<SiteEntry>;
  querySearchAnalytics(siteUrl: string, request: SearchAnalyticsRequest): Promise<SearchAnalyticsResponse>;
  listSitemaps(siteUrl: string, sitemapIndex?: string): Promise<SitemapsListResponse>;
  getSitemap(siteUrl: string, feedpath: string): Promise<Sitemap>;
  inspectUrl(request: UrlInspectionRequest): Promise<UrlInspectionResponse>;
}

/**
 * AUTH MODEL. A refresh token belonging to ONE Google account, minted once by a
 * human running the consent flow. No service account: Search Console grants a
 * property to a person (or to a service account added as a property user by
 * hand), and the account a human consents with is the one whose properties they
 * meant to share.
 */
class OAuthGoogleSearchConsoleClient implements IGoogleSearchConsoleClient {
  private oauth2Client: OAuth2Client;
  private cachedToken: string | null = null;
  private tokenExpiry = 0;
  private refreshPromise: Promise<void> | null = null;

  constructor(
    clientId: string,
    clientSecret: string,
    private readonly refreshTokenValue: string,
    /** Where a human goes to re-consent. Optional: outside strad there is no such page. */
    private readonly reconnectUrl?: string
  ) {
    this.oauth2Client = new OAuth2Client(clientId, clientSecret);
    this.oauth2Client.setCredentials({ refresh_token: refreshTokenValue });
  }

  private async refreshToken(): Promise<void> {
    let token: string | null | undefined;
    let res: { data?: { expiry_date?: number } } | null | undefined;
    try {
      ({ token, res } = await this.oauth2Client.getAccessToken());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('invalid_grant')) {
        throw new Error(
          `${message}\n\nHint: this refresh token is no longer valid — revoked, expired, or ` +
            'invalidated by a password change. A token issued by an OAuth app still in ' +
            '"testing" mode expires after 7 days. ' +
            (this.reconnectUrl
              ? `Open ${this.reconnectUrl} and click Reconnect Google to mint a new one.`
              : 'Run the consent flow again for this account and replace ' +
                'GOOGLE_SEARCH_CONSOLE_OAUTH_REFRESH_TOKEN with the new token.')
        );
      }
      throw error;
    }
    if (!token) throw new Error('Failed to obtain an access token from the OAuth refresh token');
    const expiry = res?.data?.expiry_date;
    this.cachedToken = token;
    this.tokenExpiry = typeof expiry === 'number' ? expiry : Date.now() + 3600000;
  }

  /** Bearer headers, refreshing the access token at most once at a time. */
  private async headers(): Promise<Record<string, string>> {
    if (!this.cachedToken || Date.now() >= this.tokenExpiry - 60000) {
      this.refreshPromise ??= this.refreshToken().finally(() => {
        this.refreshPromise = null;
      });
      await this.refreshPromise;
    }
    return { Authorization: `Bearer ${this.cachedToken}` };
  }

  /** One call, dropping the cached token if Google says it is not valid after all. */
  private async withAuth<T>(call: (headers: Record<string, string>) => Promise<T>): Promise<T> {
    const headers = await this.headers();
    try {
      return await call(headers);
    } catch (error) {
      if ((error as { category?: string })?.category === 'auth') {
        // Drop BOTH caches. OAuth2Client keeps its own access token and hands
        // it back from getAccessToken() until its own expiry, so clearing only
        // ours would re-cache the rejected token for another hour.
        this.cachedToken = null;
        this.tokenExpiry = 0;
        this.oauth2Client.setCredentials({ refresh_token: this.refreshTokenValue });
      }
      throw error;
    }
  }

  private async lib() {
    return import('./client/api.js');
  }

  async listSites(): Promise<SitesListResponse> {
    const { listSites } = await this.lib();
    return this.withAuth((h) => listSites(h));
  }

  async getSite(siteUrl: string): Promise<SiteEntry> {
    const { getSite } = await this.lib();
    return this.withAuth((h) => getSite(h, siteUrl));
  }

  async querySearchAnalytics(siteUrl: string, request: SearchAnalyticsRequest): Promise<SearchAnalyticsResponse> {
    const { querySearchAnalytics } = await this.lib();
    return this.withAuth((h) => querySearchAnalytics(h, siteUrl, request));
  }

  async listSitemaps(siteUrl: string, sitemapIndex?: string): Promise<SitemapsListResponse> {
    const { listSitemaps } = await this.lib();
    return this.withAuth((h) => listSitemaps(h, siteUrl, sitemapIndex));
  }

  async getSitemap(siteUrl: string, feedpath: string): Promise<Sitemap> {
    const { getSitemap } = await this.lib();
    return this.withAuth((h) => getSitemap(h, siteUrl, feedpath));
  }

  async inspectUrl(request: UrlInspectionRequest): Promise<UrlInspectionResponse> {
    const { inspectUrl } = await this.lib();
    return this.withAuth((h) => inspectUrl(h, request));
  }
}

export type ClientFactory = () => IGoogleSearchConsoleClient;

/**
 * One client per credential, for the life of the process. Both hosts build a
 * fresh `Server` per HTTP request, so a client built per server would cache its
 * access token for exactly one call. Keyed by a HASH of the credential and the
 * reconnect page, so the map never holds a refresh token as a key.
 */
const clients = new Map<string, IGoogleSearchConsoleClient>();

/**
 * Builds the client from an environment, LAZILY: a missing credential is a
 * failed tool call, never a failed boot, so the server lists its tools with no
 * secrets set.
 */
export function createDefaultClient(env: EnvLike = process.env): IGoogleSearchConsoleClient {
  const missing = missingCredentials(env);
  if (missing.length > 0) {
    throw new Error(
      `This google-search-console server has no credential: ${missing.join(', ')} ` +
        `${missing.length === 1 ? 'is' : 'are'} not set. It needs an OAuth client id, client secret ` +
        'and refresh token for exactly one Google account, consented for ' +
        `${GOOGLE_SEARCH_CONSOLE_SCOPES.readonly}.`
    );
  }
  const clientId = env.GOOGLE_SEARCH_CONSOLE_OAUTH_CLIENT_ID!;
  const clientSecret = env.GOOGLE_SEARCH_CONSOLE_OAUTH_CLIENT_SECRET!;
  const refreshToken = env.GOOGLE_SEARCH_CONSOLE_OAUTH_REFRESH_TOKEN!;
  const reconnectUrl = env[GOOGLE_SEARCH_CONSOLE_RECONNECT_URL_ENV] || undefined;

  const key = createHash('sha256')
    .update(`${clientId}\u0000${clientSecret}\u0000${refreshToken}\u0000${reconnectUrl ?? ''}`)
    .digest('hex');
  let client = clients.get(key);
  if (!client) {
    client = new OAuthGoogleSearchConsoleClient(clientId, clientSecret, refreshToken, reconnectUrl);
    clients.set(key, client);
  }
  return client;
}

export interface CreateMCPServerOptions {
  version: string;
  /** The environment THIS instance reads. Defaults to `process.env`. */
  env?: EnvLike;
}

export function createMCPServer(options: CreateMCPServerOptions) {
  const env = options.env ?? process.env;

  const server = new Server(
    { name: 'google-search-console-workspace-mcp-server', version: options.version },
    { capabilities: { tools: {} } }
  );

  const registerHandlers = async (server: Server, clientFactory?: ClientFactory) => {
    const factory = clientFactory ?? (() => createDefaultClient(env));
    createRegisterTools(factory)(server);
  };

  return { server, registerHandlers };
}
