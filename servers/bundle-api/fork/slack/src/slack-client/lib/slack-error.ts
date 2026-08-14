/**
 * A Slack Web API error, with the scope it names.
 *
 * Every DM call in this fork is gated on an OAuth scope the channel calls do not
 * need (`im:write`, `im:read`, `mpim:read`, `users:read`, `users:read.email`), and
 * Slack answers a missing one with `{"ok":false,"error":"missing_scope","needed":"im:write"}`.
 * `needed` is the whole diagnosis — an operator reading "missing_scope" alone has
 * to go and guess which of five scopes it was — so it is carried into the message.
 */
export function slackApiError(action: string, data: { error?: string; needed?: string }): Error {
  const scope = data.needed ? ` — this call needs the OAuth scope: ${data.needed}` : '';
  return new Error(`Slack API error on ${action}: ${data.error ?? 'unknown error'}${scope}`);
}
