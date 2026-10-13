/**
 * Every Drive API call this server makes.
 *
 * SCOPE DISCIPLINE. Four reads — list, describe, export, download — that need
 * `drive.readonly`, and two CREATES that need only `drive.file`. There is no
 * update, no delete, no trash, no copy, no move and no permission call. A create
 * always mints a new file id, so nothing here can overwrite, lose or share a
 * file that already exists.
 *
 * `supportsAllDrives` on every call that takes it: without it a file in a shared
 * drive 404s for an account that can plainly see it.
 */
import { throwForDriveApiError } from './api-errors.js';
import type { DriveFile, DriveFileList } from '../types.js';

export const DRIVE_FILES_URL = 'https://www.googleapis.com/drive/v3/files';
export const DRIVE_UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files';
export const FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';

/** What `search_files` asks for per file: enough to choose one, no more. */
export const LIST_FIELDS =
  'nextPageToken,incompleteSearch,' +
  'files(id,name,mimeType,size,modifiedTime,owners(displayName,emailAddress),webViewLink,driveId,shortcutDetails)';

/** What `get_file` asks for. */
export const FILE_FIELDS =
  'id,name,mimeType,description,size,createdTime,modifiedTime,' +
  'owners(displayName,emailAddress),lastModifyingUser(displayName,emailAddress),' +
  'parents,webViewLink,shared,starred,trashed,driveId,shortcutDetails,' +
  'permissions(type,role,emailAddress,domain,displayName),' +
  'capabilities(canEdit,canComment,canDownload)';

/** What a create returns: the new file's id and where to open it. */
const CREATED_FIELDS = 'id,name,mimeType,parents,webViewLink,driveId';

/** The longest a 429 is waited out before the one retry. */
const MAX_RETRY_WAIT_MS = 10_000;

export class DriveFileTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DriveFileTooLargeError';
  }
}

/**
 * One request, retried ONCE on a 429 after its `Retry-After` (capped at 10s).
 * Once, because the calling model can retry a tool call itself and a second
 * silent wait is a tool call that hangs for no visible reason.
 */
async function send(url: string, init: RequestInit, operation: string): Promise<Response> {
  let response = await fetch(url, init);
  if (response.status === 429) {
    const seconds = Number(response.headers.get('retry-after'));
    const waitMs = Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds * 1000, MAX_RETRY_WAIT_MS) : 1000;
    await response.body?.cancel();
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    response = await fetch(url, init);
  }
  if (!response.ok) await throwForDriveApiError(response, operation);
  return response;
}

function filesUrl(path: string, query: Record<string, string>): string {
  return `${DRIVE_FILES_URL}${path}?${new URLSearchParams(query).toString()}`;
}

export interface ListFilesParams {
  /** A complete Drive `q` expression, built by `utils/query.ts`. */
  q: string;
  pageSize: number;
  pageToken?: string;
  /** Omitted for a full-text search, which Drive orders by relevance and refuses to sort. */
  orderBy?: string;
}

export async function listFiles(
  headers: Record<string, string>,
  params: ListFilesParams
): Promise<DriveFileList> {
  const query: Record<string, string> = {
    q: params.q,
    pageSize: String(params.pageSize),
    fields: LIST_FIELDS,
    // Every drive the account can see, not only My Drive. The price is that
    // Drive may search a subset and say so with `incompleteSearch`.
    corpora: 'allDrives',
    includeItemsFromAllDrives: 'true',
    supportsAllDrives: 'true',
  };
  if (params.pageToken) query.pageToken = params.pageToken;
  if (params.orderBy) query.orderBy = params.orderBy;
  const response = await send(filesUrl('', query), { method: 'GET', headers }, 'List Drive files');
  return (await response.json()) as DriveFileList;
}

export async function getFile(headers: Record<string, string>, fileId: string): Promise<DriveFile> {
  const response = await send(
    filesUrl(`/${encodeURIComponent(fileId)}`, { fields: FILE_FIELDS, supportsAllDrives: 'true' }),
    { method: 'GET', headers },
    `Describe Drive file ${fileId}`
  );
  return (await response.json()) as DriveFile;
}

/** A Google-native file (Doc, Sheet, Slides) converted to `mimeType`. Google caps an export at 10MB. */
export async function exportFile(
  headers: Record<string, string>,
  fileId: string,
  mimeType: string,
  maxBytes: number
): Promise<Uint8Array> {
  const response = await send(
    filesUrl(`/${encodeURIComponent(fileId)}/export`, { mimeType }),
    { method: 'GET', headers },
    `Export Drive file ${fileId} as ${mimeType}`
  );
  return readCapped(response, maxBytes);
}

/** A stored file's bytes, as uploaded. */
export async function downloadFile(
  headers: Record<string, string>,
  fileId: string,
  maxBytes: number
): Promise<Uint8Array> {
  const response = await send(
    filesUrl(`/${encodeURIComponent(fileId)}`, { alt: 'media', supportsAllDrives: 'true' }),
    { method: 'GET', headers },
    `Download Drive file ${fileId}`
  );
  return readCapped(response, maxBytes);
}

/**
 * Read a body in chunks and stop at the cap. `arrayBuffer()` would allocate the
 * whole body before anything could refuse it, and `content-length` is absent on
 * an export, so a bound applied after the read is not a bound.
 */
async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
  const advertised = Number(response.headers.get('content-length'));
  if (Number.isFinite(advertised) && advertised > maxBytes) {
    await response.body?.cancel();
    throw new DriveFileTooLargeError(tooLarge(advertised, maxBytes));
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new DriveFileTooLargeError(tooLarge(total, maxBytes));
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function tooLarge(bytes: number, maxBytes: number): string {
  const mb = (n: number) => (n / (1024 * 1024)).toFixed(1);
  return (
    `This file is at least ${mb(bytes)}MB, past the ${mb(maxBytes)}MB this server reads in one ` +
    'call. Open it in the browser instead; get_file returns its link.'
  );
}

export async function createFolder(
  headers: Record<string, string>,
  name: string,
  parentId?: string
): Promise<DriveFile> {
  const body: Record<string, unknown> = { name, mimeType: FOLDER_MIME_TYPE };
  if (parentId) body.parents = [parentId];
  const response = await send(
    filesUrl('', { fields: CREATED_FIELDS, supportsAllDrives: 'true' }),
    { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    `Create Drive folder "${name}"`
  );
  return (await response.json()) as DriveFile;
}

export interface CreateFileRequest {
  name: string;
  /** The type of the bytes being uploaded. */
  mimeType: string;
  content: Uint8Array;
  parentId?: string;
  /**
   * A Google-native type to convert the upload into (a Doc, Sheet or Slides
   * deck). Drive converts when the metadata's type differs from the media's.
   */
  convertTo?: string;
}

/**
 * One multipart upload: the metadata part, then the media part. A single
 * request, so a failure never leaves a metadata-only empty file behind.
 */
export async function createFile(
  headers: Record<string, string>,
  request: CreateFileRequest
): Promise<DriveFile> {
  const metadata: Record<string, unknown> = {
    name: request.name,
    mimeType: request.convertTo ?? request.mimeType,
  };
  if (request.parentId) metadata.parents = [request.parentId];

  const boundary = `strad-drive-${crypto.randomUUID()}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
      `${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\nContent-Type: ${request.mimeType}\r\n\r\n`,
    'utf8'
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  const body = Buffer.concat([head, Buffer.from(request.content), tail]);

  const query = new URLSearchParams({
    uploadType: 'multipart',
    fields: CREATED_FIELDS,
    supportsAllDrives: 'true',
  });
  const response = await send(
    `${DRIVE_UPLOAD_URL}?${query.toString()}`,
    {
      method: 'POST',
      headers: { ...headers, 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    },
    `Create Drive file "${request.name}"`
  );
  return (await response.json()) as DriveFile;
}
