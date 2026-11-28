/**
 * A Search Console property, as Search Console spells it.
 *
 * Two kinds, and the API matches the string exactly:
 *
 * - a Domain property, `sc-domain:example.com` — every protocol and subdomain;
 * - a URL-prefix property, `https://www.example.com/` — that origin and path
 *   prefix only, stored WITH its trailing slash.
 *
 * A bare `example.com` is neither, and sent as-is it comes back a 403 that
 * reads like a permissions problem. So it is refused here, naming both forms.
 * The one repair made is the trailing slash on a URL-prefix property that has
 * no path, because `https://example.com` can only mean `https://example.com/`.
 */
export const SITE_URL_DESCRIPTION =
  'The Search Console property, exactly as list_sites returns it: "sc-domain:example.com" for a ' +
  'Domain property, or the full URL with its trailing slash for a URL-prefix property, e.g. ' +
  '"https://www.example.com/".';

export function normalizeSiteUrl(raw: string): string {
  const value = raw.trim();
  if (/^sc-domain:/i.test(value)) {
    const domain = value.slice('sc-domain:'.length).trim();
    if (!domain || /[/\s:]/.test(domain)) {
      throw new Error(`"${raw}" is not a Domain property. Write it as "sc-domain:example.com", with no scheme or path.`);
    }
    return `sc-domain:${domain}`;
  }
  if (/^https?:\/\//i.test(value)) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error(`"${raw}" is not a valid URL-prefix property.`);
    }
    if (url.pathname === '/' && !url.search && !url.hash && !value.endsWith('/')) return `${value}/`;
    return value;
  }
  throw new Error(
    `"${raw}" is not a Search Console property. Use "sc-domain:${value || 'example.com'}" for a Domain ` +
      `property or "https://${value || 'example.com'}/" for a URL-prefix one; list_sites shows which ` +
      'this account has.'
  );
}

/**
 * The calendar day Search Console is on at `date`. Search Console reports days in
 * Pacific time, so a default end date taken in UTC is tomorrow there for eight
 * hours of every day.
 */
export function pacificDate(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/** A date's UTC calendar day, as YYYY-MM-DD. */
export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** A YYYY-MM-DD string that is also a real calendar date. */
export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && isoDate(parsed) === value;
}

/** `date` moved by `days` (negative for earlier), as YYYY-MM-DD. */
export function addDays(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return isoDate(parsed);
}
