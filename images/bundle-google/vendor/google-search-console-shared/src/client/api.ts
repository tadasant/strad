/**
 * Every Search Console API call this server makes, and all of them read.
 *
 * Two hosts. Sites, search analytics and sitemaps are the `webmasters/v3`
 * surface on www.googleapis.com; URL inspection exists only on the newer
 * `searchconsole.googleapis.com/v1`. Both accept a `webmasters.readonly` token.
 * Nothing here submits or deletes a sitemap, adds or removes a site: those are
 * the API's only writes, and this server has no tool for any of them.
 *
 * The property is a PATH SEGMENT, encoded whole — `sc-domain:example.com`
 * becomes `sc-domain%3Aexample.com` and `https://example.com/` becomes
 * `https%3A%2F%2Fexample.com%2F`. A sitemap's feedpath is a full URL too, and
 * encoded the same way.
 */
import { throwForApiError } from './api-errors.js';
import type {
  SearchAnalyticsRequest,
  SearchAnalyticsResponse,
  SiteEntry,
  Sitemap,
  SitemapsListResponse,
  SitesListResponse,
  UrlInspectionRequest,
  UrlInspectionResponse,
} from '../types.js';

export const WEBMASTERS_URL = 'https://www.googleapis.com/webmasters/v3';
export const URL_INSPECTION_URL = 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect';

/** The longest a 429 is waited out before the one retry. */
const MAX_RETRY_WAIT_MS = 10_000;

/**
 * One request, retried ONCE on a 429 after its `Retry-After` (capped at 10s).
 * Once, because the calling model can retry a tool call itself and a second
 * silent wait is a tool call that hangs for no visible reason.
 */
async function send(url: string, init: RequestInit, operation: string): Promise<Response> {
  let response = await fetch(url, init);
  if (response.status === 429) {
    const seconds = Number(response.headers.get('retry-after'));
    const waitMs = Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds * 1000, MAX_RETRY_WAIT_MS) : 1000;
    await response.body?.cancel();
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    response = await fetch(url, init);
  }
  if (!response.ok) await throwForApiError(response, operation);
  return response;
}

function siteUrlPath(siteUrl: string): string {
  return `${WEBMASTERS_URL}/sites/${encodeURIComponent(siteUrl)}`;
}

async function getJson<T>(headers: Record<string, string>, url: string, operation: string): Promise<T> {
  const response = await send(url, { method: 'GET', headers }, operation);
  return (await response.json()) as T;
}

async function postJson<T>(
  headers: Record<string, string>,
  url: string,
  body: unknown,
  operation: string
): Promise<T> {
  const response = await send(
    url,
    { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    operation
  );
  return (await response.json()) as T;
}

export function listSites(headers: Record<string, string>): Promise<SitesListResponse> {
  return getJson(headers, `${WEBMASTERS_URL}/sites`, 'sites.list');
}

export function getSite(headers: Record<string, string>, siteUrl: string): Promise<SiteEntry> {
  return getJson(headers, siteUrlPath(siteUrl), 'sites.get');
}

export function querySearchAnalytics(
  headers: Record<string, string>,
  siteUrl: string,
  request: SearchAnalyticsRequest
): Promise<SearchAnalyticsResponse> {
  return postJson(headers, `${siteUrlPath(siteUrl)}/searchAnalytics/query`, request, 'searchanalytics.query');
}

export function listSitemaps(
  headers: Record<string, string>,
  siteUrl: string,
  sitemapIndex?: string
): Promise<SitemapsListResponse> {
  const query = sitemapIndex ? `?${new URLSearchParams({ sitemapIndex }).toString()}` : '';
  return getJson(headers, `${siteUrlPath(siteUrl)}/sitemaps${query}`, 'sitemaps.list');
}

export function getSitemap(headers: Record<string, string>, siteUrl: string, feedpath: string): Promise<Sitemap> {
  return getJson(headers, `${siteUrlPath(siteUrl)}/sitemaps/${encodeURIComponent(feedpath)}`, 'sitemaps.get');
}

export function inspectUrl(
  headers: Record<string, string>,
  request: UrlInspectionRequest
): Promise<UrlInspectionResponse> {
  return postJson(headers, URL_INSPECTION_URL, request, 'urlInspection.index.inspect');
}
