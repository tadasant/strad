/** Compact, model-facing renderings of Drive files. */
import type { DriveFile, DriveUser } from '../types.js';
import { describeMimeType } from './mime.js';

export function formatBytes(size: string | undefined): string | undefined {
  if (size === undefined) return undefined;
  const n = Number(size);
  if (!Number.isFinite(n)) return undefined;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatUser(user: DriveUser | undefined): string | undefined {
  if (!user) return undefined;
  if (user.displayName && user.emailAddress) return `${user.displayName} <${user.emailAddress}>`;
  return user.displayName ?? user.emailAddress;
}

/** One line per file, for a list. */
export function fileLine(file: DriveFile): string {
  const parts = [`id \`${file.id}\``, describeMimeType(file.mimeType)];
  const size = formatBytes(file.size);
  if (size) parts.push(size);
  if (file.modifiedTime) parts.push(`modified ${file.modifiedTime}`);
  const owner = formatUser(file.owners?.[0]);
  if (owner) parts.push(`owner ${owner}`);
  if (file.driveId) parts.push('in a shared drive');
  if (file.shortcutDetails?.targetId) {
    parts.push(`shortcut to \`${file.shortcutDetails.targetId}\` (${describeMimeType(file.shortcutDetails.targetMimeType)})`);
  }
  let line = `- **${file.name ?? '(untitled)'}** — ${parts.join(', ')}`;
  if (file.webViewLink) line += `\n  ${file.webViewLink}`;
  return line;
}
