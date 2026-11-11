import { throwForGoogleApiError } from './api-errors.js';
import type {
  DocsBatchUpdateRequest,
  DocsBatchUpdateResponse,
  DocsWriteControl,
} from '../../types.js';

const DOCS_BASE_URL = 'https://docs.googleapis.com/v1/documents';

export async function batchUpdate(
  headers: Record<string, string>,
  documentId: string,
  requests: DocsBatchUpdateRequest[],
  writeControl?: DocsWriteControl
): Promise<DocsBatchUpdateResponse> {
  const response = await fetch(`${DOCS_BASE_URL}/${encodeURIComponent(documentId)}:batchUpdate`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ requests, ...(writeControl ? { writeControl } : {}) }),
  });

  if (!response.ok) {
    await throwForGoogleApiError(response, `Batch update document ${documentId}`);
  }

  const result = (await response.json()) as DocsBatchUpdateResponse;

  // A 200 that lost the comments or suggestions it was sent. Every caller gets
  // this as a failure, because the document may have changed underneath it.
  if (result.commentUpdateState === 'ALL_FAILED_UNKNOWN_REASON') {
    throw new Error(
      `Batch update document ${documentId}: Google could not save the comment or suggestion ` +
        '(commentUpdateState: ALL_FAILED_UNKNOWN_REASON), and its text changes may still have ' +
        'been committed. Read the document (get_document, list_comments) before retrying.'
    );
  }

  return result;
}
