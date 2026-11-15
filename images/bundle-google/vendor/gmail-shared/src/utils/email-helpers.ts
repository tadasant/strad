import type { Email } from '../types.js';

/**
 * Extracts a header value from an email by header name (case-insensitive)
 */
export function getHeader(email: Email, headerName: string): string | undefined {
  return email.payload?.headers?.find((h) => h.name.toLowerCase() === headerName.toLowerCase())
    ?.value;
}

/**
 * Builds an account-scoped Gmail web URL for a given message.
 *
 * The account selector is the `?authuser=<account-email>` query parameter.
 * When the reader is signed into multiple Google accounts, some browsers fail
 * to resolve the `/mail/u/<email>/` email-in-path selector and open the wrong
 * account; the `?authuser=<email>` query parameter reliably selects the
 * intended mailbox across multi-account browser sessions.
 *
 * The label anchor is `#all/<messageId>`, which resolves the thread regardless
 * of which label it lives under. An `#inbox/<id>` anchor only matches threads
 * currently in the Inbox, so links to Sent, archived, or otherwise non-Inbox
 * threads would open the mailbox but never surface the thread.
 *
 * `accountEmail` is interpolated with a literal `@` (Gmail accepts the literal
 * form in `authuser`), matching the deep-link form confirmed to open Sent and
 * archived threads across a multi-account browser session.
 */
export function buildGmailUrl(accountEmail: string, messageId: string): string {
  return `https://mail.google.com/mail/?authuser=${accountEmail}#all/${messageId}`;
}

/**
 * The Drafts folder of ONE account, as a Gmail web URL.
 *
 * Gmail has no documented URL for a single draft. The widely repeated
 * `#drafts?compose=<message-id>` fragment is undocumented and was not
 * confirmed against a live mailbox, so a draft tool links its account's
 * Drafts folder instead: one click from the draft (`FORK.md` delta 7).
 *
 * The account is selected by ADDRESS (`?authuser=<email>`), never by a
 * `/u/<n>/` index: a reader signed into several Google accounts has them
 * numbered in sign-in order, and an index opens whichever one happens to sit
 * there. The address is percent-encoded, so a `+` in it is not read as a
 * space and a `#` or `&` cannot end the parameter.
 */
export function buildGmailDraftsUrl(accountEmail: string): string {
  return `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(accountEmail)}#drafts`;
}

/**
 * The account a draft tool is acting as, or `undefined` when it cannot be
 * read. A draft tool asks AFTER its write has landed, so a failed profile
 * lookup must cost the link and never turn a saved draft into a reported
 * error.
 */
export async function draftsAccountEmail(client: {
  getAccountEmail(): Promise<string>;
}): Promise<string | undefined> {
  try {
    const email = (await client.getAccountEmail()).trim();
    return email || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Formats an email for display in tool output.
 *
 * When `accountEmail` is provided, an account-scoped Gmail web URL is
 * appended so the user can click through to the correct mailbox.
 */
export function formatEmail(email: Email, accountEmail?: string): string {
  const subject = getHeader(email, 'Subject') || '(No Subject)';
  const from = getHeader(email, 'From') || 'Unknown';
  const date = getHeader(email, 'Date') || 'Unknown date';
  const snippet = email.snippet || '';

  let output = `**ID:** ${email.id}
**Thread ID:** ${email.threadId}
**Subject:** ${subject}
**From:** ${from}
**Date:** ${date}
**Preview:** ${snippet}`;

  if (accountEmail) {
    output += `\n**Gmail URL:** ${buildGmailUrl(accountEmail, email.id)}`;
  }

  return output;
}
