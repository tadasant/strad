/**
 * Body text handling for outgoing mail: reflowing hard-wrapped plain text, and
 * the quoted-printable transfer encoding every text body part is sent in.
 *
 * Callers are mostly LLM agents, and agents hard-wrap prose at 72-80 columns
 * the way they wrap code comments. A text/plain part without `format=flowed`
 * shows every one of those newlines as a hard break, so on a phone a
 * 72-column line wraps once more and the paragraph comes out as alternating
 * long and two-word lines. Reflowing the body before it is encoded is what
 * makes it read as paragraphs everywhere.
 */

/** Below this, a block's lines are too short to be soft-wrapped prose. */
const MIN_WRAP_WIDTH = 50;

/** Above this, the author is not hard-wrapping, so every break is meant. */
const MAX_WRAP_WIDTH = 100;

/** A line shorter than this is never treated as soft-wrapped. */
const MIN_WRAPPED_LINE = 40;

const FENCE = /^\s*(```|~~~)/;
const LIST_ITEM = /^(\s*)([-*+•]|\d{1,3}[.)]|[a-zA-Z][.)])\s+/;
const QUOTE = /^\s*>/;
const HEADING = /^\s{0,3}#{1,6}\s/;
const TABLE_ROW = /^\s*\|/;
const BARE_URL = /^\s*(\S+:\/\/|www\.)\S*\s*$/;
const RULE = /^\s*([-*_=])(\s*\1){2,}\s*$/;
// `Status: merged`, `Attn: Legal` — a label row, not a wrapped continuation.
const LABEL = /^\s*[A-Z][\w /-]{0,30}:\s/;
const POSTSCRIPT = /^\s*P\.\s?S\.?\s/i;
// The RFC 3676 signature separator; everything below it is kept as written.
const SIGNATURE = /^-- ?$/;

/** A short line ending in a comma: `Best regards,`, `Thanks,`. */
function isSignOff(line: string): boolean {
  return line.trim().length < MIN_WRAPPED_LINE && /,$/.test(line.trim());
}

/** A line that starts its own element and is never joined onto the line before it. */
function startsElement(line: string): boolean {
  return (
    LIST_ITEM.test(line) ||
    QUOTE.test(line) ||
    HEADING.test(line) ||
    TABLE_ROW.test(line) ||
    RULE.test(line) ||
    BARE_URL.test(line) ||
    LABEL.test(line) ||
    POSTSCRIPT.test(line) ||
    isSignOff(line)
  );
}

/** A line whose own layout must survive verbatim, and that nothing is joined onto. */
function isVerbatim(line: string): boolean {
  return QUOTE.test(line) || TABLE_ROW.test(line) || RULE.test(line) || HEADING.test(line);
}

function firstWordLength(line: string): number {
  return line.trimStart().split(/\s/, 1)[0].length;
}

/**
 * Reflows a block of consecutive non-blank lines that sits outside any code
 * fence. A line is joined onto the one before it only when the one before it
 * was evidently cut by a wrap: it is long, the block's widest line is a
 * plausible wrap width, and the next line's first word would not have fit
 * after it. That is the test a human applies, and it keeps short intentional
 * lines (a sign-off, an address, `Key: value` rows) exactly as written.
 */
function reflowBlock(lines: string[]): string[] {
  // The wrap width is the widest line a wrap could have produced. A line with
  // no space in it (a bare URL) overflows any wrap, so it does not count.
  const width = Math.max(
    0,
    ...lines
      .map((l) => l.trimEnd())
      .filter((l) => /\S\s+\S/.test(l))
      .map((l) => l.length)
  );
  if (lines.length < 2 || width < MIN_WRAP_WIDTH || width > MAX_WRAP_WIDTH) {
    return lines;
  }

  const out: string[] = [];
  // Length of the last source line in the last output line; that line may
  // already hold several joined source lines.
  let lastLength = 0;
  // Continuation indent of the list item the last output line belongs to, or
  // null when that line is plain prose.
  let itemIndent: number | null = null;
  // Whether anything may be joined onto the last output line: not when it is
  // verbatim layout, a single token (a bare URL), or an indented line outside
  // a list (code, an address).
  let joinable = false;

  for (const raw of lines) {
    const line = raw.trimEnd();
    const indent = line.length - line.trimStart().length;

    let join = false;
    if (joinable && !startsElement(line)) {
      // A line ending in a colon introduces what follows; it was not cut.
      const wrapped =
        lastLength >= MIN_WRAPPED_LINE &&
        lastLength + 1 + firstWordLength(line) > width &&
        !out[out.length - 1].endsWith(':');
      // Inside a list item a continuation is indented to the item's text, or
      // not at all; outside one, an indented line is code or layout.
      const continues = indent === 0 || (itemIndent !== null && indent === itemIndent);
      join = wrapped && continues;
    }

    if (join) {
      out[out.length - 1] += ` ${line.trim()}`;
    } else {
      out.push(line);
      const item = LIST_ITEM.exec(line);
      itemIndent = item ? item[0].length : null;
      joinable = !isVerbatim(line) && /\S\s+\S/.test(line) && (indent === 0 || item !== null);
    }
    lastLength = line.length;
  }
  return out;
}

/**
 * Joins lines that were soft-wrapped by the author's editor (or model) back
 * into the paragraphs they belong to. Blank lines, list items, quoted lines,
 * headings, table rows, label rows (`Status: merged`), sign-offs, `P.S.`
 * lines, indented blocks, fenced code and everything below a `-- ` signature
 * separator are kept as written, as is any block whose widest line is too short or too long to be a wrap
 * width. Line endings come back as `\n`.
 */
export function reflowPlainText(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let block: string[] = [];
  let inFence = false;

  const flush = () => {
    if (block.length > 0) out.push(...reflowBlock(block));
    block = [];
  };

  for (const [i, line] of lines.entries()) {
    if (!inFence && SIGNATURE.test(line)) {
      flush();
      out.push(...lines.slice(i));
      return out.join('\n');
    }
    if (FENCE.test(line)) {
      flush();
      out.push(line);
      inFence = !inFence;
    } else if (inFence) {
      out.push(line);
    } else if (line.trim() === '') {
      flush();
      out.push(line);
    } else {
      block.push(line);
    }
  }
  flush();
  return out.join('\n');
}

const QP_MAX_LINE = 76;

function qpByte(byte: number): string {
  return `=${byte.toString(16).toUpperCase().padStart(2, '0')}`;
}

/**
 * Encodes text as quoted-printable (RFC 2045 §6.7) with CRLF line endings.
 * Every line break in the text is a hard break; lines longer than 76
 * characters are split with soft breaks (`=` at the end), which a receiving
 * client removes when it decodes. That keeps a long paragraph on one logical
 * line while every line on the wire stays inside RFC 5322's limits, so no
 * relay has a reason to fold it.
 */
export function encodeQuotedPrintable(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  return lines
    .map((line) => {
      // One token per character, so a soft break never splits the bytes of
      // one character across two wire lines.
      const chars = [...line];
      const tokens = chars.map((char, i) => {
        const code = char.charCodeAt(0);
        const last = i === chars.length - 1;
        const printable =
          (code >= 33 && code <= 126 && code !== 61) || ((code === 32 || code === 9) && !last);
        return printable ? char : [...Buffer.from(char, 'utf-8')].map(qpByte).join('');
      });

      const wire: string[] = [];
      let current = '';
      for (const token of tokens) {
        // Leave room for the trailing `=` of a soft break.
        if (current.length + token.length > QP_MAX_LINE - 1) {
          wire.push(`${current}=`);
          current = '';
        }
        current += token;
      }
      wire.push(current);
      return wire.join('\r\n');
    })
    .join('\r\n');
}

const URL_IN_TEXT = /\bhttps?:\/\/[^\s<>"]+/g;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Splits trailing sentence punctuation off a URL found in prose, so
 * `see https://x.test/a.` links `https://x.test/a`. A closing parenthesis
 * stays only when the URL opened one.
 */
function splitUrl(match: string): [string, string] {
  let url = match;
  for (;;) {
    const last = url.slice(-1);
    if (/[.,;:!?'"]/.test(last)) {
      url = url.slice(0, -1);
    } else if (last === ')' && url.split('(').length < url.split(')').length) {
      url = url.slice(0, -1);
    } else {
      break;
    }
  }
  return [url, match.slice(url.length)];
}

/** One line of plain text as HTML: escaped, its URLs linked, its indent kept. */
function lineToHtml(line: string): string {
  let html = '';
  let at = 0;
  for (const match of line.matchAll(URL_IN_TEXT)) {
    const [url, rest] = splitUrl(match[0]);
    html += escapeHtml(line.slice(at, match.index));
    html += `<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>${escapeHtml(rest)}`;
    at = match.index + match[0].length;
  }
  html += escapeHtml(line.slice(at));
  // HTML collapses runs of spaces; an indented line keeps its indent.
  return html.replace(/^ +/, (spaces) => '&nbsp;'.repeat(spaces.length)).replace(/\t/g, '&nbsp;'.repeat(4));
}

/**
 * The HTML alternative sent beside a plain-text-only body. Gmail renders a
 * `text/plain` part by breaking it at about 70 columns of its own choosing —
 * the hard breaks land in the reader's view and in the quote of every reply,
 * however long the line on the wire was — and it ignores `format=flowed`.
 * An HTML part is laid out by the reader's client at the reader's width.
 * Every line break of the (already reflowed) text is kept as a `<br>`, so the
 * two parts say the same thing with the same structure; bare URLs become
 * links whose text is the URL.
 */
export function plainTextToHtml(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  return `<div dir="auto">${lines.map(lineToHtml).join('<br>\n')}</div>`;
}
