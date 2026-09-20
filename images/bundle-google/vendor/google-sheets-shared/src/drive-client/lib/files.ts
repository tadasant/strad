/**
 * The two Drive API calls this server makes, and nothing else.
 *
 * SCOPE DISCIPLINE. Everything here is `drive.readonly` work: describe a file,
 * download its bytes. There is no create, no copy, no export and no permission
 * call — notably NOT `files.copy` with `mimeType: application/vnd.google-apps.spreadsheet`,
 * which is the obvious way to make an .xlsx readable and is wrong for a read
 * tier: it leaves a second file in the owner's Drive every time an agent reads a
 * spreadsheet. `files.export` is not an option either; Drive exports only NATIVE
 * Workspace documents, and an uploaded .xlsx is precisely not one.
 */
import { throwForGoogleApiError } from '../../google-sheets-client/lib/api-errors.js';

export const DRIVE_BASE_URL = 'https://www.googleapis.com/drive/v3/files';

/** How large a file this server will pull into the bundle container's memory. */
export const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;

export interface DriveFileMetadata {
  id?: string;
  name?: string;
  mimeType?: string;
  /** Bytes, as a STRING — Drive reports int64 fields as strings in JSON. */
  size?: string;
  modifiedTime?: string;
  [k: string]: unknown;
}

const METADATA_FIELDS = 'id,name,mimeType,size,modifiedTime';

/**
 * `supportsAllDrives` on both calls: without it a file in a shared drive 404s
 * for an account that can plainly see it, which is the least diagnosable
 * failure this path has.
 */
function driveUrl(fileId: string, query: Record<string, string>): string {
  const params = new URLSearchParams({ supportsAllDrives: 'true', ...query });
  return `${DRIVE_BASE_URL}/${encodeURIComponent(fileId)}?${params.toString()}`;
}

export async function getFileMetadata(
  headers: Record<string, string>,
  fileId: string
): Promise<DriveFileMetadata> {
  const response = await fetch(driveUrl(fileId, { fields: METADATA_FIELDS }), {
    method: 'GET',
    headers,
  });
  if (!response.ok) {
    await throwForGoogleApiError(response, `Describe Drive file ${fileId}`);
  }
  return (await response.json()) as DriveFileMetadata;
}

export class DriveFileTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DriveFileTooLargeError';
  }
}

/** The file's bytes. Refuses anything past {@link MAX_DOWNLOAD_BYTES}. */
export async function downloadFile(
  headers: Record<string, string>,
  fileId: string,
  declaredSize?: string
): Promise<Uint8Array> {
  const declared = declaredSize === undefined ? undefined : Number(declaredSize);
  if (declared !== undefined && Number.isFinite(declared) && declared > MAX_DOWNLOAD_BYTES) {
    throw new DriveFileTooLargeError(
      `This Drive file is ${Math.round(declared / (1024 * 1024))}MB, past the ` +
        `${MAX_DOWNLOAD_BYTES / (1024 * 1024)}MB this server will download and parse in one ` +
        'call. Open it in Google Sheets and use File > Save as Google Sheets; the Sheets API ' +
        'then reads it a range at a time rather than whole.'
    );
  }

  const response = await fetch(driveUrl(fileId, { alt: 'media' }), { method: 'GET', headers });
  if (!response.ok) {
    await throwForGoogleApiError(response, `Download Drive file ${fileId}`);
  }

  // Drive does not always send content-length on a media download, so the
  // declared size above is a cheap pre-check and this is the real bound.
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_DOWNLOAD_BYTES) {
    throw new DriveFileTooLargeError(
      `This Drive file downloaded to ${Math.round(bytes.byteLength / (1024 * 1024))}MB, past ` +
        `the ${MAX_DOWNLOAD_BYTES / (1024 * 1024)}MB this server will parse in one call.`
    );
  }
  return bytes;
}
