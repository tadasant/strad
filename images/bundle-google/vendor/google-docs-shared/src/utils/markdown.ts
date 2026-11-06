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
const STRIPPED_BY_DOCS = /[\u0000-\u0008\u000C-\u001F-]/g;

const ESCAPABLE = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;
const LINKABLE = /^(https?:\/\/|mailto:)/i;
const WORD_CHARACTER = /[\p{L}\p{N}]/u;

function refusedLine(line: string): string | undefined {
  if (/^\s*(```|~~~)/.test(line)) return 'a code fence';
  if (/^\s*>/.test(line)) return 'a block quote';
  if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) return 'a horizontal rule';
  if (/^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(line)) return 'a table';
  if (/^\s*!\[[^\]]*\]\([^)]*\)\s*$/.test(line)) return 'an image';
  return undefined;
}

export function parseMarkdown(content: string): ContentParagraph[] {
  const lines = content.replace(/\r\n?/g, '\n').replace(STRIPPED_BY_DOCS, '').split('\n');
  const paragraphs: ContentParagraph[] = [];
  const refused: string[] = [];

  lines.forEach((line, i) => {
    if (line.trim().length === 0) return;

    const what = refusedLine(line);
    if (what) {
      refused.push(`line ${i + 1} is ${what}`);
      return;
    }

    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/);
    if (heading) {
      paragraphs.push({
        namedStyle: `HEADING_${heading[1].length}` as NamedStyle,
        ...parseInline(heading[2]),
      });
      return;
    }

    const item = line.match(/^(\s*)(?:([-*+])|\d+[.)])\s+(.+?)\s*$/);
    if (item) {
      if (item[1].length >= 2 && paragraphs[paragraphs.length - 1]?.list) {
        refused.push(`line ${i + 1} is a nested list item`);
        return;
      }
      paragraphs.push({
        namedStyle: 'NORMAL_TEXT',
        list: item[2] ? 'bullet' : 'number',
        ...parseInline(item[3]),
      });
      return;
    }

    paragraphs.push({ namedStyle: 'NORMAL_TEXT', ...parseInline(line.trim()) });
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

function parseInline(source: string): { text: string; spans: StyledSpan[] } {
  const out = { text: '', spans: [] as StyledSpan[] };
  walkInline(source, {}, out);
  return out;
}

function emit(out: { text: string; spans: StyledSpan[] }, text: string, style: InlineStyle): void {
  if (text.length === 0) return;
  const start = out.text.length;
  out.text += text;
  if (Object.keys(style).length > 0) out.spans.push({ start, end: out.text.length, style });
}

function walkInline(
  source: string,
  style: InlineStyle,
  out: { text: string; spans: StyledSpan[] }
): void {
  let literal = '';
  const flush = () => {
    emit(out, literal, style);
    literal = '';
  };

  for (let i = 0; i < source.length; ) {
    const char = source[i];

    if (char === '\\' && ESCAPABLE.test(source[i + 1] ?? '')) {
      literal += source[i + 1];
      i += 2;
      continue;
    }

    if (char === '`') {
      const close = source.indexOf('`', i + 1);
      if (close > i + 1) {
        flush();
        emit(out, source.slice(i + 1, close), { ...style, code: true });
        i = close + 1;
        continue;
      }
    }

    if (char === '[') {
      const link = source.slice(i).match(/^\[([^\]]+)\]\(([^\s)]+)\)/);
      if (link && LINKABLE.test(link[2])) {
        flush();
        walkInline(link[1], { ...style, link: link[2] }, out);
        i += link[0].length;
        continue;
      }
    }

    if (char === '*' || char === '_') {
      const run = source.slice(i).match(char === '*' ? /^\*+/ : /^_+/)![0];
      const size = Math.min(run.length, 3);
      const delimiter = char.repeat(size);
      const close = closingDelimiter(source, i, delimiter);
      if (close !== -1) {
        flush();
        const inner = source.slice(i + size, close);
        walkInline(
          inner,
          {
            ...style,
            ...(size >= 2 ? { bold: true } : {}),
            ...(size !== 2 ? { italic: true } : {}),
          },
          out
        );
        i = close + size;
        continue;
      }
      literal += run;
      i += run.length;
      continue;
    }

    literal += char;
    i += 1;
  }
  flush();
}

/**
 * Where the emphasis opened at `open` closes, or -1 when it is not emphasis.
 * CommonMark's flanking rule is what keeps `2 * 3 * 4` and `a ** b` literal, and
 * `_` additionally needs a word boundary, so `snake_case_name` stays one word.
 */
function closingDelimiter(source: string, open: number, delimiter: string): number {
  const char = delimiter[0];
  const size = delimiter.length;
  const after = source[open + size];
  if (after === undefined || /\s/.test(after)) return -1;
  if (char === '_' && open > 0 && WORD_CHARACTER.test(source[open - 1])) return -1;

  for (let j = open + size + 1; j < source.length; j++) {
    if (source[j] === '\\') {
      j += 1;
      continue;
    }
    if (source[j] !== char) continue;
    const run = source.slice(j).match(char === '*' ? /^\*+/ : /^_+/)![0];
    if (run.length < size) {
      j += run.length - 1;
      continue;
    }
    if (size === 1 && run.length === 2) {
      j += 1;
      continue;
    }
    if (/\s/.test(source[j - 1])) {
      j += run.length - 1;
      continue;
    }
    const next = source[j + size];
    if (char === '_' && next !== undefined && WORD_CHARACTER.test(next)) {
      j += run.length - 1;
      continue;
    }
    return j;
  }
  return -1;
}
