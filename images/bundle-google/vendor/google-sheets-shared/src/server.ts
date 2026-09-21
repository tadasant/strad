import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { OAuth2Client } from 'google-auth-library';
import { createRegisterTools } from './tools.js';
import { OfficeWorkbookLoader } from './office/load.js';
import { withOfficeFallback } from './office/client.js';
import type { Spreadsheet, SheetProperties, ValueRange, BatchGetValuesResponse } from './types.js';
import type { ReadValuesOptions, ValueInputOption } from './google-sheets-client/lib/values.js';
import type { CreateSpreadsheetRequest } from './google-sheets-client/lib/create-spreadsheet.js';
import type {
  UpdateValuesResponse,
  AppendValuesResponse,
  ClearValuesResponse,
} from './google-sheets-client/lib/values.js';

/**
 * The scopes a refresh token for this server has to have been consented for.
 *
 * ONE ACCOUNT PER CREDENTIAL, and the credential decides what the account can do:
 * a token consented for `spreadsheets.readonly` can serve every read tool here
 * and will be refused by Google on every write one. That is the property strad's
 * read-only slugs are built on — see the note about tiers below.
 */
export const GOOGLE_SHEETS_SCOPES = {
  /** Read and write. What a `-rw` slug's token needs. */
  readwrite: 'https://www.googleapis.com/auth/spreadsheets',
  /** Read only. Enough for get_spreadsheet / get_sheet_values / batch_get_sheet_values / find_in_spreadsheet. */
  readonly: 'https://www.googleapis.com/auth/spreadsheets.readonly',
  /**
   * OPTIONAL, and only for reading Office-format files held in Drive.
   *
   * An .xlsx or .csv uploaded to Drive is invisible to the Sheets API — every
   * call against it is `400 FAILED_PRECONDITION` — so the four read tools fall
   * back to downloading the file from Drive and parsing it here. That fallback
   * needs this scope, and a slug without it serves native spreadsheets exactly
   * as before and says precisely what is missing when asked for an Office file.
   *
   * It is READ-ONLY, so a `-ro` slug carrying it is still derived as read-only
   * by strad's connector — connectorTier() at the repo root's
   * src/connectors/index.ts reads the `.readonly` suffix — but it is also
   * BROAD: it reaches every file in the account's Drive,
   * not only spreadsheets. Google offers no narrower alternative that can
   * download a file the app did not itself create — `drive.file` covers only
   * app-created files, and `drive.metadata.readonly` cannot read content.
   */
  driveReadonly: 'https://www.googleapis.com/auth/drive.readonly',
} as const;

/**
 * The variables ONE instance of this server reads.
 *
 * They are read out of an injected `env`, never out of `process.env` directly,
 * because the strad bundle runs SEVERAL instances of this server in one process —
 * one per Google account — and hands each the environment as its own slug sees
 * it (`GOOGLE_SHEETS_TADAS412_RO__GOOGLE_SHEETS_OAUTH_REFRESH_TOKEN` and friends,
 * flattened back to these bare names). A module that reached for the global would
 * give every account the last one's credential.
 */
export const GOOGLE_SHEETS_ENV_NAMES = [
  'GOOGLE_SHEETS_OAUTH_CLIENT_ID',
  'GOOGLE_SHEETS_OAUTH_CLIENT_SECRET',
  'GOOGLE_SHEETS_OAUTH_REFRESH_TOKEN',
] as const;

/**
 * The OAuth APP half of that credential — everything except the account's token.
 *
 * These two are the ones a human seeds BEFORE anything is connected; the third
 * is minted by a consent flow that cannot run until the slug is deployed and
 * serving. So they, and not {@link GOOGLE_SHEETS_ENV_NAMES}, are what says "a
 * deployment asked for a mount here": the strad bundle host keys its per-slug
 * discovery on this list, which is what lets an unconnected slug mount, list its
 * tools, and report itself degraded until the token lands.
 *
 * It is a marker set, not a credential. {@link missingCredentials} still gates on
 * all three, so a mount discovered by these two fails every call until the third
 * arrives.
 */
export const GOOGLE_SHEETS_OAUTH_APP_ENV_NAMES = [
  'GOOGLE_SHEETS_OAUTH_CLIENT_ID',
  'GOOGLE_SHEETS_OAUTH_CLIENT_SECRET',
] as const;

export type EnvLike = Readonly<Record<string, string | undefined>>;

/** Which of {@link GOOGLE_SHEETS_ENV_NAMES} this environment does not carry. */
export function missingCredentials(env: EnvLike): string[] {
  return GOOGLE_SHEETS_ENV_NAMES.filter((name) => !env[name]);
}

/** Everything the tools can ask Google for. Read first, then the five writes. */
export interface IGoogleSheetsClient {
  getSpreadsheet(spreadsheetId: string): Promise<Spreadsheet>;
  getValues(
    spreadsheetId: string,
    range: string,
    options?: ReadValuesOptions
  ): Promise<ValueRange>;
  batchGetValues(
    spreadsheetId: string,
    ranges: string[],
    options?: ReadValuesOptions
  ): Promise<BatchGetValuesResponse>;
  updateValues(
    spreadsheetId: string,
    range: string,
    values: unknown[][],
    valueInputOption: ValueInputOption
  ): Promise<UpdateValuesResponse>;
  appendValues(
    spreadsheetId: string,
    range: string,
    values: unknown[][],
    valueInputOption: ValueInputOption
  ): Promise<AppendValuesResponse>;
  clearValues(spreadsheetId: string, range: string): Promise<ClearValuesResponse>;
  addSheet(
    spreadsheetId: string,
    properties: { title: string; index?: number; rowCount?: number; columnCount?: number }
  ): Promise<SheetProperties>;
  createSpreadsheet(request: CreateSpreadsheetRequest): Promise<Spreadsheet>;
}

/**
 * The OAuth2 client every instance uses.
 *
 * AUTH MODEL. A refresh token belonging to ONE Google account, minted once by a
 * human running the consent flow, then stored in strad's secret store. There is
 * no service account and no domain-wide delegation here: a DWD credential can
 * impersonate any user in a Workspace domain, which is far more authority than
 * "read Tadas's spreadsheets", and it cannot reach a consumer gmail.com account
 * at all. The trade is that a refresh token is a human-minted artifact — it does
 * not rotate on its own, and if it is revoked (password change, consent removed,
 * or an unverified app's 7-day testing-mode expiry) every call fails with
 * `invalid_grant` until a human re-consents and re-seeds it. `refreshTokenImpl`
 * says exactly that when it happens.
 */
class OAuthGoogleSheetsClient implements IGoogleSheetsClient {
  private oauth2Client: OAuth2Client;
  private cachedToken: string | null = null;
  private tokenExpiry = 0;
  private refreshPromise: Promise<void> | null = null;

  constructor(
    clientId: string,
    clientSecret: string,
    refreshToken: string,
    /**
     * Where a human goes to re-consent: this slug's own console page, which
     * carries a Reconnect Google button. Optional, because a deployment that is
     * not strad's console still gets a usable hint.
     */
    private readonly reconnectUrl?: string
  ) {
    this.oauth2Client = new OAuth2Client(clientId, clientSecret);
    this.oauth2Client.setCredentials({ refresh_token: refreshToken });
  }

  /**
   * Bearer headers for THIS account, for a call this class does not make.
   *
   * The Office path reads the file from Drive rather than from Sheets, and it
   * has to do so as the same account — this is the only credential in the
   * process that may read that file. Public for that one caller.
   */
  authorizedHeaders(): Promise<Record<string, string>> {
    return this.getHeaders();
  }

  private async refreshTokenImpl(): Promise<{ token: string; expiryDate: number }> {
    let token: string | null | undefined;
    let res: { data?: { expiry_date?: number } } | null | undefined;
    try {
      ({ token, res } = await this.oauth2Client.getAccessToken());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('invalid_grant')) {
        // NAME THE PAGE. Re-consenting used to mean an OAuth Playground round
        // trip and a hand-seeded parameter; it is now one button on this slug's
        // own console page, and an error that does not say so sends a human back
        // to the old procedure.
        throw new Error(
          `${message}\n\nHint: this refresh token is no longer valid — revoked, expired, or ` +
            'invalidated by a password change. A token issued by an OAuth app still in ' +
            '"testing" mode expires after 7 days. ' +
            (this.reconnectUrl
              ? `Open ${this.reconnectUrl} in strad's console and click Reconnect Google; ` +
                'strad re-runs the consent and rotates the stored credential.'
              : "Re-run the consent flow for this account from this slug's page in strad's " +
                'console (Reconnect Google), which rotates the stored credential.')
        );
      }
      throw error;
    }
    if (!token) {
      throw new Error('Failed to obtain an access token from the OAuth refresh token');
    }
    const expiryDate = res?.data?.expiry_date;
    return {
      token,
      expiryDate: typeof expiryDate === 'number' ? expiryDate : Date.now() + 3600000,
    };
  }

  /**
   * Bearer headers, refreshing the access token at most once at a time.
   *
   * The single-flight promise matters here more than it looks: a batch_get of ten
   * ranges on a cold instance would otherwise start ten token exchanges against
   * Google for one credential.
   */
  private async getHeaders(): Promise<Record<string, string>> {
    if (this.cachedToken && Date.now() < this.tokenExpiry - 60000) {
      return {
        Authorization: `Bearer ${this.cachedToken}`,
        'Content-Type': 'application/json',
      };
    }

    if (!this.refreshPromise) {
      this.refreshPromise = this.refreshTokenImpl()
        .then(({ token, expiryDate }) => {
          this.cachedToken = token;
          this.tokenExpiry = expiryDate;
        })
        .finally(() => {
          this.refreshPromise = null;
        });
    }
    await this.refreshPromise;

    return {
      Authorization: `Bearer ${this.cachedToken}`,
      'Content-Type': 'application/json',
    };
  }

  /**
   * Run one API call, and drop the cached access token if Google says it is not
   * a valid one.
   *
   * Without this, a token that expired earlier than the expiry we recorded — the
   * library can hand back its own cached token, in which case there is no expiry
   * to record and we assume an hour — turns into a 401 on every subsequent call
   * for as long as that hour lasts, because nothing would ever ask for a new one.
   */
  private async withAuth<T>(call: (headers: Record<string, string>) => Promise<T>): Promise<T> {
    const headers = await this.getHeaders();
    try {
      return await call(headers);
    } catch (error) {
      if ((error as { category?: string })?.category === 'auth') {
        this.cachedToken = null;
        this.tokenExpiry = 0;
      }
      throw error;
    }
  }

  async getSpreadsheet(spreadsheetId: string): Promise<Spreadsheet> {
    const { getSpreadsheet } = await import('./google-sheets-client/lib/get-spreadsheet.js');
    return this.withAuth((headers) => getSpreadsheet(headers, spreadsheetId));
  }

  async getValues(
    spreadsheetId: string,
    range: string,
    options?: ReadValuesOptions
  ): Promise<ValueRange> {
    const { getValues } = await import('./google-sheets-client/lib/values.js');
    return this.withAuth((headers) => getValues(headers, spreadsheetId, range, options));
  }

  async batchGetValues(
    spreadsheetId: string,
    ranges: string[],
    options?: ReadValuesOptions
  ): Promise<BatchGetValuesResponse> {
    const { batchGetValues } = await import('./google-sheets-client/lib/values.js');
    return this.withAuth((headers) => batchGetValues(headers, spreadsheetId, ranges, options));
  }

  async updateValues(
    spreadsheetId: string,
    range: string,
    values: unknown[][],
    valueInputOption: ValueInputOption
  ): Promise<UpdateValuesResponse> {
    const { updateValues } = await import('./google-sheets-client/lib/values.js');
    return this.withAuth((headers) =>
      updateValues(headers, spreadsheetId, range, values, valueInputOption)
    );
  }

  async appendValues(
    spreadsheetId: string,
    range: string,
    values: unknown[][],
    valueInputOption: ValueInputOption
  ): Promise<AppendValuesResponse> {
    const { appendValues } = await import('./google-sheets-client/lib/values.js');
    return this.withAuth((headers) =>
      appendValues(headers, spreadsheetId, range, values, valueInputOption)
    );
  }

  async clearValues(spreadsheetId: string, range: string): Promise<ClearValuesResponse> {
    const { clearValues } = await import('./google-sheets-client/lib/values.js');
    return this.withAuth((headers) => clearValues(headers, spreadsheetId, range));
  }

  async addSheet(
    spreadsheetId: string,
    properties: { title: string; index?: number; rowCount?: number; columnCount?: number }
  ): Promise<SheetProperties> {
    const { addSheet } = await import('./google-sheets-client/lib/batch-update.js');
    return this.withAuth((headers) => addSheet(headers, spreadsheetId, properties));
  }

  async createSpreadsheet(request: CreateSpreadsheetRequest): Promise<Spreadsheet> {
    const { createSpreadsheet } = await import('./google-sheets-client/lib/create-spreadsheet.js');
    return this.withAuth((headers) => createSpreadsheet(headers, request));
  }
}

export type ClientFactory = () => IGoogleSheetsClient;

/**
 * One client per credential, for the life of the process.
 *
 * Both hosts build a FRESH `Server` per HTTP request, so a client constructed
 * inside the factory would be constructed per tool call — and its access-token
 * cache would then live for exactly one call, making every call pay a full token
 * exchange against Google. Keying on the credential keeps the cache where it is
 * useful and keeps two accounts apart, which is the property the whole per-slug
 * design rests on.
 */
const clients = new Map<string, IGoogleSheetsClient>();

export interface CreateMCPServerOptions {
  version: string;
  /**
   * The environment THIS instance reads. Defaults to `process.env` for a
   * single-instance deployment; the strad bundle passes a per-slug view.
   */
  env?: EnvLike;
}

/**
 * Builds the client from an environment, LAZILY.
 *
 * Lazily is load-bearing: the image is credential-free, and a missing token must
 * be one mount's failed tool call rather than a boot failure for the twenty
 * servers sharing the process. So this throws when a tool is CALLED, never when
 * the server is built or its tools are listed.
 */
export function createDefaultClient(env: EnvLike = process.env): IGoogleSheetsClient {
  const missing = missingCredentials(env);
  if (missing.length > 0) {
    throw new Error(
      `This google-sheets mount has no credential: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set. ` +
        'Each slug supplies its own OAuth client id, client secret and refresh token, ' +
        'for exactly one Google account.'
    );
  }

  const clientId = env.GOOGLE_SHEETS_OAUTH_CLIENT_ID!;
  const clientSecret = env.GOOGLE_SHEETS_OAUTH_CLIENT_SECRET!;
  const refreshToken = env.GOOGLE_SHEETS_OAUTH_REFRESH_TOKEN!;
  // Not a credential and not one of GOOGLE_SHEETS_ENV_NAMES: an absent one costs
  // a link in an error message and nothing else. The bundle host composes it
  // from the gateway's public URL and this mount's slug.
  const reconnectUrl = env.GOOGLE_SHEETS_RECONNECT_URL || undefined;

  // The key is the credential itself, so two slugs holding the same account
  // share one token cache and two accounts can never share one.
  const key = `${clientId}\u0000${clientSecret}\u0000${refreshToken}`;
  const existing = clients.get(key);
  if (existing) return existing;

  const sheets = new OAuthGoogleSheetsClient(clientId, clientSecret, refreshToken, reconnectUrl);
  // The Office reader is built PER CREDENTIAL, beside the token cache and for
  // the same reason: it caches parsed workbooks by file id, and one shared
  // across the mounts in this process would serve one Google account a workbook
  // another account downloaded.
  const client = withOfficeFallback(
    sheets,
    new OfficeWorkbookLoader(() => sheets.authorizedHeaders(), reconnectUrl)
  );
  clients.set(key, client);
  return client;
}

/**
 * ONE server, read tools AND write tools.
 *
 * The `-ro` / `-rw` split is NOT made here. strad's gateway carries a `tools:`
 * allow-list per slug and enforces it on `tools/list` and on `tools/call`
 * (src/gateway/toolPolicy.ts), so `google-sheets-tadas412-ro` is this same server
 * with the five write tools withheld. Deciding it in the container instead would
 * mean a container per tier per account — six of them — which is the architecture
 * this bundle exists to have deleted.
 *
 * Because each slug carries its OWN credential, a deployment that wants the read
 * tier enforced by Google as well as by strad can seed the `-ro` slug a refresh
 * token consented only for `spreadsheets.readonly`. Then a write tool that
 * somehow reached this code is refused twice.
 */
export function createMCPServer(options: CreateMCPServerOptions) {
  const env = options.env ?? process.env;

  const server = new Server(
    {
      name: 'google-sheets-workspace-mcp-server',
      version: options.version,
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  const registerHandlers = async (server: Server, clientFactory?: ClientFactory) => {
    const factory = clientFactory ?? (() => createDefaultClient(env));
    createRegisterTools(factory)(server);
  };

  return { server, registerHandlers };
}
