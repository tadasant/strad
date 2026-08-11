/**
 * A fake MTProto client: the same five calls the real one answers, over
 * fixtures.
 *
 * The seam is deliberate. The tests drive the CLIENT, not this server's own
 * gateway interface, so everything between a TL object and a tool result —
 * entity mapping, chat resolution and its dialog-scan fallback, paging cursors,
 * ordering — is under test rather than mocked away.
 *
 * EVERY IDENTIFIER HERE IS INVENTED. No real Telegram account, group id, phone
 * number or display name appears in this repo.
 */

/** A supergroup the fixture account is a member of and does not administer. */
export const GROUP = {
  id: 4123456789,
  className: "Channel",
  title: "Weekend Climbing",
  username: "weekendclimbing",
  megagroup: true,
};

/** A broadcast channel it merely follows. */
export const CHANNEL = {
  id: 4222222222,
  className: "Channel",
  title: "Route Conditions",
  username: "routeconditions",
  broadcast: true,
};

/** A person. */
export const FRIEND = {
  id: 4111111111,
  className: "User",
  firstName: "Ada",
  lastName: "Lovelace",
  username: "ada_fixture",
};

export const ME = {
  id: 4999999999,
  className: "User",
  firstName: "Fixture",
  lastName: "Account",
  username: "fixture_account",
};

const HOUR = 3600;
const BASE = Date.UTC(2026, 7, 9, 12, 0, 0) / 1000;

/** Newest first, the way Telegram answers. */
export const GROUP_MESSAGES = [
  {
    id: 8815,
    date: BASE + 2 * HOUR,
    message: "I am. bringing the permit paperwork",
    sender: FRIEND,
    senderId: FRIEND.id,
    replyTo: { replyToMsgId: 8814 },
  },
  {
    id: 8814,
    date: BASE + HOUR,
    message: "anyone free saturday?",
    sender: ME,
    senderId: ME.id,
    out: true,
  },
  {
    id: 8813,
    date: BASE,
    message: "",
    sender: FRIEND,
    senderId: FRIEND.id,
    media: { className: "MessageMediaPhoto" },
    editDate: BASE + 60,
  },
];

export function fakeDialogs() {
  return [
    {
      id: -1004123456789,
      title: GROUP.title,
      unreadCount: 3,
      isGroup: true,
      entity: GROUP,
    },
    {
      id: -1004222222222,
      title: CHANNEL.title,
      unreadCount: 0,
      isChannel: true,
      entity: CHANNEL,
    },
    { id: 4111111111, title: "Ada Lovelace", unreadCount: 1, isUser: true, entity: FRIEND },
  ];
}

/**
 * @param {object} [options]
 * @param {boolean} [options.entityLookupWorks] false makes `getEntity` throw the
 *   way the real client does for an id whose access hash this session has never
 *   learned — the case the dialog-scan fallback exists for.
 */
export function fakeClient(options = {}) {
  const { entityLookupWorks = true } = options;
  /** Every call, in order, so a test can assert what reached Telegram. */
  const calls = [];
  let archivedDialogs = [];
  let messages = GROUP_MESSAGES;
  let nextSentId = 8900;

  return {
    calls,
    setArchived(dialogs) {
      archivedDialogs = dialogs;
    },
    setMessages(next) {
      messages = next;
    },

    async connect() {
      calls.push({ method: "connect" });
      return true;
    },

    async getMe() {
      calls.push({ method: "getMe" });
      return ME;
    },

    async getDialogs(params) {
      calls.push({ method: "getDialogs", params });
      return params.archived ? archivedDialogs : fakeDialogs();
    },

    async getEntity(ref) {
      calls.push({ method: "getEntity", ref });
      if (typeof ref === "string") {
        const match = [GROUP, CHANNEL, FRIEND].find(
          (e) => e.username?.toLowerCase() === ref.toLowerCase(),
        );
        if (match) return match;
        throw new Error("No user has that username.");
      }
      if (!entityLookupWorks) {
        throw new Error(
          "Could not find the input entity for PeerChannel. Please read https://…",
        );
      }
      const match = [GROUP, CHANNEL, FRIEND].find(
        (e) => String(e.id) === String(Math.abs(ref)).replace(/^100/, ""),
      );
      if (match) return match;
      throw new Error("Could not find the input entity");
    },

    async getMessages(entity, params) {
      calls.push({ method: "getMessages", entity, params });
      let page = messages;
      if (params.search) {
        page = page.filter((m) =>
          (m.message ?? "").toLowerCase().includes(params.search.toLowerCase()),
        );
      }
      if (params.offsetId !== undefined) {
        page = page.filter((m) => m.id < params.offsetId);
      }
      return page.slice(0, params.limit);
    },

    async sendMessage(entity, params) {
      calls.push({ method: "sendMessage", entity, params });
      return {
        id: nextSentId++,
        date: BASE + 3 * HOUR,
        message: params.message,
        sender: ME,
        senderId: ME.id,
        out: true,
      };
    },
  };
}
