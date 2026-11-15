// The DM surface: four tools that make a direct message a first-class
// conversation rather than a channel id somebody had to already know.
//
// Three things here are load-bearing and none is obvious from the Slack docs:
//
//   1. A DM is gated on scopes the channel tools never touch. `im:write` opens
//      one, `im:read` lists them, `mpim:read` is a SECOND scope for group DMs
//      that fails the whole listing when absent, and `users:read` /
//      `users:read.email` are what turn a name into an id. A missing one comes
//      back as `missing_scope` with the needed scope in a field nobody reads.
//   2. Naming a recipient is ambiguous by nature. "tadas" can be two people, and
//      the failure mode of guessing is a private message delivered to the wrong
//      human — which no advisory can walk back.
//   3. Every lookup here is a page-capped scan of a workspace-sized list, so
//      "exactly one member matched" is only true of the pages that were read.
//
// So: the fallback path is pinned, the scope is pinned into the error text,
// ambiguity is pinned as a refusal that sends nothing, and a truncated scan is
// pinned as an answer of its own rather than a "no".
import { test } from 'vitest';
import assert from 'node:assert/strict';

import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { createRegisterTools } from '../src/tools.js';
import { sendDmTool } from '../src/tools/send-dm.js';
import { getDmTool } from '../src/tools/get-dm.js';
import { getDmsTool } from '../src/tools/get-dms.js';
import { findUserTool } from '../src/tools/find-user.js';
import { resolveUser, userLabel, UserResolutionError } from '../src/tools/resolve-user.js';
import { openDm, findDmChannel } from '../src/slack-client/lib/open-dm.js';
import { getDms, listDmChannels } from '../src/slack-client/lib/get-dms.js';
import { findUsers } from '../src/slack-client/lib/find-users.js';
import { listUsers } from '../src/slack-client/lib/list-users.js';
import { lookupUserByEmail } from '../src/slack-client/lib/lookup-user-by-email.js';
import { createIntegrationMockSlackClient } from '../src/slack-client/slack-client.integration-mock.js';

const TADAS = {
  id: 'U012AB3CDEF',
  name: 'tadas',
  real_name: 'Tadas Antanavicius',
  is_bot: false,
  profile: { display_name: 'tadas', real_name: 'Tadas Antanavicius' },
};

const TADAS_TWIN = {
  id: 'U012AB3CDZZ',
  name: 'tadas.a',
  real_name: 'Tadas Antanavicius (personal)',
  is_bot: false,
  profile: { display_name: 'tadas', real_name: 'Tadas Antanavicius (personal)' },
};

const JULIE = {
  id: 'U045GH6IJKL',
  name: 'julie',
  real_name: 'Julie Doe',
  is_bot: false,
  profile: { display_name: 'Julie Doe', real_name: 'Julie Doe', email: 'julie@example.com' },
};

/** A client whose every call is recorded, so "nothing was sent" is assertable. */
function fakeClient(overrides = {}) {
  const calls = [];
  const record =
    (name, impl) =>
    async (...args) => {
      calls.push({ name, args });
      return impl(...args);
    };

  const search = overrides.findUsers ?? (async () => ({
    matches: [{ user: TADAS, rank: 0, field: 'handle' }],
    truncated: false,
  }));

  return {
    calls,
    getUser: record('getUser', overrides.getUser ?? (async () => TADAS)),
    findUsers: record('findUsers', search),
    lookupUserByEmail: record('lookupUserByEmail', overrides.lookupUserByEmail ?? (async () => null)),
    openDm: record('openDm', overrides.openDm ?? (async () => ({ channelId: 'D034CD5EFGH', via: 'conversations.open' }))),
    findDmChannel: record('findDmChannel', overrides.findDmChannel ?? (async () => 'D034CD5EFGH')),
    getDms: record('getDms', overrides.getDms ?? (async () => ({ dms: [], truncated: false }))),
    getMessages: record('getMessages', overrides.getMessages ?? (async () => ({ messages: [], hasMore: false }))),
    postMessage: record('postMessage', overrides.postMessage ?? (async () => ({ ts: '1700000000.000100' }))),
  };
}

const called = (client, name) => client.calls.filter((c) => c.name === name);

/** Shorthand for the `{matches, truncated}` a client search returns. */
const search = (matches, truncated = false) => async () => ({ matches, truncated });

/**
 * A `fetch` stub that answers Slack Web API paths from a table.
 *
 * A route value of `{ __http: 503 }` fails at the TRANSPORT layer instead —
 * Slack's own error envelope is `{ok:false}` with HTTP 200, so the two failure
 * shapes are genuinely different code paths.
 */
function stubFetch(routes) {
  const requests = [];
  const original = globalThis.fetch;

  globalThis.fetch = async (url, init) => {
    const path = new URL(url).pathname.replace('/api/', '');
    requests.push({ url: String(url), path, body: init?.body ? JSON.parse(init.body) : undefined });
    const answer = routes[path];
    assert.ok(answer, `unexpected call to ${path}`);
    const payload = typeof answer === 'function' ? answer(requests.filter((r) => r.path === path).length) : answer;
    if (payload.__http) {
      return { ok: false, status: payload.__http, statusText: 'Service Unavailable' };
    }
    return { ok: true, status: 200, json: async () => payload };
  };

  return {
    requests,
    restore() {
      globalThis.fetch = original;
    },
  };
}

const BASE = 'https://slack.com/api';
const HEADERS = { Authorization: 'Bearer xoxb-test' };

/** Build a `users.list` page table of `count` synthetic members. */
function directoryPages(pages) {
  return (n) => {
    const members = Array.from({ length: 2 }, (_, i) => ({
      id: `U${String(n)}${i}0000000`,
      name: `filler${n}${i}`,
      is_bot: false,
    }));
    return n < pages
      ? { ok: true, members, response_metadata: { next_cursor: `page${n + 1}` } }
      : { ok: true, members, response_metadata: { next_cursor: `page${n + 1}` } };
  };
}

// ---------------------------------------------------------------------------
// scopes — the part that is not guessable from the channel tools
// ---------------------------------------------------------------------------

test('a missing scope is reported WITH the scope Slack named', async () => {
  // `{"error":"missing_scope","needed":"users:read.email"}` — "missing_scope"
  // alone leaves an operator guessing between five different DM scopes.
  const stub = stubFetch({
    'users.lookupByEmail': { ok: false, error: 'missing_scope', needed: 'users:read.email' },
  });
  try {
    await assert.rejects(
      () => lookupUserByEmail(BASE, HEADERS, 'tadas@example.com'),
      /users:read\.email/
    );
  } finally {
    stub.restore();
  }
});

test('an email nobody has is null, not an error — a scope problem is the error', async () => {
  const stub = stubFetch({ 'users.lookupByEmail': { ok: false, error: 'users_not_found' } });
  try {
    assert.equal(await lookupUserByEmail(BASE, HEADERS, 'nobody@example.com'), null);
  } finally {
    stub.restore();
  }
});

test('an HTTP failure is reported as one, not as a Slack error', async () => {
  // Slack answers its own errors with HTTP 200 and {ok:false}. A 503 is the
  // network, and the message has to say so or an operator hunts for a scope.
  const stub = stubFetch({ 'users.list': { __http: 503 } });
  try {
    await assert.rejects(() => listUsers(BASE, HEADERS), /503/);
  } finally {
    stub.restore();
  }
});

test('with im:write present, openDm opens and never scans', async () => {
  // The other side of the fallback, and the reason adding the scope needs no
  // code change: a successful conversations.open returns immediately, so the
  // scan that exists for the scope-less token simply stops happening.
  const stub = stubFetch({
    'conversations.open': { ok: true, channel: { id: 'D0NEWLYOPENED' } },
  });
  try {
    const result = await openDm(BASE, HEADERS, 'U0NEVERMET');
    assert.deepEqual(result, { channelId: 'D0NEWLYOPENED', via: 'conversations.open' });
    assert.deepEqual(stub.requests[0].body, { users: 'U0NEVERMET' });
    assert.equal(stub.requests.length, 1, 'nothing else should be called');
  } finally {
    stub.restore();
  }
});

test('openDm falls back to an existing DM when it may not open one', async () => {
  // The real shape of the deployed token: chat:write and im:read, no im:write.
  // Refusing to send there would refuse work the token can plainly do.
  const stub = stubFetch({
    'conversations.open': { ok: false, error: 'missing_scope', needed: 'im:write' },
    'conversations.list': {
      ok: true,
      channels: [
        { id: 'D056EF7GHIJ', user: 'USLACKBOT', created: 1783890249 },
        { id: 'D034CD5EFGH', user: TADAS.id, created: 1783890249, updated: 1786500743223 },
      ],
    },
  });
  try {
    const result = await openDm(BASE, HEADERS, TADAS.id);
    assert.deepEqual(result, { channelId: 'D034CD5EFGH', via: 'conversations.list' });
    assert.match(stub.requests[1].url, /types=im\b/);
  } finally {
    stub.restore();
  }
});

test('every refusal to OPEN falls back, not just a missing scope', async () => {
  // A restricted install answers restricted_action / not_allowed_token_type for
  // the same situation: cannot open, may still post into an existing DM.
  for (const error of ['not_allowed_token_type', 'restricted_action']) {
    const stub = stubFetch({
      'conversations.open': { ok: false, error },
      'conversations.list': {
        ok: true,
        channels: [{ id: 'D034CD5EFGH', user: TADAS.id, created: 1783890249 }],
      },
    });
    try {
      assert.equal((await openDm(BASE, HEADERS, TADAS.id)).channelId, 'D034CD5EFGH', error);
    } finally {
      stub.restore();
    }
  }
});

test('with no way to open and no existing DM, the error repeats the scope Slack named', async () => {
  const stub = stubFetch({
    'conversations.open': { ok: false, error: 'missing_scope', needed: 'im:write' },
    'conversations.list': { ok: true, channels: [] },
  });
  try {
    await assert.rejects(
      () => openDm(BASE, HEADERS, 'U0NEVERMET'),
      (error) => {
        assert.match(error.message, /im:write/);
        // The scan cannot conjure a first conversation, and the caller needs to
        // know that "have them DM the bot once" also fixes it.
        assert.match(error.message, /DM the bot once/);
        return true;
      }
    );
  } finally {
    stub.restore();
  }
});

test('a non-scope failure is not retried as a scan', async () => {
  const stub = stubFetch({ 'conversations.open': { ok: false, error: 'user_not_found' } });
  try {
    await assert.rejects(() => openDm(BASE, HEADERS, 'U0BOGUS12'), /user_not_found/);
    assert.equal(stub.requests.length, 1);
  } finally {
    stub.restore();
  }
});

test('group DMs are opt-in, because mpim:read fails the whole listing', async () => {
  const stub = stubFetch({ 'conversations.list': { ok: true, channels: [] } });
  try {
    await listDmChannels(BASE, HEADERS);
    await listDmChannels(BASE, HEADERS, { includeGroupDms: true });
    assert.match(stub.requests[0].url, /types=im&/);
    assert.match(stub.requests[1].url, /types=im%2Cmpim/);
  } finally {
    stub.restore();
  }
});

test('findDmChannel opens nothing — the read-only tier depends on it', async () => {
  const stub = stubFetch({
    'conversations.list': {
      ok: true,
      channels: [{ id: 'D034CD5EFGH', user: TADAS.id, created: 1783890249 }],
    },
  });
  try {
    assert.equal(await findDmChannel(BASE, HEADERS, TADAS.id), 'D034CD5EFGH');
    assert.equal(await findDmChannel(BASE, HEADERS, 'U0NEVERMET'), null);
    assert.ok(!stub.requests.some((r) => r.path === 'conversations.open'));
  } finally {
    stub.restore();
  }
});

// ---------------------------------------------------------------------------
// page caps — "I stopped looking" is not "it isn't there"
// ---------------------------------------------------------------------------

test('the DM listing pages, and says when it stopped early', async () => {
  const stub = stubFetch({
    'conversations.list': (n) => ({
      ok: true,
      channels: [{ id: `D${n}`, user: `U${n}`, created: 1783890249 }],
      // Never stops offering a next page: the cap is what must end this.
      response_metadata: { next_cursor: `page${n + 1}` },
    }),
  });
  try {
    const { channels, truncated } = await listDmChannels(BASE, HEADERS, { maxPages: 3 });
    assert.equal(channels.length, 3);
    assert.equal(truncated, true);
    assert.match(stub.requests[1].url, /cursor=page2/);
  } finally {
    stub.restore();
  }
});

test('a truncated DM scan that found nothing THROWS rather than reporting "none"', async () => {
  // The whole point: a read tool that says "no conversation exists" when it
  // simply stopped reading is worse than one that admits it does not know.
  const stub = stubFetch({
    'conversations.list': (n) => ({
      ok: true,
      channels: [{ id: `D${n}`, user: `U${n}`, created: 1783890249 }],
      response_metadata: { next_cursor: `page${n + 1}` },
    }),
  });
  try {
    await assert.rejects(() => findDmChannel(BASE, HEADERS, 'U0NEVERMET'), /cut off/);
  } finally {
    stub.restore();
  }
});

test('a truncated directory refuses a non-exact resolution', async () => {
  const client = fakeClient({
    findUsers: search([{ user: TADAS, rank: 1, field: 'handle' }], true),
  });
  await assert.rejects(() => resolveUser(client, 'tada'), (error) => {
    assert.ok(error instanceof UserResolutionError);
    assert.match(error.message, /page cap/);
    return true;
  });
});

test('a truncated directory still allows an EXACT match — handles are unique', async () => {
  const client = fakeClient({
    findUsers: search([{ user: TADAS, rank: 0, field: 'handle' }], true),
  });
  assert.equal((await resolveUser(client, 'tadas')).id, TADAS.id);
});

test('slack_find_user says out loud that it did not read the whole directory', async () => {
  const client = fakeClient({
    findUsers: search([{ user: TADAS, rank: 2, field: 'real_name' }], true),
  });
  const result = await findUserTool(null, () => client).handler({ query: 'ant' });
  assert.match(result.content[0].text, /larger than this tool reads/);
});

test('deactivated accounts are dropped from the directory — they cannot receive a DM', async () => {
  const stub = stubFetch({
    'users.list': { ok: true, members: [TADAS, { ...JULIE, deleted: true }] },
  });
  try {
    const { users, truncated } = await listUsers(BASE, HEADERS);
    assert.deepEqual(users.map((u) => u.id), [TADAS.id]);
    assert.equal(truncated, false);
  } finally {
    stub.restore();
  }
});

test('the directory is paged through', async () => {
  const stub = stubFetch({
    'users.list': (n) =>
      n === 1
        ? { ok: true, members: [TADAS], response_metadata: { next_cursor: 'page2' } }
        : { ok: true, members: [JULIE] },
  });
  try {
    const { users, truncated } = await listUsers(BASE, HEADERS);
    assert.equal(users.length, 2);
    assert.equal(truncated, false);
    assert.match(stub.requests[1].url, /cursor=page2/);
  } finally {
    stub.restore();
  }
});

test('the directory scan reports its own cap', async () => {
  const stub = stubFetch({ 'users.list': directoryPages(99) });
  try {
    const { truncated } = await listUsers(BASE, HEADERS, { maxPages: 2 });
    assert.equal(truncated, true);
  } finally {
    stub.restore();
  }
});

// ---------------------------------------------------------------------------
// user search — WHICH field matched is half the ranking
// ---------------------------------------------------------------------------

test('user search ranks exact over prefix over substring', async () => {
  const stub = stubFetch({
    'users.list': {
      ok: true,
      members: [
        { ...JULIE, name: 'notadasatall', real_name: 'Not Tadas At All' },
        TADAS,
        { ...TADAS_TWIN, profile: { display_name: 'tadas.a' } },
      ],
    },
  });
  try {
    const { matches } = await findUsers(BASE, HEADERS, '@Tadas');
    assert.deepEqual(matches.map((m) => m.user.id), [TADAS.id, TADAS_TWIN.id, JULIE.id]);
    assert.deepEqual(matches.map((m) => m.rank), [0, 1, 2]);
    assert.equal(matches[0].field, 'handle');
  } finally {
    stub.restore();
  }
});

test('a prefix on a weak field does not beat an exact hit on a strong one', async () => {
  const stub = stubFetch({
    'users.list': {
      ok: true,
      members: [
        { id: 'UBOT0000001', name: 'annoy-bot', is_bot: true },
        { id: 'UJOANNA0001', name: 'joanna', real_name: 'Ann Smith', is_bot: false },
      ],
    },
  });
  try {
    const { matches } = await findUsers(BASE, HEADERS, 'ann');
    // annoy-bot is a PREFIX on handle; Ann Smith is EXACT on nothing but a
    // prefix on real_name. Rank ties, so the field decides — handle first.
    assert.equal(matches[0].user.id, 'UBOT0000001');
    assert.deepEqual(matches.map((m) => m.field), ['handle', 'real_name']);
  } finally {
    stub.restore();
  }
});

test('resolving over the REAL search refuses the bot-beats-human case', async () => {
  // Driven through findUsers rather than hand-built matches: the bug this
  // guards against lived in the comparison between two users, not inside one.
  const stub = stubFetch({
    'users.list': {
      ok: true,
      members: [
        { id: 'UBOT0000001', name: 'annoy-bot', is_bot: true },
        { id: 'UJOANNA0001', name: 'joanna', real_name: 'Ann Smith', is_bot: false },
      ],
    },
  });
  const client = {
    findUsers: async (q) => findUsers(BASE, HEADERS, q),
  };
  try {
    await assert.rejects(() => resolveUser(client, 'ann'), (error) => {
      assert.match(error.message, /UBOT0000001/);
      assert.match(error.message, /UJOANNA0001/);
      return true;
    });
  } finally {
    stub.restore();
  }
});

// ---------------------------------------------------------------------------
// resolving a recipient — the refusal is the feature
// ---------------------------------------------------------------------------

test('a user ID is used as given, and confirmed with a name', async () => {
  const client = fakeClient();
  const resolved = await resolveUser(client, 'U012AB3CDEF');
  assert.equal(resolved.id, 'U012AB3CDEF');
  assert.match(resolved.label, /Tadas Antanavicius \(@tadas, U012AB3CDEF\)/);
  assert.equal(called(client, 'findUsers').length, 0);
});

test('an enterprise-grid W… id is an id too', async () => {
  const client = fakeClient({ getUser: async () => ({ ...TADAS, id: 'W012AB3CDEF' }) });
  const resolved = await resolveUser(client, 'W012AB3CDEF');
  assert.equal(resolved.id, 'W012AB3CDEF');
  assert.equal(called(client, 'findUsers').length, 0);
});

test('a short name starting with U or W is a NAME, not an id', async () => {
  // "will", "wes", "una" all match a loose id pattern. Taking them as ids
  // fabricates a user, skips the directory entirely, and fails at the send with
  // an error naming nothing the caller typed.
  for (const name of ['will', 'wes', 'una', 'Wanda', 'ubuntu']) {
    const client = fakeClient({ findUsers: search([{ user: TADAS, rank: 0, field: 'handle' }]) });
    await resolveUser(client, name);
    assert.equal(called(client, 'findUsers').length, 1, `${name} must go to the directory`);
    assert.equal(called(client, 'getUser').length, 0, `${name} must not be treated as an id`);
  }
});

test('an id Slack does not know is refused, not passed on', async () => {
  const client = fakeClient({
    getUser: async () => {
      throw new Error('Slack API error on users.info: user_not_found');
    },
  });
  await assert.rejects(() => resolveUser(client, 'U0BOGUS1234'), (error) => {
    assert.ok(error instanceof UserResolutionError);
    assert.match(error.message, /No workspace member has the ID/);
    return true;
  });
});

test('an unreadable directory does not block a send, but the label says so', async () => {
  const client = fakeClient({
    getUser: async () => {
      throw new Error('Slack API error on users.info: missing_scope — needs users:read');
    },
  });
  const resolved = await resolveUser(client, 'U012AB3CDEF');
  assert.equal(resolved.id, 'U012AB3CDEF');
  assert.equal(resolved.user, undefined);
  assert.match(resolved.label, /UNVERIFIED/);
});

test('a deactivated account is refused by ID and by email', async () => {
  // users.list drops them; users.info and users.lookupByEmail do NOT, and both
  // of those are resolution paths.
  const byId = fakeClient({ getUser: async () => ({ ...JULIE, deleted: true }) });
  await assert.rejects(() => resolveUser(byId, 'U045GH6IJKL'), /deactivated/);

  const byEmail = fakeClient({ lookupUserByEmail: async () => ({ ...JULIE, deleted: true }) });
  await assert.rejects(() => resolveUser(byEmail, 'julie@example.com'), /deactivated/);
});

test('an email goes to lookupByEmail, never to a directory scan', async () => {
  const client = fakeClient({ lookupUserByEmail: async () => JULIE });
  const resolved = await resolveUser(client, 'julie@example.com');
  assert.equal(resolved.id, JULIE.id);
  assert.equal(called(client, 'findUsers').length, 0);
});

test('an email nobody has points at the search tool instead', async () => {
  const client = fakeClient({ lookupUserByEmail: async () => null });
  await assert.rejects(() => resolveUser(client, 'ghost@example.com'), (error) => {
    assert.ok(error instanceof UserResolutionError);
    assert.match(error.message, /slack_find_user/);
    return true;
  });
});

test('an ambiguous name is refused, with both candidates and their IDs', async () => {
  const client = fakeClient({
    findUsers: search([
      { user: TADAS, rank: 0, field: 'display_name' },
      { user: TADAS_TWIN, rank: 0, field: 'display_name' },
    ]),
  });
  await assert.rejects(() => resolveUser(client, 'tadas'), (error) => {
    assert.match(error.message, /matches 2 workspace members/);
    assert.match(error.message, new RegExp(TADAS.id));
    assert.match(error.message, new RegExp(TADAS_TWIN.id));
    return true;
  });
});

test('a better match on a stronger field wins outright', async () => {
  const client = fakeClient({
    findUsers: search([
      { user: TADAS, rank: 0, field: 'handle' },
      { user: TADAS_TWIN, rank: 0, field: 'real_name' },
    ]),
  });
  assert.equal((await resolveUser(client, 'tadas')).id, TADAS.id);
});

test('a non-exact win over an equally close rival is refused, whatever it matched on', async () => {
  // The field tie-break exists to ORDER results; it must not settle a contest
  // between two coincidences. "ann" prefixes `annoy-bot` and "Ann Smith" alike.
  for (const rank of [1, 2]) {
    const client = fakeClient({
      findUsers: search([
        { user: TADAS, rank, field: 'handle' },
        { user: JULIE, rank, field: 'real_name' },
      ]),
    });
    await assert.rejects(() => resolveUser(client, 'a'), /matches 2 workspace members equally well/);
  }
});

test('a lone substring match is allowed — nothing else claims the name', async () => {
  const client = fakeClient({ findUsers: search([{ user: TADAS, rank: 2, field: 'real_name' }]) });
  assert.equal((await resolveUser(client, 'antanav')).id, TADAS.id);
});

test('no match at all says so', async () => {
  const client = fakeClient({ findUsers: search([]) });
  await assert.rejects(() => resolveUser(client, 'nobody'), /No workspace member matches/);
});

test('a label carries the id, so a caller can pin the next call', () => {
  assert.equal(userLabel(TADAS), 'Tadas Antanavicius (@tadas, U012AB3CDEF)');
  assert.match(userLabel({ id: 'U9', name: 'ci', is_bot: true }), /\[bot\]$/);
});

// ---------------------------------------------------------------------------
// slack_send_dm
// ---------------------------------------------------------------------------

test('slack_send_dm resolves, opens and posts in one call', async () => {
  const client = fakeClient();
  const tool = sendDmTool(null, () => client);

  const result = await tool.handler({ user: '@tadas', text: 'Please re-auth at /quotas.' });

  assert.notEqual(result.isError, true);
  assert.deepEqual(called(client, 'openDm')[0].args, [TADAS.id]);
  assert.deepEqual(called(client, 'postMessage')[0].args, [
    'D034CD5EFGH',
    'Please re-auth at /quotas.',
  ]);

  const text = result.content[0].text;
  // Who it went to, in a form a human can check, and the ids to keep talking.
  assert.match(text, /Tadas Antanavicius \(@tadas, U012AB3CDEF\)/);
  assert.match(text, /D034CD5EFGH/);
  assert.match(text, /1700000000\.000100/);
  assert.match(text, /slack_reply_to_thread/);
});

test('slack_send_dm carries the unverified warning into its result', async () => {
  // The description tells the agent to CHECK who it went to. When the directory
  // could not confirm the id, the result has to say that rather than echo it.
  const client = fakeClient({
    getUser: async () => {
      throw new Error('missing_scope — needs users:read');
    },
  });
  const result = await sendDmTool(null, () => client).handler({
    user: 'U012AB3CDEF',
    text: 'hi',
  });
  assert.match(result.content[0].text, /UNVERIFIED/);
});

test('slack_send_dm sends the caller text UNCHANGED and warns about mrkdwn', async () => {
  // A DM is mrkdwn too, and the fork's promise — advise, never rewrite — holds
  // here exactly as it does for a channel post.
  const client = fakeClient();
  const tool = sendDmTool(null, () => client);
  const text = 'the fare is ~750 som and ~$9';

  const result = await tool.handler({ user: 'U012AB3CDEF', text });

  assert.equal(called(client, 'postMessage')[0].args[1], text);
  assert.match(result.content[0].text, /Slack mrkdwn warning/);
  assert.match(result.content[0].text, /slack_update_message/);
});

test('slack_send_dm sends NOTHING when the recipient is ambiguous', async () => {
  const client = fakeClient({
    findUsers: search([
      { user: TADAS, rank: 0, field: 'display_name' },
      { user: TADAS_TWIN, rank: 0, field: 'display_name' },
    ]),
  });
  const tool = sendDmTool(null, () => client);

  const result = await tool.handler({ user: 'tadas', text: 'secret' });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /matches 2 workspace members/);
  assert.equal(called(client, 'openDm').length, 0);
  assert.equal(called(client, 'postMessage').length, 0);
});

test('slack_send_dm reports a scope failure verbatim rather than as "unknown error"', async () => {
  const client = fakeClient({
    openDm: async () => {
      throw new Error(
        'Cannot open a DM with U012AB3CDEF: conversations.open was refused (missing_scope, needs "im:write")'
      );
    },
  });
  const result = await sendDmTool(null, () => client).handler({ user: 'U012AB3CDEF', text: 'hi' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /im:write/);
  assert.equal(called(client, 'postMessage').length, 0);
});

// ---------------------------------------------------------------------------
// slack_get_dm / slack_get_dms / slack_find_user
// ---------------------------------------------------------------------------

test('slack_get_dm reads the conversation without opening one', async () => {
  const client = fakeClient({
    getMessages: async () => ({
      messages: [
        {
          type: 'message',
          user: TADAS.id,
          text: 'Can you work in DMs?',
          ts: '1700000003.000400',
        },
      ],
      hasMore: false,
    }),
  });

  const result = await getDmTool(null, () => client).handler({ user: '@tadas' });

  assert.notEqual(result.isError, true);
  assert.match(result.content[0].text, /Can you work in DMs\?/);
  assert.match(result.content[0].text, /D034CD5EFGH/);
  assert.equal(called(client, 'openDm').length, 0);
});

test('slack_get_dm with nobody to read reports that, and still opens nothing', async () => {
  const client = fakeClient({ findDmChannel: async () => null });
  const result = await getDmTool(null, () => client).handler({ user: '@tadas' });
  assert.notEqual(result.isError, true);
  assert.match(result.content[0].text, /No DM conversation with .* exists yet/);
  assert.match(result.content[0].text, /slack_send_dm/);
  assert.equal(called(client, 'getMessages').length, 0);
  assert.equal(called(client, 'openDm').length, 0);
});

test('slack_get_dm surfaces a cut-off scan as an error, not as "no conversation"', async () => {
  const client = fakeClient({
    findDmChannel: async () => {
      throw new Error('Could not tell whether a DM with U012AB3CDEF exists: … cut off …');
    },
  });
  const result = await getDmTool(null, () => client).handler({ user: '@tadas' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /cut off/);
});

test('slack_get_dm takes a channel id directly, skipping the lookup', async () => {
  const client = fakeClient();
  const result = await getDmTool(null, () => client).handler({ channel_id: 'D034CD5EFGH' });
  assert.notEqual(result.isError, true);
  assert.equal(called(client, 'findDmChannel').length, 0);
  assert.deepEqual(called(client, 'getMessages')[0].args[0], 'D034CD5EFGH');
});

test('slack_get_dm refuses both, and neither', async () => {
  const client = fakeClient();
  const tool = getDmTool(null, () => client);

  for (const args of [{}, { user: '@tadas', channel_id: 'D034CD5EFGH' }]) {
    const result = await tool.handler(args);
    assert.equal(result.isError, true, JSON.stringify(args));
    assert.match(result.content[0].text, /exactly one of user .* or channel_id/);
  }
});

test('slack_get_dms lists conversations with names and ids', async () => {
  const client = createIntegrationMockSlackClient();
  const result = await getDmsTool(null, () => client).handler({});
  assert.match(result.content[0].text, /Tadas Antanavicius \(@tadas, U012AB3CDEF\)/);
  assert.match(result.content[0].text, /DM channel: D034CD5EFGH/);
});

test('slack_get_dms labels a creation date as one', async () => {
  // Slack returns `updated` on a DM but does not document it. Printing a
  // creation time under "Last activity" would be a claim the data cannot back.
  const client = fakeClient({
    getDms: async () => ({
      dms: [
        { id: 'D_NOUPD', isGroup: false, userId: 'U1', created: 1783890249, isUserDeleted: false },
        {
          id: 'D_UPD',
          isGroup: false,
          userId: 'U2',
          created: 1783890249,
          updated: 1786500743223,
          isUserDeleted: false,
        },
      ],
      truncated: false,
    }),
  });
  const text = (await getDmsTool(null, () => client).handler({})).content[0].text;
  assert.match(text, /Conversation created: 2026-07-12/);
  assert.match(text, /Last activity: 2026-08-12/);
});

test('slack_get_dms flags a group DM and a deactivated member', async () => {
  const client = fakeClient({
    getDms: async () => ({
      dms: [
        { id: 'D_G', isGroup: true, name: 'mpdm-tadas--julie-1', created: 1, isUserDeleted: false },
        { id: 'D_X', isGroup: false, userId: 'U9', created: 1, isUserDeleted: true },
      ],
      truncated: true,
    }),
  });
  const text = (await getDmsTool(null, () => client).handler({})).content[0].text;
  assert.match(text, /group DM \(mpdm-tadas--julie-1\) \[group\]/);
  assert.match(text, /\[member deactivated\]/);
  assert.match(text, /More DM conversations exist/);
});

test('slack_get_dms defaults to one-to-one and passes its options through', async () => {
  const client = fakeClient();
  const tool = getDmsTool(null, () => client);

  await tool.handler({});
  assert.deepEqual(called(client, 'getDms')[0].args[0], { includeGroupDms: false, limit: 50 });

  await tool.handler({ include_group_dms: true, limit: 5 });
  assert.deepEqual(called(client, 'getDms')[1].args[0], { includeGroupDms: true, limit: 5 });
});

test('the DM listing sorts most recent first and slices to the limit', async () => {
  const stub = stubFetch({
    'conversations.list': {
      ok: true,
      channels: [
        { id: 'D_OLD', user: 'U1', created: 1783890249, updated: 1783890249211 },
        { id: 'D_NEW', user: 'U2', created: 1783890249, updated: 1786500743223 },
      ],
    },
    'users.list': { ok: true, members: [] },
  });
  try {
    const { dms } = await getDms(BASE, HEADERS);
    assert.deepEqual(dms.map((d) => d.id), ['D_NEW', 'D_OLD']);
    assert.deepEqual((await getDms(BASE, HEADERS, { limit: 1 })).dms.map((d) => d.id), ['D_NEW']);
  } finally {
    stub.restore();
  }
});

test('a DM list survives a directory the token cannot read', async () => {
  // im:read without users:read. Ids still address a DM; names are a nicety.
  const stub = stubFetch({
    'conversations.list': {
      ok: true,
      channels: [{ id: 'D034CD5EFGH', user: TADAS.id, created: 1783890249 }],
    },
    'users.list': { ok: false, error: 'missing_scope', needed: 'users:read' },
  });
  try {
    const { dms } = await getDms(BASE, HEADERS);
    assert.equal(dms.length, 1);
    assert.equal(dms[0].id, 'D034CD5EFGH');
    assert.equal(dms[0].user, undefined);
  } finally {
    stub.restore();
  }
});

test('slack_get_dms with nothing to show says how to start one', async () => {
  const result = await getDmsTool(null, () => fakeClient()).handler({});
  assert.notEqual(result.isError, true);
  assert.match(result.content[0].text, /slack_send_dm/);
});

test('slack_find_user reports WHY each candidate matched', async () => {
  const client = fakeClient({
    findUsers: search([
      { user: TADAS, rank: 0, field: 'handle' },
      { user: TADAS_TWIN, rank: 2, field: 'real_name' },
    ]),
  });
  const result = await findUserTool(null, () => client).handler({ query: 'tadas' });
  assert.match(result.content[0].text, /exact on handle/);
  assert.match(result.content[0].text, /contains on real_name/);
  assert.match(result.content[0].text, /slack_send_dm/);
});

test('slack_find_user answers an email in one call, not a directory scan', async () => {
  const client = fakeClient({ lookupUserByEmail: async () => JULIE });
  const result = await findUserTool(null, () => client).handler({ query: 'julie@example.com' });
  assert.match(result.content[0].text, /Julie Doe \(@julie, U045GH6IJKL\)/);
  assert.equal(called(client, 'findUsers').length, 0);
});

test('slack_find_user finding nobody is an answer, not an error', async () => {
  const client = fakeClient({ findUsers: search([]) });
  const result = await findUserTool(null, () => client).handler({ query: 'nobody' });
  assert.notEqual(result.isError, true);
  assert.match(result.content[0].text, /No workspace member matches/);
});

// ---------------------------------------------------------------------------
// the tier split
// ---------------------------------------------------------------------------

async function registeredNames(groups) {
  let listed = null;
  const fakeServer = {
    setRequestHandler(schema, handler) {
      if (schema === ListToolsRequestSchema) listed = handler;
    },
  };
  createRegisterTools(() => ({}), groups)(fakeServer);
  const { tools } = await listed();
  return tools.map((t) => t.name).sort();
}

test('the read-only tier is exactly these eight, and slack_send_dm is not one', async () => {
  // `slack-readonly` carves its allow-list out of this group, and every read
  // path here was built to justify it: slack_get_dm resolves an EXISTING DM
  // rather than calling conversations.open, which would create one.
  assert.deepEqual(await registeredNames(['readonly']), [
    'slack_download_file',
    'slack_events_status',
    'slack_find_user',
    'slack_get_channel',
    'slack_get_channels',
    'slack_get_dm',
    'slack_get_dms',
    'slack_get_thread',
  ]);

  assert.ok((await registeredNames(['write'])).includes('slack_send_dm'));
});

test('every DM tool describes itself for an agent that has never seen it', async () => {
  for (const factory of [sendDmTool, getDmTool, getDmsTool, findUserTool]) {
    const tool = factory(null, () => ({}));
    assert.match(tool.description, /\*\*Returns:\*\*/, `${tool.name} must say what it returns`);
    assert.match(tool.description, /\*\*Use cases:\*\*/, `${tool.name} must give use cases`);
    for (const [param, schema] of Object.entries(tool.inputSchema.properties)) {
      assert.ok(schema.description?.length > 40, `${tool.name}.${param} needs a real description`);
    }
  }
});
