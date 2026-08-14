/**
 * Slack API Types
 * Based on Slack Web API responses
 */

export interface Channel {
  id: string;
  name: string;
  is_channel: boolean;
  is_group: boolean;
  is_im: boolean;
  is_mpim: boolean;
  is_private: boolean;
  is_archived: boolean;
  is_general: boolean;
  is_member: boolean;
  topic?: {
    value: string;
    creator: string;
    last_set: number;
  };
  purpose?: {
    value: string;
    creator: string;
    last_set: number;
  };
  num_members?: number;
  created: number;
  creator?: string;
}

export interface Message {
  type: string;
  subtype?: string;
  user?: string;
  bot_id?: string;
  text: string;
  ts: string;
  thread_ts?: string;
  reply_count?: number;
  reply_users_count?: number;
  latest_reply?: string;
  reply_users?: string[];
  reactions?: Reaction[];
  attachments?: Attachment[];
  files?: SlackFile[];
  blocks?: Block[];
  edited?: {
    user: string;
    ts: string;
  };
}

export interface Reaction {
  name: string;
  count: number;
  users: string[];
}

export interface Attachment {
  id?: number;
  fallback?: string;
  color?: string;
  pretext?: string;
  author_name?: string;
  author_link?: string;
  author_icon?: string;
  title?: string;
  title_link?: string;
  text?: string;
  fields?: Array<{
    title: string;
    value: string;
    short: boolean;
  }>;
  image_url?: string;
  thumb_url?: string;
  footer?: string;
  footer_icon?: string;
  ts?: number;
  // Unfurled link fields
  from_url?: string;
  original_url?: string;
  service_name?: string;
  service_icon?: string;
}

export interface SlackFile {
  id: string;
  name?: string;
  title?: string;
  mimetype?: string;
  filetype?: string;
  size?: number;
  url_private?: string;
  url_private_download?: string;
  permalink?: string;
  permalink_public?: string;
  thumb_360?: string;
  thumb_480?: string;
  thumb_720?: string;
  thumb_800?: string;
  thumb_1024?: string;
}

export interface Block {
  type: string;
  block_id?: string;
  text?: {
    type: string;
    text: string;
    emoji?: boolean;
  };
  elements?: unknown[];
}

export interface ThreadWithReplies {
  messages: Message[];
  has_more: boolean;
  response_metadata?: {
    next_cursor?: string;
  };
}

export interface User {
  id: string;
  name: string;
  real_name?: string;
  display_name?: string;
  is_bot: boolean;
  is_admin?: boolean;
  /** Deactivated. `users.info` and `users.lookupByEmail` still return these. */
  deleted?: boolean;
  profile?: {
    display_name?: string;
    real_name?: string;
    image_48?: string;
    image_72?: string;
    /** Only populated when the token holds `users:read.email`. */
    email?: string;
  };
}

/**
 * Which field of a member a user search matched on, most identifying first.
 * The ORDER is load-bearing: it breaks a tie between two users whose matches
 * rank equally, so a handle hit beats a real-name hit rather than whichever
 * happened to sort first.
 */
export const USER_MATCH_FIELDS = ['handle', 'display_name', 'real_name', 'email'] as const;

export type UserMatchField = (typeof USER_MATCH_FIELDS)[number];

export interface UserMatch {
  user: User;
  /** 0 = exact, 1 = prefix, 2 = substring. Lower is a better match. */
  rank: number;
  field: UserMatchField;
}

/**
 * A directory read, with whether it saw the whole directory.
 *
 * `truncated` is not a detail: "exactly one member matched" is only a promise
 * about the pages that were fetched, and a caller about to send a private
 * message to that one member needs to know which of the two it got.
 */
export interface UserDirectory {
  users: User[];
  truncated: boolean;
}

export interface UserSearch {
  matches: UserMatch[];
  truncated: boolean;
}

export interface DmList {
  dms: DirectMessage[];
  truncated: boolean;
}

/**
 * A DM conversation. `is_im` conversations are one-to-one and carry the other
 * member in `userId`; `is_mpim` group DMs carry a generated `name` instead
 * (`mpdm-tadas--julie--zimmer-1`) and no single counterpart.
 */
export interface DirectMessage {
  /** The DM channel id — `D…` — which every channel tool here also accepts. */
  id: string;
  isGroup: boolean;
  userId?: string;
  /** Resolved from `users.list` when the token can read it. */
  user?: User;
  /** Group DMs only. */
  name?: string;
  created: number;
  /** Milliseconds since epoch, unlike `created`. Slack's shape, not ours. */
  updated?: number;
  isUserDeleted: boolean;
}

export interface PaginatedResponse<T> {
  items: T[];
  has_more: boolean;
  next_cursor?: string;
}
