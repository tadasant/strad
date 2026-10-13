import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { OAuth2Client } from 'google-auth-library';
import { createRegisterTools, parseToolGroups } from './tools.js';
import type { DriveFile, DriveFileList } from './types.js';
import type { CreateFileRequest, ListFilesParams } from './drive-client/files.js';

/**
 * The scopes a refresh token for this server has to have been consented for.
 *
 * Neither is the full `drive` scope, and that is the point of the split.
 * `drive.readonly` reaches every file the account can see and cannot change any
 * of them. `drive.file` can write, but only to files this OAuth app created —
 * which is exactly what `create_folder` and `create_file` need, because they
 * only ever create. Together a token can read the whole Drive and add to it,
 * and cannot edit, delete, move or share a single file a human made.
 */
export const GOOGLE_DRIVE_SCOPES = {
  /** Every read tool: search_files, get_file, read_file. */
  readonly: 'https://www.googleapis.com/auth/drive.readonly',
  /** The two create tools, in addition to `readonly`. */
  file: 'https://www.googleapis.com/auth/drive.file',
} as const;

/**
 * The variables ONE instance of this server reads, out of an injected `env`
 * rather than `process.env`: a strad bundle can run several instances of a
 * Google server in one process, one per account, and a module that reached for
 * the global would hand every account the last one's credential.
 */
export const GOOGLE_DRIVE_ENV_NAMES = [
  'GOOGLE_DRIVE_OAUTH_CLIENT_ID',
  'GOOGLE_DRIVE_OAUTH_CLIENT_SECRET',
  'GOOGLE_DRIVE_OAUTH_REFRESH_TOKEN',
] as const;

/** The OAuth APP half of the credential: everything but the account's token. */
export const GOOGLE_DRIVE_OAUTH_APP_ENV_NAMES = [
  'GOOGLE_DRIVE_OAUTH_CLIENT_ID',
  'GOOGLE_DRIVE_OAUTH_CLIENT_SECRET',
] as const;

/** Narrows the tools to `readonly` or `readwrite`; unset means every tool. Not a credential. */
export const GOOGLE_DRIVE_TOOLGROUPS_ENV = 'GOOGLE_DRIVE_ENABLED_TOOLGROUPS';

export type EnvLike = Readonly<Record<string, string | undefined>>;

/** Which of {@link GOOGLE_DRIVE_ENV_NAMES} this environment does not carry. */
export function missingCredentials(env: EnvLike): string[] {
  return GOOGLE_DRIVE_ENV_NAMES.filter((name) => !env[name]);
}

/** Everything the tools can ask Drive for. Four reads, then the two creates. */
export interface IGoogleDriveClient {
  listFiles(params: ListFilesParams): Promise<DriveFileList>;
  getFile(fileId: string): Promise<DriveFile>;
  exportFile(fileId: string, mimeType: string, maxBytes: number): Promise<Uint8Array>;
  downloadFile(fileId: string, maxBytes: number): Promise<Uint8Array>;
  createFolder(name: string, parentId?: string): Promise<DriveFile>;
  createFile(request: CreateFileRequest): Promise<DriveFile>;
}

/**
 * AUTH MODEL. A refresh token belonging to ONE Google account, minted once by a
 * human running the consent flow. No service account and no domain-wide
 * delegation: a DWD credential can impersonate anyone in a Workspace domain,
 * which is far more authority than "read my Drive", and cannot reach a consumer
 * gmail.com account at all. The trade is that a refresh token can be revoked,
 * and `refreshToken` says what to do when it is.
 */
class OAuthGoogleDriveClient implements IGoogleDriveClient {
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
                'GOOGLE_DRIVE_OAUTH_REFRESH_TOKEN with the new token.')
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
    return import('./drive-client/files.js');
  }

  async listFiles(params: ListFilesParams): Promise<DriveFileList> {
    const { listFiles } = await this.lib();
    return this.withAuth((h) => listFiles(h, params));
  }

  async getFile(fileId: string): Promise<DriveFile> {
    const { getFile } = await this.lib();
    return this.withAuth((h) => getFile(h, fileId));
  }

  async exportFile(fileId: string, mimeType: string, maxBytes: number): Promise<Uint8Array> {
    const { exportFile } = await this.lib();
    return this.withAuth((h) => exportFile(h, fileId, mimeType, maxBytes));
  }

  async downloadFile(fileId: string, maxBytes: number): Promise<Uint8Array> {
    const { downloadFile } = await this.lib();
    return this.withAuth((h) => downloadFile(h, fileId, maxBytes));
  }

  async createFolder(name: string, parentId?: string): Promise<DriveFile> {
    const { createFolder } = await this.lib();
    return this.withAuth((h) => createFolder(h, name, parentId));
  }

  async createFile(request: CreateFileRequest): Promise<DriveFile> {
    const { createFile } = await this.lib();
    return this.withAuth((h) => createFile(h, request));
  }
}

export type ClientFactory = () => IGoogleDriveClient;

/**
 * One client per credential, for the life of the process. Both hosts build a
 * fresh `Server` per HTTP request, so a client built per server would cache its
 * access token for exactly one call.
 */
const clients = new Map<string, IGoogleDriveClient>();

/**
 * Builds the client from an environment, LAZILY: a missing credential is a
 * failed tool call, never a failed boot, so the server lists its tools with no
 * secrets set.
 */
export function createDefaultClient(env: EnvLike = process.env): IGoogleDriveClient {
  const missing = missingCredentials(env);
  if (missing.length > 0) {
    throw new Error(
      `This google-drive server has no credential: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set. ` +
        'It needs an OAuth client id, client secret and refresh token for exactly one Google account, ' +
        `consented for ${GOOGLE_DRIVE_SCOPES.readonly} (and ${GOOGLE_DRIVE_SCOPES.file} for the create tools).`
    );
  }
  const clientId = env.GOOGLE_DRIVE_OAUTH_CLIENT_ID!;
  const clientSecret = env.GOOGLE_DRIVE_OAUTH_CLIENT_SECRET!;
  const refreshToken = env.GOOGLE_DRIVE_OAUTH_REFRESH_TOKEN!;
  const reconnectUrl = env.GOOGLE_DRIVE_RECONNECT_URL || undefined;

  const key = `${clientId}\u0000${clientSecret}\u0000${refreshToken}`;
  let client = clients.get(key);
  if (!client) {
    client = new OAuthGoogleDriveClient(clientId, clientSecret, refreshToken, reconnectUrl);
    clients.set(key, client);
  }
  return client;
}

export interface CreateMCPServerOptions {
  version: string;
  /** The environment THIS instance reads. Defaults to `process.env`. */
  env?: EnvLike;
  /**
   * `readonly`, `readwrite`, or a comma list of them; unset means every tool.
   * Defaults to the env's `GOOGLE_DRIVE_ENABLED_TOOLGROUPS`. An unknown group
   * THROWS rather than widening to every tool, so a typo such as `read-only`
   * cannot serve the create tools.
   */
  enabledToolGroups?: string;
}

export function createMCPServer(options: CreateMCPServerOptions) {
  const env = options.env ?? process.env;
  const groups = parseToolGroups(options.enabledToolGroups ?? env[GOOGLE_DRIVE_TOOLGROUPS_ENV]);

  const server = new Server(
    { name: 'google-drive-workspace-mcp-server', version: options.version },
    { capabilities: { tools: {} } }
  );

  const registerHandlers = async (server: Server, clientFactory?: ClientFactory) => {
    const factory = clientFactory ?? (() => createDefaultClient(env));
    createRegisterTools(factory, groups)(server);
  };

  return { server, registerHandlers };
}
