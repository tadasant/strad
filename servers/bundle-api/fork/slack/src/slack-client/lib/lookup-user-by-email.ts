import type { User } from '../../types.js';
import { slackApiError } from './slack-error.js';

interface UsersLookupByEmailResponse {
  ok: boolean;
  user?: User;
  error?: string;
  needed?: string;
}

/**
 * Resolves an email address to a workspace member, or null when nobody in the
 * workspace has it.
 *
 * `users.lookupByEmail` needs `users:read.email`, which is a SEPARATE scope from
 * `users:read` — and without it Slack also omits `profile.email` from
 * `users.list`, so there is no fallback path that works. A missing scope is
 * therefore raised rather than folded into "no such user": the two need
 * different fixes, and confusing them sends an operator hunting for a typo in an
 * address that is fine.
 */
export async function lookupUserByEmail(
  baseUrl: string,
  headers: Record<string, string>,
  email: string
): Promise<User | null> {
  const params = new URLSearchParams({ email });

  const response = await fetch(`${baseUrl}/users.lookupByEmail?${params}`, {
    method: 'GET',
    headers,
  });

  if (!response.ok) {
    throw new Error(`Failed to look up user by email: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as UsersLookupByEmailResponse;

  if (!data.ok) {
    if (data.error === 'users_not_found') {
      return null;
    }
    throw slackApiError('users.lookupByEmail', data);
  }

  return data.user ?? null;
}
