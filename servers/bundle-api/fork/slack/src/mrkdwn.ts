/**
 * strad's fork delta: Slack mrkdwn is not Markdown.
 *
 * Slack renders message text as **mrkdwn**, a format that shares punctuation
 * with Markdown and disagrees with it about what that punctuation means. The
 * expensive disagreement is `~`: in mrkdwn a tilde-delimited span is
 * STRIKETHROUGH, and an agent writing "~750 som" and "~$9" in the same message
 * has not written two approximations — it has written one struck-through run
 * covering everything between them.
 *
 * That failure has no error in it. `chat.postMessage` accepts the text, returns
 * `ok`, and the tool reports success; the only signal is a human reading the
 * channel. So this module does two things, and deliberately not a third:
 *
 *   1. `MRKDWN_TEXT_GUIDANCE` — the rules, stated on every tool that takes
 *      message text, leading with the tilde rather than with "supports Slack
 *      markdown formatting" (which is what upstream says, and which invites
 *      exactly this bug by calling the format markdown).
 *   2. `mrkdwnAdvisory()` — a post-hoc check on the text that was sent. When a
 *      construct would render wrong, the tool result carries a warning naming
 *      the spans and how to repair them.
 *
 * The third thing — silently escaping or rewriting the caller's text — is NOT
 * done. `~`, `**` and `[…](…)` all have legitimate uses in a Slack message, and
 * a server that rewrites the words a caller chose is a worse failure than the
 * one it prevents: it is just as silent and it is not recoverable by reading the
 * result. Advise, never rewrite.
 */

/** The mrkdwn rules, for the description of any parameter carrying message text. */
export const MRKDWN_TEXT_GUIDANCE =
  'FORMAT: Slack mrkdwn, which is NOT Markdown. ' +
  'THE TRAP: "~" is the strikethrough delimiter, so a tilde meaning "approximately" ' +
  'pairs with the next tilde in the message and strikes through everything between them ' +
  '— write "approx." or "≈" instead, or wrap the value in backticks. ' +
  'Bold is *one asterisk* (**two** leaves the extra asterisks showing). Italic is _underscores_. ' +
  'Links are <https://example.com|link text>, never [link text](https://example.com). ' +
  '`code` and ```code blocks``` work as expected. ' +
  'Headings (#), tables, and Markdown list syntax do NOT exist in mrkdwn and post as ' +
  'literal characters — use "•" and real newlines for bullets.';

/** The same rules, formatted as the opening section of a tool description. */
export const MRKDWN_TOOL_WARNING = `⚠️ FORMAT — Slack mrkdwn is NOT Markdown. Read this before composing text.

- "~" is STRIKETHROUGH. A tilde followed by a non-space pairs with the next
  tilde in the message and strikes through everything between them. A tilde
  meaning "approximately" ("~750 som", "~$9") is the common way this goes wrong,
  it strikes through whole paragraphs, and it does NOT error — the message posts
  and the tool reports success. Write "approx." or "≈", or put the value in
  \`backticks\`.
- Bold is *one asterisk*. **Two asterisks** leaves the extra asterisks showing.
- Italic is _underscores_.
- Links are <https://example.com|link text>. [link text](https://example.com)
  posts as literal brackets and parentheses.
- \`code\` and \`\`\`code blocks\`\`\` work. Blockquotes (>) work.
- Headings (#), tables, and Markdown list syntax do NOT exist. Use "•" and real
  newlines for bullets.

This tool re-checks the text after sending and warns in its result if any of the
above would render wrong. It never rewrites what you wrote.`;

export type MrkdwnRule = 'strikethrough' | 'bold' | 'link' | 'heading';

export interface MrkdwnFinding {
  rule: MrkdwnRule;
  /** How many times the construct occurs in the text. */
  count: number;
  /** Up to three offending spans, truncated for legibility. */
  samples: string[];
}

/**
 * Slack resolves code spans BEFORE the inline formatting characters, so a tilde
 * inside `backticks` or a ```fence``` is literal and must not be reported.
 *
 * Each span collapses to a NUL rather than to a space, and the difference
 * matters at a delimiter's edge. Two tildes separated only by a code span really
 * do pair up in Slack, and so does `~`code`` more~` — a space there would look
 * like whitespace on the opening tilde's inner edge and suppress the finding.
 * NUL cannot occur in the patterns' own character classes, so it reads as
 * ordinary content everywhere else.
 */
function stripCode(text: string): string {
  return text.replace(/```[\s\S]*?```/g, '\u0000').replace(/`[^`\n]*`/g, '\u0000');
}

/**
 * An OPENING delimiter does not fire against whitespace ("a ~ b ~ c" is not
 * strikethrough), and strikethrough DOES span newlines — which is why one stray
 * tilde can take a paragraph with it.
 *
 * The closing edge is treated leniently on purpose, and the span is UNBOUNDED
 * for the same reason. The cost of the two errors is not symmetric:
 * over-reporting spends a few lines of a tool result that the caller can read
 * and dismiss, while under-reporting ships a mangled message to a channel of
 * humans with a success result attached. A length cap here would have missed
 * exactly the case the module exists for — a pair with whole paragraphs between
 * it — and `chat.postMessage` accepts far more text than any comfortable bound.
 * A negated class with a lazy quantifier stays linear, so the cap bought nothing.
 * When in doubt, warn.
 */
const STRIKETHROUGH = /~(?=[^\s~])([^~]*?)~/g;
const DOUBLE_ASTERISK = /\*\*(?=[^\s*])([^*\n]{0,400}?[^\s*])\*\*/g;
// Slack has no CommonMark, so neither the "at most 6 hashes" nor the "at most 3
// leading spaces" rule applies: `####### x` and `      # x` both post literally.
const MARKDOWN_LINK = /\[([^\]\n]{1,300})\]\(([^)\s]{1,600})\)/g;
const MARKDOWN_HEADING = /^[ \t]*#+[ \t]+(\S[^\n]{0,200})/gm;

const MAX_SAMPLES = 3;
const SAMPLE_CHARS = 72;

function sample(span: string): string {
  const flat = span.replace(/\s+/g, ' ').trim();
  return flat.length > SAMPLE_CHARS ? `${flat.slice(0, SAMPLE_CHARS)}…` : flat;
}

function collect(text: string, rule: MrkdwnRule, pattern: RegExp): MrkdwnFinding | null {
  const samples: string[] = [];
  let count = 0;
  // The patterns are module-level /g objects shared by every mount in this
  // process, and `lastIndex` is state on them. That is safe ONLY because this
  // loop is synchronous by contract: Node runs it to completion before another
  // caller's tool call resumes. Introduce an `await` in here and two concurrent
  // callers will silently scan each other's offsets.
  pattern.lastIndex = 0;
  for (let m = pattern.exec(text); m !== null; m = pattern.exec(text)) {
    count += 1;
    if (samples.length < MAX_SAMPLES) samples.push(sample(m[1]));
    // A zero-length match would spin forever; none of the patterns can produce
    // one, but advancing defensively costs nothing.
    if (m.index === pattern.lastIndex) pattern.lastIndex += 1;
  }
  return count === 0 ? null : { rule, count, samples };
}

/**
 * Report the mrkdwn constructs in `text` that will not render the way a caller
 * writing Markdown would expect.
 *
 * Underscore italics are deliberately NOT reported. `_` pairs the same way `~`
 * does, so `snake_case_name` really can come out italicised — but identifiers,
 * paths and filenames carry underscores constantly, and a rule that fires on
 * every one of them would train a reader to ignore the whole advisory. The
 * underscore rule is stated in the description instead, where it costs nothing.
 */
export function lintMrkdwn(text: string): MrkdwnFinding[] {
  const scannable = stripCode(text);
  return [
    collect(scannable, 'strikethrough', STRIKETHROUGH),
    collect(scannable, 'bold', DOUBLE_ASTERISK),
    collect(scannable, 'link', MARKDOWN_LINK),
    collect(scannable, 'heading', MARKDOWN_HEADING),
  ].filter((f): f is MrkdwnFinding => f !== null);
}

const EXPLANATIONS: Record<MrkdwnRule, { what: string; fix: string }> = {
  strikethrough: {
    what: 'tilde pair(s) — Slack has STRUCK THROUGH the text between each pair',
    fix: 'mrkdwn has no backslash escape: write "approx." or "≈", or wrap the value in `backticks`.',
  },
  bold: {
    what: 'double-asterisk span(s) — the asterisks post literally, no bold',
    fix: 'Slack bold is *a single asterisk* on each side.',
  },
  link: {
    what: 'Markdown link(s) — the brackets and parentheses post literally',
    fix: 'Slack links are <https://example.com|link text>.',
  },
  heading: {
    what: 'Markdown heading(s) — the # characters post literally',
    fix: 'mrkdwn has no headings; use *bold* on its own line.',
  },
};

export interface RepairTarget {
  channelId: string;
  /** The `ts` of the message that was just sent, if it can be edited. */
  messageTs?: string;
}

/**
 * The warning appended to a successful write tool's result, or null when the
 * text renders as written.
 *
 * This runs AFTER the send on purpose. The message has already posted — the
 * failure mode being caught is precisely that nothing goes wrong at send time —
 * so the useful output is not a refusal but the two facts that let an agent fix
 * it in one more call: what Slack mangled, and the ids to edit.
 */
export function mrkdwnAdvisory(text: string, repair?: RepairTarget): string | null {
  const findings = lintMrkdwn(text);
  if (findings.length === 0) return null;

  const lines = [
    '⚠️ Slack mrkdwn warning: this posted successfully, but Slack does NOT render',
    'it the way it was written. mrkdwn is not Markdown.',
    '',
  ];

  for (const finding of findings) {
    const { what, fix } = EXPLANATIONS[finding.rule];
    lines.push(`• ${finding.count} ${what}`);
    for (const s of finding.samples) lines.push(`    "${s}"`);
    if (finding.count > finding.samples.length) {
      lines.push(`    …and ${finding.count - finding.samples.length} more`);
    }
    lines.push(`  ${fix}`);
  }

  if (repair?.messageTs) {
    lines.push(
      '',
      `To repair: slack_update_message with channel_id "${repair.channelId}" and ` +
        `message_ts "${repair.messageTs}". Note that chat.update caps text at 4,000 ` +
        'characters — a message long enough to post is not always short enough to edit.'
    );
  }

  return lines.join('\n');
}

/** Append `mrkdwnAdvisory()` to a tool result's text, when there is one. */
export function withMrkdwnAdvisory(
  resultText: string,
  sentText: string,
  repair?: RepairTarget
): string {
  const advisory = mrkdwnAdvisory(sentText, repair);
  return advisory === null ? resultText : `${resultText}\n\n${advisory}`;
}
