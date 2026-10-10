/**
 * The display name Gmail holds for the address this server sends from.
 *
 * Gmail keeps it on the account's send-as settings ("Send mail as" in Gmail's
 * settings, `users.settings.sendAs`), and the web UI uses it on every message.
 * A message sent through the API carries whatever `From` header its raw MIME
 * spells, and Gmail does not add the name to a bare address. So the server has
 * to read the name and put it in the header itself.
 *
 * `sendAs.list` needs `gmail.readonly`, `gmail.modify`, `gmail.settings.basic`
 * or full `mail.google.com`. A credential granted only `gmail.send` or
 * `gmail.compose` can send but not read this, and its mail goes out from the
 * bare address.
 */

/** A lookup slower than this gives up, so a hung settings read never holds up a send. */
export const SEND_AS_TIMEOUT_MS = 5000;

interface SendAs {
  sendAsEmail?: string;
  displayName?: string;
}

/**
 * Returns the display name of the send-as entry for `email`, matched by
 * address and never by `isPrimary`: another address's name on this one would
 * be a wrong name, and a bare address is not. `undefined` when there is no
 * entry or it has no name.
 * Throws when the settings cannot be read, so the caller can decide not to
 * remember a failure.
 */
export async function getSendAsDisplayName(
  baseUrl: string,
  headers: Record<string, string>,
  email: string
): Promise<string | undefined> {
  const response = await fetch(`${baseUrl}/settings/sendAs`, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(SEND_AS_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Failed to list send-as settings: ${response.status} ${response.statusText}`);
  }
  const { sendAs = [] } = (await response.json()) as { sendAs?: SendAs[] };
  const wanted = email.toLowerCase();
  const entry = sendAs.find((s) => s.sendAsEmail?.toLowerCase() === wanted);
  const name = entry?.displayName?.trim();
  return name ? name : undefined;
}
