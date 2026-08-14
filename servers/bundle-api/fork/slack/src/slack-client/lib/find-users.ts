import type { User, UserMatch, UserMatchField } from '../../types.js';
import { listUsers } from './list-users.js';

/** Fields a query is matched against, best-identifying first. */
const FIELDS: Array<{ field: UserMatchField; of: (user: User) => string | undefined }> = [
  { field: 'handle', of: (u) => u.name },
  { field: 'display_name', of: (u) => u.profile?.display_name },
  { field: 'real_name', of: (u) => u.real_name ?? u.profile?.real_name },
  { field: 'email', of: (u) => u.profile?.email },
];

/** Strip the `@` a caller naturally types in front of a handle. */
export function normalizeQuery(query: string): string {
  return query.trim().replace(/^@/, '').toLowerCase();
}

function score(user: User, query: string): UserMatch | null {
  let best: UserMatch | null = null;

  for (const { field, of } of FIELDS) {
    const value = of(user)?.trim().toLowerCase();
    if (!value) continue;

    const rank = value === query ? 0 : value.startsWith(query) ? 1 : value.includes(query) ? 2 : -1;
    if (rank === -1) continue;

    if (best === null || rank < best.rank) {
      best = { user, rank, field };
    }
  }

  return best;
}

/**
 * Finds workspace members whose handle, display name, real name or email matches
 * `query`.
 *
 * Slack has no server-side user search, so this lists the workspace and filters
 * here — see `listUsers` for what that costs. Matches come back best-first
 * (exact, then prefix, then substring) and the rank is preserved, because the
 * useful question for a caller about to send a DM is not "is there a match" but
 * "is there exactly ONE best match".
 *
 * Email matching only works when the token holds `users:read.email`; without it
 * Slack omits `profile.email` from every member and the field silently never
 * matches. `lookupUserByEmail` is the call that says so out loud.
 */
export async function findUsers(
  baseUrl: string,
  headers: Record<string, string>,
  query: string
): Promise<UserMatch[]> {
  const normalized = normalizeQuery(query);
  if (normalized === '') {
    return [];
  }

  const users = await listUsers(baseUrl, headers);

  return users
    .map((user) => score(user, normalized))
    .filter((match): match is UserMatch => match !== null)
    .sort((a, b) => a.rank - b.rank || a.user.id.localeCompare(b.user.id));
}
