import type { DocsBatchUpdateRequest, DocsBatchUpdateResponse } from '../types.js';

/** The `suggest` parameter, worded once for the four tools that take it. */
export const SUGGEST_PARAM_DESCRIPTION =
  'When true, the edit is made as a suggestion for a human to accept or reject in the Docs ' +
  'editor, not as a direct change. Defaults to false (a direct edit). A pending suggestion ' +
  'still occupies document indexes, so re-read with get_document before computing new ones.';

/**
 * The requests the Docs API refuses under `writeMode: SUGGEST`, keyed by their
 * name in the `Request` union (https://developers.google.com/workspace/docs/api/how-tos/suggestions).
 */
const UNSUPPORTED_IN_SUGGEST_MODE = [
  'addDocumentTab',
  'createNamedRange',
  'deleteFooter',
  'deleteHeader',
  'deleteNamedRange',
  'deleteTab',
  'updateDocumentTabProperties',
  'updateTableColumnProperties',
] as const;

/**
 * Requests that act on comment and suggestion threads, not on the document's
 * text. There is nothing in them to propose, and Google does not say what
 * `SUGGEST` does to one; an `acceptSuggestion` reported as "pending review"
 * would be a direct change described as the opposite. strad's rule, not Docs'.
 */
const THREAD_REQUESTS = [
  'insertComment',
  'addCommentReply',
  'updateCommentPost',
  'deleteComment',
  'deleteCommentReply',
  'acceptSuggestion',
  'rejectSuggestion',
  'deleteSuggestion',
] as const;

/** The `updateDocumentStyle` fields Docs will not take as a suggestion. */
const UNSUPPORTED_DOCUMENT_STYLE_FIELDS = [
  'documentFormat',
  'useEvenPageHeaderFooter',
  'useFirstPageHeaderFooter',
] as const;

function unsupportedStyleFields(request: DocsBatchUpdateRequest): string[] {
  const update = request.updateDocumentStyle as
    | { fields?: unknown; documentStyle?: Record<string, unknown> }
    | undefined;
  if (!update) return [];
  const fields =
    typeof update.fields === 'string' ? update.fields.split(',').map((f) => f.trim()) : [];
  return UNSUPPORTED_DOCUMENT_STYLE_FIELDS.filter(
    (name) =>
      fields.some((f) => f === name || f.startsWith(`${name}.`)) ||
      (fields.includes('*') && update.documentStyle?.[name] !== undefined)
  );
}

/**
 * Refuses, before anything reaches Google, a batch that cannot be a suggestion.
 * The batch is atomic, so one such request would fail all of it; naming the
 * request here is what lets the caller split it rather than decode a 400.
 */
export function assertSuggestable(requests: DocsBatchUpdateRequest[]): void {
  const refused: string[] = [];
  requests.forEach((request, i) => {
    for (const name of [...UNSUPPORTED_IN_SUGGEST_MODE, ...THREAD_REQUESTS]) {
      if (name in request) refused.push(`requests[${i}].${name}`);
    }
    for (const field of unsupportedStyleFields(request)) {
      refused.push(`requests[${i}].updateDocumentStyle (${field})`);
    }
  });
  if (refused.length === 0) return;
  throw new Error(
    `Google Docs cannot make these a suggestion: ${refused.join(', ')}. Nothing was changed. ` +
      'Remove them from this request, or send them separately without suggest as direct edits.'
  );
}

/** The suggestions Google says a batch created or folded into an existing one. */
export function suggestionIds(response: DocsBatchUpdateResponse): string[] {
  const ids = (response.suggestionResponses ?? []).flatMap((r) => [
    ...(r.createdSuggestionIds ?? []),
    ...(r.updatedSummarySuggestionIds ?? []),
  ]);
  return [...new Set(ids)];
}

/**
 * The lines a suggest-mode result carries. A response that names no suggestion
 * and does not say `ALL_SAVED` is not a success to report: the caller asked
 * that nothing change directly, and this answer cannot say that nothing did.
 * `suggestionResponses` maps 1:1 with the requests, so a request whose entry
 * names none is called out rather than covered by a sibling's id.
 */
export function renderSuggestionResult(
  response: DocsBatchUpdateResponse,
  requestCount = 1
): string {
  const ids = suggestionIds(response);
  if (ids.length === 0 && response.commentUpdateState !== 'ALL_SAVED') {
    return (
      '**Applied as:** UNCONFIRMED. A suggestion was requested and Google\'s answer names none ' +
      `(commentUpdateState: ${response.commentUpdateState ?? 'absent'}). Read the document ` +
      'before retrying: the edit may be pending, direct, or missing.\n'
    );
  }
  let output = "**Applied as:** suggestion, pending review. It takes effect once accepted.\n";
  if (ids.length > 0) output += `**Suggestion IDs:** ${ids.join(', ')}\n`;
  const named = (response.suggestionResponses ?? []).filter(
    (r) => suggestionIds({ documentId: '', suggestionResponses: [r] }).length > 0
  ).length;
  if (ids.length > 0 && named < requestCount) {
    output += `**Check:** only ${named} of ${requestCount} requests name a suggestion. Read the document to see what the others did.\n`;
  }
  return output;
}
