// The DM surface: four tools that make a direct message a first-class
// conversation rather than a channel id somebody had to already know.
//
// Two things here are load-bearing and neither is obvious from the Slack docs:
//
//   1. A DM is gated on scopes the channel tools never touch. `im:write` opens
//      one, `im:read` lists them, `mpim:read` is a SECOND scope for group DMs
//      that fails the whole listing when absent, and `users:read` /
//      `users:read.email` are what turn a name into an id. A missing one comes
//      back as `missing_scope` with the needed scope in a field nobody reads.
//   2. Naming a recipient is ambiguous by nature. "tadas" can be two people, and
//      the failure mode of guessing is a private message delivered to the wrong
//      human — which no advisory can walk back.
//
// So: the fallback path is pinned, the scope is pinned into the error text, and
// ambiguity is pinned as a refusal that sends nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { createRegisterTools } from '../build/tools.js';
import { sendDmTool } from '../build/tools/send-dm.js';
import { getDmTool } from '../build/tools/get-dm.js';
import { getDmsTool } from '../build/tools/get-dms.js';
import { findUserTool } from '../build/tools/find-user.js';
import { resolveUser, userLabel, UserResolutionError } from '../build/tools/resolve-user.js';
import { openDm, findDmChannel } from '../build/slack-client/lib/open-dm.js';
import { getDms, listDmChannels } from '../build/slack-client/lib/get-dms.js';
import { findUsers } from '../build/slack-client/lib/find-users.js';
import { listUsers } from '../build/slack-client/lib/list-users.js';
import { lookupUserByEmail } from '../build/slack-client/lib/lookup-user-by-email.js';
import { createIntegrationMockSlackClient } from '../build/slack-client/slack-client.integration-mock.js';

const TADAS = {
  id: 'U0BFTSUN8MD',
  name: 'tadas',
  real_name: 'Tadas Antanavicius',
  is_bot: false,
  profile: { display_name: 'tadas', real_name: 'Tadas Antanavicius' },
};

const TADAS_TWIN = {
  id: 'U0BFTSUN8ZZ',
  name: 'tadas.a',
  real_name: 'Tadas Antanavicius (personal)',
  is_bot: false,
  profile: { display_name: 'tadas', real_name: 'Tadas Antanavicius (personal)' },
};

const JULIE = {
  id: 'U0BGU04U6F6',
  name: 'julie',
  real_name: 'juliehazz',
  is_bot: false,
  profile: { display_name: 'juliehazz', real_name: 'juliehazz', email: 'julie@example.com' },
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

  return {
    calls,
    getUser: record('getUser', overrides.getUser ?? (async () => TADAS)),
    findUsers: record('findUsers', overrides.findUsers ?? (async () => [{ user: TADAS, rank: 0, field: 'handle' }])),
    lookupUserByEmail: record('lookupUserByEmail', overrides.lookupUserByEmail ?? (async () => null)),
    openDm: record('openDm', overrides.openDm ?? (async () => ({ channelId: 'D0BGVRZRX4Z', via: 'conversations.open' }))),
    findDmChannel: record('findDmChannel', overrides.findDmChannel ?? (async () => 'D0BGVRZRX4Z')),
    getDms: record('getDms', overrides.getDms ?? (async () => [])),
    getMessages: record('getMessages', overrides.getMessages ?? (async () => ({ messages: [], hasMore: false }))),
    postMessage: record('postMessage', overrides.postMessage ?? (async () => ({ ts: '1786453389.428549' }))),
  };
}

const called = (client, name) => client.calls.filter((c) => c.name === name);

/** A `fetch` stub that answers Slack Web API paths from a table. */
function stubFetch(routes) {
  const requests = [];
  const original = globalThis.fetch;

  globalThis.fetch = async (url, init) => {
    const path = new URL(url).pathname.replace('/api/', '');
    requests.push({ url: String(url), path, body: init?.body ? JSON.parse(init.body) : undefined });
    const answer = routes[path];
    assert.ok(answer, `unexpected call to ${path}`);
    const payload = typeof answer === 'function' ? answer(requests.length) : answer;
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
    await assert.rejects(() => lookupUserByEmail(BASE, HEADERS, 'tadas@example.com'), /users:read\.email/);
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

test('openDm falls back to an existing DM when im:write is absent', async () => {
  // The real shape of the deployed token: chat:write and im:read, no im:write.
  // Refusing to send there would refuse work the token can plainly do.
  const stub = stubFetch({
    'conversations.open': { ok: false, error: 'missing_scope', needed: 'im:write' },
    'conversations.list': {
      ok: true,
      channels: [
        { id: 'D0BGQKN0WCV', user: 'USLACKBOT', created: 1783890249 },
        { id: 'D0BGVRZRX4Z', user: TADAS.id, created: 1783890249, updated: 1786500743223 },
      ],
    },
  });
  try {
    const result = await openDm(BASE, HEADERS, TADAS.id);
    assert.deepEqual(result, { channelId: 'D0BGVRZRX4Z', via: 'conversations.list' });
    assert.match(stub.requests[1].url, /types=im\b/);
  } finally {
    stub.restore();
  }
});

test('with no im:write and no existing DM, the error names the scope and the other way out', async () => {
  const stub = stubFetch({
    'conversations.open': { ok: false, error: 'missing_scope', needed: 'im:write' },
    'conversations.list': { ok: true, channels: [] },
  });
  try {
    await assert.rejects(() => openDm(BASE, HEADERS, 'U0NEVERMET'), (error) => {
      assert.match(error.message, /im:write/);
      // The scan cannot conjure a first conversation, and the caller needs to
      // know that "have them DM the bot once" also fixes it.
      assert.match(error.message, /DM the bot once/);
      return true;
    });
  } finally {
    stub.restore();
  }
});

test('a non-scope failure is not retried as a scan', async () => {
  const stub = stubFetch({ 'conversations.open': { ok: false, error: 'user_not_found' } });
  try {
    await assert.rejects(() => openDm(BASE, HEADERS, 'U0BOGUS'), /user_not_found/);
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
      channels: [{ id: 'D0BGVRZRX4Z', user: TADAS.id, created: 1783890249 }],
    },
  });
  try {
    assert.equal(await findDmChannel(BASE, HEADERS, TADAS.id), 'D0BGVRZRX4Z');
    assert.equal(await findDmChannel(BASE, HEADERS, 'U0NEVERMET'), null);
    assert.ok(!stub.requests.some((r) => r.path === 'conversations.open'));
  } finally {
    stub.restore();
  }
});

test('a DM list survives a directory the token cannot read', async () => {
  // im:read without users:read. Ids still address a DM; names are a nicety.
  const stub = stubFetch({
    'conversations.list': {
      ok: true,
      channels: [{ id: 'D0BGVRZRX4Z', user: TADAS.id, created: 1783890249 }],
    },
    'users.list': { ok: false, error: 'missing_scope', needed: 'users:read' },
  });
  try {
    const dms = await getDms(BASE, HEADERS);
    assert.equal(dms.length, 1);
    assert.equal(dms[0].id, 'D0BGVRZRX4Z');
    assert.equal(dms[0].user, undefined);
  } finally {
    stub.restore();
  }
});

test('DMs come back most recently active first', async () => {
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
    assert.deepEqual((await getDms(BASE, HEADERS)).map((d) => d.id), ['D_NEW', 'D_OLD']);
  } finally {
    stub.restore();
  }
});

test('deactivated accounts are dropped from the directory — they cannot receive a DM', async () => {
  const stub = stubFetch({
    'users.list': { ok: true, members: [TADAS, { ...JULIE, deleted: true }] },
  });
  try {
    assert.deepEqual((await listUsers(BASE, HEADERS)).map((u) => u.id), [TADAS.id]);
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
    assert.equal((await listUsers(BASE, HEADERS)).length, 2);
    assert.match(stub.requests[1].url, /cursor=page2/);
  } finally {
    stub.restore();
  }
});

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
    const matches = await findUsers(BASE, HEADERS, '@Tadas');
    assert.deepEqual(matches.map((m) => m.user.id), [TADAS.id, TADAS_TWIN.id, JULIE.id]);
    assert.deepEqual(matches.map((m) => m.rank), [0, 1, 2]);
    assert.equal(matches[0].field, 'handle');
  } finally {
    stub.restore();
  }
});

// ---------------------------------------------------------------------------
// resolving a recipient — the refusal is the feature
// ---------------------------------------------------------------------------

test('a user ID is used as given, and confirmed with a name', async () => {
  const client = fakeClient();
  const resolved = await resolveUser(client, 'u0bftsun8md');
  assert.equal(resolved.id, 'U0BFTSUN8MD');
  assert.match(resolved.label, /Tadas Antanavicius \(@tadas, U0BFTSUN8MD\)/);
  assert.equal(called(client, 'findUsers').length, 0);
});

test('an unreadable directory does not block a send to a known ID', async () => {
  const client = fakeClient({
    getUser: async () => {
      throw new Error('Slack API error on users.info: missing_scope — needs users:read');
    },
  });
  const resolved = await resolveUser(client, 'U0BFTSUN8MD');
  assert.deepEqual(resolved, { id: 'U0BFTSUN8MD', label: 'U0BFTSUN8MD' });
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
    findUsers: async () => [
      { user: TADAS, rank: 0, field: 'display_name' },
      { user: TADAS_TWIN, rank: 0, field: 'display_name' },
    ],
  });
  await assert.rejects(() => resolveUser(client, 'tadas'), (error) => {
    assert.match(error.message, /matches 2 workspace members/);
    assert.match(error.message, new RegExp(TADAS.id));
    assert.match(error.message, new RegExp(TADAS_TWIN.id));
    return true;
  });
});

test('a better match wins outright — ambiguity means TIED, not "more than one"', async () => {
  const client = fakeClient({
    findUsers: async () => [
      { user: TADAS, rank: 0, field: 'handle' },
      { user: TADAS_TWIN, rank: 2, field: 'real_name' },
    ],
  });
  assert.equal((await resolveUser(client, 'tadas')).id, TADAS.id);
});

test('no match at all says so', async () => {
  const client = fakeClient({ findUsers: async () => [] });
  await assert.rejects(() => resolveUser(client, 'nobody'), /No workspace member matches/);
});

test('a label carries the id, so a caller can pin the next call', () => {
  assert.equal(userLabel(TADAS), 'Tadas Antanavicius (@tadas, U0BFTSUN8MD)');
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
  assert.deepEqual(called(client, 'postMessage')[0].args, ['D0BGVRZRX4Z', 'Please re-auth at /quotas.']);

  const text = result.content[0].text;
  // Who it went to, in a form a human can check, and the ids to keep talking.
  assert.match(text, /Tadas Antanavicius \(@tadas, U0BFTSUN8MD\)/);
  assert.match(text, /D0BGVRZRX4Z/);
  assert.match(text, /1786453389\.428549/);
  assert.match(text, /slack_reply_to_thread/);
});

test('slack_send_dm sends the caller text UNCHANGED and warns about mrkdwn', async () => {
  // A DM is mrkdwn too, and the fork's promise — advise, never rewrite — holds
  // here exactly as it does for a channel post.
  const client = fakeClient();
  const tool = sendDmTool(null, () => client);
  const text = 'the fare is ~750 som and ~$9';

  const result = await tool.handler({ user: 'U0BFTSUN8MD', text });

  assert.equal(called(client, 'postMessage')[0].args[1], text);
  assert.match(result.content[0].text, /Slack mrkdwn warning/);
  assert.match(result.content[0].text, /slack_update_message/);
});

test('slack_send_dm sends NOTHING when the recipient is ambiguous', async () => {
  const client = fakeClient({
    findUsers: async () => [
      { user: TADAS, rank: 0, field: 'display_name' },
      { user: TADAS_TWIN, rank: 0, field: 'display_name' },
    ],
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
      throw new Error('Cannot open a DM with U0BFTSUN8MD: the bot token lacks the "im:write" scope');
    },
  });
  const result = await sendDmTool(null, () => client).handler({ user: 'U0BFTSUN8MD', text: 'hi' });
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
      messages: [{ type: 'message', user: TADAS.id, text: 'Can you work in DMs?', ts: '1785498097.604729' }],
      hasMore: false,
    }),
  });

  const result = await getDmTool(null, () => client).handler({ user: '@tadas' });

  assert.notEqual(result.isError, true);
  assert.match(result.content[0].text, /Can you work in DMs\?/);
  assert.match(result.content[0].text, /D0BGVRZRX4Z/);
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

test('slack_get_dm takes a channel id directly, skipping the lookup', async () => {
  const client = fakeClient();
  const result = await getDmTool(null, () => client).handler({ channel_id: 'D0BGVRZRX4Z' });
  assert.notEqual(result.isError, true);
  assert.equal(called(client, 'findDmChannel').length, 0);
  assert.deepEqual(called(client, 'getMessages')[0].args[0], 'D0BGVRZRX4Z');
});

test('slack_get_dm refuses both, and neither', async () => {
  const client = fakeClient();
  const tool = getDmTool(null, () => client);

  for (const args of [{}, { user: '@tadas', channel_id: 'D0BGVRZRX4Z' }]) {
    const result = await tool.handler(args);
    assert.equal(result.isError, true, JSON.stringify(args));
    assert.match(result.content[0].text, /exactly one of user .* or channel_id/);
  }
});

test('slack_get_dms lists conversations with names and ids', async () => {
  const client = createIntegrationMockSlackClient();
  const result = await getDmsTool(null, () => client).handler({});
  assert.match(result.content[0].text, /Tadas Antanavicius \(@tadas, U0BFTSUN8MD\)/);
  assert.match(result.content[0].text, /DM channel: D0BGVRZRX4Z/);
});

test('slack_get_dms defaults to one-to-one and passes the opt-in through', async () => {
  const client = fakeClient();
  const tool = getDmsTool(null, () => client);

  await tool.handler({});
  assert.equal(called(client, 'getDms')[0].args[0].includeGroupDms, false);

  await tool.handler({ include_group_dms: true });
  assert.equal(called(client, 'getDms')[1].args[0].includeGroupDms, true);
});

test('slack_get_dms with nothing to show says how to start one', async () => {
  const result = await getDmsTool(null, () => fakeClient()).handler({});
  assert.notEqual(result.isError, true);
  assert.match(result.content[0].text, /slack_send_dm/);
});

test('slack_find_user reports WHY each candidate matched', async () => {
  const client = fakeClient({
    findUsers: async () => [
      { user: TADAS, rank: 0, field: 'handle' },
      { user: TADAS_TWIN, rank: 2, field: 'real_name' },
    ],
  });
  const result = await findUserTool(null, () => client).handler({ query: 'tadas' });
  assert.match(result.content[0].text, /exact on handle/);
  assert.match(result.content[0].text, /contains on real_name/);
  assert.match(result.content[0].text, /slack_send_dm/);
});

test('slack_find_user answers an email in one call, not a directory scan', async () => {
  const client = fakeClient({ lookupUserByEmail: async () => JULIE });
  const result = await findUserTool(null, () => client).handler({ query: 'julie@example.com' });
  assert.match(result.content[0].text, /juliehazz \(@julie, U0BGU04U6F6\)/);
  assert.equal(called(client, 'findUsers').length, 0);
});

test('slack_find_user finding nobody is an answer, not an error', async () => {
  const client = fakeClient({ findUsers: async () => [] });
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

test('only slack_send_dm is a write tool — reading and searching are read-only', async () => {
  // `slack-readonly` carves its allow-list out of this group, and every read
  // path here was built to justify it: slack_get_dm resolves an EXISTING DM
  // rather than calling conversations.open, which would create one.
  const readonly = await registeredNames(['readonly']);
  assert.ok(readonly.includes('slack_get_dm'));
  assert.ok(readonly.includes('slack_get_dms'));
  assert.ok(readonly.includes('slack_find_user'));
  assert.ok(!readonly.includes('slack_send_dm'));

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
