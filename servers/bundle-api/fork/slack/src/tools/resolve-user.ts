import type { ISlackClient } from '../server.js';
import type { User, UserMatch } from '../types.js';

/**
 * How a DM tool names its recipient.
 *
 * A raw `U0BFTSUN8MD` is what Slack's API wants and is not something an agent
 * has lying around; a name is what the agent has and is not unique. So one
 * parameter takes all three forms and the AMBIGUITY, not the lookup, is what
 * gets surfaced: an identifier matching two people is an error listing both with
 * their ids, never a message delivered to whichever sorted first.
 */
export const USER_PARAM_GUIDANCE =
  'The recipient. Accepts any of: a Slack user ID ("U0BFTSUN8MD" — exact and ' +
  'always unambiguous), an email address ("tadas@example.com", needs the ' +
  'users:read.email scope), a handle with or without the "@" ("@tadas"), or a ' +
  'display or real name ("Tadas Antanavicius"). Names are matched case-' +
  'insensitively, exact matches beat prefixes beat substrings, and an identifier ' +
  'that matches more than one person is an ERROR listing the candidates rather ' +
  'than a guess — re-run with the user ID of the one you meant. ' +
  'Use slack_find_user to search for an ID first if you are unsure.';

/** Slack member ids are `U…`; enterprise-grid accounts are `W…`. */
const USER_ID = /^[UW][A-Z0-9]{2,}$/i;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const MAX_CANDIDATES = 5;

export interface ResolvedUser {
  id: string;
  /** "Tadas Antanavicius (@tadas, U0BFTSUN8MD)" — what a result line should say. */
  label: string;
  user?: User;
}

/** A recipient that could not be turned into exactly one user id. */
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
  const shown = matches.slice(0, MAX_CANDIDATES).map((m) => `${userLabel(m.user)} — matched on ${m.field}`);
  const rest = matches.length - shown.length;
  return shown.join('; ') + (rest > 0 ? `; and ${rest} more` : '');
}

/**
 * Turns whatever a caller wrote into exactly one user id, or explains why it
 * could not.
 */
export async function resolveUser(
  client: ISlackClient,
  identifier: string
): Promise<ResolvedUser> {
  const raw = identifier.trim();

  if (USER_ID.test(raw)) {
    const id = raw.toUpperCase();
    try {
      const user = await client.getUser(id);
      return { id, label: userLabel(user), user };
    } catch {
      // users:read may be absent, or the id may be a bot/app id. Neither stops a
      // DM from being addressed — it only costs the confirmation of who it is.
      return { id, label: id };
    }
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
    return { id: user.id, label: userLabel(user), user };
  }

  const matches = await client.findUsers(raw);

  if (matches.length === 0) {
    throw new UserResolutionError(
      `No workspace member matches "${raw}". Try slack_find_user with a shorter query, ` +
        'or pass the user ID directly.'
    );
  }

  const best = matches.filter((m) => m.rank === matches[0].rank);

  if (best.length > 1) {
    throw new UserResolutionError(
      `"${raw}" matches ${best.length} workspace members: ${describe(best)}. ` +
        'Re-run with the user ID of the one you meant.'
    );
  }

  return { id: best[0].user.id, label: userLabel(best[0].user), user: best[0].user };
}
