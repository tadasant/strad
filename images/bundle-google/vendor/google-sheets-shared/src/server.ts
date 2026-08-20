import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { OAuth2Client } from 'google-auth-library';
import { createRegisterTools } from './tools.js';
import type { Spreadsheet, SheetProperties, ValueRange, BatchGetValuesResponse } from './types.js';
import type { ReadValuesOptions, ValueInputOption } from './google-sheets-client/lib/values.js';
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

export type EnvLike = Readonly<Record<string, string | undefined>>;

/** Which of {@link GOOGLE_SHEETS_ENV_NAMES} this environment does not carry. */
export function missingCredentials(env: EnvLike): string[] {
  return GOOGLE_SHEETS_ENV_NAMES.filter((name) => !env[name]);
}

/** Everything the tools can ask Google for. Read first, then the four writes. */
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

  constructor(clientId: string, clientSecret: string, refreshToken: string) {
    this.oauth2Client = new OAuth2Client(clientId, clientSecret);
    this.oauth2Client.setCredentials({ refresh_token: refreshToken });
  }

  private async refreshTokenImpl(): Promise<{ token: string; expiryDate: number }> {
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
            '"testing" mode expires after 7 days. Re-run the consent flow for this account ' +
            "and re-seed GOOGLE_SHEETS_OAUTH_REFRESH_TOKEN in strad's secret store."
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

  async getSpreadsheet(spreadsheetId: string): Promise<Spreadsheet> {
    const headers = await this.getHeaders();
    const { getSpreadsheet } = await import('./google-sheets-client/lib/get-spreadsheet.js');
    return getSpreadsheet(headers, spreadsheetId);
  }

  async getValues(
    spreadsheetId: string,
    range: string,
    options?: ReadValuesOptions
  ): Promise<ValueRange> {
    const headers = await this.getHeaders();
    const { getValues } = await import('./google-sheets-client/lib/values.js');
    return getValues(headers, spreadsheetId, range, options);
  }

  async batchGetValues(
    spreadsheetId: string,
    ranges: string[],
    options?: ReadValuesOptions
  ): Promise<BatchGetValuesResponse> {
    const headers = await this.getHeaders();
    const { batchGetValues } = await import('./google-sheets-client/lib/values.js');
    return batchGetValues(headers, spreadsheetId, ranges, options);
  }

  async updateValues(
    spreadsheetId: string,
    range: string,
    values: unknown[][],
    valueInputOption: ValueInputOption
  ): Promise<UpdateValuesResponse> {
    const headers = await this.getHeaders();
    const { updateValues } = await import('./google-sheets-client/lib/values.js');
    return updateValues(headers, spreadsheetId, range, values, valueInputOption);
  }

  async appendValues(
    spreadsheetId: string,
    range: string,
    values: unknown[][],
    valueInputOption: ValueInputOption
  ): Promise<AppendValuesResponse> {
    const headers = await this.getHeaders();
    const { appendValues } = await import('./google-sheets-client/lib/values.js');
    return appendValues(headers, spreadsheetId, range, values, valueInputOption);
  }

  async clearValues(spreadsheetId: string, range: string): Promise<ClearValuesResponse> {
    const headers = await this.getHeaders();
    const { clearValues } = await import('./google-sheets-client/lib/values.js');
    return clearValues(headers, spreadsheetId, range);
  }

  async addSheet(
    spreadsheetId: string,
    properties: { title: string; index?: number; rowCount?: number; columnCount?: number }
  ): Promise<SheetProperties> {
    const headers = await this.getHeaders();
    const { addSheet } = await import('./google-sheets-client/lib/batch-update.js');
    return addSheet(headers, spreadsheetId, properties);
  }
}

export type ClientFactory = () => IGoogleSheetsClient;

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
 * be one mount's failed tool call rather than a boot failure for the eighteen
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

  return new OAuthGoogleSheetsClient(
    env.GOOGLE_SHEETS_OAUTH_CLIENT_ID!,
    env.GOOGLE_SHEETS_OAUTH_CLIENT_SECRET!,
    env.GOOGLE_SHEETS_OAUTH_REFRESH_TOKEN!
  );
}

/**
 * ONE server, read tools AND write tools.
 *
 * The `-ro` / `-rw` split is NOT made here. strad's gateway carries a `tools:`
 * allow-list per slug and enforces it on `tools/list` and on `tools/call`
 * (src/gateway/toolPolicy.ts), so `google-sheets-tadas412-ro` is this same server
 * with the four write tools withheld. Deciding it in the container instead would
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
