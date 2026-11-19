/**
 * One Gmail message -> one `message_received` occurrence, or nothing.
 *
 * WHAT IS NEVER AN EVENT, and why each. These mirror Zimmer's email trigger
 * (`EmailTriggerPollerJob` in tadasant/zimmer), so a trigger moved onto this
 * event sees the mail the poller saw:
 *   - a message labelled SENT, DRAFT, SPAM or TRASH when it is read: not
 *     inbound mail for anyone to answer (Zimmer's NEVER_FIRE_LABELS);
 *   - a message From the mailbox's own address: the poller's `-from:me`, the
 *     self-loop of a trigger that answers by email.
 *
 * AUTOMATED MAIL IS AN EVENT, MARKED. `is_automated` and `automated_reason`
 * carry Zimmer's `automated_reason` verdict, and `include_automated: false`
 * (the default, as on Zimmer's condition) drops it at poll and delivery time.
 * The reason names a header, a label or a pattern, never what the sender
 * wrote.
 *
 * EVERYTHING THE SENDER WROTE IS UNTRUSTED: `from`, `to`, `subject` and
 * `snippet` are the sender's words and are cut to a length, never interpreted.
 */
import type { MessageMetadata } from "./gmail-api.js";

/** Zimmer's NEVER_FIRE_LABELS. */
export const NEVER_EVENT_LABELS = ["SENT", "DRAFT", "SPAM", "TRASH"] as const;

/** Zimmer's AUTOMATED_LABELS. Updates is deliberately not one: a forwarded receipt lands there too. */
export const AUTOMATED_LABELS = ["CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL", "CATEGORY_FORUMS"] as const;

/** Zimmer's AUTOMATED_SENDER, on the address. */
export const AUTOMATED_SENDER =
  /^(mailer-daemon|postmaster|no[-_.]?reply|do[-_.]?not[-_.]?reply|bounces?|notifications?|alerts?)([+@])/i;

/** Zimmer's AUTOMATED_SUBJECT. */
export const AUTOMATED_SUBJECT =
  /^\s*(auto(matic)?[- ]?(reply|response)\b|auto:|out of (the )?office\b|undeliverable\b|undelivered mail\b|delivery status notification\b|mail delivery (failed|subsystem)\b|returned mail\b|failure notice\b)/i;

const MAX_HEADER_CHARS = 1_000;
export const MAX_SNIPPET_CHARS = 500;

export interface MessageReceivedData {
  message_id: string;
  thread_id: string;
  permalink: string;
  from: string;
  to: string;
  subject: string;
  snippet: string;
  received_at: string;
  label_ids: string[];
  is_automated: boolean;
  automated_reason: string | null;
}

export interface StoredEvent {
  /** `gmail:<message_id>`, exactly. */
  eventId: string;
  /** ISO 8601, Gmail's `internalDate`: when the mailbox received it. */
  timestamp: string;
  data: MessageReceivedData;
  /** Ingest order; see `buffer.ts`. */
  seq: number;
  /**
   * Gmail-search verdicts, per subscription `query`: true, false, or absent
   * while undecided. Never sent: delivery and poll send `data` only.
   */
  q?: Record<string, boolean>;
  /** The RFC 822 Message-ID, which a query is checked against. Never sent. */
  rfc822?: string;
}

export function eventIdFor(messageId: string): string {
  return `gmail:${messageId}`;
}

/**
 * The link the gmail tools print as "Gmail URL", character for character
 * (`buildGmailUrl` in `vendor/gmail-shared/src/utils/email-helpers.ts`), which
 * is also the `{{link}}` Zimmer's email trigger fills in.
 */
export function permalinkFor(accountEmail: string, messageId: string): string {
  return `https://mail.google.com/mail/?authuser=${accountEmail}#all/${messageId}`;
}

export function header(meta: MessageMetadata, name: string): string | undefined {
  const lower = name.toLowerCase();
  return meta.headers.find((h) => h.name.toLowerCase() === lower)?.value;
}

/** The address in a From header, lower-cased: `Name <a@b.c>` and bare `a@b.c` alike. Zimmer's `from_address`. */
export function addressOf(from: string | undefined): string | null {
  if (!from) return null;
  const angle = /<([^<>\s]+@[^<>\s]+)>/.exec(from)?.[1];
  const bare = angle ?? /[^\s<>"]+@[^\s<>"]+/.exec(from)?.[0];
  return bare ? bare.toLowerCase() : null;
}

/** Zimmer's `automated_reason`: a header, a label, a sender or a subject, in that order. */
export function automatedReason(meta: MessageMetadata): string | null {
  const autoSubmitted = header(meta, "Auto-Submitted");
  if (autoSubmitted !== undefined && autoSubmitted.split(";")[0]!.trim().toLowerCase() !== "no") {
    return "automated: Auto-Submitted header";
  }
  if (header(meta, "List-Id") !== undefined) return "automated: List-Id header";
  const category = AUTOMATED_LABELS.filter((l) => meta.labelIds.includes(l));
  if (category.length > 0) return `automated: label ${category.join(", ")}`;
  if ((addressOf(header(meta, "From")) ?? "").match(AUTOMATED_SENDER)) {
    return "automated: no-reply or mail-system sender";
  }
  if ((header(meta, "Subject") ?? "").match(AUTOMATED_SUBJECT)) return "automated: auto-reply or bounce subject";
  return null;
}

/** Why this message is never an event, or null when it is one. Names a label, never content. */
export function neverEventReason(meta: MessageMetadata, accountEmail: string): string | null {
  const never = NEVER_EVENT_LABELS.filter((l) => meta.labelIds.includes(l));
  if (never.length > 0) return `label ${never.join(", ")}`;
  if (addressOf(header(meta, "From")) === accountEmail.toLowerCase()) return "from the mailbox itself";
  return null;
}

export function toMessageReceived(
  meta: MessageMetadata,
  accountEmail: string,
): Omit<StoredEvent, "seq"> | null {
  if (!meta.id || neverEventReason(meta, accountEmail) !== null) return null;
  const ms = Number(meta.internalDate);
  const receivedAt = new Date(Number.isFinite(ms) && ms > 0 ? ms : 0).toISOString();
  const reason = automatedReason(meta);
  const rfc822 = safeMessageId(header(meta, "Message-ID"));
  return {
    eventId: eventIdFor(meta.id),
    timestamp: receivedAt,
    data: {
      message_id: meta.id,
      thread_id: meta.threadId,
      permalink: permalinkFor(accountEmail, meta.id),
      from: cut(header(meta, "From") ?? "", MAX_HEADER_CHARS),
      to: cut(header(meta, "To") ?? "", MAX_HEADER_CHARS),
      subject: cut(header(meta, "Subject") ?? "", MAX_HEADER_CHARS),
      snippet: cut(meta.snippet, MAX_SNIPPET_CHARS),
      received_at: receivedAt,
      label_ids: [...meta.labelIds],
      is_automated: reason !== null,
      automated_reason: reason,
    },
    ...(rfc822 ? { rfc822 } : {}),
  };
}

/**
 * The Message-ID, only when it can go into a Gmail search as one token. The
 * sender writes it, and a space, quote, parenthesis or brace would turn the
 * rest into search terms: a query check that always misses, holding the
 * subscriber's feed for 30 minutes. Anything else is checked by time window.
 */
export function safeMessageId(raw: string | undefined): string | undefined {
  const id = raw?.trim().replace(/^<|>$/g, "");
  return id && id.length <= 250 && /^[A-Za-z0-9._%+=$#!@\/-]+$/.test(id) ? id : undefined;
}

/** At most `max` UTF-16 units, never ending on half a surrogate pair. */
export function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const end = /[\uD800-\uDBFF]/.test(text[max - 1]!) ? max - 1 : max;
  return text.slice(0, end);
}
