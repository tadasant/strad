/**
 * The Drive `q` expression `search_files` sends, built from structured filters.
 *
 * The tool takes no raw `q`. A raw query is a string the model has to escape by
 * Drive's rules, and an unescaped `'` in a file name is a 400 that reads like a
 * broken server. Every value here goes through {@link quote}.
 */
import { FILE_TYPES, type FileType } from './mime.js';

/** A Drive query string literal: backslash and single quote escaped, then quoted. */
export function quote(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

export interface SearchFilters {
  query?: string;
  nameContains?: string;
  type?: FileType;
  mimeType?: string;
  folderId?: string;
  modifiedAfter?: string;
  sharedWithMe?: boolean;
  includeTrashed?: boolean;
}

export function buildQuery(filters: SearchFilters): string {
  if (filters.type && filters.mimeType) {
    throw new Error('Pass type or mime_type, not both.');
  }
  const terms: string[] = [];
  if (filters.query) terms.push(`fullText contains ${quote(filters.query)}`);
  if (filters.nameContains) terms.push(`name contains ${quote(filters.nameContains)}`);
  if (filters.type) terms.push(FILE_TYPES[filters.type]);
  if (filters.mimeType) terms.push(`mimeType = ${quote(filters.mimeType)}`);
  if (filters.folderId) terms.push(`${quote(filters.folderId)} in parents`);
  if (filters.modifiedAfter) {
    const time = Date.parse(filters.modifiedAfter);
    if (Number.isNaN(time)) {
      throw new Error(
        `modified_after "${filters.modifiedAfter}" is not a date. Use ISO 8601, e.g. 2026-10-01 or 2026-10-01T09:00:00Z.`
      );
    }
    terms.push(`modifiedTime > ${quote(new Date(time).toISOString())}`);
  }
  if (filters.sharedWithMe) terms.push('sharedWithMe = true');
  if (!filters.includeTrashed) terms.push('trashed = false');
  return terms.join(' and ');
}

export const ORDER_BY = {
  modified: 'modifiedTime desc',
  created: 'createdTime desc',
  name: 'name_natural',
} as const;

export type OrderBy = keyof typeof ORDER_BY;

/**
 * Drive sorts a full-text search by relevance and refuses an explicit sort on
 * one, so a sort is only sent without `query`.
 */
export function resolveOrderBy(hasQuery: boolean, orderBy: OrderBy | undefined): string | undefined {
  if (hasQuery) {
    if (orderBy) {
      throw new Error(
        'Drive does not sort a full-text search; results come back by relevance. ' +
          'Drop order_by, or search by name_contains instead of query.'
      );
    }
    return undefined;
  }
  return ORDER_BY[orderBy ?? 'modified'];
}
