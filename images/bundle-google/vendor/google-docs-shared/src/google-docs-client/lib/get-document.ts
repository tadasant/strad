import { throwForGoogleApiError } from './api-errors.js';
import type { GoogleDoc } from '../../types.js';

const DOCS_BASE_URL = 'https://docs.googleapis.com/v1/documents';

export interface GetDocumentOptions {
  /**
   * Ask for every tab (`document.tabs[]`, nested through `childTabs`). Without
   * it the Docs API returns only the FIRST tab's content, in the legacy
   * top-level `body`, and every other tab is invisible.
   */
  includeTabsContent?: boolean;
  /**
   * How pending suggestions are represented. `SUGGESTIONS_INLINE` is the only
   * mode whose indexes a later `batchUpdate` can use. Omitted, Docs applies it
   * to anyone with more than view access.
   */
  suggestionsViewMode?: 'SUGGESTIONS_INLINE';
}

export async function getDocument(
  headers: Record<string, string>,
  documentId: string,
  options: GetDocumentOptions = {}
): Promise<GoogleDoc> {
  const params = new URLSearchParams();
  if (options.includeTabsContent) params.set('includeTabsContent', 'true');
  if (options.suggestionsViewMode) params.set('suggestionsViewMode', options.suggestionsViewMode);
  const query = params.size > 0 ? `?${params}` : '';
  const response = await fetch(`${DOCS_BASE_URL}/${encodeURIComponent(documentId)}${query}`, {
    method: 'GET',
    headers,
  });

  if (!response.ok) {
    await throwForGoogleApiError(response, `Get document ${documentId}`);
  }

  return (await response.json()) as GoogleDoc;
}
