/**
 * The scripts the custody server evaluates inside the owner's page. Their
 * results come back to THIS PROCESS and stop here: nothing they return is
 * ever put in a tool result. Caller-supplied selectors cross in through
 * `JSON.stringify`, never through concatenation.
 */

/** Shortest string the diff treats as a candidate credential. */
export const MIN_CANDIDATE_LENGTH = 16;

/**
 * Every credential-shaped token on the page, with a selector for the element
 * it is in. Read from: input and textarea VALUES (a revealed key is often a
 * read-only field), a copy button's `data-clipboard-text`, and
 * whitespace-separated runs of every text node — in the document and in
 * every open shadow root. An element inside a shadow root gets a null
 * selector: `document.querySelector` cannot reach it, and a selector built
 * from inside the root could name a different element in the document.
 *
 * A candidate has no whitespace, is at least `MIN_CANDIDATE_LENGTH` long,
 * mixes letters and digits, and is not a URL. Its characters are printable
 * ASCII plus the four a page MASKS a key with (`…`, `•`, `●`, `·`): a masked
 * preview is let through here so the caller can tell "only a masked preview
 * appeared" from "nothing appeared" — `chooseCapture` never keeps one.
 */
export const SNAPSHOT_CANDIDATES = `(() => {
  const MIN = ${MIN_CANDIDATE_LENGTH};
  const path = (el) => {
    if (el.getRootNode() !== document) return null;
    if (el.id && document.querySelectorAll('#' + CSS.escape(el.id)).length === 1) return '#' + CSS.escape(el.id);
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && n !== document.documentElement; n = n.parentElement) {
      if (n.id && document.querySelectorAll('#' + CSS.escape(n.id)).length === 1) { parts.unshift('#' + CSS.escape(n.id)); break; }
      const sibs = n.parentElement ? [...n.parentElement.children].filter((s) => s.tagName === n.tagName) : [n];
      parts.unshift(n.tagName.toLowerCase() + (sibs.length > 1 ? ':nth-of-type(' + (sibs.indexOf(n) + 1) + ')' : ''));
    }
    return parts.join(' > ');
  };
  const out = [];
  const seen = new Set();
  const add = (el, text) => {
    for (const tok of String(text || '').split(/\\s+/)) {
      if (out.length >= 5000) return;
      if (tok.length < MIN || seen.has(tok)) continue;
      if (!/^[\\x21-\\x7e\\u2026\\u2022\\u25cf\\u00b7]+$/.test(tok) || !/[0-9]/.test(tok) || !/[A-Za-z]/.test(tok)) continue;
      if (/^https?:\\/\\//i.test(tok)) continue;
      seen.add(tok);
      out.push({ selector: path(el), token: tok });
    }
  };
  const roots = [document];
  for (let i = 0; i < roots.length && i < 200; i++) {
    const r = roots[i];
    for (const el of r.querySelectorAll('*')) if (el.shadowRoot) roots.push(el.shadowRoot);
  }
  for (const r of roots) {
    for (const el of r.querySelectorAll('input, textarea')) add(el, el.value);
    for (const el of r.querySelectorAll('[data-clipboard-text]')) add(el, el.getAttribute('data-clipboard-text'));
    const root = r === document ? (document.body || document.documentElement) : r;
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const p = n.parentElement;
      if (p && p.tagName !== 'SCRIPT' && p.tagName !== 'STYLE') add(p, n.nodeValue);
    }
  }
  return out;
})()`;

/**
 * One element's value: a form field's `value`, else a copy button's
 * `data-clipboard-text`, else its text. Null when nothing matches.
 */
export function elementValue(selector: string): string {
  return `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return null;
  if ('value' in el && typeof el.value === 'string' && el.value) return el.value;
  const clip = el.getAttribute('data-clipboard-text');
  if (clip) return clip;
  return (el.textContent || '').trim();
})()`;
}
