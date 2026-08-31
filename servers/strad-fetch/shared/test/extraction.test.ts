import { describe, expect, it } from 'vitest';
import { assessExtraction, MIN_EXTRACTED_CHARS } from '../src/clean/extraction.js';

/**
 * "The response had a body" and "the page had content" are different questions.
 *
 * This is the predicate that separates them, and the numbers in it are measured
 * against this cleaner rather than chosen: the reported failure
 * (tadasant/strad#205, a craigslist search page) extracts to exactly ZERO
 * characters, while the shortest page here that carries a sentence extracts to
 * ten. The floor sits between them, near the bottom, because a false escalation
 * spends a paid credential AND turns a short-but-real page into "unknown".
 */

/**
 * The shape of the page in the report: a full document, a `ld+json` payload the
 * server did render, and result rows that only exist after JavaScript runs.
 */
const CLIENT_RENDERED = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<title>SF bay area apartments / housing for rent - craigslist</title>
<link rel="stylesheet" href="/static/a.css"><script src="/static/app.js"></script></head>
<body class="search"><div id="page-container"><div class="cl-search-page"></div></div>
<script type="application/ld+json" id="ld_searchpage_results">{"@context":"https://schema.org","itemListElement":[{"item":{"name":"Garden Areas, Washer/Dryers","@type":"Apartment","numberOfBedrooms":1},"position":"0","@type":"ListItem"}]}</script>
<script>window.cl={};</script></body></html>`;

const URL = 'https://sfbay.craigslist.org/search/apa';

describe('assessExtraction', () => {
  it('calls a client-rendered page unreadable, and says how it knows', async () => {
    const assessment = await assessExtraction(CLIENT_RENDERED, URL);

    expect(assessment.readable).toBe(false);
    expect(assessment.text?.trim()).toBe('');
    expect(assessment.reason).toContain('extracted 0 characters');
    // The bytes WERE there — that is the whole point of the distinction.
    expect(assessment.reason).toContain(`fetched ${CLIENT_RENDERED.length} bytes`);
  });

  it('calls an empty body unreadable without bothering to clean it', async () => {
    const assessment = await assessExtraction('   \n  ', URL);

    expect(assessment.readable).toBe(false);
    expect(assessment.reason).toBe('fetched an empty body');
    expect(assessment.text).toBeUndefined();
    // An empty page IS empty. Only a page that served something can be unknown.
    expect(assessment.empty).toBe(true);
  });

  it('treats an absent body the same as an empty one', async () => {
    // firecrawl's payload carries `html` as an optional field, so a success can
    // arrive with nothing in it.
    const assessment = await assessExtraction(undefined, 'https://example.com/a');

    expect(assessment.readable).toBe(false);
    expect(assessment.empty).toBe(true);
  });

  it('returns the extraction it computed, so nothing downstream cleans twice', async () => {
    const assessment = await assessExtraction(
      '<html><body><article><h1>Heading</h1><p>Prose.</p></article></body></html>',
      'https://example.com/a'
    );

    expect(assessment.readable).toBe(true);
    expect(assessment.text).toContain('Heading');
    expect(assessment.text).not.toContain('<h1>');
  });

  /** The other half of the fix: a short page is short, not unreadable. */
  it.each([
    ['a one-sentence page', '<html><body><p>Not found.</p></body></html>'],
    [
      'a status page',
      '<html><body><article><h1>Status</h1><p>All systems operational.</p></article></body></html>',
    ],
    [
      'a 200 error page',
      '<html><body><h1>Not Found</h1><p>The requested URL was not found on this server.</p></body></html>',
    ],
  ])('does not call %s unreadable', async (_name, html) => {
    const assessment = await assessExtraction(html, 'https://example.com/a');
    expect(assessment.readable).toBe(true);
  });

  /**
   * Pass-through content comes back byte-identical, so a character floor over it
   * would escalate `{}` to a paid strategy that returns the same two bytes.
   */
  it.each([
    ['a tiny JSON body', '{}'],
    ['a JSON body with one key', '{"ok":true}'],
    ['an empty RSS channel', '<?xml version="1.0"?><rss version="2.0"><channel></channel></rss>'],
    ['a two-character text body', 'ok'],
  ])('does not hold %s to the character floor', async (_name, body) => {
    const assessment = await assessExtraction(body, 'https://example.com/a');

    expect(assessment.readable).toBe(true);
    // Identity, which is why the floor cannot apply: there is nothing to lose.
    expect(assessment.text).toBe(body);
  });

  it('reads pass-through bodies that are shorter than the floor', async () => {
    for (const body of ['{}', 'ok']) {
      expect(body.length).toBeLessThan(MIN_EXTRACTED_CHARS);
      expect((await assessExtraction(body, 'https://example.com/a')).readable).toBe(true);
    }
  });

  /**
   * A document whose root element is XML carries no HTML at all, so an HTML
   * clean extracts nothing from it — and a feed, a sitemap or an image would be
   * reported unreadable while being perfectly readable. A declaration is not
   * enough to spot them: plenty of feeds ship without one.
   */
  it.each([
    ['an SVG image', '<svg xmlns="http://www.w3.org/2000/svg"><rect width="4" height="4"/></svg>'],
    [
      'an Atom feed with no declaration',
      '<feed xmlns="http://www.w3.org/2005/Atom"><title>t</title></feed>',
    ],
    ['a sitemap', '<urlset xmlns="x"><url><loc>https://example.com/a</loc></url></urlset>'],
    ['an RSS channel', '<rss version="2.0"><channel><title>t</title></channel></rss>'],
  ])('reads %s rather than calling it unreadable', async (_name, body) => {
    const assessment = await assessExtraction(body, 'https://example.com/a');

    expect(assessment.readable).toBe(true);
    expect(assessment.text).toBe(body);
  });

  /**
   * The cleaner's cost tracks the content it EXTRACTS, not the document's size:
   * a 906KB client-rendered shell cleans in under a second because there is
   * nothing in it, while 2MB of prose takes forty. Capping the INPUT bounds the
   * expensive case without exempting the shells this check exists for.
   */
  describe('over the assessment cap', () => {
    const CAP = 256 * 1024;
    const shell = (bytes: number) =>
      `<!DOCTYPE html><html><head><title>s</title></head><body><div id="app"></div>` +
      `<script type="application/ld+json">{"a":"${'x'.repeat(bytes)}"}</script></body></html>`;
    const prose = (bytes: number) =>
      `<html><body><article><h1>Title</h1><p>${'lorem ipsum dolor sit amet '.repeat(
        Math.ceil(bytes / 26)
      )}</p></article></body></html>`;

    it('still catches a client-rendered shell far larger than the cap', async () => {
      const html = shell(CAP * 2);
      expect(html.length).toBeGreaterThan(CAP);

      const assessment = await assessExtraction(html, 'https://example.com/a');
      expect(assessment.readable).toBe(false);
      expect(assessment.reason).toContain(`fetched ${html.length} bytes`);
    });

    it('reads a page larger than the cap, and hands back no partial text', async () => {
      const html = prose(CAP * 2);
      expect(html.length).toBeGreaterThan(CAP);

      const assessment = await assessExtraction(html, 'https://example.com/a');
      expect(assessment.readable).toBe(true);
      // A prefix rendered as the whole page is worse than the raw bytes, so the
      // caller gets nothing to render and cleans for itself.
      expect(assessment.text).toBeUndefined();
    });
  });

  it('holds HTML at exactly the floor, and rejects one character under it', async () => {
    const at = await assessExtraction(`<html><body><p>${'a'.repeat(8)}</p></body></html>`, URL);
    const under = await assessExtraction(`<html><body><p>${'a'.repeat(7)}</p></body></html>`, URL);

    expect(MIN_EXTRACTED_CHARS).toBe(8);
    expect(at.readable).toBe(true);
    expect(under.readable).toBe(false);
  });
});
