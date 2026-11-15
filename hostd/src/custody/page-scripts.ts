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
 * it is in: input and textarea values, and whitespace-separated runs of text.
 * A candidate is printable, has no whitespace, is at least
 * `MIN_CANDIDATE_LENGTH` long, mixes letters and digits, and is not a URL.
 */
export const SNAPSHOT_CANDIDATES = `(() => {
  const MIN = ${MIN_CANDIDATE_LENGTH};
  const path = (el) => {
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
      if (tok.length < MIN || seen.has(tok)) continue;
      if (!/^[\\x21-\\x7e]+$/.test(tok) || !/[0-9]/.test(tok) || !/[A-Za-z]/.test(tok)) continue;
      if (/^https?:\\/\\//i.test(tok)) continue;
      seen.add(tok);
      out.push({ selector: path(el), token: tok });
      if (out.length >= 5000) return;
    }
  };
  for (const el of document.querySelectorAll('input, textarea')) add(el, el.value);
  const root = document.body || document.documentElement;
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    const p = n.parentElement;
    if (p && p.tagName !== 'SCRIPT' && p.tagName !== 'STYLE') add(p, n.nodeValue);
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
