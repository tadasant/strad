/**
 * The Office path: recognise the refusal, fetch the file, parse it, cache it.
 *
 * TRIGGERED BY A FAILURE, never speculatively. A native spreadsheet's read is
 * byte-for-byte the call it always was — same URL, same latency, no Drive
 * request — and this code runs only after the Sheets API has said
 * `400 FAILED_PRECONDITION`, which it says for exactly one reason: the document
 * is an Office file. That keeps the common path free and makes the Drive scope
 * something only a caller who needs it ever notices is missing.
 */
import { GoogleApiError } from '../google-sheets-client/lib/api-errors.js';
import { downloadFile, getFileMetadata } from '../drive-client/lib/files.js';
import { DELIMITED_MIME_TYPES, delimitedWorkbook } from './delimited.js';
import { XLSX_MIME_TYPES, parseXlsx } from './xlsx.js';
import type { OfficeWorkbook } from './workbook.js';

/** The Drive scope a slug needs before any of this works. */
export const DRIVE_READONLY_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';

/**
 * Does this failure mean "the document is an Office file"?
 *
 * The Sheets API answers `400 FAILED_PRECONDITION` with the message "This
 * operation is not supported for this document. The document must not be an
 * Office file." — the second sentence is the whole diagnosis, and it is the only
 * condition under which v4 returns that status, so matching on either half is
 * safe. Matching on the status alone would not be.
 */
export function isOfficeFileError(error: unknown): boolean {
  if (!(error instanceof GoogleApiError) || error.status !== 400) return false;
  const text = error.message.toLowerCase();
  return (
    text.includes('failed_precondition') ||
    text.includes('this operation is not supported for this document')
  );
}

/** Formats Drive holds that are spreadsheets but that this cannot parse. */
const UNREADABLE_SPREADSHEET_FORMATS: Record<string, string> = {
  'application/vnd.ms-excel':
    'a legacy .xls workbook (the binary BIFF format Excel used before 2007)',
  'application/vnd.oasis.opendocument.spreadsheet': 'an OpenDocument .ods spreadsheet',
  'application/vnd.ms-excel.sheet.binary.macroEnabled.12': 'a binary .xlsb workbook',
};

export class OfficeFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OfficeFormatError';
  }
}

/** True if this server can parse what Drive says the file is. */
export function isReadableOfficeMimeType(mimeType: string): boolean {
  return (
    (XLSX_MIME_TYPES as readonly string[]).includes(mimeType) ||
    (DELIMITED_MIME_TYPES as readonly string[]).includes(mimeType)
  );
}

/** The refusal for a format neither the Sheets API nor this server can read. */
export function unreadableFormatError(title: string, mimeType: string): OfficeFormatError {
  const known = UNREADABLE_SPREADSHEET_FORMATS[mimeType];
  return new OfficeFormatError(
    known
      ? `"${title}" is ${known}, which the Sheets API cannot read and this server cannot ` +
        'parse. Open it in Google Sheets and use File > Save as Google Sheets, which mints ' +
        'a native spreadsheet this server reads directly.'
      : `"${title}" has mime type ${mimeType}, which is neither a Google Sheet nor an Office ` +
        'workbook (.xlsx, .xlsm) nor a delimited file (.csv, .tsv). This server reads those ' +
        'and nothing else.'
  );
}

/** Turn downloaded bytes into a workbook, by what Drive says the file is. */
export function parseOfficeFile(
  bytes: Uint8Array,
  options: { title: string; mimeType: string }
): OfficeWorkbook {
  const { mimeType } = options;
  if ((XLSX_MIME_TYPES as readonly string[]).includes(mimeType)) {
    return parseXlsx(bytes, options);
  }
  if ((DELIMITED_MIME_TYPES as readonly string[]).includes(mimeType)) {
    return delimitedWorkbook(bytes, options);
  }
  throw unreadableFormatError(options.title, mimeType);
}

/**
 * What to tell a caller when the DRIVE half fails.
 *
 * By the time this runs, two things are known and neither is in the raw error:
 * the file is an Office file, and the only way to read it is Drive. A bare
 * `403 Permission denied` at this point sends a reader to check file sharing
 * when the actual cause is a scope nobody consented for — so every Drive
 * failure on this path is re-narrated with both facts in it.
 */
export function describeDriveFailure(
  error: unknown,
  context: { spreadsheetId: string; reconnectUrl?: string }
): Error {
  const preamble =
    `The Sheets API refused ${context.spreadsheetId} because it is an Office-format file ` +
    '(an .xlsx, .csv or similar uploaded to Drive rather than converted to a Google Sheet). ' +
    'strad can read those by downloading them from Drive instead, and that download failed.';

  const convert =
    'Alternatively, with no scope change at all: open the file in Google Sheets and use ' +
    'File > Save as Google Sheets. That mints a NEW native spreadsheet (a 44-character id, ' +
    'where an uploaded file id is around 33) which the Sheets API reads directly.';

  if (error instanceof GoogleApiError && (error.status === 403 || error.status === 401)) {
    const text = error.message.toLowerCase();
    const scopeRefusal =
      text.includes('insufficient authentication scopes') ||
      text.includes('access_token_scope_insufficient') ||
      text.includes('insufficientpermissions') ||
      text.includes('request had insufficient');
    if (scopeRefusal) {
      return new Error(
        `${preamble}\n\nGoogle refused the download for lack of scope: this slug's refresh ` +
          `token was never consented for Drive. To fix it, add ${DRIVE_READONLY_SCOPE} to ` +
          "this slug's `oauth: scopes:` in strad's config and deploy, then press Reconnect " +
          `Google on ${context.reconnectUrl ?? "this slug's page in strad's console"} and ` +
          'consent again as this account — a scope added to a config does not reach an ' +
          `already-minted refresh token.\n\n${convert}\n\nGoogle said: ${error.message}`
      );
    }
    return new Error(
      `${preamble}\n\nDrive refused it: the account this slug's refresh token belongs to is ` +
        `not allowed to read that file. Check who the file is shared with.\n\n${convert}\n\n` +
        `Google said: ${error.message}`
    );
  }

  if (error instanceof GoogleApiError && error.status === 404) {
    return new Error(
      `${preamble}\n\nDrive has no file with that id visible to this slug's account. Check ` +
        `the id, and check that the file is shared with that account.\n\n${convert}\n\n` +
        `Google said: ${error.message}`
    );
  }

  const message = error instanceof Error ? error.message : String(error);
  return new Error(`${preamble}\n\n${message}\n\n${convert}`);
}

/**
 * A parsed workbook, cached briefly per file.
 *
 * `find_in_spreadsheet` alone reads the map and then every tab, which is two
 * calls into this loader for one tool call; without a cache that is two
 * downloads and two parses of the same megabytes. The TTL is short because the
 * file is someone's live document and a stale read is worse than a slow one, and
 * the entry count is small because this process hosts twenty-two servers and
 * several Google accounts.
 *
 * The cache holds the PROMISE, not the workbook, so concurrent ranges of one
 * batch share a single download rather than racing to start their own.
 */
const WORKBOOK_TTL_MS = 60_000;
const MAX_CACHED_WORKBOOKS = 3;

interface CacheEntry {
  at: number;
  workbook: Promise<OfficeWorkbook>;
}

export class OfficeWorkbookLoader {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly headers: () => Promise<Record<string, string>>,
    private readonly reconnectUrl?: string
  ) {}

  async load(spreadsheetId: string): Promise<OfficeWorkbook> {
    const cached = this.cache.get(spreadsheetId);
    if (cached && Date.now() - cached.at < WORKBOOK_TTL_MS) return cached.workbook;

    const pending = this.fetchAndParse(spreadsheetId);
    this.cache.set(spreadsheetId, { at: Date.now(), workbook: pending });
    // A failed load must not be remembered: the next call may be made after the
    // scope was granted, and serving it a cached rejection would report the
    // fix as not having worked.
    pending.catch(() => this.cache.delete(spreadsheetId));
    this.evictOldest();
    return pending;
  }

  private evictOldest(): void {
    while (this.cache.size > MAX_CACHED_WORKBOOKS) {
      // Insertion order: the first key is the least recently loaded.
      const oldest = this.cache.keys().next();
      if (oldest.done) return;
      this.cache.delete(oldest.value);
    }
  }

  private async fetchAndParse(spreadsheetId: string): Promise<OfficeWorkbook> {
    const headers = await this.headers();
    let bytes: Uint8Array;
    let title: string;
    let mimeType: string;
    try {
      const metadata = await getFileMetadata(headers, spreadsheetId);
      title = metadata.name ?? spreadsheetId;
      mimeType = metadata.mimeType ?? 'application/octet-stream';
      // Refuse a format we cannot parse BEFORE spending the download on it.
      if (!isReadableOfficeMimeType(mimeType)) throw unreadableFormatError(title, mimeType);
      bytes = await downloadFile(headers, spreadsheetId, metadata.size);
    } catch (error) {
      if (error instanceof OfficeFormatError) throw error;
      throw describeDriveFailure(error, { spreadsheetId, reconnectUrl: this.reconnectUrl });
    }

    return parseOfficeFile(bytes, { title, mimeType });
  }
}

/**
 * A read, with the Office-file path behind it.
 *
 * The Sheets call is made first and UNCHANGED, so a native spreadsheet pays
 * nothing for any of this: no extra request, no extra scope, no behaviour
 * change. Only `400 FAILED_PRECONDITION` — the API's one way of saying "this
 * document is an Office file" — diverts to the workbook. Every other failure,
 * including a 404 for a spreadsheet that does not exist and a 403 for one the
 * account cannot see, propagates exactly as before.
 *
 * Exported rather than inlined into the client so that the branch — which
 * decides whether a Drive request is made at all — is reachable by a test.
 */
export async function readWithOfficeFallback<T>(
  viaSheetsApi: () => Promise<T>,
  viaWorkbook: () => Promise<T>
): Promise<T> {
  try {
    return await viaSheetsApi();
  } catch (error) {
    if (!isOfficeFileError(error)) throw error;
    return await viaWorkbook();
  }
}

/**
 * Why a write cannot take the same path.
 *
 * Reading an Office file is a download; writing one would be a download, an
 * edit and an UPLOAD — a Drive WRITE scope, a re-encoded workbook, and a
 * last-writer-wins race against whoever has the file open in the Sheets UI.
 * None of that belongs behind a tool called `update_sheet_values`, so the write
 * tools refuse and say what to do instead.
 */
export function officeWriteRefusal(operation: string, spreadsheetId: string): Error {
  return new Error(
    `${operation} cannot edit ${spreadsheetId}: it is an Office-format file (an .xlsx or ` +
      'similar uploaded to Drive rather than converted to a Google Sheet), and the Sheets ' +
      'API refuses every write against one. strad can READ such a file — the four read ' +
      'tools download it from Drive and parse it, given the ' +
      `${DRIVE_READONLY_SCOPE} scope — but it will not write one back. To make this file ` +
      'editable, open it in Google Sheets and use File > Save as Google Sheets, then use ' +
      'the new spreadsheet id.'
  );
}

/** Run a write, turning the Office-file refusal into one that explains itself. */
export async function writeRefusingOfficeFiles<T>(
  operation: string,
  spreadsheetId: string,
  call: () => Promise<T>
): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (isOfficeFileError(error)) throw officeWriteRefusal(operation, spreadsheetId);
    throw error;
  }
}
