import { z } from 'zod';
import type { ClientFactory } from '../server.js';
import { errorResult, READ_ANNOTATIONS, type Tool } from '../tools.js';
import { normalizeSiteUrl, SITE_URL_DESCRIPTION } from '../utils/site-url.js';
import { logError } from '../logging.js';
import type { UrlInspectionResult } from '../types.js';

export const InspectUrlSchema = z.object({
  site_url: z.string().min(1),
  inspection_url: z.string().url(),
  language_code: z.string().min(2).max(35).optional(),
});

/** At most this many referring URLs are listed; the rest are counted. */
const MAX_REFERRING_URLS = 5;

export function renderInspection(url: string, result: UrlInspectionResult | undefined): string {
  if (!result) return `Search Console returned no inspection result for ${url}.\n`;
  const lines = [`# ${url}`];
  const index = result.indexStatusResult;
  if (index) {
    lines.push(`**Verdict:** ${index.verdict ?? 'unknown'}`);
    if (index.coverageState) lines.push(`**Coverage:** ${index.coverageState}`);
    if (index.indexingState) lines.push(`**Indexing allowed:** ${index.indexingState}`);
    if (index.robotsTxtState) lines.push(`**robots.txt:** ${index.robotsTxtState}`);
    if (index.pageFetchState) lines.push(`**Page fetch:** ${index.pageFetchState}`);
    if (index.lastCrawlTime) {
      lines.push(`**Last crawl:** ${index.lastCrawlTime}${index.crawledAs ? ` (as ${index.crawledAs})` : ''}`);
    }
    if (index.googleCanonical) lines.push(`**Google-selected canonical:** ${index.googleCanonical}`);
    if (index.userCanonical) lines.push(`**User-declared canonical:** ${index.userCanonical}`);
    if (index.sitemap?.length) lines.push(`**In sitemaps:** ${index.sitemap.join(', ')}`);
    if (index.referringUrls?.length) {
      const shown = index.referringUrls.slice(0, MAX_REFERRING_URLS);
      const more = index.referringUrls.length - shown.length;
      lines.push(`**Referring URLs:** ${shown.join(', ')}${more > 0 ? ` (and ${more} more)` : ''}`);
    }
  }
  const mobile = result.mobileUsabilityResult;
  if (mobile?.verdict) {
    const issues = (mobile.issues ?? []).map((i) => i.message).filter(Boolean);
    lines.push(`**Mobile usability:** ${mobile.verdict}${issues.length ? ` — ${issues.join('; ')}` : ''}`);
  }
  const rich = result.richResultsResult;
  if (rich?.verdict) {
    const types = (rich.detectedItems ?? []).map((d) => {
      const issues = (d.items ?? []).flatMap((i) => (i.issues ?? []).map((x) => x.issueMessage)).filter(Boolean);
      return `${d.richResultType ?? 'unknown'}${issues.length ? ` (${issues.join('; ')})` : ''}`;
    });
    lines.push(`**Rich results:** ${rich.verdict}${types.length ? ` — ${types.join(', ')}` : ''}`);
  }
  if (result.ampResult?.verdict) lines.push(`**AMP:** ${result.ampResult.verdict}`);
  if (result.inspectionResultLink) lines.push(`**Open in Search Console:** ${result.inspectionResultLink}`);
  return `${lines.join('\n')}\n`;
}

const DESCRIPTION = `Inspect one URL the way Search Console's URL Inspection tool does: whether it is in Google's index, why or why not, when Google last crawled it, and which canonical Google chose.

This reads Google's INDEXED version of the page. It does not run a live test and does not request indexing; neither is in the API.

**Returns**, for example:

# https://example.com/pricing
**Verdict:** PASS
**Coverage:** Submitted and indexed
**Indexing allowed:** INDEXING_ALLOWED
**robots.txt:** ALLOWED
**Page fetch:** SUCCESSFUL
**Last crawl:** 2026-10-25T11:42:07Z (as MOBILE)
**Google-selected canonical:** https://example.com/pricing
**User-declared canonical:** https://example.com/pricing
**In sitemaps:** https://example.com/sitemap.xml
**Rich results:** PASS — Breadcrumbs, FAQ
**Open in Search Console:** https://search.google.com/search-console/inspect?resource_id=...

**Verdict**: PASS (indexed), PARTIAL (indexed with issues), FAIL (not indexed, or an error), NEUTRAL (excluded, e.g. noindex or a duplicate). **Coverage** is Search Console's own sentence for why, e.g. "Crawled - currently not indexed" or "Duplicate, Google chose different canonical than user".

The inspection_url must belong to site_url: under a Domain property any URL on that domain, under a URL-prefix property a URL beginning with it. Google limits inspection to 2,000 calls a day and 600 a minute per property, so inspect the URLs you care about rather than every URL in a sitemap.

**Use cases:**
- Find out why a page gets no impressions in query_search_analytics
- Check that a newly published page has been crawled and indexed
- See whether Google picked a different canonical than the page declares
- Check robots.txt or noindex blocking on one URL`;

export function inspectUrlTool(clientFactory: ClientFactory): Tool {
  return {
    name: 'inspect_url',
    description: DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        site_url: { type: 'string', description: SITE_URL_DESCRIPTION },
        inspection_url: {
          type: 'string',
          description: 'The full URL to inspect, e.g. "https://example.com/pricing". Must be under site_url.',
        },
        language_code: {
          type: 'string',
          description:
            'Optional BCP-47 language for the translated issue messages, e.g. "en-US" or "de". Default: en-US.',
        },
      },
      required: ['site_url', 'inspection_url'],
    },
    annotations: { title: 'Inspect a URL in Google\'s index', ...READ_ANNOTATIONS },
    handler: async (args) => {
      try {
        const parsed = InspectUrlSchema.parse(args ?? {});
        const result = await clientFactory().inspectUrl({
          inspectionUrl: parsed.inspection_url,
          siteUrl: normalizeSiteUrl(parsed.site_url),
          ...(parsed.language_code ? { languageCode: parsed.language_code } : {}),
        });
        return { content: [{ type: 'text', text: renderInspection(parsed.inspection_url, result.inspectionResult) }] };
      } catch (error) {
        logError('inspect-url-tool', error);
        return errorResult('Error inspecting URL', error);
      }
    },
  };
}
