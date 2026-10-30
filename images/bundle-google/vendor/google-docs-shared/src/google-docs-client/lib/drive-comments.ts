import { throwForGoogleApiError } from './api-errors.js';
import { logWarning } from '../../logging.js';
import type { DriveComment, DriveCommentList, DriveCommentReply } from '../../types.js';

const DRIVE_BASE_URL = 'https://www.googleapis.com/drive/v3/files';

/**
 * Drive's `comments.list` requires an explicit `fields` mask — it returns a 400
 * if one is not supplied. We request the full comment + nested reply shape this
 * server surfaces (author, body, timestamps, resolved state, anchored quote,
 * and replies including their resolve/reopen `action`).
 */
const COMMENT_FIELDS =
  'nextPageToken,comments(' +
  'id,author(displayName,emailAddress,me),content,htmlContent,' +
  'createdTime,modifiedTime,resolved,deleted,anchor,' +
  'quotedFileContent(mimeType,value),' +
  'replies(id,author(displayName,emailAddress,me),content,htmlContent,' +
  'createdTime,modifiedTime,action,deleted)' +
  ')';

/**
 * The fields `comments.create` and `replies.create` are asked to echo back.
 * Both return 400 without a `fields` mask, like `comments.list`.
 */
const CREATED_COMMENT_FIELDS =
  'id,author(displayName,emailAddress,me),content,createdTime,resolved,' +
  'quotedFileContent(mimeType,value)';
const CREATED_REPLY_FIELDS = 'id,author(displayName,emailAddress,me),content,createdTime,action';

/** Drive caps `pageSize` at 100 for comments.list. */
const PAGE_SIZE = 100;

/**
 * Safety cap on total pages fetched, so a doc with a pathological number of
 * comments can't cause an unbounded fetch loop. 50 pages × 100 = 5000 comments.
 */
const MAX_PAGES = 50;

export interface ListCommentsOptions {
  /**
   * When true, include deleted comments (Drive omits them by default).
   */
  includeDeleted?: boolean;
}

/**
 * List all comments on a Drive file (e.g. a Google Doc), following pagination.
 *
 * Requires a read scope broad enough to see the file's comments. `drive.file`
 * only covers files this app created/opened; reading comments on an arbitrary
 * existing doc requires the broader `drive` scope.
 */
export async function listComments(
  headers: Record<string, string>,
  fileId: string,
  options?: ListCommentsOptions
): Promise<DriveCommentList> {
  const comments: DriveComment[] = [];
  let pageToken: string | undefined;
  let pages = 0;

  do {
    const params = new URLSearchParams({
      fields: COMMENT_FIELDS,
      pageSize: String(PAGE_SIZE),
      includeDeleted: String(options?.includeDeleted ?? false),
    });
    if (pageToken) {
      params.set('pageToken', pageToken);
    }

    const response = await fetch(
      `${DRIVE_BASE_URL}/${encodeURIComponent(fileId)}/comments?${params.toString()}`,
      { method: 'GET', headers }
    );

    if (!response.ok) {
      await throwForGoogleApiError(response, `List comments for ${fileId}`);
    }

    const body = (await response.json()) as {
      comments?: DriveComment[];
      nextPageToken?: string;
    };
    if (body.comments) {
      comments.push(...body.comments);
    }
    pageToken = body.nextPageToken;
    pages += 1;
  } while (pageToken && pages < MAX_PAGES);

  // A still-set pageToken after the loop means the safety cap was hit with more
  // comments remaining. Warn and signal the partial result so the caller doesn't
  // present a truncated list as complete.
  const truncated = Boolean(pageToken);
  if (truncated) {
    logWarning(
      'drive-comments',
      `Comment list for ${fileId} truncated at the ${MAX_PAGES * PAGE_SIZE}-comment cap; more comments exist but were not fetched.`
    );
  }

  return { comments, truncated };
}

export interface CreateCommentOptions {
  /** The comment's text. */
  content: string;
  /**
   * Document text the comment is about. Drive stores it as `quotedFileContent`
   * and Docs shows it as the comment's quote, but the comment is NOT attached
   * to that text: Docs does not honour an API-supplied anchor, so an API
   * comment is unanchored whatever is sent.
   */
  quotedText?: string;
}

/**
 * Create a comment on a Drive file (`comments.create`).
 *
 * The `drive` scope covers it; `drive.file` would only for files this app
 * created or opened.
 */
export async function createComment(
  headers: Record<string, string>,
  fileId: string,
  options: CreateCommentOptions
): Promise<DriveComment> {
  const body: Record<string, unknown> = { content: options.content };
  if (options.quotedText) {
    body.quotedFileContent = { mimeType: 'text/plain', value: options.quotedText };
  }
  const params = new URLSearchParams({ fields: CREATED_COMMENT_FIELDS });

  const response = await fetch(
    `${DRIVE_BASE_URL}/${encodeURIComponent(fileId)}/comments?${params.toString()}`,
    { method: 'POST', headers, body: JSON.stringify(body) }
  );

  if (!response.ok) {
    await throwForGoogleApiError(response, `Create comment on ${fileId}`);
  }

  return (await response.json()) as DriveComment;
}

export interface CreateReplyOptions {
  /** The reply's text. Drive requires it unless `action` is set. */
  content?: string;
  /** `resolve` closes the thread, `reopen` opens a resolved one. */
  action?: 'resolve' | 'reopen';
}

/**
 * Reply to a comment thread (`replies.create`). A reply carrying an `action`
 * is how Drive resolves or reopens a thread; there is no other way.
 */
export async function createReply(
  headers: Record<string, string>,
  fileId: string,
  commentId: string,
  options: CreateReplyOptions
): Promise<DriveCommentReply> {
  const body: Record<string, unknown> = {};
  if (options.content) body.content = options.content;
  if (options.action) body.action = options.action;
  const params = new URLSearchParams({ fields: CREATED_REPLY_FIELDS });

  const response = await fetch(
    `${DRIVE_BASE_URL}/${encodeURIComponent(fileId)}/comments/` +
      `${encodeURIComponent(commentId)}/replies?${params.toString()}`,
    { method: 'POST', headers, body: JSON.stringify(body) }
  );

  if (!response.ok) {
    await throwForGoogleApiError(response, `Reply to comment ${commentId} on ${fileId}`);
  }

  return (await response.json()) as DriveCommentReply;
}
