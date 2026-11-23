import { handleApiError } from './api-errors.js';

/**
 * A Gmail label, as `users.labels.list` and `users.labels.create` return it.
 * `type` is `system` for Gmail's own (INBOX, STARRED, CATEGORY_UPDATES, …) and
 * `user` for one the mailbox's owner made. Strad FORK.md delta 8.
 */
export interface GmailLabel {
  id: string;
  name: string;
  type?: 'system' | 'user';
  messageListVisibility?: string;
  labelListVisibility?: string;
}

/**
 * Gmail compares label names without regard to case: creating `receipts` beside
 * `Receipts` is refused with 409. So name lookups here fold case too, and a
 * caller's `added details to calendar` finds `Added details to calendar`.
 * Surrounding whitespace is not part of a name.
 */
export function labelNameKey(name: string): string {
  return name.trim().toLowerCase();
}

/** The label whose name matches `name` (case-insensitively), if any. */
export function findLabelByName(labels: GmailLabel[], name: string): GmailLabel | undefined {
  const key = labelNameKey(name);
  return labels.find((l) => labelNameKey(l.name) === key);
}

/** Every label in the mailbox, system and user. One request; Gmail does not page it. */
export async function listLabels(
  baseUrl: string,
  headers: Record<string, string>
): Promise<GmailLabel[]> {
  const response = await fetch(`${baseUrl}/labels`, { method: 'GET', headers });
  if (!response.ok) {
    handleApiError(response.status, 'listing labels');
  }
  const data = (await response.json()) as { labels?: GmailLabel[] };
  return data.labels ?? [];
}

/**
 * Creates a user label, or returns the one that already has this name.
 *
 * Idempotent by name: the labels are listed first and an existing match is
 * returned with `created: false`. A create that still loses a race (Gmail's
 * 409, "Label name exists or conflicts") re-lists and returns the winner, so
 * two agents labelling at once both succeed and both get the same ID.
 */
export async function createLabel(
  baseUrl: string,
  headers: Record<string, string>,
  name: string
): Promise<{ label: GmailLabel; created: boolean }> {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error('A label name cannot be empty.');
  }

  const existing = findLabelByName(await listLabels(baseUrl, headers), trimmed);
  if (existing) return { label: existing, created: false };

  const response = await fetch(`${baseUrl}/labels`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: trimmed,
      labelListVisibility: 'labelShow',
      messageListVisibility: 'show',
    }),
  });

  if (response.status === 409) {
    const winner = findLabelByName(await listLabels(baseUrl, headers), trimmed);
    if (winner) return { label: winner, created: false };
    // 409 with no visible match: the name collides with a reserved system name.
    throw new Error(
      `Gmail refused to create a label named "${trimmed}": the name is reserved or conflicts ` +
        'with an existing label. Call list_email_labels to see the names in use.'
    );
  }
  if (response.status === 400) {
    throw new Error(
      `Gmail refused the label name "${trimmed}" (HTTP 400). Names cannot be empty, ` +
        'cannot be a system label name (INBOX, SENT, …), and nested names use "/".'
    );
  }
  if (response.status === 403) {
    throw new Error(
      'Permission denied creating a label. The credential needs the gmail.modify ' +
        '(or gmail.labels) scope; a gmail.readonly credential cannot create labels.'
    );
  }
  if (!response.ok) {
    handleApiError(response.status, 'creating label', trimmed);
  }

  return { label: (await response.json()) as GmailLabel, created: true };
}
