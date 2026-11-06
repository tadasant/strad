/**
 * The small markdown dialect `insert_content` takes, parsed into paragraphs with
 * their styles as offsets into each paragraph's own text. Nothing here knows a
 * document index: `content-requests.ts` places the result, so a caller never
 * counts a UTF-16 code unit.
 *
 * Every non-blank line is one paragraph. There is no soft wrapping, because a
 * line an agent wrote as a paragraph must not merge with the next one.
 *
 * What the dialect cannot express is REFUSED, by line. Writing `> quote` or a
 * table into a live document as literal punctuation is a worse answer than an
 * error, and a backslash in front of the character inserts it literally.
 *
 * Emphasis follows CommonMark's delimiter algorithm rather than a search for a
 * closing mark, because model-written markdown nests it (`**bold *both***`), and
 * a scan that does not nest writes the leftover stars into the document.
 */

export type NamedStyle =
  | 'NORMAL_TEXT'
  | 'HEADING_1'
  | 'HEADING_2'
  | 'HEADING_3'
  | 'HEADING_4'
  | 'HEADING_5'
  | 'HEADING_6';

export interface InlineStyle {
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  link?: string;
}

/** A styled stretch of one paragraph's text, in UTF-16 code units from its start. */
export interface StyledSpan {
  start: number;
  end: number;
  style: InlineStyle;
}

export interface ContentParagraph {
  namedStyle: NamedStyle;
  list?: 'bullet' | 'number';
  text: string;
  spans: StyledSpan[];
}

/**
 * The characters `insertText` strips, per its reference. They are removed here
 * first, or every range computed after one would be off by what Google dropped.
 */
// eslint-disable-next-line no-control-regex
const STRIPPED_BY_DOCS = /[\u0000-\u0008\u000C-\u001F\uE000-\uF8FF]/g;

const ESCAPABLE = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;
const LINKABLE = /^(https?:\/\/|mailto:)/i;
const PUNCTUATION = /[\p{P}\p{S}]/u;
const WHITESPACE = /\s/;
const DIGIT = /[0-9]/;

const TAB_WIDTH = 4;
const NESTED_INDENT = 2;

function refusedLine(line: string): string | undefined {
  if (/^\s*(```|~~~)/.test(line)) return 'a code fence';
  if (/^\s*>/.test(line)) return 'a block quote';
  if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) return 'a horizontal rule';
  if (/^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(line)) return 'a table';
  if (/^\s*\|(\s*:?-+:?\s*\|)+\s*$/.test(line)) return 'a table';
  return undefined;
}

function indentOf(whitespace: string): number {
  return whitespace.replace(/\t/g, ' '.repeat(TAB_WIDTH)).length;
}

/**
 * `createParagraphBullets` reads a leading tab as a nesting level, removes it
 * and shifts everything after it. The block rules consume indentation, so one can
 * only arrive from inside a code span or a link; it goes here, before any range
 * is computed.
 */
function withoutLeadingTabs(text: string, spans: StyledSpan[]) {
  const cut = text.length - text.replace(/^\t+/, '').length;
  if (cut === 0) return { text, spans };
  return {
    text: text.slice(cut),
    spans: spans
      .map((s) => ({ ...s, start: Math.max(0, s.start - cut), end: s.end - cut }))
      .filter((s) => s.end > s.start),
  };
}

export function parseMarkdown(content: string): ContentParagraph[] {
  const lines = content.replace(/\r\n?/g, '\n').replace(STRIPPED_BY_DOCS, '').split('\n');
  const paragraphs: ContentParagraph[] = [];
  const refused: string[] = [];
  let listIndent = 0;

  lines.forEach((line, i) => {
    if (line.trim().length === 0) return;
    const number = i + 1;
    const refuse = (what: string) => void refused.push(`line ${number} is ${what}`);
    const inline = (source: string) => {
      const parsed = parseInline(source);
      if (parsed.image) refused.push(`line ${number} holds an image`);
      return { text: parsed.text, spans: parsed.spans };
    };

    const what = refusedLine(line);
    if (what) {
      refuse(what);
      return;
    }

    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/);
    if (heading) {
      paragraphs.push({
        namedStyle: `HEADING_${heading[1].length}` as NamedStyle,
        ...inline(heading[2]),
      });
      return;
    }

    const previous = paragraphs[paragraphs.length - 1]?.list;
    const item = line.match(/^(\s*)(?:([-*+])|(\d{1,9})[.)])\s+(.+?)\s*$/);
    // A number starts a list only at 1: `2020. A good year` is a sentence, and
    // Docs numbers its own lists, so any other first number would be rewritten.
    const isItem = item && (item[2] || Number(item[3]) === 1 || previous === 'number');
    if (item && isItem) {
      const indent = indentOf(item[1]);
      if (previous && indent >= listIndent + NESTED_INDENT) {
        refuse('a nested list item');
        return;
      }
      const inner = refusedLine(item[4]);
      if (inner) {
        refuse(inner);
        return;
      }
      if (!previous) listIndent = indent;
      const { text, spans } = inline(item[4]);
      const flat = withoutLeadingTabs(text, spans);
      if (flat.text.length === 0) {
        refuse('an empty list item');
        return;
      }
      paragraphs.push({ namedStyle: 'NORMAL_TEXT', list: item[2] ? 'bullet' : 'number', ...flat });
      return;
    }

    paragraphs.push({ namedStyle: 'NORMAL_TEXT', ...inline(line.trim()) });
  });

  if (refused.length > 0) {
    throw new Error(
      `content cannot be written as Docs paragraphs: ${refused.join(', ')}. Nothing was changed. ` +
        'Supported: # to ###### headings, paragraphs, - bullets, 1. numbers (one level), ' +
        '**bold**, *italic*, `code` and [text](https://url). Put a backslash before a character ' +
        'to insert it literally. Tables and images go through update_document.'
    );
  }
  if (paragraphs.length === 0) {
    throw new Error('content holds no text. Nothing was changed.');
  }
  return paragraphs;
}

type InlineNode =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'link'; url: string; children: InlineNode[] }
  | { kind: 'emphasis'; strong: boolean; children: InlineNode[] }
  | Delimiter;

interface Delimiter {
  kind: 'delimiter';
  char: string;
  count: number;
  original: number;
  canOpen: boolean;
  canClose: boolean;
}

/** Where a `[label](destination)` at `open` ends, with parentheses in it balanced. */
function matchLink(source: string, open: number) {
  let close = open + 1;
  for (; close < source.length && source[close] !== ']'; close++) {
    if (source[close] === '\\') close += 1;
  }
  if (close === open + 1 || source[close] !== ']' || source[close + 1] !== '(') return undefined;

  let depth = 1;
  let end = close + 2;
  for (; end < source.length && depth > 0; end++) {
    if (source[end] === '(') depth += 1;
    else if (source[end] === ')') depth -= 1;
    else if (WHITESPACE.test(source[end])) return undefined;
  }
  if (depth > 0) return undefined;
  const url = source.slice(close + 2, end - 1);
  if (url.length === 0) return undefined;
  return { label: source.slice(open + 1, close), url, end };
}

function delimiterAt(source: string, start: number, end: number): Delimiter {
  const char = source[start];
  const before = source[start - 1] ?? ' ';
  const after = source[end] ?? ' ';
  const spaceBefore = WHITESPACE.test(before);
  const spaceAfter = WHITESPACE.test(after);
  const markBefore = PUNCTUATION.test(before);
  const markAfter = PUNCTUATION.test(after);
  const left = !spaceAfter && (!markAfter || spaceBefore || markBefore);
  const right = !spaceBefore && (!markBefore || spaceAfter || markAfter);

  // Arithmetic, not emphasis: `2*3*4` would lose its stars as `234`.
  const betweenDigits = DIGIT.test(before) && DIGIT.test(after);
  const canOpen = char === '_' ? left && (!right || markBefore) : left && !betweenDigits;
  const canClose = char === '_' ? right && (!left || markAfter) : right && !betweenDigits;
  const count = end - start;
  return { kind: 'delimiter', char, count, original: count, canOpen, canClose };
}

function tokenize(source: string, found: { image: boolean }): InlineNode[] {
  const nodes: InlineNode[] = [];
  let literal = '';
  const flush = () => {
    if (literal.length > 0) nodes.push({ kind: 'text', text: literal });
    literal = '';
  };

  let lastBacktick = source.lastIndexOf('`');
  const lastBracket = source.lastIndexOf(']');
  for (let i = 0; i < source.length; ) {
    const char = source[i];

    if (char === '\\' && ESCAPABLE.test(source[i + 1] ?? '')) {
      literal += source[i + 1];
      i += 2;
      continue;
    }

    if (char === '`' && i < lastBacktick) {
      const close = source.indexOf('`', i + 1);
      if (close > i + 1) {
        flush();
        nodes.push({ kind: 'code', text: source.slice(i + 1, close) });
        i = close + 1;
        continue;
      }
      lastBacktick = close === i + 1 ? lastBacktick : -1;
    }

    if (char === '!' && source[i + 1] === '[' && i + 1 < lastBracket) {
      if (matchLink(source, i + 1)) found.image = true;
    }

    if (char === '[' && i < lastBracket) {
      const link = matchLink(source, i);
      if (link && LINKABLE.test(link.url)) {
        flush();
        nodes.push({ kind: 'link', url: link.url, children: inlineNodes(link.label, found) });
        i = link.end;
        continue;
      }
    }

    if (char === '*' || char === '_') {
      let end = i + 1;
      while (source[end] === char) end += 1;
      flush();
      nodes.push(delimiterAt(source, i, end));
      i = end;
      continue;
    }

    literal += char;
    i += 1;
  }
  flush();
  return nodes;
}

/** CommonMark's "multiple of 3" rule, which stops `*foo**bar*` pairing the wrong marks. */
function blockedByLengths(opener: Delimiter, closer: Delimiter): boolean {
  if (!(opener.canClose || closer.canOpen)) return false;
  const sum = opener.original + closer.original;
  return sum % 3 === 0 && (opener.original % 3 !== 0 || closer.original % 3 !== 0);
}

/** Pairs closers with their nearest opener, wrapping what lies between. */
function resolveEmphasis(nodes: InlineNode[]): InlineNode[] {
  for (let c = 0; c < nodes.length; c++) {
    const closer = nodes[c];
    if (closer.kind !== 'delimiter' || !closer.canClose) continue;

    while (closer.count > 0) {
      let o = c - 1;
      for (; o >= 0; o--) {
        const node = nodes[o];
        if (
          node.kind === 'delimiter' &&
          node.char === closer.char &&
          node.canOpen &&
          node.count > 0 &&
          !blockedByLengths(node, closer)
        ) {
          break;
        }
      }
      if (o < 0) break;

      const opener = nodes[o] as Delimiter;
      const strong = opener.count >= 2 && closer.count >= 2;
      const used = strong ? 2 : 1;
      opener.count -= used;
      closer.count -= used;
      nodes.splice(o + 1, c - o - 1, {
        kind: 'emphasis',
        strong,
        children: nodes.slice(o + 1, c),
      });
      c = o + 2;
    }
  }
  return nodes;
}

function inlineNodes(source: string, found: { image: boolean }): InlineNode[] {
  return resolveEmphasis(tokenize(source, found));
}

function emit(
  out: { text: string; spans: StyledSpan[] },
  text: string,
  style: InlineStyle
): void {
  if (text.length === 0) return;
  const start = out.text.length;
  out.text += text;
  if (Object.keys(style).length > 0) out.spans.push({ start, end: out.text.length, style });
}

function render(
  nodes: InlineNode[],
  style: InlineStyle,
  out: { text: string; spans: StyledSpan[] }
): void {
  for (const node of nodes) {
    if (node.kind === 'text') emit(out, node.text, style);
    else if (node.kind === 'delimiter') emit(out, node.char.repeat(node.count), style);
    else if (node.kind === 'code') emit(out, node.text, { ...style, code: true });
    else if (node.kind === 'link') render(node.children, { ...style, link: node.url }, out);
    else render(node.children, { ...style, ...(node.strong ? { bold: true } : { italic: true }) }, out);
  }
}

function parseInline(source: string) {
  const found = { image: false };
  const out = { text: '', spans: [] as StyledSpan[] };
  render(inlineNodes(source, found), {}, out);
  return { ...out, image: found.image };
}
