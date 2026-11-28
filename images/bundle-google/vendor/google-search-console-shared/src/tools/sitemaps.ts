import { z } from 'zod';
import type { ClientFactory } from '../server.js';
import { errorResult, READ_ANNOTATIONS, type Tool } from '../tools.js';
import { normalizeSiteUrl, SITE_URL_DESCRIPTION } from '../utils/site-url.js';
import { logError } from '../logging.js';
import type { Sitemap } from '../types.js';

/** One sitemap, as a few compact lines. */
export function renderSitemap(sitemap: Sitemap): string {
  const flags = [
    sitemap.isSitemapsIndex ? 'sitemap index' : (sitemap.type ?? 'sitemap'),
    sitemap.isPending ? 'pending (not yet processed)' : undefined,
  ].filter(Boolean);
  const lines = [`- ${sitemap.path} (${flags.join(', ')})`];
  const when = [
    sitemap.lastSubmitted ? `submitted ${sitemap.lastSubmitted}` : undefined,
    sitemap.lastDownloaded ? `last read by Google ${sitemap.lastDownloaded}` : 'never read by Google',
  ].filter(Boolean);
  lines.push(`  ${when.join('; ')}`);
  lines.push(`  errors ${sitemap.errors ?? '0'}, warnings ${sitemap.warnings ?? '0'}`);
  for (const content of sitemap.contents ?? []) {
    lines.push(
      `  ${content.type ?? 'content'}: ${content.submitted ?? '0'} submitted` +
        `${content.indexed !== undefined ? `, ${content.indexed} indexed` : ''}`
    );
  }
  return lines.join('\n');
}

const SITEMAP_EXAMPLE = `- https://example.com/sitemap.xml (sitemap index)
  submitted 2026-09-14T08:12:40.000Z; last read by Google 2026-10-27T03:01:22.000Z
  errors 0, warnings 1
  web: 1840 submitted`;

export const ListSitemapsSchema = z.object({
  site_url: z.string().min(1),
  sitemap_index: z.string().url().optional(),
});

const LIST_DESCRIPTION = `List the sitemaps submitted for a property, or the child sitemaps of one sitemap index, with Google's processing status for each.

Read only: this server cannot submit, resubmit or delete a sitemap.

**Returns**, for example:

1 sitemap for sc-domain:example.com:
${SITEMAP_EXAMPLE}

"errors" and "warnings" are counts from Google's last read of the file; "submitted" is how many URLs of that content type (web, image, video, news) the file lists. Search Console has stopped reporting an "indexed" count for most sitemaps, so it appears only when Google returns one.

**Use cases:**
- Check that a site's sitemap is submitted and Google has read it recently
- Find a sitemap reporting errors, then get_sitemap for its detail
- Expand a sitemap index into its children with sitemap_index`;

export function listSitemapsTool(clientFactory: ClientFactory): Tool {
  return {
    name: 'list_sitemaps',
    description: LIST_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        site_url: { type: 'string', description: SITE_URL_DESCRIPTION },
        sitemap_index: {
          type: 'string',
          description:
            'Optional: the full URL of a sitemap index, e.g. "https://example.com/sitemap_index.xml", to list ' +
            'its children instead of the property\'s submitted sitemaps.',
        },
      },
      required: ['site_url'],
    },
    annotations: { title: 'List sitemaps', ...READ_ANNOTATIONS },
    handler: async (args) => {
      try {
        const parsed = ListSitemapsSchema.parse(args ?? {});
        const siteUrl = normalizeSiteUrl(parsed.site_url);
        const result = await clientFactory().listSitemaps(siteUrl, parsed.sitemap_index);
        const sitemaps = result.sitemap ?? [];
        const scope = parsed.sitemap_index ? `in ${parsed.sitemap_index}` : `for ${siteUrl}`;
        if (sitemaps.length === 0) {
          return { content: [{ type: 'text', text: `No sitemaps ${scope}.\n` }] };
        }
        const text =
          `${sitemaps.length} sitemap${sitemaps.length === 1 ? '' : 's'} ${scope}:\n` +
          `${sitemaps.map(renderSitemap).join('\n')}\n`;
        return { content: [{ type: 'text', text }] };
      } catch (error) {
        logError('list-sitemaps-tool', error);
        return errorResult('Error listing sitemaps', error);
      }
    },
  };
}

export const GetSitemapSchema = z.object({
  site_url: z.string().min(1),
  feedpath: z.string().url(),
});

const GET_DESCRIPTION = `Get Google's processing status for one submitted sitemap: when it was submitted and last read, its error and warning counts, and how many URLs it lists by content type.

**Returns**, for example:

${SITEMAP_EXAMPLE}

**Use cases:**
- Check whether Google has read a sitemap since it last changed
- See whether a sitemap's errors went away after a fix`;

export function getSitemapTool(clientFactory: ClientFactory): Tool {
  return {
    name: 'get_sitemap',
    description: GET_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        site_url: { type: 'string', description: SITE_URL_DESCRIPTION },
        feedpath: {
          type: 'string',
          description: 'The sitemap\'s full URL, as list_sitemaps shows it, e.g. "https://example.com/sitemap.xml".',
        },
      },
      required: ['site_url', 'feedpath'],
    },
    annotations: { title: 'Get a sitemap', ...READ_ANNOTATIONS },
    handler: async (args) => {
      try {
        const parsed = GetSitemapSchema.parse(args ?? {});
        const sitemap = await clientFactory().getSitemap(normalizeSiteUrl(parsed.site_url), parsed.feedpath);
        return { content: [{ type: 'text', text: `${renderSitemap(sitemap)}\n` }] };
      } catch (error) {
        logError('get-sitemap-tool', error);
        return errorResult('Error getting sitemap', error);
      }
    },
  };
}
