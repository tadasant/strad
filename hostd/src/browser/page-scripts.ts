/**
 * The scripts evaluated INSIDE the owner's pages. Source text, because that is
 * what `Runtime.evaluate` takes; every caller-supplied value crosses into them
 * through `JSON.stringify`, never through concatenation of raw text.
 */

/** The page's interactive elements, each with a selector that finds it again. */
// Labels come back long (2000) and are clipped to 80 in the daemon AFTER
// redaction, so a clip cannot leave a token's tail too short to recognise.
export const LIST_ELEMENTS = `(() => {
  const pick = 'a[href],button,input,select,textarea,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[contenteditable=true],[onclick]';
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
  for (const el of document.querySelectorAll(pick)) {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    if (r.width === 0 || r.height === 0 || st.visibility === 'hidden' || st.display === 'none') continue;
    const label = (el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || '').trim().replace(/\\s+/g, ' ').slice(0, 2000);
    out.push({ selector: path(el), tag: el.tagName.toLowerCase(), type: el.getAttribute('type') || undefined, role: el.getAttribute('role') || undefined, label, href: el.tagName === 'A' ? el.href : undefined });
    if (out.length >= 400) break;
  }
  return out;
})()`;

/**
 * Scroll an element into view and report where its centre is, and whether
 * the page believes it is hidden — a background tab, or an occluded window.
 */
export function locate(selector: string): string {
  return `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return null;
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, tag: el.tagName.toLowerCase(), hidden: document.visibilityState === 'hidden' };
})()`;
}

/** Focus an element for typing, optionally emptying it first. */
export function focusForTyping(selector: string, clear: boolean): string {
  return `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return false;
  el.scrollIntoView({ block: 'center' });
  el.focus();
  if (${JSON.stringify(clear)}) {
    if ('value' in el) { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); }
    else if (el.isContentEditable) el.textContent = '';
  }
  return true;
})()`;
}
