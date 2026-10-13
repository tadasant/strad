/**
 * Drive's mime types, the friendly names a tool takes instead, and what
 * `read_file` can turn each kind of file into.
 */
import { FOLDER_MIME_TYPE } from '../drive-client/files.js';

export const GOOGLE_DOC = 'application/vnd.google-apps.document';
export const GOOGLE_SHEET = 'application/vnd.google-apps.spreadsheet';
export const GOOGLE_SLIDES = 'application/vnd.google-apps.presentation';
export const GOOGLE_SHORTCUT = 'application/vnd.google-apps.shortcut';

/** The `type` filter `search_files` takes, and the Drive `q` term each one becomes. */
export const FILE_TYPES = {
  folder: `mimeType = '${FOLDER_MIME_TYPE}'`,
  document: `mimeType = '${GOOGLE_DOC}'`,
  spreadsheet: `mimeType = '${GOOGLE_SHEET}'`,
  presentation: `mimeType = '${GOOGLE_SLIDES}'`,
  pdf: "mimeType = 'application/pdf'",
  image: "mimeType contains 'image/'",
  video: "mimeType contains 'video/'",
} as const;

export type FileType = keyof typeof FILE_TYPES;

const FRIENDLY: Record<string, string> = {
  [FOLDER_MIME_TYPE]: 'folder',
  [GOOGLE_DOC]: 'Google Doc',
  [GOOGLE_SHEET]: 'Google Sheet',
  [GOOGLE_SLIDES]: 'Google Slides',
  [GOOGLE_SHORTCUT]: 'shortcut',
  'application/vnd.google-apps.form': 'Google Form',
  'application/vnd.google-apps.drawing': 'Google Drawing',
  'application/pdf': 'PDF',
};

/** A short human name for a mime type, falling back to the type itself. */
export function describeMimeType(mimeType: string | undefined): string {
  if (!mimeType) return 'unknown type';
  return FRIENDLY[mimeType] ?? mimeType;
}

/** The text formats `read_file` can export a Google-native file as. */
export type ReadFormat = 'markdown' | 'text' | 'html' | 'csv';

const FORMAT_MIME: Record<ReadFormat, string> = {
  markdown: 'text/markdown',
  text: 'text/plain',
  html: 'text/html',
  csv: 'text/csv',
};

/**
 * Per Google-native type, the formats it exports as, default first. A Sheet's
 * CSV export is its FIRST TAB only; that is Drive's behaviour, and `read_file`
 * says so in its output.
 */
export const EXPORT_FORMATS: Record<string, ReadFormat[]> = {
  [GOOGLE_DOC]: ['markdown', 'text', 'html'],
  [GOOGLE_SHEET]: ['csv'],
  [GOOGLE_SLIDES]: ['text'],
};

export function exportMimeType(format: ReadFormat): string {
  return FORMAT_MIME[format];
}

/** A stored (non-native) file whose bytes can be returned as text. */
export function isTextMimeType(mimeType: string): boolean {
  if (mimeType.startsWith('text/')) return true;
  return (
    /^application\/(json|xml|javascript|x-javascript|ecmascript|x-yaml|yaml|x-sh|sql|csv|x-ndjson|ld\+json|geo\+json)$/.test(
      mimeType
    ) || /\+(json|xml)$/.test(mimeType)
  );
}

/** Images a model can see, returned as MCP image content. */
export const IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** The upload type `create_file` infers from a name's extension when none is given. */
export function inferMimeType(name: string): string {
  const ext = /\.([A-Za-z0-9]+)$/.exec(name)?.[1]?.toLowerCase();
  switch (ext) {
    case 'md':
    case 'markdown':
      return 'text/markdown';
    case 'csv':
      return 'text/csv';
    case 'json':
      return 'application/json';
    case 'html':
    case 'htm':
      return 'text/html';
    case 'pdf':
      return 'application/pdf';
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    default:
      return 'text/plain';
  }
}

/** The Google-native type `create_file` converts an upload into. */
export const CONVERT_TO = {
  document: GOOGLE_DOC,
  spreadsheet: GOOGLE_SHEET,
  presentation: GOOGLE_SLIDES,
} as const;
