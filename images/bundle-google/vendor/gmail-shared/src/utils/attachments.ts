import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { z } from 'zod';
import type { MimeAttachment } from '../gmail-client/lib/mime-utils.js';

/**
 * Limits for outgoing attachments. Gmail rejects messages over 25 MB, and
 * base64 transfer encoding with a CRLF every 76 characters inflates content
 * by ~1.37, so the decoded total is capped at 17 MB: ~23.4 MB encoded, which
 * leaves room for the body and headers.
 */
export const MAX_ATTACHMENTS = 10;
export const MAX_TOTAL_ATTACHMENT_BYTES = 17 * 1024 * 1024;
/** One budget for every download in a call, redirects included. */
export const ATTACHMENT_FETCH_TIMEOUT_MS = 60_000;
const MAX_REDIRECTS = 5;
const MAX_FILENAME_LENGTH = 255;

const MIME_TYPE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]*\/[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]*$/;
const GENERIC_MIME_TYPES = new Set(['application/octet-stream', 'binary/octet-stream']);
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

export const ATTACHMENTS_DESCRIPTION =
  'Files to attach (optional, max ' +
  `${MAX_ATTACHMENTS}, ${MAX_TOTAL_ATTACHMENT_BYTES / (1024 * 1024)} MB total decoded). ` +
  'Each item provides exactly one of: `url` — an HTTPS URL the server downloads ' +
  '(e.g. a signed artifact-store link; must be publicly fetchable without extra auth; ' +
  `all downloads share one ${ATTACHMENT_FETCH_TIMEOUT_MS / 1000} s budget), or ` +
  '`content_base64` — the file bytes as standard base64. ' +
  '`filename` is required with content_base64 and defaults to the last URL path segment with url. ' +
  '`mime_type` defaults to the URL response Content-Type, then a guess from the filename extension, ' +
  'then application/octet-stream.';

export const AttachmentInputSchema = z
  .object({
    filename: z
      .string()
      .min(1)
      .max(255)
      .optional()
      .describe('File name shown to the recipient, e.g. "statement-2026-09.pdf".'),
    mime_type: z
      .string()
      .regex(MIME_TYPE_PATTERN, 'mime_type must look like "type/subtype"')
      .optional()
      .describe('MIME type, e.g. "application/pdf".'),
    content_base64: z.string().min(1).optional().describe('File content as standard base64.'),
    url: z.string().url().optional().describe('HTTPS URL to download the file from.'),
  })
  .superRefine((data, ctx) => {
    if (Boolean(data.content_base64) === Boolean(data.url)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Each attachment must provide exactly one of content_base64 or url.',
      });
    }
    if (data.content_base64 && !data.filename) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'filename is required when an attachment is given as content_base64.',
      });
    }
    if (data.url && !data.url.toLowerCase().startsWith('https://')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Attachment url must use https://.',
      });
    }
  });

export const AttachmentsSchema = z
  .array(AttachmentInputSchema)
  .max(MAX_ATTACHMENTS, `At most ${MAX_ATTACHMENTS} attachments are allowed.`)
  .optional()
  .describe(ATTACHMENTS_DESCRIPTION);

export type AttachmentInput = z.infer<typeof AttachmentInputSchema>;

/**
 * JSON Schema for the `attachments` tool parameter (mirrors AttachmentsSchema).
 */
export const ATTACHMENTS_JSON_SCHEMA = {
  type: 'array',
  description: ATTACHMENTS_DESCRIPTION,
  maxItems: MAX_ATTACHMENTS,
  items: {
    type: 'object',
    properties: {
      filename: {
        type: 'string',
        maxLength: 255,
        description: 'File name shown to the recipient, e.g. "statement-2026-09.pdf".',
      },
      mime_type: {
        type: 'string',
        pattern: MIME_TYPE_PATTERN.source,
        description: 'MIME type, e.g. "application/pdf".',
      },
      content_base64: { type: 'string', description: 'File content as standard base64.' },
      url: { type: 'string', description: 'HTTPS URL to download the file from.' },
    },
    additionalProperties: false,
  },
} as const;

const EXTENSION_MIME_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  csv: 'text/csv',
  txt: 'text/plain',
  html: 'text/html',
  htm: 'text/html',
  json: 'application/json',
  xml: 'application/xml',
  zip: 'application/zip',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  ics: 'text/calendar',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

export function guessMimeType(filename: string): string {
  const ext = filename.includes('.') ? filename.split('.').pop()!.toLowerCase() : '';
  return EXTENSION_MIME_TYPES[ext] ?? 'application/octet-stream';
}

function filenameFromUrl(url: URL): string {
  const lastSegment = url.pathname.split('/').filter(Boolean).pop();
  if (!lastSegment) {
    return 'attachment';
  }
  try {
    return decodeURIComponent(lastSegment);
  } catch {
    return lastSegment;
  }
}

/**
 * Addresses a download may never reach: this machine, and every non-public
 * network. One list per family, because a BlockList also matches an IPv4
 * address against its IPv6 rules, and `::/96` would then refuse every one.
 */
const PRIVATE_IPV4 = new BlockList();
const PRIVATE_IPV6 = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  PRIVATE_IPV4.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 96], // unspecified, loopback, and IPv4-compatible
  ['::ffff:0:0', 96], // IPv4-mapped
  ['64:ff9b::', 96], // NAT64
  ['64:ff9b:1::', 48], // local-use NAT64
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local
  ['ff00::', 8], // multicast
] as const) {
  PRIVATE_IPV6.addSubnet(net, prefix, 'ipv6');
}

/** True for an IP address (v4 or v6) on this machine or a non-public network. */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  return family === 4
    ? PRIVATE_IPV4.check(address, 'ipv4')
    : PRIVATE_IPV6.check(address, 'ipv6');
}

/**
 * Rejects hosts that point at the server's own machine or private networks,
 * as written in the URL. {@link assertPublicResolution} checks what a name
 * resolves to.
 */
export function isDisallowedHost(hostname: string): boolean {
  const host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.+$/, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) {
    return true;
  }
  return isPrivateAddress(host);
}

/**
 * Resolves a DNS name and refuses it if ANY address it resolves to is
 * private, so a public name pointing at an internal service is not fetched.
 * The fetch resolves again, so a name whose answer changes between the two
 * lookups (DNS rebinding) is not caught.
 */
async function assertPublicResolution(hostname: string): Promise<void> {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) !== 0) return;
  let addresses: { address: string }[];
  try {
    addresses = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new Error(`Attachment url host "${hostname}" could not be resolved.`);
  }
  if (addresses.some((a) => isPrivateAddress(a.address))) {
    throw new Error(`Attachment url host "${hostname}" resolves to a private address.`);
  }
}

/**
 * Makes a filename safe to show and to send: control characters (a newline
 * would forge a line in the confirmation prompt) become `_`, and the name is
 * held to 255 characters, keeping its extension.
 */
export function sanitizeFilename(filename: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = filename.replace(/[\x00-\x1F\x7F]/g, '_');
  const chars = [...clean];
  if (chars.length <= MAX_FILENAME_LENGTH) return clean;
  const dot = clean.lastIndexOf('.');
  const ext = dot > 0 ? [...clean.slice(dot)] : [];
  const keep = ext.length < 16 ? ext : [];
  return chars.slice(0, MAX_FILENAME_LENGTH - keep.length).join('') + keep.join('');
}

function decodeBase64(content: string, filename: string, limit: number): Buffer {
  const normalized = content.replace(/\s+/g, '');
  if (normalized.length % 4 !== 0 || !BASE64_PATTERN.test(normalized)) {
    throw new Error(`Attachment "${filename}": content_base64 is not valid base64.`);
  }
  // Check the decoded size before decoding so oversized input is never materialised.
  const padding = normalized.endsWith('==') ? 2 : normalized.endsWith('=') ? 1 : 0;
  if ((normalized.length / 4) * 3 - padding > limit) {
    throw new Error(`Attachment "${filename}" exceeds the remaining size limit (${limit} bytes).`);
  }
  return Buffer.from(normalized, 'base64');
}

async function readBodyWithLimit(response: Response, limit: number, label: string) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    throw new Error(`Attachment "${label}" exceeds the remaining size limit (${limit} bytes).`);
  }
  if (!response.body) {
    return Buffer.alloc(0);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new Error(`Attachment "${label}" exceeds the remaining size limit (${limit} bytes).`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

async function assertAllowedUrl(url: URL): Promise<void> {
  if (url.protocol !== 'https:') {
    throw new Error(`Attachment url must use https:// (got ${url.protocol}).`);
  }
  if (isDisallowedHost(url.hostname)) {
    throw new Error(`Attachment url host "${url.hostname}" is not allowed.`);
  }
  await assertPublicResolution(url.hostname);
}

async function fetchAttachment(
  rawUrl: string,
  limit: number,
  signal: AbortSignal
): Promise<{ content: Buffer; contentType?: string; url: URL }> {
  let url = new URL(rawUrl);

  // Follow redirects by hand so every hop is checked before it is requested.
  let response: Response;
  for (let hop = 0; ; hop++) {
    await assertAllowedUrl(url);
    response = await fetch(url, { redirect: 'manual', signal });
    const location = response.headers.get('location');
    if (response.status < 300 || response.status >= 400 || !location) {
      break;
    }
    if (hop >= MAX_REDIRECTS) {
      throw new Error(`Attachment url redirected more than ${MAX_REDIRECTS} times.`);
    }
    await response.body?.cancel();
    url = new URL(location, url);
  }

  if (!response.ok) {
    throw new Error(
      `Failed to download attachment from ${url.host}${url.pathname}: HTTP ${response.status}`
    );
  }

  const content = await readBodyWithLimit(response, limit, url.pathname);
  const contentType = response.headers.get('content-type')?.split(';')[0].trim();
  return { content, contentType, url };
}

/**
 * Resolves attachment inputs (base64 content or HTTPS URLs) into decoded
 * attachments, enforcing the total size limit across all of them.
 */
export async function resolveAttachments(
  inputs: AttachmentInput[] | undefined
): Promise<MimeAttachment[]> {
  if (!inputs || inputs.length === 0) {
    return [];
  }
  if (inputs.length > MAX_ATTACHMENTS) {
    throw new Error(`At most ${MAX_ATTACHMENTS} attachments are allowed.`);
  }

  const resolved: MimeAttachment[] = [];
  let totalBytes = 0;
  const signal = AbortSignal.timeout(ATTACHMENT_FETCH_TIMEOUT_MS);

  for (const input of inputs) {
    const remaining = MAX_TOTAL_ATTACHMENT_BYTES - totalBytes;
    let content: Buffer;
    let filename: string;
    let fetchedType: string | undefined;

    if (input.content_base64) {
      filename = sanitizeFilename(input.filename!);
      content = decodeBase64(input.content_base64, filename, remaining);
    } else {
      const fetched = await fetchAttachment(input.url!, remaining, signal);
      content = fetched.content;
      fetchedType = fetched.contentType;
      filename = sanitizeFilename(input.filename ?? filenameFromUrl(fetched.url));
    }

    totalBytes += content.length;
    if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
      throw new Error(
        `Attachments exceed the ${MAX_TOTAL_ATTACHMENT_BYTES / (1024 * 1024)} MB total size limit.`
      );
    }

    // Generic types (common on object stores) fall through to an extension guess.
    const useFetchedType =
      fetchedType &&
      MIME_TYPE_PATTERN.test(fetchedType) &&
      !GENERIC_MIME_TYPES.has(fetchedType.toLowerCase());
    const mimeType = input.mime_type ?? (useFetchedType ? fetchedType! : guessMimeType(filename));

    resolved.push({ filename, mimeType, content });
  }

  return resolved;
}

/**
 * Human-readable summary of resolved attachments, e.g. "a.pdf (application/pdf, 12.3 KB)".
 */
export function formatAttachmentList(attachments: MimeAttachment[]): string {
  return attachments
    .map((a) => `${a.filename} (${a.mimeType}, ${(a.content.length / 1024).toFixed(1)} KB)`)
    .join(', ');
}
