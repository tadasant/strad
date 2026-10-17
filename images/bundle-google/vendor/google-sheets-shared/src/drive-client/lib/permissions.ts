/**
 * The one Drive WRITE this server makes: `permissions.create`, behind
 * `share_spreadsheet`.
 *
 * Kept apart from ./files.ts, whose header promises `drive.readonly` work and
 * nothing else. This call needs the full `https://www.googleapis.com/auth/drive`
 * scope: `drive.file` reaches only files this OAuth app created, and the
 * spreadsheets an agent is asked to share are mostly ones a human made.
 *
 * The request shape is google-docs' `createPermission`
 * (`vendor/google-docs-shared/src/google-docs-client/lib/drive-permissions.ts`)
 * on purpose, so the two share tools grant the same thing for the same input.
 * It is not imported from there: that tree is vendored verbatim and does not
 * export it, and a deep import into a verbatim copy breaks on the next
 * re-vendor without anyone noticing.
 */
import { throwForGoogleApiError } from '../../google-sheets-client/lib/api-errors.js';
import { DRIVE_BASE_URL } from './files.js';

export interface CreatePermissionOptions {
  type: 'user' | 'group' | 'domain' | 'anyone';
  role: 'reader' | 'commenter' | 'writer';
  emailAddress?: string;
  domain?: string;
  sendNotificationEmail?: boolean;
}

export interface DrivePermission {
  id?: string;
  type?: string;
  role?: string;
  emailAddress?: string;
  domain?: string;
  [k: string]: unknown;
}

export async function createPermission(
  headers: Record<string, string>,
  fileId: string,
  options: CreatePermissionOptions
): Promise<DrivePermission> {
  const body: Record<string, unknown> = { type: options.type, role: options.role };
  if (options.emailAddress) body.emailAddress = options.emailAddress;
  if (options.domain) body.domain = options.domain;

  const params = new URLSearchParams({
    supportsAllDrives: 'true',
    // Without `fields`, Drive answers id/type/kind only, and the tool could not
    // confirm what it granted.
    fields: 'id,type,role,emailAddress,domain',
  });
  if (options.sendNotificationEmail !== undefined) {
    params.set('sendNotificationEmail', String(options.sendNotificationEmail));
  }

  const response = await fetch(
    `${DRIVE_BASE_URL}/${encodeURIComponent(fileId)}/permissions?${params.toString()}`,
    { method: 'POST', headers, body: JSON.stringify(body) }
  );
  if (!response.ok) {
    await throwForGoogleApiError(response, `Share Drive file ${fileId}`);
  }
  return (await response.json()) as DrivePermission;
}
