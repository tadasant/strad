import type { User } from '../../types.js';
import { slackApiError } from './slack-error.js';

interface UsersInfoResponse {
  ok: boolean;
  user?: User;
  error?: string;
  needed?: string;
}

/**
 * Fetches one member by ID. Needs `users:read`.
 *
 * Used to put a NAME on a raw `U…` id before a DM is sent: an agent handed the
 * wrong id would otherwise get a success result that names only the id it
 * already passed, and no way to notice it just messaged a stranger.
 */
export async function getUser(
  baseUrl: string,
  headers: Record<string, string>,
  userId: string
): Promise<User> {
  const params = new URLSearchParams({ user: userId });

  const response = await fetch(`${baseUrl}/users.info?${params}`, {
    method: 'GET',
    headers,
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch user: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as UsersInfoResponse;

  if (!data.ok || !data.user) {
    throw slackApiError('users.info', data);
  }

  return data.user;
}
