import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { JWT, OAuth2Client } from 'google-auth-library';
import { createRegisterTools, parseEnabledToolGroups, type ToolGroup } from './tools.js';
import type {
  CalendarEvent,
  CalendarEventList,
  CalendarList,
  FreeBusyRequest,
  FreeBusyResponse,
} from './types.js';

/**
 * Google Calendar API client interface
 * Defines all methods for interacting with the Google Calendar API
 */
export interface ICalendarClient {
  /**
   * List events from a calendar
   */
  listEvents(
    calendarId: string,
    options?: {
      timeMin?: string;
      timeMax?: string;
      maxResults?: number;
      pageToken?: string;
      q?: string;
      singleEvents?: boolean;
      orderBy?: string;
    }
  ): Promise<CalendarEventList>;

  /**
   * Get a specific event by ID
   */
  getEvent(calendarId: string, eventId: string): Promise<CalendarEvent>;

  /**
   * Create a new event
   */
  createEvent(
    calendarId: string,
    event: Partial<CalendarEvent>,
    options?: { supportsAttachments?: boolean }
  ): Promise<CalendarEvent>;

  /**
   * Update an existing event
   */
  updateEvent(
    calendarId: string,
    eventId: string,
    event: Partial<CalendarEvent>,
    options?: { sendUpdates?: 'all' | 'externalOnly' | 'none'; supportsAttachments?: boolean }
  ): Promise<CalendarEvent>;

  /**
   * Delete an event
   */
  deleteEvent(
    calendarId: string,
    eventId: string,
    options?: { sendUpdates?: 'all' | 'externalOnly' | 'none' }
  ): Promise<void>;

  /**
   * List calendars available to the user
   */
  listCalendars(options?: { maxResults?: number; pageToken?: string }): Promise<CalendarList>;

  /**
   * Query free/busy information
   */
  queryFreebusy(request: FreeBusyRequest): Promise<FreeBusyResponse>;

  /**
   * Get the email address of the Google account this client reads from.
   * Used to append `&authuser=<email>` to event URLs so they open against
   * the correct account in multi-account browsers (the reader's default
   * Google account may not be the calendar owner). Returns an empty string
   * if the account email cannot be resolved — callers should treat empty
   * as "skip authuser" and fall back to the bare `?eid=` form.
   */
  getAccountEmail(): Promise<string>;
}

/**
 * Service account credentials structure
 */
export interface ServiceAccountCredentials {
  type: string;
  project_id: string;
  private_key_id: string;
  private_key: string;
  client_email: string;
  client_id: string;
  auth_uri: string;
  token_uri: string;
  auth_provider_x509_cert_url: string;
  client_x509_cert_url: string;
}

/**
 * Google Calendar API client implementation using service account with domain-wide delegation
 */
export class ServiceAccountCalendarClient implements ICalendarClient {
  private baseUrl = 'https://www.googleapis.com/calendar/v3';
  private jwtClient: JWT;
  private cachedToken: string | null = null;
  private tokenExpiry: number = 0;
  private refreshPromise: Promise<void> | null = null;

  constructor(
    credentials: ServiceAccountCredentials,
    private impersonateEmail: string
  ) {
    this.jwtClient = new JWT({
      email: credentials.client_email,
      key: credentials.private_key,
      scopes: ['https://www.googleapis.com/auth/calendar'],
      subject: impersonateEmail,
    });
  }

  private async refreshToken(): Promise<void> {
    const tokenResponse = await this.jwtClient.authorize();
    if (!tokenResponse.access_token) {
      throw new Error('Failed to obtain access token from service account');
    }

    this.cachedToken = tokenResponse.access_token;
    // Token typically expires in 1 hour, but use the actual expiry if provided
    this.tokenExpiry = tokenResponse.expiry_date || Date.now() + 3600000;
  }

  private async getHeaders(): Promise<Record<string, string>> {
    // Check if we have a valid cached token (with 60 second buffer)
    if (this.cachedToken && Date.now() < this.tokenExpiry - 60000) {
      return {
        Authorization: `Bearer ${this.cachedToken}`,
        'Content-Type': 'application/json',
      };
    }

    // Use mutex pattern to prevent concurrent token refresh
    if (!this.refreshPromise) {
      this.refreshPromise = this.refreshToken().finally(() => {
        this.refreshPromise = null;
      });
    }
    await this.refreshPromise;

    return {
      Authorization: `Bearer ${this.cachedToken}`,
      'Content-Type': 'application/json',
    };
  }

  async listEvents(
    calendarId: string,
    options?: {
      timeMin?: string;
      timeMax?: string;
      maxResults?: number;
      pageToken?: string;
      q?: string;
      singleEvents?: boolean;
      orderBy?: string;
    }
  ): Promise<CalendarEventList> {
    const headers = await this.getHeaders();
    const { listEvents } = await import('./calendar-client/lib/list-events.js');
    return listEvents(this.baseUrl, headers, calendarId, options);
  }

  async getEvent(calendarId: string, eventId: string): Promise<CalendarEvent> {
    const headers = await this.getHeaders();
    const { getEvent } = await import('./calendar-client/lib/get-event.js');
    return getEvent(this.baseUrl, headers, calendarId, eventId);
  }

  async createEvent(
    calendarId: string,
    event: Partial<CalendarEvent>,
    options?: { supportsAttachments?: boolean }
  ): Promise<CalendarEvent> {
    const headers = await this.getHeaders();
    const { createEvent } = await import('./calendar-client/lib/create-event.js');
    return createEvent(this.baseUrl, headers, calendarId, event, options);
  }

  async updateEvent(
    calendarId: string,
    eventId: string,
    event: Partial<CalendarEvent>,
    options?: { sendUpdates?: 'all' | 'externalOnly' | 'none'; supportsAttachments?: boolean }
  ): Promise<CalendarEvent> {
    const headers = await this.getHeaders();
    const { updateEvent } = await import('./calendar-client/lib/update-event.js');
    return updateEvent(this.baseUrl, headers, calendarId, eventId, event, options);
  }

  async deleteEvent(
    calendarId: string,
    eventId: string,
    options?: { sendUpdates?: 'all' | 'externalOnly' | 'none' }
  ): Promise<void> {
    const headers = await this.getHeaders();
    const { deleteEvent } = await import('./calendar-client/lib/delete-event.js');
    return deleteEvent(this.baseUrl, headers, calendarId, eventId, options);
  }

  async listCalendars(options?: {
    maxResults?: number;
    pageToken?: string;
  }): Promise<CalendarList> {
    const headers = await this.getHeaders();
    const { listCalendars } = await import('./calendar-client/lib/list-calendars.js');
    return listCalendars(this.baseUrl, headers, options);
  }

  async queryFreebusy(request: FreeBusyRequest): Promise<FreeBusyResponse> {
    const headers = await this.getHeaders();
    const { queryFreebusy } = await import('./calendar-client/lib/query-freebusy.js');
    return queryFreebusy(this.baseUrl, headers, request);
  }

  async getAccountEmail(): Promise<string> {
    return this.impersonateEmail;
  }
}

export type ClientFactory = () => ICalendarClient;

/**
 * Options for creating the MCP server
 */
export interface CreateMCPServerOptions {
  version: string;
  /**
   * Optional array of tool groups to enable or comma-separated string.
   * Available groups:
   * - 'readonly': Read-only operations (list events, get event, list calendars, query freebusy)
   * - 'readwrite': Read and write operations (includes readonly + create_event)
   *
   * If not specified, defaults to all groups (full access).
   * Can also be set via ENABLED_TOOLGROUPS environment variable.
   */
  enabledToolGroups?: ToolGroup[] | string;
}

/**
 * STRAD DELTA (the README's delta table, `HACKS.md` #125): a second auth mode,
 * chosen by `GOOGLE_CALENDAR_AUTH_MODE`.
 *
 *   service_account (the default): GCAL_SERVICE_ACCOUNT_CLIENT_EMAIL,
 *     GCAL_SERVICE_ACCOUNT_PRIVATE_KEY and GCAL_IMPERSONATE_EMAIL. One user in a
 *     Workspace domain, through domain-wide delegation.
 *   oauth: GOOGLE_CALENDAR_OAUTH_CLIENT_ID, GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET
 *     and GOOGLE_CALENDAR_OAUTH_REFRESH_TOKEN. One Google account, personal
 *     `@gmail.com` or Workspace, that consented once.
 *
 * The mode is NAMED rather than inferred from which variables are set, so a
 * deployment that sets a stray OAuth variable keeps the service account it
 * always had, and an `oauth` deployment missing its token says so rather than
 * falling back to a service account it never meant to use.
 */
export const GOOGLE_CALENDAR_AUTH_MODE_ENV = 'GOOGLE_CALENDAR_AUTH_MODE';
export const GOOGLE_CALENDAR_AUTH_MODES = ['service_account', 'oauth'] as const;
export type GoogleCalendarAuthMode = (typeof GOOGLE_CALENDAR_AUTH_MODES)[number];

export const GOOGLE_CALENDAR_SERVICE_ACCOUNT_ENV_NAMES = [
  'GCAL_SERVICE_ACCOUNT_CLIENT_EMAIL',
  'GCAL_SERVICE_ACCOUNT_PRIVATE_KEY',
  'GCAL_IMPERSONATE_EMAIL',
] as const;

export const GOOGLE_CALENDAR_OAUTH_ENV_NAMES = [
  'GOOGLE_CALENDAR_OAUTH_CLIENT_ID',
  'GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET',
  'GOOGLE_CALENDAR_OAUTH_REFRESH_TOKEN',
] as const;

/** The scope either mode's token is minted for. The write tools need the full one. */
export const GOOGLE_CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar';

export type EnvLike = Readonly<Record<string, string | undefined>>;

/** How `calendar-client/lib/api-errors.ts` opens a 401 and a 403. */
const SERVICE_ACCOUNT_401 = 'Service account authentication failed';
const SERVICE_ACCOUNT_403 = 'Permission denied. Ensure calendar scope';

/**
 * The mode an environment selects. Unset or blank is `service_account`, so a
 * deployment that predates the variable is unchanged. Anything else THROWS:
 * reading a typo as the default would put the server on a credential nobody
 * chose.
 */
export function parseAuthMode(env: EnvLike): GoogleCalendarAuthMode {
  const raw = env[GOOGLE_CALENDAR_AUTH_MODE_ENV]?.trim().toLowerCase();
  if (!raw) return 'service_account';
  if ((GOOGLE_CALENDAR_AUTH_MODES as readonly string[]).includes(raw)) {
    return raw as GoogleCalendarAuthMode;
  }
  throw new Error(
    `${GOOGLE_CALENDAR_AUTH_MODE_ENV}="${env[GOOGLE_CALENDAR_AUTH_MODE_ENV]}" is not a mode; ` +
      `expected ${GOOGLE_CALENDAR_AUTH_MODES.join(' or ')}`
  );
}

/** The credential variables the selected mode needs. Throws on an unknown mode. */
export function credentialEnvNames(env: EnvLike): readonly string[] {
  return parseAuthMode(env) === 'oauth'
    ? GOOGLE_CALENDAR_OAUTH_ENV_NAMES
    : GOOGLE_CALENDAR_SERVICE_ACCOUNT_ENV_NAMES;
}

/** Which of the selected mode's variables this environment does not carry. */
export function missingCredentials(env: EnvLike): string[] {
  return credentialEnvNames(env).filter((name) => !env[name]);
}

/**
 * Google Calendar API client authenticated as ONE Google account by an OAuth
 * refresh token. The calls are the service-account client's, by the same
 * `calendar-client/lib` functions; only the bearer token differs.
 */
export class OAuthCalendarClient implements ICalendarClient {
  private baseUrl = 'https://www.googleapis.com/calendar/v3';
  private oauth2Client: OAuth2Client;
  private cachedToken: string | null = null;
  private tokenExpiry = 0;
  private refreshPromise: Promise<void> | null = null;
  private accountEmail: Promise<string> | null = null;

  constructor(
    clientId: string,
    clientSecret: string,
    private readonly refreshTokenValue: string
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
          `${message}\n\nHint: this refresh token is no longer valid: revoked, expired, or ` +
            'invalidated by a password change. A token issued by an OAuth app still in ' +
            '"testing" mode expires after 7 days. Run the consent flow again for this account ' +
            'and replace GOOGLE_CALENDAR_OAUTH_REFRESH_TOKEN with the new token.'
        );
      }
      throw error;
    }
    if (!token) throw new Error('Failed to obtain an access token from the OAuth refresh token');
    const expiry = res?.data?.expiry_date;
    this.cachedToken = token;
    this.tokenExpiry = typeof expiry === 'number' ? expiry : Date.now() + 3600000;
  }

  private async getHeaders(): Promise<Record<string, string>> {
    if (!this.cachedToken || Date.now() >= this.tokenExpiry - 60000) {
      this.refreshPromise ??= this.refreshToken().finally(() => {
        this.refreshPromise = null;
      });
      await this.refreshPromise;
    }
    return {
      Authorization: `Bearer ${this.cachedToken}`,
      'Content-Type': 'application/json',
    };
  }

  /**
   * One call. The shared `api-errors.ts` words a 401 and a 403 for a service
   * account; in this mode they are reworded for a refresh token. A 401 also
   * drops BOTH token caches: OAuth2Client keeps its own access token until its
   * own expiry, so clearing only ours would re-cache the rejected token for
   * another hour.
   */
  private async withAuth<T>(call: (headers: Record<string, string>) => Promise<T>): Promise<T> {
    const headers = await this.getHeaders();
    try {
      return await call(headers);
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (message.startsWith(SERVICE_ACCOUNT_401)) {
        this.cachedToken = null;
        this.tokenExpiry = 0;
        this.oauth2Client.setCredentials({ refresh_token: this.refreshTokenValue });
        throw new Error(
          'OAuth authentication failed: Google rejected the access token (HTTP 401). The next ' +
            'call mints a new one from the refresh token; if this repeats, re-consent the account.'
        );
      }
      if (message.startsWith(SERVICE_ACCOUNT_403)) {
        throw new Error(
          'Permission denied (HTTP 403). Either the account this refresh token belongs to cannot ' +
            `do this to that calendar, or the token was not consented for ${GOOGLE_CALENDAR_SCOPE}.`
        );
      }
      throw error;
    }
  }

  async listEvents(
    calendarId: string,
    options?: {
      timeMin?: string;
      timeMax?: string;
      maxResults?: number;
      pageToken?: string;
      q?: string;
      singleEvents?: boolean;
      orderBy?: string;
    }
  ): Promise<CalendarEventList> {
    const { listEvents } = await import('./calendar-client/lib/list-events.js');
    return this.withAuth((h) => listEvents(this.baseUrl, h, calendarId, options));
  }

  async getEvent(calendarId: string, eventId: string): Promise<CalendarEvent> {
    const { getEvent } = await import('./calendar-client/lib/get-event.js');
    return this.withAuth((h) => getEvent(this.baseUrl, h, calendarId, eventId));
  }

  async createEvent(
    calendarId: string,
    event: Partial<CalendarEvent>,
    options?: { supportsAttachments?: boolean }
  ): Promise<CalendarEvent> {
    const { createEvent } = await import('./calendar-client/lib/create-event.js');
    return this.withAuth((h) => createEvent(this.baseUrl, h, calendarId, event, options));
  }

  async updateEvent(
    calendarId: string,
    eventId: string,
    event: Partial<CalendarEvent>,
    options?: { sendUpdates?: 'all' | 'externalOnly' | 'none'; supportsAttachments?: boolean }
  ): Promise<CalendarEvent> {
    const { updateEvent } = await import('./calendar-client/lib/update-event.js');
    return this.withAuth((h) => updateEvent(this.baseUrl, h, calendarId, eventId, event, options));
  }

  async deleteEvent(
    calendarId: string,
    eventId: string,
    options?: { sendUpdates?: 'all' | 'externalOnly' | 'none' }
  ): Promise<void> {
    const { deleteEvent } = await import('./calendar-client/lib/delete-event.js');
    return this.withAuth((h) => deleteEvent(this.baseUrl, h, calendarId, eventId, options));
  }

  async listCalendars(options?: {
    maxResults?: number;
    pageToken?: string;
  }): Promise<CalendarList> {
    const { listCalendars } = await import('./calendar-client/lib/list-calendars.js');
    return this.withAuth((h) => listCalendars(this.baseUrl, h, options));
  }

  async queryFreebusy(request: FreeBusyRequest): Promise<FreeBusyResponse> {
    const { queryFreebusy } = await import('./calendar-client/lib/query-freebusy.js');
    return this.withAuth((h) => queryFreebusy(this.baseUrl, h, request));
  }

  /**
   * A service account is told which user it acts as; a refresh token is not.
   * The primary calendar's id IS the account's address, and `calendar` covers
   * reading it. Resolved once per client. A failure is "" (the bare `?eid=`
   * link), and is not cached, so a transient one is retried on the next call.
   */
  async getAccountEmail(): Promise<string> {
    this.accountEmail ??= this.withAuth(async (headers) => {
      const response = await fetch(`${this.baseUrl}/calendars/primary`, { headers });
      if (!response.ok) throw new Error(`calendars/primary: ${response.status}`);
      const body = (await response.json()) as { id?: unknown };
      return typeof body.id === 'string' && body.id.includes('@') ? body.id : '';
    }).catch(() => {
      this.accountEmail = null;
      return '';
    });
    return this.accountEmail;
  }
}

/**
 * One OAuth client per credential, for the life of the process. Both hosts
 * build a fresh `Server` per HTTP request, so a client built per server would
 * exchange the refresh token on every call.
 */
const oauthClients = new Map<string, OAuthCalendarClient>();

/**
 * Creates the default Google Calendar client from environment variables, in
 * the mode `GOOGLE_CALENDAR_AUTH_MODE` selects (see above). Called at the first
 * tool call, never at boot, so a missing credential is a failed call and the
 * server still lists its tools.
 */
export function createDefaultClient(env: EnvLike = process.env): ICalendarClient {
  if (parseAuthMode(env) === 'oauth') {
    const missing = missingCredentials(env);
    if (missing.length > 0) {
      throw new Error(
        `${GOOGLE_CALENDAR_AUTH_MODE_ENV}=oauth, but ${missing.join(', ')} ` +
          `${missing.length === 1 ? 'is' : 'are'} not set. OAuth mode needs an OAuth client id, ` +
          `client secret and a refresh token for one Google account, consented for ${GOOGLE_CALENDAR_SCOPE}.`
      );
    }
    const clientId = env.GOOGLE_CALENDAR_OAUTH_CLIENT_ID!;
    const clientSecret = env.GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET!;
    const refreshToken = env.GOOGLE_CALENDAR_OAUTH_REFRESH_TOKEN!;
    const key = `${clientId}\u0000${clientSecret}\u0000${refreshToken}`;
    let client = oauthClients.get(key);
    if (!client) {
      client = new OAuthCalendarClient(clientId, clientSecret, refreshToken);
      oauthClients.set(key, client);
    }
    return client;
  }

  const clientEmail = env.GCAL_SERVICE_ACCOUNT_CLIENT_EMAIL;
  // Handle both literal \n in JSON configs and actual newlines
  const privateKey = env.GCAL_SERVICE_ACCOUNT_PRIVATE_KEY?.replace(/\\n/g, '\n');
  const impersonateEmail = env.GCAL_IMPERSONATE_EMAIL;

  if (!clientEmail) {
    throw new Error(
      'GCAL_SERVICE_ACCOUNT_CLIENT_EMAIL environment variable must be set. ' +
        'This is the email address from your Google Cloud service account.'
    );
  }

  if (!privateKey) {
    throw new Error(
      'GCAL_SERVICE_ACCOUNT_PRIVATE_KEY environment variable must be set. ' +
        'This is the private key from your Google Cloud service account (PEM format).'
    );
  }

  if (!impersonateEmail) {
    throw new Error(
      'GCAL_IMPERSONATE_EMAIL environment variable must be set. ' +
        'This is the email address of the user to access Google Calendar as.'
    );
  }

  const credentials: ServiceAccountCredentials = {
    type: 'service_account',
    project_id: '',
    private_key_id: '',
    private_key: privateKey,
    client_email: clientEmail,
    client_id: '',
    auth_uri: 'https://accounts.google.com/o/oauth2/auth',
    token_uri: 'https://oauth2.googleapis.com/token',
    auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
    client_x509_cert_url: '',
  };

  return new ServiceAccountCalendarClient(credentials, impersonateEmail);
}

export function createMCPServer(options: CreateMCPServerOptions) {
  const server = new Server(
    {
      name: 'google-calendar-workspace-mcp-server',
      version: options.version,
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  const registerHandlers = async (server: Server, clientFactory?: ClientFactory) => {
    // Use provided factory or create default client
    const factory = clientFactory || createDefaultClient;

    // Parse tool groups - handle both array and string formats
    const enabledGroups = Array.isArray(options.enabledToolGroups)
      ? options.enabledToolGroups
      : options.enabledToolGroups
        ? parseEnabledToolGroups(options.enabledToolGroups)
        : undefined;

    const registerTools = createRegisterTools(factory, enabledGroups);
    registerTools(server);
  };

  return { server, registerHandlers };
}
