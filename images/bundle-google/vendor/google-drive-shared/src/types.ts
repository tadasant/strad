/**
 * The slice of the Drive API v3 `File` resource this server asks for.
 *
 * Every request names its `fields`, because Drive's default answer for a file is
 * four fields and its answer for `*` is several kilobytes. The interfaces keep an
 * index signature so a field the renderers do not model still survives.
 */

export interface DriveUser {
  displayName?: string;
  emailAddress?: string;
  [k: string]: unknown;
}

export interface DrivePermission {
  /** user | group | domain | anyone */
  type?: string;
  /** owner | organizer | fileOrganizer | writer | commenter | reader */
  role?: string;
  emailAddress?: string;
  domain?: string;
  displayName?: string;
  [k: string]: unknown;
}

export interface DriveFile {
  id: string;
  name?: string;
  mimeType?: string;
  description?: string;
  /** Bytes, as a STRING: Drive reports int64 fields as strings in JSON. Absent on Google-native files. */
  size?: string;
  createdTime?: string;
  modifiedTime?: string;
  owners?: DriveUser[];
  lastModifyingUser?: DriveUser;
  parents?: string[];
  webViewLink?: string;
  shared?: boolean;
  starred?: boolean;
  trashed?: boolean;
  /** Set when the file lives in a shared drive. */
  driveId?: string;
  shortcutDetails?: { targetId?: string; targetMimeType?: string };
  /** Only returned to an account that may see the sharing list; absent in many shared drives. */
  permissions?: DrivePermission[];
  capabilities?: { canEdit?: boolean; canComment?: boolean; canDownload?: boolean; [k: string]: unknown };
  [k: string]: unknown;
}

export interface DriveFileList {
  files?: DriveFile[];
  nextPageToken?: string;
  /**
   * True when Drive searched only part of the corpus — it happens on an
   * all-drives search across many shared drives. The results are then a subset,
   * and a caller has to be told so rather than read "not found" as an answer.
   */
  incompleteSearch?: boolean;
  [k: string]: unknown;
}
