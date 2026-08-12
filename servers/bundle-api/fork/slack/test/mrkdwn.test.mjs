// The strad fork delta: Slack mrkdwn is not Markdown, and the message that
// proved it posted successfully.
//
// These tests exist because the failure has no error in it. A `~` used as
// "approximately" strikes through everything up to the next `~`, `chat.postMessage`
// returns ok, and the tool reports success — so the only things that can catch it
// are the tool DESCRIPTION (before the send) and the tool RESULT (after it). Both
// are asserted here, and so is the promise that neither one rewrites the caller's
// text.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { lintMrkdwn, mrkdwnAdvisory, MRKDWN_TEXT_GUIDANCE } from '../build/mrkdwn.js';
import { postMessageTool } from '../build/tools/post-message.js';
import { replyToThreadTool } from '../build/tools/reply-to-thread.js';
import { updateMessageTool } from '../build/tools/update-message.js';
import { uploadSnippetTool } from '../build/tools/upload-snippet.js';
import { reactToMessageTool } from '../build/tools/react-to-message.js';
import { getChannelsTool } from '../build/tools/get-channels.js';
import { getChannelTool } from '../build/tools/get-channel.js';
import { getThreadTool } from '../build/tools/get-thread.js';
import { downloadFileTool } from '../build/tools/download-file.js';

// An abridged copy of the message that actually shipped struck through, in
// #general on 2026-08-11. Six tildes, every one of them meaning "approximately".
const INCIDENT = [
  'There is a direct Karakol → Kochkor marshrutka, ~750 som each (~$9), 4–5 hrs.',
  'Then Kochkor → Kyzart on arrival: shared taxi ~500 som pp, or 2000–3000 som (~$23–34)',
  'for the whole car. CBT quotes ~5000-7000 som for a 4x4; Naryn cars run ~800-1000/seat.',
].join('\n');

const rules = (text) => lintMrkdwn(text).map((f) => f.rule);

// ---------------------------------------------------------------------------
// the linter
// ---------------------------------------------------------------------------

test('the incident message reports strikethrough', () => {
  const findings = lintMrkdwn(INCIDENT);
  const strike = findings.find((f) => f.rule === 'strikethrough');
  assert.ok(strike, 'six tildes must be reported as strikethrough');
  // Six tildes pair off into three struck spans.
  assert.equal(strike.count, 3);
  assert.ok(
    strike.samples[0].includes('750 som'),
    `the first struck span should quote the text Slack ate, got ${strike.samples[0]}`
  );
});

test('a single unpaired tilde is not reported', () => {
  // One tilde renders literally; warning about it would be noise.
  assert.deepEqual(rules('the fare is ~750 som'), []);
});

test('a tilde inside code is not reported', () => {
  // Slack resolves code spans before the inline delimiters, so these are literal.
  assert.deepEqual(rules('`~750` and `~$9`'), []);
  assert.deepEqual(rules('```\n~750 som\n~$9\n```'), []);
});

test('tildes separated only by a code span still pair', () => {
  // They do in Slack, so they must here: stripping the code span must not
  // silently drop the pair around it.
  assert.deepEqual(rules('~750 som `x` and ~$9 total'), ['strikethrough']);
});

test('strikethrough spans newlines, which is what makes it expensive', () => {
  const findings = lintMrkdwn('~750 som\n\nand later ~$9');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, 'strikethrough');
});

test('a tilde pair with whitespace on the inner edge is not strikethrough', () => {
  assert.deepEqual(rules('a ~ b ~ c'), []);
});

test('Markdown bold, links and headings are reported', () => {
  assert.deepEqual(rules('**bold**'), ['bold']);
  assert.deepEqual(rules('[the guide](https://example.com/x)'), ['link']);
  assert.deepEqual(rules('## Findings\n\nbody'), ['heading']);
});

test('correct mrkdwn reports nothing', () => {
  const clean = [
    '*Short answer:* there is no such ride.',
    '_verified today_ · `#582` · <https://example.com|the guide>',
    '• approx. 750 som (≈$9)',
    '> a quote',
  ].join('\n');
  assert.deepEqual(rules(clean), []);
});

test('an advisory names the fix and the ids to repair with', () => {
  const advisory = mrkdwnAdvisory(INCIDENT, {
    channelId: 'C0BG98BRH7U',
    messageTs: '1786453389.428549',
  });
  assert.ok(advisory);
  assert.match(advisory, /STRUCK THROUGH/);
  assert.match(advisory, /approx\.|≈/);
  assert.match(advisory, /slack_update_message/);
  assert.match(advisory, /C0BG98BRH7U/);
  assert.match(advisory, /1786453389\.428549/);
  assert.match(advisory, /4,000/);
});

test('clean text produces no advisory at all', () => {
  assert.equal(mrkdwnAdvisory('approx. 750 som (≈$9)', { channelId: 'C1', messageTs: '1.2' }), null);
});

// ---------------------------------------------------------------------------
// the tool surface
// ---------------------------------------------------------------------------

const WRITE_TEXT_TOOLS = [postMessageTool, replyToThreadTool, updateMessageTool];

test('every tool taking message text leads with the mrkdwn trap', () => {
  for (const factory of WRITE_TEXT_TOOLS) {
    const tool = factory(null, () => ({}));
    const head = tool.description.slice(0, 400);
    assert.match(head, /mrkdwn is NOT Markdown/, `${tool.name} must lead with the trap`);
    assert.match(head, /strikethrough/i, `${tool.name} must name the tilde rule up front`);
  }
});

test('no tool still calls the format "Slack markdown formatting"', () => {
  // The upstream phrasing this fork exists to remove: it calls mrkdwn markdown,
  // which is the assumption that produced the struck-through message, and it
  // omits the one construct that silently wrecks one.
  for (const factory of [...WRITE_TEXT_TOOLS, uploadSnippetTool]) {
    const tool = factory(null, () => ({}));
    const surface = tool.description + JSON.stringify(tool.inputSchema);
    assert.doesNotMatch(surface, /Supports Slack markdown/i, `${tool.name} still says it`);
  }
});

test('the text parameter of each write tool carries the rules', () => {
  for (const factory of WRITE_TEXT_TOOLS) {
    const tool = factory(null, () => ({}));
    assert.match(
      tool.inputSchema.properties.text.description,
      /"~" is the strikethrough delimiter/,
      `${tool.name}.text must state the tilde rule`
    );
  }
  assert.match(MRKDWN_TEXT_GUIDANCE, /NOT Markdown/);
});

test('slack_upload_snippet documents the opposite: a snippet is not mrkdwn', () => {
  const tool = uploadSnippetTool(null, () => ({}));
  assert.match(tool.description, /NOT mrkdwn/);
  assert.match(tool.inputSchema.properties.content.description, /verbatim/);
});

test('the fork renames no upstream tool', () => {
  // Every caller of the published package addresses these names, and the
  // gateway's `tools: allow` policy for slack-readonly names four of them.
  const names = [
    getChannelsTool,
    getChannelTool,
    getThreadTool,
    downloadFileTool,
    postMessageTool,
    replyToThreadTool,
    updateMessageTool,
    reactToMessageTool,
    uploadSnippetTool,
  ].map((f) => f(null, () => ({})).name);

  assert.deepEqual(names.sort(), [
    'slack_download_file',
    'slack_get_channel',
    'slack_get_channels',
    'slack_get_thread',
    'slack_post_message',
    'slack_react_to_message',
    'slack_reply_to_thread',
    'slack_update_message',
    'slack_upload_snippet',
  ]);
});

// ---------------------------------------------------------------------------
// the handlers — advise, never rewrite
// ---------------------------------------------------------------------------

function fakeClient() {
  const sent = [];
  return {
    sent,
    async postMessage(channelId, text, options) {
      sent.push({ channelId, text, options });
      return { ts: '1786453389.428549' };
    },
    async updateMessage(channelId, ts, text) {
      sent.push({ channelId, ts, text });
      return { ts };
    },
  };
}

test('slack_post_message sends the caller text UNCHANGED and warns in the result', async () => {
  const client = fakeClient();
  const tool = postMessageTool(null, () => client);

  const result = await tool.handler({ channel_id: 'C0BG98BRH7U', text: INCIDENT });

  // The promise this fork makes: it does not silently escape or rewrite. `~`
  // has legitimate uses, and a server that edits a caller's words fails just as
  // quietly as the bug it is trying to prevent.
  assert.equal(client.sent.length, 1);
  assert.equal(client.sent[0].text, INCIDENT);

  assert.notEqual(result.isError, true);
  assert.match(result.content[0].text, /Message posted successfully/);
  assert.match(result.content[0].text, /Slack mrkdwn warning/);
  assert.match(result.content[0].text, /slack_update_message/);
});

test('slack_post_message adds no warning to correct mrkdwn', async () => {
  const client = fakeClient();
  const tool = postMessageTool(null, () => client);
  const result = await tool.handler({ channel_id: 'C1', text: '*Short answer:* approx. 750 som' });
  assert.doesNotMatch(result.content[0].text, /mrkdwn warning/);
});

test('slack_reply_to_thread warns too — this thread is where it happened', async () => {
  const client = fakeClient();
  const tool = replyToThreadTool(null, () => client);
  const result = await tool.handler({
    channel_id: 'C0BG98BRH7U',
    thread_ts: '1786445558.550989',
    text: INCIDENT,
  });
  assert.equal(client.sent[0].text, INCIDENT);
  assert.match(result.content[0].text, /Slack mrkdwn warning/);
});

test('slack_update_message warns, so a repair that reintroduces the bug is caught', async () => {
  const client = fakeClient();
  const tool = updateMessageTool(null, () => client);
  const result = await tool.handler({
    channel_id: 'C0BG98BRH7U',
    message_ts: '1786453389.428549',
    text: 'still ~750 som and ~$9',
  });
  assert.equal(client.sent[0].text, 'still ~750 som and ~$9');
  assert.match(result.content[0].text, /Slack mrkdwn warning/);
});

test('a failed send reports the failure and nothing else', async () => {
  const tool = postMessageTool(null, () => ({
    async postMessage() {
      throw new Error('channel_not_found');
    },
  }));
  const result = await tool.handler({ channel_id: 'C0', text: INCIDENT });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /channel_not_found/);
  // Nothing posted, so there is nothing to warn about or repair.
  assert.doesNotMatch(result.content[0].text, /mrkdwn warning/);
});
