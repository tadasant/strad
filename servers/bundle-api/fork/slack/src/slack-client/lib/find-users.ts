import type { User, UserMatch, UserMatchField, UserSearch } from '../../types.js';
import { USER_MATCH_FIELDS } from '../../types.js';
import { listUsers } from './list-users.js';

/** Fields a query is matched against, in `USER_MATCH_FIELDS` order. */
const FIELDS: Record<UserMatchField, (user: User) => string | undefined> = {
  handle: (u) => u.name,
  display_name: (u) => u.profile?.display_name,
  real_name: (u) => u.real_name ?? u.profile?.real_name,
  email: (u) => u.profile?.email,
};

/** How identifying the matched field is. Lower is stronger. */
export function fieldStrength(field: UserMatchField): number {
  return USER_MATCH_FIELDS.indexOf(field);
}

/**
 * Order two matches: better rank first, then the more identifying field.
 *
 * Both halves matter. Comparing on `rank` alone lets a prefix hit on any field
 * beat an exact hit on none — so `annoy-bot` (handle, prefix of "ann") outranks
 * the Joanna whose real name contains it, and the tie that should have been
 * reported never forms.
 */
export function compareMatches(a: UserMatch, b: UserMatch): number {
  return (
    a.rank - b.rank ||
    fieldStrength(a.field) - fieldStrength(b.field) ||
    a.user.id.localeCompare(b.user.id)
  );
}

/** True when two matches are equally good — which is what ambiguity IS. */
export function equallyGood(a: UserMatch, b: UserMatch): boolean {
  return a.rank === b.rank && a.field === b.field;
}

/** Strip the `@` a caller naturally types in front of a handle. */
export function normalizeQuery(query: string): string {
  return query.trim().replace(/^@/, '').toLowerCase();
}

function score(user: User, query: string): UserMatch | null {
  let best: UserMatch | null = null;

  for (const field of USER_MATCH_FIELDS) {
    const value = FIELDS[field](user)?.trim().toLowerCase();
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
 * here — see `listUsers` for what that costs and why `truncated` comes back with
 * the matches. Matches are ordered best-first by `compareMatches`, because the
 * useful question for a caller about to send a DM is not "is there a match" but
 * "is there exactly one BEST match".
 *
 * Email matching only works when the token holds `users:read.email`; without it
 * Slack omits `profile.email` from every member and the field silently never
 * matches. `lookupUserByEmail` is the call that says so out loud.
 */
export async function findUsers(
  baseUrl: string,
  headers: Record<string, string>,
  query: string
): Promise<UserSearch> {
  const normalized = normalizeQuery(query);
  if (normalized === '') {
    return { matches: [], truncated: false };
  }

  const { users, truncated } = await listUsers(baseUrl, headers);

  const matches = users
    .map((user) => score(user, normalized))
    .filter((match): match is UserMatch => match !== null)
    .sort(compareMatches);

  return { matches, truncated };
}
