/**
 * Subset of the Google Docs API Document resource that this server inspects directly.
 *
 * The Docs API surface is huge; we deliberately model only the fields we read
 * (text extraction, headings, document metadata) and treat unfamiliar fields
 * as opaque pass-through. Anything else is preserved verbatim under the
 * `[k: string]: unknown` index signature so callers asking for the raw
 * structured response get the full payload.
 */

export interface TextRun {
  content: string;
  textStyle?: Record<string, unknown>;
  /** Non-empty when this text is a pending suggested insertion. */
  suggestedInsertionIds?: string[];
  /** Non-empty when this text is pending deletion by a suggestion. */
  suggestedDeletionIds?: string[];
}

export interface ParagraphElement {
  startIndex?: number;
  endIndex?: number;
  textRun?: TextRun;
  pageBreak?: Record<string, unknown>;
  horizontalRule?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface ParagraphStyle {
  namedStyleType?: string;
  [k: string]: unknown;
}

export interface Paragraph {
  elements?: ParagraphElement[];
  paragraphStyle?: ParagraphStyle;
  [k: string]: unknown;
}

export interface StructuralElement {
  startIndex?: number;
  endIndex?: number;
  paragraph?: Paragraph;
  sectionBreak?: Record<string, unknown>;
  table?: Record<string, unknown>;
  tableOfContents?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface DocumentBody {
  content?: StructuralElement[];
  [k: string]: unknown;
}

/**
 * A tab's identity and place in the tab tree (`Tab.tabProperties`). `index` is
 * the position among its siblings; `nestingLevel` is 0 for a top-level tab.
 */
export interface TabProperties {
  tabId?: string;
  title?: string;
  parentTabId?: string;
  index?: number;
  nestingLevel?: number;
  [k: string]: unknown;
}

/**
 * A tab's content (`Tab.documentTab`). It carries the same fields the legacy
 * single-tab `Document` carries at its top level — `body`, `lists`,
 * `inlineObjects`, `namedStyles`, … — scoped to this tab.
 */
export interface DocumentTab {
  body?: DocumentBody;
  [k: string]: unknown;
}

/**
 * One tab of a document. Only populated when `documents.get` is called with
 * `includeTabsContent=true`; tabs nest through `childTabs`.
 */
export interface Tab {
  tabProperties?: TabProperties;
  childTabs?: Tab[];
  documentTab?: DocumentTab;
  [k: string]: unknown;
}

export interface GoogleDoc {
  documentId: string;
  title?: string;
  /**
   * Every tab, top-level ones here and nested ones under `childTabs`. Present
   * only when fetched with `includeTabsContent=true`, in which case the
   * top-level content fields (`body`, `lists`, …) are empty.
   */
  tabs?: Tab[];
  body?: DocumentBody;
  revisionId?: string;
  documentStyle?: Record<string, unknown>;
  namedStyles?: Record<string, unknown>;
  inlineObjects?: Record<string, unknown>;
  positionedObjects?: Record<string, unknown>;
  lists?: Record<string, unknown>;
  [k: string]: unknown;
}

/**
 * Generic Docs batchUpdate request - the union type is enormous in the real API.
 * We leave it as a permissive object so callers can pass whatever the Docs API accepts.
 * See: https://developers.google.com/docs/api/reference/rest/v1/documents/request
 */
export type DocsBatchUpdateRequest = Record<string, unknown>;

/**
 * How a `batchUpdate` is applied. `SUGGEST` turns every request in the batch
 * into a suggestion; `targetRevisionId` applies it to that revision, with
 * collaborators' later changes merged in by the server.
 */
export interface DocsWriteControl {
  writeMode?: 'EDIT' | 'SUGGEST';
  targetRevisionId?: string;
}

/** The suggestions one request in a batch touched. Maps 1:1 with the requests. */
export interface DocsSuggestionResponse {
  createdSuggestionIds?: string[];
  updatedSummarySuggestionIds?: string[];
  [k: string]: unknown;
}

export interface DocsBatchUpdateResponse {
  documentId: string;
  replies?: Array<Record<string, unknown>>;
  writeControl?: Record<string, unknown>;
  suggestionResponses?: DocsSuggestionResponse[];
  /**
   * Whether the batch's comment and suggestion updates saved. This is a 200
   * either way: `ALL_FAILED_UNKNOWN_REASON` can arrive with the document's
   * text changes already committed.
   */
  commentUpdateState?: string;
  [k: string]: unknown;
}

/** A comment thread as `insertComment` returns it (`replies[].insertComment.commentThread`). */
export interface DocsCommentThread {
  commentId?: string;
  anchorId?: string;
  plainTextQuote?: string;
  headPost?: {
    postId?: string;
    author?: { displayName?: string; [k: string]: unknown };
    createTime?: string;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

/**
 * Drive `files.get` minimal projection used by this server.
 */
export interface DriveFile {
  id: string;
  name?: string;
  mimeType?: string;
  trashed?: boolean;
  webViewLink?: string;
  [k: string]: unknown;
}

export interface DrivePermission {
  id?: string;
  type?: string;
  role?: string;
  emailAddress?: string;
  domain?: string;
  displayName?: string;
  [k: string]: unknown;
}

/**
 * Drive `comments` resource author (a `User`).
 */
export interface DriveCommentAuthor {
  displayName?: string;
  emailAddress?: string;
  me?: boolean;
  [k: string]: unknown;
}

/**
 * A reply to a Drive comment. The `action` field, when present, is either
 * `resolve` or `reopen` — replies that toggle the parent comment's resolved state.
 */
export interface DriveCommentReply {
  id?: string;
  author?: DriveCommentAuthor;
  content?: string;
  htmlContent?: string;
  createdTime?: string;
  modifiedTime?: string;
  action?: string;
  deleted?: boolean;
  [k: string]: unknown;
}

/**
 * A Drive `comments` resource. `quotedFileContent` is the document text the
 * comment is anchored to; `resolved` indicates a resolved (closed) thread.
 */
export interface DriveComment {
  id?: string;
  author?: DriveCommentAuthor;
  content?: string;
  htmlContent?: string;
  createdTime?: string;
  modifiedTime?: string;
  resolved?: boolean;
  deleted?: boolean;
  anchor?: string;
  quotedFileContent?: {
    mimeType?: string;
    value?: string;
  };
  replies?: DriveCommentReply[];
  [k: string]: unknown;
}

export interface DriveCommentList {
  comments: DriveComment[];
  /**
   * True when the document has more comments than were fetched (the pagination
   * safety cap was hit). Callers should signal that the list is partial.
   */
  truncated?: boolean;
}
