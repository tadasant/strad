/**
 * Enough XML to read an OOXML worksheet, and no more.
 *
 * This is a SCANNER, not a parser: it walks tags with a regular expression and
 * hands back names, attributes and the text between them. That is the right
 * shape for SpreadsheetML, which is a flat stream of `<row>`/`<c>`/`<v>` and is
 * routinely hundreds of megabytes — building a DOM for it would cost more memory
 * than the workbook does.
 *
 * It is deliberately NOT a general XML implementation. It does not resolve
 * namespaces (OOXML prefixes are fixed by the spec), does not expand DTD
 * entities (an OOXML part has no DTD, and expanding one is how billion-laughs
 * works), and does not validate. Everything it is given has already been
 * inflated out of a ZIP this process bounded.
 */

/** One start tag, and where its content begins. */
export interface XmlTag {
  /** The local name, namespace prefix stripped: `c`, `sheet`, `numFmt`. */
  name: string;
  /** The name exactly as written, prefix included — what the end tag repeats. */
  rawName: string;
  /** Raw attribute text, parsed on demand by {@link attributes}. */
  attributeText: string;
  /** True for `<c r="A1"/>`, false for `<c r="A1">`. */
  selfClosing: boolean;
  /** Index just past the tag, where its content starts. */
  contentStart: number;
  /** Index of the `<` that opened it. */
  tagStart: number;
}

// FRESH RegExp objects per call, never shared module-level ones. A `/g` regex
// carries `lastIndex` as mutable state, and these scans NEST — reading a cell
// walks the tags inside one `<c>` while the worksheet's own tag walk is
// suspended mid-iteration. Two walks sharing one regex would each clobber the
// other's position, which shows up as silently dropped cells rather than as an
// error.
//
// The first alternative is the one that matters for correctness rather than for
// reentrancy: a comment, a CDATA section and a processing instruction are
// matched and SKIPPED WHOLE. Walking into them instead is not a cosmetic
// failure — `<!-- <row r="9"> -->` inside a worksheet would be read as a real
// `<row>`, resetting the row cursor and shifting every cell after it.
const tagPattern = () =>
  /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<([A-Za-z_][\w.:-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
const attributePattern = () => /([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** Strip an OOXML namespace prefix: `r:id` -> `id`, `xdr:col` -> `col`. */
function localName(name: string): string {
  const colon = name.indexOf(':');
  return colon === -1 ? name : name.slice(colon + 1);
}

/**
 * Every start tag in `xml`, in document order.
 *
 * A generator so a 200MB worksheet part is walked once without a tag array
 * beside it.
 */
export function* tags(xml: string, from = 0): Generator<XmlTag> {
  const pattern = tagPattern();
  pattern.lastIndex = from;
  for (;;) {
    const match = pattern.exec(xml);
    if (!match) return;
    // A comment, a CDATA section, a processing instruction and a doctype match
    // the pattern's leading alternatives, which capture nothing — so they are
    // consumed and skipped here. `</close>` does not match at all.
    if (match[1] === undefined) continue;
    yield {
      name: localName(match[1]),
      rawName: match[1],
      attributeText: match[2],
      selfClosing: match[3] === '/',
      contentStart: match.index + match[0].length,
      tagStart: match.index,
    };
  }
}

/** A tag's attributes, by local name. */
export function attributes(tag: XmlTag): Record<string, string> {
  const out: Record<string, string> = {};
  const pattern = attributePattern();
  for (;;) {
    const match = pattern.exec(tag.attributeText);
    if (!match) return out;
    out[localName(match[1])] = unescapeXml(match[2] ?? match[3] ?? '');
  }
}

/**
 * The raw content between a start tag and its matching end tag.
 *
 * NOT nesting-aware, and it does not need to be: the only elements this server
 * asks for content from are `si`, `is` and `c`, none of which may contain
 * another element of its own name. Returns `''` for a self-closing tag, and the
 * remainder of the document if the end tag is missing — the forgiving choice,
 * because a truncated part should still yield the cells it does have.
 */
export function innerXml(xml: string, tag: XmlTag): string {
  if (tag.selfClosing) return '';
  const close = `</${tag.rawName}>`;
  const end = xml.indexOf(close, tag.contentStart);
  return end === -1 ? xml.slice(tag.contentStart) : xml.slice(tag.contentStart, end);
}

/**
 * The text content of a fragment: its character data with every tag removed.
 *
 * `<is><r><t>Net</t></r><r><t> worth</t></r></is>` is one string, "Net worth" —
 * Excel splits a styled cell's text into runs, and a reader that took only the
 * first run would silently truncate every bolded label in the workbook.
 */
export function textContent(fragment: string): string {
  // CDATA FIRST, and it is not a nicety: `<![CDATA[Roth IRA]]>` opens with `<`
  // and its first `>` is the one in `]]>`, so a bare tag-strip deletes the text
  // along with the wrapper and the cell silently becomes empty. Excel does not
  // write CDATA, but it is legal SpreadsheetML and third-party writers do —
  // which is exactly the population of files this path exists for. Its contents
  // are literal, so they are NOT entity-unescaped.
  const CDATA = /<!\[CDATA\[([\s\S]*?)\]\]>/g;
  let out = '';
  let cursor = 0;
  for (;;) {
    const match = CDATA.exec(fragment);
    if (!match) break;
    out += unescapeXml(fragment.slice(cursor, match.index).replace(/<[^>]*>/g, ''));
    out += match[1];
    cursor = match.index + match[0].length;
  }
  return out + unescapeXml(fragment.slice(cursor).replace(/<[^>]*>/g, ''));
}

/**
 * A character, or undefined for a reference no character answers to.
 *
 * `String.fromCodePoint` THROWS past U+10FFFF, and this scanner reads bytes that
 * came off a Drive file: `&#x110000;` is a one-line denial of a whole workbook.
 * Every other unparseable form here degrades to the raw text, and so does this.
 */
function codePoint(code: number): string | undefined {
  if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return undefined;
  return String.fromCodePoint(code);
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/**
 * XML entities, plus Excel's `_xHHHH_` escape for characters XML cannot carry.
 *
 * The second one is Excel's own invention: a literal newline inside a shared
 * string is written `_x000D_`, and a string that really does contain the text
 * `_x000D_` is written `_x005F_x000D_` — the underscore itself escaped first. So
 * the `_x005F_` form has to be taken out of the way BEFORE the general form is
 * expanded, or a legitimate label turns into a control character.
 */
export function unescapeXml(text: string): string {
  let out = text;
  if (out.includes('&')) {
    out = out.replace(/&(#x?[0-9A-Fa-f]+|[A-Za-z]+);/g, (whole, body: string) => {
      if (body.startsWith('#x') || body.startsWith('#X')) {
        return codePoint(Number.parseInt(body.slice(2), 16)) ?? whole;
      }
      if (body.startsWith('#')) {
        return codePoint(Number.parseInt(body.slice(1), 10)) ?? whole;
      }
      return NAMED_ENTITIES[body] ?? whole;
    });
  }
  if (out.includes('_x')) {
    const ESCAPED_UNDERSCORE = '\u0000';
    out = out
      .split('_x005F_')
      .join(ESCAPED_UNDERSCORE)
      .replace(/_x([0-9A-Fa-f]{4})_/g, (whole, hex: string) => {
        return codePoint(Number.parseInt(hex, 16)) ?? whole;
      })
      .split(ESCAPED_UNDERSCORE)
      .join('_');
  }
  return out;
}
