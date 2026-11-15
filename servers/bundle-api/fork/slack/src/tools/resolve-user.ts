import type { ISlackClient } from '../server.js';
import { compareMatches, equallyGood } from '../slack-client/lib/find-users.js';
import type { User, UserMatch } from '../types.js';

/**
 * How a DM tool names its recipient.
 *
 * A raw `U012AB3CDEF` is what Slack's API wants and is not something an agent
 * has lying around; a name is what the agent has and is not unique. So one
 * parameter takes all three forms and the AMBIGUITY, not the lookup, is what
 * gets surfaced: an identifier matching two people is an error listing both with
 * their IDs, never a message delivered to whichever sorted first.
 */
export const USER_PARAM_GUIDANCE =
  'The recipient. Accepts any of: a Slack user ID ("U012AB3CDEF" — exact and ' +
  'always unambiguous), an email address ("tadas@example.com", needs the ' +
  'users:read.email scope), a handle with or without the "@" ("@tadas"), or a ' +
  'display or real name ("Tadas Antanavicius"). Names are matched case-' +
  'insensitively, exact matches beat prefixes beat substrings, and an identifier ' +
  'that matches more than one person equally well is an ERROR listing the ' +
  'candidates rather than a guess — re-run with the user ID of the one you meant. ' +
  'Use slack_find_user to search for an ID first if you are unsure.';

/**
 * Slack member ids: `U…` for a normal account, `W…` on enterprise grid, and at
 * least eight characters after the prefix.
 *
 * Case-sensitive and length-bounded on purpose. A loose `/^[UW][A-Z0-9]{2,}$/i`
 * also matches "will", "wes" and "una" — ordinary handles the tool description
 * invites — and routes them down the id path, where they resolve to a fabricated
 * id and fail at the send with a Slack error naming nothing the caller wrote.
 */
const USER_ID = /^[UW][A-Z0-9]{7,}$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Shared with `slack_find_user`, so one rule decides what an address is. */
export function looksLikeEmail(value: string): boolean {
  return EMAIL.test(value.trim());
}

const MAX_CANDIDATES = 5;

export interface ResolvedUser {
  id: string;
  /** "Tadas Antanavicius (@tadas, U012AB3CDEF)" — what a result line should say. */
  label: string;
  /** Absent when the directory could not confirm the id. The label says so too. */
  user?: User;
}

/** A recipient that could not be turned into exactly one live user id. */
export class UserResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserResolutionError';
  }
}

export function userLabel(user: User): string {
  const real = (user.real_name ?? user.profile?.real_name)?.trim();
  const display = user.profile?.display_name?.trim();
  const name = real || display || user.name;
  return `${name} (@${user.name}, ${user.id})${user.is_bot ? ' [bot]' : ''}`;
}

function describe(matches: UserMatch[]): string {
  const shown = matches
    .slice(0, MAX_CANDIDATES)
    .map((m) => `${userLabel(m.user)} — matched on ${m.field}`);
  const rest = matches.length - shown.length;
  return shown.join('; ') + (rest > 0 ? `; and ${rest} more` : '');
}

function refuseDeactivated(user: User, identifier: string): void {
  if (user.deleted) {
    throw new UserResolutionError(
      `${userLabel(user)} is a deactivated account and cannot receive a DM ` +
        `(resolved from "${identifier}").`
    );
  }
}

/**
 * Turns whatever a caller wrote into exactly one user id, or explains why it
 * could not.
 */
export async function resolveUser(client: ISlackClient, identifier: string): Promise<ResolvedUser> {
  const raw = identifier.trim();

  if (USER_ID.test(raw)) {
    let user: User;
    try {
      user = await client.getUser(raw);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A real "no such user" is the caller's problem and must not be dressed up
      // as a successful resolution; anything else (users:read missing, a
      // transport blip) only costs the confirmation, not the delivery.
      if (/user_not_found/.test(message)) {
        throw new UserResolutionError(
          `No workspace member has the ID "${raw}". Use slack_find_user to search by name.`
        );
      }
      return { id: raw, label: `${raw} — identity UNVERIFIED, the user directory could not be read` };
    }
    refuseDeactivated(user, raw);
    return { id: user.id, label: userLabel(user), user };
  }

  if (EMAIL.test(raw)) {
    const user = await client.lookupUserByEmail(raw);
    if (!user) {
      throw new UserResolutionError(
        `No workspace member has the email "${raw}". Slack matches the address on the ` +
          'Slack profile, which is not always the one you know them by — search with ' +
          'slack_find_user by name or handle instead.'
      );
    }
    refuseDeactivated(user, raw);
    return { id: user.id, label: userLabel(user), user };
  }

  const { matches, truncated } = await client.findUsers(raw);

  if (matches.length === 0) {
    throw new UserResolutionError(
      `No workspace member matches "${raw}"${
        truncated ? ', though the directory listing was cut off before the end' : ''
      }. Try slack_find_user with a shorter query, or pass the user ID directly.`
    );
  }

  // findUsers already sorts, but a client implementation is not obliged to.
  const ordered = [...matches].sort(compareMatches);
  const best = ordered[0];

  // What counts as a rival depends on how strong the win is.
  //
  // An EXACT hit is a real claim to be the person named, so the field decides
  // between two of them: an exact handle beats an exact real name, and only
  // another exact hit on the SAME field is a tie.
  //
  // A prefix or substring hit is not a claim, it is a coincidence of letters.
  // "ann" prefixes the handle `annoy-bot` and the real name "Ann Smith" alike,
  // and preferring the handle there would DM a bot on a technicality. So at
  // rank 1 or 2 any equally-close candidate is a rival, whatever it matched on.
  const rivals = ordered
    .slice(1)
    .filter((m) => (best.rank === 0 ? equallyGood(m, best) : m.rank === best.rank));

  if (rivals.length > 0) {
    const tied = [best, ...rivals];
    throw new UserResolutionError(
      `"${raw}" matches ${tied.length} workspace members equally well: ${describe(tied)}. ` +
        'Re-run with the user ID of the one you meant.'
    );
  }

  if (truncated && best.rank !== 0) {
    throw new UserResolutionError(
      `"${raw}" matched ${userLabel(best.user)}, but only ${ordered.length === 1 ? 'a part' : 'part'} ` +
        'of the workspace directory was read before this tool hit its page cap — another ' +
        'member could match it better. Re-run with a user ID, or with an exact handle.'
    );
  }

  return { id: best.user.id, label: userLabel(best.user), user: best.user };
}
