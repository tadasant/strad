// The strad fork delta: Slack mrkdwn is not Markdown, and the message that
// proved it posted successfully.
//
// These tests exist because the failure has no error in it. A `~` used as
// "approximately" strikes through everything up to the next `~`, `chat.postMessage`
// returns ok, and the tool reports success — so the only things that can catch it
// are the tool DESCRIPTION (before the send) and the tool RESULT (after it). Both
// are asserted here, and so is the promise that neither one rewrites the caller's
// text.
import { test } from 'vitest';
import assert from 'node:assert/strict';

import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { lintMrkdwn, mrkdwnAdvisory, MRKDWN_TEXT_GUIDANCE } from '../src/mrkdwn.js';
import { createRegisterTools } from '../src/tools.js';
import { postMessageTool } from '../src/tools/post-message.js';
import { replyToThreadTool } from '../src/tools/reply-to-thread.js';
import { updateMessageTool } from '../src/tools/update-message.js';
import { uploadSnippetTool } from '../src/tools/upload-snippet.js';
import { reactToMessageTool } from '../src/tools/react-to-message.js';
import { getChannelsTool } from '../src/tools/get-channels.js';
import { getChannelTool } from '../src/tools/get-channel.js';
import { getThreadTool } from '../src/tools/get-thread.js';
import { downloadFileTool } from '../src/tools/download-file.js';
import { getDmsTool } from '../src/tools/get-dms.js';
import { getDmTool } from '../src/tools/get-dm.js';
import { findUserTool } from '../src/tools/find-user.js';
import { sendDmTool } from '../src/tools/send-dm.js';

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
  // Pin the exact span, not a substring of it: a regression returning the whole
  // match or the wrong capture group would still "include" the fare.
  assert.equal(strike.samples[0], '750 som each (');
});

test('a struck span of any length is reported — paragraphs are the point', () => {
  // A length cap here would miss precisely the failure this module exists for,
  // and chat.postMessage accepts far more text than any comfortable bound.
  const long = `~750 som${'x'.repeat(20000)} and ~$9`;
  const findings = lintMrkdwn(long);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, 'strikethrough');
});

test('a code span adjacent to a tilde does not suppress the pair', () => {
  // stripCode must not leave whitespace on the opening tilde's inner edge.
  assert.deepEqual(rules('~`750` som and ~$9'), ['strikethrough']);
});

test('Slack has no CommonMark, so deep and indented headings count too', () => {
  assert.deepEqual(rules('####### seven hashes'), ['heading']);
  assert.deepEqual(rules('      # four spaces in'), ['heading']);
});

test('a Markdown link with no scheme is still a Markdown link', () => {
  assert.deepEqual(rules('[the doc](/operate/secrets/)'), ['link']);
  assert.deepEqual(rules('[mail me](mailto:a@example.com)'), ['link']);
});

test('the anti-noise promises hold', () => {
  // Stated in the description rather than linted, so pin that they stay silent.
  assert.deepEqual(rules('snake_case_name and another_identifier_here'), []);
  assert.deepEqual(rules('see #general and #alerts'), []);
  assert.deepEqual(rules('a *bold* word and _italics_'), []);
});

test('samples are capped and the remainder is counted', () => {
  const text = '~a~ ~b~ ~c~ ~d~ ~e~';
  const findings = lintMrkdwn(text);
  assert.equal(findings[0].count, 5);
  assert.equal(findings[0].samples.length, 3);
  assert.match(mrkdwnAdvisory(text, { channelId: 'C1', messageTs: '1.2' }), /and 2 more/);
});

test('with no message_ts there is no repair paragraph', () => {
  const advisory = mrkdwnAdvisory('~750 som and ~$9', { channelId: 'C1' });
  assert.ok(advisory);
  assert.match(advisory, /STRUCK THROUGH/);
  assert.doesNotMatch(advisory, /To repair/);
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

const WRITE_TEXT_TOOLS = [postMessageTool, replyToThreadTool, updateMessageTool, sendDmTool];

const ALL_TOOL_FACTORIES = [
  getChannelsTool,
  getChannelTool,
  getThreadTool,
  downloadFileTool,
  postMessageTool,
  replyToThreadTool,
  updateMessageTool,
  reactToMessageTool,
  uploadSnippetTool,
  getDmsTool,
  getDmTool,
  findUserTool,
  sendDmTool,
];

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
  // omits the one construct that silently wrecks one. Checked over ALL THIRTEEN
  // tools, not just the ones that were reworded — a re-vendor could reintroduce
  // it anywhere.
  for (const factory of ALL_TOOL_FACTORIES) {
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

/** The tool names a group really registers, read off the registration table. */
async function registeredNames(groups) {
  let listed = null;
  const fakeServer = {
    setRequestHandler(schema, handler) {
      if (schema === ListToolsRequestSchema) listed = handler;
    },
  };
  createRegisterTools(() => ({}), groups)(fakeServer);
  assert.ok(listed, 'createRegisterTools must register a tools/list handler');
  const { tools } = await listed();
  return tools.map((t) => t.name).sort();
}

test('the fork renames and drops no upstream tool, and adds exactly the DM four and the events status tool', async () => {
  // Read from createRegisterTools rather than a hand-written list, so a tool
  // dropped from ALL_TOOLS in src/tools.ts fails here too. Every caller of the
  // published package addresses these names — upstream's nine are untouched, and
  // the four the fork ADDS are the DM surface (test/dm.test.ts covers them), plus
  // slack_events_status, the MCP Events feed's state (test/events.test.ts).
  assert.deepEqual(await registeredNames(['readonly', 'write']), [
    'slack_download_file',
    'slack_events_status',
    'slack_find_user',
    'slack_get_channel',
    'slack_get_channels',
    'slack_get_dm',
    'slack_get_dms',
    'slack_get_thread',
    'slack_post_message',
    'slack_react_to_message',
    'slack_reply_to_thread',
    'slack_send_dm',
    'slack_update_message',
    'slack_upload_snippet',
  ]);
});

test('the readonly group is exactly the eight tools slack-readonly allows', async () => {
  // infra/strad.staging.yaml and strad.config.example.yaml both carve the
  // `slack-readonly` slug's `tools: allow` list out of this group. An allow-list
  // is exhaustive, so a tool moving between groups narrows that slug in silence.
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

test('slack_upload_snippet never appends an advisory — a snippet is not mrkdwn', async () => {
  // The description says the mrkdwn rules do not apply here. The handler has to
  // agree, or the tool tells a caller to repair something Slack never mangled.
  const uploaded = [];
  const tool = uploadSnippetTool(null, () => ({
    async uploadSnippet(content, options) {
      uploaded.push({ content, options });
      return { id: 'F123', name: 'notes.txt' };
    },
  }));
  const result = await tool.handler({ channel_id: 'C1', content: INCIDENT });
  assert.equal(uploaded[0].content, INCIDENT);
  assert.doesNotMatch(result.content[0].text, /mrkdwn warning/);
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
