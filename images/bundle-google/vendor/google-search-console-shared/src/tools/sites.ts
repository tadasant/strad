import { z } from 'zod';
import type { ClientFactory } from '../server.js';
import { errorResult, READ_ANNOTATIONS, type Tool } from '../tools.js';
import { normalizeSiteUrl, SITE_URL_DESCRIPTION } from '../utils/site-url.js';
import { logError } from '../logging.js';
import type { SiteEntry } from '../types.js';

/** What each permission level lets the account do in Search Console. */
const PERMISSION_MEANINGS: Record<string, string> = {
  siteOwner: 'owner (verified; full access, can add users)',
  siteFullUser: 'full user (can see all data)',
  siteRestrictedUser: 'restricted user (can see most data)',
  siteUnverifiedUser: 'unverified (added but not verified; no data)',
};

function describePermission(level: string | undefined): string {
  if (!level) return 'unknown';
  return PERMISSION_MEANINGS[level] ? `${level} — ${PERMISSION_MEANINGS[level]}` : level;
}

function kind(siteUrl: string): string {
  return siteUrl.startsWith('sc-domain:') ? 'Domain property' : 'URL-prefix property';
}

function renderSite(site: SiteEntry): string {
  return `- ${site.siteUrl} (${kind(site.siteUrl)}): ${describePermission(site.permissionLevel)}`;
}

const LIST_DESCRIPTION = `List every Search Console property the connected Google account can see, with its permission level.

Call this first: every other tool takes a site_url, and Search Console matches it EXACTLY, so pass a value from this list verbatim.

**Returns**, for example:

2 properties:
- sc-domain:example.com (Domain property): siteOwner — owner (verified; full access, can add users)
- https://blog.example.com/ (URL-prefix property): siteFullUser — full user (can see all data)

**Permission levels:**
- siteOwner: a verified owner of the property
- siteFullUser: can view all data
- siteRestrictedUser: can view most data
- siteUnverifiedUser: the property was added but never verified, so it has no data

**Use cases:**
- Find the exact site_url to pass to query_search_analytics or inspect_url
- Check whether the account can see a domain at all
- Tell a Domain property from a URL-prefix one for the same site`;

export function listSitesTool(clientFactory: ClientFactory): Tool {
  return {
    name: 'list_sites',
    description: LIST_DESCRIPTION,
    inputSchema: { type: 'object', properties: {} },
    annotations: { title: 'List Search Console properties', ...READ_ANNOTATIONS },
    handler: async () => {
      try {
        const result = await clientFactory().listSites();
        const sites = [...(result.siteEntry ?? [])].sort((a, b) => a.siteUrl.localeCompare(b.siteUrl));
        if (sites.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text:
                  'This Google account has no Search Console properties. A property has to be added for this ' +
                  'account (or the account added as a user of one) at https://search.google.com/search-console.',
              },
            ],
          };
        }
        const text = `${sites.length} propert${sites.length === 1 ? 'y' : 'ies'}:\n${sites.map(renderSite).join('\n')}\n`;
        return { content: [{ type: 'text', text }] };
      } catch (error) {
        logError('list-sites-tool', error);
        return errorResult('Error listing Search Console properties', error);
      }
    },
  };
}

export const GetSiteSchema = z.object({ site_url: z.string().min(1) });

const GET_DESCRIPTION = `Check one Search Console property: whether this account can see it, and at what permission level.

**Returns**, for example:

sc-domain:example.com (Domain property)
Permission: siteOwner — owner (verified; full access, can add users)

A property this account cannot see is a 403 or 404 that names the exact spelling to try; list_sites shows every property it can see.

**Use cases:**
- Confirm access to one property before querying its performance
- Check that a site_url is spelled the way Search Console stores it`;

export function getSiteTool(clientFactory: ClientFactory): Tool {
  return {
    name: 'get_site',
    description: GET_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: { site_url: { type: 'string', description: SITE_URL_DESCRIPTION } },
      required: ['site_url'],
    },
    annotations: { title: 'Get a Search Console property', ...READ_ANNOTATIONS },
    handler: async (args) => {
      try {
        const parsed = GetSiteSchema.parse(args ?? {});
        const site = await clientFactory().getSite(normalizeSiteUrl(parsed.site_url));
        const text = `${site.siteUrl} (${kind(site.siteUrl)})\nPermission: ${describePermission(site.permissionLevel)}\n`;
        return { content: [{ type: 'text', text }] };
      } catch (error) {
        logError('get-site-tool', error);
        return errorResult('Error getting Search Console property', error);
      }
    },
  };
}
