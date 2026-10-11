import type { Email } from '../types.js';

/**
 * The headers a reader needs to decide who actually sent a message, rather
 * than who the `From:` line claims sent it. Delta 4 of this fork (`FORK.md`).
 *
 * `From:` is text the sender wrote. What the receiving server concluded about
 * it is `Authentication-Results`, which the receiving server (mx.google.com,
 * for a Gmail mailbox) prepends ABOVE every header the sender wrote. A sender
 * can write its own `Authentication-Results` lower in the message, so the
 * order is the evidence, and this module never merges, dedupes or reorders.
 */
export const SENDER_VERIFICATION_HEADERS = [
  'Authentication-Results',
  'ARC-Authentication-Results',
  'Received-SPF',
  'DKIM-Signature',
  'From',
  'Sender',
  'Reply-To',
  'Return-Path',
  'Message-ID',
  'In-Reply-To',
  'References',
  'Auto-Submitted',
  'List-Id',
] as const;

export interface VerificationHeader {
  /** Position in the message's full header list; 0 is the topmost header. */
  index: number;
  /** The header name as the message spells it. */
  name: string;
  /** The value exactly as Gmail returned it. */
  value: string;
}

export interface SenderVerification {
  /** Every instance of every header in SENDER_VERIFICATION_HEADERS, top first. */
  headers: VerificationHeader[];
  /** The names in SENDER_VERIFICATION_HEADERS the message does not carry at all. */
  absent: string[];
}

const WANTED = new Map<string, string>(
  SENDER_VERIFICATION_HEADERS.map((name) => [name.toLowerCase(), name])
);

export function getSenderVerification(email: Email): SenderVerification {
  const all = email.payload?.headers ?? [];
  const headers: VerificationHeader[] = [];
  const seen = new Set<string>();
  all.forEach((h, index) => {
    const key = h.name.toLowerCase();
    if (!WANTED.has(key)) return;
    seen.add(key);
    headers.push({ index, name: h.name, value: h.value });
  });
  const absent = SENDER_VERIFICATION_HEADERS.filter((name) => !seen.has(name.toLowerCase()));
  return { headers, absent };
}

/**
 * JSON.stringify escapes C0 controls but passes these through. None of them
 * can end a line for a markdown parser, but each can make one line read as two
 * (U+2028, U+2029, NEL) or reorder what a reader sees (bidi controls), so they
 * are written as escapes. The value is unchanged once the JSON is parsed.
 */
const VISUALLY_UNSAFE = /[\u007f-\u009f\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

export function formatSenderVerificationSection(email: Email): string {
  const json = JSON.stringify(getSenderVerification(email), null, 2).replace(
    VISUALLY_UNSAFE,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`
  );
  return `## Sender Verification Headers

Every instance of each header below, verbatim and in message order: \`index\` is the header's position in the message, and 0 is the topmost. The receiving server writes its \`Authentication-Results\` above everything the sender wrote, so only the topmost one (the lowest \`index\`) is the receiving server's verdict, once its first token (the authserv-id, e.g. mx.google.com) confirms which server wrote it; a lower one may have been written by the sender. A name in \`absent\` is not in the message at all. This section appears once, before the headers and body the sender controls.

\`\`\`json
${json}
\`\`\``;
}
