import type { Email, EmailListItem } from '../../types.js';
import { handleApiError } from './api-errors.js';
import { buildMimeMessage, type MimeAttachment } from './mime-utils.js';
import { requestWithRawMessage } from './raw-message-request.js';

/**
 * What a Gmail draft ID looks like (`r-1234567890123456789`, `r123…`).
 *
 * The ID is spliced into a request path, and `fetch` resolves `..` in a path:
 * `drafts/../messages/<id>` would be a request against a MESSAGE. So every
 * draft call refuses an ID outside this set before it builds a URL.
 */
export const DRAFT_ID_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;

function draftPath(draftId: string): string {
  if (!DRAFT_ID_PATTERN.test(draftId)) {
    throw new Error(`Not a Gmail draft ID: ${JSON.stringify(draftId.slice(0, 64))}`);
  }
  return `/drafts/${draftId}`;
}

interface Draft {
  id: string;
  message: Email;
}

interface DraftListItem {
  id: string;
  message: EmailListItem;
}

interface DraftsListResponse {
  drafts?: DraftListItem[];
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

/**
 * Creates a new draft email
 */
export async function createDraft(
  baseUrl: string,
  headers: Record<string, string>,
  from: string,
  options: {
    to: string;
    subject: string;
    plaintextBody?: string;
    htmlBody?: string;
    cc?: string;
    bcc?: string;
    threadId?: string;
    inReplyTo?: string;
    references?: string;
    attachments?: MimeAttachment[];
  }
): Promise<Draft> {
  const rawMessage = buildMimeMessage(from, options);

  const response = await requestWithRawMessage(
    baseUrl,
    '/drafts',
    'POST',
    headers,
    rawMessage,
    (raw) => ({
      message: {
        ...(raw !== undefined && { raw }),
        ...(options.threadId && { threadId: options.threadId }),
      },
    })
  );

  if (!response.ok) {
    handleApiError(response.status, 'creating draft');
  }

  return (await response.json()) as Draft;
}

/**
 * Gets a draft by ID
 */
export async function getDraft(
  baseUrl: string,
  headers: Record<string, string>,
  draftId: string
): Promise<Draft> {
  const url = `${baseUrl}${draftPath(draftId)}`;

  const response = await fetch(url, {
    method: 'GET',
    headers,
  });

  if (!response.ok) {
    handleApiError(response.status, 'getting draft', draftId);
  }

  return (await response.json()) as Draft;
}

/**
 * Lists drafts
 */
export async function listDrafts(
  baseUrl: string,
  headers: Record<string, string>,
  options?: {
    maxResults?: number;
    pageToken?: string;
  }
): Promise<{
  drafts: DraftListItem[];
  nextPageToken?: string;
  resultSizeEstimate?: number;
}> {
  const params = new URLSearchParams();

  if (options?.maxResults) {
    params.set('maxResults', options.maxResults.toString());
  }

  if (options?.pageToken) {
    params.set('pageToken', options.pageToken);
  }

  const queryString = params.toString();
  const url = `${baseUrl}/drafts${queryString ? `?${queryString}` : ''}`;

  const response = await fetch(url, {
    method: 'GET',
    headers,
  });

  if (!response.ok) {
    handleApiError(response.status, 'listing drafts');
  }

  const data = (await response.json()) as DraftsListResponse;

  return {
    drafts: data.drafts ?? [],
    nextPageToken: data.nextPageToken,
    resultSizeEstimate: data.resultSizeEstimate,
  };
}

/**
 * Updates an existing draft email
 */
export async function updateDraft(
  baseUrl: string,
  headers: Record<string, string>,
  from: string,
  draftId: string,
  options: {
    to: string;
    subject: string;
    plaintextBody?: string;
    htmlBody?: string;
    cc?: string;
    bcc?: string;
    threadId?: string;
    inReplyTo?: string;
    references?: string;
    attachments?: MimeAttachment[];
  }
): Promise<Draft> {
  const rawMessage = buildMimeMessage(from, options);

  const response = await requestWithRawMessage(
    baseUrl,
    draftPath(draftId),
    'PUT',
    headers,
    rawMessage,
    (raw) => ({
      message: {
        ...(raw !== undefined && { raw }),
        ...(options.threadId && { threadId: options.threadId }),
      },
    })
  );

  if (!response.ok) {
    handleApiError(response.status, 'updating draft', draftId);
  }

  return (await response.json()) as Draft;
}

/**
 * Deletes a draft
 */
export async function deleteDraft(
  baseUrl: string,
  headers: Record<string, string>,
  draftId: string
): Promise<void> {
  const url = `${baseUrl}${draftPath(draftId)}`;

  const response = await fetch(url, {
    method: 'DELETE',
    headers,
  });

  if (!response.ok) {
    handleApiError(response.status, 'deleting draft', draftId);
  }
}
